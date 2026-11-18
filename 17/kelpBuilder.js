// The forest's geometry and physics layout, built in forest.worker.js (it also loads on the main thread, for the reef).
// Three kinds of kelp, each on a holdfast on the rock: giant kelp (Macrocystis: thin stipes up to the surface and along
// it, blades hanging from small gas bladders all the way up, sporophylls at the base), bull kelp (Nereocystis: a whip of a
// stipe up to one small float, two bunches of long ribbons streaming from it) and palm kelp (Pterygophora: a short woody
// stipe with two rows of narrow blades). The reef is broken rock strewn with boulders.
import * as THREE from "../third_party/three.core.js";

// Nodes per stipe in the physics, and the attributes every forest vertex carries.
export const SEGS_PER_COL = 14;
export const ATTRIBUTES = { position: 3, normal: 3, uv: 2, aColumnSeed: 3, aBladeParam: 4, aAttachPos: 3, aBladeId: 1 };
// Per stipe: its rest nodes, then sway, stiffness, buoyancy, the float's lift, kind, age and blade flexibility.
export const COLUMN_STRIDE = SEGS_PER_COL * 3 + 7;
// Per blade: stipe, height on it, attachment, rest direction, length, half width, hinge range, hinge stiffness and whether
// it's simulated (far blades only ride their stipe and ripple in the shader).
export const BLADE_STRIDE = 13;
export const KINDS = { giant: 0, bull: 1, palm: 2 };
export const SURFACE = 17.8;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
// The current a plant hangs in when it isn't given one.
const STREAM = new THREE.Vector3(0.98, 0, 0.2).normalize();
// Where the opening view sees the sun through the surface (x, z): canopies stay clear of it.
const SUN_SPOT = [3.9, -5.5];
// Each kind's blade hinge, packed with every blade: how far a blade swings from its rest pose (radians), how stiffly it
// springs back, and how much that stiffness varies blade to blade (0.6: 0.7-1.3 times), so neighbours don't swing in
// lockstep. kelpPhysics.js applies the same values from its own table.
const HINGES = {
  giant: { maxAngle: 1.6, hinge: 2.5, spread: 0.6 },
  bull: { maxAngle: 2.2, hinge: 0.3, spread: 0.6 },
  palm: { maxAngle: 1.0, hinge: 2.5, spread: 0.6 },
};
const hingeOf = (kind, r, simulate = true) => ({ maxAngle: HINGES[kind].maxAngle, hinge: HINGES[kind].hinge * (1 + HINGES[kind].spread * (r - 0.5)), simulate });

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function crinkleFbm(x, y) {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    v += amp * valNoise(x * freq, y * freq);
    freq *= 2.05;
    amp *= 0.5;
  }
  return v;
}

// Rounded boulders on a jittered grid of cells, each cut by sloping facets, as heights above the ground. A cell holds one
// with the chance given at its centre.
function boulders(x, z, cell, chance, rMin, rMax, tall, cut, salt) {
  const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
  let top = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cz = iz + j;
      const h1 = hash2(cx + salt * 7, cz + 11), h2 = hash2(cx - 13, cz + salt * 3), h3 = hash2(cx + 29, cz - salt);
      const bx = (cx + 0.2 + 0.6 * h1) * cell, bz = (cz + 0.2 + 0.6 * h2) * cell;
      const r = rMin + (rMax - rMin) * h3 * h3;
      const dx = x - bx, dz = z - bz;
      if (dx * dx + dz * dz > r * r * 1.7 || hash2(cx * 3 + salt, cz * 5 - salt) > chance(bx, bz)) continue;
      // An elliptic footprint, turned.
      const a = h1 * 6.2832, ca = Math.cos(a), sa = Math.sin(a);
      const e = 0.75 + 0.5 * h2;
      const u = (dx * ca + dz * sa) / (r * e), v = (dz * ca - dx * sa) / (r / e);
      const s2 = u * u + v * v;
      if (s2 >= 1) continue;
      const H = r * tall * (0.75 + 0.5 * h3);
      let h = (H * (Math.pow(1 - s2, 0.4) - 0.1)) / 0.9;
      // Three facets: planes through the rock, sloping down across it.
      for (let k = 0; k < 3; k++) {
        const fa = a + 2.1 + k * 2.1 + h2 * 1.3;
        const g = cut * (0.5 + hash2(cx + k * 17, cz + salt));
        h = Math.min(h, H * (0.6 + 0.35 * hash2(cz - k * 5, cx + salt)) - (H / r) * g * (dx * Math.cos(fa) + dz * Math.sin(fa)));
      }
      top = Math.max(top, h);
    }
  }
  return top;
}

// How likely a boulder is at (x, z): patches of rock; cobbles gather in clusters between bare stretches.
const rockField = (x, z) => 0.25 + 0.4 * smooth(0.25, 0.6, valNoise(x * 0.09 + 7.3, z * 0.09 - 1.7));
const cobbleField = (x, z) => (0.4 + 0.55 * smooth(0.25, 0.6, valNoise(x * 0.09 + 7.3, z * 0.09 - 1.7))) * (0.35 + 0.65 * smooth(0.2, 0.6, valNoise(x * 0.33 + 1.3, z * 0.33 + 7.1)));

// The reef's height: rolling rock strewn with boulders, and cobbles where the reef's mesh is fine enough to hold them
// (none right under the opening view's camera).
export function floorHeight(x, z) {
  const ground = -6.9 + crinkleFbm(x * 0.14 + 3.1, z * 0.14 - 2.4) * 2.6 + crinkleFbm(x * 0.45, z * 0.45) * 0.65;
  const fine = 1 - smooth(0, 2, Math.hypot(Math.max(0, Math.abs(x) - 11), Math.max(0, z - 10, -12 - z)));
  let rocks = boulders(x, z, 2.4, rockField, 0.45, 1.0, 0.36, 0.75, 3);
  if (fine > 0) rocks = Math.max(rocks, fine * Math.max(boulders(x, z, 0.9, cobbleField, 0.28, 0.5, 0.5, 0.35, 9), boulders(x, z, 0.5, cobbleField, 0.15, 0.27, 0.6, 0.35, 5)));
  // A rough skin on the rock, gentler on the open ground.
  rocks += Math.min(0.02 + 0.25 * Math.max(0, rocks), 0.1) * (valNoise(x * 1.7 + 4.1, z * 1.7 - 8.3) + 0.5 * valNoise(x * 3.4, z * 3.4) - 0.75);
  return ground + rocks * smooth(1.6, 2.8, Math.hypot(x, z - 10.5));
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

class KelpGeometryAccumulator {
  constructor(capacity = 1 << 16) {
    this.vertexCount = 0;
    this.capacity = 0;
    this.arrays = {};
    this.indices = new Uint32Array(Math.ceil(capacity * 4.6));
    this.indexCount = 0;
    this.grow(capacity);
  }

  grow(capacity) {
    for (const [name, size] of Object.entries(ATTRIBUTES)) {
      const next = new Float32Array(capacity * size);
      if (this.arrays[name]) next.set(this.arrays[name]);
      this.arrays[name] = next;
    }
    this.capacity = capacity;
  }

  addVertex(pos, norm, uv, colSeed, bladeParam, attachPos, bladeId = -1) {
    if (this.vertexCount === this.capacity) this.grow(this.capacity * 2);
    const i = this.vertexCount;
    const { position, normal, uv: uvs, aColumnSeed, aBladeParam, aAttachPos, aBladeId } = this.arrays;
    position[i * 3] = pos.x;
    position[i * 3 + 1] = pos.y;
    position[i * 3 + 2] = pos.z;
    normal[i * 3] = norm.x;
    normal[i * 3 + 1] = norm.y;
    normal[i * 3 + 2] = norm.z;
    uvs[i * 2] = uv.x;
    uvs[i * 2 + 1] = uv.y;
    aColumnSeed[i * 3] = colSeed.x;
    aColumnSeed[i * 3 + 1] = colSeed.y;
    aColumnSeed[i * 3 + 2] = colSeed.z;
    aBladeParam[i * 4] = bladeParam.x;
    aBladeParam[i * 4 + 1] = bladeParam.y;
    aBladeParam[i * 4 + 2] = bladeParam.z;
    aBladeParam[i * 4 + 3] = bladeParam.w;
    aAttachPos[i * 3] = attachPos.x;
    aAttachPos[i * 3 + 1] = attachPos.y;
    aAttachPos[i * 3 + 2] = attachPos.z;
    aBladeId[i] = bladeId;
    return this.vertexCount++;
  }

  addTriangle(a, b, c) {
    if (this.indexCount + 3 > this.indices.length) {
      const next = new Uint32Array(this.indices.length * 2);
      next.set(this.indices);
      this.indices = next;
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  // A grid of vertex indices (rows of columns) into quads, wound so the front face is the side the normals point to.
  addGrid(grid) {
    for (let i = 0; i < grid.length - 1; i++) {
      for (let j = 0; j < grid[i].length - 1; j++) {
        const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
        this.addTriangle(a, d, b);
        this.addTriangle(b, d, c);
      }
    }
  }

  // The same for rows of cols vertices added in order from base.
  addGridRows(base, rows, cols) {
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j, b = a + cols;
        this.addTriangle(a, a + 1, b);
        this.addTriangle(b, a + 1, b + 1);
      }
    }
  }

  // Arrays of the exact size: views when the buffers are nearly full, copies otherwise.
  finish() {
    const fit = (a, n) => (n > a.length * 0.8 ? a.subarray(0, n) : a.slice(0, n));
    const attributes = {};
    for (const [name, size] of Object.entries(ATTRIBUTES)) attributes[name] = fit(this.arrays[name], this.vertexCount * size);
    return { attributes, index: fit(this.indices, this.indexCount) };
  }
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();
const _uv = new THREE.Vector2();
const _bp = new THREE.Vector4();

// A tube along the curve, radius from r0 at the base to r1 at the top (or radiusAt(t)). Thickness 1.8 marks a stipe;
// height is the place on its stipe the physics moves it with (t along the curve unless given).
function appendTube(acc, curve, segs, radial, r0, r1, colSeed, { radiusAt = null, height = null, marker = 1.8 } = {}) {
  const frames = curve.computeFrenetFrames(segs, false);
  const length = curve.getLength();
  const grid = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, _p);
    const radius = radiusAt ? radiusAt(t) : THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.7));
    const N = frames.normals[i];
    const B = frames.binormals[i];
    _bp.set(height ?? t, 0, 0, marker);
    const ring = [];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      _n.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a)).normalize();
      _q.copy(_p).addScaledVector(_n, radius);
      _uv.set(t * length, j / radial);
      ring.push(acc.addVertex(_q, _n, _uv, colSeed, _bp, _p));
    }
    grid.push(ring);
  }
  acc.addGrid(grid);
}

const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();

// A solid of revolution from base along axis (a unit vector): radius profile(s) at the fractions s in at, sides around.
// Marker 1.5 marks a gas bladder or float, 1.8 other stalk tissue; height is its place on the stipe for the physics.
function appendLathe(acc, base, axis, length, profile, at, sides, colSeed, height, marker = 1.5) {
  _s1.crossVectors(axis, Math.abs(axis.y) < 0.9 ? UP : _q.set(1, 0, 0)).normalize();
  _s2.crossVectors(axis, _s1);
  const n = at.length - 1;
  const r = at.map(profile);
  _bp.set(height, 0, 0, marker);
  const grid = [];
  for (let i = 0; i <= n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1);
    // The surface's slope along the axis tilts its normal toward the narrower end.
    const slope = (r[i1] - r[i0]) / ((at[i1] - at[i0]) * length);
    _p.copy(base).addScaledVector(axis, at[i] * length);
    const ring = [];
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      _n.copy(_s1).multiplyScalar(Math.cos(a)).addScaledVector(_s2, Math.sin(a));
      _q.copy(_p).addScaledVector(_n, r[i]);
      _n.addScaledVector(axis, -slope).normalize();
      _uv.set(at[i], j / sides);
      ring.push(acc.addVertex(_q, _n, _uv, colSeed, _bp, base));
    }
    grid.push(ring);
  }
  acc.addGrid(grid);
}

// A giant kelp's gas bladder: a thin stalk for its first 30%, then a float swelling to radius and narrowing into the blade.
const bladderRings = (rings) => (rings === 2 ? [0, 0.65, 1] : [0, ...Array.from({ length: rings }, (_, i) => 0.3 + (0.7 * i) / (rings - 1))]);
const bladderProfile = (radius) => (s) => (s < 0.3 ? 0.0035 : Math.max(0.0035, radius * Math.pow(Math.sin((Math.PI * Math.min(1, s - 0.3)) / 0.7), 0.75)));

// Width along a blade (0 at the base, 1 at the tip), per kind.
const SHAPES = {
  // Bull kelp: a long ribbon out of the bulb, nearly the same width to a blunt end.
  ribbon: (u) => (0.12 + 0.88 * Math.sqrt(smooth(0, 0.07, u))) * Math.sqrt(Math.max(0, 1 - Math.pow(smooth(0.85, 1, u), 2))),
  // Pterygophora: narrow, parallel-sided and blunt.
  ptery: (u) => (0.15 + 0.85 * Math.sqrt(smooth(0, 0.12, u))) * Math.sqrt(Math.max(0, 1 - Math.pow(smooth(0.55, 1, u), 1.6))),
  // Giant kelp sporophylls: short, smooth, rounded.
  spor: (u) => Math.sqrt(smooth(0, 0.2, u)) * Math.sqrt(Math.max(0, 1 - Math.pow(smooth(0.4, 1, u), 1.6))),
};

// Giant kelp: a wedge out of the bladder, widest at peak, tapering to a point (full: 1 straight, less fuller, more
// slender). A worn blade (worn 0..1) has lost its tip: it ends where it is still wide, rounded off.
function giantOutline(peak, full, neck, worn) {
  const k = Math.log(0.5) / Math.log(peak);
  const young = (u) => Math.sqrt(smooth(0, neck, u)) * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(u, k))), full);
  if (worn <= 0.01) return young;
  const keep = 1 - 0.3 * worn, cap = 0.08 * worn;
  return (u) => young(u * keep) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, u - 1 + cap) / cap, 2)));
}

// How much of a blade's bend is done at u: mostly just past the base (hanging from its float) or toward the tip (arching).
const BENDS = { base: (u) => 1 - (1 - u) * (1 - u) * (1 - u), arch: (u) => Math.pow(u, 1.6) };
// The centre line is integrated in fixed steps, so every tessellation (and the shadow copy) follows the same curve.
const LINE_STEPS = 48;
const BEND_STEPS = Object.fromEntries(Object.entries(BENDS).map(([k, f]) => [k, Float64Array.from({ length: LINE_STEPS }, (_, i) => f((i + 0.5) / LINE_STEPS))]));
const lineC = new Float64Array(LINE_STEPS + 1);
const lineS = new Float64Array(LINE_STEPS + 1);
const bladeScratch = { pos: new Float64Array(3 * 64 * 9), rowN: new Float64Array(3 * 64), params: new Float64Array(4 * 64 * 9) };
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _kr = new THREE.Vector3();
const _kn = new THREE.Vector3();
const _dU = new THREE.Vector3();
const _dV = new THREE.Vector3();

// A blade from attach, launched along dir and bent over toward hang by droop (the fraction of the angle between them it
// turns through) without stretching, its cross-section curled on an arc and its margins buckled into ruffles (ruffle: their
// height as a fraction of the half width, ruffleLength: their length in metres). uv is in metres (along, across) for the
// shaders' wrinkles. Returns the tip's centre; with no accumulator it only finds it.
function appendBlade(acc, o) {
  const { attach, dir, length, width, outline, hang = DOWN, droop = 0, bend = "base", twist = 0, ruffle = 0, ruffleLength = 0.35, curl = 0, colSeed, colHeight, segsU, segsV, bladeId, phase = 0 } = o;
  const forward = _fwd.copy(dir).normalize();
  const right = _right.crossVectors(forward, UP);
  if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
  const normal = _norm.crossVectors(right, forward).normalize();
  right.crossVectors(forward, normal);
  const axis = _axis.crossVectors(forward, _q.copy(hang).normalize());
  // A blade launched straight at its hang direction bends about its own width.
  if (axis.lengthSq() < 1e-6) axis.copy(right);
  else axis.normalize();
  const turn = droop * forward.angleTo(_q);
  const perp = _perp.crossVectors(axis, forward);
  const bendAt = BENDS[bend];
  const steps = BEND_STEPS[bend];
  for (let k = 0; k < LINE_STEPS; k++) {
    const a = turn * steps[k];
    lineC[k + 1] = lineC[k] + Math.cos(a) / LINE_STEPS;
    lineS[k + 1] = lineS[k] + Math.sin(a) / LINE_STEPS;
  }
  const tip = attach.clone().addScaledVector(forward, lineC[LINE_STEPS] * length).addScaledVector(perp, lineS[LINE_STEPS] * length);
  if (!acc) return tip;

  // The frame turns with the centre line: right and normal rotated about the bend axis (Rodrigues, terms kept per blade).
  const kr = _kr.crossVectors(axis, right), kn = _kn.crossVectors(axis, normal);
  const dr = axis.dot(right), dn = axis.dot(normal);
  const widthAt = outline;
  const cols = segsV + 1;
  const count = (segsU + 1) * cols;
  if (bladeScratch.pos.length < count * 3 || bladeScratch.rowN.length < (segsU + 1) * 3) {
    bladeScratch.pos = new Float64Array(count * 6);
    bladeScratch.params = new Float64Array(count * 8);
    bladeScratch.rowN = new Float64Array((segsU + 1) * 6);
  }
  const { pos, params, rowN } = bladeScratch;
  for (let i = 0; i <= segsU; i++) {
    const u = i / segsU;
    const x = u * LINE_STEPS, k = Math.min(LINE_STEPS - 1, Math.floor(x)), f = x - k;
    const along = (lineC[k] + (lineC[k + 1] - lineC[k]) * f) * length;
    const out = (lineS[k] + (lineS[k + 1] - lineS[k]) * f) * length;
    const cx = attach.x + forward.x * along + perp.x * out;
    const cy = attach.y + forward.y * along + perp.y * out;
    const cz = attach.z + forward.z * along + perp.z * out;
    const a = turn * bendAt(u), ca = Math.cos(a), sa = Math.sin(a), ia = 1 - ca;
    const r0x = right.x * ca + kr.x * sa + axis.x * dr * ia, r0y = right.y * ca + kr.y * sa + axis.y * dr * ia, r0z = right.z * ca + kr.z * sa + axis.z * dr * ia;
    const n0x = normal.x * ca + kn.x * sa + axis.x * dn * ia, n0y = normal.y * ca + kn.y * sa + axis.y * dn * ia, n0z = normal.z * ca + kn.z * sa + axis.z * dn * ia;
    const tw = twist * u, ct = Math.cos(tw), st = Math.sin(tw);
    const rx = r0x * ct + n0x * st, ry = r0y * ct + n0y * st, rz = r0z * ct + n0z * st;
    const nx = n0x * ct - r0x * st, ny = n0y * ct - r0y * st, nz = n0z * ct - r0z * st;
    rowN[i * 3] = nx;
    rowN[i * 3 + 1] = ny;
    rowN[i * 3 + 2] = nz;
    const halfW = width * 0.5 * Math.max(widthAt(u), 0.02);
    // The cross-section curls on an arc, more toward the tip; v * halfW stays the distance across.
    const th = curl * (0.3 + 0.7 * smooth(0.1, 1, u));
    // The margins are longer than the midline, so they buckle, out of step on the two sides; none at the stalk, less at the tip.
    const buckle = ruffle * halfW * smooth(0.04, 0.25, u) * (1 - 0.6 * smooth(0.85, 1, u));
    const wave = (u * length * 2 * Math.PI) / ruffleLength + phase;
    for (let j = 0; j <= segsV; j++) {
      const v = (j / segsV) * 2 - 1;
      const av = Math.abs(v);
      const xs = Math.abs(th) < 1e-3 ? v : Math.sin(v * th) / th;
      const ys = Math.abs(th) < 1e-3 ? 0 : (1 - Math.cos(v * th)) / th;
      const across = xs * halfW, lift = ys * halfW + (buckle > 0 ? buckle * av * av * Math.sin(wave + (v > 0 ? 0 : 2.1)) : 0);
      const p = (i * cols + j) * 3;
      pos[p] = cx + rx * across + nx * lift;
      pos[p + 1] = cy + ry * across + ny * lift;
      pos[p + 2] = cz + rz * across + nz * lift;
      // Even across the blade, thinner toward the tip and in the outer margin.
      const q = (i * cols + j) * 4;
      params[q] = u;
      params[q + 1] = v;
      params[q + 2] = Math.max(0.14, (1 - 0.6 * Math.pow(u, 0.8)) * (1 - 0.3 * smooth(0.7, 1, av)));
      params[q + 3] = v * halfW;
    }
  }
  const base = acc.vertexCount;
  for (let i = 0; i <= segsU; i++) {
    const iu1 = Math.min(segsU, i + 1) * cols, iu0 = Math.max(0, i - 1) * cols;
    for (let j = 0; j <= segsV; j++) {
      const a = (iu1 + j) * 3, b = (iu0 + j) * 3, c = (i * cols + Math.min(segsV, j + 1)) * 3, d = (i * cols + Math.max(0, j - 1)) * 3;
      _dU.set(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
      _dV.set(pos[c] - pos[d], pos[c + 1] - pos[d + 1], pos[c + 2] - pos[d + 2]);
      _n.crossVectors(_dV, _dU);
      if (_n.lengthSq() < 1e-14) _n.set(rowN[i * 3], rowN[i * 3 + 1], rowN[i * 3 + 2]);
      else _n.normalize();
      const p = (i * cols + j) * 3, q = (i * cols + j) * 4;
      _p.set(pos[p], pos[p + 1], pos[p + 2]);
      _uv.set(params[q] * length, params[q + 3]);
      _bp.set(colHeight, params[q], params[q + 1], params[q + 2]);
      acc.addVertex(_p, _n, _uv, colSeed, _bp, attach, bladeId);
    }
  }
  acc.addGridRows(base, segsU + 1, cols);
  return tip;
}

// A canopy run from top downstream, shortened to pass 1.4 m clear of the sun spot: the canopy frames the sun.
function clearOfSun(top, down, run) {
  const sx = SUN_SPOT[0] - top.x, sz = SUN_SPOT[1] - top.z;
  const along = Math.max(0, Math.min(run, sx * down.x + sz * down.z));
  return Math.hypot(sx - down.x * along, sz - down.z * along) < 1.4 ? Math.min(run, Math.max(0, along - 1.4)) : run;
}

// A stipe's path up to reach (a fraction of its length), resampled about every 0.8 m with a gentle sideways wave and a
// slow bow of its own, none at the holdfast, so the stipes of a bundle splay apart and cross. It stays under the surface.
function wander(curve, reach, [a, b, c, d, e, g]) {
  const total = curve.getLength() * reach;
  const n = Math.max(6, Math.ceil(total / 0.8) + 1);
  const amp = 0.06 + 0.1 * a;
  const k1 = (2 * Math.PI) / (2.5 + 1.5 * b);
  const k2 = (2 * Math.PI) / (2.5 + 1.5 * c);
  const ph = d * 2 * Math.PI;
  const bow = 0.2 + 0.3 * e;
  const kb = (2 * Math.PI) / (5 + 4 * g);
  const bx = Math.cos(e * 40), bz = Math.sin(e * 40);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const p = curve.getPointAt(s * reach);
    const arc = s * total;
    const fade = amp * smooth(0, 2, arc);
    const sway = bow * smooth(0, 4, arc) * Math.sin(kb * arc + g * 9);
    p.x += fade * Math.sin(k1 * arc + ph) + bx * sway;
    p.z += fade * Math.sin(k2 * arc + ph * 1.7 + 1.3) + bz * sway;
    p.y = Math.min(p.y, SURFACE - 0.12);
    pts.push(p);
  }
  return new THREE.CatmullRomCurve3(pts);
}

const _radial = new THREE.Vector3();
const _bdir = new THREE.Vector3();
const _hang = new THREE.Vector3();
const _float = new THREE.Vector3();
const _start = new THREE.Vector3();
const _seed = new THREE.Vector3();

// Builds plants into one accumulator, recording the physics layout as it goes. The shadow copy (shadow: true) leaves out
// what is thinner than a shadow texel, with the same draws, so its columns and blades are the main build's.
class Forest {
  constructor(rng, segs, density, { detail = 1, shadow = false, capacity } = {}) {
    this.rng = rng;
    this.segs = segs;
    this.density = density;
    this.detail = detail;
    this.shadow = shadow;
    this.acc = new KelpGeometryAccumulator(capacity);
    this.columns = [];
    this.blades = [];
  }

  // Rows along a blade: the tessellation follows its length.
  rows(len, perMetre, min) {
    return Math.max(min, Math.round(len * perMetre * this.detail));
  }

  column(curve, physics) {
    const colId = this.columns.length;
    this.columns.push({ curve, ...physics });
    return colId;
  }

  // The blade is built first, and its drawn chord is the physics' rest pose, so an unmoved blade renders as built.
  // options.noShadow leaves it out of the shadow copy, which also skips the ruffles (they don't move the chord).
  blade(colId, segT, attach, dir, length, width, hinge, options) {
    const bladeId = this.blades.length;
    const acc = this.shadow && options.noShadow ? null : this.acc;
    const tip = appendBlade(acc, { attach, dir, length, width, bladeId, colHeight: segT, ...options, ruffle: this.shadow ? 0 : options.ruffle });
    const chord = tip.sub(attach);
    this.blades.push({ colId, segT, attachPos: attach.clone(), restDir: chord.clone().normalize(), length: chord.length(), halfWidth: width * 0.5, ...hinge });
  }

  // A holdfast: a low mound of root-like haptera spreading and forking down onto the rock around a stipe's base. It rides
  // the stipe's pinned base. It draws from its own generator: the shadow copy skips it and keeps the plant's sequence.
  holdfast(colId, cx, cz, radius, count, rng) {
    // None on the lightest tier, and only the big ones on the medium tier.
    const n = this.detail < (radius < 0.2 ? 0.7 : 0.5) ? 0 : Math.round(count * this.detail);
    if (this.shadow || n === 0) return;
    const colSeed = new THREE.Vector3(colId, 0, rng());
    const y0 = floorHeight(cx, cz);
    const height = radius * 0.7;
    const [along, around] = this.detail < 0.7 || radius < 0.2 ? [4, 3] : [6, 4];
    appendLathe(this.acc, new THREE.Vector3(cx, y0 - 0.06, cz), UP, height + 0.06, (s) => radius * 0.4 * Math.sqrt(Math.max(0, 1 - s * s)), [0, 0.35, 0.65, 0.85, 1], 7, colSeed, 0, 1.8);
    for (let h = 0; h < n; h++) {
      const a = rng() * Math.PI * 2, r0 = Math.sqrt(rng()) * radius * 0.35, reach = radius * (0.6 + 0.5 * rng());
      const start = new THREE.Vector3(cx + Math.cos(a) * r0, y0 + height * (0.5 + 0.5 * rng()) * (1 - r0 / radius), cz + Math.sin(a) * r0);
      const ea = a + (rng() - 0.5) * 0.6, ex = cx + Math.cos(ea) * reach, ez = cz + Math.sin(ea) * reach;
      const end = new THREE.Vector3(ex, floorHeight(ex, ez) - 0.04, ez);
      const mid = start.clone().lerp(end, 0.45).add(new THREE.Vector3(0, radius * (0.12 + 0.18 * rng()), 0));
      const r = (0.006 + 0.006 * rng()) * (radius < 0.2 ? 0.6 : 1);
      appendTube(this.acc, new THREE.CatmullRomCurve3([start, mid, end]), along, around, r, r * 0.45, colSeed, { height: 0 });
    }
  }

  // Giant kelp: a bundle of fronds from one holdfast. A frond grows from its tip: blades and their stalks grow from a few cm
  // to full size over its top metre or so and split off the stipe one side then the other, loosely, on small gas bladders.
  // Mature blades hang from their bladders on their own side and downstream; old fronds have shed their lowest blades. The
  // older fronds reach the surface and grow on along it downstream as the canopy, their blades trailing along it. maxAge
  // caps the plant's age (the composed plants keep their lower blades). holdfast: its radius (0 for none), with haptera
  // roots and sporophylls per stipe on the first two.
  giant({ points, stipes = 3, spread = 0.35, radius = 0.011, bladeEvery = 0.2, bladeLength = 1.0, bladeWidth = 0.19, canopy = 3, stream = STREAM, far = false, bladderScale = 1, bladders = "plant", rowsPerMetre = 18, maxAge = 1, sway = 1, holdfast = 0, haptera = 0, sporophylls = 0, ruffle = 0 }) {
    const { segs } = this;
    // One draw from the forest's sequence per plant, so changes inside a plant never move the others.
    const rng = mulberry32((this.rng() * 4294967296) >>> 0);
    const hrng = mulberry32((rng() * 4294967296) >>> 0);
    const plantAge = rng() * maxAge;
    const down = new THREE.Vector3(stream.x, 0, stream.z).normalize();
    const side = new THREE.Vector3(-down.z, 0, down.x);
    const count0 = Math.max(1, Math.round(stipes * (0.5 + 0.5 * this.density)));
    const full = Math.ceil(count0 * 0.6);
    const [rings, sides] = segs.bladder[bladders];
    const at = bladderRings(rings);
    const [px, , pz] = points[0];
    const ground = floorHeight(px, pz);
    const attach = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const r = new Float64Array(20);
    for (let b = 0; b < count0; b++) {
      const twistPhase = (b / count0) * Math.PI * 2 + rng() * 0.6;
      const pts = points.map(([x, y, z], idx) => {
        const t = idx / Math.max(points.length - 1, 1);
        const off = spread * (0.2 + t);
        const ang = twistPhase + t * 2.6;
        return new THREE.Vector3(x + Math.cos(ang) * off, y, z + Math.sin(ang) * off);
      });
      // Out of the top of the holdfast, or straight from the rock.
      pts[0].y = ground + (holdfast > 0 ? holdfast * 0.7 * (0.7 + 0.25 * rng()) : -0.05);
      const reach = b < full ? 1 : 0.25 + 0.65 * rng();
      const want = canopy * (0.7 + 0.6 * rng());
      const jit = [rng(), rng(), rng(), rng(), rng(), rng()];
      const wave = [rng(), rng(), rng(), rng(), rng(), rng()];
      if (reach === 1) {
        // A top leaning upstream ends at the point before it, so the run never doubles back over the stipe.
        const [p, l] = pts.slice(-2);
        const top = (l.x - p.x) * down.x + (l.z - p.z) * down.z < 0 ? p : l;
        const run = clearOfSun(top, down, want);
        if (run > 1) {
          if (top === p) pts.pop();
          for (let k = 1; k <= 3; k++) {
            pts.push(
              top
                .clone()
                .addScaledVector(down, (k * run) / 3)
                .addScaledVector(side, (jit[k - 1] - 0.5) * Math.min(0.8, 0.18 * run))
                .setY(SURFACE - 0.12 - 0.1 * jit[k + 2]),
            );
          }
        }
      }
      const curve = wander(new THREE.CatmullRomCurve3(pts), reach, wave);
      const age = Math.min(1, Math.max(0, plantAge * (reach < 1 ? 0.5 : 1) + (rng() - 0.5) * 0.2));
      const colId = this.column(curve, { swayAmp: sway * (0.9 + 0.2 * rng()), stiffness: 0.65, buoyancy: 0.85, topBuoy: 0, kind: KINDS.giant, age, flex: 0.55 });
      const colSeed = new THREE.Vector3(colId, 0, rng());
      const r0 = radius * (0.85 + 0.3 * rng());
      const length = curve.getLength();
      // Thinner than a shadow texel, the stipe stays out of the shadow copy.
      if (!this.shadow) appendTube(this.acc, curve, Math.max(12, Math.round(length * (far ? 2 : 4) * this.detail)), far ? segs.radialFar : segs.radial, r0, r0 * 0.8, colSeed);
      if (b === 0 && holdfast > 0) this.holdfast(colId, px, pz, holdfast, haptera, hrng);

      // Sporophylls: a skirt of short, smooth blades without bladders just above the holdfast, splayed out and down.
      for (let k = 0; b < 2 && k < sporophylls; k++) {
        for (let q = 0; q < 6; q++) r[q] = rng();
        const t = Math.min(0.5, (0.1 + 0.7 * r[0]) / length);
        curve.getPointAt(t, attach);
        curve.getTangentAt(t, tangent);
        const radial = _radial.set(Math.cos(r[1] * 6.2832), 0, Math.sin(r[1] * 6.2832));
        radial.addScaledVector(tangent, -radial.dot(tangent)).normalize();
        const len = Math.min(0.25 + 0.25 * r[2], 0.9 * (attach.y - floorHeight(attach.x, attach.z)) + 0.15);
        const start = attach.clone().addScaledVector(radial, r0);
        this.blade(colId, t, start, _bdir.copy(radial).addScaledVector(tangent, 0.8).normalize(), len, 0.05 + 0.04 * r[3], hingeOf("giant", r[4], false), {
          outline: SHAPES.spor,
          hang: _hang.copy(radial).addScaledVector(DOWN, 0.5).normalize(),
          droop: 0.6 + 0.4 * r[4],
          twist: (r[5] - 0.5) * 0.8,
          curl: 0.3,
          noShadow: true,
          // y: age + 2 for a sporophyll.
          colSeed: _seed.set(colId, 2 + age, r[5]),
          segsU: this.rows(len, 14, 4),
          segsV: 2,
          phase: r[2] * 6.28,
        });
      }

      let plane = rng() * Math.PI * 2;
      let flip = false;
      let step = 0;
      for (let d = 0.04; d < length - 0.4; d += step) {
        // A fixed number of draws per node, shed or not.
        for (let k = 0; k < r.length; k++) r[k] = rng();
        const t = 1 - d / length;
        const mature = 1 - Math.exp(-d / 0.8);
        const oldness = smooth(0.45, 1, d / length) * age;
        // Internodes grow from a few cm at the tip to full length, unevenly.
        step = (0.03 + (bladeEvery - 0.03) * mature * (0.45 + 1.1 * r[0])) / this.density;
        // One side then the other of a plane turning along the stipe, loosely.
        const angle = plane + (flip ? Math.PI : 0) + (r[1] - 0.5) * 1.8;
        flip = !flip;
        plane += 1.6 * step;
        if (r[2] < 0.06 + 0.6 * oldness) continue;
        curve.getPointAt(t, attach);
        curve.getTangentAt(t, tangent);
        const atSurface = smooth(SURFACE - 1.0, SURFACE - 0.35, attach.y);
        // Blades split off square to the stipe; on a level canopy run, to either side and never up out of the water.
        const radial = _radial.set(Math.cos(angle), 0, Math.sin(angle));
        radial.addScaledVector(tangent, -radial.dot(tangent));
        if (radial.lengthSq() < 0.04) radial.crossVectors(tangent, UP).multiplyScalar(flip ? 1 : -1);
        radial.normalize();
        if (atSurface > 0 && radial.y > 0) {
          radial.y = 0;
          if (radial.lengthSq() < 1e-4) radial.crossVectors(tangent, UP);
          radial.normalize();
        }
        // The bladder floats out and up (along the surface in the canopy), young ones pointing on toward the frond's tip.
        // The blade bends over from it: in mid-water it hangs, on its own side and downstream; at the surface it trails
        // downstream along it.
        const bdir = _bdir.copy(radial).addScaledVector(UP, 0.4 * (1 - atSurface)).addScaledVector(tangent, 1.5 * (1 - mature));
        if (atSurface > 0) bdir.y = Math.min(bdir.y, 0.45 * (1 - atSurface));
        bdir.normalize();
        const hang = _hang.copy(radial).multiplyScalar(0.4).addScaledVector(down, 0.35).add(DOWN).applyAxisAngle(UP, (r[13] - 0.5) * 0.9).normalize();
        hang.lerp(_float.copy(down).addScaledVector(radial, 0.6).addScaledVector(DOWN, 0.15).applyAxisAngle(UP, (r[19] - 0.5) * 1.2).normalize(), atSurface).normalize();
        const bladeAge = Math.min(0.999, Math.max(0, 0.85 * (d / length) + 0.3 * plantAge + 0.3 * (r[6] - 0.5)));
        // A few old blades are dying back: limp, worn short.
        const senescent = bladeAge > 0.75 && r[17] < 0.07;
        const len = bladeLength * (0.12 + 0.88 * mature) * (0.7 + 0.6 * r[3]) * (1 - 0.25 * oldness * r[4]);
        const wid = bladeWidth * (0.3 + 0.7 * mature) * (0.75 + 0.5 * r[5]);
        const R = (far ? 0.006 + 0.008 * mature : 0.0075 + 0.0105 * mature) * bladderScale * (0.85 + 0.3 * r[7]);
        const L = bladderScale > 0 ? 0.015 + 2.6 * R : 0;
        const start = _start.copy(attach).addScaledVector(bdir, r0 * 0.5);
        // Bladders are below a shadow texel, and below a pixel when small and far.
        if (L > 0 && !this.shadow && !(far && R < 0.008)) appendLathe(this.acc, start, bdir, L, bladderProfile(R), at, sides, colSeed, t);
        start.addScaledVector(bdir, L);
        const limp = (0.82 + 0.18 * r[11]) * (1 - atSurface) + (0.45 + 0.5 * r[11]) * atSurface;
        this.blade(colId, t, start, bdir, len, wid, hingeOf("giant", r[18], !far && len > 0.45), {
          outline: giantOutline(0.26 + 0.16 * r[8], 0.75 + 0.5 * r[9], 0.05 + 0.05 * r[10], senescent ? 1 : smooth(0.5, 1, bladeAge) * r[4]),
          hang,
          droop: Math.min(1, (0.25 + 0.75 * mature) * limp * (senescent ? 1.3 : 1)),
          bend: r[14] < 0.2 ? "arch" : "base",
          twist: (r[15] - 0.5) * 2.0,
          curl: (r[12] - 0.35) * 1.6,
          ruffle: far ? 0 : ruffle * (0.7 + 0.6 * r[16]),
          ruffleLength: (6.5 + 3 * r[16]) / rowsPerMetre,
          // y: the blade's age, plus 4 when it is dying back.
          colSeed: _seed.set(colId, senescent ? 4 + bladeAge : bladeAge, (colSeed.z * 0.4 + r[7] * 0.6) % 1),
          segsU: far ? this.rows(len, 7, 3) : this.rows(len, rowsPerMetre, 4),
          segsV: far ? 2 : segs.nearV,
          phase: r[10] * 6.28,
        });
      }
    }
  }

  // Bull kelp (Nereocystis): a thin whip of a stipe swelling over its top third into one round float, with two bunches of
  // long ribbons streaming downstream from it together.
  bull({ base, top, ribbons = 28, ribbonLength = 2.8, ribbonWidth = 0.11, stream = STREAM, far = false }) {
    const { segs } = this;
    const rng = mulberry32((this.rng() * 4294967296) >>> 0);
    const hrng = mulberry32((rng() * 4294967296) >>> 0);
    const b = new THREE.Vector3(...base);
    const t = new THREE.Vector3(...top);
    const mid = b.clone().lerp(t, 0.55).add(new THREE.Vector3((rng() - 0.5) * 1.2, 0, (rng() - 0.5) * 1.2));
    const curve = new THREE.CatmullRomCurve3([b, b.clone().lerp(mid, 0.5), mid, mid.clone().lerp(t, 0.6), t]);
    const colId = this.column(curve, { swayAmp: 1.1, stiffness: 0.2, buoyancy: 0.15, topBuoy: 3, kind: KINDS.bull, age: rng(), flex: 1 });
    const colSeed = new THREE.Vector3(colId, 0, rng());
    appendTube(this.acc, curve, this.rows(curve.getLength(), 1.2, 12), segs.radialFar, 0, 0, colSeed, { radiusAt: (s) => 0.005 + 0.017 * Math.pow(smooth(0.55, 1, s), 1.5) });
    if (!far) this.holdfast(colId, b.x, b.z, 0.1, 6, hrng);
    // The float: the stipe flares into it, widest two thirds up and rounded on top. Marked as a bladder, so it glows.
    const floatR = 0.055 + 0.02 * rng();
    const tangent = curve.getTangentAt(1, new THREE.Vector3());
    const crown = t.clone().addScaledVector(tangent, floatR * 2.4);
    const bulb = (s) => (0.022 + (floatR - 0.022) * smooth(0, 0.65, s)) * Math.sqrt(Math.max(0, 1 - Math.pow(smooth(0.6, 1, s), 2)));
    appendLathe(this.acc, t, tangent, floatR * 2.4, bulb, [0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.83, 0.92, 0.97, 1], segs.floatSides, colSeed, 1);
    const across = new THREE.Vector3().crossVectors(tangent, stream).normalize();
    const hang = stream.clone().add(new THREE.Vector3(0, -0.4, 0)).normalize();
    const count = Math.max(4, Math.round(ribbons * this.density));
    for (let k = 0; k < count; k++) {
      const bunch = k & 1 ? 1 : -1;
      const start = crown.clone().addScaledVector(across, bunch * floatR * 0.3).addScaledVector(tangent, -floatR * 0.3);
      const dir = stream.clone().addScaledVector(across, bunch * (0.25 + 0.35 * rng())).addScaledVector(tangent, 0.2 + 0.4 * rng()).normalize();
      const len = ribbonLength * (0.6 + 0.7 * rng());
      this.blade(colId, 1, start, dir, len, ribbonWidth * (0.8 + 0.4 * rng()), hingeOf("bull", rng(), !far), {
        outline: SHAPES.ribbon,
        hang,
        droop: 0.5 + 0.4 * rng(),
        twist: (rng() - 0.5) * 2.4,
        curl: (rng() - 0.5) * 1.0,
        ruffle: far ? 0 : 0.5,
        ruffleLength: 0.6 + 0.25 * rng(),
        colSeed: new THREE.Vector3(colId, 0.2 + 0.6 * rng(), rng()),
        segsU: this.rows(len, far ? 6 : 12, far ? 6 : 8),
        segsV: far ? 2 : segs.nearV,
        phase: rng() * 6.28,
      });
    }
  }

  // Pterygophora: a thin woody stipe with two rows of narrow, dark blades along its upper third and one at its tip, held up
  // and arching over downstream.
  palm({ base, height = 1.0, blades = 12, bladeLength = 0.48, bladeWidth = 0.065, stream = STREAM }) {
    const { segs } = this;
    const rng = mulberry32((this.rng() * 4294967296) >>> 0);
    const hrng = mulberry32((rng() * 4294967296) >>> 0);
    const b = new THREE.Vector3(...base);
    const lean = new THREE.Vector3((rng() - 0.5) * 0.35 + stream.x * 0.2, 1, (rng() - 0.5) * 0.35 + stream.z * 0.2).normalize();
    const top = b.clone().addScaledVector(lean, height);
    const bow = new THREE.Vector3((rng() - 0.5) * 0.12, 0, (rng() - 0.5) * 0.12);
    const curve = new THREE.CatmullRomCurve3([b, b.clone().lerp(top, 0.4).add(bow), top]);
    const colId = this.column(curve, { swayAmp: 0.3, stiffness: 12, buoyancy: 0, topBuoy: 0, kind: KINDS.palm, age: rng(), flex: 0.3 });
    const colSeed = new THREE.Vector3(colId, 0, rng());
    appendTube(this.acc, curve, 8, segs.radialFar, 0.011, 0.007, colSeed);
    this.holdfast(colId, b.x, b.z, 0.08 + 0.04 * rng(), 5, hrng);
    const plane = rng() * Math.PI;
    const hang = stream.clone().multiplyScalar(1.2).add(DOWN).normalize();
    const attach = new THREE.Vector3(), tangent = new THREE.Vector3();
    for (let i = 0; i <= blades; i++) {
      // The last continues the stipe.
      const tip = i === blades;
      const t = tip ? 1 : 0.62 + 0.36 * (i / blades);
      curve.getPointAt(t, attach);
      curve.getTangentAt(t, tangent);
      const a = plane + (i & 1 ? Math.PI : 0) + (rng() - 0.5) * 0.4;
      const dir = tip ? tangent.clone() : tangent.clone().multiplyScalar(0.9).add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.55)).normalize();
      const len = bladeLength * (tip ? 1.25 : 0.6 + 0.5 * (i / blades)) * (0.85 + 0.3 * rng());
      this.blade(colId, t, attach, dir, len, bladeWidth * (0.8 + 0.4 * rng()), hingeOf("palm", rng()), {
        outline: SHAPES.ptery,
        hang,
        droop: 0.35 + 0.4 * rng(),
        bend: "arch",
        twist: (rng() - 0.5) * 0.5,
        curl: 0.2,
        colSeed: new THREE.Vector3(colId, 0.3 + 0.5 * rng(), rng()),
        segsU: this.rows(len, 18, 6),
        segsV: segs.nearV,
        phase: rng() * 6.28,
      });
    }
  }

  // A young giant kelp on the reef: a short stipe with one to three broad, thin blades. Too small for the physics, they
  // share one stub of a column, pinned where they stand, and only ripple in the shader.
  juvenile({ base, stream = STREAM }) {
    const { segs } = this;
    const rng = mulberry32((this.rng() * 4294967296) >>> 0);
    const b = new THREE.Vector3(...base);
    this.young ??= this.column(new THREE.LineCurve3(b, b.clone().add(new THREE.Vector3(0, 0.2, 0))), { swayAmp: 0.1, stiffness: 12, buoyancy: 0, topBuoy: 0, kind: KINDS.giant, age: 0.05, flex: 0.55 });
    const colId = this.young;
    const height = 0.05 + 0.35 * rng();
    const top = b.clone().add(new THREE.Vector3((rng() - 0.5) * 0.3 * height + stream.x * 0.2 * height, height, (rng() - 0.5) * 0.3 * height + stream.z * 0.2 * height));
    const curve = new THREE.CatmullRomCurve3([b, b.clone().lerp(top, 0.5).add(new THREE.Vector3((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.04)), top]);
    const colSeed = new THREE.Vector3(colId, 0, rng());
    if (!this.shadow) appendTube(this.acc, curve, 4, segs.radialFar, 0.004, 0.003, colSeed, { height: 0 });
    const n = 1 + Math.floor(rng() * 3);
    const hang = stream.clone().addScaledVector(DOWN, 0.3).normalize();
    const tangent = curve.getTangentAt(1, new THREE.Vector3());
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const dir = tangent.clone().multiplyScalar(1.2).add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))).normalize();
      const len = 0.2 + 0.4 * rng();
      this.blade(colId, 0, top, dir, len, 0.06 + 0.09 * rng(), hingeOf("giant", rng(), false), {
        outline: giantOutline(0.4, 0.8, 0.06, 0),
        hang,
        droop: 0.3 + 0.3 * rng(),
        twist: (rng() - 0.5) * 1.2,
        curl: (rng() - 0.3) * 0.8,
        ruffle: 0.25,
        ruffleLength: 0.2,
        colSeed: new THREE.Vector3(colId, 0.2 * rng(), rng()),
        segsU: this.rows(len, 24, 5),
        segsV: segs.nearV,
        phase: rng() * 6.28,
      });
    }
  }

  pack() {
    const columns = new Float32Array(this.columns.length * COLUMN_STRIDE);
    const p = new THREE.Vector3();
    this.columns.forEach((c, i) => {
      const o = i * COLUMN_STRIDE;
      for (let s = 0; s < SEGS_PER_COL; s++) c.curve.getPointAt(s / (SEGS_PER_COL - 1), p).toArray(columns, o + s * 3);
      columns.set([c.swayAmp, c.stiffness, c.buoyancy, c.topBuoy, c.kind, c.age, c.flex], o + SEGS_PER_COL * 3);
    });
    const blades = new Float32Array(this.blades.length * BLADE_STRIDE);
    this.blades.forEach((b, i) => {
      const o = i * BLADE_STRIDE;
      blades[o] = b.colId;
      blades[o + 1] = b.segT;
      b.attachPos.toArray(blades, o + 2);
      b.restDir.toArray(blades, o + 5);
      blades[o + 8] = b.length;
      blades[o + 9] = b.halfWidth;
      blades[o + 10] = b.maxAngle;
      blades[o + 11] = b.hinge;
      blades[o + 12] = b.simulate === false ? 0 : 1;
    });
    return { ...this.acc.finish(), columns, blades };
  }
}

// The hand-composed forest, framed for the opening view from the reef looking up toward the sun.
const HERO = [
  [-6.0, -6.0, 4.9],
  [-4.9, -1.4, 3.8],
  [-3.8, 3.4, 2.5],
  [-2.9, 9.2, 1.2],
  [-2.0, 16.2, -0.4],
  [-0.8, 17.3, -0.8],
];
const ARCH = [
  [5.8, -6.5, -1.2],
  [4.5, -0.5, -2.4],
  [3.1, 5.8, -3.4],
  [1.5, 11.4, -4.5],
  [-0.2, 16.5, -5.8],
  [-2.0, 17.4, -6.5],
];
const CENTER = [
  [-2.6, -7.0, -3.5],
  [-2.2, 0.5, -4.2],
  [-1.7, 7.5, -4.8],
  [-1.2, 16.4, -5.5],
  [0.2, 17.3, -6.0],
];
// A frond close to the lens, framing the left of the opening view as in the reference.
const NEAR = [
  [-2.7, -5.9, 8.2],
  [-4.2, -3.0, 7.8],
  [-5.2, 0.0, 7.4],
  [-6.1, 3.0, 7.0],
  [-6.6, 7.0, 6.4],
  [-6.8, 12.0, 5.6],
  [-6.6, 16.9, 4.8],
  [-5.6, 17.5, 4.4],
];
// Bull kelp: [x, z, float depth below the surface].
const BULLS = [
  [-4.2, -2.6, 1.4],
  [2.6, -6.4, 0.9],
  [7.2, 1.4, 1.8],
  [-7.6, -8.2, 1.2],
  [3.8, -12.8, 1.0],
];
// Giant kelp further back, between the composed plants and the far forest: [x, z].
const MID = [
  [-8.6, 1.2],
  [8.2, 2.4],
  [-5.6, -4.8],
  [4.6, -5.8],
  [9.8, -2.2],
  [-1.2, -8.4],
  [-10.4, -2.6],
  [1.8, -12.2],
];
// Stands of palm kelp (Pterygophora) on the reef in front: [x, z].
const PALMS = [
  [-5.0, 5.0],
  [-1.6, 4.4],
  [-0.6, 2.2],
  [1.8, 5.0],
  [-6.8, 1.8],
  [4.8, 2.4],
  [0.8, -0.6],
  [3.0, 6.8],
  [-3.2, 6.6],
  [6.6, 4.8],
  [-8.4, 5.2],
  [2.6, 1.0],
  [-3.0, 0.8],
];
const DISTANT = [
  [-8.2, -4.5], [-6.8, -7.5], [-4.6, -9.2], [-1.4, -11.2], [2.4, -9.8], [6.8, -7.0], [9.2, -4.8],
  [-11.0, -10.5], [-7.5, -13.5], [-3.8, -14.8], [0.2, -15.5], [4.5, -14.0], [8.8, -11.2], [12.5, -9.0],
  [-13.5, -17.5], [-9.2, -19.0], [-4.8, -20.5], [-0.4, -21.5], [3.8, -19.8], [8.2, -17.8], [13.0, -15.5],
  [-11.5, -25.0], [-6.5, -26.5], [-1.2, -27.5], [4.2, -26.0], [9.8, -24.5], [15.0, -21.0], [-15.5, -22.0],
  [-11.2, 2.5], [-13.5, 8.5], [-9.8, 12.8], [-5.2, 15.5], [0.4, 17.0], [5.8, 15.2], [10.4, 12.2],
  [11.5, 2.0], [13.8, 7.8], [-16.0, -2.0], [16.2, -1.5], [-14.5, 14.5], [14.8, 14.0],
  [-8.0, 21.5], [0.0, 23.0], [8.2, 21.0],
];
// A far plant's stipe path from its base at (x, z), leaning by (lx, lz) and over at the top.
const farPoints = (x, z, lx, lz) => [
  [x, -8.5, z],
  [x + lx * 0.35, 0.0, z + lz * 0.35],
  [x + lx * 0.75, 8.5, z + lz * 0.75],
  [x + lx, 16.5, z + lz],
  [x + lx + 1.4, 17.5, z + lz + 0.5],
];

// The default seed builds the composed forest; randomLayout moves, leans and resizes its plants and mirrors it half the
// time (from a second generator, so the plants' own randomness is drawn the same way). detail scales the tessellation;
// shadow builds the shadow map's copy.
export function buildKelpForestGeometry({ seed = 42197, randomLayout = false, detail = 1, density = 1, shadow = false } = {}) {
  const rng = mulberry32(seed);
  const segs = {
    nearV: detail < 0.7 ? 2 : 4,
    radial: detail < 0.7 ? 4 : 6,
    radialFar: 4,
    // Giant kelp bladders, [rings, sides]: on the frond by the lens, the composed plants and the mid-distance ones.
    bladder: detail < 0.7 ? { near: [3, 4], plant: [3, 4], far: [2, 3] } : { near: [5, 5], plant: [4, 4], far: [2, 3] },
    floatSides: detail < 0.7 ? 6 : 10,
  };
  const forest = new Forest(rng, segs, density, { detail, shadow, capacity: Math.ceil((shadow ? 1.25e6 : 1.5e6) * detail * density) + (1 << 15) });
  const lay = randomLayout ? createLayout(mulberry32(seed ^ 0x5bd1e995)) : null;
  const place = (cfg) => (lay ? lay.place(cfg) : cfg);
  // A base on the reef, a little into it: the reef's mesh is linear between its vertices.
  const at = (x, z) => [x, floorHeight(x, z) - 0.04, z];
  const sx = lay ? lay.sx : 1;
  // The current runs this way: every blade hangs, and every canopy spreads, downstream.
  const stream = new THREE.Vector3(0.98 * sx, 0, 0.2).normalize();

  const composed = { stream, maxAge: 0.6, holdfast: 0.35, haptera: 48, sporophylls: 6, ruffle: 0.3 };
  forest.giant(place({ ...composed, points: HERO, stipes: 12, spread: 0.36, radius: 0.011, bladeEvery: 0.2, bladeLength: 1.05, bladeWidth: 0.24, canopy: 4 }));
  forest.giant(place({ ...composed, points: ARCH, stipes: 10, spread: 0.42, radius: 0.011, bladeEvery: 0.2, bladeLength: 1.1, bladeWidth: 0.24, canopy: 2.5 }));
  forest.giant(place({ ...composed, points: CENTER, stipes: 8, spread: 0.36, radius: 0.01, bladeEvery: 0.21, bladeLength: 1.0, bladeWidth: 0.22, canopy: 1.2 }));
  forest.giant(place({ ...composed, points: NEAR, stipes: 4, spread: 0.2, radius: 0.01, bladeEvery: 0.2, bladeLength: 1.0, bladeWidth: 0.24, canopy: 2, bladders: "near", rowsPerMetre: 26, maxAge: 0.25, holdfast: 0.25, haptera: 30, sway: 0.6, clear: [0, 10.5, 2.2] }));

  for (const [bx, bz] of MID) {
    const leanX = (rng() - 0.5) * 3;
    const leanZ = (rng() - 0.5) * 2.4;
    forest.giant(
      place({
        points: [
          [bx, -8.0, bz],
          [bx + leanX * 0.3, -0.5, bz + leanZ * 0.3],
          [bx + leanX * 0.7, 8.0, bz + leanZ * 0.7],
          [bx + leanX, 16.4, bz + leanZ],
          [bx + leanX + 1.6, 17.4, bz + leanZ + 0.6],
        ],
        stipes: 9,
        spread: 0.45,
        radius: 0.014,
        bladeEvery: 0.2,
        bladeLength: 1.1 + 0.25 * rng(),
        bladeWidth: 0.3,
        canopy: 4,
        stream,
        far: true,
        bladderScale: 0.8,
        bladders: "far",
        maxAge: 0.7,
        sway: 0.9 + rng() * 0.3,
        holdfast: 0.25,
        haptera: 20,
      }),
    );
  }

  for (const [x, z, depth] of BULLS) {
    const cfg = place({ points: [[x, 0, z], [x + (rng() - 0.5) * 2, 0, z + (rng() - 0.5) * 2]] });
    const [bx, , bz] = cfg.points[0];
    const [tx, , tz] = cfg.points[1];
    forest.bull({ base: at(bx, bz), top: [tx, SURFACE - depth, tz], stream });
  }

  // Palm kelp grows in tight stands.
  for (const [x, z] of PALMS) {
    if (lay && !lay.keep(0.85)) continue;
    const [cx, , cz] = place({ points: [[x, 0, z]] }).points[0];
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < Math.max(1, Math.round(n * density)); k++) {
      const px = cx + (rng() - 0.5) * 1.0;
      const pz = cz + (rng() - 0.5) * 1.0;
      forest.palm({ base: at(px, pz), height: 0.6 + 0.8 * rng(), blades: Math.max(4, Math.round((7 + Math.floor(rng() * 4)) * density)), bladeLength: 0.4 + 0.2 * rng(), stream });
    }
  }

  // Young giant kelp on the reef in front, none right under the camera.
  for (let k = 0; k < Math.round(16 * density); k++) {
    const jx = (rng() - 0.5) * 14;
    const jz = -1 + rng() * 10;
    const [x, , z] = place({ points: [[jx, 0, jz]] }).points[0];
    if (Math.hypot(x, z - 10.5) < 1.5) continue;
    forest.juvenile({ base: at(x, z), stream });
  }

  // The far forest grows in clumps: a younger plant beside about half of them.
  for (const [bx, bz] of lay ? lay.scatter(DISTANT) : DISTANT) {
    const leanX = (rng() - 0.5) * 2.6;
    const leanZ = (rng() - 0.5) * 2.0;
    const nearer = bz > -14;
    if (rng() < 0.18) {
      const cfg = place({ points: [[bx, 0, bz], [bx + leanX, 0, bz + leanZ]] });
      forest.bull({ base: at(cfg.points[0][0], cfg.points[0][2]), top: [cfg.points[1][0], SURFACE - 0.8 - rng(), cfg.points[1][2]], ribbons: 14, far: true, stream });
      continue;
    }
    const distant = { spread: 0.45, radius: 0.018, bladeEvery: nearer ? 0.22 : 0.25, bladeWidth: 0.31, stream, far: true, bladderScale: 0 };
    forest.giant(place({ ...distant, points: farPoints(bx, bz, leanX, leanZ), stipes: nearer ? 4 : 3, bladeLength: 1.15 + 0.25 * rng(), canopy: 2.5, sway: 0.9 + rng() * 0.35 }));
    if (rng() < 0.5) {
      const a = rng() * Math.PI * 2;
      const dist = 0.8 + 0.8 * rng();
      const lx = (rng() - 0.5) * 2.6;
      const lz = (rng() - 0.5) * 2.0;
      forest.giant(place({ ...distant, points: farPoints(bx + Math.cos(a) * dist, bz + Math.sin(a) * dist, lx, lz), stipes: 2, bladeLength: 1.05, canopy: 1.5, maxAge: 0.5 }));
    }
  }
  return { ...forest.pack(), stream: stream.toArray() };
}

// The forest's arrays as a BufferGeometry, on the main thread.
export function forestGeometry({ attributes, index }) {
  const geometry = new THREE.BufferGeometry();
  for (const [name, size] of Object.entries(ATTRIBUTES)) geometry.setAttribute(name, new THREE.BufferAttribute(attributes[name], size));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

// Moves the hand-placed stalks around their spots: shifted, leaned, resized, and the whole forest mirrored half the time.
// A plant with clear: [x, z, r] keeps every point at least r from (x, z), so the camera there never ends up inside it.
function createLayout(r) {
  const range = (a, b) => a + (b - a) * r();
  const sx = r() < 0.5 ? -1 : 1;
  return {
    sx,
    keep: (p) => r() < p,
    place(cfg) {
      const ox = range(-1.2, 1.2), oz = range(-1, 1);
      const lx = range(-1.4, 1.4), lz = range(-1.2, 1.2);
      const n = cfg.points.length;
      const out = {
        ...cfg,
        points: cfg.points.map(([x, y, z], i) => {
          const t = i / Math.max(1, n - 1);
          return [(x + ox + lx * t) * sx, y, z + oz + lz * t];
        }),
      };
      if (cfg.clear) {
        const [cx, cz, cr] = cfg.clear;
        out.points = out.points.map(([x, y, z]) => {
          const dx = x - cx, dz = z - cz, dist = Math.hypot(dx, dz);
          if (dist >= cr) return [x, y, z];
          return dist < 1e-6 ? [cx, y, cz + cr] : [cx + (dx * cr) / dist, y, cz + (dz * cr) / dist];
        });
      }
      if (cfg.bladeLength) out.bladeLength = cfg.bladeLength * range(0.85, 1.2);
      if (cfg.bladeWidth) out.bladeWidth = cfg.bladeWidth * range(0.85, 1.2);
      if (cfg.stipes) out.stipes = Math.max(1, cfg.stipes + Math.round(range(-1, 1)));
      return out;
    },
    scatter(coords) {
      return coords.filter(() => r() < 0.88).map(([x, z]) => [x + range(-1.5, 1.5), z + range(-1.5, 1.5)]);
    },
  };
}

// Grid lines from -44 to 44 m: every `fine` metres across [lo, hi], spreading out to `coarse` toward the edges.
function reefAxis(lo, hi, fine, coarse) {
  const out = [];
  for (let s = fine, x = lo; x > -44; x -= s, s = Math.min(coarse, s * 1.1)) out.unshift(x);
  out.unshift(-44);
  for (let x = lo + fine; x < hi; x += fine) out.push(x);
  for (let s = fine, x = hi; x < 44; x += s, s = Math.min(coarse, s * 1.1)) out.push(x);
  out.push(44);
  return out;
}

// The reef: 88 m square, finely meshed where the views look, so the boulders keep their shape. segments is the tier's
// resolution (160 on high).
export function buildReefFloorGeometry(segments = 80) {
  const fine = segments >= 160 ? 0.14 : 0.3;
  const xs = reefAxis(-12, 12, fine, 88 / segments);
  const zs = reefAxis(-13, 11, fine, 88 / segments);
  const nx = xs.length, nz = zs.length;
  const position = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      position[k] = xs[i];
      position[k + 1] = floorHeight(xs[i], zs[j]);
      position[k + 2] = zs[j];
    }
  }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let n = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + nx;
      index.set([a, b, a + 1, b, b + 1, a + 1], n);
      n += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}
