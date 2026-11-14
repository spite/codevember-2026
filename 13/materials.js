// Physically grounded, multi-layer procedural materials for the 12 labyrinth finishes & 9 marble styles:
// - Pre-baked tileable 64^3 HalfFloat (RGBA16F) 4-channel 3D volume (domain warp, 4-octave FBM, Worley domes, Worley ridges)
//   for quantization-free trilinear derivatives and zero-cost shadow/prepass skips.
// - Smooth C1 height fields only in dFdx/dFdy applyBump (zero 2x2 quad stair-step or spike artifacts), while crisp per-pixel
//   masks drive albedo, roughness, metalness, and occlusion.
// - Physically measured linear reflectance (F0) for metals and multi-layer subsurface optics (Snell-refracted depth for
//   clearcoated 3K 2x2 twill carbon fiber, Song Qingbai celadon-pooled porcelain, nephrite jade, alabaster, and cabochon gems;
//   longitudinal solid-timber hardwood with chatoyancy & hair-thin pores; vein-cut travertine; fine forge-folded Damascus).
import {
  Color,
  Vector3,
  Data3DTexture,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  ShaderMaterial,
  GreaterDepth,
  DataTexture,
  RedFormat,
  FloatType,
  NearestFilter,
  Matrix4,
} from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

export const FINISHES = {
  "walnut & brass": {
    id: 0,
    acoustic: "wood",
    backdrop: "#221b17",
    exposure: 1.02,
    floorColor: "#422414",
    floorSecondary: "#1c0c05",
    floorRough: 0.28,
    floorMetal: 0.0,
    wallColor: "#d6b07a",
    wallCrown: "#ead0a4",
    wallRough: 0.30,
    wallMetal: 0.0,
    rimColor: "#f3d57e",
    rimMetal: 1.0,
    rimRough: 0.16,
    marbleColor: "#d6dade",
    marbleAccent: "#9ea5b0",
    marbleMetal: 1.0,
    marbleRough: 0.034,
    marbleStyle: 0, // hardened 52100 chrome steel ball bearing
  },
  boxwood: {
    id: 1,
    acoustic: "wood",
    backdrop: "#d8d1c5",
    exposure: 0.92,
    floorColor: "#dfc28e",
    floorSecondary: "#c49f66",
    floorRough: 0.28,
    floorMetal: 0.0,
    wallColor: "#45180d",
    wallCrown: "#632617",
    wallRough: 0.25,
    wallMetal: 0.0,
    rimColor: "#ecc66c",
    rimMetal: 1.0,
    rimRough: 0.18,
    marbleColor: "#244ea8",
    marbleAccent: "#6c3694",
    marbleMetal: 1.0,
    marbleRough: 0.042,
    marbleStyle: 1, // 290 C heat-blued watchmaker steel
  },
  "black enamel": {
    id: 2,
    acoustic: "metal",
    backdrop: "#191a20",
    exposure: 1.03,
    floorColor: "#010102",
    floorSecondary: "#05060a",
    floorRough: 0.030,
    floorMetal: 0.0,
    wallColor: "#ebb949",
    wallCrown: "#ffe084",
    wallRough: 0.24,
    wallMetal: 1.0,
    rimColor: "#ffdf82",
    rimMetal: 1.0,
    rimRough: 0.12,
    marbleColor: "#c82614",
    marbleAccent: "#f7efe4",
    marbleMetal: 0.0,
    marbleRough: 0.034,
    marbleStyle: 2, // banded carnelian / sardonyx eye agate
  },
  travertine: {
    id: 3,
    acoustic: "stone",
    backdrop: "#d4cdc0",
    exposure: 0.91,
    floorColor: "#d6c7ae",
    floorSecondary: "#9e8b6f",
    floorRough: 0.35,
    floorMetal: 0.0,
    wallColor: "#e6decb",
    wallCrown: "#f1eadc",
    wallRough: 0.33,
    wallMetal: 0.0,
    rimColor: "#cca062",
    rimMetal: 0.98,
    rimRough: 0.22,
    marbleColor: "#08090c",
    marbleAccent: "#782f1d",
    marbleMetal: 0.0,
    marbleRough: 0.030,
    marbleStyle: 3, // banded volcanic mahogany-sheen obsidian
  },
  "verdigris bronze": {
    id: 4,
    acoustic: "metal",
    backdrop: "#1d2321",
    exposure: 1.04,
    floorColor: "#6e5030",
    floorSecondary: "#3f8c6e",
    floorRough: 0.32,
    floorMetal: 0.84,
    wallColor: "#7d5b36",
    wallCrown: "#e6b66c",
    wallRough: 0.26,
    wallMetal: 0.94,
    rimColor: "#efc574",
    rimMetal: 1.0,
    rimRough: 0.16,
    marbleColor: "#f7f4ec",
    marbleAccent: "#7d838e",
    marbleMetal: 1.0,
    marbleRough: 0.042,
    marbleStyle: 0, // antiqued sterling silver
  },
  "porcelain & cobalt": {
    id: 5,
    acoustic: "stone",
    backdrop: "#d3dce2",
    exposure: 0.90,
    floorColor: "#eef3f4",
    floorSecondary: "#7ab8b6",
    floorRough: 0.038,
    floorMetal: 0.0,
    wallColor: "#f2f6f7",
    wallCrown: "#123488",
    wallRough: 0.042,
    wallMetal: 0.0,
    rimColor: "#f0b494",
    rimMetal: 0.98,
    rimRough: 0.17,
    marbleColor: "#f4d683",
    marbleAccent: "#c79a3e",
    marbleMetal: 1.0,
    marbleRough: 0.072,
    marbleStyle: 4, // lathe-turned solid C260 brass
  },
  "damascus & gold": {
    id: 6,
    acoustic: "metal",
    backdrop: "#191b20",
    exposure: 1.04,
    floorColor: "#dfe5ef",
    floorSecondary: "#434a56",
    floorRough: 0.17,
    floorMetal: 0.95,
    wallColor: "#e4e9f2",
    wallCrown: "#f2f5fa",
    wallRough: 0.15,
    wallMetal: 0.97,
    rimColor: "#ffdf7d",
    rimMetal: 1.0,
    rimRough: 0.11,
    marbleColor: "#8a8f98",
    marbleAccent: "#565b63",
    marbleMetal: 1.0,
    marbleRough: 0.032,
    marbleStyle: 0, // lapped tungsten carbide (WC-Co)
  },
  "jade & gilt": {
    id: 7,
    acoustic: "stone",
    backdrop: "#1c221e",
    exposure: 1.02,
    floorColor: "#356648",
    floorSecondary: "#142e1e",
    floorRough: 0.13,
    floorMetal: 0.0,
    wallColor: "#4f8262",
    wallCrown: "#86ba96",
    wallRough: 0.12,
    wallMetal: 0.0,
    rimColor: "#ffdf82",
    rimMetal: 1.0,
    rimRough: 0.14,
    marbleColor: "#f2ede2",
    marbleAccent: "#cfd6c8",
    marbleMetal: 0.0,
    marbleRough: 0.10,
    marbleStyle: 7, // Hetian mutton-fat white nephrite jade
  },
  "terracotta & basalt": {
    id: 8,
    acoustic: "stone",
    backdrop: "#251d1a",
    exposure: 1.0,
    floorColor: "#a64828",
    floorSecondary: "#63210d",
    floorRough: 0.78,
    floorMetal: 0.0,
    wallColor: "#262930",
    wallCrown: "#383c45",
    wallRough: 0.58,
    wallMetal: 0.0,
    rimColor: "#e6be73",
    rimMetal: 0.98,
    rimRough: 0.22,
    marbleColor: "#14348f",
    marbleAccent: "#f5d478",
    marbleMetal: 0.0,
    marbleRough: 0.065,
    marbleStyle: 5, // Badakhshan lapis lazuli with pyrite crystals
  },
  "lapis & alabaster": {
    id: 9,
    acoustic: "stone",
    backdrop: "#181d2b",
    exposure: 1.0,
    floorColor: "#0c2063",
    floorSecondary: "#1c43a8",
    floorRough: 0.11,
    floorMetal: 0.0,
    wallColor: "#eadfce",
    wallCrown: "#f8f2e4",
    wallRough: 0.20,
    wallMetal: 0.0,
    rimColor: "#ffdf82",
    rimMetal: 1.0,
    rimRough: 0.13,
    marbleColor: "#ffe084",
    marbleAccent: "#cf9b3a",
    marbleMetal: 1.0,
    marbleRough: 0.052,
    marbleStyle: 4, // solid 24k burnished gold sphere
  },
  "carbon & titanium": {
    id: 10,
    acoustic: "metal",
    backdrop: "#16181d",
    exposure: 1.04,
    floorColor: "#040507",
    floorSecondary: "#1c212b",
    floorRough: 0.032,
    floorMetal: 0.0,
    wallColor: "#b8b3aa",
    wallCrown: "#dad5cd",
    wallRough: 0.24,
    wallMetal: 0.98,
    rimColor: "#f09048",
    rimMetal: 0.98,
    rimRough: 0.14,
    marbleColor: "#b80f24",
    marbleAccent: "#ff3850",
    marbleMetal: 0.0,
    marbleRough: 0.025,
    marbleStyle: 6, // synthetic ruby corundum bearing
  },
  "yakisugi & copper": {
    id: 11,
    acoustic: "wood",
    backdrop: "#201a18",
    exposure: 1.04,
    floorColor: "#08080a",
    floorSecondary: "#16110e",
    floorRough: 0.48,
    floorMetal: 0.0,
    wallColor: "#e59d84",
    wallCrown: "#fad0c0",
    wallRough: 0.18,
    wallMetal: 0.98,
    rimColor: "#f7c4b0",
    rimMetal: 1.0,
    rimRough: 0.14,
    marbleColor: "#f2eee6",
    marbleAccent: "#3b3632",
    marbleMetal: 0.0,
    marbleRough: 0.042,
    marbleStyle: 8, // white Raku crackle-glazed ceramic
  },
};

// Filled once the worker has baked it (see noise.js).
function createNoiseVolume(size) {
  const tex = new Data3DTexture(new Uint16Array(size * size * size * 4), size, size, size);
  tex.format = RGBAFormat;
  tex.type = HalfFloatType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapR = RepeatWrapping;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared GLSL Physical Material Library
// ---------------------------------------------------------------------------
// Floor reflections of the walls and the marble: the reflection ray marches the walls' distance field (capsules from
// the maze, looked up through a CSR grid in data textures) and meets the marble analytically.
const REFLECTION_GLSL = /* glsl */ `
uniform highp sampler2D uRefCaps;
uniform highp sampler2D uRefOffsets;
uniform highp sampler2D uRefItems;
uniform float uRefRes;
uniform float uRefHalf;
uniform float uRefMargin;
uniform float uWallHalfW;
uniform float uWallH;
uniform vec3 uWallColor;
uniform vec3 uCrownColor;
uniform float uWallMetal;
uniform float uWallRough;
uniform vec3 uMarbleColorRef;
uniform float uMarbleMetalRef;
uniform float uMarbleRefRadius;
uniform float uReflect;
uniform float uRefStrength;
uniform float uRefReach;
uniform float uMirrorTest;
uniform mat4 uWorldToLocal;

// Set by the floor's surface(): object-space normal, world size of a pixel, and the floor's reflectance at normal
// incidence (to skip rays whose reflection would be too faint or too small to see).
vec3 refFloorNormal = vec3(0.0, 1.0, 0.0);
float refFootprint = 0.0;
float refF0 = 0.04;

float refFetch(highp sampler2D t, int i) {
  return texelFetch(t, ivec2(i & 1023, i >> 10), 0).r;
}

vec3 capTexel(int i, int k) {
  int j = i * 3 + k;
  return texelFetch(uRefCaps, ivec2(j & 1023, j >> 10), 0).xyz;
}

// Distance to the nearest wall or the marble; kind 0 = wall, 1 = marble.
float refScene(vec3 p, out vec3 nrm, out float top, out float kind) {
  float best = length(p - uMarbleLocalPos) - uMarbleRefRadius;
  nrm = normalize(p - uMarbleLocalPos);
  top = 0.0;
  kind = 1.0;
  vec3 g = floor((p + uRefHalf) * (uRefRes / (2.0 * uRefHalf)));
  if (any(lessThan(g, vec3(0.0))) || any(greaterThanEqual(g, vec3(uRefRes)))) return best;
  int res = int(uRefRes);
  int cell = (int(g.z) * res + int(g.y)) * res + int(g.x);
  int start = int(refFetch(uRefOffsets, cell));
  int end = min(int(refFetch(uRefOffsets, cell + 1)), start + 64);
  float H = uWallH * clamp(uWallRaise, 0.0, 1.0);
  for (int k = start; k < end; k++) {
    int i = int(refFetch(uRefItems, k));
    vec3 a = capTexel(i, 0);
    vec3 ab = capTexel(i, 1) - a;
    vec3 up = capTexel(i, 2);
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
    vec3 q = p - (a + ab * t);
    float h = dot(q, up);
    vec3 side = q - up * h;
    float lat = length(side);
    vec2 d = vec2(lat - uWallHalfW, abs(h - H * 0.5) - H * 0.5);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    if (dist < best) {
      best = dist;
      nrm = d.y > d.x ? up : side / max(lat, 1e-6);
      top = clamp(h / max(H, 1e-5), 0.0, 1.0);
      kind = 0.0;
    }
  }
  return best;
}

// P and R in world space. Returns lit radiance and how much of the reflection it covers (soft for rough floors).
vec4 traceReflection(vec3 P, vec3 R, float rough) {
  if (uReflect < 0.5 || rough > 0.55) return vec4(0.0);
  // LOD: a reflection is about one wall height across; fade it out once that's only a couple of pixels.
  float lod = smoothstep(1.5, 4.0, uWallH / max(refFootprint * length(mat3(uWorldToLocal)[0]), 1e-6));
  // Visibility bound: Fresnel at this angle, dimmed by roughness.
  vec3 V = normalize(cameraPosition - P);
  float NdotV = clamp(dot(normalize(R + V), V), 0.0, 1.0);
  float fresnel = refF0 + (1.0 - refF0) * pow(1.0 - NdotV, 5.0);
  if (lod * fresnel * (1.0 - rough) * (1.0 - rough) < 0.025) return vec4(0.0);
  vec3 o = (uWorldToLocal * vec4(P, 1.0)).xyz;
  // Hits fade as exp(-t / reach): past about three reaches they're invisible, so far pixels and long rays stop early.
  float reachLen = max(uRefReach * uWallH, 1e-4);
  float nearest = min(vWallFar, length(o - uMarbleLocalPos) - uMarbleRefRadius);
  if (nearest > reachLen * 3.0) return vec4(0.0);
  vec3 dir = normalize(mat3(uWorldToLocal) * R);
  // Walls only reach uWallH above the floor: a steep ray clears them within a short distance.
  float rise = dot(dir, refFloorNormal);
  float maxT = min(max(uRefReach * uWallH, 1e-4) * 3.0, (uWallH + 0.01) / max(rise, 0.025));
  float cone = 0.012 + rough * 1.3;
  float t = 0.003;
  float best = 1e9;
  float hitT = 0.0;
  vec3 hitN = vec3(0.0, 1.0, 0.0);
  float hitTop = 0.0;
  float hitKind = 0.0;
  // Contact hardening: the cone widens with distance, so reflections blur as they move away from what casts them.
  float reach = max(uRefReach * uWallH, 1e-4);
  for (int k = 0; k < 40; k++) {
    vec3 n;
    float top, kind;
    float d = refScene(o + dir * t, n, top, kind);
    float ratio = d / ((cone + 0.15 * t / reach) * t);
    if (ratio < best) {
      best = ratio;
      hitT = t;
      hitN = n;
      hitTop = top;
      hitKind = kind;
    }
    if (d < 0.0004) {
      best = 0.0;
      break;
    }
    // A step floor that grows with distance keeps rays skimming a wall face from running out of steps.
    t += clamp(d, 0.0015 + t * 0.02, uRefMargin);
    if (t > maxT) break;
  }
  // A blurred edge spreads the reflection thinner rather than widening it at full strength.
  float soft = 1.0 - smoothstep(0.0, 1.0, best);
  float cover = soft * soft * exp(-hitT / reach) * uRefStrength * lod;
  if (cover <= 0.0) return vec4(0.0);

  vec3 nW = normalize(mat3(modelMatrix) * hitN);
  vec3 albedo = hitKind > 0.5 ? uMarbleColorRef : mix(uWallColor, uCrownColor, smoothstep(0.55, 1.0, hitTop));
  float metal = hitKind > 0.5 ? uMarbleMetalRef : uWallMetal;
  float hitRough = hitKind > 0.5 ? 0.12 : uWallRough;
  // Diffuse from the key light and studio, plus the studio's mirror image; no key-light highlight, which a flat-topped
  // stand-in for the rounded crowns would turn into stray bright streaks.
  vec3 L = normalize(lightDirection);
  vec3 irradiance = max(evalSH(envRotation * nW), vec3(0.0)) * envIntensity;
  vec3 diffuse = albedo * (irradiance + lightColor * max(dot(nW, L), 0.0) * PIPELINE_INV_PI);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 env = textureLod(envMap, envRotation * reflect(R, nW), envMapMaxLod * hitRough * (2.0 - hitRough)).rgb * envIntensity;
  return vec4(mix(diffuse, diffuse * 0.5, metal) + env * f0, cover);
}
`;

const MATERIAL_COMMON_GLSL = /* glsl */ `
uniform highp sampler3D uNoiseVol;
uniform float uLowDetail;
uniform mat4 modelMatrix;

// Largest per-axis screen footprint of p, so a fade works on faces of any orientation.
float maxFwidth(vec3 p) {
  vec3 fw = fwidth(p);
  return max(max(fw.x, fw.y), fw.z);
}

vec4 sampleVol(vec3 p) {
  return textureLod(uNoiseVol, p, 0.0);
}

// Transforms a world-space unit vector into object space (handles uniform scale + rotation cleanly).
vec3 worldDirToObject(vec3 worldDir) {
  return normalize(transpose(mat3(modelMatrix)) * worldDir);
}

// Refracted object-space lookup beneath a clear glaze / lacquer / gem cabochon of thickness coatDepth.
vec3 refractedObjPos(vec3 pObj, vec3 nObj, float eta, float coatDepth) {
  vec3 vWorld = normalize(cameraPosition - vWorldPosition);
  vec3 vObj = worldDirToObject(vWorld);
  vec3 rDir = refract(-vObj, normalize(nObj), eta);
  if (dot(rDir, rDir) < 1e-6) rDir = -vObj;
  return pObj + rDir * coatDepth;
}

vec3 surfGrad(vec3 nrm, float h) {
  vec3 dpdx = dFdx(vWorldPosition);
  vec3 dpdy = dFdy(vWorldPosition);
  vec3 r1 = cross(dpdy, nrm);
  vec3 r2 = cross(nrm, dpdx);
  float det = dot(dpdx, r1);
  float sgn = det < 0.0 ? -1.0 : 1.0;
  det = sgn * max(abs(det), 1e-12);
  return (dFdx(h) * r1 + dFdy(h) * r2) / det;
}

void applyBump(inout Surface s, float heightWorld, float maxSlope) {
  vec3 g = surfGrad(s.normal, heightWorld);
  g /= sqrt(1.0 + dot(g, g) / (maxSlope * maxSlope));
  s.normal = normalize(s.normal - g);
}

void specularAA(inout Surface s) {
  vec3 dx = dFdx(s.normal);
  vec3 dy = dFdy(s.normal);
  float variance = min(0.45 * (dot(dx, dx) + dot(dy, dy)), 0.16);
  float a = s.roughness * s.roughness;
  s.roughness = sqrt(sqrt(clamp(a * a + variance, 8e-7, 1.0)));
}

// Solid-block longitudinal cabinetmaker timber:
// - Longitudinal plank grain axis so main faces show sweeping cathedral arches & long silky wood fibres
// - Authentic end-grain optical darkening & matte oil absorption where timber axis exits the solid
// - Hair-thin 38:1 elongated earlywood vessel pores (albedo/roughness only — smooth C1 height avoids 2x2 bump spikes!)
// - Quartersawn medullary ray flecks & view-dependent chatoyant curl
void evalHardwood(
  vec3 p,
  vec3 objNrm,
  vec3 grainAxis,
  vec3 baseCol,
  vec3 darkCol,
  float ringFreq,
  float ringContrast,
  float poreStrength,
  out vec3 outColor,
  out float outRoughDelta,
  out float outHeight
) {
  vec3 upRef = abs(grainAxis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 uAx = normalize(cross(upRef, grainAxis));
  vec3 vAx = cross(grainAxis, uAx);

  float along = dot(p, grainAxis);
  vec2 radialXY = vec2(dot(p, uAx), dot(p, vAx));
  vec3 nObj = normalize(objNrm);
  float endGrain = pow(abs(dot(nObj, grainAxis)), 2.6);

  // Offset log heart center + irregular dry/wet year ring-width modulation so growth rings vary organically like real timber!
  vec4 nLow = sampleVol(p * 0.42 + vec3(0.17, 0.31, 0.43));
  vec4 nMed = sampleVol(p * 1.45 + vec3(0.53, 0.11, 0.29));
  vec2 logCenter = radialXY + vec2(0.68, -0.52) + (nLow.rg - 0.5) * 0.14 + (nMed.rg - 0.5) * 0.03;
  float rDist = length(logCenter);
  vec4 nYear = sampleVol(vec3(rDist * 2.4, along * 0.18 + 0.31, 0.57));
  float ringCoord = rDist * ringFreq + (nYear.r - 0.5) * 2.8 + along * 0.85 + nLow.g * 1.65;
  float ringLod = 1.0 - smoothstep(0.24, 0.78, fwidth(ringCoord));

  // Asymmetric botanical growth ring: gradual summer->autumn darkening, crisp winter boundary!
  float ringFrac = fract(ringCoord);
  float latewood = smoothstep(0.34, 0.86, ringFrac) * (1.0 - smoothstep(0.88, 0.992, ringFrac));
  latewood = mix(0.36, latewood, ringLod);
  float earlyZone = (1.0 - smoothstep(0.02, 0.34, ringFrac)) * ringLod;

  // Fine continuous parallel wood tracheid fibres stretched 22:1 along the timber axis!
  vec3 fibreCoord = vec3(radialXY * 10.5, along * 0.48);
  vec4 nFibre = sampleVol(fibreCoord);
  float fibreLod = (1.0 - uLowDetail * 0.5) * (1.0 - smoothstep(0.18, 0.55, max(fwidth(fibreCoord.x), fwidth(fibreCoord.y)) * 6.5));
  float fibres = (nFibre.g - 0.5) * fibreLod;

  // Ultra-fine secondary micro-grain & dark mineral pigment streaks along timber length.
  vec3 streakCoord = vec3(radialXY * 19.0, along * 0.55) + vec3(nLow.r, nLow.g, nLow.r * 0.5) * 0.18;
  vec4 nStreak = sampleVol(streakCoord);
  float fineStreaks = (nStreak.g - 0.5) * fibreLod;
  float inkStreak = smoothstep(0.66, 0.92, nStreak.r) * ringContrast * (1.0 - endGrain * 0.6);

  // Quartersawn medullary ray ribbons where surface normal aligns with circumferential log tangent.
  vec2 radDir = logCenter / max(rDist, 1e-4);
  vec3 rayTangent = uAx * (-radDir.y) + vAx * radDir.x;
  float quarterMask = pow(abs(dot(nObj, rayTangent)), 2.8) * (1.0 - endGrain);
  vec4 nRay = sampleVol(vec3(atan(logCenter.y, logCenter.x) * 3.5, along * 3.8, rDist * 2.8));
  float medRay = smoothstep(0.70, 0.93, nRay.g) * quarterMask * ringLod * 0.55;

  // Hair-thin 38:1 longitudinal earlywood vessel lines (domain-warped FBM x Worley, never round polka dots!).
  vec3 poreCoord = vec3(radialXY * 24.0 + (nFibre.rg - 0.5) * 0.22, along * 0.62);
  vec4 nPore = sampleVol(poreCoord);
  float poreLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.14, 0.48, max(fwidth(poreCoord.x), fwidth(poreCoord.y)) * 6.0));
  float vesselLine = smoothstep(0.74, 0.95, nPore.b * 0.68 + nStreak.g * 0.42) * (0.22 + 0.78 * earlyZone) * (1.0 - endGrain * 0.7) * poreStrength * poreLod;

  // View-dependent chatoyant figure shimmer along the wood fibres.
  vec3 vObj = worldDirToObject(normalize(cameraPosition - vWorldPosition));
  float viewAlong = dot(vObj, grainAxis);
  float curlWave = sin(along * 20.0 + nLow.r * 7.5);
  float chatoyancy = (0.5 + 0.5 * sin(curlWave * 2.0 + viewAlong * 3.2)) * (1.0 - endGrain * 0.8);

  float darkMix = clamp(latewood * ringContrast + inkStreak * 0.48, 0.0, 0.96);
  vec3 woodTone = mix(baseCol * (0.91 + 0.18 * fibres + 0.10 * fineStreaks + 0.09 * chatoyancy), darkCol, darkMix);
  woodTone = mix(woodTone, baseCol * 1.15, medRay * 0.38);
  woodTone *= mix(1.0, 0.76, endGrain * 0.85);
  woodTone *= 1.0 - vesselLine * 0.48;

  outColor = woodTone;
  outRoughDelta = -0.05 * latewood - fibres * 0.06 - fineStreaks * 0.04 + endGrain * 0.10 + vesselLine * 0.34;
  // Strictly smooth C1 fibre & latewood micro-undulation in height (zero sharp pore step spikes!).
  outHeight = (fibres * 0.00015 + fineStreaks * 0.00008 - latewood * 0.00009 * ringLod) * (1.0 - endGrain * 0.5);
}

// Vein-cut Honed Roman Travertine: tilted fine millimetre-scale sedimentary beds, sparry calcite veins, and elongated lenticular vugs!
void evalTravertine(
  vec3 p,
  vec3 baseCol,
  vec3 darkCol,
  out vec3 outColor,
  out float outRoughDelta,
  out float outOcc,
  out float outHeight
) {
  // Tilted sedimentary bedding axis so horizontal, vertical, and curved faces all show crisp fine vein-cut strata!
  vec3 bedAxis = normalize(vec3(0.38, 0.82, 0.43));
  vec3 bedU = normalize(cross(vec3(0.0, 0.0, 1.0), bedAxis));
  vec3 bedV = cross(bedAxis, bedU);

  vec4 nLow = sampleVol(p * 0.48);
  vec4 nFine = sampleVol(p * 3.2);
  float bedPos = dot(p, bedAxis);
  float bedCoord = bedPos * 14.5 + (nLow.r - 0.5) * 1.45 + (nFine.g - 0.5) * 0.24;
  float bedLod = 1.0 - smoothstep(0.24, 0.78, fwidth(bedCoord));

  // Multi-harmonic sedimentary laminations (broad beds + delicate sub-millimetre varves).
  float macroBed = 0.5 + 0.5 * sin(bedCoord * 6.2831853);
  float microBed = 0.5 + 0.5 * sin(bedCoord * 21.99 + nFine.r * 3.0);
  float fineVarve = nFine.g;
  float strata = mix(0.5, clamp(macroBed * 0.58 + microBed * 0.28 + fineVarve * 0.24 - 0.05, 0.0, 1.0), bedLod);

  // Elongated 8:1 lenticular sedimentary vugs stretched strictly parallel to the bedding plane!
  float porousHorizon = smoothstep(0.52, 0.84, 1.0 - macroBed) * smoothstep(0.38, 0.72, nLow.g);
  vec3 vugWarp = vec3(nFine.r - 0.5, nFine.g - 0.5, (nFine.r - nFine.g) * 0.5) * 0.34;
  vec3 vugCoord = vec3(dot(p, bedU) * 1.85, bedPos * 14.8, dot(p, bedV) * 1.85) + vugWarp;
  vec4 nVug = sampleVol(vugCoord);
  float vugLod = (1.0 - uLowDetail * 0.5) * (1.0 - smoothstep(0.16, 0.56, fwidth(vugCoord.y) * 3.2));
  float vugRaw = nVug.b * 0.72 + nFine.b * 0.28;
  float fissure = smoothstep(0.50, 0.82, vugRaw) * porousHorizon * vugLod;
  float softFissure = smoothstep(0.32, 0.88, vugRaw) * porousHorizon * vugLod;

  // Translucent sparry calcite veins & fine honed limestone micro-grain.
  vec4 nVein = sampleVol(p * 0.75 + vec3(0.41, 0.19, 0.63));
  float vein = smoothstep(0.76, 0.95, nVein.a) * (1.0 - fissure) * bedLod;
  float grain = (nFine.g - 0.5) * (1.0 - smoothstep(0.2, 0.6, maxFwidth(p) * 24.0));

  outColor = mix(darkCol * 0.90, baseCol * 1.07, strata);
  outColor = mix(outColor, baseCol * 1.16, vein * 0.55);
  outColor = mix(outColor, darkCol * 0.54, fissure);

  outRoughDelta = fissure * 0.52 - vein * 0.15 - grain * 0.06;
  outOcc = mix(1.0, 0.34, fissure);
  // Smooth C1 softFissure in height avoids pixelated cliff edges while carving crisp shadowed vugs!
  outHeight = -softFissure * 0.00095 + grain * 0.00012;
}

// Fine Forge-Folded Acid-Etched Damascus Steel (~60 tight woodgrain/watering steel layers, satin sanding lines, C1 relief!):
void evalDamascus(
  vec3 p,
  vec3 brightSteel,
  vec3 darkSteel,
  out vec3 outColor,
  out float outMetal,
  out float outRough,
  out float outHeight
) {
  vec4 w1 = sampleVol(p * 1.05);
  vec4 w2 = sampleVol(p * 2.85 + vec3(w1.r - 0.5, w1.g - 0.5, (w1.r - w1.g) * 0.5) * 0.42);
  vec4 w3 = sampleVol(vec3(p.x * 16.0, p.y * 2.5, p.z * 2.5));
  // Tilted forge-lamination stack warped purely by smooth FBM (.r/.g, never Worley .b) so every face shows tight steel watering!
  float lam = dot(p, normalize(vec3(0.58, 0.56, 0.59))) * 220.0;
  float phase = lam + (w1.g - 0.5) * 34.0 + (w2.g - 0.5) * 14.0 + (w1.r - 0.5) * 20.0;
  // Footprint of the smooth lamination term: per-2x2 derivatives of the full warped phase jump between blocks.
  float fw = max(fwidth(lam), 1e-4);
  float lod = 1.0 - smoothstep(2.0, 5.0, fw);
  float wave = sin(phase);
  float band = smoothstep(-0.32 - fw * 0.5, 0.32 + fw * 0.5, wave);
  band = mix(0.52, band, lod);

  // Fine 1200-grit hand-rubbed satin steel sanding lines across the billet.
  float satinLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.22, 0.70, maxFwidth(p) * 28.0));
  float brush = (w3.g - 0.5) * satinLod;
  outColor = mix(darkSteel * 1.28, brightSteel, band) * (0.96 + 0.08 * brush);
  outMetal = mix(0.86, 1.0, band);
  outRough = mix(0.30, 0.13, band) + brush * 0.045;
  outHeight = wave * 0.00009 * lod + brush * 0.00005;
}

// Blended seam-free triplanar 3K 2x2 twill carbon fiber evaluated at a Snell-refracted depth under clear epoxy,
// with raven-black resin valleys and orthogonal warp/weft anisotropic graphite filament flip-flop!
// fwUv is fwidth(uvPlane), taken by the caller outside any per-pixel branch.
vec3 evalCarbonTwillPlane(vec2 uvPlane, vec2 fwUv, vec3 axisU, vec3 axisV, vec3 nObj, vec3 vObj, vec3 lObj, vec3 darkCol, vec3 brightCol, out float outTowH) {
  vec2 cellUv = uvPlane * 44.0;
  float fw = max(fwUv.x, fwUv.y) * 44.0;
  float lodC = (1.0 - uLowDetail) * (1.0 - smoothstep(0.22, 0.70, fw));
  vec2 gv = fract(cellUv);
  vec2 idv = floor(cellUv);

  // Authentic 2x2 twill step: two over, two under, stepping diagonally by 1 each row!
  float stepIdx = mod(idv.x + idv.y, 4.0);
  float isWarp = stepIdx < 1.5 ? 1.0 : 0.0;
  float acrossCoord = isWarp > 0.5 ? gv.y : gv.x;
  float alongCoord = isWarp > 0.5 ? (gv.x + mod(idv.x - idv.y, 2.0)) * 0.5 : (gv.y + mod(idv.y - idv.x, 2.0)) * 0.5;

  float acrossArch = sin(acrossCoord * 3.14159265);
  float crimpArch = sin(clamp(alongCoord, 0.0, 1.0) * 3.14159265);
  float crown = acrossArch * (0.48 + 0.52 * crimpArch);
  float gapMask = smoothstep(0.0, 0.16, acrossArch);

  // Individual 3K carbon micro-filaments running lengthwise along each tow.
  float strandCoord = (isWarp > 0.5 ? cellUv.y : cellUv.x) * 8.0;
  float strandLod = 1.0 - smoothstep(0.25, 0.75, (isWarp > 0.5 ? fwUv.y : fwUv.x) * 44.0 * 8.0);
  float filaments = mix(0.5, 0.5 + 0.5 * sin(strandCoord * 6.2831853), strandLod);

  // Orthogonal cylinder tilt of warp vs weft fiber normals -> deep holographic graphite flip-flop!
  vec3 acrossAxis = isWarp > 0.5 ? axisV : axisU;
  vec3 alongAxis = isWarp > 0.5 ? axisU : axisV;
  float acrossSlope = cos(acrossCoord * 3.14159265) * 0.36;
  float crimpSlope = cos(clamp(alongCoord, 0.0, 1.0) * 3.14159265) * 0.30;
  vec3 towNormal = normalize(nObj + acrossAxis * acrossSlope + alongAxis * crimpSlope);

  vec3 hObj = normalize(vObj + lObj);
  float anisoSpec = pow(max(dot(towNormal, hObj), 0.0), 18.0);
  float anisoView = pow(max(dot(towNormal, vObj), 0.0), 7.0);
  float towSheen = gapMask * crown * (0.18 + 0.65 * anisoView + 1.55 * anisoSpec) * (0.82 + 0.36 * filaments);
  float flipFlop = mix(0.32, towSheen, lodC);

  outTowH = (crown - 0.5) * lodC;
  return mix(darkCol, brightCol * 1.35, clamp(flipFlop, 0.0, 1.25));
}
`;

export function createLabyrinthMaterials({ lowDetail = false } = {}) {
  const noiseVol = createNoiseVolume(lowDetail ? 48 : 64);

  const shared = {
    uNoiseVol: { value: noiseVol },
    uLowDetail: { value: lowDetail ? 1.0 : 0.0 },
    uFinishId: { value: 0 },
    uMarbleStyle: { value: 0 },
    uFloorSecondary: { value: new Color("#1c0c05") },
    uRimColor: { value: new Color("#f3d57e") },
    uRimMetal: { value: 1.0 },
    uRimRough: { value: 0.16 },
    uCrownColor: { value: new Color("#ead0a4") },
    uMarbleAccent: { value: new Color("#9ea5b0") },
    uMarbleLocalPos: { value: new Vector3(0, 2, 0) },
    uMarbleRadius: { value: 0.035 },
    uGoalLocalPos: { value: new Vector3(0, -1, 0) },
    uStartLocalPos: { value: new Vector3(0, 1, 0) },
    uPocketRadius: { value: 0.055 },
    uWallRaise: { value: 1.0 },
    uShowHint: { value: 0.0 },
    uGoalPulse: { value: 0.0 },
    uRefCaps: { value: null },
    uRefOffsets: { value: null },
    uRefItems: { value: null },
    uRefRes: { value: 1 },
    uRefHalf: { value: 1 },
    uRefMargin: { value: 0.03 },
    uWallHalfW: { value: 0.0125 },
    uWallH: { value: 0.04 },
    uWallColor: { value: new Color() },
    uWallMetal: { value: 0 },
    uWallRough: { value: 0.5 },
    uMarbleColorRef: { value: new Color() },
    uMarbleMetalRef: { value: 0 },
    uMarbleRefRadius: { value: 0 },
    uReflect: { value: 0 },
    uRefStrength: { value: 0.75 },
    uRefReach: { value: 1.5 },
    uMirrorTest: { value: 0 },
    uWorldToLocal: { value: new Matrix4() },
  };

  // -------------------------------------------------------------------------
  // 1. Floor Material
  // -------------------------------------------------------------------------
  const floorMaterial = new PipelineMaterial({
    color: 0x422414,
    roughness: 0.28,
    metalness: 0.0,
    reflections: true,
    uniforms: shared,
    vertexPars: /* glsl */ `
      in float floorWallDist;
      in float floorWallFar;
    `,
    varyings: {
      vWallDist: "float",
      vWallFar: "float",
    },
    vertex: /* glsl */ `
      vec3 displace(vec3 p, inout vec3 n) {
        #ifdef PIPELINE_SHADOW
        return p - n * 0.002;
        #else
        return p;
        #endif
      }
    `,
    vertexMain: /* glsl */ `
      vWallDist = floorWallDist;
      vWallFar = floorWallFar;
    `,
    fragmentPars: /* glsl */ `
      uniform int uFinishId;
      uniform vec3 uFloorSecondary;
      uniform vec3 uRimColor;
      uniform float uRimMetal;
      uniform float uRimRough;
      uniform vec3 uMarbleLocalPos;
      uniform float uMarbleRadius;
      uniform vec3 uGoalLocalPos;
      uniform vec3 uStartLocalPos;
      uniform float uPocketRadius;
      uniform float uWallRaise;
      uniform float uGoalPulse;
      ${MATERIAL_COMMON_GLSL}
      ${REFLECTION_GLSL}
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        #ifndef PIPELINE_COLOR
        return;
        #endif
        vec3 p = vObjectPosition;
        vec3 nObj = normalize(vObjectNormal);
        refFloorNormal = nObj;
        vec3 refBaseNormal = s.normal;
        refFootprint = length(fwidth(vWorldPosition));
        float wallUp = clamp(uWallRaise, 0.0, 1.0);
        float cove = (1.0 - smoothstep(0.0, 0.44, vWallDist)) * wallUp;
        float wideCove = (1.0 - smoothstep(0.0, 0.76, vWallDist)) * wallUp;
        float trackWear = mix(0.55, smoothstep(0.28, 0.88, vWallDist), wallUp);
        float height = 0.0;

        if (uFinishId == 0 || uFinishId == 1) {
          // Longitudinal plank grain axis: sweeping American Black Walnut (0) or fine silky European Boxwood (1)
          vec3 col;
          float rDelta;
          float ringFreq = uFinishId == 0 ? 22.0 : 46.0;
          float ringContrast = uFinishId == 0 ? 0.85 : 0.42;
          float poreAmt = uFinishId == 0 ? 1.10 : 0.10;
          evalHardwood(p, nObj, normalize(vec3(0.92, 0.14, 0.36)), s.albedo, uFloorSecondary, ringFreq, ringContrast, poreAmt, col, rDelta, height);
          s.albedo = col * mix(1.0, 0.72, cove * 0.78);
          s.specular = 1.14;
          s.roughness = clamp(s.roughness + rDelta - trackWear * 0.07 + cove * 0.06, 0.11, 0.88);
          s.sheenColor = s.albedo * 0.04;
          s.sheenRoughness = 0.54;
        } else if (uFinishId == 2) {
          // Grand-Feu Piano-Black Vitreous Enamel: ink-deep black glass with ultra-smooth kiln surface tension wave
          vec3 pRef = refractedObjPos(p, nObj, 0.63, 0.018);
          vec4 nKiln = sampleVol(p * 0.32);
          vec4 nSub = sampleVol(pRef * 1.1);
          s.specular = 1.08;
          s.albedo = mix(s.albedo, uFloorSecondary, nSub.g * 0.24 + cove * 0.18);
          s.roughness = clamp(s.roughness + (nKiln.g - 0.5) * 0.010 - trackWear * 0.006 + cove * 0.018, 0.03, 0.16);
          height = (nKiln.r - 0.5) * 0.00014;
        } else if (uFinishId == 3) {
          // Vein-Cut Honed Roman Travertine
          vec3 col;
          float rDelta, pitOcc;
          evalTravertine(p, s.albedo, uFloorSecondary, col, rDelta, pitOcc, height);
          s.albedo = col * mix(1.0, 0.82, cove);
          s.roughness = clamp(s.roughness + rDelta - trackWear * 0.08, 0.15, 0.95);
          s.sheenColor = vec3(0.03, 0.028, 0.024) * clamp(rDelta * 1.8, 0.0, 1.0);
          s.sheenRoughness = 0.82;
          s.occlusion *= pitOcc;
        } else if (uFinishId == 4) {
          // Ancient Patinated Statuary Bronze: patchy broken malachite pockets (never a uniform parallel stripe!), dark cuprite & cast grain!
          vec4 nPat = sampleVol(p * 0.95);
          vec4 nMed = sampleVol(p * 2.6 + vec3(nPat.r - 0.5, nPat.g - 0.5, (nPat.r - nPat.g) * 0.5) * 0.36);
          vec4 nFine = sampleVol(p * 6.4);
          // Break up cove patina strongly with multi-scale blotches so some wall stretches stay bare dark bronze while corners bloom!
          float blotch = smoothstep(0.28, 0.78, nPat.g * 0.55 + nMed.r * 0.45);
          float edgeRagged = (nMed.g - 0.48) * 0.48 + (nFine.g - 0.5) * 0.22;
          float patina = clamp((wideCove * (0.25 + 1.35 * blotch) + edgeRagged * wideCove) + (1.0 - trackWear) * 0.28 * blotch, 0.0, 1.3);
          float darkPatina = smoothstep(0.04, 0.42, patina + 0.24 - trackWear * 0.18);
          float crust = smoothstep(0.48, 0.76, patina);
          float softCrust = smoothstep(0.28, 0.88, patina);
          float azurite = smoothstep(0.78, 0.94, nMed.b) * crust;

          vec3 rubbedBronze = s.albedo * 1.55 * mix(0.84, 1.16, nFine.g);
          vec3 darkStatuary = vec3(0.036, 0.025, 0.015) * mix(0.70, 1.38, nMed.g * 0.6 + nFine.g * 0.4);
          vec3 metalLayer = mix(rubbedBronze, darkStatuary, darkPatina * (1.0 - trackWear * 0.52));

          vec3 malachite = mix(uFloorSecondary * 0.55, uFloorSecondary * 1.32, nMed.g * 0.55 + nFine.g * 0.45);
          malachite = mix(malachite, vec3(0.28, 0.52, 0.42), smoothstep(0.65, 0.92, nFine.r) * 0.45);
          malachite = mix(malachite, vec3(0.025, 0.070, 0.21), azurite * 0.65);

          s.albedo = mix(metalLayer, malachite, crust);
          s.metalness = mix(mix(0.95, 0.62, darkPatina), 0.0, crust);
          s.roughness = clamp(mix(0.20 + darkPatina * 0.22 + (nFine.g - 0.5) * 0.12 - trackWear * 0.06, 0.88, crust), 0.12, 0.95);
          s.sheenColor = malachite * (0.16 * crust);
          s.sheenRoughness = 0.86;
          height = softCrust * 0.00038 + (nFine.g - 0.5) * 0.00014 + (nMed.g - 0.5) * 0.00010;
        } else if (uFinishId == 5) {
          // Song-Dynasty Qingbai ("Shadow-Blue") Glazed Porcelain: broad luminous celadon glaze pooling + multi-scale tea-stained crazing!
          vec3 pSub = refractedObjPos(p, nObj, 0.65, 0.024 * (0.45 + 0.95 * wideCove));
          vec4 nGlaze = sampleVol(pSub * 0.85);
          vec4 nCraze2 = sampleVol(pSub * 1.85 + vec3(0.31, 0.17, 0.53));
          vec4 nSurf = sampleVol(p * 1.45);
          float pool = clamp(pow(wideCove, 1.05) * 0.95 + (nGlaze.r - 0.32) * 0.24, 0.0, 1.0);
          float craze = max(smoothstep(0.70, 0.93, nGlaze.a), smoothstep(0.78, 0.96, nCraze2.a) * 0.65) * (1.0 - uLowDetail * 0.6);

          vec3 bodyCol = mix(s.albedo, uFloorSecondary, pool * 0.90);
          bodyCol = mix(bodyCol, vec3(0.38, 0.33, 0.26), craze * (0.28 + 0.36 * pool));
          s.albedo = bodyCol;
          s.specular = 1.38;
          s.transmission = vec3(0.10, 0.15, 0.14) * (1.0 - pool * 0.45);
          s.roughness = clamp(s.roughness + craze * 0.05 + (nSurf.g - 0.5) * 0.010, 0.032, 0.30);
          height = (nSurf.r - 0.5) * 0.00009;
        } else if (uFinishId == 6) {
          // Acid-Etched Pattern-Welded Damascus Steel
          vec3 col;
          float met, rgh;
          evalDamascus(p, s.albedo, uFloorSecondary, col, met, rgh, height);
          s.albedo = col * mix(1.0, 0.76, cove);
          s.metalness = met;
          s.roughness = clamp(rgh - trackWear * 0.03, 0.09, 0.62);
        } else if (uFinishId == 7) {
          // Carved Spinach-Celadon Nephrite Jade: stretched fibrous tremolite clouds, moss pockets, pinpoint chromite & waxy polish!
          vec3 pSub1 = refractedObjPos(p, nObj, 0.62, 0.022);
          vec3 pSub2 = refractedObjPos(p, nObj, 0.62, 0.052);
          vec4 nJade1 = sampleVol(pSub1 * 0.90);
          vec3 jWarp = vec3(nJade1.r - 0.5, nJade1.g - 0.5, (nJade1.r - nJade1.g) * 0.5) * 0.28;
          vec4 nJade2 = sampleVol(vec3(pSub2.x * 3.8, pSub2.y * 1.4, pSub2.z * 3.8) + jWarp);
          vec4 nPin = sampleVol(p * 8.6 + jWarp * 0.4);
          float cloud = smoothstep(0.16, 0.84, nJade1.g * 0.56 + nJade2.g * 0.44);
          float mossPocket = smoothstep(0.56, 0.88, 1.0 - nJade1.r) * (1.0 - cloud * 0.55);
          float fibreVein = smoothstep(0.72, 0.94, nJade2.g) * smoothstep(0.45, 0.80, nJade1.g);
          float chromite = smoothstep(0.92, 0.985, nPin.b) * smoothstep(0.45, 0.80, 1.0 - nJade1.r);

          vec3 jadeBody = mix(uFloorSecondary, s.albedo * 1.28, cloud);
          jadeBody = mix(jadeBody, uFloorSecondary * 0.52, mossPocket * 0.68);
          jadeBody = mix(jadeBody, vec3(0.58, 0.74, 0.60), fibreVein * 0.42);
          s.albedo = jadeBody * (1.0 - chromite * 0.85) * mix(1.0, 0.80, cove);
          s.specular = 1.48;
          s.roughness = clamp(s.roughness + (0.5 - cloud) * 0.04 - trackWear * 0.025, 0.09, 0.34);
          s.transmission = vec3(0.24, 0.44, 0.22) * (1.0 - cove * 0.45);
          s.sheenColor = vec3(0.035, 0.075, 0.04);
          s.sheenRoughness = 0.64;
          height = (nJade2.r - 0.5) * 0.00014;
        } else if (uFinishId == 8) {
          // Sun-Baked Impruneta Terracotta Clay: low-F0 porous earthenware, kiln-flame blushing, hand-molded wave & sandy chamotte!
          vec4 nMacro = sampleVol(p * 0.72);
          vec4 nMid = sampleVol(p * 2.15 + vec3(nMacro.r - 0.5, nMacro.g - 0.5, 0.0) * 0.25);
          vec4 nSand = sampleVol(p * 5.8 + vec3(nMid.r - 0.5, nMid.g - 0.5, 0.0) * 0.18);
          vec4 nMicro = sampleVol(p * 11.5);
          float kilnBlush = clamp(0.25 + 0.75 * (nMacro.g * 0.62 + nMid.g * 0.38), 0.0, 1.0);
          float sandGrain = (nSand.g - 0.5) * 0.60 + (nMicro.g - 0.5) * 0.40;
          float warmChamotte = smoothstep(0.72, 0.93, nSand.g * 0.55 + nMid.r * 0.55);
          float darkIron = smoothstep(0.83, 0.96, nMicro.b * (0.5 + 0.7 * (1.0 - nSand.r)));
          float limeBloom = smoothstep(0.28, 0.84, cove * (0.52 + 0.82 * nMacro.g));

          vec3 clayCol = mix(uFloorSecondary, s.albedo * 1.14, clamp(kilnBlush + sandGrain * 0.36, 0.0, 1.0));
          clayCol = mix(clayCol, s.albedo * 1.28, warmChamotte * 0.25);
          clayCol = mix(clayCol, vec3(0.11, 0.035, 0.02), darkIron * 0.50);
          clayCol = mix(clayCol, vec3(0.56, 0.46, 0.38), limeBloom * 0.32);
          s.albedo = clayCol * mix(1.0, 0.76, cove);
          s.specular = 0.46; // Open-pored earthenware traps grazing Fresnel reflections!
          s.roughness = clamp(s.roughness + sandGrain * 0.16 + (0.5 - kilnBlush) * 0.08 - trackWear * 0.16, 0.48, 0.98);
          s.sheenColor = vec3(0.065, 0.042, 0.030);
          s.sheenRoughness = 0.88;
          height = (nMid.g - 0.5) * 0.00038 + sandGrain * 0.00034;
        } else if (uFinishId == 9) {
          // Cabochon-Lapped Badakhshan Lapis Lazuli: pure FBM domain warps (zero Worley rings!), marble clouds & clustered pyrite seams!
          vec3 pSub = refractedObjPos(p, nObj, 0.66, 0.015);
          vec4 nLap = sampleVol(pSub * 0.88);
          vec3 lWarp = vec3(nLap.r - 0.5, nLap.g - 0.5, (nLap.r - nLap.g) * 0.5) * 0.32;
          vec4 nCloud = sampleVol(pSub * 2.2 + lWarp);
          vec4 nPy = sampleVol(p * 8.2 + lWarp * 0.5);

          float lazurite = smoothstep(0.16, 0.84, nLap.g * 0.62 + nCloud.g * 0.38);
          float violetZone = smoothstep(0.65, 0.92, nLap.r) * lazurite;
          float calcite = smoothstep(0.66, 0.88, 1.0 - nLap.g) * smoothstep(0.42, 0.78, nCloud.r);
          float pySeam = smoothstep(0.46, 0.80, nCloud.g * 0.6 + nLap.r * 0.4);
          float pyrite = smoothstep(0.84, 0.95, nPy.b) * pySeam * (1.0 - uLowDetail * 0.4);

          vec3 baseBlue = mix(s.albedo * 0.72, uFloorSecondary, lazurite);
          baseBlue = mix(baseBlue, vec3(0.05, 0.03, 0.22), violetZone * 0.48);
          baseBlue = mix(baseBlue, vec3(0.80, 0.82, 0.86), calcite * 0.68);
          s.albedo = mix(baseBlue * mix(1.0, 0.74, cove), vec3(0.96, 0.82, 0.44), pyrite);
          s.metalness = pyrite * 0.98;
          s.specular = 1.28;
          s.roughness = clamp(mix(s.roughness + calcite * 0.14 - trackWear * 0.02, 0.07, pyrite), 0.045, 0.48);
          height = (nLap.r - 0.5) * 0.00008;
        } else if (uFinishId == 10) {
          // Autoclave-Cured Clearcoated 3K 2x2 Twill Carbon Fiber: deep raven-black resin + holographic graphite flip-flop!
          vec3 pSub = refractedObjPos(p, nObj, 0.66, 0.012);
          vec3 vObj = worldDirToObject(normalize(cameraPosition - vWorldPosition));
          vec3 lObj = worldDirToObject(normalize(lightDirection));
          vec3 wTri = pow(abs(nObj), vec3(5.0));
          wTri /= max(wTri.x + wTri.y + wTri.z, 1e-5);

          float hY = 0.0, hX = 0.0, hZ = 0.0;
          vec3 fwSub = fwidth(pSub);
          vec3 cY = wTri.y > 0.01 ? evalCarbonTwillPlane(pSub.xz, fwSub.xz, vec3(1,0,0), vec3(0,0,1), nObj, vObj, lObj, s.albedo, uFloorSecondary, hY) : vec3(0.0);
          vec3 cX = wTri.x > 0.01 ? evalCarbonTwillPlane(pSub.yz, fwSub.yz, vec3(0,1,0), vec3(0,0,1), nObj, vObj, lObj, s.albedo, uFloorSecondary, hX) : vec3(0.0);
          vec3 cZ = wTri.z > 0.01 ? evalCarbonTwillPlane(pSub.xy, fwSub.xy, vec3(1,0,0), vec3(0,1,0), nObj, vObj, lObj, s.albedo, uFloorSecondary, hZ) : vec3(0.0);

          vec3 weaveCol = cX * wTri.x + cY * wTri.y + cZ * wTri.z;
          float towH = hX * wTri.x + hY * wTri.y + hZ * wTri.z;
          vec4 nCoat = sampleVol(p * 0.52);

          s.albedo = weaveCol * mix(1.0, 0.72, cove);
          s.metalness = 0.0;
          s.specular = 1.18;
          s.roughness = clamp(s.roughness + (nCoat.g - 0.5) * 0.010 + cove * 0.018, 0.030, 0.16);
          height = towH * 0.00004 + (nCoat.r - 0.5) * 0.00009;
        } else {
          // Charred Japanese Yakisugi Sugi Cedar: rectangular longitudinal cedar char blocks + narrow hairline shrinkage cracks!
          vec3 grainAx = normalize(vec3(0.93, 0.12, 0.34));
          vec3 upRefY = vec3(0.0, 1.0, 0.0);
          vec3 uAxY = normalize(cross(upRefY, grainAx));
          vec3 vAxY = cross(grainAx, uAxY);
          vec2 radY = vec2(dot(p, uAxY), dot(p, vAxY));
          float alongY = dot(p, grainAx);

          vec3 col;
          float rDelta;
          evalHardwood(p, nObj, grainAx, s.albedo, uFloorSecondary, 30.0, 0.80, 0.15, col, rDelta, height);

          vec4 nWarp = sampleVol(p * 0.65);
          vec2 wOff = (nWarp.rg - 0.5) * 0.16;
          // 4.5:1 rectangular cedar char scales aligned with the longitudinal wood grain, with narrow connected hairline cracks!
          vec3 charCoord = vec3(radY * 2.85 + wOff, alongY * 0.62);
          vec4 nChar = sampleVol(charCoord);
          vec4 nFine = sampleVol(vec3(radY * 11.0, alongY * 0.85));
          float crackLod = 1.0 - smoothstep(0.22, 0.74, max(fwidth(charCoord.x), fwidth(charCoord.y)) * 4.5);
          float fissure = smoothstep(0.30, 0.76, nChar.a) * crackLod;
          float woodRidge = (nFine.g - 0.5) * crackLod;

          vec3 charPlate = mix(vec3(0.008, 0.008, 0.010), vec3(0.022, 0.023, 0.026), clamp(0.45 + woodRidge * 0.9 + nChar.b * 0.25, 0.0, 1.0));
          vec3 crackCol = vec3(0.002, 0.002, 0.002);
          s.albedo = mix(charPlate, crackCol, fissure * 0.88) * mix(1.0, 0.75, cove);
          s.metalness = 0.0;
          s.specular = 0.72; // Consistent porous carbon Fresnel so highlights sweep naturally across the charred wood grain!
          s.roughness = clamp(0.42 + rDelta * 0.28 - woodRidge * 0.08 + fissure * 0.24 - trackWear * 0.05, 0.28, 0.82);
          s.sheenColor = vec3(0.028, 0.030, 0.035) * (1.0 - fissure * 0.7);
          s.sheenRoughness = 0.48;
          s.occlusion *= mix(1.0, 0.42, fissure);
          height = height * 1.4 + woodRidge * 0.00022 + nChar.b * 0.00024 * crackLod;
        }

        s.occlusion *= mix(0.46, 1.0, 1.0 - cove * 0.85);
        float inlayVis = smoothstep(0.08, 0.55, wallUp);

        // Watchmaker-turned Start & Goal bezels with radial sunburst brushing, recessed dark-patinated engraved ticks & chamfers!
        vec3 dgVec = p - uGoalLocalPos;
        float dGoal = length(dgVec);
        float dStart = length(p - uStartLocalPos);
        float aa = max(fwidth(dGoal), 0.0012);

        float well = (1.0 - smoothstep(uPocketRadius * 0.52, uPocketRadius * 0.86, dGoal)) * inlayVis;
        s.albedo *= mix(1.0, 0.34, well);
        s.occlusion *= mix(1.0, 0.42, well);

        float outerGoalRing = (1.0 - smoothstep(uPocketRadius * 1.10 - aa, uPocketRadius * 1.10 + aa, dGoal))
          * smoothstep(uPocketRadius * 0.80 - aa, uPocketRadius * 0.80 + aa, dGoal);
        float innerGoalDot = 1.0 - smoothstep(uPocketRadius * 0.27 - aa, uPocketRadius * 0.27 + aa, dGoal);
        float goalMetal = clamp(outerGoalRing + innerGoalDot * 0.95, 0.0, 1.0) * inlayVis;
        vec3 radialT = normalize(dgVec - nObj * dot(dgVec, nObj) + vec3(1e-5));
        vec3 refAx = abs(nObj.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 bU = normalize(cross(refAx, nObj));
        vec3 bV = cross(nObj, bU);
        float ang = atan(dot(radialT, bV), dot(radialT, bU));
        // The same angle with its ±π seam on the opposite side; the smaller footprint ignores the seam.
        float angFw = min(fwidth(ang), fwidth(atan(-dot(radialT, bV), -dot(radialT, bU))));
        if (goalMetal > 0.001) {
          float radialBrush = 0.5 + 0.5 * sin(ang * 64.0 + dGoal * 240.0);
          float tickWave = abs(fract(ang * (24.0 / 6.2831853)) - 0.5);
          float tickLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.08, 0.25, angFw * 4.0));
          float tickMark = (1.0 - smoothstep(0.055, 0.125, tickWave)) * outerGoalRing * tickLod;

          vec3 bezelCol = uRimColor * mix(0.90, 1.08, radialBrush);
          bezelCol = mix(bezelCol, uRimColor * 0.28, tickMark * 0.82);
          s.albedo = mix(s.albedo, bezelCol, goalMetal);
          s.metalness = mix(s.metalness, mix(uRimMetal, 0.25, tickMark * 0.75), goalMetal);
          s.roughness = mix(s.roughness, clamp(uRimRough + (0.5 - radialBrush) * 0.06 + tickMark * 0.35, 0.06, 0.85), goalMetal);
          s.emissive += uRimColor * goalMetal * (0.05 + 0.78 * uGoalPulse);
          height += (outerGoalRing * 0.00055 + innerGoalDot * 0.00045) * inlayVis;
        }

        float startRing = (1.0 - smoothstep(uPocketRadius * 0.92 - aa, uPocketRadius * 0.92 + aa, dStart))
          * smoothstep(uPocketRadius * 0.73 - aa, uPocketRadius * 0.73 + aa, dStart) * inlayVis;
        if (startRing > 0.001) {
          s.albedo = mix(s.albedo, uRimColor * 0.90, startRing * 0.92);
          s.metalness = mix(s.metalness, uRimMetal * 0.95, startRing * 0.92);
          s.roughness = mix(s.roughness, uRimRough + 0.05, startRing * 0.92);
          height += startRing * 0.00045;
        }

        applyBump(s, height, 0.34);
        specularAA(s);
        if (uMirrorTest > 0.5) {
          s.normal = refBaseNormal;
          s.albedo = vec3(0.95);
          s.metalness = 1.0;
          s.roughness = 0.02;
          s.occlusion = 1.0;
        }
        refF0 = mix(0.04 * s.specular, max(max(s.albedo.r, s.albedo.g), s.albedo.b), s.metalness);

        float dBall = length(p - uMarbleLocalPos);
        float contact = (1.0 - smoothstep(uMarbleRadius * 0.82, uMarbleRadius * 2.25, dBall)) * inlayVis;
        s.occlusion *= mix(1.0, 0.20, contact * contact);
      }
    `,
  });

  // -------------------------------------------------------------------------
  // 2. Wall Material
  // -------------------------------------------------------------------------
  const wallMaterial = new PipelineMaterial({
    color: 0xd6b07a,
    roughness: 0.30,
    metalness: 0.0,
    uniforms: shared,
    vertexPars: /* glsl */ `
      in vec3 surfNormal;
      in vec4 wallMeta;
      in vec2 wallShade;
      uniform float uWallRaise;
    `,
    vertex: /* glsl */ `
      vec3 displace(vec3 p, inout vec3 n) {
        float wave = wallMeta.y * 0.45;
        float localRaise = smoothstep(wave, wave + 0.55, uWallRaise);
        float sink = (1.0 - localRaise) * wallMeta.w;
        return p - surfNormal * sink;
      }
    `,
    varyings: {
      vWallMeta: "vec4",
      vWallShade: "vec2",
    },
    vertexMain: /* glsl */ `
      vWallMeta = wallMeta;
      vWallShade = wallShade;
    `,
    fragmentPars: /* glsl */ `
      uniform int uFinishId;
      uniform vec3 uFloorSecondary;
      uniform vec3 uCrownColor;
      uniform vec3 uRimColor;
      uniform vec3 uMarbleLocalPos;
      uniform float uMarbleRadius;
      ${MATERIAL_COMMON_GLSL}
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        #ifndef PIPELINE_COLOR
        return;
        #endif
        vec3 p = vObjectPosition;
        vec3 nObj = normalize(vObjectNormal);
        float hFrac = clamp(vWallMeta.x, 0.0, 1.0);
        float topMask = clamp(vWallMeta.z, 0.0, 1.0);
        float bevelMask = clamp(vWallShade.x, 0.0, 1.0);
        float flankMask = (1.0 - topMask) * smoothstep(0.06, 0.25, hFrac);
        float footCove = 1.0 - smoothstep(0.0, 0.22, hFrac);
        float height = 0.0;

        if (uFinishId == 0 || uFinishId == 1) {
          // Satin Boxwood/Maple (0) or East Indian Rosewood with deep black-violet mineral ink lines (1)!
          vec3 wallBase = mix(s.albedo, uCrownColor, smoothstep(0.40, 0.95, topMask));
          vec3 darkBand = wallBase * (uFinishId == 1 ? 0.14 : 0.72);
          float ringFreq = uFinishId == 1 ? 26.0 : 38.0;
          float ringContrast = uFinishId == 1 ? 0.92 : 0.52;
          float poreAmt = uFinishId == 1 ? 1.15 : 0.12;
          vec3 col;
          float rDelta;
          evalHardwood(p, nObj, normalize(vec3(0.32, 0.12, 0.94)), wallBase, darkBand, ringFreq, ringContrast, poreAmt, col, rDelta, height);

          float kerfPhase = hFrac * 24.0;
          float kerfLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.2, 0.6, fwidth(kerfPhase))) * flankMask;
          float kerf = sin(kerfPhase * 6.2831853) * kerfLod;
          height += kerf * 0.00010;

          s.albedo = col * mix(0.72, 1.0, 1.0 - footCove * 0.82) * (1.0 + bevelMask * 0.05);
          s.specular = 1.14;
          s.roughness = clamp(s.roughness + rDelta - bevelMask * 0.09 + abs(kerf) * 0.025, 0.10, 0.88);
          s.sheenColor = s.albedo * 0.035;
          s.sheenRoughness = 0.55;
        } else if (uFinishId == 2) {
          // 18th-Century French Ormolu Fire-Gilt Bronze: fine frosted-gold stippled flanks + mirror agate-burnished bevels!
          vec4 nSable = sampleVol(p * 6.8);
          vec4 nBrush = sampleVol(vec3(p.x * 3.2, p.y * 14.0, p.z * 3.2));
          float sableLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.22, 0.68, maxFwidth(p) * 40.0));
          float burnish = clamp(bevelMask * 0.95 + topMask * 0.48, 0.0, 1.0);
          float stipple = (nSable.g - 0.5) * sableLod * (1.0 - burnish);
          float brush = (nBrush.g - 0.5) * (1.0 - burnish * 0.85);

          s.albedo = mix(s.albedo, uCrownColor, burnish);
          s.albedo *= mix(1.0, 0.56, footCove * 0.85);
          s.roughness = clamp(mix(0.32 + abs(stipple) * 0.14 + brush * 0.06, 0.072, burnish) + footCove * 0.12, 0.065, 0.72);
          height = stipple * 0.00018 + brush * 0.00012;
        } else if (uFinishId == 3) {
          // Carved Vein-Cut Roman Travertine Walls
          vec3 col;
          float rDelta, pitOcc;
          evalTravertine(p * 1.06, mix(s.albedo, uCrownColor, topMask), uFloorSecondary, col, rDelta, pitOcc, height);
          s.albedo = col * (1.0 + bevelMask * 0.04);
          s.roughness = clamp(s.roughness + rDelta - bevelMask * 0.07, 0.15, 0.95);
          s.occlusion *= pitOcc;
        } else if (uFinishId == 4) {
          // Ancient Statuary Bronze Walls: patchy malachite pockets, dark olive-brown bronze flanks, and bright rubbed golden-bronze bevels!
          vec4 nPat = sampleVol(p * 0.95);
          vec4 nMed = sampleVol(p * 2.6 + vec3(nPat.r - 0.5, nPat.g - 0.5, (nPat.r - nPat.g) * 0.5) * 0.35);
          vec4 nFine = sampleVol(p * 5.8);
          float blotch = smoothstep(0.30, 0.78, nPat.g * 0.55 + nMed.r * 0.45);
          float rawPat = (footCove * 1.25 + (1.0 - hFrac) * 0.35) * (0.25 + 1.25 * blotch) - bevelMask * 0.95 - topMask * 0.65;
          float darkPatina = smoothstep(0.02, 0.45, rawPat + 0.26);
          float crust = smoothstep(0.48, 0.78, rawPat);
          float softCrust = smoothstep(0.30, 0.90, rawPat);

          vec3 brightBronze = mix(s.albedo * 1.45, uCrownColor, clamp(bevelMask * 0.92 + topMask * 0.60, 0.0, 1.0));
          vec3 darkStatuary = vec3(0.042, 0.028, 0.018) * mix(0.75, 1.35, nMed.g);
          vec3 metalCol = mix(brightBronze, darkStatuary, darkPatina * (1.0 - bevelMask * 0.85));
          vec3 malachite = uFloorSecondary * mix(0.62, 1.25, nMed.g * 0.60 + nFine.g * 0.40);

          s.albedo = mix(metalCol, malachite, crust);
          s.metalness = mix(mix(0.98, 0.60, darkPatina), 0.0, crust);
          s.roughness = clamp(mix(0.14 + darkPatina * 0.22 - bevelMask * 0.08 + (nFine.g - 0.5) * 0.08, 0.88, crust), 0.08, 0.95);
          s.sheenColor = malachite * (0.15 * crust);
          s.sheenRoughness = 0.86;
          height = softCrust * 0.00042 + (nFine.g - 0.5) * 0.00010;
        } else if (uFinishId == 5) {
          // Blue-and-White Jingdezhen Porcelain Walls: hand-brushed Mohammedan Cobalt crown feathering into wet feldspathic glaze!
          vec3 pSub = refractedObjPos(p, nObj, 0.65, 0.018);
          vec4 nBrush = sampleVol(pSub * 0.68);
          vec4 nGlaze = sampleVol(pSub * 1.65 + vec3(nBrush.r - 0.5, nBrush.g - 0.5, 0.0) * 0.25);
          vec4 nSurf = sampleVol(p * 1.6);
          float brushLoad = 0.65 + 0.70 * nBrush.g;
          float bleed = clamp((topMask * 0.95 + bevelMask * (0.32 + 0.55 * nGlaze.g) + (hFrac - 0.68) * 0.55 * nBrush.r) * brushLoad - 0.28, 0.0, 1.0);
          bleed = smoothstep(0.02, 0.74, bleed);
          float deepCobalt = smoothstep(0.65, 0.95, bleed * nGlaze.r * 1.35);
          float ironSpot = smoothstep(0.80, 0.95, nGlaze.b) * smoothstep(0.62, 0.95, bleed);
          float craze = smoothstep(0.74, 0.95, nGlaze.a) * (1.0 - uLowDetail * 0.6);

          vec3 porcelain = mix(s.albedo, uFloorSecondary, footCove * 0.78);
          vec3 cobalt = mix(uCrownColor * 1.45, uCrownColor * 0.48, deepCobalt);
          s.albedo = mix(porcelain, cobalt, bleed);
          s.albedo = mix(s.albedo, vec3(0.20, 0.09, 0.05), ironSpot * 0.82);
          s.albedo = mix(s.albedo, s.albedo * 0.72, craze * 0.24);
          s.metalness = ironSpot * 0.45;
          s.specular = 1.38;
          s.transmission = vec3(0.08, 0.12, 0.11) * (1.0 - bleed * 0.7);
          s.roughness = clamp(s.roughness + ironSpot * 0.26 + craze * 0.05 + (nSurf.g - 0.5) * 0.012, 0.032, 0.55);
          height = (nSurf.r - 0.5) * 0.00010;
        } else if (uFinishId == 6) {
          // Acid-Etched Damascus Steel Walls with Hammered 24k Koftgari Gold Bevel Inlay!
          vec3 col;
          float met, rgh;
          evalDamascus(p * 1.12, s.albedo, uFloorSecondary, col, met, rgh, height);
          float goldEdge = smoothstep(0.74, 0.98, bevelMask) * 0.88;
          s.albedo = mix(col, uRimColor, goldEdge);
          s.metalness = mix(met, 1.0, goldEdge);
          s.roughness = clamp(mix(rgh, 0.10, goldEdge), 0.07, 0.62);
        } else if (uFinishId == 7) {
          // Carved Translucent Spinach-Celadon Nephrite Jade Walls
          vec3 pSub = refractedObjPos(p, nObj, 0.62, 0.024);
          vec4 nJade = sampleVol(pSub * 1.15);
          vec4 nFine = sampleVol(p * 2.8);
          vec4 nPin = sampleVol(p * 8.6);
          float cloud = smoothstep(0.18, 0.82, nJade.g * 0.65 + nFine.g * 0.35);
          float chromite = smoothstep(0.92, 0.985, nPin.b) * smoothstep(0.45, 0.80, 1.0 - nJade.r);

          s.albedo = mix(uFloorSecondary * 1.3, uCrownColor, clamp(cloud * 0.65 + topMask * 0.32 + bevelMask * 0.22, 0.0, 1.0));
          s.albedo *= 1.0 - chromite * 0.78;
          s.specular = 1.48;
          s.roughness = clamp(s.roughness - bevelMask * 0.03 + (0.5 - cloud) * 0.04, 0.085, 0.34);
          s.transmission = vec3(0.36, 0.56, 0.28) * (0.45 + 0.55 * hFrac);
          s.sheenColor = vec3(0.04, 0.08, 0.045);
          s.sheenRoughness = 0.62;
          height = (nFine.r - 0.5) * 0.00014;
        } else if (uFinishId == 8) {
          // Saw-Cut Vesicular Volcanic Basalt Walls: fine crystalline diabase speckle & tiny pinhead micro-vesicles!
          vec4 nMacro = sampleVol(p * 1.8);
          vec4 nCrystal = sampleVol(p * 7.8);
          vec4 nPore = sampleVol(p * 9.5 + vec3(nMacro.r - 0.5, nMacro.g - 0.5, 0.0) * 0.20);
          float plagio = (nCrystal.g - 0.5);
          float vesicle = smoothstep(0.80, 0.95, nPore.b * (0.6 + 0.6 * nMacro.g));
          float softVesicle = smoothstep(0.65, 0.96, nPore.b * (0.6 + 0.6 * nMacro.g));

          vec3 stone = mix(s.albedo, uCrownColor, topMask * 0.50 + bevelMask * 0.32);
          stone *= 0.96 + 0.28 * plagio;
          s.albedo = stone * (1.0 - vesicle * 0.68);
          s.occlusion *= 1.0 - vesicle * 0.65;
          s.roughness = clamp(s.roughness + vesicle * 0.32 - plagio * 0.10 - bevelMask * 0.08, 0.28, 0.96);
          height = -softVesicle * 0.00032 + plagio * 0.00014;
        } else if (uFinishId == 9) {
          // Translucent Volterra Honey Alabaster Walls: refracted warm amber aragonite bands & candle-like subsurface glow!
          vec3 pSub = refractedObjPos(p, nObj, 0.67, 0.026);
          vec4 nAlb = sampleVol(pSub * 0.95);
          vec4 nFine = sampleVol(p * 2.4);
          vec3 bandAx = normalize(vec3(0.32, 0.88, -0.35));
          float bandCoord = dot(pSub, bandAx) * 11.5 + nAlb.r * 2.4 + nFine.g * 0.35;
          float amberBand = smoothstep(0.45, 0.88, 0.5 + 0.5 * sin(bandCoord * 6.2831853));
          float vein = smoothstep(0.76, 0.94, nAlb.a);

          vec3 body = mix(s.albedo, uCrownColor, topMask * 0.45 + (1.0 - amberBand) * 0.35);
          body = mix(body, vec3(0.68, 0.46, 0.22), amberBand * 0.38);
          s.albedo = mix(body, vec3(0.58, 0.38, 0.16), vein * 0.42);
          s.specular = 1.25;
          s.transmission = vec3(0.42, 0.32, 0.18) * (0.42 + 0.58 * hFrac);
          s.sheenColor = vec3(0.05, 0.042, 0.03);
          s.sheenRoughness = 0.66;
          s.roughness = clamp(s.roughness - bevelMask * 0.06 + vein * 0.04 + (nFine.g - 0.5) * 0.04, 0.11, 0.50);
          height = (nFine.g - 0.5) * 0.00012;
        } else if (uFinishId == 10) {
          // CNC-Machined Grade-5 Ti-6Al-4V Titanium Walls: bead-blasted flanks, fine end-mill cusps & bright diamond-chamfered bevels!
          vec4 nTi = sampleVol(p * 4.8);
          float millPhase = hFrac * 34.0;
          float millLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.2, 0.65, fwidth(millPhase))) * flankMask;
          float millCusp = sin(millPhase * 6.2831853) * millLod;
          float chamfer = smoothstep(0.45, 0.92, bevelMask);
          float blast = (nTi.g - 0.5) * (1.0 - chamfer * 0.85);

          s.albedo = mix(s.albedo, uCrownColor, clamp(chamfer * 0.90 + topMask * 0.45, 0.0, 1.0));
          s.albedo *= mix(1.0, 0.72, footCove * 0.75);
          s.roughness = clamp(mix(s.roughness + blast * 0.09 + abs(millCusp) * 0.04, 0.082, chamfer), 0.072, 0.58);
          height = blast * 0.00012 + millCusp * 0.00009;
        } else {
          // Hand-Planished Warm Rose Copper Walls: smooth FBM-warped shallow hammer facets + plum cuprite oxide in base coves!
          vec4 nWarp = sampleVol(p * 0.85);
          vec4 nCu = sampleVol(p * 1.55 + vec3(nWarp.r - 0.5, nWarp.g - 0.5, (nWarp.r - nWarp.g) * 0.5) * 0.26);
          vec4 nFine = sampleVol(p * 4.5);
          float hammerDish = nCu.b;
          float oxide = clamp(footCove * 1.05 - bevelMask * 0.75, 0.0, 1.0) * (0.65 + 0.55 * nWarp.r);
          oxide = clamp(oxide, 0.0, 1.0);

          vec3 brightCu = mix(s.albedo, uCrownColor, clamp(bevelMask * 0.82 + topMask * 0.48 + (nCu.g - 0.5) * 0.16, 0.0, 1.0));
          s.albedo = mix(brightCu, vec3(0.12, 0.038, 0.032), oxide * 0.80);
          s.metalness = mix(0.99, 0.35, oxide * 0.75);
          s.roughness = clamp(s.roughness + oxide * 0.28 - bevelMask * 0.08 + (nFine.g - 0.5) * 0.04, 0.08, 0.72);
          height = -hammerDish * 0.00022 + (nFine.g - 0.5) * 0.00007;
        }

        applyBump(s, height, 0.32);
        specularAA(s);

        s.occlusion *= mix(0.58, 1.0, smoothstep(0.0, 0.36, hFrac));

        float dBall = length(p - uMarbleLocalPos);
        float nearBall = 1.0 - smoothstep(uMarbleRadius * 0.92, uMarbleRadius * 2.15, dBall);
        s.occlusion *= mix(1.0, 0.50, nearBall);
      }
    `,
  });

  // -------------------------------------------------------------------------
  // 3. Marble Material (9 distinct lapidary, ceramic & precision-metal spheres rotating with spinQuat!)
  // -------------------------------------------------------------------------
  const marbleMaterial = new PipelineMaterial({
    color: 0xd6dade,
    roughness: 0.034,
    metalness: 1.0,
    uniforms: shared,
    fragmentPars: /* glsl */ `
      uniform int uMarbleStyle;
      uniform int uFinishId;
      uniform vec3 uMarbleAccent;
      ${MATERIAL_COMMON_GLSL}
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        #ifndef PIPELINE_COLOR
        return;
        #endif
        vec3 uDir = normalize(vObjectPosition);
        vec3 viewVec = normalize(cameraPosition - vWorldPosition);
        vec3 wNrm = normalize(vWorldNormal);
        float ndotv = clamp(dot(wNrm, viewVec), 0.0, 1.0);

        vec4 n1 = sampleVol(uDir * 0.45 + 0.5);
        vec4 n2 = sampleVol(uDir * 1.25 + vec3(n1.r - 0.5, n1.g - 0.5, (n1.r - n1.g) * 0.5) * 0.22);

        if (uMarbleStyle == 0) {
          // 52100 Chrome Steel / Sterling Silver / Tungsten Carbide: mirror lapped with faint rolling micro-patina
          float scratch = smoothstep(0.80, 0.97, n2.a) * (1.0 - uLowDetail * 0.6);
          s.albedo = mix(s.albedo, uMarbleAccent, scratch * 0.24 + n1.g * 0.08);
          s.roughness = clamp(s.roughness + scratch * 0.055 + (n2.g - 0.5) * 0.015, 0.025, 0.28);
        } else if (uMarbleStyle == 1) {
          // 290 C Heat-Blued Watchmaker Steel: thin-film oxide interference shifting royal blue -> violet -> pale steel rim!
          float fres = pow(1.0 - ndotv, 1.65);
          float rimCyan = pow(1.0 - ndotv, 4.2);
          vec3 tempered = mix(s.albedo, uMarbleAccent, clamp(fres * 0.85 + (n1.r - 0.5) * 0.14, 0.0, 1.0));
          s.albedo = mix(tempered, vec3(0.55, 0.72, 0.88), rimCyan * 0.45);
          s.roughness = clamp(s.roughness + (n2.g - 0.5) * 0.020, 0.032, 0.24);
        } else if (uMarbleStyle == 2) {
          // Refracted Carnelian / Sardonyx Fortification Eye Agate
          vec3 uRef = refractedObjPos(uDir, uDir, 0.65, 0.22);
          vec4 nSub = sampleVol(uRef * 0.48 + 0.5);
          vec3 warpOff = vec3(nSub.r - 0.5, nSub.g - 0.5, (nSub.r - nSub.g) * 0.5) * 0.26;
          float eyeDist = length(normalize(uRef) - vec3(0.38, 0.52, -0.26) + warpOff);
          float wave = 0.5 + 0.5 * sin(eyeDist * 14.5);
          float whiteRibbon = smoothstep(0.85, 0.97, wave);
          float darkSard = smoothstep(0.66, 0.94, 1.0 - wave);

          s.albedo = mix(s.albedo, s.albedo * 0.20, darkSard * 0.84);
          s.albedo = mix(s.albedo, uMarbleAccent, whiteRibbon * 0.90);
          s.specular = 1.38;
          s.transmission = vec3(0.36, 0.055, 0.015) * (1.0 - whiteRibbon * 0.6);
          s.roughness = clamp(s.roughness + whiteRibbon * 0.016, 0.026, 0.16);
        } else if (uMarbleStyle == 3) {
          // Volcanic Mahogany-Sheen Obsidian: glassy black rhyolite with oxidized iron flow ribbons & golden schiller!
          float flowCoord = (uDir.x * 2.3 + uDir.y * 1.7 - uDir.z * 1.1 + n1.r * 1.5) * 4.6;
          float flow = smoothstep(0.48, 0.86, 0.5 + 0.5 * sin(flowCoord));
          float schiller = pow(ndotv, 3.0) * smoothstep(0.55, 0.88, n2.g) * (1.0 - flow);
          s.albedo = mix(s.albedo, uMarbleAccent, flow * 0.82);
          s.albedo += vec3(0.09, 0.065, 0.025) * schiller;
          s.specular = 1.24;
          s.roughness = clamp(s.roughness + flow * 0.018 + (n1.g - 0.5) * 0.012, 0.024, 0.16);
        } else if (uMarbleStyle == 4) {
          // Lathe-Turned Solid C260 Brass / 24k Burnished Gold Sphere
          float latPhase = uDir.y * 44.0 + n1.r * 0.7;
          float ringLod = (1.0 - uLowDetail) * (1.0 - smoothstep(0.25, 0.75, fwidth(latPhase)));
          float latRings = mix(0.5, 0.5 + 0.5 * sin(latPhase * 6.2831853), ringLod);
          s.albedo = mix(uMarbleAccent, s.albedo * 1.05, 0.48 + 0.52 * latRings);
          s.roughness = clamp(s.roughness + (0.5 - latRings) * 0.040, 0.036, 0.28);
        } else if (uMarbleStyle == 5) {
          // Badakhshan Lapis Lazuli Sphere with metallic golden pyrite crystals & white calcite wisps
          float cloud = smoothstep(0.20, 0.80, n1.g * 0.7 + n2.r * 0.3);
          float calcite = smoothstep(0.80, 0.96, n1.a) * (1.0 - cloud * 0.5);
          float pyrite = smoothstep(0.86, 0.955, n2.b);
          vec3 blueStone = mix(s.albedo * 0.72, s.albedo * 1.38, cloud);
          blueStone = mix(blueStone, vec3(0.85, 0.86, 0.88), calcite * 0.55);
          s.albedo = mix(blueStone, uMarbleAccent, pyrite);
          s.metalness = pyrite * 0.98;
          s.specular = 1.28;
          s.roughness = clamp(mix(s.roughness + calcite * 0.10 + (0.5 - cloud) * 0.03, 0.08, pyrite), 0.042, 0.28);
        } else if (uMarbleStyle == 6) {
          // Synthetic Flame-Fusion Ruby Corundum Bearing (Al2O3:Cr, IOR = 1.77 -> F0 = 0.077 -> specular = 1.92!)
          float coreGlow = pow(ndotv, 1.85);
          s.albedo = mix(s.albedo * 0.32, uMarbleAccent, coreGlow * 0.82 + n1.g * 0.14);
          s.specular = 1.92;
          s.transmission = vec3(0.52, 0.02, 0.06);
          s.emissive += vec3(0.06, 0.002, 0.008) * coreGlow;
          s.roughness = clamp(s.roughness + (n1.r - 0.5) * 0.008, 0.022, 0.10);
        } else if (uMarbleStyle == 7) {
          // Hetian Mutton-Fat White Nephrite Jade Sphere: refracted internal cloud flocculence & greasy-waxy polish!
          vec3 uRef = refractedObjPos(uDir, uDir, 0.62, 0.26);
          vec4 nSub = sampleVol(uRef * 0.85 + 0.5);
          float cloud = smoothstep(0.22, 0.80, nSub.g * 0.68 + n2.g * 0.32);
          s.albedo = mix(uMarbleAccent, s.albedo * 1.04, cloud);
          s.specular = 1.48;
          s.transmission = vec3(0.42, 0.39, 0.30);
          s.sheenColor = vec3(0.06, 0.06, 0.05);
          s.sheenRoughness = 0.62;
          s.roughness = clamp(s.roughness + (0.5 - cloud) * 0.025, 0.075, 0.24);
        } else {
          // White Raku / Hagi Crackle-Glazed Ceramic Marble: refracted smoke-stained Kannyu crackle network!
          vec3 uRef = refractedObjPos(uDir, uDir, 0.65, 0.16);
          vec4 nCrack = sampleVol(uRef * 0.72 + 0.5);
          float crackle = smoothstep(0.76, 0.95, nCrack.a);
          float ironSpeck = smoothstep(0.92, 0.985, n2.b);
          vec3 glaze = mix(s.albedo * 0.96, s.albedo * 1.03, n1.g);
          glaze = mix(glaze, uMarbleAccent, crackle * 0.62);
          glaze = mix(glaze, vec3(0.22, 0.14, 0.09), ironSpeck * 0.75);
          s.albedo = glaze;
          s.specular = 1.38;
          s.transmission = vec3(0.14, 0.12, 0.09) * (1.0 - crackle * 0.5);
          s.roughness = clamp(s.roughness + crackle * 0.06 + (n1.r - 0.5) * 0.015, 0.032, 0.22);
        }

        specularAA(s);
      }
    `,
  });

  // -------------------------------------------------------------------------
  // 4. Ariadne Golden Inlay Ribbon Material (~600 triangles, 0 cost when hidden!)
  // -------------------------------------------------------------------------
  const hintMaterial = new PipelineMaterial({
    color: 0xf3d57e,
    roughness: 0.16,
    metalness: 1.0,
    uniforms: shared,
    vertexPars: /* glsl */ `
      in vec3 surfNormal;
      uniform float uWallRaise;
      uniform float uShowHint;
    `,
    vertex: /* glsl */ `
      vec3 displace(vec3 p, inout vec3 n) {
        float vis = clamp(uShowHint, 0.0, 1.0) * smoothstep(0.08, 0.55, uWallRaise);
        return p - surfNormal * ((1.0 - vis) * 0.008);
      }
    `,
    fragmentPars: /* glsl */ `
      uniform vec3 uRimColor;
      uniform float uRimMetal;
      uniform float uRimRough;
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        #ifndef PIPELINE_COLOR
        return;
        #endif
        s.albedo = uRimColor * 1.06;
        s.metalness = uRimMetal;
        s.roughness = uRimRough;
        s.emissive = uRimColor * 0.12;
      }
    `,
  });

  return { shared, floorMaterial, wallMaterial, marbleMaterial, hintMaterial };
}

// Draws only where the piece hides the marble (depth test inverted), as a soft glowing rim, so it can be followed
// through strands and walls. Use on a sphere slightly larger than the marble so its visible surface never passes.
export function createMarbleSeeThroughMaterial() {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(1.0, 0.93, 0.8) },
      uOpacity: { value: 0.65 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal;
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 1.6);
        gl_FragColor = vec4(uColor * (0.5 + 0.9 * rim), uOpacity * (0.3 + 0.7 * rim));
      }
    `,
    transparent: true,
    depthWrite: false,
    depthFunc: GreaterDepth,
  });
}

function floatTexture(data, texels, channels) {
  const width = 1024;
  const height = Math.max(1, Math.ceil(texels / width));
  const padded = new Float32Array(width * height * channels);
  padded.set(data.subarray(0, Math.min(data.length, padded.length)));
  const tex = new DataTexture(padded, width, height, channels === 4 ? RGBAFormat : RedFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Uploads a labyrinth's walls for the floor's reflection rays (replacing the previous labyrinth's).
export function setReflectionData(shared, labyrinth) {
  for (const key of ["uRefCaps", "uRefOffsets", "uRefItems"]) shared[key].value?.dispose();
  const caps = labyrinth.capsuleData;
  const count = caps.length / 12;
  const texels = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const c = i * 12;
    const o = i * 12;
    texels.set([caps[c], caps[c + 1], caps[c + 2], 0, caps[c + 6], caps[c + 7], caps[c + 8], 0], o);
    const nx = caps[c + 3] + caps[c + 9];
    const ny = caps[c + 4] + caps[c + 10];
    const nz = caps[c + 5] + caps[c + 11];
    const len = Math.hypot(nx, ny, nz) || 1;
    texels.set([nx / len, ny / len, nz / len, 0], o + 8);
  }
  const grid = labyrinth.renderGrid;
  shared.uRefCaps.value = floatTexture(texels, count * 3, 4);
  shared.uRefOffsets.value = floatTexture(Float32Array.from(grid.offsets), grid.offsets.length, 1);
  shared.uRefItems.value = floatTexture(Float32Array.from(grid.items), Math.max(1, grid.items.length), 1);
  shared.uRefRes.value = grid.res;
  shared.uRefHalf.value = grid.half;
  shared.uRefMargin.value = Math.max(0.01, grid.pad - labyrinth.wallHalfWidth - labyrinth.wallHeight);
  shared.uWallHalfW.value = labyrinth.wallHalfWidth;
  shared.uWallH.value = labyrinth.wallHeight;
}
