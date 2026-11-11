// The acid's fumes: a smoke simulation (stable fluids) in a box around and above the piece, while it bites. The grid's
// slices are tiled in a 2D atlas, so each pass is one full-screen draw: advection with buoyancy and the vapour given
// off where the acid bites, vorticity confinement, then a pressure solve that makes the flow divergence free around
// the piece, a moving obstacle whose surface drags the air with it as it turns. Drawn over the lit image (main.js
// hooks it in): marched at half resolution up to the scene depth, with a fine noise carried by the flow for the wisps
// finer than the grid, lit by the key light with a short shadow march and by the studio's ambient, folded into the
// last frames, then laid over the image full size with a depth-aware upsample. Nothing runs while the acid is off.
import {
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  WebGLRenderTarget,
  HalfFloatType,
  RGBAFormat,
  RGFormat,
  RedFormat,
  DataUtils,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  NoColorSpace,
  Data3DTexture,
  UnsignedByteType,
  Matrix3,
  Matrix4,
  Quaternion,
  Color,
  Vector2,
  Vector3,
} from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { nativeRandom } from "modules/random.js";

const NOISE = 48;
// The grid: 48 x 64 x 48 cells, z slices tiled 8 x 6 in a 384 x 384 atlas. In units of the piece's radius it spans
// [-1.8, 1.8] across and [-1.3, 3.5] up, so cells are cubes 0.075 on a side.
const G = { nx: 48, ny: 64, nz: 48, tx: 8, ty: 6 };
const CELL = 0.075;
const LO = new Vector3(-1.8, -1.3, -1.8);
// Steps of the clock's own advance, but no shorter than MIN_STEP (fast displays step every other frame) nor longer
// than MAX_STEP (a long frame takes up to three).
const MIN_STEP = 1 / 75;
const MAX_STEP = 1 / 30;
// How long a reset takes to fade the vapour out.
const FADE = 0.6;
const JACOBI = 18;

const vertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Shared by the passes and the march: cells <-> atlas texels, trilinear lookups, and the piece as an ellipsoid.
const gridChunk = /* glsl */ `
#define NX ${G.nx}
#define NY ${G.ny}
#define NZ ${G.nz}
#define TX ${G.tx}
#define TY ${G.ty}
const vec3 GRID = vec3(NX, NY, NZ);
const float H = ${CELL.toFixed(4)};
const vec3 LO = vec3(${LO.x.toFixed(3)}, ${LO.y.toFixed(3)}, ${LO.z.toFixed(3)});
// The piece: its bounds as an ellipsoid at objCenter with half axes objHalf in its own frame (objRot turns world to
// piece), turning at omega about the grid's origin. All in units of the piece's radius.
uniform vec3 objCenter;
uniform vec3 objHalf;
uniform mat3 objRot;
uniform vec3 omega;
// Where the piece is off the grid's centre, and how fast it moves (its shake), in the same units.
uniform vec3 pieceOff;
uniform vec3 linVel;

ivec2 atlasPx(ivec3 c) {
  return ivec2(c.x + (c.z % TX) * NX, c.y + (c.z / TX) * NY);
}
ivec3 cellOf(ivec2 px) {
  int tx = px.x / NX, ty = px.y / NY;
  return ivec3(px.x - tx * NX, px.y - ty * NY, tx + ty * TX);
}
bool inGrid(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(NX, NY, NZ)));
}
ivec2 clampedPx(ivec3 c) {
  return atlasPx(clamp(c, ivec3(0), ivec3(NX - 1, NY - 1, NZ - 1)));
}
// g in cells (centres at i + 0.5); hardware bilinear within a slice, blended across two.
vec4 sampleGrid(sampler2D t, vec3 g) {
  g = clamp(g, vec3(0.5), GRID - 0.5);
  float z = g.z - 0.5;
  int z0 = int(floor(z));
  int z1 = min(z0 + 1, NZ - 1);
  vec2 inv = 1.0 / vec2(NX * TX, NY * TY);
  vec4 a = texture(t, (g.xy + vec2((z0 % TX) * NX, (z0 / TX) * NY)) * inv);
  vec4 b = texture(t, (g.xy + vec2((z1 % TX) * NX, (z1 / TX) * NY)) * inv);
  return mix(a, b, z - float(z0));
}
vec3 cellPos(ivec3 c) {
  return LO + (vec3(c) + 0.5) * H;
}
// Signed distance to the ellipsoid (iq's bound).
float sdEllipsoid(vec3 p) {
  vec3 q = objRot * (p - objCenter);
  float k0 = length(q / objHalf), k1 = length(q / (objHalf * objHalf));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
`;

const passHeader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 fragColor;
${gridChunk}
`;

// Where the piece is this step: its velocity (xyz) and signed distance (w) at each cell. The distance comes from the
// blank's own field baked in its frame when there is one, else from its bounds' ellipsoid.
const obstacleShader = /* glsl */ `
${passHeader}
uniform sampler3D tShape;
uniform float useShape;
uniform vec3 shapeLo;
uniform vec3 shapeSize;
uniform float shapeScale;
void main() {
  vec3 p = cellPos(cellOf(ivec2(gl_FragCoord.xy)));
  float sd = sdEllipsoid(p);
  if (useShape > 0.5) {
    vec3 uvw = (objRot * (p - pieceOff) - shapeLo) / shapeSize;
    if (all(greaterThan(uvw, vec3(0.0))) && all(lessThan(uvw, vec3(1.0)))) sd = texture(tShape, uvw).r * shapeScale;
    else sd = max(sd, H);
  }
  fragColor = vec4(cross(omega, p - pieceOff) + linVel, sd);
}
`;

// Semi-Lagrangian advection of velocity and vapour: the value where each cell's air came from.
const advectShader = /* glsl */ `
${passHeader}
uniform sampler2D tState;
uniform float dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(tState, px, 0);
  vec3 g = vec3(cellOf(px)) + 0.5 - dt * s.xyz / H;
  vec4 a = sampleGrid(tState, g);
  // Clean, still air comes in from outside.
  float outside = max(max(-g.x, g.x - GRID.x), max(max(-g.y, g.y - GRID.y), max(-g.z, g.z - GRID.z)));
  fragColor = a * (1.0 - smoothstep(0.0, 1.0, outside));
}
`;

// The vapour sharpened by a MacCormack correction (traced back forward to estimate the error, clamped to the cells it
// came from), then buoyancy, the piece's drag on the air next to it, and the vapour given off where the acid bites
// (spots on the piece's surface, so they turn with it).
const forcesShader = /* glsl */ `
${passHeader}
uniform sampler2D tState;
uniform sampler2D tAdvected;
uniform sampler2D tSolid;
uniform sampler3D tNoise;
uniform float dt;
uniform float time;
uniform float emission;
uniform float acidLine;
uniform float objUnit;
uniform float dissipation;
uniform float buoyancy;
uniform float drag;
uniform float stir;
vec4 nz(vec3 q) { return texture(tNoise, q * (4.0 / ${NOISE}.0)); }
float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// The acid's cover at o (object space), as relief.js draws it: 0..1 spreading, 1..2 rinsing off; the finest octave is
// left at its mean, below the grid's resolution.
float acidWet(vec3 o) {
  if (acidLine < -1e2) return 0.0;
  bool draining = acidLine > 1.0;
  float cov = draining ? 2.0 - acidLine : acidLine;
  float field = draining ? 0.55 * vnoise(o * 4.0 + 29.0) + 0.3 * vnoise(o * 13.0) + 0.075 - 0.3 * 0.5 + 0.15
                         : 0.65 * vnoise(o * 1.7 + 11.0) + 0.35 * vnoise(o * 6.0 + 3.0);
  return smoothstep(-0.08, 0.08, cov * 1.3 - 0.15 - field);
}
float sdAt(ivec3 c) { return texelFetch(tSolid, clampedPx(c), 0).w; }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec3 p = cellPos(c);
  vec4 solid = texelFetch(tSolid, px, 0);
  float sd = solid.w;
  vec3 vs = solid.xyz;
  if (sd < 0.0) {
    fragColor = vec4(vs, 0.0);
    return;
  }
  vec4 s = texelFetch(tState, px, 0);
  vec4 a = texelFetch(tAdvected, px, 0);
  vec3 g = vec3(c) + 0.5;
  vec3 back = g - dt * s.xyz / H;
  float d = a.w;
  if (all(greaterThan(back, vec3(0.5))) && all(lessThan(back, GRID - 0.5))) {
    float err = s.w - sampleGrid(tAdvected, g + dt * s.xyz / H).w;
    ivec3 b0 = ivec3(floor(back - 0.5));
    float lo = 1e9, hi = -1e9;
    for (int k = 0; k < 8; k++) {
      float w = texelFetch(tState, clampedPx(b0 + ivec3(k & 1, (k >> 1) & 1, k >> 2)), 0).w;
      lo = min(lo, w);
      hi = max(hi, w);
    }
    d = clamp(d + 0.5 * err, lo, hi);
  }
  vec3 v = a.xyz * exp(-dt * 0.15);
  d = max(d, 0.0) * exp(-dt * dissipation);
  v.y += dt * buoyancy * d / (1.0 + 0.6 * d);
  // The room's air is never quite still: a slow wandering draught, felt where there is vapour.
  v += dt * stir * min(d * 3.0, 1.0) * (nz(p * 0.35 + vec3(0.0, -time * 0.25, time * 0.05)).xyz - 0.5);
  // The air touching the piece goes with its surface.
  float shell = 1.0 - smoothstep(0.0, 2.5 * H, sd);
  v = mix(v, vs, shell * (1.0 - exp(-dt * drag)));
  // Vapour off the wet surface, from spots fixed on the piece that come and go.
  float src = 1.0 - smoothstep(H * 0.5, H * 2.5, sd);
  if (src > 0.0 && emission > 0.0) {
    vec3 q = objRot * (p - pieceOff);
    float spot = nz(q * 1.6 + vec3(31.0, 31.0 + time * 0.3, 31.0)).w;
    float pattern = 0.05 + smoothstep(0.45, 0.75, spot) * 1.6;
    vec3 n = normalize(vec3(sdAt(c + ivec3(1, 0, 0)) - sdAt(c - ivec3(1, 0, 0)), sdAt(c + ivec3(0, 1, 0)) - sdAt(c - ivec3(0, 1, 0)),
      sdAt(c + ivec3(0, 0, 1)) - sdAt(c - ivec3(0, 0, 1))) + 1e-6);
    // Most of it off the upper side: what leaves the underside clings to the surface and climbs it.
    pattern *= 0.08 + 0.92 * smoothstep(-0.2, 0.7, n.y);
    float wet = acidWet(q * objUnit);
    float e = emission * pattern * wet * src;
    d += dt * e;
    // Boiling off the surface: a little push outward and a stir.
    vec3 jitter = nz(q * 4.0 + time * vec3(0.7, 1.3, 0.9)).xyz - 0.5;
    v += dt * e * (n * 0.25 + jitter * 1.2);
  }
  fragColor = vec4(v, d);
}
`;

// The flow's curl (xyz) and its length (w).
const curlShader = /* glsl */ `
${passHeader}
uniform sampler2D tState;
vec3 vel(ivec3 c) {
  return texelFetch(tState, clampedPx(c), 0).xyz;
}
void main() {
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy));
  vec3 l = vel(c - ivec3(1, 0, 0)), r = vel(c + ivec3(1, 0, 0));
  vec3 b = vel(c - ivec3(0, 1, 0)), t = vel(c + ivec3(0, 1, 0));
  vec3 k = vel(c - ivec3(0, 0, 1)), f = vel(c + ivec3(0, 0, 1));
  vec3 w = vec3((t.z - b.z) - (f.y - k.y), (f.x - k.x) - (r.z - l.z), (r.y - l.y) - (t.x - b.x)) * (0.5 / H);
  fragColor = vec4(w, length(w));
}
`;

// Vorticity confinement: puts back the swirl the coarse grid smears out.
const confineShader = /* glsl */ `
${passHeader}
uniform sampler2D tState;
uniform sampler2D tCurl;
uniform float dt;
uniform float vorticity;
float mag(ivec3 c) {
  return texelFetch(tCurl, clampedPx(c), 0).w;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec4 s = texelFetch(tState, px, 0);
  vec3 eta = vec3(mag(c + ivec3(1, 0, 0)) - mag(c - ivec3(1, 0, 0)), mag(c + ivec3(0, 1, 0)) - mag(c - ivec3(0, 1, 0)),
    mag(c + ivec3(0, 0, 1)) - mag(c - ivec3(0, 0, 1)));
  float l = length(eta);
  if (l > 1e-5) {
    vec3 w = texelFetch(tCurl, px, 0).xyz;
    // Stronger where there is vapour to show it.
    s.xyz += dt * vorticity * H * (0.3 + 0.7 * min(s.w * 2.0, 1.0)) * cross(eta / l, w);
  }
  fragColor = s;
}
`;

// Divergence (r) and whether the cell is solid (g). Neighbours inside the piece move with its surface; outside the
// box the velocity carries on as it is.
const divergenceShader = /* glsl */ `
${passHeader}
uniform sampler2D tState;
uniform sampler2D tSolid;
vec3 vel(ivec3 c, vec3 v0) {
  if (!inGrid(c)) return v0;
  ivec2 px = atlasPx(c);
  vec4 solid = texelFetch(tSolid, px, 0);
  return solid.w < 0.0 ? solid.xyz : texelFetch(tState, px, 0).xyz;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec3 v0 = texelFetch(tState, px, 0).xyz;
  float d = vel(c + ivec3(1, 0, 0), v0).x - vel(c - ivec3(1, 0, 0), v0).x + vel(c + ivec3(0, 1, 0), v0).y
    - vel(c - ivec3(0, 1, 0), v0).y + vel(c + ivec3(0, 0, 1), v0).z - vel(c - ivec3(0, 0, 1), v0).z;
  fragColor = vec4(0.5 * d / H, texelFetch(tSolid, px, 0).w < 0.0 ? 1.0 : 0.0, 0.0, 0.0);
}
`;

// Pressure (r) carries the solid flag (g) along, so a neighbour's both come in one fetch: zero outside the box
// (open), mirrored at the piece (no flow through it).
const pressureChunk = /* glsl */ `
uniform sampler2D tPressure;
float pr(ivec3 c, float p0) {
  if (!inGrid(c)) return 0.0;
  vec2 v = texelFetch(tPressure, atlasPx(c), 0).rg;
  return v.g > 0.5 ? p0 : v.r;
}
`;

const jacobiShader = /* glsl */ `
${passHeader}
${pressureChunk}
uniform sampler2D tDivergence;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  float p0 = texelFetch(tPressure, px, 0).r;
  vec2 div = texelFetch(tDivergence, px, 0).rg;
  float s = pr(c + ivec3(1, 0, 0), p0) + pr(c - ivec3(1, 0, 0), p0) + pr(c + ivec3(0, 1, 0), p0) + pr(c - ivec3(0, 1, 0), p0)
    + pr(c + ivec3(0, 0, 1), p0) + pr(c - ivec3(0, 0, 1), p0);
  fragColor = vec4((s - H * H * div.r) / 6.0, div.g, 0.0, 0.0);
}
`;

const projectShader = /* glsl */ `
${passHeader}
${pressureChunk}
uniform sampler2D tState;
uniform sampler2D tSolid;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec4 s = texelFetch(tState, px, 0);
  vec4 solid = texelFetch(tSolid, px, 0);
  if (solid.w < 0.0) {
    fragColor = vec4(solid.xyz, 0.0);
    return;
  }
  float p0 = texelFetch(tPressure, px, 0).r;
  vec3 grad = vec3(pr(c + ivec3(1, 0, 0), p0) - pr(c - ivec3(1, 0, 0), p0), pr(c + ivec3(0, 1, 0), p0) - pr(c - ivec3(0, 1, 0), p0),
    pr(c + ivec3(0, 0, 1), p0) - pr(c - ivec3(0, 0, 1), p0)) * (0.5 / H);
  fragColor = vec4(s.xyz - grad, s.w);
}
`;

const marchShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
#define NOISE ${NOISE}
${gridChunk}
uniform sampler2D tDepth;
uniform sampler2D tState;
uniform sampler3D tNoise;
uniform mat4 inverseViewProjection;
uniform vec3 cameraPos;
uniform vec3 center;
uniform float radius;
uniform float time;
uniform float density;
uniform float frame;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform vec3 shIrradiance[9];
uniform vec3 extinction;
uniform vec3 albedo;
uniform vec2 fullSize;
uniform int scale;
out vec4 fragColor;

vec3 sh(vec3 n) {
  return shIrradiance[0] * 0.282095 + shIrradiance[1] * (0.488603 * n.y) + shIrradiance[2] * (0.488603 * n.z)
    + shIrradiance[3] * (0.488603 * n.x) + shIrradiance[4] * (1.092548 * n.x * n.y) + shIrradiance[5] * (1.092548 * n.y * n.z)
    + shIrradiance[6] * (0.315392 * (3.0 * n.z * n.z - 1.0)) + shIrradiance[7] * (1.092548 * n.x * n.z)
    + shIrradiance[8] * (0.546274 * (n.x * n.x - n.y * n.y));
}

vec4 nz(vec3 q) { return texture(tNoise, q * (4.0 / float(NOISE))); }

// Thin curling sheets of a warped noise.
float sheets(vec3 p) {
  vec3 q = p * 3.0;
  q += (nz(q * 0.5 + 13.0).xyz - 0.5) * 1.8;
  float n = nz(q).x + 0.22 * (nz(q * 2.6 + 5.0).y - 0.5);
  float s = smoothstep(0.6, 1.0, 1.0 - abs(2.0 * n - 1.0));
  return s * s;
}

// The fine detail rises with the vapour and is pushed about by the simulated flow, so it bends with the eddies.
float detail(vec3 p, vec3 v) {
  return sheets(p - v * 0.3 - vec3(0.0, time * 0.45, 0.0));
}

// Fades out near the box's walls, so it never shows.
float walls(vec3 g) {
  vec3 e = min(g, GRID - g);
  return smoothstep(0.5, 4.0, min(min(e.x, e.z), e.y));
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

void main() {
  ivec2 full = ivec2(gl_FragCoord.xy) * scale;
  vec2 uv = (vec2(full) + 0.5) / fullSize;
  float depth = texelFetch(tDepth, full, 0).r;
  vec4 far = inverseViewProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - cameraPos);
  float tScene = 1e9;
  if (depth < 1.0) {
    vec4 wp = inverseViewProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    tScene = length(wp.xyz / wp.w - cameraPos);
  }
  // In the piece's units, clipped to the grid.
  vec3 ro = (cameraPos - center) / radius;
  vec3 lo = LO, hi = LO + GRID * H;
  vec3 inv = 1.0 / dir;
  vec3 t0 = (lo - ro) * inv, t1 = (hi - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float ta = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  float tb = min(min(min(tmax.x, tmax.y), tmax.z), tScene / radius);
  if (tb <= ta) {
    fragColor = vec4(0.0);
    return;
  }
  const int STEPS = 56;
  float dt = max((tb - ta) / float(STEPS), 0.05);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * mod(frame, 64.0), vec2(0.06711056, 0.00583715))));
  float t = ta + dt * jitter;
  float cosv = dot(dir, lightDirection);
  float phase = mix(hg(cosv, 0.4), hg(cosv, -0.1), 0.3) * 3.14159;
  vec3 amb = (0.6 * sh(vec3(0.0, 1.0, 0.0)) + 0.4 * sh(-dir)) / 3.14159;
  vec3 sun = lightColor * phase;
  vec3 ls = objRot * lightDirection / objHalf;
  float tau = 0.0;
  vec3 scatter = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    if (t > tb) break;
    vec3 p = ro + dir * t;
    vec3 g = (p - LO) / H;
    vec4 s = sampleGrid(tState, g);
    float d0 = s.w * walls(g);
    if (d0 > 2e-3) {
      // Faded out close to the lens, so a close-up looks past the vapour rather than into it.
      float d = d0 * (0.03 + 3.0 * detail(p, s.xyz)) * density * smoothstep(0.3, 1.1, t);
      // Toward the light: a short march for the vapour's own shadow, and the piece in the way.
      float ts = 0.0;
      for (int k = 1; k <= 3; k++) ts += sampleGrid(tState, g + lightDirection * (0.12 * float(k * k) / H)).w;
      vec3 o = objRot * (p - objCenter) / objHalf;
      float b = -dot(o, ls) / dot(ls, ls);
      float lit = b < 0.0 ? 1.0 : smoothstep(0.8, 1.08, length(o + ls * b));
      vec3 T = exp(-tau * extinction);
      vec3 Ts = exp(-ts * density * 0.35 * extinction);
      vec3 S = albedo * (sun * Ts * lit + amb * (0.55 + 0.45 * Ts));
      float a = d * dt;
      scatter += T * S * (1.0 - exp(-a * extinction));
      tau += a;
      if (tau > 6.0) break;
    }
    t += dt;
  }
  fragColor = vec4(scatter, tau);
}
`;

// Folds this frame's march into the last ones, the history clamped to the neighbourhood's range so it can't ghost.
const resolveShader = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform float blend;
out vec4 fragColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(tCurrent, 0);
  vec4 lo = vec4(1e9), hi = vec4(-1e9), c = texelFetch(tCurrent, px, 0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec4 v = texelFetch(tCurrent, clamp(px + ivec2(i, j), ivec2(0), size - 1), 0);
    lo = min(lo, v);
    hi = max(hi, v);
  }
  vec4 h = clamp(texelFetch(tHistory, px, 0), lo, hi);
  fragColor = mix(h, c, blend);
}
`;

const compositeShader = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tVapour;
uniform sampler2D tDepth;
uniform vec3 extinction;
uniform float cameraNear;
uniform float cameraFar;
uniform int scale;
out vec4 fragColor;

float linear(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 base = texelFetch(tScene, px, 0);
  float z = linear(texelFetch(tDepth, px, 0).r);
  ivec2 hs = textureSize(tVapour, 0);
  // A 3x3 tent over the half-res texels, weighted by depth so the vapour stays on its side of an edge.
  vec2 h = gl_FragCoord.xy / float(scale) - 0.5;
  ivec2 h0 = ivec2(floor(h + 0.5));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  vec4 best = vec4(0.0);
  float bestErr = 1e9;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = clamp(h0 + ivec2(i, j), ivec2(0), hs - 1);
    vec2 d = vec2(c) - h;
    float zc = linear(texelFetch(tDepth, c * scale, 0).r);
    float err = abs(zc - z) / z;
    float w = max(0.0, 1.0 - abs(d.x) / 1.5) * max(0.0, 1.0 - abs(d.y) / 1.5) * exp(-err * 40.0) + 1e-6;
    vec4 v = texelFetch(tVapour, c, 0);
    sum += v * w;
    wsum += w;
    if (err < bestErr) {
      bestErr = err;
      best = v;
    }
  }
  vec4 v = wsum > 0.01 ? sum / wsum : best;
  fragColor = vec4(base.rgb * exp(-v.a * extinction) + v.rgb, base.a);
}
`;

// A tiling smooth random field, four independent channels: white noise blurred twice by a [1 2 1] kernel on each axis.
// Built a pass at a time, yielding between them, so it never holds up a frame.
async function noiseTexture() {
  const n = NOISE, size = n * n * n;
  const idle = () => new Promise((resolve) => setTimeout(resolve, 0));
  let a = new Float32Array(size * 4), b = new Float32Array(size * 4);
  for (let i = 0; i < a.length; i++) a[i] = nativeRandom();
  for (let pass = 0; pass < 6; pass++) {
    await idle();
    const axis = pass % 3, st = 4 * n ** axis;
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++) {
        const row = 4 * n * (y + n * z);
        const c0 = axis === 1 ? y : z;
        for (let x = 0; x < n; x++) {
          const c = axis === 0 ? x : c0;
          const k = row + 4 * x;
          const m = k - (c === 0 ? 1 - n : 1) * st, p = k + (c === n - 1 ? 1 - n : 1) * st;
          for (let j = 0; j < 4; j++) b[k + j] = 0.25 * (a[m + j] + a[p + j]) + 0.5 * a[k + j];
        }
      }
    [a, b] = [b, a];
  }
  await idle();
  // Stretched back to the full range.
  const data = new Uint8Array(size * 4);
  for (let k = 0; k < 4; k++) {
    let mean = 0, sq = 0;
    for (let i = k; i < a.length; i += 4) mean += a[i];
    mean /= size;
    for (let i = k; i < a.length; i += 4) sq += (a[i] - mean) ** 2;
    const scale = 255 / (5 * Math.sqrt(sq / size));
    for (let i = k; i < a.length; i += 4) data[i] = Math.max(0, Math.min(255, Math.round(127.5 + (a[i] - mean) * scale)));
  }
  const t = new Data3DTexture(data, n, n, n);
  t.format = RGBAFormat;
  t.type = UnsignedByteType;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

const target = (filter, w = 1, h = 1, format = RGBAFormat) =>
  new WebGLRenderTarget(w, h, {
    type: HalfFloatType,
    format,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
  });

const quad = (material) => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  return scene;
};

const _p3 = new Vector3(), _lv = new Vector3();
const _dq = new Quaternion(), _q = new Quaternion(), _w = new Vector3(), _e = new Vector3(), _v = new Vector3();
const _m4 = new Matrix4(), _clear = new Color();

export function createFumes() {
  const AW = G.nx * G.tx, AH = G.ny * G.ty;
  const state = [target(LinearFilter, AW, AH), target(LinearFilter, AW, AH), target(LinearFilter, AW, AH)];
  const solid = target(NearestFilter, AW, AH);
  const curl = target(NearestFilter, AW, AH);
  const divergence = target(NearestFilter, AW, AH, RGFormat);
  const pressure = [target(NearestFilter, AW, AH, RGFormat), target(NearestFilter, AW, AH, RGFormat)];
  const half = target(NearestFilter);
  const history = [target(NearestFilter), target(NearestFilter)];
  const output = target(NearestFilter);
  const extinction = { value: new Vector3(1, 1, 1) };
  // The piece, shared by every pass that needs it.
  const piece = {
    objCenter: { value: new Vector3() },
    objHalf: { value: new Vector3(1, 1, 1) },
    objRot: { value: new Matrix3() },
    omega: { value: new Vector3() },
    pieceOff: { value: new Vector3() },
    linVel: { value: new Vector3() },
  };
  const noiseU = { value: null };
  const timeU = { value: 0 };
  const dtU = { value: MIN_STEP };
  const material = (fragmentShader, uniforms) =>
    new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, depthTest: false, depthWrite: false, uniforms: { ...piece, ...uniforms } });
  const shapeU = { tShape: { value: null }, useShape: { value: 0 }, shapeLo: { value: new Vector3() }, shapeSize: { value: new Vector3(1, 1, 1) }, shapeScale: { value: 1 } };
  const sim = {
    obstacle: material(obstacleShader, shapeU),
    advect: material(advectShader, { tState: { value: null }, dt: dtU }),
    forces: material(forcesShader, {
      tState: { value: null },
      tAdvected: { value: null },
      tSolid: { value: solid.texture },
      stir: { value: 3.0 },
      tNoise: noiseU,
      dt: dtU,
      time: timeU,
      emission: { value: 0 },
      acidLine: { value: -1e3 },
      objUnit: { value: 1 },
      dissipation: { value: 0.3 },
      buoyancy: { value: 4.0 },
      drag: { value: 14 },
    }),
    curl: material(curlShader, { tState: { value: null } }),
    confine: material(confineShader, { tState: { value: null }, tCurl: { value: curl.texture }, dt: dtU, vorticity: { value: 4.0 } }),
    divergence: material(divergenceShader, { tState: { value: null }, tSolid: { value: solid.texture } }),
    jacobi: material(jacobiShader, { tPressure: { value: null }, tDivergence: { value: divergence.texture } }),
    project: material(projectShader, { tState: { value: null }, tSolid: { value: solid.texture }, tPressure: { value: null } }),
  };
  const simScene = quad(sim.advect);
  const simMesh = simScene.children[0];
  const march = material(marchShader, {
    tDepth: { value: null },
    tState: { value: null },
    tNoise: noiseU,
    inverseViewProjection: { value: new Matrix4() },
    cameraPos: { value: new Vector3() },
    center: { value: new Vector3() },
    radius: { value: 1 },
    time: timeU,
    density: { value: 0 },
    frame: { value: 0 },
    lightDirection: globalUniforms.lightDirection,
    lightColor: globalUniforms.lightColor,
    shIrradiance: globalUniforms.shIrradiance,
    extinction,
    albedo: { value: new Vector3(1, 1, 1) },
    fullSize: { value: new Vector2() },
    scale: { value: 2 },
  });
  const composite = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader: compositeShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: null },
      tVapour: { value: null },
      tDepth: { value: null },
      extinction,
      cameraNear: { value: 0.1 },
      cameraFar: { value: 100 },
      scale: { value: 2 },
    },
  });
  const resolve = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader: resolveShader,
    depthTest: false,
    depthWrite: false,
    uniforms: { tCurrent: { value: half.texture }, tHistory: { value: null }, blend: { value: 1 } },
  });
  const resolveScene = quad(resolve);
  const marchScene = quad(march);
  const compositeScene = quad(composite);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const _vp = new Matrix4();
  let ready = false;
  const baked = { lo: new Vector3(), size: new Vector3(1, 1, 1) };
  let fresh = true;
  let frame = 0;
  // Sim state: whether it holds vapour, clock seconds since it last gave any off, and time not yet stepped.
  const run = { alive: false, quiet: 0, owed: 0, fading: 0, R: 1, lastTime: 0, lastRot: null };

  const pass = (renderer, mat, out) => {
    simMesh.material = mat;
    renderer.setRenderTarget(out);
    renderer.render(simScene, camera);
  };
  function clearSim(renderer) {
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(_clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [...state, ...pressure, solid, curl, divergence]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(_clear, alpha);
    renderer.setRenderTarget(prev);
  }
  function step(renderer) {
    const s = sim;
    pass(renderer, s.obstacle, solid);
    s.advect.uniforms.tState.value = state[0].texture;
    pass(renderer, s.advect, state[1]);
    s.forces.uniforms.tState.value = state[0].texture;
    s.forces.uniforms.tAdvected.value = state[1].texture;
    pass(renderer, s.forces, state[2]);
    s.curl.uniforms.tState.value = state[2].texture;
    pass(renderer, s.curl, curl);
    s.confine.uniforms.tState.value = state[2].texture;
    pass(renderer, s.confine, state[0]);
    s.divergence.uniforms.tState.value = state[0].texture;
    pass(renderer, s.divergence, divergence);
    // Warm started from the last step's pressure.
    for (let i = 0; i < JACOBI; i++) {
      s.jacobi.uniforms.tPressure.value = pressure[0].texture;
      pass(renderer, s.jacobi, pressure[1]);
      pressure.reverse();
    }
    s.project.uniforms.tState.value = state[0].texture;
    s.project.uniforms.tPressure.value = pressure[0].texture;
    pass(renderer, s.project, state[1]);
    [state[0], state[1]] = [state[1], state[0]];
  }

  const fumes = {
    enabled: true,
    // Sim steps taken so far.
    steps: 0,
    // Builds the noise and compiles the passes ahead of the etch, off the load's critical path.
    async prepare(renderer) {
      const texture = await noiseTexture();
      noiseU.value = texture;
      const compile = [renderer.compileAsync(marchScene, camera), renderer.compileAsync(resolveScene, camera), renderer.compileAsync(compositeScene, camera)];
      for (const m of Object.values(sim)) compile.push(renderer.compileAsync(quad(m), camera));
      await Promise.all(compile);
      clearSim(renderer);
      this.renderer = renderer;
      ready = true;
    },
    // A replay or a new piece: what vapour there is fades out quickly.
    reset() {
      if (run.alive && run.fading === 0) run.fading = FADE;
    },
    // The blank's signed distance on a 32^3 grid over its bounds, in its own frame (baked in the build worker), or
    // null until it comes: the sim uses the bounds meanwhile.
    setShape(field) {
      this.reset();
      shapeU.useShape.value = 0;
      if (!field) return;
      // One texture a shape, kept with its field.
      if (!field.texture) {
        const n = 32, data = new Uint16Array(n * n * n);
        for (let i = 0; i < data.length; i++) data[i] = DataUtils.toHalfFloat(field.data[i]);
        const texture = new Data3DTexture(data, n, n, n);
        texture.format = RedFormat;
        texture.type = HalfFloatType;
        texture.minFilter = texture.magFilter = LinearFilter;
        texture.unpackAlignment = 1;
        texture.needsUpdate = true;
        field.texture = texture;
      }
      shapeU.tShape.value = field.texture;
      baked.lo.fromArray(field.lo);
      baked.size.fromArray(field.size);
      shapeU.useShape.value = 1;
    },
    // time: the process clock, but running on while pieces change over (stopped while paused); strength 0..1: how
    // fast vapour is given off; line: the acid's cover, as relief.js's acidLine (0..1 spreading, 1..2 rinsing);
    // warm: how coppery the metal is (nitric acid on copper gives off brown NO2, others a pale vapour). Steps the sim
    // by the clock's advance.
    update(time, strength, line, mesh, warm) {
      const g = mesh.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const box = g.boundingBox;
      const dt = time - run.lastTime;
      // The piece's spin, from its rotation since the last step of time.
      if (dt > 1e-4 && dt < 0.5 && run.lastRot) {
        _dq.copy(mesh.quaternion).multiply(_q.copy(run.lastRot).invert());
        if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
        const ang = 2 * Math.acos(Math.min(1, _dq.w));
        const sn = Math.sqrt(Math.max(1 - _dq.w * _dq.w, 1e-12));
        _w.set(_dq.x / sn, _dq.y / sn, _dq.z / sn).multiplyScalar(ang / dt);
        if (_w.length() > 15) _w.setLength(15);
        piece.omega.value.lerp(_w, Math.min(1, dt * 20));
      }
      if (dt !== 0) {
        (run.lastRot ??= mesh.quaternion.clone()).copy(mesh.quaternion);
        run.lastTime = time;
      }
      if (!ready || !this.enabled) return;
      const renderer = this.renderer;
      if (dt < 0) run.alive = false;
      if (run.fading > 0 && dt > 0) {
        run.fading = Math.max(0, run.fading - dt);
        if (run.fading === 0) run.alive = false;
      }
      box.getSize(_v).multiplyScalar(0.5);
      // The acid starting on a clear sim, sized to the piece as it stands (and kept so while it shrinks away).
      if (strength > 0.002 && (!run.alive || run.fading > 0)) {
        clearSim(renderer);
        run.alive = true;
        run.fading = 0;
        run.quiet = 0;
        run.owed = 0;
        run.R = Math.max(_v.x, _v.y, _v.z, 1e-3);
        // The grid stays where the piece was: its shaking then moves through the air.
        (run.center ??= new Vector3()).setFromMatrixPosition(mesh.matrixWorld);
        run.lastPos = null;
        fresh = true;
      }
      if (!run.alive) return;
      const R = run.R, scale = Math.max(mesh.scale.x, 1e-3);
      const u = march.uniforms;
      u.radius.value = R;
      u.center.value.copy(run.center);
      _p3.setFromMatrixPosition(mesh.matrixWorld);
      piece.pieceOff.value.copy(_p3).sub(run.center).divideScalar(R);
      if (run.lastPos && dt > 1e-4 && dt < 0.5) {
        _lv.copy(_p3).sub(run.lastPos).divideScalar(dt * R);
        if (_lv.length() > 12) _lv.setLength(12);
        piece.linVel.value.lerp(_lv, Math.min(1, dt * 30));
      }
      if (dt !== 0) (run.lastPos ??= new Vector3()).copy(_p3);
      piece.objHalf.value.copy(_v).multiplyScalar((1.04 * scale) / R);
      piece.objCenter.value.copy(box.getCenter(_v)).multiplyScalar(scale).applyQuaternion(mesh.quaternion).divideScalar(R).add(piece.pieceOff.value);
      piece.objRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q.copy(mesh.quaternion).invert()));
      shapeU.shapeScale.value = scale / R;
      shapeU.shapeLo.value.copy(baked.lo).multiplyScalar(scale / R);
      shapeU.shapeSize.value.copy(baked.size).multiplyScalar(scale / R);
      // Once the acid is off, what is left thins out and goes; a reset fades it out faster.
      run.quiet = strength > 0.002 ? 0 : run.quiet + Math.max(dt, 0);
      const fade = run.fading > 0 ? run.fading / FADE : Math.min(1, 5 - run.quiet);
      if (fade <= 0) {
        run.alive = false;
        return;
      }
      u.density.value = (1.5 + 0.8 * warm) * fade;
      extinction.value.set(1, 1, 1).lerp(_e.set(0.45, 0.85, 1.9), warm);
      u.albedo.value.set(0.9, 0.9, 0.88).lerp(_e.set(0.45, 0.27, 0.12), warm);
      if (dt <= 0) return;
      const a = sim.forces.uniforms;
      a.emission.value = run.fading > 0 ? 0 : 3.2 * strength;
      a.acidLine.value = line;
      a.objUnit.value = R / scale;
      a.dissipation.value = 0.45 + 0.9 * Math.min(1, run.quiet / 2);
      timeU.value = time;
      run.owed = Math.min(run.owed + dt, 3 * MAX_STEP);
      if (run.owed < MIN_STEP) return;
      const prev = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      const n = Math.ceil(run.owed / MAX_STEP - 1e-6);
      dtU.value = run.owed / n;
      for (let i = 0; i < n; i++) step(renderer);
      this.steps += n;
      run.owed = 0;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(prev);
    },
    // The pipeline's composite hook: null (the image as it is) while there's nothing to draw.
    render(renderer, hdr, { depthTexture, camera: view, width, height }) {
      if (!this.enabled || !ready || !run.alive) {
        fresh = true;
        return null;
      }
      // Half resolution, or full when the image is already small (the page renders scaled down on slow devices).
      const scale = width * height > 450000 ? 2 : 1;
      march.uniforms.scale.value = composite.uniforms.scale.value = scale;
      const hw = Math.ceil(width / scale), hh = Math.ceil(height / scale);
      if (half.width !== hw || half.height !== hh) {
        for (const t of [half, ...history]) t.setSize(hw, hh);
        fresh = true;
      }
      if (output.width !== width || output.height !== height) output.setSize(width, height);
      const u = march.uniforms;
      u.tDepth.value = depthTexture;
      u.tState.value = state[0].texture;
      _vp.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
      u.inverseViewProjection.value.copy(_vp).invert();
      u.cameraPos.value.setFromMatrixPosition(view.matrixWorld);
      u.fullSize.value.set(width, height);
      u.frame.value = frame++;
      const c = composite.uniforms;
      c.tScene.value = hdr;
      c.tDepth.value = depthTexture;
      c.cameraNear.value = view.near;
      c.cameraFar.value = view.far;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(half);
      renderer.render(marchScene, camera);
      const [prevTarget, nextTarget] = frame & 1 ? history : [history[1], history[0]];
      resolve.uniforms.tHistory.value = prevTarget.texture;
      resolve.uniforms.blend.value = fresh ? 1 : 0.35;
      fresh = false;
      renderer.setRenderTarget(nextTarget);
      renderer.render(resolveScene, camera);
      composite.uniforms.tVapour.value = nextTarget.texture;
      renderer.setRenderTarget(output);
      renderer.render(compositeScene, camera);
      renderer.setRenderTarget(prev);
      return output.texture;
    },
  };
  return fumes;
}
