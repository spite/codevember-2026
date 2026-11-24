import {
  fromDefaults,
  renderer,
  camera,
  controls as sharedControls,
  render,
  onResize,
  onRandomize,
  applyUrlState,
  keysHelp,
  setDay,
  showHint,
  loadingStep,
  getSeed,
  addKey,
  onPause,
} from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3, Color, Quaternion, DataTexture, RGBAFormat, HalfFloatType, LinearFilter, BufferGeometry, RawShaderMaterial, GLSL3, WebGLRenderTarget, OrthographicCamera } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { OrbitControls as FreeOrbitControls } from "modules/FreeOrbitControls.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { MagmaFluidField, STYLES, STYLE_PROFILES } from "./sim.js";
import { MagmaTextureBaker } from "./baker.js";
import { WRAP_N } from "./meshData.js";
import { MeshBuilder, SHAPES, createSdfTexture, createHeatTexture, createFlowTexture, writeVolume, SDF_BOUND, SDF_SIZE, FLOW_SIZE } from "./geometry.js";
import { LavaPulseVolume } from "./pulse.js";
import { LightShaft } from "./shaft.js";
import { RockSmoke } from "./fumes.js";
import { createMagmaMaterial } from "./material.js";
import { MoltenMorph, MorphFieldAtlas } from "./morph.js";
import { createMorphUniforms } from "./lava.js";
import { EmberSystem } from "./embers.js";
import { EmberLight } from "./emberLight.js";
import { VolumetricLavaGlow } from "./glow.js";

const BACKDROPS = {
  Obsidian: "#0f0f12",
  Slate: "#24303b",
  Ember: "#180f0d",
  Charcoal: "#191a1e",
};

const QUALITY_FLUID = { capture: 512, high: 512, medium: 512, low: 384 };
const QUALITY_MAP = { capture: 1024, high: 1024, medium: 512, low: 512 };
// Tessellation: quadtree depth per cube face, error tolerance (world units), triangle budget
const QUALITY_MESH = {
  capture: { levels: 9, tol: 0.0012, maxTriangles: 2500000 },
  high: { levels: 9, tol: 0.0018, maxTriangles: 1500000 },
  medium: { levels: 8, tol: 0.004, maxTriangles: 350000 },
  low: { levels: 7, tol: 0.007, maxTriangles: 150000 },
};

const defaults = {
  style: "Cracked Plates",
  shape: "Sphere",
  backdrop: "Obsidian",
  crust: 0.84,
  fluidFlow: 0.35,
  turbulence: 0.32,
  scale: 1.2,
  relief: 0.86,
  heat: 0.78,
  glow: 0.70,
  glowSpread: 0.45,
  gloss: 0.26,
  flow: 0.40,
  embers: 0.55,
  spin: 0.10,
  auto: true,
  autoTime: 14,
  detail: 1,
  shimmer: 1,
  shaft: 1,
  smokeRoom: 1,
  smokeSize: 1,
  smokePlumes: 1,
  smokeLava: 1,
  smokeUnder: 1,
  smokeRise: 1,
  smokeDensity: 1,
  smokeTurbulence: 1,
  smokeLifetime: 1,
  smokeDraught: 1,
  smokeHeading: 53,
  smokeLavaLight: 1,
  smokeEmberLight: 1,
};

const params = fromDefaults(defaults);
const load = {
  studio: loadingStep(1, "Lighting the caldera…"),
  fluid: loadingStep(2, "Simulating magma flow…"),
  bake: loadingStep(1, "Solidifying basalt crust…"),
  compile: loadingStep(3, "Compiling shaders…"),
  wrap: loadingStep(0.3, "Shaping Suzanne…"),
};

const pipeline = new Pipeline(renderer, {
  background: BACKDROPS[params.backdrop()],
  exposure: 1.0,
  bloomStrength: 0.30,
  bloomRadius: 0.82,
  vignette: 0.34,
  grain: 0.02,
  contrast: 1.2,
  saturation: 1.55,
  shadow: { autoFit: true, denoise: true },
});

const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(-0.6, 0.85, 0.55),
    keyIntensity: 3.6,
    keySize: 0.46,
    fill: 0.45,
    // Cool light on the crust, so black-blue rock against orange lava reads as temperature
    tint: 0xe2e5ec,
    floor: 0.35,
    wall: 0.2,
  }),
);

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: true });
gui.addSelect("Style", params.style, STYLES);
gui.addSelect("Shape", params.shape, SHAPES);
gui.addSlider("Crust", params.crust, 0, 1, 0.01);
gui.addSlider("Fluid flow", params.fluidFlow, 0, 1, 0.01);
gui.addSlider("Turbulence", params.turbulence, 0, 1, 0.01);
gui.addSlider("Scale", params.scale, 0.7, 2.0, 0.01);
gui.addSlider("Relief", params.relief, 0, 1, 0.01);
gui.addSlider("Geometry detail", params.detail, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Heat", params.heat, 0, 1, 0.01);
gui.addSlider("Glow", params.glow, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Glow spread", params.glowSpread, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Heat haze", params.shimmer, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Gloss", params.gloss, 0, 1, 0.01);
gui.addSlider("Magma flow", params.flow, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Embers", params.embers, 0, 1, 0.01);
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });

// A look change: the crust melts, the rock is handed to a liquid that collapses into a sloshing pool,
// the new form rises out of the pool, is handed back to the new rock, and cools. The rock on show keeps
// every old value until the liquid has taken over.
const MELT_TIME = 1.4;
const HAND_TIME = 0.3;
const COLLAPSE_TIME = 1.1;
const SLOSH_TIME = 1.2;
const RECOMPOSE_TIME = 1.4;
const COOL_TIME = 2.6;
const POOL_SCALE = 0.9;
const look = {
  phase: "idle",
  melt: 0,
  march: 0,
  t: 0,
  sloshTime: 0,
  pool: 1,
  radiusA: 1,
  radiusB: 1,
  // Bounding radius of each shape's distance field (SDF_BOUND until known)
  extentA: SDF_BOUND,
  extentB: SDF_BOUND,
  ready: false,
  fluid: false,
  queued: false,
  // Lava pattern of the old look (A, captured when the melt starts) and how far the liquid has turned to the new one
  lookA: { scale: 1.2, seed: new Vector3() },
  lookMix: 0,
};
const isFrozen = () => look.phase === "melt" || look.phase === "handIn";
const smooth = (x) => x * x * (3 - 2 * x);

const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => look.phase === "idle" });
const smokeSlider = (label, signal, min, max, step = 0.01) => gui.addSlider(label, signal, min, max, step, { randomizable: false });
gui.addSection("Smoke", { open: false });
smokeSlider("Light shaft", params.shaft, 0, 2);
smokeSlider("Room smoke", params.smokeRoom, 0, 2);
smokeSlider("Room billow size", params.smokeSize, 0.5, 2);
smokeSlider("Plumes", params.smokePlumes, 0, 2);
smokeSlider("From the lava", params.smokeLava, 0, 3);
smokeSlider("From underneath", params.smokeUnder, 0, 3);
smokeSlider("Rise speed", params.smokeRise, 0.2, 3);
smokeSlider("Density", params.smokeDensity, 0.2, 3);
smokeSlider("Turbulence", params.smokeTurbulence, 0, 3);
smokeSlider("Lifetime", params.smokeLifetime, 0.25, 4);
smokeSlider("Draught", params.smokeDraught, 0, 4);
smokeSlider("Draught heading", params.smokeHeading, 0, 360, 1);
smokeSlider("Lava light", params.smokeLavaLight, 0, 3);
smokeSlider("Ember light", params.smokeEmberLight, 0, 3);
gui.endSection();
pipeline.addGUI(gui);
addKey("KeyW", "toggle wireframe", () => (pipeline.wireframe = !pipeline.wireframe));
gui.addSeparator();
gui.addText(keysHelp("Drag to turn the rock · scroll to zoom"));
showHint("Drag to turn the rock · scroll to zoom · R for a new rock", "Drag to turn the rock · pinch to zoom · tap {randomize} for a new rock");
gui.show();

const fluidSize = QUALITY_FLUID[pipeline.quality] ?? 384;
const faceSize = QUALITY_MAP[pipeline.quality] ?? 768;
const meshQuality = QUALITY_MESH[pipeline.quality] ?? QUALITY_MESH.high;

const fluid = new MagmaFluidField(renderer, fluidSize);
const baker = new MagmaTextureBaker(renderer, fluid, faceSize);
// Suzanne's shrink-wrap grid, so the baker can lay patterns on her surface (see meshData.js)
const wrapGrid = await load.wrap.track(
  fetch(new URL("./suzanne-wrap.bin", import.meta.url))
    .then((r) => r.arrayBuffer())
    .then((buffer) => {
      const n = WRAP_N + 1;
      const texture = new DataTexture(new Uint16Array(buffer), n, n * 6, RGBAFormat, HalfFloatType);
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
      return texture;
    }),
);
baker.setWrapGrid(wrapGrid, WRAP_N);
const morphUniforms = createMorphUniforms(SDF_BOUND);
const volumetricGlow = new VolumetricLavaGlow(renderer, morphUniforms, baker.noiseTexture);
const SHAFT_DIRECTION = new Vector3(-0.3, 1, -0.45).normalize();
const meshBuilder = new MeshBuilder();
const moltenMorph = new MoltenMorph(renderer, { noiseTexture: baker.noiseTexture, morphUniforms });
const fieldAtlas = new MorphFieldAtlas(renderer, morphUniforms);
const sdf = { a: createSdfTexture(), b: createSdfTexture() };
const heatVolume = createHeatTexture();

const scene = new Scene();
const { material, uniforms } = createMagmaMaterial(baker);
uniforms.uHeatVolume.value = heatVolume;
const flowVolume = createFlowTexture();
const lavaPulse = new LavaPulseVolume(renderer, { size: FLOW_SIZE, bound: SDF_BOUND, flowVolume, shared: uniforms });
uniforms.uPulseVolume.value = lavaPulse.texture;
// The smoke is simulated around the rock (a coarser grid on medium); low marches the static noise
const rockSmoke = pipeline.quality === "low" ? null : new RockSmoke({ quality: pipeline.quality === "medium" ? "medium" : "high", morphUniforms, heatVolume, pulseVolume: lavaPulse.texture, sdfBound: SDF_BOUND });
const lightShaft = new LightShaft(renderer, morphUniforms, baker.noiseTexture, rockSmoke);
const emberLight = rockSmoke ? new EmberLight(rockSmoke.box) : null;
let emberLightAmount = -1;


// Uploads a hidden mesh's buffers one per frame, so its first visible frame doesn't stall on them
const UPLOAD_ATTRIBUTES = ["position", "normal", "uv", "aTangent", "aTileBounds", "aCellTexels"];
const uploader = {
  scene: new Scene(),
  camera: new OrthographicCamera(),
  target: new WebGLRenderTarget(1, 1, { depthBuffer: false }),
  queue: [],
  meshes: Object.fromEntries(UPLOAD_ATTRIBUTES.map((name) => {
    const mesh = new Mesh(new BufferGeometry(), new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: `in vec4 ${name};\nuniform float uZero;\nvoid main() { gl_Position = vec4(${name}.x * uZero, 0.0, 0.0, 1.0); }`,
      fragmentShader: "precision highp float;\nout vec4 c;\nvoid main() { c = vec4(0.0); }",
      uniforms: { uZero: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    }));
    mesh.frustumCulled = false;
    return [name, mesh];
  })),
  get indexMesh() {
    this._indexMesh ??= Object.assign(new Mesh(new BufferGeometry(), this.meshes.position.material), { frustumCulled: false });
    return this._indexMesh;
  },
  start(geometry) {
    this.queue = [...UPLOAD_ATTRIBUTES.filter((n) => geometry.getAttribute(n)).map((n) => [n, false]), ["position", true]].map(([n, indexed]) => ({ geometry, n, indexed }));
  },
  step() {
    const { geometry, n, indexed } = this.queue.shift();
    const mesh = indexed ? this.indexMesh : this.meshes[n];
    mesh.geometry.setAttribute(n, geometry.getAttribute(n));
    mesh.geometry.setIndex(indexed ? geometry.index : null);
    mesh.geometry.setDrawRange(0, 3);
    this.scene.add(mesh);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    this.scene.remove(mesh);
  },
};

const magmaMesh = new Mesh(undefined, material);
magmaMesh.castShadow = true;
magmaMesh.receiveShadow = true;
scene.add(magmaMesh);

const embers = new EmberSystem(pipeline.quality);
scene.add(embers.mesh);

camera.position.set(0, 0.25, 5.1);
sharedControls.dispose();
const controls = new FreeOrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 2.0;
controls.maxDistance = 10;
// Dragging turns the rock itself (the camera only zooms), so the air, embers and haze stay put around it
controls.enableRotate = false;
const dragSpin = { x: 0, y: 0, active: false, lastX: 0, lastY: 0, lastT: 0, id: -1 };
const spinAxis = new Vector3();
const spinQuat = new Quaternion();
const canvasEl = renderer.domElement;
// While paused the mouse orbits the camera instead, to look around the frozen scene
onPause((running) => {
  controls.enableRotate = !running;
  if (!running) dragSpin.active = false;
});
canvasEl.addEventListener("pointerdown", (ev) => {
  if (!ev.isPrimary || controls.enableRotate) return;
  Object.assign(dragSpin, { active: true, lastX: ev.clientX, lastY: ev.clientY, lastT: performance.now(), id: ev.pointerId, x: 0, y: 0 });
  canvasEl.setPointerCapture(ev.pointerId);
});
canvasEl.addEventListener("pointermove", (ev) => {
  if (!dragSpin.active || ev.pointerId !== dragSpin.id) return;
  const now = performance.now();
  const s = 5 / Math.max(canvasEl.clientHeight, 1);
  const dx = (ev.clientX - dragSpin.lastX) * s;
  const dy = (ev.clientY - dragSpin.lastY) * s;
  turnRock(dx, dy);
  const dts = Math.max((now - dragSpin.lastT) / 1000, 1 / 240);
  dragSpin.x = dx / dts;
  dragSpin.y = dy / dts;
  Object.assign(dragSpin, { lastX: ev.clientX, lastY: ev.clientY, lastT: now });
});
const endDrag = (ev) => {
  if (ev.pointerId !== dragSpin.id) return;
  dragSpin.active = false;
  if (performance.now() - dragSpin.lastT > 80) dragSpin.x = dragSpin.y = 0;
};
canvasEl.addEventListener("pointerup", endDrag);
canvasEl.addEventListener("pointercancel", endDrag);
canvasEl.style.touchAction = "none";

// Turns the rock about the camera's up (horizontal drag) and right (vertical drag) axes
function turnRock(dx, dy) {
  if (dx) {
    spinAxis.set(0, 1, 0).applyQuaternion(camera.quaternion);
    magmaMesh.quaternion.premultiply(spinQuat.setFromAxisAngle(spinAxis, dx));
  }
  if (dy) {
    spinAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    magmaMesh.quaternion.premultiply(spinQuat.setFromAxisAngle(spinAxis, dy));
  }
}

onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

function currentFluidKey() {
  return `${params.fluidFlow().toFixed(2)}|${params.turbulence().toFixed(2)}|${getSeed()}`;
}

function currentShapeMode(shape = params.shape()) {
  if (shape === "Torus") return 1;
  if (shape === "Trefoil Knot") return 2;
  if (shape === "Twisted Ring") return 3;
  if (shape === "Suzanne") return 5;
  return 0;
}

function currentBakeKey() {
  return `${params.style()}|${params.shape()}|${params.crust().toFixed(2)}|${params.scale().toFixed(2)}|${params.relief().toFixed(2)}|${currentFluidKey()}`;
}

let appliedFluidKey = "";
let appliedBakeKey = "";
let bakeChangedAt = 0;

function currentLookKey() {
  return `${params.style()}|${params.shape()}`;
}

let appliedLookKey = "";

// A staged job (a bake, or the fluid developed ahead during the melt) runs a slice per frame from the render loop
let bakeJob = null;
let fluidIncomplete = false;
let fluidDeveloped = "";
const fluidSteps = pipeline.quality === "low" ? 42 : 78;

function* developFluid(seed, fluidOpts) {
  fluidIncomplete = true;
  fluid.reset(seed);
  yield* fluid.developSteps(fluidSteps, fluidOpts);
  fluidIncomplete = false;
  fluidDeveloped = `${seed}|${fluidOpts.turbulence}|${fluidOpts.fluidFlow}`;
}

function* bakeJobSteps(reDevelopFluid, seed, fluidOpts, bakeSteps) {
  // The fluid only depends on these, so one developed ahead for them is used as is
  if (fluidIncomplete || (reDevelopFluid && fluidDeveloped !== `${seed}|${fluidOpts.turbulence}|${fluidOpts.fluidFlow}`)) yield* developFluid(seed, fluidOpts);
  yield* bakeSteps;
}

// staged: spread over frames (only while the rock is hidden, since its maps are rebaked in place)
function bakeMaps(seed = getSeed(), reDevelopFluid = true, staged = false) {
  const styleIndex = Math.max(0, STYLES.indexOf(params.style()));
  const shapeMode = currentShapeMode();
  const fluidOpts = { turbulence: params.turbulence(), fluidFlow: params.fluidFlow() };
  if (reDevelopFluid) appliedFluidKey = currentFluidKey();
  const bakeSteps = baker.bakeSteps({
    styleIndex,
    shapeMode,
    crust: params.crust(),
    scale: params.scale(),
    fluidFlow: params.fluidFlow(),
    relief: params.relief(),
    seed,
  });
  bakeJob = bakeJobSteps(reDevelopFluid, seed, fluidOpts, bakeSteps);
  if (!staged) {
    for (const _ of bakeJob);
    bakeJob = null;
  }

  const rng = seededRandom(`mat:${seed}`);
  uniforms.uStyle.value = styleIndex;
  uniforms.uSeedOffset.value.set((rng() - 0.5) * 20, (rng() - 0.5) * 20, (rng() - 0.5) * 20);
  appliedBakeKey = currentBakeKey();
  appliedLookKey = currentLookKey();
  bakeChangedAt = 0;
}

// Geometry detail 1 is the quality tier's full tessellation; 0 keeps only the big forms in the mesh
// (three levels shallower, an 8x looser tolerance) and leaves the rest to the normal map and parallax
function meshSettings(detail) {
  const { levels, tol, maxTriangles } = meshQuality;
  const minLevels = Math.max(6, levels - 3);
  return {
    levels: Math.round(minLevels + (levels - minLevels) * detail),
    tol: tol * Math.pow(8, 1 - detail),
    maxTriangles,
  };
}

let appliedDetail = -1;
let detailChangedAt = 0;

// Must match displace() in material.js
const displacementAmount = (relief) => 0.04 + relief * 0.135;

// Builds the mesh for the maps just baked; only the latest request is applied.
// Its distance field goes to sdf.a when it is the rock on show, to sdf.b when it is a morph target.
let buildSerial = 0;
async function buildMesh(seed = getSeed(), { target = "a" } = {}) {
  const serial = ++buildSerial;
  const detail = params.detail();
  const opts = {
    radius: 1.36,
    baker,
    shape: params.shape(),
    seed,
    dispAmp: displacementAmount(params.relief()),
    ...meshSettings(detail),
  };
  // The baked mesh info arrives asynchronously
  if (!(await baker.ready) || serial !== buildSerial) return false;
  const built = await meshBuilder.build(opts);
  if (serial !== buildSerial) {
    built.geometry.dispose();
    return false;
  }
  magmaMesh.geometry.dispose();
  magmaMesh.geometry = built.geometry;
  if (!magmaMesh.visible) uploader.start(built.geometry);
  else uploader.queue = [];
  appliedDetail = detail;
  writeVolume(sdf[target], built.sdf);
  writeVolume(heatVolume, built.heat);
  if (built.flow) writeVolume(flowVolume, built.flow);
  embers.setEmitters(built.emitters, magmaMesh);
  embers.setSpawnWeights(built.emitters.length ? lavaPulse.setProbePoints(built.emitters, 7) : null);
  embers.setCollider(() => ({ data: sdf.a.image.data, size: SDF_SIZE, bound: SDF_BOUND }));
  const bs = built.geometry.boundingSphere;
  const extent = Math.min(SDF_BOUND, bs.center.length() + bs.radius + 0.1);
  if (target === "a") Object.assign(look, { radiusA: built.volumeRadius, extentA: extent });
  else Object.assign(look, { radiusB: built.volumeRadius, extentB: extent });
  return true;
}

function changeLook(reDevelopFluid) {
  look.fluid ||= reDevelopFluid;
  if (look.phase === "idle" || look.phase === "cool") {
    look.phase = "melt";
    // The rock keeps its maps through the melt, but the fluid for the new look can develop already
    if (reDevelopFluid && !bakeJob) bakeJob = developFluid(getSeed(), { turbulence: params.turbulence(), fluidFlow: params.fluidFlow() });
    look.lookA.scale = uniforms.uScale.value;
    look.lookA.seed.copy(uniforms.uSeedOffset.value);
    look.lookMix = 0;
  }
  else if (look.phase === "collapse" || look.phase === "slosh") buildMorphTarget();
  else if (look.phase === "recompose" || look.phase === "handOut") look.queued = true;
}

// Runs while the liquid is on show and the rock is hidden
function buildMorphTarget() {
  look.ready = false;
  look.queued = false;
  const reDevelopFluid = look.fluid;
  look.fluid = false;
  const seed = getSeed();
  bakeMaps(seed, reDevelopFluid, true);
  syncShownToParams();
  buildMesh(seed, { target: "b" }).then((ok) => {
    if (ok) look.ready = true;
  });
}

function startCollapse() {
  look.phase = "collapse";
  look.t = 0;
  look.sloshTime = 0;
  look.pool = look.radiusA * POOL_SCALE;
}

function swapSdf() {
  [sdf.a, sdf.b] = [sdf.b, sdf.a];
}

function syncShownToParams() {
  lastBackdrop = params.backdrop();
  bgTarget.set(BACKDROPS[lastBackdrop] ?? BACKDROPS.Obsidian);
  for (const key of Object.keys(eased)) if (params[key] && key !== "embers") eased[key] = params[key]();
  eased.turbulence = eased.flow;
}

function stepLook(wallDt) {
  const mu = morphUniforms;
  if (look.phase === "melt") {
    look.melt = Math.min(1, look.melt + wallDt / MELT_TIME);
    if (look.melt >= 1) look.phase = "handIn";
  } else if (look.phase === "handIn") {
    look.march = Math.min(1, look.march + wallDt / HAND_TIME);
    if (look.march >= 1) {
      magmaMesh.visible = false;
      startCollapse();
      buildMorphTarget();
    }
  } else if (look.phase === "collapse") {
    look.t = Math.min(1, look.t + wallDt / COLLAPSE_TIME);
    if (look.t > 0.5) look.sloshTime += wallDt;
    if (nativeRandom() < 0.4) emitFromSurface(1);
    if (look.t >= 1) {
      look.phase = "slosh";
      look.t = 0;
    }
  } else if (look.phase === "slosh") {
    look.t += wallDt / SLOSH_TIME;
    look.sloshTime += wallDt;
    // The pool takes the new form's volume
    const target = (look.ready ? look.radiusB : look.radiusA) * POOL_SCALE;
    look.pool += (target - look.pool) * (1 - Math.exp(-wallDt * 2.5));
    if (look.t >= 1 && look.ready && Math.abs(look.pool - target) < 0.01) {
      look.pool = target;
      look.phase = "recompose";
      look.t = 0;
    }
  } else if (look.phase === "recompose") {
    look.t = Math.min(1, look.t + wallDt / RECOMPOSE_TIME);
    look.sloshTime += wallDt;
    if (look.t >= 1 && look.lookMix >= 1) {
      if (look.queued) {
        swapSdf();
        look.radiusA = look.radiusB;
        look.extentA = look.extentB;
        look.lookA.scale = uniforms.uScale.value;
        look.lookA.seed.copy(uniforms.uSeedOffset.value);
        look.lookMix = 0;
        startCollapse();
        buildMorphTarget();
      } else {
        magmaMesh.visible = true;
        look.phase = "handOut";
      }
    }
  } else if (look.phase === "handOut") {
    look.march = Math.max(0, look.march - wallDt / HAND_TIME);
    if (look.march <= 0) {
      swapSdf();
      look.radiusA = look.radiusB;
      look.extentA = look.extentB;
      look.phase = "cool";
      autoChange.restart();
    }
  } else if (look.phase === "cool") {
    look.melt = Math.max(0, look.melt - wallDt / COOL_TIME);
    if (look.melt <= 0) look.phase = "idle";
  }

  const stage = { collapse: 1, slosh: 2, recompose: 3 }[look.phase] ?? (look.phase === "handOut" ? 3 : 0);
  mu.uStage.value = stage;
  mu.uCollapse.value = look.phase === "collapse" ? smooth(look.t) : 0;
  mu.uRecompose.value = look.phase === "recompose" ? smooth(look.t) : 1;
  mu.uSloshTime.value = look.sloshTime;
  mu.uPoolRadius.value = look.pool;
  mu.uSdfA.value = sdf.a;
  mu.uSdfB.value = sdf.b;
  // Bounds of the morph field: where its surface can be (uFieldRadius), and beyond which it is at least 0.2
  // (uFieldClear; the pool's field understates distance and smin cuts up to 0.09 into it)
  const poolR = 0.2 + look.pool * 1.28;
  let shapeR = look.extentA;
  if (stage === 1) shapeR = look.extentA * (1 - 0.3 * mu.uCollapse.value) + 0.3 * mu.uCollapse.value ** 2;
  if (stage === 3) shapeR = look.extentB * (0.45 + 0.55 * mu.uRecompose.value) + 0.35 * (1 - mu.uRecompose.value) ** 2;
  if (stage === 0) {
    mu.uFieldRadius.value = shapeR;
    mu.uFieldClear.value = shapeR + 0.25;
  } else if (stage === 2) {
    mu.uFieldRadius.value = poolR + 0.1;
    mu.uFieldClear.value = poolR + 0.6;
  } else {
    mu.uFieldRadius.value = Math.max(shapeR, poolR + 0.1) + 0.09;
    mu.uFieldClear.value = Math.max(shapeR + 0.25, poolR + 0.6) + 0.09;
  }

  // Once the new look is built, the liquid's pattern cross-fades to it while it churns and rises
  if (look.ready && (look.phase === "slosh" || look.phase === "recompose")) look.lookMix = Math.min(1, look.lookMix + wallDt / 1.6);
  uniforms.uMelt.value = look.melt;
  // The lava pattern turns neutral over the end of the melt, and back to the look's early in the cooling
  uniforms.uNeutral.value = Math.min(1, Math.max(0, (look.melt - 0.55) / 0.45));
}

const emitPoint = new Vector3();
function emitFromSurface(count) {
  const pos = magmaMesh.geometry.getAttribute("position");
  if (!pos) return;
  for (let i = 0; i < count; i++) {
    emitPoint.fromBufferAttribute(pos, Math.floor(nativeRandom() * pos.count));
    embers.burst(magmaMesh.localToWorld(emitPoint), 2);
  }
}

let initialized = false;
let lastStyle = params.style();
let lastBackdrop = params.backdrop();
const bgColor = new Color(BACKDROPS[lastBackdrop]);
const bgTarget = bgColor.clone();

function applyStylePreset(styleName) {
  const profile = STYLE_PROFILES[styleName];
  if (!profile) return;
  params.crust.set(profile.crust);
  params.fluidFlow.set(profile.fluidFlow);
  params.turbulence.set(profile.turbulence);
  params.scale.set(profile.scale);
  params.relief.set(profile.relief);
  params.heat.set(profile.heat);
  params.gloss.set(profile.gloss);
}

const eased = {
  heat: params.heat(),
  glow: params.glow(),
  glowSpread: params.glowSpread(),
  relief: params.relief(),
  gloss: params.gloss(),
  scale: params.scale(),
  flow: params.flow(),
  embers: params.embers(),
  turbulence: params.turbulence(),
};

const remap = (param, lo, hi) => param.set(Number((lo + param() * (hi - lo)).toFixed(2)));

// A new look never repeats the shape or the style on show
function pickOther(param, options, previous) {
  if (param() !== previous) return;
  const rest = options.filter((o) => o !== previous);
  param.set(rest[Math.floor(Math.random() * rest.length)]);
}

onRandomize((seed) => {
  const previousStyle = params.style();
  const previousShape = params.shape();
  gui.randomizeAll();
  pickOther(params.style, STYLES, previousStyle);
  pickOther(params.shape, SHAPES, previousShape);
  const profile = STYLE_PROFILES[params.style()] ?? STYLE_PROFILES["Cracked Plates"];
  lastStyle = params.style();
  remap(params.crust, Math.max(0.32, profile.crust - 0.10), Math.min(0.90, profile.crust + 0.08));
  remap(params.fluidFlow, Math.max(0.10, profile.fluidFlow - 0.15), Math.min(0.98, profile.fluidFlow + 0.12));
  remap(params.turbulence, Math.max(0.12, profile.turbulence - 0.15), Math.min(0.95, profile.turbulence + 0.12));
  remap(params.scale, Math.max(0.80, profile.scale - 0.18), Math.min(1.65, profile.scale + 0.18));
  remap(params.relief, Math.max(0.45, profile.relief - 0.12), Math.min(0.96, profile.relief + 0.10));
  remap(params.heat, Math.max(0.58, profile.heat - 0.10), Math.min(0.95, profile.heat + 0.10));
  remap(params.gloss, Math.max(0.10, profile.gloss - 0.12), Math.min(0.92, profile.gloss + 0.12));
  remap(params.embers, 0.3, 0.8);
  if (initialized) changeLook(true);
});

applyUrlState();
// The backdrop is always Obsidian (older urls may name another)
params.backdrop.set("Obsidian");
lastStyle = params.style();
lastBackdrop = params.backdrop();
bgColor.set(BACKDROPS[lastBackdrop] ?? BACKDROPS.Obsidian);
bgTarget.copy(bgColor);
pipeline.background = bgColor;

Object.assign(eased, {
  heat: params.heat(),
  glow: params.glow(),
  glowSpread: params.glowSpread(),
  relief: params.relief(),
  gloss: params.gloss(),
  scale: params.scale(),
  flow: params.flow(),
  embers: params.embers(),
  turbulence: params.turbulence(),
});

// Compile the sim and bake shaders in parallel first, so the first bake doesn't stall the page
const precompile = new Scene();
const firstStyle = Math.max(0, STYLES.indexOf(params.style()));
for (const m of [...fluid.materials, ...baker.materialsFor(firstStyle), moltenMorph.material, fieldAtlas.material, ...Object.values(uploader.meshes).map((u) => u.material)]) precompile.add(new Mesh(fluid.quad.geometry, m));
await load.fluid.track(Promise.all([renderer.compileAsync(precompile, camera), rockSmoke?.compile(renderer)]), 4);
bakeMaps(getSeed(), true);
embers.reset();
load.bake.done();
// The page opens on the sloshing pool, which waits for the first mesh, so it builds while the pool sloshes
look.phase = "slosh";
look.t = 0;
look.sloshTime = 0.5;
look.radiusA = look.radiusB = 1.1;
look.pool = look.radiusB * POOL_SCALE;
look.melt = 1;
look.march = 1;
look.ready = false;
uniforms.uMelt.value = 1;
uniforms.uNeutral.value = 1;
buildMesh(getSeed(), { target: "b" }).then((ok) => {
  if (ok) look.ready = true;
});
await studio;
await load.compile.track(pipeline.compileAsync(scene, camera), 3);
magmaMesh.visible = false;
initialized = true;

// The other styles' bake programs compile in the background, so a style change doesn't stall
const laterStyles = new Scene();
baker.heightMats.forEach((m, i) => i !== firstStyle && laterStyles.add(new Mesh(fluid.quad.geometry, m)));
renderer.compileAsync(laterStyles, camera);

function syncImmediate() {
  lastStyle = params.style();
  lastBackdrop = params.backdrop();
  bgColor.set(BACKDROPS[lastBackdrop] ?? BACKDROPS.Obsidian);
  bgTarget.copy(bgColor);
  pipeline.background = bgColor;
  Object.assign(eased, {
    heat: params.heat(),
    glow: params.glow(),
    glowSpread: params.glowSpread(),
    relief: params.relief(),
    gloss: params.gloss(),
    scale: params.scale(),
    flow: params.flow(),
    embers: params.embers(),
    turbulence: params.turbulence(),
  });
  uniforms.uHeat.value = eased.heat;
  uniforms.uRelief.value = eased.relief;
  uniforms.uGloss.value = eased.gloss;
  uniforms.uScale.value = eased.scale;
}

window.app = {
  canvas: renderer.domElement,
  renderer,
  scene,
  params,
  pipeline,
  camera,
  controls,
  magmaMesh,
  fluid,
  baker,
  bakeMaps,
  buildMesh,
  changeLook,
  look,
  applyStylePreset,
  syncImmediate,
  styles: STYLES,
  embers,
  rockSmoke,
};

let lastWall = performance.now();
let flowTime = 0;
let probeClock = 0;
let flowRate = 0.2 + params.flow() * 1.2;
let renderTime = 0;

pipeline.composite = (hdr, ctx) => {
  morphUniforms.uMorphTime.value = renderTime;
  fieldAtlas.update();
  const withLiquid = moltenMorph.apply(hdr, ctx, {
    mesh: magmaMesh,
    alpha: look.march,
    flowTime,
    lookA: look.lookA,
    lookB: { scale: uniforms.uScale.value, seed: uniforms.uSeedOffset.value },
    lookMix: look.lookMix,
    lightDirection: globalUniforms.lightDirection.value,
  });
  const shaftOpts = {
    mesh: magmaMesh,
    strength: 0.5 * params.shaft(),
    // From high above and a little behind, so it reads as a column rather than fog facing the camera
    lightDirection: SHAFT_DIRECTION,
    time: renderTime,
    molten: smooth(look.melt),
  };
  const glowStrength = eased.glow * 1.15;
  // The glow's composite adds the shaft too; without a glow the shaft composites on its own
  const shaft = glowStrength > 0.005 ? lightShaft.march(ctx, shaftOpts) : null;
  const withShaft = glowStrength > 0.005 ? withLiquid : lightShaft.apply(withLiquid, ctx, shaftOpts);
  return volumetricGlow.apply(withShaft, ctx, {
    shaft,
    mesh: magmaMesh,
    strength: glowStrength,
    heatVolume,
    pulseVolume: lavaPulse.texture,
    // Crusted rock lights the air only where it is hot; molten rock glows all over
    surfaceGlow: 5.5 * (1 - smooth(look.melt)),
    shellGlow: smooth(look.melt),
    shimmer: 0.006 * params.shimmer(),
    spread: eased.glowSpread,
    heat: eased.heat,
    time: renderTime,
  });
};

render(({ time, dt }) => {
  renderTime = time;
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWall) * 0.001);
  lastWall = now;

  autoChange.update(dt);

  // Selecting a new Style preset automatically applies its reference-calibrated profile
  const styleNow = params.style();
  if (styleNow !== lastStyle) {
    lastStyle = styleNow;
    applyStylePreset(styleNow);
  }

  if (look.phase === "idle" || look.phase === "cool") {
    if (currentLookKey() !== appliedLookKey) {
      changeLook(currentFluidKey() !== appliedFluidKey);
    } else if (currentBakeKey() !== appliedBakeKey) {
      // Slider changes rebake in place, debounced
      if (!bakeChangedAt) bakeChangedAt = now;
      if (now - bakeChangedAt > 110) {
        bakeMaps(getSeed(), currentFluidKey() !== appliedFluidKey);
        buildMesh(getSeed());
      }
    } else {
      bakeChangedAt = 0;
      // Geometry detail only rebuilds the mesh, debounced while the slider moves
      if (appliedDetail >= 0 && params.detail() !== appliedDetail) {
        if (!detailChangedAt) detailChangedAt = now;
        if (now - detailChangedAt > 250) {
          detailChangedAt = 0;
          appliedDetail = params.detail();
          buildMesh(getSeed());
        }
      }
    }
  }

  stepLook(wallDt);
  if (bakeJob && bakeJob.next().done) bakeJob = null;
  else if (uploader.queue.length && !magmaMesh.visible) uploader.step();
  const frozen = isFrozen();

  const backdrop = params.backdrop();
  if (!frozen && backdrop !== lastBackdrop) {
    lastBackdrop = backdrop;
    bgTarget.set(BACKDROPS[backdrop] ?? BACKDROPS.Obsidian);
  }

  // Wall-clock easing for live shading parameters so changes show while paused
  // Panel edits ease in; the rock on show keeps its values while it leaves
  if (!frozen) {
    const k = 1 - Math.exp(-wallDt * 7);
    for (const key of Object.keys(eased)) if (params[key]) eased[key] += (params[key]() - eased[key]) * k;
    eased.turbulence = eased.flow;
  }
  pipeline.bloomStrength = 0.1 + eased.glow * 0.35;
  pipeline.bloomRadius = 0.32 + eased.glowSpread * 0.56;

  // The flow speed eases to a new look's, so the liquid never visibly jumps in pace
  // and slows while the rock is liquid, so the pattern holds together through the change
  const flowTarget = (0.2 + eased.flow * 1.2) * (look.phase === "idle" ? 1 : 0.45);
  flowRate += (flowTarget - flowRate) * (1 - Math.exp(-wallDt * 1.5));
  flowTime += dt * flowRate;
  uniforms.uHeat.value = eased.heat;
  uniforms.uRelief.value = eased.relief;
  uniforms.uGloss.value = eased.gloss;
  uniforms.uScale.value = eased.scale;
  uniforms.uFlowTime.value = flowTime;

  bgColor.lerp(bgTarget, 1 - Math.exp(-wallDt * 3));
  pipeline.background = bgColor;

  // Idle spin about world up, plus the drag's momentum once released
  magmaMesh.quaternion.premultiply(spinQuat.setFromAxisAngle(spinAxis.set(0, 1, 0), dt * params.spin()));
  if (!dragSpin.active && (dragSpin.x || dragSpin.y)) {
    turnRock(dragSpin.x * dt, dragSpin.y * dt);
    const decay = Math.exp(-dt * 3);
    dragSpin.x = Math.abs(dragSpin.x * decay) < 1e-3 ? 0 : dragSpin.x * decay;
    dragSpin.y = Math.abs(dragSpin.y * decay) < 1e-3 ? 0 : dragSpin.y * decay;
  }
  // While paused, the embers in the air keep drifting until they burn out, and no new ones start
  // Frozen with everything else while paused (dt is 0), so the paused scene can be orbited
  embers.update(dt, eased, { spawn: dt > 0 });

  controls.update();
  lavaPulse.update(sdf.a);
  if (rockSmoke && params.shaft() > 0.002) {
    const plume = params.smokePlumes();
    rockSmoke.set({
      plume,
      rise: params.smokeRise(),
      turbulence: params.smokeTurbulence(),
      lifetime: params.smokeLifetime(),
      draught: params.smokeDraught(),
      angle: params.smokeHeading(),
      scale: params.smokeSize(),
      lava: params.smokeLava(),
      under: params.smokeUnder(),
    });
    rockSmoke.update(renderer, time, magmaMesh, { molten: smooth(look.melt) });
    // Embers light the smoke; frozen with them while paused
    const emberLit = params.smokeEmberLight() > 0;
    if (!emberLit) emberLightAmount = -1;
    if (emberLit && (dt > 0 || emberLightAmount !== params.embers())) {
      emberLightAmount = params.embers();
      emberLight.update(embers);
    }
    lightShaft.setLook({
      room: params.smokeRoom(),
      wisps: Math.max(0, 1 - plume),
      plumes: plume,
      density: params.smokeDensity(),
      lavaLight: params.smokeLavaLight(),
      emberLight: params.smokeEmberLight(),
      embers: emberLit ? emberLight.texture : null,
    });
  }
  // Embers start where the flowing lava is bright now: refresh the per-emitter brightness a few times a second
  probeClock += wallDt;
  if (probeClock > 0.3 && magmaMesh.visible && params.embers() > 0) {
    probeClock = 0;
    lavaPulse.probe();
  }
  pipeline.render(scene, camera, time);
});
