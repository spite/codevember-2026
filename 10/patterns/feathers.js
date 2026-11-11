// Feathers: long barbed plumes laid along the level lines of a slope plus noise, overlapping like plumage. Each
// plume is walked from its quill along the flow, its tip curling over, and kept a little less than its width from
// the others, so the vanes overlap; the first ones laid sit on top. Plumes are laid largest first wherever they fit,
// then small plumes, curls, flowers and beads fill the ground. A plume is drawn from the quill to the tip, spreading
// as a wave over the blank.
import { FEATHER, ROSETTE, BEAD, STROKE, DAISY, FIVE, rnd, rand, norm, Occupancy, Walker, surfacePoint, surfaceLattice, createNoise } from "../kit.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/*
 * opts: scale, flow (how much the plumes wander), leafiness (how far the tips curl), rosettes (flowers among the
 * fillers), fill (how densely the ground is filled), seed.
 */
export function feathers(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const curling = opts.leafiness ?? 0.5;
  const rosettes = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const images = kit.images;
  const occ = new Occupancy(0.035 * S, shape.bounds);
  occ.images = images;
  const prims = [];
  const GAP = 0.0024 * S;
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const axis = norm([rand(-0.5, 0.5), 1, rand(-0.5, 0.5)]);
  const amp = 0.08 + 0.45 * flow;
  const nf = 1.2 / S;
  const phi = (p) => dot(p, axis) + amp * noise(p[0] * nf + off[0], p[1] * nf + off[1], p[2] * nf + off[2]);
  const start = surfacePoint(shape);
  const wave = (p) => dist(p, start) * 3;

  // The flow at a walker: along the level line of phi, the same way round everywhere.
  function flowDir(w) {
    const e = 2e-4;
    const p = w.p;
    const v = phi(p);
    const g = [(phi([p[0] + e, p[1], p[2]]) - v) / e, (phi([p[0], p[1] + e, p[2]]) - v) / e, (phi([p[0], p[1], p[2] + e]) - v) / e];
    const d = cross(w.n, g);
    const l = Math.hypot(...d);
    return l < 1e-6 ? null : [d[0] / l, d[1] / l, d[2] / l];
  }

  // Half width of a plume at u (0 quill .. 1 tip), as a fraction of its widest, for its reservation.
  const profile = (u) => (u < 0.07 ? 0.25 : Math.pow(Math.sin(Math.PI * Math.pow((u - 0.07) / 0.93, 0.6)), 0.75));

  // Walks a plume from q along the flow; its rachis points with their half widths, or null if it is blocked early.
  function walk(q, W, Lf, hand) {
    const w = new Walker(shape, q, [1, 0, 0]);
    const d0 = flowDir(w);
    if (!d0) return null;
    w.setDir(d0);
    const h = W * 0.3;
    const n = Math.ceil(Lf / h);
    const pts = [{ p: w.p.slice(), n: w.n.slice(), d: w.d.slice() }];
    const curlAt = 0.55 + 0.3 * (1 - curling);
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const f = flowDir(w);
      if (f) {
        // Steer toward the flow, then curl over toward the tip.
        const s = w.side();
        const k = Math.atan2(dot(f, s), dot(f, w.d)) / (h * 3);
        const c = u > curlAt ? ((hand * (u - curlAt)) / (1 - curlAt)) * (2.2 + 2 * curling) / Lf : 0;
        w.step(h, u > curlAt ? c + k * 0.3 : k);
      } else w.step(h, 0);
      const r = W * profile(u) * 0.72 + GAP;
      if (occ.hit(w.p[0], w.p[1], w.p[2], r) || occ.selfHit(w.p[0], w.p[1], w.p[2], r)) {
        if (u < 0.75) return null;
        return { pts, Lf: (Lf * (i - 1)) / n };
      }
      pts.push({ p: w.p.slice(), n: w.n.slice(), d: w.d.slice() });
    }
    return { pts, Lf };
  }

  // Emits a plume as segments of a few steps, mitred at their joints.
  function emit(pts, W, Lf, layer, t0) {
    const per = 3;
    const idx = [];
    for (let i = 0; i < pts.length - 1; i += per) idx.push(i);
    idx.push(pts.length - 1);
    if (idx.length > 2 && idx[idx.length - 1] - idx[idx.length - 2] < 2) idx.splice(idx.length - 2, 1);
    const dirs = [];
    for (let k = 0; k + 1 < idx.length; k++) dirs.push(norm([0, 1, 2].map((j) => pts[idx[k + 1]].p[j] - pts[idx[k]].p[j])));
    const turn = (k) => {
      const n = pts[idx[k]].n;
      const a = dirs[k - 1];
      const b = dirs[k];
      return -Math.tan(Math.atan2(dot(n, cross(a, b)), dot(a, b)) / 2);
    };
    const total = idx[idx.length - 1];
    for (let k = 0; k + 1 < idx.length; k++) {
      const u0 = idx[k] / total;
      const u1 = idx[k + 1] / total;
      prims.push({
        type: FEATHER,
        a: pts[idx[k]].p,
        b: pts[idx[k + 1]].p,
        W,
        Lf,
        u0,
        u1,
        kA: k > 0 ? turn(k) : 0,
        kB: k + 2 < idx.length ? turn(k + 1) : 0,
        twist: 1,
        h: layer,
        ta: t0 + u0 * Lf * 8,
        tb: t0 + u1 * Lf * 8,
      });
    }
  }

  let owner = 0;
  function tryPlume(q, W, Lf, layer) {
    const hand = rnd() < 0.5 ? 1 : -1;
    const id = owner++;
    const r = walk(q, W, Lf, hand);
    if (!r || r.Lf < W * 3) return false;
    const { pts } = r;
    const t0 = wave(pts[0].p);
    pts.forEach((pt, i) => occ.add(pt.p[0], pt.p[1], pt.p[2], W * profile(i / (pts.length - 1)) * 0.72, id, 0, t0 + (i / pts.length) * r.Lf * 8));
    emit(pts, W, r.Lf, layer, t0);
    return true;
  }

  // Plumes, largest first; each size gets as many tries as would cover the blank a few times over.
  const SIZES = [0.068, 0.054, 0.043, 0.034, 0.026].map((w) => w * S);
  SIZES.forEach((W, level) => {
    const Lf = W * rand(6, 8.5);
    const tries = Math.round((shape.area / (W * Lf)) * 2.5);
    for (let k = 0; k < tries; k++) {
      const q = surfacePoint(shape);
      if (occ.hit(q[0], q[1], q[2], W * 0.5)) continue;
      // The first laid lie on top.
      tryPlume([q[0], q[1], q[2]], W, Lf * rand(0.8, 1.2), 0.98 - level * 0.07 - 0.12 * (k / tries) - rnd() * 0.03);
    }
  });

  // What is left: small plumes where they fit, then curls, flowers and beads.
  function freeCurl(q, r, t) {
    const w = new Walker(shape, [q[0], q[1], q[2]], [rand(-1, 1), rand(-1, 1), rand(-1, 1)]);
    const sg = rnd() < 0.5 ? 1 : -1;
    const lw = Math.max(0.0028 * S, r * 0.16);
    let rho = r * 0.55;
    const pts = [w.p.slice()];
    for (let i = 0; i < 16; i++) {
      w.step((2 * Math.PI * rho * 1.1) / 16, sg / rho);
      rho *= 0.95;
      if (occ.hit(w.p[0], w.p[1], w.p[2], lw + GAP)) return false;
      pts.push(w.p.slice());
    }
    for (let i = 0; i + 1 < pts.length; i++) prims.push({ type: STROKE, a: pts[i], b: pts[i + 1], ra: lw * (1 - 0.3 * (i / 16)), rb: lw * (1 - 0.3 * ((i + 1) / 16)), ta: t + i * 0.02, tb: t + (i + 1) * 0.02, h: 1 });
    for (const p of pts) occ.add(p[0], p[1], p[2], lw + GAP, -1, 0, t);
    return true;
  }
  const samples = surfaceLattice(shape, 0.008 * S);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  const RADII = [0.04, 0.032, 0.024, 0.018, 0.013, 0.0095, 0.007, 0.005].map((r) => r * S);
  const bound = new Float64Array(samples.length).fill(RADII[0]);
  const minR = 0.0055 * S * (1.6 - fill);
  for (const minP of [0.024, 0.013, 0].map((r) => r * S))
    for (let i = 0; i < samples.length; i++) {
      if (bound[i] < Math.max(minP, minR)) continue;
      const q = samples[i];
      let r = 0;
      for (const x of RADII) if (x <= bound[i] && !occ.hit(q[0], q[1], q[2], x)) { r = x; break; }
      bound[i] = r;
      if (r < Math.max(minP, minR) || occ.selfHit(q[0], q[1], q[2], r * 0.8)) continue;
      const t = (occ.nearestTime(q[0], q[1], q[2], 0.2 * S) ?? 0) + 0.5;
      if (r >= 0.018 * S && tryPlume([q[0], q[1], q[2]], r * 0.75, r * rand(4, 5.5), 0.62)) continue;
      if (r >= 0.013 * S && rnd() > rosettes && freeCurl(q, r, t)) continue;
      if (r >= 0.0085 * S) {
        const kind = rnd() < 0.6 ? DAISY : FIVE;
        prims.push({ type: ROSETTE, a: [q[0], q[1], q[2]], b: [rand(-1, 1), rand(-1, 1), rand(-1, 1)], R: r - GAP, petals: kind === FIVE ? 5 : Math.floor(rand(9, 14)), layers: kind === FIVE ? 2 : 1, seed: rnd(), kind, ta: t, tb: t + 0.5 });
      } else prims.push({ type: BEAD, a: [q[0], q[1], q[2]], R: (r - GAP) * 0.9, ta: t, tb: t + 0.05 });
      occ.add(q[0], q[1], q[2], r, -1, 0, t);
    }
  return prims;
}
