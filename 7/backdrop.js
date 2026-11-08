import { Mesh, Vector2, Vector4, LatheGeometry, BufferAttribute, DoubleSide } from "three";
import { createReceiverMaterial } from "./materials.js";

// A seamless cyc, its centre pushed toward the camera so the sweep rises close behind the sculpture and the light
// through the holes reaches it.
const CYC_FLOOR = 3.4;
const CYC_ARC = 2.2;
const CYC_SHIFT = 1.6;

// `cycS` is the arc length along the profile from the centre, so shading can follow the sweep.
function cycGeometry(floorY) {
  const points = [];
  for (let i = 0; i <= 24; i++) points.push(new Vector2((CYC_FLOOR * i) / 24, floorY));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(CYC_FLOOR + CYC_ARC * Math.sin(a), floorY + CYC_ARC * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 8; i++) points.push(new Vector2(CYC_FLOOR + CYC_ARC, floorY + CYC_ARC + i * 3));
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
  const material = createReceiverMaterial({
    color,
    roughness: 0.9,
    side: DoubleSide,
    uniforms: {
      cycSweep: { value: new Vector2(CYC_FLOOR - 1, CYC_FLOOR + CYC_ARC * 1.2) },
      backdropLevel: { value: 0.3 },
      wallFill: { value: 0.3 },
      cycTop: { value: 0.8 },
      cycFall: { value: new Vector2(0.4, 1) },
      contactSphere: { value: new Vector4(0, 1, 0, 0) },
      contactStrength: { value: 1.6 },
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
uniform vec4 contactSphere;
uniform float contactStrength;

// The floating sculpture as a sphere that hides the studio from the floor under it.
float contactShade(vec3 P, vec3 n) {
  vec3 D = contactSphere.xyz - P;
  float d = length(D), r = contactSphere.w;
  if (r <= 0.0) return 1.0;
  float occ = r * r / max(d * d, r * r) * clamp(dot(n, D / d), 0.0, 1.0);
  return exp(-contactStrength * occ);
}
`,
  });
  // The receiver's surface() plus the backdrop's own fill along the sweep.
  material.fragmentShader = material.fragmentShader.replace(
    "s.emissive += lampDiffuse(vWorldPosition, normalize(s.normal), s.albedo, lampWrap);",
    /* glsl */ `s.albedo *= backdropLevel;
  float contact = contactShade(vWorldPosition, normalize(s.normal));
  s.occlusion *= contact;
  vec3 L = normalize(lightDirection);
  vec3 open = s.albedo * (lightColor * max(L.y, 0.0) * 0.3183 + max(evalSH(vec3(0.0, 1.0, 0.0)), vec3(0.0)) * envIntensity);
  float w = smoothstep(cycSweep.x, cycSweep.y, vCycS);
  float up = gl_FragCoord.y / resolution.y;
  s.emissive += open * w * wallFill * mix(1.0, cycTop, smoothstep(cycFall.x, cycFall.y, up)) * contact;
  s.emissive += lampDiffuse(vWorldPosition, normalize(s.normal), s.albedo * min(1.0 / backdropLevel, 2.4), 0.0);`,
  );

  const mesh = new Mesh(cycGeometry(floorY), material);
  mesh.position.z = CYC_SHIFT;
  mesh.userData.noShadow = true;

  // The cyc's centre stays pushed toward the camera, so the sweep is always behind the sculpture and the orbit never
  // has to pull the camera in.
  function follow(camera, target) {
    const a = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
    mesh.position.set(Math.sin(a) * CYC_SHIFT, 0, Math.cos(a) * CYC_SHIFT);
    mesh.updateMatrixWorld();
  }

  return { mesh, material, follow };
}

export { createBackdrop };
