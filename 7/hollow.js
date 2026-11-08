// A shape's surface as a fine, fair triangle mesh, perforated by Voronoi cells laid out on the surface and
// thickened into rounded struts. prepare() builds everything that doesn't change while it erodes: the surface, the
// cell sites, every vertex's cell and its distance to the cell's border. mesh() cuts the surface along that distance
// for erosion E (0: a closed skin, 1: struts) and thickens what is left, all in the sculpture's own frame.
import { shapeById, shapeConfig, mulberry32 } from "./shapes/index.js";
import { FIT } from "./shapes/parametric.js";
import { Buf, Heap, decimate, paramMesh, implicitMesh, adjacency, edgesOf, orient, gradient } from "./surface.js";

// Wall thickness nested layers are spaced for, the gap between them, and how far the light keeps from any wall.
const REF_T = 0.028;
const LAYER_GAP = 0.03;
const LIGHT_CLEAR = 0.04;
// Bands of the rounded lip: isolines of the strut profile at these angles (0 at the rim, 90° on the face).
const LIP_STEPS = 4, LIP_STEPS_LITE = 3;
const BEAD_STEPS = 6;

// Layer recipes: wall thickness, cell size, material, and how much they crown or widen their struts. Inner
// layers are the solid's surface inset, so they only exist on solids thick enough to hold them.
const MODES = {
  single: [{ thick: 1, cell: 1, kind: 0 }],
};

function hash(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(s | 0, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, z, s) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash(ix, iy, iz, s), hash(ix + 1, iy, iz, s), fx), l(hash(ix, iy + 1, iz, s), hash(ix + 1, iy + 1, iz, s), fx), fy),
    l(l(hash(ix, iy, iz + 1, s), hash(ix + 1, iy, iz + 1, s), fx), l(hash(ix, iy + 1, iz + 1, s), hash(ix + 1, iy + 1, iz + 1, s), fx), fy),
    fz,
  );
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- the base surface, in the shape's frame ----------

function boxOf(P) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = P[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  return { lo, hi };
}

// Centres points on the box of P and scales them into the sphere of radius FIT (every array in `also` too).
function fitInto(P, also) {
  const { lo, hi } = boxOf(P);
  const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  let r = 0;
  for (let i = 0; i < P.length; i += 3) r = Math.max(r, Math.hypot(P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]));
  const f = FIT / (r || 1);
  for (const A of [P, ...also]) if (A) for (let i = 0; i < A.length; i += 3) for (let a = 0; a < 3; a++) A[i + a] = (A[i + a] - c[a]) * f;
}

// Stencil points beside each vertex from its normal (t1 x t2 = n), so a later warp carries the normal along.
function stencilFrom(P, N, e) {
  const S = new Float64Array((P.length / 3) * 6);
  for (let v = 0; v < P.length / 3; v++) {
    const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
    const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
    let t1x = -ay * nz, t1y = ax * nz, t1z = ay * nx - ax * ny;
    const l = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= l; t1y /= l; t1z /= l;
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], o = v * 6;
    S[o] = x + e * t1x; S[o + 1] = y + e * t1y; S[o + 2] = z + e * t1z;
    S[o + 3] = x + e * t2x; S[o + 4] = y + e * t2y; S[o + 5] = z + e * t2z;
  }
  return S;
}

// Keeps the part of a mesh where Q < 0, cutting triangles along Q = 0 (positions and normals interpolated).
function clipMesh(P, N, T, Q) {
  const nv = P.length / 3;
  const Pn = new Buf(Float64Array), Nn = new Buf(Float64Array), Tn = new Buf(Uint32Array);
  const map = new Int32Array(nv).fill(-1);
  const keepV = (v) => {
    if (map[v] < 0) {
      map[v] = Pn.n / 3;
      Pn.push3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      Nn.push3(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    }
    return map[v];
  };
  const cuts = new Map();
  const cut = (a, b) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let id = cuts.get(key);
    if (id !== undefined) return id;
    const t = Q[a] / (Q[a] - Q[b]);
    id = Pn.n / 3;
    Pn.push3(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t);
    Nn.push3(N[a * 3] + (N[b * 3] - N[a * 3]) * t, N[a * 3 + 1] + (N[b * 3 + 1] - N[a * 3 + 1]) * t, N[a * 3 + 2] + (N[b * 3 + 2] - N[a * 3 + 2]) * t);
    cuts.set(key, id);
    return id;
  };
  for (let t = 0; t < T.length; t += 3) {
    const k = [T[t], T[t + 1], T[t + 2]];
    const inn = k.map((v) => Q[v] < 0);
    if (inn[0] && inn[1] && inn[2]) { Tn.push3(keepV(k[0]), keepV(k[1]), keepV(k[2])); continue; }
    if (!inn[0] && !inn[1] && !inn[2]) continue;
    const poly = [];
    for (let m = 0; m < 3; m++) {
      const a = k[m], b = k[(m + 1) % 3];
      if (inn[m]) poly.push(keepV(a));
      if (inn[m] !== inn[(m + 1) % 3]) poly.push(cut(a, b));
    }
    for (let m = 1; m + 1 < poly.length; m++) Tn.push3(poly[0], poly[m], poly[m + 1]);
  }
  return { P: Pn.slice(), N: Nn.slice(), T: Tn.slice() };
}

// A parametric sheet: patches on (u, v) grids, fitted, warped and fitted again like the shape module defines it.
function sheetBase(shape, hs, areaRef) {
  let ext = 0;
  const pts = [];
  for (const part of shape.parts) {
    for (let j = 0; j <= 24; j++)
      for (let i = 0; i <= 24; i++) {
        const u = part.u[0] + ((part.u[1] - part.u[0]) * i) / 24, v = part.v[0] + ((part.v[1] - part.v[0]) * j) / 24;
        if (part.clip && part.clip(u, v) >= 0) continue;
        const p = part.fn(u, v);
        if (p && Number.isFinite(p[0] + p[1] + p[2])) pts.push(p);
      }
  }
  const c = [0, 1, 2].map((k) => (Math.min(...pts.map((p) => p[k])) + Math.max(...pts.map((p) => p[k]))) / 2);
  for (const p of pts) ext = Math.max(ext, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  let area = 0;
  for (const part of shape.parts) {
    const n = 24, g = [];
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const u = part.u[0] + ((part.u[1] - part.u[0]) * i) / n, v = part.v[0] + ((part.v[1] - part.v[0]) * j) / n;
        const p = part.clip && part.clip(u, v) >= 0 ? null : part.fn(u, v);
        g.push(p && Number.isFinite(p[0] + p[1] + p[2]) ? p : null);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = g[j * (n + 1) + i], b = g[j * (n + 1) + i + 1], c = g[(j + 1) * (n + 1) + i];
        if (!a || !b || !c) continue;
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      }
  }
  area *= (FIT / ext) ** 2;
  // A large surface gets a coarser mesh, a small one a finer one (its cells are smaller).
  const coarsen = Math.max(0.75, Math.sqrt(area / areaRef));
  const m = paramMesh(shape.parts, ((hs * ext) / FIT) * coarsen);
  const rails = shape.rails?.length ? Float64Array.from(shape.rails) : null;
  fitInto(m.P, [m.S, rails]);
  if (shape.deform) {
    shape.deform(m.P);
    shape.deform(m.S);
    if (rails) shape.deform(rails);
    fitInto(m.P, [m.S, rails]);
  }
  return { P: m.P, S: m.S, T: m.T, rails, coarsen };
}

// An implicit sheet (Scherk): surface nets past its region, cut cleanly along the region's edge, projected again.
function implicitSheetBase(shape, hs) {
  const { f, lo, hi, clip } = shape.implicit;
  const ext = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  const h = (hs * ext) / FIT;
  const pad = 4 * h;
  const m = implicitMesh(f, lo.map((v) => v - pad), hi.map((v) => v + pad), h, { keep: 0.05 });
  const Q = new Float64Array(m.P.length / 3);
  for (let v = 0; v < Q.length; v++) Q[v] = clip(m.P[v * 3], m.P[v * 3 + 1], m.P[v * 3 + 2]);
  const c = clipMesh(m.P, m.N, m.T, Q);
  const g = new Float64Array(3);
  for (let v = 0; v < c.P.length / 3; v++) {
    let x = c.P[v * 3], y = c.P[v * 3 + 1], z = c.P[v * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const f0 = f(x, y, z);
      gradient(f, x, y, z, f0, h * 0.01, g);
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (!(gg > 1e-20)) break;
      x -= (f0 * g[0]) / gg; y -= (f0 * g[1]) / gg; z -= (f0 * g[2]) / gg;
    }
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    c.P[v * 3] = x; c.P[v * 3 + 1] = y; c.P[v * 3 + 2] = z;
    c.N[v * 3] = g[0] / gl; c.N[v * 3 + 1] = g[1] / gl; c.N[v * 3 + 2] = g[2] / gl;
  }
  const S = stencilFrom(c.P, c.N, h * 0.02);
  fitInto(c.P, [S]);
  if (shape.deform) {
    shape.deform(c.P);
    shape.deform(S);
    fitInto(c.P, [S]);
  }
  return { P: c.P, S, T: c.T, rails: null, coarsen: 1 };
}

// A solid: its reach sets the frame (radius about FIT), then surface nets of the field projected onto it.
function solidBase(shape, hs, progress, areaRef) {
  const { f, extent } = shape;
  const C = 40, ch = (2 * extent) / C;
  let reach = 0, crossings = 0;
  const inside = new Uint8Array((C + 1) ** 3);
  for (let k = 0, o = 0; k <= C; k++)
    for (let j = 0; j <= C; j++)
      for (let i = 0; i <= C; i++, o++) {
        const x = -extent + i * ch, y = -extent + j * ch, z = -extent + k * ch;
        if (f(x, y, z) < 0) { reach = Math.max(reach, Math.hypot(x, y, z)); inside[o] = 1; }
        if (i && inside[o] !== inside[o - 1]) crossings++;
        if (j && inside[o] !== inside[o - C - 1]) crossings++;
        if (k && inside[o] !== inside[o - (C + 1) ** 2]) crossings++;
      }
  reach = Math.max(reach + ch, 0.2);
  const scale = reach / 0.95;
  // A large surface gets a coarser mesh: area from the crossings of the coarse grid, in the 0.95-sized frame.
  const area = (crossings * ch * ch) / 1.5 / (scale * scale);
  const coarsen = Math.max(1, Math.sqrt(area / areaRef));
  const h = hs * scale * coarsen;
  const B = Math.min(extent, reach + 4 * h);
  const m = implicitMesh(f, [-B, -B, -B], [B, B, B], h, { keep: shape.keep, onProgress: (x) => progress(0.1 + 0.3 * x) });
  for (let i = 0; i < m.P.length; i++) m.P[i] /= scale;
  const S = stencilFrom(m.P, m.N, (h / scale) * 0.02);
  let rails = null;
  if (shape.rails?.length) {
    const segs = [];
    for (const line of shape.rails) for (let i = 0; i < line.length; i++) segs.push(...line[i].map((c) => c / scale), ...line[(i + 1) % line.length].map((c) => c / scale));
    rails = Float64Array.from(segs);
  }
  const sites = shape.sites ? Float64Array.from(shape.sites, (c) => c / scale) : null;
  // Inner layers: the field's surface inset by `inset` (in the shape's frame), coarser by `coarse`.
  const inner = (inset, coarse) => {
    const mi = implicitMesh(f, [-B, -B, -B], [B, B, B], h * coarse, { keep: 0.12, offset: inset * scale });
    for (let i = 0; i < mi.P.length; i++) mi.P[i] /= scale;
    return { P: mi.P, S: stencilFrom(mi.P, mi.N, ((h * coarse) / scale) * 0.02), T: mi.T };
  };
  return { P: m.P, S, T: m.T, rails, sites, siteKeep: shape.siteKeep, siteSpacing: shape.siteSpacing ? shape.siteSpacing / scale : 0, inner, coarsen, scale };
}

// Rotation (rows) taking the surface's principal axes to x (longest), y and z (thinnest). Nearly isotropic shapes
// are left as they are.
function principalAxes(P, T) {
  const C = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const w = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    C[0] += w * x * x; C[1] += w * y * y; C[2] += w * z * z; C[3] += w * x * y; C[4] += w * y * z; C[5] += w * x * z;
  }
  return axesFrom(C);
}

// The rotation from a second-moment tensor (xx, yy, zz, xy, yz, xz).
function axesFrom(C) {
  const A = [[C[0], C[3], C[5]], [C[3], C[1], C[4]], [C[5], C[4], C[2]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 30; it++) {
    let p = 0, q = 1;
    if (Math.abs(A[0][2]) > Math.abs(A[p][q])) (p = 0), (q = 2);
    if (Math.abs(A[1][2]) > Math.abs(A[p][q])) (p = 1), (q = 2);
    if (Math.abs(A[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let r = 0; r < 3; r++) { const a = A[r][p], b = A[r][q]; A[r][p] = c * a - s * b; A[r][q] = s * a + c * b; }
    for (let r = 0; r < 3; r++) { const a = A[p][r], b = A[q][r]; A[p][r] = c * a - s * b; A[q][r] = s * a + c * b; }
    for (let r = 0; r < 3; r++) { const a = V[r][p], b = V[r][q]; V[r][p] = c * a - s * b; V[r][q] = s * a + c * b; }
  }
  const ev = [0, 1, 2].sort((a, b) => A[b][b] - A[a][a]);
  if (A[ev[0]][ev[0]] < 1.25 * A[ev[2]][ev[2]]) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const axis = (e) => {
    const v = [V[0][e], V[1][e], V[2][e]];
    const big = v.reduce((m, c, i) => (Math.abs(c) > Math.abs(v[m]) ? i : m), 0);
    return v[big] < 0 ? v.map((c) => -c) : v;
  };
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  // An axis of the world, less its part along n, normalised: a choice that doesn't depend on the mesh.
  const across = (n, w) => {
    const d = w[0] * n[0] + w[1] * n[1] + w[2] * n[2], v = [w[0] - d * n[0], w[1] - d * n[1], w[2] - d * n[2]];
    const l = Math.hypot(...v);
    return l > 0.3 ? v.map((c) => c / l) : null;
  };
  const e0 = A[ev[0]][ev[0]], e1 = A[ev[1]][ev[1]], e2 = A[ev[2]][ev[2]];
  // Two near-equal axes (a knot, a torus) leave the turn between them to chance, which a finer or coarser mesh of the
  // same shape would pick differently: the unique axis is kept and the other two follow the world's axes.
  if (e0 < 1.15 * e1) {
    const z = axis(ev[2]);
    const x = across(z, [1, 0, 0]) ?? across(z, [0, 1, 0]);
    const y = cross(z, x);
    return [...x, ...y, ...z];
  }
  if (e1 < 1.15 * e2) {
    const x = axis(ev[0]);
    const z = across(x, [0, 0, 1]) ?? across(x, [0, 1, 0]);
    const y = cross(z, x);
    return [...x, ...y, ...z];
  }
  const a = axis(ev[0]), b = axis(ev[1]);
  return [...a, ...b, ...cross(a, b)];
}

// ---------- fields on the surface ----------

// Unsigned distance to the vertices on a grid (nearest vertex propagated by two raster sweeps).
function distanceGrid(P, g, box = boxOf(P)) {
  const nv = P.length / 3;
  const { lo, hi } = box;
  const o = lo.map((v) => v - 3 * g);
  const n = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a]) / g) + 7);
  const [nx, ny, nz] = n, NXY = nx * ny, N = NXY * nz;
  const idx = new Int32Array(N).fill(-1), D = new Float32Array(N).fill(Infinity);
  const d2 = (node, v) => {
    const k = (node / NXY) | 0, r = node - k * NXY, j = (r / nx) | 0, i = r - j * nx;
    return (o[0] + i * g - P[v * 3]) ** 2 + (o[1] + j * g - P[v * 3 + 1]) ** 2 + (o[2] + k * g - P[v * 3 + 2]) ** 2;
  };
  for (let v = 0; v < nv; v++) {
    const i0 = Math.round((P[v * 3] - o[0]) / g), j0 = Math.round((P[v * 3 + 1] - o[1]) / g), k0 = Math.round((P[v * 3 + 2] - o[2]) / g);
    for (let k = k0 - 1; k <= k0 + 1; k++)
      for (let j = j0 - 1; j <= j0 + 1; j++)
        for (let i = i0 - 1; i <= i0 + 1; i++) {
          const node = i + nx * j + NXY * k, d = d2(node, v);
          if (d < D[node]) { D[node] = d; idx[node] = v; }
        }
  }
  const offs = [];
  for (let c = -1; c <= 0; c++)
    for (let b = -1; b <= 1; b++)
      for (let a = -1; a <= 1; a++) if (c < 0 || b < 0 || (b === 0 && a < 0)) offs.push(a + nx * b + NXY * c);
  const no = offs.length;
  for (const s of [1, -1]) {
    for (let kk = 1; kk < nz - 1; kk++) {
      const k = s > 0 ? kk : nz - 1 - kk, z = o[2] + k * g;
      for (let jj = 1; jj < ny - 1; jj++) {
        const j = s > 0 ? jj : ny - 1 - jj, y = o[1] + j * g;
        for (let ii = 1; ii < nx - 1; ii++) {
          const i = s > 0 ? ii : nx - 1 - ii, node = i + nx * j + NXY * k, x = o[0] + i * g;
          let best = D[node], bv = idx[node];
          for (let m = 0; m < no; m++) {
            const v = idx[node + s * offs[m]];
            if (v < 0 || v === bv) continue;
            const d = (x - P[v * 3]) ** 2 + (y - P[v * 3 + 1]) ** 2 + (z - P[v * 3 + 2]) ** 2;
            if (d < best) { best = d; bv = v; }
          }
          D[node] = best;
          idx[node] = bv;
        }
      }
    }
  }
  for (let i = 0; i < N; i++) D[i] = Math.sqrt(D[i]);
  const data = { D, lo: o, n, g };
  const nearest = (x, y, z) => {
    const i = Math.min(nx - 1, Math.max(0, Math.round((x - o[0]) / g))), j = Math.min(ny - 1, Math.max(0, Math.round((y - o[1]) / g))), k = Math.min(nz - 1, Math.max(0, Math.round((z - o[2]) / g)));
    return idx[i + nx * j + NXY * k];
  };
  return { at: gridSampler(data), nearest, data, lo: o, n, g, box: [o, [o[0] + (nx - 1) * g, o[1] + (ny - 1) * g, o[2] + (nz - 1) * g]] };
}

// The grid as the main thread samples it anywhere: its outer layer of nodes, which the sweeps never reach, is filled
// in from the layer inside.
function lightField(data) {
  const { D, n: [nx, ny, nz], g } = data;
  const c = (i, n) => Math.min(n - 2, Math.max(1, i));
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const q = i + nx * (j + ny * k);
        if (Number.isFinite(D[q])) continue;
        const ci = c(i, nx), cj = c(j, ny), ck = c(k, nz);
        D[q] = D[ci + nx * (cj + ny * ck)] + g * Math.hypot(i - ci, j - cj, k - ck);
      }
  return gridSampler(data);
}

// Trilinear lookup in a distance grid; past its box, plus the distance to the box.
function gridSampler({ D, lo: o, n, g }) {
  const [nx, ny, nz] = n, NXY = nx * ny;
  return (x, y, z) => {
    let fx = (x - o[0]) / g, fy = (y - o[1]) / g, fz = (z - o[2]) / g;
    const out = Math.hypot(Math.max(0, -fx, fx - (nx - 1.001)), Math.max(0, -fy, fy - (ny - 1.001)), Math.max(0, -fz, fz - (nz - 1.001))) * g;
    fx = Math.min(nx - 1.001, Math.max(0, fx)); fy = Math.min(ny - 1.001, Math.max(0, fy)); fz = Math.min(nz - 1.001, Math.max(0, fz));
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
    const q = i + nx * j + NXY * k;
    const a0 = D[q] + (D[q + 1] - D[q]) * tx, a1 = D[q + nx] + (D[q + nx + 1] - D[q + nx]) * tx;
    const a2 = D[q + NXY] + (D[q + NXY + 1] - D[q + NXY]) * tx, a3 = D[q + NXY + nx] + (D[q + NXY + nx + 1] - D[q + NXY + nx]) * tx;
    const b0 = a0 + (a1 - a0) * ty, b1 = a2 + (a3 - a2) * ty;
    return b0 + (b1 - b0) * tz + out;
  };
}

// Lengths of the adjacency's edges.
function edgeLengths(P, adj) {
  const nv = adj.start.length - 1;
  const len = new Float32Array(adj.list.length);
  for (let v = 0; v < nv; v++)
    for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
      const u = adj.list[e];
      len[e] = Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
    }
  return len;
}

// Jacobi smoothing of a scalar over the mesh.
function smoothScalar(X, adj, passes) {
  const nv = X.length, tmp = new Float32Array(nv);
  for (let p = 0; p < passes; p++) {
    for (let v = 0; v < nv; v++) {
      let s = X[v], n = 1;
      for (let e = adj.start[v]; e < adj.start[v + 1]; e++) { s += X[adj.list[e]]; n++; }
      tmp[v] = s / n;
    }
    X.set(tmp);
  }
}

// Distance (3D) to the nearest of a set of segments, carried over the mesh from the vertices next to them, so only the
// sheet they lie on is reached. Also the direction away from it. Beyond `reach` it is left at reach.
function segmentDistance(P, adj, segs, seeds, reach) {
  const nv = P.length / 3;
  const D = new Float64Array(nv).fill(reach), seg = new Int32Array(nv).fill(-1);
  const dist = (v, s) => {
    const o = s * 6, ax = segs[o], ay = segs[o + 1], az = segs[o + 2];
    const dx = segs[o + 3] - ax, dy = segs[o + 4] - ay, dz = segs[o + 5] - az;
    const px = P[v * 3] - ax, py = P[v * 3 + 1] - ay, pz = P[v * 3 + 2] - az;
    const ll = dx * dx + dy * dy + dz * dz;
    let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - dx * t, py - dy * t, pz - dz * t);
  };
  const heap = new Heap();
  for (let i = 0; i < seeds.length; i += 2) {
    const v = seeds[i], s = seeds[i + 1], d = dist(v, s);
    if (d < D[v]) { D[v] = d; seg[v] = s; heap.push(d, v); }
  }
  while (heap.n) {
    const v = heap.pop();
    if (heap.key > D[v]) continue;
    const s = seg[v];
    for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
      const u = adj.list[e];
      const d = dist(u, s);
      if (d < D[u] && d < reach) { D[u] = d; seg[u] = s; heap.push(d, u); }
    }
  }
  // Direction away from the segment.
  const Gd = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const s = seg[v];
    if (s < 0) continue;
    const o = s * 6, ax = segs[o], ay = segs[o + 1], az = segs[o + 2];
    const dx = segs[o + 3] - ax, dy = segs[o + 4] - ay, dz = segs[o + 5] - az;
    const px = P[v * 3] - ax, py = P[v * 3 + 1] - ay, pz = P[v * 3 + 2] - az;
    const ll = dx * dx + dy * dy + dz * dz;
    let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t, l = Math.hypot(qx, qy, qz);
    if (l > 1e-9) { Gd[v * 3] = qx / l; Gd[v * 3 + 1] = qy / l; Gd[v * 3 + 2] = qz / l; }
  }
  return { D, G: Gd };
}

// ---------- prepare ----------

// desc: { key, seed, shape, form, mode, count, cells, variation, roundness, h, size, view, lite }
// h is the edge length of the surface mesh. progress(f) is told roughly how far along it is.
function prepare(desc, progress = () => {}) {
  const t0 = performance.now();
  const times = {};
  const mark = (name) => (times[name] = Math.round(performance.now() - t0));
  const rand = mulberry32(desc.seed >>> 0);
  const def = shapeById(desc.shape);
  const shape = def.build(shapeConfig(desc.shape, desc.values, desc.form));
  const sheet = shape.kind === "sheet";
  let L = desc.h;
  // Edge length in the shape's frame, which is fitted to about FIT (sheets) or 0.95 (solids).
  const hs = (L * (sheet ? FIT : 0.95)) / desc.size;
  // Surface area (in the shape's frame) past which the mesh gets coarser: about 5 square units in the sculpture's.
  const areaRef = 5 * ((sheet ? FIT : 0.95) / desc.size) ** 2;
  const base = sheet ? (shape.parts ? sheetBase(shape, hs, areaRef) : implicitSheetBase(shape, hs)) : solidBase(shape, hs, progress, areaRef);
  L *= base.coarsen;
  mark("surface");
  progress(0.45);

  // Into the sculpture's frame: turned so its longest extent lies across the view and its thinnest faces the
  // camera, scaled to desc.size.
  let ext = 0;
  for (let i = 0; i < base.P.length; i += 3) ext = Math.max(ext, Math.hypot(base.P[i], base.P[i + 1], base.P[i + 2]));
  const K = desc.size / ext;
  const R = def.upright ?? principalAxes(base.P, base.T);
  const toFrame = (A) => {
    if (!A) return;
    for (let i = 0; i < A.length; i += 3) {
      const x0 = A[i], y0 = A[i + 1], z0 = A[i + 2];
      const x = R[0] * x0 + R[1] * y0 + R[2] * z0, y = R[3] * x0 + R[4] * y0 + R[5] * z0, z = R[6] * x0 + R[7] * y0 + R[8] * z0;
      A[i] = x * K; A[i + 1] = y * K; A[i + 2] = z * K;
    }
  };
  // Inner layers of a solid: its surface inset, each a gap clear of the one outside it, with finer cells. A layer
  // that would only cover scraps of the solid is left out, and the ones inside it with it.
  let recipes = sheet || !base.inner ? MODES.single : MODES[desc.mode].slice(0, desc.mode === "nested" ? desc.count : undefined);
  const parts = [{ P: base.P, S: base.S, T: base.T }];
  if (recipes.length > 1) {
    let inset = 0;
    for (let l = 1; l < recipes.length; l++) {
      inset += 0.5 * REF_T * (recipes[l - 1].thick + recipes[l].thick) + LAYER_GAP;
      const m = base.inner(inset / K, 1.15);
      if (m.T.length / 3 < 0.12 * (parts[0].T.length / 3) * (1 / 1.15) ** 2) break;
      parts.push(m);
      progress(0.45 + 0.05 * l);
    }
    recipes = recipes.slice(0, parts.length);
  }
  mark("layers");
  const layerOf = [];
  for (const part of parts) {
    for (const A of [part.P, part.S]) toFrame(A);
    const d = decimate(part.P, part.T, 0.62 * L, 1.4 * L);
    const S = new Float64Array(d.keep.length * 6);
    for (let i = 0; i < d.keep.length; i++) S.set(part.S.subarray(d.keep[i] * 6, d.keep[i] * 6 + 6), i * 6);
    part.P = d.P; part.T = d.T; part.S = S;
  }
  for (const A of [base.rails, base.sites]) toFrame(A);
  {
    const nP = parts.reduce((n, p) => n + p.P.length, 0), nT = parts.reduce((n, p) => n + p.T.length, 0);
    const P = new Float64Array(nP), S = new Float64Array(nP * 2), T = new Uint32Array(nT);
    let op = 0, ot = 0;
    parts.forEach((part, l) => {
      P.set(part.P, op);
      S.set(part.S, op * 2);
      for (let i = 0; i < part.T.length; i++) T[ot + i] = part.T[i] + op / 3;
      for (let i = 0; i < part.P.length / 3; i++) layerOf.push(l);
      op += part.P.length;
      ot += part.T.length;
    });
    base.P = P; base.S = S; base.T = T;
  }
  const layerW = Uint8Array.from(layerOf);
  mark("decimate");

  // Winding and seams; every vertex copy gets a normal agreeing with its triangles.
  const or = orient(base.T, base.P.length / 3);
  const canon = or.canon, T = or.T;
  const nw = base.P.length / 3, ns = canon.length;
  const Ps = new Float64Array(ns * 3);
  for (let v = 0; v < ns; v++) for (let a = 0; a < 3; a++) Ps[v * 3 + a] = base.P[canon[v] * 3 + a];
  const face = new Float64Array(ns * 3);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = Ps[b] - Ps[a], uy = Ps[b + 1] - Ps[a + 1], uz = Ps[b + 2] - Ps[a + 2];
    const vx = Ps[c] - Ps[a], vy = Ps[c + 1] - Ps[a + 1], vz = Ps[c + 2] - Ps[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { face[o] += cx; face[o + 1] += cy; face[o + 2] += cz; }
  }
  const Ns = new Float32Array(ns * 3);
  for (let v = 0; v < ns; v++) {
    const o = canon[v] * 6, S = base.S, q = canon[v] * 3, BP = base.P;
    const ax = S[o] - BP[q], ay = S[o + 1] - BP[q + 1], az = S[o + 2] - BP[q + 2];
    const bx = S[o + 3] - BP[q], by = S[o + 4] - BP[q + 1], bz = S[o + 5] - BP[q + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    let l = Math.hypot(nx, ny, nz);
    const fx = face[v * 3], fy = face[v * 3 + 1], fz = face[v * 3 + 2], fl = Math.hypot(fx, fy, fz) || 1;
    let ok = l > 0 && Number.isFinite(l);
    if (ok) {
      nx /= l; ny /= l; nz /= l;
      const d = (nx * fx + ny * fy + nz * fz) / fl;
      if (Math.abs(d) < 0.7) ok = false;
      else if (d < 0) { nx = -nx; ny = -ny; nz = -nz; }
    }
    if (!ok) { nx = fx / fl; ny = fy / fl; nz = fz / fl; }
    Ns[v * 3] = nx; Ns[v * 3 + 1] = ny; Ns[v * 3 + 2] = nz;
  }
  // A normal per welded vertex (any sign) for the fields below.
  const Nw = new Float32Array(nw * 3);
  for (let v = ns - 1; v >= 0; v--) for (let a = 0; a < 3; a++) Nw[canon[v] * 3 + a] = Ns[v * 3 + a];
  const Pw = base.P, Tw = base.T;
  mark("orient");

  // Fields on the welded mesh.
  const adj = adjacency(Tw, nw);
  const elen = edgeLengths(Pw, adj);
  let area = 0;
  for (let t = 0; t < Tw.length; t += 3) {
    if (layerW[Tw[t]]) continue;
    const a = Tw[t] * 3, b = Tw[t + 1] * 3, c = Tw[t + 2] * 3;
    const ux = Pw[b] - Pw[a], uy = Pw[b + 1] - Pw[a + 1], uz = Pw[b + 2] - Pw[a + 2];
    const vx = Pw[c] - Pw[a], vy = Pw[c + 1] - Pw[a + 1], vz = Pw[c + 2] - Pw[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  const grid = distanceGrid(Pw, Math.max(0.02, 1.8 * L));
  mark("grid");

  // Clearance: how far along the normal, either way, until another part of the surface (the solid's thickness, or a
  // sheet passing close).
  // Rays are cast from every third vertex; the rest are filled in from their neighbours.
  const sampled = (v) => v % 3 === 0;
  const fill = (X) => {
    const known = new Uint8Array(nw);
    for (let v = 0; v < nw; v++) known[v] = sampled(v) ? 1 : 0;
    for (let pass = 0; pass < 8; pass++) {
      let missing = 0;
      for (let v = 0; v < nw; v++) {
        if (known[v]) continue;
        let sum = 0, n = 0;
        for (let e = adj.start[v]; e < adj.start[v + 1]; e++) if (known[adj.list[e]] === 1) { sum += X[adj.list[e]]; n++; }
        if (n) { X[v] = sum / n; known[v] = 2; } else missing++;
      }
      for (let v = 0; v < nw; v++) if (known[v] === 2) known[v] = 1;
      if (!missing) break;
    }
  };
  // A solid's cells are limited by its thickness only (inward); its walls by anything close either way.
  const clear = new Float32Array(nw).fill(0.6), clearIn = new Float32Array(nw).fill(0.6);
  const thr = 0.6 * L + 0.25 * grid.g;
  for (let v = 0; v < nw; v++) {
    if (!sampled(v)) continue;
    const px = Pw[v * 3], py = Pw[v * 3 + 1], pz = Pw[v * 3 + 2], nx = Nw[v * 3], ny = Nw[v * 3 + 1], nz = Nw[v * 3 + 2];
    let best = 0.6;
    for (const sgn of [-1, 1]) {
      let t = 1.5 * grid.g;
      for (let it = 0; it < 48 && t < best; it++) {
        const qx = px + sgn * nx * t, qy = py + sgn * ny * t, qz = pz + sgn * nz * t;
        const d = grid.at(qx, qy, qz);
        if (d < thr) {
          // Only a sheet roughly parallel to this one limits the wall; one crossing it doesn't.
          const u = grid.nearest(qx, qy, qz);
          if (u < 0 || Math.abs(nx * Nw[u * 3] + ny * Nw[u * 3 + 1] + nz * Nw[u * 3 + 2]) > 0.6) best = t;
          break;
        }
        t += Math.max(0.9 * (d - thr), 0.3 * grid.g);
      }
      if (sgn < 0) clearIn[v] = best;
    }
    clear[v] = best;
  }
  fill(clear);
  fill(clearIn);
  smoothScalar(clear, adj, 2);
  smoothScalar(clearIn, adj, 2);

  // Ambient occlusion either side of the surface: a few short rays against the whole skin. The inside of a solid
  // reads dark through its holes.
  const aoTop = new Float32Array(nw), aoBot = new Float32Array(nw);
  {
    const R = 0.16, dirs = [[0, 0, 1], [0.6, 0, 0.8], [-0.3, 0.52, 0.8], [-0.3, -0.52, 0.8], [0.86, 0.5, 0.1], [-0.86, 0.5, 0.1], [0, -1, 0.1]];
    for (let v = 0; v < nw; v++) {
      if (!sampled(v)) continue;
      const px = Pw[v * 3], py = Pw[v * 3 + 1], pz = Pw[v * 3 + 2], nx = Nw[v * 3], ny = Nw[v * 3 + 1], nz = Nw[v * 3 + 2];
      const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
      let t1x = -ay * nz, t1y = ax * nz, t1z = ay * nx - ax * ny;
      const l = Math.hypot(t1x, t1y, t1z) || 1;
      t1x /= l; t1y /= l; t1z /= l;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      for (const sgn of [1, -1]) {
        let open = 0;
        for (const [a, b, c] of dirs) {
          const dx = t1x * a + t2x * b + sgn * nx * c, dy = t1y * a + t2y * b + sgn * ny * c, dz = t1z * a + t2z * b + sgn * nz * c;
          let t = 1.4 * grid.g, vis = 1;
          while (t < R) {
            const d = grid.at(px + dx * t, py + dy * t, pz + dz * t);
            if (d < thr) { vis = 0.15 + 0.85 * (t / R) ** 2; break; }
            t += Math.max(0.8 * (d - thr), 0.5 * grid.g);
          }
          open += vis;
        }
        (sgn > 0 ? aoTop : aoBot)[v] = open / dirs.length;
      }
    }
    fill(aoTop);
    fill(aoBot);
  }

  // Curvature: how fast the normal turns, sign-agnostic, smoothed.
  const kappa = new Float32Array(nw);
  for (let v = 0; v < nw; v++) {
    let s = 0, n = 0;
    for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
      const u = adj.list[e];
      const d = Nw[v * 3] * Nw[u * 3] + Nw[v * 3 + 1] * Nw[u * 3 + 1] + Nw[v * 3 + 2] * Nw[u * 3 + 2];
      s += Math.sqrt(Math.max(0, 2 - 2 * Math.abs(d))) / Math.max(elen[e], 1e-6);
      n++;
    }
    kappa[v] = n ? s / n : 0;
  }
  smoothScalar(kappa, adj, 4);
  mark("fields");

  // Cell spacing: from the count, noisy, smaller where the surface is tight (curved, or thin, or close to another
  // sheet), never under a few edges.
  // Cells is a count for a sculpture of typical surface area; a smaller surface gets fewer.
  const nCells = desc.cells * (def.cells ?? 1) * Math.min(1.5, Math.max(0.7, Math.sqrt(area / 3.5)));
  const rho0 = Math.sqrt(area / (1.25 * nCells));
  const seedN = desc.seed | 0;
  const rho = new Float32Array(nw);
  const rhoMin = Math.max(7 * L, 0.3 * rho0);
  for (let v = 0; v < nw; v++) {
    const x = Pw[v * 3], y = Pw[v * 3 + 1], z = Pw[v * 3 + 2];
    const nz = vnoise(x * 2.4 + 11, y * 2.4, z * 2.4 - 5, seedN) * 0.65 + vnoise(x * 5.5, y * 5.5 + 7, z * 5.5, seedN + 1) * 0.35;
    const vary = Math.min(1.8, Math.max(0.55, 1 + desc.variation * 1.5 * (nz - 0.5)));
    const r0 = rho0 * recipes[layerW[v]].cell;
    let r = (r0 * vary) / (1 + (sheet ? 0.5 : 0.12) * r0 * kappa[v]);
    r = Math.min(r, 1.2 * (sheet ? clear[v] : clearIn[v]));
    rho[v] = Math.max(rhoMin * Math.min(1, recipes[layerW[v]].cell * 1.4), r);
  }
  smoothScalar(rho, adj, 3);
  // Scaled so the count stays near the one asked for, a little over where the surface is tight.
  {
    const va = new Float64Array(nw);
    for (let t = 0; t < Tw.length; t += 3) {
      const a = Tw[t] * 3, b = Tw[t + 1] * 3, c = Tw[t + 2] * 3;
      const ux = Pw[b] - Pw[a], uy = Pw[b + 1] - Pw[a + 1], uz = Pw[b + 2] - Pw[a + 2];
      const vx = Pw[c] - Pw[a], vy = Pw[c + 1] - Pw[a + 1], vz = Pw[c + 2] - Pw[a + 2];
      const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
      va[Tw[t]] += ar; va[Tw[t + 1]] += ar; va[Tw[t + 2]] += ar;
    }
    // Per layer: an inner layer has as many cells as its area at its finer spacing would.
    for (let l = 0; l < recipes.length; l++) {
      let expect = 0, ideal = 0;
      for (let v = 0; v < nw; v++) {
        if (layerW[v] !== l) continue;
        expect += va[v] / (1.25 * rho[v] * rho[v]);
        ideal += va[v] / (1.25 * (rho0 * recipes[l].cell) ** 2);
      }
      const k = Math.sqrt(expect / (1.15 * ideal));
      if (k > 1) for (let v = 0; v < nw; v++) if (layerW[v] === l) rho[v] *= k;
    }
    // Still no wider than a solid is thick, so a cell never wraps right round a thin tube and cuts it.
    if (!sheet) for (let v = 0; v < nw; v++) rho[v] = Math.min(rho[v], Math.max(rhoMin * 0.5, 1.8 * clearIn[v]));
  }

  let rhoMax = 0;
  for (let v = 0; v < nw; v++) rhoMax = Math.max(rhoMax, rho[v]);
  // Open edges of a sheet, and rails a shape keeps solid: distance to them over the mesh.
  const reach = Math.max(0.12, 0.8 * rhoMax);
  const segs = [], seeds = [];
  for (let i = 0; i < or.boundary.length; i += 2) {
    const a = or.boundary[i], b = or.boundary[i + 1], s = segs.length / 6;
    segs.push(Pw[a * 3], Pw[a * 3 + 1], Pw[a * 3 + 2], Pw[b * 3], Pw[b * 3 + 1], Pw[b * 3 + 2]);
    seeds.push(a, s, b, s);
  }
  if (base.rails) {
    // Rails lie on or near the surface: vertices within a couple of edges of one seed it.
    const r0 = segs.length / 6;
    for (let i = 0; i < base.rails.length; i++) segs.push(base.rails[i]);
    const hashCell = 0.05, map = new Map();
    const key = (x, y, z) => `${Math.floor(x / hashCell)},${Math.floor(y / hashCell)},${Math.floor(z / hashCell)}`;
    for (let s = r0; s < segs.length / 6; s++) {
      const o = s * 6;
      for (let t = 0; t <= 1; t += 0.5) {
        const k = key(segs[o] + (segs[o + 3] - segs[o]) * t, segs[o + 1] + (segs[o + 4] - segs[o + 1]) * t, segs[o + 2] + (segs[o + 5] - segs[o + 2]) * t);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(s);
      }
    }
    for (let v = 0; v < nw; v++) {
      const x = Pw[v * 3], y = Pw[v * 3 + 1], z = Pw[v * 3 + 2];
      const i0 = Math.floor(x / hashCell), j0 = Math.floor(y / hashCell), k0 = Math.floor(z / hashCell);
      let best = 2.5 * L, bs = -1;
      for (let k = k0 - 1; k <= k0 + 1; k++)
        for (let j = j0 - 1; j <= j0 + 1; j++)
          for (let i = i0 - 1; i <= i0 + 1; i++) {
            const list = map.get(`${i},${j},${k}`);
            if (!list) continue;
            for (const s of list) {
              const o = s * 6, dx = segs[o + 3] - segs[o], dy = segs[o + 4] - segs[o + 1], dz = segs[o + 5] - segs[o + 2];
              const px = x - segs[o], py = y - segs[o + 1], pz = z - segs[o + 2], ll = dx * dx + dy * dy + dz * dz;
              let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const d = Math.hypot(px - dx * t, py - dy * t, pz - dz * t);
              if (d < best) { best = d; bs = s; }
            }
          }
      if (bs >= 0) seeds.push(v, bs);
    }
  }
  const rail = seeds.length ? segmentDistance(Pw, adj, Float64Array.from(segs), seeds, reach) : null;

  // Sites: Poisson disc over graph distance, so another sheet passing close never blocks one.
  const heap = new Heap(1 << 12);
  const cover = new Float32Array(nw).fill(Infinity);
  const sites = [];
  const siteKeep = [];
  const distTo = new Float64Array(nw).fill(Infinity);
  const touched = new Int32Array(nw);
  const reachFrom = (v, R, visit) => {
    let nt = 0;
    distTo[v] = 0;
    touched[nt++] = v;
    heap.n = 0;
    heap.push(0, v);
    while (heap.n) {
      const x = heap.pop();
      const d = heap.key;
      if (d > distTo[x]) continue;
      visit(x, d);
      for (let e = adj.start[x]; e < adj.start[x + 1]; e++) {
        const u = adj.list[e], du = d + elen[e];
        if (du < distTo[u] && du < R) {
          if (distTo[u] === Infinity) touched[nt++] = u;
          distTo[u] = du;
          heap.push(du, u);
        }
      }
    }
    for (let i = 0; i < nt; i++) distTo[touched[i]] = Infinity;
  };
  if (base.sites) {
    // A shape's own lattice of sites, snapped to the surface.
    for (let o = 0; o < base.sites.length; o += 3) {
      const v = grid.nearest(base.sites[o], base.sites[o + 1], base.sites[o + 2]);
      if (v < 0) continue;
      const d = Math.hypot(Pw[v * 3] - base.sites[o], Pw[v * 3 + 1] - base.sites[o + 1], Pw[v * 3 + 2] - base.sites[o + 2]);
      if (d > 0.25 * base.siteSpacing * K || sites.includes(v)) continue;
      sites.push(v);
      siteKeep.push(base.siteKeep?.[o / 3] ? 1 : 0);
    }
  } else {
    const order = Uint32Array.from({ length: nw }, (_, i) => i);
    for (let i = nw - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (const v of order) {
      // No site right by an open edge: the cell there would be too narrow to open.
      if (cover[v] < 0.5 * rho[v] || (rail && rail.D[v] < 0.6 * rho[v])) continue;
      sites.push(v);
      siteKeep.push(0);
      const rv = 0.5 * rho[v];
      reachFrom(v, rv + 0.5 * rhoMax, (x, d) => {
        if (d - rv < cover[x]) cover[x] = d - rv;
      });
    }
  }
  mark("sites");
  progress(0.6);

  // Cells: nearest site over the mesh, then nearest among the cells around each vertex in space, so the borders
  // are the planes halfway between sites.
  const nc = sites.length;
  const cell = new Int32Array(nw).fill(-1);
  {
    const D = new Float64Array(nw).fill(Infinity);
    heap.n = 0;
    sites.forEach((v, c) => { D[v] = 0; cell[v] = c; heap.push(0, v); });
    while (heap.n) {
      const x = heap.pop();
      if (heap.key > D[x]) continue;
      for (let e = adj.start[x]; e < adj.start[x + 1]; e++) {
        const u = adj.list[e], du = heap.key + elen[e];
        if (du < D[u]) { D[u] = du; cell[u] = cell[x]; heap.push(du, u); }
      }
    }
  }
  const SX = new Float64Array(nc * 3);
  sites.forEach((v, c) => { SX[c * 3] = Pw[v * 3]; SX[c * 3 + 1] = Pw[v * 3 + 1]; SX[c * 3 + 2] = Pw[v * 3 + 2]; });
  const sd2 = (v, c) => (Pw[v * 3] - SX[c * 3]) ** 2 + (Pw[v * 3 + 1] - SX[c * 3 + 1]) ** 2 + (Pw[v * 3 + 2] - SX[c * 3 + 2]) ** 2;
  for (let pass = 0; pass < 2; pass++) {
    const next = cell.slice();
    for (let v = 0; v < nw; v++) {
      let best = cell[v];
      if (best < 0) continue;
      let bd = sd2(v, best);
      for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
        const c = cell[adj.list[e]];
        if (c === best || c < 0) continue;
        const d = sd2(v, c);
        if (d < bd) { bd = d; best = c; }
      }
      next[v] = best;
    }
    cell.set(next);
  }
  // Neighbouring cells: those meeting across an edge.
  const nbSets = Array.from({ length: nc }, () => new Set());
  for (let v = 0; v < nw; v++)
    for (let e = adj.start[v]; e < adj.start[v + 1]; e++) {
      const a = cell[v], b = cell[adj.list[e]];
      if (a !== b && a >= 0 && b >= 0) { nbSets[a].add(b); nbSets[b].add(a); }
    }
  const nbOff = new Int32Array(nc + 1);
  for (let c = 0; c < nc; c++) nbOff[c + 1] = nbOff[c] + nbSets[c].size;
  const nbList = new Int32Array(nbOff[nc]);
  for (let c = 0; c < nc; c++) [...nbSets[c]].forEach((q, i) => (nbList[nbOff[c] + i] = q));

  // Distance to the cell's border: half the gap between the distances to the nearest and the next sites (F2 - F1),
  // which is the same from either side of a border. The gaps to every neighbour (and an open edge, as a full strut)
  // are blended by a soft min, so the holes round off into ovals and the joints into webs. Its gradient along the
  // surface is kept for the normals of the lips.
  const B = new Float32Array(nw), G = new Float32Array(nw * 3);
  let maxNb = 0;
  for (let c = 0; c < nc; c++) maxNb = Math.max(maxNb, nbOff[c + 1] - nbOff[c]);
  const es = new Float64Array(maxNb * 4 + 4);
  const crho = new Float32Array(nc);
  sites.forEach((v, c) => (crho[c] = rho[v]));
  for (let v = 0; v < nw; v++) {
    const c = cell[v];
    if (c < 0) { B[v] = 1; continue; }
    const k = Math.max(1e-4, desc.roundness * 0.22 * crho[c]);
    const px = Pw[v * 3], py = Pw[v * 3 + 1], pz = Pw[v * 3 + 2];
    const cx = px - SX[c * 3], cy = py - SX[c * 3 + 1], cz = pz - SX[c * 3 + 2];
    const dc = Math.hypot(cx, cy, cz), ic = dc > 1e-9 ? 1 / dc : 0;
    let ne = 0, eMin = Infinity;
    for (let i = nbOff[c]; i < nbOff[c + 1]; i++) {
      const q = nbList[i];
      const qx = px - SX[q * 3], qy = py - SX[q * 3 + 1], qz = pz - SX[q * 3 + 2];
      const dq = Math.hypot(qx, qy, qz) || 1e-9;
      const e = dq - dc;
      es[ne++] = e; es[ne++] = qx / dq - cx * ic; es[ne++] = qy / dq - cy * ic; es[ne++] = qz / dq - cz * ic;
      if (e < eMin) eMin = e;
    }
    if (rail && rail.D[v] < reach) {
      const e = rail.D[v];
      es[ne++] = e; es[ne++] = rail.G[v * 3]; es[ne++] = rail.G[v * 3 + 1]; es[ne++] = rail.G[v * 3 + 2];
      if (e < eMin) eMin = e;
    }
    if (!ne) { B[v] = 1; continue; }
    let sum = 0, gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < ne; i += 4) {
      const wgt = Math.exp(-(es[i] - eMin) / k);
      sum += wgt; gx += wgt * es[i + 1]; gy += wgt * es[i + 2]; gz += wgt * es[i + 3];
    }
    B[v] = 0.5 * (eMin - k * Math.log(sum));
    gx *= 0.5 / sum; gy *= 0.5 / sum; gz *= 0.5 / sum;
    const nx = Nw[v * 3], ny = Nw[v * 3 + 1], nz = Nw[v * 3 + 2], dn = gx * nx + gy * ny + gz * nz;
    G[v * 3] = gx - dn * nx; G[v * 3 + 1] = gy - dn * ny; G[v * 3 + 2] = gz - dn * nz;
  }
  // How far each cell is from its own border at its middle: the hole opens there first.
  const bMax = new Float32Array(nc);
  for (let v = 0; v < nw; v++) if (cell[v] >= 0 && B[v] > bMax[cell[v]]) bMax[cell[v]] = B[v];
  mark("cells");
  progress(0.75);

  // Cell clocks: erosion drifts out from the side facing the camera, loosely.
  const view = desc.view ?? [0, 0, 1];
  const ov = [view[0] + (rand() - 0.5) * 0.9, view[1] + (rand() - 0.5) * 0.6, view[2] + (rand() - 0.5) * 0.9];
  const ol = Math.hypot(...ov) || 1;
  const origin = ov.map((v) => (v / ol) * desc.size);
  const delay = new Float32Array(nc), widthJitter = new Float32Array(nc);
  let maxDist = 0;
  const cdist = new Float32Array(nc);
  for (let c = 0; c < nc; c++) {
    cdist[c] = Math.hypot(SX[c * 3] - origin[0], SX[c * 3 + 1] - origin[1], SX[c * 3 + 2] - origin[2]);
    maxDist = Math.max(maxDist, cdist[c]);
  }
  const cellLayer = new Uint8Array(nc);
  sites.forEach((v, c) => (cellLayer[c] = layerW[v]));
  let rhoMean = 0;
  for (let c = 0; c < nc; c++) {
    delay[c] = Math.min(1, 0.45 * (cdist[c] / maxDist) + 0.5 * rand());
    widthJitter[c] = 0.88 + 0.24 * rand();
    rhoMean += crho[c] / recipes[cellLayer[c]].cell / nc;
  }

  // The split (oriented) mesh the frames are cut from, with its own edges, and the open edges' outward directions.
  const E = edgesOf(T, ns);
  const bnd = new Buf(Uint32Array);
  const outward = new Float32Array(ns * 3);
  const isBnd = new Set();
  for (let i = 0; i < or.boundary.length; i += 2) isBnd.add(Math.min(or.boundary[i], or.boundary[i + 1]) * nw + Math.max(or.boundary[i], or.boundary[i + 1]));
  for (let e = 0; e < E.count; e++) {
    if (E.nt[e] !== 1) continue;
    const ca = canon[E.a[e]], cb = canon[E.b[e]];
    if (!isBnd.has(Math.min(ca, cb) * nw + Math.max(ca, cb))) continue;
    // Along the winding of its triangle.
    const t = E.t0[e];
    let a = E.a[e], b = E.b[e];
    const ia = [0, 1, 2].find((k) => T[t * 3 + k] === a);
    if (T[t * 3 + ((ia + 1) % 3)] !== b) { const x = a; a = b; b = x; }
    bnd.push(a); bnd.push(b);
    const dx = Ps[b * 3] - Ps[a * 3], dy = Ps[b * 3 + 1] - Ps[a * 3 + 1], dz = Ps[b * 3 + 2] - Ps[a * 3 + 2];
    for (const v of [a, b]) {
      const nx = Ns[v * 3], ny = Ns[v * 3 + 1], nz = Ns[v * 3 + 2];
      outward[v * 3] += dy * nz - dz * ny; outward[v * 3 + 1] += dz * nx - dx * nz; outward[v * 3 + 2] += dx * ny - dy * nx;
    }
  }
  for (let v = 0; v < ns; v++) {
    const nx = Ns[v * 3], ny = Ns[v * 3 + 1], nz = Ns[v * 3 + 2];
    let x = outward[v * 3], y = outward[v * 3 + 1], z = outward[v * 3 + 2];
    const d = x * nx + y * ny + z * nz;
    x -= d * nx; y -= d * ny; z -= d * nz;
    const l = Math.hypot(x, y, z);
    if (l > 0) { outward[v * 3] = x / l; outward[v * 3 + 1] = y / l; outward[v * 3 + 2] = z / l; }
  }

  // Per vertex copy: everything the frames need.
  const V = {
    P: new Float32Array(ns * 3), N: Ns, G: new Float32Array(ns * 3), B: new Float32Array(ns), cell: new Int32Array(ns),
    clear: new Float32Array(ns), layer: new Uint8Array(ns), ao: new Float32Array(ns * 2), rho: new Float32Array(ns), kappa: new Float32Array(ns), canon,
  };
  for (let v = 0; v < ns; v++) {
    const w = canon[v];
    for (let a = 0; a < 3; a++) { V.P[v * 3 + a] = Pw[w * 3 + a]; V.G[v * 3 + a] = G[w * 3 + a]; }
    V.B[v] = B[w];
    V.cell[v] = cell[w];
    V.clear[v] = clear[w];
    V.rho[v] = rho[w];
    V.kappa[v] = kappa[w];
    V.layer[v] = layerW[w];
    // The copy's normal may be the welded one flipped.
    const same = Ns[v * 3] * Nw[w * 3] + Ns[v * 3 + 1] * Nw[w * 3 + 1] + Ns[v * 3 + 2] * Nw[w * 3 + 2] > 0;
    V.ao[v * 2] = same ? aoTop[w] : aoBot[w];
    V.ao[v * 2 + 1] = same ? aoBot[w] : aoTop[w];
  }
  let radius = 0, radiusX = 0;
  for (let v = 0; v < nw; v++) {
    radius = Math.max(radius, Math.hypot(Pw[v * 3], Pw[v * 3 + 1], Pw[v * 3 + 2]));
    radiusX = Math.max(radiusX, Math.hypot(Pw[v * 3 + 1], Pw[v * 3 + 2]));
  }
  const st = {
    key: desc.key,
    sheet,
    L,
    lip: desc.lite ? LIP_STEPS_LITE : LIP_STEPS,
    nv: ns,
    V,
    T,
    E,
    bnd: bnd.slice(),
    outward,
    cells: { n: nc, bMax, rho: crho, rhoMean, delay, widthJitter, keep: Uint8Array.from(siteKeep), layer: cellLayer },
    layers: recipes.map((r) => ({ T: r.thick, kind: r.kind, puff: r.puff ?? 0, strut: r.strut ?? 1, cell: r.cell })),
    grid,
    scratch: {},
    times,
  };
  mark("split");
  // frame: the field's coordinates into the sculpture's (rotation R, then scale F), so a sketch of the same shape lines up.
  st.meta = { frame: base.scale ? { R, F: K / base.scale } : null, ...light(grid, desc.size), radius: radius + 0.02, radiusX: radiusX + 0.02, kind: shape.kind, layers: recipes.length, kinds: recipes.map((r) => r.kind), area, cells: nc, vertices: ns, triangles: T.length / 3, times };
  mark("light");
  progress(0.95);
  return st;
}

// Where the inner light sits: the most enclosed point clear of every wall, near the middle, with its tables.
function light(grid, size) {
  const [o, box] = grid.box;
  const wall = (x, y, z) => grid.at(x, y, z) - LIGHT_CLEAR;
  const dirs = [];
  const nd = 40;
  for (let i = 0; i < nd; i++) {
    const ph = Math.acos(1 - (2 * (i + 0.5)) / nd), th = i * 2.399963;
    dirs.push([Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)]);
  }
  const march = marcher(grid.at, grid.g, size);
  const score = (p) => {
    const c = wall(...p);
    if (c < 0.03) return -Infinity;
    let hits = 0;
    for (const d of dirs) if (march(p[0], p[1], p[2], d) >= 0) hits++;
    return hits / nd - (0.45 * Math.hypot(...p)) / size + 0.6 * Math.min(c, 0.12);
  };
  let best = null, bestScore = -Infinity;
  const M = 9;
  for (let k = 0; k < M; k++)
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        const p = [0, 1, 2].map((a) => o[a] + (box[a] - o[a]) * (0.1 + (0.8 * [i, j, k][a]) / (M - 1)));
        const s = score(p);
        if (s > bestScore) { bestScore = s; best = p; }
      }
  if (!best) best = [0, 0, 0];
  let step = Math.max(...[0, 1, 2].map((a) => (box[a] - o[a]) * 0.1));
  for (let r = 0; r < 3; r++, step *= 0.5) {
    const c = best;
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          if (!i && !j && !k) continue;
          const p = [c[0] + i * step, c[1] + j * step, c[2] + k * step];
          const s = score(p);
          if (s > bestScore) { bestScore = s; best = p; }
        }
  }
  const t = lightTables(grid.at, grid.g, size, best);
  return { interior: best, ...t, bulbRadius: Math.min(0.07, Math.max(0.015, 0.35 * t.clearance)) };
}

// Distance along d to the first wall (or the last one, with last) closer than LIGHT_CLEAR to the surface, or -1.
function marcher(at, g, size) {
  const reach = 2.4 * size;
  return (x, y, z, d, last = false) => {
    let t = 0, hit = -1;
    for (let s = 0; s < 300 && t < reach; s++) {
      const w = at(x + d[0] * t, y + d[1] * t, z + d[2] * t) - LIGHT_CLEAR;
      if (w < 0.004) {
        if (!last) return t;
        hit = t;
      }
      t += Math.max(Math.abs(w) * 0.9, 0.5 * g);
    }
    return hit;
  };
}

// For a light at p: its clearance, and how far the skin is from it in each direction (the last wall along rays
// binned by the cosine of their angle from axis), for the penumbra of what it projects. open: the share of rays
// that miss the sculpture.
function lightTables(at, g, size, p, axis = [0, 1, 0]) {
  const march = marcher(at, g, size);
  const clearance = Math.max(at(...p) - LIGHT_CLEAR, 0.02);
  const r = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const k = r[0] * axis[0] + r[1] * axis[1] + r[2] * axis[2];
  const u = [r[0] - k * axis[0], r[1] - k * axis[1], r[2] - k * axis[2]];
  const ul = Math.hypot(...u);
  for (let a = 0; a < 3; a++) u[a] /= ul;
  const v = [u[1] * axis[2] - u[2] * axis[1], u[2] * axis[0] - u[0] * axis[2], u[0] * axis[1] - u[1] * axis[0]];
  const occ = [];
  let miss = 0;
  for (let b = 0; b <= 16; b++) {
    const cyv = Math.max(-0.995, Math.min(0.995, -1 + b / 8)), sy = Math.sqrt(1 - cyv * cyv);
    let sum = 0, n = 0;
    for (let a = 0; a < 12; a++) {
      const th = (a / 12) * Math.PI * 2, c = sy * Math.cos(th), s = sy * Math.sin(th);
      const d = [0, 1, 2].map((i) => axis[i] * cyv + u[i] * c + v[i] * s);
      const t = march(p[0], p[1], p[2], d, true);
      if (t >= 0) { sum += t; n++; }
    }
    occ.push(n ? sum / n : -1);
    miss += 12 - n;
  }
  const far = Math.max(clearance + 0.05, ...occ);
  return {
    clearance,
    shell: clearance + LIGHT_CLEAR,
    occ: occ.map((v) => (v < 0 ? far : Math.max(v, clearance))),
    open: miss / (17 * 12),
  };
}

// ---------- frames ----------

// Per-cell erosion at E: the half-width w of the strut around the cell (its hole is where the border distance is
// past w), the lip radius r, and how far the hole has opened (-1 while closed). A cell first thins in its middle
// (w comes down to its largest border distance plus r), breaks through there, and widens to its final strut.
const BREAK = 0.3;
function cellState(st, E, look, out) {
  const C = st.cells;
  const grow = smoothstep(0.45, 1, E);
  for (let c = 0; c < C.n; c++) {
    const lay = st.layers[C.layer[c]];
    const bMax = C.bMax[c];
    const wNom = Math.max(1.1 * st.L, look.strut * 0.5 * lay.strut * Math.sqrt(C.rho[c] * C.rhoMean) * C.widthJitter[c]);
    const wF = Math.min(wNom, 0.62 * bMax);
    const r = Math.max(0.1, look.fillet) * wF;
    out.r[c] = r;
    out.wF[c] = wF;
    // A cell too small for a clean hole stays closed.
    if (C.keep[c] || bMax < 1.5 * wNom) {
      out.w[c] = bMax + 2 * r;
      out.open[c] = -1;
      continue;
    }
    const d = C.delay[c];
    const e = Math.min(1, Math.max(0, (E - 0.55 * d) / 0.45));
    if (e < BREAK) {
      // A shallow dimple runs ahead of the main one, so the erosion shows from the start.
      const dim = Math.max(smoothstep(0, BREAK, e), 0.5 * smoothstep(0, 0.2, E - 0.25 * d));
      out.w[c] = bMax + 1.05 * r * (1 - dim);
      out.open[c] = -1;
    } else {
      const open = 1 - (1 - (e - BREAK) / (1 - BREAK)) ** 2.2;
      out.w[c] = bMax - (bMax - wF) * open;
      out.open[c] = open;
    }
  }
  out.grow = grow;
  return out;
}

const DT = 0.02;

// Cuts the surface at erosion E and thickens it. The kept part is where s = (w - b) / r > 0 (b the vertex's border
// distance); s runs 0 at a rim to 1 where the lip meets the face. The lip is cut along isolines of s at even angles
// of a quarter round, so its profile (half-thickness t·sin θ, s = 1 - cos θ) is sampled finely whatever the mesh.
// Open edges of a sheet get a half-round bead. Normals are analytic: the face normal tilted by the slope of the
// profile along the border distance's gradient.
function mesh(st, E, look, { ao = true } = {}) {
  const t0 = performance.now();
  const V = st.V, nv = st.nv, C = st.cells, nc = C.n;
  const KL = st.lip, KL1 = KL + 1;
  const sc = st.scratch;
  if (!sc.w) {
    for (const k of ["w", "r", "open", "wF"]) { sc[k] = new Float32Array(nc); sc[k + "N"] = new Float32Array(nc); }
    sc.s = new Float32Array(nv);
    sc.sN = new Float32Array(nv);
    sc.top = new Int32Array(nv).fill(-1);
    sc.bot = new Int32Array(nv).fill(-1);
    sc.iso = new Int32Array(st.E.count * KL1 * 2).fill(-1);
    sc.isoTouched = new Buf(Int32Array);
    sc.bead = new Int32Array(nv * (BEAD_STEPS - 1)).fill(-1);
    sc.sig = new Float64Array(KL1);
    for (let k = 0; k <= KL; k++) sc.sig[k] = 1 - Math.cos((k / KL) * Math.PI * 0.5);
    sc.sig[KL] = 1;
  }
  const now = cellState(st, E, look, { w: sc.w, r: sc.r, open: sc.open, wF: sc.wF });
  cellState(st, Math.min(1, E + DT), look, { w: sc.wN, r: sc.rN, open: sc.openN, wF: sc.wFN });
  const sig = sc.sig;
  const s = sc.s, sN = sc.sN;
  const { P, N, G, B, cell, clear, canon } = V;
  for (let v = 0; v < nv; v++) {
    const c = cell[v];
    if (c < 0) { s[v] = sN[v] = 9; continue; }
    s[v] = (sc.w[c] - B[v]) / sc.r[c];
    sN[v] = (sc.wN[c] - B[v]) / sc.r[c];
  }
  // Walls no thicker than the struts there are wide, so with a full fillet a strut is a round tube.
  const half = 0.5 * look.thickness, wMin = 1.1 * st.L;
  const puff = look.puff * 0.6 * now.grow;

  const pos = (sc.pos ??= new Buf(Float32Array, 1 << 20)), nrm = (sc.nrm ??= new Buf(Float32Array, 1 << 20));
  const vel = (sc.vel ??= new Buf(Float32Array, 1 << 20)), dat = (sc.dat ??= new Buf(Float32Array, 1 << 20));
  const idx = (sc.idx ??= new Buf(Uint32Array, 1 << 21));
  pos.n = nrm.n = vel.n = dat.n = idx.n = 0;
  sc.top.fill(-1);
  sc.bot.fill(-1);
  sc.bead.fill(-1);
  const iso = sc.iso;
  const touched = sc.isoTouched;
  for (let i = 0; i < touched.n; i++) iso[touched.a[i]] = -1;
  touched.n = 0;

  // One output vertex: p + side·n·h, with the profile's normal; (px..) at E + DT for the velocity.
  let nOut = 0;
  const out = (px, py, pz, nx, ny, nz, gx, gy, gz, b, sv, w, r, tv, c, side, qx, qy, qz, svN, wN, bN, aoT, aoB) => {
    const cs = 1 - Math.min(1, Math.max(0, sv)), sn = Math.sqrt(Math.max(0, 1 - cs * cs));
    const u = Math.max(0, b) / w, crown = u < 1 ? puff * (1 - u * u) : 0, cp = u < 1 ? (-2 * puff * u) / w : 0;
    const h = tv * (1 + crown) * sn;
    const k1 = side * r * sn, k2 = -tv * (cp * r * sn * sn - (1 + crown) * cs);
    let mx = k1 * nx + k2 * gx, my = k1 * ny + k2 * gy, mz = k1 * nz + k2 * gz;
    let ml = Math.hypot(mx, my, mz);
    if (ml < 1e-9) { mx = side * nx; my = side * ny; mz = side * nz; ml = 1; }
    const x = px + side * nx * h, y = py + side * ny * h, z = pz + side * nz * h;
    // Same at E + DT.
    const csN = 1 - Math.min(1, Math.max(0, svN)), snN = Math.sqrt(Math.max(0, 1 - csN * csN));
    const uN = Math.max(0, bN) / wN, crownN = uN < 1 ? puff * (1 - uN * uN) : 0;
    const hN = tv * (1 + crownN) * snN;
    pos.push3(x, y, z);
    nrm.push3(mx / ml, my / ml, mz / ml);
    vel.push3((qx + side * nx * hN - x) / DT, (qy + side * ny * hN - y) / DT, (qz + side * nz * hN - z) / DT);
    dat.reserve(4);
    // Round the lip the occlusion turns from one face's to the other's.
    const aoS = side > 0 ? aoT : aoB;
    dat.a[dat.n++] = aoS + (0.5 * (aoT + aoB) - aoS) * cs;
    dat.a[dat.n++] = c >= 0 ? C.layer[c] : 0;
    dat.a[dat.n++] = side * h;
    dat.a[dat.n++] = 0;
    return nOut++;
  };
  // Never thicker than the surface's radius of curvature, so the wall doesn't fold through itself at a pinch point.
  const thick = (v) => {
    const lay = st.layers[V.layer[v]];
    return Math.min(half * lay.T, Math.max(wMin, look.strut * 0.5 * lay.strut * Math.sqrt(V.rho[v] * C.rhoMean)), 0.42 * clear[v], 0.6 / V.kappa[v]);
  };
  const baseVertex = (v, side) => {
    const arr = side > 0 ? sc.top : sc.bot;
    if (arr[v] >= 0) return arr[v];
    const c = cell[v], o = v * 3;
    const w = c >= 0 ? sc.w[c] : 1, r = c >= 0 ? sc.r[c] : 1, wN = c >= 0 ? sc.wN[c] : 1;
    const id = out(P[o], P[o + 1], P[o + 2], N[o], N[o + 1], N[o + 2], G[o], G[o + 1], G[o + 2], B[v], s[v], w, r, thick(v), c, side, P[o], P[o + 1], P[o + 2], sN[v], wN, B[v], V.ao[v * 2], V.ao[v * 2 + 1]);
    arr[v] = id;
    return id;
  };
  const Ea = st.E.a, Eb = st.E.b;
  // A point on edge e where s = sig[k], interpolated from the edge's ends in a fixed (welded) order so both copies
  // of a seam edge land on the same spot.
  const isoVertex = (e, k, side) => {
    const slot = (e * KL1 + k) * 2 + (k === 0 || side > 0 ? 0 : 1);
    if (iso[slot] >= 0) return iso[slot];
    let a = Ea[e], b = Eb[e];
    if (canon[a] > canon[b]) { const x = a; a = b; b = x; }
    const sa = s[a], sb = s[b];
    const t = Math.min(1, Math.max(0, (sig[k] - sa) / (sb - sa)));
    const tN = Math.min(1, Math.max(0, (sig[k] - sN[a]) / (sN[b] - sN[a] || 1e-9)));
    const ia = a * 3, ib = b * 3;
    const L = (arr, o) => arr[ia + o] + (arr[ib + o] - arr[ia + o]) * t;
    const LN = (arr, o) => arr[ia + o] + (arr[ib + o] - arr[ia + o]) * tN;
    let nx = L(N, 0), ny = L(N, 1), nz = L(N, 2);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let gx = L(G, 0), gy = L(G, 1), gz = L(G, 2);
    const gd = gx * nx + gy * ny + gz * nz;
    gx -= gd * nx; gy -= gd * ny; gz -= gd * nz;
    const ca = cell[a], cb = cell[b];
    const wa = ca >= 0 ? sc.w[ca] : 1, wb = cb >= 0 ? sc.w[cb] : 1, ra = ca >= 0 ? sc.r[ca] : 1, rb = cb >= 0 ? sc.r[cb] : 1;
    const wna = ca >= 0 ? sc.wN[ca] : 1, wnb = cb >= 0 ? sc.wN[cb] : 1;
    const bb = B[a] + (B[b] - B[a]) * t, bN = B[a] + (B[b] - B[a]) * tN;
    const tv = thick(a) + (thick(b) - thick(a)) * t;
    const id = out(L(P, 0), L(P, 1), L(P, 2), nx, ny, nz, gx, gy, gz, bb, sig[k], wa + (wb - wa) * t, ra + (rb - ra) * t, tv, ca >= 0 ? ca : cb, side,
      LN(P, 0), LN(P, 1), LN(P, 2), sig[k], wna + (wnb - wna) * tN, bN,
      V.ao[a * 2] + (V.ao[b * 2] - V.ao[a * 2]) * t, V.ao[a * 2 + 1] + (V.ao[b * 2 + 1] - V.ao[a * 2 + 1]) * t);
    iso[slot] = id;
    touched.push(slot);
    return id;
  };
  // Polygon points: a vertex v (>= 0) or an iso point -(1 + e * KL1 + k).
  const top = (p) => (p >= 0 ? baseVertex(p, 1) : isoVertex(((-p - 1) / KL1) | 0, (-p - 1) % KL1, 1));
  const bot = (p) => (p >= 0 ? baseVertex(p, -1) : isoVertex(((-p - 1) / KL1) | 0, (-p - 1) % KL1, -1));
  const sOf = (p) => (p >= 0 ? s[p] : sig[(-p - 1) % KL1]);
  const emit = (poly, n) => {
    const t0 = top(poly[0]), b0 = bot(poly[0]);
    for (let m = 1; m + 1 < n; m++) {
      const t1 = top(poly[m]), t2 = top(poly[m + 1]);
      const b1 = bot(poly[m]), b2 = bot(poly[m + 1]);
      idx.reserve(6);
      const I = idx.a;
      let q = idx.n;
      I[q++] = t0; I[q++] = t1; I[q++] = t2;
      I[q++] = b0; I[q++] = b2; I[q++] = b1;
      idx.n = q;
    }
  };
  const T = st.T, triEdge = st.E.triEdge, nt = T.length / 3;
  const polyA = new Int32Array(12), polyB = new Int32Array(12), lower = new Int32Array(12);
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const sa = s[a], sb = s[b], sc2 = s[c];
    if (sa >= 1 && sb >= 1 && sc2 >= 1) {
      const ta = baseVertex(a, 1), tb = baseVertex(b, 1), tc = baseVertex(c, 1);
      const ba = baseVertex(a, -1), bb = baseVertex(b, -1), bc = baseVertex(c, -1);
      idx.reserve(6);
      const I = idx.a;
      let q = idx.n;
      I[q++] = ta; I[q++] = tb; I[q++] = tc;
      I[q++] = ba; I[q++] = bc; I[q++] = bb;
      idx.n = q;
      continue;
    }
    if (sa < 0 && sb < 0 && sc2 < 0) continue;
    // Clip the triangle into bands between successive isolines.
    let poly = polyA, other = polyB, n = 3;
    poly[0] = a; poly[1] = b; poly[2] = c;
    for (let k = 0; k <= KL && n >= 3; k++) {
      const sk = sig[k];
      let nu = 0, nl = 0;
      for (let m = 0; m < n; m++) {
        const X = poly[m], Y = poly[(m + 1) % n];
        const sX = sOf(X), sY = sOf(Y);
        if (sX < sk) lower[nl++] = X;
        else other[nu++] = X;
        if (sX < sk !== sY < sk) {
          let e;
          if (X < 0) e = ((-X - 1) / KL1) | 0;
          else if (Y < 0) e = ((-Y - 1) / KL1) | 0;
          else {
            const side = (X === a && Y === b) || (X === b && Y === a) ? 0 : (X === b && Y === c) || (X === c && Y === b) ? 1 : 2;
            e = triEdge[t * 3 + side];
          }
          const p = -(1 + e * KL1 + k);
          lower[nl++] = p;
          other[nu++] = p;
        }
      }
      if (k > 0 && nl >= 3) emit(lower, nl);
      const sw = poly;
      poly = other;
      other = sw;
      n = nu;
    }
    if (n >= 3) emit(poly, n);
  }

  // Beads along a sheet's open edges: a half round from the top face to the bottom one.
  const bnd = st.bnd, M = BEAD_STEPS;
  const beadVertex = (v, i) => {
    const slot = v * (M - 1) + i - 1;
    if (sc.bead[slot] >= 0) return sc.bead[slot];
    const o = v * 3, c = cell[v];
    const w = c >= 0 ? sc.w[c] : 1, wN = c >= 0 ? sc.wN[c] : 1;
    const sv = Math.min(1, Math.max(0, s[v])), svN = Math.min(1, Math.max(0, sN[v]));
    const u = Math.max(0, B[v]) / w, crown = u < 1 ? puff * (1 - u * u) : 0;
    const uN = Math.max(0, B[v]) / wN, crownN = uN < 1 ? puff * (1 - uN * uN) : 0;
    const tv = thick(v);
    const h = tv * (1 + crown) * Math.sqrt(Math.max(0, 1 - (1 - sv) ** 2));
    const hN = tv * (1 + crownN) * Math.sqrt(Math.max(0, 1 - (1 - svN) ** 2));
    const ph = (Math.PI * i) / M, cp = Math.cos(ph), sp = Math.sin(ph);
    const m = st.outward;
    const dx = N[o] * cp + m[o] * sp, dy = N[o + 1] * cp + m[o + 1] * sp, dz = N[o + 2] * cp + m[o + 2] * sp;
    pos.push3(P[o] + dx * h, P[o + 1] + dy * h, P[o + 2] + dz * h);
    nrm.push3(dx, dy, dz);
    vel.push3((dx * (hN - h)) / DT, (dy * (hN - h)) / DT, (dz * (hN - h)) / DT);
    dat.reserve(4);
    dat.a[dat.n++] = V.ao[v * 2] + (V.ao[v * 2 + 1] - V.ao[v * 2]) * (0.5 - 0.5 * cp);
    dat.a[dat.n++] = c >= 0 ? C.layer[c] : 0;
    dat.a[dat.n++] = h * cp;
    dat.a[dat.n++] = 0;
    sc.bead[slot] = nOut;
    return nOut++;
  };
  for (let i = 0; i < bnd.length; i += 2) {
    const a = bnd[i], b = bnd[i + 1];
    if (s[a] <= 0 || s[b] <= 0) continue;
    let pa = baseVertex(a, 1), pb = baseVertex(b, 1);
    for (let k = 1; k <= M; k++) {
      const na = k === M ? baseVertex(a, -1) : beadVertex(a, k), nb = k === M ? baseVertex(b, -1) : beadVertex(b, k);
      idx.reserve(6);
      const I = idx.a;
      let q = idx.n;
      I[q++] = pa; I[q++] = na; I[q++] = pb;
      I[q++] = pb; I[q++] = na; I[q++] = nb;
      idx.n = q;
      pa = na;
      pb = nb;
    }
  }

  const res = {
    position: pos.slice(),
    normal: nrm.slice(),
    vel: vel.slice(),
    data: dat.slice(),
    index: idx.slice(),
    E,
    meta: st.meta,
  };
  // The main thread keeps the light clear of the walls with the distance grid; it comes with the closed skin.
  if (E === 0) res.lightGrid = st.grid.data;
  res.cutMs = performance.now() - t0;
  return res;
}

export { vnoise, principalAxes, prepare, mesh, MODES, lightField, lightTables, distanceGrid, LIGHT_CLEAR };
