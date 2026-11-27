// Glass foley over a sea-shore bed: one-shots cut from freesound.org recordings (see README) played with a random
// variant, pitch and pan, and a looping recording of small waves on a shingle beach. The AudioContext is created on load: it runs at once if the browser allows it (the visitor
// has already interacted), otherwise it resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const SETS = { clink: 14, tick: 6, scrape: 2, grind: 8, wavein: 2, waveout: 2 };
const MAX_VOICES = 24;
// At most this many of a set at once (grinds are long and would pile up into noise; clinks into a rattle)
const MAX_OF = { grind: 3, clink: 2, tick: 2 };
// Closest two plays of the same set may start, in seconds: a burst of contacts becomes a patter, not a pile-up.
const SPACING = { clink: 0.09, tick: 0.07, scrape: 0.08, grind: 0.12, wavein: 0.5, waveout: 0.5 };

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
  // A recording's soundtrack: everything scheduled on an offline context, timed by the page's clock (CCapture's virtual
  // one) from beginOffline
  let offline = null;
  const clock = () => (offline ? (performance.now() - offline.t0) / 1000 : ctx.currentTime);
  const running = () => !!offline || ctx?.state === "running";

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
    if (ctx || offline) return;
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
    decodedAll = true;
    maybeStartShore();
  }
  // The shore waits for both the decode and arm(), called on the page's first frame.
  let armed = false;
  let decodedAll = false;
  let shoreStarted = false;
  function maybeStartShore() {
    if (!armed || !decodedAll || shoreStarted) return;
    shoreStarted = true;
    startShore();
  }
  // Resolves once every sample is decoded
  const decoded = start();

  function startShore() {
    const shore = buffers.shore?.[0];
    if (!shore) return;
    const src = ctx.createBufferSource();
    src.buffer = shore;
    src.loop = true;
    // Skip the encoder's padding at both ends; the loop's own crossfade hides the seam
    src.loopStart = 0.03;
    src.loopEnd = shore.duration - 0.03;
    src.connect(shoreGain);
    src.start(0, nativeRandom() * (shore.duration - 1));
  }

  const gesture = () => {
    if (offline) return;
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
    if (!running()) return;
    const now = clock();
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
    if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, clock(), 0.05);
    if (shoreGain) shoreGain.gain.setTargetAtTime(on ? shoreLevel : 0, clock(), 0.3);
  }

  // A looping bed at level 0..1 and a playback rate, easing to them; created on first use.
  function setBed(name, level, rate = 1) {
    if (!ctx || !running()) return;
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
    // Offline, only changes are scheduled: a recording would otherwise pile up thousands of automation events
    const t = clock();
    const target = on && !paused ? level : 0;
    if (offline && Math.abs(target - (bed.level ?? -1)) < 0.004 && Math.abs(rate - (bed.rate ?? -1)) < 0.004) return;
    bed.level = target;
    bed.rate = rate;
    bed.gain.gain.setTargetAtTime(target, t, 0.15);
    bed.src.playbackRate.setTargetAtTime(rate, t, 0.3);
  }

  // Level of the shore bed, 0..1
  function setAmbience(level) {
    shoreLevel = level;
    if (shoreGain && on) shoreGain.gain.setTargetAtTime(level, clock(), 0.3);
  }

  function setPaused(value) {
    paused = value;
    if (!ctx || offline) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  }

  // Switches every later sound to an offline context of `seconds`, its time 0 now; the shore bed starts with it.
  function beginOffline(seconds) {
    if (offline) return;
    const o = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    const comp = o.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master = o.createGain();
    master.gain.value = 0.8;
    master.connect(comp).connect(o.destination);
    shoreGain = o.createGain();
    shoreGain.gain.value = shoreLevel;
    shoreGain.connect(o.destination);
    offline = { t0: performance.now() };
    ctx = o;
    on = true;
    paused = false;
    voices = [];
    for (const k of Object.keys(lastAt)) delete lastAt[k];
    for (const k of Object.keys(beds)) delete beds[k];
    startShore();
  }

  // The offline soundtrack as a 16-bit stereo WAV.
  async function renderOffline() {
    const buffer = await ctx.startRendering();
    const n = buffer.length;
    const data = new DataView(new ArrayBuffer(44 + n * 4));
    const text = (o, t) => [...t].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
    text(0, "RIFF");
    data.setUint32(4, 36 + n * 4, true);
    text(8, "WAVEfmt ");
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 2, true);
    data.setUint32(24, buffer.sampleRate, true);
    data.setUint32(28, buffer.sampleRate * 4, true);
    data.setUint16(32, 4, true);
    data.setUint16(34, 16, true);
    text(36, "data");
    data.setUint32(40, n * 4, true);
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(1);
    for (let i = 0; i < n; i++) {
      data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
      data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
    }
    return data.buffer;
  }

  return {
    arm() {
      armed = true;
      maybeStartShore();
    },
    downloaded,
    decoded,
    beginOffline,
    renderOffline,
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
      return running();
    },
  };
}
