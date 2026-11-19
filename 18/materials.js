import { Color } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { shader as simplex } from "shaders/perlinSimplex3D.js";

// Cast plaster or clay: a faint cloudy mottle in colour and roughness, and a fine grain in the normal, fixed to the
// object so turning parts carry it with them.
function plasterMaterial({ color, roughness = 0.75, mottle = 0.035, grain = 0.25, scale = 1, sheen = 0 }) {
  return new PipelineMaterial({
    color,
    roughness,
    sheen,
    sheenColor: color,
    sheenRoughness: 0.6,
    uniforms: { mottle: { value: mottle }, grain: { value: grain }, texScale: { value: scale } },
    fragmentPars: /* glsl */ `
uniform float mottle;
uniform float grain;
uniform float texScale;
${simplex}

// Bump from a height field along the surface, via screen-space derivatives (Mikkelsen's surface gradient).
vec3 bumpNormal(vec3 n, float h) {
  vec3 dpdx = dFdx(vWorldPosition), dpdy = dFdy(vWorldPosition);
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 g = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - g);
}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition * texScale;
  float cloud = snoise(p * 3.1) * 0.6 + snoise(p * 11.0) * 0.4;
  s.albedo *= 1.0 + mottle * cloud;
  s.roughness = clamp(s.roughness + 0.06 * snoise(p * 7.0 + 3.1), 0.05, 1.0);
  float h = snoise(p * 47.0) * 0.00016;
  s.normal = normalize(mix(s.normal, bumpNormal(s.normal, h), grain));
}
`,
  });
}

// Polished stone fixed to the object: marble's veins (a band pattern warped by noise), or travertine's soft layers
// and pits.
function stoneMaterial({ color, vein = 0x6f6a64, kind = "marble", roughness = 0.3, scale = 1 }) {
  return new PipelineMaterial({
    color,
    roughness,
    uniforms: { veinColor: { value: new Color(vein) }, texScale: { value: scale }, travertine: { value: kind === "travertine" ? 1 : 0 } },
    fragmentPars: /* glsl */ `
uniform vec3 veinColor;
uniform float texScale;
uniform float travertine;
${simplex}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition * texScale;
  // Veins: a sine along one direction, pushed about by turbulence (summed |noise|), kept thin.
  float turb = 0.0, f = 1.0, a = 1.0;
  for (int i = 0; i < 4; i++) {
    turb += abs(snoise(p * 1.4 * f)) * a;
    f *= 2.1;
    a *= 0.5;
  }
  float band = abs(sin((p.x * 0.9 + p.y * 1.6 + p.z * 0.4) * 2.0 + turb * 1.5));
  float fine = abs(sin((p.x * 2.3 - p.y * 0.8 + p.z * 1.1) * 3.3 + turb * 2.2));
  float vein = pow(1.0 - band, 11.0) * 0.6 + pow(1.0 - band, 3.0) * 0.1 + pow(1.0 - fine, 22.0) * 0.22;
  // Cloudy patches between the veins.
  float cloud = smoothstep(-0.2, 0.8, snoise(p * 0.9 + 4.0)) * 0.12;
  vec3 marble = mix(s.albedo * (1.0 + 0.05 * (turb - 0.9)), veinColor, clamp(vein + cloud, 0.0, 1.0) * 0.7);
  float layers = 0.5 + 0.5 * sin(p.y * 24.0 + snoise(p * vec3(0.8, 3.0, 0.8)) * 2.5);
  float pits = smoothstep(0.6, 0.75, snoise(p * 40.0)) * (0.6 + 0.4 * snoise(p * 7.0));
  vec3 trav = s.albedo * (0.9 + 0.12 * layers) * (1.0 - 0.4 * max(pits, 0.0));
  s.albedo = mix(marble, trav, travertine);
  s.roughness = clamp(mix(s.roughness, 0.68, travertine) + 0.25 * max(pits, 0.0) * travertine, 0.05, 1.0);
}
`,
  });
}

// Brass, faintly brushed: its roughness streaks along the object's own X.
function brassMaterial({ color, roughness = 0.3 }) {
  return new PipelineMaterial({
    color,
    roughness,
    metalness: 1,
    uniforms: { texScale: { value: 1 } },
    fragmentPars: /* glsl */ `
uniform float texScale;
${simplex}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition * texScale;
  s.roughness = clamp(s.roughness + 0.08 * snoise(p * vec3(3.0, 90.0, 90.0)) + 0.05 * snoise(p * 6.0), 0.08, 1.0);
}
`,
  });
}

function glazeMaterial({ color, roughness = 0.18 }) {
  return plasterMaterial({ color, roughness, mottle: 0.015, grain: 0.1 });
}

function metalMaterial({ color, roughness = 0.3 }) {
  return new PipelineMaterial({ color, roughness, metalness: 1 });
}

export { plasterMaterial, glazeMaterial, metalMaterial, stoneMaterial, brassMaterial };
