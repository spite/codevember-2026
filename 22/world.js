// An endless labyrinth in the spirit of liminal back rooms, generated in chunks around the walker.
// Each chunk is CHUNK x CHUNK cells: a maze carved by a random spanning tree, rooms knocked open, and
// openings on its sides decided by the shared edge, so neighbouring chunks always agree. Depth is the
// distance from the start; with it the place gets wrong: rooms grow, ceilings rise or vanish, floors
// break into platforms, shapes sink half into walls and floors, and presences wait in the corridors.
// Rays are traced cell by cell through the grid, so cost doesn't grow with the size of the world.

import {
  Group,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  BoxGeometry,
  IcosahedronGeometry,
  DodecahedronGeometry,
  OctahedronGeometry,
  TorusGeometry,
  Vector3,
  Color,
  Raycaster,
  MeshBasicMaterial,
} from "three";
import { seededRandom, getSeed } from "modules/random.js";

export const CELL = 2.4;
const CHUNK = 8;
const BASE_CEILING = 2.7;
const VOID = 40;
const LOAD_RADIUS = 3;
const MAX_STEP = 0.85;
const WALL = 0.2;
const HW = WALL / 2;

// How wrong the place is at a depth in metres: 0 near the start, 1 deep in.
const weirdness = (d) => Math.min(1, Math.max(0, (d - 18) / 110));

const PAPER = [new Color("#c9b66c"), new Color("#a9ad62"), new Color("#9a6b4a"), new Color("#7a3a35")];
const CARPET = [new Color("#8c7a44"), new Color("#6f7442"), new Color("#5e4733"), new Color("#40262a")];
const TILE = new Color("#d9d3bd");
const PANEL = new Color("#fff6e0");
const PLINTH = new Color("#d9d1bd");
const OBJECT_COLORS = [new Color("#d8d4cc"), new Color("#c8684e"), new Color("#5482b8"), new Color("#c8b68c")];

function ramp(stops, w, out) {
  const x = w * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return out.copy(stops[i]).lerp(stops[i + 1], x - i);
}

// Deterministic per-item randomness from integer coordinates.
function hash(...v) {
  let h = 2166136261 ^ seedHash;
  for (const x of v) {
    h = Math.imul(h ^ (x | 0), 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
let seedHash = 0;

// The listener's body, in metres from the feet, facing -z: capsules [ax, ay, az, bx, by, bz, radius].
const BODY = [
  [0, 1.66, 0.06, 0, 1.66, 0.06, 0.11], // head (just behind the eyes)
  [0, 1.47, 0.05, 0, 1.56, 0.05, 0.06], // neck
  [-0.1, 1.38, 0.05, 0.1, 1.38, 0.05, 0.11], // shoulders
  [-0.07, 1.05, 0.05, -0.07, 1.36, 0.05, 0.12], // torso, left half
  [0.07, 1.05, 0.05, 0.07, 1.36, 0.05, 0.12], // torso, right half
  [-0.1, 0.92, 0.05, 0.1, 0.92, 0.05, 0.12], // hips
  [-0.22, 1.36, 0.05, -0.26, 0.8, 0.03, 0.05], // left arm
  [0.22, 1.36, 0.05, 0.26, 0.8, 0.03, 0.05], // right arm
  [-0.1, 0.88, 0.05, -0.11, 0.08, 0.04, 0.075], // left leg
  [0.1, 0.88, 0.05, 0.11, 0.08, 0.04, 0.075], // right leg
];
const BODY_ENDS = BODY.map((c) => [c[3], c[4], c[5]]);

// Ray (ro, rd unit) against a capsule from a to b; distance or Infinity.
function capsule(ro, rd, a, b, r) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const oax = ro.x - a[0], oay = ro.y - a[1], oaz = ro.z - a[2];
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * rd.x + bay * rd.y + baz * rd.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = rd.x * oax + rd.y * oay + rd.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  let h = B * B - A * C;
  if (h >= 0 && A > 1e-9) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t > 0) return t;
  }
  // The end caps.
  for (const [cx, cy, cz] of [a, b]) {
    const ox = ro.x - cx, oy = ro.y - cy, oz = ro.z - cz;
    const bb = ox * rd.x + oy * rd.y + oz * rd.z;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    h = bb * bb - cc;
    if (h >= 0) {
      const t = -bb - Math.sqrt(h);
      if (t > 0) return t;
    }
  }
  return Infinity;
}

export function createWorld(material, suzanneGeo) {
  const group = new Group();
  const chunks = new Map();
  const raycaster = new Raycaster();
  const hullMat = new MeshBasicMaterial();
  const presences = [];
  // The listener's body: rays that reach it are absorbed, so it leaves a person-shaped sound shadow.
  const body = { feet: new Vector3(), cos: 1, sin: 0, on: false };
  const _lo = new Vector3();
  const _ld = new Vector3();
  function hitBody(b, origin, dir) {
    // A quick bounding test, then into the body's frame: feet at the origin, facing -z.
    const ox = origin.x - b.feet.x, oy = origin.y - b.feet.y - 0.9, oz = origin.z - b.feet.z;
    const bb = ox * dir.x + oy * dir.y + oz * dir.z;
    const cc = ox * ox + oy * oy + oz * oz - 1.0;
    if (cc > 0 && (bb > 0 || bb * bb - cc < 0)) return Infinity;
    _lo.set(b.cos * (origin.x - b.feet.x) - b.sin * (origin.z - b.feet.z), origin.y - b.feet.y, b.sin * (origin.x - b.feet.x) + b.cos * (origin.z - b.feet.z));
    _ld.set(b.cos * dir.x - b.sin * dir.z, dir.y, b.sin * dir.x + b.cos * dir.z);
    let t = Infinity;
    for (let k = 0; k < BODY.length; k++) t = Math.min(t, capsule(_lo, _ld, BODY[k], BODY_ENDS[k], BODY[k][6]));
    return t;
  }
  // Watchers: people standing in the distance, made of nothing but the sound they block.
  const watchers = [];
  function bodyHit(origin, dir) {
    let t = body.on ? hitBody(body, origin, dir) : Infinity;
    for (const w of watchers) t = Math.min(t, hitBody(w, origin, dir));
    return t;
  }
  const tmpColor = new Color();
  const shapeGeos = {
    sphere: new SphereGeometry(1, 40, 28),
    icosa: new IcosahedronGeometry(1, 0),
    dodeca: new DodecahedronGeometry(1, 0),
    octa: new OctahedronGeometry(1, 0),
    torus: new TorusGeometry(0.75, 0.25, 20, 48),
    box: new BoxGeometry(1.4, 1.4, 1.4),
    plinth: new BoxGeometry(1, 1, 1),
  };
  for (const g of Object.values(shapeGeos)) g.computeBoundingSphere();
  const suzHull = suzanneGeo.userData.hull ?? suzanneGeo;
  suzanneGeo.computeBoundingSphere();

  const key = (ci, cj) => `${ci},${cj}`;
  const chunkOf = (i) => Math.floor(i / CHUNK);

  // Data of chunk (ci, cj): per cell, walls on its +x (east) and +z (south) edges, floor and ceiling heights.
  function buildData(ci, cj) {
    const rand = seededRandom(`${getSeed()}:${ci}:${cj}`);
    const N = CHUNK;
    const center = new Vector3((ci + 0.5) * N * CELL, 0, (cj + 0.5) * N * CELL);
    const w = weirdness(center.length());
    const wallE = new Array(N * N).fill(true);
    const wallS = new Array(N * N).fill(true);
    const floor = new Array(N * N).fill(0);
    const ceil = new Array(N * N).fill(BASE_CEILING);
    const id = (x, z) => z * N + x;
    // Spanning tree: the chunk is fully connected inside.
    const seen = new Array(N * N).fill(false);
    const stack = [[Math.floor(rand() * N), Math.floor(rand() * N)]];
    seen[id(...stack[0])] = true;
    while (stack.length) {
      const [x, z] = stack[stack.length - 1];
      const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [x + dx, z + dz]).filter(([a, b]) => a >= 0 && b >= 0 && a < N && b < N && !seen[id(a, b)]);
      if (!next.length) {
        stack.pop();
        continue;
      }
      const [a, b] = next[Math.floor(rand() * next.length)];
      if (a !== x) wallE[id(Math.min(x, a), z)] = false;
      else wallS[id(x, Math.min(z, b))] = false;
      seen[id(a, b)] = true;
      stack.push([a, b]);
    }
    // Rooms, more and bigger with depth; tall or ceilingless and broken into platforms deeper in.
    const roomCount = 2 + Math.floor(rand() * (2 + w * 1.5));
    const rooms = [];
    for (let r = 0; r < roomCount; r++) {
      const rw = 2 + Math.floor(rand() * (3 + w * 3));
      const rh = 2 + Math.floor(rand() * (3 + w * 3));
      const x0 = Math.floor(rand() * Math.max(1, N - rw));
      const z0 = Math.floor(rand() * Math.max(1, N - rh));
      rooms.push({ x0, z0, w: Math.min(rw, N - x0), h: Math.min(rh, N - z0) });
      const height = rand() < w * 0.35 ? VOID : BASE_CEILING + (rand() < w ? rand() * w * 7 : 0);
      for (let z = z0; z < Math.min(N, z0 + rh); z++) {
        for (let x = x0; x < Math.min(N, x0 + rw); x++) {
          if (x < x0 + rw - 1 && x < N - 1) wallE[id(x, z)] = false;
          if (z < z0 + rh - 1 && z < N - 1) wallS[id(x, z)] = false;
          ceil[id(x, z)] = Math.max(ceil[id(x, z)], height);
          if (rand() < w * 0.45) floor[id(x, z)] = Math.round(rand() * (1 + w * 5)) * 0.4;
          ceil[id(x, z)] = Math.max(ceil[id(x, z)], floor[id(x, z)] + BASE_CEILING);
        }
      }
    }
    // Extra openings: loops, more of them deeper in.
    for (let k = 0; k < 3 + w * 10; k++) {
      const x = Math.floor(rand() * N);
      const z = Math.floor(rand() * N);
      if (rand() < 0.5 && x < N - 1) wallE[id(x, z)] = false;
      else if (z < N - 1) wallS[id(x, z)] = false;
    }
    // Chunk sides: two openings per side, decided by the side itself so both chunks agree.
    for (let k = 0; k < N; k++) {
      wallE[id(N - 1, k)] = !(sideOpen(ci, cj, "x", k));
      wallS[id(k, N - 1)] = !(sideOpen(ci, cj, "z", k));
    }
    return { ci, cj, w, wallE, wallS, floor, ceil, rooms, owned: [] };
  }

  // Openings on the side between chunk (ci, cj) and its +x ("x") or +z ("z") neighbour.
  function sideOpen(ci, cj, axis, k) {
    const a = Math.floor(hash(ci, cj, axis === "x" ? 1 : 2) * CHUNK);
    const b = Math.floor(hash(ci, cj, axis === "x" ? 3 : 4) * CHUNK);
    return k === a || k === b || hash(ci, cj, axis === "x" ? 5 : 6, k) < 0.12;
  }

  function data(ci, cj) {
    const k = key(ci, cj);
    let c = chunks.get(k);
    if (!c) {
      c = buildData(ci, cj);
      chunks.set(k, c);
      placeObjects(c);
    }
    return c;
  }

  function cell(i, j) {
    const c = data(chunkOf(i), chunkOf(j));
    const x = i - c.ci * CHUNK;
    const z = j - c.cj * CHUNK;
    return { c, idx: z * CHUNK + x };
  }
  const floorOf = (i, j) => {
    const { c, idx } = cell(i, j);
    return c.floor[idx];
  };
  const ceilOf = (i, j) => {
    const { c, idx } = cell(i, j);
    return c.ceil[idx];
  };
  // Is there a wall on the edge between cell (i, j) and its neighbour in direction (di, dj)?
  function wallBetween(i, j, di, dj) {
    if (di < 0 || dj < 0) return wallBetween(i + di, j + dj, -di, -dj);
    const ci = chunkOf(i);
    const cj = chunkOf(j);
    const x = i - ci * CHUNK;
    const z = j - cj * CHUNK;
    if (di === 1 && x === CHUNK - 1) return !sideOpen(ci, cj, "x", z);
    if (dj === 1 && z === CHUNK - 1) return !sideOpen(ci, cj, "z", x);
    const c = data(ci, cj);
    return di === 1 ? c.wallE[z * CHUNK + x] : c.wallS[z * CHUNK + x];
  }

  // Walls are WALL thick slabs on the cell edges, with square posts wherever walls meet at a corner.
  const wallE = (i, j) => wallBetween(i, j, 1, 0);
  const wallS = (i, j) => wallBetween(i, j, 0, 1);
  // A post at the grid vertex (a, b), the corner at (a * CELL, b * CELL), if any wall touches it.
  const postAt = (a, b) => wallE(a - 1, b - 1) || wallE(a - 1, b) || wallS(a - 1, b - 1) || wallS(a, b - 1);

  // Objects: half-sunken shapes in walls and floors, and presences, registered in every cell they overlap.
  const cellObjects = new Map();
  function addObject(c, obj) {
    const r = obj.radius;
    obj.cells = [];
    for (let i = Math.floor((obj.center.x - r) / CELL); i <= Math.floor((obj.center.x + r) / CELL); i++) {
      for (let j = Math.floor((obj.center.z - r) / CELL); j <= Math.floor((obj.center.z + r) / CELL); j++) {
        const k = `${i},${j}`;
        if (!cellObjects.has(k)) cellObjects.set(k, []);
        cellObjects.get(k).push(obj);
        obj.cells.push(k);
      }
    }
    obj.chunk = c;
    c.owned.push(obj);
  }
  function removeObject(obj) {
    for (const k of obj.cells) {
      const list = cellObjects.get(k);
      const at = list ? list.indexOf(obj) : -1;
      if (at >= 0) list.splice(at, 1);
    }
    const at = obj.chunk.owned.indexOf(obj);
    if (at >= 0) obj.chunk.owned.splice(at, 1);
  }
  const NONE = [];
  function objectsAt(i, j) {
    // Make sure the chunks that could own objects reaching into this cell exist.
    data(chunkOf(i), chunkOf(j));
    return cellObjects.get(`${i},${j}`) ?? NONE;
  }

  function placeObjects(c) {
    const rand = seededRandom(`${getSeed()}:${c.ci}:${c.cj}:objects`);
    const w = c.w;
    const sunk = Math.floor(rand() * (0.6 + w * 7));
    const kinds = ["sphere", "icosa", "dodeca", "octa", "torus", "box", "suzanne"];
    for (let k = 0; k < sunk; k++) {
      const x = c.ci * CHUNK + Math.floor(rand() * CHUNK);
      const z = c.cj * CHUNK + Math.floor(rand() * CHUNK);
      const size = 0.35 + rand() * (0.4 + w * 1.4);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const center = new Vector3((x + 0.5) * CELL, 0, (z + 0.5) * CELL);
      // Into a wall of the cell if it has one, else into the floor.
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => wallBetween(x, z, di, dj));
      if (dirs.length && rand() < 0.75) {
        const [di, dj] = dirs[Math.floor(rand() * dirs.length)];
        center.x += di * CELL * 0.5;
        center.z += dj * CELL * 0.5;
        center.y = 0.3 + rand() * 1.8;
      } else {
        center.y = floorOf(x, z) + (rand() - 0.6) * size;
      }
      addShape(c, kind, center, size, rand);
    }
    // A sculpture on a plinth in the middle of every room. Deeper in they go wrong: bigger, floating
    // above the plinth, tilted, and sometimes several crowding one plinth.
    const sculptures = ["icosa", "dodeca", "octa", "sphere", "torus", "suzanne"];
    for (const r of c.rooms) {
      const cx = (c.ci * CHUNK + r.x0 + r.w / 2) * CELL;
      const cz = (c.cj * CHUNK + r.z0 + r.h / 2) * CELL;
      const f = floorOf(Math.floor(cx / CELL), Math.floor(cz / CELL));
      const ph = 0.8 + rand() * 0.35;
      const yaw = rand() * Math.PI;
      addShape(c, "plinth", new Vector3(cx, f + ph / 2, cz), 1, rand, { scale: [0.8, ph, 0.8], rotation: [0, yaw, 0], color: PLINTH });
      const count = 1 + (rand() < w * 0.6 ? 1 + Math.floor(rand() * 2) : 0);
      for (let k = 0; k < count; k++) {
        const size = (0.36 + rand() * 0.14) * (1 + w * rand() * 1.8);
        const lift = size * (1.05 + (rand() < w ? rand() * w * 3 : 0));
        const spread = k ? 0.35 + rand() * 0.4 : 0;
        const a = rand() * Math.PI * 2;
        const tilt = w * 1.2;
        addShape(c, sculptures[Math.floor(rand() * sculptures.length)], new Vector3(cx + Math.cos(a) * spread, f + ph + lift, cz + Math.sin(a) * spread), size, rand, {
          rotation: [(rand() - 0.5) * tilt, rand() * Math.PI * 2, (rand() - 0.5) * tilt],
        });
      }
    }

    // Presences: still heads at eye height, more of them deeper in.
    if (rand() < w * 1.4) {
      const x = c.ci * CHUNK + Math.floor(rand() * CHUNK);
      const z = c.cj * CHUNK + Math.floor(rand() * CHUNK);
      const center = new Vector3((x + 0.5) * CELL, floorOf(x, z) + 1.65, (z + 0.5) * CELL);
      const p = addShape(c, "suzanne", center, 0.36, rand);
      p.presence = true;
      p.cell = [x, z];
      presences.push(p);
    }
  }

  // options: scale [x, y, z] (instead of size), rotation [x, y, z], color.
  function addShape(c, kind, center, size, rand, options = {}) {
    const geo = kind === "suzanne" ? suzanneGeo : shapeGeos[kind];
    const scale = kind === "suzanne" ? size / 0.8 : size;
    const mesh = new Mesh(geo, material);
    mesh.position.copy(center);
    if (options.rotation) mesh.rotation.set(...options.rotation);
    else mesh.rotation.set((rand() - 0.5) * 1.2, rand() * Math.PI * 2, (rand() - 0.5) * 0.8);
    if (options.scale) mesh.scale.set(...options.scale);
    else mesh.scale.setScalar(scale);
    mesh.updateMatrixWorld(true);
    const collider = new Mesh(kind === "suzanne" ? suzHull : geo, hullMat);
    collider.matrixAutoUpdate = false;
    collider.matrixWorld.copy(mesh.matrixWorld);
    const radius = geo.boundingSphere.radius * (options.scale ? Math.max(...options.scale) : scale) + 0.02;
    const obj = { kind, center, radius, mesh, collider, color: options.color ?? OBJECT_COLORS[Math.floor(rand() * OBJECT_COLORS.length)] };
    addObject(c, obj);
    return obj;
  }

  // Black occluder geometry for a chunk: thick walls and posts as boxes, floors, ceilings and the step faces
  // between cells of different heights.
  function buildMesh(c) {
    const pos = [];
    const quad = (a, b, cc, d) => pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    // A box without its bottom face.
    const box = (xa, xb, ya, yb, za, zb) => {
      quad([xa, ya, za], [xb, ya, za], [xb, yb, za], [xa, yb, za]);
      quad([xb, ya, zb], [xa, ya, zb], [xa, yb, zb], [xb, yb, zb]);
      quad([xa, ya, zb], [xa, ya, za], [xa, yb, za], [xa, yb, zb]);
      quad([xb, ya, za], [xb, ya, zb], [xb, yb, zb], [xb, yb, za]);
      quad([xa, yb, za], [xb, yb, za], [xb, yb, zb], [xa, yb, zb]);
    };
    const N = CHUNK;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = c.ci * N + x;
        const j = c.cj * N + z;
        const idx = z * N + x;
        const x0 = i * CELL, x1 = x0 + CELL, z0 = j * CELL, z1 = z0 + CELL;
        const f = c.floor[idx];
        const h = c.ceil[idx];
        quad([x0, f, z0], [x1, f, z0], [x1, f, z1], [x0, f, z1]);
        if (h < VOID) quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]);
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          const nf = floorOf(i + di, j + dj);
          const nh = ceilOf(i + di, j + dj);
          const bottom = Math.min(f, nf);
          const top = Math.min(VOID, Math.max(h, nh));
          if (wallBetween(i, j, di, dj)) {
            if (di) box(x1 - HW, x1 + HW, bottom, top, z0 + HW, z1 - HW);
            else box(x0 + HW, x1 - HW, bottom, top, z1 - HW, z1 + HW);
          } else {
            const ex0 = di ? x1 : x0, ez0 = di ? z0 : z1;
            if (Math.abs(nf - f) > 1e-3) quad([ex0, bottom, ez0], [x1, bottom, z1], [x1, Math.max(f, nf), z1], [ex0, Math.max(f, nf), ez0]);
            if (Math.abs(nh - h) > 1e-3 && Math.min(h, nh) < VOID) quad([ex0, Math.min(h, nh), ez0], [x1, Math.min(h, nh), z1], [x1, top, z1], [ex0, top, ez0]);
          }
        }
        // The post at this cell's far corner, spanning the four cells around it.
        if (postAt(i + 1, j + 1)) {
          let lo = Infinity;
          let hi = 0;
          for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            lo = Math.min(lo, floorOf(i + a, j + b));
            hi = Math.max(hi, ceilOf(i + a, j + b));
          }
          box(x1 - HW, x1 + HW, lo, Math.min(VOID, hi), z1 - HW, z1 + HW);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  // Load meshes for chunks near the walker and drop far ones.
  let centerKey = null;
  function update(position) {
    const ci = chunkOf(Math.floor(position.x / CELL));
    const cj = chunkOf(Math.floor(position.z / CELL));
    const k = key(ci, cj);
    if (k === centerKey) return;
    centerKey = k;
    for (let a = ci - LOAD_RADIUS; a <= ci + LOAD_RADIUS; a++) for (let b = cj - LOAD_RADIUS; b <= cj + LOAD_RADIUS; b++) data(a, b);
    for (const c of chunks.values()) {
      const near = Math.abs(c.ci - ci) <= LOAD_RADIUS && Math.abs(c.cj - cj) <= LOAD_RADIUS;
      const far = Math.abs(c.ci - ci) > LOAD_RADIUS + 1 || Math.abs(c.cj - cj) > LOAD_RADIUS + 1;
      if (near && !c.mesh) {
        c.mesh = buildMesh(c);
        group.add(c.mesh);
        for (const o of c.owned) group.add(o.mesh);
      } else if (far && c.mesh) {
        group.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh = null;
        for (const o of c.owned) group.remove(o.mesh);
      }
    }
  }

  // Surface colour and brightness at a hit: wallpaper stripes, carpet, ceiling tiles and light panels.
  function surface(kind, p, n, w, out) {
    if (kind === "floor") {
      ramp(CARPET, w, out);
      const speck = 0.82 + 0.18 * Math.sin(p.x * 41.3 + Math.sin(p.z * 37.1) * 3.0);
      return out.multiplyScalar(speck);
    }
    if (kind === "ceiling") {
      const u = ((p.x % 0.6) + 0.6) % 0.6;
      const v = ((p.z % 0.6) + 0.6) % 0.6;
      const ci = ((p.x % CELL) + CELL) % CELL;
      const cz = ((p.z % CELL) + CELL) % CELL;
      if (Math.abs(ci - CELL / 2) < 0.3 && Math.abs(cz - CELL / 2) < 0.6) return out.copy(PANEL).multiplyScalar(2.2);
      return out.copy(TILE).multiplyScalar(u < 0.025 || v < 0.025 ? 0.45 : 0.75);
    }
    ramp(PAPER, w, out);
    const along = Math.abs(n.x) > 0.5 ? p.z : p.x;
    const stripe = Math.sin(along * Math.PI * 2 / 0.16) > 0 ? 1 : 0.86;
    const damask = 0.92 + 0.08 * Math.sin(along * 9.0 + Math.sin(p.y * 7.0) * 2.0);
    // A darker skirting band at the bottom.
    const skirting = p.y < 0.12 ? 0.55 : 1;
    return out.multiplyScalar(stripe * damask * skirting);
  }

  // The first hit along a ray, stepping through the grid cell by cell.
  const _p = new Vector3();
  // Cells a call's rays have passed through: what the listener has heard, so far.
  const heard = new Set();
  // mark: this is a sound ray (not a look), so the cells it crosses count as heard.
  function trace(origin, dir, maxT = 40, mark = false) {
    const tBody = bodyHit(origin, dir);
    return traceWorld(origin, dir, Math.min(maxT, tBody), mark);
  }

  function traceWorld(origin, dir, maxT, mark = false) {
    let i = Math.floor(origin.x / CELL);
    let j = Math.floor(origin.z / CELL);
    const stepI = dir.x > 0 ? 1 : -1;
    const stepJ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dir.x) > 1e-9 ? CELL / Math.abs(dir.x) : Infinity;
    const tDeltaZ = Math.abs(dir.z) > 1e-9 ? CELL / Math.abs(dir.z) : Infinity;
    let tMaxX = Math.abs(dir.x) > 1e-9 ? ((dir.x > 0 ? (i + 1) * CELL : i * CELL) - origin.x) / dir.x : Infinity;
    let tMaxZ = Math.abs(dir.z) > 1e-9 ? ((dir.z > 0 ? (j + 1) * CELL : j * CELL) - origin.z) / dir.z : Infinity;
    let tEnter = 0;
    for (let steps = 0; steps < 64 && tEnter < maxT; steps++) {
      const tExit = Math.min(tMaxX, tMaxZ, maxT);
      const { c, idx } = cell(i, j);
      if (mark) heard.add(`${i},${j}`);
      let best = null;
      // Objects in this cell.
      for (const o of objectsAt(i, j)) {
        const ox = origin.x - o.center.x, oy = origin.y - o.center.y, oz = origin.z - o.center.z;
        const b = ox * dir.x + oy * dir.y + oz * dir.z;
        const cc = ox * ox + oy * oy + oz * oz - o.radius * o.radius;
        if (cc > 0 && (b > 0 || b * b - cc < 0)) continue;
        raycaster.set(origin, dir);
        raycaster.near = 0.001;
        raycaster.far = best ? best.t : tExit + 0.001;
        const hit = raycaster.intersectObject(o.collider, false)[0];
        if (!hit) continue;
        const nrm = hit.face.normal.clone().transformDirection(o.collider.matrixWorld);
        if (nrm.dot(dir) > 0) nrm.negate();
        best = { t: hit.distance, normal: nrm, kind: "object", object: o };
      }
      // The wall halves and corner posts on this cell's side of its edges.
      const x0 = i * CELL, x1 = x0 + CELL, z0 = j * CELL, z1 = z0 + CELL;
      const testBox = (bx0, bx1, bz0, bz1) => {
        let tn = -Infinity, tf = Infinity, nx = 0, nz = 0;
        if (Math.abs(dir.x) < 1e-9) {
          if (origin.x < bx0 || origin.x > bx1) return;
        } else {
          let ta = (bx0 - origin.x) / dir.x, tb = (bx1 - origin.x) / dir.x;
          if (ta > tb) [ta, tb] = [tb, ta];
          if (ta > tn) {
            tn = ta;
            nx = -Math.sign(dir.x);
            nz = 0;
          }
          tf = Math.min(tf, tb);
        }
        if (Math.abs(dir.z) < 1e-9) {
          if (origin.z < bz0 || origin.z > bz1) return;
        } else {
          let ta = (bz0 - origin.z) / dir.z, tb = (bz1 - origin.z) / dir.z;
          if (ta > tb) [ta, tb] = [tb, ta];
          if (ta > tn) {
            tn = ta;
            nx = 0;
            nz = -Math.sign(dir.z);
          }
          tf = Math.min(tf, tb);
        }
        if (tn > tf || tn < 1e-4 || tn < tEnter - 1e-4 || tn > tExit + 1e-4) return;
        if (!best || tn < best.t) best = { t: tn, normal: new Vector3(nx, 0, nz), kind: "wall" };
      };
      if (wallE(i, j)) testBox(x1 - HW, x1, z0, z1);
      if (wallE(i - 1, j)) testBox(x0, x0 + HW, z0, z1);
      if (wallS(i, j)) testBox(x0, x1, z1 - HW, z1);
      if (wallS(i, j - 1)) testBox(x0, x1, z0, z0 + HW);
      if (postAt(i, j)) testBox(x0, x0 + HW, z0, z0 + HW);
      if (postAt(i + 1, j)) testBox(x1 - HW, x1, z0, z0 + HW);
      if (postAt(i, j + 1)) testBox(x0, x0 + HW, z1 - HW, z1);
      if (postAt(i + 1, j + 1)) testBox(x1 - HW, x1, z1 - HW, z1);
      // Floor and ceiling of this cell.
      const f = c.floor[idx];
      const h = c.ceil[idx];
      if (dir.y < -1e-6) {
        const t = (f - origin.y) / dir.y;
        if (t >= tEnter - 1e-4 && t <= tExit && t > 1e-4 && (!best || t < best.t)) best = { t, normal: new Vector3(0, 1, 0), kind: "floor" };
      } else if (dir.y > 1e-6 && h < VOID) {
        const t = (h - origin.y) / dir.y;
        if (t >= tEnter - 1e-4 && t <= tExit && t > 1e-4 && (!best || t < best.t)) best = { t, normal: new Vector3(0, -1, 0), kind: "ceiling" };
      }
      if (best) return finish(origin, dir, best, c.w);
      if (tExit >= maxT) return null;
      // Leaving the cell: a wall, or a step up in the floor or down in the ceiling, stops the ray.
      const alongX = tMaxX < tMaxZ;
      const di = alongX ? stepI : 0;
      const dj = alongX ? 0 : stepJ;
      const y = origin.y + dir.y * tExit;
      const nf = floorOf(i + di, j + dj);
      const nh = ceilOf(i + di, j + dj);
      if (wallBetween(i, j, di, dj) || y < nf || y > nh) {
        const normal = new Vector3(-di, 0, -dj);
        return finish(origin, dir, { t: tExit, normal, kind: "wall" }, c.w);
      }
      tEnter = tExit;
      if (alongX) {
        i += stepI;
        tMaxX += tDeltaX;
      } else {
        j += stepJ;
        tMaxZ += tDeltaZ;
      }
    }
    return null;
  }

  function finish(origin, dir, best, w) {
    const point = origin.clone().addScaledVector(dir, best.t);
    const albedo = best.kind === "object" ? best.object.color.clone() : surface(best.kind, point, best.normal, w, new Color());
    return { point, normal: best.normal, distance: best.t, albedo, shade: true, object: best.object ?? null };
  }

  // Keeps a walker of the given radius inside open space; returns the floor height under it.
  function collide(p, radius = 0.35) {
    const i = Math.floor(p.x / CELL);
    const j = Math.floor(p.z / CELL);
    const f = floorOf(i, j);
    const blocked = (di, dj) => wallBetween(i, j, di, dj) || Math.abs(floorOf(i + di, j + dj) - f) > MAX_STEP || ceilOf(i + di, j + dj) - floorOf(i + di, j + dj) < 2;
    const x0 = i * CELL, z0 = j * CELL;
    const r = radius + HW;
    if (blocked(-1, 0)) p.x = Math.max(p.x, x0 + r);
    if (blocked(1, 0)) p.x = Math.min(p.x, x0 + CELL - r);
    if (blocked(0, -1)) p.z = Math.max(p.z, z0 + r);
    if (blocked(0, 1)) p.z = Math.min(p.z, z0 + CELL - r);
    // The corner posts, as circles around their corners.
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      if (!postAt(i + a, j + b)) continue;
      _p.set(p.x - (i + a) * CELL, 0, p.z - (j + b) * CELL);
      const reach = radius + HW * 1.42;
      const d = _p.length();
      if (d < reach && d > 1e-6) p.addScaledVector(_p.normalize(), reach - d);
    }
    for (const o of objectsAt(i, j)) {
      _p.set(p.x - o.center.x, 0, p.z - o.center.z);
      const reach = o.radius * 0.85 + radius;
      const d = _p.length();
      if (d < reach && o.center.y - o.radius < f + 1.8 && o.center.y + o.radius > f) p.addScaledVector(_p.normalize(), reach - d);
    }
    return floorOf(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
  }

  const canStep = (i, j, di, dj) =>
    !wallBetween(i, j, di, dj) && Math.abs(floorOf(i + di, j + dj) - floorOf(i, j)) <= MAX_STEP && ceilOf(i + di, j + dj) - floorOf(i + di, j + dj) >= 2;

  // A destination and the cells to walk there. The search goes only through heard cells, so the way is known
  // (a dead end already heard is never on it), and the destination is an unheard cell at the edge of what has
  // been heard: a few cells off, ahead rather than behind, deeper rather than back toward the start. With
  // nothing unheard in reach, the heard cell farthest out. avoid: a cell key to leave out (a blocked one).
  function plan(p, heading, rand, avoid = null) {
    const si = Math.floor(p.x / CELL), sj = Math.floor(p.z / CELL);
    const prev = new Map([[`${si},${sj}`, null]]);
    const queue = [[si, sj, 0]];
    const cands = [];
    const radial = (i, j) => Math.hypot((i + 0.5) * CELL - startPos.x, (j + 0.5) * CELL - startPos.z);
    const r0 = radial(si, sj);
    const score = (i, j, d, unheard) => {
      const vx = i - si, vz = j - sj, vl = Math.hypot(vx, vz) || 1;
      const ahead = (vx * heading[0] + vz * heading[1]) / vl;
      const near = d < 3 ? 0.35 : d > 14 ? 0.6 : 1;
      const out = Math.exp(Math.max(-1, Math.min(1, ((radial(i, j) - r0) / CELL) * 0.15)));
      return (unheard ? 1 : 0.25) * near * (1.3 + ahead) * out * (0.7 + rand() * 0.6);
    };
    for (let head = 0; head < queue.length && prev.size < 900; head++) {
      const [i, j, d] = queue[head];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, k = `${ni},${nj}`;
        if (prev.has(k) || k === avoid || !canStep(i, j, di, dj)) continue;
        prev.set(k, [i, j]);
        if (heard.has(k)) {
          queue.push([ni, nj, d + 1]);
          if (d + 1 >= 3) cands.push([ni, nj, score(ni, nj, d + 1, false)]);
        } else cands.push([ni, nj, score(ni, nj, d + 1, true)]);
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b[2] - a[2]);
    const cells = [];
    for (let c = [cands[0][0], cands[0][1]]; c && (c[0] !== si || c[1] !== sj); c = prev.get(`${c[0]},${c[1]}`)) cells.unshift(c);
    return { from: [si, sj], cells };
  }

  // The next cell centre for a wanderer at p heading `heading`: forward if it can, rarely back,
  // and drifting away from the start so a stroll goes deeper.
  function wander(p, heading, rand) {
    const i = Math.floor(p.x / CELL);
    const j = Math.floor(p.z / CELL);
    const f = floorOf(i, j);
    const options = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(
      ([di, dj]) => !wallBetween(i, j, di, dj) && Math.abs(floorOf(i + di, j + dj) - f) <= MAX_STEP && ceilOf(i + di, j + dj) - floorOf(i + di, j + dj) >= 2,
    );
    // Boxed in on a platform: climb out over whatever isn't a wall.
    if (!options.length) options.push(...[[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => !wallBetween(i, j, di, dj)));
    if (!options.length) return null;
    const scored = options.map(([di, dj]) => {
      const back = di === -heading[0] && dj === -heading[1];
      const ahead = di === heading[0] && dj === heading[1];
      const out = (i + di + 0.5) * (i + di + 0.5) + (j + dj + 0.5) * (j + dj + 0.5) > (i + 0.5) ** 2 + (j + 0.5) ** 2;
      // What lies that way: unheard cells reachable through heard ones. None, with the region closed, is
      // a dead end the listener can already hear, and it isn't worth walking into.
      const unknown = frontier(i + di, j + dj, i, j);
      const deadEnd = unknown === 0;
      const s = (deadEnd ? 0.01 : 1) * (1 + Math.min(unknown, 12) * 0.35) * (back ? 0.15 : 1) * (ahead ? 1.4 : 1) * (out ? 1.3 : 1) * (0.6 + rand() * 0.8);
      return { d: [di, dj], s };
    });
    scored.sort((a, b) => b.s - a.s);
    const [di, dj] = scored[0].d;
    return { target: new Vector3((i + di + 0.5) * CELL, 0, (j + dj + 0.5) * CELL), heading: [di, dj], choices: options.length };
  }

  // Unheard cells reachable from (si, sj) without passing back through (fi, fj), exploring only through heard
  // cells (an unheard one counts and isn't entered). Bounded, so it costs little.
  function frontier(si, sj, fi, fj) {
    const seen = new Set([`${fi},${fj}`, `${si},${sj}`]);
    if (!heard.has(`${si},${sj}`)) return 1;
    const queue = [[si, sj]];
    let unknown = 0;
    for (let n = 0; queue.length && n < 60; n++) {
      const [i, j] = queue.shift();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (wallBetween(i, j, di, dj)) continue;
        const k = `${i + di},${j + dj}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (heard.has(k)) queue.push([i + di, j + dj]);
        else unknown++;
      }
    }
    // Ran out of budget with cells left to look at: treat it as open.
    return queue.length ? Math.max(unknown, 1) : unknown;
  }

  // Keeps the watchers 9-16 m away, where there's a clear line to them (so the hole they leave in the
  // scan has something behind it), facing the listener. Come within 7 m and one is somewhere else.
  const _eye = new Vector3();
  const _to = new Vector3();
  function updateWatchers(position, random, enabled = 1) {
    const depth = Math.hypot(position.x - startPos.x, position.z - startPos.z);
    const want = !enabled || depth < 6 ? 0 : 1 + Math.floor(weirdness(depth) * 3.5);
    while (watchers.length > want) watchers.pop();
    for (let k = 0; k < watchers.length; k++) {
      const w = watchers[k];
      const d = Math.hypot(w.feet.x - position.x, w.feet.z - position.z);
      if (d < 7 || d > 22) watchers.splice(k--, 1);
    }
    // A few tries a frame to place a missing one.
    for (let tries = 0; tries < 6 && watchers.length < want; tries++) {
      const a = random() * Math.PI * 2;
      const r = 9 + random() * 7;
      const i = Math.floor((position.x + Math.cos(a) * r) / CELL);
      const j = Math.floor((position.z + Math.sin(a) * r) / CELL);
      const feet = new Vector3((i + 0.5) * CELL + (random() - 0.5) * 0.8, floorOf(i, j), (j + 0.5) * CELL + (random() - 0.5) * 0.8);
      if (ceilOf(i, j) - feet.y < 2) continue;
      if (objectsAt(i, j).length) continue;
      _eye.copy(position);
      _to.set(feet.x - _eye.x, feet.y + 1.3 - _eye.y, feet.z - _eye.z);
      const dist = _to.length();
      _to.divideScalar(dist);
      const hit = traceWorld(_eye, _to, dist + 0.1);
      if (hit && hit.distance < dist - 0.3) continue;
      watchers.push({ feet, cos: 1, sin: 0 });
    }
    for (const w of watchers) {
      const yaw = Math.atan2(-(position.x - w.feet.x), -(position.z - w.feet.z));
      w.cos = Math.cos(yaw);
      w.sin = Math.sin(yaw);
    }
  }

  // Each call, presences that heard it step one cell closer and turn to face the caller.
  function onCall(from) {
    const fi = Math.floor(from.x / CELL);
    const fj = Math.floor(from.z / CELL);
    const now = performance.now();
    for (const p of presences) {
      const [x, z] = p.cell;
      if (Math.hypot(x - fi, z - fj) > 9 || (x === fi && z === fj)) continue;
      // At most a step every 1.5 s, however fast the calls come.
      if (now - (p.movedAt ?? -Infinity) < 1500) continue;
      p.movedAt = now;
      const moves = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => !wallBetween(x, z, di, dj));
      moves.sort((a, b) => Math.hypot(x + a[0] - fi, z + a[1] - fj) - Math.hypot(x + b[0] - fi, z + b[1] - fj));
      const [di, dj] = moves[0] ?? [0, 0];
      if (x + di === fi && z + dj === fj) continue;
      removeObject(p);
      const wasShown = !!p.mesh.parent;
      p.cell = [x + di, z + dj];
      p.center.set((x + di + 0.5) * CELL, floorOf(x + di, z + dj) + 1.65, (z + dj + 0.5) * CELL);
      p.mesh.position.copy(p.center);
      p.mesh.rotation.set(0, Math.atan2(from.x - p.center.x, from.z - p.center.z), 0);
      p.mesh.updateMatrixWorld(true);
      p.collider.matrixWorld.copy(p.mesh.matrixWorld);
      const home = data(chunkOf(x + di), chunkOf(z + dj));
      addObject(home, p);
      if (home.mesh && !wasShown) group.add(p.mesh);
      if (!home.mesh && wasShown) group.remove(p.mesh);
    }
  }

  function reset() {
    for (const c of chunks.values()) if (c.mesh) c.mesh.geometry.dispose();
    group.clear();
    chunks.clear();
    cellObjects.clear();
    heard.clear();
    watchers.length = 0;
    presences.length = 0;
    centerKey = null;
    seedHash = Math.floor(seededRandom(`${getSeed()}:hash`)() * 4294967296);
  }
  reset();

  const startPos = new Vector3(CELL * 0.5, 0, CELL * 0.5);
  return {
    group,
    trace,
    collide,
    wander,
    plan,
    onCall,
    update,
    updateWatchers,
    // Directions out of the cell at p that aren't walled off.
    // What the eyes see along a ray: the world without the bodies (one's own is right behind the eyes).
    see: (origin, dir, maxT) => traceWorld(origin, dir, maxT, false),
    openings(p) {
      const i = Math.floor(p.x / CELL);
      const j = Math.floor(p.z / CELL);
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => !wallBetween(i, j, di, dj));
    },
    // For the debug map.
    map: {
      wallE: (i, j) => wallE(i, j),
      wallS: (i, j) => wallS(i, j),
      floor: (i, j) => floorOf(i, j),
      ceil: (i, j) => ceilOf(i, j),
      heard: (i, j) => heard.has(`${i},${j}`),
      objects: (i, j) => objectsAt(i, j),
      void: VOID,
    },
    // Objects with a cell within r metres of p (each once).
    objectsNear(p, r) {
      const out = new Set();
      for (let i = Math.floor((p.x - r) / CELL); i <= Math.floor((p.x + r) / CELL); i++) {
        for (let j = Math.floor((p.z - r) / CELL); j <= Math.floor((p.z + r) / CELL); j++) for (const o of objectsAt(i, j)) out.add(o);
      }
      return [...out];
    },
    watcherCount: () => watchers.length,
    watchersList: () => watchers,
    bodyParts: BODY,
    heardCount: () => heard.size,
    watcherFeet: () => watchers.map((w) => w.feet.clone()),
    reset,
    // Where the listener stands (feet) and faces (yaw, 0 = -z).
    setBody(feet, yaw, on = true) {
      body.feet.copy(feet);
      body.cos = Math.cos(yaw);
      body.sin = Math.sin(yaw);
      body.on = on;
    },
    startPos,
    depthAt: (p) => Math.hypot(p.x - startPos.x, p.z - startPos.z),
    weirdnessAt: (p) => weirdness(Math.hypot(p.x, p.z)),
  };
}
