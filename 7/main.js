import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, keysHelp, setDay, getSeed, applyUrlState, addKey, loadingStep } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Group, BufferGeometry, BufferAttribute, Vector2, Vector3, Matrix3, Quaternion, Color, SphereGeometry, Sphere, MathUtils } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { seededRandom } from "modules/random.js";
import { SHAPES, FAMILIES, shapeById } from "./shapes/index.js";
import { MODES, lightField, lightTables, LIGHT_CLEAR } from "./hollow.js";
import { PALETTES, FINISHES, lampUniforms, lampConfig, shellShared, createShellMaterial, createBulbMaterial, LampShadow } from "./materials.js";
import { createBackdrop } from "./backdrop.js";
import { LightPath } from "./lightpath.js";
import { createSketchLines, setSegments } from "./sketchLines.js";
import { createAutoChange } from "modules/autoChange.js";
import { Easings } from "easings";

// The pill fills while the studio loads, the shaders compile and the worker prepares and meshes the sculpture.
const load = { studio: loadingStep(1), compile: loadingStep(2), sculpture: loadingStep(5) };

const pipeline = new Pipeline(renderer, {
  background: 0xd6d3cd,
  exposure: 1.05,
  bloomStrength: 0.055,
  bloomRadius: 0.7,
  vignette: 0.22,
  saturation: 1.1,
  grain: 0.025,
  shadow: { autoFit: true, denoise: true },
  giOptions: { thickness: 0.5 },
});
const lite = ["low", "medium"].includes(pipeline.quality);
// Edge length of the surface mesh.
const EDGE = lite ? 0.016 : 0.011;
lampConfig.taps = lite ? 4 : 6;

// The sculpture fits a sphere of this radius and floats this far above the floor.
const SIZE = 0.68;
const LIFT = 0.16;
const BULB_R = 0.032;
const ENVELOPE = { radius: SIZE + 0.02, radiusX: SIZE + 0.02 };
const FLOOR_Y = 0;

const query = new URLSearchParams(location.search);
const touch = matchMedia("(pointer: coarse)").matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// A shape's sliders live in params as "<shape>_<key>".
const sliderKey = (def, sl) => `${def.id}_${sl.key}`;
function shapeSliderDefaults() {
  const out = {};
  for (const def of SHAPES) for (const sl of def.sliders ?? []) out[sliderKey(def, sl)] = sl.value;
  return out;
}
function shapeValues(id) {
  const def = shapeById(id), v = {};
  for (const sl of def?.sliders ?? []) v[sl.key] = params[sliderKey(def, sl)]();
  return v;
}
const formKey = (id) => JSON.stringify(shapeValues(id));

const defaults = {
  family: "random",
  shape: "random",
  ...shapeSliderDefaults(),
  cells: 240,
  variation: 0.6,
  strut: 0.2,
  roundness: 0.75,
  fillet: 1,
  thickness: 0.026,
  puff: 0.3,
  palette: "white",
  translucency: 0.5,
  finish: "porcelain",
  lamp: true,
  light: "pointer",
  lightGap: 0.06,
  brightness: 1,
  warmth: 2700,
  daylight: 0.45,
  flicker: 0.35,
  hollowTime: lite ? 12 : 9,
  spin: 0.35,
  auto: true,
  autoTime: 20,
};
const params = fromDefaults(defaults);

globalUniforms.aoIntensity.value = 1;
globalUniforms.aoPower.value = 1.2;
globalUniforms.aoMin.value = 0.08;
globalUniforms.aoDirect.value = 0.15;
globalUniforms.giIntensity.value = 1.4;
globalUniforms.aoColor.value.setRGB(0.05, 0.045, 0.04);
globalUniforms.lightSpecular.value = 0.35;
globalUniforms.specularShadow.value = 1;

// Soft window light from the right, a large dim fill on the left.
const studio = load.studio.track(createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(0.75, 0.62, 0.35),
  keyIntensity: 12,
  keySize: 0.7,
  fill: 0.22,
  fillColor: 0xe6ebf2,
  floor: 0.55,
  wall: 0.55,
  ceiling: 0.35,
  tint: 0xfbf8f3,
}));

const familyOf = (f) => SHAPES.filter((s) => s.family in FAMILIES && (f === "random" || s.family === f));
const shapeOptions = (f) => [["random", "random"], ...familyOf(f).map((s) => [s.id, s.name])];

// A random pick takes a family first, then a shape in it, favouring the strongest shapes. Always two draws.
const FAMILY_WEIGHT = { parametric: 1, warped: 1, fractal: 0.35 };
const SHAPE_WEIGHT = { associate: 0.4, riemann: 0.6, "riemann-elliptic": 0.6, supershape: 0.9, "klein-bottle": 0.7, roman: 0.5, crosscap: 0.6, boy: 1.3, costa: 0.8, enneper: 1.2, goursat: 1.3, borromean: 1.2, "torus-knot": 1.2, "knot-core": 0.7, chmutov: 0.7, menger: 0.6, sphereflake: 0.5, mandelbulb: 0.4, mobius: 1.8 };
function weighted(list, weight, u) {
  const total = list.reduce((s, x) => s + weight(x), 0);
  let t = u * total;
  for (const x of list) if ((t -= weight(x)) < 0) return x;
  return list[list.length - 1];
}
function pickShape(f) {
  const a = Math.random(), b = Math.random();
  const family = f === "random" ? weighted(Object.keys(FAMILIES), (k) => FAMILY_WEIGHT[k] ?? 1, a) : f;
  return weighted(familyOf(family), (s) => SHAPE_WEIGHT[s.id] ?? 1, b).id;
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
// Hover text for every control: what it does, and the randomize hint guspira shows when a label has no title.
const RND = " Click the name to randomize it.";
const tip = (text, opts = {}) => ({ ...opts, title: text + (opts.randomizable === false ? "" : RND) });
// Everything in Shape builds a new sculpture and hollows it from solid.
gui.addSection("Shape");
const shapeSelect = gui.addSelect("Shape", params.shape, shapeOptions(params.family()),
  tip("The solid that gets hollowed. Random picks one from the seed. Changing it shows a line sketch, then rebuilds and hollows the sculpture."));
// Randomize picks an actual shape (from the family, if one is chosen), so its name shows. A ?seed= url replays this
// before its params are applied, so the family then comes from the url.
let replaying = true;
shapeSelect.randomize = () => {
  const f = replaying ? query.get("family") ?? params.family() : params.family();
  params.shape.set(pickShape(f in FAMILIES ? f : "random"));
};
// Each shape's own sliders, shown while it is the shape on show.
for (const def of SHAPES)
  for (const sl of def.sliders ?? [])
    gui.addSlider(sl.name, params[sliderKey(def, sl)], sl.min, sl.max, sl.step ?? (sl.max - sl.min) / 200,
      tip(sl.tip + " Morphs the shape, then rebuilds.", { visibleWhen: () => resolveShape() === def.id }));
// The holes and the hollowing; these rebuild too.
gui.addSection("Hollowing");
// Randomize keeps the lattice open: more cells get thinner struts.
let randomCells = defaults.cells;
gui.addSlider("Cells", params.cells, 40, 1000, 1,
  tip("About how many holes the sculpture gets. More cells means smaller holes and a finer lattice. Rebuilds.")).randomize = () => params.cells.set((randomCells = Math.round(150 + Math.random() * 150)));
gui.addSlider("Variation", params.variation, 0, 1, 0.01,
  tip("How much hole sizes vary across the surface: 0 makes them all alike, 1 mixes big and small holes in patches. Rebuilds."));
gui.addSlider("Roundness", params.roundness, 0.1, 1, 0.01,
  tip("Shape of the holes: low values give polygonal holes with sharp corners, high values round ovals with webbed joints. Rebuilds.")).randomize = () => params.roundness.set(Math.round((0.5 + Math.random() * 0.5) * 100) / 100);
gui.addSlider("Hollow time", params.hollowTime, 1, 30, 0.5,
  tip("How many seconds the erosion takes, from solid skin to finished lattice. Applies the next time it hollows.", { randomizable: false }));
gui.addButton("Hollow again", () => rehollow()).el.title = "Replays the hollowing from a solid skin (or press H).";
// The rest change the finished sculpture in place.
gui.addSection("Look");
gui.addSlider("Strut", params.strut, 0.06, 0.45, 0.01,
  tip("Width of the struts between holes, relative to the cell size: higher values make wider struts and smaller holes. Re-cuts the lattice without hollowing again.")).randomize = () => {
  const top = 0.26 - ((randomCells - 150) / 150) * 0.05;
  params.strut.set(Math.round((0.15 + Math.random() * (top - 0.15)) * 100) / 100);
};
gui.addSlider("Fillet", params.fillet, 0.1, 1, 0.01,
  tip("How rounded the hole edges are: 1 is a full half-round, so struts read as tubes; lower values give flat bands with rounded edges.")).randomize = () => params.fillet.set(Math.round((0.85 + Math.random() * 0.15) * 100) / 100);
// Randomize keeps the struts round: as thick as they are wide, give or take.
gui.addSlider("Thickness", params.thickness, 0.012, 0.06, 0.001,
  tip("Wall thickness. Never more than the struts are wide: thick walls give chunky round struts, thin walls give delicate flat ones.")).randomize = () => params.thickness.set(Math.round((0.02 + Math.random() * 0.014) * 1000) / 1000);
gui.addSlider("Puff", params.puff, 0, 1, 0.01,
  tip("Swells each strut along its middle, so the struts look plump and pillowy instead of flat.")).randomize = () => params.puff.set(Math.round(Math.random() * 60) / 100);
gui.addSelect("Palette", params.palette, Object.keys(PALETTES), tip("The colour of the sculpture, and the backdrop that goes with it."));
gui.addSlider("Translucency", params.translucency, 0, 1, 0.01,
  tip("How much of the inner light shines through the walls: 0 is opaque, higher values make thin walls glow."));
gui.addSelect("Finish", params.finish, Object.keys(FINISHES),
  tip("The material: glossy glaze, satin plastic, matte porcelain, or wax that glows softly where it's thin."));
gui.addSlider("Tumble", params.spin, 0, 1, 0.01, tip("How fast the sculpture turns in the air. 0 holds it still.", { randomizable: false }));
gui.addSection("Light");
gui.addCheckbox("Glow", params.lamp, tip("Switches the light inside the sculpture on or off (or press L).", { randomizable: false }));
gui.addSelect("Light", params.light, ["fixed", "pointer"],
  tip("Where the inner light is. Fixed: it stays put while the sculpture turns around it, so the hole patterns sweep across the floor. Pointer: it follows the mouse (or a tap), finding its way through the holes.", { randomizable: false }));
gui.addSlider("Light distance", params.lightGap, 0, 0.15, 0.005,
  tip("How far the light keeps from the walls. It still squeezes through narrower holes on its way.", { randomizable: false }));
gui.addSlider("Brightness", params.brightness, 0, 2, 0.01, tip("Strength of the inner light.", { randomizable: false }));
gui.addSlider("Warmth", params.warmth, 1800, 4500, 50, tip("Colour of the inner light, in kelvin: low values are candle orange, high values neutral white."));
// Randomize picks a time of day: daylight with the glow on, or night.
gui.addSlider("Daylight", params.daylight, 0, 1, 0.01,
  tip("Brightness of the studio around it: 0 is night, where the inner light and its projected patterns take over; 1 is a bright studio.")).randomize = () => params.daylight.set(Math.random() < 0.5 ? Math.round((0.02 + Math.random() * 0.1) * 100) / 100 : Math.round((0.45 + Math.random() * 0.5) * 100) / 100);
gui.addSlider("Flicker", params.flicker, 0, 1, 0.01, tip("A gentle candle-like flicker of the inner light once the sculpture has opened.", { randomizable: false }));
gui.endSection();
// Kiosk mode: a new sculpture every Change every seconds, counted once one has finished hollowing.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, max: 120, ready: () => done && !previewing && morph.to === 1 && !morph.queued });
pipeline.addGUI(gui);
addKey("KeyH", "hollow it again", () => rehollow());
addKey("KeyL", "switch the glow on or off", () => params.lamp.set(!params.lamp()));
gui.addText(touch ? "Drag to orbit, pinch to zoom. With Light on pointer, tap to move the light." : `Drag to orbit, scroll to zoom. With Light on pointer, the light follows the mouse.<br/>${keysHelp()}`);
gui.show();

// A chosen shape outside the chosen family goes back to random.
let familySeen = params.family();
function syncFamily() {
  const f = params.family();
  if (f === familySeen) return;
  familySeen = f;
  shapeSelect.setOptions(shapeOptions(f));
  if (params.shape() !== "random" && !familyOf(f).some((s) => s.id === params.shape())) params.shape.set("random");
}

const scene = new Scene();
const backdrop = createBackdrop({ floorY: FLOOR_Y, color: 0xd6d3cd });
backdrop.mesh.renderOrder = 1;
scene.add(backdrop.mesh);

const shared = shellShared();
shared.displaceMax.value = EDGE * 2;
const shellMaterial = createShellMaterial(shared);
const lampShadow = new LampShadow(renderer, shared, lite ? 256 : 512);
const bulbMaterial = createBulbMaterial();

// The sculpture's own frame: it floats and tumbles, and the glow inside goes with it.
const hero = new Group();
scene.add(hero);
const bulb = new Mesh(new SphereGeometry(1, 32, 16), bulbMaterial);
bulb.userData.noShadow = true;
bulb.visible = false;
hero.add(bulb);
let shell = null;
let sculpture = null;

camera.near = 0.1;
camera.far = 60;
Object.assign(controls, { enablePan: false, minDistance: 1.6, maxDistance: 4.4, minPolarAngle: Math.PI * 0.12, maxPolarAngle: Math.PI * 0.53, enableDamping: true });

// The tumble keeps the long axis (x) roughly level, so a long shape is framed by its reach about that axis, plus
// the tilt the tumble gives it.
const reachUp = (m) => Math.min(m.radius, Math.max(m.radiusX ?? m.radius, 0.7 * m.radius));
const heightOf = (m) => reachUp(m) + LIFT;

// Frames the sculpture and the floor under it at any aspect. The fitted lens is kept across resizes (common resets
// the fov on every one), and a big change of aspect refits it, keeping the viewer's zoom.
let fit = null;
function frame(force = false) {
  if (!sculpture) return;
  const a = camera.aspect;
  if (force || !fit || Math.abs(a - fit.aspect) / a > 0.15) {
    const zoom = fit && !force ? camera.position.distanceTo(controls.target) / fit.d : 1;
    // The envelope of any sculpture (every shape is scaled to the same reach), so every shape fits the default view.
    const R = ENVELOPE.radius, H = heightOf(ENVELOPE) + reachUp(ENVELOPE);
    const side = a < 1 ? 0.18 : 0.3;
    const want = 4.1;
    // Narrow screens keep the bottom band clear for the collapsed GUI bar: the sculpture fits the rest, and the
    // lens is shifted to centre it there.
    const band = innerWidth <= 950 ? Math.min(0.25, 80 / Math.max(innerHeight, 1)) : 0;
    const k = 1 - band;
    const top = band > 0.1 ? 0.08 : 0.14;
    const tv = Math.min(Math.tan(MathUtils.degToRad(22.5)), Math.max(Math.tan(MathUtils.degToRad(13)), (H * 0.5 + top) / (want * k), (R + side) / (want * a)));
    const d = Math.max((H * 0.5 + top) / (tv * k), (R + side) / (tv * a));
    fit = { aspect: a, fov: MathUtils.radToDeg(2 * Math.atan(tv)), d, band };
    controls.target.set(0, FLOOR_Y + H * 0.5, 0);
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.32, 0.2, 1);
    camera.position.copy(controls.target).add(dir.setLength(MathUtils.clamp(d * zoom, controls.minDistance, controls.maxDistance)));
    camera.lookAt(controls.target);
  }
  camera.fov = fit.fov;
  if (fit.band > 0) camera.setViewOffset(innerWidth, innerHeight, 0, fit.band * innerHeight * 0.5, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
camera.position.set(0.32, 0.2, 1);
onResize((w, h, dpr) => {
  // Phones render at 1.5x at most, except for a 2x screenshot.
  if (lite && !query.has("dpr") && dpr <= window.devicePixelRatio) renderer.setPixelRatio(Math.min(dpr, 1.5));
  pipeline.setSize(w, h, renderer.getPixelRatio());
  frame();
});

// Workers: each keeps its own prepared field and they take turns meshing frames of the erosion. Each runs one job at
// a time with one waiting slot, so a newer request replaces a stale one instead of queueing behind it.
let jobId = 0;
const workers = Array.from({ length: (navigator.hardwareConcurrency ?? 4) >= (lite ? 6 : 4) ? 2 : 1 }, () => {
  const w = new Worker(new URL("./mesher.worker.js", import.meta.url), { type: "module" });
  const worker = { w, ms: 600, key: null, inflight: null, next: null, get busy() { return !!(this.inflight || this.next); } };
  w.onmessage = (e) => {
    if (e.data.progress !== undefined) return worker.inflight?.progress?.(e.data.progress);
    const job = worker.inflight;
    worker.inflight = null;
    if (!e.data.error) {
      worker.key = e.data.key;
      worker.ms = worker.ms * 0.5 + e.data.ms * 0.5;
    }
    job?.done(e.data);
    pump(worker);
  };
  w.onerror = (e) => {
    const job = worker.inflight;
    worker.inflight = null;
    job?.done({ error: e.message || "mesher failed to load" });
    pump(worker);
  };
  return worker;
});

function pump(worker) {
  if (worker.inflight || !worker.next) return;
  const job = worker.next;
  worker.next = null;
  worker.inflight = job;
  worker.w.postMessage({ ...job.msg, id: ++jobId });
}

function request(worker, msg, done, progress) {
  worker.next?.done({ stale: true });
  worker.next = { msg, done, progress };
  pump(worker);
}

function seeded(name, fn) {
  const r = Math.random;
  Math.random = seededRandom(`${getSeed()}:${name}`);
  try {
    return fn();
  } finally {
    Math.random = r;
  }
}

// "random" picks a shape by the seed, from the chosen family.
function resolveShape() {
  if (params.shape() !== "random") return params.shape();
  return seeded("shape", () => pickShape(params.family()));
}

const buildKey = () => [params.family(), params.shape(), formKey(resolveShape()), params.cells(), params.variation(), params.roundness(), getSeed()].join();
const lookKey = () => [params.strut(), params.fillet(), params.thickness(), params.puff()].join();
const look = () => ({ strut: params.strut(), fillet: params.fillet(), thickness: params.thickness(), puff: params.puff() });

let desc = null;
let token = 0;
let shownE = -1;
let shownLook = null;
let hollowT = 0;
let clock = 0;
let done = false;
let doneAt = 0;
let lastAsked = 0;
let pending = [];
let solid = null;
let ready = false;
let tumble = 0;
let firstMesh;
const firstMeshReady = new Promise((r) => (firstMesh = r));

function makeDesc() {
  const shape = resolveShape();
  const [seed, count] = seeded("sculpture", () => [Math.floor(Math.random() * 2 ** 31), Math.random() < 0.5 ? 2 : 3]);
  // The camera's direction in the sculpture's resting frame, so the erosion starts on the side in view.
  const v = camera.position.clone().sub(controls.target).normalize();
  return {
    key: buildKey(),
    seed,
    shape,
    form: formKey(shape),
    values: shapeValues(shape),
    mode: "single",
    count,
    cells: params.cells(),
    variation: params.variation(),
    roundness: params.roundness(),
    h: EDGE,
    size: SIZE,
    view: [v.x, v.y, v.z],
    lite,
  };
}

// The glow, in the sculpture's frame (shared.bulbLocal): at the interior point, held still in the room while the
// sculpture turns about it, or following the pointer. It keeps clear of the walls by the distance grid.
const lamp = {
  pos: shared.bulbLocal.value,
  home: new Vector3(),
  fixed: new Vector3(),
  target: new Vector3(),
  at: null,
  g: 0.02,
  homeClear: Infinity,
  layerT: 1,
  cubePos: new Vector3(),
  tablesPos: new Vector3(),
  last: new Vector3(),
  movedAt: -1,
  bulbR: 0.03,
  // Where the light rests in the room (world coordinates) when the pointer isn't moving it.
  hold: new Vector3(),
  world: new Vector3(),
  placedWorld: false,
  placed: false,
  // The way through the open lattice: a planner over its clearance grid, the planned points and when.
  pass: null,
  way: null,
  wayAt: -1,
  wayTarget: new Vector3(),
};
const pointer = { ndc: new Vector2(), active: false, last: -1e9 };
const _n = new Vector3(), _d = new Vector3(), _w = new Vector3(), _c = new Vector3();

// How close the light may come to a wall's mid-surface: half the wall and its crown, the bulb, and a margin.
function lampClear() {
  const half = 0.5 * params.thickness() * lamp.layerT * (1 + 0.6 * params.puff());
  return Math.min(lamp.homeClear, Math.max(LIGHT_CLEAR, half + lamp.bulbR + 0.015));
}

// Moves p out of the walls along the distance grid.
function keepClear(p, c) {
  const at = lamp.at;
  const h = 0.5 * lamp.g;
  for (let i = 0; i < 6; i++) {
    const d = at(p.x, p.y, p.z);
    if (d >= c) break;
    _n.set(at(p.x + h, p.y, p.z) - at(p.x - h, p.y, p.z), at(p.x, p.y + h, p.z) - at(p.x, p.y - h, p.z), at(p.x, p.y, p.z + h) - at(p.x, p.y, p.z - h));
    if (_n.lengthSq() < 1e-14) _n.copy(p).sub(lamp.home);
    if (_n.lengthSq() < 1e-14) _n.set(0, 1, 0);
    p.addScaledVector(_n.normalize(), c - d + 0.001);
  }
  return p;
}

// One eased step of the light toward its (clear) target; a step into a wall slides along it.
function stepLamp(p, T, k, c) {
  _w.copy(p).lerp(T, k);
  if (_w.distanceTo(T) < 0.002) return p.copy(T);
  if (lamp.at(_w.x, _w.y, _w.z) >= c) return p.copy(_w);
  keepClear(_w, c);
  // Pressed against a wall, it rests instead of trembling there.
  if (_w.distanceToSquared(p) > 1e-6) p.copy(_w);
  return p;
}

// Once the lattice is open the light travels along a planned way through the holes, never across a wall: it heads
// for the furthest point of the way it can see, and the bulb shrinks to squeeze through narrow openings.
const PASS_MIN = 0.012;
const _a = [0, 0, 0], _b = [0, 0, 0];
function followWay(rate, dt, now) {
  const P = lamp.pass, p = lamp.pos, T = lamp.target;
  const c = PASS_MIN + 0.003;
  // The room it keeps from the walls; narrower ways are only for squeezing through holes.
  const keep = Math.max(c, params.lightGap());
  backOff(T, keep);
  // The light holds its place in the room while the sculpture turns, so a strut can sweep into it: out it goes.
  backOff(p, c);
  const replan = !lamp.way || (now - lamp.wayAt > 0.15 && (T.distanceTo(lamp.wayTarget) > 3 * P.g || now - lamp.wayAt > 1));
  if (replan) {
    lamp.way = P.plan([p.x, p.y, p.z], [T.x, T.y, T.z], c, keep);
    lamp.wayAt = now;
    lamp.wayTarget.copy(T);
    if (!lamp.way) return;
  }
  _a[0] = p.x; _a[1] = p.y; _a[2] = p.z;
  _b[0] = T.x; _b[1] = T.y; _b[2] = T.z;
  // Past the grid's box, or with nothing in between, it goes straight.
  const room0 = P.at(..._a);
  if (P.at(..._b) >= keep && P.clear(_a, _b, Math.min(keep, room0))) lamp.way = [[T.x, T.y, T.z]];
  const way = lamp.way;
  // Shortcuts keep the full distance where it has it, so it doesn't cut close past a strut.
  let j = 0;
  for (let k = Math.min(way.length - 1, 16); k > 0; k--) {
    if (P.clear(_a, way[k], Math.max(c, Math.min(keep, room0)))) { j = k; break; }
  }
  if (j > 0) way.splice(0, j);
  let rest = Math.hypot(way[0][0] - p.x, way[0][1] - p.y, way[0][2] - p.z);
  for (let k = 1; k < way.length; k++) rest += Math.hypot(way[k][0] - way[k - 1][0], way[k][1] - way[k - 1][1], way[k][2] - way[k - 1][2]);
  // This frame's distance, spent along the way: past a waypoint it carries on to the next one.
  let budget = Math.min(1.2, rate * rest) * dt;
  while (budget > 0 && way.length) {
    const aim = way[0];
    const d = Math.hypot(aim[0] - p.x, aim[1] - p.y, aim[2] - p.z);
    const s = Math.min(d, budget);
    if (d > 1e-9) {
      _b[0] = p.x + ((aim[0] - p.x) * s) / d; _b[1] = p.y + ((aim[1] - p.y) * s) / d; _b[2] = p.z + ((aim[2] - p.z) * s) / d;
      if (!(P.at(..._b) >= c || P.at(..._b) >= P.at(p.x, p.y, p.z))) break;
      p.set(_b[0], _b[1], _b[2]);
    }
    budget -= s;
    // Close enough to a waypoint (the sculpture's bob moves it a hair every frame): on to the next.
    if (d - s < 0.25 * P.g && way.length > 1) way.shift();
    else if (d - s < 1e-6) break;
  }
  const room = P.at(p.x, p.y, p.z) - 0.004;
  const r = Math.min(lamp.bulbR, Math.max(PASS_MIN, room));
  bulb.scale.setScalar(bulb.scale.x + (r - bulb.scale.x) * Math.min(1, 12 * dt));
}

// Moves a target out to the kept distance from the walls, along the clearance grid.
function backOff(T, keep) {
  const P = lamp.pass, h = P.g;
  for (let i = 0; i < 8; i++) {
    const d = P.at(T.x, T.y, T.z);
    if (d >= keep) return;
    _n.set(P.at(T.x + h, T.y, T.z) - P.at(T.x - h, T.y, T.z), P.at(T.x, T.y + h, T.z) - P.at(T.x, T.y - h, T.z), P.at(T.x, T.y, T.z + h) - P.at(T.x, T.y, T.z - h));
    if (_n.lengthSq() < 1e-14) return;
    T.addScaledVector(_n.normalize(), keep - d + 0.002);
  }
}

// The penumbra tables for the light where it is: the interior point's own, or measured from there.
function lampTables() {
  const p = lamp.pos;
  let t = sculpture;
  const axis = lampUniforms.lampAxis.value.set(0, 1, 0);
  if (lamp.at && p.distanceTo(lamp.home) > 1e-4) {
    // Off the interior point, the rays are binned about the direction to the centre.
    if (p.length() > 0.05) axis.copy(p).negate().normalize();
    t = lightTables(lamp.at, lamp.g, SIZE, [p.x, p.y, p.z], [axis.x, axis.y, axis.z]);
  }
  lampUniforms.lampShell.value = t.shell * 0.9;
  lampUniforms.lampOpen.value = t.open ?? 0;
  for (let k = 0; k <= 16; k++) lampUniforms.lampOcc.value[k] = t.occ[k];
}

// Puts the glow at the sculpture's interior point, with the distances its penumbra is measured from.
function setSculpture(meta, grid) {
  sculpture = meta;
  const [x, y, z] = meta.interior;
  lamp.home.set(x, y, z);
  // Only the first sculpture places the light; after that it stays where it is in the room.
  if (!lamp.placed) {
    lamp.placed = true;
    lamp.pos.copy(lamp.home);
    lamp.last.copy(lamp.home);
    lamp.tablesPos.copy(lamp.home);
    lamp.hold.copy(lamp.home).applyQuaternion(hero.quaternion);
    lamp.hold.y += FLOOR_Y + heightOf(meta);
  }
  lamp.at = grid ? lightField(grid) : null;
  lamp.g = grid?.g ?? 0.02;
  lamp.homeClear = lamp.at ? lamp.at(x, y, z) : Infinity;
  lamp.layerT = Math.max(...MODES[desc.mode].slice(0, meta.layers).map((l) => l.thick));
  bulb.position.copy(lamp.pos);
  // One bulb size for every shape.
  lamp.bulbR = BULB_R;
  bulb.scale.setScalar(lamp.bulbR);
  lamp.pass = null;
  lamp.way = null;
  bulb.visible = true;
  // The fixed light: the clear point nearest the centre on the way to the interior point.
  const c = lampClear();
  lamp.fixed.copy(lamp.home);
  for (let i = 0; i < 10 && lamp.at; i++) {
    _w.copy(lamp.home).multiplyScalar(i / 10);
    if (lamp.at(_w.x, _w.y, _w.z) >= c + 0.01) {
      lamp.fixed.copy(_w);
      break;
    }
  }
  lampUniforms.lampRadius.value = BULB_R / 1.1;
  lampTables();
  applyLook();
  // Only the first sculpture frames the camera; after that the view stays where the viewer left it.
  if (!fit) frame(true);
}

// Desktop: the light follows the mouse while it hovers with no button down. Touch: a tap (not a drag, not two
// fingers) places it.
{
  const canvas = renderer.domElement;
  const touches = new Map();
  const toNdc = (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    pointer.active = true;
    pointer.last = performance.now() / 1000;
  };
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") {
      const t = touches.get(e.pointerId);
      if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) t.drag = true;
    } else if (!e.buttons) toNdc(e);
  });
  canvas.addEventListener("pointerleave", (e) => {
    // Off the canvas (over the panel, say) the light stays at the last position the pointer gave it.
    if (e.pointerType !== "touch") pointer.last = performance.now() / 1000;
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, drag: touches.size > 0 });
    if (touches.size > 1) for (const t of touches.values()) t.drag = true;
  });
  const lift = (e) => {
    const t = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if (e.type === "pointerup" && t && !t.drag && !touches.size && e.timeStamp - t.t < 400) toNdc(e);
  };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);
}

// Where the light is headed, in the sculpture's frame, and how fast it eases there.
function lampTarget(now) {
  const T = lamp.target;
  const mode = params.light();
  if (mode === "fixed") {
    T.copy(lamp.fixed).applyQuaternion(qa.copy(hero.quaternion).invert());
    return 10;
  }
  // Worked out in the room, anchored to the orbit target rather than the sculpture, so a new shape or its float
  // height never moves the light. Never closer to the floor than Light distance.
  const floorY = FLOOR_Y + Math.max(params.lightGap(), 0.02) + lamp.bulbR;
  const tracking = mode === "pointer" && pointer.active;
  if (tracking) {
    // The pointer on a plane through the orbit target, facing the camera.
    _d.set(pointer.ndc.x, pointer.ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
    camera.getWorldDirection(_n);
    const t = _w.copy(controls.target).sub(camera.position).dot(_n) / Math.max(_d.dot(_n), 1e-3);
    _w.copy(camera.position).addScaledVector(_d, t).sub(controls.target).clampLength(0, 4).add(controls.target);
    lamp.hold.copy(_w);
  } else _w.copy(lamp.hold);
  _w.y = Math.max(_w.y, floorY);
  hero.worldToLocal(T.copy(_w));
  return tracking ? 6 : 2.5;
}

let lampDirty = true;
function install(data) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.position, 3));
  g.setAttribute("normal", new BufferAttribute(data.normal, 3));
  g.setAttribute("shellData", new BufferAttribute(data.data, 4));
  g.setAttribute("shellVel", new BufferAttribute(data.vel, 3));
  g.setIndex(new BufferAttribute(data.index, 1));
  g.boundingSphere = new Sphere(new Vector3(), sculpture.radius + 0.08);
  if (!shell) {
    shell = new Mesh(g, shellMaterial);
    hero.add(shell);
  } else {
    shell.geometry.dispose();
    shell.geometry = g;
  }
  shared.meshErosion.value = data.E;
  if (data.passGrid) {
    const grid = data.passGrid;
    lamp.pass = new LightPath(grid, lightField(grid));
    lamp.way = null;
  }
  shownE = data.E;
  lampShadow.setGeometry(g);
  lampDirty = true;
  shell.userData.from = data;
}

// Starts the erosion over from the solid skin; meshes still on their way from before are ignored. A new sculpture
// keeps the old one on show until its solid skin has been meshed.
let buildProgress = 0;
function restart() {
  buildProgress = 0;
  lamp.pass = null;
  lamp.way = null;
  token++;
  hollowT = 0;
  failures = 0;
  done = false;
  lastAsked = 0;
  pending = [];
  if (solid?.key === desc.key && solid.look === lookKey()) {
    const again = () => {
      install(solid);
      shownLook = lookKey();
      ready = true;
    };
    if (morph.to === 0 || morph.queued) morph.queued = { solid: again };
    else again();
    return;
  }
  ready = false;
  const t = token;
  const lk = lookKey();
  let tries = 0;
  const ask = () =>
    request(workers[0], { desc, E: 0, look: look() }, (d) => {
      if (d.stale || t !== token) return;
      if (d.error) {
        console.warn("Hollow mesher:", d.error);
        return ++tries < 3 ? ask() : firstMesh();
      }
      onSolid(d);
    }, (f) => {
      buildProgress = f;
      load.sculpture.set(0.85 * f);
    });
  // A finished build waits behind a shape change under way (shrink, backdrop, material), then grows in.
  const onSolid = (d) => {
    if (morph.to === 0 || morph.queued) {
      morph.queued = { solid: () => showSolid(d) };
      return;
    }
    showSolid(d);
  };
  const showSolid = (d) => {
    hideSketch();
    morph.shown = shapeOf(desc);
    lines.lastShape = `${desc.shape}:${desc.form}`;
    // Warms the sketch worker with this shape, so the first sketch comes quickly.
    if (!sketcher.warm) {
      sketcher.warm = true;
      sketcher.want = { ...makeDesc(), sketch: true };
      askSketch();
    }
    solid = d;
    solid.look = lk;
    setSculpture(d.meta, d.lightGrid);
    install(d);
    shownLook = lookKey();
    ready = true;
    firstMesh();
    schedule();
  };
  ask();
}

// While the Shape settings change, a sketch follows them live: the plain shape, lit like the sculpture, with the
// holes it will open drawn on it as bright outlines. The sculpture is built and hollows once they have settled.
const SETTLE = 1.2;
// How long the settings must rest before the hole outlines are worked out and fade in.
const LINE_DELAY = 0.45;
const lines = { key: null, shape: null, lastShape: null, alpha: 0, changedAt: -1, leaving: false };
// The shape and its own slider values, without the hole settings.
const currentShapeKey = () => {
  const id = resolveShape();
  return `${id}:${formKey(id)}`;
};
// The outlines are a plain material, which the pipeline draws in its main pass only, nudged toward the camera.
const sketchFront = createSketchLines({ color: new Color(2.4, 2.2, 1.9), opacity: 1, width: 1.1, depthTest: true });
// Their glow: a wide soft halo on the same segments, added on top.
const sketchGlow = createSketchLines({ color: new Color(1, 0.8, 0.55), opacity: 1, width: 7, depthTest: true, soft: true });
sketchGlow.renderOrder = 2;
// A new shape stands in as a coarse solid skin in the sculpture's own material, so the glow comes through it too.
const sketchSurface = new Mesh(new BufferGeometry(), shellMaterial);
sketchFront.renderOrder = 1;
const sketchRes = new Vector2();
for (const m of [sketchFront, sketchGlow, sketchSurface]) {
  m.visible = false;
  m.frustumCulled = false;
  hero.add(m);
}
const sketcher = { w: new Worker(new URL("./mesher.worker.js", import.meta.url), { type: "module" }), busy: false, want: null, shown: null };
sketcher.w.onmessage = (e) => {
  sketcher.busy = false;
  // A sketch of another shape than the one now wanted (computed before a change) is dropped, never shown.
  if (!e.data.error && previewing && e.data.shape === resolveShape()) showSketch(e.data);
  askSketch();
};
let previewing = false;
// A change of shape shrinks the sculpture away and grows the new one in, both eased.
const morph = { s: 1, from: 1, to: 1, t: 1, dur: 1, ease: Easings.Linear, queued: null, shown: null, last: performance.now() };
function scaleTo(to, dur, ease) {
  if (morph.to === to) return;
  Object.assign(morph, { from: morph.s, to, t: 0, dur, ease });
}
function stepMorph() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - morph.last) / 1000);
  morph.last = now;
  if (morph.t < morph.dur) {
    morph.t = Math.min(morph.dur, morph.t + dt);
    morph.s = morph.from + (morph.to - morph.from) * morph.ease(morph.t / morph.dur);
  }
  // Shrunk away: the backdrop fades to the new palette, the new material goes on, and the new shape grows in.
  if (morph.queued && morph.to === 0 && morph.t >= morph.dur) {
    if (!morph.fade) morph.fade = { t: 0 };
    const f = morph.fade;
    f.t += dt;
    bgTarget.setHex(PALETTES[params.palette()].backdrop);
    // Most of the way there is enough; the rest of the fade carries on while the new shape grows in.
    if (Math.abs(bgNow.r - bgTarget.r) + Math.abs(bgNow.g - bgTarget.g) + Math.abs(bgNow.b - bgTarget.b) < 0.04 || f.t > 0.9) {
      const d = morph.queued;
      morph.queued = null;
      morph.fade = null;
      paletteKey = null;
      applyLook();
      // A finished build goes in as it is, and a sketch if it is still the preview or the shape being built. Anything
      // else is out of date: nothing grows in until the build's own solid arrives, so the old shape never comes back.
      if (d.solid) d.solid();
      else if (previewing || (desc && d.shape === desc.shape && d.form === desc.form)) applySketch(d);
      else return;
      scaleTo(1, 0.6, (t) => Easings.OutBack(t, 1.2));
    }
  }
  // The sculpture, the sketch and the glow's copy of the sculpture scale; the light stays where it is.
  const sc = Math.max(1e-3, morph.s);
  for (const m of [shell, sketchSurface, sketchFront, sketchGlow, lampShadow.mesh]) m?.scale.setScalar(sc);
  // The outlines keep their width in pixels, so as the shape shrinks they fade, or they'd gather into a bright dot.
  // They fade in once the changes rest and the outlines are for the current settings, and out as soon as they change.
  const showLines = !lines.leaving && lines.shape === currentShapeKey() && now / 1000 - lines.changedAt > LINE_DELAY;
  lines.alpha += ((showLines ? 1 : 0) - lines.alpha) * Math.min(1, dt * 6);
  sketchFront.material.uniforms.opacity.value = lines.alpha * MathUtils.smoothstep(sc, 0.15, 0.6);
  sketchGlow.material.uniforms.opacity.value = 0.55 * sketchFront.material.uniforms.opacity.value;
  if (lines.leaving && lines.alpha < 0.01) {
    sketchFront.visible = false;
    lines.leaving = false;
  }
  sketchGlow.visible = sketchFront.visible;
  if (morph.t < morph.dur) lampDirty = true;
}
// A new shape shrinks out and grows in; the same shape with other slider values morphs in place.
const shapeOf = (d) => d.shape;
// The backdrop eases toward its palette's colour; the light's settings ease too.
const bgTarget = new Color(), bgNow = new Color();
let bgSet = false;
const eased = { day: null, warmth: null, bright: null };

function askSketch() {
  if (sketcher.busy || !sketcher.want) return;
  const d = sketcher.want;
  // The same shape as the sculpture on show: the outlines go onto it, so they take its exact frame.
  if (sculpture?.frame && desc && d.shape === desc.shape && d.form === desc.form) d.frame = sculpture.frame;
  if (morph.shown && shapeOf(d) !== morph.shown) scaleTo(0, 0.35, Easings.InCubic);
  else if (morph.to === 0 && !morph.queued) scaleTo(1, 0.4, Easings.OutCubic);
  sketcher.want = null;
  sketcher.busy = true;
  sketcher.shown = d.key + (d.noLines ? "" : "#lines");
  sketcher.w.postMessage({ id: 0, desc: d, E: 0, look: look() });
}
function preview() {
  previewing = true;
  // A finished build still waiting behind a transition is out of date now.
  if (morph.queued?.solid) morph.queued = null;
  // The open lattice's clearance is no longer the shape on show: until the new one opens, the light goes straight.
  lamp.pass = null;
  lamp.way = null;
  // Stops the hollowing in progress; its meshes are ignored from here on.
  token++;
  ready = false;
  done = false;
  pending = [];
  // Hole settings alone change the outlines but not the shape: those are drawn straight away.
  sketcher.want = { ...makeDesc(), sketch: true, noLines: performance.now() / 1000 - lines.changedAt <= LINE_DELAY };
  askSketch();
}
function showSketch(d) {
  if (morph.shown && shapeOf(d) !== morph.shown) {
    morph.queued = d;
    scaleTo(0, 0.35, Easings.InCubic);
    return;
  }
  morph.queued = null;
  applySketch(d);
}
function applySketch(d) {
  morph.shown = shapeOf(d);
  morph.size = { radius: d.radius, radiusX: d.radiusX };
  // Outlines only come with a rested request; until then the old ones fade out where they are.
  if (d.lines.length) {
    setSegments(sketchFront, d.lines);
    sketchGlow.geometry = sketchFront.geometry;
    lines.key = d.key;
    lines.shape = `${d.shape}:${d.form}`;
    lines.leaving = false;
  }
  sketchFront.visible = true;
  // The same shape as the sculpture on show: the outlines go straight onto its solid skin.
  if (solid && desc && d.shape === desc.shape && d.form === desc.form) {
    if (shell.userData.from !== solid) install(solid);
    shell.visible = true;
    sketchSurface.visible = false;
    return;
  }
  sketchSurface.geometry.dispose();
  sketchSurface.geometry = new BufferGeometry();
  sketchSurface.geometry.setAttribute("position", new BufferAttribute(d.surface, 3));
  sketchSurface.geometry.setAttribute("normal", new BufferAttribute(d.normal, 3));
  sketchSurface.geometry.setIndex(new BufferAttribute(d.index, 1));
  const n = d.surface.length / 3, data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { data[i * 4] = 1; data[i * 4 + 2] = 0.5 * params.thickness(); }
  sketchSurface.geometry.setAttribute("shellData", new BufferAttribute(data, 4));
  sketchSurface.geometry.setAttribute("shellVel", new BufferAttribute(new Float32Array(n * 3), 3));
  sketchSurface.geometry.computeBoundingSphere();
  sketchSurface.visible = true;
  if (shell) shell.visible = false;
  // The glow stays on, now lighting through the new shape: it measures wall thickness between an entering and a
  // leaving face, so it gets the skin with its inner face too, a wall's thickness in and wound the other way.
  const thk = params.thickness(), P = d.surface, Nn = d.normal, I = d.index;
  const P2 = new Float32Array(n * 6);
  P2.set(P);
  for (let i = 0; i < n * 3; i++) P2[n * 3 + i] = P[i] - Nn[i] * thk;
  const I2 = new Uint32Array(I.length * 2);
  I2.set(I);
  for (let t = 0; t < I.length; t += 3) { I2[I.length + t] = I[t] + n; I2[I.length + t + 1] = I[t + 2] + n; I2[I.length + t + 2] = I[t + 1] + n; }
  const lg = new BufferGeometry();
  lg.setAttribute("position", new BufferAttribute(P2, 3));
  lg.setIndex(new BufferAttribute(I2, 1));
  lampShadow.setGeometry(lg);
  lampDirty = true;
}
// The sculpture takes over from the sketch: the coarse surface goes at once (they match), the outlines fade out.
function hideSketch() {
  sketchSurface.visible = false;
  if (shell) shell.visible = true;
  if (sketchFront.visible) lines.leaving = true;
}

function build() {
  previewing = false;
  desc = makeDesc();
  solid = null;
  restart();
}

function rehollow() {
  if (desc && ready) restart();
}

// A mesh that failed or was dropped is asked for again; after a few failures in a row the erosion stops at the
// last mesh.
let failures = 0;
function accept(t, data) {
  if (t !== token) return;
  if (data.error && ++failures >= 4) {
    console.warn("Hollow mesher gave up:", data.error);
    done = true;
    doneAt = clock;
    pending = [];
    return;
  }
  if (data.stale || data.error) {
    if (data.error) console.warn("Hollow mesher:", data.error);
    lastAsked = Math.max(shownE, ...pending.map((p) => p.E));
    return;
  }
  failures = 0;
  if (data.E > shownE) pending.push(data);
}

const hollowDelay = 0.7;
const erosionAt = (t) => {
  const T = Math.max(params.hollowTime(), 0.1);
  const u = Math.min(1, Math.max(0, (t - hollowDelay) / T));
  return u * u * (3 - 2 * u) * 0.6 + u * 0.4;
};

// How far a mesh may land past the last one, and how far the erosion may run ahead of the newest mesh. Slow meshing
// slows the erosion down rather than letting it jump. The step follows Hollow time, so a slow hollowing still gets a
// new mesh about every 0.15 s and the holes grow without visible jumps.
const stepE = () => {
  const max = lite && workers.length === 1 ? 0.05 : 0.025;
  return Math.min(max, Math.max(lite ? 0.008 : 0.004, 0.2 / Math.max(params.hollowTime(), 0.1)));
};
const leadE = () => Math.max(0.01, 1.2 * stepE());

function schedule() {
  if (!desc || done || !ready) return;
  const t = token;
  for (const w of workers) {
    if (w.busy) continue;
    // A second worker starts preparing once the first has a field, so they don't both prepare at once.
    if (w !== workers[0] && w.key !== desc.key && workers[0].key !== desc.key) continue;
    // Meshes go out a full step apart, until the newest is ahead of where the clock will be when this one lands.
    const base = Math.max(lastAsked, shownE, ...pending.map((p) => p.E));
    if (base >= 1 || base > erosionAt(hollowT + (w.ms / 1000) * 1.5 + 0.2)) continue;
    let E = Math.min(1, base + stepE());
    if (E > 0.99) E = 1;
    lastAsked = E;
    request(w, { desc, E, look: look() }, (d) => accept(t, d));
  }
}

// Advances the erosion, slowing it near the newest mesh, and installs a mesh once the erosion reaches it.
function advance(dt) {
  if (done || !desc || !ready) return;
  const lead = leadE();
  const cap = Math.max(shownE, ...pending.map((p) => p.E)) + lead;
  const now = erosionAt(hollowT);
  hollowT += dt * Math.min(1, Math.max(0, (cap - now) / (0.5 * lead)));
  const e = erosionAt(hollowT);
  let best = null;
  for (const p of pending) if (p.E <= e + 1e-6 && (!best || p.E > best.E)) best = p;
  if (!best) return;
  pending = pending.filter((p) => p.E > best.E);
  install(best);
  if (best.E >= 1) {
    done = true;
    doneAt = clock;
    pending = [];
    autoChange.restart();
  }
}

// Changing the struts after the sculpture has opened re-meshes it fully open.
let lookAt = 0;
let lookSeen = null;
// Real time, so it also applies while paused. Mid-hollowing, the meshes still to come take the new values; the one on
// show is cut again with them (that matters while paused, when no new mesh comes).
function relook() {
  if (!desc || !ready) return;
  const key = lookKey();
  const now = performance.now() / 1000;
  if (key !== lookSeen) {
    lookSeen = key;
    lookAt = now;
  }
  if (key === shownLook || now - lookAt < 0.2) return;
  const w = workers.find((w) => !w.busy);
  if (!w) return;
  shownLook = key;
  const t = token;
  const E = done ? 1 : shownE;
  if (!done) {
    pending = [];
    lastAsked = shownE;
  }
  relooking = true;
  request(w, { desc, E, look: look() }, (d) => {
    relooking = false;
    if (!d.stale && !d.error && t === token && (done || d.E >= shownE)) install(d);
  });
}
let relooking = false;

// The status pill: what is changing right now, filled with its progress where there is one.
const statusEl = document.querySelector("#status");
let statusText = "";
function showStatus() {
  let text = "", progress = 0;
  if (previewing) text = sketcher.busy || sketcher.want ? "Sketching…" : "Hollows when you stop";
  else if (desc && !ready) [text, progress] = ["Building…", buildProgress];
  else if (desc && !done) [text, progress] = ["Hollowing…", erosionAt(hollowT)];
  else if (relooking || (done && lookKey() !== shownLook)) text = "Updating struts…";
  // Not over the loading screen.
  if (document.querySelector("#loading")) text = "";
  if (text && text !== statusText) statusEl.textContent = text;
  if (text !== statusText) statusEl.classList.toggle("shown", !!text);
  statusText = text;
  statusEl.style.setProperty("--progress", progress.toFixed(3));
}

// Colour of a black body at K kelvin (Tanner Helland's fit), in linear RGB, normalised to unit luminance.
function kelvin(K) {
  const t = K / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = new Color().setRGB(...[r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255), "srgb");
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.multiplyScalar(1 / lum);
}

// Inner layers are a touch paler and glow more, so the depth reads by brightness.
const hsl = {};
const tint = new Color();
// The sketch's outlines glow: a bright warm white well past 1, so they bloom on any palette.
function sketchColor() {
  return new Color(1, 0.93, 0.8).multiplyScalar(5);
}

function applyLook() {
  const pal = PALETTES[params.palette()];
  sketchFront.material.uniforms.color.value.copy(sketchColor());
  const fin = FINISHES[params.finish()];
  const kinds = sculpture?.kinds ?? [0];
  // Flat-faced shapes catch the key evenly and would clip to white.
  const albedo = (desc && shapeById(desc.shape)?.albedo) ?? 1;
  const white = new Color(1, 1, 1);
  const u = shellMaterial.uniforms;
  for (let i = 0; i < 3; i++) {
    const kind = kinds[i] ?? 0;
    const glass = kind === 1 || (pal.glassInner && i > 0);
    const c = u.layerColor.value[i];
    c.setHex(glass ? pal.glass : pal.shell);
    if (!glass) {
      c.getHSL(hsl);
      c.setHSL(hsl.h, Math.min(1, hsl.s * fin.sat), hsl.l);
      c.multiplyScalar(fin.value);
      if (fin.tint) c.multiply(tint.setHex(fin.tint));
      if (i > 0) c.lerp(white, 0.12 * i);
      c.multiplyScalar(albedo);
    }
    u.layerRough.value[i] = glass ? 0.06 : fin.rough;
    u.layerGlass.value[i] = glass ? 1 : 0;
    u.layerGlow.value[i] = glass ? 1 : (1 + 0.7 * i) * fin.glow;
    const k = 1 - params.translucency();
    const sigma = lampUniforms.lampSigma.value[i];
    if (glass) sigma.set(3, 14, 42).multiplyScalar(0.6 + 1.2 * k);
    else sigma.set(0.9, 1, 1.15).multiplyScalar((24 + 70 * k) * (pal.sigma ?? 1) * fin.sigma * (1 - 0.2 * i));
  }
  shellMaterial.sheen = fin.sheen;
  u.transmission.value.setHex(0xffd9b0).multiplyScalar(fin.transmission);
  u.finishSpecular.value = fin.specular;
  u.finishWax.value = fin.wax;
  u.finishGlaze.value = fin.glaze;
  bgTarget.setHex(pal.backdrop);
  // The first look is set outright, under the loading screen.
  if (!bgSet) {
    bgNow.copy(bgTarget);
    bgSet = true;
  }
}


onRandomize(() => gui.randomizeAll());
applyUrlState();
replaying = false;
syncFamily();
shapeSelect.setOptions(shapeOptions(params.family()));
build();
await studio;
const keyColor = globalUniforms.lightColor.value.clone();
let envBase = globalUniforms.envIntensity.value;
// Shaders compile against a stand-in skin with the real attributes while the worker prepares the first mesh.
if (!shell) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("shellData", new BufferAttribute(new Float32Array(12), 4));
  g.setAttribute("shellVel", new BufferAttribute(new Float32Array(9), 3));
  g.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  g.boundingSphere = new Sphere(new Vector3(), 1);
  shell = new Mesh(g, shellMaterial);
  hero.add(shell);
  lampShadow.setGeometry(g);
}
const bulbShown = bulb.visible;
bulb.visible = true;
// The sketch's materials too, so the first sketch doesn't stall on them.
{
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  sketchSurface.geometry = g;
  setSegments(sketchFront, new Float32Array(6));
  sketchGlow.geometry = sketchFront.geometry;
}
const sketchShown = sketchFront.visible;
sketchSurface.visible = sketchFront.visible = sketchGlow.visible = true;
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), lampShadow.compileAsync()]), 3);
bulb.visible = bulbShown || !!sculpture;
sketchSurface.visible = sketchFront.visible = sketchGlow.visible = sketchShown;
await firstMeshReady;
load.sculpture.done();

window.app = {
  canvas: renderer.domElement,
  pipeline,
  params,
  controls,
  state: () => ({ shownE, done, ready, erosion: erosionAt(hollowT), pending: pending.length, workers: workers.map((w) => Math.round(w.ms)), shape: desc?.shape, meta: sculpture }),
  rehollow,
  // For scripted capture: set a look's values (any params) and go straight to it: the sculpture on show shrinks
  // away, the new one is built and grows in, then hollows. No sketch preview.
  nextLook(look = {}) {
    for (const [k, v] of Object.entries(look)) params[k]?.set(v);
    const key = buildKey();
    wantedKey = pendingKey = key;
    keyChangedAt = performance.now() / 1000;
    previewing = false;
    scaleTo(0, 0.35, Easings.InCubic);
    build();
  },
  // Parks the light at a room position (with Light on pointer and no pointer, it stays where it is put).
  lightAt(x, y, z) {
    lamp.hold.set(x, y, z);
    lamp.scripted = true;
  },
  target: () => controls.target,
};

const rot = new Matrix3();
const qa = new Quaternion(), qb = new Quaternion();
const axisA = new Vector3(0.3, 1, 0.15).normalize(), axisB = new Vector3(1, 0, 0.25).normalize();
const _up = new Vector3(0, 1, 0), _side = new Vector3(1, 0, 0);
let wantedKey = buildKey();
let wantedAt = 0;
let keyChangedAt = 0;
let pendingKey = wantedKey;
let paletteKey = null;
let spinSpeed = 0;
let cubeE = -1;
let cubeFrame = 0;
let lampNow = performance.now() / 1000;
let exposureBase = pipeline.exposure;
let exposureSet = null;
let exposureBoost = 1;
let envSet = null;
let envScale = 1;
render(({ dt }) => {
  autoChange.update(dt);
  clock += dt;
  syncFamily();
  const key = buildKey();
  if (key !== wantedKey) {
    wantedKey = key;
    wantedAt = clock;
    keyChangedAt = performance.now() / 1000;
    // Only a change to the shape itself hides the outlines; cells, variation and roundness redraw them live.
    const shapeKey = currentShapeKey();
    if (shapeKey !== lines.lastShape) lines.changedAt = performance.now() / 1000;
    lines.lastShape = shapeKey;
  }
  if (key !== pendingKey && !previewing && shell) preview();
  // The shape follows every change at once; its outlines wait until the changes rest, then fade in.
  const resting = performance.now() / 1000 - lines.changedAt > LINE_DELAY;
  const tag = key + (resting ? "#lines" : "");
  if (key !== pendingKey && previewing && sketcher.shown !== tag) {
    sketcher.want = { ...makeDesc(), sketch: true, noLines: !resting };
    askSketch();
  }
  // Once the settings rest (real time, so it happens while paused too) the preview always ends: a new sculpture is
  // built, or the one on show starts over if the settings came back to it.
  if ((previewing || key !== pendingKey) && performance.now() / 1000 - keyChangedAt > SETTLE) {
    pendingKey = key;
    if (desc && solid && key === desc.key) {
      previewing = false;
      restart();
    } else build();
  }
  const pk = [params.palette(), params.finish(), params.translucency(), sculpture?.kinds.join()].join();
  // A new look waits while a shape change is under way: it comes in between the old shape and the new one.
  if (pk !== paletteKey && morph.to !== 0) {
    paletteKey = pk;
    applyLook();
  }
  advance(dt);
  schedule();
  relook();
  showStatus();
  if (ready && !previewing && (sketchSurface.visible || (sketchFront.visible && !lines.leaving))) hideSketch();
  stepMorph();
  if (sketchFront.visible) {
    renderer.getDrawingBufferSize(sketchRes).multiplyScalar(0.5);
    const px = renderer.getPixelRatio();
    sketchFront.material.uniforms.resolution.value.copy(sketchRes);
    sketchFront.material.uniforms.width.value = 1.1 * px;
    sketchGlow.material.uniforms.resolution.value.copy(sketchRes);
    sketchGlow.material.uniforms.width.value = 7 * px;
  }

  // Between meshes the surface is carried on by the field's rate of change.
  shared.erosionNow.value = done ? shared.meshErosion.value : Math.max(erosionAt(hollowT), shownE);

  // Day and night: the studio dims, the exposure opens up a little (on top of the Exposure control).
  // Randomize and the sliders move the studio and the glow smoothly, never in a jump.
  const ke = 1 - Math.exp(-Math.min(0.1, dt || 1 / 60) * 2.2);
  for (const [k, v] of [["day", params.daylight()], ["warmth", params.warmth()], ["bright", params.brightness()]]) eased[k] = eased[k] === null ? v : eased[k] + (v - eased[k]) * ke;
  bgNow.lerp(bgTarget, ke);
  backdrop.material.color.copy(bgNow);
  pipeline.background.copy(bgNow);
  const day = eased.day;
  const dayScale = 0.004 + 0.996 * day ** 1.8;
  globalUniforms.lightColor.value.copy(keyColor).multiplyScalar(dayScale);
  // The Environment control sets the full-daylight level.
  if (envSet !== null && globalUniforms.envIntensity.value !== envSet) envBase = globalUniforms.envIntensity.value / envScale;
  envScale = dayScale;
  globalUniforms.envIntensity.value = envSet = envBase * dayScale;
  if (exposureSet !== null && pipeline.exposure !== exposureSet) exposureBase = pipeline.exposure / exposureBoost;
  exposureBoost = 1 + 0.45 * (1 - day) ** 2;
  pipeline.exposure = exposureSet = exposureBase * exposureBoost;

  // The glow: a little flicker once it has opened up.
  const settle = done ? Math.min(1, (clock - doneAt) / 2) : 0;
  const t = clock;
  const flick = 1 + params.flicker() * settle * (0.05 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1) + 0.03 * Math.sin(t * 23.3) * Math.sin(t * 1.3));
  const on = params.lamp() ? eased.bright * flick : 0;
  const lampRGB = kelvin(eased.warmth);
  lampUniforms.lampColor.value.copy(lampRGB).multiplyScalar(on * 0.9 * (1 + 1.3 * day));
  bulbMaterial.uniforms.bulbGlow.value.copy(lampRGB).multiplyScalar(on * 6);
  shellMaterial.uniforms.lampFill.value.copy(lampRGB).multiplyScalar(on * 0.12 * (1 - day) ** 2);

  // Floats, and tumbles slowly about two axes, whatever it is doing (sketch, build, hollowing).
  spinSpeed += (params.spin() - spinSpeed) * Math.min(1, dt * 0.8);
  tumble += dt * spinSpeed * 0.3;
  if (shapeById(morph.shown?.split(":")[0] ?? desc?.shape)?.upright) {
    // A face keeps looking forward: it sways from side to side and nods a little instead of tumbling over.
    qa.setFromAxisAngle(_up, 0.55 * Math.sin(tumble * 1.3));
    qb.setFromAxisAngle(_side, 0.1 * Math.sin(tumble * 0.9));
  } else {
    qa.setFromAxisAngle(axisA, tumble);
    qb.setFromAxisAngle(axisB, tumble * 0.43);
  }
  hero.quaternion.multiplyQuaternions(qa, qb);
  // Floats at the height of what is on show, so a new shape grows in where it will stay.
  const onShow = sketchSurface.visible && morph.size ? morph.size : sculpture;
  if (onShow) hero.position.set(0, FLOOR_Y + heightOf(onShow) + 0.012 * Math.sin(clock * 0.9), 0);
  hero.updateMatrixWorld();

  // The light eases toward its target in real time (so it follows the pointer while paused), never into a wall.
  const now = performance.now() / 1000;
  // Capped, so a slow frame holds the light back rather than letting it jump.
  const rdt = Math.min(1 / 50, now - lampNow);
  lampNow = now;
  if (sculpture) {
    // The light keeps its place in the room while the sculpture moves, turns or changes under it.
    if (lamp.placedWorld) hero.worldToLocal(lamp.pos.copy(lamp.world));
    const rate = lampTarget(now);
    if (lamp.pass) followWay(rate, rdt, now);
    // Following the pointer (or a scripted path), it goes straight through a skin that is still closed.
    else if (params.light() === "pointer" && (pointer.active || lamp.scripted)) lamp.pos.lerp(lamp.target, 1 - Math.exp(-rate * rdt));
    else if (lamp.at) {
      const c = lampClear();
      keepClear(lamp.target, c);
      stepLamp(lamp.pos, lamp.target, 1 - Math.exp(-rate * rdt), c);
    } else lamp.pos.copy(lamp.target);
    bulb.position.copy(lamp.pos);
    hero.localToWorld(lamp.world.copy(lamp.pos));
    lamp.placedWorld = true;
    if (lamp.pos.distanceToSquared(lamp.last) > 1e-10) lamp.movedAt = now;
    lamp.last.copy(lamp.pos);
    lampUniforms.lampFree.value = MathUtils.smoothstep(lamp.pos.distanceTo(lamp.home), 0, 0.03);
    lampUniforms.lampWall.value = params.thickness() * lamp.layerT;
  }
  lampUniforms.lampPos.value.copy(shared.bulbLocal.value).applyMatrix4(hero.matrixWorld);
  rot.setFromMatrix4(hero.matrixWorld).transpose();
  lampUniforms.lampRot.value.copy(rot);
  if (sculpture) backdrop.material.uniforms.contactSphere.value.set(hero.position.x, hero.position.y, hero.position.z, onShow.radius * 0.62 * morph.s);

  // The glow's cube follows the vertex shader between meshes only a few times a second (never on phones). While the
  // light moves it is redrawn every other frame (every third on phones), its tables once it has gone a centimetre,
  // and both once more where it stops.
  const ev = shared.erosionNow.value;
  const still = now - lamp.movedAt > 0.2;
  const moved = lamp.pos.distanceTo(lamp.cubePos);
  const due = moved > 0.002 ? pipeline.frame - cubeFrame >= (lite ? 3 : 2) : moved > 0 && still;
  const eroded = !lite && Math.abs(ev - cubeE) > 0.004 && pipeline.frame - cubeFrame >= 4;
  if (shell && (lampDirty || eroded || due)) {
    if (lamp.pos.distanceTo(lamp.tablesPos) > (still ? 0 : 0.01)) {
      lampTables();
      lamp.tablesPos.copy(lamp.pos);
    }
    lampShadow.render(lamp.pos);
    lamp.cubePos.copy(lamp.pos);
    lampDirty = false;
    cubeE = ev;
    cubeFrame = pipeline.frame;
  }

  // The orbit keeps its distance; low orbits stop at the floor instead of being pulled in.
  const dist = camera.position.distanceTo(controls.target);
  controls.maxPolarAngle = Math.min(Math.PI * 0.53, Math.acos(MathUtils.clamp((FLOOR_Y + 0.06 - controls.target.y) / dist, -1, 1)));
  controls.update();
  backdrop.follow(camera, controls.target);
  pipeline.render(scene, camera, clock);
});
