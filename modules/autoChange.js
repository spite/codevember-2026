// Kiosk mode: randomizes every `every` seconds when nobody is interacting. Randomizing, pausing and
// any pointer, wheel or key input start the count over; it holds while a pointer is down and while
// `ready()` is false (e.g. a layout still landing). Off under ?capture, which drives its own changes.
import { signal } from "guspira";
import { onRandomize, onPause, randomize, isRunning } from "common";

const capture = new URLSearchParams(location.search).has("capture");

// enabled, every: the day's signals (so they live in its params and url state).
function createAutoChange({ enabled, every, gui, min = 5, max = 60, ready = () => true, onChange = randomize }) {
  let elapsed = 0;
  let held = false;
  const status = signal("");
  const on = () => enabled() && !capture;
  const restart = () => (elapsed = 0);

  onRandomize(restart);
  onPause(restart);
  const opts = { capture: true, passive: true };
  addEventListener("pointerdown", () => ((held = true), restart()), opts);
  for (const e of ["pointerup", "pointercancel"]) addEventListener(e, () => ((held = false), restart()), opts);
  for (const e of ["wheel", "keydown"]) addEventListener(e, restart, opts);

  if (gui) {
    gui.addCheckbox("Auto change", enabled, { randomizable: false });
    gui.addSlider("Change every", every, min, max, 1, { randomizable: false });
    gui.addMonitor("Next change", status);
  }

  function describe() {
    if (!on()) return "off";
    if (!isRunning()) return "paused";
    if (held || !ready()) return "waiting";
    return `in ${Math.max(1, Math.ceil(every() - elapsed))} s`;
  }

  // Call once a frame with the page's dt (0 while paused).
  function update(dt) {
    elapsed = on() && !held && ready() ? elapsed + dt : 0;
    if (elapsed >= every()) {
      elapsed = 0;
      onChange();
    }
    const text = describe();
    if (text !== status.peek()) status.set(text);
  }

  return {
    update,
    restart,
    get remaining() {
      return on() ? Math.max(0, every() - elapsed) : Infinity;
    },
  };
}

export { createAutoChange };
