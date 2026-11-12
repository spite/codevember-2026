// Roller chain: sprocket geometry, a closed chain loop over 2-3 sprockets, and link geometry for instancing.
import { Matrix4, ShapeUtils, Vector2 } from "three";
import { delaunayFlip } from "./wear.js";

const TAU = Math.PI * 2;

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bisect(f, a, b, n = 48) {
  let fa = f(a);
  for (let k = 0; k < n; k++) {
    const c = (a + b) / 2, fc = f(c);
    if ((fc > 0) === (fa > 0)) { a = c; fa = fc; } else b = c;
  }
  return (a + b) / 2;
}

/**
 * ANSI-like chain proportions for a pitch p: roller radius, inner width (between inner plates), plate thickness
 * and heights, pin radius, seat radius (roller + clearance) and the default sprocket width.
 */
export function chainDimensions(pitch) {
  const p = pitch;
  return {
    pitch: p, rollerRadius: 0.3125 * p, seatRadius: 0.3125 * p + 0.02 * p, innerWidth: 0.625 * p,
    plate: 0.12 * p, plateGap: 0.006 * p, innerHeight: 0.94 * p, outerHeight: 0.86 * p, pinRadius: 0.156 * p,
    sprocketWidth: 0.55 * p,
  };
}

export const sprocketPitchRadius = (teeth, pitch) => pitch / (2 * Math.sin(Math.PI / teeth));

// ---------------------------------------------------------------- mesh building

class MeshBuilder {
  constructor() { this.p = []; this.i = []; }
  v(x, y, z) { this.p.push(x, y, z); return this.p.length / 3 - 1; }
  t(a, b, c) {
    const p = this.p;
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-30) return;
    this.i.push(a, b, c);
  }
  q(a, b, c, d) {
    const p = this.p, l = (i, j) => (p[3 * i] - p[3 * j]) ** 2 + (p[3 * i + 1] - p[3 * j + 1]) ** 2 + (p[3 * i + 2] - p[3 * j + 2]) ** 2;
    if (l(a, c) <= l(b, d)) { this.t(a, b, c); this.t(a, c, d); } else { this.t(a, b, d); this.t(b, c, d); }
  }
  // Appends another builder's triangles (for multi-solid link geometry).
  merge(o) {
    const base = this.p.length / 3;
    this.p.push(...o.p);
    for (const v of o.i) this.i.push(v + base);
  }
  finish() {
    const remap = new Int32Array(this.p.length / 3).fill(-1), p = [];
    const idx = this.i.map((v) => {
      if (remap[v] < 0) { remap[v] = p.length / 3; p.push(this.p[3 * v], this.p[3 * v + 1], this.p[3 * v + 2]); }
      return remap[v];
    });
    const n = new Float32Array(p.length);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k], b = idx[k + 1], c = idx[k + 2];
      const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
      const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { n[3 * v] += cx; n[3 * v + 1] += cy; n[3 * v + 2] += cz; }
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return { position: new Float32Array(p), normal: n, index: new Uint32Array(idx), triangles: idx.length / 3 };
  }
}

// Quads between consecutive rows of a closed loop (CCW rows bottom to top face outward); crease[i] splits normals.
function sweep(mesh, rows, crease) {
  const n = rows[0].length, cin = [], cout = [];
  for (let i = 0; i < n; i++) {
    cin[i] = rows.map((row) => mesh.v(...row[i]));
    cout[i] = crease && crease[i] ? rows.map((row) => mesh.v(...row[i])) : cin[i];
  }
  for (let i = 0; i < n; i++) {
    const A = cout[i], B = cin[(i + 1) % n];
    for (let k = 0; k < rows.length - 1; k++) mesh.q(A[k], B[k], B[k + 1], A[k + 1]);
  }
}

// Each segment of the (r, z) path is its own smoothing group; the solid lies to the left of the walking direction.
function lathe(mesh, angles, path) {
  const ring = ([r, z]) => angles.map((a) => [r * Math.cos(a), r * Math.sin(a), z]);
  for (let k = 0; k < path.length - 1; k++) {
    const [r0, z0] = path[k], [r1, z1] = path[k + 1];
    if (Math.abs(r1 - r0) + Math.abs(z1 - z0) < 1e-12) continue;
    sweep(mesh, [ring(path[k]), ring(path[k + 1])]);
  }
}

function creases(xy, limit = 0.6) {
  const n = xy.length;
  return xy.map((p, i) => {
    const a = xy[(i + n - 1) % n], b = xy[(i + 1) % n];
    const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
    return (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1) < Math.cos(limit);
  });
}

// Flat cap of 2D triangles at z; up = normal +z.
function cap(mesh, xy, tris, z, up) {
  const ids = xy.map(([x, y]) => mesh.v(x, y, z));
  for (const [a, b, c] of tris) {
    const area = (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[c][0] - xy[a][0]) * (xy[b][1] - xy[a][1]);
    if ((area > 0) === up) mesh.t(ids[a], ids[b], ids[c]);
    else mesh.t(ids[a], ids[c], ids[b]);
  }
}

// ---------------------------------------------------------------- sprocket profile

// Samples of half a tooth, from the seat bottom up to the tip centre (exclusive).
const SEAT = 6, FLANK = 8, FILLET = 3, TIP = 3, HALF = SEAT + FLANK + FILLET + TIP, PER = 2 * HALF;
const TIP_FILLET = 0.015; // tip corner radius of a clean sprocket, in pitches

function toothForm({ teeth: N, pitch: p, seatRadius, tipRadius }) {
  const d2 = Math.PI / N, R = sprocketPitchRadius(N, p);
  const cmx = R * Math.cos(d2), cmy = -R * Math.sin(d2), cpx = cmx, cpy = -cmy;
  // Corner of the region inset by D: flank angle b where the flank meets the tip circle (or the tooth gets too thin).
  const corner = (D) => {
    const rho = p - seatRadius - D, at = (b) => [cpx + rho * Math.cos(b), cpy + rho * Math.sin(b)];
    const bThin = bisect((b) => at(b)[1] + 0.04 * p, -Math.PI / 2, 0);
    const tipR = Math.min(tipRadius - D, Math.hypot(...at(bThin)));
    const b = bisect((b) => Math.hypot(...at(b)) - tipR, -Math.PI / 2, bThin);
    return { b, F: at(b) };
  };
  // Lower half of tooth 0: seat and flank samples inset by d[i], the tip zone by dT with corner radius rf
  // (the region inset by dT + rf, grown back by rf).
  const half = (d, dT, rf) => {
    const { b, F } = corner(dT + rf), aF = Math.atan2(F[1], F[0]), out = [];
    for (let i = 0; i < SEAT; i++) {
      const psi = Math.PI - d2 - (i / SEAT) * (Math.PI / 2 - d2), rs = seatRadius + d[i];
      out.push([cmx + rs * Math.cos(psi), cmy + rs * Math.sin(psi)]);
    }
    for (let i = 0; i < FLANK; i++) {
      const beta = -Math.PI / 2 + (i / FLANK) * (b + Math.PI / 2), rho = p - seatRadius - d[SEAT + i];
      out.push([cpx + rho * Math.cos(beta), cpy + rho * Math.sin(beta)]);
    }
    for (let i = 0; i < FILLET; i++) { const f = b + (i / FILLET) * (aF - b); out.push([F[0] + rf * Math.cos(f), F[1] + rf * Math.sin(f)]); }
    const tr = Math.hypot(...F) + rf;
    for (let i = 0; i < TIP; i++) { const g = aF * (1 - i / TIP); out.push([tr * Math.cos(g), tr * Math.sin(g)]); }
    return { pts: out, tipR: tr };
  };
  return { R, half };
}

// Whole outline (CCW): per tooth k and side (-1 lower, +1 upper), d(k, side) -> per-sample insets, tip(k, side) -> { dT, rf }.
function buildOutline(form, N, d, tip) {
  const out = [];
  for (let k = 0; k < N; k++) {
    const lo = tip(k, -1), hi = tip(k, 1);
    const L = form.half(d(k, -1), lo.dT, lo.rf), U = form.half(d(k, 1), hi.dT, hi.rf);
    const a = (TAU * k) / N, c = Math.cos(a), sn = Math.sin(a), rot = ([x, y]) => [x * c - y * sn, x * sn + y * c];
    for (const q of L.pts) out.push(rot(q));
    out.push(rot([Math.min(L.tipR, U.tipR), 0]));
    for (let i = HALF - 1; i >= 1; i--) out.push(rot([U.pts[i][0], -U.pts[i][1]]));
  }
  return out;
}

/** 2D outline (CCW, [x, y]) of a clean sprocket at theta = 0, inset by `inset` (scene units); tooth 0 centred on +x. */
export function sprocketProfile(teeth, pitch, { inset = 0 } = {}) {
  const form = toothForm({ teeth, pitch, seatRadius: chainDimensions(pitch).seatRadius, tipRadius: defaultTip(teeth, pitch) });
  const d = new Array(HALF).fill(inset);
  return buildOutline(form, teeth, () => d, () => ({ dT: inset, rf: TIP_FILLET * pitch }));
}

const defaultTip = (N, p) => p * (0.3 + 0.5 / Math.tan(Math.PI / N));

/**
 * Roller-chain sprocket, axis +z, face from -width/2 to width/2. Tooth 0 is centred on +x, so seat k (a tooth gap,
 * where a roller sits) is at angle (k + 0.5) * 2PI / teeth on the pitch circle (radius pitch / (2 sin(PI / teeth))).
 * Seats are circular arcs (roller radius + clearance); each flank is an arc centred on the neighbouring seat, so a
 * roller swinging about its neighbour clears it.
 * chamfer: bevel of the cap edges (outline and bore), scene units. erosion: amount 0..1 (true = 1) or { amount, seed },
 * removal only. The default bore depends on the teeth and pitch only.
 */
export function sprocket({ teeth: N, pitch: p = 0.05, width, bore, chamfer, erosion, seed } = {}) {
  const dims = chainDimensions(p);
  width = width ?? dims.sprocketWidth;
  chamfer = Math.max(0, Math.min(chamfer ?? 0.04 * p, 0.2 * width, 0.06 * p));
  const ero = erosion === true ? { amount: 1 } : typeof erosion === "number" ? { amount: erosion } : erosion ? { ...erosion, amount: erosion.amount ?? 1 } : { amount: 0 };
  const A = Math.max(0, Math.min(1, Number(ero.amount) || 0));
  const rng = mulberry32(ero.seed ?? seed ?? N * 7919 + 3);
  const seatRadius = dims.seatRadius, tipRadius = defaultTip(N, p);
  const form = toothForm({ teeth: N, pitch: p, seatRadius, tipRadius });
  const R = form.R, rootR = R - seatRadius;
  const m = p / Math.PI;

  // Insets as smooth functions of arc length: wall (noise; worn, rounded tips) and caps (chamfer, noise, chips).
  const clean = sprocketProfile(N, p), n = clean.length, arc = [0];
  for (let j = 1; j <= n; j++) arc.push(arc[j - 1] + Math.hypot(clean[j % n][0] - clean[j - 1][0], clean[j % n][1] - clean[j - 1][1]));
  const total = arc[n];
  // Integer cycles per loop, wavelengths between lmin and lmax.
  const waves = (count, lmin, lmax) => Array.from({ length: count }, () => ({ f: Math.max(1, Math.round(total / (lmin + (lmax - lmin) * rng()))), ph: rng() * TAU, a: 0.5 + rng() }));
  const noise = (w, j) => w.reduce((acc, { f, ph, a }) => acc + a * (0.5 + 0.5 * Math.sin((TAU * f * arc[j]) / total + ph)), 0) / w.reduce((acc, x) => acc + x.a, 0);
  const wallWaves = waves(4, 0.5 * p, 3 * p), topWaves = waves(5, 0.4 * p, 2 * p), botWaves = waves(5, 0.4 * p, 2 * p);
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const index = (k, side, i) => k * PER + (side < 0 ? i : (PER - i) % PER) + (side > 0 && i === 0 ? PER : 0);
  const tips = new Map();
  for (let k = 0; k < N; k++) for (const side of [-1, 1]) {
    const chip = rng() < 0.25 * A ? { top: rng() < 0.5, depth: (0.04 + 0.08 * rng()) * p } : null;
    tips.set(k * 2 + (side > 0), { wear: A * (0.3 + 0.7 * rng()), chip });
  }
  const outline = (layer) => {
    const waveSet = layer === "top" ? topWaves : botWaves;
    const dAt = (j) => {
      const w = A * 0.012 * p * noise(wallWaves, j % n);
      return layer === "wall" ? w : w + chamfer + A * 0.03 * p * noise(waveSet, j % n);
    };
    const tip = (k, side) => {
      const t = tips.get(k * 2 + (side > 0)), j = index(k, side, SEAT + FLANK);
      let dT = dAt(j) + t.wear * 0.02 * p;
      if (layer !== "wall" && t.chip && t.chip.top === (layer === "top")) dT += t.chip.depth;
      // The region inset by dT + rf must keep a tooth: its flank start is only p / 2 - seatRadius thick.
      const Dmax = p / 2 - seatRadius - 0.05 * p;
      dT = Math.min(dT, Dmax - TIP_FILLET * p);
      return { dT, rf: Math.min((TIP_FILLET + 0.06 * t.wear) * p, Dmax - dT) };
    };
    const d = (k, side) => {
      const { dT } = tip(k, side);
      return Array.from({ length: HALF }, (_, i) => {
        const v = dAt(index(k, side, i));
        return i < SEAT ? v : v + (dT - v) * smooth(((i - SEAT) / FLANK - 0.2) / 0.6);
      });
    };
    return buildOutline(form, N, d, tip);
  };
  const wall = outline("wall"), capTop = outline("top"), capBot = outline("bottom");
  // Chamfer depth along z matches the radial inset (45 degrees).
  const depth = (o) => o.map((q, j) => Math.min(Math.hypot(wall[j][0] - q[0], wall[j][1] - q[1]), 0.3 * width));
  const dTop = depth(capTop), dBot = depth(capBot);
  const dWall = wall.map((q, j) => Math.hypot(clean[j][0] - q[0], clean[j][1] - q[1]));

  const mesh = new MeshBuilder(), hw = width / 2;
  const wallCr = creases(wall);
  sweep(mesh, [
    capBot.map(([x, y]) => [x, y, -hw]),
    wall.map(([x, y], j) => [x, y, -hw + dBot[j]]),
    wall.map(([x, y], j) => [x, y, hw - dTop[j]]),
    capTop.map(([x, y]) => [x, y, hw]),
  ], wallCr);

  // Face annulus between the bore and a circle below the seats: polar grid, finer when eroded (craters).
  const maxInset = Math.max(...dWall) + Math.max(...dTop, ...dBot);
  const rc = rootR - maxInset - 0.12 * p, rcClean = rootR - 0.12 * p;
  let boreR = bore ?? Math.min(0.3 * rcClean, 0.5 * p + 0.1 * rcClean);
  boreR = Math.max(0, Math.min(boreR, rc - 2 * chamfer - 0.2 * p));
  const cb = boreR > 0 ? Math.min(chamfer, 0.3 * boreR) : 0, r0 = boreR + cb;
  const span = rc - r0;
  let K = Math.max(64, Math.round(N * 4)), rows = 1;
  if (A > 0) {
    const h = Math.max(0.04 * p, Math.sqrt((Math.PI * (rc * rc - r0 * r0)) / 3200));
    rows = Math.max(2, Math.ceil(span / h));
    K = Math.max(K, Math.ceil((TAU * rc) / h));
  }
  const angles = Array.from({ length: K }, (_, k) => (TAU * k) / K);
  // Craters kept apart, so each stays a separate pit of its own size.
  const craters = (count) => {
    const out = [], gap = Math.max(0.3 * m, 2.5 * Math.max(span / rows, (TAU * rc) / K));
    for (let k = 0; k < count; k++) {
      const rad = Math.min((0.25 + 1.75 * rng() ** 2) * m, 0.45 * span);
      if (rad < 0.1 * m) continue;
      const rr = r0 + rad + rng() * Math.max(0, span - 2 * rad), a = rng() * TAU, depth = A * width * (0.04 + 0.11 * rng()) * Math.min(1, rad / m);
      const c = { x: rr * Math.cos(a), y: rr * Math.sin(a), rad, depth };
      if (out.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > o.rad + rad + gap)) out.push(c);
    }
    return out;
  };
  const area = Math.PI * (rc * rc - r0 * r0);
  const nCr = Math.round(A * area / (m * m) * 0.25);
  const cell = 4 * m, bucket = (list) => {
    const map = new Map();
    for (const c of list) for (let i = Math.floor((c.x - c.rad) / cell); i <= Math.floor((c.x + c.rad) / cell); i++)
      for (let j = Math.floor((c.y - c.rad) / cell); j <= Math.floor((c.y + c.rad) / cell); j++) {
        const k = i * 4096 + j;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(c);
      }
    return map;
  };
  const cratersTop = bucket(craters(nCr)), cratersBot = bucket(craters(nCr));
  const depthAt = (map, x, y) => {
    let d = 0;
    for (const c of map.get(Math.floor(x / cell) * 4096 + Math.floor(y / cell)) || []) {
      const q = ((x - c.x) ** 2 + (y - c.y) ** 2) / (c.rad * c.rad);
      if (q < 1) d = Math.max(d, c.depth * (1 - q) * (1 - q));
    }
    return d;
  };
  // Polar grid of the face; a solid centre (r0 = 0) is a fan from its first ring to one centre vertex.
  const grid = (z, up, list) => {
    const ids = [];
    for (let r = r0 > 0 ? 0 : 1; r <= rows; r++) {
      const rho = r0 + (span * r) / rows;
      ids.push(angles.map((a) => {
        const x = rho * Math.cos(a), y = rho * Math.sin(a);
        const d = r === 0 || r === rows ? 0 : depthAt(list, x, y);
        return mesh.v(x, y, up ? z - d : z + d);
      }));
    }
    for (let r = 0; r < ids.length - 1; r++) for (let k = 0; k < K; k++) {
      const a = ids[r][k], b = ids[r][(k + 1) % K], c = ids[r + 1][(k + 1) % K], d = ids[r + 1][k];
      if (up) mesh.q(a, d, c, b); else mesh.q(a, b, c, d);
    }
    if (r0 > 0) return;
    const o = mesh.v(0, 0, z);
    for (let k = 0; k < K; k++) up ? mesh.t(o, ids[0][k], ids[0][(k + 1) % K]) : mesh.t(o, ids[0][(k + 1) % K], ids[0][k]);
  };
  grid(hw, true, cratersTop);
  grid(-hw, false, cratersBot);
  // Tooth band between the cap outline and the grid circle.
  const circle = angles.map((a) => [rc * Math.cos(a), rc * Math.sin(a)]), hole = circle.map(([x, y]) => new Vector2(x, y)).reverse();
  for (const [edge, z, up] of [[capTop, hw, true], [capBot, -hw, false]]) {
    const xy = [...edge, ...circle], last = xy.length - 1;
    const tris = ShapeUtils.triangulateShape(edge.map(([x, y]) => new Vector2(x, y)), [hole]).map((t) => t.map((i) => (i < n ? i : last - (i - n))));
    const ar = ([a, b, c]) => (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[c][0] - xy[a][0]) * (xy[b][1] - xy[a][1]);
    // Flips earcut's needles at nearly straight runs of the outline, whose float32 vertices can poke through the band.
    cap(mesh, xy, delaunayFlip(tris.map((t) => (ar(t) < 0 ? [t[0], t[2], t[1]] : t)), xy), z, up);
  }
  if (boreR > 0) lathe(mesh, angles, [[r0, hw], [boreR, hw - cb], [boreR, -hw + cb], [r0, -hw]]);

  return {
    kind: "sprocket", teeth: N, pitch: p, width, chamfer, erosion: { amount: A, seed: ero.seed ?? seed },
    ...mesh.finish(), outline: wall, capOutline: capTop,
    pitchRadius: R, tipRadius: Math.hypot(...clean[HALF]), rootRadius: rootR, seatRadius, rollerRadius: dims.rollerRadius,
    bore: boreR, seatAngle: (k) => ((k + 0.5) * TAU) / N,
  };
}

// ---------------------------------------------------------------- chain loop

function loopGeometry(sp, p) {
  const n = sp.length, spans = [];
  for (let j = 0; j < n; j++) {
    const a = sp[j], b = sp[(j + 1) % n];
    const dx = b.c[0] - a.c[0], dy = b.c[1] - a.c[1], L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = uy, ny = -ux, k = (a.R - b.R) / L;
    if (Math.abs(k) >= 1) throw new Error("chainLoop: sprockets overlap");
    const s = Math.sqrt(1 - k * k), vx = k * ux + s * nx, vy = k * uy + s * ny;
    spans.push({ from: j, to: (j + 1) % n, nu: [vx, vy], t0: [a.c[0] + a.R * vx, a.c[1] + a.R * vy], t1: [b.c[0] + b.R * vx, b.c[1] + b.R * vy], length: L * s });
  }
  const arcs = sp.map((s, j) => {
    const inS = spans[(j + n - 1) % n], outS = spans[j];
    const a0 = Math.atan2(inS.nu[1], inS.nu[0]), a1 = Math.atan2(outS.nu[1], outS.nu[0]);
    let wrap = (((a1 - a0) % TAU) + TAU) % TAU;
    if (n === 1) wrap = TAU;
    return { j, start: a0, wrap, links: (wrap * s.N) / TAU };
  });
  const total = arcs.reduce((t, a) => t + a.links, 0) + spans.reduce((t, s) => t + s.length / p, 0);
  return { spans, arcs, total };
}

/**
 * Closed roller chain over sprockets in the xy plane (the sprockets' common z = 0 plane), wrapping each on the outside
 * of their convex hull. sprockets: [{ centre: [x, y], teeth }] (radius, if given, must be the pitch radius).
 * The link count is even (inner and outer links alternate); sprocket `adjust` (default: the last) is moved along
 * `slot` (default: away from the others) so the loop holds exactly that many links; `links` forces the count.
 *
 * Chain travel s (scene units, positive = counter-clockwise around the loop) turns every sprocket the same way:
 * theta_j(s) = phase_j + 2PI s / (N_j pitch), one tooth per pitch of travel (= s / pitchRadius up to the chordal
 * factor), so theta_j = (N_driver / N_j) theta_driver + const.
 * Roller k sits exactly in a seat while wrapped, and on the tangent line between sprockets, spaced one pitch.
 * Link i joins rollers i and i + 1; even links are inner (roller) links, odd ones outer (pin) links.
 */
export function chainLoop({ sprockets, pitch: p, adjust, slot, links } = {}) {
  let sp = sprockets.map((s, j) => {
    const R = sprocketPitchRadius(s.teeth, p);
    if (s.radius !== undefined && Math.abs(s.radius - R) > 1e-6 * R) throw new Error(`chainLoop: sprocket ${j} radius ${s.radius} is not the pitch radius ${R}`);
    return { j, c: [s.centre[0], s.centre[1]], N: s.teeth, R };
  });
  // Counter-clockwise order.
  const areaOf = (list) => list.reduce((a, s, k) => { const t = list[(k + 1) % list.length]; return a + s.c[0] * t.c[1] - t.c[0] * s.c[1]; }, 0);
  if (sp.length > 2 && areaOf(sp) < 0) sp = sp.reverse();
  const ai = sp.findIndex((s) => s.j === (adjust ?? sprockets.length - 1));
  const base = sp[ai].c.slice();
  let dir = slot;
  if (!dir) {
    const others = sp.filter((_, k) => k !== ai), mx = others.reduce((a, s) => a + s.c[0], 0) / others.length, my = others.reduce((a, s) => a + s.c[1], 0) / others.length;
    dir = [base[0] - mx, base[1] - my];
  }
  const dl = Math.hypot(dir[0], dir[1]);
  dir = [dir[0] / dl, dir[1] / dl];
  const at = (t) => { sp[ai].c = [base[0] + dir[0] * t, base[1] + dir[1] * t]; return loopGeometry(sp, p); };
  const free = at(0).total;
  const count = links ?? 2 * Math.ceil(free / 2 - 1e-9);
  if (count % 2) throw new Error("chainLoop: the link count must be even");
  let shift = 0;
  if (Math.abs(free - count) > 1e-12) {
    let lo = 0, hi = (count - free) * p;
    if (hi < 0) { lo = hi; hi = 0; }
    const f = (t) => at(t).total - count;
    let tries = 0;
    while (f(lo) > 0 && tries++ < 40) lo -= p;
    while (f(hi) < 0 && tries++ < 80) hi += p;
    shift = bisect(f, lo, hi, 80);
  }
  const geo = at(shift);

  // Segments in link units (lambda); lambda 0 = where roller 0 is at s = 0, entry of sprocket 0's arc.
  const segs = [];
  let lam = 0;
  for (let k = 0; k < sp.length; k++) {
    const arc = geo.arcs[k], span = geo.spans[k];
    segs.push({ type: "arc", k, l0: lam, l1: lam + arc.links, arc });
    lam += arc.links;
    segs.push({ type: "span", k, l0: lam, l1: lam + span.length / p, span });
    lam += span.length / p;
  }
  const n = count;
  // Sprocket phases: roller at arc entry (lambda l0) must sit on a seat: theta + (k + 0.5) delta.
  const phase = new Array(sprockets.length), byOriginal = new Array(sprockets.length);
  segs.filter((s) => s.type === "arc").forEach((s) => {
    const o = sp[s.k], delta = TAU / o.N;
    let ph = s.arc.start - s.l0 * delta - 0.5 * delta;
    ph -= delta * Math.round(ph / delta);
    phase[o.j] = ph;
    byOriginal[o.j] = o;
  });
  const theta = (j, s) => phase[j] + (TAU * s) / (byOriginal[j].N * p);

  const rollerState = (k, s) => {
    let l = (k + s / p) % n;
    if (l < 0) l += n;
    let seg = segs[segs.length - 1];
    for (const g of segs) if (l < g.l1) { seg = g; break; }
    const u = l - seg.l0;
    if (seg.type === "arc") {
      const o = sp[seg.k], a = seg.arc.start + (u * TAU) / o.N;
      return { x: o.c[0] + o.R * Math.cos(a), y: o.c[1] + o.R * Math.sin(a), sprocket: o.j, lambda: l };
    }
    const { t0, t1, length } = seg.span, f = (u * p) / length;
    return { x: t0[0] + (t1[0] - t0[0]) * f, y: t0[1] + (t1[1] - t0[1]) * f, sprocket: -1, lambda: l };
  };
  const rollerPosition = (k, s) => { const r = rollerState(k, s); return [r.x, r.y]; };

  const linkPose = (i, s, target = new Matrix4()) => {
    const a = rollerState(i, s), b = rollerState((i + 1) % n, s);
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, cx = dx / l, sy = dy / l;
    return target.set(cx, -sy, 0, (a.x + b.x) / 2, sy, cx, 0, (a.y + b.y) / 2, 0, 0, 1, 0, 0, 0, 0, 1);
  };

  const centres = sprockets.map((_, j) => byOriginal[j].c.slice());
  return {
    pitch: p, linkCount: n, length: n * p,
    pathLength: geo.arcs.reduce((t, a) => t + a.wrap * sp[a.j].R, 0) + geo.spans.reduce((t, s) => t + s.length, 0),
    shift, slot: dir, adjusted: sp[ai].j,
    sprockets: sprockets.map((s, j) => ({ centre: centres[j], teeth: s.teeth, radius: byOriginal[j].R, phase: phase[j], wrap: geo.arcs.find((a) => sp[a.j].j === j).wrap })),
    segments: segs.map(({ type, k, l0, l1 }) => ({ type, sprocket: sp[k].j, from: l0 * p, to: l1 * p })),
    theta, ratio: (j, driver = 0) => byOriginal[driver].N / byOriginal[j].N,
    sprocketPose: (j, s, target = new Matrix4()) => {
      const t = theta(j, s), c = Math.cos(t), sn = Math.sin(t);
      return target.set(c, -sn, 0, centres[j][0], sn, c, 0, centres[j][1], 0, 0, 1, 0, 0, 0, 0, 1);
    },
    rollerState, rollerPosition, linkPose,
    linkKind: (i) => (i % 2 === 0 ? "inner" : "outer"),
  };
}

// ---------------------------------------------------------------- links

// Plate outline: two end circles of half height a at x = +-p/2 joined by a slight waist.
function plateOutline(p, a, waist = 0.14, ends = 14, sides = 8) {
  const pts = [];
  for (let k = 0; k <= ends; k++) { const t = -Math.PI / 2 + (Math.PI * k) / ends; pts.push([p / 2 + a * Math.cos(t), a * Math.sin(t)]); }
  for (let k = 1; k < sides; k++) { const x = p / 2 - (p * k) / sides; pts.push([x, a * (1 - waist * Math.cos((Math.PI * x) / p) ** 2)]); }
  for (let k = 0; k <= ends; k++) { const t = Math.PI / 2 + (Math.PI * k) / ends; pts.push([-p / 2 + a * Math.cos(t), a * Math.sin(t)]); }
  for (let k = 1; k < sides; k++) { const x = -p / 2 + (p * k) / sides; pts.push([x, -a * (1 - waist * Math.cos((Math.PI * x) / p) ** 2)]); }
  return pts;
}

function insetLoop(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const t1 = [p[0] - a[0], p[1] - a[1]], t2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...t1), l2 = Math.hypot(...t2);
    const n1 = [-t1[1] / l1, t1[0] / l1], n2 = [-t2[1] / l2, t2[0] / l2];
    const nx = n1[0] + n2[0], ny = n1[1] + n2[1], nl = Math.hypot(nx, ny), c = (nx * n1[0] + ny * n1[1]) / nl;
    return [p[0] + (nx / nl) * (d / c), p[1] + (ny / nl) * (d / c)];
  });
}

// Extruded CCW loop from z0 to z1 with chamfered cap edges.
function plate(mesh, pts, z0, z1, ch) {
  const inner = insetLoop(pts, ch), cr = creases(pts);
  sweep(mesh, [inner.map(([x, y]) => [x, y, z0]), pts.map(([x, y]) => [x, y, z0 + ch]), pts.map(([x, y]) => [x, y, z1 - ch]), inner.map(([x, y]) => [x, y, z1])], cr);
  // Star-shaped about its centre: a fan.
  const xy = [[0, 0], ...inner], tris = inner.map((_, i) => [0, 1 + i, 1 + ((i + 1) % inner.length)]);
  cap(mesh, xy, tris, z1, true);
  cap(mesh, xy, tris, z0, false);
}

function cylinder(mesh, x, y, r, z0, z1, ch, K = 20) {
  const angles = Array.from({ length: K }, (_, k) => (TAU * k) / K), sub = new MeshBuilder();
  lathe(sub, angles, [[0, z0], [r - ch, z0], [r, z0 + ch], [r, z1 - ch], [r - ch, z1], [0, z1]]);
  for (let k = 0; k < sub.p.length; k += 3) { sub.p[k] += x; sub.p[k + 1] += y; }
  mesh.merge(sub);
}

/**
 * Inner (roller) link in its own frame: x along the chain (rollers at x = +-pitch/2), z across, centred at the origin.
 * Two inner plates outside the inner width, plus the two rollers. Several closed solids in one buffer.
 */
export function rollerLink({ pitch: p = 0.05, segments = 20 } = {}) {
  const d = chainDimensions(p), mesh = new MeshBuilder(), w = d.innerWidth / 2, ch = 0.02 * p;
  const outline = plateOutline(p, d.innerHeight / 2);
  plate(mesh, outline, w, w + d.plate, ch);
  plate(mesh, outline, -w - d.plate, -w, ch);
  for (const x of [-p / 2, p / 2]) cylinder(mesh, x, 0, d.rollerRadius, -w + 0.004 * p, w - 0.004 * p, ch, segments);
  return { kind: "rollerLink", pitch: p, ...mesh.finish(), zInner: w, zOuter: w + d.plate };
}

/** Outer (pin) link: two outer plates outside the inner plates, and the two pins through both links. */
export function plateLink({ pitch: p = 0.05, segments = 16 } = {}) {
  const d = chainDimensions(p), mesh = new MeshBuilder(), w = d.innerWidth / 2 + d.plate + d.plateGap, ch = 0.02 * p;
  const outline = plateOutline(p, d.outerHeight / 2);
  plate(mesh, outline, w, w + d.plate, ch);
  plate(mesh, outline, -w - d.plate, -w, ch);
  const head = w + d.plate + 0.05 * p;
  for (const x of [-p / 2, p / 2]) cylinder(mesh, x, 0, d.pinRadius, -head, head, 0.03 * p, segments);
  return { kind: "plateLink", pitch: p, ...mesh.finish(), zInner: w, zOuter: w + d.plate };
}
