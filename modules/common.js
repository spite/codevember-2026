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

const renderer = new WebGLRenderer({
  antialias: true,
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

// Fades the placeholder out; render() calls it after the first frame.
function ready() {
  if (!loading?.isConnected || loading.classList.contains("done")) return;
  loading.classList.add("done");
  setTimeout(() => loading.remove(), 700);
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
  const title = entry?.title ? `${day}. ${entry.title}` : `${day}`;
  document.title = `${event} ${year} - ${title}`;

  const info = document.createElement("nav");
  info.id = "info";
  const link = (href, text) => `<a href="${href}">${text}</a>`;
  info.innerHTML = [
    day > 1 ? link(`../${day - 1}/`, "&larr;") : "",
    link("../", `${event} ${year}`),
    days.find((d) => d.day === day + 1)?.title
      ? link(`../${day + 1}/`, "&rarr;")
      : "",
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

// fn({ time, dt, frame }) is called every frame; time and dt stop while paused.
function render(fn) {
  // A ?seed= url replays the randomize handlers so it reproduces the result.
  // Then any params in the url go on top, so a copied link reproduces edits made after randomizing.
  if (frame === 0) {
    if (urlSeed) {
      setSeed(urlSeed);
      applySeedHandlers(urlSeed);
    }
    applyUrlParams();
  }
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
  loadSeed,
  onRandomize,
  getSeed,
  addKey,
  keysHelp,
  addActionButton,
  screenshot,
  setDay,
  ready,
};
