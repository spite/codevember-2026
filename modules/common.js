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
  return btn;
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
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const prev = days.find((d) => d.day === day - 1);
  const next = days.find((d) => d.day === day + 1);
  info.innerHTML = [
    prev?.title ? link(`../${prev.day}/`, `${arrow("M13 8H3M7.5 3.5 3 8l4.5 4.5")}${prev.day}`, `Previous: ${prev.day}. ${prev.title}`) : "",
    link("../", `${event} ${year}`),
    next?.title ? link(`../${next.day}/`, `${next.day}${arrow("M3 8h10M8.5 3.5 13 8l-4.5 4.5")}`, `Next: ${next.day}. ${next.title}`) : "",
  ].join("");
  document.body.append(info);

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
  applyUrlState,
  loadSeed,
  onRandomize,
  getSeed,
  addKey,
  keysHelp,
  addActionButton,
  screenshot,
  setDay,
  ready,
  showHint,
};
