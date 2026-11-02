// GGX / Charlie BRDF terms and the split-sum environment fits.
export const brdf = /* glsl */ `
#ifndef BRDF_CHUNK
#define BRDF_CHUNK
#define PIPELINE_PI 3.141592653589793
#define PIPELINE_INV_PI 0.3183098861837907

float pipelineMax3(vec3 v) { return max(v.x, max(v.y, v.z)); }

vec3 F_Schlick(float u, vec3 f0) {
  float f = pow(1.0 - u, 5.0);
  return f0 + (1.0 - f0) * f;
}

float D_GGX(float NdotH, float alpha) {
  float a2 = alpha * alpha;
  float f = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PIPELINE_PI * f * f);
}

// Height-correlated Smith, already divided by 4 NdotL NdotV.
float V_SmithGGXCorrelated(float alpha, float NdotV, float NdotL) {
  float a2 = alpha * alpha;
  float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}

float D_Charlie(float roughness, float NdotH) {
  float alpha = roughness * roughness;
  float invAlpha = 1.0 / alpha;
  float sin2h = max(1.0 - NdotH * NdotH, 0.0078125);
  return (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * PIPELINE_PI);
}

float V_Neubelt(float NdotV, float NdotL) {
  return clamp(1.0 / (4.0 * (NdotL + NdotV - NdotL * NdotV)), 0.0, 1.0);
}

// Karis' analytic fit of the split-sum DFG.
vec2 EnvBRDFApprox(float roughness, float NdotV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

// three.js' fit of the directional albedo of the Charlie sheen lobe.
float IBLSheenBRDF(float NdotV, float roughness) {
  float r2 = roughness * roughness;
  float rInv = 1.0 / (roughness + 0.1);
  float a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
  float b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
  return clamp(exp(a * NdotV + b), 0.0, 1.0);
}

// Lagarde's specular occlusion from ambient occlusion.
float specularOcclusion(float NdotV, float ao, float roughness) {
  return clamp(pow(NdotV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
#endif
`;
