import { giCommon } from "./gi.js";
import { shadowChunk } from "./shadow.js";

// Evaluates getShadow() at the half-res geometry with per-frame noise; temporal + a-trous
// passes (from gi.js) then denoise it. The shadow is in .a (and .r, .b); .g holds the PCF kernel
// radius in half-res texels, which limits the blur so hard and contact shadows stay sharp.
export const shadowMaskFragment = /* glsl */ `${giCommon}
uniform sampler2D tGeo;
uniform mat4 uView;
uniform mat4 uViewInverse;
uniform float noiseFrame;

#define SHADOW_FRAME noiseFrame
${shadowChunk}

layout(location = 0) out vec4 outShadow;

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  vec4 g = texelFetch(tGeo, h, 0);
  if (g.x <= 0.0) {
    outShadow = vec4(1.0);
    return;
  }
  vec3 P = (uViewInverse * vec4(viewPosition(halfToUv(h), g.x), 1.0)).xyz;
  float s = getShadow(P, unpackNormal(g.y));
  // Kernel radius in world, then in half-res texels at this depth.
  vec3 row0 = vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]);
  float radiusWorld = shadowKernelRadius * 2.0 / length(row0);
  vec3 Pv = viewPosition(halfToUv(h), g.x);
  float texelWorld = length(viewPosition(halfToUv(h + ivec2(0, 1)), g.x) - Pv);
  outShadow = vec4(s, radiusWorld / max(texelWorld, 1e-6), s, s);
}
`;
