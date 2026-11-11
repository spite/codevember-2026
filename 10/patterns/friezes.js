// Friezes: the blank turned into bands of classical mouldings, as on a chased beaker. The bands follow the level
// lines of a slope plus noise (the scales' rows, folded by the symmetry), wide ones (egg-and-dart, a running wave,
// a guilloche) alternating with narrow bead-and-reel, each between fillets. A band is laid along a level line once
// that is half its height plus half the last one's from the bands before, as units spaced evenly along it, so it
// breaks where the levels crowd; a rosette or bead fills whatever is left, at the poles and band ends.
import { FRIEZE, ROSETTE, BEAD, EGG, REEL, WAVE, CABLE, DAISY, PEONY, CHRYS, rnd, rand, norm, Occupancy, applyImage, surfaceLattice, createNoise } from "../kit.js";
import { Grid, levelField } from "./levels.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The bands' field: on tubes they go round them, as arc length along a knot's curve, or across a torus' tube from its
// inner equator; elsewhere they are rings round the axis, by the angle from it (so even on a ball, and concentric on
// a box's top).
function bandSlope(shape, axis) {
  if (shape.curve && shape.nearest) {
    const per = shape.length / (2 * Math.PI);
    const c = [0, 0, 0], d1 = [0, 0, 0], d2 = [0, 0, 0];
    return ([x, y, z]) => {
      let i = shape.nearest(x, y, z);
      if (i < 0) shape.bruteNearest(x, y, z, 4), (i = shape.far);
      let t = (i / shape.samples) * 2 * Math.PI;
      for (let it = 0; it < 4; it++) {
        shape.curve(t, c, d1, d2);
        const ex = c[0] - x, ey = c[1] - y, ez = c[2] - z;
        const fp = d2[0] * ex + d2[1] * ey + d2[2] * ez + d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
        const st = (d1[0] * ex + d1[1] * ey + d1[2] * ez) / Math.max(fp, 1e-9);
        t -= st;
        if (Math.abs(st) < 1e-7) break;
      }
      return (((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * per;
    };
  }
  if (shape.R !== undefined && shape.r !== undefined) return ([x, y, z]) => (Math.atan2(y, Math.hypot(x, z) - shape.R) + Math.PI) * shape.r;
  return (p) => -Math.atan2(Math.hypot(...cross(p, axis)), dot(p, axis));
}

// Cuts a traced line where it doubles back onto itself (a trace stuck where the field's slope vanishes).
function untangle({ pts, closed }, H) {
  const seen = new Grid(H);
  for (let i = 0; i < pts.length; i++) {
    const [d, k] = seen.nearest(pts[i], (v) => pts[v]);
    if (d < H * 0.5 && i - k > 3) return { pts: pts.slice(0, i), closed: false };
    seen.add(pts[i], i);
  }
  return { pts, closed };
}

/*
 * opts: scale, flow (how much the bands wander), rosettes (rosettes rather than beads in the gaps), fill (how densely
 * the gaps are filled), seed.
 */
export function friezes(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const rosettes = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const images = kit.images;
  // Narrower bands on a thin tube.
  const B = 0.056 * S * rand(0.9, 1.1) * (shape.curve ? Math.min(1, shape.r / 0.22) : 1);
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const axis = norm([rand(-0.3, 0.3), 1, rand(-0.3, 0.3)]);
  // The tubes' symmetries map their rings onto rings: no folding needed (nor its cost).
  const tube = !!shape.curve || (shape.R !== undefined && shape.r !== undefined);
  const lf = levelField(shape, images, { axis, amp: 0.02 + 0.3 * flow, nf: 1 / S, noise, off, slope: bandSlope(shape, axis), fold: !tube });
  const { field, toLevel, arcs, at, dom, boundary, onMirror } = lf;
  const { samples, vMax, vMin, gMed } = lf.sample(Math.min(B * 0.6, 0.04 * S));
  const gMax = samples.reduce((m, s) => Math.max(m, s.g), 0);

  // The wide bands in a shuffled order, a narrow bead-and-reel between each two.
  const wide = [EGG, WAVE, CABLE].sort(() => rnd() - 0.5);
  const kindOf = (r) => (r % 2 ? REEL : wide[(r >> 1) % 3]);
  const HALF = { [EGG]: B, [WAVE]: B * 0.92, [CABLE]: B * 0.95, [REEL]: B * 0.5 };
  // Unit length over half height.
  const ASPECT = { [EGG]: 1.5, [WAVE]: 2.5, [CABLE]: 2.3, [REEL]: 2.5 };

  const prims = [];
  const occ = new Occupancy(0.03 * S, shape.bounds);
  const GAP = 0.002 * S;
  // Centre lines of the bands laid so far (and their images), with their half heights.
  const lines = new Grid(B * 2.4);
  const addLine = (p, hb) => {
    lines.add(p, { p, hb });
    for (const m of images) lines.add(applyImage(m, p), { p: applyImage(m, p), hb });
  };
  // Distance from p to the edge of the nearest band.
  const gapTo = (p) => {
    const [d, e] = lines.nearest(p, (v) => v.p);
    return e ? d - e.hb : Infinity;
  };

  function addUnit(pts, s, x, sp, hb, kind, t) {
    const p = at(pts, s, x);
    const e = Math.min(sp * 0.25, 0.01);
    const p0 = at(pts, s, x - e);
    const p1 = at(pts, s, x + e);
    const q = shape.project(p[0], p[1], p[2]);
    const n = [q[3], q[4], q[5]];
    let b = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const bn = dot(b, n);
    b = norm([b[0] - n[0] * bn, b[1] - n[1] * bn, b[2] - n[2] * bn]);
    // The motif's up (+y) toward the bands above, whose field is higher.
    const [, g] = field(p, n);
    const twist = dot(cross(n, b), g) >= 0 ? 1 : -1;
    prims.push({ type: FRIEZE, a: p, b, B: hb, P: sp, kind, seed: rnd(), twist, ta: t, tb: t + 0.25 });
    for (const k of [-1, 0, 1]) {
      const c = shape.project(p[0] + b[0] * k * sp * 0.3, p[1] + b[1] * k * sp * 0.3, p[2] + b[2] * k * sp * 0.3);
      occ.add(c[0], c[1], c[2], Math.hypot(sp * 0.22, hb) * 1.02, -1, 0, t);
    }
  }

  // Units over a band: evenly round a closed loop, or along each run that is in the domain and clear of the bands
  // before; a run ending on the domain's boundary ends on a seam there, so the images carry the band on. A band goes
  // down once most of its line is clear; where the line comes closer to the bands before, the run is squeezed.
  function placeBand(pts, closed, kind, r) {
    const hb = HALF[kind];
    const P = hb * ASPECT[kind];
    const n = pts.length;
    const inDom = pts.map(dom);
    const gap = pts.map(gapTo);
    const inside = pts.map((_, i) => i).filter((i) => inDom[i]);
    if (inside.filter((i) => gap[i] >= hb * 0.97).length < inside.length * 0.75) return false;
    const flags = pts.map((p, i) => inDom[i] && gap[i] >= hb * 0.55);
    const t0 = r * 1.2;
    // Units at x0 + (i + 0.5) sp along rp, all as high as the clearance allows (so their fillets line up).
    const lay = (rp, rg, rs, x0, sp, count) => {
      const h = Math.max(hb * 0.55, Math.min(hb, ...rg));
      for (let i = 0; i < count; i++) addUnit(rp, rs, x0 + (i + 0.5) * sp, sp, h, kind, t0 + i / count);
      rp.forEach((p) => addLine(p, h));
    };
    if (closed && flags.every((x) => x)) {
      const s = arcs(pts, true);
      const total = s[s.length - 1];
      const count = Math.round(total / P);
      if (count < 4) return false;
      lay(pts, gap, s, 0, total / count, count);
      return true;
    }
    let placed = false;
    let start = 0;
    if (closed) start = Math.max(0, flags.findIndex((x) => !x));
    const order = Array.from({ length: n }, (_, i) => (start + i) % n);
    let run = [];
    const flush = () => {
      if (run.length < 3) return void (run = []);
      const rp = run.map((i) => pts[i]);
      const rg = run.map((i) => gap[i]);
      const i0 = run[0];
      const i1 = run[run.length - 1];
      run = [];
      if ((closed || i0 > 0) && !inDom[(i0 + n - 1) % n]) {
        rp.unshift(boundary(pts[i0], pts[(i0 + n - 1) % n]));
        rg.unshift(rg[0]);
      }
      if ((closed || i1 < n - 1) && !inDom[(i1 + 1) % n]) {
        rp.push(boundary(pts[i1], pts[(i1 + 1) % n]));
        rg.push(rg[rg.length - 1]);
      }
      const rs = arcs(rp, false);
      const L = rs[rs.length - 1];
      const count = Math.floor(L / P + 0.3);
      if (count < 1) return;
      const sp = Math.min(L / count, P * 1.2);
      // Centred on the run, unless one end is on a mirror (its seam goes there).
      const x0 = onMirror(rp[0]) ? 0 : onMirror(rp[rp.length - 1]) ? L - count * sp : (L - count * sp) / 2;
      lay(rp, rg, rs, x0, sp, count);
      placed = true;
    };
    for (const i of order) {
      if (flags[i]) run.push(i);
      else flush();
    }
    flush();
    return placed;
  }

  // Levels from the top of the field down, in small steps: each part of a level line gets a band once it is clear
  // of the bands before. The next band's kind (and so its height) is the next in the sequence.
  const H = B * 0.3;
  // A line longer than a few times round the blank is a trace stuck going back and forth.
  const maxSteps = Math.ceil((10 * Math.max(...shape.bounds)) / H);
  let l = vMax - B * gMed * 0.5;
  let r = 0;
  for (let guard = 0; guard < 4000 && l > vMin; guard++) {
    const kind = kindOf(r);
    const rowGrid = new Grid(H * 2);
    const taken = (p) => rowGrid.nearest(p)[0] < H * 0.8;
    let any = false;
    const gsRow = [];
    // The samples are sorted by value, highest first: only those within reach of the level.
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (samples[m].v > l + gMax * B * 0.45) lo = m + 1;
      else hi = m;
    }
    for (let k = lo; k < samples.length && samples[k].v >= l - gMax * B * 0.45; k++) {
      const smp = samples[k];
      if (Math.abs(smp.v - l) > smp.g * B * 0.45) continue;
      if (taken(smp.p)) continue;
      // A line is only laid once mostly clear: start tracing it only from where it is.
      if (gapTo(smp.p) < HALF[kind] * 0.9) continue;
      const q = toLevel(smp.p, l);
      if (!q || taken([q[0], q[1], q[2]])) continue;
      const { pts, closed } = untangle(lf.trace(q, l, taken, H, maxSteps), H);
      for (const p of pts) rowGrid.add(p);
      if (pts.length < 3) continue;
      for (const p of pts.filter((_, i) => i % 6 === 0)) {
        const qq = shape.project(p[0], p[1], p[2]);
        gsRow.push(Math.hypot(...field(p, [qq[3], qq[4], qq[5]])[1]));
      }
      if (placeBand(pts, closed, kind, r)) any = true;
    }
    if (any) r++;
    gsRow.sort((a, b) => a - b);
    const g = gsRow.length ? gsRow[Math.floor(gsRow.length * 0.9)] : gMed;
    l -= B * 0.2 * Math.max(g, gMed * 0.1);
  }

  // Rosettes and beads in what is left, largest first.
  occ.images = images;
  const fillSamples = surfaceLattice(shape, Math.min(B * 0.3, 0.013 * S)).filter((q) => dom(q));
  for (let i = fillSamples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [fillSamples[i], fillSamples[j]] = [fillSamples[j], fillSamples[i]];
  }
  const RADII = [0.16, 0.12, 0.09, 0.07, 0.05, 0.036, 0.026, 0.018, 0.013, 0.009].map((x) => x * S);
  const minR = 0.009 * S * (1.6 - fill);
  const tEnd = r * 1.2;
  for (const q of fillSamples) {
    const p = [q[0], q[1], q[2]];
    let rf = 0;
    for (const x of RADII)
      if (!occ.hit(p[0], p[1], p[2], x)) {
        rf = x;
        break;
      }
    if (rf < minR || occ.selfHit(p[0], p[1], p[2], rf * 0.5)) continue;
    const R = rf - GAP;
    occ.add(p[0], p[1], p[2], rf, -1, 0, tEnd);
    if (R > 0.02 * S && rnd() < 0.4 + rosettes * 0.6)
      prims.push({ type: ROSETTE, a: p, b: [1, 0, 0], R, petals: 8 + Math.floor(rnd() * 8), layers: R > 0.05 * S ? 3 : 2, seed: rnd(), kind: [DAISY, PEONY, CHRYS][Math.floor(rnd() * 3)], ta: tEnd, tb: tEnd + 1 });
    else prims.push({ type: BEAD, a: p, R: R * 0.85, ta: tEnd, tb: tEnd + 0.2 });
  }
  return prims;
}
