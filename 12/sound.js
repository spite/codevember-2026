// The plumage's sound, synthesized (no samples). A feather ruffle is a dense crackle of tiny contacts, barbs and vanes
// brushing past each other, bunched on the rhythm of the shake (the "frrrrt" of a bird rousing): each rouse is built
// that way, sample by sample, and plays once; the pointer brushing the plumage gives shorter, looser bursts on no fixed
// rhythm. Breathing is a faint, slow draw of air. The AudioContext is created on load: it runs at once if the browser
// allows it, otherwise it resumes on the first gesture. Variation uses nativeRandom, so the seeded layout never
// shifts.
import { nativeRandom } from "modules/random.js";

// A burst of feather contacts, duration long: flutter (Hz, 0 for none) bunches them on a rhythm; density is contacts
// per second at the peak; the envelope rises over attack and fades over the last release.
// decay: the flutter's bursts fade (per second), like a shake dying down.
// gaps: bursts tight on the flutter with silence between (a dry "brrrt" rather than a hiss).
// smooth: 0..1, how rounded each contact is (higher: softer, less crunchy).
function rustle(sampleRate, { duration, flutter = 0, density = 1200, attack = 0.04, release = 0.3, brightness = 1, body = 0.6, decay = 0, gaps = false, smooth = 0.5 }) {
  const n = Math.ceil(duration * sampleRate);
  const out = new Float32Array(n);
  const rnd = nativeRandom;
  // Contacts: each a few hundred microseconds to a couple of milliseconds of decaying noise.
  const count = Math.round(density * duration);
  const fl = flutter * (0.9 + 0.2 * rnd());
  for (let c = 0; c < count; c++) {
    let t = rnd() * duration;
    // On the flutter, contacts gather round each cycle's peak (where the vanes meet).
    if (fl > 0) {
      const cycle = Math.floor(t * fl);
      // Tight: each burst a small fraction of its cycle, with silence between (the vanes knock, then part).
      const spread = gaps ? 0.05 + 0.04 * rnd() : 0.18 + 0.12 * rnd();
      t = (cycle + 0.5 + (rnd() - 0.5) * spread * 2) / fl;
      if (t < 0 || t >= duration) continue;
    }
    const env = Math.min(1, t / attack) * Math.min(1, (duration - t) / release) * Math.exp(-decay * t);
    if (env <= 0) continue;
    // Contacts of varying loudness (log-normal, narrow), so it crackles softly, without sharp outliers.
    const a = env * Math.exp(0.55 * (rnd() + rnd() + rnd() - 1.5)) * 0.08;
    const len = Math.floor(sampleRate * (0.0005 + 0.004 * rnd()));
    const i0 = Math.floor(t * sampleRate);
    const fall = Math.exp(-5 / Math.max(len, 1));
    let k = a;
    let v = 0;
    const smoothn = smooth, gainS = 1 / Math.sqrt((1 - smooth) / (1 + smooth)) * 0.6;
    for (let i = 0; i < len && i0 + i < n; i++) {
      v = smooth * v + (1 - smoothn) * (rnd() * 2 - 1);
      out[i0 + i] += k * v * gainS;
      k *= fall;
    }
  }
  // The vanes moving air: a soft, low swell of noise on each flutter cycle (or on the envelope), under the crackle.
  let lowState = 0;
  const lowK = Math.exp((-2 * Math.PI * 500) / sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / attack) * Math.min(1, (duration - t) / release);
    const pulse = fl > 0 ? 0.5 + 0.5 * Math.cos(2 * Math.PI * (t * fl - 0.5)) : 1;
    lowState = lowK * lowState + (1 - lowK) * (rnd() * 2 - 1);
    out[i] += lowState * env * pulse * pulse * body;
  }
  // Off the rumble and the hiss (high-pass ~250 Hz, low-pass ~2-3.5 kHz with brightness, so it's soft, not scratchy).
  const hp = Math.exp((-2 * Math.PI * (gaps ? 700 : 250)) / sampleRate);
  const lp = Math.exp((-2 * Math.PI * (1400 + 1800 * brightness)) / sampleRate);
  let x1 = 0, y1 = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const x = out[i];
    const y = hp * (y1 + x - x1);
    x1 = x;
    y1 = y;
    z = (1 - lp) * y + lp * z;
    out[i] = z;
  }
  return out;
}

export function createSound() {
  let ctx = null, master = null, room = null, breathGain = null, breathFilter = null, windGain = null, windFilter = null, windPanNode = null;
  let chirpAt = 2 + 6 * nativeRandom();
  let on = true, paused = false;
  let lastRouse = 0, brushDue = 0, swiping = false;
  // Bursts played (for tests: sound is checked in code, never by listening).
  let played = 0;

  // offline: a recording's own clock (seconds), when the sound is rendered offline for it (see startOffline).
  let offline = null;
  const clock = () => (offline ? offline.t : ctx.currentTime);
  function start(context = new AudioContext()) {
    ctx = context;
    if (paused) ctx.suspend();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master = ctx.createGain();
    master.gain.value = on ? 1 : 0;
    master.connect(comp).connect(ctx.destination);
    // A soft room around it (a generated decaying stereo tail), so it sounds big rather than close and dry.
    const tail = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.4), ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = tail.getChannelData(c);
      let y = 0;
      for (let i = 0; i < d.length; i++) {
        y = 0.6 * y + 0.4 * (Math.random() * 2 - 1);
        d[i] = y * Math.exp((-4 * i) / d.length) * (i < 400 ? i / 400 : 1);
      }
    }
    room = ctx.createConvolver();
    room.buffer = tail;
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.35;
    room.connect(roomGain).connect(master);
    // Breath: faint looped noise, low and soft.
    const n = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < n; i++) d[i] = b = 0.97 * b + 0.03 * (Math.random() * 2 - 1) * 4;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    breathFilter = ctx.createBiquadFilter();
    breathFilter.type = "bandpass";
    breathFilter.frequency.value = 450;
    breathFilter.Q.value = 0.7;
    breathGain = ctx.createGain();
    breathGain.gain.value = 0;
    src.connect(breathFilter).connect(breathGain).connect(master);
    src.start();
    // Wind: the same noise, slower, through a band that drifts, swelling with each gust.
    const wind = ctx.createBufferSource();
    wind.buffer = buf;
    wind.loop = true;
    wind.playbackRate.value = 0.5;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 500;
    windFilter.Q.value = 0.8;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    const windPan = ctx.createStereoPanner();
    windPanNode = windPan;
    wind.connect(windFilter).connect(windGain).connect(windPan).connect(master);
    windGain.connect(room);
    wind.start(0, 1.1);
  }
  start();
  const resume = () => {
    if (ctx && !offline && ctx.state === "suspended" && !paused) ctx.resume();
  };
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(e, resume, { capture: true });

  // A bird's call from somewhere around: 1-5 short whistled chirps, each a quick glide in pitch, distant and soft.
  function chirps(now) {
    const n = 1 + Math.floor(nativeRandom() * 5);
    const base = 2600 + 2200 * nativeRandom();
    const shape = nativeRandom();
    const pan = (nativeRandom() - 0.5) * 1.6;
    const level = 0.025 + 0.04 * nativeRandom();
    let t = now + 0.02;
    for (let i = 0; i < n; i++) {
      const dur = 0.04 + 0.08 * nativeRandom();
      const f0 = base * (0.9 + 0.2 * nativeRandom());
      const f1 = f0 * (shape < 0.5 ? 1.35 + 0.3 * nativeRandom() : 0.65 + 0.15 * nativeRandom());
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      // A little warble.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 30 + 40 * nativeRandom();
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = f0 * 0.03;
      lfo.connect(lfoGain).connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.008);
      g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      osc.connect(g).connect(p).connect(master);
      g.connect(room);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + dur + 0.02);
      lfo.stop(t + dur + 0.02);
      t += dur + 0.03 + 0.09 * nativeRandom();
    }
    played++;
  }

  // Two independent bursts, one per side, so it's wide; panned toward pan.
  function play(make, gain, pan, delay = 0) {
    const l = make(), r = make();
    const b = ctx.createBuffer(2, Math.max(l.length, r.length), ctx.sampleRate);
    b.copyToChannel(l, 0);
    b.copyToChannel(r, 1);
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(master);
    g.connect(room);
    src.start(clock() + delay);
    played++;
  }

  // Each frame: breath (girth scale around 1), rouse (0..1, the shake now), stir (0..1, the pointer brushing the
  // plumage), pan (-1..1, where the pointer is), and lap (seconds the rouse takes to run round).
  function update(dt, { breath, rouse, stir, pan, lap = 1, shakeHz = 7, rouseCount = 0, swipe = 0, swipePan = 0, gust = 0, gustPan = 0 }) {
    if (!ctx || !on) return;
    if (offline) offline.t += dt;
    const live = !!offline || ctx.state === "running";
    if (live) {
      const now = clock();
      windGain.gain.setTargetAtTime(0.015 + 0.35 * gust * gust, now, 0.25);
      windFilter.frequency.setTargetAtTime(350 + 700 * gust + 150 * Math.sin(now * 0.7), now, 0.4);
      windPanNode.pan.setTargetAtTime(gustPan, now, 0.5);
      // Now and then a bird somewhere: a few quick chirps.
      chirpAt -= dt;
      if (chirpAt <= 0) {
        chirps(now);
        chirpAt = nativeRandom() < 0.3 ? 0.6 + 1.2 * nativeRandom() : 4 + 14 * nativeRandom();
      }
    }
    if (live) {
      const inhale = Math.max(0, (breath - 1) / 0.024);
      breathGain.gain.setTargetAtTime(0.02 + 0.07 * inhale, clock(), 0.15);
    }
    // A rouse starting: the dry "brrrrt" of a bird shaking out: tight bursts of vanes knocking together, 22-30 a
    // second with silence between, fading as the shake dies down. No air layer under it (that reads as wind).
    // Each new rouse (even one starting before the last has settled) plays its own shake.
    if (rouseCount !== lastRouse && live) {
      const duration = Math.min(1.4, Math.max(0.6, lap - 0.2));
      const shake = () => rustle(ctx.sampleRate, { duration, flutter: 22 + 8 * nativeRandom(), density: 3500, attack: 0.03, release: 0.5 * duration, brightness: 0.1 + 0.2 * nativeRandom(), body: 0, decay: 2.5, gaps: true, smooth: 0.8 });
      play(shake, 1.2 * rouse, (nativeRandom() - 0.5) * 0.3, 0.2);
    }
    lastRouse = rouseCount;
    // A swipe: a quick brush along the plumage, as long as it runs.
    if (swipe && !swiping && live) {
      const duration = 0.5 + 0.3 * nativeRandom();
      play(() => rustle(ctx.sampleRate, { duration, density: 4500, attack: duration * 0.3, release: duration * 0.5, brightness: 0.1, body: 0.4, smooth: 0.85 }), 0.9, swipePan);
    }
    swiping = !!swipe;
    // The pointer brushing: short, loose bursts, more and louder the more it stirs.
    if (stir > 0.05 && live) {
      brushDue += dt * (2 + 10 * stir);
      while (brushDue >= 1) {
        brushDue--;
        const duration = 0.15 + 0.25 * nativeRandom();
        play(() => rustle(ctx.sampleRate, { duration, density: 1200 + 1500 * stir, attack: duration * 0.4, release: duration * 0.6, brightness: 0, body: 0.3, smooth: 0.9 }), 0.4 + 0.6 * Math.min(1, stir), pan);
      }
    } else brushDue = 0;
  }

  // For recordings: from now on everything is rendered into an offline buffer, seconds long, on the update clock
  // (the recording's virtual time); render() then returns it as a 16-bit stereo WAV.
  function startOffline(seconds, sampleRate = 48000) {
    ctx?.close?.();
    start(new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate));
    offline = { t: 0 };
  }
  async function render() {
    const buf = await ctx.startRendering();
    const n = buf.length, ch = [buf.getChannelData(0), buf.getChannelData(1)];
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); out.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) out.setInt16(44 + i * 4 + c * 2, Math.max(-1, Math.min(1, ch[c][i])) * 32767, true);
    return out.buffer;
  }

  return {
    update,
    startOffline,
    render,
    get enabled() { return on; },
    get running() { return !!ctx && ctx.state === "running"; },
    get played() { return played; },
    setEnabled(v) {
      on = v;
      if (master) master.gain.setTargetAtTime(on ? 1 : 0, clock(), 0.05);
    },
    setPaused(v) {
      paused = v;
      if (!ctx || offline) return;
      if (v) ctx.suspend();
      else ctx.resume();
    },
  };
}

export { rustle };
