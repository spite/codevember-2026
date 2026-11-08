// A line sketch of the sculpture while its Shape settings change: the outline of every hole it will open, traced on a
// coarse mesh of its surface, plus a dot per cell. The mesh is made once per shape; cells, variation, roundness
// and strut only move it and re-trace the outlines, so it follows a slider live. Cells, their spacing noise and the
// rounded border distance follow the mesher (hollow.js), simplified: no curvature or thickness terms.
import { shapeById, shapeConfig, mulberry32 } from "./shapes/index.js";
import { vnoise, principalAxes } from "./hollow.js";
import { implicitMesh, adjacency } from "./surface.js";

// The coarse mesh (while a shape slider moves) and the fine one, kept apart so neither evicts the other.
const caches = { true: null, false: null };

// A coarse mesh of the surface, in the shape's frame scaled to a reach of 0.95 like the mesher's.
function base(desc, coarse) {
  const def = shapeById(desc.shape);
  const shape = def.build(shapeConfig(desc.shape, desc.values, desc.form), { h: desc.h });
  const { f, extent } = shape;
  const C = 24, ch = (2 * extent) / C;
  let reach = 0;
  for (let k = 0; k <= C; k++)
    for (let j = 0; j <= C; j++)
      for (let i = 0; i <= C; i++) {
        const x = -extent + i * ch, y = -extent + j * ch, z = -extent + k * ch;
        if (f(x, y, z) < 0) reach = Math.max(reach, Math.hypot(x, y, z));
      }
  reach = Math.max(reach + ch, 0.2);
  const scale = reach / 0.95;
  const B = Math.min(extent, reach + 0.1 * scale);
  // Coarser still while a shape slider is being dragged, so the shape keeps up with it.
  const m = implicitMesh(f, [-B, -B, -B], [B, B, B], (coarse ? 0.06 : 0.034) * scale, { relax: 1 });
  const n = m.P.length / 3;
  return { key: `${desc.shape}:${desc.form}:${coarse}`, P: m.P, N: m.N, T: m.T, n, adj: adjacency(m.T, n), cells: def.cells ?? 1, upright: def.upright };
}

// The surface turned to its principal axes and scaled to desc.size, like the finished sculpture.
function place(c, desc) {
  const { P: U, n } = c;
  let ext = 0;
  for (let i = 0; i < U.length; i += 3) ext = Math.max(ext, Math.hypot(U[i], U[i + 1], U[i + 2]));
  // The same axes as the mesher's, weighted by area, so the sketch and the sculpture face the same way.
  // The sculpture's own frame when it is the same shape, else the same axes as the mesher's, weighted by area.
  const R = desc.frame?.R ?? c.upright ?? principalAxes(U, c.T), K = desc.frame?.F ?? desc.size / ext;
  const W = new Float64Array(n * 3), N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = U[i * 3], y = U[i * 3 + 1], z = U[i * 3 + 2];
    W[i * 3] = (R[0] * x + R[1] * y + R[2] * z) * K;
    W[i * 3 + 1] = (R[3] * x + R[4] * y + R[5] * z) * K;
    W[i * 3 + 2] = (R[6] * x + R[7] * y + R[8] * z) * K;
    const a = c.N[i * 3], b = c.N[i * 3 + 1], d = c.N[i * 3 + 2];
    N[i * 3] = R[0] * a + R[1] * b + R[2] * d;
    N[i * 3 + 1] = R[3] * a + R[4] * b + R[5] * d;
    N[i * 3 + 2] = R[6] * a + R[7] * b + R[8] * d;
  }
  return { W, N };
}

// A uniform hash of points for neighbour queries within one cell size.
function hashOf(cell) {
  const map = new Map(), inv = 1 / cell;
  const key = (i, j, k) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  const add = (q, x, y, z) => {
    const k = key(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv));
    let l = map.get(k);
    if (!l) map.set(k, (l = []));
    l.push(q);
  };
  const near = (x, y, z, fn) => {
    const i0 = Math.floor(x * inv), j0 = Math.floor(y * inv), k0 = Math.floor(z * inv);
    for (let c = -1; c <= 1; c++)
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) {
          const l = map.get(key(i0 + a, j0 + b, k0 + c));
          if (l) for (let m = 0; m < l.length; m++) fn(l[m]);
        }
  };
  return { add, near };
}

// desc: as for prepare(); look: { strut }. Returns hole outlines as line segments, the cells' centres and the
// surface they lie on, with its normals.
function sketch(desc, look) {
  const coarse = !!desc.noLines;
  if (caches[coarse]?.key !== `${desc.shape}:${desc.form}:${coarse}`) caches[coarse] = base(desc, coarse);
  const cache = caches[coarse];
  const { T, n, adj } = cache;
  const { W, N } = place(cache, desc);
  // Out to the skin's outer face, as far as the mesher's solid skin reaches (a little under half the wall).
  const out = 0.38 * (look.thickness ?? 0);
  for (let i = 0; i < W.length; i++) W[i] += N[i] * out;
  const surface = { surface: Float32Array.from(W), normal: N, index: T.slice(), shape: desc.shape, form: desc.form, ...reach(W) };
  // While the settings are still changing only the surface is wanted; the outlines come once they rest.
  if (desc.noLines) return { lines: new Float32Array(0), sites: new Float32Array(0), ...surface };

  // Cell spacing as the mesher sets it: from the count and the area, varied by the same noise.
  let area = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = W[b] - W[a], uy = W[b + 1] - W[a + 1], uz = W[b + 2] - W[a + 2];
    const vx = W[c] - W[a], vy = W[c + 1] - W[a + 1], vz = W[c + 2] - W[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  const nCells = desc.cells * cache.cells * Math.min(1.5, Math.max(0.7, Math.sqrt(area / 3.5)));
  const rho0 = Math.sqrt(area / (1.25 * nCells));
  const seedN = desc.seed | 0;
  const rho = new Float32Array(n);
  let rhoMax = 0;
  for (let v = 0; v < n; v++) {
    const x = W[v * 3], y = W[v * 3 + 1], z = W[v * 3 + 2];
    const nz = vnoise(x * 2.4 + 11, y * 2.4, z * 2.4 - 5, seedN) * 0.65 + vnoise(x * 5.5, y * 5.5 + 7, z * 5.5, seedN + 1) * 0.35;
    rho[v] = rho0 * Math.min(1.8, Math.max(0.55, 1 + desc.variation * 1.5 * (nz - 0.5)));
    rhoMax = Math.max(rhoMax, rho[v]);
  }

  // Sites: a Poisson disc over the vertices in a seeded order.
  const rand = mulberry32(desc.seed >>> 0);
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
  const S = [], srho = [];
  const sh = hashOf(rhoMax);
  for (const v of order) {
    const x = W[v * 3], y = W[v * 3 + 1], z = W[v * 3 + 2], r = rho[v];
    let ok = true;
    sh.near(x, y, z, (q) => {
      if (ok && (S[q * 3] - x) ** 2 + (S[q * 3 + 1] - y) ** 2 + (S[q * 3 + 2] - z) ** 2 < (0.5 * (r + srho[q])) ** 2) ok = false;
    });
    if (!ok) continue;
    sh.add(srho.length, x, y, z);
    S.push(x, y, z);
    srho.push(r);
  }
  const nc = srho.length;

  // Each vertex's cell, and cells meeting across an edge.
  const cell = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const x = W[v * 3], y = W[v * 3 + 1], z = W[v * 3 + 2];
    let best = Infinity, bc = 0;
    sh.near(x, y, z, (q) => {
      const d = (S[q * 3] - x) ** 2 + (S[q * 3 + 1] - y) ** 2 + (S[q * 3 + 2] - z) ** 2;
      if (d < best) { best = d; bc = q; }
    });
    cell[v] = bc;
  }
  const nb = Array.from({ length: nc }, () => new Set());
  for (let v = 0; v < n; v++)
    for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
      const a = cell[v], b = cell[adj.list[e]];
      if (a !== b) { nb[a].add(b); nb[b].add(a); }
    }
  const nbl = nb.map((s) => [...s]);

  // Distance to the cell's border, the gaps to its neighbours blended by a soft min as wide as Roundness.
  const Bd = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const c = cell[v], l = nbl[c];
    if (!l.length) { Bd[v] = 1; continue; }
    const k = Math.max(1e-4, desc.roundness * 0.22 * srho[c]);
    const px = W[v * 3], py = W[v * 3 + 1], pz = W[v * 3 + 2];
    const dc = Math.hypot(px - S[c * 3], py - S[c * 3 + 1], pz - S[c * 3 + 2]);
    let eMin = Infinity;
    for (const q of l) eMin = Math.min(eMin, Math.hypot(px - S[q * 3], py - S[q * 3 + 1], pz - S[q * 3 + 2]) - dc);
    let sum = 0;
    for (const q of l) sum += Math.exp(-(Math.hypot(px - S[q * 3], py - S[q * 3 + 1], pz - S[q * 3 + 2]) - dc - eMin) / k);
    Bd[v] = 0.5 * (eMin - k * Math.log(sum));
  }

  // The hole's rim: where the border distance reaches the strut's half width, by marching triangles.
  const rhoMean = Math.sqrt(area / Math.max(1, nc));
  const s = new Float32Array(n);
  for (let v = 0; v < n; v++) s[v] = Bd[v] - look.strut * 0.5 * Math.sqrt(srho[cell[v]] * rhoMean);
  const lines = [];
  const cut = (a, b) => {
    const t = s[a] / (s[a] - s[b]);
    lines.push(W[a * 3] + (W[b * 3] - W[a * 3]) * t, W[a * 3 + 1] + (W[b * 3 + 1] - W[a * 3 + 1]) * t, W[a * 3 + 2] + (W[b * 3 + 2] - W[a * 3 + 2]) * t);
  };
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    const ia = s[a] > 0, ib = s[b] > 0, ic = s[c] > 0;
    if (ia === ib && ib === ic) continue;
    if (ia !== ib) cut(a, b);
    if (ib !== ic) cut(b, c);
    if (ic !== ia) cut(c, a);
  }
  return { lines: Float32Array.from(lines), sites: Float32Array.from(S), ...surface };
}

// How far the surface reaches from the centre, overall and about the x axis, measured as the mesher measures them.
function reach(W) {
  let radius = 0, radiusX = 0;
  for (let i = 0; i < W.length; i += 3) {
    radius = Math.max(radius, Math.hypot(W[i], W[i + 1], W[i + 2]));
    radiusX = Math.max(radiusX, Math.hypot(W[i + 1], W[i + 2]));
  }
  return { radius: radius + 0.02, radiusX: radiusX + 0.02 };
}

export { sketch };
