// Motion blur after McGuire et al. 2012: per-tile max velocity, its 3x3 neighbourhood max, then a
// depth-aware gather along it, so moving objects smear over what is behind them.
// Velocities come from the motion pass (.zw, NDC, over half the shutter) and are used in pixels.

const velocityChunk = /* glsl */ `
uniform sampler2D tVelocity;
uniform vec2 resolution;
uniform float maxRadius;

vec2 pixelVelocity(ivec2 p) {
  vec2 v = texelFetch(tVelocity, p, 0).zw * 0.5 * resolution;
  float l = length(v);
  return l > maxRadius ? v * (maxRadius / l) : v;
}
`;

export const tileMaxFragment = /* glsl */ `
precision highp float;
${velocityChunk}
uniform int tile;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * tile;
  ivec2 last = ivec2(resolution) - 1;
  vec2 best = vec2(0.0);
  float bestLength = 0.0;
  for (int y = 0; y < tile; y++) {
    for (int x = 0; x < tile; x++) {
      vec2 v = pixelVelocity(min(base + ivec2(x, y), last));
      float l = dot(v, v);
      if (l > bestLength) {
        bestLength = l;
        best = v;
      }
    }
  }
  outColor = vec4(best, 0.0, 1.0);
}
`;

export const neighborMaxFragment = /* glsl */ `
precision highp float;
uniform sampler2D tTiles;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(tTiles, 0) - 1;
  vec2 best = vec2(0.0);
  float bestLength = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texelFetch(tTiles, clamp(p + ivec2(x, y), ivec2(0), last), 0).xy;
      float l = dot(v, v);
      if (l > bestLength) {
        bestLength = l;
        best = v;
      }
    }
  }
  outColor = vec4(best, 0.0, 1.0);
}
`;

export const reconstructFragment = /* glsl */ `
precision highp float;
${velocityChunk}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNeighbor;
uniform float tile;
uniform int samples;
uniform float softZ;
uniform float cameraNear;
uniform float cameraFar;
uniform float isOrtho;
uniform float frame;
layout(location = 0) out vec4 outColor;

float linearDepth(float d) {
  return isOrtho > 0.5
    ? cameraNear + d * (cameraFar - cameraNear)
    : cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

float cone(float d, float l) {
  return clamp(1.0 - d / l, 0.0, 1.0);
}

float cylinder(float d, float l) {
  return 1.0 - smoothstep(0.95 * l, 1.05 * l, d);
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  ivec2 X = ivec2(gl_FragCoord.xy);
  vec4 colorX = texelFetch(tColor, X, 0);
  vec2 vN = texelFetch(tNeighbor, X / int(tile), 0).xy;
  float lN = length(vN);
  if (lN < 0.5) {
    outColor = colorX;
    return;
  }
  float lX = max(length(pixelVelocity(X)), 0.5);
  float zX = linearDepth(texelFetch(tDepth, X, 0).r);
  float weight = 1.0 / lX;
  vec3 sum = colorX.rgb * weight;
  float total = weight;
  float jitter = ign(gl_FragCoord.xy + mod(frame, 64.0) * vec2(5.588, 3.123)) - 0.5;
  ivec2 last = ivec2(resolution) - 1;
  for (int i = 0; i < samples; i++) {
    float t = mix(-1.0, 1.0, (float(i) + 0.5 + jitter) / float(samples));
    ivec2 Y = ivec2(gl_FragCoord.xy + vN * t);
    if (Y == X || any(lessThan(Y, ivec2(0))) || any(greaterThan(Y, last))) continue;
    float lY = max(length(pixelVelocity(Y)), 0.5);
    float zY = linearDepth(texelFetch(tDepth, Y, 0).r);
    float d = abs(t) * lN;
    // Y in front smears over X along Y's motion; X in front reveals what is behind along X's.
    float front = clamp(1.0 - (zY - zX) / softZ, 0.0, 1.0);
    float back = clamp(1.0 - (zX - zY) / softZ, 0.0, 1.0);
    float w = front * cone(d, lY) + back * cone(d, lX) + cylinder(d, lY) * cylinder(d, lX) * 2.0;
    sum += texelFetch(tColor, Y, 0).rgb * w;
    total += w;
  }
  outColor = vec4(sum / total, colorX.a);
}
`;
