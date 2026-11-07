// Mechanical foley: one-shots cut from CC0 recordings (freesound.org, see README), played with a random
// variant, pitch and pan. The AudioContext starts on the first user gesture; nothing plays before that.
import { nativeRandom } from "modules/random.js";

// Watch, gear, winding and latch sounds, stones sliding, freewheels and clinks for the plates, plus heavier clockwork (tower-clock cogs, a press, levers, a crank, bolts,
// shifts) for the transformations and a ka-ching for the moment the last plate locks.
const SETS = { tick: 5, click: 4, ratchet: 7, slide: 5, pop: 4, whirr: 2, latch: 3, wind: 8, bolt: 6, shift: 9, kaching: 2, cog: 5, press: 4, lever: 4, crank: 3, spin: 4, clink: 4, clack: 2 };
// The escapement's beat plays the watch ticks under its own name, so it never crowds out a dial's tick.
const ALIAS = { beat: "tick" };
const MAX_VOICES = 28;
// Closest two plays of the same set may start, in seconds: a busy tick becomes a patter, not a pile-up.
const SPACING = { tick: 0.012, click: 0.02, ratchet: 0.008, slide: 0.012, pop: 0.05, whirr: 0.1, latch: 0.04, wind: 0.25, bolt: 0.035, cog: 0.03, press: 0.05, lever: 0.04, crank: 0.3, shift: 0.025, kaching: 0.5, beat: 0.05, spin: 0.05, clink: 0.03, clack: 0.008 };

// ?soundlog prints every sound in the console as it starts, or why it was skipped; ?soundlog=all adds the
// escapement and each ratchet click, and ?soundlog=slide,clink logs just those.
const SOUND_LOG = new URLSearchParams(location.search).get("soundlog");
const LOG_ONLY = SOUND_LOG && SOUND_LOG !== "all" ? new Set(SOUND_LOG.split(",")) : null;
const WHAT = {
  slide: "bead slides", click: "bead lands, or dial step", tick: "dial steps a notch", beat: "escapement", ratchet: "ratchet",
  pop: "part pops out", whirr: "part turns", latch: "part latches", spin: "plate turns", clink: "plate seats", clack: "turntable locks",
  wind: "winding", cog: "cogs", crank: "transformation crank", press: "transformation press", lever: "transformation lever",
  bolt: "transformation bolt", shift: "transformation shift", kaching: "ka-ching",
};
function report(name, delay, gain, status, all = false) {
  if (SOUND_LOG === null) return;
  if (LOG_ONLY ? !LOG_ONLY.has(name) : all && SOUND_LOG !== "all") return;
  setTimeout(() => console.log(`sound: ${name} (${WHAT[name] ?? name}), gain ${gain.toFixed(2)}: ${status}`), Math.max(delay, 0) * 1000);
}

export function createMachineSound({ base = "./sounds/", enabled = true } = {}) {
  let ctx = null;
  let master = null;
  let on = enabled;
  let paused = false;
  // When each scheduled sound starts and ends, so the voice cap counts what will actually be playing at a time.
  let voices = [];
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

  // gain 0..1, pan -1..1, delay and duration in seconds (duration cuts it short with a fade). With an envelope (values
  // 0..1 spread over the duration), the sample loops for exactly that long at a steady pitch and its gain follows the
  // envelope.
  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1, duration = 0, envelope = null, quiet = false } = {}) {
    const set = ALIAS[name] ?? name;
    const all = quiet || name === "beat";
    if (!on || paused) return;
    if (gain <= 0.001 || !SETS[set]) return report(name, delay, gain, "skipped, silent", all);
    // The audio clock only while it runs: a suspended context's clock stands still, and every sound would look like
    // it starts at the same moment as the last one of its kind.
    const live = ctx && ctx.state === "running" && !logger;
    const now = (live ? ctx.currentTime : performance.now() / 1000) + Math.max(delay, 0);
    if (Math.abs(now - (lastAt[name] ?? -Infinity)) < SPACING[name]) return report(name, delay, gain, "skipped, too soon after the last one", all);
    lastAt[name] = now;
    const variedRate = envelope ? rate : rate * (0.92 + nativeRandom() * 0.16);
    if (logger) {
      logger({ name, variant: pick(name, SETS[set]), gain: Math.min(1, gain), pan, rate: variedRate, delay: Math.max(delay, 0), duration });
      return;
    }
    if (!ctx || ctx.state !== "running") return report(name, delay, gain, "skipped, audio not started", all);
    const list = buffers[set]?.filter(Boolean);
    if (!list?.length) return report(name, delay, gain, "skipped, samples not loaded", all);
    const buffer = list[pick(name, list.length)];
    const shaped = envelope && duration > 0;
    const end = now + (shaped ? duration : duration > 0 ? Math.min(duration + 0.2, buffer.duration / variedRate) : buffer.duration / variedRate);
    voices = voices.filter((v) => v.end > ctx.currentTime);
    if (voices.filter((v) => v.start <= now && v.end > now).length >= MAX_VOICES) return report(name, delay, gain, `skipped, all ${MAX_VOICES} voices busy`, all);
    voices.push({ start: now, end });
    report(name, delay, gain, "plays", all);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = variedRate;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    if (shaped) {
      src.loop = true;
      src.loopStart = Math.min(0.08, buffer.duration / 4);
      src.loopEnd = Math.max(buffer.duration - 0.08, (buffer.duration * 3) / 4);
      const g0 = Math.min(1, gain);
      g.gain.setValueCurveAtTime(Float32Array.from(envelope, (e) => Math.max(e * g0, 1e-4)), now, duration);
      src.start(now);
      src.stop(now + duration);
      return;
    }
    g.gain.setValueAtTime(Math.min(1, gain), now);
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
    report("ratchet", delay, gain, `${n} clicks over ${duration.toFixed(2)} s`);
    for (let k = 0; k < n; k++) {
      // Clockwork easing: clicks bunch up in the middle of the turn, where it moves fastest.
      const u = (k + 0.5) / n;
      const t = 0.5 - Math.cos(u * Math.PI) / 2;
      play("ratchet", { gain: gain * (0.75 + 0.25 * Math.sin(u * Math.PI)), pan, delay: delay + t * duration, rate, quiet: true });
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
      play("beat", { gain: gain * (tac ? 0.85 : 1), delay: nextBeat - now, rate: tac ? 0.92 : 1.05 });
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
