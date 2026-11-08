// Warped SDF solids: knots, tangles, twisted bands and prisms, linked rings, with domain warps.
// A raw field only needs the right sign; the mesher projects onto its zero set.

const TAU = Math.PI * 2;

const range = (rand, a, b) => a + (b - a) * rand();
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const chance = (rand, p) => rand() < p;

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * h * k * (1 / 6);
}

// ── Domain warps ───────────────────────────────────────────────────────────────────────────────────

function randomWarp(rand, { twist = 1, bend = 0.5, noise = 1 } = {}) {
  const waves = [];
  const amp = chance(rand, 0.5 * noise) ? range(rand, 0.03, 0.07) : 0;
  if (amp) {
    for (let i = 0; i < 6; i++) {
      const u = range(rand, -1, 1), t = range(rand, 0, TAU), s = Math.sqrt(1 - u * u);
      waves.push({ d: [s * Math.cos(t), s * Math.sin(t), u], axis: i % 3, f: range(rand, 1.4, 3.2), ph: range(rand, 0, TAU), a: amp * range(rand, 0.6, 1) / (1 + (i >> 2)) });
    }
  }
  return {
    twist: chance(rand, 0.6 * twist) ? range(rand, -1.6, 1.6) : 0,
    bend: chance(rand, 0.5 * bend) ? range(rand, -0.7, 0.7) : 0,
    waves,
  };
}

const isWarped = (w) => w && (w.twist || w.bend || w.waves.length);

// The point of the raw field a point of space is looked up at.
function warpPoint(w, x, y, z) {
  const { twist, bend, waves } = w;
  if (twist) {
    const a = twist * y, c = Math.cos(a), s = Math.sin(a);
    const nx = c * x - s * z;
    z = s * x + c * z; x = nx;
  }
  if (bend) {
    const a = bend * x, c = Math.cos(a), s = Math.sin(a);
    const nx = c * x - s * y;
    y = s * x + c * y; x = nx;
  }
  if (waves.length) {
    const q = [x, y, z];
    for (const v of waves) q[v.axis] += v.a * Math.sin(v.f * (v.d[0] * x + v.d[1] * y + v.d[2] * z) + v.ph);
    [x, y, z] = q;
  }
  return [x, y, z];
}

function applyWarp(w, f) {
  if (!isWarped(w)) return f;
  return (x, y, z) => f(...warpPoint(w, x, y, z));
}

// The point of space that warps onto q: undo the twist, then Newton on the rest.
function unwarp(w, q) {
  if (!isWarped(w)) return q;
  const a = -w.twist * q[1], c = Math.cos(a), s = Math.sin(a);
  let p = [c * q[0] - s * q[2], q[1], s * q[0] + c * q[2]];
  const e = 1e-4;
  for (let it = 0; it < 12; it++) {
    const f = warpPoint(w, ...p), r = [q[0] - f[0], q[1] - f[1], q[2] - f[2]];
    if (Math.hypot(...r) < 1e-6) break;
    const J = [0, 1, 2].map((k) => {
      const d = p.slice();
      d[k] += e;
      const g = warpPoint(w, ...d);
      return [(g[0] - f[0]) / e, (g[1] - f[1]) / e, (g[2] - f[2]) / e];
    });
    // Columns J[k]; solve J·dp = r by Cramer's rule.
    const det = (A, B, C) => A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
    const D = det(J[0], J[1], J[2]);
    if (Math.abs(D) < 1e-9) break;
    p = [p[0] + det(r, J[1], J[2]) / D, p[1] + det(J[0], r, J[2]) / D, p[2] + det(J[0], J[1], r) / D];
  }
  return p;
}


// ── Smooth closed curves ──────────────────────────────────────────────────────────────────────────────

// Catmull-Rom through closed polyline values (points, frame vectors or radii as arrays) at parameter s (in
// segments): value, first and second derivative.
function catmull(V, s, k, out, d1, d2) {
  const n = V.length, i = Math.floor(s), t = s - i;
  const a = V[(((i - 1) % n) + n) % n], b = V[((i % n) + n) % n], c = V[(((i + 1) % n) + n) % n], d = V[(((i + 2) % n) + n) % n];
  const t2 = t * t, t3 = t2 * t;
  for (let j = 0; j < k; j++) {
    const p0 = a[j], p1 = b[j], p2 = c[j], p3 = d[j];
    const A = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3, B = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3, C = -0.5 * p0 + 0.5 * p2;
    out[j] = A * t3 + B * t2 + C * t + p1;
    if (d1) d1[j] = 3 * A * t2 + 2 * B * t + C;
    if (d2) d2[j] = 6 * A * t + 2 * B;
  }
}

// The parameter of the closest point of the smooth curve to (x, y, z), from a polyline estimate s0.
function closestParam(pts, s0, x, y, z, C, D1, D2) {
  let s = s0;
  for (let it = 0; it < 4; it++) {
    catmull(pts, s, 3, C, D1, D2);
    const ex = C[0] - x, ey = C[1] - y, ez = C[2] - z;
    const f = ex * D1[0] + ey * D1[1] + ez * D1[2];
    const fp = D1[0] * D1[0] + D1[1] * D1[1] + D1[2] * D1[2] + ex * D2[0] + ey * D2[1] + ez * D2[2];
    let ds = fp > 1e-12 ? -f / fp : 0;
    if (ds > 0.75) ds = 0.75;
    else if (ds < -0.75) ds = -0.75;
    s += ds;
    if (Math.abs(ds) < 1e-7) break;
  }
  catmull(pts, s, 3, C, D1, null);
  return s;
}

// ── Polylines looked up through a hash grid ───────────────────────────────────────────────────────────

// Segments of closed polylines in cells of a grid, each listed in every cell within `reach` of it.
function segmentHash(lines, reach) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const pts of lines) for (const q of pts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
  const cell = 0.1;
  for (let a = 0; a < 3; a++) { lo[a] -= reach + cell; hi[a] += reach + cell; }
  const dim = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / cell)));
  const segs = [], cells = new Map();
  lines.forEach((pts, li) => {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const A = pts[i], B = pts[(i + 1) % n];
      const s = { ax: A[0], ay: A[1], az: A[2], bx: B[0] - A[0], by: B[1] - A[1], bz: B[2] - A[2], line: li, i };
      s.ll = Math.max(s.bx * s.bx + s.by * s.by + s.bz * s.bz, 1e-12);
      segs.push(s);
      const c0 = [0, 1, 2].map((a) => Math.floor((Math.min(A[a], B[a]) - reach - lo[a]) / cell));
      const c1 = [0, 1, 2].map((a) => Math.floor((Math.max(A[a], B[a]) + reach - lo[a]) / cell));
      for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) {
        const key = (x * dim[1] + y) * dim[2] + z;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(s);
      }
    }
  });
  return (x, y, z) => {
    const cx = Math.floor((x - lo[0]) / cell), cy = Math.floor((y - lo[1]) / cell), cz = Math.floor((z - lo[2]) / cell);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= dim[0] || cy >= dim[1] || cz >= dim[2]) return null;
    return cells.get((cx * dim[1] + cy) * dim[2] + cz) ?? null;
  };
}

// Tubes along smooth closed curves through the polylines, radius per point; separate lines meet with a smooth union
// of size k.
function tubes(groups, k = 0) {
  let maxR = 0;
  for (const g of groups) for (const r of g.r) maxR = Math.max(maxR, r);
  const reach = maxR + k + 0.02;
  const lookup = segmentHash(groups.map((g) => g.pts), reach);
  const G = groups.length, best = new Float64Array(G), bs = new Float64Array(G);
  const R = groups.map((g) => g.r.map((r) => [r]));
  const C = [0, 0, 0], D1 = [0, 0, 0], D2 = [0, 0, 0], rr = [0];
  return (x, y, z) => {
    const list = lookup(x, y, z);
    if (!list) return reach;
    best.fill(Infinity);
    for (const s of list) {
      const px = x - s.ax, py = y - s.ay, pz = z - s.az;
      let t = (px * s.bx + py * s.by + pz * s.bz) / s.ll;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - s.bx * t, dy = py - s.by * t, dz = pz - s.bz * t;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best[s.line]) { best[s.line] = d; bs[s.line] = s.i + t; }
    }
    let d = reach;
    for (let g = 0; g < G; g++) {
      if (best[g] === Infinity) continue;
      const sp = closestParam(groups[g].pts, bs[g], x, y, z, C, D1, D2);
      catmull(R[g], sp, 1, rr, null, null);
      const dg = Math.hypot(x - C[0], y - C[1], z - C[2]) - rr[0];
      d = d === reach ? dg : k > 0 ? smin(d, dg, k) : Math.min(d, dg);
    }
    return d;
  };
}

// A 2D profile swept along a closed polyline, turning `turn` radians in total on top of a closed frame.
function sweep(pts, profile, size, turn) {
  const n = pts.length;
  const T = pts.map((_, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...v);
    return v.map((c) => c / l);
  });
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((c) => c / l); };
  // Parallel transport, then spread the closing mismatch and the twist along the arc length.
  const up = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const Nf = [norm(cross(cross(T[0], up), T[0]))];
  for (let i = 1; i <= n; i++) {
    const t = T[i % n], p = Nf[i - 1];
    Nf.push(norm(p.map((c, a) => c - dot(p, t) * t[a])));
  }
  const end = Nf[n], B0 = cross(T[0], Nf[0]);
  const gap = Math.atan2(dot(end, B0), dot(end, Nf[0]));
  const cum = [0];
  for (let i = 1; i <= n; i++) { const a = pts[i - 1], b = pts[i % n]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
  const L = cum[n];
  const U = [], V = [];
  for (let i = 0; i <= n; i++) {
    const ang = (-gap + turn) * (cum[i] / L), c = Math.cos(ang), s = Math.sin(ang);
    const N0 = Nf[i], B = cross(T[i % n], N0);
    U.push(N0.map((v, a) => c * v + s * B[a]));
    V.push(B.map((v, a) => c * v - s * N0[a]));
  }
  const reach = size + 0.05;
  const lookup = segmentHash([pts], reach);
  // A line along the swept solid at profile point (u, v).
  const line = (u, v) => pts.map((p, i) => [0, 1, 2].map((a) => p[a] + U[i][a] * u + V[i][a] * v));
  const C = [0, 0, 0], D1 = [0, 0, 0], D2 = [0, 0, 0], Fu = [0, 0, 0], Fv = [0, 0, 0];
  // Profile coordinates about the closest point of the smooth path, in a frame interpolated along it. The closing
  // segment's frame turns by the twist; its far end is interpolated towards the turned frame.
  const f = (x, y, z) => {
    const list = lookup(x, y, z);
    if (!list) return reach;
    let best = Infinity, bs = 0;
    for (const s of list) {
      const px = x - s.ax, py = y - s.ay, pz = z - s.az;
      let t = (px * s.bx + py * s.by + pz * s.bz) / s.ll;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - s.bx * t, dy = py - s.by * t, dz = pz - s.bz * t, e = dx * dx + dy * dy + dz * dz;
      if (e < best) { best = e; bs = s.i + t; }
    }
    if (best > reach * reach) return reach;
    const sp = closestParam(pts, bs, x, y, z, C, D1, D2);
    frameAt(sp, Fu, Fv);
    // Square the frame to the tangent.
    const tl = Math.hypot(D1[0], D1[1], D1[2]) || 1, tx = D1[0] / tl, ty = D1[1] / tl, tz = D1[2] / tl;
    let du = Fu[0] * tx + Fu[1] * ty + Fu[2] * tz;
    let ux = Fu[0] - du * tx, uy = Fu[1] - du * ty, uz = Fu[2] - du * tz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const sv = Fv[0] * vx + Fv[1] * vy + Fv[2] * vz < 0 ? -1 : 1;
    const ex = x - C[0], ey = y - C[1], ez = z - C[2];
    return profile(ex * ux + ey * uy + ez * uz, sv * (ex * vx + ey * vy + ez * vz));
  };
  // Frame at s: Catmull-Rom over the point frames. A frame one lap on (or back) is the point's own frame turned by the
  // angle the closing frame U[n] makes with U[0].
  const alpha = Math.atan2(dot(U[n], V[0]), dot(U[n], U[0]));
  const frameJ = (j, ang) => {
    const c = Math.cos(ang), s2 = Math.sin(ang);
    return [U[j].map((x, k) => c * x + s2 * V[j][k]), V[j].map((x, k) => c * x - s2 * U[j][k])];
  };
  const fwd = Array.from({ length: 3 }, (_, j) => frameJ(j, alpha)), back = Array.from({ length: 2 }, (_, j) => frameJ(n - 1 - j, -alpha));
  const frame = (j) => (j < 0 ? back[-j - 1] : j >= n ? fwd[j - n] : [U[j], V[j]]);
  const frameAt = (s, ou, ov) => {
    const m = ((s % n) + n) % n, i = Math.floor(m), t = m - i;
    const q = [frame(i - 1), frame(i), frame(i + 1), frame(i + 2)];
    const t2 = t * t, t3 = t2 * t;
    for (let w = 0; w < 2; w++) {
      const o = w ? ov : ou;
      for (let a = 0; a < 3; a++) {
        const p0 = q[0][w][a], p1 = q[1][w][a], p2 = q[2][w][a], p3 = q[3][w][a];
        o[a] = (-0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3) * t3 + (p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3) * t2 + (-0.5 * p0 + 0.5 * p2) * t + p1;
      }
    }
  };
  // The surface swept by the profile's u axis: a ribbon along the path.
  f.ribbon = (sp, u) => {
    catmull(pts, sp, 3, C, D1, null);
    frameAt(sp, Fu, Fv);
    const tl = Math.hypot(D1[0], D1[1], D1[2]) || 1, tx = D1[0] / tl, ty = D1[1] / tl, tz = D1[2] / tl;
    const du = Fu[0] * tx + Fu[1] * ty + Fu[2] * tz;
    let ux = Fu[0] - du * tx, uy = Fu[1] - du * ty, uz = Fu[2] - du * tz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    return [C[0] + (u * ux) / ul, C[1] + (u * uy) / ul, C[2] + (u * uz) / ul];
  };
  f.segments = n;
  f.line = line;
  return f;
}

// Rounded rectangle and rounded regular polygon profiles.
const bandProfile = (w, t, round) => (u, v) => {
  const qx = Math.abs(u) - w + round, qy = Math.abs(v) - t + round;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - round;
};
const polygonProfile = (sides, r, round) => {
  const ap = Math.PI / sides, edge = Math.tan(ap);
  return (u, v) => {
    const ang = Math.atan2(v, u), rr = Math.hypot(u, v);
    const sec = ang - 2 * ap * Math.round(ang / (2 * ap));
    const px = rr * Math.cos(sec), py = Math.abs(rr * Math.sin(sec));
    const a = r - round, dx = px - a, dy = Math.max(py - a * edge, 0);
    return (dx > 0 ? Math.hypot(dx, dy) : dx) - round;
  };
};

// Smallest distance between points of a closed polyline that are more than `skip` arc length apart.
function minClearance(pts, skip) {
  const n = pts.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1], pts[0][2] - pts[n - 1][2]);
  let m = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s = Math.abs(cum[j] - cum[i]);
    if (Math.min(s, L - s) < skip) continue;
    m = Math.min(m, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
  }
  return m;
}

// ── Raw fields (negative inside) ──────────────────────────────────────────────────────────────────────

function knotCurve(P, Q, a, h, M) {
  const pts = [];
  for (let i = 0; i < M; i++) {
    const t = (TAU * i) / M, r = 1 + a * Math.cos(Q * t);
    pts.push([r * Math.cos(P * t), h * a * Math.sin(Q * t), r * Math.sin(P * t)]);
  }
  return pts;
}

// Two lines along a tube on opposite sides, offset along dir(point) made square to the path.
function tubeRails(pts, r, dir) {
  const n = pts.length, inner = [], outer = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n], p = pts[i];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], tl = Math.hypot(...t) || 1;
    const d = dir(p, i), k = (d[0] * t[0] + d[1] * t[1] + d[2] * t[2]) / (tl * tl);
    const q = [d[0] - k * t[0], d[1] - k * t[1], d[2] - k * t[2]], ql = Math.hypot(...q) || 1;
    outer.push(p.map((c, j) => c + (r[i] * q[j]) / ql));
    inner.push(p.map((c, j) => c - (r[i] * q[j]) / ql));
  }
  return [inner, outer];
}

function knotField(p) {
  const M = 50 * (p.P + p.Q);
  const pts = knotCurve(p.P, p.Q, p.a, p.h, M);
  const clear = minClearance(pts, 0.9);
  const base = Math.min(p.tube, 0.47 * clear / (1 + p.swell));
  const r = pts.map((_, i) => base * (1 + p.swell * Math.sin((TAU * p.lobes * i) / M + p.phase)));
  return tubes([{ pts, r }]);
}

// A closed path: a torus knot, or a ring with a wavy radius and height.
function path(p) {
  if (p.P) return knotCurve(p.P, p.Q, p.a, p.h, 80 * (p.P + p.Q));
  const pts = [], M = 360;
  for (let i = 0; i < M; i++) {
    const t = (TAU * i) / M, r = 1 + p.wobble * Math.cos(p.wobK * t);
    pts.push([r * Math.cos(t), p.lift * Math.sin(p.wobK * t + 0.7), r * Math.sin(t)]);
  }
  return pts;
}

// A ribbon with `halfTwists` half turns: odd ones make it one-sided. A sheet, (u, v) along the path and across it.
function mobiusSheet(p) {
  const pts = path(p.path), clear = p.path.P ? minClearance(pts, 1.2) : 1.4;
  const w = Math.min(p.width, 0.47 * clear);
  const f = sweep(pts, bandProfile(w, w * p.aspect, p.round * w), w * Math.hypot(1, p.aspect), p.halfTwists * Math.PI);
  const fn = isWarped(p.warp) ? (t, u) => unwarp(p.warp, f.ribbon(t, u * w)) : (t, u) => f.ribbon(t, u * w);
  return { kind: "sheet", parts: [{ fn, u: [0, f.segments], v: [-1, 1] }] };
}

// A rounded polygon twisting `turns` × 2π / sides along the path.
function twistedField(p) {
  const pts = path(p.path), clear = p.path.P ? minClearance(pts, 1.2) : 1.4;
  const R = Math.min(p.size, 0.47 * clear), r = R * Math.cos(Math.PI / p.sides);
  const f = sweep(pts, polygonProfile(p.sides, r, p.round * r), R, (p.turns * TAU) / p.sides);
  // Rails along the rounded edges, so the twisting prism keeps its edges while its faces open.
  const ap = Math.PI / p.sides, rc = (r - p.round * r) / Math.cos(ap) + p.round * r;
  f.rails = Array.from({ length: p.sides }, (_, k) => f.line(rc * Math.cos((2 * k + 1) * ap), rc * Math.sin((2 * k + 1) * ap)));
  return f;
}

// Σx⁴ + a·r⁴ + b·r² + c: Goursat's family, the tanglecube among them.
function goursatField(p) {
  const { a, b, c, s } = p;
  return (x, y, z) => {
    x *= s; y *= s; z *= s;
    const x2 = x * x, y2 = y * y, z2 = z * z, r2 = x2 + y2 + z2;
    return x2 * x2 + y2 * y2 + z2 * z2 + a * r2 * r2 + b * r2 + c;
  };
}

const cheb = {
  4: (x) => { const x2 = x * x; return 8 * x2 * x2 - 8 * x2 + 1; },
  6: (x) => { const x2 = x * x; return ((32 * x2 - 48) * x2 + 18) * x2 - 1; },
  8: (x) => { const x2 = x * x; return (((128 * x2 - 256) * x2 + 160) * x2 - 32) * x2 + 1; },
};

// T_n(x) + T_n(y) + T_n(z) + c: a cube of chambers, closed off by the polynomials' growth past ±1.
function chmutovField(p) {
  const T = cheb[p.n], s = p.s, c = p.c;
  return (x, y, z) => T(x * s) + T(y * s) + T(z * s) + c;
}

function superFormula(phi, a, b, m, n1, n2, n3) {
  const t1 = Math.pow(Math.abs(Math.cos((m * phi) / 4) / a), n2);
  const t2 = Math.pow(Math.abs(Math.sin((m * phi) / 4) / b), n3);
  return Math.pow(t1 + t2 + 1e-12, -1 / n1);
}

function supershapeField(p) {
  const A = p.A, B = p.B;
  return (x, y, z) => {
    const d = Math.hypot(x, y, z);
    if (d < 1e-9) return -1;
    const th = Math.atan2(z, x), r1 = superFormula(th, A.a, A.b, A.m, A.n1, A.n2, A.n3);
    const ph = Math.atan2(y * r1, Math.hypot(x, z));
    const r2 = superFormula(ph, B.a, B.b, B.m, B.n1, B.n2, B.n3);
    return d - p.scale * r2 * Math.hypot(r1 * Math.cos(ph), Math.sin(ph));
  };
}

// Three mutually perpendicular ellipses, interlocked like the Borromean rings, fused where they pass.
function borromeanField(p) {
  const M = 120, groups = [], rails = [];
  for (let k = 0; k < 3; k++) {
    const pts = [], r = [], nrm = [];
    for (let i = 0; i < M; i++) {
      const t = (TAU * i) / M, e = [p.a * Math.cos(t), p.b * Math.sin(t), p.bow * Math.sin(2 * t + k)];
      const q = [0, 0, 0], n = [0, 0, 0];
      q[k] = e[0]; q[(k + 1) % 3] = e[1]; q[(k + 2) % 3] = e[2];
      n[k] = p.b * Math.cos(t); n[(k + 1) % 3] = p.a * Math.sin(t);
      pts.push(q);
      nrm.push(n);
      r.push(p.tube * (1 + p.swell * Math.cos(2 * t + p.phase)));
    }
    groups.push({ pts, r });
  }
  return tubes(groups, p.k);
}

// Polar repetition of a standing torus around the y axis, smooth-unioned into a crown.
function rosetteField(p) {
  const { count, R, ring, tube, tilt, k, hub } = p;
  const sector = TAU / count, ct = Math.cos(tilt), st = Math.sin(tilt);
  const torus = (x, y, z) => {
    x -= R;
    const yy = ct * y - st * z, zz = st * y + ct * z;
    return Math.hypot(Math.hypot(x, yy) - ring, zz) - tube;
  };
  return (x, y, z) => {
    const a = Math.atan2(z, x), r = Math.hypot(x, z);
    const i = Math.round(a / sector);
    let d = Infinity;
    for (let j = -1; j <= 1; j++) {
      const b = a - (i + j) * sector;
      d = smin(d, torus(r * Math.cos(b), y, r * Math.sin(b)), k);
    }
    if (hub) d = smin(d, Math.hypot(r - R, y) - hub, k);
    return d;
  };
}

// A torus knot threaded through a supershape core.
function knotCoreField(p) {
  const knot = knotField(p.knot), core = supershapeField(p.core);
  return (x, y, z) => smin(knot(x, y, z), core(x, y, z), p.k);
}

// ── The surface ────────────────────────────────────────────────────────────────────────────────────────

// The warped field and its rails (closed polylines in the field's frame). The mesher finds its reach, meshes it and
// keeps the largest inside part (and any at least `keep` of its size).
function make(kind, raw, warp, keep) {
  const out = { kind, f: applyWarp(warp, raw), extent: 2.2, keep: keep ?? Infinity };
  if (raw.rails) out.rails = raw.rails.map((line) => line.map((p) => unwarp(warp, p)));
  return out;
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────────────

const KNOTS = [[2, 3], [2, 5], [3, 4], [3, 5], [2, 7], [3, 7], [4, 5], [5, 3], [5, 2], [3, 2], [7, 3]];

function randomKnot(rand, tubeScale = 1) {
  const [P, Q] = pick(rand, KNOTS);
  return {
    P, Q,
    a: range(rand, 0.42, 0.62),
    h: range(rand, 0.8, 1.5),
    tube: range(rand, 0.17, 0.26) * tubeScale,
    swell: chance(rand, 0.7) ? range(rand, 0.15, 0.4) : 0,
    lobes: Math.floor(range(rand, 1, 7)),
    phase: range(rand, 0, TAU),
  };
}

function randomPath(rand, knotChance) {
  if (chance(rand, knotChance)) {
    const [P, Q] = pick(rand, [[2, 3], [3, 2], [2, 5], [3, 4], [3, 5], [5, 2]]);
    return { P, Q, a: range(rand, 0.45, 0.6), h: range(rand, 0.8, 1.3) };
  }
  return { wobble: range(rand, 0, 0.18), wobK: Math.floor(range(rand, 2, 6)), lift: range(rand, 0, 0.35) };
}

const solid = (id, name, random, field, extra = {}) => ({
  id, name, family: "warped", kind: "solid", random, ...extra,
  build: (p) => make("solid", field(p), p.warp, extra.keepParts),
});

export const SHAPES = [
  solid("torus-knot", "Torus knot",
    (rand) => ({ knot: randomKnot(rand), warp: randomWarp(rand, { twist: 0.6, bend: 0.4, noise: 0 }) }),
    (p) => knotField(p.knot),
    { cells: 1.1 }),
  solid("goursat", "Goursat tangle",
    (rand) => {
      const g = pick(rand, [[0, -5, 11.8], [0, -5, 10.5], [0.1, -5.5, 11], [-0.15, -4, 9], [0.25, -7, 15], [-0.2, -3, 6]]);
      return { a: g[0], b: g[1], c: g[2] * range(rand, 0.97, 1.03), s: 2.6, warp: randomWarp(rand, { twist: 1.4 }) };
    },
    goursatField),
  solid("chmutov", "Chmutov chambers",
    (rand) => {
      // Fuller chambers (lower c) read as a cube of lobes; thin ones turn to worms once perforated.
      const n = pick(rand, [6, 8, 8]);
      return { n, s: 1, c: n === 6 ? range(rand, -0.3, -0.05) : range(rand, -0.5, 0.05), warp: randomWarp(rand, { twist: 0, bend: 0, noise: 0 }) };
    },
    chmutovField,
    { cellFloor: 1, cells: 0.4, strut: 1.8 }),
  {
    id: "mobius", name: "Möbius band", family: "warped", kind: "sheet",
    random: (rand) => ({
      path: randomPath(rand, 0.4),
      halfTwists: pick(rand, [1, 1, 3, 3, 5, 2]) * pick(rand, [1, -1]),
      width: range(rand, 0.3, 0.42),
      aspect: range(rand, 0.32, 0.48),
      round: range(rand, 0.15, 0.3),
      warp: randomWarp(rand, { twist: 0.4, bend: 0.4 }),
    }),
    build: mobiusSheet,
  },
  solid("twisted", "Twisted prism",
    (rand) => {
      const sides = pick(rand, [3, 3, 4, 5]);
      const path = randomPath(rand, 0);
      path.wobble *= 0.5;
      path.lift *= 0.4;
      return {
        // A plain ring rather than a knot or a warp: a fat prism folds over itself in tight bends.
        path,
        sides,
        turns: pick(rand, [1, 2, 3, -1, -2]) * (sides === 3 ? 2 : 1),
        size: range(rand, 0.26, 0.38),
        // Round edges: a sharp one creases the skin's inner wall, which tears as the cells open.
        round: range(rand, 0.35, 0.5),
        warp: randomWarp(rand, { twist: 0, bend: 0, noise: 0 }),
      };
    },
    twistedField,
    { cellFloor: 1, cells: 0.55 }),
  solid("borromean", "Borromean rings",
    (rand) => ({
      a: 1,
      b: range(rand, 0.5, 0.62),
      bow: chance(rand, 0.5) ? range(rand, 0.05, 0.15) : 0,
      tube: range(rand, 0.11, 0.14),
      swell: chance(rand, 0.6) ? range(rand, 0.1, 0.25) : 0,
      phase: range(rand, 0, TAU),
      k: range(rand, 0.06, 0.12),
      warp: randomWarp(rand, { twist: 0.6, bend: 0.3, noise: 0 }),
    }),
    borromeanField,
    { cellFloor: 1, cells: 0.5, keepParts: 0.5 }),
  solid("crown", "Ring crown",
    (rand) => {
      const count = Math.floor(range(rand, 5, 10)), R = 0.75;
      return {
        count, R,
        ring: R * range(rand, 0.9, 1.2),
        tube: range(rand, 0.13, 0.18),
        tilt: range(rand, 0, 0.5),
        k: range(rand, 0.1, 0.18),
        hub: chance(rand, 0.4) ? range(rand, 0.12, 0.16) : 0,
        warp: randomWarp(rand, { twist: 0.6, bend: 0.3, noise: 0.6 }),
      };
    },
    rosetteField),
  solid("knot-core", "Knotted core",
    (rand) => {
      const core = {
        scale: range(rand, 0.5, 0.62),
        A: { a: 1, b: 1, m: pick(rand, [4, 6, 8]), n1: range(rand, 2, 4), n2: range(rand, 1.5, 3), n3: range(rand, 1.5, 3) },
        B: { a: 1, b: 1, m: pick(rand, [2, 4]), n1: range(rand, 2, 4), n2: range(rand, 1.5, 3), n3: range(rand, 1.5, 3) },
      };
      return { knot: randomKnot(rand, 0.8), core, k: range(rand, 0.1, 0.2), warp: randomWarp(rand, { twist: 0.5, bend: 0.3, noise: 0.3 }) };
    },
    knotCoreField,
    { cellFloor: 0.25 }),
];
