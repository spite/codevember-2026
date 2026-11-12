// The machine's sound: one-shots cut from CC0 recordings (freesound.org, see README), played with a random variant,
// pitch and pan. The AudioContext is created on load: it runs at once if the browser allows it, otherwise it resumes
// on the first gesture. Variation uses nativeRandom, so the seeded layout never shifts.
import { nativeRandom } from "modules/random.js";

const SETS = { tick: 5, cog: 5, ratchet: 4, clink: 4, clack: 2, latch: 3, clank: 6, chain: 4, creak: 2, lever: 1 };
// Closest two plays of the same set may start, in seconds.
const SPACING = { tick: 0.04, cog: 0.06, ratchet: 0.025, clink: 0.03, clack: 0.04, latch: 0.05, clank: 0.07, chain: 0.12, creak: 0.5, lever: 0.1 };
const MAX_VOICES = 24;

export function createSound({ base = new URL("./sounds/", import.meta.url).href, onProgress } = {}) {
  let ctx = null, master = null, on = true, paused = false;
  const buffers = {}, lastAt = {}, last = {};
  let voices = [];

  const files = Object.entries(SETS).flatMap(([name, n]) => Array.from({ length: n }, (_, i) => ({ name, i })));
  let fetched = 0;
  for (const f of files) {
    f.data = fetch(`${base}${f.name}-${f.i}.mp3`)
      .then((r) => r.arrayBuffer())
      .finally(() => onProgress?.(++fetched / files.length));
    f.data.catch(() => {});
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
    await downloaded;
    for (const f of files) {
      try {
        const buf = await ctx.decodeAudioData((await f.data).slice(0));
        (buffers[f.name] ??= []).push(buf);
      } catch {}
    }
  }
  start();
  const resume = () => {
    if (ctx && ctx.state === "suspended" && !paused) ctx.resume();
  };
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(e, resume, { capture: true });

  // A variant of the set, never the same one twice in a row.
  function pick(name) {
    const list = buffers[name];
    if (!list?.length) return null;
    let i = Math.floor(nativeRandom() * list.length);
    if (list.length > 1 && i === last[name]) i = (i + 1) % list.length;
    last[name] = i;
    return list[i];
  }

  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1, lowpass = 0 } = {}) {
    if (!ctx || ctx.state !== "running" || !on || gain < 0.01) return;
    const at = ctx.currentTime + Math.max(0, delay);
    if (at - (lastAt[name] ?? -1) < SPACING[name]) return;
    voices = voices.filter((v) => v > ctx.currentTime);
    if (voices.length >= MAX_VOICES) return;
    const buf = pick(name);
    if (!buf) return;
    lastAt[name] = at;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (0.94 + 0.12 * nativeRandom());
    const g = ctx.createGain();
    g.gain.value = gain * (0.85 + 0.3 * nativeRandom());
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    let node = src.connect(g);
    // Rust dulls the sound: the crust damps the ring of the metal.
    if (lowpass > 0) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    node.connect(p).connect(master);
    src.start(at);
    voices.push(at + buf.duration / src.playbackRate.value);
  }

  // A looping sound whose level and pitch follow the caller (set(gain, rate) every frame).
  function loop(name) {
    let src = null, g = null;
    return {
      set(gain, rate = 1) {
        if (!ctx || ctx.state !== "running") return;
        if (!src) {
          const buf = pick(name);
          if (!buf) return;
          src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          g = ctx.createGain();
          g.gain.value = 0;
          src.connect(g).connect(master);
          src.start();
        }
        g.gain.setTargetAtTime(on ? gain : 0, ctx.currentTime, 0.08);
        src.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.1);
      },
    };
  }

  return {
    play,
    loop,
    get running() {
      return !!ctx && ctx.state === "running";
    },
    get enabled() {
      return on;
    },
    setEnabled(v) {
      on = v;
      if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.05);
    },
    setPaused(v) {
      paused = v;
      if (!ctx) return;
      if (v) ctx.suspend();
      else ctx.resume();
    },
  };
}
