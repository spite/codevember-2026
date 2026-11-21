// The objects that get struck, each as a signed distance baked to an N³ grid (cell centres over [-EXTENT, EXTENT]³,
// x fastest, bounding radius about 1): the glass is ray-traced from it, the click is found in it and the figure grows
// inside it. Suzanne comes from the grid day 7 baked (tools/suzanne-sdf.mjs), which sets N and EXTENT for the rest.
const N = 96;
const EXTENT = 1.12;
const CELL = (2 * EXTENT) / N;

const PHI = (1 + Math.sqrt(5)) / 2;

function normals(list) {
  return list.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
}
// Half of each solid's face normals (the other half are their opposites).
const DODECA = normals([[0, 1, PHI], [0, -1, PHI], [1, PHI, 0], [-1, PHI, 0], [PHI, 0, 1], [PHI, 0, -1]]);
const ICOSA = normals([
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1],
  [0, 1 / PHI, PHI], [0, -1 / PHI, PHI], [1 / PHI, PHI, 0], [-1 / PHI, PHI, 0], [PHI, 0, 1 / PHI], [PHI, 0, -1 / PHI],
]);
const OCTA = normals([[1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]]);
// A solid cut by pairs of planes at r from the centre. Where planes meet they are blended by a soft maximum of all of
// them at once (log-sum-exp), which treats every plane alike: folding a two-way smooth maximum over them one by one
// rounds an edge well but leaves creases round a vertex, where five faces meet.
const planes = (faces, r) => (x, y, z, edge) => {
  const k = edge * 0.5;
  let top = -Infinity;
  for (const n of faces) top = Math.max(top, Math.abs(x * n[0] + y * n[1] + z * n[2]) - r);
  let sum = 0;
  for (const n of faces) sum += Math.exp((Math.abs(x * n[0] + y * n[1] + z * n[2]) - r - top) / k);
  return top + k * Math.log(sum);
};
// The faceted shapes take two controls: edge, the radius their edges are rounded to, and inflate, how far they
// swell toward a ball (or, for the block, an ellipsoid) of about their size.
const swell = (fn, ball) => (x, y, z, edge, inflate) => {
  const d = fn(x, y, z, Math.max(edge, 0.004));
  return d + (ball(x, y, z) - d) * inflate * 0.6;
};
const ballOf = (r) => (x, y, z) => Math.hypot(x, y, z) - r;

function roundBox(x, y, z, bx, by, bz, r) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
function roundCylinder(x, y, z, radius, half, r) {
  const dx = Math.hypot(x, z) - radius + r, dy = Math.abs(y) - half + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const BLOCK = [0.6, 0.72, 0.42];
const SHAPES = {
  sphere: (x, y, z) => Math.hypot(x, y, z) - 0.9,
  block: swell((x, y, z, e) => roundBox(x, y, z, BLOCK[0], BLOCK[1], BLOCK[2], e), (x, y, z) => (Math.hypot(x / BLOCK[0], y / BLOCK[1], z / BLOCK[2]) / 1.3 - 1) * 0.55),
  cube: swell((x, y, z, e) => roundBox(x, y, z, 0.56, 0.56, 0.56, e), ballOf(0.76)),
  cylinder: (x, y, z) => roundCylinder(x, y, z, 0.52, 0.76, 0.05),
  bottle: (x, y, z) => smin(roundCylinder(x, y + 0.2, z, 0.5, 0.62, 0.12), roundCylinder(x, y - 0.6, z, 0.2, 0.3, 0.03), 0.25),
  octahedron: swell(planes(OCTA, 0.566), ballOf(0.75)),
  dodecahedron: swell(planes(DODECA, 0.72), ballOf(0.82)),
  icosahedron: swell(planes(ICOSA, 0.74), ballOf(0.84)),
  // Upright, on its rim.
  torus: (x, y, z) => Math.hypot(Math.hypot(x, y) - 0.6, z) - 0.33,
  suzanne: null,
};
// The shapes the edge and inflate controls change.
const FACETED = ["block", "cube", "octahedron", "dodecahedron", "icosahedron"];

function halfToFloat(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 31, m = u & 1023;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return s * 1e3;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

let suzanne = null;
const SUZANNE_TILT = -0.37;
async function loadSuzanne() {
  const response = await fetch(new URL("../assets/suzanne-sdf-96.bin", import.meta.url));
  if (!response.ok) throw new Error(`suzanne-sdf-96.bin: ${response.status}`);
  const raw = Float32Array.from(new Uint16Array(await response.arrayBuffer()), halfToFloat);
  // The grid has her nose down: tilted back (-0.37 about x, as day 7 does) she sits on her chin and looks ahead.
  const c = Math.cos(SUZANNE_TILT), s = Math.sin(SUZANNE_TILT);
  suzanne = new Float32Array(N * N * N);
  for (let k = 0, i = 0; k < N; k++) {
    const z = -EXTENT + (k + 0.5) * CELL;
    for (let j = 0; j < N; j++) {
      const y = -EXTENT + (j + 0.5) * CELL;
      for (let l = 0; l < N; l++, i++) suzanne[i] = sample(raw, -EXTENT + (l + 0.5) * CELL, y * c + z * s, -y * s + z * c);
    }
  }
}

let last = { key: null, result: null };
// { grid, minY }: the distances, and the lowest point of the object, which is what stands on the plinth.
function bake(name, edge = 0.03, inflate = 0) {
  const fn = SHAPES[name];
  const key = FACETED.includes(name) ? `${name} ${edge} ${inflate}` : name;
  if (last.key === key) return last.result;
  const grid = fn ? new Float32Array(N * N * N) : suzanne;
  let minY = EXTENT;
  for (let k = 0, i = 0; k < N; k++) {
    const z = -EXTENT + (k + 0.5) * CELL;
    for (let j = 0; j < N; j++) {
      const y = -EXTENT + (j + 0.5) * CELL;
      for (let l = 0; l < N; l++, i++) {
        if (fn) grid[i] = fn(-EXTENT + (l + 0.5) * CELL, y, z, edge, inflate);
        if (grid[i] < 0 && y < minY) minY = y;
      }
    }
  }
  // Where the surface is, between the lowest cell inside and the one under it.
  last = { key, result: { grid, minY: minY - CELL * 0.5 } };
  return last.result;
}

// Trilinear, clamped at the grid's edge.
function sample(grid, x, y, z) {
  const fx = Math.min(Math.max((x + EXTENT) / CELL - 0.5, 0), N - 1.001);
  const fy = Math.min(Math.max((y + EXTENT) / CELL - 0.5, 0), N - 1.001);
  const fz = Math.min(Math.max((z + EXTENT) / CELL - 0.5, 0), N - 1.001);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const o = ix + N * (iy + N * iz);
  const a = grid[o] + (grid[o + 1] - grid[o]) * tx;
  const b = grid[o + N] + (grid[o + N + 1] - grid[o + N]) * tx;
  const c = grid[o + N * N] + (grid[o + N * N + 1] - grid[o + N * N]) * tx;
  const d = grid[o + N * N + N] + (grid[o + N * N + N + 1] - grid[o + N * N + N]) * tx;
  const ab = a + (b - a) * ty, cd = c + (d - c) * ty;
  return ab + (cd - ab) * tz;
}

// Where a ray (object space, unit direction) meets the surface: { point, normal } or null.
function trace(grid, ox, oy, oz, dx, dy, dz) {
  // Start where the ray enters the bounding sphere of the grid's cube.
  const b = ox * dx + oy * dy + oz * dz;
  const R = EXTENT * 1.5;
  const disc = b * b - (ox * ox + oy * oy + oz * oz - R * R);
  if (disc < 0) return null;
  let t = Math.max(0, -b - Math.sqrt(disc));
  const end = -b + Math.sqrt(disc);
  for (let i = 0; i < 160 && t < end; i++) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const outside = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - (EXTENT - CELL);
    const d = outside > 0 ? outside + CELL : sample(grid, x, y, z);
    if (d < 0.002) {
      const e = CELL;
      const nx = sample(grid, x + e, y, z) - sample(grid, x - e, y, z);
      const ny = sample(grid, x, y + e, z) - sample(grid, x, y - e, z);
      const nz = sample(grid, x, y, z + e) - sample(grid, x, y, z - e);
      const l = Math.hypot(nx, ny, nz) || 1;
      return { point: [x, y, z], normal: [nx / l, ny / l, nz / l] };
    }
    t += Math.max(d * 0.9, 0.002);
  }
  return null;
}

const shapeNames = Object.keys(SHAPES);

// The same shapes for the shaders, exact: a grid's trilinear samples can't hold a crease, so a polyhedron traced
// from the baked texture has wavy edges and dimpled faces. shapeId is the shape's index in shapeNames; only Suzanne
// is read from the texture. Mirrors SHAPES above, number for number.
const glslVec3s = (list) => `vec3[${list.length}](${list.map((n) => `vec3(${n.map((v) => v.toFixed(7)).join(", ")})`).join(", ")})`;
const sdfGLSL = /* glsl */ `
uniform sampler3D tSdf;
uniform int shapeId;
uniform float shapeEdge;
uniform float shapeInflate;
const float SDF_INV = ${(0.5 / EXTENT).toFixed(6)};
const float SDF_CELL = ${CELL.toFixed(6)};
const float SDF_BOX = ${(EXTENT - CELL).toFixed(4)};
const vec3 SDF_OCTA[${OCTA.length}] = ${glslVec3s(OCTA)};
const vec3 SDF_DODECA[${DODECA.length}] = ${glslVec3s(DODECA)};
const vec3 SDF_ICOSA[${ICOSA.length}] = ${glslVec3s(ICOSA)};
float sdfRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdfRoundCylinder(vec3 p, float radius, float hh, float r) {
  vec2 d = vec2(length(p.xz) - radius + r, abs(p.y) - hh + r);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}
float sdfSwell(float d, float ball) {
  return d + (ball - d) * shapeInflate * 0.6;
}
float sdf(vec3 p) {
  float e = max(shapeEdge, 0.004), k = e * 0.5;
  if (shapeId == ${shapeNames.indexOf("sphere")}) return length(p) - 0.9;
  if (shapeId == ${shapeNames.indexOf("block")}) return sdfSwell(sdfRoundBox(p, vec3(${BLOCK.join(", ")}), e), (length(p / vec3(${BLOCK.join(", ")})) / 1.3 - 1.0) * 0.55);
  if (shapeId == ${shapeNames.indexOf("cube")}) return sdfSwell(sdfRoundBox(p, vec3(0.56), e), length(p) - 0.76);
  if (shapeId == ${shapeNames.indexOf("cylinder")}) return sdfRoundCylinder(p, 0.52, 0.76, 0.05);
  if (shapeId == ${shapeNames.indexOf("bottle")}) {
    float a = sdfRoundCylinder(p + vec3(0.0, 0.2, 0.0), 0.5, 0.62, 0.12), b = sdfRoundCylinder(p - vec3(0.0, 0.6, 0.0), 0.2, 0.3, 0.03);
    float h = max(0.25 - abs(a - b), 0.0) / 0.25;
    return min(a, b) - h * h * 0.25 * 0.25;
  }
  if (shapeId == ${shapeNames.indexOf("octahedron")}) {
    float top = -1e3, sum = 0.0;
    for (int i = 0; i < ${OCTA.length}; i++) top = max(top, abs(dot(p, SDF_OCTA[i])) - 0.566);
    for (int i = 0; i < ${OCTA.length}; i++) sum += exp((abs(dot(p, SDF_OCTA[i])) - 0.566 - top) / k);
    float d = top + k * log(sum);
    return sdfSwell(d, length(p) - 0.75);
  }
  if (shapeId == ${shapeNames.indexOf("dodecahedron")}) {
    float top = -1e3, sum = 0.0;
    for (int i = 0; i < ${DODECA.length}; i++) top = max(top, abs(dot(p, SDF_DODECA[i])) - 0.72);
    for (int i = 0; i < ${DODECA.length}; i++) sum += exp((abs(dot(p, SDF_DODECA[i])) - 0.72 - top) / k);
    float d = top + k * log(sum);
    return sdfSwell(d, length(p) - 0.82);
  }
  if (shapeId == ${shapeNames.indexOf("icosahedron")}) {
    float top = -1e3, sum = 0.0;
    for (int i = 0; i < ${ICOSA.length}; i++) top = max(top, abs(dot(p, SDF_ICOSA[i])) - 0.74);
    for (int i = 0; i < ${ICOSA.length}; i++) sum += exp((abs(dot(p, SDF_ICOSA[i])) - 0.74 - top) / k);
    float d = top + k * log(sum);
    return sdfSwell(d, length(p) - 0.84);
  }
  if (shapeId == ${shapeNames.indexOf("torus")}) return length(vec2(length(p.xy) - 0.6, p.z)) - 0.33;
  // Suzanne, from the grid; outside it, at least as far as its box.
  float beyond = length(max(abs(p) - SDF_BOX, 0.0));
  return beyond > 0.0 ? beyond + SDF_CELL : textureLod(tSdf, p * SDF_INV + 0.5, 0.0).r;
}
vec3 sdfNormal(vec3 p) {
  vec2 e = vec2(shapeId == ${shapeNames.indexOf("suzanne")} ? SDF_CELL * 1.2 : 0.0015, 0.0);
  return normalize(vec3(sdf(p + e.xyy) - sdf(p - e.xyy), sdf(p + e.yxy) - sdf(p - e.yxy), sdf(p + e.yyx) - sdf(p - e.yyx)));
}
`;

export { N, EXTENT, CELL, shapeNames, FACETED, sdfGLSL, loadSuzanne, bake, sample, trace };
