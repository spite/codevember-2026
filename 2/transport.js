// A floating transport for the burst: rewind, play/pause, randomize and a scrubber over `value`
// (a 0..1 signal). Playback runs the burst in slow motion over `duration` seconds of page time.
const ICONS = {
  rewind: '<path d="M6 5h2v14H6zM20 5.5v13a.6.6 0 0 1-.9.5L9 12.5a.6.6 0 0 1 0-1l10.1-6.5a.6.6 0 0 1 .9.5z"/>',
  play: '<path d="M7 4.6v14.8a.7.7 0 0 0 1.05.6l12.3-7.4a.7.7 0 0 0 0-1.2L8.05 4A.7.7 0 0 0 7 4.6z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
}

function button(label, html) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "transport-button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = html;
  return b;
}

function createTransport({ value, duration = 4, onRandomize, onPlay }) {
  const root = document.createElement("div");
  root.id = "transport";
  const rewind = button("Rewind", icon("rewind"));
  const play = button("Play", icon("play"));
  const random = button("Randomize", '<img src="../assets/randomize.svg" alt="" width="20" height="20" />');
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = 0;
  scrub.max = 1;
  scrub.step = 0.001;
  scrub.setAttribute("aria-label", "Explosion");
  const readout = document.createElement("span");
  readout.className = "transport-readout";
  root.append(rewind, play, random, scrub, readout);
  document.body.append(root);

  let playing = false;
  const setPlaying = (v) => {
    playing = v;
    play.innerHTML = icon(v ? "pause" : "play");
    play.title = v ? "Pause" : "Play";
    play.setAttribute("aria-label", play.title);
  };

  rewind.addEventListener("click", () => {
    setPlaying(false);
    value.set(0);
  });
  play.addEventListener("click", () => {
    if (playing) return setPlaying(false);
    if (value() >= 1) value.set(0);
    setPlaying(true);
    onPlay?.();
  });
  random.addEventListener("click", () => onRandomize?.());
  scrub.addEventListener("input", () => {
    setPlaying(false);
    value.set(Number(scrub.value));
  });
  // Keys meant for the page (Space, R) shouldn't move the focused slider.
  scrub.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "KeyR") e.preventDefault();
  });

  // Called every frame with the page's dt (0 while paused).
  function update(dt) {
    if (playing) {
      const next = Math.min(1, value() + dt / duration);
      value.set(next);
      if (next >= 1) setPlaying(false);
    }
    const v = value();
    if (document.activeElement !== scrub || playing) scrub.value = v;
    scrub.style.setProperty("--progress", `${v * 100}%`);
    readout.textContent = `${Math.round(v * 100)}%`;
  }

  return { update, get playing() { return playing; }, setPlaying };
}

export { createTransport };
