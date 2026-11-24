// Wooden foley cut from CC0 recordings (freesound.org, see README): small wooden boxes and lids opening as the halves
// part, closing as they seat, over a looping song. The AudioContext is created on load: it runs at once if the browser
// allows it, otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const SETS = { open: 6, close: 3 };

function createSound({ base = "./sounds/", music: musicUrl = "./music.mp3", musicGain = 0.3, onProgress } = {}) {
  let on = true;
  let paused = false;
  // Nothing plays until the page is ready (the loader is done): start() lets it out.
  let started = false;
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

  const ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  // Muffled: the wood heard through a soft low-pass, as if from inside the hollow.
  const muffle = ctx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 1800;
  muffle.Q.value = 0.5;
  master.connect(muffle).connect(comp).connect(ctx.destination);
  // The song streams through the same context, so pausing and muting reach it too; it skips the muffle.
  const music = new Audio(musicUrl);
  music.loop = true;
  music.preload = "auto";
  const musicOut = ctx.createGain();
  musicOut.gain.value = musicGain;
  ctx.createMediaElementSource(music).connect(musicOut).connect(ctx.destination);
  const syncMusic = () => {
    if (started && on && !paused && ctx.state === "running") music.play().catch(() => {});
    else music.pause();
  };
  ctx.addEventListener("statechange", syncMusic);

  for (const { name, i, data } of files) {
    data
      .then((buf) => ctx.decodeAudioData(buf))
      .then((b) => ((buffers[name] ??= [])[i] = b))
      .catch((e) => console.warn("sound", name, i, e));
  }

  const gesture = () => {
    if (!paused) ctx.resume();
    syncMusic();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  // A random variant (never the same one twice in a row), with a little pitch and gain spread.
  function play(name, { gain = 1, rate = 1, delay = 0, pan = 0 } = {}) {
    if (!started || !on || paused || ctx.state !== "running") return;
    const set = (buffers[name] || []).filter(Boolean);
    if (!set.length) return;
    let k = Math.floor(nativeRandom() * set.length);
    if (set.length > 1 && k === last[name]) k = (k + 1) % set.length;
    last[name] = k;
    const src = ctx.createBufferSource();
    src.buffer = set[k];
    src.playbackRate.value = rate * (0.93 + nativeRandom() * 0.14);
    const g = ctx.createGain();
    g.gain.value = gain * (0.85 + nativeRandom() * 0.3);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    src.start(ctx.currentTime + delay);
  }

  return {
    downloaded,
    play,
    start() {
      started = true;
      syncMusic();
    },
    get running() {
      return ctx.state === "running";
    },
    get enabled() {
      return on;
    },
    setEnabled(v) {
      on = !!v;
      master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.02);
      if (on) gesture();
      else syncMusic();
    },
    setPaused(v) {
      paused = !!v;
      if (paused) ctx.suspend();
      else if (navigator.userActivation?.hasBeenActive) ctx.resume();
      syncMusic();
    },
  };
}

export { createSound };
