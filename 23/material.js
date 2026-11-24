import { Vector3 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { shader as simplexNoise3D } from "shaders/perlinSimplex3D.js";
import { LAVA_GLSL } from "./lava.js";

function createMagmaMaterial(baker) {

  const uniforms = {
    uHeightHeatMap: { value: baker.heightHeatTexture },
    uNormalAoMap: { value: baker.normalAoTexture },
    uFlowMap: { value: baker.flowTexture },
    uNoiseMap: { value: baker.noiseTexture },
    uStyle: { value: 0 },
    uRelief: { value: 0.68 },
    // Scales the mesh's displacement for one shape (Suzanne keeps her features)
    uShapeRelief: { value: 1 },
    uUseDispUv: { value: 0 },
    uHeat: { value: 0.76 },
    uGloss: { value: 0.40 },
    uScale: { value: 1.15 },
    uFlowTime: { value: 0 },
    uMelt: { value: 0 },
    uNeutral: { value: 0 },
    uHeatVolume: { value: null },
    uPulseVolume: { value: null },
    uHeatBound: { value: 2 },
    uSeedOffset: { value: new Vector3(1.7, 3.1, 2.3) },
  };

  const material = new PipelineMaterial({
    color: 0x161416,
    roughness: 0.72,
    metalness: 0.04,
    uniforms,
    varyings: {
      vWorldTangent: "vec3",
      vWorldBitangent: "vec3",
      vObjTangent: "vec3",
      vObjBitangent: "vec3",
      vTileBounds: "vec4",
      vObjView: "vec3",
    },
    vertexPars: /* glsl */ `
in vec4 aTangent;
in vec4 aTileBounds;
in float aCellTexels;
// Suzanne's height uv, shared by every copy of a seam point; read only when uUseDispUv is 1
in vec2 aDispUv;
uniform sampler2D uHeightHeatMap;
uniform float uRelief;
uniform float uMelt;
uniform float uShapeRelief;
uniform float uUseDispUv;
`,
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  // Height filtered to this vertex's cell size: the mesh carries the relief it can hold, the
  // normal map and parallax the detail finer than its triangles. n stays the base normal, which
  // the normal map is relative to.
  // Never sharper than 4 texels: creases finer than that would zigzag across triangles; the normal map draws them
  float lod = log2(max(aCellTexels, 4.0));
  float h = textureLod(uHeightHeatMap, uUseDispUv > 0.5 ? aDispUv : uv, lod).r;
  float dispAmp = (0.040 + uRelief * 0.135) * (1.0 - uMelt) * uShapeRelief;
  return p + normalize(n) * ((h - 0.5) * dispAmp);
}
`,
    vertexMain: /* glsl */ `
  mat3 m3 = mat3(modelMatrix);
  vec3 objN = normalize(normal);
  vec3 objT = normalize(aTangent.xyz - objN * dot(aTangent.xyz, objN));
  vObjTangent = objT;
  vObjBitangent = cross(objN, objT) * aTangent.w;
  vec3 wt = normalize(m3 * aTangent.xyz);
  vec3 wn = normalize(vWorldNormal);
  wt = normalize(wt - wn * dot(wt, wn));
  vWorldTangent = wt;
  vWorldBitangent = cross(wn, wt) * aTangent.w;
  vTileBounds = aTileBounds;
  vObjView = transpose(m3) * (cameraPosition - vWorldPosition);
`,
    fragmentPars: /* glsl */ `
${simplexNoise3D}

uniform sampler2D uHeightHeatMap;
uniform sampler2D uNormalAoMap;
uniform sampler2D uFlowMap;
uniform sampler2D uNoiseMap;
uniform int uStyle;
uniform float uRelief;
uniform float uHeat;
uniform float uGloss;
uniform float uScale;
uniform float uFlowTime;
uniform float uMelt;
uniform float uNeutral;
uniform highp sampler3D uHeatVolume;
uniform highp sampler3D uPulseVolume;
uniform float uHeatBound;
uniform vec3 uSeedOffset;

const mat3 FBM_ROT = mat3(
   0.00,  0.80,  0.60,
  -0.80,  0.36, -0.48,
  -0.60, -0.48,  0.64
);

float fbm2(vec3 p) {
  float f = 0.5 * snoise(p);
  p = FBM_ROT * p * 2.04 + vec3(17.1, 31.7, 13.3);
  f += 0.25 * snoise(p);
  return f;
}

${LAVA_GLSL}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 N = normalize(vWorldNormal);
  vec3 T = normalize(vWorldTangent);
  vec3 B = normalize(vWorldBitangent);
  mat3 TBN = mat3(T, B, N);

  vec3 worldV = normalize(cameraPosition - vWorldPosition);
  vec3 viewTS = normalize(transpose(TBN) * worldV);
  vec3 lightTS = normalize(transpose(TBN) * normalize(lightDirection));

  // Baked maps: the mesh carries the relief, the normal map the finer detail
  vec4 hh = texture(uHeightHeatMap, vUv);
  vec4 nao = texture(uNormalAoMap, vUv);

  float height = hh.r;
  float baseHeat = hh.g;
  float crustMask = hh.b;
  float plateId = hh.a;

  vec3 normalTS = normalize(nao.rgb * 2.0 - 1.0);
  float bakedAo = nao.a;

  // Apply crisp tangent-space normal map
  s.normal = normalize(TBN * normalTS);


  vec3 p = vObjectPosition;
  float moltenMask = 1.0 - crustMask;

  // Dual-phase grayscale noise advected in 3D object space along the baked flow map (zero cube-face seams!)
  vec4 flowSample = texture(uFlowMap, vUv);
  vec2 flowTS = (flowSample.rg * 2.0 - 1.0) * (0.60 + 0.90 * flowSample.b);
  vec3 flowObj = normalize(vObjTangent) * flowTS.x + normalize(vObjBitangent) * flowTS.y;
  vec3 objN = normalize(cross(vObjTangent, vObjBitangent));
  float smoothPhase = flowSample.a;
  // Neutral: the look's pattern without its flow map, as the molten morph shows it. Cross-faded rather than
  // blending the inputs, which would slide and zoom the pattern
  vec2 lavaFlow = vec2(0.0);
#ifdef PIPELINE_PREPASS
  // The prepass only needs the flow for the melt front (its normals skip the molten ripple)
  bool needFlow = uMelt > 0.0;
#else
  bool needFlow = true;
#endif
  if (needFlow && uNeutral < 0.999) lavaFlow = sampleFlowingNoise(uNoiseMap, p, flowObj, objN, uFlowTime, smoothPhase, uScale, uSeedOffset);
  if (needFlow && uNeutral > 0.001) {
    vec3 nO = normalize(vObjectNormal);
    vec2 neutral = sampleFlowingNoise(uNoiseMap, p, neutralFlow(nO), nO, uFlowTime, 0.5, uScale, uSeedOffset);
    lavaFlow = uNeutral >= 0.999 ? neutral : mix(lavaFlow, neutral, uNeutral);
  }
  float hueWave = lavaFlow.x;

  // Melt transition: low ground liquefies first and peaks last; cooling runs it backwards
  float meltKey = height * 0.7 + lavaFlow.y * 0.3;
  float meltLocal = smoothstep(meltKey, meltKey + 0.3, uMelt * 1.3);
  moltenMask = max(moltenMask, meltLocal);
  s.normal = normalize(mix(s.normal, N, max(meltLocal * 0.85, uNeutral)));

  // Subtle flowing liquid-surface ripple perturbation on molten pools so specular highlights slide with the swirl
#ifndef PIPELINE_PREPASS
  if (moltenMask > 0.08) {
    float ripple = (lavaFlow.y - 0.5) * 0.22 * moltenMask * (1.0 - uNeutral);
    s.normal = normalize(s.normal + (T * flowTS.y - B * flowTS.x) * ripple);
  }
#endif

  vec3 crustBase = vec3(0.011, 0.013, 0.018);              // Cracked Plates: cool blue-black basalt
  if (uStyle == 1)      crustBase = vec3(0.008, 0.008, 0.009); // Pillow Lava: wet black
  else if (uStyle == 2) crustBase = vec3(0.012, 0.012, 0.013); // Pahoehoe Coils: charred graphite black
  else if (uStyle == 3) crustBase = vec3(0.008, 0.006, 0.005); // Obsidian: smoky brown-black glass
  else if (uStyle == 4) crustBase = vec3(0.021, 0.015, 0.012); // Flow Bands: warm iron-stained basalt
  else if (uStyle == 5) crustBase = vec3(0.012, 0.008, 0.010); // Shard Scales: dark plum glass
  else if (uStyle == 6) crustBase = vec3(0.019, 0.022, 0.034); // Strata Plates: blue-grey basalt
  else if (uStyle == 7) crustBase = vec3(0.030, 0.029, 0.028); // Charred Grain: charcoal grey
  else if (uStyle == 8) crustBase = vec3(0.022, 0.026, 0.036); // Ropy Strands: blue-black

  // Ash settled on exposed crests
  float crestMask = smoothstep(0.55, 0.92, height) * crustMask * (1.0 - uGloss * 0.6);
  vec3 crustColor = crustBase * (0.72 + 0.56 * plateId) + vec3(0.018, 0.017, 0.017) * crestMask;

  // Scorched carbonized rim right along glowing magma fissures
  crustColor *= mix(1.0, 0.75, smoothstep(0.16, 0.62, baseHeat) * crustMask);

  float baseRough = mix(0.86, 0.08, uGloss);
  float crustRough = clamp(baseRough + (1.0 - bakedAo) * 0.18 - crestMask * 0.12, 0.05, 0.95);
  if (uStyle == 3) {
    crustRough = mix(0.82, 0.06, plateId);
  }
  // Charred Grain: satin ridges, matte grooves
  if (uStyle == 7) crustRough = clamp(crustRough + mix(0.25, -0.12, plateId), 0.05, 0.95);
  // Cooling skin drifting on the lava: dark, rougher patches carried by the flow
  float skin = skinOf(hueWave) * moltenMask;
  s.roughness = mix(crustRough, mix(0.55, 0.8, skin), moltenMask);
  s.metalness = 0.0;
  s.specular = mix(mix(0.5, 1.2, uGloss), 0.35, moltenMask);
  s.albedo = mix(crustColor, vec3(0.012, 0.004, 0.002), moltenMask);
  if (uStyle == 0 || uStyle == 1) {
    // Cracked Plates / Pillow Lava: matte molten surface so the studio sheen doesn't wash the lava pink
    s.specular = mix(s.specular, 0.1, moltenMask);
  }
  if (uStyle == 8) {
    // Ropy Strands: fibre tops catch a little sheen, the grooves between them stay matte
    s.roughness = mix(s.roughness, clamp(0.95 - plateId * 0.4, 0.45, 0.95), crustMask);
  }
  if (uStyle == 9) {
    // Marbled Glass: dark glass under one perfectly smooth clear coat
    s.normal = N;
    s.roughness = 0.03;
    s.specular = 0.7;
    s.albedo = vec3(0.005, 0.0015, 0.001);
  }

  s.occlusion = mix(bakedAo, 1.0, meltLocal);

  // Fiery blackbody incandescence driven by flow-mapped grayscale noise -> vivid hue shifts
  // across the full ruby-crimson -> scarlet-orange -> golden-yellow thermal spectrum!
  float wallSlope = 1.0 - clamp(normalTS.z, 0.0, 1.0);
  float liquidMod = mix(0.28, 1.38, hueWave);
  float temp = baseHeat * mix(0.58, liquidMod, moltenMask) * (1.0 - skin * 0.55);
  temp = mix(temp, moltenTemp(hueWave), meltLocal);
  // Lava cools against the crust but still glows: at the rim it stays a dull crimson instead of going black
  temp = max(temp, smoothstep(0.0, 0.5, moltenMask) * 0.45 * (1.0 - skin * 0.5));
  // Hierarchy: some fissures run hot and others are dimmer, by a broad static pattern over the rock
  float hier = sampleNoiseTriplanar(uNoiseMap, p * 0.16 + uSeedOffset * 0.05, normalize(vObjectNormal)).r;
  float settled = moltenMask * (1.0 - skin) * (1.0 - meltLocal) * (1.0 - uNeutral);
  temp *= mix(1.0, mix(0.6, 1.45, smoothstep(0.3, 0.7, hier)), settled);
  // Across a crack: a thin hot core in the middle burns yellow-orange, its edges stay a deeper red
  temp *= mix(1.0, mix(0.62, 1.0, smoothstep(0.35, 0.8, baseHeat)), settled);
  temp += smoothstep(0.7, 1.05, baseHeat) * (0.45 + 0.5 * hueWave) * settled;
  // The thread down the middle (heat baked above 1.2) runs white-yellow
  temp += smoothstep(1.2, 1.5, baseHeat) * (0.55 + 0.35 * hueWave) * settled;
  temp *= mix(mix(0.32, 1.24, uHeat), 1.0, uNeutral);

  if (uStyle == 8) {
    // Ropy Strands: the thin lava threads stay hot down their middle, whatever the flowing skin does
    temp = max(temp, baseHeat * moltenMask * mix(0.65, 0.85, hueWave) * mix(mix(0.32, 1.24, uHeat), 1.0, uNeutral) * (1.0 - meltLocal));
  }
  if (uStyle == 9) {
    // Marbled Glass: no cooling skin or flow pulse; a second, deeper layer seen through the glass at a
    // view-dependent offset, softer, so the fire has depth
    vec2 deep = vUv - viewTS.xy / max(viewTS.z, 0.35) * 0.006;
    float under = textureLod(uHeightHeatMap, deep, 2.5).g;
    temp = mix(max(baseHeat, under * 0.75), baseHeat, 0.6) * mix(0.85, 1.15, hueWave) * mix(mix(0.32, 1.24, uHeat), 1.0, uNeutral);
  }
  vec3 incandescence = blackbody(temp);
  float rimBounce = smoothstep(0.10, 0.65, baseHeat) * (0.25 + 0.75 * wallSlope) * crustMask;
  vec3 bounceGlow = vec3(1.2, 0.2, 0.01) * rimBounce * uHeat * 0.5 * (1.0 - meltLocal);

  // Lava light spilling onto the rock around it (stylised): the heat of the air here, from the seamless 3D
  // heat volume (mip-blurred atlas heat bled across cube faces), strongest on crack walls and in crevices
  vec3 heatQ = clamp(p / (2.0 * uHeatBound) + 0.5, 0.0, 1.0);
  float airHeat = texture(uHeatVolume, heatQ).r * texture(uPulseVolume, heatQ).r;
  float facing = 0.35 + 0.65 * max(wallSlope, 1.0 - height);
  float spill = airHeat * airHeat * 1.6 * crustMask * facing * (1.0 - meltLocal);
  bounceGlow += vec3(1.0, 0.16, 0.01) * spill * uHeat * 0.2;

  // Crevice walls lit by the lava below them: the heat a few texels around (a blur that stays inside each
  // face's padding), strongest on steep walls and low down, so plate tops stay dark
  float lavaNear = textureLod(uHeightHeatMap, vUv, 2.5).g;
  float wallLight = lavaNear * (0.3 + 0.7 * wallSlope) * (1.0 - 0.6 * height) * crustMask * (1.0 - meltLocal);
  bounceGlow += vec3(1.0, 0.16, 0.025) * wallLight * uHeat * 1.6;

  // Obsidian: ember flecks inside the glass
  if (uStyle == 3) {
    float f1 = pow(clamp(snoise(p * 40.0 + uSeedOffset) - 0.35, 0.0, 1.0) / 0.65, 12.0);
    float f2 = pow(clamp(snoise(p * 70.0 - uSeedOffset * 1.3) - 0.4, 0.0, 1.0) / 0.6, 14.0);
    float fleck = (f1 * 1.4 + f2 * 2.2) * plateId * (1.0 - meltLocal);
    bounceGlow += vec3(3.4, 0.95, 0.08) * fleck * uHeat * 1.8;
  }

  s.emissive = incandescence + bounceGlow;
}
`,
  });

  material.defaultAttributeValues.aDispUv = [0, 0];

  return { material, uniforms };
}

export { createMagmaMaterial };
