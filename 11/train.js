// Seeded floating gear trains driven by an anchor escapement. One degree of freedom: q, the escape wheel's angle.
import { Matrix4, Vector3 } from "three";
import * as G from "./gears.js";
import * as E from "./escapement.js";
import * as C from "./chain.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const FLIP = new Matrix4().makeRotationX(Math.PI);
const GEAR_KINDS = new Set(["spur", "ring", "bevel", "worm", "wormWheel", "rack", "helical", "herringbone", "sprocket"]);
const BUILDERS = { spurGear: G.spurGear, helicalGear: G.helicalGear, ringGear: G.ringGear, bevelGear: G.bevelGear, worm: G.worm, wormWheel: G.wormWheel, rack: G.rack, sprocket: C.sprocket };
const LIBS = { "gears.js": G, "escapement.js": E, "chain.js": C };

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

const rotZ = (a) => new Matrix4().makeRotationZ(a);
const tz = (z) => new Matrix4().makeTranslation(0, 0, z);
const mul = (...ms) => ms.reduce((a, b) => a.multiply(b), new Matrix4());
const col = (M, i) => { const e = M.elements; return [e[4 * i], e[4 * i + 1], e[4 * i + 2]]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- convex colliders and GJK clearance

// Hull of coaxial discs [[z, r], ...] about the z axis of `frame`, an oriented box with half sizes `h` in `frame`,
// or the convex hull of several such shapes.
const hullShape = (frame, discs) => ({ type: "hull", c: col(frame, 3), ax: col(frame, 2), discs });
const boxShape = (frame, centre, h) => {
  const M = frame.clone().multiply(new Matrix4().makeTranslation(...centre));
  return { type: "box", c: col(M, 3), axes: [col(M, 0), col(M, 1), col(M, 2)], h };
};
const hullsShape = (parts) => ({ type: "hulls", parts, c: [0, 1, 2].map((j) => parts.reduce((a, s) => a + s.c[j], 0) / parts.length) });

function support(s, d) {
  if (s.type === "hulls") {
    let best = -Infinity, bp = null;
    for (const p of s.parts) { const v = support(p, d), k = dot(v, d); if (k > best) { best = k; bp = v; } }
    return bp;
  }
  if (s.type === "box") {
    const p = [...s.c];
    for (let i = 0; i < 3; i++) { const e = s.axes[i], k = dot(d, e) >= 0 ? s.h[i] : -s.h[i]; p[0] += k * e[0]; p[1] += k * e[1]; p[2] += k * e[2]; }
    return p;
  }
  const a = s.ax, dz = dot(d, a);
  let px = d[0] - dz * a[0], py = d[1] - dz * a[1], pz = d[2] - dz * a[2];
  const L = Math.hypot(px, py, pz);
  if (L > 1e-12) { px /= L; py /= L; pz /= L; }
  let best = -Infinity, bz = 0, br = 0;
  for (const [z, r] of s.discs) { const v = z * dz + r * L; if (v > best) { best = v; bz = z; br = r; } }
  return [s.c[0] + bz * a[0] + br * px, s.c[1] + bz * a[1] + br * py, s.c[2] + bz * a[2] + br * pz];
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];

// Closest point to the origin on triangle abc (Ericson), with the sub-simplex that supports it.
function closestTri(a, b, c) {
  const ab = sub3(b, a), ac = sub3(c, a), ap = [-a[0], -a[1], -a[2]];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { v: a, S: [a] };
  const bp = [-b[0], -b[1], -b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { v: b, S: [b] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return { v: lerp3(a, b, d1 / (d1 - d3)), S: [a, b] };
  const cp = [-c[0], -c[1], -c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { v: c, S: [c] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return { v: lerp3(a, c, d2 / (d2 - d6)), S: [a, c] };
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return { v: lerp3(b, c, (d4 - d3) / (d4 - d3 + (d5 - d6))), S: [b, c] };
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return { v: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w], S: [a, b, c] };
}

function closestSimplex(S) {
  if (S.length === 1) return { v: S[0], S };
  if (S.length === 2) {
    const [a, b] = S, ab = sub3(b, a), t = -dot(a, ab) / (dot(ab, ab) || 1);
    return t <= 0 ? { v: a, S: [a] } : t >= 1 ? { v: b, S: [b] } : { v: lerp3(a, b, t), S };
  }
  if (S.length === 3) return closestTri(...S);
  const [a, b, c, d] = S;
  let best = null;
  for (const [p, q, r, o] of [[a, b, c, d], [a, b, d, c], [a, c, d, b], [b, c, d, a]]) {
    const n = cross(sub3(q, p), sub3(r, p)), sO = -dot(n, p), sD = dot(n, sub3(o, p));
    if (sO * sD < 0 || Math.abs(sD) < 1e-30) {
      const res = closestTri(p, q, r);
      if (!best || dot(res.v, res.v) < dot(best.v, best.v)) best = res;
    }
  }
  return best ?? { v: [0, 0, 0], S, inside: true };
}

/** True when convex shapes A and B are at least `clear` apart. */
export function clearOf(A, B, clear) {
  const diff = (d) => sub3(support(A, d), support(B, [-d[0], -d[1], -d[2]]));
  let v = diff(sub3(B.c, A.c)), S = [v];
  for (let it = 0; it < 80; it++) {
    const vv = dot(v, v);
    if (vv < clear * clear) return false;
    const w = diff([-v[0], -v[1], -v[2]]), vw = dot(v, w);
    if (vw > 0 && vw * vw >= clear * clear * vv) return true;
    if (vv - vw <= 1e-10 * vv) return true;
    S.push(w);
    const r = closestSimplex(S);
    if (r.inside) return false;
    S = r.S; v = r.v;
  }
  return false;
}

function shapePoints(s) {
  const pts = [];
  if (s.type === "hulls") { for (const p of s.parts) pts.push(...shapePoints(p)); return pts; }
  if (s.type === "box") {
    for (let i = 0; i < 8; i++) {
      const p = [...s.c];
      for (let k = 0; k < 3; k++) { const sg = (i >> k) & 1 ? 1 : -1; for (let j = 0; j < 3; j++) p[j] += sg * s.h[k] * s.axes[k][j]; }
      pts.push(p);
    }
    return pts;
  }
  const a = s.ax, u = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]), ul = Math.hypot(...u);
  const e1 = u.map((x) => x / ul), e2 = cross(a, e1), n = 16, grow = 1 / Math.cos(Math.PI / n);
  for (const [z, r] of s.discs) for (let i = 0; i < n; i++) {
    const t = (TAU * i) / n, c = Math.cos(t) * r * grow, sn = Math.sin(t) * r * grow;
    pts.push([0, 1, 2].map((j) => s.c[j] + z * a[j] + c * e1[j] + sn * e2[j]));
  }
  return pts;
}

// Centre and radius of a near-minimal sphere around points (Badoiu-Clarkson from the box centre).
function enclosingSphere(pts, iterations = 0) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); }
  let c = lo.map((x, j) => (x + hi[j]) / 2);
  const far = () => { let best = 0, bp = c; for (const p of pts) { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d > best) { best = d; bp = p; } } return [Math.sqrt(best), bp]; };
  let [R] = far(), bestC = c, bestR = R;
  for (let i = 1; i <= iterations; i++) {
    const [, p] = far();
    c = lerp3(c, p, 1 / (i + 1));
    const [r] = far();
    if (r < bestR) { bestR = r; bestC = c; }
  }
  return { centre: bestC, radius: bestR };
}

// Closed cylinder along local x, from -length/2 to length/2 (the differential's cross pin).
function pinMesh(radius, length, n = 20) {
  const P = [], N = [], I = [], h = length / 2;
  for (let i = 0; i <= n; i++) {
    const a = (TAU * i) / n, y = Math.cos(a), z = Math.sin(a);
    P.push(-h, radius * y, radius * z, h, radius * y, radius * z);
    N.push(0, y, z, 0, y, z);
  }
  for (let i = 0; i < n; i++) { const a = 2 * i, b = 2 * i + 2; I.push(a, b, a + 1, a + 1, b, b + 1); }
  for (const s of [-1, 1]) {
    const c = P.length / 3;
    P.push(s * h, 0, 0); N.push(s, 0, 0);
    for (let i = 0; i < n; i++) { const a = (TAU * i) / n; P.push(s * h, radius * Math.cos(a), radius * Math.sin(a)); N.push(s, 0, 0); }
    for (let i = 0; i < n; i++) { const a = c + 1 + i, b = c + 1 + ((i + 1) % n); if (s > 0) I.push(c, a, b); else I.push(c, b, a); }
  }
  return { position: new Float32Array(P), normal: new Float32Array(N), index: new Uint32Array(I) };
}

// ---------------------------------------------------------------- stage registry

/**
 * Stage types the train grows by. Each entry: weight (default; 0 = only when asked for), gears (most gears it adds),
 * canAttach(D, x) (can it grow from driver part D), build(D, x) -> { c (candidate: parts, shafts, colliders, meshes),
 * driver (the part the next stage grows from), extra? } or null. x is the generator context (seeded rng, module,
 * shaft and collider helpers). The order fixes the seeded sequence: append new types at the end.
 */
export const STAGE_TYPES = [
  {
    type: "spur", weight: 1.5, gears: 1,
    canAttach: (D) => D.kind === "spur" && !!D.shaft,
    build(D, x) {
      const c = x.candidate();
      const [, nb] = x.spurTeeth(x.wantUp(D.shaft));
      const B = x.meshNew(c, D, x.spurInfo(nb, D.info.args.width), x.rng() * TAU);
      return x.speedOk(B.shaft) ? { c, driver: B } : null;
    },
  },
  {
    type: "compound", weight: 1.5, gears: 2,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { m, rand, rng } = x;
      const c = x.candidate(), side = x.pick(x.openSides(D.shaft)), [na, nb] = x.spurTeeth(x.wantUp(D.shaft)), w = x.width();
      const A = x.onShaft(c, D.shaft, side, x.spurInfo(na, w), m * rand(0.8, 2.5));
      const B = x.meshNew(c, A, x.spurInfo(nb, w), rng() * TAU);
      return x.speedOk(B.shaft) ? { c, driver: B } : null;
    },
  },
  {
    type: "idler", weight: 1, gears: 2,
    canAttach: (D) => D.kind === "spur" && !!D.shaft,
    build(D, x) {
      const { rng, rand, int, nMax } = x;
      const c = x.candidate(), w = D.info.args.width, dir = rng() * TAU;
      const I = x.meshNew(c, D, x.spurInfo(int(9, Math.min(nMax, 20)), w), dir);
      const [, nb] = x.spurTeeth(x.wantUp(I.shaft));
      const B = x.meshNew(c, I, x.spurInfo(nb, w), dir + Math.PI + rand(0.6, TAU - 0.6));
      return x.speedOk(B.shaft) ? { c, driver: B } : null;
    },
  },
  {
    type: "bevel", weight: 2.5, gears: 2,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, nMax, AXLE_END } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const sigma = rng() < 0.7 ? Math.PI / 2 : pick([Math.PI / 3, (2 * Math.PI) / 3]);
      const up = x.wantUp(sh), nLo = 12, nHi = Math.max(16, Math.min(30, Math.floor(nMax * 0.85)));
      let na = int(nLo, nHi), nb = int(nLo, nHi);
      if (up !== na > nb) [na, nb] = [nb, na];
      const [dA, dB] = G.bevelPitchAngles(na, nb, sigma);
      const iA = x.built("bevelGear", { teeth: na, module: m, pitchAngle: dA, bore: ra });
      const iB = x.built("bevelGear", { teeth: nb, module: m, pitchAngle: dB, bore: ra });
      const flip = side < 0, gap = m * rand(0.8, 2);
      const zc = x.placeAt(sh, side, iA.zmin, iA.zmax, gap, flip, x.membersOf(c, sh));
      const [z0, z1] = x.span(zc, iA, flip);
      const fA = sh.frame.clone().multiply(tz(zc)).multiply(flip ? FLIP : new Matrix4());
      const thA = x.mapTheta(sh, flip ? -1 : 1, 0);
      const A = x.gearPart(c, "bevel", iA, sh, x.rotating(fA, thA.theta, thA.lin, thA.peak));
      x.addMember(c, sh, { part: A, z0, z1, axle: true, m0: side < 0 ? 0 : AXLE_END, m1: side > 0 ? 0 : AXLE_END });
      c.colliders.push(x.hullCollider(A, fA, iA.discs));
      c.open.push([sh, side]);
      const pr = G.meshBevel(iA.g, iB.g, sigma, rng() * TAU);
      const fB = fA.clone().multiply(pr.transform);
      const thB = x.mapTheta(thA, pr.ratio, pr.phase);
      const shB = x.newShaft(fB, thB.theta, thB.lin, [true, false], thB.peak);
      c.shafts.push(shB);
      const B = x.gearPart(c, "bevel", iB, shB, x.rotating(fB, thB.theta, thB.lin, thB.peak));
      shB.members = [{ part: B, z0: iB.zmin, z1: iB.zmax, axle: true, m0: AXLE_END, m1: 0 }];
      c.colliders.push(x.hullCollider(B, fB, iB.discs));
      x.meshPair(c, A, B);
      return x.speedOk(shB) ? { c, driver: B, extra: { sigma } } : null;
    },
  },
  {
    type: "worm", weight: 2, gears: 2,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, nMax, AXLE_END } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const starts = rng() < 0.7 ? 1 : 2, rootRadius = 2.5 * m;
      const iW = x.built("worm", { module: m, starts, length: Math.PI * m * rand(4, 5.5), rootRadius, bore: ra });
      const nh = int(Math.min(16, nMax), Math.max(16, Math.min(nMax, 30)));
      const iH = x.built("wormWheel", { teeth: nh, module: m, width: m * rand(3.5, 4.5), lead: iW.g.leadAngle, bore: ra, style: "auto", seed: int(1, 1e6) });
      const pr = G.meshWorm(iW.g, iH.g, rng() * TAU);
      // Slow trains get the wheel on the shaft (it drives a fast worm), fast ones the worm.
      const wheelDrives = x.ratioOf(sh) * starts < 1.5 ? rng() < 0.8 : rng() < 0.2;
      const gap = m * pick([1, 1.5, 3]) + (wheelDrives ? 0 : rng() * iH.rmax);
      const mems = x.membersOf(c, sh);
      if (wheelDrives) {
        const zc = x.placeAt(sh, side, iH.zmin, iH.zmax, gap, false, mems);
        const fH = sh.frame.clone().multiply(tz(zc));
        const H = x.gearPart(c, "wormWheel", iH, sh, x.rotating(fH, sh.theta, sh.lin, sh.peak));
        x.addMember(c, sh, { part: H, z0: zc + iH.zmin, z1: zc + iH.zmax, axle: true, m0: AXLE_END, m1: AXLE_END });
        c.colliders.push(x.hullCollider(H, fH, iH.discs));
        const fW = fH.clone().multiply(pr.transform.clone().invert());
        const thW = x.invTheta(sh, pr.ratio, pr.phase);
        const shW = x.newShaft(fW, thW.theta, thW.lin, undefined, thW.peak);
        c.shafts.push(shW);
        const W = x.gearPart(c, "worm", iW, shW, x.rotating(fW, thW.theta, thW.lin, thW.peak));
        shW.members = [{ part: W, z0: iW.zmin, z1: iW.zmax, axle: true, m0: AXLE_END, m1: AXLE_END }];
        c.colliders.push(x.hullCollider(W, fW, iW.discs));
        x.meshPair(c, W, H);
        return x.speedOk(shW) ? { c, driver: W } : null;
      }
      const zc = x.placeAt(sh, side, iW.zmin, iW.zmax, gap, false, mems);
      const fW = sh.frame.clone().multiply(tz(zc));
      const W = x.gearPart(c, "worm", iW, sh, x.rotating(fW, sh.theta, sh.lin, sh.peak));
      x.addMember(c, sh, { part: W, z0: zc + iW.zmin, z1: zc + iW.zmax, axle: true, m0: AXLE_END, m1: AXLE_END });
      c.colliders.push(x.hullCollider(W, fW, iW.discs));
      const fH = fW.clone().multiply(pr.transform);
      const thH = x.mapTheta(sh, pr.ratio, pr.phase);
      const shH = x.newShaft(fH, thH.theta, thH.lin, undefined, thH.peak);
      c.shafts.push(shH);
      const H = x.gearPart(c, "wormWheel", iH, shH, x.rotating(fH, thH.theta, thH.lin, thH.peak));
      shH.members = [{ part: H, z0: iH.zmin, z1: iH.zmax, axle: true, m0: AXLE_END, m1: AXLE_END }];
      c.colliders.push(x.hullCollider(H, fH, iH.discs));
      x.meshPair(c, W, H);
      return x.speedOk(shH) ? { c, driver: H } : null;
    },
  },
  {
    type: "ring", weight: 2, gears: 3,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, unit, AXLE_END } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const np = int(8, 12), nrMax = Math.floor(2 * ((0.34 * unit) / m - 3.75));
      if (nrMax < np + 8) return null;
      const nr = int(np + 8, Math.min(nrMax, np + 24)), wp = m * rand(3, 4), wr = wp + 2 * m;
      const iP = x.spurInfo(np, wp, { hub: { width: wp } });
      const iR = x.built("ringGear", { teeth: nr, module: m, width: wr, rim: 2.5 * m });
      const P = x.onShaft(c, sh, side, iP, m * rand(1.5, 3) + (wr - wp) / 2, 0.4 * m);
      c.open.push([sh, side]);
      const mr = G.meshRing(iR.g, iP.g, rng() * TAU);
      const fR = P.motion.frame.clone().multiply(mr.transform.clone().invert());
      const thR = x.invTheta(sh, mr.ratio, mr.phase);
      const shR = x.newShaft(fR, thR.theta, thR.lin, side > 0 ? [false, true] : [true, false], thR.peak);
      c.shafts.push(shR);
      const R = x.gearPart(c, "ring", iR, shR, x.rotating(fR, thR.theta, thR.lin, thR.peak));
      x.meshPair(c, P, R);
      const K = Math.max(16, Math.min(32, Math.round(nr / 2))), ri = iR.g.tipRadius * Math.cos(Math.PI / K), ro = iR.g.outerRadius;
      for (let i = 0; i < K; i++) {
        const a = (TAU * i) / K, fr = fR.clone().multiply(rotZ(a));
        c.colliders.push({ shape: boxShape(fr, [(ri + ro) / 2, 0, 0], [(ro - ri) / 2, ro * Math.tan(Math.PI / K), wr / 2]), tags: [`p:${R.id}`, `g:${shR.id}`], ignore: [] });
      }
      const nb = int(Math.max(12, nr - 6), nr + 2), wb = m * rand(3, 4);
      const iB = x.spurInfo(nb, wb, { hub: { width: wb } });
      const zb = side > 0 ? wr / 2 - iB.zmin : -wr / 2 - iB.zmax;
      const fB = fR.clone().multiply(tz(zb));
      const B = x.gearPart(c, "spur", iB, shR, x.rotating(fB, thR.theta, thR.lin, thR.peak), { role: "ringBacker" });
      shR.members = [
        { part: R, z0: -wr / 2, z1: wr / 2, axle: false, m0: 0, m1: 0 },
        { part: B, z0: zb + iB.zmin, z1: zb + iB.zmax, axle: true, m0: side > 0 ? 0 : AXLE_END, m1: side < 0 ? 0 : AXLE_END },
      ];
      c.colliders.push(x.hullCollider(B, fB, iB.discs));
      return x.speedOk(shR) ? { c, driver: B } : null;
    },
  },
  {
    type: "planetary", weight: 2, gears: 7,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0 && x.gearCount() + 6 <= x.hi,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, unit, AXLE_END } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const count = rng() < 0.7 ? 3 : 4;
      let ns, np, nr, P = null;
      const fit = (a, b) => !(((a + 2 * b) / 2 + 1.25 + 2.5) * m > 0.38 * unit);
      const valid = (a, b) => G.planetary({ sun: { teeth: a, module: m }, planet: { teeth: b, module: m }, ring: { teeth: a + 2 * b, module: m }, count }).valid;
      if (x.custom) {
        const ok = [];
        for (let a = 8; a <= 16; a++) for (let b = 8; b <= 14; b++) if (fit(a, b) && valid(a, b)) ok.push([a, b]);
        if (ok.length) { [ns, np] = pick(ok); nr = ns + 2 * np; P = true; }
      } else for (let t = 0; t < 30 && !P; t++) {
        ns = int(8, 16); np = int(8, 14); nr = ns + 2 * np;
        if (fit(ns, np) && valid(ns, np)) P = true;
      }
      if (!P) return null;
      const wp = m * rand(3, 4), pinR = 0.6 * m;
      const iS = x.built("spurGear", { teeth: ns, module: m, width: wp, bore: ra, hub: { width: wp }, style: "solid" });
      const iP = x.built("spurGear", { teeth: np, module: m, width: wp, bore: pinR, hub: { width: wp }, style: "auto", seed: int(1, 1e6) });
      const iR = x.built("ringGear", { teeth: nr, module: m, width: wp, rim: 2.5 * m });
      P = G.planetary({ sun: iS.g, planet: iP.g, ring: iR.g, count });
      const S = x.onShaft(c, sh, side, iS, m * rand(1, 2.5), 0.4 * m);
      c.colliders.pop();
      c.open.push([sh, side]);
      const fS = S.motion.frame;
      const ring = x.gearPart(c, "ring", iR, null, { local: () => fS.clone().multiply(rotZ(P.ringAngle)), lin: { ratio: 0, phase: P.ringAngle }, frame: fS.clone().multiply(rotZ(P.ringAngle)), fixed: true }, { group: x.nextId("r"), draggable: false });
      const gapC = 1.2 * m, tp = 2 * m, offC = side * (wp / 2 + gapC + tp / 2);
      const fC = fS.clone().multiply(tz(offC));
      const cr = P.carrierRatio;
      const thC = x.mapTheta(sh, cr, 0);
      const shC = x.newShaft(fC, thC.theta, thC.lin, side > 0 ? [false, true] : [true, false], thC.peak);
      c.shafts.push(shC);
      const carrier = x.addPart(c, {
        id: x.nextId("c"), kind: "carrier", shaft: shC, group: shC.id, meshesWith: [], draggable: true,
        build: { fn: "carrier", module: "train", args: { radius: P.carrierRadius, arms: count, angles: P.angles, thickness: tp, pinRadius: pinR, pinLength: gapC + wp + 0.5 * m, pinSide: -side, hubRadius: 2.2 * ra, armWidth: 2.4 * pinR + m } },
        motion: x.rotating(fC, thC.theta, thC.lin, thC.peak),
      });
      shC.members = [{ part: carrier, z0: -tp / 2, z1: tp / 2, axle: true, m0: side < 0 ? AXLE_END : 0, m1: side > 0 ? AXLE_END : 0 }];
      const sunTheta = sh.theta;
      for (let i = 0; i < count; i++) {
        const pl = x.gearPart(c, "spur", iP, null, {
          local: (q) => { const s = P.planet(i, sunTheta(q)); return fS.clone().multiply(new Matrix4().makeTranslation(...s.position)).multiply(rotZ(s.spin)); },
          lin: null, frame: fS,
        }, { group: x.nextId("pl"), role: "planet" });
        x.meshPair(c, S, pl); x.meshPair(c, pl, ring); x.meshPair(c, carrier, pl);
      }
      const asm = x.nextId("asm"), ro = iR.g.outerRadius;
      const zA = side > 0 ? -wp / 2 : offC - tp / 2, zB = side > 0 ? offC + tp / 2 : wp / 2;
      const asmIgnore = [`p:${S.id}`, `a:${sh.id}`, `a:${shC.id}`, `p:${carrier.id}`];
      c.colliders.push({ shape: hullShape(fS, [[zA, ro], [zB, ro]]), tags: [`p:${ring.id}`, `g:${asm}`], ignore: asmIgnore });
      // Carrier pin tips past the planets.
      const zT = -side * wp / 2, rT = P.carrierRadius + pinR;
      c.colliders.push({ shape: hullShape(fS, [[zT, rT], [zT - side * 0.5 * m, rT]]), tags: [`p:${carrier.id}`, `g:${asm}`], ignore: asmIgnore });
      // Output gear on the carrier shaft.
      const [, nout] = x.spurTeeth(x.wantUp(shC));
      const O = x.onShaft(c, shC, side, x.spurInfo(Math.max(nout, 12)), m * rand(1, 2));
      return x.speedOk(shC) ? { c, driver: O, extra: { count } } : null;
    },
  },
  {
    type: "yoke", weight: 1.8, gears: 2,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, AXLE_END } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const e = m * rand(3.5, 5.5), tc = 2 * m, pinR = 0.8 * m, gap = m * rand(1, 2.5);
      const zc = x.endOf(sh, side, x.membersOf(c, sh)) + side * (gap + tc / 2);
      const fK = sh.frame.clone().multiply(tz(zc));
      const crankR = e + 2.2 * m;
      const crank = x.addPart(c, {
        id: x.nextId("k"), kind: "crank", shaft: sh, group: sh.id, meshesWith: [], draggable: true,
        build: { fn: "crank", module: "train", args: { radius: crankR, thickness: tc, pinOffset: e, pinRadius: pinR, pinLength: 0, pinSide: side, hubRadius: 2.2 * ra } },
        motion: x.rotating(fK, sh.theta, sh.lin, sh.peak),
      });
      x.addMember(c, sh, { part: crank, z0: zc - tc / 2, z1: zc + tc / 2, axle: true, m0: side < 0 ? 0.3 * m : AXLE_END, m1: side > 0 ? 0.3 * m : AXLE_END });
      c.colliders.push(x.hullCollider(crank, fK, [[-tc / 2, crankR], [tc / 2, crankR]]));
      c.open.push([sh, side]);
      const gapY = 1.2 * m, ty = 3 * m, psi = rng() * TAU;
      crank.build.args.pinLength = gapY + ty + 0.5 * m;
      const fY = fK.clone().multiply(tz(side * (tc / 2 + gapY + ty / 2))).multiply(rotZ(psi));
      const Ls = e + pinR + 0.4 * m, sw = pinR + 0.15 * m, wall = 1.5 * m, hx = sw + wall, hy = Ls + wall;
      const theta = sh.theta, xs = (q) => e * Math.cos(theta(q) - psi);
      const yoke = x.addPart(c, {
        id: x.nextId("y"), kind: "yoke", shaft: null, group: x.nextId("yk"), meshesWith: [], draggable: true,
        build: { fn: "yoke", module: "train", args: { slotLength: 2 * Ls, slotWidth: 2 * sw, wall, thickness: ty } },
        motion: { local: (q) => fY.clone().multiply(new Matrix4().makeTranslation(xs(q), 0, 0)), lin: null, frame: fY },
      });
      x.meshPair(c, crank, yoke);
      c.colliders.push({ shape: boxShape(fY, [0, 0, 0], [hx + e, hy, ty / 2]), tags: [`p:${yoke.id}`, `g:${yoke.group}`], ignore: [] });
      // The crank pin's tip sweeps a disc past the yoke's far face.
      const zTip = side * (tc / 2 + gapY + ty);
      c.colliders.push(x.hullCollider(crank, fK, [[zTip, e + pinR], [zTip + side * 0.5 * m, e + pinR]], [`g:${yoke.group}`]));
      const p = Math.PI * m, h = Math.max(3, Math.ceil((e + 2.5 * m) / p - 0.5)), nT = 2 * h + 1, height = 2.5 * m, sigma = rng() < 0.5 ? 1 : -1;
      const iK = x.built("rack", { module: m, teeth: nT, width: ty, height });
      const fRB = fY.clone().multiply(new Matrix4().makeTranslation(0, sigma * (hy + height), 0)).multiply(sigma < 0 ? FLIP : new Matrix4());
      const rk = x.addPart(c, {
        id: x.nextId("k"), kind: "rack", shaft: null, group: yoke.group, meshesWith: [], draggable: true,
        build: { fn: "rack", args: { module: m, teeth: nT, width: ty, height }, module: "gears.js", result: iK.g }, info: iK,
        motion: { local: (q) => fRB.clone().multiply(new Matrix4().makeTranslation(xs(q), 0, 0)), lin: null, frame: fRB },
      });
      const k0 = -Math.floor((nT - 1) / 2), xl = (k0 - 0.5) * p - e, xh = (k0 + nT - 0.5) * p + e;
      c.colliders.push({ shape: boxShape(fRB, [(xl + xh) / 2, (m - height) / 2, 0], [(xh - xl) / 2, (m + height) / 2, ty / 2]), tags: [`p:${rk.id}`, `g:${yoke.group}`], ignore: [] });
      const iP = x.spurInfo(int(9, 14), ty);
      const mr = G.meshRack(iP.g, iK.g, 0);
      const fP = fRB.clone().multiply(mr.transform.clone().invert());
      const thP = (q) => (xs(q) - mr.phase) / mr.ratio;
      const peakP = (e * x.peakOf(sh)) / Math.abs(mr.ratio);
      const shP = x.newShaft(fP, thP, null, undefined, peakP);
      c.shafts.push(shP);
      const pin = x.gearPart(c, "spur", iP, shP, x.rotating(fP, thP, null, peakP), { role: "oscillating" });
      shP.members = [{ part: pin, z0: iP.zmin, z1: iP.zmax, axle: true, m0: AXLE_END, m1: AXLE_END }];
      c.colliders.push(x.hullCollider(pin, fP, iP.discs));
      x.meshPair(c, rk, pin);
      return x.speedOk(shP) ? { c, driver: pin } : null;
    },
  },
  helicalStage("helical", false),
  helicalStage("herringbone", true),
  {
    // Crossed helical pair: the next shaft is skew to this one (90 deg, sometimes 60).
    type: "crossed", weight: 0, gears: 2,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0 || crossedFrom(D, Math.PI / 2),
    build(D, x) {
      const { rng, rand, int, pick, m, ra, rMax } = x;
      const c = x.candidate(), sh = D.shaft, sides = x.openSides(sh);
      const sigma = rng() < 0.8 ? Math.PI / 2 : Math.PI / 3;
      const direct = crossedFrom(D, sigma) && (!sides.length || rng() < 0.5);
      if (!direct && !sides.length) return null;
      const hA = direct ? D.info.g.helix : sigma * rand(0.4, 0.6), hB = sigma - hA;
      const mn = direct ? D.info.g.normalModule : m * rand(0.75, 0.9), w = m * rand(3.5, 5);
      const maxN = (h) => Math.max(10, Math.min(24, Math.floor((2 * rMax * Math.cos(h)) / mn)));
      const up = x.wantUp(sh);
      let na = int(10, maxN(hA)), nb = int(10, maxN(hB));
      if (!direct && up !== na > nb) [na, nb] = [Math.min(nb, maxN(hA)), Math.min(na, maxN(hB))];
      const info = (n, h) => x.built("helicalGear", { teeth: n, normalModule: mn, width: w, helix: h, bore: ra, style: "auto", seed: int(1, 1e6) });
      const A = direct ? D : x.onShaft(c, sh, pick(sides), info(na, hA), m * rand(1, 2.5), undefined, "helical");
      const B = x.meshNew(c, A, info(nb, hB), rng() * TAU, (a, b, d) => G.meshCrossedHelical(a, b, sigma, d), "helical");
      return x.speedOk(B.shaft) ? { c, driver: B, extra: { sigma } } : null;
    },
  },
  {
    // Roller chain over 2-3 sprockets in the plane of one on this shaft.
    type: "chain", weight: 0, gears: 3,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, rMax, AXLE_END, CLEAR } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      const p = Math.PI * m * rand(1, 1.25), dims = C.chainDimensions(p);
      // Half width of the links across the chain, and how far their plates reach past the pitch line.
      const hc = 0.62 * p, hr = dims.innerHeight / 2 + 0.03 * p;
      const nFor = (lo, hi) => { let n = int(lo, hi); while (n > lo && C.sprocketPitchRadius(n, p) + hr > rMax) n--; return n; };
      const count = rng() < 0.65 ? 2 : 3, up = x.wantUp(sh);
      const teeth = [nFor(10, 28), nFor(9, 28)];
      if (up !== teeth[0] > teeth[1]) teeth.reverse();
      if (count === 3) teeth.push(nFor(9, 24));
      const R = teeth.map((n) => C.sprocketPitchRadius(n, p));
      const room = (a, b) => R[a] + R[b] + 2 * hr + CLEAR;
      const a1 = rng() * TAU, d1 = room(0, 1) + p * rand(1, 6);
      const centres = [[0, 0], [d1 * Math.cos(a1), d1 * Math.sin(a1)]];
      if (count === 3) {
        const a2 = a1 + (rng() < 0.5 ? 1 : -1) * rand(0.8, 1.9), d2 = room(0, 2) + p * rand(1, 5);
        centres.push([d2 * Math.cos(a2), d2 * Math.sin(a2)]);
        if (Math.hypot(centres[2][0] - centres[1][0], centres[2][1] - centres[1][1]) < room(1, 2) + p) return null;
      }
      let loop;
      try { loop = C.chainLoop({ sprockets: teeth.map((n, j) => ({ centre: centres[j], teeth: n })), pitch: p }); } catch { return null; }
      const zc = x.placeAt(sh, side, -hc, hc, m * rand(1, 2), false, x.membersOf(c, sh));
      const F = sh.frame.clone().multiply(tz(zc));
      const ph0 = loop.sprockets[0].phase, n0 = teeth[0];
      const travel = (q) => ((sh.theta(q) - ph0) * n0 * p) / TAU;
      const chainId = x.nextId("ch"), group = x.nextId("chn");
      const sprockets = [], ignore = [`a:${sh.id}`], hulls = [];
      for (let j = 0; j < count; j++) {
        const info = x.built("sprocket", { teeth: teeth[j], pitch: p, width: dims.sprocketWidth, bore: ra, chamfer: 0, seed: int(1, 1e6) });
        const cj = loop.sprockets[j].centre;
        const Fj = F.clone().multiply(new Matrix4().makeTranslation(cj[0], cj[1], 0));
        let part;
        if (j === 0) {
          part = x.gearPart(c, "sprocket", info, sh, x.rotating(Fj, sh.theta, sh.lin, sh.peak), { chain: chainId });
          x.addMember(c, sh, { part, z0: zc - hc, z1: zc + hc, axle: true, m0: AXLE_END, m1: AXLE_END });
        } else {
          const r = n0 / teeth[j], th = x.mapTheta(sh, r, loop.sprockets[j].phase - r * ph0);
          const shj = x.newShaft(Fj, th.theta, th.lin, undefined, th.peak);
          c.shafts.push(shj);
          part = x.gearPart(c, "sprocket", info, shj, x.rotating(Fj, th.theta, th.lin, th.peak), { chain: chainId });
          shj.members = [{ part, z0: -hc, z1: hc, axle: true, m0: AXLE_END, m1: AXLE_END }];
          ignore.push(`a:${shj.id}`);
          if (!x.speedOk(shj)) return null;
        }
        c.colliders.push(x.hullCollider(part, Fj, info.discs));
        hulls.push(hullShape(Fj, [[-hc, R[j] + hr], [hc, R[j] + hr]]));
        sprockets.push(part);
      }
      const chain = x.addPart(c, {
        id: chainId, kind: "chain", shaft: null, group, meshesWith: [], draggable: false,
        build: { fn: "chainLinks", module: "chain.js", args: { pitch: p, linkCount: loop.linkCount } },
        motion: { local: () => F.clone(), lin: null, frame: F, chain: { loop, travel, frame: F } },
      });
      for (const s of sprockets) x.meshPair(c, chain, s);
      c.colliders.push({ shape: hullsShape(hulls), tags: [`p:${chain.id}`, `g:${group}`], ignore });
      return { c, driver: sprockets[count - 1], extra: { count, links: loop.linkCount, pitch: p } };
    },
  },
  {
    // Bevel differential: the input spur drives a large wheel that is the cage; two spiders on its cross pin roll on
    // a side gear held on a fixed stub, so the other side gear turns at twice the cage, and drives on.
    type: "differential", weight: 0, gears: 7,
    canAttach: (D, x) => x.openSides(D.shaft).length > 0 && x.gearCount() + 7 <= x.hi,
    build(D, x) {
      const { rng, rand, int, pick, m, ra, unit, AXLE_END, CLEAR } = x;
      const c = x.candidate(), sh = D.shaft, side = pick(x.openSides(sh));
      // The bevels inside mesh only with each other, so they take a finer module to keep the cage wheel small.
      const ns = 2 * int(5, 6), np = int(8, Math.min(ns, 10)), md = m * rand(0.6, 0.8);
      const [dS, dP] = G.bevelPitchAngles(ns, np, Math.PI / 2);
      const pinR = 0.6 * md;
      const iL = x.built("bevelGear", { teeth: ns, module: md, pitchAngle: dS, bore: Math.min(ra, 0.8 * md) });
      const iP = x.built("bevelGear", { teeth: np, module: md, pitchAngle: dP, bore: pinR + 0.05 * md });
      // Wheel bore clear of the spiders (radial reach hypot(apex, back radius)) and the side gears.
      const reach = Math.max(Math.hypot(iP.g.apex, iP.rmax), iL.rmax);
      const rb = reach + CLEAR + 0.5 * m;
      let nw = 12;
      const rimOf = (n) => { const rf = (n * m) / 2 - 1.25 * m; return Math.max(rf - Math.max(1.2 * m, 0.1 * rf), 0.6 * rf); };
      while (nw < 200 && rimOf(nw) < rb + 2 * m) nw++;
      if ((nw / 2 + 1) * m > 0.4 * unit) return null;
      const ww = m * rand(3, 4);
      const iA = x.spurInfo(int(9, 14), ww);
      const iW = x.spurInfo(nw, ww, { bore: rb, hub: { radius: rb + m, width: ww }, style: "solid" });
      const A = x.onShaft(c, sh, side, iA, m * rand(1, 2.5));
      const pw = G.meshSpur(A.info.g, iW.g, rng() * TAU);
      const FW = A.motion.frame.clone().multiply(pw.transform);
      const thC = x.mapTheta(A.motion, pw.ratio, pw.phase);
      const shC = x.newShaft(FW, thC.theta, thC.lin, [false, false], thC.peak);
      c.shafts.push(shC);
      const W = x.gearPart(c, "spur", iW, shC, x.rotating(FW, thC.theta, thC.lin, thC.peak), { role: "diffCage" });
      x.meshPair(c, A, W);
      const psi = rng() * TAU, pinLen = 2 * (rb + 0.6 * m);
      const FPin = FW.clone().multiply(rotZ(psi));
      const pin = x.addPart(c, {
        id: x.nextId("cg"), kind: "cage", shaft: shC, group: shC.id, meshesWith: [], draggable: true,
        build: { fn: "crossPin", module: "train", args: { radius: pinR, length: pinLen }, result: pinMesh(pinR, pinLen) },
        motion: x.rotating(FPin, thC.theta, thC.lin, thC.peak),
      });
      shC.members = [{ part: W, z0: -ww / 2, z1: ww / 2, axle: false, m0: 0, m1: 0 }, { part: pin, z0: -pinR, z1: pinR, axle: false, m0: 0, m1: 0 }];
      // Held side gear: back face at -apex on the cage axis, teeth toward the centre.
      const zL = -iL.g.apex, FL = FW.clone().multiply(tz(zL));
      const shL = x.newShaft(FL, () => 0, { ratio: 0, phase: 0 }, [false, false], 0);
      c.shafts.push(shL);
      const L = x.gearPart(c, "bevel", iL, shL, { local: () => FL.clone(), lin: { ratio: 0, phase: 0 }, frame: FL, fixed: true }, { role: "sideHeld", draggable: false });
      shL.members = [{ part: L, z0: iL.zmin, z1: iL.zmax, axle: true, m0: 2 * AXLE_END, m1: 0 }];
      // Spiders: theta relative to the cage follows the held gear's relative angle, -thetaCage.
      const th = thC.theta, spiders = [], pairs = [];
      for (let k = 0; k < 2; k++) {
        const pr = G.meshBevel(iL.g, iP.g, Math.PI / 2, psi + k * Math.PI);
        const T = tz(zL).multiply(pr.transform);
        pairs.push({ pr, T });
        const S = x.gearPart(c, "bevel", iP, null, {
          local: (q) => { const t = th(q); return FW.clone().multiply(rotZ(t)).multiply(T).multiply(rotZ(-pr.ratio * t + pr.phase)); },
          lin: null, frame: FW, peak: Math.abs(pr.ratio) * thC.peak,
        }, { group: x.nextId("sd"), role: "spider" });
        x.meshPair(c, L, S); x.meshPair(c, pin, S);
        spiders.push(S);
      }
      // Output side gear, phased from spider 0; spider 1 must agree (an even side gear count makes it).
      const outPose = (k) => {
        const { pr, T } = pairs[k];
        const az = new Vector3(0, 0, 1).transformDirection(T.clone().invert());
        const ppr = G.meshBevel(iP.g, iL.g, Math.PI / 2, Math.atan2(az.y, az.x));
        const K = T.clone().multiply(ppr.transform);
        return { K, ratio: -(ppr.ratio * pr.ratio + 1), phase: ppr.ratio * pr.phase + ppr.phase };
      };
      const o0 = outPose(0), o1 = outPose(1);
      const zR = o0.K.elements, pitchR = TAU / ns;
      if (Math.abs(zR[10] + 1) > 1e-9 || Math.hypot(zR[12], zR[13]) > 1e-9 || Math.abs(o0.ratio + 2) > 1e-9 || Math.abs(o1.ratio + 2) > 1e-9) return null;
      const rel = o0.K.clone().invert().multiply(o1.K).elements, dphi = Math.atan2(rel[1], rel[0]) + o1.phase - o0.phase;
      if (Math.abs(dphi - pitchR * Math.round(dphi / pitchR)) > 1e-7) return null;
      const FR = FW.clone().multiply(o0.K);
      const thR = x.mapTheta(thC, o0.ratio, o0.phase);
      const shR = x.newShaft(FR, thR.theta, thR.lin, [true, false], thR.peak);
      c.shafts.push(shR);
      const R = x.gearPart(c, "bevel", iL, shR, x.rotating(FR, thR.theta, thR.lin, thR.peak), { role: "side" });
      shR.members = [{ part: R, z0: iL.zmin, z1: iL.zmax, axle: true, m0: AXLE_END, m1: 0 }];
      for (const S of spiders) x.meshPair(c, S, R);
      // The cage wheel as an annulus of boxes; everything inside it as one hull.
      const K = 32, ri = rb * Math.cos(Math.PI / K), ro = iW.g.tipRadius;
      for (let i = 0; i < K; i++) {
        const fr = FW.clone().multiply(rotZ((TAU * i) / K));
        c.colliders.push({ shape: boxShape(fr, [(ri + ro) / 2, 0, 0], [(ro - ri) / 2, ro * Math.tan(Math.PI / K), ww / 2]), tags: [`p:${W.id}`, `g:${shC.id}`], ignore: [] });
      }
      const ext = Math.max(iL.g.apex, iP.rmax);
      c.colliders.push({ shape: hullShape(FW, [[-ext, rb - 0.2 * m], [ext, rb - 0.2 * m]]), tags: [`p:${pin.id}`, `g:${shC.id}`], ignore: [`a:${shL.id}`, `a:${shR.id}`] });
      const [, nout] = x.spurTeeth(x.wantUp(shR));
      const O = x.onShaft(c, shR, -1, x.spurInfo(Math.max(nout, 12)), m * rand(1, 2));
      if (!x.speedOk(shC) || !x.speedOk(shR)) return null;
      return { c, driver: O, extra: { held: L.id, cage: W.id, pin: pin.id, out: R.id, spiders: spiders.map((s) => s.id) } };
    },
  },
];

// A helical gear can drive a crossed pair directly when its helix leaves the partner a workable one.
function crossedFrom(D, sigma) {
  const g = D.info?.g;
  if (D.kind !== "helical" || !D.shaft || !g || g.herringbone) return false;
  const hB = sigma - g.helix;
  return g.helix > 15 * DEG && hB > 15 * DEG && hB < 75 * DEG;
}

// Parallel helical (or herringbone) pair: meshes D directly when D is one of the same kind, else rides D's shaft.
function helicalStage(type, herringbone) {
  return {
    type, weight: 0, gears: 2,
    canAttach: (D, x) => (D.kind === type && !!D.shaft) || x.openSides(D.shaft).length > 0,
    build(D, x) {
      const { rng, rand, int, pick, m, ra } = x;
      const c = x.candidate(), sh = D.shaft, sides = x.openSides(sh);
      const direct = D.kind === type && (!sides.length || rng() < 0.5);
      const info = (n, h, w, mod = m) => x.built("helicalGear", { teeth: n, module: mod, width: w, helix: h, herringbone, bore: ra, style: "auto", seed: int(1, 1e6) });
      const [na, nb] = x.spurTeeth(x.wantUp(sh));
      let A;
      if (direct) A = D;
      else {
        const h = (rng() < 0.5 ? 1 : -1) * rand(15, 30) * DEG;
        A = x.onShaft(c, sh, pick(sides), info(na, h, m * rand(4, 6)), m * rand(1, 2.5), undefined, type);
      }
      const B = x.meshNew(c, A, info(nb, -A.info.g.helix, A.info.args.width, A.info.g.module), rng() * TAU, G.meshHelical, type);
      return x.speedOk(B.shaft) ? { c, driver: B } : null;
    },
  };
}

const FORCE = 10;
export const STAGE_WEIGHTS = Object.fromEntries(STAGE_TYPES.map((s) => [s.type, s.weight]));
const STAGE = Object.fromEntries(STAGE_TYPES.map((s) => [s.type, s]));

// ---------------------------------------------------------------- machine

/**
 * A seeded gear train hanging off an anchor escapement, inside a sphere of radius `size` about the origin.
 * Parts: pose(q[, anchorAngle]) -> Matrix4 world matrix; fixed-axle parts also have ratio and phase
 * (theta = ratio * q + phase about the part's local +z); dPose(q, point) -> world velocity per unit q of the
 * material point at `point`. build: { fn, args, module } names the builder (gears.js, escapement.js, chain.js, or
 * "train" for the crank / yoke / carrier that main.js makes from primitives); build.result, when present, is the
 * geometry already built. A "chain" part has linkCount, linkKind(i) and linkPose(i, q[, target]) (world matrix of
 * link i, for instancing chain.js rollerLink / plateLink), and travel(q).
 *
 * Options:
 * - gears: target gear count, 6..30 (default: 9..14 at random, accepted 8..15; a value that is not a number is the
 *   default). A target G is met within +-ceil(G / 6), widened by up to 7 when the weights leave no other way.
 * - size: radius of the bounding sphere. Default 0.65 * cbrt(G / 12), so the room grows with the gear count while
 *   parts keep their size; parts (module, escapement) scale by size / (0.65 * cbrt(G / 12)), i.e. size / 0.65 when
 *   no gear count is given.
 * - weights: { [stage type]: weight }, merged over STAGE_WEIGHTS; 0 disables a type, 10 or more puts it in every
 *   machine the gear count leaves room for (tried first; a machine without it is rejected). All 0 means a plain
 *   spur / compound / idler train.
 *   Only when every candidate fails (the last 10 of 60 attempts) may spur, compound and idler stages fill in
 *   anyway. A custom mix also makes the big types (planetary, differential) be tried while they still fit, and
 *   planetary sets pick from every fitting tooth count, so a type in the mix gets built. Without weights the
 *   generator keeps the phase-2 rules, and the new types (helical, herringbone, crossed, chain, differential)
 *   default to 0, so the defaults give the same machines as before.
 * - chamfer: 0..1 (or true = 0.5): every edge chamfered by chamfer * 2 * DEFAULT_CHAMFER modules (0.5 = the
 *   builders' default). erosion: amount 0..1 (true = 1) or { amount, seed }. Both reshape the parts only: the layout is the
 *   same for any finish, and the worn geometry is built when build.result is first read.
 */
export function createMachine({ seed = 1, size, gears, weights, chamfer = 0, erosion = 0 } = {}) {
  const gN = gears === undefined ? NaN : Number(gears);
  const G0 = Number.isFinite(gN) ? Math.max(6, Math.min(30, Math.round(gN))) : null;
  const room = size ?? (G0 ? 0.65 * Math.cbrt(G0 / 12) : 0.65);
  const scale = room / (0.65 * Math.cbrt((G0 ?? 12) / 12));
  const w = { ...STAGE_WEIGHTS };
  for (const [k, v] of Object.entries(weights ?? {})) if (k in w) w[k] = Math.max(0, Number(v) || 0);
  const custom = weights != null;
  if (custom && !Object.values(w).some((v) => v > 0)) for (const k of ["spur", "compound", "idler"]) w[k] = STAGE_WEIGHTS[k];
  for (let attempt = 0; attempt < 60; attempt++) {
    const mc = tryMachine(seed, attempt, room, scale, G0, w, custom);
    if (mc) return finish(mc, chamfer, erosion);
  }
  throw new Error(`createMachine: no machine for seed ${seed}`);
}

function tryMachine(seed, attempt, size, k, G0, weights, custom = false) {
  const W = { ...weights };
  const rng = mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(attempt + 1, 0x85ebca6b)) >>> 0);
  const rand = (a, b) => a + (b - a) * rng();
  const int = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const unit = 0.65 * k;
  const others = STAGE_TYPES.map((s) => s.type).filter((s) => s !== "compound" && W[s] > 0);
  // Types weighted FORCE or more are in every machine's mix.
  const palette = ["compound", ...others.filter((s) => W[s] >= FORCE)];
  const nTypes = Math.max(palette.length, rng() < 0.2 ? 2 : rng() < 0.65 ? 3 : 4);
  while (palette.length < nTypes) {
    const pool = others.filter((s) => !palette.includes(s)), tot = pool.reduce((a, s) => a + W[s], 0);
    if (!pool.length) break;
    let r = rng() * tot;
    for (const s of pool) { r -= W[s]; if (r <= 0) { palette.push(s); break; } }
  }
  // Late attempts may fall back on plain spur stages even when their weight is 0. A custom mix widens the gear count
  // window instead: at once when its forced types or its stage sizes cannot land in it, else from attempt 30; and it
  // falls back only on its last attempts.
  const relaxed = custom ? attempt >= 50 : attempt >= 30, lo0 = G0 ? Math.max(4, G0 - Math.ceil(G0 / 6)) : 8, hi0 = G0 ? G0 + Math.ceil(G0 / 6) : 15;
  const forced = palette.filter((s) => W[s] >= FORCE), need = 2 + forced.reduce((a, s) => a + STAGE[s].gears, 0);
  let widen = 0;
  if (custom) {
    const sizes = palette.filter((s) => W[s] > 0).map((s) => STAGE[s].gears), reach = new Uint8Array(hi0 + 8);
    reach[2] = 1;
    for (let g = 3; g < reach.length; g++) reach[g] = sizes.some((z) => g - z >= 2 && reach[g - z]) ? 1 : 0;
    const lands = (d) => reach.some((r, g) => r && g >= lo0 - d && g <= hi0 + d);
    while (widen < 7 && !lands(widen)) widen++;
    widen = Math.min(7, Math.max(widen, need - hi0, attempt >= 30 ? 7 : 0));
  }
  const lo = Math.max(4, lo0 - widen), hi = hi0 + widen;
  const mustHave = custom && attempt < 30 && forced.length <= 3 && need <= hi;
  // Rings and planetary sets only fit with fine teeth.
  const m = (palette.includes("planetary") ? rand(0.014, 0.0155) : palette.includes("ring") ? rand(0.014, 0.017) : rand(0.014, 0.021)) * k;
  const ra = 0.7 * m, CLEAR = 0.35 * m, AXLE_END = 1.2 * m;
  const rMax = 0.24 * unit;
  const nMax = Math.max(14, Math.floor((2 * rMax) / m));

  const cache = new Map();
  function built(fn, args) {
    const key = fn + JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const g = BUILDERS[fn](args);
    const P = g.position, I = g.index;
    let zmin = Infinity, zmax = -Infinity, rmax = 0;
    for (let i = 0; i < P.length; i += 3) { zmin = Math.min(zmin, P[i + 2]); zmax = Math.max(zmax, P[i + 2]); rmax = Math.max(rmax, Math.hypot(P[i], P[i + 1])); }
    let discs = [[zmin, rmax], [zmax, rmax]];
    if (fn === "bevelGear") {
      // Radius per z slice, so the cone's hull hugs it.
      const n = 6, bins = new Array(n).fill(0), at = (z) => Math.min(n - 1, Math.max(0, Math.floor(((z - zmin) / (zmax - zmin)) * n)));
      for (let t = 0; t < I.length; t += 3) {
        let lo = Infinity, hi = -Infinity, r = 0;
        for (let v = 0; v < 3; v++) { const j = 3 * I[t + v]; lo = Math.min(lo, P[j + 2]); hi = Math.max(hi, P[j + 2]); r = Math.max(r, Math.hypot(P[j], P[j + 1])); }
        for (let b = at(lo); b <= at(hi); b++) bins[b] = Math.max(bins[b], r);
      }
      discs = [];
      bins.forEach((r, b) => { discs.push([zmin + ((zmax - zmin) * b) / n, r], [zmin + ((zmax - zmin) * (b + 1)) / n, r]); });
    }
    const out = { g, fn, args, zmin, zmax, rmax, discs };
    cache.set(key, out);
    return out;
  }

  const parts = [], shafts = [], colliders = [], stages = [];
  let gearCount = 0, uid = 0;
  const nextId = (p) => `${p}${uid++}`;

  // Peak |dtheta/dq|: the ratio, or a bound for parts driven through the yoke.
  const peakOf = (x) => (x.lin ? Math.abs(x.lin.ratio) : x.peak);
  // A shaft: world frame at theta = 0, theta(q), linear {ratio, phase} or null, members along its z.
  function newShaft(frame, theta, lin, open = [true, true], peak) {
    return { id: nextId("s"), frame, theta, lin, peak: lin ? Math.abs(lin.ratio) : peak, members: [], open: [...open], axle: null };
  }
  const mapTheta = (sh, r, p) => ({ theta: (q) => r * sh.theta(q) + p, lin: sh.lin && { ratio: r * sh.lin.ratio, phase: r * sh.lin.phase + p }, peak: peakOf(sh) * Math.abs(r) });
  const invTheta = (sh, r, p) => mapTheta(sh, 1 / r, -p / r);

  function axleSpan(members) {
    let from = Infinity, to = -Infinity;
    for (const mb of members) if (mb.axle) { from = Math.min(from, mb.z0 - mb.m0); to = Math.max(to, mb.z1 + mb.m1); }
    return from < to ? { from, to } : null;
  }
  function axleCollider(sh, members) {
    const span = axleSpan(members);
    if (!span) return null;
    return { shape: hullShape(sh.frame, [[span.from, ra], [span.to, ra]]), tags: [`a:${sh.id}`, `g:${sh.id}`], ignore: [], axleOf: sh.id };
  }
  function endOf(sh, side, members = sh.members) {
    let v = side > 0 ? -Infinity : Infinity;
    for (const mb of members) v = side > 0 ? Math.max(v, mb.z1) : Math.min(v, mb.z0);
    return v;
  }
  // Centre z of a member with local z range [zmin, zmax] placed `gap` past the shaft's end on `side`.
  const placeAt = (sh, side, zmin, zmax, gap, flip = false, members = sh.members) => {
    const end = endOf(sh, side, members);
    if (side > 0) return flip ? end + gap + zmax : end + gap - zmin;
    return flip ? end - gap + zmin : end - gap - zmax;
  };
  const span = (zc, info, flip) => (flip ? [zc - info.zmax, zc - info.zmin] : [zc + info.zmin, zc + info.zmax]);

  function rotating(frame, theta, lin, peak) {
    const f = frame.clone();
    return { local: (q) => f.clone().multiply(rotZ(theta(q))), lin, peak: lin ? Math.abs(lin.ratio) : peak, frame: f, theta };
  }

  // A candidate stage: new parts, shafts, members per shaft, colliders, meshing pairs, gears added.
  function candidate() {
    return { parts: [], shafts: [], members: new Map(), colliders: [], meshes: [], gears: 0, open: [] };
  }
  const membersOf = (c, sh) => c.members.get(sh) ?? sh.members;
  function addMember(c, sh, mb) { c.members.set(sh, [...membersOf(c, sh), mb]); }
  function addPart(c, part) { c.parts.push(part); if (GEAR_KINDS.has(part.kind)) c.gears++; return part; }
  const PREFIX = { spur: "g", helical: "h", herringbone: "h", sprocket: "sp" };
  function gearPart(c, kind, info, sh, motion, extra = {}) {
    const module = info.fn === "sprocket" ? "chain.js" : "gears.js";
    return addPart(c, { id: nextId(PREFIX[kind] ?? kind[0]), kind, build: { fn: info.fn, args: info.args, module, result: info.g }, info, shaft: sh, group: sh ? sh.id : extra.group, motion, meshesWith: [], draggable: true, ...extra });
  }
  const hullCollider = (part, frame, discs, extraIgnore = []) => ({ shape: hullShape(frame, discs), tags: [`p:${part.id}`, `g:${part.group}`], ignore: [...extraIgnore] });

  function meshPair(c, a, b) { c.meshes.push([a, b]); }

  function check(c) {
    const shafts2 = [...c.members.keys()];
    const replaced = new Set(shafts2.map((s) => s.id));
    const fresh = [...c.colliders];
    for (const sh of shafts2) { const ac = axleCollider(sh, c.members.get(sh)); if (ac) fresh.push(ac); }
    for (const sh of c.shafts) if (!c.members.has(sh)) { const ac = axleCollider(sh, sh.members); if (ac) fresh.push(ac); }
    const meshTags = new Map();
    for (const [a, b] of c.meshes) {
      (meshTags.get(a.id) ?? meshTags.set(a.id, []).get(a.id)).push(`p:${b.id}`);
      (meshTags.get(b.id) ?? meshTags.set(b.id, []).get(b.id)).push(`p:${a.id}`);
    }
    const extraIgnore = (col) => { const id = col.tags.find((t) => t.startsWith("p:")); return id ? meshTags.get(id.slice(2)) ?? [] : []; };
    const skip = (A, B) => {
      for (const t of A.tags) if (t.startsWith("g:") && B.tags.includes(t)) return true;
      const ia = [...A.ignore, ...extraIgnore(A)], ib = [...B.ignore, ...extraIgnore(B)];
      return A.tags.some((t) => ib.includes(t)) || B.tags.some((t) => ia.includes(t));
    };
    const old = colliders.filter((cl) => !(cl.axleOf && replaced.has(cl.axleOf)));
    for (let i = 0; i < fresh.length; i++) {
      for (const B of old) if (!skip(fresh[i], B) && !clearOf(fresh[i].shape, B.shape, CLEAR)) return null;
      for (let j = i + 1; j < fresh.length; j++) if (!skip(fresh[i], fresh[j]) && !clearOf(fresh[i].shape, fresh[j].shape, CLEAR)) return null;
    }
    const pts = [];
    for (const cl of [...old, ...fresh]) pts.push(...(cl.pts ?? (cl.pts = shapePoints(cl.shape))));
    if (enclosingSphere(pts).radius > 1.04 * size) return null;
    return { old, fresh };
  }

  function commit(c, res, type) {
    colliders.length = 0;
    colliders.push(...res.old, ...res.fresh);
    for (const [sh, mb] of c.members) sh.members = mb;
    for (const [sh, side] of c.open) sh.open[side > 0 ? 1 : 0] = false;
    for (const sh of c.shafts) if (!shafts.includes(sh)) shafts.push(sh);
    for (const [a, b] of c.meshes) { a.meshesWith.push(b.id); b.meshesWith.push(a.id); }
    parts.push(...c.parts);
    gearCount += c.gears;
    stages.push({ type, parts: c.parts.map((p) => p.id) });
  }

  const ratioOf = peakOf;
  const speedOk = (sh) => peakOf(sh) < 40 && peakOf(sh) > 0.01;
  // Steer the train's speed: true for a step-up (big driver, small driven).
  const wantUp = (sh) => { const r = ratioOf(sh); return r < 0.8 ? rng() < 0.85 : r > 6 ? rng() < 0.15 : rng() < 0.5; };
  const spurTeeth = (up) => {
    const pin = int(8, 12), wheel = int(Math.min(nMax, pin + 5), nMax);
    return up ? [wheel, pin] : [pin, wheel];
  };
  const width = () => m * rand(3.5, 5);
  const spurInfo = (teeth, w = width(), extra = {}) => built("spurGear", { teeth, module: m, width: w, bore: ra, style: "auto", seed: int(1, 1e6), ...extra });

  // Place a gear on a shaft member slot.
  function onShaft(c, sh, side, info, gap, m1 = AXLE_END, kind = "spur") {
    const zc = placeAt(sh, side, info.zmin, info.zmax, gap, false, membersOf(c, sh));
    const [z0, z1] = span(zc, info, false);
    const frame = sh.frame.clone().multiply(tz(zc));
    const mot = rotating(frame, sh.theta, sh.lin, sh.peak);
    const part = gearPart(c, kind, info, sh, mot);
    addMember(c, sh, { part, z0, z1, axle: true, m0: side < 0 ? m1 : AXLE_END, m1: side > 0 ? m1 : AXLE_END });
    c.colliders.push(hullCollider(part, frame, info.discs));
    return part;
  }

  // Mesh a new gear with gear part A at `dir` (meshSpur by default); the new gear gets its own shaft.
  function meshNew(c, A, info, dir, pairing = G.meshSpur, kind = "spur") {
    const pr = pairing(A.info.g, info.g, dir);
    const frame = A.motion.frame.clone().multiply(pr.transform);
    const th = mapTheta(A.motion, pr.ratio, pr.phase);
    const sh = newShaft(frame, th.theta, th.lin, undefined, th.peak);
    c.shafts.push(sh);
    const part = gearPart(c, kind, info, sh, rotating(frame, th.theta, th.lin, th.peak));
    sh.members = [{ part, z0: info.zmin, z1: info.zmax, axle: true, m0: AXLE_END, m1: AXLE_END }];
    c.colliders.push(hullCollider(part, frame, info.discs));
    meshPair(c, A, part);
    return part;
  }

  const openSides = (sh) => (sh ? [-1, 1].filter((s) => sh.open[s > 0 ? 1 : 0]) : []);

  const x = {
    rng, rand, int, pick, m, ra, CLEAR, AXLE_END, size, unit, rMax, nMax, hi,
    built, candidate, membersOf, addMember, addPart, gearPart, hullCollider, meshPair, newShaft, mapTheta, invTheta,
    rotating, placeAt, span, endOf, openSides, spurTeeth, wantUp, width, spurInfo, onShaft, meshNew, speedOk, ratioOf,
    peakOf, nextId, gearCount: () => gearCount, custom,
  };

  // ---- escapement
  const Ne = int(15, 30), Re = rand(0.1, 0.13) * k, wE = 0.07 * Re;
  const layout = E.escapementLayout({ teeth: Ne, radius: Re });
  // The anchor's hub is set by the layout; its arbor thins to keep a wall around the bore.
  const raA = Math.min(ra, layout.hubRadius - 0.5 * m);
  const anchorGeo = E.buildAnchor({ teeth: Ne, radius: Re, bore: raA });
  const wA = anchorGeo.width;
  let anchorR = 0;
  for (let i = 0; i < anchorGeo.position.length; i += 3) anchorR = Math.max(anchorR, Math.hypot(anchorGeo.position[i], anchorGeo.position[i + 1]));
  const pLen = rand(0.36, 0.48) * k, bobR = rand(0.13, 0.17) * pLen;
  const pendArgs = { length: pLen, bobRadius: bobR, bore: raA, hubRadius: Math.max(0.048 * pLen, raA + 0.8 * m) };
  const pendGeo0 = E.buildPendulum(pendArgs);
  const pz = E.escapementPendulumZ({ wheelWidth: wE, anchorWidth: wA, pendulumThickness: pendGeo0.bobThickness, gap: 2.5 * m });
  pendArgs.z = pz;
  const pivot = layout.pivot;
  const fPivot = new Matrix4().makeTranslation(...pivot);

  const esc = newShaft(new Matrix4(), (q) => q, { ratio: 1, phase: 0 }, [false, true]);
  shafts.push(esc);
  const escWheel = {
    id: "escape", kind: "escapeWheel", shaft: esc, group: esc.id, meshesWith: [], draggable: true,
    build: { fn: "buildEscapeWheel", module: "escapement.js", args: { teeth: Ne, radius: Re, width: wE, bore: ra } },
    motion: rotating(new Matrix4(), esc.theta, esc.lin),
  };
  esc.members = [{ part: escWheel, z0: -wE / 2, z1: wE / 2, axle: true, m0: 0.6 * m, m1: AXLE_END }];
  const amp = layout.amplitude + 0.02;
  const anchor = {
    id: "anchor", kind: "anchor", shaft: null, group: "anchor", meshesWith: ["escape"], draggable: false,
    build: { fn: "buildAnchor", module: "escapement.js", args: { teeth: Ne, radius: Re, bore: raA } },
    motion: { local: (q, a = 0) => fPivot.clone().multiply(rotZ(a)), lin: null, frame: fPivot, swing: true },
  };
  const pendulum = {
    id: "pendulum", kind: "pendulum", shaft: null, group: "anchor", meshesWith: [], draggable: false,
    build: { fn: "buildPendulum", module: "escapement.js", args: pendArgs },
    motion: { local: (q, a = 0) => fPivot.clone().multiply(rotZ(a)), lin: null, frame: fPivot, swing: true },
  };
  escWheel.meshesWith.push("anchor");
  parts.push(escWheel, anchor, pendulum);
  const ptz = pendGeo0.bobThickness;
  const anchorAxle = { origin: [...pivot], dir: [0, 0, 1], from: pz - ptz / 2 - 0.5 * m, to: wA / 2 + AXLE_END, radius: raA };
  colliders.push(
    { shape: hullShape(new Matrix4(), [[-wE / 2, Re * 1.01], [wE / 2, Re * 1.01]]), tags: ["p:escape", `g:${esc.id}`], ignore: ["p:anchor"] },
    { shape: hullShape(fPivot, [[-wA / 2, anchorR], [wA / 2, anchorR]]), tags: ["p:anchor", "g:anchor"], ignore: ["p:escape"] },
    { shape: hullShape(fPivot, [[anchorAxle.from, raA], [anchorAxle.to, raA]]), tags: ["a:anchor", "g:anchor"], ignore: [] },
    { shape: boxShape(fPivot, [0, -(pLen + bobR - pendGeo0.hubRadius) / 2, pz], [pLen * Math.sin(amp) + bobR * 1.02, (pLen + bobR + pendGeo0.hubRadius) / 2 * 1.01, ptz / 2 * 1.02]), tags: ["p:pendulum", "g:anchor"], ignore: [] },
  );
  const ac0 = axleCollider(esc, esc.members);
  colliders.push(ac0);

  // ---- train: the escape arbor's pinion drives the first wheel
  const target0 = int(9, 14), target = G0 ?? target0;
  let driver = null;
  for (let t = 0; t < 12 && !driver; t++) {
    const c = candidate(), w = width();
    const A = onShaft(c, esc, 1, spurInfo(int(8, 12), w), m * rand(1, 2.5));
    const B = meshNew(c, A, spurInfo(int(10, Math.min(nMax, 24)), w), rng() * TAU);
    const res = check(c);
    if (res) { commit(c, res, "compound"); driver = B; }
  }
  if (!driver) return null;

  let budget = Math.round(260 * Math.max(1, target / 12));
  const uses = (s) => stages.filter((st) => st.type === s).length, eagerTries = new Map();
  // Stages of a type beyond the escape arbor's own compound.
  const added = (s) => uses(s) - (s === "compound" ? 1 : 0);
  while (gearCount < target && budget > 0) {
    const tryTypes = (types, D) => {
      for (let t = 0; t < 4 && budget > 0; t++) {
        const tot = types.reduce((a, s) => a + W[s] / (1 + 0.6 * uses(s)), 0);
        if (!(tot > 0)) return null;
        let r = rng() * tot, type = types[0];
        for (const s of types) { r -= W[s] / (1 + 0.6 * uses(s)); if (r <= 0) { type = s; break; } }
        for (let tries = 0; tries < 6 && budget > 0; tries++) {
          budget--;
          const res = STAGE[type].canAttach(D, x) ? STAGE[type].build(D, x) : null;
          if (!res) break;
          const ok = check(res.c);
          if (ok) { commit(res.c, ok, type); Object.assign(stages[stages.length - 1], res.extra ?? {}); return res.driver; }
        }
      }
      return null;
    };
    const fits = (s) => gearCount + STAGE[s].gears <= hi;
    let next = null;
    if (custom) {
      // Forced types, then big ones that may soon stop fitting, go first (a few rounds each).
      const eager = palette.filter((s) => (W[s] >= FORCE || STAGE[s].gears >= 5) && !added(s) && fits(s) && (eagerTries.get(s) ?? 0) < 3);
      for (const s of eager) eagerTries.set(s, (eagerTries.get(s) ?? 0) + 1);
      if (eager.length) next = tryTypes(eager, driver);
    }
    next ??= tryTypes(palette.filter(fits), driver);
    if (!next) {
      // Branch from another gear of the train.
      const drivers = parts.filter((p) => p.shaft && p.kind !== "escapeWheel" && p !== driver);
      for (let t = 0; t < 4 && !next && drivers.length; t++) next = tryTypes(palette.filter(fits), pick(drivers));
      if (!next) {
        const basic = ["spur", "compound", "idler"].filter((s) => fits(s) && (W[s] > 0 || relaxed));
        if (relaxed) for (const s of basic) W[s] ||= 1;
        if (basic.length) next = tryTypes(basic, pick(drivers.length ? drivers : [driver]));
      }
    }
    if (!next) break;
    driver = next;
  }
  const kinds = new Set(["compound", ...others]).size;
  if (gearCount < lo || gearCount > hi || new Set(stages.map((st) => st.type)).size < Math.min(2, kinds)) return null;
  if (mustHave && forced.some((s) => !added(s))) return null;

  // ---- recentre and expose
  const pts = [];
  for (const cl of colliders) pts.push(...(cl.pts ?? shapePoints(cl.shape)));
  const sphere = enclosingSphere(pts, 400);
  if (sphere.radius > size) return null;
  const SHIFT = new Matrix4().makeTranslation(-sphere.centre[0], -sphere.centre[1], -sphere.centre[2]);
  const shiftArr = (p) => [p[0] - sphere.centre[0], p[1] - sphere.centre[1], p[2] - sphere.centre[2]];

  const axleOf = new Map();
  const axles = [];
  for (const sh of shafts) {
    const s = axleSpan(sh.members);
    if (!s) continue;
    const a = { origin: shiftArr(col(sh.frame, 3)), dir: col(sh.frame, 2), from: s.from, to: s.to, radius: ra, shaft: sh.id };
    if (sh.lin && sh.lin.ratio === 0) a.fixed = true;
    axles.push(a);
    axleOf.set(sh.id, a);
  }
  const anchorAx = { ...anchorAxle, origin: shiftArr(anchorAxle.origin), shaft: "anchor" };
  axles.push(anchorAx);

  const out = parts.map((p) => {
    const local = p.motion.local;
    const pose = (q, a = 0) => SHIFT.clone().multiply(local(q, a));
    const part = {
      id: p.id, kind: p.kind, build: p.build, group: p.group, meshesWith: [...new Set(p.meshesWith)], draggable: p.draggable,
      axle: p.shaft ? axleOf.get(p.shaft.id) ?? null : p.group === "anchor" ? anchorAx : null,
      pose,
      dPose(q, point, a = 0, h = 1e-4) {
        const P = Array.isArray(point) ? new Vector3(...point) : point.clone();
        const L = P.clone().applyMatrix4(pose(q, a).invert());
        return L.clone().applyMatrix4(pose(q + h, a)).sub(L.applyMatrix4(pose(q - h, a))).divideScalar(2 * h);
      },
    };
    if (p.role) part.role = p.role;
    if (p.chain) part.chain = p.chain;
    if (p.motion.lin) { part.ratio = p.motion.lin.ratio; part.phase = p.motion.lin.phase; }
    if (p.motion.fixed) part.fixed = true;
    if (p.motion.swing) part.swing = true;
    if (p.motion.chain) {
      const { loop, travel, frame } = p.motion.chain, F = SHIFT.clone().multiply(frame), L = new Matrix4();
      Object.assign(part, {
        pitch: loop.pitch, linkCount: loop.linkCount, travel, linkKind: loop.linkKind,
        linkPose: (i, q, target = new Matrix4()) => target.multiplyMatrices(F, loop.linkPose(i, travel(q), L)),
        rollerPosition: (k, q) => new Vector3(...loop.rollerPosition(k, travel(q)), 0).applyMatrix4(F),
      });
    }
    return part;
  });

  return {
    seed, module: m, size, attempt, parts: out, axles,
    bounds: { centre: [0, 0, 0], radius: sphere.radius },
    gearCount, stages, palette,
    escapement: { teeth: Ne, radius: Re, width: wE, layout, pivot: shiftArr(pivot) },
    colliders: colliders.map(({ pts: _, ...cl }) => ({ ...cl, shape: shiftShape(cl.shape, sphere.centre) })),
    clearance: CLEAR,
  };
}

// Chamfer and erosion go into every builder's args; the worn mesh is built on first read of build.result.
function finish(mc, chamfer, erosion) {
  const amount = chamfer === true ? 0.5 : Math.max(0, Math.min(1, Number(chamfer) || 0));
  const ero = erosion === true ? { amount: 1 } : typeof erosion === "number" ? { amount: erosion } : erosion ? { ...erosion, amount: erosion.amount ?? 1 } : {};
  const eAmount = Math.max(0, Math.min(1, Number(ero.amount) || 0)), eSeed = (ero.seed ?? mc.seed) | 0;
  if (!(amount > 0) && !(eAmount > 0)) return mc;
  const ch = amount * 2 * G.DEFAULT_CHAMFER * mc.module;
  mc.parts.forEach((p, i) => {
    const b = p.build, lib = LIBS[b.module];
    if (!lib || !lib[b.fn] || b.fn === "chainLinks") return;
    b.args = { ...b.args, chamfer: ch };
    if (eAmount > 0) b.args.erosion = { amount: eAmount, seed: (Math.imul(eSeed, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0 };
    if (!("result" in b)) return;
    let worn = null;
    const fn = lib[b.fn], args = b.args;
    Object.defineProperty(b, "result", { get: () => (worn ??= fn(args)), configurable: true, enumerable: false });
  });
  mc.finish = { chamfer: ch, erosion: eAmount };
  return mc;
}

function shiftShape(s, c) {
  if (s.type === "hulls") return { ...s, c: [s.c[0] - c[0], s.c[1] - c[1], s.c[2] - c[2]], parts: s.parts.map((p) => shiftShape(p, c)) };
  return { ...s, c: [s.c[0] - c[0], s.c[1] - c[1], s.c[2] - c[2]] };
}
