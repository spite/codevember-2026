// The transparent volume: a union of up to two primitives (rounded boxes, which also make spheres and capsules, and
// tori), morphing between two shapes. The second primitive's k blends the two smoothly (0: a plain union). The same
// field runs in JS for the physics and in GLSL for the render.

const BOX = 0;
const TORUS = 1;

const box = (c, b, r) => ({ type: BOX, c, b, r });
const torus = (c, R, r) => ({ type: TORUS, c, b: [R, r, 0], r: 0 });

// Each fits in a sphere of radius ~1.3 about the origin, which is what the volume turns about.
const SHAPES = {
  cube: () => [box([0, 0, 0], [0.95, 0.95, 0.95], 0.05)],
  slab: () => [box([0, 0, 0], [1.12, 0.62, 0.8], 0.05)],
  tower: () => [box([0, 0, 0], [0.68, 1.12, 0.68], 0.05)],
  sphere: () => [box([0, 0, 0], [1.12, 1.12, 1.12], 1.12)],
  capsule: () => [box([0, 0, 0], [0.7, 1.22, 0.7], 0.7)],
  torus: () => [torus([0, 0, 0], 0.82, 0.44)],
  tee: () => [box([0, 0.55, 0], [0.98, 0.32, 0.56], 0.05), box([0, -0.3, 0], [0.44, 0.82, 0.44], 0.05)],
  // The arms share their bottom, left, front and back faces exactly, so the join leaves no step.
  ell: () => [box([-0.45, 0.02, 0], [0.4, 0.98, 0.56], 0.05), box([0.07, -0.56, 0], [0.92, 0.4, 0.56], 0.05)],
  cross: () => [box([0, 0, 0], [1.05, 0.42, 0.5], 0.05), box([0, 0, 0], [0.42, 1.05, 0.5], 0.05)],
  // Two balls blended into a waisted capsule.
  peanut: () => [box([0, 0.5, 0], [0.7, 0.7, 0.7], 0.7), { ...box([0, -0.5, 0], [0.7, 0.7, 0.7], 0.7), k: 0.45 }],
};

function primSDF(p, x, y, z) {
  x -= p.c[0];
  y -= p.c[1];
  z -= p.c[2];
  if (p.type === TORUS) {
    const q = Math.hypot(x, z) - p.b[0];
    return Math.hypot(q, y) - p.b[1];
  }
  const qx = Math.abs(x) - p.b[0] + p.r, qy = Math.abs(y) - p.b[1] + p.r, qz = Math.abs(z) - p.b[2] + p.r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - p.r;
}

// The field and its gradient for one primitive, into out[0..3].
function primSample(p, x, y, z, out) {
  x -= p.c[0];
  y -= p.c[1];
  z -= p.c[2];
  if (p.type === TORUS) {
    const l = Math.hypot(x, z) || 1e-9;
    const qx = l - p.b[0];
    const m = Math.hypot(qx, y) || 1e-9;
    out[0] = m - p.b[1];
    out[1] = (x / l) * (qx / m);
    out[2] = y / m;
    out[3] = (z / l) * (qx / m);
    return;
  }
  const sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1, sz = z < 0 ? -1 : 1;
  const qx = Math.abs(x) - p.b[0] + p.r, qy = Math.abs(y) - p.b[1] + p.r, qz = Math.abs(z) - p.b[2] + p.r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  const o = Math.hypot(ox, oy, oz);
  if (o > 0) {
    out[0] = o - p.r;
    out[1] = (sx * ox) / o;
    out[2] = (sy * oy) / o;
    out[3] = (sz * oz) / o;
  } else {
    out[0] = Math.max(qx, qy, qz) - p.r;
    out[1] = out[2] = out[3] = 0;
    if (qx >= qy && qx >= qz) out[1] = sx;
    else if (qy >= qz) out[2] = sy;
    else out[3] = sz;
  }
}

const blendOf = (prims) => prims[1]?.k ?? 0;

// Smooth minimum (iq): the weight given to a.
const sminWeight = (a, b, k) => Math.min(Math.max(0.5 + (0.5 * (b - a)) / k, 0), 1);

const _a = [0, 0, 0, 0], _b = [0, 0, 0, 0], _c = [0, 0, 0, 0];
function shapeSample(prims, x, y, z, out) {
  const k = blendOf(prims);
  if (k > 0) {
    primSample(prims[0], x, y, z, _b);
    primSample(prims[1], x, y, z, _c);
    const h = sminWeight(_b[0], _c[0], k);
    out[0] = _c[0] + (_b[0] - _c[0]) * h - k * h * (1 - h);
    for (let i = 1; i < 4; i++) out[i] = _c[i] + (_b[i] - _c[i]) * h;
    const l = Math.hypot(out[1], out[2], out[3]) || 1;
    out[1] /= l;
    out[2] /= l;
    out[3] /= l;
    return;
  }
  out[0] = 1e9;
  for (const p of prims) {
    primSample(p, x, y, z, _b);
    if (_b[0] < out[0]) {
      out[0] = _b[0];
      out[1] = _b[1];
      out[2] = _b[2];
      out[3] = _b[3];
    }
  }
}

function shapeSDF(prims, x, y, z) {
  const k = blendOf(prims);
  if (k > 0) {
    const a = primSDF(prims[0], x, y, z), b = primSDF(prims[1], x, y, z);
    const h = sminWeight(a, b, k);
    return b + (a - b) * h - k * h * (1 - h);
  }
  let d = 1e9;
  for (const p of prims) d = Math.min(d, primSDF(p, x, y, z));
  return d;
}

// A morph between two shapes: their fields mixed.
class Container {
  constructor(name) {
    this.from = SHAPES[name]();
    this.to = this.from;
    this.name = name;
    this.t = 1;
    // A hollow shell's wall thickness: the contents live inside the field offset by it (0: a solid block).
    this.wall = 0;
  }

  // Room for the contents in the target shape: its volume and the largest ball that fits.
  get volume() {
    return estimateVolume(this.to, this.wall);
  }

  get inner() {
    return innerRadius(this.to, this.wall);
  }

  morphTo(name) {
    this.from = this.current();
    this.to = SHAPES[name]();
    this.name = name;
    this.t = 0;
  }

  // The shape at this point of the morph, as primitives when it is settled.
  current() {
    return this.t >= 1 ? this.to : this.from;
  }

  // The inner field (what the contents touch).
  sdf(x, y, z) {
    const b = shapeSDF(this.to, x, y, z);
    if (this.t >= 1) return b + this.wall;
    const a = shapeSDF(this.from, x, y, z);
    const s = this.t * this.t * (3 - 2 * this.t);
    return a + (b - a) * s + this.wall;
  }

  // The field and its gradient at (x, y, z), into out = [d, nx, ny, nz].
  sample(x, y, z, out) {
    shapeSample(this.to, x, y, z, out);
    if (this.t < 1) {
      shapeSample(this.from, x, y, z, _a);
      const s = this.t * this.t * (3 - 2 * this.t);
      for (let i = 0; i < 4; i++) out[i] = _a[i] + (out[i] - _a[i]) * s;
      const l = Math.hypot(out[1], out[2], out[3]) || 1;
      out[1] /= l;
      out[2] /= l;
      out[3] /= l;
    }
    out[0] += this.wall;
    return out;
  }

  // Up to two primitives per shape, for the shader: [type, cx, cy, cz], [bx, by, bz, r].
  uniforms(target) {
    const pack = (prims, i) => {
      const p = prims[Math.min(i, prims.length - 1)];
      return [[p.type, ...p.c], [...p.b, p.r]];
    };
    for (let i = 0; i < 2; i++) {
      const [a0, b0] = pack(this.from, i);
      const [a1, b1] = pack(this.to, i);
      target.from[i * 2].set(...a0);
      target.from[i * 2 + 1].set(...b0);
      target.to[i * 2].set(...a1);
      target.to[i * 2 + 1].set(...b1);
    }
    target.t = this.t * this.t * (3 - 2 * this.t);
    target.blend.set(blendOf(this.from), blendOf(this.to));
  }
}

function estimateVolume(prims, offset = 0, n = 28, R = 1.4) {
  let inside = 0;
  const s = (2 * R) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) if (shapeSDF(prims, -R + (i + 0.5) * s, -R + (j + 0.5) * s, -R + (k + 0.5) * s) + offset < 0) inside++;
  return inside * s * s * s;
}

// The largest ball that fits anywhere inside.
function innerRadius(prims, offset = 0, n = 28, R = 1.4) {
  let best = 0;
  const s = (2 * R) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) best = Math.max(best, -shapeSDF(prims, -R + (i + 0.5) * s, -R + (j + 0.5) * s, -R + (k + 0.5) * s) - offset);
  return best;
}

const containerGLSL = /* glsl */ `
uniform vec4 shapeFrom[4];
uniform vec4 shapeTo[4];
uniform float shapeMix;
uniform vec2 shapeBlend;
float primSDF(vec3 p, vec4 a, vec4 b) {
  p -= a.yzw;
  if (a.x > 0.5) return length(vec2(length(p.xz) - b.x, p.y)) - b.y;
  vec3 q = abs(p) - b.xyz + b.w;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - b.w;
}
// A union, smooth (iq's smin) when k > 0.
float blendSDF(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float containerSDF(vec3 p) {
  float b = blendSDF(primSDF(p, shapeTo[0], shapeTo[1]), primSDF(p, shapeTo[2], shapeTo[3]), shapeBlend.y);
  if (shapeMix >= 1.0) return b;
  float a = blendSDF(primSDF(p, shapeFrom[0], shapeFrom[1]), primSDF(p, shapeFrom[2], shapeFrom[3]), shapeBlend.x);
  return mix(a, b, shapeMix);
}
`;

export { Container, SHAPES, containerGLSL };
