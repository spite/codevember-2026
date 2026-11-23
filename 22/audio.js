import { nativeRandom } from "modules/random.js";

// Synthesized acoustic ping + scene-matched multi-bounce echoes + opt-in mic input.

export function createAudio() {
  let ctx = null;
  let master = null;
  let bus = null;
  let scope = null;
  let reverb = null;
  let reverbSend = null;
  let noiseBuf = null;
  let muted = false;

  // Microphone state
  let micStream = null;
  let micSource = null;
  // The mic, a moment late (MIC_PRE): echoes of the voice can then include the instant before it was detected.
  let micPre = null;
  const MIC_PRE = 0.12;
  let micAnalyser = null;
  let micTimeData = null;
  let micFreqData = null;
  let micActive = false;
  let micLabel = "";
  let noiseFloor = 0.015;
  let micRecorder = null;
  // The last few seconds of the mic, so each utterance can be cut out and played back as the ping.
  let ring = null;
  let written = 0;
  let speaking = false;
  let uttStart = 0;
  let uttStartMs = 0;
  let lastLoudMs = 0;
  let uttRatio = 0;
  let uttCentroid = 0.35;
  let lastOnsetMs = -1e9;
  let prevRatio = 0;
  // Until then the page is playing a voice echo, which the mic would hear and re-trigger on.
  let busyUntil = 0;

  function ensureContext() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    buildGraph();
    return ctx;
  }

  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.72;
    master.connect(ctx.destination);
    // Everything the page plays goes through the bus, which the scope reads before the mute.
    bus = ctx.createGain();
    bus.connect(master);
    scope = ctx.createAnalyser();
    scope.fftSize = 512;
    bus.connect(scope);

    // Cavernous stone-gallery reverb tail (convolver) to carry the sonar ring.
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * 1.9);
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.8) * (i < rate * 0.03 ? i / (rate * 0.03) : 1);
        d[i] = (nativeRandom() * 2 - 1) * env * 0.32;
      }
    }
    reverb = ctx.createConvolver();
    reverb.buffer = ir;
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.34;
    reverbSend.connect(reverb);
    reverb.connect(bus);

    // Short noise burst buffer for acoustic click transients.
    const nLen = Math.floor(rate * 0.06);
    noiseBuf = ctx.createBuffer(1, nLen, rate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) {
      nd[i] = (nativeRandom() * 2 - 1) * Math.exp(-i / (rate * 0.008));
    }
  }

  // For a video: from beginOffline on, every sound goes to an offline context timed by the page's clock (the
  // recorder's virtual one), and renderOffline returns the soundtrack as a 16-bit stereo WAV.
  let offline = null;
  const now = () => (offline ? (performance.now() - offline.t0) / 1000 : ctx.currentTime);
  const live = () => !!offline || ctx?.state === "running";
  function beginOffline(seconds) {
    if (offline) return;
    ctx = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    muted = false;
    buildGraph();
    offline = { t0: performance.now() };
  }
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

  function triggerSonar(time, { gain = 0.32, pan = 0, pitch = 1.0, cutoff = 4200, isPrimary = false, order = 0 }) {
    if (!ctx || muted) return;
    const g = Math.min(0.45, Math.max(0.008, gain));
    const tail = isPrimary ? 0.62 : Math.max(0.24, 0.44 - order * 0.07);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), time);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoff, time);
    filter.Q.value = isPrimary ? 1.8 : 1.1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(g, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, time + tail);

    // Classic resonant sonar carrier (~1320 Hz) with subtle micro-chirp attack.
    const baseFreq = 1320 * pitch * (1 - order * 0.015);
    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.setValueAtTime(baseFreq * 1.03, time);
    carrier.frequency.exponentialRampToValueAtTime(baseFreq, time + 0.018);
    carrier.connect(filter);

    // Subtle slightly detuned 2nd harmonic for glassy/metallic shimmer on primary & 1st bounce.
    let overtone = null;
    if (isPrimary || order === 1) {
      overtone = ctx.createOscillator();
      overtone.type = "sine";
      overtone.frequency.setValueAtTime(baseFreq * 2.004, time);
      const oGain = ctx.createGain();
      oGain.gain.setValueAtTime(isPrimary ? 0.14 : 0.07, time);
      oGain.gain.exponentialRampToValueAtTime(0.001, time + tail * 0.55);
      overtone.connect(oGain);
      oGain.connect(filter);
    }

    // Gentle octave-below body for warmth on the primary ping.
    let sub = null;
    if (isPrimary) {
      sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(baseFreq * 0.5, time);
      const sGain = ctx.createGain();
      sGain.gain.value = 0.16;
      sub.connect(sGain);
      sGain.connect(filter);
    }

    filter.connect(env);
    env.connect(panner);
    panner.connect(bus);
    if (isPrimary || order === 1) panner.connect(reverbSend);

    const stopAt = time + tail + 0.03;
    carrier.start(time);
    carrier.stop(stopAt);
    if (overtone) {
      overtone.start(time);
      overtone.stop(stopAt);
    }
    if (sub) {
      sub.start(time);
      sub.stop(stopAt);
    }
  }

  function playPing({ pitch = 1.0, intensity = 1.0, echoes = [], skipPrimary = false } = {}) {
    if (muted) return;
    const c = ensureContext();
    if (!c || c.state !== "running") return;
    const now = c.currentTime + 0.004;

    if (!skipPrimary) {
      triggerSonar(now, {
        gain: 0.26 * Math.min(1.4, intensity),
        pan: 0,
        pitch,
        cutoff: 5200,
        isPrimary: true,
        order: 0,
      });
    }

    // Schedule up to 10 well-spaced stereo-panned sonar echoes matching the traced bounces.
    let scheduled = 0;
    let lastDelay = -1;
    for (let i = 0; i < echoes.length && scheduled < 10; i++) {
      const e = echoes[i];
      if (e.delay < 0.06 || e.delay - lastDelay < 0.055) continue;
      lastDelay = e.delay;
      scheduled++;
      const cutoff = e.order === 1 ? 2600 : e.order === 2 ? 1650 : 1050;
      triggerSonar(now + e.delay, {
        gain: 0.16 * e.gain,
        pan: e.pan,
        pitch: e.pitch,
        cutoff,
        isPrimary: false,
        order: e.order,
      });
    }
  }

  function setMuted(m) {
    muted = !!m;
    if (master && ctx) {
      master.gain.setTargetAtTime(muted ? 0 : 0.72, ctx.currentTime, 0.02);
    }
  }

  function isMuted() {
    return muted;
  }

  async function startMic() {
    if (micActive) return true;
    if (!window.isSecureContext) {
      throw new Error("needs HTTPS or localhost");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia unavailable");
    }
    const c = ensureContext();
    if (!c) throw new Error("Web Audio unavailable");
    if (c.state === "suspended") await c.resume();
    micStream = await navigator.mediaDevices.getUserMedia({
      // Raw by default so claps and snaps come through; gain control lifts quiet laptop mics.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    if (c.state === "suspended") await c.resume();
    micSource = c.createMediaStreamSource(micStream);
    micAnalyser = c.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.2;
    micSource.connect(micAnalyser);
    micPre = c.createDelay(1);
    micPre.delayTime.value = MIC_PRE;
    micSource.connect(micPre);
    ring = new Float32Array(Math.ceil(c.sampleRate * 4));
    written = 0;
    speaking = false;
    micRecorder = c.createScriptProcessor(2048, 1, 1);
    micRecorder.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) ring[(written + i) % ring.length] = input[i];
      written += input.length;
    };
    // A ScriptProcessor only runs while connected to the output; this one plays silence.
    const sink = c.createGain();
    sink.gain.value = 0;
    micSource.connect(micRecorder);
    micRecorder.connect(sink);
    sink.connect(c.destination);
    micTimeData = new Float32Array(micAnalyser.fftSize);
    micFreqData = new Uint8Array(micAnalyser.frequencyBinCount);
    micActive = true;
    micLabel = micStream.getAudioTracks()[0]?.label || "microphone";
    noiseFloor = 0.004;
    return true;
  }

  function stopMic() {
    micActive = false;
    speaking = false;
    if (micRecorder) {
      micRecorder.onaudioprocess = null;
      try { micRecorder.disconnect(); } catch {}
      micRecorder = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch {}
      micSource = null;
    }
    if (micPre) {
      try { micPre.disconnect(); } catch {}
      micPre = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    micAnalyser = null;
  }

  function isMicActive() {
    return micActive;
  }

  function spectralCentroid() {
    micAnalyser.getByteFrequencyData(micFreqData);
    let weighted = 0;
    let total = 0;
    for (let i = 2; i < 160; i++) {
      weighted += i * micFreqData[i];
      total += micFreqData[i];
    }
    return total > 10 ? weighted / (total * 160) : 0.35;
  }

  // Cuts samples [from, to) out of the ring, normalized, with short fades so the clip doesn't click.
  function extractClip(from, to) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.min(to - from, ring.length, Math.floor(rate * 2)));
    const start = to - length;
    const buffer = ctx.createBuffer(1, length, rate);
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < length; i++) {
      d[i] = ring[(start + i) % ring.length];
      peak = Math.max(peak, Math.abs(d[i]));
    }
    const gain = Math.min(20, 0.8 / Math.max(peak, 1e-4));
    const fade = Math.min(Math.floor(rate * 0.012), length >> 1);
    for (let i = 0; i < length; i++) {
      const edge = Math.min(1, i / fade, (length - 1 - i) / fade);
      d[i] *= gain * edge;
    }
    return buffer;
  }

  // Called every frame while the mic listens. Each utterance (voice, clap, shout) is cut out once it ends
  // and returned as the ping's sound, with an intensity from its loudness and a pitch from its brightness.
  function pollMic(nowMs, sensitivity = 0.72) {
    if (!micActive || !micAnalyser) return { level: 0, peak: 0, busy: false, utterance: null };

    micAnalyser.getFloatTimeDomainData(micTimeData);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < micTimeData.length; i++) {
      const v = micTimeData[i];
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / micTimeData.length);
    const energy = Math.max(rms, peak * 0.35);

    // Slowly tracks the room's noise floor, capped so sustained sound can't raise it out of range.
    if (energy < noiseFloor * 1.6) {
      noiseFloor = noiseFloor * 0.94 + energy * 0.06;
    } else {
      noiseFloor = Math.min(0.025, noiseFloor * 0.998 + energy * 0.002);
    }

    // Sensitivity 0..1 maps the threshold logarithmically from 0.045 down to 0.0025.
    const baseThresh = 0.045 * Math.pow(0.055, sensitivity);
    const threshold = Math.max(noiseFloor * 1.45, baseThresh);
    const ratio = energy / Math.max(threshold, 0.002);
    const level = Math.min(1, Math.log1p(ratio * 2.5) / Math.log(12));

    const busy = ctx.currentTime < busyUntil;

    // Onsets ping at once: the start of a sound, and any sharp jump within it (syllables, claps).
    // While the page plays echoes, only sounds well above them count, so the echoes don't re-trigger.
    let onset = null;
    const gate = busy ? 3 : 1;
    const loudness = (r) => Math.min(1.65, Math.max(0.3, 0.22 + Math.log1p(Math.max(0, r - 1)) * 0.42));
    if (ratio > gate && nowMs - lastOnsetMs > 280 && (!speaking || ratio > prevRatio * 1.8)) {
      onset = { intensity: loudness(ratio / gate) };
      lastOnsetMs = nowMs;
    }
    prevRatio = ratio;
    if (busy) {
      speaking = false;
      return { level, peak, ratio, busy, onset, utterance: null };
    }
    if (!speaking && energy > threshold) {
      speaking = true;
      uttStart = Math.max(0, written - Math.floor(ctx.sampleRate * 0.08));
      uttStartMs = nowMs;
      lastLoudMs = nowMs;
      uttRatio = ratio;
      uttCentroid = spectralCentroid();
    }
    if (speaking) {
      if (energy > threshold * 0.7) {
        lastLoudMs = nowMs;
        uttRatio = Math.max(uttRatio, ratio);
      }
      if (nowMs - lastLoudMs > 220 || nowMs - uttStartMs > 1600) {
        speaking = false;
        // Loudness to intensity: whispers ~0.3, normal voice ~0.75, claps and shouts ~1.5.
        const intensity = Math.min(1.65, Math.max(0.24, 0.22 + Math.log1p(uttRatio - 1) * 0.42));
        return {
          level,
          peak,
          ratio,
          busy,
          onset,
          utterance: {
            clip: extractClip(uttStart, written),
            intensity,
            pitch: 0.75 + uttCentroid * 0.9,
            duration: (nowMs - uttStartMs) / 1000,
          },
        };
      }
    }
    return { level, peak, ratio, busy, onset, utterance: null };
  }

  // Plays a recorded clip as the ping: at the source (unless primary is false, when it was just heard live),
  // then once per echo, delayed, panned and duller. elapsed: seconds since the sound actually started,
  // so echoes that should already have begun start partway into the clip.
  // rate: playback speed (and pitch) of every copy, for a little variation between calls.
  // How the echoes come back:
  //   flutter (0..1, how narrow the space is): parallel walls ring the call and its first echoes with a fast
  //   flutter, a short feedback delay; later echoes are smeared into the reverb rather than crisp copies.
  //   weirdness (0..1, depth): echoes drift lower and slower, warble like a stretched tape, and now and then
  //   one comes back reversed; past halfway, sometimes a different take answers, late, from the wrong side.
  //   others: the takes that can answer.
  const reversed = new WeakMap();
  function reverseOf(clip) {
    let r = reversed.get(clip);
    if (!r) {
      r = ctx.createBuffer(clip.numberOfChannels, clip.length, clip.sampleRate);
      for (let c = 0; c < clip.numberOfChannels; c++) r.getChannelData(c).set(clip.getChannelData(c).slice().reverse());
      reversed.set(clip, r);
    }
    return r;
  }
  function playVoice(clip, { intensity = 1, echoes = [], primary = true, elapsed = 0, rate = 1, flutter = 0, weirdness = 0, others = [] } = {}) {
    // Until the context runs, sounds would only queue up and all play at once on the first click.
    if (muted || !ctx || !live()) return;
    const t0 = now() + 0.01;
    const w = Math.max(0, Math.min(1, weirdness));
    // The flutter: a ~13 ms round trip between walls a corridor apart, fed back and darkened each pass.
    let ring = null;
    if (flutter > 0.05) {
      ring = ctx.createDelay(0.05);
      ring.delayTime.value = 0.011 + nativeRandom() * 0.005;
      const fb = ctx.createGain();
      fb.gain.value = 0.35 + 0.3 * flutter;
      const dark = ctx.createBiquadFilter();
      dark.type = "lowpass";
      dark.frequency.value = 2600;
      const out = ctx.createGain();
      out.gain.value = 0.5 * flutter;
      ring.connect(dark);
      dark.connect(fb);
      fb.connect(ring);
      dark.connect(out);
      out.connect(bus);
      const r = ring;
      setTimeout(() => r.disconnect(), (clip.duration + 3) * 1000);
    }
    const play = (time, gain, pan, cutoff, { reverb = false, flutters = false, buffer = clip, speed = rate, warble = 0, dir = null } = {}) => {
      const offset = Math.max(0, t0 - time);
      if (offset >= buffer.duration / speed) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = speed;
      if (warble > 0) {
        // Tape-like wow: a slow wobble of pitch, in cents.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 3 + nativeRandom() * 4;
        const depth = ctx.createGain();
        depth.gain.value = warble;
        lfo.connect(depth);
        depth.connect(src.detune);
        lfo.start(Math.max(t0, time));
        lfo.stop(Math.max(t0, time) + buffer.duration / speed + 0.1);
      }
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;
      const g = ctx.createGain();
      g.gain.value = gain;
      // Spatial: from its direction around the head (HRTF, so behind and above read too); the gain already
      // carries the distance. Without a direction, plain left/right.
      let panner;
      if (dir) {
        panner = ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "linear";
        panner.rolloffFactor = 0;
        panner.positionX.value = dir[0];
        panner.positionY.value = dir[1];
        panner.positionZ.value = dir[2];
      } else {
        panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
      }
      src.connect(filter);
      filter.connect(g);
      g.connect(panner);
      panner.connect(bus);
      if (reverb) panner.connect(reverbSend);
      if (flutters && ring) panner.connect(ring);
      src.start(Math.max(t0, time), offset * speed);
    };
    if (primary) play(t0, 0.55 * Math.min(1.2, intensity), 0, 12000, { reverb: true, flutters: true });
    let end = t0 + clip.duration - elapsed;
    let lastDelay = -1;
    let scheduled = 0;
    // At most one reversed echo a call, more likely deeper in.
    let reverse = nativeRandom() < w * 0.35 ? 2 + Math.floor(nativeRandom() * 4) : -1;
    for (const e of echoes) {
      if (scheduled >= 10 || e.delay < 0.06 || e.delay - lastDelay < 0.055) continue;
      lastDelay = e.delay;
      scheduled++;
      const cutoff = e.order === 1 ? 3200 : e.order === 2 ? 2000 : 1200;
      // Later echoes lean on the reverb (smeared), earlier ones stay crisp and ring in narrow spaces.
      const late = e.order > 1;
      const speed = rate * (1 - w * (0.04 + 0.1 * nativeRandom()) * (late ? 1.4 : 1));
      const flip = scheduled === reverse;
      play(t0 + e.delay - elapsed, 0.45 * e.gain * (late ? 0.7 : 1), e.pan, cutoff, {
        reverb: true,
        flutters: !late,
        buffer: flip ? reverseOf(clip) : clip,
        speed,
        dir: e.dir,
        warble: w > 0.1 ? w * (25 + 35 * nativeRandom()) : 0,
      });
      end = Math.max(end, t0 + e.delay - elapsed + clip.duration / speed);
    }
    // An answer that isn't yours: another take, late, low, from the other side.
    if (others.length && w > 0.5 && nativeRandom() < (w - 0.5) * 0.9) {
      const take = others[Math.floor(nativeRandom() * others.length)];
      const at = t0 + Math.max(lastDelay, 0.3) + 0.5 + nativeRandom() * 0.9;
      const side = (nativeRandom() < 0.5 ? -1 : 1) * (0.5 + 0.5 * nativeRandom());
      const speed = 0.86 + nativeRandom() * 0.08;
      // Somewhere off to the side and behind.
      const a = side * (1.6 + nativeRandom() * 1.2);
      play(at, 0.22, side, 1500, { reverb: true, buffer: take, speed, warble: 20, dir: [Math.sin(a), 0.1, -Math.cos(a)] });
      end = Math.max(end, at + take.duration / speed);
    }
    busyUntil = end + 0.25;
  }

  // Fills out with the latest samples: the microphone while it listens, otherwise the page's own sound.
  function getWaveform(out) {
    const analyser = micActive && micAnalyser ? micAnalyser : scope;
    if (!analyser) return false;
    analyser.getFloatTimeDomainData(out);
    return true;
  }

  // A footstep on carpet: a soft low thud and a short scuff, varied a little each time.
  function playStep(gain = 1, pan = 0) {
    if (muted || !ctx || !live()) return;
    const t = now() + 0.005;
    // The mic shouldn't hear our own footsteps as a call.
    busyUntil = Math.max(busyUntil, t + 0.3);
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(bus);
    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(95 + nativeRandom() * 25, t);
    thud.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.22 * gain, t + 0.008);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    thud.connect(tg);
    tg.connect(out);
    thud.start(t);
    thud.stop(t + 0.15);
    const scuff = ctx.createBufferSource();
    scuff.buffer = noiseBuf;
    scuff.playbackRate.value = 0.5 + nativeRandom() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700 + nativeRandom() * 400;
    const sg = ctx.createGain();
    sg.gain.value = 0.5 * gain;
    scuff.connect(lp);
    lp.connect(sg);
    sg.connect(out);
    scuff.start(t + 0.01);
  }

  // Breathing: one recorded breath (inhale then exhale), close to the mic, slightly varied.
  function playBreath(clip, gain = 1, rate = 1, delay = 0) {
    if (muted || !ctx || !live()) return;
    const src = ctx.createBufferSource();
    src.buffer = clip;
    src.playbackRate.value = rate * (0.96 + nativeRandom() * 0.08);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(bus);
    src.start(now() + 0.01 + delay);
  }

  // The visitor's own voice, echoing: the mic (from just before the call was detected, for 1.3 s) through one
  // delay per echo, darker and quieter the later it comes, from its direction around the head.
  function playMicEchoes(echoes) {
    if (muted || !micPre || !ctx || offline || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(0, t);
    gate.gain.linearRampToValueAtTime(1, t + 0.01);
    gate.gain.setValueAtTime(1, t + 1.1);
    gate.gain.linearRampToValueAtTime(0, t + 1.3);
    micPre.connect(gate);
    const nodes = [gate];
    let lastDelay = -1, scheduled = 0, longest = 0;
    for (const e of echoes) {
      if (scheduled >= 10 || e.delay < 0.06 || e.delay - lastDelay < 0.055) continue;
      lastDelay = e.delay;
      scheduled++;
      const late = e.order > 1;
      const d = ctx.createDelay(10);
      d.delayTime.value = Math.max(0, e.delay - MIC_PRE);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = e.order === 1 ? 3200 : e.order === 2 ? 2000 : 1200;
      const g = ctx.createGain();
      g.gain.value = 0.9 * e.gain * (late ? 0.7 : 1);
      let panner;
      if (e.dir) {
        panner = ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "linear";
        panner.rolloffFactor = 0;
        panner.positionX.value = e.dir[0];
        panner.positionY.value = e.dir[1];
        panner.positionZ.value = e.dir[2];
      } else {
        panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, e.pan));
      }
      gate.connect(d);
      d.connect(filter).connect(g).connect(panner).connect(bus);
      panner.connect(reverbSend);
      nodes.push(d, filter, g, panner);
      longest = Math.max(longest, e.delay);
    }
    // The page's own echoes mustn't count as new calls.
    busyUntil = Math.max(busyUntil, t + longest + 1.4);
    setTimeout(() => {
      try {
        micPre?.disconnect(gate);
      } catch {}
      for (const n of nodes) n.disconnect();
    }, (longest + 2) * 1000);
  }

  // A tape rewinding: the motor's whine rising and the tape's hiss, for `seconds`.
  function playRewind(seconds = 3) {
    if (muted || !ctx || !live()) return;
    const t = now() + 0.02;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.18, t + 0.25);
    out.gain.setValueAtTime(0.18, t + seconds - 0.35);
    out.gain.linearRampToValueAtTime(0, t + seconds);
    out.connect(bus);
    const motor = ctx.createOscillator();
    motor.type = "sawtooth";
    motor.frequency.setValueAtTime(70, t);
    motor.frequency.exponentialRampToValueAtTime(190, t + seconds * 0.8);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 700;
    const mg = ctx.createGain();
    mg.gain.value = 0.35;
    motor.connect(tone).connect(mg).connect(out);
    const len = Math.ceil(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = nativeRandom() * 2 - 1;
    const hiss = ctx.createBufferSource();
    hiss.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(900, t);
    band.frequency.exponentialRampToValueAtTime(3200, t + seconds * 0.8);
    const hg = ctx.createGain();
    hg.gain.value = 0.25;
    hiss.connect(band).connect(hg).connect(out);
    motor.start(t);
    hiss.start(t);
    motor.stop(t + seconds);
    hiss.stop(t + seconds);
  }

  // A clip cut so its voice lands at the same moment in every take: `pre` seconds after the start, the point where
  // it first reaches 40% of its peak (smoothed over 5 ms), which is the vowel rather than a soft "h" before it.
  // Every call then starts together with its rays, and its echoes stay in step.
  function trimOnset(clip, pre = 0.06) {
    const d = clip.getChannelData(0);
    const w = Math.max(1, Math.round(clip.sampleRate * 0.005));
    let peak = 0, sum = 0;
    const env = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) {
      sum += Math.abs(d[i]) - (i >= w ? Math.abs(d[i - w]) : 0);
      env[i] = sum / w;
      peak = Math.max(peak, env[i]);
    }
    const at = env.findIndex((v) => v > peak * 0.4) - Math.round(w / 2);
    const on = Math.max(0, at - Math.round(pre * clip.sampleRate));
    if (on === 0) {
      // Too little before it: pad with silence instead.
      const pad = Math.round(pre * clip.sampleRate) - at;
      if (pad <= 0) return clip;
      const out = new AudioBuffer({ length: clip.length + pad, numberOfChannels: clip.numberOfChannels, sampleRate: clip.sampleRate });
      for (let c = 0; c < clip.numberOfChannels; c++) out.copyToChannel(clip.getChannelData(c), c, pad);
      return out;
    }
    const out = new AudioBuffer({ length: clip.length - on, numberOfChannels: clip.numberOfChannels, sampleRate: clip.sampleRate });
    for (let c = 0; c < clip.numberOfChannels; c++) out.copyToChannel(clip.getChannelData(c).subarray(on), c);
    return out;
  }

  // Recorded calls (short spoken words), decoded once for playVoice.
  async function loadClips(urls, onProgress) {
    const c = ensureContext();
    let done = 0;
    return Promise.all(
      urls.map(async (url) => {
        const data = await (await fetch(url)).arrayBuffer();
        const buffer = await c.decodeAudioData(data);
        onProgress?.(++done / urls.length);
        return buffer;
      }),
    );
  }

  return {
    ensureContext,
    beginOffline,
    renderOffline,
    loadClips,
    trimOnset,
    playRewind,
    playMicEchoes,
    playStep,
    playBreath,
    getWaveform,
    playPing,
    playVoice,
    setMuted,
    isMuted,
    isRunning: () => ctx?.state === "running",
    startMic,
    stopMic,
    isMicActive,
    micLabel: () => micLabel,
    pollMic,
  };
}
