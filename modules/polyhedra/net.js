// Unfolds a polyhedron into a planar net: a spanning tree of the face adjacency
// graph where every non-root face hangs from its parent by a hinge edge.

import {
  sub,
  dot,
  cross,
  normalize,
  centroid,
  faceNormal,
  rotationMatrix,
  apply,
  planeBasis,
  triangulate,
  rng,
} from "./geom.js";
import { vertexCycles } from "./solids.js";

// Map undirected edge -> [{ face, index }] (index of the edge's first vertex in face).
export function faceAdjacency(solid) {
  const n = solid.vertices.length;
  const map = new Map();
  solid.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const key = Math.min(a, b) * n + Math.max(a, b);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ face: fi, index: i });
    }
  });
  return map;
}

export const edgeKey = (solid, a, b) =>
  Math.min(a, b) * solid.vertices.length + Math.max(a, b);

// Signed angle about u that takes normal np to nc.
const signedAngle = (np, nc, u) => Math.atan2(dot(cross(np, nc), u), dot(np, nc));

// Per-solid data every tree and layout shares (solids are treated as immutable).
const prepared = new WeakMap();
function prepare(solid) {
  let c = prepared.get(solid);
  if (c) return c;
  const adjacency = faceAdjacency(solid);
  const normals = solid.faces.map((f) => faceNormal(solid.vertices, f));
  c = { adjacency, normals, neighbors: buildTree(solid, adjacency), hinges: new Map(), out: null };
  prepared.set(solid, c);
  return c;
}

function buildTree(solid, adjacency, hingeKeys) {
  const F = solid.faces.length;
  const neighbors = Array.from({ length: F }, () => []);
  for (const [key, list] of adjacency) {
    if (list.length !== 2 || (hingeKeys && !hingeKeys.has(key))) continue;
    neighbors[list[0].face].push({ face: list[1].face, key });
    neighbors[list[1].face].push({ face: list[0].face, key });
  }
  return neighbors;
}

// Breadth-first spanning tree from root with shuffled neighbour order.
function bfsParents(solid, root, random) {
  return bfs(prepare(solid).neighbors, root, random);
}

function bfs(neighbors, root, random) {
  const F = neighbors.length;
  const parent = new Int32Array(F).fill(-2);
  const via = new Array(F).fill(-1);
  parent[root] = -1;
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const f = queue[qi];
    const list = neighbors[f].slice();
    if (random) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    for (const { face, key } of list) {
      if (parent[face] !== -2) continue;
      parent[face] = f;
      via[face] = key;
      queue.push(face);
    }
  }
  if (queue.length !== F) return null;
  return { parent, via, order: queue };
}

// Steepest-edge unfolding: every vertex cuts its steepest edge towards `dir`;
// the uncut edges form the face tree.
function steepestEdgeTree(solid, dir) {
  const V = solid.vertices;
  const prep = prepare(solid);
  const adjacency = prep.adjacency;
  // Per vertex: its neighbours with the edge vector and length towards each.
  const out = (prep.out ??= vertexCycles(solid).map((c, v) =>
    c.neighbors.map((n) => {
      const dx = V[n][0] - V[v][0], dy = V[n][1] - V[v][1], dz = V[n][2] - V[v][2];
      return { n, dx, dy, dz, len: Math.hypot(dx, dy, dz) };
    }),
  ));
  const cut = new Set();
  let top = 0;
  V.forEach((v, i) => {
    if (dot(v, dir) > dot(V[top], dir)) top = i;
  });
  for (let v = 0; v < V.length; v++) {
    if (v === top) continue;
    let best = -1;
    let bestSlope = 0;
    for (const e of out[v]) {
      const slope = (e.dx * dir[0] + e.dy * dir[1] + e.dz * dir[2]) / e.len;
      if (slope > bestSlope) {
        bestSlope = slope;
        best = e.n;
      }
    }
    if (best < 0) return null;
    cut.add(edgeKey(solid, v, best));
  }
  if (adjacency.size - cut.size !== solid.faces.length - 1) return null;
  const hinges = new Set();
  for (const key of adjacency.keys()) if (!cut.has(key)) hinges.add(key);
  if (hinges.size !== solid.faces.length - 1) return null;
  const neighbors = buildTree(solid, adjacency, hinges);
  // Root at the tree centre (middle of the longest path) for a shallow fold.
  const far = (r) => {
    const t = bfs(neighbors, r);
    return t && { t, end: t.order.at(-1) };
  };
  const a = far(0);
  if (!a) return null;
  const b = far(a.end);
  const path = [];
  for (let f = b.end; f !== -1; f = b.t.parent[f]) path.push(f);
  return bfs(neighbors, path[path.length >> 1]);
}

// Row-major 3x4 [r | t] transforms, composed with the same arithmetic as geom.js compose().
function composeInto(T, o, A, a, r, t) {
  for (let i = 0; i < 3; i++) {
    const a0 = A[a + i * 4], a1 = A[a + i * 4 + 1], a2 = A[a + i * 4 + 2];
    T[o + i * 4] = a0 * r[0] + a1 * r[3] + a2 * r[6];
    T[o + i * 4 + 1] = a0 * r[1] + a1 * r[4] + a2 * r[7];
    T[o + i * 4 + 2] = a0 * r[2] + a1 * r[5] + a2 * r[8];
    T[o + i * 4 + 3] = a0 * t[0] + a1 * t[1] + a2 * t[2] + A[a + i * 4 + 3];
  }
}

function setIdentity(T, o) {
  T.fill(0, o, o + 12);
  T[o] = T[o + 5] = T[o + 10] = 1;
}

// Root face plane frame: the flat layout is (p - o) . e1, (p - o) . e2.
function rootFrame(solid, normals, root) {
  const V = solid.vertices;
  const n = normals[root];
  const o = centroid(solid.faces[root].map((i) => V[i]));
  const { e1, e2 } = planeBasis(n, sub(V[solid.faces[root][0]], o));
  return { o, n, e1, e2 };
}

// 2D coordinates of face fi under transform T[m..m+12), appended to out at k; returns the next k.
function flatCoords(V, face, T, m, fr, out, k) {
  const { o, e1, e2 } = fr;
  for (const i of face) {
    const v = V[i];
    const px = T[m] * v[0] + T[m + 1] * v[1] + T[m + 2] * v[2] + T[m + 3] - o[0];
    const py = T[m + 4] * v[0] + T[m + 5] * v[1] + T[m + 6] * v[2] + T[m + 7] - o[1];
    const pz = T[m + 8] * v[0] + T[m + 9] * v[1] + T[m + 10] * v[2] + T[m + 11] - o[2];
    out[k++] = px * e1[0] + py * e1[1] + pz * e1[2];
    out[k++] = px * e2[0] + py * e2[1] + pz * e2[2];
  }
  return k;
}

// Face shrunk slightly about its centroid (so touching is fine): box at B[b..b+4) and
// triangles (6 numbers each) appended to tris; returns the triangle count.
function shrunkShape(pts, k0, n, B, b, tris) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[k0 + i * 2] / n;
    cy += pts[k0 + i * 2 + 1] / n;
  }
  const q = n === 3 ? null : new Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = cx + (pts[k0 + i * 2] - cx) * 0.995;
    const y = cy + (pts[k0 + i * 2 + 1] - cy) * 0.995;
    if (q) q[i] = [x, y];
    else tris.push(x, y);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  B[b] = x0;
  B[b + 1] = y0;
  B[b + 2] = x1;
  B[b + 3] = y1;
  if (!q) return 1;
  const tl = triangulate(q);
  for (const t of tl) for (const i of t) tris.push(q[i][0], q[i][1]);
  return tl.length;
}

// Separating-axis test on two triangles stored as 6 numbers at A[a..] and B[b..].
function triOverlap(A, a, B, b) {
  for (let pass = 0; pass < 2; pass++) {
    const P = pass ? B : A;
    const p = pass ? b : a;
    const Q = pass ? A : B;
    const q = pass ? a : b;
    for (let i = 0; i < 3; i++) {
      const s = p + i * 2;
      const e = p + ((i + 1) % 3) * 2;
      const nx = P[s + 1] - P[e + 1];
      const ny = P[e] - P[s];
      let pmin = Infinity;
      let pmax = -Infinity;
      for (let v = 0; v < 6; v += 2) {
        const d = P[p + v] * nx + P[p + v + 1] * ny;
        pmin = Math.min(pmin, d);
        pmax = Math.max(pmax, d);
      }
      let qmin = Infinity;
      let qmax = -Infinity;
      for (let v = 0; v < 6; v += 2) {
        const d = Q[q + v] * nx + Q[q + v + 1] * ny;
        qmin = Math.min(qmin, d);
        qmax = Math.max(qmax, d);
      }
      if (pmax <= qmin || qmax <= pmin) return false;
    }
  }
  return true;
}

// Shapes: box (4 per shape), triangle runs [start, count) into one flat triangle list.
class ShapeSet {
  constructor(n) {
    this.box = new Float64Array(n * 4);
    this.start = new Int32Array(n);
    this.count = new Int32Array(n);
    this.tris = [];
  }
  set(s, pts, k0, n) {
    this.start[s] = this.tris.length;
    this.count[s] = shrunkShape(pts, k0, n, this.box, s * 4, this.tris);
  }
  // Boxes touching or apart never overlap.
  overlaps(s, t) {
    const A = this.box;
    if (A[s * 4 + 2] <= A[t * 4] || A[t * 4 + 2] <= A[s * 4] || A[s * 4 + 3] <= A[t * 4 + 1] || A[t * 4 + 3] <= A[s * 4 + 1]) return false;
    const T = this.tris;
    for (let i = 0; i < this.count[s]; i++)
      for (let j = 0; j < this.count[t]; j++) if (triOverlap(T, this.start[s] + i * 6, T, this.start[t] + j * 6)) return true;
    return false;
  }
}

function hingeOf(solid, prep, p, fi, key) {
  const k = key * solid.faces.length + p;
  let h = prep.hinges.get(k);
  if (!h) prep.hinges.set(k, (h = hingeTransform(solid, prep.adjacency, prep.normals, p, fi, key)));
  return h;
}

// Min-heap on (d, seq): pops in the order a stable sort by d would give.
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  static less(x, y) {
    return x.d < y.d || (x.d === y.d && x.seq < y.seq);
  }
  push(x) {
    const a = this.a;
    let i = a.length;
    a.push(x);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// Grows the tree face by face, nearest-first, skipping placements that overlap
// faces already laid out (deferred ones are used only when nothing else fits).
function greedyTree(solid, root, random) {
  const V = solid.vertices;
  const F = solid.faces.length;
  const prep = prepare(solid);
  const neighbors = prep.neighbors;
  const fr = rootFrame(solid, prep.normals, root);
  const maxN = Math.max(...solid.faces.map((f) => f.length));
  const pts = new Float64Array(maxN * 2);
  // One shape and transform slot per candidate placement (the root is slot 0).
  const maxSlots = 1 + 2 * prep.adjacency.size;
  const shapes = new ShapeSet(maxSlots);
  const M = new Float64Array(maxSlots * 12);
  const slotOf = new Int32Array(F);
  let slots = 0;
  const parent = new Int32Array(F).fill(-2);
  const via = new Array(F).fill(-1);
  const order = [];
  // Placed shapes bucketed by a grid over their boxes, so a candidate is only tested against nearby ones.
  const B = shapes.box;
  let cell = 0;
  const grid = new Map();
  const stamp = new Int32Array(maxSlots);
  let query = 0;
  const cells = (s, fn) => {
    const i0 = Math.floor(B[s * 4] / cell), i1 = Math.floor(B[s * 4 + 2] / cell);
    const j0 = Math.floor(B[s * 4 + 1] / cell), j1 = Math.floor(B[s * 4 + 3] / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) fn((i + 50000) * 100000 + j + 50000);
  };
  const place = (fi, p, key, slot) => {
    parent[fi] = p;
    via[fi] = key;
    slotOf[fi] = slot;
    order.push(fi);
    cells(slot, (k) => {
      const list = grid.get(k);
      if (list) list.push(slot);
      else grid.set(k, [slot]);
    });
  };
  const hitsOf = (s) => {
    let hits = 0;
    query++;
    cells(s, (k) => {
      const list = grid.get(k);
      if (!list) return;
      for (const t of list) {
        if (stamp[t] === query) continue;
        stamp[t] = query;
        if (shapes.overlaps(s, t)) hits++;
      }
    });
    return hits;
  };
  setIdentity(M, 0);
  flatCoords(V, solid.faces[root], M, 0, fr, pts, 0);
  shapes.set(slots++, pts, 0, solid.faces[root].length);
  cell = Math.max(B[2] - B[0], B[3] - B[1], 1e-9);
  place(root, -1, -1, 0);
  const frontier = new Heap();
  const deferred = [];
  let seq = 0;
  const expand = (p) => {
    for (const { face, key } of neighbors[p]) {
      if (parent[face] !== -2) continue;
      const { local } = hingeOf(solid, prep, p, face, key);
      const shape = slots++;
      composeInto(M, shape * 12, M, slotOf[p] * 12, local.r, local.t);
      const n = solid.faces[face].length;
      flatCoords(V, solid.faces[face], M, shape * 12, fr, pts, 0);
      shapes.set(shape, pts, 0, n);
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += pts[i * 2] / n;
        cy += pts[i * 2 + 1] / n;
      }
      frontier.push({ face, p, key, shape, d: Math.hypot(cx, cy) + random() * 1e-3, seq: seq++ });
    }
  };
  expand(root);
  while (order.length < F) {
    let placedOne = false;
    while (frontier.size) {
      const c = frontier.pop();
      if (parent[c.face] !== -2) continue;
      const hits = hitsOf(c.shape);
      if (hits) {
        c.hits = hits;
        deferred.push(c);
        continue;
      }
      place(c.face, c.p, c.key, c.shape);
      expand(c.face);
      placedOne = true;
      break;
    }
    if (placedOne) continue;
    const left = deferred.filter((c) => parent[c.face] === -2).sort((a, b) => a.hits - b.hits);
    if (!left.length) return null;
    const c = left[0];
    place(c.face, c.p, c.key, c.shape);
    expand(c.face);
  }
  return { parent, via, order };
}

function hingeTransform(solid, adjacency, normals, p, fi, key) {
  const V = solid.vertices;
  const pf = solid.faces[p];
  const e = adjacency.get(key).find((x) => x.face === p);
  const a = pf[e.index];
  const b = pf[(e.index + 1) % pf.length];
  const u = normalize(sub(V[b], V[a]));
  const angle = signedAngle(normals[p], normals[fi], u);
  const r = rotationMatrix(u, -angle);
  return { a, b, angle, local: { r, t: sub(V[a], apply({ r, t: [0, 0, 0] }, V[a])) } };
}

// Flat 2D layout of a tree (sharp hinges) in the root face's plane: per face transforms and coordinates.
function layoutCoords(solid, tree) {
  const { parent, via, order } = tree;
  const F = solid.faces.length;
  const prep = prepare(solid);
  const T = new Float64Array(F * 12);
  for (const fi of order) {
    const p = parent[fi];
    if (p < 0) setIdentity(T, fi * 12);
    else {
      const { local } = hingeOf(solid, prep, p, fi, via[fi]);
      composeInto(T, fi * 12, T, p * 12, local.r, local.t);
    }
  }
  const fr = rootFrame(solid, prep.normals, order[0]);
  const start = new Int32Array(F + 1);
  for (let fi = 0; fi < F; fi++) start[fi + 1] = start[fi] + solid.faces[fi].length;
  const coords = new Float64Array(start[F] * 2);
  for (let fi = 0; fi < F; fi++) flatCoords(solid.vertices, solid.faces[fi], T, fi * 12, fr, coords, start[fi] * 2);
  return { coords, start, frame: fr };
}

// Lays the tree flat (sharp hinges) in the root face's plane.
function layout(solid, tree, flat = layoutCoords(solid, tree)) {
  const { parent, via, order } = tree;
  const F = solid.faces.length;
  const prep = prepare(solid);
  const faces = new Array(F);
  for (const fi of order) {
    const p = parent[fi];
    if (p < 0) {
      faces[fi] = { parent: -1, hinge: null, angle: 0, depth: 0, children: [] };
      continue;
    }
    // Hinge edge as it runs in the parent (a -> b, parent's CCW order).
    const { a, b, angle } = hingeOf(solid, prep, p, fi, via[fi]);
    faces[fi] = { parent: p, hinge: [a, b], angle, depth: faces[p].depth + 1, children: [] };
    faces[p].children.push(fi);
  }
  const { coords, start } = flat;
  for (let fi = 0; fi < F; fi++) {
    const c = [];
    for (let k = start[fi]; k < start[fi + 1]; k++) c.push([coords[k * 2], coords[k * 2 + 1]]);
    faces[fi].coords = c;
  }
  return { root: order[0], order: Int32Array.from(order), faces, frame: flat.frame };
}

// Overlapping face pairs of a flat layout (or just past cap); a sweep over box x ranges skips pairs that can't touch.
function overlapCount({ coords, start }, cap = Infinity) {
  const F = start.length - 1;
  const shapes = new ShapeSet(F);
  for (let fi = 0; fi < F; fi++) shapes.set(fi, coords, start[fi] * 2, start[fi + 1] - start[fi]);
  const B = shapes.box;
  const byX = Array.from({ length: F }, (_, i) => i).sort((a, b) => B[a * 4] - B[b * 4]);
  let overlaps = 0;
  for (let i = 0; i < F; i++) {
    const s = byX[i];
    for (let j = i + 1; j < F; j++) {
      const t = byX[j];
      if (B[t * 4] >= B[s * 4 + 2]) break;
      if (shapes.overlaps(s, t) && ++overlaps > cap) return overlaps;
    }
  }
  return overlaps;
}

// Number of overlapping face pairs (faces shrunk slightly so touching is fine).
export function countOverlaps(net) {
  const F = net.faces.length;
  const start = new Int32Array(F + 1);
  for (let fi = 0; fi < F; fi++) start[fi + 1] = start[fi] + net.faces[fi].coords.length;
  const coords = new Float64Array(start[F] * 2);
  net.faces.forEach((f, fi) => f.coords.forEach((p, k) => coords.set(p, (start[fi] + k) * 2)));
  return overlapCount({ coords, start });
}

function netRadius({ coords }) {
  const n = coords.length / 2;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < n; k++) {
    cx += coords[k * 2];
    cy += coords[k * 2 + 1];
  }
  cx /= n;
  cy /= n;
  let r = 0;
  for (let k = 0; k < n; k++) r = Math.max(r, Math.hypot(coords[k * 2] - cx, coords[k * 2 + 1] - cy));
  return r;
}

// Tries overlap-avoiding greedy, breadth-first and steepest-edge trees and keeps
// the one with the fewest overlaps, then the smallest radius.
// Returns { root, order, faces: [{ parent, hinge: [a, b], angle, depth, children, coords }],
// overlaps, radius, frame }; `angle` is the signed fold about a -> b (parent's order).
export function unfold(solid, options) {
  const it = unfoldSteps(solid, options);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// unfold() as a generator that yields between trees, so the search can be spread over frames.
export function* unfoldSteps(solid, { seed = 1, tries = 24 } = {}) {
  const random = rng(seed);
  const F = solid.faces.length;
  const trees = [];
  const roots = [...Array(F).keys()];
  for (let i = F - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [roots[i], roots[j]] = [roots[j], roots[i]];
  }
  yield;
  for (let i = 0; i < Math.ceil(tries / 2); i++) {
    const t = greedyTree(solid, roots[i % F], random);
    if (t) trees.push(t);
    yield;
  }
  for (let i = 0; i < Math.ceil(tries / 4); i++) {
    const t = bfsParents(solid, roots[i % F], i % 2 ? random : null);
    if (t) trees.push(t);
  }
  yield;
  for (let i = 0; trees.length < tries * 1.25 && i < tries * 2; i++) {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const t = steepestEdgeTree(solid, [r * Math.cos(a), r * Math.sin(a), z]);
    if (t) trees.push(t);
    if (i % 4 === 3) yield;
  }
  let best = null;
  for (const tree of trees) {
    const flat = layoutCoords(solid, tree);
    // Counting stops once the tree can no longer beat the best one.
    const overlaps = overlapCount(flat, best ? best.overlaps : Infinity);
    if (best && overlaps > best.overlaps) {
      yield;
      continue;
    }
    const radius = netRadius(flat);
    if (!best || overlaps < best.overlaps || (overlaps === best.overlaps && radius < best.radius)) best = { tree, flat, overlaps, radius };
    yield;
  }
  const net = layout(solid, best.tree, best.flat);
  net.overlaps = best.overlaps;
  net.radius = best.radius;
  return net;
}
