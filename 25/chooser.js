// The start screen: how to play (your camera, or the mouse or touch), then that mode's instructions. The skull keeps
// moving behind it. open() shows it again to change mode. Adapted from day 22's.

const css = `
.veil-chooser { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.35); font-family: "Segoe UI", sans-serif; color: rgb(232, 228, 222);
  transition: opacity 0.4s; }
.veil-chooser.hidden { opacity: 0; pointer-events: none; }
.veil-card { width: min(440px, 100%); background: rgba(16, 15, 16, 0.86); border: 1px solid rgba(255, 235, 225, 0.12);
  border-radius: 14px; padding: 22px 22px 18px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px); }
.veil-card h2 { margin: 0 0 4px; font-size: 19px; font-weight: 600; letter-spacing: 0.01em; display: flex; align-items: center; gap: 10px; }
.veil-card p.sub { margin: 0 0 16px; font-size: 13px; opacity: 0.6; }
.veil-card .icon { width: 32px; height: 32px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; }
.veil-card h2 .icon { color: rgb(230, 120, 110); }
.veil-card button.choice { display: flex; gap: 14px; align-items: flex-start; width: 100%; text-align: left; margin: 0 0 10px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid rgba(255, 235, 225, 0.14); background: rgba(255, 240, 235, 0.05); color: inherit; font: inherit; cursor: pointer; }
.veil-card button.choice:hover, .veil-card button.choice:focus-visible { background: rgba(255, 200, 190, 0.12); border-color: rgba(255, 190, 180, 0.4); outline: none; }
.veil-card button.choice .icon { margin-top: 3px; color: rgb(230, 120, 110); }
.veil-card button.choice b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.veil-card button.choice span { font-size: 13px; opacity: 0.65; }
.veil-card ul { margin: 0 0 16px; padding: 0; list-style: none; font-size: 14px; line-height: 1.45; }
.veil-card li { display: flex; gap: 11px; align-items: flex-start; margin: 0 0 9px; }
.veil-card li .icon { width: 24px; height: 24px; margin-top: -1px; opacity: 0.75; }
.veil-card .note { font-size: 13px; color: rgb(255, 170, 140); margin: -6px 0 12px; }
.veil-card .waiting { text-align: center; padding: 6px 0 2px; }
.veil-card .waiting .icon { width: 40px; height: 40px; color: rgb(230, 120, 110); animation: veil-pulse 1.6s ease-in-out infinite; }
.veil-card .waiting h2 { justify-content: center; margin-top: 8px; }
.veil-card .waiting .sub { margin-bottom: 14px; }
.veil-card button.instead { border: 0; background: none; color: inherit; font: inherit; font-size: 13px; opacity: 0.7;
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 4px 8px; }
.veil-card button.instead:hover, .veil-card button.instead:focus-visible { opacity: 1; outline: none; }
@keyframes veil-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.veil-card button.go { padding: 9px 22px; border-radius: 999px; border: 0; background: rgb(232, 222, 214); color: rgb(20, 16, 14);
  font: inherit; font-weight: 600; cursor: pointer; }
`;

// Line icons, drawn on a 24-unit grid in the text colour.
const ICONS = {
  camera: '<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 3v6"/>',
  tap: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.6 15.5a1.5 1.5 0 0 1 2.4-1.8L9 16"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  turn: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  lean: '<path d="M12 5v14M8 9l4-4 4 4M8 15l4 4 4-4"/>',
  jaw: '<path d="M5 9c0-3 3-5 7-5s7 2 7 5v2H5z"/><path d="M6 14h12l-1 4c-.4 1.3-2 2-5 2s-4.6-.7-5-2z"/>',
  frown: '<circle cx="12" cy="12" r="9"/><path d="M8 16c1-1.5 2.4-2 4-2s3 .5 4 2M7.5 9l2.5 1M16.5 9l-2.5 1"/>',
  change: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  orbit: '<ellipse cx="12" cy="12" rx="9" ry="4"/><circle cx="12" cy="12" r="2"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const CHOICES = [
  { mode: "camera", icon: "camera", title: "Use my camera", text: "The skull follows your face: turn, lean in, open your jaw. Frown and its eyes light up. Nothing leaves your device." },
  { mode: "mouse", icon: "mouse", touchIcon: "tap", title: "Use the mouse", touchTitle: "Use touch", text: "No camera: the skull turns to follow the pointer.", touchText: "No camera: the skull turns to follow your finger." },
];

// Each line: [icon, text].
function instructions(mode, touch) {
  const veil = ["change", touch ? "Tap the dice for a new veil" : "R for a new veil · D drops it again"];
  const change = ["camera", touch ? "Tap the camera button to change how you play" : "C to change how you play"];
  if (mode === "camera") return [["turn", "Turn and tilt your head; lean in and back"], ["jaw", "Open your jaw, push it sideways"], ["frown", "Frown and the eyes light up"], veil, change];
  return touch
    ? [["tap", "Drag to turn the head"], ["jaw", "Hold to open the jaw; hold on and the eyes light up"], veil, change]
    : [["mouse", "Move the mouse to turn the head"], ["jaw", "Hold the button to open the jaw; hold on and the eyes light up"], ["orbit", "Scroll to zoom"], veil, change];
}

// status() (optional) tells how the camera is getting on: "asking" or "loading".
export function createChooser({ touch = false, onChoose, status }) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const root = document.createElement("div");
  root.className = "veil-chooser hidden";
  const card = document.createElement("div");
  card.className = "veil-card";
  root.append(card);
  document.body.append(root);
  // Clicks on the card stay off the scene.
  for (const type of ["pointerdown", "pointerup", "click", "wheel"]) root.addEventListener(type, (e) => e.stopPropagation());

  let hideTimer = 0;
  const hide = () => {
    clearTimeout(hideTimer);
    root.classList.add("hidden");
  };

  function showChoices() {
    card.innerHTML = `<h2>How do you want to play?</h2><p class="sub">A skull under a veil, moving as you do.</p>`;
    for (const c of CHOICES) {
      const b = document.createElement("button");
      b.className = "choice";
      b.innerHTML = `${icon((touch && c.touchIcon) || c.icon)}<div><b></b><span></span></div>`;
      b.querySelector("b").textContent = (touch && c.touchTitle) || c.title;
      b.querySelector("span").textContent = (touch && c.touchText) || c.text;
      b.addEventListener("click", () => choose(c.mode));
      card.append(b);
    }
  }

  let pending = 0;
  async function choose(mode) {
    const ticket = ++pending;
    card.innerHTML = `<h2>…</h2>`;
    // While the camera starts: what it's waiting for, and (the prompt can be left unanswered) a way out meanwhile.
    let poll = 0;
    if (mode === "camera") {
      card.innerHTML = `<div class="waiting">${icon("camera")}<h2></h2><p class="sub"></p><button class="instead"></button></div>`;
      const title = card.querySelector("h2");
      const sub = card.querySelector(".sub");
      // Already allowed (the browser remembers), there's no prompt to point at.
      let granted = false;
      navigator.permissions?.query({ name: "camera" }).then((p) => (granted = p.state === "granted"), () => {});
      const show = () => {
        const loading = status?.() === "loading";
        title.textContent = loading ? "Loading the face tracker…" : granted ? "Starting the camera…" : "Waiting for the camera…";
        sub.textContent = loading ? "Almost there." : granted ? "The video stays on your device." : "Allow it in your browser's prompt. The video stays on your device.";
      };
      show();
      poll = setInterval(show, 200);
      const alt = card.querySelector("button.instead");
      alt.textContent = touch ? "Use touch instead" : "Use the mouse instead";
      alt.addEventListener("click", () => choose("mouse"));
    }
    const { mode: got, note } = await onChoose(mode);
    clearInterval(poll);
    if (ticket !== pending) return;
    const c = CHOICES.find((x) => x.mode === got);
    card.innerHTML = `<h2>${icon((touch && c.touchIcon) || c.icon)}<span></span></h2><p class="sub">How it works</p>`;
    card.querySelector("h2 span").textContent = (touch && c.touchTitle) || c.title;
    if (note) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = note;
      card.append(n);
    }
    const ul = document.createElement("ul");
    for (const [name, text] of instructions(got, touch)) {
      const li = document.createElement("li");
      li.innerHTML = `${icon(name)}<span></span>`;
      li.querySelector("span").textContent = text;
      ul.append(li);
    }
    const go = document.createElement("button");
    go.className = "go";
    go.textContent = "Start";
    go.addEventListener("click", hide);
    card.append(ul, go);
    go.focus();
    hideTimer = setTimeout(hide, 15000);
  }

  return {
    open() {
      clearTimeout(hideTimer);
      showChoices();
      root.classList.remove("hidden");
    },
    hide,
    get visible() {
      return !root.classList.contains("hidden");
    },
  };
}
