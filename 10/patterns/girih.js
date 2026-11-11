// Girih: the Persian ten-fold strapwork. The plane is tiled with regular decagons on a rhombic lattice, a bowtie in
// each gap, and each decagon carries Hankin's star: two straps leave each edge midpoint at 54° and run until they
// meet their neighbours', so each holds a ten-point star ringed by petals, crossing its neighbours' at shared edges. Laid in framed panels over the blank (panels.js),
// the straps interlace (over and under in turn, by the checkerboard of the regions they bound) and run on under the
// frames; each star gets a rosette or a faceted star, and pellets and small rosettes fill what is left.
import { RIBBON, ROSETTE, ROUNDEL, BEAD, RIBBED, FLAT, DAISY, CHRYS, FIVE, rnd, rand, Occupancy, inDomain, surfaceLattice } from "../kit.js";
import { framedPanels, waveFrom, emitFrames, clipBox, pick } from "./panels.js";
import { sub, add, scale, dot, cross, len } from "./weave.js";

const D2R = Math.PI / 180;
const R10 = 1 / (2 * Math.sin(18 * D2R));
const D10 = 1 / Math.tan(18 * D2R);
const V1 = [D10, 0];
const V2 = [D10 * Math.cos(72 * D2R), D10 * Math.sin(72 * D2R)];
const at = (c, a) => [c[0] + R10 * Math.cos(a * D2R), c[1] + R10 * Math.sin(a * D2R)];
// The radius of the circle inside a decagon's star (edge 1) to its inner corners.
const STAR_IN = R10 - 0.5;

// A decagon's star (edge 1, corners at 18° + 36° k): from each edge midpoint a strap at 54° to the edge toward each
// corner, meeting its neighbour's 0.5 from the corner. Edges 1, 4, 6 and 9 are shared with the next decagons on the
// lattice, where the straps cross; on the others (facing the bowties) the two straps from a midpoint make a point.
const STAR = [];
for (let j = 0; j < 10; j++) {
  const V = at([0, 0], 18 + 36 * j);
  const X = [V[0] * (1 - 0.5 / R10), V[1] * (1 - 0.5 / R10)];
  for (const k of [(j + 9) % 10, j]) {
    const A = at([0, 0], 18 + 36 * k);
    const B = at([0, 0], 18 + 36 * (k + 1));
    STAR.push({ m: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], x: X, u: [B[0] - A[0], B[1] - A[1]], cross: [1, 4, 6, 9].includes(k), edge: k });
  }
}
// The other strap from the same midpoint.
STAR.forEach((s, i) => (s.twin = STAR.findIndex((o, k) => k !== i && o.edge === s.edge)));
// The lobes of the bowtie in each lattice cell, between the four decagons round it.
const LOBES = [
  [at([0, 0], 18), at([0, 0], 54), at(V1, 126), at(V2, 306)],
  [at(V1, 90), at(V2, 342), at(V1, 126), at(V2, 306)],
].map((q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4]);

// The pattern's straps in panel coordinates (edge 1) over the box |x| <= X, |y| <= Y: origin O of the lattice at
// the panel's centre, turned by `rot`. Each strap: { p (midpoint end), q (meeting end), u (edge), partner (at q),
// twin (at p), cross }.
function planarGirih(X, Y, O, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const T = (p) => [(p[0] - O[0]) * c - (p[1] - O[1]) * s, (p[0] - O[0]) * s + (p[1] - O[1]) * c];
  const Tv = (v) => [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  const reach = Math.hypot(X, Y) + 2 * R10;
  const K = Math.ceil(reach / (D10 * Math.sin(72 * D2R))) + 2;
  const straps = [];
  const stars = [];
  const petals = [];
  const lobes = [];
  for (let i = -K; i <= K; i++)
    for (let j = -K; j <= K; j++) {
      const L = [i * V1[0] + j * V2[0], i * V1[1] + j * V2[1]];
      const cL = T(L);
      if (Math.abs(cL[0]) > X + 2.5 * R10 || Math.abs(cL[1]) > Y + 2.5 * R10) continue;
      stars.push(cL);
      for (let k = 0; k < 10; k++) petals.push(T(at(L, 18 + 36 * k)));
      for (const q of LOBES) lobes.push(T([q[0] + L[0], q[1] + L[1]]));
      const base = straps.length;
      STAR.forEach((st, k) => straps.push({ p: T([st.m[0] + L[0], st.m[1] + L[1]]), q: T([st.x[0] + L[0], st.x[1] + L[1]]), u: Tv(st.u), partner: base + (k ^ 1), twin: base + st.twin, cross: st.cross }));
    }
  return { straps, stars, petals, lobes };
}

// Which of the two colours of the pattern's regions p lies in: the parity of the straps crossed on the way from a
// point near the centre.
function parity(straps, p) {
  const o = [0.0123, 0.0071];
  let k = 0;
  for (const st of straps) {
    const a = st.p;
    const b = st.q;
    const d1 = (b[0] - a[0]) * (o[1] - a[1]) - (b[1] - a[1]) * (o[0] - a[0]);
    const d2 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (d1 > 0 === d2 > 0) continue;
    const d3 = (p[0] - o[0]) * (a[1] - o[1]) - (p[1] - o[1]) * (a[0] - o[0]);
    const d4 = (p[0] - o[0]) * (b[1] - o[1]) - (p[1] - o[1]) * (b[0] - o[0]);
    if (d3 > 0 !== d4 > 0) k++;
  }
  return k & 1;
}

/*
 * opts: scale, flow (how many stars a panel holds), rosettes (rosettes rather than faceted stars), fill, seed.
 */
export function girih(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const rosettes = opts.rosettes ?? 0.5;
  // The tiles' edge on the blank, and the panels' size in lattice spacings. A blank whose grid is fixed (or capped)
  // keeps its panels, and the stars are sized to them.
  const E0 = 0.07 * S * rand(0.92, 1.08);
  const across = 1.25 + 1.5 * flow;
  const P = framedPanels(shape, E0 * D10 * across, kit.images);
  const size = P.panels.reduce((s, p) => s + Math.sqrt(p.Lu * p.Lv), 0) / (P.panels.length || 1);
  const E = Math.max(0.75 * E0, Math.min(1.4 * E0, size / (D10 * across)));
  // Panels too small for a lattice of stars hold one star each.
  const single = size < D10 * E * 1.1;
  const images = P.images;
  const dom = (p) => inDomain(p, images);
  const prims = [];
  const occ = new Occupancy(0.03 * S, shape.bounds);
  occ.images = images;
  const GAP = 0.0022 * S;
  const w = E * rand(0.1, 0.125);
  const wf = w * 1.35;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const wave = waveFrom(shape);
  const when = (p) => wave(p) * 3;
  let owner = emitFrames(prims, P, { w: wf, kind: rnd() < 0.7 ? RIBBED : FLAT, boss: wf * 1.7, gap: GAP, occ, when, images });
  // One layout for every panel: the lattice centred on a star or on a bowtie, either way up.
  const O = rnd() < 0.7 ? [0, 0] : [(V1[0] + V2[0]) / 2, (V1[1] + V2[1]) / 2];
  const rot = -36 * D2R + (rnd() < 0.5 ? Math.PI / 2 : 0);
  const starKind = rnd() < rosettes ? "rosette" : "roundel";
  const petals = pick([DAISY, CHRYS, FIVE]);
  const pearls = rnd() < 0.5 ? 1 : 0;

  for (const pn of P.panels) {
    if (!pn.own) continue;
    const t0 = when(pn.c) + 0.15;
    const at3 = (x, y) => {
      const q = pn.map(0.5 + (x * E) / pn.Lu, 0.5 + (y * E) / pn.Lv);
      return { p: [q[0], q[1], q[2]], n: [q[3], q[4], q[5]] };
    };
    const tAt = (p) => t0 + dist(p, pn.c) * 3;
    // Contents its stabilizer can't leave alone (it turns the panel a quarter), or a panel too small for the
    // lattice: one turned medallion.
    if (pn.quarter || single) {
      let R = Math.min(pn.Lu, pn.Lv) * 0.5 - wf - GAP * 2;
      while (R > 0.01 * S && occ.hit(pn.c[0], pn.c[1], pn.c[2], R + GAP)) R *= 0.9;
      if (R > 0.01 * S) {
        occ.add(pn.c[0], pn.c[1], pn.c[2], R, owner++, 0, t0);
        prims.push({ type: ROUNDEL, a: pn.c.slice(), b: pn.ex.slice(), R, points: single && !pn.quarter ? 10 : pick([8, 12, 16]), kind: 0, seed: rnd(), pearls: 1, ta: t0, tb: t0 + 0.6, h: 1 });
      }
      continue;
    }
    const X = pn.Lu / (2 * E);
    const Y = pn.Lv / (2 * E);
    const { straps, stars, petals: petalPts, lobes } = planarGirih(X, Y, O, rot);
    const keep = (p) => !pn.fixed || dom(p);
    for (const st of straps) {
      const cl = clipBox(st.p, st.q, X, Y);
      if (!cl || cl[1] - cl[0] < 1e-3) continue;
      const d = [st.q[0] - st.p[0], st.q[1] - st.p[1]];
      const A = [st.p[0] + d[0] * cl[0], st.p[1] + d[1] * cl[0]];
      const B = [st.p[0] + d[0] * cl[1], st.p[1] + d[1] * cl[1]];
      const pa = at3(A[0], A[1]);
      const pb = at3(B[0], B[1]);
      const mid = scale(add(pa.p, pb.p), 0.5);
      if (!keep(mid)) continue;
      const chord = sub(pb.p, pa.p);
      const L = len(chord);
      if (L < w * 0.5) continue;
      const ux = scale(chord, 1 / L);
      // Mitred where it meets its partner or its twin at a point, run on a little through a crossing, cut square
      // under the frame.
      const mitre = (d, e) => {
        const cosT = Math.max(-1, Math.min(1, (d[0] * e[0] + d[1] * e[1]) / (Math.hypot(...d) * Math.hypot(...e))));
        return Math.max(w * 0.2, Math.min(w * Math.tan(Math.acos(cosT) / 2), w * 3));
      };
      let extA = 0;
      if (cl[0] === 0) {
        const o = straps[st.twin];
        extA = st.cross ? w * 0.25 : mitre([st.p[0] - o.q[0], st.p[1] - o.q[1]], d);
      }
      let extB = 0;
      if (cl[1] === 1) {
        const o = straps[st.partner];
        extB = mitre(d, [o.p[0] - st.q[0], o.p[1] - st.q[1]]);
      }
      let a = sub(pa.p, scale(ux, extA));
      let b = add(pb.p, scale(ux, extB));
      // The crossing at the midpoint: over where the region clockwise of the strap's way out is the first colour.
      let c = pa.p;
      let rc = 0;
      let sag = 0;
      if (cl[0] === 0 && st.cross) {
        const dl = Math.hypot(...d);
        const dd = [d[0] / dl, d[1] / dl];
        const k = Math.cos(-30 * D2R);
        const s = Math.sin(-30 * D2R);
        const probe = [st.p[0] + 0.05 * (dd[0] * k - dd[1] * s), st.p[1] + 0.05 * (dd[0] * s + dd[1] * k)];
        const over = parity(straps, probe) === 0;
        // The other strap through the midpoint, mirrored in the edge's normal.
        const du = dd[0] * st.u[0] + dd[1] * st.u[1];
        const d2 = [dd[0] - 2 * du * st.u[0], dd[1] - 2 * du * st.u[1]];
        const cdir = sub(at3(st.p[0] + 0.05 * d2[0], st.p[1] + 0.05 * d2[1]).p, at3(st.p[0] - 0.05 * d2[0], st.p[1] - 0.05 * d2[1]).p);
        const ey = cross(pa.n, ux);
        sag = Math.atan2(dot(cdir, ey), dot(cdir, ux));
        // A panel on a mirror can't interlace (the mirror swaps over and under): its straps just meet.
        if (!pn.mirror) rc = over ? -w : w + GAP;
      }
      const ta = tAt(pa.p);
      const tb = tAt(pb.p);
      // Drawn outward from the panel's centre.
      if (tb < ta) [a, b] = [b, a];
      const id = owner++;
      const m = Math.max(1, Math.ceil(L / w));
      for (let j = 0; j <= m; j++) {
        const x = add(pa.p, scale(chord, j / m));
        occ.add(x[0], x[1], x[2], w + GAP, id, 0, tAt(x));
      }
      prims.push({ type: RIBBON, a, b, w: -w, sag, c: c.slice(), rc, ta: Math.min(ta, tb), tb: Math.max(ta, tb), h: 1, flipSag: true });
    }
    // A rosette or a faceted star in each star, shrunk to what the frame leaves.
    for (const sc of stars) {
      if (Math.abs(sc[0]) > X || Math.abs(sc[1]) > Y) continue;
      const { p } = at3(sc[0], sc[1]);
      if (!keep(p)) continue;
      let R = STAR_IN * E - w - GAP;
      while (R > 0.008 * S && occ.hit(p[0], p[1], p[2], R + GAP)) R *= 0.9;
      if (R <= 0.008 * S) continue;
      const t = tAt(p) + 0.3;
      occ.add(p[0], p[1], p[2], R, owner++, 0, t);
      // Turned so its points face the star's.
      const ax = sub(at3(sc[0] + 0.1 * Math.cos(rot), sc[1] + 0.1 * Math.sin(rot)).p, p);
      if (starKind === "rosette") prims.push({ type: ROSETTE, a: p, b: ax, R, petals: 10, layers: 2, seed: rnd(), kind: petals, ta: t, tb: t + 0.4 });
      else prims.push({ type: ROUNDEL, a: p, b: ax, R: R * 1.05, points: 10, kind: 0, seed: rnd(), pearls, ta: t, tb: t + 0.4, h: 1 });
    }
    // A pellet in each petal and each lobe of the bowties, as large as fits.
    for (const sc of [...petalPts, ...lobes]) {
      if (Math.abs(sc[0]) > X || Math.abs(sc[1]) > Y) continue;
      const { p } = at3(sc[0], sc[1]);
      if (!keep(p)) continue;
      let R = E * 0.24;
      while (R > 0.005 * S && occ.hit(p[0], p[1], p[2], R + GAP)) R *= 0.9;
      if (R <= 0.005 * S) continue;
      const t = tAt(p) + 0.35;
      occ.add(p[0], p[1], p[2], R, owner++, 0, t);
      prims.push({ type: BEAD, a: p.slice(0, 3), R: R * 0.9, ta: t, tb: t + 0.01 });
    }
  }

  // Last, every free spot: a pellet.
  const step = 0.011 * S;
  const samples = surfaceLattice(shape, step).filter(dom);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  const RADII = [0.0075, 0.006, 0.0048].map((r) => r * S);
  for (const minR of [0.0075, 0.0065 - 0.002 * fill].map((r) => r * S)) {
    for (const p of samples) {
      if (occ.hit(p[0], p[1], p[2], minR)) continue;
      let rf = 0;
      for (const r of RADII)
        if (!occ.hit(p[0], p[1], p[2], r)) {
          rf = r;
          break;
        }
      if (rf < minR) continue;
      const t = (occ.nearestTime(p[0], p[1], p[2], E * 3) ?? 0) + 0.2;
      const R = rf - GAP;
      occ.add(p[0], p[1], p[2], R, owner++, 0, t);
      prims.push({ type: BEAD, a: p.slice(0, 3), R: R * 0.85, ta: t, tb: t + 0.01 });
    }
  }
  prims.whole = !P.mesh.symmetric;
  return prims;
}
