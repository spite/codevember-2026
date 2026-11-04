import { ShaderMaterial, Color, Matrix4, FrontSide, GLSL3 } from "three";
import { globalUniforms } from "./uniforms.js";
import { shGLSL } from "./studio.js";
import { shadowChunk } from "shaders/pipeline/shadow.js";
import { giChunk } from "shaders/pipeline/gi.js";
import { brdf } from "shaders/pipeline/brdf.js";
import { octahedral } from "shaders/pipeline/octahedral.js";

// Which userData matrix the prepass treats as "previous"; the motion blur pass switches it to the shutter's.
const prevMatrixSource = { key: "prevMatrixWorld" };

const VARIANT_DEFINES = {
  color: "PIPELINE_COLOR",
  prepass: "PIPELINE_PREPASS",
  shadow: "PIPELINE_SHADOW",
};

function varyingDecls(varyings, qualifier) {
  return Object.entries(varyings).map(([name, type]) => `${qualifier} ${type} ${name};`).join("\n");
}

function vertexShader({ vertexPars, vertex, vertexMain, varyings }) {
  return /* glsl */ `
uniform mat4 prevModelMatrix;
uniform mat4 prevViewProjection;
uniform float time;
#ifdef PIPELINE_PREPASS
uniform float prevTime;
#if defined(USE_INSTANCING) && defined(PIPELINE_PREV_INSTANCING)
in mat4 prevInstanceMatrix;
#endif
#endif

out vec3 vObjectPosition;
out vec3 vObjectNormal;
out vec3 vWorldPosition;
out vec3 vWorldNormal;
out vec2 vUv;
out vec3 vColor;
#ifdef PIPELINE_PREPASS
out vec4 vCurrClip;
out vec4 vPrevClip;
#endif
${varyingDecls(varyings, "out")}

// True while displace() computes the previous pose for velocity (prepass only).
bool pipelinePrevPose = false;

#if defined(PIPELINE_PREPASS) && defined(PIPELINE_DISPLACE)
// Lets the prepass re-run displace() at prevTime for velocity.
float pipelineCurrentTime() { return time; }
float pipelineTime;
#define time pipelineTime
#endif

${vertexPars}
${vertex}

void main() {
#if defined(PIPELINE_PREPASS) && defined(PIPELINE_DISPLACE)
  pipelineTime = pipelineCurrentTime();
#endif
  vec3 p = position;
  vec3 n = normal;
#ifdef PIPELINE_DISPLACE
  p = displace(p, n);
#endif
  vObjectPosition = p;
  vObjectNormal = n;
  vUv = uv;
#ifdef USE_COLOR
  vColor = color.rgb;
#else
  vColor = vec3(1.0);
#endif
#ifdef USE_INSTANCING_COLOR
  vColor *= instanceColor;
#endif

  vec4 local = vec4(p, 1.0);
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
  mat3 im = mat3(instanceMatrix);
  n = im * (n / vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])));
#endif
  vec4 world = modelMatrix * local;
  vWorldPosition = world.xyz;
  // normalMatrix is the inverse transpose of modelView; the view rotation cancels out.
  vWorldNormal = normalize(transpose(mat3(viewMatrix)) * (normalMatrix * n));
  gl_Position = projectionMatrix * viewMatrix * world;
#ifdef PIPELINE_PREPASS
  vCurrClip = gl_Position;
  vec4 prevLocal = vec4(position, 1.0);
  #ifdef PIPELINE_DISPLACE
  vec3 prevNormal = normal;
  pipelineTime = prevTime;
  pipelinePrevPose = true;
  prevLocal.xyz = displace(prevLocal.xyz, prevNormal);
  pipelinePrevPose = false;
  pipelineTime = pipelineCurrentTime();
  #endif
  #if defined(USE_INSTANCING) && defined(PIPELINE_PREV_INSTANCING)
  prevLocal = prevInstanceMatrix * prevLocal;
  #elif defined(USE_INSTANCING)
  prevLocal = instanceMatrix * prevLocal;
  #endif
  vPrevClip = prevViewProjection * prevModelMatrix * prevLocal;
#endif
  ${vertexMain}
}
`;
}

function fragmentShader({ fragmentPars, surface, varyings }) {
  return /* glsl */ `
uniform vec2 resolution;
uniform mat4 projectionMatrixInverse;
uniform mat4 viewMatrixInverse;
uniform mat4 prevViewProjection;
uniform vec2 jitter;
uniform float time;
uniform float frame;
uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 shIrradiance[9];
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float lightSpecular;
uniform float lightSheen;
uniform float specularShadow;
uniform float aoIntensity;
uniform float giIntensity;
uniform vec3 aoColor;
uniform float aoPower;
uniform float aoDirect;
uniform float aoMin;
uniform vec4 occluders[16];
uniform int occluderCount;
uniform float occluderStrength;
uniform float occluderReach;
uniform sampler2D shadowMask;
uniform float shadowMaskEnabled;
uniform float pipelineDebug;

uniform vec3 baseColor;
uniform float roughness;
uniform float metalness;
uniform float sheen;
uniform vec3 sheenColor;
uniform float sheenRoughness;
uniform vec3 emissive;
uniform float opacity;
uniform vec3 transmission;

in vec3 vObjectPosition;
in vec3 vObjectNormal;
in vec3 vWorldPosition;
in vec3 vWorldNormal;
in vec2 vUv;
in vec3 vColor;
#ifdef PIPELINE_PREPASS
in vec4 vCurrClip;
in vec4 vPrevClip;
#endif
${varyingDecls(varyings, "in")}

layout(location = 0) out vec4 outColor;

struct Surface {
  vec3 albedo;
  float alpha;
  float roughness;
  float metalness;
  vec3 normal;
  vec3 emissive;
  vec3 sheenColor;
  float sheenRoughness;
  float occlusion;
  vec3 transmission; // thin-sheet diffuse transmission (light through the back face)
  float specular; // scales the dielectric F0 (1 = 0.04)
};

${shadowChunk}
${giChunk}
${brdf}
${octahedral}
${shGLSL}

// Visibility from the analytic sphere occluders (Quilez sphere AO), faded out by occluderReach * r.
float sphereOcclusion(vec3 p, vec3 n) {
  float vis = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= occluderCount) break;
    vec4 o = occluders[i];
    vec3 D = o.xyz - p;
    float d = length(D);
    float r = max(o.w, 1e-6);
    // Points deep inside the sphere (the occluder's own surface) are left alone; contact at d ~ r is not.
    float outside = smoothstep(0.3 * r, 0.6 * r, d);
    float occ = (r * r) / max(d * d, r * r) * clamp(dot(n, D / max(d, 1e-4)), 0.0, 1.0);
    occ *= outside * (1.0 - smoothstep(0.5 * occluderReach * r, occluderReach * r, d));
    vis *= o.w > 0.0 ? exp(-occ * occluderStrength) : 1.0;
  }
  return vis;
}

${fragmentPars}
${surface}

void main() {
#ifdef FLAT_SHADED
  vec3 N = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
#else
  vec3 N = normalize(vWorldNormal);
  #ifdef FLIP_SIDED
  N = -N;
  #endif
  #ifdef DOUBLE_SIDED
  N *= gl_FrontFacing ? 1.0 : -1.0;
  #endif
#endif

  Surface s;
  s.albedo = baseColor * vColor;
  s.alpha = opacity;
  s.roughness = roughness;
  s.metalness = metalness;
  s.normal = N;
  s.emissive = emissive;
  s.sheenColor = sheenColor * sheen;
  s.sheenRoughness = sheenRoughness;
  s.occlusion = 1.0;
  s.transmission = transmission;
  s.specular = 1.0;
#ifdef PIPELINE_SURFACE
  surface(s);
#endif

#if defined(PIPELINE_SHADOW)
  if (s.alpha < 0.5) discard;
  // The shadow map's raw depth (ShadowPass).
  outColor = vec4(gl_FragCoord.z);
#elif defined(PIPELINE_PREPASS)
  if (s.alpha < 0.5) discard;
  vec3 nv = normalize(mat3(viewMatrix) * normalize(s.normal));
  vec2 velocity = (vCurrClip.xy / vCurrClip.w - jitter) - vPrevClip.xy / vPrevClip.w;
  outColor = vec4(octEncode(nv), velocity);
#else
  #ifdef OPAQUE
  if (s.alpha < 0.5) discard;
  #endif
  vec3 P = vWorldPosition;
  vec3 n = normalize(s.normal);
  vec3 V = isOrthographic
    ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]))
    : normalize(cameraPosition - P);
  float rough = clamp(s.roughness, 0.03, 1.0);
  float alpha = rough * rough;
  float metal = clamp(s.metalness, 0.0, 1.0);
  vec3 diffuseColor = s.albedo * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04 * s.specular), s.albedo, metal);
  float NdotV = clamp(dot(n, V), 1e-4, 1.0);
  float sheenScale = 1.0 - 0.157 * pipelineMax3(s.sheenColor);
  float sheenRough = clamp(s.sheenRoughness, 0.07, 1.0);

  // Direct key light; lightColor is irradiance, so diffuse = lightColor * NdotL * albedo / pi.
  vec3 L = normalize(lightDirection);
  vec3 H = normalize(L + V);
  // A geometric back face gets no key, even where the shading normal tilts toward it.
  float NdotL = clamp(dot(n, L), 0.0, 1.0) * step(0.0, dot(N, L));
  float NdotH = clamp(dot(n, H), 0.0, 1.0);
  float VdotH = clamp(dot(V, H), 0.0, 1.0);
  #ifdef OPAQUE
  float zTol = giDepthTolerance();
  // Pixels the half-res mask has no match for (thin geometry) trace their own shadow.
  float maskMatch = 0.0;
  float shadow = 1.0;
  if (shadowMaskEnabled > 0.5) shadow = giUpsample(shadowMask, N, zTol, maskMatch).a;
  if (maskMatch < 0.05) shadow = getShadow(P, N);
  #else
  float shadow = getShadow(P, N);
  #endif
  vec3 E = lightColor * NdotL * shadow;
  vec3 directSpecular = E * F_Schlick(VdotH, f0) * D_GGX(NdotH, alpha) * V_SmithGGXCorrelated(alpha, NdotV, NdotL) * lightSpecular;
  vec3 directDiffuse = E * diffuseColor * PIPELINE_INV_PI;
  vec3 directSheen = E * s.sheenColor * D_Charlie(sheenRough, NdotH) * V_Neubelt(NdotV, NdotL) * lightSheen;
  // Thin sheet: the key lighting the back side, shadowed from there.
  vec3 directTransmission = vec3(0.0);
  if (pipelineMax3(s.transmission) > 0.0) {
    float backNdotL = clamp(-dot(n, L), 0.0, 1.0);
    if (backNdotL > 0.0) directTransmission = lightColor * backNdotL * getShadowFixed(P, -N, 3.0) * s.transmission * diffuseColor * PIPELINE_INV_PI;
  }

  // Indirect: SH env irradiance with AO, screen-space GI, prefiltered env specular.
  #ifdef OPAQUE
  vec4 gi = sampleGI(N, zTol);
  #else
  vec4 gi = vec4(0.0, 0.0, 0.0, 1.0);
  #endif
  gi.a = pow(clamp(gi.a, 0.0, 1.0), aoPower);
  float sphereVis = occluderCount > 0 ? sphereOcclusion(P, n) : 1.0;
  float ao = max(mix(1.0, gi.a, aoIntensity) * s.occlusion * sphereVis, aoMin);
  vec3 aoTint = max(mix(vec3(1.0), mix(aoColor, vec3(1.0), gi.a), aoIntensity) * s.occlusion * sphereVis, vec3(aoMin));
  directDiffuse *= mix(1.0, ao, aoDirect) * mix(1.0, sphereVis, 0.5);
  vec3 irradiance = max(evalSH(envRotation * n), vec3(0.0)) * envIntensity;

  vec2 dfg = EnvBRDFApprox(rough, NdotV);
  vec3 FssEss = f0 * dfg.x + dfg.y;
  float Ems = 1.0 - (dfg.x + dfg.y);
  vec3 Favg = f0 + (1.0 - f0) * 0.047619;
  vec3 multiScatter = FssEss * Favg / (1.0 - Ems * Favg) * Ems;
  vec3 kD = diffuseColor * (1.0 - pipelineMax3(FssEss + multiScatter));

  vec3 R = reflect(-V, n);
  R = normalize(mix(R, n, alpha * alpha));
  vec3 radiance = textureLod(envMap, envRotation * R, envMapMaxLod * rough * (2.0 - rough)).rgb * envIntensity;
  float so = specularOcclusion(NdotV, ao, alpha);

  vec3 indirectDiffuse = kD * (irradiance * aoTint + gi.rgb * giIntensity);
  vec3 indirectSpecular = (radiance * FssEss + multiScatter * irradiance) * so;
  vec3 indirectSheen = s.sheenColor * IBLSheenBRDF(NdotV, sheenRough) * irradiance * ao;
  float specShadow = mix(1.0, shadow, specularShadow);
  indirectSpecular *= specShadow;
  indirectSheen *= specShadow;

  vec3 color = (directDiffuse + directSpecular + indirectDiffuse + indirectSpecular + directTransmission) * sheenScale
    + directSheen + indirectSheen + s.emissive;

  if (pipelineDebug > 0.5) {
    int d = int(pipelineDebug + 0.5);
    color = d == 1 ? vec3(shadow) : d == 2 ? vec3(ao) : d == 3 ? gi.rgb : s.albedo;
  }

  #ifdef OPAQUE
  outColor = vec4(color, 1.0);
  #else
  float a = clamp(s.alpha, 0.0, 1.0);
  outColor = vec4(color * a, a);
  #endif
#endif
}
`;
}

// Forward PBR material with PREPASS/SHADOW variants sharing one uniforms object.
class PipelineMaterial extends ShaderMaterial {
  constructor(params = {}) {
    const {
      color = 0xf4efe6,
      roughness = 0.8,
      metalness = 0,
      sheen = 0,
      sheenColor = 0xffffff,
      sheenRoughness = 0.5,
      emissive = 0x000000,
      transmission = 0,
      transmissionColor = 0xffffff,
      opacity = 1,
      transparent = false,
      side = FrontSide,
      flatShading = false,
      uniforms = {},
      vertexPars = "",
      vertex = "",
      vertexMain = "",
      varyings = {},
      fragmentPars = "",
      surface = "",
      defines = {},
      instanceMotion = false,
      ...rest
    } = params;

    const own = {
      baseColor: { value: new Color(color) },
      roughness: { value: roughness },
      metalness: { value: metalness },
      sheen: { value: sheen },
      sheenColor: { value: new Color(sheenColor) },
      sheenRoughness: { value: sheenRoughness },
      emissive: { value: new Color(emissive) },
      opacity: { value: opacity },
      transmission: { value: new Color(transmissionColor).multiplyScalar(transmission) },
      prevModelMatrix: { value: new Matrix4() },
    };
    const source = { vertexPars, vertex, vertexMain, varyings, fragmentPars, surface };
    const baseDefines = { ...defines };
    if (vertex.trim()) baseDefines.PIPELINE_DISPLACE = "";
    if (surface.trim()) baseDefines.PIPELINE_SURFACE = "";
    if (instanceMotion) baseDefines.PIPELINE_PREV_INSTANCING = "";

    super({
      ...rest,
      glslVersion: GLSL3,
      uniforms: { ...globalUniforms, ...own, ...uniforms },
      defines: { ...baseDefines, PIPELINE_COLOR: "" },
      vertexShader: vertexShader(source),
      fragmentShader: fragmentShader(source),
      transparent,
      side,
    });

    this.flatShading = flatShading;
    this.isPipelineMaterial = true;
    this.type = "PipelineMaterial";
    this.toneMapped = false;
    this.premultipliedAlpha = true;
    this.lights = false;
    this.fog = false;
    this.instanceMotion = instanceMotion;
    this._source = source;
    this._baseDefines = baseDefines;
    this._variants = {};
  }

  // ShaderMaterial.copy deep-clones every uniform (and drops render-target textures): clone only our
  // own, share the globals by reference and keep render-target textures as the same texture.
  copy(source) {
    const all = source.uniforms;
    const own = {};
    for (const k in all) {
      if (all[k] !== globalUniforms[k] && !all[k].value?.isRenderTargetTexture) own[k] = all[k];
    }
    source.uniforms = own;
    try {
      super.copy(source);
    } finally {
      source.uniforms = all;
    }
    const cloned = this.uniforms;
    const uniforms = {};
    for (const k in all) {
      if (k in cloned) uniforms[k] = cloned[k];
      else uniforms[k] = all[k] === globalUniforms[k] ? globalUniforms[k] : { value: all[k].value };
    }
    this.uniforms = uniforms;
    this.flatShading = source.flatShading;
    this.isPipelineMaterial = true;
    this.type = "PipelineMaterial";
    this.toneMapped = false;
    this.premultipliedAlpha = source.premultipliedAlpha;
    this.lights = false;
    this.fog = false;
    this.instanceMotion = source.instanceMotion;
    this._source = source._source;
    this._baseDefines = { ...source._baseDefines };
    this._variants = {};
    return this;
  }

  get color() { return this.uniforms.baseColor.value; }
  set color(v) { this.uniforms.baseColor.value.set(v); }
  get roughness() { return this.uniforms.roughness.value; }
  set roughness(v) { this.uniforms.roughness.value = v; }
  get metalness() { return this.uniforms.metalness.value; }
  set metalness(v) { this.uniforms.metalness.value = v; }
  get sheen() { return this.uniforms.sheen.value; }
  set sheen(v) { this.uniforms.sheen.value = v; }
  get sheenColor() { return this.uniforms.sheenColor.value; }
  set sheenColor(v) { this.uniforms.sheenColor.value.set(v); }
  get sheenRoughness() { return this.uniforms.sheenRoughness.value; }
  set sheenRoughness(v) { this.uniforms.sheenRoughness.value = v; }
  get emissive() { return this.uniforms.emissive.value; }
  set emissive(v) { this.uniforms.emissive.value.set(v); }
  // Material's constructor assigns opacity before the uniforms exist.
  get opacity() { return this.uniforms?.opacity?.value ?? this._opacity ?? 1; }
  set opacity(v) {
    if (this.uniforms?.opacity) this.uniforms.opacity.value = v;
    else this._opacity = v;
  }

  customProgramCacheKey() {
    return "pipeline-color";
  }

  get variants() {
    return { prepass: this.getVariant("prepass"), shadow: this.getVariant("shadow") };
  }

  getVariant(name) {
    if (name === "color") return this;
    let m = this._variants[name];
    if (!m) {
      m = new ShaderMaterial({
        glslVersion: GLSL3,
        uniforms: this.uniforms,
        vertexShader: this.vertexShader,
        fragmentShader: this.fragmentShader,
      });
      m.isPipelineVariant = true;
      m.toneMapped = false;
      m.lights = false;
      m.fog = false;
      m.customProgramCacheKey = () => `pipeline-${name}`;
      if (name === "prepass") {
        m.onBeforeRender = (renderer, scene, camera, geometry, object) => {
          this.uniforms.prevModelMatrix.value.copy(object.userData[prevMatrixSource.key] ?? object.matrixWorld);
          m.uniformsNeedUpdate = true;
        };
      }
      m.userData.sourceVersion = -1;
      this._variants[name] = m;
    }
    this._syncVariant(m, name);
    return m;
  }

  _syncVariant(m, name) {
    m.side = name === "shadow" ? (this.shadowSide ?? this.side) : this.side;
    m.flatShading = this.flatShading;
    m.vertexColors = this.vertexColors;
    m.wireframe = this.wireframe;
    m.clippingPlanes = this.clippingPlanes;
    m.clipShadows = this.clipShadows;
    m.depthTest = true;
    m.depthWrite = true;
    m.transparent = false;
    m.colorWrite = true;
    if (m.userData.sourceVersion !== this.version) {
      const defines = { ...this.defines };
      delete defines.PIPELINE_COLOR;
      defines[VARIANT_DEFINES[name]] = "";
      m.defines = defines;
      m.vertexShader = this.vertexShader;
      m.fragmentShader = this.fragmentShader;
      m.needsUpdate = true;
      m.userData.sourceVersion = this.version;
    }
  }

  dispose() {
    for (const m of Object.values(this._variants)) m.dispose();
    super.dispose();
  }
}

export { PipelineMaterial, prevMatrixSource };
