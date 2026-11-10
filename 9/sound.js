// Rubbery voops, suction pops and squelches played backwards: one-shots cut from CC0 recordings (freesound.org, see
// README), played with a random variant, pitch and pan, muffled and given a short dark echo, as if heard through jelly
// and glass. The AudioContext is created on load: it runs at once if the browser allows it, otherwise it resumes on
// the first gesture.
import { nativeRandom } from "modules/random.js";

// Impacts between bodies, which bodies at rest reuse softly; a pop as a set leaves and a swell as the next comes in.
// A bounce: the jelly's low, wobbling "hmm-hum" on a hard knock.
// A marble: floaters knocking about inside the bodies.
// A swoosh: the container swung round.
const SETS = { squish: 3, stretch: 3, swell: 5, bounce: 2, marble: 5, swoosh: 4 };
// A deep voop: the impact clips, pitched well down, under their own name so they never block the squishes.
const ALIAS = { deep: "squish" };
const SPACING = { squish: 0.05, stretch: 0.4, swell: 0.4, bounce: 0.12, deep: 0.1, marble: 0.05, swoosh: 0.3 };
const MAX_VOICES = 16;
const PRIORITY = new Set(["stretch", "swell"]);

// A small room's impulse response: a few early reflections, then a stereo tail of noise that decays and darkens.
function roomImpulse(ctx, seconds) {
  const n = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      // The tail gets darker as it decays: a one-pole lowpass whose cutoff falls with time.
      const k = Math.exp(-2 * Math.PI * (3000 * Math.exp(-t * 4) + 300) / ctx.sampleRate);
      lp = (1 - k) * (nativeRandom() * 2 - 1) + k * lp;
      d[i] = lp * Math.exp(-t * 6) * 2;
    }
    for (const [at, g] of [[0.011, 0.5], [0.019, 0.35], [0.031, 0.25], [0.047, 0.18]]) d[Math.round((at + c * 0.003) * ctx.sampleRate)] += g;
  }
  return ir;
}

function createSound({ base = "./sounds/", onProgress } = {}) {
  const ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  // Muffled: the direct sound through a soft lowpass. Echo: a short, dark room, convolved and mixed in under it.
  const muffle = ctx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 3500;
  muffle.Q.value = 0.5;
  const dry = ctx.createGain();
  dry.gain.value = 0.85;
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx, 0.9);
  const wet = ctx.createGain();
  wet.gain.value = 0.4;
  master.connect(muffle).connect(dry).connect(comp);
  muffle.connect(room).connect(wet).connect(comp);
  comp.connect(ctx.destination);
  let on = true;
  let paused = false;
  const buffers = {};
  const lastAt = {};
  const last = {};
  let voices = [];

  const files = Object.entries(SETS).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => ({ name, i })));
  let fetched = 0;
  const loaded = Promise.all(
    files.map(({ name, i }) =>
      fetch(`${base}${name}-${i}.mp3`)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((b) => ((buffers[name] ??= [])[i] = b))
        .catch((e) => console.warn("sound", name, i, e))
        .finally(() => onProgress?.(++fetched / files.length)),
    ),
  );

  const gesture = () => {
    if (!paused && ctx.state !== "running") ctx.resume();
  };
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  function pick(name, count) {
    let i = Math.floor(nativeRandom() * count);
    if (count > 1 && i === last[name]) i = (i + 1) % count;
    last[name] = i;
    return i;
  }

  // gain 0..1, pan -1..1, rate scales the pitch.
  function play(name, { gain = 1, pan = 0, rate = 1 } = {}) {
    if (!on || paused || ctx.state !== "running" || gain < 0.01) return false;
    const now = ctx.currentTime;
    if (now - (lastAt[name] ?? -1) < SPACING[name]) return false;
    const list = buffers[ALIAS[name] ?? name]?.filter(Boolean);
    if (!list?.length) return false;
    voices = voices.filter((t) => t > now);
    // The shape change's sounds always play; impacts give way when the voices are full.
    if (voices.length >= MAX_VOICES && !PRIORITY.has(name)) return false;
    lastAt[name] = now;
    const buffer = list[pick(name, list.length)];
    const r = rate * (0.9 + nativeRandom() * 0.2);
    voices.push(now + buffer.duration / r);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = r;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, gain);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    src.start(now);
    return true;
  }

  return {
    loaded,
    play,
    get running() {
      return ctx.state === "running";
    },
    get enabled() {
      return on;
    },
    setEnabled(v) {
      on = v;
      master.gain.setTargetAtTime(on ? 0.85 : 0, ctx.currentTime, 0.05);
    },
    setPaused(v) {
      paused = v;
      if (v) ctx.suspend();
      else if (navigator.userActivation?.hasBeenActive ?? true) ctx.resume();
    },
  };
}

export { createSound };
