import {
  RawShaderMaterial,
  Vector3,
  PMREMGenerator,
  DirectionalLight,
  AmbientLight,
  Vector2,
  HemisphereLight,
  Color,
  GLSL3,
} from "three";
import { UltraHDRLoader } from "third_party/UltraHDRLoader.js";

const envMaps = new Map();

// Accepts (file, renderer) or (renderer[, file]).
function loadEnvMap(file, renderer) {
  if (file?.isWebGLRenderer) [file, renderer] = [renderer, file];
  file ??= "../assets/spruit_sunrise_2k.hdr.jpg";
  if (envMaps.has(file)) return envMaps.get(file);
  const promise = new Promise((resolve, reject) => {
    const loader = new UltraHDRLoader();
    loader.load(
      file,
      (texture) => {
        try {
          const pmremGenerator = new PMREMGenerator(renderer);
          const pmremRT = pmremGenerator.fromEquirectangular(texture);
          texture.dispose();
          pmremGenerator.dispose();
          resolve(pmremRT.texture);
        } catch (e) {
          envMaps.delete(file);
          reject(e);
        }
      },
      undefined,
      (e) => {
        envMaps.delete(file);
        reject(e);
      },
    );
  });
  envMaps.set(file, promise);
  return promise;
}

const vertexShader = `
precision highp float;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

in vec3 position;
in vec3 normal;
in vec2 uv;

out vec3 vPosition;
out vec3 vViewPosition;
out vec3 vWorldPosition;
out vec3 vNormal;
out vec2 vUv;

void main() {
    vUv = uv;
    vPosition = position;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPosition;
} `;

const MAX_DIR_LIGHTS = 4;
const MAX_HEMI_LIGHTS = 2;

const fragmentShader = `
precision highp float;

#define PI 3.141592653589793
#define RECIPROCAL_PI 0.3183098861837907
#define EPSILON 1e-6
#define saturate( a ) clamp( a, 0.0, 1.0 )

struct DirectionalLight { vec3 direction; vec3 color; };
struct HemisphereLight { vec3 direction; vec3 skyColor; vec3 groundColor; };

uniform mat4 viewMatrix;
uniform bool hasEnvMap;

uniform vec3 color; 

uniform bool hasMap;
uniform sampler2D map;
uniform vec2 mapRepeat;

uniform bool hasRoughnessMap;
uniform float roughness;
uniform sampler2D roughnessMap;
uniform vec2 roughnessMapRepeat;

uniform bool hasMetalnessMap;
uniform float metalness;
uniform sampler2D metalnessMap;
uniform vec2 metalnessMapRepeat;

uniform bool hasNormalMap;
uniform sampler2D normalMap;
uniform vec2 normalScale;
uniform vec2 normalRepeat;

uniform float toneMappingExposure; // Added exposure uniform

#define MAX_DIR_LIGHTS ${MAX_DIR_LIGHTS}
#define MAX_HEMI_LIGHTS ${MAX_HEMI_LIGHTS}
uniform DirectionalLight directionalLights[MAX_DIR_LIGHTS];
uniform HemisphereLight hemisphereLights[MAX_HEMI_LIGHTS];
uniform int numDirectionalLights;
uniform int numHemisphereLights;

uniform vec3 ambientLightColor;
uniform vec3 cameraPosition; 

uniform samplerCube envMap;
uniform float envMapIntensity;
uniform float envMapMaxLod;

uniform mat3 normalMatrix;

in vec3 vPosition;
in vec3 vViewPosition;
in vec3 vWorldPosition;
in vec3 vNormal;
in vec2 vUv;

out vec4 fragColor;

// --- Three.js Standard ACES Implementation ---
vec3 RRTAndODTFit( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
}

vec3 ACESFilmicToneMapping( vec3 color ) {
    const mat3 ACESInputMat = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
    );
    const mat3 ACESOutputMat = mat3(
        1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
    );

    // Three.js exposure correction factor
    color *= toneMappingExposure / 0.6;

    color = ACESInputMat * color;
    color = RRTAndODTFit( color );
    color = ACESOutputMat * color;

    return saturate( color );
}

vec4 linearToSRGB( in vec4 value ) {
    return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}

vec3 perturbNormal2Arb( vec3 worldPos, vec3 surf_norm, vec2 uv_coords, in vec3 mapN ) {
    vec3 q0 = dFdx( worldPos.xyz ); vec3 q1 = dFdy( worldPos.xyz );
    vec2 st0 = dFdx( uv_coords.st ); vec2 st1 = dFdy( uv_coords.st );
    vec3 N = surf_norm;
    vec3 q1perp = cross( q1, N ); vec3 q0perp = cross( N, q0 );
    vec3 T = q1perp * st0.x + q0perp * st1.x;
    vec3 B = q1perp * st0.y + q0perp * st1.y;
    float det = max( dot( T, T ), dot( B, B ) );
    float scale_det = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
    mat3 tsn = mat3( T * scale_det, B * scale_det, N );
    
    return normalize( tsn * mapN );
}

vec3 F_Schlick(float u, vec3 f0) { return f0 + (vec3(1.0) - f0) * pow(1.0 - u, 5.0); }

vec3 F_SchlickRoughness(float u, vec3 f0, float roughness) {
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - u, 5.0);
}

float D_GGX(float NdotH, float alpha) {
    float a2 = alpha * alpha;
    float f = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
    return a2 / (PI * f * f);
}

float V_GGX_SmithCorrelated(float alpha, float dotNV, float dotNL) {
    float a2 = alpha * alpha;
    float gv = dotNL * sqrt(dotNV * dotNV * (1.0 - a2) + a2);
    float gl = dotNV * sqrt(dotNL * dotNL * (1.0 - a2) + a2);
    return 0.5 / max(gv + gl, EPSILON);
}

vec2 EnvBRDFApprox(float roughness, float NoV) {
    vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
    return AB;
}

// Mirrors three's PMREM roughnessToMip (envmap_common_pars_fragment)
vec4 textureEnv( samplerCube envMapSampler, vec3 sampleDir, float roughness ) {
    float r = clamp( roughness, 0.0, 1.0 );
    return textureLod( envMapSampler, sampleDir, envMapMaxLod * r * ( 2.0 - r ) );
}

void calculateLight(vec3 L, vec3 lightColor, vec3 geometryNormal, vec3 viewDir, vec3 f0, float alpha, float metalnessFactor, vec3 diffuseReflectance, inout vec3 reflectedLight, inout vec3 diffuseLight) {
    vec3 H = normalize(L + viewDir);
    float NdotL = clamp(dot(geometryNormal, L), 0.0, 1.0);
    float NdotV = clamp(abs(dot(geometryNormal, viewDir)), 0.0, 1.0);
    float NdotH = clamp(dot(geometryNormal, H), 0.0, 1.0);
    float VdotH = clamp(dot(viewDir, H), 0.0, 1.0);
    if (NdotL > 0.0) {
        vec3 F = F_Schlick(VdotH, f0);
        float D = D_GGX(NdotH, alpha);
        float V = V_GGX_SmithCorrelated(alpha, NdotV, NdotL);
        vec3 specular = F * (D * V);
        vec3 kD = (vec3(1.0) - F) * (1.0 - metalnessFactor);
        vec3 diffuse = diffuseReflectance * RECIPROCAL_PI;
        reflectedLight += specular * lightColor * NdotL;
        diffuseLight += diffuse * lightColor * NdotL;
    }
}

vec3 shade(in vec3 worldPosition, in vec3 worldNormal, in vec2 uv, in vec4 diffuseColor, in float roughness, in float metalness) {
   
    float metalnessFactor = metalness;
    float roughnessFactor = max(roughness, 0.0525);
    float alpha = roughnessFactor * roughnessFactor;

    vec3 f0 = vec3(0.04);
    f0 = mix(f0, diffuseColor.rgb, metalnessFactor);
    vec3 diffuseReflectance = diffuseColor.rgb * (1.0 - metalnessFactor);

    vec3 geometryNormal = worldNormal; 
    vec3 viewDir = normalize(cameraPosition - worldPosition);

    vec3 reflectedLight = vec3(0.0);
    vec3 diffuseLight = vec3(0.0);

    for(int i = 0; i < MAX_DIR_LIGHTS; i++) {
        if (i >= numDirectionalLights) break;
        vec3 L = normalize(directionalLights[i].direction);
        calculateLight(L, directionalLights[i].color, geometryNormal, viewDir, f0, alpha, metalnessFactor, diffuseReflectance, reflectedLight, diffuseLight);
    }

    vec3 indirectSpecular = vec3(0.0);
    vec3 indirectDiffuse = vec3(0.0);

    // Hemisphere/ambient lights - simple Lambertian diffuse (no multi-scattering)
    vec3 ambientIrradiance = ambientLightColor;
    for(int i = 0; i < MAX_HEMI_LIGHTS; i++) {
        if (i >= numHemisphereLights) break;
        float weight = 0.5 * dot(geometryNormal, normalize(hemisphereLights[i].direction)) + 0.5;
        ambientIrradiance += mix(hemisphereLights[i].groundColor, hemisphereLights[i].skyColor, weight);
    }
    // Simple Lambert BRDF for ambient/hemisphere
    indirectDiffuse = ambientIrradiance * diffuseReflectance * RECIPROCAL_PI;
    
    if (hasEnvMap) {
        float NdotV = clamp(abs(dot(geometryNormal, viewDir)), 0.0, 1.0);
        
        // Reflection vector - bend toward normal for rough surfaces (Three.js getIBLRadiance)
        vec3 worldReflectVec = reflect(-viewDir, geometryNormal);
        worldReflectVec = normalize(mix(worldReflectVec, geometryNormal, roughnessFactor * roughnessFactor));
        
        // Sample prefiltered radiance
        vec3 radiance = textureEnv(envMap, worldReflectVec, roughnessFactor).rgb;
        radiance *= envMapIntensity;

        // Environment diffuse irradiance
        // Three.js getIBLIrradiance returns: PI * envMapColor * envMapIntensity
        // Then RE_IndirectSpecular divides by PI, so net effect is: envMapColor * envMapIntensity
        vec3 iblIrradiance = textureEnv(envMap, geometryNormal, 1.0).rgb;
        iblIrradiance *= envMapIntensity;
        // Note: NOT dividing by PI here since PMREM irradiance is already properly scaled
        
        // DFG approximation (split-sum approximation)
        vec2 fab = EnvBRDFApprox(roughnessFactor, NdotV);
        
        // Single scattering term
        float specularF90 = 1.0;
        vec3 FssEss = f0 * fab.x + specularF90 * fab.y;
        
        // Multi-scattering compensation (Fdez-Aguera's approach)
        float Ess = fab.x + fab.y;
        float Ems = 1.0 - Ess;
        vec3 Favg = f0 + (1.0 - f0) * 0.047619; // 1/21
        vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
        
        // Total scattering
        vec3 singleScattering = FssEss;
        vec3 multiScattering = Fms * Ems;
        vec3 totalScattering = singleScattering + multiScattering;
        
        // IBL diffuse - reduced by total scattering for energy conservation
        vec3 iblDiffuse = diffuseReflectance * (1.0 - max(max(totalScattering.r, totalScattering.g), totalScattering.b));
        
        // IBL contribution with multi-scattering
        // Use iblIrradiance directly (Three.js: PI * sample / PI = sample)
        indirectSpecular = radiance * singleScattering + multiScattering * iblIrradiance;
        indirectDiffuse += iblDiffuse * iblIrradiance;
    }

    vec3 outgoingLight = reflectedLight + diffuseLight + indirectDiffuse + indirectSpecular;
    return outgoingLight;
}

void _main() {
    float r = roughness;
    float m = metalness;

    mat3 viewMatrixInverse = mat3(inverse(viewMatrix));
    vec3 worldNormal = normalize(viewMatrixInverse * vNormal);
    if (hasNormalMap) {
        vec3 mapN = texture( normalMap, vUv * normalRepeat ).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale;
        worldNormal = perturbNormal2Arb(vWorldPosition, worldNormal, vUv * normalRepeat, mapN);
    }
    if (hasRoughnessMap) {
        r *= texture(roughnessMap, vUv * roughnessMapRepeat).r;
    }
    if (hasMetalnessMap) {
        m *= texture(metalnessMap, vUv * metalnessMapRepeat).r;
    }
    vec4 diffuseColor = vec4(color, 1.0);
    if (hasMap) {
        vec4 texColor = texture(map, vUv * mapRepeat);
        texColor = pow(texColor, vec4(2.2)); 
        diffuseColor *= texColor;
    }

    vec3 outgoingLight = shade(vWorldPosition, worldNormal, vUv, diffuseColor, r, m) ;
    outgoingLight = ACESFilmicToneMapping(outgoingLight);
    fragColor = linearToSRGB(vec4(outgoingLight, 1.0));
}
`;

class Material extends RawShaderMaterial {
  constructor(params = {}) {
    params = {
      ...params,
      uniforms: {
        color: new Color(0xffffff),
        roughness: 0.5,
        metalness: 0,
        ...params.uniforms,
      },
    };
    super({
      vertexShader: params.vertexShader ?? vertexShader,
      fragmentShader:
        (params.fragmentShader ?? fragmentShader) +
        (params.main ?? `void main() { _main(); }`),
      uniforms: {
        color: { value: params.uniforms.color },
        roughness: { value: params.uniforms.roughness },
        metalness: { value: params.uniforms.metalness },
        toneMappingExposure: { value: 1.0 },

        hasMap: { value: params.uniforms.hasMap ?? false },
        map: { value: params.uniforms.map },
        mapRepeat: {
          value: params.uniforms.mapRepeat ?? new Vector2(1, 1),
        },

        hasRoughnessMap: { value: params.uniforms.hasRoughnessMap },
        roughnessMap: { value: params.uniforms.roughnessMap },
        roughnessMapRepeat: {
          value: params.uniforms.roughnessMapRepeat ?? new Vector2(1, 1),
        },

        hasMetalnessMap: { value: params.uniforms.hasMetalnessMap },
        metalnessMap: { value: params.uniforms.metalnessMap },
        metalnessMapRepeat: {
          value: params.uniforms.metalnessMapRepeat ?? new Vector2(1, 1),
        },

        hasNormalMap: { value: params.uniforms.hasNormalMap },
        normalMap: { value: params.uniforms.normalMap },
        normalScale: {
          value: params.uniforms.normalScale ?? new Vector2(1, 1),
        },
        normalRepeat: {
          value: params.uniforms.normalRepeat ?? new Vector2(1, 1),
        },

        ambientLightColor: { value: new Color(0) },

        hemisphereLights: {
          value: [
            {
              direction: new Vector3(0, 1, 0),
              skyColor: new Color(0),
              groundColor: new Color(0),
            },
            {
              direction: new Vector3(0, 1, 0),
              skyColor: new Color(0),
              groundColor: new Color(0),
            },
          ],
        },

        hasEnvMap: { value: false },
        envMap: { value: null },
        envMapIntensity: { value: 1.0 },
        envMapMaxLod: { value: 0 },

        directionalLights: {
          value: [
            { direction: new Vector3(0, 1, 0), color: new Color(0) },
            { direction: new Vector3(0, 1, 0), color: new Color(0) },
            { direction: new Vector3(0, 1, 0), color: new Color(0) },
            { direction: new Vector3(0, 1, 0), color: new Color(0) },
          ],
        },
        numDirectionalLights: { value: 0 },
        numHemisphereLights: { value: 0 },
        ...params.customUniforms,
      },
      glslVersion: GLSL3,
    });
  }

  set envMap(texture) {
    this.uniforms.envMap.value = texture;
    this.uniforms.envMapMaxLod.value = Math.max(texture.mipmaps.length - 1, 0);
    this.uniforms.hasEnvMap.value = true;
    this.needsUpdate = true;
  }

  syncLights(scene) {
    const directionalLights = [];
    const hemisphereLights = [];

    scene.traverse((object) => {
      if (object instanceof AmbientLight) {
        this.uniforms.ambientLightColor.value.copy(object.color);
      }
      if (object instanceof DirectionalLight) {
        directionalLights.push({
          direction: object.position.clone().normalize(),
          color: object.color.clone().multiplyScalar(object.intensity),
        });
      } else if (object instanceof HemisphereLight) {
        hemisphereLights.push({
          direction: object.position.clone().normalize(),
          skyColor: object.color.clone().multiplyScalar(object.intensity),
          groundColor: object.groundColor
            .clone()
            .multiplyScalar(object.intensity),
        });
      }
    });

    const maxDirLights = MAX_DIR_LIGHTS;
    for (let i = 0; i < maxDirLights; i++) {
      if (i < directionalLights.length) {
        this.uniforms.directionalLights.value[i] = directionalLights[i];
      } else {
        this.uniforms.directionalLights.value[i] = {
          direction: new Vector3(0, 1, 0),
          color: new Color(0),
        };
      }
    }
    this.uniforms.numDirectionalLights.value = Math.min(
      directionalLights.length,
      maxDirLights,
    );

    const maxHemiLights = MAX_HEMI_LIGHTS;
    for (let i = 0; i < maxHemiLights; i++) {
      if (i < hemisphereLights.length) {
        this.uniforms.hemisphereLights.value[i] = hemisphereLights[i];
      } else {
        this.uniforms.hemisphereLights.value[i] = {
          direction: new Vector3(0, 1, 0),
          skyColor: new Color(0),
          groundColor: new Color(0),
        };
      }
    }
    this.uniforms.numHemisphereLights.value = Math.min(
      hemisphereLights.length,
      maxHemiLights,
    );
  }

  syncRenderer(renderer) {
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
  }
}

export { Material, loadEnvMap };
