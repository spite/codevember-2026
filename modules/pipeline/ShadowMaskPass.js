import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Scene,
  OrthographicCamera,
  RawShaderMaterial,
  GLSL3,
  WebGLRenderTarget,
  RGBAFormat,
  FloatType,
  HalfFloatType,
  NearestFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
} from "three";
import { globalUniforms } from "./uniforms.js";
import { fullscreenVertex, temporalFragment, blurFragment } from "shaders/pipeline/gi.js";
import { shadowMaskFragment } from "shaders/pipeline/shadowMask.js";

function target(type, count = 1) {
  return new WebGLRenderTarget(1, 1, {
    type,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count,
  });
}

// Screen-space shadow mask: PCSS at half res with per-frame noise, accumulated over a short
// history and bilateral-blurred, so wide penumbrae are smooth instead of stippled.
// Reads the GIPass geometry buffer; materials sample it via globalUniforms.shadowMask.
export class ShadowMaskPass {
  constructor(gi, { maxHistory = 8, historyClamp = 2, blurPasses = 2, pcfSamples = 16, blockerSamples = 16 } = {}) {
    this.gi = gi;
    this.maxHistory = maxHistory;
    this.historyClamp = historyClamp;
    this.blurPasses = blurPasses;

    const make = (fragmentShader, own, defines = {}) =>
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: fullscreenVertex,
        fragmentShader,
        uniforms: { ...gi.shared, ...own },
        defines,
        depthTest: false,
        depthWrite: false,
      });

    const u = globalUniforms;
    this.traceMaterial = make(
      shadowMaskFragment,
      {
        tGeo: { value: null },
        noiseFrame: { value: 0 },
        shadowMap: u.shadowMap,
        shadowMapCmp: u.shadowMapCmp,
        shadowMatrix: u.shadowMatrix,
        shadowMapSize: u.shadowMapSize,
        shadowLightSize: u.shadowLightSize,
        shadowSoftness: u.shadowSoftness,
        shadowBias: u.shadowBias,
        shadowNormalBias: u.shadowNormalBias,
        shadowEnabled: u.shadowEnabled,
        shadowMaxRadius: u.shadowMaxRadius,
      },
      { SHADOW_PCF_SAMPLES: pcfSamples, SHADOW_BLOCKER_SAMPLES: blockerSamples },
    );
    this.temporalMaterial = make(temporalFragment, {
      tCurrent: { value: null },
      tGeo: { value: null },
      tHistory: { value: null },
      tHistoryGeo: { value: null },
      tNormalVelocity: { value: null },
      uPrevViewProjection: { value: u.prevViewProjection.value },
      historyValid: { value: 0 },
      maxHistory: { value: maxHistory },
      depthTolerance: { value: gi.depthTolerance },
      normalThreshold: { value: gi.normalThreshold },
      historyClamp: { value: historyClamp },
    });
    this.blurMaterial = make(blurFragment, {
      tInput: { value: null },
      tGeo: { value: null },
      stepSize: { value: 1 },
      planeSigma: { value: gi.planeSigma },
      normalPower: { value: gi.normalPower },
    });

    this.traceTarget = target(HalfFloatType);
    this.history = [0, 1].map(() => {
      const rt = target(HalfFloatType, 2);
      rt.textures[1].type = FloatType;
      return rt;
    });
    this.blurTargets = [target(HalfFloatType), target(HalfFloatType)];
    this.historyIndex = 0;
    this.historyValid = false;
    this.output = this.blurTargets[1];

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry, this.traceMaterial);
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = 0;
    this.height = 0;
  }

  get texture() {
    return this.output.texture;
  }

  _pass(renderer, material, rt) {
    this.quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(this.scene, this.quadCamera);
  }

  _syncSize() {
    const { x, y } = this.gi.halfRes;
    if (x === this.width && y === this.height) return;
    this.width = x;
    this.height = y;
    for (const rt of [this.traceTarget, ...this.history, ...this.blurTargets]) rt.setSize(x, y);
    this.historyValid = false;
  }

  // After gi.renderGeometry() (or gi.render()) and the shadow map for this frame.
  render(renderer, { normalVelocity }) {
    this._syncSize();
    const prevTarget = renderer.getRenderTarget();
    const geometryTexture = this.gi.geometryTarget.texture;

    const tr = this.traceMaterial.uniforms;
    tr.tGeo.value = geometryTexture;
    tr.noiseFrame.value = globalUniforms.frame.value;
    this._pass(renderer, this.traceMaterial, this.traceTarget);

    const read = this.history[this.historyIndex];
    const write = this.history[1 - this.historyIndex];
    const tm = this.temporalMaterial.uniforms;
    tm.tCurrent.value = this.traceTarget.texture;
    tm.tGeo.value = geometryTexture;
    tm.tHistory.value = read.textures[0];
    tm.tHistoryGeo.value = read.textures[1];
    tm.tNormalVelocity.value = normalVelocity;
    tm.uPrevViewProjection.value = globalUniforms.prevViewProjection.value;
    tm.historyValid.value = this.historyValid ? 1 : 0;
    tm.maxHistory.value = Math.max(1, this.maxHistory);
    tm.historyClamp.value = this.historyClamp;
    this._pass(renderer, this.temporalMaterial, write);
    this.historyIndex = 1 - this.historyIndex;
    this.historyValid = true;

    let source = write.textures[0];
    const bl = this.blurMaterial.uniforms;
    bl.tGeo.value = write.textures[1];
    const passes = Math.max(0, Math.round(this.blurPasses));
    for (let i = 0; i < Math.max(passes, 1); i++) {
      const dst = this.blurTargets[(Math.max(passes, 1) - 1 - i) % 2 === 0 ? 1 : 0];
      bl.tInput.value = source;
      bl.stepSize.value = passes === 0 ? 0 : 1 << i;
      this._pass(renderer, this.blurMaterial, dst);
      source = dst.texture;
    }
    this.output = this.blurTargets[1];
    renderer.setRenderTarget(prevTarget);

    globalUniforms.shadowMask.value = this.output.texture;
    globalUniforms.shadowMaskEnabled.value = 1;
  }

  resetHistory() {
    this.historyValid = false;
  }

  dispose() {
    for (const rt of [this.traceTarget, ...this.history, ...this.blurTargets]) rt.dispose();
    for (const m of [this.traceMaterial, this.temporalMaterial, this.blurMaterial]) m.dispose();
    this.quad.geometry.dispose();
    if (globalUniforms.shadowMask.value === this.output.texture) {
      globalUniforms.shadowMask.value = null;
      globalUniforms.shadowMaskEnabled.value = 0;
    }
  }
}
