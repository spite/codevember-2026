// Recorded sounds (freesound.org, CC0; see the README): cloth rustling as the wound body moves, a heartbeat for each
// shove from inside the cocoon, cloth ripping as it breaks, and paper fluttering as the chips fly and fall.
import { nativeRandom } from "modules/random.js";

const RUSTLES = 22;
const url = (name) => new URL(`./sounds/${name}.mp3`, import.meta.url).href;

export function createSound({ onProgress } = {}) {
  let ctx = new (window.AudioContext || window.webkitAudioContext)();
  // The samples are levelled to one loudness (rustles at -23 dB RMS, the rip a little louder); the gains below are
  // the mix, and a gentle compressor holds overlapping ones together.
  let master = ctx.createGain();
  master.gain.value = 0;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 12;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.25;
  master.connect(glue).connect(ctx.destination);

  let muted = false;
  let paused = false;
  let rustlesEnd = []; // when the rustles sounding now end
  let lastRustle = -1;
  // For a recording: every later sound goes to an offline context, timed by the page's clock from beginOffline.
  let offline = null;
  const clock = () => (offline ? (performance.now() - offline.t0) / 1000 : ctx.currentTime);

  const names = [...Array.from({ length: RUSTLES }, (_, i) => `rustle-${i}`), "rip", "flutter", "fall", "heartbeat"];
  const buffers = {};
  let done = 0;
  const loaded = Promise.all(
    // A sample that fails is left out (its sound stays silent) rather than holding up the load.
    names.map(async (name) => {
      try {
        const data = await (await fetch(url(name))).arrayBuffer();
        buffers[name] = await ctx.decodeAudioData(data);
      } catch (e) {
        console.warn("sound", name, e);
      }
      onProgress?.(++done / names.length);
    }),
  );

  const resume = () => {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, resume, { capture: true });

  const ready = () => !!offline || (!muted && !paused && ctx.state === "running");

  // One sample through a low-pass, at a gain and rate, cut short with a fade after duration seconds if given.
  function play(name, { gain = 1, rate = 1, lowpass = 20000, offset = 0, duration = 0 } = {}) {
    const buffer = buffers[name];
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    filter.Q.value = 0.5;
    const level = ctx.createGain();
    level.gain.value = gain;
    src.connect(filter).connect(level).connect(master);
    const now = clock();
    src.start(now, offset);
    if (duration) {
      level.gain.setValueAtTime(gain, now + duration * 0.7);
      level.gain.linearRampToValueAtTime(0, now + duration);
      src.stop(now + duration + 0.02);
    }
    return src;
  }

  // strength 0..1: louder, a little brighter and quicker the harder the move. At most three at once.
  function rustle(strength = 0.5) {
    const now = clock();
    rustlesEnd = rustlesEnd.filter((end) => end > now);
    if (!ready() || rustlesEnd.length >= 3) return;
    if (now - lastRustle < 0.08) return;
    lastRustle = now;
    const s = Math.min(1, strength);
    const src = play(`rustle-${Math.floor(nativeRandom() * RUSTLES)}`, {
      gain: (0.15 + 0.35 * s) * (0.85 + 0.15 * nativeRandom()),
      rate: 0.85 + 0.2 * s + 0.1 * nativeRandom(),
      lowpass: 2500 + 3500 * s,
    });
    if (src) rustlesEnd.push(now + src.buffer.duration / src.playbackRate.value);
  }

  // A shove from inside: a heartbeat, muffled by the shell, harder with each shove.
  function push(strength = 0.5) {
    if (!ready()) return;
    play("heartbeat", { gain: 0.4 + 0.7 * strength, rate: 0.92 + 0.08 * strength, lowpass: 900 + 900 * strength });
  }

  function tear(strength = 1) {
    if (!ready()) return;
    // Slowed and darkened to sit with the cloth: a heavier fabric giving way, not paper.
    play("rip", { gain: 0.45 + 0.75 * strength, rate: 0.55 + 0.15 * nativeRandom(), lowpass: 1800 + 1200 * strength, offset: nativeRandom() * 0.6, duration: 0.5 + 0.4 * strength });
  }

  function flutter() {
    if (!ready()) return;
    play("flutter", { gain: 0.6, rate: 0.9 + 0.15 * nativeRandom(), lowpass: 6000 });
  }

  function fall() {
    if (!ready()) return;
    play("fall", { gain: 0.45, rate: 0.85 + 0.15 * nativeRandom(), lowpass: 5000 });
  }

  function update() {
    if (offline) return;
    master.gain.setTargetAtTime(muted || paused ? 0 : 0.9, ctx.currentTime, 0.08);
  }

  function setPaused(p) {
    paused = p;
    if (offline) return;
    if (p) master.gain.setValueAtTime(0, ctx.currentTime);
  }

  function setMuted(m) {
    muted = m;
  }

  // Switches every later sound to an offline context of `seconds`, its time 0 now.
  function beginOffline(seconds) {
    if (offline) return;
    const o = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    const comp = o.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    master = o.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(o.destination);
    ctx = o;
    offline = { t0: performance.now() };
    rustlesEnd = [];
    lastRustle = -1;
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
    const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
    for (let i = 0; i < n; i++) {
      data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
      data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
    }
    return data.buffer;
  }

  return {
    loaded,
    beginOffline,
    renderOffline,
    rustle,
    push,
    tear,
    flutter,
    fall,
    update,
    setPaused,
    setMuted,
    get muted() {
      return muted;
    },
    get running() {
      return ctx.state === "running";
    },
  };
}
