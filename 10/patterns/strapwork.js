// Voronoi strapwork: Poisson sites over the blank, the edges of their Voronoi cells raised as ribbed straps riveted
// with a boss at every junction. Each cell holds a turned medallion at its centre (faceted star, gadrooned boss or
// stepped terraces, its fold matching the cell's corners), and nested fillets following its outline, broken off
// around the medallion, fill the corners. Laid out as a wave from one point, straps first, then each cell's contents.
import { FRET, ROUNDEL, BEAD, RIBBED, FLAT, BEADED, rnd, Occupancy, surfacePoint } from "../kit.js";

/*
 * opts: scale, fill (0..1: how much of each cell the medallion takes), rosettes (0..1: medallions in more cells).
 */
export function strapwork(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const fill = opts.fill ?? 0.7;
  const rosettes = opts.rosettes ?? 0.5;
  const D = 0.12 * S;
  const WS = 0.0065 * S;
  const WT = 0.0024 * S;
  const GAP = 0.0036 * S;
  const images = kit.images;
  const prims = [];
  const strapKind = rnd() < 0.7 ? RIBBED : FLAT;
  const mapI = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Sites by dart throwing, each with its symmetry images, so the diagram itself is symmetric.
  const sites = [];
  const hash = new Occupancy(D, shape.bounds);
  const count = Math.round((shape.area / (D * D)) * 1.1);
  for (let tries = 0; tries < count * 30 && sites.length < count * (images.length + 1); tries++) {
    const q = surfacePoint(shape);
    const p = [q[0], q[1], q[2]];
    if (hash.hit(p[0], p[1], p[2], D * 0.5)) continue;
    const orbit = [p];
    let ok = true;
    for (const m of images) {
      const r = mapI(m, p);
      const dmin = Math.min(...orbit.map((o) => dist(o, r)));
      if (dmin < 1e-6) continue;
      if (dmin < D * 0.8) ok = false;
      orbit.push(r);
    }
    if (!ok) continue;
    for (const o of orbit) {
      const s = shape.project(o[0], o[1], o[2]);
      hash.add(s[0], s[1], s[2], D * 0.5, 0, 0, sites.length);
      sites.push({ p: [s[0], s[1], s[2]], n: [s[3], s[4], s[5]] });
    }
  }

  // Prims are emitted once per orbit: ornament.js copies them to the images.
  const taken = new Occupancy(D * 0.25, shape.bounds);
  const tol = D * 0.02;
  function claim(c, r = tol) {
    if (taken.near(c[0], c[1], c[2], r).length) return false;
    taken.addOne(c[0], c[1], c[2], 0, 0, 0, 1);
    for (const m of images) {
      const r = mapI(m, c);
      taken.addOne(r[0], r[1], r[2], 0, 0, 0, 1);
    }
    return true;
  }

  // The drawing spreads from one point over the blank, in units of D.
  const origin = sites.length ? sites[Math.floor(rnd() * sites.length)].p : [0, 0, 1];
  const when = (p) => dist(p, origin) / D;

  for (let i = 0; i < sites.length; i++) {
    const { p, n } = sites[i];
    const T = norm(cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n));
    const B = cross(n, T);
    // The cell in the tangent plane, by clipping a square with the bisector of each neighbour.
    const planes = [];
    // (A disc is listed once per grid cell it overlaps.)
    for (const j of new Set(hash.near(p[0], p[1], p[2], D * 3.2).map((e) => e[1]))) {
      if (j === i || dot(sites[j].n, n) < -0.6) continue;
      const d = sub(sites[j].p, p);
      const a = dot(d, T);
      const b = dot(d, B);
      const l = Math.hypot(a, b);
      if (l < 1e-9) continue;
      // Round a fold (a neighbour facing well away) the bisector goes at half the distance, as if unrolled.
      const c = dot(sites[j].n, n) < 0.8 ? Math.sqrt(dot(d, d)) / 2 : dot(d, d) / 2 / l;
      planes.push({ a: a / l, b: b / l, c, j });
    }
    const cell = clip(planes, 0);
    if (cell.length < 3) continue;
    // A cell left open (where the neighbours lie round a fold) is cut back to a disc.
    const cut = (poly) => {
      for (const v of poly) {
        const r = Math.hypot(v.x, v.y);
        if (r > D * 1.6) (v.x *= (D * 1.6) / r), (v.y *= (D * 1.6) / r);
      }
      return poly;
    };
    cut(cell);
    const lift = ({ x, y }) => {
      const q = shape.project(p[0] + T[0] * x + B[0] * y, p[1] + T[1] * x + B[1] * y, p[2] + T[2] * x + B[2] * y);
      return [q[0], q[1], q[2]];
    };
    const verts = cell.map(lift);
    const tc = when(p);

    // Straps, each once (from the lower site), and a boss at each junction.
    for (let k = 0; k < cell.length; k++) {
      const j = cell[k].j;
      const a = verts[k];
      const b = verts[(k + 1) % cell.length];
      if (j < 0 || j < i) continue;
      if (!claim([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])) continue;
      const [s0, s1] = when(a) <= when(b) ? [a, b] : [b, a];
      prims.push({ type: FRET, a: s0, b: s1, w: WS, ext: -1, extB: -1, kind: strapKind, ta: when(s0), tb: when(s1), h: 1 });
    }
    for (const v of verts) {
      if (!claim(v, D * 0.12)) continue;
      prims.push({ type: BEAD, a: v, R: WS * 1.6, ta: when(v) + 0.05, tb: when(v) + 0.1, h: 1 });
    }

    // Fillets following the outline, nested inward and broken off around the medallion, so the corners fill
    // with chevrons.
    if (!claim(p)) continue;
    const step = 2 * WT + GAP * 1.1;
    const d1 = WS + GAP * 1.5 + WT;
    let rin = Infinity;
    for (const pl of planes) rin = Math.min(rin, pl.c);
    const R = (rin - d1 - WT - GAP) * (0.8 + 0.2 * fill);
    const keep = R + GAP + WT;
    for (let m = 0, off = d1; m < 8; m++, off += step) {
      // Fillets of open cells are cut back too.
      const poly = cut(clip(planes, off));
      if (poly.length < 3) break;
      let any = false;
      for (let k = 0; k < poly.length; k++) {
        const u = poly[k];
        const v = poly[(k + 1) % poly.length];
        for (const [t0, t1] of outside(u, v, m === 0 ? 0 : keep)) {
          const len = Math.hypot(v.x - u.x, v.y - u.y) * (t1 - t0);
          if (len < WT * 2) continue;
          any = true;
          const a = lift({ x: u.x + (v.x - u.x) * t0, y: u.y + (v.y - u.y) * t0 });
          const b = lift({ x: u.x + (v.x - u.x) * t1, y: u.y + (v.y - u.y) * t1 });
          const ta = tc + 0.3 + m * 0.12 + (k / poly.length) * 0.2;
          prims.push({ type: FRET, a, b, w: WT, ext: -1, extB: -1, kind: BEADED, ta, tb: ta + 0.2 / poly.length, h: 1.5 });
        }
      }
      if (!any) break;
    }

    // The medallion.
    if (R < D * 0.06) continue;
    const big = R > D * 0.13;
    const N = cell.length;
    const v0 = cell[0];
    const ax = norm([T[0] * v0.x + B[0] * v0.y, T[1] * v0.x + B[1] * v0.y, T[2] * v0.x + B[2] * v0.y]);
    // Star points toward the corners; a cell with few corners gets twice as many.
    const points = N <= 5 ? N * 2 : N;
    const kind = rnd() < rosettes ? 0 : rnd() < 0.5 ? 1 : 2;
    prims.push({ type: ROUNDEL, a: p.slice(), b: ax, R, points, kind: big ? kind : 1, seed: rnd(), pearls: big && rnd() < 0.5 ? 1 : 0, ta: tc + 0.6, tb: tc + 1.2, h: 1 });
  }
  return prims;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// The parts of segment u→v outside the circle of radius r about the origin, as [t0, t1] ranges.
function outside(u, v, r) {
  const dx = v.x - u.x;
  const dy = v.y - u.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (u.x * dx + u.y * dy);
  const c = u.x * u.x + u.y * u.y - r * r;
  const disc = b * b - 4 * a * c;
  if (r <= 0 || disc <= 0) return [[0, 1]];
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  const out = [];
  if (t1 > 0) out.push([0, Math.min(1, t1)]);
  if (t2 < 1) out.push([Math.max(0, t2), 1]);
  return out;
}

// A convex polygon {x, y, j} (j: the neighbour whose bisector makes the edge from this vertex to the next, -1 for the
// starting square) from half-planes a x + b y <= c - inset.
function clip(planes, inset) {
  const L = 10;
  let poly = [
    { x: -L, y: -L, j: -1 },
    { x: L, y: -L, j: -1 },
    { x: L, y: L, j: -1 },
    { x: -L, y: L, j: -1 },
  ];
  for (const pl of planes) {
    const c = pl.c - inset;
    const out = [];
    const f = (v) => pl.a * v.x + pl.b * v.y - c;
    for (let k = 0; k < poly.length; k++) {
      const u = poly[k];
      const v = poly[(k + 1) % poly.length];
      const fu = f(u);
      const fv = f(v);
      if (fu <= 0) out.push(u);
      if (fu <= 0 !== fv <= 0) {
        const t = fu / (fu - fv);
        // Entering the half-plane, the new edge runs along the bisector; leaving it, along u→v's own.
        out.push({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t, j: fu <= 0 ? pl.j : u.j });
      }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}
