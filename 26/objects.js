import { Vector3 } from "three";

const TAU = Math.PI * 2;
const S13 = Math.sqrt(1 / 3);
const ISO_PITCH_DEG = (Math.asin(S13) * 180) / Math.PI; // 35.2643897°

// -----------------------------------------------------------------------------
// 1. Impossible Ring (Reference 1):
//    Built from TWO untwisted 180° half-torus meshes split at the minor-axis middle,
//    with the second half rotated 180° around +Z from the first!
// -----------------------------------------------------------------------------

function buildRing(opts) {
  const radius = opts.radius * 1.04;
  const halfSize = opts.thickness * 0.44;
  // Clamp tilt to [24°..66°]; default 45° gives a pure square cross-section (wr === wn)
  // where both 3D contours AND surface shading normals weld with zero discontinuity!
  const tiltDeg = Math.max(24, Math.min(66, opts.tilt));
  const tiltRad = (tiltDeg * Math.PI) / 180;
  const rollRad = (opts.roll * Math.PI) / 180;

  const cosTilt = Math.cos(tiltRad);
  const sinTilt = Math.sin(tiltRad);
  const cosRoll = Math.cos(rollRad);
  const sinRoll = Math.sin(rollRad);

  // Matching wr * cos(tilt) === wn * sin(tilt) keeps all 3 contour lines welded across the split
  // for every Tilt angle, reducing to wr === wn === halfSize at default Tilt = 45°.
  const diag = halfSize * Math.SQRT2;
  const wr = diag * sinTilt;
  const wn = diag * cosTilt;

  // Screen basis: u along major axis (roll), v along minor axis (roll + 90°), z toward sweet-spot camera.
  const uX = cosRoll;
  const uY = sinRoll;
  const vX = -sinRoll;
  const vY = cosRoll;

  // Sweet-spot C^inf ribbon bevel angle so shading has zero flat-to-curved Mach band or Tilt step across [0, 0.5]
  const sweetTiltRad = (24 * Math.PI) / 180;
  const cosSweet = Math.cos(sweetTiltRad);
  const sinSweet = Math.sin(sweetTiltRad);

  // Unwrapped C^inf ribbon normal: evaluates without modulo wrap so inner (`w=0`) and outer (`w=4`)
  // walls + their adjacent 45° chamfers (`w=1, 3`) stay C^inf smooth across s = 0, 0.25, 0.5, and 0.75!
  const evalUnwrappedRibbon = (isRibbonB, tauUnwrapped, dst) => {
    const phi = Math.PI * tauUnwrapped;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const nu = isRibbonB ? -sp : sp;
    const nv = (isRibbonB ? 1 : -1) * cp * sinSweet;
    const nz = cp * cosSweet;
    dst.set(nu * uX + nv * vX, nu * uY + nv * vY, nz).normalize();
  };

  const _sweetFront = new Vector3();
  const _sweetOuter = new Vector3();
  const _sweetInner = new Vector3();
  const _sweetBev1 = new Vector3();
  const _sweetBev3 = new Vector3();
  const chamfer = Math.max(0, Math.min(0.45, opts.chamfer || 0));

  const loop = {
    isRing: true,
    segments: opts.segments,
    gap: opts.gap,
    steps: 14,
    continuousSteps: 192,
    splits: [0, 0.5],
    chamfer,
    ringCount: chamfer > 1e-4 ? 8 : 4,
    collarS: (chamfer * halfSize) / (TAU * radius),
    smoothPortalNormals: false,
    sample(s, side, out) {
      let f = (s + side * 1e-8) % 1;
      if (f < 0) f += 1;
      const isSecondHalf = f >= 0.5;

      // Exact unwrapped local parameter in [0, 0.5] on the active untwisted half
      const base = isSecondHalf ? 0.5 : 0;
      let local = s - Math.floor(s - base + 1e-7) - base;
      local = Math.max(0, Math.min(0.5, local));

      // theta in [-pi/2, +pi/2] around the untwisted tilted half-ring
      const theta = -Math.PI * 0.5 + TAU * local;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Half 2 is rotated 180° around +Z: (u, v, z) -> (-u, -v, +z) (proper SO(3) rotation, det = +1)
      const xySign = isSecondHalf ? -1 : 1;

      const ru = xySign * cosT;
      const rv = xySign * sinT * cosTilt;
      const rz = -sinT * sinTilt;

      const nu = 0;
      const nv = xySign * sinTilt;
      const nz = cosTilt;

      const rx = ru * uX + rv * vX;
      const ry = ru * uY + rv * vY;
      const nx = nu * uX + nv * vX;
      const ny = nu * uY + nv * vY;

      out.pos.set(radius * rx, radius * ry, radius * rz);
      // Right-handed untwisted cross-section: (a x b) . T > 0
      out.a.set(wn * nx, wn * ny, wn * nz);
      out.b.set(wr * rx, wr * ry, wr * rz);
    },
    sampleWallNormals(s, side, offAxisBlend, geomNormals, outNormals, ringCount = 4) {
      if (offAxisBlend >= 0.999) {
        for (let w = 0; w < ringCount; w++) outNormals[w].copy(geomNormals[w]);
        return;
      }
      let f = (s + side * 1e-8) % 1;
      if (f < 0) f += 1;
      const isSecondHalf = f >= 0.5;
      const base = isSecondHalf ? 0.5 : 0;
      let local = s - Math.floor(s - base + 1e-7) - base;
      local = Math.max(0, Math.min(0.5, local));

      const frontIsB = !isSecondHalf;
      const sideIsB = isSecondHalf;
      evalUnwrappedRibbon(frontIsB, local - 0.25, _sweetFront);
      evalUnwrappedRibbon(sideIsB, local + 0.25, _sweetOuter);
      evalUnwrappedRibbon(sideIsB, local - 0.75, _sweetInner);

      if (ringCount === 8) {
        const theta = -Math.PI * 0.5 + TAU * local;
        const t = 0.5 * (1 + Math.sin(theta));
        _sweetBev1.copy(_sweetFront).addScaledVector(_sweetInner, t).normalize();
        _sweetBev3.copy(_sweetFront).addScaledVector(_sweetOuter, 1 - t).normalize();

        for (let w = 0; w < 8; w++) {
          const g = geomNormals[w];
          if (w >= 5) {
            outNormals[w].copy(g);
          } else {
            const sw =
              w === 0
                ? _sweetInner
                : w === 1
                  ? _sweetBev1
                  : w === 2
                    ? _sweetFront
                    : w === 3
                      ? _sweetBev3
                      : _sweetOuter;
            outNormals[w].copy(sw).lerp(g, offAxisBlend).normalize();
          }
        }
        return;
      }

      // 4-wall unchamfered mode: w = 0 (-b inner), w = 1 (+a front), w = 2 (+b outer), w = 3 (-a back)
      for (let w = 0; w < 4; w++) {
        const g = geomNormals[w];
        if (w === 3) {
          outNormals[w].copy(g);
        } else {
          const sw = w === 0 ? _sweetInner : w === 1 ? _sweetFront : _sweetOuter;
          outNormals[w].copy(sw).lerp(g, offAxisBlend).normalize();
        }
      }
    },
    sampleCapNormal(s, _isEndCap, offAxisBlend, geomCapNormal, outCapNormal) {
      if (offAxisBlend >= 0.999) {
        outCapNormal.copy(geomCapNormal);
        return;
      }
      // Keep narrow radial slots softly recessed on both halves from the sweet spot so Half 2 caps don't catch glare
      const gu = geomCapNormal.x * uX + geomCapNormal.y * uY;
      const gv = geomCapNormal.x * vX + geomCapNormal.y * vY;
      const su = gu * 0.55;
      const sv = -Math.abs(gv) * 0.55;
      const sz = Math.max(0.18, Math.abs(geomCapNormal.z) * 0.42);
      outCapNormal
        .set(su * uX + sv * vX, su * uY + sv * vY, sz)
        .normalize()
        .lerp(geomCapNormal, offAxisBlend)
        .normalize();
    },
  };

  return { loops: [loop] };
}

// -----------------------------------------------------------------------------
// 2. Fernando Cortell's Impossible Figure-8 (Reference 2):
//    Untwisted flat circular front faces merging at the waist while the 3D side-walls
//    flip from lower-left (x < 0) to upper-right (x > 0) across the sightline split.
// -----------------------------------------------------------------------------

function circularFig8Frame2D(f, figR) {
  let u = f % 1;
  if (u < 0) u += 1;
  if (u < 0.25) {
    const a = 4 * Math.PI * u;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    return [figR * sa, figR + figR * ca, ca, -sa];
  }
  if (u < 0.75) {
    const b = 4 * Math.PI * (u - 0.25);
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    return [-figR * sb, -figR + figR * cb, -cb, -sb];
  }
  const a = Math.PI + 4 * Math.PI * (u - 0.75);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [figR * sa, figR + figR * ca, ca, -sa];
}

function buildFigure8(opts) {
  const figR = 0.63 * opts.radius;
  const halfW = opts.thickness * 0.37;
  const halfD = opts.thickness * 0.30;

  // Tilt scales the impossible side-wall bevel extrusion; Roll rotates the sculpture in screen space.
  const bevelScale = 0.42 + ((opts.tilt - 24) / 42) * 0.38;
  const leanX = opts.thickness * 0.52 * bevelScale;
  const leanY = opts.thickness * 0.24 * bevelScale;

  // Subtle screen-plane roll offset relative to default Roll = 53° so default Figure-8 stands upright.
  const screenRollRad = (((opts.roll - 53) * 0.65) * Math.PI) / 180;
  const cr = Math.cos(screenRollRad);
  const sr = Math.sin(screenRollRad);

  // Symmetric depth profile centered at z = 0: front waist (u = 0.25) clears back waist (u = 0.75),
  // with a sightline portal jump at s = 0/1 at the top arch.
  const zAmp = Math.max(0.45, halfD * 2.8);
  const splitJump = 0.64;
  const chamfer = Math.max(0, Math.min(0.45, opts.chamfer || 0));

  const loop = {
    segments: Math.max(8, Math.round(opts.segments * 1.6)),
    gap: opts.gap,
    steps: 14,
    continuousSteps: 216,
    splits: [0],
    chamfer,
    ringCount: chamfer > 1e-4 ? 8 : 4,
    collarS: (chamfer * 0.5 * (halfW + halfD)) / (4 * Math.PI * figR),
    smoothPortalNormals: true,
    curveShadow: {
      mode: 1,
      r0: figR,
      r1: splitJump,
      halfW,
      halfD,
      leanX,
      leanY,
      cr,
      sr,
      zAmp,
      chamfer,
    },
    sample(s, side, out) {
      const probe = ((s + side * 1e-8) % 1 + 1) % 1;
      let u = s - Math.floor(s + 1e-7);
      if (probe > 0.5 && u < 0.2) u += 1;
      if (probe < 0.5 && u > 0.8) u -= 1;
      u = Math.max(0, Math.min(1, u));

      const [x0, y0, tx0, ty0] = circularFig8Frame2D(u, figR);
      const nx0 = -ty0;
      const ny0 = tx0;

      // Opposite 3D bevel shift: (-leanX, -leanY) on left (x < 0), (+leanX, +leanY) on right (x > 0)
      const xNorm = x0 / Math.max(1e-4, figR);
      const bx = leanX * xNorm;
      const by = leanY * xNorm;

      // Front (+b): pos_xy + b_xy === (x0, y0) (exact pure circle!)
      // Back  (-b): pos_xy - b_xy === (x0 + bx, y0 + by) (left wall down-left, right wall up-right!)
      const pxL = x0 + 0.5 * bx;
      const pyL = y0 + 0.5 * by;
      const axL = nx0 * halfW;
      const ayL = ny0 * halfW;
      const bxL = -0.5 * bx;
      const byL = -0.5 * by;

      const z = zAmp * Math.sin(TAU * u) + splitJump * (0.5 - u);

      out.pos.set(pxL * cr - pyL * sr, pxL * sr + pyL * cr, z);
      out.a.set(axL * cr - ayL * sr, axL * sr + ayL * cr, 0);
      out.b.set(bxL * cr - byL * sr, bxL * sr + byL * cr, halfD);
    },
  };

  return { loops: [loop] };
}

// -----------------------------------------------------------------------------
// 3–13. Isometric / Trimetric Cube-Lattice Impossible Beams:
//       100% untwisted orthogonal 3D square beams along orthonormal triad (E0, E1, E2)
//       with sharp 90° mitered L-corners, coplanar Penrose strips, square block end-caps,
//       and exact sightline closure (-E0.z)*E0 + (-E1.z)*E1 + (-E2.z)*E2 === (0, 0, -1).
// -----------------------------------------------------------------------------

function makeCubeLatticeBasis(tiltDeg, rollDeg, yawDeg = 45) {
  // Map UI Tilt [24..66] (default 45) smoothly around true isometric pitch 35.264°
  const pitchDeg = ISO_PITCH_DEG + (tiltDeg - 45) * 0.42;
  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;

  // Build standard isometric basis first, then rotate around +Z so E0_xy is at angle `rollDeg`
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);

  const raw = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ].map(([vx, vy, vz]) => {
    const x1 = cy * vx + sy * vz;
    const y1 = vy;
    const z1 = -sy * vx + cy * vz;
    return [x1, cp * y1 - sp * z1, sp * y1 + cp * z1];
  });

  // Flip any raw axis with z > 0 so all three E[0], E[1], E[2] recede in -Z (E_i.z < 0)
  for (let i = 0; i < 3; i++) {
    if (raw[i][2] > 0) {
      raw[i][0] = -raw[i][0];
      raw[i][1] = -raw[i][1];
      raw[i][2] = -raw[i][2];
    }
  }

  // Sort / rotate in +Z so E[0]'s XY projection sits at angle `rollDeg`, with E[0], E[1], E[2] in CCW 120° order
  const a0 = Math.atan2(raw[0][1], raw[0][0]);
  const targetRad = (rollDeg * Math.PI) / 180;
  const dAng = targetRad - a0;
  const cd = Math.cos(dAng);
  const sd = Math.sin(dAng);

  const E = raw.map(([rx, ry, rz]) => [rx * cd - ry * sd, rx * sd + ry * cd, rz]);
  // Ensure CCW screen order (E[0] -> E[1] -> E[2] around +Z)
  const cross01 = E[0][0] * E[1][1] - E[0][1] * E[1][0];
  if (cross01 < 0) {
    const tmp = E[1];
    E[1] = E[2];
    E[2] = tmp;
  }

  // Exact trimetric step weights so sum_i w[i] * E[i] === (0, 0, -sqrt(3)) for EVERY Tilt & Roll!
  const weights = E.map((e) => (-e[2]) / S13);
  return { E, weights };
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// Builds an untwisted 3D orthogonal cube-lattice loop with hinged 90° mitered corners and sightline portals.
// `bars`: array of [axisIdx, sign, nomLen]
// `portals`: sorted array of [barIdx, fracInBar, nomJumpZ] (portals[0] becomes parameter s = 0!)
function createCubeLatticeLoop({
  bars,
  portals,
  basis,
  halfSize,
  chamfer = 0,
  trimCornerVertical = false,
  trimCornerAxisFn = null,
  threeWayCornerFn = null,
  selfCrossings = false,
  segments,
  gap,
  phaseOffset = 0,
  xyOffset = null,
  zInit = 0,
}) {
  const { E, weights } = basis;
  const numBars = bars.length;

  // Compute scaled 3D bar lengths and unit tangents
  const tangs = [];
  const lens = [];
  for (let i = 0; i < numBars; i++) {
    const [ax, sg, nomLen] = bars[i];
    const e = E[ax];
    tangs.push([sg * e[0], sg * e[1], sg * e[2]]);
    lens.push(nomLen * weights[ax]);
  }

  // Compute 2D vertex centroid (without portals) if xyOffset is not given, so single-loop shapes auto-center cleanly
  let startX = 0;
  let startY = 0;
  if (xyOffset) {
    startX = xyOffset[0];
    startY = xyOffset[1];
  } else {
    let px = 0;
    let py = 0;
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (let i = 0; i < numBars; i++) {
      px += lens[i] * tangs[i][0];
      py += lens[i] * tangs[i][1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    startX = -0.5 * (minX + maxX);
    startY = -0.5 * (minY + maxY);
  }

  // Propagate right-handed orthogonal square cross-section offsets `barDeltas[i][0..3]` around the bars
  const ax0 = bars[0][0];
  let U = E[(ax0 + 1) % 3];
  let V = E[(ax0 + 2) % 3];
  if (dot3(cross3(U, V), tangs[0]) < 0) {
    const tmp = U;
    U = V;
    V = tmp;
  }

  let minBarLen = Infinity;
  for (let i = 0; i < numBars; i++) {
    if (lens[i] < minBarLen) minBarLen = lens[i];
  }
  const h = Math.min(halfSize, minBarLen * 0.43);
  const ch = Math.max(0, Math.min(0.45, chamfer));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;
  const barDeltas = new Array(numBars);
  if (useOct) {
    const k1 = 1 - ch;
    barDeltas[0] = [
      [h * (-k1 * U[0] - V[0]), h * (-k1 * U[1] - V[1]), h * (-k1 * U[2] - V[2])],
      [h * (k1 * U[0] - V[0]), h * (k1 * U[1] - V[1]), h * (k1 * U[2] - V[2])],
      [h * (U[0] - k1 * V[0]), h * (U[1] - k1 * V[1]), h * (U[2] - k1 * V[2])],
      [h * (U[0] + k1 * V[0]), h * (U[1] + k1 * V[1]), h * (U[2] + k1 * V[2])],
      [h * (k1 * U[0] + V[0]), h * (k1 * U[1] + V[1]), h * (k1 * U[2] + V[2])],
      [h * (-k1 * U[0] + V[0]), h * (-k1 * U[1] + V[1]), h * (-k1 * U[2] + V[2])],
      [h * (-U[0] + k1 * V[0]), h * (-U[1] + k1 * V[1]), h * (-U[2] + k1 * V[2])],
      [h * (-U[0] - k1 * V[0]), h * (-U[1] - k1 * V[1]), h * (-U[2] - k1 * V[2])],
    ];
  } else {
    barDeltas[0] = [
      [h * (-U[0] - V[0]), h * (-U[1] - V[1]), h * (-U[2] - V[2])],
      [h * (U[0] - V[0]), h * (U[1] - V[1]), h * (U[2] - V[2])],
      [h * (U[0] + V[0]), h * (U[1] + V[1]), h * (U[2] + V[2])],
      [h * (-U[0] + V[0]), h * (-U[1] + V[1]), h * (-U[2] + V[2])],
    ];
  }

  for (let i = 0; i < numBars - 1; i++) {
    const Ti = tangs[i];
    const Tn = tangs[i + 1];
    const prevD = barDeltas[i];
    const nextD = new Array(ringCount);
    for (let c = 0; c < ringCount; c++) {
      const d = prevD[c];
      const proj = dot3(d, Tn);
      nextD[c] = [
        d[0] - proj * (Tn[0] + Ti[0]),
        d[1] - proj * (Tn[1] + Ti[1]),
        d[2] - proj * (Tn[2] + Ti[2]),
      ];
    }
    barDeltas[i + 1] = nextD;
  }

  // Decompose the closed bar cycle into linear sub-segments split at `portals`, then cyclically rotate
  // the sub-segment list so `portals[0]` is at global s = 0!
  const portalMap = new Map();
  for (let pi = 0; pi < portals.length; pi++) {
    const [bi, fr, nomJz] = portals[pi];
    if (!portalMap.has(bi)) portalMap.set(bi, []);
    portalMap.get(bi).push({ frac: fr, jz: nomJz * Math.sqrt(3), idx: pi });
  }

  const rawSpans = [];
  let cx = startX;
  let cy = startY;
  let cz = zInit;
  let firstPortalSpanIdx = 0;

  for (let bi = 0; bi < numBars; bi++) {
    const T = tangs[bi];
    const L = lens[bi];
    const cuts = portalMap.get(bi);
    if (cuts) cuts.sort((a, b) => a.frac - b.frac);

    let fPrev = 0;
    const numCuts = cuts ? cuts.length : 0;
    for (let ci = 0; ci <= numCuts; ci++) {
      const fNext = ci < numCuts ? cuts[ci].frac : 1;
      const segLen = (fNext - fPrev) * L;
      const p0 = [cx, cy, cz];
      const p1 = [cx + segLen * T[0], cy + segLen * T[1], cz + segLen * T[2]];

      rawSpans.push({
        barIdx: bi,
        p0,
        p1,
        len: segLen,
        T,
        Tprev: fPrev === 0 ? tangs[(bi + numBars - 1) % numBars] : null,
        Tnext: fNext === 1 ? tangs[(bi + 1) % numBars] : null,
        deltas: barDeltas[bi],
        startsAtPortal: fPrev > 0,
        endsAtPortal: fNext < 1,
      });

      cx = p1[0];
      cy = p1[1];
      cz = p1[2];
      if (ci < numCuts) {
        cz += cuts[ci].jz;
        if (cuts[ci].idx === 0) {
          firstPortalSpanIdx = rawSpans.length;
        }
      }
      fPrev = fNext;
    }
  }

  // Center single-loop sculptures around Z = 0 so 3D camera orbiting pivots cleanly around the origin
  if (!xyOffset) {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < rawSpans.length; k++) {
      minZ = Math.min(minZ, rawSpans[k].p0[2], rawSpans[k].p1[2]);
      maxZ = Math.max(maxZ, rawSpans[k].p0[2], rawSpans[k].p1[2]);
    }
    const zMid = 0.5 * (minZ + maxZ);
    for (let k = 0; k < rawSpans.length; k++) {
      rawSpans[k].p0[2] -= zMid;
      rawSpans[k].p1[2] -= zMid;
    }
  }

  // Rotate rawSpans so firstPortalSpanIdx sits at s = 0; propagate deltas cleanly across bar numBars-1 -> 0!
  const ordered = [];
  for (let k = 0; k < rawSpans.length; k++) {
    ordered.push({ ...rawSpans[(firstPortalSpanIdx + k) % rawSpans.length] });
  }

  // Re-propagate `deltas` sequentially along `ordered` so every continuous 3D corner inside a portal piece
  // uses identical rail slot indices before & after the wrap bar numBars-1 -> 0!
  let curDeltas = ordered[0].deltas.map((d) => [...d]);
  for (let k = 0; k < ordered.length; k++) {
    ordered[k].deltas = curDeltas;
    if (k + 1 < ordered.length) {
      if (ordered[k].endsAtPortal) {
        // Keep a clean right-handed basis on the same bar across a midpoint portal
        curDeltas = curDeltas.map((d) => [...d]);
      } else if (ordered[k].Tnext) {
        const Ti = ordered[k].T;
        const Tn = ordered[k + 1].T;
        curDeltas = curDeltas.map((d) => {
          const proj = dot3(d, Tn);
          return [
            d[0] - proj * (Tn[0] + Ti[0]),
            d[1] - proj * (Tn[1] + Ti[1]),
            d[2] - proj * (Tn[2] + Ti[2]),
          ];
        });
      }
    }
  }

  // Assign global arc-length fractions s in [0, 1] and precompute exact corner & hinge stations
  let totalLen = 0;
  for (let k = 0; k < ordered.length; k++) totalLen += ordered[k].len;

  const splits = [0];
  const corners = [];
  const threeWayCorners = [];
  const hinges = [];
  let acc = 0;

  const resolveTrimAxis =
    trimCornerAxisFn || (trimCornerVertical ? () => 2 : null);

  const bevelMiterPt = (pBase, d, Tother, Tself, trimAxis = -1) => {
    const proj = dot3(d, Tother);
    let mx = d[0] - proj * Tself[0];
    let my = d[1] - proj * Tself[1];
    let mz = d[2] - proj * Tself[2];
    if (trimAxis >= 0 && ch > 1e-4) {
      const a1 = (trimAxis + 1) % 3;
      const a2 = (trimAxis + 2) % 3;
      const da = mx * E[a1][0] + my * E[a1][1] + mz * E[a1][2];
      const db = mx * E[a2][0] + my * E[a2][1] + mz * E[a2][2];
      const excess = Math.abs(da) + Math.abs(db) - (2 - ch) * h;
      if (excess > 1e-6) {
        const pullA = 0.5 * excess * (da >= 0 ? 1 : -1);
        const pullB = 0.5 * excess * (db >= 0 ? 1 : -1);
        mx -= pullA * E[a1][0] + pullB * E[a2][0];
        my -= pullA * E[a1][1] + pullB * E[a2][1];
        mz -= pullA * E[a1][2] + pullB * E[a2][2];
      }
    }
    return [pBase[0] + mx, pBase[1] + my, pBase[2] + mz];
  };

  const threeWayMiterPt = (pBase, d, TselfOut, TotherOut, TthirdOut) => {
    const u0 = Math.max(dot3(d, TotherOut), dot3(d, TthirdOut));
    return [
      pBase[0] + d[0] + u0 * TselfOut[0],
      pBase[1] + d[1] + u0 * TselfOut[1],
      pBase[2] + d[2] + u0 * TselfOut[2],
    ];
  };

  for (let k = 0; k < ordered.length; k++) {
    const sp = ordered[k];
    sp.s0 = acc / totalLen;
    acc += sp.len;
    sp.s1 = acc / totalLen;

    const hClamped = Math.min(h, sp.len * 0.45);
    sp.uLo = sp.Tprev ? hClamped : 0;
    sp.uHi = sp.Tnext ? sp.len - hClamped : sp.len;

    if (sp.Tprev) {
      const Tthird = threeWayCornerFn ? threeWayCornerFn(sp.barIdx) : null;
      if (Tthird) {
        const prevOut = [-sp.Tprev[0], -sp.Tprev[1], -sp.Tprev[2]];
        sp.qStart = sp.deltas.map((d) => threeWayMiterPt(sp.p0, d, sp.T, prevOut, Tthird));
      } else {
        const trimAx = resolveTrimAxis ? resolveTrimAxis(sp.barIdx) : -1;
        sp.qStart = sp.deltas.map((d) => bevelMiterPt(sp.p0, d, sp.Tprev, sp.T, trimAx));
      }
      const sHinge = sp.s0 + sp.uLo / totalLen;
      if (sHinge > 1e-5 && sHinge < 1 - 1e-5) hinges.push(sHinge);
    }

    if (sp.Tnext) {
      const nextBarIdx = (sp.barIdx + 1) % numBars;
      const Tthird = threeWayCornerFn ? threeWayCornerFn(nextBarIdx) : null;
      if (Tthird) {
        const selfOut = [-sp.T[0], -sp.T[1], -sp.T[2]];
        sp.qEnd = sp.deltas.map((d) => threeWayMiterPt(sp.p1, d, selfOut, sp.Tnext, Tthird));
      } else {
        const trimAx = resolveTrimAxis ? resolveTrimAxis(nextBarIdx) : -1;
        sp.qEnd = sp.deltas.map((d) => bevelMiterPt(sp.p1, d, sp.Tnext, sp.T, trimAx));
      }
      const sHinge = sp.s0 + sp.uHi / totalLen;
      if (sHinge > 1e-5 && sHinge < 1 - 1e-5) hinges.push(sHinge);
      if (sp.s1 > 1e-5 && sp.s1 < 1 - 1e-5) {
        corners.push(sp.s1);
        if (Tthird) threeWayCorners.push(sp.s1);
      }
    } else if (sp.endsAtPortal && k + 1 < ordered.length) {
      splits.push(sp.s1);
    }
  }

  // Group spans into continuous portal pieces so `(s, side)` resolves unambiguously at every portal boundary
  const pieces = [];
  let pieceStartIdx = 0;
  for (let k = 0; k < ordered.length; k++) {
    if (ordered[k].endsAtPortal || k === ordered.length - 1) {
      pieces.push({
        sStart: ordered[pieceStartIdx].s0,
        sEnd: ordered[k].s1,
        firstSpan: pieceStartIdx,
        lastSpan: k,
      });
      pieceStartIdx = k + 1;
    }
  }

  const evalSpanAt = (sp, f, dst) => {
    const spanFrac = sp.s1 > sp.s0 ? Math.max(0, Math.min(1, (f - sp.s0) / (sp.s1 - sp.s0))) : 0;
    const u = spanFrac * sp.len;
    const { p0, T, deltas } = sp;

    if (sp.Tprev && u < sp.uLo && sp.uLo > 1e-8) {
      const t = u / sp.uLo;
      const bx = p0[0] + sp.uLo * T[0];
      const by = p0[1] + sp.uLo * T[1];
      const bz = p0[2] + sp.uLo * T[2];
      for (let c = 0; c < ringCount; c++) {
        const q = sp.qStart[c];
        const d = deltas[c];
        dst[c].set(
          q[0] + (bx + d[0] - q[0]) * t,
          q[1] + (by + d[1] - q[1]) * t,
          q[2] + (bz + d[2] - q[2]) * t,
        );
      }
      return;
    }

    if (sp.Tnext && u > sp.uHi && sp.len - sp.uHi > 1e-8) {
      const t = (u - sp.uHi) / (sp.len - sp.uHi);
      const bx = p0[0] + sp.uHi * T[0];
      const by = p0[1] + sp.uHi * T[1];
      const bz = p0[2] + sp.uHi * T[2];
      for (let c = 0; c < ringCount; c++) {
        const q = sp.qEnd[c];
        const d = deltas[c];
        const sx = bx + d[0];
        const sy = by + d[1];
        const sz = bz + d[2];
        dst[c].set(
          sx + (q[0] - sx) * t,
          sy + (q[1] - sy) * t,
          sz + (q[2] - sz) * t,
        );
      }
      return;
    }

    const px = p0[0] + u * T[0];
    const py = p0[1] + u * T[1];
    const pz = p0[2] + u * T[2];
    for (let c = 0; c < ringCount; c++) {
      const d = deltas[c];
      dst[c].set(px + d[0], py + d[1], pz + d[2]);
    }
  };

  // Prebuild unbroken pre-portal continuation chains and vertical +Z sightline cut planes for every portal.
  // Any block near a portal is built as a single unbroken 3D prism and Sutherland-Hodgman clipped against
  // d(x, y) = (x - cx)*ux + (y - cy)*uy = 0 (with +jz applied strictly to d >= 0), eliminating overhang Z-bleed.
  const overhangS = Math.min(0.14, (1.55 * h) / Math.max(1e-5, totalLen));
  const portalZones = [];

  for (let pi = 0; pi < pieces.length; pi++) {
    const sCut = splits[pi];
    const prevPiece = pieces[(pi - 1 + pieces.length) % pieces.length];
    const nextPiece = pieces[pi];
    const spPrev = ordered[prevPiece.lastSpan];
    const spNext = ordered[nextPiece.firstSpan];

    const cxP = spPrev.p1[0];
    const cyP = spPrev.p1[1];
    const jz = spNext.p0[2] - spPrev.p1[2];
    const tXY = Math.hypot(spPrev.T[0], spPrev.T[1]) || 1;
    const ux = spPrev.T[0] / tXY;
    const uy = spPrev.T[1] / tXY;

    const chain = [];
    const chainCorners = [];
    const chainThreeWayCorners = [];
    const chainHinges = [];
    const sShiftPrev = pi === 0 ? -1 : 0;

    for (let k = prevPiece.firstSpan; k <= prevPiece.lastSpan; k++) {
      const src = ordered[k];
      const s0 = src.s0 + sShiftPrev;
      const s1 = src.s1 + sShiftPrev;
      chain.push({ ...src, s0, s1 });
      if (src.Tprev) chainHinges.push(s0 + src.uLo / totalLen);
      if (src.Tnext) {
        const nextBarIdx = (src.barIdx + 1) % numBars;
        chainHinges.push(s0 + src.uHi / totalLen);
        chainCorners.push(s1);
        if (threeWayCornerFn && threeWayCornerFn(nextBarIdx)) {
          chainThreeWayCorners.push(s1);
        }
      }
    }

    let chainDeltas = spPrev.deltas.map((d) => [...d]);
    for (let k = nextPiece.firstSpan; k <= nextPiece.lastSpan; k++) {
      const src = ordered[k];
      const p0 = [src.p0[0], src.p0[1], src.p0[2] - jz];
      const p1 = [src.p1[0], src.p1[1], src.p1[2] - jz];
      const deltas = chainDeltas;

      let qStart = null;
      if (src.Tprev) {
        const Tthird = threeWayCornerFn ? threeWayCornerFn(src.barIdx) : null;
        if (Tthird) {
          const prevOut = [-src.Tprev[0], -src.Tprev[1], -src.Tprev[2]];
          qStart = deltas.map((d) => threeWayMiterPt(p0, d, src.T, prevOut, Tthird));
        } else {
          const trimAx = resolveTrimAxis ? resolveTrimAxis(src.barIdx) : -1;
          qStart = deltas.map((d) => bevelMiterPt(p0, d, src.Tprev, src.T, trimAx));
        }
        chainHinges.push(src.s0 + src.uLo / totalLen);
      }

      let qEnd = null;
      if (src.Tnext) {
        const nextBarIdx = (src.barIdx + 1) % numBars;
        const Tthird = threeWayCornerFn ? threeWayCornerFn(nextBarIdx) : null;
        if (Tthird) {
          const selfOut = [-src.T[0], -src.T[1], -src.T[2]];
          qEnd = deltas.map((d) => threeWayMiterPt(p1, d, selfOut, src.Tnext, Tthird));
        } else {
          const trimAx = resolveTrimAxis ? resolveTrimAxis(nextBarIdx) : -1;
          qEnd = deltas.map((d) => bevelMiterPt(p1, d, src.Tnext, src.T, trimAx));
        }
        chainHinges.push(src.s0 + src.uHi / totalLen);
        chainCorners.push(src.s1);
        if (Tthird) chainThreeWayCorners.push(src.s1);
      }

      chain.push({
        ...src,
        p0,
        p1,
        deltas,
        qStart,
        qEnd,
      });

      if (k < nextPiece.lastSpan && src.Tnext) {
        const Ti = src.T;
        const Tn = ordered[k + 1].T;
        chainDeltas = chainDeltas.map((d) => {
          const proj = dot3(d, Tn);
          return [
            d[0] - proj * (Tn[0] + Ti[0]),
            d[1] - proj * (Tn[1] + Ti[1]),
            d[2] - proj * (Tn[2] + Ti[2]),
          ];
        });
      }
    }

    const sMin = chain[0].s0;
    const sMax = chain[chain.length - 1].s1;
    const guardBeforeS = Math.max(0.012, spPrev.s1 - spPrev.s0 - 2e-4);
    const guardAfterS = Math.max(0.012, spNext.s1 - spNext.s0 - 2e-4);

    portalZones.push({
      sCut,
      cx: cxP,
      cy: cyP,
      ux,
      uy,
      jz,
      overhangS,
      guardBeforeS,
      guardAfterS,
      corners: chainCorners,
      threeWayCorners: chainThreeWayCorners,
      hinges: chainHinges,
      sampleUnbrokenCorners(sLocal, side, dst4) {
        const f = Math.max(sMin, Math.min(sMax, sLocal));
        const probe = Math.max(sMin, Math.min(sMax, sLocal + side * 1e-7));
        let sp = chain[chain.length - 1];
        for (let k = 0; k < chain.length; k++) {
          if (probe <= chain[k].s1 + 1e-9) {
            sp = chain[k];
            break;
          }
        }
        evalSpanAt(sp, f, dst4);
      },
    });
  }

  const hasRealPortal = portals.some((p) => Math.abs(p[2]) > 1e-7);

  return {
    segments,
    gap,
    phaseOffset,
    steps: 8,
    continuousSteps: 48,
    chamfer: ch,
    ringCount,
    collarS: (ch * h) / Math.max(1e-5, totalLen),
    unbrokenClosed: !hasRealPortal,
    splits: hasRealPortal ? splits : [],
    corners,
    threeWayCorners,
    hinges,
    portalZones: hasRealPortal ? portalZones : [],
    selfCrossings: Boolean(selfCrossings),
    flatShaded: true,
    smoothPortalNormals: false,
    sampleCorners(s, side, dst4) {
      let probe = (s + side * 1e-7) % 1;
      if (probe < 0) probe += 1;

      let piece = pieces[pieces.length - 1];
      for (let pi = 0; pi < pieces.length; pi++) {
        if (probe <= pieces[pi].sEnd + 1e-9) {
          piece = pieces[pi];
          break;
        }
      }

      // Exact un-nudged coordinate inside [piece.sStart, piece.sEnd] (preserving s = piece.sEnd = 1.0!)
      const laps = Math.round(s + side * 1e-7 - probe);
      let f = s - laps;
      if (f < piece.sStart) f = piece.sStart;
      if (f > piece.sEnd) f = piece.sEnd;

      let sp = ordered[piece.lastSpan];
      for (let k = piece.firstSpan; k <= piece.lastSpan; k++) {
        if (f <= ordered[k].s1 + 1e-9) {
          sp = ordered[k];
          break;
        }
      }

      evalSpanAt(sp, f, dst4);
    },
  };
}

// 3. Penrose Triangle (Reference 3, Row 1 Col 2)
function buildTriangle(opts) {
  const L = opts.radius * 2.55;
  const halfSize = opts.thickness * 0.42;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, L],
      [1, 1, L],
      [2, 1, L],
    ],
    portals: [[0, 0.5, L]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(4, opts.segments),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 4. Impossible Frame (Reference 3, Row 3 Col 4 & 5 — 4-bar trapezoidal Penrose frame)
function buildFrame(opts) {
  const shortSide = opts.radius * 1.28;
  const diagSide = opts.radius * 1.68;
  const longSide = shortSide + diagSide;
  const halfSize = opts.thickness * 0.38;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll + 37);
  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, longSide],
      [1, 1, diagSide],
      [0, -1, shortSide],
      [2, 1, diagSide],
    ],
    portals: [[0, 0.5, diagSide]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(4, Math.round(opts.segments * 1.1)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 5. Impossible S-Hook (Reference 3, Row 3 Col 3 & Row 4 Col 2 — symmetric 6-bar isometric figure-8)
function buildSHook(opts) {
  const arm = opts.radius * 1.48;
  const halfSize = opts.thickness * 0.34;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const jumpNom = arm * 1.6;
  const loop = createCubeLatticeLoop({
    bars: [
      [2, -1, arm],
      [0, 1, arm],
      [2, 1, arm * 2],
      [0, 1, arm],
      [2, -1, arm],
      [0, -1, arm * 2],
    ],
    portals: [
      [3, 0.5, jumpNom],
      [0, 0.5, -jumpNom],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    selfCrossings: true,
    segments: Math.max(6, Math.round(opts.segments * 1.5)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 6. Impossible Triquetra (Reference 3, Row 2 Col 5 — 9-bar alternating 6-crossing Penrose trefoil)
function buildTriquetra(opts) {
  const s = opts.radius * 1.04;
  const L = 2.4 * s;
  const S = 0.95 * s;
  const M = 1.25 * s;
  const lobeDrop = (L + S + M) / 3;
  const halfSize = opts.thickness * 0.31;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, L], [1, 1, S], [2, 1, M],
      [1, 1, L], [2, 1, S], [0, 1, M],
      [2, 1, L], [0, 1, S], [1, 1, M],
    ],
    portals: [
      [0, 0.8, lobeDrop],
      [3, 0.8, lobeDrop],
      [6, 0.8, lobeDrop],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    selfCrossings: true,
    segments: Math.max(9, Math.round(opts.segments * 1.8)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 7. Impossible Double-Tribar (Interlocking Star-of-David pair of Penrose triangles)
function buildDoubleTribar(opts) {
  const L = opts.radius * 2.55;
  const halfSize = opts.thickness * 0.3;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const { E, weights } = basis;

  // Exact vertex centroids so upright △ and inverted ▽ interlock symmetrically around (0, 0)
  const computeTriStart = (bars) => {
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < 3; i++) {
      sx += x;
      sy += y;
      const [ax, sg, ln] = bars[i];
      x += sg * ln * weights[ax] * E[ax][0];
      y += sg * ln * weights[ax] * E[ax][1];
    }
    return [-sx / 3, -sy / 3];
  };

  const barsA = [
    [0, 1, L],
    [1, 1, L],
    [2, 1, L],
  ];
  const barsB = [
    [0, -1, L],
    [1, -1, L],
    [2, -1, L],
  ];
  const barJump = L / 3;
  const segs = Math.max(6, Math.round(opts.segments * 1.1));

  const loopA = createCubeLatticeLoop({
    bars: barsA,
    portals: [
      [0, 0.5, barJump],
      [1, 0.5, barJump],
      [2, 0.5, barJump],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: segs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: computeTriStart(barsA),
    zInit: 0,
  });

  const loopB = createCubeLatticeLoop({
    bars: barsB,
    portals: [
      [0, 0.17, -barJump],
      [1, 0.17, -barJump],
      [2, 0.17, -barJump],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: segs,
    gap: opts.gap,
    phaseOffset: 0.5 / segs,
    xyOffset: computeTriStart(barsB),
    zInit: L * S13 * 0.35,
  });

  return { loops: [loopA, loopB] };
}

// 8. Impossible Hourglass (Reference 3, Row 4 Col 4 — 4-bar crossed isometric Penrose hourglass)
function buildHourglass(opts) {
  const topBot = opts.radius * 1.38;
  const diag = topBot * 2;
  const halfSize = opts.thickness * 0.34;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const totalNom = (topBot + diag + topBot + diag) / 3;
  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, topBot],
      [1, 1, diag],
      [0, 1, topBot],
      [2, 1, diag],
    ],
    portals: [[0, 0.5, totalNom]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    selfCrossings: true,
    segments: Math.max(6, Math.round(opts.segments * 1.4)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 9. Penrose Staircase (12-bar 4-flight endless ascending orthogonal loop with flat corner landings)
function buildStairs(opts) {
  const s = opts.radius * 0.94;
  const r = 0.44 * s;
  const a = 0.76 * s;
  const b = a + 2 * r;
  const halfSize = opts.thickness * 0.25;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, a], [2, -1, r], [0, 1, a],
      [1, 1, a], [2, -1, r], [1, 1, a],
      [0, -1, b], [2, -1, r], [0, -1, b],
      [1, -1, b], [2, -1, r], [1, -1, b],
    ],
    portals: [[6, 0.5, -4 * r]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(8, Math.round(opts.segments * 1.6)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// Straight open-ended 3D square column [0, 1] with optional sightline portal jumps `[[sCut0, +jz], [sCut1, -jz]]`
function createCubePillarLoop({
  pBot,
  pTop,
  A,
  B,
  U,
  halfSize,
  chamfer = 0,
  portals = [],
  crossOnlyLoop = null,
  weldBridge = false,
  lappedRung = false,
  unwoundWeld = false,
  fixedWorldWeld = false,
  weldStart = false,
  weldEnd = false,
  weldStartTJunctionPerp = null,
  weldEndTJunctionPerp = null,
  weldStart3Way = null,
  weldEnd3Way = null,
  capStartAlways = false,
  capEndAlways = false,
  segments = 4,
  gap = 0.11,
  phaseOffset = 0,
}) {
  let uVec = A;
  let vVec = B;
  if (dot3(cross3(uVec, vVec), U) < 0) {
    const tmp = uVec;
    uVec = vVec;
    vVec = tmp;
  }

  const h = halfSize;
  const ch = Math.max(0, Math.min(0.45, chamfer));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;
  let deltas;
  if (useOct) {
    const k1 = 1 - ch;
    deltas = [
      [h * (-k1 * uVec[0] - vVec[0]), h * (-k1 * uVec[1] - vVec[1]), h * (-k1 * uVec[2] - vVec[2])],
      [h * (k1 * uVec[0] - vVec[0]), h * (k1 * uVec[1] - vVec[1]), h * (k1 * uVec[2] - vVec[2])],
      [h * (uVec[0] - k1 * vVec[0]), h * (uVec[1] - k1 * vVec[1]), h * (uVec[2] - k1 * vVec[2])],
      [h * (uVec[0] + k1 * vVec[0]), h * (uVec[1] + k1 * vVec[1]), h * (uVec[2] + k1 * vVec[2])],
      [h * (k1 * uVec[0] + vVec[0]), h * (k1 * uVec[1] + vVec[1]), h * (k1 * uVec[2] + vVec[2])],
      [h * (-k1 * uVec[0] + vVec[0]), h * (-k1 * uVec[1] + vVec[1]), h * (-k1 * uVec[2] + vVec[2])],
      [h * (-uVec[0] + k1 * vVec[0]), h * (-uVec[1] + k1 * vVec[1]), h * (-uVec[2] + k1 * vVec[2])],
      [h * (-uVec[0] - k1 * vVec[0]), h * (-uVec[1] - k1 * vVec[1]), h * (-uVec[2] - k1 * vVec[2])],
    ];
  } else {
    deltas = [
      [h * (-uVec[0] - vVec[0]), h * (-uVec[1] - vVec[1]), h * (-uVec[2] - vVec[2])],
      [h * (uVec[0] - vVec[0]), h * (uVec[1] - vVec[1]), h * (uVec[2] - vVec[2])],
      [h * (uVec[0] + vVec[0]), h * (uVec[1] + vVec[1]), h * (uVec[2] + vVec[2])],
      [h * (-uVec[0] + vVec[0]), h * (-uVec[1] + vVec[1]), h * (-uVec[2] + vVec[2])],
    ];
  }

  const dx = pTop[0] - pBot[0];
  const dy = pTop[1] - pBot[1];
  const dz = pTop[2] - pBot[2];
  const pillarLen = Math.hypot(dx, dy, dz) || 1;
  const uXY = Math.hypot(dx, dy) || 1;
  const ux = dx / uXY;
  const uy = dy / uXY;
  const overhangS = Math.min(0.18, (1.55 * h) / pillarLen);

  const uUnit = [dx / pillarLen, dy / pillarLen, dz / pillarLen];
  const hasStartMiter = Boolean(weldStartTJunctionPerp || weldStart3Way);
  const hasEndMiter = Boolean(weldEndTJunctionPerp || weldEnd3Way);
  const uStartMiter = hasStartMiter ? Math.min(h, pillarLen * 0.45) : 0;
  const uEndMiter = hasEndMiter ? Math.min(h, pillarLen * 0.45) : 0;
  const fLo = uStartMiter / pillarLen;
  const fHi = 1 - uEndMiter / pillarLen;
  const fCap3 = 2e-4;
  const useStartCap3 = Boolean(weldStart3Way && useOct);
  const useEndCap3 = Boolean(weldEnd3Way && useOct);
  const pillarCorners = [];
  const pillarHinges = [];
  if (useStartCap3) pillarCorners.push(fCap3);
  if (uStartMiter > 1e-5) pillarHinges.push(fLo);
  if (uEndMiter > 1e-5) pillarHinges.push(fHi);
  if (useEndCap3) pillarCorners.push(1 - fCap3);

  const k1Oct = 1 - ch;
  let startCapRail = -1;
  let startInnerRail = -1;
  let cBotCap = null;
  let cBotInner = null;
  if (useStartCap3) {
    const su = dot3(weldStart3Way[0], uVec) + dot3(weldStart3Way[1], uVec) < 0 ? 1 : -1;
    const sv = dot3(weldStart3Way[0], vVec) + dot3(weldStart3Way[1], vVec) < 0 ? 1 : -1;
    startCapRail = su > 0 ? (sv > 0 ? 3 : 1) : sv > 0 ? 5 : 7;
    startInnerRail = (startCapRail + 4) % 8;
    cBotCap = [
      pBot[0] + h * (-uUnit[0] + su * k1Oct * uVec[0] + sv * k1Oct * vVec[0]),
      pBot[1] + h * (-uUnit[1] + su * k1Oct * uVec[1] + sv * k1Oct * vVec[1]),
      pBot[2] + h * (-uUnit[2] + su * k1Oct * uVec[2] + sv * k1Oct * vVec[2]),
    ];
    cBotInner = [
      pBot[0] + h * (k1Oct * uUnit[0] - su * uVec[0] - sv * vVec[0]),
      pBot[1] + h * (k1Oct * uUnit[1] - su * uVec[1] - sv * vVec[1]),
      pBot[2] + h * (k1Oct * uUnit[2] - su * uVec[2] - sv * vVec[2]),
    ];
  }
  let endCapRail = -1;
  let endInnerRail = -1;
  let cTopCap = null;
  let cTopInner = null;
  if (useEndCap3) {
    const su = dot3(weldEnd3Way[0], uVec) + dot3(weldEnd3Way[1], uVec) < 0 ? 1 : -1;
    const sv = dot3(weldEnd3Way[0], vVec) + dot3(weldEnd3Way[1], vVec) < 0 ? 1 : -1;
    endCapRail = su > 0 ? (sv > 0 ? 3 : 1) : sv > 0 ? 5 : 7;
    endInnerRail = (endCapRail + 4) % 8;
    cTopCap = [
      pTop[0] + h * (uUnit[0] + su * k1Oct * uVec[0] + sv * k1Oct * vVec[0]),
      pTop[1] + h * (uUnit[1] + su * k1Oct * uVec[1] + sv * k1Oct * vVec[1]),
      pTop[2] + h * (uUnit[2] + su * k1Oct * uVec[2] + sv * k1Oct * vVec[2]),
    ];
    cTopInner = [
      pTop[0] + h * (-k1Oct * uUnit[0] - su * uVec[0] - sv * vVec[0]),
      pTop[1] + h * (-k1Oct * uUnit[1] - su * uVec[1] - sv * vVec[1]),
      pTop[2] + h * (-k1Oct * uUnit[2] - su * uVec[2] - sv * vVec[2]),
    ];
  }

  const qWeldStart = weldStart3Way
    ? deltas.map((d) => {
        const x0 = Math.max(dot3(d, weldStart3Way[0]), dot3(d, weldStart3Way[1]));
        return [
          pBot[0] + x0 * uUnit[0] + d[0],
          pBot[1] + x0 * uUnit[1] + d[1],
          pBot[2] + x0 * uUnit[2] + d[2],
        ];
      })
    : weldStartTJunctionPerp
      ? deltas.map((d) => {
          const xp = Math.abs(dot3(d, weldStartTJunctionPerp));
          const x0 = Math.min(h, (2 - ch) * h - xp);
          return [
            pBot[0] + x0 * uUnit[0] + d[0],
            pBot[1] + x0 * uUnit[1] + d[1],
            pBot[2] + x0 * uUnit[2] + d[2],
          ];
        })
      : null;
  const qWeldEnd = weldEnd3Way
    ? deltas.map((d) => {
        const x0 = Math.max(dot3(d, weldEnd3Way[0]), dot3(d, weldEnd3Way[1]));
        return [
          pTop[0] - x0 * uUnit[0] + d[0],
          pTop[1] - x0 * uUnit[1] + d[1],
          pTop[2] - x0 * uUnit[2] + d[2],
        ];
      })
    : weldEndTJunctionPerp
      ? deltas.map((d) => {
          const xp = Math.abs(dot3(d, weldEndTJunctionPerp));
          const x0 = Math.min(h, (2 - ch) * h - xp);
          return [
            pTop[0] - x0 * uUnit[0] + d[0],
            pTop[1] - x0 * uUnit[1] + d[1],
            pTop[2] - x0 * uUnit[2] + d[2],
          ];
        })
      : null;

  const sStartBase = useStartCap3 ? fCap3 : 0;
  const sEndBase = useEndCap3 ? 1 - fCap3 : 1;

  const evalStraight = (f, zShift, dst) => {
    if (useStartCap3 && f < fCap3) {
      const t = Math.max(0, f / fCap3);
      for (let c = 0; c < ringCount; c++) {
        const q = qWeldStart[c];
        if (c === startCapRail) {
          dst[c].set(
            cBotCap[0] + (q[0] - cBotCap[0]) * t,
            cBotCap[1] + (q[1] - cBotCap[1]) * t,
            cBotCap[2] + zShift + (q[2] - cBotCap[2]) * t,
          );
        } else if (c === startInnerRail) {
          dst[c].set(
            cBotInner[0] + (q[0] - cBotInner[0]) * t,
            cBotInner[1] + (q[1] - cBotInner[1]) * t,
            cBotInner[2] + zShift + (q[2] - cBotInner[2]) * t,
          );
        } else {
          dst[c].set(q[0], q[1], q[2] + zShift);
        }
      }
      return;
    }
    if (useEndCap3 && f > 1 - fCap3) {
      const t = Math.min(1, (f - (1 - fCap3)) / fCap3);
      for (let c = 0; c < ringCount; c++) {
        const q = qWeldEnd[c];
        if (c === endCapRail) {
          dst[c].set(
            q[0] + (cTopCap[0] - q[0]) * t,
            q[1] + (cTopCap[1] - q[1]) * t,
            q[2] + zShift + (cTopCap[2] - q[2]) * t,
          );
        } else if (c === endInnerRail) {
          dst[c].set(
            q[0] + (cTopInner[0] - q[0]) * t,
            q[1] + (cTopInner[1] - q[1]) * t,
            q[2] + zShift + (cTopInner[2] - q[2]) * t,
          );
        } else {
          dst[c].set(q[0], q[1], q[2] + zShift);
        }
      }
      return;
    }
    if (qWeldStart && f < fLo && fLo - sStartBase > 1e-8) {
      const t = Math.max(0, (f - sStartBase) / (fLo - sStartBase));
      const sx = pBot[0] + fLo * dx;
      const sy = pBot[1] + fLo * dy;
      const sz = pBot[2] + fLo * dz + zShift;
      for (let c = 0; c < ringCount; c++) {
        const q = qWeldStart[c];
        const d = deltas[c];
        const ax = sx + d[0];
        const ay = sy + d[1];
        const az = sz + d[2];
        const qz = q[2] + zShift;
        dst[c].set(q[0] + (ax - q[0]) * t, q[1] + (ay - q[1]) * t, qz + (az - qz) * t);
      }
      return;
    }
    if (qWeldEnd && f > fHi && sEndBase - fHi > 1e-8) {
      const t = Math.min(1, (f - fHi) / (sEndBase - fHi));
      const sx = pBot[0] + fHi * dx;
      const sy = pBot[1] + fHi * dy;
      const sz = pBot[2] + fHi * dz + zShift;
      for (let c = 0; c < ringCount; c++) {
        const q = qWeldEnd[c];
        const d = deltas[c];
        const ax = sx + d[0];
        const ay = sy + d[1];
        const az = sz + d[2];
        dst[c].set(ax + (q[0] - ax) * t, ay + (q[1] - ay) * t, az + (q[2] + zShift - az) * t);
      }
      return;
    }
    const px = pBot[0] + f * dx;
    const py = pBot[1] + f * dy;
    const pz = pBot[2] + f * dz + zShift;
    for (let c = 0; c < ringCount; c++) {
      const d = deltas[c];
      dst[c].set(px + d[0], py + d[1], pz + d[2]);
    }
  };

  const portalZones = [];
  let accZ = 0;
  for (let pi = 0; pi < portals.length; pi++) {
    const [sCut, jz] = portals[pi];
    const zBase = accZ;
    portalZones.push({
      sCut,
      cx: pBot[0] + sCut * dx,
      cy: pBot[1] + sCut * dy,
      ux,
      uy,
      jz,
      overhangS,
      corners: pillarCorners,
      hinges: pillarHinges,
      sampleUnbrokenCorners(sLocal, _side, dst) {
        evalStraight(Math.max(0, Math.min(1, sLocal)), zBase, dst);
      },
    });
    accZ += jz;
  }

  return {
    open: true,
    weldStart,
    weldEnd,
    capStartAlways,
    capEndAlways,
    weldBridge,
    lappedRung,
    unwoundWeld,
    fixedWorldWeld,
    segments,
    gap,
    phaseOffset,
    steps: 2,
    continuousSteps: 6,
    chamfer: ch,
    ringCount,
    collarS: (ch * h) / pillarLen,
    splits: portals.map((p) => p[0]),
    corners: pillarCorners,
    hinges: pillarHinges,
    portalZones,
    crossOnlyLoop,
    flatShaded: true,
    smoothPortalNormals: false,
    skipSpanWall:
      useStartCap3 || useEndCap3
        ? (sMid, w) => {
            if (useStartCap3 && sMid < fCap3) return w !== startCapRail && w !== startInnerRail;
            if (useEndCap3 && sMid > 1 - fCap3) return w !== endCapRail && w !== endInnerRail;
            return false;
          }
        : undefined,
    skipSpanRail:
      useStartCap3 || useEndCap3
        ? (sMid, cr) => {
            if (useStartCap3 && sMid < fCap3) return cr !== startCapRail && cr !== startInnerRail;
            if (useEndCap3 && sMid > 1 - fCap3) return cr !== endCapRail && cr !== endInnerRail;
            return false;
          }
        : undefined,
    sampleCorners(s, side, dst) {
      const f = Math.max(0, Math.min(1, s));
      const probe = Math.max(0, Math.min(1, s + side * 1e-7));
      let zShift = 0;
      for (let pi = 0; pi < portals.length; pi++) {
        if (probe >= portals[pi][0]) zShift += portals[pi][1];
      }
      evalStraight(f, zShift, dst);
    },
  };
}

// 10. Escher's Impossible Cube (M.C. Escher's Belvedere 12-edge cube: unbroken top & bottom squares + 4 pillars with swapped interior crossings)
function buildEscherCube(opts) {
  const s = opts.radius * 0.98;
  const halfSize = opts.thickness * 0.25;
  const pitchDeg = 26 + (opts.tilt - 45) * 0.35;
  const yawDeg = 32;
  const rollDeltaDeg = (opts.roll - 53) * 0.65;

  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const r = (rollDeltaDeg * Math.PI) / 180;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);

  const rotVec = (vx, vy, vz) => {
    const x1 = cy * vx + sy * vz;
    const y1 = vy;
    const z1 = -sy * vx + cy * vz;
    const x2 = x1;
    const y2 = cp * y1 - sp * z1;
    const z2 = sp * y1 + cp * z1;
    return [x2 * cr - y2 * sr, x2 * sr + y2 * cr, z2];
  };

  const A = rotVec(1, 0, 0);
  const B = rotVec(0, 0, 1);
  const U = rotVec(0, 1, 0);
  const cubeBasis = { E: [A, B, U], weights: [1, 1, 1] };

  const W = 1.66 * s;
  const H = 1.78 * s;

  const vtx = (ia, ib, uCoord) => [
    ia * W * A[0] + ib * W * B[0] + uCoord * U[0],
    ia * W * A[1] + ib * W * B[1] + uCoord * U[1],
    ia * W * A[2] + ib * W * B[2] + uCoord * U[2],
  ];

  const squareBars = [
    [0, 1, W],
    [1, 1, W],
    [0, -1, W],
    [1, -1, W],
  ];
  const squareSegs = Math.max(6, Math.round(opts.segments * 1.1));
  const pillarSegs = Math.max(3, Math.round(opts.segments * 0.55));

  const topStart = vtx(-0.5, -0.5, 0.5 * H);
  const botStart = vtx(-0.5, -0.5, -0.5 * H);

  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const negA = [-A[0], -A[1], -A[2]];
  const negB = [-B[0], -B[1], -B[2]];
  const negU = [-U[0], -U[1], -U[2]];
  const isContinuous = !opts.segmented;

  const topLoop = createCubeLatticeLoop({
    bars: squareBars,
    portals: [[0, 0.5, 0]],
    basis: cubeBasis,
    halfSize,
    chamfer: ch,
    trimCornerVertical: Boolean(opts.segmented),
    threeWayCornerFn: isContinuous ? () => negU : null,
    segments: squareSegs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: [topStart[0], topStart[1]],
    zInit: topStart[2],
  });

  const botLoop = createCubeLatticeLoop({
    bars: squareBars,
    portals: [[0, 0.5, 0]],
    basis: cubeBasis,
    halfSize,
    chamfer: ch,
    trimCornerVertical: Boolean(opts.segmented),
    threeWayCornerFn: isContinuous ? () => U : null,
    segments: squareSegs,
    gap: opts.gap,
    phaseOffset: 0.5 / squareSegs,
    xyOffset: [botStart[0], botStart[1]],
    zInit: botStart[2],
  });

  const uBot = opts.segmented ? -0.5 * H + halfSize : -0.5 * H;
  const uTop = opts.segmented ? 0.5 * H - halfSize : 0.5 * H;

  // Solve exact 2D crossing stations along the two interior pillars across all Tilt values
  const intersect2D = (a0, a1, b0, b1) => {
    const dx1 = a1[0] - a0[0];
    const dy1 = a1[1] - a0[1];
    const dx2 = b1[0] - b0[0];
    const dy2 = b1[1] - b0[1];
    const det = dx1 * -dy2 - dy1 * -dx2;
    if (Math.abs(det) < 1e-8) return { t: 0.5, u: 0.5 };
    const rx = b0[0] - a0[0];
    const ry = b0[1] - a0[1];
    return {
      t: (rx * -dy2 - ry * -dx2) / det,
      u: (dx1 * ry - dy1 * rx) / det,
    };
  };

  const prBot = vtx(0.5, -0.5, uBot);
  const prTop = vtx(0.5, -0.5, uTop);
  const tfl0 = vtx(0.5, 0.5, 0.5 * H);
  const tfl1 = vtx(-0.5, 0.5, 0.5 * H);
  const crossR = intersect2D(tfl0, tfl1, prBot, prTop);
  const zTfl = tfl0[2] + crossR.t * (tfl1[2] - tfl0[2]);
  const zPrReal = prBot[2] + crossR.u * (prTop[2] - prBot[2]);

  const plBot = vtx(-0.5, 0.5, uBot);
  const plTop = vtx(-0.5, 0.5, uTop);
  const bbr0 = vtx(-0.5, -0.5, -0.5 * H);
  const bbr1 = vtx(0.5, -0.5, -0.5 * H);
  const crossL = intersect2D(bbr0, bbr1, plBot, plTop);

  // Exact symmetric Z-jump so back pillar passes in front of top-front-left and front pillar passes behind bottom-back-right
  const jzSwap = zTfl - zPrReal + 0.85 * s;
  const rCut0 = Math.max(0.11, Math.min(0.66, crossR.u - 0.22));
  const rCut1 = Math.max(rCut0 + 0.32, Math.min(0.89, crossR.u + 0.22));
  const lCut0 = Math.max(0.11, Math.min(0.66, crossL.u - 0.22));
  const lCut1 = Math.max(lCut0 + 0.32, Math.min(0.89, crossL.u + 0.22));

  const pilBack = createCubePillarLoop({
    pBot: vtx(-0.5, -0.5, uBot),
    pTop: vtx(-0.5, -0.5, uTop),
    A,
    B,
    U,
    halfSize,
    chamfer: opts.chamfer,
    portals: [],
    weldStart: isContinuous,
    weldEnd: isContinuous,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    weldStart3Way: isContinuous ? [A, B] : null,
    weldEnd3Way: isContinuous ? [A, B] : null,
    segments: pillarSegs,
    gap: opts.gap,
    phaseOffset: 0.15,
  });

  const pilFront = createCubePillarLoop({
    pBot: vtx(0.5, 0.5, uBot),
    pTop: vtx(0.5, 0.5, uTop),
    A,
    B,
    U,
    halfSize,
    chamfer: opts.chamfer,
    portals: [],
    weldStart: isContinuous,
    weldEnd: isContinuous,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    weldStart3Way: isContinuous ? [negA, negB] : null,
    weldEnd3Way: isContinuous ? [negA, negB] : null,
    segments: pillarSegs,
    gap: opts.gap,
    phaseOffset: 0.65,
  });

  const pilRight = createCubePillarLoop({
    pBot: prBot,
    pTop: prTop,
    A,
    B,
    U,
    halfSize,
    chamfer: opts.chamfer,
    portals: [
      [rCut0, jzSwap],
      [rCut1, -jzSwap],
    ],
    crossOnlyLoop: 0,
    weldStart: isContinuous,
    weldEnd: isContinuous,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    weldStart3Way: isContinuous ? [negA, B] : null,
    weldEnd3Way: isContinuous ? [negA, B] : null,
    segments: pillarSegs,
    gap: opts.gap,
    phaseOffset: 0.4,
  });

  const pilLeft = createCubePillarLoop({
    pBot: plBot,
    pTop: plTop,
    A,
    B,
    U,
    halfSize,
    chamfer: opts.chamfer,
    portals: [
      [lCut0, -jzSwap],
      [lCut1, jzSwap],
    ],
    crossOnlyLoop: 3,
    weldStart: isContinuous,
    weldEnd: isContinuous,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    weldStart3Way: isContinuous ? [A, negB] : null,
    weldEnd3Way: isContinuous ? [A, negB] : null,
    segments: pillarSegs,
    gap: opts.gap,
    phaseOffset: 0.9,
  });

  return { loops: [topLoop, botLoop, pilBack, pilFront, pilRight, pilLeft] };
}

// 11. Impossible Meander / Interlock (Ref 3, Row 4 Col 2 — single 8-bar self-hooking loop)
function buildMeander(opts) {
  const s = opts.radius * 0.94;
  const halfSize = opts.thickness * 0.3;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const loop = createCubeLatticeLoop({
    bars: [
      [2, 1, 2.4 * s],
      [0, 1, 2.1 * s],
      [2, -1, 1.5 * s],
      [1, 1, 1.1 * s],
      [2, 1, 2.8 * s],
      [0, 1, 0.7 * s],
      [2, -1, 0.9 * s],
      [1, 1, 1.7 * s],
    ],
    portals: [[0, 0.5, 2.8 * s]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    selfCrossings: true,
    segments: Math.max(8, Math.round(opts.segments * 1.5)),
    gap: opts.gap,
  });
  return { loops: [loop] };
}

// 12. Spiral Tribar (Ref 3, Row 3 Col 2 — unbroken outer Penrose triangle with a flush 3D T-branched inner spiral arm)
function buildSpiralTribar(opts) {
  const s = opts.radius * 0.98;
  const rawHalf = opts.thickness * 0.33;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll + 7);
  const { E, weights } = basis;

  const outerNom = 2.75 * s;
  const branchNom = 1.9 * s;
  const innerNom = 1.05 * s;

  const minW = Math.min(weights[0], weights[1], weights[2]);
  const h = Math.min(rawHalf, innerNom * minW * 0.43);
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;

  const outerSegs = Math.max(5, Math.round(opts.segments * 1.05));
  const innerSegs = Math.max(2, Math.round(opts.segments * 0.45));

  const outerLoop = createCubeLatticeLoop({
    bars: [
      [0, 1, outerNom],
      [1, 1, outerNom],
      [2, 1, outerNom],
    ],
    portals: [[0, 0.5, outerNom]],
    basis,
    halfSize: h,
    chamfer: ch,
    segments: outerSegs,
    gap: opts.gap,
    phaseOffset: 0,
  });

  const totalOut = outerNom * (weights[0] + weights[1] + weights[2]);
  const sBranch =
    (0.5 * outerNom * weights[0] + outerNom * weights[1] + branchNom * weights[2]) / totalOut;
  const dsH = h / totalOut;
  const sTj0 = sBranch - dsH;
  const sTj1 = sBranch + dsH;

  const probeRing = Array.from({ length: ringCount }, () => new Vector3());
  outerLoop.sampleCorners(sBranch, 1, probeRing);
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let c = 0; c < ringCount; c++) {
    bx += probeRing[c].x;
    by += probeRing[c].y;
    bz += probeRing[c].z;
  }
  bx /= ringCount;
  by /= ringCount;
  bz /= ringCount;

  const railIsInner = new Array(ringCount);
  const railNeedsMiter = new Array(ringCount);
  for (let c = 0; c < ringCount; c++) {
    const rx = probeRing[c].x - bx;
    const ry = probeRing[c].y - by;
    const rz = probeRing[c].z - bz;
    const x0 = rx * E[0][0] + ry * E[0][1] + rz * E[0][2];
    const x1 = Math.abs(rx * E[1][0] + ry * E[1][1] + rz * E[1][2]);
    railIsInner[c] = x0 > 1e-5;
    railNeedsMiter[c] = useOct && x0 > 1e-5 && x1 > (1 - ch) * h + 1e-5;
  }

  if (!opts.segmented) {
    outerLoop.hinges.push(sTj0, sTj1);
    for (let zi = 0; zi < outerLoop.portalZones.length; zi++) {
      const zh = outerLoop.portalZones[zi].hinges;
      zh.push(sTj0 - 1, sTj1 - 1, sTj0, sTj1, sTj0 + 1, sTj1 + 1);
    }
    const baseSampleCorners = outerLoop.sampleCorners;
    if (useOct) {
      const shiftMag = ch * h;
      outerLoop.sampleCorners = (sVal, side, dst) => {
        baseSampleCorners(sVal, side, dst);
        let f = sVal % 1;
        if (f < 0) f += 1;
        let dir = 0;
        if (Math.abs(f - sTj0) < 1e-5) dir = 1;
        else if (Math.abs(f - sTj1) < 1e-5) dir = -1;
        if (dir !== 0) {
          const sx = dir * shiftMag * E[2][0];
          const sy = dir * shiftMag * E[2][1];
          const sz = dir * shiftMag * E[2][2];
          for (let c = 0; c < ringCount; c++) {
            if (railNeedsMiter[c]) {
              dst[c].x += sx;
              dst[c].y += sy;
              dst[c].z += sz;
            }
          }
        }
      };
    }
    outerLoop.skipSpanWall = (sMid, _w, wallNorm) => {
      let f = sMid % 1;
      if (f < 0) f += 1;
      if (f > sTj0 + 1e-6 && f < sTj1 - 1e-6) {
        return wallNorm.x * E[0][0] + wallNorm.y * E[0][1] + wallNorm.z * E[0][2] > 0.25;
      }
      return false;
    };
    outerLoop.skipSpanRail = (sMid, cr) => {
      let f = sMid % 1;
      if (f < 0) f += 1;
      return f > sTj0 + 1e-6 && f < sTj1 - 1e-6 && railIsInner[cr];
    };
  }

  // Build 2-bar inner arm (+E[0] -> 90° L-corner -> +E[1]) welded flush at `pBranch` and tucking behind Bar 2
  const T3 = E[0];
  const T4 = E[1];
  let U3 = E[1];
  let V3 = E[2];
  if (dot3(cross3(U3, V3), T3) < 0) {
    const tmp = U3;
    U3 = V3;
    V3 = tmp;
  }

  let deltas3;
  if (useOct) {
    const k1 = 1 - ch;
    deltas3 = [
      [h * (-k1 * U3[0] - V3[0]), h * (-k1 * U3[1] - V3[1]), h * (-k1 * U3[2] - V3[2])],
      [h * (k1 * U3[0] - V3[0]), h * (k1 * U3[1] - V3[1]), h * (k1 * U3[2] - V3[2])],
      [h * (U3[0] - k1 * V3[0]), h * (U3[1] - k1 * V3[1]), h * (U3[2] - k1 * V3[2])],
      [h * (U3[0] + k1 * V3[0]), h * (U3[1] + k1 * V3[1]), h * (U3[2] + k1 * V3[2])],
      [h * (k1 * U3[0] + V3[0]), h * (k1 * U3[1] + V3[1]), h * (k1 * U3[2] + V3[2])],
      [h * (-k1 * U3[0] + V3[0]), h * (-k1 * U3[1] + V3[1]), h * (-k1 * U3[2] + V3[2])],
      [h * (-U3[0] + k1 * V3[0]), h * (-U3[1] + k1 * V3[1]), h * (-U3[2] + k1 * V3[2])],
      [h * (-U3[0] - k1 * V3[0]), h * (-U3[1] - k1 * V3[1]), h * (-U3[2] - k1 * V3[2])],
    ];
  } else {
    deltas3 = [
      [h * (-U3[0] - V3[0]), h * (-U3[1] - V3[1]), h * (-U3[2] - V3[2])],
      [h * (U3[0] - V3[0]), h * (U3[1] - V3[1]), h * (U3[2] - V3[2])],
      [h * (U3[0] + V3[0]), h * (U3[1] + V3[1]), h * (U3[2] + V3[2])],
      [h * (-U3[0] + V3[0]), h * (-U3[1] + V3[1]), h * (-U3[2] + V3[2])],
    ];
  }

  const deltas4 = deltas3.map((d) => {
    const proj = dot3(d, T4);
    return [
      d[0] - proj * (T4[0] + T3[0]),
      d[1] - proj * (T4[1] + T3[1]),
      d[2] - proj * (T4[2] + T3[2]),
    ];
  });

  const fullLen3 = innerNom * weights[0];
  const len4 = innerNom * weights[1];
  const uStart3 = opts.segmented ? h : 0;
  const segLen3 = fullLen3 - uStart3;
  const totalInner = segLen3 + len4;
  const sElbow = segLen3 / totalInner;

  const pStart3 = [bx + uStart3 * T3[0], by + uStart3 * T3[1], bz + uStart3 * T3[2]];
  const pElbow = [bx + fullLen3 * T3[0], by + fullLen3 * T3[1], bz + fullLen3 * T3[2]];

  const qWeld = !opts.segmented
    ? deltas3.map((d) => {
        const x1 = Math.abs(dot3(d, E[1]));
        const x0 = Math.min(h, (2 - ch) * h - x1);
        return [bx + x0 * T3[0] + d[0], by + x0 * T3[1] + d[1], bz + x0 * T3[2] + d[2]];
      })
    : null;

  const qElbow = deltas3.map((d) => {
    const proj = dot3(d, T4);
    return [
      pElbow[0] + d[0] - proj * T3[0],
      pElbow[1] + d[1] - proj * T3[1],
      pElbow[2] + d[2] - proj * T3[2],
    ];
  });

  const uLo3 = !opts.segmented ? Math.min(h, segLen3 * 0.45) : 0;
  const uHi3 = Math.max(uLo3, segLen3 - Math.min(h, segLen3 * 0.45));
  const uLo4 = Math.min(h, len4 * 0.45);

  const innerHinges = [];
  if (uLo3 > 1e-5) innerHinges.push(uLo3 / totalInner);
  if (uHi3 < segLen3 - 1e-5) innerHinges.push(uHi3 / totalInner);
  if (uLo4 > 1e-5) innerHinges.push((segLen3 + uLo4) / totalInner);

  const innerArm = {
    open: true,
    weldStart: !opts.segmented,
    unwoundWeldBar: 2,
    segments: innerSegs,
    gap: opts.gap,
    phaseOffset: 0.25 / innerSegs,
    steps: 6,
    continuousSteps: 14,
    chamfer: ch,
    ringCount,
    collarS: (ch * h) / Math.max(1e-4, totalInner),
    splits: [],
    corners: [sElbow],
    hinges: innerHinges,
    portalZones: [],
    obbSpans: [
      [0, sElbow],
      [sElbow, 1],
    ],
    flatShaded: true,
    smoothPortalNormals: false,
    sampleCorners(sVal, _side, dst) {
      const f = Math.max(0, Math.min(1, sVal));
      if (f <= sElbow) {
        const u = (sElbow > 1e-8 ? f / sElbow : 0) * segLen3;
        if (qWeld && u < uLo3 && uLo3 > 1e-8) {
          const t = u / uLo3;
          const sx = pStart3[0] + uLo3 * T3[0];
          const sy = pStart3[1] + uLo3 * T3[1];
          const sz = pStart3[2] + uLo3 * T3[2];
          for (let c = 0; c < ringCount; c++) {
            const q = qWeld[c];
            const d = deltas3[c];
            dst[c].set(
              q[0] + (sx + d[0] - q[0]) * t,
              q[1] + (sy + d[1] - q[1]) * t,
              q[2] + (sz + d[2] - q[2]) * t,
            );
          }
          return;
        }
        if (u > uHi3 && segLen3 - uHi3 > 1e-8) {
          const t = (u - uHi3) / (segLen3 - uHi3);
          const sx = pStart3[0] + uHi3 * T3[0];
          const sy = pStart3[1] + uHi3 * T3[1];
          const sz = pStart3[2] + uHi3 * T3[2];
          for (let c = 0; c < ringCount; c++) {
            const q = qElbow[c];
            const d = deltas3[c];
            const ax = sx + d[0];
            const ay = sy + d[1];
            const az = sz + d[2];
            dst[c].set(ax + (q[0] - ax) * t, ay + (q[1] - ay) * t, az + (q[2] - az) * t);
          }
          return;
        }
        const px = pStart3[0] + u * T3[0];
        const py = pStart3[1] + u * T3[1];
        const pz = pStart3[2] + u * T3[2];
        for (let c = 0; c < ringCount; c++) {
          const d = deltas3[c];
          dst[c].set(px + d[0], py + d[1], pz + d[2]);
        }
      } else {
        const u = (1 - sElbow > 1e-8 ? (f - sElbow) / (1 - sElbow) : 0) * len4;
        if (u < uLo4 && uLo4 > 1e-8) {
          const t = u / uLo4;
          const sx = pElbow[0] + uLo4 * T4[0];
          const sy = pElbow[1] + uLo4 * T4[1];
          const sz = pElbow[2] + uLo4 * T4[2];
          for (let c = 0; c < ringCount; c++) {
            const q = qElbow[c];
            const d = deltas4[c];
            dst[c].set(
              q[0] + (sx + d[0] - q[0]) * t,
              q[1] + (sy + d[1] - q[1]) * t,
              q[2] + (sz + d[2] - q[2]) * t,
            );
          }
          return;
        }
        const px = pElbow[0] + u * T4[0];
        const py = pElbow[1] + u * T4[1];
        const pz = pElbow[2] + u * T4[2];
        for (let c = 0; c < ringCount; c++) {
          const d = deltas4[c];
          dst[c].set(px + d[0], py + d[1], pz + d[2]);
        }
      }
    },
  };

  return { loops: [outerLoop, innerArm] };
}

// 13. Impossible Borromean Rectangles (3 orthogonal cube-plane golden frames impossibly doubly-linked)
function buildBorromean(opts) {
  const s = opts.radius * 0.96;
  const longSide = 2.55 * s;
  const shortSide = 0.8 * s;
  const jumpNom = 1.65 * s;
  const halfSize = opts.thickness * 0.26;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const { E, weights } = basis;
  const segs = Math.max(6, Math.round(opts.segments * 1.05));

  const loops = [];
  for (let i = 0; i < 3; i++) {
    const a1 = i;
    const a2 = (i + 1) % 3;
    const cx0 = -0.5 * (longSide * weights[a1] * E[a1][0] + shortSide * weights[a2] * E[a2][0]);
    const cy0 = -0.5 * (longSide * weights[a1] * E[a1][1] + shortSide * weights[a2] * E[a2][1]);
    const cz0 = -0.5 * (longSide * weights[a1] * E[a1][2] + shortSide * weights[a2] * E[a2][2]);

    loops.push(
      createCubeLatticeLoop({
        bars: [
          [a1, 1, longSide],
          [a2, 1, shortSide],
          [a1, -1, longSide],
          [a2, -1, shortSide],
        ],
        portals: [
          [1, 0.5, jumpNom],
          [3, 0.5, -jumpNom],
        ],
        basis,
        halfSize,
        chamfer: opts.chamfer,
        segments: segs,
        gap: opts.gap,
        phaseOffset: i / (3 * segs),
        xyOffset: [cx0, cy0],
        zInit: cz0,
      }),
    );
  }

  return { loops };
}

// 14. Impossible Borromean Tribar (3 congruent orthogonal square plates with G2-continuous straight-leg D-arch holes)
function holeUnitRadius(ct, st, aRatio) {
  if (st < -1e-9) {
    const r = -1 / st;
    const u = r * ct;
    if (u >= -aRatio && u <= 1) return r;
  }
  if (ct > 1e-9) {
    const r = 1 / ct;
    const v = r * st;
    if (v >= -1 && v <= aRatio) return r;
  }
  const c1 = 3 - Math.sqrt(2 * (1 - aRatio));
  if (ct >= 0 && st > 0) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 22; it++) {
      const s = 0.5 * (lo + hi);
      const om = 1 - s;
      const x = 1 - om * om * om * (1 + c1 * s);
      const y = 1 - (1 - aRatio) * s * s;
      if (x * st - y * ct < 0) lo = s;
      else hi = s;
    }
    const s = 0.5 * (lo + hi);
    return (1 - (1 - aRatio) * s * s) / st;
  }
  if (ct < 0 && st <= 0) {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 22; it++) {
      const s = 0.5 * (lo + hi);
      const om = 1 - s;
      const yn = 1 - om * om * om * (1 + c1 * s);
      const xn = 1 - (1 - aRatio) * s * s;
      if (yn * -ct - xn * -st < 0) lo = s;
      else hi = s;
    }
    const s = 0.5 * (lo + hi);
    return (1 - (1 - aRatio) * s * s) / -ct;
  }
  return 1;
}

function createSquareWasherLoop({
  U,
  V,
  N,
  wU,
  wV,
  centerShift,
  rSquare,
  rCircle,
  halfT,
  chamfer = 0,
  zFront,
  zBack,
  segments,
  gap,
  phaseOffset = 0,
}) {
  const ch = Math.max(0, Math.min(0.45, chamfer));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;
  const minRimHalf = Math.max(0.02, 0.45 * (rSquare - rCircle));
  const bev = ch * Math.min(halfT, minRimHalf);
  const aRatio = 0.46;

  const bandW = rSquare - rCircle;
  const tFull = halfT;
  const tBev = halfT - bev;

  const uX = wU * U[0];
  const uY = wU * U[1];
  const uZ = wU * U[2];
  const vX = wV * V[0];
  const vY = wV * V[1];
  const vZ = wV * V[2];

  const cX = rSquare * (-centerShift * uX + centerShift * vX);
  const cY = rSquare * (-centerShift * uY + centerShift * vY);
  const cZ = rSquare * (-centerShift * uZ + centerShift * vZ);

  // The rim is a band of constant width around the hole: the outer edge is the hole's outline offset along its normal.
  const holePt = (th) => {
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const r = holeUnitRadius(ct, st, aRatio);
    return [r * ct, r * st];
  };
  const holeFrame = (th) => {
    const p = holePt(th);
    const a = holePt(th - 1e-4);
    const b = holePt(th + 1e-4);
    let nx = b[1] - a[1];
    let ny = -(b[0] - a[0]);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * p[0] + ny * p[1] < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [p[0], p[1], nx, ny];
  };

  // s runs by length along the middle of the band, so equal steps in s give equal blocks.
  const ARC_N = 1024;
  const arcS = new Float64Array(ARC_N + 1);
  {
    let prev = null;
    for (let k = 0; k <= ARC_N; k++) {
      const [hx, hy, nx, ny] = holeFrame(-Math.PI + (TAU * k) / ARC_N);
      const pu = rCircle * hx + 0.5 * bandW * nx;
      const pv = rCircle * hy + 0.5 * bandW * ny;
      const p = [pu * uX + pv * vX, pu * uY + pv * vY, pu * uZ + pv * vZ];
      arcS[k] = prev ? arcS[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) : 0;
      prev = p;
    }
    for (let k = 1; k <= ARC_N; k++) arcS[k] /= arcS[ARC_N];
  }
  const thetaOfS = (sv) => {
    const f = sv - Math.floor(sv);
    let lo = 0;
    let hi = ARC_N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arcS[mid] <= f) lo = mid;
      else hi = mid;
    }
    const t = (f - arcS[lo]) / Math.max(1e-12, arcS[hi] - arcS[lo]);
    return -Math.PI + (TAU * (lo + t)) / ARC_N + TAU * Math.floor(sv);
  };
  const sOfTheta = (th) => {
    const x = (((th + Math.PI) / TAU) % 1 + 1) % 1 * ARC_N;
    const k = Math.min(ARC_N - 1, Math.floor(x));
    return arcS[k] + (x - k) * (arcS[k + 1] - arcS[k]);
  };

  const evalWasherAt = (sVal, zShift, dst) => {
    const [hx, hy, nx, ny] = holeFrame(thetaOfS(sVal));

    const setPt = (idx, off, tn) => {
      const pu = rCircle * hx + off * nx;
      const pv = rCircle * hy + off * ny;
      dst[idx].set(
        cX + pu * uX + pv * vX + tn * N[0],
        cY + pu * uY + pv * vY + tn * N[1],
        cZ + pu * uZ + pv * vZ + tn * N[2] + zShift,
      );
    };

    if (useOct) {
      setPt(0, 0, -tBev);
      setPt(1, 0, tBev);
      setPt(2, bev, tFull);
      setPt(3, bandW - bev, tFull);
      setPt(4, bandW, tBev);
      setPt(5, bandW, -tBev);
      setPt(6, bandW - bev, -tFull);
      setPt(7, bev, -tFull);
    } else {
      setPt(0, 0, -tFull);
      setPt(1, 0, tFull);
      setPt(2, bandW, tFull);
      setPt(3, bandW, -tFull);
    }
  };

  // Three occluded / open sightline half-space portals:
  //   s = 0      (v_m = 0 at u_m < 0, outer free side):      0      -> +zFront
  //   s = sCut1  (u_m + k1*v_m = d1, under next plate bar):  +zFront -> zBack
  //   s = sCut2  (v_m = vCut2 at u_m > 0, under prev post):  zBack   -> 0
  const k1 = 0.85;
  const d1 = 0.1;
  const vCut2 = 0.08;
  const rRatio = rCircle / Math.max(1e-6, rSquare);

  // Middle of the band, in units of rSquare.
  const midAt = (th) => {
    const [hx, hy, nx, ny] = holeFrame(th);
    const half = 0.5 * (bandW / Math.max(1e-6, rSquare));
    return [rRatio * hx + half * nx, rRatio * hy + half * ny];
  };

  let lo1 = sOfTheta(-Math.PI + TAU * 0.25);
  let hi1 = sOfTheta(-Math.PI + TAU * 0.42);
  for (let it = 0; it < 40; it++) {
    const mid = 0.5 * (lo1 + hi1);
    const m = midAt(thetaOfS(mid));
    if (m[0] + k1 * m[1] - d1 < 0) lo1 = mid;
    else hi1 = mid;
  }
  const sCut1 = 0.5 * (lo1 + hi1);

  let lo2 = sOfTheta(-Math.PI + TAU * 0.38);
  let hi2 = sOfTheta(-Math.PI + TAU * 0.6);
  for (let it = 0; it < 40; it++) {
    const mid = 0.5 * (lo2 + hi2);
    if (midAt(thetaOfS(mid))[1] - vCut2 < 0) lo2 = mid;
    else hi2 = mid;
  }
  const sCut2 = 0.5 * (lo2 + hi2);

  const splits = [0, sCut1, sCut2];
  const pieceZ = [zFront, zBack, 0];
  const corners = [0.125, 0.375, 0.625, 0.875].map((c) => sOfTheta(-Math.PI + TAU * c));
  const sJoinB = sOfTheta(Math.atan2(-1, -aRatio));
  const sJoinC = sOfTheta(Math.atan2(aRatio, 1));
  const hinges = [sJoinB, sJoinC];
  const zoneCorners = [];
  const zoneHinges = [];
  for (let k = -1; k <= 1; k++) {
    for (let ci = 0; ci < 4; ci++) {
      zoneCorners.push(k + corners[ci]);
    }
    zoneHinges.push(k + sJoinB, k + sJoinC);
  }

  const approxPerim = 8 * rSquare;
  const overhangS = 0.08;
  const cutDefs = [
    {
      cx: cX,
      cy: cY,
      nx: uY,
      ny: -uX,
    },
    {
      cx: cX + rSquare * d1 * uX,
      cy: cY + rSquare * d1 * uY,
      nx: vY - k1 * uY,
      ny: -vX + k1 * uX,
    },
    {
      cx: cX + rSquare * vCut2 * vX,
      cy: cY + rSquare * vCut2 * vY,
      nx: -uY,
      ny: uX,
    },
  ];
  const portalZones = [];

  for (let pi = 0; pi < 3; pi++) {
    const sCut = splits[pi];
    const prevIdx = (pi + 2) % 3;
    const zpPrev = pieceZ[prevIdx];
    const jz = pieceZ[pi] - zpPrev;
    const def = cutDefs[pi];
    const nLen = Math.hypot(def.nx, def.ny) || 1;
    const ux = def.nx / nLen;
    const uy = def.ny / nLen;

    portalZones.push({
      sCut,
      cx: def.cx,
      cy: def.cy,
      ux,
      uy,
      jz,
      overhangS,
      corners: zoneCorners,
      hinges: zoneHinges,
      sampleUnbrokenCorners(sLocal, _side, dst) {
        evalWasherAt(sLocal, zpPrev, dst);
      },
    });
  }

  return {
    segments,
    gap,
    phaseOffset,
    steps: 10,
    continuousSteps: 136,
    chamfer: ch,
    ringCount,
    collarS: (ch * halfT) / Math.max(1e-4, approxPerim),
    splits,
    corners,
    hinges,
    portalZones,
    washerSlab: {
      cx: cX,
      cy: cY,
      cz: cZ,
      Au: [uX, uY, uZ],
      An: [N[0], N[1], N[2]],
      Av: [vX, vY, vZ],
      rSquare: rSquare - 0.12 * bev,
      halfT: halfT - 0.12 * bev,
      rCircle: rCircle + 0.12 * bev,
      bandW: bandW - 0.24 * bev,
      bandExtent: rCircle * Math.SQRT2 + bandW,
      aRatio,
      zFront,
      sMid0: 0.5 * sCut1,
      sMid2: 0.5 * (sCut2 + 1),
    },
    flatShaded: false,
    smoothPortalNormals: true,
    noSelfCrossShadow: true,
    hiddenShadowRange: [sCut1, sCut2],
    sampleCorners(s, side, dst) {
      let probe = (s + side * 1e-7) % 1;
      if (probe < 0) probe += 1;
      let pieceIdx = 2;
      if (probe < sCut1) pieceIdx = 0;
      else if (probe < sCut2) pieceIdx = 1;
      evalWasherAt(s, pieceZ[pieceIdx], dst);
    },
  };
}

function buildBorromeanTribar(opts) {
  const rSquare = opts.radius * 0.98;
  const rCircle = rSquare * 0.66;
  const halfT = opts.thickness * 0.22;
  const centerShift = 0.5;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const { E, weights } = basis;
  const segs = Math.max(10, Math.round(opts.segments * 1.25));

  const zFront = 1.35 * rSquare;
  const loops = [];

  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    const U = E[i];
    const V = E[i1];
    const N = [-E[i2][0], -E[i2][1], -E[i2][2]];
    const zBack = (-1.55 - 1.35 * i) * rSquare;

    loops.push(
      createSquareWasherLoop({
        U,
        V,
        N,
        wU: weights[i],
        wV: weights[i1],
        centerShift,
        rSquare,
        rCircle,
        halfT,
        chamfer: opts.chamfer,
        zFront,
        zBack,
        segments: segs,
        gap: opts.gap,
        phaseOffset: i / (3 * segs),
      }),
    );
  }

  return { loops };
}

// -----------------------------------------------------------------------------
// Shared Helpers for Multi-Bar Open Chains & Flush 3D T-Junctions
// -----------------------------------------------------------------------------

function sampleLoopCentroid(loop, sVal, side) {
  const ringCount = loop.ringCount || 4;
  const pts = Array.from({ length: ringCount }, () => new Vector3());
  loop.sampleCorners(sVal, side, pts);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let c = 0; c < ringCount; c++) {
    x += pts[c].x;
    y += pts[c].y;
    z += pts[c].z;
  }
  return [x / ringCount, y / ringCount, z / ringCount];
}

function carveCubeLatticeTJunction({
  trunkLoop,
  sBranch,
  totalTrunkLen,
  branchDir,
  trunkTangent,
  perpAxis,
  halfSize: h,
  chamfer: ch,
  segmented,
}) {
  const ringCount = trunkLoop.ringCount || 4;
  const useOct = ch > 1e-4;
  const dsH = h / Math.max(1e-5, totalTrunkLen);
  const sTj0 = sBranch - dsH;
  const sTj1 = sBranch + dsH;

  const probeRing = Array.from({ length: ringCount }, () => new Vector3());
  trunkLoop.sampleCorners(sBranch, 1, probeRing);
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let c = 0; c < ringCount; c++) {
    bx += probeRing[c].x;
    by += probeRing[c].y;
    bz += probeRing[c].z;
  }
  bx /= ringCount;
  by /= ringCount;
  bz /= ringCount;

  const railIsInner = new Array(ringCount);
  const railNeedsMiter = new Array(ringCount);
  for (let c = 0; c < ringCount; c++) {
    const rx = probeRing[c].x - bx;
    const ry = probeRing[c].y - by;
    const rz = probeRing[c].z - bz;
    const xb = rx * branchDir[0] + ry * branchDir[1] + rz * branchDir[2];
    const xp = Math.abs(rx * perpAxis[0] + ry * perpAxis[1] + rz * perpAxis[2]);
    railIsInner[c] = xb > 1e-5;
    railNeedsMiter[c] = useOct && xb > 1e-5 && xp > (1 - ch) * h + 1e-5;
  }

  if (!segmented) {
    trunkLoop.hinges.push(sTj0, sTj1);
    if (trunkLoop.portalZones) {
      for (let zi = 0; zi < trunkLoop.portalZones.length; zi++) {
        const zh = trunkLoop.portalZones[zi].hinges;
        zh.push(sTj0 - 1, sTj1 - 1, sTj0, sTj1, sTj0 + 1, sTj1 + 1);
      }
    }
    if (useOct) {
      const baseSampleCorners = trunkLoop.sampleCorners;
      const shiftMag = ch * h;
      trunkLoop.sampleCorners = (sVal, side, dst) => {
        baseSampleCorners(sVal, side, dst);
        let f = sVal % 1;
        if (f < 0) f += 1;
        let dir = 0;
        if (Math.abs(f - sTj0) < 1e-5) dir = 1;
        else if (Math.abs(f - sTj1) < 1e-5) dir = -1;
        if (dir !== 0) {
          const sx = dir * shiftMag * trunkTangent[0];
          const sy = dir * shiftMag * trunkTangent[1];
          const sz = dir * shiftMag * trunkTangent[2];
          for (let c = 0; c < ringCount; c++) {
            if (railNeedsMiter[c]) {
              dst[c].x += sx;
              dst[c].y += sy;
              dst[c].z += sz;
            }
          }
        }
      };
    }
    const prevSkipWall = trunkLoop.skipSpanWall;
    trunkLoop.skipSpanWall = (sMid, wIdx, wallNorm) => {
      if (prevSkipWall && prevSkipWall(sMid, wIdx, wallNorm)) return true;
      let f = sMid % 1;
      if (f < 0) f += 1;
      if (f > sTj0 + 1e-6 && f < sTj1 - 1e-6) {
        return (
          wallNorm.x * branchDir[0] +
            wallNorm.y * branchDir[1] +
            wallNorm.z * branchDir[2] >
          0.25
        );
      }
      return false;
    };
    const prevSkipRail = trunkLoop.skipSpanRail;
    trunkLoop.skipSpanRail = (sMid, cr) => {
      if (prevSkipRail && prevSkipRail(sMid, cr)) return true;
      let f = sMid % 1;
      if (f < 0) f += 1;
      return f > sTj0 + 1e-6 && f < sTj1 - 1e-6 && railIsInner[cr];
    };
  }

  return [bx, by, bz];
}

function createOpenCubeLatticeChain({
  bars,
  basis,
  halfSize,
  chamfer = 0,
  startPt,
  weldStart = false,
  weldEnd = false,
  weldStartTJunctionPerp = null,
  weldEndTJunctionPerp = null,
  weldStart3Way = null,
  weldEnd3Way = null,
  capStartAlways = false,
  capEndAlways = false,
  trimCornerAxisFn = null,
  unwoundWeld = false,
  segments = 4,
  gap = 0.11,
  phaseOffset = 0,
}) {
  const { E, weights } = basis;
  const numBars = bars.length;
  const tangs = [];
  const lens = [];
  let minBarLen = Infinity;
  for (let i = 0; i < numBars; i++) {
    const [ax, sg, nomLen] = bars[i];
    const e = E[ax];
    tangs.push([sg * e[0], sg * e[1], sg * e[2]]);
    const l = nomLen * weights[ax];
    lens.push(l);
    if (l < minBarLen) minBarLen = l;
  }

  const h = Math.min(halfSize, minBarLen * 0.43);
  const ch = Math.max(0, Math.min(0.45, chamfer));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;

  const ax0 = bars[0][0];
  let U = E[(ax0 + 1) % 3];
  let V = E[(ax0 + 2) % 3];
  if (dot3(cross3(U, V), tangs[0]) < 0) {
    const tmp = U;
    U = V;
    V = tmp;
  }

  const barDeltas = new Array(numBars);
  if (useOct) {
    const k1 = 1 - ch;
    barDeltas[0] = [
      [h * (-k1 * U[0] - V[0]), h * (-k1 * U[1] - V[1]), h * (-k1 * U[2] - V[2])],
      [h * (k1 * U[0] - V[0]), h * (k1 * U[1] - V[1]), h * (k1 * U[2] - V[2])],
      [h * (U[0] - k1 * V[0]), h * (U[1] - k1 * V[1]), h * (U[2] - k1 * V[2])],
      [h * (U[0] + k1 * V[0]), h * (U[1] + k1 * V[1]), h * (U[2] + k1 * V[2])],
      [h * (k1 * U[0] + V[0]), h * (k1 * U[1] + V[1]), h * (k1 * U[2] + V[2])],
      [h * (-k1 * U[0] + V[0]), h * (-k1 * U[1] + V[1]), h * (-k1 * U[2] + V[2])],
      [h * (-U[0] + k1 * V[0]), h * (-U[1] + k1 * V[1]), h * (-U[2] + k1 * V[2])],
      [h * (-U[0] - k1 * V[0]), h * (-U[1] - k1 * V[1]), h * (-U[2] - k1 * V[2])],
    ];
  } else {
    barDeltas[0] = [
      [h * (-U[0] - V[0]), h * (-U[1] - V[1]), h * (-U[2] - V[2])],
      [h * (U[0] - V[0]), h * (U[1] - V[1]), h * (U[2] - V[2])],
      [h * (U[0] + V[0]), h * (U[1] + V[1]), h * (U[2] + V[2])],
      [h * (-U[0] + V[0]), h * (-U[1] + V[1]), h * (-U[2] + V[2])],
    ];
  }

  for (let i = 0; i < numBars - 1; i++) {
    const Ti = tangs[i];
    const Tn = tangs[i + 1];
    const prevD = barDeltas[i];
    barDeltas[i + 1] = prevD.map((d) => {
      const proj = dot3(d, Tn);
      return [
        d[0] - proj * (Tn[0] + Ti[0]),
        d[1] - proj * (Tn[1] + Ti[1]),
        d[2] - proj * (Tn[2] + Ti[2]),
      ];
    });
  }

  const bevelMiterPt = (pBase, d, Tother, Tself, trimAxis = -1) => {
    const proj = dot3(d, Tother);
    let mx = d[0] - proj * Tself[0];
    let my = d[1] - proj * Tself[1];
    let mz = d[2] - proj * Tself[2];
    if (trimAxis >= 0 && ch > 1e-4) {
      const a1 = (trimAxis + 1) % 3;
      const a2 = (trimAxis + 2) % 3;
      const da = mx * E[a1][0] + my * E[a1][1] + mz * E[a1][2];
      const db = mx * E[a2][0] + my * E[a2][1] + mz * E[a2][2];
      const excess = Math.abs(da) + Math.abs(db) - (2 - ch) * h;
      if (excess > 1e-6) {
        const pullA = 0.5 * excess * (da >= 0 ? 1 : -1);
        const pullB = 0.5 * excess * (db >= 0 ? 1 : -1);
        mx -= pullA * E[a1][0] + pullB * E[a2][0];
        my -= pullA * E[a1][1] + pullB * E[a2][1];
        mz -= pullA * E[a1][2] + pullB * E[a2][2];
      }
    }
    return [pBase[0] + mx, pBase[1] + my, pBase[2] + mz];
  };

  let totalLen = 0;
  for (let i = 0; i < numBars; i++) totalLen += lens[i];

  const spans = [];
  const corners = [];
  const hinges = [];
  const obbSpans = [];
  let cx = startPt[0];
  let cy = startPt[1];
  let cz = startPt[2];
  let acc = 0;

  for (let i = 0; i < numBars; i++) {
    const T = tangs[i];
    const len = lens[i];
    const s0 = acc / totalLen;
    acc += len;
    const s1 = acc / totalLen;
    const p0 = [cx, cy, cz];
    const p1 = [cx + len * T[0], cy + len * T[1], cz + len * T[2]];
    cx = p1[0];
    cy = p1[1];
    cz = p1[2];

    const hClamp = Math.min(h, len * 0.45);
    const hasStart = i > 0 || Boolean(weldStartTJunctionPerp);
    const hasEnd = i < numBars - 1 || Boolean(weldEndTJunctionPerp);
    const uLo = hasStart ? hClamp : 0;
    const uHi = hasEnd ? len - hClamp : len;

    let qStart = null;
    if (i > 0) {
      const trimAx = trimCornerAxisFn ? trimCornerAxisFn(i) : -1;
      qStart = barDeltas[i].map((d) => bevelMiterPt(p0, d, tangs[i - 1], T, trimAx));
      hinges.push(s0 + uLo / totalLen);
    } else if (weldStartTJunctionPerp) {
      qStart = barDeltas[0].map((d) => {
        const xp = Math.abs(dot3(d, weldStartTJunctionPerp));
        const x0 = Math.min(h, (2 - ch) * h - xp);
        return [p0[0] + x0 * T[0] + d[0], p0[1] + x0 * T[1] + d[1], p0[2] + x0 * T[2] + d[2]];
      });
      if (uLo > 1e-5) hinges.push(s0 + uLo / totalLen);
    }

    let qEnd = null;
    if (i < numBars - 1) {
      const trimAx = trimCornerAxisFn ? trimCornerAxisFn(i + 1) : -1;
      qEnd = barDeltas[i].map((d) => bevelMiterPt(p1, d, tangs[i + 1], T, trimAx));
      hinges.push(s0 + uHi / totalLen);
      corners.push(s1);
    } else if (weldEndTJunctionPerp) {
      qEnd = barDeltas[i].map((d) => {
        const xp = Math.abs(dot3(d, weldEndTJunctionPerp));
        const x0 = Math.min(h, (2 - ch) * h - xp);
        return [p1[0] - x0 * T[0] + d[0], p1[1] - x0 * T[1] + d[1], p1[2] - x0 * T[2] + d[2]];
      });
      if (uHi < len - 1e-5) hinges.push(s0 + uHi / totalLen);
    }

    spans.push({ p0, p1, T, len, s0, s1, uLo, uHi, deltas: barDeltas[i], qStart, qEnd });
    obbSpans.push([s0, s1]);
  }

  return {
    open: true,
    weldStart,
    weldEnd,
    capStartAlways,
    capEndAlways,
    unwoundWeld,
    segments,
    gap,
    phaseOffset,
    steps: Math.max(4, numBars * 3),
    continuousSteps: Math.max(10, numBars * 8),
    chamfer: ch,
    ringCount,
    collarS: (ch * h) / Math.max(1e-4, totalLen),
    splits: [],
    corners,
    hinges,
    portalZones: [],
    obbSpans,
    flatShaded: true,
    smoothPortalNormals: false,
    sampleCorners(sVal, _side, dst) {
      const f = Math.max(0, Math.min(1, sVal));
      let sp = spans[spans.length - 1];
      for (let i = 0; i < spans.length; i++) {
        if (f <= spans[i].s1 + 1e-9) {
          sp = spans[i];
          break;
        }
      }
      const frac = sp.s1 > sp.s0 ? Math.max(0, Math.min(1, (f - sp.s0) / (sp.s1 - sp.s0))) : 0;
      const u = frac * sp.len;
      const { p0, T, deltas } = sp;

      if (sp.qStart && u < sp.uLo && sp.uLo > 1e-8) {
        const t = u / sp.uLo;
        const sx = p0[0] + sp.uLo * T[0];
        const sy = p0[1] + sp.uLo * T[1];
        const sz = p0[2] + sp.uLo * T[2];
        for (let c = 0; c < ringCount; c++) {
          const q = sp.qStart[c];
          const d = deltas[c];
          dst[c].set(
            q[0] + (sx + d[0] - q[0]) * t,
            q[1] + (sy + d[1] - q[1]) * t,
            q[2] + (sz + d[2] - q[2]) * t,
          );
        }
        return;
      }
      if (sp.qEnd && u > sp.uHi && sp.len - sp.uHi > 1e-8) {
        const t = (u - sp.uHi) / (sp.len - sp.uHi);
        const sx = p0[0] + sp.uHi * T[0];
        const sy = p0[1] + sp.uHi * T[1];
        const sz = p0[2] + sp.uHi * T[2];
        for (let c = 0; c < ringCount; c++) {
          const q = sp.qEnd[c];
          const d = deltas[c];
          const ax = sx + d[0];
          const ay = sy + d[1];
          const az = sz + d[2];
          dst[c].set(ax + (q[0] - ax) * t, ay + (q[1] - ay) * t, az + (q[2] - az) * t);
        }
        return;
      }
      const px = p0[0] + u * T[0];
      const py = p0[1] + u * T[1];
      const pz = p0[2] + u * T[2];
      for (let c = 0; c < ringCount; c++) {
        const d = deltas[c];
        dst[c].set(px + d[0], py + d[1], pz + d[2]);
      }
    },
  };
}

// 15. Escher's Waterfall Aqueduct (4-segment zig-zag flume + cantilevered spout + vertical waterfall drop + twin towers)
function buildWaterfall(opts) {
  const s = opts.radius * 0.72;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const { E, weights } = basis;

  const c0 = 2.52 * s;
  const m = 1.66 * s;
  const dropH = c0 + m;

  const minW = Math.min(weights[0], weights[1], weights[2]);
  const h = Math.min(opts.thickness * 0.2, (c0 - m) * minW * 0.36);

  const flumeSegs = Math.max(9, Math.round(opts.segments * 1.55));
  const postSegs = Math.max(3, Math.round(opts.segments * 0.45));

  const flumeLoop = createCubeLatticeLoop({
    bars: [
      [0, 1, c0],
      [1, 1, m],
      [0, 1, m],
      [1, 1, c0],
      [2, 1, dropH],
    ],
    portals: [[4, 0.52, dropH]],
    basis,
    halfSize: h,
    chamfer: ch,
    trimCornerAxisFn: (barAfterCorner) =>
      barAfterCorner === 1 || barAfterCorner === 2 || barAfterCorner === 3 ? 2 : -1,
    segments: flumeSegs,
    gap: opts.gap,
    phaseOffset: 0,
  });

  // Portal [4, 0.52] sits at s = 0; P1, P2, P3 are corners 1, 2, 3 and P4 sits at distance `m` along Bar 3
  const l0 = c0 * weights[0];
  const l1 = m * weights[1];
  const l2 = m * weights[0];
  const l3 = c0 * weights[1];
  const l4 = dropH * weights[2];
  const tot = l0 + l1 + l2 + l3 + l4;
  const tail4 = (1 - 0.52) * l4;

  const p1 = sampleLoopCentroid(flumeLoop, (tail4 + l0) / tot, 1);
  const p2 = sampleLoopCentroid(flumeLoop, (tail4 + l0 + l1) / tot, 1);
  const p3 = sampleLoopCentroid(flumeLoop, (tail4 + l0 + l1 + l2) / tot, 1);
  const sP4 = (tail4 + l0 + l1 + l2 + m * weights[1]) / tot;
  const p4 = carveCubeLatticeTJunction({
    trunkLoop: flumeLoop,
    sBranch: sP4,
    totalTrunkLen: tot,
    branchDir: E[2],
    trunkTangent: E[1],
    perpAxis: E[0],
    halfSize: h,
    chamfer: ch,
    segmented: opts.segmented,
  });

  const U = [-E[2][0], -E[2][1], -E[2][2]];
  const inset = (1 - ch) * h;
  const jzPost = -m * Math.sqrt(3);

  // Right tower column between 3-way bends P1 and P3
  const rBot = [p1[0] + inset * U[0], p1[1] + inset * U[1], p1[2] + inset * U[2]];
  const rSpan = m * weights[2] - 2 * inset;
  const rTopUnshifted = [rBot[0] + rSpan * U[0], rBot[1] + rSpan * U[1], rBot[2] + rSpan * U[2]];
  const rJz = p3[2] - inset * U[2] - rTopUnshifted[2];
  const pilRight = createCubePillarLoop({
    pBot: rBot,
    pTop: rTopUnshifted,
    A: E[0],
    B: E[1],
    U,
    halfSize: h,
    chamfer: ch,
    portals: [[0.56, Number.isFinite(rJz) ? rJz : jzPost]],
    weldBridge: true,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    segments: postSegs,
    gap: opts.gap,
    phaseOffset: 0.25,
  });

  // Left tower column from 3-way bend P2 up to flush 3D T-junction P4 underneath Bar 3
  const lBot = [p2[0] + inset * U[0], p2[1] + inset * U[1], p2[2] + inset * U[2]];
  const lTopInset = opts.segmented ? h : 0;
  const lSpan = m * weights[2] - inset - lTopInset;
  const lTopUnshifted = [lBot[0] + lSpan * U[0], lBot[1] + lSpan * U[1], lBot[2] + lSpan * U[2]];
  const lJz = p4[2] - lTopInset * U[2] - lTopUnshifted[2];
  const pilLeft = createCubePillarLoop({
    pBot: lBot,
    pTop: lTopUnshifted,
    A: E[0],
    B: E[1],
    U,
    halfSize: h,
    chamfer: ch,
    portals: [[0.56, Number.isFinite(lJz) ? lJz : jzPost]],
    weldBridge: true,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    weldEndTJunctionPerp: !opts.segmented ? E[0] : null,
    segments: postSegs,
    gap: opts.gap,
    phaseOffset: 0.65,
  });

  return { loops: [flumeLoop, pilRight, pilLeft] };
}

// 16. Impossible Archway / Tri-Column Viaduct (unbroken straight architrave lintel over an L-stepped 3-column base)
function buildArchway(opts) {
  const s = opts.radius * 0.94;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const { E, weights } = basis;

  const wBay = 1.42 * s;
  const dWing = 1.32 * s;
  const hCol = 1.66 * s;

  const minW = Math.min(weights[0], weights[1], weights[2]);
  const h = Math.min(opts.thickness * 0.29, Math.min(wBay, dWing) * minW * 0.42);

  const archSegs = Math.max(7, Math.round(opts.segments * 1.25));
  const midSegs = Math.max(3, Math.round(opts.segments * 0.45));

  const archLoop = createCubeLatticeLoop({
    bars: [
      [0, 1, wBay],
      [1, -1, dWing],
      [2, -1, hCol + dWing],
      [0, -1, wBay + dWing],
      [2, 1, hCol],
    ],
    portals: [[1, 0.5, -dWing]],
    basis,
    halfSize: h,
    chamfer: ch,
    trimCornerAxisFn: (barAfterCorner) => (barAfterCorner === 1 ? 2 : -1),
    segments: archSegs,
    gap: opts.gap,
    phaseOffset: 0,
  });

  const l0 = wBay * weights[0];
  const l1 = dWing * weights[1];
  const l2 = (hCol + dWing) * weights[2];
  const l3 = (wBay + dWing) * weights[0];
  const l4 = hCol * weights[2];
  const totalArch = l0 + l1 + l2 + l3 + l4;

  const sMTop = (0.5 * l1 + l2 + dWing * weights[0]) / totalArch;
  const sM = (0.5 * l1 + l2 + l3 + l4 + l0) / totalArch;

  const pM = sampleLoopCentroid(archLoop, sM, -1);
  const pMTop = carveCubeLatticeTJunction({
    trunkLoop: archLoop,
    sBranch: sMTop,
    totalTrunkLen: totalArch,
    branchDir: E[2],
    trunkTangent: [-E[0][0], -E[0][1], -E[0][2]],
    perpAxis: E[1],
    halfSize: h,
    chamfer: ch,
    segmented: opts.segmented,
  });

  const U = [-E[2][0], -E[2][1], -E[2][2]];
  const insetBot = opts.segmented ? h : (1 - ch) * h;
  const insetTop = opts.segmented ? h : 0;
  const pStartMid = [
    pM[0] + insetBot * U[0],
    pM[1] + insetBot * U[1],
    pM[2] + insetBot * U[2],
  ];
  const midNomLen =
    (Math.hypot(pMTop[0] - pStartMid[0], pMTop[1] - pStartMid[1], pMTop[2] - pStartMid[2]) -
      insetTop) /
    Math.max(1e-5, weights[2]);

  const pilMid = createOpenCubeLatticeChain({
    bars: [[2, -1, midNomLen]],
    basis,
    halfSize: h,
    chamfer: ch,
    startPt: pStartMid,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    weldEndTJunctionPerp: !opts.segmented ? E[1] : null,
    unwoundWeld: true,
    segments: midSegs,
    gap: opts.gap,
    phaseOffset: 0.35,
  });

  return { loops: [archLoop, pilMid] };
}

// 17. Impossible Ladder (coplanar rectangular ladder frame crossed by 3 lapped rungs that swap front/back depth)
function buildLadder(opts) {
  const s = opts.radius * 0.96;
  const halfSize = opts.thickness * 0.24;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));

  const pitchDeg = 23 + (opts.tilt - 45) * 0.32;
  const yawDeg = 28;
  const rollDeg = -13 + (opts.roll - 53) * 0.65;

  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);

  const rotVec = (vx, vy, vz) => {
    const x1 = cy * vx + sy * vz;
    const y1 = vy;
    const z1 = -sy * vx + cy * vz;
    const x2 = x1;
    const y2 = cp * y1 - sp * z1;
    const z2 = sp * y1 + cp * z1;
    return [x2 * cr - y2 * sr, x2 * sr + y2 * cr, z2];
  };

  const A = rotVec(1, 0, 0);
  const B = rotVec(0, 0, 1);
  const U = rotVec(0, 1, 0);
  const ladderBasis = { E: [A, U, B], weights: [1, 1, 1] };

  const W = 1.18 * s;
  const H = 2.86 * s;
  const overhang = 0.28 * s;

  const frameStart = [
    -0.5 * W * A[0] - 0.5 * H * U[0],
    -0.5 * W * A[1] - 0.5 * H * U[1],
    -0.5 * W * A[2] - 0.5 * H * U[2],
  ];

  const frameSegs = Math.max(8, Math.round(opts.segments * 1.3));
  const rungSegs = Math.max(3, Math.round(opts.segments * 0.45));

  const frameLoop = createCubeLatticeLoop({
    bars: [
      [0, 1, W],
      [1, 1, H],
      [0, -1, W],
      [1, -1, H],
    ],
    portals: [[0, 0.5, 0]],
    basis: ladderBasis,
    halfSize,
    chamfer: ch,
    segments: frameSegs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: [frameStart[0], frameStart[1]],
    zInit: frameStart[2],
  });

  // Sightline Z offset that places a rung flush against the +B front or -B back face of both side rails
  const dzFlush = (2.05 * halfSize) / Math.max(0.25, Math.abs(B[2]));
  const rungHeights = [-0.74 * s, 0, 0.74 * s];
  const loops = [frameLoop];

  for (let ri = 0; ri < 3; ri++) {
    const uH = rungHeights[ri];
    const signL = ri % 2 === 0 ? 1 : -1;
    const dzStart = signL * dzFlush;
    const jzMid = -2 * signL * dzFlush;
    const halfSpan = 0.5 * W + overhang;

    const pLeft = [
      -halfSpan * A[0] + uH * U[0],
      -halfSpan * A[1] + uH * U[1],
      -halfSpan * A[2] + uH * U[2] + dzStart,
    ];
    const pRightUnshifted = [
      halfSpan * A[0] + uH * U[0],
      halfSpan * A[1] + uH * U[1],
      halfSpan * A[2] + uH * U[2] + dzStart,
    ];

    loops.push(
      createCubePillarLoop({
        pBot: pLeft,
        pTop: pRightUnshifted,
        A: B,
        B: U,
        U: A,
        halfSize,
        chamfer: ch,
        portals: [[0.5, jzMid]],
        lappedRung: true,
        capStartAlways: true,
        capEndAlways: true,
        segments: rungSegs,
        gap: opts.gap,
        phaseOffset: (ri + 1) * 0.23,
      }),
    );
  }

  return { loops };
}

// 18. Impossible Greek Cross (12-bar symmetric 4-arm `+` orthogonal loop closing via sightline portal)
function buildCross(opts) {
  const s = opts.radius * 0.82;
  const w = 0.94 * s;
  const a = 0.96 * s;
  const halfSize = opts.thickness * 0.25;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 8);

  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, a],
      [2, -1, w],
      [0, -1, a + w],
      [1, 1, a + w],
      [0, -1, w],
      [1, -1, a + w],
      [0, -1, a + w],
      [1, -1, w],
      [0, 1, a + w],
      [1, -1, a + w],
      [2, -1, w],
      [1, 1, a],
    ],
    portals: [[2, 0.5, -2 * w]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(9, Math.round(opts.segments * 1.65)),
    gap: opts.gap,
  });

  return { loops: [loop] };
}

// Exact C_N-symmetric 3D untwisted rhombus-prism Penrose N-gon (`diamond`, `square`, `pentagon`, `hexagon`).
// With `hz = -w * tan(pi / N) * mz`, every bar is a flat-faced 3D prism whose inner-front face wraps with
// 1.000000000000 3D coplanarity into the next bar's outer-bevel face across every corner `i -> i+1`.
const _OCT_AB = [
  [-1, -1],
  [1, -1],
  [1, -1],
  [1, 1],
  [1, 1],
  [-1, 1],
  [-1, 1],
  [-1, -1],
];
const _QUAD_AB = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

function createPenrosePolygonLoop({
  sides,
  sideLen,
  halfWidth,
  chamfer = 0,
  tilt = 45,
  roll = 53,
  baseAngleDeg = 0,
  segments = 8,
  gap = 0.11,
  phaseOffset = 0,
}) {
  const N = Math.max(3, sides | 0);
  const L = sideLen;
  const theta = (2 * Math.PI) / N;
  const sinTh = Math.sin(theta);
  const cosTh = Math.cos(theta);
  const cotTh = cosTh / sinTh;
  const tanHalf = Math.tan(0.5 * theta);

  const cornerFactor = (1 + Math.abs(cosTh)) / Math.max(1e-4, sinTh);
  const w = Math.min(halfWidth, (L * 0.39) / Math.max(1, cornerFactor));
  const mz = -(0.54 + ((tilt - 24) / 42) * 0.34);
  const hz = Math.max(1e-4, -w * tanHalf * mz);

  const ch = Math.max(0, Math.min(0.45, chamfer));
  const useOct = ch > 1e-4;
  const ringCount = useOct ? 8 : 4;
  const slotStep = useOct ? 2 : 1;
  const k1 = 1 - ch;
  const abTable = useOct
    ? [
        [-1, -k1],
        [-1, k1],
        [-k1, 1],
        [k1, 1],
        [1, k1],
        [1, -k1],
        [k1, -1],
        [-k1, -1],
      ]
    : _QUAD_AB;

  const alpha0 = ((baseAngleDeg + (roll - 53) * 0.65) * Math.PI) / 180;
  const dirs = [];
  const norms = [];
  const verts2D = [[0, 0]];
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < N; i++) {
    const ang = alpha0 - i * theta;
    const tx = Math.cos(ang);
    const ty = Math.sin(ang);
    dirs.push([tx, ty]);
    norms.push([-ty, tx]);
    vx += L * tx;
    vy += L * ty;
    if (i < N - 1) verts2D.push([vx, vy]);
  }
  let cx0 = 0;
  let cy0 = 0;
  for (let i = 0; i < N; i++) {
    cx0 += verts2D[i][0];
    cy0 += verts2D[i][1];
  }
  cx0 /= N;
  cy0 /= N;
  for (let i = 0; i < N; i++) {
    verts2D[i][0] -= cx0;
    verts2D[i][1] -= cy0;
  }

  const makeSlotDeltas = (barIdx, shiftCount) => {
    const nx = norms[barIdx][0];
    const ny = norms[barIdx][1];
    const out = new Array(ringCount);
    for (let r = 0; r < ringCount; r++) {
      const idx = (((r - shiftCount * slotStep) % ringCount) + ringCount) % ringCount;
      const ab = abTable[idx];
      const dn = 0.5 * (ab[0] + ab[1]) * w;
      const dz = 0.5 * (ab[0] - ab[1]) * hz;
      out[r] = { dx: dn * nx, dy: dn * ny, dz, dn };
    }
    return out;
  };

  const makeStartMiter = (p0, barIdx, slotDeltas) => {
    const tx = dirs[barIdx][0];
    const ty = dirs[barIdx][1];
    return slotDeltas.map(({ dx, dy, dz, dn }) => {
      const uS = cotTh * dn + (w / (hz * sinTh)) * dz;
      return [p0[0] + uS * tx + dx, p0[1] + uS * ty + dy, p0[2] + uS * mz + dz];
    });
  };

  const makeEndMiter = (p1, barIdx, slotDeltas) => {
    const tx = dirs[barIdx][0];
    const ty = dirs[barIdx][1];
    return slotDeltas.map(({ dx, dy, dz, dn }) => {
      const uE = -cotTh * dn + (w / (hz * sinTh)) * dz;
      return [p1[0] + uE * tx + dx, p1[1] + uE * ty + dy, p1[2] + uE * mz + dz];
    });
  };

  // Single sightline portal at midpoint of bar 0 (`s = 0`), keeping all N corners 100% unbroken in 3D
  const totalLen2D = N * L;
  const portalJz = -totalLen2D * mz;
  const uCorner = Math.min(L * 0.44, w * cornerFactor);

  const ordered = [];
  let curZ = 0.5 * portalJz;
  const mid0X = verts2D[0][0] + 0.5 * L * dirs[0][0];
  const mid0Y = verts2D[0][1] + 0.5 * L * dirs[0][1];

  // Span 0: bar 0 post `[0.5*L, L]`
  {
    const p0 = [mid0X, mid0Y, curZ];
    const p1 = [verts2D[1][0], verts2D[1][1], curZ + 0.5 * L * mz];
    const slotDeltas = makeSlotDeltas(0, 0);
    ordered.push({
      barIdx: 0,
      shiftIdx: 0,
      p0,
      p1,
      len: 0.5 * L,
      tx: dirs[0][0],
      ty: dirs[0][1],
      uLo: 0,
      uHi: Math.max(0.02 * L, 0.5 * L - uCorner),
      slotDeltas,
      qStart: null,
      qEnd: makeEndMiter(p1, 0, slotDeltas),
    });
    curZ = p1[2];
  }

  // Spans 1 .. N-1: full bars `1 .. N-1`
  for (let bi = 1; bi < N; bi++) {
    const nextVi = (bi + 1) % N;
    const p0 = [verts2D[bi][0], verts2D[bi][1], curZ];
    const p1 = [verts2D[nextVi][0], verts2D[nextVi][1], curZ + L * mz];
    const slotDeltas = makeSlotDeltas(bi, bi);
    ordered.push({
      barIdx: bi,
      shiftIdx: bi,
      p0,
      p1,
      len: L,
      tx: dirs[bi][0],
      ty: dirs[bi][1],
      uLo: uCorner,
      uHi: L - uCorner,
      slotDeltas,
      qStart: makeStartMiter(p0, bi, slotDeltas),
      qEnd: makeEndMiter(p1, bi, slotDeltas),
    });
    curZ = p1[2];
  }

  // Span N: bar 0 pre `[0, 0.5*L]`
  {
    const p0 = [verts2D[0][0], verts2D[0][1], curZ];
    const p1 = [mid0X, mid0Y, curZ + 0.5 * L * mz];
    const slotDeltas = makeSlotDeltas(0, N);
    ordered.push({
      barIdx: 0,
      shiftIdx: N,
      p0,
      p1,
      len: 0.5 * L,
      tx: dirs[0][0],
      ty: dirs[0][1],
      uLo: Math.min(0.48 * L, uCorner),
      uHi: 0.5 * L,
      slotDeltas,
      qStart: makeStartMiter(p0, 0, slotDeltas),
      qEnd: null,
    });
  }

  const corners = [];
  const hinges = [];
  let acc = 0;
  for (let k = 0; k < ordered.length; k++) {
    const sp = ordered[k];
    sp.s0 = acc / totalLen2D;
    acc += sp.len;
    sp.s1 = acc / totalLen2D;
    if (sp.qStart) {
      const sh = sp.s0 + sp.uLo / totalLen2D;
      if (sh > 1e-5 && sh < 1 - 1e-5) hinges.push(sh);
    }
    if (sp.qEnd) {
      const sh = sp.s0 + sp.uHi / totalLen2D;
      if (sh > 1e-5 && sh < 1 - 1e-5) hinges.push(sh);
      if (sp.s1 > 1e-5 && sp.s1 < 1 - 1e-5) corners.push(sp.s1);
    }
  }

  const evalPolySpanAt = (sp, f, dst) => {
    const spanFrac = sp.s1 > sp.s0 ? Math.max(0, Math.min(1, (f - sp.s0) / (sp.s1 - sp.s0))) : 0;
    const u = spanFrac * sp.len;
    const { p0, tx, ty, slotDeltas } = sp;

    if (sp.qStart && u < sp.uLo && sp.uLo > 1e-8) {
      const t = u / sp.uLo;
      const bx = p0[0] + sp.uLo * tx;
      const by = p0[1] + sp.uLo * ty;
      const bz = p0[2] + sp.uLo * mz;
      for (let c = 0; c < ringCount; c++) {
        const q = sp.qStart[c];
        const d = slotDeltas[c];
        dst[c].set(
          q[0] + (bx + d.dx - q[0]) * t,
          q[1] + (by + d.dy - q[1]) * t,
          q[2] + (bz + d.dz - q[2]) * t,
        );
      }
      return;
    }

    if (sp.qEnd && u > sp.uHi && sp.len - sp.uHi > 1e-8) {
      const t = (u - sp.uHi) / (sp.len - sp.uHi);
      const bx = p0[0] + sp.uHi * tx;
      const by = p0[1] + sp.uHi * ty;
      const bz = p0[2] + sp.uHi * mz;
      for (let c = 0; c < ringCount; c++) {
        const q = sp.qEnd[c];
        const d = slotDeltas[c];
        const sx = bx + d.dx;
        const sy = by + d.dy;
        const sz = bz + d.dz;
        dst[c].set(sx + (q[0] - sx) * t, sy + (q[1] - sy) * t, sz + (q[2] - sz) * t);
      }
      return;
    }

    const px = p0[0] + u * tx;
    const py = p0[1] + u * ty;
    const pz = p0[2] + u * mz;
    for (let c = 0; c < ringCount; c++) {
      const d = slotDeltas[c];
      dst[c].set(px + d.dx, py + d.dy, pz + d.dz);
    }
  };

  // Unbroken chain across portal `sCut = 0` (`[-1, 0]` followed by `[0, 1]` shifted by `-portalJz` and `+N` slotShift)
  const chain = [];
  const chainCorners = [];
  const chainHinges = [];
  for (let k = 0; k < ordered.length; k++) {
    const src = ordered[k];
    const s0 = src.s0 - 1;
    const s1 = src.s1 - 1;
    chain.push({ ...src, s0, s1 });
    if (src.qStart) chainHinges.push(s0 + src.uLo / totalLen2D);
    if (src.qEnd) {
      chainHinges.push(s0 + src.uHi / totalLen2D);
      chainCorners.push(s1);
    }
  }
  for (let k = 0; k < ordered.length; k++) {
    const src = ordered[k];
    const p0 = [src.p0[0], src.p0[1], src.p0[2] - portalJz];
    const p1 = [src.p1[0], src.p1[1], src.p1[2] - portalJz];
    const slotDeltas = makeSlotDeltas(src.barIdx, src.shiftIdx + N);
    const qStart = src.qStart ? makeStartMiter(p0, src.barIdx, slotDeltas) : null;
    const qEnd = src.qEnd ? makeEndMiter(p1, src.barIdx, slotDeltas) : null;
    if (qStart) chainHinges.push(src.s0 + src.uLo / totalLen2D);
    if (qEnd) {
      chainHinges.push(src.s0 + src.uHi / totalLen2D);
      chainCorners.push(src.s1);
    }
    chain.push({
      ...src,
      p0,
      p1,
      slotDeltas,
      qStart,
      qEnd,
    });
  }

  const overhangS = Math.min(0.14, (1.65 * Math.max(w, hz)) / Math.max(1e-5, totalLen2D));
  const portalZones = [
    {
      sCut: 0,
      cx: mid0X,
      cy: mid0Y,
      ux: dirs[0][0],
      uy: dirs[0][1],
      jz: portalJz,
      overhangS,
      corners: chainCorners,
      hinges: chainHinges,
      sampleUnbrokenCorners(sLocal, _side, dst) {
        const f = Math.max(-1, Math.min(1, sLocal));
        let sp = chain[chain.length - 1];
        for (let k = 0; k < chain.length; k++) {
          if (f <= chain[k].s1 + 1e-9) {
            sp = chain[k];
            break;
          }
        }
        evalPolySpanAt(sp, f, dst);
      },
    },
  ];

  return {
    segments,
    gap,
    phaseOffset,
    steps: 8,
    continuousSteps: 48,
    chamfer: ch,
    ringCount,
    collarS: (ch * w) / Math.max(1e-5, totalLen2D),
    splits: [0],
    corners,
    hinges,
    portalZones,
    flatShaded: true,
    smoothPortalNormals: false,
    sampleCorners(s, side, dst) {
      let probe = (s + side * 1e-7) % 1;
      if (probe < 0) probe += 1;
      const laps = Math.round(s + side * 1e-7 - probe);
      const f = Math.max(0, Math.min(1, s - laps));
      let sp = ordered[ordered.length - 1];
      for (let k = 0; k < ordered.length; k++) {
        if (f <= ordered[k].s1 + 1e-9) {
          sp = ordered[k];
          break;
        }
      }
      evalPolySpanAt(sp, f, dst);
    },
  };
}

// 19a. Classic Impossible Diamond (4-bar C4 Penrose square rotated 45°)
function buildDiamond(opts) {
  return {
    loops: [
      createPenrosePolygonLoop({
        sides: 4,
        sideLen: opts.radius * 2.15,
        halfWidth: opts.thickness * 0.44,
        chamfer: opts.chamfer,
        tilt: opts.tilt,
        roll: opts.roll,
        baseAngleDeg: 45,
        segments: Math.max(4, Math.round(opts.segments * 1.1)),
        gap: opts.gap,
      }),
    ],
  };
}

// 19b. Classic Penrose Square (axis-aligned 4-bar C4 Penrose square)
function buildSquare(opts) {
  return {
    loops: [
      createPenrosePolygonLoop({
        sides: 4,
        sideLen: opts.radius * 2.15,
        halfWidth: opts.thickness * 0.44,
        chamfer: opts.chamfer,
        tilt: opts.tilt,
        roll: opts.roll,
        baseAngleDeg: 0,
        segments: Math.max(4, Math.round(opts.segments * 1.1)),
        gap: opts.gap,
      }),
    ],
  };
}

// 19c. Impossible Pentagon (5-bar C5 Penrose pentagon)
function buildPentagon(opts) {
  return {
    loops: [
      createPenrosePolygonLoop({
        sides: 5,
        sideLen: opts.radius * 1.72,
        halfWidth: opts.thickness * 0.42,
        chamfer: opts.chamfer,
        tilt: opts.tilt,
        roll: opts.roll,
        baseAngleDeg: -36,
        segments: Math.max(5, Math.round(opts.segments * 1.2)),
        gap: opts.gap,
      }),
    ],
  };
}

// 19d. Impossible Hexagon (6-bar C6 Penrose hexagon)
function buildHexagon(opts) {
  return {
    loops: [
      createPenrosePolygonLoop({
        sides: 6,
        sideLen: opts.radius * 1.44,
        halfWidth: opts.thickness * 0.4,
        chamfer: opts.chamfer,
        tilt: opts.tilt,
        roll: opts.roll,
        baseAngleDeg: 0,
        segments: Math.max(6, Math.round(opts.segments * 1.3)),
        gap: opts.gap,
      }),
    ],
  };
}

// 19e. Impossible Divided Diamond (Ref Sheet Row 2 Col 3 — symmetric 3D outer rhombus + central portal spine with 3-way cube-corner miters)
function buildDividedDiamond(opts) {
  const s = opts.radius * 0.98;
  const L = 2.45 * s;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll + 127);
  const { E, weights } = basis;

  const minW = Math.min(weights[0], weights[1], weights[2]);
  const h = Math.min(opts.thickness * 0.34, L * minW * 0.42);

  // Exact 3D vertices of the closed 4-bar rhombus centered at `(0, 0, 0)`:
  // `V_L ->(+E2)-> V_T ->(+E1)-> V_R ->(-E2)-> V_B ->(-E1)-> V_L`
  const l0 = L * weights[0];
  const l1 = L * weights[1];
  const l2 = L * weights[2];
  const pVL = [
    -0.5 * (l2 * E[2][0] + l1 * E[1][0]),
    -0.5 * (l2 * E[2][1] + l1 * E[1][1]),
    -0.5 * (l2 * E[2][2] + l1 * E[1][2]),
  ];
  const pVR = [-pVL[0], -pVL[1], -pVL[2]];

  const negE0 = [-E[0][0], -E[0][1], -E[0][2]];
  const posE0 = [E[0][0], E[0][1], E[0][2]];
  const negE1 = [-E[1][0], -E[1][1], -E[1][2]];
  const negE2 = [-E[2][0], -E[2][1], -E[2][2]];

  const outerSegs = Math.max(6, Math.round(opts.segments * 1.35));
  const spineSegs = Math.max(3, Math.round(opts.segments * 0.45));

  const outerRhombus = createCubeLatticeLoop({
    bars: [
      [2, 1, L],
      [1, 1, L],
      [2, -1, L],
      [1, -1, L],
    ],
    portals: [[3, 0.5, 0]],
    basis,
    halfSize: h,
    chamfer: ch,
    threeWayCornerFn: opts.segmented
      ? null
      : (barAfterCorner) =>
          barAfterCorner === 0 ? negE0 : barAfterCorner === 2 ? posE0 : null,
    segments: outerSegs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: [pVL[0], pVL[1]],
    zInit: pVL[2],
  });

  // Central spine runs from `V_R` along `+E[0]` to `V_L`, with a single midpoint sightline portal `jz = L * sqrt(3)`
  const segInset = opts.segmented ? h : 0;
  const spanLen = Math.max(2.5 * h, l0 - 2 * segInset);
  const pBot = [
    pVR[0] + segInset * E[0][0],
    pVR[1] + segInset * E[0][1],
    pVR[2] + segInset * E[0][2],
  ];
  const pTopUnshifted = [
    pBot[0] + spanLen * E[0][0],
    pBot[1] + spanLen * E[0][1],
    pBot[2] + spanLen * E[0][2],
  ];
  const pVLTargetZ = pVL[2] - segInset * E[0][2];
  const spineJz = pVLTargetZ - pTopUnshifted[2];

  const centralSpine = createCubePillarLoop({
    pBot,
    pTop: pTopUnshifted,
    A: negE1,
    B: negE2,
    U: posE0,
    halfSize: h,
    chamfer: ch,
    portals: [[0.5, spineJz]],
    weldBridge: true,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    weldStart3Way: !opts.segmented ? [negE1, negE2] : null,
    weldEnd3Way: !opts.segmented ? [E[1], E[2]] : null,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    segments: spineSegs,
    gap: opts.gap,
    phaseOffset: 0.35 / spineSegs,
  });

  return { loops: [outerRhombus, centralSpine] };
}

// 20. Curved Impossible Trefoil (C^inf 3-lobe torus-knot ribbon with C3 impossible side-wall flips & 3 sightline portals)
function buildTrefoil(opts) {
  const rMaj = 0.7 * opts.radius;
  const rMin = 0.36 * opts.radius;
  const halfW = opts.thickness * 0.33;
  const halfD = opts.thickness * 0.27;

  const bevelScale = 0.42 + ((opts.tilt - 24) / 42) * 0.38;
  const leanMag = opts.thickness * 0.48 * bevelScale;

  const screenRollRad = (((opts.roll - 53) * 0.65 + 30) * Math.PI) / 180;
  const cr = Math.cos(screenRollRad);
  const sr = Math.sin(screenRollRad);

  const zAmp = Math.max(0.46, halfD * 2.95);
  const chamfer = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const approxPerim = 18.2 * opts.radius;

  const loop = {
    segments: Math.max(9, Math.round(opts.segments * 1.8)),
    gap: opts.gap,
    steps: 14,
    continuousSteps: 216,
    splits: [0, 1 / 3, 2 / 3],
    chamfer,
    ringCount: chamfer > 1e-4 ? 8 : 4,
    collarS: (chamfer * 0.5 * (halfW + halfD)) / Math.max(1e-4, approxPerim),
    smoothPortalNormals: true,
    curveShadow: {
      mode: 2,
      r0: rMaj,
      r1: rMin,
      halfW,
      halfD,
      leanX: leanMag * 0.82,
      leanY: 0,
      cr,
      sr,
      zAmp,
      chamfer,
    },
    sample(s, side, out) {
      let probe = (s + side * 1e-8) % 1;
      if (probe < 0) probe += 1;
      const pieceIdx = probe < 1 / 3 ? 0 : probe < 2 / 3 ? 1 : 2;
      const sBase = pieceIdx / 3;

      let local = s - Math.floor(s - sBase + 1e-7) - sBase;
      local = Math.max(0, Math.min(1 / 3, local));
      const u = sBase + local;
      const w = local * 3;

      const a = 4 * Math.PI * u;
      const b = -2 * Math.PI * u;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cb = Math.cos(b);
      const sb = Math.sin(b);

      const x0 = rMaj * ca + rMin * cb;
      const y0 = rMaj * sa + rMin * sb;
      const vx = -4 * Math.PI * rMaj * sa + 2 * Math.PI * rMin * sb;
      const vy = 4 * Math.PI * rMaj * ca - 2 * Math.PI * rMin * cb;
      const vLen = Math.hypot(vx, vy) || 1;
      const tx0 = vx / vLen;
      const ty0 = vy / vLen;
      const nx0 = -ty0;
      const ny0 = tx0;

      // Smooth C3-equivariant normal-aligned side-wall flip: orthogonal to tangent (zero shear) and 0 at splits 0, 1/3, 2/3
      const flip = Math.sin(6 * Math.PI * u) * leanMag * 0.82;
      const bx = flip * nx0;
      const by = flip * ny0;

      const pxL = x0 + 0.5 * bx;
      const pyL = y0 + 0.5 * by;
      const axL = nx0 * halfW;
      const ayL = ny0 * halfW;
      const bxL = -0.5 * bx;
      const byL = -0.5 * by;

      const z = zAmp * Math.cos(Math.PI * w);

      out.pos.set(pxL * cr - pyL * sr, pxL * sr + pyL * cr, z);
      out.a.set(axL * cr - ayL * sr, axL * sr + ayL * cr, 0);
      out.b.set(bxL * cr - byL * sr, bxL * sr + byL * cr, halfD);
    },
  };

  return { loops: [loop] };
}

// 21. Impossible Bauhaus Frame Chair (cantilevered sled base + square seat + tall backrest with swapped leg/post crossings)
function buildChair(opts) {
  const s = opts.radius * 0.9;
  const halfSize = opts.thickness * 0.22;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));

  const pitchDeg = 23.5 + (opts.tilt - 45) * 0.22;
  const yawDeg = 32;
  const rollDeltaDeg = (opts.roll - 53) * 0.65;

  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const r = (rollDeltaDeg * Math.PI) / 180;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);

  const rotVec = (vx, vy, vz) => {
    const x1 = cy * vx + sy * vz;
    const y1 = vy;
    const z1 = -sy * vx + cy * vz;
    const x2 = x1;
    const y2 = cp * y1 - sp * z1;
    const z2 = sp * y1 + cp * z1;
    return [x2 * cr - y2 * sr, x2 * sr + y2 * cr, z2];
  };

  const A = rotVec(1, 0, 0);
  const B = rotVec(0, 0, 1);
  const U = rotVec(0, 1, 0);
  const chairBasis = { E: [A, B, U], weights: [1, 1, 1] };

  const W = 1.48 * s;
  const D = 1.28 * s;
  const uFloor = -1.24 * s;
  const uSeat = -0.06 * s;
  const uBack = 1.38 * s;

  const vtx = (ia, ib, uCoord) => [
    ia * W * A[0] + ib * D * B[0] + uCoord * U[0],
    ia * W * A[1] + ib * D * B[1] + uCoord * U[1],
    ia * W * A[2] + ib * D * B[2] + uCoord * U[2],
  ];

  const seatSegs = Math.max(6, Math.round(opts.segments * 1.0));
  const archSegs = Math.max(5, Math.round(opts.segments * 0.8));
  const legSegs = Math.max(3, Math.round(opts.segments * 0.45));

  const negA = [-A[0], -A[1], -A[2]];
  const negB = [-B[0], -B[1], -B[2]];
  const negU = [-U[0], -U[1], -U[2]];
  const isContinuous = !opts.segmented;

  const seatStart = vtx(-0.5, -0.5, uSeat);
  const seatLoop = createCubeLatticeLoop({
    bars: [
      [0, 1, W],
      [1, 1, D],
      [0, -1, W],
      [1, -1, D],
    ],
    portals: [[0, 0.5, 0]],
    basis: chairBasis,
    halfSize,
    chamfer: ch,
    trimCornerAxisFn: (b) => (opts.segmented || b === 0 || b === 1 ? 2 : -1),
    threeWayCornerFn: isContinuous ? (b) => (b === 2 || b === 3 ? negU : null) : null,
    segments: seatSegs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: [seatStart[0], seatStart[1]],
    zInit: seatStart[2],
  });

  // Open-front cantilevered floor sled runner with front skid toes extending past the front legs
  const skidToe = 0.22 * s;
  const sledArmLen = D + skidToe;
  const sledTotal = 2 * sledArmLen + W;
  const sledChain = createOpenCubeLatticeChain({
    bars: [
      [1, -1, sledArmLen],
      [0, 1, W],
      [1, 1, sledArmLen],
    ],
    basis: chairBasis,
    halfSize,
    chamfer: ch,
    startPt: [
      -0.5 * W * A[0] + (0.5 * D + skidToe) * B[0] + uFloor * U[0],
      -0.5 * W * A[1] + (0.5 * D + skidToe) * B[1] + uFloor * U[1],
      -0.5 * W * A[2] + (0.5 * D + skidToe) * B[2] + uFloor * U[2],
    ],
    capStartAlways: true,
    capEndAlways: true,
    trimCornerAxisFn: () => 2,
    segments: archSegs,
    gap: opts.gap,
    phaseOffset: 0.3,
  });

  // Carve flush 3D T-junction mouths on the top face of both front skids where the front legs land
  carveCubeLatticeTJunction({
    trunkLoop: sledChain,
    sBranch: skidToe / sledTotal,
    totalTrunkLen: sledTotal,
    branchDir: U,
    trunkTangent: [-B[0], -B[1], -B[2]],
    perpAxis: A,
    halfSize,
    chamfer: ch,
    segmented: opts.segmented,
  });
  carveCubeLatticeTJunction({
    trunkLoop: sledChain,
    sBranch: (sledArmLen + W + D) / sledTotal,
    totalTrunkLen: sledTotal,
    branchDir: U,
    trunkTangent: B,
    perpAxis: A,
    halfSize,
    chamfer: ch,
    segmented: opts.segmented,
  });

  // Tall rear backrest U-arch welded onto the two rear seat corners
  const inset = (1 - ch) * halfSize;
  const backSpanH = uBack - (uSeat + inset);
  const backChain = createOpenCubeLatticeChain({
    bars: [
      [2, 1, backSpanH],
      [0, 1, W],
      [2, -1, backSpanH],
    ],
    basis: chairBasis,
    halfSize,
    chamfer: ch,
    startPt: vtx(-0.5, -0.5, uSeat + inset),
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    segments: archSegs,
    gap: opts.gap,
    phaseOffset: 0.6,
  });

  const uLegBot = uFloor + inset;
  const uLegTop = uSeat - inset;

  const intersect2D = (a0, a1, b0, b1) => {
    const dx1 = a1[0] - a0[0];
    const dy1 = a1[1] - a0[1];
    const dx2 = b1[0] - b0[0];
    const dy2 = b1[1] - b0[1];
    const det = dx1 * -dy2 - dy1 * -dx2;
    if (Math.abs(det) < 1e-8) return { t: 0.5, u: 0.5 };
    const rx = b0[0] - a0[0];
    const ry = b0[1] - a0[1];
    return {
      t: (rx * -dy2 - ry * -dx2) / det,
      u: (dx1 * ry - dy1 * rx) / det,
    };
  };

  // Back-Right leg crosses IN FRONT OF Front Seat Rail (loop 0)
  const brBot = vtx(0.5, -0.5, uLegBot);
  const brTop = vtx(0.5, -0.5, uLegTop);
  const fs0 = vtx(0.5, 0.5, uSeat);
  const fs1 = vtx(-0.5, 0.5, uSeat);
  const crossR = intersect2D(fs0, fs1, brBot, brTop);
  const zFs = fs0[2] + crossR.t * (fs1[2] - fs0[2]);
  const zBrReal = brBot[2] + crossR.u * (brTop[2] - brBot[2]);
  const jzOver = zFs - zBrReal + 0.78 * s;
  const rCut0 = Math.max(0.08, Math.min(0.66, crossR.u - 0.22));
  const rCut1 = Math.max(rCut0 + 0.32, Math.min(0.92, crossR.u + 0.22));

  // Front-Left leg crosses BEHIND Rear Floor Sled Rail (loop 1)
  const uFrontLegBot = opts.segmented ? uFloor + halfSize : uFloor;
  const uFrontLegTop = opts.segmented ? uSeat - inset : uSeat;
  const flBot = vtx(-0.5, 0.5, uFrontLegBot);
  const flTop = vtx(-0.5, 0.5, uFrontLegTop);
  const rf0 = vtx(-0.5, -0.5, uFloor);
  const rf1 = vtx(0.5, -0.5, uFloor);
  const crossL = intersect2D(rf0, rf1, flBot, flTop);
  const zRf = rf0[2] + crossL.t * (rf1[2] - rf0[2]);
  const zFlReal = flBot[2] + crossL.u * (flTop[2] - flBot[2]);
  const jzUnder = zFlReal - zRf + 0.78 * s;
  const lCut0 = Math.max(0.14, Math.min(0.64, crossL.u - 0.22));
  const lCut1 = Math.max(lCut0 + 0.3, Math.min(0.89, crossL.u + 0.22));

  const pilBackLeft = createCubePillarLoop({
    pBot: vtx(-0.5, -0.5, uLegBot),
    pTop: vtx(-0.5, -0.5, uLegTop),
    A,
    B,
    U,
    halfSize,
    chamfer: ch,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    segments: legSegs,
    gap: opts.gap,
    phaseOffset: 0.15,
  });

  const pilFrontRight = createCubePillarLoop({
    pBot: vtx(0.5, 0.5, uFrontLegBot),
    pTop: vtx(0.5, 0.5, uFrontLegTop),
    A,
    B,
    U,
    halfSize,
    chamfer: ch,
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    weldStartTJunctionPerp: !opts.segmented ? A : null,
    weldEnd3Way: isContinuous ? [negA, negB] : null,
    segments: legSegs,
    gap: opts.gap,
    phaseOffset: 0.55,
  });

  const pilBackRight = createCubePillarLoop({
    pBot: brBot,
    pTop: brTop,
    A,
    B,
    U,
    halfSize,
    chamfer: ch,
    portals: [
      [rCut0, jzOver],
      [rCut1, -jzOver],
    ],
    crossOnlyLoop: 0, // overpass over seatLoop (loop 0)
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    segments: legSegs,
    gap: opts.gap,
    phaseOffset: 0.35,
  });

  const pilFrontLeft = createCubePillarLoop({
    pBot: flBot,
    pTop: flTop,
    A,
    B,
    U,
    halfSize,
    chamfer: ch,
    portals: [
      [lCut0, -jzUnder],
      [lCut1, jzUnder],
    ],
    crossOnlyLoop: 3, // underpass under sledChain (loop 1: 2*1 + 1 = 3)
    weldStart: !opts.segmented,
    weldEnd: !opts.segmented,
    weldStartTJunctionPerp: !opts.segmented ? A : null,
    weldEnd3Way: isContinuous ? [A, negB] : null,
    segments: legSegs,
    gap: opts.gap,
    phaseOffset: 0.8,
  });

  return {
    loops: [
      seatLoop,
      sledChain,
      backChain,
      pilBackLeft,
      pilFrontRight,
      pilBackRight,
      pilFrontLeft,
    ],
  };
}

// 22. Reutersvärd's Tribar Y-Pinwheel (9-bar C3-symmetric orthogonal Y-arms folding impossibly around the center)
function buildPinwheel(opts) {
  const s = opts.radius * 0.96;
  const lOut = 2.05 * s;
  const wTip = 0.82 * s;
  const lIn = 1.55 * s;
  const lobeDrop = (lOut + wTip - lIn) / 3;
  const halfSize = opts.thickness * 0.27;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);

  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, lOut],
      [1, 1, wTip],
      [0, -1, lIn],
      [1, 1, lOut],
      [2, 1, wTip],
      [1, -1, lIn],
      [2, 1, lOut],
      [0, 1, wTip],
      [2, -1, lIn],
    ],
    portals: [
      [0, 0.35, lobeDrop],
      [3, 0.35, lobeDrop],
      [6, 0.35, lobeDrop],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(9, Math.round(opts.segments * 1.75)),
    gap: opts.gap,
  });

  return { loops: [loop] };
}

// 23. Impossible Valknut (Odin's Knot — 3 C3-symmetric Penrose triangles interlocked in a 6-crossing Borromean weave)
function buildValknut(opts) {
  const s = opts.radius * 0.96;
  const L = 2.44 * s;
  const halfSize = opts.thickness * 0.195;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const { E, weights } = basis;
  const segs = Math.max(6, Math.round(opts.segments * 1.05));
  const shiftMag = 0.228 * L;
  // Same bar order and cut as the triangle, so each loop welds cleanly at its portal.
  const axSeq = [0, 1, 2];

  const baseAngle0 =
    Math.atan2(
      weights[1] * E[1][1] - weights[2] * E[2][1],
      weights[1] * E[1][0] - weights[2] * E[2][0],
    ) -
    (12 * Math.PI) / 180;

  const starts = [0, 1, 2].map((i) => {
    const b0 = axSeq[i];
    const b1 = axSeq[(i + 1) % 3];
    const ang = baseAngle0 - (i * 2 * Math.PI) / 3;
    return [
      (-L * (2 * weights[b0] * E[b0][0] + weights[b1] * E[b1][0])) / 3 + shiftMag * Math.cos(ang),
      (-L * (2 * weights[b0] * E[b0][1] + weights[b1] * E[b1][1])) / 3 + shiftMag * Math.sin(ang),
    ];
  });
  // Each triangle's outline on screen: its three bars as 2D segments.
  const outlines = starts.map(([x, y], i) => {
    const pts = [[x, y]];
    for (let k = 0; k < 3; k++) {
      const ax = axSeq[(i + k) % 3];
      const [px, py] = pts[k];
      pts.push([px + L * weights[ax] * E[ax][0], py + L * weights[ax] * E[ax][1]]);
    }
    return pts;
  });
  const segDist = (p, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
  };
  // The depth jump must not land where another bar covers this one (it would show as a step), so each triangle is cut
  // at the point of its outline farthest from every other bar.
  const cuts = outlines.map((pts, i) => {
    let best = { d: -1, bar: 0, f: 0.294 };
    for (let bar = 0; bar < 3; bar++) {
      for (let k = 1; k < 100; k++) {
        const f = k / 100;
        const a = pts[bar], b = pts[bar + 1];
        const p = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
        let d = Infinity;
        for (let m = 0; m < 3; m++) if (m !== bar) d = Math.min(d, segDist(p, pts[m], pts[m + 1]));
        outlines.forEach((o, j) => {
          if (j !== i) for (let m = 0; m < 3; m++) d = Math.min(d, segDist(p, o[m], o[m + 1]));
        });
        if (d > best.d) best = { d, bar, f };
      }
    }
    return best;
  });

  const build = (dx, dy) => {
  const loops = [];
  for (let i = 0; i < 3; i++) {
    const b0 = axSeq[i];
    const b1 = axSeq[(i + 1) % 3];
    const b2 = axSeq[(i + 2) % 3];
    const [cx0, cy0] = starts[i];

    loops.push(
      createCubeLatticeLoop({
        bars: [
          [b0, 1, L],
          [b1, 1, L],
          [b2, 1, L],
        ],
        portals: [[cuts[i].bar, cuts[i].f, L]],
        basis,
        halfSize,
        chamfer: opts.chamfer,
        segments: segs,
        gap: opts.gap,
        phaseOffset: i / (3 * segs),
        xyOffset: [cx0 + dx, cy0 + dy],
        zInit: 0,
      }),
    );
  }

  return loops;
  };

  // Centre the three triangles' outline on the origin.
  const probe = Array.from({ length: 8 }, () => new Vector3());
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const loop of build(0, 0)) {
    for (let k = 0; k < 120; k++) {
      loop.sampleCorners(k / 120, 0, probe);
      for (let c = 0; c < (loop.ringCount ?? 4); c++) {
        minX = Math.min(minX, probe[c].x);
        maxX = Math.max(maxX, probe[c].x);
        minY = Math.min(minY, probe[c].y);
        maxY = Math.max(maxY, probe[c].y);
      }
    }
  }
  return { loops: build(-0.5 * (minX + maxX), -0.5 * (minY + maxY)) };
}

// 24. Impossible Crossed Hexagon (6-bar figure-8 cube-lattice hexagon with X-crossed diagonals + 2 rear side pillars)
function buildHexCross(opts) {
  const s = opts.radius * 0.96;
  const L = 1.38 * s;
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);
  const { E, weights } = basis;
  const minW = Math.min(weights[0], weights[1], weights[2]);
  const halfSize = Math.min(opts.thickness * 0.28, L * minW * 0.36);

  const mainSegs = Math.max(8, Math.round(opts.segments * 1.55));
  const postSegs = Math.max(3, Math.round(opts.segments * 0.4));

  // Center V0..V5 hexagon around `(0, 0)` (`V0 = -L * w2 * E[2]`)
  const v0x = -L * weights[2] * E[2][0];
  const v0y = -L * weights[2] * E[2][1];

  const negE0 = [-E[0][0], -E[0][1], -E[0][2]];
  const negE1 = [-E[1][0], -E[1][1], -E[1][2]];
  const negE2 = [-E[2][0], -E[2][1], -E[2][2]];
  const isContinuous = !opts.segmented;

  const mainLoop = createCubeLatticeLoop({
    bars: [
      [0, -1, L],
      [1, -1, 2 * L],
      [0, -1, L],
      [1, 1, L],
      [0, 1, 2 * L],
      [1, 1, L],
    ],
    portals: [
      [2, 0.5, -1.4 * L],
      [5, 0.5, 1.4 * L],
    ],
    basis,
    halfSize,
    chamfer: ch,
    threeWayCornerFn: isContinuous
      ? (barIdx) => (barIdx === 4 ? negE2 : barIdx === 5 ? E[2] : null)
      : null,
    trimCornerAxisFn: isContinuous
      ? (barIdx) => (barIdx === 1 || barIdx === 2 ? 2 : -1)
      : null,
    selfCrossings: true,
    segments: mainSegs,
    gap: opts.gap,
    phaseOffset: 0,
    xyOffset: [v0x, v0y],
    zInit: 0,
  });

  // Sample exact 3D positions of rear-welded corners V4 and V5 from the straight
  // barrel midpoint of Bar 4 (V4 -> V5 along +E[0], avoiding 3-way saddle miter bias).
  const l0 = L * weights[0];
  const l1 = L * weights[1];
  const l2 = L * weights[2];
  const totalLen = 4 * l0 + 4 * l1;
  const sMid4 = (1.5 * l0 + l1) / totalLen;
  const pMid4 = sampleLoopCentroid(mainLoop, sMid4, 1);
  const pV4 = [
    pMid4[0] - l0 * E[0][0],
    pMid4[1] - l0 * E[0][1],
    pMid4[2] - l0 * E[0][2],
  ];
  const pV5 = [
    pMid4[0] + l0 * E[0][0],
    pMid4[1] + l0 * E[0][1],
    pMid4[2] + l0 * E[0][2],
  ];

  const insetStart = opts.segmented ? halfSize : 0;
  const insetEnd = opts.segmented ? halfSize : 0;
  const postSpan = Math.max(2 * halfSize, l2 - insetStart - insetEnd);

  const pilLeft = createCubePillarLoop({
    pBot: [
      pV4[0] + insetStart * negE2[0],
      pV4[1] + insetStart * negE2[1],
      pV4[2] + insetStart * negE2[2],
    ],
    pTop: [
      pV4[0] + (insetStart + postSpan) * negE2[0],
      pV4[1] + (insetStart + postSpan) * negE2[1],
      pV4[2] + (insetStart + postSpan) * negE2[2],
    ],
    A: E[0],
    B: E[1],
    U: negE2,
    halfSize,
    chamfer: ch,
    fixedWorldWeld: true,
    weldStart: isContinuous,
    weldEnd: isContinuous,
    weldStart3Way: isContinuous ? [negE1, E[0]] : null,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    segments: postSegs,
    gap: opts.gap,
    phaseOffset: 0.25,
  });

  const pilRight = createCubePillarLoop({
    pBot: [
      pV5[0] + insetStart * E[2][0],
      pV5[1] + insetStart * E[2][1],
      pV5[2] + insetStart * E[2][2],
    ],
    pTop: [
      pV5[0] + (insetStart + postSpan) * E[2][0],
      pV5[1] + (insetStart + postSpan) * E[2][1],
      pV5[2] + (insetStart + postSpan) * E[2][2],
    ],
    A: E[0],
    B: E[1],
    U: E[2],
    halfSize,
    chamfer: ch,
    fixedWorldWeld: true,
    weldStart: isContinuous,
    weldEnd: isContinuous,
    weldStart3Way: isContinuous ? [negE0, E[1]] : null,
    capStartAlways: Boolean(opts.segmented),
    capEndAlways: Boolean(opts.segmented),
    segments: postSegs,
    gap: opts.gap,
    phaseOffset: 0.65,
  });

  return { loops: [mainLoop, pilLeft, pilRight] };
}

// 25. Impossible Hooked Tribar (12-bar C3-symmetric notched interlocking Penrose triangle)
function buildHookedTribar(opts) {
  const s = opts.radius * 0.9;
  const a = 1.68 * s;
  const d = 0.46 * s;
  const b = 2.52 * s;
  const c = 0.54 * s;
  const lobeDrop = (a - d + b - c) / 3;
  const halfSize = opts.thickness * 0.25;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);

  const bars = [];
  for (const k of [0, 2, 1]) {
    bars.push([k, 1, a]);
    bars.push([(k + 2) % 3, -1, d]);
    bars.push([(k + 1) % 3, 1, b]);
    bars.push([k, -1, c]);
  }

  const loop = createCubeLatticeLoop({
    bars,
    portals: [
      [2, 0.52, lobeDrop],
      [6, 0.52, lobeDrop],
      [10, 0.52, lobeDrop],
    ],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    selfCrossings: true,
    segments: Math.max(9, Math.round(opts.segments * 1.9)),
    gap: opts.gap,
  });

  return { loops: [loop] };
}

// 26. Impossible 6-Pointed Star (12-bar cube-lattice hexagram with asymmetrical +/- lengths closing identically in 2D while winding in 3D Z)
function buildStar(opts) {
  const s = opts.radius * 0.96;
  const baseL = 0.92 * s;
  const bias = 0.18 * s;
  const lp = baseL + bias;
  const lm = baseL - bias;
  const halfSize = opts.thickness * 0.26;
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 23);

  const loop = createCubeLatticeLoop({
    bars: [
      [0, 1, lp],
      [2, 1, lp],
      [1, -1, lm],
      [0, -1, lm],
      [2, 1, lp],
      [1, 1, lp],
      [0, -1, lm],
      [2, -1, lm],
      [1, 1, lp],
      [0, 1, lp],
      [2, -1, lm],
      [1, -1, lm],
    ],
    portals: [[1, 0.5, 4 * bias]],
    basis,
    halfSize,
    chamfer: opts.chamfer,
    segments: Math.max(9, Math.round(opts.segments * 1.85)),
    gap: opts.gap,
  });

  return { loops: [loop] };
}

// 27. Oscar Reutersvärd's 1934 Impossible Triangle of Floating Cubes (9 isometric cubes along a Penrose triangle)
function buildReutersvard(opts) {
  const s = opts.radius * 1.02;
  const L = 2.48 * s;
  const halfSize = Math.min(opts.thickness * 0.42, L * 0.118);
  const ch = Math.max(0, Math.min(0.45, opts.chamfer || 0));
  const basis = makeCubeLatticeBasis(opts.tilt, opts.roll - 53);
  const { E, weights } = basis;

  if (opts.segmented) {
    const loop = createCubeLatticeLoop({
      bars: [
        [0, 1, L],
        [1, 1, L],
        [2, 1, L],
      ],
      portals: [[0, 0.5, L]],
      basis,
      halfSize,
      chamfer: ch,
      segments: 9,
      gap: 0.34,
    });
    return { loops: [loop] };
  }

  // In continuous mode, place the 9 discrete floating isometric cubes (`3` per side) along the 3D staircase spiral
  // centered around `(0, 0, 0)` so orbiting reveals the forced-perspective Ames spiral of 9 cubes!
  const l0 = L * weights[0];
  const l1 = L * weights[1];
  const l2 = L * weights[2];
  const vx1 = l0 * E[0][0];
  const vy1 = l0 * E[0][1];
  const vx2 = vx1 + l1 * E[1][0];
  const vy2 = vy1 + l1 * E[1][1];
  const cx0 = -(vx1 + vx2) / 3;
  const cy0 = -(vy1 + vy2) / 3;

  const sideLens = [l0, l1, l2];
  const zTotalDrop = l0 * E[0][2] + l1 * E[1][2] + l2 * E[2][2];
  let curX = cx0;
  let curY = cy0;
  let curZ = -0.5 * zTotalDrop * (8 / 9);

  const loops = [];
  for (let side = 0; side < 3; side++) {
    const U = E[side];
    const A = E[(side + 1) % 3];
    const B = E[(side + 2) % 3];
    const stepLen = sideLens[side] / 3;
    const cubeHalf = Math.min(halfSize, stepLen * 0.34);

    for (let j = 0; j < 3; j++) {
      const cx = curX + j * stepLen * U[0];
      const cy = curY + j * stepLen * U[1];
      const cz = curZ + j * stepLen * U[2];
      loops.push(
        createCubePillarLoop({
          pBot: [cx - cubeHalf * U[0], cy - cubeHalf * U[1], cz - cubeHalf * U[2]],
          pTop: [cx + cubeHalf * U[0], cy + cubeHalf * U[1], cz + cubeHalf * U[2]],
          A,
          B,
          U,
          halfSize: cubeHalf,
          chamfer: ch,
          capStartAlways: true,
          capEndAlways: true,
          segments: 1,
          gap: 0.34,
        }),
      );
    }
    curX += sideLens[side] * U[0];
    curY += sideLens[side] * U[1];
    curZ += sideLens[side] * U[2];
  }

  return { loops };
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export const OBJECTS = {
  ring: { label: "ring", build: buildRing },
  "figure-8": { label: "figure-8", build: buildFigure8 },
  trefoil: { label: "trefoil", build: buildTrefoil },
  triangle: { label: "triangle", build: buildTriangle },
  square: { label: "square", build: buildSquare },
  diamond: { label: "diamond", build: buildDiamond },
  "divided-diamond": { label: "divided-diamond", build: buildDividedDiamond },
  pentagon: { label: "pentagon", build: buildPentagon },
  hexagon: { label: "hexagon", build: buildHexagon },
  star: { label: "star", build: buildStar },
  "reutersvard": { label: "reutersvard", build: buildReutersvard },
  valknut: { label: "valknut", build: buildValknut },
  "hex-cross": { label: "hex-cross", build: buildHexCross },
  "hooked-tribar": { label: "hooked-tribar", build: buildHookedTribar },
  stairs: { label: "stairs", build: buildStairs },
  waterfall: { label: "waterfall", build: buildWaterfall },
  "escher-cube": { label: "escher-cube", build: buildEscherCube },
  archway: { label: "archway", build: buildArchway },
  ladder: { label: "ladder", build: buildLadder },
  chair: { label: "chair", build: buildChair },
  cross: { label: "cross", build: buildCross },
  pinwheel: { label: "pinwheel", build: buildPinwheel },
  frame: { label: "frame", build: buildFrame },
  "s-hook": { label: "s-hook", build: buildSHook },
  meander: { label: "meander", build: buildMeander },
  "spiral-tribar": { label: "spiral-tribar", build: buildSpiralTribar },
  triquetra: { label: "triquetra", build: buildTriquetra },
  "double-tribar": { label: "double-tribar", build: buildDoubleTribar },
  borromean: { label: "borromean", build: buildBorromean },
  "borromean-tribar": { label: "borromean-tribar", build: buildBorromeanTribar },
  hourglass: { label: "hourglass", build: buildHourglass },
};

export const OBJECT_NAMES = Object.keys(OBJECTS);
