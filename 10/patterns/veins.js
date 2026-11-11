// Branching veins grown by space colonization (Runions et al. 2005) on the surface: attractors scattered over the
// blank pull the nearest vein tips toward them and die when reached. Radii follow the pipe model, so trunks taper
// into capillaries. Knotted nodules swell at the junctions, bulbs at some tips, and pods and pored cysts fill the
// spaces between. Growth time is the distance from the root, so the network spreads from a few hearts.
import { TUBE, NODULE, POD, VEIN, rnd, rand, Occupancy, Walker, surfacePoint, jitteredLattice, createNoise } from "../kit.js";

/*
 * opts: scale, seed, flow (how much the veins wander), fill (how densely the spaces are filled), leafiness (more
 * pods vs cysts), rosettes (more junction nodules).
 */
export function veins(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const fill = opts.fill ?? 0.7;
  const flow = opts.flow ?? 0.5;
  const podiness = opts.leafiness ?? 0.5;
  const knots = opts.rosettes ?? 0.5;
  const images = kit.images;
  const prims = [];

  const D = 0.0105 * S; // growth step
  const DKF = 0.014 * S; // last kill distance: sets how close the capillaries pack
  const SPACING = 0.019 * S;
  const R0 = 0.0021 * S; // capillary radius
  const RMAX = 0.0125 * S;
  const GAP = 0.0024 * S;
  const tf = (v, m) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

  // A hash grid of points with ids.
  class Grid {
    constructor(cell) {
      this.cell = cell;
      this.map = new Map();
    }
    key(x, y, z) {
      const c = this.cell;
      return ((Math.floor(x / c) + 512) * 1024 + Math.floor(y / c) + 512) * 1024 + Math.floor(z / c) + 512;
    }
    add(p, id) {
      const k = this.key(p[0], p[1], p[2]);
      let b = this.map.get(k);
      if (!b) this.map.set(k, (b = []));
      b.push(id);
    }
    // Calls fn(id) for every id in the cells within r of p.
    each(p, r, fn) {
      const c = this.cell;
      const x0 = Math.floor((p[0] - r) / c), x1 = Math.floor((p[0] + r) / c);
      const y0 = Math.floor((p[1] - r) / c), y1 = Math.floor((p[1] + r) / c);
      const z0 = Math.floor((p[2] - r) / c), z1 = Math.floor((p[2] + r) / c);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const b = this.map.get(((x + 512) * 1024 + y + 512) * 1024 + z + 512);
            if (b) for (let i = 0; i < b.length; i++) fn(b[i]);
          }
    }
  }

  // Nodes: the real ones, plus their symmetry images (real = false), which claim attractors but never grow.
  const nodes = [];
  const ngrid = new Grid(D * 2);
  let ax, agrid, alive, best, bestD, active, DI, DK;
  function addNode(p, n, d, parent, t) {
    const id = nodes.length;
    nodes.push({ p, n, d, parent, t, children: [], real: true });
    ngrid.add(p, id);
    claim(id);
    for (const m of images) {
      const q = tf(p, m);
      const iid = nodes.length;
      nodes.push({ p: q, real: false });
      ngrid.add(q, iid);
      claim(iid);
    }
    if (parent >= 0) nodes[parent].children.push(id);
    return id;
  }
  function claim(id) {
    const p = nodes[id].p;
    agrid.each(p, DI, (i) => {
      if (!alive[i]) return;
      const a = ax[i];
      const dd = (a[0] - p[0]) ** 2 + (a[1] - p[1]) ** 2 + (a[2] - p[2]) ** 2;
      if (dd < DK * DK) alive[i] = 0;
      else if (dd < DI * DI && dd < bestD[i]) {
        if (best[i] < 0) active.push(i);
        bestD[i] = dd;
        best[i] = id;
      }
    });
  }
  function nearNode(p, r) {
    let hit = false;
    ngrid.each(p, r, (i) => {
      if (hit) return;
      const q = nodes[i].p;
      if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < r * r) hit = true;
    });
    return hit;
  }
  // Attractors spread evenly over the blank; the ones already reached die at once.
  function scatter(spacing, di, dk) {
    DI = di;
    DK = dk;
    ax = [];
    agrid = new Grid(DI);
    const count = Math.round(shape.area / (spacing * spacing));
    const pre = new Grid(spacing);
    const r2 = (spacing * 0.6) ** 2;
    for (let tries = 0; ax.length < count && tries < count * 3; tries++) {
      const q = surfacePoint(shape);
      let near = false;
      pre.each(q, spacing * 0.6, (i) => {
        const a = ax[i];
        if (!near && (a[0] - q[0]) ** 2 + (a[1] - q[1]) ** 2 + (a[2] - q[2]) ** 2 < r2) near = true;
      });
      if (near) continue;
      pre.add(q, ax.length);
      agrid.add(q, ax.length);
      ax.push([q[0], q[1], q[2]]);
    }
    alive = new Uint8Array(ax.length).fill(1);
    best = new Int32Array(ax.length).fill(-1);
    bestD = new Float64Array(ax.length).fill(Infinity);
    active = [];
    for (let i = 0; i < nodes.length; i++) claim(i);
  }

  const noise = createNoise(rnd);
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const wander = 0.1 + flow * 0.7;
  function grow(maxIter) {
    const sum = new Map();
    for (let iter = 0; iter < maxIter && nodes.length < 80000; iter++) {
      sum.clear();
      let live = 0;
      for (let j = 0; j < active.length; j++) {
        const i = active[j];
        if (!alive[i]) continue;
        active[live++] = i;
        const nd = nodes[best[i]];
        if (!nd.real) continue;
        const a = ax[i];
        const p = nd.p;
        const l = Math.sqrt(bestD[i]);
        let s = sum.get(best[i]);
        if (!s) sum.set(best[i], (s = [0, 0, 0]));
        s[0] += (a[0] - p[0]) / l;
        s[1] += (a[1] - p[1]) / l;
        s[2] += (a[2] - p[2]) / l;
      }
      active.length = live;
      let grown = 0;
      for (const [id, s] of sum) {
        const nd = nodes[id];
        const sl = Math.hypot(s[0], s[1], s[2]);
        if (sl < 1e-6) continue;
        const [x, y, z] = nd.p;
        const k = 3.2 / S;
        const nz = [noise(x * k + off[0], y * k, z * k), noise(x * k, y * k + off[1], z * k), noise(x * k, y * k, z * k + off[2])];
        const inert = nd.parent >= 0 ? 0.3 : 0;
        const dir = [0, 1, 2].map((c) => s[c] / sl + nd.d[c] * inert + nz[c] * wander);
        const w = new Walker(shape, nd.p, dir);
        w.step(D);
        if (nearNode(w.p, D * 0.55)) continue;
        addNode(w.p, w.n, w.d, id, nd.t + D);
        grown++;
      }
      if (!grown) break;
    }
  }

  // A few hearts, apart from each other and from their own images.
  scatter(0.065 * S, 0.16 * S, 0.04 * S);
  const roots = Math.max(2, Math.round((shape.area * rand(0.35, 0.6)) / S ** 2 / (1 + images.length)));
  const rootPts = [];
  for (let tries = 0; rootPts.length < roots && tries < 400; tries++) {
    const q = surfacePoint(shape);
    const p = [q[0], q[1], q[2]];
    const others = rootPts.concat(rootPts.flatMap((r) => images.map((m) => tf(r, m)))).concat(images.map((m) => tf(p, m)));
    const minD = Math.sqrt(shape.area / (roots * (1 + images.length))) * 0.7;
    if (others.some((r) => Math.hypot(r[0] - p[0], r[1] - p[1], r[2] - p[2]) < minD)) continue;
    rootPts.push(p);
    const w = new Walker(shape, p, [rand(-1, 1), rand(-1, 1), rand(-1, 1)]);
    addNode(w.p, w.n, w.d, -1, rand(0, 0.15));
  }
  // The main veins through sparse attractors, then the capillaries off them through dense ones.
  grow(2000);
  scatter(0.032 * S, 0.09 * S, 0.024 * S);
  grow(2000);
  scatter(SPACING, 0.045 * S, DKF);
  grow(2000);

  // Pipe model: a vein's cross-section carries all the tips beyond it.
  const real = nodes.filter((n) => n.real);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (!nd.real) continue;
    if (!nd.children.length) nd.tips = 1;
    else nd.tips = nd.children.reduce((a, c) => a + nodes[c].tips, 0);
    nd.depth = nd.children.length ? Math.max(...nd.children.map((c) => nodes[c].depth)) + 1 : 0;
  }
  for (const nd of real) {
    const r = R0 * Math.pow(nd.tips, 0.42);
    nd.r = RMAX * Math.tanh(r / RMAX);
    // Capillaries thin to a point over their last steps.
    nd.r *= 0.55 + 0.45 * Math.min(1, nd.depth / 3);
  }

  // Smoothed chains between junctions.
  for (let pass = 0; pass < 3; pass++) {
    for (const nd of real) {
      if (nd.parent < 0 || nd.children.length !== 1) continue;
      const a = nodes[nd.parent].p;
      const b = nodes[nd.children[0]].p;
      const q = shape.project((a[0] + b[0] + nd.p[0] * 2) / 4, (a[1] + b[1] + nd.p[1] * 2) / 4, (a[2] + b[2] + nd.p[2] * 2) / 4);
      nd.p = [q[0], q[1], q[2]];
      nd.n = [q[3], q[4], q[5]];
    }
  }

  const occ = new Occupancy(0.02 * S, shape.bounds);
  occ.images = images;
  let owner = 0;
  // Walks a vessel from node a toward its child c, as segments two or three steps long, then on past each junction.
  function walk(a, c) {
    const own = owner++;
    for (;;) {
      const end = segment(a, c, own);
      const nb = nodes[end];
      if (nb.children.length === 1) {
        a = end;
        c = nb.children[0];
        continue;
      }
      if (!nb.children.length) tip(nb);
      else {
        junction(nb);
        for (const k of nb.children) walk(end, k);
      }
      return;
    }
  }
  function segment(a, b, own) {
    let end = b;
    let len = 1;
    const maxLen = nodes[a].r > 0.006 * S ? 5 : 3;
    while (len < maxLen && nodes[end].children.length === 1) {
      const nx = nodes[end].children[0];
      // Stop at a bend, so the segments follow the curve.
      const A = nodes[a].p, B = nodes[end].p, C = nodes[nx].p;
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const v = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
      const cs = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) + 1e-12);
      if (cs < 0.975) break;
      end = nx;
      len++;
    }
    const na = nodes[a];
    const nb = nodes[end];
    prims.push({ type: TUBE, a: na.p.slice(), b: nb.p.slice(), ra: na.r, rb: nb.r, ribs: (2 * Math.PI) / (0.035 * S), s0: na.t, kind: VEIN, seed: rnd(), ta: na.t, tb: nb.t, h: 1 });
    const steps = Math.max(1, Math.ceil(Math.hypot(nb.p[0] - na.p[0], nb.p[1] - na.p[1], nb.p[2] - na.p[2]) / (Math.min(na.r, nb.r) + 0.006 * S)));
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      occ.add(na.p[0] + (nb.p[0] - na.p[0]) * f, na.p[1] + (nb.p[1] - na.p[1]) * f, na.p[2] + (nb.p[2] - na.p[2]) * f, na.r + (nb.r - na.r) * f, own, 0, na.t + (nb.t - na.t) * f);
    }
    return end;
  }

  const nodulePrims = [];
  function junction(nd) {
    // Only where a real branch leaves, not at every twig.
    const second = nd.children.map((c) => nodes[c].r).sort((a, b) => b - a)[1];
    if (nd.r < 0.0032 * S || second < nd.r * 0.45 || rnd() > 0.35 + knots * 0.6) return;
    const R = nd.r * rand(1.5, 2.2);
    const d = nodes[nd.children[0]].d ?? nd.d;
    nodulePrims.push({ type: NODULE, a: nd.p.slice(), b: d.slice(), R, lumps: Math.round(rand(2, 4)), pore: rnd() < 0.25 ? rand(0.22, 0.32) : 0, seed: rnd(), kind: 0, ta: nd.t - R, tb: nd.t + R * 2, h: 1 });
    occ.add(nd.p[0], nd.p[1], nd.p[2], R, owner++, 0, nd.t);
  }
  function tip(nd) {
    if (nd.r < 0.0016 * S || rnd() > 0.25) return;
    const R = nd.r * rand(1.8, 2.6) + 0.0012 * S;
    const p = [nd.p[0] + nd.d[0] * R * 0.6, nd.p[1] + nd.d[1] * R * 0.6, nd.p[2] + nd.d[2] * R * 0.6];
    const q = shape.project(...p);
    nodulePrims.push({ type: NODULE, a: [q[0], q[1], q[2]], b: nd.d.slice(), R, lumps: 0, pore: 0, seed: rnd(), kind: 1, ta: nd.t, tb: nd.t + R * 3, h: 1 });
    occ.add(q[0], q[1], q[2], R, owner++, 0, nd.t);
  }
  nodes.forEach((nd, i) => {
    if (!nd.real || nd.parent >= 0) return;
    if (nd.children.length > 1) junction(nd);
    for (const c of nd.children) walk(i, c);
  });
  prims.push(...nodulePrims);

  // The spaces between: pods along the nearest vein, cysts with a pore, then beads, largest first.
  function freeRadius(p, max) {
    let lo = 0, hi = max;
    if (!occ.hit(p[0], p[1], p[2], hi)) return hi;
    for (let k = 0; k < 9; k++) {
      const m = (lo + hi) / 2;
      if (occ.hit(p[0], p[1], p[2], m)) hi = m;
      else lo = m;
    }
    return lo;
  }
  // The direction of the nearest vein, from the nodes around.
  function veinDir(p) {
    let bd = Infinity, bn = null;
    ngrid.each(p, 0.04 * S, (i) => {
      const nd = nodes[i];
      if (!nd.real || nd.parent < 0) return;
      const dd = (nd.p[0] - p[0]) ** 2 + (nd.p[1] - p[1]) ** 2 + (nd.p[2] - p[2]) ** 2;
      if (dd < bd) (bd = dd), (bn = nd);
    });
    return bn ? bn.d : [rand(-1, 1), rand(-1, 1), rand(-1, 1)];
  }
  function tryPod(p, rf, t) {
    const w = new Walker(shape, p, veinDir(p));
    w.turn(rand(-0.25, 0.25));
    const L = rf * rand(1.5, 2.1);
    const W = Math.min(rf - GAP, L * rand(0.38, 0.5));
    // The pod's ends must be free too.
    for (const sg of [1, -1]) {
      const e = w.clone();
      e.step(sg * L * 0.55);
      if (occ.hit(e.p[0], e.p[1], e.p[2], W * 0.55 + GAP)) return false;
    }
    if (occ.hit(w.p[0], w.p[1], w.p[2], W + GAP) || occ.selfHit(w.p[0], w.p[1], w.p[2], L * 0.6)) return false;
    for (const f of [-0.66, -0.33, 0, 0.33, 0.66]) {
      const e = w.clone();
      e.step(f * L);
      occ.add(e.p[0], e.p[1], e.p[2], W * Math.sqrt(1 - f * f), owner, 0, t);
    }
    owner++;
    prims.push({ type: POD, a: w.p.slice(), b: w.d.slice(), L, W, seeds: Math.max(2, Math.round(L / W * rand(1.4, 2))), seed: rnd(), ta: t, tb: t + L * 1.5, h: 1 });
    return true;
  }
  // A short neck from the nearest vein to a growth of radius R at p; returns the vein's time there, or null.
  function neck(p, R) {
    let bd = Infinity, bn = null;
    ngrid.each(p, R + 0.03 * S, (i) => {
      const nd = nodes[i];
      if (!nd.real) return;
      const dd = (nd.p[0] - p[0]) ** 2 + (nd.p[1] - p[1]) ** 2 + (nd.p[2] - p[2]) ** 2;
      if (dd < bd) (bd = dd), (bn = nd);
    });
    if (!bn) return null;
    const l = Math.sqrt(bd);
    const u = [(p[0] - bn.p[0]) / l, (p[1] - bn.p[1]) / l, (p[2] - bn.p[2]) / l];
    const rs = Math.max(0.0012 * S, Math.min(R * 0.24, bn.r * 0.85));
    const a = bn.r * 0.5;
    const b = l - R * 0.6;
    if (b - a < GAP * 2) return null;
    for (let x = bn.r + GAP; x < l - R - GAP * 0.5; x += rs) {
      if (occ.hit(bn.p[0] + u[0] * x, bn.p[1] + u[1] * x, bn.p[2] + u[2] * x, rs + GAP * 0.6)) return null;
    }
    const A = [bn.p[0] + u[0] * a, bn.p[1] + u[1] * a, bn.p[2] + u[2] * a];
    const B = [bn.p[0] + u[0] * b, bn.p[1] + u[1] * b, bn.p[2] + u[2] * b];
    prims.push({ type: TUBE, a: A, b: B, ra: rs * 1.3, rb: rs, ribs: 0, s0: 0, kind: VEIN, seed: rnd(), ta: bn.t, tb: bn.t + (b - a), h: 1 });
    for (let x = a; x <= b; x += rs * 2) occ.add(bn.p[0] + u[0] * x, bn.p[1] + u[1] * x, bn.p[2] + u[2] * x, rs, owner, 0, bn.t);
    return bn.t + (b - a);
  }
  function tryNodule(p, R, t, kind) {
    if (occ.hit(p[0], p[1], p[2], R + GAP) || occ.selfHit(p[0], p[1], p[2], R + GAP * 0.5)) return false;
    // Most hang off the nearest vein by a neck, like berries.
    if (R > 0.003 * S && rnd() < 0.65) {
      const R2 = R * 0.75;
      const tn = neck(p, R2);
      if (tn !== null) (R = R2), (t = tn);
    }
    occ.add(p[0], p[1], p[2], R, owner++, 0, t);
    const big = R > 0.006 * S;
    prims.push({ type: NODULE, a: p.slice(), b: [rand(-1, 1), rand(-1, 1), rand(-1, 1)], R, lumps: big ? Math.round(rand(2, 4)) : 0, pore: kind === 2 ? rand(0.25, 0.4) : 0, seed: rnd(), kind, ta: t, tb: t + R * 3, h: 1 });
    return true;
  }

  let samples = jitteredLattice(shape, 0.0085 * S);
  const passes = [0.015, 0.0095, 0.0068].map((r) => r * S);
  for (const [pi, minR] of passes.entries()) {
    if (pi >= 2 && fill < 0.3) break;
    // Spots already covered stay covered.
    samples = samples.filter((p) => !occ.hit(p[0], p[1], p[2], 0));
    for (const p of samples) {
      if (occ.hit(p[0], p[1], p[2], minR)) continue;
      const rf = freeRadius(p, 0.03 * S);
      const t = (occ.nearestTime(p[0], p[1], p[2], 0.05 * S) ?? 0) + rf;
      const r = rnd();
      if (rf > 0.006 * S && r < 0.35 + podiness * 0.5 && tryPod(p, rf, t)) continue;
      const kind = rf > 0.0045 * S && rnd() < 0.6 ? 2 : 1;
      tryNodule(p, Math.max(0.0028 * S, (rf - GAP) * (kind === 2 ? 0.95 : 0.85)), t, kind);
    }
  }
  return prims;
}
