// Paper foley: one-shot samples (CC0, freesound.org) played with random variant, pitch and pan.
// The AudioContext starts on the first user gesture; nothing plays before that.

import { nativeRandom } from "modules/random.js";

const SETS = { crease: 10, open: 2, rustle: 4, tap: 8 };
const MAX_VOICES = 10;

// The samples download right away (onProgress(fraction) follows them); they are decoded once the AudioContext starts.
export function createPaperSound({ base = "./sounds/", enabled = true, onProgress } = {}) {
  let ctx = null;
  let master = null;
  let on = enabled;
  let voices = 0;
  let paused = false;
  let logger = null;
  const buffers = {};
  const last = {};

  const files = Object.entries(SETS).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => ({ name, i })));
  let fetched = 0;
  for (const file of files) {
    file.data = fetch(`${base}${file.name}-${file.i}.mp3`)
      .then((res) => res.arrayBuffer())
      .finally(() => onProgress?.(++fetched / files.length));
    file.data.catch(() => {});
  }
  const downloaded = Promise.allSettled(files.map((f) => f.data));

  async function start() {
    if (ctx) return;
    ctx = new AudioContext();
    if (paused) ctx.suspend();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master = ctx.createGain();
    master.gain.value = on ? 0.8 : 0;
    master.connect(comp).connect(ctx.destination);
    await Promise.all(
      files.map(async ({ name, i, data }) => {
        try {
          (buffers[name] ??= [])[i] = await ctx.decodeAudioData(await data);
        } catch (e) {
          console.warn("paper sound", name, i, e);
        }
      }),
    );
  }

  const gesture = () => {
    start();
    if (!paused) ctx?.resume();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  // gain 0..1, pan -1..1, delay in seconds; never repeats the previous variant of a set.
  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1 } = {}) {
    // Offline renders (video capture) get every event, with its variant and pitch, whether or not audio runs.
    if (logger && on && !paused && gain > 0.001 && SETS[name]) {
      let i = Math.floor(nativeRandom() * SETS[name]);
      if (SETS[name] > 1 && i === last[name]) i = (i + 1) % SETS[name];
      last[name] = i;
      logger({ name, variant: i, gain: Math.min(1, gain), pan, rate: rate * (0.9 + nativeRandom() * 0.2), time: performance.now() / 1000 + delay });
      return;
    }
    if (!ctx || !on || paused || ctx.state !== "running" || voices >= MAX_VOICES) return;
    const list = (buffers[name] || []).filter(Boolean);
    if (!list.length || gain <= 0.001) return;
    let i = Math.floor(nativeRandom() * list.length);
    if (list.length > 1 && i === last[name]) i = (i + 1) % list.length;
    last[name] = i;
    const src = ctx.createBufferSource();
    src.buffer = list[i];
    src.playbackRate.value = rate * (0.9 + nativeRandom() * 0.2);
    const g = ctx.createGain();
    g.gain.value = Math.min(1, gain);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    voices++;
    src.onended = () => voices--;
    src.start(ctx.currentTime + delay);
  }

  function setEnabled(value) {
    on = value;
    if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.05);
  }

  function setPaused(value) {
    paused = value;
    if (!ctx) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  }

  // fn(event) receives each sound instead of it playing; null restores playback.
  function setLogger(fn) {
    logger = fn;
  }

  return { play, setEnabled, setPaused, setLogger, downloaded, get enabled() { return on; } };
}
