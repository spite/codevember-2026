// Depth of field: thin-lens circle of confusion, gathered at half resolution over tiles that know how
// far blur can reach them, then blended into the full-res image where it is out of focus.
// CoC is signed and in full-res pixels: negative in front of the focus, positive behind.

const common = /* glsl */ `
precision highp float;
uniform float cameraNear;
uniform float cameraFar;
uniform float focus;
uniform float aperture;
uniform float maxCoc;

float linearDepth(float d) {
  return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

float cocAt(float d) {
  return clamp(aperture * (1.0 - focus / linearDepth(d)), -maxCoc, maxCoc);
}
`;

// Full res -> half res: average colour, and the CoC of the nearest of the four texels.
export const dofPrefilterFragment = /* glsl */ `
${common}
uniform sampler2D tColor;
uniform sampler2D tDepth;
layout(location = 0) out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 size = textureSize(tColor, 0) - 1;
  vec3 color = vec3(0.0);
  float near = 1.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = min(p + ivec2(i & 1, i >> 1), size);
    color += texelFetch(tColor, q, 0).rgb;
    near = min(near, texelFetch(tDepth, q, 0).r);
  }
  outColor = vec4(color * 0.25, cocAt(near));
}
`;

// Half res -> tiles: the largest blur in the tile (r) and the largest foreground blur (g).
export const dofTileFragment = /* glsl */ `
precision highp float;
uniform sampler2D tHalf;
uniform int tile;
layout(location = 0) out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * tile;
  ivec2 size = textureSize(tHalf, 0) - 1;
  float maxAbs = 0.0, maxNear = 0.0;
  for (int y = 0; y < 32; y++) {
    if (y >= tile) break;
    for (int x = 0; x < 32; x++) {
      if (x >= tile) break;
      float c = texelFetch(tHalf, min(p + ivec2(x, y), size), 0).a;
      maxAbs = max(maxAbs, abs(c));
      maxNear = max(maxNear, -c);
    }
  }
  outColor = vec4(maxAbs, maxNear, 0.0, 1.0);
}
`;

// How far blur can reach into each tile: its own, or foreground spreading from neighbours.
export const dofDilateFragment = /* glsl */ `
precision highp float;
uniform sampler2D tTiles;
uniform int reach;
layout(location = 0) out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(tTiles, 0) - 1;
  float r = texelFetch(tTiles, p, 0).r;
  for (int y = -4; y <= 4; y++) {
    if (abs(y) > reach) continue;
    for (int x = -4; x <= 4; x++) {
      if (abs(x) > reach) continue;
      r = max(r, texelFetch(tTiles, clamp(p + ivec2(x, y), ivec2(0), size), 0).g);
    }
  }
  outColor = vec4(r, 0.0, 0.0, 1.0);
}
`;

// Scatter-as-gather on a golden-angle disc sized to the tile's reach. A sample counts when its blur
// reaches this pixel; samples behind are limited to this pixel's blur, so foreground spreads over
// what is behind it and not the other way round. Alpha is how much foreground spread here.
export const dofGatherFragment = /* glsl */ `
precision highp float;
uniform sampler2D tHalf;
uniform sampler2D tReach;
uniform vec2 resolution;
uniform int tile;
uniform int maxSamples;
uniform float density;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 center = texelFetch(tHalf, p, 0);
  float c0 = center.a;
  float reach = texelFetch(tReach, p / tile, 0).r;
  if (reach < 0.5) {
    outColor = vec4(center.rgb, 0.0);
    return;
  }
  int n = clamp(int(reach * reach * density), 8, maxSamples);
  float rotation = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  vec3 sum = center.rgb;
  float total = 1.0, front = 0.0;
  for (int i = 0; i < 128; i++) {
    if (i >= n) break;
    float r = sqrt((float(i) + 0.5) / float(n)) * reach;
    float a = float(i) * 2.399963229728653 + rotation;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / resolution;
    vec4 s = textureLod(tHalf, uv, 0.0);
    float spread = s.a < c0 ? abs(s.a) : min(abs(s.a), abs(c0));
    float w = clamp((spread - r) * 0.5 + 0.5, 0.0, 1.0) * step(0.5, spread);
    sum += s.rgb * w;
    total += w;
    if (s.a < c0 - 0.5 && abs(s.a) > abs(c0)) front += w;
  }
  outColor = vec4(sum / total, clamp(front / total * 4.0, 0.0, 1.0));
}
`;

// Full res: the sharp image where in focus, the half-res blur where not or where foreground spreads.
export const dofCompositeFragment = /* glsl */ `
${common}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec4 sharp = texelFetch(tColor, ivec2(gl_FragCoord.xy), 0);
  float c0 = cocAt(texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r);
  vec4 blur = textureLod(tBlur, vUv, 0.0);
  float amount = max(smoothstep(0.5, 1.5, abs(c0)), blur.a);
  outColor = vec4(mix(sharp.rgb, blur.rgb, amount), sharp.a);
}
`;

// Running mean of the lens samples: prev + (cur - prev) / n.
export const dofAccumulateFragment = /* glsl */ `
precision highp float;
uniform sampler2D tPrev;
uniform sampler2D tCurrent;
uniform float weight;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  outColor = mix(textureLod(tPrev, vUv, 0.0), textureLod(tCurrent, vUv, 0.0), weight);
}
`;
