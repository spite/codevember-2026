import { Mesh, Vector2, LatheGeometry, BufferAttribute, DoubleSide } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

// Seamless cyc from Day 1: floor disc sweeping up into a round wall.
const CYC_FLOOR = 10;
const CYC_ARC = 5;

// `cycS` is the arc length along the profile from the centre, so shading can follow the sweep.
function cycGeometry(floorY) {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push(new Vector2((CYC_FLOOR * i) / 12, floorY));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(CYC_FLOOR + CYC_ARC * Math.sin(a), floorY + CYC_ARC * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 6; i++) points.push(new Vector2(CYC_FLOOR + CYC_ARC, floorY + CYC_ARC + i * 25));
  const geometry = new LatheGeometry(points, 128);
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
    defines: { FLOOR_Y: floorY.toFixed(3) },
    roughness: 0.95,
    side: DoubleSide,
    uniforms: {
      cycSweep: { value: new Vector2(CYC_FLOOR - 1, CYC_FLOOR + CYC_ARC * 1.2) },
      backdropLevel: { value: 0.3 },
      wallFill: { value: 0.2 },
      cycTop: { value: 0.8 },
      cycFall: { value: new Vector2(0.4, 1) },
      poolStrength: { value: 0.6 },
      backdropSpecular: { value: 1 },
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
uniform float poolStrength;
uniform float backdropSpecular;
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo *= backdropLevel;
  s.specular *= backdropSpecular;
  // The key barely reaches the wall, so a soft fill rises along the sweep.
  vec3 L = normalize(lightDirection);
  vec3 open = s.albedo * (lightColor * max(L.y, 0.0) * 0.3183 + max(evalSH(vec3(0.0, 1.0, 0.0)), vec3(0.0)) * envIntensity);
  float w = smoothstep(cycSweep.x, cycSweep.y, vCycS);
  float up = gl_FragCoord.y / resolution.y;
  s.emissive += open * w * wallFill * mix(1.0, cycTop, smoothstep(cycFall.x, cycFall.y, up));
  // Denser contact pool under low occluders.
  float pool = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= occluderCount) break;
    vec4 o = occluders[i];
    if (o.w <= 0.0) continue;
    float gap = max(o.y - o.w - FLOOR_Y, 0.05);
    float d = length(vWorldPosition.xz - o.xz) / (o.w + 0.5 * gap);
    float k = o.w / (o.w + gap);
    pool *= 1.0 - poolStrength * k * k * exp(-2.0 * d * d);
  }
  s.occlusion *= pool;
}
`,
  });

  const mesh = new Mesh(cycGeometry(floorY), material);
  mesh.userData.noShadow = true;

  // Inner radius of the cyc at height y.
  const radiusAt = (y) => {
    const h = Math.min(Math.max(y - floorY, 0), CYC_ARC);
    return CYC_FLOOR + Math.sqrt(Math.max(CYC_ARC * CYC_ARC - (CYC_ARC - h) ** 2, 0));
  };

  // Low orbits meet the sweep sooner, so the camera is pulled in to stay in front of it.
  function keepInsideCyc(camera, target) {
    const p = camera.position;
    for (let i = 0; i < 4; i++) {
      const limit = radiusAt(p.y) - 1.2;
      const r = Math.hypot(p.x - target.x, p.z - target.z);
      if (r <= limit) break;
      p.sub(target).multiplyScalar(limit / r).add(target);
    }
  }

  return { mesh, material, keepInsideCyc };
}

export { createBackdrop };
