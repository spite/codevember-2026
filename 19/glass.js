// Procedural beach glass geometry & erosion engine.
// Generates watertight, wave-tumbled glass pieces with dual raw/eroded poses,
// local optical thickness, and surface wear for micro-pitting & Beer-Lambert shading.
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  TorusGeometry,
  Vector3,
} from "three";

// Spatial-hash vertex weld so indexed/non-indexed primitives share smooth normals.
function mergeVertices(geometry, tolerance = 1e-4) {
  const pos = geometry.attributes.position.array;
  const srcIndex = geometry.index ? geometry.index.array : null;
  const count = srcIndex ? srcIndex.length : pos.length / 3;
  const invTol = 1 / tolerance;
  const map = new Map();
  const newPos = [];
  const index = [];

  for (let k = 0; k < count; k++) {
    const i = srcIndex ? srcIndex[k] : k;
    const j = i * 3;
    const x = pos[j];
    const y = pos[j + 1];
    const z = pos[j + 2];
    const key = `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(key, idx);
    }
    index.push(idx);
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(newPos, 3));
  out.setIndex(index);
  return out;
}

// Deterministic fast 3D value noise for organic outline & fracture asymmetry.
function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function noise3(x, y, z, seed = 1) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const fz = smoothstep(z - iz);
  const c000 = hash3(ix, iy, iz, seed);
  const c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed);
  const c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed);
  const c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed);
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  return lerp(
    lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
    lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
    fz,
  );
}

function fbm3(x, y, z, seed = 1) {
  return (
    0.55 * (noise3(x, y, z, seed) * 2 - 1) +
    0.3 * (noise3(x * 2.03 + 11.7, y * 2.03 - 4.3, z * 2.03 + 7.1, seed + 17) * 2 - 1) +
    0.15 * (noise3(x * 4.11 - 3.1, y * 4.11 + 8.9, z * 4.11 - 5.4, seed + 53) * 2 - 1)
  );
}

// Recompute smooth vertex normals on an indexed BufferGeometry for a given position array.
function computeNormals(pos, index) {
  const count = pos.length / 3;
  const normals = new Float32Array(pos.length);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i] * 3;
    const i1 = index[i + 1] * 3;
    const i2 = index[i + 2] * 3;
    a.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
    b.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
    c.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    normals[i0] += n.x;
    normals[i0 + 1] += n.y;
    normals[i0 + 2] += n.z;
    normals[i1] += n.x;
    normals[i1 + 1] += n.y;
    normals[i1 + 2] += n.z;
    normals[i2] += n.x;
    normals[i2 + 1] += n.y;
    normals[i2 + 2] += n.z;
  }
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    const len = Math.hypot(normals[j], normals[j + 1], normals[j + 2]) || 1;
    normals[j] /= len;
    normals[j + 1] /= len;
    normals[j + 2] /= len;
  }
  return normals;
}

// Taubin smoothing (shrink-free Laplacian): wave-wears creases and steps the mesh can't resolve.
// Each vertex's neighbours, as offsets into one flat list (the same for every piece built from one base mesh).
function buildAdjacency(index, count) {
  const degree = new Uint32Array(count + 1);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) degree[index[i + k] + 1] += 2;
  }
  for (let i = 0; i < count; i++) degree[i + 1] += degree[i];
  const offset = degree.slice();
  const nbr = new Uint32Array(degree[count]);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = index[i + k];
      nbr[offset[v]++] = index[i + ((k + 1) % 3)];
      nbr[offset[v]++] = index[i + ((k + 2) % 3)];
    }
  }
  return { degree, nbr };
}

function smoothPositions(pos, { degree, nbr }, iterations, lambda = 0.55, mu = -0.58) {
  const count = pos.length / 3;
  const tmp = new Float32Array(pos.length);
  const pass = (factor) => {
    for (let v = 0; v < count; v++) {
      const a = degree[v];
      const b = degree[v + 1];
      let x = 0, y = 0, z = 0;
      for (let k = a; k < b; k++) {
        const j = nbr[k] * 3;
        x += pos[j];
        y += pos[j + 1];
        z += pos[j + 2];
      }
      const inv = 1 / Math.max(1, b - a);
      const j = v * 3;
      tmp[j] = pos[j] + factor * (x * inv - pos[j]);
      tmp[j + 1] = pos[j + 1] + factor * (y * inv - pos[j + 1]);
      tmp[j + 2] = pos[j + 2] + factor * (z * inv - pos[j + 2]);
    }
    pos.set(tmp);
  };
  for (let i = 0; i < iterations; i++) {
    pass(lambda);
    pass(mu);
  }
}

// Center both raw and eroded positions around their bounding box center for clean 3D tumbling.
function centerGeometry(rawPos, erodedPos) {
  let minRx = Infinity, minRy = Infinity, minRz = Infinity;
  let maxRx = -Infinity, maxRy = -Infinity, maxRz = -Infinity;
  let minEx = Infinity, minEy = Infinity, minEz = Infinity;
  let maxEx = -Infinity, maxEy = -Infinity, maxEz = -Infinity;
  for (let i = 0; i < rawPos.length; i += 3) {
    const rx = rawPos[i], ry = rawPos[i + 1], rz = rawPos[i + 2];
    const ex = erodedPos[i], ey = erodedPos[i + 1], ez = erodedPos[i + 2];
    if (rx < minRx) minRx = rx; if (rx > maxRx) maxRx = rx;
    if (ry < minRy) minRy = ry; if (ry > maxRy) maxRy = ry;
    if (rz < minRz) minRz = rz; if (rz > maxRz) maxRz = rz;
    if (ex < minEx) minEx = ex; if (ex > maxEx) maxEx = ex;
    if (ey < minEy) minEy = ey; if (ey > maxEy) maxEy = ey;
    if (ez < minEz) minEz = ez; if (ez > maxEz) maxEz = ez;
  }
  const crx = 0.5 * (minRx + maxRx), cry = 0.5 * (minRy + maxRy), crz = 0.5 * (minRz + maxRz);
  const cex = 0.5 * (minEx + maxEx), cey = 0.5 * (minEy + maxEy), cez = 0.5 * (minEz + maxEz);
  for (let i = 0; i < rawPos.length; i += 3) {
    rawPos[i] -= crx; rawPos[i + 1] -= cry; rawPos[i + 2] -= crz;
    erodedPos[i] -= cex; erodedPos[i + 1] -= cey; erodedPos[i + 2] -= cez;
  }
  return { raw: [-crx, -cry, -crz], eroded: [-cex, -cey, -cez] };
}

const baseSpheres = new Map();

// The unit sphere every non-ring piece starts from, built once per detail; each piece gets its own index copy.
function makeBaseSphere(detail) {
  let base = baseSpheres.get(detail);
  if (!base) {
    // IcosahedronGeometry is non-indexed; merge vertices so we get smooth shared normals.
    const raw = new IcosahedronGeometry(1, detail);
    base = mergeVertices(raw, 1e-4);
    raw.dispose();
    base.userData.adjacency = buildAdjacency(base.index.array, base.attributes.position.count);
    baseSpheres.set(detail, base);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", base.attributes.position);
  geo.setIndex(new BufferAttribute(base.index.array.slice(), 1));
  geo.userData.adjacency = base.userData.adjacency;
  return geo;
}

function makeBaseTorus(radial = 48, tubular = 72, tube = 0.36) {
  const raw = new TorusGeometry(1, tube, radial, tubular);
  const indexed = mergeVertices(raw, 1e-4);
  raw.dispose();
  return indexed;
}

// Organic 2D outline radius in XZ as a function of angle + shape seed.
function organicOutline(angle, rng, lobes = 3) {
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const p3 = rng() * Math.PI * 2;
  const a1 = 0.08 + rng() * 0.14;
  const a2 = 0.04 + rng() * 0.09;
  const a3 = 0.02 + rng() * 0.05;
  return (
    1 +
    a1 * Math.cos(2 * angle + p1) +
    a2 * Math.sin(lobes * angle + p2) +
    a3 * Math.cos((lobes + 2) * angle + p3)
  );
}

// Angular polygonal outline for freshly broken shards.
function fracturedOutline(angle, rng, sides = 5) {
  const step = (Math.PI * 2) / sides;
  const phase = rng() * Math.PI * 2;
  const a = ((angle + phase) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const sector = Math.floor(a / step);
  const local = (a - sector * step) / step - 0.5;
  const chord = 1 / Math.cos(local * step * 0.88);
  const jitter = 0.88 + 0.24 * hash3(sector, sides, 7, Math.floor(rng() * 1000));
  return clamp(chord * jitter, 0.72, 1.38);
}

// Builds the base spheres ahead of time (on load), so the first piece of a kind never pays for it mid-animation.
export function prewarmBaseSpheres(details) {
  for (const d of details) makeBaseSphere(d);
}

export const PIECE_TYPES = ["pebble", "shard", "bottle", "bowl", "fluted", "marble", "stopper", "ring", "torus", "rod"];

/**
 * Build a single beach glass piece geometry.
 * Attributes:
 * - position / normal: fully wave-eroded state (erosion = 1)
 * - aRawPos / aRawNormal: freshly fractured / sharp state (erosion = 0)
 * - aThickness: local optical thickness (0.08 .. 1.4)
 * - aWear: surface exposure / abrasion (0 .. 1)
 * - aPieceType: 0 = standard glass, 1 = swirled marble
 */
// Matches the pole-free 3D Cartesian swirl in render.js so surface differential erosion aligns with internal ribbons.
function evalSwirlBands(x, y, z, swirlSeed) {
  const angS = swirlSeed * 1.37;
  const cs = Math.cos(angS);
  const sn = Math.sin(angS);
  const qx = x * cs - z * sn;
  const qy = y;
  const qz = x * sn + z * cs;
  const tw = qx * 3.4 + Math.sin(qy * 4.2 + qz * 3.6) * 0.65;
  const ct = Math.cos(tw);
  const st = Math.sin(tw);
  const wy = qy * ct - qz * st;
  const wz = qy * st + qz * ct;
  const sheet1 = Math.sin(wy * 6.5 + Math.sin(wz * 4.0 + qx * 2.5) * 1.1);
  const sheet2 = Math.cos(wz * 5.5 + Math.sin(qx * 4.5 - wy * 3.0) * 1.1);
  const ribW = Math.exp(-Math.pow(sheet1 * 2.8, 2));
  const ribD = Math.exp(-Math.pow(sheet2 * 3.0, 2));
  return { ribW, ribD };
}

export function createGlassPiece(options) {
  const steps = createGlassPieceSteps(options);
  let step;
  while (!(step = steps.next()).done);
  return step.value;
}

// The same, in steps of a few ms (it yields through the vertex loop and between stages) and returning the geometry.
export function* createGlassPieceSteps({ type = "pebble", radius = 0.5, seed = 1, swirlSeed = 1, detail = 4 } = {}) {
  let s = (seed | 0) ^ 0x9e3779b9;
  const rng = () => {
    s = Math.imul(s ^ (s >>> 15), 0x85ebca6b);
    s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
    return ((s ^ (s >>> 16)) >>> 0) / 4294967295;
  };

  const isRing = type === "ring" || type === "torus";
  const torusTube = type === "torus" ? 0.36 + rng() * 0.08 : 0.3;
  const geo = isRing ? makeBaseTorus(56, 110, torusTube) : makeBaseSphere(detail);
  const ringW = 0.14 + rng() * 0.06;
  const ringH = 0.26 + rng() * 0.1;
  const basePos = geo.attributes.position.array;
  const vCount = basePos.length / 3;

  const erodedPos = new Float32Array(basePos.length);
  const rawPos = new Float32Array(basePos.length);
  const thickness = new Float32Array(vCount);
  const wear = new Float32Array(vCount);
  const pieceType = new Float32Array(vCount);
  const reliefE = new Float32Array(vCount);
  const reliefR = new Float32Array(vCount);

  const aspect = 0.78 + rng() * 0.44;
  const flatRatio =
    type === "marble" ? 0.96 :
    type === "stopper" ? 0.58 :
    type === "rod" ? 0.42 :
    0.34 + rng() * 0.22;

  const noiseSeed = Math.floor(rng() * 10000);
  const lobes = 3 + Math.floor(rng() * 2);
  const fractureSides = 4 + Math.floor(rng() * 3);
  const fluteCount = 7 + Math.floor(rng() * 9);
  const fluteStyle = Math.floor(rng() * 4); // 0: bottle base, 1: paneled wall, 2: worn hobnails, 3: jar lip
  const bottleCurvature = (0.25 + rng() * 0.35) * (rng() < 0.5 ? 1 : -1);
  const outlineSeed = rng() * 100;
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const hasSwirl = type === "marble" || (type === "rod" && rng() < 0.7) || (rng() < 0.25);
  const rodEnds = [0.62 + rng() * 0.2, 0.62 + rng() * 0.2];
  const rodSlant = (rng() - 0.5) * 0.5;
  const rodTaper = (rng() - 0.5) * 0.24;
  const rodBend = (rng() - 0.5) * 0.3;

  // Conchoidal fracture chip centers (scooped crescent scars worn smooth by waves)
  const chipA = rng() * Math.PI * 2;
  const chip1 = new Vector3(Math.cos(chipA) * 0.65, 0.35, Math.sin(chipA) * 0.65).normalize();
  const chip2 = new Vector3(Math.cos(chipA + 2.4) * 0.72, -0.25, Math.sin(chipA + 2.4) * 0.72).normalize();
  const hasChip = type === "shard" || type === "pebble" || type === "fluted";
  const bumps = Array.from({ length: 4 + Math.floor(rng() * 3) }, () => {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 0.62;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });

  // Curved vessel parameters for broken bottle & bowl shards
  const vesselR = radius * (1.05 + rng() * 0.55);
  const arcSpan = 0.65 + rng() * 0.5; // ~75° to 130° total arc
  const wallHalf = radius * (0.16 + rng() * 0.07);
  const hasShoulder = rng() < 0.55;
  const hasRim = rng() < 0.6;

  // Pre-roll outline function params so every vertex gets consistent angle shaping.
  const evalOrganic = (ang) =>
    1 +
    0.12 * Math.cos(2 * ang + p1) +
    0.07 * Math.sin(lobes * ang + p2) +
    0.04 * Math.cos((lobes + 2) * ang + outlineSeed);

  // Broken outline: an irregular polygon whose corners have their own radius, joined by straight sides, so the
  // outline (and the shape built on it) has corners but no steps.
  const fractureStep = (Math.PI * 2) / fractureSides;
  const corner = (k) =>
    Math.min(1.32, (0.88 + 0.22 * hash3(k % fractureSides, fractureSides, 3, noiseSeed)) / Math.cos(fractureStep * 0.425));
  const evalFracture = (ang) => {
    const a = ((ang + p1) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const k = Math.floor(a / fractureStep);
    const t0 = k * fractureStep;
    const t1 = t0 + fractureStep;
    const r0 = corner(k);
    const r1 = corner(k + 1);
    // Where the ray at angle a meets the side between corners k and k + 1
    const x0 = r0 * Math.cos(t0), y0 = r0 * Math.sin(t0);
    const ex = r1 * Math.cos(t1) - x0, ey = r1 * Math.sin(t1) - y0;
    const dx = Math.cos(a), dy = Math.sin(a);
    return (x0 * ey - y0 * ex) / (dx * ey - dy * ex);
  };

  for (let i = 0; i < vCount; i++) {
    const j = i * 3;
    const bx = basePos[j];
    const by = basePos[j + 1];
    const bz = basePos[j + 2];

    let ex = bx;
    let ey = by;
    let ez = bz;
    let rx = bx;
    let ry = by;
    let rz = bz;
    let thick = 0.6;
    let w = 0.5;
    let pType = 0;

    if (type === "marble") {
      const n = fbm3(bx * 1.4, by * 1.4, bz * 1.4, noiseSeed);
      const rEroded = radius * (0.98 + 0.025 * n);
      const rRaw = radius * (0.97 + 0.045 * n);
      ex = bx * rEroded;
      ey = by * rEroded * 0.96;
      ez = bz * rEroded;
      rx = bx * rRaw;
      ry = by * rRaw;
      rz = bz * rRaw;
      // Differential erosion: swirl veins erode faster (recessed channels) or slower (raised bands)
      const { ribW, ribD } = evalSwirlBands(ex, ey, ez, swirlSeed);
      const diffSign = swirlSeed % 2 === 0 ? 1 : -1;
      reliefE[i] = diffSign * (ribW * 0.055 + ribD * 0.035) * radius;
      thick = radius * 1.85;
      w = clamp(0.45 + 0.35 * Math.abs(n) + (diffSign > 0 ? ribW * 0.25 : -ribW * 0.15), 0.1, 1.0);
      pType = 1.0;
    } else if (type === "torus") {
      // Round-section glass torus. Torus lies in XY by default; rotate into XZ so it rests flat on y = 0.
      const tx = bx;
      const ty = bz;
      const tz = by;
      const ang = Math.atan2(tz, tx);
      const rMajor = Math.hypot(tx, tz);
      const n = fbm3(tx * 1.8, ty * 1.8, tz * 1.8, noiseSeed);
      const thread = Math.sin(ang * 3 + ty * 9.0) * 0.045;
      const scale = radius * 0.72 * (1 + 0.08 * Math.sin(2 * ang + p1) + 0.04 * n);
      ex = tx * scale;
      ey = ty * scale * 0.82;
      ez = tz * scale;
      const rawScale = radius * 0.76 * (1 + 0.1 * Math.cos(3 * ang + p2));
      reliefE[i] = thread * 0.5 * radius * 0.72;
      reliefR[i] = thread * 1.2 * radius * 0.76;
      rx = tx * rawScale;
      ry = Math.sign(ty) * Math.pow(Math.abs(ty), 0.72) * rawScale * 0.92;
      rz = tz * rawScale;
      thick = radius * 0.52;
      w = clamp(0.35 + 0.65 * clamp((rMajor - 0.85) * 1.6 + Math.abs(ty) * 1.2, 0, 1), 0, 1);
    } else if (type === "ring") {
      // Bottle-neck lip: a collar of rounded-rectangle section, taller than wide, around a wide hole.
      // Torus lies in XY by default; rotate into XZ so it rests flat on y = 0.
      const tx = bx;
      const ty = bz;
      const tz = by;
      const ang = Math.atan2(tz, tx);
      const rMajor = Math.hypot(tx, tz) || 1;
      const dx = tx / rMajor;
      const dz = tz / rMajor;
      const phi = Math.atan2(ty, rMajor - 1);
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      const sp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
      const n = fbm3(tx * 1.8, ty * 1.8, tz * 1.8, noiseSeed);
      const S = radius * 0.72;
      const major = 1 + 0.06 * Math.sin(2 * ang + p1) + 0.03 * n;
      // Screw thread ridges on the outer face
      const thread = Math.sin(sn * ringH * 18 + ang + p2) * 0.03 * Math.max(c, 0);

      const uE = sp(c, 0.8) * ringW;
      reliefE[i] = thread * 0.4 * S;
      reliefR[i] = thread * S;
      const vE = sp(sn, 0.8) * ringH * (1 + 0.04 * n);
      ex = dx * (major + uE) * S;
      ey = vE * S;
      ez = dz * (major + uE) * S;

      const uR = sp(c, 0.4) * ringW * 1.06;
      const vR = sp(sn, 0.4) * ringH * 1.04;
      rx = dx * (major + uR) * S;
      ry = vR * S;
      rz = dz * (major + uR) * S;

      thick = 2 * ringW * S;
      w = clamp(0.3 + 1.2 * Math.abs(c * sn), 0, 1);
    } else if (type === "stopper") {
      // Lathed bottle stopper resting on its side (axis along X), with faceted finial & collar ring.
      const u = bx;
      const rCyl = Math.hypot(by, bz);
      const ang = Math.atan2(bz, by);
      const finialFacet = u < -0.15 ? Math.cos(ang * 8) * 0.05 * smoothstep(clamp((-u - 0.15) / 0.5, 0, 1)) : 0;
      const collar = Math.exp(-Math.pow((u - 0.02) / 0.12, 2)) * 0.08;
      // Bulb, neck and shaft blended into each other, so the profile has shoulders but no steps
      const profile = (bulb, neck, shaft, soft) =>
        lerp(lerp(bulb, neck, smoothstep(clamp((u + 0.2) / soft, 0, 1))), shaft, smoothstep(clamp((u - 0.15) / soft, 0, 1)));
      const profEroded = profile(
        0.92 * Math.sqrt(Math.max(0.0, 1 - Math.pow((u + 0.48) / 0.52, 2))),
        lerp(0.56, 0.32, smoothstep(clamp((u + 0.1) / 0.35, 0, 1))),
        0.34 * Math.sqrt(Math.max(0.0, 1 - Math.pow((u - 0.25) / 0.75, 2))),
        0.16,
      );
      const profRaw = profile(
        0.98 * Math.pow(Math.max(0.0, 1 - Math.pow((u + 0.48) / 0.52, 4)), 0.25),
        lerp(0.52, 0.28, clamp((u + 0.12) / 0.34, 0, 1)),
        0.36 * Math.sqrt(Math.max(0.0, 1 - Math.pow((u - 0.22) / 0.78, 2))),
        0.14,
      );

      const warp = 1 + 0.03 * fbm3(bx * 2, by * 2, bz * 2, noiseSeed);
      const rScale = radius * 1.1;
      reliefE[i] = (finialFacet * 0.5 + collar * 0.5) * rScale * 0.78;
      reliefR[i] = (finialFacet * 1.3 + collar * 1.2) * rScale * 0.82;

      ex = u * rScale * 1.15;
      ey = (rCyl > 1e-4 ? by / rCyl : 0) * profEroded * rScale * 0.78 * warp;
      ez = (rCyl > 1e-4 ? bz / rCyl : 0) * profEroded * rScale * 0.78 * warp;

      rx = u * rScale * 1.22;
      ry = (rCyl > 1e-4 ? by / rCyl : 0) * profRaw * rScale * 0.82;
      rz = (rCyl > 1e-4 ? bz / rCyl : 0) * profRaw * rScale * 0.82;

      thick = clamp(profEroded * radius * 1.6, 0.18 * radius, 1.3 * radius);
      w = u < 0.25 && u > -0.15 ? 0.22 : 0.75; // neck groove is protected from sand abrasion
    } else if (type === "rod") {
      // Fragment of a twisted glass cane (latticino) along X: slightly bent and tapered, ends worn round unevenly, a
      // faint twist on the surface and white spiral threads inside (drawn by the shader).
      const u = bx;
      const rCyl = Math.hypot(by, bz);
      const ang = Math.atan2(bz, by);
      const twist = ang + u * 3.0;
      const ribFade = smoothstep(clamp((0.85 - Math.abs(u)) / 0.3, 0, 1));
      const rib = Math.cos(twist * 2) * ribFade;
      // Each end is worn back by its own amount
      const endStart = u > 0 ? rodEnds[0] : rodEnds[1];
      const endT = clamp((Math.abs(u) - endStart) / (1 - endStart), 0, 1);
      const capE = Math.sqrt(Math.max(0.0, 1 - endT * endT));
      // Raw: a slanted break near each end
      const endTR = clamp((Math.abs(u) + rodSlant * by - 0.84) / 0.16, 0, 1);
      const capR = Math.sqrt(Math.max(0.0, 1 - endTR * endTR * 0.92));
      const taper = 1 + rodTaper * u;
      const rBase = radius * 0.34;
      const ny = rCyl > 1e-4 ? by / rCyl : 0;
      const nz = rCyl > 1e-4 ? bz / rCyl : 0;
      const bend = rodBend * (u * u - 0.33) * radius;
      ex = u * radius * 1.32;
      ey = ny * rBase * capE * taper + bend;
      ez = nz * rBase * capE * taper;
      rx = u * radius * 1.42;
      ry = ny * rBase * capR * taper + bend;
      rz = nz * rBase * capR * taper;
      reliefE[i] = rBase * capE * 0.025 * rib;
      reliefR[i] = rBase * capR * 0.07 * rib;
      thick = radius * 0.62 * Math.max(capE, 0.25);
      w = clamp(0.4 + 0.5 * Math.abs(u) + 0.2 * rib, 0, 1);
      pType = 2.0;
    } else if (type === "bottle") {
      // Curved broken bottle wall / shoulder shard (cylindrical arc wrapping 75°-130°).
      const rXZ = Math.hypot(bx, bz);
      const ang = Math.atan2(bz, bx);
      const org = evalOrganic(ang);
      const frac = evalFracture(ang);
      const n = fbm3(bx * 1.5, by * 1.5, bz * 1.5, noiseSeed);

      const uE = bx * org * (1 + 0.03 * n);
      const vE = bz * org * aspect * (1 + 0.03 * n);
      const uR = bx * frac * (1 + 0.05 * n);
      const vR = bz * frac * aspect * (1 + 0.05 * n);

      const ySign = by >= 0 ? 1 : -1;
      // Low exponent keeps wall thickness flat out to a chamfered, wave-rounded rim
      const tE = ySign * Math.pow(Math.abs(by), 0.36) * wallHalf;
      const tR = ySign * Math.pow(Math.abs(by), 0.20) * wallHalf;

      // Optional bottle shoulder taper at +v end & embossed horizontal bottle rib
      const shoulderE = hasShoulder ? 1 - 0.28 * smoothstep(clamp((vE - 0.1) / 0.9, 0, 1)) : 1;
      const shoulderR = hasShoulder ? 1 - 0.34 * smoothstep(clamp((vR - 0.1) / 0.9, 0, 1)) : 1;
      const rib = by > 0 ? Math.sin(vE * 12.0 + p1) * wallHalf * 0.18 : 0;

      const thetaE = uE * arcSpan;
      const rE = vesselR * shoulderE + tE;
      reliefE[i] = rib * 0.5;
      reliefR[i] = rib * 1.1;
      ex = rE * Math.sin(thetaE);
      ey = rE * Math.cos(thetaE) - vesselR;
      ez = vE * radius * 0.95;

      const thetaR = uR * arcSpan * 1.05;
      const rR = vesselR * shoulderR + tR;
      rx = rR * Math.sin(thetaR);
      ry = rR * Math.cos(thetaR) - vesselR;
      rz = vR * radius * 1.02;

      const edgeTaper = Math.sqrt(Math.max(0.15, 1 - rXZ * rXZ * 0.78));
      thick = clamp(wallHalf * 2.1 * edgeTaper, 0.08 * radius, 0.55 * radius);
      w = clamp(0.32 + 0.64 * Math.pow(rXZ, 1.4), 0.12, 1.0);
      pType = hasSwirl ? 1.0 : 0.0;
    } else if (type === "bowl") {
      // Doubly-curved broken bowl / vessel rim shard (spherical dish patch + optional rolled lip).
      const rXZ = Math.hypot(bx, bz);
      const ang = Math.atan2(bz, bx);
      const org = evalOrganic(ang);
      const frac = evalFracture(ang);
      const n = fbm3(bx * 1.5, by * 1.5, bz * 1.5, noiseSeed);

      const pxE = bx * org * (1 + 0.03 * n) * radius * aspect;
      const pzE = bz * org * (1 + 0.03 * n) * radius / aspect;
      const pxR = bx * frac * (1 + 0.05 * n) * radius * aspect * 1.05;
      const pzR = bz * frac * (1 + 0.05 * n) * radius / aspect * 1.05;

      const ySign = by >= 0 ? 1 : -1;
      const rimBulge = hasRim ? smoothstep(clamp((bz - 0.35) / 0.55, 0, 1)) * 0.55 : 0;
      const tE = ySign * Math.pow(Math.abs(by), 0.36) * wallHalf * (1 + rimBulge * 0.6);
      const tR = ySign * Math.pow(Math.abs(by), 0.20) * wallHalf * (1 + rimBulge);

      const bowlR = vesselR * 1.25;
      const dishE = (pxE * pxE + pzE * pzE) / (2 * bowlR);
      const dishR = (pxR * pxR + pzR * pzR) / (2 * bowlR * 0.92);

      ex = pxE;
      ey = dishE + tE;
      ez = pzE;

      rx = pxR;
      ry = dishR + tR;
      rz = pzR;

      const edgeTaper = Math.sqrt(Math.max(0.15, 1 - rXZ * rXZ * 0.78));
      thick = clamp(wallHalf * 2.1 * edgeTaper * (1 + rimBulge * 0.4), 0.08 * radius, 0.58 * radius);
      w = clamp(0.30 + 0.65 * Math.pow(rXZ, 1.4), 0.10, 1.0);
      pType = hasSwirl ? 1.0 : 0.0;
    } else {
      // pebble, shard, fluted: flattened organic bodies with intricate smoothed-out vessel & fracture relief.
      const rXZ = Math.hypot(bx, bz);
      const ang = Math.atan2(bz, bx);
      const org = evalOrganic(ang);
      const frac = evalFracture(ang);

      const n = fbm3(bx * 1.6, by * 1.6, bz * 1.6, noiseSeed);
      const sx = radius * aspect;
      const sz = radius / aspect;

      // Eroded silhouette & pillowy cross-section
      const outE = org * (1 + 0.025 * n);
      ex = bx * sx * outE;
      ez = bz * sz * outE;

      // Raw silhouette: angular fracture for shards, slightly sharper for pebbles/fluted
      const outR = type === "shard" ? frac * (1 + 0.05 * n) : lerp(org, frac, 0.55) * (1 + 0.04 * n);
      rx = bx * sx * outR;
      rz = bz * sz * outR;

      // Height profile: shards keep a flatter chamfered rim; pebbles are more pillowy.
      const hBase = radius * flatRatio;
      const ySign = by >= 0 ? 1 : -1;
      const yAbs = Math.abs(by);
      const yEroded = ySign * Math.pow(yAbs, type === "shard" ? 0.44 : 0.72) * hBase * (1 + 0.03 * n);
      const yRaw = ySign * Math.pow(yAbs, type === "shard" ? 0.24 : 0.42) * hBase * (type === "shard" ? 0.95 : 1.02);

      ey = yEroded;
      ry = yRaw;

      // Bottle curvature & embossed bottle ribs / mold seam for shards
      let relief = 0;
      if (type === "shard") {
        const curve = bottleCurvature * (ex * ex) / Math.max(radius, 0.1);
        ey += curve * 0.45;
        ry += curve * 0.85;
        // Faint embossed bottle ribs and a soft mould seam on the outer face
        const face = smoothstep(clamp((by - 0.15) / 0.45, 0, 1));
        const ribs = Math.sin(bz * 7.0 + p1) * 0.03 * radius;
        const seam = Math.exp(-Math.pow((bx - 0.1) / 0.16, 2)) * 0.035 * radius;
        relief += (ribs + seam) * face;
      }

      // Pressed and moulded glass, worn down: broad features only, kept off the rim walls
      if (type === "fluted") {
        const face = smoothstep(clamp((by - 0.1) / 0.5, 0, 1));
        if (fluteStyle === 0) {
          // Bottle base: concave punt inside a rounded heel ring
          const punt = -Math.exp(-Math.pow(rXZ / 0.42, 2)) * 0.13;
          const heel = Math.exp(-Math.pow((rXZ - 0.68) / 0.14, 2)) * 0.05;
          relief += (punt + heel) * radius * face;
        } else if (fluteStyle === 1) {
          // Paneled bottle wall: a few broad, soft flutes
          const k = 3 + (fluteCount % 3);
          relief += Math.cos(bx * k * Math.PI * 0.5 + p1) * 0.045 * radius * face;
        } else if (fluteStyle === 2) {
          // Hobnails worn into low domes
          let h = 0;
          for (const [cx, cz] of bumps) h += Math.exp(-((bx - cx) ** 2 + (bz - cz) ** 2) / 0.035);
          relief += Math.min(h, 1.2) * 0.075 * radius * face;
        } else {
          // Jar lip: a rounded bead along one edge
          const along = bx * Math.cos(p2) + bz * Math.sin(p2);
          relief += Math.exp(-Math.pow((along - 0.62) / 0.16, 2)) * 0.08 * radius * smoothstep(clamp((by + 0.4) / 0.6, 0, 1));
        }
      }

      // Conchoidal fracture chips (crescent hollows with faint ripple rings, worn smooth)
      if (hasChip) {
        const d1 = Math.hypot(bx - chip1.x, by - chip1.y, bz - chip1.z);
        const scoop1 = Math.exp(-Math.pow(d1 / 0.42, 2)) * (0.14 + 0.02 * Math.cos(d1 * 16.0));
        const d2 = Math.hypot(bx - chip2.x, by - chip2.y, bz - chip2.z);
        const scoop2 = Math.exp(-Math.pow(d2 / 0.36, 2)) * (0.11 + 0.016 * Math.cos(d2 * 14.0));
        const chipDepth = (scoop1 + (type === "pebble" ? 0.55 : 0.9) * scoop2) * radius;
        relief -= chipDepth;
      }

      reliefE[i] = relief * 0.58;
      reliefR[i] = relief * 1.25;

      // Local optical thickness: thicker in center, thinner at rim & inside flutes/chips.
      const radialNorm = clamp(rXZ, 0, 1);
      const edgeTaper = Math.sqrt(Math.max(0.04, 1 - radialNorm * radialNorm * 0.88));
      thick = clamp(hBase * 2.0 * edgeTaper + relief * 0.6, 0.08 * radius, 1.45 * radius);

      // Wear: rim & raised ridges are most exposed to sand abrasion; valleys & chips are more protected.
      w = clamp(0.28 + 0.65 * Math.pow(radialNorm, 1.5) + (relief > 0 ? 0.22 : relief < 0 ? -0.22 : 0), 0.08, 1.0);
      pType = hasSwirl ? 1.0 : 0.0;
    }

    erodedPos[j] = ex;
    erodedPos[j + 1] = ey;
    erodedPos[j + 2] = ez;

    rawPos[j] = rx;
    rawPos[j + 1] = ry;
    rawPos[j + 2] = rz;

    thickness[i] = thick;
    wear[i] = w;
    pieceType[i] = pType;
    if (i % 1500 === 1499) yield;
  }

  const index = geo.index.array;
  // The rings' y/z swap mirrors the torus; flip the winding back so its faces point outward.
  if (isRing) {
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
  }
  // The poses without their pattern, so the pattern can erode at its own rate.
  const erodedBase = erodedPos.slice();
  const rawBase = rawPos.slice();
  // Relief goes along the base surface normal, so it never shears the steep rim walls.
  for (const [pos, relief] of [[erodedPos, reliefE], [rawPos, reliefR]]) {
    const n = computeNormals(pos, index);
    for (let i = 0; i < vCount; i++) {
      const j = i * 3;
      pos[j] += n[j] * relief[i];
      pos[j + 1] += n[j + 1] * relief[i];
      pos[j + 2] += n[j + 2] * relief[i];
    }
  }
  const adjacency = geo.userData.adjacency ?? buildAdjacency(index, vCount);
  const smoothing = { fluted: 7, shard: 5, pebble: 4, bowl: 3, bottle: 3, stopper: 2, rod: 2, ring: 2, marble: 1 };
  smoothPositions(erodedPos, adjacency, smoothing[type] ?? 3);
  smoothPositions(erodedBase, adjacency, smoothing[type] ?? 3);

  yield;
  const centers = centerGeometry(rawPos, erodedPos);
  for (const [base, c] of [[erodedBase, centers.eroded], [rawBase, centers.raw]]) {
    for (let i = 0; i < base.length; i += 3) {
      base[i] += c[0];
      base[i + 1] += c[1];
      base[i + 2] += c[2];
    }
  }

  yield;
  const erodedNormals = computeNormals(erodedPos, index);
  const rawNormals = computeNormals(rawPos, index);
  const erodedBaseNormals = computeNormals(erodedBase, index);
  const rawBaseNormals = computeNormals(rawBase, index);
  const patternE = erodedPos.map((v, i) => v - erodedBase[i]);
  const patternR = rawPos.map((v, i) => v - rawBase[i]);

  geo.setAttribute("position", new Float32BufferAttribute(erodedPos, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(erodedNormals, 3));
  geo.setAttribute("aRawPos", new Float32BufferAttribute(rawPos, 3));
  geo.setAttribute("aRawNormal", new Float32BufferAttribute(rawNormals, 3));
  geo.setAttribute("aThickness", new Float32BufferAttribute(thickness, 1));
  geo.setAttribute("aWear", new Float32BufferAttribute(wear, 1));
  geo.setAttribute("aPieceType", new Float32BufferAttribute(pieceType, 1));
  // Pattern offsets from the pattern-free poses, and those poses' normals
  geo.setAttribute("aPatternE", new Float32BufferAttribute(patternE, 3));
  geo.setAttribute("aPatternR", new Float32BufferAttribute(patternR, 3));
  geo.setAttribute("aBaseNormalE", new Float32BufferAttribute(erodedBaseNormals, 3));
  geo.setAttribute("aBaseNormalR", new Float32BufferAttribute(rawBaseNormals, 3));

  // An ideal torus fitted to the piece, for the shader to trace its inside (eroded and raw poses).
  if (isRing) {
    const torus = type === "torus";
    const Re = radius * 0.72;
    const Rr = torus ? radius * 0.76 : Re;
    geo.userData.torus = {
      eroded: { center: centers.eroded, R: Re, a: (torus ? torusTube : ringW) * Re, b: (torus ? torusTube * 0.82 : ringH) * Re, square: torus ? 2 : 2.5 },
      raw: { center: centers.raw, R: Rr, a: (torus ? torusTube : ringW * 1.06) * Rr, b: (torus ? torusTube * 0.92 : ringH * 1.04) * Rr, square: torus ? 2.6 : 5 },
      wobble: torus ? 0.08 : 0.06,
      phase: p1,
      wobbleTube: torus ? 1 : 0,
      thread: torus ? 0.0225 : 0,
    };
  }

  // Radius of the cane, for the shader's spiral threads
  if (type === "rod") geo.userData.rodRadius = radius * 0.34;

  // Bounding sphere for raycasting & frustum culling
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  return geo;
}
