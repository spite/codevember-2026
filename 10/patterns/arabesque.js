// Arabesque strapwork: flat straps laid by Hankin's polygons-in-contact method over a mesh on the blank (weave.js).
// From each edge's midpoint two straps leave at a contact angle and meet their neighbours' inside the faces, so
// every face holds a star and every vertex another; the straps cross at the midpoints, over and under in turn,
// with mitred corners. The stars are filled with split palmettes radiating from a boss, scrolls curl into the
// space between them, and buds and pellets take what is left.
import { PALMETTE, ROSETTE, BEAD, ARC, STROKE, DAISY, FIVE, CHRYS, rnd, rand, Occupancy, Walker, inDomain, surfaceLattice } from "../kit.js";
import { weaveMesh, weaveStrands, symmetricBreaks, faceCentre, sub, add, scale, dot, cross, len, lerp } from "./weave.js";
import { emitStrand } from "./knotwork.js";

const normalize = (a) => scale(a, 1 / (len(a) || 1));

/*
 * opts: scale, flow (breaks, and how far the stars open), fill, rosettes, lobes, seed.
 */
export function arabesque(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const rosettes = opts.rosettes ?? 0.5;
  const lobes = opts.lobes ?? 3;
  let images = kit.images;
  const dom = (p) => inDomain(p, images);
  let cell = 0.15 * S * rand(0.9, 1.12);
  const mesh = weaveMesh(shape, cell, images);
  cell = mesh.cell ?? cell;
  // No mesh this symmetry maps onto itself: weave the whole surface instead.
  if (!mesh.symmetric) images = [];
  const breaks = symmetricBreaks(images, dom, flow * 0.12, () => 1);
  const { loops } = weaveStrands(mesh, breaks);
  const theta = (rand(56, 68) * Math.PI) / 180;
  const centres = mesh.F.map((_, f) => faceCentre(mesh, f));
  const onSurf = (p) => {
    const q = shape.project(p[0], p[1], p[2]);
    return [q[0], q[1], q[2]];
  };
  const normalAt = (p) => {
    const q = shape.project(p[0], p[1], p[2]);
    return [q[3], q[4], q[5]];
  };

  // Hankin's point in face f at corner u: where the rays leaving its two edges' midpoints at the contact angle meet.
  const hankin = new Map();
  function X(f, u, e1, e2) {
    const key = f * 1e7 + u;
    if (hankin.has(key)) return hankin.get(key);
    const c = centres[f];
    const nf = normalAt(c);
    const ray = (e) => {
      const m = e.mid;
      const along = normalize(sub(mesh.V[u], m));
      let inward = cross(nf, along);
      if (dot(inward, sub(c, m)) < 0) inward = scale(inward, -1);
      return [m, add(scale(along, Math.cos(theta)), scale(normalize(inward), Math.sin(theta)))];
    };
    const [p1, d1] = ray(e1);
    const [p2, d2] = ray(e2);
    // Closest points of the two lines.
    const r = sub(p1, p2);
    const a = dot(d1, d1);
    const b = dot(d1, d2);
    const cc = dot(d2, d2);
    const d = dot(d1, r);
    const e = dot(d2, r);
    const den = a * cc - b * b;
    let x;
    if (Math.abs(den) < 1e-9) x = lerp(c, mesh.V[u], 0.5);
    else {
      const t = (b * e - cc * d) / den;
      const s = (a * e - b * d) / den;
      x = lerp(add(p1, scale(d1, t)), add(p2, scale(d2, s)), 0.5);
      // Keep it between the corner and the centre.
      const k = dot(sub(x, mesh.V[u]), sub(c, mesh.V[u])) / dot(sub(c, mesh.V[u]), sub(c, mesh.V[u]));
      if (!(k > 0.15 && k < 0.98)) x = lerp(mesh.V[u], c, 0.6);
    }
    x = onSurf(x);
    hankin.set(key, x);
    return x;
  }

  const prims = [];
  const occ = new Occupancy(0.03 * S, shape.bounds);
  const GAP = 0.0022 * S;
  const ws = cell * rand(0.055, 0.07);
  let owner = 0;
  const cornerOf = new Map();
  for (const steps of loops) {
    // The strap's corners: the junction at each edge, then the Hankin point of the face corner.
    const pts = [];
    const crossings = [];
    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const st = steps[i];
      const e = st.from;
      let J = e.mid;
      // Junctions where a strap turns back sit a little inside the face, so the corner reads.
      const prev = steps[(i + n - 1) % n];
      if (e.kind === 1) J = lerp(e.mid, centres[st.f], 0.28);
      J = onSurf(J);
      const x = X(st.f, st.u, st.from, st.e);
      cornerOf.set(st.f * 1e7 + st.u, x);
      // One straight strap from corner to corner: a chain of chords would crease at every joint.
      const seg = (a) => pts.push({ p: a, n: normalAt(a), w: ws });
      if (e.kind === 0) {
        // The strap over or under this one is its mirror image in the edge.
        const ed = sub(mesh.V[e.w], mesh.V[e.v]);
        const eu = scale(ed, 1 / len(ed));
        const d = normalize(sub(X(st.f, st.u, st.from, st.e), J));
        const dir = sub(scale(eu, 2 * dot(d, eu)), d);
        crossings.push({ k: pts.length, over: prev.over, p: J, w: ws, reach: ws * 4, dir });
      }
      seg(J);
      seg(x);
    }
    emitStrand(prims, occ, pts, crossings, { images, style: -1, gap: GAP, t0: 0, chunk: 0.6 * S, owner: owner++ });
  }
  occ.images = images;
  const strapTime = (p) => occ.nearestTime(p[0], p[1], p[2], cell) ?? 0;

  // A split palmette from p along dir, shrunk until it fits; `skip` is the boss it grows from.
  function palmette(p, dir, Lmax, t, skip = -1) {
    let L = Lmax;
    const w0 = new Walker(shape, p, dir);
    for (let attempt = 0; attempt < 4 && L > 0.014 * S; attempt++, L *= 0.8) {
      const W = L * rand(0.48, 0.56);
      const discs = [];
      const w = w0.clone();
      let ok = true;
      for (let i = 0; i <= 5; i++) {
        const u = i / 5;
        const hw = W * (0.3 + 0.75 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7) * (u > 0.8 ? 0.8 : 1);
        if (occ.hit(w.p[0], w.p[1], w.p[2], hw + GAP, skip, 0, 1e9)) {
          ok = false;
          break;
        }
        discs.push([w.p.slice(), hw]);
        w.step(L / 5, 0);
      }
      if (!ok) continue;
      const id = owner++;
      for (const [q, r] of discs) occ.add(q[0], q[1], q[2], r, id, 0, t);
      prims.push({ type: PALMETTE, a: w0.p.slice(), b: w0.d.slice(), L, W, lobes: Math.max(2, Math.min(4, Math.round(lobes * 0.8))), seed: rnd(), spread: rand(0.3, 0.8), ta: t, tb: t + L * 3 });
      return true;
    }
    return false;
  }
  // A boss at a star's centre, sized to it.
  function boss(p, t) {
    let r = cell * rand(0.14, 0.2);
    while (r > 0.008 * S && occ.hit(p[0], p[1], p[2], r + GAP)) r *= 0.85;
    if (r <= 0.008 * S) return [0, -1];
    const id = owner++;
    occ.add(p[0], p[1], p[2], r, id, 0, t);
    const big = r > 0.016 * S && rnd() < 0.75 + rosettes * 0.25;
    if (big) prims.push({ type: ROSETTE, a: p, b: [1, 0, 0], R: r, petals: [6, 8, 12][Math.floor(rnd() * 3)], layers: 2, seed: rnd(), kind: [DAISY, FIVE, CHRYS][Math.floor(rnd() * 3)], ta: t, tb: t + r * 6 });
    else prims.push({ type: BEAD, a: p, R: r * 0.85, ta: t, tb: t + 0.01 });
    return [r, id];
  }

  // The stars: one per face around its centre (arms toward the edge midpoints), one per vertex (arms toward the
  // Hankin points of its corners). Each gets a boss and a palmette down each arm.
  const stars = [];
  mesh.F.forEach((loop, f) => {
    const arms = loop.map((u, k) => onSurf(lerp(mesh.V[u], mesh.V[loop[(k + 1) % loop.length]], 0.5)));
    stars.push({ c: onSurf(centres[f]), arms });
  });
  const vertexArms = mesh.V.map(() => []);
  mesh.F.forEach((loop, f) => {
    for (const u of loop) {
      const x = cornerOf.get(f * 1e7 + u);
      if (x) vertexArms[u].push(x);
    }
  });
  mesh.V.forEach((v, u) => stars.push({ c: v, arms: vertexArms[u] }));
  for (const st of stars) {
    if (!dom(st.c)) continue;
    const t = strapTime(st.c) + 0.05 * S;
    const [r, id] = boss(st.c, t);
    for (const a of st.arms) {
      const d = sub(a, st.c);
      const l = len(d);
      const base = onSurf(add(st.c, scale(d, (r * 0.85) / l)));
      palmette(base, d, (l - r) * 0.85, t + r, id);
    }
  }

  // Scrolls: a tendril leaves a strap's side and curls into the space left, tightening as it goes.
  function scroll(p, rf, t) {
    const q = shape.project(p[0], p[1], p[2]);
    const w = new Walker(shape, p, cross([q[3], q[4], q[5]], [0.3, 1, 0.2]));
    w.turn(rand(0, Math.PI * 2));
    const sign = rnd() < 0.5 ? 1 : -1;
    const width = Math.max(0.0012 * S, rf * 0.11);
    let r = rf * 0.95;
    const h = width * 1.5;
    const id = owner++;
    const pts = [[w.p.slice(), w.n.slice(), w.d.slice()]];
    let s = 0;
    for (let i = 0; i < 80 && r > width * 1.4; i++) {
      w.step(h, sign / r);
      s += h;
      r *= 0.965;
      if (occ.hit(w.p[0], w.p[1], w.p[2], width + GAP, id, s, width * 4)) break;
      occ.add(w.p[0], w.p[1], w.p[2], width, id, s, t + s);
      pts.push([w.p.slice(), w.n.slice(), w.d.slice()]);
    }
    if (pts.length < 6) return false;
    // An arc over every two steps, through its start with the start's heading.
    for (let i = 0; i + 2 < pts.length; i += 2) {
      const A = pts[i][0];
      const B = pts[i + 2][0];
      const side = cross(pts[i][1], pts[i][2]);
      const ab = sub(B, A);
      const ds = dot(ab, side);
      const ww = width * (1 - (0.4 * i) / pts.length);
      const ta = t + i * h;
      if (Math.abs(ds) < 1e-7) prims.push({ type: STROKE, a: A, b: B, ra: ww, rb: ww, ta, tb: ta + 2 * h, h: 1 });
      else {
        const rho = dot(ab, ab) / (2 * ds);
        prims.push({ type: ARC, a: A, b: B, c: add(A, scale(side, rho)), ra: ww, rb: ww * 0.97, ta, tb: ta + 2 * h, h: 1 });
      }
    }
    const end = pts[pts.length - 1][0];
    prims.push({ type: BEAD, a: end, R: width * 1.6, ta: t + s, tb: t + s + 0.01 });
    return true;
  }

  // Last, every free spot: a scroll, a small rosette or a pellet.
  const step = 0.011 * S;
  const samples = surfaceLattice(shape, step).filter(dom);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  const RADII = [0.04, 0.03, 0.022, 0.016, 0.012, 0.009, 0.0065, 0.0048].map((r) => r * S);
  for (const minR of [0.016, 0.0085].map((r) => r * S)) {
    for (const p of samples) {
      if (occ.hit(p[0], p[1], p[2], minR)) continue;
      let rf = 0;
      for (const r of RADII)
        if (!occ.hit(p[0], p[1], p[2], r)) {
          rf = r;
          break;
        }
      if (rf < minR) continue;
      const t = strapTime(p) + 0.1 * S;
      const r = rnd();
      if (rf >= 0.012 * S && r < 0.5 * fill + 0.2 && scroll(p, rf, t)) continue;
      if (rf >= 0.012 * S) {
        const q = shape.project(p[0], p[1], p[2]);
        const d = cross([q[3], q[4], q[5]], [rand(-1, 1), rand(-1, 1), rand(-1, 1)]);
        if (palmette(p, d, rf * 1.6, t)) continue;
      }
      const R = rf - GAP;
      occ.add(p[0], p[1], p[2], R, owner++, 0, t);
      if (R > 0.009 * S && rnd() < rosettes) prims.push({ type: ROSETTE, a: p.slice(0, 3), b: [1, 0, 0], R, petals: 5 + Math.floor(rnd() * 4), layers: 2, seed: rnd(), kind: [DAISY, FIVE][Math.floor(rnd() * 2)], ta: t, tb: t + R * 6 });
      else prims.push({ type: BEAD, a: p.slice(0, 3), R: R * 0.85, ta: t, tb: t + 0.01 });
    }
  }
  prims.whole = !mesh.symmetric;
  return prims;
}
