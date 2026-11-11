// The workshop: a scribe scratching while the pattern is drawn, a tink per hammer blow, the acid's fizz and hiss, the
// rinse and the burnishing rub. Cut from CC0 recordings (freesound.org, see README). The AudioContext is created on load: it
// runs at once if the browser allows it, otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const TINKS = 6;
const LOOPS = ["scratch", "fizz", "rub", "torch", "stone", "hiss"];
// Loops played from another's recording: the hiss is the fizz, sped up and stripped of its bubbles.
const FROM = { hiss: "fizz" };
const HIGHPASS = { hiss: 3500 };
const MAX_VOICES = 12;

function createSound({ base = "./sounds/", onProgress } = {}) {
  const ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  let on = true;
  let paused = false;
  const tinks = [];
  const loops = {};
  let voices = [];
  let lastTink = -1;

  const files = [...Array.from({ length: TINKS }, (_, i) => `tink-${i}`), ...LOOPS.filter((n) => !FROM[n]), "rinse"];
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
    for (let i = 0; i < TINKS; i++) if (buffers[`tink-${i}`]) tinks.push(buffers[`tink-${i}`]);
    for (const name of LOOPS) {
      const buffer = buffers[FROM[name] ?? name];
      if (!buffer) continue;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      if (HIGHPASS[name]) {
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = HIGHPASS[name];
        gain.connect(f).connect(master);
      } else gain.connect(master);
      loops[name] = { buffer, gain, source: null, level: 0 };
    }
  });

  const gesture = () => {
    if (!paused && ctx.state !== "running") ctx.resume();
  };
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  const live = () => on && !paused && ctx.state === "running";

  // A hammer blow: gain 0..1, pan -1..1, rate scales the pitch.
  function tink({ gain = 1, pan = 0, rate = 1 } = {}) {
    if (!live() || !tinks.length || gain < 0.01) return false;
    const now = ctx.currentTime;
    voices = voices.filter((t) => t > now);
    if (voices.length >= MAX_VOICES) return false;
    let i = Math.floor(nativeRandom() * tinks.length);
    if (tinks.length > 1 && i === lastTink) i = (i + 1) % tinks.length;
    lastTink = i;
    const buffer = tinks[i];
    const r = rate * (0.92 + nativeRandom() * 0.16);
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

  // A one-shot: the rinse as the acid drains off.
  function splash({ gain = 1 } = {}) {
    const buffer = buffers.rinse;
    if (!live() || !buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.94 + nativeRandom() * 0.12;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, gain);
    src.connect(g).connect(master);
    src.start(ctx.currentTime);
    return true;
  }

  // A loop's level (0..1), eased; the loop starts at a random point when it comes in and stops when silent.
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
      l.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
      l.level = target;
      l.quietSince = target > 0.001 ? null : ctx.currentTime;
    }
    if (l.source && l.level <= 0.001 && l.quietSince !== null && ctx.currentTime - l.quietSince > 0.6) {
      l.source.stop();
      l.source.disconnect();
      l.source = null;
    }
  }

  return {
    loaded,
    tink,
    splash,
    setLoop,
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
