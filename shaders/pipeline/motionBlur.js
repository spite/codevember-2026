// Motion blur after McGuire et al. 2012: per-tile max velocity, its max over the blur's reach, then a
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
uniform int reach;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(tTiles, 0) - 1;
  vec2 best = vec2(0.0);
  float bestLength = 0.0;
  for (int y = -reach; y <= reach; y++) {
    for (int x = -reach; x <= reach; x++) {
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

// 4x4 ordered dither: a fine regular pattern reads smoother than white noise without temporal accumulation.
float bayer4(ivec2 p) {
  int i = (p.x & 3) + 4 * (p.y & 3);
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}

void main() {
  ivec2 X = ivec2(gl_FragCoord.xy);
  vec4 colorX = texelFetch(tColor, X, 0);
  float jitter = bayer4(X) - 0.5;
  vec2 vN = texelFetch(tNeighbor, X / int(tile), 0).xy;
  float lN = length(vN);
  if (lN < 0.5) {
    outColor = colorX;
    return;
  }
  vec2 vX = pixelVelocity(X);
  float lX = max(length(vX), 0.5);
  // Half the samples follow the pixel's own motion, so spinning pieces blur along their real path.
  vec2 vC = length(vX) > 0.5 ? vX : vN;
  float zX = linearDepth(texelFetch(tDepth, X, 0).r);
  float weight = 1.0 / lX;
  vec3 sum = colorX.rgb * weight;
  float total = weight;
  ivec2 last = ivec2(resolution) - 1;
  for (int i = 0; i < samples; i++) {
    float t = mix(-1.0, 1.0, (float(i) + 0.5 + jitter) / float(samples));
    vec2 dir = (i & 1) == 0 ? vN : vC;
    ivec2 Y = ivec2(gl_FragCoord.xy + dir * t);
    if (Y == X || any(lessThan(Y, ivec2(0))) || any(greaterThan(Y, last))) continue;
    float lY = max(length(pixelVelocity(Y)), 0.5);
    float zY = linearDepth(texelFetch(tDepth, Y, 0).r);
    float d = abs(t) * length(dir);
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
