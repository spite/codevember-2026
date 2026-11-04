// Indexed surface nets plus the clean-up passes shared by every shape bake.

export function gradient(sdf, x, y, z, e = 1e-3) {
  return [
    (sdf(x + e, y, z) - sdf(x - e, y, z)) / (2 * e),
    (sdf(x, y + e, z) - sdf(x, y - e, z)) / (2 * e),
    (sdf(x, y, z + e) - sdf(x, y, z - e)) / (2 * e),
  ];
}

function newton(sdf, p, steps, e) {
  for (let it = 0; it < steps; it++) {
    const d = sdf(p[0], p[1], p[2]);
    const g = gradient(sdf, p[0], p[1], p[2], e);
    const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    if (!(g2 > 1e-12)) break;
    p[0] -= (d * g[0]) / g2;
    p[1] -= (d * g[1]) / g2;
    p[2] -= (d * g[2]) / g2;
  }
}

// Surface nets over [-b, b]^3 with N cells per axis: shared vertices and an outward-wound index.
export function surfaceNets(sdf, b, N, { newtonSteps = 6 } = {}) {
  const h = (2 * b) / N;
  const M = N + 1;
  const vals = new Float32Array(M * M * M);
  for (let k = 0; k < M; k++)
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) vals[i + M * (j + M * k)] = sdf(-b + i * h, -b + j * h, -b + k * h);
  const cellVert = new Int32Array(N * N * N).fill(-1);
  const pos = [];
  const c = new Float32Array(8);
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        let neg = 0;
        for (let m = 0; m < 8; m++) {
          c[m] = vals[i + (m & 1) + M * (j + ((m >> 1) & 1) + M * (k + (m >> 2)))];
          if (c[m] < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let x = 0, y = 0, z = 0, n = 0;
        for (let m = 0; m < 8; m++)
          for (const bit of [1, 2, 4]) {
            if (m & bit || (c[m] < 0) === (c[m | bit] < 0)) continue;
            const t = c[m] / (c[m] - c[m | bit]);
            x += (m & 1) + (bit === 1 ? t : 0);
            y += ((m >> 1) & 1) + (bit === 2 ? t : 0);
            z += (m >> 2) + (bit === 4 ? t : 0);
            n++;
          }
        const p = [-b + (i + x / n) * h, -b + (j + y / n) * h, -b + (k + z / n) * h];
        newton(sdf, p, newtonSteps, h * 1e-2);
        // Keep the vertex in its cell's neighbourhood so a bad step cannot fold the mesh.
        const cx = -b + (i + 0.5) * h, cy = -b + (j + 0.5) * h, cz = -b + (k + 0.5) * h;
        const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz, dl = Math.hypot(dx, dy, dz);
        if (!(dl < h)) {
          p[0] = -b + (i + x / n) * h; p[1] = -b + (j + y / n) * h; p[2] = -b + (k + z / n) * h;
        }
        cellVert[i + N * (j + N * k)] = pos.length / 3;
        pos.push(p[0], p[1], p[2]);
      }
  const tris = [];
  const cv = (i, j, k) => cellVert[i + N * (j + N * k)];
  const dist2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  // Corners go counter-clockwise about +axis; flip when the outside lies on the negative side.
  const quad = (a, b2, c2, d, flip) => {
    if (flip) [b2, d] = [d, b2];
    if (dist2(a, c2) <= dist2(b2, d)) tris.push(a, b2, c2, a, c2, d);
    else tris.push(a, b2, d, b2, c2, d);
  };
  for (let k = 1; k < N; k++)
    for (let j = 1; j < N; j++)
      for (let i = 1; i < N; i++) {
        const v0 = vals[i + M * (j + M * k)] < 0;
        if (v0 !== vals[i + 1 + M * (j + M * k)] < 0) quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), !v0);
        if (v0 !== vals[i + M * (j + 1 + M * k)] < 0) quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), !v0);
        if (v0 !== vals[i + M * (j + M * (k + 1))] < 0) quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), !v0);
      }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(tris) };
}

// Drops unused vertices and degenerate triangles.
export function compact({ pos, index }) {
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (a === b || b === c || c === a) continue;
    tris.push(a, b, c);
  }
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  for (const v of tris) if (remap[v] < 0) { remap[v] = out.length / 3; out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
  return { pos: Float64Array.from(out), index: Uint32Array.from(tris.map((v) => remap[v])) };
}

// Edge use counts, orientation consistency, Euler characteristic and connected components.
export function topology({ pos, index }) {
  const nv = pos.length / 3, nf = index.length / 3;
  const edges = new Map();
  let misoriented = 0;
  for (let t = 0; t < index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      const rec = edges.get(key) || { n: 0, dir: 0 };
      rec.n++;
      rec.dir += a < b ? 1 : -1;
      edges.set(key, rec);
    }
  let boundary = 0, nonManifold = 0;
  for (const r of edges.values()) {
    if (r.n === 1) boundary++;
    else if (r.n > 2) nonManifold++;
    else if (r.dir !== 0) misoriented++;
  }
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]);
    parent[find(index[t + 1])] = a;
    parent[find(index[t + 2])] = a;
  }
  const roots = new Set();
  for (let v = 0; v < nv; v++) roots.add(find(v));
  return { verts: nv, tris: nf, edges: edges.size, euler: nv - edges.size + nf, boundary, nonManifold, misoriented, components: roots.size, componentOf: (v) => find(v) };
}

export function neighbours({ pos, index }) {
  const nv = pos.length / 3;
  const sets = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)];
      sets[a].add(b);
      sets[b].add(a);
    }
  return sets.map((s) => [...s]);
}

// Tangential Laplacian smoothing, each round followed by one projection back onto the surface.
export function relax(mesh, sdf, rounds = 3, amount = 0.5) {
  const nb = neighbours(mesh);
  const { pos } = mesh;
  const nv = pos.length / 3;
  for (let r = 0; r < rounds; r++) {
    const next = new Float64Array(pos);
    for (let v = 0; v < nv; v++) {
      const list = nb[v];
      if (!list.length) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const u of list) { cx += pos[u * 3]; cy += pos[u * 3 + 1]; cz += pos[u * 3 + 2]; }
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let dx = cx / list.length - x, dy = cy / list.length - y, dz = cz / list.length - z;
      const g = gradient(sdf, x, y, z);
      const gl = Math.hypot(g[0], g[1], g[2]) || 1;
      const nx = g[0] / gl, ny = g[1] / gl, nz = g[2] / gl;
      const dn = dx * nx + dy * ny + dz * nz;
      dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
      const p = [x + amount * dx, y + amount * dy, z + amount * dz];
      newton(sdf, p, 1, 1e-3);
      next[v * 3] = p[0]; next[v * 3 + 1] = p[1]; next[v * 3 + 2] = p[2];
    }
    pos.set(next);
  }
  return mesh;
}

export function sdfNormals(mesh, sdf) {
  const { pos } = mesh;
  const nv = pos.length / 3;
  const n = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const g = gradient(sdf, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    const l = Math.hypot(g[0], g[1], g[2]) || 1;
    n[v * 3] = g[0] / l; n[v * 3 + 1] = g[1] / l; n[v * 3 + 2] = g[2] / l;
  }
  return n;
}

// Area-weighted face normals, as BufferGeometry.computeVertexNormals would give.
export function meshNormals({ pos, index }) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < index.length; t += 3) {
    const f = faceNormal(pos, index[t], index[t + 1], index[t + 2], false);
    for (let e = 0; e < 3; e++) for (let k = 0; k < 3; k++) n[index[t + e] * 3 + k] += f[k];
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    n[v] /= l; n[v + 1] /= l; n[v + 2] /= l;
  }
  return n;
}

export function faceNormal(pos, a, b, c, normalize = true) {
  const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  if (!normalize) return [x, y, z];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// 5-tap occlusion along the normal, as in 2/fracture.js; exactly 1 on a convex solid.
export function bakeAO(mesh, normals, sdf, size = 1) {
  const { pos } = mesh;
  const nv = pos.length / 3;
  const ao = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
    let occ = 0;
    for (const f of [0.06, 0.15, 0.3, 0.5, 0.8]) {
      const h = size * f;
      occ += Math.min(Math.max((h - sdf(x + nx * h, y + ny * h, z + nz * h)) / h, 0), 1);
    }
    ao[v] = 1 - occ / 5;
  }
  return ao;
}

// Angle between each facet normal and the SDF gradient at the facet centroid, in degrees.
export function facetAngles({ pos, index }, gradAt) {
  let sum = 0, max = 0, count = 0, over = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const f = faceNormal(pos, a, b, c);
    const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
    const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
    const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    const g = gradAt(cx, cy, cz);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    const dot = (f[0] * g[0] + f[1] * g[1] + f[2] * g[2]) / gl;
    const ang = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    sum += ang; count++;
    if (ang > max) max = ang;
    if (ang > 90) over++;
  }
  return { mean: sum / count, max, flipped: over };
}

// Cubic grid of res^3 samples at voxel centres around the given AABB plus a margin.
export function sdfGrid(sdf, aabbMin, aabbMax, res = 48, margin = 0.25) {
  const size = Math.max(aabbMax[0] - aabbMin[0], aabbMax[1] - aabbMin[1], aabbMax[2] - aabbMin[2]) + 2 * margin;
  const min = [0, 1, 2].map((k) => (aabbMin[k] + aabbMax[k]) / 2 - size / 2);
  const h = size / res;
  const data = new Float32Array(res * res * res);
  for (let k = 0; k < res; k++)
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++)
        data[i + res * (j + res * k)] = sdf(min[0] + (i + 0.5) * h, min[1] + (j + 0.5) * h, min[2] + (k + 0.5) * h);
  return { res, min, size, data };
}

// Trilinear lookup of a voxel-centred grid, clamped at the border like a ClampToEdge texture.
export function gridSampler({ res, min, size, data }) {
  const h = size / res;
  const at = (i, j, k) => data[Math.min(res - 1, Math.max(0, i)) + res * (Math.min(res - 1, Math.max(0, j)) + res * Math.min(res - 1, Math.max(0, k)))];
  return (x, y, z) => {
    const fx = (x - min[0]) / h - 0.5, fy = (y - min[1]) / h - 0.5, fz = (z - min[2]) / h - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(at(i, j, k), at(i + 1, j, k), tx), l(at(i, j + 1, k), at(i + 1, j + 1, k), tx), ty),
      l(l(at(i, j, k + 1), at(i + 1, j, k + 1), tx), l(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), tx), ty),
      tz,
    );
  };
}

export function aabb(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < pos.length; v += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[v + k]);
      hi[k] = Math.max(hi[k], pos[v + k]);
    }
  return { lo, hi };
}

// Closest point on triangle (a, b, c are offsets into P); writes it to out and returns the squared distance.
function closestOnTriangle(px, py, pz, P, a, b, c, out) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const at = (s, t) => {
    out[0] = ax + s * abx + t * acx; out[1] = ay + s * aby + t * acy; out[2] = az + s * abz + t * acz;
    return (out[0] - px) ** 2 + (out[1] - py) ** 2 + (out[2] - pz) ** 2;
  };
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}

// Signed distance grid (voxel centres) to a triangle mesh: exact closest points in a band around the
// surface, carried outwards by closest-point sweeps; the sign comes from inside(x, y, z).
export function meshSdfGrid({ pos, index }, inside, aabbMin, aabbMax, res = 48, margin = 0.25) {
  const size = Math.max(aabbMax[0] - aabbMin[0], aabbMax[1] - aabbMin[1], aabbMax[2] - aabbMin[2]) + 2 * margin;
  const min = [0, 1, 2].map((k) => (aabbMin[k] + aabbMax[k]) / 2 - size / 2);
  const h = size / res;
  const n = res * res * res;
  const cx = (i) => min[0] + (i + 0.5) * h, cy = (j) => min[1] + (j + 0.5) * h, cz = (k) => min[2] + (k + 0.5) * h;
  // Triangles bucketed by grid voxel.
  const buckets = new Map();
  const cell = (v, k) => Math.max(0, Math.min(res - 1, Math.floor((v - min[k]) / h)));
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const r = [0, 1, 2].map((k) => [cell(Math.min(pos[a + k], pos[b + k], pos[c + k]), k), cell(Math.max(pos[a + k], pos[b + k], pos[c + k]), k)]);
    for (let z = r[2][0]; z <= r[2][1]; z++)
      for (let y = r[1][0]; y <= r[1][1]; y++)
        for (let x = r[0][0]; x <= r[0][1]; x++) {
          const key = x + res * (y + res * z);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(a, b, c);
        }
  }
  const cp = new Float64Array(n * 3).fill(NaN);
  const best = new Float64Array(n).fill(Infinity);
  const tmp = [0, 0, 0];
  const BAND = 2;
  for (const [key, list] of buckets) {
    const i0 = key % res, j0 = Math.floor(key / res) % res, k0 = Math.floor(key / (res * res));
    for (let dk = -BAND; dk <= BAND; dk++)
      for (let dj = -BAND; dj <= BAND; dj++)
        for (let di = -BAND; di <= BAND; di++) {
          const i = i0 + di, j = j0 + dj, k = k0 + dk;
          if (i < 0 || j < 0 || k < 0 || i >= res || j >= res || k >= res) continue;
          const v = i + res * (j + res * k);
          const x = cx(i), y = cy(j), z = cz(k);
          for (let q = 0; q < list.length; q += 3) {
            const d = closestOnTriangle(x, y, z, pos, list[q], list[q + 1], list[q + 2], tmp);
            if (d < best[v]) { best[v] = d; cp[v * 3] = tmp[0]; cp[v * 3 + 1] = tmp[1]; cp[v * 3 + 2] = tmp[2]; }
          }
        }
  }
  // Gauss-Seidel sweeps in all 8 octant orders, each voxel adopting a neighbour's closest point if nearer.
  for (let pass = 0; pass < 2; pass++)
    for (let o = 0; o < 8; o++) {
      const si = o & 1 ? -1 : 1, sj = o & 2 ? -1 : 1, sk = o & 4 ? -1 : 1;
      for (let kk = 0; kk < res; kk++) {
        const k = sk > 0 ? kk : res - 1 - kk;
        for (let jj = 0; jj < res; jj++) {
          const j = sj > 0 ? jj : res - 1 - jj;
          for (let ii = 0; ii < res; ii++) {
            const i = si > 0 ? ii : res - 1 - ii;
            const v = i + res * (j + res * k);
            const x = cx(i), y = cy(j), z = cz(k);
            for (let dk = -1; dk <= 1; dk++)
              for (let dj = -1; dj <= 1; dj++)
                for (let di = -1; di <= 1; di++) {
                  const a = i + di, b = j + dj, c = k + dk;
                  if (a < 0 || b < 0 || c < 0 || a >= res || b >= res || c >= res) continue;
                  const u = a + res * (b + res * c);
                  if (!(best[u] < Infinity)) continue;
                  const d = (cp[u * 3] - x) ** 2 + (cp[u * 3 + 1] - y) ** 2 + (cp[u * 3 + 2] - z) ** 2;
                  if (d < best[v]) { best[v] = d; cp[v * 3] = cp[u * 3]; cp[v * 3 + 1] = cp[u * 3 + 1]; cp[v * 3 + 2] = cp[u * 3 + 2]; }
                }
          }
        }
      }
    }
  const data = new Float32Array(n);
  for (let k = 0; k < res; k++)
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const v = i + res * (j + res * k);
        data[v] = (inside(cx(i), cy(j), cz(k)) ? -1 : 1) * Math.sqrt(best[v]);
      }
  return { res, min, size, data };
}
