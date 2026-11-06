import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, onPause, randomize, keysHelp, setDay, getSeed, applyUrlState, addKey } from "common";
import { GUI } from "guspira";
import { EqualDepth, Scene, Mesh, Group, InstancedMesh, BufferGeometry, BufferAttribute, Vector3, Matrix3, Matrix4 } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { seededRandom } from "modules/random.js";
import { ReactionDiffusion, SHAPES, STRUCTURES, CORES } from "./rd.js";
import { createShared, createBodyMaterial, createShellMaterial, createShellDepthMaterial, applyPalette, PALETTES, STONES } from "./materials.js";
import { createBackdrop } from "./backdrop.js";
import { FogPass } from "./fog.js";

const PATTERNS = {
  worms: { feed: 0.029, kill: 0.057 },
  sponge: { feed: 0.042, kill: 0.0615 },
  coral: { feed: 0.055, kill: 0.062 },
  pores: { feed: 0.0367, kill: 0.0649, invert: true, iso: 0.1 },
};

const defaults = {
  shape: "sphere",
  structure: "lattice",
  pattern: "worms",
  scale: 0.55,
  patternSize: 1,
  erosion: 0.05,
  variation: 0.15,
  tumble: 1,
  overgrowth: 0.5,
  depth: 0.5,
  shoots: 0.5,
  moss: "forest",
  stone: "bone",
  weathering: 0.5,
  growTime: 14,
  spin: 0.5,
  float: 0.6,
  aperture: 0.7,
  focus: -0.75,
  auto: true,
  autoTime: 15,
};
const params = fromDefaults(defaults);
const touch = matchMedia("(pointer: coarse)").matches;

const FLOOR_Y = -1;
const MIST = 0x9aa397;

const fog = new FogPass(renderer);
const pipeline = new Pipeline(renderer, {
  background: MIST,
  exposure: 0.85,
  saturation: 1.1,
  contrast: 1,
  bloomStrength: 0.05,
  vignette: 0.28,
  grain: 0.035,
  shadow: { autoFit: true, denoise: true },
  giOptions: { thickness: 0.6 },
  depthOfField: { aperture: 0 },
  composite: (hdr, opts) => fog.render(hdr, opts),
});
const lite = ["low", "medium"].includes(pipeline.quality);
if (lite) pipeline.lensSamples = 64;
const LAYERS = { low: 6, medium: 8, high: 18, capture: 26 }[pipeline.quality];
const RES = lite ? 96 : 128;
const STEPS = 2600;
const GROW_MS = 2200;

fog.uniforms.density.value = 0.06;
fog.uniforms.veil.value = 0.02;
fog.uniforms.groundMist.value = 0.15;
fog.uniforms.floorY.value = FLOOR_Y;
fog.uniforms.mistLow.value.set(MIST).multiplyScalar(1.1);
fog.uniforms.mistHigh.value.set(0xc4ccc0).multiplyScalar(1.6);

globalUniforms.aoIntensity.value = 1;
globalUniforms.aoPower.value = 1.2;
globalUniforms.aoMin.value = 0.05;
globalUniforms.giIntensity.value = 1.3;
globalUniforms.lightSpecular.value = 0.6;
globalUniforms.aoColor.value.set(0.03, 0.035, 0.025);

const studio = createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(-0.45, 1, 0.12),
  keyIntensity: 6,
  keySize: 1.1,
  fill: 0.28,
  fillColor: 0xd4dccf,
  floor: 0.18,
  wall: 0.5,
  ceiling: 0.9,
  tint: 0xd2dacd,
});

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
gui.addSelect("Shape", params.shape, Object.keys(SHAPES));
gui.addSelect("Structure", params.structure, Object.keys(STRUCTURES));
gui.addSelect("Pattern", params.pattern, Object.keys(PATTERNS));
gui.addSlider("Scale", params.scale, 0.3, 0.6, 0.01);
gui.addSlider("Pattern size", params.patternSize, 1, 2.5, 0.05);
// How deep the pattern eats into the solid structure.
gui.addSlider("Erosion", params.erosion, 0, 0.15, 0.005);
gui.addSlider("Variation", params.variation, 0, 0.4, 0.01);
gui.addSlider("Tumble", params.tumble, 0, 1, 0.01);
gui.addSelect("Stone", params.stone, Object.keys(STONES));
gui.addSlider("Weathering", params.weathering, 0, 1, 0.01);
gui.addSeparator();
gui.addSelect("Moss", params.moss, Object.keys(PALETTES));
// Randomize always leaves some moss to grow.
gui.addSlider("Overgrowth", params.overgrowth, 0, 1, 0.01).randomize = () => params.overgrowth.set(Math.round((0.35 + Math.random() * 0.65) * 100) / 100);
gui.addSlider("Depth", params.depth, 0, 1, 0.01);
gui.addSlider("Shoots", params.shoots, 0, 1, 0.01);
gui.addSlider("Grow time", params.growTime, 0, 40, 0.5, { randomizable: false });
gui.addButton("Regrow", () => regrow());
gui.addSeparator();
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Float", params.float, 0, 1.2, 0.01, { randomizable: false });
gui.addSlider("Aperture", params.aperture, 0, 1, 0.01, { randomizable: false });
// Focal distance through the sculpture: -1 its front, 0 its middle, 1 its back.
gui.addSlider("Focus", params.focus, -1.5, 1.5, 0.01, { randomizable: false });
gui.addCheckbox("Auto change", params.auto, { randomizable: false });
gui.addSlider("Change every", params.autoTime, 5, 60, 1, { randomizable: false });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(touch ? "Drag to orbit, pinch to zoom." : `Drag to orbit, scroll to zoom.<br/>${keysHelp()}`);
gui.show();

const scene = new Scene();
const backdrop = createBackdrop({ floorY: FLOOR_Y, color: MIST });
backdrop.material.uniforms.backdropLevel.value = 0.26;
backdrop.material.uniforms.wallFill.value = 0.55;
backdrop.material.uniforms.cycTop.value = 1.4;
backdrop.material.uniforms.cycFall.value.set(0.25, 1.0);
backdrop.material.uniforms.poolStrength.value = 0.75;
backdrop.mesh.renderOrder = 1;
scene.add(backdrop.mesh);

const shared = createShared();
const bodyMaterial = createBodyMaterial(shared);
const shellMaterial = createShellMaterial(shared, { lite });
const shellDepthMaterial = createShellDepthMaterial(shellMaterial);
shellMaterial.depthWrite = false;
shellMaterial.depthFunc = EqualDepth;
let shellDepth = null;
shared.layers.value = LAYERS;
shared.aoBake.value = 0.35;
const hero = new Group();
scene.add(hero);

camera.near = 0.2;
camera.far = 60;
camera.userData.baseFov = 27;
camera.fov = camera.aspect < 1 ? (2 * Math.atan(Math.tan((27 * Math.PI) / 360) / camera.aspect) * 180) / Math.PI : 27;
camera.position.set(1.0, 0.35, 6.5);
controls.target.set(0, 0, 0);
camera.lookAt(controls.target);
camera.updateProjectionMatrix();
Object.assign(controls, { enablePan: false, minDistance: 2, maxDistance: 14, minPolarAngle: Math.PI * 0.1, maxPolarAngle: Math.PI * 0.56, enableDamping: true });

const R = 1.15;
let fitAspect = 0;
onResize((w, h, dpr) => {
  if (lite && !new URLSearchParams(location.search).has("dpr")) renderer.setPixelRatio(Math.min(dpr, 1.5));
  pipeline.setSize(w, h, renderer.getPixelRatio());
  const a = w / h;
  // Screenshots and the phone URL bar keep the user's zoom.
  if (Math.abs(a - fitAspect) / a < 0.15) return;
  fitAspect = a;
  setDistance(fitDistance(params.float()));
});

// Frames the object close up (0.78 of a fit that leaves room for the shadow below).
function fitDistance(lift) {
  const t = Math.tan((camera.fov * Math.PI) / 360);
  const a = camera.aspect;
  return 0.78 * Math.max((R + 0.15 + lift * 0.8) / t, (R + 0.35) / (t * a));
}

function setDistance(d) {
  camera.position.sub(controls.target).setLength(Math.min(controls.maxDistance, d)).add(controls.target);
}

// The reaction-diffusion volume and the mesher.
const rd = new ReactionDiffusion(renderer, RES);
// Two meshers, so previews of the growing form overlap.
let jobId = 0;
const workers = Array.from({ length: (navigator.hardwareConcurrency ?? 4) >= 4 ? 2 : 1 }, () => {
  const w = new Worker(new URL("./mesher.worker.js", import.meta.url), { type: "module" });
  const jobs = new Map();
  w.onmessage = (e) => {
    const resolve = jobs.get(e.data.id);
    jobs.delete(e.data.id);
    resolve?.(e.data);
  };
  w.onerror = (e) => {
    for (const r of jobs.values()) r({ error: e.message || "mesher failed to load" });
    jobs.clear();
  };
  return { w, jobs };
});
const meshField = (msg) =>
  new Promise((resolve) => {
    const id = ++jobId;
    const { w, jobs } = workers.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
    jobs.set(id, resolve);
    w.postMessage({ ...msg, id }, [msg.field.buffer]);
  });

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

let body = null;
let restY = null;
let lookDue = false;
let shownOvergrowth = defaults.overgrowth;
let wantRestY = 0;
let targetLift = null;
const center = new Vector3();
const wantCenter = new Vector3();
const aim = new Vector3();
let fittedLift = defaults.float;
let shells = null;
let buildToken = 0;
let builtKey = null;
let started = false;
let previewing = false;
let firstShown;
const shown = new Promise((r) => (firstShown = r));
let progress = 0;
let clock = 0;
let binStart = null;

// A random turn for the sculpture from the seed; Tumble scales it from upright to anywhere. Suzanne stays
// upright, facing the camera.
function orientation() {
  if (params.shape() === "suzanne") return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [axis, f] = seeded("orient", () => {
    const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [new Vector3(r * Math.cos(a), z, r * Math.sin(a)), 0.4 + 0.6 * Math.random()];
  });
  return Array.from(new Matrix3().setFromMatrix4(new Matrix4().makeRotationAxis(axis, params.tumble() * Math.PI * f)).elements);
}

let lastField = null;
let lastSeed = null;
let meshedTumble = null;
let remeshToken = 0;
let seenTumble = null;
let tumbleAt = 0;

const buildKey = () => [params.shape(), params.structure(), params.pattern(), params.scale(), params.patternSize(), params.variation(), params.structure() === "solid" ? params.erosion() : 0, getSeed()].join();

function seeded(name, fn) {
  const r = Math.random;
  Math.random = seededRandom(`${getSeed()}:${name}`);
  try {
    return fn();
  } finally {
    Math.random = r;
  }
}

async function build(retry = false) {
  const token = ++buildToken;
  const key = buildKey();
  const seed = seeded("rd", () => new Vector3(Math.random() * 100, Math.random() * 100, Math.random() * 100));
  const pattern = PATTERNS[params.pattern()];
  rd.reset({
    shape: params.shape(),
    structure: params.structure(),
    wall: params.structure() === "lattice" ? 0.42 : 0.32,
    core: CORES[params.shape()],
    erosion: params.erosion(),
    feed: pattern.feed,
    kill: pattern.kill,
    scale: params.scale(),
    size: params.patternSize(),
    variation: params.variation(),
    seed,
    invert: !!pattern.invert,
    iso: pattern.iso ?? 0.2,
    dt: 1.6,
    seedDensity: retry ? 0.45 : undefined,
  });
  // The form is meshed now and then while it grows, so a change shows up right away.
  const inflight = new Set();
  let previewAt = -Infinity;
  let previewSeq = 0;
  let shownSeq = 0;
  const showPreview = async () => {
    const seq = ++previewSeq;
    const field = await rd.read(RES / 2);
    if (token !== buildToken) return;
    const data = await meshField({ field, N: RES / 2, extent: rd.extent, preview: true, rotation: orientation() });
    // An older preview finishing after a newer one, or after the final mesh started, is dropped.
    if (token !== buildToken || seq < shownSeq || data.error || data.index.length === 0) return;
    shownSeq = seq;
    install(data, true);
    builtKey = null;
  };
  // Steps per frame adapt to what the device keeps up with; once running, growth takes at least GROW_MS
  // so the previews read as the form growing.
  let batch = started ? 8 : 48;
  let last = performance.now();
  const begin = last;
  while (rd.steps < STEPS) {
    const allowed = started ? Math.ceil((STEPS * (performance.now() - begin)) / GROW_MS) - rd.steps : Infinity;
    rd.run(Math.max(0, Math.min(batch, STEPS - rd.steps, allowed)));
    const now = performance.now();
    if (inflight.size < workers.length && rd.steps >= 60 && rd.steps < STEPS && now - previewAt > 120) {
      previewAt = now;
      const p = showPreview().finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await nextFrame();
    if (token !== buildToken) return;
    const t = performance.now();
    batch = Math.max(4, Math.min(400, Math.round(batch * (t - last > (started ? 34 : 80) ? 0.7 : 1.15))));
    last = t;
  }
  // Previews still meshing are dropped rather than waited for.
  shownSeq = Infinity;
  const field = await rd.read();
  if (token !== buildToken) return;
  lastField = field.slice();
  lastSeed = [seed.x, seed.y, seed.z];
  meshedTumble = params.tumble();
  remeshToken++;
  const data = await meshField({ field, N: RES, extent: rd.extent, seed: lastSeed, cushionScale: 1.6, rotation: orientation() });
  if (token !== buildToken) return;
  if (data.error || data.index.length === 0) {
    if (data.error) console.warn("Moss mesher:", data.error);
    if (!retry) return build(true);
    builtKey = key;
    return;
  }
  install(data);
  builtKey = key;
}

// Tumble only re-meshes the grown field, and the moss keeps its progress.
async function remesh() {
  const token = ++remeshToken;
  const build = buildToken;
  meshedTumble = params.tumble();
  const data = await meshField({ field: lastField.slice(), N: RES, extent: rd.extent, seed: lastSeed, cushionScale: 1.6, rotation: orientation() });
  if (token !== remeshToken || build !== buildToken || data.error || data.index.length === 0) return;
  install(data, false, true);
}

function install(data, isPreview = false, keepGrowth = false) {
  if (body) {
    hero.remove(body, shells);
    body.geometry.dispose();
    shells.geometry.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.position, 3));
  g.setAttribute("normal", new BufferAttribute(data.normal, 3));
  g.setAttribute("uv", new BufferAttribute(data.uv, 2));
  g.setAttribute("curve", new BufferAttribute(data.curve, 1));
  g.setAttribute("cushion", new BufferAttribute(data.cushion, 4));
  g.setAttribute("species", new BufferAttribute(data.species, 1));
  g.setIndex(new BufferAttribute(data.index, 1));
  g.computeBoundingSphere();
  g.boundingSphere.radius += 0.1;
  binStart = data.binStart;

  const sg = new BufferGeometry();
  for (const name of ["position", "normal", "uv", "cushion", "species"]) sg.setAttribute(name, g.attributes[name]);
  sg.setIndex(g.index);
  sg.boundingSphere = g.boundingSphere.clone();

  body = new Mesh(g, bodyMaterial);
  shells = new InstancedMesh(sg, shellMaterial, LAYERS);
  const identity = new Matrix4();
  for (let i = 0; i < LAYERS; i++) shells.setMatrixAt(i, identity);
  shells.boundingSphere = sg.boundingSphere.clone();
  shells.frustumCulled = false;
  hero.add(body, shells);
  // Previews keep the height they started at; the final mesh sets it, eased in by the render loop.
  if (!isPreview || restY === null) {
    wantRestY = FLOOR_Y - data.minY - 0.015;
    wantCenter.fromArray(data.center);
  }
  if (restY === null) {
    restY = wantRestY;
    center.copy(wantCenter);
  }
  globalUniforms.occluderCount.value = 1;
  globalUniforms.occluderStrength.value = 0;
  previewing = isPreview;
  firstShown();
  lookDue = true;
  if (!keepGrowth) regrow();
  pipeline.restartAccumulation();
}

// Triangles are sorted by rank, so the shells only draw the part the moss has reached.
function updateShellRange() {
  if (!shells) return;
  const b = Math.min(31, Math.max(0, Math.floor((1 - shared.growth.value) * 32)));
  const tris = binStart[32 - b];
  shells.geometry.setDrawRange(0, tris * 3);
  shells.visible = tris > 0 && shared.growth.value > 0;
}

// The shadow pass and prepass draw every other layer.
const HALF_LAYERS = ["pipeline-shadow", "pipeline-prepass"];
function shellPass(renderer, scene, camera, geometry, material) {
  const stride = HALF_LAYERS.includes(material.customProgramCacheKey()) ? 2 : 1;
  this.count = Math.ceil(shared.layers.value / stride);
  shared.layerStride.value = stride;
}

function shellDepthPass() {
  this.count = shared.layers.value;
  shared.layerStride.value = 1;
}

// The depth-only copy of the shells follows whatever shells are installed.
function syncShellDepth() {
  if (!shells) return;
  shells.onBeforeRender = shellPass;
  if (shellDepth?.geometry !== shells.geometry) {
    shellDepth?.removeFromParent();
    shellDepth = new InstancedMesh(shells.geometry, shellDepthMaterial, shared.layers.value);
    shellDepth.instanceMatrix = shells.instanceMatrix;
    shellDepth.frustumCulled = false;
    shellDepth.renderOrder = -1;
    shellDepth.userData.noShadow = true;
    shellDepth.onBeforeRender = shellDepthPass;
    shells.parent.add(shellDepth);
  }
  shellDepth.visible = shells.visible;
}

// Fewer layers when the moss is only a few pixels deep.
function updateLayers() {
  if (!shells) return;
  syncShellDepth();
  const ppu = renderer.domElement.height / (2 * camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360));
  const want = Math.max(6, Math.min(LAYERS, 2 * Math.round(0.35 * shared.mossDepth.value * ppu)));
  const n = shared.layers.value;
  if (Math.abs(want - n) >= 2 || (want === LAYERS && n !== LAYERS)) {
    shells.count = want;
    shared.layers.value = want;
  }
}

function regrow() {
  progress = 0;
}


function updateLook() {
  shownOvergrowth = params.overgrowth();
  applyPalette([bodyMaterial, shellMaterial], params.moss());
  const stone = STONES[params.stone()];
  shared.stoneColor.value.setHex(stone.color);
  shared.stoneRough.value = stone.rough;
  shared.weathering.value = params.weathering();
  shared.mossDepth.value = 0.01 + 0.04 * params.depth();
  shared.shootSize.value = 0.006 + 0.012 * params.shoots();
}

// Progress is kept as state, so changing Grow time only changes the speed of what is left.
function growth(dt) {
  if (previewing) return 0;
  const T = params.growTime();
  progress = T <= 0 ? 1 : Math.min(1, progress + dt / T);
  const e = 1 - Math.pow(1 - progress, 2.2);
  return shownOvergrowth * e;
}

onRandomize(() => gui.randomizeAll());
applyUrlState();
updateLook();
// Start on the first look at the growing form; the build carries on in the background.
await rd.ready;
const firstBuild = build();
await Promise.race([firstBuild, shown]);
await studio;
if (shells) shells.visible = true;
syncShellDepth();
await pipeline.compileAsync(scene, camera);
started = true;

window.app = { canvas: renderer.domElement, pipeline, controls, params, shared, rd, regrow };

const focusPoint = new Vector3();
const lookKey = () => [params.moss(), params.stone(), params.weathering(), params.depth(), params.shoots(), params.overgrowth()].join();
let builtLook = lookKey();
let wantedKey = buildKey();
let wantedAt = 0;
// The first build may still be running.
let pendingKey = wantedKey;
// Auto change: a new sculpture once the current one has been on show for Change every seconds. The count
// stops while paused and starts over on resuming.
let shownFor = 0;
onPause((running) => {
  if (running) shownFor = 0;
});
render(({ dt }) => {
  clock += dt;
  shownFor = params.auto() && buildKey() === builtKey ? shownFor + dt : 0;
  if (shownFor > params.autoTime()) {
    shownFor = 0;
    randomize();
  }
  const now = performance.now() / 1000;
  const key = buildKey();
  // Back to the built object: drop any build in flight.
  if (key === builtKey && pendingKey !== builtKey) {
    buildToken++;
    pendingKey = builtKey;
  }
  if (key !== wantedKey) {
    wantedKey = key;
    wantedAt = now;
  }
  // Rebuild once the sliders have settled.
  if (params.tumble() !== seenTumble) {
    seenTumble = params.tumble();
    tumbleAt = now;
  }
  if (key === builtKey && pendingKey === builtKey && lastField && seenTumble !== meshedTumble && now - tumbleAt > 0.25) remesh();
  if (key !== builtKey && key !== pendingKey && now - wantedAt > 0.25) {
    pendingKey = key;
    build();
  }
  // While a new form is on its way, its look waits for it, so both change together.
  const look = lookKey();
  if (lookDue || (look !== builtLook && key === builtKey && pendingKey === builtKey)) {
    lookDue = false;
    builtLook = look;
    updateLook();
    pipeline.restartAccumulation();
  }
  shared.growth.value = growth(dt);
  updateShellRange();
  updateLayers();
  // Hovering: the camera aims at the middle of the object, and the backdrop's contact pool softens with the gap.
  const lift = params.float();
  const ease = 1 - Math.exp(-dt * 5);
  if (restY !== null) restY = Math.abs(wantRestY - restY) < 1e-4 ? wantRestY : restY + (wantRestY - restY) * ease;
  center.distanceTo(wantCenter) < 1e-4 ? center.copy(wantCenter) : center.lerp(wantCenter, ease);
  hero.position.y = (restY ?? 0) + lift;
  hero.rotation.y += dt * params.spin() * 0.3;
  const cs = Math.cos(hero.rotation.y), sn = Math.sin(hero.rotation.y);
  aim.set(center.x * cs + center.z * sn, hero.position.y + center.y, -center.x * sn + center.z * cs);
  const ty = aim.y;
  if (targetLift === null) controls.target.copy(aim);
  else if (!controls.target.equals(aim)) {
    camera.position.add(aim).sub(controls.target);
    controls.target.copy(aim);
    // Keep the user's zoom relative to the fit.
    const d = camera.position.distanceTo(controls.target);
    setDistance(d * fitDistance(lift) / fitDistance(fittedLift));
    pipeline.restartAccumulation();
  }
  targetLift = ty;
  fittedLift = lift;
  globalUniforms.occluders.value[0].set(aim.x, FLOOR_Y + R * 0.9 + lift, aim.z, R * 0.85);
  hero.updateMatrixWorld();
  shared.heroBasis.value.setFromMatrix4(hero.matrixWorld);

  controls.update();
  backdrop.keepInsideCyc(camera, controls.target);
  focusPoint.copy(controls.target);
  pipeline.dof.focus = camera.position.distanceTo(focusPoint) + R * params.focus();
  pipeline.dof.aperture = params.aperture() * 0.045;
  fog.uniforms.start.value = camera.position.distanceTo(controls.target) - 1.4;

  const still = params.spin() === 0 && shared.growth.value >= shownOvergrowth - 1e-6;
  pipeline.render(scene, camera, still ? 0 : clock);
});
