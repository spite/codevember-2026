// Bakes a smoothed signed distance field of Suzanne for the reaction-diffusion shapes.
// usage: node 5/tools/suzanne-sdf.mjs path/to/suzanne.obj 5/suzanne.bin
import fs from "fs";

const [src, out] = process.argv.slice(2);
const N = 64;
const EXTENT = 1.12; // the volume spans [-EXTENT, EXTENT], as in rd.js
const RANGE = 0.6; // stored distances span [-RANGE, RANGE] world units
const SIGMA = 1.4; // blur, in voxels
const DILATE = 0.05; // fattens it first, so the ears survive the blur

const verts = [], tris = [];
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  const t = line.trim().split(/\s+/);
  if (t[0] === "v") verts.push(t.slice(1, 4).map(Number));
  if (t[0] === "f") {
    const ids = t.slice(1).map((s) => parseInt(s, 10) - 1);
    for (let i = 1; i < ids.length - 1; i++) tris.push([ids[0], ids[i], ids[i + 1]]);
  }
}

// Centre it and fit its largest half-extent to 0.98.
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const v of verts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
const c = lo.map((l, a) => (l + hi[a]) / 2);
const s = 0.98 / Math.max(...hi.map((h, a) => (h - lo[a]) / 2));
const P = verts.map((v) => v.map((x, a) => (x - c[a]) * s));
const T = tris.map((t) => t.map((i) => P[i]));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

function triDistance(p, [a, b, cc]) {
  const ab = sub(b, a), ac = sub(cc, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return len(sub(ap, ab.map((x) => x * v))); }
  const cp = sub(p, cc), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return len(sub(ap, ac.map((x) => x * w))); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return len(sub(bp, sub(cc, b).map((x) => x * w))); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return len(sub(ap, [ab[0] * v + ac[0] * w, ab[1] * v + ac[1] * w, ab[2] * v + ac[2] * w]));
}

// Solid angle of a triangle seen from p (Van Oosterom & Strackee); summed it gives the winding number.
function solidAngle(p, [a, b, cc]) {
  const A = sub(a, p), B = sub(b, p), C = sub(cc, p);
  const la = len(A), lb = len(B), lc = len(C);
  return 2 * Math.atan2(dot(A, cross(B, C)), la * lb * lc + dot(A, B) * lc + dot(A, C) * lb + dot(B, C) * la);
}

const field = new Float32Array(N ** 3);
for (let k = 0; k < N; k++) {
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = [i, j, k].map((g) => ((g + 0.5) / N * 2 - 1) * EXTENT);
      let d = Infinity, w = 0;
      for (const t of T) { d = Math.min(d, triDistance(p, t)); w += solidAngle(p, t); }
      field[i + N * (j + N * k)] = (Math.abs(w) / (4 * Math.PI) > 0.5 ? -d : d) - DILATE;
    }
  process.stdout.write(`\r${k + 1}/${N}`);
}

// Separable Gaussian blur, which rounds the creases and fills the small gaps.
const R = Math.ceil(SIGMA * 3), kern = [];
for (let x = -R; x <= R; x++) kern.push(Math.exp(-(x * x) / (2 * SIGMA * SIGMA)));
const ks = kern.reduce((a, b) => a + b);
let a = field, b = new Float32Array(N ** 3);
for (const stride of [1, N, N * N]) {
  for (let idx = 0; idx < N ** 3; idx++) {
    const g = Math.floor(idx / stride) % N;
    let sum = 0;
    for (let x = -R; x <= R; x++) sum += a[idx + Math.min(N - 1, Math.max(0, g + x)) * stride - g * stride] * kern[x + R];
    b[idx] = sum / ks;
  }
  [a, b] = [b, a];
}

const bytes = new Uint8Array(N ** 3);
for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, a[i] / RANGE * 0.5 + 0.5)) * 255);
fs.writeFileSync(out, bytes);
console.log(`\nwrote ${out}, ${N}^3, inside ${bytes.filter((v) => v < 128).length} voxels`);
