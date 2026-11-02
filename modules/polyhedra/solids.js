// Polyhedra as { vertices: [[x, y, z]], faces: [[i, j, k, ...]] }, faces CCW seen
// from outside, centred, circumradius 1. Built with Conway operators from a
// tetrahedron seed and canonicalized (edges tangent to the unit sphere).

import {
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  normalize,
  lerp,
  centroid,
  newell,
  faceNormal,
  planeBasis,
} from "./geom.js";

const clone = (s) => ({
  vertices: s.vertices.map((v) => v.slice()),
  faces: s.faces.map((f) => f.slice()),
});

export function edgesOf(solid) {
  const seen = new Set();
  const edges = [];
  const n = solid.vertices.length;
  for (const f of solid.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const key = Math.min(a, b) * n + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return edges;
}

// For each vertex: incident faces and outgoing neighbours, CCW seen from outside;
// faces[j] contains the edge v -> neighbors[j].
export function vertexCycles(solid) {
  const n = solid.vertices.length;
  const owner = new Map();
  const start = new Array(n).fill(-1);
  solid.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      owner.set(f[i] * n + f[(i + 1) % f.length], fi);
      if (start[f[i]] < 0) start[f[i]] = fi;
    }
  });
  const cycles = [];
  for (let v = 0; v < n; v++) {
    const faces = [];
    const neighbors = [];
    let fi = start[v];
    let guard = 0;
    do {
      const f = solid.faces[fi];
      const next = f[(f.indexOf(v) + 1) % f.length];
      faces.push(fi);
      neighbors.push(next);
      fi = owner.get(next * n + v);
      if (fi === undefined) throw new Error("vertexCycles: open surface");
    } while (fi !== start[v] && guard++ < 1000);
    // Walking across outgoing edges goes CW; flip to CCW.
    cycles.push({ faces: faces.reverse(), neighbors: neighbors.reverse() });
  }
  return cycles;
}

function builder() {
  const keys = new Map();
  const vertices = [];
  const faces = [];
  return {
    v(key, p) {
      if (!keys.has(key)) {
        keys.set(key, vertices.length);
        vertices.push(p);
      }
      return keys.get(key);
    },
    face(f) {
      faces.push(f);
    },
    done: () => ({ vertices, faces }),
  };
}

const pt = (s, f) => centroid(f.map((i) => s.vertices[i]));

// --- Conway operators (topological; positions are rough, canonicalize after) ---

export function dual(s) {
  const verts = s.faces.map((f) => pt(s, f));
  const faces = vertexCycles(s).map((c) => c.faces);
  return { vertices: verts, faces };
}

export function ambo(s) {
  const b = builder();
  const V = s.vertices;
  const mid = (a, c) => b.v(Math.min(a, c) + "_" + Math.max(a, c), lerp(V[a], V[c], 0.5));
  for (const f of s.faces) b.face(f.map((a, i) => mid(a, f[(i + 1) % f.length])));
  vertexCycles(s).forEach((c, v) => b.face(c.neighbors.map((n) => mid(v, n))));
  return b.done();
}

// Topological truncation (cuts at 1/3); see truncate() for the geometric one.
export function truncateTopo(s) {
  const b = builder();
  const V = s.vertices;
  const p = (a, c) => b.v(a + ">" + c, lerp(V[a], V[c], 1 / 3));
  for (const f of s.faces) {
    const nf = [];
    f.forEach((a, i) => {
      const c = f[(i + 1) % f.length];
      nf.push(p(a, c), p(c, a));
    });
    b.face(nf);
  }
  vertexCycles(s).forEach((c, v) => b.face(c.neighbors.map((n) => p(v, n))));
  return b.done();
}

export function gyro(s) {
  const b = builder();
  const V = s.vertices;
  const p = (a, c) => b.v(a + ">" + c, lerp(V[a], V[c], 1 / 3));
  s.faces.forEach((f, fi) => {
    const c = b.v("c" + fi, pt(s, f));
    for (let i = 0; i < f.length; i++) {
      const v1 = f[i];
      const v2 = f[(i + 1) % f.length];
      const v3 = f[(i + 2) % f.length];
      b.face([c, p(v1, v2), p(v2, v1), b.v("v" + v2, V[v2]), p(v2, v3)]);
    }
  });
  return b.done();
}

// Pyramid on every face; apex at centroid + normal * height (negative = pushed in).
export function kis(s, height = 0.1, filter = null) {
  const vertices = s.vertices.map((v) => v.slice());
  const faces = [];
  s.faces.forEach((f, fi) => {
    if (filter && !filter(f, fi)) {
      faces.push(f.slice());
      return;
    }
    const c = pt(s, f);
    const n = faceNormal(s.vertices, f);
    const apex = vertices.length;
    vertices.push(add(c, scale(n, height)));
    for (let i = 0; i < f.length; i++) faces.push([f[i], f[(i + 1) % f.length], apex]);
  });
  return { vertices, faces };
}

// Geometric truncation: cuts each vertex with a plane normal to its direction,
// `amount` (0..0.5) of the way along its shortest edge, so new faces are planar.
export function truncate(s, amount = 1 / 3) {
  amount = Math.min(Math.max(amount, 1e-4), 0.4999);
  const V = s.vertices;
  const cycles = vertexCycles(s);
  const b = builder();
  const cut = cycles.map((c, v) => {
    const d = normalize(V[v]);
    const depths = c.neighbors.map((n) => dot(sub(V[v], V[n]), d));
    return { d, depth: amount * Math.min(...depths) };
  });
  const p = (a, c) => {
    const k = cut[a];
    const t = k.depth / dot(sub(V[a], V[c]), k.d);
    return b.v(a + ">" + c, lerp(V[a], V[c], t));
  };
  for (const f of s.faces) {
    const nf = [];
    f.forEach((a, i) => {
      const c = f[(i + 1) % f.length];
      nf.push(p(a, c), p(c, a));
    });
    b.face(nf);
  }
  cycles.forEach((c, v) => b.face(c.neighbors.map((n) => p(v, n))));
  return b.done();
}

// --- canonical form ---

const tangentPoint = (a, b) => {
  const d = sub(b, a);
  return sub(a, scale(d, dot(d, a) / dot(d, d)));
};

// Hart's canonicalization: edges tangent to the unit sphere, tangent points
// centred, faces planar.
export function canonicalize(s, { iterations = 40000, tolerance = 1e-12 } = {}) {
  const edges = edgesOf(s);
  let V = s.vertices.map((v) => v.slice());
  for (let it = 0; it < iterations; it++) {
    const old = V.map((v) => v.slice());
    for (const [a, b] of edges) {
      const t = tangentPoint(V[a], V[b]);
      const c = scale(t, 1 - length(t));
      V[a] = add(V[a], c);
      V[b] = add(V[b], c);
    }
    let center = [0, 0, 0];
    for (const [a, b] of edges) center = add(center, tangentPoint(V[a], V[b]));
    center = scale(center, 1 / edges.length);
    V = V.map((v) => sub(v, center));
    const next = V.map((v) => v.slice());
    for (const f of s.faces) {
      const pts = f.map((i) => V[i]);
      let n = normalize(newell(pts));
      const c = centroid(pts);
      if (dot(n, c) < 0) n = scale(n, -1);
      for (const i of f) next[i] = add(next[i], scale(n, 0.5 * dot(n, sub(c, V[i]))));
    }
    V = next;
    let change = 0;
    for (let i = 0; i < V.length; i++) change = Math.max(change, length(sub(V[i], old[i])));
    if (change < tolerance) break;
  }
  return { vertices: V, faces: s.faces.map((f) => f.slice()) };
}

// Polar reciprocal about the unit sphere: exact, planar dual of a canonical solid.
export function reciprocal(s) {
  const vertices = s.faces.map((f) => {
    const n = faceNormal(s.vertices, f);
    let d = 0;
    for (const i of f) d += dot(n, s.vertices[i]);
    return scale(n, f.length / d);
  });
  return { vertices, faces: vertexCycles(s).map((c) => c.faces) };
}

export function normalizeSolid(s, radius = 1) {
  const c = centroid(s.vertices);
  let r = 0;
  for (const v of s.vertices) r = Math.max(r, length(sub(v, c)));
  return {
    vertices: s.vertices.map((v) => scale(sub(v, c), radius / r)),
    faces: s.faces.map((f) => f.slice()),
  };
}

// --- Kepler–Poinsot: outer visible surface of self-intersecting star solids ---

// faceCycles may be star polygons (e.g. pentagrams); the visible surface is the
// farthest hit along rays from the centre (the solids are star-shaped).
export function outerSurface(vertices, faceCycles) {
  const faces = faceCycles.map((cycle) => {
    const pts = cycle.map((i) => vertices[i]);
    let n = normalize(newell(pts));
    // Star cycles can cancel Newell's sum; fall back to the first non-degenerate triple.
    if (!isFinite(n[0]) || length(newell(pts)) < 1e-9) {
      n = normalize(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    }
    let d = dot(n, pts[0]);
    if (d < 0) {
      n = scale(n, -1);
      d = -d;
    }
    const { e1, e2 } = planeBasis(n, sub(pts[1], pts[0]));
    const to2 = (p) => [dot(p, e1), dot(p, e2)];
    return { n, d, e1, e2, o: scale(n, d), poly: pts.map(to2), to2 };
  });
  const winding = (poly, p) => {
    let w = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const c = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) {
        if (b[1] > p[1] && c > 0) w++;
      } else if (b[1] <= p[1] && c < 0) w--;
    }
    return w;
  };
  const insideFace = (F, p) => winding(F.poly, F.to2(p)) !== 0;

  const scaleRef = Math.max(...vertices.map(length));
  const eps = 1e-9 * scaleRef;
  const cells = [];
  faces.forEach((A, ai) => {
    let polys = [hull2D(A.poly)];
    const lines = [];
    faces.forEach((B, bi) => {
      if (bi === ai) return;
      // B's plane restricted to A's: a·x + b·y = c in A's 2D frame.
      const a = dot(B.n, A.e1);
      const b = dot(B.n, A.e2);
      if (Math.hypot(a, b) < 1e-9) return;
      lines.push([a, b, B.d - dot(B.n, A.o)]);
    });
    for (const l of lines) {
      const out = [];
      for (const p of polys) out.push(...splitConvex(p, l, eps));
      polys = out;
    }
    for (const p of polys) {
      const c2 = centroid2D(p);
      const to3 = (q) => add(A.o, add(scale(A.e1, q[0]), scale(A.e2, q[1])));
      if (!insideFace(A, to3(c2))) continue;
      // Off-centre samples so no ray passes exactly through another face's edge.
      const samples = [
        [0.31, 0.17],
        [0.13, 0.42],
        [0.23, 0.07],
      ].map(([u, w]) => {
        const a = p[0];
        const b = p[1 + (p.length > 3 ? 1 : 0)];
        return to3([
          c2[0] + u * (a[0] - c2[0]) + w * (b[0] - c2[0]),
          c2[1] + u * (a[1] - c2[1]) + w * (b[1] - c2[1]),
        ]);
      });
      let hidden = false;
      for (let bi = 0; bi < faces.length && !hidden; bi++) {
        if (bi === ai) continue;
        const B = faces[bi];
        for (const c3 of samples) {
          const den = dot(B.n, c3);
          if (den <= 1e-12) continue;
          const s = B.d / den;
          if (s > 1 + 1e-9 && insideFace(B, scale(c3, s))) hidden = true;
        }
      }
      if (hidden) continue;
      cells.push({
        face: ai,
        pts: p.map(to3),
      });
    }
  });
  return mergeCoplanarCells(cells, faces.map((f) => f.n), scaleRef);
}

function hull2D(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cr(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function splitConvex(poly, [a, b, c], eps) {
  const s = poly.map((p) => a * p[0] + b * p[1] - c);
  if (s.every((v) => v >= -eps) || s.every((v) => v <= eps)) return [poly];
  const pos = [];
  const neg = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const p = poly[i];
    const q = poly[j];
    if (s[i] >= -eps) pos.push(p);
    if (s[i] <= eps) neg.push(p);
    if ((s[i] > eps && s[j] < -eps) || (s[i] < -eps && s[j] > eps)) {
      const t = s[i] / (s[i] - s[j]);
      const x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      pos.push(x);
      neg.push(x);
    }
  }
  return [pos, neg].filter((p) => p.length >= 3);
}

const centroid2D = (p) => {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q[0];
    y += q[1];
  }
  return [x / p.length, y / p.length];
};

// Welds cell corners, merges same-plane cells into polygons and drops
// collinear vertices that sit on a straight edge between two faces.
function mergeCoplanarCells(cells, normals, scaleRef) {
  const tol = 1e-7 * scaleRef;
  const vertices = [];
  const grid = new Map();
  const cellKey = (x, y, z) => x + "," + y + "," + z;
  const weld = (p) => {
    const g = p.map((v) => Math.round(v / (tol * 10)));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(cellKey(g[0] + dx, g[1] + dy, g[2] + dz));
          if (!list) continue;
          for (const i of list) if (length(sub(vertices[i], p)) < tol) return i;
        }
    const k = cellKey(...g);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(vertices.length);
    vertices.push(p);
    return vertices.length - 1;
  };
  const polys = [];
  for (const c of cells) {
    const idx = [];
    for (const p of c.pts) {
      const i = weld(p);
      if (idx.at(-1) !== i) idx.push(i);
    }
    while (idx.length > 1 && idx[0] === idx.at(-1)) idx.pop();
    if (idx.length >= 3) polys.push({ face: c.face, idx });
  }

  // Union same-face cells that share an edge.
  const parent = polys.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edgeOwner = new Map();
  polys.forEach((p, pi) => {
    for (let i = 0; i < p.idx.length; i++) {
      const a = p.idx[i];
      const b = p.idx[(i + 1) % p.idx.length];
      const k = Math.min(a, b) + "_" + Math.max(a, b);
      const o = edgeOwner.get(k);
      if (o !== undefined && polys[o].face === p.face) parent[find(o)] = find(pi);
      else edgeOwner.set(k, pi);
    }
  });
  const groups = new Map();
  polys.forEach((p, pi) => {
    const r = find(pi);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });

  let faces = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      faces.push(group[0].idx);
      continue;
    }
    const directed = new Set();
    for (const p of group)
      for (let i = 0; i < p.idx.length; i++) directed.add(p.idx[i] + ">" + p.idx[(i + 1) % p.idx.length]);
    const next = new Map();
    let pinch = false;
    for (const e of directed) {
      const [a, b] = e.split(">").map(Number);
      if (directed.has(b + ">" + a)) continue;
      if (next.has(a)) pinch = true;
      next.set(a, b);
    }
    const loop = [];
    if (!pinch && next.size) {
      let v = next.keys().next().value;
      do {
        loop.push(v);
        v = next.get(v);
      } while (v !== undefined && v !== loop[0] && loop.length <= next.size);
    }
    if (pinch || loop.length !== next.size) for (const p of group) faces.push(p.idx);
    else faces.push(loop);
  }

  // Remove vertices lying on a straight edge shared by exactly two faces.
  for (let pass = 0; pass < 4; pass++) {
    const uses = new Map();
    faces.forEach((f, fi) => f.forEach((v) => uses.set(v, (uses.get(v) || 0) + 1)));
    const collinearIn = (f, k) => {
      const a = vertices[f[(k + f.length - 1) % f.length]];
      const b = vertices[f[k]];
      const c = vertices[f[(k + 1) % f.length]];
      const u = sub(b, a);
      const w = sub(c, b);
      return length(cross(u, w)) < 1e-9 * length(u) * length(w) && dot(u, w) > 0;
    };
    const drop = new Set();
    for (const [v, n] of uses) {
      if (n !== 2) continue;
      if (faces.every((f) => !f.includes(v) || collinearIn(f, f.indexOf(v)))) drop.add(v);
    }
    if (!drop.size) break;
    faces = faces.map((f) => f.filter((v) => !drop.has(v)));
  }

  // Compact.
  const remap = new Map();
  const out = [];
  faces = faces.map((f) =>
    f.map((v) => {
      if (!remap.has(v)) {
        remap.set(v, out.length);
        out.push(vertices[v]);
      }
      return remap.get(v);
    }),
  );
  return { vertices: out, faces };
}

// --- seeds and recipes ---

const T = {
  vertices: [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ],
  faces: [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ],
};

const memo = new Map();
const once = (key, fn) => () => {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};
const canon = (fn) => () => canonicalize(fn());

const C = {};
C.T = once("T", canon(() => clone(T)));
C.O = once("O", canon(() => ambo(C.T())));
C.C = once("C", () => reciprocal(C.O()));
C.I = once("I", () => reciprocal(canonicalize(gyro(C.T()))));
C.D = once("D", () => reciprocal(C.I()));

// Archimedean (canonical, midradius 1); snubs come from canonical gyro duals.
const arch = {
  truncatedTetrahedron: once("tT", canon(() => truncateTopo(C.T()))),
  cuboctahedron: once("aC", canon(() => ambo(C.C()))),
  truncatedCube: once("tC", canon(() => truncateTopo(C.C()))),
  truncatedOctahedron: once("tO", canon(() => truncateTopo(C.O()))),
  rhombicuboctahedron: once("eC", canon(() => ambo(ambo(C.C())))),
  truncatedCuboctahedron: once("bC", canon(() => truncateTopo(ambo(C.C())))),
  snubCube: once("sC", () => reciprocal(once("gC", canon(() => gyro(C.C())))())),
  icosidodecahedron: once("aD", canon(() => ambo(C.D()))),
  truncatedDodecahedron: once("tD", canon(() => truncateTopo(C.D()))),
  truncatedIcosahedron: once("tI", canon(() => truncateTopo(C.I()))),
  rhombicosidodecahedron: once("eD", canon(() => ambo(ambo(C.D())))),
  truncatedIcosidodecahedron: once("bD", canon(() => truncateTopo(ambo(C.D())))),
  snubDodecahedron: once("sD", () => reciprocal(once("gD", canon(() => gyro(C.D())))())),
};

const catalanOf = {
  triakisTetrahedron: "truncatedTetrahedron",
  rhombicDodecahedron: "cuboctahedron",
  triakisOctahedron: "truncatedCube",
  tetrakisHexahedron: "truncatedOctahedron",
  deltoidalIcositetrahedron: "rhombicuboctahedron",
  disdyakisDodecahedron: "truncatedCuboctahedron",
  pentagonalIcositetrahedron: "snubCube",
  rhombicTriacontahedron: "icosidodecahedron",
  triakisIcosahedron: "truncatedDodecahedron",
  pentakisDodecahedron: "truncatedIcosahedron",
  deltoidalHexecontahedron: "rhombicosidodecahedron",
  disdyakisTriacontahedron: "truncatedIcosidodecahedron",
  pentagonalHexecontahedron: "snubDodecahedron",
};

function ringsOfIcosahedron(I) {
  return vertexCycles(I).map((c) => c.neighbors);
}

const kepler = {
  smallStellatedDodecahedron: () => {
    const I = C.I();
    const faces = ringsOfIcosahedron(I).map((r) => [0, 2, 4, 1, 3].map((k) => r[k]));
    return outerSurface(I.vertices, faces);
  },
  greatDodecahedron: () => {
    const I = C.I();
    return outerSurface(I.vertices, ringsOfIcosahedron(I));
  },
  greatStellatedDodecahedron: () => {
    // Pentagrams through the second ring of dodecahedron vertices around each face axis.
    const D = C.D();
    const faces = C.I().vertices.map((axis) => {
      const n = normalize(axis);
      const h = D.vertices.map((v, i) => [dot(v, n), i]).sort((a, b) => b[0] - a[0]);
      const ring = h.slice(5, 10).map(([, i]) => i);
      const { e1, e2 } = planeBasis(n);
      ring.sort((a, b) => {
        const pa = D.vertices[a];
        const pb = D.vertices[b];
        return Math.atan2(dot(pa, e2), dot(pa, e1)) - Math.atan2(dot(pb, e2), dot(pb, e1));
      });
      return [0, 2, 4, 1, 3].map((k) => ring[k]);
    });
    return outerSurface(D.vertices, faces);
  },
  greatIcosahedron: () => {
    const V = C.I().vertices;
    const d = V.map((a) => V.map((b) => length(sub(a, b))));
    const edge = Math.min(...d[0].filter((x) => x > 1e-9));
    const far = (i, j) => Math.abs(d[i][j] - edge * (1 + Math.sqrt(5)) / 2) < 1e-6 * edge;
    const faces = [];
    for (let i = 0; i < V.length; i++)
      for (let j = i + 1; j < V.length; j++)
        for (let k = j + 1; k < V.length; k++)
          if (far(i, j) && far(j, k) && far(i, k)) faces.push([i, j, k]);
    return outerSurface(V, faces);
  },
};

const recipes = {
  tetrahedron: C.T,
  cube: C.C,
  octahedron: C.O,
  dodecahedron: C.D,
  icosahedron: C.I,
  ...arch,
};
for (const [name, of] of Object.entries(catalanOf)) recipes[name] = () => reciprocal(arch[of]());
Object.assign(recipes, kepler);

export const families = {
  platonic: ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"],
  archimedean: Object.keys(arch),
  catalan: Object.keys(catalanOf),
  keplerPoinsot: Object.keys(kepler),
};

// Lazily built on first access, then cached.
export const solids = {};
for (const [name, make] of Object.entries(recipes)) {
  Object.defineProperty(solids, name, {
    enumerable: true,
    configurable: true,
    get() {
      const s = normalizeSolid(make());
      s.name = name;
      Object.defineProperty(solids, name, { value: s, enumerable: true });
      return s;
    },
  });
}

export function getSolid(name) {
  const s = solids[name];
  if (!s) throw new Error(`Unknown solid "${name}"`);
  return s;
}
