// Materials: kelp (and its shadow stand-in), the reef, the probe and the marine snow. All lit by the water's light model
// (water.js) with the sun's shadows and caustics (shadow.js); every colour is linear HDR for the renderer's final pass.
import * as THREE from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { waterUniforms, waterGLSL, NOISE_GLSL } from "./water.js";
import { shadowUniforms, shadowGLSL, shadowDepthFragment } from "./shadow.js";
import { kelpUniforms, KELP_VERTEX_GLSL } from "./kelpVertex.js";

export { kelpUniforms };

export const BRDF_GLSL = /* glsl */ `
float ggx(float ndh, float a) {
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}
`;

// Light through and off thin wet tissue: forward scattering, and reflectance from water into kelp.
export const TISSUE_GLSL = /* glsl */ `
float hg(float mu, float g) {
  float d = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / (12.566371 * d * sqrt(d));
}
// Reflectance from water into kelp tissue (relative index 1.08): 0.15% head-on against 3% in air.
float fresnelWater(float c) {
  float g = sqrt(0.1664 + c * c);
  float a = (g - c) / (g + c);
  float b = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * a * a * (1.0 + b * b);
}
`;

// An integer hash, so the depth and colour passes compute identical per-blade values.
export const KELP_HASH_GLSL = /* glsl */ `
uint kelpHash(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float kelpRand(uint x) {
  return float(kelpHash(x) >> 8) / 16777216.0;
}
float kelpNoise1(float x, uint seed) {
  uint b = uint(int(floor(x)) + 1048576);
  float f = fract(x);
  return mix(kelpRand(b ^ seed), kelpRand((b + 1u) ^ seed), f * f * (3.0 - 2.0 * f));
}
`;

// A blade's condition (vertex): age (0 young .. 1 old), type (0 blade, 1 sporophyll, 2 senescent), its id and kind.
// Runs after kelpDeform: bull and palm blades carry no age of their own and take their plant's (kelpInfo.y). Every
// vertex of a blade passes the same values; they aren't flat varyings, which ANGLE emulates on D3D11 with a geometry
// shader over every triangle.
const KELP_CONDITION_GLSL = /* glsl */ `
vec4 kelpCondition() {
  float type = floor(aColumnSeed.y * 0.5);
  float age = aColumnSeed.y - 2.0 * type;
  float id = max(aBladeId, 0.0);
  uint u = uint(id + 0.5);
  if (kelpInfo.x > 0.5) age = clamp(0.2 + 0.6 * kelpInfo.y + 0.6 * (kelpRand(u * 2u + 1u) - 0.5), 0.0, 1.0);
  return vec4(age, type, id, kelpInfo.x);
}
`;

// A blade's condition (fragment): age, type and two random numbers, from what kelpCondition passed on.
export const KELP_COND_GLSL = /* glsl */ `
vec4 bladeCondition(vec4 c) {
  uint u = uint(c.z + 0.5);
  return vec4(c.xy, kelpRand(u * 2u + 1u), kelpRand(u * 2u + 2u));
}
`;

// Coverage at a blade's margin in metres (uvm: along, across), antialiased over a pixel: 1 inside the drawn outline,
// less where an uneven edge, the gaps between a young giant blade's spines, or an old blade's ragged end cut in. The
// derivatives are taken first, so the inside of the blade can skip the rest.
export const COVERAGE_GLSL = /* glsl */ `
float bladeCoverage(vec2 uvm, vec4 bp, float kind, vec4 cond) {
  float px = max(fwidth(uvm.x), 1e-5);
  float pv = fwidth(bp.z);
  float v = abs(bp.z);
  if (v < 0.8 && bp.y < 0.85) return 1.0;
  float halfW = abs(uvm.y) / max(v, 0.05);
  uint seed = kelpHash(floatBitsToUint(cond.z));
  uint side = bp.z > 0.0 ? 0x9e3779b9u : 0u;
  float young = kind < 0.5 && cond.y < 0.5 ? 1.0 - cond.x : 0.0;
  // About one cell per 1.2 cm, half of them with a 2 mm spine leaning toward the tip; the margin between is set back.
  float x = uvm.x / 0.012;
  float f = fract(x);
  float h = kelpRand(uint(int(floor(x)) + 65536) ^ seed ^ side);
  float c = 0.3 + 0.4 * h;
  float spine = step(0.5, h) * max(0.0, 1.0 - max((c - f) / 0.3, (f - c) / 0.08));
  float back = halfW * 0.035 * kelpNoise1(uvm.x * 9.0, seed ^ side) * smoothstep(0.02, 0.15, bp.y);
  back += 0.002 * (1.0 - spine) * young * smoothstep(0.03, 0.1, bp.y) * smoothstep(1.0, 0.85, bp.y) * smoothstep(0.004, 0.0015, px);
  // A pixel's grace: where nothing is cut, the drawn edge stays as the multisampling made it.
  float cov = clamp(((1.0 - v) * halfW - back) / max(halfW * pv, 1e-5) + 1.0, 0.0, 1.0);
  // An old blade's end: metres from the tip, less a ragged allowance.
  float wear = smoothstep(0.45, 1.0, cond.x) * (0.4 + 0.6 * cond.w) * (abs(cond.y - 2.0) < 0.5 ? 1.6 : 1.0);
  float toTip = (1.0 - bp.y) * uvm.x / max(bp.y, 1e-3) - wear * (0.01 + 0.05 * kelpNoise1(uvm.y * 30.0, seed ^ 119u));
  return bp.y > 0.5 ? min(cov, clamp(toTip / px + 1.0, 0.0, 1.0)) : cov;
}
`;

// The lamina's relief, baked once into tiles in blade metres (1 mm a texel, tiling, mipmapped), read at each blade's own
// place. A: the blisters' and crinkles' slopes (rg, along and across), the optical thickness factor (b) and the
// blisters' domes (a). B: Membranipora crust (r), epiphyte specks (g), spore patches (b) and a colour mottle (a).
const TISSUE_SIZE = [1024, 512];
export const tissueUniforms = { tTissueA: { value: null }, tTissueB: { value: null } };
export const TISSUE_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D tTissueA;
uniform sampler2D tTissueB;
const vec2 TISSUE_TILE = vec2(1.024, 0.512);
`;

const TISSUE_BAKE_GLSL = /* glsl */ `
precision highp float;
precision highp int;
uniform int uLayer;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

const vec2 TILE = vec2(1.024, 0.512);
const vec2 TEXELS = vec2(${TISSUE_SIZE[0]}.0, ${TISSUE_SIZE[1]}.0);

uint tHash(uvec2 q, uint seed) {
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u) ^ (seed * 2654435761u);
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  h *= 0x846ca68bu;
  h ^= h >> 16;
  return h;
}

// A random number per cell of a grid with whole cells per tile (period), so all that's built on it tiles.
float tRand(vec2 cell, vec2 period, uint seed) {
  return float(tHash(uvec2(mod(cell, period)), seed) >> 8) / 16777216.0;
}

float tNoise(vec2 q, vec2 period, uint seed) {
  vec2 p = q * period;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = tRand(i, period, seed);
  float b = tRand(i + vec2(1.0, 0.0), period, seed);
  float c = tRand(i + vec2(0.0, 1.0), period, seed);
  float d = tRand(i + vec2(1.0, 1.0), period, seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Blisters: small rounded bumps, one per 6 mm cell, of their own size and height, overlapping into smooth hollows: 0..1.
const vec2 BLISTERS = vec2(170.0, 85.0);
float blisters(vec2 q) {
  vec2 cellM = TILE / BLISTERS;
  vec2 p = q * BLISTERS;
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float h = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 c = ip + g;
      vec2 o = vec2(tRand(c, BLISTERS, 11u), tRand(c, BLISTERS, 23u));
      float radius = 0.45 + 0.35 * tRand(c, BLISTERS, 29u);
      float x = min(length(g + o - fp) / radius, 1.0);
      float k = 1.0 - x * x;
      h = max(h, k * k * (0.5 + 0.5 * tRand(c, BLISTERS, 37u)));
    }
  }
  return h;
}

// Crinkles across the blade about 1.6 cm apart, wavy, unevenly spaced, coming and going in patches: 1 on a ridge.
float crinkles(vec2 q) {
  float warp = 2.6 * tNoise(q, vec2(9.0, 4.0), 41u) + 1.1 * tNoise(q, vec2(23.0, 10.0), 43u) + 0.4 * tNoise(q, vec2(60.0, 24.0), 45u);
  float wave = 0.5 + 0.5 * cos(6.2831853 * (q.x * 64.0 + q.y * 2.0 + warp));
  return wave * wave * smoothstep(0.35, 0.8, tNoise(q, vec2(7.0, 3.0), 47u));
}

// The lamina's height in metres.
float relief(vec2 q) {
  return 0.0004 * blisters(q) + 0.0005 * crinkles(q);
}

void main() {
  vec2 q = vUv;
  if (uLayer == 0) {
    vec2 e = 0.5 / TEXELS;
    float sx = (relief(q + vec2(e.x, 0.0)) - relief(q - vec2(e.x, 0.0))) / (2.0 * e.x * TILE.x);
    float sy = (relief(q + vec2(0.0, e.y)) - relief(q - vec2(0.0, e.y))) / (2.0 * e.y * TILE.y);
    float b = blisters(q);
    float ridge = crinkles(q);
    // Thicker and thinner patches 5-15 cm across, thicker along the crinkles' ridges, thinner on the bumps.
    float patchy = 0.55 * tNoise(q, vec2(14.0, 7.0), 51u) + 0.3 * tNoise(q, vec2(36.0, 18.0), 53u) + 0.15 * tNoise(q, vec2(5.0, 2.0), 57u);
    float thick = mix(0.75, 1.3, patchy) * (1.0 + 0.15 * ridge) * (1.0 - 0.12 * b);
    outColor = vec4(clamp(vec2(sx, sy) * 0.5 + 0.5, 0.0, 1.0), clamp((thick - 0.5) / 2.0, 0.0, 1.0), b);
  } else {
    // Membranipora colonies: rounded patches 1-3 cm across, one in some cells of a 4 cm grid, each with its own rank
    // (0.5-1 inside it, falling to 0 over its rim): a blade showing colonies above a threshold grows more as it fouls.
    const vec2 COLONIES = vec2(25.0, 12.0);
    vec2 cp = q * COLONIES;
    vec2 cc = floor(cp);
    vec2 cMid = 0.35 + 0.3 * vec2(tRand(cc, COLONIES, 61u), tRand(cc, COLONIES, 67u));
    float cRadius = 0.006 + 0.008 * tRand(cc, COLONIES, 71u);
    float cDist = length((fract(cp) - cMid) * TILE / COLONIES) + 0.002 * (tNoise(q, vec2(200.0, 100.0), 109u) - 0.5);
    float crust = (0.5 + 0.5 * tRand(cc, COLONIES, 113u)) * (1.0 - smoothstep(cRadius - 0.003, cRadius + 0.001, cDist));
    // Epiphyte specks: dots 1.6-3.6 mm across in an eighth of the cells of a 6 mm grid.
    const vec2 SPECKS = vec2(170.0, 85.0);
    vec2 sp = q * SPECKS;
    vec2 sc = floor(sp);
    float has = step(tRand(sc, SPECKS, 73u), 0.12);
    vec2 centre = 0.3 + 0.4 * vec2(tRand(sc, SPECKS, 79u), tRand(sc, SPECKS, 83u));
    float radius = 0.0008 + 0.001 * tRand(sc, SPECKS, 89u);
    float d = length((fract(sp) - centre) * TILE / SPECKS);
    float speck = has * (1.0 - smoothstep(radius - 0.0005, radius + 0.0005, d));
    float spores = 0.7 * tNoise(q, vec2(12.0, 30.0), 97u) + 0.3 * tNoise(q, vec2(40.0, 90.0), 101u);
    float mottle = 0.6 * tNoise(q, vec2(6.0, 3.0), 103u) + 0.4 * tNoise(q, vec2(17.0, 8.0), 107u);
    outColor = vec4(crust, speck, spores, mottle);
  }
}
`;

function bakeTissue(renderer) {
  if (tissueUniforms.tTissueA.value) return;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertex,
    fragmentShader: TISSUE_BAKE_GLSL,
    uniforms: { uLayer: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previous = renderer.getRenderTarget();
  ["tTissueA", "tTissueB"].forEach((key, layer) => {
    const target = new THREE.WebGLRenderTarget(TISSUE_SIZE[0], TISSUE_SIZE[1], {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    material.uniforms.uLayer.value = layer;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    tissueUniforms[key].value = target.texture;
  });
  renderer.setRenderTarget(previous);
  material.dispose();
  geometry.dispose();
}

// Set by the renderer before the kelp materials are made: whether the scene is multisampled (blade margins then cut
// samples by alpha to coverage; without it they're discarded).
export const kelpSetup = { msaa: true };
export function setupKelpMaterials(renderer, { msaa }) {
  kelpSetup.msaa = msaa;
  bakeTissue(renderer);
}

// A blade's tissue: its albedo, the light let through (tau, seen at nv) and roughness, from its kind, condition, place on
// the blade (bp: height, u, v, thickness), its plant's age, the baked tissue (tA, tB) and the metres per pixel.
export const BLADE_TISSUE_GLSL = /* glsl */ `
void bladeTissue(float kind, vec4 cond, vec4 bp, float plantAge, vec4 tA, vec4 tB, float nv, float px, out vec3 albedo, out vec3 tau, out float rough) {
  // A blade grows from its base, so its tip is its oldest tissue.
  float tissue = clamp(cond.x + 0.45 * bp.y - 0.15, 0.0, 1.0);
  float senescent = abs(cond.y - 2.0) < 0.5 ? 1.0 : 0.0;
  float sporophyll = abs(cond.y - 1.0) < 0.5 ? 1.0 : 0.0;
  // Half the dying blades bleach, half darken.
  float pale = senescent * step(0.5, cond.z);
  float thick = 0.5 + 2.0 * tA.z;
  float dome = tA.w;

  // Kelp reflects little: under 15% even in the yellow. Bull kelp lighter, palm kelp darker.
  vec3 youngC = kind < 0.5 ? vec3(0.13, 0.1, 0.025) : (kind < 1.5 ? vec3(0.14, 0.115, 0.03) : vec3(0.08, 0.05, 0.018));
  vec3 oldC = kind < 0.5 ? vec3(0.07, 0.045, 0.014) : (kind < 1.5 ? vec3(0.09, 0.065, 0.02) : vec3(0.045, 0.028, 0.01));
  albedo = mix(youngC, oldC, smoothstep(0.05, 0.95, tissue)) * (0.85 + 0.3 * cond.w) * mix(0.88, 1.1, tB.a) * mix(0.85, 1.08, dome);
  albedo = mix(albedo, vec3(0.22, 0.18, 0.07), pale);
  // Sporophylls carry dark patches of spores.
  float sori = sporophyll * smoothstep(0.5, 0.6, tB.b) * smoothstep(0.8, 0.3, abs(bp.z));
  albedo *= 1.0 - 0.45 * sori;

  // Membranipora: pale colonies on a few old blades of old plants, more as they foul, opaque against the light.
  float foul = smoothstep(0.55, 1.0, tissue) * smoothstep(0.3, 0.9, plantAge) * step(cond.w, 0.35) * step(kind, 1.5) * (1.0 + senescent);
  float th = 1.02 - 0.47 * min(foul, 1.0);
  float aa = 0.03 + 3.0 * px;
  float crust = foul > 0.0 ? smoothstep(th - aa, th + aa, tB.r) : 0.0;
  // Dark specks of epiphytes on the older blades.
  float speck = smoothstep(0.35, 0.9, tissue) * fract(cond.z * 5.3) * tB.g;
  albedo = mix(albedo * (1.0 - 0.6 * speck), vec3(0.46, 0.46, 0.42), crust);

  // Through a blade blue goes first, then green: thin young tissue lemon, thick old tissue amber, blade to blade. Seen
  // obliquely the path is longer, so edges and folds go deeper amber.
  vec3 sigma = kind < 0.5 ? vec3(1.2, 1.8, 7.0) : (kind < 1.5 ? vec3(1.15, 1.5, 7.0) : vec3(1.2, 1.8, 7.0));
  sigma.g *= mix(0.9, 1.12, cond.z);
  sigma = mix(sigma, vec3(0.6, 0.95, 3.5), pale);
  float bladeThick = mix(0.85, 1.3, cond.w * cond.w) * mix(0.85, 1.25, tissue) * (1.0 + 0.6 * senescent * (1.0 - pale)) * (1.0 + 0.5 * sori);
  float optDepth = (0.5 + 0.55 * bp.w) * bladeThick * thick + 4.0 * crust;
  tau = exp(-sigma * optDepth * (0.5 + 0.5 / nv));
  // Palm kelp's leathery blades let less through, bull kelp's more: by luminance, as a longer path through the filter
  // would drift to rust.
  float kindDark = kind < 0.5 ? 1.0 : (kind < 1.5 ? 0.85 : 2.0);
  tau *= pow(max(dot(tau, vec3(0.2126, 0.7152, 0.0722)), 1e-4), kindDark - 1.0) * (1.0 - 0.8 * speck);
  rough = mix(mix(0.26, 0.15, dome) * (kind > 1.5 ? 0.8 : 1.0), 0.75, crust);
}
`;

// Light off and through wet tissue: diffuse, transmitted (half diffused, half scattered forward with g, about 2.4 times
// Lambert looking into the sun, and bounded), small sharp sun glints, and a faint reflection of the water that fades on
// rough tissue and edge-on, and below the horizon sees the dark reef and forest. A shell (a bladder) is lit through its
// far wall from any side.
export const KELP_SHEET_GLSL = /* glsl */ `
vec3 kelpSheet(vec3 P, vec3 N, vec3 V, vec3 albedo, vec3 tau, float rough, vec3 sun, vec3 skyLight, float g, bool shell) {
  vec3 L = uSunDir;
  float ndl = dot(N, L);
  float mu = max(dot(-V, L), 0.0);
  float back = shell ? 1.0 : clamp((0.1 - ndl) / 1.1, 0.0, 1.0);
  vec3 transmitted = tau * (sun * back * (0.5 / 3.14159 + hg(mu, g)) + ambientAt(P, -N) * skyLight);
  vec3 diffuse = albedo * (sun * max(ndl, 0.0) / 3.14159 + ambientAt(P, N) * skyLight);
  vec3 H = normalize(L + V);
  float nvRaw = dot(N, V);
  float ndv = max(nvRaw, 1e-3);
  float nl = max(ndl, 0.0);
  // The sun under the waves spans a few degrees, so its glints are never sharper than that.
  float a = max(rough * rough, 0.06), a2 = a * a;
  float vis = 0.5 / (nl * sqrt(a2 + (1.0 - a2) * ndv * ndv) + ndv * sqrt(a2 + (1.0 - a2) * nl * nl) + 1e-4);
  // Glints only where the (bumped) normal faces the eye, and finite.
  vec3 spec = min(sun * ggx(max(dot(N, H), 0.0), a) * vis * fresnelWater(max(dot(V, H), 0.0)) * nl * step(0.0, nvRaw), vec3(48.0));
  vec3 R = reflect(-V, N);
  float envF = fresnelWater(max(ndv, 0.5 * rough)) * (1.0 - rough);
  vec3 env = waterBackground(P, R) * envF * skyLight * mix(0.1, 0.7, smoothstep(-0.35, 0.25, R.y));
  return diffuse + transmitted + spec + env;
}
`;

// What the kelp's vertex shaders pass on for the margins, identical in the depth and colour passes. Centroid: thin
// triangles that cover a sample but not the pixel's centre would otherwise be shaded at a point extrapolated off them
// (metres away when edge-on, as a stipe's sides are), which shows as specks of open water or of full sun.
const KELP_MARGIN_VARYINGS = /* glsl */ `
centroid varying vec2 vUv;
centroid varying vec4 vBladeParam;
varying float vIsBlade;
varying vec4 vCond;
`;

// The kelp's depth alone, drawn before the scene so the costly shading runs once per pixel; positions are invariant so the
// two passes agree exactly. It cuts the margins (alpha to coverage, or a discard without multisampling), and the colour
// pass then lands only on the samples it kept.
export function createKelpDepthMaterial(segsPerCol) {
  const msaa = kelpSetup.msaa;
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    colorWrite: false,
    alphaToCoverage: msaa,
    defines: { SEGS: segsPerCol, KELP_MSAA: msaa ? 1 : 0 },
    uniforms: { ...kelpUniforms },
    vertexShader: /* glsl */ `
      invariant gl_Position;
      ${KELP_VERTEX_GLSL}
      ${KELP_HASH_GLSL}
      ${KELP_CONDITION_GLSL}
      ${KELP_MARGIN_VARYINGS}

      void main() {
        vUv = uv;
        vBladeParam = aBladeParam;
        vIsBlade = aBladeId >= 0.0 ? 1.0 : 0.0;
        vec3 pos = position;
        vec3 nrm = normal;
        kelpDeform(pos, nrm);
        vCond = kelpCondition();
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${KELP_HASH_GLSL}
      ${KELP_COND_GLSL}
      ${COVERAGE_GLSL}
      ${KELP_MARGIN_VARYINGS}

      void main() {
        float cov = bladeCoverage(vUv, vBladeParam, vCond.w, bladeCondition(vCond));
        cov = vIsBlade > 0.5 ? cov : 1.0;
        #if KELP_MSAA == 0
        if (cov < 0.5) discard;
        #endif
        gl_FragColor = vec4(0.0, 0.0, 0.0, cov);
      }
    `,
  });
}

export function createKelpMaterial(segsPerCol, { taps = 8 } = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    // The depth pre-pass has already written depth, with the margins cut: colour lands only on the samples it kept.
    depthWrite: false,
    depthFunc: THREE.EqualDepth,
    defines: { SEGS: segsPerCol, SHADOW_TAPS: `${taps}.0` },
    uniforms: { ...waterUniforms, ...shadowUniforms, ...kelpUniforms, ...tissueUniforms },
    vertexShader: /* glsl */ `
      invariant gl_Position;
      ${KELP_VERTEX_GLSL}
      ${KELP_HASH_GLSL}
      ${KELP_CONDITION_GLSL}
      ${KELP_MARGIN_VARYINGS}
      uniform vec3 uSunDir;
      ${shadowGLSL}
      centroid varying vec3 vNormalW;
      centroid varying vec3 vAlongW;
      centroid varying vec3 vAcrossW;
      centroid varying vec3 vWorldPos;
      varying vec4 vInfo;
      // The canopy's share of the light from above, and the gap up to the kelp shading this point, per vertex: per pixel
      // their taps would step with the shadow map's texels.
      varying float vOpenSky;
      varying float vShadowGap;

      void main() {
        vUv = uv;
        vBladeParam = aBladeParam;
        vIsBlade = aBladeId >= 0.0 ? 1.0 : 0.0;
        vec3 pos = position;
        vec3 nrm = normal;
        kelpDeform(pos, nrm);
        vCond = kelpCondition();
        vInfo = kelpInfo;
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        vWorldPos = wp.xyz;
        vOpenSky = canopyOcclusion(wp.xyz);
        vShadowGap = shadowGapAt(wp.xyz);
        vNormalW = normalize(mat3(modelMatrix) * nrm);
        vAlongW = kelpAlong;
        vAcrossW = kelpAcross;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      ${KELP_MARGIN_VARYINGS}
      centroid varying vec3 vNormalW;
      centroid varying vec3 vAlongW;
      centroid varying vec3 vAcrossW;
      centroid varying vec3 vWorldPos;
      varying vec4 vInfo;
      varying float vOpenSky;
      varying float vShadowGap;

      ${waterGLSL}
      ${shadowGLSL}
      ${BRDF_GLSL}
      ${TISSUE_GLSL}
      ${KELP_HASH_GLSL}
      ${KELP_COND_GLSL}
      ${TISSUE_SAMPLE_GLSL}
      ${BLADE_TISSUE_GLSL}
      ${KELP_SHEET_GLSL}

      void main() {
        vec4 cond = bladeCondition(vCond);
        // The lamina at this blade's own place in the baked tile.
        vec2 tq = vUv / TISSUE_TILE + cond.zw * vec2(13.0, 7.0);
        vec4 tA = texture(tTissueA, tq);
        vec4 tB = texture(tTissueB, tq);
        float px = max(fwidth(vUv.x), fwidth(vUv.y));
        float isBlade = vIsBlade;
        float kind = vCond.w;

        vec3 Ng = normalize(vNormalW);
        vec3 Nf = Ng;
        if (isBlade > 0.5) {
          // Blisters and crinkles tilt the normal: less on bull and palm kelp, little on sporophylls, none at the base.
          vec2 slope = tA.xy * 2.0 - 1.0;
          float amount = (kind < 0.5 ? 1.0 : (kind < 1.5 ? 0.35 : 0.5)) * (abs(cond.y - 1.0) < 0.5 ? 0.2 : 1.0) * smoothstep(0.02, 0.15, vBladeParam.y);
          vec3 along = vAlongW * inversesqrt(max(dot(vAlongW, vAlongW), 1e-12));
          vec3 across = vAcrossW * inversesqrt(max(dot(vAcrossW, vAcrossW), 1e-12));
          Nf = normalize(Ng - (along * slope.x + across * slope.y) * amount);
          // The margins ripple, the ripples running down the blade, faded out before they alias.
          float ripple = 0.008 * smoothstep(0.55, 1.0, abs(vBladeParam.z)) * (kind < 1.5 ? 1.0 : 0.3) * smoothstep(0.03, 0.01, px);
          Nf = normalize(Nf - along * (ripple * 28.6 * cos(vUv.x * 28.6 - uTime * 2.3 + cond.z * 31.0)));
        }
        if (!gl_FrontFacing) {
          Ng = -Ng;
          Nf = -Nf;
        }
        vec3 N = Nf;

        vec3 P = vWorldPos;
        vec3 V = normalize(cameraPosition - P);
        float ndlG = dot(Ng, uSunDir);
        float nv = max(dot(N, V), 0.2);
        float openSky = vOpenSky;
        vec3 shade = sunShadow(P, ndlG >= 0.0 ? Ng : -Ng, SHADOW_TAPS, shadowFloor(0.04, openSky), vShadowGap);
        float caustic = causticAt(P);
        vec3 sun = sunAt(P) * caustic * shade;
        // Light from above: dimmed and turned olive-gold under the canopy, darker toward a bundle's core.
        float bundle = isBlade > 0.5 ? mix(kind < 0.5 ? 0.55 : 0.75, 1.0, smoothstep(0.0, 0.5, vBladeParam.y)) : 0.55;
        vec3 skyLight = mix(uCanopyTint, vec3(1.0), openSky) * bundle;

        vec3 albedo = vec3(0.07, 0.05, 0.018);
        vec3 tau = vec3(0.0);
        float rough = 0.4;
        bool bladder = isBlade < 0.5 && vBladeParam.w < 1.6;
        if (isBlade > 0.5) {
          bladeTissue(kind, cond, vBladeParam, vInfo.y, tA, tB, nv, px, albedo, tau, rough);
        } else if (bladder) {
          // A gas-filled shell with thin walls: lit through the far one it glows like an amber bead, dark at the rim
          // where the near wall is oblique.
          albedo = vec3(0.08, 0.055, 0.018);
          tau = exp(-vec3(1.2, 1.7, 7.0) * 0.5 * (1.0 + 1.0 / max(dot(N, V), 0.12)));
          rough = 0.12;
        }
        vec3 col = kelpSheet(P, N, V, albedo, tau, rough, sun, skyLight, bladder ? 0.7 : 0.55, bladder);
        if (uDebug == 1) col = shade;
        else if (uDebug == 2) col = vec3(caustic * 0.25);
        gl_FragColor = vec4(uDebug == 0 ? applyWater(col, P) : (uDebug == 3 ? col * 0.25 : col), 1.0);
      }
    `,
  });
}

// The kelp in the shadow map: the same vertices, depth only, both sides.
export function createKelpShadowMaterial(segsPerCol) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    defines: { SEGS: segsPerCol },
    uniforms: { ...kelpUniforms },
    vertexShader: /* glsl */ `
      ${KELP_VERTEX_GLSL}
      void main() {
        vec3 pos = position;
        vec3 nrm = normal;
        kelpDeform(pos, nrm);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: shadowDepthFragment,
  });
}

export function createShadowDepthMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: shadowDepthFragment,
  });
}

export function createReefFloorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...waterUniforms, ...shadowUniforms },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      varying float vOpenSky;
      varying float vShadowGap;
      uniform vec3 uSunDir;
      ${shadowGLSL}
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vOpenSky = canopyOcclusion(wp.xyz);
        vShadowGap = shadowGapAt(wp.xyz);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      varying float vOpenSky;
      varying float vShadowGap;
      ${waterGLSL}
      ${shadowGLSL}
      ${NOISE_GLSL}

      // Rocky relief: octaves of value noise, each turned so their grids don't line up, height (0..1) and gradient per
      // metre; the finer ones fade to their mean before they alias.
      vec3 relief(vec2 p, float pixel) {
        vec3 sum = vec3(0.0);
        float amp = 0.5, freq = 0.55;
        mat2 R = mat2(1.0);
        for (int i = 0; i < 6; i++) {
          vec3 n = noise2DGrad(R * p * freq + float(i) * 17.31);
          float fade = smoothstep(0.35, 0.1, pixel * freq);
          sum += vec3(mix(0.5, n.x, fade), transpose(R) * n.yz * freq * fade) * amp;
          R = mat2(0.8, 0.6, -0.6, 0.8) * R;
          freq *= 2.15;
          amp *= 0.5;
        }
        return sum;
      }

      // Now and then a colony on the rock, one cell in eight: a small mound, an urchin's purple, coralline pink or a
      // sponge's orange, half its own colour and half the rock's. rgb: colour, a: cover; slope: its dome's tilt.
      vec4 colony(vec2 p, float cell, float pixel, inout vec2 slope) {
        vec2 c = floor(p / cell);
        float h = hash21(c + 71.3);
        if (h > 0.12) return vec4(0.0);
        float h2 = hash21(c + 13.7);
        float h3 = hash21(c + 5.1);
        vec2 centre = (c + 0.3 + 0.4 * vec2(h2, h3)) * cell;
        float r = cell * (0.1 + 0.18 * fract(h * 37.0)) * (0.85 + 0.3 * noise2D(p * 14.0 / cell));
        vec2 d2 = (p - centre) / r;
        float d = length(d2);
        float soft = max(pixel / r, 0.15);
        float cover = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, d);
        slope += d2 * 0.9 * cover;
        vec3 col = h2 < 0.33 ? vec3(0.1, 0.04, 0.07) : (h2 < 0.66 ? vec3(0.3, 0.14, 0.16) : vec3(0.32, 0.14, 0.05));
        col *= (0.55 + 0.45 * sqrt(max(1.0 - d * d, 0.0))) * (0.75 + 0.5 * noise2D(p * 90.0 / cell));
        return vec4(col, 0.5 * cover);
      }

      void main() {
        vec3 Ng = normalize(vNormalW);
        vec2 p = vWorldPos.xz;
        float pixel = length(fwidth(p));
        vec3 r = relief(p, pixel);
        vec2 mound = vec2(0.0);
        vec4 c1 = colony(p, 0.45, pixel, mound);
        vec4 c2 = colony(p + 3.1, 0.22, pixel, mound);
        vec3 g = vec3(r.y + mound.x, 0.0, r.z + mound.y);
        vec3 N = normalize(Ng - (g - Ng * dot(g, Ng)) * 0.45);
        // Dark rock, sand settled in the hollows, coralline crust and turf on the tops, colonies here and there; the
        // cracks dark.
        float h = r.x;
        float patches = fbm(p * 0.35 + 3.7);
        vec3 rock = mix(vec3(0.07, 0.065, 0.06), vec3(0.13, 0.11, 0.09), noise2D(p * 2.3));
        vec3 albedo = mix(rock, vec3(0.3, 0.26, 0.19), smoothstep(0.42, 0.3, h) * smoothstep(0.35, 0.6, patches));
        albedo = mix(albedo, vec3(0.26, 0.11, 0.15), smoothstep(0.55, 0.75, h) * smoothstep(0.5, 0.7, noise2D(p * 0.9 + 9.1)) * 0.6);
        albedo = mix(albedo, vec3(0.09, 0.1, 0.035), smoothstep(0.45, 0.7, noise2D(p * 1.7 - 4.2)) * 0.5);
        albedo = mix(albedo, c1.rgb, c1.a);
        albedo = mix(albedo, c2.rgb, c2.a);
        float cavity = smoothstep(0.12, 0.4, h);
        albedo *= (0.75 + 0.5 * h) * mix(0.35, 1.0, cavity);

        vec3 P = vWorldPos;
        float openSky = vOpenSky;
        vec3 shade = sunShadow(P, N, 8.0, shadowFloor(0.04, openSky), vShadowGap);
        float caustic = causticAt(P);
        vec3 sun = sunAt(P) * caustic * shade;
        // Light from above, half as olive under the canopy as the kelp's: the reef also sees the open water around it.
        vec3 occ = mix(mix(vec3(0.3), uCanopyTint, 0.5), vec3(1.0), openSky) * mix(0.5, 1.0, cavity);
        vec3 col = albedo * (sun * max(dot(N, uSunDir), 0.0) / 3.14159 + ambientAt(P, N) * occ);
        if (uDebug == 1) col = shade;
        else if (uDebug == 2) col = vec3(caustic * 0.25);
        gl_FragColor = vec4(uDebug == 0 ? applyWater(col, P) : (uDebug == 3 ? col * 0.25 : col), 1.0);
      }
    `,
  });
}

export function createProbeSphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...waterUniforms, ...shadowUniforms },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      ${waterGLSL}
      ${shadowGLSL}
      ${BRDF_GLSL}

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 P = vWorldPos;
        vec3 V = normalize(cameraPosition - P);
        vec3 L = uSunDir;
        vec3 sun = sunAt(P) * causticAt(P) * sunShadow(P, N, 8.0);
        float ndv = max(dot(N, V), 1e-3);
        float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        vec3 albedo = vec3(0.05, 0.06, 0.065);
        vec3 col = albedo * (sun * max(dot(N, L), 0.0) / 3.14159 + ambientAt(P, N));
        col += waterBackground(P, reflect(-V, N)) * mix(0.25, 1.0, fresnel);
        col += sun * ggx(max(dot(N, normalize(L + V)), 0.0), 0.04) * 0.04;
        gl_FragColor = vec4(applyWater(col, P), 1.0);
      }
    `,
  });
}

// Marine snow: specks that show only where the sun lights them, scattering it forward, sized and dimmed as the lens draws
// them. A few drift close to the lens, where they open into faint out-of-focus discs.
export function createMarineSnowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...waterUniforms, ...shadowUniforms, uPixelRatio: { value: 1 }, uViewHeight: { value: 800 } },
    vertexShader: /* glsl */ `
      uniform float uPixelRatio;
      uniform float uViewHeight;
      attribute float aSeed;
      varying vec3 vColor;
      varying float vEdge;
      ${waterGLSL}
      ${shadowGLSL}
      ${TISSUE_GLSL}

      // The lens: focused a few metres out, its aperture as wide as a dome port's blur of what's near makes it.
      const float FOCUS = 4.0;
      const float APERTURE = 0.03;

      void main() {
        vec3 P = (modelMatrix * vec4(position, 1.0)).xyz;
        // One speck in seven stays within 3 m of the eye, wrapped around it; it fades out before it wraps.
        vec3 rel = P - cameraPosition;
        vec3 w = mod(rel + 3.0, 6.0) - 3.0;
        float near = step(fract(aSeed * 13.7), 0.15);
        rel = mix(rel, w, near);
        float fade = mix(1.0, 1.0 - smoothstep(2.2, 3.0, max(abs(w.x), max(abs(w.y), abs(w.z)))), near);
        P = cameraPosition + rel;
        fade *= step(P.y, uSurfaceY - 0.05) * (1.0 - uMurk);
        vec4 mv = viewMatrix * vec4(P, 1.0);
        float dist = max(-mv.z, 0.05);
        vec3 rd = normalize(rel);
        // The sun, where it gets through the kelp, scattered mostly forward; the diffuse light only greys them faintly.
        vec3 through = sunThroughKelpSoft(P, shadowDepthScale());
        vec3 sun = sunAt(P) * min(causticAt(P), 2.0) * through * hg(dot(rd, uSunDir), 0.6);
        vec3 sky = mix(uCanopyTint, vec3(1.0), canopyOcclusion(P));
        float amb = dot(ambientAt(P, -rd) * sky, vec3(0.2126, 0.7152, 0.0722)) * 0.02;
        vec3 radiance = (sun + amb) * 0.3 * (0.6 + 0.8 * fract(aSeed * 7.3));
        // Drawn as big as the speck's image or its blur out of focus, at least a pixel, with its light spread over that:
        // far specks dim instead of brightening, near ones open into faint discs. Most are under 2 mm.
        float pxAngle = 2.0 / (projectionMatrix[1][1] * uViewHeight * uPixelRatio);
        float diameter = 0.0008 + 0.006 * pow(fract(aSeed * 3.1), 3.0);
        float image = diameter / dist / pxAngle;
        float blur = APERTURE * abs(1.0 / dist - 1.0 / FOCUS) / pxAngle;
        float size = clamp(max(image, blur), 1.0, 64.0 * uPixelRatio);
        vColor = radiance * exp(-uSigma * dist) * min(image * image / (size * size), 1.0) * fade;
        vEdge = min(1.5 / size, 0.5);
        gl_PointSize = size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vEdge;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float disc = 1.0 - smoothstep(0.5 - vEdge, 0.5, r);
        if (disc <= 0.0) discard;
        gl_FragColor = vec4(vColor * disc, 1.0);
      }
    `,
  });
}
