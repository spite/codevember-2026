// Rows along the level lines of a field on the surface, shared by the scales (and seigaiha) and the friezes: a slope
// plus noise, folded by the symmetry (a soft maximum over the images) so the rows meet in chevrons at the mirror
// planes; a level line is traced from a point both ways until it closes or stops.
import { Walker, inDomain, applyImage, surfaceLattice } from "../kit.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Points hashed in cells, with the nearest lookup.
export class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  key(p, di = 0, dj = 0, dk = 0) {
    const c = this.cell;
    return (Math.floor(p[0] / c) + di) * 73856093 + (Math.floor(p[1] / c) + dj) * 19349663 + (Math.floor(p[2] / c) + dk) * 83492791;
  }
  add(p, v = p) {
    const k = this.key(p);
    const b = this.map.get(k);
    if (b) b.push(v);
    else this.map.set(k, [v]);
  }
  // The nearest entry within the cell size, as [distance, entry].
  nearest(p, pos = (v) => v) {
    let best = [Infinity, null];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const b = this.map.get(this.key(p, i, j, k));
          if (!b) continue;
          for (const v of b) {
            const d = dist(p, pos(v));
            if (d < best[0]) best = [d, v];
          }
        }
    return best;
  }
}

/*
 * The field dot(p, axis) + amp · noise(p · nf + off), folded over the symmetry images; slope(p), when given, replaces
 * the dot product; fold: false leaves it unfolded (for a slope whose level lines the symmetry already maps onto level
 * lines). Returns its value and tangential gradient (field), a projection onto a level (toLevel), samples over the
 * surface (sample), the level line tracer (trace), arc length helpers (arcs, at) and the fundamental domain's tests
 * (dom, boundary, onMirror).
 */
export function levelField(shape, images, { axis, amp, nf, noise, off, K = 18, slope, fold = true }) {
  const group = [[1, 0, 0, 0, 1, 0, 0, 0, 1], ...(fold ? images : [])];
  const f = (p) => (slope ? slope(p) : dot(p, axis)) + amp * noise(p[0] * nf + off[0], p[1] * nf + off[1], p[2] * nf + off[2]);
  // dot(m p, axis) = dot(p, mᵀ axis).
  const axes = group.map((m) => [m[0] * axis[0] + m[3] * axis[1] + m[6] * axis[2], m[1] * axis[0] + m[4] * axis[1] + m[7] * axis[2], m[2] * axis[0] + m[5] * axis[1] + m[8] * axis[2]]);
  const phi =
    group.length === 1
      ? f
      : (p) => {
          // Only the images whose slope term is within reach of the largest need their noise.
          const dots = slope ? group.map((m) => slope(applyImage(m, p))) : axes.map((a) => dot(p, a));
          let md = -Infinity;
          for (const x of dots) md = Math.max(md, x);
          const v = [];
          for (let i = 0; i < dots.length; i++) if (dots[i] > md - 2 * amp - 8 / K) v.push(f(applyImage(group[i], p)));
          let m = -Infinity;
          for (const x of v) m = Math.max(m, x);
          let s = 0;
          for (const x of v) s += Math.exp(K * (x - m));
          return m + Math.log(s) / K;
        };
  // Value and tangential gradient at a surface point with normal n.
  const field = (p, n) => {
    const e = 2e-4;
    const v = phi(p);
    const g = [(phi([p[0] + e, p[1], p[2]]) - v) / e, (phi([p[0], p[1] + e, p[2]]) - v) / e, (phi([p[0], p[1], p[2] + e]) - v) / e];
    const k = dot(g, n);
    return [v, [g[0] - n[0] * k, g[1] - n[1] * k, g[2] - n[2] * k]];
  };
  // Moves a point onto the level line l.
  const toLevel = (p, l) => {
    let q = shape.project(p[0], p[1], p[2]);
    for (let it = 0; it < 2; it++) {
      const [v, g] = field(q, [q[3], q[4], q[5]]);
      const gg = dot(g, g);
      if (gg < 1e-8) return null;
      const t = (v - l) / gg;
      if (Math.abs(v - l) < 1e-6) break;
      q = shape.project(q[0] - g[0] * t, q[1] - g[1] * t, q[2] - g[2] * t);
    }
    return q;
  };

  // Samples over the surface on a lattice of the given step, highest first, with the field's range and median slope.
  function sample(step) {
    const samples = surfaceLattice(shape, step).map((q) => {
      const [v, g] = field(q, [q[3], q[4], q[5]]);
      return { p: [q[0], q[1], q[2]], v, g: Math.hypot(g[0], g[1], g[2]) };
    });
    samples.sort((a, b) => b.v - a.v);
    const gs = samples.map((s) => s.g).sort((a, b) => a - b);
    return { samples, vMax: samples[0].v, vMin: samples[samples.length - 1].v, gMed: gs[gs.length >> 1] };
  }

  // Traces the level line l from q both ways in steps of H (at most maxSteps each way) until it closes or stops;
  // returns { pts, closed }.
  function trace(q, l, taken, H, maxSteps = 4000) {
    const halves = [];
    let closed = false;
    for (const sg of [1, -1]) {
      const pts = [];
      const w = new Walker(shape, [q[0], q[1], q[2]], [1, 0, 0]);
      let prevDir = null;
      for (let i = 0; i < maxSteps; i++) {
        const [, g] = field(w.p, w.n);
        const gl = Math.hypot(g[0], g[1], g[2]);
        if (gl < 1e-5) break;
        const n = w.n;
        let d = [(n[1] * g[2] - n[2] * g[1]) / gl, (n[2] * g[0] - n[0] * g[2]) / gl, (n[0] * g[1] - n[1] * g[0]) / gl];
        if (!prevDir) d = d.map((x) => x * sg);
        else if (dot(d, prevDir) < 0) d = d.map((x) => -x);
        w.setDir(d);
        prevDir = w.d.slice();
        const from = w.p.slice();
        w.step(H, 0);
        const r = toLevel(w.p, l);
        if (!r) break;
        w.p = [r[0], r[1], r[2]];
        w.n = [r[3], r[4], r[5]];
        // Stalled: the level pull undoes the step, or the line winds in place.
        if ((w.p[0] - from[0]) * d[0] + (w.p[1] - from[1]) * d[1] + (w.p[2] - from[2]) * d[2] < H * 0.25) break;
        if (pts.length >= 32 && dist(w.p, pts[pts.length - 32]) < H * 4) break;
        if (sg > 0 && i > 8 && dist(w.p, q) < H * 1.2) {
          closed = true;
          break;
        }
        if (taken(w.p)) break;
        pts.push(w.p.slice());
      }
      halves.push(pts);
      if (closed) break;
    }
    const seed = [q[0], q[1], q[2]];
    if (closed) return { pts: [seed, ...halves[0]], closed };
    return { pts: [...halves[1].reverse(), seed, ...halves[0]], closed };
  }

  // Cumulative arc length, and the point at arc length s.
  const arcs = (pts, closed) => {
    const s = [0];
    const n = pts.length;
    for (let i = 1; i < n + (closed ? 1 : 0); i++) s.push(s[i - 1] + dist(pts[i % n], pts[i - 1]));
    return s;
  };
  const at = (pts, s, x) => {
    let lo = 0;
    let hi = s.length - 1;
    x = Math.max(0, Math.min(s[hi], x));
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (s[m] <= x) lo = m;
      else hi = m;
    }
    const t = (x - s[lo]) / Math.max(s[hi] - s[lo], 1e-12);
    const a = pts[lo % pts.length];
    const b = pts[hi % pts.length];
    const q = shape.project(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    return [q[0], q[1], q[2]];
  };
  const dom = (p) => inDomain(p, images);
  // Bisects for the domain boundary between an inside point a and an outside point b.
  const boundary = (a, b) => {
    for (let i = 0; i < 24; i++) {
      const m = shape.project((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      const mp = [m[0], m[1], m[2]];
      if (dom(mp)) a = mp;
      else b = mp;
    }
    return a;
  };
  const onMirror = (p) => images.some((m) => m.det < 0 && dist(applyImage(m, p), p) < 1e-4);
  return { phi, field, toLevel, sample, trace, arcs, at, dom, boundary, onMirror };
}
