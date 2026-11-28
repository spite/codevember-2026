// Prototype: find your way through a dark maze by echolocation. Your voice (or a click) sends rays of sound
// out from where you stand; each lands as a glowing dot on what it hits and bounces on, so the maze
// appears as a point cloud that stays and slowly fades.
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
  randomize,
  showHint,
  showSoundHint,
  loadingStep,
  addKey,
  addActionButton,
  getSeed,
  loadSeed,
} from "common";
import { GUI, signal } from "guspira";
import { Scene, ShaderMaterial, Vector3, Quaternion, DoubleSide, MeshBasicMaterial, Group, Mesh, CapsuleGeometry } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createAutoChange } from "modules/autoChange.js";
import { nativeRandom } from "modules/random.js";
import { loadSuzanne } from "./room.js";
import { createWorld } from "./world.js";
import { createWalker } from "./walk.js";
import { createAudio } from "./audio.js";
import { createChooser } from "./chooser.js";
import { createMotionRecorder, lastPose } from "./record.js";
import { createScanner } from "./scan.js";
import { createLens } from "./lens.js";
import { createVHS } from "./vhs.js";
import { createCRT } from "./crt.js";
import { createMinimap } from "./minimap.js";

const defaults = {
  rays: 4000,
  bounces: 2,
  speed: 14,
  memory: 10,
  dotSize: 0.06,
  fisheye: 1,
  vhs: 1,
  crt: 1,
  body: true,
  footsteps: true,
  watchers: true,
  debugMaze: false,
  debugMap: false,
  breath: true,
  focus: 0.55,
  micSensitivity: 0.72,
  auto: false,
  autoWalk: true,
  autoTime: 120,
  tape: 10,
  display: true,
  pingTime: 2.5,
};
const params = fromDefaults(defaults);
// Takes of the visitor's motion, for the video (see record.js).
const motion = createMotionRecorder();
const load = { maze: loadingStep(1, "Opening the back rooms…"), voice: loadingStep(1, "Clearing my throat…"), breath: loadingStep(1, "Catching my breath…"), compile: loadingStep(2, "Compiling shaders…") };

const pipeline = new Pipeline(renderer, {
  background: 0x000000,
  exposure: 1.1,
  bloomStrength: 0.35,
  bloomRadius: 0.5,
  vignette: 0.35,
  grain: 0.025,
  shadow: false,
  gi: false,
  // Lens, then the tape, then the tube it's played on.
  composite: (hdr, view) => {
    const image = lens.render(renderer, hdr, view);
    if (params.vhs() <= 0.001 && params.crt() <= 0.001) return image;
    return crt.render(renderer, vhs.render(renderer, image, view), view);
  },
});
const lens = createLens();
const vhs = createVHS();
const crt = createCRT();

const audio = createAudio();
// The call is a voice: one person's recorded hellos, shouted or plain, a different take each time.
// How the visitor plays: "mic" (only the voice calls), "click" (clicks call) or "watch" (it strolls and calls by
// itself), or "standby" before one is chosen.
// Standing by (the camcorder's blue screen, nothing running) until a mode is chosen; capture and replay skip it.
const skipStandby = ["capture", "replay"].some((k) => new URLSearchParams(location.search).has(k));
let mode = skipStandby ? "watch" : "standby";
// Scene time when recording began, for the tape counter.
let recordingFrom = 0;
// The tape running out: { t0, counter, was, rewound } while it stops and rewinds.
let tapeEnd = null;
let calls = { loud: [], normal: [] };
// Takes from a set play in a shuffled order, every one before any repeats, and never the same twice in a row.
const bags = new WeakMap();
function pick(list) {
  let bag = bags.get(list);
  if (!bag) bags.set(list, (bag = { order: [], last: -1 }));
  if (!bag.order.length) {
    bag.order = list.map((_, i) => i);
    for (let i = bag.order.length - 1; i > 0; i--) {
      const j = Math.floor(nativeRandom() * (i + 1));
      [bag.order[i], bag.order[j]] = [bag.order[j], bag.order[i]];
    }
    if (bag.order.length > 1 && bag.order[bag.order.length - 1] === bag.last) bag.order.unshift(bag.order.pop());
  }
  bag.last = bag.order.pop();
  return list[bag.last];
}
// Breathing: the same voice's breaths (see README): light ones, deep ones, and gasps for when it runs out.
let breaths = { deep: [], light: [], gasp: [] };
// No ordinary breath on top of a gasp.
let breathAfter = 0;
const breathsLoaded = load.breath.track(
  Promise.all([
    audio.loadClips([1, 2, 3, 4].map((k) => `breath/deep-${k}.mp3`)),
    audio.loadClips([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `breath/light-${k}.mp3`)),
    audio.loadClips([1].map((k) => `breath/gasp-${k}.mp3`)),
  ]).then(([deep, light, gasp]) => (breaths = { deep, light, gasp })).catch(() => {}),
);
const callsLoaded = load.voice.track(
  Promise.all([
    audio.loadClips([1, 2, 3, 4, 5, 6, 7, 8].map((k) => `voice/hello-loud-${k}.mp3`)),
    audio.loadClips([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `voice/hello-${k}.mp3`)),
  ])
    .then(([loud, normal]) => (calls = { loud: loud.map((c) => audio.trimOnset(c)), normal: normal.map((c) => audio.trimOnset(c)) }))
    .catch(() => {}),
);
audio.ensureContext();
for (const type of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(type, () => audio.ensureContext(), { capture: true });

const soundBtn = addActionButton("../assets/sound.svg", "Mute sound (M)", () => toggleSound());
function toggleSound() {
  audio.setMuted(!audio.isMuted());
  soundBtn.querySelector("img").src = audio.isMuted() ? "../assets/sound-off.svg" : "../assets/sound.svg";
}
// Keys and buttons work during the load: the chooser once it exists, recordings and calls (and their sound) from the
// first frame.
let chooserReady = false;
let framed = false;
const micBtn = addActionButton("mic.svg", "How to play: voice, click or watch (V)", () => chooserReady && chooser.open());
const micStatus = signal("off");
let micStarting = false;
async function toggleMic(on = !audio.isMicActive()) {
  if (micStarting || on === audio.isMicActive()) return audio.isMicActive();
  if (!on) {
    audio.stopMic();
    micBtn.querySelector("img").src = "mic.svg";
    micStatus.set("off");
    return false;
  }
  micStarting = true;
  try {
    await audio.startMic();
    micBtn.querySelector("img").src = "mic-on.svg";
    micStatus.set("listening");
  } catch (err) {
    micStatus.set(`unavailable (${err.name === "NotAllowedError" ? "permission denied" : err.message || err.name})`);
  }
  micStarting = false;
  return audio.isMicActive();
}
addKey("KeyM", "toggle sound", toggleSound);
addKey("KeyV", "choose how to play", () => chooserReady && chooser.open());
addKey("KeyK", "record your motion for a video (again to stop)", () => framed && toggleRecording());
addKey("KeyE", "shout (click mode)", () => mode === "click" && ping(1));

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSlider("Rays per call", params.rays, 200, 4000, 100, { randomizable: false });
gui.addSlider("Bounces", params.bounces, 0, 3, 1, { randomizable: false });
gui.addSlider("Sound speed (m/s)", params.speed, 3, 25, 0.5, { randomizable: false });
gui.addSlider("Memory (s, 60 = keep)", params.memory, 2, 60, 1, { randomizable: false });
gui.addSlider("Dot size (m)", params.dotSize, 0.008, 0.06, 0.001, { randomizable: false });
gui.addSlider("Fisheye", params.fisheye, 0, 1, 0.01, { randomizable: false });
gui.addSlider("VHS", params.vhs, 0, 1, 0.01, { randomizable: false });
gui.addSlider("CRT", params.crt, 0, 1, 0.01, { randomizable: false });
gui.addCheckbox("Camcorder display", params.display, { randomizable: false });
gui.addCheckbox("Body casts a sound shadow", params.body, { randomizable: false });
gui.addCheckbox("Footsteps reveal the floor", params.footsteps, { randomizable: false });
gui.addCheckbox("Watchers in the distance", params.watchers, { randomizable: false });
gui.addCheckbox("Show the maze (debug)", params.debugMaze, { randomizable: false });
gui.addCheckbox("Show the map (debug)", params.debugMap, { randomizable: false });
gui.addCheckbox("Breathing", params.breath, { randomizable: false });
gui.addSlider("Forward focus", params.focus, 0, 1.5, 0.05, { randomizable: false });
gui.addSlider("Mic sensitivity", params.micSensitivity, 0.1, 1, 0.05, { randomizable: false });
gui.addMonitor("Mic", micStatus);
const depthStat = signal("0 m");
gui.addMonitor("Depth", depthStat);
// Walking on its own (and calling out) is separate from the kiosk's new mazes.
gui.addCheckbox("Auto walk", params.autoWalk, { randomizable: false });
gui.addSlider("Tape (min)", params.tape, 1, 60, 1, { randomizable: false });
gui.addSlider("Call every (s, auto walk)", params.pingTime, 1, 8, 0.5, { randomizable: false });
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, min: 20, max: 180, ready: () => !audio.isMicActive() && !motion.recording && !motion.playing });
// Recording: K records the motion (a fresh start of this maze from where you stand); save it as a file,
// and play a file back. ?replay=<file> plays one on load (for the video recorder).
gui.addSection("Recording");
const recStatus = signal("idle");
gui.addMonitor("Motion", recStatus);
gui.addButton("Record / stop (K)", () => framed && toggleRecording());
gui.addButton("Save the last take", () => framed && lastTake && saveTake(lastTake));
gui.addButton("Play the last take", () => framed && lastTake && playRecording(lastTake));
gui.addButton("Play a take from a file…", () => framed && takeInput.click());
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showSoundHint(() => !audio.isMuted() && !audio.isRunning());
showHint("Choose how to explore · V to change it later · R for a new maze", "Choose how to explore · tap the mic to change it · tap {randomize} for a new maze");

// A prompt in the dark until the first call.
const prompt = document.createElement("div");
prompt.textContent = "";
Object.assign(prompt.style, {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  color: "rgba(255,248,236,0.75)",
  font: "300 22px/1.2 system-ui, sans-serif",
  letterSpacing: "0.08em",
  pointerEvents: "none",
  transition: "opacity 1.2s",
  zIndex: 5,
});
document.body.append(prompt);

const scene = new Scene();
// The maze itself is black: it only hides the dots behind its walls.
const black = new ShaderMaterial({
  uniforms: { uDebug: { value: 0 } },
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  // Black, except in the debug view: plainly shaded and fogged so the whole maze can be seen.
  fragmentShader: `
    uniform float uDebug;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      if (uDebug < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float light = 0.25 + 0.6 * abs(dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.3))));
      float fog = exp(-distance(vWorld, cameraPosition) * 0.05);
      gl_FragColor = vec4(vec3(0.85, 0.78, 0.5) * light * fog * 0.6, 1.0);
    }`,
  side: DoubleSide,
});
const suzanneGeo = await load.maze.track(loadSuzanne());
const room = createWorld(black, suzanneGeo);
scene.add(room.group);
// Dots are kept in a ring: past this many, each new one replaces the oldest.
const scanner = createScanner(scene, room, { maxDots: pipeline.quality === "high" || pipeline.quality === "capture" ? 400000 : 160000 });

// The watchers' bodies, built from the same capsules that block the sound: black, so they hide the dots
// behind them and stand out as silhouettes (red in the debug view).
const watcherMat = new MeshBasicMaterial({ color: 0x000000 });
const mannequins = Array.from({ length: 6 }, () => {
  const g = new Group();
  for (const [ax, ay, az, bx, by, bz, r] of room.bodyParts) {
    const a = new Vector3(ax, ay, az);
    const b = new Vector3(bx, by, bz);
    const len = a.distanceTo(b);
    const part = new Mesh(new CapsuleGeometry(r, len, 4, 10), watcherMat);
    part.position.copy(a).add(b).multiplyScalar(0.5);
    if (len > 1e-3) part.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(part);
  }
  g.visible = false;
  scene.add(g);
  return g;
});

camera.fov = 62;
camera.near = 0.05;
camera.updateProjectionMatrix();
controls.enabled = false;
const walker = createWalker(camera, renderer.domElement, room);
walker.setPassive(true);

const touch = matchMedia("(pointer: coarse)").matches;
let chooseTicket = 0;
// Choosing goes fullscreen with the UI hidden; leaving fullscreen brings the UI back. Browsers without
// fullscreen (iPhone Safari) keep the UI, since there'd be no way back to it.
const fullscreen = () => document.fullscreenElement || document.webkitFullscreenElement;
const syncUI = () => document.body.classList.toggle("hide-ui", !!fullscreen());
document.addEventListener("fullscreenchange", syncUI);
document.addEventListener("webkitfullscreenchange", syncUI);
const chooser = createChooser({
  touch,
  onPick() {
    if (fullscreen()) return;
    const el = document.documentElement;
    (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  },
  async onChoose(m) {
    const ticket = ++chooseTicket;
    let note = "";
    if (m === "mic") {
      const ok = await toggleMic(true);
      // Another choice was made while the browser asked: that one stands.
      if (ticket !== chooseTicket) {
        if (mode !== "mic") toggleMic(false);
        return { mode, note };
      }
      if (!ok) {
        m = "click";
        note = `The microphone isn't available (${micStatus.peek()}), so it's ${touch ? "taps" : "clicks"} for now.`;
      }
    }
    if (m !== "mic") await toggleMic(false);
    if (mode === "standby") recordingFrom = sceneTime;
    mode = m;
    walker.setPassive(m === "watch");
    prompt.textContent = m === "mic" ? "Say hello…" : m === "click" ? (touch ? "Tap to shout…" : "Click to shout…") : "";
    return { mode: m, note };
  },
});
chooserReady = true;
if (!skipStandby) chooser.open();
walker.reset();
const minimap = createMinimap(room, walker);
let mapClock = 0;
let baseFov = 62;
// The fisheye needs a wider render to bend in; the stronger it is, the wider the camera.
function updateFov() {
  const fov = baseFov + params.fisheye() * Math.min(45, 150 - baseFov);
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
onResize((w, h, dpr) => {
  const aspect = w / h;
  baseFov = aspect < 1 ? Math.min(85, (2 * Math.atan(Math.tan((31 * Math.PI) / 180) / aspect) * 180) / Math.PI) : 62;
  updateFov();
  pipeline.setSize(w, h, dpr);
  scanner.dotUniforms.uViewHeight.value = h * dpr;
});

let sceneTime = 0;
let sinceCall = Infinity;
let followUps = 0;
let followIn = 0;
const forward = new Vector3();
const right = new Vector3();
const up = new Vector3();
const stepOrigin = new Vector3();
const bodyDir = new Vector3();
const bodyFeet = new Vector3();
const toEcho = new Vector3();
const headInverse = new Quaternion();

// A call from where you stand: rays out, and its sound back from the surfaces as each ray lands.
// Voice: every call spends some, a shout more; it comes back after a moment's rest. A tired voice is weaker
// (fewer rays, quieter, lower). After a call it takes half a second to call again, and once it runs out it can't
// call at all for HOARSE seconds, and until it is back to one bar.
let voice = 1;
let sinceVoiced = Infinity;
let hoarse = false;
const COOLDOWN = 0.5;
const HOARSE = 5;
// With the microphone the voice is real: it never tires and needs no rest.
const canCall = () => mode === "mic" || (sinceVoiced >= COOLDOWN && !hoarse);
// Take playback state: declared before the load awaits, since a ping can come from the chooser during them.
let replaying = false;
let replayTime = 0;
let lastTake = null;
let replayTake = null;
let replayDone = null;

function ping(intensity = 1, silent = false) {
  if (!framed) return [];
  if (!replaying && (!canCall() || mode === "standby" || mode === "ended")) return [];
  const asked = intensity;
  motion.event(sceneTime, "call", asked);
  if (mode !== "mic") {
    intensity *= 0.2 + 0.8 * voice;
    voice = Math.max(0, voice - 0.085 * asked);
  }
  if (voice <= 0.001 && !hoarse) {
    hoarse = true;
    // Out of voice: a gasp for air once the call is out.
    if (breaths.gasp.length && params.breath()) {
      audio.playBreath(pick(breaths.gasp), 0.7, 1, 0.9);
      breathAfter = sceneTime + 3.5;
    }
  }
  sinceVoiced = 0;
  camera.updateMatrixWorld();
  forward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
  right.setFromMatrixColumn(camera.matrixWorld, 0);
  // From the mouth: a little below the eyes and in front of them.
  up.setFromMatrixColumn(camera.matrixWorld, 1);
  const origin = camera.position.clone().addScaledVector(forward, 0.12).addScaledVector(up, -0.11);
  const count = Math.round(params.rays() * Math.min(1.5, 0.5 + 0.5 * intensity));
  const hits = scanner.ping(origin, forward, count, intensity, sceneTime, params.bounces(), 200, params.focus());
  sinceCall = 0;
  room.onCall(camera.position);
  prompt.style.opacity = "0";
  if (!hits.length) return hits;
  // A handful of echoes, spread over the distances the rays actually landed at.
  hits.sort((a, b) => a.distance - b.distance);
  const echoes = [];
  for (let k = 1; k <= 8; k++) {
    const h = hits[Math.min(hits.length - 1, Math.floor((k / 9) * hits.length))];
    toEcho.subVectors(h.point, camera.position).normalize();
    // Its direction from the listener's head (x right, y up, -z ahead), for spatial sound.
    const local = toEcho.clone().applyQuaternion(headInverse.copy(camera.quaternion).invert());
    echoes.push({ delay: h.distance / params.speed(), gain: 0.9 / (1 + h.distance * 0.25), pan: toEcho.dot(right), dir: [local.x, local.y, local.z], order: k < 4 ? 1 : 2, pitch: 1 });
  }
  // The visitor's own voice isn't played back (they hear it themselves), only its echoes.
  if (silent) {
    audio.playMicEchoes(echoes);
    return hits;
  }
  if (calls.normal.length) {
    // A shouted hello for a strong call, a plain one otherwise; a tired voice shouts less.
    const loud = nativeRandom() < Math.min(1, Math.max(0, (intensity - 0.75) / 0.5)) * (0.4 + 0.6 * voice);
    const set = loud && calls.loud.length ? calls.loud : calls.normal;
    const clip = pick(set);
    // How enclosed it is (share of the call's hits within 1.4 m) rings a flutter; depth bends the echoes.
    const close = hits.filter((h) => h.distance < 1.4).length / hits.length;
    const others = [...calls.loud, ...calls.normal].filter((c) => c !== clip);
    audio.playVoice(clip, {
      intensity: Math.min(1.4, intensity),
      echoes,
      rate: (0.97 + nativeRandom() * 0.06) * (0.95 + 0.05 * voice),
      flutter: Math.min(1, Math.max(0, (close - 0.15) * 2.5)),
      weirdness: room.weirdnessAt(camera.position),
      others,
    });
  } else {
    audio.playPing({ pitch: 0.95 + nativeRandom() * 0.1, intensity, echoes });
  }
  return hits;
}

// In click mode, a click (a press that didn't turn the view) calls.
renderer.domElement.addEventListener("pointerup", (e) => {
  if (e.isPrimary && walker.wasClick() && mode === "click") ping(1);
});

onRandomize(() => {
  gui.randomizeAll();
  room.reset();
  scanner.clear();
  minimap.clearTrail();
  walker.reset();
  sinceCall = Infinity;
  followUps = 0;
  voice = 1;
  hoarse = false;
  sinceVoiced = Infinity;
});
applyUrlState();

await callsLoaded;
await breathsLoaded;
await load.compile.track(pipeline.compileAsync(scene, camera), 2);

// Recording and playing back takes.
const recLabel = document.createElement("div");
Object.assign(recLabel.style, {
  position: "fixed",
  top: "14px",
  left: "50%",
  transform: "translateX(-50%)",
  padding: "5px 12px",
  borderRadius: "999px",
  background: "rgba(20,0,0,0.7)",
  color: "rgb(255,90,80)",
  font: "600 13px 'Segoe UI', sans-serif",
  pointerEvents: "none",
  zIndex: 30,
  display: "none",
});
document.body.append(recLabel);
// A take starts from a fresh state of this maze (nothing heard yet, everyone where they began), so it plays back the same.
function startFresh() {
  room.reset();
  scanner.clear();
  minimap.clearTrail();
  voice = 1;
  hoarse = false;
  sinceVoiced = Infinity;
  sinceCall = Infinity;
  followUps = 0;
}
function toggleRecording() {
  if (motion.playing) return;
  if (motion.recording) {
    lastTake = motion.stop();
    recLabel.style.display = "none";
    recStatus.set(`take: ${lastTake.duration.toFixed(1)} s, ${lastTake.events.filter((e) => e[1] === "call").length} calls`);
    return;
  }
  startFresh();
  motion.start(sceneTime, { seed: getSeed(), mode, params: Object.fromEntries(Object.keys(defaults).map((k) => [k, params[k]()])) });
  recLabel.style.display = "block";
}
function saveTake(take) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(take)], { type: "application/json" }));
  a.download = `echo-take-${take.seed}-${Math.round(take.duration)}s.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const takeInput = document.createElement("input");
takeInput.type = "file";
takeInput.accept = ".json,application/json";
takeInput.addEventListener("change", async () => {
  const file = takeInput.files[0];
  takeInput.value = "";
  if (file) playRecording(JSON.parse(await file.text()));
});
// Plays a take in its own maze and settings; resolves when it ends, leaving the walker where it stopped.
function playRecording(take) {
  if (motion.recording) toggleRecording();
  if (String(take.seed) !== String(getSeed())) loadSeed(take.seed);
  for (const [k, v] of Object.entries(take.params || {})) if (params[k] && k !== "auto") params[k].set(v);
  chooser.hide();
  mode = take.mode || "click";
  walker.setPassive(true);
  startFresh();
  replaying = true;
  replayTake = take;
  motion.play(take, sceneTime);
  return new Promise((resolve) => (replayDone = resolve));
}
function endReplay() {
  replaying = false;
  const p = lastPose(replayTake);
  walker.teleport(p.x, p.z, p.yaw);
  walker.setPassive(mode === "watch");
  recStatus.set("idle");
  replayDone?.();
  replayDone = null;
}

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  room,
  scanner,
  audio,
  walker,
  ping: (i) => ping(i ?? 1),
  // For the video: play a take (an object or a url), resolving when it ends.
  playRecording: async (take) => playRecording(typeof take === "string" ? await (await fetch(take)).json() : take),
  toggleRecording,
  // For the video recorder: assets are loaded before the page runs; fn (the adapter's) runs before capture starts.
  preload: async (fn) => fn?.(window.app),
  get replayTime() {
    return replayTime;
  },
  get lastTake() {
    return lastTake;
  },
};

let lastWall = performance.now();
render(({ dt }) => {
  framed = true;
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;
  autoChange.update(dt);
  sceneTime += dt;
  sinceCall += dt;

  if (audio.isMicActive()) {
    const mic = audio.pollMic(now, params.micSensitivity());
    const bars = Math.round(mic.level * 8);
    const label = mic.peak < 1e-5 ? "no signal · mic muted or wrong input?" : `listening ${"█".repeat(bars)}${"░".repeat(8 - bars)}`;
    if (micStatus.peek() !== label) micStatus.set(label);
    // Your voice is the call (you hear it yourself, so the page stays quiet).
    if (mic.onset && !motion.playing) ping(mic.onset.intensity, true);
  }

  room.update(camera.position);
  room.updateWatchers(camera.position, nativeRandom, params.watchers() ? 1 : 0);
  black.uniforms.uDebug.value = params.debugMaze() ? 1 : 0;
  const ws = room.watchersList();
  mannequins.forEach((m, k) => {
    const w = ws[k];
    m.visible = !!w;
    if (!m.visible) return;
    watcherMat.color.set(params.debugMaze() ? 0xd04030 : 0x000000);
    m.position.copy(w.feet);
    m.rotation.set(0, Math.atan2(w.sin, w.cos), 0);
  });
  camera.getWorldDirection(bodyDir);
  room.setBody(bodyFeet.set(camera.position.x, camera.position.y - 1.6, camera.position.z), Math.atan2(-bodyDir.x, -bodyDir.z), params.body());
  const depth = Math.round(room.depthAt(camera.position));
  if (depthStat.peek() !== `${depth} m`) depthStat.set(`${depth} m`);
  let body;
  if (motion.playing) {
    // A take: its pose, and its calls, steps and breaths as they come (calls voiced, whatever the take's mode).
    const r = motion.pose(sceneTime, camera);
    body = { steps: [], inhale: false, call: false, moving: r.moving };
    for (const e of r.events) {
      if (e[1] === "call") ping(e[2]);
      else if (e[1] === "step") body.steps.push({ x: e[2], y: e[3], z: e[4], strength: e[5] });
      else if (e[1] === "breath") body.inhale = true;
    }
    replayTime = r.time;
    recStatus.set(`playing ${r.time.toFixed(1)} / ${replayTake.duration.toFixed(1)} s`);
    if (r.ended) endReplay();
  } else {
    body = walker.update(dt, { autoStroll: params.autoWalk() && mode === "watch", strollSpeed: 1.1, random: nativeRandom, weirdness: room.weirdnessAt(camera.position), speedScale: params.debugMaze() ? 4 : 1 });
  }
  if (motion.recording) {
    motion.frame(sceneTime, camera, body.moving);
    for (const st of body.steps) motion.event(sceneTime, "step", st.x, st.y, st.z, st.strength);
    if (body.inhale) motion.event(sceneTime, "breath");
    const t = Math.floor(motion.elapsed);
    recLabel.textContent = `● REC motion ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    recStatus.set(`recording ${motion.elapsed.toFixed(1)} s · ${motion.calls} calls`);
  }
  // Footsteps are sounds too: each one is heard, and lights the floor around the foot a little.
  for (const st of body.steps) {
    toEcho.set(st.x - camera.position.x, 0, st.z - camera.position.z);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    audio.playStep(0.6 + 0.4 * st.strength, toEcho.dot(right) * 2);
    // With the mic, the voice is the only thing that sends out sound to see by.
    if (params.footsteps() && mode !== "mic") scanner.ping(stepOrigin.set(st.x, st.y + 0.06, st.z), forward.set(0, -1, 0), 90, 0.35 * st.strength, sceneTime, 0, 90, 0);
  }
  // Each breath: deeper and louder deeper in, while walking, and after spending the voice.
  if (body.inhale && params.breath() && breaths.light.length && sceneTime > breathAfter) {
    const w = room.weirdnessAt(camera.position);
    const heavy = Math.min(1, 0.15 + 0.5 * w + 0.25 * body.moving + 0.6 * (1 - voice));
    const deep = nativeRandom() < heavy;
    const set = deep ? breaths.deep : breaths.light;
    audio.playBreath(pick(set), 0.6 * (0.8 + 0.4 * heavy), 1 + 0.04 * w);
  }
  // In kiosk mode it calls when it stops at a junction, or now and then while walking (not while the mic is on).
  sinceVoiced += dt;
  if (sinceVoiced > 0.8) voice = Math.min(1, voice + dt * 0.07);
  if (hoarse && voice >= 0.1 && sinceVoiced >= HOARSE) hoarse = false;
  // The stroll rests its voice when it runs low.
  if (params.autoWalk() && mode === "watch" && !motion.playing && walker.idle > 6 && followUps === 0 && voice > 0.3 && canCall() && (body.call || sinceCall > params.pingTime() * 3)) {
    const hits = ping(0.9);
    // Most of it landed far away (a big room, or dark ahead): call a few more times while looking round.
    const far = hits.length ? hits[Math.floor(hits.length / 2)].distance : 0;
    if (far > 3.5) followUps = far > 6 ? 3 : 2;
    followIn = COOLDOWN + 0.05;
  } else if (followUps > 0) {
    followIn -= dt;
    if (voice < 0.2) followUps = 0;
    else if (followIn <= 0) {
      ping(0.8 + nativeRandom() * 0.3);
      followUps--;
      followIn = COOLDOWN + 0.05 + nativeRandom() * 0.3;
    }
  }

  lens.uniforms.uStrength.value = params.fisheye();
  // The tape: when it runs out, recording stops (TAPE END), it rewinds, and a fresh one goes in: back to the start
  // screen, or, when watching, straight on into a new maze.
  const elapsed = sceneTime - recordingFrom;
  if (!tapeEnd && !skipStandby && !motion.playing && mode !== "standby" && mode !== "ended" && elapsed >= params.tape() * 60) {
    if (motion.recording) toggleRecording();
    tapeEnd = { t0: sceneTime, counter: elapsed, was: mode, rewound: false };
    mode = "ended";
    walker.setPassive(true);
    toggleMic(false);
    chooser.hide();
  }
  // While a take plays, the tape counter runs from its start.
  const osd = { voice: mode === "mic" ? null : voice, hoarse, counter: motion.playing ? replayTime : elapsed, state: mode === "standby" ? "standby" : "rec", tapeMinutes: params.tape() };
  let roll = 0;
  if (tapeEnd) {
    const e = sceneTime - tapeEnd.t0;
    if (e < 3) Object.assign(osd, { state: "stop", message: "TAPE END", counter: tapeEnd.counter });
    else if (e < 6) {
      if (!tapeEnd.rewound) {
        tapeEnd.rewound = true;
        audio.playRewind(3);
      }
      Object.assign(osd, { state: "rewind", counter: tapeEnd.counter * (1 - (e - 3) / 3) });
      roll = ((e - 3) * 1.7) % 1;
    } else {
      const was = tapeEnd.was;
      tapeEnd = null;
      randomize();
      recordingFrom = sceneTime;
      if (was === "watch") mode = "watch";
      else {
        mode = "standby";
        chooser.open("The tape ran out", "A fresh one is in. How do you want to explore?");
      }
      Object.assign(osd, { state: mode === "standby" ? "standby" : "rec", counter: 0 });
    }
  }
  osd.hidden = !params.display();
  vhs.update(sceneTime, params.vhs(), osd, roll);
  crt.uniforms.uAmount.value = params.crt();
  updateFov();
  // The debug map, redrawn ten times a second.
  minimap.setVisible(params.debugMap());
  mapClock += wallDt;
  if (params.debugMap() && mapClock > 0.1) {
    mapClock = 0;
    camera.getWorldDirection(bodyDir);
    minimap.draw(camera.position, Math.atan2(-bodyDir.x, -bodyDir.z), sceneTime);
  }
  scanner.dotUniforms.uMemory.value = params.memory();
  scanner.dotUniforms.uSize.value = params.dotSize();
  scanner.update(sceneTime, params.speed());
  pipeline.render(scene, camera, sceneTime);
});

const replayUrl = new URLSearchParams(location.search).get("replay");
if (replayUrl) window.app.playRecording(replayUrl);
