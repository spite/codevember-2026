// Shared by the pattern generators: primitive types, the seeded random sequence, occupancy discs, a walker on the
// surface, surface sampling, symmetry images and hammer blows. Import-free beyond ./noise.js (runs in the worker).

// A stroke or arc drawn from its later end is turned round, so it grows from a (ta) to b (tb).
export const forward = (p) => {
  if (p.ta > p.tb) [p.a, p.b, p.ra, p.rb, p.ta, p.tb] = [p.b, p.a, p.rb, p.ra, p.tb, p.ta];
  return p;
};

export { createNoise } from "./noise.js";

export const STROKE = 0;
export const LEAF = 1;
export const ROSETTE = 2;
export const BEAD = 3;
export const ARC = 4;
export const FROND = 5;
export const BLOSSOM = 6;
// Classic patterns: a strand of knotwork or strapwork, an imbricated scale, a split palmette.
export const RIBBON = 10;
export const SCALE = 11;
export const PALMETTE = 12;
// Geometric primitives. FRET: a straight strap from a to b (half width w, profile kind; each end a square cap ext
// long, a mitre of slope kA / kB, or round);
// ROUNDEL: a turned medallion of concentric rings around a star or polygon (b: its orientation).
export const FRET = 20;
export const ROUNDEL = 21;
export const FLAT = 0, RIBBED = 1, BEADED = 2;
// Alien primitives: a vessel or hose segment, a lumpy nodule (optionally with a pore), a seed pod, a sphincter ring
// around an open orifice, a vertebra.
export const TUBE = 30;
export const NODULE = 31;
export const POD = 32;
export const SPHINCTER = 33;
export const VERTEBRA = 34;
export const VEIN = 0, HOSE = 1, BONE = 2, SEPTA = 3;
// More classic primitives: a unit of a classical border (egg-and-dart, bead-and-reel, running wave, guilloche) and a
// segment of a barbed plume. Their twist (±1) is the handedness of their frame, flipped in mirror images.
export const FRIEZE = 40;
export const FEATHER = 41;
export const EGG = 0, REEL = 1, WAVE = 2, CABLE = 3;
// Engine turning: a panel (a convex quad round a, turned to b) cut with fine ridges: rose-engine rings, a sunburst,
// waves, barleycorn, hobnail (clous de Paris) or spiral rays.
export const GUILLOCHE = 50;
export const ROSE = 0, SUNBURST = 1, WAVES = 2, BARLEYCORN = 3, HOBNAIL = 4, SPIRAL = 5;
// Art Nouveau primitives. BLADE: a smooth lanceolate leaf bent along an arc (LANCE), or a round lily pad notched
// toward its stem (PAD). BLOOM: a poppy seen from above, an iris or a closed bud seen from the side.
export const BLADE = 60;
export const BLOOM = 61;
export const LANCE = 0, PAD = 1;
export const POPPY = 0, IRIS = 1, CLOSED = 2;

// Flower kinds (ROSETTE): daisy, peony, five petals with sepals, chrysanthemum. BLOSSOM kinds: bud, bell, side-view.
export const DAISY = 0, PEONY = 1, FIVE = 2, CHRYS = 3;
export const BUD = 0, BELL = 1, FAN = 2;

export let rnd = Math.random;
export function seedRandom(seed) {
  rnd = mulberry32(seed);
}
export const rand = (a, b) => a + rnd() * (b - a);
export const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Discs that mark the occupied surface, in a dense grid of cells over the shape's bounds.
export class Occupancy {
  constructor(cell, bounds) {
    this.cell = cell;
    this.min = bounds.map((b) => -b - 0.1);
    this.dim = bounds.map((b) => Math.ceil((2 * b + 0.2) / cell));
    this.cells = new Array(this.dim[0] * this.dim[1] * this.dim[2]);
    this.list = [];
    this.x = new Float64Array(1024);
    this.n = 0;
    // Symmetry images (3×3 matrices): every disc is also added at each image, under an owner of its own.
    this.images = [];
  }
  range(v, r, k) {
    const c = this.cell;
    const lo = Math.max(0, Math.floor((v - r - this.min[k]) / c));
    const hi = Math.min(this.dim[k] - 1, Math.floor((v + r - this.min[k]) / c));
    return [lo, hi];
  }
  add(x, y, z, r, owner, s, t) {
    this.addOne(x, y, z, r, owner, s, t);
    this.images.forEach((m, k) => this.addOne(m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z, r, owner + (k + 1) * 1e7, s, t));
  }
  addOne(x, y, z, r, owner, s, t) {
    if ((this.n + 1) * 6 > this.x.length) {
      const g = new Float64Array(this.x.length * 2);
      g.set(this.x);
      this.x = g;
    }
    const id = this.n++;
    this.x.set([x, y, z, r, owner, s], id * 6);
    this.list.push(t);
    // Each disc goes in every cell it overlaps, so a query only looks at the cells it overlaps itself.
    const [i0, i1] = this.range(x, r, 0);
    const [j0, j1] = this.range(y, r, 1);
    const [k0, k1] = this.range(z, r, 2);
    const [dx, dy] = this.dim;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const ci = i + dx * (j + dy * k);
          (this.cells[ci] ??= []).push(id);
        }
  }
  // Drops the discs added since count n (they stay in the cells, with a radius that never hits).
  rollback(n) {
    for (let id = n; id < this.n; id++) this.x[id * 6 + 3] = -1e9;
  }
  // True if a disc is closer than r + its radius. Skips the discs of `owner` within `win` of arc length `s`, and
  // likewise for a second owner (a stem's parent, near where it branched).
  hit(x, y, z, r, owner = -1, s = 0, win = 0, owner2 = -1, s2 = 0, win2 = 0) {
    const [i0, i1] = this.range(x, r, 0);
    const [j0, j1] = this.range(y, r, 1);
    const [k0, k1] = this.range(z, r, 2);
    const [dx, dy] = this.dim;
    const X = this.x;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = this.cells[i + dx * (j + dy * k)];
          if (!b) continue;
          for (let m = 0; m < b.length; m++) {
            const o = b[m] * 6;
            const ow = X[o + 4];
            if (ow === owner && Math.abs(X[o + 5] - s) < win) continue;
            if (ow === owner2 && Math.abs(X[o + 5] - s2) < win2) continue;
            const rr = r + X[o + 3];
            if (rr <= 0) continue;
            const ex = X[o] - x;
            const ey = X[o + 1] - y;
            const ez = X[o + 2] - z;
            if (ex * ex + ey * ey + ez * ez < rr * rr) return true;
          }
        }
    return false;
  }
  // True if a disc of radius r at the point would overlap its own symmetry images (it sits too near a plane or axis).
  selfHit(x, y, z, r) {
    for (const m of this.images) {
      const dx = m[0] * x + m[1] * y + m[2] * z - x;
      const dy = m[3] * x + m[4] * y + m[5] * z - y;
      const dz = m[6] * x + m[7] * y + m[8] * z - z;
      if (dx * dx + dy * dy + dz * dz < 4 * r * r) return true;
    }
    return false;
  }
  // The entries of the discs whose centres are within r.
  near(x, y, z, r) {
    const [i0, i1] = this.range(x, r, 0);
    const [j0, j1] = this.range(y, r, 1);
    const [k0, k1] = this.range(z, r, 2);
    const [dx, dy] = this.dim;
    const X = this.x;
    const out = [];
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = this.cells[i + dx * (j + dy * k)];
          if (!b) continue;
          for (let m = 0; m < b.length; m++) {
            const o = b[m] * 6;
            if (X[o + 3] < 0) continue;
            const dd = (X[o] - x) ** 2 + (X[o + 1] - y) ** 2 + (X[o + 2] - z) ** 2;
            if (dd < r * r) out.push([dd, this.list[b[m]]]);
          }
        }
    return out;
  }
  // The nearest disc's time within r, for the fillers' growth order.
  nearestTime(x, y, z, r) {
    const [i0, i1] = this.range(x, r, 0);
    const [j0, j1] = this.range(y, r, 1);
    const [k0, k1] = this.range(z, r, 2);
    const [dx, dy] = this.dim;
    const X = this.x;
    let best = Infinity;
    let t = null;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const b = this.cells[i + dx * (j + dy * k)];
          if (!b) continue;
          for (let m = 0; m < b.length; m++) {
            const o = b[m] * 6;
            if (X[o + 3] < 0) continue;
            const dd = (X[o] - x) ** 2 + (X[o + 1] - y) ** 2 + (X[o + 2] - z) ** 2;
            if (dd < best) (best = dd), (t = this.list[b[m]]);
          }
        }
    return t;
  }
}

// A point on the surface with its tangent direction, walked by geodesic-ish steps.
export class Walker {
  constructor(shape, p, d) {
    this.shape = shape;
    const q = shape.project(p[0], p[1], p[2]);
    this.p = [q[0], q[1], q[2]];
    this.n = [q[3], q[4], q[5]];
    this.d = [0, 0, 0];
    this.setDir(d);
  }
  clone() {
    const w = Object.create(Walker.prototype);
    w.shape = this.shape;
    w.p = this.p.slice();
    w.n = this.n.slice();
    w.d = this.d.slice();
    return w;
  }
  setDir(d) {
    const n = this.n;
    const k = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    let x = d[0] - n[0] * k;
    let y = d[1] - n[1] * k;
    let z = d[2] - n[2] * k;
    const l = Math.hypot(x, y, z) || 1;
    this.d[0] = x / l;
    this.d[1] = y / l;
    this.d[2] = z / l;
  }
  // The tangent to the left (n × d).
  side() {
    const [nx, ny, nz] = this.n;
    const [dx, dy, dz] = this.d;
    return [ny * dz - nz * dy, nz * dx - nx * dz, nx * dy - ny * dx];
  }
  turn(a) {
    const s = this.side();
    const c = Math.cos(a);
    const si = Math.sin(a);
    this.setDir([this.d[0] * c + s[0] * si, this.d[1] * c + s[1] * si, this.d[2] * c + s[2] * si]);
  }
  // Turns by curvature k (positive = left) over the step h, moves, and projects back.
  step(h, k = 0) {
    this.turn(k * h * 0.5);
    const q = this.shape.project(this.p[0] + this.d[0] * h, this.p[1] + this.d[1] * h, this.p[2] + this.d[2] * h);
    this.p = [q[0], q[1], q[2]];
    this.n = [q[3], q[4], q[5]];
    this.setDir(this.d);
    this.turn(k * h * 0.5);
  }
  offset(dist) {
    const s = this.side();
    const w = this.clone();
    const q = this.shape.project(this.p[0] + s[0] * dist, this.p[1] + s[1] * dist, this.p[2] + s[2] * dist);
    w.p = [q[0], q[1], q[2]];
    w.n = [q[3], q[4], q[5]];
    w.setDir(this.d);
    return w;
  }
}

export function randomDir() {
  const z = rand(-1, 1);
  const a = rand(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}

// The points of a lattice of spacing `step` over the shape's bounds that lie within step·0.6 (L1) of the surface,
// projected onto it, in lattice order. With shape.sdf (a bound: |sdf| ≤ the distance), each row skips ahead as
// far as the bound allows, as in sphere tracing.
export function surfaceLattice(shape, step) {
  const samples = [];
  const bb = shape.bounds;
  const near = step * 0.6;
  const sdf = shape.sdf;
  for (let x = -bb[0] - step; x <= bb[0] + step; x += step)
    for (let y = -bb[1] - step; y <= bb[1] + step; y += step) {
      let skip = 0;
      for (let z = -bb[2] - step; z <= bb[2] + step; z += step) {
        if (sdf) {
          if (skip-- > 0) continue;
          const d = Math.abs(sdf.call(shape, x, y, z));
          if (d >= near) {
            skip = Math.floor((d - near) / step);
            continue;
          }
        }
        const q = shape.project(x, y, z);
        if (Math.abs(x - q[0]) + Math.abs(y - q[1]) + Math.abs(z - q[2]) < near) samples.push(q);
      }
    }
  return samples;
}

// Where the ray from shape.radial (a centre the blank is star-shaped about) toward p leaves the surface: lays grids
// on blanks whose closest-point projection would bunch them into the hollows.
export function radialPoint(shape, p) {
  const c = shape.radial;
  const d = norm([p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  let t = Math.hypot(...shape.bounds) * 1.2;
  for (let i = 0; i < 200; i++) {
    const s = shape.sdf(c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t);
    if (Math.abs(s) < 1e-5) break;
    t -= s;
  }
  return [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t];
}

// Random points spread evenly over the surface (dart throwing on projected random points).
export function surfacePoint(shape) {
  const b = shape.bounds;
  for (;;) {
    const p = [rand(-b[0], b[0]) * 1.2, rand(-b[1], b[1]) * 1.2, rand(-b[2], b[2]) * 1.2];
    // A blank that fills little of its bounds (sparse: how near a point must be) rules out the rest by its sdf.
    if (shape.sparse && Math.abs(shape.sdf(p[0], p[1], p[2])) >= shape.sparse) continue;
    const q = shape.project(p[0], p[1], p[2]);
    // Rejects most of the points that projection would bunch up (the box's rounded edges, the torus' inside).
    const dist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    // A point deep inside can project off the surface (the box's core): it must project onto itself.
    const r = shape.project(q[0], q[1], q[2]);
    if (dist < 0.25 && Math.abs(r[0] - q[0]) + Math.abs(r[1] - q[1]) + Math.abs(r[2] - q[2]) < 1e-6) return q;
  }
}

// Points on the surface on a jittered lattice of the given step, shuffled: only the coarse cells the surface passes
// through are refined.
export function jitteredLattice(shape, step, jitter = 0.3) {
  const out = [];
  const bb = shape.bounds;
  const C = step * 8;
  for (let X = -bb[0] - C; X <= bb[0] + C; X += C)
    for (let Y = -bb[1] - C; Y <= bb[1] + C; Y += C)
      for (let Z = -bb[2] - C; Z <= bb[2] + C; Z += C) {
        const c = shape.project(X + C / 2, Y + C / 2, Z + C / 2);
        if (Math.hypot(X + C / 2 - c[0], Y + C / 2 - c[1], Z + C / 2 - c[2]) > C * 0.9) continue;
        for (let x = X; x < X + C - 1e-9; x += step)
          for (let y = Y; y < Y + C - 1e-9; y += step)
            for (let z = Z; z < Z + C - 1e-9; z += step) {
              const jx = x + rand(-jitter, jitter) * step, jy = y + rand(-jitter, jitter) * step, jz = z + rand(-jitter, jitter) * step;
              if (shape.sparse && Math.abs(shape.sdf(jx, jy, jz)) >= step * 0.8) continue;
              const q = shape.project(jx, jy, jz);
              if (Math.abs(x - q[0]) + Math.abs(y - q[1]) + Math.abs(z - q[2]) < step * 0.8) out.push([q[0], q[1], q[2]]);
            }
      }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The symmetry group's elements other than the identity, as row-major 3×3 matrices (with .det), generated by
// reflections in planes through the centre. The rounded box only has 3-fold symmetry about its diagonal.
export function symmetryImages(kind, shape) {
  const H = (n) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    const [a, b, c] = n.map((v) => v / l);
    return [1 - 2 * a * a, -2 * a * b, -2 * a * c, -2 * b * a, 1 - 2 * b * b, -2 * b * c, -2 * c * a, -2 * c * b, 1 - 2 * c * c];
  };
  const fold = (n) => [H([1, 0, 0]), H([Math.cos(Math.PI / n), 0, Math.sin(Math.PI / n)])];
  const box = shape.h !== undefined;
  // A shape can list the groups it has (shape.symmetries: kind → generators); any other kind is none.
  const gens = shape.symmetries ? shape.symmetries[kind] ?? [] : {
    none: [],
    mirror: [H([1, 0, 0])],
    "2 planes": [H([1, 0, 0]), H([0, 0, 1])],
    "3 planes": [H([1, 0, 0]), H([0, 1, 0]), H([0, 0, 1])],
    "3-fold": box ? [H([1, -1, 0]), H([0, 1, -1])] : fold(3),
    "4-fold": fold(4),
    "6-fold": box ? [H([1, -1, 0]), H([0, 1, -1]), H([1, 0, 0])] : fold(6),
  }[kind] ?? [];
  const mul = (a, b) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  const key = (m) => m.map((v) => Math.round(v * 1e4)).join();
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const group = new Map([[key(I), I]]);
  const queue = [I];
  while (queue.length) {
    const m = queue.pop();
    for (const g of gens) {
      const n = mul(g, m);
      const k = key(n);
      if (!group.has(k)) group.set(k, n), queue.push(n);
    }
  }
  group.delete(key(I));
  return [...group.values()].map((m) => {
    m.det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    return m;
  });
}

// True if p lies in the fundamental domain of the symmetry images: closer to a generic point than to any of its images.
const GENERIC = [0.3141, 0.5297, 0.7863];
export function inDomain(p, images) {
  const g = GENERIC;
  const d0 = (p[0] - g[0]) ** 2 + (p[1] - g[1]) ** 2 + (p[2] - g[2]) ** 2;
  for (const m of images) {
    const x = m[0] * g[0] + m[1] * g[1] + m[2] * g[2];
    const y = m[3] * g[0] + m[4] * g[1] + m[5] * g[2];
    const z = m[6] * g[0] + m[7] * g[1] + m[8] * g[2];
    if ((p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2 < d0 - 1e-9) return false;
  }
  return true;
}
export const applyImage = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

// Hammer blows over the whole blank, ordered as a path; each primitive is raised by the first blow over it.
export function hammerBlows(shape, prims, S) {
  const count = Math.max(24, Math.min(96, Math.round(shape.area * 5)));
  const pts = [];
  for (let tries = 0; pts.length < count && tries < count * 40; tries++) {
    const q = surfacePoint(shape);
    const minD = Math.sqrt(shape.area / count) * 0.75;
    if (pts.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < minD)) continue;
    pts.push(q);
  }
  // Greedy nearest-neighbour tour, so the hammer works its way across.
  const order = [pts.pop()];
  while (pts.length) {
    const last = order[order.length - 1];
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1], pts[i][2] - last[2]);
      if (d < bd) (bd = d), (best = i);
    }
    order.push(pts.splice(best, 1)[0]);
  }
  const spacing = Math.sqrt(shape.area / count);
  const blows = order.map((q, i) => ({
    p: [q[0], q[1], q[2]],
    n: [q[3], q[4], q[5]],
    R: spacing * rand(0.85, 1.25),
    depth: rand(0.5, 1),
    t: (i + rand(-0.3, 0.3)) / order.length,
  }));
  blows.sort((a, b) => a.t - b.t);
  blows.forEach((b) => (b.t = Math.max(0.002, Math.min(1, b.t))));
  for (const p of prims) {
    let t = 1;
    let bd = Infinity;
    let tn = 1;
    for (const b of blows) {
      const d = (p.a[0] - b.p[0]) ** 2 + (p.a[1] - b.p[1]) ** 2 + (p.a[2] - b.p[2]) ** 2;
      if (d < b.R * b.R) t = Math.min(t, b.t);
      if (d < bd) (bd = d), (tn = b.t);
    }
    p.th = t < 1 ? t : tn;
  }
  return blows;
}

