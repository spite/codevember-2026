// Solids with real volume: a fat trefoil, Suzanne from a baked distance field, and rounded primitives as analytic
// distance fields, alone or smoothly blended in pairs.

const TAU = Math.PI * 2;
const PHI = (1 + Math.sqrt(5)) / 2;

const range = (rand, a, b) => a + (b - a) * rand();
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

// Polynomial smooth min: a convex blend of the gradients, so 1-Lipschitz.
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Uniform random rotation (rows), from a random unit quaternion.
function randomRotation(rand) {
  const u1 = rand(), u2 = rand() * TAU, u3 = rand() * TAU;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const x = a * Math.sin(u2), y = a * Math.cos(u2), z = b * Math.sin(u3), w = b * Math.cos(u3);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

const rotated = (f, R) => (x, y, z) => f(R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z);

// Divides f by its steepest gradient found over the box, if that is past 1.
function lipschitz(f, extent) {
  const rand = mulberry(7), e = 1e-3;
  let L = 1;
  for (let n = 0; n < 4000; n++) {
    const x = (rand() * 2 - 1) * extent, y = (rand() * 2 - 1) * extent, z = (rand() * 2 - 1) * extent;
    const f0 = f(x, y, z);
    L = Math.max(L, Math.hypot(f(x + e, y, z) - f0, f(x, y + e, z) - f0, f(x, y, z + e) - f0) / e);
  }
  return scaled(f, L);
}

const scaled = (f, L) => (L <= 1 ? f : (x, y, z) => f(x, y, z) / (L * 1.03));

function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Trefoil ────────────────────────────────────────────────────────────────────────────────────────────

// A tube along the (2, 3) torus knot r = 1 + a cos 3t, closest point by sampling then Newton on the exact curve.
function trefoilField(p) {
  const { a, h, tube, swell, phase } = p;
  const M = 120;
  const S = new Float64Array(M * 3);
  const curve = (t, out, d1, d2) => {
    const c2 = Math.cos(2 * t), s2 = Math.sin(2 * t), c3 = Math.cos(3 * t), s3 = Math.sin(3 * t);
    const r = 1 + a * c3, r1 = -3 * a * s3, r2 = -9 * a * c3;
    out[0] = r * c2; out[1] = h * a * s3; out[2] = r * s2;
    if (!d1) return;
    d1[0] = r1 * c2 - 2 * r * s2; d1[1] = 3 * h * a * c3; d1[2] = r1 * s2 + 2 * r * c2;
    d2[0] = r2 * c2 - 4 * r1 * s2 - 4 * r * c2; d2[1] = -9 * h * a * s3; d2[2] = r2 * s2 + 4 * r1 * c2 - 4 * r * s2;
  };
  const C = [0, 0, 0], D1 = [0, 0, 0], D2 = [0, 0, 0];
  for (let i = 0; i < M; i++) {
    curve((TAU * i) / M, C);
    S.set(C, i * 3);
  }
  const radius = (t) => tube * (1 + swell * Math.sin(3 * t + phase));
  const newton = (t, x, y, z) => {
    for (let it = 0; it < 6; it++) {
      curve(t, C, D1, D2);
      const ex = C[0] - x, ey = C[1] - y, ez = C[2] - z;
      const g = ex * D1[0] + ey * D1[1] + ez * D1[2];
      const gp = D1[0] * D1[0] + D1[1] * D1[1] + D1[2] * D1[2] + ex * D2[0] + ey * D2[1] + ez * D2[2];
      let dt = gp > 1e-9 ? -g / gp : 0;
      dt = Math.max(-0.03, Math.min(0.03, dt));
      t += dt;
      if (Math.abs(dt) < 1e-7) break;
    }
    curve(t, C);
    return Math.hypot(x - C[0], y - C[1], z - C[2]) - radius(t);
  };
  const d2 = (i, x, y, z) => {
    const dx = x - S[i * 3], dy = y - S[i * 3 + 1], dz = z - S[i * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  // Samples that can be nearest to any point of a cell of a coarse grid; 0.12 covers the samples' gap to the curve.
  const B = 1.9, G = 20, cs = (2 * B) / G, rc = cs * 0.8661;
  const cand = [];
  const dist = new Float64Array(M), pick16 = new Int16Array(M);
  for (let k = 0; k < G; k++)
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const x = -B + (i + 0.5) * cs, y = -B + (j + 0.5) * cs, z = -B + (k + 0.5) * cs;
        let dmin = Infinity;
        for (let s = 0; s < M; s++) { dist[s] = Math.sqrt(d2(s, x, y, z)); if (dist[s] < dmin) dmin = dist[s]; }
        const lim = dmin + 2 * rc + 0.12;
        let n = 0;
        for (let s = 0; s < M; s++) if (dist[s] <= lim) pick16[n++] = s;
        cand.push(pick16.slice(0, n));
      }
  const all = Int16Array.from({ length: M }, (_, s) => s);
  // Newton from the nearest sample of each run of consecutive candidates (one per pass of the curve).
  return (x, y, z) => {
    const i = Math.floor((x + B) / cs), j = Math.floor((y + B) / cs), k = Math.floor((z + B) / cs);
    const list = i < 0 || j < 0 || k < 0 || i >= G || j >= G || k >= G ? all : cand[i + G * (j + G * k)];
    let best = Infinity;
    for (let n = 0; n < list.length; n++) best = Math.min(best, d2(list[n], x, y, z));
    const cut = (Math.sqrt(best) + 0.12) ** 2;
    let d = Infinity, runBest = Infinity, runAt = -1;
    for (let n = 0; n <= list.length; n++) {
      if (n === list.length || (n > 0 && list[n] !== list[n - 1] + 1)) {
        if (runBest <= cut) d = Math.min(d, newton((TAU * runAt) / M, x, y, z));
        runBest = Infinity;
        if (n === list.length) break;
      }
      const v = d2(list[n], x, y, z);
      if (v < runBest) { runBest = v; runAt = list[n]; }
    }
    return d;
  };
}

// ── Suzanne ────────────────────────────────────────────────────────────────────────────────────────────

// 7_v2/tools/suzanne-sdf.mjs: N³ half floats at cell centres over [-EXTENT, EXTENT]³, x fastest.
const SUZ_N = 96, SUZ_EXTENT = 1.12;
let suzanneRaw = null;

function halfToFloat(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 31, m = u & 1023;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return s * 1e3;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// Synchronous, since build() is: an XHR in the mesher worker, the file system in node.
function loadSuzanne() {
  if (suzanneRaw) return suzanneRaw;
  const url = new URL("../suzanne.bin", import.meta.url);
  let buffer;
  if (typeof XMLHttpRequest !== "undefined") {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url.href, false);
    xhr.responseType = "arraybuffer";
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) throw new Error(`suzanne.bin: ${xhr.status}`);
    buffer = xhr.response;
  } else {
    const fs = globalThis.process.getBuiltinModule("node:fs");
    const b = fs.readFileSync(url);
    buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const h = new Uint16Array(buffer);
  suzanneRaw = Float32Array.from(h, halfToFloat);
  return suzanneRaw;
}

// Running max over a window of 2r + 1 along one axis.
function maxFilter(A, N, stride, r) {
  const out = new Float32Array(A.length);
  for (let idx = 0; idx < A.length; idx++) {
    const g = Math.floor(idx / stride) % N;
    let m = -Infinity;
    for (let d = Math.max(-r, -g); d <= Math.min(r, N - 1 - g); d++) m = Math.max(m, A[idx + d * stride]);
    out[idx] = m;
  }
  return out;
}

function blur(A, N, sigma) {
  const R = Math.ceil(sigma * 3), kern = [];
  for (let x = -R; x <= R; x++) kern.push(Math.exp(-(x * x) / (2 * sigma * sigma)));
  let a = Float32Array.from(A), b = new Float32Array(A.length);
  for (const stride of [1, N, N * N]) {
    for (let idx = 0; idx < a.length; idx++) {
      const g = Math.floor(idx / stride) % N;
      let sum = 0, ws = 0;
      for (let x = Math.max(-R, -g); x <= Math.min(R, N - 1 - g); x++) {
        sum += a[idx + x * stride] * kern[x + R];
        ws += kern[x + R];
      }
      b[idx] = sum / ws;
    }
    [a, b] = [b, a];
  }
  return a;
}

// The head with every part thinner than 2·minHalf (ears, brow) grown to it, and dilated by `puff`. Local half
// thickness is the deepest point within 0.1 of a voxel.
let suzanneDepth = null;
function suzanneGrid(minHalf, puff) {
  const F = loadSuzanne(), N = SUZ_N, vox = (2 * SUZ_EXTENT) / N;
  // The local half thickness doesn't depend on the sliders: worked out once.
  if (!suzanneDepth) {
    const D = F.map((v) => Math.max(-v, 0));
    const r = Math.round(0.1 / vox);
    suzanneDepth = maxFilter(maxFilter(maxFilter(D, N, 1, r), N, N, r), N, N * N, r);
  }
  const M = suzanneDepth;
  const O = blur(M.map((m) => Math.max(0, minHalf - m)), N, 1.5);
  return F.map((v, i) => v - O[i] - puff);
}

// Cubic B-spline over the grid (C², so the projected surface is fair), plus the distance past its box.
function gridField(G, N, extent) {
  const inv = N / (2 * extent);
  const wx = [0, 0, 0, 0], wy = [0, 0, 0, 0], wz = [0, 0, 0, 0];
  const weights = (t, w) => {
    const t2 = t * t, t3 = t2 * t, u = 1 - t;
    w[0] = (u * u * u) / 6;
    w[1] = (3 * t3 - 6 * t2 + 4) / 6;
    w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
    w[3] = t3 / 6;
  };
  const lim = extent * (1 - 1.5 / N);
  return (x, y, z) => {
    const cx = Math.max(-lim, Math.min(lim, x)), cy = Math.max(-lim, Math.min(lim, y)), cz = Math.max(-lim, Math.min(lim, z));
    const out = Math.hypot(x - cx, y - cy, z - cz);
    const gx = (cx + extent) * inv - 0.5, gy = (cy + extent) * inv - 0.5, gz = (cz + extent) * inv - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    weights(gx - ix, wx); weights(gy - iy, wy); weights(gz - iz, wz);
    let sum = 0;
    for (let c = 0; c < 4; c++) {
      const k = Math.min(N - 1, Math.max(0, iz - 1 + c));
      let sy = 0;
      for (let b = 0; b < 4; b++) {
        const j = Math.min(N - 1, Math.max(0, iy - 1 + b)), o = N * (j + N * k);
        const i0 = Math.max(0, ix - 1), i1 = ix, i2 = Math.min(N - 1, ix + 1), i3 = Math.min(N - 1, ix + 2);
        sy += wy[b] * (wx[0] * G[o + i0] + wx[1] * G[o + i1] + wx[2] * G[o + i2] + wx[3] * G[o + i3]);
      }
      sum += wz[c] * sy;
    }
    return sum + out;
  };
}

function suzanneField(p) {
  const G = suzanneGrid(p.minHalf, p.puff), N = SUZ_N, vox = (2 * SUZ_EXTENT) / N;
  // The spline's gradient is a blend of the grid's differences, so the steepest of those about bounds it.
  let L = 0;
  for (let k = 0; k < N - 1; k++)
    for (let j = 0; j < N - 1; j++)
      for (let i = 0, o = N * (j + N * k); i < N - 1; i++, o++) {
        const g = G[o];
        L = Math.max(L, Math.hypot(G[o + 1] - g, G[o + N] - g, G[o + N * N] - g));
      }
  return scaled(gridField(G, N, SUZ_EXTENT), L / vox);
}

// ── Primitives (about unit size) ───────────────────────────────────────────────────────────────────────

const sphere = (r) => (x, y, z) => Math.hypot(x, y, z) - r;

// Ellipsoid scaled to its smallest radius (1-Lipschitz without taper); `taper` widens it towards +y like an egg.
function ellipsoid(rx, ry, rz, taper = 0) {
  const m = Math.min(rx, ry, rz);
  return (x, y, z) => {
    const w = 1 + taper * Math.tanh(y / ry);
    return (Math.hypot(x / (rx * w), y / ry, z / (rz * w)) - 1) * m;
  };
}

function torus(R, r) {
  return (x, y, z) => Math.hypot(Math.hypot(x, z) - R, y) - r;
}

function roundBox(b, r) {
  return (x, y, z) => {
    const dx = Math.abs(x) - b + r, dy = Math.abs(y) - b + r, dz = Math.abs(z) - b + r;
    const mx = Math.max(dx, 0), my = Math.max(dy, 0), mz = Math.max(dz, 0);
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(dx, dy, dz), 0) - r;
  };
}

function capsule(half, r) {
  return (x, y, z) => Math.hypot(x, y - Math.max(-half, Math.min(half, y)), z) - r;
}

const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
const cyclic = (list) => list.flatMap(([a, b, c]) => [[a, b, c], [b, c, a], [c, a, b]]);
const signs = (v) => {
  const out = [];
  for (let m = 0; m < 8; m++) {
    const s = v.map((c, i) => (m >> i) & 1 ? -c : c);
    if (!out.some((o) => o.every((c, i) => c === s[i]))) out.push(s);
  }
  return out;
};

// Face normals and circumradius / inradius of the Platonic solids.
const PLATONIC = {
  4: { normals: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(norm), ratio: 3 },
  6: { normals: cyclic([[1, 0, 0], [-1, 0, 0]]), ratio: Math.sqrt(3) },
  8: { normals: signs([1, 1, 1]).map(norm), ratio: Math.sqrt(3) },
  12: { normals: cyclic(signs([0, 1, PHI])).map(norm), ratio: 1.2584 },
  20: { normals: [...signs([1, 1, 1]), ...cyclic(signs([0, 1 / PHI, PHI]))].map(norm), ratio: 1.2584 },
};

// A Platonic solid of circumradius about 1 with its edges and corners rounded: log-sum-exp of the face planes
// (softmax-weighted normals, so 1-Lipschitz).
function platonic(faces, round) {
  const { normals, ratio } = PLATONIC[faces];
  const rho = 1 / ratio, k = round * rho;
  const n = normals.flat(), F = normals.length;
  return (x, y, z) => {
    let m = -Infinity;
    const d = new Array(F);
    for (let i = 0; i < F; i++) {
      d[i] = n[i * 3] * x + n[i * 3 + 1] * y + n[i * 3 + 2] * z - rho;
      if (d[i] > m) m = d[i];
    }
    let s = 0;
    for (let i = 0; i < F; i++) s += Math.exp((d[i] - m) / k);
    return m + k * Math.log(s);
  };
}

// A primitive of a kind, about unit size, from seeded parameters.
const PRIMS = {
  sphere: () => sphere(1),
  egg: (q) => ellipsoid(q.r, 1.4 * q.r, q.r, q.taper),
  pebble: (q) => ellipsoid(1, q.ry, q.rz),
  torus: (q) => torus(0.7, q.tube),
  box: (q) => roundBox(0.62, q.round * 0.62),
  capsule: (q) => capsule(q.half, q.r),
  platonic: (q) => platonic(q.faces, q.round),
};

// Rounding of the edges against the inradius: just enough that the skin's inner wall doesn't crease, so the faces still read.
const platonicRound = (rand, faces) => range(rand, ...{ 4: [0.1, 0.14], 6: [0.08, 0.12], 8: [0.07, 0.1], 12: [0.045, 0.07], 20: [0.04, 0.06] }[faces]);

function randomPrim(rand, kind) {
  switch (kind) {
    case "egg": return { kind, r: 0.72, taper: range(rand, 0.15, 0.25) };
    case "pebble": return { kind, ry: range(rand, 0.55, 0.7), rz: range(rand, 0.75, 0.9) };
    case "torus": return { kind, tube: range(rand, 0.28, 0.4) };
    case "box": return { kind, round: range(rand, 0.18, 0.35) };
    case "capsule": return { kind, half: range(rand, 0.35, 0.55), r: range(rand, 0.4, 0.5) };
    case "platonic": { const faces = pick(rand, [4, 6, 8, 12, 20]); return { kind, faces, round: platonicRound(rand, faces) }; }
    default: return { kind };
  }
}

// Two primitives either side of the centre along a seeded direction, smoothly unioned.
function blendField(p) {
  const at = (q) => {
    const f = rotated(PRIMS[q.kind](q), q.R);
    const s = q.size, [ox, oy, oz] = q.pos;
    return (x, y, z) => f((x - ox) / s, (y - oy) / s, (z - oz) / s) * s;
  };
  const a = at(p.a), b = at(p.b);
  return lipschitz((x, y, z) => smin(a(x, y, z), b(x, y, z), p.k), 1.35);
}

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────────────────

const out = (f, extent = 1.35) => ({ kind: "solid", f, extent, keep: Infinity });

const prim = (id, name, random, field, extra = {}) => ({
  id, name, family: "volumes", kind: "solid", random, ...extra,
  build: (p) => out(p.R ? rotated(field(p), p.R) : field(p)),
});

export const SHAPES = [
  {
    id: "trefoil", name: "Trefoil", family: "volumes", kind: "solid", cells: 1.1,
    random: (rand) => {
      const a = range(rand, 0.42, 0.5);
      return { a, h: range(rand, 1, 1.4), tube: range(rand, 0.28, 0.34), swell: rand() < 0.6 ? range(rand, 0.04, 0.1) : 0, phase: range(rand, 0, TAU) };
    },
    sliders: [
      { key: "width", name: "Knot width", min: 0.3, max: 0.6, value: 0.46, tip: "How far the knot's loops reach out from its centre." },
      { key: "height", name: "Knot height", min: 0.6, max: 1.6, value: 1.2, tip: "How much the knot rises and falls as it winds: low is flat, high is tall." },
      { key: "tube", name: "Tube", min: 0.22, max: 0.4, value: 0.31, tip: "Thickness of the knot's tube." },
      { key: "swell", name: "Swell", min: 0, max: 0.12, value: 0.06, tip: "Gentle bulges along the tube: 0 keeps it even." },
    ],
    fromSliders: (v) => ({ a: v.width, h: v.height, tube: v.tube, swell: v.swell, phase: 0.7 }),
    build: (p) => out(trefoilField(p), 1.9),
  },
  {
    // upright: the rotation (rows) that stands her up facing the camera, used instead of her principal axes. Her field
    // is turned so her eyes sit above her snout and she looks at the default camera, which is a little below her.
    id: "suzanne", name: "Suzanne", family: "volumes", kind: "solid", upright: [1, 0, 0, 0, 0.866, 0.5, 0, -0.5, 0.866],
    random: (rand) => ({ minHalf: range(rand, 0.055, 0.07), puff: range(rand, 0, 0.012) }),
    sliders: [
      { key: "thicken", name: "Thicken", min: 0.04, max: 0.09, value: 0.062, tip: "How much her thin parts (ears, brow) are thickened, so the lattice holds together there." },
      { key: "swell", name: "Swell", min: 0, max: 0.02, value: 0.006, tip: "Swells her whole head slightly." },
    ],
    fromSliders: (v) => ({ minHalf: v.thicken, puff: v.swell }),
    build: (p) => out(suzanneField(p), 1.1),
  },
  prim("sphere", "Sphere", () => ({}), () => sphere(1), { sliders: [], fromSliders: () => ({}) }),
  prim("egg", "Egg", (rand) => randomPrim(rand, "egg"), (p) => lipschitz(PRIMS.egg(p), 1.35), {
    sliders: [{ key: "taper", name: "Taper", min: 0, max: 0.35, value: 0.2, tip: "How much narrower the top is than the bottom: 0 is an ellipsoid." }],
    fromSliders: (v) => ({ kind: "egg", r: 0.72, taper: v.taper }),
  }),
  prim("torus", "Torus", (rand) => randomPrim(rand, "torus"), PRIMS.torus, {
    sliders: [{ key: "tube", name: "Tube", min: 0.2, max: 0.45, value: 0.34, tip: "Thickness of the ring's tube, against the size of the ring." }],
    fromSliders: (v) => ({ tube: v.tube }),
  }),
  prim("rounded-cube", "Rounded cube", (rand) => randomPrim(rand, "box"), PRIMS.box, {
    sliders: [{ key: "round", name: "Edges", min: 0.08, max: 0.45, value: 0.26, tip: "How rounded the cube's edges and corners are." }],
    fromSliders: (v) => ({ round: v.round }),
  }),
  ...[[4, "tetrahedron", "Tetrahedron", 0.12], [8, "octahedron-solid", "Octahedron", 0.085], [12, "dodecahedron", "Dodecahedron", 0.058], [20, "icosahedron", "Icosahedron", 0.05]].map(([faces, id, name, round]) =>
    prim(id, name, (rand) => ({ kind: "platonic", faces, round: platonicRound(rand, faces) }), PRIMS.platonic, {
      sliders: [{ key: "round", name: "Edges", min: round * 0.6, max: round * 2.5, value: round, tip: "How rounded the edges and corners are." }],
      fromSliders: (v) => ({ kind: "platonic", faces, round: v.round }),
    })),
  prim("capsule", "Capsule", (rand) => randomPrim(rand, "capsule"), PRIMS.capsule, {
    sliders: [
      { key: "length", name: "Length", min: 0.15, max: 0.7, value: 0.45, tip: "Length of the capsule's straight middle." },
      { key: "radius", name: "Radius", min: 0.3, max: 0.55, value: 0.45, tip: "Thickness of the capsule." },
    ],
    fromSliders: (v) => ({ half: v.length, r: v.radius }),
  }),
  prim("blend", "Blend",
    (rand) => {
      const kinds = ["sphere", "egg", "torus", "box", "capsule", "platonic"];
      const ka = pick(rand, kinds);
      const kb = pick(rand, kinds.filter((k) => k !== ka));
      const dir = norm([range(rand, -1, 1), range(rand, -0.6, 0.6), range(rand, -1, 1)]);
      const o = range(rand, 0.32, 0.45);
      const part = (kind, s) => ({ ...randomPrim(rand, kind), R: randomRotation(rand), size: range(rand, 0.55, 0.7), pos: dir.map((c) => c * o * s) });
      return { a: part(ka, -1), b: part(kb, 1), k: range(rand, 0.2, 0.35) };
    },
    blendField, {
      sliders: [{ key: "variant", name: "Variant", min: 0, max: 99, step: 1, value: 0, tip: "Which two solids are joined, their sizes and how they meet: each number is a different pair." }],
      fromSliders: null,
    }),
];
