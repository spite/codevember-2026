import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, getSeed, loadSeed, randomize, addActionButton, addKey, onPause } from "common";
import { GUI } from "guspira";
import { Scene, Vector3, Vector2, Raycaster, Quaternion } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { createBackdrop } from "./backdrop.js";
import { Contraption, Cutter, FLOOR_Y } from "./contraption.js";
import { designContraption, pick, LAYOUTS } from "./design.js";
import { LOOKS, FINISHES, materialsFor, dress, blendStudio } from "./looks.js";
import { Stage } from "./stage.js";
import { Director } from "./director.js";
import { createSound } from "./sound.js";
import { Foley } from "./foley.js";

const BOBS = ["any", "star", "polygon", "cross", "gear", "flower", "key", "sphere", "suzanne"];
const HEROES = ["any", "wall", "iris", "rings", "tunnel", "torus"];
const LAYOUT_NAMES = ["any", ...LAYOUTS];
const LOOK_NAMES = ["any", ...Object.keys(LOOKS)];

const defaults = {
  physical: false,
  pendulumView: false,
  instant: false,
  slowMotion: false,
  motion: "constant",
  layout: "any",
  crossing: "any",
  hero: "any",
  bob: "any",
  finish: "any",
  look: "any",
  clearance: 4,
  speed: 1,
  auto: true,
  autoTime: 15,
};
const params = fromDefaults(defaults);
const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  sound: loadingStep(1, "Loading sounds…"),
  build: loadingStep(2, "Cutting the gates…"),
  compile: loadingStep(4, "Compiling shaders…"),
};

const pipeline = new Pipeline(renderer, {
  background: LOOKS.peach.backdrop,
  exposure: 1.55,
  bloomStrength: 0.02,
  vignette: 0.14,
  grain: 0.022,
  shadow: { autoFit: true, denoise: true },
  giOptions: { thickness: 0.35, fadeStart: 15, fadeEnd: 22 },
  // A short shutter: the bob is a blur only where it is fastest, at the bottom of the swing.
  motionBlur: { shutter: 1 / 90, samples: 16, maxBlur: 0.03, reusePrepass: true },
});
pipeline.gi.radius = 0.9;
// The drifting camera keeps the blur from reusing the prepass, so it costs a pass: high quality only.
pipeline.motionBlur = pipeline.quality === "high" || pipeline.quality === "capture";
globalUniforms.giIntensity.value = 1.3;
globalUniforms.aoIntensity.value = 1;
globalUniforms.aoPower.value = 1.25;
globalUniforms.aoDirect.value = 0.2;
globalUniforms.aoMin.value = 0.1;
globalUniforms.aoColor.value.setRGB(0.06, 0.04, 0.035);
globalUniforms.lightSpecular.value = 0.35;
globalUniforms.specularShadow.value = 1;

const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(0.52, 0.76, 0.5),
    keyIntensity: 18,
    keySize: 0.42,
    fill: 0.32,
    fillColor: 0xfff6ee,
    floor: 0.45,
    wall: 0.55,
    ceiling: 0.03,
    tint: 0xfffaf5,
  }),
);

const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Sounds already scheduled freeze with the animation.
onPause((running) => sound.setPaused(!running));

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Motion", params.motion, ["quick", "constant"], { randomizable: false, tooltip: "Quick: the mechanisms wait, then snap into line just in time. Constant: they never stop, each turning at one steady rate and swinging smoothly into line." });
gui.addCheckbox("Instant change", params.instant, { randomizable: false, tooltip: "R and auto change cut straight to the next contraption, with no pieces flying out and in." });
gui.addCheckbox("Slow motion", params.slowMotion, { randomizable: false, tooltip: "Time slows right down as the bob goes through each gate, then picks up again." });
gui.addCheckbox("Pendulum view", params.pendulumView, { randomizable: false, tooltip: "The camera hangs with the pendulum: its rod stays upright on screen and everything else swings round it." });
gui.addCheckbox("Physical", params.physical, { randomizable: false, tooltip: "Every piece held by something: turning parts make whole turns between passes and stay whole, and nothing is left floating." });
gui.addSelect("Layout", params.layout, LAYOUT_NAMES, { randomizable: false });
gui.addSelect("Hero", params.hero, HEROES, { randomizable: false });
gui.addSelect("Crossing", params.crossing, ["any", "on", "off"], { randomizable: false });
gui.addSelect("Bob", params.bob, BOBS, { randomizable: false });
gui.addSelect("Finish", params.finish, ["any", ...FINISHES], { randomizable: false });
gui.addSelect("Look", params.look, LOOK_NAMES, { randomizable: false });
gui.addSlider("Clearance (mm)", params.clearance, 1, 20, 0.5, { randomizable: false });
gui.addSlider("Speed", params.speed, 0, 2, 0.01, { randomizable: false });

const scene = new Scene();
const backdrop = createBackdrop({ floorY: FLOOR_Y, color: LOOKS.peach.backdrop });
scene.add(backdrop.mesh);
const cutter = new Cutter();

let buildFailures = 0;
// A build that fails would leave the stage empty for good: another seed instead, a few times at most.
function buildFailed(error) {
  if (error) console.error("day 18: building a contraption failed", error);
  if (++buildFailures <= 3) randomize();
}
const stage = new Stage({
  scene,
  shadowCamera: () => pipeline.shadow?.camera,
  // The new look's colours go on while the stage is empty; the studio blends to it.
  onLook: (from, to, t) => {
    if (t >= 1 || from === to) dress(to);
    blendStudio(from, to, t, { backdrop, pipeline });
  },
  onSettled: () => ((buildFailures = 0), autoChange.restart()),
  onFailed: () => buildFailed(),
  onArrive: (c) => director.reframe(c.framing()),
  // Each piece as it lifts off its seat, and as it lands: a click and a clack, the base heavier.
  onCue: (name, gate) => {
    const pan = gate ? foley.pan(gate.group.getWorldPosition(new Vector3())) : 0;
    if (name === "off") sound.play("click", { gain: gate ? 0.16 : 0.3, pan, rate: gate ? 1.1 : 0.75 });
    else sound.play(gate ? "clack" : "press", { gain: gate ? 0.3 : 0.4, pan, rate: gate ? 1 : 0.8 });
  },
});
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => !stage.busy });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Click a gate to knock it · drag to orbit · R for a new pendulum", "Tap a gate to knock it · drag to orbit · tap {randomize} for a new one");
showSoundHint(() => !sound.running);
gui.show();

// Every random draw for a contraption comes from the seed alone, so a link with the same seed and params rebuilds it.
const key = () => [getSeed(), params.motion(), params.physical(), params.layout(), params.hero(), params.crossing(), params.bob(), params.finish(), params.look(), params.clearance()].join("|");
function makeEntry() {
  const random = seededRandom(getSeed());
  const design = designContraption(random, { motion: params.motion(), physical: params.physical(), layout: params.layout(), bob: params.bob(), hero: params.hero(), crossing: params.crossing() === "any" ? undefined : params.crossing() === "on" });
  const names = Object.keys(LOOKS).filter((n) => params.finish() === "any" || LOOKS[n].finish === params.finish());
  // Stone and brass, and one colour throughout, now and then; pastel clay most of the time.
  const weights = names.map((n) => ({ clay: 3, mono: 1, stone: 1.4 })[LOOKS[n].finish]);
  const name = params.look() !== "any" ? params.look() : pick(random, names, weights);
  const look = LOOKS[name];
  const contraption = new Contraption(design, { clearance: params.clearance() / 1000, physical: params.physical() });
  return contraption.build(cutter, materialsFor(look)).then(() => ({ contraption, look }));
}

onRandomize(() => gui.randomizeAll());
applyUrlState();

camera.fov = 24;
camera.updateProjectionMatrix();
controls.minDistance = 3;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * 0.49;
const director = new Director({ camera, controls, random: nativeRandom });
// common.js resets the fov to its default on every resize: the Director's lens (24° and up) is put back.
let lensFov = camera.fov;
onResize((w, h, dpr) => {
  pipeline.setSize(w, h, dpr);
  camera.fov = lensFov;
  camera.updateProjectionMatrix();
});

let builtKey = key();
// The first contraption, retried if it fails to build (a few times at most).
const first = await load.build.track(
  (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // Keyed before the build: an R or panel change made while it builds swaps in on the first frame.
        builtKey = key();
        return await makeEntry();
      } catch (error) {
        if (attempt >= 2) throw error;
        console.error("day 18: building a contraption failed", error);
        // The same seed once more first (a cutter worker that failed to load hands over to the page), then another.
        if (attempt > 0) randomize();
      }
    }
  })(),
);
stage.show(first, 0.37);
director.reframe(first.contraption.framing(), true);
await studio;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);
await load.sound.track(sound.downloaded);

// The stage's machinery: cogs and a lever as the set is taken away, a crank as the next comes in, a latch as it lets go.
function stageSounds(state) {
  if (state === "leave") {
    sound.play("lever", { gain: 0.35, rate: 0.85 });
    sound.play("cog", { gain: 0.28, delay: 0.25, rate: 0.8 });
    sound.ratchet({ teeth: 12, duration: 1.2, gain: 0.12, delay: 0.3, rate: 0.75 });
  } else if (state === "arrive") {
    sound.play("crank", { gain: 0.2, rate: 0.9, duration: 1.4 });
    sound.ratchet({ teeth: 10, duration: 1.3, gain: 0.12, delay: 0.1, rate: 0.85 });
  } else if (state === "idle") {
    sound.play("bolt", { gain: 0.32, rate: 0.9 });
    sound.play("latch", { gain: 0.3, delay: 0.04 });
  }
}

// A click (not a drag) on a gate knocks it; a cursor shows which parts can be knocked.
const raycaster = new Raycaster();
const ndc = new Vector2();
function gateAt(event) {
  const c = stage.current?.contraption;
  if (!c || stage.busy) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  asSeen(() => raycaster.setFromCamera(ndc, camera));
  const hit = raycaster.intersectObjects(c.gates.map((g) => g.group), true).find((h) => h.object.userData.gate);
  return hit ?? null;
}
let press = null;
renderer.domElement.addEventListener("pointerdown", (e) => (press = { x: e.clientX, y: e.clientY, time: performance.now() }));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 || performance.now() - press.time > 400) return;
  press = null;
  const hit = gateAt(e);
  if (!hit) return;
  const moved = hit.object.userData.gate.knock(hit.object, hit.point, raycaster.ray.direction.clone(), stage.time);
  const pan = foley.pan(hit.point);
  // A knock always sounds; if the gate is free to move it spins or shoves, rattling as it goes.
  sound.play("clink", { gain: 0.45, pan, rate: 0.9 });
  sound.play("pop", { gain: 0.35, pan, rate: 0.7 });
  if (moved) sound.ratchet({ teeth: 8, duration: 0.5, gain: 0.18, pan, delay: 0.03, rate: 1.1 });
});
let hoverAt = 0;
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons || performance.now() - hoverAt < 90) return;
  hoverAt = performance.now();
  renderer.domElement.style.cursor = gateAt(e) ? "pointer" : "";
});

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  stage,
  director,
  sound,
  setTime: (t) => (stage.time = t),
  // Pieces of the contraption on show that nothing holds up (with Physical on, these are the fragments removed).
  floating: () => {
    const gates = stage.current?.contraption.gates ?? [];
    const pieces = gates.flatMap((g) => g.pieces.filter((p) => p.floating).map((p) => ({ gate: g.constructor.name, fragments: p.floating })));
    return { floating: pieces.reduce((a, p) => a + p.fragments, 0), removed: gates.reduce((a, g) => a + (g.dropped ?? 0), 0), pieces };
  },
  // A new contraption for `seed`, with the usual transition.
  change: (seed) => loadSeed(seed),
  // Recordings: the next contraption, as { seed, look, layout, hero, crossing } (any left out stay as they are).
  nextLook: (pick = {}) => {
    for (const k of ["look", "layout", "hero", "crossing"]) if (pick[k] !== undefined) params[k].set(pick[k]);
    if (pick.seed) loadSeed(pick.seed);
    else loadSeed(Math.floor(nativeRandom() * 2 ** 31).toString(36));
  },
  // Straight to the contraption of `seed`, without a transition.
  jump: async (seed, time = 0.37, set = {}) => {
    for (const [k, v] of Object.entries(set)) params[k].set(v);
    loadSeed(seed);
    builtKey = key();
    stage.replace(await makeEntry(), time);
    director.reframe(stage.current.contraption.framing(), true);
  },
};

const foley = new Foley(sound, camera);

// Every `loop` periods every turning part comes back round at once and its dot points at the pivot: a bell, and the
// dots glow for a moment.
let grandTime = null, grandAt = -Infinity;
function grandAlignment(c, t) {
  const accent = stage.current ? materialsFor(stage.current.look).accent : null;
  const cycle = c ? c.pendulum.period * c.design.loop : 0;
  if (c && grandTime !== null && c.markers.length && Math.floor(t / cycle) > Math.floor(grandTime / cycle)) {
    grandAt = t;
    sound.bell({ gain: 0.8, pitch: [1, 1.1225, 1.26][Math.floor(t / cycle) % 3] * Math.max(0.3, slowAt(c, t)) });
  }
  grandTime = c ? t : null;
  const glow = Math.exp(-Math.max(0, t - grandAt) / 0.5) * (t >= grandAt ? 1 : 0);
  if (accent) accent.emissive.copy(accent.color).multiplyScalar(1.6 * glow);
}
// Pendulum view: the picture turns about the pendulum's pivot so its rod stays upright on screen while the rest swings
// round it. The camera rolls about its line of sight to the pivot (it stays where it is, so it never swings through
// the floor), just for drawing and picking: the director and the controls keep their own upright camera. Switching it,
// or a new pendulum coming in, eases from one roll to the next.
const view = { turn: new Quaternion(), from: new Quaternion(), to: new Quaternion(), pivot: new Vector3(), hang: new Vector3(0, -1, 0), blend: 1, on: false, c: null };
const _axis = new Vector3(), _down = new Vector3(), _rod = new Vector3(), _cross = new Vector3();
function turnView(dt) {
  const c = stage.current?.contraption ?? null;
  const on = params.pendulumView();
  if (on !== view.on || (c && c !== view.c)) {
    view.from.copy(view.turn);
    view.blend = 0;
    view.on = on;
  }
  if (c) {
    view.c = c;
    view.pivot.copy(c.pivot);
    c.hang(view.hang);
  }
  if (!on) view.to.identity();
  else {
    // The roll about the line of sight that turns the camera's own down onto the rod, as seen.
    const axis = _axis.subVectors(view.pivot, camera.position).normalize();
    const down = _down.set(0, -1, 0).applyQuaternion(camera.quaternion);
    const rod = _rod.copy(view.hang);
    down.addScaledVector(axis, -down.dot(axis));
    rod.addScaledVector(axis, -rod.dot(axis));
    if (rod.lengthSq() > 1e-6 && down.lengthSq() > 1e-6) {
      down.normalize();
      rod.normalize();
      view.to.setFromAxisAngle(axis, Math.atan2(_cross.crossVectors(down, rod).dot(axis), down.dot(rod)));
    }
  }
  view.blend = Math.min(1, view.blend + dt / 0.8);
  const x = view.blend * view.blend * (3 - 2 * view.blend);
  view.turn.slerpQuaternions(view.from, view.to, x);
}
const _saved = new Quaternion();
function asSeen(fn) {
  if (Math.abs(view.turn.w) > 0.999999) return fn();
  _saved.copy(camera.quaternion);
  camera.quaternion.premultiply(view.turn);
  camera.updateMatrixWorld();
  try {
    return fn();
  } finally {
    camera.quaternion.copy(_saved);
    camera.updateMatrixWorld();
  }
}

// A new contraption: flown in piece by piece, or with Instant change a straight cut to it once it's built (the camera
// cutting to its framing too). The latest asked for wins.
let swaps = 0;
function swapTo(next) {
  const id = ++swaps;
  if (!params.instant()) return stage.change(next);
  next.then(
    (entry) => {
      if (id !== swaps) return entry.contraption.dispose();
      stage.replace(entry, 0);
      director.reframe(entry.contraption.framing(), true);
      autoChange.restart();
    },
    (error) => id === swaps && buildFailed(error),
  );
}

// Slow motion: how fast time runs at time t, eased right down around each pass through a gate and back up between.
const SLOWEST = 0.04;
const passCache = new WeakMap();
function slowAt(c, t) {
  if (!params.slowMotion() || !c) return 1;
  if (!passCache.has(c)) passCache.set(c, c.passTimes());
  const T = c.pendulum.period;
  let near = 0;
  for (const p of passCache.get(c)) {
    const d = ((((t - p) % T) + T * 1.5) % T) - T / 2;
    near = Math.max(near, Math.exp(-((d / 0.09) ** 2)));
  }
  return 1 - (1 - SLOWEST) * near;
}

let stageState = stage.state;
render(({ time, dt }) => {
  autoChange.update(dt);
  if (key() !== builtKey) {
    builtKey = key();
    swapTo(makeEntry());
  }
  const swinging = stage.state === "idle" ? stage.current?.contraption : null;
  const slow = slowAt(swinging, stage.time);
  const rate = params.speed() * slow;
  // Comings and goings keep at least a fifth of their pace, so a speed of 0 can't stall a change half way.
  stage.update(dt * (stage.state === "idle" ? rate : Math.max(0.2, params.speed())));
  if (stage.state !== stageState) {
    stageSounds(stage.state);
    stageState = stage.state;
  }
  foley.update(swinging, stage.time, dt > 0 ? rate : 0, (t) => slowAt(swinging, t));
  grandAlignment(stage.state === "idle" ? stage.current?.contraption : null, stage.time);
  director.update(dt * slow);
  controls.update();
  turnView(dt);
  lensFov = camera.fov;
  asSeen(() => pipeline.render(scene, camera, time));
});
