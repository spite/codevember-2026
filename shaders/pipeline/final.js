import { octahedral } from "./octahedral.js";

// Tonemappers on exposed linear sRGB; each returns display-linear [0, 1].
export const tonemap = /* glsl */ `
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187)
);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
  );
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = inset * (LINEAR_SRGB_TO_LINEAR_REC2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = outset * agxContrast(color);
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(LINEAR_REC2020_TO_LINEAR_SRGB * color, 0.0, 1.0);
}

vec3 aces(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = inputMat * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(outputMat * (a / b), 0.0, 1.0);
}

vec3 neutral(vec3 color) {
  const float start = 0.76;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}
`;

// Bloom, exposure, vignette, tonemap, grade, grain, dither, chromatic aberration; debug views.
export const finalFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tNormalVelocity;
uniform sampler2D tDepth;
uniform float bloomStrength;
uniform float bloomScale;
uniform float exposure;
uniform float vignette;
uniform float grain;
uniform float aberration;
uniform float saturation;
uniform float contrast;
uniform int tonemapper;
uniform float frame;
uniform int debugView;
uniform float clipWarning;
uniform float cameraNear;
uniform float cameraFar;
uniform float isOrtho;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

${tonemap}
${octahedral}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float linearDepth(float d) {
  return isOrtho > 0.5
    ? cameraNear + d * (cameraFar - cameraNear)
    : cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

void main() {
  if (debugView == 1) {
    vec4 nv = textureLod(tNormalVelocity, vUv, 0.0);
    float bg = step(1.0, textureLod(tDepth, vUv, 0.0).r);
    outColor = vec4(mix(octDecode(nv.xy) * 0.5 + 0.5, vec3(0.0), bg), 1.0);
    return;
  }
  if (debugView == 2) {
    float z = linearDepth(textureLod(tDepth, vUv, 0.0).r);
    float t = log2(z / cameraNear) / log2(cameraFar / cameraNear);
    outColor = vec4(vec3(1.0 - t), 1.0);
    return;
  }
  if (debugView == 3) {
    vec2 v = textureLod(tNormalVelocity, vUv, 0.0).zw;
    outColor = vec4(abs(v) * 50.0, 0.0, 1.0);
    return;
  }
  if (debugView == 4) {
    outColor = vec4(linearToSRGB(textureLod(tColor, vUv, 0.0).rgb), 1.0);
    return;
  }

  vec2 centred = vUv - 0.5;
  vec3 color;
  if (aberration > 0.0) {
    vec2 o = centred * dot(centred, centred) * aberration * 0.05;
    color = vec3(
      textureLod(tColor, vUv - o, 0.0).r,
      textureLod(tColor, vUv, 0.0).g,
      textureLod(tColor, vUv + o, 0.0).b);
  } else {
    color = textureLod(tColor, vUv, 0.0).rgb;
  }
  color = max(color, vec3(0.0));
  if (bloomStrength > 0.0) color = mix(color, textureLod(tBloom, vUv, 0.0).rgb * bloomScale, bloomStrength);

  color *= exposure;
  if (vignette > 0.0) {
    float edge = length(centred) * 2.0;
    color *= mix(1.0, smoothstep(1.6, 0.3, edge), vignette);
  }

  if (tonemapper == 0) color = agx(color);
  else if (tonemapper == 1) color = aces(color);
  else if (tonemapper == 2) color = neutral(color);
  else color = clamp(color, 0.0, 1.0);

  vec3 c = linearToSRGB(color);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, saturation);
  c = (c - 0.5) * contrast + 0.5;

  // Exposure check: red at clipping, yellow in the 0.90-0.96 target band for paper whites.
  if (debugView == 5) {
    float m = max(c.r, max(c.g, c.b));
    vec3 v = vec3(luma);
    if (m >= 0.96) v = vec3(1.0, 0.0, 0.0);
    else if (m >= 0.9) v = vec3(1.0, 0.85, 0.0);
    outColor = vec4(v, 1.0);
    return;
  }
  // Overlay on the beauty image: tints displayed luminance above 0.97 yellow.
  if (clipWarning > 0.5 && dot(clamp(c, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722)) > 0.97) {
    outColor = vec4(1.0, 0.85, 0.0, 1.0);
    return;
  }
  if (grain > 0.0) {
    float n = hash12(gl_FragCoord.xy + vec2(mod(frame, 512.0) * 17.31, mod(frame, 509.0) * 7.77)) - 0.5;
    c += n * grain * (1.0 - 0.6 * abs(luma * 2.0 - 1.0));
  }
  c += (ign(gl_FragCoord.xy + 5.588238 * mod(frame, 64.0)) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
