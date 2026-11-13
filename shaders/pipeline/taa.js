// Temporal resolve (opt-in, Pipeline `temporal`): blends this frame's jittered sample into the history, reprojected
// with the prepass velocity (taken from the nearest surface around the pixel, so edges move with what is in front)
// and clamped to the current neighbourhood's colour range (in YCoCg, by mean and spread), so stale history can't
// ghost. Noise from anything sampled stochastically per frame averages out here.
export const taaFragment = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tNormalVelocity;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float feedback;
uniform float hasHistory;
uniform float clampGamma;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Tonemapped weights, so a few very bright samples don't dominate the blend.
vec3 compress(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 expand(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }
// History through a Catmull-Rom filter (five bilinear taps), so resampling it every frame doesn't blur.
vec3 sampleHistory(vec2 uv) {
  vec2 pos = uv * resolution;
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c - 1.0) / resolution, t3 = (c + 2.0) / resolution, t12 = (c + w2 / w12) / resolution;
  vec3 r = textureLod(tHistory, vec2(t12.x, t0.y), 0.0).rgb * w12.x * w0.y
    + textureLod(tHistory, vec2(t0.x, t12.y), 0.0).rgb * w0.x * w12.y
    + textureLod(tHistory, t12, 0.0).rgb * w12.x * w12.y
    + textureLod(tHistory, vec2(t3.x, t12.y), 0.0).rgb * w3.x * w12.y
    + textureLod(tHistory, vec2(t12.x, t3.y), 0.0).rgb * w12.x * w3.y;
  float w = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / w, vec3(0.0));
}

void main() {
  vec2 texel = 1.0 / resolution;
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = ivec2(resolution) - 1;
  vec3 cur = compress(texelFetch(tCurrent, p, 0).rgb);
  // Neighbourhood statistics, and the nearest depth's velocity.
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  float nearest = 1.0;
  ivec2 nearestP = p;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = clamp(p + ivec2(x, y), ivec2(0), size);
    vec3 c = toYCoCg(compress(texelFetch(tCurrent, q, 0).rgb));
    m1 += c;
    m2 += c * c;
    float d = texelFetch(tDepth, q, 0).r;
    if (d < nearest) {
      nearest = d;
      nearestP = q;
    }
  }
  m1 /= 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec2 velocity = texelFetch(tNormalVelocity, nearestP, 0).zw;
  vec2 prevUv = vUv - 0.5 * velocity;
  if (hasHistory < 0.5 || any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    outColor = vec4(expand(cur), 1.0);
    return;
  }
  vec3 hist = toYCoCg(compress(sampleHistory(prevUv)));
  // A non-finite history (a degenerate frame) would stick: start over from this frame.
  if (any(isnan(hist)) || any(isinf(hist))) hist = toYCoCg(cur);
  // Clip the history toward the neighbourhood's mean, into its box.
  vec3 lo = m1 - clampGamma * sigma, hi = m1 + clampGamma * sigma;
  vec3 center = 0.5 * (lo + hi), extent = max(0.5 * (hi - lo), vec3(1e-5));
  vec3 off = hist - center;
  vec3 ts = abs(off / extent);
  float t = max(ts.x, max(ts.y, ts.z));
  if (t > 1.0) hist = center + off / t;
  // Less history where things move fast (sub-pixel resampling blurs).
  float speed = length(velocity * resolution * 0.5);
  float alpha = mix(1.0 - feedback, 0.5, clamp(speed / 16.0, 0.0, 1.0));
  vec3 result = mix(fromYCoCg(hist), cur, alpha);
  outColor = vec4(expand(result), 1.0);
}
`;
