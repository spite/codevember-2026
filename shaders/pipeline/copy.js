// Fullscreen-triangle vertex shader and a weighted copy (also used for additive accumulation).
export const fullscreenVertex = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const copyFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform float weight;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = textureLod(tInput, vUv, 0.0) * weight;
}
`;
