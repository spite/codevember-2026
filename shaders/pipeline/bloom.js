// Jimenez-style bloom: 13-tap downsample (Karis average on the first level) and tent upsample.
export const bloomDownFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 texel;
uniform float karis;
uniform float clampMax;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

vec3 tap(vec2 o) {
  vec3 c = textureLod(tInput, vUv + o * texel, 0.0).rgb;
  c = max(c, vec3(0.0));
  return min(c, vec3(clampMax));
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
}

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
  if (karis > 0.5) {
    float k0 = karisWeight(g0), k1 = karisWeight(g1), k2 = karisWeight(g2), k3 = karisWeight(g3), k4 = karisWeight(g4);
    vec3 sum = g0 * k0 * 0.5 + (g1 * k1 + g2 * k2 + g3 * k3 + g4 * k4) * 0.125;
    float wsum = k0 * 0.5 + (k1 + k2 + k3 + k4) * 0.125;
    outColor = vec4(sum / wsum, 1.0);
  } else {
    outColor = vec4(g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125, 1.0);
  }
}
`;

// Adds the tent-filtered lower level (scaled by radius) to this level's downsample.
export const bloomUpFragment = /* glsl */ `
precision highp float;
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 texel;
uniform float radius;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 s = textureLod(tLow, vUv + vec2(-1.0, -1.0) * texel, 0.0).rgb;
  s += textureLod(tLow, vUv + vec2(0.0, -1.0) * texel, 0.0).rgb * 2.0;
  s += textureLod(tLow, vUv + vec2(1.0, -1.0) * texel, 0.0).rgb;
  s += textureLod(tLow, vUv + vec2(-1.0, 0.0) * texel, 0.0).rgb * 2.0;
  s += textureLod(tLow, vUv, 0.0).rgb * 4.0;
  s += textureLod(tLow, vUv + vec2(1.0, 0.0) * texel, 0.0).rgb * 2.0;
  s += textureLod(tLow, vUv + vec2(-1.0, 1.0) * texel, 0.0).rgb;
  s += textureLod(tLow, vUv + vec2(0.0, 1.0) * texel, 0.0).rgb * 2.0;
  s += textureLod(tLow, vUv + vec2(1.0, 1.0) * texel, 0.0).rgb;
  outColor = vec4(textureLod(tHigh, vUv, 0.0).rgb + s / 16.0 * radius, 1.0);
}
`;
