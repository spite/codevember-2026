// The start screen: how to play (with your voice, by clicking, or just watching), then that mode's
// instructions. The scene keeps strolling behind it. open() shows it again to change mode.

const css = `
.echo-chooser { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.35); font-family: "Segoe UI", sans-serif; color: rgb(236, 232, 220);
  transition: opacity 0.4s; }
.echo-chooser.hidden { opacity: 0; pointer-events: none; }
.echo-card { width: min(440px, 100%); background: rgba(18, 17, 14, 0.86); border: 1px solid rgba(255, 240, 200, 0.12);
  border-radius: 14px; padding: 22px 22px 18px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px); }
.echo-card h2 { margin: 0 0 4px; font-size: 19px; font-weight: 600; letter-spacing: 0.01em; }
.echo-card p.sub { margin: 0 0 16px; font-size: 13px; opacity: 0.6; }
.echo-card .icon { width: 32px; height: 32px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; }
.echo-card h2 { display: flex; align-items: center; gap: 10px; }
.echo-card h2 .icon { width: 32px; height: 32px; color: rgb(236, 210, 140); }
.echo-card button.choice { display: flex; gap: 14px; align-items: flex-start; width: 100%; text-align: left; margin: 0 0 10px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid rgba(255, 240, 200, 0.14); background: rgba(255, 245, 215, 0.05); color: inherit; font: inherit; cursor: pointer; }
.echo-card button.choice:hover, .echo-card button.choice:focus-visible { background: rgba(255, 235, 170, 0.13); border-color: rgba(255, 235, 170, 0.4); outline: none; }
.echo-card button.choice .icon { margin-top: 3px; color: rgb(236, 210, 140); }
.echo-card button.choice b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.echo-card button.choice span { font-size: 13px; opacity: 0.65; }
.echo-card ul { margin: 0 0 16px; padding: 0; list-style: none; font-size: 14px; line-height: 1.45; }
.echo-card li { display: flex; gap: 11px; align-items: flex-start; margin: 0 0 9px; }
.echo-card li .icon { width: 24px; height: 24px; margin-top: -1px; opacity: 0.75; }
.echo-card .note { font-size: 13px; color: rgb(255, 170, 120); margin: -6px 0 12px; }
.echo-card button.go { padding: 9px 22px; border-radius: 999px; border: 0; background: rgb(236, 226, 190); color: rgb(20, 18, 12);
  font: inherit; font-weight: 600; cursor: pointer; }
`;

// Line icons, drawn on a 24-unit grid in the text colour.
const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  click: '<path d="M10 9l9 3.5-3.8 1.4L13.8 18z"/><path d="M5.5 3.5l1.4 2M3 8h2.5M9 2.5V5"/>',
  tap: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.6 15.5a1.5 1.5 0 0 1 2.4-1.8L9 16"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  keys: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  drag: '<path d="M12 3v6M9.5 5.5L12 3l2.5 2.5M12 21v-6M9.5 18.5L12 21l2.5-2.5M3 12h6M5.5 9.5L3 12l2.5 2.5M21 12h-6M18.5 9.5L21 12l-2.5 2.5"/>',
  meter: '<path d="M4 19v-3M8 19v-6M12 19v-9M16 19v-6M20 19v-3"/>',
  change: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2.5-6 2.5 2v4M8.5 11.5l2.5-3.5 3 1.5 2 3M12.5 15l-1-4"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const CHOICES = [
  { mode: "mic", icon: "mic", title: "With my voice", text: "Say hello, shout or clap: every sound you make sends an echo. Uses the microphone; wear headphones, or the echoes from your speakers can feed back into it." },
  { mode: "click", icon: "click", touchIcon: "tap", title: "Click to shout", touchTitle: "Tap to shout", text: "No microphone: you call out with a click.", touchText: "No microphone: you call out with a tap." },
  { mode: "watch", icon: "eye", title: "Just watch", text: "Sit back: it finds its own way through the back rooms, calling out as it goes." },
];

// Each line: [icon, text].
function instructions(mode, touch) {
  const look = touch ? ["drag", "Drag to look around · hold to walk"] : ["keys", "WASD or the arrow keys to walk · the first click grabs the mouse to look around, Esc lets go"];
  const tired = ["meter", "Your voice tires: let it rest when the VOICE meter runs low"];
  const change = ["change", touch ? "Tap the mic button to change how you play" : "V to change how you play"];
  if (mode === "mic") return [["mic", "Say hello, shout or clap to send an echo; louder carries further"], ["headphones", "Use headphones: through speakers, your echoes reach the mic again and can feed back"], look, change];
  if (mode === "click") return [[touch ? "tap" : "click", touch ? "Tap to shout" : "Click to shout"], look, tired, change];
  return [["walk", "Relax: it walks, stops at forks to listen, and calls out on its own"], ["change", touch ? "Tap the mic button to take over" : "V to take over"]];
}

export function createChooser({ touch = false, onChoose, onPick }) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const root = document.createElement("div");
  root.className = "echo-chooser hidden";
  const card = document.createElement("div");
  card.className = "echo-card";
  root.append(card);
  document.body.append(root);
  // Clicks and keys on the card stay off the scene.
  for (const type of ["pointerdown", "pointerup", "click", "wheel"]) root.addEventListener(type, (e) => e.stopPropagation());

  let hideTimer = 0;
  const hide = () => {
    clearTimeout(hideTimer);
    root.classList.add("hidden");
  };

  function showChoices(title = "How do you want to explore?", sub = "You can only see what your echoes reach.") {
    card.innerHTML = `<h2></h2><p class="sub"></p>`;
    card.querySelector("h2").textContent = title;
    card.querySelector(".sub").textContent = sub;
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
    // Still inside the click: what needs a user gesture (fullscreen) happens here.
    onPick?.(mode);
    const ticket = ++pending;
    card.innerHTML = `<h2>${mode === "mic" ? "Allow the microphone…" : "…"}</h2>`;
    // The permission prompt can be left unanswered: offer a way out meanwhile.
    if (mode === "mic") {
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = "Your browser is asking to use it.";
      const alt = document.createElement("button");
      alt.className = "choice";
      alt.innerHTML = `${icon(touch ? "tap" : "click")}<div><b></b></div>`;
      alt.querySelector("b").textContent = touch ? "Tap to shout instead" : "Click to shout instead";
      alt.addEventListener("click", () => choose("click"));
      card.append(p, alt);
    }
    const { mode: got, note } = await onChoose(mode);
    if (ticket !== pending) return;
    const title = CHOICES.find((c) => c.mode === got);
    card.innerHTML = `<h2>${icon((touch && title.touchIcon) || title.icon)}<span></span></h2><p class="sub">How it works</p>`;
    card.querySelector("h2 span").textContent = (touch && title.touchTitle) || title.title;
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
    go.textContent = got === "watch" ? "Watch" : "Start";
    go.addEventListener("click", hide);
    card.append(ul, go);
    go.focus();
    hideTimer = setTimeout(hide, 15000);
  }

  return {
    // title, sub: in place of the usual heading (e.g. when the tape has run out).
    open(title, sub) {
      clearTimeout(hideTimer);
      showChoices(title, sub);
      root.classList.remove("hidden");
    },
    hide,
    get visible() {
      return !root.classList.contains("hidden");
    },
  };
}
