// The station and its water: a cabin hum and ventilation under everything, drops and a spreading ripple for taps, a slosh while stirring,
// squishes as a tendril stretches, a bloop when it snaps and a plop when a drop lands, a swirl and a whoosh for a spin,
// bubbles while the shape morphs. Cut from CC0 recordings (freesound.org, see README). The AudioContext is created on
// load: it runs at once if the browser allows it, otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const DROPS = 17;
const SQUISHES = 4;
const RIPPLES = 6;
const SHOTS = ["bloop", "plop", "swirl", "whoosh"];
const LOOPS = ["slosh", "bubbles", "hum", "vent"];
const MAX_VOICES = 14;

function createSound({ base = new URL("./sounds/", import.meta.url).href, onProgress } = {}) {
  const ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  // The cabin bed has its own lowpass, so each background can sound warmer or emptier.
  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = "lowpass";
  bedFilter.frequency.value = 8000;
  bedFilter.connect(master);
  let on = true;
  let paused = false;
  const drops = [];
  const squishes = [];
  const shots = {};
  const loops = {};
  let voices = [];
  let lastDrop = -1;

  // Ripples run through a warm lowpass, under the drop's bright plink.
  const rippleBus = ctx.createBiquadFilter();
  rippleBus.type = "lowpass";
  rippleBus.frequency.value = 2600;
  rippleBus.connect(master);
  const ripples = [];
  const files = [...Array.from({ length: RIPPLES }, (_, i) => `ripple-${i}`), ...Array.from({ length: DROPS }, (_, i) => `drop-${i}`), ...Array.from({ length: SQUISHES }, (_, i) => `squish-${i}`), ...SHOTS, ...LOOPS];
  let fetched = 0;
  const buffers = {};
  const loaded = Promise.all(
    files.map((name) =>
      fetch(`${base}${name}.mp3`)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((b) => (buffers[name] = b))
        .catch((e) => console.warn("sound", name, e))
        .finally(() => onProgress?.(++fetched / files.length)),
    ),
  ).then(() => {
    for (let i = 0; i < DROPS; i++) if (buffers[`drop-${i}`]) drops.push(buffers[`drop-${i}`]);
    for (let i = 0; i < RIPPLES; i++) if (buffers[`ripple-${i}`]) ripples.push(buffers[`ripple-${i}`]);
    for (let i = 0; i < SQUISHES; i++) if (buffers[`squish-${i}`]) squishes.push(buffers[`squish-${i}`]);
    for (const name of SHOTS) shots[name] = buffers[name];
    for (const name of LOOPS) {
      if (!buffers[name]) continue;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(name === "hum" || name === "vent" ? bedFilter : master);
      loops[name] = { buffer: buffers[name], gain, source: null, level: 0, quietSince: null };
    }
  });

  const gesture = () => {
    if (!paused && ctx.state !== "running") ctx.resume();
  };
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });
  // A hidden tab stops the frames that set the loops' levels: silence it rather than leave them at their last.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) ctx.suspend();
    else if (!paused && (navigator.userActivation?.hasBeenActive ?? true)) ctx.resume();
  });

  const live = () => on && !paused && ctx.state === "running";

  // Nothing plays before arm(), called on the page's first frame (a gesture during the load is silent).
  let armed = false;
  function play(buffer, { gain = 1, pan = 0, rate = 1, at = ctx.currentTime, out = master } = {}) {
    if (!armed || !live() || !buffer || gain < 0.005) return false;
    voices = voices.filter((t) => t > ctx.currentTime);
    if (voices.length >= MAX_VOICES) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = Math.min(1.2, gain);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(out);
    src.start(at);
    voices.push(at + buffer.duration / rate);
    return true;
  }

  // A drop for a tap: size (0.3..3) lowers the pitch and raises the level; pan -1..1. Never the same drop twice running.
  function drop({ size = 1, pan = 0, gain = 1 } = {}) {
    if (!drops.length) return false;
    let i = Math.floor(nativeRandom() * drops.length);
    if (drops.length > 1 && i === lastDrop) i = (i + 1) % drops.length;
    lastDrop = i;
    const rate = (0.9 + nativeRandom() * 0.25) / Math.pow(size, 0.35);
    return play(drops[i], { gain: gain * (0.55 + 0.3 * Math.min(size, 2)) * (0.8 + 0.3 * nativeRandom()), pan, rate });
  }

  // The ring spreading out after a tap: a soft swell just behind the drop, lower and longer for bigger taps.
  function ripple({ size = 1, pan = 0, gain = 1 } = {}) {
    if (!ripples.length) return false;
    const buffer = ripples[Math.floor(nativeRandom() * ripples.length)];
    const rate = (0.85 + nativeRandom() * 0.25) / Math.pow(size, 0.25);
    return play(buffer, { gain: gain * (0.35 + 0.25 * Math.min(size, 2)), pan: pan * 0.7, rate, at: ctx.currentTime + 0.05, out: rippleBus });
  }

  function squish({ gain = 0.6, pan = 0 } = {}) {
    if (!squishes.length) return false;
    return play(squishes[Math.floor(nativeRandom() * squishes.length)], { gain, pan, rate: 0.85 + nativeRandom() * 0.35 });
  }

  // bloop (a tendril snaps), plop (a drop lands; size lowers it), swirl and whoosh (a spin), each a little varied.
  function shot(name, { gain = 1, pan = 0, rate = 1 } = {}) {
    return play(shots[name], { gain, pan, rate: rate * (0.92 + nativeRandom() * 0.16) });
  }

  // A loop's level (0..1), eased; it starts at a random point when it comes in and stops once it has been silent.
  function setLoop(name, level, rate = 1) {
    const l = loops[name];
    if (!l) return;
    const target = live() ? level : 0;
    if (target > 0.001 && !l.source) {
      const src = ctx.createBufferSource();
      src.buffer = l.buffer;
      src.loop = true;
      // Skips the mp3 encoder's padding at both ends.
      src.loopStart = 0.03;
      src.loopEnd = l.buffer.duration - 0.03;
      src.connect(l.gain);
      src.start(ctx.currentTime, nativeRandom() * l.buffer.duration);
      l.source = src;
    }
    if (l.source) l.source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.1);
    if (Math.abs(target - l.level) > 0.002) {
      l.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.12);
      l.level = target;
      l.quietSince = target > 0.001 ? null : ctx.currentTime;
    }
    if (l.source && target <= 0.001 && l.quietSince === null) l.quietSince = ctx.currentTime;
    if (l.source && l.level <= 0.001 && l.quietSince !== null && ctx.currentTime - l.quietSince > 0.8) {
      l.source.stop();
      l.source.disconnect();
      l.source = null;
    }
  }

  // The cabin bed for a background: { hum, vent, lowpass (Hz) }, eased.
  function setBed({ hum, vent, lowpass }) {
    setLoop("hum", hum);
    setLoop("vent", vent);
    bedFilter.frequency.setTargetAtTime(lowpass, ctx.currentTime, 0.3);
  }

  return {
    loaded,
    arm: () => (armed = true),
    drop,
    ripple,
    squish,
    shot,
    setLoop,
    setBed,
    get running() {
      return ctx.state === "running";
    },
    get enabled() {
      return on;
    },
    setEnabled(v) {
      on = v;
      master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.05);
    },
    setPaused(v) {
      paused = v;
      if (v) ctx.suspend();
      else if (navigator.userActivation?.hasBeenActive ?? true) ctx.resume();
    },
  };
}

export { createSound };
