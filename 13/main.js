import {
  fromDefaults,
  renderer,
  camera,
  controls,
  render,
  onResize,
  onRandomize,
  isRunning,
  applyUrlState,
  loadSeed,
  getSeed,
  addKey,
  keysHelp,
  addActionButton,
  onPause,
  setDay,
  showHint,
  showSoundHint,
  loadingStep,
  randomize,
} from "common";
import { GUI } from "guspira";
import {
  Scene,
  Group,
  Mesh,
  Color,
  Sphere,
  SphereGeometry,
  BufferGeometry,
  BufferAttribute,
  Vector3,
  Quaternion,
  Matrix4,
  MOUSE,
  TOUCH,
} from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { SHAPES } from "./shapes.js";
import {
  createMarbleState,
  placeMarbleAtStart,
  stepMarble,
  computeAutoTiltQuat,
  computeAutoTiltQuatOriginal,
  AUTO_PROFILES,
} from "./physics.js";
import { FINISHES, createLabyrinthMaterials, createMarbleSeeThroughMaterial, setReflectionData } from "./materials.js";
import { createBackdrop } from "./backdrop.js";
import { createLabyrinthSound } from "./sound.js";
import { createViewKeeper } from "./view.js";

const SHAPE_NAMES = Object.keys(SHAPES);
const TILING_NAMES = ["polyhedral", "triangular", "hexagonal", "octagonal", "masonry", "voronoi"];
const ALGORITHM_NAMES = ["backtracker", "kruskal", "braided", "rings"];
const WALL_STYLE_NAMES = ["original", "three-step", "straightened"];
const FINISH_NAMES = Object.keys(FINISHES);

const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
const isLowEnd = isMobile && ((navigator.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4);

const defaults = {
  shape: "icosahedron",
  tiling: "polyhedral",
  algorithm: "backtracker",
  density: 0.45,
  walls: "original",
  finish: "walnut & brass",
  cameraMode: "orbit",
  followHeight: 0.65,
  gravity: 1.0,
  music: 0.7,
  floorReflect: true,
  reflections: 0.75,
  reflectionReach: 1.5,
  mirrorTest: false,
  hint: false,
  autoPlay: true,
  solver: "steady",
  auto: true,
  autoTime: 25,
};
const params = fromDefaults(defaults);

const load = {
  sound: loadingStep(2),
  studio: loadingStep(1),
  build: loadingStep(2),
  compile: loadingStep(4),
};

const pipeline = new Pipeline(renderer, {
  quality: isLowEnd ? "low" : "auto",
  background: FINISHES[defaults.finish].backdrop,
  exposure: FINISHES[defaults.finish].exposure,
  bloomStrength: 0.04,
  vignette: 0.24,
  grain: 0.02,
  shadow: { autoFit: false, denoise: true },
  stillSamples: isLowEnd ? 8 : isMobile ? 16 : 48,
});
// Floor reflections of the walls and marble march per glossy pixel: desktop tiers only.
const floorReflections = pipeline.quality === "high" || pipeline.quality === "capture";
if (pipeline.quality === "low") {
  pipeline.bloom = false;
  pipeline.gi.steps = 4;
}
globalUniforms.aoIntensity.value = 1.0;
globalUniforms.aoMin.value = 0.05;
globalUniforms.giIntensity.value = 1.1;
globalUniforms.shadowNormalBias.value = 0.032;
globalUniforms.shadowBias.value = 0.0009;

const studioPromise = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(-0.55, 0.9, 0.48),
    keyIntensity: 13,
    keySize: 0.55,
    fill: 0.36,
    fillColor: 0xdfe5f0,
    floor: 0.28,
    wall: 0.36,
    ceiling: 0.24,
    tint: 0xfff8ef,
  }),
);

// ---------------------------------------------------------------------------
// GUI & Controls Help
// ---------------------------------------------------------------------------
const gui = new GUI(setDay(13), document.querySelector("#gui-container"));
gui.addSelect("Shape", params.shape, SHAPE_NAMES);
gui.addSelect("Cells", params.tiling, TILING_NAMES);
gui.addSelect("Maze", params.algorithm, ALGORITHM_NAMES);
gui.addSlider("Density", params.density, 0.15, 0.9, 0.05);
gui.addSelect("Walls", params.walls, WALL_STYLE_NAMES, { randomizable: false });
gui.addSelect("Finish", params.finish, FINISH_NAMES);
gui.addSelect("Camera", params.cameraMode, ["orbit", "follow"], { randomizable: false });
gui.addSlider("Follow height", params.followHeight, 0.25, 2.0, 0.05, { randomizable: false });
gui.addSlider("Gravity", params.gravity, 0.4, 1.8, 0.05, { randomizable: false });
gui.addSlider("Music", params.music, 0, 1, 0.01, { randomizable: false });
if (floorReflections) {
  gui.addCheckbox("Floor reflections", params.floorReflect, { randomizable: false });
  gui.addSlider("Reflections", params.reflections, 0, 1, 0.01, { randomizable: false });
  gui.addSlider("Reflection reach", params.reflectionReach, 0.5, 8, 0.1, { randomizable: false });
  gui.addCheckbox("Mirror floor (test)", params.mirrorTest, { randomizable: false });
}
gui.addCheckbox("Hint thread", params.hint, { randomizable: false });
gui.addCheckbox("Auto tilt", params.autoPlay, { randomizable: false });
gui.addSelect("Solver", params.solver, ["steady", "original", "optimal"], { randomizable: false });

let transitionPhase = "idle";
let solveBest = Infinity;
let solveStuck = 0;
const autoChange = createAutoChange({
  enabled: params.auto,
  every: params.autoTime,
  gui,
  max: 90,
  // While auto tilt is still getting closer to the goal, let it finish; a solve randomizes by itself.
  ready: () => transitionPhase === "idle" && !(params.autoPlay() && dragState.idleTime > 2 && solveStuck < 20),
});
pipeline.addGUI(gui);
gui.addSeparator();

const sound = createLabyrinthSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}

let resetMarbleRequested = false;
addKey("KeyM", "toggle sound", toggleSound);
addKey("KeyC", "toggle follow camera", () => {
  params.cameraMode.set(params.cameraMode() === "follow" ? "orbit" : "follow");
});
addKey("KeyH", "toggle hint thread", () => params.hint.set(!params.hint()));
addKey("KeyB", "return marble to start", () => {
  resetMarbleRequested = true;
});

onPause((running) => {
  sound.setPaused(!running);
  controls.mouseButtons.LEFT = running ? MOUSE.PAN : MOUSE.ROTATE;
  controls.touches.ONE = running ? null : TOUCH.ROTATE;
});

gui.addText(
  isMobile
    ? "Drag to turn the labyrinth · two fingers to zoom/orbit · reach the brass cup."
    : `Drag or WASD / Arrows to turn the labyrinth · Shift+drag or right-drag to orbit camera · scroll to zoom.<br/>${keysHelp()}`,
);
showHint(
  "Drag or WASD to tilt the labyrinth · Shift+drag to orbit · R for a new one",
  "Drag to tilt the labyrinth · pinch to zoom · tap {randomize} for a new one",
);
showSoundHint(() => !sound.running);
gui.show();

// ---------------------------------------------------------------------------
// Scene & Placeholder Meshes
// ---------------------------------------------------------------------------
const scene = new Scene();
const backdrop = createBackdrop();
scene.add(backdrop.mesh);

const isLowQuality = pipeline.quality === "low";
const { shared, floorMaterial, wallMaterial, marbleMaterial, hintMaterial } = createLabyrinthMaterials({
  lowDetail: isLowQuality,
});

const rigGroup = new Group();
scene.add(rigGroup);

function emptyFloorGeometry() {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("floorWallDist", new BufferAttribute(new Float32Array(3), 1));
  g.setAttribute("floorWallFar", new BufferAttribute(new Float32Array(3), 1));
  return g;
}

function emptyWallGeometry() {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("surfNormal", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("wallMeta", new BufferAttribute(new Float32Array(12), 4));
  g.setAttribute("wallShade", new BufferAttribute(new Float32Array(6), 2));
  return g;
}

function emptyHintGeometry() {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("surfNormal", new BufferAttribute(new Float32Array(9), 3));
  return g;
}

const floorMesh = new Mesh(emptyFloorGeometry(), floorMaterial);
const wallMesh = new Mesh(emptyWallGeometry(), wallMaterial);
const hintMesh = new Mesh(emptyHintGeometry(), hintMaterial);
const unitBallGeo = new SphereGeometry(1, isLowQuality ? 28 : 56, isLowQuality ? 18 : 36);
const marbleMesh = new Mesh(unitBallGeo, marbleMaterial);
const marbleSeeThrough = new Mesh(unitBallGeo, createMarbleSeeThroughMaterial());
marbleSeeThrough.scale.setScalar(1.05);
marbleSeeThrough.renderOrder = 2;
marbleSeeThrough.frustumCulled = false;
marbleSeeThrough.userData.noShadow = true;
marbleSeeThrough.userData.noWireframe = true;
marbleMesh.add(marbleSeeThrough);
// Draw walls first, then floor (so depth test skips floor pixels hidden beneath walls), then hint wire & marble, then backdrop (renderOrder = 1).
wallMesh.renderOrder = 0;
floorMesh.renderOrder = 0.25;
hintMesh.renderOrder = 0.3;
marbleMesh.renderOrder = 0.35;
hintMesh.userData.noShadow = true;
hintMesh.userData.noWireframe = true;
hintMesh.visible = false;
floorMesh.frustumCulled = false;
wallMesh.frustumCulled = false;
hintMesh.frustumCulled = false;
marbleMesh.frustumCulled = false;
rigGroup.add(floorMesh, wallMesh, hintMesh, marbleMesh);

// ---------------------------------------------------------------------------
// Camera, Trackball Drag & WASD / Arrow Controls
// ---------------------------------------------------------------------------
camera.near = 0.025;
camera.far = 50;
camera.updateProjectionMatrix();
camera.position.set(0, 1.75, 4.15);
controls.target.set(0, 0, 0);
controls.enablePan = false;
controls.enableRotate = true;
controls.minDistance = 1.8;
controls.maxDistance = 8.0;
controls.maxPolarAngle = Math.PI * 0.62;
// Shift+left-drag and right-drag both trigger OrbitControls.ROTATE while plain left-drag turns the shape!
controls.mouseButtons = {
  LEFT: MOUSE.PAN,
  MIDDLE: MOUSE.DOLLY,
  RIGHT: MOUSE.ROTATE,
};
controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };

const FRAME_RADIUS = 1.38;
let orbitDefaultDist = 4.5;
let framedPortrait = null;
onResize((w, h, dpr) => {
  const halfFov = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, w / h));
  orbitDefaultDist = Math.min(controls.maxDistance, FRAME_RADIUS / Math.sin(halfFov));
  // Reframe only on load and orientation changes, so a phone's toolbar resizing keeps the user's zoom.
  const portrait = w < h;
  if (params.cameraMode() !== "follow" && portrait !== framedPortrait) {
    framedPortrait = portrait;
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(orbitDefaultDist);
    camera.position.copy(controls.target).add(offset);
  }
  pipeline.setSize(w, h, dpr);
});

const shapeQuat = new Quaternion();
const angularVel = new Vector3();
const dragState = {
  active: false,
  pointerId: -1,
  lastX: 0,
  lastY: 0,
  deltaX: 0,
  deltaY: 0,
  idleTime: 1.6,
};
const activeTouchIds = new Set();
const heldKeys = new Set();

const canvas = renderer.domElement;

canvas.addEventListener(
  "wheel",
  (e) => {
    if (params.cameraMode() !== "follow") return;
    e.preventDefault();
    e.stopPropagation();
    const scaled = params.followHeight() * Math.exp(e.deltaY * 0.0012);
    const clamped = Math.max(0.25, Math.min(2.0, Math.round(scaled * 20) / 20));
    params.followHeight.set(clamped);
  },
  { capture: true, passive: false },
);
canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType === "touch") {
      activeTouchIds.add(e.pointerId);
      if (activeTouchIds.size >= 2) {
        dragState.active = false;
        return;
      }
    }
    if (!isRunning()) return;
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;

    // Plain left-drag turns the labyrinth; touches still reach OrbitControls so a second finger can pinch.
    if (e.pointerType !== "touch") e.stopPropagation();
    dragState.active = true;
    dragState.pointerId = e.pointerId;
    dragState.lastX = e.clientX;
    dragState.lastY = e.clientY;
    dragState.deltaX = 0;
    dragState.deltaY = 0;
    dragState.idleTime = 0;
    autoChange.restart?.();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
  },
  { capture: true },
);

canvas.addEventListener("pointermove", (e) => {
  if (!dragState.active || e.pointerId !== dragState.pointerId) return;
  dragState.deltaX += e.clientX - dragState.lastX;
  dragState.deltaY += e.clientY - dragState.lastY;
  dragState.lastX = e.clientX;
  dragState.lastY = e.clientY;
  dragState.idleTime = 0;
});

for (const eventName of ["pointerup", "pointercancel"]) {
  window.addEventListener(
    eventName,
    (e) => {
      activeTouchIds.delete(e.pointerId);
      if (e.pointerId === dragState.pointerId) {
        dragState.active = false;
        dragState.pointerId = -1;
      }
    },
    { capture: true },
  );
}

const TILT_KEY_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

window.addEventListener("keydown", (e) => {
  if (e.target?.matches?.("input, textarea, select")) return;
  if (TILT_KEY_CODES.has(e.code)) {
    e.preventDefault();
    heldKeys.add(e.code);
    dragState.idleTime = 0;
    autoChange.restart?.();
  }
});

window.addEventListener("keyup", (e) => {
  heldKeys.delete(e.code);
});

window.addEventListener("blur", () => {
  heldKeys.clear();
  dragState.active = false;
});

// ---------------------------------------------------------------------------
// Labyrinth State, Transitions & Orientation
// ---------------------------------------------------------------------------
const marble = createMarbleState();
let currentLabyrinth = null;
let puzzleSerial = 0;
let builtKey = "";
let shownShape = "";
let shownFinishName = "";
let booted = false;
let pendingRandomSeed = null;
let applyingAtBottom = false;
let pendingFullSwap = false;
let randomizingSwap = false;
let activeTransitionShrink = false;
let dropPlayedInRise = false;
let stageStartWall = 1;
let stageStartScale = 1;
let stageStartMusicFade = 1;
let rebuiltWhileHidden = false;
let musicFade = 1;
let transitionProgress = 0;
let rigScale = 1;
let wallRaise = 1;
let marbleReveal = 1;
let goalPulse = 0;
let lastSwooshAt = 0;

function desiredMazeSeedKey() {
  return [
    getSeed(),
    puzzleSerial,
    params.shape(),
    params.tiling(),
    params.algorithm(),
    params.density().toFixed(2),
  ].join("|");
}

function desiredBuildKey() {
  return `${desiredMazeSeedKey()}|${params.walls()}`;
}

// Rotates shapeQuat smoothly (or immediately on fresh shape load) so the Start dish faces upper-front toward camera
// (or in follow/chase mode, places Start on top with the opening corridor pointing straight ahead away from the chase cam).
const startNormalVec = new Vector3();
const startAimVec = new Vector3();
const startBinormVec = new Vector3();
const desiredViewDir = new Vector3();
const desiredFwdDir = new Vector3();
const desiredBinormDir = new Vector3();
const orientMatLocal = new Matrix4();
const orientMatWorld = new Matrix4();
const orientQuat = new Quaternion();
const chaseAnchorPos = new Vector3(0, 1.75, 4.15);
const followAutoAnchor = new Vector3(0, 1.75, -4.15);
const localChaseDir = new Vector3(0, 0, -1);
const smoothLocalVel = new Vector3();
let reverseHoldTime = 0;

function resetChaseHeading() {
  localChaseDir.copy(marble.smoothAimDir);
  localChaseDir.addScaledVector(marble.normal, -localChaseDir.dot(marble.normal));
  if (localChaseDir.lengthSq() < 1e-6) {
    localChaseDir.set(0, 0, -1).addScaledVector(marble.normal, marble.normal.z);
    if (localChaseDir.lengthSq() < 1e-6) {
      localChaseDir.set(1, 0, 0).addScaledVector(marble.normal, -marble.normal.x);
    }
  }
  localChaseDir.normalize();
  smoothLocalVel.set(0, 0, 0);
  reverseHoldTime = 0;
}

function orientStartTowardCamera(immediate = false) {
  if (!currentLabyrinth) return;
  startNormalVec.fromArray(currentLabyrinth.startCell.normal);
  if (params.cameraMode() === "follow") {
    startAimVec.copy(marble.smoothAimDir);
    startAimVec.addScaledVector(startNormalVec, -startAimVec.dot(startNormalVec));
    if (startAimVec.lengthSq() < 1e-6) {
      startAimVec.set(0, 0, -1).addScaledVector(startNormalVec, startNormalVec.z);
      if (startAimVec.lengthSq() < 1e-6) {
        startAimVec.set(1, 0, 0).addScaledVector(startNormalVec, -startNormalVec.x);
      }
    }
    startAimVec.normalize();
    startBinormVec.crossVectors(startNormalVec, startAimVec).normalize();

    desiredFwdDir.set(-chaseAnchorPos.x, 0, -chaseAnchorPos.z);
    if (desiredFwdDir.lengthSq() < 1e-4) desiredFwdDir.set(0, 0, -1);
    else desiredFwdDir.normalize();

    desiredViewDir.set(desiredFwdDir.x * 0.24, 0.97, desiredFwdDir.z * 0.24).normalize();
    desiredFwdDir.addScaledVector(desiredViewDir, -desiredFwdDir.dot(desiredViewDir)).normalize();
    desiredBinormDir.crossVectors(desiredViewDir, desiredFwdDir).normalize();

    orientMatLocal.makeBasis(startBinormVec, startNormalVec, startAimVec);
    orientMatWorld.makeBasis(desiredBinormDir, desiredViewDir, desiredFwdDir);
    orientMatWorld.multiply(orientMatLocal.transpose());
    orientQuat.setFromRotationMatrix(orientMatWorld).normalize();
  } else {
    desiredViewDir.copy(camera.position).normalize().add(new Vector3(0, 0.35, 0)).normalize();
    orientQuat.setFromUnitVectors(startNormalVec, desiredViewDir);
  }
  if (immediate) {
    shapeQuat.copy(orientQuat);
    marble.prevShapeQuat.copy(shapeQuat);
  } else {
    shapeQuat.slerp(orientQuat, 0.85);
    marble.prevShapeQuat.copy(shapeQuat);
  }
}

const shadowBoundSphere = new Sphere(new Vector3(0, 0, 0), 1.15);

// Labyrinths are built in a worker; a result is used only if it still matches the wanted build.
const buildWorker = new Worker(new URL("./build.worker.js", import.meta.url), { type: "module" });
const builder = { requestedKey: "", ready: null, onReady: null };

function unpackGeometry({ attributes, index }) {
  const g = new BufferGeometry();
  for (const [name, { array, itemSize }] of Object.entries(attributes)) g.setAttribute(name, new BufferAttribute(array, itemSize));
  if (index) g.setIndex(new BufferAttribute(index, 1));
  return g;
}

const noiseBaked = new Promise((resolve) => {
  builder.onNoise = resolve;
});
buildWorker.postMessage({ type: "noise", size: shared.uNoiseVol.value.image.width });

buildWorker.onmessage = ({ data }) => {
  if (data.type === "noise") {
    shared.uNoiseVol.value.image.data = data.data;
    shared.uNoiseVol.value.needsUpdate = true;
    builder.onNoise();
    return;
  }
  if (data.key !== builder.requestedKey) return;
  if (data.error) {
    console.error(data.error);
    builder.requestedKey = "";
    puzzleSerial++;
    requestBuild();
    return;
  }
  const next = data.labyrinth;
  next.key = data.key;
  next.shape = SHAPES[next.shapeName];
  next.floorGeometry = unpackGeometry(next.floorGeometry);
  next.wallGeometry = unpackGeometry(next.wallGeometry);
  next.hintGeometry = unpackGeometry(next.hintGeometry);
  builder.ready = next;
  builder.onReady?.();
};

function requestBuild() {
  const key = desiredBuildKey();
  if (key === builder.requestedKey) return;
  builder.requestedKey = key;
  builder.ready = null;
  buildWorker.postMessage({
    key,
    seedKey: desiredMazeSeedKey(),
    options: {
      shapeName: params.shape(),
      tiling: params.tiling(),
      algorithm: params.algorithm(),
      density: params.density(),
      wallStyle: params.walls(),
      lowDetail: isLowQuality,
    },
  });
}

// Returns the wanted labyrinth once the worker has it, requesting it if needed.
function takeBuild() {
  requestBuild();
  const next = builder.ready;
  if (!next || next.key !== desiredBuildKey()) return null;
  builder.ready = null;
  return next;
}

function installLabyrinth(next, orientImmediate) {
  floorMesh.geometry.dispose();
  wallMesh.geometry.dispose();
  hintMesh.geometry.dispose();
  floorMesh.geometry = next.floorGeometry;
  wallMesh.geometry = next.wallGeometry;
  hintMesh.geometry = next.hintGeometry;

  currentLabyrinth = next;
  builtKey = next.key;
  setReflectionData(shared, next);
  shownShape = next.shapeName;

  marbleMesh.scale.setScalar(next.marbleRadius);
  shared.uMarbleRadius.value = next.marbleRadius;
  shared.uGoalLocalPos.value.fromArray(next.goalCell.center);
  shared.uStartLocalPos.value.fromArray(next.startCell.center);
  shared.uPocketRadius.value = next.pocketRadius;

  // Place backdrop below lowest possible point of the rotated shape & fit shadow camera once cleanly!
  const maxBound = Math.hypot(...next.shape.bounds);
  backdrop.place(-Math.min(1.22, maxBound));
  shadowBoundSphere.radius = maxBound + 0.08;
  pipeline.shadow.fit(shadowBoundSphere);
  globalUniforms.occluders.value[0].set(0, 0, 0, Math.min(0.95, next.shape.bounds[1]));
  globalUniforms.occluderCount.value = 1;

  placeMarbleAtStart(marble, next);
  solveBest = Infinity;
  solveStuck = 0;
  resetChaseHeading();
  if (orientImmediate) {
    angularVel.set(0, 0, 0);
    orientStartTowardCamera(true);
  }
  pipeline.restartAccumulation();
}

// Smoothly interpolates finish colors & roughness on wall-clock delta so edits show while paused.
const shownLook = {
  floorColor: new Color(),
  floorSecondary: new Color(),
  wallColor: new Color(),
  crownColor: new Color(),
  rimColor: new Color(),
  marbleColor: new Color(),
  marbleAccent: new Color(),
  bgColor: new Color(),
  initialized: false,
};
const scratchColor = new Color();

let lookSettling = false;

function updateFinishLook(wallDt, snap = false) {
  const finishKey = shownFinishName || params.finish();
  const f = FINISHES[finishKey] ?? FINISHES["walnut & brass"];
  const k = snap || !shownLook.initialized ? 1 : 1 - Math.exp(-wallDt * 7);
  shownLook.initialized = true;

  shownLook.floorColor.lerp(scratchColor.set(f.floorColor), k);
  shownLook.floorSecondary.lerp(scratchColor.set(f.floorSecondary), k);
  shownLook.wallColor.lerp(scratchColor.set(f.wallColor), k);
  shownLook.crownColor.lerp(scratchColor.set(f.wallCrown), k);
  shownLook.rimColor.lerp(scratchColor.set(f.rimColor), k);
  shownLook.marbleColor.lerp(scratchColor.set(f.marbleColor), k);
  shownLook.marbleAccent.lerp(scratchColor.set(f.marbleAccent), k);
  shownLook.bgColor.lerp(scratchColor.set(f.backdrop), k);

  floorMaterial.color.copy(shownLook.floorColor);
  floorMaterial.roughness += (f.floorRough - floorMaterial.roughness) * k;
  floorMaterial.metalness += (f.floorMetal - floorMaterial.metalness) * k;

  wallMaterial.color.copy(shownLook.wallColor);
  wallMaterial.roughness += (f.wallRough - wallMaterial.roughness) * k;
  wallMaterial.metalness += (f.wallMetal - wallMaterial.metalness) * k;

  marbleMaterial.color.copy(shownLook.marbleColor);
  marbleMaterial.roughness += (f.marbleRough - marbleMaterial.roughness) * k;
  marbleMaterial.metalness += (f.marbleMetal - marbleMaterial.metalness) * k;

  shared.uFinishId.value = f.id;
  shared.uMarbleStyle.value = f.marbleStyle;
  shared.uFloorSecondary.value.copy(shownLook.floorSecondary);
  shared.uCrownColor.value.copy(shownLook.crownColor);
  shared.uRimColor.value.copy(shownLook.rimColor);
  shared.uRimMetal.value += (f.rimMetal - shared.uRimMetal.value) * k;
  shared.uRimRough.value += (f.rimRough - shared.uRimRough.value) * k;
  shared.uMarbleAccent.value.copy(shownLook.marbleAccent);

  const targetHint = params.hint() ? 1 : 0;
  shared.uShowHint.value += (targetHint - shared.uShowHint.value) * (snap ? 1 : 1 - Math.exp(-wallDt * 9));
  hintMesh.visible = shared.uShowHint.value > 0.005 && wallRaise > 0.08 && rigGroup.visible;

  pipeline.background.copy(shownLook.bgColor);
  pipeline.exposure += (f.exposure - pipeline.exposure) * k;
  backdrop.setColor(f.backdrop, 0.74);
  if (snap) backdrop.snap();
  else backdrop.update(wallDt);

  // Uniform-only blends are invisible to the pipeline, so restart the still until they settle.
  scratchColor.set(f.wallColor);
  const colorGap = Math.abs(scratchColor.r - shownLook.wallColor.r) + Math.abs(scratchColor.g - shownLook.wallColor.g) + Math.abs(scratchColor.b - shownLook.wallColor.b);
  lookSettling = !snap && colorGap + Math.abs(f.floorRough - floorMaterial.roughness) + Math.abs(f.exposure - pipeline.exposure) + Math.abs(targetHint - shared.uShowHint.value) > 1e-3;
}

// ---------------------------------------------------------------------------
// Step Transitions
//   - Shape switch / Randomize: walls-down -> shape-out -> calculate values & labyrinth -> shape-in -> walls-up
//   - Same-shape rebuild (win / Maze / Cells / Density): walls-down -> calculate labyrinth -> walls-up
// ---------------------------------------------------------------------------
function easeOutBack(t) {
  const c1 = 1.38;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function rebuildAtBottom() {
  if (pendingRandomSeed !== null) {
    const seedToApply = pendingRandomSeed;
    pendingRandomSeed = null;
    applyingAtBottom = true;
    loadSeed(seedToApply);
    applyingAtBottom = false;
  }
  pendingFullSwap = false;
  activeTransitionShrink = false;
  shownFinishName = params.finish();
  updateFinishLook(1, true);
  requestBuild();
}

function updateTransitions(dt) {
  const fullSwapWanted = pendingFullSwap || params.shape() !== shownShape;
  const rebuildWanted = fullSwapWanted || desiredBuildKey() !== builtKey;

  if (transitionPhase === "idle") {
    if (!fullSwapWanted) {
      shownFinishName = params.finish();
      musicFade = 1;
    }
    if (rebuildWanted) {
      if (!fullSwapWanted) requestBuild();
      sound.silenceLoops();
      activeTransitionShrink = fullSwapWanted;
      stageStartWall = wallRaise;
      stageStartMusicFade = musicFade;
      transitionPhase = "walls-down";
      transitionProgress = 0;
      sound.wallWave({ rising: false, duration: 0.34 });
    }
  } else if (transitionPhase === "walls-down") {
    if (fullSwapWanted) activeTransitionShrink = true;
    transitionProgress = Math.min(1, transitionProgress + dt / 0.34);
    wallRaise = stageStartWall * (1 - transitionProgress * transitionProgress);
    marbleReveal = Math.max(0, Math.min(1, (wallRaise - 0.08) / 0.92));
    if (randomizingSwap) {
      musicFade = stageStartMusicFade * (1 - 0.68 * transitionProgress);
    }
    wallMesh.visible = true;
    marbleMesh.visible = marbleReveal > 0.02;

    if (transitionProgress >= 1) {
      wallRaise = 0;
      marbleReveal = 0;
      marbleMesh.visible = false;
      if (activeTransitionShrink) {
        wallMesh.visible = false;
        stageStartScale = rigScale;
        stageStartMusicFade = musicFade;
        transitionPhase = "shape-out";
        transitionProgress = 0;
        sound.swoosh({ spinSpeed: 4.8 });
      } else {
        // Holds with the walls down until the worker delivers.
        const next = takeBuild();
        if (next) {
          const oldStart = currentLabyrinth?.startCell.center;
          installLabyrinth(next, false);
          const newStart = next.startCell.center;
          // A wall style change can still move the start, so compare positions rather than seeds.
          if (!oldStart || Math.hypot(oldStart[0] - newStart[0], oldStart[1] - newStart[1], oldStart[2] - newStart[2]) > 1e-3) {
            orientStartTowardCamera(false);
          }
          wallMesh.visible = true;
          dropPlayedInRise = false;
          transitionPhase = "walls-up";
          transitionProgress = 0;
          sound.wallWave({ rising: true, duration: 0.44 });
        }
      }
    }
  } else if (transitionPhase === "shape-out") {
    wallRaise = 0;
    marbleReveal = 0;
    wallMesh.visible = false;
    marbleMesh.visible = false;
    angularVel.multiplyScalar(Math.exp(-dt * 8));
    transitionProgress = Math.min(1, transitionProgress + dt / 0.28);
    const rem = 1 - transitionProgress;
    rigScale = stageStartScale * Math.pow(rem, 2.2);
    if (randomizingSwap) {
      musicFade = stageStartMusicFade * rem * rem;
    }

    if (transitionProgress >= 1 || rigScale <= 0.0015) {
      rigScale = 0;
      rigGroup.visible = false;
      if (randomizingSwap) musicFade = 0;
      rebuiltWhileHidden = false;
      transitionPhase = "shape-hidden";
      transitionProgress = 0;
    }
  } else if (transitionPhase === "shape-hidden") {
    rigScale = 0;
    wallRaise = 0;
    marbleReveal = 0;
    wallMesh.visible = false;
    marbleMesh.visible = false;
    rigGroup.visible = false;
    if (randomizingSwap) musicFade = 0;

    if (!rebuiltWhileHidden) {
      rebuildAtBottom();
      rebuiltWhileHidden = true;
    } else {
      const next = takeBuild();
      if (next) {
        installLabyrinth(next, true);
        transitionPhase = "shape-in";
        transitionProgress = 0;
        sound.swoosh({ spinSpeed: 4.2 });
      }
    }
  } else if (transitionPhase === "shape-in") {
    wallRaise = 0;
    marbleReveal = 0;
    wallMesh.visible = false;
    marbleMesh.visible = false;

    if (fullSwapWanted) {
      stageStartScale = rigScale;
      stageStartMusicFade = musicFade;
      transitionPhase = "shape-out";
      transitionProgress = 0;
    } else {
      transitionProgress = Math.min(1, transitionProgress + dt / 0.38);
      rigScale = Math.max(0.001, easeOutBack(transitionProgress));
      if (randomizingSwap) {
        musicFade = 0.42 * transitionProgress * transitionProgress;
      }
      if (transitionProgress >= 1) {
        rigScale = 1;
        if (desiredBuildKey() !== builtKey) {
          // Settings changed while the shape grew: rebuild with the walls already down.
          stageStartWall = 0;
          transitionPhase = "walls-down";
          transitionProgress = 1;
        } else {
          wallMesh.visible = true;
          dropPlayedInRise = false;
          transitionPhase = "walls-up";
          transitionProgress = 0;
          sound.wallWave({ rising: true, duration: 0.44 });
        }
      }
    }
  } else if (transitionPhase === "walls-up") {
    if (rebuildWanted) {
      sound.silenceLoops();
      activeTransitionShrink = fullSwapWanted;
      stageStartWall = Math.max(0.02, wallRaise);
      stageStartMusicFade = musicFade;
      transitionPhase = "walls-down";
      transitionProgress = 0;
      sound.wallWave({ rising: false, duration: 0.28 });
    } else {
      wallMesh.visible = true;
      transitionProgress = Math.min(1, transitionProgress + dt / 0.44);
      wallRaise = 1 - Math.pow(1 - transitionProgress, 2.4);
      marbleReveal = Math.max(0, Math.min(1, (transitionProgress - 0.3) / 0.6));
      if (randomizingSwap) {
        const ease = 1 - Math.pow(1 - transitionProgress, 2.0);
        musicFade = 0.42 + 0.58 * ease;
      }
      marbleMesh.visible = marbleReveal > 0.02;
      if (!dropPlayedInRise && transitionProgress >= 0.36) {
        dropPlayedInRise = true;
        sound.drop({ pan: 0, rate: 1.0 });
      }
      if (transitionProgress >= 1) {
        wallRaise = 1;
        marbleReveal = 1;
        musicFade = 1;
        randomizingSwap = false;
        marbleMesh.visible = true;
        transitionPhase = "idle";
      }
    }
  }

  sound.setMusicVolume(params.music());
  sound.setMusicFade(musicFade);
  shared.uWallRaise.value = wallRaise;
  rigGroup.scale.setScalar(Math.max(0.0001, rigScale));
  rigGroup.visible = transitionPhase !== "shape-hidden" && rigScale > 0.003;
}

// ---------------------------------------------------------------------------
// Step Shape Rotation (Drag, Keyboard, Coasting & Idle Auto-Tilt)
// ---------------------------------------------------------------------------
const camRight = new Vector3();
const camUp = new Vector3();
const camFwd = new Vector3();
const targetOmega = new Vector3();
const rotStepQuat = new Quaternion();
const autoQuat = new Quaternion();
const autoErrQuat = new Quaternion();
const rotAxis = new Vector3();
const omegaStep = new Vector3();

// How hard each solver turns the piece toward its target: gain (1/s), top speed (rad/s), and either a response rate
// (1/s) or an acceleration cap (rad/s²) so speed always changes gradually.
const SOLVER_GAINS = {
  steady: { gain: 5, max: 1.2, accel: 2 },
  original: { gain: 2.25, max: 2.45, rate: 6.2 },
  optimal: { gain: 10, max: 8, rate: 20 },
};

function autoSteeringActive() {
  return params.autoPlay() && transitionPhase === "idle" && !marble.captured && !dragState.active && heldKeys.size === 0 && dragState.idleTime > 2.0;
}

function updateRotation(dt, elapsed) {
  if (dt <= 0 || !currentLabyrinth) return;

  camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  camFwd.setFromMatrixColumn(camera.matrixWorld, 2).normalize();

  const keyRight = (heldKeys.has("KeyD") || heldKeys.has("ArrowRight") ? 1 : 0) -
    (heldKeys.has("KeyA") || heldKeys.has("ArrowLeft") ? 1 : 0);
  const keyDown = (heldKeys.has("KeyS") || heldKeys.has("ArrowDown") ? 1 : 0) -
    (heldKeys.has("KeyW") || heldKeys.has("ArrowUp") ? 1 : 0);

  let autoSteering = false;
  if (dragState.active) {
    const gain = 5.2 / Math.max(320, Math.min(window.innerWidth, window.innerHeight));
    targetOmega
      .copy(camUp)
      .multiplyScalar((dragState.deltaX * gain) / dt)
      .addScaledVector(camRight, (dragState.deltaY * gain) / dt);
    if (targetOmega.length() > 8.5) targetOmega.setLength(8.5);
    angularVel.lerp(targetOmega, 1 - Math.exp(-dt * 28));
    dragState.deltaX = 0;
    dragState.deltaY = 0;
    dragState.idleTime = 0;
  } else if (keyRight !== 0 || keyDown !== 0) {
    const keySpeed = 1.95;
    targetOmega
      .copy(camRight)
      .multiplyScalar(keyDown * keySpeed)
      .addScaledVector(camUp, keyRight * keySpeed * 0.75)
      .addScaledVector(camFwd, -keyRight * keySpeed * 0.55);
    angularVel.lerp(targetOmega, 1 - Math.exp(-dt * 12));
    dragState.idleTime = 0;
  } else {
    dragState.idleTime += dt;
    autoSteering = params.autoPlay() && transitionPhase === "idle" && !marble.captured && dragState.idleTime > 2.0;
    const original = params.solver() === "original";
    const gains = SOLVER_GAINS[params.solver()] ?? SOLVER_GAINS.original;
    // Coasting damps the spin; the newer solvers ease toward their own target instead.
    if (!autoSteering || original) angularVel.multiplyScalar(Math.exp(-dt * 5.2));

    if (autoSteering) {
      const blendIn = Math.min(1, (dragState.idleTime - 2.0) / 1.4);
      const autoRefCamPos = params.cameraMode() === "follow" ? followAutoAnchor : camera.position;
      if (original) computeAutoTiltQuatOriginal(marble, currentLabyrinth, autoRefCamPos, autoQuat, dt);
      else computeAutoTiltQuat(marble, currentLabyrinth, autoRefCamPos, autoQuat, dt, shapeQuat, AUTO_PROFILES[params.solver()]);
      autoErrQuat.copy(shapeQuat).invert().premultiply(autoQuat);
      if (autoErrQuat.w < 0) {
        autoErrQuat.x = -autoErrQuat.x;
        autoErrQuat.y = -autoErrQuat.y;
        autoErrQuat.z = -autoErrQuat.z;
        autoErrQuat.w = -autoErrQuat.w;
      }
      const sinHalf = Math.hypot(autoErrQuat.x, autoErrQuat.y, autoErrQuat.z);
      if (sinHalf > 1e-5) {
        const errAngle = 2 * Math.atan2(sinHalf, autoErrQuat.w);
        targetOmega
          .set(autoErrQuat.x / sinHalf, autoErrQuat.y / sinHalf, autoErrQuat.z / sinHalf)
          .multiplyScalar(Math.min(gains.max, errAngle * gains.gain) * blendIn);
        if (gains.accel) {
          omegaStep.subVectors(targetOmega, angularVel);
          if (omegaStep.length() > gains.accel * dt) omegaStep.setLength(gains.accel * dt);
          angularVel.add(omegaStep);
        } else {
          angularVel.lerp(targetOmega, 1 - Math.exp(-dt * gains.rate));
        }
      }
    }
  }

  const speed = angularVel.length();
  if (speed > 3.5 && !autoSteering && elapsed - lastSwooshAt > 0.32) {
    if (sound.swoosh({ spinSpeed: speed })) lastSwooshAt = elapsed;
  }
  if (speed > 1e-6) {
    rotAxis.copy(angularVel).divideScalar(speed);
    rotStepQuat.setFromAxisAngle(rotAxis, speed * dt);
    shapeQuat.premultiply(rotStepQuat).normalize();
  }
  rigGroup.quaternion.copy(shapeQuat);
}

// ---------------------------------------------------------------------------
// Initial Load & Main Render Loop
// ---------------------------------------------------------------------------
onRandomize((seedVal) => {
  if (!booted || applyingAtBottom) {
    // Initial URL ?seed= replay on startup, or deferred seed application while shrunk to 0.
    puzzleSerial = 0;
    gui.randomizeAll();
    return;
  }
  // Live randomize (R, button, or autoChange): keep old values until walls sink & shape shrinks to 0!
  pendingRandomSeed = seedVal;
  pendingFullSwap = true;
  randomizingSwap = true;
});

applyUrlState();
await load.build.track(
  new Promise((resolve) => {
    builder.onReady = resolve;
    requestBuild();
  }),
);
builder.onReady = null;
installLabyrinth(takeBuild(), true);
await noiseBaked;
shownFinishName = params.finish();
updateFinishLook(1, true);
booted = true;

await studioPromise;
await load.sound.track(sound.loaded);
await load.compile.track(pipeline.compileAsync(scene, camera), 3);

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  sound,
  rigGroup,
  floorMesh,
  wallMesh,
  marbleMesh,
  marble,
  get labyrinth() {
    return currentLabyrinth;
  },
  get transitionPhase() {
    return transitionPhase;
  },
  get wallRaise() {
    return wallRaise;
  },
  get rigScale() {
    return rigScale;
  },
  get marbleReveal() {
    return marbleReveal;
  },
  get musicFade() {
    return musicFade;
  },
  get shownShape() {
    return shownShape;
  },
  get shownFinishName() {
    return shownFinishName;
  },
};

const worldBallPos = new Vector3();
const worldBallNormal = new Vector3();
const worldBallVel = new Vector3();
const screenProj = new Vector3();
const viewToBall = new Vector3();
const prevRigMatrix = new Matrix4();
const prevCamMatrix = new Matrix4();

// Smooth Critically-Damped Car Chase Camera: perches behind and above the ball along its corridor heading,
// hovering at a steady normal height above the surface and swinging gracefully around corners without bounce-whip!
const smoothSurfNormal = new Vector3(0, 1, 0);
const worldChaseDir = new Vector3(0, 0, -1);
const smoothWorldChase = new Vector3(0, 0, -1);
const chaseTargetDir = new Vector3();
const chaseSideDir = new Vector3();
const velDirVec = new Vector3();
const followCamPos = new Vector3(0, 1.75, 4.15);
const followCamPosVel = new Vector3();
const followCamTarget = new Vector3(0, 0, 0);
const followCamTargetVel = new Vector3();
const smoothCamOffset = new Vector3(0, 0.65, 0.35);
const smoothCamOffsetVel = new Vector3();
const smoothTargetOffset = new Vector3(0, -0.1, -0.28);
const smoothTargetOffsetVel = new Vector3();
const smoothCamUp = new Vector3(0, 1, 0);
const smoothCamUpVel = new Vector3();
const orbitReturnPos = new Vector3(0, 1.75, 4.15);
const orbitZeroTarget = new Vector3(0, 0, 0);
const desiredCamOffset = new Vector3();
const desiredTargetOffset = new Vector3();
const desiredCamUp = new Vector3();
const rawDesiredPos = new Vector3();
const hoverNormal = new Vector3();
const overviewPos = new Vector3();
const invShapeQuat = new Quaternion();
const localProbe = new Vector3();
const worldUpConst = new Vector3(0, 1, 0);
let cameraState = "orbit"; // "orbit" | "follow" | "returning"
const viewKeeper = createViewKeeper();
let lastOrbitInput = -Infinity;
controls.addEventListener("start", () => (lastOrbitInput = performance.now()));
controls.addEventListener("end", () => (lastOrbitInput = performance.now()));
let smoothFollowHeight = params.followHeight();
let smoothFollowHeightVel = 0;
let smoothOcclusionScale = 1;
let smoothOverviewMix = 0;
let chaseBootedSnap = true;

// Exact closed-form critically-damped 2nd-order spring (zero overshoot, C2-continuous across sudden target changes).
function dampSpringVec3(pos, vel, target, omega, dt) {
  const exp = Math.exp(-omega * dt);
  const dx = pos.x - target.x;
  const dy = pos.y - target.y;
  const dz = pos.z - target.z;
  const tx = (vel.x + omega * dx) * dt;
  const ty = (vel.y + omega * dy) * dt;
  const tz = (vel.z + omega * dz) * dt;
  vel.x = (vel.x - omega * tx) * exp;
  vel.y = (vel.y - omega * ty) * exp;
  vel.z = (vel.z - omega * tz) * exp;
  pos.x = target.x + (dx + tx) * exp;
  pos.y = target.y + (dy + ty) * exp;
  pos.z = target.z + (dz + tz) * exp;
}

function updateCameraMode(wallDt) {
  const wantFollow = params.cameraMode() === "follow";

  // Smoothly damp Follow height changes on wall-clock dt so slider & scroll edits glide even while paused!
  {
    const targetH = params.followHeight();
    const hOmega = 6.5;
    const hExp = Math.exp(-hOmega * wallDt);
    const dh = smoothFollowHeight - targetH;
    const th = (smoothFollowHeightVel + hOmega * dh) * wallDt;
    smoothFollowHeightVel = (smoothFollowHeightVel - hOmega * th) * hExp;
    smoothFollowHeight = targetH + (dh + th) * hExp;
  }

  if (!wantFollow) {
    chaseBootedSnap = false;
    // While auto tilt drives, glide the orbit camera to a view of the marble whenever the piece hides it.
    const keepView =
      cameraState === "orbit" &&
      params.solver() === "steady" &&
      autoSteeringActive() &&
      performance.now() - lastOrbitInput > 3000 &&
      currentLabyrinth;
    if (keepView) viewKeeper.update(isRunning() ? wallDt : 0, currentLabyrinth, shapeQuat, marble, camera.position);
    else viewKeeper.reset();
    if (cameraState === "follow") {
      cameraState = "returning";
      followCamPos.copy(worldBallPos).add(smoothCamOffset);
      followCamPosVel.copy(smoothCamOffsetVel);
      followCamTarget.copy(worldBallPos).add(smoothTargetOffset);
      followCamTargetVel.copy(smoothTargetOffsetVel);
      orbitReturnPos.copy(camera.position);
      if (orbitReturnPos.lengthSq() < 1e-4) orbitReturnPos.set(0, 1.75, 4.15);
      if (orbitReturnPos.y < 0.35) orbitReturnPos.y = 0.85;
      orbitReturnPos.setLength(orbitDefaultDist);
    }
    if (cameraState === "returning") {
      dampSpringVec3(followCamPos, followCamPosVel, orbitReturnPos, 2.2, wallDt);
      dampSpringVec3(followCamTarget, followCamTargetVel, orbitZeroTarget, 2.6, wallDt);
      dampSpringVec3(smoothCamUp, smoothCamUpVel, worldUpConst, 2.4, wallDt);
      if (smoothCamUp.lengthSq() > 1e-6) smoothCamUp.normalize();
      camera.position.copy(followCamPos);
      camera.up.copy(smoothCamUp);
      camera.lookAt(followCamTarget);
      camera.updateMatrixWorld();
      if (
        followCamPos.distanceToSquared(orbitReturnPos) < 0.0004 &&
        followCamTarget.lengthSq() < 0.0002 &&
        smoothCamUp.distanceToSquared(worldUpConst) < 0.0002
      ) {
        cameraState = "orbit";
        camera.up.set(0, 1, 0);
        controls.target.set(0, 0, 0);
        camera.position.copy(orbitReturnPos);
        controls.enabled = true;
        controls.update();
      }
      return;
    }
    controls.update();
    return;
  }

  // Parallel-transport localChaseDir onto the ball's current tangent plane on the shape.
  localChaseDir.addScaledVector(marble.normal, -localChaseDir.dot(marble.normal));
  if (localChaseDir.lengthSq() < 1e-6) {
    resetChaseHeading();
  } else {
    localChaseDir.normalize();
  }

  // Filter rolling velocity in shape-local space (rejects brief wall-knock bounces) and steer heading like a car!
  if (transitionPhase === "idle") {
    smoothLocalVel.lerp(marble.vel, 1 - Math.exp(-wallDt * 5.5));
  } else {
    smoothLocalVel.set(0, 0, 0);
  }
  smoothLocalVel.addScaledVector(marble.normal, -smoothLocalVel.dot(marble.normal));
  const localSpeed = smoothLocalVel.length();
  const autoSteering =
    params.autoPlay() &&
    transitionPhase === "idle" &&
    !marble.captured &&
    !dragState.active &&
    heldKeys.size === 0 &&
    dragState.idleTime > 2.0;

  if (autoSteering) {
    reverseHoldTime = 0;
    chaseTargetDir.copy(marble.smoothAimDir);
    if (localSpeed > 0.08) {
      velDirVec.copy(smoothLocalVel).divideScalar(localSpeed);
      if (velDirVec.dot(marble.smoothAimDir) > -0.1) {
        chaseTargetDir.multiplyScalar(0.35).addScaledVector(velDirVec, 0.65);
      }
    }
    chaseTargetDir.addScaledVector(marble.normal, -chaseTargetDir.dot(marble.normal));
    if (chaseTargetDir.lengthSq() > 1e-6) {
      chaseTargetDir.normalize();
      localChaseDir.lerp(chaseTargetDir, 1 - Math.exp(-wallDt * 4.2));
      localChaseDir.addScaledVector(marble.normal, -localChaseDir.dot(marble.normal)).normalize();
    }
  } else if (localSpeed > 0.065) {
    velDirVec.copy(smoothLocalVel).divideScalar(localSpeed);
    const align = localChaseDir.dot(velDirVec);
    const speedWeight = Math.min(1, (localSpeed - 0.065) / 0.38);
    if (align >= -0.25) {
      reverseHoldTime = Math.max(0, reverseHoldTime - wallDt * 3.5);
      localChaseDir.lerp(velDirVec, 1 - Math.exp(-wallDt * 3.6 * speedWeight));
      localChaseDir.addScaledVector(marble.normal, -localChaseDir.dot(marble.normal)).normalize();
    } else {
      // Hold steady through brief wall bounces or braking; only swing around on sustained reverse driving!
      if (localSpeed > 0.14) reverseHoldTime += wallDt;
      if (reverseHoldTime >= 0.45) {
        chaseSideDir.crossVectors(marble.normal, localChaseDir);
        const sideSign = chaseSideDir.dot(velDirVec) >= 0 ? 1 : -1;
        chaseTargetDir.copy(velDirVec);
        if (align < -0.82) {
          chaseTargetDir.addScaledVector(chaseSideDir, sideSign * 0.65).normalize();
        }
        localChaseDir.lerp(chaseTargetDir, 1 - Math.exp(-wallDt * 2.6 * speedWeight));
        localChaseDir.addScaledVector(marble.normal, -localChaseDir.dot(marble.normal)).normalize();
      }
    }
  } else {
    reverseHoldTime = Math.max(0, reverseHoldTime - wallDt * 3.5);
  }

  worldChaseDir.copy(localChaseDir).applyQuaternion(shapeQuat);

  const snapOnEnter = chaseBootedSnap && cameraState !== "follow";
  if (cameraState !== "follow") {
    const fromOrbit = cameraState === "orbit";
    cameraState = "follow";
    controls.enabled = false;
    if (fromOrbit) {
      let hx = camera.position.x;
      let hz = camera.position.z;
      const hLen = Math.hypot(hx, hz);
      if (hLen < 0.2) {
        hx = 0;
        hz = 1;
      } else {
        hx /= hLen;
        hz /= hLen;
      }
      // Keep chase camera in the orbit camera's sunlit front hemisphere while auto-tilt rolls AWAY (-hx, -hz)!
      chaseAnchorPos.set(hx * 4.15, 1.75, hz * 4.15);
      followAutoAnchor.set(-hx * 4.15, 1.75, -hz * 4.15);

      smoothCamOffset.copy(camera.position).sub(worldBallPos);
      smoothCamOffsetVel.set(0, 0, 0);
      smoothTargetOffset.copy(controls.target).sub(worldBallPos);
      smoothTargetOffsetVel.set(0, 0, 0);
      smoothCamUp.copy(camera.up);
      smoothCamUpVel.set(0, 0, 0);
      smoothSurfNormal.copy(worldBallNormal);
      smoothOcclusionScale = 1;
    } else {
      // Switching back into follow while mid-return: preserve continuous position & velocity!
      smoothCamOffset.copy(followCamPos).sub(worldBallPos);
      smoothCamOffsetVel.copy(followCamPosVel);
      smoothTargetOffset.copy(followCamTarget).sub(worldBallPos);
      smoothTargetOffsetVel.copy(followCamTargetVel);
    }
  }

  // 1. Low-pass filter surface normal so polyhedron bevels feel seamless, and keep chase tangent orthogonal to it.
  smoothSurfNormal.lerp(worldBallNormal, 1 - Math.exp(-wallDt * 4.5));
  if (smoothSurfNormal.lengthSq() > 1e-6) smoothSurfNormal.normalize();
  else smoothSurfNormal.set(0, 1, 0);
  hoverNormal.copy(smoothSurfNormal);

  smoothWorldChase.copy(worldChaseDir).addScaledVector(hoverNormal, -hoverNormal.dot(worldChaseDir));
  if (smoothWorldChase.lengthSq() < 1e-6) {
    smoothWorldChase.set(0, 0, -1).addScaledVector(hoverNormal, hoverNormal.z);
  }
  smoothWorldChase.normalize();

  // 2. Car-style Chase Cam geometry: behind (-smoothWorldChase) and above (+hoverNormal) the ball,
  //    calibrated for our 35-deg FOV on unit-radius curved surfaces so the ball sits at ~74% screen Y
  //    with 40-55 deg of upcoming labyrinth passages filling the screen ahead!
  const rawAbove = smoothFollowHeight;
  const rawBehind = 0.08 + smoothFollowHeight * 0.42;
  rawDesiredPos
    .copy(worldBallPos)
    .addScaledVector(hoverNormal, rawAbove)
    .addScaledVector(smoothWorldChase, -rawBehind);

  // Duck smoothly under overhanging arches/holes on genus-1 shapes (torus, saddle ring, trefoil) so opposite rings never block the ball.
  let targetOccScale = 1;
  if (currentLabyrinth && currentLabyrinth.shape.genus === 1 && transitionPhase === "idle") {
    invShapeQuat.copy(shapeQuat).invert();
    const rBall = currentLabyrinth.marbleRadius;
    for (const frac of [0.32, 0.48, 0.64, 0.82, 1.0]) {
      localProbe.copy(worldBallPos).lerp(rawDesiredPos, frac).applyQuaternion(invShapeQuat);
      const expectedClear = rBall + frac * rawAbove;
      if (currentLabyrinth.shape.sdf(localProbe.x, localProbe.y, localProbe.z) < Math.min(0.075, expectedClear * 0.5)) {
        targetOccScale = Math.max(0.32, frac - 0.14);
        break;
      }
    }
  }
  const occRate = targetOccScale < smoothOcclusionScale ? 6.5 : 2.2;
  smoothOcclusionScale += (targetOccScale - smoothOcclusionScale) * (1 - Math.exp(-wallDt * occRate));

  const aboveHeight = rawAbove * smoothOcclusionScale;
  const behindDist = rawBehind * smoothOcclusionScale;
  const lookAheadDist = (0.18 + smoothFollowHeight * 0.16) * (0.55 + 0.45 * smoothOcclusionScale);
  const targetDrop = (0.04 + aboveHeight * 0.15) * (0.55 + 0.45 * smoothOcclusionScale);

  desiredCamOffset
    .copy(hoverNormal)
    .multiplyScalar(aboveHeight)
    .addScaledVector(smoothWorldChase, -behindDist);

  desiredTargetOffset
    .copy(smoothWorldChase)
    .multiplyScalar(lookAheadDist)
    .addScaledVector(hoverNormal, -targetDrop);

  // Smoothly pull back to stage overview during shape swaps.
  const rawOverview = transitionPhase === "idle" ? 0 : Math.min(1, (1 - wallRaise) * 0.85);
  smoothOverviewMix += (rawOverview - smoothOverviewMix) * (1 - Math.exp(-wallDt * 2.2));
  if (smoothOverviewMix > 0.001) {
    overviewPos.copy(chaseAnchorPos).setLength(orbitDefaultDist * 0.86).sub(worldBallPos);
    desiredCamOffset.lerp(overviewPos, smoothOverviewMix);
    overviewPos.copy(worldBallPos).multiplyScalar(-1);
    desiredTargetOffset.lerp(overviewPos, smoothOverviewMix);
  }

  if (snapOnEnter) {
    chaseBootedSnap = false;
    smoothCamOffset.copy(desiredCamOffset);
    smoothTargetOffset.copy(desiredTargetOffset);
  } else {
    // 3. Critically-damped 2nd-order springs in the ball's moving frame (zero distance lag at speed, plush cornering swing!).
    dampSpringVec3(smoothCamOffset, smoothCamOffsetVel, desiredCamOffset, 2.5, wallDt);
    dampSpringVec3(smoothTargetOffset, smoothTargetOffsetVel, desiredTargetOffset, 3.5, wallDt);
  }

  followCamPos.copy(worldBallPos).add(smoothCamOffset);
  followCamTarget.copy(worldBallPos).add(smoothTargetOffset);

  viewToBall.copy(followCamPos).sub(followCamTarget);
  if (viewToBall.lengthSq() < 1e-6) viewToBall.set(0, 0, 1);
  else viewToBall.normalize();

  // Align camera up with the local surface normal (blending to world up during shape-swap overview) so the floor is always level!
  desiredCamUp.copy(hoverNormal).lerp(worldUpConst, smoothOverviewMix);
  desiredCamUp.addScaledVector(viewToBall, -viewToBall.dot(desiredCamUp));
  if (desiredCamUp.lengthSq() < 1e-5) {
    desiredCamUp.copy(worldUpConst).addScaledVector(viewToBall, -viewToBall.y);
  }
  if (desiredCamUp.lengthSq() > 1e-6) desiredCamUp.normalize();
  else desiredCamUp.set(0, 1, 0);

  if (snapOnEnter) {
    smoothCamUp.copy(desiredCamUp);
  } else {
    dampSpringVec3(smoothCamUp, smoothCamUpVel, desiredCamUp, 2.2, wallDt);
    if (smoothCamUp.lengthSq() > 1e-6) smoothCamUp.normalize();
    else smoothCamUp.set(0, 1, 0);
  }

  camera.position.copy(followCamPos);
  camera.up.copy(smoothCamUp);
  camera.lookAt(followCamTarget);
  camera.updateMatrixWorld();
}

let lastWallNow = performance.now();

function onFrame({ time, dt, wallDtOverride }) {
  const now = performance.now();
  const wallDt = wallDtOverride ?? Math.min(0.1, Math.max(0.001, (now - lastWallNow) / 1000));
  lastWallNow = now;

  autoChange.update(dt);
  updateTransitions(wallDt);
  updateFinishLook(wallDt);

  if (resetMarbleRequested && currentLabyrinth && transitionPhase === "idle") {
    resetMarbleRequested = false;
    placeMarbleAtStart(marble, currentLabyrinth);
    resetChaseHeading();
    orientStartTowardCamera(false);
    sound.drop({ pan: 0 });
  }

  if (dt > 0) {
    updateRotation(dt, time);
  }

  const finishCfg = FINISHES[shownFinishName || params.finish()] ?? FINISHES["walnut & brass"];
  const wallsActive = transitionPhase === "idle";
  const stepInfo = stepMarble(marble, currentLabyrinth, shapeQuat, wallsActive ? dt : 0, {
    gravity: 6.4 * params.gravity(),
    materialKind: finishCfg.acoustic,
    wallsActive,
  });

  if (currentLabyrinth) {
    const rBall = currentLabyrinth.marbleRadius;
    const sinkOffset = (1 - marbleReveal) * rBall * 2.2;
    marbleMesh.position.copy(marble.pos).addScaledVector(marble.normal, -sinkOffset);
    marbleMesh.scale.setScalar(rBall * (0.35 + 0.65 * marbleReveal));
  } else {
    marbleMesh.position.copy(marble.pos);
  }
  marbleMesh.quaternion.copy(marble.spinQuat);
  shared.uMarbleLocalPos.value.copy(marbleMesh.position);
  shared.uMarbleRefRadius.value = marbleMesh.visible && rigGroup.visible ? marbleMesh.scale.x : 0;
  shared.uMarbleColorRef.value.copy(marbleMaterial.color);
  shared.uMarbleMetalRef.value = marbleMaterial.metalness;
  shared.uWallColor.value.copy(wallMaterial.color);
  shared.uWallMetal.value = wallMaterial.metalness;
  shared.uWallRough.value = wallMaterial.roughness;
  const reflectOn = floorReflections && params.floorReflect() ? 1 : 0;
  const refChanged =
    shared.uReflect.value !== reflectOn ||
    shared.uRefStrength.value !== params.reflections() ||
    shared.uRefReach.value !== params.reflectionReach() ||
    shared.uMirrorTest.value !== (params.mirrorTest() ? 1 : 0);
  shared.uMirrorTest.value = params.mirrorTest() ? 1 : 0;
  shared.uReflect.value = reflectOn;
  shared.uRefStrength.value = params.reflections();
  shared.uRefReach.value = params.reflectionReach();

  rigGroup.updateMatrixWorld();
  worldBallPos.copy(marble.pos).applyMatrix4(rigGroup.matrixWorld);
  worldBallNormal.copy(marble.normal).transformDirection(rigGroup.matrixWorld);

  updateCameraMode(wallDt);
  shared.uWorldToLocal.value.copy(floorMesh.matrixWorld).invert();

  // Compute stereo pan and camera-facing visibility for spatialized foley.
  viewToBall.copy(camera.position).sub(worldBallPos).normalize();
  const facing = Math.max(0, worldBallNormal.dot(viewToBall));
  screenProj.copy(worldBallPos).project(camera);
  const pan = Math.max(-0.85, Math.min(0.85, screenProj.x * 0.75));

  if (stepInfo.maxImpact > 0) {
    sound.hit(finishCfg.acoustic, {
      impactSpeed: stepInfo.maxImpact,
      pan,
      facing,
      isGoalRim: stepInfo.impactGoalRim,
    });
  }

  if (currentLabyrinth && wallsActive && dt > 0) {
    const d = currentLabyrinth.distToGoal[marble.currentCellId];
    if (d < solveBest) {
      solveBest = d;
      solveStuck = 0;
    } else {
      solveStuck += dt;
    }
  }

  if (stepInfo.justCaptured) {
    goalPulse = 1.0;
    sound.win({ pan });
    autoChange.restart?.();
  }

  if (marble.captured && transitionPhase === "idle") {
    goalPulse = Math.max(0, 1 - marble.captureTime * 0.9);
    if (marble.captureTime > 1.05) {
      goalPulse = 0;
      if (params.auto() && dragState.idleTime > 2) randomize();
      else puzzleSerial++;
    }
  } else {
    goalPulse *= Math.exp(-wallDt * 5);
  }
  shared.uGoalPulse.value = goalPulse;

  sound.updateRolling({
    materialKind: finishCfg.acoustic,
    speed: wallsActive && !marble.captured ? marble.vel.length() : 0,
    scrapeSpeed: wallsActive && !marble.captured ? stepInfo.scrapeSpeed : 0,
    pan,
    facing,
    active: dt > 0 && wallsActive && !marble.captured,
  });

  // Restart accumulation whenever the labyrinth, camera, or marble moves so still frames supersample cleanly when paused.
  const rigMoved = !rigGroup.matrixWorld.equals(prevRigMatrix);
  const camMoved = !camera.matrixWorld.equals(prevCamMatrix);
  prevRigMatrix.copy(rigGroup.matrixWorld);
  prevCamMatrix.copy(camera.matrixWorld);
  if (
    rigMoved ||
    camMoved ||
    transitionPhase !== "idle" ||
    lookSettling ||
    refChanged ||
    (dt > 0 && (marble.vel.lengthSq() > 1e-7 || goalPulse > 0.01))
  ) {
    pipeline.restartAccumulation(false);
  }

  pipeline.render(scene, camera, time);
}

window.app.step = onFrame;
render(onFrame);
