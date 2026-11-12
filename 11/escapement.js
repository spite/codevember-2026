// Graham deadbeat anchor escapement: escape wheel, anchor, pendulum, their layout and the timing that drives the train.
//
// Frames. Escape wheel: axis +z through the origin, face width centred on z = 0, wheel angle w turns it about +z
// (counter-clockwise seen from +z, so q = w only grows); tooth k's tip is at angle w + k * pitch. The anchor turns about
// the pivot P = (0, D, 0) of the wheel frame, axis +z, by the anchor angle a; the anchor and pendulum geometry are built
// in that frame (origin at P). +y of the wheel frame is up: the pendulum hangs along -y, behind the wheel at z < 0.
//
// Geometry (all in the wheel's plane, tip radius R, pitch p = 2 pi / N):
// - The pallets span (n + 1/2) pitches, n = round(N / 4 - 1/2), so the lines from P to the middle of both working
//   ranges are tangent to the tip circle: half-span beta = (n + 1/2) p / 2, D = R / cos(beta).
// - Locking faces are arcs about P (deadbeat: while a tooth rests on one the wheel cannot move, it never recoils).
//   The entry pallet locks on its outer arc (teeth there move toward P), the exit pallet on its inner arc.
// - Impulse faces are straight cuts from the locking corner to the far corner, placed so that the tooth tip slides
//   across them while the anchor turns through `lift` and the wheel through `impulse` pitches; the wheel then drops
//   free through (1/2 - impulse) pitches onto the other pallet, which by then is `lock` deep past its corner.
// - Anchor angles: entry unlocks at a = -(lift - lock) / 2 (rising), exit at a = +(lift - lock) / 2 (falling); the
//   pendulum swings to +-amplitude, the rest of the swing is supplementary arc on the locking faces.
// - Every contact keeps a gap of `clearance` * R, so the solids touch visually but never numerically.
import { Matrix4, ShapeUtils, Vector2 } from "three";
import { wearOptions, profiledExtrusion } from "./wear.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const scale = (a, s) => [a[0] * s, a[1] * s];

// ---------------------------------------------------------------- layout

const layouts = new Map();

/**
 * Escapement geometry for `teeth` (15-30) and tip radius `radius`. Angles in radians.
 * Returns the anchor pivot (wheel frame), pallet corners and radii (anchor frame), lock wheel angles, the release
 * angles and everything buildAnchor / buildEscapeWheel / motion need.
 */
export function escapementLayout({ teeth = 30, radius = 0.2, lift = 2 * DEG, lock = 0.75 * DEG, amplitude = 3.5 * DEG, impulse = 0.38, clearance = 0.002 } = {}) {
  const key = [teeth, radius, lift, lock, amplitude, impulse, clearance].join();
  if (layouts.has(key)) return layouts.get(key);
  const N = teeth, R = radius, p = TAU / N, A = amplitude, eps = clearance * R;
  const n = Math.max(1, Math.round(N / 4 - 0.5)), span = (n + 0.5) * p, beta = span / 2, D = R / Math.cos(beta);
  const P = [0, D], dImp = impulse * p, dDrop = p / 2 - dImp;
  const gE = Math.PI / 2 - beta - dImp / 2, gX = gE + span;
  const a0 = -(lift - lock) / 2, b0 = (lift - lock) / 2;
  const tip = (g) => polar(R, g);
  const along = (v, d) => scale(v, (len(v) + d) / len(v));

  const lE = sub(tip(gE), P), lX = sub(tip(gX), P);
  const psiE = Math.atan2(lE[1], lE[0]), psiX = Math.atan2(lX[1], lX[0]);
  const entry = {
    name: "entry", lockWheel: gE,
    c1: rot(along(lE, -eps), -a0), c2: rot(along(sub(tip(gE + dImp), P), -eps), -(a0 + lift)),
  };
  const exit = {
    name: "exit", lockWheel: gX,
    c1: rot(along(lX, eps), -b0), c2: rot(along(sub(tip(gX + dImp), P), eps), -(b0 - lift)),
  };
  for (const pl of [entry, exit]) {
    pl.r1 = len(pl.c1); pl.r2 = len(pl.c2);
    pl.psi1 = Math.atan2(pl.c1[1], pl.c1[0]); pl.psi2 = Math.atan2(pl.c2[1], pl.c2[0]);
  }
  // Pallet thickness along rho, arm width (angle) and the margin past the supplementary arc.
  const armAngle = (0.55 * (entry.r1 - entry.r2)) / entry.r1 + 4 * DEG, margin = 2.5 * DEG;
  entry.top = psiE + A + margin + armAngle;
  entry.armLow = entry.top - armAngle;
  exit.top = psiX - A - margin - armAngle;
  exit.armLow = exit.top + armAngle;
  // Interior point of each pallet, to orient its impulse face normal.
  entry.inside = polar((entry.r1 + entry.r2) / 2, (entry.psi1 + entry.top) / 2);
  exit.inside = polar((exit.r1 + exit.r2) / 2, (exit.psi1 + exit.top) / 2);
  // Deepest reach of a pallet inside the tip circle (radially, wheel frame), for the tooth height.
  const reach = (pl, a) => R - len([P[0] + rot(pl.c2, a)[0], P[1] + rot(pl.c2, a)[1]]);
  const dip = Math.max(reach(entry, -A), reach(exit, A));

  const L = {
    teeth: N, radius: R, pitch: p, span, spanTeeth: n + 0.5, beta, pivot: [0, D, 0], axis: [0, 0, 1], distance: D,
    lift, lock, amplitude: A, impulse: dImp, drop: dDrop, clearance: eps, unlockEntry: a0, unlockExit: b0,
    entry, exit, dip, toothHeight: Math.max(0.12 * R, dip + 0.05 * R), wheelLock: ((gE % p) + p) % p,
    anchorTransform: new Matrix4().makeTranslation(0, D, 0),
  };
  L.hubRadius = Math.min(0.2 * R, 0.55 * (D - R));
  // The wheel turns through the impulse while the tip slides on the face; release is where it passes the far corner.
  for (const pl of [entry, exit]) {
    const sign = pl === entry ? 1 : -1, lo = pl === entry ? a0 - lift : -A, hi = pl === entry ? A : b0 + lift;
    let a = lo, b = hi;
    for (let i = 0; i < 80; i++) {
      const m = (a + b) / 2, u = impulseContact(L, pl, m).u;
      if ((u < 1) === (sign > 0)) a = m; else b = m;
    }
    pl.release = (a + b) / 2;
    pl.releaseOffset = impulseContact(L, pl, pl.release).offset;
  }
  layouts.set(key, L);
  return L;
}

// Tooth tip on the impulse face (offset by the clearance) at anchor angle a: wheel offset from lock, and u along the face.
function impulseContact(L, pl, a) {
  const P = [0, L.distance], R = L.radius;
  const q1 = [P[0] + rot(pl.c1, a)[0], P[1] + rot(pl.c1, a)[1]], q2 = [P[0] + rot(pl.c2, a)[0], P[1] + rot(pl.c2, a)[1]];
  const e = sub(q2, q1), el = len(e);
  let nrm = [e[1] / el, -e[0] / el];
  const ins = rot(pl.inside, a);
  if (dot(nrm, sub([P[0] + ins[0], P[1] + ins[1]], q1)) > 0) nrm = [-nrm[0], -nrm[1]];
  const c = (L.clearance + dot(nrm, q1)) / R, tn = Math.atan2(nrm[1], nrm[0]), ac = Math.acos(Math.max(-1, Math.min(1, c)));
  const target = pl.lockWheel + L.impulse / 2;
  const g = [tn + ac, tn - ac].reduce((best, x) => (Math.abs(wrapPi(x - target)) < Math.abs(wrapPi(best - target)) ? x : best));
  const t = polar(R, g);
  return { offset: wrapPi(g - pl.lockWheel), u: dot(sub(t, q1), e) / (el * el) };
}

// Wheel offset from lock at which the tooth tip is `clearance` from the pallet's locking corner at anchor angle a.
function cornerContact(L, pl, a) {
  const R = L.radius, eps = L.clearance, c = rot(pl.c1, a), q = [c[0], L.distance + c[1]], ql = len(q);
  const phi = Math.atan2(q[1], q[0]), ac = Math.acos(Math.max(-1, Math.min(1, (R * R + ql * ql - eps * eps) / (2 * R * ql))));
  const g = [phi + ac, phi - ac].reduce((best, x) => (Math.abs(wrapPi(x - pl.lockWheel)) < Math.abs(wrapPi(best - pl.lockWheel)) ? x : best));
  return wrapPi(g - pl.lockWheel);
}

// ---------------------------------------------------------------- motion

/**
 * Escapement state at `time` (seconds). period: one full pendulum swing (two beats).
 * Beat k runs over [k, k + 1) * period / 2; each advances the wheel by exactly half a pitch: a slide across an
 * impulse face, then a short eased drop (`dropTime`, fraction of a beat) onto the other pallet's locking face.
 * Returns { wheel (cumulative, = the train's q), anchor, beat, tick (a tooth landed within (time - dt, time]),
 * pallet ("entry" | "exit"), phase ("lock" | "impulse" | "drop"), landing (time of this beat's landing) }.
 */
export function motion(time, { period = 2, dt = 1 / 60, dropTime = 0.05, layout, ...opts } = {}) {
  const L = layout || escapementLayout(opts), A = L.amplitude, half = period / 2;
  const state = (t) => {
    const beat = Math.floor(t / half), s = t - beat * half, odd = beat & 1, th = (Math.PI * s) / half;
    const anchor = odd ? A * Math.cos(th) : -A * Math.cos(th);
    const pl = odd ? L.exit : L.entry;
    const sRel = (Math.acos(odd ? pl.release / A : -pl.release / A) / Math.PI) * half;
    const tau = dropTime * half, sLand = sRel + tau, base = L.wheelLock + (beat * L.pitch) / 2;
    let off, phase;
    if (s < sRel) {
      const ic = impulseContact(L, pl, anchor), unlocked = odd ? anchor < L.unlockExit : anchor > L.unlockEntry;
      // Between unlocking and the face catching up, the tip rides the locking corner.
      off = Math.max(0, unlocked && ic.u < 0 ? cornerContact(L, pl, anchor) : ic.offset);
      phase = off > 0 ? "impulse" : "lock";
    } else if (s < sLand) {
      const u = (s - sRel) / tau;
      off = pl.releaseOffset + (L.pitch / 2 - pl.releaseOffset) * u * u;
      phase = "drop";
    } else {
      off = L.pitch / 2;
      phase = "lock";
    }
    return { wheel: base + off, anchor, beat, pallet: pl.name, phase, landing: beat * half + sLand };
  };
  const st = state(time);
  st.tick = [st, state(time - dt)].some((x) => x.landing > time - dt && x.landing <= time);
  return st;
}

// ---------------------------------------------------------------- outlines

function arc(r, a0, a1, step = 0.5 * DEG, cx = 0, cy = 0) {
  const k = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step)), out = [];
  for (let i = 0; i <= k; i++) { const a = a0 + ((a1 - a0) * i) / k; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const ccw = (pts) => (area(pts) < 0 ? pts.slice().reverse() : pts);
const cw = (pts) => (area(pts) > 0 ? pts.slice().reverse() : pts);
const circle = (r, n = 48, cx = 0, cy = 0) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((TAU * k) / n), cy + r * Math.sin((TAU * k) / n)]);

/**
 * Escape wheel outline at w = 0: { outer (CCW), holes (CW) }. Pointed teeth lean forward (+angle) by `lean`, so only
 * the tip touches a pallet. Crossings: `spokes` straight spokes between a rim and a hub.
 */
export function escapeWheelOutline({ teeth = 30, radius = 0.2, spokes = 5, bore, lean = 14 * DEG, ...opts } = {}) {
  const L = escapementLayout({ teeth, radius, ...opts }), R = radius, p = L.pitch, h = L.toothHeight, Rr = R - h;
  const front = (h * Math.tan(lean)) / Rr, back = front + 0.3 * p;
  const outer = [];
  for (let k = 0; k < teeth; k++) {
    const c = k * p;
    for (let i = 0; i < 4; i++) { const s = i / 4; outer.push(polar(Rr + h * s, c - back * (1 - s) ** 1.25)); }
    outer.push(polar(R, c));
    for (let i = 1; i <= 3; i++) { const s = i / 3; outer.push(polar(R - h * s, c - front * s)); }
    const r0 = c - front, r1 = c + p - back, m = 4;
    for (let i = 1; i < m; i++) outer.push(polar(Rr, r0 + ((r1 - r0) * i) / m));
  }
  const holes = [];
  const rim = Rr - Math.max(0.1 * R, 0.6 * h), hub = Math.max(0.2 * R, (bore ?? 0.05 * R) + 0.08 * R), sw = 0.07 * R;
  for (let s = 0; spokes > 0 && s < spokes; s++) {
    const c0 = (TAU * s) / spokes + p / 2, c1 = (TAU * (s + 1)) / spokes + p / 2;
    const ha = (r) => Math.asin(Math.min(1, sw / 2 / r));
    holes.push(cw([...arc(rim, c0 + ha(rim), c1 - ha(rim), 3 * DEG), ...arc(hub, c1 - ha(hub), c0 + ha(hub), 3 * DEG)]));
  }
  const boreR = bore ?? 0.05 * R;
  if (boreR > 0) holes.push(cw(circle(boreR)));
  return { outer: ccw(outer), holes, tipRadius: R, rootRadius: Rr, rimRadius: rim, hubRadius: hub, layout: L };
}

/** Anchor outline in its own frame (origin at the pivot, a = 0): hub, two arms and the two pallets. */
export function anchorOutline({ bore, ...opts } = {}) {
  const L = escapementLayout(opts), E = L.entry, X = L.exit, rh = L.hubRadius, step = 0.25 * DEG;
  const kappa = 14 * DEG;
  let topX = X.top;
  while (topX < E.top) topX += TAU;
  let lowE = E.armLow;
  while (lowE < X.armLow) lowE += TAU;
  const pts = [
    ...arc(E.r1, E.psi1, E.top, step),
    ...arc(rh, E.top + kappa, topX - kappa, 3 * DEG),
    ...arc(X.r2, X.top, X.psi2, step),
    ...arc(X.r1, X.psi1, X.armLow, step),
    ...arc(rh, X.armLow + kappa, lowE - kappa, 3 * DEG),
    ...arc(E.r2, E.armLow, E.psi2, step),
  ];
  const boreR = bore ?? 0.05 * L.radius;
  return { outer: ccw(pts), holes: boreR > 0 ? [cw(circle(boreR, 32))] : [], layout: L };
}

// ---------------------------------------------------------------- meshes

class Mesh {
  constructor() { this.p = []; this.n = []; this.i = []; }
  v(p, n) { this.p.push(...p); this.n.push(...n); return this.p.length / 3 - 1; }
  // Triangle wound so its face normal agrees with the stored vertex normals.
  t(a, b, c) {
    const P = this.p, N = this.n, g = (i, k) => P[3 * i + k];
    const u = [g(b, 0) - g(a, 0), g(b, 1) - g(a, 1), g(b, 2) - g(a, 2)], w = [g(c, 0) - g(a, 0), g(c, 1) - g(a, 1), g(c, 2) - g(a, 2)];
    const f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (f[0] ** 2 + f[1] ** 2 + f[2] ** 2 < 1e-30) return;
    let s = 0;
    for (const v of [a, b, c]) s += f[0] * N[3 * v] + f[1] * N[3 * v + 1] + f[2] * N[3 * v + 2];
    s < 0 ? this.i.push(a, c, b) : this.i.push(a, b, c);
  }
  finish() { return { position: new Float32Array(this.p), normal: new Float32Array(this.n), index: new Uint32Array(this.i) }; }
}

// Prism of a 2D shape (outer CCW, holes CW) from z0 to z1; walls split their normals at corners sharper than 30 deg.
function extrude(mesh, outer, holes, z0, z1) {
  const loops = [outer, ...holes], flat = loops.flat();
  const tris = ShapeUtils.triangulateShape(outer.map(([x, y]) => new Vector2(x, y)), holes.map((h) => h.map(([x, y]) => new Vector2(x, y))));
  for (const [z, nz] of [[z1, 1], [z0, -1]]) {
    const ids = flat.map(([x, y]) => mesh.v([x, y, z], [0, 0, nz]));
    for (const [a, b, c] of tris) mesh.t(ids[a], ids[b], ids[c]);
  }
  for (const loop of loops) {
    const m = loop.length, en = loop.map((p, i) => {
      const q = loop[(i + 1) % m], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
      return [dy / l, -dx / l];
    });
    const vn = (i, e) => {
      const a = en[(i + m - 1) % m], b = en[i % m];
      if (dot(a, b) < Math.cos(30 * DEG)) return en[e];
      const s = [a[0] + b[0], a[1] + b[1]], l = len(s);
      return [s[0] / l, s[1] / l];
    };
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, na = vn(i, i), nb = vn(j, i);
      const a0 = mesh.v([...loop[i], z0], [...na, 0]), a1 = mesh.v([...loop[i], z1], [...na, 0]);
      const b0 = mesh.v([...loop[j], z0], [...nb, 0]), b1 = mesh.v([...loop[j], z1], [...nb, 0]);
      mesh.t(a0, b0, b1);
      mesh.t(a0, b1, a1);
    }
  }
}

// Surface of revolution about z through (cx, cy, cz). rows: [r, z, nr, nz] from the +z pole to the -z pole; a row with
// r = 0 is a pole, `null` splits smooth runs (the rows either side repeat the shared position).
function lathe(mesh, rows, { cx = 0, cy = 0, cz = 0, segments = 64 } = {}) {
  const ring = ([r, z, nr, nz]) => {
    if (r === 0) { const v = mesh.v([cx, cy, cz + z], [0, 0, Math.sign(nz)]); return Array(segments).fill(v); }
    return Array.from({ length: segments }, (_, k) => {
      const a = (TAU * k) / segments, c = Math.cos(a), s = Math.sin(a);
      return mesh.v([cx + r * c, cy + r * s, cz + z], [nr * c, nr * s, nz]);
    });
  };
  let prev = null;
  for (const row of rows) {
    if (!row) { prev = null; continue; }
    const cur = ring(row);
    if (prev) for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments;
      mesh.t(prev[k], prev[k1], cur[k1]);
      mesh.t(prev[k], cur[k1], cur[k]);
    }
    prev = cur;
  }
}

const info = (mesh, extra) => { const g = mesh.finish(); return { ...g, triangles: g.index.length / 3, ...extra }; };

// Prism of a 2D shape, with cap profiles, wear and pits when `wear` asks for them.
function extrudeWorn(mesh, outer, holes, z0, z1, wear) {
  if (!wear.active) return extrude(mesh, outer, holes, z0, z1);
  const g = profiledExtrusion(outer, holes, z0, z1, wear), base = mesh.p.length / 3;
  for (let k = 0; k < g.position.length; k++) { mesh.p.push(g.position[k]); mesh.n.push(g.normal[k]); }
  for (const i of g.index) mesh.i.push(base + i);
}

// Pallets and tooth tips do the work: corners only wear a little and never chip.
const ESCAPEMENT_WEAR = { tip: 0.04, chips: 0 };

/**
 * Escape wheel, axis +z, faces at z = +-width/2, tooth 0's tip on +x. radius: tip radius (or teeth * module / 2).
 * Pass the same angle options as escapementLayout, so the teeth are tall enough for the pallets.
 * chamfer / erosion as in gears.js, with the module taken as 2 radius / teeth (also for the anchor).
 */
export function buildEscapeWheel({ teeth = 30, radius, width, module: mod, chamfer, erosion, seed, ...opts } = {}) {
  radius = radius ?? (mod ? (teeth * mod) / 2 : 0.2);
  width = width ?? 0.07 * radius;
  const o = escapeWheelOutline({ teeth, radius, ...opts }), mesh = new Mesh();
  extrudeWorn(mesh, o.outer, o.holes, -width / 2, width / 2, wearOptions({ chamfer, erosion }, (2 * radius) / teeth, seed ?? teeth * 131 + 7, ESCAPEMENT_WEAR));
  return info(mesh, { kind: "escapeWheel", teeth, radius, width, outline: o.outer, holes: o.holes, tipRadius: radius, rootRadius: o.rootRadius, layout: o.layout });
}

/** Anchor in its frame (origin at the pivot, axis +z), faces at z = +-width/2. Same options as escapementLayout. */
export function buildAnchor({ width, bore, chamfer, erosion, seed, ...opts } = {}) {
  const o = anchorOutline({ bore, ...opts }), L = o.layout, mesh = new Mesh();
  width = width ?? 0.1 * L.radius;
  extrudeWorn(mesh, o.outer, o.holes, -width / 2, width / 2, wearOptions({ chamfer, erosion }, (2 * L.radius) / L.teeth, seed ?? L.teeth * 131 + 11, ESCAPEMENT_WEAR));
  return info(mesh, { kind: "anchor", width, outline: o.outer, holes: o.holes, layout: L });
}

/**
 * Pendulum in the anchor frame: a hub on the anchor arbor and a flat rod hanging along -y to a lens bob, all in the
 * plane z = `z` (escapementPendulumZ gives one clear of the wheel). Two closed shells: the rod ends inside the bob.
 * chamfer / erosion as in gears.js, with thickness / 2.5 as the module; the bob only gets the chamfer on its rim.
 */
export function buildPendulum({ length = 0.6, bobRadius, bobThickness, rodWidth, thickness, hubRadius, bore, z = 0, segments = 64, chamfer, erosion, seed } = {}) {
  bobRadius = bobRadius ?? 0.16 * length;
  rodWidth = rodWidth ?? 0.03 * length;
  thickness = thickness ?? 0.4 * rodWidth;
  hubRadius = Math.max(hubRadius ?? 1.6 * rodWidth, 0.6 * rodWidth);
  bobThickness = Math.max(bobThickness ?? 0.32 * bobRadius, 1.5 * thickness);
  bore = bore ?? 0.45 * hubRadius;
  const mesh = new Mesh(), hw = rodWidth / 2, yAttach = -Math.sqrt(hubRadius ** 2 - hw ** 2), ar = Math.atan2(yAttach, hw);
  const wear = wearOptions({ chamfer, erosion }, thickness / 2.5, seed ?? 977, ESCAPEMENT_WEAR);
  // Worn rods get points along their sides, so the eaten edges and pits do not leave rod-long slivers on the caps.
  const steps = wear.active ? Math.max(1, Math.round((yAttach + length) / rodWidth)) : 1, side = (x, a, b) => Array.from({ length: steps }, (_, i) => [x, a + ((b - a) * i) / steps]);
  const outer = [...arc(hubRadius, ar, Math.PI - ar, 4 * DEG).slice(0, -1), ...side(-hw, yAttach, -length), [-hw, -length], ...side(hw, -length, yAttach)];
  outer[0] = [hw, yAttach];
  extrudeWorn(mesh, ccw(outer), bore > 0 ? [cw(circle(bore, 32))] : [], z - thickness / 2, z + thickness / 2, wear);
  // Lens: two spherical caps on a short band, its two rims cut by cb.
  const te = 0.25 * bobThickness, tb = bobThickness, zc = (tb * tb / 4 - te * te / 4 - bobRadius ** 2) / (tb - te), Rs = tb / 2 - zc;
  const cb = Math.min(wear.chamfer + (wear.erosion ? 0.5 * wear.erosion.amount * wear.erosion.edge * wear.scale : 0), 0.3 * te);
  const phiMax = Math.asin(bobRadius / Rs), phiA = phiMax - cb / Rs, k = 16, rows = [];
  for (let i = 0; i <= k; i++) { const f = (phiA * i) / k; rows.push([Rs * Math.sin(f), zc + Rs * Math.cos(f), Math.sin(f), Math.cos(f)]); }
  if (cb > 0) {
    const A = rows[k], dr = bobRadius - A[0], dz = te / 2 - cb - A[1], l = Math.hypot(dr, dz), nr = -dz / l, nz = dr / l;
    rows.push(null, [A[0], A[1], nr, nz], [bobRadius, te / 2 - cb, nr, nz], null, [bobRadius, te / 2 - cb, 1, 0], [bobRadius, -te / 2 + cb, 1, 0], null);
    rows.push([bobRadius, -te / 2 + cb, nr, -nz], [A[0], -A[1], nr, -nz], null);
  } else {
    rows[k] = [bobRadius, te / 2, Math.sin(phiMax), Math.cos(phiMax)];
    rows.push(null, [bobRadius, te / 2, 1, 0], [bobRadius, -te / 2, 1, 0], null);
  }
  for (let i = k; i >= 0; i--) { const f = (phiA * i) / k; rows.push([i === k && !(cb > 0) ? bobRadius : Rs * Math.sin(f), i === k && !(cb > 0) ? -te / 2 : -(zc + Rs * Math.cos(f)), Math.sin(f), -Math.cos(f)]); }
  lathe(mesh, rows, { cy: -length, cz: z, segments });
  return info(mesh, { kind: "pendulum", length, bobRadius, bobThickness, rodWidth, thickness, hubRadius, z });
}

/** A pendulum plane behind the wheel and anchor (both of these widths), with `gap` between. */
export function escapementPendulumZ({ wheelWidth, anchorWidth, pendulumThickness, gap }) {
  return -(Math.max(wheelWidth, anchorWidth) / 2 + gap + pendulumThickness / 2);
}
