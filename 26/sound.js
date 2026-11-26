// Toy wooden blocks knocking as each block splits off or closes up, a wooden click as the figure lands in its sweet spot,
// a deep cinematic whoosh as each orbit sets off (CC0 recordings from freesound.org, see README), and a layered air
// swoosh that follows how fast the camera swings, all in a short room reverb. The AudioContext is created on load: it runs at once if the browser allows it, otherwise it resumes on the
// first gesture.
import { nativeRandom } from "modules/random.js";

const SAMPLES = ["split-0", "split-1", "split-2", "land", "whoosh-0", "whoosh-1"];

// ctx: an OfflineAudioContext to render into instead (recordings); then `at` in play()/swoosh() places events in time.
function createSound({ base = "./sounds/", onProgress, ctx: offlineCtx = null } = {}) {
  let on = true;
  let paused = false;
  // Nothing plays until the page is ready (the loader is done): start() lets it out.
  let started = false;
  const buffers = {};
  let lastSplit = -1;

  const ctx = offlineCtx ?? new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 3;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  // Reverb: a generated two-second decaying noise tail, mixed in on a send.
  const reverb = ctx.createConvolver();
  const irLength = Math.floor(ctx.sampleRate * 2.2);
  const ir = ctx.createBuffer(2, irLength, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < irLength; i++) d[i] = (nativeRandom() * 2 - 1) * Math.pow(1 - i / irLength, 3.2);
  }
  reverb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.16;
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

  // Swoosh: looping pink-ish noise in three layers whose levels and pitch follow the camera's angular speed: a low body,
  // a band that sweeps up with speed and flutters (a tremolo as fast as the turn), and high air on top.
  const noise = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = noise.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const w = nativeRandom() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  const swooshSrc = ctx.createBufferSource();
  swooshSrc.buffer = noise;
  swooshSrc.loop = true;
  const swooshPan = ctx.createStereoPanner();
  const swooshOut = ctx.createGain();
  swooshOut.gain.value = 0;
  swooshOut.connect(swooshPan).connect(master);

  const body = ctx.createBiquadFilter();
  body.type = "lowpass";
  body.frequency.value = 160;
  body.Q.value = 2.5;
  const bodyGain = ctx.createGain();
  swooshSrc.connect(body).connect(bodyGain).connect(swooshOut);

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 400;
  band.Q.value = 1.4;
  const flutter = ctx.createGain();
  const flutterLfo = ctx.createOscillator();
  flutterLfo.frequency.value = 6;
  const flutterDepth = ctx.createGain();
  flutterDepth.gain.value = 0;
  flutterLfo.connect(flutterDepth).connect(flutter.gain);
  flutterLfo.start();
  const bandGain = ctx.createGain();
  swooshSrc.connect(band).connect(flutter).connect(bandGain).connect(swooshOut);

  const air = ctx.createBiquadFilter();
  air.type = "highpass";
  air.frequency.value = 4500;
  const airGain = ctx.createGain();
  swooshSrc.connect(air).connect(airGain).connect(swooshOut);
  swooshSrc.start();

  if (!offlineCtx) {
    const gesture = () => {
      if (!paused) ctx.resume();
    };
    // iOS only unlocks audio on touchend/click.
    for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });
  }

  const audible = () => started && on && !paused && (offlineCtx || ctx.state === "running");

  // A sample with a little pitch, gain and pan spread.
  function play(name, { gain = 1, rate = 1, delay = 0, pan = 0, at = ctx.currentTime } = {}) {
    if (!audible() || !buffers[name]) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate * (0.9 + nativeRandom() * 0.2);
    const g = ctx.createGain();
    g.gain.value = gain * (0.7 + nativeRandom() * 0.4);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    src.start(at + delay);
  }

  // Called every frame with the camera's angular speed (radians per second) and where it is around the figure (-1..1,
  // left to right), which pans the air across as it swings.
  function swoosh(speed, side, t = ctx.currentTime) {
    // A gentle curve, so the swoosh carries through the slow end of the glide instead of dying with the fast start.
    const level = audible() ? Math.pow(Math.min(1, speed / 4), 0.5) : 0;
    swooshOut.gain.setTargetAtTime(level > 0.02 ? 1 : 0, t, 0.08);
    bodyGain.gain.setTargetAtTime(0.4 * level, t, 0.1);
    body.frequency.setTargetAtTime(110 + 220 * level, t, 0.12);
    bandGain.gain.setTargetAtTime(0.32 * level, t, 0.08);
    band.frequency.setTargetAtTime(260 + 1500 * level * level, t, 0.1);
    flutterLfo.frequency.setTargetAtTime(2 + 10 * level, t, 0.12);
    flutterDepth.gain.setTargetAtTime(0.25 * level, t, 0.12);
    flutter.gain.setTargetAtTime(1 - 0.25 * level, t, 0.12);
    airGain.gain.setTargetAtTime(0.1 * level * level * level, t, 0.06);
    swooshPan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, side * 0.8)), t, 0.08);
  }

  return {
    loaded,
    // A random split knock, never the same one twice in a row.
    split(opts) {
      let k = Math.floor(nativeRandom() * 3);
      if (k === lastSplit) k = (k + 1) % 3;
      lastSplit = k;
      play(`split-${k}`, opts);
    },
    land: (opts) => play("land", opts),
    // A deep whoosh as an orbit sets off.
    whoosh(opts) {
      play(`whoosh-${Math.floor(nativeRandom() * 2)}`, opts);
    },
    swoosh,
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
      if (!on) swooshOut.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    },
    pause(p) {
      paused = p;
      if (p) swooshOut.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    },
  };
}

export { createSound };
