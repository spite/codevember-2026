// Brain coral: a labyrinth of rounded ridges of near-constant width, a pitch apart, meandering over the whole blank.
// Ridges are grown by walkers stepping all at once along the surface: each wanders with a smooth noise (so
// neighbours meander alike), hugs the ridge beside it (turning round its end when it runs out, which makes the
// U-turns of brain coral), turns away from what is ahead, and now and then forks into a Y. When they are all stuck,
// every spot still a pitch clear of the ridges seeds a new pair running both ways, parallel to its nearest
// neighbour, so the labyrinth closes up; the wider valleys left get pores. Drawing grows from a few seeds outward.
import { TUBE, NODULE, VEIN, BONE, HOSE, rnd, rand, Occupancy, Walker, jitteredLattice, surfacePoint, createNoise } from "../kit.js";

/*
 * opts: scale, seed, flow (how much the ridges wander), leafiness (the ridges' texture: crested, flat-topped and
 * pulsing, or crossed by septa), rosettes (how often they fork), fill (pores in the wider valleys).
 */
export function coral(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const texture = opts.leafiness ?? 0.5;
  const forks = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const images = kit.images;
  const prims = [];

  const P = 0.03 * S; // pitch: ridge centre to ridge centre
  const R = P * 0.39; // ridge radius
  const H = P * 0.28; // step
  const KMAX = 1 / (0.56 * P); // tightest U-turn
  const WIN = 2.1 * P; // a ridge ignores itself this far back along its length
  const style = texture < 0.34 ? BONE : texture < 0.67 ? VEIN : HOSE;

  const occ = new Occupancy(P, shape.bounds);
  occ.images = images;
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const fk = 0.9 / S;
  const wander = (p) => noise(p[0] * fk + off[0], p[1] * fk + off[1], p[2] * fk + off[2]);

  let ownerId = 0;
  const walkers = [];
  const fronts = [];
  // A front: one end of a ridge, growing. Its discs near a fork are labelled with the parent's, so both ignore them.
  function front(w, own, sg, t, parent = -1, ps = 0) {
    const f = { w, own, sg, s: 0, t, parent, ps, hug: 0, pts: [{ p: w.p.slice(), n: w.n.slice(), d: w.d.slice(), t }], alive: true };
    fronts.push(f);
    walkers.push(f);
    return f;
  }
  // True if a ridge centre is within a pitch of p, besides the front's own recent ones (and, joining, its own images).
  function blocked(p, f, s, join = false) {
    if (!join) return occ.hit(p[0], p[1], p[2], P / 2, f.own, s * f.sg, WIN, f.parent, f.ps, WIN);
    const [i0, i1] = occ.range(p[0], P, 0);
    const [j0, j1] = occ.range(p[1], P, 1);
    const [k0, k1] = occ.range(p[2], P, 2);
    const [dx, dy] = occ.dim;
    const X = occ.x;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = occ.cells[i + dx * (j + dy * k)];
          if (b)
            for (const id of b) {
              const o = id * 6;
              const ow = X[o + 4] % 1e7;
              if ((ow === f.own || ow === f.parent) && X[o + 4] >= 1e7) continue;
              if (ow === f.own && X[o + 4] < 1e7 && Math.abs(X[o + 5] - s * f.sg) < WIN) continue;
              if ((X[o] - p[0]) ** 2 + (X[o + 1] - p[1]) ** 2 + (X[o + 2] - p[2]) ** 2 < P * P) return true;
            }
        }
    return false;
  }
  // How far p is from its nearest symmetry image.
  const toImage = (p) => Math.min(...images.map((m) => Math.hypot(m[0] * p[0] + m[1] * p[1] + m[2] * p[2] - p[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] - p[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] - p[2])));
  const mark = (p, f, t) => {
    const young = f.parent >= 0 && f.s < WIN;
    occ.add(p[0], p[1], p[2], P / 2, young ? f.parent : f.own, young ? f.ps : f.s * f.sg, t);
  };
  // A new ridge at p running both ways, parallel to d.
  function seed(p, d, t) {
    const w = new Walker(shape, p, d);
    if (occ.hit(w.p[0], w.p[1], w.p[2], P / 2) || occ.selfHit(w.p[0], w.p[1], w.p[2], P / 2)) return false;
    const own = ownerId++;
    const a = front(w, own, 1, t);
    const bw = w.clone();
    bw.setDir(w.d.map((v) => -v));
    front(bw, own, -1, t);
    mark(w.p, a, t);
    return true;
  }

  // Distance to the nearest other ridge on each side (left, right), from the discs around.
  function sense(f) {
    const w = f.w;
    const p = w.p;
    const sd = w.side();
    const r = 2.3 * P;
    const [i0, i1] = occ.range(p[0], r, 0);
    const [j0, j1] = occ.range(p[1], r, 1);
    const [k0, k1] = occ.range(p[2], r, 2);
    const [dx, dy] = occ.dim;
    const X = occ.x;
    const own = f.s * f.sg;
    let L = Infinity, Rt = Infinity;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = occ.cells[i + dx * (j + dy * k)];
          if (!b) continue;
          for (let m = 0; m < b.length; m++) {
            const o = b[m] * 6;
            const ow = X[o + 4];
            if (ow === f.own && Math.abs(X[o + 5] - own) < WIN) continue;
            if (ow === f.parent && Math.abs(X[o + 5] - f.ps) < WIN) continue;
            const ex = X[o] - p[0], ey = X[o + 1] - p[1], ez = X[o + 2] - p[2];
            const dd = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (dd > r) continue;
            const lat = ex * sd[0] + ey * sd[1] + ez * sd[2];
            if (lat > 0.25 * dd) L = Math.min(L, dd);
            else if (lat < -0.25 * dd) Rt = Math.min(Rt, dd);
          }
        }
    return [L, Rt];
  }

  function advance(f, c) {
    f.w = c;
    f.s += H;
    f.t += H;
    mark(c.p, f, f.t);
    f.pts.push({ p: c.p.slice(), n: c.n.slice(), d: c.d.slice(), t: f.t });
  }

  function stepFront(f) {
    const w = f.w;
    // Blocked only by its own image across a mirror or axis: run straight on to meet it there.
    if (f.join || (f.stuck && images.length)) {
      const c = w.clone();
      c.step(H, 0);
      const look = c.clone();
      look.step(P * 0.5, 0);
      if (blocked(c.p, f, f.s + H, true) || (!f.join && blocked(look.p, f, f.s + H + P * 0.5, true))) return void (f.alive = false);
      f.join = true;
      advance(f, c);
      if (toImage(c.p) < H * 1.5) f.alive = false;
      return;
    }
    let kp = flow * KMAX * 0.5 * wander(w.p);
    // Keep a pitch from the ridge alongside: round its end when it stops, which makes the U-turns.
    const [L, Rt] = sense(f);
    if (!f.hug || (f.hug > 0 ? L : Rt) > 2.2 * P) f.hug = Math.min(L, Rt) < 2.2 * P ? (L < Rt ? 1 : -1) : 0;
    if (f.hug) {
      const D = f.hug > 0 ? L : Rt;
      kp = kp * 0.3 + f.hug * KMAX * 0.8 * Math.max(-1, Math.min(1, (D - 1.06 * P) / (0.5 * P)));
    }
    kp = Math.max(-KMAX, Math.min(KMAX, kp));
    const dk = KMAX / 3;
    for (let j = 0; j < 9; j++) {
      const k = kp + (j & 1 ? 1 : -1) * Math.ceil(j / 2) * dk;
      if (Math.abs(k) > KMAX * 1.01) continue;
      const c = w.clone();
      c.step(H, k);
      if (blocked(c.p, f, f.s + H)) continue;
      // Looking ahead along the tangent is close enough, and saves a projection.
      const look = [c.p[0] + c.d[0] * P * 0.7, c.p[1] + c.d[1] * P * 0.7, c.p[2] + c.d[2] * P * 0.7];
      if (blocked(look, f, f.s + H + P * 0.7)) continue;
      advance(f, c);
      // A fork: a branch leaves at an angle, the front carries on.
      if (f.s > 3 * P && rnd() < forks * 0.035) {
        const b = c.clone();
        b.turn((rnd() < 0.5 ? 1 : -1) * rand(0.7, 1.0));
        front(b, ownerId++, 1, f.t, f.own, f.s * f.sg);
      }
      return;
    }
    if (images.length) f.stuck = true;
    else f.alive = false;
  }

  function growAll() {
    for (let round = 0; round < 20000; round++) {
      let live = 0;
      for (let i = 0; i < walkers.length; i++) {
        const f = walkers[i];
        if (!f.alive) continue;
        stepFront(f);
        if (f.alive) walkers[live++] = f;
      }
      walkers.length = live;
      if (!live) break;
    }
  }

  // A few first seeds, apart from each other and their images.
  const first = Math.max(1, Math.round(rand(2, 5) / (1 + images.length * 0.5)));
  for (let i = 0, tries = 0; i < first && tries < 200; tries++) {
    const q = surfacePoint(shape);
    if (occ.hit(q[0], q[1], q[2], 0.3 * S)) continue;
    if (seed([q[0], q[1], q[2]], [rand(-1, 1), rand(-1, 1), rand(-1, 1)], rand(0, P * 3))) i++;
  }
  growAll();
  // The nearest ridge centre within r of p: [centre, distance, time].
  function nearest(p, r) {
    const [i0, i1] = occ.range(p[0], r, 0);
    const [j0, j1] = occ.range(p[1], r, 1);
    const [k0, k1] = occ.range(p[2], r, 2);
    const [dx, dy] = occ.dim;
    const X = occ.x;
    let best = null;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = occ.cells[i + dx * (j + dy * k)];
          if (!b) continue;
          for (const id of b) {
            const o = id * 6;
            const dd = Math.hypot(X[o] - p[0], X[o + 1] - p[1], X[o + 2] - p[2]);
            if (dd < r && (!best || dd < best[1])) best = [[X[o], X[o + 1], X[o + 2]], dd, occ.list[id]];
          }
        }
    return best;
  }
  // Batches of new ridges, each started a pitch beside its nearest neighbour and running along it, well apart from
  // the others in the batch, until no spot is left.
  const lattice = jitteredLattice(shape, P * 0.45);
  let samples = lattice;
  for (let batch = 0; batch < 60; batch++) {
    samples = samples.filter((p) => !occ.hit(p[0], p[1], p[2], P / 2));
    const started = [];
    for (const p of samples) {
      if (occ.hit(p[0], p[1], p[2], P / 2) || started.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 6 * P)) continue;
      const nb = nearest(p, 3 * P);
      let q = p;
      let t = 0;
      let d = [rand(-1, 1), rand(-1, 1), rand(-1, 1)];
      if (nb) {
        const [c, dist] = nb;
        const u = [(p[0] - c[0]) / dist, (p[1] - c[1]) / dist, (p[2] - c[2]) / dist];
        const r = shape.project(c[0] + u[0] * 1.06 * P, c[1] + u[1] * 1.06 * P, c[2] + u[2] * 1.06 * P);
        q = [r[0], r[1], r[2]];
        // Along the neighbour: the normal crossed with the way to it.
        d = [r[4] * u[2] - r[5] * u[1], r[5] * u[0] - r[3] * u[2], r[3] * u[1] - r[4] * u[0]];
        t = nb[2] + 1.06 * P;
      }
      const ok = seed(q, d, t) ? q : q !== p && seed(p, d, t) ? p : null;
      // Its images too, so the batch's seeds stay apart across the mirrors.
      if (ok) started.push(ok, ...images.map((m) => [m[0] * ok[0] + m[1] * ok[1] + m[2] * ok[2], m[3] * ok[0] + m[4] * ok[1] + m[5] * ok[2], m[6] * ok[0] + m[7] * ok[1] + m[8] * ok[2]]));
    }
    if (!started.length) break;
    growAll();
  }

  // Ridges: each front's points smoothed on the surface, as tubes that break where the ridge bends.
  const ribs = 1 / (P * 0.3);
  const body = new Occupancy(P * 0.75, shape.bounds);
  body.images = images;
  const tangent = (pts, i) => {
    const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(pts.length - 1, i + 1)].p, n = pts[i].n;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const k = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    const l = Math.hypot(d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k) || 1;
    return [(d[0] - n[0] * k) / l, (d[1] - n[1] * k) / l, (d[2] - n[2] * k) / l];
  };
  for (const f of fronts) {
    let pts = f.pts;
    for (let it = 0; it < 3; it++)
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1].p, b = pts[i].p, c = pts[i + 1].p;
        const r = shape.project((a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4);
        pts[i] = { ...pts[i], p: [r[0], r[1], r[2]], n: [r[3], r[4], r[5]] };
      }
    const rr = (i) => R * (1 + 0.05 * wander(pts[i].p.map((v) => v * 5)));
    for (const q of pts) body.add(q.p[0], q.p[1], q.p[2], R, f.own, 0, q.t);
    if (pts.length < 2) continue;
    let a = 0;
    let s0 = 0;
    while (a < pts.length - 1) {
      // Run on while the ridge is nearly straight, up to a little over a pitch.
      let b = a + 1;
      const da = tangent(pts, a);
      let len = Math.hypot(...pts[b].p.map((v, k) => v - pts[a].p[k]));
      while (b < pts.length - 1 && len < 1.2 * P) {
        const db = tangent(pts, b + 1);
        if (da[0] * db[0] + da[1] * db[1] + da[2] * db[2] < 0.985) break;
        len += Math.hypot(...pts[b + 1].p.map((v, k) => v - pts[b].p[k]));
        b++;
      }
      const A = pts[a], B = pts[b];
      prims.push({ type: TUBE, a: A.p, b: B.p, ra: rr(a), rb: rr(b), ribs: style === HOSE ? ribs : style === VEIN ? (2 * Math.PI) / (1.6 * P) : 0, s0, kind: style, ta: A.t, tb: B.t, h: 0.95 });
      s0 += len;
      a = b;
    }
  }

  // The wider valleys: pores (a cyst with a hole), knobs in the smaller ones.
  if (fill > 0) {
    const GAP = P * 0.14;
    const RADII = [1.2, 0.95, 0.75, 0.6, 0.48].map((r) => r * P);
    for (const p of lattice) {
      if (body.hit(p[0], p[1], p[2], RADII[RADII.length - 1] * 0.5 + GAP)) continue;
      let rf = 0;
      for (const r of RADII) if (!body.hit(p[0], p[1], p[2], r)) {
        rf = r;
        break;
      }
      if (rf < 0.48 * P || rnd() > 0.1 + fill * 0.5) continue;
      const Rn = rf - GAP;
      if (Rn < 0.18 * P || body.selfHit(p[0], p[1], p[2], Rn + GAP / 2)) continue;
      const t = body.nearestTime(p[0], p[1], p[2], P * 2) ?? 0;
      body.add(p[0], p[1], p[2], Rn, ownerId++, 0, t);
      const pore = Rn > 0.3 * P && rnd() < 0.6 + fill * 0.4;
      prims.push({ type: NODULE, a: p.slice(), b: [rand(-1, 1), rand(-1, 1), rand(-1, 1)], R: Rn, lumps: Rn > 0.5 * P ? 3 : 0, pore: pore ? rand(0.3, 0.42) : 0, seed: rnd(), kind: pore ? 2 : 1, ta: t, tb: t + Rn * 3, h: 1 });
    }
  }
  return prims;
}
