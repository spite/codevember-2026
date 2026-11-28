import { fromDefaults, renderer, camera, controls as sharedControls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, loadingStep, addKey, setRunning, isRunning, getSeed, loadSeed, randomize, addActionButton, onPause, showSoundHint } from "common";
import { createSound } from "./sound.js";
import { GUI, signal } from "guspira";
import { Scene, Vector3, Vector2, Color, Matrix4, Matrix3, Raycaster, WebGLRenderTarget, HalfFloatType, RawShaderMaterial, GLSL3, BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera, Quaternion } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { createAutoChange } from "modules/autoChange.js";
import { OrbitControls as FreeOrbitControls } from "modules/FreeOrbitControls.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { setSeed, seededRandom, nativeRandom } from "modules/random.js";
import { createSpores, MAX_SPORES } from "./spores.js";
import { createAtmosphere } from "./atmosphere.js";

const BACKGROUND = "#1e2226";

// The query this page was opened with: a view link replays from it (see viewLink).
const query = new URLSearchParams(location.search);
const LINK_KEYS = ["step", "ev", "cam", "turn", "paused", "build"];
const MAX_REPLAY = 36000;
// Yields to the browser without setTimeout's throttling in a background tab.
const yieldChannel = new MessageChannel();
const yieldNow = () => new Promise((resolve) => {
  yieldChannel.port1.onmessage = () => resolve();
  yieldChannel.port2.postMessage(0);
});
const replaySteps = Math.min(MAX_REPLAY, Math.max(0, Math.round(Number(query.get("step")) || 0)));
// The seed the page started from (a link from a page opened without ?seed= carries it as origin). The stream restarts
// here, so the build depends only on the seed, not on what modules drew while loading.
const startSeed = query.get("seed") ? getSeed() : (query.get("origin") ?? getSeed());
setSeed(startSeed);
// The simulation's own events (pulses, bursts, buds) draw from a stream of their own, restarted with every seed, so
// nothing else drawing from Math.random can shift them.
let simRandom = seededRandom(`sim:${startSeed}`);

// Crust light, crust deep, and the dark grains under it.
const PALETTES = {
  pollen: ["#ffc414", "#ee8204", "#0c0b0a"],
  saffron: ["#ffcf3a", "#f08a12", "#1a1410"],
  rust: ["#e0601f", "#a3300f", "#120e0d"],
  lichen: ["#c9dc4c", "#6f8f18", "#0d100c"],
  coral: ["#ff8a72", "#e04062", "#140d0f"],
  frost: ["#eef1f3", "#9fb2c2", "#0b0c0f"],
  ultraviolet: ["#b896ff", "#5e36d0", "#0c0a10"],
  verdigris: ["#62d3b4", "#1d8a7c", "#0b0f0f"],
};

const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 0.95,
  bloomStrength: 0.025,
  bloomRadius: 0.85,
  vignette: 0.35,
  grain: 0.025,
  saturation: 1.45,
  contrast: 1.08,
  shadow: { autoFit: true, denoise: true },
  // Spores hide most of each other: depth first, so each pixel is shaded once.
  depthPrepass: true,
  // Blurred from the prepass's per-spore motion (the simulation knows where every spore was last frame).
  // Off by default (it costs a full-screen pass); the Motion blur slider turns it on.
  motionBlur: { enabled: false, shutter: 1 / 60, samples: 16, maxBlur: 0.015, reusePrepass: true },
  composite: (hdr, opts) => atmosphere.render(glow.render(hdr, opts), opts),
  // Focus on the near side of the colony: live frames gather the blur, still ones average views across the lens.
  // Enough lens samples that wide blur melts into bokeh instead of showing the copies (only rendered while still).
  depthOfField: { aperture: 0, maxBlur: 0.02, lensSamples: 128, holdLive: true },
  // The dust draws its own out-of-focus discs, after the depth of field so they aren't blurred twice.
  afterFocus: (hdr, opts) => atmosphere.renderDust(hdr, opts),
});

// Phones settle a still sooner, with fewer lens samples.
pipeline.lensSamples = { capture: 256, high: 128, medium: 64, low: 48 }[pipeline.quality] ?? 128;
const COUNTS = { capture: 240000, high: 160000, medium: 90000, low: 50000 };
const defaults = {
  spores: COUNTS[pipeline.quality] ?? 120000,
  size: 1,
  palette: "pollen",
  crust: 0.45,
  flow: 0.7,
  turbulence: 1,
  scale: 1,
  cohesion: 1,
  bonds: 1,
  pressure: 1,
  drag: 1,
  disrupt: 1,
  tear: 0.5,
  puff: 1,
  breathe: 0.5,
  collisions: 1,
  sporulation: 1,
  budding: 1,
  halo: 0.3,
  translucency: 0.5,
  detail: 0.6,
  look: "studio",
  beam: 1,
  haze: 0.5,
  dust: 1,
  blur: 0,
  focusBlur: 0.5,
  focus: -0.35,
  cameraSpeed: 1,
  spin: 0.12,
  speed: 1,
  pace: 0.5,
  colonies: 1,
  wildness: 0.5,
  sorting: 0.6,
  auto: true,
  autoTime: 10,
};
const params = fromDefaults(defaults);

// What a view link replays: each randomize ("#", seed) and panel change (key, value), at the simulation step it came
// before. A link's own events carry over, so a link made from a link keeps them.
const RECORDED = Object.keys(defaults).filter((k) => k !== "auto" && k !== "autoTime");
const events = (() => {
  try {
    const ev = JSON.parse(query.get("ev") ?? "[]");
    return Array.isArray(ev) ? ev.filter((e) => Array.isArray(e) && e.length === 3 && e[0] <= replaySteps) : [];
  } catch {
    return [];
  }
})();
let recording = false;
// Bigger changes take longer: the physics springs slow down with how far the wildness jumped (set on each new colony).
let springSlow = 1;
let nextLookPending = false;
const recorded = {};
function snapshotParams() {
  for (const k of RECORDED) recorded[k] = params[k]();
}
function record(key, value) {
  events.push([simSteps, key, value]);
  snapshotParams();
}
function recordEdits() {
  for (const k of RECORDED) if (params[k]() !== recorded[k]) events.push([simSteps, k, (recorded[k] = params[k]())]);
}
const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  compile: loadingStep(4, "Compiling shaders…"),
  sound: loadingStep(2, "Loading sound…"),
  ...(replaySteps ? { replay: loadingStep(4, "Replaying the colony…") } : {}),
};

// A dark set: a warm key high on the left, a little fill, almost nothing bouncing back.
const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, { keyDirection: new Vector3(-0.68, 0.7, 0.1), keyIntensity: 12, keySize: 0.55, fill: 0.4, fillColor: 0xe8eeff, tint: 0xfff5ec, floor: 0.03, wall: 0.025 }),
);

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
// The panel, by what each setting does. Randomizing draws the palette, crust, wildness (which sets the physics),
// colonies and sorting from the seed alone, so a seed always gives the same colony.
// Look: the colony's colours and its grains.
gui.addSection("Look");
gui.addSelect("Palette", params.palette, Object.keys(PALETTES)).randomize = () => {
  const weights = { pollen: 4, saffron: 2, rust: 2, lichen: 1.5, coral: 1.5, frost: 1, ultraviolet: 1, verdigris: 1 };
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b);
  for (const [k, w] of Object.entries(weights)) if ((r -= w) < 0) return params.palette.set(k);
};
gui.addSlider("Crust", params.crust, 0, 1, 0.01).randomize = () => params.crust.set(round(0.4 + 0.3 * Math.random()));
gui.addSlider("Translucency", params.translucency, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Detail", params.detail, 0, 1, 0.01, { randomizable: false });
// Studio: the colony in colour under a warm key. Microscope: an electron micrograph (grey, edge-lit, ornamented spores,
// shallow focus, a scale bar). Hidden for now (params.look stays studio).
// gui.addSegmented("Look", params.look, ["studio", "microscope"], { randomizable: false });

// Colony: what it is. Wildness sets its physics in one go: calm (a slow, rounded blob that barely pulses) through the
// usual colony to wild (a strong, coarse current against weak cohesion and pressure, held by tough bonds, so the mass
// stretches out into arms, pulsing, budding and bursting more). Randomizing alternates a calmer and a wilder colony;
// on each side, most land near the middle and few at the extremes.
gui.addSection("Colony");
const WILD = {
  calm: { turbulence: 0.6, scale: 1.3, cohesion: 1.4, pressure: 1.2, bonds: 1, tear: 0.6, flow: 0.45, breathe: 0.2, sporulation: 0.4, budding: 0.4 },
  usual: { turbulence: 1.3, scale: 0.95, cohesion: 0.9, pressure: 0.9, bonds: 1.2, tear: 0.4, flow: 0.75, breathe: 0.45, sporulation: 1, budding: 1 },
  wild: { turbulence: 2.05, scale: 0.76, cohesion: 0.6, pressure: 0.68, bonds: 1.55, tear: 0.25, flow: 1, breathe: 0.56, sporulation: 1.45, budding: 1.4 },
};
function applyWildness(w, randomized) {
  const [a, b, t] = w < 0.5 ? [WILD.calm, WILD.usual, w * 2] : [WILD.usual, WILD.wild, w * 2 - 1];
  for (const k of Object.keys(a)) {
    const v = a[k] + (b[k] - a[k]) * t;
    params[k].set(round(randomized ? v * (1 + (Math.random() * 2 - 1) * 0.08) : v));
  }
}
function randomWildness() {
  // Either side of the middle, leaning toward it, so the extremes are rare.
  const wild = Math.random() < 0.5;
  const d = 0.1 + 0.4 * Math.pow(Math.random(), 2);
  return round(wild ? 0.5 + d : 0.5 - d);
}
gui.addSlider("Wildness", params.wildness, 0, 1, 0.01, { onChange: (v) => applyWildness(v, false) }).randomize = () => params.wildness.set(randomWildness());
// One, or two or three that drift apart, meet, merge and split again.
gui.addSlider("Colonies", params.colonies, 1, 3, 1).randomize = () => params.colonies.set(Math.random() < 0.45 ? 1 : Math.random() < 0.6 ? 2 : 3);
// How much spores drift toward their own colour: 0 lets the stirring mix them freely, higher gathers the colours into
// patches and streams (never fully apart).
gui.addSlider("Sorting", params.sorting, 0, 2, 0.01).randomize = () => params.sorting.set(round(0.3 + 0.7 * Math.random()));
gui.addSlider("Spores", params.spores, 10000, MAX_SPORES, 1000, { randomizable: false });
gui.addSlider("Size", params.size, 0.5, 2, 0.01, { randomizable: false });

// Motion: the clocks, and the current that folds the mass.
gui.addSection("Motion");
// How fast the physics runs, and so anything done to the colony.
gui.addSlider("Speed", params.speed, 0.1, 2, 0.01, { randomizable: false });
// How fast the colony's own life runs (current, pulses, buds, bursts, colonies circling).
gui.addSlider("Pace", params.pace, 0.05, 1, 0.01, { randomizable: false });
// How fast the current changes, how hard it stirs, and how big its swirls are.
gui.addSlider("Flow", params.flow, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Turbulence", params.turbulence, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Scale", params.scale, 0.4, 2.5, 0.01, { randomizable: false });

// Body: what holds the mass together (goo), the bead clumps (bonds) and how easily they tear (their bonds snap when
// stretched, and grow back when the pieces meet again), what stops it packing (pressure, collisions), and how thick the
// medium it floats in is (drag).
gui.addSection("Body");
gui.addSlider("Cohesion", params.cohesion, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Bonds", params.bonds, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Tear", params.tear, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Pressure", params.pressure, 0.2, 3, 0.01, { randomizable: false });
gui.addSlider("Collisions", params.collisions, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Drag", params.drag, 0.1, 3, 0.01, { randomizable: false });

// Life: how strongly the colony swells in sudden, irregular pulses; how often a patch of ripe crust bursts in a puff of
// spores (they grow back beside clump-mates); how often it buds (a lobe swells, pinches off, floats away and comes back).
gui.addSection("Life");
gui.addSlider("Pulse", params.breathe, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Sporulation", params.sporulation, 0, 4, 0.01, { randomizable: false });
gui.addSlider("Budding", params.budding, 0, 3, 0.01, { randomizable: false });

// Touch: how hard hovering stirs the spores, and how hard a click blows a puff of them out.
gui.addSection("Touch");
gui.addSlider("Disrupt", params.disrupt, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Puff", params.puff, 0, 3, 0.01, { randomizable: false });

// Light & air: a warm halo behind the colony, a beam of the key light through the haze (the colony casts shafts in it),
// and dust hanging in the air.
gui.addSection("Light & air");
gui.addSlider("Halo", params.halo, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Beam", params.beam, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Haze", params.haze, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Dust", params.dust, 0, 3, 0.01, { randomizable: false });

// Camera: depth of field and where it focuses, how fast the idle camera orbits, reframes and pulls focus, motion blur
// (the shutter as a fraction of the frame; 0.5 is a film camera's 180 degrees), and the colony's spin.
gui.addSection("Camera");
gui.addSlider("Depth of field", params.focusBlur, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Focus", params.focus, -1, 1, 0.01, { randomizable: false });
gui.addSlider("Camera speed", params.cameraSpeed, 0.2, 3, 0.01, { randomizable: false });
gui.addSlider("Motion blur", params.blur, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });

gui.addSection("Auto change");
// Auto change counts toward the next colony only once the last change has mostly settled.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => changeSettled() });
function changeSettled() {
  if (params.colonies() !== colonyMix.shown) return false;
  for (const key of SPRING_KEYS) if (Math.abs(params[key]() - eased[key]) > 0.12 * Math.max(0.3, Math.abs(params[key]()))) return false;
  return spores.simUniforms.offset.value.distanceTo(offsetTarget) < 0.5;
}
gui.addSection("Performance", { open: false });
const stats = { fps: signal(0), spores: signal(0) };
gui.addMonitor("FPS", stats.fps);
gui.addMonitor("Spores drawn", stats.spores);
// A short hash of the code that's running, to tell at a glance whether two people see the same build.
const buildStamp = signal("…");
gui.addMonitor("Build", buildStamp);
gui.endSection();
pipeline.addGUI(gui);
// The soundtrack, slowed 10x into a drone, downloaded while the page loads; M or the button turns it on and off,
// pausing pauses it.
const sound = createSound({ onProgress: load.sound.set });
load.sound.track(sound.loaded);
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
onPause((running) => sound.setPaused(!running));
showSoundHint(() => !sound.running);
gui.addSeparator();
// ?soundtest: a section to hear each sound on its own: buttons that play one now, at a random side of the colony (hover
// and gather run for two seconds), and switches for the layers that are always going.
const soundTest = { stirUntil: 0, gatherFrom: 0, gatherUntil: 0, stretchFrom: 0, stretchUntil: 0 };
if (query.has("soundtest")) {
  gui.addSection("Sound test");
  const side = () => colonyPoint(new Vector3(nativeRandom() - 0.5, nativeRandom() - 0.5, nativeRandom() - 0.5).normalize()).clone();
  gui.addButton("Swell", () => sound.test("pulse", 0.9, 0.15, 1.6, side()));
  gui.addButton("Sporulation burst", () => sound.test("burst", side()));
  gui.addButton("Bud pinching off", () => sound.test("bud", side()));
  gui.addButton("Tap (impact)", () => sound.test("puff", side()));
  gui.addButton("Hover (2 s)", () => (soundTest.stirUntil = performance.now() + 2000));
  gui.addButton("Gather (2 s), then fling", () => {
    soundTest.gatherFrom = performance.now();
    soundTest.gatherUntil = soundTest.gatherFrom + 2000;
  });
  gui.addButton("Grab (unstick)", () => sound.test("unstick", side()));
  gui.addButton("Stretch (2 s)", () => {
    soundTest.stretchFrom = performance.now();
    soundTest.stretchUntil = soundTest.stretchFrom + 2000;
  });
  gui.addButton("Colonies parting", () => sound.test("part", bulk.center));
  gui.addButton("Colonies fusing", () => sound.test("fuse", bulk.center));
  gui.addButton("Transformation", () => sound.test("transform", 2.5, bulk.center));
  gui.addButton("Room click", () => sound.test("click"));
  for (const [label, layer] of [["Slowed track", "bed"], ["Swarm", "swarm"], ["Room clicks", "room"], ["Colony life (swells, bursts, buds)", "life"]]) {
    const on = signal(true);
    gui.addCheckbox(label, on, { onChange: (v) => sound.setMuted(layer, !v) });
  }
  gui.endSection();
}
gui.addText(keysHelp());
showHint(
  "Move over it to stir · click to puff · drag a colony to stretch it · hold right to gather, release to fling · drag around it to orbit · or leave it be and watch · R for a new colony",
  "Tap to puff · drag a colony to stretch it · long-press to gather, release to fling · drag around it to orbit · or leave it be and watch · tap {randomize} for a new colony",
);
gui.show();

function round(v) {
  return Math.round(v * 100) / 100;
}

// The shared orbit locks at the poles; this one turns the camera's up with it, so it orbits freely over and under the
// colony.
sharedControls.dispose();
const controls = new FreeOrbitControls(camera, renderer.domElement);

const scene = new Scene();
const spores = createSpores(renderer, Math.random);
scene.add(spores.mesh);

// Where the current sits in noise space: a new colony's current takes over gradually and the mass reshapes itself.
const offsetTarget = new Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(20);
spores.simUniforms.offset.value.copy(offsetTarget);
const randomStep = (v, d) => v.add(new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(d));

// The pointer: hovering (no button held) disturbs the colony along the pointer's ray; dragging orbits.
const pointer = { ndc: new Vector2(), moved: false, inside: false, buttons: 0, strength: 0 };
renderer.domElement.addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  pointer.buttons = e.buttons;
  pointer.moved = true;
  pointer.inside = true;
});
renderer.domElement.addEventListener("pointerleave", () => (pointer.inside = false));
// Pressing on a colony: a quick click puffs spores out; dragging pulls a handful out (they follow the pointer, the
// mass stretches after them and tears); the right button (or a long press on touch) gathers spores in toward the
// pointer and throws them back out on release. Pressing on the background orbits as usual.
const press = { active: false, x: 0, y: 0, t: 0, mode: null, depth: 0, ndc: new Vector2(), charge: 0, longPress: 0 };
let puffPending = null;
const toNdc = (e, out) => {
  const r = renderer.domElement.getBoundingClientRect();
  return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
};
// Where the ray passes nearest a colony (world space), and whether it passes through one.
// The colony count on show and the spread of a change to it; read by clicks, which work during the load.
const colonyMix = { shown: 1, spread: 0, velocity: 0 };
function colonyUnder(ndc) {
  raycaster.setFromCamera(ndc, camera);
  const ray = raycaster.ray;
  const k = colonyMix.shown;
  const radius = 1.05 * Math.cbrt(1 / k) + 0.1;
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = _c.copy(spores.simUniforms.centres.value[i]).applyMatrix4(spores.mesh.matrixWorld);
    const t = Math.max(0, _q.copy(c).sub(ray.origin).dot(ray.direction));
    const d = ray.at(t, _q).distanceTo(c);
    if (d < radius && (!best || t < best.t)) best = { t, d, index: i };
  }
  return best;
}
const _c = new Vector3();
const _q = new Vector3();
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener(
  "pointerdown",
  (e) => {
    // While paused every drag orbits; the colony can't respond anyway.
    if (!isRunning()) return;
    // A second finger: unless the first is already pulling or gathering, it's a pinch or orbit for the camera.
    if (press.active && press.pointer !== e.pointerId) {
      if (press.mode === "press") {
        clearTimeout(press.longPress);
        press.mode = null;
        controls.enabled = true;
      }
      return;
    }
    press.pointer = e.pointerId;
    toNdc(e, press.ndc);
    // Gathering aims where the finger (or pointer) is, even without a hover before the press.
    pointer.ndc.copy(press.ndc);
    Object.assign(press, { x: e.clientX, y: e.clientY, t: performance.now(), mode: null, charge: 0, active: true });
    const hit = colonyUnder(press.ndc);
    if (e.button === 2) {
      press.mode = "attract";
      controls.enabled = false;
    } else if (e.button === 0 && hit) {
      // A click or a drag; which one is decided when it moves.
      press.mode = "press";
      press.depth = hit.t;
      // On touch the camera keeps the finger until it pulls, so a second finger can still pinch.
      if (e.pointerType !== "touch") controls.enabled = false;
      if (e.pointerType === "touch")
        press.longPress = setTimeout(() => {
          if (press.mode !== "press") return;
          press.mode = "attract";
          controls.enabled = false;
        }, 450);
    }
  },
  { capture: true },
);
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.pointerId === press.pointer && press.mode === "press" && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
    press.mode = "grab";
    controls.enabled = false;
    clearTimeout(press.longPress);
    const u = spores.simUniforms;
    raycaster.setFromCamera(press.ndc, camera);
    sound.unstick(raycaster.ray.at(press.depth, _q));
    u.grabOrigin.value.copy(raycaster.ray.origin).applyMatrix4(_inv);
    u.grabDir.value.copy(raycaster.ray.direction).applyMatrix3(_rot).normalize();
    u.grabMark.value = 1;
  }
});
// On window, so a release over the panel or outside the page still ends a drag.
const endPress = (e) => {
  if (!press.active || e.pointerId !== press.pointer) return;
  press.active = false;
  clearTimeout(press.longPress);
  const u = spores.simUniforms;
  if (press.mode === "press" || (!press.mode && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 6 && performance.now() - press.t < 350)) {
    puffPending = toNdc(e, new Vector2());
  } else if (press.mode === "grab") {
    u.grabClear.value = 1;
  } else if (press.mode === "attract") {
    // The longer it gathered, the harder the throw.
    u.fling.value = 1.2 + 3 * Math.min(1, press.charge / 1.5);
    sound.fling(0.4 + 0.6 * Math.min(1, press.charge / 1.5), lastAttract);
  }
  press.mode = null;
  controls.enabled = true;
};
addEventListener("pointerup", endPress);
addEventListener("pointercancel", endPress);
const raycaster = new Raycaster();
const lastRayPoint = new Vector3();
let hasLastRay = false;
const _inv = new Matrix4();
const _rot = new Matrix3();
const _p = new Vector3();
const lastAttract = new Vector3();
const _v = new Vector3();

camera.position.set(0, 0.2, 5.6);
controls.target.set(0, 0, 0);
controls.dampingFactor = 0.05;
controls.minDistance = 1.8;
controls.maxDistance = 9;
// On a square or tall screen, several colonies spread wider than the default view: the camera pulls back to fit them
// (at load and when the screen turns), and can zoom out that far.
function fitView() {
  const halfFov = Math.min(camera.fov, (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) * 180) / Math.PI) * (Math.PI / 360);
  const distance = Math.max(5.6, (params.colonies() > 1 ? 2.4 : 1.5) / Math.sin(halfFov));
  controls.maxDistance = Math.max(9, distance * 1.4);
  _fit.copy(camera.position).sub(controls.target);
  if (_fit.length() < distance) camera.position.copy(controls.target).addScaledVector(_fit.normalize(), distance);
}
const _fit = new Vector3();
let wasPortrait = null;
onResize((w, h, dpr) => {
  pipeline.setSize(w, h, dpr);
  // Only when the screen turns, so a resize (fullscreen, a window drag) keeps the zoom.
  if ((w < h) !== wasPortrait) fitView();
  wasPortrait = w < h;
});

// A new colony alternates calm and wild, never repeats the palette, and goes back to one colony after several: a seed
// that breaks one of these is passed over for another (each seed's colony depends on the seed alone, so its url gives
// it back).
let lastLook = null;
let rerolls = 0;
// The look on screen, for each spore to change from: mid-change, partway from the last look to the new one.
function shownLook() {
  const u = spores.uniforms;
  const t = Math.min(1, u.changeAge.value / 2.5);
  const prev = [u.prevCrustColor.value, u.prevCrustColor2.value, u.prevCoreColor.value];
  return {
    colors: colors.map((c, i) => prev[i].clone().lerp(c, t)),
    crust: u.prevCrust.value + (eased.crust - u.prevCrust.value) * t,
    size: (u.prevSize.value / 0.011) * (1 - t) + eased.size * t,
  };
}
const breaksRules = () =>
  lastLook && (params.wildness() >= 0.5 === lastLook.wild || params.palette() === lastLook.palette || (lastLook.colonies > 1 && params.colonies() > 1));
onRandomize(() => {
  // The look on screen before the change, for each spore to change from on its own schedule.
  const before = recording && !nextLookPending ? shownLook() : null;
  const wasWildness = lastLook?.wildness ?? params.wildness();
  gui.randomizeAll();
  if (recording && !nextLookPending && rerolls < 12 && breaksRules()) {
    rerolls++;
    randomize();
    return;
  }
  rerolls = 0;
  lastLook = { wild: params.wildness() >= 0.5, wildness: params.wildness(), palette: params.palette(), colonies: params.colonies() };
  applyWildness(params.wildness(), true);
  springSlow = 1 + 4 * Math.max(0, Math.abs(params.wildness() - wasWildness) - 0.25);
  // The transformation's sound lasts as long as the change looks to.
  if (before) sound.transform(Math.min(5, 2.5 * Math.sqrt(springSlow)), bulk.center);
  if (before) staggerChange(before);
  randomStep(offsetTarget, 2.5 + 1.5 * Math.random());
  simRandom = seededRandom(`sim:${getSeed()}`);
  if (recording) record("#", getSeed());
});
applyUrlState();
fitView();

// Lighting: crisp grain shadows, short crevice AO so the folds go dark.
globalUniforms.shadowLightSize.value = 0.05;

await studio;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

window.app = { canvas: renderer.domElement, renderer, scene, params, pipeline, camera, controls, spores };

// A warm halo behind the colony: added to the background only (where nothing was drawn), centred on the colony's
// place on screen.
const glow = (() => {
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: "in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }",
    fragmentShader: `
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform vec2 centre;
      uniform float radius;
      uniform float aspect;
      uniform vec3 color;
      uniform float strength;
      in vec2 vUv;
      out vec4 outColor;
      void main() {
        vec4 c = texture(tColor, vUv);
        float bg = step(0.99999, texture(tDepth, vUv).r);
        vec2 d = (vUv - centre) * vec2(aspect, 1.0) / radius;
        float g = exp(-dot(d, d) * 0.9) * 0.7 + exp(-dot(d, d) * 0.35) * 0.12;
        outColor = vec4(c.rgb + bg * color * g * strength, c.a);
      }`,
    uniforms: { tColor: { value: null }, tDepth: { value: null }, centre: { value: new Vector2(0.5, 0.5) }, radius: { value: 0.3 }, aspect: { value: 1 }, color: { value: new Color() }, strength: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const quadGeometry = new BufferGeometry();
  quadGeometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new Mesh(quadGeometry, material);
  quad.frustumCulled = false;
  const quadScene = new Scene();
  quadScene.add(quad);
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const _c = new Vector3();
  const api = {
    strength: 1,
    color: new Color(),
    render(hdr, { depthTexture, camera: cam, width, height }) {
      if (api.strength <= 0) return hdr;
      if (target.width !== width || target.height !== height) target.setSize(width, height);
      const u = material.uniforms;
      _c.copy(controls.target).project(cam);
      u.centre.value.set(_c.x * 0.5 + 0.5, _c.y * 0.5 + 0.5);
      // About the colony's radius on screen.
      const dist = cam.position.distanceTo(controls.target);
      u.radius.value = 1.15 / (dist * Math.tan((cam.fov * Math.PI) / 360));
      u.aspect.value = width / height;
      u.tColor.value = hdr;
      u.tDepth.value = depthTexture;
      u.color.value.copy(api.color).multiplyScalar(0.012);
      u.strength.value = api.strength;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCamera);
      renderer.setRenderTarget(prev);
      return target.texture;
    },
  };
  return api;
})();

const atmosphere = createAtmosphere(renderer, { steps: { capture: 64, high: 48, medium: 32, low: 24 }[pipeline.quality] ?? 48 });
window.app.atmosphere = atmosphere;
window.app.sound = sound;
// For recordings: idle = true runs the idle camera (orbit, framing, focus puller) whatever the input or auto change;
// nextLook({ seed, ring, ...values }) moves to a seed's colony (as randomizing does), then sets any panel values given;
// ring (0..1) starts the colonies' drift apart and together at that point of its cycle (0: furthest apart).
window.app.idle = false;
window.app.idleRate = 1;
window.app.nextLook = ({ seed, ring, ...values } = {}) => {
  // The values given are part of the new look, so the spores change to all of it on their own schedules.
  const before = shownLook();
  nextLookPending = true;
  if (seed) loadSeed(String(seed));
  nextLookPending = false;
  if (ring !== undefined) paceTime = (Math.floor(paceTime / 26) + ring) * 26;
  const wasWildness = params.wildness();
  for (const [k, v] of Object.entries(values)) params[k]?.set(v);
  // A wildness given sets the physics it stands for (as the slider does), at the pace its jump calls for.
  if (values.wildness !== undefined) {
    applyWildness(values.wildness, false);
    springSlow = 1 + 4 * Math.max(0, Math.abs(values.wildness - wasWildness) - 0.25);
  }
  sound.transform(Math.min(5, 2.5 * Math.sqrt(springSlow)), bulk.center);
  staggerChange(before);
  lastLook = { wild: params.wildness() >= 0.5, wildness: params.wildness(), palette: params.palette(), colonies: params.colonies() };
};

// The microscope's scale bar: a short white line in the corner, faded in with the look.
const scaleBar = document.createElement("div");
Object.assign(scaleBar.style, { position: "fixed", right: "48px", bottom: "40px", width: "120px", height: "3px", background: "#fff", opacity: "0", pointerEvents: "none", transition: "none", zIndex: "2" });
document.body.appendChild(scaleBar);

// Budding: every so often a lobe swells out along a random direction, a neck pinches in, the bud (everything past the
// neck) is held round its own centre as that moves off, drifts a while, comes back and is taken in again.
const bud = { t: -1, wait: 6, dir: new Vector3(1, 0, 0) };
const BUD = { grow: 2.5, pinch: 2.0, away: 2.0, drift: 5, back: 3.5 };
function updateBud(dt, pace = 1) {
  const f = spores.simUniforms;
  const rate = params.budding();
  f.budGrow.value = 0;
  f.budPinch.value = 0;
  if (bud.t < 0) {
    bud.wait -= dt * rate;
    if (bud.wait <= 0 && rate > 0) {
      bud.t = 0;
      bud.dir.set(simRandom() - 0.5, simRandom() - 0.5, simRandom() - 0.5).normalize();
      f.budDir.value.copy(bud.dir);
    }
    return;
  }
  bud.t += dt;
  const t = bud.t;
  const t1 = BUD.grow, t2 = t1 + BUD.pinch, t3 = t2 + BUD.away, t4 = t3 + BUD.drift, t5 = t4 + BUD.back;
  const smooth = (x) => x * x * (3 - 2 * x);
  // Pushes scale with Pace: a slower bud lasts longer, so the same push would carry it further.
  if (t < t1) f.budGrow.value = 6 * pace * Math.sin((Math.PI * t) / t1);
  else if (t < t2) {
    if (t - dt < t1) {
      f.budMark.value = 1;
      if (recording) sound.bud(colonyPoint(bud.dir, 1.2));
      f.budCentre.value.copy(bud.dir).multiplyScalar(1.0);
    }
    f.budPinch.value = 14 * pace * Math.sin((Math.PI * (t - t1)) / BUD.pinch);
    f.budCentre.value.copy(bud.dir).multiplyScalar(1.0 + 0.25 * smooth((t - t1) / BUD.pinch));
  } else if (t < t3) f.budCentre.value.copy(bud.dir).multiplyScalar(1.25 + 0.35 * smooth((t - t2) / BUD.away));
  else if (t < t4) {
    // Drifting: a slow swing round the colony.
    const a = (0.35 * (t - t3)) / BUD.drift;
    f.budCentre.value.copy(bud.dir).applyAxisAngle(_axis.set(0, 1, 0), a).multiplyScalar(1.6);
  } else if (t < t5) {
    const a = 0.35;
    f.budCentre.value.copy(bud.dir).applyAxisAngle(_axis.set(0, 1, 0), a).multiplyScalar(1.6 * (1 - smooth((t - t4) / BUD.back)));
  } else {
    f.budClear.value = 1;
    bud.t = -1;
    bud.wait = 8 + 8 * simRandom();
  }
}
const _axis = new Vector3();
// Ends a bud under way (when a change leaves more than one colony, where budding doesn't run).
function endBud() {
  const f = spores.simUniforms;
  f.budGrow.value = 0;
  f.budPinch.value = 0;
  if (bud.t < 0) return;
  f.budClear.value = 1;
  bud.t = -1;
  bud.wait = 8 + 8 * simRandom();
}

// Colonies: with more than one, their centres sit round a slowly turning, tilted ring whose radius swells and
// shrinks: apart for a while, then they drift together and merge, then pull apart again (each spore follows its own
// colony's centre, so a merged mass splits back along its colonies, streaked with each other's colours).
// A change in the number of colonies never jumps: the colonies draw together into one place, the count changes
// there (each spore's colony colour then changes on its own schedule, see staggerChange), and they spread out again.
function updateColonies(simTime) {
  const want = params.colonies();
  if (colonyMix.shown === 1) colonyMix.spread = colonyMix.velocity = 0;
  const goal = want === colonyMix.shown ? 1 : 0;
  const rate = 0.8;
  colonyMix.velocity += ((goal - colonyMix.spread) * rate * rate - 2 * rate * colonyMix.velocity) * STEP;
  colonyMix.spread = Math.max(0, colonyMix.spread + colonyMix.velocity * STEP);
  if (want !== colonyMix.shown && colonyMix.spread < 0.03) {
    spores.uniforms.prevColonies.value = colonyMix.shown;
    spores.uniforms.colonyAge.value = recording ? 0 : 100;
    colonyMix.shown = want;
    colonyMix.spread = colonyMix.velocity = 0;
  }
  const k = colonyMix.shown;
  const c = spores.simUniforms.centres.value;
  spores.simUniforms.colonies.value = k;
  if (k === 1) {
    c[0].set(0, 0, 0);
    return;
  }
  // From well apart to touching (fused at the surface, not overlapping) and back.
  const u = 0.5 + 0.5 * Math.sin((simTime * Math.PI * 2) / 26 - Math.PI / 2);
  const near = k === 2 ? 0.5 : 0.55;
  const far = k === 2 ? 1.2 : 1.15;
  const spread = (far + (near - far) * smoothstep01((u - 0.15) / 0.45)) * colonyMix.spread;
  // Colonies fusing at the surface and parting again (as they drift together and apart, or split and merge on a change
  // in their number): a wet merge, a slow tear.
  const fused = smoothstep01((u - 0.15) / 0.45) > 0.85 || colonyMix.spread < 0.35;
  if (recording && colonyMix.wasFused !== undefined && fused !== colonyMix.wasFused) (fused ? sound.fuse : sound.part)(bulk.center);
  colonyMix.wasFused = fused;
  // The ring turns in the plane facing the camera (in the colony's own space), so no colony hides behind another.
  const turn = simTime * 0.12;
  _view.copy(camera.position).sub(controls.target).applyMatrix3(_rot.setFromMatrix4(_inv.copy(spores.mesh.matrixWorld).invert())).normalize();
  _ringX.set(0, 1, 0).cross(_view);
  if (_ringX.lengthSq() < 1e-4) _ringX.set(1, 0, 0);
  _ringX.normalize();
  _ringY.crossVectors(_view, _ringX);
  for (let i = 0; i < 3; i++) {
    const a = turn + (i * Math.PI * 2) / k;
    // A little depth wobble so they don't sit on a flat card.
    c[i].copy(_ringX).multiplyScalar(Math.cos(a) * spread).addScaledVector(_ringY, Math.sin(a) * spread * 0.75).addScaledVector(_view, Math.sin(a * 0.7 + i) * 0.15 * spread);
  }
}
const _view = new Vector3();
const _ringX = new Vector3();
const _ringY = new Vector3();
const smoothstep01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// Kiosk orbit: with auto change on and no input for a while, the camera eases into a slow orbit round the colony that
// keeps to its lit side: it circles the light's axis while its angle from the light swings between 35 and 100 degrees,
// so it winds like a helix and dips past the terminator into shadow briefly, never straight round to the back. It
// eases onto that path from wherever the camera is, and any input hands the camera straight back.
const IDLE_AFTER = 5000;
const ORBIT_MID = (67.5 * Math.PI) / 180;
const ORBIT_SWING = (32.5 * Math.PI) / 180;
const idle = { last: performance.now(), amount: 0, phi: 0, psi: 0, started: false, time: 0, aimVelocity: new Vector3(), distanceVelocity: 0 };
for (const type of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"])
  addEventListener(type, () => ((idle.last = performance.now()), (idle.amount = 0), (idle.started = false)), { capture: true, passive: true });
const _off = new Vector3();
const _drift = new Vector3();
const _bulk = { center: new Vector3(), radius: 1 };
const _ci = new Vector3();
// The bulk of the colony (or colonies) in world space: round their centres, wide enough for each one's radius.
function colonyBulk(out) {
  const n = colonyMix.shown;
  const R = 1.05 * Math.cbrt(1 / n) + 0.1;
  const c = spores.simUniforms.centres.value;
  out.center.set(0, 0, 0);
  for (let i = 0; i < n; i++) out.center.add(_ci.copy(c[i]).applyMatrix4(spores.mesh.matrixWorld));
  out.center.divideScalar(n);
  let far = 0;
  for (let i = 0; i < n; i++) far = Math.max(far, _ci.copy(c[i]).applyMatrix4(spores.mesh.matrixWorld).distanceTo(out.center));
  // Wilder colonies reach further out with their arms.
  out.radius = (far + R) * (1 + 0.6 * Math.max(0, eased.wildness - 0.3));
  return out;
}
// The bulk the camera frames and focuses on, following the colony's on a gentle spring so neither ever jumps.
const bulk = { center: new Vector3(), radius: 1.2, centerVelocity: new Vector3(), radiusVelocity: 0, started: false };
const _bulkRaw = { center: new Vector3(), radius: 1 };
const _bulkPull = new Vector3();
function updateBulk(wall) {
  colonyBulk(_bulkRaw);
  if (!bulk.started) {
    bulk.center.copy(_bulkRaw.center);
    bulk.radius = _bulkRaw.radius;
    bulk.started = true;
  }
  const rate = 0.7;
  _bulkPull.copy(_bulkRaw.center).sub(bulk.center).multiplyScalar(rate * rate).addScaledVector(bulk.centerVelocity, -2 * rate);
  bulk.centerVelocity.addScaledVector(_bulkPull, wall);
  bulk.center.addScaledVector(bulk.centerVelocity, wall);
  bulk.radiusVelocity += ((_bulkRaw.radius - bulk.radius) * rate * rate - 2 * rate * bulk.radiusVelocity) * wall;
  bulk.radius += bulk.radiusVelocity * wall;
}
const _dir = new Vector3();
const _goal = new Vector3();
const _lightAxis = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _level = new Vector3();
const _turn = new Quaternion();
// Focus: the Focus slider places the focal plane across the colony's bulk, from its front (-1) through its middle (0) to
// its back (1). It normally trails its goal lazily; when it falls too far out of focus it notices and refocuses quickly,
// overshooting a little before it settles. Idle, a focus puller takes over: every now and then it racks to another
// spot between the front and the middle, or scans slowly between two.
const FOCUS_LAZY = { stiffness: 1.2, damping: 1.4 };
const FOCUS_SNAP = { stiffness: 30, damping: 2 * 0.35 * Math.sqrt(30) };
const FOCUS_FOLLOW = { stiffness: 60, damping: 2 * Math.sqrt(60) };
const focus = { value: 5, velocity: 0, snapping: false, wait: 3, from: 0, to: 0, scan: 0, scanLength: 0, spot: params.focus() };
function focusPuller(wall) {
  focus.wait -= wall;
  if (focus.scanLength > 0) {
    focus.scan = Math.min(1, focus.scan + wall / focus.scanLength);
    focus.spot = focus.from + (focus.to - focus.from) * (0.5 - 0.5 * Math.cos(Math.PI * focus.scan));
    if (focus.scan >= 1) focus.scanLength = 0;
  }
  if (focus.wait > 0) return;
  focus.wait = 6 + 6 * nativeRandom();
  // Only between the front and the middle: the far side is never the subject.
  const spot = () => -0.85 + 0.85 * nativeRandom();
  if (nativeRandom() < 0.6) {
    focus.spot = spot();
    focus.scanLength = 0;
  } else {
    focus.from = focus.spot;
    focus.to = spot();
    focus.scan = 0;
    focus.scanLength = 5 + 4 * nativeRandom();
  }
}
function updateFocus(wall) {
  _bulkFocus.center.copy(bulk.center);
  _bulkFocus.radius = bulk.radius;
  const floaty = idle.amount > 0;
  if (floaty) focusPuller(wall * params.cameraSpeed() * (window.app.idleRate ?? 1));
  else focus.spot = params.focus();
  const goal = Math.max(0.5, camera.position.distanceTo(_bulkFocus.center) + focus.spot * _bulkFocus.radius);
  const error = Math.abs(goal - focus.value);
  if (floaty) {
    // Out of focus by more than a little: refocus fast (and overshoot); back to lazy once it has settled.
    if (error > 0.08 * _bulkFocus.radius + 0.04) focus.snapping = true;
    else if (focus.snapping && error < 0.01 * _bulkFocus.radius && Math.abs(focus.velocity) < 0.05) focus.snapping = false;
  } else focus.snapping = false;
  const spring = !floaty ? FOCUS_FOLLOW : focus.snapping ? FOCUS_SNAP : FOCUS_LAZY;
  const n = Math.max(1, Math.ceil(wall * 120));
  const dt = wall / n;
  for (let i = 0; i < n; i++) {
    focus.velocity += ((goal - focus.value) * spring.stiffness - focus.velocity * spring.damping) * dt;
    focus.value = Math.max(0.5, focus.value + focus.velocity * dt);
  }
  // Settle exactly: a spring only approaches its goal, and any change of focus restarts the still's lens average.
  if (!floaty && Math.abs(goal - focus.value) < 2e-3 && Math.abs(focus.velocity) < 2e-2) {
    focus.value = goal;
    focus.velocity = 0;
  }
}
// Shift + scroll moves the focus through the colony.
addEventListener(
  "wheel",
  (e) => {
    if (!e.shiftKey || e.target !== renderer.domElement) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = Math.sign(e.deltaY || e.deltaX) * 0.06;
    params.focus.set(Math.round(Math.min(1, Math.max(-1, params.focus() + d)) * 100) / 100);
  },
  { capture: true, passive: false },
);
const _bulkFocus = { center: new Vector3(), radius: 1 };
function updateIdleOrbit(wall) {
  // Camera speed (and, for recordings, app.idleRate) runs the idle camera slower or faster.
  wall *= params.cameraSpeed() * (window.app.idleRate ?? 1);
  const on = isRunning() && (window.app.idle || (params.auto() && !query.has("capture") && performance.now() - idle.last > IDLE_AFTER));
  if (!on) {
    idle.amount = 0;
    idle.started = false;
    idle.aimVelocity.set(0, 0, 0);
    idle.distanceVelocity = 0;
    return;
  }
  idle.amount = Math.min(1, idle.amount + wall / 3);
  const k = smoothstep01(idle.amount);
  // A frame round the light's axis (toward the light).
  _lightAxis.copy(globalUniforms.lightDirection.value).normalize();
  _e1.set(0, 1, 0).cross(_lightAxis);
  if (_e1.lengthSq() < 1e-4) _e1.set(1, 0, 0).cross(_lightAxis);
  _e1.normalize();
  _e2.crossVectors(_lightAxis, _e1);
  // Floaty: the target eases onto the colony's bulk with a slow drift, and the distance onto one that frames it,
  // breathing between a close fill and a looser view.
  _bulk.center.copy(bulk.center);
  _bulk.radius = bulk.radius;
  idle.time += wall * k;
  const t = idle.time;
  _drift.set(Math.sin(t * 0.21) + 0.6 * Math.sin(t * 0.47 + 1.3), Math.sin(t * 0.17 + 2.1) + 0.6 * Math.sin(t * 0.39), Math.sin(t * 0.23 + 4.2) + 0.6 * Math.sin(t * 0.43 + 0.7)).multiplyScalar(0.06 * _bulk.radius);
  // The aim and the distance follow springs (from rest when the idle camera takes over), so nothing jumps.
  const aimRate = 0.6 * k;
  _drift.add(_bulk.center).sub(controls.target).multiplyScalar(aimRate * aimRate).addScaledVector(idle.aimVelocity, -2 * aimRate);
  idle.aimVelocity.addScaledVector(_drift, wall);
  controls.target.addScaledVector(idle.aimVelocity, wall);
  const halfFov = Math.min(camera.fov, (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) * 180) / Math.PI) * (Math.PI / 360);
  // How much room round the bulk: from a close fill with a margin left (1.2) to a looser view (1.7).
  const fill = 1.45 + 0.2 * Math.sin(t * 0.11 + 0.8) + 0.05 * Math.sin(t * 0.37);
  const fitDistance = Math.min(controls.maxDistance, Math.max(controls.minDistance, (_bulk.radius * fill) / Math.sin(halfFov)));
  _off.copy(camera.position).sub(controls.target);
  const r0 = _off.length();
  const distanceRate = 0.5 * k;
  idle.distanceVelocity += ((fitDistance - r0) * distanceRate * distanceRate - 2 * distanceRate * idle.distanceVelocity) * wall;
  const r = r0 + idle.distanceVelocity * wall;
  _dir.copy(_off).divideScalar(r0);
  if (!idle.started) {
    // Join the path where the camera is (its angle from the light clamped into the swing).
    idle.phi = Math.atan2(_dir.dot(_e2), _dir.dot(_e1));
    const theta = Math.acos(Math.min(1, Math.max(-1, _dir.dot(_lightAxis))));
    idle.psi = Math.asin(Math.min(1, Math.max(-1, (theta - ORBIT_MID) / ORBIT_SWING)));
    idle.started = true;
  }
  // About 50 s round the light's axis; one swing out and back in 40 s.
  idle.phi += 0.13 * wall * k;
  idle.psi += ((2 * Math.PI) / 40) * wall * k;
  const theta = ORBIT_MID + ORBIT_SWING * Math.sin(idle.psi);
  _goal.copy(_e1).multiplyScalar(Math.cos(idle.phi)).addScaledVector(_e2, Math.sin(idle.phi)).multiplyScalar(Math.sin(theta)).addScaledVector(_lightAxis, Math.cos(theta));
  // Follow the path with a short lag and a capped turn rate, so joining it from far off is a slow swing, not a sweep.
  _goal.lerp(_dir, Math.exp(-wall * 1.5 * k)).normalize();
  const angle = Math.acos(Math.min(1, Math.max(-1, _dir.dot(_goal))));
  const maxTurn = 0.3 * wall;
  if (angle > maxTurn) _goal.lerp(_dir, 1 - maxTurn / angle).normalize();
  _turn.setFromUnitVectors(_dir, _goal);
  camera.up.applyQuaternion(_turn);
  // Ease the horizon back toward level, so the view doesn't slowly roll over.
  _level.set(0, 1, 0).addScaledVector(_goal, -_goal.y);
  if (_level.lengthSq() > 0.04) camera.up.lerp(_level.normalize(), 1 - Math.exp(-wall * 0.6 * k));
  camera.up.addScaledVector(_goal, -camera.up.dot(_goal)).normalize();
  camera.position.copy(controls.target).addScaledVector(_goal, r);
}

// Engorgement: not a rhythm but irregular pulses. Every 1-5 s (unevenly) the colony suddenly swells, in a fraction of a
// second, often more on one side, then slowly sags back over a second or two; pulses can overlap. Each lowers the
// density the mass settles to (restAt in the simulation), so the swell spreads through the mass.
const pulses = [];
let pulseWait = 2;
const _pulseDir = new Vector3();
// A point on the colony's surface toward an object-space direction, in world space (where its sounds come from).
const _soundAt = new Vector3();
const colonyPoint = (dir, radius = 1.1) => _soundAt.copy(dir).multiplyScalar(radius).applyMatrix4(spores.mesh.matrixWorld);
function updatePulses(dt, pace) {
  const f = spores.simUniforms;
  const amount = eased.breathe;
  pulseWait -= dt * pace * (0.4 + amount);
  if (pulseWait <= 0 && amount > 0) {
    // Uneven gaps: mostly short, now and then a long rest; sometimes a quick double beat.
    pulseWait = simRandom() < 0.25 ? 0.35 + 0.3 * simRandom() : 1 + 4 * Math.pow(simRandom(), 1.5);
    const p = {
      t: 0,
      amp: 0.25 + 0.5 * simRandom(),
      rise: 0.08 + 0.12 * simRandom(),
      fall: 0.8 + 1.4 * simRandom(),
      dir: new Vector3(simRandom() - 0.5, simRandom() - 0.5, simRandom() - 0.5).normalize(),
      focus: simRandom() * 0.85,
    };
    pulses.push(p);
    if (recording) sound.pulse(p.amp * amount * 2, p.rise / pace, p.fall / pace, colonyPoint(p.dir));
  }
  let amp = 0;
  let focus = 0;
  _pulseDir.set(0, 0, 0);
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.t += dt * pace;
    // Sudden fill, slow sag.
    const env = (1 - Math.exp(-p.t / p.rise)) * Math.exp(-p.t / p.fall);
    if (p.t > p.fall * 6) {
      pulses.splice(i, 1);
      continue;
    }
    const a = p.amp * env;
    amp += a;
    focus += p.focus * a;
    _pulseDir.addScaledVector(p.dir, a);
  }
  // How fast the swell is filling (+) or sagging (-), for the mass to follow it directly.
  const total = amount * amp;
  f.pulseRate.value = dt > 0 ? (total - f.pulseAmp.value) / dt : 0;
  f.pulseAmp.value = total;
  f.pulseFocus.value = amp > 1e-4 ? focus / amp : 0;
  if (_pulseDir.lengthSq() > 1e-8) f.pulseDir.value.copy(_pulseDir).normalize();
}

// Sporulation bursts: every few seconds (sooner with the slider up) one small patch of crust ripens and pops.
let sporeWait = 3;
function updateSporulation(dt) {
  const rate = params.sporulation();
  if (rate <= 0 || dt <= 0) return;
  sporeWait -= dt * rate;
  if (sporeWait > 0) return;
  sporeWait = 3 + 4 * simRandom();
  const f = spores.simUniforms;
  f.sporeDir.value.set(simRandom() - 0.5, simRandom() - 0.5, simRandom() - 0.5).normalize();
  // A patch some 10-16 degrees across; about half its ripe crust spores go.
  f.sporeCone.value = Math.cos(0.09 + 0.05 * simRandom());
  f.sporeChance.value = 0.5;
  if (recording) sound.burst(colonyPoint(f.sporeDir.value, 1.15));
}

// A new colony's colours, crust and grain size reach the spores at different moments and paces (see the spores'
// vertex shader): the new values apply at once, the old ones stay as each spore's starting point.
function staggerChange(before) {
  const u = spores.uniforms;
  const palette = PALETTES[params.palette()] ?? PALETTES.pollen;
  colors.forEach((c, i) => c.set(palette[i]));
  eased.crust = params.crust();
  eased.size = params.size();
  u.prevCrustColor.value.copy(before.colors[0]);
  u.prevCrustColor2.value.copy(before.colors[1]);
  u.prevCoreColor.value.copy(before.colors[2]);
  u.prevCrust.value = before.crust;
  u.prevSize.value = 0.011 * before.size;
  u.changeAge.value = 0;
}
// Eased versions of what the panel sets: per simulation step (at the default speed, as fast as on wall-clock time),
// so a view link replays them exactly; on wall-clock time while paused, so changes still show.
const eased = {};
const easedKeys = ["wildness", "size", "crust", "turbulence", "scale", "cohesion", "bonds", "pressure", "drag", "blur", "tear", "breathe", "collisions", "halo", "beam", "haze", "dust"];
let micro = params.look() === "microscope" ? 1 : 0;
const STUDIO_BG = new Color(BACKGROUND);
const MICRO_BG = new Color("#3a3d41");
for (const k of easedKeys) eased[k] = params[k]();
const colors = PALETTES[params.palette()].map((c) => new Color(c));
const target = new Color();
let flowTime = 0;
let blurWasOn = false;
let simTime = 0;
// The colony's own clock: simulation time at Pace.
let paceTime = 0;
let simAcc = 0;
const STEP = 1 / 60;
let simSteps = 0;
// The simulation's parameters from the (eased) panel values; also run before a link's fast-forward, so it matches.
function applySimParams() {
  const f = spores.simUniforms;
  const u = spores.uniforms;
  // The current's push scales with Pace (by its square root: slower, without the folds flattening out).
  f.turbulence.value = 1.4 * eased.turbulence * Math.sqrt(params.pace());
  f.scale.value = eased.scale;
  f.cohesion.value = 5 * eased.cohesion;
  f.bond.value = 60 * eased.bonds;
  f.pressure.value = 8 * eased.pressure;
  f.viscosity.value = 12;
  f.drag.value = 1.5 * eased.drag;
  f.tear.value = 0.1 * (1 - 0.85 * eased.tear);
  u.sporeSize.value = 0.011 * eased.size;
  u.crust.value = eased.crust;
  u.crustColor.value.copy(colors[0]);
  u.crustColor2.value.copy(colors[1]);
  u.coreColor.value.copy(colors[2]);
  f.crust.value = eased.crust;
  f.finePressure.value = 1.5 * eased.collisions;
  f.sorting.value = params.sorting();
  spores.count = params.spores();
}
// One fixed simulation step: everything that advances with simulation time.
function simStep() {
  if (recording) recordEdits();
  ease(STEP / defaults.speed);
  easeOffset(STEP / defaults.speed);
  applySimParams();
  simTime += STEP;
  simSteps++;
  const pace = params.pace();
  paceTime += STEP * pace;
  updateSporulation(STEP * pace);
  updatePulses(STEP, pace);
  updateColonies(paceTime);
  if (colonyMix.shown === 1 && params.colonies() === 1) updateBud(STEP * pace, pace);
  else endBud();
  flowTime += STEP * pace * params.flow() * 0.25;
  spores.step(STEP, simTime, flowTime);
}
// The physics settings (and the current's place in noise space) follow a critically damped spring instead: they
// start gently, move smoothly and settle in about 4 s without overshooting, so a calm colony doesn't snap back
// into a ball when the wild one before it lets go.
const SPRING_KEYS = new Set(["wildness", "turbulence", "scale", "cohesion", "bonds", "pressure", "drag", "tear", "breathe", "collisions"]);
const SPRING = 1.1;
const easedVelocity = {};
function ease(dt) {
  const k = 1 - Math.exp(-dt * 2.5);
  for (const key of easedKeys) {
    if (!SPRING_KEYS.has(key)) {
      eased[key] += (params[key]() - eased[key]) * k;
      continue;
    }
    const v = (easedVelocity[key] ?? 0) + ((params[key]() - eased[key]) * (SPRING / springSlow) ** 2 - (2 * SPRING / springSlow) * (easedVelocity[key] ?? 0)) * dt;
    easedVelocity[key] = v;
    eased[key] += v * dt;
  }
}
const OFFSET_SPRING = 0.9;
const offsetVelocity = new Vector3();
const _offsetPull = new Vector3();
function easeOffset(dt) {
  const offset = spores.simUniforms.offset.value;
  const rate = OFFSET_SPRING / springSlow;
  _offsetPull.copy(offsetTarget).sub(offset).multiplyScalar(rate * rate).addScaledVector(offsetVelocity, -2 * rate);
  offsetVelocity.addScaledVector(_offsetPull, dt);
  offset.addScaledVector(offsetVelocity, dt);
}
let lastNow = performance.now();
let lastShown = "";
let pausedSettle = 0;
let fpsTime = 0;
let fpsFrames = 0;

function updatePointer(dt) {
  const u = spores.simUniforms;
  const mesh = spores.mesh;
  mesh.updateMatrixWorld();
  _inv.copy(mesh.matrixWorld).invert();
  _rot.setFromMatrix4(_inv);
  raycaster.setFromCamera(pointer.ndc, camera);
  // The ray in the colony's own space; its velocity measured where it passes the colony's centre.
  const ray = raycaster.ray;
  const t = Math.max(0, _p.copy(controls.target).sub(ray.origin).dot(ray.direction));
  const point = ray.at(t, _p);
  if (hasLastRay && dt > 0) _v.copy(point).sub(lastRayPoint).divideScalar(Math.max(dt, 1 / 120));
  else _v.set(0, 0, 0);
  lastRayPoint.copy(point);
  hasLastRay = true;
  u.rayOrigin.value.copy(ray.origin).applyMatrix4(_inv);
  u.rayDir.value.copy(ray.direction).applyMatrix3(_rot).normalize();
  u.rayVel.value.copy(_v).applyMatrix3(_rot);
  if (u.rayVel.value.length() > 4) u.rayVel.value.setLength(4);
  // Strong while it moves over the canvas without a button, fading out when it stops.
  const active = pointer.moved && pointer.inside && pointer.buttons === 0;
  pointer.strength = active ? 1 : pointer.strength * Math.exp(-dt * 4);
  pointer.moved = false;
  u.pointerForce.value = pointer.strength * params.disrupt() * 4;
  // The rustle only while the pointer is over a colony, where its ray meets it.
  const over = pointer.inside && pointer.strength > 0.01 ? colonyUnder(pointer.ndc) : null;
  const testing = performance.now() < soundTest.stirUntil;
  sound.stir(testing ? 0.8 : over ? pointer.strength * Math.min(1, params.disrupt()) : 0, testing ? bulk.center : over ? ray.at(over.t, _q) : point);
  // Dragging: the grabbed spores' target is the pointer, at the depth the colony was grabbed at.
  if (press.mode === "grab") {
    u.grabTarget.value.copy(ray.at(press.depth, _q)).applyMatrix4(_inv);
    u.grabPull.value = 30;
    // The stretch's sound: as loud as the pull moves, higher the further the spores are pulled from where they were.
    const at = ray.at(press.depth, _q);
    if (!press.grabFrom) press.grabFrom = at.clone();
    const tension = Math.min(1, at.distanceTo(press.grabFrom) / 1.5);
    press.stretchLevel = Math.max(Math.min(1, _v.length() * 0.6), (press.stretchLevel ?? 0) * Math.exp(-dt * 3));
    sound.stretch(press.stretchLevel * (0.4 + 0.6 * tension), tension, at);
  } else {
    u.grabPull.value = 0;
    press.grabFrom = null;
    press.stretchLevel = 0;
    // The test panel's stretch: a steady pull, tightening over two seconds.
    const now = performance.now();
    const k = now < soundTest.stretchUntil ? (now - soundTest.stretchFrom) / 2000 : 0;
    sound.stretch(k ? 0.4 + 0.6 * k : 0, k, bulk.center);
  }
  // Gathering: toward the point on the ray nearest the colony under it (or the colony's middle).
  if (press.mode === "attract") {
    press.charge += dt;
    const hit = colonyUnder(pointer.ndc);
    const c = hit ? spores.simUniforms.centres.value[hit.index].clone().applyMatrix4(spores.mesh.matrixWorld) : controls.target;
    const tt = Math.max(0, _q.copy(c).sub(ray.origin).dot(ray.direction));
    u.attractPoint.value.copy(ray.at(tt, _q)).applyMatrix4(_inv);
    u.attract.value = 14 * Math.min(1, 0.3 + press.charge);
    lastAttract.copy(ray.at(tt, _q));
    sound.gather(Math.min(1, press.charge / 1.5), lastAttract);
  } else {
    u.attract.value = 0;
    // The test panel's gather: builds over two seconds, then flings.
    const now = performance.now();
    if (now < soundTest.gatherUntil) sound.gather((now - soundTest.gatherFrom) / 2000, bulk.center);
    else {
      if (soundTest.gatherUntil) {
        soundTest.gatherUntil = 0;
        sound.fling(1, bulk.center);
      }
      sound.gather(0, lastAttract);
    }
  }
  if (puffPending && dt > 0) {
    raycaster.setFromCamera(puffPending, camera);
    u.burstOrigin.value.copy(raycaster.ray.origin).applyMatrix4(_inv);
    u.burstDir.value.copy(raycaster.ray.direction).applyMatrix3(_rot).normalize();
    u.burstCentre.value.set(0, 0, 0);
    u.burstStrength.value = 3 * params.puff();
    sound.puff(raycaster.ray.at(Math.max(0, _q.copy(controls.target).sub(raycaster.ray.origin).dot(raycaster.ray.direction)), _q));
    puffPending = null;
  }
}

// A link to this view: the query the page was opened with, plus every randomize and panel change since, the step
// count, the camera, the colony's turn, whether it's paused and the build, with auto change off. Opening it replays
// the fixed-step simulation to that step behind the loading pill. Not recorded: pointer input, the camera and spin
// over time (with several colonies their ring faces the camera), and changes made while paused (eased on wall-clock
// time); views that depend on them come back close. The GPU simulation also varies slightly from run to run, so grains
// land a little differently even then.
async function computeBuild() {
  let h = 2166136261;
  for (const file of ["main.js", "spores.js", "atmosphere.js"]) {
    const text = await (await fetch(file, { cache: "no-store" })).text();
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 7);
}
const buildPromise = computeBuild().then((b) => (buildStamp.set(b), b));
function viewLink() {
  recordEdits();
  const url = new URL(location.href);
  url.search = "";
  for (const [k, v] of query) if (!LINK_KEYS.includes(k)) url.searchParams.set(k, v);
  if (!query.get("seed")) url.searchParams.set("origin", startSeed);
  const r = (v) => Number(v.toFixed(4));
  url.searchParams.set("auto", "false");
  // Past what a link replays, it keeps the current seed, settings and camera, but not the colony's history.
  if (simSteps <= MAX_REPLAY) {
    url.searchParams.set("step", String(simSteps));
    url.searchParams.set("ev", JSON.stringify(events));
  } else {
    url.searchParams.set("seed", getSeed());
    for (const k of RECORDED) url.searchParams.set(k, String(params[k]()));
    console.warn("This session is too long to replay: the link gives its colony's settings, not its exact shape.");
  }
  url.searchParams.set("cam", [...camera.position.toArray(), ...controls.target.toArray(), ...camera.up.toArray()].map(r).join(","));
  url.searchParams.set("turn", String(r(spores.mesh.rotation.y)));
  url.searchParams.set("paused", isRunning() ? "0" : "1");
  url.searchParams.set("build", buildStamp());
  return url.toString();
}
const toast = document.createElement("div");
Object.assign(toast.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", padding: "6px 14px", borderRadius: "999px", background: "rgba(0,0,0,0.6)", color: "#fff", font: "13px system-ui, sans-serif", opacity: "0", transition: "opacity 0.3s", pointerEvents: "none", zIndex: "3" });
document.body.appendChild(toast);
function copyViewLink() {
  const link = viewLink();
  navigator.clipboard?.writeText(link).catch(() => {});
  console.log(link);
  toast.textContent = "Link to this view copied";
  toast.style.opacity = "1";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toast.style.opacity = "0"), 1800);
}
addKey("KeyL", "Copy a link to this view", copyViewLink);
gui.addButton("Copy view link (L)", copyViewLink);
{
  const cam = query.get("cam")?.split(",").map(Number);
  if ((cam?.length === 6 || cam?.length === 9) && cam.every(Number.isFinite)) {
    camera.position.set(cam[0], cam[1], cam[2]);
    controls.target.set(cam[3], cam[4], cam[5]);
    if (cam.length === 9) camera.up.set(cam[6], cam[7], cam[8]).normalize();
    controls.update();
  }
  const turn = Number(query.get("turn"));
  if (Number.isFinite(turn)) spores.mesh.rotation.y = turn;
  spores.mesh.updateMatrixWorld();
  applySimParams();
  // In batches, waiting for the GPU between them, so a long replay never stalls the page or trips the GPU watchdog.
  const gl = renderer.getContext();
  let next = 0;
  const applyEvents = (step) => {
    for (; next < events.length && events[next][0] <= step; next++) {
      const [, key, value] = events[next];
      if (key === "#") loadSeed(String(value));
      else if (params[key]) params[key].set(value);
    }
  };
  for (let i = 0; i < replaySteps; i++) {
    applyEvents(i);
    simStep();
    if (i % 30 === 29) {
      gl.finish();
      load.replay.set(i / replaySteps);
      await yieldNow();
    }
  }
  applyEvents(replaySteps);
  load.replay?.done();
  if (query.get("paused") === "1") setRunning(false);
  const linkBuild = query.get("build");
  if (linkBuild) buildPromise.then((b) => b !== linkBuild && console.warn(`This link was made with build ${linkBuild}; this is ${b}.`));
  snapshotParams();
  recording = true;
  lastLook = { wild: params.wildness() >= 0.5, wildness: params.wildness(), palette: params.palette(), colonies: params.colonies() };
}

render(({ time, dt }) => {
  sound.update(camera);
  // The swarm's constant sound: as loud as the colony is lively, swelling with its pulses, from its bulk.
  const lively = Math.min(1, 0.25 + 0.3 * eased.turbulence * Math.sqrt(params.pace()) * (0.5 + params.flow()) / 1.2);
  sound.swarm(lively, Math.min(1, spores.simUniforms.pulseAmp.value * 2), bulk.center);
  const now = performance.now();
  const wall = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  autoChange.update(dt);

  const k = 1 - Math.exp(-wall * 2.5);
  if (!isRunning()) ease(wall);
  const palette = PALETTES[params.palette()] ?? PALETTES.pollen;
  colors.forEach((c, i) => c.lerp(target.set(palette[i]), k));

  const f = spores.simUniforms;
  const u = spores.uniforms;
  applySimParams();
  // Simulation time runs at Speed in fixed steps (so a seed, the settings and a time always give the same colony);
  // the pointer, spin and camera stay on real time.
  simAcc += dt * params.speed();
  let steps = Math.floor(simAcc / STEP);
  if (steps > 4) {
    steps = 4;
    simAcc = 4 * STEP;
  }
  simAcc -= steps * STEP;
  // The look eases between studio and microscope (on wall-clock time).
  micro += ((params.look() === "microscope" ? 1 : 0) - micro) * (1 - Math.exp(-wall * 3));
  u.microscope.value = micro;
  u.changeAge.value += wall / Math.sqrt(springSlow);
  u.colonyAge.value += wall;
  u.translucency.value = params.translucency();
  u.detail.value = params.detail();
  pipeline.saturation = 1.45 * (1 - micro);
  pipeline.contrast = 1.08 + 0.22 * micro;
  pipeline.background.copy(STUDIO_BG).lerp(MICRO_BG, micro);
  scaleBar.style.opacity = String(micro * 0.9);
  glow.strength = eased.halo * (1 - micro);
  atmosphere.beam = eased.beam * (1 - micro);
  atmosphere.haze = eased.haze * (1 - micro);
  atmosphere.dust = eased.dust * (1 - 0.7 * micro);
  atmosphere.color.setRGB(1, 0.9, 0.78).lerp(target.setRGB(1, 1, 1), micro);
  atmosphere.centre.copy(controls.target);
  atmosphere.time = time;
  // Sharp a little in front of the colony's middle, so its near side is crisp and its far side and the air soften.
  const aperture = 0.05 * params.focusBlur();
  updateBulk(wall);
  updateFocus(wall);
  pipeline.dof.focus = focus.value;
  pipeline.dof.aperture = aperture;
  atmosphere.dustAfterFocus = aperture > 0;
  atmosphere.lens.aperture = aperture;
  atmosphere.lens.focus = pipeline.dof.focus;
  glow.color.copy(colors[1]);
  f.sorting.value = params.sorting();
  spores.count = params.spores();

  updatePointer(dt);
  for (let i = 0; i < steps; i++) simStep();
  if (steps === 0) spores.step(0, simTime, flowTime);
  // Drawn between the last two steps, so a slow simulation still moves every frame.
  spores.interpolate(simAcc / STEP, steps > 0 || dt > 0);
  spores.mesh.rotation.y += dt * params.spin() * 0.5;
  spores.updateLight();

  // The shutter, as a fraction of the frame. While paused the last move is kept (no step copies new positions), so the
  // frozen frame keeps its blur, like a photograph.
  u.shutter.value = eased.blur;
  // The pipeline's blur pass only runs while the slider is up (switched on change, so the Rendering panel's own
  // toggle still works).
  const blurOn = params.blur() > 0;
  if (blurOn !== blurWasOn) pipeline.motionBlur = blurWasOn = blurOn;
  updateIdleOrbit(wall);
  controls.update();
  // While paused, settings that only change the picture (palette, size, look, light, air...) still show: the
  // pipeline can't see uniforms change, so frames render live while anything shown changes, and a little after (the
  // grains' light eases over a few frames); then the still settles again.
  if (!isRunning()) {
    const shown = RECORDED.map((k) => params[k]()).join() + easedKeys.map((k) => eased[k].toFixed(4)).join() + colors.map((c) => c.getHexString()).join() + micro.toFixed(4);
    if (shown !== lastShown || spores.uniforms.changeAge.value < 8 || spores.uniforms.colonyAge.value < 4 || colonyMix.shown !== params.colonies()) pausedSettle = 20;
    lastShown = shown;
    if (pausedSettle > 0) {
      pausedSettle--;
      pipeline.markMoving();
    }
  }
  pipeline.render(scene, camera, time);

  fpsFrames++;
  fpsTime += wall;
  if (fpsTime > 0.5) {
    stats.fps.set(Math.round(fpsFrames / fpsTime));
    stats.spores.set(spores.count);
    fpsTime = 0;
    fpsFrames = 0;
  }
});
