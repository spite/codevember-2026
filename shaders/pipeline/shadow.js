// PCSS soft shadows for a directional key light. Expects the shadow uniforms of
// modules/pipeline/uniforms.js; `frame` (a global) drives the temporal rotation.
const shadowChunk = /* glsl */ `
#ifndef SHADOW_UNIFORMS_DECLARED
#define SHADOW_UNIFORMS_DECLARED
uniform highp sampler2D shadowMap;
uniform highp sampler2DShadow shadowMapCmp;
uniform mat4 shadowMatrix;
uniform vec2 shadowMapSize;
uniform float shadowLightSize;
uniform float shadowSoftness;
uniform float shadowBias;
uniform float shadowNormalBias;
uniform float shadowEnabled;
uniform float shadowMaxRadius;
#endif

#ifndef SHADOW_FRAME
#define SHADOW_FRAME frame
#endif
#ifndef SHADOW_BLOCKER_SAMPLES
#define SHADOW_BLOCKER_SAMPLES 24
#endif
#ifndef SHADOW_PCF_SAMPLES
#define SHADOW_PCF_SAMPLES 20
#endif

// Per-pixel white noise: without temporal accumulation it reads as grain, where IGN shows diagonal hatching.
vec2 shadowNoise(vec2 p) {
  uvec3 v = uvec3(ivec3(ivec2(p), int(mod(float(SHADOW_FRAME), 1024.0))));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x;
  return vec2(v.xy) * (1.0 / 4294967296.0);
}

// getShadow's PCF kernel radius in shadow uv (0 when it returned early), for the mask's blur.
float shadowKernelRadius = 0.0;

vec2 shadowVogel(int i, int n, float phi, float jitter) {
  float r = sqrt((float(i) + jitter) / float(n));
  float a = float(i) * 2.399963229728653 + phi;
  return r * vec2(cos(a), sin(a));
}

// Depth change per shadow uv across the receiver's plane (depth grows away from the light), length capped.
vec2 shadowPlaneGradient(vec3 N, float ndl, float worldPerUV, float worldPerDepth) {
  vec3 X = normalize(vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]));
  vec3 Y = normalize(vec3(shadowMatrix[0][1], shadowMatrix[1][1], shadowMatrix[2][1]));
  vec2 g = vec2(dot(N, X), dot(N, Y)) / max(ndl, 0.125) * (worldPerUV / worldPerDepth);
  return g;
}

// Compare reference at offset o: follows the plane where it rises toward the light (so wide kernels
// don't self-shadow tilted receivers) but never moves past the receiver where it falls away.
float shadowRef(float zR, vec2 grad, vec2 o, float texel) {
  return zR - shadowBias + min(dot(grad, o), 0.0) - length(grad) * texel;
}

float getShadow(vec3 worldPos, vec3 worldNormal) {
  shadowKernelRadius = 0.0;
  if (shadowEnabled < 0.5) return 1.0;

  // The shadow camera is orthographic with near = 0, so its scale and axis come out of the matrix.
  vec3 row0 = vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]);
  vec3 row2 = vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]);
  vec3 L = -normalize(row2);
  float worldPerUV = 2.0 / length(row0);
  float worldPerDepth = 2.0 / length(row2);

  vec3 N = normalize(worldNormal);
  float ndl = dot(N, L);
  if (ndl <= 0.0) return 1.0;
  // Normal offset grows with texel size and toward grazing, where acne starts.
  float texelWorld = worldPerUV / shadowMapSize.x;
  vec3 offset = N * (shadowNormalBias + texelWorld * (1.5 + 3.0 * (1.0 - ndl)));
  vec4 sc = shadowMatrix * vec4(worldPos + offset, 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;

  vec2 edge = min(c.xy, 1.0 - c.xy);
  float fade = smoothstep(0.0, 0.02, min(edge.x, edge.y)) * step(0.0, c.z);
  if (fade <= 0.0) return 1.0;

  // Receivers past the far plane compare at it (every caster is nearer); distances use the real depth.
  float zR = min(c.z, 1.0);
  vec2 grad = shadowPlaneGradient(N, ndl, worldPerUV, worldPerDepth);
  vec2 noise = shadowNoise(gl_FragCoord.xy);
  float phi = noise.x * 6.283185307179586;

  // shadowLightSize is tan(angular radius of the light); penumbra grows with the world-space gap.
  // The search covers the widest kernel softness can ask for.
  float texel = 1.0 / shadowMapSize.x;
  float searchRadius = clamp(shadowLightSize * max(shadowSoftness, 1.0) * c.z * worldPerDepth / worldPerUV, texel, shadowMaxRadius);
  // The receiver's own texel always counts, so a wide search cannot miss a contact blocker.
  float dC = textureLod(shadowMap, c.xy, 0.0).r;
  float blockers = dC < shadowRef(zR, grad, vec2(0.0), texel) ? 1.0 : 0.0;
  float blockerSum = dC * blockers;
  for (int i = 0; i < SHADOW_BLOCKER_SAMPLES; i++) {
    // Radius linear in i (not sqrt): denser near the centre, where small and contact blockers are.
    vec2 o = shadowVogel(i, SHADOW_BLOCKER_SAMPLES, phi, noise.y);
    o *= length(o) * searchRadius;
    float d = textureLod(shadowMap, c.xy + o, 0.0).r;
    if (d < shadowRef(zR, grad, o, texel)) {
      blockerSum += d;
      blockers += 1.0;
    }
  }
  if (blockers == 0.0) return 1.0;
  float zB = blockerSum / blockers;

  float penumbra = (c.z - zB) * worldPerDepth * shadowLightSize / worldPerUV;
  float radius = clamp(penumbra * shadowSoftness, texel, shadowMaxRadius);
  shadowKernelRadius = radius;

  // Hardware comparison: each tap is a bilinear 2x2 PCF. Zero gradients (not textureLod) keep
  // ANGLE/D3D from emitting a gradient sample inside divergent flow.
  float lit = 0.0;
  for (int i = 0; i < SHADOW_PCF_SAMPLES; i++) {
    vec2 o = shadowVogel(i, SHADOW_PCF_SAMPLES, phi, noise.y) * radius;
    lit += textureGrad(shadowMapCmp, vec3(c.xy + o, shadowRef(zR, grad, o, texel)), vec2(0.0), vec2(0.0));
  }
  float result = mix(1.0, lit / float(SHADOW_PCF_SAMPLES), fade);
  // Near the terminator direct light is ~0 anyway, and fading hides acne; only for blockers a few
  // texels away (self-shadowing), so shadows cast on receivers under a low light keep their strength.
  float selfShadow = 1.0 - smoothstep(2.0, 6.0, (c.z - zB) * worldPerDepth / texelWorld);
  return mix(1.0, result, mix(1.0, smoothstep(0.0, 0.12, ndl), selfShadow));
}

// Noise-free fixed-radius PCF (12 taps), for soft secondary terms that are never denoised.
float getShadowFixed(vec3 worldPos, vec3 worldNormal, float radiusTexels) {
  if (shadowEnabled < 0.5) return 1.0;
  vec3 row0 = vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]);
  vec3 row2 = vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]);
  vec3 L = -normalize(row2);
  float worldPerUV = 2.0 / length(row0);
  float worldPerDepth = 2.0 / length(row2);
  vec3 N = normalize(worldNormal);
  float ndl = dot(N, L);
  if (ndl <= 0.0) return 1.0;
  float texelWorld = worldPerUV / shadowMapSize.x;
  vec3 offset = N * (shadowNormalBias + texelWorld * (1.5 + 3.0 * (1.0 - ndl)));
  vec4 sc = shadowMatrix * vec4(worldPos + offset, 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  vec2 edge = min(c.xy, 1.0 - c.xy);
  float fade = smoothstep(0.0, 0.02, min(edge.x, edge.y)) * step(0.0, c.z);
  if (fade <= 0.0) return 1.0;
  float zR = min(c.z, 1.0);
  vec2 grad = shadowPlaneGradient(N, ndl, worldPerUV, worldPerDepth);
  float radius = radiusTexels / shadowMapSize.x;
  float lit = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 o = shadowVogel(i, 12, 0.0, 0.5) * radius;
    lit += textureGrad(shadowMapCmp, vec3(c.xy + o, shadowRef(zR, grad, o, 1.0 / shadowMapSize.x)), vec2(0.0), vec2(0.0));
  }
  return mix(1.0, lit / 12.0, fade * smoothstep(0.0, 0.12, ndl));
}
`;

export { shadowChunk };
