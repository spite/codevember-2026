// Interlace on a surface, shared by knotwork and strapwork: a polygon mesh over the blank (a cube grid, a torus grid,
// or rings of latitude), chosen so the symmetry images map it onto itself. Its medial graph gives the strands: each
// edge midpoint is a crossing, and each face corner carries a piece of strand between the midpoints of its two edges.
// Some edges are breaks, where the strands turn back instead of crossing. Over and under alternate along every strand.
import { rnd, applyImage, radialPoint } from "../kit.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export { sub, add, scale, dot, cross, len, lerp };

// A spatial hash of points, for welding and for checking that the images land on vertices.
class PointHash {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  key(i, j, k) {
    return i * 73856093 + j * 19349663 + k * 83492791;
  }
  find(p, tol) {
    const c = this.cell;
    const i0 = Math.floor(p[0] / c);
    const j0 = Math.floor(p[1] / c);
    const k0 = Math.floor(p[2] / c);
    for (let i = i0 - 1; i <= i0 + 1; i++)
      for (let j = j0 - 1; j <= j0 + 1; j++)
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          const b = this.map.get(this.key(i, j, k));
          if (!b) continue;
          for (const [q, id] of b) if (Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < tol) return id;
        }
    return -1;
  }
  add(p, id) {
    const c = this.cell;
    const k = this.key(Math.floor(p[0] / c), Math.floor(p[1] / c), Math.floor(p[2] / c));
    const b = this.map.get(k);
    if (b) b.push([p, id]);
    else this.map.set(k, [[p, id]]);
  }
}

// A mesh from raw points and faces: welds coincident points and orients every face counter-clockwise from outside.
function makeMesh(shape, rawPts, rawFaces) {
  const hash = new PointHash(0.02);
  const V = [];
  const N = [];
  const remap = rawPts.map((p) => {
    // A blank can map the sphere's directions onto itself its own way, to keep the cells even.
    if (shape.radialMap) p = shape.radialMap(p);
    else if (shape.radial) p = radialPoint(shape, p);
    const q = shape.project(p[0], p[1], p[2]);
    const pp = [q[0], q[1], q[2]];
    let id = hash.find(pp, 1e-6);
    if (id < 0) {
      id = V.length;
      V.push(pp);
      N.push([q[3], q[4], q[5]]);
      hash.add(pp, id);
    }
    return id;
  });
  const F = [];
  for (const f of rawFaces) {
    const loop = [];
    for (const i of f) {
      const id = remap[i];
      if (loop[loop.length - 1] !== id && loop[0] !== id) loop.push(id);
    }
    if (loop.length < 3) continue;
    // Orientation: the polygon's area vector against the outward normal at its centre.
    const c = loop.reduce((s, i) => add(s, V[i]), [0, 0, 0]).map((x) => x / loop.length);
    let a = [0, 0, 0];
    for (let k = 0; k < loop.length; k++) a = add(a, cross(sub(V[loop[k]], c), sub(V[loop[(k + 1) % loop.length]], c)));
    const q = shape.project(c[0], c[1], c[2]);
    if (dot(a, [q[3], q[4], q[5]]) < 0) loop.reverse();
    F.push(loop);
  }
  return { V, N, F, hash };
}

function cubeMesh(shape, n, equiangular, rot) {
  const pts = [];
  const faces = [];
  const s = shape.bounds[0];
  for (const [a, b, c, sign] of [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]]) {
    const base = pts.length;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        let u = (i / n) * 2 - 1;
        let v = (j / n) * 2 - 1;
        if (equiangular) (u = Math.tan((u * Math.PI) / 4)), (v = Math.tan((v * Math.PI) / 4));
        const p = [0, 0, 0];
        p[c] = sign * s;
        p[a] = u * s * sign;
        p[b] = v * s;
        pts.push(rot ? [dot(rot[0], p), dot(rot[1], p), dot(rot[2], p)] : p);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = base + j * (n + 1) + i;
        faces.push([k, k + 1, k + n + 2, k + n + 1]);
      }
  }
  return makeMesh(shape, pts, faces);
}

function torusMesh(shape, nu, nv) {
  const { R, r } = shape;
  const pts = [];
  const faces = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const u = (i / nu) * Math.PI * 2;
      const v = ((j + 0.5) / nv) * Math.PI * 2;
      pts.push([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]);
      const i1 = (i + 1) % nu;
      const j1 = (j + 1) % nv;
      faces.push([j * nu + i, j * nu + i1, j1 * nu + i1, j1 * nu + i]);
    }
  return makeMesh(shape, pts, faces);
}

// Rings of latitude about `cell` apart, each with 12·2^k points (k growing toward the equator), and a 12-gon cap at
// each pole. Between rings of different counts the faces are pentagons.
function latLongMesh(shape, cell) {
  const lat0 = Math.acos(Math.min(0.9, (12 * cell) / (2 * Math.PI)));
  const rings = Math.max(2, Math.round((2 * lat0) / cell) + 1);
  const pts = [];
  const ring = [];
  for (let j = 0; j < rings; j++) {
    const lat = lat0 - (j / (rings - 1)) * 2 * lat0;
    let M = 12;
    while (M * 2 * cell <= 2 * Math.PI * Math.cos(lat) * 1.2) M *= 2;
    const ids = [];
    for (let i = 0; i < M; i++) {
      const a = (i / M) * Math.PI * 2;
      ids.push(pts.length);
      pts.push([Math.cos(lat) * Math.cos(a), Math.sin(lat), Math.cos(lat) * Math.sin(a)]);
    }
    ring.push(ids);
  }
  const faces = [];
  for (let j = 0; j < rings - 1; j++) {
    const A = ring[j];
    const B = ring[j + 1];
    const big = A.length >= B.length ? A : B;
    const small = big === A ? B : A;
    const r = big.length / small.length;
    for (let k = 0; k < small.length; k++) {
      const top = [];
      for (let i = 0; i <= r; i++) top.push(big[(k * r + i) % big.length]);
      const bot = [small[(k + 1) % small.length], small[k]];
      faces.push(big === A ? [...top, ...bot] : [...bot.reverse(), ...top.reverse()]);
    }
  }
  faces.push(ring[0].slice());
  faces.push(ring[rings - 1].slice());
  return makeMesh(shape, pts, faces);
}

const symmetric = (mesh, images) => images.every((m) => mesh.V.every((p) => mesh.hash.find(applyImage(m, p), 2e-4) >= 0));

// The mesh with cells about `cell` across, mapped onto itself by every image if any candidate is.
export function weaveMesh(shape, cell, images) {
  const cands = [];
  if (shape.quadGrid) {
    cands.push(() => {
      const { pos, quads, cell: actual } = shape.quadGrid(cell);
      const pts = [];
      for (let i = 0; i < pos.length; i += 3) pts.push([pos[i], pos[i + 1], pos[i + 2]]);
      const mesh = makeMesh(shape, pts, quads);
      // A grid that can't be as coarse as asked says what it is, and the pattern sizes to that.
      if (actual) mesh.cell = actual;
      return mesh;
    });
  } else if (shape.h !== undefined) {
    const n = Math.max(3, Math.round((2 * shape.h) / cell));
    cands.push(() => cubeMesh(shape, n, false));
  } else if (shape.R !== undefined) {
    const nu = Math.max(12, Math.round((2 * Math.PI * shape.R) / cell / 12) * 12);
    const nv = Math.max(4, Math.round((2 * Math.PI * shape.r) / cell / 2) * 2);
    cands.push(() => torusMesh(shape, nu, nv));
  } else {
    const n = Math.max(3, Math.round(Math.PI / 2 / cell));
    cands.push(() => cubeMesh(shape, n, true));
    // The cube with a diagonal up and a mirror plane on x = 0, for 3-fold symmetry about y.
    const ex = [1 / Math.SQRT2, -1 / Math.SQRT2, 0];
    const ey = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    cands.push(() => cubeMesh(shape, n, true, [ex, ey, cross(ex, ey)]));
    cands.push(() => latLongMesh(shape, cell));
  }
  let first = null;
  for (const make of cands) {
    const mesh = make();
    first ??= mesh;
    if (symmetric(mesh, images)) return (mesh.symmetric = true), mesh;
  }
  first.symmetric = !images.length;
  return first;
}

/*
 * Strands of the medial graph. breakAt(edge) returns 0 (a crossing), 1 (a break along the edge: each strand turns
 * back on its own side) or 2 (a break across it: each strand wraps around the nearer vertex).
 * Returns { edges, loops }: each loop a closed list of steps { f, u, e } (the corner piece of face f at vertex u,
 * leaving through edge e), and at each edge its crossing kind and which strand passes over.
 */
export function weaveStrands(mesh, breakAt) {
  const { V, F } = mesh;
  const edges = new Map();
  const ekey = (a, b) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  F.forEach((loop, f) => {
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      const key = ekey(a, b);
      let e = edges.get(key);
      if (!e) edges.set(key, (e = { v: a, w: b, faces: [], mid: lerp(V[a], V[b], 0.5) }));
      e.faces.push(f);
    }
  });
  for (const e of edges.values()) {
    e.vp = V[e.v];
    e.wp = V[e.w];
    e.np = mesh.N[e.v];
    e.kind = e.faces.length === 2 ? breakAt(e) : 1;
  }
  // The two edges at corner u of face f.
  const cornerEdges = (f, u) => {
    const loop = F[f];
    const k = loop.indexOf(u);
    const prev = loop[(k + loop.length - 1) % loop.length];
    const next = loop[(k + 1) % loop.length];
    return [edges.get(ekey(prev, u)), edges.get(ekey(u, next))];
  };
  // Where a strand arriving at edge e from the corner (f, u) goes on: the corner (f2, u2) on the far side.
  const across = (e, f, u) => {
    const other = e.v === u ? e.w : e.v;
    const f2 = e.faces[0] === f ? e.faces[1] ?? f : e.faces[0];
    if (e.kind === 0) return [f2, other];
    if (e.kind === 1) return [f, other];
    return [f2, u];
  };
  const seen = new Set();
  const loops = [];
  F.forEach((loop, f0) => {
    for (const u0 of loop) {
      if (seen.has(f0 * 1e7 + u0)) continue;
      const steps = [];
      let f = f0;
      let u = u0;
      // Leave each corner through the edge it was not entered by.
      let entered = cornerEdges(f, u)[0];
      for (let guard = 0; guard < 100000; guard++) {
        seen.add(f * 1e7 + u);
        const [e1, e2] = cornerEdges(f, u);
        const out = e1 === entered ? e2 : e1;
        steps.push({ f, u, e: out, from: entered });
        [f, u] = across(out, f, u);
        entered = out;
        if (f === f0 && u === u0) break;
      }
      loops.push(steps);
    }
  });
  // Over or under, alternating: a strand passes over where it has the vertex region (around `u`) to its right.
  for (const steps of loops)
    for (const st of steps) {
      const e = st.e;
      if (e.kind !== 0) continue;
      const c = F[st.f].reduce((s, i) => add(s, V[i]), [0, 0, 0]).map((x) => x / F[st.f].length);
      const dir = sub(e.mid, c);
      const n = mesh.N[st.u];
      st.over = dot(cross(dir, sub(V[st.u], e.mid)), n) < 0;
    }
  return { edges, loops };
}

export const faceCentre = (mesh, f) => mesh.F[f].reduce((s, i) => add(s, mesh.V[i]), [0, 0, 0]).map((x) => x / mesh.F[f].length);

// Random breaks, the same over each orbit of the symmetry, and forced at mirror planes (a mirrored crossing can't
// keep its over and under). kind: 1 along the edge, 2 across it.
export function symmetricBreaks(images, inDomain, chance, pick, wall = null) {
  const memo = new Map();
  return (e) => {
    const m0 = e.mid;
    for (const m of images) {
      const q = applyImage(m, m0);
      if (Math.abs(q[0] - m0[0]) + Math.abs(q[1] - m0[1]) + Math.abs(q[2] - m0[2]) < 1e-5 && m.det < 0) {
        // On the plane: the edge lies in it (along) or crosses it.
        const qv = applyImage(m, e.vp);
        return Math.abs(qv[0] - e.vp[0]) + Math.abs(qv[1] - e.vp[1]) + Math.abs(qv[2] - e.vp[2]) < 1e-5 ? 1 : 2;
      }
    }
    let rep = m0;
    if (!inDomain(m0))
      for (const m of images) {
        const q = applyImage(m, m0);
        if (inDomain(q)) {
          rep = q;
          break;
        }
      }
    const key = rep.map((x) => Math.round(x * 1e4)).join();
    if (!memo.has(key)) memo.set(key, wall?.(rep, e, m0) ? 1 : rnd() < chance ? pick() : 0);
    return memo.get(key);
  };
}
