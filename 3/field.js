import { TRAIL_ASPECT, CHAIN_P } from "./trails.js";
import { DataTexture, RGBAFormat, FloatType, NearestFilter, Vector3, Matrix3 } from "three";

const GRID = 8;
const CELLS = GRID * GRID * GRID;
const BLOB_P = 2.5;
const SAG_K = 0.3;
const FRONT = 1.1;
// A running blob narrows behind its centre by up to this share of its width, so it flows into its trail.
const TAPER = 0.5;
// Share of the concave radius a bulge may fill.
const CLEAR_K = 0.5;

function dataTexture(w, h) {
  const t = new DataTexture(new Float32Array(w * h * 4), w, h, RGBAFormat, FloatType);
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// World down in the object space of matrix m (rotation part, normalised), into out.
function downIn(m, out) {
  const e = m.elements;
  return out.set(-e[1] / Math.hypot(e[0], e[1], e[2]), -e[5] / Math.hypot(e[4], e[5], e[6]), -e[9] / Math.hypot(e[8], e[9], e[10]));
}

// Blob and trail kernels as textures plus an 8³ object-space grid of which kernels reach each cell; poses 0 (now),
// 1 (last frame) and 2 (motion-blur shutter). fieldAt / surfaceAt mirror the GLSL for pose 0.
export function createField({ lite = false, quality = "high" } = {}) {
  const MAXB = lite ? 48 : 96;
  const MAXT = lite ? 80 : 160;
  const P = lite ? 6 : 8;
  const G = 12;
  const SLOTS = 4 * G - 1;

  const blobTex = dataTexture(MAXB, 9);
  const trailTex = dataTexture(P + 2, MAXT);
  const gridTex = dataTexture(CELLS, G);
  const bd = blobTex.image.data;
  const gd = gridTex.image.data;
  const prev0 = new Float32Array(MAXB * 3 * 4);
  let primed = true;

  const uniforms = {
    blobTex: { value: blobTex },
    trailTex: { value: trailTex },
    gridTex: { value: gridTex },
    gridMin: { value: new Vector3() },
    gridSize: { value: 1 },
    blobCount: { value: 0 },
    trailCount: { value: 0 },
    blobP: { value: BLOB_P },
    trailAspect: { value: TRAIL_ASPECT },
    gravityObj: { value: [new Vector3(0, -1, 0), new Vector3(0, -1, 0), new Vector3(0, -1, 0)] },
    sagK: { value: SAG_K },
    bodyRotation: { value: new Matrix3() },
  };
  const defines = { MAX_BLOBS: MAXB, MAX_TRAILS: MAXT, TRAIL_POINTS: P, GRID, GRID_SLOTS: SLOTS, BLOB_FRONT: FRONT.toFixed(3), BLOB_TAPER: TAPER.toFixed(3), CLEAR_K: CLEAR_K.toFixed(3), CHAIN_P: CHAIN_P.toFixed(3) };
  if (quality === "low") defines.NO_PIXEL_FIELD = "";

  const stats = { peak: 0, overflow: 0, blobs: 0 };
  const gMin = [0, 0, 0];
  let gSize = 1;

  function setShape(shape) {
    for (let k = 0; k < 3; k++) gMin[k] = shape.sdf.min[k];
    gSize = shape.sdf.size;
    uniforms.gridMin.value.fromArray(gMin);
    uniforms.gridSize.value = gSize;
  }

  // body matrices -> gravityObj[3] and bodyRotation.
  function setPoses(body) {
    const g = uniforms.gravityObj.value;
    const m = body.matrixWorld;
    downIn(m, g[0]);
    downIn(body.userData.prevMatrixWorld ?? m, g[1]);
    downIn(body.userData.shutterMatrixWorld ?? m, g[2]);
    const r = uniforms.bodyRotation.value.setFromMatrix4(m).elements;
    for (let c = 0; c < 3; c++) {
      const l = 1 / Math.hypot(r[c * 3], r[c * 3 + 1], r[c * 3 + 2]);
      for (let k = 0; k < 3; k++) r[c * 3 + k] *= l;
    }
  }

  const texel = (i, row) => (row * MAXB + i) * 4;

  const cellOf = (v, k, s) => Math.max(0, Math.min(GRID - 1, Math.floor((v - gMin[k]) * s)));
  // Squared distance from c to cell b's slab along axis k.
  const gap = (c, b, k, cs) => {
    const bl = gMin[k] + b * cs, bh = bl + cs;
    const e = c < bl ? bl - c : c > bh ? c - bh : 0;
    return e * e;
  };

  function insert(id, cx, cy, cz, r) {
    const s = GRID / gSize;
    const x0 = cellOf(cx - r, 0, s), y0 = cellOf(cy - r, 1, s), z0 = cellOf(cz - r, 2, s);
    const x1 = cellOf(cx + r, 0, s), y1 = cellOf(cy + r, 1, s), z1 = cellOf(cz + r, 2, s);
    const cs = gSize / GRID, r2 = r * r;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          // Sphere-box overlap.
          if (gap(cx, x, 0, cs) + gap(cy, y, 1, cs) + gap(cz, z, 2, cs) > r2) continue;
          const cell = x + GRID * (y + GRID * z);
          const n = gd[cell * 4];
          if (n > SLOTS) continue;
          // A trail inserts once per segment; its ids arrive consecutively.
          if (n > 0 && gd[((n >> 2) * CELLS + cell) * 4 + (n & 3)] === id) continue;
          if (n === SLOTS) {
            gd[cell * 4] = SLOTS + 1;
            stats.overflow++;
            continue;
          }
          const k = n + 1;
          gd[((k >> 2) * CELLS + cell) * 4 + (k & 3)] = id;
          gd[cell * 4] = k;
          if (k > stats.peak) stats.peak = k;
        }
  }

  // Packs the blob bands and rebuilds the grid. running is false while paused; shutter in seconds; view, when given,
  // holds the interpolated c, n, dir, a, A and tail.
  function pack(blobs, trails, running, shutter, view = blobs) {
    const { MAXB: nb, state, speed, resetPrev } = blobs;
    const { c, n, dir, a, A, tail } = view;
    let count = 0;
    for (let i = 0; i < MAXB; i++) {
      const live = i < nb && state[i] !== 0;
      const o0 = texel(i, 0), o1 = texel(i, 1), o2 = texel(i, 2);
      if (!live) {
        bd.fill(0, o0, o0 + 4);
        bd.fill(0, o1, o1 + 4);
        bd.fill(0, o2, o2 + 4);
        continue;
      }
      count = i + 1;
      // Orthonormal (dir, n), so the kernel ellipsoid stays inside its bound sphere and the cut there never steps.
      let mx = n[i * 3], my = n[i * 3 + 1], mz = n[i * 3 + 2];
      const ml = 1 / Math.max(Math.hypot(mx, my, mz), 1e-9);
      (mx *= ml), (my *= ml), (mz *= ml);
      let dx = dir[i * 3], dy = dir[i * 3 + 1], dz = dir[i * 3 + 2];
      const dm = dx * mx + dy * my + dz * mz;
      (dx -= dm * mx), (dy -= dm * my), (dz -= dm * mz);
      let dl = Math.hypot(dx, dy, dz);
      if (dl < 1e-6) (dx = my), (dy = -mx), (dz = 0), (dl = Math.hypot(dx, dy) || ((dx = 1), 1));
      const tl = tail[i] / dl;
      bd[o0] = c[i * 3];
      bd[o0 + 1] = c[i * 3 + 1];
      bd[o0 + 2] = c[i * 3 + 2];
      bd[o0 + 3] = a[i];
      bd[o1] = dx * tl;
      bd[o1 + 1] = dy * tl;
      bd[o1 + 2] = dz * tl;
      bd[o1 + 3] = A[i];
      bd[o2] = mx;
      bd[o2 + 1] = my;
      bd[o2 + 2] = mz;
      bd[o2 + 3] = a[i] * Math.max(tail[i], FRONT);
    }
    // Pose 1: last pack's pose 0, or now for new slots, paused frames and primes.
    for (let i = 0; i < MAXB; i++) {
      const fresh = primed || !running || (i < nb && resetPrev[i]);
      for (let k = 0; k < 3; k++) {
        const src = texel(i, k), dst = texel(i, 3 + k), p = (k * MAXB + i) * 4;
        for (let q = 0; q < 4; q++) bd[dst + q] = fresh ? bd[src + q] : prev0[p + q];
      }
      if (i < nb) resetPrev[i] = 0;
    }
    prev0.set(bd.subarray(0, MAXB * 3 * 4));
    // Pose 2: the shutter, c - vel·shutter/2 with the same kernel.
    const hs = primed ? 0 : 0.5 * shutter;
    for (let i = 0; i < MAXB; i++) {
      for (let k = 0; k < 3; k++) {
        const src = texel(i, k), dst = texel(i, 6 + k);
        for (let q = 0; q < 4; q++) bd[dst + q] = bd[src + q];
      }
      if (i < nb && state[i] !== 0) {
        const o = texel(i, 6);
        for (let k = 0; k < 3; k++) bd[o + k] -= dir[i * 3 + k] * speed[i] * hs;
      }
    }
    primed = false;
    uniforms.blobCount.value = count;
    blobTex.needsUpdate = true;

    // Grid: each kernel goes into every cell its bound covers over all three poses.
    for (let cell = 0; cell < CELLS; cell++) gd[cell * 4] = 0;
    stats.peak = 0;
    stats.overflow = 0;
    stats.blobs = 0;
    for (let i = 0; i < count; i++) {
      const o0 = texel(i, 0), o1 = texel(i, 3), o2 = texel(i, 6);
      if (bd[texel(i, 1) + 3] <= 0 && bd[texel(i, 4) + 3] <= 0) continue;
      stats.blobs++;
      const bound = Math.max(bd[texel(i, 2) + 3], bd[texel(i, 5) + 3]);
      const moved = Math.hypot(bd[o0] - bd[o1], bd[o0 + 1] - bd[o1 + 1], bd[o0 + 2] - bd[o1 + 2]);
      const smear = Math.hypot(bd[o0] - bd[o2], bd[o0 + 1] - bd[o2 + 1], bd[o0 + 2] - bd[o2 + 2]);
      insert(i, bd[o0], bd[o0 + 1], bd[o0 + 2], bound + moved + smear);
    }
    let tcount = 0;
    trailSrc = trails;
    if (trails) {
      tcount = trails.pack(trailTex.image.data, P);
      const td = trailTex.image.data;
      for (let j = 0; j < tcount; j++) {
        const o = j * (P + 2) * 4;
        if (td[o + 3] <= 0) continue;
        for (let k = 2; k <= P; k++) {
          const a = o + (k - 1) * 4, b = o + k * 4;
          if (td[b + 3] <= 0) break;
          const w = TRAIL_ASPECT * Math.sqrt(Math.max(td[a + 3], td[b + 3]));
          const len = Math.hypot(td[b] - td[a], td[b + 1] - td[a + 1], td[b + 2] - td[a + 2]);
          insert(MAXB + j, 0.5 * (td[a] + td[b]), 0.5 * (td[a + 1] + td[b + 1]), 0.5 * (td[a + 2] + td[b + 2]), 0.5 * len + w);
        }
      }
      trailTex.needsUpdate = true;
    }
    uniforms.trailCount.value = tcount;
    gridTex.needsUpdate = true;
  }

  // Next pack writes all three bands equal to now.
  function prime() {
    primed = true;
  }

  let trailSrc = null;
  const _tg = [0, 0, 0];
  // CPU mirror of blobField() for pose 0: returns H, gradient into grad.
  function fieldAt(p, nrm, grad) {
    const T = trailSrc ? trailSrc.heightAt(p, _tg, -1, nrm) : 0;
    let sum = T > 0 ? Math.pow(T, BLOB_P) : 0;
    const tk = T > 0 ? Math.pow(T, BLOB_P - 1) : 0;
    let gx = _tg[0] * tk, gy = _tg[1] * tk, gz = _tg[2] * tk;
    const count = uniforms.blobCount.value;
    for (let i = 0; i < count; i++) {
      const o0 = texel(i, 0), o1 = texel(i, 1), o2 = texel(i, 2);
      const dx = p[0] - bd[o0], dy = p[1] - bd[o0 + 1], dz = p[2] - bd[o0 + 2];
      if (dx * dx + dy * dy + dz * dz >= bd[o2 + 3] * bd[o2 + 3]) continue;
      const fd = nrm[0] * bd[o2] + nrm[1] * bd[o2 + 1] + nrm[2] * bd[o2 + 2];
      const facing = smoothstep(0.0, 0.45, fd);
      if (facing <= 0 || bd[o1 + 3] <= 0) continue;
      const tl = Math.hypot(bd[o1], bd[o1 + 1], bd[o1 + 2]);
      const nx = bd[o1] / tl, ny = bd[o1 + 1] / tl, nz = bd[o1 + 2] / tl;
      const mx = bd[o2], my = bd[o2 + 1], mz = bd[o2 + 2];
      const sx = my * nz - mz * ny, sy = mz * nx - mx * nz, sz = mx * ny - my * nx;
      const u = dx * nx + dy * ny + dz * nz, v = dx * sx + dy * sy + dz * sz;
      const w = dx * mx + dy * my + dz * mz;
      const ca = bd[o0 + 3];
      const ax = ca * (u < 0 ? tl : FRONT);
      const tp = u < 0 ? TAPER * 0.5 * (tl - 1) : 0;
      const tt = Math.min(1, Math.max(0, -u / ax));
      const av = ca * (1 - tp * tt);
      const dav = u < 0 && tt < 1 ? (ca * tp) / ax : 0;
      const iu = 1 / (ax * ax), iv = 1 / (av * av), iw = 1 / (bd[o2 + 3] * bd[o2 + 3]);
      const s2 = u * u * iu + v * v * iv + w * w * iw;
      if (s2 >= 1) continue;
      const q = 1 - s2, k = bd[o1 + 3] * facing, h = k * q * q;
      const hp = Math.pow(h, BLOB_P - 1);
      sum += hp * h;
      const du = u * iu - ((v * v * iv) / av) * dav;
      const f = hp * -4 * k * q;
      gx += f * (du * nx + v * iv * sx + w * iw * mx);
      gy += f * (du * ny + v * iv * sy + w * iw * my);
      gz += f * (du * nz + v * iv * sz + w * iw * mz);
    }
    if (sum <= 1e-30) {
      if (grad) grad[0] = grad[1] = grad[2] = 0;
      return 0;
    }
    const H = Math.pow(sum, 1 / BLOB_P);
    if (grad) {
      const k = Math.pow(H, 1 - BLOB_P);
      (grad[0] = gx * k), (grad[1] = gy * k), (grad[2] = gz * k);
    }
    return H;
  }

  const _g = [0, 0, 0];
  // CPU mirror of bodySurface() for pose 0 (fade and room are the body's attributes): displaced point into outP,
  // displaced normal into outN.
  function surfaceAt(p, nrm, outP, outN, fade = 1, room = Infinity) {
    let h = fade * fieldAt(p, nrm, _g);
    // Soft limit at the clearance, so concave creases never fold.
    if (room < 1e3) {
      const cl = CLEAR_K * room, e = Math.exp(-h / cl);
      h = cl * (1 - e);
      fade *= e;
    }
    const gv = uniforms.gravityObj.value[0];
    const gd0 = nrm[0] * gv.x + nrm[1] * gv.y + nrm[2] * gv.z;
    const m = [nrm[0] + SAG_K * (gv.x - nrm[0] * gd0), nrm[1] + SAG_K * (gv.y - nrm[1] * gd0), nrm[2] + SAG_K * (gv.z - nrm[2] * gd0)];
    const up = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = normalize(cross(nrm, up));
    const e2 = cross(nrm, e1);
    const g1 = fade * dot(_g, e1), g2 = fade * dot(_g, e2);
    const t1 = [e1[0] + g1 * m[0], e1[1] + g1 * m[1], e1[2] + g1 * m[2]];
    const t2 = [e2[0] + g2 * m[0], e2[1] + g2 * m[1], e2[2] + g2 * m[2]];
    const nn = normalize(cross(t1, t2));
    for (let c = 0; c < 3; c++) {
      outP[c] = p[c] + h * m[c];
      if (outN) outN[c] = nn[c];
    }
    return h;
  }

  return { uniforms, defines, stats, MAXB, MAXT, P, setShape, setPoses, pack, prime, fieldAt, surfaceAt };
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a) {
  const l = 1 / Math.max(Math.hypot(a[0], a[1], a[2]), 1e-20);
  return [a[0] * l, a[1] * l, a[2] * l];
}
