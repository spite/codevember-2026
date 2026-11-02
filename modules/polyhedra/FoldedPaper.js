// Paper polyhedron that folds from its flat net. Faces are rigid flat parts;
// each hinge is a crease strip that is an exact fillet between the two faces at
// every fold angle, tapering to a sharp point at the edge's vertices so faces
// still meet there and the folded solid closes.

import { BufferGeometry, BufferAttribute, Quaternion, Matrix4, Vector3, Sphere } from "three";
import { unfoldSteps, edgeKey } from "./net.js";
import { edgesOf } from "./solids.js";
import {
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  normalize,
  centroid,
  faceNormal,
  rotationMatrix,
  identity,
  compose,
  apply,
  planeBasis,
  triangulate,
  rng,
} from "./geom.js";

export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

const angleAt = (V, f, i) => {
  const p = V[f[i]];
  const a = normalize(sub(V[f[(i + f.length - 1) % f.length]], p));
  const b = normalize(sub(V[f[(i + 1) % f.length]], p));
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
};

// Set while FoldedPaper.create() runs the constructor, which then leaves the build steps to it.
let deferring = false;

export class FoldedPaper extends BufferGeometry {
  // solid: { vertices, faces } from solids.js (or kis()/truncate() of one).
  // size scales the solid (circumradius 1 -> size); creaseRadius and thickness
  // are fractions of the mean edge length; creaseTaper is the fraction of each
  // edge over which a crease narrows to its vertex. The `crease` attribute is the
  // fillet weight (0 on flat faces, 1 mid-fold), negative on valley folds.
  // Opt-in: foldingCreaseRadius (radius while a hinge is open, eased to creaseRadius when shut),
  // faceSubdivisions (each face becomes 4x this many rings around its centroid so `pillow` can bow it; with
  // adaptiveRings, faces smaller than half the circumradius in inradius get proportionally fewer, at least 2), pillow (max face bow, fraction
  // of the mean edge, seeded per face), hingeJitter (max degrees each hinge stops short of shut;
  // opens the seams), creaseJitter (± fraction of per-hinge crease radius variation), cornerRound
// (blunts convex peaks once folded: tip pulled in by this fraction of the mean edge), staticValley (the
  // `valley` attribute keeps its folded depth instead of scaling it by easing(fold) each frame; for shaders that do it).
  constructor(solid, options = {}) {
    super();
    const steps = this._build(solid, options);
    if (deferring) this._steps = steps;
    else while (!steps.next().done);
  }

  // Generator form of the constructor: yields between build stages (and net search trees), returns the geometry.
  static *create(solid, options = {}) {
    deferring = true;
    let g;
    try {
      g = new FoldedPaper(solid, options);
    } finally {
      deferring = false;
    }
    yield* g._steps;
    delete g._steps;
    return g;
  }

  *_build(solid, options) {
    this.type = "FoldedPaper";
    const o = {
      size: 1,
      creaseRadius: 0.015,
      creaseSegments: 4,
      creaseTaper: 0.2,
      taperSegments: 3,
      thickness: 0,
      stagger: 0.6,
      layFlat: true,
      easing: easeInOutCubic,
      seed: 1,
      tries: 24,
      net: null,
      fold: 1,
      foldingCreaseRadius: null,
      faceSubdivisions: 0,
      adaptiveRings: false,
      pillow: 0,
      hingeJitter: 0,
      creaseJitter: 0,
      cornerRound: 0,
      staticValley: false,
      ...options,
    };
    this.options = o;
    this.solid = solid;
    const net = o.net || (yield* unfoldSteps(solid, { seed: o.seed, tries: o.tries }));
    const c = this._setup(o, net);
    yield;
    this._mesh(c);
    // Faces in batches of about 6000 vertices.
    for (let f0 = 0, F = solid.faces.length; f0 < F; ) {
      let f1 = f0;
      while (f1 < F && c.faceStart[f1 + 1] - c.faceStart[f0] < 6000) f1++;
      f1 = Math.max(f1, f0 + 1);
      this._meshFaces(c, f0, f1);
      f0 = f1;
      yield;
    }
    this._meshCreases(c);
    yield;
    this._assemble(c);
    yield;
    c.valleyRest = this._valleyGeometry(c.P0, c.N, c.faceIdArr, c.V, c.F, c.normals, c.inradius, c.centroids);
    yield;
    this._flat(c);
    yield;
    this._finish(c);
    yield;
    this.setFold(o.fold);
  }

  // Build stages, kept out of the generator so their loops get optimised.
  _setup(o, net) {
    const solid = this.solid;
    const V = solid.vertices.map((v) => scale(v, o.size));
    const F = solid.faces;
    this.net = net;
    this.restVertices = V;
    this.boundingRadius = Math.max(...V.map(length));

    const edges = edgesOf(solid);
    const meanEdge = edges.reduce((s, [a, b]) => s + length(sub(V[a], V[b])), 0) / edges.length;
    const S = Math.max(1, Math.round(o.creaseSegments));
    const K = Math.max(1, Math.round(o.taperSegments));
    const tau = Math.min(Math.max(o.creaseTaper, 0.01), 0.5);
    this.segments = S;

    // Crease rows along an edge (s = 0..1) and the taper profile at each.
    const rowS = [0];
    for (let k = 1; k <= K; k++) rowS.push((tau * k) / K);
    for (let k = K; k >= 1; k--) if (1 - (tau * k) / K > rowS.at(-1) + 1e-9) rowS.push(1 - (tau * k) / K);
    if (rowS.at(-1) < 1 - 1e-9) rowS.push(1);
    const profile = rowS.map((s) => Math.sin((Math.PI / 2) * Math.min(1, Math.min(s, 1 - s) / tau)));
    this._rowS = rowS;
    this._profile = profile;
    const rows = rowS.length;

    const normals = F.map((f) => faceNormal(V, f));
    const centroids = F.map((f) => centroid(f.map((i) => V[i])));
    const inradius = F.map((f, fi) => {
      const c = centroids[fi];
      let r = Infinity;
      for (let i = 0; i < f.length; i++) {
        const a = V[f[i]];
        const b = V[f[(i + 1) % f.length]];
        const t = normalize(sub(b, a));
        const d = sub(c, a);
        r = Math.min(r, length(sub(d, scale(t, dot(d, t)))));
      }
      return r;
    });

    // Hinges, one per non-root face; `off` is the tangent distance of the fillet.
    const random = rng((o.seed ^ 0x9e3779b9) >>> 0);
    const maxDepth = Math.max(1, ...net.faces.map((f) => f.depth));
    const hinges = [];
    const hingeOfEdge = new Map();
    const hingeOfFace = new Int32Array(F.length).fill(-1);
    net.faces.forEach((nf, c) => {
      if (nf.parent < 0) return;
      const p = nf.parent;
      const [a, b] = nf.hinge;
      const theta = nf.angle;
      const L = length(sub(V[b], V[a]));
      const u = scale(sub(V[b], V[a]), 1 / L);
      const pf = F[p];
      const cf = F[c];
      const ia = pf.indexOf(a);
      const jb = cf.indexOf(b);
      // Keep both tapers inside the narrowest face corner at either end.
      const corner = Math.min(
        angleAt(V, pf, ia),
        angleAt(V, pf, (ia + 1) % pf.length),
        angleAt(V, cf, jb),
        angleAt(V, cf, (jb + 1) % cf.length),
      );
      const slopeMax = Math.tan(corner * 0.4);
      const offMax = Math.min(0.3 * Math.min(inradius[p], inradius[c]), (slopeMax * tau * L * 2) / Math.PI);
      const offPerRadius = meanEdge * Math.tan(Math.abs(theta) / 2) * (o.creaseJitter ? 1 + (random() * 2 - 1) * o.creaseJitter : 1);
      const off = Math.min(o.creaseRadius * offPerRadius, offMax);
      const dA = cross(normals[p], u);
      const e1 = scale(dA, -1);
      hingeOfFace[c] = hinges.length;
      hingeOfEdge.set(edgeKey(solid, a, b), hinges.length);
      hinges.push({
        child: c,
        parent: p,
        a,
        b,
        L,
        theta,
        u,
        off,
        offMax,
        offPerRadius,
        // Always under-folds, so seams open slightly instead of faces cutting through each other.
        jitter: o.hingeJitter ? -Math.sign(theta) * random() * o.hingeJitter * (Math.PI / 180) : 0,
        dA,
        e1,
        e2: cross(u, e1),
        delay: maxDepth > 1 ? (nf.depth - 1) / (maxDepth - 1) : 0,
        // Valley folds: the faces' normals converge across the edge.
        valley: dot(sub(normals[c], normals[p]), sub(centroids[c], centroids[p])) < 0,
      });
    });
    this.hinges = hinges;
    this._hingeOfFace = hingeOfFace;
    const H = hinges.length;

    // Convex corners only: a hyperbolic cap of depth D, faded out by distance R from the tip.
    const vertexFaces = V.map(() => []);
    F.forEach((f, fi) => f.forEach((vi) => vertexFaces[vi].includes(fi) || vertexFaces[vi].push(fi)));
    const vertexEdges = V.map(() => []);
    for (const e of edges) {
      vertexEdges[e[0]].push(e);
      if (e[1] !== e[0]) vertexEdges[e[1]].push(e);
    }
    this._corners = V.map((C, vi) => {
      let n = [0, 0, 0];
      for (const fi of vertexFaces[vi].sort((a, b) => a - b)) n = add(n, normals[fi]);
      n = normalize(n);
      const nb = vertexEdges[vi].map(([a, b]) => V[a === vi ? b : a]);
      const minEdge = Math.min(...nb.map((q) => length(sub(q, C))));
      const D = o.cornerRound * meanEdge;
      const convex = dot(sub(C, centroid(nb)), n) > 1e-6;
      return { C, n, D, R: 0.4 * minEdge, on: D > 0 && convex };
    });
    return { o, net, V, F, meanEdge, S, rows, rowS, profile, normals, centroids, inradius, random, hinges, hingeOfEdge, H };
  }

  _mesh(c) {
    const { o, V, F, meanEdge, S, rows, rowS, profile, normals, centroids, inradius, random, hinges, hingeOfEdge, H } = c;
    const solid = this.solid;
    // Vertex counts: face parts (boundary, then centre and rings) are contiguous per face, then crease grids.
    const R = Math.max(0, Math.round(o.faceSubdivisions));
    const rings = 4 * R;
    // Small faces barely bow, so they need fewer rings than big ones.
    const faceRings = new Int32Array(F.length).fill(rings);
    if (o.adaptiveRings && R > 0) {
      F.forEach((f, fi) => {
        faceRings[fi] = Math.max(2, Math.min(rings, Math.round((rings * inradius[fi]) / (0.5 * o.size))));
      });
    }
    const faceStart = new Int32Array(F.length + 1);
    let triCount = 0;
    F.forEach((f, fi) => {
      const m = f.length * (rows - 1);
      faceStart[fi + 1] = faceStart[fi] + m + (R > 0 ? 1 + (faceRings[fi] - 1) * m : 0);
      triCount += R > 0 ? m * (2 * faceRings[fi] - 1) : Math.max(0, m - 2);
    });
    const NF = faceStart[F.length];
    const N = NF + H * rows * (S + 1);
    triCount += H * (rows - 1) * S * 2;

    const f64 = (n) => new Float64Array(n);
    const kind = new Uint8Array(N);
    const vRest = f64(N * 3);
    const vDir = f64(N * 3);
    const vHinge = new Int32Array(N).fill(-1);
    const vTaper = f64(N);
    const vCorner = new Int32Array(N).fill(-1);
    const lerpA = new Int32Array(N);
    const lerpB = new Int32Array(N);
    const lerpT = f64(N);
    const bubH = f64(N);
    const bubG = f64(N * 3);
    // Rest position at build time (edge points at their build crease offset), for rings and valleys.
    const P0 = f64(N * 3);
    const faceIdArr = new Float32Array(N);
    const creaseArr = new Float32Array(N);
    const tris = new Uint32Array(triCount * 3);
    const boundary = [];

    // Seeded bow height per face.
    this._facePillow = F.map(() => ({ amp: o.pillow > 0 && R > 0 ? o.pillow * meanEdge * (0.5 + 0.5 * random()) : 0 }));

    const maxM = Math.max(...F.map((f) => f.length)) * (rows - 1);
    const ring0 = new Int32Array(maxM);
    const ring1 = new Int32Array(maxM);
    const lines = f64(F.reduce((m, f) => Math.max(m, f.length), 0) * 7);
    Object.assign(c, { R, rings, faceRings, faceStart, NF, N, kind, vRest, vDir, vHinge, vTaper, vCorner, lerpA, lerpB, lerpT, bubH, bubG, P0, faceIdArr, creaseArr, tris, nt: 0, boundary, ring0, ring1, lines });
  }

  // Faces f0..f1-1: boundary points, centre and rings, and their triangles.
  _meshFaces(c, f0, f1) {
    const { V, F, rows, rowS, profile, normals, centroids, hinges, hingeOfEdge, R, faceRings, faceStart, kind, vRest, vDir, vHinge, vTaper, vCorner } = c;
    const { lerpA, lerpB, lerpT, bubH, bubG, P0, faceIdArr, tris, boundary, ring0, ring1, lines } = c;
    const solid = this.solid;
    let nt = c.nt;
    for (let fi = f0; fi < f1; fi++) {
      const f = F[fi];
      faceIdArr.fill(fi, faceStart[fi], faceStart[fi + 1]);
      const n = normals[fi];
      let k = faceStart[fi];
      const k0 = k;
      const cutAfter = [];
      const corners = [];
      const fixed = (x, y, z) => {
        vRest[k * 3] = P0[k * 3] = x;
        vRest[k * 3 + 1] = P0[k * 3 + 1] = y;
        vRest[k * 3 + 2] = P0[k * 3 + 2] = z;
        return k++;
      };
      f.forEach((va, i) => {
        const vb = f[(i + 1) % f.length];
        const A = V[va];
        const B = V[vb];
        corners.push(fixed(A[0], A[1], A[2]));
        const hi = hingeOfEdge.get(edgeKey(solid, va, vb));
        if (hi === undefined) {
          // Cut edges get the same rows as hinges, so both faces along a seam share their boundary points.
          const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
          for (let r = 1; r < rows - 1; r++) {
            const s = rowS[r];
            cutAfter.push(k - 1 - k0);
            fixed(A[0] + dx * s, A[1] + dy * s, A[2] + dz * s);
          }
          cutAfter.push(k - 1 - k0);
          return;
        }
        const h = hinges[hi];
        const t = normalize(sub(B, A));
        const d = cross(n, t);
        for (let r = 1; r < rows - 1; r++) {
          const sL = rowS[r] * h.L;
          const w = h.off * profile[r];
          const k3 = k * 3;
          for (let c = 0; c < 3; c++) {
            const base = A[c] + t[c] * sL;
            vRest[k3 + c] = base;
            vDir[k3 + c] = d[c];
            P0[k3 + c] = base + d[c] * w;
          }
          kind[k] = 1;
          vHinge[k] = hi;
          vTaper[k] = profile[r];
          k++;
        }
      });
      const m = k - k0;
      // Corners on a hinge meet zero-radius crease ends, so they share the vertex's back offset.
      f.forEach((va, i) => {
        if (hingeOfEdge.get(edgeKey(solid, va, f[(i + 1) % f.length])) === undefined) return;
        vCorner[corners[i]] = va;
        vCorner[corners[(i + 1) % f.length]] = f[(i + 1) % f.length];
      });
      for (const c of cutAfter) boundary.push([k0 + c, k0 + ((c + 1) % m)]);
      if (R === 0) {
        const { e1, e2 } = planeBasis(n, sub(V[f[1]], V[f[0]]));
        const pts = [];
        for (let q = k0; q < k; q++) {
          const x = P0[q * 3], y = P0[q * 3 + 1], z = P0[q * 3 + 2];
          pts.push([x * e1[0] + y * e1[1] + z * e1[2], x * e2[0] + y * e2[1] + z * e2[2]]);
        }
        for (const tr of triangulate(pts)) {
          tris[nt++] = k0 + tr[0];
          tris[nt++] = k0 + tr[1];
          tris[nt++] = k0 + tr[2];
        }
        continue;
      }
      // Concentric rings around the centroid: spokes follow the bow's radial gradient, so no
      // diagonal creases show. Ring points are fixed blends of the boundary, following the crease offsets.
      // Bubble over the face: product of distances to its edges (1 at the centroid, 0 on every edge),
      // smooth everywhere inside, unlike anything tied to the ring layout.
      const fc = centroids[fi];
      for (let i = 0; i < f.length; i++) {
        const a = V[f[i]];
        let inward = normalize(cross(n, sub(V[f[(i + 1) % f.length]], a)));
        if (dot(sub(fc, a), inward) < 0) inward = scale(inward, -1);
        lines.set([a[0], a[1], a[2], inward[0], inward[1], inward[2], dot(sub(fc, a), inward)], i * 7);
      }
      // Height smoothstep(B) and its gradient, so normals are analytic and never trace the mesh layout.
      const bubble = (v, qx, qy, qz) => {
        let b = 1;
        let gx = 0, gy = 0, gz = 0;
        for (let l = 0; l < f.length * 7; l += 7) {
          const ix = lines[l + 3], iy = lines[l + 4], iz = lines[l + 5];
          const d = (qx - lines[l]) * ix + (qy - lines[l + 1]) * iy + (qz - lines[l + 2]) * iz;
          if (d <= 0) return;
          b *= d / lines[l + 6];
          const w = 1 / d;
          gx = gx + ix * w;
          gy = gy + iy * w;
          gz = gz + iz * w;
        }
        if (b >= 1) {
          bubH[v] = 1;
          return;
        }
        const w = 6 * b * (1 - b) * b;
        bubH[v] = b * b * (3 - 2 * b);
        bubG[v * 3] = gx * w;
        bubG[v * 3 + 1] = gy * w;
        bubG[v * 3 + 2] = gz * w;
      };
      let cx = 0, cy = 0, cz = 0;
      for (let q = k0; q < k; q++) {
        cx += P0[q * 3];
        cy += P0[q * 3 + 1];
        cz += P0[q * 3 + 2];
      }
      const inv = 1 / m;
      cx *= inv;
      cy *= inv;
      cz *= inv;
      const center = k;
      kind[center] = 3;
      lerpA[center] = k0;
      lerpB[center] = m;
      lerpT[center] = 1 / m;
      P0[center * 3] = cx;
      P0[center * 3 + 1] = cy;
      P0[center * 3 + 2] = cz;
      bubble(center, cx, cy, cz);
      k++;
      let inner = ring0;
      let outer = ring1;
      const rings = faceRings[fi];
      for (let r = 1; r <= rings; r++) {
        // Denser toward the rim, where the creases and rounded corners bend.
        const t = 1 - (1 - r / rings) ** 2;
        for (let i = 0; i < m; i++) {
          const b = k0 + i;
          if (r === rings) {
            outer[i] = b;
            continue;
          }
          const x = cx * (1 - t) + P0[b * 3] * t;
          const y = cy * (1 - t) + P0[b * 3 + 1] * t;
          const z = cz * (1 - t) + P0[b * 3 + 2] * t;
          kind[k] = 2;
          lerpA[k] = center;
          lerpB[k] = b;
          lerpT[k] = t;
          P0[k * 3] = x;
          P0[k * 3 + 1] = y;
          P0[k * 3 + 2] = z;
          bubble(k, x, y, z);
          outer[i] = k++;
        }
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          if (r === 1) {
            tris[nt++] = center;
            tris[nt++] = outer[i];
            tris[nt++] = outer[j];
            continue;
          }
          tris[nt++] = inner[i];
          tris[nt++] = outer[i];
          tris[nt++] = outer[j];
          tris[nt++] = inner[i];
          tris[nt++] = outer[j];
          tris[nt++] = inner[j];
        }
        [inner, outer] = [outer, inner];
      }
    }
    c.nt = nt;
  }

  _meshCreases(c) {
    const { V, S, rows, rowS, profile, hinges, H, NF, vHinge, vTaper, vCorner, faceIdArr, creaseArr, P0, tris } = c;
    let nt = c.nt;

    // Crease strips: rows along the edge (a -> b), columns j = 0..S parent -> child.
    const hStart = new Int32Array(H);
    let k = NF;
    hinges.forEach((h, hi) => {
      hStart[hi] = k;
      h.grid = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        const corner = r === 0 ? h.a : r === rows - 1 ? h.b : -1;
        for (let j = 0; j <= S; j++, k++) {
          row.push(k);
          vHinge[k] = hi;
          vTaper[k] = profile[r];
          vCorner[k] = corner;
          faceIdArr[k] = j * 2 <= S ? h.parent : h.child;
          creaseArr[k] = Math.sin((Math.PI * j) / S) * profile[r] * (h.valley ? -1 : 1);
          for (let c = 0; c < 3; c++) P0[k * 3 + c] = V[h.a][c] + h.u[c] * (rowS[r] * h.L);
        }
        h.grid.push(row);
      }
      const g = hStart[hi];
      for (let r = 0; r < rows - 1; r++) {
        for (let j = 0; j < S; j++) {
          const a = g + r * (S + 1) + j;
          const b = a + S + 1;
          tris[nt++] = a;
          tris[nt++] = a + 1;
          tris[nt++] = b + 1;
          tris[nt++] = a;
          tris[nt++] = b + 1;
          tris[nt++] = b;
        }
      }
    });
    Object.assign(c, { nt, hStart });
  }

  _assemble(c) {
    const { o, V, F, meanEdge, S, rows, normals, centroids, inradius, hinges, H, faceStart, NF, N, kind, vRest, vDir, vHinge, vTaper, vCorner, lerpA, lerpB, lerpT, bubH, bubG, P0, faceIdArr, creaseArr, tris, nt, boundary, hStart } = c;

    this._vertexHinges = V.map(() => []);
    hinges.forEach((h, hi) => {
      this._vertexHinges[h.a].push(hi);
      this._vertexHinges[h.b].push(hi);
    });
    this._front = N;
    const th = Math.min(o.thickness, 0.9 * o.creaseRadius) * meanEdge;
    this._thickness = th;
    let count = N;
    const rim = [];
    if (th > 0) {
      count = 2 * N;
      for (const [i, j] of boundary) {
        const r = [i, j, i + N, j + N].map((src) => ({ src, at: count++ }));
        rim.push(r);
      }
    }
    this._count = count;
    const indexCount = nt * (th > 0 ? 2 : 1) + rim.length * 6;
    const index = count - 1 >= 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    index.set(tris.subarray(0, nt));
    let ni = nt;
    if (th > 0) {
      for (let t = 0; t < nt; t += 3) {
        index[ni++] = tris[t] + N;
        index[ni++] = tris[t + 2] + N;
        index[ni++] = tris[t + 1] + N;
      }
      for (const r of rim) {
        const [ri, rj, ri2, rj2] = r.map((x) => x.at);
        index.set([ri2, rj2, rj, ri2, rj, ri], ni);
        ni += 6;
      }
    }

    const hull = new Int32Array(NF + H * rows);
    const mid = S >> 1;
    for (let i = 0; i < NF; i++) hull[i] = i;
    for (let hi = 0, h = NF; hi < H; hi++) for (let r = 0; r < rows; r++) hull[h++] = hStart[hi] + r * (S + 1) + mid;
    this._pack({ V, F, normals, rim, faceStart, kind, vRest, vDir, vHinge, vTaper, vCorner, lerpA, lerpB, lerpT, bubH, bubG, hull, hStart });

    this.positions = new Float32Array(count * 3);
    this.normalsArray = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const faceId = new Float32Array(count);
    faceId.set(faceIdArr);
    const crease = new Float32Array(count);
    crease.set(creaseArr);
    const valley = new Float32Array(count * 2);
    Object.assign(c, { count, rim, th, index, uv, faceId, crease, valley });
  }

  // Flat-state frame: net centred at the origin in the XZ plane, outside up.
  _flat(c) {
    this._global = null;
    this._evaluate(0);
    this._global = this._flatFrame(c.normals[c.net.root]);
  }

  _finish(c) {
    const { N, rim, th, index, uv, faceId, crease, valley, valleyRest } = c;
    const P = this.positions;
    const g = this._global.r;
    const gt = this._global.t;
    for (let i = 0; i < N; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      uv[i * 2] = g[0] * x + g[1] * y + g[2] * z + gt[0];
      uv[i * 2 + 1] = -(g[6] * x + g[7] * y + g[8] * z + gt[2]);
      valley[i * 2] = valleyRest[i * 2];
    }
    const copyAttr = (dst, src) => {
      uv[dst * 2] = uv[src * 2];
      uv[dst * 2 + 1] = uv[src * 2 + 1];
      faceId[dst] = faceId[src];
      crease[dst] = crease[src];
      valley[dst * 2] = valley[src * 2];
      valleyRest[dst * 2 + 1] = valleyRest[src * 2 + 1];
    };
    if (th > 0) for (let i = 0; i < N; i++) copyAttr(i + N, i);
    for (const r of rim) for (const { src, at } of r) copyAttr(at, src % N);

    this.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.setAttribute("normal", new BufferAttribute(this.normalsArray, 3));
    this.setAttribute("uv", new BufferAttribute(uv, 2));
    this.setAttribute("faceId", new BufferAttribute(faceId, 1));
    this.setAttribute("crease", new BufferAttribute(crease, 1));
    this.setAttribute("valley", new BufferAttribute(valley, 2));
    this._valleyRest = valleyRest;
    this.setIndex(new BufferAttribute(index, 1));
    this.fold = -1;
  }

  // For code that expects a { geometry } holder.
  get geometry() {
    return this;
  }

  // Typed arrays for the per-frame path.
  _pack({ V, F, normals, rim, faceStart, kind, vRest, vDir, vHinge, vTaper, vCorner, lerpA, lerpB, lerpT, bubH, bubG, hull, hStart }) {
    const H = this.hinges.length;
    const nF = F.length;
    const nV = V.length;
    const N = this._front;
    const rows = this._rowS.length;
    const S = this.segments;
    const f64 = (n) => new Float64Array(n);

    const faceN = f64(nF * 3);
    normals.forEach((n, i) => faceN.set(n, i * 3));
    const restV = f64(nV * 3);
    V.forEach((p, i) => restV.set(p, i * 3));
    const amp = f64(nF);
    this._facePillow.forEach((p, i) => (amp[i] = p.amp));

    // Rounded corners: per face (and per hinge) the list of convex corner ids it can reach.
    const cC = f64(nV * 3);
    const cN = f64(nV * 3);
    const cD = f64(nV);
    const cR = f64(nV);
    this._corners.forEach((c, k) => {
      cC.set(c.C, k * 3);
      cN.set(c.n, k * 3);
      cD[k] = c.D;
      cR[k] = c.R;
    });
    const on = (k) => this._corners[k].on;
    const faceCornerStart = new Int32Array(nF + 1);
    const faceCorners = [];
    F.forEach((f, fi) => {
      faceCornerStart[fi] = faceCorners.length;
      for (const k of f) if (on(k)) faceCorners.push(k);
    });
    faceCornerStart[nF] = faceCorners.length;

    const hTheta = f64(H);
    const hJitter = f64(H);
    const hDelay = f64(H);
    const hOff = f64(H);
    const hOffMax = f64(H);
    const hOffPer = f64(H);
    const hU = f64(H * 3);
    const hDA = f64(H * 3);
    const hE1 = f64(H * 3);
    const hE2 = f64(H * 3);
    const hA = new Int32Array(H);
    const hB = new Int32Array(H);
    const hParent = new Int32Array(H);
    const hCorners = new Int32Array(H * 2).fill(-1);
    const hEdge = f64(H * rows * 3);
    this.hinges.forEach((h, k) => {
      hTheta[k] = h.theta;
      hJitter[k] = h.jitter;
      hDelay[k] = h.delay;
      hOff[k] = h.off;
      hOffMax[k] = h.offMax;
      hOffPer[k] = h.offPerRadius;
      hU.set(h.u, k * 3);
      hDA.set(h.dA, k * 3);
      hE1.set(h.e1, k * 3);
      hE2.set(h.e2, k * 3);
      hA[k] = h.a;
      hB[k] = h.b;
      hParent[k] = h.parent;
      let c = 0;
      if (on(h.a)) hCorners[k * 2 + c++] = h.a;
      if (on(h.b)) hCorners[k * 2 + c++] = h.b;
      const A = V[h.a];
      for (let r = 0; r < rows; r++) {
        const sL = this._rowS[r] * h.L;
        const e = (k * rows + r) * 3;
        hEdge[e] = A[0] + h.u[0] * sL;
        hEdge[e + 1] = A[1] + h.u[1] * sL;
        hEdge[e + 2] = A[2] + h.u[2] * sL;
      }
    });

    const order = this.net.order.filter((f) => f !== this.net.root);
    const rimArr = new Int32Array(rim.length * 8);
    rim.forEach((r, k) => r.forEach(({ src, at }, c) => {
      rimArr[k * 8 + c] = src;
      rimArr[k * 8 + 4 + c] = at;
    }));

    this._d = {
      faceN, restV, amp, faceStart, kind, vRest, vDir, vHinge, vTaper, vCorner, lerpA, lerpB, lerpT, bubH, bubG,
      cC, cN, cD, cR, faceCornerStart, faceCorners: Int32Array.from(faceCorners), hCorners,
      hTheta, hJitter, hDelay, hOff, hOffMax, hOffPer, hU, hDA, hE1, hE2, hA, hB, hParent, hStart, hEdge,
      order: Int32Array.from(order),
      faceParent: Int32Array.from(this.net.faces.map((f) => f.parent)),
      rim: rimArr,
      hull,
      folds: f64(H),
      phis: f64(H),
      offs: f64(H),
      T: f64(nF * 12),
      M: f64(nF * 12),
      rest: f64(N * 3),
      cornerOff: f64(nV),
      colN: f64((S + 1) * 3),
      colS: f64(S + 1),
      colC: f64(S + 1),
    };
  }

  // Per front vertex: x = distance to the nearest concave edge of its face / face inradius
  // (10 when the face has none), y = that edge's bend (0..1 over 0..90 degrees). Sized for the full
  // vertex count; back and rim copies are filled by the caller.
  _valleyGeometry(P0, N, faceIds, V, F, normals, inradius, centroids) {
    const edgeFaces = new Map();
    F.forEach((f, fi) => f.forEach((a, i) => {
      const k = edgeKey(this.solid, a, f[(i + 1) % f.length]);
      const list = edgeFaces.get(k);
      if (list) list.push(fi);
      else edgeFaces.set(k, [fi]);
    }));
    const faceValleys = F.map(() => []);
    const n = V.length;
    for (const [k, list] of edgeFaces) {
      if (list.length !== 2) continue;
      const [p, c] = list;
      const concave = dot(sub(normals[c], normals[p]), sub(centroids[c], centroids[p])) < -1e-9;
      if (!concave) continue;
      const a = Math.floor(k / n);
      const b = k - a * n;
      const bend = Math.acos(Math.min(1, Math.max(-1, dot(normals[p], normals[c]))));
      const ab = sub(V[b], V[a]);
      const e = [...V[a], ...ab, dot(ab, ab), Math.min(1, bend / (Math.PI / 2))];
      faceValleys[p].push(e);
      faceValleys[c].push(e);
    }
    // Per face: its concave edges as [a, b - a, |b - a|^2, bend] runs of 8.
    const start = new Int32Array(F.length + 1);
    faceValleys.forEach((l, fi) => (start[fi + 1] = start[fi] + l.length));
    const E = new Float64Array(start[F.length] * 8);
    faceValleys.forEach((l, fi) => l.forEach((e, j) => E.set(e, (start[fi] + j) * 8)));
    const out = new Float32Array(this._count * 2);
    for (let i = 0; i < N; i++) {
      const fi = faceIds[i] | 0;
      out[i * 2] = 10;
      if (start[fi] === start[fi + 1]) continue;
      const px = P0[i * 3], py = P0[i * 3 + 1], pz = P0[i * 3 + 2];
      let best = Infinity;
      let bend = 0;
      for (let e = start[fi] * 8, end = start[fi + 1] * 8; e < end; e += 8) {
        const ax = E[e], ay = E[e + 1], az = E[e + 2], bx = E[e + 3], by = E[e + 4], bz = E[e + 5];
        const t = Math.min(1, Math.max(0, ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / E[e + 6]));
        const dx = px - (ax + bx * t), dy = py - (ay + by * t), dz = pz - (az + bz * t);
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < best) {
          best = d;
          bend = E[e + 7];
        }
      }
      out[i * 2] = best / Math.max(inradius[fi], 1e-6);
      out[i * 2 + 1] = bend;
    }
    return out;
  }

  // Fold amount (0..1) of hinge h at global t, staggered by tree depth.
  hingeFold(h, t) {
    const st = Math.min(Math.max(this.options.stagger, 0), 0.95);
    return this.options.easing(clamp01((t - h.delay * st) / (1 - st)));
  }

  // 0 = flat net, 1 = folded solid; updates positions and normals in place.
  setFold(t) {
    t = clamp01(t);
    if (t === this.fold) return this;
    this.fold = t;
    this._evaluate(t);
    // Valley depth follows the fold: none on the flat net.
    const e = this.options.staticValley ? 1 : this.options.easing(t);
    if (e !== this._valleyScale) {
      this._valleyScale = e;
      const valley = this.attributes.valley;
      const va = valley.array;
      const vr = this._valleyRest;
      for (let i = 1, n = valley.count * 2; i < n; i += 2) va[i] = vr[i] * e;
      valley.needsUpdate = true;
    }
    this.attributes.position.needsUpdate = true;
    this.attributes.normal.needsUpdate = true;
    this._boundingSphere();
    return this;
  }

  // Same result as computeBoundingSphere() without the Vector3 round trips.
  _boundingSphere() {
    const P = this.positions;
    const n = this._count * 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r2 = 0;
    for (let i = 0; i < n; i += 3) {
      const dx = P[i] - cx, dy = P[i + 1] - cy, dz = P[i + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    if (!this.boundingSphere) this.boundingSphere = new Sphere();
    this.boundingSphere.center.set(cx, cy, cz);
    this.boundingSphere.radius = Math.sqrt(r2);
  }

  // Face transforms (rest -> current) as row-major 3x4 [r | t] per face: children turn about their hinge edge.
  _faceTransforms(phis, T) {
    const d = this._d;
    const { order, faceParent, restV, hU, hA, hTheta } = d;
    const hof = this._hingeOfFace;
    const root = this.net.root * 12;
    T.fill(0, root, root + 12);
    T[root] = T[root + 5] = T[root + 10] = 1;
    for (let oi = 0; oi < order.length; oi++) {
      const f = order[oi];
      const hi = hof[f];
      const ang = phis[hi] - hTheta[hi];
      const c = Math.cos(ang), s = Math.sin(ang), k = 1 - c;
      const x = hU[hi * 3], y = hU[hi * 3 + 1], z = hU[hi * 3 + 2];
      const r0 = k * x * x + c, r1 = k * x * y - s * z, r2 = k * x * z + s * y;
      const r3 = k * x * y + s * z, r4 = k * y * y + c, r5 = k * y * z - s * x;
      const r6 = k * x * z - s * y, r7 = k * y * z + s * x, r8 = k * z * z + c;
      const pa = hA[hi] * 3;
      const ax = restV[pa], ay = restV[pa + 1], az = restV[pa + 2];
      const tx = ax - (r0 * ax + r1 * ay + r2 * az);
      const ty = ay - (r3 * ax + r4 * ay + r5 * az);
      const tz = az - (r6 * ax + r7 * ay + r8 * az);
      const p = faceParent[f] * 12;
      const o = f * 12;
      for (let row = 0; row < 3; row++) {
        const a0 = T[p + row * 4], a1 = T[p + row * 4 + 1], a2 = T[p + row * 4 + 2];
        T[o + row * 4] = a0 * r0 + a1 * r3 + a2 * r6;
        T[o + row * 4 + 1] = a0 * r1 + a1 * r4 + a2 * r7;
        T[o + row * 4 + 2] = a0 * r2 + a1 * r5 + a2 * r8;
        T[o + row * 4 + 3] = a0 * tx + a1 * ty + a2 * tz + T[p + row * 4 + 3];
      }
    }
    return T;
  }

  _evaluate(t) {
    const d = this._d;
    const P = this.positions;
    const Nr = this.normalsArray;
    const o = this.options;
    const H = this.hinges.length;
    const { folds, phis, offs, hTheta, hJitter, hDelay, hOff, hOffMax, hOffPer } = d;
    const st = Math.min(Math.max(o.stagger, 0), 0.95);
    const fcr = o.foldingCreaseRadius ?? o.creaseRadius;
    for (let hi = 0; hi < H; hi++) {
      const f = o.easing(clamp01((t - hDelay[hi] * st) / (1 - st)));
      folds[hi] = f;
      phis[hi] = f * (hTheta[hi] + hJitter[hi]);
      offs[hi] = fcr === o.creaseRadius ? hOff[hi] : Math.min((fcr + (o.creaseRadius - fcr) * f) * hOffPer[hi], hOffMax[hi]);
    }
    const bow = o.easing(t);
    const round = o.cornerRound > 0 ? o.easing(clamp01((t - 0.6) / 0.4)) : 0;
    const T = this._faceTransforms(phis, d.T);

    // M = global frame ∘ face transform, so each vertex takes one affine map.
    const G = this._global ? this._globalAt(t) : null;
    const M = d.M;
    if (G) {
      const g = G.r;
      for (let f = 0; f < M.length; f += 12) {
        for (let row = 0; row < 3; row++) {
          const g0 = g[row * 3], g1 = g[row * 3 + 1], g2 = g[row * 3 + 2];
          for (let c = 0; c < 4; c++) M[f + row * 4 + c] = g0 * T[f + c] + g1 * T[f + 4 + c] + g2 * T[f + 8 + c];
          M[f + row * 4 + 3] += G.t[row];
        }
      }
    } else M.set(T);

    const { faceN, amp, faceStart, kind, vRest, vDir, vHinge, vTaper, lerpA, lerpB, lerpT, bubH, bubG } = d;
    const { faceCornerStart, faceCorners, rest, cC, cN, cD, cR } = d;
    const nF = faceStart.length - 1;
    for (let fi = 0; fi < nF; fi++) {
      const m = fi * 12;
      const m0 = M[m], m1 = M[m + 1], m2 = M[m + 2], m3 = M[m + 3];
      const m4 = M[m + 4], m5 = M[m + 5], m6 = M[m + 6], m7 = M[m + 7];
      const m8 = M[m + 8], m9 = M[m + 9], m10 = M[m + 10], m11 = M[m + 11];
      const fnx = faceN[fi * 3], fny = faceN[fi * 3 + 1], fnz = faceN[fi * 3 + 2];
      const k = amp[fi] * bow;
      const bubbly = amp[fi] > 0 && bow > 0;
      const c0 = faceCornerStart[fi], c1 = faceCornerStart[fi + 1];
      for (let i = faceStart[fi], end = faceStart[fi + 1]; i < end; i++) {
        const i3 = i * 3;
        let px, py, pz;
        const kd = kind[i];
        if (kd === 0) {
          px = vRest[i3];
          py = vRest[i3 + 1];
          pz = vRest[i3 + 2];
        } else if (kd === 1) {
          const a = offs[vHinge[i]] * vTaper[i];
          px = vRest[i3] + vDir[i3] * a;
          py = vRest[i3 + 1] + vDir[i3 + 1] * a;
          pz = vRest[i3 + 2] + vDir[i3 + 2] * a;
        } else if (kd === 2) {
          const a = lerpA[i] * 3, b = lerpB[i] * 3, w = lerpT[i];
          px = rest[a] + (rest[b] - rest[a]) * w;
          py = rest[a + 1] + (rest[b + 1] - rest[a + 1]) * w;
          pz = rest[a + 2] + (rest[b + 2] - rest[a + 2]) * w;
        } else {
          const w = lerpT[i];
          px = py = pz = 0;
          for (let j = lerpA[i], je = j + lerpB[i]; j < je; j++) {
            px += rest[j * 3] * w;
            py += rest[j * 3 + 1] * w;
            pz += rest[j * 3 + 2] * w;
          }
        }
        rest[i3] = px;
        rest[i3 + 1] = py;
        rest[i3 + 2] = pz;
        let nx = fnx, ny = fny, nz = fnz;
        const bh = bubH[i];
        if (bubbly && bh > 0) {
          px += fnx * (k * bh);
          py += fny * (k * bh);
          pz += fnz * (k * bh);
          nx = fnx - bubG[i3] * k;
          ny = fny - bubG[i3 + 1] * k;
          nz = fnz - bubG[i3 + 2] * k;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
        }
        // Rounded corners, inlined here and in the crease loop: tips sink by sqrt(z^2 + D^2) - z, z below the tip.
        if (round > 0) {
          for (let q = c0; q < c1; q++) {
            const vi = faceCorners[q];
            const R = cR[vi];
            const c3 = vi * 3;
            const dx = px - cC[c3], dy = py - cC[c3 + 1], dz0 = pz - cC[c3 + 2];
            const d2 = dx * dx + dy * dy + dz0 * dz0;
            if (d2 >= R * R) continue;
            const dd = Math.sqrt(d2);
            const cnx = cN[c3], cny = cN[c3 + 1], cnz = cN[c3 + 2];
            const D = cD[vi] * round;
            const z = Math.max(-(dx * cnx + dy * cny + dz0 * cnz), 0);
            const hyp = Math.sqrt(z * z + D * D);
            const x = clamp01((dd - 0.4 * R) / (0.6 * R));
            const win = 1 - x * x * (3 - 2 * x);
            const dwin = dd > 1e-9 && x > 0 && x < 1 ? (-6 * x * (1 - x)) / (0.6 * R * dd) : 0;
            const f = (hyp - z) * win;
            const dz = z > 0 ? (z / hyp - 1) * win : 0;
            const kk = (hyp - z) * dwin;
            const gx = -cnx * dz + dx * kk, gy = -cny * dz + dy * kk, gz = -cnz * dz + dz0 * kk;
            px -= cnx * f;
            py -= cny * f;
            pz -= cnz * f;
            // Exact normal under p -> p - n_c f(p): J^-T n is proportional to (1 - n_c.g) n + (n_c.n) g.
            const a = 1 - (cnx * gx + cny * gy + cnz * gz);
            const b = cnx * nx + cny * ny + cnz * nz;
            const mx = nx * a + gx * b, my = ny * a + gy * b, mz = nz * a + gz * b;
            const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
            nx = mx / l;
            ny = my / l;
            nz = mz / l;
          }
        }
        P[i3] = m0 * px + m1 * py + m2 * pz + m3;
        P[i3 + 1] = m4 * px + m5 * py + m6 * pz + m7;
        P[i3 + 2] = m8 * px + m9 * py + m10 * pz + m11;
        Nr[i3] = m0 * nx + m1 * ny + m2 * nz;
        Nr[i3 + 1] = m4 * nx + m5 * ny + m6 * nz;
        Nr[i3 + 2] = m8 * nx + m9 * ny + m10 * nz;
      }
    }

    // Fillet tangent to the parent at distance `a` from the edge and to the
    // child (turned by phi) at the same distance.
    const S = this.segments;
    const rows = this._rowS.length;
    const profile = this._profile;
    const { hU, hDA, hE1, hE2, hParent, hStart, hEdge, hCorners, colN, colS, colC } = d;
    for (let hi = 0; hi < H; hi++) {
      const phi = phis[hi];
      const off = offs[hi];
      const p = hParent[hi];
      const m = p * 12;
      const m0 = M[m], m1 = M[m + 1], m2 = M[m + 2], m3 = M[m + 3];
      const m4 = M[m + 4], m5 = M[m + 5], m6 = M[m + 6], m7 = M[m + 7];
      const m8 = M[m + 8], m9 = M[m + 9], m10 = M[m + 10], m11 = M[m + 11];
      const ux = hU[hi * 3], uy = hU[hi * 3 + 1], uz = hU[hi * 3 + 2];
      const dax = hDA[hi * 3], day = hDA[hi * 3 + 1], daz = hDA[hi * 3 + 2];
      const e1x = hE1[hi * 3], e1y = hE1[hi * 3 + 1], e1z = hE1[hi * 3 + 2];
      const e2x = hE2[hi * 3], e2y = hE2[hi * 3 + 1], e2z = hE2[hi * 3 + 2];
      const vx = faceN[p * 3], vy = faceN[p * 3 + 1], vz = faceN[p * 3 + 2];
      const ud = ux * vx + uy * vy + uz * vz;
      const xx = uy * vz - uz * vy, xy = uz * vx - ux * vz, xz = ux * vy - uy * vx;
      for (let j = 0; j <= S; j++) {
        const al = phi * (j / S);
        const c = Math.cos(al), sn = Math.sin(al), kk = ud * (1 - c);
        colS[j] = sn;
        colC[j] = c;
        colN[j * 3] = vx * c + xx * sn + ux * kk;
        colN[j * 3 + 1] = vy * c + xy * sn + uy * kk;
        colN[j * 3 + 2] = vz * c + xz * sn + uz * kk;
      }
      const flat = Math.abs(phi) < 1e-6;
      const cotHalf = flat ? 0 : 1 / Math.tan(phi / 2);
      const ca = hCorners[hi * 2], cb = hCorners[hi * 2 + 1];
      const nc = ca < 0 ? 0 : cb < 0 ? 1 : 2;
      let i = hStart[hi];
      for (let r = 0; r < rows; r++) {
        const a = off * profile[r];
        const e = (hi * rows + r) * 3;
        const ax = hEdge[e] + dax * a, ay = hEdge[e + 1] + day * a, az = hEdge[e + 2] + daz * a;
        const kr = flat ? 0 : a * cotHalf;
        for (let j = 0; j <= S; j++, i++) {
          let px, py, pz;
          if (flat) {
            const w = 2 * a * (j / S);
            px = ax + e1x * w;
            py = ay + e1y * w;
            pz = az + e1z * w;
          } else {
            const ws = kr * colS[j], wc = kr * (1 - colC[j]);
            px = ax + (e1x * ws + e2x * wc);
            py = ay + (e1y * ws + e2y * wc);
            pz = az + (e1z * ws + e2z * wc);
          }
          let nx = colN[j * 3], ny = colN[j * 3 + 1], nz = colN[j * 3 + 2];
          if (round > 0) {
            for (let q = hi * 2, qe = q + nc; q < qe; q++) {
              const vi = hCorners[q];
              const R = cR[vi];
              const c3 = vi * 3;
              const dx = px - cC[c3], dy = py - cC[c3 + 1], dz0 = pz - cC[c3 + 2];
              const d2 = dx * dx + dy * dy + dz0 * dz0;
              if (d2 >= R * R) continue;
              const dd = Math.sqrt(d2);
              const cnx = cN[c3], cny = cN[c3 + 1], cnz = cN[c3 + 2];
              const D = cD[vi] * round;
              const z = Math.max(-(dx * cnx + dy * cny + dz0 * cnz), 0);
              const hyp = Math.sqrt(z * z + D * D);
              const x = clamp01((dd - 0.4 * R) / (0.6 * R));
              const win = 1 - x * x * (3 - 2 * x);
              const dwin = dd > 1e-9 && x > 0 && x < 1 ? (-6 * x * (1 - x)) / (0.6 * R * dd) : 0;
              const f = (hyp - z) * win;
              const dz = z > 0 ? (z / hyp - 1) * win : 0;
              const kk = (hyp - z) * dwin;
              const gx = -cnx * dz + dx * kk, gy = -cny * dz + dy * kk, gz = -cnz * dz + dz0 * kk;
              px -= cnx * f;
              py -= cny * f;
              pz -= cnz * f;
              const a = 1 - (cnx * gx + cny * gy + cnz * gz);
              const b = cnx * nx + cny * ny + cnz * nz;
              const mx = nx * a + gx * b, my = ny * a + gy * b, mz = nz * a + gz * b;
              const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
              nx = mx / l;
              ny = my / l;
              nz = mz / l;
            }
          }
          const i3 = i * 3;
          P[i3] = m0 * px + m1 * py + m2 * pz + m3;
          P[i3 + 1] = m4 * px + m5 * py + m6 * pz + m7;
          P[i3 + 2] = m8 * px + m9 * py + m10 * pz + m11;
          Nr[i3] = m0 * nx + m1 * ny + m2 * nz;
          Nr[i3 + 1] = m4 * nx + m5 * ny + m6 * nz;
          Nr[i3 + 2] = m8 * nx + m9 * ny + m10 * nz;
        }
      }
    }

    const N = this._front;
    const th = this._thickness;
    if (!(th > 0)) return;
    // Back offset per vertex, kept under the local fillet radius so convex creases don't invert.
    const { vCorner, cornerOff, rim } = d;
    const vh = this._vertexHinges;
    for (let c = 0; c < vh.length; c++) {
      let w = th;
      for (const hi of vh[c]) if (phis[hi] > 1e-6) w = Math.min(w, 0);
      cornerOff[c] = w;
    }
    for (let i = 0; i < N; i++) {
      let w = th;
      const c = vCorner[i];
      const hi = vHinge[i];
      if (c >= 0) w = cornerOff[c];
      else if (hi >= 0 && phis[hi] > 1e-6) w = Math.min(w, (0.9 * offs[hi] * vTaper[i]) / Math.tan(phis[hi] / 2));
      const a = i * 3, b = (i + N) * 3;
      P[b] = P[a] - Nr[a] * w;
      P[b + 1] = P[a + 1] - Nr[a + 1] * w;
      P[b + 2] = P[a + 2] - Nr[a + 2] * w;
      Nr[b] = -Nr[a];
      Nr[b + 1] = -Nr[a + 1];
      Nr[b + 2] = -Nr[a + 2];
    }
    for (let r = 0; r < rim.length; r += 8) {
      const i = rim[r] * 3;
      const j = rim[r + 1] * 3;
      const dx = P[j] - P[i], dy = P[j + 1] - P[i + 1], dz = P[j + 2] - P[i + 2];
      const nx = Nr[i] + Nr[j], ny = Nr[i + 1] + Nr[j + 1], nz = Nr[i + 2] + Nr[j + 2];
      let ox = dy * nz - dz * ny, oy = dz * nx - dx * nz, oz = dx * ny - dy * nx;
      const l = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      ox /= l;
      oy /= l;
      oz /= l;
      for (let c = 0; c < 4; c++) {
        const src = rim[r + c] * 3;
        const at = rim[r + 4 + c] * 3;
        P[at] = P[src];
        P[at + 1] = P[src + 1];
        P[at + 2] = P[src + 2];
        Nr[at] = ox;
        Nr[at + 1] = oy;
        Nr[at + 2] = oz;
      }
    }
  }

  // Flat net outline as one convex polygon per face, [x, z] in the geometry's fold = 0 frame.
  flatOutline() {
    const T = this._faceTransforms(new Float64Array(this.hinges.length), new Float64Array(this.solid.faces.length * 12));
    const G = this._global ? this._globalAt(0) : null;
    return this.solid.faces.map((f, fi) =>
      f.map((vi) => {
        const [x, y, z] = this.restVertices[vi];
        const m = fi * 12;
        let p = [0, 1, 2].map((r) => T[m + r * 4] * x + T[m + r * 4 + 1] * y + T[m + r * 4 + 2] * z + T[m + r * 4 + 3]);
        if (G) p = apply(G, p);
        return [p[0], p[2]];
      }),
    );
  }

  // Rotation taking the root normal to +Y and the net's long axis to X, plus centring.
  _flatFrame(rootNormal) {
    const y = [0, 1, 0];
    const axis = cross(rootNormal, y);
    const ang = Math.atan2(length(axis), dot(rootNormal, y));
    let r =
      length(axis) > 1e-9
        ? rotationMatrix(normalize(axis), ang)
        : ang > 1
          ? rotationMatrix([1, 0, 0], Math.PI)
          : identity().r;
    const N = this._front;
    const P = this.positions;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < N * 3; i += 3) {
      cx += r[0] * P[i] + r[1] * P[i + 1] + r[2] * P[i + 2];
      cz += r[6] * P[i] + r[7] * P[i + 1] + r[8] * P[i + 2];
    }
    cx *= 1 / N;
    cz *= 1 / N;
    let sxx = 0;
    let sxz = 0;
    let szz = 0;
    for (let i = 0; i < N * 3; i += 3) {
      const dx = r[0] * P[i] + r[1] * P[i + 1] + r[2] * P[i + 2] - cx;
      const dz = r[6] * P[i] + r[7] * P[i + 1] + r[8] * P[i + 2] - cz;
      sxx += dx * dx;
      sxz += dx * dz;
      szz += dz * dz;
    }
    const yaw = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    r = compose({ r: rotationMatrix(y, yaw), t: [0, 0, 0] }, { r, t: [0, 0, 0] }).r;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < N * 3; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = r[k * 3] * P[i] + r[k * 3 + 1] * P[i + 1] + r[k * 3 + 2] * P[i + 2];
        min[k] = Math.min(min[k], v);
        max[k] = Math.max(max[k], v);
      }
    }
    const t = scale(add(min, max), -0.5);
    const m4 = new Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
    return { r, t, q: new Quaternion().setFromRotationMatrix(m4) };
  }

  _globalAt(t) {
    if (!this.options.layFlat) return null;
    const g = this.options.easing(t);
    const q = this._global.q.clone().slerp(new Quaternion(), g);
    const m = new Matrix4().makeRotationFromQuaternion(q).elements;
    return {
      r: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]],
      t: scale(this._global.t, 1 - g),
    };
  }

  // Convex hull points for physics: the folded solid's vertices, or with
  // current = true the present face outlines and crease midlines.
  hullPoints(current = false) {
    if (!current) return this.restVertices.map((v) => new Vector3(...v));
    const P = this.positions;
    return Array.from(this._d.hull, (i) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
  }
}
