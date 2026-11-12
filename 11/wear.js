// Chamfers, wear and pits shared by gears.js and escapement.js. Every effect only removes material.
//
// A wall is a closed 2D loop swept along an axis. Its ends get a "cap profile": rows of the loop inset toward the
// solid (along each vertex's miter) at increasing depth from the cap, a flat 45 degree bevel for a chamfer, a rounded
// band of irregular width when eroded, plus the occasional chip at a sharp corner. Eroded loops also have their convex
// corners worn round, and flat faces get shallow pits (stitched in locally, so the rest of the mesh keeps its triangles).
import { ShapeUtils, Vector2 } from "three";

const TAU = Math.PI * 2;
export const DEFAULT_CHAMFER = 0.12; // in modules (the builder's length scale)

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(a, b) {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const noise = (seed, x) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hash(seed, i) * (1 - u) + hash(seed, i + 1) * u) / 4294967296;
};
const fbm = (seed, x) => 0.65 * noise(seed, x) + 0.35 * noise(seed + 101, 2.7 * x + 0.5);

/**
 * Resolves a builder's { chamfer, erosion } against its length scale (its module). chamfer: true = DEFAULT_CHAMFER *
 * scale, a number = scene units, 0 / omitted = none. erosion: an amount 0..1 (true = 1) or { amount, seed }.
 * Knobs (scale units), overridable in the erosion object, then capped by the builder's limits: edge (eaten band
 * width), tip (corner wear), chips (chip rate, 0 = none), pits (pit density, 0 = none).
 */
export function wearOptions({ chamfer, erosion } = {}, scale, seed = 1, limits = {}) {
  const c = chamfer === true ? DEFAULT_CHAMFER * scale : Math.max(0, Number(chamfer) || 0);
  const o = erosion === true ? { amount: 1 } : typeof erosion === "number" ? { amount: erosion } : erosion;
  let e = null;
  if (o) {
    const amount = Math.max(0, Math.min(1, o.amount ?? 1));
    const knobs = Object.fromEntries(["edge", "tip", "chips", "pits"].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    if (amount > 0) e = { edge: 0.3, tip: 0.15, chips: 1, pits: 1, ...knobs, ...limits, amount, seed: (o.seed ?? seed) >>> 0 };
  }
  return { chamfer: c, erosion: e, scale, active: c > 0 || !!e };
}

// ---------------------------------------------------------------- mesh building

export class MeshBuilder {
  constructor() { this.p = []; this.i = []; }
  v(x, y, z) { this.p.push(x, y, z); return this.p.length / 3 - 1; }
  t(a, b, c) {
    const p = this.p;
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-30) return;
    this.i.push(a, b, c);
  }
  q(a, b, c, d) {
    const p = this.p, l = (i, j) => (p[3 * i] - p[3 * j]) ** 2 + (p[3 * i + 1] - p[3 * j + 1]) ** 2 + (p[3 * i + 2] - p[3 * j + 2]) ** 2;
    if (l(a, c) <= l(b, d)) { this.t(a, b, c); this.t(a, c, d); } else { this.t(a, b, d); this.t(b, c, d); }
  }
  finish() {
    // Drops the vertices left unreferenced by skipped degenerate triangles (lathe segments through r = 0).
    const remap = new Int32Array(this.p.length / 3).fill(-1), p = [];
    const idx = this.i.map((v) => {
      if (remap[v] < 0) { remap[v] = p.length / 3; p.push(this.p[3 * v], this.p[3 * v + 1], this.p[3 * v + 2]); }
      return remap[v];
    });
    const n = new Float32Array(p.length);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k], b = idx[k + 1], c = idx[k + 2];
      const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
      const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { n[3 * v] += cx; n[3 * v + 1] += cy; n[3 * v + 2] += cz; }
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return splitNormals({ position: new Float32Array(p), normal: n, index: new Uint32Array(idx) });
  }
}

/**
 * Gives a triangle its own copies (with its face normal) of the vertices whose smoothed normal points away from it
 * (dot < minDot), so sharp worn corners shade flat instead of inside out. Returns geo itself when none do.
 */
export function splitNormals(geo, minDot = 0.1) {
  const P = geo.position, N = geo.normal, I = geo.index, bad = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    for (let s = 0; s < 3; s++) {
      const v = 3 * I[t + s];
      if ((N[v] * cx + N[v + 1] * cy + N[v + 2] * cz) / l < minDot) bad.push(t + s, cx / l, cy / l, cz / l);
    }
  }
  if (!bad.length) return geo;
  const nv = P.length / 3, k = bad.length / 4, p = new Float32Array(P.length + 3 * k), n = new Float32Array(N.length + 3 * k), idx = Uint32Array.from(I);
  p.set(P); n.set(N);
  for (let j = 0; j < k; j++) {
    const slot = bad[4 * j], v = I[slot], w = nv + j;
    p[3 * w] = P[3 * v]; p[3 * w + 1] = P[3 * v + 1]; p[3 * w + 2] = P[3 * v + 2];
    n[3 * w] = bad[4 * j + 1]; n[3 * w + 1] = bad[4 * j + 2]; n[3 * w + 2] = bad[4 * j + 3];
    idx[slot] = w;
  }
  return { position: p, normal: n, index: idx };
}

// Area-weighted vertex normals of the triangles `tris` (indices), written into n (their old values replaced).
function accumulateNormals(p, idx, n, tris) {
  const done = new Uint8Array(n.length / 3);
  for (const t of tris) for (let s = 0; s < 3; s++) { const v = idx[3 * t + s]; n[3 * v] = n[3 * v + 1] = n[3 * v + 2] = 0; }
  for (const t of tris) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    n[3 * a] += cx; n[3 * a + 1] += cy; n[3 * a + 2] += cz;
    n[3 * b] += cx; n[3 * b + 1] += cy; n[3 * b + 2] += cz;
    n[3 * c] += cx; n[3 * c + 1] += cy; n[3 * c + 2] += cz;
  }
  for (const t of tris) for (let s = 0; s < 3; s++) {
    const v = idx[3 * t + s];
    if (done[v]) continue;
    done[v] = 1;
    const l = Math.sqrt(n[3 * v] ** 2 + n[3 * v + 1] ** 2 + n[3 * v + 2] ** 2) || 1;
    n[3 * v] /= l; n[3 * v + 1] /= l; n[3 * v + 2] /= l;
  }
}

// Quads between consecutive rows of a closed loop; crease[i] splits the normals at column i.
export function sweep(mesh, rows, crease) {
  const n = rows[0].length, cin = [], cout = [];
  for (let i = 0; i < n; i++) {
    cin[i] = rows.map((row) => mesh.v(...row[i]));
    cout[i] = crease && crease[i] ? rows.map((row) => mesh.v(...row[i])) : cin[i];
  }
  for (let i = 0; i < n; i++) {
    const A = cout[i], B = cin[(i + 1) % n];
    for (let k = 0; k < rows.length - 1; k++) mesh.q(A[k], B[k], B[k + 1], A[k + 1]);
  }
}

// Columns where a closed loop (2D or 3D points) turns by more than `limit`.
export function creases(pts, limit = 0.6) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const u = p.map((x, k) => x - a[k]), v = b.map((x, k) => x - p[k]);
    const c = u.reduce((s, x, k) => s + x * v[k], 0) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    return c < Math.cos(limit);
  });
}

/**
 * Flips interior edges of a 2D triangulation (CCW triangles [a, b, c] into xy) toward Delaunay, so earcut's slivers
 * along nearly straight outlines go away; edges used once (the outline) never flip. Returns the triangles.
 */
export function delaunayFlip(tris, xy) {
  const T = tris.map((t) => t.slice()), n = xy.length, key = (u, v) => u * n + v, owner = new Map();
  const ccw = (a, b, c) => (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[c][0] - xy[a][0]) * (xy[b][1] - xy[a][1]);
  const inCircle = (a, b, c, d) => {
    const [ax, ay] = [xy[a][0] - xy[d][0], xy[a][1] - xy[d][1]], [bx, by] = [xy[b][0] - xy[d][0], xy[b][1] - xy[d][1]], [cx, cy] = [xy[c][0] - xy[d][0], xy[c][1] - xy[d][1]];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  const set = (t) => { const [a, b, c] = T[t]; owner.set(key(a, b), t); owner.set(key(b, c), t); owner.set(key(c, a), t); };
  T.forEach((_, t) => set(t));
  const stack = [];
  T.forEach(([a, b, c]) => stack.push([a, b], [b, c], [c, a]));
  for (let guard = 0; stack.length && guard < 20 * T.length + 100; guard++) {
    const [u, v] = stack.pop(), t1 = owner.get(key(u, v)), t2 = owner.get(key(v, u));
    if (t1 === undefined || t2 === undefined) continue;
    const a = T[t1].find((x) => x !== u && x !== v), b = T[t2].find((x) => x !== u && x !== v);
    if (a === undefined || b === undefined || a === b) continue;
    // Triangle t1 = (u, v, a) CCW; flip when b lies inside its circumcircle and the quad u-b-v-a is convex.
    if (!(inCircle(u, v, a, b) > 0) || !(ccw(u, b, a) > 0 && ccw(b, v, a) > 0)) continue;
    owner.delete(key(u, v)); owner.delete(key(v, u));
    T[t1] = [u, b, a]; T[t2] = [b, v, a];
    set(t1); set(t2);
    stack.push([u, b], [b, v], [v, a], [a, u]);
  }
  return T;
}

const signedArea = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// ---------------------------------------------------------------- loops

// Per vertex: inward (toward the solid) miter direction b, miter length, convexity and turn angle; inside: the loop
// encloses the solid (an outer boundary) rather than a hole in it.
function loopInfo(pts, inside) {
  const n = pts.length, s = (signedArea(pts) > 0) === inside ? 1 : -1;
  const en = new Float64Array(2 * n), len = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1e-30;
    en[2 * i] = (-dy / l) * s; en[2 * i + 1] = (dx / l) * s; len[i] = l;
  }
  const b = new Float64Array(2 * n), miter = new Float64Array(n), convex = new Uint8Array(n), turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n, ax = en[2 * j], ay = en[2 * j + 1], cx = en[2 * i], cy = en[2 * i + 1];
    let bx = ax + cx, by = ay + cy, bl = Math.hypot(bx, by);
    if (bl < 1e-9) { bx = cx; by = cy; bl = 1; }
    bx /= bl; by /= bl;
    b[2 * i] = bx; b[2 * i + 1] = by;
    miter[i] = 1 / Math.max(bx * cx + by * cy, 0.33);
    convex[i] = (ax * cy - ay * cx) * s > 1e-12 ? 1 : 0;
    turn[i] = Math.acos(Math.max(-1, Math.min(1, ax * cx + ay * cy)));
  }
  return { n, en, len, b, miter, convex, turn };
}

const cellKey = (x, y) => (x + 1048576) * 2097152 + (y + 1048576);

function segmentGrid(loops, cell) {
  const segs = [], map = new Map();
  loops.forEach((pts, k) => {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n], id = segs.length;
      segs.push([a[0], a[1], c[0], c[1], k, i]);
      const x0 = Math.floor(Math.min(a[0], c[0]) / cell), x1 = Math.floor(Math.max(a[0], c[0]) / cell);
      const y0 = Math.floor(Math.min(a[1], c[1]) / cell), y1 = Math.floor(Math.max(a[1], c[1]) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = cellKey(x, y);
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        list.push(id);
      }
    }
  });
  return { segs, map, cell, sizes: loops.map((p) => p.length) };
}

// Nearest hit of the ray p + t d, 0 < t <= len, with the loops' segments except the two at vertex i of loop k.
function rayHit(G, px, py, dx, dy, len, k, i) {
  const n = G.sizes[k], c = G.cell;
  const x0 = Math.floor(Math.min(px, px + dx * len) / c), x1 = Math.floor(Math.max(px, px + dx * len) / c);
  const y0 = Math.floor(Math.min(py, py + dy * len) / c), y1 = Math.floor(Math.max(py, py + dy * len) / c);
  let best = Infinity;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const list = G.map.get(cellKey(x, y));
    if (!list) continue;
    for (const id of list) {
      const [ax, ay, bx, by, kk, ii] = G.segs[id];
      if (kk === k && (ii === i || ii === (i + n - 1) % n)) continue;
      const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-30) continue;
      const wx = ax - px, wy = ay - py, t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
      if (t > 1e-12 && t <= len && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  return best;
}

// Pairs [i, j] of non-adjacent edges (edge i runs from vertex i to i + 1) of a closed loop that cross.
function crossingEdges(pts) {
  const n = pts.length;
  let l = 0;
  for (let i = 0; i < n; i++) l = Math.max(l, Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]));
  const G = segmentGrid([pts], Math.max(l, 1e-12)), out = [];
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const list of G.map.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    let i = G.segs[list[x]][5], j = G.segs[list[y]][5];
    if (i > j) [i, j] = [j, i];
    if (j - i < 2 || (i === 0 && j === n - 1)) continue;
    const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
    const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) out.push([i, j]);
  }
  return out;
}

/**
 * Wears the convex corners of eroded loops round (tooth tips first): a few Laplacian steps that only move a vertex
 * toward its neighbours where the outline bulges, by at most erosion.tip * scale (varied per corner). unit: scene
 * units per 2D unit of the loops. Returns the loops unchanged without erosion.
 */
export function wearLoops(loops, inside, w, { unit = 1 } = {}) {
  const e = w.erosion;
  if (!e || !(e.tip > 0)) return loops;
  const S = w.scale;
  return loops.map((pts, k) => {
    const n = pts.length, max = new Float64Array(n), seed = hash(e.seed, 401 + k);
    let u = 0;
    for (let i = 0; i < n; i++) {
      max[i] = (e.amount * e.tip * S * (0.35 + 0.65 * fbm(seed, u / (3 * S)))) / unit;
      u += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]) * unit;
    }
    let cur = pts.map((p) => [p[0], p[1]]);
    for (let it = 0; it < 4; it++) {
      const info = loopInfo(cur, inside[k]), next = cur.map((p) => [p[0], p[1]]);
      for (let i = 0; i < n; i++) {
        if (!info.convex[i]) continue;
        const a = cur[(i + n - 1) % n], c = cur[(i + 1) % n], p = cur[i];
        const qx = p[0] + 0.5 * ((a[0] + c[0]) / 2 - p[0]), qy = p[1] + 0.5 * ((a[1] + c[1]) / 2 - p[1]);
        if (Math.hypot(qx - pts[i][0], qy - pts[i][1]) <= max[i]) next[i] = [qx, qy];
      }
      cur = next;
    }
    return cur;
  });
}

/**
 * Cap profile of the loops at one end of a wall: rows from the cap edge (row 0, the cap's own outline) down to the
 * plain wall, each { pts, depth } with depth (scene units) measured from the cap into the solid. A chamfer gives a flat
 * 45 degree band; erosion a rounded band of irregular width, and chips at some sharp convex corners. Insets are
 * limited to 40% of the local thickness (a ray across the loops), so narrow tips keep their shape.
 * unit: scene units per 2D unit; maxDepth: how deep this end may go; end: varies the noise per end; keep: triangles
 * [i, j, k] of the first loop's vertices (a cap's own triangulation) that row 0 must not turn over.
 * Returns null when there is nothing to do; otherwise { rows: per loop, smooth: true for the rounded band }.
 */
export function capRows(loops, inside, w, { unit = 1, maxDepth = Infinity, end = 0, keep = null, obstacles = [] } = {}) {
  if (!w.active) return null;
  const c = w.chamfer, e = w.erosion, S = w.scale;
  const infos = loops.map((p, k) => loopInfo(p, inside[k]));
  const edgeMax = e ? e.amount * e.edge * S : 0, cMax = Math.max(0, 0.6 * maxDepth);
  const rand = mulberry32(hash(e ? e.seed : 0, 31 + end));
  const chips = loops.map(() => []);
  let kappaMax = 0;
  if (e && e.chips > 0) {
    loops.forEach((pts, k) => {
      const I = infos[k];
      for (let i = 0; i < I.n; i++) {
        if (!I.convex[i] || I.turn[i] < 0.6 || rand() >= 0.07 * e.amount * e.chips) continue;
        const ch = { i, kappa: e.amount * (0.3 + 0.3 * rand()) * S, a: (0.6 + 0.5 * rand()) * S, b: (0.6 + 0.4 * rand()) * S };
        chips[k].push(ch);
        kappaMax = Math.max(kappaMax, ch.kappa);
      }
    });
  }
  const G = segmentGrid([...loops, ...obstacles], Math.max((3 * (c + edgeMax + 0.5 * kappaMax)) / unit, 1e-12));
  const rows = loops.map((pts, k) => {
    const I = infos[k], n = I.n, seed = hash(e ? e.seed : 0, 211 + 17 * k + end);
    const C = new Float64Array(n), f = new Float64Array(n).fill(1);
    let u = 0;
    for (let i = 0; i < n; i++) {
      C[i] = Math.min(cMax, c + (e ? edgeMax * (0.2 + 0.8 * fbm(seed, u / (1.3 * S))) : 0));
      u += I.len[i] * unit;
    }
    // Chips: arc distance (scene units) from each chip's corner for the vertices it reaches.
    const reached = [];
    let deep = 0;
    if (chips[k].length && Math.max(...C) + Math.max(...chips[k].map((ch) => ch.b)) <= maxDepth) {
      for (const ch of chips[k]) {
        deep = Math.max(deep, ch.b);
        const d = new Map([[ch.i, 0]]);
        for (const dir of [1, -1]) {
          let s = 0, i = ch.i;
          for (let step = 0; step < n; step++) {
            const j = (i + dir + n) % n;
            s += I.len[dir > 0 ? i : j] * unit;
            if (s >= ch.a) break;
            d.set(j, Math.min(d.get(j) ?? Infinity, s));
            i = j;
          }
        }
        reached.push({ ch, d });
      }
    }
    const chipAt = (i, depth) => {
      let v = 0;
      for (const { ch, d } of reached) { const s = d.get(i); if (s !== undefined) v = Math.max(v, ch.kappa * Math.max(0, 1 - s / ch.a - depth / ch.b)); }
      return v;
    };
    for (let i = 0; i < n; i++) {
      const want = ((C[i] + chipAt(i, 0)) * I.miter[i]) / unit;
      if (!(want > 0)) continue;
      const t = rayHit(G, pts[i][0], pts[i][1], I.b[2 * i], I.b[2 * i + 1], 2.5 * want, k, i);
      if (t < Infinity) f[i] = Math.min(1, (0.4 * t) / want);
    }
    const psis = e ? [90, 45, 0] : [90, 0];
    // Clamped insets keep some depth, so the band's rows never collapse onto each other.
    const offsetAt = (i, psi) => {
      const r = (psi * Math.PI) / 180;
      return { off: f[i] * (C[i] * (1 - Math.cos(r)) + chipAt(i, C[i] * (1 - Math.sin(r)))), depth: Math.max(f[i], 0.35) * C[i] * (1 - Math.sin(r)) };
    };
    const at = (i, off) => (off > 0 ? [pts[i][0] + (I.b[2 * i] * off * I.miter[i]) / unit, pts[i][1] + (I.b[2 * i + 1] * off * I.miter[i]) / unit] : pts[i]);
    // Halves the insets (once per problem) where row 0 would turn an edge back on itself or cross another of its
    // edges; halving one vertex can turn a neighbour's triangle over, so a last resort halves them all.
    const flagged = () => {
      const q = pts.map((_, i) => at(i, offsetAt(i, 90).off)), out = new Map(), add = (v) => out.set(v, (out.get(v) ?? 0) + 1);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ex = pts[j][0] - pts[i][0], ey = pts[j][1] - pts[i][1];
        if ((q[j][0] - q[i][0]) * ex + (q[j][1] - q[i][1]) * ey < 0.1 * (ex * ex + ey * ey)) { add(i); add(j); }
      }
      for (const [i, j] of crossingEdges(q)) for (const v of [i, (i + 1) % n, j, (j + 1) % n]) add(v);
      if (k === 0 && keep) for (const [a, b, c] of keep) {
        const ar = (u) => (u[b][0] - u[a][0]) * (u[c][1] - u[a][1]) - (u[c][0] - u[a][0]) * (u[b][1] - u[a][1]), a0 = ar(pts);
        if (ar(q) * Math.sign(a0) < 0.1 * Math.abs(a0)) { add(a); add(b); add(c); }
      }
      return out;
    };
    const repair = () => {
      let changed = false;
      for (let it = 0; it < 24; it++) {
        const bad = flagged();
        if (!bad.size) break;
        changed = true;
        if (it < 12) for (const [v, k] of bad) f[v] *= 0.5 ** k;
        else for (let i = 0; i < n; i++) f[i] *= 0.5;
      }
      return changed;
    };
    // Even, then repaired; if the repair had to clamp more, evened and repaired once more.
    smoothFactors(f, I.len, unit, 0.8 * S);
    if (repair()) {
      smoothFactors(f, I.len, unit, 0.8 * S);
      repair();
    }
    const out = psis.map((psi) => {
      const depth = new Float64Array(n), p = [];
      for (let i = 0; i < n; i++) { const o = offsetAt(i, psi); depth[i] = o.depth; p.push(at(i, o.off)); }
      return { pts: p, depth };
    });
    if (deep > 0) out.push({ pts, depth: Float64Array.from(C, (x, i) => Math.max(f[i], 0.35) * x + deep) });
    return out;
  });
  // Crisp creases until erosion's rounding outgrows the chamfer; past that the edge rolls over smoothly.
  return { rows, smooth: !!e && edgeMax > c };
}

/**
 * Rows of one loop's wall from end A (axial coordinate tA) to end B (tB): A's cap band, the plain wall cut at `breaks`
 * and into slices(t0, t1) pieces between them, then B's cap band. profA / profB: this loop's capRows rows, or null.
 * Returns { rows: [{ pts, t }], wall: [i0, i1] } with rows i0..i1 the plain wall (both band ends included).
 */
export function wallRows(pts, profA, profB, tA, tB, { breaks = [], slices = () => 1 } = {}) {
  const sg = Math.sign(tB - tA), n = pts.length;
  const ends = (prof, t0, s) => (prof ? prof.map((r) => ({ pts: r.pts, t: Float64Array.from(r.depth, (d) => t0 + s * d) })) : [{ pts, t: new Float64Array(n).fill(t0) }]);
  const A = ends(profA, tA, sg), B = ends(profB, tB, -sg).reverse();
  const a = A[A.length - 1].t, b = B[0].t;
  const knots = [tA, ...breaks.filter((x) => (x - tA) * sg > 0 && (tB - x) * sg > 0), tB];
  const rows = [...A];
  for (let j = 0; j < knots.length - 1; j++) {
    const k = Math.max(1, slices(knots[j], knots[j + 1])), last = j === knots.length - 2;
    for (let s = 1; s <= (last ? k - 1 : k); s++) {
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) { const lo = j === 0 ? a[i] : knots[j], hi = last ? b[i] : knots[j + 1]; t[i] = lo + ((hi - lo) * s) / k; }
      rows.push({ pts, t });
    }
  }
  const wall = [A.length - 1, rows.length];
  rows.push(...B);
  return { rows, wall };
}

// Evens out per-vertex inset factors along a closed loop, so a clamped bevel narrows gradually instead of kinking: a
// minimum over `width` of arc length, then a blur over half that; no factor goes up.
function smoothFactors(f, len, unit, width) {
  const n = f.length;
  if (n < 3 || !(width > 0)) return;
  const window = (i, w, fn) => {
    let acc = fn(null, f[i], 0);
    for (const dir of [1, -1]) {
      let s = 0, j = i;
      for (let step = 0; step < n; step++) {
        const nj = (j + dir + n) % n;
        s += len[dir > 0 ? j : nj] * unit;
        if (s > w) break;
        acc = fn(acc, src[nj], s);
        j = nj;
      }
    }
    return acc;
  };
  let src = f.slice();
  const lo = Float64Array.from(f, (_, i) => window(i, width, (a, v) => (a === null ? v : Math.min(a, v))));
  src = lo;
  for (let i = 0; i < n; i++) {
    let sum = lo[i], cnt = 1;
    window(i, width / 2, (a, v) => {
      if (a !== null) {
        sum += v;
        cnt++;
      }
      return 0;
    });
    f[i] = Math.min(f[i], sum / cnt);
  }
}

/** Sweeps wallRows output through place(p2, t) -> [x, y, z]; a flat chamfer keeps hard edges at its bands. */
export function sweepWall(mesh, { rows, wall }, place, crease, smooth, reverse = false) {
  const r3 = rows.map((r) => {
    const row = r.pts.map((p, i) => place(p, r.t[i]));
    return reverse ? row.reverse() : row;
  });
  if (smooth || rows.length === 2) return sweep(mesh, r3, crease);
  if (wall[0] > 0) sweep(mesh, r3.slice(0, wall[0] + 1), crease);
  sweep(mesh, r3.slice(wall[0], wall[1] + 1), crease);
  if (wall[1] < r3.length - 1) sweep(mesh, r3.slice(wall[1]), crease);
}

/**
 * Straight prism of a 2D shape (outer CCW or CW, holes either way) from z0 to z1 with cap profiles at both ends, worn
 * corners and pits; creaseAngle splits the wall normals. Returns { position, normal, index }.
 */
export function profiledExtrusion(outer, holes, z0, z1, w, { creaseAngle = (30 * Math.PI) / 180 } = {}) {
  const loops0 = [outer, ...holes].map((l, k) => ((signedArea(l) > 0) === (k === 0) ? l : l.slice().reverse()));
  const inside = loops0.map((_, k) => k === 0);
  const loops = wearLoops(loops0, inside, w);
  const md = 0.45 * (z1 - z0);
  const top = capRows(loops, inside, w, { maxDepth: md, end: 1 }), bot = capRows(loops, inside, w, { maxDepth: md, end: 0 });
  const mesh = new MeshBuilder();
  for (const [prof, z, flip] of [[top, z1, false], [bot, z0, true]]) {
    const cl = prof ? prof.rows.map((r) => r[0].pts) : loops;
    const tris = ShapeUtils.triangulateShape(cl[0].map(([x, y]) => new Vector2(x, y)), cl.slice(1).map((h) => h.map(([x, y]) => new Vector2(x, y))));
    const flat = cl.flat(), ids = flat.map(([x, y]) => mesh.v(x, y, z));
    const ccw = tris.map(([a, b, c]) => ((flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) - (flat[c][0] - flat[a][0]) * (flat[b][1] - flat[a][1]) < 0 ? [a, c, b] : [a, b, c]));
    for (const [a, b, c] of delaunayFlip(ccw, flat)) flip ? mesh.t(ids[a], ids[c], ids[b]) : mesh.t(ids[a], ids[b], ids[c]);
  }
  loops.forEach((pts, k) => {
    const wr = wallRows(pts, bot ? bot.rows[k] : null, top ? top.rows[k] : null, z0, z1);
    sweepWall(mesh, wr, (p, t) => [p[0], p[1], t], creases(pts, creaseAngle), top ? top.smooth : false);
  });
  return pitFaces(mesh.finish(), w, { width: z1 - z0 });
}

/**
 * Lathe path [[r, z], ...] (solid on the left of the walking direction) with its convex corners cut by c. startDir /
 * endDir: the direction the boundary walks into the first point / out of the last one (along the neighbouring caps),
 * or null; a convex junction there is cut too and its cap must end `start` / `end` further back along that cap.
 */
export function chamferPath(path, c, startDir = null, endDir = null) {
  const pts = path.filter((p, i) => i === 0 || Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) > 1e-12);
  if (!(c > 0) || pts.length < 2) return { path: pts, start: 0, end: 0 };
  const seg = (i) => { const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return { d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], l }; };
  const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
  const out = [];
  let start = 0, end = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], last = i === pts.length - 1;
    const prev = i > 0 ? seg(i - 1) : startDir ? { d: startDir, l: Infinity } : null;
    const next = !last ? seg(i) : endDir ? { d: endDir, l: Infinity } : null;
    if (!prev || !next || p[0] < 1e-9 || cross(prev.d, next.d) < 1e-6) { out.push(p); continue; }
    const k = Math.min(c, 0.45 * prev.l, 0.45 * next.l);
    out.push([p[0] - k * prev.d[0], p[1] - k * prev.d[1]], [p[0] + k * next.d[0], p[1] + k * next.d[1]]);
    if (i === 0) start = k;
    if (last) end = k;
  }
  return { path: out, start, end };
}

// ---------------------------------------------------------------- pits

/**
 * Shallow pits on the flat faces (normal +-z) of a finished mesh: craters 0.5-4 scale across, up to 15% of `width`
 * deep (and a quarter of the local thickness), kept clear of each face's outline and of each other. A face is a patch
 * of triangles sharing vertex indices; the triangles under a crater are cut out and the hole is filled with a small
 * polar crater mesh stitched to the cut's outline, so the rest of the mesh keeps its triangles and stays watertight.
 */
export function pitFaces(geo, w, { width = Infinity } = {}) {
  const e = w.erosion;
  if (!e || !(e.pits > 0)) return geo;
  const S = w.scale, rand = mulberry32(hash(e.seed, 977));
  const I = geo.index, nt = I.length / 3, nv0 = geo.position.length / 3;
  let P = new Float64Array(geo.position), N = new Float64Array(geo.normal), nv = nv0;
  const addVertex = (x, y, z, sg) => {
    if (3 * nv + 3 > P.length) {
      const q = new Float64Array(2 * P.length + 3), m = new Float64Array(2 * N.length + 3);
      q.set(P); m.set(N); P = q; N = m;
    }
    P[3 * nv] = x; P[3 * nv + 1] = y; P[3 * nv + 2] = z; N[3 * nv] = 0; N[3 * nv + 1] = 0; N[3 * nv + 2] = sg;
    return nv++;
  };
  // Facing of each triangle: 1 / -1 when flat (normal +-z), else the sign of its z normal times 2 (0 for walls).
  const face = new Int8Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cz !== 0 && cz * cz > 0.999998 * (cx * cx + cy * cy + cz * cz)) face[t] = cz > 0 ? 1 : -1;
    else face[t] = cz > 1e-30 ? 2 : cz < -1e-30 ? -2 : 0;
  }
  // Patches: flat triangles of one facing joined through shared vertices; a patch whose vertices other triangles
  // also use is not self-contained and is left alone.
  const parent = new Int32Array(nt), first = new Int32Array(nv0).fill(-1), outside = new Uint8Array(nv0);
  for (let t = 0; t < nt; t++) parent[t] = t;
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let t = 0; t < nt; t++) {
    const flat = face[t] === 1 || face[t] === -1;
    for (let s = 0; s < 3; s++) {
      const v = I[3 * t + s];
      if (!flat) { outside[v] = 1; continue; }
      if (first[v] < 0) first[v] = t;
      else if (face[first[v]] === face[t]) parent[find(first[v])] = find(t);
    }
  }
  const patches = new Map();
  for (let t = 0; t < nt; t++) {
    if (face[t] !== 1 && face[t] !== -1) continue;
    const r = find(t);
    let p = patches.get(r);
    if (!p) patches.set(r, (p = { tris: [], ok: true, sign: face[t], root: r }));
    p.tris.push(t);
    if (outside[I[3 * t]] || outside[I[3 * t + 1]] || outside[I[3 * t + 2]]) p.ok = false;
  }
  const segDist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const s = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const ex = x - ax - s * dx, ey = y - ay - s * dy;
    return Math.sqrt(ex * ex + ey * ey);
  };
  const ekey = (u, v) => (u < v ? u * nv0 + v : v * nv0 + u);
  // Non-wall triangles by their xy boxes, for the thickness rays (built on first use).
  let exitGrid = null;
  const exitCell = 4 * S;
  const exits = (x, y) => {
    if (!exitGrid) {
      exitGrid = new Map();
      exitGrid.big = [];
      for (let t = 0; t < nt; t++) {
        if (!face[t]) continue;
        const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
        const x0 = Math.floor(Math.min(P[a], P[b], P[c]) / exitCell), x1 = Math.floor(Math.max(P[a], P[b], P[c]) / exitCell);
        const y0 = Math.floor(Math.min(P[a + 1], P[b + 1], P[c + 1]) / exitCell), y1 = Math.floor(Math.max(P[a + 1], P[b + 1], P[c + 1]) / exitCell);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { exitGrid.big.push(t); continue; }
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const k = cellKey(gx, gy); let l = exitGrid.get(k); if (!l) exitGrid.set(k, (l = [])); l.push(t); }
      }
    }
    return [...(exitGrid.get(cellKey(Math.floor(x / exitCell), Math.floor(y / exitCell))) || []), ...exitGrid.big];
  };
  const kept = [], pitted = [];
  let changed = false;
  for (const patch of patches.values()) {
    const src = patch.tris, sg = patch.sign;
    let area = 0;
    const cum = new Float64Array(src.length);
    src.forEach((t, k) => {
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      area += Math.abs((P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (P[b + 1] - P[a + 1])) / 2;
      cum[k] = area;
    });
    const target = patch.ok ? Math.round((0.08 * e.amount * e.pits * area) / (2.26 * S * S)) : 0;
    if (target < 1) { kept.push(src); continue; }
    const z = P[3 * I[3 * src[0]] + 2];
    const count = new Map();
    for (const t of src) for (let s = 0; s < 3; s++) { const k = ekey(I[3 * t + s], I[3 * t + ((s + 1) % 3)]); count.set(k, (count.get(k) || 0) + 1); }
    const boundary = new Set();
    for (const [k, n] of count) if (n === 1) boundary.add(k);
    const isBoundary = (u, v) => u < nv0 && v < nv0 && boundary.has(ekey(u, v));
    const pick = () => {
      const r = rand() * area;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const t = src[lo], a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      let u = rand(), v = rand();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      return [P[a] + u * (P[b] - P[a]) + v * (P[c] - P[a]), P[a + 1] + u * (P[b + 1] - P[a + 1]) + v * (P[c + 1] - P[a + 1])];
    };
    // Thickness under the face: the nearest surface the solid is left through, straight down (or up) from it.
    let thick = Infinity;
    {
      const [x, y] = pick();
      for (const t of exits(x, y)) {
        if (face[t] * sg >= 0) continue;
        const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
        const d = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (P[b + 1] - P[a + 1]);
        if (Math.abs(d) < 1e-30) continue;
        const u = ((x - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (y - P[a + 1])) / d;
        const v = ((P[b] - P[a]) * (y - P[a + 1]) - (x - P[a]) * (P[b + 1] - P[a + 1])) / d;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const dz = sg * (z - (P[a + 2] + u * (P[b + 2] - P[a + 2]) + v * (P[c + 2] - P[a + 2])));
        if (dz > 1e-9 && dz < thick) thick = dz;
      }
    }
    // Working triangles [a, b, c, locked] in a grid of their boxes.
    const tris = src.map((t) => [I[3 * t], I[3 * t + 1], I[3 * t + 2], false]), alive = tris.map(() => true);
    const cell = 3 * S, grid = new Map(), big = [];
    const addTri = (id) => {
      const [a, b, c] = tris[id];
      const x0 = Math.floor(Math.min(P[3 * a], P[3 * b], P[3 * c]) / cell), x1 = Math.floor(Math.max(P[3 * a], P[3 * b], P[3 * c]) / cell);
      const y0 = Math.floor(Math.min(P[3 * a + 1], P[3 * b + 1], P[3 * c + 1]) / cell), y1 = Math.floor(Math.max(P[3 * a + 1], P[3 * b + 1], P[3 * c + 1]) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { big.push(id); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = cellKey(x, y); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(id); }
    };
    for (let id = 0; id < tris.length; id++) addTri(id);
    const overlaps = (id, x, y, r) => {
      const [a, b, c] = tris[id], ax = P[3 * a], ay = P[3 * a + 1], bx = P[3 * b], by = P[3 * b + 1], cx = P[3 * c], cy = P[3 * c + 1];
      if (segDist(x, y, ax, ay, bx, by) < r || segDist(x, y, bx, by, cx, cy) < r || segDist(x, y, cx, cy, ax, ay) < r) return true;
      const s1 = (bx - ax) * (y - ay) - (x - ax) * (by - ay), s2 = (cx - bx) * (y - by) - (x - bx) * (cy - by), s3 = (ax - cx) * (y - cy) - (x - cx) * (ay - cy);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    let made = 0;
    for (let tries = 0; tries < 4 * target && made < target; tries++) {
      const [x, y] = pick(), R = S * (0.25 + 1.75 * rand() ** 3), dr = rand();
      const D = Math.min(0.15 * width, 0.25 * thick, 0.35 * R) * e.amount * (0.4 + 0.6 * dr);
      if (!(D > 0)) continue;
      const rc = 1.15 * R, rClear = 1.25 * R + 0.1 * S, hit = new Set(big);
      for (let gx = Math.floor((x - rClear) / cell); gx <= Math.floor((x + rClear) / cell); gx++) for (let gy = Math.floor((y - rClear) / cell); gy <= Math.floor((y + rClear) / cell); gy++) for (const id of grid.get(cellKey(gx, gy)) || []) if (alive[id]) hit.add(id);
      // The face outline must stay rClear away, and the cut may not reach another crater.
      let ok = true;
      const cut = [];
      for (const id of hit) {
        if (!alive[id]) continue;
        const [a, b, c, locked] = tris[id];
        for (const [u, v] of [[a, b], [b, c], [c, a]]) if (isBoundary(u, v) && segDist(x, y, P[3 * u], P[3 * u + 1], P[3 * v], P[3 * v + 1]) < rClear) ok = false;
        if (!ok) break;
        if (overlaps(id, x, y, rc)) { if (locked) { ok = false; break; } cut.push(id); }
      }
      if (!ok || !cut.length) continue;
      // Outline of the cut: its edges not shared inside it, which must form one loop.
      const dirEdges = new Set(), next = new Map();
      for (const id of cut) { const [a, b, c] = tris[id]; dirEdges.add(a + "," + b); dirEdges.add(b + "," + c); dirEdges.add(c + "," + a); }
      let simple = true;
      for (const id of cut) {
        const [a, b, c] = tris[id];
        for (const [u, v] of [[a, b], [b, c], [c, a]]) if (!dirEdges.has(v + "," + u)) { if (next.has(u)) simple = false; next.set(u, v); }
      }
      if (!simple || !next.size) continue;
      const start = next.keys().next().value, loop = [start];
      for (let v = next.get(start); v !== start && loop.length <= next.size; v = next.get(v)) loop.push(v);
      if (loop.length !== next.size) continue;
      const M = Math.max(8, Math.min(24, Math.round((TAU * R) / (0.5 * S))));
      const ringXY = Array.from({ length: M }, (_, k) => new Vector2(x + R * Math.cos((TAU * k) / M), y + R * Math.sin((TAU * k) / M)));
      const raw = ShapeUtils.triangulateShape(loop.map((v) => new Vector2(P[3 * v], P[3 * v + 1])), [ringXY]);
      if (!raw.length) continue;
      const sxy = [...loop.map((v) => [P[3 * v], P[3 * v + 1]]), ...ringXY.map((q) => [q.x, q.y])];
      const sar = (a, b, c) => (sxy[b][0] - sxy[a][0]) * (sxy[c][1] - sxy[a][1]) - (sxy[c][0] - sxy[a][0]) * (sxy[b][1] - sxy[a][1]);
      const stitch = delaunayFlip(raw.map(([a, b, c]) => (sar(a, b, c) < 0 ? [a, c, b] : [a, b, c])), sxy);
      const ring = (f) => Array.from({ length: M }, (_, k) => addVertex(x + f * R * Math.cos((TAU * k) / M), y + f * R * Math.sin((TAU * k) / M), z - sg * D * Math.max(0, 1 - f * f) ** 2, sg));
      const r0 = ring(1), r1 = ring(2 / 3), r2 = ring(1 / 3), centre = addVertex(x, y, z - sg * D, sg), ids = [...loop, ...r0];
      for (const id of cut) alive[id] = false;
      const push = (a, b, c, locked) => {
        const ar = (P[3 * b] - P[3 * a]) * (P[3 * c + 1] - P[3 * a + 1]) - (P[3 * c] - P[3 * a]) * (P[3 * b + 1] - P[3 * a + 1]);
        if (Math.abs(ar) < 1e-30) return;
        tris.push(ar * sg > 0 ? [a, b, c, locked] : [a, c, b, locked]);
        alive.push(true);
        addTri(tris.length - 1);
      };
      for (const [a, b, c] of stitch) push(ids[a], ids[b], ids[c], false);
      for (const [A, B] of [[r0, r1], [r1, r2]]) for (let k = 0; k < M; k++) { const k1 = (k + 1) % M; push(A[k], A[k1], B[k1], true); push(A[k], B[k1], B[k], true); }
      for (let k = 0; k < M; k++) push(r2[k], r2[(k + 1) % M], centre, true);
      made++;
    }
    if (!made) { kept.push(src); continue; }
    changed = true;
    pitted.push(tris.filter((_, id) => alive[id]));
  }
  if (!changed) return geo;
  // Reassemble: untouched triangles, then the pitted patches; unused vertices dropped, pitted patches renormalised.
  let total = 0;
  for (let t = 0; t < nt; t++) if (face[t] !== 1 && face[t] !== -1) total++;
  for (const l of kept) total += l.length;
  const start = total;
  for (const l of pitted) total += l.length;
  const idx = new Uint32Array(3 * total);
  let k = 0;
  for (let t = 0; t < nt; t++) if (face[t] !== 1 && face[t] !== -1) { idx[k++] = I[3 * t]; idx[k++] = I[3 * t + 1]; idx[k++] = I[3 * t + 2]; }
  for (const l of kept) for (const t of l) { idx[k++] = I[3 * t]; idx[k++] = I[3 * t + 1]; idx[k++] = I[3 * t + 2]; }
  for (const l of pitted) for (const [a, b, c] of l) { idx[k++] = a; idx[k++] = b; idx[k++] = c; }
  const remap = new Int32Array(nv).fill(-1);
  let m = 0;
  for (let j = 0; j < idx.length; j++) { const v = idx[j]; if (remap[v] < 0) remap[v] = m++; idx[j] = remap[v]; }
  const p = new Float32Array(3 * m), n = new Float32Array(3 * m);
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    p[3 * r] = P[3 * v]; p[3 * r + 1] = P[3 * v + 1]; p[3 * r + 2] = P[3 * v + 2];
    n[3 * r] = N[3 * v]; n[3 * r + 1] = N[3 * v + 1]; n[3 * r + 2] = N[3 * v + 2];
  }
  accumulateNormals(p, idx, n, Array.from({ length: total - start }, (_, j) => start + j));
  return splitNormals({ position: p, normal: n, index: idx });
}
