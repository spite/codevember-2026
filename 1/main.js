import {
  fromDefaults,
  renderer,
  camera,
  controls,
  render,
  onResize,
  onRandomize,
  keysHelp,
  setDay,
  addKey,
  addActionButton,
  isRunning,
  onPause,
  loadSeed,
  getSeed,
  showHint,
  showSoundHint,
  loadingStep,
} from "common";
import { GUI } from "guspira";
import { createAutoChange } from "modules/autoChange.js";
import {
  Scene,
  Group,
  Mesh,
  Vector2,
  Vector3,
  Quaternion,
  Box3,
  Sphere,
  Color,
  LatheGeometry,
  BufferAttribute,
  DoubleSide,
  MathUtils,
} from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { loadPaperTexture, paperUniforms, paperGLSL } from "modules/materials/paper.js";
import { solids, families, kis } from "modules/polyhedra/solids.js";
import { FoldedPaper, easeInOutCubic } from "modules/polyhedra/FoldedPaper.js";
import { NetMorph } from "modules/polyhedra/NetMorph.js";
import { Physics } from "modules/physics/Physics.js";
import { createPointer } from "modules/physics/pointer.js";
import { createPaperSound } from "./sound.js";
import { nativeRandom, seededRandom } from "modules/random.js";

// What "mixed" draws from.
const MIXED = [...families.platonic, "truncatedDodecahedron", "truncatedIcosahedron"];

const shapeNames = [
  "mixed",
  ...families.platonic,
  "cuboctahedron",
  "truncatedTetrahedron",
  "truncatedOctahedron",
  "truncatedDodecahedron",
  "truncatedIcosahedron",
  "rhombicDodecahedron",
  "triakisTetrahedron",
  "smallStellatedDodecahedron",
];

const defaults = {
  solid: "mixed",
  variant: "plain",
  colors: "accents",
  count: 7,
  size: 0.85,
  homeStrength: 2.5,
  bounce: 0.35,
  drift: 1.5,
  spin: 0.3,
  creaseAmount: 0.6,
  auto: true,
  autoTime: 15,
};

const params = fromDefaults(defaults);
// Load progress: the paper's textures, Ammo, the sounds, the studio and the shader programs.
const load = { paper: loadingStep(1), physics: loadingStep(2), sound: loadingStep(1), studio: loadingStep(1), compile: loadingStep(4) };
const touch = matchMedia("(pointer: coarse)").matches;

const FLOOR_Y = -3.1;
const PAPER = 0xf0ebe0;
const BACKDROP = 0xd2d1ce;
// Origami paper; saturated enough for the bounce to show on neighbours and the floor.
const PAPERS = [
  0xd8432f, // vermilion
  0xec8a2c, // orange
  0xebc23c, // yellow
  0x356cb8, // blue
  0x2f9a8a, // teal
  0xe2879d, // pink
  0x6a4c9c, // violet
  0x1f3f78, // navy
  0x7fae5e, // leaf green
  0xc23f6e, // magenta
  0x8fb8d8, // sky
  0xc98a4b, // ochre
  0xb8322e, // crimson
  0x9fc5a8, // mint
  0xd9b98f, // kraft
  0x3a3a40, // charcoal
];

const pipeline = new Pipeline(renderer, {
  background: BACKDROP,
  exposure: 1.8,
  bloomStrength: 0.02,
  vignette: 0.12,
  grain: 0.025,
  shadow: { autoFit: false, denoise: true },
  giOptions: { thickness: 1.2 },
});
pipeline.gi.radius = 2.4;
// Wider denoise: paper bounce is diffuse, never a sharp image of the neighbour.
pipeline.gi.blurPasses = 4;
globalUniforms.giIntensity.value = 1.2;
globalUniforms.aoIntensity.value = 1;
globalUniforms.aoPower.value = 1.3;
globalUniforms.aoDirect.value = 0.2;
globalUniforms.aoColor.value.setRGB(0.04, 0.04, 0.042);
// Open flaps and deep pockets keep some light.
globalUniforms.aoMin.value = 0.18;
globalUniforms.occluderStrength.value = 2.2;
globalUniforms.occluderReach.value = 4;
// The studio env already reflects the key softbox.
globalUniforms.lightSpecular.value = 0;
globalUniforms.specularShadow.value = 1;

// Compiles in the background while the rest is set up; awaited before the first frame.
const studio = createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(-0.6, 0.85, 0.2),
  keyIntensity: 17,
  keySize: 0.45,
  fill: 0.4,
  fillColor: 0xfbfaf7,
  floor: 0.4,
  wall: 0.5,
  ceiling: 0.03,
  tint: 0xfdfdfd,
});

const sound = createPaperSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Sounds already scheduled freeze with the animation.
onPause((running) => sound.setPaused(!running));

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
gui.addSelect("Solid", params.solid, shapeNames);
gui.addSelect("Faces", params.variant, ["plain", "pyramids", "inverted", "mixed"]);
gui.addSelect("Colors", params.colors, ["white", "accents", "colorful"]);
gui.addSlider("Count", params.count, 3, 12, 1);
gui.addSlider("Size", params.size, 0.5, 1.2, 0.01);
gui.addSlider("Home spring", params.homeStrength, 0.2, 6, 0.01);
gui.addSlider("Bounce", params.bounce, 0, 0.9, 0.01);
gui.addSlider("Drift", params.drift, 0, 4, 0.01);
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Crease", params.creaseAmount, 0, 1, 0.01);
// Counts once the new shapes have folded up.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => !transition && key() === builtKey });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(
  touch
    ? "Drag a shape to throw it, tap to scatter. Drag empty space to orbit, pinch to zoom."
    : `Drag a shape to throw it, tap to scatter.<br/>${keysHelp()}`,
);
showHint("Drag a shape to throw it · drag the backdrop to orbit · R for new shapes", "Drag a shape to throw it · tap {randomize} for new ones");
showSoundHint();
gui.show();

const scene = new Scene();

const paperTexture = await load.paper.track(loadPaperTexture(renderer, { tile: 0.35 }));

const paper = new PipelineMaterial({
  color: PAPER,
  roughness: 0.85,
  sheen: 0.3,
  sheenColor: 0xffffff,
  sheenRoughness: 0.6,
  transmission: 0.25,
  transmissionColor: 0xfff2e0,
  side: DoubleSide,
  uniforms: {
    ...paperUniforms(paperTexture, { bump: 0.14, tone: 0.035, fibreTone: 0.035, bumpRoughness: 0.5, bumpGrazing: 1 }),
    paperFold: { value: 1 },
    creaseAmount: { value: defaults.creaseAmount },
  },
  varyings: { vCrease: "float", vValley: "vec2" },
  vertexPars: "in float crease;\nin vec2 valley;\nuniform float paperFold;",
  // Valley depth eases in with the fold (FoldedPaper's staticValley; same curve as easeInOutCubic).
  vertexMain: /* glsl */ `
vCrease = crease;
float paperRise = 2.0 - 2.0 * paperFold;
vValley = vec2(valley.x, valley.y * (paperFold < 0.5 ? 4.0 * paperFold * paperFold * paperFold : 1.0 - 0.5 * paperRise * paperRise * paperRise));
`,
  fragmentPars: paperGLSL + "uniform float paperFold;\nuniform float creaseAmount;",
  surface: /* glsl */ `
void surface(inout Surface s) {
  float c = abs(vCrease);
  // No bump across the fillet, where the narrow strip makes screen derivatives unreliable.
  applyPaper(s, vUv, 1.0 - smoothstep(0.2, 0.8, c));
  // Mountain folds are faintly burnished, broken up by the paper's grain; valleys slightly shut in.
  float grain = smoothstep(0.35, 0.65, texture(paperMap, vUv / paperTile).r);
  s.roughness = clamp(s.roughness - 0.08 * max(vCrease, 0.0) * grain, 0.0, 1.0);
  if (vCrease < 0.0) s.occlusion *= 1.0 - 0.15 * c;
  // Long soft gradient into concave creases, deeper for sharper bends.
  s.occlusion *= mix(1.0 - creaseAmount * sqrt(vValley.y), 1.0, smoothstep(0.0, 0.8, vValley.x));
  s.albedo *= 1.0 - 0.03 * smoothstep(0.85, 1.0, c);
  // The inside of a closed shape, seen through a seam, is dim.
  if (!gl_FrontFacing) {
    float closed = smoothstep(0.85, 1.0, paperFold);
    s.albedo *= 1.0 - 0.75 * closed;
    s.sheenColor *= 1.0 - closed;
  }
}
`,
});

// Seamless cyc: floor disc sweeping up into a round wall, with the bend in view behind the shapes.
const CYC_FLOOR = 10;
const CYC_ARC = 5;
const CAMERA_MAX = 14;

// Inner radius of the cyc at height y: the flat floor out to CYC_FLOOR, then the quarter-circle sweep.
function cycRadiusAt(y) {
  const h = Math.min(Math.max(y - FLOOR_Y, 0), CYC_ARC);
  return CYC_FLOOR + Math.sqrt(Math.max(CYC_ARC * CYC_ARC - (CYC_ARC - h) ** 2, 0));
}

// Low orbits meet the sweep sooner, so the camera is pulled in to stay in front of it.
function keepInsideCyc() {
  const p = camera.position;
  // Pulling in also lowers y below the target, so iterate to settle on the curve.
  for (let i = 0; i < 4; i++) {
    const limit = cycRadiusAt(p.y) - 1.2;
    const r = Math.hypot(p.x, p.z);
    if (r <= limit) break;
    p.multiplyScalar(limit / r);
  }
}
// `cycS` is the arc length along the profile from the centre, so shading can follow the sweep.
function cycGeometry() {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push(new Vector2((CYC_FLOOR * i) / 12, FLOOR_Y));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(CYC_FLOOR + CYC_ARC * Math.sin(a), FLOOR_Y + CYC_ARC * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 6; i++) points.push(new Vector2(CYC_FLOOR + CYC_ARC, FLOOR_Y + CYC_ARC + i * 25));
  const geometry = new LatheGeometry(points, 128);
  const pos = geometry.attributes.position;
  const arc = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const rho = Math.hypot(pos.getX(i), pos.getZ(i));
    const y = pos.getY(i) - FLOOR_Y;
    if (y < 1e-4) arc[i] = rho;
    else if (y < CYC_ARC) arc[i] = CYC_FLOOR + CYC_ARC * Math.asin(Math.min(1, (rho - CYC_FLOOR) / CYC_ARC));
    else arc[i] = CYC_FLOOR + CYC_ARC * Math.PI * 0.5 + y - CYC_ARC;
  }
  geometry.setAttribute("cycS", new BufferAttribute(arc, 1));
  return geometry;
}

const backdrop = new PipelineMaterial({
  color: BACKDROP,
  defines: { FLOOR_Y: FLOOR_Y.toFixed(3) },
  roughness: 0.95,
  side: DoubleSide,
  uniforms: {
    cycSweep: { value: new Vector2(CYC_FLOOR - 1, CYC_FLOOR + CYC_ARC * 1.2) },
    backdropLevel: { value: 0.3 },
    wallFill: { value: 0.2 },
    cycTop: { value: 0.8 },
    cycFall: { value: new Vector2(0.4, 1) },
    poolStrength: { value: 0.6 },
  },
  varyings: { vCycS: "float" },
  vertexPars: "in float cycS;",
  vertexMain: "vCycS = cycS;",
  fragmentPars: /* glsl */ `
uniform vec2 cycSweep;
uniform float backdropLevel;
uniform float wallFill;
uniform float cycTop;
uniform vec2 cycFall;
uniform float poolStrength;
`,
  surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo *= backdropLevel;
  // The key barely reaches the wall, so a soft fill rises along the sweep; the bend still reads as a gradient.
  vec3 L = normalize(lightDirection);
  vec3 open = s.albedo * (lightColor * max(L.y, 0.0) * 0.3183 + max(evalSH(vec3(0.0, 1.0, 0.0)), vec3(0.0)) * envIntensity);
  float w = smoothstep(cycSweep.x, cycSweep.y, vCycS);
  float up = gl_FragCoord.y / resolution.y;
  s.emissive += open * w * wallFill * mix(1.0, cycTop, smoothstep(cycFall.x, cycFall.y, up));
  // Denser contact pool under low shapes.
  float pool = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= occluderCount) break;
    vec4 o = occluders[i];
    if (o.w <= 0.0) continue;
    float gap = max(o.y - o.w - FLOOR_Y, 0.05);
    float d = length(vWorldPosition.xz - o.xz) / (o.w + 0.5 * gap);
    float k = o.w / (o.w + gap);
    pool *= 1.0 - poolStrength * k * k * exp(-2.0 * d * d);
  }
  s.occlusion *= pool;
}
`,
});

const cyc = new Mesh(cycGeometry(), backdrop);
cyc.userData.noShadow = true;
// Drawn after the shapes, so its shading is skipped where they cover it.
cyc.renderOrder = 1;
scene.add(cyc);

const physics = await load.physics.track(Physics.create({ damping: 0.08, angularDamping: 0.12 }));
physics.addPlane({ x: 0, y: 1, z: 0 }, FLOOR_Y);
const pointer = createPointer({
  physics,
  camera,
  domElement: renderer.domElement,
  controls,
  grabAtPoint: true,
});

camera.near = 0.5;
camera.far = 80;
camera.position.set(0, 2.4, 11);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = CAMERA_MAX;
controls.minPolarAngle = Math.PI * 0.12;
controls.maxPolarAngle = Math.PI * 0.55;

// Phones held upright get a tall layout instead of a wide one.
const portrait = () => innerWidth < innerHeight;
const layoutSpread = () => (portrait() ? new Vector3(1.7, 2.6, 1.2) : new Vector3(3.4, 2.0, 1.3));

// Keeps the whole cluster in frame at any aspect ratio.
onResize((w, h, dpr) => {
  const t = Math.tan((camera.fov * Math.PI) / 360);
  const s = layoutSpread();
  camera.position.setLength(Math.min(CAMERA_MAX, Math.max((s.y + 1.6) / t, (s.x + 1.6) / (t * (w / h)))));
  pipeline.setSize(w, h, dpr);
});

const group = new Group();
scene.add(group);

let shapes = [];

// Cached, so every shape of a solid shares one object (and its unfolding data).
const solidCache = new Map();
function solidFor(name, variant) {
  const key = `${name}|${variant}`;
  if (!solidCache.has(key)) {
    const base = solids[name];
    solidCache.set(key, variant === "pyramids" ? kis(base, 0.35) : variant === "inverted" ? kis(base, -0.18) : base);
  }
  return solidCache.get(key);
}

// Rejection-samples home positions inside an ellipsoid so shapes start apart.
function placeHomes(radii) {
  const homes = [];
  const spread = layoutSpread();
  for (const r of radii) {
    let best = null;
    let bestGap = -Infinity;
    for (let i = 0; i < 60; i++) {
      const p = new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (p.lengthSq() > 1) continue;
      p.multiply(spread);
      p.y = Math.max(p.y, FLOOR_Y + r + 0.2);
      let gap = Infinity;
      homes.forEach((h, j) => (gap = Math.min(gap, h.distanceTo(p) - r - radii[j])));
      if (gap > bestGap) {
        bestGap = gap;
        best = p;
      }
      if (gap > 0.05) break;
    }
    homes.push(best ?? new Vector3());
  }
  return homes;
}

function clearShapes() {
  for (const s of shapes) {
    physics.remove(s.entry);
    group.remove(s.object);
    s.paper.dispose();
  }
  shapes = [];
}

const materials = new Map([[PAPER, paper]]);
function paperMaterial(color) {
  if (!materials.has(color)) {
    const m = paper.clone();
    m.color = color;
    materials.set(color, m);
  }
  return materials.get(color);
}

const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

// White stays the minority in the coloured modes: accents use one or two hues, colorful cycles the palette.
function pickColors(count) {
  const mode = params.colors();
  if (mode === "white") return new Array(count).fill(PAPER);
  const hues = shuffle([...PAPERS]);
  const share = mode === "accents" ? 0.15 + Math.random() * 0.25 : Math.random() * 0.25;
  const whites = Math.min(Math.floor(count * share), Math.ceil(count / 2) - 1);
  const used = mode === "accents" ? hues.slice(0, Math.random() < 0.5 ? 1 : 2) : hues;
  const colors = Array.from({ length: count }, (_, i) => (i < whites ? PAPER : used[(i - whites) % used.length]));
  return shuffle(colors);
}

// Every random draw for a layout happens here, from the seed alone, so a link with the same seed and params rebuilds it.
function planShapes() {
  const random = Math.random;
  Math.random = seededRandom(`${getSeed()}:layout`);
  try {
    return planLayout();
  } finally {
    Math.random = random;
  }
}

function planLayout() {
  const count = Math.round(params.count());
  const name = shapeNames.includes(params.solid()) ? params.solid() : "mixed";
  const radii = [];
  const picks = [];
  for (let i = 0; i < count; i++) {
    picks.push(name === "mixed" ? MIXED[Math.floor(Math.random() * MIXED.length)] : name);
    radii.push(params.size() * (0.75 + Math.random() * 0.45));
  }
  const homes = placeHomes(radii);
  const colors = pickColors(count);
  const variants = ["plain", "pyramids", "inverted"];
  const variantOf = () => (params.variant() === "mixed" ? variants[Math.floor(Math.random() * 3)] : params.variant());
  return picks.map((pick, i) => ({
    pick,
    variant: variantOf(),
    radius: radii[i],
    home: homes[i],
    quaternion: new Quaternion().random(),
    axis: new Vector3().randomDirection(),
    rate: 0.5 + Math.random(),
    seed: Math.floor(Math.random() * 1e6),
    color: colors[i],
    geometry: null,
  }));
}

// Crease sets the fold fillet width: 0 is a sharp fold, the default 0.6 gives 0.07 of the edge.
const creaseRadius = () => 0.12 * params.creaseAmount();

const paperOptions = (item, fold) => ({
  size: item.radius,
  creaseRadius: creaseRadius(),
  foldingCreaseRadius: Math.max(0.1, 1.43 * creaseRadius()),
  // Lighter meshes on touch devices: folding updates every vertex on the CPU.
  creaseSegments: touch ? 4 : 6,
  faceSubdivisions: touch ? 1 : 2,
  adaptiveRings: true,
  pillow: 0.012,
  creaseJitter: 0.35,
  cornerRound: 0.04,
  staticValley: true,
  seed: item.seed,
  fold,
});

function planGeometry(item, fold) {
  item.geometry ??= new FoldedPaper(solidFor(item.pick, item.variant), paperOptions(item, fold));
  return item.geometry;
}

function setPaperFold(mesh) {
  mesh.onBeforeRender = (r, sc, cam, geo, material) => {
    material.uniforms.paperFold.value = geo.fold;
    material.uniforms.creaseAmount.value = params.creaseAmount();
    material.uniformsNeedUpdate = true;
  };
}

function commitShapes(plan, fold) {
  clearShapes();
  for (const item of plan) {
    const geometry = planGeometry(item, fold);
    const mesh = new Mesh(geometry, paperMaterial(item.color));
    setPaperFold(mesh);
    const object = new Group();
    object.add(mesh);
    object.position.copy(item.home);
    object.quaternion.copy(item.quaternion);
    group.add(object);
    const entry = physics.addConvex(object, geometry.hullPoints(), {
      mass: item.radius ** 3,
      home: item.home,
      homeQuaternion: object.quaternion.clone(),
      kinematic: fold < SOLID_FOLD,
    });
    shapes.push({ object, mesh, paper: geometry, entry, axis: item.axis, rate: item.rate, color: item.color });
  }
  applyFold(fold);
}

function applyFold(t) {
  for (const s of shapes) {
    s.fold = t;
    s.paper.setFold(t);
    s.mesh.scale.setScalar(flatScale(t));
  }
}

const flatScale = (t) => 0.6 + 0.4 * easeInOutCubic(Math.min(1, t * 1.6));

// Rotating a phone re-lays the shapes out for the new orientation.
const key = () => [params.solid(), params.variant(), params.colors(), Math.round(params.count()), params.size(), portrait()].join();

let builtKey = null;
let transition = null;
const UNFOLD = 1.1;
const MORPH = 1.8;
const REFOLD = 1.8;
// Bodies are kinematic below this fold, where the mesh no longer matches the folded hull.
const SOLID_FOLD = 0.65;
// Milliseconds of geometry JS per frame while the old shapes unfold; building gets what their fold leaves.
const GEOMETRY_BUDGET = 5;

function setKinematic(kinematic) {
  for (const s of shapes) physics.setKinematic(s.entry, kinematic);
}

// New geometry is drawn empty for one frame while the old shapes unfold, so its upload doesn't land on the frame it first shows.
const uploads = [];
const uploader = new Group();
scene.add(uploader);
function startUploads() {
  for (const geometry of uploads.splice(0, 2)) {
    const mesh = new Mesh(geometry, paper);
    mesh.frustumCulled = false;
    mesh.userData.count = geometry.drawRange.count;
    geometry.drawRange.count = 0;
    uploader.add(mesh);
  }
}
function endUploads() {
  for (const mesh of uploader.children) mesh.geometry.drawRange.count = mesh.userData.count;
  uploader.clear();
}

// One flat sheet per pair (old shape, new plan item), either side possibly missing.
function buildSheet(tr, i, geometry) {
  const from = shapes[i];
  const to = tr.plan[i];
  const material = paper.clone();
  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(flatScale(0));
  setPaperFold(mesh);
  const object = new Group();
  object.add(mesh);
  object.visible = false;
  group.add(object);
  tr.sheets[i] = {
    object,
    mesh,
    geometry,
    material,
    fromColor: new Color(from ? from.color : to.color),
    toColor: new Color(to ? to.color : from.color),
    fromPos: (from ? from.object.position : to.home).clone(),
    fromQuat: (from ? from.object.quaternion : to.quaternion).clone(),
    toPos: (to ? to.home : from.object.position).clone(),
    toQuat: (to ? to.quaternion : from.object.quaternion).clone(),
  };
  uploads.push(geometry);
  if (to) uploads.push(to.geometry);
}

function disposeSheets(tr) {
  uploads.length = 0;
  for (const sh of tr.sheets) {
    if (!sh) continue;
    group.remove(sh.object);
    sh.geometry.dispose();
    sh.material.dispose();
  }
  tr.sheets = [];
}

// New geometry and its sheet per pair, as small resumable steps.
function* buildSteps(tr) {
  for (let i = 0; i < tr.total; i++) {
    const to = tr.plan[i];
    if (to && !to.geometry) to.geometry = yield* FoldedPaper.create(solidFor(to.pick, to.variant), paperOptions(to, 0));
    const from = shapes[i];
    const geometry = yield* NetMorph.create(from ? from.paper.flatOutline() : null, to ? to.geometry.flatOutline() : null, { via: "square", bulge: 0.05 });
    buildSheet(tr, i, geometry);
    yield;
  }
}

function pumpBuild(tr, spent) {
  const end = performance.now() + Math.max(0.5, GEOMETRY_BUDGET - spent);
  while (!tr.built) {
    if (tr.build.next().done) tr.built = true;
    else if (performance.now() >= end) break;
  }
}

const _ndc = new Vector3();
const panAt = (p) => Math.max(-1, Math.min(1, _ndc.copy(p).project(camera).x * 0.8));

// One crease per shape, scattered over the phase, so a fold reads as many hands at work.
function creaseSounds(list, duration, gain) {
  list.forEach((o, i) => {
    const delay = (duration * 0.8 * (i + nativeRandom())) / Math.max(1, list.length);
    sound.play("crease", { gain, pan: panAt(o.position), delay });
  });
}

function contactSounds() {
  for (const c of physics.contacts) {
    // Impulses span orders of magnitude; map them on a log scale to a soft tap.
    const g = Math.min(1, Math.log10(c.impulse / physics.minImpulse) / 2.5);
    if (g > 0.05) sound.play("tap", { gain: 0.15 + 0.6 * g, pan: panAt(_ndc.set(c.x, c.y, c.z)), rate: 1.1 - 0.2 * g });
  }
}

function startTransition() {
  if (transition) disposeSheets(transition);
  const plan = planShapes();
  transition = { phase: "unfold", time: 0, plan, sheets: [], built: false, total: Math.max(plan.length, shapes.length) };
  transition.build = buildSteps(transition);
  setKinematic(true);
  sound.play("open", { gain: 0.45 });
  creaseSounds(shapes.map((s) => s.object), UNFOLD, 0.5);
}

// A failed transition is dropped and the new layout built at once, folded.
function cancelTransition(error) {
  console.error(error);
  const tr = transition;
  transition = null;
  if (tr) disposeSheets(tr);
  builtKey = key();
  commitShapes(planShapes(), 1);
}

function updateTransition(dt) {
  const tr = transition;
  if (!tr) return;
  tr.time += dt;
  if (tr.phase === "unfold") {
    // Geometry and sheets are built a few ms per frame while the old shapes open up; the flat nets wait for them.
    const t = 1 - Math.min(1, tr.time / UNFOLD);
    const start = performance.now();
    applyFold(t);
    pumpBuild(tr, performance.now() - start);
    if (t === 0 && tr.built) {
      // Sheets about to show must keep their draw range; what's left uploads as they first draw.
      uploads.length = 0;
      // The sheets start where the old flat nets are.
      tr.sheets.forEach((sh, i) => {
        const from = shapes[i];
        if (from) {
          sh.fromPos.copy(from.object.position);
          sh.fromQuat.copy(from.object.quaternion);
        }
        sh.object.visible = true;
      });
      builtKey = key();
      commitShapes(tr.plan, 0);
      for (const s of shapes) s.object.visible = false;
      tr.phase = "morph";
      tr.time = 0;
      updateMorph(tr, 0);
      tr.sheets.slice(0, 5).forEach((sh, i) => sound.play("rustle", { gain: 0.45, pan: panAt(sh.object.position), delay: i * 0.12 * nativeRandom() + i * 0.05 }));
    }
  } else if (tr.phase === "morph") {
    const t = Math.min(1, tr.time / MORPH);
    updateMorph(tr, t);
    if (t === 1) {
      disposeSheets(tr);
      for (const s of shapes) s.object.visible = true;
      tr.phase = "fold";
      tr.time = 0;
      creaseSounds(shapes.map((s) => s.object), REFOLD, 0.65);
    }
  } else {
    const t = Math.min(1, tr.time / REFOLD);
    applyFold(t);
    if (t >= SOLID_FOLD) setKinematic(false);
    if (t === 1) transition = null;
  }
}

function updateMorph(tr, t) {
  const e = easeInOutCubic(t);
  tr.sheets.forEach((sh, i) => {
    // New shapes keep spinning while hidden, so the sheet lands on their live pose.
    const to = shapes[i]?.object;
    // The sheet eases each half itself, around the held square.
    sh.geometry.setMorph(t);
    sh.object.position.lerpVectors(sh.fromPos, to ? to.position : sh.toPos, e);
    sh.object.quaternion.slerpQuaternions(sh.fromQuat, to ? to.quaternion : sh.toQuat, e);
    sh.material.color.lerpColors(sh.fromColor, sh.toColor, e);
  });
}

const casters = new Box3();
const shadowBox = new Box3();
const shadowSphere = new Sphere();
const corner = new Vector3();

// Shadow bounds: the shapes plus their shadows on the floor, so PCSS sees the real gap.
// Starts from the whole layout region, so the shadow frustum (and penumbra size) stays put while shapes drift.
const layoutBox = new Box3();
function fitShadow() {
  const r = params.size() * 1.3;
  const sp = layoutSpread();
  layoutBox.min.set(-sp.x - r, FLOOR_Y, -sp.z - r);
  layoutBox.max.set(sp.x + r, sp.y + r, sp.z + r);
  casters.copy(layoutBox);
  const meshes = shapes.filter((s) => s.object.visible).map((s) => s.mesh);
  if (transition) for (const sh of transition.sheets) if (sh?.object.visible) meshes.push(sh.mesh);
  for (const mesh of meshes) {
    // The live sphere covers the flat net mid-transition; matrices are not updated until render.
    mesh.parent.updateMatrixWorld();
    shadowSphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    corner.setScalar(shadowSphere.radius);
    casters.expandByPoint(corner.add(shadowSphere.center));
    corner.setScalar(-shadowSphere.radius);
    casters.expandByPoint(corner.add(shadowSphere.center));
  }
  if (casters.isEmpty()) return;
  shadowBox.copy(casters);
  const L = globalUniforms.lightDirection.value;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? casters.max.x : casters.min.x, i & 2 ? casters.max.y : casters.min.y, i & 4 ? casters.max.z : casters.min.z);
    corner.addScaledVector(L, -Math.max(corner.y - FLOOR_Y, 0) / Math.max(L.y, 0.2));
    shadowBox.expandByPoint(corner);
  }
  shadowBox.getBoundingSphere(shadowSphere);
  pipeline.shadow.fit(shadowSphere);
}

// Soft occlusion pools under floating shapes (and between neighbours).
function updateOccluders() {
  const list = globalUniforms.occluders.value;
  const count = Math.min(shapes.length, list.length);
  for (let i = 0; i < count; i++) {
    const s = shapes[i];
    // Open nets would occlude themselves, so the sphere only grows in near the end of the fold.
    const r = s.paper.boundingRadius * s.mesh.scale.x * 0.8 * MathUtils.smoothstep(s.fold, 0.85, 1);
    list[i].set(s.object.position.x, s.object.position.y, s.object.position.z, r);
  }
  globalUniforms.occluderCount.value = count;
}

commitShapes(planShapes(), 1);
builtKey = key();

onRandomize(() => gui.randomizeAll());

// Rebuilds the paper in place once the Crease slider settles: same shapes and layout, new fillets.
let builtCrease = params.creaseAmount();
let seenCrease = builtCrease;
let creaseChanged = 0;
function updateCrease(time) {
  const value = params.creaseAmount();
  if (value !== seenCrease) {
    seenCrease = value;
    creaseChanged = time;
  }
  if (value === builtCrease || transition || time - creaseChanged < 0.25) return;
  builtCrease = value;
  for (const s of shapes) {
    const old = s.paper;
    const options = { ...old.options, creaseRadius: creaseRadius(), foldingCreaseRadius: Math.max(0.1, 1.43 * creaseRadius()), fold: old.fold };
    s.paper = s.mesh.geometry = new FoldedPaper(old.solid, options);
    old.dispose();
  }
}

const dq = new Quaternion();
let started = false;

await load.studio.track(studio);
// The samples are in before the first frame, so the first click already sounds.
await sound.downloaded;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

// Handle for scripted capture and the console: nextLook() transitions to a seed or a set of settings.
window.app = {
  canvas: renderer.domElement,
  pipeline,
  controls,
  sound,
  // Throws every shape outward from the middle of the cluster, like a tap on empty space.
  scatter(strength = 2.2) {
    physics.burst(new Vector3(0, -0.3, 0.6), new Vector3(0, 0.35, 0.25), strength, 9, "soft", 1.2);
    sound.play("rustle", { gain: 0.5 });
  },
  // A seed string, or settings ({ solid, count, ... }) applied over the defaults, like a url without a seed.
  nextLook(look) {
    if (typeof look === "string") loadSeed(look);
    else if (look) {
      params.$reset();
      params.$apply(look);
    }
  },
};

render(({ time, dt }) => {
  autoChange.update(dt);
  if (key() !== builtKey) {
    if (!started) {
      builtKey = key();
      commitShapes(planShapes(), 1);
    } else if (!transition && isRunning()) {
      // While paused the change waits, so the transition (and its sound) starts on resume.
      startTransition();
    }
  }
  started = true;
  try {
    updateTransition(dt);
    updateCrease(performance.now() / 1000);
  } catch (error) {
    cancelTransition(error);
  }

  physics.configure({
    homeStrength: params.homeStrength(),
    bounce: params.bounce(),
    idleStrength: params.drift(),
  });
  for (const s of shapes) {
    dq.setFromAxisAngle(s.axis, params.spin() * s.rate * dt);
    s.entry.homeQuaternion.premultiply(dq);
    if (s.entry.kinematic) s.object.quaternion.premultiply(dq);
  }

  pointer.update(dt);
  physics.step(dt);
  // Contacts are only refreshed by a real step.
  if (dt > 0) contactSounds();

  controls.update();
  keepInsideCyc();
  fitShadow();
  updateOccluders();
  startUploads();
  pipeline.render(scene, camera, time);
  endUploads();
});
