// Mechanical foley: one-shots cut from CC0 recordings (freesound.org, see README), played with a random
// variant, pitch and pan. The AudioContext starts on the first user gesture; nothing plays before that.
import { nativeRandom } from "modules/random.js";

// Watch, gear, winding and latch sounds, plus heavier clockwork (tower-clock cogs, a press, levers, a crank, bolts,
// shifts) for the transformations and a ka-ching for the moment the last plate locks.
const SETS = { tick: 5, click: 4, ratchet: 7, slide: 2, pop: 4, whirr: 2, latch: 3, wind: 8, bolt: 6, shift: 9, kaching: 2, cog: 5, press: 4, lever: 4, crank: 3 };
// The escapement's beat plays the watch ticks under its own name, so it never crowds out a dial's tick.
const ALIAS = { beat: "tick" };
const MAX_VOICES = 28;
// Closest two plays of the same set may start, in seconds: a busy tick becomes a patter, not a pile-up.
const SPACING = { tick: 0.012, click: 0.02, ratchet: 0.008, slide: 0.03, pop: 0.05, whirr: 0.1, latch: 0.04, wind: 0.25, bolt: 0.035, cog: 0.03, press: 0.05, lever: 0.04, crank: 0.3, shift: 0.025, kaching: 0.5, beat: 0.05 };

export function createMachineSound({ base = "./sounds/", enabled = true } = {}) {
  let ctx = null;
  let master = null;
  let on = enabled;
  let paused = false;
  let voices = 0;
  let logger = null;
  const buffers = {};
  const last = {};
  const lastAt = {};

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
      Object.entries(SETS).flatMap(([name, n]) =>
        Array.from({ length: n }, async (_, i) => {
          try {
            const data = await (await fetch(`${base}${name}-${i}.mp3`)).arrayBuffer();
            (buffers[name] ??= [])[i] = await ctx.decodeAudioData(data);
          } catch (e) {
            console.warn("machine sound", name, i, e);
          }
        }),
      ),
    );
  }

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

  // gain 0..1, pan -1..1, delay and duration in seconds (duration cuts it short with a fade).
  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1, duration = 0 } = {}) {
    const set = ALIAS[name] ?? name;
    if (!on || paused || gain <= 0.001 || !SETS[set]) return;
    const now = (ctx ? ctx.currentTime : performance.now() / 1000) + Math.max(delay, 0);
    if (Math.abs(now - (lastAt[name] ?? -Infinity)) < SPACING[name]) return;
    lastAt[name] = now;
    const variedRate = rate * (0.92 + nativeRandom() * 0.16);
    if (logger) {
      logger({ name, variant: pick(name, SETS[set]), gain: Math.min(1, gain), pan, rate: variedRate, delay: Math.max(delay, 0), duration });
      return;
    }
    if (!ctx || ctx.state !== "running" || voices >= MAX_VOICES) return;
    const list = buffers[set]?.filter(Boolean);
    if (!list?.length) return;
    const src = ctx.createBufferSource();
    src.buffer = list[pick(name, list.length)];
    src.playbackRate.value = variedRate;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    g.gain.setValueAtTime(Math.min(1, gain), now);
    voices++;
    src.onended = () => voices--;
    // A source has to be started before its stop can be scheduled.
    src.start(now);
    if (duration > 0) {
      g.gain.setTargetAtTime(0, now + Math.max(duration - 0.12, 0.02), 0.04);
      src.stop(now + duration + 0.2);
    }
  }

  // A run of ratchet clicks spread over a turn: one per tooth.
  function ratchet({ teeth, duration, gain = 1, pan = 0, delay = 0, rate = 1 }) {
    const n = Math.max(1, Math.min(teeth, 24));
    for (let k = 0; k < n; k++) {
      // Clockwork easing: clicks bunch up in the middle of the turn, where it moves fastest.
      const u = (k + 0.5) / n;
      const t = 0.5 - Math.cos(u * Math.PI) / 2;
      play("ratchet", { gain: gain * (0.75 + 0.25 * Math.sin(u * Math.PI)), pan, delay: delay + t * duration, rate });
    }
  }

  // The escapement: tic-tac at `rate` beats a second, scheduled a little ahead each frame.
  let nextBeat = 0, beatIndex = 0;
  function escapement(rate, gain) {
    const live = ctx && ctx.state === "running";
    if (!on || paused || rate <= 0 || (!live && !logger)) return (nextBeat = 0);
    const now = live ? ctx.currentTime : performance.now() / 1000;
    if (nextBeat < now) nextBeat = now + 0.05;
    while (nextBeat < now + 0.15) {
      const tac = beatIndex++ % 2 === 1;
      play("beat", { gain: gain * (tac ? 0.8 : 1), delay: nextBeat - now, rate: tac ? 0.8 : 1.05 });
      nextBeat += 1 / rate;
    }
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

  return { play, ratchet, escapement, setEnabled, setPaused, setLogger, get enabled() { return on; }, sets: SETS };
}
