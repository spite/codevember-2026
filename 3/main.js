import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, addKey, showHint, loadingStep } from "common";
import { getSeed } from "modules/random.js";
import { GUI } from "guspira";
import { createAutoChange } from "modules/autoChange.js";
import { Scene, Mesh, Vector3, Vector2, Sphere, Raycaster, Matrix4, Quaternion, IcosahedronGeometry, InstancedBufferGeometry, BufferGeometry, BufferAttribute } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { loadReflections } from "./reflections.js";
import { bakeReflectionEnv } from "./reflectionEnv.js";
import { createBackdrop } from "./backdrop.js";
import { SHAPES, loadShape, prefetchShapes } from "./shapeAsset.js";
import { FINISHES, applyFinish, lookUniforms, createBodyMaterial, createDropMaterial, createPuddleMaterial } from "./materials.js";
import { createRotation, MOTION_MODES } from "./rotation.js";
import { createField } from "./field.js";
import { createBlobs } from "./blobs.js";
import { createTrails } from "./trails.js";
import { createSurfaceWalk, projectFacing } from "./surfaceWalk.js";
import { createPendants, pendantLayout } from "./pendants.js";
import { createDrops } from "./drops.js";
import { createPuddle } from "./puddle.js";
import { createBodyBake } from "./bake.js";
import { dropTables } from "./dropShape.js";

// Backdrop colour, its specular, exposure, and the reflection studio that matches it.
const SETS = {
  Light: { color: "#d8d5cf", specular: 1, exposure: 1.55, env: { floor: 0.6, horizon: 0.5, wall: 0.4, ceiling: 0.06, flag: 0.015, rimIntensity: 3 } },
  Dark: { color: "#0e0e0f", specular: 0.2, exposure: 1.1, env: { floor: 0.025, horizon: 0.022, wall: 0.02, ceiling: 0.004, flag: 0, keyIntensity: 28, rimIntensity: 12, strip: 2.5 } },
};

const defaults = {
  shape: "Suzanne",
  finish: "Lacquer",
  amount: 0.4,
  viscosity: 0.5,
  size: 0.5,
  dripLength: 0.5,
  motion: "Rock",
  spin: 0.12,
  height: 1.8,
  set: "Light",
  reflections: "auto",
  auto: true,
  autoTime: 15,
};

const params = fromDefaults(defaults);

const FLOOR_Y = -1.8;
const WARM_SECONDS = 6;
const SUBSTEP = 1 / 60;
const CAMERA_MAX = 14;
// Occluder sphere over the shape's bounding radius.
const OCCLUDER_BODY = 0.75;
const touch = matchMedia("(pointer: coarse)").matches;

const pipeline = new Pipeline(renderer, {
  background: SETS.Light.color,
  exposure: SETS.Light.exposure,
  bloomStrength: 0.015,
  vignette: 0.2,
  grain: 0.025,
  shadow: { autoFit: false, denoise: true },
  motionBlur: { shutter: 1 / 60, maxBlur: 0.015, samples: 32 },
  giOptions: { thickness: 0.6 },
});
const lite = ["low", "medium"].includes(pipeline.quality);
if (lite) pipeline.motionBlur = false;
pipeline.gi.radius = 1.4;
globalUniforms.giIntensity.value = 1.1;
globalUniforms.aoIntensity.value = 1;
globalUniforms.aoPower.value = 1.4;
globalUniforms.aoDirect.value = 0.35;
globalUniforms.aoColor.value.setRGB(0.02, 0.02, 0.022);
globalUniforms.aoMin.value = 0.06;

const KEY_DIRECTION = new Vector3(-0.5, 0.9, 0.55);
const studio = createStudioEnvironmentAsync(renderer, {
  keyDirection: KEY_DIRECTION,
  keyIntensity: 20,
  keySize: 0.4,
  fill: 0.15,
  fillColor: 0xfaf4ec,
  floor: 0.3,
  wall: 0.35,
  ceiling: 0.02,
  tint: 0xfffaf3,
  size: 512,
});

// Reflection-only envs: a softbox studio matched to the set (baked on first use), the studio HDR (loaded when first
// picked), or the lit studio itself. Diffuse light, key and shadows always come from the lit studio.
const envs = {};
studio.then((env) => (envs.studio = { envMap: env.envMap, maxLod: Math.max(env.envMap.mipmaps.length - 1, 0) })).catch(() => {});
let hdrLoad = null;
function loadHdr(onProgress) {
  return (hdrLoad ??= studio
    .then((env) => loadReflections(renderer, "../assets/studio_small_03_2k.hdr", { keyDirection: KEY_DIRECTION, match: env.envMap, onProgress }))
    .then((env) => {
      envs.hdr = env;
      lookKey = "";
    })
    .catch((e) => console.warn("Reflections unavailable", e)));
}

// surround scales the floor, horizon, wall and ceiling; the key, rim and flags stay as they are.
function softboxEnv(set, surround = 1, horizon, cards) {
  const env = { ...SETS[set].env };
  for (const k of ["floor", "horizon", "wall", "ceiling"]) env[k] *= surround;
  // A bright horizon band draws an edge line along every blob slope on black.
  if (horizon) env.horizon = horizon[set];
  if (cards) env.cards = cards;
  return (envs[`softbox ${set} ${surround} ${env.horizon} ${!!cards}`] ??= bakeReflectionEnv(renderer, { keyDirection: KEY_DIRECTION, size: lite ? 256 : 512, ...env }));
}

function updateReflections() {
  const finish = FINISHES[params.finish()];
  const choice = params.reflections() === "auto" ? finish.reflections : params.reflections();
  if (choice === "hdr" && !envs.hdr) loadHdr();
  const env = choice === "softbox" ? softboxEnv(params.set(), finish.surround, finish.horizon, finish.cards) : envs[choice] ?? envs.studio;
  if (!env) return;
  globalUniforms.envMap.value = env.envMap;
  globalUniforms.envMapMaxLod.value = env.maxLod;
}

const scene = new Scene();

const backdrop = createBackdrop({ floorY: FLOOR_Y, color: SETS.Light.color });
scene.add(backdrop.mesh);

const field = createField({ lite, quality: pipeline.quality });
// Hanging pools are part of the body surface; each melt brings its own pool texture.
const poolUniforms = { poolTex: { value: null }, poolCount: { value: 0 } };
const pools = { defines: pendantLayout(lite).defines, uniforms: poolUniforms };
const bake = createBodyBake(field, pools);
// Until the shape loads, an empty stand-in with the same attributes, so programs compile as they will be used.
const placeholder = new BufferGeometry();
placeholder.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
placeholder.setAttribute("normal", new BufferAttribute(new Float32Array(0), 3));
const body = new Mesh(placeholder, createBodyMaterial(field, pools, bake));
body.userData.shutterManual = true;
body.userData.noWireframe = true;
body.userData.shutterMatrixWorld = body.matrixWorld.clone();
scene.add(body);
// Wireframe: the same displaced mesh drawn as translucent edges over the body.
const wire = new Mesh(placeholder, createBodyMaterial(field, pools, bake, { wire: true }));
wire.material.wireframe = true;
wire.material.depthWrite = false;
wire.visible = false;
wire.renderOrder = 1;
wire.userData.noWireframe = true;
body.add(wire);

// Falling drops and the puddle they land in, in world space.
const puddle = createPuddle({ lite, floorY: FLOOR_Y });
const drops = createDrops({ lite, floorY: FLOOR_Y, puddle });
const dropGeometry = new InstancedBufferGeometry().copy(new IcosahedronGeometry(1, 3));
dropGeometry.instanceCount = 0;
const dropMesh = new Mesh(dropGeometry, createDropMaterial(drops));
dropMesh.frustumCulled = false;
dropMesh.userData.shutterManual = true;
dropMesh.userData.shutterMatrixWorld = dropMesh.matrixWorld.clone();
scene.add(dropMesh);
const puddleMesh = new Mesh(puddle.createGeometry(), createPuddleMaterial(puddle));
puddleMesh.userData.noShadow = true;
scene.add(puddleMesh);

const rotation = createRotation({
  body,
  camera,
  controls,
  domElement: renderer.domElement,
  radius: () => (shape ? shape.radius * SHAPES[shape.name].scale : 1),
  mode: params.motion,
  spin: params.spin,
  shutter: () => pipeline.shutter,
  hit: hitBody,
  press: {
    start: (h) => melt?.blobs.press(h),
    release: (seconds) => melt?.blobs.release(seconds),
    cancel: () => melt?.blobs.cancel(),
  },
});

// Pointer → walk state on the body under it (object space), or null on a miss, including through the torus hole.
const raycaster = new Raycaster();
const _ndc = new Vector2();
const _inv = new Matrix4();
function hitBody(x, y) {
  if (!shape || !melt || shape.name !== shapeRequest) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.set(((x - rect.left) / rect.width) * 2 - 1, 1 - ((y - rect.top) / rect.height) * 2);
  raycaster.setFromCamera(_ndc, camera);
  _inv.copy(body.matrixWorld).invert();
  const { origin, direction } = raycaster.ray;
  origin.applyMatrix4(_inv);
  direction.transformDirection(_inv);
  const t = shape.sdf.raycast(origin, direction);
  if (t < 0) return null;
  origin.addScaledVector(direction, t);
  return projectFacing(melt.walk, origin, direction);
}

// ---------------------------------------------------------------- GUI

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Shape", params.shape, Object.keys(SHAPES));
gui.addSelect("Finish", params.finish, Object.keys(FINISHES));
gui.addSlider("Amount", params.amount, 0, 1, 0.01);
gui.addSlider("Viscosity", params.viscosity, 0, 1, 0.01);
gui.addSlider("Size", params.size, 0, 1, 0.01);
gui.addSlider("Drip length", params.dripLength, 0, 1, 0.01);
gui.addButton("Reset melt", resetMelt);
gui.addSelect("Motion", params.motion, MOTION_MODES, { randomizable: false });
gui.addSlider("Spin", params.spin, 0, 0.6, 0.01, { randomizable: false });
gui.addButton("Flip", () => rotation.flip());
gui.addSlider("Height", params.height, 1.0, 2.6, 0.01, { randomizable: false });
gui.addSelect("Set", params.set, Object.keys(SETS));
gui.addSelect("Reflections", params.reflections, ["auto", "softbox", "hdr", "studio"], { randomizable: false });
// Counts once a new shape has loaded.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => shape?.name === shapeRequest });
pipeline.addGUI(gui);
gui.addSeparator();
addKey("KeyT", "turn the object over", () => rotation.flip());
addKey("KeyM", "reset the melt", resetMelt);
addKey("KeyW", "toggle wireframe", () => (pipeline.wireframe = !pipeline.wireframe));
const help = "Hold on the object to grow a blob, tap to drop one, drag it to turn, drag elsewhere to orbit, pinch to zoom.";
gui.addText(touch ? help : `${help}<br/>${keysHelp()}`);
showHint("Hold on the object to grow a blob · drag it to turn · R for a new one", "Hold to grow a blob · tap {randomize} for a new one");
gui.show();

// ---------------------------------------------------------------- shape

let shape = null;
let shapeExtent = 0.99;
let melt = null;
let shapeRequest = null;

// The melt simulation for one shape: blobs and trails (later pendants, drops, puddle) stepped at a fixed rate
// and packed into the field.
function createMelt(next, walk = createSurfaceWalk(next.walk, next.topology())) {
  const seed = getSeed();
  const trails = createTrails({ maxTrails: field.MAXT, points: field.P });
  const blobs = createBlobs(walk, { lite, maxBlobs: field.MAXB, seed, trails });
  const pendants = createPendants({ lite, walk, field, sdf: next.sdf, blobs, drops, seed, floorY: FLOOR_Y });
  drops.reset();
  puddle.reset();
  blobs.setPendants(pendants);
  poolUniforms.poolTex.value?.dispose();
  poolUniforms.poolTex.value = pendants.tex;
  const gObj = [0, -1, 0];
  const eye = [0, 0, 1];
  const key = [0, 1, 0];
  const eyeV = new Vector3();
  const inv = new Quaternion();
  const maxSteps = lite ? 2 : 3;
  let acc = 0;
  const timing = { step: 0, pack: 0, drops: 0 };

  // World down and the directions to the camera and the key light, in object space.
  function orient(body) {
    inv.copy(body.quaternion).invert();
    const v = eyeV.set(0, -1, 0).applyQuaternion(inv);
    gObj[0] = v.x;
    gObj[1] = v.y;
    gObj[2] = v.z;
    v.copy(KEY_DIRECTION).normalize().applyQuaternion(inv);
    key[0] = v.x;
    key[1] = v.y;
    key[2] = v.z;
    body.worldToLocal(eyeV.copy(camera.position)).normalize();
    eye[0] = eyeV.x;
    eye[1] = eyeV.y;
    eye[2] = eyeV.z;
  }

  return {
    seed,
    cold: true,
    walk,
    blobs,
    trails,
    pendants,
    drops,
    puddle,
    timing,
    params() {
      blobs.params.amount = pendants.params.amount = params.amount();
      blobs.params.viscosity = trails.params.viscosity = pendants.params.viscosity = params.viscosity();
      blobs.params.size = pendants.params.size = params.size();
      blobs.params.dripLength = pendants.params.dripLength = params.dripLength();
    },
    warm(body) {
      this.cold = false;
      orient(body);
      // Upright (as on load): fixed gravity, key and eye, so a ?seed= gives the same melt at any size or aspect.
      if (Math.abs(body.quaternion.w) > Math.cos(0.025)) {
        gObj.splice(0, 3, 0, -1, 0);
        key.splice(0, 3, ...KEY_DIRECTION.clone().normalize().toArray());
        eye.splice(0, 3, ...view.toArray());
      }
      for (let t = 0, n = 0; t < WARM_SECONDS; t += 1 / 20, n++) {
        blobs.step(1 / 20, gObj, eye, key);
        trails.step(1 / 20);
        // The pendants read the dome apex from the packed field.
        if (n % 5 === 0) field.pack(blobs, trails, false, 0);
        // At the runtime substep, so the pools hang the same when the clock hands over.
        for (let k = 0; k < 3; k++) {
          pendants.step(SUBSTEP, body.matrixWorld, gObj);
          drops.step(SUBSTEP);
          puddle.step(SUBSTEP);
        }
      }
      blobs.resetPrev.fill(1);
      acc = SUBSTEP;
      field.prime();
      pendants.prime();
      drops.prime();
      puddle.prime();
    },
    step(dt, body) {
      const t0 = performance.now();
      timing.drops = 0;
      orient(body);
      acc = Math.min(acc + dt, (maxSteps + 1) * SUBSTEP);
      while (acc > SUBSTEP + 1e-6) {
        blobs.step(SUBSTEP, gObj, eye, key);
        trails.step(SUBSTEP);
        pendants.step(SUBSTEP, body.matrixWorld, gObj);
        const t1 = performance.now();
        drops.step(SUBSTEP);
        puddle.step(SUBSTEP);
        timing.drops += performance.now() - t1;
        acc -= SUBSTEP;
      }
      timing.step = performance.now() - t0;
    },
    upload(dt, body) {
      const t0 = performance.now();
      // Renders one substep behind, blended by the leftover time.
      const t = acc / SUBSTEP;
      const view = blobs.interpolate(t);
      field.pack(blobs, trails, dt > 0, pipeline.shutter, view);
      poolUniforms.poolCount.value = pendants.pack(view, t);
      dropGeometry.instanceCount = drops.pack(t, dt, pipeline.shutter);
      puddle.upload(dt > 0);
      timing.pack = performance.now() - t0;
    },
    reset() {
      blobs.reset();
      trails.reset();
      pendants.reset();
      drops.reset();
      puddle.reset();
      acc = SUBSTEP;
      field.prime();
    },
  };
}

async function setShape(name, onProgress) {
  shapeRequest = name;
  let next;
  try {
    // Densified on phones too: the hanging pools are drawn from the body's own vertices.
    next = await loadShape(name, { lite, densify: pipeline.quality !== "low", onProgress });
  } catch (e) {
    console.error(`Shape ${name} failed to load`, e);
    if (shapeRequest === name && shape) params.shape.set(shape.name);
    return;
  }
  if (shapeRequest !== name) return;
  shape = next;
  shapeExtent = horizontalExtent(next) * SHAPES[name].scale;
  field.setShape(next);
  lookUniforms.shapeSdf.value = next.sdf.texture;
  lookUniforms.shapeSdfMin.value.fromArray(next.sdf.min);
  lookUniforms.shapeSdfSize.value = next.sdf.size;
  melt = createMelt(next);
  body.geometry = wire.geometry = next.geometry;
  body.scale.setScalar(SHAPES[name].scale);
}

// Dry: the shape comes back clean and blobs seep in again; primes so the reset gives no velocity spike.
function resetMelt() {
  melt?.reset();
}

// Furthest the shape reaches from its vertical axis, over x and z since it spins.
function horizontalExtent(s) {
  const p = s.walk.attributes.position.array;
  let m = 0;
  for (let i = 0; i < p.length; i += 3) m = Math.max(m, Math.abs(p[i]), Math.abs(p[i + 2]));
  return m;
}

function bodyY() {
  return FLOOR_Y + params.height();
}

// Covers the body, the drips below it and its shadow on the floor; refit when Height or Shape changes.
let shadowKey = "";
function fitShadow() {
  const key = `${params.height()}|${params.shape()}`;
  if (key === shadowKey) return;
  shadowKey = key;
  const y = bodyY();
  pipeline.shadow.fit(new Sphere(new Vector3(0, (FLOOR_Y + y) / 2, 0), 0.5 * (y - FLOOR_Y) + 2));
}

// The body draws its own wireframe as an overlay; the pipeline's toggle wireframes the drops and puddle.
function updateWireframe() {
  wire.visible = pipeline.wireframe;
}

let lookKey = "";
let lookSet = "Light";
function updateLook() {
  const key = `${params.finish()}|${params.set()}|${params.reflections()}`;
  if (key === lookKey) return;
  lookKey = key;
  applyFinish(params.finish());
  updateReflections();
  const { color, specular, exposure } = SETS[params.set()];
  // Only a set change moves exposure, so the Rendering slider keeps working.
  if (params.set() !== lookSet) {
    lookSet = params.set();
    pipeline.exposure = exposure;
  }
  pipeline.background.set(color);
  backdrop.material.color.set(color);
  backdrop.material.uniforms.backdropSpecular.value = specular;
  document.querySelector("#loading")?.style.setProperty("--loading-background", color);
}

// The body, plus its largest bulbs and drops, darken what is under them: the floor pool and the puddle.
const occluderList = [];
const occluderOrder = [];
const _centre = new Vector3();
function updateOccluders() {
  const list = globalUniforms.occluders.value;
  let count = 0;
  if (shape) {
    const c = body.localToWorld(_centre.fromArray(shape.center));
    list[count++].set(c.x, c.y, c.z, OCCLUDER_BODY * shape.radius * body.scale.x);
  }
  if (melt) {
    occluderList.length = 0;
    const nb = melt.pendants.bulbs(occluderList);
    for (let i = 0; i < nb; i++) occluderList[i * 4 + 3] *= body.scale.x;
    melt.drops.largest(occluderList);
    const n = occluderList.length / 4;
    occluderOrder.length = n;
    for (let i = 0; i < n; i++) occluderOrder[i] = i;
    occluderOrder.sort((a, b) => occluderList[b * 4 + 3] - occluderList[a * 4 + 3]);
    for (let k = 0; k < Math.min(n, 8); k++) {
      const i = occluderOrder[k];
      list[count++].set(occluderList[i * 4], occluderList[i * 4 + 1], occluderList[i * 4 + 2], occluderList[i * 4 + 3]);
    }
  }
  for (let i = count; i < list.length; i++) list[i].set(0, 0, 0, 0);
  globalUniforms.occluderCount.value = count;
}

// ---------------------------------------------------------------- camera

camera.near = 0.3;
camera.far = 80;
const target = new Vector3();
const view = new Vector3(0.34, 0.26, 1).normalize();
// Portrait swings round towards the key so the shadow, cast to the right, stays in frame.
const viewPortrait = new Vector3(0.05, 0.26, 1).normalize();
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = CAMERA_MAX;
controls.minPolarAngle = Math.PI * 0.2;
controls.maxPolarAngle = Math.PI * 0.53;

// Frames the body and the floor below it for the puddle, at any aspect ratio; a user zoom is kept in proportion.
let fitted = 0;
function frame(w, h) {
  const t = Math.tan((camera.fov * Math.PI) / 360);
  const halfH = 0.5 * (params.height() + 1.3) + 0.3;
  // Wide shapes (Suzanne's ears) get more room.
  const halfW = (w < h ? 1.3 : 1.55) * Math.max(1, shapeExtent / 0.99);
  target.set(0, FLOOR_Y + 0.5 * (params.height() + 1), 0);
  const dir = camera.position.clone().sub(controls.target);
  const fit = Math.min(CAMERA_MAX, Math.max(halfH / t, halfW / (t * (w / h))));
  // Zooming in stops before the shape leaves the frame's narrower side.
  controls.minDistance = Math.max(3, (1.15 * shapeExtent) / Math.sin(Math.atan(t * Math.min(1, w / h))));
  const distance = fitted ? (dir.length() * fit) / fitted : fit;
  fitted = fit;
  dir.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, distance)));
  controls.target.copy(target);
  camera.position.copy(target).add(dir);
  camera.lookAt(target);
}

camera.position.copy(innerWidth < innerHeight ? viewPortrait : view);
let size = [1, 1];
onResize((w, h, dpr) => {
  size = [w, h];
  frame(w, h);
  pipeline.setSize(w, h, dpr);
});

let framedKey = "";
function updateFraming() {
  const key = `${params.height()}|${shapeExtent}`;
  if (key === framedKey) return;
  framedKey = key;
  frame(...size);
}

// ---------------------------------------------------------------- start

onRandomize(() => gui.randomizeAll());
// The url's seed and params first, so the first shape built and warmed is the one asked for.
applyUrlState();
// Load progress: the first shape, the studio, the studio HDR when it is picked, and the shader programs.
const load = { shape: loadingStep(3), studio: loadingStep(1), hdr: params.reflections() === "hdr" ? loadingStep(6) : null, compile: loadingStep(4) };

// Programs don't depend on the shape or the envs, so they compile while those load.
const compiled = load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), bake.compileAsync(renderer)]), 4);
updateLook();
await load.shape.track(setShape(params.shape(), load.shape.set));
await load.studio.track(studio);
lookKey = "";
updateLook();
if (load.hdr) await load.hdr.track(loadHdr(load.hdr.set));
// The pools' profile tables, built while the GPU compiles rather than on the first frame.
dropTables();
await compiled;

window.app = { canvas: renderer.domElement, camera, pipeline, controls, body, dropMesh, puddleMesh, drops, puddle, rotation, backdrop, scene, params, field, setShape, resetMelt, hit: hitBody, get shape() { return shape; }, get melt() { return melt; } };

let wasPaused = false;
render(({ time, dt, frame }) => {
  // The other shapes download once the first frame is up, so a change only waits to build one.
  if (frame === 1) prefetchShapes();
  // The first frame after a pause carries the paused time (up to 0.1 s); it steps as one substep.
  if (wasPaused && dt > 0) dt = Math.min(dt, SUBSTEP);
  wasPaused = dt === 0;
  autoChange.update(dt);
  if (params.shape() !== shapeRequest) setShape(params.shape());
  // While a new shape loads, the rest of a randomize waits for it, so they change on the same frame.
  const settled = shape?.name === shapeRequest;
  if (settled) {
    updateLook();
    updateFraming();
    body.position.y = bodyY();
  }
  updateWireframe();
  rotation.update(dt);
  if (melt) {
    // R with the same shape: rebuild from the new seed so the url reproduces the pattern.
    if (melt.seed !== getSeed() && shapeRequest === shape.name) melt = createMelt(shape, melt.walk);
    melt.params();
    // Warmed on its first frame, after a ?seed= url or R has set the params.
    if (melt.cold) melt.warm(body);
    else if (dt > 0) melt.step(dt, body);
  }
  field.setPoses(body);
  melt?.upload(dt, body);
  updateOccluders();
  if (settled) fitShadow();
  controls.update();
  backdrop.keepInsideCyc(camera, controls.target);
  bake.render(renderer, body.geometry, pipeline.motionBlur && pipeline.motionBlurAvailable);
  pipeline.render(scene, camera, time);
});
