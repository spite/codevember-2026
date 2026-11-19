import { Mesh, Vector2, LatheGeometry, BufferAttribute, DoubleSide } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

// Seamless cyc: a floor disc sweeping up into a round wall, so any orbit has the sweep behind the contraption.
const CYC_FLOOR = 14;
const CYC_ARC = 5;

// `cycS` is the arc length along the profile from the centre, so shading can follow the sweep.
function cycGeometry(floorY) {
  const points = [];
  for (let i = 0; i <= 16; i++) points.push(new Vector2((CYC_FLOOR * i) / 16, floorY));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(CYC_FLOOR + CYC_ARC * Math.sin(a), floorY + CYC_ARC * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 6; i++) points.push(new Vector2(CYC_FLOOR + CYC_ARC, floorY + CYC_ARC + i * 20));
  const geometry = new LatheGeometry(points, 160);
  const pos = geometry.attributes.position;
  const arc = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const rho = Math.hypot(pos.getX(i), pos.getZ(i));
    const y = pos.getY(i) - floorY;
    if (y < 1e-4) arc[i] = rho;
    else if (y < CYC_ARC) arc[i] = CYC_FLOOR + CYC_ARC * Math.asin(Math.min(1, (rho - CYC_FLOOR) / CYC_ARC));
    else arc[i] = CYC_FLOOR + CYC_ARC * Math.PI * 0.5 + y - CYC_ARC;
  }
  geometry.setAttribute("cycS", new BufferAttribute(arc, 1));
  return geometry;
}

function createBackdrop({ floorY, color }) {
  const material = new PipelineMaterial({
    color,
    roughness: 0.92,
    side: DoubleSide,
    uniforms: {
      cycSweep: { value: new Vector2(CYC_FLOOR - 2, CYC_FLOOR + CYC_ARC * 1.2) },
      backdropLevel: { value: 0.32 },
      wallFill: { value: 0.25 },
      cycTop: { value: 0.75 },
      cycFall: { value: new Vector2(0.45, 1) },
    },
    varyings: { vCycS: "float" },
    vertexPars: "in float cycS;",
    vertexMain: "vCycS = cycS;",
    fragmentPars: /* glsl */ `
uniform vec2 cycSweep;
uniform float backdropLevel;
uniform float wallFill;
uniform float cycTop;
uniform vec2 cycFall;
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo *= backdropLevel;
  // The key barely reaches the wall, so a soft fill rises along the sweep; the bend still reads as a gradient.
  vec3 L = normalize(lightDirection);
  vec3 open = s.albedo * (lightColor * max(L.y, 0.0) * 0.3183 + max(evalSH(vec3(0.0, 1.0, 0.0)), vec3(0.0)) * envIntensity);
  float w = smoothstep(cycSweep.x, cycSweep.y, vCycS);
  float up = gl_FragCoord.y / resolution.y;
  s.emissive += open * w * wallFill * mix(1.0, cycTop, smoothstep(cycFall.x, cycFall.y, up));
}
`,
  });
  const mesh = new Mesh(cycGeometry(floorY), material);
  mesh.userData.noShadow = true;
  // Drawn after the contraption, so its shading is skipped where the contraption covers it.
  mesh.renderOrder = 1;
  return { mesh, material };
}

export { createBackdrop, CYC_FLOOR, CYC_ARC };
