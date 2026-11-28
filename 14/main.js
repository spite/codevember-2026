import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, addKey, addActionButton, onPause } from "common";
import { GUI } from "guspira";
import { PMREMGenerator, Matrix3, Color, TextureLoader, SRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping, LinearMipmapLinearFilter, Scene, Group, Vector2, Vector3, Quaternion, Matrix4, Raycaster } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { computeSH, dominantDirection, applyEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { SHAPES, loadShape, prefetchShapes } from "../3/shapeAsset.js";
import { Water, MAX_BLOBS, MAX_RIPPLES } from "./water.js";
import { SurfaceWaves } from "./waves.js";
import { nativeRandom } from "modules/random.js";
import { Parcels, TUNING, bodyDistance } from "./sim.js";
import { loadSdf, prefetchSdf } from "./sdfAsset.js";
import { Backdrop } from "./backdrop.js";
import { createNoiseTexture } from "./noise.js";
import { createSound } from "./sound.js";
import { OrbitControls as FreeOrbitControls } from "modules/FreeOrbitControls.js";

const BACKGROUND = 0x5f6268;

const FINISHES = {
  "Red ceramic": { a: "#b8321f", b: "#b8321f", roughness: 0.25, metalness: 0, pattern: 0 },
  "Striped plastic": { a: "#f2efe8", b: "#1d4f8f", roughness: 0.35, metalness: 0, pattern: 1 },
  Brass: { a: "#d9a84e", b: "#d9a84e", roughness: 0.22, metalness: 1, pattern: 0 },
  Chrome: { a: "#e8e8e8", b: "#e8e8e8", roughness: 0.08, metalness: 1, pattern: 0 },
  Spots: { a: "#2f7d6b", b: "#f3ede1", roughness: 0.3, metalness: 0, pattern: 2 },
  Latitude: { a: "#f2efe8", b: "#2b2b2b", roughness: 0.35, metalness: 0, pattern: 3 },
  "Beach ball": { a: "#f2efe8", b: "#e0402f", roughness: 0.3, metalness: 0, pattern: 6 },
  "Candy swirl": { a: "#f6f1e6", b: "#d1283a", roughness: 0.25, metalness: 0, pattern: 7 },
  Giraffe: { a: "#f1e2c2", b: "#b0612a", roughness: 0.5, metalness: 0, pattern: 8 },
  Camo: { a: "#6f8150", b: "#36442a", roughness: 0.55, metalness: 0, pattern: 9 },
  Coral: { a: "#f2efe8", b: "#e06a4c", roughness: 0.35, metalness: 0, pattern: 10 },
  Wood: { a: "#d8a266", b: "#6b3a1c", roughness: 0.45, metalness: 0, pattern: 12 },
  Agate: { a: "#f4e9db", b: "#b8301a", roughness: 0.15, metalness: 0, pattern: 13 },
  Damascus: { a: "#c3c6cc", b: "#4f535a", roughness: 0.25, metalness: 1, pattern: 14 },
  Marble: { a: "#f1eee8", b: "#7d8490", roughness: 0.2, metalness: 0, pattern: 15 },
};

// 360° equirect panoramas around the scene, fetched when first shown.
// lift: how far the photo's clipped lights are pushed back up for the lighting (the visible backdrop shows the photo as is).
// exposure: the photos are dark interiors and space; each is brightened to sit with the other days.
const BACKGROUNDS = {
  Module: { file: "module", lift: 6, exposure: 1.35 },
  Bridge: { file: "bridge", lift: 6, exposure: 1.7 },
  "Deep space": { file: "space", lift: 3, exposure: 2 },
};
function loadPano(name) {
  return new TextureLoader().loadAsync(new URL(`./assets/backgrounds/${BACKGROUNDS[name].file}.jpg`, import.meta.url).href).then((t) => {
    t.colorSpace = SRGBColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.minFilter = LinearMipmapLinearFilter;
    return t;
  });
}

// The background is also the light: its lifted copy becomes the environment (reflections, ambient), and the key light
// comes from its brightest direction. The backdrop maps a direction to the photo as (atan(x, −z), −elevation) and
// three's equirect lookup as (atan(z, x), +elevation); this mirror takes one onto the other.
const ENV_ROTATION = new Matrix3().set(0, 0, -1, 0, -1, 0, 1, 0, 0);
const KEY_LIGHT = 3.2;
const KEY_DIRECTION = new Vector3(-0.6, 0.8, 0.7).normalize();
function lightFrom(backdrop, lift) {
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(backdrop.lighting(lift));
  pmrem.dispose();
  const sh = computeSH(renderer, target.texture);
  const direction = dominantDirection(sh).applyMatrix3(ENV_ROTATION.clone().transpose()).normalize();
  // The key takes the environment's average colour.
  const c = sh[0];
  const color = new Color(c.x, c.y, c.z).multiplyScalar(KEY_LIGHT / Math.max(c.x, c.y, c.z, 1e-4));
  return { envMap: target.texture, sh, direction, color };
}

// The photo's brightest region, as a direction in the backdrop's frame (its inverse mapping), from a small downsample.
function brightestDirection(image) {
  const W = 64, H = 32;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  c2d.drawImage(image, 0, 0, W, H);
  const px = c2d.getImageData(0, 0, W, H).data;
  let best = -1, bx = 0, by = 0;
  // Away from the poles, where a framing would look straight up or down.
  for (let y = 6; y < H - 6; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      if (l > best) (best = l), (bx = x), (by = y);
    }
  const az = ((bx + 0.5) / W - 0.5) * 2 * Math.PI, el = (0.5 - (by + 0.5) / H) * Math.PI;
  return new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

// Each background, once fetched: its defocused backdrop and its lighting.
const backgrounds = new Map();
function prepareBackground(name) {
  if (!backgrounds.has(name)) {
    const promise = loadPano(name).then((photo) => {
      const backdrop = new Backdrop(renderer);
      backdrop.setPhoto(photo);
      backdrop.setBlur(params.blur());
      return { name, backdrop, env: lightFrom(backdrop, BACKGROUNDS[name].lift), bright: brightestDirection(photo.image) };
    });
    promise.catch(() => backgrounds.delete(name));
    backgrounds.set(name, promise);
  }
  return backgrounds.get(name);
}

const defaults = {
  shape: "Suzanne",
  finish: "Striped plastic",
  film: 0.18,
  beads: 0,
  beadSize: 0.55,
  smooth: 0.25,
  freeBlobs: 0,
  ior: 1.2,
  steps: 160,
  spin: 0.2,
  grip: 7,
  taps: 2.5,
  tapStrength: 1,
  drift: 1,
  pooling: 0.6,
  background: "Module",
  blur: 0,
  turn: 0.02,
  auto: true,
  autoTime: 15,
};
const params = fromDefaults(defaults);
const load = {
  shape: loadingStep(2, "Loading the shape…"),
  cabin: loadingStep(1, "Lighting the cabin…"),
  sound: loadingStep(1, "Loading sounds…"),
  compile: loadingStep(5, "Compiling shaders…"),
};

let water = null;
const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1,
  bloomStrength: 0.04,
  vignette: 0.15,
  grain: 0.02,
  stillSamples: 16,
  // The body is always under the water and there is no floor: nothing in the raster pass receives AO or shadows.
  gi: false,
  shadows: false,
  composite: (hdr, info) => water.render(renderer, hdr, info),
});
// Phones trace the water at half resolution; their pixels are small enough that it stays sharp.
water = new Water({ scale: pipeline.quality === "high" || pipeline.quality === "capture" ? 1 : 0.5 });
water.uniforms.noiseTex.value = createNoiseTexture();

const TRANSITION = { shape: 2.2, finish: 1.2, background: 1.6 };
const smooth = (x) => x * x * (3 - 2 * x);
const look = {
  shape: { target: null, ready: null, shown: null, tween: null },
  finish: { shown: null, tween: null },
  background: { target: null, ready: null, shown: null, tween: null },
  swell: 0,
};
const transitioning = () => !!(look.shape.tween || look.finish.tween || look.background.tween);
const _cB = new Vector3();

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Shape", params.shape, Object.keys(SHAPES));
gui.addSelect("Finish", params.finish, Object.keys(FINISHES));
// Randomizing stays where it reads as water: thinner looks like varnish, thicker like glass.
const ranged = (controller, sig, lo, hi) => (controller.randomize = () => sig.set(+(lo + Math.random() * (hi - lo)).toFixed(3)));
ranged(gui.addSlider("Water thickness", params.film, 0.02, 0.4, 0.005), params.film, 0.12, 0.22);
gui.addSlider("Beads", params.beads, 0, 16, 1, { randomizable: false });
ranged(gui.addSlider("Bead size", params.beadSize, 0.1, 0.9, 0.01), params.beadSize, 0.3, 0.7);
gui.addSlider("Free blobs", params.freeBlobs, 0, 4, 1, { randomizable: false });
ranged(gui.addSlider("Smoothness", params.smooth, 0.05, 0.5, 0.01), params.smooth, 0.12, 0.4);
ranged(gui.addSlider("Pooling", params.pooling, 0, 1, 0.01), params.pooling, 0.3, 0.65);
ranged(gui.addSlider("Drift", params.drift, 0, 2, 0.01), params.drift, 0.6, 1.4);
ranged(gui.addSlider("IOR", params.ior, 1, 2, 0.01), params.ior, 1.1, 1.3);
gui.addSlider("Steps", params.steps, 32, 256, 1, { randomizable: false });
ranged(gui.addSlider("Spin", params.spin, 0, 1, 0.01), params.spin, 0.1, 0.35);
ranged(gui.addSlider("Grip", params.grip, 1, 20, 0.1), params.grip, 5, 10);
ranged(gui.addSlider("Tap strength", params.tapStrength, 0.2, 3, 0.05), params.tapStrength, 0.8, 1.5);
ranged(gui.addSlider("Random taps", params.taps, 0, 8, 0.1), params.taps, 1.8, 3.5);
gui.addSelect("Background", params.background, Object.keys(BACKGROUNDS));
gui.addSlider("Background blur", params.blur, 0, 5, 0.1, { randomizable: false });
ranged(gui.addSlider("Background turn", params.turn, 0, 0.2, 0.005), params.turn, 0.01, 0.04);
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => !transitioning() });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint(
  "Tap, hold or drag the water · pull it off the edge for a drop · swipe to spin · R for a new one",
  "Tap, hold or drag the water · pull it off the edge for a drop · swipe to spin · tap {randomize} for a new one",
);
const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
onPause((running) => sound.setPaused(!running));
showSoundHint(() => !sound.running);
// The cabin bed for each background: hum and ventilation levels and how bright it sounds.
const BED = {
  Module: { hum: 0.35, vent: 0.55, lowpass: 9000 },
  Bridge: { hum: 0.6, vent: 0.25, lowpass: 3500 },
  "Deep space": { hum: 0.25, vent: 0, lowpass: 1200 },
};
// Stereo position of a world point: -1 left .. 1 right.
const _pan = new Vector3();
const panOf = (p) => Math.max(-1, Math.min(1, _pan.copy(p).project(camera).x * 0.8));
const panOfContact = (c) => panOf(body.localToWorld(_pan.copy(c)));
gui.show();

const scene = new Scene();
const body = new Group();
scene.add(body);
let shape = null;
let waves = null;
const parcels = new Parcels();
const ripples = [];

const sdfs = new Map();
function shapeSdf(name, onProgress) {
  const key = SHAPES[name].key;
  if (!sdfs.has(key)) sdfs.set(key, loadSdf(renderer, key, onProgress));
  return sdfs.get(key);
}

const wavesByShape = new Map();
function shapeWaves(name, next, sdf) {
  if (!wavesByShape.has(name))
    // The height texture reaches further out than the body's grid, so thick coats and big waves stay inside it.
    wavesByShape.set(name, new SurfaceWaves(renderer, next.walk, next.topology(), next.sdf, { min: sdf.min.map((v) => v - 0.6), size: sdf.size + 1.2 }, SHAPES[name].scale));
  return wavesByShape.get(name);
}

let parcelKey = "";
function resetParcels() {
  if (!shape) return;
  parcels.reset(shape, body, { count: params.beads(), size: params.beadSize(), film: coat(), free: params.freeBlobs() });
  parcelKey = [shape.name, params.beads(), params.beadSize(), params.freeBlobs()].join();
  tendrils.length = 0;
  waves?.reset();
  ripples.length = 0;
}

// The axis along which a shape is thinnest (its smallest principal axis), object space: a torus's own axis.
function thinAxis(pos) {
  const n = pos.length / 3;
  const c = [0, 0, 0], C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / n;
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += (pos[i * 3 + a] - c[a]) * (pos[i * 3 + b] - c[b]) / n;
  // Power iteration on (trace·I − C): its largest eigenvector is C's smallest.
  const tr = C[0] + C[4] + C[8];
  let v = new Vector3(0.3, 0.8, 0.5).normalize();
  for (let it = 0; it < 60; it++) {
    const x = (tr - C[0]) * v.x - C[1] * v.y - C[2] * v.z;
    const y = -C[3] * v.x + (tr - C[4]) * v.y - C[5] * v.z;
    const z = -C[6] * v.x - C[7] * v.y + (tr - C[8]) * v.z;
    v.set(x, y, z).normalize();
  }
  return v;
}

// Each shape, once fetched: day 3's mesh and CPU field, our finer field, and its waves.
const shapes = new Map();
function prepareShape(name, onProgress) {
  if (!shapes.has(name)) {
    const promise = Promise.all([loadShape(name, { lite: true }), shapeSdf(name, onProgress)]).then(async ([next, sdf]) => {
      const w = shapeWaves(name, next, sdf);
      await w.ready;
      return { name, shape: next, sdf, waves: w, thin: thinAxis(next.walk.attributes.position.array) };
    });
    promise.catch(() => shapes.delete(name));
    shapes.set(name, promise);
  }
  return shapes.get(name);
}

function commitShape(p) {
  shape = p.shape;
  body.scale.setScalar(SHAPES[p.name].scale);
  water.setSdf(p.sdf);
  water.uniforms.objCentre.value.fromArray(p.shape.center);
  waves = p.waves;
  water.uniforms.heightTex.value = waves.texture;
  water.uniforms.heightMin.value.fromArray(waves.box.min);
  water.uniforms.heightSize.value = waves.box.size;
  resetParcels();
}

function setFinish(f, second) {
  const u = water.uniforms;
  (second ? u.objColorA2 : u.objColorA).value.set(f.a);
  (second ? u.objColorB2 : u.objColorB).value.set(f.b);
  (second ? u.objRoughness2 : u.objRoughness).value = f.roughness;
  (second ? u.objMetalness2 : u.objMetalness).value = f.metalness;
  (second ? u.objPattern2 : u.objPattern).value = f.pattern;
}

// Changes of shape, finish and background never cut: each runs as a transition of its own. A shape morphs (the two
// fields blend while the coat swells and its waves fade), a finish blends into the next, and a background crossfades
// with its lighting. A change made during one waits for it to finish.

function request(slot, name, prepare) {
  // A load that failed isn't asked for again until something else has been picked (then picking it retries).
  if (slot.target === name || slot.failed === name) return;
  slot.failed = null;
  slot.target = name;
  prepare(name).then(
    (p) => {
      if (slot.target === name) slot.ready = p;
    },
    (e) => {
      console.error(`Couldn't load ${name}`, e);
      if (slot.target === name) (slot.target = null), (slot.failed = name);
    },
  );
}

// The background tumbles slowly, like a camera drifting in zero gravity: its spin axis wanders through all three
// directions. Its lighting turns with it: backdrop, environment and key light.
let turnTime = 0;
const _spin = new Quaternion(), _step = new Quaternion(), _axisSpin = new Vector3();
const _turn = new Matrix3(), _unturn = new Matrix3(), _m4 = new Matrix4();
function turnBackground(dt) {
  turnTime += dt;
  const t = turnTime;
  _axisSpin.set(Math.sin(t * 0.071 + 1.3), 0.8 * Math.cos(t * 0.053 + 0.4), Math.sin(t * 0.089 + 2.1)).normalize();
  _step.setFromAxisAngle(_axisSpin, params.turn() * dt);
  _spin.premultiply(_step).normalize();
  _turn.setFromMatrix4(_m4.makeRotationFromQuaternion(_spin));
  _unturn.copy(_turn).transpose();
  water.uniforms.bgRotation.value.copy(_unturn);
  globalUniforms.envRotation.value.copy(ENV_ROTATION).multiply(_unturn);
}

// Continuous settings ease to new values instead of jumping.
const eased = { film: null, smooth: null };
function ease(key, target, dt, seconds = 0.8) {
  eased[key] = eased[key] === null ? target : eased[key] + (target - eased[key]) * (1 - Math.exp(-dt / (seconds / 3)));
  return eased[key];
}
const coat = () => eased.film ?? params.film();
const smoothness = () => eased.smooth ?? params.smooth();

function updateLook(dt) {
  const u = water.uniforms;
  ease("film", params.film(), dt);
  ease("smooth", params.smooth(), dt);

  // Shape.
  const s = look.shape;
  request(s, params.shape(), prepareShape);
  if (!s.tween && s.ready && s.ready !== s.shown) {
    s.tween = { from: s.shown, to: s.ready, t: 0 };
    water.setSdf(s.ready.sdf, true);
    sound.shot("plop", { gain: 0.6, rate: 0.55 });
  }
  u.morph.value = 0;
  u.heightGain.value = 1;
  look.swell = 0;
  sound.setLoop("bubbles", s.tween ? 0.45 * Math.sin(Math.PI * Math.min(1, s.tween.t + dt / TRANSITION.shape)) : 0, 0.8);
  if (s.tween) {
    const tw = s.tween;
    tw.t = Math.min(1, tw.t + dt / TRANSITION.shape);
    const k = smooth(tw.t);
    const a = SHAPES[tw.from.name].scale, b = SHAPES[tw.to.name].scale;
    u.morph.value = k;
    body.scale.setScalar(a + (b - a) * k);
    u.objCentre.value.fromArray(tw.from.shape.center).lerp(_cB.fromArray(tw.to.shape.center), k);
    u.heightGain.value = 1 - smooth(Math.min(1, tw.t / 0.3));
    look.swell = 0.12 * Math.sin(Math.PI * tw.t);
    if (tw.t >= 1) {
      s.tween = null;
      s.shown = tw.to;
      u.morph.value = 0;
      u.heightGain.value = 1;
      commitShape(tw.to);
      settle();
    }
  }

  // Finish.
  const f = look.finish;
  if (!f.tween && params.finish() !== f.shown) {
    f.tween = { to: params.finish(), t: 0 };
    setFinish(FINISHES[f.tween.to], true);
  }
  u.matMix.value = 0;
  if (f.tween) {
    f.tween.t = Math.min(1, f.tween.t + dt / TRANSITION.finish);
    u.matMix.value = smooth(f.tween.t);
    if (f.tween.t >= 1) {
      f.shown = f.tween.to;
      settle();
      f.tween = null;
      setFinish(FINISHES[f.shown], false);
      u.matMix.value = 0;
        }
  }

  // Background, with its lighting.
  const bg = look.background;
  request(bg, params.background(), prepareBackground);
  if (!bg.tween && bg.ready && bg.ready !== bg.shown) {
    bg.tween = { to: bg.ready, t: 0 };
    sound.shot("whoosh", { gain: 0.3, rate: 0.6 });
  }
  let k = 0;
  if (bg.tween) {
    bg.tween.t = Math.min(1, bg.tween.t + dt / TRANSITION.background);
    k = smooth(bg.tween.t);
    if (bg.tween.t >= 1) {
      bg.shown = bg.tween.to;
      settle();
      bg.tween = null;
      k = 0;
    }
  }
  const A = bg.shown, B = bg.tween?.to ?? A;
  A.backdrop.setBlur(params.blur());
  B.backdrop.setBlur(params.blur());
  u.pano.value = A.backdrop.texture;
  u.panoB.value = B.backdrop.texture;
  u.panoMix.value = k;
  const g = globalUniforms;
  if (g.envMap.value !== A.env.envMap) applyEnvironment({ envMap: A.env.envMap, sh: A.env.sh, lightDirection: A.env.direction });
  u.envMapB.value = B.env.envMap;
  u.envMix.value = k;
  for (let i = 0; i < 9; i++) g.shIrradiance.value[i].copy(A.env.sh[i]).lerp(B.env.sh[i], k);
  // The key stays above left of the camera, so the object is never only backlit; it takes the cabin's colour.
  g.lightDirection.value.copy(KEY_DIRECTION).applyQuaternion(camera.quaternion);
  pipeline.exposure = BACKGROUNDS[A.name].exposure + (BACKGROUNDS[B.name].exposure - BACKGROUNDS[A.name].exposure) * k;
  g.lightColor.value.copy(A.env.color).lerp(B.env.color, k);
  const bedA = BED[A.name], bedB = BED[B.name];
  sound.setBed({ hum: bedA.hum + (bedB.hum - bedA.hum) * k, vent: bedA.vent + (bedB.vent - bedA.vent) * k, lowpass: bedA.lowpass * Math.pow(bedB.lowpass / bedA.lowpass, k) });
}

// Body motion: a slow tumble about a drifting axis, plus the spin a swipe gives it, which decays.
const omega = new Vector3();
const prevOmega = new Vector3();
const flickOmega = new Vector3();
const _axis = new Vector3(), _dq = new Quaternion();

// The body drifts slowly round the centre on a soft spring; a swipe also pushes it. The coat feels the acceleration.
const SLOSH = { wander: 0.12, stiffness: 1.6, damping: 1.4, push: 0.3, maxPush: 1.4, gain: 0.55 };
const bodyVel = new Vector3(), linAccel = new Vector3(), _wander = new Vector3(), _f = new Vector3();
const showcase = { on: false, zoom: false, base: 0, face: {}, zoomVel: 0 };
const _view = new Vector3(), _thin = new Vector3(), _align = new Quaternion(), _err = new Vector3(), alignVel = new Vector3();
const SHOWCASE_SPRING = 0.45;
// Scripted pushes and spins ramp in over KICK_TIME (a smooth bump of force), never in one frame.
const KICK_TIME = 0.5;
const nudges = [];
function applyKicks(dt) {
  for (let i = nudges.length - 1; i >= 0; i--) {
    const k = nudges[i];
    const t0 = 1 - k.left / KICK_TIME, t1 = Math.min(1, t0 + dt / KICK_TIME);
    const share = (t1 * t1 * (3 - 2 * t1)) - (t0 * t0 * (3 - 2 * t0));
    bodyVel.addScaledVector(k.lin, share);
    linAccel.addScaledVector(k.lin, share);
    flickOmega.addScaledVector(k.ang, share);
    if ((k.left -= dt) <= 0) nudges.splice(i, 1);
  }
}

function moveBody(time, dt) {
  applyKicks(dt);
  _wander.set(Math.sin(time * 0.31 + 1.0), Math.sin(time * 0.23 + 2.0) * 0.8, Math.sin(time * 0.27 + 4.0)).multiplyScalar(SLOSH.wander * params.drift());
  _f.copy(_wander).sub(body.position).multiplyScalar(SLOSH.stiffness * SLOSH.stiffness).addScaledVector(bodyVel, -2 * SLOSH.damping);
  linAccel.add(_f.clone().multiplyScalar(dt));
  bodyVel.addScaledVector(_f, dt);
  body.position.addScaledVector(bodyVel, dt);
  _axis.set(Math.sin(time * 0.13), 1, Math.cos(time * 0.17) * 0.6).normalize();
  if (showcase.on) {
    // Showcase: the body turns its broad side to the camera and spins about the line of sight, so it reads whole.
    _view.copy(orbit.target).sub(camera.position).normalize();
    _axis.copy(_view);
    const p = look.shape.tween?.to ?? look.shape.shown;
    if (p) {
      const face = showcase.face[p.name];
      _thin.copy(face ? _thin.fromArray(face) : p.thin).transformDirection(body.matrixWorld);
      // A set facing points at the camera (the view runs from it, so the axis turns to oppose it); a thin axis either way.
      if (face) _thin.negate();
      else if (_thin.dot(_view) < 0) _thin.negate();
      // A soft angular spring with velocity, so the body eases into its facing and out of it, never stops dead. It
      // lets go while a quick spin is running and gathers the body back afterwards.
      _align.setFromUnitVectors(_thin, _view);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(_align.w)));
      const s = Math.sqrt(Math.max(1e-12, 1 - _align.w * _align.w)) * Math.sign(_align.w || 1);
      _err.set(_align.x, _align.y, _align.z).divideScalar(s || 1).multiplyScalar(angle);
      const k = SHOWCASE_SPRING * (1 - Math.min(1, flickOmega.length() / 1.5));
      alignVel.addScaledVector(_err, k * dt).multiplyScalar(Math.exp(-dt * 2 * Math.sqrt(SHOWCASE_SPRING)));
    }
  }
  flickOmega.multiplyScalar(Math.exp(-dt / 2.5));
  prevOmega.copy(omega);
  omega.copy(_axis).multiplyScalar(params.spin()).add(flickOmega);
  if (showcase.on) omega.add(alignVel);
  const w = omega.length();
  if (w > 1e-6) {
    _dq.setFromAxisAngle(_axis.copy(omega).divideScalar(w), w * dt);
    body.quaternion.premultiply(_dq);
  }
  body.updateMatrixWorld();
}

// Inertial acceleration of the coat in the body's frame (centrifugal and Euler), outward along the normal.
const _wo = new Vector3(), _ao = new Vector3(), _iq = new Quaternion();
const inertia = { cx: 0, cy: 0, cz: 0, s: 1 };
function inertialAt(x, y, z, nx, ny, nz) {
  const s = inertia.s;
  const rx = (x - inertia.cx) * s, ry = (y - inertia.cy) * s, rz = (z - inertia.cz) * s;
  const wr = _wo.x * rx + _wo.y * ry + _wo.z * rz, w2 = _wo.lengthSq();
  // −ω×(ω×r) = ω²r − (ω·r)ω, and −α×r.
  const ax = w2 * rx - wr * _wo.x - (_ao.y * rz - _ao.z * ry);
  const ay = w2 * ry - wr * _wo.y - (_ao.z * rx - _ao.x * rz);
  const az = w2 * rz - wr * _wo.z - (_ao.x * ry - _ao.y * rx);
  // The water also lags the body's own acceleration: it piles up on the trailing side.
  return ax * nx + ay * ny + az * nz - SLOSH.gain * (_al.x * nx + _al.y * ny + _al.z * nz);
}
const _al = new Vector3();

// Gestures on the water. A tap kicks the coat; holding presses a dent that springs back on release; dragging over
// the water presses a moving dent that leaves a wake; dragging off its edge pulls a tendril that necks and snaps into
// a drop; a quick swipe spins the body. Drags that start off the water orbit the camera.
const GESTURE = {
  tap: 5.5, // velocity kick (object units / s)
  tapRadius: 0.13,
  ripple: 0.13, // height of a tap's ripple train (world units)
  rippleLife: 2.2, // s
  rippleOnset: 0.04,
  press: 9, // pressure under a held pointer
  pressRadius: 0.11,
  pressRamp: 0.3, // s
  flick: 1.1,
  tendrilRadius: 0.17, // world units
  tendrilReach: 1.05, // snaps beyond this many body radii
  tendrilDraw: 3, // pressure drawing the coat into the tendril, at full stretch
};
const _ray = new Raycaster(), _ndc = new Vector2(), _hit = new Vector3(), _q = new Vector3(), _n = new Vector3(), _inv = new Matrix4();
const _plane = new Vector3(), _t = new Vector3(), _v = new Vector3();

function setRay(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
}

// The coat and the parcels, without the waves: { point (world), contact (object surface point), parcel } or null.
function pick(x, y) {
  if (!shape) return null;
  setRay(x, y);
  _inv.copy(body.matrixWorld).invert();
  const scale = body.scale.x, film = coat();
  const o = _ray.ray.origin, d = _ray.ray.direction;
  let t = 0;
  for (let i = 0; i < 128 && t < 40; i++) {
    _hit.copy(o).addScaledVector(d, t);
    _q.copy(_hit).applyMatrix4(_inv);
    let f = bodyDistance(shape.sdf, _q.x, _q.y, _q.z) * scale - film, parcel = null;
    for (const b of parcels.list) {
      const e = _hit.distanceTo(b.p) - b.r * (1 + Math.abs(b.stretch));
      if (e < f) (f = e), (parcel = b);
    }
    if (f < 1e-3) {
      _q.copy(_hit).applyMatrix4(_inv);
      shape.sdf.grad(_q.x, _q.y, _q.z, _n);
      const contact = _q.clone().addScaledVector(_n, -shape.sdf.sample(_q.x, _q.y, _q.z));
      return { point: _hit.clone(), contact, normal: _n.clone(), parcel };
    }
    t += f;
  }
  return null;
}

// Where the pointer ray meets the plane through `through` facing the camera.
function pointerOnPlane(x, y, through, out) {
  setRay(x, y);
  camera.getWorldDirection(_plane);
  const denom = _ray.ray.direction.dot(_plane);
  const t = Math.abs(denom) > 1e-6 ? _t.copy(through).sub(_ray.ray.origin).dot(_plane) / denom : 0;
  return out.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, Math.max(t, 0));
}

let gesture = null;
// Tendrils being pulled: the pointer's, and any started by app.pull().
const tendrils = [];
const kicks = [];

renderer.domElement.addEventListener(
  "pointerdown",
  (e) => {
    if (gesture || (e.pointerType === "mouse" && e.button !== 0)) return;
    const hit = pick(e.clientX, e.clientY);
    if (!hit) return;
    orbit.enabled = false;
    try {
      renderer.domElement.setPointerCapture(e.pointerId);
    } catch {}
    gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), age: 0, hit, contact: hit.contact, moved: 0, start: hit.point.clone() };
  },
  { capture: true },
);
addEventListener("pointermove", (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  gesture.x = e.clientX;
  gesture.y = e.clientY;
  gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0));
});
function endGesture(e, cancelled) {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  orbit.enabled = true;
  try {
    renderer.domElement.releasePointerCapture(e.pointerId);
  } catch {}
  if (cancelled) return;
  const duration = (performance.now() - g.t0) / 1000;
  if (g.tendril && !g.tendril.snapped) g.tendril.retracting = true;
  if (g.moved < 8 && duration < 0.3) {
    kicks.push(g.hit);
    return;
  }
  if (!g.tendril && g.moved > 30 && duration < 0.35) {
    // Swipe: spin the body as if the water were pushed along the swipe at the touched point.
    const end = pointerOnPlane(e.clientX, e.clientY, g.start, new Vector3());
    const v = end.sub(g.start).divideScalar(Math.max(duration, 0.05));
    const r = g.start.clone().sub(body.getWorldPosition(new Vector3()));
    const dw = r.clone().cross(v).divideScalar(Math.max(r.lengthSq(), 0.2)).multiplyScalar(GESTURE.flick);
    if (dw.length() > 9) dw.setLength(9);
    flickOmega.add(dw);
    // The push: the body moves along the swipe and the water lags behind, sloshing.
    const push = v.clone().multiplyScalar(SLOSH.push);
    if (push.length() > SLOSH.maxPush) push.setLength(SLOSH.maxPush);
    bodyVel.add(push);
    linAccel.add(push);
    const spin = Math.min(1, dw.length() / 6);
    sound.shot("whoosh", { gain: 0.25 + 0.6 * spin, pan: panOf(g.start), rate: 0.9 + 0.3 * spin });
    sound.shot("swirl", { gain: 0.3 + 0.5 * spin, pan: panOf(g.start) });
  }
}
addEventListener("pointerup", (e) => endGesture(e, false));
addEventListener("pointercancel", (e) => endGesture(e, true));

// The live gesture's dent, plus the tendril's draw on the coat.
function gesturePresses(dt, presses) {
  const g = gesture;
  let slosh = 0;
  if (g) {
    g.age += dt;
    if (!g.tendril) {
      const hit = pick(g.x, g.y);
      if (hit && !hit.parcel) {
        g.contact = hit.contact;
        const ramp = Math.min(1, g.age / GESTURE.pressRamp);
        if (g.moved >= 8 || g.age > 0.15) presses.push({ c: g.contact, pressure: GESTURE.press * ramp, radius: GESTURE.pressRadius });
        // Stirring: the slosh follows the pointer's speed over the water.
        const speed = dt > 0 ? Math.hypot(g.x - (g.lastX ?? g.x), g.y - (g.lastY ?? g.y)) / dt : 0;
        g.slosh = Math.min(1, speed / 1400);
      } else if (!hit && g.moved > 12) {
        startTendril(g);
      }
    }
  }
  if (g) {
    slosh = g.tendril ? 0 : g.slosh ?? 0;
    g.slosh = 0;
    g.lastX = g.x;
    g.lastY = g.y;
  }
  sound.setLoop("slosh", 0.7 * slosh, 0.85 + 0.3 * slosh);
  for (const t of tendrils) {
    const stretch = Math.min(1, t.length / t.reach);
    presses.push({ c: t.anchor, pressure: GESTURE.tendrilDraw * stretch, radius: GESTURE.pressRadius * 1.3 });
  }
}

function startTendril(g) {
  g.tendril = addTendril(g.contact, { gesture: g });
}

// A tendril from object-space contact c: driven by a gesture, or by script { dir (world, unit), speed (units / s) }.
function addTendril(c, { gesture: g = null, script = null } = {}) {
  _n.copy(c);
  shape.sdf.grad(_n.x, _n.y, _n.z, _n);
  const anchorWorld = body.localToWorld(c.clone().addScaledVector(_n, coat() / body.scale.x * 0.5));
  const t = {
    anchor: c.clone(),
    normal: _n.clone(),
    tip: anchorWorld.clone(),
    tipV: new Vector3(),
    length: 0,
    reach: GESTURE.tendrilReach * shape.radius * body.scale.x,
    snapped: false,
    retracting: false,
    gesture: g,
    script,
    age: 0,
  };
  tendrils.push(t);
  return t;
}

const _aw = new Vector3(), _target = new Vector3();
function updateTendrils(dt) {
  for (let i = tendrils.length - 1; i >= 0; i--) if (updateTendril(tendrils[i], dt)) tendrils.splice(i, 1);
}

// Returns true once the tendril is gone (snapped or drawn back in).
function updateTendril(t, dt) {
  t.age += dt;
  _aw.copy(t.anchor).addScaledVector(t.normal, (coat() / body.scale.x) * 0.5);
  body.localToWorld(_aw);
  if (t.script) _target.copy(_aw).addScaledVector(t.script.dir, t.script.speed * t.age);
  else if (t.retracting || t.gesture !== gesture) _target.copy(_aw);
  else pointerOnPlane(gesture.x, gesture.y, _aw, _target);
  // The tip follows on a spring, so it lags and overshoots a little.
  _v.copy(_target).sub(t.tip).multiplyScalar(140).addScaledVector(t.tipV, -16);
  t.tipV.addScaledVector(_v, dt);
  t.tip.addScaledVector(t.tipV, dt);
  t.length = t.tip.distanceTo(_aw);
  const r0 = GESTURE.tendrilRadius;
  // A squish now and then as it stretches, sooner the faster it goes.
  if (!t.retracting) {
    t.pulled = (t.pulled ?? 0) + t.tipV.length() * dt;
    if (t.pulled > 0.18) {
      t.pulled = 0;
      sound.squish({ gain: 0.25 + 0.5 * Math.min(1, t.tipV.length() / 4), pan: panOf(t.tip) });
    }
  }
  if (t.retracting && t.length < r0 * 0.5) {
    sound.shot("plop", { gain: 0.45, rate: 1.25, pan: panOf(t.tip) });
    waves.kick(t.anchor, -GESTURE.tap * 0.6, GESTURE.tapRadius * 1.4);
    return true;
  }
  if (!t.retracting && t.length > t.reach) {
    // Snap: the bulb flies on as a drop, a small satellite from the neck, and the stump recoils into the coat.
    const tipR = r0 * 0.95;
    sound.shot("bloop", { gain: 0.9, pan: panOf(t.tip) });
    parcels.addDrop(t.tip, t.tipV.clone().multiplyScalar(0.3), tipR);
    const mid = _v.copy(_aw).lerp(t.tip, 0.55);
    parcels.addDrop(mid, t.tipV.clone().multiplyScalar(0.12), r0 * 0.3);
    waves.kick(t.anchor, GESTURE.tap * 0.25, GESTURE.tapRadius * 1.5);
    t.snapped = true;
    return true;
  }
  return false;
}

// Tendril blobs: a bulb at the tip, a neck that thins as it stretches, and a foot in the coat.
function tendrilBlobs(out) {
  const r0 = GESTURE.tendrilRadius;
  for (const t of tendrils) {
    const s = Math.min(1, t.length / t.reach);
    _aw.copy(t.anchor).addScaledVector(t.normal, (coat() / body.scale.x) * 0.5);
    body.localToWorld(_aw);
    const neck = r0 * Math.max(0.12, 0.75 - 0.6 * s);
    out.push([_aw.clone(), r0 * 0.85]);
    out.push([_aw.clone().lerp(t.tip, 0.35), Math.max(neck * 1.3, r0 * 0.2)]);
    out.push([_aw.clone().lerp(t.tip, 0.68), neck]);
    out.push([t.tip.clone(), r0 * (0.75 + 0.3 * s)]);
  }
}

// A drop that comes back lands with a small splash, then sinks and shrinks into the coat over MERGE_TIME while its
// volume is poured in as a swell around the landing point.
const MERGE_TIME = 0.7;
function mergeDrops(dt) {
  _inv.copy(body.matrixWorld).invert();
  for (let i = parcels.list.length - 1; i >= 0; i--) {
    const b = parcels.list[i];
    if (b.merge === undefined) {
      if (!b.drop || !b.wasFree || b.attached < 0.9 || b.age < 0.4) continue;
      b.merge = 0;
      b.r0 = b.r;
      const size = b.r / GESTURE.tendrilRadius;
      sound.shot("plop", { gain: 0.35 + 0.6 * size, rate: 1.35 - 0.4 * size, pan: panOf(b.p) });
      waves.kick(landing(b), -GESTURE.tap * 0.5 * size * size, GESTURE.tapRadius * (0.8 + size));
    }
    const before = smoothstep(b.merge);
    b.merge = Math.min(1, b.merge + dt / MERGE_TIME);
    const k = smoothstep(b.merge);
    b.r = b.r0 * Math.cbrt(1 - k);
    // The share of the drop's volume that left it this step, spread as a gaussian of the same volume.
    const scale = body.scale.x;
    const sigma = Math.max(b.r0 * 1.2, 0.12);
    const volume = (4 / 3) * Math.PI * b.r0 ** 3 * (k - before);
    waves.raise(landing(b), volume / (2 * Math.PI * sigma * sigma) / scale, sigma / scale);
    if (b.merge >= 1) parcels.list.splice(i, 1);
  }
}

function landing(b) {
  _q.copy(b.p).applyMatrix4(_inv);
  shape.sdf.grad(_q.x, _q.y, _q.z, _n);
  return _q.clone().addScaledVector(_n, -bodyDistance(shape.sdf, _q.x, _q.y, _q.z));
}

function smoothstep(x) {
  return x * x * (3 - 2 * x);
}

onRandomize(() => {
  gui.randomizeAll();
  resetParcels();
});
applyUrlState();

camera.position.set(0, 0.4, 5.5);
// The shared orbit locks at the poles; this one turns the camera's up with it, so the view rolls freely in zero gravity.
controls.dispose();
const orbit = new FreeOrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 0);
// Orbiting keeps drifting after release and eases to a stop, like a camera floating free.
orbit.enableDamping = true;
orbit.dampingFactor = 0.04;
orbit.maxDistance = 8;
orbit.minDistance = 2;
onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

look.shape.target = params.shape();
look.shape.shown = look.shape.ready = await load.shape.track(prepareShape(params.shape(), load.shape.set));
commitShape(look.shape.shown);
look.background.target = params.background();
look.background.shown = look.background.ready = await load.cabin.track(prepareBackground(params.background()));
globalUniforms.envRotation.value.copy(ENV_ROTATION);
look.finish.shown = params.finish();
setFinish(FINISHES[look.finish.shown], false);
await load.sound.track(sound.loaded);
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), water.compile(renderer)]), 5);
// Desktops fetch every shape and background (about 13 MB) so a change never waits; phones fetch on demand.
if (pipeline.quality === "high") {
  prefetchShapes();
  for (const { key } of Object.values(SHAPES)) prefetchSdf(key);
  for (const name of Object.keys(BACKGROUNDS)) loadPano(name).catch(() => {});
}

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls: orbit,
  water,
  sound,
  Vector3,
  parcels,
  get waves() {
    return waves;
  },
  pick,
  // For recordings: every shape and background ready, so no change waits.
  // ready(app), if given, runs once everything is in (a recorder's setup before its first frame).
  preload: (ready) =>
    Promise.all([...Object.keys(SHAPES).map((n) => prepareShape(n)), ...Object.keys(BACKGROUNDS).map((n) => prepareBackground(n))]).then(() => ready?.(window.app)),
  // n tendrils pulled at once from spots facing the camera.
  pull(n = 3) {
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 30; tries++) {
        const i = Math.floor(nativeRandom() * waves.n);
        _tp.fromArray(waves.pos, i * 3);
        _tn.fromArray(waves.nor, i * 3).transformDirection(body.matrixWorld);
        const world = body.localToWorld(_tp.clone());
        if (_tn.dot(_eye.copy(camera.position).sub(world).normalize()) < 0.25) continue;
        if (tendrils.some((t) => t.anchor.distanceTo(_tp) < 0.6)) continue;
        addTendril(_tp.clone(), { script: { dir: _tn.clone(), speed: 1.4 + 0.6 * nativeRandom() } });
        break;
      }
    }
  },
  // A push along a world direction: the body moves and turns, the water swings behind.
  push(dir, strength = 1) {
    const v = dir.clone().normalize().multiplyScalar(SLOSH.maxPush * strength);
    nudges.push({ lin: v, ang: new Vector3(0, 0, 1).applyQuaternion(camera.quaternion).cross(v).multiplyScalar(1.2), left: KICK_TIME });
    sound.shot("whoosh", { gain: 0.4 * strength, rate: 0.95 });
    sound.shot("swirl", { gain: 0.5 * strength });
  },
  // A quick spin about the screen's vertical, so the turn reads to the camera.
  spin(speed = 4) {
    nudges.push({ lin: new Vector3(), ang: new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(speed), left: KICK_TIME });
    sound.shot("whoosh", { gain: 0.6, rate: 1.1 });
    sound.shot("swirl", { gain: 0.7 });
  },
  // n taps; strength (× Tap strength) is random about 1 unless given.
  tapRandom(n = 1, strength = null) {
    for (let k = 0; k < n; k++) tapSomewhere(params.tapStrength() * (strength ?? 0.9 + 0.4 * nativeRandom()), lastTime, false);
  },
  // Turns the camera so the background's brightest region sits right behind the object.
  // amount < 1 eases toward it (call every frame), so a new background swings the view round smoothly.
  frameBright(amount = 1) {
    const b = look.background.tween?.to ?? look.background.shown;
    if (!b) return;
    const d = b.bright.clone().applyMatrix3(_turn).normalize();
    const dist = camera.position.distanceTo(orbit.target);
    const from = orbit.target.clone().sub(camera.position).normalize();
    const dir = from.lerp(d, amount).normalize();
    camera.up.lerp(_eye.set(0, 1, 0), amount).normalize();
    camera.position.copy(orbit.target).addScaledVector(dir, -dist);
    camera.lookAt(orbit.target);
  },
  // For recordings: the body faces the camera with its broad side and spins about the view; zoom follows the drops.
  // face: { [shape]: [x, y, z] } an object-space direction to turn toward the camera instead of the thin axis.
  showcase({ zoom = true, face = {} } = {}) {
    showcase.on = true;
    showcase.face = face;
    showcase.zoom = zoom;
    showcase.base = camera.position.distanceTo(orbit.target);
    // Turn to the facing at once, so a recording starts settled.
    const p = look.shape.tween?.to ?? look.shape.shown;
    if (p) {
      const v = orbit.target.clone().sub(camera.position).normalize();
      const f = face[p.name];
      const a = (f ? new Vector3().fromArray(f) : p.thin.clone()).transformDirection(body.matrixWorld);
      if (f || a.dot(v) < 0) a.negate();
      body.quaternion.premultiply(new Quaternion().setFromUnitVectors(a, v));
      body.updateMatrixWorld();
    }
  },
  tap: (x, y) => {
    const hit = pick(x, y);
    if (hit) kicks.push(hit);
    return hit;
  },
};

// Random taps on the side facing the camera, every `taps` seconds on average, once the visitor has left it alone.
let idle = 0;
let nextTap = 1;
const _tp = new Vector3(), _tn = new Vector3(), _eye = new Vector3();
addEventListener("pointerdown", () => (idle = 0), { capture: true });
// A tap at a random spot on the side facing the camera.
function tapSomewhere(strength, time, quiet) {
  for (let tries = 0; tries < 24; tries++) {
    const i = Math.floor(nativeRandom() * waves.n);
    _tp.fromArray(waves.pos, i * 3);
    _tn.fromArray(waves.nor, i * 3).transformDirection(body.matrixWorld);
    body.localToWorld(_tp);
    if (_tn.dot(_eye.copy(camera.position).sub(_tp).normalize()) < 0.35) continue;
    tapAt(_tp.fromArray(waves.pos, i * 3).clone(), strength, time, quiet);
    return;
  }
}

function randomTaps(dt, time) {
  idle += dt;
  // Taps queued by a finished transition: a couple of them, a moment apart, to set the new look moving.
  for (let i = settleTaps.length - 1; i >= 0; i--)
    if ((settleTaps[i] -= dt) <= 0) {
      settleTaps.splice(i, 1);
      if (!gesture && !tendrils.length) tapSomewhere(params.tapStrength() * (0.8 + 0.5 * nativeRandom()), time, false);
    }
  if (params.taps() <= 0 || gesture || tendrils.length || idle < 3 || (nextTap -= dt) > 0) return;
  nextTap = params.taps() * (0.4 + 1.2 * nativeRandom());
  tapSomewhere(params.tapStrength() * (0.6 + 0.7 * nativeRandom()), time, true);
}

const settleTaps = [];
// Once a transition lands, two taps in different places; several landing together queue them once.
function settle() {
  if (settleTaps.length) return;
  settleTaps.push(0.1, 0.45 + 0.3 * nativeRandom());
}

// A thin film can only carry small waves: taps scale down below a coat of about 0.11.
const coatScale = () => Math.min(1, coat() * 9);

// A tap: a ripple train drawn over the coat, plus a smaller kick to the simulation for the dent and the wobble.
function tapAt(contact, strength, time, quiet = false) {
  const size = 0.4 + strength * coatScale(), pan = panOfContact(contact);
  sound.drop({ size, pan, gain: quiet ? 0.4 : 1 });
  sound.ripple({ size, pan, gain: quiet ? 0.35 : 1 });
  if (ripples.length >= MAX_RIPPLES) ripples.shift();
  ripples.push({ contact: contact.clone(), start: time, strength });
  waves.kick(contact, -GESTURE.tap * 0.5 * strength * coatScale(), GESTURE.tapRadius);
}

function updateRipples(time) {
  const u = water.uniforms;
  // A ripple leaves the shader once it has decayed below a few thousandths of a unit.
  for (let i = ripples.length - 1; i >= 0; i--) {
    const age = time - ripples[i].start;
    if (age > GESTURE.rippleLife && GESTURE.ripple * ripples[i].strength * Math.exp(-age / GESTURE.rippleLife) < 0.003) ripples.splice(i, 1);
  }
  let steep = 0;
  ripples.forEach((r, i) => {
    const age = Math.max(0, time - r.start);
    const amp = -GESTURE.ripple * r.strength * coatScale() * water.uniforms.heightGain.value * (1 - Math.exp(-age / GESTURE.rippleOnset)) * Math.exp(-age / GESTURE.rippleLife);
    u.rippleA.value[i].set(r.contact.x, r.contact.y, r.contact.z, age);
    u.rippleAmp.value[i] = amp;
    steep += Math.abs(amp) * u.rippleWave.value.z;
  });
  // Overlapping trains add up: past a combined steepness the water folds into chaos, so they share a budget.
  const budget = 3;
  if (steep > budget) {
    for (let i = 0; i < ripples.length; i++) u.rippleAmp.value[i] *= budget / steep;
    steep = budget;
  }
  u.rippleCount.value = ripples.length;
  return steep;
}

const _c = new Vector3();
let lastNow = performance.now();
// Transitions run on wall time, so a change made while paused still plays out.
function realDt() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  return dt;
}
const SUBSTEPS = 4;
const blobList = [];
let lastSignature = "";

let lastTime = 0;
render(({ time, dt }) => {
  sound.arm();
  lastTime = time;
  autoChange.update(dt);
  updateLook(realDt());
  turnBackground(dt);
  if (!shape || !waves) return;
  if ([shape.name, params.beads(), params.beadSize(), params.freeBlobs()].join() !== parcelKey) resetParcels();
  TUNING.grip = params.grip();

  const scale = body.scale.x;
  const film = coat();
  for (const hit of kicks) {
    if (hit.parcel) parcels.poke(hit.point, _ray.ray.direction, 1.6, hit.parcel.r * 1.5);
    else tapAt(hit.contact, params.tapStrength(), time);
  }
  kicks.length = 0;

  if (dt > 0) {
    const step = Math.min(dt, 1 / 30);
    const h = step / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      moveBody(time, h);
      const centre = body.localToWorld(_c.fromArray(shape.center));
      parcels.step(h, shape, body, omega, centre, film);
      updateTendrils(h);
    }
    mergeDrops(step);
    randomTaps(step, time);
    // The coat feels the body's spin in its own frame.
    _iq.copy(body.quaternion).invert();
    _wo.copy(omega).applyQuaternion(_iq);
    _ao.copy(omega).sub(prevOmega).divideScalar(h).applyQuaternion(_iq);
    // Linear acceleration over the step (velocity change / step), in the body's frame.
    _al.copy(linAccel).divideScalar(step).applyQuaternion(_iq);
    linAccel.set(0, 0, 0);
    inertia.cx = shape.center[0];
    inertia.cy = shape.center[1];
    inertia.cz = shape.center[2];
    inertia.s = scale;
    const presses = [];
    gesturePresses(step, presses);
    waves.step(step, presses, inertialAt, 0.6 * film, 1.2 * film);
    waves.upload();
  }
  const centre = body.localToWorld(_c.fromArray(shape.center));

  const u = water.uniforms;
  u.film.value = film + look.swell;
  u.smoothK.value = smoothness();
  u.ior.value = params.ior();
  u.pooling.value = params.pooling();
  u.maxSteps.value = water.scale < 1 ? Math.min(params.steps(), 110) : params.steps();

  blobList.length = 0;
  for (const b of parcels.list) blobList.push([b.p, b.r, b.axis, b.stretch]);
  tendrilBlobs(blobList);
  // The water reaches past the body by the coat, its highest crest and the tallest ripple.
  let reach = shape.radius * scale + film * 2.2 + smoothness() + GESTURE.ripple * params.tapStrength();
  let count = 0;
  for (const [p, r, axis, stretch] of blobList) {
    if (count >= MAX_BLOBS) break;
    water.blobs[count].set(p.x, p.y, p.z, r);
    if (axis) u.blobShapes.value[count].set(axis.x, axis.y, axis.z, stretch);
    else u.blobShapes.value[count].set(0, 1, 0, 0);
    count++;
    reach = Math.max(reach, p.distanceTo(centre) + r * (1 + Math.abs(stretch ?? 0)) + smoothness());
  }
  const steep = updateRipples(time);
  u.stepScale.value = Math.max(0.3, 1 / (1 + waves.slope + steep));
  u.bound.value.set(centre.x, centre.y, centre.z, reach * 1.02);
  water.update(body, count);
  // Moving water, a panel change or a new shape all invalidate the paused still.
  const signature = Object.keys(defaults).map((k) => params[k]()).join() + shape.name;
  if (dt > 0 || signature !== lastSignature || transitioning()) pipeline.restartAccumulation(false);
  lastSignature = signature;

  orbit.update();
  if (showcase.zoom) {
    // The camera eases out when drops or tendrils reach far, and back in once they're home.
    const rest = shape.radius * scale + coat() * 2 + 0.25;
    let far = rest;
    // Drops flung far are let go rather than chased: the camera only widens by half at most.
    const reach = rest * 1.5;
    const near = (d) => (d <= reach ? d : rest);
    for (const b of parcels.list) far = Math.max(far, near(b.p.distanceTo(centre) + b.r));
    for (const t of tendrils) far = Math.max(far, near(t.tip.distanceTo(centre) + GESTURE.tendrilRadius));
    const want = showcase.base * Math.min(1.5, Math.max(1, far / rest));
    const dist = camera.position.distanceTo(orbit.target);
    // A critically damped spring on the distance, so the camera glides out and back without a kink.
    const kz = 3;
    showcase.zoomVel += ((want - dist) * kz - 2 * Math.sqrt(kz) * showcase.zoomVel) * dt;
    camera.position.sub(orbit.target).setLength(dist + showcase.zoomVel * dt).add(orbit.target);
  }
  pipeline.render(scene, camera, time);
});
