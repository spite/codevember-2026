// Involute gear geometry (spur, helical, ring, bevel, worm, worm wheel, rack) and the pairing maths that places them.
import { Matrix4, ShapeUtils, Vector2, Vector3 } from "three";
import { MeshBuilder, sweep, creases, wearOptions, wearLoops, capRows, wallRows, sweepWall, chamferPath, pitFaces, profiledExtrusion, delaunayFlip } from "./wear.js";

export { DEFAULT_CHAMFER } from "./wear.js";

export const PRESSURE_ANGLE = (20 * Math.PI) / 180;
export const BACKLASH = 0.03; // thinning of each flank, in modules
const ADDENDUM = 1;
const DEDENDUM = 1.25;
const TAU = Math.PI * 2;
const inv = (a) => Math.tan(a) - a;
const wrap = (a, p) => a - p * Math.round(a / p);

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

// ---------------------------------------------------------------- 2D profiles

// Half-angle w(rho) of an external tooth, rack-generated (trochoid undercut below the involute).
function externalFlank({ teeth: N, module: m, alpha = PRESSURE_ANGLE, thickness, addendum = ADDENDUM * m, dedendum = DEDENDUM * m, cutter = true, flankPoints = 10, filletPoints = 4 }) {
  const r = (N * m) / 2, rb = r * Math.cos(alpha), rf = r - dedendum, half = Math.PI / N;
  const psi = thickness / (2 * r), invA = inv(alpha);
  const wInv = (rho) => psi + invA - inv(Math.acos(Math.min(1, rb / rho)));
  const u0 = (Math.PI * m - thickness) / 2 - dedendum * Math.tan(alpha);
  const useCutter = cutter && u0 > 0 && rf > 0;
  const rhoInv = Math.hypot(rb, Math.max(0, r * Math.sin(alpha) - dedendum / Math.sin(alpha)));
  const troch = (rho) => {
    const q = Math.sqrt(Math.max(0, rho * rho - rf * rf));
    return Math.max(Math.atan2(q, rf) - (q - u0) / r, Math.atan2(-q, rf) + (q + u0) / r);
  };
  const w = useCutter ? (rho) => half - (rho >= rhoInv ? Math.max(troch(rho), half - wInv(rho)) : troch(rho)) : wInv;

  let ra = r + addendum;
  const land = 0.12 * m;
  if (w(ra) * ra < land) {
    let lo = r, hi = ra;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (w(mid) * mid < land) hi = mid; else lo = mid; }
    ra = lo;
  }

  const rhos = [];
  let start = rf;
  if (useCutter) {
    const dom = (rho) => rho < rhoInv || troch(rho) >= half - wInv(rho) - 1e-12;
    const steps = 400;
    let lo = rf;
    for (let k = 0; k <= steps; k++) { const rho = rf + ((ra - rf) * k) / steps; if (dom(rho)) lo = rho; }
    let hi = Math.min(ra, lo + (ra - rf) / steps);
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (dom(mid)) lo = mid; else hi = mid; }
    const qT = Math.sqrt(lo * lo - rf * rf);
    for (let k = 0; k < filletPoints; k++) rhos.push(Math.hypot(rf, (qT * k) / filletPoints));
    start = lo;
  } else if (rf < rb) {
    const k = Math.max(1, Math.round(((rb - rf) * flankPoints) / (ra - rb)));
    for (let i = 0; i < k; i++) rhos.push(rf + ((rb - rf) * i) / k);
    start = rb;
  }
  const t0 = Math.sqrt(Math.max(0, (start / rb) ** 2 - 1)), t1 = Math.sqrt((ra / rb) ** 2 - 1);
  for (let k = 0; k <= flankPoints; k++) { const t = t0 + ((t1 - t0) * k) / flankPoints; rhos.push(k === 0 ? start : k === flankPoints ? ra : rb * Math.sqrt(1 + t * t)); }
  return { r, rb, ra, rf, half, w, flank: rhos.map((rho) => [rho, w(rho)]) };
}

// Internal teeth: the space is shaped like an external involute tooth. Flank runs root (outer) to tip (inner).
function internalFlank({ teeth: N, module: m, alpha = PRESSURE_ANGLE, thickness, addendum = ADDENDUM * m, dedendum = DEDENDUM * m, flankPoints = 10 }) {
  const r = (N * m) / 2, rb = r * Math.cos(alpha), half = Math.PI / N, invA = inv(alpha);
  const psiS = (Math.PI * m - thickness) / (2 * r);
  const wS = (rho) => psiS + invA - inv(Math.acos(Math.min(1, rb / rho)));
  const w = (rho) => half - wS(rho);
  const rt = Math.max(r - addendum, rb * 1.0005);
  let rr = r + dedendum;
  const land = 0.12 * m;
  if (wS(rr) * rr < land) {
    let lo = r, hi = rr;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (wS(mid) * mid < land) hi = mid; else lo = mid; }
    rr = lo;
  }
  const t0 = Math.sqrt((rr / rb) ** 2 - 1), t1 = Math.sqrt(Math.max(0, (rt / rb) ** 2 - 1));
  const flank = [];
  for (let k = 0; k <= flankPoints; k++) { const t = t0 + ((t1 - t0) * k) / flankPoints; const rho = k === 0 ? rr : k === flankPoints ? rt : rb * Math.sqrt(1 + t * t); flank.push([rho, w(rho)]); }
  return { r, rb, ra: rt, rf: rr, half, w, flank };
}

// Outline of N teeth in polar (rho, angle), CCW, tooth 0 centred on angle 0, plus the triangles of the teeth.
function toothRing(N, flank, { tipPoints = 2, rootPoints = 3 } = {}) {
  const p = TAU / N, n = flank.length - 1, pts = [], ladder = [], root = [], teeth = [];
  for (let i = 0; i < N; i++) {
    const c = i * p, R = [], L = [], T = [], gap = [];
    for (let j = 0; j <= n; j++) R.push(pts.push([flank[j][0], c - flank[j][1]]) - 1);
    for (let k = 1; k <= tipPoints; k++) T.push(pts.push([flank[n][0], c - flank[n][1] + (2 * flank[n][1] * k) / (tipPoints + 1)]) - 1);
    for (let j = n; j >= 0; j--) L[j] = pts.push([flank[j][0], c + flank[j][1]]) - 1;
    for (let k = 1; k <= rootPoints; k++) gap.push(pts.push([flank[0][0], c + flank[0][1] + ((p - 2 * flank[0][1]) * k) / (rootPoints + 1)]) - 1);
    root.push(R[0], L[0], ...gap);
    teeth.push({ R, L, T, gap });
    for (let j = 0; j < n - 1; j++) ladder.push([R[j], R[j + 1], L[j + 1]], [R[j], L[j + 1], L[j]]);
    // Tip arc fanned from the row below: one row lies on a circle, and its plane cuts across a curved (bevel) cap.
    if (n > 0) {
      const tip = [R[n], ...T, L[n]];
      for (let k = 0; k < tip.length - 1; k++) ladder.push([R[n - 1], tip[k], tip[k + 1]]);
      ladder.push([R[n - 1], L[n], L[n - 1]]);
    }
  }
  return { pts, ladder, root, teeth };
}

// Internal tips are straight: an arc there would bulge into the tooth's own triangles.
const INTERNAL_RING = { tipPoints: 0, rootPoints: 3 };

// Creases of a wall swept from a 2D loop along helices with twist rate k (radians per unit z).
function wallCreases(xy, k, limit = 0.6) {
  const n = xy.length, normals = xy.map((p, i) => {
    const q = xy[(i + 1) % n], tx = q[0] - p[0], ty = q[1] - p[1], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const hx = -k * my, hy = k * mx;
    return [ty, -tx, tx * hy - ty * hx];
  });
  return xy.map((_, i) => {
    const a = normals[(i + n - 1) % n], b = normals[i];
    return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)) < Math.cos(limit);
  });
}

const polarXY = ([rho, a], rot = 0) => [rho * Math.cos(a + rot), rho * Math.sin(a + rot)];

// Triangulates the band between two closed loops sorted by angle.
function zipper(a, b, angle) {
  const prep = (ids) => {
    const ang = ids.map((i) => ((angle(i) % TAU) + TAU) % TAU);
    let s = 0;
    for (let k = 1; k < ids.length; k++) if (ang[k] < ang[s]) s = k;
    const out = [], oa = [];
    for (let k = 0; k < ids.length; k++) {
      const kk = (s + k) % ids.length;
      let x = ang[kk];
      if (oa.length && x < oa[oa.length - 1]) x += TAU;
      out.push(ids[kk]);
      oa.push(x);
    }
    out.push(out[0]);
    oa.push(oa[0] + TAU);
    return [out, oa];
  };
  const [A, aa] = prep(a), [B, ba] = prep(b);
  return zipOpen(A, aa, B, ba);
}

// Triangulates the strip between two open polylines with increasing angles aa, ba that start and end together.
function zipOpen(A, aa, B, ba) {
  const tris = [];
  let i = 0, j = 0;
  while (i < A.length - 1 || j < B.length - 1) {
    if (j === B.length - 1 || (i < A.length - 1 && aa[i + 1] <= ba[j + 1])) tris.push([A[i], A[++i], B[j]]);
    else tris.push([A[i], B[j + 1], B[j++]]);
  }
  return tris;
}

function orient(tris, xy) {
  return tris.map(([a, b, c]) => {
    const area = (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[c][0] - xy[a][0]) * (xy[b][1] - xy[a][1]);
    return area < 0 ? [a, c, b] : [a, b, c];
  });
}

// ---------------------------------------------------------------- mesh building

// Surface of revolution of a polyline in (r, z); the solid lies to the left of the walking direction.
function lathe(mesh, angles, path) {
  const ring = ([r, z]) => angles.map((a) => [r * Math.cos(a), r * Math.sin(a), z]);
  for (let k = 0; k < path.length - 1; k++) {
    const [r0, z0] = path[k], [r1, z1] = path[k + 1];
    if (Math.abs(r1 - r0) + Math.abs(z1 - z0) < 1e-12) continue;
    sweep(mesh, [ring(path[k]), ring(path[k + 1])]);
  }
}

function cap(mesh, pts3, tris, flip) {
  const ids = pts3.map((p) => mesh.v(...p));
  for (const [a, b, c] of tris) flip ? mesh.t(ids[a], ids[c], ids[b]) : mesh.t(ids[a], ids[b], ids[c]);
}

const uniformAngles = (n) => Array.from({ length: n }, (_, k) => (TAU * k) / n);

// Teeth split into rows of constant rho, each subdivided to arcs of at most `step`, so no triangle spans a wide angle.
function polarBand(ring, pol, step) {
  const add = (rho, a) => pol.push([rho, a]) - 1, ang = (ids) => ids.map((i) => pol[i][1]);
  const arc = (i0, i1) => {
    const [rho, a0] = pol[i0], [rho1, a1] = pol[i1], k = Math.max(1, Math.ceil((a1 - a0) / step)), ids = [i0];
    for (let s = 1; s < k; s++) ids.push(add(rho1 === rho ? rho : rho + ((rho1 - rho) * s) / k, a0 + ((a1 - a0) * s) / k));
    return [...ids, i1];
  };
  const tris = [], base = [];
  for (const { R, L, T, gap } of ring.teeth) {
    const n = R.length - 1, rows = R.map((r, j) => (j === n ? [r, ...T, L[n]] : arc(r, L[j])));
    for (let j = 0; j < n; j++) tris.push(...zipOpen(rows[j], ang(rows[j]), rows[j + 1], ang(rows[j + 1])));
    base.push(...rows[0], ...gap);
  }
  return { tris, base };
}

// True when zipping root to circle by angle gives triangles that all turn the same way (no fold).
function zipperHolds(root, circle, pol) {
  const xy = pol.map((p) => polarXY(p));
  let pos = 0, neg = 0;
  for (const [a, b, c] of zipper(root, circle, (i) => pol[i][1])) {
    const ar = (xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[c][0] - xy[a][0]) * (xy[b][1] - xy[a][1]);
    if (ar > 0) pos++; else if (ar < 0) neg++; else return false;
  }
  return !(pos && neg);
}

// Band caps (teeth plus the ring down to a circle) of a toothed outline. `rot` turns the outline only.
// polarStep: teeth wider than a half turn (worm threads) are cut into rows of rho instead of laddered flank to flank.
function bandCap(mesh, ring, circleR, angles, map, rot, flip, polarStep = 0) {
  const n = ring.pts.length;
  const pol = [...ring.pts.map(([rho, a]) => [rho, a + rot]), ...angles.map((a) => [circleR, a])];
  const circle = angles.map((_, k) => n + k);
  let band;
  if (polarStep) {
    const { tris, base } = polarBand(ring, pol, polarStep);
    band = [...tris, ...zipper(base, circle, (i) => pol[i][1])];
  } else if (ring.worn && !zipperHolds(ring.root, circle, pol)) {
    // A worn root the zipper would fold: earcut instead (the circle a hole, or the outer contour).
    const xy = pol.map((p) => polarXY(p)), v2 = (ids) => ids.map((i) => new Vector2(...xy[i]));
    const outer = circleR > pol[ring.root[0]][0], [A, B] = outer ? [circle, ring.root] : [ring.root, circle];
    const tris = ShapeUtils.triangulateShape(v2(A), [v2(B)]).map((t) => t.map((i) => (i < A.length ? A[i] : B[i - A.length])));
    band = [...ring.ladder, ...delaunayFlip(orient(tris, xy), xy)];
  } else band = [...ring.ladder, ...zipper(ring.root, circle, (i) => pol[i][1])];
  cap(mesh, pol.map(map), orient(band, pol.map((p) => polarXY(p))), flip);
}

// Band cap of a worn worm thread (polarBand's rows assume the plain outline): earcut from the outline (polar, turned
// by rot) to the circle.
function earBand(mesh, pol, circleR, angles, map, rot, flip) {
  const outer = pol.map(([rho, a]) => [rho, a + rot]), hole = angles.map((a) => [circleR, a]);
  const all = [...outer, ...hole], xy = all.map((p) => polarXY(p)), v2 = xy.map(([x, y]) => new Vector2(x, y));
  cap(mesh, all.map(map), delaunayFlip(orient(ShapeUtils.triangulateShape(v2.slice(0, outer.length), [v2.slice(outer.length)]), xy), xy), flip);
}

// Web between rHub and rRim at |z| <= t/2 with `count` windows (superellipse in scaled polar space).
function holedWeb(mesh, angles, { count, rHub, rRim, t, a, b, p }, wear) {
  const K = angles.length, per = K / count, side = 6, rc = (rHub + rRim) / 2;
  for (let s = 0; s < count; s++) {
    const lo = s * per, hi = (s + 1) * per, alo = (TAU * lo) / K, ahi = (TAU * hi) / K, ac = (alo + ahi) / 2;
    const loop = [];
    for (let k = 0; k < side; k++) loop.push([rHub + ((rRim - rHub) * k) / side, alo]);
    for (let k = lo; k < hi; k++) loop.push([rRim, (TAU * k) / K]);
    for (let k = 0; k < side; k++) loop.push([rHub + ((rRim - rHub) * (side - k)) / side, ahi]);
    for (let k = hi; k > lo; k--) loop.push([rHub, (TAU * k) / K]);
    const hole = loop.map(([rho, al]) => {
      const du = rho - rc, dv = rc * (al - ac);
      const f = (Math.abs(du / a) ** p + Math.abs(dv / b) ** p) ** (-1 / p);
      return [rc + du * f, ac + (dv * f) / rc];
    });
    // Earcut in xy (without the collinear side points): quads from the edge to the window fold in wide cells.
    const inner = (i) => (i > 0 && i < side) || (i > side + per && i < 2 * side + per);
    const edge = loop.filter((_, i) => !inner(i));
    if (wear?.active) {
      const hl = hole.map((q) => polarXY(q)), md = 0.45 * t;
      const top = capRows([hl], [false], wear, { maxDepth: md, end: 1 + 2 * s }), bot = capRows([hl], [false], wear, { maxDepth: md, end: 2 * s });
      const ex = edge.map((q) => polarXY(q));
      for (const [prof, z, flip] of [[top, t / 2, false], [bot, -t / 2, true]]) {
        const xy = [...ex, ...prof.rows[0][0].pts], v2 = xy.map(([x, y]) => new Vector2(x, y));
        cap(mesh, xy.map(([x, y]) => [x, y, z]), delaunayFlip(orient(ShapeUtils.triangulateShape(v2.slice(0, ex.length), [v2.slice(ex.length)]), xy), xy), flip);
      }
      sweepWall(mesh, wallRows(hl, bot.rows[0], top.rows[0], -t / 2, t / 2), (q, z) => [q[0], q[1], z], null, top.smooth, true);
      continue;
    }
    const xy = [...edge, ...hole].map((q) => polarXY(q)), v2 = xy.map(([x, y]) => new Vector2(x, y));
    const ot = orient(ShapeUtils.triangulateShape(v2.slice(0, edge.length), [v2.slice(edge.length)]), xy);
    cap(mesh, xy.map(([x, y]) => [x, y, t / 2]), ot, false);
    cap(mesh, xy.map(([x, y]) => [x, y, -t / 2]), ot, true);
    const hxy = hole.map((q) => polarXY(q)).reverse();
    sweep(mesh, [hxy.map(([x, y]) => [x, y, -t / 2]), hxy.map(([x, y]) => [x, y, t / 2])]);
  }
}

// ---------------------------------------------------------------- bodies

const STYLES = ["solid", "web", "spokes", "holes"];

function resolveBody({ rf, m, width, bore, hub, style, seed, teeth }) {
  const rng = mulberry32(seed ?? teeth * 7919 + 17);
  // Small pinions keep 60% of the root radius inside the rim, so the bore and hub stay positive and ordered.
  const rRim = Math.max(rf - Math.max(1.2 * m, 0.1 * rf), 0.6 * rf);
  let boreR = Math.max(0, Math.min(bore ?? Math.min(0.2 * rRim, 6 * m), rRim - m));
  if (boreR < 0.25 * m) boreR = 0;
  const hubSpec = typeof hub === "number" ? { radius: hub } : hub || {};
  let rHub = hubSpec.radius ?? boreR + Math.max(1.5 * m, (0.25 + 0.2 * rng()) * (rRim - boreR));
  rHub = Math.max(boreR, Math.min(Math.max(rHub, boreR + m), rRim - m));
  const room = rRim - rHub;
  // "auto" never picks a plain solid disc when there is room for a sunk web, spokes or holes.
  const auto = room > 5 * m ? ["web", "web", "spokes", "holes"] : room > 0.8 * m ? ["web"] : ["solid"];
  const allowed = room > 5 * m ? STYLES : room > 0.8 * m ? ["solid", "web"] : ["solid"];
  let spec = typeof style === "object" && style ? { ...style } : { type: style ?? "auto" };
  if (spec.type === "auto" || !STYLES.includes(spec.type)) spec.type = auto[Math.floor(rng() * auto.length)];
  if (!allowed.includes(spec.type)) spec.type = allowed[allowed.length - 1];
  const t = spec.type === "solid" ? width : Math.min(width, Math.max(1.5 * m, width * (spec.web ?? 0.3 + 0.25 * rng())));
  const hw = Math.max(t, hubSpec.width ?? (spec.type === "solid" ? width : width * (1 + 0.3 * rng())));
  if (spec.type === "spokes") spec.count = Math.max(1, Math.round(spec.count ?? 3 + Math.floor(rng() * 4)));
  if (spec.type === "holes") spec.count = Math.max(1, Math.round(spec.count ?? 4 + Math.floor(rng() * 5)));
  return { rRim, bore: boreR, rHub, hubWidth: hw, web: t, style: spec };
}

// Lathe paths of the body (cut by chamfer c at convex corners) and how far each cap band must stop short of rRim.
function bodyPaths(body, width, c = 0) {
  const { rRim, rHub, bore, hubWidth: hw, web: t, style } = body;
  const top = [[rRim, width / 2], [rRim, t / 2]];
  const mid = [[rHub, t / 2], [rHub, hw / 2], [bore, hw / 2], [bore, -hw / 2], [rHub, -hw / 2], [rHub, -t / 2]];
  const bottom = [[rRim, -t / 2], [rRim, -width / 2]];
  const windows = style.type === "spokes" || style.type === "holes";
  if (!(c > 0)) return { paths: windows ? [top, mid, bottom] : [[...top, ...mid, ...bottom]], top: 0, bottom: 0 };
  if (!windows) {
    const r = chamferPath([...top, ...mid, ...bottom], c, [-1, 0], [1, 0]);
    return { paths: [r.path], top: r.start, bottom: r.end };
  }
  const T = chamferPath(top, c, [-1, 0], [-1, 0]), M = chamferPath(mid, c, [-1, 0], [1, 0]), B = chamferPath(bottom, c, [1, 0], [1, 0]);
  return { paths: [T.path, M.path, B.path], top: T.start, bottom: B.end };
}

function buildBody(mesh, angles, body, paths) {
  const { rRim, rHub, web: t, style } = body;
  for (const path of paths.paths) lathe(mesh, angles, path);
  if (style.type === "spokes" || style.type === "holes") {
    const span = rRim - rHub, rc = (rRim + rHub) / 2, arc = (rc * Math.PI) / style.count;
    if (style.type === "spokes") {
      const spoke = Math.max(1.2 * body.module, 0.22 * arc);
      holedWeb(mesh, angles, { count: style.count, rHub, rRim, t, a: span / 2 - Math.max(0.8 * body.module, 0.12 * span), b: arc - spoke, p: 4 }, paths.wear);
    } else {
      const rad = Math.min(span * 0.34, arc * 0.62);
      holedWeb(mesh, angles, { count: style.count, rHub, rRim, t, a: rad, b: rad, p: 2 }, paths.wear);
    }
  }
}

function bodyAngles(teeth, count) {
  const k = Math.max(48, Math.min(160, Math.round(teeth * 2.5)));
  return uniformAngles(count ? count * Math.ceil(k / count) : k);
}

// Polar (rho, angle) of 2D points, each angle unwrapped next to ref's.
const toPolar = (pts, ref) => pts.map(([x, y], i) => { const a = Math.atan2(y, x); return [Math.hypot(x, y), a + TAU * Math.round((ref[i][1] - a) / TAU)]; });

/**
 * Wall of a toothed outline (worn loop xy of ring's outline) between its cap profiles, from z0 to z1. Rows are placed
 * from polar coordinates, so the plain outline reproduces ring.pts exactly. Returns prof -> the ring for that cap.
 */
function toothWall(mesh, ring, outline, xy, top, bot, z0, z1, { twist = () => 0, slices, breaks, crease, reverse = false, place }) {
  const polar = new Map([[outline, ring.pts]]);
  const P = (pts) => { let v = polar.get(pts); if (!v) polar.set(pts, (v = toPolar(pts, ring.pts))); return v; };
  const wr = wallRows(xy, bot ? bot.rows[0] : null, top ? top.rows[0] : null, z0, z1, { breaks, slices });
  for (const r of wr.rows) r.pts = P(r.pts);
  sweepWall(mesh, wr, place ?? ((q, z) => [...polarXY(q, twist(z)), z]), crease, top?.smooth, reverse);
  return (prof) => ({ ...ring, pts: P(prof ? prof.rows[0][0].pts : xy), worn: !!prof || xy !== outline });
}

// Body lathes get the chamfer plus some of the edge wear.
const bodyChamfer = (wear) => (wear?.active ? wear.chamfer + (wear.erosion ? 0.5 * wear.erosion.amount * wear.erosion.edge * wear.scale : 0) : 0);

/**
 * Toothed cylinder: outline twisted by twist(z) (cut at `breaks`, sliced to maxStep of twist), band down to body.rRim,
 * then the body lathe. With wear: worn outline, cap profiles at both faces, chamfered body and pits.
 */
function toothedCylinder({ prof, teeth, width, twist, maxStep, body, wear = wearOptions({}, 1), breaks = [], rate }) {
  const mesh = new MeshBuilder();
  const ring = toothRing(teeth, prof.flank);
  const angles = bodyAngles(teeth, body.style.count);
  const z0 = -width / 2, z1 = width / 2;
  const outline = ring.pts.map((p) => polarXY(p));
  const xy = wearLoops([outline], [true], wear)[0];
  const keep = ring.ladder;
  const paths = { ...bodyPaths(body, width, bodyChamfer(wear)), wear };
  const circle = (r) => [angles.map((a) => [r * Math.cos(a), r * Math.sin(a)])];
  const top = capRows([xy], [true], wear, { maxDepth: 0.45 * width, end: 1, keep, obstacles: circle(body.rRim + paths.top) });
  const bot = capRows([xy], [true], wear, { maxDepth: 0.45 * width, end: 0, keep, obstacles: circle(body.rRim + paths.bottom) });
  const slices = (a, b) => Math.max(1, Math.ceil(Math.abs(twist(b) - twist(a)) / maxStep));
  const capRing = toothWall(mesh, ring, outline, xy, top, bot, z0, z1, { twist, slices, breaks, crease: wallCreases(xy, rate ?? (twist(z1) - twist(z0)) / (z1 - z0)) });
  bandCap(mesh, capRing(top), body.rRim + paths.top, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), z1], twist(z1), false);
  bandCap(mesh, capRing(bot), body.rRim + paths.bottom, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), z0], twist(z0), true);
  buildBody(mesh, angles, body, paths);
  return { mesh: pitFaces(mesh.finish(), wear ?? {}, { width }), outline };
}

function geometryInfo(g) { return { position: g.position, normal: g.normal, index: g.index, triangles: g.index.length / 3 }; }

// ---------------------------------------------------------------- builders

/**
 * External involute spur gear, axis +z, face from -width/2 to width/2, tooth 0 centred on +x.
 * style: "auto" (seeded pick) | "solid" | "web" | "spokes" | "holes", or { type, count, web }.
 * hub: radius number or { radius, width }. bore: bore radius (0 = solid).
 * chamfer: bevel of every cap edge (scene units; true = DEFAULT_CHAMFER modules). erosion: amount 0..1 or
 * { amount, seed }: worn tips, eaten cap edges, chipped corners and pitted faces. Both only remove material, and
 * every builder below takes them.
 */
export function spurGear({ teeth, module: mod = 0.02, width, bore, hub, style = "auto", seed, chamfer, erosion } = {}) {
  width = width ?? 5 * mod;
  const prof = externalFlank({ teeth, module: mod, thickness: (Math.PI / 2 - 2 * BACKLASH) * mod });
  const body = { ...resolveBody({ rf: prof.rf, m: mod, width, bore, hub, style, seed, teeth }), module: mod };
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? teeth * 7919 + 17);
  const { mesh, outline } = toothedCylinder({ prof, teeth, width, twist: () => 0, maxStep: 1, body, wear });
  return {
    kind: "spur", teeth, module: mod, width, ...geometryInfo(mesh), outline,
    pitchRadius: prof.r, baseRadius: prof.rb, tipRadius: prof.ra, rootRadius: prof.rf, halfWidth: prof.w, body,
  };
}

/**
 * Helical gear: the transverse involute profile twisted along z by twistRate = tan(helix) / pitchRadius. module is
 * the transverse module (centre distances stay m (NA + NB) / 2), the pressure angle is 20 deg in the normal plane and
 * normalModule = module * cos(helix) (pass it instead of module to set that one), which also sizes the addendum (1)
 * and dedendum (1.25), the body and the wear, so any two gears of one normal module mesh. helix > 0 is right-handed:
 * a tooth's azimuth grows with z. herringbone: twists that way up to z = 0, then back (twist = -twistRate * |z|).
 * Tooth 0 on +x at z = 0; body, style, chamfer and erosion as spurGear.
 */
export function helicalGear({ teeth, module: mod, normalModule, width, helix = (20 * Math.PI) / 180, herringbone = false, bore, hub, style = "auto", seed, chamfer, erosion } = {}) {
  const cb = Math.cos(helix);
  mod = normalModule ? normalModule / cb : mod ?? 0.02;
  width = width ?? 5 * mod;
  const at = Math.atan(Math.tan(PRESSURE_ANGLE) / cb);
  const mn = mod * cb, prof = externalFlank({ teeth, module: mod, alpha: at, thickness: (Math.PI / 2 - 2 * BACKLASH) * mod, addendum: ADDENDUM * mn, dedendum: DEDENDUM * mn });
  const body = { ...resolveBody({ rf: prof.rf, m: mn, width, bore, hub, style, seed, teeth }), module: mn };
  const wear = wearOptions({ chamfer, erosion }, mn, seed ?? teeth * 7919 + 29);
  const k = Math.tan(helix) / prof.r;
  const twist = herringbone ? (z) => -k * Math.abs(z) : (z) => k * z;
  // Twist slices whose chords sag at most 0.01 normal module at the tip (inward, so only backlash grows).
  const maxStep = Math.max(TAU / (teeth * 8), Math.sqrt((0.08 * mn) / prof.ra));
  const { mesh, outline } = toothedCylinder({ prof, teeth, width, twist, maxStep, body, wear, breaks: herringbone ? [0] : [], rate: k });
  return {
    kind: herringbone ? "herringbone" : "helical", teeth, module: mod, normalModule: mn, width, helix, herringbone, twistRate: k,
    pressureAngle: at, ...geometryInfo(mesh), outline,
    pitchRadius: prof.r, baseRadius: prof.rb, tipRadius: prof.ra, rootRadius: prof.rf, halfWidth: prof.w, body,
  };
}

/** Internal ring gear: teeth point inward, outer radius = root + rim. Tooth 0 centred on +x. */
export function ringGear({ teeth, module: mod = 0.02, width, rim, chamfer, erosion, seed } = {}) {
  width = width ?? 5 * mod;
  rim = rim ?? 3 * mod;
  const prof = internalFlank({ teeth, module: mod, thickness: (Math.PI / 2 - 2 * BACKLASH) * mod });
  const outer = prof.rf + rim;
  const mesh = new MeshBuilder(), ring = toothRing(teeth, prof.flank, INTERNAL_RING), angles = uniformAngles(Math.max(64, Math.min(192, teeth * 2)));
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? teeth * 7919 + 41);
  const outline = ring.pts.map((p) => polarXY(p)), xy = wearLoops([outline], [false], wear)[0];
  const keep = ring.ladder, cO = Math.min(bodyChamfer(wear), 0.3 * rim, 0.3 * width);
  const obstacles = [angles.map((a) => [(outer - cO) * Math.cos(a), (outer - cO) * Math.sin(a)])];
  const top = capRows([xy], [false], wear, { maxDepth: 0.45 * width, end: 1, keep, obstacles }), bot = capRows([xy], [false], wear, { maxDepth: 0.45 * width, end: 0, keep, obstacles });
  const capRing = toothWall(mesh, ring, outline, xy, top, bot, -width / 2, width / 2, { crease: creases([...xy].reverse()), reverse: true });
  bandCap(mesh, capRing(top), outer - cO, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), width / 2], 0, false);
  bandCap(mesh, capRing(bot), outer - cO, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), -width / 2], 0, true);
  lathe(mesh, angles, cO > 0 ? [[outer - cO, -width / 2], [outer, -width / 2 + cO], [outer, width / 2 - cO], [outer - cO, width / 2]] : [[outer, -width / 2], [outer, width / 2]]);
  return {
    kind: "ring", teeth, module: mod, width, ...geometryInfo(pitFaces(mesh.finish(), wear, { width })), outline,
    pitchRadius: prof.r, baseRadius: prof.rb, tipRadius: prof.ra, rootRadius: prof.rf, outerRadius: outer, halfWidth: prof.w,
  };
}

/** Closed 2D outline [x, y][] (CCW) at z = 0, theta = 0. internal: the toothed inner loop of a ring gear. */
export function toothProfile(teeth, module = 0.02, internal = false) {
  const thickness = (Math.PI / 2 - 2 * BACKLASH) * module;
  const prof = internal ? internalFlank({ teeth, module, thickness }) : externalFlank({ teeth, module, thickness });
  return toothRing(teeth, prof.flank, internal ? INTERNAL_RING : undefined).pts.map((p) => polarXY(p));
}

/** Pitch angles [deltaA, deltaB] of a bevel pair with tooth counts nA, nB at shaft angle sigma. */
export function bevelPitchAngles(nA, nB, sigma = Math.PI / 2) {
  const dA = Math.atan2(Math.sin(sigma), nB / nA + Math.cos(sigma));
  return [dA, sigma - dA];
}

/**
 * Straight bevel gear with spherical-involute teeth (conical: every point lies on a ray from the apex).
 * Axis +z. The back face is the plane z = 0 and the teeth sit on a cone that narrows toward +z; the pitch-cone apex
 * is at (0, 0, apex) with apex = coneDistance * cos(innerAngle), returned on the gear. Teeth span cone distances
 * [coneDistance - faceWidth, coneDistance]; module is measured at the back (outer) end.
 */
export function bevelGear({ teeth: N, module: mod = 0.02, pitchAngle = Math.PI / 4, faceWidth, bore, chamfer, erosion, seed } = {}) {
  const delta = pitchAngle, r = (N * mod) / 2, L = r / Math.sin(delta);
  const F = Math.min(faceWidth ?? Math.min(L / 3, 10 * mod), 0.4 * L);
  const thickness = (Math.PI / 2 - 2 * BACKLASH) * mod;
  const Nv = N / Math.cos(delta), rv = L * Math.tan(delta);
  const v2 = externalFlank({ teeth: Nv, module: mod, thickness, flankPoints: 11 });
  const db = Math.asin(Math.sin(delta) * Math.cos(PRESSURE_ANGLE)), sdb = Math.sin(db);
  const invS = (g) => { const psi = Math.acos(Math.min(1, Math.cos(g) / Math.cos(db))); return psi / sdb - Math.atan(Math.tan(psi) / sdb); };
  const psiP = thickness / (2 * r), invP = invS(delta);
  const toRho2 = (g) => rv + L * Math.tan(g - delta);
  const w = (g) => Math.min(psiP + invP - invS(Math.max(g, db)), v2.w(toRho2(g)) / Math.cos(delta));
  const flank = v2.flank.map(([rho]) => { const g = delta + Math.atan((rho - rv) / L); return [g, w(g)]; });
  const gf = flank[0][0], ga = flank[flank.length - 1][0];
  const gin = gf - Math.max(1.5 * mod / L, 0.02);
  const apex = L * Math.cos(gin);
  const dir = (g, a, rho) => [rho * Math.sin(g) * Math.cos(a), rho * Math.sin(g) * Math.sin(a), apex - rho * Math.cos(g)];

  const mesh = new MeshBuilder(), ring = toothRing(N, flank), angles = uniformAngles(Math.max(48, Math.min(160, Math.round(N * 2.5))));
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? N * 7919 + 53);
  const xy = ring.pts.map((p) => polarXY(p)), worn = wearLoops([xy], [true], wear, { unit: L })[0];
  // Bevel caps keep the ladder (earcut's slivers would cut across the curved faces), so row 0 may not turn it over.
  const keep = ring.ladder;
  const obstacles = [angles.map((a) => [gin * Math.cos(a), gin * Math.sin(a)])];
  const back = capRows([worn], [true], wear, { unit: L, maxDepth: 0.45 * F, end: 1, keep, obstacles }), front = capRows([worn], [true], wear, { unit: L - F, maxDepth: 0.45 * F, end: 0, keep, obstacles });
  const crease = creases((worn === xy ? ring.pts : toPolar(worn, ring.pts)).map(([g, a]) => dir(g, a, L)));
  const capRing = toothWall(mesh, ring, xy, worn, front, back, L, L - F, { crease, place: ([g, a], rho) => dir(g, a, rho) });
  bandCap(mesh, capRing(back), gin, angles, ([g, a]) => dir(g, a, L), 0, true);
  bandCap(mesh, capRing(front), gin, angles, ([g, a]) => dir(g, a, L - F), 0, false);

  const rFront = (L - F) * Math.sin(gin), zFront = apex - (L - F) * Math.cos(gin);
  const boreR = Math.max(0, Math.min(bore ?? 0.3 * rFront, 0.7 * rFront));
  const rH = boreR + 0.45 * (rFront - boreR);
  const zH = zFront + 0.5 * (apex - rH / Math.tan(gin) - zFront);
  const path = [[rFront, zFront], [rH, zFront], [rH, zH], [boreR, zH], [boreR, 0], [L * Math.sin(gin), 0]];
  lathe(mesh, angles, chamferPath(path, bodyChamfer(wear)).path);
  const geo = pitFaces(mesh.finish(), wear, { width: F });
  return {
    kind: "bevel", teeth: N, module: mod, pitchAngle: delta, faceWidth: F, coneDistance: L, apex, ...geometryInfo(geo),
    rootAngle: gf, tipAngle: ga, innerAngle: gin, halfWidth: w, outline: xy, bodyPath: path, pitchRadius: r,
  };
}

/** Lead angle of a worm at its pitch radius (rootRadius + 1.25 module). */
export function wormLeadAngle({ module: mod = 0.02, starts = 1, rootRadius }) {
  return Math.atan((starts * mod) / (2 * (rootRadius + DEDENDUM * mod)));
}

/**
 * Involute (ZI) worm, axis +z, thread from -length/2 to length/2, right-handed: the thread centre sits at azimuth
 * theta + 2 pi k / starts + 2 pi z / lead, lead = starts * pi * module. So a +theta turn screws it +z through a fixed
 * nut, i.e. the pattern at a fixed azimuth moves by -lead * theta / 2 pi. Optional shaft: { radius, length } each end.
 */
export function worm({ module: mod = 0.02, starts = 1, length, rootRadius, bore = 0, shaft, chamfer, erosion, seed } = {}) {
  rootRadius = rootRadius ?? 2.5 * mod;
  const r1 = rootRadius + DEDENDUM * mod, lambda = Math.atan((starts * mod) / (2 * r1)), lead = starts * Math.PI * mod;
  length = length ?? 6 * Math.PI * mod;
  const mt = mod / Math.tan(lambda), at = Math.atan(Math.tan(PRESSURE_ANGLE) / Math.sin(lambda));
  const thickness = ((Math.PI * mod * Math.cos(lambda)) / 2 - 2 * BACKLASH * mod) / Math.sin(lambda);
  const prof = externalFlank({ teeth: starts, module: mt, alpha: at, thickness, addendum: ADDENDUM * mod, dedendum: DEDENDUM * mod, cutter: false, flankPoints: 16 });
  // Twist/arc step: facets of at most 0.6 module at the tip keep the faceting error under a third of the backlash.
  const rIn = prof.rf - 0.5 * mod, step = Math.min(TAU / 48, (0.6 * mod) / prof.ra);
  const arcPoints = (span) => Math.max(1, Math.round(span / step) - 1);
  const sr = shaft ? Math.min(shaft.radius ?? 0.6 * rIn, rIn) : 0, sl = shaft ? shaft.length ?? 4 * mod : 0;
  const mesh = new MeshBuilder(), ring = toothRing(starts, prof.flank, { tipPoints: arcPoints(2 * prof.w(prof.ra)), rootPoints: arcPoints(TAU / starts - 2 * prof.w(prof.rf)) }), angles = uniformAngles(48);
  const z0 = -length / 2, z1 = length / 2, twist = (z) => (TAU * z) / lead;
  // No chips: a chip's deep rows twist far round the thread, and their band would cross its neighbours.
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? starts * 7919 + 67, { chips: 0 });
  const xy = ring.pts.map((p) => polarXY(p)), worn = wearLoops([xy], [true], wear)[0];
  const md = Math.min(0.45 * length, 2 * mod), obstacles = [angles.map((a) => [rIn * Math.cos(a), rIn * Math.sin(a)])];
  const top = capRows([worn], [true], wear, { maxDepth: md, end: 1, obstacles }), bot = capRows([worn], [true], wear, { maxDepth: md, end: 0, obstacles });
  const slices = (a, b) => Math.ceil((twist(b) - twist(a)) / step);
  const capRing = toothWall(mesh, ring, xy, worn, top, bot, z0, z1, { twist, slices, crease: wallCreases(worn, TAU / lead) });
  const band = wear.active ? (r, ...a) => earBand(mesh, r.pts, ...a.slice(0, 5)) : (r, ...a) => bandCap(mesh, r, ...a);
  band(capRing(top), rIn, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), z1], twist(z1), false, step);
  band(capRing(bot), rIn, angles, ([rho, a]) => [rho * Math.cos(a), rho * Math.sin(a), z0], twist(z0), true, step);
  const b = Math.min(bore, (sr || rIn) - 0.5 * mod);
  const path = sl > 0
    ? [[rIn, z1], [sr, z1], [sr, z1 + sl], [b, z1 + sl], [b, z0 - sl], [sr, z0 - sl], [sr, z0], [rIn, z0]]
    : [[rIn, z1], [b, z1], [b, z0], [rIn, z0]];
  lathe(mesh, angles, chamferPath(path, bodyChamfer(wear)).path);
  return {
    kind: "worm", starts, module: mod, length, lead, leadAngle: lambda, ...geometryInfo(pitFaces(mesh.finish(), wear, { width: 2 * rIn })), outline: xy,
    pitchRadius: r1, baseRadius: prof.rb, tipRadius: prof.ra, rootRadius: prof.rf, halfWidth: prof.w,
  };
}

/**
 * Worm wheel: a right-handed involute helical gear (helix angle = lead, the worm's lead angle) that meshes with
 * worm() as a crossed helical pair. Same frame, body and style options as spurGear; tooth 0 on +x at z = 0, and a
 * tooth's azimuth grows by z * tan(lead) / pitchRadius.
 */
export function wormWheel({ teeth, module: mod = 0.02, width, lead, bore, hub, style = "auto", seed, chamfer, erosion } = {}) {
  width = width ?? 4 * mod;
  const lambda = lead ?? wormLeadAngle({ module: mod, starts: 1, rootRadius: 2.5 * mod });
  const at = Math.atan(Math.tan(PRESSURE_ANGLE) / Math.cos(lambda));
  const thickness = (Math.PI / 2 - (2 * BACKLASH) / Math.cos(lambda)) * mod;
  const prof = externalFlank({ teeth, module: mod, alpha: at, thickness });
  const body = { ...resolveBody({ rf: prof.rf, m: mod, width, bore, hub, style, seed, teeth }), module: mod };
  const k = Math.tan(lambda) / prof.r;
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? teeth * 7919 + 79);
  const { mesh, outline } = toothedCylinder({ prof, teeth, width, twist: (z) => z * k, maxStep: TAU / (teeth * 8), body, wear });
  return {
    kind: "wormWheel", teeth, module: mod, width, leadAngle: lambda, twistRate: k, ...geometryInfo(mesh), outline,
    pitchRadius: prof.r, baseRadius: prof.rb, tipRadius: prof.ra, rootRadius: prof.rf, halfWidth: prof.w, body,
  };
}

/** 2D outline [x, y][] (CCW) of a rack: pitch line y = 0, teeth up to +module, body down to -height. */
export function rackProfile(teeth, module = 0.02, height) {
  return rackOutline(teeth, module, height ?? 3 * module).pts;
}

function rackOutline(teeth, mod, height) {
  const p = Math.PI * mod, s = (Math.PI / 2 - 2 * BACKLASH) * mod, ta = Math.tan(PRESSURE_ANGLE);
  const ha = ADDENDUM * mod, hf = DEDENDUM * mod, k0 = -Math.floor((teeth - 1) / 2);
  const half = (y) => s / 2 - y * ta;
  const x0 = (k0 - 0.5) * p, x1 = (k0 + teeth - 0.5) * p;
  const pts = [[x0, -height], [x1, -height]], top = [];
  const add = (x, y) => { top.push(pts.length); pts.push([x, y]); };
  add(x1, -hf);
  const teethIds = [];
  for (let k = k0 + teeth - 1; k >= k0; k--) {
    const c = k * p;
    const ids = [];
    add(c + half(-hf), -hf); ids.push(top[top.length - 1]);
    add(c + half(ha), ha); ids.push(top[top.length - 1]);
    add(c - half(ha), ha); ids.push(top[top.length - 1]);
    add(c - half(-hf), -hf); ids.push(top[top.length - 1]);
    teethIds.push(ids);
    if (k > k0) add(c - p / 2, -hf);
  }
  add(x0, -hf);
  return { pts, top, teethIds, p, k0 };
}

/** Rack along local +x: tooth k centred on x = k * pi * module (k = 0 at the origin), teeth pointing +y. */
export function rack({ module: mod = 0.02, teeth = 12, width, height, chamfer, erosion, seed } = {}) {
  width = width ?? 5 * mod;
  height = height ?? 3 * mod;
  const { pts, top, teethIds } = rackOutline(teeth, mod, height);
  const wear = wearOptions({ chamfer, erosion }, mod, seed ?? teeth * 7919 + 97);
  if (wear.active) {
    // Points along the bottom, so the cap does not fan rack-long slivers from it.
    const k = Math.max(1, Math.round((pts[1][0] - pts[0][0]) / (0.5 * Math.PI * mod)));
    const loop = [pts[0], ...Array.from({ length: k - 1 }, (_, i) => [pts[0][0] + ((pts[1][0] - pts[0][0]) * (i + 1)) / k, pts[0][1]]), ...pts.slice(1)];
    const geo = profiledExtrusion(loop, [], -width / 2, width / 2, wear, { creaseAngle: 0.3 });
    return { kind: "rack", teeth, module: mod, width, height, pitch: Math.PI * mod, ...geometryInfo(geo), outline: pts };
  }
  const mesh = new MeshBuilder(), tris = [];
  for (const [a, b, c, d] of teethIds) tris.push([a, b, c], [a, c, d]);
  const rootIds = top.filter((i) => Math.abs(pts[i][1] + DEDENDUM * mod) < 1e-12);
  const all = [...pts];
  const bottom = rootIds.map((i, k) => (k === 0 ? 1 : k === rootIds.length - 1 ? 0 : all.push([pts[i][0], -height]) - 1));
  for (let k = 0; k < rootIds.length - 1; k++) tris.push([rootIds[k], rootIds[k + 1], bottom[k + 1]], [rootIds[k], bottom[k + 1], bottom[k]]);
  const ot = orient(tris, all);
  cap(mesh, all.map(([x, y]) => [x, y, width / 2]), ot, false);
  cap(mesh, all.map(([x, y]) => [x, y, -width / 2]), ot, true);
  const outline = [...pts];
  const bottomRow = bottom.slice(1, -1).reverse().map((i) => all[i]);
  const loop = [outline[0], ...bottomRow, ...outline.slice(1)];
  sweep(mesh, [loop.map(([x, y]) => [x, y, -width / 2]), loop.map(([x, y]) => [x, y, width / 2])], creases(loop, 0.3));
  return { kind: "rack", teeth, module: mod, width, height, pitch: Math.PI * mod, ...geometryInfo(mesh.finish()), outline: pts };
}

// ---------------------------------------------------------------- pairing

// thetaB at thetaA = 0 so that a tooth of A at the contact faces a space of B; sigma = d(azB)/d(azA) along the contact.
const meshPhase = (fA, azB, pB, sigma) => wrap(azB - pB * (sigma * fA + 0.5), pB);

const translation = (x, y, z) => new Matrix4().makeTranslation(x, y, z);

function sameModule(name, A, B) {
  if (Math.abs(A.module - B.module) > 1e-12) throw new Error(`${name}: both gears must have the same module (${A.module}, ${B.module})`);
}

/** External pair: B's centre at angle `direction` from A, centre distance m (NA + NB) / 2, frames parallel. */
export function meshSpur(A, B, direction = 0) {
  sameModule("meshSpur", A, B);
  const d = (A.module * (A.teeth + B.teeth)) / 2, pA = TAU / A.teeth, pB = TAU / B.teeth;
  return {
    transform: translation(d * Math.cos(direction), d * Math.sin(direction), 0),
    ratio: -A.teeth / B.teeth,
    phase: meshPhase(direction / pA, direction + Math.PI, pB, -1),
    distance: d,
  };
}

/**
 * Parallel helical (or herringbone) pair, placed and phased like meshSpur at z = 0. Needs opposite hands
 * (helixA = -helixB) and both herringbone or neither.
 */
export function meshHelical(A, B, direction = 0) {
  sameModule("meshHelical", A, B);
  const hA = A.helix ?? 0, hB = B.helix ?? 0;
  if (Math.abs(hA + hB) > 1e-9) throw new Error(`meshHelical: the gears need opposite hands (helix ${hA}, ${hB})`);
  if (!!A.herringbone !== !!B.herringbone) throw new Error("meshHelical: a herringbone gear meshes only with another herringbone");
  return meshSpur(A, B, direction);
}

/**
 * Crossed helical pair on skew axes: B's centre at angle `direction` in A's xy plane, at A.pitchRadius +
 * B.pitchRadius; B's axis is A's z turned by shaftAngle about that centre line, toward A's CCW tangent there (90 deg:
 * B's z = A's z x direction, as meshWorm). Helix angles must sum to the shaft angle (so the same hand at 90 deg),
 * normal modules must match, and herringbones cannot cross. ratio = -NA / NB.
 */
export function meshCrossedHelical(A, B, shaftAngle = Math.PI / 2, direction = 0) {
  const hA = A.helix ?? 0, hB = B.helix ?? 0, nA = A.normalModule ?? A.module, nB = B.normalModule ?? B.module;
  if (Math.abs(nA - nB) > 1e-12) throw new Error(`meshCrossedHelical: both gears must have the same normal module (${nA}, ${nB})`);
  if (Math.abs(hA + hB - shaftAngle) > 1e-9) throw new Error(`meshCrossedHelical: helix angles ${hA} + ${hB} must sum to the shaft angle ${shaftAngle}`);
  if (A.herringbone || B.herringbone) throw new Error("meshCrossedHelical: herringbone gears cannot run on crossed axes");
  const c = Math.cos(direction), s = Math.sin(direction), a = A.pitchRadius + B.pitchRadius;
  const xB = new Vector3(c, s, 0), zB = new Vector3(-s * Math.sin(shaftAngle), c * Math.sin(shaftAngle), Math.cos(shaftAngle));
  const yB = new Vector3().crossVectors(zB, xB);
  return {
    transform: new Matrix4().makeBasis(xB, yB, zB).setPosition(a * c, a * s, 0),
    ratio: -A.teeth / B.teeth,
    phase: meshPhase(direction / (TAU / A.teeth), Math.PI, TAU / B.teeth, -1),
    distance: a,
  };
}

/** Pinion inside a ring; centre distance m (NR - NP) / 2, frames parallel, same sense (ratio NR / NP). */
export function meshRing(ring, pinion, direction = 0) {
  sameModule("meshRing", ring, pinion);
  const d = (ring.module * (ring.teeth - pinion.teeth)) / 2, pR = TAU / ring.teeth, pP = TAU / pinion.teeth;
  return {
    transform: translation(d * Math.cos(direction), d * Math.sin(direction), 0),
    ratio: ring.teeth / pinion.teeth,
    phase: meshPhase(direction / pR, direction, pP, 1),
    distance: d,
  };
}

/**
 * Rack tangent to the pinion's pitch circle at angle `direction`, teeth toward the pinion, rack z = pinion z.
 * The rack's local +x is the pinion's CCW tangent there, so its displacement is s = ratio * theta + phase with
 * ratio = +pitchRadius; place it with transform * translation(s, 0, 0).
 */
export function meshRack(pinion, rk, direction = 0) {
  sameModule("meshRack", pinion, rk);
  const r = (pinion.module * pinion.teeth) / 2, c = Math.cos(direction), s = Math.sin(direction), p = Math.PI * rk.module;
  const transform = new Matrix4().makeBasis(new Vector3(-s, c, 0), new Vector3(-c, -s, 0), new Vector3(0, 0, 1)).setPosition(r * c, r * s, 0);
  return { transform, ratio: r, phase: meshPhase(direction / (TAU / pinion.teeth), 0, p, 1) };
}

/**
 * Bevel pair sharing the pitch-cone apex. B's axis is A's axis tilted by shaftAngle toward `direction`; the pitch
 * cones touch along A's generator at azimuth `direction` (B's azimuth pi). Pitch angles must match
 * bevelPitchAngles(NA, NB, shaftAngle).
 */
export function meshBevel(A, B, shaftAngle = Math.PI / 2, direction = 0) {
  sameModule("meshBevel", A, B);
  const [dA, dB] = bevelPitchAngles(A.teeth, B.teeth, shaftAngle);
  if (Math.abs(dA - A.pitchAngle) > 1e-6 || Math.abs(dB - B.pitchAngle) > 1e-6) throw new Error(`meshBevel: pitch angles must be ${dA}, ${dB}`);
  const c = Math.cos(direction), s = Math.sin(direction), S = shaftAngle;
  const apex = new Vector3(0, 0, A.apex);
  const g = new Vector3(Math.sin(dA) * c, Math.sin(dA) * s, -Math.cos(dA));
  const zB = new Vector3(-Math.sin(S) * c, -Math.sin(S) * s, Math.cos(S));
  const xB = g.clone().addScaledVector(zB, -g.dot(zB)).normalize().negate();
  const yB = new Vector3().crossVectors(zB, xB);
  const origin = apex.clone().addScaledVector(zB, -B.apex);
  const tA = new Vector3(0, 0, 1).cross(g), tB = zB.clone().cross(g);
  const sigma = Math.sign(tA.dot(tB));
  return {
    transform: new Matrix4().makeBasis(xB, yB, zB).setPosition(origin),
    ratio: (sigma * A.teeth) / B.teeth,
    phase: meshPhase(direction / (TAU / A.teeth), Math.PI, TAU / B.teeth, sigma),
  };
}

/**
 * Worm (A) and wheel (B) as a crossed helical pair: the wheel centre at angle `direction` in the worm's xy plane,
 * at distance worm.pitchRadius + wheel.pitchRadius, wheel axis = worm z x direction, wheel mid-plane through the worm
 * axis. ratio = -starts / N.
 */
export function meshWorm(wm, wheel, direction = 0) {
  if (Math.abs(wm.leadAngle - wheel.leadAngle) > 1e-9 || wm.module !== wheel.module) throw new Error("meshWorm: wheel lead angle/module must match the worm");
  const c = Math.cos(direction), s = Math.sin(direction), a = wm.pitchRadius + wheel.pitchRadius;
  const transform = new Matrix4().makeBasis(new Vector3(c, s, 0), new Vector3(0, 0, -1), new Vector3(-s, c, 0)).setPosition(a * c, a * s, 0);
  return {
    transform,
    ratio: -wm.starts / wheel.teeth,
    phase: meshPhase((-direction * wm.starts) / TAU, Math.PI, TAU / wheel.teeth, 1),
    distance: a,
  };
}

/**
 * Planetary set with the ring fixed at ringAngle. Inputs are gear descriptors or { teeth, module }.
 * planet(k, sunAngle) gives the planet's carrier angle, its spin (its own theta, fixed frame) and centre.
 */
export function planetary({ sun, planet, ring, count = 3 }) {
  const Ns = sun.teeth, Np = planet.teeth, Nr = ring.teeth, mod = sun.module;
  const errors = [];
  if (Nr !== Ns + 2 * Np) errors.push(`ring must have ${Ns + 2 * Np} teeth`);
  if ((Ns + Nr) % count !== 0) errors.push(`(sun + ring) must be divisible by ${count}`);
  const radius = (mod * (Ns + Np)) / 2;
  if (2 * radius * Math.sin(Math.PI / count) < mod * (Np + 2) + 0.5 * mod) errors.push("planets overlap");
  const angles = Array.from({ length: count }, (_, k) => (TAU * k) / count);
  const carrierRatio = Ns / (Ns + Nr);
  const phases = angles.map((a) => meshSpur(sun, planet, a).phase);
  const rp = meshRing(ring, planet, 0);
  const pR = TAU / Nr;
  const ringAngle = wrap(((phases[0] - rp.phase) * Np) / Nr, pR);
  return {
    valid: errors.length === 0, errors, carrierRadius: radius, angles, carrierRatio, ringAngle, planetPhases: phases,
    planet(k, sunAngle) {
      const c = sunAngle * carrierRatio, a = angles[k] + c;
      return { angle: a, spin: c - ((sunAngle - c) * Ns) / Np + phases[k], position: [radius * Math.cos(a), radius * Math.sin(a), 0] };
    },
  };
}
