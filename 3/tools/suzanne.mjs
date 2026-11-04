// Suzanne: Loop-subdivided OBJ (as the page builds it) and a signed distance field voxelised from it.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { topology, aabb } from "./mesher.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const threeUrl = pathToFileURL(`${here}../../third_party/three.core.js`).href;
// suzanneMesh.js and subdivide.js import the bare "three" that the page's importmap resolves.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(s, c, next) {
      if (s === "three") return { url: ${JSON.stringify(threeUrl)}, shortCircuit: true };
      return next(s, c);
    }`),
);
const { suzanneGeometry } = await import("../suzanneMesh.js");

// Raw OBJ coordinates per level, built by the same code the page runs.
export function loadSuzanne(objPath, levels) {
  const text = readFileSync(objPath, "utf8");
  return levels.map((level) => {
    const geo = suzanneGeometry(text, level);
    return { level, pos: Float64Array.from(geo.attributes.position.array), index: Uint32Array.from(geo.index.array) };
  });
}

// Per-axis ray parity over a cubic grid of voxel centres; returns votes 0..3 per voxel.
function parityVotes(R, min, h, pos, index) {
  const votes = new Uint8Array(R * R * R);
  const cell = (v, k) => (v - min[k]) / h - 0.5;
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, d = (a + 2) % 3;
    const hits = Array.from({ length: R * R }, () => []);
    for (let t = 0; t < index.length; t += 3) {
      const p = index[t] * 3, q = index[t + 1] * 3, r = index[t + 2] * 3;
      const pb = pos[p + b], pd = pos[p + d], qb = pos[q + b], qd = pos[q + d], rb = pos[r + b], rd = pos[r + d];
      const det = (qb - pb) * (rd - pd) - (rb - pb) * (qd - pd);
      if (Math.abs(det) < 1e-18) continue;
      const i0 = Math.max(0, Math.ceil(cell(Math.min(pb, qb, rb), b))), i1 = Math.min(R - 1, Math.floor(cell(Math.max(pb, qb, rb), b)));
      const j0 = Math.max(0, Math.ceil(cell(Math.min(pd, qd, rd), d))), j1 = Math.min(R - 1, Math.floor(cell(Math.max(pd, qd, rd), d)));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          // Offsets keep the rays off shared edges and vertices.
          const u = min[b] + (i + 0.5) * h + 1.3e-7, v = min[d] + (j + 0.5) * h + 0.7e-7;
          const l1 = ((u - pb) * (rd - pd) - (rb - pb) * (v - pd)) / det;
          const l2 = ((qb - pb) * (v - pd) - (u - pb) * (qd - pd)) / det;
          if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
          hits[j * R + i].push(pos[p + a] + l1 * (pos[q + a] - pos[p + a]) + l2 * (pos[r + a] - pos[p + a]));
        }
    }
    for (let j = 0; j < R; j++)
      for (let i = 0; i < R; i++) {
        const hh = hits[j * R + i].sort((x, y) => x - y);
        for (let s = 0; s + 1 < hh.length; s += 2) {
          const k0 = Math.max(0, Math.ceil(cell(hh[s], a))), k1 = Math.min(R - 1, Math.floor(cell(hh[s + 1], a)));
          for (let k = k0; k <= k1; k++) {
            const ijk = [0, 0, 0];
            ijk[a] = k; ijk[b] = i; ijk[d] = j;
            votes[ijk[0] + R * (ijk[1] + R * ijk[2])]++;
          }
        }
      }
  }
  return votes;
}

// Felzenszwalb 1D squared distance transform, in place on f with stride.
function edt1d(f, off, stride, n, z, v, g) {
  for (let i = 0; i < n; i++) g[i] = f[off + i * stride];
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const r = v[k];
      s = (g[q] + q * q - (g[r] + r * r)) / (2 * q - 2 * r);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) { v[0] = q; z[0] = -Infinity; z[1] = Infinity; k = 0; continue; }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    f[off + q * stride] = (q - r) * (q - r) + g[r];
  }
}

// Squared Euclidean distance, in voxels, from every voxel to the nearest voxel where seed is true.
function edt3(R, seed) {
  const f = new Float64Array(R * R * R);
  for (let i = 0; i < f.length; i++) f[i] = seed[i] ? 0 : 1e20;
  const z = new Float64Array(R + 1), v = new Int32Array(R), g = new Float64Array(R);
  for (let k = 0; k < R; k++) for (let j = 0; j < R; j++) edt1d(f, R * (j + R * k), 1, R, z, v, g);
  for (let k = 0; k < R; k++) for (let i = 0; i < R; i++) edt1d(f, i + R * R * k, R, R, z, v, g);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) edt1d(f, i + R * j, R * R, R, z, v, g);
  return f;
}

function blur3(R, data, sigma) {
  const rad = Math.ceil(3 * sigma);
  const w = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const x = Math.exp((-i * i) / (2 * sigma * sigma)); w.push(x); sum += x; }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  let src = data, dst = new Float32Array(data.length);
  const strides = [1, R, R * R];
  for (const s of strides) {
    for (let idx = 0; idx < src.length; idx++) {
      const c = Math.floor(idx / s) % R;
      let acc = 0;
      for (let t = -rad; t <= rad; t++) {
        const cc = Math.min(R - 1, Math.max(0, c + t));
        acc += w[t + rad] * src[idx + (cc - c) * s];
      }
      dst[idx] = acc;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// Signed field on a fine cubic grid around the (already normalised) mesh: inside where at least two
// axis parities agree per connected piece, OR-ed together, then a signed EDT and a light blur.
export function suzanneField({ pos, index }, { R = 192, margin = 0.3, sigma = 1 } = {}) {
  const { lo, hi } = aabb(pos);
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 2 * margin;
  const min = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2 - size / 2);
  const h = size / R;
  const topo = topology({ pos, index });
  const groups = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const c = topo.componentOf(index[t]);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(index[t], index[t + 1], index[t + 2]);
  }
  const inside = new Uint8Array(R * R * R);
  for (const tris of groups.values()) {
    const votes = parityVotes(R, min, h, pos, tris);
    for (let i = 0; i < inside.length; i++) if (votes[i] >= 2) inside[i] = 1;
  }
  const outside = inside.map((x) => 1 - x);
  const dOut = edt3(R, inside), dIn = edt3(R, outside);
  const field = new Float32Array(R * R * R);
  for (let i = 0; i < field.length; i++) {
    field[i] = inside[i] ? -(Math.sqrt(dIn[i]) - 0.5) * h : (Math.sqrt(dOut[i]) - 0.5) * h;
  }
  return { res: R, min, size, data: blur3(R, field, sigma), components: groups.size };
}

