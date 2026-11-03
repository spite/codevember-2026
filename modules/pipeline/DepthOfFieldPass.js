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
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Vector2,
} from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import {
  dofPrefilterFragment,
  dofTileFragment,
  dofDilateFragment,
  dofGatherFragment,
  dofCompositeFragment,
  dofAccumulateFragment,
} from "shaders/pipeline/dof.js";

function target(filter = NearestFilter) {
  return new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

function material(fragmentShader, uniforms) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

// Tiles are 16 full-res pixels (8 half-res texels) square.
const TILE = 8;

// Thin-lens depth of field. `gather` blurs one frame by depth; `accumulate` averages frames rendered
// from points across the lens (see lensSample) into the exact result.
class DepthOfFieldPass {
  constructor({ focus = 5, aperture = 0, maxBlur = 0.04, density = 0.6, maxSamples = 64 } = {}) {
    // Distance to the plane in focus, in world units.
    this.focus = focus;
    // Blur radius of something infinitely far, as a fraction of the image height.
    this.aperture = aperture;
    // The gather's largest blur radius, as a fraction of the height.
    this.maxBlur = maxBlur;
    this.density = density;
    this.maxSamples = maxSamples;
    this.width = 0;
    this.height = 0;

    this.halfTarget = target(LinearFilter);
    this.tileTarget = target();
    this.reachTarget = target();
    this.gatherTarget = target(LinearFilter);
    this.outputTarget = target(LinearFilter);
    this.blendTarget = target(LinearFilter);
    this.lensTargets = [target(LinearFilter), target(LinearFilter)];
    this.lensIndex = 0;

    const lens = () => ({ cameraNear: { value: 0.1 }, cameraFar: { value: 100 }, focus: { value: 5 }, aperture: { value: 0 }, maxCoc: { value: 1 } });
    this.lensUniforms = [];
    const withLens = (uniforms) => {
      const l = lens();
      this.lensUniforms.push(l);
      return { ...l, ...uniforms };
    };
    this.prefilterMaterial = material(dofPrefilterFragment, withLens({ tColor: { value: null }, tDepth: { value: null } }));
    this.tileMaterial = material(dofTileFragment, { tHalf: { value: this.halfTarget.texture }, tile: { value: TILE } });
    this.dilateMaterial = material(dofDilateFragment, { tTiles: { value: this.tileTarget.texture }, reach: { value: 1 } });
    this.gatherMaterial = material(dofGatherFragment, {
      tHalf: { value: this.halfTarget.texture },
      tReach: { value: this.reachTarget.texture },
      resolution: { value: new Vector2() },
      tile: { value: TILE },
      maxSamples: { value: maxSamples },
      density: { value: density },
    });
    this.compositeMaterial = material(dofCompositeFragment, withLens({ tColor: { value: null }, tDepth: { value: null }, tBlur: { value: this.gatherTarget.texture } }));
    this.accumulateMaterial = material(dofAccumulateFragment, { tPrev: { value: null }, tCurrent: { value: null }, weight: { value: 1 } });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry);
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get materials() {
    return [this.prefilterMaterial, this.tileMaterial, this.dilateMaterial, this.gatherMaterial, this.compositeMaterial, this.accumulateMaterial];
  }

  get active() {
    return this.aperture > 0;
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    this.halfTarget.setSize(hw, hh);
    this.gatherTarget.setSize(hw, hh);
    this.tileTarget.setSize(Math.ceil(hw / TILE), Math.ceil(hh / TILE));
    this.reachTarget.setSize(Math.ceil(hw / TILE), Math.ceil(hh / TILE));
    this.outputTarget.setSize(w, h);
    this.blendTarget.setSize(w, h);
    for (const t of this.lensTargets) t.setSize(w, h);
    this.gatherMaterial.uniforms.resolution.value.set(w, h);
  }

  _pass(renderer, material, target) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  _apertureInPixels() {
    return this.aperture * this.height;
  }

  // Blurs one frame by its depth.
  gather(renderer, hdr, depthTexture, camera) {
    const aperturePx = this._apertureInPixels();
    const maxCoc = Math.max(1, Math.min(aperturePx, this.maxBlur * this.height));
    for (const u of this.lensUniforms) {
      u.cameraNear.value = camera.near;
      u.cameraFar.value = camera.far;
      u.focus.value = this.focus;
      u.aperture.value = aperturePx;
      u.maxCoc.value = maxCoc;
    }
    this.dilateMaterial.uniforms.reach.value = Math.min(4, Math.ceil(maxCoc / (TILE * 2)));
    this.gatherMaterial.uniforms.maxSamples.value = this.maxSamples;
    this.gatherMaterial.uniforms.density.value = this.density;
    const p = this.prefilterMaterial.uniforms;
    p.tColor.value = hdr;
    p.tDepth.value = depthTexture;
    this._pass(renderer, this.prefilterMaterial, this.halfTarget);
    this._pass(renderer, this.tileMaterial, this.tileTarget);
    this._pass(renderer, this.dilateMaterial, this.reachTarget);
    this._pass(renderer, this.gatherMaterial, this.gatherTarget);
    const c = this.compositeMaterial.uniforms;
    c.tColor.value = hdr;
    c.tDepth.value = depthTexture;
    this._pass(renderer, this.compositeMaterial, this.outputTarget);
    return this.outputTarget.texture;
  }

  // Where on the lens sample `index` (from 1) looks from, as a camera-space offset (x, y), and the
  // projection shift (in NDC) that keeps the focus plane fixed, plus a sub-pixel jitter.
  lensSample(index, camera, out) {
    const a = 2 * Math.PI * halton(index, 3);
    const r = Math.sqrt(halton(index, 2));
    const e = camera.projectionMatrix.elements;
    // A pixel's blur is fPx * A * (1/focus - 1/z), so a lens of radius A blurs infinity by fPx * A / focus.
    const fPx = (e[5] * this.height) / 2;
    const A = (this._apertureInPixels() * this.focus) / fPx;
    out.x = Math.cos(a) * r * A;
    out.y = Math.sin(a) * r * A;
    out.jx = (e[0] * out.x) / this.focus + ((halton(index, 5) - 0.5) * 2) / this.width;
    out.jy = (e[5] * out.y) / this.focus + ((halton(index, 7) - 0.5) * 2) / this.height;
    return out;
  }

  // Folds frame n (from 1) into the running mean and returns it.
  accumulate(renderer, texture, n) {
    const prev = this.lensTargets[this.lensIndex];
    this.lensIndex = 1 - this.lensIndex;
    const next = this.lensTargets[this.lensIndex];
    const u = this.accumulateMaterial.uniforms;
    u.tPrev.value = prev.texture;
    u.tCurrent.value = texture;
    u.weight.value = 1 / n;
    this._pass(renderer, this.accumulateMaterial, next);
    return next.texture;
  }

  get lensResult() {
    return this.lensTargets[this.lensIndex].texture;
  }

  // Crossfade from the gathered frame to the lens mean.
  blend(renderer, from, to, t) {
    const u = this.accumulateMaterial.uniforms;
    u.tPrev.value = from;
    u.tCurrent.value = to;
    u.weight.value = t;
    this._pass(renderer, this.accumulateMaterial, this.blendTarget);
    return this.blendTarget.texture;
  }

  dispose() {
    for (const t of [this.halfTarget, this.tileTarget, this.reachTarget, this.gatherTarget, this.outputTarget, this.blendTarget, ...this.lensTargets]) t.dispose();
    for (const m of this.materials) m.dispose();
    this.quad.geometry.dispose();
  }
}

function halton(index, base) {
  let f = 1, r = 0;
  while (index > 0) {
    f /= base;
    r += f * (index % base);
    index = Math.floor(index / base);
  }
  return r;
}

export { DepthOfFieldPass };
