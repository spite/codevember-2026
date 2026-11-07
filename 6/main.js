import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, randomize, keysHelp, setDay, addKey, getSeed, applyUrlState, addActionButton, onPause } from "common";
import { GUI, signal, effect } from "guspira";
import { Scene, Mesh, Group, InstancedMesh, InstancedBufferAttribute, BufferGeometry, BufferAttribute, SphereGeometry, Matrix4, Vector2, Vector3, Color, Raycaster, Sphere, DynamicDrawUsage } from "three";
import { RoundedBoxGeometry } from "third_party/three-rounded-box.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { R, RF, RT, RC, DIAL_GAP, SCALE, setMechanismScale, PRESETS, buildLayout, randomNormals, randomNormalsSteps, rotateNormals, plateField, turntableFields, dialField, buildPiece, buildPieceSteps, buildCap, buildGear, dot, cross, normalize, angle, perpendicular } from "./layout.js";
import { Machine } from "./machine.js";
import { FINISHES, BEADS, MAX_PLATES, MAX_CIRCLES, MAX_HOLES, createShared, writePlateData, createPlateMaterial, createDialMaterial, createTurntableMaterial, createCoreMaterial, createCarriageMaterial, createBeadMaterial } from "./materials.js";
import { createBackdrop } from "./backdrop.js";
import { MOTIF_SETS, createMotifAtlas } from "./motifs.js";
import { SYMMETRIC } from "./symmetric.js";
import { createMachineSound } from "./sound.js";

const BACKDROP = "#25242a";
const FLOOR_Y = -1.45;
const MAX_NODES = 128;
const MAX_TOKENS = 80;
// How far parts fly out from the surface before they are gone, during a transformation.
const FLY = 2.6;
// How far a popped turntable or dial rises out of the sphere, showing the gears under it; plates go higher to clear the beads.
const POP = 0.15;
const PLATE_POP = 0.21;
const WELL_DEPTH = 0.12;
// Rods reach this far below the floor, so even a part at full lift is still planted in the sphere.
const ROD_BOTTOM = RF - 0.4;
// Plates are closed at the foot of their walls; rods run a little into that underside so they're joined.
const PLATE_UNDERSIDE = RF - 0.02;
const CORE_COLOR = "#050505";
// Carriage and bead sizes at mechanism scale 1; the carriage always reaches from the floor to just under the top.
const CARRIAGE = { length: 0.105, height: 0.07, width: 0.056, base: RF + 0.004 };
const BEAD_RADIUS = 0.037;
const BEAD_HEIGHT = R + 0.004;
const mobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
// Phones that report little memory or few cores start on the low tier; ?quality= (the Quality setting) overrides.
const lowEnd = mobile && ((navigator.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4);
const touch = matchMedia("(pointer: coarse)").matches;

const defaults = {
  layout: "dodecahedral rings",
  circles: 6,
  density: 0.45,
  colours: 3,
  finish: "black enamel",
  beads: "jewel",
  motifs: "arcane",
  variety: 0.7,
  engrave: 1,
  speed: 1,
  spin: 0.05,
  pops: 0.3,
  supersample: 1,
  auto: 30,
};
const params = fromDefaults(defaults);
const capture = new URLSearchParams(location.search).has("capture");

const pipeline = new Pipeline(renderer, {
  quality: lowEnd ? "low" : "auto",
  background: BACKDROP,
  exposure: 1.1,
  bloomStrength: 0.04,
  vignette: 0.3,
  grain: 0.025,
  shadow: { autoFit: true, denoise: true },
  // Mostly seen while parts fly off and back; it also softens their dithered dissolve.
  motionBlur: { shutter: 1 / 60, maxBlur: 0.03, samples: 24, reusePrepass: true },
  // Once nothing moves, jittered frames are averaged into a supersampled still, then rendering stops.
  stillSamples: 64,
});
// Medium (phones) and low (weaker phones) budgets, heaviest costs first: fewer pixels, cheaper GI, no MSAA (the
// pipeline's low tier), no motion blur or bloom, no guilloche, lighter geometry and a shorter settle.
const lite = pipeline.quality === "medium" || pipeline.quality === "low";
const low = pipeline.quality === "low";
if (lite) pipeline.motionBlur = false;
pipeline.stillSamples = low ? 8 : lite ? 16 : 64;
if (low) {
  pipeline.bloom = false;
  pipeline.gi.steps = 4;
}
globalUniforms.aoIntensity.value = 1;
globalUniforms.aoMin.value = 0.04;
globalUniforms.giIntensity.value = 1.2;
globalUniforms.lightSpecular.value = 1;
globalUniforms.specularShadow.value = 1;
globalUniforms.occluders.value[0].set(0, 0, 0, 1);
globalUniforms.occluderCount.value = 1;

const studio = createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(-0.55, 0.8, 0.45),
  keyIntensity: 16,
  keySize: 0.55,
  fill: 0.32,
  fillColor: 0xdfe4ef,
  floor: 0.22,
  wall: 0.3,
  ceiling: 0.2,
  tint: 0xfff6ec,
});

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
// Randomising picks a symmetric layout or a preset, never the free random one.
const shaped = ["symmetric", ...Object.keys(PRESETS)];
gui.addSelect("Layout", params.layout, [...shaped, "random"]).randomize = () => params.layout.set(shaped[Math.floor(Math.random() * shaped.length)]);
// The number of great circles only shapes the random layout.
gui.addSlider("Circles", params.circles, 4, 6, 1, { visibleWhen: () => params.layout() === "random" });
gui.addSlider("Bead count", params.density, 0.2, 0.6, 0.01);
gui.addSlider("Bead colours", params.colours, 2, 4, 1);
gui.addSelect("Finish", params.finish, Object.keys(FINISHES));
gui.addSelect("Beads", params.beads, Object.keys(BEADS));
gui.addSelect("Motifs", params.motifs, MOTIF_SETS);
// Randomising keeps the motifs mid to highly varied.
gui.addSlider("Motif variety", params.variety, 0, 1, 0.01).randomize = () => params.variety.set(Math.round((0.5 + Math.random() * 0.5) * 100) / 100);
gui.addSlider("Engraving", params.engrave, 0, 1.5, 0.01, { randomizable: false });
gui.addSlider("Speed", params.speed, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Spin", params.spin, 0, 0.4, 0.01, { randomizable: false });
gui.addSlider("Pop-outs", params.pops, 0, 1, 0.01, { randomizable: false });
// Renders at up to twice the resolution and averages down: the sharpest engraving, at up to four times the cost.
gui.addSlider("Supersample", params.supersample, 1, 2, 0.5, { randomizable: false });
gui.addSlider("Auto change", params.auto, 0, 120, 1, { randomizable: false });
// The pipeline's tier is fixed when it is built, so a new one reloads the page (seed and settings stay in the url).
const qualityChoice = signal(new URLSearchParams(location.search).get("quality") ?? "auto");
gui.addSelect("Quality", qualityChoice, ["auto", "high", "medium", "low"], { randomizable: false });
const startQuality = qualityChoice.peek();
effect(() => {
  const q = qualityChoice();
  if (q === startQuality) return;
  const url = new URL(location.href);
  if (q === "auto") url.searchParams.delete("quality");
  else url.searchParams.set("quality", q);
  location.replace(url);
});
pipeline.addGUI(gui);
gui.addSeparator();
const sound = createMachineSound();
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Sounds already scheduled freeze with the animation.
onPause((running) => sound.setPaused(!running));
gui.addText(
  touch
    ? "Tap turntables, dials and plates to set them moving. Drag to orbit, pinch to zoom."
    : `Click turntables, dials and plates to set them moving. Drag to orbit, scroll to zoom.<br/>${keysHelp()}`,
);
gui.show();

const scene = new Scene();
const backdrop = createBackdrop({ floorY: FLOOR_Y, color: BACKDROP });
backdrop.material.uniforms.backdropLevel.value = 0.26;
backdrop.material.uniforms.wallFill.value = 0.35;
backdrop.mesh.renderOrder = 1;
scene.add(backdrop.mesh);

const shared = createShared();
shared.lowDetail.value = low ? 1 : 0;
const motifAtlas = createMotifAtlas(renderer);
shared.motifAtlas.value = motifAtlas.texture;
const plateMaterial = createPlateMaterial(shared);
const dialMaterial = createDialMaterial(shared);
const turntableMaterial = createTurntableMaterial(shared);
const coreMaterial = createCoreMaterial(shared);
const carriageMaterial = createCarriageMaterial();
const beadMaterial = createBeadMaterial();

const rig = new Group();
rig.rotation.x = 0.18;
scene.add(rig);
const machineGroup = new Group();
rig.add(machineGroup);

coreMaterial.color.set(CORE_COLOR);
coreMaterial.metalness = 0;
const core = new Mesh(new SphereGeometry(RF, low ? 64 : lite ? 96 : 128, low ? 32 : lite ? 48 : 64), coreMaterial);
// After the parts that cover most of it, so depth testing rejects the hidden part of the core in every pass.
core.renderOrder = 0.5;
machineGroup.add(core);

// Placeholders with the attributes the real geometry has, so the programs compiled at startup match it.
function placeholder() {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
  return g;
}
const plates = new Mesh(placeholder(), plateMaterial);
const dials = new Mesh(placeholder(), dialMaterial);
plates.frustumCulled = dials.frustumCulled = false;
machineGroup.add(plates, dials);

function mergePieces(parts) {
  const steps = mergePiecesSteps(parts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
// Yields every few parts, so a rebuild can merge over several frames.
function* mergePiecesSteps(parts) {
  let vertices = 0, indices = 0;
  for (const { piece } of parts) (vertices += piece.vertexCount), (indices += piece.index.length);
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3);
  const edge = new Float32Array(vertices), plate = new Float32Array(vertices);
  const spin = new Float32Array(vertices), rider = new Float32Array(vertices);
  const index = new Uint32Array(indices);
  let v = 0, i = 0, lastYield = 0;
  for (const part of parts) {
    const { piece, id, edgeOverride } = part;
    position.set(piece.position, v * 3);
    normal.set(piece.normal, v * 3);
    if (piece.edge) edge.set(piece.edge, v);
    if (edgeOverride !== undefined) edge.fill(edgeOverride, v, v + piece.vertexCount);
    plate.fill(id ?? 0, v, v + piece.vertexCount);
    spin.fill(part.spin ?? 1, v, v + piece.vertexCount);
    rider.fill(part.rider ?? 1, v, v + piece.vertexCount);
    for (let k = 0; k < piece.index.length; k++) index[i + k] = piece.index[k] + v;
    v += piece.vertexCount;
    i += piece.index.length;
    if (i - lastYield > 60000) (lastYield = i), yield;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("normal", new BufferAttribute(normal, 3));
  geometry.setAttribute("edge", new BufferAttribute(edge, 1));
  geometry.setAttribute("plate", new BufferAttribute(plate, 1));
  geometry.setAttribute("spin", new BufferAttribute(spin, 1));
  geometry.setAttribute("rider", new BufferAttribute(rider, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.boundingSphere = new Sphere(new Vector3(), R + 0.05);
  return geometry;
}

// Angular radius of the opening in the core under a plate that pops out.
function plateHole(face) {
  return Math.max(face.dial ? face.dial + DIAL_GAP + 0.03 * SCALE : 0, Math.min(face.inradius * 0.72, 0.3));
}

// Moves a piece built around +y onto the axis c.
function aroundAxis(piece, c) {
  const e1 = perpendicular(c), e2 = cross(c, e1);
  for (const key of ["position", "normal"]) {
    const a = piece[key];
    for (let k = 0; k < a.length; k += 3) {
      const x = a[k], y = a[k + 1], z = a[k + 2];
      a[k] = e1[0] * x + c[0] * y + e2[0] * z;
      a[k + 1] = e1[1] * x + c[1] * y + e2[1] * z;
      a[k + 2] = e1[2] * x + c[2] * y + e2[2] * z;
    }
  }
  return piece;
}

// Builds the plates in small steps, so a rebuild can spread the work over frames.
function* buildGeometry(layout) {
  const plateParts = [], dialParts = [];
  for (let i = 0; i < layout.faces.length; i++) {
    const face = layout.faces[i];
    // Smaller plates need fewer samples round their rim; the turn weight keeps them dense at the rounded corners.
    const samples = Math.round(Math.min(Math.max(face.reach * 420, 72), 150) * (low ? 0.55 : lite ? 0.72 : 1));
    const piece = yield* buildPieceSteps({ seed: face.center, field: plateField(face), reach: face.reach, samples, turnWeight: 0.06, undersideStrips: 2 });
    plateParts.push({ id: i, piece });
    const c = face.center;
    const hole = plateHole(face);
    if (face.dial) {
      const dial = yield* buildPieceSteps({ seed: c, field: dialField(c, face.dial), reach: face.dial + 0.03, samples: Math.round(Math.min(Math.max(face.dial * 800, 64), 112) * (low ? 0.55 : lite ? 0.7 : 1)), topRings: 5, bottom: RF - 0.01 });
      const r = RF * Math.sin(face.dial);
      dialParts.push(
        { id: i, piece: dial },
        { id: i, edgeOverride: -2, piece: aroundAxis(buildGear({ radius: r - 0.004, teeth: Math.round(r * 380), depth: 0.007, y0: RF - 0.034, y1: RF - 0.006 }), c) },
        { id: i, edgeOverride: -2, piece: aroundAxis(buildGear({ radius: 0.018 * SCALE, y0: ROD_BOTTOM, y1: RF - 0.034, segments: 32 }), c) },
        { id: i, edgeOverride: -2, spin: -1.7, piece: aroundAxis(buildGear({ radius: r * 0.62, teeth: Math.round(r * 220), depth: 0.008, y0: RF - 0.096, y1: RF - 0.078, hole: 0.018 * SCALE }), c) },
      );
    }
    // A ring gear under every plate, seen when the plate itself pops out.
    const rh = RF * Math.sin(hole) - 0.006;
    const inner = face.dial ? RF * Math.sin(face.dial + DIAL_GAP) : 0.022 * SCALE;
    dialParts.push({ id: i, edgeOverride: -2, spin: 0, rider: 0, piece: aroundAxis(buildGear({ radius: rh, teeth: Math.round(rh * 300), depth: 0.009, y0: RF - 0.066, y1: RF - 0.046, hole: inner }), c) });
    if (!face.dial) dialParts.push({ id: i, edgeOverride: -2, spin: 0, rider: 0, piece: aroundAxis(buildGear({ radius: 0.022 * SCALE, y0: ROD_BOTTOM, y1: PLATE_UNDERSIDE + 0.006, segments: 32 }), c) });
    else {
      // With a dial in the middle, the plate stands on three pins through its ring gear instead, clear of the dial's own train.
      const pr = 0.009 * SCALE;
      // Clear of the dial's own well, inside the ring gear.
      const rp = Math.min(Math.max((inner + rh) / 2, inner + pr + 0.002 * SCALE), rh - pr);
      for (let k = 0; k < 3; k++) {
        const pin = buildGear({ radius: pr, y0: ROD_BOTTOM, y1: PLATE_UNDERSIDE + 0.006, segments: 16 });
        const a = (k / 3) * Math.PI * 2;
        for (let v = 0; v < pin.position.length; v += 3) (pin.position[v] += rp * Math.cos(a)), (pin.position[v + 2] += rp * Math.sin(a));
        dialParts.push({ id: i, edgeOverride: -2, spin: 0, rider: 0, piece: aroundAxis(pin, c) });
      }
    }
  }
  const platesGeometry = yield* mergePiecesSteps(plateParts);
  yield;
  return { plates: platesGeometry, dials: yield* mergePiecesSteps(dialParts) };
}

function turntableGeometry() {
  const parts = turntableFields().map((f) => ({ piece: buildPiece({ seed: f.seed, field: f.field, reach: f.reach, samples: low ? 40 : lite ? 48 : 64, turnWeight: 0.03, topRings: 3, bottom: RF + 0.006 }) }));
  parts.push({ piece: buildCap({ radius: RT, r: RF + 0.006, skirt: RF - 0.012, rings: 4, samples: 64 }), edgeOverride: -1 });
  // Hidden in the core until the turntable pops out: a crown wheel under the disc on a shaft.
  // The crown sits inside the cap's skirt, which narrows towards its foot.
  parts.push({ piece: buildGear({ radius: (RF - 0.012) * Math.sin(RT) - 0.003, teeth: 32, depth: 0.007, y0: RF - 0.034, y1: RF - 0.01 }), edgeOverride: -2 });
  parts.push({ piece: buildGear({ radius: 0.019 * SCALE, y0: ROD_BOTTOM, y1: RF - 0.034, segments: 32 }), edgeOverride: -2 });
  return mergePieces(parts);
}

// A smaller wheel lower on the shaft that turns the other way.
function counterGearGeometry() {
  return mergePieces([
    { piece: buildGear({ radius: 0.064 * SCALE, teeth: 18, depth: 0.009 * SCALE, y0: RF - 0.082, y1: RF - 0.062, hole: 0.019 * SCALE }), edgeOverride: -2 },
    { piece: buildGear({ radius: 0.03 * SCALE, y0: RF - 0.09, y1: RF - 0.056, segments: 32 }), edgeOverride: -2 },
  ]);
}

// A well in the core, radius 1 in x and z (scaled per opening): an open wall and a floor.
function wellGeometry() {
  const wall = buildGear({ radius: 1, y0: RF - WELL_DEPTH, y1: RF + 0.004, segments: 64, caps: false });
  for (let k = 0; k < wall.normal.length; k++) wall.normal[k] *= -1;
  for (let k = 0; k < wall.index.length; k += 3) [wall.index[k + 1], wall.index[k + 2]] = [wall.index[k + 2], wall.index[k + 1]];
  const floor = buildGear({ radius: 1, y0: RF - WELL_DEPTH - 0.01, y1: RF - WELL_DEPTH, segments: 64 });
  return mergePieces([{ piece: wall, edgeOverride: -3 }, { piece: floor, edgeOverride: -3 }]);
}
// On the well floor, a sun gear meshing with three planets (unit radius, scaled per opening).
const TRAIN = { teeth: 14, radius: 0.3, depth: 0.07, planet: 0.54 };
function trainGear() {
  return mergePieces([{ piece: buildGear({ radius: TRAIN.radius, teeth: TRAIN.teeth, depth: TRAIN.depth, y0: RF - WELL_DEPTH, y1: RF - WELL_DEPTH + 0.016, hole: 0.06 }), edgeOverride: -2 }]);
}

const turntables = new InstancedMesh(turntableGeometry(), turntableMaterial, MAX_NODES);
const counterGears = new InstancedMesh(counterGearGeometry(), turntableMaterial, MAX_NODES);
const wells = new InstancedMesh(wellGeometry(), turntableMaterial, MAX_HOLES);
const suns = new InstancedMesh(trainGear(), turntableMaterial, MAX_HOLES);
const planets = new InstancedMesh(trainGear(), turntableMaterial, MAX_HOLES * 3);
wells.count = suns.count = planets.count = 0;
function carriageGeometry() {
  const g = new RoundedBoxGeometry(CARRIAGE.length * SCALE, CARRIAGE.height, CARRIAGE.width * SCALE, 3, 0.012 * SCALE);
  return g.translate(0, CARRIAGE.base + CARRIAGE.height / 2, 0);
}
function beadGeometry() {
  return new SphereGeometry(BEAD_RADIUS * SCALE, 32, 16).translate(0, BEAD_HEIGHT - BEAD_RADIUS * (1 - SCALE), 0);
}
const carriages = new InstancedMesh(carriageGeometry(), carriageMaterial, MAX_TOKENS);
const beads = new InstancedMesh(beadGeometry(), beadMaterial, MAX_TOKENS);
// The turntables, carriages and beads are rebuilt when a layout comes with a different mechanism scale.
let mechanismScale = 1;
function setMechanism() {
  shared.mechScale.value = SCALE;
  if (SCALE === mechanismScale) return;
  mechanismScale = SCALE;
  for (const [mesh, geometry] of [[turntables, turntableGeometry()], [counterGears, counterGearGeometry()], [carriages, carriageGeometry()], [beads, beadGeometry()]]) {
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }
}
// How solid each instance is (1) or how dissolved (0), while it flies off or back.
function fadeOf(mesh) {
  if (!mesh.userData.fade) {
    mesh.userData.fade = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count).fill(1), 1);
    mesh.userData.fade.setUsage(DynamicDrawUsage);
  }
  if (mesh.geometry.getAttribute("fade") !== mesh.userData.fade) mesh.geometry.setAttribute("fade", mesh.userData.fade);
  return mesh.userData.fade;
}
for (const m of [turntables, counterGears, wells, suns, planets, carriages, beads]) {
  fadeOf(m);
  m.instanceMatrix.setUsage(DynamicDrawUsage);
  m.frustumCulled = false;
  machineGroup.add(m);
}
// Carriages get a white instance colour too, so they share the beads' shader programs.
for (let i = 0; i < MAX_TOKENS; i++) beads.setColorAt(i, new Color(1, 1, 1)), carriages.setColorAt(i, new Color(1, 1, 1));

let layout = null;
let machine = null;
let builtKey = null;
let machineBuiltKey = null;

function layoutKey() {
  return [getSeed(), params.layout(), params.circles()].join("|");
}
// Tokens and colours only restart the machine on the same layout.
function machineKey() {
  return [layoutKey(), params.density(), params.colours()].join("|");
}

function makeLayout(key) {
  const steps = makeLayoutSteps(key);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
// The random search can take a while, so a rebuild runs it in steps; the settings are read up front.
function makeLayoutSteps(key) {
  const random = seededRandom(key);
  // A preset is a list of circles, or { circles, scale } for the dense ones that need a smaller mechanism.
  let preset = params.layout() === "random" ? null : PRESETS[params.layout()];
  // "symmetric" draws one of the verified symmetric layouts from the seed.
  if (params.layout() === "symmetric") preset = SYMMETRIC[Math.floor(random() * SYMMETRIC.length)];
  setMechanismScale(preset?.scale ?? 1);
  const circles = params.circles();
  return (function* () {
    let normals;
    if (!preset) normals = yield* randomNormalsSteps(circles, random);
    else normals = rotateNormals(preset.circles ?? preset, random);
    normals ??= rotateNormals(PRESETS.icosidodecahedral, random);
    yield;
    return buildLayout(normals, { strict: false });
  })();
}
// Finds the layout, then builds its geometry; the layout is kept on rebuild.next for install().
function* layoutAndGeometry(key) {
  const next = yield* makeLayoutSteps(key);
  rebuild.next = next;
  return yield* buildGeometry(next);
}

function startMachine() {
  machineBuiltKey = machineKey();
  machine = new Machine(layout, { density: params.density(), colours: params.colours(), random: seededRandom(machineBuiltKey) });
  machine.autoRate = params.pops();
  machine.onEvent = machineSound;
  carriages.count = beads.count = Math.min(machine.tokens.length, MAX_TOKENS);
}

// previousScale is the old layout's mechanism scale over the new one: its rails keep their own width while they thin.
function setCoreCircles(next, previous, mix, previousMix = 1 - mix, previousScale = 1) {
  const N = shared.coreN.value, U = shared.coreU.value;
  for (let k = 0; k < MAX_CIRCLES * 2; k++) N[k].w = 0;
  // Circles go one after another: each one's share of the transition starts a little later than the last's.
  const put = (L, offset, weight, widthScale = 1) => {
    if (!L || weight <= 0) return;
    const n = Math.min(L.circles.length, MAX_CIRCLES), stagger = 0.6;
    L.circles.forEach((C, k) => {
      if (k >= MAX_CIRCLES) return;
      const w = weight >= 1 ? 1 : smooth(weight * (1 + stagger) - (stagger * k) / Math.max(n - 1, 1));
      N[offset + k].set(...C.n, w * widthScale);
      U[offset + k].set(...C.u, C.h);
    });
  };
  put(next, 0, mix);
  put(previous, MAX_CIRCLES, previousMix, previousScale);
}

function install(next, geometry) {
  if (plates.geometry !== geometry.plates) plates.geometry.dispose();
  if (dials.geometry !== geometry.dials) dials.geometry.dispose();
  plates.geometry = geometry.plates;
  dials.geometry = geometry.dials;
  layout = next;
  setMechanism();
  writePlateData(shared.plateData.value, layout);
  shared.motifSeed.value = seededRandom(`${builtKey}|motifs`)();
  if (atlasReady) motifAtlas.draw(shared.motifSeed.value);
  startMachine();
  turntables.count = counterGears.count = layout.nodes.length;
  shared.plateState.value.image.data.fill(0);
  shared.plateState.value.needsUpdate = true;
}

// Rebuild: everything sinks into the bare black core in a wave, its rails fade out and the new ones in,
// then the new layout rises out of it. The new layout is built while the old one sinks.
const rebuild = { state: "idle", t: 0, origin: [0, 1, 0], salt: 0, next: null, builder: null, result: null, previous: null };
// A change that comes while the new layout is already in place waits for it to finish rising.
function startRebuild(animate) {
  if (animate && (rebuild.state === "swap" || rebuild.state === "rise")) return;
  const key = layoutKey();
  builtKey = key;
  if (!animate || !layout) {
    const next = makeLayout(key);
    const gen = buildGeometry(next);
    let r;
    while (!(r = gen.next()).done);
    install(next, r.value);
    setCoreCircles(layout, null, 1);
    rebuild.state = "idle";
    return;
  }
  // Mid-sink, only the layout being built changes.
  if (rebuild.state === "sink") return Object.assign(rebuild, { next: null, builder: layoutAndGeometry(key), result: null });
  const wave = seededRandom(`${key}|wave`);
  Object.assign(rebuild, { state: "sink", t: 0, salt: wave(), origin: normalize([wave() - 0.5, wave() - 0.5, wave() - 0.5]), next: null, builder: layoutAndGeometry(key), result: null, previous: layout, previousScale: shared.mechScale.value });
  rebuildSound("sink");
}

// The transformation's sounds, like a big clockwork reconfiguring: every voiced part is heard as it leaves and as it
// seats again, timed to its own launch and arrival, over a turning crank and a running gear train.
function rebuildSound(phase) {
  const leaving = phase === "sink";
  const length = leaving ? SINK_TIME : RISE_TIME;
  for (let t = 0.05; t < length - 0.4; t += 1.1 + 0.4 * nativeRandom())
    sound.play("crank", { gain: 0.26, delay: t, rate: (leaving ? 0.8 : 0.95) + 0.1 * nativeRandom(), duration: 1.5 });
  sound.play("whirr", { gain: 0.22, delay: 0.15, rate: leaving ? 0.7 : 0.9, duration: length - 0.2 });
  sound.ratchet({ teeth: 14, duration: length - 0.4, gain: 0.14, delay: 0.25, rate: leaving ? 0.7 : 0.9 });
  if (!layout) return;
  const parts = [
    ...layout.faces.map((face, f) => ({ p: face.center, plate: true, id: f })),
    ...layout.nodes.map((node, n) => ({ p: node.p, plate: false, id: NODE_ID + n })),
  ].map((part) => ({ ...part, at: leaving ? launchAt(part.p, part.plate, part.id) : arriveAt(part.p, part.plate, part.id) }));
  parts.sort((a, b) => a.at - b.at);
  // At most 40 parts are voiced, spread evenly through the wave; busier layouts share the loudness.
  const step = Math.max(1, parts.length / 40);
  const g = 0.38 / Math.sqrt(Math.min(parts.length, 40) / 10);
  for (let k = 0; k < parts.length; k += step) {
    const { p, plate, id, at } = parts[Math.floor(k)];
    const { pan, gain } = soundAt(p);
    const r = nativeRandom();
    const v = g * gain * (0.65 + 0.7 * nativeRandom());
    if (leaving && plate) {
      sound.play(r < 0.6 ? "lever" : "bolt", { gain: v, pan, delay: at, rate: 0.9 + r * 0.2 });
      if (r < 0.35) sound.play("press", { gain: v * 0.7, pan, delay: at + 0.05, rate: 0.85 + r * 0.3 });
    } else if (leaving) {
      sound.play(r < 0.5 ? "cog" : "shift", { gain: v * 0.8, pan, delay: at, rate: 1.05 + r * 0.2 });
      sound.ratchet({ teeth: 3, duration: 0.2, gain: v * 0.6, pan, delay: at + 0.04, rate: 1.2 });
    } else if (plate) {
      sound.ratchet({ teeth: 4, duration: 0.35, gain: v * 0.6, pan, delay: at - 0.4 * flightTime(id, ARRIVE), rate: 0.85 + r * 0.2 });
      sound.play(r < 0.4 ? "press" : r < 0.7 ? "bolt" : "latch", { gain: v, pan, delay: at - 0.05, rate: 0.95 + r * 0.15 });
    } else {
      sound.play(r < 0.6 ? "cog" : "latch", { gain: v * 0.8, pan, delay: at - 0.05, rate: 1.1 + r * 0.2 });
    }
  }
  if (!leaving) {
    // Every plate is home: gears spin into mesh, then a ka-ching as they lock, and the train runs up to speed.
    const T = RISE_TIME;
    sound.ratchet({ teeth: 10, duration: 0.35, gain: 0.25, delay: T - 0.4, rate: 1.1 });
    sound.play("kaching", { gain: 0.6, delay: T - 0.02 });
    sound.play("cog", { gain: 0.3, delay: T, rate: 0.85 });
    sound.play("bolt", { gain: 0.35, delay: T + 0.01, rate: 0.85 });
    sound.play("whirr", { gain: 0.12, delay: T + 0.5, rate: 1.15, duration: 0.7 });
  }
}

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const smooth = (x) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const SINK_TIME = 2.55, RAIL_FADE = 0.8, RISE_TIME = 3.05;
const LAUNCH = 0.9, ARRIVE = 1.05;
// Part ids for the per-part timing: plates are their face index, then turntables, then beads.
const NODE_ID = 1000, TOKEN_ID = 2000;
// A stable random number per part and transformation, 0..1.
function partRandom(id, k) {
  const x = Math.sin(id * 12.9898 + rebuild.salt * 78.233 + k * 37.719) * 43758.5453;
  return x - Math.floor(x);
}
// Each part takes its own time to fly, within ±20% of the base.
const flightTime = (id, base) => base * (0.8 + 0.4 * partRandom(id, 2));
// A loose wave: the direction from the origin sets the rough order, and each part adds its own delay, squared so
// most go close to their turn and a few straggle.
const lag = (p, id) => 0.4 * (angle(p, rebuild.origin) / Math.PI) + 0.85 * partRandom(id, 1) ** 2;
// When a part at direction p leaves (going out) or seats (coming back), in seconds from the start of the phase.
// Beads and turntables leave first and come back last; plates the other way round.
function launchAt(p, plate, id) {
  return (plate ? 0.25 : 0) + lag(p, id);
}
function arriveAt(p, plate, id) {
  return (plate ? 0 : 0.5) + lag(p, id) + flightTime(id, ARRIVE);
}
// How far out a part is (along its direction from the centre) and how solid, during a transformation.
// Going: a small kick, then accelerating away while it dissolves. Coming: it appears far out, slows, and
// seats with a little dip into the surface before settling.
const _flight = { out: 0, fade: 1 };
function flightOf(p, plate, id) {
  const t = rebuild.t;
  if (rebuild.state === "sink") {
    const k = clamp01((t - launchAt(p, plate, id)) / flightTime(id, LAUNCH));
    _flight.out = 0.03 * smooth(k / 0.15) + FLY * Math.pow(Math.max(k - 0.1, 0) / 0.9, 2.2);
    _flight.fade = 1 - smooth((k - 0.25) / 0.6);
  } else if (rebuild.state === "swap") {
    _flight.out = FLY;
    _flight.fade = 0;
  } else if (rebuild.state === "rise") {
    const time = flightTime(id, ARRIVE);
    const k = clamp01((t - (arriveAt(p, plate, id) - time)) / time);
    _flight.out = FLY * Math.pow(1 - k, 3) - 0.012 * Math.sin(Math.PI * clamp01((k - 0.8) / 0.2));
    _flight.fade = smooth(k / 0.5);
  } else {
    _flight.out = 0;
    _flight.fade = 1;
  }
  return _flight;
}

function stepRebuild(dt) {
  if (rebuild.state === "idle") return;
  rebuild.t += dt;
  if (rebuild.state === "sink") {
    const deadline = performance.now() + 6;
    while (!rebuild.result && rebuild.builder && performance.now() < deadline) {
      const r = rebuild.builder.next();
      if (r.done) rebuild.result = r.value;
    }
    if (rebuild.t > SINK_TIME && rebuild.result) {
      install(rebuild.next, rebuild.result);
      Object.assign(rebuild, { state: "swap", t: 0 });
    }
  } else if (rebuild.state === "swap") {
    setCoreCircles(layout, rebuild.previous, clamp01((rebuild.t - RAIL_FADE) / RAIL_FADE), 1 - clamp01(rebuild.t / RAIL_FADE), rebuild.previousScale / SCALE);
    if (rebuild.t > RAIL_FADE * 2) {
      setCoreCircles(layout, null, 1);
      Object.assign(rebuild, { state: "rise", t: 0, salt: (rebuild.salt * 7.13 + 0.37) % 1, origin: normalize(cross(rebuild.origin, [0.3, 1, 0.2])) });
      rebuildSound("rise");
    }
  } else if (rebuild.state === "rise" && rebuild.t > RISE_TIME) {
    rebuild.state = "idle";
  }
}


const _m = new Matrix4();
// A gear on axis c turned by angle b, scaled by s across the axis and moved (u, v) along e1 and e2.
function gearMatrix(e1, e2, c, s, b, u, v) {
  const cb = Math.cos(b), sb = Math.sin(b);
  const X = [e1[0] * cb - e2[0] * sb, e1[1] * cb - e2[1] * sb, e1[2] * cb - e2[2] * sb], Z = cross(X, c);
  const t = [e1[0] * u + e2[0] * v, e1[1] * u + e2[1] * v, e1[2] * u + e2[2] * v];
  _m.set(X[0] * s, c[0], Z[0] * s, t[0], X[1] * s, c[1], Z[1] * s, t[1], X[2] * s, c[2], Z[2] * s, t[2], 0, 0, 0, 1);
}
const _basis = new Matrix4();
// Uploads an instanced mesh's matrices only when they changed: the pipeline reads an upload as motion,
// and a still scene is what lets it settle into a supersampled frame.
function uploadIfChanged(mesh) {
  const a = mesh.instanceMatrix.array, n = mesh.count * 16;
  const last = (mesh.userData.lastMatrices ??= new Float32Array(a.length).fill(NaN));
  for (let i = 0; i < n; i++) {
    if (a[i] !== last[i]) {
      last.set(a);
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }
  }
}
// Fades only change during a transformation, so they upload then and once after it.
let fadedLastFrame = false;
function updateInstances() {
  const swap = rebuild.state === "swap";
  const fading = rebuild.state !== "idle" || fadedLastFrame;
  fadedLastFrame = rebuild.state !== "idle";
  const ttFade = fadeOf(turntables), cgFade = fadeOf(counterGears), carFade = fadeOf(carriages), beadFade = fadeOf(beads);
  // Anything popped out when a rebuild starts comes back in before it flies off.
  const held = rebuild.state === "sink" ? 1 - smooth(rebuild.t / 0.5) : swap ? 0 : 1;
  const openings = [];
  layout.nodes.forEach((node, n) => {
    const psi = machine.psi[n].value(machine.time);
    const { x, y, z } = node.frame;
    const c = Math.cos(psi), s = Math.sin(psi);
    // Columns: the slot axis, the node normal, and their cross.
    const X = [x[0] * c - z[0] * s, x[1] * c - z[1] * s, x[2] * c - z[2] * s];
    const Z = cross(X, y);
    const lift = machine.lift(n) * held;
    if (lift > 0.002) openings.push([node.p, RC]);
    const flight = flightOf(node.p, false, NODE_ID + n);
    ttFade.array[n] = cgFade.array[n] = flight.fade;
    const depth = -flight.out - lift * POP;
    _m.set(X[0], y[0], Z[0], -y[0] * depth, X[1], y[1], Z[1], -y[1] * depth, X[2], y[2], Z[2], -y[2] * depth, 0, 0, 0, 1);
    turntables.setMatrixAt(n, _m);
    const g = -1.7 * psi, cg = Math.cos(g), sg = Math.sin(g);
    const G = [x[0] * cg - z[0] * sg, x[1] * cg - z[1] * sg, x[2] * cg - z[2] * sg];
    const GZ = cross(G, y);
    _m.set(G[0], y[0], GZ[0], -y[0] * depth, G[1], y[1], GZ[1], -y[1] * depth, G[2], y[2], GZ[2], -y[2] * depth, 0, 0, 0, 1);
    counterGears.setMatrixAt(n, _m);
  });
  uploadIfChanged(turntables);
  uploadIfChanged(counterGears);
  ttFade.needsUpdate = cgFade.needsUpdate = fading;
  machine.tokens.forEach((t, i) => {
    if (i >= MAX_TOKENS) return;
    const { p, x, lift: rawLift } = machine.tokenPose(t);
    const lift = rawLift * held;
    const Z = cross(x, p);
    const flight = flightOf(p, false, TOKEN_ID + i);
    carFade.array[i] = beadFade.array[i] = flight.fade;
    const depth = -flight.out - lift * POP;
    _basis.set(x[0], p[0], Z[0], -p[0] * depth, x[1], p[1], Z[1], -p[1] * depth, x[2], p[2], Z[2], -p[2] * depth, 0, 0, 0, 1);
    carriages.setMatrixAt(i, _basis);
    beads.setMatrixAt(i, _basis);
  });
  uploadIfChanged(carriages);
  uploadIfChanged(beads);
  carFade.needsUpdate = beadFade.needsUpdate = fading;

  // Row 1 keeps last frame's state for the motion vectors.
  const state = shared.plateState.value.image.data;
  state.copyWithin(MAX_PLATES * 4, 0, MAX_PLATES * 4);
  layout.faces.forEach((face, f) => {
    if (f >= MAX_PLATES) return;
    const plateLift = machine.plateLift(f) * held;
    const dialLift = machine.dialLift(f) * held;
    const flight = flightOf(face.center, true, f);
    state[f * 4] = -flight.out - plateLift * PLATE_POP;
    state[MAX_PLATES * 8 + f * 4] = flight.fade;
    state[f * 4 + 1] = machine.plateTurn[f].value(machine.time);
    state[f * 4 + 2] = machine.dials[f].value(machine.time);
    state[f * 4 + 3] = dialLift;
    if (plateLift > 0.002) openings.push([face.center, plateHole(face)]);
    else if (dialLift > 0.002) openings.push([face.center, face.dial + DIAL_GAP]);
  });
  shared.plateState.value.needsUpdate = true;

  // Open the core under whatever is out, and put a well with its gear train there.
  const holes = shared.holes.value;
  const count = Math.min(openings.length, MAX_HOLES);
  shared.holeCount.value = count;
  for (let k = 0; k < count; k++) {
    const [c, r] = openings[k];
    holes[k].set(c[0], c[1], c[2], r);
    const e1 = perpendicular(c), e2 = cross(c, e1), s = RF * Math.sin(r);
    // e1, c, -e2 is right-handed: a mirrored instance would cull the well's walls from the inside.
    _m.set(e1[0] * s, c[0], -e2[0] * s, 0, e1[1] * s, c[1], -e2[1] * s, 0, e1[2] * s, c[2], -e2[2] * s, 0, 0, 0, 0, 1);
    wells.setMatrixAt(k, _m);
    const sun = machine.time * 0.9;
    gearMatrix(e1, e2, c, s, sun, 0, 0);
    suns.setMatrixAt(k, _m);
    // Planets turn the other way at the same rate, phased so a sun tooth always meets a planet gap.
    const step = (Math.PI * 2) / TRAIN.teeth;
    for (let j = 0; j < 3; j++) {
      const phi = (j / 3) * Math.PI * 2;
      gearMatrix(e1, e2, c, s, -sun - 2 * phi - Math.PI - step / 2, Math.cos(phi) * TRAIN.planet * s, Math.sin(phi) * TRAIN.planet * s);
      planets.setMatrixAt(k * 3 + j, _m);
    }
  }
  wells.count = suns.count = count;
  planets.count = count * 3;
  // Hidden while there are none: an empty instanced draw still costs a program and uniform setup per pass.
  for (const m of [wells, suns, planets]) {
    const show = m.count > 0;
    if (show && !m.visible) {
      // Their motion history is stale from the last time they were out (the machine has spun since).
      m.userData.prevMatrixWorld?.copy(m.matrixWorld);
      const prev = m.geometry.getAttribute("prevInstanceMatrix");
      if (prev) (prev.array.set(m.instanceMatrix.array), (prev.needsUpdate = true));
    }
    m.visible = show;
    if (show) uploadIfChanged(m);
  }
}

// Finishes and bead colours ease towards the chosen set in wall time.
const look = {
  plate: new Color(), turntable: new Color(), carriage: new Color(), inlay: new Color(),
  plateRough: 0.3, turntableRough: 0.25, inlayMetal: 0.4, inlayRough: 0.7, beadRough: 0.2, beadMetal: 0,
  beads: Array.from({ length: 4 }, () => new Color()),
};
const _c = new Color();
// The old parts sink in their own finish; the new ones come up in the new one.
let shownFinish = null, shownBeads = null, shownLook = null;
let lookApplied = null, lookMachine = null;
function lookKey() {
  return [params.finish(), params.beads(), params.motifs(), params.variety()].join("|");
}
function updateLook(k) {
  // A new look shows straight away, unless a new shape is on its way: then it comes with the new parts.
  const settled = rebuild.state === "idle" && layoutKey() === builtKey;
  if (!shownLook || rebuild.state === "swap" || (settled && lookKey() !== shownLook)) {
    shownLook = lookKey();
    shownFinish = params.finish();
    shownBeads = params.beads();
    shared.motifSet.value = MOTIF_SETS.indexOf(params.motifs());
    shared.motifVariety.value = params.variety();
  }
  // Nothing to do unless the look, the engraving depth or the machine (its bead colours) changed.
  const applied = `${shownLook}|${params.engrave()}|${k}`;
  if (k === 1 && applied === lookApplied && machine === lookMachine) return;
  lookApplied = applied;
  lookMachine = machine;
  pipeline.restartAccumulation();
  const f = FINISHES[shownFinish];
  const b = BEADS[shownBeads];
  look.plate.lerp(_c.set(f.plate), k);
  look.turntable.lerp(_c.set(f.turntable), k);
  look.carriage.lerp(_c.set(f.carriage), k);
  look.inlay.lerp(_c.set(f.inlay), k);
  for (const key of ["plateRough", "turntableRough", "inlayMetal", "inlayRough"]) look[key] += (f[key] - look[key]) * k;
  look.beadRough += (b.roughness - look.beadRough) * k;
  look.beadMetal += (b.metalness - look.beadMetal) * k;
  look.beads.forEach((c, i) => c.lerp(_c.set(b.colours[i]), k));

  plateMaterial.color.copy(look.plate);
  plateMaterial.roughness = look.plateRough;
  plateMaterial.metalness = f.plateMetal ?? 1;
  dialMaterial.color.copy(look.turntable);
  shared.gearColor.value.set(f.gear ?? f.plate);
  dialMaterial.roughness = look.turntableRough;
  turntableMaterial.color.copy(look.turntable);
  turntableMaterial.roughness = look.turntableRough;
  carriageMaterial.color.copy(look.carriage);
  shared.inlayColor.value.copy(look.inlay);
  shared.partInlayColor.value.set(f.partInlay ?? f.inlay);
  shared.partInlayMetal.value = f.partInlayMetal ?? f.inlayMetal;
  shared.partInlayRough.value = f.partInlayRough ?? f.inlayRough;
  shared.inlayMetal.value = look.inlayMetal;
  shared.inlayRough.value = look.inlayRough;
  shared.engrave.value = params.engrave();
  beadMaterial.roughness = look.beadRough;
  beadMaterial.metalness = look.beadMetal;
  machine.tokens.forEach((t, i) => i < MAX_TOKENS && beads.setColorAt(i, look.beads[t.colour % 4]));
  beads.instanceColor.needsUpdate = true;
}

// Sounds for the machine's events, timed to the motion: machine time runs at Speed, so delays are scaled by it.
const _sv = new Vector3();
function soundAt(dir) {
  _sv.set(dir[0], dir[1], dir[2]).applyMatrix4(machineGroup.matrixWorld);
  const toCamera = camera.position.clone().sub(_sv).normalize();
  const facing = _sv.clone().normalize().dot(toCamera);
  const ndc = _sv.clone().project(camera);
  return { pan: Math.max(-1, Math.min(1, ndc.x)) * 0.8, gain: 0.3 + 0.7 * Math.min(Math.max((facing + 0.2) / 0.8, 0), 1) };
}
// Busy ticks share their loudness, so a dense layout is a patter rather than a wall.
let tickEvents = { at: -1, count: 0 };
function machineSound(type, start, info) {
  if (rebuild.state !== "idle" || params.speed() <= 0) return;
  const speed = params.speed();
  const delay = Math.max(0, (start - machine.time) / speed);
  if (tickEvents.at !== machine.tickStart) tickEvents = { at: machine.tickStart, count: 0 };
  const busy = 1 / Math.sqrt(1 + 0.15 * tickEvents.count++);
  const node = info.node !== undefined ? layout.nodes[info.node].p : null;
  const face = info.face !== undefined ? layout.faces[info.face].center : null;
  const { pan, gain } = soundAt(node ?? face ?? layout.nodes[info.from ?? 0].p);
  const small = 0.7 + 0.3 * SCALE;
  if (type === "move") {
    sound.play("slide", { gain: 0.22 * gain * busy, pan, delay, rate: 1.1 / small, duration: info.duration / speed });
    const { pan: arrivePan, gain: arriveGain } = soundAt(layout.nodes[info.to].p);
    sound.play("click", { gain: 0.28 * arriveGain * busy, pan: arrivePan, delay: delay + (info.duration * 0.9) / speed, rate: 1 / small });
  } else if (type === "turn") {
    sound.ratchet({ teeth: Math.round(Math.abs(info.angle) / (Math.PI / 12)) + 1, duration: info.duration / speed, gain: 0.3 * gain * busy, pan, delay, rate: 1 / small });
  } else if (type === "notch") {
    sound.play("tick", { gain: 0.3 * gain * busy, pan, delay });
  } else if (type === "pop") {
    const plate = info.kind === "plate";
    const D = info.duration / speed;
    sound.play("pop", { gain: (plate ? 0.6 : 0.45) * gain, pan, delay, rate: plate ? 0.75 : 1 / small });
    sound.play("whirr", { gain: (plate ? 0.4 : 0.3) * gain, pan, delay: delay + 0.22 * D, rate: plate ? 0.8 : 1.1, duration: 0.54 * D });
    // Everything that pops out turns, and turning is heard: a ratchet over the whole turn (heavy for plates, a notch a tooth for dials).
    if (info.kind === "turntable") sound.ratchet({ teeth: 12, duration: 0.5 * D, gain: 0.25 * gain, pan, delay: delay + 0.24 * D });
    else if (info.kind === "dial") sound.ratchet({ teeth: 24, duration: 0.56 * D, gain: 0.22 * gain, pan, delay: delay + 0.2 * D, rate: 1.2 });
    else sound.ratchet({ teeth: 18, duration: 0.54 * D, gain: 0.34 * gain, pan, delay: delay + 0.22 * D, rate: 0.7 });
    sound.play("latch", { gain: (plate ? 0.6 : 0.42) * gain, pan, delay: delay + 0.97 * D, rate: plate ? 0.85 : 1.1 });
  } else if (type === "sorted") {
    // Like winding a watch's crown, then the click of it setting.
    sound.ratchet({ teeth: 10, duration: 0.45, gain: 0.3, delay, rate: 1.25 });
    sound.play("latch", { gain: 0.3, delay: delay + 0.5, rate: 1.3 });
  }
}

// Clicks (not drags) poke whatever is under the pointer.
const raycaster = new Raycaster();
const pointerDown = new Vector2();
let downAt = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointerDown.set(e.clientX, e.clientY);
  downAt = performance.now();
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (performance.now() - downAt > 450 || pointerDown.distanceTo(new Vector2(e.clientX, e.clientY)) > 8) return;
  if (!machine || rebuild.state !== "idle" || waiting) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const ray = raycaster.ray.clone().applyMatrix4(new Matrix4().copy(machineGroup.matrixWorld).invert());
  const hit = ray.intersectSphere(new Sphere(new Vector3(), R + 0.015), new Vector3());
  if (!hit) return;
  poke(normalize([hit.x, hit.y, hit.z]));
});

function poke(p) {
  let best = null, bestA = 0.06 * SCALE;
  for (const t of machine.tokens) {
    const a = angle(machine.tokenPose(t).p, p);
    if (a < bestA) (bestA = a), (best = t);
  }
  if (best) return machine.poke(best.move ? best.move.to : best.node);
  const n = layout.nodes.findIndex((node) => angle(node.p, p) < RC + 0.012);
  if (n >= 0) return machine.poke(n);
  // Faces between rings aren't convex, so of the faces on the right side of all their walls take the nearest.
  let f = -1, nearest = Infinity;
  layout.faces.forEach((face, i) => {
    if (!face.walls.every((w) => w.s * (dot(p, w.n) - w.h) > 0)) return;
    const a = angle(p, face.center);
    if (a < nearest) (nearest = a), (f = i);
  });
  if (f < 0) return;
  const face = layout.faces[f];
  if (face.dial && angle(p, face.center) < face.dial + 0.01) return machine.popDial(f);
  // A plate pops out and turns if nothing around it is busy, otherwise it sets its corner turntables going.
  machine.queuePlate(f);
}

camera.near = 0.1;
camera.far = 80;
camera.position.set(0.5, 0.7, 4.6);
controls.target.set(0, -0.05, 0);
controls.enablePan = false;
controls.minDistance = 1.8;
controls.maxDistance = 8;

let viewport = null;
// Supersampling raises the drawing buffer's pixel ratio, so the pipeline and the canvas agree on its size.
// Phones never supersample and stay under about 2.6 megapixels.
function sizeRatio() {
  const [w, h, dpr] = viewport;
  return lite ? Math.min(dpr, Math.sqrt((low ? 1e6 : 2.6e6) / (w * h))) : dpr * params.supersample();
}
let stillView = false, lastView = [], movedAt = 0, interacting = false;
// Not while a drag or zoom is under way: a pause of the cursor mid-drag shouldn't switch resolution.
controls.addEventListener("start", () => (interacting = true));
controls.addEventListener("end", () => ((interacting = false), (movedAt = performance.now())));
function applySize() {
  if (!viewport) return;
  const [w, h] = viewport;
  const ratio = sizeRatio();
  if (renderer.getPixelRatio() !== ratio) {
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h);
  }
  pipeline.setSize(w, h, ratio);
}
onResize((w, h, dpr) => {
  viewport = [w, h, dpr];
  applySize();
});

let sinceChange = 0;
// True while a change waits for the pop-outs to come home.
let waiting = false;
// The frame loop rebuilds when the seed or layout params change.
onRandomize(() => {
  sinceChange = 0;
  gui.randomizeAll();
});

// Programs don't depend on the plates' vertex data, so they compile in parallel with the first build.
let atlasReady = false;
const compiled = Promise.all([pipeline.compileAsync(scene, camera), motifAtlas.compile()]);
applyUrlState();
// Unknown names from the url fall back to the defaults.
if (!(params.finish() in FINISHES)) params.finish.set(defaults.finish);
if (!(params.beads() in BEADS)) params.beads.set(defaults.beads);
if (!MOTIF_SETS.includes(params.motifs())) params.motifs.set(defaults.motifs);
if (!["random", "symmetric"].includes(params.layout()) && !(params.layout() in PRESETS)) params.layout.set(defaults.layout);
startRebuild(false);
updateLook(1);
updateInstances();
await studio;
await compiled;
atlasReady = true;
motifAtlas.draw(shared.motifSeed.value);

window.app = { canvas: renderer.domElement, params, pipeline, camera, controls, randomize, sound, get machine() { return machine; }, get layout() { return layout; }, get rebuild() { return rebuild.state; }, poke };

let last = performance.now();
let stillTime = 0;
render(({ time, dt, frame }) => {
  const now = performance.now();
  const wall = Math.min((now - last) / 1000, 0.1);
  last = now;
  // Never orbit under the floor: the lowest tilt depends on how far out the camera is.
  const distance = camera.position.distanceTo(controls.target);
  controls.maxPolarAngle = Math.min(Math.PI * 0.62, Math.acos(Math.max(-1, Math.min(1, (FLOOR_Y + 0.3 - controls.target.y) / distance))));
  controls.update();
  backdrop.keepInsideCyc(camera, controls.target);
  const view = [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov];
  const moving = (dt > 0 && (params.speed() > 0 || params.spin() > 0)) || rebuild.state !== "idle" || view.some((v, i) => v !== lastView[i]);
  lastView = view;
  if (moving || interacting) movedAt = now;
  // Settles only after the view has held still for a moment, so orbiting never flips back and forth.
  stillView = now - movedAt > 400;
  // A settled still draws the engraving as if its pixels were a quarter of the size, and the pipeline's average
  // of jittered frames filters that detail: supersampling spread over frames, at the same resolution.
  const detail = stillView && !capture ? 0.25 : 1;
  if (shared.detailScale.value !== detail) (shared.detailScale.value = detail), pipeline.restartAccumulation();
  if (viewport && renderer.getPixelRatio() !== sizeRatio()) applySize();

  // Only a new shape (seed, layout, circles) comes apart and rebuilds. New tokens or colours restart the machine
  // in place, and the finish and engraving change in place (see updateLook).
  // Either waits for anything popped out to finish its turn and come home; no new pop-outs start meanwhile.
  const reshape = layoutKey() !== builtKey;
  const restart = rebuild.state === "idle" && !reshape && machineKey() !== machineBuiltKey;
  // Paused (or at Speed 0) nothing would finish, so the change goes ahead.
  waiting = (reshape || restart) && frame > 0 && dt > 0 && params.speed() > 0 && rebuild.state === "idle" && machine.popping;
  if (waiting) machine.plateQueue.clear();
  else if (reshape) startRebuild(frame > 0);
  else if (restart) startMachine();
  stepRebuild(wall);
  machine.autoRate = capture || waiting ? 0 : params.pops();
  machine.popScale = Math.max(params.speed(), 0.05);
  const tickBefore = machine.tickStart;
  if (rebuild.state === "idle") machine.update(dt * params.speed());
  // The mechanism keeps itself wound: a short wind every tick, a long one every fourth.
  if (rebuild.state === "idle" && machine.tickStart !== tickBefore) {
    const long = Math.round(machine.tickStart / machine.tickLength) % 4 === 0;
    sound.play("wind", { gain: long ? 0.2 : 0.1, rate: long ? 0.95 : 1.15, duration: long ? 1.1 : 0.35, pan: (nativeRandom() - 0.5) * 0.3 });
  }
  sound.escapement(dt > 0 ? 5 * Math.sqrt(Math.max(params.speed(), 0.05)) : 0, 0.12);
  machineGroup.rotation.y += dt * params.spin();
  // Every part's prepass velocity is already last frame's motion, which the blur can reuse; only the spin is
  // measured over the shutter instead, so reuse holds while the spin moves the sphere's front under 0.4 px a frame.
  const pxPerUnit = (0.5 * renderer.domElement.height) / Math.tan((camera.fov * Math.PI) / 360) / Math.max(distance - 1.3, 0.1);
  pipeline.motionReusePrepass = params.spin() * dt * pxPerUnit < 0.4;
  // AO and GI only matter on and around the machine; the far floor and the wall skip the trace.
  pipeline.gi.fadeStart = distance + (rebuild.state === "idle" ? 2.4 : 4.5);
  pipeline.gi.fadeEnd = pipeline.gi.fadeStart + 1.6;

  // Counts only while the layout stands: a rebuild (from R, the menu or an auto change) starts it again once it lands.
  sinceChange = dt > 0 && rebuild.state === "idle" ? sinceChange + dt : 0;
  if (params.auto() > 0 && sinceChange >= params.auto() && !capture && rebuild.state === "idle") randomize();

  updateLook(1);
  updateInstances();
  // The pipeline's clock only runs while something moves, so a still view settles into a supersampled frame.
  // A transformation runs on wall time, even paused, so it keeps the frame fresh.
  if (dt > 0 && (params.speed() > 0 || params.spin() > 0)) stillTime += dt;
  if (rebuild.state !== "idle") pipeline.restartAccumulation();
  pipeline.render(scene, camera, stillTime);
});
