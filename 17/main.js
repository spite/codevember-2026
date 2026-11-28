import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, loadingStep, addKey, isRunning } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Group, Vector2, Vector3, Plane, Raycaster, SphereGeometry, BufferGeometry, BufferAttribute, Points } from "three";
import { createAutoChange } from "modules/autoChange.js";
import { nativeRandom } from "modules/random.js";
import { createBackdrop, createSurface, murk, waterUniforms } from "./water.js";
import { UnderwaterRenderer } from "./renderer.js";
import {
  createKelpMaterial,
  createKelpDepthMaterial,
  createKelpShadowMaterial,
  createShadowDepthMaterial,
  createReefFloorMaterial,
  createProbeSphereMaterial,
  createMarineSnowMaterial,
  kelpUniforms,
} from "./shaders.js";
import { SEGS_PER_COL, forestGeometry, buildReefFloorGeometry } from "./kelpBuilder.js";
import { FluidSim3D } from "./fluidSim.js";
import { KelpPhysicsSim } from "./kelpPhysics.js";

// The simulations run on a fixed step, so they behave the same at any frame rate.
const STEP = 1 / 60;
const VIEW = { position: new Vector3(0, -4.3, 10.5), target: new Vector3(0, 3.2, -3.5) };
const PROBE_RADIUS = 0.58;
// The hand-composed forest the page opens on; randomizing moves its stalks around.
const FIRST_FOREST = 42197;
const FADE_OUT = 0.9;
const FADE_IN = 1.6;
// The built forest is the forest at rest in the current: a new one only needs to make way for the probe.
const SETTLE_STEPS = 15;

const QUALITIES = ["high", "medium", "low"];
const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
// Phones that report little memory or few cores start on the low tier (the kelp physics is CPU-bound there).
const lowEnd = mobile && ((navigator.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4);
const autoQuality = lowEnd ? "low" : mobile ? "medium" : "high";
const query = new URLSearchParams(location.search);
const askedQuality = query.get("quality");
const capture = query.has("capture");
const quality = QUALITIES.includes(askedQuality) ? askedQuality : capture ? "high" : autoQuality;
const detail = { high: 1, medium: 0.55, low: 0.4 }[quality];
// Fewer blades on lighter tiers: the physics of every blade runs on the CPU.
const density = { high: 1, medium: 0.6, low: 0.45 }[quality];
// Lighter tiers step the water every other step, relax the kelp's constraints fewer times and simulate fewer blades.
const sim = {
  high: { fluidEvery: 1, iterations: 4, maxBlades: 4500 },
  medium: { fluidEvery: 2, iterations: 3, maxBlades: 2400 },
  low: { fluidEvery: 2, iterations: 3, maxBlades: 1600 },
}[quality];

const defaults = {
  surge: 1,
  probe: true,
  auto: true,
  autoTime: 15,
};
const params = fromDefaults(defaults);
const load = { forest: loadingStep(3, "Growing the kelp…"), water: loadingStep(1, "Filling the water…"), compile: loadingStep(3, "Compiling shaders…") };

const forest = { seed: FIRST_FOREST, random: false, physics: null };
const change = { state: "idle", t: 0, murk: 0, build: null, ready: null };
const underwater = new UnderwaterRenderer(renderer, { quality: capture && !askedQuality ? "capture" : quality });
// ?debug=shadow|caustics|light shows what the surfaces receive.
waterUniforms.uDebug.value = Math.max(0, ["none", "shadow", "caustics", "light"].indexOf(new URLSearchParams(location.search).get("debug")));

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSlider("Surge", params.surge, 0, 2.2, 0.05);
gui.addCheckbox("Probe sphere", params.probe, { randomizable: false });
gui.addButton("Stir the water", () => stir());
gui.addButton("Surge", () => surge());
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => change.state === "idle" });
gui.addSection("Rendering", { open: false });
gui.addSelect("Quality (reloads)", QUALITIES.includes(askedQuality) ? askedQuality : "auto", [["auto", `auto (${autoQuality})`], ...QUALITIES], {
  randomizable: false,
  onChange: (q) => {
    const url = new URL(location.href);
    if (q === "auto") url.searchParams.delete("quality");
    else url.searchParams.set("quality", q);
    location.replace(url);
  },
});
underwater.addGUI(gui);
gui.endSection();
addKey("KeyS", "stir the water", () => stir());
gui.addSeparator();
gui.addText(keysHelp());
showHint("Move the pointer to stir the water · R for a new forest", "Drag to stir the water · tap {randomize} for a new forest");
gui.show();

const scene = new Scene();
scene.add(createBackdrop());
scene.add(createSurface());
// What the sun's shadow map sees: stand-ins for the kelp and the probe.
const shadowScene = new Scene();
// The kelp's depth, laid down before the scene is shaded.
const depthScene = new Scene();

// The forest: one mesh of stipes, bladders and blades, moved by the physics through two float textures.
const forestGroup = new Group();
scene.add(forestGroup);
forestGroup.add(new Mesh(buildReefFloorGeometry(quality === "high" ? 160 : 80), createReefFloorMaterial()));
const kelpMesh = new Mesh(new BufferGeometry(), createKelpMaterial(SEGS_PER_COL, { taps: quality === "high" ? 8 : 5 }));
kelpMesh.frustumCulled = false;
forestGroup.add(kelpMesh);
const kelpShadow = new Mesh(new BufferGeometry(), createKelpShadowMaterial(SEGS_PER_COL));
kelpShadow.frustumCulled = false;
shadowScene.add(kelpShadow);
const kelpDepth = new Mesh(kelpMesh.geometry, createKelpDepthMaterial(SEGS_PER_COL));
kelpDepth.frustumCulled = false;
depthScene.add(kelpDepth);

// A probe sphere on a Lissajous path, pushing the water and the kelp aside.
const probe = new Mesh(new SphereGeometry(PROBE_RADIUS, 48, 32), createProbeSphereMaterial());
scene.add(probe);
const probeShadow = new Mesh(new SphereGeometry(PROBE_RADIUS, 24, 16), createShadowDepthMaterial());
shadowScene.add(probeShadow);
const probeVel = new Vector3();
function lissajous(t, pos, vel) {
  pos.set(4.6 * Math.sin(0.65 * t), 3.4 + 3.2 * Math.sin(0.97 * t + 0.7), -0.8 + 4.0 * Math.sin(0.49 * t + 1.4));
  vel.set(4.6 * 0.65 * Math.cos(0.65 * t), 3.2 * 0.97 * Math.cos(0.97 * t + 0.7), 4.0 * 0.49 * Math.cos(0.49 * t + 1.4));
}
lissajous(0, probe.position, probeVel);

// Marine snow, carried by the water.
const SNOW = { high: 2400, medium: 1200, low: 700 }[quality];
const snowPositions = new Float32Array(SNOW * 3);
const snowSeeds = new Float32Array(SNOW);
for (let i = 0; i < SNOW; i++) {
  snowPositions[i * 3] = (nativeRandom() - 0.5) * 32;
  snowPositions[i * 3 + 1] = nativeRandom() * 24.5 - 7;
  snowPositions[i * 3 + 2] = (nativeRandom() - 0.5) * 32;
  snowSeeds[i] = nativeRandom() * 100;
}
const snowGeo = new BufferGeometry();
snowGeo.setAttribute("position", new BufferAttribute(snowPositions, 3));
snowGeo.setAttribute("aSeed", new BufferAttribute(snowSeeds, 1));
const snowMat = createMarineSnowMaterial();
const snow = new Points(snowGeo, snowMat);
snow.frustumCulled = false;
scene.add(snow);

const fluid = new FluidSim3D(24, 18, 24);

// Forests are built in a worker; the newest request wins.
const worker = new Worker(new URL("./forest.worker.js", import.meta.url), { type: "module" });
const builds = new Map();
let buildId = 0;
// A forest that fails to build resolves to null; once the worker itself has failed, forests are built on the page.
let workerDead = false;
worker.onmessage = ({ data }) => {
  if (data.error) console.error("Forest worker:", data.error);
  builds.get(data.id)?.resolve(data.error ? null : data);
  builds.delete(data.id);
};
worker.onerror = (e) => {
  console.error("Forest worker failed; building on the page", e.message ?? "");
  workerDead = true;
  // What was waiting on it is built on the page instead (the same seed, so the url still names it).
  for (const { resolve, job } of builds.values()) resolve(buildForestHere(job));
  builds.clear();
};
function buildForest() {
  const job = { seed: forest.seed, randomLayout: forest.random, detail, density, shadowDetail: detail * 0.4 };
  if (workerDead) return buildForestHere(job);
  const id = ++buildId;
  return new Promise((resolve) => {
    builds.set(id, { resolve, job });
    worker.postMessage({ id, ...job });
  });
}
// Without the worker (it failed to load), the same build on the page, a frame later; null if it throws.
function buildForestHere(job) {
  return import("./kelpBuilder.js").then(
    ({ buildKelpForestGeometry }) =>
      new Promise((resolve) =>
        setTimeout(() => {
          try {
            const shadow = buildKelpForestGeometry({ ...job, detail: job.shadowDetail, shadow: true });
            resolve({ ...buildKelpForestGeometry(job), shadow: { attributes: shadow.attributes, index: shadow.index } });
          } catch (error) {
            console.error("Forest build failed", error);
            resolve(null);
          }
        }, 0),
      ),
  );
}

function showForest(data) {
  forest.physics?.dispose();
  kelpMesh.geometry.dispose();
  kelpMesh.geometry = kelpDepth.geometry = forestGeometry(data);
  kelpShadow.geometry.dispose();
  kelpShadow.geometry = forestGeometry(data.shadow);
  const physics = new KelpPhysicsSim(data, { maxSimulated: sim.maxBlades });
  fluid.setStream(data.stream);
  for (let i = 0; i < SETTLE_STEPS; i++) physics.step(STEP, fluid, probe.position, PROBE_RADIUS, params.probe(), sim.iterations);
  physics.uploadTextures();
  kelpUniforms.uStipeDeltaTex.value = physics.deltaTexture;
  kelpUniforms.uBladeQuatTex.value = physics.bladeQuatTexture;
  kelpUniforms.uBladeRestTex.value = physics.bladeRestTexture;
  forest.physics = physics;
}

// A new forest: silt clouds the water, the forest is swapped (built meanwhile in the worker) and the water clears.
function changeForest() {
  const build = buildForest();
  change.build = build;
  change.ready = null;
  build.then((data) => {
    if (change.build !== build) return;
    if (data) return void (change.ready = data);
    // It failed: the water clears on the forest still there.
    change.build = null;
    change.state = "in";
    change.t = FADE_IN * (1 - change.murk);
  });
  if (change.state !== "out") {
    change.t = FADE_OUT * change.murk;
    change.state = "out";
  }
}

const smooth = (x) => x * x * (3 - 2 * x);
function updateChange(dt) {
  if (change.state === "out") {
    change.t += dt;
    change.murk = smooth(Math.min(1, change.t / FADE_OUT));
    // Paused, the new forest just replaces the old one.
    const instant = !isRunning();
    if (change.ready && (change.murk >= 1 || instant)) {
      showForest(change.ready);
      change.ready = change.build = null;
      change.state = instant ? "idle" : "in";
      change.t = 0;
      change.murk = instant ? 0 : 1;
      if (instant) autoChange.restart();
    } else if (instant) {
      change.t = 0;
      change.murk = 0;
    }
  } else if (change.state === "in") {
    change.t += dt;
    change.murk = 1 - smooth(Math.min(1, change.t / FADE_IN));
    if (change.t >= FADE_IN) {
      change.state = "idle";
      change.murk = 0;
      autoChange.restart();
    }
  }
  murk.value = change.murk;
  kelpMesh.visible = change.murk < 0.999;
  kelpDepth.visible = kelpMesh.visible;
}

// The panel's Surge button works during the load, so these exist before it.
let simTime = 0;
let nextSurge = 8 + nativeRandom() * 10;

let started = false;
onRandomize(() => {
  forest.seed = Math.floor(Math.random() * 2 ** 32);
  forest.random = true;
  if (started) changeForest();
});
onRandomize(() => gui.randomizeAll());
applyUrlState();
started = true;

// The first forest, from another seed if one fails (a few times at most).
const firstForest = load.forest.track(
  (async () => {
    for (let attempt = 0; ; attempt++) {
      const data = await buildForest();
      if (data || attempt >= 2) return data;
      forest.seed = Math.floor(nativeRandom() * 2 ** 32);
    }
  })(),
);
for (let i = 0; i < 50; i++) fluid.step(STEP, params.surge());
load.water.done();
// Still none after the retries: the page runs on with an empty sea rather than stopping at the loader.
const first = await firstForest;
if (first) showForest(first);
else console.error("No forest could be built");

// A wide lens, as most underwater photographs are taken with.
camera.userData.baseFov = 72;
camera.near = 0.1;
camera.far = 150;
dispatchEvent(new Event("resize"));
// The camera is fixed: the view is composed, and the pointer stirs the water instead.
controls.enabled = false;
onResize((w, h, dpr) => {
  snowMat.uniforms.uPixelRatio.value = dpr;
  snowMat.uniforms.uViewHeight.value = h;
});

camera.position.copy(VIEW.position);
controls.target.copy(VIEW.target);
controls.update();

await load.compile.track(underwater.compileAsync(scene, shadowScene, camera, depthScene), 3);

// Now and then a bigger surge passes through the forest.
function surge() {
  fluid.surge(0.45 + 0.25 * nativeRandom(), (nativeRandom() - 0.5) * 0.8);
  nextSurge = simTime + 10 + nativeRandom() * 15;
}

function stir() {
  const dir = nativeRandom() > 0.5 ? 1 : -1;
  fluid.addImpulse(new Vector3(-3, 2, 1.5), new Vector3(2.8 * dir, 0.7, -1.4 * dir), 9);
  fluid.addImpulse(new Vector3(3, 6, -2.5), new Vector3(-2.4 * dir, -0.6, 1.6 * dir), 9);
}

// Moving the pointer stirs the water on a plane through the nearer kelp (and deeper along the same ray).
const canvas = renderer.domElement;
const raycaster = new Raycaster();
const ndc = new Vector2();
const stirPlane = new Plane();
const camDir = new Vector3();
const stirAnchor = new Vector3();
const stirFrom = new Vector3();
const stirTo = new Vector3();
const stirVel = new Vector3();
const deepHit = new Vector3();
function stirRay(x, y, out) {
  ndc.set(x * 2 - 1, 1 - y * 2);
  raycaster.setFromCamera(ndc, camera);
  camera.getWorldDirection(camDir);
  stirAnchor.copy(camera.position).addScaledVector(camDir, 8.5);
  stirPlane.setFromNormalAndCoplanarPoint(camDir, stirAnchor);
  return raycaster.ray.intersectPlane(stirPlane, out);
}
// A pointer moving from (x0, y0) to (x1, y1), in canvas fractions from the top left.
function stirLine(x0, y0, x1, y1) {
  if (!isRunning() || !stirRay(x0, y0, stirFrom) || !stirRay(x1, y1, stirTo)) return;
  stirVel.subVectors(stirTo, stirFrom).multiplyScalar(18);
  const speed = stirVel.length();
  if (speed <= 0.05) return;
  if (speed > 6) stirVel.multiplyScalar(6 / speed);
  fluid.addImpulse(stirTo, stirVel.clone().multiplyScalar(0.05), 4.2);
  deepHit.copy(stirTo).addScaledVector(raycaster.ray.direction, 4.5);
  fluid.addImpulse(deepHit, stirVel.clone().multiplyScalar(0.04), 4.6);
}
let prevPointer = null;
canvas.addEventListener("pointerleave", () => (prevPointer = null));
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const p = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  if (prevPointer) stirLine(prevPointer[0], prevPointer[1], p[0], p[1]);
  prevPointer = p;
});

const snowSample = new Vector3();
const snowVel = new Vector3();
function advectSnow(dt) {
  const arr = snowPositions;
  for (let i = 0; i < SNOW * 3; i += 3) {
    snowSample.set(arr[i], arr[i + 1], arr[i + 2]);
    fluid.sampleVelocityWorld(snowSample, snowVel);
    arr[i] += snowVel.x * dt;
    arr[i + 1] += (snowVel.y - 0.05) * dt;
    arr[i + 2] += snowVel.z * dt;
    if (arr[i] < -16) arr[i] += 32;
    else if (arr[i] > 16) arr[i] -= 32;
    if (arr[i + 1] < -7) arr[i + 1] += 24.5;
    else if (arr[i + 1] > 17.5) arr[i + 1] -= 24.5;
    if (arr[i + 2] < -16) arr[i + 2] += 32;
    else if (arr[i + 2] > 16) arr[i + 2] -= 32;
  }
}

let steps = 0;
let pending = 0;
function stepSim(dt) {
  simTime += dt;
  const probeOn = params.probe();
  if (probeOn) lissajous(simTime, probe.position, probeVel);
  probeShadow.position.copy(probe.position);
  if (simTime >= nextSurge) surge();
  if (++steps % sim.fluidEvery === 0) {
    if (probeOn) fluid.applyMovingSphere(probe.position, probeVel, PROBE_RADIUS, 2.8);
    fluid.step(dt * sim.fluidEvery, params.surge());
  }
  forest.physics?.step(dt, fluid, probe.position, PROBE_RADIUS, probeOn, sim.iterations);
  advectSnow(dt);
}

window.app = {
  canvas,
  params,
  pipeline: null,
  renderer: underwater,
  camera,
  controls,
  scene,
  fluid,
  quality,
  // For recordings: stir as a pointer moving from canvas fraction (x, y) by (dx, dy); start a surge now.
  stir: (x, y, dx, dy) => stirLine(x, y, x + dx, y + dy),
  surge,
  get kelp() {
    return forest.physics;
  },
};

// Exposure follows the view a little, as a camera would: opened up looking down into the dark, stopped down toward the sun.
const viewDir = new Vector3();
let exposure = 1;
render(({ time, dt }) => {
  autoChange.update(dt);
  probe.visible = probeShadow.visible = params.probe();
  updateChange(dt);
  pending = Math.min(pending + dt, STEP * 4);
  let stepped = false;
  while (pending >= STEP) {
    pending -= STEP;
    stepSim(STEP);
    stepped = true;
  }
  if (stepped) {
    forest.physics?.uploadTextures();
    snowGeo.attributes.position.needsUpdate = true;
  }
  kelpUniforms.uTime.value = time;
  kelpUniforms.uSurge.value = params.surge();
  controls.update();
  camera.getWorldDirection(viewDir);
  const target = 1 + 0.9 * Math.min(1, Math.max(0, (0.35 - viewDir.y) / 0.8));
  exposure = dt > 0 ? exposure + (target - exposure) * (1 - Math.exp(-dt * 2)) : target;
  underwater.exposure = exposure * underwater.baseExposure;
  kelpDepth.visible = kelpMesh.visible;
  underwater.render(scene, shadowScene, camera, time, depthScene);
});
