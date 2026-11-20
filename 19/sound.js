// Glass foley over a sea-shore bed: one-shots cut from freesound.org recordings (see README) played with a random
// variant, pitch and pan, and a looping recording of small waves on a shingle beach. The AudioContext is created on load: it runs at once if the browser allows it (the visitor
// has already interacted), otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const SETS = { clink: 14, tick: 6, scrape: 2, grind: 8, wavein: 2, waveout: 2 };
const MAX_VOICES = 24;
// At most this many of a set at once (grinds are long and would pile up into noise)
const MAX_OF = { grind: 3 };
// Closest two plays of the same set may start, in seconds: a burst of contacts becomes a patter, not a pile-up.
const SPACING = { clink: 0.025, tick: 0.02, scrape: 0.08, grind: 0.12, wavein: 0.5, waveout: 0.5 };

// The samples download right away (onProgress(fraction) follows them); they are decoded once the AudioContext starts.
export function createSound({ base = "./sounds/", enabled = true, onProgress, ambience = 0.5 } = {}) {
  let ctx = null;
  let master = null;
  let shoreGain = null;
  let shoreLevel = ambience;
  let on = enabled;
  let paused = false;
  let voices = [];
  const buffers = {};
  const last = {};
  const lastAt = {};
  // fn(event) receives each sound instead of it playing (tests count them that way, silently).
  let logger = null;

  const files = Object.entries(SETS).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => ({ name, i })));
  files.push({ name: "shore", i: 0, url: `${base}shore.mp3` });
  // Loops whose level the page sets frame by frame (erosion: grinding and water)
  const BEDS = ["erode-grind", "erode-water"];
  for (const name of BEDS) files.push({ name, i: 0, url: `${base}${name}.mp3` });
  const beds = {};
  let fetched = 0;
  for (const file of files) {
    file.data = fetch(file.url ?? `${base}${file.name}-${file.i}.mp3`)
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
    // The shore bed skips the compressor, so clinks don't make it pump
    shoreGain = ctx.createGain();
    shoreGain.gain.value = on ? shoreLevel : 0;
    shoreGain.connect(ctx.destination);
    await Promise.all(
      files.map(async ({ name, i, data }) => {
        try {
          (buffers[name] ??= [])[i] = await ctx.decodeAudioData(await data);
        } catch (e) {
          console.warn("sound", name, i, e);
        }
      }),
    );
    const shore = buffers.shore?.[0];
    if (shore) {
      const src = ctx.createBufferSource();
      src.buffer = shore;
      src.loop = true;
      // Skip the encoder's padding at both ends; the loop's own crossfade hides the seam
      src.loopStart = 0.03;
      src.loopEnd = shore.duration - 0.03;
      src.connect(shoreGain);
      src.start(0, nativeRandom() * (shore.duration - 1));
    }
  }
  start();

  const gesture = () => {
    start();
    if (!paused) ctx?.resume();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  function pick(name, count) {
    let i = Math.floor(nativeRandom() * count);
    if (count > 1 && i === last[name]) i = (i + 1) % count;
    last[name] = i;
    return i;
  }

  // gain 0..1, pan -1..1, rate is the pitch (and speed); duration cuts it short with a fade.
  function play(name, { gain = 1, pan = 0, rate = 1, duration = 0 } = {}) {
    if (!on || paused || gain <= 0.002 || !SETS[name]) return;
    if (logger) return logger({ name, gain, pan, rate, duration });
    if (ctx?.state !== "running") return;
    const now = ctx.currentTime;
    if (now - (lastAt[name] ?? -Infinity) < SPACING[name]) return;
    const list = buffers[name]?.filter(Boolean);
    if (!list?.length) return;
    const buffer = list[pick(name, list.length)];
    const varied = rate * (0.94 + nativeRandom() * 0.12);
    const length = buffer.duration / varied;
    const end = now + (duration > 0 ? Math.min(duration + 0.15, length) : length);
    voices = voices.filter((v) => v.end > now);
    if (voices.length >= MAX_VOICES) return;
    if (MAX_OF[name] && voices.filter((v) => v.name === name).length >= MAX_OF[name]) return;
    lastAt[name] = now;
    voices.push({ end, name });
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = varied;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    g.gain.setValueAtTime(Math.min(1, gain), now);
    const offset = 0;
    src.start(now, offset);
    if (duration > 0) {
      g.gain.setTargetAtTime(0, now + Math.max(duration - 0.08, 0.02), 0.04);
      src.stop(now + duration + 0.15);
    }
  }

  function setEnabled(value) {
    on = value;
    if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.05);
    if (shoreGain) shoreGain.gain.setTargetAtTime(on ? shoreLevel : 0, ctx.currentTime, 0.3);
  }

  // A looping bed at level 0..1 and a playback rate, easing to them; created on first use.
  function setBed(name, level, rate = 1) {
    if (!ctx || ctx.state !== "running") return;
    let bed = beds[name];
    if (!bed) {
      const buffer = buffers[name]?.[0];
      if (!buffer || level <= 0.001) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = 0.03;
      src.loopEnd = buffer.duration - 0.03;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(master);
      src.start(0, nativeRandom() * (buffer.duration - 0.5));
      bed = beds[name] = { src, gain };
    }
    bed.gain.gain.setTargetAtTime(on && !paused ? level : 0, ctx.currentTime, 0.15);
    bed.src.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.3);
  }

  // Level of the shore bed, 0..1
  function setAmbience(level) {
    shoreLevel = level;
    if (shoreGain && on) shoreGain.gain.setTargetAtTime(level, ctx.currentTime, 0.3);
  }

  function setPaused(value) {
    paused = value;
    if (!ctx) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  }

  return {
    downloaded,
    play,
    setEnabled,
    setAmbience,
    setBed,
    setPaused,
    setLogger: (fn) => (logger = fn),
    get enabled() {
      return on;
    },
    get running() {
      return ctx?.state === "running";
    },
  };
}
