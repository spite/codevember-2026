// Kiosk mode: randomizes every `every` seconds when nobody is interacting. Randomizing, pausing and
// any pointer, wheel or key input start the count over; it holds while a pointer is down and while
// `ready()` is false (e.g. a layout still landing). Off under ?capture, which drives its own changes.
import { signal } from "guspira";
import { onRandomize, onPause, randomize, isRunning } from "common";
import { days } from "./days.js";

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

  const pill = capture ? null : createPill();

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
    if (pill) {
      const shown = on() && isRunning();
      pill.root.classList.toggle("shown", shown);
      pill.root.classList.toggle("waiting", held || !ready());
      if (shown) {
        pill.set(held ? "Waiting…" : !ready() ? "Randomizing…" : `${pill.prefix} ${Math.max(1, Math.ceil(every() - elapsed))} s`);
        pill.root.style.setProperty("--left", Math.min(1, Math.max(0, 1 - elapsed / every())));
      }
    }
  }

  return {
    update,
    restart,
    // Leaves at least `seconds` before the next change (opt-in: a day that wants time to show something it just did).
    hold: (seconds) => (elapsed = Math.min(elapsed, every() - seconds)),
    get remaining() {
      return on() ? Math.max(0, every() - elapsed) : Infinity;
    },
  };
}

// On-screen countdown: a pill like the loader's at the bottom centre, its fill shrinking to the next change.
function createPill() {
  const root = document.createElement("div");
  root.id = "auto-change";
  const text = document.createElement("span");
  root.append(text);
  document.body.append(root);
  const day = parseInt(location.pathname.split("/").at(-2));
  const prompt = days.find((d) => d.day === day)?.prompt;
  let sized = false;
  return {
    root,
    prefix: prompt ? `New ${prompt.toLowerCase()} in` : "Next change in",
    // The pill's width follows the text, animated.
    set(label) {
      if (text.textContent === label && sized) return;
      text.textContent = label;
      const w = text.offsetWidth;
      sized = w > 0;
      if (sized) root.style.width = `${w}px`;
    },
  };
}

export { createAutoChange };
