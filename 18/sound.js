// Mechanical foley: one-shots cut from CC0 recordings (freesound.org, see README; the set day 6 uses), played with a
// random variant, pitch and pan, and the bob's whoosh, noise filtered by how fast it moves. The AudioContext is
// created on load: it runs at once if the browser allows it (the visitor has already interacted), otherwise it
// resumes on the first gesture.
import { nativeRandom } from "modules/random.js";

const SETS = { tick: 5, click: 4, latch: 3, clack: 2, slide: 5, clink: 4, pop: 4, cog: 5, lever: 4, kaching: 2, spin: 4, ratchet: 7, bolt: 6, press: 4, shift: 9, whirr: 2, crank: 3 };
const MAX_VOICES = 32;
// Closest two plays of the same set may start, in seconds: a cascade becomes a patter, not a pile-up.
const SPACING = { tick: 0.012, click: 0.015, latch: 0.02, clack: 0.012, slide: 0.03, clink: 0.03, pop: 0.04, cog: 0.03, lever: 0.04, kaching: 0.5, spin: 0.05, ratchet: 0.008, bolt: 0.035, press: 0.05, shift: 0.025, whirr: 0.1, crank: 0.3 };

// Brown noise (white noise summed and leaking away, normalised): a soft rush of air with no hiss in it.
function brown(data) {
  let b = 0, peak = 1e-6;
  for (let i = 0; i < data.length; i++) {
    b = (b + 0.02 * (nativeRandom() * 2 - 1)) / 1.02;
    data[i] = b;
    peak = Math.max(peak, Math.abs(b));
  }
  for (let i = 0; i < data.length; i++) data[i] /= peak;
}

// The samples download right away (onProgress(fraction) follows them); they are decoded once the AudioContext starts.
export function createSound({ base = "./sounds/", enabled = true, onProgress } = {}) {
  let ctx = null;
  let master = null;
  let on = enabled;
  let paused = false;
  let voices = [];
  const buffers = {};
  const last = {};
  const lastAt = {};
  const whooshes = [];
  // fn(event) receives each sound instead of it playing (tests count them that way, silently).
  let logger = null;
  // A recording's soundtrack: everything scheduled on an offline context, timed by the page's clock (CCapture's virtual
  // one) from when it began, and rendered to a WAV at the end. Nothing is heard.
  let offline = null;
  const clock = () => (offline ? (performance.now() - offline.t0) / 1000 : ctx.currentTime);
  const running = () => !!offline || ctx?.state === "running";

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
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    master = ctx.createGain();
    master.gain.value = on ? 0.8 : 0;
    master.connect(comp).connect(ctx.destination);
    await Promise.all(
      files.map(async ({ name, i, data }) => {
        try {
          (buffers[name] ??= [])[i] = await ctx.decodeAudioData(await data);
        } catch (e) {
          console.warn("sound", name, i, e);
        }
      }),
    );
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

  // gain 0..1, pan -1..1, delay and duration in seconds (duration cuts it short with a fade).
  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1, duration = 0 } = {}) {
    if (!on || paused || gain <= 0.001 || !SETS[name]) return;
    if (logger) return logger({ name, gain, pan, delay, rate, duration });
    if (!running()) return;
    const now = clock() + Math.max(delay, 0);
    if (Math.abs(now - (lastAt[name] ?? -Infinity)) < SPACING[name]) return;
    lastAt[name] = now;
    const list = buffers[name]?.filter(Boolean);
    if (!list?.length) return;
    const buffer = list[pick(name, list.length)];
    const varied = rate * (0.92 + nativeRandom() * 0.16);
    const end = now + (duration > 0 ? Math.min(duration + 0.2, buffer.duration / varied) : buffer.duration / varied);
    voices = voices.filter((v) => v.end > clock());
    if (voices.filter((v) => v.start <= now && v.end > now).length >= MAX_VOICES) return;
    voices.push({ start: now, end });
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = varied;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    g.gain.setValueAtTime(Math.min(1, gain), now);
    src.start(now);
    if (duration > 0) {
      g.gain.setTargetAtTime(0, now + Math.max(duration - 0.12, 0.02), 0.04);
      src.stop(now + duration + 0.2);
    }
  }

  // A run of ratchet clicks over `duration`, bunched where a turn moves fastest.
  function ratchet({ teeth, duration, gain = 1, pan = 0, delay = 0, rate = 1 }) {
    const n = Math.max(1, Math.min(teeth, 24));
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const t = 0.5 - Math.cos(u * Math.PI) / 2;
      play("ratchet", { gain: gain * (0.75 + 0.25 * Math.sin(u * Math.PI)), pan, delay: delay + t * duration, rate });
    }
  }

  // Air past a moving bob: looping noise through a band-pass, its level and pitch following the bob's speed.
  function whoosh(index) {
    if (!running()) return null;
    if (whooshes[index]) return whooshes[index];
    const length = ctx.sampleRate * 2;
    const noise = ctx.createBuffer(1, length, ctx.sampleRate);
    brown(noise.getChannelData(0));
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "lowpass";
    band.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner();
    src.connect(band).connect(g).connect(p).connect(master);
    src.start();
    return (whooshes[index] = { band, gain: g, pan: p });
  }

  // speed 0..1 (of the swing's fastest), pan -1..1.
  function air(index, speed, pan, level = 1) {
    const w = whoosh(index);
    if (!w) return;
    const t = clock();
    const s = Math.max(0, Math.min(1, speed));
    w.gain.gain.setTargetAtTime(on && !paused ? 0.13 * level * s * s : 0, t, 0.08);
    w.band.frequency.setTargetAtTime(180 + 520 * s, t, 0.08);
    w.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.08);
  }

  // Fades out every whoosh from index `from` on: bobs no longer swinging.
  function silenceAir(from = 0) {
    if (whooshes.length <= from) return;
    const t = clock();
    for (let i = from; i < whooshes.length; i++) whooshes[i]?.gain.gain.setTargetAtTime(0, t, 0.08);
  }

  // A short rush of air: noise swept up through a band-pass, for the bob slipping through a gate.
  function swish({ gain = 1, pan = 0, delay = 0, duration = 0.16, pitch = 1 } = {}) {
    if (logger && on && !paused) return logger({ name: "swish", gain, pan, delay, pitch });
    if (!on || paused || !running()) return;
    const now = clock() + Math.max(delay, 0);
    if (Math.abs(now - (lastAt.swish ?? -Infinity)) < 0.03) return;
    lastAt.swish = now;
    const n = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    brown(buffer.getChannelData(0));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = "lowpass";
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(350 * pitch, now);
    band.frequency.exponentialRampToValueAtTime(1300 * pitch, now + duration * 0.5);
    band.frequency.exponentialRampToValueAtTime(500 * pitch, now + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.4 * gain), now + duration * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(band).connect(g).connect(p).connect(master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  // A small bell: a few inharmonic partials, each dying away at its own rate.
  function bell({ gain = 1, pan = 0, delay = 0, pitch = 1 } = {}) {
    if (logger && on && !paused) return logger({ name: "bell", gain, pan, delay, pitch });
    if (!on || paused || !running()) return;
    const now = clock() + Math.max(delay, 0);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(master);
    const f0 = 659 * pitch;
    for (const [ratio, level, decay] of [[1, 1, 2.6], [2.01, 0.5, 1.7], [3.02, 0.28, 1.1], [4.17, 0.16, 0.8], [5.43, 0.08, 0.55]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f0 * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.09 * gain * level, now + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      o.connect(g).connect(p);
      o.start(now);
      o.stop(now + decay + 0.05);
    }
  }

  function beginOffline(seconds) {
    if (offline) return;
    const o = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    const comp = o.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    const m = o.createGain();
    m.gain.value = 0.8;
    m.connect(comp).connect(o.destination);
    offline = { t0: performance.now() };
    ctx = o;
    master = m;
    on = true;
    paused = false;
    whooshes.length = 0;
    voices = [];
    for (const k of Object.keys(lastAt)) delete lastAt[k];
  }

  // The offline soundtrack as a 16-bit stereo WAV.
  async function renderOffline() {
    const buffer = await ctx.startRendering();
    const n = buffer.length, data = new DataView(new ArrayBuffer(44 + n * 4));
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
    const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
    for (let i = 0; i < n; i++) {
      data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
      data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
    }
    return data.buffer;
  }

  function setEnabled(value) {
    on = value;
    if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, clock(), 0.05);
  }

  function setPaused(value) {
    paused = value;
    if (!ctx || offline) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  }

  start();

  return {
    setLogger: (fn) => (logger = fn),
    play,
    ratchet,
    air,
    silenceAir,
    swish,
    bell,
    setEnabled,
    setPaused,
    beginOffline,
    renderOffline,
    downloaded,
    get enabled() {
      return on;
    },
    get running() {
      return ctx?.state === "running";
    },
  };
}
