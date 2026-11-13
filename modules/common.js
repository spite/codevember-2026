import { getSeed, setSeed, newSeed, urlSeed } from "./random.js";
import {
  WebGLRenderer,
  PerspectiveCamera,
  OrthographicCamera,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  Timer,
} from "three";
import { OrbitControls } from "third_party/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { createParams, bindKey, setRandomSource } from "guspira";
import Maf from "maf";
import { days, year, event } from "./days.js";

const query = new URLSearchParams(window.location.search);

// UI stuff

// One signal per key, with guspira's $ helpers (options as in createParams).
// Every set is also mirrored in the url: the seed plus whatever differs from what that seed gives.
const paramSets = [];
const baselines = new Map();
const rerolled = new Map();

function fromDefaults(defaults, options) {
  const params = createParams(defaults, options);
  paramSets.push(params);
  baselines.set(params, { ...defaults });
  return params;
}

// Query keys the base itself uses.
const reservedKeys = new Set(["seed", "size", "w", "h", "dpr", "capture", "quality"]);
// A param named like a reserved key goes in the url with a leading underscore.
const urlKey = (k) => (reservedKeys.has(k) ? `_${k}` : k);
const sameValue = (a, b) => String(a) === String(b);

function coerceParam(raw, def) {
  if (typeof def === "number") {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof def === "boolean") return raw === "true" || raw === "1";
  if (Array.isArray(def)) {
    const v = raw.split(",").map(Number);
    return v.every(Number.isFinite) ? v : undefined;
  }
  return raw;
}

// Runs the randomize handlers and records what the seed produced. Keys the handlers have
// never changed (not randomizable) keep their default as the baseline, as a fresh load would.
function applySeedHandlers(value) {
  const before = paramSets.map((p) => p.$snapshot(p.$keys));
  for (const fn of randomizeFns) fn(value);
  paramSets.forEach((p, i) => {
    const after = p.$snapshot(p.$keys);
    if (!rerolled.has(p)) rerolled.set(p, new Set());
    const seen = rerolled.get(p);
    const base = {};
    for (const k of p.$keys) {
      if (!sameValue(after[k], before[i][k])) seen.add(k);
      base[k] = seen.has(k) ? after[k] : p.$defaults[k];
    }
    baselines.set(p, base);
  });
}

function applyUrlParams() {
  for (const p of paramSets) {
    const values = {};
    for (const k of p.$keys) {
      if (!query.has(urlKey(k))) continue;
      const v = coerceParam(query.get(urlKey(k)), p.$defaults[k]);
      if (v !== undefined) values[k] = v;
    }
    p.$apply(values);
  }
}

let seeded = !!urlSeed;
let lastUrl = "";

function writeUrl() {
  const url = new URL(window.location.href);
  if (seeded) url.searchParams.set("seed", getSeed());
  for (const p of paramSets) {
    const base = baselines.get(p);
    for (const k of p.$keys) {
      const v = p[k].target();
      if (sameValue(v, base[k])) url.searchParams.delete(urlKey(k));
      else url.searchParams.set(urlKey(k), Array.isArray(v) ? v.join(",") : String(v));
    }
  }
  const href = url.toString();
  if (href === lastUrl) return;
  lastUrl = href;
  if (href !== window.location.href) history.replaceState(null, "", href);
}

// Guspira's rerolls follow the seeded Math.random whatever order modules load in.
setRandomSource(() => Math.random());

// Rendering stuff

const defaultFov = 35;
const maxDPR = parseFloat(query.get("dpr")) || 2;
const cameras = [];
const resizeFns = [];
let pixelRatioOverride = null;

// <html data-canvas="pipeline">: only a full-screen pass draws to the canvas (the pipeline's final pass), so it needs no
// MSAA or depth of its own; the picture is the same.
const pipelineCanvas = document.documentElement.dataset.canvas === "pipeline";
const renderer = new WebGLRenderer({
  antialias: !pipelineCanvas,
  depth: !pipelineCanvas,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

let composer = null;

// ?size=N renders an exact N x N canvas at pixel ratio 1, whatever the window (for recording).
const fixedSize = parseInt(query.get("size")) || 0;

function getPixelRatio() {
  return pixelRatioOverride ?? (fixedSize ? 1 : Math.min(window.devicePixelRatio, maxDPR));
}

function getSize() {
  const w = fixedSize || parseInt(query.get("w")) || window.innerWidth;
  const h = fixedSize || parseInt(query.get("h")) || window.innerHeight;
  return { w, h };
}

function updateCamera(camera, w, h) {
  const aspect = w / h;
  if (camera.isPerspectiveCamera) {
    const fov = camera.userData.baseFov;
    camera.aspect = aspect;
    if (aspect < 1) {
      // Keep the horizontal fov of a square viewport in portrait.
      const t = Math.tan(Maf.toRadians(fov) / 2);
      camera.fov = Maf.toDegrees(2 * Math.atan(t / aspect));
    } else {
      camera.fov = fov;
    }
  }
  if (camera.isOrthographicCamera) {
    const fh = camera.userData.frustumHeight;
    camera.top = fh / 2;
    camera.bottom = -fh / 2;
    camera.left = (-fh * aspect) / 2;
    camera.right = (fh * aspect) / 2;
  }
  camera.updateProjectionMatrix();
}

function resize() {
  const { w, h } = getSize();
  const dpr = getPixelRatio();
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  if (composer) {
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
  }
  for (const camera of cameras) {
    updateCamera(camera, w, h);
  }
  for (const fn of resizeFns) {
    fn(w, h, dpr);
  }
}

window.addEventListener("resize", resize);

function watchPixelRatio() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    "change",
    () => {
      resize();
      watchPixelRatio();
    },
    { once: true },
  );
}
watchPixelRatio();

// fn(width, height, pixelRatio): size render targets at width * pixelRatio.
function onResize(fn) {
  resizeFns.push(fn);
  const { w, h } = getSize();
  fn(w, h, getPixelRatio());
}

function getCamera(fov = defaultFov, near = 0.1, far = 100) {
  const camera = new PerspectiveCamera(fov, 1, near, far);
  camera.userData.baseFov = fov;
  cameras.push(camera);
  const { w, h } = getSize();
  updateCamera(camera, w, h);
  return camera;
}

function getOrthoCamera(frustumHeight = 2, near = -100, far = 100) {
  const camera = new OrthographicCamera(-1, 1, 1, -1, near, far);
  camera.userData.frustumHeight = frustumHeight;
  cameras.push(camera);
  const { w, h } = getSize();
  updateCamera(camera, w, h);
  return camera;
}

function getComposer() {
  if (!composer) {
    composer = new EffectComposer(renderer);
    resize();
  }
  return composer;
}

resize();

const camera = getCamera();
const controls = new OrbitControls(camera, renderer.domElement);

// Pause

let running = true;
const pauseFns = [];

function isRunning() {
  return running;
}

function setRunning(v) {
  running = v;
  document.body.classList.toggle("paused", !running);
  // The button shows what a click does: Play while paused, Pause while running.
  const button = document.querySelector("#pause-button");
  const icon = button?.querySelector("img");
  if (button) button.title = running ? "Pause" : "Play";
  if (icon) {
    icon.src = icon.src.replace(/(pause|play)\.svg/, running ? "pause.svg" : "play.svg");
    icon.alt = button.title;
  }
  for (const fn of pauseFns) fn(running);
}

function pause() {
  setRunning(!running);
}

function onPause(fn) {
  pauseFns.push(fn);
}

// Randomize

const randomizeFns = [];

function onRandomize(fn) {
  randomizeFns.push(fn);
}

function randomize() {
  newSeed();
  seeded = true;
  applySeedHandlers(getSeed());
  writeUrl();
}

// Jumps to a known seed, as if the page had been loaded with ?seed=.
function loadSeed(seed) {
  setSeed(seed);
  seeded = true;
  applySeedHandlers(getSeed());
  writeUrl();
}

// Fullscreen; browsers without it (iPhone Safari) just ignore the key.
function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  else (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
}

// Keyboard

const keys = [];

// Binds through guspira's bindKey (options as there); a description lists it in keysHelp().
function addKey(code, description, fn, options) {
  keys.push({ code, description });
  return bindKey(code, fn, { preventDefault: true, ...options });
}

function keysHelp() {
  const names = { Space: "Space", Tab: "Tab" };
  return keys
    .filter((k) => k.description)
    .map(
      (k) =>
        `<p>Press ${names[k.code] ?? k.code.replace(/^Key|^Digit/, "")} to ${k.description}.</p>`,
    )
    .join("");
}

addKey("Space", "toggle animation", pause);
addKey("KeyR", "randomize", randomize);
addKey("KeyF", "toggle fullscreen", toggleFullscreen);
addKey("Tab", "toggle this GUI", () =>
  document.body.classList.toggle("hide-ui"),
);
addKey("KeyP", "save a screenshot (Shift+P for 2x)", () => screenshot(1));
addKey("KeyP", null, () => screenshot(2), { shift: true });

if (query.has("capture")) {
  document.body.classList.add("hide-ui");
}

// Loading placeholder (#loading in index.html)

const loading = document.querySelector("#loading");
if (query.has("capture")) loading?.remove();

// How to interact: showHint(desktop, touch) before the first frame; touch screens get the second text.
// {name} in a text shows the button icon assets/name.svg, e.g. "tap {randomize} for a new one".
let hintText = null;
function showHint(desktop, touch = desktop) {
  hintText = matchMedia("(pointer: coarse)").matches ? touch : desktop;
}

// A day with sound calls showSoundHint(needed) before the first frame: a second pill under the hint says a click
// or tap turns the sound on, when needed() is true then (e.g. () => !sound.running).
let soundHint = null;
function showSoundHint(needed = () => true) {
  soundHint = needed;
}

// Load progress in the placeholder's pill. Declare every step up front, so the total is known from the start:
// const step = loadingStep(weight); … step.set(0.5); … step.track(promise). The pill fills by weight.
// track(promise, seconds) creeps toward the step's end over about that long, for work that can't report
// its progress (shader compiles).
const loadingSteps = [];
let loadingShown = 0;
function loadingStep(weight = 1) {
  const step = {
    weight,
    value: 0,
    set(f) {
      step.value = Math.max(step.value, Math.min(1, f));
      showLoadingProgress();
    },
    done() {
      step.set(1);
    },
    track(promise, seconds = 0) {
      const start = performance.now();
      const creep = seconds > 0 && setInterval(() => step.set(0.9 * (1 - Math.exp((start - performance.now()) / 1000 / seconds))), 100);
      const finish = () => {
        clearInterval(creep);
        step.done();
      };
      promise.then(finish, finish);
      return promise;
    },
  };
  loadingSteps.push(step);
  showLoadingProgress();
  return step;
}

function showLoadingProgress() {
  const span = loading?.querySelector("span");
  if (!span || loading.classList.contains("hint")) return;
  const total = loadingSteps.reduce((a, s) => a + s.weight, 0);
  const value = loadingSteps.reduce((a, s) => a + s.weight * s.value, 0);
  loadingShown = Math.max(loadingShown, total > 0 ? value / total : 0);
  loading.classList.add("progress");
  span.style.setProperty("--progress", loadingShown);
}

// fetch(), with onProgress(fraction) as the body arrives. Resolves to a Response once it is all in.
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  const total = Number(res.headers.get("content-length"));
  if (!res.ok || !res.body || !total) {
    onProgress?.(1);
    return res;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded / total);
  }
  onProgress?.(1);
  return new Response(new Blob(chunks), { status: res.status, statusText: res.statusText, headers: res.headers });
}

function hideLoading() {
  if (!loading.isConnected || loading.classList.contains("done")) return;
  loading.classList.add("done");
  setTimeout(() => loading.remove(), 700);
}

// Fades the placeholder out; render() calls it after the first frame. With a hint, the backdrop fades
// while the pill resizes to the hint, which stays a few seconds or until the first interaction.
function ready() {
  if (!loading?.isConnected || loading.classList.contains("done")) return;
  const span = loading.querySelector("span");
  if (!hintText || !span) return hideLoading();
  if (soundHint?.() && !navigator.userActivation?.hasBeenActive) {
    const note = document.createElement("span");
    note.className = "sound-hint";
    const img = document.createElement("img");
    img.src = "../assets/sound.svg";
    img.alt = "";
    note.append(img, matchMedia("(pointer: coarse)").matches ? "Tap anywhere for sound" : "Click anywhere for sound");
    loading.append(note);
  }
  const from = span.getBoundingClientRect().width;
  span.style.width = `${from}px`;
  loading.classList.add("hint");
  const events = ["pointerdown", "wheel", "keydown", "touchstart"];
  const dismiss = () => {
    events.forEach((e) => removeEventListener(e, dismiss, true));
    hideLoading();
  };
  events.forEach((e) => addEventListener(e, dismiss, { capture: true, passive: true }));
  setTimeout(() => {
    span.replaceChildren(
      ...hintText.split(/\{(\w+)\}/).map((part, i) => {
        if (i % 2 === 0) return part;
        const img = document.createElement("img");
        img.src = `../assets/${part}.svg`;
        img.alt = part;
        return img;
      }),
    );
    span.style.width = "";
    const to = span.getBoundingClientRect().width;
    span.style.width = `${from}px`;
    span.getBoundingClientRect();
    span.style.width = `${to}px`;
    setTimeout(() => loading.classList.add("shown"), 350);
  }, 250);
  setTimeout(dismiss, 6000);
}

// Buttons next to the GUI

function addActionButton(icon, title, fn) {
  const btn = document.createElement("div");
  btn.className = "button action";
  btn.title = title;
  const img = document.createElement("img");
  img.src = icon;
  img.alt = title;
  btn.append(img);
  btn.addEventListener("click", fn);
  document.querySelector("#gui-container")?.before(btn);
  queueFitNav();
  return btn;
}

// While the nav would run into the header buttons, it gives way one step at a time: the explainer link
// shrinks to its icon, then prev/next go, then the explainer link, then the home button.
const NAV_STEPS = ["compact", "no-arrows", "no-explainer", "no-home"];
function fitNav() {
  const info = document.querySelector("#info");
  if (!info) return;
  info.classList.remove(...NAV_STEPS);
  const buttons = [...document.querySelectorAll("#main-gui > .button")].map((b) => b.getBoundingClientRect()).filter((r) => r.width);
  if (!buttons.length) return;
  const limit = Math.min(...buttons.map((r) => r.left)) - 6;
  for (const cls of NAV_STEPS) {
    if (info.getBoundingClientRect().right <= limit) return;
    info.classList.add(cls);
  }
}
let fitQueued = false;
function queueFitNav() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitNav();
  });
}
addEventListener("resize", queueFitNav);

// A header button that is a link, e.g. to the day's gallery.
function addActionLink(icon, title, href) {
  const link = document.createElement("a");
  link.className = "button action";
  link.href = href;
  link.title = title;
  const img = document.createElement("img");
  img.src = icon;
  img.alt = title;
  link.append(img);
  document.querySelector("#gui-container")?.before(link);
  queueFitNav();
  return link;
}

document
  .querySelector("#randomize-button")
  ?.addEventListener("click", randomize);
document.querySelector("#pause-button")?.addEventListener("click", pause);

// Page chrome

function getDay() {
  return parseInt(window.location.pathname.split("/").at(-2));
}

// Sets the page title and prev/next nav; the day defaults to the folder name.
function setDay(day = getDay()) {
  if (isNaN(day)) {
    document.title = `${event} ${year}`;
    return "Template";
  }
  const entry = days.find((d) => d.day === day);
  const title = entry ? `${day}. ${entry.prompt}` : `${day}`;
  document.title = `${event} ${year} - ${title}`;

  const info = document.createElement("nav");
  info.id = "info";
  const link = (href, text, label) =>
    `<a href="${href}"${label ? ` title="${label}" aria-label="${label}"` : ""}>${text}</a>`;
  const arrow = (d) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${d}" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const grid = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="2.5" y="2.5" width="4.75" height="4.75" rx="0.75"/><rect x="8.75" y="2.5" width="4.75" height="4.75" rx="0.75"/><rect x="2.5" y="8.75" width="4.75" height="4.75" rx="0.75"/><rect x="8.75" y="8.75" width="4.75" height="4.75" rx="0.75"/></svg>`;
  const book = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 4.2C6.8 3.3 5.2 2.9 2.8 2.9v9.3c2.4 0 4 .4 5.2 1.3 1.2-.9 2.8-1.3 5.2-1.3V2.9c-2.4 0-4 .4-5.2 1.3zM8 4.2v9.3"/></svg>`;
  const prev = days.find((d) => d.day === day - 1);
  const next = days.find((d) => d.day === day + 1);
  info.innerHTML = [
    prev?.title ? link(`../${prev.day}/`, `${arrow("M11 3.5v9L4.5 8z")}<span>${prev.day}</span>`, `Previous: ${prev.day}. ${prev.title}`) : "",
    `<a class="home" href="../">${grid}<span>[vibe-]Codevember ${year}</span></a>`,
    next?.title ? link(`../${next.day}/`, `<span>${next.day}</span>${arrow("M5 3.5v9L11.5 8z")}`, `Next: ${next.day}. ${next.title}`) : "",
    // Published days have an explainer.
    entry?.title ? `<a class="explainer" href="explainer.html" title="How ${entry.prompt} works">${book}<span>How it works</span></a>` : "",
  ].join("");
  document.body.append(info);
  queueFitNav();

  return title;
}

// Render loop

const timer = new Timer();
timer.connect(document);
let time = 0;
let frame = 0;
let frameFn = null;

// A ?seed= url replays the randomize handlers so it reproduces the result.
// Then any params in the url go on top, so a copied link reproduces edits made after randomizing.
// render() does this on its first frame; a day that builds from its params before rendering can call
// it earlier (after registering its randomize handlers), so it never builds the defaults first.
let urlStateApplied = false;
function applyUrlState() {
  if (urlStateApplied) return;
  urlStateApplied = true;
  if (urlSeed) {
    setSeed(urlSeed);
    applySeedHandlers(urlSeed);
  }
  applyUrlParams();
}

// fn({ time, dt, frame }) is called every frame; time and dt stop while paused.
function render(fn) {
  if (frame === 0) applyUrlState();
  frameFn = fn;
  renderer.setAnimationLoop((timestamp) => {
    timer.update(timestamp);
    const dt = running ? Maf.clamp(timer.getDelta(), 0, 0.1) : 0;
    time += dt;
    fn({ time, dt, frame });
    if (frame === 0) ready();
    // Cheap enough to check twice a second; GUI edits show up in the url without hooks per param.
    if (frame % 30 === 0) writeUrl();
    frame++;
  });
  return () => renderer.setAnimationLoop(null);
}

function screenshot(scale = 1) {
  pixelRatioOverride = getPixelRatio() * scale;
  resize();
  frameFn?.({ time, dt: 0, frame });
  const canvas = renderer.domElement;
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    const day = getDay() || "template";
    a.download = `${event.toLowerCase()}-${year}-${day}-${getSeed()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
  pixelRatioOverride = null;
  resize();
}

export {
  Maf,
  fromDefaults,
  getCamera,
  getOrthoCamera,
  getComposer,
  onResize,
  renderer,
  camera,
  controls,
  render,
  running,
  isRunning,
  setRunning,
  pause,
  onPause,
  randomize,
  loadingStep,
  fetchWithProgress,
  showSoundHint,
  applyUrlState,
  loadSeed,
  onRandomize,
  getSeed,
  addKey,
  keysHelp,
  addActionButton,
  addActionLink,
  screenshot,
  setDay,
  ready,
  showHint,
};
