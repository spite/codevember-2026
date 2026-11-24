import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Scene,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  Matrix4,
  Vector3,
  RedFormat,
} from "three";
import { LAVA_GLSL, MORPH_GLSL } from "./lava.js";

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Sphere-traces the morph field in the rock's object space and shades it as neutral molten rock
const MARCH_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uHdr;
uniform sampler2D uNoise;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform mat4 uInvModel;
uniform vec3 uCamLocal;
uniform vec3 uLightLocal;
uniform float uPixelAngle;
uniform float uAlpha;
uniform float uFlowTime;
// The lava pattern of the old look (A) and the new one (B), cross-faded while the liquid churns
uniform float uLookScaleA;
uniform vec3 uLookSeedA;
uniform float uLookScaleB;
uniform vec3 uLookSeedB;
uniform float uLookMix;
// A uniform bound keeps the Direct3D compiler from unrolling the march, which made the shader take seconds to compile
uniform int uSteps;
uniform int uFour;

${MORPH_GLSL}
${LAVA_GLSL}

// Tetrahedral gradient in a loop, so only one copy of the field is inlined
vec3 fieldNormal(vec3 p) {
  vec3 n = vec3(0.0);
  for (int i = 0; i < uFour; i++) {
    vec3 k = vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) * 2.0 - 1.0;
    n += k * morphField(p + k * 0.012);
  }
  return normalize(n);
}

void main() {
  vec4 base = texture(uHdr, vUv);
  outColor = base;

  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 nearV = uInvProj * vec4(ndc, -1.0, 1.0);
  vec4 farV = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 lNear = (uInvModel * (uInvView * vec4(nearV.xyz / nearV.w, 1.0))).xyz;
  vec3 lFar = (uInvModel * (uInvView * vec4(farV.xyz / farV.w, 1.0))).xyz;
  vec3 ro = uCamLocal;
  vec3 rd = normalize(lFar - lNear);

  float R = min(uSdfBound, uFieldRadius + 0.1);
  float b = dot(ro, rd);
  float disc = b * b - (dot(ro, ro) - R * R);
  if (disc <= 0.0) return;
  float s = sqrt(disc);
  float t = max(0.0, -b - s);
  float tEnd = -b + s;
  if (tEnd <= 0.0) return;

  // March to the surface; near misses give the silhouette its coverage
  float closest = 1e9;
  float tClosest = t;
  bool hit = false;
  for (int i = 0; i < uSteps; i++) {
    // Coarse steps from the baked field, the exact one near the surface
    float d = morphFieldFast(ro + rd * t);
    if (d < 0.06) d = morphField(ro + rd * t);
    float footprint = max(t * uPixelAngle, 1e-4);
    float rel = d / footprint;
    if (rel < closest) {
      closest = rel;
      tClosest = t;
    }
    if (d < footprint * 0.25) {
      hit = true;
      break;
    }
    t += max(d * 0.8, footprint * 0.5);
    if (t > tEnd) break;
  }
  float coverage = hit ? 1.0 : clamp(1.0 - closest, 0.0, 1.0);
  if (coverage <= 0.0) return;

  vec3 p = ro + rd * tClosest;
  vec3 n = fieldNormal(p);
  vec3 V = -rd;
  vec3 nf = neutralFlow(n);
  vec3 pp = morphPatternPos(p);
  float lava = sampleFlowingNoise(uNoise, pp, nf, n, uFlowTime, 0.5, uLookScaleA, uLookSeedA).x;
  if (uLookMix > 0.001) lava = mix(lava, sampleFlowingNoise(uNoise, pp, nf, n, uFlowTime, 0.5, uLookScaleB, uLookSeedB).x, uLookMix);
  float skin = skinOf(lava);
  vec3 col = blackbody(moltenTemp(lava));

  // A soft key highlight and rim sheen on the liquid
  vec3 H = normalize(uLightLocal + V);
  float spec = pow(max(dot(n, H), 0.0), mix(24.0, 10.0, skin)) * mix(0.35, 0.08, skin);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
  col += vec3(1.0, 0.85, 0.7) * spec * max(dot(n, uLightLocal), 0.0) + vec3(0.03, 0.02, 0.015) * fres;

  outColor = vec4(mix(base.rgb, col, coverage * uAlpha), base.a);
}
`;

const ATLAS_FS = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
${MORPH_GLSL}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 voxel = vec3(float(px.x % 64), float(px.y % 64), float(px.x / 64 + (px.y / 64) * 8)) + 0.5;
  vec3 p = (voxel / 64.0 - 0.5) * 2.0 * uSdfBound;
  outColor = vec4(morphField(p));
}
`;

// Bakes the morph field (while it is not just shape A's distance field) into a 2D atlas of z slices, so the
// shaft, haze and the morph's coarse march read it with two taps instead of evaluating the pool's noise
class MorphFieldAtlas {
  constructor(renderer, morphUniforms) {
    this.renderer = renderer;
    this.morphUniforms = morphUniforms;
    this.target = new WebGLRenderTarget(512, 512, {
      type: HalfFloatType,
      format: RedFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      colorSpace: NoColorSpace,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const { uFieldAtlas, uFieldBaked, ...fieldUniforms } = morphUniforms;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: ATLAS_FS,
      uniforms: fieldUniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.material));
  }

  update() {
    const u = this.morphUniforms;
    u.uFieldBaked.value = 0;
    if (u.uStage.value === 0) return;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    u.uFieldAtlas.value = this.target.texture;
    u.uFieldBaked.value = 1;
  }
}

class MoltenMorph {
  constructor(renderer, { noiseTexture, morphUniforms }) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.scene.add(this.quad);
    this.outRT = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      colorSpace: NoColorSpace,
      depthBuffer: false,
    });
    this._invModel = new Matrix4();
    this.uniforms = {
      uHdr: { value: null },
      uNoise: { value: noiseTexture },
      uInvProj: { value: new Matrix4() },
      uInvView: { value: new Matrix4() },
      uInvModel: { value: this._invModel },
      uCamLocal: { value: new Vector3() },
      uLightLocal: { value: new Vector3(0, 1, 0) },
      uPixelAngle: { value: 0.001 },
      uAlpha: { value: 0 },
      uFlowTime: { value: 0 },
      uLookScaleA: { value: 1.2 },
      uLookSeedA: { value: new Vector3() },
      uLookScaleB: { value: 1.2 },
      uLookSeedB: { value: new Vector3() },
      uLookMix: { value: 0 },
      uSteps: { value: 96 },
      uFour: { value: 4 },
      ...morphUniforms,
    };
    this.quad.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: MARCH_FS,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
  }

  get material() {
    return this.quad.material;
  }

  apply(hdr, { camera, width, height }, { mesh, alpha, flowTime, lightDirection, lookA, lookB, lookMix = 0 }) {
    if (alpha <= 0.001) return hdr;
    if (this.outRT.width !== width || this.outRT.height !== height) this.outRT.setSize(width, height);

    const u = this.uniforms;
    mesh.updateMatrixWorld();
    this._invModel.copy(mesh.matrixWorld).invert();
    u.uHdr.value = hdr;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uCamLocal.value.copy(camera.position).applyMatrix4(this._invModel);
    u.uLightLocal.value.copy(lightDirection).transformDirection(this._invModel);
    u.uPixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / height;
    u.uAlpha.value = alpha;
    u.uFlowTime.value = flowTime;
    if (lookA) {
      u.uLookScaleA.value = lookA.scale;
      u.uLookSeedA.value.copy(lookA.seed);
    }
    if (lookB) {
      u.uLookScaleB.value = lookB.scale;
      u.uLookSeedB.value.copy(lookB.seed);
    }
    u.uLookMix.value = lookMix;

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.outRT);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    return this.outRT.texture;
  }
}

export { MoltenMorph, MorphFieldAtlas };
