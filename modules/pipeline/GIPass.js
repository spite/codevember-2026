import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Scene,
  OrthographicCamera,
  RawShaderMaterial,
  GLSL3,
  WebGLRenderTarget,
  DataTexture,
  RGBAFormat,
  FloatType,
  HalfFloatType,
  NearestFilter,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Vector2,
  Vector4,
  Matrix4,
} from "three";
import { globalUniforms } from "./uniforms.js";
import {
  fullscreenVertex,
  geometryFragment,
  traceFragment,
  temporalFragment,
  blurFragment,
} from "shaders/pipeline/gi.js";

function target(type, filter = NearestFilter, count = 1) {
  return new WebGLRenderTarget(1, 1, {
    type,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count,
  });
}

const blackTexture = new DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, RGBAFormat, FloatType);
blackTexture.needsUpdate = true;

export class GIPass {
  constructor({
    slices = 2,
    steps = 8,
    radius = 1,
    thickness = 0.5,
    thicknessScale = 0.05,
    fadeStart = null,
    fadeEnd = null,
    temporal = true,
    maxHistory = 32,
    maxRadiusPixels = 128,
    radianceClamp = 8,
    blurPasses = 2,
    depthTolerance = 0.03,
    normalThreshold = 0.8,
    historyClamp = 2.5,
    planeSigma = 0.01,
    normalPower = 16,
  } = {}) {
    Object.assign(this, {
      slices, steps, radius, thickness, thicknessScale, fadeStart, fadeEnd, temporal, maxHistory, maxRadiusPixels,
      radianceClamp, blurPasses, depthTolerance, normalThreshold, planeSigma, normalPower, historyClamp,
    });

    this.fullRes = new Vector2(1, 1);
    this.halfRes = new Vector2(1, 1);

    // Shared by every pass; per-pass inputs are added below.
    const shared = {
      fullRes: { value: this.fullRes },
      halfRes: { value: this.halfRes },
      projInfo: { value: new Vector4() },
      depthInfo: { value: new Vector2() },
      isOrtho: { value: 0 },
      uView: { value: new Matrix4() },
      uViewInverse: { value: new Matrix4() },
    };
    this.shared = shared;

    const make = (fragmentShader, own) =>
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: fullscreenVertex,
        fragmentShader,
        uniforms: { ...shared, ...own },
        depthTest: false,
        depthWrite: false,
      });

    this.geometryMaterial = make(geometryFragment, {
      tDepth: { value: null },
      tNormalVelocity: { value: null },
    });
    this.traceMaterial = make(traceFragment, {
      tGeo: { value: null },
      tNormalVelocity: { value: null },
      tPrevColor: { value: blackTexture },
      radius: { value: radius },
      thickness: { value: thickness },
      thicknessScale: { value: thicknessScale },
      depthFade: { value: new Vector2() },
      maxRadiusPixels: { value: maxRadiusPixels },
      radianceClamp: { value: radianceClamp },
      prevColorValid: { value: 0 },
      noiseFrame: { value: 0 },
      slices: { value: slices },
      steps: { value: steps },
    });
    this.temporalMaterial = make(temporalFragment, {
      tCurrent: { value: null },
      tGeo: { value: null },
      tHistory: { value: null },
      tHistoryGeo: { value: null },
      tNormalVelocity: { value: null },
      uPrevViewProjection: { value: globalUniforms.prevViewProjection.value },
      historyValid: { value: 0 },
      maxHistory: { value: maxHistory },
      depthTolerance: { value: depthTolerance },
      normalThreshold: { value: normalThreshold },
      historyClamp: { value: historyClamp },
    });
    this.blurMaterial = make(blurFragment, {
      tInput: { value: null },
      tGeo: { value: null },
      stepSize: { value: 1 },
      planeSigma: { value: planeSigma },
      normalPower: { value: normalPower },
    });

    this.geometryTarget = target(FloatType);
    this.traceTarget = target(HalfFloatType);
    // textures[0] = accumulated GI/AO, textures[1] = geometry + history length.
    this.history = [0, 1].map(() => {
      const rt = target(HalfFloatType, NearestFilter, 2);
      rt.textures[1].type = FloatType;
      return rt;
    });
    this.blurTargets = [target(HalfFloatType, LinearFilter), target(HalfFloatType, LinearFilter)];
    this.historyIndex = 0;
    this.historyValid = false;
    this.lastTemporal = temporal;
    this.output = this.blurTargets[1];

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry, this.geometryMaterial);
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.fullRes.set(width, height);
    if (w === this.halfRes.x && h === this.halfRes.y) return;
    this.halfRes.set(w, h);
    for (const rt of [this.geometryTarget, this.traceTarget, ...this.history, ...this.blurTargets]) {
      rt.setSize(w, h);
    }
    this.historyValid = false;
  }

  get texture() {
    return this.output.texture;
  }

  resetHistory() {
    this.historyValid = false;
  }

  _pass(renderer, material, rt) {
    this.quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(this.scene, this.quadCamera);
  }

  _updateCamera(camera) {
    const p = camera.projectionMatrix.elements;
    const ortho = camera.isOrthographicCamera ? 1 : 0;
    const s = this.shared;
    s.projInfo.value.set(p[0], p[5], p[8] - p[12], p[9] - p[13]);
    s.depthInfo.value.set(p[10], p[14]);
    s.isOrtho.value = ortho;
    s.uView.value.copy(camera.matrixWorldInverse);
    s.uViewInverse.value.copy(camera.matrixWorld);
  }

  // Half-res depth + normal buffer (also used by the shadow denoiser); render() runs it first.
  renderGeometry(renderer, { depthTexture, normalVelocity, camera }) {
    const prevTarget = renderer.getRenderTarget();
    this._updateCamera(camera);
    const geo = this.geometryMaterial.uniforms;
    geo.tDepth.value = depthTexture;
    geo.tNormalVelocity.value = normalVelocity;
    this._pass(renderer, this.geometryMaterial, this.geometryTarget);
    renderer.setRenderTarget(prevTarget);
    globalUniforms.giGeoMap.value = this.geometryTarget.texture;
  }

  render(renderer, { depthTexture, normalVelocity, prevColor, camera }) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (this.temporal !== this.lastTemporal) this.historyValid = false;
    this.lastTemporal = this.temporal;

    this.renderGeometry(renderer, { depthTexture, normalVelocity, camera });

    const frame = globalUniforms.frame.value;
    const tr = this.traceMaterial.uniforms;
    tr.tGeo.value = this.geometryTarget.texture;
    tr.tNormalVelocity.value = normalVelocity;
    tr.tPrevColor.value = prevColor || blackTexture;
    tr.prevColorValid.value = prevColor && this.historyValid ? 1 : 0;
    tr.radius.value = this.radius;
    tr.thickness.value = this.thickness;
    tr.thicknessScale.value = this.thicknessScale;
    // Fade defaults follow the camera range: 30% to 50% of far.
    tr.depthFade.value.set(this.fadeStart ?? camera.far * 0.3, this.fadeEnd ?? camera.far * 0.5);
    tr.maxRadiusPixels.value = this.maxRadiusPixels / 2;
    tr.radianceClamp.value = this.radianceClamp;
    tr.slices.value = Math.max(1, Math.round(this.slices));
    tr.steps.value = Math.max(1, Math.round(this.steps));
    tr.noiseFrame.value = this.temporal ? frame : 0;
    this._pass(renderer, this.traceMaterial, this.traceTarget);

    let source = this.traceTarget.texture;
    let geometry = this.geometryTarget.texture;

    if (this.temporal) {
      const read = this.history[this.historyIndex];
      const write = this.history[1 - this.historyIndex];
      const tm = this.temporalMaterial.uniforms;
      tm.tCurrent.value = this.traceTarget.texture;
      tm.tGeo.value = this.geometryTarget.texture;
      tm.tHistory.value = read.textures[0];
      tm.tHistoryGeo.value = read.textures[1];
      tm.tNormalVelocity.value = normalVelocity;
      tm.uPrevViewProjection.value = globalUniforms.prevViewProjection.value;
      tm.historyValid.value = this.historyValid ? 1 : 0;
      tm.maxHistory.value = Math.max(1, this.maxHistory);
      tm.depthTolerance.value = this.depthTolerance;
      tm.normalThreshold.value = this.normalThreshold;
      tm.historyClamp.value = this.historyClamp;
      this._pass(renderer, this.temporalMaterial, write);
      this.historyIndex = 1 - this.historyIndex;
      source = write.textures[0];
      geometry = write.textures[1];
    }
    this.historyValid = true;

    const bl = this.blurMaterial.uniforms;
    bl.tGeo.value = geometry;
    bl.planeSigma.value = this.planeSigma;
    bl.normalPower.value = this.normalPower;
    const passes = Math.max(0, Math.round(this.blurPasses));
    // Ends on blurTargets[1] so the output texture keeps its identity; 0 passes is a centre-only copy.
    for (let i = 0; i < Math.max(passes, 1); i++) {
      const dst = this.blurTargets[(Math.max(passes, 1) - 1 - i) % 2 === 0 ? 1 : 0];
      bl.tInput.value = source;
      bl.stepSize.value = passes === 0 ? 0 : 1 << i;
      this._pass(renderer, this.blurMaterial, dst);
      source = dst.texture;
    }
    this.output = this.blurTargets[1];

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    globalUniforms.giMap.value = this.output.texture;
    globalUniforms.depthTexture.value = depthTexture;
    globalUniforms.giEnabled.value = 1;
  }

  dispose() {
    for (const rt of [this.geometryTarget, this.traceTarget, ...this.history, ...this.blurTargets]) {
      rt.dispose();
    }
    for (const m of [this.geometryMaterial, this.traceMaterial, this.temporalMaterial, this.blurMaterial]) {
      m.dispose();
    }
    this.quad.geometry.dispose();
    if (globalUniforms.giMap.value === this.output.texture) {
      globalUniforms.giMap.value = null;
      globalUniforms.giEnabled.value = 0;
    }
  }
}
