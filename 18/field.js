// A 2D grid of cell centres over a rectangle of the (u, v) plane: centre (i, j) is at
// (u0 + (i + 0.5) h, v0 + (j + 0.5) h).
class Grid {
  constructor(u0, v0, u1, v1, h) {
    this.h = h;
    this.nx = Math.max(2, Math.ceil((u1 - u0) / h));
    this.ny = Math.max(2, Math.ceil((v1 - v0) / h));
    this.u0 = u0;
    this.v0 = v0;
    this.mask = new Uint8Array(this.nx * this.ny);
  }

  u(i) {
    return this.u0 + (i + 0.5) * this.h;
  }

  v(j) {
    return this.v0 + (j + 0.5) * this.h;
  }

  // Fills every cell whose centre is inside the triangle (u, v pairs).
  fillTriangle(au, av, bu, bv, cu, cv) {
    const { h, nx, ny, mask } = this;
    // To continuous cell coordinates, centres on integers.
    let x0 = (au - this.u0) / h - 0.5, y0 = (av - this.v0) / h - 0.5;
    let x1 = (bu - this.u0) / h - 0.5, y1 = (bv - this.v0) / h - 0.5;
    let x2 = (cu - this.u0) / h - 0.5, y2 = (cv - this.v0) / h - 0.5;
    if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    if (y2 < y0) [x0, y0, x2, y2] = [x2, y2, x0, y0];
    if (y2 < y1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
    if (y2 - y0 < 1e-9) return;
    const jStart = Math.max(0, Math.ceil(y0));
    const jEnd = Math.min(ny - 1, Math.floor(y2));
    for (let j = jStart; j <= jEnd; j++) {
      // Long edge 0-2 against the short edge (0-1 below y1, 1-2 above).
      const xa = x0 + ((x2 - x0) * (j - y0)) / (y2 - y0);
      let xb;
      if (j < y1) xb = y1 - y0 > 1e-9 ? x0 + ((x1 - x0) * (j - y0)) / (y1 - y0) : x1;
      else xb = y2 - y1 > 1e-9 ? x1 + ((x2 - x1) * (j - y1)) / (y2 - y1) : x1;
      const iStart = Math.max(0, Math.ceil(Math.min(xa, xb)));
      const iEnd = Math.min(nx - 1, Math.floor(Math.max(xa, xb)));
      const row = j * nx;
      for (let i = iStart; i <= iEnd; i++) mask[row + i] = 1;
    }
  }

  // Distance from every cell centre to the nearest filled cell's edge (0 inside), in world units.
  distance() {
    const { nx, ny, mask, h } = this;
    const INF = 1e20;
    const d2 = new Float64Array(nx * ny);
    for (let k = 0; k < d2.length; k++) d2[k] = mask[k] ? 0 : INF;
    const n = Math.max(nx, ny);
    const f = new Float64Array(n);
    const out = new Float64Array(n);
    const vIdx = new Int32Array(n);
    const z = new Float64Array(n + 1);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) f[j] = d2[j * nx + i];
      edt1d(f, ny, out, vIdx, z);
      for (let j = 0; j < ny; j++) d2[j * nx + i] = out[j];
    }
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) f[i] = d2[row + i];
      edt1d(f, nx, out, vIdx, z);
      for (let i = 0; i < nx; i++) d2[row + i] = out[i];
    }
    const d = new Float32Array(nx * ny);
    // A filled cell's centre lies about half a cell inside its region's true edge.
    for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : Math.max(0, Math.sqrt(d2[k]) - 0.5) * h;
    return d;
  }
}

// Felzenszwalb & Huttenlocher's 1D squared distance transform.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      k = 0;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

// Closed iso-lines of a grid field (inside where value < iso), oriented with the inside on the left: outer
// loops counter-clockwise, holes clockwise. `value(i, j)` is read at cell centres; outside the grid counts as outside.
function contours(grid, value, iso = 0) {
  const { nx, ny } = grid;
  // Padded by one cell all round, so every loop closes.
  const W = nx + 2;
  const H = ny + 2;
  const f = new Float32Array(W * H).fill(1e9);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) f[(j + 1) * W + i + 1] = value(i, j) - iso;
  const inside = (i, j) => f[j * W + i] < 0;
  // Edge ids: horizontal edge (i, j)-(i+1, j) is 2 * (j * W + i), vertical (i, j)-(i, j+1) is 2 * (j * W + i) + 1.
  const H_ = (i, j) => 2 * (j * W + i);
  const V_ = (i, j) => 2 * (j * W + i) + 1;
  const next = new Map();
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = inside(i, j), b = inside(i + 1, j), c = inside(i + 1, j + 1), d = inside(i, j + 1);
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const bottom = H_(i, j), top = H_(i, j + 1), left = V_(i, j), right = V_(i + 1, j);
      const seg = (e1, e2) => next.set(e1, e2);
      switch (code) {
        case 1: seg(bottom, left); break;
        case 2: seg(right, bottom); break;
        case 4: seg(top, right); break;
        case 8: seg(left, top); break;
        case 14: seg(left, bottom); break;
        case 13: seg(bottom, right); break;
        case 11: seg(right, top); break;
        case 7: seg(top, left); break;
        case 3: seg(right, left); break;
        case 6: seg(top, bottom); break;
        case 12: seg(left, right); break;
        case 9: seg(bottom, top); break;
        case 5: {
          const centre = f[j * W + i] + f[j * W + i + 1] + f[(j + 1) * W + i] + f[(j + 1) * W + i + 1] < 0;
          if (centre) { seg(bottom, right); seg(top, left); } else { seg(bottom, left); seg(top, right); }
          break;
        }
        case 10: {
          const centre = f[j * W + i] + f[j * W + i + 1] + f[(j + 1) * W + i] + f[(j + 1) * W + i + 1] < 0;
          if (centre) { seg(left, bottom); seg(right, top); } else { seg(right, bottom); seg(left, top); }
          break;
        }
      }
    }
  }
  const point = (e) => {
    const k = e >> 1;
    const i = k % W;
    const j = (k - i) / W;
    const f0 = f[k];
    const f1 = e & 1 ? f[k + W] : f[k + 1];
    const t = f0 / (f0 - f1);
    // Padded cell (i, j) is grid cell (i - 1, j - 1).
    const ci = i - 1 + (e & 1 ? 0 : t);
    const cj = j - 1 + (e & 1 ? t : 0);
    return [grid.u0 + (ci + 0.5) * grid.h, grid.v0 + (cj + 0.5) * grid.h];
  };
  const loops = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop = [];
    let e = start;
    while (next.has(e)) {
      const n = next.get(e);
      next.delete(e);
      loop.push(point(e));
      e = n;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function signedArea(loop) {
  let a = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Douglas-Peucker on a closed loop.
function simplify(loop, tolerance) {
  const n = loop.length;
  if (n < 8) return loop;
  // Split at the vertex farthest from the first one.
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > best) [best, far] = [d, i];
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const t2 = tolerance * tolerance;
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const A = loop[s], B = loop[e % n];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy || 1e-30;
    let worst = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const P = loop[i];
      const cross = (P[0] - A[0]) * dy - (P[1] - A[1]) * dx;
      const d2 = (cross * cross) / len2;
      if (d2 > worst) [worst, idx] = [d2, i];
    }
    if (worst > t2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i]);
  return out;
}

// Signed distances of simple outlines (negative inside).
function sdCircle(u, v, r) {
  return Math.hypot(u, v) - r;
}

function sdRoundRect(u, v, hw, hh, r) {
  const qx = Math.abs(u) - hw + r;
  const qy = Math.abs(v) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Regular n-gon with circumradius r, a flat side up (or a corner, turned by pi / n).
function sdPolygon(u, v, r, n, turn = 0) {
  const an = Math.PI / n;
  let a = Math.atan2(u, v) + turn;
  a = ((((a + an) % (2 * an)) + 2 * an) % (2 * an)) - an;
  const len = Math.hypot(u, v);
  const px = len * Math.cos(a), py = Math.abs(len * Math.sin(a));
  const apothem = r * Math.cos(an), half = r * Math.sin(an);
  const d = Math.hypot(px - apothem, py - Math.min(py, half));
  return px < apothem ? -Math.min(d, apothem - px) * (py <= half ? 1 : 1) : d;
}

// Regular star with n points, outer radius r, inner radius ri, one point toward +v (Quilez's sdStar, exact).
function sdStar(u, v, r, n, ri) {
  const an = Math.PI / n;
  // Fold into one sector, with the point along +v.
  let a = Math.atan2(u, v);
  a = ((a % (2 * an)) + 2 * an) % (2 * an);
  if (a > an) a = 2 * an - a;
  const len = Math.hypot(u, v);
  const px = len * Math.sin(a), py = len * Math.cos(a);
  // Segment from the point (0, r) to the inner vertex (ri sin an, ri cos an).
  const ax = 0, ay = r, bx = ri * Math.sin(an), by = ri * Math.cos(an);
  const ex = bx - ax, ey = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
  const dx = px - ax - ex * t, dy = py - ay - ey * t;
  const d = Math.hypot(dx, dy);
  // Inside if on the centre's side of the segment.
  const side = ex * (py - ay) - ey * (px - ax);
  return side < 0 ? -d : d;
}


// Even spacing along a closed loop.
function resample(loop, step) {
  const out = [];
  const n = loop.length;
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = carry;
    while (s < len) {
      const t = s / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      s += step;
    }
    carry = s - len;
  }
  return out.length >= 3 ? out : loop;
}

// Taubin smoothing: removes the grid's stair-steps and rounds sharp corners without shrinking the loop.
function taubin(loop, iterations, lambda = 0.5, mu = -0.53) {
  const n = loop.length;
  let p = loop.map((q) => [q[0], q[1]]);
  let tmp = p.map((q) => [q[0], q[1]]);
  for (let it = 0; it < iterations * 2; it++) {
    const k = it % 2 ? mu : lambda;
    for (let i = 0; i < n; i++) {
      const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
      tmp[i][0] = b[0] + k * ((a[0] + c[0]) / 2 - b[0]);
      tmp[i][1] = b[1] + k * ((a[1] + c[1]) / 2 - b[1]);
    }
    [p, tmp] = [tmp, p];
  }
  return p;
}

function pointInLoop(p, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Clean loops of a field (inside where value < iso): smoothed, simplified, nested into { outer, holes }.
function regionLoops(grid, value, { iso = 0, smooth = 12, tolerance = 1e-4, minArea = 4e-6 } = {}) {
  const step = grid.h * 0.7;
  const outers = [];
  const holes = [];
  for (const raw of contours(grid, value, iso)) {
    if (Math.abs(signedArea(raw)) < minArea) continue;
    const loop = simplify(taubin(resample(raw, step), smooth), tolerance);
    if (loop.length < 3) continue;
    const area = signedArea(loop);
    (area > 0 ? outers : holes).push({ loop, area: Math.abs(area) });
  }
  outers.sort((a, b) => a.area - b.area);
  const shapes = outers.map(({ loop }) => ({ outer: loop, holes: [] }));
  for (const { loop } of holes) shapes.find((s) => pointInLoop(loop[0], s.outer))?.holes.push(loop);
  return shapes;
}

// An outline as data: the union of `add` minus the union of `sub`, clipped by every `clip`; each a primitive in (u, v).
// Compiled once into a function, since it runs for every cell.
function compilePrimitive(p) {
  const f = shapePrimitive(p);
  if (!p.rot) return f;
  // Turned by `rot` about the piece's origin.
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  return (u, v) => f(c * u + s * v, -s * u + c * v);
}

function shapePrimitive(p) {
  const cx = p.c?.[0] ?? 0, cy = p.c?.[1] ?? 0;
  switch (p.type) {
    case "circle": return (u, v) => Math.hypot(u - cx, v - cy) - p.r;
    case "outsideCircle": return (u, v) => p.r - Math.hypot(u - cx, v - cy);
    // The wedge within `half` (radians) either side of straight down from c, turned by `at`.
    case "wedge": {
      const s = Math.sin(p.half), c = Math.cos(p.half);
      const ca = Math.cos(p.at ?? 0), sa = Math.sin(p.at ?? 0);
      return (u, v) => {
        const du = u - cx, dv = v - cy;
        const x = Math.abs(ca * du + sa * dv), y = -(-sa * du + ca * dv);
        // Distance past the nearer edge ray (direction (s, c) from the centre).
        const d = x * c - y * s;
        return x * s + y * c < 0 ? Math.max(d, Math.hypot(x, y) * (d > 0 ? 1 : -1)) : d;
      };
    }
    case "roundRect": {
      const [hw, hh] = p.h, r = p.r ?? 0;
      return (u, v) => sdRoundRect(u - cx, v - cy, hw, hh, r);
    }
    // Any simple polygon, `points` [[u, v], ...].
    case "poly": {
      const pts = p.points;
      return (u, v) => {
        let d = Infinity, sign = 1;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [ax, ay] = pts[j], [bx, by] = pts[i];
          const ex = bx - ax, ey = by - ay, wx = u - ax, wy = v - ay;
          const k = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
          d = Math.min(d, Math.hypot(wx - ex * k, wy - ey * k));
          const c1 = v >= ay, c2 = v < by, c3 = ex * wy > ey * wx;
          if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
        }
        return sign * d;
      };
    }
    case "polygon": {
      const round = p.round ?? 0, r = p.r - round, n = p.n, turn = p.vertexUp ? Math.PI / n : 0;
      return (u, v) => sdPolygon(u - cx, v - cy, r, n, turn) - round;
    }
    case "star": {
      const round = p.round ?? 0, r = p.r - round, ri = r * p.inner, n = p.n;
      return (u, v) => sdStar(u - cx, v - cy, r, n, ri) - round;
    }
  }
  throw new Error(`unknown primitive ${p.type}`);
}

// `plus` is added back after `sub` (a boss on a cut-away edge).
function compileOutline(outline) {
  const add = outline.add.map(compilePrimitive);
  const sub = (outline.sub ?? []).map(compilePrimitive);
  const plus = (outline.plus ?? []).map(compilePrimitive);
  const clip = (outline.clip ?? []).map(compilePrimitive);
  return (u, v) => {
    let a = add[0](u, v);
    for (let i = 1; i < add.length; i++) a = Math.min(a, add[i](u, v));
    for (let i = 0; i < sub.length; i++) a = Math.max(a, -sub[i](u, v));
    for (let i = 0; i < plus.length; i++) a = Math.min(a, plus[i](u, v));
    for (let i = 0; i < clip.length; i++) a = Math.max(a, clip[i](u, v));
    return a;
  };
}

export { Grid, contours, simplify, signedArea, resample, taubin, regionLoops, compileOutline, sdCircle, sdRoundRect, sdStar };
