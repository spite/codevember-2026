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
  addActionButton,
  showSoundHint,
  onPause,
  isRunning,
  loadSeed,
} from "common";
import { GUI } from "guspira";
import { Scene, Vector2, Vector3, Color, Raycaster, Plane, MathUtils, Quaternion } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync, loadHDREnvironment, applyEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { createSound } from "./sound.js";
import { OrbitControls as FreeOrbitControls } from "modules/FreeOrbitControls.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { GlassCluster, PALETTES, prewarmDetail, TYPE_WEIGHTS } from "./physics.js";
import { GlassCompositeRenderer, GLASS_KEYS, envFadeUniforms } from "./render.js";

const BACKDROPS = {
  "HDR blurred": "#303438",
  "Warm studio": "#e8e3d9",
  "Deep slate": "#1c2228",
  "Soft mist": "#d4dce2",
  "Sandstone": "#dcd0be",
};

const QUALITY_COUNTS = { capture: 28, high: 24, medium: 18, low: 12 };
// Subdivisions of each piece's base sphere (20: about 4,400 vertices); finer meshes shade slower, in tiny triangles
const QUALITY_DETAIL = { capture: 32, high: 20, medium: 14, low: 12 };

const composite = new GlassCompositeRenderer();
const cluster = new GlassCluster();

const pipeline = new Pipeline(renderer, {
  background: BACKDROPS["HDR blurred"],
  exposure: 1.0,
  bloomStrength: 0.035,
  bloomRadius: 0.75,
  vignette: 0.22,
  grain: 0.02,
  saturation: 1.15,
  contrast: 1.04,
  shadow: false,
  gi: false,
  composite: (hdr, opts) => composite.render(renderer, hdr, opts, cluster.pieces),
});

const defaults = {
  count: QUALITY_COUNTS[pipeline.quality] ?? 24,
  palette: "Sea glass",
  backdrop: "HDR blurred",
  environment: "Umhlanga sunrise",
  bgBlur: 0.25,
  erosion: 0.85,
  patternWear: 0.7,
  // Glass properties are ranges: each piece takes its own value inside them
  frosting: [0.55, 0.88],
  wetness: [0.05, 0.3],
  diffusion: [0.65, 0.9],
  ior: [1.48, 1.56],
  refraction: [0.55, 0.75],
  dispersion: [0.28, 0.48],
  translucency: [0.62, 0.88],
  drift: 0.5,
  cameraSpeed: 0.08,
  shore: 0.5,
  // How often each kind of piece turns up in a new set
  ...Object.fromEntries(Object.entries(TYPE_WEIGHTS).map(([type, w]) => [`${type}Weight`, w])),
  auto: true,
  autoTime: 12,
};

const params = fromDefaults(defaults);
const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  glass: loadingStep(2, "Tumbling glass…"),
  compile: loadingStep(3, "Compiling shaders…"),
  sound: loadingStep(1, "Gathering clinks…"),
};

const hdrEnvPromise = load.studio.track(
  loadHDREnvironment(renderer, "../assets/studio_small_03_2k.hdr", { apply: false }).then((env) => {
    env.lightColor = new Color(3.8, 3.6, 3.3);
    return env;
  }),
);
const softboxEnvPromise = createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(-0.55, 0.85, 0.45),
  keyIntensity: 8.5,
  keySize: 0.55,
  fill: 0.55,
  floor: 0.45,
  wall: 0.6,
  apply: false,
});

// Beach HDRIs from Poly Haven (CC0), loaded when first chosen and prefetched once the page is up
// sun: where the sun sits in the panorama (u, v of its brightest pixel; v = 1 at the top), or null when overcast
const BEACHES = {
  "Mondello beach": { url: "hdr/spiaggia_di_mondello_1k.hdr", sun: [0.601, 0.64] },
  "Secluded cove": { url: "hdr/secluded_beach_1k.hdr", sun: [0.642, 0.677] },
  "Fish Hoek beach": { url: "hdr/fish_hoek_beach_1k.hdr", sun: null },
  "Umhlanga sunrise": { url: "hdr/umhlanga_sunrise_1k.hdr", sun: [0.6, 0.511] },
};

// A panorama position as a direction, by three's equirectangular mapping
function panoramaDirection([u, v]) {
  const phi = (u - 0.5) * Math.PI * 2;
  const theta = (v - 0.5) * Math.PI;
  return new Vector3(Math.cos(phi) * Math.cos(theta), Math.sin(theta), Math.sin(phi) * Math.cos(theta));
}
const ENVIRONMENTS = ["HDR Studio", "Softbox Studio", ...Object.keys(BEACHES)];
const luminance = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
const envs = { "HDR Studio": null, "Softbox Studio": null };
const envIntensity = { "HDR Studio": 1.15, "Softbox Studio": 1.0 };

// A beach at its own intensity; its key light keeps the studio's ratio to the ambient light, tinted by the sky.
function loadBeach(name) {
  envs[name] ??= loadHDREnvironment(renderer, BEACHES[name].url, { apply: false }).then(async (env) => {
    // The key light comes from the sun itself, not the sky's average brightest direction
    if (BEACHES[name].sun) env.lightDirection = panoramaDirection(BEACHES[name].sun);
    const studio = await hdrEnvPromise;
    envIntensity[name] = 1;
    const studioAmbient = luminance(studio.sh[0]) * envIntensity["HDR Studio"];
    const ambient = luminance(env.sh[0]) * envIntensity[name];
    const c = env.sh[0];
    env.lightColor = new Color(c.x, c.y, c.z).multiplyScalar((3.6 * ambient) / studioAmbient / Math.max(1e-4, luminance(c)));
    return env;
  });
  return envs[name];
}

// A change crossfades: the backdrop and reflections blend the outgoing map with the new one, and the ambient (SH) and
// key light ease from the old values to the new.
const ENV_FADE = 2.5;
const envFade = { t: 1, from: null, to: null };
async function selectEnvironment(name, fade = false) {
  const env = await (BEACHES[name] ? loadBeach(name) : envs[name]);
  if (!env || params.environment() !== name) return;
  const u = globalUniforms;
  const lighting = () => ({ sh: u.shIrradiance.value.map((v) => v.clone()), light: u.lightColor.value.clone(), dir: u.lightDirection.value.clone() });
  const from = fade && u.envMap.value ? lighting() : null;
  if (from) {
    envFadeUniforms.envMapPrev.value = u.envMap.value;
    envFadeUniforms.envMapMaxLodPrev.value = u.envMapMaxLod.value;
    envFadeUniforms.envIntensityPrev.value = u.envIntensity.value;
  }
  applyEnvironment(env);
  u.envIntensity.value = envIntensity[name];
  envFade.t = from ? 0 : 1;
  envFade.from = from;
  envFade.to = lighting();
  envFadeUniforms.uEnvFade.value = envFade.t;
}

function stepEnvFade(wallDt) {
  if (envFade.t >= 1) return;
  envFade.t = Math.min(1, envFade.t + wallDt / ENV_FADE);
  const e = envFade.t * envFade.t * (3 - 2 * envFade.t);
  const u = globalUniforms;
  const { from, to } = envFade;
  u.shIrradiance.value.forEach((v, i) => v.lerpVectors(from.sh[i], to.sh[i], e));
  u.lightColor.value.copy(from.light).lerp(to.light, e);
  u.lightDirection.value.lerpVectors(from.dir, to.dir, e).normalize();
  envFadeUniforms.uEnvFade.value = e;
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Palette", params.palette, Object.keys(PALETTES));
gui.addSelect("Backdrop", params.backdrop, Object.keys(BACKDROPS), { randomizable: false });
// Randomized only among the beaches (in onRandomize)
gui.addSelect("Environment", params.environment, ENVIRONMENTS, { randomizable: false });
gui.addSlider("BG blur", params.bgBlur, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Erosion", params.erosion, 0, 1, 0.01);
gui.addSlider("Pattern wear", params.patternWear, 0, 1, 0.01);
gui.addRangeSlider("Frosting", params.frosting, 0, 1, 0.01);
gui.addRangeSlider("Wetness", params.wetness, 0, 1, 0.01);
gui.addRangeSlider("Diffusion", params.diffusion, 0, 1, 0.01);
gui.addRangeSlider("IOR", params.ior, 1.33, 1.8, 0.01);
gui.addRangeSlider("Refraction", params.refraction, 0, 1, 0.01);
gui.addRangeSlider("Dispersion", params.dispersion, 0, 1, 0.01);
gui.addRangeSlider("Translucency", params.translucency, 0, 1, 0.01);
gui.addSlider("Drift", params.drift, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Camera speed", params.cameraSpeed, 0, 0.5, 0.01, { randomizable: false });
gui.addSlider("Shore", params.shore, 0, 1, 0.01, { randomizable: false });
// The set: how many pieces and how often each kind turns up (a change brings a new set with the same seed)
const PIECE_LABELS = {
  pebble: "Pebbles",
  bottle: "Bottle shards",
  shard: "Shards",
  bowl: "Bowl shards",
  fluted: "Pressed glass",
  marble: "Marbles",
  stopper: "Stoppers",
  ring: "Bottle necks",
  torus: "Tori",
  rod: "Canes",
};
gui.addSection("Pieces", { open: false });
gui.addSlider("Count", params.count, 8, 36, 1, { randomizable: false });
for (const type of Object.keys(TYPE_WEIGHTS)) gui.addSlider(PIECE_LABELS[type] ?? type, params[`${type}Weight`], 0, 10, 0.05, { randomizable: false });
gui.endSection();
const typeWeights = () => Object.fromEntries(Object.keys(TYPE_WEIGHTS).map((type) => [type, params[`${type}Weight`]()]));
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => !cluster.replacing });
pipeline.addGUI(gui);
addKey("KeyW", "toggle wireframe", () => (pipeline.wireframe = !pipeline.wireframe));
addKey("KeyM", "toggle sound", () => toggleSound());
gui.addSeparator();
gui.addText(keysHelp("Click/drag a piece to move it · drag space to orbit · scroll to zoom"));
showHint(
  "Drag a piece through the cluster · drag space to orbit · R for a new mix",
  "Drag a piece · drag space to orbit · tap {randomize} for a new mix",
);
gui.show();

const sound = createSound({ onProgress: load.sound.set, ambience: params.shore() * 0.6 });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.setPaused(!running));
showSoundHint(() => !sound.running);

// Contacts to sound, by how long they last: a short one (ending within SHORT seconds) is a pebble click when it ends
// (a tick when light), as loud as its hardest impact; a longer one grinds, first a short grind, then grinding strokes
// while it lasts. Panned by where it happens, quieter farther away, and budgeted so the cluster never chatters.
const SHORT = 0.15;
const contactState = new Map();
const soundPoint = new Vector3();
const CLICK_RATE = 1.6;
const CLICK_BURST = 2;
const GRIND_RATE = 1;
const GRIND_BURST = 2;
let clickBudget = CLICK_BURST;
let grindBudget = GRIND_BURST;
let budgetTime = performance.now() / 1000;
function contactSounds() {
  const now = performance.now() / 1000;
  clickBudget = Math.min(CLICK_BURST, clickBudget + (now - budgetTime) * CLICK_RATE);
  grindBudget = Math.min(GRIND_BURST, grindBudget + (now - budgetTime) * GRIND_RATE);
  budgetTime = now;
  for (const { a, b, point, impact, slide } of cluster.takeContacts()) {
    const key = `${a.mesh.id}:${b.mesh.id}`;
    let c = contactState.get(key);
    if (!c) contactState.set(key, (c = { start: now, impact: 0, slide: 0, grinds: 0, nextGrind: 0, a, b, point: point.clone() }));
    c.seen = now;
    c.impact = Math.max(c.impact, impact);
    c.slide = Math.max(c.slide * 0.9, slide);
    c.point.copy(point);
  }
  for (const [key, c] of contactState) {
    soundPoint.copy(c.point).project(camera);
    const pan = Math.max(-1, Math.min(1, soundPoint.x)) * 0.8;
    // Loudness by distance relative to the framed view, so a farther fit for a bigger set doesn't quieten everything
    const near = Math.min(1.3, Math.max(0.45, (0.8 * (fit.distance || 9)) / camera.position.distanceTo(c.point)));
    const length = c.seen - c.start;
    // A contact ends once it hasn't been seen for a few frames
    if (now - c.seen > 0.06) {
      contactState.delete(key);
      if (length < SHORT && c.impact > 0.02 && (clickBudget >= 1 || c.impact > 0.15)) {
        clickBudget = Math.max(0, clickBudget - 1);
        const rate = 1.4 * Math.min(1.15, Math.max(0.85, 0.7 / Math.sqrt((c.a.radius + c.b.radius) / 2)));
        const gain = Math.pow(Math.min(1, (c.impact - 0.01) / 0.25), 0.7) * 0.55 * near;
        sound.play(c.impact < 0.035 ? "tick" : "clink", { gain, pan, rate });
      }
      continue;
    }
    if (length < SHORT || now < c.nextGrind || grindBudget < 1) continue;
    // Still touching: a short grind first, then strokes every so often while it lasts and keeps moving
    const level = Math.min(1, Math.max(c.impact, c.slide) / 0.25);
    if (c.grinds === 0) {
      grindBudget -= 1;
      sound.play("scrape", { gain: (0.17 + 0.35 * level) * near, pan, rate: 0.9 + 0.3 * level });
      c.grinds++;
      c.nextGrind = c.start + 0.5;
    } else if (c.slide > 0.04) {
      grindBudget -= 1;
      sound.play("grind", { gain: (0.15 + 0.35 * level) * near, pan, rate: 0.9 + 0.3 * level, duration: 1 });
      c.grinds++;
      c.nextGrind = now + 1.1;
    }
  }
}

const scene = new Scene();
const viewRight = new Vector3();
const viewUp = new Vector3();
const viewForward = new Vector3();
const turn = new Quaternion();
const driftRight = new Vector3();
let driftTime = 0;
// Yaw and pitch offsets (radians) and a distance factor: incommensurate slow sines, so the drift never visibly repeats
function drift(t) {
  const w = (period) => (t * Math.PI * 2) / period;
  return {
    yaw: 0.35 * Math.sin(w(48)) + 0.1 * Math.sin(w(17) + 1.3),
    pitch: 0.06 * Math.sin(w(31) + 0.7),
    distance: 1 + 0.05 * Math.sin(w(37) + 2.1),
  };
}
const bgColor = new Color(BACKDROPS[params.backdrop()]);
const bgTarget = bgColor.clone();

const START_DISTANCE = 9;
camera.position.set(0, 0.8, START_DISTANCE);

// Framing: the cluster's centre and radius (90th-percentile piece reach, so one stray piece doesn't zoom out), and
// the distance that fits that radius in the narrower of the two angles of view
const FIT_MARGIN = 1.2;
const fit = { center: new Vector3(), radius: 0, distance: 0, ready: false };
const fitCenter = new Vector3();
function measureCluster() {
  const settled = cluster.pieces.filter((p) => !p.anim);
  if (settled.length < 3) return false;
  fitCenter.set(0, 0, 0);
  for (const p of settled) fitCenter.add(p.pos);
  fitCenter.divideScalar(settled.length);
  const reach = settled.map((p) => p.pos.distanceTo(fitCenter) + p.visualRadius).sort((a, b) => a - b);
  return reach[Math.min(reach.length - 1, Math.floor(reach.length * 0.9))];
}
function fitDistance(radius) {
  const half = MathUtils.degToRad(camera.fov) / 2;
  const narrow = Math.min(half, Math.atan(Math.tan(half) * camera.aspect));
  return (radius * FIT_MARGIN) / Math.sin(narrow);
}
// The shared orbit locks at the poles; this one turns the camera's up with it, so it orbits freely over and under the
// floating glass.
sharedControls.dispose();
const controls = new FreeOrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 2.5;
controls.maxDistance = 14;
onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

let lastPalette = params.palette();
let lastBackdrop = params.backdrop();
let lastEnv = params.environment();
let lastShore = params.shore();
let initialSeed = null;

// Each piece carries its own look; R gives the new one to the pieces that replace the old ones.
const currentLook = () => ({
  ...Object.fromEntries(GLASS_KEYS.map((key) => [key, [...params[key]()]])),
  erosion: params.erosion(),
  patternWear: params.patternWear(),
});
let appliedLook = JSON.stringify(currentLook());
const meshDetail = () => QUALITY_DETAIL[pipeline.quality] ?? 20;

const clusterSeed = (seed) => Math.floor(seededRandom(`day19:${seed}`)() * 1e6);
const remap = (param, lo, hi) => param.set(Number((lo + param() * (hi - lo)).toFixed(2)));
const remapRange = (param, lo, hi) => param.set(param().map((v) => Number((lo + v * (hi - lo)).toFixed(2))));

onRandomize((seed) => {
  gui.randomizeAll();
  // Keep the rerolls in the ranges that still read as sea glass.
  remap(params.erosion, 0.45, 1);
  remapRange(params.frosting, 0.45, 0.95);
  remapRange(params.wetness, 0, 0.55);
  remapRange(params.diffusion, 0.55, 0.97);
  remap(params.patternWear, 0.2, 0.95);
  // A new mix of kinds: the common ones vary freely (one or two tend to dominate), the oddities stay rare except, in
  // about a third of the sets, one that turns up as the find
  const COMMON = ["pebble", "bottle", "shard", "bowl", "fluted"];
  const RARE = ["marble", "stopper", "ring", "torus", "rod"];
  for (const type of COMMON) params[`${type}Weight`].set(Number((0.3 + 9.7 * Math.random() ** 1.5).toFixed(2)));
  for (const type of RARE) params[`${type}Weight`].set(Number((0.6 * Math.random()).toFixed(2)));
  if (Math.random() < 0.33) params[`${RARE[Math.floor(Math.random() * RARE.length)]}Weight`].set(Number((2 + 4 * Math.random()).toFixed(2)));
  const beaches = Object.keys(BEACHES);
  params.environment.set(beaches[Math.floor(Math.random() * beaches.length)]);
  appliedLook = JSON.stringify(currentLook());
  lastPalette = params.palette();
  // On load the first set is built at once; afterwards a new set replaces the old one piece by piece
  if (!cluster.pieces.length) {
    initialSeed = clusterSeed(seed);
    return;
  }
  sweepIn(clusterSeed(seed));
});

// A wave takes the set away across the screen, and its backwash brings the new one, broken, to erode
function sweepIn(seed) {
  camera.updateMatrixWorld();
  const across = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const side = nativeRandom() < 0.5 ? -1 : 1;
  const dir = across.multiplyScalar(side).addScaledVector(up, (nativeRandom() - 0.5) * 0.6).normalize();
  sweepPan = side * 0.5;
  cluster.typeWeights = typeWeights();
  appliedWeights = JSON.stringify(cluster.typeWeights);
  cluster.startSweep({
    drift: params.drift(),
    count: Math.round(params.count()),
    paletteName: params.palette(),
    seed,
    detail: meshDetail(),
    look: currentLook(),
    dir,
    ...sweepTiming,
  });
}
// How fast a sweep runs and how long the new set rests and wears down (recordings speed these up)
const sweepTiming = { pace: 1, hold: 1.5, erodeTime: 9 };
let appliedWeights = JSON.stringify(typeWeights());
let weightsChangedAt = 0;
let sweepPan = 0;
// The wave rushing in, then its backwash as the new set arrives: overlapping cuts of one stretch of surf, so they join
cluster.onSweep = (phase) => sound.play(phase === "in" ? "wavein" : "waveout", { gain: 0.75, pan: phase === "in" ? sweepPan : -sweepPan });

// Time between replacements, so a whole set changes over most of the auto-change interval
const replaceSpacing = () => Math.min(1, Math.max(0.25, (params.autoTime() * 0.9) / Math.max(1, params.count())));

// Pointer drag / click interaction on suspended pieces
const raycaster = new Raycaster();
const pointer = new Vector2();
const dragPlane = new Plane();
const dragHit = new Vector3();
const camDir = new Vector3();
let pointerDownPos = new Vector2();
let activePointerId = null;

function updatePointer(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  // While paused a drag anywhere orbits the camera, pieces included
  if (e.button !== 0 || !isRunning()) return;
  updatePointer(e);
  pointerDownPos.set(e.clientX, e.clientY);
  raycaster.setFromCamera(pointer, camera);
  const meshes = cluster.pieces.map((p) => p.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length > 0) {
    const hitMesh = hits[0].object;
    const piece = cluster.pieces.find((p) => p.mesh === hitMesh);
    if (piece) {
      activePointerId = e.pointerId;
      cluster.grab(piece, hits[0].point);
      controls.enabled = false;
      camera.getWorldDirection(camDir);
      dragPlane.setFromNormalAndCoplanarPoint(camDir, hits[0].point);
    }
  }
});

window.addEventListener("pointermove", (e) => {
  if (!cluster.grabbed || e.pointerId !== activePointerId) return;
  updatePointer(e);
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragHit)) {
    cluster.grabTarget.copy(dragHit);
  }
});

function releaseGrab(e) {
  if (e.pointerId !== activePointerId) return;
  if (cluster.grabbed) {
    const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (moved < 6) {
      camera.getWorldDirection(camDir);
      cluster.nudge(cluster.grabbed, camDir);
    }
  }
  cluster.grabbed = null;
  activePointerId = null;
  controls.enabled = true;
}

window.addEventListener("pointerup", releaseGrab);
window.addEventListener("pointercancel", releaseGrab);

applyUrlState();
load.glass.track(
  Promise.resolve().then(() => {
    prewarmDetail(meshDetail());
    cluster.typeWeights = typeWeights();
    appliedWeights = JSON.stringify(cluster.typeWeights);
    cluster.build(Math.round(params.count()), params.palette(), initialSeed ?? clusterSeed(getSeed()), meshDetail(), currentLook());
    bgColor.set(BACKDROPS[params.backdrop()] ?? BACKDROPS["Warm studio"]);
    bgTarget.copy(bgColor);
    composite.settings.envMix = params.backdrop() === "HDR blurred" ? 1 : 0;
    composite.settings.bgBlur = params.bgBlur();
  }),
);

const [hdrEnv, softboxEnv] = await Promise.all([hdrEnvPromise, softboxEnvPromise]);
envs["HDR Studio"] = hdrEnv;
envs["Softbox Studio"] = softboxEnv;
if (BEACHES[params.environment()]) await load.studio.track(loadBeach(params.environment()));
await selectEnvironment(params.environment());
// Start facing the sun: the camera on the far side of the glass from it, a little above, so the sun sits behind the
// cluster and lights it from the back
{
  const sun = globalUniforms.lightDirection.value;
  const away = new Vector3(-sun.x, 0, -sun.z);
  const radius = measureCluster();
  if (radius) {
    fit.center.copy(fitCenter);
    fit.radius = radius;
    fit.ready = true;
    controls.target.copy(fit.center);
  }
  const distance = fit.ready ? fitDistance(fit.radius) : START_DISTANCE;
  fit.distance = distance;
  if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
  camera.position.copy(away.normalize()).setY(0.09).normalize().multiplyScalar(distance).add(controls.target);
  camera.lookAt(controls.target);
}
lastEnv = params.environment();

await load.sound.track(sound.downloaded);
await load.compile.track(
  Promise.all([pipeline.compileAsync(scene, camera), composite.compileAsync(renderer, camera, cluster.pieces[0].mesh.geometry)]),
  3,
);

window.app = {
  canvas: renderer.domElement,
  scene,
  params,
  pipeline,
  camera,
  controls,
  cluster,
  composite,
  sound,
  sweepTiming,
  // Recordings: every asset a set can use, and a jump to a seed (its set comes in with a wave)
  preload: () => Promise.all([sound.decoded, ...Object.keys(BEACHES).map(loadBeach)]),
  nextLook: (pick) => loadSeed(pick?.seed ?? String(Math.floor(nativeRandom() * 1e9))),
  // For tools/perf: the glass composite's stages as their own segments
  perfSegments: (wrap) => {
    wrap(composite, "render", "post.composite");
    wrap(composite, "buildPyramid", "post.pyramid");
    wrap(composite, "beginLayer", "post.copy");
    wrap(composite, "drawThickness", "post.thick");
    wrap(composite, "shadePiece", "post.glass");
  },
};
// Fetch the beach HDRIs into the cache once the page is up, so choosing one never waits on the network
setTimeout(() => Object.values(BEACHES).forEach(({ url }) => fetch(url).catch(() => {})), 2000);

let lastWall = performance.now();

render(({ time, dt }) => {
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWall) * 0.001);
  lastWall = now;

  autoChange.update(dt);

  // Pieces slider: add or remove pieces the same way, once nothing else is changing
  const count = Math.round(params.count());
  if (!cluster.replacing && count !== cluster.pieces.length) {
    cluster.startReplacement({
      count,
      paletteName: params.palette(),
      seed: Math.floor(nativeRandom() * 1e6),
      detail: meshDetail(),
      look: currentLook(),
      replaceAll: false,
      spacing: replaceSpacing(),
    });
  }
  camera.updateMatrixWorld();
  cluster.stepReplacement(dt, 5, {
    position: camera.position,
    forward: camera.getWorldDirection(viewForward),
    right: viewRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize(),
    up: viewUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize(),
    tanHalf: Math.tan(MathUtils.degToRad(camera.fov) / 2),
    aspect: camera.aspect,
  });
  // Piece weights moved by hand: once they settle for a second, a wave brings a set with the new mix (same seed)
  const weightsKey = JSON.stringify(typeWeights());
  if (weightsKey !== appliedWeights) {
    if (!weightsChangedAt) weightsChangedAt = now;
    if (now - weightsChangedAt > 1000 && !cluster.replacing) {
      weightsChangedAt = 0;
      sweepIn(clusterSeed(getSeed()));
    }
  } else weightsChangedAt = 0;
  // A slider moved by hand applies to every piece
  const lookKey = JSON.stringify(currentLook());
  if (lookKey !== appliedLook) {
    appliedLook = lookKey;
    cluster.setLookTarget(currentLook());
  }
  if (params.palette() !== lastPalette) {
    lastPalette = params.palette();
    cluster.setPalette(lastPalette, false);
  }
  if (params.backdrop() !== lastBackdrop) {
    lastBackdrop = params.backdrop();
    bgTarget.set(BACKDROPS[lastBackdrop] ?? BACKDROPS["Warm studio"]);
  }
  if (params.environment() !== lastEnv) {
    lastEnv = params.environment();
    selectEnvironment(lastEnv, true);
  }
  stepEnvFade(wallDt);

  // Wall-clock easing for all visual parameters so changes show while paused; the backdrop fades slowly
  const k = 1 - Math.exp(-wallDt * 6);
  const kBackdrop = 1 - Math.exp(-wallDt * 0.9);
  const s = composite.settings;
  cluster.easeLooks(k);
  s.envMix += ((params.backdrop() === "HDR blurred" ? 1 : 0) - s.envMix) * kBackdrop;
  s.wireframe = pipeline.wireframe;
  s.bgBlur += (params.bgBlur() - s.bgBlur) * k;

  bgColor.lerp(bgTarget, kBackdrop);
  pipeline.background = bgColor;

  if (params.shore() !== lastShore) sound.setAmbience((lastShore = params.shore()) * 0.6);
  cluster.update(dt, wallDt, time, { drift: params.drift() });
  contactSounds();
  // While new pieces wear down: grinding and water, swelling in as they start and fading as they come out smooth;
  // the grind rises a little in pitch as it gets finer
  {
    const { activity, progress } = cluster.erosionActivity;
    const s0 = Math.min(1, progress / 0.06);
    const s1 = Math.min(1, Math.max(0, (progress - 0.75) / 0.25));
    const level = activity * s0 * s0 * (3 - 2 * s0) * (1 - s1 * s1 * (3 - 2 * s1));
    sound.setBed("erode-grind", level * 0.5, 0.85 + 0.35 * progress);
    sound.setBed("erode-water", level * 0.55, 1);
  }

  // A calm drift around the view: a slow sway, rise and fall and breathing in distance (Camera speed sets its pace),
  // applied as the change since last frame so it adds to the visitor's own orbiting
  if (dt > 0 && params.cameraSpeed() > 0 && !cluster.grabbed) {
    const before = drift(driftTime);
    driftTime += dt * (params.cameraSpeed() / 0.08);
    const after = drift(driftTime);
    const offset = camera.position.sub(controls.target);
    turn.setFromAxisAngle(camera.up, after.yaw - before.yaw);
    offset.applyQuaternion(turn);
    turn.setFromAxisAngle(driftRight.crossVectors(camera.up, offset).normalize(), before.pitch - after.pitch);
    offset.applyQuaternion(turn).multiplyScalar(after.distance / before.distance);
    camera.position.copy(offset).add(controls.target);
  }

  // Follow the cluster: ease its centre and fitted distance over a few seconds, applied as the change since last frame
  // so the visitor's own orbit and zoom stay on top
  {
    // Holds while a set is coming or going, so a half-arrived set doesn't pull the view in
    const radius = cluster.replacing ? 0 : measureCluster();
    if (radius) {
      if (!fit.ready) {
        fit.center.copy(fitCenter);
        fit.radius = radius;
        fit.ready = true;
        fit.distance = camera.position.distanceTo(controls.target);
      }
      const k = 1 - Math.exp(-wallDt / 2.5);
      const shift = fitCenter.sub(fit.center).multiplyScalar(k);
      fit.center.add(shift);
      fit.radius += (radius - fit.radius) * k;
      // A resize changes the fitted distance at once
      const after = fitDistance(fit.radius);
      const offset = camera.position.sub(controls.target).multiplyScalar(after / fit.distance);
      fit.distance = after;
      controls.target.add(shift);
      camera.position.copy(offset).add(controls.target);
      controls.maxDistance = Math.max(14, after * 1.8);
    }
  }

  controls.update();
  pipeline.render(scene, camera, time);
});
