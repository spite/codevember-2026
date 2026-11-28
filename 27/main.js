// Day 27 — Burrow: true 3D raytraced frosted glass block encasing a 3D baked cast-metal burrow
// with Total Internal Reflection, depth-dependent bilateral frost blur, volumetric ember glow, and matte slate plinth.
import {
  fromDefaults,
  renderer,
  camera,
  controls,
  render,
  onResize,
  onRandomize,
  applyUrlState,
  keysHelp,
  setDay,
  showHint,
  loadingStep,
  addKey,
  addActionButton,
  showSoundHint,
  onPause,
} from "common";
import { getSeed, seededRandom } from "modules/random.js";
import { GUI } from "guspira";
import { Scene, Mesh, Group, Vector2, Vector3, Spherical, Color, Shape, ExtrudeGeometry, LatheGeometry, CylinderGeometry, BoxGeometry, DataUtils } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { BLOCK_SPECS, ARCHETYPE_NAMES, SHAPE_NAMES, EXTENT } from "./volume.js";
import { bakeBurrowVolumes } from "./textures.js";
import { createPlinthMaterial, createBackdropMaterial, createToeMaterial, createCastShadowMaterial, METAL_FINISHES, FINISH_NAMES, spotUniforms, baseUniforms, BASE_INSET, BASE_GAP, FLOOR_Y } from "./materials.js";
import { GlassBurrow } from "./glass.js";
import { createSound } from "./sound.js";

const BACKGROUND = 0x131417;

const defaults = {
  archetype: "dendritic",
  shape: "cube",
  finish: "aluminum",
  encase: 1.0,
  chamfer: 0.052,
  frost: 0.45,
  marks: 0.35,
  markScale: 1,
  ior: 1.5,
  heat: 1.0,
  grain: 0.3,
  bubbles: 0.15,
  pour: 1.0,
  spotlight: 0.25,
  room: 0.12,
  baseLight: 1,
  complexity: 0.65,
  detail: "fast",
  spin: 0.1,
  orbit: true,
  auto: true,
  autoTime: 14,
};
const params = fromDefaults(defaults);

const load = {
  studio: loadingStep(1, "Lighting the gallery…"),
  burrow: loadingStep(2, "Casting the burrow…"),
  sound: loadingStep(1, "Fetching sounds…"),
  compile: loadingStep(8, "Compiling shaders…"),
};

const glass = new GlassBurrow();
const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1.05,
  bloomStrength: 0.14,
  vignette: 0.28,
  grain: 0.024,
  shadow: { autoFit: true, denoise: true },
  composite: (hdr, view) => glass.render(renderer, hdr, view),
});

// Dramatic raking gallery lighting: strong overhead-side key + cool rim fill on dark studio walls.
const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(-0.62, 0.85, 0.42),
    keyIntensity: 8.5,
    keySize: 0.44,
    fill: 0.12,
    fillColor: 0xb8c8dc,
    floor: 0.04,
    wall: 0.05,
  }),
);

// 3D volume resolution scaled by quality tier.
const VOL_RES = { low: 96, medium: 128, high: 144, capture: 160 }[pipeline.quality] || 128;

const sound = createSound({ onProgress: load.sound.set });
load.sound.track(sound.loaded);
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.on = !sound.on;
  soundButton.querySelector("img").src = `../assets/${sound.on ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.pause(!running));

addKey("KeyE", "toggle excavate", () => params.encase.set(params.encase() > 0.5 ? 0 : 1));
addKey("KeyC", "replay the cast", () => beginLift(false));
addKey("KeyM", "toggle sound", () => toggleSound());

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Archetype", params.archetype, ARCHETYPE_NAMES);
gui.addSelect("Encasing", params.shape, SHAPE_NAMES);
gui.addSelect("Finish", params.finish, FINISH_NAMES);
gui.addSlider("Level", params.encase, 0, 1, 0.01, { randomizable: false, title: "Raise or lower the frosted glass encasing volume (0 = fully excavated, 1 = fully encased)." });
gui.addSlider("Chamfer", params.chamfer, 0.004, 0.16, 0.002, { randomizable: false, title: "Radius of the rounded edge fillets on the glass encasing." });
const frostCtl = gui.addSlider("Frost", params.frost, 0, 1, 0.01, { title: "The even sanded finish of the glass: the haze and blur of what is inside." });
const marksCtl = gui.addSlider("Streaks", params.marks, 0, 1, 0.01, { title: "How much the frost smears what is behind it down the faces, as glass sanded in one direction." });
const markScaleCtl = gui.addSlider("Streak length", params.markScale, 0.25, 4, 0.01, { title: "How far the streaks smear." });
// Randomize stays where the frost and its streaks look good (a sweep of the three): heavy frost with long, strong
// streaks smears the highlights into white bars, and short streaks or light frost show nothing.
const pick = (lo, hi) => Math.round((lo + (hi - lo) * Math.random()) * 100) / 100;
frostCtl.randomize = () => params.frost.set(pick(0.3, 0.65));
marksCtl.randomize = () => params.marks.set(pick(0.15, params.frost() > 0.55 ? 0.4 : 0.6));
markScaleCtl.randomize = () => params.markScale.set(pick(0.8, params.frost() > 0.55 && params.marks() > 0.3 ? 1.5 : 2));
gui.addSlider("Refraction", params.ior, 1.1, 1.9, 0.01, { randomizable: false });
gui.addSlider("Heat", params.heat, 0, 1.5, 0.01, { title: "Molten ember intensity at the lower burrow tips (0 = fully cooled metal)." });
gui.addSlider("Grain", params.grain, 0, 1, 0.01, { title: "Sand-imprinted cast metal surface micro-texture (subtle cast grain always remains)." });
gui.addSlider("Bubbles", params.bubbles, 0, 1, 0.01, { title: "Trapped gas blowholes and spherical air pockets carved into the cast metal." });
gui.addSlider("Pour", params.pour, 0, 1, 0.01, { randomizable: false, title: "Molten metal pour fill progress from the top entrance (press C to replay)." });
gui.addSlider("Spotlight", params.spotlight, 0, 1, 0.01, { randomizable: false, title: "Volumetric overhead gallery spotlight shaft and drifting dust haze." });
gui.addSlider("Room light", params.room, 0, 1, 0.01, { randomizable: false, title: "Light on the plinth and backdrop outside the spot (0: only the spot and the embers)." });
gui.addSlider("Base light", params.baseLight, 0, 2, 0.01, { randomizable: false, title: "The warm strip tucked under the plinth." });
gui.addSlider("Complexity", params.complexity, 0.2, 1, 0.05);
gui.addSelect("Glass Detail", params.detail, ["fast", "ultra"], { randomizable: false, title: "Fast: 3-level frost pyramid, 6-step glow. Ultra: a 4th pyramid level, 12-step glow, seed bubbles and finer grain." });
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
gui.addCheckbox("Idle orbit", params.orbit, { randomizable: false, title: "Left alone, the camera slowly circles the piece, near and far, above and a little below." });
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => cycle.phase === "rest" });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Drag to orbit · C pour · E excavate · R new cast", "Drag to orbit · tap {randomize} for a new cast");
showSoundHint(() => !sound.running);
gui.show();

const scene = new Scene();
const plinthMat = createPlinthMaterial();
const backdropMat = createBackdropMaterial();

// Seamless dark charcoal gallery cyc backdrop.
function makeCyc() {
  const pts = [];
  const floorR = 11;
  const arcR = 4.5;
  const floorY = -1.85;
  pts.push(new Vector2(0, floorY));
  pts.push(new Vector2(floorR - arcR, floorY));
  for (let i = 1; i <= 16; i++) {
    const a = (i / 16) * (Math.PI * 0.5);
    pts.push(new Vector2(floorR - arcR + Math.sin(a) * arcR, floorY + arcR - Math.cos(a) * arcR));
  }
  pts.push(new Vector2(floorR, floorY + arcR + 10));
  const geo = new LatheGeometry(pts, 64);
  const mesh = new Mesh(geo, backdropMat);
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(makeCyc());

// Dark matte slate museum plinth resting at y = 0 with a subtle architectural edge chamfer.
function makeChamferedPlinth(w, h, d, bevel = 0.018) {
  const cr = bevel * 0.55;
  const hw = w * 0.5 - bevel;
  const hd = d * 0.5 - bevel;
  const s = new Shape();
  s.moveTo(-hw + cr, -hd);
  s.lineTo(hw - cr, -hd);
  s.absarc(hw - cr, -hd + cr, cr, -Math.PI * 0.5, 0, false);
  s.lineTo(hw, hd - cr);
  s.absarc(hw - cr, hd - cr, cr, 0, Math.PI * 0.5, false);
  s.lineTo(-hw + cr, hd);
  s.absarc(-hw + cr, hd - cr, cr, Math.PI * 0.5, Math.PI, false);
  s.lineTo(-hw, -hd + cr);
  s.absarc(-hw + cr, -hd + cr, cr, Math.PI, Math.PI * 1.5, false);
  const geo = new ExtrudeGeometry(s, {
    depth: h - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI * 0.5);
  geo.translate(0, -(h - bevel), 0);
  geo.computeVertexNormals();
  return geo;
}

const plinthGroup = new Group();
// The plinth floats a little above the floor on a recessed toe, with a warm strip tucked under its edge.
const plinthTop = new Mesh(makeChamferedPlinth(2.65, -FLOOR_Y - BASE_GAP, 2.65, 0.018), plinthMat);
plinthTop.castShadow = true;
plinthTop.receiveShadow = true;
const toe = new Mesh(new BoxGeometry(2.65 - 2 * BASE_INSET, BASE_GAP + 0.01, 2.65 - 2 * BASE_INSET), createToeMaterial());
toe.position.y = FLOOR_Y + (BASE_GAP + 0.01) / 2;
toe.receiveShadow = true;
plinthTop.add(toe);

// The cast's shadow caster: a box around the block, drawn only into the shadow map.
const castShadowMat = createCastShadowMaterial();
const castShadow = new Mesh(new BoxGeometry(1, 1, 1), castShadowMat);
castShadow.castShadow = true;
castShadow.receiveShadow = false;
scene.add(castShadow);
plinthGroup.add(plinthTop);
scene.add(plinthGroup);

let activeVol = null;
let currentKey = "";
const hasUrlPour = new URLSearchParams(location.search).has("pour");
let pourAnimActive = false;
let curPour = 1.0;
let curPourHeat = 0.0;
let lastSliderPour = 1.0;
// Seconds since the pour began: each point's heat follows when the front reached it.
const POUR_RATE = 0.24;
let pourClock = 1e3;

// The molten stream falling into the pour hole.
const streamMat = new PipelineMaterial({ color: "#000000", emissive: "#000000", roughness: 1 });
const stream = new Mesh(new CylinderGeometry(0.022, 0.03, 1, 16, 1, true), streamMat);
scene.add(stream);

function triggerPour() {
  pourAnimActive = true;
  curPour = 0.0;
  curPourHeat = 1.0;
  pourClock = 0;
  params.pour.set(1);
  lastSliderPour = 1;
}

// The cycle: an empty plinth, the pour defines the burrow, the resin rises around it as it cools, then it rests. A change
// lifts the finished piece out of the scene first; the next one is cast while the plinth is empty.
const LIFT_TIME = 1.8;
const LIFT_HEIGHT = 9;
const EMPTY_TIME = 0.8;
const RESIN_DELAY = 0.8;
const RESIN_TIME = 5.5;
const cycle = { phase: "empty", t: 0, lift: 0, resin: 0, rebuild: true };
function startCycle() {
  cycle.phase = "empty";
  cycle.t = 0;
  cycle.lift = 0;
  cycle.resin = 0;
  pourAnimActive = false;
  curPour = 0;
  curPourHeat = 0;
  pourClock = 0;
  params.pour.set(1);
  lastSliderPour = 1;
}
function beginLift(rebuild = true) {
  if (rebuild) startBake();
  if (cycle.phase === "lift") {
    cycle.rebuild ||= rebuild;
    return;
  }
  cycle.phase = "lift";
  cycle.t = 0;
  cycle.rebuild = rebuild;
}
function sculptureKey() {
  return `${params.archetype()}|${params.shape()}|${params.complexity().toFixed(2)}`;
}
function updateCycle(dt) {
  cycle.t += dt;
  if (cycle.phase === "lift") {
    const k = Math.min(cycle.t / LIFT_TIME, 1);
    cycle.lift = LIFT_HEIGHT * k * k * k;
    // Held out of view until the next piece is baked.
    if (k >= 1 && (!cycle.rebuild || bake?.vol)) {
      if (cycle.rebuild) {
        applyVolume(bake.vol);
        bake = null;
      }
      startCycle();
      curGlassMix = 0;
      cycle.snap = true;
    }
  } else if (cycle.phase === "empty") {
    if (cycle.t >= EMPTY_TIME) {
      cycle.phase = "pour";
      cycle.t = 0;
      triggerPour();
    }
  } else if (cycle.phase === "pour") {
    if (!pourAnimActive) {
      cycle.phase = "cool";
      cycle.t = 0;
    }
  } else if (cycle.phase === "cool") {
    const k = Math.min(Math.max((cycle.t - RESIN_DELAY) / RESIN_TIME, 0), 1);
    cycle.resin = k * k * (3 - 2 * k);
    if (k >= 1) {
      cycle.phase = "rest";
      autoChange.restart();
    }
  }
}

// Where the pour lands on the cast: the highest metal on the axis under the hole (world y).
let crownY = 1.8;
function findCrown(vol) {
  const T = VOL_RES;
  const data = vol.burrowTex.image.data;
  const c = Math.floor(T / 2);
  for (let j = T - 1; j >= 0; j--) {
    for (let k = c - 1; k <= c + 1; k++) {
      for (let i = c - 1; i <= c + 1; i++) {
        if (DataUtils.fromHalfFloat(data[((k * T + j) * T + i) * 4]) > 0.5) return vol.spec.hy - EXTENT + (j + 0.5) * vol.voxel;
      }
    }
  }
  return vol.spec.hy * 2;
}

// The plinth's width and depth, eased to each piece's.
const plinthSize = { current: new Vector2(2.65, 2.65), target: new Vector2(2.65, 2.65) };
let activeVolSet = false;
function setPlinthSize() {
  const { x: w, y: d } = plinthSize.current;
  plinthTop.scale.set(w / 2.65, 1, d / 2.65);
  baseUniforms.uPlinthHalf.value.set(w / 2, d / 2);
  glass.uniforms.uPlinthHalf.value.set(w / 2, (-FLOOR_Y - BASE_GAP) / 2, d / 2);
  glass.uniforms.uPlinthCenterY.value = (FLOOR_Y + BASE_GAP) / 2;
}

// The next piece bakes in a worker while the current one lifts away; its textures are uploaded as soon as it arrives.
let bake = null;
function startBake() {
  // A baked piece that never went on show.
  if (bake?.vol) {
    bake.vol.burrowTex.dispose();
    bake.vol.glowTex.dispose();
  }
  currentKey = sculptureKey();
  const job = { vol: null };
  bake = job;
  job.promise = bakeBurrowVolumes({
    archetype: params.archetype(),
    shape: params.shape(),
    complexity: params.complexity(),
    T: VOL_RES,
    G: 48,
    random: seededRandom(`${getSeed()}|${currentKey}`),
  }).then((vol) => {
    renderer.initTexture(vol.burrowTex);
    renderer.initTexture(vol.glowTex);
    if (bake === job) job.vol = vol;
    else {
      vol.burrowTex.dispose();
      vol.glowTex.dispose();
    }
    return vol;
  });
  return job.promise;
}

function applyVolume(vol) {
  const shape = vol.shape;
  crownY = findCrown(vol);

  if (activeVol) {
    activeVol.burrowTex.dispose();
    activeVol.glowTex.dispose();
  }
  activeVol = vol;
  glass.setVolume(vol);

  const spec = vol.spec;
  plinthMat.uniforms.tGlow.value = vol.glowTex;
  plinthMat.uniforms.uHasGlow.value = 1;
  castShadowMat.uniforms.tBurrow.value = vol.burrowTex;
  castShadowMat.uniforms.uVoxel.value = vol.voxel;
  castShadow.geometry.dispose();
  castShadow.geometry = new BoxGeometry(2 * spec.hx + 0.04, 2 * spec.hy + 0.04, 2 * spec.hz + 0.04);
  castShadow.position.y = spec.hy;
  plinthMat.uniforms.uHoleR.value = spec.holeR;
  plinthMat.uniforms.uBlockHalf.value.set(spec.hx, spec.hy, spec.hz);
  plinthMat.uniforms.uBlockType.value = spec.type;

  plinthSize.target.set(shape === "column" ? 1.85 : shape === "slab" ? 3.1 : 2.65, shape === "column" ? 1.85 : shape === "slab" ? 1.65 : 2.65);
  // The first piece sets it; later ones ease to theirs on the empty plinth.
  if (!activeVolSet) plinthSize.current.copy(plinthSize.target);
  activeVolSet = true;
  setPlinthSize();

}

// 3/4 museum macro camera framing matching the hero cube references.
// baseFov is what common.js widens for portrait on every resize; this first one is widened the same way here.
camera.userData.baseFov = 34;
camera.fov = camera.aspect < 1 ? (2 * Math.atan(Math.tan((34 * Math.PI) / 360) / camera.aspect) * 180) / Math.PI : 34;
camera.updateProjectionMatrix();
camera.position.set(3.45, 3.05, 3.85);
controls.target.set(0, 0.96, 0);
controls.enableDamping = true;
controls.minDistance = 2.0;
// Stay inside the cyc: its flat floor ends 6.5 from the centre and its wall stands at 11.
controls.maxDistance = 8.5;
controls.maxPolarAngle = Math.PI * 0.54;

onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));
onRandomize(() => {
  gui.randomizeAll();
  beginLift(true);
});

applyUrlState();
load.burrow.set(0.3);
// A seed in the url has already started this piece's bake.
if (!bake || currentKey !== sculptureKey()) startBake();
// R during the bake starts another: wait for whichever is current once it lands.
let firstJob;
do {
  firstJob = bake;
  await load.burrow.track(firstJob.promise);
} while (bake !== firstJob);
applyVolume(firstJob.vol);
bake = null;
if (hasUrlPour) {
  cycle.phase = "rest";
  cycle.resin = 1;
  curPour = params.pour();
  lastSliderPour = curPour;
  curPourHeat = curPour < 0.99 ? 1.0 : 0.0;
  pourClock = curPour < 0.99 ? curPour / POUR_RATE : 1e3;
} else {
  startCycle();
}
load.burrow.set(1);

await studio;
globalUniforms.shadowLightSize.value = 0.018;
// Soft-edged cast shadows: lookups average over at least a 7-texel disc.
globalUniforms.shadowMinTexels.value = 7;
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), glass.compile(renderer)]), 6);

// Wall-clock eased visual state so GUI/key changes animate smoothly even when paused.
const targetColor = new Color(METAL_FINISHES[params.finish()].color);
const curColor = targetColor.clone();
let curRough = METAL_FINISHES[params.finish()].roughness;
let curMetal = METAL_FINISHES[params.finish()].metalness;
let curUnderRough = METAL_FINISHES[params.finish()].undersideRough;
let curFrost = params.frost();
let curChamfer = params.chamfer();
let curIor = params.ior();
let curHeat = params.heat();
let curGrain = params.grain();
let curBubbles = params.bubbles();
let curSpotlight = params.spotlight();
let curGlassMix = hasUrlPour ? params.encase() : 0;
let curTargetY = (BLOCK_SPECS[params.shape()] || BLOCK_SPECS.cube).hy;
let rotY = 0;
let pulseTime = 0;
let lastWall = performance.now();

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  scene,
  glass,
  sound,
  rebuild: () => beginLift(true),
  pour: () => beginLift(false),
  cycle,
  // For recordings: restart this piece's cycle from the empty plinth, or lift it away for the next one (the given
  // params, else a randomize).
  restart: () => {
    startCycle();
    curGlassMix = 0;
  },
  nextLook: (look) => {
    if (look) for (const [k, v] of Object.entries(look)) params[k].set(v);
    else gui.randomizeAll();
    beginLift(true);
  },
  // Orbit from the start, even under ?capture.
  forceOrbit: false,
  // The whole orbit from high above, looking down.
  orbitHigh: false,
};

// Idle orbit: left alone, the camera circles the piece, drifting near and far, above and a little below.
const IDLE_DELAY = 6;
let idleFor = 0;
let idleWeight = 0;
let orbitTime = 0;
// 0 wide (the pour, the lift), 1 close in (the cooling and the resin, the finished piece).
let orbitClose = 0;
const orbitOffset = new Vector3();
const orbitSpherical = new Spherical();
for (const type of ["pointerdown", "wheel"]) renderer.domElement.addEventListener(type, () => (idleFor = 0), { passive: true });
let pointerHeld = false;
renderer.domElement.addEventListener("pointerdown", () => (pointerHeld = true));
for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, () => (pointerHeld = false));
const capturing = new URLSearchParams(location.search).has("capture");
const mix = (a, b, t) => a + (b - a) * t;
function idleOrbit(dt) {
  idleFor = pointerHeld ? 0 : idleFor + dt;
  const want = window.app.forceOrbit || (params.orbit() && !capturing && idleFor > IDLE_DELAY);
  idleWeight = window.app.forceOrbit ? 1 : want ? Math.min(1, idleWeight + dt / 3) : 0;
  if (idleWeight <= 0) return;
  orbitTime += dt;
  const w = idleWeight * idleWeight * (3 - 2 * idleWeight);
  const follow = 1 - Math.exp(-dt * 0.35 * w);
  const closeTarget = cycle.phase === "rest" ? 1 : cycle.phase === "cool" ? Math.min(1, cycle.t / 2.5) : 0;
  orbitClose += (closeTarget - orbitClose) * (1 - Math.exp(-dt * 0.9));
  const near = 3.2 + 1.0 * activeVol.spec.hy;
  controls.target.x -= controls.target.x * follow;
  controls.target.z -= controls.target.z * follow;
  orbitOffset.subVectors(camera.position, controls.target);
  orbitSpherical.setFromVector3(orbitOffset);
  const c = orbitClose * orbitClose * (3 - 2 * orbitClose);
  const radius = mix(5.2 + 2.0 * Math.sin(orbitTime * 0.09), near + 0.25 * Math.sin(orbitTime * 0.21), c);
  const elevation = window.app.orbitHigh ? 0.85 : mix(0.2 + 0.32 * Math.sin(orbitTime * 0.061 + 1.3), 0.12 + 0.16 * Math.sin(orbitTime * 0.13 + 0.4), c);
  // A little faster around while close, to show the cast through each face.
  orbitSpherical.theta += dt * (0.12 + 0.08 * c) * w;
  orbitSpherical.radius += (radius - orbitSpherical.radius) * (1 - Math.exp(-dt * 0.8 * w));
  orbitSpherical.phi += (Math.PI / 2 - elevation - orbitSpherical.phi) * (1 - Math.exp(-dt * 0.7 * w));
  orbitSpherical.makeSafe();
  camera.position.copy(controls.target).add(orbitOffset.setFromSpherical(orbitSpherical));
}

let soundStarted = false;
let pendingKey = null;
let pendingSince = 0;
render(({ time, dt }) => {
  if (!soundStarted) {
    soundStarted = true;
    sound.start();
  }
  const now = performance.now();
  const wallDt = Math.min((now - lastWall) * 0.001, 0.1);
  lastWall = now;
  const ease = cycle.phase === "lift" ? 0 : cycle.snap ? 1 : 1 - Math.exp(-wallDt * 7.5);
  cycle.snap = false;

  autoChange.update(dt);
  // A Complexity drag bakes once the slider rests (a bake per step would queue up); archetype and shape go at once.
  const wantKey = sculptureKey();
  if (wantKey !== currentKey) {
    if (wantKey !== pendingKey) (pendingKey = wantKey), (pendingSince = now);
    const sameForm = wantKey.split("|").slice(0, 2).join() === currentKey.split("|").slice(0, 2).join();
    if (!sameForm || now - pendingSince > 250) beginLift(true);
  }
  updateCycle(dt);
  const lift = cycle.lift;
  const present = cycle.phase === "lift" ? 1 - Math.min(cycle.t / LIFT_TIME, 1) : 1;

  const fin = METAL_FINISHES[params.finish()] || METAL_FINISHES.aluminum;
  targetColor.set(fin.color);
  curColor.lerp(targetColor, ease);
  curRough += (fin.roughness - curRough) * ease;
  curMetal += (fin.metalness - curMetal) * ease;
  curUnderRough += (fin.undersideRough - curUnderRough) * ease;
  curFrost += (params.frost() - curFrost) * ease;
  curChamfer += (params.chamfer() - curChamfer) * ease;
  curIor += (params.ior() - curIor) * ease;
  curHeat += (params.heat() - curHeat) * ease;
  curGrain += (params.grain() - curGrain) * ease;
  curBubbles += (params.bubbles() - curBubbles) * ease;
  curSpotlight += (params.spotlight() - curSpotlight) * ease;
  // The spot as glass.js places it: above the block along the key, aimed at its lower third.
  const keyDir = globalUniforms.lightDirection.value;
  spotUniforms.uSpotDir.value.copy(keyDir).normalize().negate();
  spotUniforms.uSpotPos.value.set(0, glass.uniforms.uHalfSize.value.y * 0.65, 0).addScaledVector(keyDir, 6.8 / keyDir.length());
  spotUniforms.uRoom.value = params.room();
  glass.uniforms.uPoolGain.value = params.room();
  if (cycle.phase !== "lift") {
    glass.uniforms.uMarks.value = params.marks();
    glass.uniforms.uMarkScale.value = params.markScale();
  }
  baseUniforms.uBaseLight.value = params.baseLight();
  const levelEase = 1 - Math.exp(-wallDt * 2.0);
  if (cycle.phase !== "lift") curGlassMix += (params.encase() * cycle.resin - curGlassMix) * levelEase;

  // Molten pour progression: auto-pours on new cast / P key, or responds immediately if user scrubs the Pour slider.
  const sliderPour = params.pour();
  if (Math.abs(sliderPour - lastSliderPour) > 0.004) {
    pourAnimActive = false;
    lastSliderPour = sliderPour;
    pourClock = sliderPour / POUR_RATE;
    if (cycle.phase !== "lift") {
      cycle.phase = "rest";
      cycle.resin = 1;
    }
  }
  pourClock += dt;
  if (pourAnimActive) {
    curPour = Math.min(1.0, curPour + dt * POUR_RATE);
    curPourHeat = 1.0;
    if (curPour >= 1.0) pourAnimActive = false;
  } else {
    // The plinth stays empty until the pour starts.
    curPour += ((cycle.phase === "empty" ? 0 : sliderPour) - curPour) * ease;
    const targetPourHeat = curPour < 0.985 && curPour > 0.005 ? 1.0 : 0.0;
    const coolRate = targetPourHeat > curPourHeat ? 1 - Math.exp(-dt * 8.0) : dt * 0.34;
    curPourHeat = targetPourHeat > curPourHeat
      ? curPourHeat + (targetPourHeat - curPourHeat) * coolRate
      : Math.max(0.0, curPourHeat - coolRate);
  }

  const spec = activeVol.spec;
  if (plinthSize.current.distanceTo(plinthSize.target) > 1e-4) {
    plinthSize.current.lerp(plinthSize.target, 1 - Math.exp(-dt * 5));
    setPlinthSize();
  }
  curTargetY += (spec.hy - curTargetY) * (1 - Math.exp(-wallDt * 2));
  controls.target.y = curTargetY;
  // Panning keeps the target near the plinth, so the camera never leaves the backdrop.
  const pan = Math.hypot(controls.target.x, controls.target.z);
  if (pan > 1.5) controls.target.set((controls.target.x * 1.5) / pan, controls.target.y, (controls.target.z * 1.5) / pan);

  rotY += dt * params.spin();
  pulseTime += dt;

  glass.uniforms.uBlockRot.value = rotY;
  glass.uniforms.uLift.value = lift;
  castShadow.position.y = spec.hy + lift;
  glass.uniforms.uBevel.value = Math.min(curChamfer, Math.min(spec.hx, spec.hz) * 0.42);
  glass.uniforms.uGlassMix.value = curGlassMix;
  glass.uniforms.uFrost.value = curFrost;
  glass.uniforms.uIor.value = curIor;
  glass.uniforms.uHeatIntensity.value = curHeat;
  glass.uniforms.uGrain.value = curGrain;
  glass.uniforms.uBubbles.value = curBubbles;
  glass.uniforms.uPour.value = curPour;
  castShadowMat.uniforms.uPour.value = curPour;
  castShadow.rotation.y = -rotY;
  glass.uniforms.uPourClock.value = pourClock;
  glass.uniforms.uPourRate.value = POUR_RATE;

  // Stream from above into the hole while the metal goes in, thinning as it ends.
  const flow = pourAnimActive ? 1 - Math.min(Math.max((curPour - 0.85) / 0.12, 0), 1) : 0;
  stream.visible = flow > 0.01;
  if (stream.visible) {
    // On the glass's pour hole while encased, else into the cast's crown (the metal hides the rest, and the filling
    // top moves while it pours).
    const top = Math.max(spec.hy * 2 * curGlassMix, crownY - 0.2);
    const h = 5;
    stream.position.set(0, top + h / 2, 0);
    stream.scale.set(flow * (0.9 + 0.1 * Math.sin(pulseTime * 37)), h, flow * (0.9 + 0.1 * Math.cos(pulseTime * 29)));
    streamMat.emissive.setRGB(26, 10, 2.4);
  }
  glass.uniforms.uPourHeat.value = curPourHeat;
  glass.uniforms.uUltra.value = params.detail() === "ultra" ? 1 : 0;
  glass.uniforms.uPulseTime.value = pulseTime;
  glass.uniforms.uMetalColor.value.copy(curColor);
  glass.uniforms.uMetalRough.value = curRough;
  glass.uniforms.uMetalness.value = curMetal;
  glass.uniforms.uUnderRough.value = curUnderRough;
  if (cycle.phase !== "lift") glass.uniforms.uFinishMode.value = fin.mode || 0;
  glass.uniforms.uSpotShaft.value = curSpotlight;

  const plinthPourScale = Math.min(Math.max((curPour - 0.30) / 0.65, 0), 1);
  plinthMat.uniforms.uHeatIntensity.value = curHeat * plinthPourScale * present;
  plinthMat.uniforms.uGlassMix.value = curGlassMix * present;
  plinthMat.uniforms.uBlockRot.value = rotY;
  plinthMat.uniforms.uLift.value = lift;
  plinthMat.uniforms.uBevel.value = glass.uniforms.uBevel.value;
  plinthMat.uniforms.uPulseTime.value = pulseTime;

  // The crackle follows the cooling once the stream stops.
  sound.update(wallDt, { flow, cooling: curPourHeat * (1 - flow) });

  idleOrbit(dt);
  controls.update();
  pipeline.render(scene, camera, time);
});
