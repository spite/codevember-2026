// FXAA on the display-encoded image (used when MSAA is off).
export const fxaaFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SPAN_MAX = 8.0;
const float REDUCE_MUL = 0.125;
const float REDUCE_MIN = 0.0078125;
const float EDGE_THRESHOLD = 0.166;
const float EDGE_THRESHOLD_MIN = 0.0833;

void main() {
  vec2 texel = 1.0 / vec2(textureSize(tInput, 0));
  vec3 middle = textureLod(tInput, vUv, 0.0).rgb;
  vec3 nw = textureLod(tInput, vUv + vec2(-1.0, -1.0) * texel, 0.0).rgb;
  vec3 ne = textureLod(tInput, vUv + vec2(1.0, -1.0) * texel, 0.0).rgb;
  vec3 sw = textureLod(tInput, vUv + vec2(-1.0, 1.0) * texel, 0.0).rgb;
  vec3 se = textureLod(tInput, vUv + vec2(1.0, 1.0) * texel, 0.0).rgb;

  float lNW = dot(nw, LUMA), lNE = dot(ne, LUMA), lSW = dot(sw, LUMA), lSE = dot(se, LUMA);
  float lM = dot(middle, LUMA);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(EDGE_THRESHOLD_MIN, lMax * EDGE_THRESHOLD)) {
    outColor = vec4(middle, 1.0);
    return;
  }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, -SPAN_MAX, SPAN_MAX) * texel;

  vec3 inner = 0.5 * (
    textureLod(tInput, vUv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb +
    textureLod(tInput, vUv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
  vec3 outer = inner * 0.5 + 0.25 * (
    textureLod(tInput, vUv - dir * 0.5, 0.0).rgb +
    textureLod(tInput, vUv + dir * 0.5, 0.0).rgb);
  float lOuter = dot(outer, LUMA);
  outColor = vec4((lOuter < lMin || lOuter > lMax) ? inner : outer, 1.0);
}
`;
