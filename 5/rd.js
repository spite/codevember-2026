import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  BufferAttribute,
  FloatType,
  HalfFloatType,
  UnsignedByteType,
  RGBAFormat,
  RGFormat,
  NearestFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Vector3,
  Data3DTexture,
  RedFormat,
  LinearFilter,
} from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";

// Gray-Scott in an N^3 volume, stored as an atlas of N/8 x 8 tiles of N^2 (one z slice per tile).

const SHAPES = { sphere: 0, egg: 1, pebble: 2, torus: 3, suzanne: 11, gyroid: 4, sheet: 5, schwarz: 6, diamond: 7, neovius: 8, tanglecube: 9, goursat: 10 };
// Depth of the pattern over a solid core on the implicit shapes, so their tubes and sheets keep their volume.
const CORES = { gyroid: 0.08, sheet: 0.07, schwarz: 0.07, diamond: 0.07, neovius: 0.07, tanglecube: 0.1, goursat: 0.1 };
const STRUCTURES = { lattice: 0, coral: 1, sponge: 2, solid: 3 };

const common = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform int N;
uniform int TX;
uniform float extent;
uniform int shape;
uniform int structure;
uniform float wall;
uniform vec3 seedOffset;
// Suzanne's smoothed distance field over the volume (suzanne.bin), [-0.6, 0.6] world units.
uniform sampler3D tSuzanne;

ivec2 texelOf(ivec3 v) {
  v = clamp(v, ivec3(0), ivec3(N - 1));
  return ivec2((v.z % TX) * N + v.x, (v.z / TX) * N + v.y);
}

ivec3 voxelOf(ivec2 t) {
  return ivec3(t.x % N, t.y % N, (t.y / N) * TX + t.x / N);
}

vec3 worldOf(ivec3 v) {
  return ((vec3(v) + 0.5) / float(N) * 2.0 - 1.0) * extent;
}

float hash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float smax(float a, float b, float k) {
  float h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdRoundBox(vec3 p, float b, float r) {
  vec3 q = abs(p) - (b - r);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Implicit shapes, negative inside; not distances until divided by their gradient.
float implicitShape(vec3 p) {
  if (shape == 4) { p *= 2.7; return dot(sin(p), cos(p.yzx)) - 0.3; }
  if (shape == 5) { p *= 3.0; return abs(dot(sin(p), cos(p.yzx))) - 0.75; }
  if (shape == 6) { p *= 5.2; return -(cos(p.x) + cos(p.y) + cos(p.z)) - 0.5; }
  if (shape == 7) {
    p *= 3.4;
    vec3 s = sin(p), c = cos(p);
    return abs(s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z) - 0.95;
  }
  if (shape == 8) { p *= 4.6; vec3 c = cos(p); return -(3.0 * (c.x + c.y + c.z) + 4.0 * c.x * c.y * c.z) - 1.5; }
  if (shape == 9) { p *= 3.1; vec3 q = p * p; return dot(q * q - 5.0 * q, vec3(1)) + 11.8; }
  p *= 2.5;
  float r2 = dot(p, p);
  vec3 q = p * p;
  return (dot(q, q) - 2.0 * r2 + 1.5) / 8.0;
}

float implicitDistance(vec3 p) {
  const vec2 e = vec2(0.004, 0.0);
  float f = implicitShape(p);
  vec3 g = vec3(implicitShape(p + e.xyy) - implicitShape(p - e.xyy), implicitShape(p + e.yxy) - implicitShape(p - e.yxy), implicitShape(p + e.yyx) - implicitShape(p - e.yyx)) / (2.0 * e.x);
  return f / max(length(g), 0.5);
}

// Outer surface of the object, in world units, negative inside.
float shapeSDF(vec3 p) {
  if (shape == 0) return length(p) - 1.0;
  if (shape == 1) {
    vec3 q = p;
    q.xz *= 1.0 - 0.14 * q.y;
    return sdEllipsoid(q, vec3(0.86, 1.08, 0.86));
  }
  if (shape == 2) {
    float n = vnoise(p * 1.3 + seedOffset) - 0.5;
    return sdEllipsoid(p, vec3(1.0, 0.6, 0.84)) + 0.12 * n;
  }
  if (shape == 3) {
    vec2 q = vec2(length(p.xz) - 0.7, p.y);
    return length(q) - 0.36;
  }
  if (shape == 11) return texture(tSuzanne, p / (2.0 * extent) + 0.5).r * 1.2 - 0.6;
  float d = implicitDistance(p);
  if (shape == 6 || shape == 8) return smax(d, sdRoundBox(p, 0.82, 0.12), 0.06);
  if (shape >= 9) return smax(d, length(p) - 1.05, 0.06);
  return smax(d, length(p) - 1.0, 0.08);
}

// Where the reaction runs: lattice keeps it in a skin under the surface, the rest fill the body.
bool alive(float s) { return s < 0.0 && ((structure != 0 && structure != 3) || s > -wall); }
`;

const initFragment = /* glsl */ `
${common}
uniform float seedDensity;
uniform float seedFreq;
layout(location = 0) out vec4 outColor;
void main() {
  ivec3 v = voxelOf(ivec2(gl_FragCoord.xy));
  vec3 p = worldOf(v);
  float s = shapeSDF(p);
  float n = vnoise(p * seedFreq + seedOffset) * 0.7 + vnoise(p * seedFreq * 2.2 + seedOffset.zxy) * 0.3;
  if (!alive(s)) { outColor = vec4(-1.0, 0.0, 0.0, 1.0); return; }
  float V = n > 1.0 - seedDensity ? 0.5 : 0.0;
  outColor = vec4(V > 0.0 ? 0.5 : 1.0, V, 0.0, 1.0);
}
`;

// Slow noise that varies feed and kill across the body.
const paramFragment = /* glsl */ `
${common}
layout(location = 0) out vec4 outColor;
void main() {
  vec3 p = worldOf(voxelOf(ivec2(gl_FragCoord.xy)));
  outColor = vec4(vnoise(p * 1.7 + seedOffset.yzx), 0.0, 0.0, 1.0);
}
`;

const stepFragment = /* glsl */ `
${common}
uniform sampler2D tState;
uniform sampler2D tParam;
uniform float feed;
uniform float kill;
uniform float Du;
uniform float Dv;
uniform float variation;
uniform float dt;
layout(location = 0) out vec4 outColor;

// Zero flux at the edge of the live region (U < 0 outside), so the pattern meets the surface instead of lining it.
vec2 at(ivec3 v, vec2 c) {
  vec2 t = texelFetch(tState, texelOf(v), 0).xy;
  return t.x < 0.0 ? c : t;
}

void main() {
  ivec3 v = voxelOf(ivec2(gl_FragCoord.xy));
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(tState, tc, 0).xy;
  if (c.x < 0.0) { outColor = vec4(c, 0.0, 1.0); return; }
  // Isotropic 19-point Laplacian; the 7-point one turns patterns blocky on coarse grids.
  vec2 faces = at(v + ivec3(1, 0, 0), c) + at(v - ivec3(1, 0, 0), c)
             + at(v + ivec3(0, 1, 0), c) + at(v - ivec3(0, 1, 0), c)
             + at(v + ivec3(0, 0, 1), c) + at(v - ivec3(0, 0, 1), c);
  vec2 edges = at(v + ivec3(1, 1, 0), c) + at(v + ivec3(1, -1, 0), c) + at(v + ivec3(-1, 1, 0), c) + at(v + ivec3(-1, -1, 0), c)
             + at(v + ivec3(1, 0, 1), c) + at(v + ivec3(1, 0, -1), c) + at(v + ivec3(-1, 0, 1), c) + at(v + ivec3(-1, 0, -1), c)
             + at(v + ivec3(0, 1, 1), c) + at(v + ivec3(0, 1, -1), c) + at(v + ivec3(0, -1, 1), c) + at(v + ivec3(0, -1, -1), c);
  vec2 lap = (2.0 * faces + edges - 24.0 * c) / 6.0;
  float w = (texelFetch(tParam, tc, 0).x - 0.5) * variation;
  float F = feed * (1.0 + w);
  float k = kill * (1.0 - 0.03 * w);
  float uvv = c.x * c.y * c.y;
  float U = c.x + dt * (Du * lap.x - uvv + F * (1.0 - c.x));
  float V = c.y + dt * (Dv * lap.y + uvv - (F + k) * c.y);
  outColor = vec4(clamp(U, 0.0, 1.0), clamp(V, 0.0, 1.0), 0.0, 1.0);
}
`;

// Final signed field in voxel units (negative = solid), 16 bits over RG.
const packFragment = /* glsl */ `
${common}
uniform sampler2D tState;
uniform int SN;
uniform int STX;
uniform int blur;
uniform float iso;
uniform float gain;
uniform float invert;
uniform float range;
uniform float core;
uniform float erosion;
layout(location = 0) out vec4 outColor;

// V from the reaction grid (SN^3, possibly coarser than this one), trilinear at a voxel of this grid.
float stateV(ivec3 s) {
  s = clamp(s, ivec3(0), ivec3(SN - 1));
  return texelFetch(tState, ivec2((s.z % STX) * SN + s.x, (s.z / STX) * SN + s.y), 0).y;
}

float sampleV(ivec3 v) {
  vec3 c = (vec3(v) + 0.5) * float(SN) / float(N) - 0.5;
  ivec3 i = ivec3(floor(c));
  vec3 f = c - vec3(i);
  return mix(
    mix(mix(stateV(i), stateV(i + ivec3(1, 0, 0)), f.x), mix(stateV(i + ivec3(0, 1, 0)), stateV(i + ivec3(1, 1, 0)), f.x), f.y),
    mix(mix(stateV(i + ivec3(0, 0, 1)), stateV(i + ivec3(1, 0, 1)), f.x), mix(stateV(i + ivec3(0, 1, 1)), stateV(i + ivec3(1, 1, 1)), f.x), f.y),
    f.z);
}

void main() {
  ivec3 v = voxelOf(ivec2(gl_FragCoord.xy));
  float V = 0.0, wsum = 0.0;
  // A coarser output grid already smooths as much as the blur does at full size.
  int r = blur;
  for (int z = -r; z <= r; z++)
  for (int y = -r; y <= r; y++)
  for (int x = -r; x <= r; x++) {
    float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0) * (z == 0 ? 2.0 : 1.0);
    V += (SN == N ? stateV(v + ivec3(x, y, z)) : sampleV(v + ivec3(x, y, z))) * w;
    wsum += w;
  }
  V /= wsum;
  vec3 p = worldOf(v);
  float voxel = 2.0 * extent / float(N);
  float s = shapeSDF(p) / voxel;
  float rd = (iso - V) * gain * mix(1.0, -1.0, invert);
  float d;
  if (structure == 0) d = smax(smax(rd, s, 1.5), -s - wall / voxel, 1.5);
  // Solid: the pattern only carves grooves erosion deep (world units); below them the body stays whole.
  else if (structure == 3) d = smax(s, smin(rd, s + erosion / voxel, 1.5), 1.5);
  else d = smax(rd, s, 1.5);
  if (structure == 1) d = smin(d, s + wall / voxel, 2.0);
  if (core > 0.0) d = smin(d, s + core / voxel, 1.5);
  // Keep the border of the box empty so the surface always closes.
  vec3 b = abs(vec3(v) + 0.5 - float(N) * 0.5) - (float(N) * 0.5 - 1.5);
  d = max(d, max(b.x, max(b.y, b.z)));
  float e = clamp(d / range * 0.5 + 0.5, 0.0, 1.0) * 65535.0;
  float hi = floor(e / 256.0);
  outColor = vec4(hi / 255.0, (e - hi * 256.0) / 255.0, 0.0, 1.0);
}
`;

function quad(fragmentShader, uniforms) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

function target(w, h, type, format = RGBAFormat) {
  return new WebGLRenderTarget(w, h, {
    type,
    format,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

class ReactionDiffusion {
  constructor(renderer, N = 128) {
    this.renderer = renderer;
    this.N = N;
    this.TX = N / 8;
    this.width = this.TX * N;
    this.height = 8 * N;
    const float = renderer.extensions.has("EXT_color_buffer_float");
    if (!float && !renderer.extensions.has("EXT_color_buffer_half_float")) console.warn("Reaction-diffusion: no renderable float target");
    this.stateType = float ? FloatType : HalfFloatType;
    this.out = target(this.width, this.height, UnsignedByteType);
    this.simN = 0;

    // Shared uniforms describe the reaction grid; the pack pass writes the full grid.
    this.uniforms = {
      N: { value: N },
      TX: { value: this.TX },
      extent: { value: 1.12 },
      shape: { value: 0 },
      structure: { value: 0 },
      wall: { value: 0.3 },
      seedOffset: { value: new Vector3() },
      tSuzanne: { value: null },
    };
    // Suzanne's field, loaded alongside; build after ready.
    this.ready = fetch(new URL("./suzanne.bin", import.meta.url))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const n = Math.round(Math.cbrt(buf.byteLength));
        const tex = new Data3DTexture(new Uint8Array(buf), n, n, n);
        tex.format = RedFormat;
        tex.type = UnsignedByteType;
        tex.minFilter = tex.magFilter = LinearFilter;
        tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        this.uniforms.tSuzanne.value = tex;
      })
      .catch((e) => console.warn("Suzanne field:", e));
    const u = this.uniforms;
    this.init = quad(initFragment, { ...u, seedDensity: { value: 0.12 }, seedFreq: { value: 14 } });
    this.paramPass = quad(paramFragment, u);
    this.step = quad(stepFragment, { ...u, tState: { value: null }, tParam: { value: null }, feed: { value: 0.03 }, kill: { value: 0.06 }, Du: { value: 0.16 }, Dv: { value: 0.08 }, variation: { value: 0.1 }, dt: { value: 1 } });
    this.pack = quad(packFragment, { ...u, N: { value: N }, TX: { value: this.TX }, SN: u.N, STX: u.TX, tState: { value: null }, iso: { value: 0.2 }, gain: { value: 14 }, invert: { value: 0 }, range: { value: 8 }, core: { value: 0 }, erosion: { value: 0.05 }, blur: { value: 1 } });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new Mesh(geometry, this.init);
    this.mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.mesh);
    this.camera = new OrthographicCamera();
    this._resizeSim(N);
  }

  // The reaction grid, a multiple of 8 so the atlas tiles evenly.
  _resizeSim(n) {
    if (n === this.simN) return;
    this.ping?.dispose();
    this.pong?.dispose();
    this.param?.dispose();
    this.simN = n;
    const w = (n / 8) * n, h = 8 * n;
    this.ping = target(w, h, this.stateType, RGFormat);
    this.pong = target(w, h, this.stateType, RGFormat);
    this.param = target(w, h, UnsignedByteType);
    this.uniforms.N.value = n;
    this.uniforms.TX.value = n / 8;
    this.step.uniforms.tParam.value = this.param.texture;
  }

  _draw(material, rt) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.autoClear = false;
    this.mesh.material = material;
    r.setRenderTarget(rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = autoClear;
  }

  // opts: shape, structure, wall, core, erosion, feed, kill, scale, size, variation, seed (vec3), seedDensity, iso, invert, dt
  // size > 1 runs the reaction on a coarser grid, so the pattern comes out that much bigger.
  reset(opts) {
    const size = Math.max(1, opts.size ?? 1);
    this._resizeSim(Math.max(32, Math.round(this.N / size / 8) * 8));
    const u = this.uniforms;
    u.shape.value = SHAPES[opts.shape] ?? 0;
    u.structure.value = STRUCTURES[opts.structure] ?? 0;
    u.wall.value = opts.wall;
    u.seedOffset.value.copy(opts.seed);
    this.init.uniforms.seedDensity.value = opts.seedDensity ?? 0.3;
    this.init.uniforms.seedFreq.value = 14 / size;
    const s = this.step.uniforms;
    s.feed.value = opts.feed;
    s.kill.value = opts.kill;
    // Diffusion is per voxel, so the grid scales it: the pattern is the same in world units at size 1.
    const d = ((this.simN * size) / 128) ** 2;
    s.Du.value = 0.16 * opts.scale * d;
    s.Dv.value = 0.08 * opts.scale * d;
    s.dt.value = opts.dt ?? 1;
    s.variation.value = opts.variation;
    this.pack.uniforms.iso.value = opts.iso ?? 0.2;
    this.pack.uniforms.invert.value = opts.invert ? 1 : 0;
    this.pack.uniforms.core.value = opts.core ?? 0;
    this.pack.uniforms.erosion.value = opts.erosion ?? 0.05;
    // V falls off over more voxels of the full grid when the pattern is bigger.
    this.pack.uniforms.gain.value = 14 / ((this.N / this.simN) * 0.5 + 0.5);
    this._draw(this.init, this.ping);
    this._draw(this.paramPass, this.param);
    this.steps = 0;
  }

  run(count) {
    const s = this.step.uniforms;
    for (let i = 0; i < count; i++) {
      s.tState.value = this.ping.texture;
      this._draw(this.step, this.pong);
      [this.ping, this.pong] = [this.pong, this.ping];
    }
    this.steps += count;
  }

  // Returns the signed field (voxel units, negative inside) as a Float32Array of n^3; n < N for quick previews.
  async read(n = this.N) {
    const pu = this.pack.uniforms;
    const TX = n / 8, width = TX * n, height = 8 * n;
    this.outs ??= new Map([[this.N, this.out]]);
    if (!this.outs.has(n)) this.outs.set(n, target(width, height, UnsignedByteType));
    const out = this.outs.get(n);
    const gain = pu.gain.value;
    pu.N.value = n;
    pu.TX.value = TX;
    // Distances are in voxels of the grid being written.
    pu.gain.value = gain * (n / this.N);
    pu.blur.value = n === this.N ? 1 : 0;
    pu.tState.value = this.ping.texture;
    this._draw(this.pack, out);
    pu.N.value = this.N;
    pu.TX.value = this.TX;
    pu.gain.value = gain;
    const buf = new Uint8Array(width * height * 4);
    await this.renderer.readRenderTargetPixelsAsync(out, 0, 0, width, height, buf);
    const range = pu.range.value;
    const field = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++) {
      const ox = (z % TX) * n, oy = Math.floor(z / TX) * n;
      for (let y = 0; y < n; y++) {
        let t = ((oy + y) * width + ox) * 4;
        let i = n * (y + n * z);
        for (let x = 0; x < n; x++, t += 4, i++) field[i] = ((buf[t] * 256 + buf[t + 1]) / 65535 * 2 - 1) * range;
      }
    }
    return field;
  }

  get extent() {
    return this.uniforms.extent.value;
  }

  dispose() {
    this.ping.dispose();
    this.pong.dispose();
    for (const t of this.outs?.values() ?? [this.out]) t.dispose();
    this.param.dispose();
    this.paramPass.dispose();
    this.init.dispose();
    this.step.dispose();
    this.pack.dispose();
  }
}

export { ReactionDiffusion, SHAPES, STRUCTURES, CORES };
