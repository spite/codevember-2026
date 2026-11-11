// Art Nouveau: a few long whiplash stems sweep over the blank (contour lines of a slow noise, kept far apart, each
// end lashing into a tight volute), carrying irises, poppies and lily pads on long S-curved stalks and slender
// blades that sweep along them. What is left is filled sparingly, largest first (smaller flowers and buds on
// stalks from the nearest stem, blades, thin tendrils), so the matted ground shows between: airy where the
// rinceau is dense.
import { STROKE, ARC, BEAD, BLADE, BLOOM, LANCE, PAD, POPPY, IRIS, CLOSED, rnd, rand, Occupancy, Walker, randomDir, surfacePoint, jitteredLattice, createNoise, forward } from "../kit.js";

/*
 * opts: scale, seed, flow (how much the stems sway), leafiness (blades and pads), rosettes (flowers), fill (how much
 * of the leftover ground is filled).
 */
export function nouveau(shape, opts, kit) {
  const images = kit.images;
  // A small fundamental domain (high symmetry) takes smaller motifs, or the big flowers never fit inside it.
  const S = (opts.scale ?? 1) * Math.max(0.75, Math.min(1, Math.sqrt(shape.area / (1 + images.length) / 1.2)));
  const flow = opts.flow ?? 0.5;
  const leafiness = opts.leafiness ?? 0.5;
  const flowers = opts.rosettes ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const prims = [];

  const GAP = 0.0065 * S;
  const occ = new Occupancy(0.04 * S, shape.bounds);
  occ.images = images;
  // Points along every stem and stalk, where later motifs can branch off.
  const stems = new Occupancy(0.06 * S, shape.bounds);
  const addStemPt = (w, width, t, owner, s) => stems.add(w.p[0], w.p[1], w.p[2], 0, owner, s, { w: w.clone(), width, t, owner, s });
  let ownerId = 0;
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Stems as circular arcs (or straight strokes) through each start point with its start tangent.
  function stemBuilder(p, n, d, width, t) {
    let A = p.slice(), An = n.slice(), Ad = d.slice(), Aw = width, At = t;
    let turn = 0, len = 0, last = null;
    function emit(B, Bw, Bt) {
      const ab = sub3(B, A);
      const l2 = dot3(ab, ab);
      const side = [An[1] * Ad[2] - An[2] * Ad[1], An[2] * Ad[0] - An[0] * Ad[2], An[0] * Ad[1] - An[1] * Ad[0]];
      const ds = dot3(ab, side);
      if (Math.abs(turn) < 0.03 || Math.abs(ds) < 1e-7) prims.push(forward({ type: STROKE, a: A, b: B.slice(), ra: Aw, rb: Bw, ta: At, tb: Bt, h: 1 }));
      else {
        const rho = l2 / (2 * ds);
        prims.push(forward({ type: ARC, a: A, b: B.slice(), c: [A[0] + side[0] * rho, A[1] + side[1] * rho, A[2] + side[2] * rho], ra: Aw, rb: Bw, ta: At, tb: Bt, h: 1 }));
      }
    }
    return {
      add(w, width, t, k, h) {
        turn += k * h;
        len += h;
        last = [w.p.slice(), w.n.slice(), w.d.slice(), width, t];
        if (Math.abs(turn) > 0.7 || len > 0.1 * S) {
          emit(w.p, width, t);
          [A, An, Ad, Aw, At] = last;
          turn = 0;
          len = 0;
          last = null;
        }
      },
      finish() {
        if (last) emit(last[0], last[3], last[4]);
      },
    };
  }
  // Lays a walked path ([walker, s, k, width]) as a stem from walker w0 at time t (occupied: its discs are in).
  function commitPath(w0, pts, own, t, h, occupied = false) {
    const stem = stemBuilder(w0.p, w0.n, w0.d, pts[0][3], t);
    for (const [q, s, k, width] of pts) {
      if (!occupied) occ.add(q.p[0], q.p[1], q.p[2], width, own, s, t + s);
      addStemPt(q, width, t + s, own, s);
      stem.add(q, width, t + s, k, h);
    }
    stem.finish();
  }

  // A blade from walker w (its base, pointing along d), bent by curl; shrinks to fit, or fails.
  function blade(w, L, W, curl, t, parent, sNode) {
    for (let attempt = 0; attempt < 3; attempt++, L *= 0.78, W *= 0.8, curl /= 0.78) {
      if (L < 0.035 * S) return false;
      const ww = w.clone();
      const pts = [];
      let ok = true;
      for (let i = 1; i <= 7 && ok; i++) {
        ww.step(L / 7, curl);
        const u = i / 7;
        const hw = W * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.85) + 0.002 * S;
        if (occ.hit(ww.p[0], ww.p[1], ww.p[2], hw + GAP, parent, sNode, W * 3 + L * u) || occ.selfHit(ww.p[0], ww.p[1], ww.p[2], hw)) ok = false;
        pts.push([ww.p[0], ww.p[1], ww.p[2], hw]);
      }
      if (!ok) continue;
      const id = ownerId++;
      for (const p of pts) occ.add(p[0], p[1], p[2], p[3], id, 0, t + L);
      prims.push({ type: BLADE, kind: LANCE, a: w.p.slice(), b: w.d.slice(), L, W, curl, twist: rnd() < 0.5 ? 1 : -1, ta: t, tb: t + L * 1.3 });
      return true;
    }
    return false;
  }

  // A flower head (a BLOOM kind, or "pad") at the end of walker w, along its direction; false if it doesn't fit.
  function head(w, kind, size, t, owner, s) {
    const win = size * 1.5;
    if (kind === POPPY || kind === "pad") {
      const R = kind === POPPY ? size * 0.5 : size * 0.55;
      const e = kind === POPPY ? R * 0.95 : R * 0.88;
      const c = shape.project(w.p[0] + w.d[0] * e, w.p[1] + w.d[1] * e, w.p[2] + w.d[2] * e);
      if (occ.hit(c[0], c[1], c[2], R + GAP, owner, s, win) || occ.selfHit(c[0], c[1], c[2], R)) return false;
      occ.add(c[0], c[1], c[2], R, ownerId++, 0, t);
      if (kind === POPPY) prims.push({ type: BLOOM, kind: POPPY, a: [c[0], c[1], c[2]], b: w.d.slice(), L: R, W: 0, seed: rnd(), petals: 4, ta: t, tb: t + R * 5 });
      else prims.push({ type: BLADE, kind: PAD, a: [c[0], c[1], c[2]], b: w.d.slice(), L: R, W: R, ta: t, tb: t + R * 3 });
      return true;
    }
    // Iris or bud: discs along its axis, wide where the falls hang.
    const L = kind === IRIS ? size : size * 0.5;
    const W = L * 0.32;
    const ww = w.clone();
    const discs = [];
    for (const [u, r] of kind === IRIS ? [[0.3, 0.44], [0.62, 0.34], [0.86, 0.18]] : [[0.25, 0.3], [0.55, 0.32], [0.82, 0.22]]) {
      const q = ww.clone();
      q.step(u * L, 0);
      if (occ.hit(q.p[0], q.p[1], q.p[2], r * L + GAP, owner, s, win) || occ.selfHit(q.p[0], q.p[1], q.p[2], r * L)) return false;
      discs.push([q.p, r * L]);
    }
    const id = ownerId++;
    for (const [p, r] of discs) occ.add(p[0], p[1], p[2], r, id, 0, t);
    prims.push({ type: BLOOM, kind, a: w.p.slice(), b: w.d.slice(), L, W, seed: rnd(), petals: kind === IRIS ? 5 : 3, ta: t, tb: t + L * 2 });
    return true;
  }

  // A long stalk peeling off a stem at walker w and swaying in an S (its curvature swings from one side to the
  // other), with a flower, pad or bud at its end.
  function flowerStalk(w, width, t, parent, sParent, side, kind, size, Ls) {
    const sw = Math.max(0.0018 * S, width * 0.7);
    for (let attempt = 0; attempt < 4; attempt++, size *= 0.87, Ls *= 0.85) {
      const own = ownerId++;
      const base = w.offset(side * width * 0.6);
      base.turn(side * rand(0.35, 0.75));
      let ww = base.clone();
      const k0 = (side * rand(0, 4)) / S;
      const k1 = (-side * rand(2, 7)) / S;
      const h = 0.005 * S;
      const pts = [];
      let s = 0;
      // Blocked past halfway, the stalk just ends there.
      while (s < Ls) {
        const k = k0 + (k1 - k0) * (s / Ls);
        const c = ww.clone();
        c.step(h, k);
        if (occ.hit(c.p[0], c.p[1], c.p[2], sw + GAP, own, s + h, sw * 4, parent, sParent, width * 4 + sw * 10)) break;
        ww = c;
        s += h;
        pts.push([ww.clone(), s, k, sw * (1 - 0.3 * (s / Ls))]);
      }
      if (s < Ls * 0.45 || !pts.length) continue;
      const tf = t + s;
      const n0 = occ.n;
      // The path goes in first so the head keeps clear of it; both are taken back if the head doesn't fit.
      for (const [q, s2, , wd] of pts) occ.add(q.p[0], q.p[1], q.p[2], wd, own, s2, tf);
      if (!head(ww, kind, size, tf, own, s)) {
        occ.rollback(n0);
        continue;
      }
      commitPath(base, pts, own, t, h, true);
      // A spathe: a small blade clasping the stalk below an iris or bud.
      if ((kind === IRIS || kind === CLOSED) && rnd() < 0.7) {
        const b = ww.clone();
        b.setDir(b.d.map((v) => -v));
        b.step(size * 0.12, 0);
        b.setDir(b.d.map((v) => -v));
        b.turn(side * rand(0.3, 0.5));
        blade(b, size * rand(0.45, 0.6), size * 0.08, (-side * rand(3, 8)) / S, tf, own, s);
      }
      return true;
    }
    return false;
  }

  // A spray of blades from walker w, sweeping along the stem: one long, one or two shorter.
  function spray(w, width, t, parent, sParent, side, L) {
    const base = w.offset(side * width * 0.6);
    base.turn(side * rand(0.25, 0.6));
    const narrow = rnd() < 0.4;
    const ratio = () => (narrow ? rand(0.08, 0.1) : rand(0.14, 0.19));
    const curl = (-side * rand(1.5, 5)) / S;
    if (!blade(base.clone(), L, L * ratio(), curl, t, parent, sParent)) return false;
    for (const [a, f] of [[0.55, 0.65], [-0.45, 0.5]]) {
      if (rnd() < 0.35) continue;
      const b = base.clone();
      b.turn(side * a);
      const l = L * f * rand(0.85, 1.1);
      blade(b, l, l * ratio(), (-Math.sign(a) * side * rand(2, 7)) / S, t + L * 0.2, parent, sParent);
    }
    return true;
  }

  // A volute: the curvature tightens from 1/r0 to 1/rEnd over L, until blocked.
  function volute(w, w0, w1, L, sign, r0, rEnd, t, parent, parentS) {
    const own = ownerId++;
    const ww = w.clone();
    const h = 0.004 * S;
    const pts = [];
    let s = 0;
    while (s < L) {
      const f = s / L;
      const k = sign / (r0 * (1 - f) + rEnd * f);
      const width = w0 + (w1 - w0) * f;
      ww.step(h, k);
      s += h;
      if (occ.hit(ww.p[0], ww.p[1], ww.p[2], width + GAP * 0.7, own, s, width * 4 + h * 3, parent, parentS, w0 * 10)) break;
      if (occ.selfHit(ww.p[0], ww.p[1], ww.p[2], width + GAP * 0.5)) break;
      pts.push([ww.clone(), s, k, width]);
    }
    if (s < L * 0.3 || !pts.length) return false;
    commitPath(w, pts, own, t, h);
    // A knob at the eye.
    const e = pts[pts.length - 1][0];
    const br = pts[pts.length - 1][3] * 1.5;
    if (!occ.hit(e.p[0], e.p[1], e.p[2], br + GAP * 0.4, own, s, br * 6)) {
      occ.add(e.p[0], e.p[1], e.p[2], br, own, s, t + s);
      prims.push({ type: BEAD, a: e.p.slice(), R: br, ta: t + s, tb: t + s + br * 4 });
    }
    return true;
  }

  // The whiplashes: contour lines of a slow noise (plus a slope, for sweeps), grown all at once, far apart.
  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const slope = randomDir();
  const fs = 0.8 / S;
  const lin = (1 - flow) * 1.4;
  const field = (x, y, z) => noise(x * fs + off[0], y * fs + off[1], z * fs + off[2]) * (0.5 + flow) + 0.25 * flow * noise(x * fs * 2.3 - off[1], y * fs * 2.3, z * fs * 2.3 + off[0]) + (x * slope[0] + y * slope[1] + z * slope[2]) * lin;
  function flowDir(w) {
    const e = 0.01;
    const [x, y, z] = w.p;
    const g = [(field(x + e, y, z) - field(x - e, y, z)) / (2 * e), (field(x, y + e, z) - field(x, y - e, z)) / (2 * e), (field(x, y, z + e) - field(x, y, z - e)) / (2 * e)];
    const n = w.n;
    const k = dot3(g, n);
    const gt = [g[0] - n[0] * k, g[1] - n[1] * k, g[2] - n[2] * k];
    const l = Math.hypot(gt[0], gt[1], gt[2]);
    if (l < 1e-3) return null;
    return [(n[1] * gt[2] - n[2] * gt[1]) / l, (n[2] * gt[0] - n[0] * gt[2]) / l, (n[0] * gt[1] - n[1] * gt[0]) / l];
  }

  const DSEP = 0.25 * S;
  const H = 0.009 * S;
  const sep = new Occupancy(DSEP, shape.bounds);
  sep.images = images;
  const seedCount = Math.max(4, Math.round((shape.area / (DSEP * DSEP)) * 0.3));
  const lines = [];
  for (let i = 0; i < seedCount; i++) lines.push({ id: i, seed: new Walker(shape, surfacePoint(shape), [1, 0, 0]), delay: Math.floor(rand(0, 60)), fronts: null, started: false, dead: false });
  let activeFronts = 0;
  for (let round = 0; round < 2000; round++) {
    let pending = 0;
    for (const line of lines) {
      if (line.dead) continue;
      if (!line.started) {
        if (round < line.delay) {
          pending++;
          continue;
        }
        line.started = true;
        const d = flowDir(line.seed);
        const p = line.seed.p;
        if (!d || sep.hit(p[0], p[1], p[2], DSEP * 0.5) || sep.selfHit(p[0], p[1], p[2], DSEP * 0.5)) {
          line.dead = true;
          continue;
        }
        line.seed.setDir(d);
        line.round = round;
        sep.add(p[0], p[1], p[2], DSEP * 0.5, line.id, 0, round);
        line.fronts = [1, -1].map((sg) => ({ sg, w: line.seed.clone(), pts: [], s: 0, active: true }));
        activeFronts += 2;
        continue;
      }
      for (const f of line.fronts) {
        if (!f.active) continue;
        const probe = f.w.clone();
        const d = flowDir(probe);
        const s = f.s + H;
        if (d) {
          probe.setDir([d[0] * f.sg, d[1] * f.sg, d[2] * f.sg]);
          probe.step(H, 0);
        }
        const p = probe.p;
        if (!d || sep.hit(p[0], p[1], p[2], DSEP * 0.5, line.id, s * f.sg, DSEP * 2) || s > 3.5 * S) {
          f.active = false;
          activeFronts--;
          continue;
        }
        sep.add(p[0], p[1], p[2], DSEP * 0.5, line.id, s * f.sg, round);
        f.w = probe;
        f.s = s;
        f.pts.push({ p: p.slice(), n: probe.n.slice(), d: probe.d.slice(), round });
      }
    }
    if (!activeFronts && !pending) break;
  }

  const W_MAIN = 0.0088 * S;
  const anchors = [];
  const ends = [];
  const at = (q) => {
    const w = Object.create(Walker.prototype);
    w.shape = shape;
    w.p = q.p.slice();
    w.n = q.n.slice();
    w.d = q.d.slice();
    return w;
  };
  for (const line of lines) {
    if (!line.fronts) continue;
    const [fw, bw] = line.fronts;
    const s0 = line.seed;
    const path = [...bw.pts.slice().reverse(), { p: s0.p.slice(), n: s0.n.slice(), d: s0.d.slice(), round: line.round }, ...fw.pts];
    if ((path.length - 1) * H < 0.3 * S) continue;
    for (let it = 0; it < 6; it++)
      for (let i = 1; i < path.length - 1; i++) {
        const a = path[i - 1].p, b = path[i].p, c = path[i + 1].p;
        const r = shape.project((a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4);
        path[i] = { ...path[i], p: [r[0], r[1], r[2]], n: [r[3], r[4], r[5]] };
      }
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)].p, b = path[Math.min(path.length - 1, i + 1)].p, n = path[i].n;
      const d = sub3(b, a);
      const k = dot3(d, n);
      const l = Math.hypot(d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k) || 1;
      path[i].d = [(d[0] - n[0] * k) / l, (d[1] - n[1] * k) / l, (d[2] - n[2] * k) / l];
    }
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)].d, b = path[Math.min(path.length - 1, i + 1)].d, n = path[i].n;
      path[i].k = dot3([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], n) / (2 * H);
    }
    const owner = ownerId++;
    const width = (i) => W_MAIN * (0.5 + 0.5 * Math.sin(Math.PI * (i / (path.length - 1))));
    const time = (q) => q.round * H * 1.2;
    const stem = stemBuilder(path[0].p, path[0].n, path[0].d, width(0), time(path[0]));
    let next = rand(0.05, 0.12) * S;
    let side = rnd() < 0.5 ? 1 : -1;
    for (let i = 0; i < path.length; i++) {
      const q = path[i];
      occ.add(q.p[0], q.p[1], q.p[2], width(i), owner, i * H, time(q));
      if (i % 2 === 0) addStemPt(at(q), width(i), time(q), owner, i * H);
      if (i === 0) continue;
      stem.add(at(q), width(i), time(q), q.k, H);
      if (i * H >= next && i < path.length - 4) {
        anchors.push([at(q), width(i), time(q), owner, i * H, side, rnd()]);
        side = -side;
        next += rand(0.08, 0.14) * S;
      }
    }
    stem.finish();
    ends.push([path[path.length - 1], path.length - 1, 1, owner, width], [path[0], 0, -1, owner, width]);
  }
  // Each end lashes on into a volute, curling the way the line already turns.
  for (const [q, i, dirSign, owner, width] of ends) {
    const w = at(q);
    if (dirSign < 0) w.setDir(q.d.map((v) => -v));
    const k = q.k * dirSign;
    const sg = Math.abs(k) > 0.5 ? Math.sign(k) : rnd() < 0.5 ? 1 : -1;
    const ww = Math.max(width(i), W_MAIN * 0.5);
    for (const sign of [sg, -sg]) if (volute(w, ww, ww * 0.55, rand(0.12, 0.22) * S, sign, rand(0.035, 0.06) * S, ww * 2, q.round * H * 1.2, owner, i * H)) break;
  }
  // The big motifs on long stalks and blade sprays, in random order along the stems.
  const flowerKind = () => {
    const r = rnd();
    return r < 0.45 ? IRIS : r < 0.85 ? POPPY : CLOSED;
  };
  // Flowers first, so they get the room; then blade sprays and pads at the anchors left.
  anchors.sort((a, b) => a[6] - b[6]);
  const rest = [];
  for (const anchor of anchors) {
    const [w, width, t, owner, s, side] = anchor;
    const kind = flowerKind();
    const size = (kind === POPPY ? rand(0.11, 0.15) : kind === IRIS ? rand(0.11, 0.15) : rand(0.09, 0.12)) * S;
    if (rnd() < flowers * 0.8 && flowerStalk(w, width, t, owner, s, side, kind, size, rand(0.07, 0.17) * S)) continue;
    rest.push(anchor);
  }
  for (const [w, width, t, owner, s, side] of rest) {
    const r = rnd();
    if (r < leafiness * 0.3 && flowerStalk(w, width, t, owner, s, side, "pad", rand(0.09, 0.13) * S, rand(0.04, 0.1) * S)) continue;
    if (r < 0.2 + leafiness * 0.7) spray(w, width, t, owner, s, side, rand(0.12, 0.22) * S);
  }

  // Fillers: each free spot, largest first, gets a motif sized to it on a stalk from the nearest stem.
  function stalkTo(p, reach, before, sw0) {
    const cands = stems.near(p[0], p[1], p[2], reach).sort((a, b) => a[0] - b[0]);
    for (let ci = 0; ci < Math.min(4, cands.length); ci++) {
      const c = cands[ci][1];
      const v = sub3(p, c.w.p);
      const cw = c.w.clone();
      if (dot3(v, cw.d) < 0 && rnd() < 0.6) cw.d = cw.d.map((x) => -x);
      const sv = dot3(v, cw.side());
      const ang = Math.atan2(Math.abs(sv), dot3(v, cw.d));
      if (ang < 0.15 || ang > 2.0) continue;
      const side = sv >= 0 ? 1 : -1;
      const sw = Math.max(0.0014 * S, Math.min(sw0, c.width * 0.7));
      const own = ownerId++;
      const base = cw.offset(side * c.width * 0.5);
      const ww = base.clone();
      ww.turn(side * Math.min(ang * 0.6, 0.5));
      const h = 0.005 * S;
      const pts = [];
      let s = 0;
      let ok = false;
      for (let it = 0; it < 80; it++) {
        const v2 = sub3(p, ww.p);
        const dist = Math.hypot(v2[0], v2[1], v2[2]);
        if (dist <= before + h * 0.5) {
          ok = true;
          break;
        }
        // Turns gently toward the spot, so stalks sweep rather than kink.
        const a2 = Math.max(-0.25, Math.min(0.25, Math.atan2(dot3(v2, ww.side()), dot3(v2, ww.d)) * 0.5));
        const st = Math.min(h, dist - before);
        ww.step(st, a2 / st);
        s += st;
        if (occ.hit(ww.p[0], ww.p[1], ww.p[2], sw + GAP, own, s, sw * 4, c.owner, c.s, c.width * 4 + sw * 8)) break;
        pts.push([ww.clone(), s, a2 / st, sw]);
      }
      if (!ok || !pts.length) continue;
      return { w: ww, base, pts, own, sw, c, s, t: c.t + s, h };
    }
    return null;
  }
  function attach(p, rf, kind) {
    if (kind === "lance") {
      const L = Math.min(0.16 * S, rf * rand(2.4, 3));
      const st = stalkTo(p, L + 0.05 * S, L * 0.45, 0.002 * S);
      if (!st) return false;
      const n0 = occ.n;
      for (const [q, s2, , wd] of st.pts) occ.add(q.p[0], q.p[1], q.p[2], wd, st.own, s2, st.t);
      const ok = blade(st.w, L, L * rand(0.13, 0.18), ((rnd() < 0.5 ? 1 : -1) * rand(1, 5)) / S, st.t, st.own, st.s);
      if (!ok) occ.rollback(n0);
      else commitPath(st.base, st.pts, st.own, st.c.t, st.h, true);
      return ok;
    }
    const size = kind === POPPY ? rf * 2 - GAP * 2 : kind === "pad" ? (rf - GAP) / 0.55 : kind === IRIS ? rf * 1.9 : rf * 3;
    const st = stalkTo(p, size + 0.08 * S, size * (kind === IRIS || kind === CLOSED ? 0.35 : 0.5), 0.0022 * S);
    if (!st) return false;
    const n0 = occ.n;
    for (const [q, s2, , wd] of st.pts) occ.add(q.p[0], q.p[1], q.p[2], wd, st.own, s2, st.t);
    const ok = head(st.w, kind, size, st.t, st.own, st.s);
    if (!ok) {
      occ.rollback(n0);
      return false;
    }
    commitPath(st.base, st.pts, st.own, st.c.t, st.h, true);
    return true;
  }
  // A thin tendril from the nearest stem, lashing into a curl.
  function tendril(p, rf) {
    const st = stalkTo(p, rf * 2 + 0.05 * S, rf * 0.9, 0.0018 * S);
    if (!st) return false;
    commitPath(st.base, st.pts, st.own, st.c.t, st.h);
    const v = sub3(p, st.w.p);
    const sg = dot3(v, st.w.side()) >= 0 ? 1 : -1;
    volute(st.w, st.sw, st.sw * 0.6, rf * rand(2.5, 3.5), sg, rf * 0.8, st.sw * 2, st.t, st.own, st.s);
    return true;
  }

  // Where no stem reaches: an S-shaped whiplash of its own, which later motifs can branch from.
  function freeStem(p, rf) {
    const w = new Walker(shape, p, [1, 0, 0]);
    const d = flowDir(w) ?? randomDir();
    w.setDir(d);
    if (occ.hit(w.p[0], w.p[1], w.p[2], W_MAIN + GAP * 2)) return false;
    const t = (occ.nearestTime(p[0], p[1], p[2], 0.3 * S) ?? 0) + rf;
    const sign = rnd() < 0.5 ? 1 : -1;
    const first = ownerId;
    let ok = false;
    for (const sg of [1, -1]) {
      const ww = w.clone();
      if (sg < 0) ww.setDir(d.map((v) => -v));
      ok = volute(ww, W_MAIN * 0.7, W_MAIN * 0.45, rf * rand(2.5, 3.5), sign * sg, rf * rand(2, 3), rf * 0.35, t, sg < 0 ? first : -1, 0) || ok;
    }
    return ok;
  }

  // Nothing could reach the spot: a flower, pad or blade on its own.
  function loose(p, rf) {
    const t = (occ.nearestTime(p[0], p[1], p[2], 0.3 * S) ?? 0) + rf;
    const w = new Walker(shape, p, [1, 0, 0]);
    w.setDir(flowDir(w) ?? randomDir());
    if (rf >= 0.045 * S) {
      const R = rf - GAP;
      if (occ.hit(p[0], p[1], p[2], rf) || occ.selfHit(p[0], p[1], p[2], R)) return false;
      occ.add(p[0], p[1], p[2], R, ownerId++, 0, t);
      if (rnd() < 0.4 + flowers * 0.4) prims.push({ type: BLOOM, kind: POPPY, a: p.slice(), b: w.d.slice(), L: R, W: 0, seed: rnd(), petals: 4, ta: t, tb: t + R * 5 });
      else prims.push({ type: BLADE, kind: PAD, a: p.slice(), b: w.d.slice(), L: R, W: R, ta: t, tb: t + R * 3 });
      return true;
    }
    const L = rf * 2.4;
    const b = w.clone();
    b.setDir(w.d.map((v) => -v));
    b.step(L * 0.5, 0);
    b.setDir(w.d);
    return blade(b, L, L * rand(0.15, 0.2), ((rnd() < 0.5 ? 1 : -1) * rand(1, 4)) / S, t, -1, 0);
  }

  const RADII = [0.075, 0.06, 0.048, 0.038, 0.03].map((r) => r * S);
  const freeRadius = (p) => {
    for (const r of RADII) if (!occ.hit(p[0], p[1], p[2], r)) return r;
    return 0;
  };
  const samples = jitteredLattice(shape, 0.02 * S);
  const passes = fill < 0.15 ? 2 : fill < 0.5 ? 3 : RADII.length;
  for (const minR of RADII.slice(0, passes)) {
    for (const q of samples) {
      if (occ.hit(q[0], q[1], q[2], minR) || occ.selfHit(q[0], q[1], q[2], minR * 0.5)) continue;
      if (rnd() > 0.4 + fill * 0.6) continue;
      const p = [q[0], q[1], q[2]];
      const rf = freeRadius(p) || minR;
      const r = rnd();
      const pf = 0.15 + flowers * 0.5;
      if (rf >= 0.06 * S && !stems.near(p[0], p[1], p[2], rf * 2.5).length && freeStem(p, rf)) continue;
      let ok;
      if (rf >= 0.048 * S) {
        if (r < pf) ok = attach(p, Math.min(rf, 0.065 * S), flowerKind()) || attach(p, rf, "lance") || tendril(p, rf);
        else if (r < pf + leafiness * 0.5) ok = attach(p, Math.min(rf, 0.07 * S), rnd() < 0.5 ? "pad" : "lance") || attach(p, rf, "lance") || tendril(p, rf);
        else ok = attach(p, rf, "lance") || tendril(p, rf);
      } else if (rf >= 0.038 * S) {
        if (r < pf * 0.7) ok = attach(p, rf, rnd() < 0.5 ? CLOSED : POPPY) || attach(p, rf, "lance") || tendril(p, rf);
        else if (r < 0.85) ok = attach(p, rf, "lance") || tendril(p, rf);
        else ok = tendril(p, rf) || attach(p, rf, "lance");
      } else if (r < 0.12) ok = tendril(p, rf) || attach(p, rf, "lance");
      else ok = attach(p, rf, "lance") || attach(p, rf, CLOSED) || (r < 0.4 && tendril(p, rf));
      if (!ok) loose(p, Math.min(rf, 0.065 * S));
    }
  }
  return prims;
}
