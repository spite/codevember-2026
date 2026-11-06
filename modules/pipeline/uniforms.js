import { Vector2, Vector3, Vector4, Matrix3, Matrix4, Color } from "three";

// Shared by every PipelineMaterial and pass; materials merge these by reference.
export const globalUniforms = {
  // camera
  resolution: { value: new Vector2() },
  cameraNear: { value: 0.1 },
  cameraFar: { value: 100 },
  projectionMatrixInverse: { value: new Matrix4() },
  viewMatrixInverse: { value: new Matrix4() },
  prevViewProjection: { value: new Matrix4() },
  jitter: { value: new Vector2() },
  frame: { value: 0 },
  time: { value: 0 },
  prevTime: { value: 0 }, // last frame's time, for displace() velocity
  motionPass: { value: 0 }, // 1 while the motion blur pass renders: the previous pose is the shutter's
  // environment
  envMap: { value: null },
  envMapMaxLod: { value: 0 },
  envIntensity: { value: 1 },
  envRotation: { value: new Matrix3() },
  shIrradiance: { value: Array.from({ length: 9 }, () => new Vector3()) },
  // key light (directional), direction points toward the light
  lightDirection: { value: new Vector3(0.5, 1, 0.3).normalize() },
  lightColor: { value: new Color(1, 1, 1) },
  lightSpecular: { value: 1 },
  lightSheen: { value: 1 }, // scales the key light's direct sheen lobe
  specularShadow: { value: 0 }, // 1 = env specular and sheen darken in the key's shadow (env holds the key softbox)
  // shadows
  shadowMap: { value: null },
  shadowMapCmp: { value: null },
  shadowMatrix: { value: new Matrix4() },
  shadowMapSize: { value: new Vector2(2048, 2048) },
  shadowLightSize: { value: 0.05 },
  shadowSoftness: { value: 1 },
  shadowBias: { value: 0.0005 },
  shadowNormalBias: { value: 0.02 },
  shadowEnabled: { value: 0 },
  shadowMaxRadius: { value: 0.12 }, // PCSS radius clamp in shadow-map uv
  shadowMask: { value: null }, // half-res denoised shadow (ShadowMaskPass), read from .a
  shadowMaskEnabled: { value: 0 },
  // AO + GI
  giMap: { value: null },
  giEnabled: { value: 0 },
  aoIntensity: { value: 1 },
  giIntensity: { value: 1 },
  aoColor: { value: new Color(0, 0, 0) },
  aoPower: { value: 1 },
  aoDirect: { value: 0 }, // fraction of AO applied to direct diffuse
  aoMin: { value: 0 }, // floor on the combined occlusion, so deep pockets never go black
  depthTexture: { value: null },
  giGeoMap: { value: null }, // half-res x = linear depth, y = packed world normal
  // analytic sphere occluders (xyz centre, w radius), for soft contact darkening
  occluders: { value: Array.from({ length: 16 }, () => new Vector4()) },
  occluderCount: { value: 0 },
  occluderStrength: { value: 1 },
  occluderReach: { value: 4 }, // falloff distance in radii
  // 0 beauty, 1 shadow, 2 ao, 3 gi, 4 albedo (set by Pipeline.debug)
  pipelineDebug: { value: 0 },
};
