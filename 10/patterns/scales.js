// Imbricated scales, as on a fish, a dragon or the snake of a chased silver handle: rows along the level lines of a
// smooth field on the surface, each scale overlapping the bases of the two rows downstream of it. The field is a
// slope plus noise, folded by the symmetry (a soft maximum over the images), so the rows meet in chevrons at the
// mirror planes. Each row is traced as a contour, its scales spaced evenly and shifted half a step from the row
// before. A boss and pellets fill the sources and sinks where the rows close up.
import { SCALE, ROSETTE, BEAD, DAISY, PEONY, CHRYS, rnd, rand, norm, Occupancy, applyImage, createNoise } from "../kit.js";
import { Grid, levelField } from "./levels.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/*
 * opts: scale, flow (how much the rows wander), fill (bosses and pellets where rows close), lobes (picks the kind
 * together with the seed), seed.
 */
export function scales(shape, opts, kit, style) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const images = kit.images;
  // Kinds: 0 round (fish), 1 pointed (dragon), 2 small and keeled (snake), 3 seigaiha (concentric waves, by style).
  const picked = Math.floor(rnd() * 3);
  const kind = style ?? picked;
  const D = S * (kind === 3 ? 0.088 : kind === 2 ? 0.049 : 0.058) * rand(0.9, 1.12);
  const Dr = D * (kind === 1 ? 0.56 : 0.5);
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const axis = norm([rand(-0.5, 0.5), 1, rand(-0.5, 0.5)]);
  const amp = 0.06 + 0.3 * flow;
  const nf = 1.3 / S;
  const { field, toLevel, sample, trace: traceLevel, arcs, at, dom, boundary, onMirror } = levelField(shape, images, { axis, amp, nf, noise, off });

  // Samples over the surface, for seeding the rows.
  const step = Math.min(D * 0.7, 0.04 * S);
  const { samples, vMax, vMin, gMed } = sample(step);

  const H = D * 0.4;
  const trace = (q, l, taken) => traceLevel(q, l, taken, H);

  const prims = [];
  const placed = new Grid(D * 1.2);
  const occ = new Occupancy(0.03 * S, shape.bounds);
  const GAP = 0.002 * S;
  // Scores a candidate set of positions: the half-step stagger keeps them away from the row before.
  const score = (ps) => ps.reduce((acc, p) => acc + Math.min(placed.nearest(p, (v) => v.p)[0], D), 0);
  function addScale(p, spacing, rowIndex) {
    const q = shape.project(p[0], p[1], p[2]);
    const n = [q[3], q[4], q[5]];
    const [, g] = field(p, n);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    const b = [-g[0] / gl, -g[1] / gl, -g[2] / gl];
    const W = Math.min(spacing, D * 1.6) * (kind === 1 ? 0.53 : 0.5);
    const L = W + Dr * 1.85;
    const t = rowIndex + rand(0, 0.4);
    prims.push({ type: SCALE, a: p, b, L, W, Dr, kind, seed: rnd(), ta: t, tb: t + 1.6 });
    placed.add(p, { p });
    const tip = [p[0] + b[0] * (L - W), p[1] + b[1] * (L - W), p[2] + b[2] * (L - W)];
    occ.add(tip[0], tip[1], tip[2], W, -2, 0, t);
  }
  // Points of the rows laid so far (and their images), so a new row starts only a row spacing below them.
  const lines = new Grid(Dr * 1.1);
  const addLine = (p) => {
    lines.add(p);
    for (const m of images) lines.add(applyImage(m, p));
  };
  const gapTo = (p) => lines.nearest(p)[0];
  // Positions over a row: evenly around a closed loop, or along each run that is free and in the domain, ending on
  // the domain's boundary (a mirror takes a scale on it, or a half step) or where the row is not free.
  function placeRow(pts, closed, t) {
    const n = pts.length;
    const inDom = pts.map(dom);
    // A row goes down where most of it is a row spacing below the last; the rest of it may come a little closer,
    // which bunches the rows there rather than breaking them.
    const gap = pts.map(gapTo);
    const flags = pts.map((p, i) => inDom[i] && gap[i] >= Dr * 0.6);
    const ready = (idx) => idx.filter((i) => gap[i] >= Dr * 0.92).length >= idx.length * 0.6;
    if (closed && flags.every((x) => x)) {
      if (!ready(pts.map((_, i) => i))) return;
      const s = arcs(pts, closed);
      const total = s[s.length - 1];
      const count = Math.round(total / D);
      if (count < 5) return;
      const sp = total / count;
      let best = null;
      let bestScore = -1;
      for (let c = 0; c < 6; c++) {
        const ph = (c / 6) * sp;
        const ps = Array.from({ length: count }, (_, i) => at(pts, s, ph + i * sp));
        const sc = score(ps);
        if (sc > bestScore) (bestScore = sc), (best = ps);
      }
      for (const p of best) addScale(p, sp, t);
      pts.forEach(addLine);
      return;
    }
    let start = 0;
    if (closed) start = Math.max(0, flags.findIndex((x) => !x));
    const order = Array.from({ length: n }, (_, i) => (start + i) % n);
    let run = [];
    const flush = () => {
      if (run.length < 3 || !ready(run)) return void (run = []);
      const rp = run.map((i) => pts[i]);
      const i0 = run[0];
      const i1 = run[run.length - 1];
      const prevI = (i0 + n - 1) % n;
      const nextI = (i1 + 1) % n;
      let mirror0 = false;
      let mirror1 = false;
      if ((closed || i0 > 0) && !inDom[prevI]) {
        const b = boundary(pts[i0], pts[prevI]);
        rp.unshift(b);
        mirror0 = onMirror(b);
      }
      if ((closed || i1 < n - 1) && !inDom[nextI]) {
        const b = boundary(pts[i1], pts[nextI]);
        rp.push(b);
        mirror1 = onMirror(b);
      }
      run = [];
      const rs = arcs(rp, false);
      const L = rs[rs.length - 1];
      if (L < D * 0.6) return;
      const count = Math.max(1, Math.round(L / D));
      const sp = L / count;
      let best = null;
      let bestScore = -1;
      for (const ph of [0, 0.5]) {
        const ps = [];
        for (let i = 0; i <= count; i++) {
          const x = (i + ph) * sp;
          if (x > L + 1e-9) break;
          if (i === count && ph === 0 && !mirror1) break;
          if (i === 0 && ph === 0 && !mirror0 && mirror1) continue;
          ps.push(at(rp, rs, x));
        }
        const sc = score(ps) - (ps.length ? 0 : 1);
        if (sc > bestScore) (bestScore = sc), (best = ps);
      }
      for (const p of best) addScale(p, sp, t);
      rp.forEach(addLine);
    };
    for (const i of order) {
      if (flags[i]) run.push(i);
      else flush();
    }
    flush();
  }

  // Levels from the top of the field down, a quarter row apart: each part of a level line gets a row once it is a
  // row spacing from the last, so the rows keep their spacing however the field's slope varies.
  let l = vMax - Dr * gMed * 0.3;
  let t = 0;
  for (let guard = 0; guard < 4000 && l > vMin; guard++) {
    const rowGrid = new Grid(H * 2);
    const taken = (p) => rowGrid.nearest(p)[0] < H * 0.8;
    const gsRow = [];
    for (const smp of samples) {
      if (Math.abs(smp.v - l) > smp.g * step * 0.75) continue;
      if (taken(smp.p)) continue;
      const q = toLevel(smp.p, l);
      if (!q || taken([q[0], q[1], q[2]])) continue;
      const { pts, closed } = trace(q, l, taken);
      for (const p of pts) rowGrid.add(p);
      if (pts.length < 3) continue;
      for (const p of pts.filter((_, i) => i % 6 === 0)) {
        const qq = shape.project(p[0], p[1], p[2]);
        gsRow.push(Math.hypot(...field(p, [qq[3], qq[4], qq[5]])[1]));
      }
      placeRow(pts, closed, t);
    }
    gsRow.sort((a, b) => a - b);
    // The steepest part of the level sets the step, so no part skips a row.
    const g = gsRow.length ? gsRow[Math.floor(gsRow.length * 0.9)] : gMed;
    l -= Dr * 0.3 * Math.max(g, gMed * 0.1);
    t += 0.3;
  }

  // The scales whose rims cross each one's free edge, as offsets of their tip circles from its own in units of its
  // width (along, across): it is cut back a gap from those rims, so the ground shows in crescents between them.
  const tip = (p) => [p.a[0] + p.b[0] * (p.L - p.W), p.a[1] + p.b[1] * (p.L - p.W), p.a[2] + p.b[2] * (p.L - p.W)];
  let maxW = 0;
  for (const p of prims) maxW = Math.max(maxW, p.W);
  const tips = new Grid(maxW * 2.2);
  for (const p of prims) {
    const t = tip(p);
    tips.add(t, t);
    for (const m of images) {
      const ti = applyImage(m, t);
      tips.add(ti, ti);
    }
  }
  for (const p of prims) {
    const T = tip(p);
    const q = shape.project(p.a[0], p.a[1], p.a[2]);
    const n = [q[3], q[4], q[5]];
    const b = p.b;
    const side = [n[1] * b[2] - n[2] * b[1], n[2] * b[0] - n[0] * b[2], n[0] * b[1] - n[1] * b[0]];
    const found = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const cell = tips.map.get(tips.key(T, i, j, k));
          if (!cell) continue;
          for (const o of cell) {
            const e = sub(o, T);
            const du = dot(e, b) / p.W;
            const dv = dot(e, side) / p.W;
            const r = Math.hypot(du, dv);
            if (du < -0.25 && r < 2.1 && du > -3.4 && Math.abs(dv) < 1.9) found.push([r, du, dv]);
          }
        }
    found.sort((x, y) => x[0] - y[0]);
    p.nb = found.slice(0, 3).map(([, du, dv]) => [du, dv]);
    // With nothing straight above, it is cut as if there were, and the hole gets a pellet, not a long tongue.
    if (!p.nb.some(([du, dv]) => du < -1.2 && Math.abs(dv) < 0.7)) {
      if (p.nb.length === 3) p.nb.pop();
      p.nb.push([(-2 * Dr) / p.W, 0]);
    }
  }

  // Bosses where the rows close up, and pellets in what is left.
  occ.images = images;
  const fillSamples = samples.filter((s) => dom(s.p));
  for (let i = fillSamples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [fillSamples[i], fillSamples[j]] = [fillSamples[j], fillSamples[i]];
  }
  const RADII = [0.16, 0.12, 0.09, 0.07, 0.05, 0.036, 0.026, 0.018, 0.012].map((r) => r * S);
  for (const smp of fillSamples) {
    const p = smp.p;
    let rf = 0;
    for (const r of RADII)
      if (!occ.hit(p[0], p[1], p[2], r)) {
        rf = r;
        break;
      }
    if (rf < 0.012 * S) continue;
    const R = rf * 1.12 - GAP;
    const t = (occ.nearestTime(p[0], p[1], p[2], 0.2) ?? 0) + 0.5;
    occ.add(p[0], p[1], p[2], R, -1, 0, t);
    if (R > 0.03 * S) prims.push({ type: ROSETTE, a: p, b: [1, 0, 0], R, petals: 8 + Math.floor(rnd() * 6), layers: R > 0.06 * S ? 3 : 2, seed: rnd(), kind: [DAISY, PEONY, CHRYS][Math.floor(rnd() * 3)], ta: t, tb: t + 2 });
    else prims.push({ type: BEAD, a: p, R: R * 0.85, ta: t, tb: t + 0.2 });
  }
  return prims;
}
