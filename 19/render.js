// Full-screen composite refraction, multi-layer Gaussian diffusion, chromatic dispersion,
// Beer-Lambert absorption, and micro-pitted frosted glass renderer for Day 19 (Erosion).
import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Matrix3,
  Matrix4,
  Vector2,
  Vector3,
  Color,
  FrontSide,
  BackSide,
  DoubleSide,
  CustomBlending,
  OneFactor,
  AddEquation,
  Vector4,
  DepthTexture,
} from "three";
import { fullscreenVertex, copyFragment } from "shaders/pipeline/copy.js";
import { brdf } from "shaders/pipeline/brdf.js";
import { shGLSL } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";

// Limits a target's draws to a pixel rect [x0, y0, x1, y1], or lifts the limit (null)
function setScissor(target, rect) {
  target.scissorTest = !!rect;
  if (rect) target.scissor.set(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
}

const PYRAMID_LEVELS = 6; // full, 1/2, 1/4, 1/8, 1/16, 1/32

const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 texel;
uniform vec2 dir;
in vec2 vUv;
out vec4 outColor;
void main() {
  // 9-tap Gaussian blur
  vec2 d1 = dir * texel * 1.38461538;
  vec2 d2 = dir * texel * 3.23076923;
  vec4 c = texture(tSource, vUv) * 0.22702703;
  c += (texture(tSource, vUv + d1) + texture(tSource, vUv - d1)) * 0.31621622;
  c += (texture(tSource, vUv + d2) + texture(tSource, vUv - d2)) * 0.07027027;
  outColor = c;
}
`;

const envBgFragment = /* glsl */ `
precision highp float;
uniform mat4 inverseViewProjection;
uniform vec3 cameraPos;
uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
// The outgoing environment while a change crossfades (uEnvFade 0 -> 1)
uniform samplerCube envMapPrev;
uniform float envMapMaxLodPrev;
uniform float envIntensityPrev;
uniform float uEnvFade;
uniform mat3 envRotation;
uniform float uBgBlur;
uniform sampler2D tSolid;
uniform float uSolid;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 far = inverseViewProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(far.xyz / far.w - cameraPos);
  float r = clamp(uBgBlur, 0.0, 1.0);
  // Clamped: an HDRI's sun is brighter than the half-float buffers hold, and would turn into infinities that blur everywhere
  vec3 c = textureLod(envMap, envRotation * rd, envMapMaxLod * r * (2.0 - r)).rgb * envIntensity;
  if (uEnvFade < 1.0) c = mix(textureLod(envMapPrev, envRotation * rd, envMapMaxLodPrev * r * (2.0 - r)).rgb * envIntensityPrev, c, uEnvFade);
  c = min(c, vec3(64.0));
  // Crossfade to the solid backdrop (the pipeline's own frame)
  outColor = vec4(mix(c, texture(tSolid, vUv).rgb, uSolid), 1.0);
}
`;

const glassVertex = /* glsl */ `
in vec3 position;
in vec3 normal;
in vec3 aRawPos;
in vec3 aRawNormal;
in float aThickness;
in float aWear;
in float aPieceType;
in vec3 aPatternE;
in vec3 aPatternR;
in vec3 aBaseNormalE;
in vec3 aBaseNormalR;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uErosion;
uniform float uPatternErosion;

out vec3 vObjectPos;
out vec3 vWorldPos;
out vec3 vWorldNormal;
out float vThickness;
out float vWear;
out float vPieceType;

void main() {
  // The shape erodes with uErosion and its pattern (relief, threads, veins) with uPatternErosion; equal, this is a
  // plain blend of the two poses.
  vec3 base = mix(aRawPos - aPatternR, position - aPatternE, uErosion);
  vec3 p = base + mix(aPatternR, aPatternE, uPatternErosion);
  vec3 baseN = mix(aBaseNormalR, aBaseNormalE, uErosion);
  vec3 patternTilt = mix(aRawNormal, normal, uPatternErosion) - mix(aBaseNormalR, aBaseNormalE, uPatternErosion);
  vec3 n = normalize(baseN + patternTilt);
  vObjectPos = p;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * n);
  vThickness = aThickness;
  vWear = aWear;
  vPieceType = aPieceType;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const thickFragment = /* glsl */ `
precision highp float;
uniform vec3 cameraPos;
uniform float refDist;
in vec3 vWorldPos;
out vec4 outColor;
void main() {
  float d = distance(vWorldPos, cameraPos) - refDist;
  float s = gl_FrontFacing ? -d : d;
  outColor = vec4(s, s, s, s);
}
`;

const depthFragment = /* glsl */ `
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

const wireFragment = /* glsl */ `
precision highp float;
uniform vec3 uWireColor;
out vec4 outColor;
void main() {
  outColor = vec4(uWireColor, 1.0);
}
`;

const glassFragment = /* glsl */ `
precision highp float;

uniform sampler2D tPyr0;
uniform sampler2D tPyr1;
uniform sampler2D tPyr2;
uniform sampler2D tPyr3;
uniform sampler2D tPyr4;
uniform sampler2D tPyr5;
uniform sampler2D tThick;
uniform vec2 resolution;
uniform vec2 texel1;
uniform vec2 texel2;
uniform vec2 texel3;
uniform vec2 texel4;
uniform vec2 texel5;

uniform vec3 cameraPos;
uniform vec3 camRight;
uniform vec3 camUp;
uniform mat3 uInvModelRot;
uniform vec3 uColor;
uniform float uErosion;
uniform float uFrosting;
uniform float uWetness;
uniform float uDiffusion;
uniform float uRefraction;
uniform float uDispersion;
uniform float uDensity;
uniform float uTranslucency;
uniform float uIor;
uniform float uPieceSeed;
uniform int uPieceCount;
uniform int uPieceIndex;
// Loop bounds as uniforms (interior march steps, backdrop taps): constant bounds make the D3D compiler unroll the
// loops, which took seconds.
uniform ivec2 uLoops;
uniform float uRodRadius;
#ifdef TRACE
// Loop bounds as uniforms: constant bounds make the D3D compiler unroll the nested tracer loops, taking seconds.
uniform ivec4 uTraceLoops;
uniform int uTraceBranches;
uniform vec4 uTorus;
uniform vec3 uTorusWobble;
uniform vec3 uTorusCenter;
uniform float uTorusSquare;
uniform vec3 uPieceCenter;
uniform mat4 uViewProj;
#endif
uniform vec4 uPiecePosR[36];
uniform vec3 uPieceCol[36];

uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
// The outgoing environment while a change crossfades (uEnvFade 0 -> 1)
uniform samplerCube envMapPrev;
uniform float envMapMaxLodPrev;
uniform float envIntensityPrev;
uniform float uEnvFade;
uniform mat3 envRotation;
uniform vec3 shIrradiance[9];
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float lightSpecular;

in vec3 vObjectPos;
in vec3 vWorldPos;
in vec3 vWorldNormal;
in float vThickness;
in float vWear;
in float vPieceType;

out vec4 outColor;

#define PI 3.14159265
${brdf}
${shGLSL}

vec3 env(vec3 d, float rough) {
  vec3 c = textureLod(envMap, envRotation * d, envMapMaxLod * rough * (2.0 - rough)).rgb * envIntensity;
  if (uEnvFade < 1.0) c = mix(textureLod(envMapPrev, envRotation * d, envMapMaxLodPrev * rough * (2.0 - rough)).rgb * envIntensityPrev, c, uEnvFade);
  return min(c, vec3(64.0));
}

vec3 meanRadiance() {
  return max(shIrradiance[0] * 0.282095, vec3(0.0)) * envIntensity;
}

// Fast 3D hash for procedural micro-pitting (percussion marks & sandblasted grain).
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Crater field: one crater per cell, its centre kept 0.25 from the cell walls so a crater (radius 0.22) never crosses
// into a neighbour and only the cell itself needs checking.
float pitField(vec3 p, float scale) {
  vec3 sp = p * scale;
  vec3 r = (0.25 + 0.5 * hash33(floor(sp))) - fract(sp);
  return smoothstep(0.0, 0.22, length(r));
}

// High-frequency sugary grain for frosted normal perturbation.
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i).x;
  float n100 = hash33(i + vec3(1, 0, 0)).x;
  float n010 = hash33(i + vec3(0, 1, 0)).x;
  float n110 = hash33(i + vec3(1, 1, 0)).x;
  float n001 = hash33(i + vec3(0, 0, 1)).x;
  float n101 = hash33(i + vec3(1, 0, 1)).x;
  float n011 = hash33(i + vec3(0, 1, 1)).x;
  float n111 = hash33(i + vec3(1, 1, 1)).x;
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

vec4 bicubic(sampler2D t, vec2 uv, vec2 texel) {
  vec2 st = uv / texel - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) * texel;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) * texel;
  return g0.y * (g0.x * texture(t, vec2(h0.x, h0.y)) + g1.x * texture(t, vec2(h1.x, h0.y)))
    + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, vec2(h1.x, h1.y)));
}

vec3 samplePyramid(vec2 uv, float lod) {
  uv = clamp(uv, vec2(0.002), vec2(0.998));
  float l = clamp(lod, 0.0, 5.0);
  if (l < 1.0) return mix(texture(tPyr0, uv).rgb, bicubic(tPyr1, uv, texel1).rgb, l);
  if (l < 2.0) return mix(bicubic(tPyr1, uv, texel1).rgb, bicubic(tPyr2, uv, texel2).rgb, l - 1.0);
  if (l < 3.0) return mix(bicubic(tPyr2, uv, texel2).rgb, bicubic(tPyr3, uv, texel3).rgb, l - 2.0);
  if (l < 4.0) return mix(bicubic(tPyr3, uv, texel3).rgb, bicubic(tPyr4, uv, texel4).rgb, l - 3.0);
  return mix(bicubic(tPyr4, uv, texel4).rgb, bicubic(tPyr5, uv, texel5).rgb, l - 4.0);
}

float fresnelDielectric(float cosI, float eta) {
  cosI = clamp(cosI, 0.0, 1.0);
  float sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - sin2T);
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

#ifdef TRACE
// Ideal torus fitted to a ring piece, in its object space: uTorus = (major R, radial semi-axis, vertical semi-axis, wobble).
float torusSDF(vec3 p) {
  p -= uTorusCenter;
  float ang = atan(p.z, p.x);
  float s = 1.0 + uTorus.w * sin(2.0 * ang + uTorusWobble.x) + uTorusWobble.z * sin(3.0 * ang + 9.0 * p.y / (0.82 * uTorus.x));
  float tube = uTorus.y * mix(1.0, s, uTorusWobble.y);
  // Superellipse cross-section (exponent uTorusSquare: 2 round, higher squarer), matching the collar's corners.
  vec2 q = abs(vec2(length(p.xz) - uTorus.x * s, p.y)) / vec2(tube, uTorus.z * mix(1.0, s, uTorusWobble.y));
  float n = uTorusSquare;
  float f = pow(pow(q.x, n) + pow(q.y, n), 1.0 / n) - 1.0;
  return f * min(tube, uTorus.z) * 0.85;
}

vec3 torusNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.003;
  return normalize(k.xyy * torusSDF(p + k.xyy * e) + k.yyx * torusSDF(p + k.yyx * e) + k.yxy * torusSDF(p + k.yxy * e) + k.xxx * torusSDF(p + k.xxx * e));
}

// Distance to where a ray inside the glass leaves it.
float marchInside(vec3 p, vec3 d) {
  float t = 0.0;
  float prev = 0.0;
  for (int i = 0; i < uTraceLoops.x; i++) {
    float h = torusSDF(p + d * t);
    if (h > 0.0 && t > 0.01) break;
    prev = t;
    t += max(abs(h), 0.004);
  }
  for (int i = 0; i < uTraceLoops.y; i++) {
    float mid = 0.5 * (prev + t);
    if (torusSDF(p + d * mid) > 0.0) t = mid; else prev = mid;
  }
  return t;
}

// Distance to where a ray outside the glass meets it again, or -1.
float marchOutside(vec3 p, vec3 d) {
  float t = 0.005;
  for (int i = 0; i < uTraceLoops.x; i++) {
    float h = torusSDF(p + d * t);
    if (h < 0.001) return t;
    t += h;
    if (t > 4.0 * uTorus.x) break;
  }
  return -1.0;
}

// Continues a path: out through the next wall (or back in by total internal reflection), into the other side of the
// tube and out again.
void traceOn(inout vec3 p, inout vec3 d, bool inside, inout float len, inout float fresnelT, inout float lodExtra, float frostLod) {
  for (int k = 0; k < uTraceLoops.z; k++) {
    if (inside) {
      float t = marchInside(p, d);
      p += d * t;
      len += t;
      vec3 N = torusNormal(p);
      vec3 r = refract(d, -N, uIor);
      if (dot(r, r) < 1e-4) {
        d = reflect(d, N);
        lodExtra += 0.25;
      } else {
        fresnelT *= 1.0 - fresnelDielectric(dot(d, N), uIor);
        d = normalize(r);
        inside = false;
        lodExtra += frostLod;
      }
    } else {
      float t = marchOutside(p, d);
      if (t < 0.0) return;
      p += d * t;
      vec3 N = torusNormal(p);
      fresnelT *= 1.0 - fresnelDielectric(-dot(d, N), 1.0 / uIor);
      d = normalize(refract(d, N, 1.0 / uIor));
      inside = true;
      lodExtra += frostLod;
    }
  }
  if (inside) fresnelT *= 0.3;
}

// What is behind along a path's final ray: the pyramid where it lands on screen, the environment off it.
vec3 lookBehind(vec3 p, vec3 d, float rough, float blurLod, float lodExtra) {
  mat3 toWorld = transpose(uInvModelRot);
  vec3 pw = uPieceCenter + toWorld * p;
  vec3 dw = toWorld * d;
  vec4 clip = uViewProj * vec4(pw + dw * mix(0.4, 1.6, uRefraction), 1.0);
  vec2 uvT = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  vec3 behind = samplePyramid(uvT, clamp(blurLod + lodExtra, 0.25, 5.0));
  vec2 edgeUv = min(uvT, 1.0 - uvT);
  float onScreen = clip.w > 0.0 ? smoothstep(-0.02, 0.06, min(edgeUv.x, edgeUv.y)) : 0.0;
  return mix(env(dw, clamp(rough + 0.12 * lodExtra + 0.35 * uFrosting * (1.0 - 0.55 * uWetness), 0.0, 1.0)), behind, onScreen);
}

// One ray through the fitted torus. It marches to the first inner wall once, then follows both the transmitted and the
// Fresnel-reflected ray from there: their sum is continuous across the critical angle, where taking one leaves hard edges.
vec3 traceRay(vec3 rdWorld, vec3 V, vec2 cone, float rough, float blurLod, float frostLod, out float lenInside) {
  vec3 tp = uInvModelRot * (vWorldPos - uPieceCenter);
  vec3 td = normalize(uInvModelRot * rdWorld);
  // Start on the fitted torus where the camera ray meets it, not on the mesh, which it only approximates.
  vec3 vo = normalize(uInvModelRot * -V);
  vec3 q = tp - vo * 0.2 * uTorus.x;
  float t = 0.0;
  for (int i = 0; i < uTraceLoops.w; i++) {
    float h = torusSDF(q + vo * t);
    if (h < 0.0005) break;
    t += h;
  }
  if (t < 0.45 * uTorus.x) {
    // Refract at the fitted surface's smooth normal: the path is too sensitive for the frost's pixel-scale pits.
    tp = q + vo * t;
    vec3 entry = refract(vo, torusNormal(tp), 1.0 / uIor);
    if (dot(entry, entry) > 1e-4) td = normalize(entry);
    tp += td * 0.002;
  }
  vec3 T = normalize(cross(td, abs(td.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  td = normalize(td + (T * cone.x + cross(td, T) * cone.y));

  float first = marchInside(tp, td);
  tp += td * first;
  lenInside = first;
  vec3 N = torusNormal(tp);
  vec3 r = refract(td, -N, uIor);
  float F = dot(r, r) < 1e-4 ? 1.0 : fresnelDielectric(dot(td, N), uIor);
  vec3 result = vec3(0.0);
  // One loop over both branches keeps a single inlined copy of the rest of the path
  for (int b = 0; b < uTraceBranches; b++) {
    bool reflected = b == 1;
    float w = reflected ? F : 1.0 - F;
    if (w <= (reflected ? 0.02 : 0.0)) continue;
    vec3 p = tp;
    vec3 d = reflected ? reflect(td, N) : normalize(r);
    float len = 0.0;
    float lod = reflected ? 0.25 : frostLod;
    traceOn(p, d, reflected, len, w, lod, frostLod);
    result += lookBehind(p, d, rough, blurLod, lod) * w;
    if (reflected) lenInside += len * F;
  }
  return result;
}
#endif

// Analytical soft colored shadows, ambient occlusion, and colored bounce GI across the floating cluster.
void computeClusterLighting(vec3 P, vec3 N, vec3 L, out vec3 shadowTint, out float ao, out vec3 bounceGI) {
  shadowTint = vec3(1.0);
  ao = 1.0;
  bounceGI = vec3(0.0);
  for (int i = 0; i < uPieceCount; i++) {
    if (i == uPieceIndex) continue;
    vec4 sp = uPiecePosR[i];
    vec3 toC = sp.xyz - P;
    float dist = length(toC);
    vec3 dir = toC / max(dist, 1e-4);

    // 1. Soft colored translucent shadow along key light L
    float t = dot(toC, L);
    if (t > 0.0) {
      float dPerp = length(toC - L * t);
      float coneR = sp.w + t * 0.24;
      float occ = (1.0 - smoothstep(sp.w * 0.3, coneR, dPerp)) * exp(-t * 0.1);
      shadowTint *= mix(vec3(1.0), mix(vec3(0.24), uPieceCol[i] * 0.88, 0.72), occ * 0.8);
    }

    // 2. Solid-angle ambient occlusion in shared crevices
    float rRatio = clamp(sp.w / max(dist, sp.w + 0.01), 0.0, 1.0);
    float sa = rRatio * rRatio * clamp(dot(N, dir) * 0.5 + 0.5, 0.0, 1.0);
    ao *= (1.0 - sa * 0.52);

    // 3. Colored bounce GI from illuminated neighbors
    float bounceFacing = clamp(dot(N, dir) * 0.65 + 0.35, 0.0, 1.0);
    float lightFactor = 0.45 + 0.55 * clamp(dot(dir, -L) * 0.5 + 0.5, 0.0, 1.0);
    bounceGI += uPieceCol[i] * (sa * bounceFacing * lightFactor * 0.72);
  }
  ao = clamp(ao, 0.35, 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec3 V = normalize(cameraPos - vWorldPos);
  vec3 nGeo = normalize(vWorldNormal);
  if (dot(nGeo, V) < 0.02) nGeo = normalize(nGeo + V * (0.02 - dot(nGeo, V)));

  // Fine, velvety frosted micro-pitting in object space
  float frostAmt = uFrosting * (0.45 + 0.55 * uErosion) * (0.55 + 0.55 * vWear);
  float wetReduce = 1.0 - 0.65 * uWetness;
  vec3 op = vObjectPos + vec3(uPieceSeed * 1.73, uPieceSeed * 3.11, uPieceSeed * 0.91);
  float eps = 0.0025;
  float h0 = pitField(op, 70.0) * 0.6 + valueNoise3(op * 260.0) * 0.4;
  float hx = pitField(op + vec3(eps, 0.0, 0.0), 70.0) * 0.6 + valueNoise3((op + vec3(eps, 0.0, 0.0)) * 260.0) * 0.4;
  float hy = pitField(op + vec3(0.0, eps, 0.0), 70.0) * 0.6 + valueNoise3((op + vec3(0.0, eps, 0.0)) * 260.0) * 0.4;
  float hz = pitField(op + vec3(0.0, 0.0, eps), 70.0) * 0.6 + valueNoise3((op + vec3(0.0, 0.0, eps)) * 260.0) * 0.4;
  vec3 grad = vec3(hx - h0, hy - h0, hz - h0) / eps;
  grad -= nGeo * dot(grad, nGeo);
  vec3 n = normalize(nGeo - grad * (0.0022 * frostAmt * wetReduce));
  if (dot(n, V) < 0.06) n = normalize(n + V * (0.06 - dot(n, V)));

  float NdotV = clamp(dot(n, V), 0.04, 1.0);
  float rough = clamp(mix(mix(0.22, 0.6, uFrosting), 0.08, uWetness) * (0.85 + 0.25 * vWear), 0.06, 0.75);

  // Total solid glass thickness along the camera ray (sums all segments cleanly without internal edges)
  float thick = max(texelFetch(tThick, ivec2(gl_FragCoord.xy), 0).a, vThickness * 0.35);
  thick = clamp(thick, 0.03, 4.0);

  // Solid entry refraction with stronger chromatic dispersion
  float iorDisp = uDispersion * 0.14;
  vec3 rd1 = refract(-V, n, 1.0 / uIor);
  if (length(rd1) < 0.01) rd1 = reflect(-V, n);
  rd1 = normalize(rd1);
  vec3 rd1R = refract(-V, n, 1.0 / (uIor + iorDisp));
  vec3 rd1B = refract(-V, n, 1.0 / max(1.01, uIor - iorDisp));
  vec3 rd2R = length(rd1R) > 0.01 ? normalize(rd1R) : rd1;
  vec3 rd2G = rd1;
  vec3 rd2B = length(rd1B) > 0.01 ? normalize(rd1B) : rd1;
  vec3 exitN = -n;

  // Physical parallax shift from travelling thick inside the glass + exit bend, always driven by IOR
  float edge = pow(1.0 - NdotV, 1.8);
  float iorScale = max(0.2, (uIor - 1.0) * 1.9);
  float shiftScale = iorScale * (0.35 + 0.65 * uRefraction) * (0.05 + 0.12 * thick + 0.06 * edge);
  vec2 uvR = uv + vec2(dot(rd2R - (-V), camRight), dot(rd2R - (-V), camUp)) * shiftScale;
  vec2 uvG = uv + vec2(dot(rd2G - (-V), camRight), dot(rd2G - (-V), camUp)) * shiftScale;
  vec2 uvB = uv + vec2(dot(rd2B - (-V), camRight), dot(rd2B - (-V), camUp)) * shiftScale;

  // Heavy frosted diffusion & wide interior scatter: melts sharp silhouettes behind the glass
  float blurLod = clamp(uDiffusion * (0.45 + 0.55 * uFrosting) * (1.0 - 0.55 * uWetness) * (2.6 + 2.2 * thick + 1.4 * edge), 0.25, 5.0);
  // 4-tap rotated scatter around the refracted UV to disperse & soften crisp edges behind frosted glass
  float scatterRad = uFrosting * (1.0 - 0.55 * uWetness) * (0.012 + 0.026 * edge + 0.016 * thick);
  float angJ = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.283185;
  vec2 j0 = vec2(cos(angJ), sin(angJ)) * scatterRad;
  vec2 j1 = vec2(-j0.y, j0.x);
  vec3 bg = vec3(0.0);
  for (int i = 0; i < uLoops.y; i++) {
    vec2 j = (i == 0 ? j0 : i == 1 ? -j0 : i == 2 ? j1 : -j1);
    bg += vec3(samplePyramid(uvR + j, blurLod).r, samplePyramid(uvG + j, blurLod).g, samplePyramid(uvB + j, blurLod).b);
  }
  bg *= 0.25;

  // Ring pieces: trace the inside of the fitted torus instead of the screen-space shift.
  // Frosted glass scatters the entering ray, so a few rays spread over a cone are averaged.
#ifdef TRACE
  {
    float frost = uFrosting * (1.0 - 0.55 * uWetness);
    int rays = frost > 0.15 ? 2 : 1;
    float cone = rays > 1 ? 0.06 + 0.22 * frost : 0.0;
    vec3 acc = vec3(0.0);
    float lenAcc = 0.0;
    for (int i = 0; i < rays; i++) {
      float a = 0.785 + float(i) * 3.1416;
      float lenInside;
      acc += traceRay(rd1, V, vec2(cos(a), sin(a)) * cone, rough, blurLod, frost * 1.2, lenInside);
      lenAcc += lenInside;
    }
    // Frost scatters what the tracer resolves: the frostier the piece, the more it falls back to the diffuse look
    // the other pieces have, keeping only a hint of the lensing inside
    float frostMix = clamp(frost * 1.1, 0.0, 0.85);
    bg = mix(acc / float(rays), bg, frostMix);
    thick = mix(clamp(lenAcc / float(rays), 0.03, 4.0), thick, frostMix);
  }
#endif

  // Volumetric 3D internal march along the refracted ray rd1:
  // integrates solid glass absorption, internal micro-bubbles, and volumetric swirls.
  vec3 rd1Obj = normalize(uInvModelRot * rd1);
  vec3 swirlScatter = vec3(0.0);
  float swirlTrans = 1.0;
  float bubbleGlow = 0.0;
  {
    int STEPS = uLoops.x;
    float stepLen = thick / float(STEPS);
    vec3 sigmaV = -log(max(uColor, vec3(0.015))) * uDensity;
    for (int i = 0; i < STEPS; i++) {
      float t = (float(i) + 0.5) * stepLen;
      vec3 sp = vObjectPos + rd1Obj * t;
      // Subtle suspended micro-bubbles / mineral specks inside solid glass
      float bCell = pitField(sp + vec3(uPieceSeed * 0.7), 9.5);
      float bubble = smoothstep(0.08, 0.0, bCell) * 0.18;
      bubbleGlow += swirlTrans * bubble * stepLen;

      if (vPieceType > 1.5) {
        // Latticino cane: thin white threads spiralling at a fixed radius inside the rod (along x)
        float rr = length(sp.yz) / max(uRodRadius, 1e-3);
        float a = atan(sp.z, sp.y);
        float spiral = cos(6.0 * a - sp.x / max(uRodRadius, 1e-3) * 1.6 + uPieceSeed);
        float threads = exp(-pow((rr - 0.55) / 0.16, 2.0)) * smoothstep(0.75, 0.97, spiral);
        float alpha = 1.0 - exp(-threads * 6.0 * stepLen / max(uRodRadius, 1e-3));
        swirlScatter += swirlTrans * alpha * vec3(0.96, 0.97, 0.99) * exp(-sigmaV * t);
        swirlTrans *= (1.0 - alpha * 0.7);
      } else if (vPieceType > 0.5) {
        // Pole-free 3D Cartesian domain-warped glass ribbons (no atan polar pinching)
        float angS = uPieceSeed * 1.37;
        float cs = cos(angS), sn = sin(angS);
        vec3 q = vec3(sp.x * cs - sp.z * sn, sp.y, sp.x * sn + sp.z * cs);
        // Smooth 3D molten-glass twist & fold
        float tw = q.x * 3.4 + sin(q.y * 4.2 + q.z * 3.6) * 0.65;
        float ct = cos(tw), st = sin(tw);
        vec2 yz = vec2(q.y * ct - q.z * st, q.y * st + q.z * ct);
        vec3 w = vec3(q.x, yz.x, yz.y);
        // Folded ribbon sheets + subtle 3D gyroid filament
        float sheet1 = sin(w.y * 6.5 + sin(w.z * 4.0 + w.x * 2.5) * 1.1);
        float sheet2 = cos(w.z * 5.5 + sin(w.x * 4.5 - w.y * 3.0) * 1.1);
        float falloff = exp(-dot(sp, sp) * 2.2);
        float ribW = exp(-pow(sheet1 * 2.8, 2.0)) * falloff;
        float ribD = exp(-pow(sheet2 * 3.0, 2.0)) * falloff;
        float dens = (ribW * 2.5 + ribD * 1.9) * stepLen;
        vec3 ribCol = mix(uColor * 0.32, vec3(0.96, 0.97, 0.99), ribW / max(ribW + ribD, 1e-4));
        vec3 localAbs = exp(-sigmaV * t);
        float alpha = 1.0 - exp(-dens);
        swirlScatter += swirlTrans * alpha * ribCol * localAbs;
        swirlTrans *= (1.0 - alpha * 0.78);
      }
    }
  }

  // Solid Beer-Lambert absorption + subtle volumetric scattering so glass stays genuinely translucent
  vec3 sigma = max(-log(max(uColor, vec3(0.015))) * uDensity, vec3(0.32));
  vec3 sigmaT = sigma + vec3(0.45 + 0.65 * uFrosting * (1.0 - 0.5 * uWetness));
  vec3 beer = exp(-sigma * (thick * 1.05));
  vec3 volOpacity = vec3(1.0) - exp(-sigmaT * (thick * 0.85));

  // Purely solid transmitted background (attenuated by Beer-Lambert & swirl opacity)
  vec3 through = bg * beer * swirlTrans;

  // Directional light interaction: soft colored shadows, AO, bounce GI, backlit & forward scatter
  vec3 L = normalize(lightDirection);
  vec3 shadowTint;
  float ao;
  vec3 bounceGI;
  computeClusterLighting(vWorldPos, n, L, shadowTint, ao, bounceGI);

  // Physically-based radiative transfer:
  // - studioFront: directional SH irradiance entering the front/side surface (AO-attenuated)
  // - studioBack / studioSide: studio light entering from behind and sides, Beer-Lambert attenuated through thick glass
  // - key light: soft colored shadows, forward Henyey-Greenstein, backlit & wrapped subsurface
  vec3 studioFront = max(evalSH(envRotation * n), vec3(0.0)) * envIntensity * ao;
  vec3 studioBack = max(evalSH(envRotation * -n), vec3(0.0)) * envIntensity * beer;
  vec3 studioSide = max(evalSH(envRotation * rd1), vec3(0.0)) * envIntensity * beer;

  float cosL = dot(-V, L);
  const float g = 0.45;
  float hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cosL, 1.5));
  float backLit = pow(clamp(dot(-n, L) * 0.5 + 0.5, 0.0, 1.0), 1.5);
  float frontWrap = pow(clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0), 1.35);

  vec3 keySubsurface = lightColor * shadowTint * (hg * 0.42 + backLit * 0.36 + frontWrap * 0.34);
  vec3 scatterLight = studioFront * 0.52 + (studioBack * 0.32 + studioSide * 0.24) + keySubsurface + bounceGI * (0.65 + 0.35 * uTranslucency);

  // Solid interior body color: translucent jewel core, luminous where light enters sides/thin edges
  vec3 solidAlbedo = uColor * mix(vec3(0.42), vec3(1.10), beer) * (0.35 + 0.65 * uTranslucency);
  vec3 internalScatter = scatterLight * (solidAlbedo * volOpacity * 0.36 + swirlScatter * 0.85 + uColor * bubbleGlow * 0.45)
    + (studioBack + studioSide) * 0.16 * uColor * beer * (0.5 + 0.5 * uTranslucency);

  // Energy-conserving rough dielectric BRDF (single + multiple scattering, Turquin / Jimenez)
  float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
  vec2 dfg = EnvBRDFApprox(rough, NdotV);
  vec3 FssEss = vec3(f0 * dfg.x + dfg.y);
  float Ems = 1.0 - (dfg.x + dfg.y);
  vec3 Favg = vec3(f0 + (1.0 - f0) * 0.047619);
  vec3 multiScatter = FssEss * Favg / (1.0 - Ems * Favg) * Ems;
  vec3 enterReflect = FssEss + multiScatter;

  vec3 H = normalize(L + V);
  float NdotL = clamp(dot(n, L), 0.0, 1.0);
  float a = rough * rough;
  vec3 keySpec = lightColor * shadowTint * NdotL * F_Schlick(clamp(dot(V, H), 0.0, 1.0), vec3(f0))
    * D_GGX(clamp(dot(n, H), 0.0, 1.0), a) * V_SmithGGXCorrelated(a, NdotV, NdotL) * lightSpecular * 1.35;
  vec3 spec = (env(reflect(-V, n), rough) * FssEss * 1.25 + multiScatter * studioFront * 0.65) * mix(1.0, ao, 0.65) + keySpec;

  // Thin rims pass the light from behind, saturated by the glass colour.
  float thinness = 1.0 - smoothstep(0.04, 0.4, thick);
  vec3 rimGlow = (studioBack + lightColor * shadowTint * backLit * 0.25) * uColor * thinness * (0.35 + 0.65 * uTranslucency);

  // Light piping: where the view runs along the glass, light carried inside it leaves saturated instead of dark.
  float pipe = smoothstep(1.6, 4.0, thick / max(vThickness, 0.02));
  vec3 pipeCol = exp(-sigma * 0.35) * (meanRadiance() * 1.4 + lightColor * shadowTint * 0.12) * (0.4 + 0.6 * uTranslucency);
  through = mix(through, max(through, pipeCol), pipe);

  // Frosted skin: a milky diffuse veil over the coloured body, thinner when wet.
  float veil = uFrosting * (1.0 - 0.7 * uWetness) * (0.12 + 0.3 * pow(1.0 - NdotV, 1.5)) * (0.75 + 0.25 * vWear);
  vec3 veilLight = studioFront + lightColor * shadowTint * NdotL * (1.0 / PI);
  vec3 veilCol = veilLight * mix(vec3(0.9), uColor, 0.55);

  vec3 body = mix(through + internalScatter + rimGlow, veilCol, veil);
  // Swirl ribbons are opaque white glass inside: lit on their own and seen through most of the frosted veil
  body += swirlScatter * (meanRadiance() * 1.4 + keySubsurface * 0.6) * (1.0 - 0.5 * veil);
  vec3 color = clamp(spec + body * (vec3(1.0) - enterReflect), vec3(0.0), vec3(24.0));
  outColor = vec4(color, 1.0);
}
`;

export const GLASS_KEYS = ["frosting", "wetness", "diffusion", "ior", "refraction", "dispersion", "translucency"];
const GLASS_UNIFORMS = {
  frosting: "uFrosting",
  wetness: "uWetness",
  diffusion: "uDiffusion",
  ior: "uIor",
  refraction: "uRefraction",
  dispersion: "uDispersion",
  translucency: "uTranslucency",
};

function makeTarget(w, h, depthBuffer = false, type = HalfFloatType, filter = LinearFilter) {
  return new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer,
    stencilBuffer: false,
  });
}

// The outgoing environment during a crossfade, shared by the backdrop and the glass
export const envFadeUniforms = {
  envMapPrev: { value: null },
  envMapMaxLodPrev: { value: 0 },
  envIntensityPrev: { value: 1 },
  uEnvFade: { value: 1 },
};

export class GlassCompositeRenderer {
  constructor() {
    this.width = 0;
    this.height = 0;

    this.accumA = null;
    this.accumB = null;
    this.thickTarget = null;
    this.pyramid = [];
    this.blurTemp = [];

    this.quadGeo = new BufferGeometry();
    this.quadGeo.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.copyMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: copyFragment,
      uniforms: { tInput: { value: null }, weight: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.copyScene = new Scene();
    this.copyScene.add(new Mesh(this.quadGeo, this.copyMat));

    this.envBgMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: envBgFragment,
      uniforms: {
        ...globalUniforms,
        ...envFadeUniforms,
        inverseViewProjection: { value: new Matrix4() },
        cameraPos: { value: new Vector3() },
        uBgBlur: { value: 0.55 },
        tSolid: { value: null },
        uSolid: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.envBgScene = new Scene();
    this.envBgScene.add(new Mesh(this.quadGeo, this.envBgMat));

    this.blurMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: blurFragment,
      uniforms: {
        tSource: { value: null },
        texel: { value: new Vector2() },
        dir: { value: new Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurScene = new Scene();
    this.blurScene.add(new Mesh(this.quadGeo, this.blurMat));

    this.thickMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glassVertex,
      fragmentShader: thickFragment,
      uniforms: {
        cameraPos: { value: new Vector3() },
        refDist: { value: 1 },
        uErosion: { value: 0.85 },
        uPatternErosion: { value: 0.85 },
      },
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    });

    this.depthMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glassVertex,
      fragmentShader: depthFragment,
      uniforms: { uErosion: { value: 0.85 }, uPatternErosion: { value: 0.85 } },
      side: FrontSide,
      colorWrite: false,
    });

    this.wireMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glassVertex,
      fragmentShader: wireFragment,
      uniforms: { uErosion: { value: 0.85 }, uPatternErosion: { value: 0.85 }, uWireColor: { value: new Color(0.9, 0.95, 1.0) } },
      wireframe: true,
      depthWrite: false,
    });

    this.glassMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glassVertex,
      fragmentShader: glassFragment,
      uniforms: {
        ...globalUniforms,
        ...envFadeUniforms,
        tPyr0: { value: null },
        tPyr1: { value: null },
        tPyr2: { value: null },
        tPyr3: { value: null },
        tPyr4: { value: null },
        tPyr5: { value: null },
        tThick: { value: null },
        resolution: { value: new Vector2() },
        texel1: { value: new Vector2() },
        texel2: { value: new Vector2() },
        texel3: { value: new Vector2() },
        texel4: { value: new Vector2() },
        texel5: { value: new Vector2() },
        cameraPos: { value: new Vector3() },
        camRight: { value: new Vector3() },
        camUp: { value: new Vector3() },
        uInvModelRot: { value: new Matrix3() },
        uColor: { value: new Color(1, 1, 1) },
        uErosion: { value: 0.85 },
        uPatternErosion: { value: 0.85 },
        uFrosting: { value: 0.72 },
        uWetness: { value: 0.15 },
        uDiffusion: { value: 0.78 },
        uRefraction: { value: 0.65 },
        uDispersion: { value: 0.35 },
        uDensity: { value: 4.2 },
        uTranslucency: { value: 0.75 },
        uIor: { value: 1.52 },
        uPieceSeed: { value: 1 },
        uPieceCount: { value: 0 },
        uPieceIndex: { value: 0 },
        uPiecePosR: { value: Array.from({ length: 36 }, () => new Vector4()) },
        uTraceLoops: { value: [48, 6, 5, 32] },
        uTraceBranches: { value: 2 },
        uLoops: { value: [8, 4] },
        uRodRadius: { value: 0 },
        uTorus: { value: new Vector4(1, 0.3, 0.3, 0) },
        uTorusWobble: { value: new Vector3() },
        uTorusCenter: { value: new Vector3() },
        uTorusSquare: { value: 2 },
        uPieceCenter: { value: new Vector3() },
        uViewProj: { value: new Matrix4() },

        uPieceCol: { value: Array.from({ length: 36 }, () => new Color()) },
      },
      side: FrontSide,
      depthTest: true,
      depthWrite: true,
    });
    // Rings and tori only: the tracer is large enough to slow every piece if compiled into the shared shader.
    this.glassTraceMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: glassVertex,
      fragmentShader: glassFragment,
      uniforms: this.glassMat.uniforms,
      defines: { TRACE: 1 },
      side: FrontSide,
      depthTest: true,
      depthWrite: true,
    });

    this.traceReady = false;
    this.layerScene = new Scene();
    this._camFwd = new Vector3();
    this._corner = new Vector3();
    this._key = [];
    this._lastKey = [];
    this._lastOut = null;
    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._proj = new Vector3();
    this._viewProj = new Matrix4();
    this._clearColor = new Color();

    this.settings = {
      density: 4.2,
      // 1: the blurred environment behind the glass, 0: the solid backdrop
      envMix: 1,
      bgBlur: 0.55,
      wireframe: false,
    };
  }

  // Compiles the programs up front (a piece geometry supplies the glass attributes), so nothing compiles mid-animation.
  // The tracer variant takes seconds, so it compiles in the background; rings use the plain glass until it is ready.
  compileAsync(renderer, camera, geometry) {
    const scene = (materials, geo) => {
      const s = new Scene();
      for (const m of materials) s.add(new Mesh(geo, m));
      return s;
    };
    renderer.compileAsync(scene([this.glassTraceMat], geometry), camera).then(() => (this.traceReady = true));
    const core = scene([this.thickMat, this.depthMat, this.wireMat, this.glassMat], geometry);
    for (const m of [this.copyMat, this.envBgMat, this.blurMat]) core.add(new Mesh(this.quadGeo, m));
    return renderer.compileAsync(core, camera);
  }

  ensureSize(width, height) {
    if (this.width === width && this.height === height) return;
    this.disposeTargets();
    this.width = width;
    this.height = height;

    // The ping-pong targets share one depth texture, so depth carries from layer to layer without redrawing it.
    this.sharedDepth = new DepthTexture(width, height);
    this.accumA = makeTarget(width, height, true);
    this.accumB = makeTarget(width, height, true);
    this.accumA.depthTexture = this.sharedDepth;
    this.accumB.depthTexture = this.sharedDepth;
    this.thickTarget = makeTarget(width, height, false, HalfFloatType, NearestFilter);

    for (let i = 1; i < PYRAMID_LEVELS; i++) {
      const w = Math.max(1, width >> i);
      const h = Math.max(1, height >> i);
      this.pyramid[i] = makeTarget(w, h, false);
      this.blurTemp[i] = makeTarget(w, h, false);
    }
  }

  disposeTargets() {
    this._lastOut = null;
    this.accumA?.dispose();
    this.accumB?.dispose();
    this.sharedDepth?.dispose();
    this.thickTarget?.dispose();
    for (const t of this.pyramid) t?.dispose?.();
    for (const t of this.blurTemp) t?.dispose?.();
    this.pyramid.length = 0;
    this.blurTemp.length = 0;
  }

  // dirty: the full-res pixel rect [x0, y0, x1, y1] that changed since the last build, or null to rebuild it all. Each
  // level then redoes only that rect, grown by its blur's reach (the targets keep the rest from the last build).
  buildPyramid(renderer, sourceTex, dirty = null) {
    this.pyramid[0] = { texture: sourceTex };
    let rect = dirty;
    for (let i = 1; i < PYRAMID_LEVELS; i++) {
      const dst = this.pyramid[i];
      const tmp = this.blurTemp[i];
      const prev = this.pyramid[i - 1];
      if (rect) {
        rect = [Math.floor(rect[0] / 2) - 10, Math.floor(rect[1] / 2) - 10, Math.ceil(rect[2] / 2) + 10, Math.ceil(rect[3] / 2) + 10];
        rect = [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(dst.width, rect[2]), Math.min(dst.height, rect[3])];
        if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
      }
      const texelX = 1 / dst.width;
      const texelY = 1 / dst.height;

      this.blurMat.uniforms.tSource.value = prev.texture;
      this.blurMat.uniforms.texel.value.set(texelX, texelY);
      this.blurMat.uniforms.dir.value.set(1, 0);
      setScissor(tmp, rect);
      renderer.setRenderTarget(tmp);
      renderer.render(this.blurScene, this.quadCam);

      this.blurMat.uniforms.tSource.value = tmp.texture;
      this.blurMat.uniforms.dir.value.set(0, 1);
      setScissor(dst, rect);
      renderer.setRenderTarget(dst);
      renderer.render(this.blurScene, this.quadCam);
      setScissor(tmp, null);
      setScissor(dst, null);
    }
  }

  // Full-res pixel rect [x0, y0, x1, y1] (bottom-left origin) covering the pieces, or null when one reaches behind
  // the camera: the projected corners of a camera-aligned box around each piece's bounding sphere.
  screenRect(pieces) {
    const r = [Infinity, Infinity, -Infinity, -Infinity];
    const c = this._corner;
    const e = this._viewProj.elements;
    for (const p of pieces) {
      const R = p.visualRadius * 1.05;
      for (let k = 0; k < 8; k++) {
        c.copy(p.pos)
          .addScaledVector(this._camRight, k & 1 ? R : -R)
          .addScaledVector(this._camUp, k & 2 ? R : -R)
          .addScaledVector(this._camFwd, k & 4 ? R : -R);
        const w = e[3] * c.x + e[7] * c.y + e[11] * c.z + e[15];
        if (w <= 0.05) return null;
        const x = ((e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12]) / w) * 0.5 + 0.5;
        const y = ((e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13]) / w) * 0.5 + 0.5;
        r[0] = Math.min(r[0], x);
        r[1] = Math.min(r[1], y);
        r[2] = Math.max(r[2], x);
        r[3] = Math.max(r[3], y);
      }
    }
    const x0 = Math.max(0, Math.floor(r[0] * this.width) - 2);
    const y0 = Math.max(0, Math.floor(r[1] * this.height) - 2);
    return [x0, y0, Math.max(x0, Math.min(this.width, Math.ceil(r[2] * this.width) + 2)), Math.max(y0, Math.min(this.height, Math.ceil(r[3] * this.height) + 2))];
  }

  // Partition back-to-front sorted pieces into layers where no two pieces in the same layer overlap on screen.
  partitionLayers(pieces, camera) {
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    camera.getWorldDirection(this._camFwd);

    const aspect = this.width / Math.max(1, this.height);
    const fovScale = camera.projectionMatrix.elements[5]; // 1 / tan(fov/2)

    const projected = pieces.map((p) => {
      const rel = p.pos.clone().sub(camera.position);
      const depth = rel.dot(this._camFwd);
      const v = p.pos.clone().applyMatrix4(this._viewProj);
      const rNdc = (p.visualRadius * fovScale) / Math.max(0.25, depth);
      return { piece: p, depth, x: v.x * aspect, y: v.y, r: rNdc };
    });

    // Sort far -> near
    projected.sort((a, b) => b.depth - a.depth);

    const layers = [];
    let current = [];
    for (const item of projected) {
      let overlaps = false;
      for (const other of current) {
        const dx = item.x - other.x;
        const dy = item.y - other.y;
        const rr = item.r + other.r;
        if (dx * dx + dy * dy < rr * rr) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        layers.push(current.map((c) => c.piece));
        current = [item];
      } else {
        current.push(item);
      }
    }
    if (current.length) layers.push(current.map((c) => c.piece));
    return layers;
  }

  // Everything the composite reads, flattened; an unchanged key (paused, view still) reuses the last image.
  stateKey(hdrTexture, camera, width, height, pieces) {
    const k = this._key;
    k.length = 0;
    const push = (v) => {
      if (typeof v === "number" || typeof v === "boolean") k.push(+v);
      else if (Array.isArray(v) || ArrayBuffer.isView(v)) for (const x of v) push(x);
      else if (v?.isTexture) k.push(v.id, v.version);
      else if (v?.elements) for (const x of v.elements) k.push(x);
      else if (v?.toArray) k.push(...v.toArray());
      else if (v?.isWebGLRenderTarget || v?.isRenderTarget) k.push(v.texture.id);
      else k.push(v ? 1 : 0);
    };
    push(width);
    push(height);
    push(hdrTexture);
    push(camera.matrixWorld);
    push(camera.projectionMatrix);
    push(this.traceReady);
    for (const v of Object.values(this.settings)) push(v);
    for (const [name, u] of Object.entries(globalUniforms)) if (name !== "frame") push(u.value);
    for (const u of Object.values(envFadeUniforms)) push(u.value);
    for (const p of pieces) {
      push(p.mesh.geometry.id);
      push(p.mesh.matrixWorld);
      push(p.color);
      push(p.look.erosion);
      push(p.patternErosion);
      for (const key of GLASS_KEYS) k.push(p.look[key][0], p.look[key][1]);
    }
    return k;
  }

  render(renderer, hdrTexture, { camera, width, height }, pieces) {
    if (!pieces.length) return hdrTexture;
    this.ensureSize(width, height);
    const key = this.stateKey(hdrTexture, camera, width, height, pieces);
    const last = this._lastKey;
    // The solid backdrop comes from the pipeline's own frame, which this key can't see, so only the HDR backdrop reuses
    if (this._lastOut && this.settings.envMix >= 0.999 && last.length === key.length && key.every((v, i) => v === last[i])) return this._lastOut;
    [this._key, this._lastKey] = [last, key];

    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this._clearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    // Seed accumA with either the blurred HDR environment or the solid pipeline backdrop
    renderer.autoClear = false;
    renderer.setRenderTarget(this.accumA);
    renderer.clear(true, true, false);
    if (this.settings.envMix > 0.001 && globalUniforms.envMap.value) {
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.envBgMat.uniforms.inverseViewProjection.value.copy(this._viewProj).invert();
      this.envBgMat.uniforms.cameraPos.value.copy(camera.position);
      this.envBgMat.uniforms.uBgBlur.value = this.settings.bgBlur;
      this.envBgMat.uniforms.tSolid.value = hdrTexture;
      this.envBgMat.uniforms.uSolid.value = 1 - this.settings.envMix;
      renderer.render(this.envBgScene, this.quadCam);
    } else {
      this.copyMat.uniforms.tInput.value = hdrTexture;
      renderer.render(this.copyScene, this.quadCam);
    }

    let currAccum = this.accumA;
    let nextAccum = this.accumB;

    const layers = this.partitionLayers(pieces, camera);
    this.glassMat.uniforms.uViewProj.value.copy(this._viewProj);

    this._camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    const gu = this.glassMat.uniforms;
    gu.resolution.value.set(width, height);
    gu.cameraPos.value.copy(camera.position);
    gu.camRight.value.copy(this._camRight);
    gu.camUp.value.copy(this._camUp);
    gu.uDensity.value = this.settings.density;

    pieces.forEach((p, i) => (p.slot = i));
    const pCount = Math.min(36, pieces.length);
    gu.uPieceCount.value = pCount;
    for (let i = 0; i < pCount; i++) {
      const p = pieces[i];
      gu.uPiecePosR.value[i].set(p.pos.x, p.pos.y, p.pos.z, p.radius * 0.85);
      gu.uPieceCol.value[i].copy(p.color);
    }

    this.thickMat.uniforms.cameraPos.value.copy(camera.position);
    this.thickMat.uniforms.refDist.value = camera.position.length();

    // What the previous layer drew over: the only part of the image (and pyramid) that changed since
    let dirty = null;
    let first = true;
    for (const layer of layers) {
      const rect = this.screenRect(layer);
      // 1. Blur pyramid of everything behind this layer
      this.buildPyramid(renderer, currAccum.texture, first ? null : dirty);

      // 2. Additive total optical thickness for this layer's pieces (zero internal edges)
      setScissor(this.thickTarget, rect);
      renderer.setRenderTarget(this.thickTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      for (const p of layer) this.drawThickness(renderer, camera, p);
      setScissor(this.thickTarget, null);

      // 3. Start the layer from everything so far, with earlier layers' depth
      this.beginLayer(renderer, currAccum, nextAccum, first ? null : dirty);
      dirty = rect;
      first = false;

      // 4. Shade each piece's outer surface against the blurred pyramid and its thickness
      this.setPyramidUniforms();
      gu.tThick.value = this.thickTarget.texture;
      for (const p of layer) {
        this.shadePiece(renderer, camera, p);
      }

      [currAccum, nextAccum] = [nextAccum, currAccum];
    }

    if (this.settings.wireframe) this.drawWireframe(renderer, camera, currAccum, pieces);

    this.layerScene.children.length = 0;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(this._clearColor, prevClearAlpha);
    this._lastOut = currAccum.texture;
    return currAccum.texture;
  }

  setPyramidUniforms() {
    const gu = this.glassMat.uniforms;
    for (let i = 0; i < PYRAMID_LEVELS; i++) gu[`tPyr${i}`].value = this.pyramid[i].texture;
    for (let i = 1; i < PYRAMID_LEVELS; i++) gu[`texel${i}`].value.set(1 / this.pyramid[i].width, 1 / this.pyramid[i].height);
  }

  // Starts a layer's target from everything so far; the shared depth already holds the earlier layers'.
  // Only `dirty` (the last layer's rect) differs between the two, or everything when it is null.
  beginLayer(renderer, source, target, dirty = null) {
    this.copyMat.uniforms.tInput.value = source.texture;
    setScissor(target, dirty);
    renderer.setRenderTarget(target);
    renderer.render(this.copyScene, this.quadCam);
    setScissor(target, null);
    renderer.setRenderTarget(target);
  }

  // One piece with a pass material, at its own erosion (pieces each carry their look).
  drawPiece(renderer, camera, p, material) {
    material.uniforms.uErosion.value = p.look.erosion;
    material.uniforms.uPatternErosion.value = p.patternErosion;
    p.mesh.material = material;
    this.layerScene.children.length = 0;
    this.layerScene.children.push(p.mesh);
    renderer.render(this.layerScene, camera);
  }

  drawThickness(renderer, camera, p) {
    this.drawPiece(renderer, camera, p, this.thickMat);
  }

  shadePiece(renderer, camera, p) {
    const gu = this.glassMat.uniforms;
    gu.uColor.value.copy(p.color);
    gu.uPieceSeed.value = p.index + 1;
    gu.uPieceIndex.value = p.slot;
    gu.uInvModelRot.value.setFromMatrix4(p.mesh.matrixWorld).transpose();
    gu.uRodRadius.value = p.mesh.geometry.userData.rodRadius ?? 0;
    for (const key of GLASS_KEYS) {
      const [lo, hi] = p.look[key];
      gu[GLASS_UNIFORMS[key]].value = lo + (hi - lo) * p.glassRolls[key];
    }
    const torus = p.mesh.geometry.userData.torus;
    if (torus) {
      const e = p.look.erosion;
      const mix = (k) => torus.raw[k] + (torus.eroded[k] - torus.raw[k]) * e;
      gu.uTorus.value.set(mix("R"), mix("a"), mix("b"), torus.wobble);
      // The torus thread is part of its pattern: 2.4x deeper raw than worn
      gu.uTorusWobble.value.set(torus.phase, torus.wobbleTube, torus.thread * (2.4 - 1.4 * p.patternErosion));
      gu.uTorusSquare.value = mix("square");
      const cr = torus.raw.center;
      const ce = torus.eroded.center;
      gu.uTorusCenter.value.set(cr[0] + (ce[0] - cr[0]) * e, cr[1] + (ce[1] - cr[1]) * e, cr[2] + (ce[2] - cr[2]) * e);
      gu.uPieceCenter.value.copy(p.mesh.position);
    }
    this.drawPiece(renderer, camera, p, torus && this.traceReady ? this.glassTraceMat : this.glassMat);
  }

  // Wires over the finished image, with lines hidden behind any piece removed by a depth pre-pass.
  drawWireframe(renderer, camera, target, pieces) {
    renderer.setRenderTarget(target);
    renderer.clear(false, true, false);
    this.depthMat.polygonOffset = true;
    this.depthMat.polygonOffsetFactor = 1;
    this.depthMat.polygonOffsetUnits = 1;
    for (const material of [this.depthMat, this.wireMat]) for (const p of pieces) this.drawPiece(renderer, camera, p, material);
    this.depthMat.polygonOffset = false;
  }

  dispose() {
    this.disposeTargets();
    this.quadGeo.dispose();
    this.copyMat.dispose();
    this.envBgMat.dispose();
    this.blurMat.dispose();
    this.thickMat.dispose();
    this.depthMat.dispose();
    this.wireMat.dispose();
    this.glassMat.dispose();
    this.glassTraceMat.dispose();
  }
}
