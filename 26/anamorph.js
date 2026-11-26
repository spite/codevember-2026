import {
  BufferGeometry,
  BufferAttribute,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  LineSegments,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Vector3,
  Vector4,
} from "three";

// Sweet-Spot Orthographic Anamorphic Segment & Solid Rig.
// Supports multi-portal sightline splits (`loop.splits`), unbroken-prism Sutherland-Hodgman
// sightline-plane half-space clipping (`loop.portalZones`), sharp 90° mitered corners,
// and smooth C^inf sweet-spot normals (`loop.sampleWallNormals`), with zero per-frame heap allocations.

const MAX_RING = 8;
const MAX_STEPS = 220;
const MAX_EXTRA_STATIONS = 56;
const MAX_SLICES = MAX_STEPS + MAX_EXTRA_STATIONS + 6;
const MAX_MESH_VERTS = MAX_RING * (MAX_SLICES - 1) * 6 + 512;
const MAX_EDGE_VERTS = MAX_RING * (MAX_SLICES - 1) * 2 + (MAX_EXTRA_STATIONS + 24) * 16 + 256;
const MAX_CUT_CHORDS = 512;
const MAX_SHADOW_BOXES = 220;
const SHADOW_TEX_ROWS = 13;
const CROSS_TABLE_STRIDE = 14;

const EDGE_BIAS = 0.0042;
const EPS_SPLIT = 1e-6;

const _sample = {
  pos: new Vector3(),
  a: new Vector3(),
  b: new Vector3(),
};
const _d1 = new Vector3();
const _d2 = new Vector3();
const _fn = new Vector3();
const _n0 = new Vector3();
const _n1 = new Vector3();
const _sn0 = new Vector3();
const _sn1 = new Vector3();
const _capNormal = new Vector3();
const _geomCapNormal = new Vector3();
const _bias = new Vector3();
const _cBias0 = new Vector3();
const _cBias1 = new Vector3();

const _sValues = new Float64Array(MAX_SLICES);
const _isSharp = new Uint8Array(MAX_SLICES);
const _isCollar = new Uint8Array(MAX_SLICES);
const _ringPts = Array.from({ length: MAX_SLICES }, () =>
  Array.from({ length: MAX_RING }, () => new Vector3()),
);
const _wallNormals = Array.from({ length: MAX_SLICES }, () =>
  Array.from({ length: MAX_RING }, () => new Vector3()),
);
const _geomSliceNormals = Array.from({ length: MAX_RING }, () => new Vector3());
const _customSliceNormals = Array.from({ length: MAX_SLICES }, () =>
  Array.from({ length: MAX_RING }, () => new Vector3()),
);
const _spanHasWall = Array.from({ length: MAX_SLICES }, () => new Uint8Array(MAX_RING));
const _cornerOut = Array.from({ length: MAX_SLICES }, () =>
  Array.from({ length: MAX_RING }, () => new Vector3()),
);
const _guardPrevPts = Array.from({ length: MAX_RING }, () => new Vector3());
const _guardNextPts = Array.from({ length: MAX_RING }, () => new Vector3());
const _guardPrevNormals = Array.from({ length: MAX_RING }, () => new Vector3());
const _guardNextNormals = Array.from({ length: MAX_RING }, () => new Vector3());
const _subSpans = [];
const _subSpansPool = [];
const _portalCuts = new Float64Array(64);
const _specS = new Float64Array(256);
const _specSharp = new Uint8Array(256);
const _specCollar = new Uint8Array(256);
const _uniqS = new Float64Array(256);
const _uniqSharp = new Uint8Array(256);
const _uniqCollar = new Uint8Array(256);

function markAttrUpdated(attr, floatCount) {
  if (floatCount <= 0) return;
  const ranges = attr.updateRanges;
  if (ranges) {
    let r = attr._singleRange;
    if (!r) {
      r = { start: 0, count: floatCount };
      attr._singleRange = r;
    } else {
      r.start = 0;
      r.count = floatCount;
    }
    ranges.length = 0;
    ranges.push(r);
  }
  attr.needsUpdate = true;
}

// Scratch raw buffers for unbroken prism assembly before optional Sutherland-Hodgman clipping
const _rawPos = new Float32Array(MAX_MESH_VERTS * 3);
const _rawNorm = new Float32Array(MAX_MESH_VERTS * 3);
const _rawSweetNorm = new Float32Array(MAX_MESH_VERTS * 3);
const _rawTag = new Float32Array(MAX_MESH_VERTS * 4);
const _rawEdge = new Float32Array(MAX_EDGE_VERTS * 3);
// Loop position of each raw edge endpoint, so edges are clipped at sightline cuts by the same rule as the mesh.
const _rawEdgeS = new Float32Array(MAX_EDGE_VERTS);
const _cutChords = new Float32Array(MAX_CUT_CHORDS * 6);
const _polyPos = new Float32Array(4 * 3);
const _polyNorm = new Float32Array(4 * 3);
const _polySweetNorm = new Float32Array(4 * 3);
const _polyTag = new Float32Array(4 * 4);
const _barCutScratch = [];

const _obbPts0 = Array.from({ length: MAX_RING }, () => new Vector3());
const _obbPts1 = Array.from({ length: MAX_RING }, () => new Vector3());
const _obbPtsMid = Array.from({ length: MAX_RING }, () => new Vector3());
const _obbC0 = new Vector3();
const _obbC1 = new Vector3();
const _obbCMid = new Vector3();
const _obbU = new Vector3();
const _obbV = new Vector3();
const _obbW = new Vector3();
const _obbN1 = new Vector3();
const _obbN2 = new Vector3();
const _obbDual1 = new Vector3();
const _obbDual2 = new Vector3();
const _obbCap0 = new Vector3();
const _obbCap1 = new Vector3();
const _obbCap0b = new Vector3();
const _obbCap1b = new Vector3();
const _saddleMids = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _saddleW0 = new Vector3();
const _saddleW1 = new Vector3();
const _saddleD = [0, 0];

function extractSaddleCapPlanes(pts, ringCount, zOffset, cx, cy, cz, obbU, outSign, outNa, outNb, outD) {
  for (let w = 0; w < 4; w++) {
    const i0 = ringCount === 8 ? w * 2 : w;
    const i1 = ringCount === 8 ? w * 2 + 1 : (w + 1) & 3;
    _saddleMids[w].set(
      0.5 * (pts[i0].x + pts[i1].x) - cx,
      0.5 * (pts[i0].y + pts[i1].y) - cy,
      0.5 * (pts[i0].z + pts[i1].z) + zOffset - cz,
    );
  }
  const u0 = _saddleMids[0].dot(obbU) * outSign;
  const u1 = _saddleMids[1].dot(obbU) * outSign;
  const u2 = _saddleMids[2].dot(obbU) * outSign;
  const u3 = _saddleMids[3].dot(obbU) * outSign;
  const outer02 = u0 > u2 ? 0 : 2;
  const inner02 = 2 - outer02;
  const outer13 = u1 > u3 ? 1 : 3;
  const inner13 = 4 - outer13;

  const fitOne = (outerWall, innerMid, outN) => {
    const aIdx = ringCount === 8 ? outerWall * 2 : outerWall;
    const bIdx = ringCount === 8 ? outerWall * 2 + 1 : (outerWall + 1) & 3;
    _saddleW0.set(pts[aIdx].x - cx, pts[aIdx].y - cy, pts[aIdx].z + zOffset - cz);
    _saddleW1.set(pts[bIdx].x - cx, pts[bIdx].y - cy, pts[bIdx].z + zOffset - cz);
    _d1.subVectors(_saddleW1, _saddleW0);
    _d2.subVectors(innerMid, _saddleW0);
    outN.crossVectors(_d1, _d2);
    const len = outN.length();
    if (len < 1e-10) {
      outN.copy(obbU).multiplyScalar(outSign);
    } else {
      outN.multiplyScalar(1 / len);
      if (outN.dot(obbU) * outSign < 0) outN.negate();
    }
    return _saddleW0.dot(outN);
  };

  outD[0] = fitOne(outer02, _saddleMids[inner13], outNa);
  outD[1] = fitOne(outer13, _saddleMids[inner02], outNb);
}

function wrapHalf(x) {
  let r = (x + 0.5) % 1;
  if (r < 0) r += 1;
  return r - 0.5;
}

function packLoopBarId(loopId, hasPortals, selfCross, numBars, barId) {
  return (
    loopId * 16384 +
    (selfCross ? 8192 : 0) +
    (hasPortals ? 4096 : 0) +
    numBars * 64 +
    (barId >= 0 ? barId : 63)
  );
}

function smooth01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function writeVertex(posArr, normArr, sweetNormArr, tagArr, idx, p, n, sn, loopId, sVal, zPortal, lapJump) {
  const o = idx * 3;
  posArr[o] = p.x;
  posArr[o + 1] = p.y;
  posArr[o + 2] = p.z;
  normArr[o] = n.x;
  normArr[o + 1] = n.y;
  normArr[o + 2] = n.z;
  sweetNormArr[o] = sn.x;
  sweetNormArr[o + 1] = sn.y;
  sweetNormArr[o + 2] = sn.z;
  const to = idx * 4;
  tagArr[to] = loopId;
  tagArr[to + 1] = sVal;
  tagArr[to + 2] = zPortal;
  tagArr[to + 3] = lapJump;
}

function writeEdge(edgeArr, eIdx, p0, b0, p1, b1, s0 = NaN, s1 = s0) {
  _rawEdgeS[eIdx * 2] = s0;
  _rawEdgeS[eIdx * 2 + 1] = s1;
  const o = eIdx * 6;
  edgeArr[o] = p0.x + b0.x;
  edgeArr[o + 1] = p0.y + b0.y;
  edgeArr[o + 2] = p0.z + b0.z;
  edgeArr[o + 3] = p1.x + b1.x;
  edgeArr[o + 4] = p1.y + b1.y;
  edgeArr[o + 5] = p1.z + b1.z;
}

function evalSliceCorners(loop, s, side, dst, depthScale, cornerSampler = null) {
  const ringCount = loop.ringCount ?? 4;
  if (cornerSampler) {
    cornerSampler(s, side, dst);
  } else if (loop.sampleCorners) {
    loop.sampleCorners(s, side, dst);
  } else {
    loop.sample(s, side, _sample);
    const { pos, a, b } = _sample;
    if (ringCount === 8) {
      const k1 = 1 - (loop.chamfer ?? 0);
      dst[0].set(pos.x - k1 * a.x - b.x, pos.y - k1 * a.y - b.y, pos.z - k1 * a.z - b.z);
      dst[1].set(pos.x + k1 * a.x - b.x, pos.y + k1 * a.y - b.y, pos.z + k1 * a.z - b.z);
      dst[2].set(pos.x + a.x - k1 * b.x, pos.y + a.y - k1 * b.y, pos.z + a.z - k1 * b.z);
      dst[3].set(pos.x + a.x + k1 * b.x, pos.y + a.y + k1 * b.y, pos.z + a.z + k1 * b.z);
      dst[4].set(pos.x + k1 * a.x + b.x, pos.y + k1 * a.y + b.y, pos.z + k1 * a.z + b.z);
      dst[5].set(pos.x - k1 * a.x + b.x, pos.y - k1 * a.y + b.y, pos.z - k1 * a.z + b.z);
      dst[6].set(pos.x - a.x + k1 * b.x, pos.y - a.y + k1 * b.y, pos.z - a.z + k1 * b.z);
      dst[7].set(pos.x - a.x - k1 * b.x, pos.y - a.y - k1 * b.y, pos.z - a.z - k1 * b.z);
    } else {
      dst[0].set(pos.x - a.x - b.x, pos.y - a.y - b.y, pos.z - a.z - b.z);
      dst[1].set(pos.x + a.x - b.x, pos.y + a.y - b.y, pos.z + a.z - b.z);
      dst[2].set(pos.x + a.x + b.x, pos.y + a.y + b.y, pos.z + a.z + b.z);
      dst[3].set(pos.x - a.x + b.x, pos.y - a.y + b.y, pos.z - a.z + b.z);
    }
  }
  if (depthScale !== 1) {
    for (let c = 0; c < ringCount; c++) {
      dst[c].z *= depthScale;
    }
  }
}

// Diagonal cross-product (p11 - p00) x (p10 - p01): exact outward normal even when one edge collapses to a point.
function computeSpanWallNormals(pts0, pts1, ringCount, outNormals, outValid) {
  for (let w = 0; w < ringCount; w++) {
    const w1 = w + 1 === ringCount ? 0 : w + 1;
    const p00 = pts0[w];
    const p01 = pts0[w1];
    const p10 = pts1[w];
    const p11 = pts1[w1];
    _d1.subVectors(p11, p00);
    _d2.subVectors(p10, p01);
    _fn.crossVectors(_d1, _d2);
    const lenSq = _fn.lengthSq();
    if (lenSq > 1e-14) {
      _fn.multiplyScalar(1 / Math.sqrt(lenSq));
      outNormals[w].copy(_fn);
      if (outValid) outValid[w] = 1;
    } else {
      outNormals[w].set(0, 0, 0);
      if (outValid) outValid[w] = 0;
    }
  }
}

function shrinkRingToCentroid(pts, ringCount, scale) {
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let c = 0; c < ringCount; c++) {
    mx += pts[c].x;
    my += pts[c].y;
    mz += pts[c].z;
  }
  const inv = 1 / ringCount;
  mx *= inv;
  my *= inv;
  mz *= inv;
  for (let c = 0; c < ringCount; c++) {
    pts[c].set(
      mx + (pts[c].x - mx) * scale,
      my + (pts[c].y - my) * scale,
      mz + (pts[c].z - mz) * scale,
    );
  }
}

function computePolygonCapNormal(pts, ringCount, reverse, outNormal) {
  outNormal.set(0, 0, 0);
  const p0 = pts[0];
  for (let k = 1; k < ringCount - 1; k++) {
    _d1.subVectors(pts[k], p0);
    _d2.subVectors(pts[k + 1], p0);
    if (reverse) _fn.crossVectors(_d2, _d1);
    else _fn.crossVectors(_d1, _d2);
    outNormal.add(_fn);
  }
  const lenSq = outNormal.lengthSq();
  if (lenSq > 1e-14) {
    outNormal.multiplyScalar(1 / Math.sqrt(lenSq));
    return true;
  }
  return false;
}

// Builds sorted slice stations inside [sA, sB], inserting exact corner, hinge, and optional cap-collar stations.
function buildStations(
  loop,
  sA,
  sB,
  baseSteps,
  cornersOverride = null,
  hingesOverride = null,
  periodic = true,
  collarStartS = -Infinity,
  collarEndS = Infinity,
  forceSubdivide = false,
  threeWayCornersOverride = null,
) {
  const span = sB - sA;
  const corners = cornersOverride ?? loop.corners;
  const threeWayCorners = threeWayCornersOverride ?? loop.threeWayCorners;
  const hinges = hingesOverride ?? loop.hinges;

  let specLen = 0;
  const pushSpec = (sVal, sharpVal, collarVal) => {
    if (specLen < 256) {
      _specS[specLen] = sVal;
      _specSharp[specLen] = sharpVal;
      _specCollar[specLen] = collarVal;
      specLen++;
    }
  };

  const isThreeWay = (cVal) => {
    if (!threeWayCorners || threeWayCorners.length === 0) return false;
    for (let ti = 0; ti < threeWayCorners.length; ti++) {
      if (Math.abs(cVal - threeWayCorners[ti]) < 1e-5) return true;
    }
    return false;
  };

  if (collarStartS > sA + 1e-6 && collarStartS < sB - 1e-6) {
    pushSpec(collarStartS, 1, 1);
  }
  if (collarEndS > sA + 1e-6 && collarEndS < sB - 1e-6 && collarEndS > collarStartS + 1e-6) {
    pushSpec(collarEndS, 1, 1);
  }
  if (periodic) {
    const kMin = Math.floor(sA) - 1;
    const kMax = Math.ceil(sB) + 1;
    if (corners && corners.length > 0) {
      for (let k = kMin; k <= kMax; k++) {
        for (let ci = 0; ci < corners.length; ci++) {
          const sc = k + corners[ci];
          if (isThreeWay(corners[ci])) {
            const sPre = sc - 2e-6;
            const sPost = sc + 2e-6;
            if (sPre > sA + 1e-6 && sPre < sB - 1e-6) pushSpec(sPre, 2, 0);
            if (sPost > sA + 1e-6 && sPost < sB - 1e-6) pushSpec(sPost, 3, 0);
          } else if (sc > sA + 1e-6 && sc < sB - 1e-6) {
            pushSpec(sc, 1, 0);
          }
        }
      }
    }
    if (hinges && hinges.length > 0) {
      for (let k = kMin; k <= kMax; k++) {
        for (let hi = 0; hi < hinges.length; hi++) {
          const sh = k + hinges[hi];
          if (sh > sA + 1e-6 && sh < sB - 1e-6) pushSpec(sh, 1, 0);
        }
      }
    }
  } else {
    if (corners && corners.length > 0) {
      for (let ci = 0; ci < corners.length; ci++) {
        const sc = corners[ci];
        if (isThreeWay(sc)) {
          const sPre = sc - 2e-6;
          const sPost = sc + 2e-6;
          if (sPre > sA + 1e-6 && sPre < sB - 1e-6) pushSpec(sPre, 2, 0);
          if (sPost > sA + 1e-6 && sPost < sB - 1e-6) pushSpec(sPost, 3, 0);
        } else if (sc > sA + 1e-6 && sc < sB - 1e-6) {
          pushSpec(sc, 1, 0);
        }
      }
    }
    if (hinges && hinges.length > 0) {
      for (let hi = 0; hi < hinges.length; hi++) {
        const sh = hinges[hi];
        if (sh > sA + 1e-6 && sh < sB - 1e-6) pushSpec(sh, 1, 0);
      }
    }
  }

  if (specLen === 0) {
    const steps = Math.max(1, Math.min(MAX_STEPS, baseSteps));
    for (let i = 0; i <= steps; i++) {
      _sValues[i] = sA + (span * i) / steps;
      _isSharp[i] = 0;
      _isCollar[i] = 0;
    }
    return steps + 1;
  }

  for (let i = 1; i < specLen; i++) {
    const ks = _specS[i];
    const ksh = _specSharp[i];
    const kco = _specCollar[i];
    let j = i - 1;
    while (j >= 0 && _specS[j] > ks) {
      _specS[j + 1] = _specS[j];
      _specSharp[j + 1] = _specSharp[j];
      _specCollar[j + 1] = _specCollar[j];
      j--;
    }
    _specS[j + 1] = ks;
    _specSharp[j + 1] = ksh;
    _specCollar[j + 1] = kco;
  }

  let uniqLen = 0;
  for (let i = 0; i < specLen; i++) {
    const curS = _specS[i];
    if (uniqLen > 0 && Math.abs(curS - _uniqS[uniqLen - 1]) < 1e-6) {
      _uniqSharp[uniqLen - 1] |= _specSharp[i];
      _uniqCollar[uniqLen - 1] |= _specCollar[i];
    } else {
      _uniqS[uniqLen] = curS;
      _uniqSharp[uniqLen] = _specSharp[i];
      _uniqCollar[uniqLen] = _specCollar[i];
      uniqLen++;
    }
  }

  let count = 0;
  const pushStation = (sVal, sharpVal, collarVal = 0) => {
    if (count < MAX_SLICES) {
      _sValues[count] = sVal;
      _isSharp[count] = sharpVal;
      _isCollar[count] = collarVal;
      count++;
    }
  };

  const isLinearBars = Boolean(loop.flatShaded);
  let prevS = sA;
  pushStation(sA, 1, 0);

  for (let i = 0; i <= uniqLen; i++) {
    const nextS = i < uniqLen ? _uniqS[i] : sB;
    const nextSharp = i < uniqLen ? _uniqSharp[i] : 1;
    const nextCollar = i < uniqLen ? _uniqCollar[i] : 0;
    const subSpan = nextS - prevS;
    const inCollarBand = nextS <= collarStartS + 1e-6 || prevS >= collarEndS - 1e-6;
    const subSteps =
      (isLinearBars && !forceSubdivide) || inCollarBand
        ? 1
        : Math.max(1, Math.round((subSpan / Math.max(1e-6, span)) * baseSteps));
    for (let j = 1; j < subSteps; j++) {
      pushStation(prevS + (subSpan * j) / subSteps, 0, 0);
    }
    if (subSpan > 1e-7) {
      pushStation(nextS, nextSharp, nextCollar);
    }
    prevS = nextS;
  }

  return count;
}

// Assembles a 3D prism over [sA, sB] into scratch `_rawPos`, `_rawNorm`, `_rawEdge` buffers.
function buildRawPrism(
  loop,
  sA,
  sB,
  {
    stepsOverride = null,
    capStart = true,
    capEnd = true,
    edgeStart = true,
    edgeEnd = true,
    chamferCapStart = false,
    chamferCapEnd = false,
    smoothPortalStart = false,
    smoothPortalEnd = false,
    depthScale = 1,
    offAxisBlend = 0,
    cornerSampler = null,
    cornersOverride = null,
    threeWayCornersOverride = null,
    hingesOverride = null,
    periodicSpecials = true,
    forceSubdivide = false,
    loopId = 0,
    loopInfo = null,
    fixedZPortal = null,
    blockA = sA,
    blockB = sB,
    blockCapStart = chamferCapStart,
    blockCapEnd = chamferCapEnd,
    capChamferStart = 1,
    capChamferEnd = 1,
  } = {},
) {
  const ringCount = loop.ringCount ?? 4;
  const chamfer = loop.chamfer ?? 0;
  // Collars are sized and placed on the whole block, so a block cut at a portal keeps one continuous taper.
  const cA = blockA;
  const cB = blockB;
  const spanLen = cB - cA;
  const activeCrn = cornersOverride ?? loop.corners;
  const activeHng = hingesOverride ?? loop.hinges;

  // Fade cap collar smoothly when a block cap lands right inside a 90° corner miter zone,
  // and clamp collar span so it never crosses an interior corner or hinge.
  let startCapScale = chamfer * capChamferStart;
  let endCapScale = chamfer * capChamferEnd;
  let maxStartDs = spanLen * 0.28;
  let maxEndDs = spanLen * 0.28;

  if (chamfer > 1e-4 && activeCrn && activeCrn.length > 0) {
    let wedgeS = 0.03;
    if (activeHng && activeHng.length > 0) {
      let minWh = Infinity;
      for (let ci = 0; ci < activeCrn.length; ci++) {
        for (let hi = 0; hi < activeHng.length; hi++) {
          const d = Math.abs(
            periodicSpecials
              ? wrapHalf(activeCrn[ci] - activeHng[hi])
              : activeCrn[ci] - activeHng[hi],
          );
          if (d > 1e-5 && d < minWh) minWh = d;
        }
      }
      if (minWh < 0.25) wedgeS = minWh * 1.15;
    }

    let minDistA = Infinity;
    let minDistB = Infinity;
    for (let ci = 0; ci < activeCrn.length; ci++) {
      const cVal = activeCrn[ci];
      const dA = Math.abs(periodicSpecials ? wrapHalf(cA - cVal) : cA - cVal);
      const dB = Math.abs(periodicSpecials ? wrapHalf(cB - cVal) : cB - cVal);
      if (dA < minDistA) minDistA = dA;
      if (dB < minDistB) minDistB = dB;
    }
    if (minDistA < wedgeS) {
      startCapScale *= Math.max(0, (minDistA - wedgeS * 0.45) / (wedgeS * 0.55));
    }
    if (minDistB < wedgeS) {
      endCapScale *= Math.max(0, (minDistB - wedgeS * 0.45) / (wedgeS * 0.55));
    }

    // Clamp collar stations before the first / after the last interior corner or hinge
    const checkInterior = (arr) => {
      if (!arr) return;
      if (periodicSpecials) {
        const kMin = Math.floor(cA) - 1;
        const kMax = Math.ceil(cB) + 1;
        for (let k = kMin; k <= kMax; k++) {
          for (let j = 0; j < arr.length; j++) {
            const sv = k + arr[j];
            if (sv > cA + 1e-5 && sv < cB - 1e-5) {
              maxStartDs = Math.min(maxStartDs, (sv - cA) * 0.65);
              maxEndDs = Math.min(maxEndDs, (cB - sv) * 0.65);
            }
          }
        }
      } else {
        for (let j = 0; j < arr.length; j++) {
          const sv = arr[j];
          if (sv > cA + 1e-5 && sv < cB - 1e-5) {
            maxStartDs = Math.min(maxStartDs, (sv - cA) * 0.65);
            maxEndDs = Math.min(maxEndDs, (cB - sv) * 0.65);
          }
        }
      }
    };
    checkInterior(activeCrn);
    checkInterior(activeHng);
  }

  // collarS is the loop's 45° bevel length: absolute, so long pieces get the same bevel as short blocks.
  const baseCollarDs = loop.collarS ?? spanLen * 0.12;
  const startDs = Math.min(maxStartDs, baseCollarDs * (chamfer > 1e-5 ? startCapScale / chamfer : 0));
  const endDs = Math.min(maxEndDs, baseCollarDs * (chamfer > 1e-5 ? endCapScale / chamfer : 0));
  const hasStartZone = blockCapStart && startCapScale > 1e-3 && startDs > 2e-4 && spanLen > 1e-4;
  const hasEndZone =
    blockCapEnd &&
    endCapScale > 1e-3 &&
    endDs > 2e-4 &&
    spanLen > 1e-4 &&
    cB - endDs > (hasStartZone ? cA + startDs + 2e-4 : cA + 2e-4);
  const collarStartS = hasStartZone ? cA + startDs : -Infinity;
  const collarEndS = hasEndZone ? cB - endDs : Infinity;
  const doCollarStart = hasStartZone && sA < collarStartS - 1e-6;
  const doCollarEnd = hasEndZone && sB > collarEndS + 1e-6;
  const collarShrink = (s) => {
    let k = 0;
    if (hasStartZone) k = Math.max(k, startCapScale * Math.min(1, Math.max(0, 1 - (s - cA) / startDs)));
    if (hasEndZone) k = Math.max(k, endCapScale * Math.min(1, Math.max(0, 1 - (cB - s) / endDs)));
    return k;
  };

  const baseSteps = Math.min(MAX_STEPS, Math.max(1, stepsOverride ?? loop.steps ?? 20));
  const sliceCount = buildStations(
    loop,
    sA,
    sB,
    baseSteps,
    cornersOverride,
    hingesOverride,
    periodicSpecials,
    collarStartS,
    collarEndS,
    forceSubdivide,
    threeWayCornersOverride,
  );
  const spanCount = sliceCount - 1;

  for (let i = 0; i < sliceCount; i++) {
    const side =
      _isSharp[i] === 2 ? -1 : _isSharp[i] === 3 ? 1 : i === 0 ? 1 : i === spanCount ? -1 : 1;
    evalSliceCorners(loop, _sValues[i], side, _ringPts[i], depthScale, cornerSampler);
  }

  if ((doCollarStart || doCollarEnd) && sliceCount >= 2) {
    for (let i = 0; i < sliceCount; i++) {
      const k = collarShrink(_sValues[i]);
      if (k > 1e-6) shrinkRingToCentroid(_ringPts[i], ringCount, 1 - k);
    }
  }

  const skipWallFn = loop.skipSpanWall;
  for (let i = 0; i < spanCount; i++) {
    if (_isSharp[i] === 2 && _isSharp[i + 1] === 3) {
      for (let w = 0; w < ringCount; w++) {
        _wallNormals[i][w].set(0, 0, 0);
        _spanHasWall[i][w] = 0;
      }
      continue;
    }
    computeSpanWallNormals(_ringPts[i], _ringPts[i + 1], ringCount, _wallNormals[i], _spanHasWall[i]);
    if (skipWallFn) {
      const sMid = 0.5 * (_sValues[i] + _sValues[i + 1]);
      for (let w = 0; w < ringCount; w++) {
        if (_spanHasWall[i][w] && skipWallFn(sMid, w, _wallNormals[i][w])) {
          _spanHasWall[i][w] = false;
        }
      }
    }
  }

  // Fallback normal propagation if a hinge shoulder has a collapsed wall on one side of a corner
  for (let i = 1; i < spanCount; i++) {
    for (let w = 0; w < ringCount; w++) {
      if (!_spanHasWall[i][w] && _spanHasWall[i - 1][w]) {
        _wallNormals[i][w].copy(_wallNormals[i - 1][w]);
      }
    }
  }
  for (let i = spanCount - 2; i >= 0; i--) {
    for (let w = 0; w < ringCount; w++) {
      if (!_spanHasWall[i][w] && _spanHasWall[i + 1][w]) {
        _wallNormals[i][w].copy(_wallNormals[i + 1][w]);
      }
    }
  }

  // Guard slices across smooth curved portals (e.g. `figure-8` s = 0/1) so shading normals don't kink
  const flatShaded = Boolean(loop.flatShaded);
  const dsGuard = spanCount > 0 ? (_sValues[spanCount] - _sValues[0]) / Math.max(1, spanCount) : 0.005;
  if (!flatShaded && smoothPortalStart && dsGuard > 1e-7) {
    evalSliceCorners(loop, sA - dsGuard, -1, _guardPrevPts, depthScale, cornerSampler);
    computeSpanWallNormals(_guardPrevPts, _ringPts[0], ringCount, _guardPrevNormals, null);
  }
  if (!flatShaded && smoothPortalEnd && dsGuard > 1e-7) {
    evalSliceCorners(loop, sB + dsGuard, 1, _guardNextPts, depthScale, cornerSampler);
    computeSpanWallNormals(_ringPts[spanCount], _guardNextPts, ringCount, _guardNextNormals, null);
  }

  let barrelFirst = 0;
  while (barrelFirst < spanCount && _sValues[barrelFirst] < collarStartS - 1e-6) barrelFirst++;
  let barrelLast = spanCount;
  while (barrelLast > barrelFirst && _sValues[barrelLast] > collarEndS + 1e-6) barrelLast--;
  const useCustomWallNormals = typeof loop.sampleWallNormals === "function";
  if (useCustomWallNormals) {
    for (let i = barrelFirst; i <= barrelLast; i++) {
      const side = i === barrelFirst ? 1 : i === barrelLast ? -1 : 1;
      for (let w = 0; w < ringCount; w++) {
        if (i > barrelFirst && i < barrelLast) {
          _geomSliceNormals[w].addVectors(_wallNormals[i - 1][w], _wallNormals[i][w]).normalize();
        } else if (i === barrelFirst && i < spanCount) {
          _geomSliceNormals[w].copy(_wallNormals[i][w]);
        } else {
          _geomSliceNormals[w].copy(_wallNormals[Math.max(0, i - 1)][w]);
        }
      }
      loop.sampleWallNormals(
        _sValues[i],
        side,
        offAxisBlend,
        _geomSliceNormals,
        _customSliceNormals[i],
        ringCount,
      );
    }
  }

  // Compute outward wireframe bias vector at every slice corner from physical adjacent wall normals
  for (let i = 0; i < sliceCount; i++) {
    for (let cr = 0; cr < ringCount; cr++) {
      const wPrev = cr === 0 ? ringCount - 1 : cr - 1;
      const wCurr = cr;
      _bias.set(0, 0, 0);
      if (i > 0) {
        _bias.add(_wallNormals[i - 1][wPrev]).add(_wallNormals[i - 1][wCurr]);
      }
      if (i < spanCount) {
        _bias.add(_wallNormals[i][wPrev]).add(_wallNormals[i][wCurr]);
      }
      const lenSq = _bias.lengthSq();
      if (lenSq > 1e-12) {
        _bias.multiplyScalar(EDGE_BIAS / Math.sqrt(lenSq));
      } else {
        _bias.set(0, 0, EDGE_BIAS);
      }
      _cornerOut[i][cr].copy(_bias);
    }
  }

  const useCustomCapNormal = typeof loop.sampleCapNormal === "function";
  const lapJump = loopInfo ? loopInfo.lapJump : 0;
  const numBars = loopInfo ? loopInfo.numBars : 0;
  const hasPortals = Boolean(loopInfo && loopInfo.hasPortals);
  const selfCross = Boolean(loopInfo && loopInfo.selfCross);
  const evalZPortal = (sVal, side) =>
    fixedZPortal !== null ? fixedZPortal : loopInfo ? loopInfo.cumPortalZ(sVal, side) : 0;
  const evalPackedId = (sVal, side) =>
    packLoopBarId(loopId, hasPortals, selfCross, numBars, loopInfo ? loopInfo.barIdAt(sVal, side) : -1);

  let vIdx = 0;

  // Longitudinal & collar walls
  for (let i = 0; i < spanCount; i++) {
    const c0 = _ringPts[i];
    const c1 = _ringPts[i + 1];
    const sVal0 = _sValues[i];
    const sVal1 = _sValues[i + 1];
    const zp0 = evalZPortal(sVal0, 1);
    const zp1 = evalZPortal(sVal1, -1);
    const packedSpanId = evalPackedId(0.5 * (sVal0 + sVal1), 0);
    const isStartCollarSpan = doCollarStart && sVal1 <= collarStartS + 1e-6;
    const isEndCollarSpan = doCollarEnd && sVal0 >= collarEndS - 1e-6;
    const isCollarSpan = isStartCollarSpan || isEndCollarSpan;

    for (let w = 0; w < ringCount; w++) {
      if (!_spanHasWall[i][w]) continue;
      const w1 = w + 1 === ringCount ? 0 : w + 1;
      const fnCurr = _wallNormals[i][w];

      if (isCollarSpan) {
        _n0.copy(fnCurr);
        if (useCustomCapNormal) {
          loop.sampleCapNormal(isEndCollarSpan ? cB : cA, isEndCollarSpan, offAxisBlend, _n0, _n0);
        }
        _n1.copy(_n0);
        _sn0.copy(fnCurr);
        _sn1.copy(fnCurr);
      } else {
        if (!flatShaded && i > 0 && (!_isSharp[i] || _wallNormals[i - 1][w].dot(fnCurr) > 0.96)) {
          _sn0.addVectors(_wallNormals[i - 1][w], fnCurr).normalize();
        } else if (!flatShaded && i === 0 && smoothPortalStart && _guardPrevNormals[w].dot(fnCurr) > 0.96) {
          _sn0.addVectors(_guardPrevNormals[w], fnCurr).normalize();
        } else {
          _sn0.copy(fnCurr);
        }

        if (
          !flatShaded &&
          i + 1 < spanCount &&
          (!_isSharp[i + 1] || fnCurr.dot(_wallNormals[i + 1][w]) > 0.96)
        ) {
          _sn1.addVectors(fnCurr, _wallNormals[i + 1][w]).normalize();
        } else if (
          !flatShaded &&
          i + 1 === spanCount &&
          smoothPortalEnd &&
          fnCurr.dot(_guardNextNormals[w]) > 0.96
        ) {
          _sn1.addVectors(fnCurr, _guardNextNormals[w]).normalize();
        } else {
          _sn1.copy(fnCurr);
        }

        if (useCustomWallNormals) {
          _n0.copy(_customSliceNormals[i][w]);
          _n1.copy(_customSliceNormals[i + 1][w]);
        } else {
          _n0.copy(_sn0);
          _n1.copy(_sn1);
        }
      }

      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c0[w], _n0, _sn0, packedSpanId, sVal0, zp0, lapJump);
      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c0[w1], _n0, _sn0, packedSpanId, sVal0, zp0, lapJump);
      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c1[w1], _n1, _sn1, packedSpanId, sVal1, zp1, lapJump);

      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c0[w], _n0, _sn0, packedSpanId, sVal0, zp0, lapJump);
      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c1[w1], _n1, _sn1, packedSpanId, sVal1, zp1, lapJump);
      writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, c1[w], _n1, _sn1, packedSpanId, sVal1, zp1, lapJump);
    }
  }

  // Start cap (slice 0)
  if (capStart) {
    const cs = _ringPts[0];
    const sVal0 = _sValues[0];
    const zp0 = evalZPortal(sVal0, 1);
    const packedStartId = evalPackedId(sVal0, 1);
    if (computePolygonCapNormal(cs, ringCount, true, _capNormal)) {
      _geomCapNormal.copy(_capNormal);
      if (useCustomCapNormal) {
        loop.sampleCapNormal(sA, false, offAxisBlend, _capNormal, _capNormal);
      }
      for (let k = 1; k < ringCount - 1; k++) {
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, cs[0], _capNormal, _geomCapNormal, packedStartId, sVal0, zp0, lapJump);
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, cs[k + 1], _capNormal, _geomCapNormal, packedStartId, sVal0, zp0, lapJump);
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, cs[k], _capNormal, _geomCapNormal, packedStartId, sVal0, zp0, lapJump);
      }
    }
  }

  // End cap (slice spanCount)
  if (capEnd) {
    const ce = _ringPts[spanCount];
    const sValEnd = _sValues[spanCount];
    const zpEnd = evalZPortal(sValEnd, -1);
    const packedEndId = evalPackedId(sValEnd, -1);
    if (computePolygonCapNormal(ce, ringCount, false, _capNormal)) {
      _geomCapNormal.copy(_capNormal);
      if (useCustomCapNormal) {
        loop.sampleCapNormal(sB, true, offAxisBlend, _capNormal, _capNormal);
      }
      for (let k = 1; k < ringCount - 1; k++) {
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, ce[0], _capNormal, _geomCapNormal, packedEndId, sValEnd, zpEnd, lapJump);
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, ce[k], _capNormal, _geomCapNormal, packedEndId, sValEnd, zpEnd, lapJump);
        writeVertex(_rawPos, _rawNorm, _rawSweetNorm, _rawTag, vIdx++, ce[k + 1], _capNormal, _geomCapNormal, packedEndId, sValEnd, zpEnd, lapJump);
      }
    }
  }

  // Architectural wireframe edges
  let eIdx = 0;

  // 1. Longitudinal & collar crease rails
  const skipRailFn = loop.skipSpanRail;
  for (let i = 0; i < spanCount; i++) {
    const c0 = _ringPts[i];
    const c1 = _ringPts[i + 1];
    const b0 = _cornerOut[i];
    const b1 = _cornerOut[i + 1];
    const sMid = 0.5 * (_sValues[i] + _sValues[i + 1]);
    for (let cr = 0; cr < ringCount; cr++) {
      const wPrev = cr === 0 ? ringCount - 1 : cr - 1;
      if (!_spanHasWall[i][wPrev] && !_spanHasWall[i][cr]) continue;
      if (skipRailFn && skipRailFn(sMid, cr)) continue;
      if (c0[cr].distanceToSquared(c1[cr]) < 1e-12) continue;
      writeEdge(_rawEdge, eIdx++, c0[cr], b0[cr], c1[cr], b1[cr], _sValues[i], _sValues[i + 1]);
    }
  }

  // 2. Interior sharp corner termination edges & beveled collar shoulder rings
  const activeCorners = cornersOverride ?? loop.corners;
  for (let i = 1; i < spanCount; i++) {
    if (_isCollar[i]) {
      const c = _ringPts[i];
      const b = _cornerOut[i];
      for (let cr = 0; cr < ringCount; cr++) {
        const cr1 = cr + 1 === ringCount ? 0 : cr + 1;
        if (c[cr].distanceToSquared(c[cr1]) > 1e-12) {
          writeEdge(_rawEdge, eIdx++, c[cr], b[cr], c[cr1], b[cr1], _sValues[i]);
        }
      }
      continue;
    }

    if (!activeCorners || activeCorners.length === 0 || !_isSharp[i]) continue;
    let isCornerSlice = false;
    if (periodicSpecials) {
      const frac = ((_sValues[i] % 1) + 1) % 1;
      for (let ci = 0; ci < activeCorners.length; ci++) {
        const d = Math.abs(frac - activeCorners[ci]);
        if (d < 1e-4 || Math.abs(d - 1) < 1e-4) {
          isCornerSlice = true;
          break;
        }
      }
    } else {
      for (let ci = 0; ci < activeCorners.length; ci++) {
        if (Math.abs(_sValues[i] - activeCorners[ci]) < 1e-4) {
          isCornerSlice = true;
          break;
        }
      }
    }
    if (!isCornerSlice) continue;

    const c = _ringPts[i];
    const b = _cornerOut[i];
    const checkPrevDup = _isSharp[i] === 3 && i > 0 && _isSharp[i - 1] === 2;
    const cPrev = checkPrevDup ? _ringPts[i - 1] : null;
    for (let w = 0; w < ringCount; w++) {
      let iPrev = i - 1;
      while (iPrev > 0 && !_spanHasWall[iPrev][w]) iPrev--;
      let iNext = i;
      while (iNext < spanCount - 1 && !_spanHasWall[iNext][w]) iNext++;
      if (!_spanHasWall[iPrev][w] || !_spanHasWall[iNext][w]) continue;
      const dot = _wallNormals[iPrev][w].dot(_wallNormals[iNext][w]);
      if (dot < 0.96) {
        const w1 = w + 1 === ringCount ? 0 : w + 1;
        if (
          checkPrevDup &&
          c[w].distanceToSquared(cPrev[w]) < 1e-10 &&
          c[w1].distanceToSquared(cPrev[w1]) < 1e-10
        ) {
          continue;
        }
        if (c[w].distanceToSquared(c[w1]) > 1e-12) {
          writeEdge(_rawEdge, eIdx++, c[w], b[w], c[w1], b[w1], _sValues[i]);
        }
      }
    }
  }

  // 3. End-cap loops
  if (edgeStart) {
    const c = _ringPts[0];
    const b = _cornerOut[0];
    if (computePolygonCapNormal(c, ringCount, true, _bias)) {
      _bias.multiplyScalar(EDGE_BIAS * 0.65);
      for (let cr = 0; cr < ringCount; cr++) {
        const cr1 = cr + 1 === ringCount ? 0 : cr + 1;
        _cBias0.copy(b[cr]).add(_bias);
        _cBias1.copy(b[cr1]).add(_bias);
        writeEdge(_rawEdge, eIdx++, c[cr], _cBias0, c[cr1], _cBias1, _sValues[0]);
      }
    }
  }

  if (edgeEnd) {
    const c = _ringPts[spanCount];
    const b = _cornerOut[spanCount];
    if (computePolygonCapNormal(c, ringCount, false, _bias)) {
      _bias.multiplyScalar(EDGE_BIAS * 0.65);
      for (let cr = 0; cr < ringCount; cr++) {
        const cr1 = cr + 1 === ringCount ? 0 : cr + 1;
        _cBias0.copy(b[cr]).add(_bias);
        _cBias1.copy(b[cr1]).add(_bias);
        writeEdge(_rawEdge, eIdx++, c[cr], _cBias0, c[cr1], _cBias1, _sValues[spanCount]);
      }
    }
  }

  return { rawVertCount: vIdx, rawEdgeCount: eIdx };
}

function flushRawToUnit(unit, rawVertCount, rawEdgeCount, zOffset = 0, loopInfo = null) {
  const posArr = unit.posAttr.array;
  const normArr = unit.normAttr.array;
  const sweetPosArr = unit.sweetPosAttr.array;
  const sweetNormArr = unit.sweetNormAttr.array;
  const sweetTagArr = unit.sweetTagAttr.array;
  const nFloats = rawVertCount * 3;
  const tFloats = rawVertCount * 4;

  if (zOffset === 0) {
    posArr.set(_rawPos.subarray(0, nFloats), 0);
    sweetTagArr.set(_rawTag.subarray(0, tFloats), 0);
  } else {
    for (let i = 0; i < nFloats; i += 3) {
      posArr[i] = _rawPos[i];
      posArr[i + 1] = _rawPos[i + 1];
      posArr[i + 2] = _rawPos[i + 2] + zOffset;
    }
    for (let i = 0; i < tFloats; i += 4) {
      sweetTagArr[i] = _rawTag[i];
      sweetTagArr[i + 1] = _rawTag[i + 1];
      sweetTagArr[i + 2] = _rawTag[i + 2] + zOffset;
      sweetTagArr[i + 3] = _rawTag[i + 3];
    }
  }
  normArr.set(_rawNorm.subarray(0, nFloats), 0);
  sweetPosArr.set(posArr.subarray(0, nFloats), 0);
  sweetNormArr.set(_rawSweetNorm.subarray(0, nFloats), 0);

  unit.vertCount = rawVertCount;
  unit.edgeVertCount = rawEdgeCount * 2;
  unit.mesh.geometry.setDrawRange(0, rawVertCount);
  markAttrUpdated(unit.posAttr, nFloats);
  markAttrUpdated(unit.normAttr, nFloats);
  markAttrUpdated(unit.sweetPosAttr, nFloats);
  markAttrUpdated(unit.sweetNormAttr, nFloats);
  markAttrUpdated(unit.sweetTagAttr, tFloats);

  const edgeArr = unit.edgeAttr.array;
  const eFloats = rawEdgeCount * 6;
  if (zOffset === 0) {
    edgeArr.set(_rawEdge.subarray(0, eFloats), 0);
  } else {
    for (let i = 0; i < eFloats; i += 3) {
      edgeArr[i] = _rawEdge[i];
      edgeArr[i + 1] = _rawEdge[i + 1];
      edgeArr[i + 2] = _rawEdge[i + 2] + zOffset;
    }
  }
  unit.lines.geometry.setDrawRange(0, rawEdgeCount * 2);
  markAttrUpdated(unit.edgeAttr, eFloats);
}

// Measures signed screen distance range d = (x - cx)*ux + (y - cy)*uy across raw mesh & wireframe buffers,
// guarded by unwrapped station proximity to `zone.sCut` so portals on short bars never wrap across 120° corners.
function measurePlaneBounds(rawVertCount, rawEdgeCount, zone, outMinMax) {
  const { cx, cy, ux, uy } = zone;
  const sCut = zone.sCut ?? 0;
  const baseGuard = Math.max(0.12, (zone.overhangS ?? 0.04) * 2.2);
  const sGuardBefore = Math.min(zone.guardBeforeS ?? Infinity, baseGuard);
  const sGuardAfter = Math.min(zone.guardAfterS ?? Infinity, baseGuard);
  let minD = Infinity;
  let maxD = -Infinity;
  for (let v = 0; v < rawVertCount; v++) {
    const i = v * 3;
    const sVert = _rawTag[v * 4 + 1];
    let d;
    if (sVert < sCut - sGuardBefore) d = -1;
    else if (sVert > sCut + sGuardAfter) d = 1;
    else d = (_rawPos[i] - cx) * ux + (_rawPos[i + 1] - cy) * uy;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (rawVertCount === 0) {
    const eFloats = rawEdgeCount * 6;
    for (let i = 0; i < eFloats; i += 3) {
      const d = (_rawEdge[i] - cx) * ux + (_rawEdge[i + 1] - cy) * uy;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
  }
  outMinMax[0] = minD;
  outMinMax[1] = maxD;
}

// Sutherland-Hodgman clips `_rawPos`/`_rawNorm` triangles and `_rawEdge` segments to half-space
// `sign * ((x - cx)*ux + (y - cy)*uy) >= 0` (`sign = +1` for keepPositive, `-1` for !keepPositive),
// shifts `z` by `zOffset`, and optionally caps the planar cut when orbiting off-axis.
function emitHalfSpaceClippedToUnit(
  unit,
  rawVertCount,
  rawEdgeCount,
  zone,
  keepPositive,
  zOffset,
  emitCutCap,
  _loopInfo = null,
) {
  const { cx, cy, ux, uy } = zone;
  const sCut = zone.sCut ?? 0;
  const baseGuard = Math.max(0.12, (zone.overhangS ?? 0.04) * 2.2);
  const sGuardBefore = Math.min(zone.guardBeforeS ?? Infinity, baseGuard);
  const sGuardAfter = Math.min(zone.guardAfterS ?? Infinity, baseGuard);
  const sign = keepPositive ? 1 : -1;
  const posArr = unit.posAttr.array;
  const normArr = unit.normAttr.array;
  const sweetPosArr = unit.sweetPosAttr.array;
  const sweetNormArr = unit.sweetNormAttr.array;
  const sweetTagArr = unit.sweetTagAttr.array;
  let vOut = 0;
  let chordCount = 0;

  const capSVal = sCut + (keepPositive ? 1e-4 : -1e-4);
  const basePacked = rawVertCount > 0 ? Math.round(_rawTag[0]) : 0;
  const capLoopId = _loopInfo
    ? packLoopBarId(
        Math.floor(basePacked / 16384),
        _loopInfo.hasPortals,
        _loopInfo.selfCross,
        _loopInfo.numBars,
        _loopInfo.barIdAt(capSVal, 0),
      )
    : basePacked;
  const capZPortal = (rawVertCount > 0 ? _rawTag[2] : 0) + zOffset;
  const capLapJump = rawVertCount > 0 ? _rawTag[3] : 0;

  const evalVertSignedD = (iPos, qTag) => {
    const sv = _rawTag[qTag + 1];
    if (sv < sCut - sGuardBefore) return -sign;
    if (sv > sCut + sGuardAfter) return sign;
    return sign * ((_rawPos[iPos] - cx) * ux + (_rawPos[iPos + 1] - cy) * uy);
  };

  const pushOutVert = (px, py, pz, nx, ny, nz, snx, sny, snz, t0, t1, t2, t3) => {
    if (vOut >= MAX_MESH_VERTS) return;
    const o = vOut * 3;
    const shiftedZ = pz + zOffset;
    posArr[o] = px;
    posArr[o + 1] = py;
    posArr[o + 2] = shiftedZ;
    normArr[o] = nx;
    normArr[o + 1] = ny;
    normArr[o + 2] = nz;
    sweetPosArr[o] = px;
    sweetPosArr[o + 1] = py;
    sweetNormArr[o] = snx;
    sweetNormArr[o + 1] = sny;
    sweetNormArr[o + 2] = snz;
    const to = vOut * 4;
    const sClamped = keepPositive ? Math.max(sCut + 2e-5, t1) : Math.min(sCut - 2e-5, t1);
    sweetTagArr[to] = t0;
    sweetTagArr[to + 1] = sClamped;
    sweetTagArr[to + 3] = t3;
    sweetPosArr[o + 2] = shiftedZ;
    sweetTagArr[to + 2] = t2 + zOffset;
    vOut++;
  };

  for (let t = 0; t < rawVertCount; t += 3) {
    const i0 = t * 3;
    const i1 = i0 + 3;
    const i2 = i0 + 6;
    const q0 = t * 4;
    const q1 = q0 + 4;
    const q2 = q0 + 8;

    const d0 = evalVertSignedD(i0, q0);
    const d1 = evalVertSignedD(i1, q1);
    const d2 = evalVertSignedD(i2, q2);

    const in0 = d0 >= 0;
    const in1 = d1 >= 0;
    const in2 = d2 >= 0;

    if (in0 && in1 && in2) {
      pushOutVert(
        _rawPos[i0], _rawPos[i0 + 1], _rawPos[i0 + 2],
        _rawNorm[i0], _rawNorm[i0 + 1], _rawNorm[i0 + 2],
        _rawSweetNorm[i0], _rawSweetNorm[i0 + 1], _rawSweetNorm[i0 + 2],
        _rawTag[q0], _rawTag[q0 + 1], _rawTag[q0 + 2], _rawTag[q0 + 3],
      );
      pushOutVert(
        _rawPos[i1], _rawPos[i1 + 1], _rawPos[i1 + 2],
        _rawNorm[i1], _rawNorm[i1 + 1], _rawNorm[i1 + 2],
        _rawSweetNorm[i1], _rawSweetNorm[i1 + 1], _rawSweetNorm[i1 + 2],
        _rawTag[q1], _rawTag[q1 + 1], _rawTag[q1 + 2], _rawTag[q1 + 3],
      );
      pushOutVert(
        _rawPos[i2], _rawPos[i2 + 1], _rawPos[i2 + 2],
        _rawNorm[i2], _rawNorm[i2 + 1], _rawNorm[i2 + 2],
        _rawSweetNorm[i2], _rawSweetNorm[i2 + 1], _rawSweetNorm[i2 + 2],
        _rawTag[q2], _rawTag[q2 + 1], _rawTag[q2 + 2], _rawTag[q2 + 3],
      );
      continue;
    }
    if (!in0 && !in1 && !in2) continue;

    // Sutherland-Hodgman clip of triangle against s >= 0 (produces 3 or 4 vertices)
    let pCount = 0;
    let hasEnter = false;
    let hasExit = false;
    let enX = 0, enY = 0, enZ = 0;
    let exX = 0, exY = 0, exZ = 0;

    const idxs = [i0, i1, i2];
    const qIdxs = [q0, q1, q2];
    const ds = [d0, d1, d2];
    const ins = [in0, in1, in2];

    for (let e = 0; e < 3; e++) {
      const eNext = (e + 1) % 3;
      const ia = idxs[e];
      const ib = idxs[eNext];
      const qa = qIdxs[e];
      const qb = qIdxs[eNext];
      const da = ds[e];
      const db = ds[eNext];
      const ina = ins[e];
      const inb = ins[eNext];

      if (ina) {
        const po = pCount * 3;
        const qo = pCount * 4;
        _polyPos[po] = _rawPos[ia];
        _polyPos[po + 1] = _rawPos[ia + 1];
        _polyPos[po + 2] = _rawPos[ia + 2];
        _polyNorm[po] = _rawNorm[ia];
        _polyNorm[po + 1] = _rawNorm[ia + 1];
        _polyNorm[po + 2] = _rawNorm[ia + 2];
        _polySweetNorm[po] = _rawSweetNorm[ia];
        _polySweetNorm[po + 1] = _rawSweetNorm[ia + 1];
        _polySweetNorm[po + 2] = _rawSweetNorm[ia + 2];
        _polyTag[qo] = _rawTag[qa];
        _polyTag[qo + 1] = _rawTag[qa + 1];
        _polyTag[qo + 2] = _rawTag[qa + 2];
        _polyTag[qo + 3] = _rawTag[qa + 3];
        pCount++;
      }

      if (ina !== inb) {
        const denom = da - db;
        const frac = Math.abs(denom) > 1e-14 ? da / denom : 0.5;
        const ix = _rawPos[ia] + (_rawPos[ib] - _rawPos[ia]) * frac;
        const iy = _rawPos[ia + 1] + (_rawPos[ib + 1] - _rawPos[ia + 1]) * frac;
        const iz = _rawPos[ia + 2] + (_rawPos[ib + 2] - _rawPos[ia + 2]) * frac;

        let nx = _rawNorm[ia] + (_rawNorm[ib] - _rawNorm[ia]) * frac;
        let ny = _rawNorm[ia + 1] + (_rawNorm[ib + 1] - _rawNorm[ia + 1]) * frac;
        let nz = _rawNorm[ia + 2] + (_rawNorm[ib + 2] - _rawNorm[ia + 2]) * frac;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;

        let snx = _rawSweetNorm[ia] + (_rawSweetNorm[ib] - _rawSweetNorm[ia]) * frac;
        let sny = _rawSweetNorm[ia + 1] + (_rawSweetNorm[ib + 1] - _rawSweetNorm[ia + 1]) * frac;
        let snz = _rawSweetNorm[ia + 2] + (_rawSweetNorm[ib + 2] - _rawSweetNorm[ia + 2]) * frac;
        const snl = Math.hypot(snx, sny, snz) || 1;
        snx /= snl;
        sny /= snl;
        snz /= snl;

        const po = pCount * 3;
        const qo = pCount * 4;
        _polyPos[po] = ix;
        _polyPos[po + 1] = iy;
        _polyPos[po + 2] = iz;
        _polyNorm[po] = nx;
        _polyNorm[po + 1] = ny;
        _polyNorm[po + 2] = nz;
        _polySweetNorm[po] = snx;
        _polySweetNorm[po + 1] = sny;
        _polySweetNorm[po + 2] = snz;
        _polyTag[qo] = _rawTag[qa];
        _polyTag[qo + 1] = _rawTag[qa + 1] + (_rawTag[qb + 1] - _rawTag[qa + 1]) * frac;
        _polyTag[qo + 2] = _rawTag[qa + 2] + (_rawTag[qb + 2] - _rawTag[qa + 2]) * frac;
        _polyTag[qo + 3] = _rawTag[qa + 3];
        pCount++;

        if (ina && !inb) {
          hasExit = true;
          exX = ix;
          exY = iy;
          exZ = iz;
        } else {
          hasEnter = true;
          enX = ix;
          enY = iy;
          enZ = iz;
        }
      }
    }

    if (pCount >= 3) {
      pushOutVert(
        _polyPos[0], _polyPos[1], _polyPos[2],
        _polyNorm[0], _polyNorm[1], _polyNorm[2],
        _polySweetNorm[0], _polySweetNorm[1], _polySweetNorm[2],
        _polyTag[0], _polyTag[1], _polyTag[2], _polyTag[3],
      );
      pushOutVert(
        _polyPos[3], _polyPos[4], _polyPos[5],
        _polyNorm[3], _polyNorm[4], _polyNorm[5],
        _polySweetNorm[3], _polySweetNorm[4], _polySweetNorm[5],
        _polyTag[4], _polyTag[5], _polyTag[6], _polyTag[7],
      );
      pushOutVert(
        _polyPos[6], _polyPos[7], _polyPos[8],
        _polyNorm[6], _polyNorm[7], _polyNorm[8],
        _polySweetNorm[6], _polySweetNorm[7], _polySweetNorm[8],
        _polyTag[8], _polyTag[9], _polyTag[10], _polyTag[11],
      );
      if (pCount === 4) {
        pushOutVert(
          _polyPos[0], _polyPos[1], _polyPos[2],
          _polyNorm[0], _polyNorm[1], _polyNorm[2],
          _polySweetNorm[0], _polySweetNorm[1], _polySweetNorm[2],
          _polyTag[0], _polyTag[1], _polyTag[2], _polyTag[3],
        );
        pushOutVert(
          _polyPos[6], _polyPos[7], _polyPos[8],
          _polyNorm[6], _polyNorm[7], _polyNorm[8],
          _polySweetNorm[6], _polySweetNorm[7], _polySweetNorm[8],
          _polyTag[8], _polyTag[9], _polyTag[10], _polyTag[11],
        );
        pushOutVert(
          _polyPos[9], _polyPos[10], _polyPos[11],
          _polyNorm[9], _polyNorm[10], _polyNorm[11],
          _polySweetNorm[9], _polySweetNorm[10], _polySweetNorm[11],
          _polyTag[12], _polyTag[13], _polyTag[14], _polyTag[15],
        );
      }
    }

    if (emitCutCap && hasEnter && hasExit && chordCount < MAX_CUT_CHORDS) {
      const dx = exX - enX;
      const dy = exY - enY;
      const dz = exZ - enZ;
      if (dx * dx + dy * dy + dz * dz > 1e-12) {
        const co = chordCount * 6;
        _cutChords[co] = enX;
        _cutChords[co + 1] = enY;
        _cutChords[co + 2] = enZ;
        _cutChords[co + 3] = exX;
        _cutChords[co + 4] = exY;
        _cutChords[co + 5] = exZ;
        chordCount++;
      }
    }
  }

  // Clip wireframe segments to the exact same half-space s >= 0
  const edgeArr = unit.edgeAttr.array;
  let eOut = 0;

  const pushOutEdge = (ax, ay, az, bx, by, bz) => {
    if (eOut * 2 >= MAX_EDGE_VERTS) return;
    const o = eOut * 6;
    edgeArr[o] = ax;
    edgeArr[o + 1] = ay;
    edgeArr[o + 2] = az + zOffset;
    edgeArr[o + 3] = bx;
    edgeArr[o + 4] = by;
    edgeArr[o + 5] = bz + zOffset;
    eOut++;
  };

  for (let e = 0; e < rawEdgeCount; e++) {
    const o = e * 6;
    let ax = _rawEdge[o];
    let ay = _rawEdge[o + 1];
    let az = _rawEdge[o + 2];
    let bx = _rawEdge[o + 3];
    let by = _rawEdge[o + 4];
    let bz = _rawEdge[o + 5];

    const edgeD = (x, y, sv) => {
      if (sv < sCut - sGuardBefore) return -sign;
      if (sv > sCut + sGuardAfter) return sign;
      return sign * ((x - cx) * ux + (y - cy) * uy);
    };
    const da = edgeD(ax, ay, _rawEdgeS[e * 2]);
    const db = edgeD(bx, by, _rawEdgeS[e * 2 + 1]);

    if (da < 0 && db < 0) continue;
    if (da >= 0 && db >= 0) {
      pushOutEdge(ax, ay, az, bx, by, bz);
      continue;
    }

    const denom = da - db;
    const frac = Math.abs(denom) > 1e-14 ? da / denom : 0.5;
    const ix = ax + (bx - ax) * frac;
    const iy = ay + (by - ay) * frac;
    const iz = az + (bz - az) * frac;
    if (da >= 0) {
      pushOutEdge(ax, ay, az, ix, iy, iz);
    } else {
      pushOutEdge(ix, iy, iz, bx, by, bz);
    }
  }

  // When orbited off-axis, cap the planar sightline cut (cCap, I_enter, I_exit) with outward normal (-sign*ux, -sign*uy, 0)
  if (emitCutCap && chordCount >= 2) {
    let midX = 0;
    let midY = 0;
    let midZ = 0;
    for (let c = 0; c < chordCount; c++) {
      const co = c * 6;
      midX += _cutChords[co] + _cutChords[co + 3];
      midY += _cutChords[co + 1] + _cutChords[co + 4];
      midZ += _cutChords[co + 2] + _cutChords[co + 5];
    }
    const inv = 1 / (chordCount * 2);
    midX *= inv;
    midY *= inv;
    midZ *= inv;

    const cutNx = -sign * ux;
    const cutNy = -sign * uy;
    const ebX = cutNx * (EDGE_BIAS * 0.65);
    const ebY = cutNy * (EDGE_BIAS * 0.65);
    const rawCapZp = capZPortal - zOffset;

    for (let c = 0; c < chordCount; c++) {
      const co = c * 6;
      const enX = _cutChords[co];
      const enY = _cutChords[co + 1];
      const enZ = _cutChords[co + 2];
      const exX = _cutChords[co + 3];
      const exY = _cutChords[co + 4];
      const exZ = _cutChords[co + 5];

      pushOutVert(midX, midY, midZ, cutNx, cutNy, 0, cutNx, cutNy, 0, capLoopId, capSVal, rawCapZp, capLapJump);
      pushOutVert(enX, enY, enZ, cutNx, cutNy, 0, cutNx, cutNy, 0, capLoopId, capSVal, rawCapZp, capLapJump);
      pushOutVert(exX, exY, exZ, cutNx, cutNy, 0, cutNx, cutNy, 0, capLoopId, capSVal, rawCapZp, capLapJump);

      pushOutEdge(enX + ebX, enY + ebY, enZ, exX + ebX, exY + ebY, exZ);
    }
  }

  unit.vertCount = vOut;
  unit.edgeVertCount = eOut * 2;
  unit.mesh.geometry.setDrawRange(0, vOut);
  const vFloats = vOut * 3;
  markAttrUpdated(unit.posAttr, vFloats);
  markAttrUpdated(unit.normAttr, vFloats);
  markAttrUpdated(unit.sweetPosAttr, vFloats);
  markAttrUpdated(unit.sweetNormAttr, vFloats);
  markAttrUpdated(unit.sweetTagAttr, vOut * 4);

  unit.lines.geometry.setDrawRange(0, eOut * 2);
  markAttrUpdated(unit.edgeAttr, eOut * 6);
}

// Applies the exact PGL(4, R) perspective homology (x, y, z) -> (D / (D + k*z)) * (x, y, k*z)
// so every straight line & flat plane stays 100% straight/planar in 3D while projecting to the exact
// same sweet-spot pixels from PerspectiveCamera at (0, 0, D) as OrthographicCamera!
function warpBuffersForPerspective(
  posArr,
  normArr,
  vertCount,
  edgeArr,
  edgeVertCount,
  perspDist,
  zCompress,
  offAxisBlend,
) {
  const minDenom = 0.16 * perspDist;
  const nFloats = vertCount * 3;
  for (let i = 0; i < nFloats; i += 3) {
    const x = posArr[i];
    const y = posArr[i + 1];
    const zs = posArr[i + 2] * zCompress;
    const denom = Math.max(minDenom, perspDist + zs);
    const scale = perspDist / denom;
    posArr[i] = x * scale;
    posArr[i + 1] = y * scale;
    posArr[i + 2] = zs * scale;

    if (normArr && offAxisBlend > 1e-4) {
      const nx = normArr[i];
      const ny = normArr[i + 1];
      const nz = normArr[i + 2];
      let pnx = perspDist * zCompress * nx;
      let pny = perspDist * zCompress * ny;
      let pnz = x * zCompress * nx + y * zCompress * ny + denom * nz;
      const plen = Math.hypot(pnx, pny, pnz) || 1;
      pnx /= plen;
      pny /= plen;
      pnz /= plen;
      const bnx = nx + (pnx - nx) * offAxisBlend;
      const bny = ny + (pny - ny) * offAxisBlend;
      const bnz = nz + (pnz - nz) * offAxisBlend;
      const blen = Math.hypot(bnx, bny, bnz) || 1;
      normArr[i] = bnx / blen;
      normArr[i + 1] = bny / blen;
      normArr[i + 2] = bnz / blen;
    }
  }

  if (edgeArr && edgeVertCount > 0) {
    const eFloats = edgeVertCount * 3;
    for (let i = 0; i < eFloats; i += 3) {
      const ex = edgeArr[i];
      const ey = edgeArr[i + 1];
      const ezs = edgeArr[i + 2] * zCompress;
      const denom = Math.max(minDenom, perspDist + ezs);
      const scale = perspDist / denom;
      edgeArr[i] = ex * scale;
      edgeArr[i + 1] = ey * scale;
      edgeArr[i + 2] = ezs * scale;
    }
  }
}

function updateSegmentUnit(unit, loop, sA, sB, opts) {
  const { rawVertCount, rawEdgeCount } = buildRawPrism(loop, sA, sB, opts);
  flushRawToUnit(unit, rawVertCount, rawEdgeCount, 0, opts?.loopInfo ?? null);
}

function pushSubSpan(a, b, portalStart, portalEnd) {
  const idx = _subSpans.length;
  let item = _subSpansPool[idx];
  if (!item) {
    item = { a: 0, b: 0, portalStart: false, portalEnd: false };
    _subSpansPool[idx] = item;
  }
  item.a = a;
  item.b = b;
  item.portalStart = portalStart;
  item.portalEnd = portalEnd;
  _subSpans.push(item);
}

// Splits unwrapped interval [s0, s1] across all sightline portals in `loop.splits` (used for curved loops).
function collectPortalSubSpans(loop, s0, s1) {
  _subSpans.length = 0;
  const splits = loop.splits;
  if (!splits || splits.length === 0) {
    pushSubSpan(s0, s1, false, false);
    return _subSpans;
  }

  let cutLen = 0;
  const kMin = Math.floor(s0) - 1;
  const kMax = Math.ceil(s1) + 1;
  for (let k = kMin; k <= kMax; k++) {
    for (let i = 0; i < splits.length; i++) {
      const p = k + splits[i];
      if (p > s0 + EPS_SPLIT && p < s1 - EPS_SPLIT && cutLen < 64) {
        _portalCuts[cutLen++] = p;
      }
    }
  }

  if (cutLen === 0) {
    pushSubSpan(s0, s1, false, false);
    return _subSpans;
  }

  for (let i = 1; i < cutLen; i++) {
    const kp = _portalCuts[i];
    let j = i - 1;
    while (j >= 0 && _portalCuts[j] > kp) {
      _portalCuts[j + 1] = _portalCuts[j];
      j--;
    }
    _portalCuts[j + 1] = kp;
  }

  let cur = s0;
  for (let i = 0; i < cutLen; i++) {
    const p = _portalCuts[i];
    if (p - cur > EPS_SPLIT) {
      pushSubSpan(cur, p, i > 0, true);
      cur = p;
    }
  }
  if (s1 - cur > EPS_SPLIT) {
    pushSubSpan(cur, s1, true, false);
  }
  return _subSpans;
}

function ringCentroid(pts, ringCount, dst) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let c = 0; c < ringCount; c++) {
    x += pts[c].x;
    y += pts[c].y;
    z += pts[c].z;
  }
  const inv = 1 / ringCount;
  dst.set(x * inv, y * inv, z * inv);
}

function buildLoopPortalInfo(loop, depthScale) {
  const ringCount = loop.ringCount ?? 4;
  const isOpen = Boolean(loop.open);
  const splits = loop.splits ?? [];
  const cuts = [];
  let lapJump = 0;

  for (let i = 0; i < splits.length; i++) {
    const sCut = splits[i];
    evalSliceCorners(loop, sCut, -1, _obbPts0, depthScale);
    evalSliceCorners(loop, sCut, 1, _obbPts1, depthScale);
    ringCentroid(_obbPts0, ringCount, _obbC0);
    ringCentroid(_obbPts1, ringCount, _obbC1);
    const jzScaled = _obbC1.z - _obbC0.z;
    cuts.push({ sCut, jzScaled });
    lapJump += jzScaled;
  }

  const sortedCorners =
    !isOpen && loop.corners && loop.corners.length > 0
      ? [...loop.corners].sort((a, b) => a - b)
      : null;
  const numBars = sortedCorners ? sortedCorners.length : 0;
  const isRing = Boolean(loop.isRing);
  const noSelfCross = Boolean(loop.noSelfCrossShadow);
  const hasPortals = cuts.some((c) => Math.abs(c.jzScaled) > 1e-6);
  let minPieceSpan = 1;
  if (!isOpen && cuts.length >= 2) {
    for (let i = 0; i < cuts.length; i++) {
      const s0 = cuts[i].sCut;
      const s1 = i + 1 < cuts.length ? cuts[i + 1].sCut : cuts[0].sCut + 1;
      if (s1 - s0 < minPieceSpan) minPieceSpan = s1 - s0;
    }
  }
  const rampW = Math.min(0.068, minPieceSpan * 0.35);
  const wrapCut0 = sortedCorners && sortedCorners.length > 0 ? sortedCorners[0] + 0.01 : 2.0;

  return {
    isOpen,
    hasPortals,
    selfCross: Boolean(loop.selfCrossings),
    numBars,
    sortedCorners,
    wrapCut0,
    cuts,
    lapJump: isOpen && !loop.lappedRung && !loop.weldBridge ? 0 : lapJump,
    smoothPortalZ(s) {
      if (!hasPortals) return 0;
      if (isOpen) {
        let acc = 0;
        for (let i = 0; i < cuts.length; i++) {
          const c = cuts[i].sCut;
          const w = Math.min(0.095, c * 0.85, (1 - c) * 0.85);
          const u = w > 1e-5 ? (s - c + w) / (2 * w) : s >= c ? 1 : 0;
          acc += cuts[i].jzScaled * smooth01(u);
        }
        return acc;
      }
      let acc = 0;
      for (let i = 0; i < cuts.length; i++) {
        const c = cuts[i].sCut;
        const u = s - c;
        const m = Math.floor(u + 0.5);
        const delta = u - m;
        const baseShift = c > 1e-6 ? 0 : 1;
        acc += cuts[i].jzScaled * (m + smooth01((delta + rampW) / (2 * rampW)) - baseShift);
      }
      return acc;
    },
    barIdAt(s, side) {
      if (isRing || noSelfCross) return 62;
      if (loop.weldBridge) return 61;
      if (loop.unwoundWeld) return 60;
      if (loop.fixedWorldWeld) return 59;
      if (loop.lappedRung) return 58;
      if (typeof loop.unwoundWeldBar === "number") return 50 + (loop.unwoundWeldBar | 0);
      if (typeof loop.crossOnlyLoop === "number") return 1 + loop.crossOnlyLoop;
      if (!sortedCorners) return -1;
      let f = (s + side * 1e-6) % 1;
      if (f < 0) f += 1;
      let idx = 0;
      for (let i = 0; i < numBars; i++) {
        if (f >= sortedCorners[i]) idx++;
      }
      return idx === numBars ? 0 : idx;
    },
    cumPortalZ(s, side) {
      if (cuts.length === 0) return 0;
      const p = s + side * 1e-7;
      if (isOpen) {
        let acc = 0;
        for (let i = 0; i < cuts.length; i++) {
          if (p >= cuts[i].sCut) acc += cuts[i].jzScaled;
        }
        return acc;
      }
      let f = p % 1;
      if (f < 0) f += 1;
      const laps = Math.round(p - f);
      let acc = laps * lapJump;
      for (let i = 0; i < cuts.length; i++) {
        if (cuts[i].sCut > 1e-6 && f >= cuts[i].sCut) {
          acc += cuts[i].jzScaled;
        }
      }
      return acc;
    },
    barPortalZ(s, barId) {
      if (!hasPortals || isOpen) return this.cumPortalZ(s, 1);
      let f = s % 1;
      if (f < 0) f += 1;
      let zp0 = 0;
      for (let i = 0; i < cuts.length; i++) {
        if (cuts[i].sCut > 1e-6 && f >= cuts[i].sCut) {
          zp0 += cuts[i].jzScaled;
        }
      }
      return barId === 0 && f > wrapCut0 ? zp0 - lapJump : zp0;
    },
  };
}

function buildBarCrossRow(loops, loopInfos, depthScale, outRow) {
  outRow.fill(0);
  const bars = [];
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    const info = loopInfos[li];
    if (!info.hasPortals || info.isOpen || info.numBars <= 0 || !info.sortedCorners) continue;
    if (info.barIdAt(0.1, 0) >= 14) continue;
    const nb = info.numBars;
    if ((li + 1) * nb > CROSS_TABLE_STRIDE) return;
    const corners = info.sortedCorners;
    const ringCount = loop.ringCount ?? 4;

    for (let bi = 0; bi < nb; bi++) {
      const s0 = bi === 0 ? corners[nb - 1] - 1 : corners[bi - 1];
      const s1 = bi === 0 ? corners[0] : corners[bi];
      const sStartProbe = s0 + 1e-4;
      const sEndProbe = s1 - 1e-4;
      evalSliceCorners(loop, sStartProbe, 1, _obbPts0, depthScale);
      evalSliceCorners(loop, sEndProbe, -1, _obbPts1, depthScale);
      ringCentroid(_obbPts0, ringCount, _obbC0);
      ringCentroid(_obbPts1, ringCount, _obbC1);
      const p0x = _obbC0.x;
      const p0y = _obbC0.y;
      const p0z = _obbC0.z - info.barPortalZ(sStartProbe, bi);
      const p1x = _obbC1.x;
      const p1y = _obbC1.y;
      const p1z = _obbC1.z - info.barPortalZ(sEndProbe, bi);
      bars.push({
        g: li * nb + bi,
        li,
        bi,
        nb,
        s0,
        s1,
        wrapCut: info.wrapCut0,
        selfCross: info.selfCross,
        loop,
        ringCount,
        p0x,
        p0y,
        p0z,
        p1x,
        p1y,
        p1z,
      });
    }
  }

  if (bars.length === 0) return;

  const setEntry = (gA, gB, mode, deltaZ, wrapCutA) => {
    const o = (gA * CROSS_TABLE_STRIDE + gB) * 4;
    outRow[o] = mode;
    outRow[o + 1] = deltaZ;
    outRow[o + 2] = wrapCutA;
    outRow[o + 3] = 1;
  };

  for (let i = 0; i < bars.length; i++) {
    const bA = bars[i];
    for (let j = 0; j < bars.length; j++) {
      const bB = bars[j];
      const same = bA.li === bB.li;
      setEntry(bA.g, bB.g, same ? 1 : 0, 0, bA.wrapCut);
    }
  }

  const underSet = new Set();
  const overList = [];

  for (let i = 0; i < bars.length; i++) {
    const bA = bars[i];
    for (let j = 0; j < bars.length; j++) {
      const bB = bars[j];
      const same = bA.li === bB.li;
      if (same) {
        if (!bA.selfCross) continue;
        const dBar = Math.min(Math.abs(bA.bi - bB.bi), bA.nb - Math.abs(bA.bi - bB.bi));
        if (dBar <= 1) continue;
      }
      const dx1 = bA.p1x - bA.p0x;
      const dy1 = bA.p1y - bA.p0y;
      const dx2 = bB.p1x - bB.p0x;
      const dy2 = bB.p1y - bB.p0y;
      const det = dx1 * -dy2 - dy1 * -dx2;
      if (Math.abs(det) < 1e-5) continue;
      const rx = bB.p0x - bA.p0x;
      const ry = bB.p0y - bA.p0y;
      const tA = (rx * -dy2 - ry * -dx2) / det;
      const tB = (dx1 * ry - dy1 * rx) / det;
      if (tA >= -0.05 && tA <= 1.05 && tB >= -0.05 && tB <= 1.05) {
        const tcA = Math.max(1e-4, Math.min(1 - 1e-4, tA));
        const tcB = Math.max(1e-4, Math.min(1 - 1e-4, tB));
        const sCA = bA.s0 + tcA * (bA.s1 - bA.s0);
        const sCB = bB.s0 + tcB * (bB.s1 - bB.s0);
        evalSliceCorners(bA.loop, sCA, 0, _obbPts0, depthScale);
        evalSliceCorners(bB.loop, sCB, 0, _obbPts1, depthScale);
        ringCentroid(_obbPts0, bA.ringCount, _obbC0);
        ringCentroid(_obbPts1, bB.ringCount, _obbC1);
        const zRealA = _obbC0.z;
        const zRealB = _obbC1.z;
        if (zRealB > zRealA + 1e-3) {
          const zUnwA = bA.p0z + tcA * (bA.p1z - bA.p0z);
          const zUnwB = bB.p0z + tcB * (bB.p1z - bB.p0z);
          const dz = zUnwA - zUnwB;
          setEntry(bA.g, bB.g, 2, dz, bA.wrapCut);
          overList.push({ iA: i, bB, tA, dz });
        } else if (zRealB < zRealA - 1e-3) {
          underSet.add(bA.g * CROSS_TABLE_STRIDE + bB.g);
          if (same) {
            setEntry(bA.g, bB.g, 0, 0, bA.wrapCut);
          }
        }
      }
    }
  }

  // Propagate inter-loop overpass entries across portal-free receiver corners when crossing sits near a corner
  for (let k = 0; k < overList.length; k++) {
    const { iA, bB, tA, dz } = overList[k];
    const bA = bars[iA];
    if (bA.li === bB.li) continue;
    if (tA < 0.28) {
      const biPrev = (bA.bi - 1 + bA.nb) % bA.nb;
      const bPrev = bars[iA - bA.bi + biPrev];
      const keyPrev = bPrev.g * CROSS_TABLE_STRIDE + bB.g;
      if (outRow[keyPrev * 4] === 0 && !underSet.has(keyPrev)) {
        setEntry(bPrev.g, bB.g, 2, dz + (bPrev.p1z - bA.p0z), bPrev.wrapCut);
      }
    }
    if (tA > 0.72) {
      const biNext = (bA.bi + 1) % bA.nb;
      const bNext = bars[iA - bA.bi + biNext];
      const keyNext = bNext.g * CROSS_TABLE_STRIDE + bB.g;
      if (outRow[keyNext * 4] === 0 && !underSet.has(keyNext)) {
        setEntry(bNext.g, bB.g, 2, dz + (bNext.p0z - bA.p1z), bNext.wrapCut);
      }
    }
  }

  // Same-loop U-turn bridge: if bB crosses over BOTH neighbors of bMid (e.g. meander Bar 5 between Bar 4 & Bar 6),
  // promote (bMid, bB) to mode 2 so the short connecting bar tucked behind bB receives the continuous overpass shadow.
  for (let i = 0; i < bars.length; i++) {
    const bMid = bars[i];
    if (!bMid.selfCross || bMid.nb < 5) continue;
    const biPrev = (bMid.bi - 1 + bMid.nb) % bMid.nb;
    const biNext = (bMid.bi + 1) % bMid.nb;
    const bPrev = bars[i - bMid.bi + biPrev];
    const bNext = bars[i - bMid.bi + biNext];
    for (let j = 0; j < bars.length; j++) {
      const bB = bars[j];
      if (bB.li !== bMid.li) continue;
      const oPrev = (bPrev.g * CROSS_TABLE_STRIDE + bB.g) * 4;
      const oNext = (bNext.g * CROSS_TABLE_STRIDE + bB.g) * 4;
      const oMid = (bMid.g * CROSS_TABLE_STRIDE + bB.g) * 4;
      if (outRow[oPrev] === 2 && outRow[oNext] === 2 && outRow[oMid] === 1) {
        const dzPrev = outRow[oPrev + 1];
        setEntry(bMid.g, bB.g, 2, dzPrev + (bMid.p0z - bPrev.p1z), bMid.wrapCut);
      }
    }
  }
}

function createSegmentUnit(bodyMaterial, edgeMaterial) {
  const meshGeo = new BufferGeometry();
  const posAttr = new BufferAttribute(new Float32Array(MAX_MESH_VERTS * 3), 3);
  const normAttr = new BufferAttribute(new Float32Array(MAX_MESH_VERTS * 3), 3);
  const sweetPosAttr = new BufferAttribute(new Float32Array(MAX_MESH_VERTS * 3), 3);
  const sweetNormAttr = new BufferAttribute(new Float32Array(MAX_MESH_VERTS * 3), 3);
  const sweetTagAttr = new BufferAttribute(new Float32Array(MAX_MESH_VERTS * 4), 4);
  posAttr.setUsage(DynamicDrawUsage);
  normAttr.setUsage(DynamicDrawUsage);
  sweetPosAttr.setUsage(DynamicDrawUsage);
  sweetNormAttr.setUsage(DynamicDrawUsage);
  sweetTagAttr.setUsage(DynamicDrawUsage);
  meshGeo.setAttribute("position", posAttr);
  meshGeo.setAttribute("normal", normAttr);
  meshGeo.setAttribute("sweetPos", sweetPosAttr);
  meshGeo.setAttribute("sweetNorm", sweetNormAttr);
  meshGeo.setAttribute("sweetTag", sweetTagAttr);
  meshGeo.setDrawRange(0, 0);

  const mesh = new Mesh(meshGeo, bodyMaterial);
  mesh.frustumCulled = false;
  mesh.userData.noShadow = true;

  const lineGeo = new BufferGeometry();
  const edgeAttr = new BufferAttribute(new Float32Array(MAX_EDGE_VERTS * 3), 3);
  edgeAttr.setUsage(DynamicDrawUsage);
  lineGeo.setAttribute("position", edgeAttr);
  lineGeo.setDrawRange(0, 0);

  const lines = new LineSegments(lineGeo, edgeMaterial);
  lines.frustumCulled = false;

  return { mesh, lines, posAttr, normAttr, sweetPosAttr, sweetNormAttr, sweetTagAttr, edgeAttr };
}

const _minMaxD = [0, 0];

export function createShadowState() {
  const data = new Float32Array(MAX_SHADOW_BOXES * SHADOW_TEX_ROWS * 4);
  const tex = new DataTexture(
    data,
    MAX_SHADOW_BOXES,
    SHADOW_TEX_ROWS,
    RGBAFormat,
    FloatType,
  );
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const uniforms = {
    uShadowBoxes: { value: tex },
    uShadowBoxCount: { value: 0 },
    uShadowWasherMode: { value: 0 },
    uShadowCurveMode: { value: 0 },
    uShadowCurveA: { value: new Vector4() },
    uShadowCurveB: { value: new Vector4() },
    uShadowCurveC: { value: new Vector4() },
    uShadowSegmented: { value: 1 },
    uShadowStrength: { value: 0.8 },
    uShadowGap: { value: 0.32 },
    uShadowLightDir: { value: new Vector3(-0.62, 0.58, 0.78).normalize() },
    uShadowTint: { value: new Color("#383a42") },
  };
  return { data, tex, uniforms };
}

export class AnamorphicRig {
  constructor({ bodyMaterial, edgeMaterial, shadowState = null }) {
    this.group = new Group();
    this.segmentGroup = new Group();
    this.group.add(this.segmentGroup);

    this.bodyMaterial = bodyMaterial;
    this.edgeMaterial = edgeMaterial;
    this.pool = [];
    this.showEdges = true;
    this._thicknessSum = 0;
    this._cachedForm = null;
    this._cachedDepthScale = NaN;
    this._cachedLoopInfos = null;
    this._cachedCrossRow = new Float32Array(MAX_SHADOW_BOXES * 4);

    const shadow = shadowState ?? createShadowState();
    this.shadowBoxData = shadow.data;
    this.shadowBoxTex = shadow.tex;
    this.shadowUniforms = shadow.uniforms;
  }

  _writeOBB(
    boxIdx,
    loop,
    loopId,
    loopInfo,
    s0,
    s1,
    sSelfSkip,
    depthScale,
    cornerSampler = null,
    zOffset = 0,
    fixedZPortal = null,
    selfMidOverride = null,
    fullHalfOverride = null,
  ) {
    if (boxIdx >= MAX_SHADOW_BOXES || s1 - s0 <= 1e-4) return boxIdx;
    const ringCount = loop.ringCount ?? 4;
    const sMid = 0.5 * (s0 + s1);
    if (loop.hiddenShadowRange) {
      let fm = sMid % 1;
      if (fm < 0) fm += 1;
      if (fm >= loop.hiddenShadowRange[0] && fm <= loop.hiddenShadowRange[1]) {
        return boxIdx;
      }
    }
    const s0Probe = loop.open && s0 < 3e-4 && s1 > 0.02 ? Math.max(s0, 3e-4) : s0;
    const s1Probe = loop.open && s1 > 1 - 3e-4 && s0 < 0.98 ? Math.min(s1, 1 - 3e-4) : s1;
    evalSliceCorners(loop, s0Probe, 1, _obbPts0, depthScale, cornerSampler);
    evalSliceCorners(loop, s1Probe, -1, _obbPts1, depthScale, cornerSampler);
    ringCentroid(_obbPts0, ringCount, _obbC0);
    ringCentroid(_obbPts1, ringCount, _obbC1);
    _obbC0.z += zOffset;
    _obbC1.z += zOffset;
    const useAxisDir = typeof loop.sampleAxisDir === "function";
    if (useAxisDir) {
      evalSliceCorners(loop, sMid, 1, _obbPtsMid, depthScale, cornerSampler);
      ringCentroid(_obbPtsMid, ringCount, _obbCMid);
      _obbCMid.z += zOffset;
      loop.sampleAxisDir(sMid, _obbU);
      _obbU.z *= depthScale;
      const axisLen = _obbU.length();
      if (axisLen < 1e-6) return boxIdx;
      _obbU.multiplyScalar(1 / axisLen);
    } else {
      if (s1 - s0 > 0.03) {
        const spanS = s1 - s0;
        evalSliceCorners(loop, s0 + 0.35 * spanS, 1, _obbPtsMid, depthScale, cornerSampler);
        ringCentroid(_obbPtsMid, ringCount, _n0);
        evalSliceCorners(loop, s0 + 0.65 * spanS, -1, _obbPtsMid, depthScale, cornerSampler);
        ringCentroid(_obbPtsMid, ringCount, _n1);
        _obbU.subVectors(_n1, _n0);
      } else {
        _obbU.subVectors(_obbC1, _obbC0);
      }
      evalSliceCorners(loop, sMid, 1, _obbPtsMid, depthScale, cornerSampler);
      ringCentroid(_obbPtsMid, ringCount, _obbCMid);
      _obbCMid.z += zOffset;
      const lenU = _obbU.length();
      if (lenU < 1e-4) _obbU.subVectors(_obbC1, _obbC0);
      const lenU2 = _obbU.length();
      if (lenU2 < 1e-4) return boxIdx;
      _obbU.multiplyScalar(1 / lenU2);
    }

    // Orthonormal fallback cross-section frame (axisV, axisW) around axisU
    if (ringCount === 8) {
      _obbV.set(
        0.5 * (_obbPtsMid[2].x + _obbPtsMid[3].x - _obbPtsMid[6].x - _obbPtsMid[7].x),
        0.5 * (_obbPtsMid[2].y + _obbPtsMid[3].y - _obbPtsMid[6].y - _obbPtsMid[7].y),
        0.5 * (_obbPtsMid[2].z + _obbPtsMid[3].z - _obbPtsMid[6].z - _obbPtsMid[7].z),
      );
    } else {
      _obbV.set(
        0.5 * (_obbPtsMid[1].x + _obbPtsMid[2].x - _obbPtsMid[0].x - _obbPtsMid[3].x),
        0.5 * (_obbPtsMid[1].y + _obbPtsMid[2].y - _obbPtsMid[0].y - _obbPtsMid[3].y),
        0.5 * (_obbPtsMid[1].z + _obbPtsMid[2].z - _obbPtsMid[0].z - _obbPtsMid[3].z),
      );
    }
    _obbV.addScaledVector(_obbU, -_obbV.dot(_obbU));
    if (_obbV.lengthSq() < 1e-8) {
      if (Math.abs(_obbU.z) < 0.9) _obbV.set(-_obbU.y, _obbU.x, 0);
      else _obbV.set(0, -_obbU.z, _obbU.y);
    }
    _obbV.normalize();
    _obbW.crossVectors(_obbU, _obbV).normalize();

    let useExactNormals = false;
    if (!useAxisDir) {
      _d1.subVectors(_obbPtsMid[1], _obbPtsMid[0]);
      _obbN1.crossVectors(_d1, _obbU);
      _obbN1.addScaledVector(_obbU, -_obbN1.dot(_obbU));
      const i2a = ringCount === 8 ? 2 : 1;
      const i2b = ringCount === 8 ? 3 : 2;
      _d2.subVectors(_obbPtsMid[i2b], _obbPtsMid[i2a]);
      _obbN2.crossVectors(_d2, _obbU);
      _obbN2.addScaledVector(_obbU, -_obbN2.dot(_obbU));
      if (_obbN1.lengthSq() > 1e-10 && _obbN2.lengthSq() > 1e-10) {
        _obbN1.normalize();
        _obbN2.normalize();
        if (_fn.crossVectors(_obbN1, _obbN2).lengthSq() > 1e-3) {
          useExactNormals = true;
        }
      }
    }
    if (!useExactNormals) {
      _obbN1.copy(_obbV);
      _obbN2.copy(_obbW);
    }

    _obbDual1.crossVectors(_obbU, _obbN2);
    const detD1 = _obbDual1.dot(_obbN1);
    _obbDual1.multiplyScalar(1 / ((detD1 >= 0 ? 1 : -1) * Math.max(1e-5, Math.abs(detD1))));
    _obbDual2.crossVectors(_obbU, _obbN1);
    const detD2 = _obbDual2.dot(_obbN2);
    _obbDual2.multiplyScalar(1 / ((detD2 >= 0 ? 1 : -1) * Math.max(1e-5, Math.abs(detD2))));

    let minU = Infinity;
    let maxU = -Infinity;
    let min1 = Infinity;
    let max1 = -Infinity;
    let min2 = Infinity;
    let max2 = -Infinity;
    const rings = [_obbPts0, _obbPtsMid, _obbPts1];
    for (let ri = 0; ri < 3; ri++) {
      const ring = rings[ri];
      const measureCross = useAxisDir || ri === 1;
      for (let c = 0; c < ringCount; c++) {
        const dx = ring[c].x - _obbCMid.x;
        const dy = ring[c].y - _obbCMid.y;
        const dz = ring[c].z + zOffset - _obbCMid.z;
        const pu = dx * _obbU.x + dy * _obbU.y + dz * _obbU.z;
        if (pu < minU) minU = pu;
        if (pu > maxU) maxU = pu;
        if (measureCross) {
          const p1 = dx * _obbN1.x + dy * _obbN1.y + dz * _obbN1.z;
          const p2 = dx * _obbN2.x + dy * _obbN2.y + dz * _obbN2.z;
          if (p1 < min1) min1 = p1;
          if (p1 > max1) max1 = p1;
          if (p2 < min2) min2 = p2;
          if (p2 > max2) max2 = p2;
        }
      }
    }
    if (maxU - minU < 1e-4) return boxIdx;

    const bevelTrim = useExactNormals ? 1 : 1 - 0.12 * (loop.chamfer ?? 0);
    const midU = 0.5 * (minU + maxU);
    const mid1 = 0.5 * (min1 + max1);
    const mid2 = 0.5 * (min2 + max2);
    const halfU = 0.5 * (maxU - minU);
    const half1 = Math.max(0.01, 0.5 * (max1 - min1) * bevelTrim);
    const half2 = Math.max(0.01, 0.5 * (max2 - min2) * bevelTrim);
    const cx = _obbCMid.x + midU * _obbU.x + mid1 * _obbDual1.x + mid2 * _obbDual2.x;
    const cy = _obbCMid.y + midU * _obbU.y + mid1 * _obbDual1.y + mid2 * _obbDual2.y;
    const cz = _obbCMid.z + midU * _obbU.z + mid1 * _obbDual1.z + mid2 * _obbDual2.z;

    if (computePolygonCapNormal(_obbPts0, ringCount, true, _obbCap0)) {
      const dot0 = _obbCap0.dot(_obbU);
      if (dot0 > 0) _obbCap0.negate();
      if (Math.abs(dot0) < 0.05) _obbCap0.copy(_obbU).negate();
    } else {
      _obbCap0.copy(_obbU).negate();
    }
    if (computePolygonCapNormal(_obbPts1, ringCount, false, _obbCap1)) {
      const dot1 = _obbCap1.dot(_obbU);
      if (dot1 < 0) _obbCap1.negate();
      if (Math.abs(dot1) < 0.05) _obbCap1.copy(_obbU);
    } else {
      _obbCap1.copy(_obbU);
    }

    let minCap0 = Infinity;
    let maxCap0 = -Infinity;
    let minCap1 = Infinity;
    let maxCap1 = -Infinity;
    for (let c = 0; c < ringCount; c++) {
      const v0 =
        (_obbPts0[c].x - cx) * _obbCap0.x +
        (_obbPts0[c].y - cy) * _obbCap0.y +
        (_obbPts0[c].z + zOffset - cz) * _obbCap0.z;
      if (v0 < minCap0) minCap0 = v0;
      if (v0 > maxCap0) maxCap0 = v0;
      const v1 =
        (_obbPts1[c].x - cx) * _obbCap1.x +
        (_obbPts1[c].y - cy) * _obbCap1.y +
        (_obbPts1[c].z + zOffset - cz) * _obbCap1.z;
      if (v1 < minCap1) minCap1 = v1;
      if (v1 > maxCap1) maxCap1 = v1;
    }
    let dCap0 = maxCap0 - 0.25 * (maxCap0 - minCap0);
    let dCap1 = maxCap1 - 0.25 * (maxCap1 - minCap1);
    let dCap0b = 0;
    let dCap1b = 0;
    let cap3Flags = 0;
    const saddleTol = 1e-3 * Math.max(half1, half2);
    if ((ringCount === 8 || ringCount === 4) && maxCap0 - minCap0 > saddleTol) {
      extractSaddleCapPlanes(
        _obbPts0,
        ringCount,
        zOffset,
        cx,
        cy,
        cz,
        _obbU,
        -1,
        _obbCap0,
        _obbCap0b,
        _saddleD,
      );
      dCap0 = _saddleD[0];
      dCap0b = _saddleD[1];
      cap3Flags |= 1;
    } else {
      _obbCap0b.set(0, 0, 0);
    }
    if ((ringCount === 8 || ringCount === 4) && maxCap1 - minCap1 > saddleTol) {
      extractSaddleCapPlanes(
        _obbPts1,
        ringCount,
        zOffset,
        cx,
        cy,
        cz,
        _obbU,
        1,
        _obbCap1,
        _obbCap1b,
        _saddleD,
      );
      dCap1 = _saddleD[0];
      dCap1b = _saddleD[1];
      cap3Flags |= 2;
    } else {
      _obbCap1b.set(0, 0, 0);
    }
    const chEncode = useExactNormals && ringCount === 8 ? Math.max(0, Math.min(0.45, loop.chamfer ?? 0)) : 0;
    const capScale0 = 1 + chEncode;
    const capScale1 = 1 + 0.5 * cap3Flags;

    this._thicknessSum += Math.min(half1, half2);
    const barIdVal = loopInfo.barIdAt(sMid, 0);
    const zPortal =
      fixedZPortal !== null ? fixedZPortal + zOffset : loopInfo.cumPortalZ(sMid, 1);
    const packedBoxId = packLoopBarId(
      loopId,
      loopInfo.hasPortals,
      loopInfo.selfCross,
      loopInfo.numBars,
      barIdVal,
    );

    const stride = MAX_SHADOW_BOXES * 4;
    const b4 = boxIdx * 4;
    const data = this.shadowBoxData;

    data[0 * stride + b4] = cx;
    data[0 * stride + b4 + 1] = cy;
    data[0 * stride + b4 + 2] = cz;
    data[0 * stride + b4 + 3] = packedBoxId;

    data[1 * stride + b4] = _obbU.x;
    data[1 * stride + b4 + 1] = _obbU.y;
    data[1 * stride + b4 + 2] = _obbU.z;
    data[1 * stride + b4 + 3] = halfU;

    data[2 * stride + b4] = _obbN1.x;
    data[2 * stride + b4 + 1] = _obbN1.y;
    data[2 * stride + b4 + 2] = _obbN1.z;
    data[2 * stride + b4 + 3] = half1;

    data[3 * stride + b4] = _obbN2.x;
    data[3 * stride + b4 + 1] = _obbN2.y;
    data[3 * stride + b4 + 2] = _obbN2.z;
    data[3 * stride + b4 + 3] = half2;

    const halfS = fullHalfOverride !== null ? fullHalfOverride : Math.max(1e-4, 0.5 * (s1 - s0));
    data[4 * stride + b4] = selfMidOverride !== null ? selfMidOverride : sMid;
    data[4 * stride + b4 + 1] = sSelfSkip;
    data[4 * stride + b4 + 2] = zPortal;
    data[4 * stride + b4 + 3] = loopInfo.isOpen ? -halfS : halfS;

    data[5 * stride + b4] = _obbCap0.x * capScale0;
    data[5 * stride + b4 + 1] = _obbCap0.y * capScale0;
    data[5 * stride + b4 + 2] = _obbCap0.z * capScale0;
    data[5 * stride + b4 + 3] = dCap0;

    data[6 * stride + b4] = _obbCap1.x * capScale1;
    data[6 * stride + b4 + 1] = _obbCap1.y * capScale1;
    data[6 * stride + b4 + 2] = _obbCap1.z * capScale1;
    data[6 * stride + b4 + 3] = dCap1;

    const e1x = _obbDual1.x * half1;
    const e1y = _obbDual1.y * half1;
    const e1z = _obbDual1.z * half1;
    const e2x = _obbDual2.x * half2;
    const e2y = _obbDual2.y * half2;
    const e2z = _obbDual2.z * half2;
    const diagP = Math.hypot(e1x + e2x, e1y + e2y, e1z + e2z);
    const diagM = Math.hypot(e1x - e2x, e1y - e2y, e1z - e2z);
    const crossR = Math.max(diagP, diagM);
    const padScale = Math.hypot(1, _obbDual1.length() + _obbDual2.length());
    const boundR = Math.hypot(halfU, crossR) + 0.22 * Math.max(0, padScale - 1) + 1e-3;

    let invBevMin = 0;
    if (chEncode > 1e-4) {
      const invH1 = 1 / half1;
      const invH2 = 1 / half2;
      const bpx = _obbN1.x * invH1 + _obbN2.x * invH2;
      const bpy = _obbN1.y * invH1 + _obbN2.y * invH2;
      const bpz = _obbN1.z * invH1 + _obbN2.z * invH2;
      const bmx = _obbN1.x * invH1 - _obbN2.x * invH2;
      const bmy = _obbN1.y * invH1 - _obbN2.y * invH2;
      const bmz = _obbN1.z * invH1 - _obbN2.z * invH2;
      const maxSq = Math.max(
        1e-8,
        bpx * bpx + bpy * bpy + bpz * bpz,
        bmx * bmx + bmy * bmy + bmz * bmz,
      );
      invBevMin = 1 / Math.sqrt(maxSq);
    }

    data[7 * stride + b4] = e1x;
    data[7 * stride + b4 + 1] = e1y;
    data[7 * stride + b4 + 2] = e1z;
    data[7 * stride + b4 + 3] = boundR;

    data[8 * stride + b4] = e2x;
    data[8 * stride + b4 + 1] = e2y;
    data[8 * stride + b4 + 2] = e2z;
    data[8 * stride + b4 + 3] = invBevMin;

    data[9 * stride + b4] = cz - loopInfo.barPortalZ(sMid, barIdVal);
    data[9 * stride + b4 + 1] = barIdVal;
    data[9 * stride + b4 + 2] = cap3Flags;
    data[9 * stride + b4 + 3] = loopInfo.lapJump;

    data[11 * stride + b4] = _obbCap0b.x;
    data[11 * stride + b4 + 1] = _obbCap0b.y;
    data[11 * stride + b4 + 2] = _obbCap0b.z;
    data[11 * stride + b4 + 3] = dCap0b;

    data[12 * stride + b4] = _obbCap1b.x;
    data[12 * stride + b4 + 1] = _obbCap1b.y;
    data[12 * stride + b4 + 2] = _obbCap1b.z;
    data[12 * stride + b4 + 3] = dCap1b;

    return boxIdx + 1;
  }

  // Illusion-space boxes for an open path drawn as one piece (continuous mode, or kept solid while loops march).
  _writeOpenLoopBoxes(boxCount, loop, li, loopInfo, depthScale) {
    const zones = loop.portalZones;
    if (!zones || zones.length === 0) {
      if (loop.obbSpans) {
        for (let k = 0; k < loop.obbSpans.length; k++) {
          const sp = loop.obbSpans[k];
          boxCount = this._writeOBB(
            boxCount,
            loop,
            li,
            loopInfo,
            sp[0],
            sp[1],
            (sp[1] - sp[0]) * 0.5 + 0.01,
            depthScale,
          );
        }
      } else {
        boxCount = this._writeOBB(boxCount, loop, li, loopInfo, 0, 1, 1.1, depthScale);
      }
    } else {
      _barCutScratch.length = 0;
      _barCutScratch.push(0, 1);
      if (loop.splits) {
        for (let i = 0; i < loop.splits.length; i++) _barCutScratch.push(loop.splits[i]);
      }
      if (loop.corners) {
        for (let i = 0; i < loop.corners.length; i++) _barCutScratch.push(loop.corners[i]);
      }
      _barCutScratch.sort((a, b) => a - b);
      for (let i = 0; i + 1 < _barCutScratch.length; i++) {
        const sA = _barCutScratch[i];
        const sB = _barCutScratch[i + 1];
        const pLen = sB - sA;
        if (pLen <= 1e-3) continue;
        const ca = sA + (i > 0 ? 1e-5 : 0);
        const cb = sB - (i + 2 < _barCutScratch.length ? 1e-5 : 0);
        boxCount = this._writeOBB(
          boxCount,
          loop,
          li,
          loopInfo,
          ca,
          cb,
          1.1,
          depthScale,
        );
      }
    }
    return boxCount;
  }

  // skipPad: how far past the block's ends a receiver still counts as the block itself (kept inside the gap, or the
  // neighbour's end face would skip this block and show lit).
  _writeSegmentedSpanOBBs(boxIdx, loop, loopId, loopInfo, s0, s1, depthScale, skipPad = 0.004) {
    if (boxIdx >= MAX_SHADOW_BOXES || s1 - s0 <= 1e-4) return boxIdx;
    const fullMid = 0.5 * (s0 + s1);
    const fullHalf = Math.max(1e-4, 0.5 * (s1 - s0));
    const fullSkip = fullHalf + skipPad;
    const isOpen = Boolean(loop.open);

    _barCutScratch.length = 0;
    _barCutScratch.push(s0, s1);

    const pushBreaks = (arr) => {
      if (!arr || arr.length === 0) return;
      if (isOpen) {
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (v > s0 + 1e-5 && v < s1 - 1e-5) _barCutScratch.push(v);
        }
      } else {
        const kMin = Math.floor(s0) - 1;
        const kMax = Math.ceil(s1) + 1;
        for (let k = kMin; k <= kMax; k++) {
          for (let i = 0; i < arr.length; i++) {
            const v = k + arr[i];
            if (v > s0 + 1e-5 && v < s1 - 1e-5) _barCutScratch.push(v);
          }
        }
      }
    };

    pushBreaks(loop.splits);
    pushBreaks(loop.corners);
    _barCutScratch.sort((a, b) => a - b);

    const isSmoothCurved = !loop.flatShaded && (!loop.corners || loop.corners.length === 0);
    let outIdx = boxIdx;
    for (let i = 0; i + 1 < _barCutScratch.length; i++) {
      const a = _barCutScratch[i];
      const b = _barCutScratch[i + 1];
      const span = b - a;
      if (span <= 1e-4) continue;
      if (isSmoothCurved && span > 0.062) {
        const chords = Math.min(3, Math.ceil(span / 0.062));
        for (let c = 0; c < chords; c++) {
          const ca = Math.max(a + 1e-5, a + (span * c) / chords - 0.0012);
          const cb = Math.min(b - 1e-5, a + (span * (c + 1)) / chords + 0.0012);
          outIdx = this._writeOBB(
            outIdx,
            loop,
            loopId,
            loopInfo,
            ca,
            cb,
            fullSkip,
            depthScale,
            null,
            0,
            null,
            fullMid,
            fullHalf,
          );
        }
      } else {
        outIdx = this._writeOBB(
          outIdx,
          loop,
          loopId,
          loopInfo,
          a,
          b,
          fullSkip,
          depthScale,
          null,
          0,
          null,
          fullMid,
          fullHalf,
        );
      }
    }
    return outIdx;
  }

  _writeWasherSlab(boxIdx, loop, loopId, loopInfo, pieceIdx, depthScale) {
    if (boxIdx >= MAX_SHADOW_BOXES || !loop.washerSlab) return boxIdx;
    const ws = loop.washerSlab;
    const zShift = pieceIdx === 0 ? ws.zFront * depthScale : 0;
    const sMid = pieceIdx === 0 ? ws.sMid0 : ws.sMid2;
    const pieceFlag = pieceIdx === 0 ? -100.0 : -200.0;

    // Forward basis columns M = [Au, An, Av] in depthScale-scaled sweet-spot space
    const auX = ws.Au[0];
    const auY = ws.Au[1];
    const auZ = ws.Au[2] * depthScale;
    const anX = ws.An[0];
    const anY = ws.An[1];
    const anZ = ws.An[2] * depthScale;
    const avX = ws.Av[0];
    const avY = ws.Av[1];
    const avZ = ws.Av[2] * depthScale;

    // Exact inverse rows R_u, R_n, R_v = M^-1 so dot(rel, R_*) recovers (u, w, v) for any Tilt/Roll/DepthSplit
    const c0x = anY * avZ - anZ * avY;
    const c0y = anZ * avX - anX * avZ;
    const c0z = anX * avY - anY * avX;
    const det = auX * c0x + auY * c0y + auZ * c0z;
    if (Math.abs(det) < 1e-8) return boxIdx;
    const invDet = 1 / det;

    const ruX = c0x * invDet;
    const ruY = c0y * invDet;
    const ruZ = c0z * invDet;

    const rnX = (avY * auZ - avZ * auY) * invDet;
    const rnY = (avZ * auX - avX * auZ) * invDet;
    const rnZ = (avX * auY - avY * auX) * invDet;

    const rvX = (auY * anZ - auZ * anY) * invDet;
    const rvY = (auZ * anX - auX * anZ) * invDet;
    const rvZ = (auX * anY - auY * anX) * invDet;

    this._thicknessSum += ws.halfT;
    const packedBoxId = packLoopBarId(loopId, loopInfo.hasPortals, false, loopInfo.numBars, 62);

    const stride = MAX_SHADOW_BOXES * 4;
    const b4 = boxIdx * 4;
    const data = this.shadowBoxData;

    data[0 * stride + b4] = ws.cx;
    data[0 * stride + b4 + 1] = ws.cy;
    data[0 * stride + b4 + 2] = ws.cz * depthScale + zShift;
    data[0 * stride + b4 + 3] = packedBoxId;

    data[1 * stride + b4] = ruX;
    data[1 * stride + b4 + 1] = ruY;
    data[1 * stride + b4 + 2] = ruZ;
    data[1 * stride + b4 + 3] = ws.rSquare;

    data[2 * stride + b4] = rnX;
    data[2 * stride + b4 + 1] = rnY;
    data[2 * stride + b4 + 2] = rnZ;
    data[2 * stride + b4 + 3] = ws.halfT;

    data[3 * stride + b4] = rvX;
    data[3 * stride + b4 + 1] = rvY;
    data[3 * stride + b4 + 2] = rvZ;
    data[3 * stride + b4 + 3] = ws.rCircle;

    data[4 * stride + b4] = sMid;
    data[4 * stride + b4 + 1] = ws.aRatio;
    data[4 * stride + b4 + 2] = zShift;
    data[4 * stride + b4 + 3] = pieceFlag;

    data[5 * stride + b4] = ws.bandW ?? 0;
    data[5 * stride + b4 + 1] = ws.bandExtent ?? 0;
    data[5 * stride + b4 + 2] = 0;
    data[5 * stride + b4 + 3] = 0;

    data[6 * stride + b4] = 0;
    data[6 * stride + b4 + 1] = 0;
    data[6 * stride + b4 + 2] = 0;
    data[6 * stride + b4 + 3] = 0;

    data[7 * stride + b4] = 0;
    data[7 * stride + b4 + 1] = 0;
    data[7 * stride + b4 + 2] = 0;
    data[7 * stride + b4 + 3] = 0;

    data[8 * stride + b4] = 0;
    data[8 * stride + b4 + 1] = 0;
    data[8 * stride + b4 + 2] = 0;
    data[8 * stride + b4 + 3] = 0;

    data[9 * stride + b4] = 0;
    data[9 * stride + b4 + 1] = 0;
    data[9 * stride + b4 + 2] = 0;
    data[9 * stride + b4 + 3] = 0;

    data[11 * stride + b4] = 0;
    data[11 * stride + b4 + 1] = 0;
    data[11 * stride + b4 + 2] = 0;
    data[11 * stride + b4 + 3] = 0;

    data[12 * stride + b4] = 0;
    data[12 * stride + b4 + 1] = 0;
    data[12 * stride + b4 + 2] = 0;
    data[12 * stride + b4 + 3] = 0;

    return boxIdx + 1;
  }

  setEdgesVisible(visible) {
    this.showEdges = visible;
    for (const unit of this.pool) {
      unit.lines.visible = unit.mesh.visible && visible;
    }
  }

  _ensurePool(count) {
    while (this.pool.length < count) {
      const unit = createSegmentUnit(this.bodyMaterial, this.edgeMaterial);
      this.pool.push(unit);
      this.segmentGroup.add(unit.mesh, unit.lines);
    }
  }

  _activateUnit(idx) {
    const unit = this.pool[idx];
    unit.mesh.visible = true;
    unit.lines.visible = this.showEdges;
    return unit;
  }

  update(
    form,
    phase,
    {
      segmented = true,
      offAxis = false,
      offAxisBlend = 0,
      shadeBlend = offAxisBlend,
      split = 1,
      splitStyle = "together",
      solidOpenLoops = false,
      depthScale = 1,
      perspDist = 0,
      zCompress = 1,
    } = {},
  ) {
    // offAxisBlend below only bends normals; geometry reads geomBlend.
    const geomBlend = offAxisBlend;
    offAxisBlend = shadeBlend;
    const loops = form.loops;
    let cursor = 0;
    let boxCount = 0;
    this._thicknessSum = 0;

    if (this._cachedForm !== form || this._cachedDepthScale !== depthScale) {
      this._cachedForm = form;
      this._cachedDepthScale = depthScale;
      this._cachedLoopInfos = loops.map((lp) => buildLoopPortalInfo(lp, depthScale));
      buildBarCrossRow(loops, this._cachedLoopInfos, depthScale, this._cachedCrossRow);
    }
    const loopInfos = this._cachedLoopInfos;
    this.shadowBoxData.set(this._cachedCrossRow, 10 * MAX_SHADOW_BOXES * 4);

    if (!segmented) {
      for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const loopInfo = loopInfos[li];
        const splits = loop.splits && loop.splits.length > 0 ? loop.splits : [0];
        const numPieces = splits.length;
        const totalSteps = loop.continuousSteps ?? 180;
        const smoothPortals = Boolean(loop.smoothPortalNormals);
        const zones = loop.portalZones;

        if (loop.unbrokenClosed) {
          this._ensurePool(cursor + 1);
          const unit = this._activateUnit(cursor++);
          updateSegmentUnit(unit, loop, 0, 1, {
            stepsOverride: totalSteps,
            capStart: false,
            capEnd: false,
            edgeStart: false,
            edgeEnd: false,
            depthScale,
            offAxisBlend,
            loopId: li,
            loopInfo,
          });
        } else if (loop.open) {
          const capSOpen = loop.weldStart ? false : Boolean(loop.capStartAlways) || offAxis;
          const capEOpen = loop.weldEnd ? false : Boolean(loop.capEndAlways) || offAxis;
          const chamSOpen = Boolean(loop.capStartAlways);
          const chamEOpen = Boolean(loop.capEndAlways);
          if (!zones || zones.length === 0) {
            this._ensurePool(cursor + 1);
            const unit = this._activateUnit(cursor++);
            updateSegmentUnit(unit, loop, 0, 1, {
              stepsOverride: totalSteps,
              capStart: capSOpen,
              capEnd: capEOpen,
              edgeStart: capSOpen,
              edgeEnd: capEOpen,
              chamferCapStart: chamSOpen,
              chamferCapEnd: chamEOpen,
              depthScale,
              offAxisBlend,
              loopId: li,
              loopInfo,
            });
          } else if (zones.length === 1) {
            // Open straight beam with 1 sightline portal `sCut0` -> 2 clipped half-space sections
            const z0 = zones[0];
            const pad = z0.overhangS * 1.1;
            const baseZp0 = loopInfo.cumPortalZ(z0.sCut, -1);
            this._ensurePool(cursor + 2);
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                0,
                Math.min(1, z0.sCut + pad),
                {
                  stepsOverride: 10,
                  capStart: capSOpen,
                  capEnd: false,
                  edgeStart: capSOpen,
                  edgeEnd: false,
                  chamferCapStart: chamSOpen,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z0.sampleUnbrokenCorners,
                  cornersOverride: z0.corners,
                  hingesOverride: z0.hinges,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp0,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z0,
                false,
                0,
                offAxis,
                loopInfo,
              );
            }
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                Math.max(0, z0.sCut - pad),
                1,
                {
                  stepsOverride: 10,
                  capStart: false,
                  capEnd: capEOpen,
                  edgeStart: false,
                  edgeEnd: capEOpen,
                  chamferCapEnd: chamEOpen,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z0.sampleUnbrokenCorners,
                  cornersOverride: z0.corners,
                  hingesOverride: z0.hinges,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp0,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z0,
                true,
                z0.jz * depthScale,
                offAxis,
                loopInfo,
              );
            }
          } else {
            // Open straight pillar with 2 sightline portals `[sCut0, sCut1]` -> 4 clipped half-space sections
            const z0 = zones[0];
            const z1 = zones[1];
            const pad = z0.overhangS * 1.1;
            const sMid = 0.5 * (z0.sCut + z1.sCut);
            const baseZp0 = loopInfo.cumPortalZ(z0.sCut, -1);
            const baseZp1 = loopInfo.cumPortalZ(z1.sCut, -1);
            this._ensurePool(cursor + 4);

            // 1. Base stub [0, sCut0] clipped to d_0 <= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                0,
                Math.min(1, z0.sCut + pad),
                {
                  stepsOverride: 10,
                  capStart: capSOpen,
                  capEnd: false,
                  edgeStart: capSOpen,
                  edgeEnd: false,
                  chamferCapStart: chamSOpen,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z0.sampleUnbrokenCorners,
                  cornersOverride: z0.corners,
                  hingesOverride: z0.hinges,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp0,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z0,
                false,
                0,
                offAxis,
                loopInfo,
              );
            }
            // 2. Shifted middle span lower half [sCut0, sMid] clipped to d_0 >= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                Math.max(0, z0.sCut - pad),
                sMid,
                {
                  stepsOverride: 10,
                  capStart: false,
                  capEnd: false,
                  edgeStart: false,
                  edgeEnd: false,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z0.sampleUnbrokenCorners,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp0,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z0,
                true,
                z0.jz * depthScale,
                offAxis,
                loopInfo,
              );
            }
            // 3. Shifted middle span upper half [sMid, sCut1] clipped to d_1 <= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                sMid,
                Math.min(1, z1.sCut + pad),
                {
                  stepsOverride: 10,
                  capStart: false,
                  capEnd: false,
                  edgeStart: false,
                  edgeEnd: false,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z1.sampleUnbrokenCorners,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp1,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z1,
                false,
                0,
                offAxis,
                loopInfo,
              );
            }
            // 4. Top stub [sCut1, 1] clipped to d_1 >= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                Math.max(0, z1.sCut - pad),
                1,
                {
                  stepsOverride: 10,
                  capStart: false,
                  capEnd: capEOpen,
                  edgeStart: false,
                  edgeEnd: capEOpen,
                  chamferCapEnd: chamEOpen,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: z1.sampleUnbrokenCorners,
                  cornersOverride: z1.corners,
                  hingesOverride: z1.hinges,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp1,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                z1,
                true,
                z1.jz * depthScale,
                offAxis,
                loopInfo,
              );
            }
          }
        } else if (zones && zones.length === numPieces) {
          // Exact sightline-plane half-space cuts at both portal ends of each continuous piece
          this._ensurePool(cursor + numPieces * 3);
          for (let pi = 0; pi < numPieces; pi++) {
            const sA = splits[pi];
            const sB = pi + 1 < numPieces ? splits[pi + 1] : splits[0] + 1;
            const pieceLen = sB - sA;
            const zoneStart = zones[pi];
            const zoneEnd = zones[(pi + 1) % numPieces];
            const padStart = Math.min(
              zoneStart.overhangS * 1.1,
              (zoneStart.guardBeforeS ?? Infinity) * 0.95,
            );
            const padEnd = Math.min(
              zoneEnd.overhangS * 1.1,
              (zoneEnd.guardAfterS ?? Infinity) * 0.95,
            );
            const padInnerStart = Math.min(
              pieceLen * 0.5,
              (zoneStart.guardAfterS ?? Infinity) * 0.95,
              Math.max(padStart * 1.35, Math.min(0.11, pieceLen * 0.32)),
            );
            const padInnerEnd = Math.min(
              pieceLen * 0.5,
              (zoneEnd.guardBeforeS ?? Infinity) * 0.95,
              Math.max(padEnd * 1.35, Math.min(0.11, pieceLen * 0.32)),
            );
            const zpStart = loopInfo.cumPortalZ(zoneStart.sCut, -1);
            const zpEnd = loopInfo.cumPortalZ(zoneEnd.sCut, -1);
            const headSteps = loop.flatShaded
              ? 12
              : Math.max(12, Math.round((padStart + padInnerStart) * totalSteps));
            const tailSteps = loop.flatShaded
              ? 12
              : Math.max(12, Math.round((padEnd + padInnerEnd) * totalSteps));

            // 1. Head section clipped to d_start >= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                zoneStart.sCut - padStart,
                zoneStart.sCut + padInnerStart,
                {
                  stepsOverride: headSteps,
                  capStart: false,
                  capEnd: false,
                  edgeStart: false,
                  edgeEnd: false,
                  smoothPortalStart: true,
                  smoothPortalEnd: true,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: zoneStart.sampleUnbrokenCorners,
                  cornersOverride: zoneStart.corners,
                  threeWayCornersOverride: zoneStart.threeWayCorners,
                  hingesOverride: zoneStart.hinges,
                  periodicSpecials: false,
                  forceSubdivide: true,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: zpStart,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                zoneStart,
                true,
                zoneStart.jz * depthScale,
                offAxis,
                loopInfo,
              );
            }

            // 2. Unclipped interior span [sA + padInnerStart, sB - padInnerEnd]
            if (sB - padInnerEnd > sA + padInnerStart + 1e-6) {
              const midSteps = Math.max(
                24,
                Math.round((pieceLen - padInnerStart - padInnerEnd) * totalSteps),
              );
              const unit = this._activateUnit(cursor++);
              updateSegmentUnit(unit, loop, sA + padInnerStart, sB - padInnerEnd, {
                stepsOverride: midSteps,
                capStart: false,
                capEnd: false,
                edgeStart: false,
                edgeEnd: false,
                smoothPortalStart: true,
                smoothPortalEnd: true,
                depthScale,
                offAxisBlend,
                forceSubdivide: loopInfo.hasPortals,
                loopId: li,
                loopInfo,
              });
            }

            // 3. Tail section clipped to d_end <= 0
            {
              const { rawVertCount, rawEdgeCount } = buildRawPrism(
                loop,
                zoneEnd.sCut - padInnerEnd,
                zoneEnd.sCut + padEnd,
                {
                  stepsOverride: tailSteps,
                  capStart: false,
                  capEnd: false,
                  edgeStart: false,
                  edgeEnd: false,
                  smoothPortalStart: true,
                  smoothPortalEnd: true,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: zoneEnd.sampleUnbrokenCorners,
                  cornersOverride: zoneEnd.corners,
                  threeWayCornersOverride: zoneEnd.threeWayCorners,
                  hingesOverride: zoneEnd.hinges,
                  periodicSpecials: false,
                  forceSubdivide: true,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: zpEnd,
                },
              );
              const unit = this._activateUnit(cursor++);
              emitHalfSpaceClippedToUnit(
                unit,
                rawVertCount,
                rawEdgeCount,
                zoneEnd,
                false,
                0,
                offAxis,
                loopInfo,
              );
            }
          }
        } else {
          // Curved continuous mode (`ring`, `figure-8`)
          this._ensurePool(cursor + numPieces);
          for (let pi = 0; pi < numPieces; pi++) {
            const sA = splits[pi];
            const sB = pi + 1 < numPieces ? splits[pi + 1] : splits[0] + 1;
            const pieceSteps = Math.max(2, Math.round((sB - sA) * totalSteps));
            const unit = this._activateUnit(cursor++);
            updateSegmentUnit(unit, loop, sA, sB, {
              stepsOverride: pieceSteps,
              capStart: offAxis,
              capEnd: offAxis,
              edgeStart: offAxis,
              edgeEnd: offAxis,
              smoothPortalStart: !offAxis && smoothPortals,
              smoothPortalEnd: !offAxis && smoothPortals,
              depthScale,
              offAxisBlend,
              loopId: li,
              loopInfo,
            });
          }
        }

        // Emit illusion-space OBBs for continuous mode (excluding continuous `ring` so Half 1's inner wall stays split-free)
        if (!loop.isRing) {
          if (loop.open) {
            boxCount = this._writeOpenLoopBoxes(boxCount, loop, li, loopInfo, depthScale);
          } else if (loop.flatShaded) {
            _barCutScratch.length = 0;
            _barCutScratch.push(0, 1);
            if (loop.splits) {
              for (let i = 0; i < loop.splits.length; i++) _barCutScratch.push(loop.splits[i]);
            }
            if (loop.corners) {
              for (let i = 0; i < loop.corners.length; i++) _barCutScratch.push(loop.corners[i]);
            }
            _barCutScratch.sort((a, b) => a - b);
            for (let i = 0; i + 1 < _barCutScratch.length; i++) {
              const a = _barCutScratch[i];
              const b = _barCutScratch[i + 1];
              if (b - a > 1e-4) {
                boxCount = this._writeOBB(
                  boxCount,
                  loop,
                  li,
                  loopInfo,
                  a,
                  b,
                  (b - a) * 0.5 + 0.004,
                  depthScale,
                );
              }
            }
          } else if (loop.washerSlab) {
            boxCount = this._writeWasherSlab(boxCount, loop, li, loopInfo, 0, depthScale);
          } else if (loop.obbSpans) {
            for (let k = 0; k < loop.obbSpans.length; k++) {
              const sp = loop.obbSpans[k];
              boxCount = this._writeOBB(
                boxCount,
                loop,
                li,
                loopInfo,
                sp[0],
                sp[1],
                (sp[1] - sp[0]) * 0.5 + 0.012,
                depthScale,
              );
            }
          } else if (!loop.curveShadow) {
            // Partition curved chords strictly within each portal piece [sA, sB] so no OBB ever straddles a portal Z-jump
            const totalChords = 132;
            for (let pi = 0; pi < numPieces; pi++) {
              const sA = splits[pi];
              const sB = pi + 1 < numPieces ? splits[pi + 1] : splits[0] + 1;
              const pLen = sB - sA;
              const pChords = Math.max(8, Math.round(pLen * totalChords));
              for (let k = 0; k < pChords; k++) {
                const a = Math.max(sA + 1e-5, sA + (pLen * k) / pChords - 0.0028);
                const b = Math.min(sB - 1e-5, sA + (pLen * (k + 1)) / pChords + 0.0028);
                boxCount = this._writeOBB(boxCount, loop, li, loopInfo, a, b, 0.06, depthScale);
              }
            }
          }
        }
      }
    } else {
      // Segmented conveyor mode: blocks travel continuously along [0, 1) and split cleanly across portals.
      for (let li = 0; li < loops.length; li++) {
        const loop = loops[li];
        const loopInfo = loopInfos[li];
        const n = Math.max(1, loop.segments | 0);
        const gap = Math.min(0.85, Math.max(0.02, loop.gap ?? 0.12));
        const segLen = (1 - gap) / n;
        const halfLen = segLen * 0.5;
        const baseSteps = loop.steps ?? 22;
        const rawPhase = phase * (loop.phaseScale ?? 1) + (loop.phaseOffset ?? 0);
        const smoothPortals = Boolean(loop.smoothPortalNormals);
        const zones = loop.portalZones;

        const isOpen = Boolean(loop.open);
        // An open path can stay one solid piece while the closed loops march.
        const solid = isOpen && solidOpenLoops;
        const pWrap = ((rawPhase % 1) + 1) % 1;
        const kStart = solid ? 0 : isOpen ? -1 : 0;
        const kEnd = solid ? 0 : isOpen ? n : n - 1;

        // split < 1 narrows the gaps (0 = blocks abut flush). Each style gives gap j a start delay in [0, 1].
        const levels = Math.max(1, Math.ceil(Math.log2(n)));
        const portalCuts = loop.splits && loop.splits.length ? loop.splits : zones ? zones.map((z) => z.sCut) : [];
        const gapDelay = (jj) => {
          switch (splitStyle) {
            case "wave":
            case "slide":
              return jj / n;
            case "alternate":
              return jj % 2 ? 1 : 0;
            case "halving": {
              // Level at which this gap appears when the loop is halved again and again.
              for (let L = 0; L <= levels; L++) {
                const x = (jj * 2 ** L) / n;
                if (Math.abs(x - Math.round(x)) < (0.5 * 2 ** L) / n) return L / levels;
              }
              return 1;
            }
            case "both ways":
              return Math.min(jj, n - jj) / Math.max(1, n / 2);
            case "joins": {
              if (!portalCuts.length) return jj / n;
              const sGap = (jj + 0.5) / n + rawPhase;
              let d = 0.5;
              for (const c of portalCuts) d = Math.min(d, Math.abs(wrapHalf(sGap - c)));
              return Math.min(1, d / 0.5);
            }
            default:
              return 0;
          }
        };
        const gapOpen = (j) => {
          if (isOpen || split >= 1) return 1;
          // Narrow gaps can't be slot-shadowed and flash lit end faces: pass through that range quickly.
          if (splitStyle === "together") return 1 - (1 - Math.max(0, split)) ** 3;
          const jj = ((j % n) + n) % n;
          const spread = splitStyle === "alternate" ? 1 : Math.min(1, 3 / n);
          const t = Math.min(1, Math.max(0, (split * (1 + spread) - gapDelay(jj)) / spread));
          return t * t * (3 - 2 * t);
        };
        const gapS = gap / n;


        for (let k = kStart; k <= kEnd; k++) {
          let s0;
          let s1;
          const openStart = gapOpen(k - 1);
          const openEnd = gapOpen(k);
          // Outlines at a block end only once its gap has opened: a closed seam shouldn't draw a line.
          const edgeAtStart = openStart > 0.08;
          const edgeAtEnd = openEnd > 0.08;
          // Bevels reach full size early: flat, unbevelled block ends in a narrow gap escape the slot shadow and show lit.
          const bevelStart = Math.min(1, openStart * 5);
          const bevelEnd = Math.min(1, openEnd * 5);
          if (solid) {
            s0 = 0;
            s1 = 1;
          } else if (isOpen) {
            const c = (k + pWrap) / n;
            s0 = Math.max(0, c - halfLen);
            s1 = Math.min(1, c + halfLen);
            if (s1 - s0 <= 0.01) continue;
          } else {
            // Slide: a gap opens by the block behind it falling back, not by both ends shrinking.
            const slide = splitStyle === "slide";
            const b0 = (k - 0.5) / n + rawPhase + (slide ? 0 : 0.5 * gapS * openStart);
            const b1 = (k + 0.5) / n + rawPhase - (slide ? gapS * openEnd : 0.5 * gapS * openEnd);
            s0 = b0 % 1;
            if (s0 < 0) s0 += 1;
            s1 = s0 + (b1 - b0);
          }

          if (zones && zones.length > 0) {
            const fullHalf = (s1 - s0) * 0.5;
            const fullMid = s0 + fullHalf;
            let zFirst = null;
            let zSecond = null;
            let dFirst = 0;
            let dSecond = 0;

            for (let zi = 0; zi < zones.length; zi++) {
              const z = zones[zi];
              const dMid = isOpen ? fullMid - z.sCut : wrapHalf(fullMid - z.sCut);
              const extraPad = geomBlend > 0.15 ? 0 : z.overhangS;
              if (Math.abs(dMid) < fullHalf + extraPad) {
                if (!zFirst) {
                  zFirst = z;
                  dFirst = dMid;
                } else {
                  zSecond = z;
                  dSecond = dMid;
                  break;
                }
              }
            }

            let partCount = 1;
            let sSplit = s1;
            if (zFirst && zSecond && !isOpen) {
              if (dFirst < dSecond) {
                const tmpZ = zFirst;
                zFirst = zSecond;
                zSecond = tmpZ;
                const tmpD = dFirst;
                dFirst = dSecond;
                dSecond = tmpD;
              }
              const cutLo = fullMid - dFirst;
              const cutHi = fullMid - dSecond;
              const midPocket = 0.5 * (cutLo + cutHi);
              if (midPocket > s0 + 2e-3 && midPocket < s1 - 2e-3) {
                partCount = 2;
                sSplit = midPocket;
              }
            }

            for (let part = 0; part < partCount; part++) {
              const p0 = part === 0 ? s0 : sSplit;
              const p1 = part === 0 && partCount === 2 ? sSplit : s1;
              const capS = part === 0;
              const capE = part === partCount - 1;
              const curHalf = (p1 - p0) * 0.5;
              const sMid = p0 + curHalf;
              const hitZone = partCount === 2 ? (part === 0 ? zFirst : zSecond) : zFirst;
              const hitDMid = hitZone
                ? isOpen
                  ? sMid - hitZone.sCut
                  : wrapHalf(sMid - hitZone.sCut)
                : 0;
              const partSteps =
                partCount === 2
                  ? Math.max(2, Math.round(((p1 - p0) / Math.max(1e-6, s1 - s0)) * baseSteps))
                  : baseSteps;

              if (!hitZone) {
                this._ensurePool(cursor + 1);
                const unit = this._activateUnit(cursor++);
                updateSegmentUnit(unit, loop, p0, p1, {
                  stepsOverride: partSteps,
                  capStart: capS,
                  capEnd: capE,
                  edgeStart: capS && edgeAtStart,
                  edgeEnd: capE && edgeAtEnd,
                  chamferCapStart: capS,
                  chamferCapEnd: capE,
                  capChamferStart: bevelStart,
                  capChamferEnd: bevelEnd,
                  smoothPortalStart: !capS,
                  smoothPortalEnd: !capE,
                  depthScale,
                  offAxisBlend,
                  loopId: li,
                  loopInfo,
                });
              } else {
                const loc0 = isOpen ? p0 : hitZone.sCut + hitDMid - curHalf;
                const loc1 = isOpen ? p1 : hitZone.sCut + hitDMid + curHalf;
                const baseZp = loopInfo.cumPortalZ(hitZone.sCut, -1);
                const { rawVertCount, rawEdgeCount } = buildRawPrism(loop, loc0, loc1, {
                  stepsOverride: partSteps,
                  capStart: capS,
                  capEnd: capE,
                  edgeStart: capS && edgeAtStart,
                  edgeEnd: capE && edgeAtEnd,
                  chamferCapStart: capS,
                  chamferCapEnd: capE,
                  capChamferStart: bevelStart,
                  capChamferEnd: bevelEnd,
                  smoothPortalStart: !capS,
                  smoothPortalEnd: !capE,
                  depthScale,
                  offAxisBlend,
                  cornerSampler: hitZone.sampleUnbrokenCorners,
                  cornersOverride: hitZone.corners,
                  threeWayCornersOverride: hitZone.threeWayCorners,
                  hingesOverride: hitZone.hinges,
                  periodicSpecials: false,
                  loopId: li,
                  loopInfo,
                  fixedZPortal: baseZp,
                });

                measurePlaneBounds(rawVertCount, rawEdgeCount, hitZone, _minMaxD);
                const minD = _minMaxD[0];
                const maxD = _minMaxD[1];

                if (maxD <= 1e-6) {
                  this._ensurePool(cursor + 1);
                  const unit = this._activateUnit(cursor++);
                  flushRawToUnit(unit, rawVertCount, rawEdgeCount, 0, loopInfo);
                } else if (minD >= -1e-6) {
                  this._ensurePool(cursor + 1);
                  const unit = this._activateUnit(cursor++);
                  flushRawToUnit(
                    unit,
                    rawVertCount,
                    rawEdgeCount,
                    hitZone.jz * depthScale,
                    loopInfo,
                  );
                } else {
                  this._ensurePool(cursor + 2);
                  const unitPre = this._activateUnit(cursor++);
                  emitHalfSpaceClippedToUnit(
                    unitPre,
                    rawVertCount,
                    rawEdgeCount,
                    hitZone,
                    false,
                    0,
                    offAxis,
                    loopInfo,
                  );
                  const unitPost = this._activateUnit(cursor++);
                  emitHalfSpaceClippedToUnit(
                    unitPost,
                    rawVertCount,
                    rawEdgeCount,
                    hitZone,
                    true,
                    hitZone.jz * depthScale,
                    offAxis,
                    loopInfo,
                  );
                }
              }
            }
            boxCount = solid
              ? this._writeOpenLoopBoxes(boxCount, loop, li, loopInfo, depthScale)
              : this._writeSegmentedSpanOBBs(
              boxCount,
              loop,
              li,
              loopInfo,
              s0,
              s1,
              depthScale,
              Math.min(0.004, 0.4 * gapS * Math.min(openStart, openEnd)),
            );
          } else {
            const subs = collectPortalSubSpans(loop, s0, s1);
            this._ensurePool(cursor + subs.length);

            for (let si = 0; si < subs.length; si++) {
              const sub = subs[si];
              const subLen = sub.b - sub.a;
              const subSteps = Math.max(
                1,
                Math.round((subLen / Math.max(1e-6, segLen)) * baseSteps),
              );
              const unit = this._activateUnit(cursor++);
              updateSegmentUnit(unit, loop, sub.a, sub.b, {
                stepsOverride: subSteps,
                capStart: sub.portalStart ? offAxis : true,
                capEnd: sub.portalEnd ? offAxis : true,
                edgeStart: sub.portalStart ? offAxis : edgeAtStart,
                edgeEnd: sub.portalEnd ? offAxis : edgeAtEnd,
                chamferCapStart: !sub.portalStart,
                chamferCapEnd: !sub.portalEnd,
                blockA: s0,
                blockB: s1,
                blockCapStart: true,
                blockCapEnd: true,
                capChamferStart: bevelStart,
                capChamferEnd: bevelEnd,
                smoothPortalStart: sub.portalStart && !offAxis && smoothPortals,
                smoothPortalEnd: sub.portalEnd && !offAxis && smoothPortals,
                depthScale,
                offAxisBlend,
                loopId: li,
                loopInfo,
              });
            }
            boxCount = solid
              ? this._writeOpenLoopBoxes(boxCount, loop, li, loopInfo, depthScale)
              : this._writeSegmentedSpanOBBs(
              boxCount,
              loop,
              li,
              loopInfo,
              s0,
              s1,
              depthScale,
              Math.min(0.004, 0.4 * gapS * Math.min(openStart, openEnd)),
            );
          }
        }
      }
    }

    // Washer figures shadow from their exact plates in both modes: per-block boxes are coarse on the curved rims and
    // pop as blocks cross the portals.
    const washer = loops.length > 0 && Boolean(loops[0].washerSlab);
    if (washer && segmented) {
      boxCount = 0;
      for (let li = 0; li < loops.length; li++) {
        boxCount = this._writeWasherSlab(boxCount, loops[li], li, loopInfos[li], 0, depthScale);
      }
    }
    this.shadowUniforms.uShadowBoxCount.value = boxCount;
    this.shadowUniforms.uShadowWasherMode.value = washer ? 1 : 0;
    const curveShadow = !segmented && loops.length > 0 ? loops[0].curveShadow : null;
    if (curveShadow) {
      this.shadowUniforms.uShadowCurveMode.value = curveShadow.mode;
      this.shadowUniforms.uShadowCurveA.value.set(
        curveShadow.r0,
        curveShadow.mode === 1 ? curveShadow.r1 * depthScale : curveShadow.r1,
        curveShadow.halfW,
        curveShadow.halfD * depthScale,
      );
      this.shadowUniforms.uShadowCurveB.value.set(
        curveShadow.leanX,
        curveShadow.leanY,
        curveShadow.cr,
        curveShadow.sr,
      );
      this.shadowUniforms.uShadowCurveC.value.set(
        curveShadow.zAmp * depthScale,
        curveShadow.chamfer,
        0,
        0,
      );
      this.shadowUniforms.uShadowGap.value = Math.max(
        0.14,
        Math.min(curveShadow.halfW, curveShadow.halfD * depthScale) * 1.65,
      );
    } else {
      this.shadowUniforms.uShadowCurveMode.value = 0;
    }
    this.shadowUniforms.uShadowSegmented.value = segmented ? 1 : 0;
    if (boxCount > 0) {
      this.shadowUniforms.uShadowGap.value = Math.max(0.14, (this._thicknessSum / boxCount) * 1.65);
    }
    this.shadowBoxTex.needsUpdate = true;

    if (perspDist > 0) {
      for (let i = 0; i < cursor; i++) {
        const unit = this.pool[i];
        const vCount = unit.vertCount ?? 0;
        const eCount = unit.edgeVertCount ?? 0;
        warpBuffersForPerspective(
          unit.posAttr.array,
          unit.normAttr.array,
          vCount,
          unit.edgeAttr.array,
          eCount,
          perspDist,
          zCompress,
          offAxisBlend,
        );
        markAttrUpdated(unit.posAttr, vCount * 3);
        if (offAxisBlend > 1e-4) {
          markAttrUpdated(unit.normAttr, vCount * 3);
        }
        markAttrUpdated(unit.edgeAttr, eCount * 3);
      }
    }

    for (let i = cursor; i < this.pool.length; i++) {
      this.pool[i].mesh.visible = false;
      this.pool[i].lines.visible = false;
    }
  }
}
