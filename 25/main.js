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
import { GUI, signal } from "guspira";
import { Scene, Group, Vector3, Matrix4, Euler, Quaternion, MathUtils } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { nativeRandom } from "modules/random.js";
import { SKULLS, loadSkull, poseJaw, setEmbers } from "./skull.js";
import { Veil, VeilComposite, loadFields } from "./veil.js";
import { createTracker } from "./tracker.js";
import { createSound } from "./sound.js";

const BACKGROUND = 0x060607;
const capture = new URLSearchParams(location.search).has("capture");

const defaults = {
  skull: "evil",
  followFace: true,
  frownThreshold: 0.4,
  glow: 1,
  veil: true,
  veilColor: "#dedede",
  veilOpacity: 0.2,
  diffusion: 0.2,
  tattered: false,
  tatterSeed: 0,
  draft: 5,
  auto: true,
  autoTime: 15,
};
const params = fromDefaults(defaults);

const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  skull: loadingStep(3, "Digging up a skull…"),
  fields: loadingStep(1),
  sound: loadingStep(1),
  compile: loadingStep(4, "Compiling shaders…"),
};

const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1.1,
  bloomStrength: 0.06,
  bloomRadius: 0.7,
  vignette: 0.32,
  grain: 0.03,
  shadow: { autoFit: true, denoise: true },
  composite: (hdr, info) => composite.render(hdr, info),
});
const composite = new VeilComposite(renderer, { samples: pipeline.msaa });
// The veil's shadow is a checkerboard; a wide enough filter averages it into half the light.
globalUniforms.shadowMinTexels.value = 2.5;

const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(0.5, 1, 1),
    keyIntensity: 7,
    keySize: 0.35,
    fill: 0.12,
    floor: 0.08,
    wall: 0.06,
  }),
);

// Face tracking: the camera is asked for on load; with no camera, no permission or no face, the skull is posed by
// itself (idle).
const tracker = createTracker();
const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.setPaused(!running));
showSoundHint(() => !sound.running);

const cameraButton = addActionButton("../assets/camera.svg", "Follow my face", () => params.followFace.set(!params.followFace()));
function syncCamera() {
  const on = params.followFace() && !capture;
  if (on) tracker.start();
  else if (tracker.state.status !== "idle") tracker.stop();
  cameraButton.querySelector("img").src = `../assets/${on ? "camera" : "camera-off"}.svg`;
  cameraButton.title = on ? "Stop following my face" : "Follow my face";
}

const cameraStatus = signal("");
const frownScore = signal(0);
const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: true });
gui.addSelect("Skull", params.skull, Object.entries(SKULLS).map(([k, v]) => [k, v.label]), { randomizable: false });
gui.addCheckbox("Follow my face", params.followFace, { randomizable: false });
gui.addMonitor("Camera", cameraStatus);
const trackingStats = signal("");
gui.addMonitor("Tracking", trackingStats);
gui.addGraph("Frown", frownScore, { min: 0, max: 1, format: (v) => v.toFixed(2) });
gui.addSlider("Frown threshold", params.frownThreshold, 0.1, 0.9, 0.01, { randomizable: false, title: "How hard to frown before the eyes light up" });
gui.addSlider("Glow", params.glow, 0, 3, 0.05, { randomizable: false });
gui.addSeparator();
gui.addCheckbox("Veil", params.veil, { randomizable: false });
gui.addColor("Veil color", params.veilColor);
gui.addSlider("Veil opacity", params.veilOpacity, 0, 0.95, 0.01);
gui.addSlider("Veil diffusion", params.diffusion, 0, 1, 0.01, { title: "How much the veil blurs the skull behind it" });
gui.addCheckbox("Tattered", params.tattered);
gui.addSlider("Tatters", params.tatterSeed, 0, 15, 1, { title: "Which set of tatters" });
gui.addSlider("Draft", params.draft, 0, 12, 0.5, { title: "A draft blowing the veil back onto the face, in m/s²" });
gui.addButton("Drop the veil again", () => dropVeil());
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => swap.state === "idle" });
pipeline.addGUI(gui);
gui.addSeparator();
addKey("KeyD", "drop the veil again", () => dropVeil());
addKey("KeyC", "camera on/off", () => params.followFace.set(!params.followFace()));
addKey("KeyM", "sound on/off", toggleSound);
gui.addText(keysHelp());
showHint(
  "Look at the camera · open your mouth · frown · drag to orbit · R for a new veil",
  "Look at the camera · open your mouth · frown · tap {randomize} for a new veil",
);

// World units are decimetres. The head is posed in MediaPipe's metric space (centimetres, the camera at the origin);
// the skulls are modelled in metres, resting on y = 0 and facing +z, with their sockets on the canonical eyes.
const scene = new Scene();
const head = new Group();
head.matrixAutoUpdate = false;
scene.add(head);
const SKULL_SCALE = 100;
const SKULL_OFFSET = new Vector3(0, -8.9, -4.1);
const CM = 0.1;
// Where a face sits from the camera, in cm, and how much of its moving about the skull follows.
const NEUTRAL = new Vector3(0, 0, -50);
const FOLLOW = 0.5;
const TARGET = new Vector3(0, -0.55, -0.4);

const skulls = {};
const fieldsCache = {};
function fieldsFor(name) {
  fieldsCache[name] ??= loadFields(new URL(SKULLS[name].fields, document.baseURI).href);
  return fieldsCache[name];
}

async function prepareSkull(name, onProgress) {
  skulls[name] ??= (async () => {
    const skull = await loadSkull(name, { onProgress });
    skull.root.scale.setScalar(SKULL_SCALE);
    skull.root.position.copy(SKULL_OFFSET);
    skull.root.visible = false;
    skull.veil = new Veil(SKULLS[name].fields, { offset: SKULLS[name].veilOffset, ember: skull.ember, composite, fields: fieldsFor(name) });
    skull.root.add(skull.veil.mesh);
    skull.lastMatrix = new Matrix4();
    skull.hasLastMatrix = false;
    head.add(skull.root);
    skulls[name].ready = skull;
    return skull;
  })();
  return skulls[name];
}

// --- Veil looks. What's shown changes only once the old veil has dissolved: R, the panel and auto change set the
// params, the old veil fades out in its own look, and the new one drops and fades in.
const shown = { color: defaults.veilColor, opacity: defaults.veilOpacity, diffusion: defaults.diffusion, tattered: false, tatterSeed: 0 };
const swap = { state: "idle", fade: 0 };
const FADE_OUT = 0.6;
const FADE_IN = 1.1;
function lookKey() {
  return `${params.tattered()}|${params.tatterSeed()}`;
}
let appliedKey = null;
function dropVeil() {
  if (swap.state === "idle") swap.state = "out";
  swap.redrop = true;
}
onRandomize(() => gui.randomizeAll());
onRandomize(() => {
  if (started) dropVeil();
});

function updateSwap(dt, skull) {
  const veil = skull?.veil;
  if (swap.state === "idle") {
    // Colour, opacity and diffusion follow the panel live; a new cut of cloth needs a new drop.
    shown.color = params.veilColor();
    shown.opacity = params.veilOpacity();
    shown.diffusion = params.diffusion();
    if (veil && lookKey() !== appliedKey) swap.state = "out";
  }
  if (swap.state === "out") {
    swap.fade = Math.max(0, swap.fade - dt / FADE_OUT);
    if (swap.fade === 0 && veil) {
      shown.color = params.veilColor();
      shown.opacity = params.veilOpacity();
      shown.diffusion = params.diffusion();
      appliedKey = lookKey();
      veil.setTattered(params.tattered(), params.tatterSeed());
      swap.redrop = false;
      swap.state = "wait";
      sound.drop();
    }
  }
  if (swap.state === "wait" && veil?.settled) swap.state = "in";
  if (swap.state === "in") {
    swap.fade = Math.min(1, swap.fade + dt / FADE_IN);
    if (swap.fade === 1) {
      swap.state = "idle";
      autoChange.restart();
    }
  }
}

// --- Idle: the skull looks about by itself, chatters now and then and scowls. Smooth value noise of time.
function noise1(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n) => {
    const x = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}
const idle = {
  yaw: 0,
  yawSpeed: 0,
  yawTarget: 0,
  nextLook: 3,
  euler: new Euler(0, 0, 0, "YXZ"),
  pose: new Matrix4(),
  shapes: {},
};
function updateIdle(t, dt) {
  // Every few seconds it turns to look somewhere else, on a critically damped spring, so the cloth swings.
  if (t > idle.nextLook) {
    idle.yawTarget = (nativeRandom() * 2 - 1) * 0.55;
    idle.nextLook = t + 4 + nativeRandom() * 5;
  }
  const k = 9;
  idle.yawSpeed += (k * k * (idle.yawTarget - idle.yaw) - 2 * k * idle.yawSpeed) * dt;
  idle.yaw += idle.yawSpeed * dt;
  idle.euler.set(
    0.16 * noise1(t * 0.21, 1) - 0.04,
    idle.yaw + 0.15 * noise1(t * 0.17, 2),
    0.1 * noise1(t * 0.13, 3),
  );
  idle.pose.makeRotationFromEuler(idle.euler).setPosition(2 * noise1(t * 0.11, 4), 1.2 * noise1(t * 0.09, 5) + NEUTRAL.y, NEUTRAL.z + 3 * noise1(t * 0.07, 6));
  // Chatter in bursts, an occasional slow gape, and a scowl that comes and goes.
  const chatter = Math.max(0, noise1(t * 0.23, 7) - 0.35) * 2.2;
  const gape = Math.max(0, noise1(t * 0.09, 8) - 0.45) * 2.4;
  const s = idle.shapes;
  s.jawOpen = MathUtils.clamp(chatter * (0.5 + 0.5 * Math.sin(t * 17)) * 0.5 + gape * 0.8, 0, 1);
  s.jawLeft = Math.max(0, 0.25 * noise1(t * 0.3, 9));
  s.jawRight = Math.max(0, -0.25 * noise1(t * 0.3, 9));
  const scowl = MathUtils.smoothstep(noise1(t * 0.12, 10), 0.05, 0.35);
  s.browDownLeft = s.browDownRight = scowl;
  return idle.pose;
}

// --- Presence: when the face is lost the head drifts off into the dark, turning as it goes, and comes back the same way
// (to the idle pose, or to the face when it's found again). 1 is fully here.
const RECEDE = 75; // cm further away when gone
const RECEDE_TIME = 2.2;
const RETURN_TIME = 2;
const TUMBLE = new Vector3(0.5, 1.8, 0.7);
const SWAY = 0.25;
const DRIFT = new Vector3(5, 3, 0);
const DRAW_IN = 0.75;
const DRAW_IN_PULL = 0.7;
const TURN_CENTER = new Vector3(0, 0, -5);
// How long a blend from the idle pose to a newly found face takes.
const BLEND_TIME = 1.2;

const state = {
  mode: "idle", // idle | face
  presence: 1,
  blend: 0,
  facePose: new Matrix4(),
  blendFrom: new Matrix4(),
  arriving: true,
  shapes: {},
};
let current = null;
let currentName = null;

const pose = new Matrix4();
const tumble = new Matrix4();
const tumbleAngles = new Euler(0, 0, 0, "YXZ");
const inverse = new Matrix4();
const motion = new Matrix4();
const jawInverse = new Matrix4();
const tmp = new Vector3();
const down = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _q0 = new Quaternion();
const _q1 = new Quaternion();
const _s = new Vector3();
const world = new Matrix4().makeScale(CM, CM, CM);

function blendPoses(a, b, t, out) {
  a.decompose(_p0, _q0, _s);
  b.decompose(_p1, _q1, _s);
  return out.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s.set(1, 1, 1));
}

// Smoothed expression: the jaw eases (blendshapes aren't filtered) and the glow follows the frown.
const face = { jawOpen: 0, jawSide: 0, jawForward: 0, glow: 0, lastOpen: 0 };
const JAW_OPEN = 0.6;
const MAX_JAW_OPEN = 0.45;
const JAW_SIDE_GAIN = 2.5;
function updateExpression(skull, shapes, dt, mirrored) {
  const open = shapes.jawOpen || 0;
  // +x is the person's left; mirroring the pose flips the skull's own x, so the side flips with it.
  let side = MathUtils.clamp(JAW_SIDE_GAIN * ((shapes.jawLeft || 0) - (shapes.jawRight || 0)), -1, 1);
  if (mirrored) side = -side;
  const brows = ((shapes.browDownLeft || 0) + (shapes.browDownRight || 0)) / 2;
  const mouth = ((shapes.mouthFrownLeft || 0) + (shapes.mouthFrownRight || 0)) / 2;
  const frown = Math.max(brows, mouth);
  frownScore.set(frown);
  const fast = 1 - Math.exp(-dt * 20);
  face.jawOpen += (Math.min(MAX_JAW_OPEN, open * JAW_OPEN) - face.jawOpen) * fast;
  face.jawSide += (side - face.jawSide) * fast;
  face.jawForward += ((shapes.jawForward || 0) - face.jawForward) * fast;
  poseJaw(skull, face.jawOpen, face.jawSide, face.jawForward);
  // The teeth meet: a clack when the jaw shuts quickly.
  const closing = (face.lastOpen - face.jawOpen) / Math.max(dt, 1e-3);
  if (face.jawOpen < 0.03 && face.lastOpen >= 0.03 && closing > 0.4) sound.clack(Math.min(1, closing / 3));
  face.lastOpen = face.jawOpen;
  const threshold = params.frownThreshold();
  const target = MathUtils.smoothstep(frown, threshold - 0.08, threshold + 0.08);
  face.glow += (target - face.glow) * (1 - Math.exp(-dt * 8));
}

function updateVeil(skull, dt) {
  const { veil, root } = skull;
  const m = root.matrixWorld;
  inverse.copy(m).invert();
  down.set(0, -1, 0).transformDirection(inverse);
  let delta = null;
  if (skull.hasLastMatrix) {
    // While the head floats off or back, the veil is carried along and only feels the turning.
    if (state.presence < 1) inverse.copy(m).setPosition(tmp.setFromMatrixPosition(skull.lastMatrix)).invert();
    delta = motion.multiplyMatrices(inverse, skull.lastMatrix);
    // Fast turns rustle the cloth.
    const angle = 2 * Math.acos(MathUtils.clamp(_q0.setFromRotationMatrix(delta).w, -1, 1));
    sound.rustle(angle / Math.max(dt, 1e-3));
  }
  skull.lastMatrix.copy(m);
  skull.hasLastMatrix = true;
  jawInverse.copy(skull.jawMatrix).invert();
  veil.draft = params.draft();
  const p = state.presence;
  veil.loose = state.arriving && p > DRAW_IN ? -DRAW_IN_PULL * Math.sin((Math.PI * (p - DRAW_IN)) / (1 - DRAW_IN)) : MathUtils.smootherstep(1 - p / DRAW_IN, 0, 1);
  veil.update(dt, down, skull.jawMatrix, jawInverse, delta);
}

let started = false;
let elapsed = 0;

function frame(dt) {
  elapsed += dt;
  const found = tracker.update(dt) && params.followFace();
  const name = params.skull();
  if (!skulls[name]) prepareSkull(name);
  // A new skull: the old one drifts off first, and the new one comes back in its place.
  const leaving = current && name !== currentName;

  if (found) state.facePose.copy(tracker.state.pose);
  if (state.mode === "idle" && found && !leaving) {
    state.mode = "face";
    state.blend = state.presence > 0 ? 0 : 1;
    state.blendFrom.copy(pose);
  }
  const target = updateIdle(elapsed, dt);
  if (state.mode === "face") {
    state.blend = Math.min(1, state.blend + dt / BLEND_TIME);
    const b = MathUtils.smootherstep(state.blend, 0, 1);
    blendPoses(state.blendFrom, state.facePose, b, pose);
  } else {
    pose.copy(target);
  }

  const here = !leaving && (state.mode === "idle" || found);
  state.arriving = here;
  state.presence = MathUtils.clamp(state.presence + (here ? dt / RETURN_TIME : -dt / RECEDE_TIME), 0, 1);
  if (state.presence === 0) {
    // Gone: come back posed by itself (or as the new skull), until a face is found.
    if (state.mode === "face" && !found) {
      state.mode = "idle";
      if (current) current.hasLastMatrix = false;
    }
    if (leaving) {
      current.root.visible = false;
      current = null;
    }
  }
  if (!current && skulls[name]?.ready) {
    current = skulls[name].ready;
    currentName = name;
    current.root.visible = true;
    current.hasLastMatrix = false;
    // Its veil comes in with it, in the look the panel has now.
    appliedKey = null;
    swap.state = "out";
    swap.fade = 0;
  }
  const skull = current;
  if (!skull) return;

  const away = MathUtils.smootherstep(1 - state.presence, 0, 1);
  tmp.setFromMatrixPosition(pose).sub(NEUTRAL).multiplyScalar(FOLLOW);
  tmp.z -= RECEDE * away;
  tmp.x += DRIFT.x * Math.sin(state.presence * Math.PI) * away;
  tmp.y += DRIFT.y * Math.sin(state.presence * 5) * away;
  head.matrix.copy(pose).setPosition(tmp);
  tumbleAngles.set((TUMBLE.x + SWAY * Math.sin(state.presence * 6)) * away, TUMBLE.y * away, (TUMBLE.z + SWAY * Math.sin(state.presence * 4 + 1)) * away);
  tumble
    .makeRotationFromEuler(tumbleAngles)
    .setPosition(TURN_CENTER)
    .multiply(inverse.makeTranslation(-TURN_CENTER.x, -TURN_CENTER.y, -TURN_CENTER.z));
  head.matrix.multiply(tumble).premultiply(world);
  head.matrixWorldNeedsUpdate = true;

  const shapes = state.mode === "face" && found ? tracker.state.blendshapes : state.mode === "face" ? state.shapes : idle.shapes;
  if (state.mode === "face" && found) Object.assign(state.shapes, shapes);
  updateExpression(skull, shapes, dt, state.mode === "face" && tracker.state.mirrored);
  head.updateMatrixWorld(true);

  updateSwap(dt, skull);
  const veil = skull.veil;
  const veiled = params.veil();
  veil.setLook({ color: shown.color, opacity: shown.opacity, fade: swap.fade });
  composite.diffusion = shown.diffusion;
  veil.setVisible(veiled);
  if (veiled) updateVeil(skull, dt);
  else skull.hasLastMatrix = false;
  // Far off, the head is lost in the dark.
  const lit = MathUtils.smoothstep(state.presence, 0, 0.5);
  globalUniforms.lightColor.value.copy(baseLight).multiplyScalar(lit);
  globalUniforms.envIntensity.value = baseEnv * lit;
  setEmbers(skull, face.glow * params.glow() * lit, elapsed, 1);
  sound.ember(face.glow * params.glow() * lit);
}

function describeCamera() {
  const s = tracker.state;
  if (capture) return "off (capture)";
  if (!params.followFace()) return "off";
  if (s.status === "asking") return "asking for the camera…";
  if (s.status === "loading") return "loading the face tracker…";
  if (s.status === "denied") return "no permission";
  if (s.status === "failed") return "unavailable";
  if (s.status === "running") return s.found ? "following your face" : "looking for a face…";
  return "";
}

// Far enough back for the veiled skull to fit either way round; a resize keeps the direction it's seen from.
const viewDirection = new Vector3(0, 0.04, 1).normalize();
function frameCamera(w, h) {
  const t = Math.tan(MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(2.7 / t, 2.1 / (t * (w / h)));
  if (camera.position.lengthSq() > 0 && controls.target.equals(TARGET)) viewDirection.subVectors(camera.position, TARGET).normalize();
  camera.position.copy(TARGET).addScaledVector(viewDirection, dist);
  controls.target.copy(TARGET);
  controls.update();
}

camera.fov = 30;
camera.near = 0.5;
camera.far = 60;
camera.updateProjectionMatrix();
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 16;
onResize((w, h, dpr) => {
  pipeline.setSize(w, h, dpr);
  frameCamera(w, h);
});

applyUrlState();
syncCamera();

const first = load.skull.track(prepareSkull(params.skull(), load.skull.set));
await load.fields.track(fieldsFor(params.skull()));
await studio;
const firstSkull = await first;
firstSkull.root.visible = true;
const baseLight = globalUniforms.lightColor.value.clone();
const baseEnv = globalUniforms.envIntensity.value;
// Every program, the veil's near side included, before the first frame.
const compileScene = new Scene();
compileScene.add(firstSkull.veil.front.clone());
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), renderer.compileAsync(compileScene, camera)]), 4);
firstSkull.root.visible = false;

let lastFollow = params.followFace();
window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  tracker,
  preload: () => Promise.all(Object.keys(SKULLS).map((n) => prepareSkull(n))),
};

render(({ dt }) => {
  if (!started) {
    started = true;
    sound.start();
    // The other heads, in the background.
    for (const name of Object.keys(SKULLS)) prepareSkull(name);
  }
  if (params.followFace() !== lastFollow) {
    lastFollow = params.followFace();
    syncCamera();
  }
  autoChange.update(dt);
  if (dt > 0) frame(dt);
  const text = describeCamera();
  if (text !== cameraStatus.peek()) cameraStatus.set(text);
  if (tracker.state.stats !== trackingStats.peek()) trackingStats.set(tracker.state.stats);
  controls.update();
  pipeline.render(scene, camera, elapsed);
});
