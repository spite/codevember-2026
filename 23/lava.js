import { shader as simplexNoise3D } from "shaders/perlinSimplex3D.js";

// Shared by the rock material and the molten morph, so a molten surface looks the same in both.
const LAVA_GLSL = /* glsl */ `
// Triplanar sampling of the tileable noise map in object space (seam-free on every shape)
vec3 sampleNoiseTriplanar(sampler2D noiseMap, vec3 q, vec3 objN) {
  vec3 w = pow(abs(objN), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  return texture(noiseMap, q.yz).rgb * w.x
       + texture(noiseMap, q.xz).rgb * w.y
       + texture(noiseMap, q.xy).rgb * w.z;
}

// Noise advected along flowObj with two phases cross-faded; x = lava brightness, y = ripple
vec2 sampleFlowingNoise(sampler2D noiseMap, vec3 p, vec3 flowObj, vec3 objN, float t, float smoothPhase, float scale, vec3 seedOffset) {
  float cycle = t * 0.32;
  float p0 = fract(cycle + smoothPhase * 0.15);
  float p1 = fract(cycle + 0.5 + smoothPhase * 0.15);
  float blend = abs(2.0 * p0 - 1.0);

  vec3 baseP = p * (0.42 * scale) + seedOffset * 0.15;
  vec3 adv = flowObj * 0.78;

  vec3 n0 = sampleNoiseTriplanar(noiseMap, baseP - adv * (p0 - 0.5), objN);
  vec3 n1 = sampleNoiseTriplanar(noiseMap, baseP - adv * (p1 - 0.5) + vec3(0.37, 0.61, 0.23), objN);
  vec3 broad = mix(n0, n1, blend);

  vec3 medP = baseP * 1.75 + vec3(0.23, 0.71, 0.41);
  vec3 m0 = sampleNoiseTriplanar(noiseMap, medP - adv * 1.25 * (p0 - 0.5), objN);
  vec3 m1 = sampleNoiseTriplanar(noiseMap, medP - adv * 1.25 * (p1 - 0.5) + vec3(0.51, 0.29, 0.67), objN);
  vec3 med = mix(m0, m1, blend);

  float gray = clamp(broad.r * 0.68 + broad.g * 0.20 + med.g * 0.20 - 0.04, 0.0, 1.0);
  gray = smoothstep(0.18, 0.84, gray);
  float ripple = mix(broad.g, med.b, 0.4);
  return vec2(gray, ripple);
}

// Incandescence ramp: dark crimson -> crimson -> red-orange -> orange -> small golden cores
vec3 blackbody(float t) {
  float x = clamp(t, 0.0, 1.38);
  vec3 c1 = vec3(0.25, 0.006, 0.0);
  vec3 c2 = vec3(1.30, 0.11, 0.0);
  // Brighter is oranger: saturated red at the dim end turns pink once tonemapped bright, so the hot end gains green
  vec3 c3 = vec3(3.00, 1.28, 0.0);
  vec3 c4 = vec3(7.00, 3.80, 0.18);
  vec3 c5 = vec3(16.0, 11.0, 2.60);

  vec3 col = mix(vec3(0.0), c1, smoothstep(0.05, 0.22, x));
  col = mix(col, c2, smoothstep(0.20, 0.46, x));
  col = mix(col, c3, smoothstep(0.44, 0.72, x));
  col = mix(col, c4, smoothstep(0.66, 0.96, x));
  col = mix(col, c5, smoothstep(0.96, 1.32, x));
  return col;
}

float skinOf(float lava) {
  return smoothstep(0.5, 0.15, lava);
}

// Temperature of fully molten rock with no look applied
float moltenTemp(float lava) {
  return mix(0.32, 0.98, lava) * (1.0 - skinOf(lava) * 0.7);
}

vec3 neutralFlow(vec3 n) {
  return cross(n, vec3(0.0, 1.0, 0.0)) * 0.9;
}
`;

// Liquid morph from shape A to shape B through a sloshing pool. uStage: 0 shape A; 1 A collapses into
// the pool (uCollapse 0..1); 2 the pool sloshes; 3 B rises out of the pool (uRecompose 0..1).
const MORPH_GLSL = /* glsl */ `
${simplexNoise3D}

uniform highp sampler3D uSdfA;
uniform highp sampler3D uSdfB;
uniform float uSdfBound;
uniform int uStage;
uniform float uCollapse;
uniform float uRecompose;
uniform float uSloshTime;
uniform float uPoolRadius;
uniform float uMorphTime;
uniform float uFieldRadius;
uniform float uFieldClear;
// morphField baked this frame into an 8x8 atlas of 64 z slices (MorphFieldAtlas), while uFieldBaked is 1
uniform sampler2D uFieldAtlas;
uniform float uFieldBaked;

float sdfAt(highp sampler3D tex, vec3 p) {
  vec3 q = p / (2.0 * uSdfBound) + 0.5;
  vec3 outside = max(abs(p) - uSdfBound, 0.0);
  return texture(tex, clamp(q, 0.0, 1.0)).r + length(outside);
}

float smin(float a, float b, float k) {
  k = max(k, 1e-4);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// A wobbling pool of lava: damped side-to-side slosh plus squash and stretch
void poolPose(vec3 p, out vec3 q, out vec3 axes) {
  float energy = 0.35 + 0.65 * exp(-uSloshTime * 1.1);
  float w = uSloshTime * 4.6;
  float squash = 0.2 * energy * cos(w);
  q = p - vec3(0.14 * sin(w * 0.73), -0.05 + 0.06 * cos(w), 0.1 * sin(w * 0.51 + 1.0)) * energy;
  axes = vec3(1.0 + squash, 1.0 - 1.4 * squash, 1.0 + 0.6 * squash);
}

// The pool without its surface noise (which adds at most +-0.05); q is the posed point for poolNoise
float poolBase(vec3 p, out vec3 q) {
  vec3 axes;
  poolPose(p, q, axes);
  float r = uPoolRadius;
  return (length(q / (r * axes)) - 1.0) * r * min(axes.x, min(axes.y, axes.z));
}

float poolNoise(vec3 q) {
  return 0.05 * snoise(q * 1.5 + vec3(0.0, uMorphTime * 0.6, uMorphTime * 0.4));
}

float pool(vec3 p) {
  vec3 q;
  float d = poolBase(p, q);
  return d + poolNoise(q);
}

// smin(a, pool(p) + offset, k), skipping the pool's noise where the pool is too far to change the result
float sminPool(float a, vec3 p, float offset, float k) {
  vec3 q;
  float c = poolBase(p, q) + offset;
  if (c - 0.05 - a >= max(k, 1e-4)) return a;
  return smin(a, c + poolNoise(q), k);
}

// A shape shrunk toward the centre by scale and lowered by drop
float sagged(highp sampler3D tex, vec3 p, float scale, float drop) {
  return sdfAt(tex, (p + vec3(0.0, drop, 0.0)) / scale) * scale;
}

float morphField(vec3 p) {
  if (uStage == 0) return sdfAt(uSdfA, p);
  if (uStage == 2) return pool(p);
  // The pool swells inside the shape as it sags, so the liquid keeps its volume instead of shrinking and popping back
  if (uStage == 1) {
    float s = uCollapse;
    float a = sagged(uSdfA, p, 1.0 - 0.3 * s, 0.3 * s * s) + smoothstep(0.5, 1.0, s) * 0.95;
    return sminPool(a, p, (1.0 - smoothstep(0.0, 0.55, s)) * 0.9, 0.35 * smoothstep(0.0, 0.3, s));
  }
  float s = uRecompose;
  float b = sagged(uSdfB, p, 0.45 + 0.55 * s, 0.35 * (1.0 - s) * (1.0 - s)) + (1.0 - smoothstep(0.0, 0.45, s)) * 0.6;
  return sminPool(b, p, smoothstep(0.4, 1.0, s) * 1.0, 0.35 * (1.0 - s * s));
}

float fieldAtlas(vec3 p) {
  const float N = 64.0;
  vec3 q = clamp(p / (2.0 * uSdfBound) + 0.5, 0.0, 1.0);
  vec2 xy = clamp(q.xy, 0.5 / N, 1.0 - 0.5 / N) / 8.0;
  float z = clamp(q.z * N - 0.5, 0.0, N - 1.0);
  float z0 = floor(z);
  float z1 = min(z0 + 1.0, N - 1.0);
  float a = textureLod(uFieldAtlas, vec2(mod(z0, 8.0), floor(z0 / 8.0)) / 8.0 + xy, 0.0).r;
  float b = textureLod(uFieldAtlas, vec2(mod(z1, 8.0), floor(z1 / 8.0)) / 8.0 + xy, 0.0).r;
  return mix(a, b, z - z0) + length(max(abs(p) - uSdfBound, 0.0));
}

// The morph field from the baked atlas when there is one (within ~0.005 of morphField), else exact
float morphFieldFast(vec3 p) {
  return uFieldBaked > 0.5 ? fieldAtlas(p) : morphField(p);
}

// Where the lava pattern is read for a point of the liquid: its place in the pool at rest while the pool
// sloshes, so the pattern rides the wobble instead of the surface swimming through it
vec3 morphPatternPos(vec3 p) {
  vec3 q, axes;
  poolPose(p, q, axes);
  vec3 rest = q / axes;
  if (uStage == 0) return p;
  if (uStage == 2) return rest;
  if (uStage == 1) return mix(p, rest, smoothstep(0.0, 0.55, uCollapse));
  return mix(rest, p, smoothstep(0.4, 1.0, uRecompose));
}
`;

function createMorphUniforms(sdfBound) {
  return {
    uSdfA: { value: null },
    uSdfB: { value: null },
    uSdfBound: { value: sdfBound },
    uStage: { value: 0 },
    uCollapse: { value: 0 },
    uRecompose: { value: 0 },
    uSloshTime: { value: 0 },
    uPoolRadius: { value: 1 },
    uMorphTime: { value: 0 },
    uFieldRadius: { value: sdfBound },
    uFieldClear: { value: 1e9 },
    uFieldAtlas: { value: null },
    uFieldBaked: { value: 0 },
  };
}

export { LAVA_GLSL, MORPH_GLSL, createMorphUniforms };
