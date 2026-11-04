// Walking on the rest (undensified) mesh: nearest vertex, closest-point projection and sub-stepped moves.
// A walk state is { p: [x,y,z], n: [x,y,z] (interpolated rest normal), face, bary: [u,v,w], vtx (nearest corner) }.

const CELL = 0.05;

export function createSurfaceWalk(geometry, topology) {
  const pos = geometry.attributes.position.array;
  const nrm = geometry.attributes.normal.array;
  const rimAttr = geometry.attributes.rim?.array;
  const { nv, nf, index, offsets, neighbours, vfOffsets, vfFaces } = topology;

  let edgeSum = 0;
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3], b = index[f * 3 + 1];
    edgeSum += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  }
  const edge = edgeSum / nf;

  // Vertex hash for nearest().
  const hash = new Map();
  const key = (i, j, k) => (i + 512) * 1048576 + (j + 512) * 1024 + (k + 512);
  for (let v = 0; v < nv; v++) {
    const k = key(Math.floor(pos[v * 3] / CELL), Math.floor(pos[v * 3 + 1] / CELL), Math.floor(pos[v * 3 + 2] / CELL));
    let list = hash.get(k);
    if (!list) hash.set(k, (list = []));
    list.push(v);
  }

  function d2(v, x, y, z) {
    const dx = pos[v * 3] - x, dy = pos[v * 3 + 1] - y, dz = pos[v * 3 + 2] - z;
    return dx * dx + dy * dy + dz * dz;
  }

  // Nearest vertex by growing shells of hash cells; falls back to a full scan far from the mesh.
  function nearest(x, y, z) {
    const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL), ck = Math.floor(z / CELL);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 6; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            const list = hash.get(key(ci + i, cj + j, ck + k));
            if (!list) continue;
            for (const v of list) {
              const d = d2(v, x, y, z);
              if (d < bestD) (bestD = d), (best = v);
            }
          }
      // Anything in a farther shell is at least r·CELL away.
      if (best >= 0 && Math.sqrt(bestD) <= r * CELL) return best;
    }
    if (best >= 0) return best;
    for (let v = 0; v < nv; v++) {
      const d = d2(v, x, y, z);
      if (d < bestD) (bestD = d), (best = v);
    }
    return best;
  }

  // Greedy descent over the one-ring to the vertex nearest p.
  function descend(v, x, y, z) {
    let d = d2(v, x, y, z);
    for (let it = 0; it < 64; it++) {
      let next = v;
      for (let k = offsets[v]; k < offsets[v + 1]; k++) {
        const u = neighbours[k], du = d2(u, x, y, z);
        if (du < d) (d = du), (next = u);
      }
      if (next === v) break;
      v = next;
    }
    return v;
  }

  const bary = [0, 0, 0];
  // Faces already tested by the current project() call carry its stamp.
  const faceMark = new Int32Array(nf);
  let faceStamp = 0;
  let px = 0, py = 0, pz = 0, bestD = Infinity, best = null;

  function testFaces(u) {
    for (let k = vfOffsets[u]; k < vfOffsets[u + 1]; k++) {
      const f = vfFaces[k];
      if (faceMark[f] === faceStamp) continue;
      faceMark[f] = faceStamp;
      const d = closestOnTriangle(px, py, pz, pos, index[f * 3], index[f * 3 + 1], index[f * 3 + 2], bary);
      if (d < bestD) {
        bestD = d;
        best.face = f;
        best.bary[0] = bary[0];
        best.bary[1] = bary[1];
        best.bary[2] = bary[2];
      }
    }
  }

  // Closest point to (x,y,z) on the faces around the nearest vertex and its one-ring, starting from hint.
  function project(x, y, z, hint, out = createState()) {
    const v = descend(hint >= 0 ? hint : nearest(x, y, z), x, y, z);
    if (++faceStamp === 0x7fffffff) faceMark.fill(0), (faceStamp = 1);
    (px = x), (py = y), (pz = z), (bestD = Infinity), (best = out);
    testFaces(v);
    for (let k = offsets[v]; k < offsets[v + 1]; k++) testFaces(neighbours[k]);
    best = null;
    resolve(out);
    return out;
  }

  // Fills p, n and vtx from face and bary.
  function resolve(out) {
    const f = out.face, b = out.bary;
    const ia = index[f * 3], ib = index[f * 3 + 1], ic = index[f * 3 + 2];
    let nl = 0;
    for (let c = 0; c < 3; c++) {
      out.p[c] = b[0] * pos[ia * 3 + c] + b[1] * pos[ib * 3 + c] + b[2] * pos[ic * 3 + c];
      out.n[c] = b[0] * nrm[ia * 3 + c] + b[1] * nrm[ib * 3 + c] + b[2] * nrm[ic * 3 + c];
      nl += out.n[c] * out.n[c];
    }
    nl = 1 / Math.sqrt(Math.max(nl, 1e-20));
    for (let c = 0; c < 3; c++) out.n[c] *= nl;
    out.vtx = b[0] >= b[1] && b[0] >= b[2] ? ia : b[1] >= b[2] ? ib : ic;
    return out;
  }

  // Moves a state by delta along the surface, in sub-moves shorter than half an edge.
  function move(state, dx, dy, dz) {
    const len = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(len / (0.5 * edge)));
    for (let s = 0; s < steps; s++)
      project(state.p[0] + dx / steps, state.p[1] + dy / steps, state.p[2] + dz / steps, state.vtx, state);
    return state;
  }

  // State at face f with barycentrics (u, v, 1-u-v).
  function atFace(f, u, v, out = createState()) {
    out.face = f;
    out.bary[0] = u;
    out.bary[1] = v;
    out.bary[2] = 1 - u - v;
    return resolve(out);
  }

  const rim = (v) => (rimAttr ? rimAttr[v] : 1);

  // Attribute name interpolated at a walk state (fallback when the mesh has none).
  function attrAt(name, s, fallback = 1) {
    const a = geometry.attributes[name]?.array;
    if (!a) return fallback;
    const f = s.face;
    return s.bary[0] * a[index[f * 3]] + s.bary[1] * a[index[f * 3 + 1]] + s.bary[2] * a[index[f * 3 + 2]];
  }

  const ringMark = new Int32Array(nv).fill(-1);
  let ringStamp = 0;
  const ring = [];
  const NQ = 5;
  const M = new Float64Array(NQ * NQ), rhs = new Float64Array(NQ), sol = new Float64Array(NQ);
  const quadZ = (x, y) => {
    const P = sol[0] + sol[1] * x * x + sol[2] * x * y + sol[3] * y * y;
    return (2 * P) / (1 + Math.sqrt(Math.max(0, 1 - 4 * sol[4] * P)));
  };

  // Least-squares implicit quadric z = c0 + k1·x² + k2·xy + k3·y² + λ·z² over the vertices within radius of state s
  // (breadth-first from its vertex), in the frame (s.n, e1, e2) with e1 the tangent part of hint. The z² term makes
  // spheres and rounded tips exact. Fills out { n, e1, e2, c0, k1, k2, k3, lambda, rms, count } and returns it, or
  // null when the patch is too small or the system singular.
  function fitQuadric(s, hint, radius, out) {
    const [nx, ny, nz] = s.n;
    let ex = hint[0], ey = hint[1], ez = hint[2];
    const hd = ex * nx + ey * ny + ez * nz;
    (ex -= hd * nx), (ey -= hd * ny), (ez -= hd * nz);
    let el = Math.hypot(ex, ey, ez);
    if (el < 1e-4) {
      const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = 1 - ax;
      (ex = ay * nz), (ey = -ax * nz), (ez = ax * ny - ay * nx);
      el = Math.hypot(ex, ey, ez);
    }
    (ex /= el), (ey /= el), (ez /= el);
    const fx = ny * ez - nz * ey, fy = nz * ex - nx * ez, fz = nx * ey - ny * ex;
    const r2 = radius * radius;
    ringStamp++;
    ring.length = 0;
    ring.push(s.vtx);
    ringMark[s.vtx] = ringStamp;
    for (let q = 0; q < ring.length && ring.length < 400; q++) {
      const v = ring[q];
      for (let k = offsets[v]; k < offsets[v + 1]; k++) {
        const u = neighbours[k];
        if (ringMark[u] === ringStamp) continue;
        ringMark[u] = ringStamp;
        if (d2(u, s.p[0], s.p[1], s.p[2]) < r2) ring.push(u);
      }
    }
    if (ring.length < 10) return null;
    M.fill(0);
    rhs.fill(0);
    const row = [1, 0, 0, 0, 0];
    for (const v of ring) {
      const dx = pos[v * 3] - s.p[0], dy = pos[v * 3 + 1] - s.p[1], dz = pos[v * 3 + 2] - s.p[2];
      const x = dx * ex + dy * ey + dz * ez, y = dx * fx + dy * fy + dz * fz, z = dx * nx + dy * ny + dz * nz;
      (row[1] = x * x), (row[2] = x * y), (row[3] = y * y), (row[4] = z * z);
      for (let i = 0; i < NQ; i++) {
        rhs[i] += row[i] * z;
        for (let j = 0; j < NQ; j++) M[i * NQ + j] += row[i] * row[j];
      }
    }
    // A touch of ridge on λ keeps flat patches (z² ≈ 0) well posed.
    M[NQ * NQ - 1] += 1e-9 * ring.length;
    if (!solveN(M, rhs, sol, NQ)) return null;
    let res = 0;
    for (const v of ring) {
      const dx = pos[v * 3] - s.p[0], dy = pos[v * 3 + 1] - s.p[1], dz = pos[v * 3 + 2] - s.p[2];
      const x = dx * ex + dy * ey + dz * ez, y = dx * fx + dy * fy + dz * fz, z = dx * nx + dy * ny + dz * nz;
      const e = z - quadZ(x, y);
      res += e * e;
    }
    out.n = [nx, ny, nz];
    out.e1 = [ex, ey, ez];
    out.e2 = [fx, fy, fz];
    [out.c0, out.k1, out.k2, out.k3, out.lambda] = sol;
    out.rms = Math.sqrt(res / ring.length);
    out.count = ring.length;
    return out;
  }

  // Vertex within radius of state s that lies furthest along g (breadth-first from its vertex).
  function lowest(s, g, radius) {
    const r2 = radius * radius;
    ringStamp++;
    ring.length = 0;
    ring.push(s.vtx);
    ringMark[s.vtx] = ringStamp;
    let best = s.vtx, bestD = -Infinity;
    for (let q = 0; q < ring.length && ring.length < 400; q++) {
      const v = ring[q];
      const d = pos[v * 3] * g[0] + pos[v * 3 + 1] * g[1] + pos[v * 3 + 2] * g[2];
      if (d > bestD) (bestD = d), (best = v);
      for (let k = offsets[v]; k < offsets[v + 1]; k++) {
        const u = neighbours[k];
        if (ringMark[u] === ringStamp) continue;
        ringMark[u] = ringStamp;
        if (d2(u, s.p[0], s.p[1], s.p[2]) < r2) ring.push(u);
      }
    }
    return best;
  }

  return { edge, nearest, project, move, atFace, rim, attrAt, fitQuadric, lowest, position: pos, normal: nrm, index, nf, nv };
}

// Gaussian elimination with partial pivoting on the N×N system M·x = b (both overwritten); false if singular.
function solveN(M, b, x, N) {
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r * N + c]) > Math.abs(M[p * N + c])) p = r;
    if (Math.abs(M[p * N + c]) < 1e-24) return false;
    if (p !== c) {
      for (let k = 0; k < N; k++) [M[c * N + k], M[p * N + k]] = [M[p * N + k], M[c * N + k]];
      [b[c], b[p]] = [b[p], b[c]];
    }
    for (let r = c + 1; r < N; r++) {
      const f = M[r * N + c] / M[c * N + c];
      for (let k = c; k < N; k++) M[r * N + k] -= f * M[c * N + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = N - 1; r >= 0; r--) {
    let v = b[r];
    for (let k = r + 1; k < N; k++) v -= M[r * N + k] * x[k];
    x[r] = v / M[r * N + r];
  }
  return true;
}

export function createState() {
  return { p: [0, 0, 0], n: [0, 1, 0], face: 0, bary: [1, 0, 0], vtx: 0 };
}

// Squared distance from p to triangle abc (vertex indices into pos); barycentrics of the closest point go in out.
export function closestOnTriangle(px, py, pz, pos, ia, ib, ic, out) {
  const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
  const abx = pos[ib * 3] - ax, aby = pos[ib * 3 + 1] - ay, abz = pos[ib * 3 + 2] - az;
  const acx = pos[ic * 3] - ax, acy = pos[ic * 3 + 1] - ay, acz = pos[ic * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) (u = 1), (v = 0), (w = 0);
  else {
    const bpx = px - pos[ib * 3], bpy = py - pos[ib * 3 + 1], bpz = pz - pos[ib * 3 + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - pos[ic * 3], cpy = py - pos[ic * 3 + 1], cpz = pz - pos[ic * 3 + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) (u = 0), (v = 1), (w = 0);
    else if (d6 >= 0 && d5 <= d6) (u = 0), (v = 0), (w = 1);
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      (u = 1 - t), (v = t), (w = 0);
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      (u = 1 - t), (v = 0), (w = t);
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
      (u = 0), (v = 1 - t), (w = t);
    } else {
      const den = 1 / (va + vb + vc);
      v = vb * den;
      w = vc * den;
      u = 1 - v - w;
    }
  }
  out[0] = u;
  out[1] = v;
  out[2] = w;
  const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

// Nearest walk point that faces the ray; in a crease the nearest vertex can lie on the far side, so retry from just
// in front of the hit, and miss if that fails too.
export function projectFacing(walk, p, d) {
  for (const back of [0, 0.01, 0.025, 0.05]) {
    const h = walk.project(p.x - d.x * back, p.y - d.y * back, p.z - d.z * back, -1);
    if (h.n[0] * d.x + h.n[1] * d.y + h.n[2] * d.z < 0 && Math.hypot(h.p[0] - p.x, h.p[1] - p.y, h.p[2] - p.z) < 0.04) return h;
  }
  return null;
}
