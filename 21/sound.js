// Recorded sounds (freesound.org, CC0; see the README): a Tesla coil's hum while the charge gathers, a close lightning
// crack with a rolling tail, a zap for each restrike, ice crackling as the discharge runs through the glass, and a few
// ticks as it cools. The AudioContext is created on load and resumes on the first gesture if the browser holds it.
import { nativeRandom } from "modules/random.js";

const NAMES = ["charge", "crack-0", "crack-1", "rumble", "zap", "crackle", "tick"];
const url = (name) => new URL(`./sounds/${name}.mp3`, import.meta.url).href;

function createSound({ onProgress } = {}) {
  const live = new (window.AudioContext || window.webkitAudioContext)();
  let ctx = live;
  let master = ctx.createGain();
  // For a recording: every later sound goes to an offline context, timed by the page's clock from beginOffline.
  let offline = null;
  const now = () => (offline ? (performance.now() - offline.t0) / 1000 : ctx.currentTime);
  // The samples are levelled (the long ones to -16 LUFS, the short ones to their peak); a compressor holds the crack.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.3;
  master.connect(comp).connect(ctx.destination);
  const resume = () => live.state === "suspended" && live.resume().catch(() => {});
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(e, resume, { capture: true });

  const buffers = {};
  let done = 0;
  const loaded = Promise.all(
    NAMES.map(async (name) => {
      const data = await (await fetch(url(name))).arrayBuffer();
      buffers[name] = await live.decodeAudioData(data);
      onProgress?.(++done / NAMES.length);
    }),
  );

  let enabled = true;
  let leaderNodes = null;

  // One sample at a time `at` (context seconds), through a low-pass, at a gain and rate.
  function play(name, { at = now(), gain = 1, rate = 1, lowpass = 20000, highpass = 0, loop = false, offset = 0 } = {}) {
    const buffer = buffers[name];
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.loop = loop;
    if (loop) (src.loopStart = 0.1), (src.loopEnd = buffer.duration - 0.15);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpass;
    let node = src.connect(lp);
    if (highpass) {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = highpass;
      node = node.connect(hp);
    }
    const level = ctx.createGain();
    level.gain.value = gain;
    node.connect(level).connect(master);
    src.start(at, offset);
    return { src, level, lp };
  }

  // The charge gathering: a Tesla coil's hum that swells and rises until stopLeader().
  function leader() {
    stopLeader();
    const t = now();
    const hum = play("charge", { loop: true, gain: 0, rate: 0.85, lowpass: 2500, offset: nativeRandom() * 4 });
    if (!hum) return;
    hum.level.gain.setTargetAtTime(0.5, t, 0.08);
    hum.src.playbackRate.setTargetAtTime(1.15, t, 0.6);
    hum.lp.frequency.setTargetAtTime(9000, t, 0.4);
    // Sparks at the impact: snaps, quicker and louder as the charge gathers, until the stroke cuts them off.
    const sparks = [];
    for (let at = 0.05; at < 4; at += 0.05 + nativeRandom() * Math.max(0.05, 0.3 - at * 0.15)) {
      const grown = Math.min(1, at / 1.1);
      const spark = play("zap", { at: t + at, gain: (0.06 + 0.3 * grown) * (0.4 + nativeRandom() * 0.6), rate: 1.3 + nativeRandom() * 1.2, highpass: 1500 + nativeRandom() * 2000 });
      if (spark) sparks.push(spark.src);
    }
    leaderNodes = { ...hum, sparks };
  }
  function stopLeader() {
    if (!leaderNodes) return;
    const t = now();
    leaderNodes.level.gain.cancelScheduledValues(t);
    leaderNodes.level.gain.setTargetAtTime(0, t, 0.015);
    leaderNodes.src.stop(t + 0.15);
    for (const spark of leaderNodes.sparks) spark.stop(t);
    leaderNodes = null;
  }

  // strokes: the bolt's return strokes, [{ at, level }], seconds after the first. reveal: how long the discharge
  // takes to run through the glass.
  function strike(strokes = [{ at: 0, level: 1 }], reveal = 1) {
    stopLeader();
    const t = now();
    // The crack, close: one of two recordings, a little different each time.
    play(nativeRandom() < 0.6 ? "crack-0" : "crack-1", { at: t, gain: 1.1, rate: 0.94 + nativeRandom() * 0.12 });
    // Further off, the roll it starts.
    play("rumble", { at: t + 0.35, gain: 0.45, rate: 0.9 + nativeRandom() * 0.15, lowpass: 900 });
    // A snap for each restrike, down the same channel.
    for (const { at, level } of strokes.slice(1)) play("zap", { at: t + at, gain: level * 0.7, rate: 0.8 + nativeRandom() * 0.4, highpass: 400 });
    // The glass taking the discharge: crackling while the front runs, fading as it slows.
    const crackle = play("crackle", { at: t + 0.03, gain: 0.9, rate: 1.1 + nativeRandom() * 0.2, offset: nativeRandom() * 3, highpass: 1500 });
    if (crackle) {
      crackle.level.gain.setValueAtTime(0.9, t + 0.03);
      crackle.level.gain.setTargetAtTime(0, t + reveal * 0.6, reveal * 0.5);
      crackle.src.stop(t + reveal * 3 + 0.5);
    }
    // And a few ticks as it cools.
    for (let k = 0, at = reveal + 0.3; k < 4; k++, at += 0.4 + nativeRandom() * 1.4) {
      play("tick", { at: t + at, gain: 0.25 + nativeRandom() * 0.3, rate: 1.2 + nativeRandom() * 0.9, highpass: 1200 });
    }
  }

  // Switches every later sound to an offline context of `seconds`, its time 0 now.
  function beginOffline(seconds) {
    if (offline) return;
    stopLeader();
    const o = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    const glue = o.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.knee.value = 8;
    glue.ratio.value = 4;
    glue.attack.value = 0.002;
    glue.release.value = 0.3;
    master = o.createGain();
    master.connect(glue).connect(o.destination);
    ctx = o;
    offline = { t0: performance.now() };
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
    leader,
    stopLeader,
    strike,
    get running() {
      return live.state === "running";
    },
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = v;
      if (!offline) master.gain.setTargetAtTime(v ? 1 : 0, now(), 0.03);
    },
  };
}

export { createSound };
