// Bakes Suzanne's mesh and UV atlas for day 23 (23/suzanne-mesh.bin): the Loop-subdivided head (level 3, its vertices
// moved to level 4), upright in the units of assets/suzanne-sdf-96.bin, cut into near-planar charts (variational shape
// approximation on face normals), each projected onto its plane at one texel density and packed into the 3:2 atlas
// with a gutter, plus a skirt around every chart that extrapolates it into the gutter for the bake.
// usage: node 23/tools/suzanne-mesh.mjs [out=23/suzanne-mesh.bin]
import { register } from "node:module";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const LEVEL = 3;
// Same framing as tools/suzanne-sdf.mjs (level 2 bounds, dilated radius), tilted back to face ahead (meshData.js SUZ_TILT)
const DILATE = 0.015;
const TILT = -0.37;
// Charts: no face further than this from its chart's plane
const MAX_ANGLE = +(process.env.ANG ?? 32);
// Atlas, in texels at the smallest map (face 512, atlas 1536x1024): skirt width, extra gap, packing cell
const F = 512;
const SKIRT = 5;
const MARGIN = 1;
const CELL = 2;

const three = new URL("third_party/three.module.js", root).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === "three" ? { url: ${JSON.stringify(three)}, shortCircuit: true } : next(s, c); }`)}`);
const { suzanneGeometry } = await import(new URL("modules/suzanne/suzanneMesh.js", root).href);
const objText = fs.readFileSync(new URL("assets/suzanne.obj", root), "utf8");
const out = process.argv[2] ?? new URL("23/suzanne-mesh.bin", root).pathname;

// ── Mesh ───────────────────────────────────────────────────────────────────────────────────────────────────────
const g2 = suzanneGeometry(objText, 2).attributes.position.array;
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < g2.length; i += 3) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], g2[i + a])), (hi[a] = Math.max(hi[a], g2[i + a]));
const centre = lo.map((l, a) => (l + hi[a]) / 2);
let rMax = 0;
for (let i = 0; i < g2.length; i += 3) rMax = Math.max(rMax, Math.hypot(g2[i] - centre[0], g2[i + 1] - centre[1], g2[i + 2] - centre[2]));
const scale = (1 - DILATE) / rMax;
const ct = Math.cos(TILT), st = Math.sin(TILT);

const g3 = suzanneGeometry(objText, LEVEL);
const g4 = suzanneGeometry(objText, LEVEL + 1);
const tris = Uint32Array.from(g3.index.array);
const nPos = g3.attributes.position.count;
const nTri = tris.length / 3;
// Loop keeps the old vertices first, so level 3's vertex i is level 4's vertex i, nearer the limit surface
const P = new Float64Array(nPos * 3);
const toUpright = (src, i, dst, j) => {
  const x = (src[i] - centre[0]) * scale, y = (src[i + 1] - centre[1]) * scale, z = (src[i + 2] - centre[2]) * scale;
  dst[j] = x;
  dst[j + 1] = y * ct - z * st;
  dst[j + 2] = y * st + z * ct;
};
const p4 = g4.attributes.position.array;
for (let i = 0; i < nPos; i++) toUpright(p4, i * 3, P, i * 3);
// Vertex normals from level 4's faces (area weighted)
const N = new Float64Array(nPos * 3);
{
  const n4 = g4.attributes.position.count;
  const Q = new Float64Array(n4 * 3);
  for (let i = 0; i < n4; i++) toUpright(p4, i * 3, Q, i * 3);
  const NN = new Float64Array(n4 * 3);
  const t4 = g4.index.array;
  for (let t = 0; t < t4.length; t += 3) {
    const a = t4[t] * 3, b = t4[t + 1] * 3, c = t4[t + 2] * 3;
    const ux = Q[b] - Q[a], uy = Q[b + 1] - Q[a + 1], uz = Q[b + 2] - Q[a + 2];
    const vx = Q[c] - Q[a], vy = Q[c + 1] - Q[a + 1], vz = Q[c + 2] - Q[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) (NN[v] += nx), (NN[v + 1] += ny), (NN[v + 2] += nz);
  }
  for (let i = 0; i < nPos; i++) {
    const l = Math.hypot(NN[i * 3], NN[i * 3 + 1], NN[i * 3 + 2]) || 1;
    for (let a = 0; a < 3; a++) N[i * 3 + a] = NN[i * 3 + a] / l;
  }
}

// Faces: normal, area, neighbours across each edge (-1 on the open rims of the eyes)
const fN = new Float64Array(nTri * 3), fA = new Float64Array(nTri);
const adj = new Int32Array(nTri * 3).fill(-1);
{
  const edges = new Map();
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    fA[t] = l / 2;
    fN[t * 3] = nx / l;
    fN[t * 3 + 1] = ny / l;
    fN[t * 3 + 2] = nz / l;
    for (let e = 0; e < 3; e++) {
      const i = tris[t * 3 + e], j = tris[t * 3 + ((e + 1) % 3)];
      const k = i < j ? i * nPos + j : j * nPos + i;
      const other = edges.get(k);
      if (other === undefined) edges.set(k, t * 3 + e);
      else {
        adj[t * 3 + e] = Math.floor(other / 3);
        adj[other] = t;
      }
    }
  }
}
let totalArea = 0;
for (let t = 0; t < nTri; t++) totalArea += fA[t];
console.log(`level ${LEVEL}: ${nPos} vertices, ${nTri} triangles, area ${totalArea.toFixed(3)}`);

// ── Charts: variational shape approximation (L2,1), adding proxies until every face is within MAX_ANGLE ──────────
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

const cost = (t, px, py, pz) => {
  const dx = fN[t * 3] - px, dy = fN[t * 3 + 1] - py, dz = fN[t * 3 + 2] - pz;
  return fA[t] * (dx * dx + dy * dy + dz * dz);
};
const label = new Int32Array(nTri);
let proxies = []; // { n: [x,y,z], seed }

function partition() {
  label.fill(-1);
  const heap = new Heap();
  proxies.forEach((p, i) => {
    label[p.seed] = i;
    for (let e = 0; e < 3; e++) {
      const nb = adj[p.seed * 3 + e];
      if (nb >= 0) heap.push(cost(nb, ...p.n), nb * 4096 + i);
    }
  });
  while (heap.size) {
    const x = heap.pop();
    const t = Math.floor(x / 4096), i = x % 4096;
    if (label[t] >= 0) continue;
    label[t] = i;
    for (let e = 0; e < 3; e++) {
      const nb = adj[t * 3 + e];
      if (nb >= 0 && label[nb] < 0) heap.push(cost(nb, ...proxies[i].n), nb * 4096 + i);
    }
  }
  // Faces no flood reached (none on a connected mesh) join their own new proxy
  for (let t = 0; t < nTri; t++) if (label[t] < 0) { proxies.push({ n: [fN[t * 3], fN[t * 3 + 1], fN[t * 3 + 2]], seed: t }); return partition(); }
}

function fit() {
  const sums = proxies.map(() => [0, 0, 0]);
  for (let t = 0; t < nTri; t++) for (let a = 0; a < 3; a++) sums[label[t]][a] += fN[t * 3 + a] * fA[t];
  proxies.forEach((p, i) => {
    const l = Math.hypot(...sums[i]) || 1;
    p.n = sums[i].map((v) => v / l);
  });
  const best = proxies.map(() => [Infinity, -1]);
  for (let t = 0; t < nTri; t++) {
    const i = label[t], c = cost(t, ...proxies[i].n) / fA[t];
    if (c < best[i][0]) best[i] = [c, t];
  }
  proxies.forEach((p, i) => (p.seed = best[i][1] >= 0 ? best[i][1] : p.seed));
}

const cosMax = Math.cos((MAX_ANGLE * Math.PI) / 180);
function worst() {
  // Per proxy: its face furthest from its plane
  const w = proxies.map(() => [1, -1]);
  for (let t = 0; t < nTri; t++) {
    const i = label[t];
    const d = fN[t * 3] * proxies[i].n[0] + fN[t * 3 + 1] * proxies[i].n[1] + fN[t * 3 + 2] * proxies[i].n[2];
    if (d < w[i][0]) w[i] = [d, t];
  }
  return w;
}

// Seeds spread by farthest-point sampling over face centroids
{
  const cen = new Float64Array(nTri * 3);
  for (let t = 0; t < nTri; t++) for (let a = 0; a < 3; a++) cen[t * 3 + a] = (P[tris[t * 3] * 3 + a] + P[tris[t * 3 + 1] * 3 + a] + P[tris[t * 3 + 2] * 3 + a]) / 3;
  const dist = new Float64Array(nTri).fill(Infinity);
  let s = 0;
  for (let k = 0; k < 16; k++) {
    proxies.push({ n: [fN[s * 3], fN[s * 3 + 1], fN[s * 3 + 2]], seed: s });
    let far = 0;
    for (let t = 0; t < nTri; t++) {
      dist[t] = Math.min(dist[t], Math.hypot(cen[t * 3] - cen[s * 3], cen[t * 3 + 1] - cen[s * 3 + 1], cen[t * 3 + 2] - cen[s * 3 + 2]));
      if (dist[t] > dist[far]) far = t;
    }
    s = far;
  }
}
for (let round = 0; ; round++) {
  for (let it = 0; it < 12; it++) {
    partition();
    fit();
  }
  partition();
  const w = worst();
  const bad = w.map(([d, t], i) => ({ d, t, i })).filter((x) => x.d < cosMax);
  if (!bad.length) break;
  // Split the worst regions first
  bad.sort((a, b) => a.d - b.d);
  for (const { t } of bad.slice(0, Math.max(1, Math.ceil(bad.length / 2)))) proxies.push({ n: [fN[t * 3], fN[t * 3 + 1], fN[t * 3 + 2]], seed: t });
  if (round > 60) throw new Error("charting did not converge");
}
console.log(`${proxies.length} charts within ${MAX_ANGLE}°`);

// Clean-up: charts merge into a neighbour (smallest first) while the merged chart stays within MAX_ANGLE of its mean
// normal; charts still small then hand their faces one by one to neighbours that can take them
{
  const K = proxies.length;
  const members = Array.from({ length: K }, () => []);
  for (let t = 0; t < nTri; t++) members[label[t]].push(t);
  const sum = members.map((fs) => fs.reduce((s, t) => [0, 1, 2].map((a) => s[a] + fN[t * 3 + a] * fA[t]), [0, 0, 0]));
  const area = members.map((fs) => fs.reduce((s, t) => s + fA[t], 0));
  const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const fits = (faces, n) => faces.every((t) => fN[t * 3] * n[0] + fN[t * 3 + 1] * n[1] + fN[t * 3 + 2] * n[2] >= cosMax);
  const neighbours = (L) => {
    const s = new Set();
    for (const t of members[L]) for (let e = 0; e < 3; e++) { const nb = adj[t * 3 + e]; if (nb >= 0 && label[nb] !== L) s.add(label[nb]); }
    return [...s];
  };
  let merged = true;
  while (merged) {
    merged = false;
    const order = [...members.keys()].filter((L) => members[L].length).sort((a, b) => area[a] - area[b]);
    for (const L of order) {
      if (!members[L].length) continue;
      for (const M of neighbours(L).sort((a, b) => area[b] - area[a])) {
        const n = unit(sum[L].map((v, a) => v + sum[M][a]));
        if (!fits(members[L], n) || !fits(members[M], n)) continue;
        for (const t of members[L]) label[t] = M;
        members[M].push(...members[L]);
        members[L] = [];
        sum[M] = sum[M].map((v, a) => v + sum[L][a]);
        area[M] += area[L];
        merged = true;
        break;
      }
    }
  }
  // Moves face t from its chart to M when both charts still fit afterwards
  const move = (t, M) => {
    const L = label[t];
    const sL = sum[L].map((v, a) => v - fN[t * 3 + a] * fA[t]), sM = sum[M].map((v, a) => v + fN[t * 3 + a] * fA[t]);
    const restL = members[L].filter((f) => f !== t);
    if (restL.length && !fits(restL, unit(sL))) return false;
    if (!fits([t], unit(sM)) || !fits(members[M], unit(sM))) return false;
    label[t] = M;
    members[L] = restL;
    members[M].push(t);
    sum[L] = sL;
    sum[M] = sM;
    area[L] -= fA[t];
    area[M] += fA[t];
    return true;
  };
  // Small charts hand their faces to neighbours; then ragged borders are smoothed: a face goes over to the chart
  // that holds two of its neighbours
  const small = totalArea * 0.002;
  for (const L of [...members.keys()].filter((L) => members[L].length && area[L] < small)) {
    for (let pass = 0; pass < 50 && members[L].length; pass++) {
      let moved = false;
      for (const t of members[L].slice()) {
        const cands = [0, 1, 2].map((e) => adj[t * 3 + e]).filter((nb) => nb >= 0 && label[nb] !== L).map((nb) => label[nb]);
        for (const M of cands) if (move(t, M)) { moved = true; break; }
      }
      if (!moved) break;
    }
  }
  for (let pass = 0; pass < 8; pass++) {
    let moved = 0;
    for (let t = 0; t < nTri; t++) {
      const nbs = [0, 1, 2].map((e) => adj[t * 3 + e]).filter((nb) => nb >= 0).map((nb) => label[nb]);
      const L = label[t];
      const M = nbs.find((m, i) => m !== L && nbs.indexOf(m) !== i);
      if (M !== undefined && nbs.filter((m) => m === L).length === 0 || (M !== undefined && nbs.filter((m) => m === M).length >= 2)) {
        if (move(t, M)) moved++;
      }
    }
    if (!moved) break;
  }
  // Compact, with each chart's normal its area-weighted mean
  const live = [...members.keys()].filter((L) => members[L].length);
  const remap = new Map(live.map((L, i) => [L, i]));
  for (let t = 0; t < nTri; t++) label[t] = remap.get(label[t]);
  proxies = live.map((L) => ({ n: unit(sum[L]) }));
  console.log(`${proxies.length} charts after merging`);
}
{ const ar = proxies.map(() => 0); for (let t = 0; t < nTri; t++) ar[label[t]] += fA[t]; ar.sort((a, b) => a - b); console.log("chart areas pct", [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((q) => ar[Math.min(ar.length - 1, Math.floor(q * ar.length))].toFixed(4)).join(" ")); if (process.env.ONLYCHART) { const info = proxies.map(() => ({ a: 0, c: [0, 0, 0], n: 0 })); for (let t = 0; t < nTri; t++) { const I = info[label[t]]; I.a += fA[t]; I.n++; for (let a = 0; a < 3; a++) I.c[a] += P[tris[t * 3 + a] * 3 + a] ; } info.filter((I) => I.a < 0.002).forEach((I) => console.log(I.n, I.a.toFixed(5), I.c.map((v) => (v / I.n).toFixed(2)).join(","))); process.exit(0); } }

// ── Per chart: split vertices, planar coordinates turned to their tightest bounding box ───────────────────────────────
const charts = proxies.map((p, i) => ({ i, n: p.n, faces: [] }));
for (let t = 0; t < nTri; t++) charts[label[t]].faces.push(t);

function convexHull(pts) {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of s) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

for (const ch of charts) {
  const [nx, ny, nz] = ch.n;
  // Any basis of the plane, then rotated to the hull's minimum-area box
  let ux = 0, uy = 0, uz = 0;
  if (Math.abs(ny) < 0.9) [ux, uy, uz] = [nz, 0, -nx]; else [ux, uy, uz] = [0, -nz, ny];
  let l = Math.hypot(ux, uy, uz);
  ux /= l; uy /= l; uz /= l;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  ch.vmap = new Map();
  ch.verts = [];
  for (const t of ch.faces) for (let e = 0; e < 3; e++) {
    const v = tris[t * 3 + e];
    if (!ch.vmap.has(v)) {
      ch.vmap.set(v, ch.verts.length);
      ch.verts.push(v);
    }
  }
  const pts = ch.verts.map((v) => [P[v * 3] * ux + P[v * 3 + 1] * uy + P[v * 3 + 2] * uz, P[v * 3] * vx + P[v * 3 + 1] * vy + P[v * 3 + 2] * vz]);
  const hull = convexHull(pts);
  let best = { area: Infinity, a: 0 };
  for (let k = 0; k < hull.length; k++) {
    const p = hull[k], q = hull[(k + 1) % hull.length];
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c + y * s, ry = -x * s + y * c;
      x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area) best = { area, a, w: x1 - x0, h: y1 - y0 };
  }
  let c = Math.cos(best.a), s = Math.sin(best.a);
  // World axes of the chart's x and y (right-handed with its normal)
  ch.ax = [ux * c + vx * s, uy * c + vy * s, uz * c + vz * s];
  ch.ay = [-ux * s + vx * c, -uy * s + vy * c, -uz * s + vz * c];
  ch.xy = ch.verts.map((v) => [P[v * 3] * ch.ax[0] + P[v * 3 + 1] * ch.ax[1] + P[v * 3 + 2] * ch.ax[2], P[v * 3] * ch.ay[0] + P[v * 3 + 1] * ch.ay[1] + P[v * 3 + 2] * ch.ay[2]]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ch.xy) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  ch.box = [x0, y0, x1, y1];
  ch.area = ch.faces.reduce((a, t) => a + fA[t], 0);
  // Projected faces keep their winding (all within MAX_ANGLE of the normal)
  for (const t of ch.faces) {
    const [a, b, cc] = [0, 1, 2].map((e) => ch.xy[ch.vmap.get(tris[t * 3 + e])]);
    if ((b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0]) <= 0) throw new Error("flipped face");
  }
  // Boundary edges, directed as in their face (the chart's inside on their left)
  ch.boundary = [];
  for (const t of ch.faces) for (let e = 0; e < 3; e++) {
    const nb = adj[t * 3 + e];
    if (nb < 0 || label[nb] !== ch.i) ch.boundary.push([tris[t * 3 + e], tris[t * 3 + ((e + 1) % 3)]]);
  }
}

// Overlap check: rasterise each chart's faces on a fine grid; a cell covered twice means the projection folds over
function rasterize(points, triangles, cell, onCell) {
  for (const [a, b, c] of triangles) {
    const A = points[a], B = points[b], C = points[c];
    const x0 = Math.floor(Math.min(A[0], B[0], C[0]) / cell), x1 = Math.floor(Math.max(A[0], B[0], C[0]) / cell);
    const y0 = Math.floor(Math.min(A[1], B[1], C[1]) / cell), y1 = Math.floor(Math.max(A[1], B[1], C[1]) / cell);
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
      const w0 = (B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px);
      const w1 = (C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px);
      const w2 = area - w0 - w1;
      if (w0 > 1e-12 && w1 > 1e-12 && w2 > 1e-12) onCell(x, y);
    }
  }
}
let overlaps = 0;
for (const ch of charts) {
  const seen = new Set();
  const local = ch.xy.map(([x, y]) => [x - ch.box[0], y - ch.box[1]]);
  rasterize(local, ch.faces.map((t) => [0, 1, 2].map((e) => ch.vmap.get(tris[t * 3 + e]))), 0.002, (x, y) => {
    const k = y * 100000 + x;
    if (seen.has(k)) overlaps++;
    seen.add(k);
  });
}
if (overlaps) throw new Error(`${overlaps} overlapping cells`);

// ── Packing: chart footprints (dilated by skirt + margin) placed bottom-left on a grid, at the largest scale that fits ──
const GW = (3 * F) / CELL, GH = (2 * F) / CELL;
const dil = Math.ceil((SKIRT + MARGIN) / CELL);

function footprint(ch, s, rot) {
  // Atlas units (1 = F texels) at scale s; rot turns it a quarter
  const pts = ch.xy.map(([x, y]) => {
    const px = (x - ch.box[0]) * s, py = (y - ch.box[1]) * s;
    return rot ? [(ch.box[3] - ch.box[1]) * s - py, px] : [px, py];
  });
  const w = rot ? ch.box[3] - ch.box[1] : ch.box[2] - ch.box[0];
  const h = rot ? ch.box[2] - ch.box[0] : ch.box[3] - ch.box[1];
  const cw = Math.ceil((w * s * F) / CELL) + 1 + 2 * dil, chh = Math.ceil((h * s * F) / CELL) + 1 + 2 * dil;
  const mask = new Uint8Array(cw * chh);
  const cellA = CELL / F;
  const shifted = pts.map(([x, y]) => [x + dil * cellA, y + dil * cellA]);
  // Conservative: every cell a face touches (corners included), then dilated
  const tri = ch.faces.map((t) => [0, 1, 2].map((e) => ch.vmap.get(tris[t * 3 + e])));
  for (const [a, b, c] of tri) {
    const A = shifted[a], B = shifted[b], C = shifted[c];
    for (const p of [A, B, C]) mask[Math.floor(p[1] / cellA) * cw + Math.floor(p[0] / cellA)] = 1;
  }
  rasterize(shifted, tri, cellA / 2, (x, y) => (mask[(y >> 1) * cw + (x >> 1)] = 1));
  const grown = new Uint8Array(cw * chh);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    if (!mask[y * cw + x]) continue;
    for (let dy = -dil; dy <= dil; dy++) for (let dx = -dil; dx <= dil; dx++) {
      if (dx * dx + dy * dy > (dil + 0.5) ** 2) continue;
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < cw && Y < chh) grown[Y * cw + X] = 1;
    }
  }
  // Row spans
  const rows = [];
  for (let y = 0; y < chh; y++) {
    const spans = [];
    for (let x = 0; x < cw; x++) {
      if (!grown[y * cw + x]) continue;
      let e = x;
      while (e + 1 < cw && grown[y * cw + e + 1]) e++;
      spans.push([x, e]);
      x = e;
    }
    rows.push(spans);
  }
  return { cw, ch: chh, rows, cells: grown.reduce((a, b) => a + b, 0) };
}

function pack(s) {
  const occ = Array.from({ length: GH }, () => new Uint8Array(GW));
  const pre = Array.from({ length: GH }, () => new Int32Array(GW + 1));
  const order = charts.map((ch) => ({ ch, fp: [footprint(ch, s, false), footprint(ch, s, true)] })).sort((a, b) => b.fp[0].cells - a.fp[0].cells);
  const placed = [];
  for (const { ch, fp } of order) {
    let best = null;
    for (let rot = 0; rot < 2; rot++) {
      const f = fp[rot];
      if (f.cw > GW || f.ch > GH) continue;
      search: for (let y = 0; y + f.ch <= GH; y++) {
        if (best && y + f.ch >= best.top) break;
        for (let x = 0; x + f.cw <= GW; x++) {
          let ok = true;
          for (let r = 0; r < f.ch && ok; r++) {
            const p = pre[y + r];
            for (const [a, b] of f.rows[r]) if (p[x + b + 1] - p[x + a] > 0) { ok = false; break; }
          }
          if (ok) {
            if (!best || y + f.ch < best.top || (y + f.ch === best.top && x < best.x)) best = { x, y, rot, top: y + f.ch, f };
            break search;
          }
        }
      }
    }
    if (!best) return null;
    const { x, y, f } = best;
    for (let r = 0; r < f.ch; r++) {
      for (const [a, b] of f.rows[r]) occ[y + r].fill(1, x + a, x + b + 1);
      const p = pre[y + r], o = occ[y + r];
      for (let i = 0; i < GW; i++) p[i + 1] = p[i] + o[i];
    }
    placed.push({ ch, ...best });
  }
  return placed;
}

let sLo = 0.2 * Math.sqrt(6 / totalArea), sHi = Math.sqrt(6 / totalArea), layout = null;
for (let it = 0; it < 14; it++) {
  const s = (sLo + sHi) / 2;
  const res = pack(s);
  if (res) (sLo = s), (layout = res);
  else sHi = s;
}
if (!layout) throw new Error("packing failed");
const S = sLo;
console.log(`atlas scale ${S.toFixed(4)} atlas units per unit: ${(totalArea * S * S / 6 * 100).toFixed(1)}% of the atlas covered`);

// ── Split vertices (one per chart corner) and their atlas positions ───────────────────────────────────────────────
const verts = []; // { pos, a: atlas units, chart }
const outTris = [];
for (const pl of layout) {
  const { ch, x, y, rot } = pl;
  const cellA = CELL / F;
  const ox = (x + dil) * cellA, oy = (y + dil) * cellA;
  const toAtlas = ([px, py]) => {
    const lx = (px - ch.box[0]) * S, ly = (py - ch.box[1]) * S;
    return rot ? [ox + (ch.box[3] - ch.box[1]) * S - ly, oy + lx] : [ox + lx, oy + ly];
  };
  // World axes along atlas x and y
  ch.axX = rot ? ch.ay.map((v) => -v) : ch.ax;
  ch.axY = rot ? ch.ax : ch.ay;
  ch.atlas = ch.xy.map(toAtlas);
  ch.base = verts.length;
  ch.verts.forEach((v, k) => verts.push({ pos: v, a: ch.atlas[k], chart: ch.i }));
  for (const t of ch.faces) outTris.push(...[0, 1, 2].map((e) => ch.base + ch.vmap.get(tris[t * 3 + e])));
}
const nVert = verts.length;
console.log(`${nVert} split vertices (${nVert - nPos} on seams)`);
if (nVert > 65535) throw new Error("too many vertices for 16-bit indices");

// ── Stats: stretch of the planar projection (its singular values are 1 and cos of the face's tilt) ────────────────
{
  let wSum = 0, cosSum = 0, cosMin = 1;
  const hist = [0, 0, 0, 0];
  for (const ch of charts) for (const t of ch.faces) {
    const c = fN[t * 3] * ch.n[0] + fN[t * 3 + 1] * ch.n[1] + fN[t * 3 + 2] * ch.n[2];
    wSum += fA[t];
    cosSum += fA[t] * c;
    cosMin = Math.min(cosMin, c);
    hist[c > 0.98 ? 0 : c > 0.95 ? 1 : c > 0.9 ? 2 : 3] += fA[t];
  }
  const pct = (v) => ((v / wSum) * 100).toFixed(1) + "%";
  console.log(`stretch (max/min singular value): area-weighted mean ${(wSum / cosSum).toFixed(3)}, worst ${(1 / cosMin).toFixed(3)}; ` +
    `by area: <1.02 ${pct(hist[0])}, 1.02-1.05 ${pct(hist[1])}, 1.05-1.11 ${pct(hist[2])}, >1.11 ${pct(hist[3])}`);
  console.log(`texel: ${(1 / (S * 512)).toFixed(5)} units at face 512, ${(1 / (S * 1024)).toFixed(5)} at 1024`);
}

// ── Write ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// u32 magic, positions, vertices, triangles, charts; f32 box min (3), box size (3), atlas units per unit, skirt width
// (atlas units); u16x3 positions (quantised in the box), i16x3 normals; per vertex u16 position index, u16 chart,
// u16x2 uv; per chart f32x3 x2 world axes along atlas u and v; u16x3 triangles. Blocks padded to 4 bytes.
const blo = [Infinity, Infinity, Infinity], bhi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nPos * 3; i++) (blo[i % 3] = Math.min(blo[i % 3], P[i])), (bhi[i % 3] = Math.max(bhi[i % 3], P[i]));
const size = blo.map((l, a) => bhi[a] - l);
const pq = new Uint16Array(nPos * 3), nq = new Int16Array(nPos * 3);
for (let i = 0; i < nPos * 3; i++) {
  pq[i] = Math.round(((P[i] - blo[i % 3]) / size[i % 3]) * 65535);
  nq[i] = Math.round(Math.max(-1, Math.min(1, N[i])) * 32767);
}
const vp = new Uint16Array(nVert), vc = new Uint16Array(nVert), vuv = new Uint16Array(nVert * 2);
verts.forEach((v, i) => {
  vp[i] = v.pos;
  vc[i] = v.chart;
  vuv[i * 2] = Math.round((v.a[0] / 3) * 65535);
  vuv[i * 2 + 1] = Math.round((v.a[1] / 2) * 65535);
});
const ca = new Float32Array(charts.length * 6);
charts.forEach((ch) => ca.set([...ch.axX, ...ch.axY], ch.i * 6));
const parts = [
  new Uint32Array([0x315a5553, nPos, nVert, outTris.length / 3, charts.length]),
  new Float32Array([...blo, ...size, S, SKIRT / F]),
  pq, nq, vp, vc, vuv, ca, Uint16Array.from(outTris),
];
const bytes = Buffer.concat(parts.map((p) => {
  const b = Buffer.from(p.buffer, p.byteOffset, p.byteLength);
  return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
}));
fs.writeFileSync(out, bytes);
console.log(`wrote ${out}: ${(bytes.length / 1024).toFixed(0)} KB`);

// Optional preview of the charts in the atlas: node suzanne-mesh.mjs out.bin preview.pgm
if (process.argv[3]) {
  const W = 3 * F, H = 2 * F, img = new Uint8Array(W * H);
  const pts = verts.map((v) => [v.a[0] * F, v.a[1] * F]);
  for (const ch of charts) rasterize(pts, ch.faces.map((t) => [0, 1, 2].map((e) => ch.base + ch.vmap.get(tris[t * 3 + e]))), 1, (x, y) => {
    if (x >= 0 && y >= 0 && x < W && y < H) img[(H - 1 - y) * W + x] = 120 + ((ch.i * 37) % 130);
  });
  fs.writeFileSync(process.argv[3], Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), Buffer.from(img)]));
}
