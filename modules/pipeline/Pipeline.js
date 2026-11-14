import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  DynamicDrawUsage,
  Mesh,
  Scene,
  OrthographicCamera,
  RawShaderMaterial,
  WebGLRenderTarget,
  DepthTexture,
  GLSL3,
  RGBAFormat,
  HalfFloatType,
  FloatType,
  UnsignedByteType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  NoToneMapping,
  CustomBlending,
  AddEquation,
  OneFactor,
  NoBlending,
  Color,
  Vector2,
  Vector3,
  Matrix4,
  Quaternion,
  Box3,
  Sphere,
} from "three";
import { globalUniforms } from "./uniforms.js";
import { renderVariant, compileVariant } from "./variants.js";
import { prevMatrixSource } from "./PipelineMaterial.js";
import { ShadowPass } from "./ShadowPass.js";
import { GIPass } from "./GIPass.js";
import { ShadowMaskPass } from "./ShadowMaskPass.js";
import { DepthOfFieldPass } from "./DepthOfFieldPass.js";
import { fullscreenVertex, copyFragment } from "shaders/pipeline/copy.js";
import { bloomDownFragment, bloomUpFragment } from "shaders/pipeline/bloom.js";
import { finalFragment } from "shaders/pipeline/final.js";
import { fxaaFragment } from "shaders/pipeline/fxaa.js";
import { taaFragment } from "shaders/pipeline/taa.js";
import { tileMaxFragment, neighborMaxFragment, reconstructFragment } from "shaders/pipeline/motionBlur.js";

const TIERS = {
  low: { msaa: 0, shadowMapSize: 1024, gi: { slices: 1, steps: 8, blurPasses: 3, maxHistory: 48 }, samples: 1 },
  medium: { msaa: 2, shadowMapSize: 2048, gi: { slices: 1, steps: 8 }, samples: 1 },
  high: { msaa: 4, shadowMapSize: 2048, gi: { slices: 2, steps: 8 }, samples: 1 },
  capture: { msaa: 4, shadowMapSize: 4096, gi: { slices: 3, steps: 12 }, samples: 16 },
};

const TONEMAPPERS = ["agx", "aces", "neutral", "none"];
const DEBUG_VIEWS = ["none", "normals", "depth", "velocity", "shadow", "ao", "gi", "albedo", "clipping"];
// Views the material writes into the HDR target (pipelineDebug), shown untonemapped.
const MATERIAL_DEBUG = { shadow: 1, ao: 2, gi: 3, albedo: 4 };
const FINAL_DEBUG = { normals: 1, depth: 2, velocity: 3, clipping: 5 };

// useUrl false gives what "auto" picks on this device, ignoring ?quality and ?capture.
function resolveQuality(quality, useUrl = true) {
  const query = new URLSearchParams(window.location.search);
  if (useUrl && TIERS[query.get("quality")]) return query.get("quality");
  if (useUrl && query.has("capture")) return "capture";
  if (TIERS[quality]) return quality;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
  return mobile ? "medium" : "high";
}

function usesInstanceMotion(material) {
  return Array.isArray(material) ? material.some((m) => m.instanceMotion) : !!material.instanceMotion;
}

function halton(index, base) {
  let f = 1;
  let r = 0;
  while (index > 0) {
    f /= base;
    r += f * (index % base);
    index = Math.floor(index / base);
  }
  return r;
}

function colorTarget(type = HalfFloatType, options = {}) {
  return new WebGLRenderTarget(1, 1, {
    type,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...options,
  });
}

function quadMaterial(fragmentShader, uniforms, options = {}) {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: fullscreenVertex,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    ...options,
  });
}

const _size = new Vector2();
const _box = new Box3();
const _meshBox = new Box3();
const _sphere = new Sphere();
const _projection = new Matrix4();
const _viewProjection = new Matrix4();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _s1 = new Vector3();
const _q0 = new Quaternion();
const _q1 = new Quaternion();
const _dq = new Quaternion();
const _axis = new Vector3();
const _lens = { x: 0, y: 0, jx: 0, jy: 0 };
const _right = new Vector3();
const _up = new Vector3();

class Pipeline {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.quality = resolveQuality(options.quality ?? "auto");
    this.autoQuality = resolveQuality(options.quality ?? "auto", false);
    const tier = TIERS[this.quality];

    // Opt-in temporal antialiasing: one jittered sample per pixel each frame, resolved against the reprojected
    // history (see shaders/pipeline/taa.js), so anything a material samples stochastically per frame (transparency,
    // shadows) averages out in motion too. It replaces MSAA (and FXAA) unless msaa is given.
    this.temporal = !!options.temporal;
    this.temporalFeedback = options.temporal?.feedback ?? 0.9;
    this.temporalClamp = options.temporal?.clamp ?? 1.25;
    this.msaa = Math.min(options.msaa ?? (this.temporal ? 0 : tier.msaa), renderer.capabilities.maxSamples);
    this.samples = options.samples ?? tier.samples;
    this.shadows = options.shadows ?? true;
    this.giEnabled = options.gi ?? true;
    this.bloom = options.bloom ?? true;
    this.background = new Color(options.background ?? 0xf2efe9);
    this.exposure = options.exposure ?? 1;
    this.bloomStrength = options.bloomStrength ?? 0.04;
    this.bloomRadius = options.bloomRadius ?? 0.6;
    this.vignette = options.vignette ?? 0.25;
    this.grain = options.grain ?? 0.03;
    this.aberration = options.aberration ?? 0;
    this.saturation = options.saturation ?? 1;
    this.contrast = options.contrast ?? 1;
    this.tonemapper = options.tonemapper ?? "agx";
    this.debug = "none";
    // Tints displayed luminance above 0.97 yellow on the normal image (exposure check).
    this.clipWarning = options.clipWarning ?? false;
    // Draws every pipeline mesh as wireframe; a mesh with userData.noWireframe is left to the day.
    this._wireframe = options.wireframe ?? false;
    this._wired = new Map();
    const shadowOptions = { mapSize: tier.shadowMapSize, autoFit: true, ...options.shadow };
    // Fits the shadow camera to the casters every frame; set false after calling shadow.fit() yourself.
    this.shadowAutoFit = shadowOptions.autoFit;
    // Opt-in: shadows computed at half res and denoised over time (see ShadowMaskPass).
    this.shadowDenoise = shadowOptions.denoise ?? false;
    this.shadowMaskOptions = shadowOptions.mask ?? {};
    this.shadowMask = null;

    // Opt-in motion blur over a shutter window in scene time, so it holds while time is paused.
    // Meshes may set userData.shutterMatrixWorld (pose at time - shutter / 2) with userData.shutterManual;
    // otherwise it is extrapolated from their last measured motion. The camera is not blurred.
    const motionOptions = options.motionBlur;
    this.motionBlurAvailable = !!motionOptions;
    this.motionBlur = motionOptions ? (motionOptions.enabled ?? true) : false;
    this.shutter = motionOptions?.shutter ?? 1 / 30;
    this.motionSamples = motionOptions?.samples ?? (this.quality === "capture" ? 32 : 24);
    this.motionMaxBlur = motionOptions?.maxBlur ?? 0.03; // half-length cap, as a fraction of the height
    this.motionSoftZ = motionOptions?.softZ ?? 0.1;
    // Opt-in: with the camera still, blur from the prepass velocity (last frame's motion) instead of rendering
    // the scene again for the shutter's. Only for scenes whose motion is already measured per frame.
    this.motionReusePrepass = motionOptions?.reusePrepass ?? false;

    // (hdrTexture, { depthTexture, camera, width, height }) => texture, run before bloom; see render().
    this.composite = options.composite ?? null;

    // Opt-in depth of field (perspective cameras). Set dof.focus (distance) and dof.aperture (blur of
    // infinity, as a fraction of the height). Live frames are blurred by depth; while nothing changes,
    // frames from across the lens are averaged up to lensSamples for the exact result.
    const dofOptions = options.depthOfField;
    this.dof = dofOptions ? new DepthOfFieldPass(dofOptions) : null;
    this.dofRequested = !!dofOptions;
    this.dofEnabled = !!dofOptions && (dofOptions.enabled ?? true);
    this.lensSamples = dofOptions?.lensSamples ?? 256;
    // Opt-in: while the view holds still, average this many jittered frames, then stop rendering the scene.
    // Without depth of field it borrows the lens average with no aperture, so it only antialiases.
    this.stillSamples = options.stillSamples ?? 0;
    if (this.stillSamples > 0 && !this.dof) this.dof = new DepthOfFieldPass({ aperture: 0 });
    this.lensCount = 0;
    this._stillKey = [];

    this.shadow = new ShadowPass({ mapSize: shadowOptions.mapSize });
    this.gi = new GIPass({ ...tier.gi, ...options.giOptions });

    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.hasPrevColor = false;
    this.hasPrevFrame = false;
    this.meshes = [];
    this.instanceMotion = [];

    this.depthTexture = new DepthTexture(1, 1, FloatType);
    this.prepassTarget = colorTarget(HalfFloatType, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      depthTexture: this.depthTexture,
    });
    // Nothing reads the main pass's depth (passes use the prepass's), so MSAA depth is neither resolved nor kept.
    // Temporal without MSAA instead draws the main pass over the prepass's depth, so hidden surfaces are rejected
    // before they are shaded (only the nearest is lit, however deep the overdraw).
    this.reuseDepth = this.temporal && this.msaa === 0 && (options.temporal?.reuseDepth ?? true);
    this.mainTarget = this.reuseDepth
      ? colorTarget(HalfFloatType, { depthBuffer: true, depthTexture: this.depthTexture })
      : colorTarget(HalfFloatType, { depthBuffer: true, samples: this.msaa, resolveDepthBuffer: false, storeMultisampledDepthBuffer: false });
    this.prevColorTarget = colorTarget(HalfFloatType);
    this.accumTarget = colorTarget(HalfFloatType);
    this.ldrTarget = colorTarget(UnsignedByteType);
    if (this.motionBlurAvailable) {
      const nearest = { minFilter: NearestFilter, magFilter: NearestFilter };
      this.motionTarget = colorTarget(HalfFloatType, { ...nearest, depthBuffer: true });
      this.tileTarget = colorTarget(HalfFloatType, nearest);
      this.neighborTarget = colorTarget(HalfFloatType, nearest);
      this.blurTarget = colorTarget(HalfFloatType);
      const velocity = { tVelocity: { value: this.motionTarget.texture }, resolution: { value: new Vector2() }, maxRadius: { value: 32 } };
      this.tileMaxMaterial = quadMaterial(tileMaxFragment, { ...velocity, tile: { value: 32 } });
      this.neighborMaxMaterial = quadMaterial(neighborMaxFragment, { tTiles: { value: this.tileTarget.texture }, reach: { value: 4 } });
      this.reconstructMaterial = quadMaterial(reconstructFragment, {
        ...velocity,
        tColor: { value: null },
        tDepth: { value: this.depthTexture },
        tNeighbor: { value: this.neighborTarget.texture },
        tile: { value: 32 },
        samples: { value: 16 },
        softZ: { value: 0.1 },
        cameraNear: globalUniforms.cameraNear,
        cameraFar: globalUniforms.cameraFar,
        isOrtho: { value: 0 },
        frame: { value: 0 },
      });
    }

    this.bloomLevels = [];
    this.bloomNorm = 1;

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry);
    this.quad.frustumCulled = false;
    this.quadScene = new Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.copyMaterial = quadMaterial(copyFragment, { tInput: { value: null }, weight: { value: 1 } }, { blending: NoBlending });
    this.accumMaterial = quadMaterial(
      copyFragment,
      { tInput: { value: null }, weight: { value: 1 } },
      {
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: OneFactor,
        blendDst: OneFactor,
        blendEquationAlpha: AddEquation,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneFactor,
      },
    );
    this.downMaterial = quadMaterial(bloomDownFragment, {
      tInput: { value: null },
      texel: { value: new Vector2() },
      karis: { value: 1 },
      clampMax: { value: 64 },
    });
    this.upMaterial = quadMaterial(bloomUpFragment, {
      tLow: { value: null },
      tHigh: { value: null },
      texel: { value: new Vector2() },
      radius: { value: 1 },
    });
    this.finalMaterial = quadMaterial(finalFragment, {
      tColor: { value: null },
      tBloom: { value: null },
      tNormalVelocity: { value: this.prepassTarget.texture },
      tDepth: { value: this.depthTexture },
      bloomStrength: { value: 0 },
      bloomScale: { value: 1 },
      exposure: { value: 1 },
      vignette: { value: 0 },
      grain: { value: 0 },
      aberration: { value: 0 },
      saturation: { value: 1 },
      contrast: { value: 1 },
      tonemapper: { value: 0 },
      frame: { value: 0 },
      debugView: { value: 0 },
      clipWarning: { value: 0 },
      cameraNear: globalUniforms.cameraNear,
      cameraFar: globalUniforms.cameraFar,
      isOrtho: { value: 0 },
    });
    this.fxaaMaterial = quadMaterial(fxaaFragment, { tInput: { value: this.ldrTarget.texture } });
    this.taaTargets = this.temporal ? [colorTarget(HalfFloatType), colorTarget(HalfFloatType)] : [];
    this.taaIndex = 0;
    this.taaHistory = false;
    this.taaMaterial = quadMaterial(taaFragment, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tNormalVelocity: { value: this.prepassTarget.texture },
      tDepth: { value: this.depthTexture },
      resolution: { value: new Vector2() },
      feedback: { value: this.temporalFeedback },
      hasHistory: { value: 0 },
      clampGamma: { value: this.temporalClamp },
    }, { blending: NoBlending });

    renderer.getDrawingBufferSize(_size);
    this._resize(_size.x, _size.y);

    if (this.shadows && this.shadowDenoise) this.shadowMask = new ShadowMaskPass(this.gi, this.shadowMaskOptions);
    this._passesCompiled = this._compilePasses();
  }

  setSize(width, height, dpr = this.renderer.getPixelRatio()) {
    this._resize(Math.floor(width * dpr), Math.floor(height * dpr));
  }

  _resize(w, h) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    for (const rt of [this.prepassTarget, this.mainTarget, this.prevColorTarget, this.accumTarget, this.ldrTarget, ...this.taaTargets]) {
      rt.setSize(w, h);
    }
    this.taaHistory = false;
    this.gi.setSize(w, h);
    this.dof?.setSize(w, h);
    this.lensCount = 0;
    if (this.motionBlurAvailable) {
      this.motionTarget.setSize(w, h);
      this.blurTarget.setSize(w, h);
      // Small tiles, with the neighbourhood max reaching as far as the longest blur, keep tile edges fine.
      const tile = 8;
      const maxRadius = Math.max(tile, Math.ceil(this.motionMaxBlur * h));
      this.tileTarget.setSize(Math.ceil(w / tile), Math.ceil(h / tile));
      this.neighborTarget.setSize(Math.ceil(w / tile), Math.ceil(h / tile));
      this.neighborMaxMaterial.uniforms.reach.value = Math.ceil(maxRadius / tile);
      for (const m of [this.tileMaxMaterial, this.reconstructMaterial]) {
        m.uniforms.tile.value = tile;
        m.uniforms.maxRadius.value = maxRadius;
        m.uniforms.resolution.value.set(w, h);
      }
    }
    globalUniforms.resolution.value.set(w, h);
    this.hasPrevColor = false;
    this._buildBloom(w, h);
  }

  _buildBloom(w, h) {
    for (const level of this.bloomLevels) {
      level.down.dispose();
      level.up.dispose();
    }
    this.bloomLevels = [];
    this._bloomCache = null;
    let lw = w;
    let lh = h;
    for (let i = 0; i < 7; i++) {
      lw = Math.max(1, Math.floor(lw / 2));
      lh = Math.max(1, Math.floor(lh / 2));
      const down = colorTarget();
      const up = colorTarget();
      down.setSize(lw, lh);
      up.setSize(lw, lh);
      this.bloomLevels.push({ down, up, width: lw, height: lh });
      if (Math.min(lw, lh) <= 8) break;
    }
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  // Pose at time - shutter / 2, extrapolated from the motion measured while time last advanced.
  _updateShutter(object, dt) {
    const d = object.userData;
    if (d.shutterManual) return;
    d.shutterMatrixWorld ??= object.matrixWorld.clone();
    d.motionLinear ??= new Vector3();
    d.motionAngular ??= new Vector3();
    object.matrixWorld.decompose(_p1, _q1, _s1);
    if (dt > 1e-6) {
      d.prevMatrixWorld.decompose(_p0, _q0, _axis);
      d.motionLinear.subVectors(_p1, _p0).divideScalar(dt);
      _dq.copy(_q1).multiply(_q0.invert());
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
      const angle = 2 * Math.acos(Math.min(_dq.w, 1));
      const sin = Math.sqrt(Math.max(1 - _dq.w * _dq.w, 0));
      if (sin > 1e-6) d.motionAngular.set(_dq.x / sin, _dq.y / sin, _dq.z / sin).multiplyScalar(angle / dt);
      else d.motionAngular.set(0, 0, 0);
    }
    const half = this.shutter / 2;
    _p1.addScaledVector(d.motionLinear, -half);
    const rate = d.motionAngular.length();
    if (rate > 1e-6) _q1.premultiply(_dq.setFromAxisAngle(_axis.copy(d.motionAngular).divideScalar(rate), -rate * half));
    d.shutterMatrixWorld.compose(_p1, _q1, _s1);
  }

  // True when the camera's view-projection matches the one stored last frame.
  _cameraUnmoved(camera) {
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const a = _viewProjection.elements, b = globalUniforms.prevViewProjection.value.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6 * (1 + Math.abs(b[i]))) return false;
    return true;
  }

  _renderMotion(scene, camera) {
    const u = globalUniforms;
    _viewProjection.copy(u.prevViewProjection.value);
    const prevTime = u.prevTime.value;
    u.prevViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.prevTime.value = u.time.value - this.shutter / 2;
    prevMatrixSource.key = "shutterMatrixWorld";
    u.motionPass.value = 1;
    try {
      this.renderer.setRenderTarget(this.motionTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, true);
      renderVariant(this.renderer, scene, camera, "prepass", this.motionTarget);
    } finally {
      prevMatrixSource.key = "prevMatrixWorld";
      u.motionPass.value = 0;
      u.prevViewProjection.value.copy(_viewProjection);
      u.prevTime.value = prevTime;
    }
  }

  _renderMotionBlur(hdr) {
    this._pass(this.tileMaxMaterial, this.tileTarget);
    this._pass(this.neighborMaxMaterial, this.neighborTarget);
    const r = this.reconstructMaterial.uniforms;
    r.tColor.value = hdr;
    r.samples.value = Math.max(2, Math.round(this.motionSamples));
    r.softZ.value = this.motionSoftZ;
    r.isOrtho.value = this.finalMaterial.uniforms.isOrtho.value;
    r.frame.value = this.frame;
    this._pass(this.reconstructMaterial, this.blurTarget);
    return this.blurTarget.texture;
  }

  // Collects the meshes once per frame: previous matrices, and the shadow casters' bounds.
  _gatherScene(scene, time = globalUniforms.time.value) {
    const motion = this.motionBlur && this.motionBlurAvailable;
    const dt = time - globalUniforms.prevTime.value;
    const meshes = this.meshes;
    meshes.length = 0;
    this.instanceMotion.length = 0;
    _box.makeEmpty();
    // Anything that changes the picture, for telling when the view holds still.
    let signature = 0;
    scene.traverseVisible((object) => {
      if (!object.material) return;
      meshes.push(object);
      this._syncShadowDefines(object);
      if (!object.userData.prevMatrixWorld) object.userData.prevMatrixWorld = object.matrixWorld.clone();
      else if (!object.matrixWorld.equals(object.userData.prevMatrixWorld)) signature += 1e9;
      signature += object.id * 31 + (object.geometry?.id ?? 0) * 7 + (object.instanceMatrix?.version ?? 0) + (object.count ?? 0);
      if (motion) this._updateShutter(object, dt);
      if (object.isInstancedMesh && usesInstanceMotion(object.material)) this._trackInstances(object);
      if (!this.shadowAutoFit || object.userData.noShadow || !object.geometry) return;
      const material = object.material;
      const pipeline = Array.isArray(material) ? material.some((m) => m.isPipelineMaterial) : material.isPipelineMaterial;
      if (!pipeline) return;
      if (object.isInstancedMesh) {
        if (!object.boundingSphere) object.computeBoundingSphere();
        _sphere.copy(object.boundingSphere).applyMatrix4(object.matrixWorld);
        _sphere.getBoundingBox(_meshBox);
      } else {
        if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
        _sphere.copy(object.geometry.boundingSphere).applyMatrix4(object.matrixWorld);
        _sphere.getBoundingBox(_meshBox);
      }
      _box.union(_meshBox);
    });
    this.sceneSignature = signature + meshes.length;
  }

  // Pipeline materials compile a lighter getShadow fallback while the denoised shadow mask is on.
  _syncShadowDefines(object) {
    const want = this.shadows && this.shadowDenoise;
    for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!m?.isPipelineMaterial || ("PIPELINE_DENOISED_SHADOWS" in m.defines) === want) continue;
      if (want) m.defines.PIPELINE_DENOISED_SHADOWS = "";
      else delete m.defines.PIPELINE_DENOISED_SHADOWS;
      m.needsUpdate = true;
    }
  }

  // True while the camera, the scene, time and focus have not changed since the last frame.
  _isStill(camera, time) {
    const key = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, time, this.sceneSignature, this.dof.focus, this.dof.aperture, this.width, this.height];
    const last = this._stillKey;
    let still = key.length === last.length;
    for (let i = 0; still && i < key.length; i++) still = Math.abs(key[i] - last[i]) <= 1e-6 * Math.max(1, Math.abs(key[i]));
    this._stillKey = key;
    return still;
  }

  // This frame moves in a way the pipeline cannot see (e.g. uniforms while paused): render it live (TAA), not as a still.
  markMoving() {
    this._moving = true;
  }

  // Restarts the lens average, for changes the pipeline cannot see (uniforms, materials).
  // fade: false for motion it cannot see (an object the day draws itself), which would ghost if faded.
  restartAccumulation(fade = true) {
    if (!fade) {
      this._settleShown = null;
      this._settleFade = false;
    }
    // A settled still that starts over fades from what is on screen instead of jumping to one raw frame.
    if (this.stillSamples > 0 && this._settleShown) {
      this._settleFrom ??= colorTarget(HalfFloatType);
      if (this._settleFrom.width !== this.width || this._settleFrom.height !== this.height) this._settleFrom.setSize(this.width, this.height);
      const prev = this.renderer.getRenderTarget();
      this.copyMaterial.uniforms.tInput.value = this._settleShown;
      this.copyMaterial.uniforms.weight.value = 1;
      this._pass(this.copyMaterial, this._settleFrom);
      this.renderer.setRenderTarget(prev);
      this._settleFade = true;
    }
    this.lensCount = 0;
  }

  // One more frame from across the lens, folded into the mean; the gathered frame stands in until
  // there are enough of them.
  _renderLens(scene, camera, limit = this.lensSamples, gather = true) {
    const dof = this.dof;
    if (this.lensCount >= limit) {
      this._lensDone = true;
      return gather ? dof.lensResult : (this._settleShown = dof.lensResult);
    }
    const n = ++this.lensCount;
    dof.lensSample(n, camera, _lens);
    _p0.copy(camera.position);
    _right.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(_lens.x);
    _up.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(_lens.y);
    camera.position.add(_right).add(_up);
    camera.updateMatrixWorld();
    _projection.copy(camera.projectionMatrix);
    this._setJitter(camera, _lens.jx, _lens.jy);
    let hdr;
    try {
      this._renderFrame(scene, camera, n === 1);
      hdr = this.mainTarget.texture;
      if (this.motionBlur && this.motionBlurAvailable) {
        this._renderMotion(scene, camera);
        hdr = this._renderMotionBlur(hdr);
      }
      if (this.composite) hdr = this.composite(hdr, { depthTexture: this.depthTexture, camera, width: this.width, height: this.height }) ?? hdr;
      this._storePrevious(camera);
    } finally {
      camera.projectionMatrix.copy(_projection);
      globalUniforms.jitter.value.set(0, 0);
      camera.position.copy(_p0);
      camera.updateMatrixWorld();
      this._updateCameraUniforms(camera);
    }
    const mean = dof.accumulate(this.renderer, hdr, n);
    if (!gather) {
      const t = this._settleFade ? Math.min(1, n / 24) : 1;
      if (t >= 1) this._settleFade = false;
      return (this._settleShown = t < 1 ? dof.blend(this.renderer, this._settleFrom.texture, mean, t * t * (3 - 2 * t)) : mean);
    }
    const fade = Math.min(1, Math.max(0, (n - 8) / 24));
    if (fade >= 1) return mean;
    return dof.blend(this.renderer, dof.gather(this.renderer, hdr, this.depthTexture, camera), mean, fade);
  }

  _trackInstances(object) {
    const current = object.instanceMatrix.array;
    const prev = object.geometry.getAttribute("prevInstanceMatrix");
    if (!prev || prev.array.length !== current.length) {
      const attribute = new InstancedBufferAttribute(new Float32Array(current), 16);
      attribute.setUsage(DynamicDrawUsage);
      object.geometry.setAttribute("prevInstanceMatrix", attribute);
    }
    this.instanceMotion.push(object);
  }

  _updateCameraUniforms(camera) {
    const u = globalUniforms;
    // From the projection matrix rather than camera.near/far, which a day can change without updateProjectionMatrix().
    const p = camera.projectionMatrix.elements;
    if (camera.isOrthographicCamera) {
      u.cameraNear.value = (p[14] + 1) / p[10];
      u.cameraFar.value = (p[14] - 1) / p[10];
    } else {
      u.cameraNear.value = p[14] / (p[10] - 1);
      u.cameraFar.value = p[14] / (p[10] + 1);
    }
    u.projectionMatrixInverse.value.copy(camera.projectionMatrix).invert();
    u.viewMatrixInverse.value.copy(camera.matrixWorld);
    this.finalMaterial.uniforms.isOrtho.value = camera.isOrthographicCamera ? 1 : 0;
  }

  _storePrevious(camera) {
    globalUniforms.prevViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (const object of this.meshes) object.userData.prevMatrixWorld.copy(object.matrixWorld);
    for (const object of this.instanceMotion) {
      const prev = object.geometry.getAttribute("prevInstanceMatrix");
      prev.array.set(object.instanceMatrix.array);
      prev.needsUpdate = true;
    }
    globalUniforms.prevTime.value = globalUniforms.time.value;
  }

  _setJitter(camera, jx, jy) {
    globalUniforms.jitter.value.set(jx, jy);
    const e = camera.projectionMatrix.elements;
    if (camera.isOrthographicCamera) {
      e[12] += jx;
      e[13] += jy;
    } else {
      // NDC.x = -e0*x/z - e8 under perspective, so the sign flips.
      e[8] -= jx;
      e[9] -= jy;
    }
  }

  _renderFrame(scene, camera, renderShadow = true) {
    const renderer = this.renderer;
    const u = globalUniforms;
    u.frame.value = this.frame;
    this._updateCameraUniforms(camera);

    if (this.shadows) {
      if (renderShadow) {
        if (this.shadowAutoFit && !_box.isEmpty()) this.shadow.fit(_box);
        this.shadow.render(renderer, scene);
      }
    } else {
      u.shadowEnabled.value = 0;
    }

    renderer.setRenderTarget(this.prepassTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderVariant(renderer, scene, camera, "prepass", this.prepassTarget);
    u.depthTexture.value = this.depthTexture;

    if (this.giEnabled && !this._giWasEnabled) this.gi.resetHistory();
    this._giWasEnabled = this.giEnabled;
    const denoise = this.shadows && this.shadowDenoise;
    if (denoise && !this._denoiseWasEnabled) this.shadowMask?.resetHistory();
    this._denoiseWasEnabled = denoise;

    // With both on, GI and the shadow mask share their blur passes (gi.blurWith).
    const jointBlur = this.giEnabled && denoise;
    if (this.giEnabled) {
      this.gi.render(renderer, {
        depthTexture: this.depthTexture,
        normalVelocity: this.prepassTarget.texture,
        prevColor: this.hasPrevColor ? this._prevColor : null,
        camera,
        blur: !jointBlur,
      });
    } else {
      u.giEnabled.value = 0;
    }

    if (denoise) {
      if (!this.giEnabled) {
        this.gi.renderGeometry(renderer, { depthTexture: this.depthTexture, normalVelocity: this.prepassTarget.texture, camera });
      }
      this.shadowMask ??= new ShadowMaskPass(this.gi, this.shadowMaskOptions);
      this.shadowMask.render(renderer, { normalVelocity: this.prepassTarget.texture, blur: !jointBlur });
      if (jointBlur) this.gi.blurWith(renderer, this.shadowMask);
    } else {
      u.shadowMaskEnabled.value = 0;
    }

    // Material debug views redraw after the copy so next frame's GI still sees the beauty pass.
    const debug = u.pipelineDebug.value;
    u.pipelineDebug.value = 0;
    this._renderMain(scene, camera);
    // Nothing draws into mainTarget again before the next frame's GI reads it, except a debug view.
    this._prevColor = this.mainTarget.texture;
    if (debug > 0) {
      this.copyMaterial.uniforms.tInput.value = this.mainTarget.texture;
      this.copyMaterial.uniforms.weight.value = 1;
      this._pass(this.copyMaterial, this.prevColorTarget);
      this._prevColor = this.prevColorTarget.texture;
    }
    this.hasPrevColor = true;
    u.pipelineDebug.value = debug;
    if (debug > 0) this._renderMain(scene, camera);
    this.frame++;
  }

  _renderMain(scene, camera) {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.mainTarget);
    renderer.setClearColor(this.background, 1);
    if (!this.reuseDepth) {
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      return;
    }
    // Over the prepass depth: everything the prepass drew tests against it without writing, pulled a hair toward the
    // camera so its own surface passes.
    renderer.clear(true, false, false);
    const saved = [];
    scene.traverseVisible((object) => {
      const m = object.material;
      if (!m?.isPipelineMaterial || m.transparent) return;
      saved.push(m, m.depthWrite, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits);
      m.depthWrite = false;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -4;
    });
    try {
      renderer.render(scene, camera);
    } finally {
      for (let i = 0; i < saved.length; i += 5) {
        const m = saved[i];
        m.depthWrite = saved[i + 1];
        m.polygonOffset = saved[i + 2];
        m.polygonOffsetFactor = saved[i + 3];
        m.polygonOffsetUnits = saved[i + 4];
      }
    }
  }

  _renderBloom(source) {
    const levels = this.bloomLevels;
    const down = this.downMaterial.uniforms;
    let input = source;
    let iw = this.width;
    let ih = this.height;
    levels.forEach((level, i) => {
      down.tInput.value = input;
      down.texel.value.set(1 / iw, 1 / ih);
      down.karis.value = i === 0 ? 1 : 0;
      this._pass(this.downMaterial, level.down);
      input = level.down.texture;
      iw = level.width;
      ih = level.height;
    });
    const up = this.upMaterial.uniforms;
    const radius = this.bloomRadius;
    let low = levels[levels.length - 1].down;
    let norm = 1;
    for (let i = levels.length - 2; i >= 0; i--) {
      const lowLevel = levels[i + 1];
      up.tLow.value = low.texture;
      up.tHigh.value = levels[i].down.texture;
      up.texel.value.set(1 / lowLevel.width, 1 / lowLevel.height);
      up.radius.value = radius;
      this._pass(this.upMaterial, levels[i].up);
      low = levels[i].up;
      norm = 1 + radius * norm;
    }
    this.bloomNorm = norm;
    return low.texture;
  }

  // time (seconds) drives the `time` uniform; defaults to the page clock.
  render(scene, camera, time = performance.now() / 1000) {
    const renderer = this.renderer;
    if (this.wireframe || this._wired.size) this._applyWireframe(scene);
    renderer.getDrawingBufferSize(_size);
    this._resize(_size.x, _size.y);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;
    const prevClearColor = renderer.getClearColor(new Color());
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.toneMapping = NoToneMapping;

    try {
      if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
      this._gatherScene(scene, this.hasPrevFrame ? time : globalUniforms.prevTime.value);
      if (!this.hasPrevFrame) {
        globalUniforms.time.value = time;
        this._storePrevious(camera);
        this.hasPrevFrame = true;
      }

      const debug = DEBUG_VIEWS.includes(this.debug) ? this.debug : "none";
      globalUniforms.pipelineDebug.value = MATERIAL_DEBUG[debug] ?? 0;
      globalUniforms.time.value = time;

      let hdr;
      const samples = Math.max(1, Math.round(this.samples));
      const dof = this.dof && this.dofEnabled && this.dof.active && camera.isPerspectiveCamera && debug === "none" ? this.dof : null;
      const settle = !dof && this.stillSamples > 0 && this.dof && camera.isPerspectiveCamera && debug === "none" && samples === 1;
      const still = (dof || settle ? this._isStill(camera, time) : false) && !this._moving;
      this._moving = false;
      if (!still) this.lensCount = 0;
      if (!still) (this._settleShown = null), (this._settleFade = false);
      const lensPath = still && ((dof && this.lensSamples > 0) || settle);
      this._lensDone = false;
      if (lensPath) this.taaHistory = false;
      if (lensPath) {
        hdr = this._renderLens(scene, camera, settle ? this.stillSamples : this.lensSamples, !settle);
      } else if (samples > 1) {
        _projection.copy(camera.projectionMatrix);
        const accum = this.accumMaterial.uniforms;
        renderer.setRenderTarget(this.accumTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        for (let i = 0; i < samples; i++) {
          const jx = (halton(i + 1, 2) - 0.5) * 2 / this.width;
          const jy = (halton(i + 1, 3) - 0.5) * 2 / this.height;
          this._setJitter(camera, jx, jy);
          this._renderFrame(scene, camera, i === 0);
          camera.projectionMatrix.copy(_projection);
          globalUniforms.jitter.value.set(0, 0);
          // Later sub-frames see no motion: same instant, only the jitter moves.
          if (i === 0) this._storePrevious(camera);
          accum.tInput.value = this.mainTarget.texture;
          accum.weight.value = 1 / samples;
          this._pass(this.accumMaterial, this.accumTarget);
        }
        this._updateCameraUniforms(camera);
        hdr = this.accumTarget.texture;
      } else if (this.temporal && debug === "none") {
        // A new sub-pixel offset each frame (Halton 2,3 over 16), resolved against the history.
        _projection.copy(camera.projectionMatrix);
        const k = (this.frame % 16) + 1;
        this._setJitter(camera, ((halton(k, 2) - 0.5) * 2) / this.width, ((halton(k, 3) - 0.5) * 2) / this.height);
        this._renderFrame(scene, camera);
        camera.projectionMatrix.copy(_projection);
        globalUniforms.jitter.value.set(0, 0);
        this._updateCameraUniforms(camera);
        const t = this.taaMaterial.uniforms;
        t.tCurrent.value = this.mainTarget.texture;
        t.tHistory.value = this.taaTargets[this.taaIndex].texture;
        t.resolution.value.set(this.width, this.height);
        t.feedback.value = this.temporalFeedback;
        t.clampGamma.value = this.temporalClamp;
        t.hasHistory.value = this.taaHistory ? 1 : 0;
        this.taaIndex = 1 - this.taaIndex;
        this._pass(this.taaMaterial, this.taaTargets[this.taaIndex]);
        this.taaHistory = true;
        hdr = this.taaTargets[this.taaIndex].texture;
      } else {
        globalUniforms.jitter.value.set(0, 0);
        this._renderFrame(scene, camera);
        hdr = this.mainTarget.texture;
      }
      if (!lensPath) {
        const motionOn = this.motionBlur && this.motionBlurAvailable && debug === "none";
        const reuse = motionOn && this.motionReusePrepass && samples === 1 && this._cameraUnmoved(camera);
        if (motionOn) this.tileMaxMaterial.uniforms.tVelocity.value = reuse ? this.prepassTarget.texture : this.motionTarget.texture;
        if (motionOn && !reuse) this._renderMotion(scene, camera);
        this._storePrevious(camera);
        if (motionOn) hdr = this._renderMotionBlur(hdr);
        // Opt-in hook for a day's own full-screen pass over the lit HDR image (e.g. ray-traced glass).
        if (this.composite && debug === "none") hdr = this.composite(hdr, { depthTexture: this.depthTexture, camera, width: this.width, height: this.height }) ?? hdr;
        if (dof) hdr = dof.gather(renderer, hdr, this.depthTexture, camera);
      }

      const bloomOn = this.bloom && this.bloomStrength > 0 && (debug === "none" || debug === "clipping");
      const f = this.finalMaterial.uniforms;
      f.tColor.value = hdr;
      // A converged still is the same image as last frame, so its bloom is too.
      const cache = this._bloomCache;
      const reuseBloom = bloomOn && this._lensDone && cache && cache.source === hdr && cache.radius === this.bloomRadius;
      if (bloomOn && !reuseBloom) this._bloomCache = { source: hdr, radius: this.bloomRadius, texture: this._renderBloom(hdr) };
      if (!bloomOn) this._bloomCache = null;
      f.tBloom.value = bloomOn ? this._bloomCache.texture : null;
      f.bloomStrength.value = bloomOn ? this.bloomStrength : 0;
      f.exposure.value = this.exposure;
      f.vignette.value = this.vignette;
      f.grain.value = this.grain;
      f.aberration.value = this.aberration;
      f.saturation.value = this.saturation;
      f.contrast.value = this.contrast;
      f.tonemapper.value = Math.max(0, TONEMAPPERS.indexOf(this.tonemapper));
      f.frame.value = this.frame;
      f.debugView.value = FINAL_DEBUG[debug] ?? (MATERIAL_DEBUG[debug] ? 4 : 0);
      f.clipWarning.value = this.clipWarning && debug === "none" ? 1 : 0;
      f.bloomScale.value = 1 / this.bloomNorm;

      if (this.msaa === 0 && !this.temporal) {
        this._pass(this.finalMaterial, this.ldrTarget);
        this._pass(this.fxaaMaterial, null);
      } else {
        this._pass(this.finalMaterial, null);
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.toneMapping = prevToneMapping;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
    }
  }

  // Fullscreen-pass programs, started in the constructor so they compile alongside the day's setup.
  _compilePasses() {
    const gi = this.gi;
    const materials = [this.copyMaterial, this.accumMaterial, this.downMaterial, this.upMaterial, this.finalMaterial, this.fxaaMaterial, this.taaMaterial];
    if (this.motionBlurAvailable) materials.push(this.tileMaxMaterial, this.neighborMaxMaterial, this.reconstructMaterial);
    if (this.dof) materials.push(...this.dof.materials);
    materials.push(gi.geometryMaterial, gi.traceMaterial, gi.temporalMaterial, gi.blurMaterial, gi.blurPairMaterial, gi.tileMaterial, gi.skipMaterial);
    const mask = this.shadowMask;
    if (mask) materials.push(mask.traceMaterial, mask.temporalMaterial, mask.blurMaterial);
    const scene = new Scene();
    for (const material of materials) {
      const mesh = new Mesh(this.quad.geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    return this.renderer.compileAsync(scene, this.quadCamera);
  }

  // Optional: builds the scene's programs (and their variants) without blocking, in parallel where
  // KHR_parallel_shader_compile is available. Await it before the first render to avoid a stall.
  async compileAsync(scene, camera) {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const jobs = [this._passesCompiled];
    try {
      // Programs depend on the target's colour space: every scene pass draws into a render target.
      renderer.setRenderTarget(this.mainTarget);
      scene.traverse((object) => object.material && this._syncShadowDefines(object));
      jobs.push(renderer.compileAsync(scene, camera));
      jobs.push(compileVariant(renderer, scene, camera, "prepass"));
      jobs.push(compileVariant(renderer, scene, this.shadow.camera, "shadow", this.shadow.filter));
      if (this.shadows && this.shadowDenoise && !this.shadowMask) {
        this.shadowMask = new ShadowMaskPass(this.gi, this.shadowMaskOptions);
        this._passesCompiled = this._compilePasses();
        jobs.push(this._passesCompiled);
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
    await Promise.all(jobs);
  }

  // Guspira section bound to the settings; none of it is randomizable.
  get wireframe() {
    return this._wireframe;
  }

  set wireframe(v) {
    this._wireframe = v;
    this._wireframeControl?.signal.set(v);
  }

  // Sets wireframe on the scene's pipeline materials and restores each one's own setting when turned off.
  _applyWireframe(scene) {
    if (!this.wireframe) {
      for (const [m, was] of this._wired) m.wireframe = was;
      this._wired.clear();
      return;
    }
    scene.traverse((o) => {
      const m = o.material;
      if (!o.isMesh || !m?.isPipelineMaterial || o.userData.noWireframe || this._wired.has(m)) return;
      this._wired.set(m, m.wireframe);
      m.wireframe = true;
    });
  }

  addGUI(gui, { title = "Rendering", open = false } = {}) {
    const u = globalUniforms;
    const opts = (onChange) => ({
      randomizable: false,
      onChange: (v) => {
        onChange(v);
        this.lensCount = 0;
      },
    });
    const section = gui.addSection(title, { open });
    // The tier is fixed when the pipeline is built, so picking another reloads the page; the url keeps the
    // seed and settings.
    const asked = new URLSearchParams(location.search).get("quality");
    const tiers = ["high", "medium", "low"];
    gui.addSelect("Quality (reloads)", tiers.includes(asked) ? asked : "auto", [["auto", `auto (${this.autoQuality})`], ...tiers], {
      randomizable: false,
      onChange: (q) => {
        const url = new URL(location.href);
        if (q === "auto") url.searchParams.delete("quality");
        else url.searchParams.set("quality", q);
        location.replace(url);
      },
    });
    const add = (label, get, set, min, max, step) => gui.addSlider(label, get(), min, max, step, opts(set));
    add("Exposure", () => this.exposure, (v) => (this.exposure = v), 0.1, 4, 0.01);
    gui.addSelect("Tonemapper", this.tonemapper, TONEMAPPERS, opts((v) => (this.tonemapper = v)));
    add("Environment", () => u.envIntensity.value, (v) => (u.envIntensity.value = v), 0, 3, 0.01);
    add("Bloom", () => this.bloomStrength, (v) => (this.bloomStrength = v), 0, 0.3, 0.001);
    add("Bloom radius", () => this.bloomRadius, (v) => (this.bloomRadius = v), 0, 1, 0.01);
    add("Vignette", () => this.vignette, (v) => (this.vignette = v), 0, 1, 0.01);
    add("Grain", () => this.grain, (v) => (this.grain = v), 0, 0.15, 0.001);
    add("Aberration", () => this.aberration, (v) => (this.aberration = v), 0, 1, 0.01);
    add("Saturation", () => this.saturation, (v) => (this.saturation = v), 0, 2, 0.01);
    add("Contrast", () => this.contrast, (v) => (this.contrast = v), 0.5, 1.5, 0.01);
    gui.addCheckbox("Shadows", this.shadows, opts((v) => (this.shadows = v)));
    gui.addCheckbox("Shadow denoise", this.shadowDenoise, opts((v) => (this.shadowDenoise = v)));
    add("Shadow softness", () => u.shadowSoftness.value, (v) => (u.shadowSoftness.value = v), 0, 4, 0.01);
    add("Light size", () => u.shadowLightSize.value, (v) => (u.shadowLightSize.value = v), 0, 0.6, 0.001);
    gui.addCheckbox("AO + GI", this.giEnabled, opts((v) => (this.giEnabled = v)));
    add("AO", () => u.aoIntensity.value, (v) => (u.aoIntensity.value = v), 0, 2, 0.01);
    add("AO power", () => u.aoPower.value, (v) => (u.aoPower.value = v), 0.5, 4, 0.01);
    add("GI", () => u.giIntensity.value, (v) => (u.giIntensity.value = v), 0, 4, 0.01);
    add("GI radius", () => this.gi.radius, (v) => (this.gi.radius = v), 0.05, 4, 0.01);
    if (this.motionBlurAvailable) {
      gui.addCheckbox("Motion blur", this.motionBlur, opts((v) => (this.motionBlur = v)));
      add("Shutter", () => this.shutter, (v) => (this.shutter = v), 0, 0.2, 0.001);
      add("Blur samples", () => this.motionSamples, (v) => (this.motionSamples = v), 2, 64, 1);
    }
    if (this.dof && this.dofRequested) {
      gui.addCheckbox("Depth of field", this.dofEnabled, opts((v) => (this.dofEnabled = v)));
      add("Lens samples", () => this.lensSamples, (v) => (this.lensSamples = v), 0, 1024, 1);
    }
    gui.addSelect("Debug", this.debug, DEBUG_VIEWS, opts((v) => (this.debug = v)));
    gui.addCheckbox("Clip warning", this.clipWarning, opts((v) => (this.clipWarning = v)));
    this._wireframeControl = gui.addCheckbox("Wireframe", this.wireframe, opts((v) => (this.wireframe = v)));
    gui.endSection();
    return section;
  }

  dispose() {
    for (const rt of [this.prepassTarget, this.mainTarget, this.prevColorTarget, this.accumTarget, this.ldrTarget]) {
      rt.dispose();
    }
    if (this.motionBlurAvailable) {
      for (const rt of [this.motionTarget, this.tileTarget, this.neighborTarget, this.blurTarget]) rt.dispose();
      for (const m of [this.tileMaxMaterial, this.neighborMaxMaterial, this.reconstructMaterial]) m.dispose();
    }
    for (const level of this.bloomLevels) {
      level.down.dispose();
      level.up.dispose();
    }
    this.depthTexture.dispose();
    for (const m of [this.copyMaterial, this.accumMaterial, this.downMaterial, this.upMaterial, this.finalMaterial, this.fxaaMaterial, this.taaMaterial]) {
      m.dispose();
    }
    for (const rt of this.taaTargets) rt.dispose();
    this.quad.geometry.dispose();
    this.shadow.dispose();
    this.shadowMask?.dispose();
    this.dof?.dispose();
    this._settleFrom?.dispose();
    this.gi.dispose();
  }
}

export { Pipeline, TIERS };
