import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, loadSeed, randomize, keysHelp, setDay, showHint, loadingStep, fetchWithProgress, addKey, addActionButton, onPause, showSoundHint } from "common";
import { GUI, signal } from "guspira";
import { Scene, Mesh, InstancedMesh, Group, Vector3, Vector2, Matrix4, Quaternion, BufferGeometry, BufferAttribute, CylinderGeometry, BoxGeometry, Raycaster, Plane, Color } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync, applyEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { createBackdrop } from "./backdrop.js";
import * as gearLib from "./gears.js";
import * as escLib from "./escapement.js";
import * as chainLib from "./chain.js";
import { createMachine } from "./train.js";
import { bestView, machinePoints, fitDistance } from "./view.js";
import { createSound } from "./sound.js";
import { nativeRandom } from "modules/random.js";
import { createRustMaterial, loadRustTextures, RUST_PALETTES, setRustPalette } from "./rust.js";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Studio looks: the backdrop's colour and the light on it.
const STUDIOS = {
  bone: { background: 0xd9d3c9, tint: 0xfff4e8, key: [-0.6, 0.85, 0.5], keyIntensity: 9, keySize: 0.5, fill: 0.4, fillColor: 0xdfe8ff, floor: 0.45, wall: 0.55 },
  blush: { background: 0xc9a29a, tint: 0xfff0ea, key: [0.4, 0.8, 0.6], keyIntensity: 8, keySize: 0.6, fill: 0.5, fillColor: 0xffe8e0, floor: 0.45, wall: 0.5 },
  paper: { background: 0xe8e4dc, tint: 0xfffaf2, key: [-0.4, 0.9, 0.55], keyIntensity: 8, keySize: 0.7, fill: 0.5, fillColor: 0xe8eeff, floor: 0.55, wall: 0.65 },
  sage: { background: 0xc6cdbf, tint: 0xfdfff4, key: [0.55, 0.75, 0.5], keyIntensity: 9, keySize: 0.45, fill: 0.45, fillColor: 0xe4f0ff, floor: 0.45, wall: 0.55 },
  sky: { background: 0xc8d2dc, tint: 0xf4f8ff, key: [-0.7, 0.7, 0.45], keyIntensity: 10, keySize: 0.4, fill: 0.45, fillColor: 0xfff0e0, floor: 0.45, wall: 0.55 },
  sand: { background: 0xdcc9ad, tint: 0xfff0dc, key: [0.6, 0.65, 0.55], keyIntensity: 11, keySize: 0.35, fill: 0.35, fillColor: 0xd8e4ff, floor: 0.45, wall: 0.5 },
  ash: { background: 0xd2d0cd, tint: 0xffffff, key: [-0.3, 0.95, 0.4], keyIntensity: 9, keySize: 0.55, fill: 0.5, fillColor: 0xffffff, floor: 0.5, wall: 0.6 },
};

// Stage types the generator can use; each has a mix weight (0 leaves it out, 0.5 is the generator's own default).
const TYPES = ["spur", "compound", "idler", "bevel", "worm", "ring", "planetary", "yoke", "helical", "herringbone", "crossed", "chain", "differential"];

const defaults = {
  variation: 1,
  gears: 12,
  balance: 0.75,
  ...Object.fromEntries(TYPES.map((t) => [`mix_${t}`, 0.5])),
  chamfer: 1,
  wear: 0.3,
  rust: 0.6,
  grease: 0.5,
  palette: "auto",
  edgePits: 0.6,
  flaking: 0.5,
  grime: 0.75,
  studio: "bone",
  period: 2,
  speed: 1,
  auto: true,
  autoTime: 20,
};
const params = fromDefaults(defaults);
// Age is left out of the url: it ramps by itself on every machine, and a link shouldn't freeze it.
params.age = signal(1);
let pixelAngle = 0.001;
let meshes = [];
let axleMeshes = [];
function allMaterials() {
  return [...meshes, ...axleMeshes].map((o) => o.material ?? o.userData.material);
}
const load = { sound: loadingStep(1), rust: loadingStep(2), studio: loadingStep(1), machine: loadingStep(2), compile: loadingStep(3) };
// The rust's textures: grown corrosion fields and CC0 scans (see README and tools/).
const rustFiles = ["corrosion.bin", "textures/color.jpg", "textures/normal.jpg", "textures/data.png"];
const rustProgress = rustFiles.map(() => 0);
const rustTextures = load.rust.track(
  Promise.all(
    rustFiles.map((f, i) =>
      fetchWithProgress(new URL(`./${f}`, import.meta.url), (x) => {
        rustProgress[i] = x;
        load.rust.set(rustProgress.reduce((a, b) => a + b) / rustFiles.length);
      }).then((r) => (i === 0 ? r.arrayBuffer() : r.blob())),
    ),
  ).then(([corrosion, color, normal, data]) => loadRustTextures({ corrosion: new Uint8Array(corrosion), color, normal, data })),
);

const pipeline = new Pipeline(renderer, {
  background: STUDIOS.bone.background,
  // Much of the geometry hides behind itself: shade only the frontmost surface.
  depthPrepass: true,
  exposure: 1,
  bloomStrength: 0.02,
  vignette: 0.3,
  grain: 0.02,
  stillSamples: 32,
  shadow: { autoFit: true, denoise: true },
});

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSection("Machine");
gui.addSlider("Variation", params.variation, 1, 9999, 1);
gui.addSlider("Gears", params.gears, 6, 30, 1, { randomizable: false });
// The chance a machine runs on a balance wheel instead of a pendulum.
gui.addSlider("Balance wheel", params.balance, 0, 1, 0.01, { randomizable: false });
gui.addSection("Mix");
for (const t of TYPES) gui.addSlider(t[0].toUpperCase() + t.slice(1), params[`mix_${t}`], 0, 1, 0.01);
gui.addSection("Finish");
gui.addSlider("Chamfer", params.chamfer, 0, 1, 0.01);
gui.addSlider("Wear", params.wear, 0, 1, 0.01);
gui.addSlider("Age", params.age, 0, 1, 0.001, { randomizable: false });
gui.addSlider("Rust", params.rust, 0, 1, 0.01);
gui.addSelect("Rust colour", params.palette, ["auto", ...Object.keys(RUST_PALETTES)]);
gui.addSlider("Grease", params.grease, 0, 1, 0.01);
gui.addSlider("Edge pitting", params.edgePits, 0, 1, 0.01);
gui.addSlider("Flaking", params.flaking, 0, 1, 0.01);
gui.addSlider("Grime", params.grime, 0, 1, 0.01);
gui.addSlider("Pendulum", params.period, 1, 4, 0.01, { randomizable: false });
// How fast the escapement runs: scales the train's clock, not the pendulum's length.
gui.addSlider("Speed", params.speed, 0.25, 4, 0.01, { randomizable: false });
gui.addSection("Studio");
gui.addSelect("Studio", params.studio, Object.keys(STUDIOS));
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => phase.name === "run" });
// Frames per second, averaged over half a second.
const fps = { value: signal(0), frames: 0, since: performance.now() };
gui.addMonitor("FPS", fps.value);
pipeline.addGUI(gui);
gui.addSeparator();
// Timelapse: T ages the machine from new to the panel's settings.
const timelapse = { on: false, t: 0, duration: 14 };
addKey("KeyT", "timelapse of the ageing", () => {
  timelapse.on = true;
  timelapse.t = 0;
  params.age.set(0);
});

// Sound: the escapement's tic-tac, rust catching and breaking free, ratchets under a dragging hand, parts sliding off
// and seating; duller the rustier the machine.
const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
onPause((running) => sound.setPaused(!running));
gui.addText(keysHelp());
showSoundHint(() => !sound.running);
showHint("Drag a gear to turn the train · drag elsewhere to orbit · R for a new machine", "Drag a gear to turn the train · tap {randomize} for a new machine");
gui.show();

const scene = new Scene();
// The machine turns on its spot (the camera and the light stay put), so it always faces the light well.
const rig = new Group();
scene.add(rig);
const backdrop = createBackdrop();
backdrop.mesh.renderOrder = 1;
backdrop.place(-1.05, 0);
scene.add(backdrop.mesh);

// Studios baked once each, on first use.
const baked = {};
async function useStudio(name) {
  const s = STUDIOS[name];
  baked[name] ??= createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(...s.key),
    keyIntensity: s.keyIntensity,
    keySize: s.keySize,
    tint: s.tint,
    fill: s.fill,
    fillColor: s.fillColor,
    floor: s.floor,
    wall: s.wall,
    apply: false,
  });
  const result = await baked[name];
  if (lastStudio !== name) return;
  // Cross-fade to it: background, floor and lighting ease over a second; the reflections swap halfway.
  if (!studioFade.current) {
    applyEnvironment(result);
    pipeline.background.set(s.background);
    backdrop.setColor(s.background, 0.8);
    backdrop.snap();
    studioFade.current = result;
    return;
  }
  studioFade.from = {
    sh: globalUniforms.shIrradiance.value.map((v) => v.clone()),
    lightDirection: globalUniforms.lightDirection.value.clone(),
    lightColor: globalUniforms.lightColor.value.clone(),
    background: pipeline.background.clone(),
  };
  studioFade.to = result;
  studioFade.background = new Color(s.background);
  studioFade.t = 0;
  studioFade.swapped = false;
  backdrop.setColor(s.background, 0.8);
}

const studioFade = { current: null, from: null, to: null, t: 1, swapped: true, background: new Color() };
function updateStudioFade(dt) {
  if (studioFade.t >= 1 || !studioFade.to) return;
  studioFade.t = Math.min(1, studioFade.t + dt / 1.2);
  const k = studioFade.t * studioFade.t * (3 - 2 * studioFade.t), u = globalUniforms, f = studioFade.from, to = studioFade.to;
  for (let i = 0; i < 9; i++) u.shIrradiance.value[i].lerpVectors(f.sh[i], to.sh[i], k);
  u.lightDirection.value.lerpVectors(f.lightDirection, to.lightDirection, k).normalize();
  u.lightColor.value.copy(f.lightColor).lerp(to.lightColor, k);
  pipeline.background.copy(f.background).lerp(studioFade.background, k);
  if (!studioFade.swapped && k >= 0.5) {
    studioFade.swapped = true;
    u.envMap.value = to.envMap;
    u.envMapMaxLod.value = Math.max(to.envMap.mipmaps.length - 1, 0);
    if (to.shadowLightSize !== undefined) u.shadowLightSize.value = to.shadowLightSize;
  }
  if (studioFade.t >= 1) studioFade.current = to;
  pipeline.restartAccumulation(false);
}

camera.userData.baseFov = 30;
camera.fov = 30;
camera.position.set(1.6, 0.9, 3.4);
controls.target.set(0, 0, 0);
controls.minDistance = 1.2;
controls.maxDistance = 8;
controls.addEventListener("start", () => (frame.free = true));
// Render scale: big screens stay under a pixel budget.
const capturing = new URLSearchParams(location.search).has("capture");
const view = { w: 1, h: 1, dpr: 1 };
const budget = pipeline.quality === "low" || pipeline.quality === "medium" ? 2.2e6 : 3.7e6;
function applySize() {
  const fit = capturing ? 1 : Math.min(1, Math.sqrt(budget / (view.w * view.h * view.dpr * view.dpr)));
  const ratio = view.dpr * fit;
  if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
  pipeline.setSize(view.w, view.h, ratio);
  pixelAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (view.h * ratio);
  for (const m of allMaterials()) m.uniforms.pixelAngle.value = pixelAngle;
}
onResize((w, h, dpr) => {
  Object.assign(view, { w, h, dpr });
  applySize();
});
// ——— Meshes ———

function toGeometry(data) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.position, 3));
  g.setAttribute("normal", new BufferAttribute(data.normal, 3));
  g.setIndex(new BufferAttribute(data.index, 1));
  return weathering(g);
}

// Per vertex, for the rust: a normal smoothed across creases (vertices welded by position; displacing along it keeps
// the mesh closed, and blending to it rounds edges), and how concave the surface is there (grime gathers in it).
function weathering(g) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array;
  const nv = P.length / 3;
  const weld = new Int32Array(nv), keys = new Map();
  let nw = 0;
  for (let v = 0; v < nv; v++) {
    const k = `${Math.round(P[3 * v] * 1e5)},${Math.round(P[3 * v + 1] * 1e5)},${Math.round(P[3 * v + 2] * 1e5)}`;
    let w = keys.get(k);
    if (w === undefined) keys.set(k, (w = nw++));
    weld[v] = w;
  }
  const S = new Float32Array(nw * 3);
  for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) S[3 * weld[v] + c] += N[3 * v + c];
  for (let w = 0; w < nw; w++) {
    const l = Math.hypot(S[3 * w], S[3 * w + 1], S[3 * w + 2]) || 1;
    S[3 * w] /= l, S[3 * w + 1] /= l, S[3 * w + 2] /= l;
  }
  // Concavity: neighbours rising above the vertex's tangent plane, as the sine of the angle, averaged over its edges.
  const sum = new Float32Array(nw), cnt = new Float32Array(nw);
  for (let t = 0; t < I.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const dx = P[3 * b] - P[3 * a], dy = P[3 * b + 1] - P[3 * a + 1], dz = P[3 * b + 2] - P[3 * a + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) continue;
      const wa = weld[a], wb = weld[b];
      sum[wa] += (S[3 * wa] * dx + S[3 * wa + 1] * dy + S[3 * wa + 2] * dz) / l, cnt[wa]++;
      sum[wb] -= (S[3 * wb] * dx + S[3 * wb + 1] * dy + S[3 * wb + 2] * dz) / l, cnt[wb]++;
    }
  const smooth = new Float32Array(nv * 3), cav = new Float32Array(nv), vex = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const w = weld[v], k = sum[w] / Math.max(cnt[w], 1);
    smooth.set(S.subarray(3 * w, 3 * w + 3), 3 * v);
    cav[v] = Math.max(0, Math.min(1, k * 8));
    vex[v] = Math.max(0, Math.min(1, -k * 4));
  }
  g.setAttribute("aSmooth", new BufferAttribute(smooth, 3));
  g.setAttribute("aCavity", new BufferAttribute(cav, 1));
  g.setAttribute("aConvex", new BufferAttribute(vex, 1));
  return g;
}

// Several three geometries as one.
function merge(list) {
  let nv = 0, ni = 0;
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index.count;
  }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), I = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of list) {
    P.set(g.attributes.position.array, ov * 3);
    N.set(g.attributes.normal.array, ov * 3);
    const idx = g.index.array;
    for (let k = 0; k < idx.length; k++) I[oi + k] = idx[k] + ov;
    ov += g.attributes.position.count;
    oi += idx.length;
    g.dispose();
  }
  return toGeometry({ position: P, normal: N, index: I });
}

// A cylinder along local z.
function zCylinder(r, length, x = 0, y = 0, z = 0, segments = 32) {
  const g = new CylinderGeometry(r, r, length, segments);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

// Crank, yoke and carrier are made from primitives, within the shapes the generator assumed for them.
const BUILDERS = {
  crank: (a) => {
    const side = a.pinSide ?? 1;
    return merge([
      zCylinder(a.radius, a.thickness, 0, 0, 0, 48),
      zCylinder(a.hubRadius ?? a.radius * 0.3, a.thickness * 1.6),
      zCylinder(a.pinRadius, a.pinLength, a.pinOffset, 0, side * (a.thickness / 2 + a.pinLength / 2), 20),
    ]);
  },
  yoke: (a) => {
    const ox = a.slotWidth / 2 + a.wall / 2, oy = a.slotLength / 2 + a.wall / 2;
    const side = (x) => new BoxGeometry(a.wall, a.slotLength + 2 * a.wall, a.thickness).translate(x, 0, 0);
    const end = (y) => new BoxGeometry(a.slotWidth, a.wall, a.thickness).translate(0, y, 0);
    return merge([side(-ox), side(ox), end(-oy), end(oy)]);
  },
  carrier: (a) => {
    const side = a.pinSide ?? 1;
    const parts = [zCylinder(a.hubRadius ?? a.armWidth, a.thickness, 0, 0, 0, 32)];
    for (const ang of a.angles) {
      const x = Math.cos(ang) * a.radius, y = Math.sin(ang) * a.radius;
      const arm = new BoxGeometry(a.radius, a.armWidth, a.thickness);
      arm.translate(a.radius / 2, 0, 0);
      arm.rotateZ(ang);
      parts.push(arm, zCylinder(a.armWidth / 2, a.thickness, x, y), zCylinder(a.pinRadius, a.pinLength, x, y, side * (a.thickness / 2 + a.pinLength / 2), 16));
    }
    return merge(parts);
  },
};

function partGeometry(part) {
  const b = part.build;
  if (b.result?.position) return toGeometry(b.result);
  if (b.module === "train") return BUILDERS[b.fn](b.args);
  const lib = b.module === "escapement.js" ? escLib : b.module === "chain.js" ? chainLib : gearLib;
  return toGeometry(lib[b.fn](b.args));
}

// A chain: its roller and pin links as two instanced meshes in a group, each link posed from q every frame.
function chainMesh(part, material) {
  const group = new Group();
  const kinds = { inner: [], outer: [] };
  for (let i = 0; i < part.linkCount; i++) kinds[part.linkKind(i) === "inner" ? "inner" : "outer"].push(i);
  for (const [kind, ids] of Object.entries(kinds)) {
    if (!ids.length) continue;
    const g = toGeometry(kind === "inner" ? chainLib.rollerLink({ pitch: part.pitch }) : chainLib.plateLink({ pitch: part.pitch }));
    const inst = new InstancedMesh(g, material, ids.length);
    inst.frustumCulled = false;
    inst.userData.links = ids;
    group.add(inst);
  }
  group.userData.material = material;
  return group;
}

const _link = new Matrix4();
function poseChain(group, part, q) {
  for (const inst of group.children) {
    inst.userData.links.forEach((i, j) => inst.setMatrixAt(j, part.linkPose(i, q, _link)));
    inst.instanceMatrix.needsUpdate = true;
  }
}

// How each part has lived. The seed sets the machine's story (from still in use, oiled and polished where it runs, to
// abandoned for decades); each part strays a little from it, and the odd gear is brass.
const GEAR_KINDS = new Set(["spur", "helical", "herringbone", "bevel", "wormWheel", "escapeWheel", "sprocket"]);
function rustInfo(part, story, rand, up) {
  const b = part.build, r = b.result;
  const mod = b.args?.module ?? machine.module;
  const rp = r?.pitchRadius ?? 0;
  const gear = GEAR_KINDS.has(part.kind) && rp > 0;
  const bore = r?.body?.bore ?? b.args?.bore ?? 0;
  return {
    ageOffset: (rand() - 0.5) * 0.25 - story.inUse * 0.15,
    // Most parts share the machine's rust; some (another batch of steel, another spot) take a second palette.
    story,
    second: rand() < 0.25,
    shift: (rand() - 0.5) * 0.3,
    inUse: story.inUse,
    brass: gear && rand() < story.brass,
    meshing: (part.meshesWith?.length ?? 0) > 0,
    seed: rand() * 100,
    zones: gear ? [rp - 1.25 * mod, rp, rp + mod, bore] : [0, 0, 0, 0],
    halfWidth: gear ? (b.args?.width ?? r?.width ?? 5 * mod) / 2 : 0,
    body: gear && r?.body ? [r.body.rRim, r.body.rHub, (r.body.style?.type ?? "solid") === "solid" ? 0 : r.body.web / 2, r.body.hubWidth / 2] : [0, 0, 0, 0],
    up,
  };
}

function rustMaterial(info) {
  const m = createRustMaterial(textures, info, { lite: pipeline.quality === "low" || pipeline.quality === "medium" });
  m.userData.info = info;
  setLook(m);
  return m;
}

// The panel's weathering settings on a part's material.
// The look the machine on show has. It follows the panel, except while a change of machine is pending or under way:
// then the old machine keeps its own until it's gone, and the new one arrives with the new values.
const lookFromParams = () => ({ age: params.age(), palette: params.palette(), rust: params.rust(), grease: params.grease(), edgePits: params.edgePits(), flaking: params.flaking(), grime: params.grime() });
let L = lookFromParams();
let lastStudio = params.studio(), lastLook = "";

function setLook(m) {
  const info = m.userData.info, u = m.uniforms;
  // Age scales every weathering setting from nothing (new metal) to the panel's values.
  const a = L.age;
  // Rust leads, the rest follow behind it: crust has to form before it flakes, edges pit, or grime packs in.
  const late = (k) => Math.max(0, Math.min(1, (a - k) / (1 - k)));
  u.age.value = Math.min(1, Math.max(0, L.rust * a + info.ageOffset * a));
  const name = L.palette === "auto" ? (info.second ? info.story.second : info.story.palette) : L.palette;
  setRustPalette(m, RUST_PALETTES[name], info.shift);
  u.grease.value = L.grease * (0.6 + 0.4 * info.inUse) * Math.min(1, a * 2);
  u.pixelAngle.value = pixelAngle;
  u.edgePits.value = L.edgePits * late(0.3);
  u.flaking.value = L.flaking * late(0.45);
  u.grime.value = L.grime * late(0.15);
}


// ——— The machine ———

let machine = null;
let textures = null;

function randomDir(rand) {
  return new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
}

function buildScene(m) {
  for (const o of [...meshes, ...axleMeshes]) {
    rig.remove(o);
    o.traverse((c) => c.geometry?.dispose());
    (o.material ?? o.userData.material).dispose();
  }
  meshes = [];
  axleMeshes = [];
  machine = m;
  const rand = mulberry32(m.seed * 7919 + 1);
  const names = Object.keys(RUST_PALETTES);
  const story = { inUse: rand() ** 1.5, brass: rand() < 0.5 ? 0 : 0.1 + 0.2 * rand(), palette: rand() < 0.6 ? "mixed" : names[Math.floor(rand() * names.length)], second: names[Math.floor(rand() * names.length)] };
  const q0 = escapement(0).wheel;
  const _inv = new Matrix4();
  for (const part of m.parts) {
    // What was up for this part before it started turning: in its own frame.
    _inv.copy(part.pose(q0, 0)).invert();
    const up = new Vector3(0, 1, 0).transformDirection(_inv).toArray();
    const material = rustMaterial({ ...rustInfo(part, story, rand, up), instanced: part.kind === "chain" });
    const mesh = part.kind === "chain" ? chainMesh(part, material) : new Mesh(partGeometry(part), material);
    mesh.matrixAutoUpdate = false;
    mesh.userData.part = part;
    // How this part leaves and arrives: off its axle, then away.
    const dir = part.axle ? new Vector3(...part.axle.dir).normalize() : randomDir(rand);
    mesh.userData.out = { slide: dir.multiplyScalar(rand() < 0.5 ? -1 : 1), drift: randomDir(rand), delay: rand(), spin: randomDir(rand) };
    rig.add(mesh);
    meshes.push(mesh);
  }
  for (const a of m.axles) {
    const dir = new Vector3(...a.dir).normalize();
    const base = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir));
    const up = new Vector3(0, 1, 0).transformDirection(new Matrix4().copy(base).invert()).toArray();
    const axleInfo = { story, second: false, shift: 0, ageOffset: -0.15 - 0.2 * story.inUse, inUse: story.inUse, meshing: false, seed: rand() * 100, zones: [0, 0, 0, 0], up };
    const mesh = new Mesh(weathering(zCylinder(a.radius, a.to - a.from, 0, 0, (a.from + a.to) / 2, 20)), rustMaterial(axleInfo));
    base.setPosition(...a.origin);
    mesh.matrixAutoUpdate = false;
    mesh.userData.base = base;
    mesh.userData.out = { slide: dir.clone().multiplyScalar(rand() < 0.5 ? -1 : 1), drift: randomDir(rand), delay: rand(), spin: randomDir(rand) };
    rig.add(mesh);
    axleMeshes.push(mesh);
  }
  frame.radius = m.bounds.radius;
  // The side that shows most of the machine, which the camera turns to while it arrives.
  frame.dir = bestView(m, escapement(0).wheel, 0);
  // How far the machine turns about the vertical for its best side to face the camera.
  {
    const c = cameraDirection(frame.dir);
    frame.turn = Math.atan2(c.x, c.z) - Math.atan2(frame.dir.x, frame.dir.z);
  }
  // The parts' points with the pendulum at both ends of its swing and hanging straight (its lowest), every vertex, so
  // the floor goes just under the lowest and the view is framed on their bounds.
  const amp = m.escapement.layout?.amplitude ?? 0.06;
  const poses = [amp, -amp, 0].map((a) => machinePoints(m, q0, a));
  frame.points = new Float32Array(poses.reduce((n, a) => n + a.length, 0));
  poses.reduce((o, a) => (frame.points.set(a, o), o + a.length), 0);
  const lo = new Vector3(Infinity, Infinity, Infinity), hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < frame.points.length; i += 3) {
    lo.min(_p.set(frame.points[i], frame.points[i + 1], frame.points[i + 2]));
    hi.max(_p);
  }
  for (const a of [amp, -amp, 0]) {
    const all = machinePoints(m, q0, a, Infinity);
    for (let i = 1; i < all.length; i += 3) lo.y = Math.min(lo.y, all[i]);
  }
  frame.target = lo.clone().add(hi).multiplyScalar(0.5);
  // Close to the floor, so the shadows read: a few centimetres of air under the lowest point.
  backdrop.place(lo.y - 0.06, 0);
  frame.t = 0;
  frame.free = false;
}

// ——— Motion: one coordinate q (the escape wheel's angle) drives everything ———
// The escapement sets how far q may go; rust adds stick-slip: the train holds until the pull on it beats the static
// friction, then lurches and judders. Dragging a gear lifts the anchor clear and turns the train by hand.

const motionState = { time: 0, q: 0, v: 0, stuck: true, threshold: 0, offset: 0, anchor: 0, dragging: false, dragTarget: 0, lifted: 0, ticks: 0 };
const frictionRand = mulberry32(99);

function escapement(time) {
  return escLib.motion(time, { period: params.period(), layout: machine.escapement.layout });
}

function newThreshold(rust) {
  return rust * (0.006 + 0.02 * frictionRand());
}

// The running train: a soft click for every tooth that meshes on the busiest visible gear, and now and then a creak
// from an old machine settling.
const trainSound = { lastQ: 0, teeth: 0, creakIn: 6 };
function machineSounds(dt) {
  const s = motionState;
  const dq = s.q - trainSound.lastQ;
  trainSound.lastQ = s.q;
  if (!machine || phase.name !== "run" || dt <= 0) return;
  // The gear whose teeth pass fastest (but not a blur): its tooth count times its speed.
  if (!trainSound.gear || trainSound.gear.machine !== machine) {
    let best = null, bestRate = 0;
    for (const p of machine.parts) {
      const n = p.build?.args?.teeth, k = Math.abs(p.ratio ?? 0);
      if (!n || !k) continue;
      const rate = n * k;
      if (rate > bestRate && rate < 600) (best = p), (bestRate = rate);
    }
    trainSound.gear = best && { machine, teeth: best.build.args.teeth, ratio: Math.abs(best.ratio) };
    trainSound.teeth = 0;
  }
  const r = L.rust * L.age;
  const g = trainSound.gear;
  if (g) {
    trainSound.teeth += (Math.abs(dq) * g.ratio * g.teeth) / (2 * Math.PI);
    if (trainSound.teeth >= 1) {
      trainSound.teeth %= 1;
      sound.play("cog", { gain: 0.12 + 0.12 * r, rate: 1.4 - 0.4 * r, pan: -0.2, lowpass: dull() || 6000 });
    }
  }
  // Settling creaks.
  trainSound.creakIn -= dt;
  if (trainSound.creakIn <= 0) {
    trainSound.creakIn = 5 + 9 * nativeRandom();
    if (r > 0.3) sound.play("creak", { gain: 0.3 * r, rate: 0.7 + 0.25 * nativeRandom(), pan: nativeRandom() * 1.6 - 0.8, lowpass: dull() });
  }
}

// Rust damps the ring of the metal: a lowpass that closes as it ages (0 = open).
function dull() {
  const r = L.rust * L.age;
  return r < 0.1 ? 0 : 12000 - 9000 * Math.min(1, r);
}

function stepMotion(dt) {
  const s = motionState;
  // Stickiness follows the rust actually grown, so a new machine runs clean.
  const rust = params.rust() * params.age();
  if (!s.dragging && s.lifted <= 0) s.time += dt * params.speed();
  const esc = escapement(s.time);
  s.anchor = esc.anchor;
  if (esc.tick) {
    s.ticks++;
    // Tic and tac a little apart in pitch; quieter while the hand holds the train.
    if (!s.dragging) sound.play("tick", { gain: 0.7, rate: s.ticks % 2 ? 1.05 : 0.93, pan: 0.2, lowpass: dull() });
  }
  const target = s.dragging ? s.dragTarget : esc.wheel + s.offset;
  if (rust < 0.05) {
    s.q = target;
    s.v = 0;
    s.stuck = true;
  } else {
    // A stiff spring from the drive to the train against static and sliding friction, in small fixed steps: a slow
    // frame's long step would make it ring and twitch.
    const n = Math.ceil(dt / (1 / 240));
    for (let i = 0; i < n; i++) {
      const h = dt / n, pull = target - s.q;
      if (s.stuck) {
        if (Math.abs(pull) > s.threshold) {
          s.stuck = false;
          // Rust giving way: a creak of cogs, louder the harder it held.
          sound.play("cog", { gain: Math.min(1, 0.3 + s.threshold * 20) * rust, rate: 0.8 + 0.3 * nativeRandom(), lowpass: dull() });
        } else continue;
      }
      const k = 900, c = 60, kinetic = rust * 0.004 * Math.sign(s.v || pull);
      s.v += (k * (pull - kinetic) - c * s.v) * h;
      s.q += s.v * h;
      // Never past the escapement: a tooth can't go through a pallet.
      if (!s.dragging && s.q > target) {
        s.q = target;
        s.v = 0;
      }
      if (Math.abs(s.v) < 0.02 && Math.abs(target - s.q) < s.threshold * 0.5) {
        sound.play("clack", { gain: 0.25 * rust, rate: 0.85, lowpass: dull() });
        s.stuck = true;
        s.v = 0;
        s.threshold = newThreshold(rust);
      }
    }
  }
  machineSounds(dt);
  if (s.dragging) s.lifted = Math.min(1, s.lifted + dt * 5);
  else if (s.lifted > 0) {
    // After a turn by hand, the escapement takes the train back at the nearest lock, then the anchor drops in.
    const pitch = (2 * Math.PI) / machine.escapement.teeth;
    s.offset = Math.round((s.q - esc.wheel) / pitch) * pitch;
    s.lifted = Math.max(0, s.lifted - dt * 2.5);
  }
}

// ——— Changing machines: parts slide off their axles and drift away; the new ones fly in and seat ———

const phase = { name: "empty", t: 0 };
// The machine leaves without a new one (recordings end on the empty studio).
let clearing = false;
function clear() {
  if (!machine || phase.name !== "run") return;
  clearing = true;
  phase.name = "out";
  phase.t = 0;
  transitionSounds("out");
}
const DURATION = { out: 1.3, in: 1.8 };
const frame = { radius: 0.65, t: 0, free: false, dir: null, points: null, target: new Vector3(), distance: 3, turn: 0 };
// The camera's direction: at the best view's elevation, turned some 70 degrees round from the key light so the light
// rakes across the machine.
function cameraDirection(best) {
  const key = STUDIOS[lastStudio]?.key ?? [-0.6, 0.85, 0.5];
  const az = Math.atan2(key[0], key[2]) + 1.2;
  const el = Math.asin(Math.max(-0.95, Math.min(0.95, best.y)));
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// The automatic camera's roll: amplitude (radians) and period (seconds) of a slow lean either way.
const ROLL = { amount: 0.07, period: 23 };
const ORBIT_SPEED = 0.08; // radians per second
const _yAxis = new Vector3(0, 1, 0);
let shown = null;
let finished = null;

// The generator's options from the panel: relative weights per type (slider x 2, so 0.5 is a weight of 1); the generator
// scales the machine's size with its gear count.
function machineOptions() {
  // A slider at 1 forces its type into every machine (the generator's weight >= 10 rule).
  const weights = Object.fromEntries(TYPES.map((t) => [t, params[`mix_${t}`]() >= 0.99 ? 10 : params[`mix_${t}`]() * 2]));
  return { seed: params.variation(), gears: params.gears(), weights, balance: params.balance() };
}
const finishOptions = () => ({ chamfer: params.chamfer(), erosion: { amount: params.wear(), seed: params.variation() } });
const machineKey = () => JSON.stringify(machineOptions());
const finishKey = () => JSON.stringify(finishOptions());

function begin() {
  shown = machineKey();
  clearing = false;
  if (machine && phase.name !== "empty") {
    phase.name = "out";
    phase.t = 0;
    transitionSounds("out");
  } else install();
}

// Parts leaving are knocked off their axles with a heavy clank (lower for bigger parts), some dragging a chain rattle,
// after a lever throws; arriving ones seat with a clink and the big ones with a clank, each when it lands.
function transitionSounds(name) {
  const n = meshes.length;
  if (name === "out") sound.play("lever", { gain: 0.6, rate: 0.8, lowpass: dull() });
  meshes.forEach((mesh, i) => {
    const delay = mesh.userData.out.delay;
    const pan = Math.max(-0.8, Math.min(0.8, mesh.matrixWorld.elements[12] * 1.2));
    const geo = mesh.geometry;
    if (geo?.isBufferGeometry && !geo.boundingSphere) geo.computeBoundingSphere();
    const size = Math.min(1, (geo?.boundingSphere?.radius ?? 0.15) / 0.4);
    const rate = 1.25 - 0.55 * size + 0.1 * nativeRandom();
    if (name === "out") {
      const at = 0.12 + DURATION.out * 0.25 * delay;
      sound.play("clank", { gain: 0.25 + 0.35 * size, delay: at, pan, rate, lowpass: dull() });
      if (i % 3 === 1) sound.play("chain", { gain: 0.25, delay: at + 0.08, pan, rate: 0.9 + 0.2 * nativeRandom(), lowpass: dull() });
    } else {
      const at = DURATION.in * (1 - 0.25 * delay);
      sound.play(i === n - 1 ? "latch" : "clink", { gain: 0.45, delay: at, pan, rate: 0.9 + 0.25 * nativeRandom(), lowpass: dull() });
      if (size > 0.4) sound.play("clank", { gain: 0.3 * size, delay: at, pan, rate: rate * 0.9, lowpass: dull() });
    }
  });
}

function install() {
  finished = finishKey();
  L = lookFromParams();
  lastLook = JSON.stringify(L);
  if (params.studio() !== lastStudio) {
    lastStudio = params.studio();
    useStudio(lastStudio);
  }
  buildScene(createMachine({ ...machineOptions(), ...finishOptions() }));
  const s = motionState;
  s.time = 0;
  s.offset = 0;
  s.q = escapement(0).wheel;
  s.v = 0;
  s.stuck = true;
  s.threshold = newThreshold(params.rust());
  phase.name = "in";
  phase.t = 0;
  transitionSounds("in");
}

const _m = new Matrix4(), _r = new Matrix4(), _t = new Matrix4(), _p = new Vector3(), _c = new Vector3(), _d = new Vector3();
const ease = (t) => t * t * (3 - 2 * t);

// The extra transform taking a part from its seat (k = 0) to far away (k = 1): first off its axle, then away.
function away(out, k, centre) {
  const slide = Math.min(1, k * 2.2), drift = Math.max(0, k * 1.6 - 0.35);
  _p.copy(out.slide).multiplyScalar(0.35 * ease(slide)).addScaledVector(out.drift, 3.2 * drift * drift);
  _r.makeRotationAxis(out.spin, 1.6 * drift * drift);
  _m.makeTranslation(-centre.x, -centre.y, -centre.z).premultiply(_r);
  return _m.premultiply(_t.makeTranslation(centre.x + _p.x, centre.y + _p.y, centre.z + _p.z));
}

// Each part's share of the transition, staggered by its delay.
function stagger(k, delay) {
  return Math.min(1, Math.max(0, (k - delay * 0.25) / 0.75));
}

// The pipeline averages frames into a still while time stands still (paused), and only sees the camera and time
// change: parts that move then (dragged, or arriving) would smear across the average, so any pose change restarts it.
const lastPose = { q: NaN, anchor: NaN, k: NaN, lifted: NaN };
function poseAll() {
  const s = motionState;
  const kk = phase.name === "out" ? phase.t : phase.name === "in" ? 1 - phase.t : phase.name === "empty" ? 1 : 0;
  if (s.q !== lastPose.q || s.anchor !== lastPose.anchor || kk !== lastPose.k || s.lifted !== lastPose.lifted) {
    Object.assign(lastPose, { q: s.q, anchor: s.anchor, k: kk, lifted: s.lifted });
    pipeline.restartAccumulation(false);
  }
  const k = kk;
  for (const mesh of meshes) {
    const part = mesh.userData.part;
    if (part.kind === "chain") {
      poseChain(mesh, part, s.q);
      mesh.matrix.identity();
    } else mesh.matrix.copy(part.pose(s.q, s.anchor));
    // The anchor and pendulum slide along their arbor, clear of the wheel, while a gear is turned by hand.
    if (part.swing && s.lifted > 0) {
      _d.set(...(part.axle?.dir ?? [0, 0, 1])).normalize().multiplyScalar(0.06 * ease(s.lifted));
      mesh.matrix.premultiply(_t.makeTranslation(_d.x, _d.y, _d.z));
    }
    const kk = k > 0 ? stagger(k, mesh.userData.out.delay) : 0;
    if (k > 0) mesh.matrix.premultiply(away(mesh.userData.out, kk, _c.setFromMatrixPosition(mesh.matrix)));
    // Leaving parts dissolve as they go; arriving ones appear as they settle into place.
    (mesh.material ?? mesh.userData.material).uniforms.visible.value = 1 - Math.min(1, kk * 1.4);
  }
  for (const mesh of axleMeshes) {
    mesh.matrix.copy(mesh.userData.base);
    const kk = k > 0 ? stagger(k, mesh.userData.out.delay) : 0;
    if (k > 0) mesh.matrix.premultiply(away(mesh.userData.out, kk, _c.setFromMatrixPosition(mesh.matrix)));
    mesh.material.uniforms.visible.value = 1 - Math.min(1, kk * 1.4);
  }
}

// With auto change on, each machine ages from new to the panel's settings over its time on show, eased, finishing a
// couple of seconds before the next change.
const ramp = { t: 0 };
function update(dt) {
  if (machineKey() !== shown && (phase.name === "run" || phase.name === "empty")) begin();
  // Chamfer and wear change the parts' shapes, not the layout: rebuilt in place, the motion carrying on.
  else if (finishKey() !== finished && phase.name === "run") {
    finished = finishKey();
    const keep = { ...motionState };
    buildScene(createMachine({ ...machineOptions(), ...finishOptions() }));
    Object.assign(motionState, keep);
    pipeline.restartAccumulation();
  }
  if (phase.name === "out") {
    phase.t = Math.min(1, phase.t + dt / DURATION.out);
    if (phase.t >= 1) {
      if (clearing) phase.name = "empty";
      else install();
    }
  } else if (phase.name === "in") {
    phase.t = Math.min(1, phase.t + dt / DURATION.in);
    if (phase.t >= 1) {
      phase.name = "run";
      autoChange.restart();
    }
  }
  // (The old machine leaves as it was.)
  if (params.auto() && !timelapse.on && phase.name !== "out") {
    ramp.t = phase.name === "run" ? ramp.t + dt : 0;
    const k = Math.min(1, ramp.t / Math.max(1, params.autoTime() - 2));
    params.age.set(k * k * (3 - 2 * k));
  }
  if (machine && phase.name !== "out" && phase.name !== "empty") stepMotion(dt);
  if (machine) poseAll();
}

// ——— Turning a gear by hand ———

const raycaster = new Raycaster();
const ndc = new Vector2();
const drag = { mesh: null, plane: new Plane(), axis: new Vector3(), centre: new Vector3(), u: new Vector3(), w: new Vector3(), last: 0, ratio: 1 };
const canvas = renderer.domElement;

function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

// The pointer's angle about the dragged gear's axle.
function pointerAngle(e) {
  setRay(e);
  const hit = raycaster.ray.intersectPlane(drag.plane, _p);
  if (!hit) return null;
  hit.sub(drag.centre);
  return Math.atan2(hit.dot(drag.w), hit.dot(drag.u));
}

canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (phase.name !== "run") return;
    setRay(e);
    for (const m of meshes) m.updateMatrixWorld();
    const hits = raycaster.intersectObjects(meshes, false);
    const part = hits[0]?.object.userData.part;
    if (!part || !part.draggable || !part.ratio || !part.axle) return;
    drag.mesh = hits[0].object;
    drag.ratio = part.ratio;
    drag.teeth = part.build?.args?.teeth ?? 20;
    sound.play("latch", { gain: 0.4, lowpass: dull() });
    drag.axis.set(...part.axle.dir).applyAxisAngle(_yAxis, rig.rotation.y).normalize();
    drag.centre.set(...part.axle.origin).applyAxisAngle(_yAxis, rig.rotation.y);
    drag.u.crossVectors(drag.axis, Math.abs(drag.axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
    drag.w.crossVectors(drag.axis, drag.u);
    drag.plane.setFromNormalAndCoplanarPoint(drag.axis, hits[0].point);
    drag.last = pointerAngle(e) ?? 0;
    motionState.dragging = true;
    motionState.dragTarget = motionState.q;
    controls.enabled = false;
  },
  { capture: true },
);
canvas.addEventListener("pointermove", (e) => {
  if (!drag.mesh) return;
  const a = pointerAngle(e);
  if (a === null) return;
  let d = a - drag.last;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  drag.last = a;
  motionState.dragTarget += d / drag.ratio;
  // A ratchet click for every tooth that passes under the hand.
  drag.travel = (drag.travel ?? 0) + Math.abs(d);
  const toothAngle = (2 * Math.PI) / Math.max(8, drag.teeth ?? 20);
  if (drag.travel > toothAngle) {
    drag.travel %= toothAngle;
    sound.play("ratchet", { gain: 0.5, rate: 0.9 + 0.2 * nativeRandom(), lowpass: dull() });
  }
});
const release = () => {
  if (!drag.mesh) return;
  drag.mesh = null;
  motionState.dragging = false;
  controls.enabled = true;
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

onRandomize(() => {
  gui.randomizeAll();
  // A new machine always shows some rust.
  if (params.rust() < 0.35) params.rust.set(0.35 + Math.random() * 0.6);
});
applyUrlState();

textures = await rustTextures;
lastStudio = params.studio();
await load.studio.track(useStudio(lastStudio));
await load.machine.track(Promise.resolve().then(begin));
poseAll();
await load.compile.track(pipeline.compileAsync(scene, camera), 3);

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  phase,
  motion: motionState,
  scene,
  sound,
  // The next machine: a seed (string), none ({ clear: true }: the studio left empty) or a random one.
  nextLook: (look) => (look?.clear ? clear() : typeof look === "string" ? loadSeed(look) : randomize()),
  // Replays the current machine's arrival, for recordings that open on it.
  arrive: () => {
    phase.name = "in";
    phase.t = 0;
    frame.t = 0;
    transitionSounds("in");
  },
  // The direction that shows most of the current machine (unit vector from its centre).
  bestView: () => machine && bestView(machine, motionState.q, motionState.anchor),
  get machine() {
    return machine;
  },
};


render(({ time, dt }) => {
  const now = performance.now();
  fps.frames++;
  if (now - fps.since > 500) {
    fps.value.set(Math.round((fps.frames * 1000) / (now - fps.since)));
    fps.frames = 0;
    fps.since = now;
  }
  if (timelapse.on) {
    timelapse.t = Math.min(1, timelapse.t + dt / timelapse.duration);
    params.age.set(timelapse.t * timelapse.t * (3 - 2 * timelapse.t));
    autoChange.restart();
    if (timelapse.t >= 1) timelapse.on = false;
  }
  autoChange.update(dt);
  // A new machine pending or leaving: keep the old one's look and studio until it's gone.
  const changing = machineKey() !== shown || phase.name === "out";
  if (!changing) {
    if (params.studio() !== lastStudio) {
      lastStudio = params.studio();
      useStudio(lastStudio);
    }
    const next = lookFromParams();
    const look = JSON.stringify(next);
    if (look !== lastLook) {
      lastLook = look;
      L = next;
      for (const m of allMaterials()) setLook(m);
      pipeline.restartAccumulation();
    }
  }
  update(dt);
  // Framing: the camera holds a three-quarter view against the key light; the machine turns slowly on its spot, timed
  // so that its best side faces the camera halfway through the show (it starts half a show's turn before it and ends
  // half a turn after). The camera fits it tightly from where it is. Orbiting by hand frees the camera.
  if (frame.dir && phase.name !== "out") {
    frame.t += dt;
    const show = DURATION.in + params.autoTime();
    const camDir = cameraDirection(frame.dir);
    rig.rotation.y = frame.turn + ORBIT_SPEED * (frame.t - show / 2);
    if (!frame.free && !drag.mesh) {
      // The fit in the machine's own space: the camera direction turned back by the rig's angle.
      const local = camDir.clone().applyAxisAngle(_yAxis, -rig.rotation.y);
      const want = fitDistance(frame.points, frame.target, local, camera.fov, camera.aspect, 0.94);
      frame.distance = frame.t < 0.05 ? want : frame.distance + (want - frame.distance) * Math.min(1, dt * 1.5);
      const target = frame.target.clone().applyAxisAngle(_yAxis, rig.rotation.y);
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(camDir, frame.distance);
    }
  }
  updateStudioFade(dt || 1 / 60);
  backdrop.update(dt || 1 / 60);
  controls.update();
  // Roll on top of the orbit controls' upright view, eased out while the camera is free.
  frame.roll = (frame.roll ?? 0) + ((frame.free || drag.mesh ? 0 : 1) - (frame.roll ?? 0)) * Math.min(1, (dt || 0) * 2);
  frame.rollT = (frame.rollT ?? 0) + (dt || 0);
  if (frame.dir) camera.rotateZ(frame.roll * ROLL.amount * Math.sin((frame.rollT / ROLL.period) * Math.PI * 2));
  pipeline.render(scene, camera, time);
});
