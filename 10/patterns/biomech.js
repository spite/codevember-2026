// Biomechanical relief, after Giger: spines of vertebrae following flow lines over the blank, each tapering from
// an orifice at its head to a tail, with ribs curving back from its vertebrae into a cage; bundles of corrugated
// hoses run between them, sphincter rings open in the larger spaces, and nodules fill what is left. Growth runs
// down each spine from its head, then out along the ribs and hoses.
import { TUBE, NODULE, SPHINCTER, VERTEBRA, HOSE, BONE, rnd, rand, Occupancy, Walker, surfacePoint, jitteredLattice, createNoise, randomDir } from "../kit.js";

/*
 * opts: scale, seed, flow (how much the spines wander), leafiness (how many vertebrae carry ribs), rosettes (how many
 * orifices), fill (how densely the leftover ground is filled).
 */
export function biomech(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const ribbing = opts.leafiness ?? 0.5;
  const orifices = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const prims = [];
  const occ = new Occupancy(0.025 * S, shape.bounds);
  occ.images = kit.images;
  const GAP = 0.0028 * S;
  let owner = 0;

  const noise3 = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const slope = randomDir();
  const fs = 1.3 / S;
  const lin = (1 - flow) * 2;
  const field = (x, y, z) => noise3(x * fs + off[0], y * fs + off[1], z * fs + off[2]) * (0.4 + flow) + (x * slope[0] + y * slope[1] + z * slope[2]) * lin;
  function flowDir(w) {
    const e = 0.01;
    const [x, y, z] = w.p;
    const g = [(field(x + e, y, z) - field(x - e, y, z)) / (2 * e), (field(x, y + e, z) - field(x, y - e, z)) / (2 * e), (field(x, y, z + e) - field(x, y, z - e)) / (2 * e)];
    const n = w.n;
    const k = g[0] * n[0] + g[1] * n[1] + g[2] * n[2];
    const gt = [g[0] - n[0] * k, g[1] - n[1] * k, g[2] - n[2] * k];
    const l = Math.hypot(gt[0], gt[1], gt[2]);
    if (l < 1e-3) return null;
    return [(n[1] * gt[2] - n[2] * gt[1]) / l, (n[2] * gt[0] - n[0] * gt[2]) / l, (n[0] * gt[1] - n[1] * gt[0]) / l];
  }
  // Follows the flow, keeping to the walker's current sense.
  function follow(w) {
    const d = flowDir(w);
    if (!d) return;
    const s = d[0] * w.d[0] + d[1] * w.d[1] + d[2] * w.d[2] < 0 ? -1 : 1;
    w.setDir([w.d[0] * 0.6 + d[0] * s * 0.4, w.d[1] * 0.6 + d[1] * s * 0.4, w.d[2] * 0.6 + d[2] * s * 0.4]);
  }
  function freeRadius(p, max) {
    if (!occ.hit(p[0], p[1], p[2], max)) return max;
    let lo = 0, hi = max;
    for (let k = 0; k < 8; k++) {
      const m = (lo + hi) / 2;
      if (occ.hit(p[0], p[1], p[2], m)) hi = m;
      else lo = m;
    }
    return lo;
  }
  const nearT = (p) => occ.nearestTime(p[0], p[1], p[2], 0.08 * S) ?? 0;

  // A tube along points [p, r, t], as segments of up to m steps.
  function emitTube(pts, kind, ribs, m) {
    for (let i = 0; i + 1 < pts.length; i += m) {
      const j = Math.min(pts.length - 1, i + m);
      const A = pts[i];
      const B = pts[j];
      prims.push({ type: TUBE, a: A.p.slice(), b: B.p.slice(), ra: A.r, rb: B.r, ribs, s0: A.s, kind, seed: rnd(), ta: A.t, tb: B.t, h: 1 });
    }
  }

  const blocked = (p, r, ...skip) => occ.hit(p[0], p[1], p[2], r, ...skip) || occ.selfHit(p[0], p[1], p[2], r);
  function sphincter(p, R, t, d) {
    if (blocked(p, R + GAP)) return false;
    occ.add(p[0], p[1], p[2], R, owner++, 0, t);
    prims.push({ type: SPHINCTER, a: p.slice(), b: d ?? randomDir(), R, folds: Math.round(rand(4, 7) * Math.sqrt(R / (0.03 * S))) + 4, hole: rand(0.2, 0.34), seed: rnd(), twist: rand(1, 2.5) * (rnd() < 0.5 ? 1 : -1), ta: t, tb: t + R * 3, h: 1 });
    return true;
  }
  function nodule(p, R, t, pore = 0) {
    if (blocked(p, R + GAP)) return false;
    occ.add(p[0], p[1], p[2], R, owner++, 0, t);
    prims.push({ type: NODULE, a: p.slice(), b: randomDir(), R, lumps: R > 0.006 * S ? 2 : 0, pore, seed: rnd(), kind: 1, ta: t, tb: t + R * 3, h: 1 });
    return true;
  }

  // A rib from a vertebra's side, curving back toward the tail and tapering to a point.
  function rib(base, tail, side, r0, maxL, t, spineOwner, spineS) {
    const w = base.clone();
    const sd = w.side();
    w.setDir([sd[0] * side + tail[0] * 0.5, sd[1] * side + tail[1] * 0.5, sd[2] * side + tail[2] * 0.5]);
    const own = owner++;
    const mark = occ.n;
    const pts = [{ p: w.p.slice(), r: r0, t, s: 0 }];
    const h = Math.max(0.004 * S, r0 * 0.8);
    const k = rand(0.6, 1.4) / maxL;
    let s = 0;
    while (s < maxL) {
      const sdn = w.side();
      const toward = tail[0] * sdn[0] + tail[1] * sdn[1] + tail[2] * sdn[2];
      w.step(h, Math.sign(toward) * k * Math.min(1, Math.abs(toward) * 3));
      s += h;
      const r = r0 * (1 - 0.8 * (s / maxL) ** 1.3) + 0.0012 * S;
      if (blocked(w.p, r + GAP, own, s, r0 * 4, spineOwner, spineS, maxL * 0.3 + r0 * 6)) break;
      occ.add(w.p[0], w.p[1], w.p[2], r, own, s, t + s);
      pts.push({ p: w.p.slice(), r, t: t + s, s });
    }
    if (s < r0 * 4) {
      occ.rollback(mark);
      return;
    }
    // A blunt tip: the last point narrows.
    pts[pts.length - 1].r = Math.max(0.0012 * S, pts[pts.length - 1].r * 0.6);
    emitTube(pts, BONE, 0, 2);
  }

  // Spines, from their head (an orifice) down to the tail.
  function spine(q, t0) {
    const w = new Walker(shape, q, [1, 0, 0]);
    const d = flowDir(w) ?? randomDir();
    w.setDir(rnd() < 0.5 ? d : d.map((v) => -v));
    const Wmax = rand(0.032, 0.055) * S;
    const maxLen = rand(0.8, 2) * S;
    const own = owner++;
    const mark = occ.n;
    const head = Wmax * rand(0.9, 1.2);
    // The orifice sits behind the first vertebra.
    const hc = w.clone();
    hc.step(-head * 0.9);
    if (blocked(hc.p, head + GAP) || blocked(w.p, Wmax + GAP)) return false;
    occ.add(hc.p[0], hc.p[1], hc.p[2], head, own, -head, t0);
    const verts = [];
    let s = 0;
    let t = t0 + head;
    for (let i = 0; s < maxLen; i++) {
      const f = s / maxLen;
      const W = Wmax * (0.3 + 0.7 * (1 - f) ** 0.8);
      const L = W * rand(0.46, 0.52);
      if (i > 0) {
        for (let k = 0; k < 4; k++) {
          follow(w);
          w.step(L * 0.5);
        }
      }
      if (blocked(w.p, W * 0.55 + GAP, own, s, W * 3) || occ.selfHit(w.p[0], w.p[1], w.p[2], W)) break;
      occ.add(w.p[0], w.p[1], w.p[2], W * 0.5, own, s, t);
      // The processes' tips.
      for (const sg of [1, -1]) {
        const e = w.offset(sg * W * 0.8);
        occ.add(e.p[0], e.p[1], e.p[2], L * 0.4, own, s, t);
      }
      verts.push({ w: w.clone(), W, L, s, t });
      s += L * 2;
      t += L * 2;
    }
    if (verts.length < (kit.images.length > 6 ? 3 : 4)) {
      occ.rollback(mark);
      return false;
    }
    prims.push({ type: SPHINCTER, a: hc.p.slice(), b: hc.d.slice(), R: head, folds: Math.round(rand(7, 11)), hole: rand(0.22, 0.32), seed: rnd(), twist: rand(1, 2.5) * (rnd() < 0.5 ? 1 : -1), ta: t0, tb: t0 + head * 2, h: 1 });
    // The tail ends small.
    const nv = verts.length;
    for (let i = Math.max(0, nv - 3); i < nv; i++) {
      const k = 1 - (i - (nv - 4)) * 0.18;
      verts[i].W *= k;
      verts[i].L *= k;
    }
    for (const v of verts) {
      const back = v.w.d.map((x) => -x);
      prims.push({ type: VERTEBRA, a: v.w.p.slice(), b: back, L: v.L, W: v.W, kind: 0, seed: rnd(), sweep: rand(0.35, 0.6), ta: v.t, tb: v.t + v.L * 2, h: 1 });
    }
    // Ribs on a run of vertebrae, longest in the middle of the run.
    const r0 = Math.floor(nv * rand(0, 0.25));
    const r1 = Math.min(nv - 2, r0 + Math.ceil(nv * rand(0.35, 0.8) * (0.4 + ribbing)));
    for (let i = r0; i < r1; i++) {
      const v = verts[i];
      const f = (i - r0) / Math.max(1, r1 - r0 - 1);
      const len = v.W * rand(2.5, 4.2) * (0.55 + 0.45 * Math.sin(Math.PI * f));
      for (const sg of [1, -1]) {
        const e = v.w.offset(sg * v.W * 0.85);
        e.step(v.L * 0.45);
        e.setDir(v.w.d);
        rib(e, v.w.d, sg, v.L * 0.3, len, v.t + v.L, own, v.s);
      }
    }
    return true;
  }

  const nSpines = Math.round((shape.area * rand(1.0, 1.6)) / S ** 2 / (1 + kit.images.length));
  for (let i = 0, made = 0; i < nSpines * 6 && made < nSpines; i++) {
    const q = surfacePoint(shape);
    if (spine([q[0], q[1], q[2]], rand(0, 0.2))) made++;
  }

  // Hose bundles along the flow through the space left.
  function hoses(q, rf) {
    const k = rf > 0.03 * S ? Math.floor(rand(2, 5)) : rnd() < 0.6 ? 2 : 1;
    const r = Math.min(rf / (k * 1.2), rand(0.0055, 0.011) * S);
    const half = k * (r + GAP * 0.5);
    const w = new Walker(shape, q, [1, 0, 0]);
    const d = flowDir(w) ?? randomDir();
    w.setDir(rnd() < 0.5 ? d : d.map((v) => -v));
    if (rnd() < 0.5) w.turn(rand(0.6, 1.5) * (rnd() < 0.5 ? 1 : -1));
    const own = owner++;
    const mark = occ.n;
    const t0 = nearT(q);
    const path = [];
    const h = r * 1.2;
    const maxL = rand(0.3, 1.2) * S;
    let s = 0;
    for (;;) {
      if (blocked(w.p, half + GAP, own, s, half * 3)) break;
      occ.add(w.p[0], w.p[1], w.p[2], half, own, s, t0 + s);
      path.push(w.clone());
      if (s > maxL) break;
      follow(w);
      w.turn(rand(-0.15, 0.15));
      w.step(h);
      s += h;
    }
    // Tight symmetry domains only leave room for short runs.
    if (s < half * (kit.images.length > 6 ? 2.5 : 6)) {
      occ.rollback(mark);
      return false;
    }
    const ribs = 1 / (r * rand(0.8, 1.1));
    for (let j = 0; j < k; j++) {
      const o = (j - (k - 1) / 2) * 2 * (r + GAP * 0.5);
      const pts = path.map((pw, i) => {
        const e = o ? pw.offset(o) : pw;
        // Swells to a collar at either end.
        const end = Math.min(i, path.length - 1 - i);
        return { p: e.p, r: r * (end === 0 ? 0.75 : end === 1 ? 1.08 : 1), t: t0 + i * h, s: i * h };
      });
      emitTube(pts, HOSE, ribs, 3);
    }
    return true;
  }

  const lattice = jitteredLattice(shape, 0.008 * S);
  let samples = lattice.slice();
  for (const [minR, what] of [
    [0.045, 0],
    [0.03, 0],
    [0.02, 1],
    [0.013, 1],
    [0.0085, 2],
    [0.006, 2],
  ]) {
    if (what === 2 && fill < 0.2) break;
    const mR = minR * S;
    samples = samples.filter((p) => !occ.hit(p[0], p[1], p[2], 0));
    for (const p of samples) {
      if (occ.hit(p[0], p[1], p[2], mR)) continue;
      const rf = freeRadius(p, 0.08 * S);
      const t = nearT(p) + rf;
      const r = rnd();
      if (what === 0) {
        if (r < 0.05 + orifices * 0.2) sphincter(p, Math.min(rf - GAP, 0.07 * S), t);
        else spine(p, t) || hoses(p, rf);
      } else if (what === 1) {
        if (r < 0.75) hoses(p, rf) || nodule(p, rf - GAP, t);
        else if (r < 0.78 + orifices * 0.15) sphincter(p, rf - GAP, t);
        else nodule(p, rf - GAP, t, rnd() < 0.4 ? rand(0.2, 0.3) : 0);
      } else {
        if (r < 0.35 && rf > 0.007 * S) hoses(p, rf) || nodule(p, rf - GAP, t);
        else if (r < 0.45 && rf > 0.008 * S) sphincter(p, rf - GAP, t);
        else nodule(p, Math.max(0.0025 * S, (rf - GAP) * 0.9), t, rf > 0.007 * S && rnd() < 0.4 ? 0.3 : 0);
      }
    }
  }
  return prims;
}
