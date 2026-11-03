import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, randomize, isRunning, setRunning, applyUrlState, keysHelp, setDay } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Group, InstancedMesh, Matrix4, Quaternion, Vector3, IcosahedronGeometry, BufferGeometry } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { peelPieces, fleshGeometry, sacGeometry, chipGeometry, mulberry32, randomDirection } from "./fruit.js";
import { createShellMaterial, createFillMaterial, createPlainMaterial, applySubject } from "./materials.js";
import { SUBJECTS } from "./subjects.js";
import { SHAPES, loadShape, offsetGeometry } from "./shapes.js";
import { createTransport } from "./transport.js";

const defaults = {
  subject: "shell",
  shape: "sphere",
  explosion: 0.5,
  spray: 0.7,
  focus: 0.15,
  aperture: 0.2,
  rotation: 0.4,
};

const params = fromDefaults(defaults);

const pipeline = new Pipeline(renderer, {
  background: 0xffffff,
  exposure: 0.62,
  saturation: 1.2,
  bloomStrength: 0.03,
  vignette: 0.06,
  grain: 0.02,
  shadow: { autoFit: true, denoise: true },
  depthOfField: { aperture: 0 },
});
globalUniforms.aoMin.value = 0.2;

createStudioEnvironment(renderer, {
  keyDirection: new Vector3(-0.55, 0.8, 0.5),
  keyIntensity: 9,
  keySize: 0.45,
  fill: 0.45,
  floor: 0.5,
  wall: 0.55,
  ceiling: 0.25,
});

// The set: high-key white (brighter than paper white, so it tonemaps to white) or a grey studio
// with a heavy vignette standing in for its gradient.
const SETS = {
  white: { background: [16, 16, 16], vignette: 0.06, exposure: 0.62 },
  grey: { background: [0.55, 0.56, 0.58], vignette: 0.5, exposure: 0.9 },
  slate: { background: [0.2, 0.21, 0.23], vignette: 0.6, exposure: 0.9, bloom: 0.07 },
  dark: { background: [0.035, 0.035, 0.038], vignette: 0.55, exposure: 1.1 },
  night: { background: [0.012, 0.014, 0.02], vignette: 0.6, exposure: 1.1, bloom: 0.16 },
};

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
gui.addSelect("Subject", params.subject, Object.keys(SUBJECTS).filter((k) => !SUBJECTS[k].disabled));
gui.addSelect("Shape", params.shape, Object.keys(SHAPES));
gui.addSlider("Explosion", params.explosion, 0, 1, 0.01);
gui.addSlider("Spray", params.spray, 0, 1, 0.01);
gui.addSlider("Rotation", params.rotation, 0, 2, 0.01, { randomizable: false });
gui.addSection("Depth of field", { open: true });
// Focus runs from the nearest shell piece (0) to the farthest (1), and a little past either.
gui.addSlider("Focus", params.focus, -0.5, 1.5, 0.01, { randomizable: false });
gui.addSlider("Aperture", params.aperture, 0, 1, 0.01, { randomizable: false });
gui.endSection();
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
gui.show();

const scene = new Scene();
const materials = {
  shell: createShellMaterial(),
  fill: createFillMaterial(),
  fleck: createFillMaterial(),
  core: createPlainMaterial({ roughness: 0.35, through: 0 }),
  drop: createPlainMaterial({ roughness: 0.18, specular: 1, through: 1.2 }),
};

// ---------------------------------------------------------------- the burst

const MAX_DROPS = 3000;
const MAX_CHIPS = 4500;
const MAX_FLECKS = 1000;
const MAX_CHUNKS = 30;

const pieceGroup = new Group();
scene.add(pieceGroup);
const core = new Mesh(new BufferGeometry(), materials.core);
scene.add(core);
const chunkShapes = [0, 1, 2].map((i) => fleshGeometry(i + 1));
const CHUNK_RADIUS = Math.max(...chunkShapes.map((g) => (g.computeBoundingSphere(), g.boundingSphere.center.length() + g.boundingSphere.radius)));
const chunkMeshes = chunkShapes.map((g) => new InstancedMesh(g, materials.fill, MAX_CHUNKS));
const dropShape = mergeVertices(new IcosahedronGeometry(1, 2));
dropShape.computeVertexNormals();
const drops = new InstancedMesh(dropShape, materials.drop, MAX_DROPS);
const chipShapes = [3, 4, 5].map((n, i) => chipGeometry(i + 7, n));
const chipMeshes = chipShapes.map((g) => new InstancedMesh(g, materials.shell, Math.ceil(MAX_CHIPS / chipShapes.length)));
const flecks = new InstancedMesh(sacGeometry(), materials.fleck, MAX_FLECKS);
for (const m of [...chunkMeshes, drops, ...chipMeshes, flecks]) {
  m.frustumCulled = false;
  scene.add(m);
}

let seed = 1;
let built = null;
let subject = null;
let shape = null;
let pieces = [];
let chunks = [];
let spray = [];
let chips = [];

// Where a side burst comes from: each seed picks a direction within CONE of the side facing the
// camera's start, a little up.
const SIDE_BASE = new Vector3(0.75, 0.35, 0.55).normalize();
const CONE = (40 * Math.PI) / 180;
const SIDE = new Vector3();

function aimSide(rand) {
  const cos = 1 - rand() * (1 - Math.cos(CONE));
  const sin = Math.sqrt(1 - cos * cos);
  const a = rand() * Math.PI * 2;
  const u = new Vector3().crossVectors(SIDE_BASE, new Vector3(0, 1, 0)).normalize();
  const v = new Vector3().crossVectors(SIDE_BASE, u);
  SIDE.copy(SIDE_BASE).multiplyScalar(cos).addScaledVector(u, Math.cos(a) * sin).addScaledVector(v, Math.sin(a) * sin);
}

// How hard the burst throws something at direction d from the centre: everything in a radial
// burst, the side facing SIDE (fading to nothing) in a side burst.
function energyAt(d) {
  if (subject.burst === "radial") return 1;
  const c = d.dot(SIDE);
  return Math.max(0, Math.min(1, (c + 0.1) / 0.8)) ** 1.6;
}

function launch(d, rand, speed) {
  if (subject.burst === "radial") return d.clone().multiplyScalar(speed).add(randomDirection(rand).multiplyScalar(speed * 0.2));
  // Side: out along the surface normal and the burst direction, sweeping down in a stream.
  return d.clone().multiplyScalar(0.5).add(SIDE).add(new Vector3(0.15, -0.35, 0)).normalize().multiplyScalar(speed).add(randomDirection(rand).multiplyScalar(speed * 0.25));
}

// Everything's start and velocity; the frozen moment is then just position = start + velocity * t.
function build() {
  subject = SUBJECTS[params.subject()];
  shape = shapes.get(params.shape());
  for (const p of pieces) {
    pieceGroup.remove(p.mesh);
    p.mesh.geometry.dispose();
  }
  // Its own stream, so the direction doesn't shift the rest of the layout.
  aimSide(mulberry32(seed ^ 0x5bd1e995));
  const rand = mulberry32(seed);
  const fracture = subject.fracture ?? {};
  const impact = fracture.stretch ? nearestOnShape(shape, SIDE) : null;
  pieces = peelPieces({ seed, count: subject.pieces, shape, thickness: subject.thickness, warp: fracture.warp, stretch: fracture.stretch, impact }).map((piece) => {
    const mesh = new Mesh(piece.geometry, materials.shell);
    pieceGroup.add(mesh);
    const e = energyAt(piece.direction);
    return {
      mesh,
      centre: piece.centre,
      tear: piece.tear,
      velocity: launch(piece.direction, rand, (2 + 2 * rand()) * e),
      axis: randomDirection(rand),
      spin: (2 + 7 * rand()) * e,
    };
  });
  core.visible = !!subject.core;
  core.geometry.dispose();
  core.geometry = offsetGeometry(shape, subject.thickness + 0.004);

  // A point somewhere inside, below the surface, and the way out from it.
  const p = new Vector3(), n = new Vector3();
  const inside = (depth) => {
    shape.sample(rand, p, n);
    const start = p.clone().addScaledVector(n, -depth * shape.depth);
    return { start, out: n.clone().add(start.clone().normalize()).normalize() };
  };

  // Chunks are no bigger than the room they have under the shell, and slower than it.
  chunks = [];
  const chunkCount = subject.fill ? subject.fill.chunks : 0;
  for (let i = 0; i < MAX_CHUNKS * chunkMeshes.length; i++) {
    const { start, out } = inside(0.3 + 0.7 * rand());
    const lumpy = subject.fill ? subject.fill.lumpy : 1;
    const scale = new Vector3(1 + 0.3 * lumpy, 1 - 0.5 * lumpy * rand(), 1 - 0.3 * lumpy * rand());
    const room = Math.max(0, clearance(shape, start) - subject.thickness - 0.01) / (CHUNK_RADIUS * scale.x);
    chunks.push({
      on: i < chunkCount,
      start,
      velocity: out.multiplyScalar(0.4 + 1.2 * rand()).add(randomDirection(rand).multiplyScalar(0.15)),
      scale: scale.multiplyScalar(Math.min(0.16 + 0.22 * rand(), room)),
      axis: randomDirection(rand),
      spin: 1 + 4 * rand(),
      turn: randomDirection(rand),
    });
  }

  // Liquid and flecks out through the tears, so they pass between the pieces rather than through
  // them; chips from the shell where the burst is.
  const tears = pieces.flatMap((piece) => piece.tear);
  spray = [];
  for (let i = 0; i < MAX_DROPS + MAX_FLECKS; i++) {
    const tear = tears[Math.floor(rand() * tears.length)];
    const start = tear.p.clone().addScaledVector(tear.n, -(subject.thickness + 0.02 + 0.08 * rand()));
    const speed = 1 + 6.5 * rand() ** 2.2;
    const dir = tear.n.clone().add(randomDirection(rand).multiplyScalar(0.08)).normalize();
    spray.push({ start, velocity: dir.multiplyScalar(speed), size: (0.0025 + 0.03 * rand() ** 4) / Math.sqrt(speed / 2), axis: randomDirection(rand), spin: 4 + 12 * rand() });
  }
  chips = [];
  for (let i = 0; i < MAX_CHIPS; i++) {
    let at = inside(0);
    // Side bursts shed their chips from the burst side.
    for (let k = 0; k < 8 && rand() > energyAt(at.out); k++) at = inside(0);
    const d = at.out;
    const e = Math.max(0.15, energyAt(d));
    const start = p.clone().addScaledVector(n, -subject.thickness * 0.5);
    const speed = (1 + 6 * rand() ** 1.5) * e;
    // Mostly small, a few large ones that fly fast (and, near the camera, go soft with depth of field).
    const big = rand() < 0.012 * (subject.spray.bigChips ?? 1);
    const size = (big ? 0.12 + 0.12 * rand() : 0.012 + 0.07 * rand() ** 2.2) * (subject.spray.chipSize ?? 1);
    chips.push({ start, velocity: launch(d, rand, big ? speed * 1.6 + 2 : speed), size, axis: randomDirection(rand), spin: 3 + 14 * rand(), turn: randomDirection(rand) });
  }
}

// The vertex of the shape furthest out along a direction.
function nearestOnShape(shape, direction) {
  const p = shape.position;
  let best = 0, bd = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * direction.x + p[i + 1] * direction.y + p[i + 2] * direction.z;
    if (d > bd) (bd = d), (best = i);
  }
  return new Vector3(p[best], p[best + 1], p[best + 2]);
}

// How far a point is from the shape's surface.
function clearance(shape, from) {
  const p = shape.position;
  let best = Infinity;
  for (let i = 0; i < p.length; i += 9) best = Math.min(best, (p[i] - from.x) ** 2 + (p[i + 1] - from.y) ** 2 + (p[i + 2] - from.z) ** 2);
  return Math.sqrt(best);
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _z = new Vector3(0, 0, 1);
const _v = new Vector3();
const HIDE = new Matrix4().makeScale(0, 0, 0);

function place() {
  const t = params.explosion() * 0.6;
  const amount = params.spray();
  for (const p of pieces) {
    p.mesh.position.copy(p.centre).addScaledVector(p.velocity, t);
    p.mesh.quaternion.setFromAxisAngle(p.axis, p.spin * t);
  }
  chunks.forEach((c, i) => {
    const mesh = chunkMeshes[i % chunkMeshes.length];
    const at = Math.floor(i / chunkMeshes.length);
    if (!c.on) return mesh.setMatrixAt(at, HIDE);
    _p.copy(c.start).addScaledVector(c.velocity, t);
    _q.setFromAxisAngle(c.axis, c.spin * t).multiply(_q2.setFromUnitVectors(_z, c.turn));
    mesh.setMatrixAt(at, _m.compose(_p, _q, c.scale));
  });
  for (const m of chunkMeshes) m.instanceMatrix.needsUpdate = true;
  // Drops stretch along their flight like a fast shutter would catch them.
  const dropCount = Math.round(MAX_DROPS * amount * (subject.spray.drops ?? 0));
  for (let i = 0; i < MAX_DROPS; i++) {
    if (i >= dropCount) {
      drops.setMatrixAt(i, HIDE);
      continue;
    }
    const d = spray[i];
    _p.copy(d.start).addScaledVector(d.velocity, t);
    const speed = d.velocity.length();
    _q.setFromUnitVectors(_z, _v.copy(d.velocity).normalize());
    const stretch = 1 + speed * speed * 0.35 * Math.min(1, t * 8);
    const thin = d.size / stretch ** 0.25;
    drops.setMatrixAt(i, _m.compose(_p, _q, _s.set(thin, thin, d.size * stretch)));
  }
  drops.instanceMatrix.needsUpdate = true;
  const fleckCount = subject.spray.flecks ? Math.round(MAX_FLECKS * amount) : 0;
  for (let i = 0; i < MAX_FLECKS; i++) {
    if (i >= fleckCount) {
      flecks.setMatrixAt(i, HIDE);
      continue;
    }
    const d = spray[MAX_DROPS + i];
    _p.copy(d.start).addScaledVector(d.velocity, t * 0.8);
    _q.setFromAxisAngle(d.axis, d.spin * t);
    flecks.setMatrixAt(i, _m.compose(_p, _q, _s.set(d.size * 0.9, d.size * 0.9, d.size * 2.6)));
  }
  flecks.instanceMatrix.needsUpdate = true;
  const chipCount = Math.round(MAX_CHIPS * amount * (subject.spray.chips ?? 0));
  chips.forEach((c, i) => {
    const mesh = chipMeshes[i % chipMeshes.length];
    const at = Math.floor(i / chipMeshes.length);
    if (i >= chipCount || t <= 0) return mesh.setMatrixAt(at, HIDE);
    _p.copy(c.start).addScaledVector(c.velocity, t);
    _q.setFromAxisAngle(c.axis, c.spin * t).multiply(_q2.setFromUnitVectors(_z, c.turn));
    mesh.setMatrixAt(at, _m.compose(_p, _q, _s.set(c.size * (subject.spray.chipStretch ?? 1), c.size, c.size * (subject.spray.chipThin ?? 1))));
  });
  for (const m of chipMeshes) m.instanceMatrix.needsUpdate = true;
}

let placedKey = null;
// Shapes load on first use; until one is ready the last build stays up.
const shapes = new Map();
let loading = null;
function update() {
  const key = `${params.subject()}|${params.shape()}|${seed}`;
  if (key !== built && !shapes.has(params.shape())) {
    const name = params.shape();
    if (loading !== name) {
      loading = name;
      loadShape(name).then((s) => shapes.set(name, s));
    }
  } else if (key !== built) {
    built = key;
    build();
    placedKey = null;
    applySubject(materials, subject);
    pipeline.restartAccumulation();
    const set = SETS[subject.set];
    pipeline.background.setRGB(...set.background);
    pipeline.vignette = set.vignette;
    pipeline.bloomStrength = set.bloom ?? 0.03;
    pipeline.exposure = set.exposure;
  }
  const pk = `${built}|${params.explosion()}|${params.spray()}`;
  if (pk !== placedKey) {
    placedKey = pk;
    place();
  }
  if (focusOverride !== null) pipeline.dof.focus = focusOverride;
  else if (pieces.length) {
    const [near, far] = depthRange(camera.position);
    pipeline.dof.focus = Math.max(camera.near * 2, near + (far - near) * params.focus());
  }
  pipeline.dof.aperture = params.aperture() * 0.024;
}

// The distances to the nearest and farthest shell pieces, where they are now.
function depthRange(from) {
  let near = Infinity, far = 0;
  for (const p of pieces) {
    const d = p.mesh.position.distanceTo(from);
    near = Math.min(near, d);
    far = Math.max(far, d);
  }
  return [near, far];
}

onRandomize(() => {
  gui.randomizeAll();
  seed = Math.floor(Math.random() * 2 ** 31);
});

// ---------------------------------------------------------------- camera

camera.near = 0.2;
camera.far = 60;
camera.updateProjectionMatrix();
camera.position.set(0.8, 0.5, 6.5);
controls.target.set(0, 0, 0);
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 14;
controls.autoRotate = true;

// Frames the burst for the narrower of the two fields of view.
const FRAME_RADIUS = 2.6;
onResize((w, h, dpr) => {
  const half = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, w / h));
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(Math.min(controls.maxDistance, FRAME_RADIUS / Math.sin(half)));
  camera.position.copy(controls.target).add(offset);
  pipeline.setSize(w, h, dpr);
});

const transport = createTransport({
  value: params.explosion,
  onRandomize: randomize,
  onPlay: () => isRunning() || setRunning(true),
});

let focusOverride = null;
let firstFrame;
const rendered = new Promise((resolve) => (firstFrame = resolve));

// A handle for recording tools: the canvas, and switching to a look and replaying its burst.
window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  transport,
  side: SIDE,
  get subject() {
    return subject;
  },
  // Every shape loaded and the first frame drawn.
  async preload() {
    for (const name of Object.keys(SHAPES)) if (!shapes.has(name)) shapes.set(name, await loadShape(name));
    await rendered;
  },
  // look: { subject, shape, seed }
  nextLook(look) {
    if (!look) return;
    seed = look.seed ?? seed;
    params.subject.set(look.subject);
    params.shape.set(look.shape);
    update();
    this.bounce();
  },
  bounce() {
    params.explosion.set(0);
    transport.play();
  },
  // Orbit at `distance` round `target`, from `direction` or the current one.
  frame(distance, target, direction = camera.position.clone().sub(controls.target)) {
    direction = direction.clone().normalize();
    controls.target.copy(target);
    camera.position.copy(target).addScaledVector(direction, distance);
    controls.update();
  },
  // Focus at a fixed distance, or (null) back on the pieces as the panel sets it.
  focusAt(distance) {
    focusOverride = distance;
  },
  // Renders n still frames, so the temporal buffers (shadows, AO, GI) settle after a switch.
  warm(n) {
    for (let i = 0; i < n; i++) {
      update();
      pipeline.render(scene, camera, 0);
    }
  },
};

// The url's subject and shape, so the first build is the one asked for.
applyUrlState();
shapes.set(params.shape(), await loadShape(params.shape()));
update();
await pipeline.compileAsync(scene, camera);

render(({ dt }) => {
  transport.update(dt);
  update();
  controls.autoRotateSpeed = params.rotation();
  controls.update(dt);
  // Nothing animates with time, so whenever the view holds still the lens average refines it.
  pipeline.render(scene, camera, 0);
  firstFrame();
});
