// Bakes Suzanne's signed distance field (assets/suzanne-sdf-96.bin): the Loop-subdivided head, slightly dilated and
// blurred. usage: node tools/suzanne-sdf.mjs [out=assets/suzanne-sdf-96.bin]
// Output: N^3 half floats over [-EXTENT, EXTENT]^3 (x fastest), in units where the head's bounding radius is 1.
import { register } from "node:module";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableParallelism } from "node:os";
import fs from "node:fs";

const N = 96;
const EXTENT = 1.12;
const DILATE = 0.015;
const SIGMA = 1.1; // blur, in voxels

const root = new URL("../", import.meta.url);

function triDistance(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az;
  const acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - t[o + 3], bpy = py - t[o + 4], bpz = pz - t[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - abx * v, apy - aby * v, apz - abz * v);
  }
  const cpx = px - t[o + 6], cpy = py - t[o + 7], cpz = pz - t[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - acx * w, apy - acy * w, apz - acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bcx = t[o + 6] - t[o + 3], bcy = t[o + 7] - t[o + 4], bcz = t[o + 8] - t[o + 5];
    return Math.hypot(bpx - bcx * w, bpy - bcy * w, bpz - bcz * w);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

// Solid angle of a triangle seen from p (Van Oosterom & Strackee); summed it gives the winding number.
function solidAngle(px, py, pz, t, o) {
  const Ax = t[o] - px, Ay = t[o + 1] - py, Az = t[o + 2] - pz;
  const Bx = t[o + 3] - px, By = t[o + 4] - py, Bz = t[o + 5] - pz;
  const Cx = t[o + 6] - px, Cy = t[o + 7] - py, Cz = t[o + 8] - pz;
  const la = Math.hypot(Ax, Ay, Az), lb = Math.hypot(Bx, By, Bz), lc = Math.hypot(Cx, Cy, Cz);
  const det = Ax * (By * Cz - Bz * Cy) + Ay * (Bz * Cx - Bx * Cz) + Az * (Bx * Cy - By * Cx);
  const AB = Ax * Bx + Ay * By + Az * Bz, AC = Ax * Cx + Ay * Cy + Az * Cz, BC = Bx * Cx + By * Cy + Bz * Cz;
  return 2 * Math.atan2(det, la * lb * lc + AB * lc + AC * lb + BC * la);
}

if (!isMainThread) {
  const { tris, k0, k1 } = workerData;
  const out = new Float32Array((k1 - k0) * N * N);
  const count = tris.length / 9;
  for (let k = k0; k < k1; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N * 2 - 1) * EXTENT, y = ((j + 0.5) / N * 2 - 1) * EXTENT, z = ((k + 0.5) / N * 2 - 1) * EXTENT;
        let d = Infinity, w = 0;
        for (let t = 0; t < count; t++) {
          d = Math.min(d, triDistance(x, y, z, tris, t * 9));
          w += solidAngle(x, y, z, tris, t * 9);
        }
        out[i + N * (j + N * (k - k0))] = Math.abs(w) / (4 * Math.PI) > 0.5 ? -d : d;
      }
  parentPort.postMessage(out, [out.buffer]);
} else {
  // Resolve "three" (imported by the shared Suzanne helpers) to the vendored build.
  const three = new URL("third_party/three.module.js", root).href;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === "three" ? { url: ${JSON.stringify(three)}, shortCircuit: true } : next(s, c); }`)}`);
  const { suzanneGeometry } = await import(new URL("modules/suzanne/suzanneMesh.js", root).href);

  const out = process.argv[2] ?? new URL("assets/suzanne-sdf-96.bin", root).pathname;
  const geo = suzanneGeometry(fs.readFileSync(new URL("assets/suzanne.obj", root), "utf8"), 2);
  const p = geo.attributes.position.array;
  const index = geo.index.array;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], p[i + a])), (hi[a] = Math.max(hi[a], p[i + a]));
  const c = lo.map((l, a) => (l + hi[a]) / 2);
  let r = 0;
  for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]));
  const s = (1 - DILATE) / r;
  const tris = new Float32Array(index.length * 3);
  for (let t = 0; t < index.length; t++) for (let a = 0; a < 3; a++) tris[t * 3 + a] = (p[index[t] * 3 + a] - c[a]) * s;
  console.log(`${index.length / 3} triangles`);

  const threads = Math.max(1, availableParallelism() - 1);
  const field = new Float32Array(N ** 3);
  const jobs = [];
  for (let w = 0; w < threads; w++) {
    const k0 = Math.floor((w * N) / threads), k1 = Math.floor(((w + 1) * N) / threads);
    if (k1 <= k0) continue;
    jobs.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { tris, k0, k1 } });
        worker.on("message", (slab) => {
          field.set(slab, k0 * N * N);
          resolve();
        });
        worker.on("error", reject);
      }),
    );
  }
  await Promise.all(jobs);
  for (let i = 0; i < field.length; i++) field[i] -= DILATE;

  // Separable Gaussian blur: takes the last facets off and rounds the creases.
  const R = Math.ceil(SIGMA * 3), kern = [];
  for (let x = -R; x <= R; x++) kern.push(Math.exp(-(x * x) / (2 * SIGMA * SIGMA)));
  const ks = kern.reduce((a, b) => a + b);
  let a = field, b = new Float32Array(N ** 3);
  for (const stride of [1, N, N * N]) {
    for (let idx = 0; idx < N ** 3; idx++) {
      const g = Math.floor(idx / stride) % N;
      let sum = 0;
      for (let x = -R; x <= R; x++) sum += a[idx + (Math.min(N - 1, Math.max(0, g + x)) - g) * stride] * kern[x + R];
      b[idx] = sum / ks;
    }
    [a, b] = [b, a];
  }

  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const toHalf = (v) => {
    f32[0] = v;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 127 + 15;
    let m = x & 0x7fffff;
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
      if (e < -10) return sign;
      m = (m | 0x800000) >> (1 - e);
      return sign | ((m + 0x1000) >> 13);
    }
    return (sign | (e << 10) | (m >> 13)) + ((m >> 12) & 1);
  };
  const half = new Uint16Array(N ** 3);
  for (let i = 0; i < half.length; i++) half[i] = toHalf(a[i]);
  fs.writeFileSync(out, new Uint8Array(half.buffer));
  console.log(`wrote ${out}: ${N}^3 over ±${EXTENT}, inside ${a.filter((v) => v < 0).length} voxels`);
}
