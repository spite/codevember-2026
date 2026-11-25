// A dungeon, CC0 (freesound.org, see README): wind that rises with each gust, water dripping somewhere in the dark, and
// now and then a chain clinking in another room. The AudioContext is created on load: it runs at once if the browser
// allows it, otherwise it resumes on the first gesture. Variation uses nativeRandom, so the seeded look doesn't shift.
import { nativeRandom } from "modules/random.js";

// Where the muffle over everything starts to cut, in Hz.
const MUFFLE_HZ = 1600;

function createSound({ base = "./sounds/", sets, onProgress } = {}) {
  let on = true;
  let paused = false;
  // Nothing plays until the page is ready (the loader is done): start() lets it out.
  let started = false;
  const buffers = {};
  const last = {};

  const files = Object.entries(sets).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => `${name}-${i}`));
  let fetched = 0;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 1;
  // Everything heard through the veil and the stone: soft, muffled.
  const muffle = ctx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = MUFFLE_HZ;
  muffle.Q.value = 0.5;
  master.connect(muffle).connect(ctx.destination);
  // Far-off things more so.
  const far = ctx.createBiquadFilter();
  far.type = "lowpass";
  far.frequency.value = 1100;
  far.Q.value = 0.5;
  far.connect(master);

  for (const file of files) {
    fetch(`${base}${file}.mp3`)
      .then((res) => res.arrayBuffer())
      .finally(() => onProgress?.(++fetched / files.length))
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => ((buffers[file.split("-")[0]] ??= [])[Number(file.split("-")[1])] = buffer))
      .catch((e) => console.warn("sound", file, e));
  }

  const gesture = () => {
    if (!paused) ctx.resume();
  };
  // iOS only unlocks audio on touchend/click.
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, gesture, { capture: true });

  const live = () => started && on && !paused && ctx.state === "running";
  // A capture can't play sound: it gets each cue instead (name, when, gain, pan, rate), to build the soundtrack from.
  let cueHook = null;

  // A random variant (never the same one twice in a row), with a little pitch and gain spread, panned.
  function play(name, { gain = 1, rate = 1, pan = 0, out = master, when = 0 } = {}) {
    if (!started || !on || paused) return null;
    const set = buffers[name] || [];
    const count = set.length || sets[name] || 0;
    if (!count) return null;
    let k = Math.floor(nativeRandom() * count);
    if (count > 1 && k === last[name]) k = (k + 1) % count;
    last[name] = k;
    rate *= 0.94 + 0.12 * nativeRandom();
    gain *= 0.8 + 0.2 * nativeRandom();
    cueHook?.({ name: `${name}-${k}`, when, gain, pan, rate, far: out === far });
    if (ctx.state !== "running" || !set[k]) return null;
    const source = ctx.createBufferSource();
    source.buffer = set[k];
    source.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    source.connect(g).connect(p).connect(out);
    source.start(ctx.currentTime + when);
    return { source, gain: g };
  }

  // The wind bed loops quietly under everything and swells with the gusts.
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  windGain.connect(master);
  let windSource = null;
  function ensureWind() {
    if (windSource || !buffers.windbed?.[0] || !live()) return;
    windSource = ctx.createBufferSource();
    windSource.buffer = buffers.windbed[0];
    windSource.loop = true;
    windSource.connect(windGain);
    windSource.start();
  }

  // When the next drip and the next chain are due, in seconds of page time (paused time doesn't count).
  let dripIn = 1.5;
  let windCueIn = 0;
  let chainIn = 8;

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
    // fn({ name, when, gain, pan, rate, far }) for each sound played (a capture logs them).
    onCue(fn) {
      cueHook = fn;
    },
    setEnabled(v) {
      on = v;
      windGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    },
    setPaused(v) {
      paused = v;
      if (paused) ctx.suspend();
      else ctx.resume();
    },
    // A gust begins: strength 0..1.
    gust(strength) {
      play("gust", { gain: 0.22 + 0.22 * strength, pan: (nativeRandom() - 0.5) * 0.8 });
    },
    // Once a frame: the wind bed follows how hard it's blowing (0..1); drips and chains come at random.
    update(dt, wind) {
      ensureWind();
      // Every clip is levelled per kind in sounds/; these gains set the balance: drips, chains and gusts about equally
      // loud, the wind bed under them, rising with the gusts.
      const level = 0.18 + 0.3 * Math.min(1, wind);
      windGain.gain.setTargetAtTime(live() ? level : 0, ctx.currentTime, 0.4);
      if (!started || !on || paused || dt <= 0) return;
      // The wind bed's level, ten times a second, for a capture's soundtrack.
      if (cueHook && (windCueIn -= dt) <= 0) {
        cueHook({ name: "windbed-0", level });
        windCueIn = 0.1;
      }
      if ((dripIn -= dt) <= 0) {
        const pan = (nativeRandom() - 0.5) * 1.6;
        play("drip", { gain: 0.3 + 0.2 * nativeRandom(), pan, rate: 0.9 + 0.25 * nativeRandom() });
        // Now and then a second drop from the same place.
        if (nativeRandom() < 0.25) play("drip", { gain: 0.2, pan, when: 0.25 + 0.5 * nativeRandom() });
        dripIn = 1.5 + 4.5 * nativeRandom();
      }
      if ((chainIn -= dt) <= 0) {
        play("chain", { gain: 0.55 + 0.25 * nativeRandom(), pan: (nativeRandom() - 0.5) * 1.4, out: far, rate: 0.9 + 0.15 * nativeRandom() });
        chainIn = 10 + 15 * nativeRandom();
      }
    },
  };
}

export { createSound };
