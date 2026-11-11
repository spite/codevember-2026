// Generative rinceau on a surface, laid out largest first. Flow lines (contours of a noise, grown all at once and
// kept a band apart) are the main stems; big flowers and leaf sprays go on them first, then scrolls and leaves at
// their nodes, then every free spot, largest first, gets a leaf, flower, scroll or curl sized to it on a stalk from
// the nearest stem. Everything is grown by walking along the surface (step, then project back), so it works on any
// shape.
// Output: primitives (strokes, arcs, leaves, rosettes, beads) with a growth order, and hammer blows.
import { STROKE, LEAF, ROSETTE, BEAD, ARC, FROND, BLOSSOM, DAISY, PEONY, FIVE, CHRYS, BUD, BELL, FAN, rnd, rand, norm, smooth, Occupancy, Walker, randomDir, surfacePoint, surfaceLattice, createNoise, forward } from "../kit.js";

/*
 * opts:
 *  scale: size of the elements (1 = default)
 *  flow: 0..1, how much the flow lines wander (0 = nearly parallel bands, 1 = swirls and loops)
 *  leafiness: 0..1, how many nodes carry leaves instead of scrolls
 *  rosettes: 0..1, flowers at scroll ends and among the fillers
 *  lobes: lobe count of the leaves
 *  fill: 0..1, how densely the leftover ground is filled
 *  seed: the pattern's own random sequence
 */
export function rinceau(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const leafiness = opts.leafiness ?? 0.5;
  const rosettes = opts.rosettes ?? 0.5;
  const lobes = opts.lobes ?? 3;
  const fill = opts.fill ?? 0.7;
  const fronds = opts.fronds ?? 0.5;

  const occ = new Occupancy(0.035 * S, shape.bounds);
  const images = kit.images;
  occ.images = images;
  // Points along every stem, where later motifs can branch off.
  const stems = new Occupancy(0.05 * S, shape.bounds);
  const addStemPt = (w, width, t, owner, s) => stems.add(w.p[0], w.p[1], w.p[2], 0, owner, s, { w: w.clone(), width, t, owner, s });
  const prims = [];
  let ownerId = 0;
  const GAP = 0.0022 * S; // clearance between elements, the etched ground between them
  const LEAF_OCC = 0.72;

  // Growth time runs in arc length units; normalized at the end.
  const queue = [];
  const push = (item) => {
    queue.push(item);
    queue.sort((a, b) => b.t - a.t);
  };

  // Stems are emitted as circular arcs (or straight strokes), each through its start point with its start
  // tangent, so a stem is smooth however tightly it curls.
  function stemBuilder(p, n, d, width, t) {
    let A = p.slice();
    let An = n.slice();
    let Ad = d.slice();
    let Aw = width;
    let At = t;
    let turn = 0;
    let len = 0;
    let last = null;
    function emit(B, Bw, Bt) {
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const side = [An[1] * Ad[2] - An[2] * Ad[1], An[2] * Ad[0] - An[0] * Ad[2], An[0] * Ad[1] - An[1] * Ad[0]];
      const ds = ab[0] * side[0] + ab[1] * side[1] + ab[2] * side[2];
      if (Math.abs(turn) < 0.03 || Math.abs(ds) < 1e-7) {
        prims.push(forward({ type: STROKE, a: A, b: B.slice(), ra: Aw, rb: Bw, ta: At, tb: Bt, h: 1 }));
      } else {
        const rho = l2 / (2 * ds);
        const c = [A[0] + side[0] * rho, A[1] + side[1] * rho, A[2] + side[2] * rho];
        prims.push(forward({ type: ARC, a: A, b: B.slice(), c, ra: Aw, rb: Bw, ta: At, tb: Bt, h: 1 }));
      }
    }
    return {
      // After a step of length h with curvature k, at walker w.
      add(w, width, t, k, h) {
        turn += k * h;
        len += h;
        last = [w.p.slice(), w.n.slice(), w.d.slice(), width, t];
        if (Math.abs(turn) > 0.9 || len > 0.08 * S) {
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

  function leafAxisPoints(w, L, W, curl, owner, sNode) {
    // Samples the bent axis; returns null if blocked.
    const pts = [];
    const ww = w.clone();
    const n = 6;
    for (let i = 1; i <= n; i++) {
      ww.step(L / n, curl);
      const t = i / n;
      const hw = W * 1.05 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.65) + 0.002;
      if (occ.hit(ww.p[0], ww.p[1], ww.p[2], hw + GAP, owner, sNode, W * 2.5 + (L * i) / n)) return null;
      pts.push([ww.p[0], ww.p[1], ww.p[2], hw]);
    }
    return pts;
  }

  // A lobed leaf from walker w (at its base, pointing along d). owner: the stem, ignored near the base.
  function tryLeaf(w, L, W, curl, t, parent, sNode) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pts = leafAxisPoints(w, L, W, curl, parent, sNode);
      if (pts) {
        const id = ownerId++;
        for (const p of pts) occ.add(p[0], p[1], p[2], p[3], id, 0, t + L);
        prims.push({
          type: LEAF,
          a: w.p.slice(),
          b: w.d.slice(),
          L,
          W,
          curl,
          lobes: Math.max(2, Math.round(lobes * Math.sqrt(L / (0.09 * S)))),
          seed: rnd(),
          ta: t,
          tb: t + L * 1.5,
        });
        return true;
      }
      L *= 0.75;
      W *= 0.78;
      curl /= 0.75;
      if (L < 0.022 * S) return false;
    }
    return false;
  }

  // A leaf whose discs are then pulled in, so neighbours can tuck into the notches between its lobes.
  function leaf(w, L, W, curl, t, parent, sNode) {
    const n0 = occ.n;
    if (!tryLeaf(w, L, W, curl, t, parent, sNode)) return false;
    for (let id = n0; id < occ.n; id++) occ.x[id * 6 + 3] *= LEAF_OCC;
    return true;
  }

  // A scroll frond: a log-spiral midrib from walker w curling to side sg, with leaflets along its outside.
  function tryFrond(w, rho0, sg, t, parent, sNode) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const b = rand(0.26, 0.34);
      const k = Math.hypot(1, b);
      const left = w.side();
      const P = w.p;
      const q = shape.project(...[0, 1, 2].map((i) => P[i] + (rho0 * (b * w.d[i] + sg * left[i])) / k));
      const C = [q[0], q[1], q[2]];
      const turns = rand(0.95, 1.2) * Math.PI * 2;
      // Discs along the spiral, as wide as its leaflets there (outer ones larger), instead of one over all of it.
      const nC = [q[3], q[4], q[5]];
      const e0 = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
      const en = e0[0] * nC[0] + e0[1] * nC[1] + e0[2] * nC[2];
      const ex = norm([e0[0] - nC[0] * en, e0[1] - nC[1] * en, e0[2] - nC[2] * en]);
      const ey = [(nC[1] * ex[2] - nC[2] * ex[1]) * sg, (nC[2] * ex[0] - nC[0] * ex[2]) * sg, (nC[0] * ex[1] - nC[1] * ex[0]) * sg];
      const discs = [];
      let blocked = false;
      for (let X = 0; X < turns && !blocked; ) {
        const r = rho0 * Math.exp(-b * X);
        const f = X / turns;
        const env = smooth(0, 0.1, f) * (1 - 0.6 * smooth(0.35, 0.9, f));
        const rad = (0.4 * env + 0.11) * r;
        const ro = r * (1 + 0.1 * env);
        const c = shape.project(C[0] + (ex[0] * Math.cos(X) + ey[0] * Math.sin(X)) * ro, C[1] + (ex[1] * Math.cos(X) + ey[1] * Math.sin(X)) * ro, C[2] + (ex[2] * Math.cos(X) + ey[2] * Math.sin(X)) * ro);
        if (occ.hit(c[0], c[1], c[2], rad + GAP, parent, sNode, rho0 * 1.2)) blocked = true;
        discs.push([c[0], c[1], c[2], rad]);
        X += Math.max(0.12, (rad * 0.8) / r);
      }
      if (!blocked) {
        const id = ownerId++;
        for (const d of discs) occ.add(d[0], d[1], d[2], d[3], id, 0, t);
        const len = (rho0 * (1 - Math.exp(-b * turns)) * k) / b;
        prims.push({ type: FROND, a: C, b: [P[0] - C[0], P[1] - C[1], P[2] - C[2]], R: rho0, spiral: b * sg, turns, leaflets: Math.round(rand(9, 12)), seed: rnd(), ta: t, tb: t + len * 1.3 });
        return true;
      }
      rho0 *= 0.85;
      if (rho0 < 0.024 * S) return false;
    }
    return false;
  }

  // A flower seen from the front; its kind follows its size (big ones are layered).
  function tryRosette(p, R, t, owner = -1, s = 0, win = 0, kind = -1) {
    if (occ.hit(p[0], p[1], p[2], R + GAP, owner, s, win)) return false;
    const id = ownerId++;
    occ.add(p[0], p[1], p[2], R, id, 0, t);
    rosette(p, R, t, kind);
    return true;
  }
  function rosette(p, R, t, kind = -1) {
    const big = R > 0.028 * S;
    if (kind < 0) {
      const r = rnd();
      kind = big ? (r < 0.35 ? DAISY : r < 0.65 ? PEONY : r < 0.85 ? CHRYS : FIVE) : r < 0.45 ? DAISY : r < 0.85 ? FIVE : PEONY;
    }
    const petals =
      kind === DAISY ? Math.floor(rand(big ? 12 : 9, big ? 17 : 13)) : kind === PEONY ? Math.floor(rand(6, 9)) : kind === FIVE ? 5 : Math.floor(rand(14, 20));
    const layers = kind === FIVE ? 2 : kind === DAISY ? (big ? 2 : rnd() < 0.5 ? 2 : 1) : big ? 3 : 2;
    prims.push({ type: ROSETTE, a: [p[0], p[1], p[2]], b: randomDir(), R, petals, layers, seed: rnd(), kind, ta: t, tb: t + R * 6 });
  }

  // A flower seen from the side, a bell or a bud, from walker w along its direction.
  function tryBlossom(w, L, t, owner = -1, s = 0, kind = -1) {
    if (kind < 0) {
      const r = rnd();
      kind = r < 0.35 ? BUD : r < 0.65 ? BELL : FAN;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const W = L * (kind === BUD ? 0.32 : kind === BELL ? 0.4 : 0.55);
      const ww = w.clone();
      const pts = [];
      let ok = true;
      for (let i = 1; i <= 5 && ok; i++) {
        ww.step(L / 5, 0);
        const u = i / 5;
        const hw = kind === FAN ? W * Math.min(1, 0.4 + u) : W * Math.max(0.5, Math.sin(Math.PI * Math.min(u, 0.8) * 0.8));
        if (occ.hit(ww.p[0], ww.p[1], ww.p[2], hw + GAP, owner, s, L * 0.6 + W)) ok = false;
        pts.push([ww.p[0], ww.p[1], ww.p[2], hw]);
      }
      if (ok) {
        const id = ownerId++;
        for (const q of pts) occ.add(q[0], q[1], q[2], q[3], id, 0, t + L);
        prims.push({ type: BLOSSOM, a: w.p.slice(), b: w.d.slice(), L, W, kind, seed: rnd(), ta: t, tb: t + L * 2 });
        return true;
      }
      L *= 0.75;
      if (L < 0.014 * S) return false;
    }
    return false;
  }

  function tryBead(p, r, t, owner = -1, s = 0, win = 0) {
    if (occ.hit(p[0], p[1], p[2], r + GAP * 0.7, owner, s, win)) return false;
    occ.add(p[0], p[1], p[2], r, ownerId++, 0, t);
    prims.push({ type: BEAD, a: p.slice(0, 3), R: r, ta: t, tb: t + r * 4 });
    return true;
  }

  // A flower on a short stem peeling off a stem at walker w: the stem is walked first, then the head must fit.
  function tryFlowerBranch(w, width, t, parent, sParent, side, R, Ls) {
    const sw = Math.max(0.0018 * S, width * 0.75);
    const own = ownerId++;
    const ww = w.offset(side * width * 0.6);
    ww.turn(side * rand(0.5, 0.9));
    const k = (-side * rand(3, 9)) / S;
    const h = 0.005 * S;
    const pts = [];
    let s = 0;
    while (s < Ls) {
      ww.step(h, k);
      s += h;
      if (occ.hit(ww.p[0], ww.p[1], ww.p[2], sw + GAP, own, s, sw * 4, parent, sParent, sw * 12)) return false;
      pts.push(ww.clone());
    }
    for (let attempt = 0; attempt < 3; attempt++, R *= 0.82) {
      if (R < 0.014 * S) return false;
      const e = R + sw * 0.3;
      const c = shape.project(ww.p[0] + ww.d[0] * e, ww.p[1] + ww.d[1] * e, ww.p[2] + ww.d[2] * e);
      if (occ.hit(c[0], c[1], c[2], R + GAP, own, 0, 1e9, parent, sParent, sw * 12)) continue;
      const stem = stemBuilder(w.p, w.n, w.d, sw, t);
      pts.forEach((q, i) => {
        occ.add(q.p[0], q.p[1], q.p[2], sw, own, (i + 1) * h, t + (i + 1) * h);
        if (i % 2) addStemPt(q, sw, t + (i + 1) * h, own, (i + 1) * h);
        stem.add(q, sw, t + (i + 1) * h, k, h);
      });
      stem.finish();
      const tf = t + Ls;
      occ.add(c[0], c[1], c[2], R, own, Ls, tf);
      rosette(c, R, tf);
      // Sepals: two small leaves hugging the head where the stem meets it.
      for (const sg of [1, -1]) {
        const lw = ww.clone();
        lw.turn(sg * rand(1.1, 1.5));
        const L = R * rand(0.7, 0.9);
        leaf(lw, L, L * 0.38, (-sg * rand(6, 14)) / S, tf, own, Ls);
      }
      return true;
    }
    return false;
  }

  // A fan of leaves from one point: a big one in the middle, smaller ones either side.
  function trySpray(w, width, t, parent, sParent, side, L) {
    const base = w.offset(side * width * 0.6);
    base.turn(side * rand(0.5, 0.8));
    const curl = (-side * rand(2, 6)) / S;
    if (!leaf(base.clone(), L, L * rand(0.31, 0.37), curl, t, parent, sParent)) return false;
    for (const [a, f] of [[0.85, 0.6], [-0.85, 0.55]]) {
      const b = base.clone();
      b.turn(side * a);
      const l = L * f * rand(0.9, 1.1);
      leaf(b, l, l * rand(0.31, 0.37), (-Math.sign(a) * side * rand(4, 10)) / S, t + L * 0.3, parent, sParent);
    }
    return true;
  }

  // Grows one curling stem. kind: scroll | tendril. Returns false (and takes it back) if it was only a stub.
  function grow(item) {
    const { kind, w0, w1, L, sign } = item;
    const w = item.walker;
    const owner = ownerId++;
    const prims0 = prims.length;
    const discs0 = occ.n;
    const stems0 = stems.n;
    let s = 0;
    let t = item.t;
    let prevW = w0;
    let nextNode = w0 * rand(6, 9);
    let side = rnd() < 0.5 ? 1 : -1;
    const stem = stemBuilder(w.p, w.n, w.d, w0, t);
    let lastK = 0;
    // How much tighter than planned the stem curls, once it has had to wrap into the space left.
    let squeeze = 1;
    // Leaves and branches go on once the stem is grown, so they never block it.
    const pending = [];
    while (s < L) {
      const f = s / L;
      const width = w0 + (w1 - w0) * f;
      // The radius of curvature shrinks linearly along the stem, as in a logarithmic spiral.
      const k0 = sign / (item.r0 + (item.rEnd - item.r0) * f);
      const kMax = 1 / (width * 1.7);
      // Its own last few widths, and its parent near the fork, are not obstacles.
      const blockedAt = (q, wd) => occ.hit(q[0], q[1], q[2], wd + GAP, owner, s, wd * 4, item.parent ?? -1, item.parentS ?? 0, s < w0 * 6 ? w0 * 10 : 0);
      // When blocked, the tip curls tighter into the free space instead of stopping.
      let probe = null;
      let k = 0;
      let h = 0;
      for (const tighten of [1, 1.5, 2.3, 3.5]) {
        k = Math.sign(k0) * Math.min(Math.abs(k0) * squeeze * tighten, kMax);
        h = Math.min(Math.max(width * 0.9, 0.0025 * S), 0.25 / Math.abs(k));
        const pr = w.clone();
        pr.step(h, k);
        if (!blockedAt(pr.p, width)) {
          probe = pr;
          squeeze *= tighten;
          break;
        }
        if (Math.abs(k) >= kMax) break;
      }
      if (!probe) break;
      lastK = k;
      w.p = probe.p;
      w.n = probe.n;
      w.d = probe.d;
      s += h;
      t += h;
      occ.add(w.p[0], w.p[1], w.p[2], width, owner, s, t);
      if (width > 0.0015 * S && s < L * 0.7) addStemPt(w, width, t, owner, s);
      stem.add(w, width, t, k, h);
      prevW = width;
      if (s >= nextNode && s < L * 0.85) {
        pending.push([w.clone(), width, t, s, side]);
        side = -side;
        nextNode += width * rand(3.5, 5.5) * (1 + f * 0.5);
      }
    }
    // A stem blocked early would only be a stub: take it back.
    if (s < Math.max(w0 * 7, L * 0.4)) {
      prims.length = prims0;
      occ.rollback(discs0);
      stems.rollback(stems0);
      return false;
    }
    stem.finish();
    for (const [nw, nwidth, nt, ns, nside] of pending) spawnAtNode(item, nw, nwidth, nt, owner, ns, nside);
    endStem(item, w, prevW, t, owner, s, lastK);
    return true;
  }

  function spawnAtNode(item, w, width, t, owner, s, side) {
    const { kind } = item;
    const depth = item.depth ?? 0;
    // Scrolls branch to the outside of their curl.
    if (kind === "scroll") side = -Math.sign(item.sign) || side;
    const base = w.offset(side * width * 0.6);
    const r = rnd();
    const line = kind === "line";
    const wantScroll = line ? r > leafiness * 0.75 : r > leafiness && depth < 4;
    // The main stems carry the big flowers, on short stalks.
    if (line && rnd() < rosettes * 0.25) {
      for (const R of [0.036, 0.03, 0.024].map((x) => x * S * rand(0.9, 1.1))) {
        const stalk = rand(0.2, 0.5) * R;
        const c = w.offset(side * (width + stalk + R));
        if (tryRosette(c.p, R, t, owner, s, R * 2 + stalk)) {
          const a = w.offset(side * width * 0.5).p;
          const b = w.offset(side * (width + stalk + R * 0.3)).p;
          prims.push({ type: STROKE, a, b, ra: width * 0.7, rb: width * 0.55, ta: t, tb: t + stalk, h: 1 });
          return;
        }
      }
    }
    // A small curl on the other side of the node.
    if (kind !== "tendril" && rnd() < (line ? 0.35 : 0.5)) {
      const tb = w.offset(-side * width * 0.6);
      tb.turn(-side * rand(0.25, 0.5));
      const tw = Math.max(0.0016 * S, width * rand(0.35, 0.5));
      const tL = rand(0.035, 0.08) * S;
      push({ kind: "tendril", walker: tb, w0: tw, w1: tw * 0.6, L: tL, sign: side, r0: tL * rand(0.25, 0.4), rEnd: tw * 1.8, depth: 5, t, parent: owner, parentS: s });
    }
    if (wantScroll && kind !== "tendril") {
      // Now and then a collar where the branch leaves the stem.
      if (rnd() < 0.3) {
        const sd = w.side();
        const c = w.p;
        const e = width * 1.4;
        prims.push({ type: STROKE, a: [c[0] - sd[0] * e, c[1] - sd[1] * e, c[2] - sd[2] * e], b: [c[0] + sd[0] * e, c[1] + sd[1] * e, c[2] + sd[2] * e], ra: width * 0.6, rb: width * 0.6, ta: t, tb: t + width, h: 1.4 });
      }
      const nb = base.clone();
      // Branches peel off tangentially.
      nb.turn(side * rand(0.2, 0.42));
      const w0 = width * rand(0.6, 0.8);
      const L = line ? rand(0.14, 0.26) * S : item.L * rand(0.35, 0.55);
      if (L < 0.04 * S || w0 < 0.0018 * S) return;
      push({ kind: "scroll", walker: nb, w0, w1: w0 * 0.45, L, sign: side, r0: L * rand(0.2, 0.32), rEnd: w0 * rand(1.6, 2.2), depth: depth + 1, t, parent: owner, parentS: s });
    } else {
      const nb = base.clone();
      nb.turn(side * rand(0.4, 0.75));
      if (kind !== "tendril" && rnd() < fronds * (line ? 1 : 0.6)) {
        const fb = base.clone();
        fb.turn(side * rand(0.15, 0.4));
        if (tryFrond(fb, (line ? rand(0.04, 0.065) : rand(0.028, 0.045)) * S, side, t, owner, s)) return;
      }
      if (rnd() < rosettes * 0.3 && tryBlossom(nb, rand(0.03, 0.05) * S * (kind === "tendril" ? 0.7 : 1), t, owner, s)) return;
      const L = (line ? rand(0.08, 0.13) : rand(0.06, 0.095)) * S * (kind === "tendril" ? 0.6 : 1);
      leaf(nb, L, L * rand(0.3, 0.36), (-side * rand(3, 12)) / S, t, owner, s);
    }
  }

  function endStem(item, w, width, t, owner, s, k) {
    const r = rnd();
    if (item.kind === "tendril" && r < 0.35) {
      // A cluster of berries at the tip.
      const br = Math.max(0.0025 * S, width * rand(1.6, 2.2));
      const sd = w.side();
      let placed = 0;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const ox = Math.cos(a) * br * 1.9;
        const oy = Math.sin(a) * br * 1.9 + br * 1.2;
        const q = shape.project(w.p[0] + w.d[0] * oy + sd[0] * ox, w.p[1] + w.d[1] * oy + sd[1] * ox, w.p[2] + w.d[2] * oy + sd[2] * ox);
        if (tryBead(q, br, t + i * br, owner, s, width * 6)) placed++;
      }
      if (placed) return;
    }
    if (Math.abs(k) > 0) {
      // The scroll's eye: a flower or bead at the spiral's centre.
      const rad = 1 / Math.abs(k);
      const side = w.side();
      const sg = Math.sign(k);
      const c = shape.project(w.p[0] + side[0] * sg * rad, w.p[1] + side[1] * sg * rad, w.p[2] + side[2] * sg * rad);
      if (r < rosettes) for (const f of [1.0, 0.8]) {
        const R = rad * f;
        if (R > 0.007 * S && tryRosette(c, R, t, owner, s, Math.PI * 2 * rad)) return;
      }
    }
    // A bud, a bell or a side-view flower on the tip.
    if (rnd() < rosettes * 1.2) {
      const L = Math.max(0.018 * S, Math.min(0.06 * S, width * rand(7, 12)));
      if (tryBlossom(w, L, t, owner, s)) return;
    }
    tryBead(w.p, width * rand(1.3, 1.8), t, owner, s, width * 4);
  }

  // The flow: contour lines of a noise on the surface (plus a slope, for bands), which swirl and never cross.
  const noise3 = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const slope = randomDir();
  const fs = 1.6 / S;
  const lin = (1 - flow) * 2.2;
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
    // Along the contour: n × gradient.
    return [(n[1] * gt[2] - n[2] * gt[1]) / l, (n[2] * gt[0] - n[0] * gt[2]) / l, (n[0] * gt[1] - n[1] * gt[0]) / l];
  }

  const fillTime = (p, r) => occ.nearestTime(p[0], p[1], p[2], r * 2 + 0.03) ?? 0;

  // Flow lines, all growing at once from scattered seeds (both ways), kept a band apart.
  const DSEP = 0.13 * S;
  const H = 0.008 * S;
  const sep = new Occupancy(DSEP, shape.bounds);
  sep.images = images;
  const seedCount = Math.round((shape.area / (DSEP * DSEP)) * 0.35);
  const lines = [];
  for (let i = 0; i < seedCount; i++) {
    const q = surfacePoint(shape);
    lines.push({ id: i, seed: new Walker(shape, q, [1, 0, 0]), delay: Math.floor(rand(0, 120)), fronts: null, started: false, dead: false });
  }
  const maxRounds = 2000;
  let activeFronts = 0;
  for (let round = 0; round < maxRounds; round++) {
    let pendingStarts = 0;
    for (const line of lines) {
      if (line.dead) continue;
      if (!line.started) {
        if (round < line.delay) {
          pendingStarts++;
          continue;
        }
        line.started = true;
        const d = flowDir(line.seed);
        const p = line.seed.p;
        if (!d || sep.hit(p[0], p[1], p[2], DSEP * 0.5)) {
          line.dead = true;
          continue;
        }
        line.seed.setDir(d);
        sep.add(p[0], p[1], p[2], DSEP * 0.5, line.id, 0, round);
        line.fronts = [1, -1].map((sg) => ({ sg, w: line.seed.clone(), pts: [], s: 0, active: true }));
        activeFronts += 2;
        continue;
      }
      for (const f of line.fronts) {
        if (!f.active) continue;
        const probe = f.w.clone();
        const d = flowDir(probe);
        if (!d) {
          f.active = false;
          activeFronts--;
          continue;
        }
        probe.setDir([d[0] * f.sg, d[1] * f.sg, d[2] * f.sg]);
        const before = probe.d.slice();
        probe.step(H, 0);
        const p = probe.p;
        const s = f.s + H;
        if (sep.hit(p[0], p[1], p[2], DSEP * 0.5, line.id, s * f.sg, DSEP * 2) || s > 4 * S) {
          f.active = false;
          activeFronts--;
          continue;
        }
        // Signed curvature from the turn of the direction over the step.
        const n = probe.n;
        const cr = [before[1] * probe.d[2] - before[2] * probe.d[1], before[2] * probe.d[0] - before[0] * probe.d[2], before[0] * probe.d[1] - before[1] * probe.d[0]];
        const k = (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]) / H;
        sep.add(p[0], p[1], p[2], DSEP * 0.5, line.id, s * f.sg, round);
        f.w = probe;
        f.s = s;
        f.pts.push({ p: p.slice(), n: n.slice(), d: probe.d.slice(), k, round });
      }
    }
    if (!activeFronts && !pendingStarts) break;
  }

  // Each flow line becomes a stem: thickest in the middle, nodes along it, a volute at each end.
  const W_LINE = 0.0048 * S;
  const allNodes = [];
  const anchors = [];
  const volutes = [];
  for (const line of lines) {
    if (!line.fronts) continue;
    const [fw, bw] = line.fronts;
    const s0 = line.seed;
    // Backward points reversed (pointing forward), the seed, then the forward points.
    const path = [
      ...bw.pts.slice().reverse().map((q) => ({ ...q, d: q.d.map((v) => -v), k: -q.k })),
      { p: s0.p.slice(), n: s0.n.slice(), d: s0.d.slice(), k: 0, round: line.delay },
      ...fw.pts,
    ];
    const total = (path.length - 1) * H;
    if (total < 0.15 * S) continue;
    // Smooth the line on the surface, then take its tangents and curvature from the smoothed points.
    for (let it = 0; it < 4; it++) {
      const ps = path.map((q) => q.p);
      for (let i = 1; i < path.length - 1; i++) {
        const a = ps[i - 1];
        const b = ps[i];
        const c = ps[i + 1];
        const r = shape.project((a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4);
        path[i] = { ...path[i], p: [r[0], r[1], r[2]], n: [r[3], r[4], r[5]] };
      }
    }
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)].p;
      const b = path[Math.min(path.length - 1, i + 1)].p;
      const n = path[i].n;
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const k = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      const l = Math.hypot(d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k) || 1;
      path[i].d = [(d[0] - n[0] * k) / l, (d[1] - n[1] * k) / l, (d[2] - n[2] * k) / l];
    }
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)].d;
      const b = path[Math.min(path.length - 1, i + 1)].d;
      const n = path[i].n;
      const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      path[i].k = (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]) / (2 * H);
    }
    const owner = ownerId++;
    const width = (i) => W_LINE * (0.6 + 0.4 * Math.sin(Math.PI * (i / (path.length - 1))));
    const time = (q) => q.round * H * 1.2;
    const stem = stemBuilder(path[0].p, path[0].n, path[0].d, width(0), time(path[0]));
    let nextNode = rand(0.02, 0.05) * S;
    let side = rnd() < 0.5 ? 1 : -1;
    const at = (q) => {
      const w = Object.create(Walker.prototype);
      w.shape = shape;
      w.p = q.p.slice();
      w.n = q.n.slice();
      w.d = q.d.slice();
      return w;
    };
    let nextAnchor = rand(0.04, 0.2) * S;
    let aside = rnd() < 0.5 ? 1 : -1;
    for (let i = 0; i < path.length; i++) {
      const q = path[i];
      occ.add(q.p[0], q.p[1], q.p[2], width(i), owner, i * H, time(q));
      if (i % 2 === 0) addStemPt(at(q), width(i), time(q), owner, i * H);
      if (i === 0) continue;
      stem.add(at(q), width(i), time(q), path[i].k, H);
      if (i * H >= nextAnchor && i < path.length - 3) {
        anchors.push([at(q), width(i), time(q), owner, i * H, aside, rnd()]);
        aside = -aside;
        nextAnchor += rand(0.1, 0.17) * S;
      }
      if (i * H >= nextNode && i < path.length - 3) {
        allNodes.push([at(q), width(i), time(q), owner, i * H, side, rnd()]);
        side = -side;
        nextNode += rand(0.035, 0.06) * S;
      }
    }
    stem.finish();
    for (const [q, i, dirSign] of [[path[path.length - 1], path.length - 1, 1], [path[0], 0, -1]]) volutes.push([q, i, dirSign, owner, at, width]);
  }
  // Large motifs first, anywhere on the piece: flowers on short stems and leaf sprays off the main stems.
  anchors.sort((a, b) => a[6] - b[6]);
  for (const [w, width, t, owner, s, side] of anchors) {
    const r = rnd();
    if (r >= rosettes * 0.8 && r < rosettes * 0.8 + fronds * 0.5) {
      const fb = w.offset(side * width * 0.6);
      fb.turn(side * rand(0.3, 0.6));
      if (tryFrond(fb, rand(0.06, 0.085) * S, side, t, owner, s)) continue;
      trySpray(w, width, t, owner, s, side, rand(0.12, 0.17) * S);
    } else if (r < rosettes * 0.8) {
      if (!tryFlowerBranch(w, width, t, owner, s, side, rand(0.055, 0.075) * S, rand(0.02, 0.05) * S)) trySpray(w, width, t, owner, s, side, rand(0.11, 0.15) * S);
    } else if (!trySpray(w, width, t, owner, s, side, rand(0.12, 0.17) * S) && rosettes > 0) tryFlowerBranch(w, width, t, owner, s, side, rand(0.035, 0.05) * S, rand(0.02, 0.04) * S);
  }
  // Volutes: each end curls on into the free side.
  for (const [q, i, dirSign, owner, at, width] of volutes) {
    const w = at(q);
    if (dirSign < 0) w.setDir(q.d.map((v) => -v));
    const sg = rnd() < 0.5 ? 1 : -1;
    const ww = width(i);
    // Now and then the line ends in a frond instead.
    if (rnd() < fronds * 0.5 && tryFrond(w, rand(0.045, 0.07) * S, sg, q.round * H * 1.2, owner, i * H)) continue;
    for (const sign of [sg, -sg]) {
      const item = { kind: "scroll", walker: w.clone(), w0: ww, w1: ww * 0.5, L: rand(0.08, 0.15) * S, sign, r0: rand(0.03, 0.05) * S, rEnd: ww * 1.8, depth: 2, t: q.round * H * 1.2, parent: owner, parentS: i * H };
      if (grow(item)) break;
    }
  }
  // Then the medium layer: fronds and leaves at the main stems' nodes.
  allNodes.sort((a, b) => a[6] - b[6]);
  for (const [nw, nwidth, nt, owner, ns, nside] of allNodes) spawnAtNode({ kind: "line" }, nw, nwidth, nt, owner, ns, nside);
  while (queue.length) grow(queue.pop());

  // Fillers: each free spot, largest first, gets a motif sized to it on a stalk from the nearest stem.
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const RADII = [0.06, 0.046, 0.036, 0.028, 0.022, 0.017, 0.013, 0.01, 0.0075, 0.0055].map((r) => r * S);
  const freeRadius = (p) => {
    for (const r of RADII) if (!occ.hit(p[0], p[1], p[2], r)) return r;
    return 0;
  };
  // A stalk leaving a nearby stem tangentially and bending toward p, ending `before` short of it.
  function stalkTo(p, reach, before, sw0) {
    const cands = stems.near(p[0], p[1], p[2], reach).sort((a, b) => a[0] - b[0]);
    for (let ci = 0; ci < Math.min(4, cands.length); ci++) {
      const c = cands[ci][1];
      const v = sub3(p, c.w.p);
      const cw = c.w.clone();
      // Branches lean toward the stem's tip, or back toward its root now and then.
      if (dot3(v, cw.d) < 0 && rnd() < 0.5) cw.d = cw.d.map((x) => -x);
      const sd = cw.side();
      const sv = dot3(v, sd);
      const ang = Math.atan2(Math.abs(sv), dot3(v, cw.d));
      if (ang < 0.15 || ang > 2.0) continue;
      const side = sv >= 0 ? 1 : -1;
      const sw = Math.max(0.0013 * S, Math.min(sw0, c.width * 0.75));
      // Cheap reject: the middle of the way there is taken.
      const mid = shape.project((p[0] + c.w.p[0]) / 2, (p[1] + c.w.p[1]) / 2, (p[2] + c.w.p[2]) / 2);
      if (Math.hypot(v[0], v[1], v[2]) > before + c.width * 4 && occ.hit(mid[0], mid[1], mid[2], sw + GAP, c.owner, c.s, c.width * 4 + sw * 8)) continue;
      const own = ownerId++;
      const base = cw.offset(side * c.width * 0.5);
      const ww = base.clone();
      ww.turn(side * Math.min(ang * 0.6, 0.5));
      const h = Math.max(0.004 * S, sw * 1.5);
      const pts = [];
      let s = 0;
      let ok = false;
      for (let it = 0; it < 60; it++) {
        const v2 = sub3(p, ww.p);
        const dist = Math.hypot(v2[0], v2[1], v2[2]);
        if (dist <= before + h * 0.5) {
          ok = true;
          break;
        }
        const a2 = Math.max(-0.4, Math.min(0.4, Math.atan2(dot3(v2, ww.side()), dot3(v2, ww.d))));
        ww.turn(a2);
        const st = Math.min(h, dist - before);
        ww.step(st, 0);
        s += st;
        if (occ.hit(ww.p[0], ww.p[1], ww.p[2], sw + GAP, own, s, sw * 4, c.owner, c.s, c.width * 4 + sw * 8)) break;
        pts.push([ww.clone(), s, a2]);
      }
      if (!ok) continue;
      return { w: ww, base, pts, own, sw, c, s, t: c.t + s };
    }
    return null;
  }
  function commitStalk(st) {
    if (!st.pts.length) return;
    const stem = stemBuilder(st.base.p, st.base.n, st.base.d, st.sw, st.c.t);
    let prev = 0;
    for (const [q, s, a] of st.pts) {
      occ.add(q.p[0], q.p[1], q.p[2], st.sw, st.own, s, st.c.t + s);
      addStemPt(q, st.sw, st.c.t + s, st.own, s);
      stem.add(q, st.sw, st.c.t + s, a / Math.max(s - prev, 1e-6), s - prev);
      prev = s;
    }
    stem.finish();
  }
  function attachLeaf(p, rf) {
    const W = Math.max(rf * 1.15 - GAP, 0.004 * S);
    const L = W / rand(0.31, 0.37);
    const st = stalkTo(p, L * 0.8 + 0.04 * S, L * 0.42, W * 0.18);
    if (!st) return false;
    const short = st.pts.length < 3;
    if (!leaf(st.w, L, W, (rnd() < 0.5 ? -1 : 1) * rand(2, 10) / S, st.t, short ? st.c.owner : st.own, short ? st.c.s : st.s)) return false;
    commitStalk(st);
    return true;
  }
  function attachFlower(p, rf) {
    const R = rf - GAP;
    const st = stalkTo(p, R + 0.05 * S, R * 1.02, R * 0.12);
    if (!st) return false;
    const c = shape.project(st.w.p[0] + st.w.d[0] * R, st.w.p[1] + st.w.d[1] * R, st.w.p[2] + st.w.d[2] * R);
    if (occ.hit(c[0], c[1], c[2], R + GAP, st.c.owner, st.c.s, R * 2)) return false;
    commitStalk(st);
    occ.add(c[0], c[1], c[2], R, st.own, st.s, st.t);
    rosette(c, R, st.t);
    return true;
  }
  function attachFrond(p, rf) {
    const rho0 = (rf - GAP) / 1.45;
    if (rho0 < 0.026 * S) return false;
    const st = stalkTo(p, rf + 0.05 * S, rho0 * 1.1, 0.0035 * S);
    if (!st) return false;
    // Curl to the side that puts the spiral's pole nearer the free spot.
    const v = sub3(p, st.w.p);
    const sg = dot3(v, st.w.side()) >= 0 ? 1 : -1;
    const short = st.pts.length < 3;
    if (!tryFrond(st.w, rho0, sg, st.t, short ? st.c.owner : st.own, short ? st.c.s : st.s)) return false;
    commitStalk(st);
    return true;
  }
  function attachBlossom(p, rf) {
    const L = rf * 1.8;
    const st = stalkTo(p, L + 0.04 * S, L * 0.55, 0.0025 * S);
    if (!st) return false;
    if (!tryBlossom(st.w, L, st.t, st.own, st.s)) return false;
    commitStalk(st);
    return true;
  }
  function attachScroll(p, rf) {
    const st = stalkTo(p, rf * 2 + 0.04 * S, rf * 1.2, 0.004 * S);
    if (!st) return false;
    commitStalk(st);
    const w0 = st.sw;
    return grow({ kind: "scroll", walker: st.w.clone(), w0, w1: w0 * 0.5, L: rf * rand(3, 4.5), sign: rnd() < 0.5 ? 1 : -1, r0: rf * rand(0.7, 1), rEnd: w0 * rand(1.6, 2.2), depth: 3, t: st.t, parent: st.own, parentS: st.s });
  }
  function attachCurl(p, rf) {
    const st = stalkTo(p, rf * 2 + 0.03 * S, rf, 0.0022 * S);
    if (!st) return false;
    commitStalk(st);
    const w0 = st.sw;
    return grow({ kind: "tendril", walker: st.w.clone(), w0, w1: w0 * 0.6, L: rf * rand(2.5, 4), sign: rnd() < 0.5 ? 1 : -1, r0: rf * rand(0.5, 0.8), rEnd: w0 * 1.8, depth: 5, t: st.t, parent: st.own, parentS: st.s });
  }
  // Where no stem is near: a scroll of its own, which later motifs can branch from.
  function freeScroll(q, rf) {
    const wk = new Walker(shape, q, [1, 0, 0]);
    const d = flowDir(wk) ?? randomDir();
    wk.setDir(rnd() < 0.5 ? d : d.map((v) => -v));
    const w0 = Math.min(rf * 0.12, 0.0045 * S);
    return grow({ kind: "scroll", walker: wk, w0, w1: w0 * 0.5, L: rf * rand(4, 6), sign: rnd() < 0.5 ? 1 : -1, r0: rf * rand(0.8, 1.2), rEnd: w0 * rand(1.6, 2.2), depth: 2, t: fillTime(q, 0.05) });
  }
  const fillPasses = [
    [0.036, 1],
    [0.022, 1],
    [0.013, 0.8],
    [0.009, 0.4],
    [0.007, 0.2],
  ];
  for (const [minR, amount] of fillPasses) {
    // Darts in proportion to how many spots of this size the surface holds.
    const n = Math.round((shape.area / (minR * S) ** 2) * amount * fill);
    for (let i = 0; i < n; i++) {
      const q = surfacePoint(shape);
      const p = [q[0], q[1], q[2]];
      if (occ.hit(p[0], p[1], p[2], minR * S)) continue;
      const rf = freeRadius(p);
      const r = rnd();
      if (rf >= 0.036 * S) {
        const ok =
          r < rosettes * 0.6
            ? attachFlower(p, Math.min(rf, 0.065 * S)) || attachLeaf(p, rf * 0.8)
            : r < rosettes * 0.6 + fronds * 0.4
              ? attachFrond(p, Math.min(rf, 0.07 * S)) || attachScroll(p, rf)
              : r < 0.85
                ? attachScroll(p, rf)
                : attachLeaf(p, rf * 0.8);
        if (!ok) freeScroll(q, rf);
      } else if (rf >= 0.022 * S) {
        const ok =
          r < rosettes * 0.45
            ? attachFlower(p, rf)
            : r < rosettes * 0.45 + fronds * 0.3
              ? attachFrond(p, rf) || attachLeaf(p, rf)
              : r < rosettes * 0.45 + fronds * 0.3 + rosettes * 0.2
                ? attachBlossom(p, rf) || attachLeaf(p, rf)
                : attachLeaf(p, rf) || (r < 0.5 && attachScroll(p, rf));
        if (!ok) freeScroll(q, rf);
      } else if (rf >= 0.013 * S) {
        if (r < 0.75) attachLeaf(p, rf) || attachCurl(p, rf);
        else if (r < 0.75 + rosettes * 0.15) attachFlower(p, rf);
        else if (r < 0.75 + rosettes * 0.3) attachBlossom(p, rf) || attachCurl(p, rf);
        else attachCurl(p, rf);
      } else if (rf >= 0.009 * S) {
        if (r < 0.55) attachLeaf(p, rf) || attachCurl(p, rf);
        else if (r < 0.85) attachCurl(p, rf) || attachLeaf(p, rf);
        else tryBead(p, rf * 0.7, fillTime(p, rf) + 0.02);
      } else if (r < 0.7) attachCurl(p, rf);
      else if (r < 0.8) tryBead(p, rf * 0.75, fillTime(p, rf) + 0.02);
      while (queue.length) grow(queue.pop());
    }
  }

  // Last, a sweep over the whole surface on a fine lattice: every spot still free gets the largest motif that fits,
  // falling back to a stalkless one, so no ground is left wider than the gap.
  const SWEEP = [0.022, 0.013, 0.009, 0.0065, 0.0048].map((r) => r * S);
  const step = 0.0075 * S;
  const samples = surfaceLattice(shape, step);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  for (const minR of SWEEP) {
    for (const q of samples) {
      const p = [q[0], q[1], q[2]];
      if (occ.hit(p[0], p[1], p[2], minR)) continue;
      const rf = freeRadius(p) || minR;
      const r = rnd();
      let ok = false;
      if (rf >= 0.022 * S) ok = (r < rosettes * 0.5 ? attachFlower(p, rf) : r < rosettes * 0.5 + fronds * 0.3 ? attachFrond(p, rf) : attachLeaf(p, rf)) || attachLeaf(p, rf) || attachScroll(p, rf) || freeScroll(q, rf);
      else if (rf >= 0.013 * S) ok = (r < 0.6 ? attachLeaf(p, rf) : r < 0.6 + rosettes * 0.3 ? attachFlower(p, rf) || attachBlossom(p, rf) : attachCurl(p, rf)) || attachLeaf(p, rf) || attachCurl(p, rf);
      else if (rf >= 0.009 * S) ok = (r < 0.5 ? attachLeaf(p, rf) : attachCurl(p, rf)) || attachCurl(p, rf) || attachLeaf(p, rf);
      else ok = attachCurl(p, rf) || attachLeaf(p, rf * 1.1);
      while (queue.length) grow(queue.pop());
      if (ok) continue;
      // Nothing could reach it: a small flower of its own, or in the tightest spots a bead.
      if (rf >= 0.0065 * S && tryRosette(p, rf - GAP, fillTime(p, rf) + 0.03)) continue;
      tryBead(p, Math.max(rf - GAP, 0.0022 * S), fillTime(p, rf) + 0.02);
    }
  }

  return prims;
}
