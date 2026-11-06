// Great-circle arrangements on the unit sphere: channels run along the circles, turntables sit at
// the crossings and the faces between them become plates. Plain arrays, no three.js.

export const R = 1; // plate top
export const RF = 0.915; // channel floor (the core)
// The mechanism's sizes, scaled down for dense layouts (live bindings: importers see the current scale).
export let SCALE = 1;
export let W = 0.078; // channel width, radians
export let BEVEL = 0.011;
export let RT = 0.088; // turntable radius
export let RC = RT + 0.009; // turntable clearance cut into the plates
export let DIAL_GAP = 0.008;
let SMOOTH = 0.022;
export function setMechanismScale(k) {
  SCALE = k;
  W = 0.078 * k;
  BEVEL = 0.011 * k;
  RT = 0.088 * k;
  RC = RT + 0.009 * k;
  DIAL_GAP = 0.008 * k;
  SMOOTH = 0.022 * k;
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
export const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const clampAsin = (x) => Math.asin(Math.max(-1, Math.min(1, x)));

// Any unit vector perpendicular to n.
export function perpendicular(n) {
  const a = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, a));
}

function smin(a, b) {
  const h = Math.max(SMOOTH - Math.abs(a - b), 0) / SMOOTH;
  return Math.min(a, b) - h * h * SMOOTH * 0.25;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const DEG = Math.PI / 180;
// A circle is a normal (a great circle) or { n, h }: the small circle where dot(p, n) = h.
const ring = (n, radius) => ({ n, h: Math.cos(radius * DEG) });
const rings = (axes, radius) => axes.map((n) => ring(n, radius));
const meridians = (count) => Array.from({ length: count }, (_, k) => [Math.cos((k * Math.PI) / count), 0, Math.sin((k * Math.PI) / count)]);
const parallels = (...latitudes) => latitudes.map((l) => ({ n: [0, 1, 0], h: Math.sin(l * DEG) }));
const COORDINATES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const DIAGONALS = [[1, 1, 0], [1, -1, 0], [0, 1, 1], [0, 1, -1], [1, 0, 1], [1, 0, -1]];
const OCTA = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const TETRA = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
const CUBE = [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]];
const CUBO = [[1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]];
const EDGES = [[1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0], [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]];
const DODECA = [...CUBE, [0, 1 / PHI, PHI], [0, -1 / PHI, PHI], [0, 1 / PHI, -PHI], [0, -1 / PHI, -PHI], [1 / PHI, PHI, 0], [-1 / PHI, PHI, 0], [1 / PHI, -PHI, 0], [-1 / PHI, -PHI, 0], [PHI, 0, 1 / PHI], [-PHI, 0, 1 / PHI], [PHI, 0, -1 / PHI], [-PHI, 0, -1 / PHI]];
const ICOSA = [[0, 1, PHI], [0, -1, PHI], [0, 1, -PHI], [0, -1, -PHI], [1, PHI, 0], [-1, PHI, 0], [1, -PHI, 0], [-1, -PHI, 0], [PHI, 0, 1], [-PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, -1]];
export const PRESETS = {
  octahedral: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  cuboctahedral: [[1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]],
  icosidodecahedral: [[0, 1, PHI], [0, -1, PHI], [1, PHI, 0], [-1, PHI, 0], [PHI, 0, 1], [PHI, 0, -1]],
  armillary: [...parallels(0, 36, -36), ...meridians(3)],
  globe: [...parallels(0, 42, -42), ...meridians(4)],
  "tetrahedral rings": rings(TETRA, 80),
  "octahedral rings": rings(OCTA, 66),
  "cubic rings": rings(CUBE, 44.5),
  "icosahedral rings": rings(ICOSA, 47),
  "rhombic dodecahedral": DIAGONALS,
  "octahedral mirrors": [...COORDINATES, ...DIAGONALS],
  "seven circles": [...COORDINATES, [1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]],
  "ringed octahedron": [...COORDINATES, ...rings(OCTA, 30)],
  astrolabe: [...parallels(0, 30, -30, 58, -58), ...meridians(3)],
  // Dense arrangements, with the mechanism scaled down to fit.
  "dodecahedral rings": { circles: rings(DODECA, 28), scale: 0.75 },
  "cubic rings and diagonals": { circles: [...rings(CUBE, 26), ...DIAGONALS], scale: 0.75 },
  "edge rings and seams": { circles: [...rings(EDGES, 22), ...CUBO], scale: 0.75 },
  "cubic rings and mirrors": { circles: [...rings(CUBE, 78), ...COORDINATES], scale: 0.75 },
  "octahedral and cubic rings": { circles: [...rings(OCTA, 28), ...rings(CUBE, 48)], scale: 0.72 },
  "edge rings": { circles: rings(EDGES, 54), scale: 0.65 },
  "cuboctahedral web": { circles: [...rings(CUBE, 76), ...CUBO], scale: 0.65 },
  "great octahedral and cubic rings": { circles: [...rings(OCTA, 64), ...rings(CUBE, 48)], scale: 0.62 },
  "great icosahedral rings": { circles: rings(ICOSA, 74), scale: 0.55 },
  "icosahedral rings and seams": { circles: [...rings(ICOSA, 42), ...CUBO], scale: 0.55 },
  "cubic and icosahedral web": { circles: [...rings(CUBE, 24), ...rings(ICOSA, 44)], scale: 0.55 },
};
const toCircle = (c) => (Array.isArray(c) ? { n: normalize(c), h: 0 } : { n: normalize(c.n), h: c.h });

// Random circle normals, spread apart and rejected until every node, crossing and face is roomy enough.
export function randomNormals(count, random) {
  for (let attempt = 0; attempt < 400; attempt++) {
    // Six free circles rarely fit, so most of the time they start from a jittered symmetric set.
    if (attempt >= 40 || (count >= 6 && attempt >= 8)) {
      const base = count >= 5 ? PRESETS.icosidodecahedral.slice(0, count) : PRESETS.cuboctahedral.slice(0, count);
      const amount = attempt < 200 ? 0.22 : 0.1;
      const normals = rotateNormals(base, random).map(({ n }) => {
        const t = perpendicular(n), b = cross(n, t), a = random() * Math.PI * 2, r = amount * Math.sqrt(random());
        return normalize(add(n, add(scale(t, r * Math.cos(a)), scale(b, r * Math.sin(a)))));
      });
      if (buildLayout(normals)) return normals;
      continue;
    }
    const normals = [];
    for (let i = 0; i < count; i++) {
      let best = null;
      let bestScore = -Infinity;
      for (let c = 0; c < 12; c++) {
        const z = random() * 2 - 1;
        const a = random() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        const n = [s * Math.cos(a), s * Math.sin(a), z];
        let score = Infinity;
        for (const m of normals) score = Math.min(score, angle(n, m), Math.PI - angle(n, m));
        if (score > bestScore) (bestScore = score), (best = n);
      }
      normals.push(best);
    }
    const layout = buildLayout(normals);
    if (layout) return normals;
  }
  return null;
}

// Rotates a set of circles at random, so presets don't always face the camera the same way.
export function rotateNormals(circles, random) {
  const axis = normalize([random() - 0.5, random() - 0.5, random() - 0.5]);
  const a = random() * Math.PI * 2;
  const c = Math.cos(a), s = Math.sin(a);
  return circles.map((circle) => {
    const { n, h } = toCircle(circle);
    const k = dot(axis, n);
    const x = cross(axis, n);
    return { n: normalize(add(add(scale(n, c), scale(x, s)), scale(axis, k * (1 - c)))), h };
  });
}

// Where two circles cross: none, or two points.
function crossings(A, B) {
  const c = dot(A.n, B.n);
  const d = cross(A.n, B.n);
  const dd = dot(d, d);
  if (dd < 1e-9) return [];
  const a = (A.h - B.h * c) / (1 - c * c), b = (B.h - A.h * c) / (1 - c * c);
  const p0 = add(scale(A.n, a), scale(B.n, b));
  const r = 1 - dot(p0, p0);
  if (r <= 1e-6) return [];
  const t = Math.sqrt(r / dd);
  return [normalize(add(p0, scale(d, t))), normalize(add(p0, scale(d, -t)))];
}

// The point at angle phi on a circle.
export function circlePoint(C, phi) {
  const c = Math.cos(phi) * C.rho, s = Math.sin(phi) * C.rho;
  return [C.n[0] * C.h + C.u[0] * c + C.v[0] * s, C.n[1] * C.h + C.u[1] * c + C.v[1] * s, C.n[2] * C.h + C.u[2] * c + C.v[2] * s];
}

// Returns null when the arrangement is too cramped for the mechanism.
export function buildLayout(rawCircles, { strict = true } = {}) {
  const circles = rawCircles.map((raw) => {
    const { n, h } = toCircle(raw);
    const u = perpendicular(n);
    return { n, h, rho: Math.sqrt(1 - h * h), u, v: cross(n, u), nodes: [] };
  });
  // Crossings; where three or more circles meet at one point they share a node.
  const nodes = [];
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      for (const p of crossings(circles[i], circles[j])) {
        const same = nodes.find((node) => angle(node.p, p) < 1e-4);
        if (same) for (const c of [i, j]) !same.circles.includes(c) && same.circles.push(c);
        else nodes.push({ p, circles: [i, j] });
      }
    }
  }
  if (!nodes.length || circles.some((_, c) => !nodes.some((node) => node.circles.includes(c)))) return null;
  // Too-close nodes or shallow crossings leave no room for turntables and slots.
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) if (strict && angle(nodes[a].p, nodes[b].p) < 0.3 * SCALE) return null;
  }
  for (const node of nodes) {
    const tangents = node.circles.map((c) => normalize(cross(circles[c].n, node.p)));
    for (let a = 0; a < tangents.length; a++)
      for (let b = a + 1; b < tangents.length; b++) if (strict && Math.abs(dot(tangents[a], tangents[b])) > Math.cos(0.62)) return null;
  }

  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const y = node.p;
    const x = normalize(cross(circles[node.circles[0]].n, y));
    const z = cross(x, y);
    node.frame = { x, y, z };
    node.alpha = node.circles.map((c) => {
      const t = normalize(cross(circles[c].n, y));
      return Math.atan2(-dot(t, z), dot(t, x));
    });
    for (const c of node.circles) {
      const C = circles[c];
      C.nodes.push({ node: k, phi: Math.atan2(dot(y, C.v), dot(y, C.u)) });
    }
  }
  for (const C of circles) C.nodes.sort((a, b) => a.phi - b.phi);
  // A circle needs at least three stops to carry tokens round it.
  if (circles.some((C) => C.nodes.length < 3)) return null;

  // Neighbours along each circle: next in increasing phi (+1) and previous (-1).
  for (let c = 0; c < circles.length; c++) {
    const list = circles[c].nodes;
    list.forEach((entry, i) => {
      const node = nodes[entry.node];
      node.next ??= {};
      node.next[c] = { 1: list[(i + 1) % list.length].node, [-1]: list[(i - 1 + list.length) % list.length].node };
    });
  }

  const edges = [];
  const edgeKey = new Map();
  circles.forEach((C, c) => {
    C.nodes.forEach((entry, i) => {
      const a = entry.node, b = C.nodes[(i + 1) % C.nodes.length].node;
      let phiA = entry.phi, phiB = C.nodes[(i + 1) % C.nodes.length].phi;
      if (phiB <= phiA) phiB += Math.PI * 2;
      edgeKey.set(`${a}|${b}|${c}`, edges.length);
      edgeKey.set(`${b}|${a}|${c}`, edges.length);
      edges.push({ a, b, circle: c, phiA, phiB, faces: [] });
    });
  });

  // Outgoing half-edges at each node, counterclockwise seen from outside.
  for (const node of nodes) {
    const out = [];
    for (const c of node.circles) {
      for (const dir of [1, -1]) {
        const t = scale(normalize(cross(circles[c].n, node.p)), dir);
        out.push({ to: node.next[c][dir], circle: c, theta: Math.atan2(-dot(t, node.frame.z), dot(t, node.frame.x)) });
      }
    }
    out.sort((a, b) => a.theta - b.theta);
    node.out = out;
  }

  const faces = [];
  const used = new Set();
  nodes.forEach((node, start) => {
    for (const h of node.out) {
      const key0 = `${start}>${h.to}>${h.circle}`;
      if (used.has(key0)) continue;
      const verts = [];
      const sides = [];
      let u = start, e = h;
      for (let guard = 0; guard < 64; guard++) {
        const key = `${u}>${e.to}>${e.circle}`;
        if (used.has(key)) break;
        used.add(key);
        verts.push(u);
        sides.push(e.circle);
        const v = e.to;
        const out = nodes[v].out;
        const back = out.findIndex((o) => o.to === u && o.circle === e.circle);
        const next = out[(back + out.length - 1) % out.length];
        u = v;
        e = next;
      }
      faces.push({ verts, sides });
    }
  });
  if (faces.length !== edges.length - nodes.length + 2) return null;

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    face.center = normalize(face.verts.reduce((s, v) => add(s, nodes[v].p), [0, 0, 0]));
    face.walls = face.sides.map((c) => {
      const C = circles[c];
      return { circle: c, n: C.n, h: C.h, s: Math.sign(dot(face.center, C.n) - C.h) || 1 };
    });
    face.points = face.verts.map((v) => nodes[v].p);
    face.verts.forEach((a, i) => {
      const b = face.verts[(i + 1) % face.verts.length];
      edges[edgeKey.get(`${a}|${b}|${face.sides[i]}`)].faces.push(f);
    });
    face.reach = Math.max(...face.points.map((p) => angle(p, face.center))) + 0.15;
    face.inradius = plateField(face, null)(face.center);
    let rd = Math.min(face.inradius - 0.085 * SCALE, 0.15);
    // Shrink the dial until the plate round it is wide enough everywhere for both its bevels.
    while (rd >= 0.05 * SCALE && !roomRoundDial(face, rd)) rd -= 0.006 * SCALE;
    face.dial = rd >= 0.05 * SCALE ? rd : 0;
    if (strict && face.inradius < 0.085 * SCALE) return null;
  }

  return { circles, nodes, edges, faces, edgeKey };
}

// Whether a plate with a dial of radius rd keeps at least two bevels and a little top in every direction.
function roomRoundDial(face, rd) {
  const field = plateField(face, rd);
  const c = face.center, e1 = perpendicular(c), e2 = cross(c, e1);
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const d = add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a)));
    let peak = -Infinity;
    for (let i = 0; i <= 32; i++) {
      const t = rd + (face.reach - rd) * (i / 32);
      peak = Math.max(peak, field(geodesic(c, d, t)));
    }
    if (peak < BEVEL * 2.4) return false;
  }
  return true;
}

// Signed distance (radians, smoothed) to a plate's boundary: channel walls, turntable cuts, dial hole.
export function plateField(face, dial = face.dial) {
  const walls = face.walls.map((w) => ({ n: w.n, s: w.s, base: clampAsin(w.h) }));
  const points = face.points;
  const c = face.center;
  const half = W / 2;
  return (p) => {
    let g = Infinity;
    for (const w of walls) g = smin(g, w.s * (clampAsin(dot(p, w.n)) - w.base) - half);
    for (const q of points) g = smin(g, angle(p, q) - RC);
    if (dial) g = smin(g, angle(p, c) - dial - DIAL_GAP);
    return g;
  };
}

// The two halves of a turntable, either side of its slot, at the north pole (+y), slot along x.
export function turntableFields() {
  const pole = [0, 1, 0];
  const half = W / 2;
  return [1, -1].map((s) => {
    const field = (p) => smin(RT - angle(p, pole), s * clampAsin(p[2]) - half);
    const a = (RT + half) / 2;
    return { seed: [0, Math.cos(a), s * Math.sin(a)], field, reach: RT + 0.03 };
  });
}

export function dialField(center, radius) {
  return (p) => radius - angle(p, center);
}

// Point at angle t from c towards tangent direction d.
function geodesic(c, d, t) {
  const ct = Math.cos(t), st = Math.sin(t);
  return [c[0] * ct + d[0] * st, c[1] * ct + d[1] * st, c[2] * ct + d[2] * st];
}

function bisect(f, lo, hi, iterations = 18) {
  // f(lo) >= 0 > f(hi) or the reverse; returns the crossing.
  const flo = f(lo);
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) * 0.5;
    if (f(mid) >= 0 === flo >= 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

// A raised piece from a field: flat-topped at radius `top`, a rounded bevel, then radial walls down to
// `bottom`. Rows run outer wall → bevel → top → inner bevel → inner wall (if the piece has a hole).
// Returns flat arrays: position, normal, edge distance per vertex, and the index buffer.
// Yields every few dozen rays, so a caller can spread the work over frames.
export function* buildPieceSteps({ seed, field, reach, top = R, bottom = RF - 0.02, bevel = BEVEL, samples = 192, bevelRows = 4, topRings = 6, coarse = 20 }) {
  const c = seed;
  const e1 = perpendicular(c);
  const e2 = cross(c, e1);
  const dirOf = (a) => add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a)));

  const hole = field(c) < 0;
  // For one direction: the field along the ray, its peak, and the zero crossings either side.
  function profile(a) {
    const d = dirOf(a);
    const f = (t) => field(geodesic(c, d, t));
    let peak = 0, peakG = -Infinity;
    const gs = [];
    for (let i = 0; i <= coarse; i++) {
      const t = (reach * i) / coarse;
      const g = f(t);
      gs.push(g);
      if (g > peakG) (peakG = g), (peak = i);
    }
    let outer = reach;
    for (let i = peak + 1; i <= coarse; i++) {
      if (gs[i] < 0) {
        outer = bisect(f, (reach * (i - 1)) / coarse, (reach * i) / coarse, 14);
        break;
      }
    }
    let inner = 0;
    if (hole) {
      for (let i = peak - 1; i >= 0; i--) {
        if (gs[i] < 0) {
          inner = bisect(f, (reach * (i + 1)) / coarse, (reach * i) / coarse, 14);
          break;
        }
      }
    }
    return { d, f, peakT: (reach * peak) / coarse, peakG, outer, inner };
  }
  // Where the field reaches `level` between the peak and a boundary: two secant steps in from the boundary.
  function levelT(pr, level, side) {
    if (pr.peakG <= level) return pr.peakT;
    const edge = side > 0 ? pr.outer : pr.inner;
    const lo = Math.min(edge, pr.peakT), hi = Math.max(edge, pr.peakT);
    let t0 = edge, h0 = -level;
    let t1 = Math.max(lo, Math.min(hi, edge - side * level)), h1 = pr.f(t1) - level;
    for (let i = 0; i < 3 && Math.abs(h1) > 1e-6; i++) {
      const den = h1 - h0;
      if (Math.abs(den) < 1e-12) break;
      const t2 = Math.max(lo, Math.min(hi, t1 - (h1 * (t1 - t0)) / den));
      (t0 = t1), (h0 = h1);
      t1 = t2;
      h1 = pr.f(t1) - level;
    }
    return t1;
  }

  // Directions spaced by arc length plus turning, so rounded corners get their share of samples.
  const fine = 384;
  const finePts = [];
  for (let i = 0; i < fine; i++) {
    const a = (i / fine) * Math.PI * 2;
    const pr = profile(a);
    finePts.push(geodesic(c, pr.d, pr.outer));
    if (i % 48 === 47) yield;
  }
  const weights = [0];
  let prevDir = null;
  for (let i = 0; i < fine; i++) {
    const p = finePts[i], q = finePts[(i + 1) % fine];
    const seg = Math.hypot(...sub(q, p));
    const dir = normalize(sub(q, p));
    const turn = prevDir ? angle(dir, prevDir) : 0;
    prevDir = dir;
    weights.push(weights[i] + seg + turn * 0.012);
  }
  const total = weights[fine];
  const alphas = [];
  for (let s = 0, j = 0; s < samples; s++) {
    const target = (s / samples) * total;
    while (j < fine - 1 && weights[j + 1] < target) j++;
    const k = (target - weights[j]) / Math.max(weights[j + 1] - weights[j], 1e-9);
    alphas.push(((j + k) / fine) * Math.PI * 2);
  }

  const rows = []; // each: array of {p (unit dir), r, n}
  const grad = (p) => {
    const a = perpendicular(p), b = cross(p, a), h = 1e-4;
    const ga = (field(normalize(add(p, scale(a, h)))) - field(normalize(add(p, scale(a, -h))))) / (2 * h);
    const gb = (field(normalize(add(p, scale(b, h)))) - field(normalize(add(p, scale(b, -h))))) / (2 * h);
    return add(scale(a, ga), scale(b, gb));
  };
  const profiles = [];
  for (let s = 0; s < alphas.length; s++) {
    profiles.push(profile(alphas[s]));
    if (s % 48 === 47) yield;
  }

  function bevelSide(side) {
    const out = [];
    const ts0 = profiles.map((pr) => (side > 0 ? pr.outer : pr.inner));
    const outwards = ts0.map((t, s) => normalize(scale(grad(geodesic(c, profiles[s].d, t)), -1)));
    // wall bottom then bevel rows from the wall up to the top
    for (let j = -1; j <= bevelRows; j++) {
      const theta = j < 0 ? 0 : (j / bevelRows) * Math.PI * 0.5;
      const level = j < 0 ? 0 : bevel * (1 - Math.cos(theta));
      const r = j < 0 ? bottom : top - bevel + bevel * Math.sin(theta);
      out.push(
        profiles.map((pr, s) => {
          const t = j < 0 ? ts0[s] : levelT(pr, level, side);
          const p = geodesic(c, pr.d, t);
          const o = outwards[s];
          const outward = normalize(sub(o, scale(p, dot(o, p))));
          const n = normalize(add(scale(outward, Math.cos(theta)), scale(p, Math.sin(theta))));
          return { p, r, n, e: j < 0 ? 0 : level, t };
        }),
      );
    }
    return out;
  }
  const outer = bevelSide(1);
  rows.push(...outer);
  const outerTop = outer[outer.length - 1];
  let innerRows = null;
  let innerTop;
  if (hole) {
    innerRows = bevelSide(-1);
    innerTop = innerRows[innerRows.length - 1];
  }
  for (let k = 1; k <= topRings; k++) {
    const f = k / (topRings + (hole ? 1 : 0));
    // Denser near the rim, where the bevel highlight and engraving are.
    const ff = hole ? f : 1 - Math.pow(1 - f, 1.6);
    rows.push(
      profiles.map((pr, s) => {
        const t0 = outerTop[s].t;
        const t1 = hole ? innerTop[s].t : 0;
        const t = t0 + (t1 - t0) * ff;
        const p = geodesic(c, pr.d, t);
        return { p, r: top, n: p, e: field(p), t };
      }),
    );
  }
  if (hole) for (let j = innerRows.length - 1; j >= 0; j--) rows.push(innerRows[j]);
  const topRows = rows.length;
  // The underside at the walls' foot, facing in, so the piece is closed and its rods have something to meet.
  const footOuter = outer[0], footInner = hole ? innerRows[0] : null;
  for (let k = 0; k <= 3; k++) {
    const f = k / 3;
    rows.push(
      profiles.map((pr, s) => {
        const t0 = footOuter[s].t, t1 = footInner ? footInner[s].t : 0;
        const p = geodesic(c, pr.d, t0 + (t1 - t0) * f);
        return { p, r: bottom, n: scale(p, -1), e: 0, t: 0 };
      }),
    );
  }

  const S = samples;
  const position = new Float32Array(rows.length * S * 3);
  const normal = new Float32Array(rows.length * S * 3);
  const edge = new Float32Array(rows.length * S);
  rows.forEach((row, i) =>
    row.forEach((v, s) => {
      const o = (i * S + s) * 3;
      position[o] = v.p[0] * v.r;
      position[o + 1] = v.p[1] * v.r;
      position[o + 2] = v.p[2] * v.r;
      normal[o] = v.n[0];
      normal[o + 1] = v.n[1];
      normal[o + 2] = v.n[2];
      edge[i * S + s] = v.e;
    }),
  );
  const index = [];
  // Winding from the first top strip: the face normal must point outwards.
  const flip = (() => {
    const i = outer.length;
    const a = rows[i][0], b = rows[i][1], d = rows[i - 1][0];
    const pa = scale(a.p, a.r), pb = scale(b.p, b.r), pd = scale(d.p, d.r);
    return dot(cross(sub(pb, pa), sub(pd, pa)), a.p) > 0;
  })();
  for (let i = 0; i < rows.length - 1; i++) {
    // No strip joins the last top row to the first underside row; the underside faces the other way.
    if (i === topRows - 1) continue;
    const under = i >= topRows;
    for (let s = 0; s < S; s++) {
      const a = i * S + s, b = i * S + ((s + 1) % S), cc = (i + 1) * S + ((s + 1) % S), d = (i + 1) * S + s;
      if (flip !== under) index.push(a, d, b, b, d, cc);
      else index.push(a, b, d, b, cc, d);
    }
  }
  return { position, normal, edge, index, vertexCount: rows.length * S };
}

export function buildPiece(options) {
  const steps = buildPieceSteps(options);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

// A spherical cap of angular radius `radius` around +y at radius r, with a short skirt below it.
export function buildCap({ radius, r, skirt, rings = 6, samples = 96 }) {
  const rows = [];
  for (let k = 0; k <= rings; k++) rows.push({ t: (radius * k) / rings, r, wall: false });
  rows.push({ t: radius, r: skirt, wall: true });
  const position = [], normal = [], index = [];
  for (const row of rows) {
    for (let s = 0; s < samples; s++) {
      const a = (s / samples) * Math.PI * 2;
      const d = [Math.cos(a), 0, Math.sin(a)];
      const p = [d[0] * Math.sin(row.t), Math.cos(row.t), d[2] * Math.sin(row.t)];
      position.push(...scale(p, row.r));
      normal.push(...(row.wall ? normalize([d[0] * Math.cos(row.t), -Math.sin(row.t), d[2] * Math.cos(row.t)]) : p));
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let s = 0; s < samples; s++) {
      const a = i * samples + s, b = i * samples + ((s + 1) % samples), c = (i + 1) * samples + ((s + 1) % samples), d = (i + 1) * samples + s;
      // The skirt strip runs downwards, so it winds the other way.
      if (i === rows.length - 2) index.push(a, d, b, b, d, c);
      else index.push(a, b, d, b, c, d);
    }
  }
  return { position: new Float32Array(position), normal: new Float32Array(normal), index, vertexCount: position.length / 3 };
}

// A spur gear around +y between heights y0 and y1, flat shaded and closed; teeth = 0 gives a plain cylinder,
// caps = false an open tube. Tooth k is centred on angle (k + 0.5) * 2pi / teeth.
export function buildGear({ radius, teeth = 0, depth = 0.008, y0, y1, hole = 0, segments = 64, caps = true }) {
  const ring = [];
  if (teeth) {
    const step = (Math.PI * 2) / teeth;
    const root = radius - depth;
    for (let k = 0; k < teeth; k++) {
      const a = k * step;
      for (const [f, r] of [[0, root], [0.22, root], [0.36, radius], [0.64, radius], [0.78, root]]) ring.push([r, a + f * step]);
    }
  } else {
    for (let k = 0; k < segments; k++) ring.push([radius, (k / segments) * Math.PI * 2]);
  }
  const position = [], normal = [], index = [];
  const vert = (p, n) => (position.push(...p), normal.push(...n), position.length / 3 - 1);
  const at = ([r, a], y) => [r * Math.cos(a), y, r * Math.sin(a)];
  const smooth = !teeth;
  for (let i = 0; i < ring.length; i++) {
    const A = ring[i], B = ring[(i + 1) % ring.length];
    const pa = at(A, y1), pb = at(B, y1);
    const side = smooth ? null : normalize(cross(sub(at(B, y0), pa), sub(pb, pa)));
    const na = smooth ? [Math.cos(A[1]), 0, Math.sin(A[1])] : scale(side, -1);
    const nb = smooth ? [Math.cos(B[1]), 0, Math.sin(B[1])] : na;
    const a0 = vert(at(A, y0), na), b0 = vert(at(B, y0), nb), a1 = vert(pa, na), b1 = vert(pb, nb);
    index.push(a0, a1, b0, b0, a1, b1);
    // Top and bottom faces: fans, or rings around the hole, which also gets its own inner wall.
    for (const [y, up] of caps ? [[y1, 1], [y0, -1]] : []) {
      const n = [0, up, 0];
      const ta = vert(at(A, y), n), tb = vert(at(B, y), n);
      if (hole) {
        const ha = vert([hole * Math.cos(A[1]), y, hole * Math.sin(A[1])], n), hb = vert([hole * Math.cos(B[1]), y, hole * Math.sin(B[1])], n);
        if (up > 0) index.push(ha, tb, ta, ha, hb, tb);
        else index.push(ha, ta, tb, ha, tb, hb);
      } else {
        const o = vert([0, y, 0], n);
        if (up > 0) index.push(o, tb, ta);
        else index.push(o, ta, tb);
      }
    }
    if (hole) {
      const inA = [-Math.cos(A[1]), 0, -Math.sin(A[1])], inB = [-Math.cos(B[1]), 0, -Math.sin(B[1])];
      const h = (a, y, n) => vert([hole * Math.cos(a), y, hole * Math.sin(a)], n);
      const i0 = h(A[1], y0, inA), j0 = h(B[1], y0, inB), i1 = h(A[1], y1, inA), j1 = h(B[1], y1, inB);
      index.push(i0, j0, i1, j0, j1, i1);
    }
  }
  return { position: new Float32Array(position), normal: new Float32Array(normal), index, vertexCount: position.length / 3 };
}
