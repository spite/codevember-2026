// CC0 foley (freesound.org, see README): cloth rustling when the head turns fast, a sheet flapping as the veil drops,
// teeth clacking when the jaw shuts, and a candle crackle under the embers while they glow. The AudioContext is created
// on load: it runs at once if the browser allows it, otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const SETS = { rustle: 3, drop: 2, clack: 2 };

function createSound({ base = "./sounds/", onProgress } = {}) {
  let on = true;
  let paused = false;
  // Nothing plays until the page is ready: start() lets it out.
  let started = false;
  const buffers = {};
  const last = {};
  let emberBuffer = null;

  const files = [...Object.entries(SETS).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => `${name}-${i}`)), "ember"];
  let fetched = 0;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  for (const file of files) {
    fetch(`${base}${file}.mp3`)
      .then((res) => res.arrayBuffer())
      .finally(() => onProgress?.(++fetched / files.length))
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        if (file === "ember") emberBuffer = buffer;
        else (buffers[file.split("-")[0]] ??= []).push(buffer);
      })
      .catch((e) => console.warn("sound", file, e));
  }

  const gesture = () => {
    if (!paused) ctx.resume();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  const live = () => started && on && !paused && ctx.state === "running";

  // A random variant (never the same one twice in a row), with a little pitch and gain spread.
  function play(name, { gain = 1, rate = 1 } = {}) {
    if (!live()) return;
    const set = buffers[name] || [];
    if (!set.length) return;
    let k = Math.floor(nativeRandom() * set.length);
    if (set.length > 1 && k === last[name]) k = (k + 1) % set.length;
    last[name] = k;
    const source = ctx.createBufferSource();
    source.buffer = set[k];
    source.playbackRate.value = rate * (0.92 + 0.16 * nativeRandom());
    const g = ctx.createGain();
    g.gain.value = gain * (0.8 + 0.2 * nativeRandom());
    source.connect(g).connect(master);
    source.start();
  }

  // The crackle loops from the start, silent until the embers glow.
  const emberGain = ctx.createGain();
  emberGain.gain.value = 0;
  emberGain.connect(master);
  let emberSource = null;
  let rustleAt = 0;

  return {
    get enabled() {
      return on;
    },
    get running() {
      return ctx.state === "running";
    },
    start() {
      started = true;
    },
    setEnabled(v) {
      on = v;
    },
    setPaused(v) {
      paused = v;
      if (paused) ctx.suspend();
      else ctx.resume();
    },
    drop() {
      play("drop", { gain: 0.5, rate: 1.1 });
    },
    clack(strength) {
      play("clack", { gain: 0.35 + 0.65 * strength });
    },
    // speed: how fast the head turns, in radians per second.
    rustle(speed) {
      const now = ctx.currentTime;
      if (speed < 1.2 || now < rustleAt) return;
      rustleAt = now + 0.35 + 0.3 * nativeRandom();
      play("rustle", { gain: Math.min(1, (speed - 1.2) / 3) * 0.6, rate: 1.15 });
    },
    ember(level) {
      if (!emberSource && emberBuffer && live()) {
        emberSource = ctx.createBufferSource();
        emberSource.buffer = emberBuffer;
        emberSource.loop = true;
        emberSource.connect(emberGain);
        emberSource.start();
      }
      const target = live() ? Math.min(1, level) * 0.55 : 0;
      emberGain.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
    },
  };
}

export { createSound };
