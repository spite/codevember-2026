import { Mesh, SphereGeometry, BackSide } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { shader as simplex } from "shaders/perlinSimplex3D.js";

// Seamless studio dome around the tumbling dolls, lit like a spot behind them: bright in the middle of the screen, falling
// off toward the edges. The halves fade into this same colour (material.js).
function createBackdrop({ color = 0xe6dfd4 }) {
  const material = new PipelineMaterial({
    color,
    roughness: 0.95,
    side: BackSide,
    uniforms: {
      backdropLevel: { value: 0.42 },
      wallFill: { value: 0.32 },
    },
    fragmentPars: /* glsl */ `
uniform float backdropLevel;
uniform float wallFill;
${simplex}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 dir = normalize(vWorldPosition);
  float grad = smoothstep(-0.65, 0.75, dir.y);
  float radial = mix(1.6, 0.32, smoothstep(0.0, 0.8, length((gl_FragCoord.xy - 0.5 * resolution) / resolution.y)));
  float plaster = snoise(dir * 5.0) * 0.015 + snoise(dir * 18.0) * 0.008;
  vec3 col = s.albedo * backdropLevel * mix(0.84, 1.12, grad) * radial * (1.0 + plaster);
  // Pure emission: no diffuse or specular, so no shadow, AO or reflection can mark it.
  s.albedo = vec3(0.0);
  s.specular = 0.0;
  s.emissive = col * (1.0 + wallFill * 1.45);
  s.roughness = 1.0;
}
`,
  });
  const mesh = new Mesh(new SphereGeometry(36, 48, 32), material);
  mesh.userData.noShadow = true;
  mesh.renderOrder = 1;
  return { mesh, material };
}

export { createBackdrop };
