// Sample-based CC0 foley for the labyrinth: continuous rolling loops (wood, stone, metal) and wall-rubbing scrape,
// filtered and pitch-shifted by marble speed, plus stereo-panned wall knocks, pocket drops, goal latches and swooshes.
import { nativeRandom } from "modules/random.js";

const LOOP_NAMES = ["roll-wood", "roll-stone", "roll-metal", "scrape"];
const ONE_SHOT_SETS = {
  wood: 6,
  stone: 6,
  metal: 6,
  drop: 4,
  win: 2,
  swoosh: 4,
  shift: 6,
};
const MIN_SPACING = {
  wood: 0.022,
  stone: 0.022,
  metal: 0.022,
  drop: 0.08,
  win: 0.4,
  swoosh: 0.22,
  shift: 0.024,
};
const MAX_VOICES = 20;

export function createLabyrinthSound({ base = "./sounds/", enabled = true, onProgress } = {}) {
  const ctx = new AudioContext();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.ratio.value = 3.5;

  const master = ctx.createGain();
  master.gain.value = enabled ? 0.85 : 0;
  master.connect(compressor).connect(ctx.destination);

  // Dedicated stereo music bus (bypasses foley compressor so drum/string swells never pump marble knocks).
  const musicMaster = ctx.createGain();
  musicMaster.gain.value = enabled ? 1 : 0;
  musicMaster.connect(ctx.destination);

  const musicFilter = ctx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 20000;
  musicFilter.Q.value = 0.5;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 0;
  musicFilter.connect(musicGain).connect(musicMaster);

  const musicAudio = new Audio(`${base}soundtrack.mp3`);
  musicAudio.loop = true;
  musicAudio.preload = "auto";
  const musicSourceNode = ctx.createMediaElementSource(musicAudio);
  musicSourceNode.connect(musicFilter);

  let isEnabled = enabled;
  let isPaused = false;
  let musicStarted = false;
  let musicVolume = 0.7;
  let musicFade = 1;
  let activeVoices = [];
  const lastVariant = {};
  const lastPlayedAt = {};
  const sampleBuffers = {};
  const loops = {};

  const fileList = [
    ...LOOP_NAMES,
    ...Object.entries(ONE_SHOT_SETS).flatMap(([setName, count]) =>
      Array.from({ length: count }, (_, index) => `${setName}-${index}`),
    ),
  ];

  let fetchedCount = 0;
  const loaded = Promise.all(
    fileList.map((fileName) =>
      fetch(`${base}${fileName}.mp3`)
        .then((res) => res.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((audioBuffer) => {
          sampleBuffers[fileName] = audioBuffer;
        })
        .catch((err) => console.warn("labyrinth sound", fileName, err))
        .finally(() => onProgress?.(++fetchedCount / fileList.length)),
    ),
  ).then(() => {
    for (const loopName of LOOP_NAMES) {
      const buffer = sampleBuffers[loopName];
      if (!buffer) continue;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 1200;
      filter.Q.value = 0.6;

      const panner = ctx.createStereoPanner();
      panner.pan.value = 0;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      filter.connect(panner).connect(gain).connect(master);
      loops[loopName] = {
        buffer,
        filter,
        panner,
        gain,
        source: null,
        level: 0,
        quietSince: null,
      };
    }
  });

  const MAX_MUSIC_GAIN = 0.42;

  function applyMusicTargets(timeConstant = 0.05) {
    const now = ctx.currentTime;
    const clampedFade = Math.max(0, Math.min(1, musicFade));
    const targetGain = isEnabled && !isPaused ? musicVolume * MAX_MUSIC_GAIN * clampedFade : 0;
    const targetCutoff = 380 + 19620 * Math.pow(clampedFade, 1.5);
    if (timeConstant <= 0) {
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(targetGain, now);
      musicFilter.frequency.cancelScheduledValues(now);
      musicFilter.frequency.setValueAtTime(targetCutoff, now);
    } else {
      musicGain.gain.setTargetAtTime(targetGain, now, timeConstant);
      musicFilter.frequency.setTargetAtTime(targetCutoff, now, Math.min(0.08, timeConstant));
    }
  }

  function ensureMusicPlaying() {
    if (!isEnabled || isPaused || document.hidden) return;
    if (!musicStarted) {
      musicGain.gain.cancelScheduledValues(ctx.currentTime);
      musicGain.gain.setValueAtTime(0, ctx.currentTime);
      musicAudio
        .play()
        .then(() => {
          musicStarted = true;
          applyMusicTargets(0.38);
        })
        .catch(() => {});
      return;
    }
    if (musicAudio.paused) {
      musicAudio.play().catch(() => {});
    }
    applyMusicTargets(0.08);
  }

  const unlockOnGesture = () => {
    if (!isPaused && ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
    ensureMusicPlaying();
  };
  for (const eventType of ["pointerdown", "touchend", "click", "keydown"]) {
    window.addEventListener(eventType, unlockOnGesture, { capture: true });
  }
  // Start the music whenever the context runs, including when the browser allows it without a gesture.
  ctx.addEventListener("statechange", () => {
    if (ctx.state === "running") ensureMusicPlaying();
  });
  if (ctx.state === "running") ensureMusicPlaying();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      musicAudio.pause();
      ctx.suspend().catch(() => {});
    } else if (!isPaused && (navigator.userActivation?.hasBeenActive ?? true)) {
      ctx.resume().catch(() => {});
      if (musicStarted) ensureMusicPlaying();
    }
  });

  const isLive = () => isEnabled && !isPaused && ctx.state === "running";

  function pickVariant(setName, count) {
    let index = Math.floor(nativeRandom() * count);
    if (count > 1 && index === lastVariant[setName]) {
      index = (index + 1) % count;
    }
    lastVariant[setName] = index;
    return index;
  }

  function playSet(setName, { gain = 1, pan = 0, rate = 1, delay = 0, facing = 1 } = {}) {
    const count = ONE_SHOT_SETS[setName];
    if (!isLive() || !count || gain <= 0.004) return false;

    const now = ctx.currentTime + Math.max(0, delay);
    const spacing = MIN_SPACING[setName] ?? 0.02;
    if (Math.abs(now - (lastPlayedAt[setName] ?? -Infinity)) < spacing) return false;
    lastPlayedAt[setName] = now;

    activeVoices = activeVoices.filter((endTime) => endTime > ctx.currentTime);
    if (activeVoices.length >= MAX_VOICES) return false;

    const variantIndex = pickVariant(setName, count);
    const buffer = sampleBuffers[`${setName}-${variantIndex}`];
    if (!buffer) return false;

    const variedRate = Math.max(0.45, Math.min(2.2, rate * (0.91 + nativeRandom() * 0.18)));
    const variedGain = Math.min(1, gain * (0.82 + nativeRandom() * 0.32));

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = variedRate;

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(variedGain, now);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);

    if (facing < 0.85) {
      const muffle = ctx.createBiquadFilter();
      muffle.type = "lowpass";
      muffle.frequency.setValueAtTime(900 + Math.max(0, facing) * 3200, now);
      source.connect(muffle).connect(voiceGain).connect(panner).connect(master);
    } else {
      source.connect(voiceGain).connect(panner).connect(master);
    }

    source.start(now);
    activeVoices.push(now + buffer.duration / variedRate);
    return true;
  }

  function setLoopState(loopName, level, rate = 1, cutoff = 2200, pan = 0) {
    const loop = loops[loopName];
    if (!loop) return;
    const targetLevel = isLive() ? Math.max(0, Math.min(1, level)) : 0;
    const now = ctx.currentTime;

    if (targetLevel > 0.002 && !loop.source) {
      const source = ctx.createBufferSource();
      source.buffer = loop.buffer;
      source.loop = true;
      source.loopStart = 0.04;
      source.loopEnd = Math.max(0.2, loop.buffer.duration - 0.04);
      const startOffset = 0.04 + nativeRandom() * Math.max(0.1, loop.buffer.duration - 0.12);
      source.connect(loop.filter);
      source.start(now, startOffset);
      loop.source = source;
      loop.quietSince = null;
    }

    if (loop.source) {
      loop.source.playbackRate.setTargetAtTime(Math.max(0.5, Math.min(2.0, rate)), now, 0.06);
      loop.filter.frequency.setTargetAtTime(Math.max(280, Math.min(6000, cutoff)), now, 0.06);
      loop.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.06);
    }

    if (Math.abs(targetLevel - loop.level) > 0.0015 || targetLevel === 0) {
      loop.gain.gain.setTargetAtTime(targetLevel, now, targetLevel > loop.level ? 0.035 : 0.07);
      loop.level = targetLevel;
      loop.quietSince = targetLevel > 0.002 ? null : (loop.quietSince ?? now);
    }

    if (loop.source && targetLevel <= 0.002 && loop.quietSince === null) {
      loop.quietSince = now;
    }
    if (loop.source && loop.level <= 0.002 && loop.quietSince !== null && now - loop.quietSince > 0.55) {
      try {
        loop.source.stop();
        loop.source.disconnect();
      } catch {}
      loop.source = null;
    }
  }

  // Updates continuous rolling and wall-scrape foley from marble state each frame.
  function updateRolling({ materialKind = "wood", speed = 0, scrapeSpeed = 0, pan = 0, facing = 1, active = true } = {}) {
    const normalizedSpeed = active ? Math.min(1, speed / 2.1) : 0;
    const visibilityScale = 0.55 + 0.45 * Math.max(0, facing);
    const rollGain = normalizedSpeed > 0.012 ? Math.pow(normalizedSpeed, 0.72) * 0.62 * visibilityScale : 0;
    const rollRate = 0.68 + normalizedSpeed * 0.72;
    const rollCutoff = (480 + normalizedSpeed * 3400) * (0.65 + 0.35 * Math.max(0, facing));

    for (const kind of ["wood", "stone", "metal"]) {
      const loopKey = `roll-${kind}`;
      if (kind === materialKind && active) {
        setLoopState(loopKey, rollGain, rollRate, rollCutoff, pan);
      } else {
        setLoopState(loopKey, 0, 1, 1200, 0);
      }
    }

    const normalizedScrape = active ? Math.min(1, scrapeSpeed / 1.8) : 0;
    const scrapeGain = normalizedScrape > 0.04 ? Math.pow(normalizedScrape, 0.85) * 0.28 * visibilityScale : 0;
    setLoopState("scrape", scrapeGain, 0.82 + normalizedScrape * 0.55, 900 + normalizedScrape * 2400, pan);
  }

  function silenceLoops() {
    for (const loopName of LOOP_NAMES) {
      setLoopState(loopName, 0, 1, 1200, 0);
    }
  }

  function hit(materialKind, { impactSpeed = 0, pan = 0, facing = 1, isGoalRim = false } = {}) {
    if (impactSpeed < 0.06) return false;
    const strength = Math.min(1, (impactSpeed - 0.05) / 1.65);
    const setKey = isGoalRim ? "metal" : ONE_SHOT_SETS[materialKind] ? materialKind : "wood";
    const gain = (0.1 + 0.78 * Math.pow(strength, 0.8)) * (0.55 + 0.45 * Math.max(0, facing));
    const rate = (isGoalRim ? 1.18 : 0.92) + strength * 0.26;
    return playSet(setKey, { gain, pan, rate, facing });
  }

  function drop({ pan = 0, rate = 1 } = {}) {
    return playSet("drop", { gain: 0.52, pan, rate });
  }

  function win({ pan = 0 } = {}) {
    playSet("drop", { gain: 0.55, pan, rate: 1.05 });
    return playSet("win", { gain: 0.58, pan, rate: 1.0, delay: 0.07 });
  }

  function swoosh({ spinSpeed = 0 } = {}) {
    if (spinSpeed < 3.2) return false;
    const strength = Math.min(1, (spinSpeed - 3.2) / 5.5);
    return playSet("swoosh", { gain: 0.14 + 0.28 * strength, pan: 0, rate: 0.9 + 0.3 * strength });
  }

  function wallWave({ count = 10, duration = 0.48, rising = true } = {}) {
    const steps = Math.max(3, Math.min(14, count));
    for (let i = 0; i < steps; i++) {
      const u = i / Math.max(1, steps - 1);
      const delay = u * duration * 0.85;
      const pan = (u - 0.5) * 1.1;
      const rate = rising ? 0.85 + u * 0.35 : 1.2 - u * 0.32;
      playSet("shift", { gain: 0.16, pan, rate, delay });
    }
  }

  function setMusicFade(fade, { immediate = false } = {}) {
    musicFade = Math.max(0, Math.min(1, fade));
    if (musicStarted) {
      applyMusicTargets(immediate ? 0 : 0.045);
    }
  }

  function setMusicVolume(vol) {
    const clamped = Math.max(0, Math.min(1, vol));
    if (Math.abs(clamped - musicVolume) < 1e-4) return;
    musicVolume = clamped;
    if (musicStarted) {
      applyMusicTargets(0.06);
    }
  }

  return {
    loaded,
    updateRolling,
    silenceLoops,
    hit,
    drop,
    win,
    swoosh,
    wallWave,
    setMusicFade,
    setMusicVolume,
    get musicFade() {
      return musicFade;
    },
    get musicPlaying() {
      return musicStarted && !musicAudio.paused;
    },
    get running() {
      return ctx.state === "running";
    },
    get enabled() {
      return isEnabled;
    },
    setEnabled(value) {
      isEnabled = value;
      master.gain.setTargetAtTime(isEnabled ? 0.85 : 0, ctx.currentTime, 0.05);
      musicMaster.gain.setTargetAtTime(isEnabled ? 1 : 0, ctx.currentTime, 0.06);
      if (!isEnabled) {
        silenceLoops();
        setTimeout(() => {
          if (!isEnabled) musicAudio.pause();
        }, 300);
      } else if (navigator.userActivation?.hasBeenActive ?? false) {
        ensureMusicPlaying();
      }
    },
    setPaused(value) {
      isPaused = value;
      if (value) {
        musicAudio.pause();
        ctx.suspend().catch(() => {});
      } else if (navigator.userActivation?.hasBeenActive ?? true) {
        ctx.resume().catch(() => {});
        if (musicStarted) ensureMusicPlaying();
      }
    },
  };
}
