// Paisley: big boteh teardrops, each a bulb tapering along a bending spine into a tip that curls over, outlined by
// a raised band with a row of beads and a fillet inside it, and filled with a large flower in the bulb and smaller
// flowers, leaves and beads along the spine. Teardrops are laid largest first wherever they fit (in the tangent
// directions of a smooth field), then every free spot of the ground gets the largest flower, curl or bead that fits.
// Everything is walked along the surface, so it works on any blank; the drawing spreads as a wave from one point.
import { STROKE, LEAF, ROSETTE, BEAD, DAISY, PEONY, FIVE, CHRYS, rnd, rand, norm, Occupancy, Walker, surfacePoint, surfaceLattice, createNoise } from "../kit.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/*
 * opts: scale, flow (how much the teardrops turn from the field), leafiness (leaves along the spines), rosettes
 * (flowers among the fillers), fill (how much small fill goes in the ground), seed.
 */
export function paisley(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const leafiness = opts.leafiness ?? 0.5;
  const rosettes = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const images = kit.images;
  const occ = new Occupancy(0.035 * S, shape.bounds);
  occ.images = images;
  // The motifs inside the teardrops, which the teardrops' own reservations would block.
  const inner = new Occupancy(0.025 * S, shape.bounds);
  inner.images = images;
  const prims = [];
  const GAP = 0.0024 * S;
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const axis = norm([rand(-0.4, 0.4), 1, rand(-0.4, 0.4)]);
  const start = surfacePoint(shape);
  const wave = (p) => dist(p, start) * 6;

  // The direction a teardrop points (from bulb to tip): across a slope, turned by noise.
  function heading(q) {
    const n = [q[3], q[4], q[5]];
    const f = 1.1 / S;
    const a = (noise(q[0] * f + off[0], q[1] * f + off[1], q[2] * f + off[2]) * 2.5 + rand(-1, 1)) * (0.4 + 1.6 * flow);
    let t = cross(n, axis);
    if (Math.hypot(...t) < 0.2) t = cross(n, [1, 0, 0]);
    t = norm(t);
    const s = cross(n, t);
    return [t[0] * Math.cos(a) + s[0] * Math.sin(a), t[1] * Math.cos(a) + s[1] * Math.sin(a), t[2] * Math.cos(a) + s[2] * Math.sin(a)];
  }

  // The teardrop's spine from the bulb's centre, bending to side `hand` ever tighter toward the tip, with its half
  // width there; then its outline. Null if the surface bends too much under it for it to keep its shape.
  function teardrop(q, R, hand) {
    const Ls = R * 2.3;
    const N = 24;
    const h = Ls / N;
    const w = new Walker(shape, [q[0], q[1], q[2]], heading(q));
    const spine = [];
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const hw = R * Math.pow(Math.cos((Math.PI / 2) * s), 1.15) * (1 + 0.12 * Math.sin(Math.PI * s));
      spine.push({ w: w.clone(), hw, s });
      w.step(h, (hand * 2.5 * s * s) / R);
    }
    // Round the back of the bulb: rays from its centre.
    const back = [];
    const w0 = spine[0].w;
    for (let i = 1; i < 12; i++) {
      const a = Math.PI / 2 + (i / 12) * Math.PI;
      const ww = w0.clone();
      ww.turn(a);
      for (let k = 0; k < 6; k++) ww.step(R / 6);
      if (dist(ww.p, w0.p) < R * 0.85) return null;
      back.push(ww.p);
    }
    const left = [];
    const right = [];
    for (const sp of spine) {
      const L = sp.w.offset(sp.hw);
      const Rt = sp.w.offset(-sp.hw);
      if (Math.abs(dist(L.p, sp.w.p) - sp.hw) > sp.hw * 0.2 + 1e-3) return null;
      left.push(L.p);
      right.push(Rt.p);
    }
    // Closed, from the tip down the left side, round the back and up the right side.
    const outline = [...left.slice().reverse(), ...back, ...right];
    if (hand < 0) outline.reverse();
    return { spine, outline, tip: spine[N].w };
  }

  // Corner cutting, projected back onto the surface.
  function smoothen(pts, closed, iters = 2) {
    for (let it = 0; it < iters; it++) {
      const out = closed ? [] : [pts[0]];
      const n = pts.length - (closed ? 0 : 1);
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        for (const f of [0.25, 0.75]) {
          const q = shape.project(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
          out.push([q[0], q[1], q[2]]);
        }
      }
      if (!closed) out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  // Points along a smoothed polyline every `step`.
  function resample(pts, step, closed) {
    pts = smoothen(pts, closed);
    const out = [];
    const all = closed ? [...pts, pts[0]] : pts;
    let carry = 0;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1];
      const b = all[i];
      const l = dist(a, b);
      let x = carry;
      while (x < l) {
        const t = x / l;
        const q = shape.project(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
        out.push([q[0], q[1], q[2]]);
        x += step;
      }
      carry = x - l;
    }
    return out;
  }

  // A raised line along points, as strokes, from time t over dt.
  function line(pts, r, t, dt, closed, rb = r) {
    const n = pts.length - (closed ? 0 : 1);
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const f0 = i / n;
      const f1 = (i + 1) / n;
      prims.push({ type: STROKE, a, b, ra: r + (rb - r) * f0, rb: r + (rb - r) * f1, ta: t + dt * f0, tb: t + dt * f1, h: 1 });
    }
  }

  // The inward offset of a teardrop's outline by `inset`, as a polyline (where the teardrop is wide enough).
  function insetOutline(td, inset, hand) {
    const left = [];
    const right = [];
    for (const sp of td.spine) {
      if (sp.hw < inset * 1.25) break;
      left.push(sp.w.offset(sp.hw - inset).p);
      right.push(sp.w.offset(-(sp.hw - inset)).p);
    }
    const w0 = td.spine[0].w;
    const back = [];
    for (let i = 1; i < 12; i++) {
      const ww = w0.clone();
      ww.turn(Math.PI / 2 + (i / 12) * Math.PI);
      for (let k = 0; k < 6; k++) ww.step((td.spine[0].hw - inset) / 6);
      back.push(ww.p);
    }
    const pts = [...left.slice().reverse(), ...back, ...right];
    if (hand < 0) pts.reverse();
    return pts;
  }

  // The curled tip: a spiral walked on from the spine's end, tightening, as a tapering line ending in a bead.
  function curl(tip, R, hand, r, t) {
    const w = tip.clone();
    const pts = [w.p.slice()];
    let rho = R * 0.42;
    const n = 26;
    for (let i = 0; i < n; i++) {
      const h = (2 * Math.PI * rho * 1.25) / n;
      w.step(h, hand / rho);
      rho *= 0.955;
      pts.push(w.p.slice());
    }
    for (const p of pts.slice(2)) if (occ.hit(p[0], p[1], p[2], r + GAP)) return null;
    return { pts, end: w.p.slice(), r };
  }

  const discsOf = (td, extra) => {
    const out = [];
    for (const sp of td.spine) out.push([...sp.w.p, sp.hw + extra]);
    for (let i = 0; i < td.outline.length; i += 2) out.push([...td.outline[i], extra * 2]);
    return out;
  };

  // Teardrops, largest first.
  const drops = [];
  const SIZES = [0.2, 0.165, 0.135, 0.11, 0.09, 0.072].map((r) => r * S);
  const area = shape.area;
  for (const R of SIZES) {
    const tries = Math.round((area / (R * R)) * 2.2);
    for (let k = 0; k < tries; k++) {
      const q = surfacePoint(shape);
      if (occ.hit(q[0], q[1], q[2], R * 0.9) || occ.selfHit(q[0], q[1], q[2], R * 1.1)) continue;
      const hand = rnd() < 0.5 ? 1 : -1;
      const td = teardrop(q, R, hand);
      if (!td) continue;
      const ro = Math.max(0.0055 * S, R * 0.055);
      const discs = discsOf(td, ro + GAP);
      if (discs.some((d) => occ.hit(d[0], d[1], d[2], d[3]) || occ.selfHit(d[0], d[1], d[2], d[3]))) continue;
      const cu = curl(td.tip, R, hand, ro * 0.85, 0);
      if (!cu) continue;
      if (cu.pts.some((p) => occ.selfHit(p[0], p[1], p[2], ro + GAP))) continue;
      for (const d of discs) occ.add(d[0], d[1], d[2], d[3], -1, 0, 0);
      const t0 = wave(q);
      for (const p of cu.pts) occ.add(p[0], p[1], p[2], cu.r + GAP, -1, 0, t0);
      drops.push({ td, R, hand, ro, t0, cu });
    }
  }

  for (const { td, R, hand, ro, t0, cu } of drops) {
    // The outline from the tip round and back, the curl on from the tip.
    const outline = resample(td.outline, ro * 2.2, true);
    line(outline, ro, t0, 2.2, true);
    line(cu.pts, ro * 0.9, t0 + 2.2, 0.6, false, ro * 0.55);
    prims.push({ type: BEAD, a: cu.end, R: ro * 1.15, ta: t0 + 2.8, tb: t0 + 2.9 });
    for (const p of outline) inner.add(p[0], p[1], p[2], ro + GAP, -1, 0, t0);
    for (const p of cu.pts) inner.add(p[0], p[1], p[2], ro + GAP, -1, 0, t0);
    // A row of beads inside it, then a fillet.
    const br = Math.max(0.0042 * S, R * 0.042);
    const bIn = ro + GAP + br;
    const beads = resample(insetOutline(td, bIn, hand), br * 2 + GAP * 1.2, true);
    beads.forEach((p, i) => {
      const t = t0 + 2.4 + (i / beads.length) * 1.4;
      prims.push({ type: BEAD, a: p, R: br, ta: t, tb: t + 0.05 });
      inner.add(p[0], p[1], p[2], br + GAP, -1, 0, t);
    });
    const rf = ro * 0.55;
    const fIn = bIn + br + GAP + rf;
    const fillet = resample(insetOutline(td, fIn, hand), rf * 3, true);
    if (fillet.length > 6) {
      line(fillet, rf, t0 + 2.8, 1.4, true);
      for (const p of fillet) inner.add(p[0], p[1], p[2], rf + GAP, -1, 0, t0 + 3);
    }
    // A flower in the bulb, then leaves in pairs or flowers along the spine toward the tip.
    const inset = fIn + rf + GAP;
    const c = td.spine[0].w.p;
    const Rb = (R - inset) * rand(0.62, 0.8);
    if (Rb > 0.012 * S) {
      flower(c, Rb, t0 + 3.5, inner, R > 0.12 * S ? PEONY : -1);
      inner.add(c[0], c[1], c[2], Rb + GAP, -1, 0, t0 + 3.5);
    }
    const leaves = rnd() < leafiness;
    for (const sp of td.spine) {
      if (sp.s < 0.25 || sp.s > 0.8) continue;
      const room = sp.hw - inset;
      if (room < 0.012 * S) continue;
      const p = sp.w.p;
      const t = t0 + 3.6 + sp.s * 2;
      if (leaves) {
        for (const side of [1, -1]) {
          const lw = sp.w.clone();
          lw.turn(side * hand * 1.0);
          const L = room * 0.95;
          const W = L * 0.36;
          const tip = lw.clone();
          tip.step(L * 0.6);
          if (inner.hit(tip.p[0], tip.p[1], tip.p[2], W) || inner.hit(p[0], p[1], p[2], W * 0.6)) continue;
          prims.push({ type: LEAF, a: p.slice(), b: lw.d.slice(), L, W, curl: (side * hand * 0.5) / L, lobes: 2, seed: rnd(), ta: t, tb: t + 0.8 });
          inner.add(tip.p[0], tip.p[1], tip.p[2], W, -1, 0, t);
          inner.add(p[0], p[1], p[2], W * 0.6, -1, 0, t);
        }
      } else if (!inner.hit(p[0], p[1], p[2], room * 0.8)) {
        flower(p, room * 0.75, t, inner);
        inner.add(p[0], p[1], p[2], room * 0.75 + GAP, -1, 0, t);
      }
    }
  }

  function flower(p, R, t, o, kind = -1) {
    const big = R > 0.028 * S;
    if (kind < 0) {
      const r = rnd();
      kind = big ? (r < 0.35 ? DAISY : r < 0.6 ? PEONY : r < 0.85 ? CHRYS : FIVE) : r < 0.5 ? DAISY : r < 0.85 ? FIVE : PEONY;
    }
    const petals = kind === DAISY ? Math.floor(rand(big ? 12 : 9, big ? 17 : 13)) : kind === PEONY ? Math.floor(rand(6, 9)) : kind === FIVE ? 5 : Math.floor(rand(14, 20));
    const layers = kind === FIVE ? 2 : kind === DAISY ? (big ? 2 : 1) : big ? 3 : 2;
    prims.push({ type: ROSETTE, a: [p[0], p[1], p[2]], b: [rand(-1, 1), rand(-1, 1), rand(-1, 1)], R, petals, layers, seed: rnd(), kind, ta: t, tb: t + 0.6 });
  }

  // A small curl of a line from a free spot, ending in a bead.
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
    line(pts, lw, t, 0.4, false, lw * 0.7);
    for (const p of pts) occ.add(p[0], p[1], p[2], lw + GAP, -1, 0, t);
    return true;
  }

  // Every free spot inside the teardrops, then of the ground, gets the largest flower (or curl) that fits, or a bead.
  const step = 0.008 * S;
  const samples = surfaceLattice(shape, step);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  const RADII = [0.07, 0.055, 0.042, 0.032, 0.024, 0.018, 0.013, 0.0095, 0.007, 0.005].map((r) => r * S);
  const largest = (o, p, max) => {
    for (const r of RADII) if (r <= max && !o.hit(p[0], p[1], p[2], r)) return r;
    return 0;
  };
  // Passes from large to small, so the widest gaps get the largest motifs.
  const PASSES = [0.032, 0.018, 0.0095, 0].map((r) => r * S);
  // Inside: wherever `inner` is free but `occ` is not (the teardrops reserve their insides).
  const inside = samples.filter((q) => occ.hit(q[0], q[1], q[2], 0) && !occ.selfHit(q[0], q[1], q[2], 0.004 * S));
  // The free radius only shrinks from pass to pass: each sample keeps its last as a bound.
  let bound = new Float64Array(inside.length).fill(0.045 * S);
  for (const minR of PASSES)
    for (let i = 0; i < inside.length; i++) {
      if (bound[i] < minR || !bound[i]) continue;
      const q = inside[i];
      const p = [q[0], q[1], q[2]];
      const r = (bound[i] = largest(inner, p, bound[i]));
      if (!r || r < minR) continue;
      const t = (inner.nearestTime(p[0], p[1], p[2], 0.1 * S) ?? 0) + 0.8;
      if (r >= 0.009 * S) flower(p, r - GAP, t, inner);
      else prims.push({ type: BEAD, a: p, R: (r - GAP) * 0.9, ta: t, tb: t + 0.05 });
      inner.add(p[0], p[1], p[2], r, -1, 0, t);
    }
  // The ground.
  const minR = 0.0055 * S * (1.6 - fill);
  bound = new Float64Array(samples.length).fill(0.07 * S);
  for (const minP of PASSES)
    for (let i = 0; i < samples.length; i++) {
      if (bound[i] < Math.max(minR, minP)) continue;
      const q = samples[i];
      const p = [q[0], q[1], q[2]];
      const r = (bound[i] = largest(occ, p, bound[i]));
      if (r < Math.max(minR, minP) || occ.selfHit(p[0], p[1], p[2], r * 0.8)) continue;
      const t = (occ.nearestTime(p[0], p[1], p[2], 0.2 * S) ?? 0) + 1;
      if (r >= 0.016 * S && rnd() > rosettes * 0.8 + 0.15 && freeCurl(q, r, t)) continue;
      if (r >= 0.0085 * S) flower(p, r - GAP, t, occ);
      else prims.push({ type: BEAD, a: p, R: (r - GAP) * 0.9, ta: t, tb: t + 0.05 });
      occ.add(p[0], p[1], p[2], r, -1, 0, t);
    }
  return prims;
}
