// The pour and the cooling, from CC0 recordings on freesound.org (see README): a thick, gloopy bubbling while the stream
// runs (one of three per pour), a soft sizzle as it first hits, and a crackle as the cast cools, fading with its heat.
// The AudioContext is created on load: it runs at once if the browser allows it, otherwise it resumes on the first
// gesture.
import { nativeRandom } from "modules/random.js";

const POURS = [
  { name: "pour-0", gain: 1.3 },
  { name: "pour-1", gain: 1.0 },
  { name: "pour-2", gain: 1.2 },
];
const COOLS = [
  { name: "cool-0", gain: 1.0 },
  { name: "cool-1", gain: 0.6 },
];
const SAMPLES = [...POURS.map((p) => p.name), "sizzle", ...COOLS.map((c) => c.name)];

function createSound({ base = "./sounds/", onProgress } = {}) {
  let on = true;
  let paused = false;
  // Nothing plays until the page is ready (the loader is done): start() lets it out.
  let started = false;
  const buffers = {};

  const ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  // A small gallery room: a generated decaying noise tail on a send.
  const reverb = ctx.createConvolver();
  const irLength = Math.floor(ctx.sampleRate * 1.6);
  const ir = ctx.createBuffer(2, irLength, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < irLength; i++) d[i] = (nativeRandom() * 2 - 1) * Math.pow(1 - i / irLength, 4);
  }
  reverb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.18;
  master.connect(reverb).connect(wet).connect(comp);

  let fetched = 0;
  const loaded = Promise.allSettled(
    SAMPLES.map((name) =>
      fetch(`${base}${name}.mp3`)
        .then((res) => res.arrayBuffer())
        .finally(() => onProgress?.(++fetched / SAMPLES.length))
        .then((buf) => ctx.decodeAudioData(buf))
        .then((b) => (buffers[name] = b)),
    ),
  );

  const gesture = () => {
    if (!paused) ctx.resume();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  const audible = () => started && on && !paused && ctx.state === "running";

  // A looping bed that starts on demand (a random take, from a random point), follows a level, and stops once faded out.
  function bed(choices, lowpass) {
    const out = ctx.createGain();
    out.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = lowpass;
    tone.connect(out).connect(master);
    let src = null;
    let quietFor = 0;
    return {
      tone,
      set(target, dt) {
        const t = ctx.currentTime;
        const level = audible() ? target : 0;
        if (level > 0.01 && !src) {
          const pick = choices[Math.floor(nativeRandom() * choices.length)];
          if (buffers[pick.name]) {
            src = ctx.createBufferSource();
            src.buffer = buffers[pick.name];
            src.loop = true;
            const g = ctx.createGain();
            g.gain.value = pick.gain;
            src.connect(g).connect(tone);
            src.start(t, nativeRandom() * src.buffer.duration);
          }
        }
        out.gain.setTargetAtTime(level, t, level > out.gain.value ? 0.08 : 0.4);
        quietFor = level > 0.005 ? 0 : quietFor + dt;
        if (src && quietFor > 2) {
          src.stop();
          src = null;
        }
      },
    };
  }

  const pour = bed(POURS, 2200);
  const cool = bed(COOLS, 6000);
  let lastFlow = 0;

  function play(name, gain, rate) {
    if (!audible() || !buffers[name]) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start();
  }

  // Every frame: flow is the stream (0..1), cooling how hot the fresh cast still is (0..1).
  function update(dt, { flow = 0, cooling = 0 } = {}) {
    pour.set(0.75 * flow, dt);
    pour.tone.frequency.setTargetAtTime(700 + 1500 * flow, ctx.currentTime, 0.2);
    if (flow > 0.5 && lastFlow <= 0.5) play("sizzle", 0.45, 0.9 + nativeRandom() * 0.15);
    lastFlow = flow;
    cool.set(0.7 * Math.pow(Math.min(cooling, 1), 1.5), dt);
  }

  return {
    loaded,
    update,
    buffers,
    start() {
      started = true;
    },
    get running() {
      return ctx.state === "running";
    },
    get on() {
      return on;
    },
    set on(v) {
      on = v;
    },
    pause(p) {
      paused = p;
    },
  };
}

export { createSound };
