// Paper foley: one-shot samples (CC0, freesound.org) played with random variant, pitch and pan.
// The AudioContext starts on the first user gesture; nothing plays before that.

import { nativeRandom } from "modules/random.js";

const SETS = { crease: 6, crumple: 3, rustle: 6, tap: 8 };
const MAX_VOICES = 10;

export function createPaperSound({ base = "./sounds/", enabled = true } = {}) {
  let ctx = null;
  let master = null;
  let on = enabled;
  let voices = 0;
  let paused = false;
  const buffers = {};
  const last = {};

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
      Object.entries(SETS).flatMap(([name, n]) =>
        Array.from({ length: n }, async (_, i) => {
          try {
            const data = await (await fetch(`${base}${name}-${i}.mp3`)).arrayBuffer();
            (buffers[name] ??= [])[i] = await ctx.decodeAudioData(data);
          } catch (e) {
            console.warn("paper sound", name, i, e);
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

  // gain 0..1, pan -1..1, delay in seconds; never repeats the previous variant of a set.
  function play(name, { gain = 1, pan = 0, delay = 0, rate = 1 } = {}) {
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

  return { play, setEnabled, setPaused, get enabled() { return on; } };
}
