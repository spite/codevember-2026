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
.echo-card button.choice { display: block; width: 100%; text-align: left; margin: 0 0 10px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid rgba(255, 240, 200, 0.14); background: rgba(255, 245, 215, 0.05); color: inherit; font: inherit; cursor: pointer; }
.echo-card button.choice:hover, .echo-card button.choice:focus-visible { background: rgba(255, 235, 170, 0.13); border-color: rgba(255, 235, 170, 0.4); outline: none; }
.echo-card button.choice b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.echo-card button.choice span { font-size: 13px; opacity: 0.65; }
.echo-card ul { margin: 0 0 16px; padding-left: 18px; font-size: 14px; line-height: 1.55; }
.echo-card .note { font-size: 13px; color: rgb(255, 170, 120); margin: -6px 0 12px; }
.echo-card button.go { padding: 9px 22px; border-radius: 999px; border: 0; background: rgb(236, 226, 190); color: rgb(20, 18, 12);
  font: inherit; font-weight: 600; cursor: pointer; }
`;

const CHOICES = [
  { mode: "mic", title: "With my voice", text: "Say hello, shout or clap: every sound you make sends an echo. Uses the microphone; wear headphones, or the echoes from your speakers can feed back into it." },
  { mode: "click", title: "Click to shout", touchTitle: "Tap to shout", text: "No microphone: you call out with a click.", touchText: "No microphone: you call out with a tap." },
  { mode: "watch", title: "Just watch", text: "Sit back: it finds its own way through the back rooms, calling out as it goes." },
];

function instructions(mode, touch) {
  const look = touch ? "Drag to look around · hold to walk" : "WASD or the arrow keys to walk · the first click grabs the mouse to look around, Esc lets go";
  const tired = "Your voice tires: let it rest when the VOICE meter runs low";
  const change = touch ? "Tap the mic button to change how you play" : "V to change how you play";
  if (mode === "mic") return ["Say hello, shout or clap to send an echo; louder carries further", "Use headphones: through speakers, your echoes reach the mic again and can feed back", look, change];
  if (mode === "click") return [touch ? "Tap to shout" : "Click to shout", look, tired, change];
  return ["Relax: it walks, stops at forks to listen, and calls out on its own", touch ? "Tap the mic button to take over" : "V to take over"];
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
      b.innerHTML = `<b></b><span></span>`;
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
      alt.innerHTML = `<b></b>`;
      alt.querySelector("b").textContent = touch ? "Tap to shout instead" : "Click to shout instead";
      alt.addEventListener("click", () => choose("click"));
      card.append(p, alt);
    }
    const { mode: got, note } = await onChoose(mode);
    if (ticket !== pending) return;
    const title = CHOICES.find((c) => c.mode === got);
    card.innerHTML = `<h2></h2><p class="sub">How it works</p>`;
    card.querySelector("h2").textContent = (touch && title.touchTitle) || title.title;
    if (note) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = note;
      card.append(n);
    }
    const ul = document.createElement("ul");
    for (const line of instructions(got, touch)) {
      const li = document.createElement("li");
      li.textContent = line;
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
