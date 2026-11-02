import { giCommon } from "./gi.js";
import { shadowChunk } from "./shadow.js";

// Evaluates getShadow() at the half-res geometry with per-frame noise; temporal + a-trous
// passes (from gi.js) then denoise it. The result is written to every channel.
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
  outShadow = vec4(getShadow(P, octDecode(g.yz)));
}
`;
