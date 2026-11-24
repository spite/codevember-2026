import { fetchWithProgress } from "common";
import { nativeRandom } from "modules/random.js";

// The looping soundtrack on its own Web Audio bus. The context is created on load and runs at once when the browser
// allows it; otherwise it starts on the first gesture. silent (captures) loads nothing and never plays.
export function createSoundtrack({ url, volume = 0.55, onProgress, silent = false } = {}) {
  if (silent) {
    onProgress?.(1);
    return { loaded: Promise.resolve(), running: true, enabled: false, arm() {}, setEnabled() {}, setPaused() {} };
  }
  const ctx = new AudioContext();
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(ctx.destination);
  const audio = new Audio();
  audio.loop = true;
  ctx.createMediaElementSource(audio).connect(bus);

  let enabled = true;
  let paused = false;
  let started = false;
  // Nothing plays until the page says it is ready (arm), so the music never starts behind the loading screen
  let armed = false;

  // Fully downloaded behind the loading pill, so the first note never waits on the network
  const loaded = fetchWithProgress(url, onProgress)
    .then((res) => res.blob())
    .then((blob) => {
      audio.src = URL.createObjectURL(blob);
      tryStart();
    })
    .catch((err) => console.warn("soundtrack", err));

  const fadeTo = (value, seconds) => {
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setTargetAtTime(value, ctx.currentTime, seconds / 3);
  };

  function tryStart() {
    if (!armed || !enabled || paused || document.hidden || ctx.state !== "running" || !audio.src) return;
    const first = !started;
    if (first) {
      started = true;
      // Each visit joins the drone somewhere in its first minute
      const seek = () => (audio.currentTime = nativeRandom() * Math.min(60, audio.duration * 0.5));
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (audio.paused) audio.play().catch(() => {});
    fadeTo(volume, first ? 4 : 0.5);
  }

  const unlock = () => {
    if (!paused && ctx.state !== "running") ctx.resume().catch(() => {});
    tryStart();
  };
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(type, unlock, { capture: true });
  ctx.addEventListener("statechange", tryStart);

  const stop = () => {
    fadeTo(0, 0.3);
    setTimeout(() => (!enabled || paused) && audio.pause(), 300);
  };

  return {
    loaded,
    arm() {
      armed = true;
      tryStart();
    },
    get running() {
      return ctx.state === "running";
    },
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = value;
      if (enabled) unlock();
      else stop();
    },
    setPaused(value) {
      paused = value;
      if (paused) stop();
      else if (navigator.userActivation?.hasBeenActive ?? true) unlock();
    },
  };
}
