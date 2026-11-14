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
  RGFormat,
  FloatType,
  UnsignedByteType,
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
  blurPairFragment,
  tileFragment,
  skipFragment,
} from "shaders/pipeline/gi.js";

function target(type, filter = NearestFilter, count = 1, format = RGBAFormat) {
  return new WebGLRenderTarget(1, 1, {
    type,
    format,
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
    skipFlat = false,
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

    const make = (fragmentShader, own, def = {}) =>
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: fullscreenVertex,
        fragmentShader,
        defines: def,
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
      tSkip: { value: null },
    });
    this.tileMaterial = make(tileFragment, { tGeo: { value: null } });
    this.skipMaterial = make(skipFragment, {
      tTile: { value: null },
      radius: { value: radius },
      maxRadiusPixels: { value: maxRadiusPixels },
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
      tSkip: { value: null },
      skipReach: { value: 0 },
    });
    // GI and the shadow mask blurred in one pass (blurWith): textures[0] = GI, textures[1] = mask.
    this.blurPairMaterial = make(blurPairFragment, {
      tInput: { value: null },
      tMask: { value: null },
      tGeo: { value: null },
      stepSize: { value: 1 },
      planeSigma: { value: planeSigma },
      normalPower: { value: normalPower },
      tSkip: { value: null },
      skipReach: { value: 0 },
    });
    // Opt-in: tiles where everything in reach is one plane skip the trace and blur. Flat floors come out
    // slightly lighter than the trace makes them (it darkens them a little through texel snapping).
    this.skipFlat = skipFlat;

    // x = linear depth, y = packed normal (see packNormal).
    this.geometryTarget = target(FloatType, NearestFilter, 1, RGFormat);
    this.traceTarget = target(HalfFloatType);
    // textures[0] = accumulated GI/AO, textures[1] = geometry + history length.
    this.history = [0, 1].map(() => {
      const rt = target(HalfFloatType, NearestFilter, 2);
      rt.textures[1].type = FloatType;
      return rt;
    });
    this.blurTargets = [target(HalfFloatType, LinearFilter), target(HalfFloatType, LinearFilter)];
    this.blurPairTargets = [0, 1].map(() => {
      const rt = target(HalfFloatType, LinearFilter, 2);
      rt.textures[1].minFilter = rt.textures[1].magFilter = NearestFilter;
      return rt;
    });
    this.tileTarget = target(FloatType);
    this.skipTarget = target(UnsignedByteType);
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
    for (const rt of [this.geometryTarget, this.traceTarget, ...this.history, ...this.blurTargets, ...this.blurPairTargets]) {
      rt.setSize(w, h);
    }
    for (const rt of [this.tileTarget, this.skipTarget]) rt.setSize(Math.ceil(w / 8), Math.ceil(h / 8));
    this.historyValid = false;
  }

  get skipFlat() {
    return this._skipFlat;
  }

  set skipFlat(v) {
    v = !!v;
    if (v === this._skipFlat) return;
    this._skipFlat = v;
    for (const m of [this.traceMaterial, this.blurMaterial, this.blurPairMaterial]) {
      if (v) m.defines.GI_SKIP = "";
      else delete m.defines.GI_SKIP;
      m.needsUpdate = true;
    }
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

  // blur: false leaves the blur to blurWith(), which runs it together with the shadow mask's.
  render(renderer, { depthTexture, normalVelocity, prevColor, camera, blur = true }) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (this.temporal !== this.lastTemporal) this.historyValid = false;
    this.lastTemporal = this.temporal;

    this.renderGeometry(renderer, { depthTexture, normalVelocity, camera });

    if (this.skipFlat) {
      this.tileMaterial.uniforms.tGeo.value = this.geometryTarget.texture;
      this._pass(renderer, this.tileMaterial, this.tileTarget);
      const sk = this.skipMaterial.uniforms;
      sk.tTile.value = this.tileTarget.texture;
      sk.radius.value = this.radius;
      sk.maxRadiusPixels.value = this.maxRadiusPixels / 2;
      this._pass(renderer, this.skipMaterial, this.skipTarget);
      this.traceMaterial.uniforms.tSkip.value = this.skipTarget.texture;
      this.blurMaterial.uniforms.tSkip.value = this.skipTarget.texture;
    }

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
    }
    this.historyValid = true;

    this.blurSource = source;
    if (blur) this._blur(renderer, source, 0);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    if (blur) globalUniforms.giMap.value = this.output.texture;
    globalUniforms.depthTexture.value = depthTexture;
    globalUniforms.giEnabled.value = 1;
  }

  get blurPassCount() {
    return Math.max(0, Math.round(this.blurPasses));
  }

  // A-trous passes from index `from` on (each doubles the step), starting from `source`.
  _blur(renderer, source, from) {
    const prevTarget = renderer.getRenderTarget();
    const bl = this.blurMaterial.uniforms;
    bl.tGeo.value = this.geometryTarget.texture;
    bl.planeSigma.value = this.planeSigma;
    bl.normalPower.value = this.normalPower;
    const passes = this.blurPassCount;
    // Ends on blurTargets[1] so the output texture keeps its identity; 0 passes is a centre-only copy.
    for (let i = from; i < Math.max(passes, 1); i++) {
      const dst = this.blurTargets[(Math.max(passes, 1) - 1 - i) % 2 === 0 ? 1 : 0];
      bl.tInput.value = source;
      bl.stepSize.value = passes === 0 ? 0 : 1 << i;
      // Tiles reached by this pass and the earlier ones (2 * (2^(i+1) - 1) texels, plus the temporal 3x3);
      // without variance clipping, history can carry ghosts into skipped tiles, so nothing is skipped.
      bl.skipReach.value = this._skipReach(i);
      this._pass(renderer, this.blurMaterial, dst);
      source = dst.texture;
    }
    this.output = { texture: source };
    renderer.setRenderTarget(prevTarget);
  }

  _skipReach(i) {
    const clamped = !this.temporal || this.historyClamp > 0;
    return clamped ? Math.ceil((2 * ((1 << (i + 1)) - 1) + 1) / 8) : 0;
  }

  // Blurs GI (after render(..., { blur: false })) and the shadow mask (after its render(..., { blur: false })):
  // the passes both have run as one pair pass, with the same result as blurring each on its own.
  blurWith(renderer, mask) {
    const prevTarget = renderer.getRenderTarget();
    const nG = this.blurPassCount;
    const nM = mask.blurPassCount;
    const sameWeights = mask.blurMaterial.uniforms.planeSigma.value === this.planeSigma && mask.blurMaterial.uniforms.normalPower.value === this.normalPower;
    const shared = nG > 0 && nM > 0 && sameWeights ? Math.min(nG, nM) : 0;
    let gi = this.blurSource;
    let m = mask.blurSource;
    const bp = this.blurPairMaterial.uniforms;
    bp.tGeo.value = this.geometryTarget.texture;
    bp.planeSigma.value = this.planeSigma;
    bp.normalPower.value = this.normalPower;
    for (let i = 0; i < shared; i++) {
      const dst = this.blurPairTargets[i % 2];
      bp.tInput.value = gi;
      bp.tMask.value = m;
      bp.stepSize.value = 1 << i;
      bp.skipReach.value = this._skipReach(i);
      this._pass(renderer, this.blurPairMaterial, dst);
      gi = dst.textures[0];
      m = dst.textures[1];
    }
    renderer.setRenderTarget(prevTarget);
    this._blur(renderer, gi, shared);
    mask._blur(renderer, m, shared);
    globalUniforms.giMap.value = this.output.texture;
  }

  dispose() {
    for (const rt of [this.geometryTarget, this.traceTarget, ...this.history, ...this.blurTargets, ...this.blurPairTargets, this.tileTarget, this.skipTarget]) {
      rt.dispose();
    }
    for (const m of [this.geometryMaterial, this.traceMaterial, this.temporalMaterial, this.blurMaterial, this.blurPairMaterial, this.tileMaterial, this.skipMaterial]) {
      m.dispose();
    }
    this.quad.geometry.dispose();
    if (globalUniforms.giMap.value === this.output.texture) {
      globalUniforms.giMap.value = null;
      globalUniforms.giEnabled.value = 0;
    }
  }
}
