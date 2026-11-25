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
import { Scene, Group, Vector3, Matrix4, Euler, Quaternion, MathUtils, Color } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { nativeRandom } from "modules/random.js";
import { SKULLS, EYE_LIGHTS, loadSkull, poseJaw, setEmbers } from "./skull.js";
import { Veil, VeilComposite, loadFields } from "./veil.js";
import { createTracker, takeLookAt } from "./tracker.js";
import { createSound } from "./sound.js";
import { createChooser } from "./chooser.js";

const BACKGROUND = 0x060607;
const capture = new URLSearchParams(location.search).has("capture");

const defaults = {
  skull: "evil",
  // How to play: camera (face tracking) or mouse (or touch). Chosen on the start screen.
  control: "mouse",
  frownThreshold: 0.4,
  glow: 1,
  eyes: "hellfire",
  veil: true,
  veilColor: "#b9b2a8",
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
// The veil's shadow is stochastic (a chance of blocking per texel per frame); a wide enough filter averages it.
globalUniforms.shadowMinTexels.value = 3.5;

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

// Wind gusts, drips and chains (see sound.js); how many samples of each are in sounds/.
const sound = createSound({ sets: { gust: 2, windbed: 1, drip: 6, chain: 2 }, onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.setPaused(!running));
showSoundHint(() => !sound.running);

const cameraButton = addActionButton("../assets/camera.svg", "How to play: camera or mouse (C)", () => chooser.open());
// ?replay=take.json plays a recorded take (Shift+T) instead of the camera: for videos.
const replayUrl = new URLSearchParams(location.search).get("replay");
const replayTake = replayUrl ? fetch(replayUrl).then((r) => r.json()) : null;
// Where in the take to start (seconds): the page opens on the look the take had then.
const replayStart = Number(new URLSearchParams(location.search).get("replayStart") ?? 0);

// The start screen: camera, or mouse (touch). Choosing the camera asks for it, and falls back to the mouse if it
// isn't allowed.
const touch = matchMedia("(pointer: coarse)").matches;
const chooser = createChooser({
  touch,
  async onChoose(mode) {
    params.control.set(mode);
    lastControl = mode;
    syncCamera();
    if (mode !== "camera") return { mode };
    await tracker.start();
    const status = tracker.state.status;
    if (status === "running" || status === "loading") return { mode };
    params.control.set("mouse");
    lastControl = "mouse";
    syncCamera();
    return { mode: "mouse", note: `The camera isn't available (${status === "denied" ? "no permission" : "not supported"}), so it's ${touch ? "touch" : "the mouse"} for now.` };
  },
});

function syncCamera() {
  if (replayUrl) return;
  const on = params.control() === "camera" && !capture;
  if (on) tracker.start();
  else if (tracker.state.status !== "idle") tracker.stop();
  cameraButton.querySelector("img").src = `../assets/${on ? "camera" : "camera-off"}.svg`;
  // The mouse turns the head, so it doesn't orbit the view.
  controls.enableRotate = params.control() !== "mouse";
}

const cameraStatus = signal("");
const frownScore = signal(0);
const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Skull", params.skull, Object.entries(SKULLS).map(([k, v]) => [k, v.label]), { randomizable: false });
gui.addSelect("Control", params.control, [["camera", "Camera"], ["mouse", "Mouse / touch"]], { randomizable: false });
gui.addMonitor("Camera", cameraStatus);
const trackingStats = signal("");
gui.addMonitor("Tracking", trackingStats);
const trackingNote = signal("");
gui.addMonitor("Take", trackingNote);
gui.addGraph("Frown", frownScore, { min: 0, max: 1, format: (v) => v.toFixed(2) });
gui.addSlider("Frown threshold", params.frownThreshold, 0.1, 0.9, 0.01, { randomizable: false, title: "How hard to frown before the eyes light up" });
gui.addSlider("Glow", params.glow, 0, 3, 0.05, { randomizable: false });
gui.addSelect("Eyes", params.eyes, Object.entries(EYE_LIGHTS).map(([k, v]) => [k, v.label]), { randomizable: false });
gui.addSeparator();
gui.addCheckbox("Veil", params.veil, { randomizable: false });
gui.addColor("Veil color", params.veilColor, { randomizable: false });
gui.addSlider("Veil opacity", params.veilOpacity, 0.05, 0.5, 0.01, { randomizable: false });
gui.addSlider("Veil diffusion", params.diffusion, 0, 0.5, 0.01, { randomizable: false, title: "How much the veil blurs the skull behind it" });
gui.addCheckbox("Tattered", params.tattered);
gui.addSlider("Tatters", params.tatterSeed, 0, 15, 1, { title: "Which set of tatters" });
gui.addSlider("Draft", params.draft, 0, 12, 0.5, { randomizable: false, title: "A draft blowing the veil back onto the face, in m/s²" });
gui.addButton("Drop the veil again", () => dropVeil());
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => swap.state === "idle" });
pipeline.addGUI(gui);
gui.addSeparator();
addKey("KeyD", "drop the veil again", () => dropVeil());
addKey("KeyC", "choose how to play: camera or mouse", () => chooser.open());
addKey("KeyM", "sound on/off", toggleSound);
// Shift+T records a take of your face (and Shift+T again downloads it), to replay with ?replay= for a video.
addKey("KeyT", "record a take of your face for a video, with Shift (again to download it)", () => {
  if (!tracker.recording) {
    tracker.startTake();
    tracker.addCue("look", { look: currentLook() });
    trackingNote.set("recording a take…");
    return;
  }
  const take = tracker.stopTake();
  trackingNote.set(`take: ${take.events.length} detections`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(take)], { type: "application/json" }));
  a.download = `veil-take-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
}, { shift: true });
gui.addText(keysHelp());
showHint("Choose how to play · C to change it later · R for a new veil", "Choose how to play · tap the camera to change it · tap {randomize} for a new veil");

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
const _view = new Vector3();

// Where the head goes (cm, the world's origin being the skull's usual place), from where the face is to the webcam (cm,
// camera space): as the webcam sees it. The same direction from the view's camera, and as much nearer or further as
// the face is from its usual distance, so the skull moves across the screen and grows and shrinks with the face.
function placeHead(p, out) {
  const D = camera.position.distanceTo(controls.target);
  const k = D / -NEUTRAL.z;
  _view.set(p.x * k, p.y * k, p.z * k).applyMatrix4(camera.matrixWorld).sub(controls.target);
  return out.copy(_view).divideScalar(CM);
}
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
const shown = { color: defaults.veilColor, opacity: defaults.veilOpacity, diffusion: defaults.diffusion, eyes: defaults.eyes };
let settleVeil;
const veilSettled = new Promise((resolve) => (settleVeil = resolve));
const swap = { state: "idle", fade: 0, releasing: false, outTime: 0, inTime: 0, blow: new Vector3() };
// How long the old veil is blown for, and how long the new one takes to fall and drape.
const BLOW_TIME = 1.8;
const DROP_TIME = 2;
function lookKey() {
  return `${params.tattered()}|${params.tatterSeed()}`;
}
let appliedKey = null;
// What a veil change lands on, for takes.
const LOOK_KEYS = ["skull", "veilColor", "veilOpacity", "diffusion", "tattered", "tatterSeed", "draft", "eyes"];
function currentLook() {
  return Object.fromEntries(LOOK_KEYS.map((k) => [k, params[k]()]));
}
// A replayed take's cue: the look of the veil it starts on, a veil change, or a gust.
function playCue(cue) {
  if (cue.kind === "gust") return startGust(cue);
  for (const k of LOOK_KEYS) if (k in cue.look) params[k].set(cue.look[k]);
  if (cue.kind === "change") {
    swap.forcedBlow = cue.blow;
    dropVeil();
  }
}

function dropVeil() {
  if (swap.state === "idle") swap.state = "out";
  swap.redrop = true;
}
onRandomize(() => gui.randomizeAll());
// Cloth colours are picked from a muted set (seeded, so a link reproduces them), a little darker or lighter each time.
const VEIL_COLORS = [
  "#6e1c1c", // red
  "#4a1414", // oxblood
  "#5e0f24", // crimson
  "#1d1b1d", // black
  "#2b292d", // charcoal
  "#b9b2a8", // bone white
  "#9e978e", // ash
  "#3c2246", // purple
  "#53284f", // plum
];
onRandomize(() => {
  const color = new Color(VEIL_COLORS[Math.floor(Math.random() * VEIL_COLORS.length)]);
  color.multiplyScalar(0.85 + 0.3 * Math.random());
  params.veilColor.set(`#${color.getHexString()}`);
  // Within the sliders' ranges, only what reads as a veil: with little blur, or dark and sheer, the cloth over the face
  // all but disappears. Dark cloth needs to be more opaque to show.
  const dark = 1 - Math.min(1, (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 0.25);
  params.diffusion.set(Math.round(100 * (0.15 + 0.35 * Math.random())) / 100);
  params.veilOpacity.set(Math.round(100 * (0.12 + 0.13 * dark + (0.38 - 0.13 * dark) * Math.random())) / 100);
  // The eyes' light, from the three.
  const eyes = Object.keys(EYE_LIGHTS);
  params.eyes.set(eyes[Math.floor(Math.random() * eyes.length)]);
  // A draft that keeps the cloth on the face without pressing it flat.
  params.draft.set(Math.round(2 * (3 + 4 * Math.random())) / 2);
});
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
    shown.eyes = params.eyes();
    if (veil && lookKey() !== appliedKey) swap.state = "out";
  }
  if (swap.state === "out") {
    // The old veil lets go of the head and a gust whisks it away; it's only faded once it's mostly gone.
    if (!swap.releasing && veil?.ready && swap.fade > 0.01) {
      // The new cut's maps are made while the old veil blows away.
      if (params.tattered()) veil.prepareMaps(params.tatterSeed());
      veil.release();
      sound.gust(1);
      swap.releasing = true;
      swap.outTime = 0;
      const side = nativeRandom() < 0.5 ? -1 : 1;
      swap.blow.set(side, 0.9, -0.2 + 0.4 * nativeRandom()).normalize();
      if (swap.forcedBlow) swap.blow.fromArray(swap.forcedBlow);
    }
    // A take keeps the change, as it starts: the look it lands on (already set) and which way the old veil blew.
    if (!swap.cued) {
      swap.cued = true;
      if (!tracker.replaying) tracker.addCue("change", { look: currentLook(), blow: swap.releasing ? swap.blow.toArray() : null });
    }
    if (swap.releasing) {
      swap.outTime += dt;
      swap.fade = 1 - MathUtils.smoothstep(swap.outTime, BLOW_TIME - 0.5, BLOW_TIME);
      if (swap.outTime >= BLOW_TIME) swap.releasing = false;
    } else {
      swap.fade = 0;
    }
    if (!swap.releasing && veil) {
      shown.color = params.veilColor();
      shown.opacity = params.veilOpacity();
      shown.diffusion = params.diffusion();
      shown.eyes = params.eyes();
      appliedKey = lookKey();
      // The new one is dropped from above the frame and falls onto the head as it's seen.
      veil.setTattered(params.tattered(), params.tatterSeed(), true);
      swap.redrop = false;
      swap.state = "wait";
      swap.cued = false;
      swap.forcedBlow = null;
    }
  }
  if (swap.state === "wait" && veil?.settled) {
    swap.state = "in";
    swap.fade = 1;
    swap.inTime = 0;
  }
  if (swap.state === "in" && (swap.inTime += dt) > DROP_TIME) {
    swap.state = "idle";
    settleVeil();
    autoChange.restart();
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
  idle.pose.makeRotationFromEuler(idle.euler).setPosition(0.8 * noise1(t * 0.11, 4), 0.5 * noise1(t * 0.09, 5) + NEUTRAL.y, NEUTRAL.z + 1.5 * noise1(t * 0.07, 6));
  // Chatter in bursts, an occasional slow gape, and a scowl that comes and goes.
  const chatter = Math.max(0, noise1(t * 0.23, 7) - 0.35) * 2.2;
  const gape = Math.max(0, noise1(t * 0.09, 8) - 0.45) * 2.4;
  const s = idle.shapes;
  s.jawOpen = MathUtils.clamp(chatter * (0.5 + 0.5 * Math.sin(t * 17)) * 0.5 + gape * 0.8, 0, 1);
  s.jawLeft = Math.max(0, 0.25 * noise1(t * 0.3, 9));
  s.jawRight = Math.max(0, -0.25 * noise1(t * 0.3, 9));
  const scowl = MathUtils.smoothstep(noise1(t * 0.12, 10), 0.05, 0.35);
  s.browDownLeft = s.browDownRight = scowl;
  // With the mouse, the pointer has the head; left alone for a while (or before a choice), it moves by itself again.
  pointer.idleFor += dt;
  const follow = params.control() === "mouse" && pointer.idleFor < POINTER_IDLE && !chooser.visible;
  pointer.share += ((follow ? 1 : 0) - pointer.share) * Math.min(1, dt * 1.5);
  if (pointer.share > 0.001) {
    const own = { ...s };
    updatePointerPose(dt);
    blendPoses(idlePose.copy(idle.pose), pointerPose, pointer.share, idle.pose);
    for (const key in s) s[key] = own[key] + (pointerShapes[key] - own[key]) * pointer.share;
  }
  return idle.pose;
}
// How long the pointer can rest before the head moves by itself again, in seconds.
const POINTER_IDLE = 8;
const idlePose = new Matrix4();
const pointerPose = new Matrix4();
const pointerShapes = {};

// --- Mouse or touch: the head turns toward the pointer (on a spring, so the cloth swings), and holding the button or a
// finger down opens the jaw; held on, the eyes light up.
const pointer = { x: 0.5, y: 0.45, down: false, held: 0, yaw: 0, pitch: 0, yawSpeed: 0, pitchSpeed: 0, idleFor: 99, share: 0 };
addEventListener("pointermove", (e) => {
  pointer.x = e.clientX / innerWidth;
  pointer.y = e.clientY / innerHeight;
  pointer.idleFor = 0;
});
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointer.down = true;
  pointer.idleFor = 0;
  pointer.x = e.clientX / innerWidth;
  pointer.y = e.clientY / innerHeight;
});
for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => (pointer.down = false));
function updatePointerPose(dt) {
  const k = 7;
  const yaw = (pointer.x - 0.5) * 1.2;
  const pitch = (pointer.y - 0.45) * 0.8;
  pointer.yawSpeed += (k * k * (yaw - pointer.yaw) - 2 * k * pointer.yawSpeed) * dt;
  pointer.pitchSpeed += (k * k * (pitch - pointer.pitch) - 2 * k * pointer.pitchSpeed) * dt;
  pointer.yaw += pointer.yawSpeed * dt;
  pointer.pitch += pointer.pitchSpeed * dt;
  pointerEuler.set(pointer.pitch, pointer.yaw, -0.05 * pointer.yawSpeed);
  pointerPose.makeRotationFromEuler(pointerEuler).setPosition((pointer.x - 0.5) * 6, NEUTRAL.y - (pointer.y - 0.5) * 3, NEUTRAL.z);
  pointer.held = pointer.down ? pointer.held + dt : 0;
  const s = pointerShapes;
  s.jawOpen = MathUtils.smoothstep(pointer.held, 0, 0.25) * 0.8;
  s.jawLeft = s.jawRight = 0;
  s.browDownLeft = s.browDownRight = MathUtils.smoothstep(pointer.held, 0.7, 1.1);
}
const pointerEuler = new Euler(0, 0, 0, "YXZ");

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
const veilTint = new Color();

function blendPoses(a, b, t, out) {
  a.decompose(_p0, _q0, _s);
  b.decompose(_p1, _q1, _s);
  return out.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s.set(1, 1, 1));
}

// Smoothed expression: the jaw eases (blendshapes aren't filtered) and the glow follows the frown.
const face = { jawOpen: 0, jawSide: 0, jawForward: 0, glow: 0 };
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
  const threshold = params.frownThreshold();
  const target = MathUtils.smoothstep(frown, threshold - 0.08, threshold + 0.08);
  face.glow += (target - face.glow) * (1 - Math.exp(-dt * 8));
}

// Ghostly gusts: every few seconds, at random, a breath of wind from one side that builds over about a second and
// dies away over two or three (nativeRandom, so the seeded look doesn't shift).
const gusts = { next: 3 + 5 * nativeRandom(), t: -1, rise: 1, fall: 2.5, peak: 0, strength: 0, direction: new Vector3(1, 0, 0) };
// Starts a gust (given, as a take recorded it, or at random); a take being recorded keeps it.
function startGust(given) {
  const angle = nativeRandom() * Math.PI * 2;
  gusts.direction.set(Math.cos(angle), 0.05 * nativeRandom(), 0.5 * Math.sin(angle)).normalize();
  gusts.peak = 2.5 + 3 * nativeRandom();
  gusts.rise = 0.7 + 0.8 * nativeRandom();
  gusts.fall = 1.8 + 1.5 * nativeRandom();
  if (given) {
    gusts.direction.fromArray(given.direction);
    Object.assign(gusts, { peak: given.peak, rise: given.rise, fall: given.fall });
  }
  gusts.t = 0;
  sound.gust((gusts.peak - 2.5) / 3);
  tracker.addCue("gust", { direction: gusts.direction.toArray(), peak: gusts.peak, rise: gusts.rise, fall: gusts.fall });
}

function updateGusts(dt) {
  // A replayed take brings its own gusts.
  if (gusts.t < 0 && !tracker.replaying && (gusts.next -= dt) <= 0) startGust();
  if (gusts.t >= 0) {
    gusts.t += dt;
    const { t, rise, fall } = gusts;
    const envelope = t < rise ? MathUtils.smoothstep(t, 0, rise) : 1 - MathUtils.smoothstep(t, rise, rise + fall);
    // A little flutter while it blows.
    gusts.strength = gusts.peak * envelope * (0.8 + 0.2 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1));
    if (t > rise + fall) {
      gusts.t = -1;
      gusts.strength = 0;
      gusts.next = 4 + 8 * nativeRandom();
    }
  }
}

function updateVeil(skull, dt) {
  const { veil, root } = skull;
  const m = root.matrixWorld;
  inverse.copy(m).invert();
  down.set(0, -1, 0).transformDirection(inverse);
  let delta = null;
  if (skull.hasLastMatrix) {
    // While the head floats off or back, or glides from its idle pose to a face just found, the veil is carried along
    // and only feels the turning.
    const gliding = state.presence < 1 || (state.mode === "face" && state.blend < 1);
    if (gliding) inverse.copy(m).setPosition(tmp.setFromMatrixPosition(skull.lastMatrix)).invert();
    delta = motion.multiplyMatrices(inverse, skull.lastMatrix);
  }
  skull.lastMatrix.copy(m);
  skull.hasLastMatrix = true;
  jawInverse.copy(skull.jawMatrix).invert();
  veil.draft = params.draft();
  // The gust blows in the room: its direction goes into the skull's space like gravity's.
  tmp.copy(gusts.direction).transformDirection(inverse.copy(m).invert()).multiplyScalar(gusts.strength);
  if (swap.releasing) {
    // Blown away: a gust up and to one side, building over most of a second, so the veil slides off.
    tmp.copy(swap.blow).transformDirection(inverse.copy(m).invert()).multiplyScalar(16 * MathUtils.smoothstep(swap.outTime, 0, 0.9));
  }
  veil.wind[0] = tmp.x;
  veil.wind[1] = tmp.y;
  veil.wind[2] = tmp.z;
  const p = state.presence;
  veil.loose = state.arriving && p > DRAW_IN ? -DRAW_IN_PULL * Math.sin((Math.PI * (p - DRAW_IN)) / (1 - DRAW_IN)) : MathUtils.smootherstep(1 - p / DRAW_IN, 0, 1);
  // Nothing keeps a veil that's blowing away over the face.
  if (swap.releasing) veil.loose = 1;
  veil.update(dt, down, skull.jawMatrix, jawInverse, delta);
}

let started = false;
let elapsed = 0;
let lastSkullName = null;

function frame(dt) {
  elapsed += dt;
  const found = tracker.update(dt) && (params.control() === "camera" || tracker.replaying);
  const name = params.skull();
  if (!skulls[name]) prepareSkull(name);
  // A take keeps a change of skull when it's asked for (the head drifts off and the new one comes back after).
  if (name !== lastSkullName) {
    if (lastSkullName && !tracker.replaying) tracker.addCue("skull", { look: { skull: name } });
    lastSkullName = name;
  }
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
      // The veil's near side is drawn by the composite, outside the skull's group.
      current.veil.setVisible(false);
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
  placeHead(tmp.setFromMatrixPosition(pose), tmp);
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
  veil.setLook({ color: shown.color, opacity: shown.opacity, diffusion: shown.diffusion, fade: swap.fade });
  composite.diffusion = shown.diffusion;
  veil.setVisible(veiled);
  // How much of the soft studio light the cloth stops before it reaches the bone (as veilBlocked; holes let some through).
  const stopped = 0.15 + 0.3 * shown.diffusion + (1 - 0.15 - 0.3 * shown.diffusion) * shown.opacity;
  const block = veil.mesh.visible ? stopped * swap.fade * (veil.tattered ? 0.8 : 1) : 0;
  skull.material.uniforms.veilBlock.value = block;
  // The cloth's hue (brightness is the shadow's job), as much as it covers.
  veilTint.set(shown.color);
  veilTint.multiplyScalar(1 / Math.max(veilTint.r, veilTint.g, veilTint.b, 1e-3));
  skull.material.uniforms.veilFilter.value.setRGB(1, 1, 1).lerp(veilTint, Math.min(1, block * 0.9));
  updateGusts(dt);
  if (veiled) updateVeil(skull, dt);
  else skull.hasLastMatrix = false;
  // Far off, the head is lost in the dark.
  const lit = MathUtils.smoothstep(state.presence, 0, 0.5);
  globalUniforms.lightColor.value.copy(baseLight).multiplyScalar(lit);
  globalUniforms.envIntensity.value = baseEnv * lit;
  setEmbers(skull, face.glow * params.glow() * lit, elapsed, 1, shown.eyes);
}

function describeCamera() {
  const s = tracker.state;
  if (capture) return "off (capture)";
  if (params.control() !== "camera" && !tracker.replaying) return "off (mouse)";
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
// The pipeline at 1.5x costs about 40% less than at 2x, which a soft, dark scene doesn't show. Only the page's own pixel
// ratio is capped: ?dpr= and the 2x screenshot keep theirs.
const DPR_CAP = new URLSearchParams(location.search).has("dpr") ? Infinity : 1.5;
onResize((w, h, dpr) => {
  if (dpr === Math.min(window.devicePixelRatio, 2) && dpr > DPR_CAP) {
    dpr = DPR_CAP;
    renderer.setPixelRatio(dpr);
  }
  pipeline.setSize(w, h, dpr);
  frameCamera(w, h);
});

applyUrlState();
syncCamera();

// A replayed take's look at its start, before the first veil drops (and the skull loads).
if (replayTake) {
  const look = takeLookAt(await replayTake, replayStart);
  if (look) for (const k of LOOK_KEYS) if (k in look) params[k].set(look[k]);
}
const first = load.skull.track(prepareSkull(params.skull(), load.skull.set));
await load.fields.track(fieldsFor(params.skull()));
await studio;
// A key about 7 degrees across, like the original demo's, instead of the studio's wide softbox: the cloth rides a few
// centimetres off the bone, and a penumbra wider than that loses it as a blocker on surfaces tilted toward the light.
globalUniforms.shadowLightSize.value = Math.tan(MathUtils.degToRad(3.5));
const firstSkull = await first;
firstSkull.root.visible = true;
const baseLight = globalUniforms.lightColor.value.clone();
const baseEnv = globalUniforms.envIntensity.value;
// Every program, the veil's near side included, before the first frame.
const compileScene = new Scene();
compileScene.add(firstSkull.veil.front.clone());
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), renderer.compileAsync(compileScene, camera)]), 4);
firstSkull.root.visible = false;

let lastControl = params.control();
window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  tracker,
  sound,
  // A take (the object Shift+T downloads) played instead of the camera.
  playTake: (take, options) => tracker.playTake(take, { onCue: playCue, ...options }),
  replayTake,
  resumeTake: () => tracker.resumeTake(),
  // Every head, and the first veil settled on the current one (a capture starts on a still veil).
  preload: () => Promise.all([...Object.keys(SKULLS).map((n) => prepareSkull(n)), veilSettled]),
};

// A replayed take brings its own veil changes and gusts: auto change is off.
replayTake?.then((take) => {
  params.auto.set(false);
  // A capture holds it at its start until recording begins (the adapter calls app.resumeTake).
  tracker.playTake(take, { onCue: playCue, start: replayStart, paused: capture });
});

// Frames go out on every Nth refresh, at most ~120 fps: a frame that sometimes makes a refresh and sometimes doesn't
// judders, and every jolt shows in the cloth. When frames keep missing their refresh, N goes up a step (an even, lower
// rate). ?fps= sets the most, ?fps=0 draws every refresh.
// A capture times its own frames (virtual time): no cap there.
const FPS = capture ? 0 : Number(new URLSearchParams(location.search).get("fps") ?? 120);
let refresh = 1 / 60;
let lastStamp = 0;
let vsyncs = 0;
let heldDt = 0;
let slower = 0;
let lastDrawn = 0;
const pacing = { drawn: 0, late: 0, clean: 0 };
render(({ dt: frameDt }) => {
  const stamp = performance.now();
  if (lastStamp) {
    const gap = (stamp - lastStamp) / 1000;
    // The display's refresh, from the shortest recent gaps between callbacks.
    if (gap > 0.002 && gap < 0.05) refresh += (Math.min(gap, refresh * 1.5) - refresh) * 0.05;
  }
  lastStamp = stamp;
  heldDt += frameDt;
  const every = (FPS > 0 ? Math.max(1, Math.round(1 / FPS / refresh)) : 1) + slower;
  if (++vsyncs % every !== 0 && started) return;
  if (lastDrawn && FPS > 0) {
    pacing.drawn++;
    // Late: a whole refresh missed.
    if ((stamp - lastDrawn) / 1000 > (every + 0.9) * refresh) pacing.late++;
    if (pacing.drawn >= 120) {
      if (pacing.late > 30 && 1 / ((every + 1) * refresh) >= 30) {
        slower++;
        pacing.clean = 0;
      } else if (pacing.late < 3 && slower > 0 && ++pacing.clean >= 5) {
        slower--;
        pacing.clean = 0;
      }
      pacing.drawn = pacing.late = 0;
    }
  }
  lastDrawn = stamp;
  const dt = Math.min(0.1, heldDt);
  heldDt = 0;
  if (!started) {
    started = true;
    sound.start();
    // The other heads, in the background.
    for (const name of Object.keys(SKULLS)) prepareSkull(name);
    if (!capture && !replayUrl) chooser.open();
  }
  if (params.control() !== lastControl) {
    lastControl = params.control();
    syncCamera();
  }
  autoChange.update(dt);
  sound.update(dt, Math.max(gusts.strength / 5.5, swap.releasing ? 1 : 0));
  if (dt > 0) frame(dt);
  const text = describeCamera();
  if (text !== cameraStatus.peek()) cameraStatus.set(text);
  if (tracker.state.stats !== trackingStats.peek()) trackingStats.set(tracker.state.stats);
  controls.update();
  pipeline.render(scene, camera, elapsed);
});
