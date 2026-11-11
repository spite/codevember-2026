// Blanks defined by a distance field: a superellipsoid pillow, a twisted triangular ring and a cluster of soft blobs,
// plus a trefoil knot tube (exact, from the closest point on its curve). Each has field(x, y, z, g) → value (with
// |∇| ≤ 1, so |value| never exceeds the distance) and its gradient in g, and projects by Newton steps on it.
// Import-free, for the build worker.

const G = new Float64Array(3);

// Lands on the surface along the gradient, then slides along it until the offset to (x, y, z) is normal to it.
// (sx, sy, sz): where to start, if not at the point itself; maxSlide caps each slide.
function fieldProject(shape, x, y, z, sx = x, sy = y, sz = z, maxSlide = Infinity) {
  const g = G;
  let px = sx, py = sy, pz = sz;
  let nx = 0, ny = 1, nz = 0;
  let prev = Infinity;
  for (let it = 0; it < 8; it++) {
    for (let k = 0; k < 24; k++) {
      const f = shape.field(px, py, pz, g);
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (!(gg > 1e-14)) {
        px += 1e-3, py += 7e-4, pz += 5e-4;
        continue;
      }
      if (Math.abs(f) < 1e-8) break;
      let s = f / gg;
      const len = Math.abs(s) * Math.sqrt(gg);
      if (len > 0.15) s *= 0.15 / len;
      px -= s * g[0], py -= s * g[1], pz -= s * g[2];
    }
    const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
    nx = g[0] / gl, ny = g[1] / gl, nz = g[2] / gl;
    const rx = x - px, ry = y - py, rz = z - pz;
    const k = rx * nx + ry * ny + rz * nz;
    let tx = rx - nx * k, ty = ry - ny * k, tz = rz - nz * k;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-7 || it === 7) break;
    // Diverging (deep inside a tight curve): halve the slide.
    const damp = (tl > prev ? 0.5 : 1) * Math.min(1, maxSlide / tl);
    prev = tl;
    px += tx * damp, py += ty * damp, pz += tz * damp;
  }
  return [px, py, pz, nx, ny, nz];
}

const H = (a, b, c) => {
  const l = Math.hypot(a, b, c);
  (a /= l), (b /= l), (c /= l);
  return [1 - 2 * a * a, -2 * a * b, -2 * a * c, -2 * b * a, 1 - 2 * b * b, -2 * b * c, -2 * c * a, -2 * c * b, 1 - 2 * c * c];
};
const RY = (t) => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];

// A superellipsoid cushion: (|x|^6 + |z|^6)^(1/2) + |y|^3 = 1 on scaled axes, a squared-off plan with a soft rim.
export const pillow = {
  a: 0.86,
  b: 0.52,
  bounds: [0.86, 0.52, 0.86],
  // Measured on the mesh.
  area: 9.43,
  symmetries: {
    none: [],
    mirror: [H(1, 0, 0)],
    "2 planes": [H(1, 0, 0), H(0, 0, 1)],
    "3 planes": [H(1, 0, 0), H(0, 1, 0), H(0, 0, 1)],
    "4-fold": [H(1, 0, 0), H(1, 0, 1)],
    "8-fold": [H(1, 0, 0), H(1, 0, 1), H(0, 1, 0)],
  },
  // (G − 1)·min(a, b): G is a gauge whose unit ball holds the ball of radius min(a, b), so this is 1-Lipschitz.
  field(x, y, z, g) {
    const { a, b } = this;
    const m = Math.min(a, b);
    const X = Math.abs(x) / a, Y = Math.abs(y) / b, Z = Math.abs(z) / a;
    const X2 = X * X, Z2 = Z * Z;
    const X5 = X2 * X2 * X, Z5 = Z2 * Z2 * Z;
    const u = X5 * X + Z5 * Z;
    const us = Math.sqrt(u);
    const w = us + Y * Y * Y;
    if (!(w > 1e-300)) {
      g[0] = g[1] = g[2] = 0;
      return -m;
    }
    const Gv = Math.cbrt(w);
    const c = (Gv / w) * m;
    const cu = us > 1e-150 ? c / us : 0;
    g[0] = (cu * X5 * Math.sign(x)) / a;
    g[1] = (c * Y * Y * Math.sign(y)) / b;
    g[2] = (cu * Z5 * Math.sign(z)) / a;
    return (Gv - 1) * m;
  },
  sdf(x, y, z) {
    return this.field(x, y, z, G);
  },
  project(x, y, z) {
    return fieldProject(this, x, y, z);
  },
};

// A ring whose section, a rounded triangle, turns a third of a turn on the way round: one edge, three times round.
export const twist = {
  R: 0.66,
  t: 0.3,
  rr: 0.06,
  bounds: [1.08, 0.42, 1.08],
  area: 9.07,
  symmetries: { none: [], "2-fold": [[1, 0, 0, 0, -1, 0, 0, 0, -1]] },
  // The section's distance, mirror symmetric about the a axis (iq's equilateral triangle, half side t).
  sec(a, b) {
    const k = Math.sqrt(3), t = this.t;
    let px = Math.abs(b) - t;
    let py = a + t / k;
    if (px + k * py > 0) {
      const qx = (px - k * py) / 2;
      py = (-k * px - py) / 2;
      px = qx;
    }
    px -= Math.max(-2 * t, Math.min(0, px));
    return -Math.sqrt(px * px + py * py) * Math.sign(py) - this.rr;
  },
  field(x, y, z, g) {
    const rho = Math.sqrt(x * x + z * z) || 1e-9;
    const th = Math.atan2(z, x) / 3;
    const c = Math.cos(th), sn = Math.sin(th);
    const s = rho - this.R;
    const a = s * c + y * sn, b = -s * sn + y * c;
    const e = 1e-5;
    const f = this.sec(a, b);
    const ga = (this.sec(a + e, b) - this.sec(a - e, b)) / (2 * e);
    const gb = (this.sec(a, b + e) - this.sec(a, b - e)) / (2 * e);
    const gs = ga * c - gb * sn, gy = ga * sn + gb * c;
    const gt = (ga * b - gb * a) / 3 / (rho * rho);
    g[0] = (gs * x) / rho - gt * z;
    g[1] = gy;
    g[2] = (gs * z) / rho + gt * x;
    return f;
  },
  // The twist stretches the field away from the axis: divide by its local slope, with a margin.
  sdf(x, y, z) {
    const f = this.field(x, y, z, G);
    return f / (1.1 * Math.max(1, Math.sqrt(G[0] * G[0] + G[1] * G[1] + G[2] * G[2])));
  },
  project(x, y, z) {
    return fieldProject(this, x, y, z);
  },
};

// Spheres blended by a soft minimum, after Arp's and Moore's pebbles.
export const blob = {
  // Grids are laid by rays from here (radialPoint): every lobe is in plain view of it.
  radial: [0, 0.02, 0],
  balls: [
    [0.0, -0.18, 0.0, 0.55],
    [0.36, 0.36, 0.06, 0.37],
    [-0.5, 0.06, 0.16, 0.31],
    [0.06, -0.22, -0.52, 0.34],
    [-0.2, 0.56, -0.2, 0.24],
  ].map((b) => b.map((v) => v * 1.12)),
  k: 0.13,
  bounds: [0.95, 0.94, 1.0],
  area: 8.06,
  symmetries: { none: [] },
  field(x, y, z, g) {
    const k = this.k, B = this.flat ??= this.balls.flat(), n = this.balls.length;
    const ds = this._d ??= new Float64Array(n * 4);
    let sum = 0, gx = 0, gy = 0, gz = 0, dmin = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = x - B[i * 4], dy = y - B[i * 4 + 1], dz = z - B[i * 4 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      const d = l - B[i * 4 + 3];
      ds[i * 4] = d;
      ds[i * 4 + 1] = dx / l, ds[i * 4 + 2] = dy / l, ds[i * 4 + 3] = dz / l;
      if (d < dmin) dmin = d;
    }
    for (let i = 0; i < n; i++) {
      const e = (dmin - ds[i * 4]) / k;
      // A ball this much farther than the nearest adds nothing.
      if (e < -18) continue;
      const w = Math.exp(e);
      sum += w;
      gx += w * ds[i * 4 + 1], gy += w * ds[i * 4 + 2], gz += w * ds[i * 4 + 3];
    }
    g[0] = gx / sum, g[1] = gy / sum, g[2] = gz / sum;
    return dmin - k * Math.log(sum);
  },
  sdf(x, y, z) {
    return this.field(x, y, z, G);
  },
  project(x, y, z) {
    return fieldProject(this, x, y, z);
  },
};

// Torus knot tubes: the curve is e^{i(q−p)t} − M·e^{−ipt} in the xz plane (as z + ix) with y = −hz·sin(qt), the
// trefoil at (p, q) = (2, 3). The closest point on the curve comes from the nearest sample (in a grid of buckets),
// refined by Newton steps on the curve parameter, so the projection is exact.
function torusKnot({ p, q, M = 2, hz, tube, scale, samples, period, ring, ringMin, symmetries }) {
  const A = q - p, B = p;
  const k = {
    hz,
    tube,
    scale,
    samples,
    // The tube grid's length count is a multiple of this, so the rotations map it onto itself.
    period,
    // Its count round the tube is a multiple of ring, at least ringMin.
    ring,
    ringMin,
    _c: [0, 0, 0],
    _d1: [0, 0, 0],
    _d2: [0, 0, 0],
    symmetries,
    get r() {
      return this.tube * this.scale;
    },
    get bounds() {
      return [(1 + M + this.tube) * this.scale, (this.hz + this.tube) * this.scale, (1 + M + this.tube) * this.scale];
    },
    area: 0,
    // Point, first and second derivative at t.
    curve(t, o, d1, d2) {
      const S = this.scale, hz = this.hz;
      const ca = Math.cos(A * t), sa = Math.sin(A * t), cb = Math.cos(B * t), sb = Math.sin(B * t), cq = Math.cos(q * t), sq = Math.sin(q * t);
      o[0] = (sa + M * sb) * S, o[1] = -hz * sq * S, o[2] = (ca - M * cb) * S;
      if (d1) (d1[0] = (A * ca + M * B * cb) * S), (d1[1] = -q * hz * cq * S), (d1[2] = (-A * sa + M * B * sb) * S);
      if (d2) (d2[0] = (-A * A * sa - M * B * B * sb) * S), (d2[1] = q * q * hz * sq * S), (d2[2] = (-A * A * ca + M * B * B * cb) * S);
      return o;
    },
    init() {
      if (this.pts) return;
      const N = this.samples;
      this.pts = new Float64Array(N * 3);
      const o = [0, 0, 0];
      for (let i = 0; i < N; i++) this.pts.set(this.curve((i / N) * 2 * Math.PI, o), i * 3);
      let len = 0;
      for (let i = 0; i < N; i++) {
        const j = ((i + 1) % N) * 3;
        len += Math.hypot(this.pts[j] - this.pts[i * 3], this.pts[j + 1] - this.pts[i * 3 + 1], this.pts[j + 2] - this.pts[i * 3 + 2]);
      }
      this.length = len;
      this.gap = (0.55 * len) / N;
    },
    // Cells near the tube list the samples that can be nearest to any point in them (within the centre's nearest
    // distance plus a cell diagonal); the others keep a distance bound.
    buildGrid() {
      const N = this.samples, P = this.pts;
      const c = (this.cell = 0.04);
      const hd = c * 0.87;
      this.gmin = this.bounds.map((b) => -b - 0.08);
      const d = (this.gdim = this.bounds.map((b) => Math.ceil((2 * b + 0.16) / c)));
      const cells = d[0] * d[1] * d[2];
      const start = new Uint32Array(cells + 1);
      const bound = (this.bound = new Float32Array(cells));
      const lists = [];
      const dd = new Float64Array(N);
      for (let k = 0, ci = 0; k < d[2]; k++)
        for (let j = 0; j < d[1]; j++)
          for (let i = 0; i < d[0]; i++, ci++) {
            const x = this.gmin[0] + (i + 0.5) * c, y = this.gmin[1] + (j + 0.5) * c, z = this.gmin[2] + (k + 0.5) * c;
            let m = Infinity;
            for (let s = 0; s < N; s++) {
              const ex = P[s * 3] - x, ey = P[s * 3 + 1] - y, ez = P[s * 3 + 2] - z;
              dd[s] = ex * ex + ey * ey + ez * ez;
              if (dd[s] < m) m = dd[s];
            }
            m = Math.sqrt(m);
            bound[ci] = m - hd - this.gap;
            if (m - hd > this.r + 0.06) continue;
            const lim = (m + 2 * hd) ** 2;
            const l = [];
            for (let s = 0; s < N; s++) if (dd[s] <= lim) l.push(s);
            lists[ci] = l;
            start[ci + 1] = l.length;
          }
      for (let ci = 0; ci < cells; ci++) start[ci + 1] += start[ci];
      this.list = new Uint16Array(start[cells]);
      lists.forEach((l, ci) => l && this.list.set(l, start[ci]));
      this.grid = start;
    },
    // Nearest sample (−1 outside the cells near the tube, with a bound on the curve's distance in this.d2 instead);
    // its squared distance in this.d2.
    nearest(x, y, z) {
      if (!this.grid) this.buildGrid();
      const c = this.cell, m = this.gmin, d = this.gdim;
      const i = Math.floor((x - m[0]) / c), j = Math.floor((y - m[1]) / c), k = Math.floor((z - m[2]) / c);
      this.d2 = 0;
      if (i < 0 || j < 0 || k < 0 || i >= d[0] || j >= d[1] || k >= d[2]) return -1;
      const ci = i + d[0] * (j + d[1] * k);
      const S = this.grid, L = this.list, P = this.pts;
      if (S[ci] === S[ci + 1]) return (this.d2 = Math.max(0, this.bound[ci]) ** 2), -1;
      let best = -1, bd = Infinity;
      for (let e = S[ci]; e < S[ci + 1]; e++) {
        const s = L[e];
        const dx = P[s * 3] - x, dy = P[s * 3 + 1] - y, dz = P[s * 3 + 2] - z;
        const q = dx * dx + dy * dy + dz * dz;
        if (q < bd) (bd = q), (best = s);
      }
      this.d2 = bd;
      return best;
    },
    sdf(x, y, z) {
      const i = this.nearest(x, y, z);
      if (i < 0) {
        // Off the grid: a bound from every sixth sample.
        if (this.d2 === 0) return Math.sqrt(this.bruteNearest(x, y, z, 6)) - 6 * this.gap - this.r;
        return Math.sqrt(this.d2) - this.r;
      }
      const d = Math.sqrt(this.d2);
      // The curve is between d less half the sample spacing and d.
      return d < this.r ? d - this.r : Math.max(0, d - this.gap - this.r);
    },
    // Nearest sample by brute force: its squared distance, and the index in this.far.
    bruteNearest(x, y, z, every = 1) {
      const P = this.pts;
      let bd = Infinity;
      for (let s = 0; s < this.samples; s += every) {
        const dd = (P[s * 3] - x) ** 2 + (P[s * 3 + 1] - y) ** 2 + (P[s * 3 + 2] - z) ** 2;
        if (dd < bd) (bd = dd), (this.far = s);
      }
      return bd;
    },
    closest(x, y, z) {
      let i = this.nearest(x, y, z);
      let dt = (2 * Math.PI) / this.samples;
      let its = 5;
      // Far from the tube: a coarser start, and more steps.
      if (i < 0) this.bruteNearest(x, y, z, 4), (i = this.far), (dt *= 4), (its = 12);
      let t = (i / this.samples) * 2 * Math.PI;
      const c = this._c, d1 = this._d1, d2 = this._d2;
      for (let it = 0; it < its; it++) {
        this.curve(t, c, d1, d2);
        const ex = c[0] - x, ey = c[1] - y, ez = c[2] - z;
        const f = d1[0] * ex + d1[1] * ey + d1[2] * ez;
        const fp = d2[0] * ex + d2[1] * ey + d2[2] * ez + d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
        const st = Math.max(-dt, Math.min(dt, f / (fp > 1e-9 ? fp : 1e-9)));
        t -= st;
        if (Math.abs(st) < 1e-9) break;
      }
      return this.curve(t, c);
    },
    // Closest point on the tube: c + r · (p − c) / |p − c|.
    project(x, y, z) {
      const c = this.closest(x, y, z);
      let dx = x - c[0], dy = y - c[1], dz = z - c[2];
      let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) (dx = 0), (dy = 1), (dz = 0), (l = 1);
      const nx = dx / l, ny = dy / l, nz = dz / l, r = this.r;
      return [c[0] + nx * r, c[1] + ny * r, c[2] + nz * r, nx, ny, nz];
    },
  };
  k.init();
  k.area = 2 * Math.PI * k.r * k.length;
  return k;
}

const Z2 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
export const knot = torusKnot({ p: 2, q: 3, hz: 1.5, tube: 0.58, scale: 1 / 3.55, samples: 360, period: 6, ring: 2, ringMin: 6, symmetries: { none: [], "2-fold": [Z2], "3-fold": [RY((2 * Math.PI) / 3)], "6-fold": [RY((2 * Math.PI) / 3), Z2] } });
export const knot25 = torusKnot({ p: 2, q: 5, M: 2.5, hz: 1.5, tube: 0.5, scale: 1 / 4, samples: 600, period: 10, ring: 10, ringMin: 10, symmetries: { none: [], "2-fold": [Z2], "5-fold": [RY((2 * Math.PI) / 5)], "10-fold": [RY((2 * Math.PI) / 5), Z2] } });

// ── Suzanne ──
// Blender's Suzanne from day 7's baked distance field (tools/suzanne-sdf.mjs: N³ half floats at cell centres over
// [-EXTENT, EXTENT]³, x fastest), with her thin parts (ears, brow) thickened as there, sampled by a cubic B-spline
// (C², so the surface is fair) with its analytic gradient. The grid is built on first use (the worker), and handed to
// the main thread with the mesh (adopt), which never loads it itself.
const SUZ_N = 96;
const SUZ_EXTENT = 1.12;

function halfToFloat(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 31, m = u & 1023;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return s * 1e3;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function loadSuzanneBin() {
  const url = new URL("../assets/suzanne-sdf-96.bin", import.meta.url);
  let buffer;
  if (typeof XMLHttpRequest !== "undefined") {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url.href, false);
    xhr.responseType = "arraybuffer";
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) throw new Error(`suzanne-sdf-96.bin: ${xhr.status}`);
    buffer = xhr.response;
  } else {
    const b = globalThis.process.getBuiltinModule("node:fs").readFileSync(url);
    buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  return Float32Array.from(new Uint16Array(buffer), halfToFloat);
}

// Running max over a window of 2r + 1 along one axis.
function maxFilter(A, N, stride, r) {
  const out = new Float32Array(A.length);
  for (let idx = 0; idx < A.length; idx++) {
    const g = Math.floor(idx / stride) % N;
    let m = -Infinity;
    for (let d = Math.max(-r, -g); d <= Math.min(r, N - 1 - g); d++) m = Math.max(m, A[idx + d * stride]);
    out[idx] = m;
  }
  return out;
}

function blur3(A, N, sigma) {
  const R = Math.ceil(sigma * 3), kern = [];
  for (let x = -R; x <= R; x++) kern.push(Math.exp(-(x * x) / (2 * sigma * sigma)));
  let a = Float32Array.from(A), b = new Float32Array(A.length);
  for (const stride of [1, N, N * N]) {
    for (let idx = 0; idx < a.length; idx++) {
      const g = Math.floor(idx / stride) % N;
      let sum = 0, ws = 0;
      for (let x = Math.max(-R, -g); x <= Math.min(R, N - 1 - g); x++) {
        sum += a[idx + x * stride] * kern[x + R];
        ws += kern[x + R];
      }
      b[idx] = sum / ws;
    }
    [a, b] = [b, a];
  }
  return a;
}

function bspline(t, w, dw) {
  const t2 = t * t, t3 = t2 * t, u = 1 - t;
  w[0] = (u * u * u) / 6;
  w[1] = (3 * t3 - 6 * t2 + 4) / 6;
  w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  w[3] = t3 / 6;
  dw[0] = -0.5 * u * u;
  dw[1] = 1.5 * t2 - 2 * t;
  dw[2] = -1.5 * t2 + t + 0.5;
  dw[3] = 0.5 * t2;
}
const _wx = [0, 0, 0, 0], _wy = [0, 0, 0, 0], _wz = [0, 0, 0, 0], _dx = [0, 0, 0, 0], _dy = [0, 0, 0, 0], _dz = [0, 0, 0, 0];

export const suzanne = {
  minHalf: 0.062,
  puff: 0.006,
  // Measured on the grid.
  bounds: [1.0, 0.72, 0.62],
  area: 5.41,
  symmetries: { none: [], mirror: [H(1, 0, 0)] },
  // Interlace grids are cast out along rays from here, so they don't bunch into her hollows.
  radial: [0, 0, 0],
  // Interlace and panels still stretch over her ears and snout: randomize leaves these out.
  // She keeps her face to the viewer, swaying rather than turning.
  faced: true,
  avoid: ["knotwork", "arabesque", "girih", "guilloche"],
  grid: null,
  scale: 1,
  build() {
    if (this.grid) return;
    const F = loadSuzanneBin(), N = SUZ_N, vox = (2 * SUZ_EXTENT) / N;
    const D = F.map((v) => Math.max(-v, 0));
    const r = Math.round(0.1 / vox);
    const M = maxFilter(maxFilter(maxFilter(D, N, 1, r), N, N, r), N, N * N, r);
    const O = blur3(M.map((m) => Math.max(0, this.minHalf - m)), N, 1.5);
    this.adopt(F.map((v, i) => v - O[i] - this.puff));
  },
  // The grid, and its steepest difference, which bounds the spline's slope: dividing by it keeps the field ≤ the distance.
  adopt(grid) {
    const N = SUZ_N, vox = (2 * SUZ_EXTENT) / N;
    let L = 0;
    for (let k = 0; k < N - 1; k++)
      for (let j = 0; j < N - 1; j++)
        for (let i = 0, o = N * (j + N * k); i < N - 1; i++, o++) {
          const g0 = grid[o];
          L = Math.max(L, Math.hypot(grid[o + 1] - g0, grid[o + N] - g0, grid[o + N * N] - g0));
        }
    this.grid = grid;
    this.scale = vox / L;
  },
  field(x, y, z, g) {
    if (!this.grid) this.build();
    const N = SUZ_N, E = SUZ_EXTENT, inv = N / (2 * E), Gd = this.grid;
    const lim = E * (1 - 1.5 / N);
    const cx = Math.max(-lim, Math.min(lim, x)), cy = Math.max(-lim, Math.min(lim, y)), cz = Math.max(-lim, Math.min(lim, z));
    const ox = x - cx, oy = y - cy, oz = z - cz;
    const out = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const gx = (cx + E) * inv - 0.5, gy = (cy + E) * inv - 0.5, gz = (cz + E) * inv - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    bspline(gx - ix, _wx, _dx);
    bspline(gy - iy, _wy, _dy);
    bspline(gz - iz, _wz, _dz);
    let v = 0, vx = 0, vy = 0, vz = 0;
    for (let c = 0; c < 4; c++) {
      const k = Math.min(N - 1, Math.max(0, iz - 1 + c));
      for (let b = 0; b < 4; b++) {
        const j = Math.min(N - 1, Math.max(0, iy - 1 + b)), o = N * (j + N * k);
        for (let a = 0; a < 4; a++) {
          const f = Gd[o + Math.min(N - 1, Math.max(0, ix - 1 + a))];
          v += _wx[a] * _wy[b] * _wz[c] * f;
          vx += _dx[a] * _wy[b] * _wz[c] * f;
          vy += _wx[a] * _dy[b] * _wz[c] * f;
          vz += _wx[a] * _wy[b] * _dz[c] * f;
        }
      }
    }
    const s = this.scale;
    if (out > 0) {
      g[0] = ox / out, g[1] = oy / out, g[2] = oz / out;
      return v * s + out;
    }
    g[0] = vx * inv * s, g[1] = vy * inv * s, g[2] = vz * inv * s;
    return v * s;
  },
  sdf(x, y, z) {
    return this.field(x, y, z, G);
  },
  project(x, y, z) {
    return fieldProject(this, x, y, z);
  },
};

// ── Gyroid ──
// A sheet of constant thickness around Schoen's gyroid sin x cos y + sin y cos z + sin z cos x = 0, clipped to a ball
// with rounded corners where the clip cuts. The ball is centred in a channel, on a 3-fold axis turned to y, with three
// 2-fold axes across it (x one of them). The sheet's half thickness comes from G / |∇G|, a distance near the surface.
const GY_E = [
  [0, 1 / Math.SQRT2, -1 / Math.SQRT2],
  [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
  [2 / Math.sqrt(6), -1 / Math.sqrt(6), -1 / Math.sqrt(6)],
];
export const gyroid = {
  k: 3.9,
  t: 0.09,
  ball: 0.92,
  round: 0.05,
  bounds: [0.92, 0.92, 0.92],
  // Measured on the mesh.
  area: 13.14,
  // Mostly air: random surface points are drawn from this near it, culled by the sdf before projecting.
  sparse: 0.1,
  symmetries: { none: [], "2-fold": [[1, 0, 0, 0, -1, 0, 0, 0, -1]], "3-fold": [RY((2 * Math.PI) / 3)], "6-fold": [RY((2 * Math.PI) / 3), [1, 0, 0, 0, -1, 0, 0, 0, -1]] },
  // The sheet's signed offset from the mid surface, G / |∇G|, and its gradient in g.
  mid(x, y, z, g) {
    const k = this.k, E = GY_E, c = Math.PI / 4;
    const X = c + k * (E[0][0] * x + E[1][0] * y + E[2][0] * z);
    const Y = c + k * (E[0][1] * x + E[1][1] * y + E[2][1] * z);
    const Z = c + k * (E[0][2] * x + E[1][2] * y + E[2][2] * z);
    const sx = Math.sin(X), cx = Math.cos(X), sy = Math.sin(Y), cy = Math.cos(Y), sz = Math.sin(Z), cz = Math.cos(Z);
    const G0 = sx * cy + sy * cz + sz * cx;
    const dx = cx * cy - sx * sz, dy = cy * cz - sx * sy, dz = cz * cx - sy * sz;
    const L2 = dx * dx + dy * dy + dz * dz + 1e-12, L = Math.sqrt(L2);
    const hx = (-sx * cy - cx * sz) * dx - cx * sy * dy - sx * cz * dz;
    const hy = -cx * sy * dx + (-sx * cy - sy * cz) * dy - cy * sz * dz;
    const hz = -sx * cz * dx - cy * sz * dy + (-sy * cz - sz * cx) * dz;
    const a = G0 / (L * L2);
    const ux = dx / L - a * hx, uy = dy / L - a * hy, uz = dz / L - a * hz;
    g[0] = E[0][0] * ux + E[0][1] * uy + E[0][2] * uz;
    g[1] = E[1][0] * ux + E[1][1] * uy + E[1][2] * uz;
    g[2] = E[2][0] * ux + E[2][1] * uy + E[2][2] * uz;
    return G0 / (k * L);
  },
  // Sheet ∩ ball, the corners rounded (hg_sdf's fOpIntersectionRound); t: the half thickness.
  sheet(x, y, z, g, t) {
    const f = this.mid(x, y, z, g);
    const sg = f < 0 ? -1 : 1;
    const s = f * sg - t;
    const l = Math.sqrt(x * x + y * y + z * z) || 1e-9;
    const b = l - this.ball;
    const rc = Math.min(this.round, t * 0.9);
    if (Math.max(s, b) < -rc) {
      if (s > b) (g[0] *= sg), (g[1] *= sg), (g[2] *= sg);
      else (g[0] = x / l), (g[1] = y / l), (g[2] = z / l);
      return Math.max(s, b);
    }
    const u = Math.max(s + rc, 0), v = Math.max(b + rc, 0), h = Math.sqrt(u * u + v * v);
    g[0] = (u * sg * g[0] + (v * x) / l) / h;
    g[1] = (u * sg * g[1] + (v * y) / l) / h;
    g[2] = (u * sg * g[2] + (v * z) / l) / h;
    return h - rc;
  },
  field(x, y, z, g) {
    return this.sheet(x, y, z, g, this.t);
  },
  // Away from the sheet G / |∇G| stretches: divide by its local slope, with a margin.
  sdf(x, y, z) {
    const f = this.field(x, y, z, G);
    return f / (1.1 * Math.max(1, Math.sqrt(G[0] * G[0] + G[1] * G[1] + G[2] * G[2])));
  },
  // Far from the sheet G / |∇G| can mislead (along the tunnel's axis its gradient runs along the axis): when the
  // landing misses, start from the nearest of a cloud of surface points instead.
  project(x, y, z) {
    const q = fieldProject(this, x, y, z);
    if (Math.abs(this.field(q[0], q[1], q[2], G)) < 1e-6) return q;
    const s = this.nearestSample(x, y, z);
    return fieldProject(this, x, y, z, s[0], s[1], s[2], 0.03);
  },
  nearestSample(x, y, z) {
    const C = 0.1, n = Math.ceil((2 * this.ball + 0.4) / C), o = -this.ball - 0.2;
    if (!this.cloud) {
      this.cloud = new Map();
      const step = 0.035;
      for (let a = -this.ball; a <= this.ball; a += step)
        for (let b = -this.ball; b <= this.ball; b += step)
          for (let c = -this.ball; c <= this.ball; c += step) {
            if (Math.abs(this.field(a, b, c, G)) > step) continue;
            const q = fieldProject(this, a, b, c);
            if (Math.abs(this.field(q[0], q[1], q[2], G)) > 1e-6) continue;
            const k = Math.floor((q[0] - o) / C) + n * (Math.floor((q[1] - o) / C) + n * Math.floor((q[2] - o) / C));
            (this.cloud.get(k) ?? this.cloud.set(k, []).get(k)).push(q);
          }
    }
    const i = Math.floor((x - o) / C), j = Math.floor((y - o) / C), k = Math.floor((z - o) / C);
    let best = null, bd = Infinity;
    for (let r = 1; r <= n && (!best || Math.sqrt(bd) > (r - 1) * C); r++)
      for (let a = i - r; a <= i + r; a++)
        for (let b = j - r; b <= j + r; b++)
          for (let c = k - r; c <= k + r; c++) {
            if (Math.max(Math.abs(a - i), Math.abs(b - j), Math.abs(c - k)) !== r && r > 1) continue;
            for (const q of this.cloud.get(a + n * (b + n * c)) ?? []) {
              const d = (q[0] - x) ** 2 + (q[1] - y) ** 2 + (q[2] - z) ** 2;
              if (d < bd) (bd = d), (best = q);
            }
          }
    return best ?? [x, y, z];
  },
  // A thicker sheet in the gyroid's own axes (x, y, z → the frame GY_E), so a coarse grid over it is mapped onto
  // itself by the symmetries; its points go back with toShape.
  framed(t) {
    const self = this, E = GY_E, g3 = new Float64Array(3);
    const toShape = (a, b, c) => [E[0][0] * a + E[0][1] * b + E[0][2] * c, E[1][0] * a + E[1][1] * b + E[1][2] * c, E[2][0] * a + E[2][1] * b + E[2][2] * c];
    return {
      bounds: this.bounds,
      toShape,
      field(a, b, c, g) {
        const [x, y, z] = toShape(a, b, c);
        const f = self.sheet(x, y, z, g3, t);
        for (let i = 0; i < 3; i++) g[i] = E[0][i] * g3[0] + E[1][i] * g3[1] + E[2][i] * g3[2];
        return f;
      },
      sdf(a, b, c) {
        const [x, y, z] = toShape(a, b, c);
        return self.sheet(x, y, z, g3, t) / (1.1 * Math.max(1, Math.hypot(g3[0], g3[1], g3[2])));
      },
      project(a, b, c) {
        return fieldProject(this, a, b, c);
      },
    };
  },
};

// ── Dodecahedron ──
// A dodecahedron (face normals the cyclic permutations of (0, ±1, ±φ)) offset by a ball: flat faces, cylindrical
// edges and spherical corners. The closest point on the inner solid is exact: the face, edge or corner among those
// whose planes the point lies outside of.
const PHI = (1 + Math.sqrt(5)) / 2;
export const dodeca = (() => {
  const N = [];
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      const l = Math.hypot(1, PHI);
      N.push([0, s1 / l, (s2 * PHI) / l], [s1 / l, (s2 * PHI) / l, 0], [(s2 * PHI) / l, 0, s1 / l]);
    }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const adj = (i, j) => i !== j && dot(N[i], N[j]) > 0.4;
  const solve3 = (a, b, c, h) => {
    // The point on three planes n·x = h: Cramer's rule.
    const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const bc = cr(b, c), ca = cr(c, a), ab = cr(a, b), det = dot(a, bc);
    return [0, 1, 2].map((k) => (h * (bc[k] + ca[k] + ab[k])) / det);
  };
  const V = [], VF = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++)
      for (let k = j + 1; k < 12; k++)
        if (adj(i, j) && adj(j, k) && adj(i, k)) V.push(solve3(N[i], N[j], N[k], 1)), VF.push([i, j, k]);
  const Ed = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++) {
      if (!adj(i, j)) continue;
      const ends = VF.map((f, v) => (f.includes(i) && f.includes(j) ? v : -1)).filter((v) => v >= 0);
      Ed.push([i, j, ends[0], ends[1]]);
    }
  const H = (n) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    const [a, b, c] = n.map((v) => v / l);
    return [1 - 2 * a * a, -2 * a * b, -2 * a * c, -2 * b * a, 1 - 2 * b * b, -2 * b * c, -2 * c * a, -2 * c * b, 1 - 2 * c * c];
  };
  // Mirrors: the planes normal to the 2-fold axes (edge midpoints). The kaleidoscopes about an axis take the two
  // mirrors through it closest to π / n apart.
  const axes2 = [];
  for (const [i, j] of Ed) {
    const m = [N[i][0] + N[j][0], N[i][1] + N[j][1], N[i][2] + N[j][2]];
    const l = Math.hypot(...m);
    const a = m.map((v) => v / l);
    if (!axes2.some((b) => Math.abs(dot(a, b)) > 0.999)) axes2.push(a);
  }
  const kaleido = (axis, n) => {
    const l = Math.hypot(...axis);
    const ax = axis.map((v) => v / l);
    const m = axes2.filter((a) => Math.abs(dot(a, ax)) < 1e-6);
    let best = null, bd = Infinity;
    for (const a of m)
      for (const b of m) {
        const d = Math.abs(Math.acos(Math.min(1, Math.abs(dot(a, b)))) - Math.PI / n);
        if (a !== b && d < bd) (bd = d), (best = [H(a), H(b)]);
      }
    return best;
  };
  return {
    inner: 0.66,
    rr: 0.17,
    normals: N,
    corners: V,
    radial: [0, 0, 0],
    symmetries: {
      none: [],
      mirror: [H([1, 0, 0])],
      "2 planes": [H([1, 0, 0]), H([0, 0, 1])],
      "3 planes": [H([1, 0, 0]), H([0, 1, 0]), H([0, 0, 1])],
      "3-fold": kaleido([1, 1, 1], 3),
      "5-fold": kaleido(N[0], 5),
      pyritohedral: [H([1, 0, 0]), H([0, 1, 0]), H([0, 0, 1]), [0, 0, 1, 1, 0, 0, 0, 1, 0]],
    },
    // Measured on the mesh (Steiner's formula agrees).
    area: 10.96,
    get bounds() {
      const e = Math.max(...V.map((v) => Math.abs(v[0]))) * this.inner + this.rr;
      return [e, e, e];
    },
    // Closest point on the inner solid → c, and the signed distance to it.
    inside(x, y, z, c) {
      const h = this.inner;
      let best = -Infinity, bi = 0, out = 0;
      const dp = this._dp ??= new Float64Array(12);
      for (let i = 0; i < 12; i++) {
        const n = N[i];
        const d = n[0] * x + n[1] * y + n[2] * z - h;
        dp[i] = d;
        if (d > 0) out++;
        if (d > best) (best = d), (bi = i);
      }
      this._bi = bi;
      if (out <= 1) {
        const n = N[bi];
        c[0] = x - n[0] * best, c[1] = y - n[1] * best, c[2] = z - n[2] * best;
        return best;
      }
      let bd = Infinity;
      for (const [i, j, a, b] of Ed) {
        if (dp[i] <= 0 || dp[j] <= 0) continue;
        const A = V[a], B = V[b];
        const ex = (B[0] - A[0]) * h, ey = (B[1] - A[1]) * h, ez = (B[2] - A[2]) * h;
        const px = x - A[0] * h, py = y - A[1] * h, pz = z - A[2] * h;
        const s = Math.max(0, Math.min(1, (px * ex + py * ey + pz * ez) / (ex * ex + ey * ey + ez * ez)));
        const qx = A[0] * h + ex * s, qy = A[1] * h + ey * s, qz = A[2] * h + ez * s;
        const d = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
        if (d < bd) (bd = d), (c[0] = qx), (c[1] = qy), (c[2] = qz);
      }
      // Two faces out but not neighbours: the nearer face plane's foot is on its face.
      for (let i = 0; i < 12; i++) {
        if (dp[i] <= 0) continue;
        const n = N[i];
        const qx = x - n[0] * dp[i], qy = y - n[1] * dp[i], qz = z - n[2] * dp[i];
        let ok = true;
        for (let j = 0; j < 12 && ok; j++) if (j !== i && N[j][0] * qx + N[j][1] * qy + N[j][2] * qz > h + 1e-9) ok = false;
        if (ok && dp[i] * dp[i] < bd) (bd = dp[i] * dp[i]), (c[0] = qx), (c[1] = qy), (c[2] = qz);
      }
      return Math.sqrt(bd);
    },
    _c: [0, 0, 0],
    field(x, y, z, g) {
      const c = this._c;
      const d = this.inside(x, y, z, c);
      if (d <= 0) {
        const n = N[this._bi];
        g[0] = n[0], g[1] = n[1], g[2] = n[2];
      } else {
        g[0] = (x - c[0]) / d, g[1] = (y - c[1]) / d, g[2] = (z - c[2]) / d;
      }
      return d - this.rr;
    },
    sdf(x, y, z) {
      return this.field(x, y, z, G);
    },
    project(x, y, z) {
      const c = this._c, g = G;
      this.field(x, y, z, g);
      return [c[0] + g[0] * this.rr, c[1] + g[1] * this.rr, c[2] + g[2] * this.rr, g[0], g[1], g[2]];
    },
  };
})();

// ── Icosahedron ──
// Like the dodecahedron (its dual: the face normals point at the dodecahedron's corners), built from any set of face
// normals: corners are the triples of planes that meet on the solid, edges the face pairs sharing two corners.
export const icosa = (() => {
  // Its face normals point at the dodecahedron's corners, so the two share every symmetry.
  const N = dodeca.corners.map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  const F = N.length;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const V = [];
  for (let i = 0; i < F; i++)
    for (let j = i + 1; j < F; j++)
      for (let k = j + 1; k < F; k++) {
        const a = N[i], b = N[j], cc = N[k];
        const bc = cr(b, cc), ca = cr(cc, a), ab = cr(a, b), det = dot(a, bc);
        if (Math.abs(det) < 1e-9) continue;
        const v = [0, 1, 2].map((m) => (bc[m] + ca[m] + ab[m]) / det);
        if (N.some((n) => dot(n, v) > 1 + 1e-7)) continue;
        if (!V.some((w) => Math.hypot(w[0] - v[0], w[1] - v[1], w[2] - v[2]) < 1e-6)) V.push(v);
      }
  const onFace = V.map((v) => N.map((n, f) => (Math.abs(dot(n, v) - 1) < 1e-7 ? f : -1)).filter((f) => f >= 0));
  const Ed = [];
  for (let i = 0; i < F; i++)
    for (let j = i + 1; j < F; j++) {
      const ends = onFace.map((fs, v) => (fs.includes(i) && fs.includes(j) ? v : -1)).filter((v) => v >= 0);
      if (ends.length === 2) Ed.push([i, j, ends[0], ends[1]]);
    }
  const base = { ...dodeca };
  delete base._dp;
  return Object.assign(base, {
    // As large as the dodecahedron.
    inner: 0.675,
    rr: 0.153,
    normals: N,
    corners: V,
    // Measured on the mesh.
    area: 10.19,
    inside(x, y, z, cOut) {
      const h = this.inner;
      let best = -Infinity, bi = 0, out = 0;
      const dp = this._dp ??= new Float64Array(F);
      for (let i = 0; i < F; i++) {
        const n = N[i];
        const d = n[0] * x + n[1] * y + n[2] * z - h;
        dp[i] = d;
        if (d > 0) out++;
        if (d > best) (best = d), (bi = i);
      }
      this._bi = bi;
      if (out <= 1) {
        const n = N[bi];
        cOut[0] = x - n[0] * best, cOut[1] = y - n[1] * best, cOut[2] = z - n[2] * best;
        return best;
      }
      let bd = Infinity;
      for (const [i, j, a, b] of Ed) {
        if (dp[i] <= 0 || dp[j] <= 0) continue;
        const A = V[a], B = V[b];
        const ex = (B[0] - A[0]) * h, ey = (B[1] - A[1]) * h, ez = (B[2] - A[2]) * h;
        const px = x - A[0] * h, py = y - A[1] * h, pz = z - A[2] * h;
        const s = Math.max(0, Math.min(1, (px * ex + py * ey + pz * ez) / (ex * ex + ey * ey + ez * ez)));
        const qx = A[0] * h + ex * s, qy = A[1] * h + ey * s, qz = A[2] * h + ez * s;
        const d = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
        if (d < bd) (bd = d), (cOut[0] = qx), (cOut[1] = qy), (cOut[2] = qz);
      }
      for (let i = 0; i < F; i++) {
        if (dp[i] <= 0) continue;
        const n = N[i];
        const qx = x - n[0] * dp[i], qy = y - n[1] * dp[i], qz = z - n[2] * dp[i];
        let ok = true;
        for (let j = 0; j < F && ok; j++) if (j !== i && N[j][0] * qx + N[j][1] * qy + N[j][2] * qz > h + 1e-9) ok = false;
        if (ok && dp[i] * dp[i] < bd) (bd = dp[i] * dp[i]), (cOut[0] = qx), (cOut[1] = qy), (cOut[2] = qz);
      }
      return Math.sqrt(bd);
    },
    _c: [0, 0, 0],
    field(x, y, z, g) {
      const cc = this._c;
      const d = this.inside(x, y, z, cc);
      if (d <= 0) {
        const n = N[this._bi];
        g[0] = n[0], g[1] = n[1], g[2] = n[2];
      } else {
        g[0] = (x - cc[0]) / d, g[1] = (y - cc[1]) / d, g[2] = (z - cc[2]) / d;
      }
      return d - this.rr;
    },
  }) && Object.defineProperty(base, "bounds", {
    get() {
      const e = Math.max(...V.map((v) => Math.abs(v[0]))) * this.inner + this.rr;
      return [e, e, e];
    },
  });
})();

// ── Lens ──
// A lentil: two spherical caps meeting at a rim, rounded with a small radius. In the (|y|, ρ) half plane the inner
// vesica is the intersection of two discs of radius rad centred at ∓off on the axis, its tip at (0, b); the surface
// is that offset by rr (exact, after iq's sdVesica).
export const lens = (() => {
  const plan = 1, half = 0.34, rr = 0.045;
  const b = plan - rr, s = half - rr;
  const rad = (b * b + s * s) / (2 * s), off = rad - s;
  return {
    rad,
    off,
    tip: b,
    rr,
    bounds: [plan, half, plan],
    // Measured on the mesh.
    area: 7.16,
    radial: [0, 0, 0],
    // Closest point on the inner vesica in the (|y|, ρ) plane → [u, v], and the signed distance.
    vesica(u, v, out) {
      if ((v - b) * off > u * b) {
        const l = Math.hypot(u, v - b) || 1e-9;
        out[0] = 0, out[1] = b;
        out[2] = u / l, out[3] = (v - b) / l;
        return l;
      }
      const du = u + off, l = Math.hypot(du, v) || 1e-9;
      out[0] = -off + (du / l) * rad, out[1] = (v / l) * rad;
      out[2] = du / l, out[3] = v / l;
      return l - rad;
    },
    // Interlace grids: a direction's latitude sets how far from the rim toward the pole it lands, by arc length along
    // the profile (rim arc, then cap), so cells stay even instead of stretching out to the rim.
    radialMap(p) {
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      const lat = Math.asin(Math.max(-1, Math.min(1, p[1] / l)));
      const R = rad + rr, psi0 = Math.atan2(off, b);
      const S = rr * psi0 + R * (Math.PI / 2 - psi0);
      const s = (Math.abs(lat) / (Math.PI / 2)) * S;
      let rho, y;
      if (s < rr * psi0) (rho = b + rr * Math.cos(s / rr)), (y = rr * Math.sin(s / rr));
      else {
        const psi = psi0 + (s - rr * psi0) / R;
        (rho = R * Math.cos(psi)), (y = -off + R * Math.sin(psi));
      }
      const h = Math.hypot(p[0], p[2]);
      const cx = h > 1e-12 ? p[0] / h : 1, cz = h > 1e-12 ? p[2] / h : 0;
      return [rho * cx, lat < 0 ? -y : y, rho * cz];
    },
    _o: [0, 0, 0, 0],
    field(x, y, z, g) {
      const rho = Math.hypot(x, z), o = this._o;
      const d = this.vesica(Math.abs(y), rho, o);
      const sy = y < 0 ? -1 : 1;
      const cx = rho > 1e-12 ? x / rho : 1, cz = rho > 1e-12 ? z / rho : 0;
      g[0] = o[3] * cx, g[1] = o[2] * sy, g[2] = o[3] * cz;
      return d - rr;
    },
    sdf(x, y, z) {
      return this.field(x, y, z, G);
    },
    project(x, y, z) {
      const rho = Math.hypot(x, z), o = this._o;
      this.vesica(Math.abs(y), rho, o);
      const sy = y < 0 ? -1 : 1;
      const cx = rho > 1e-12 ? x / rho : 1, cz = rho > 1e-12 ? z / rho : 0;
      const u = (o[0] + o[2] * rr) * sy, v = o[1] + o[3] * rr;
      return [v * cx, u, v * cz, o[3] * cx, o[2] * sy, o[3] * cz];
    },
  };
})();

// ── Möbius band ──
// A flat band whose section, a stadium (a segment of half width w, rounded by rr), turns half a turn on the way round,
// so its two faces are one. A stadium turned by π maps onto itself, so the field is continuous across the seam.
export const moebius = {
  R: 0.66,
  w: 0.27,
  rr: 0.075,
  bounds: [1.02, 0.36, 1.02],
  // Measured on the mesh.
  area: 6.49,
  symmetries: { none: [] },
  sec(a, b) {
    const ca = a - Math.max(-this.w, Math.min(this.w, a));
    return Math.sqrt(ca * ca + b * b) - this.rr;
  },
  field(x, y, z, g) {
    const rho = Math.sqrt(x * x + z * z) || 1e-9;
    const th = Math.atan2(z, x) / 2;
    const c = Math.cos(th), sn = Math.sin(th);
    const s = rho - this.R;
    const a = s * c + y * sn, b = -s * sn + y * c;
    const ca = a - Math.max(-this.w, Math.min(this.w, a));
    const l = Math.sqrt(ca * ca + b * b) || 1e-9;
    const ga = ca / l, gb = b / l;
    const gs = ga * c - gb * sn, gy = ga * sn + gb * c;
    const gt = (ga * b - gb * a) / 2 / (rho * rho);
    g[0] = (gs * x) / rho - gt * z;
    g[1] = gy;
    g[2] = (gs * z) / rho + gt * x;
    return l - this.rr;
  },
  // The half twist stretches the field away from the axis: divide by its local slope, with a margin.
  sdf(x, y, z) {
    const f = this.field(x, y, z, G);
    return f / (1.1 * Math.max(1, Math.sqrt(G[0] * G[0] + G[1] * G[1] + G[2] * G[2])));
  },
  project(x, y, z) {
    return fieldProject(this, x, y, z);
  },
};
