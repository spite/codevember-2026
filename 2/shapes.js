import { BoxGeometry, BufferAttribute, BufferGeometry, DodecahedronGeometry, IcosahedronGeometry, TorusGeometry, Vector3 } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";
import { suzanneGeometry } from "modules/suzanne/suzanneMesh.js";

// The objects that burst: evenly tessellated surfaces about the size of a unit sphere, with smooth
// normals. `depth` is how far inside the surface there is room for filling; `thin` marks shapes with
// parts thinner than a shell (Suzanne's ears).

function sphere() {
  return mergeVertices(new IcosahedronGeometry(1, 40));
}

function torus() {
  return mergeVertices(new TorusGeometry(0.7, 0.32, 96, 200).deleteAttribute("uv"));
}

// A subdivided cube pushed onto a rounded box: each point is its nearest point on the inner box
// plus the radius along the way out.
function roundedCube(half = 0.78, radius = 0.26, segments = 56) {
  const geometry = mergeVertices(new BoxGeometry(2, 2, 2, segments, segments, segments).deleteAttribute("uv").deleteAttribute("normal"));
  const p = geometry.attributes.position;
  const v = new Vector3(), c = new Vector3();
  const inner = half - radius;
  const normals = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).multiplyScalar(half);
    c.set(Math.max(-inner, Math.min(inner, v.x)), Math.max(-inner, Math.min(inner, v.y)), Math.max(-inner, Math.min(inner, v.z)));
    v.sub(c).normalize();
    normals.set([v.x, v.y, v.z], i * 3);
    v.multiplyScalar(radius).add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  return geometry;
}

// A polyhedron with rounded edges and corners: the p-norm of the distances to its face planes, so
// each point of a fine sphere is pushed out along its ray to where that norm reaches 1.
function smoothPolyhedron(faceNormals, k = 32) {
  const geometry = sphere();
  const p = geometry.attributes.position;
  const normals = new Float32Array(p.count * 3);
  const u = new Vector3(), n = new Vector3();
  let max = 0;
  for (let i = 0; i < p.count; i++) {
    u.fromBufferAttribute(p, i).normalize();
    let sum = 0;
    n.set(0, 0, 0);
    for (const f of faceNormals) {
      const d = Math.max(0, f.dot(u));
      sum += d ** k;
      n.addScaledVector(f, d ** (k - 1));
    }
    u.multiplyScalar(1 / sum ** (1 / k));
    max = Math.max(max, u.length());
    p.setXYZ(i, u.x, u.y, u.z);
    n.normalize();
    normals.set([n.x, n.y, n.z], i * 3);
  }
  geometry.scale(1.05 / max, 1.05 / max, 1.05 / max);
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  return geometry;
}

// The unit vectors to a polyhedron's corners, which are the face normals of its dual.
function corners(geometry) {
  const p = geometry.attributes.position;
  const out = new Map();
  for (let i = 0; i < p.count; i++) {
    const v = new Vector3().fromBufferAttribute(p, i).normalize();
    out.set(v.toArray().map((x) => x.toFixed(4)).join(), v);
  }
  return [...out.values()];
}

const icosahedron = () => smoothPolyhedron(corners(new DodecahedronGeometry(1, 0)));
const dodecahedron = () => smoothPolyhedron(corners(new IcosahedronGeometry(1, 0)));

async function suzanne() {
  const text = await (await fetch(new URL("../assets/suzanne.obj", import.meta.url))).text();
  const geometry = suzanneGeometry(text, 2);
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox.getCenter(new Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.computeBoundingSphere();
  geometry.scale(1.15 / geometry.boundingSphere.radius, 1.15 / geometry.boundingSphere.radius, 1.15 / geometry.boundingSphere.radius);
  geometry.computeVertexNormals();
  return geometry;
}

const SHAPES = {
  sphere: { build: sphere, depth: 0.75 },
  torus: { build: torus, depth: 0.22 },
  "rounded cube": { build: roundedCube, depth: 0.55 },
  icosahedron: { build: icosahedron, depth: 0.65 },
  dodecahedron: { build: dodecahedron, depth: 0.7 },
  suzanne: { build: suzanne, depth: 0.3, thin: true },
};

const cache = new Map();

// The shape's surface: positions, normals, triangles and an area-weighted sampler.
async function loadShape(name) {
  if (cache.has(name)) return cache.get(name);
  const shape = SHAPES[name];
  const geometry = await shape.build();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const position = geometry.attributes.position.array;
  const normal = geometry.attributes.normal.array;
  const index = geometry.index ? geometry.index.array : Uint32Array.from({ length: position.length / 3 }, (_, i) => i);
  const area = new Float64Array(index.length / 3);
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  let total = 0;
  for (let t = 0; t < area.length; t++) {
    a.fromArray(position, index[t * 3] * 3);
    b.fromArray(position, index[t * 3 + 1] * 3).sub(a);
    c.fromArray(position, index[t * 3 + 2] * 3).sub(a);
    total += b.cross(c).length() * 0.5;
    area[t] = total;
  }
  // A random point on the surface and its normal.
  const sample = (rand, p = new Vector3(), n = new Vector3()) => {
    const x = rand() * total;
    let lo = 0, hi = area.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (area[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = rand(), v = rand();
    if (u + v > 1) (u = 1 - u), (v = 1 - v);
    const w = 1 - u - v;
    const [i, j, k] = [index[lo * 3] * 3, index[lo * 3 + 1] * 3, index[lo * 3 + 2] * 3];
    for (let d = 0; d < 3; d++) {
      p.setComponent(d, position[i + d] * w + position[j + d] * u + position[k + d] * v);
      n.setComponent(d, normal[i + d] * w + normal[j + d] * u + normal[k + d] * v);
    }
    n.normalize();
    return p;
  };
  const room = shape.thin ? roomInside(position, normal) : new Float32Array(position.length / 3).fill(1e3);
  const result = { name, geometry, position, normal, index, room, depth: shape.depth, sample };
  cache.set(name, result);
  return result;
}

// How far each vertex can be pushed in along its normal without reaching the far side (thin parts,
// like ears): under half the distance to the nearest vertex facing the other way behind it.
// Distances beyond REACH don't matter, since no shell is that thick.
function roomInside(position, normal, REACH = 0.4) {
  const count = position.length / 3;
  const room = new Float32Array(count).fill(REACH);
  const grid = new Map();
  const cell = (x) => Math.floor(x / REACH);
  for (let i = 0; i < count; i++) {
    const k = `${cell(position[i * 3])},${cell(position[i * 3 + 1])},${cell(position[i * 3 + 2])}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  for (let i = 0; i < count; i++) {
    const px = position[i * 3], py = position[i * 3 + 1], pz = position[i * 3 + 2];
    const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
    const cx = cell(px), cy = cell(py), cz = cell(pz);
    let best = REACH * REACH;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            const ex = position[j * 3] - px, ey = position[j * 3 + 1] - py, ez = position[j * 3 + 2] - pz;
            if (ex * nx + ey * ny + ez * nz >= 0) continue;
            if (nx * normal[j * 3] + ny * normal[j * 3 + 1] + nz * normal[j * 3 + 2] > -0.3) continue;
            best = Math.min(best, ex * ex + ey * ey + ez * ez);
          }
        }
    room[i] = Math.sqrt(best) * 0.45;
  }
  return room;
}

// The surface pushed in along its normals, for a core left standing inside the shell.
function offsetGeometry(shape, distance) {
  const p = shape.position.slice();
  for (let i = 0; i < p.length; i++) p[i] -= shape.normal[i] * Math.min(distance, shape.room[Math.floor(i / 3)]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(p, 3));
  geometry.setAttribute("normal", new BufferAttribute(shape.normal.slice(), 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from(shape.index), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export { SHAPES, loadShape, offsetGeometry };
