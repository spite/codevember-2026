// Worker-safe mesh builder: plain typed arrays out, no three.js or DOM.

class V3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    return this.set(v.x, v.y, v.z);
  }
  multiplyScalar(s) {
    return this.set(this.x * s, this.y * s, this.z * s);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  add3(x, y, z) {
    return this.set(this.x + x, this.y + y, this.z + z);
  }
  length() {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize() {
    return this.multiplyScalar(1 / (this.length() || 1));
  }
  negate() {
    return this.multiplyScalar(-1);
  }
  subVectors(a, b) {
    return this.set(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  addScaledVector(v, s) {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }
  crossVectors(a, b) {
    return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
}

// Smooth 3D value noise in -1..1 from a seeded random stream
function makeValueNoise(rng) {
  const table = new Float32Array(512).map(() => rng() * 2 - 1);
  const perm = new Uint16Array(512).map((_, i) => i & 255);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const at = (x, y, z) => table[perm[(perm[(perm[x & 255] + y) & 255] + z) & 255]];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
    const lerp = (a, b, t) => a + (b - a) * t;
    return lerp(
      lerp(lerp(at(ix, iy, iz), at(ix + 1, iy, iz), fx), lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
      lerp(lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy),
      fz,
    );
  };
}

// Same stream as modules/random.js seededRandom, which can't load in a worker.
function seededRandom(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cubeToSphere(x, y, z, out) {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const sx = x * Math.sqrt(Math.max(0, 1 - y2 * 0.5 - z2 * 0.5 + (y2 * z2) / 3));
  const sy = y * Math.sqrt(Math.max(0, 1 - z2 * 0.5 - x2 * 0.5 + (z2 * x2) / 3));
  const sz = z * Math.sqrt(Math.max(0, 1 - x2 * 0.5 - y2 * 0.5 + (x2 * y2) / 3));
  return out.set(sx, sy, sz).normalize();
}

// Cube faces match baker.js: 0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
function faceUVToCube(face, u, v, out) {
  const s = u * 2 - 1;
  const t = v * 2 - 1;
  if (face === 0) return out.set(1, t, -s);
  if (face === 1) return out.set(-1, t, s);
  if (face === 2) return out.set(s, 1, -t);
  if (face === 3) return out.set(s, -1, t);
  if (face === 4) return out.set(s, t, 1);
  return out.set(-s, t, -1);
}

function smoothMaxPlanes(planes, k) {
  return (dir) => {
    let maxDot = -1e9;
    for (let i = 0; i < planes.length; i++) {
      const v = dir.dot(planes[i].n) / planes[i].d;
      if (v > maxDot) maxDot = v;
    }
    let sum = 0;
    for (let i = 0; i < planes.length; i++) {
      sum += Math.exp((dir.dot(planes[i].n) / planes[i].d - maxDot) * k);
    }
    return maxDot + Math.log(sum) / k;
  };
}

// dir -> surface position for the genus-0 shapes
// ── Suzanne ──────────────────────────────────────────────────────────────────────────────────────────────
// Her baked distance field (tools/suzanne-sdf.mjs: 96³ half floats at cell centres over [-1.12, 1.12]³, x fastest),
// tilted back 0.37 rad about x so she looks ahead instead of nose-down.
const SUZ_N = 96;
const SUZ_EXTENT = 1.12;
const SUZ_TILT = -0.37;
let suzanneField = null;

function halfToFloat(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 31, m = u & 1023;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return s * 1e3;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// Synchronous: the mesh worker can block on it; node reads the file
function loadSuzanneField() {
  if (suzanneField) return suzanneField;
  const bytes = readBytesSync("../assets/suzanne-sdf-96.bin");
  const raw = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const grid = Float32Array.from(raw, halfToFloat);
  const cell = (2 * SUZ_EXTENT) / SUZ_N;
  const c = Math.cos(SUZ_TILT), sn = Math.sin(SUZ_TILT);
  const at = (i, j, k) => grid[(k * SUZ_N + j) * SUZ_N + i];
  // Upright space -> grid space, trilinear, and distance to the box added outside it
  suzanneField = (x, y, z) => {
    const gy = y * c + z * sn, gz = -y * sn + z * c;
    const f = (v) => (v + SUZ_EXTENT) / cell - 0.5;
    const fx = Math.min(SUZ_N - 1.001, Math.max(0, f(x)));
    const fy = Math.min(SUZ_N - 1.001, Math.max(0, f(gy)));
    const fz = Math.min(SUZ_N - 1.001, Math.max(0, f(gz)));
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const l = (a, b, t) => a + (b - a) * t;
    const d = l(
      l(l(at(i, j, k), at(i + 1, j, k), tx), l(at(i, j + 1, k), at(i + 1, j + 1, k), tx), ty),
      l(l(at(i, j, k + 1), at(i + 1, j, k + 1), tx), l(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), tx), ty),
      tz,
    );
    const ox = Math.max(Math.abs(x) - SUZ_EXTENT, 0), oy = Math.max(Math.abs(gy) - SUZ_EXTENT, 0), oz = Math.max(Math.abs(gz) - SUZ_EXTENT, 0);
    return d + Math.hypot(ox, oy, oz);
  };
  return suzanneField;
}

// A sphere grid shrink-wrapped onto her surface: each direction from the centre gets a point on Suzanne, so she
// reuses the sphere's atlas and adaptive tessellation. Projection onto the field alternates with tangential
// smoothing, which keeps the grid from bunching; deep concavities (behind the ears) stay webbed over.
const WRAP_N = 96;
let suzanneWrap = null;

// Synchronous read of a file next to this module (worker: XHR; node: fs)
function readBytesSync(name) {
  const url = new URL(name, import.meta.url);
  if (typeof XMLHttpRequest !== "undefined") {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url.href, false);
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) return null;
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }
  try {
    return new Uint8Array(globalThis.__readFileSync(url));
  } catch {
    return null;
  }
}

// The wrap is precomputed into suzanne-wrap.bin (half floats, xyzw per grid point, faces stacked): see
// computeSuzanneWrap, which builds it when the file is missing
function buildSuzanneWrap() {
  if (suzanneWrap) return suzanneWrap;
  const N = WRAP_N;
  const stride = N + 1;
  const count = 6 * stride * stride;
  let pos;
  const bytes = readBytesSync("./suzanne-wrap.bin");
  if (bytes && bytes.byteLength === count * 8) {
    const half = new Uint16Array(bytes.buffer, bytes.byteOffset, count * 4);
    pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) pos[i * 3 + c] = halfToFloat(half[i * 4 + c]);
  } else {
    pos = computeSuzanneWrap();
  }
  suzanneWrap = makeWrapLookup(pos, N);
  return suzanneWrap;
}

function computeSuzanneWrap() {
  const field = loadSuzanneField();
  const N = WRAP_N;
  const stride = N + 1;
  const count = 6 * stride * stride;
  const pos = new Float32Array(count * 3);
  const dirs = new Float32Array(count * 3);
  // Gnomonic cube faces: +x, -x, +y, -y, +z, -z
  const faceDir = (f, u, v, o) => {
    const a = u * 2 - 1, b = v * 2 - 1;
    if (f === 0) o.set(1, b, -a);
    else if (f === 1) o.set(-1, b, a);
    else if (f === 2) o.set(a, 1, -b);
    else if (f === 3) o.set(a, -1, b);
    else if (f === 4) o.set(a, b, 1);
    else o.set(-a, b, -1);
    return o.normalize();
  };
  const d = new V3();
  const weld = new Map();
  const canon = new Int32Array(count);
  for (let f = 0, i = 0; f < 6; f++) {
    for (let y = 0; y <= N; y++) {
      for (let x = 0; x <= N; x++, i++) {
        faceDir(f, x / N, y / N, d);
        dirs.set([d.x, d.y, d.z], i * 3);
        pos.set([d.x * 1.3, d.y * 1.3, d.z * 1.3], i * 3);
        const key = `${Math.round(d.x * 1e5)},${Math.round(d.y * 1e5)},${Math.round(d.z * 1e5)}`;
        if (!weld.has(key)) weld.set(key, i);
        canon[i] = weld.get(key);
      }
    }
  }
  // Neighbours of each welded vertex across faces
  const nb = new Map();
  const link = (a, b) => {
    a = canon[a];
    b = canon[b];
    if (a === b) return;
    if (!nb.has(a)) nb.set(a, new Set());
    nb.get(a).add(b);
  };
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y <= N; y++) {
      for (let x = 0; x <= N; x++) {
        const i = f * stride * stride + y * stride + x;
        if (x > 0) link(i, i - 1);
        if (x < N) link(i, i + 1);
        if (y > 0) link(i, i - stride);
        if (y < N) link(i, i + stride);
      }
    }
  }
  const roots = [...nb.keys()];
  const nbArr = roots.map((r) => [...nb.get(r)]);
  const g = new V3();
  const grad = (x, y, z) => {
    const h = 0.01;
    return g.set(field(x + h, y, z) - field(x - h, y, z), field(x, y + h, z) - field(x, y - h, z), field(x, y, z + h) - field(x, y, z - h)).normalize();
  };
  const avg = new Float32Array(count * 3);
  const iterations = 140;
  for (let it = 0; it < iterations; it++) {
    const smooth = it < iterations - 15 ? 0.6 : 0.15;
    for (let r = 0; r < roots.length; r++) {
      const i = roots[r] * 3;
      let ax = 0, ay = 0, az = 0;
      for (const n of nbArr[r]) {
        ax += pos[n * 3];
        ay += pos[n * 3 + 1];
        az += pos[n * 3 + 2];
      }
      const k = 1 / nbArr[r].length;
      avg[i] = ax * k;
      avg[i + 1] = ay * k;
      avg[i + 2] = az * k;
    }
    for (let r = 0; r < roots.length; r++) {
      const i = roots[r] * 3;
      let x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const dist = field(x, y, z);
      grad(x, y, z);
      // Tangential part of the pull toward the neighbours' centroid
      let mx = avg[i] - x, my = avg[i + 1] - y, mz = avg[i + 2] - z;
      const dn = mx * g.x + my * g.y + mz * g.z;
      mx -= g.x * dn;
      my -= g.y * dn;
      mz -= g.z * dn;
      x += mx * smooth - g.x * dist * 0.8;
      y += my * smooth - g.y * dist * 0.8;
      z += mz * smooth - g.z * dist * 0.8;
      pos[i] = x;
      pos[i + 1] = y;
      pos[i + 2] = z;
    }
  }
  for (let i = 0; i < count; i++) {
    const c = canon[i];
    if (c !== i) pos.set(pos.subarray(c * 3, c * 3 + 3), i * 3);
  }
  return pos;
}

// Bilinear lookup by direction into the wrap grid; the baker's wrapPos does the same on the GPU
function makeWrapLookup(pos, N) {
  const stride = N + 1;
  return (dir, out) => {
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    let f, u, v;
    if (ax >= ay && ax >= az) {
      f = dir.x > 0 ? 0 : 1;
      const m = 1 / ax;
      u = dir.x > 0 ? -dir.z * m : dir.z * m;
      v = dir.y * m;
    } else if (ay >= az) {
      f = dir.y > 0 ? 2 : 3;
      const m = 1 / ay;
      u = dir.x * m;
      v = dir.y > 0 ? -dir.z * m : dir.z * m;
    } else {
      f = dir.z > 0 ? 4 : 5;
      const m = 1 / az;
      u = dir.z > 0 ? dir.x * m : -dir.x * m;
      v = dir.y * m;
    }
    const gx = Math.min(N - 1e-4, Math.max(0, (u * 0.5 + 0.5) * N));
    const gy = Math.min(N - 1e-4, Math.max(0, (v * 0.5 + 0.5) * N));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const base = f * stride * stride;
    const i00 = (base + y0 * stride + x0) * 3, i10 = i00 + 3, i01 = i00 + stride * 3, i11 = i01 + 3;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    return out.set(
      pos[i00] * w00 + pos[i10] * w10 + pos[i01] * w01 + pos[i11] * w11,
      pos[i00 + 1] * w00 + pos[i10 + 1] * w10 + pos[i01 + 1] * w01 + pos[i11 + 1] * w11,
      pos[i00 + 2] * w00 + pos[i10 + 2] * w10 + pos[i01 + 2] * w01 + pos[i11 + 2] * w11,
    );
  };
}

function makeGenus0Evaluator(shape, radius, seed) {
  if (shape === "Suzanne") {
    const wrap = buildSuzanneWrap();
    return (dir, out) => wrap(dir, out).multiplyScalar(radius);
  }
  if (shape === "Sphere") {
    return (dir, out) => out.copy(dir).multiplyScalar(radius);
  }

  if (shape === "Rounded Cube") {
    const p = 4.6;
    const scale = radius * 0.88;
    return (dir, out) => {
      const lp = Math.pow(
        Math.pow(Math.abs(dir.x), p) + Math.pow(Math.abs(dir.y), p) + Math.pow(Math.abs(dir.z), p),
        1 / p,
      );
      return out.copy(dir).multiplyScalar(scale / Math.max(lp, 1e-5));
    };
  }

  if (shape === "Crystal") {
    // Hexagonal prism with pyramidal caps
    const planes = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.25;
      planes.push({ n: new V3(Math.cos(a), 0, Math.sin(a)), d: 0.78 });
      planes.push({ n: new V3(Math.cos(a) * 0.68, 0.73, Math.sin(a) * 0.68).normalize(), d: 0.88 });
      planes.push({ n: new V3(Math.cos(a) * 0.68, -0.73, Math.sin(a) * 0.68).normalize(), d: 0.88 });
    }
    const sMax = smoothMaxPlanes(planes, 14);
    return (dir, out) => out.copy(dir).multiplyScalar((radius * 1.12) / Math.max(sMax(dir), 0.25));
  }

  if (shape === "Meteorite") {
    // Lumpy body scooped by thumbprint dents (regmaglypts), all from the seed
    const rng = seededRandom(`meteorite:${seed}`);
    const noise = makeValueNoise(rng);
    const stretch = new V3(0.85 + rng() * 0.3, 0.8 + rng() * 0.25, 0.85 + rng() * 0.3);
    const dents = Array.from({ length: 34 }, () => {
      const u = rng() * 2 - 1;
      const t = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      return { d: new V3(s * Math.cos(t), u, s * Math.sin(t)), size: 0.16 + rng() * 0.22, depth: 0.05 + rng() * 0.08 };
    });
    return (dir, out) => {
      let r = 1 + 0.16 * noise(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6) + 0.06 * noise(dir.x * 4.1 + 7, dir.y * 4.1, dir.z * 4.1);
      for (const { d, size, depth } of dents) {
        const t = Math.acos(Math.min(1, Math.max(-1, dir.dot(d)))) / size;
        if (t < 1) r -= depth * (1 - t * t) * (1 - t * t);
      }
      return out.set(dir.x * stretch.x, dir.y * stretch.y, dir.z * stretch.z).multiplyScalar(radius * r);
    };
  }

  if (shape === "Dodecahedron" || shape === "Icosahedron" || shape === "Star") {
    // Face normals: a dodecahedron's are the icosahedron's vertices and vice versa; the star is two
    // interpenetrating tetrahedra, smoothly unioned
    const phi = (1 + Math.sqrt(5)) / 2;
    const icoVerts = [];
    for (const a of [-1, 1]) for (const b of [-phi, phi]) icoVerts.push(new V3(0, a, b), new V3(a, b, 0), new V3(b, 0, a));
    const dodVerts = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) dodVerts.push(new V3(a, b, c));
    for (const a of [-1 / phi, 1 / phi]) for (const b of [-phi, phi]) dodVerts.push(new V3(0, a, b), new V3(a, b, 0), new V3(b, 0, a));
    if (shape !== "Star") {
      const normals = shape === "Dodecahedron" ? icoVerts : dodVerts;
      const sMax = smoothMaxPlanes(normals.map((v) => ({ n: v.normalize(), d: 1 })), 70);
      return (dir, out) => out.copy(dir).multiplyScalar(radius * 0.82 / Math.max(sMax(dir), 0.2));
    }
    // Spiky ball: a rounded body with a tapered spike toward each of the 12 icosahedron vertices
    const tips = icoVerts.map((v) => v.normalize());
    return (dir, out) => {
      let r = 0.62;
      for (const t of tips) {
        const c = dir.dot(t);
        if (c > 0.6) r += 0.62 * Math.pow((c - 0.6) / 0.4, 3.2);
      }
      return out.copy(dir).multiplyScalar(radius * r);
    };
  }

  // Boulder: per-seed set of cutting planes, smoothly unioned
  const rng = seededRandom(`boulder:${seed}`);
  const planes = [];
  for (let i = 0; i < 10; i++) {
    const theta = rng() * Math.PI * 2;
    const u = rng() * 2 - 1;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    planes.push({ n: new V3(s * Math.cos(theta), u, s * Math.sin(theta)).normalize(), d: 0.84 + rng() * 0.26 });
  }
  const ax = 0.88 + rng() * 0.28;
  const ay = 0.82 + rng() * 0.28;
  const az = 0.88 + rng() * 0.28;
  const sMax = smoothMaxPlanes(planes, 7.5);
  return (dir, out) => {
    const r = (radius * 1.04) / Math.max(sMax(dir), 0.35);
    return out.set(dir.x * r * ax, dir.y * r * ay, dir.z * r * az);
  };
}

// Bilinear lookup of the baked height (R of the mesh info readback, 0..1 over the atlas)
function makeHeightSampler({ data, width, height }, wrap) {
  const at = (i, j) => {
    if (wrap) {
      i = ((i % width) + width) % width;
      j = ((j % height) + height) % height;
    } else {
      i = Math.max(0, Math.min(width - 1, i));
      j = Math.max(0, Math.min(height - 1, j));
    }
    return data[(j * width + i) * 4] / 255;
  };
  return (u, v) => {
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
}

// Adaptive 2:1-balanced quadtree over a patch of cellsU x cellsV root cells. A cell splits while
// error(u0, v0, du, dv) (world units the flat cell misses the displaced surface by) exceeds tol.
// The patch border stays at a fixed depth so neighbouring patches (cube faces, wrapped seams)
// share their edge vertices. vertex(u, v) appends a vertex and returns its index.
// With countOnly it stops after planning and returns the leaf count.
function buildPatch({ cellsU, cellsV, levels, minDepth, borderDepth, tol, error, vertex, texelsPerGrid, countOnly }, out) {
  const root = 1 << levels;
  const GW = cellsU * root;
  const GH = cellsV * root;
  const band = 2 << (levels - borderDepth);
  const leaves = [];
  const leafMap = new Uint8Array(GW * GH);

  function subdivide(gx, gy, depth) {
    const span = 1 << (levels - depth);
    const onBorder = gx === 0 || gy === 0 || gx + span === GW || gy + span === GH;
    // The ring inside the border is capped one deeper so 2:1 balancing never splits a border cell
    const near = gx < band || gy < band || gx + span > GW - band || gy + span > GH - band;
    const limit = onBorder ? borderDepth : near ? Math.min(levels, borderDepth + 1) : levels;
    let split = depth < minDepth || (onBorder && depth < borderDepth);
    if (!split && depth < limit) split = error(gx / GW, gy / GH, span / GW, span / GH, span * texelsPerGrid, depth) > tol;
    if (split) {
      const half = span >> 1;
      subdivide(gx, gy, depth + 1);
      subdivide(gx + half, gy, depth + 1);
      subdivide(gx, gy + half, depth + 1);
      subdivide(gx + half, gy + half, depth + 1);
      return;
    }
    leaves.push({ gx, gy, span, depth });
    for (let y = gy; y < gy + span; y++) leafMap.fill(depth, y * GW + gx, y * GW + gx + span);
  }

  for (let ry = 0; ry < cellsV; ry++) for (let rx = 0; rx < cellsU; rx++) subdivide(rx * root, ry * root, 0);

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (let i = leaves.length - 1; i >= 0; i--) {
      const { gx, gy, span, depth } = leaves[i];
      if (depth >= levels) continue;
      const stride = Math.max(1, span >> 2);
      let maxNb = depth;
      if (gx > 0) for (let y = gy; y < gy + span; y += stride) maxNb = Math.max(maxNb, leafMap[y * GW + gx - 1]);
      if (gx + span < GW) for (let y = gy; y < gy + span; y += stride) maxNb = Math.max(maxNb, leafMap[y * GW + gx + span]);
      if (gy > 0) for (let x = gx; x < gx + span; x += stride) maxNb = Math.max(maxNb, leafMap[(gy - 1) * GW + x]);
      if (gy + span < GH) for (let x = gx; x < gx + span; x += stride) maxNb = Math.max(maxNb, leafMap[(gy + span) * GW + x]);
      if (maxNb > depth + 1) {
        const half = span >> 1;
        const nd = depth + 1;
        leaves.splice(i, 1,
          { gx, gy, span: half, depth: nd },
          { gx: gx + half, gy, span: half, depth: nd },
          { gx, gy: gy + half, span: half, depth: nd },
          { gx: gx + half, gy: gy + half, span: half, depth: nd },
        );
        for (let y = gy; y < gy + span; y++) leafMap.fill(nd, y * GW + gx, y * GW + gx + span);
        changed = true;
      }
    }
  }

  if (countOnly) return leaves.length;

  const cache = new Map();
  const getVert = (gx, gy, span) => {
    const key = gy * (GW + 1) + gx;
    let id = cache.get(key);
    if (id === undefined) {
      id = vertex(gx / GW, gy / GH);
      cache.set(key, id);
      out.cellTexels[id] = Infinity;
    }
    out.cellTexels[id] = Math.min(out.cellTexels[id], span * texelsPerGrid);
    return id;
  };

  for (const { gx, gy, span, depth } of leaves) {
    const half = span >> 1;
    const splitL = gx > 0 && leafMap[(gy + half) * GW + gx - 1] > depth;
    const splitR = gx + span < GW && leafMap[(gy + half) * GW + gx + span] > depth;
    const splitB = gy > 0 && leafMap[(gy - 1) * GW + gx + half] > depth;
    const splitT = gy + span < GH && leafMap[(gy + span) * GW + gx + half] > depth;
    const bl = getVert(gx, gy, span);
    const br = getVert(gx + span, gy, span);
    const tr = getVert(gx + span, gy + span, span);
    const tl = getVert(gx, gy + span, span);
    if (!splitL && !splitR && !splitB && !splitT) {
      out.indices.push(bl, br, tr, bl, tr, tl);
      continue;
    }
    const ctr = getVert(gx + half, gy + half, span);
    const ring = [bl];
    if (splitB) ring.push(getVert(gx + half, gy, span));
    ring.push(br);
    if (splitR) ring.push(getVert(gx + span, gy + half, span));
    ring.push(tr);
    if (splitT) ring.push(getVert(gx + half, gy + span, span));
    ring.push(tl);
    if (splitL) ring.push(getVert(gx, gy + half, span));
    for (let k = 0; k < ring.length; k++) out.indices.push(ctr, ring[k], ring[(k + 1) % ring.length]);
  }
  return leaves.length;
}

function newMeshArrays() {
  return { positions: [], normals: [], uvs: [], tangents: [], tileBounds: [], indices: [], cellTexels: [] };
}

// Displacement error of a flat cell: how far the height inside strays from the corners' bilinear
// blend, in world units, sampled on a grid that scales with the cell's size in texels
function displacementError(heightAt, toAtlas, u0, v0, du, dv, cellTexels, dispAmp) {
  const k = Math.max(3, Math.min(8, Math.round(cellTexels / 6)));
  const [a0, b0] = toAtlas(u0, v0);
  const [a1, b1] = toAtlas(u0 + du, v0);
  const [a2, b2] = toAtlas(u0, v0 + dv);
  const [a3, b3] = toAtlas(u0 + du, v0 + dv);
  const h00 = heightAt(a0, b0), h10 = heightAt(a1, b1), h01 = heightAt(a2, b2), h11 = heightAt(a3, b3);
  let dev = 0;
  for (let j = 1; j < k; j++) {
    const fy = j / k;
    for (let i = 1; i < k; i++) {
      const fx = i / k;
      const [au, av] = toAtlas(u0 + du * fx, v0 + dv * fy);
      const blend = (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
      dev = Math.max(dev, Math.abs(heightAt(au, av) - blend));
    }
  }
  return dev * dispAmp;
}

// The base shape's sag across a cell: distance from its centre to the mean of its corners
function shapeError(pos, u0, v0, du, dv, tmp) {
  const [c, p0, p1, p2, p3] = tmp;
  pos(u0 + du / 2, v0 + dv / 2, c);
  pos(u0, v0, p0);
  pos(u0 + du, v0, p1);
  pos(u0, v0 + dv, p2);
  pos(u0 + du, v0 + dv, p3);
  return Math.hypot(
    c.x - (p0.x + p1.x + p2.x + p3.x) / 4,
    c.y - (p0.y + p1.y + p2.y + p3.y) / 4,
    c.z - (p0.z + p1.z + p2.z + p3.z) / 4,
  );
}

const MIN_DEPTH = 4;
// Below this depth the base shapes are smooth enough that only displacement needs refining
const SHAPE_ERROR_DEPTH = 7;

function buildGenus0(radius, info, opts, shape, seed) {
  const { pad, levels, tol, dispAmp, faceTexels } = opts;
  const heightAt = makeHeightSampler(info, false);
  const inner = 1 - 2 * pad;
  const evalShape = makeGenus0Evaluator(shape, radius, seed);
  const out = newMeshArrays();

  const d0 = new V3(), duL = new V3(), duR = new V3(), dvB = new V3(), dvT = new V3();
  const p0 = new V3(), puL = new V3(), puR = new V3(), pvB = new V3(), pvT = new V3();
  const c0 = new V3();
  const N = new V3(), T = new V3(), B = new V3(), cross = new V3();
  const tmp = [new V3(), new V3(), new V3(), new V3(), new V3()];
  const dirTmp = new V3();
  const eps = 2e-3;

  let leaves = 0;
  for (let face = 0; face < 6; face++) {
    const col = face % 3;
    const row = Math.floor(face / 3);
    const bounds = [(col + pad * 0.25) / 3, (row + pad * 0.25) / 2, (col + 1 - pad * 0.25) / 3, (row + 1 - pad * 0.25) / 2];
    const toAtlas = (u, v) => [(col + pad + u * inner) / 3, (row + pad + v * inner) / 2];
    const evalAt = (u, v, dir, pos) => {
      faceUVToCube(face, u, v, c0);
      cubeToSphere(c0.x, c0.y, c0.z, dir);
      return evalShape(dir, pos);
    };
    const pos = (u, v, outPos) => evalAt(u, v, dirTmp, outPos);

    leaves += buildPatch({
      cellsU: 1,
      cellsV: 1,
      levels,
      minDepth: MIN_DEPTH,
      borderDepth: Math.max(MIN_DEPTH, levels - 2),
      tol,
      texelsPerGrid: faceTexels / (1 << levels),
      countOnly: opts.countOnly,
      error: (u0, v0, du, dv, cellTexels, depth) =>
        Math.max(
          displacementError(heightAt, toAtlas, u0, v0, du, dv, cellTexels, dispAmp),
          depth < SHAPE_ERROR_DEPTH ? shapeError(pos, u0, v0, du, dv, tmp) : 0,
        ),
      vertex: (u, v) => {
        evalAt(u, v, d0, p0);
        // Centred differences so normals match across cube-face seams
        evalAt(u - eps, v, duL, puL);
        evalAt(u + eps, v, duR, puR);
        evalAt(u, v - eps, dvB, pvB);
        evalAt(u, v + eps, dvT, pvT);
        T.subVectors(puR, puL);
        B.subVectors(pvT, pvB);
        N.crossVectors(T, B).normalize();
        if (N.dot(d0) < 0) N.negate();
        T.addScaledVector(N, -T.dot(N)).normalize();
        B.addScaledVector(N, -B.dot(N)).normalize();
        cross.crossVectors(N, T);
        const w = cross.dot(B) >= 0 ? 1 : -1;
        const id = out.positions.length / 3;
        out.positions.push(p0.x, p0.y, p0.z);
        out.normals.push(N.x, N.y, N.z);
        out.uvs.push(...toAtlas(u, v));
        out.tangents.push(T.x, T.y, T.z, w);
        out.tileBounds.push(...bounds);
        return id;
      },
    }, out);
  }
  out.evalShape = evalShape;
  out.radius = radius;
  out.leaves = leaves;
  return out;
}

// Periodic shapes (Torus, Trefoil Knot); must match the parametrisation in baker.js
function evalTrefoilCenter(t, out) {
  const c3 = Math.cos(3 * t);
  return out.set((2 + c3) * Math.cos(2 * t), (2 + c3) * Math.sin(2 * t), Math.sin(3 * t)).multiplyScalar(0.46);
}

const TORUS_R = 0.98;
const TORUS_r = 0.44;
const KNOT_TUBE = 0.3;

const RING_R = 0.95;
const RING_r = 0.42;

// Twisted ring: a torus whose rounded-triangle section turns once per loop, so both seams close exactly
function twistedRingPos(u, v, out) {
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI * 2;
  const rho = RING_r * (1 + 0.22 * Math.cos(3 * (theta - phi)));
  const radial = RING_R + rho * Math.cos(theta);
  return out.set(radial * Math.cos(phi), radial * Math.sin(phi), rho * Math.sin(theta));
}

const TUBE_POSITION = { "Twisted Ring": twistedRingPos };

function evalPeriodicPoint(shape, u, v, outPos, outN, outT, outB) {
  const tube = TUBE_POSITION[shape];
  if (tube) {
    // Frame from finite differences
    const e = 1e-4;
    tube(u, v, outPos);
    const a = tube(u + e, v, new V3()), b = tube(u - e, v, new V3());
    const c = tube(u, v + e, new V3()), d = tube(u, v - e, new V3());
    outT.subVectors(a, b);
    outB.subVectors(c, d);
    outN.crossVectors(outT, outB);
    if (outN.lengthSq() < 1e-14) outN.copy(outT).multiplyScalar(u > 0.5 ? 1 : -1);
    outN.normalize();
    outT.normalize();
    if (outB.lengthSq() < 1e-14) outB.crossVectors(outN, outT);
    outB.normalize();
    return;
  }

  const phi = u * Math.PI * 2;
  const theta = v * Math.PI * 2;

  if (shape === "Torus") {
    const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
    outPos.set((TORUS_R + TORUS_r * ct) * cp, (TORUS_R + TORUS_r * ct) * sp, TORUS_r * st);
    outN.set(ct * cp, ct * sp, st).normalize();
    outT.set(-sp, cp, 0).normalize();
    outB.set(-st * cp, -st * sp, ct).normalize();
    return;
  }

  // theta is negated so the winding faces outwards like the torus
  const eps = 1e-4;
  const c = evalTrefoilCenter(phi, new V3());
  const cNext = evalTrefoilCenter(phi + eps, new V3());
  const cPrev = evalTrefoilCenter(phi - eps, new V3());
  const tan = new V3().subVectors(cNext, cPrev).normalize();
  const rad = new V3().copy(c).normalize();
  const binorm = new V3().crossVectors(tan, rad).normalize();
  const norm = new V3().crossVectors(binorm, tan).normalize();

  const ct = Math.cos(-theta);
  const st = Math.sin(-theta);
  outN.copy(norm).multiplyScalar(ct).addScaledVector(binorm, st).normalize();
  outPos.copy(c).addScaledVector(outN, KNOT_TUBE);
  outT.copy(tan);
  outB.copy(norm).multiplyScalar(st).addScaledVector(binorm, -ct).normalize();
}

// Torus and knot: one patch over the wrapped (u, v) domain; the maps cover it directly
function buildPeriodic(shape, info, opts) {
  const { levels, tol, dispAmp, faceTexels } = opts;
  // Root cells along u, so cells stay roughly square along each tube
  const cellsU = shape === "Trefoil Knot" ? 6 : 3;
  const heightAt = makeHeightSampler(info, true);
  const out = newMeshArrays();
  const pos = new V3(), N = new V3(), T = new V3(), B = new V3(), cross = new V3();
  const scratch = [new V3(), new V3(), new V3()];
  const tmp = [new V3(), new V3(), new V3(), new V3(), new V3()];
  const toAtlas = (u, v) => [u, v];
  const posAt = (u, v, outPos) => {
    evalPeriodicPoint(shape, u, v, outPos, scratch[0], scratch[1], scratch[2]);
    return outPos;
  };
  const vLevels = Math.max(MIN_DEPTH + 1, levels - 1);

  out.leaves = buildPatch({
    cellsU,
    cellsV: 1,
    levels: vLevels,
    minDepth: 3,
    borderDepth: Math.max(3, vLevels - 2),
    tol,
    texelsPerGrid: (faceTexels * 2) / (1 << vLevels),
    countOnly: opts.countOnly,
    error: (u0, v0, du, dv, cellTexels, depth) =>
      Math.max(
        displacementError(heightAt, toAtlas, u0, v0, du, dv, cellTexels, dispAmp),
        depth < SHAPE_ERROR_DEPTH ? shapeError(posAt, u0, v0, du, dv, tmp) : 0,
      ),
    vertex: (u, v) => {
      evalPeriodicPoint(shape, u, v, pos, N, T, B);
      cross.crossVectors(N, T);
      const w = cross.dot(B) >= 0 ? 1 : -1;
      const id = out.positions.length / 3;
      out.positions.push(pos.x, pos.y, pos.z);
      out.normals.push(N.x, N.y, N.z);
      out.uvs.push(u, v);
      out.tangents.push(T.x, T.y, T.z, w);
      // Unclamped bounds: the maps repeat across u and v
      out.tileBounds.push(-4, -4, 5, 5);
      return id;
    },
  }, out);
  return out;
}

// Recentres on the bounding box and scales so the furthest vertex sits at targetRadius
function normalizeToSphere(positions, targetRadius) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  let maxR = 0;
  for (let i = 0; i < positions.length; i += 3) {
    maxR = Math.max(maxR, Math.hypot(positions[i] - cx, positions[i + 1] - cy, positions[i + 2] - cz));
  }
  const s = maxR > 1e-5 ? targetRadius / maxR : 1;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * s;
    positions[i + 1] = (positions[i + 1] - cy) * s;
    positions[i + 2] = (positions[i + 2] - cz) * s;
  }
  return { cx, cy, cz, s };
}

const SDF_SIZE = 64;
const SDF_BOUND = 2.0;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((x & 0x7fffff) >>> 13);
}

// Approximate signed distance to the final surface on a SDF_SIZE^3 grid over [-SDF_BOUND, SDF_BOUND]^3, as half floats
function buildSdf(shape, built, xf) {
  const n = SDF_SIZE;
  const out = new Uint16Array(n * n * n);
  let dist;

  // Point in the shape's own (unscaled) space
  const toShape = (x, y, z, out) => out.set(x / xf.s + xf.cx, y / xf.s + xf.cy, z / xf.s + xf.cz);
  const q = new V3();
  if (shape === "Torus") {
    const R = TORUS_R * xf.s, r = TORUS_r * xf.s;
    dist = (x, y, z) => Math.hypot(Math.hypot(x, y) - R, z) - r;
  } else if (shape === "Twisted Ring") {
    // Distance in the section plane to the twisted rounded triangle (approximate, fine for glow and morphs)
    dist = (x, y, z) => {
      toShape(x, y, z, q);
      const phi = Math.atan2(q.y, q.x);
      const dx = Math.hypot(q.x, q.y) - RING_R;
      const theta = Math.atan2(q.z, dx);
      const rho = RING_r * (1 + 0.22 * Math.cos(3 * (theta - phi)));
      return (Math.hypot(dx, q.z) - rho) * xf.s;
    };
  } else if (shape === "Trefoil Knot") {
    const segs = 160;
    const pts = [];
    const c = new V3();
    for (let i = 0; i < segs; i++) {
      evalTrefoilCenter((i / segs) * Math.PI * 2, c);
      pts.push((c.x - xf.cx) * xf.s, (c.y - xf.cy) * xf.s, (c.z - xf.cz) * xf.s);
    }
    const tube = KNOT_TUBE * xf.s;
    dist = (x, y, z) => {
      let best = Infinity;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % segs;
        const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
        const bx = pts[j * 3] - ax, by = pts[j * 3 + 1] - ay, bz = pts[j * 3 + 2] - az;
        const px = x - ax, py = y - ay, pz = z - az;
        const t = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz)));
        const d = (px - bx * t) ** 2 + (py - by * t) ** 2 + (pz - bz * t) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best) - tube;
    };
  } else if (shape === "Suzanne") {
    // Her own distance field; the mesh is in shape units of radius per field unit
    const field = loadSuzanneField();
    const k = built.radius;
    dist = (x, y, z) => field((x / xf.s + xf.cx) / k, (y / xf.s + xf.cy) / k, (z / xf.s + xf.cz) / k) * k * xf.s;
  } else {
    // Star-shaped: distance along the ray from the centre to the surface
    const dir = new V3(), pos = new V3();
    dist = (x, y, z) => {
      const len = Math.hypot(x, y, z);
      if (len < 1e-5) return -1;
      dir.set(x / len, y / len, z / len);
      built.evalShape(dir, pos);
      const r = Math.hypot(pos.x - xf.cx, pos.y - xf.cy, pos.z - xf.cz) * xf.s;
      return len - r;
    };
  }

  let inside = 0;
  for (let k = 0; k < n; k++) {
    const z = ((k + 0.5) / n * 2 - 1) * SDF_BOUND;
    for (let j = 0; j < n; j++) {
      const y = ((j + 0.5) / n * 2 - 1) * SDF_BOUND;
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n * 2 - 1) * SDF_BOUND;
        const d = dist(x, y, z);
        if (d < 0) inside++;
        out[(k * n + j) * n + i] = toHalf(Math.max(-4, Math.min(4, d)));
      }
    }
  }
  // Radius of the sphere with the same volume
  const volume = inside * ((2 * SDF_BOUND) / n) ** 3;
  return { sdf: out, volumeRadius: Math.cbrt((3 * volume) / (4 * Math.PI)) };
}

const HEAT_SIZE = 48;

// Separable binomial blur of an n^3 grid, in place
function blur3(grid, n, passes) {
  const tmp = new Float32Array(grid.length);
  const w = [1 / 64, 6 / 64, 15 / 64, 20 / 64, 15 / 64, 6 / 64, 1 / 64];
  const strides = [1, n, n * n];
  for (let pass = 0; pass < passes; pass++) {
    for (let axis = 0; axis < 3; axis++) {
      const st = strides[axis];
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const idx = (k * n + j) * n + i;
            const c = axis === 0 ? i : axis === 1 ? j : k;
            let v = 0;
            for (let t = -3; t <= 3; t++) {
              const cc = c + t;
              if (cc >= 0 && cc < n) v += grid[idx + t * st] * w[t + 3];
            }
            tmp[idx] = v;
          }
        }
      }
      grid.set(tmp);
    }
  }
}

// Heat of the surface spread into the air around it: each triangle deposits heat x area, then a near
// and a far blur. Read by the volumetric glow, so lava lights the air even where it faces away.
function buildHeatVolume(positions, uvs, indices, importance, periodic) {
  const n = HEAT_SIZE;
  const grid = new Float32Array(n * n * n);
  const { data, width, height } = importance;
  const heatAt = (u, v) => {
    if (periodic) {
      u -= Math.floor(u);
      v -= Math.floor(v);
    }
    const x = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    return data[(y * width + x) * 4 + 1] / 255;
  };
  const toGrid = (c) => ((c / SDF_BOUND) * 0.5 + 0.5) * n - 0.5;
  const deposit = (x, y, z, w) => {
    const gx = toGrid(x), gy = toGrid(y), gz = toGrid(z);
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    for (let dk = 0; dk < 2; dk++) {
      const k = k0 + dk;
      if (k < 0 || k >= n) continue;
      const wz = dk ? fz : 1 - fz;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= n) continue;
        const wy = dj ? fy : 1 - fy;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di;
          if (i < 0 || i >= n) continue;
          grid[(k * n + j) * n + i] += w * wz * wy * (di ? fx : 1 - fx);
        }
      }
    }
  };

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ua = (indices[t] * 2), ub = (indices[t + 1] * 2), uc = (indices[t + 2] * 2);
    const heat = heatAt((uvs[ua] + uvs[ub] + uvs[uc]) / 3, (uvs[ua + 1] + uvs[ub + 1] + uvs[uc + 1]) / 3);
    if (heat < 0.02) continue;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    deposit(
      (positions[a] + positions[b] + positions[c]) / 3,
      (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
      (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
      heat * area,
    );
  }

  const voxelVolume = ((2 * SDF_BOUND) / n) ** 3;
  for (let i = 0; i < grid.length; i++) grid[i] /= voxelVolume;
  blur3(grid, n, 2);
  const near = grid.slice();
  blur3(grid, n, 6);
  const out = new Uint16Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = toHalf(Math.min(60000, near[i] + grid[i] * 0.12));
  return out;
}

const FLOW_SIZE = 24;

// The lava's flow around each point of the air: heat-weighted mean of the surface's object-space flow direction
// (xyz, from the baked flow map, as the material decodes it) and its phase (w). The glow animates with it.
function buildFlowVolume(positions, normals, tangents, uvs, indices, info, periodic) {
  const n = FLOW_SIZE;
  const sums = [0, 1, 2, 3, 4].map(() => new Float32Array(n * n * n));
  const { data, flow, width, height } = info;
  const texel = (u, v) => {
    if (periodic) {
      u -= Math.floor(u);
      v -= Math.floor(v);
    }
    const x = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    return (y * width + x) * 4;
  };
  const toGrid = (c) => ((c / SDF_BOUND) * 0.5 + 0.5) * n - 0.5;
  const vals = [0, 0, 0, 0, 0];
  const deposit = (x, y, z) => {
    const gx = toGrid(x), gy = toGrid(y), gz = toGrid(z);
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    for (let dk = 0; dk < 2; dk++) {
      const k = k0 + dk;
      if (k < 0 || k >= n) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= n) continue;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di;
          if (i < 0 || i >= n) continue;
          const w = (dk ? fz : 1 - fz) * (dj ? fy : 1 - fy) * (di ? fx : 1 - fx);
          const idx = (k * n + j) * n + i;
          for (let c = 0; c < 5; c++) sums[c][idx] += vals[c] * w;
        }
      }
    }
  };
  for (let v = 0; v < positions.length / 3; v++) {
    const t = texel(uvs[v * 2], uvs[v * 2 + 1]);
    const heat = data[t + 1] / 255;
    if (heat < 0.05) continue;
    const amp = 0.6 + 0.9 * (flow[t + 2] / 255);
    const fu = (flow[t] / 127.5 - 1) * amp, fv = (flow[t + 1] / 127.5 - 1) * amp;
    const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
    const tx = tangents[v * 4], ty = tangents[v * 4 + 1], tz = tangents[v * 4 + 2], tw = tangents[v * 4 + 3];
    const bx = (ny * tz - nz * ty) * tw, by = (nz * tx - nx * tz) * tw, bz = (nx * ty - ny * tx) * tw;
    const w = heat * heat;
    vals[0] = (tx * fu + bx * fv) * w;
    vals[1] = (ty * fu + by * fv) * w;
    vals[2] = (tz * fu + bz * fv) * w;
    vals[3] = (flow[t + 3] / 255) * w;
    vals[4] = w;
    deposit(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  }
  for (const g of sums) blur3(g, n, 2);
  const out = new Uint16Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    const w = sums[4][i];
    const inv = w > 1e-6 ? 1 / w : 0;
    // alpha is the phase; a voxel with no lava nearby gets a negative phase, which the pulse pass reads as "no flow"
    out[i * 4] = toHalf(sums[0][i] * inv);
    out[i * 4 + 1] = toHalf(sums[1][i] * inv);
    out[i * 4 + 2] = toHalf(sums[2][i] * inv);
    out[i * 4 + 3] = toHalf(w > 1e-6 ? sums[3][i] * inv : -1);
  }
  return out;
}

const EMITTER_COUNT = 2048;

// Ember emitters: surface points picked with probability proportional to their baked heat.
// Per point: position, normal, heat (7 floats), in the mesh's object space.
function buildEmitters(positions, normals, uvs, info, periodic, seed) {
  const { data, width, height } = info;
  const heatAt = (u, v) => {
    if (periodic) {
      u -= Math.floor(u);
      v -= Math.floor(v);
    }
    const x = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    return data[(y * width + x) * 4 + 1] / 255;
  };
  const count = positions.length / 3;
  const cumulative = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const h = heatAt(uvs[i * 2], uvs[i * 2 + 1]);
    total += h > 0.2 ? h * h : 0;
    cumulative[i] = total;
  }
  const out = new Float32Array(EMITTER_COUNT * 7);
  if (total <= 0) return out.subarray(0, 0);
  const rng = seededRandom(`emitters:${seed}`);
  for (let e = 0; e < EMITTER_COUNT; e++) {
    const r = rng() * total;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    out.set([positions[lo * 3], positions[lo * 3 + 1], positions[lo * 3 + 2], normals[lo * 3], normals[lo * 3 + 1], normals[lo * 3 + 2], heatAt(uvs[lo * 2], uvs[lo * 2 + 1])], e * 7);
  }
  return out;
}

function isPeriodicShape(shape) {
  return shape === "Torus" || shape === "Trefoil Knot" || shape === "Twisted Ring";
}

// info: the baker's mesh info readback (R height, G heat over the atlas). Builds with the error
// tolerance tol, raising it until the mesh fits in maxTriangles.
function buildMeshData({ radius, info, shape, seed, levels, tol, maxTriangles, dispAmp, pad, faceTexels }) {
  const periodic = isPeriodicShape(shape);
  const build = (countOnly) => {
    const opts = { pad, levels, tol, dispAmp, faceTexels, countOnly };
    return periodic ? buildPeriodic(shape, info, opts) : buildGenus0(radius, info, opts, shape, seed);
  };
  // Plan first; over budget, give up a level of depth (crack walls refine to full depth at any tolerance)
  for (let attempt = 0; attempt < 4 && levels > MIN_DEPTH + 2; attempt++) {
    if (build(true).leaves * 3 <= maxTriangles) break;
    levels--;
    tol *= 1.25;
  }
  const built = build(false);
  const positions = new Float32Array(built.positions);
  const xf = normalizeToSphere(positions, radius);
  const vertexCount = positions.length / 3;
  const heat = buildHeatVolume(positions, built.uvs, built.indices, info, periodic);
  const emitters = buildEmitters(positions, built.normals, built.uvs, info, periodic, seed);
  const flow = info.flow ? buildFlowVolume(positions, built.normals, built.tangents, built.uvs, built.indices, info, periodic) : null;
  return {
    positions,
    normals: new Float32Array(built.normals),
    uvs: new Float32Array(built.uvs),
    tangents: new Float32Array(built.tangents),
    tileBounds: new Float32Array(built.tileBounds),
    cellTexels: new Float32Array(built.cellTexels),
    indices: vertexCount > 65535 ? new Uint32Array(built.indices) : new Uint16Array(built.indices),
    ...buildSdf(shape, built, xf),
    heat,
    emitters,
    flow,
    triangles: built.indices.length / 3,
    tol,
    levels,
  };
}

export { buildMeshData, isPeriodicShape, computeSuzanneWrap, SDF_SIZE, SDF_BOUND, HEAT_SIZE, FLOW_SIZE, WRAP_N };
