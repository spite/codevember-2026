// The day's own renderer: caustics, the sun's shadow map, the scene into a multisampled HDR target, the far scene's
// scattering blur and the light shafts, then the shared pipeline's bloom and final pass (exposure, AgX, vignette, grain,
// dither).
import {
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  RawShaderMaterial,
  GLSL3,
  WebGLRenderTarget,
  DepthTexture,
  FloatType,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  NoToneMapping,
  Vector2,
  Vector3,
  Color,
} from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { bloomDownFragment, bloomUpFragment } from "shaders/pipeline/bloom.js";
import { finalFragment } from "shaders/pipeline/final.js";
import { Caustics, waterUniforms, SURFACE_Y } from "./water.js";
import { SunShadow } from "./shadow.js";
import { Shafts } from "./shafts.js";
import { setupKelpMaterials } from "./shaders.js";

export const TIERS = {
  high: { msaa: 4, shadowSize: 2048, shaftSteps: 36, shaftScale: 0.5, causticSize: 512, causticGrid: 192, soften: true },
  medium: { msaa: 2, shadowSize: 1536, shaftSteps: 20, shaftScale: 0.5, causticSize: 512, causticGrid: 128, soften: true },
  low: { msaa: 0, shadowSize: 1024, shaftSteps: 14, shaftScale: 0.35, causticSize: 256, causticGrid: 96, soften: false },
  // Recordings (?capture).
  capture: { msaa: 4, shadowSize: 4096, shaftSteps: 64, shaftScale: 0.75, causticSize: 1024, causticGrid: 256, soften: true },
};

function colorTarget(options = {}) {
  return new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    generateMipmaps: false,
    ...options,
  });
}

function quadMaterial(fragmentShader, uniforms) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

// How far the eye sees at uv: to the first thing hit or the surface, at most uMaxDistance.
const rayLengthGLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraWorld;
uniform vec3 cameraPosition;
uniform float uSurfaceY;
uniform float uMaxDistance;

float rayLength(vec2 uv) {
  float d = textureLod(tDepth, uv, 0.0).r;
  vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 viewPos = v.xyz / v.w;
  vec3 rd = normalize(mat3(uCameraWorld) * viewPos);
  float dist = d >= 1.0 ? 1e4 : length(viewPos);
  float surface = rd.y > 1e-4 ? max(uSurfaceY - cameraPosition.y, 0.0) / rd.y : 400.0;
  return min(min(dist, surface), uMaxDistance);
}
`;

// Small-angle scattering softens what's far: the scene at half resolution with its ray lengths, then blurred, leaving
// out what's nearer than about 7 m so the sharp near kelp doesn't bleed into the far forest.
const softDownFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
${rayLengthGLSL}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  // Glints and the sun's disc held to about white, so the blur doesn't spread them into blobs; nothing infinite (by the
  // exponent bits: compilers may drop isnan).
  vec3 c = textureLod(tColor, vUv, 0.0).rgb;
  bvec3 bad = equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u));
  c = any(bad) ? vec3(0.0) : clamp(c, 0.0, 4.0);
  outColor = vec4(c, rayLength(vUv));
}
`;

const softBlurFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uStep;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 c = textureLod(tInput, vUv, 0.0);
  float wc = smoothstep(5.0, 9.0, c.a) + 1e-4;
  vec3 sum = c.rgb * wc;
  float wsum = wc;
  for (int i = 1; i <= 6; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec4 t = textureLod(tInput, vUv + uStep * float(i * s), 0.0);
      float w = exp(-float(i * i) / 14.0) * smoothstep(5.0, 9.0, t.a);
      sum += t.rgb * w;
      wsum += w;
    }
  }
  outColor = vec4(sum / wsum, c.a);
}
`;

// Mixes in the blurred scene with distance, adds the shafts (and the forest's shade on the water's glow), both upsampled
// with the ray lengths as a guide, then warms the highlights. Where none of the low-resolution rays ends near this
// pixel's (thin things in front of the water), the shafts take their scattering per metre times its own length.
const compositeFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tShafts;
uniform sampler2D tSoft;
uniform vec2 uShaftSize;
uniform vec2 uSoftSize;
uniform float uSoften;
uniform vec3 uBalance;
uniform vec3 uHighlight;
uniform vec3 uVeil;
uniform vec3 uSunDir;
${rayLengthGLSL}
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 col = textureLod(tColor, vUv, 0.0).rgb;
  float z = rayLength(vUv);
  if (uSoften > 0.0) {
    vec2 q = vUv * uSoftSize - 0.5;
    vec2 fq = fract(q);
    vec2 bq = (floor(q) + 0.5) / uSoftSize;
    vec3 soft = vec3(0.0);
    float ws = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec4 s = textureLod(tSoft, bq + vec2(i, j) / uSoftSize, 0.0);
        float w = (i == 0 ? 1.0 - fq.x : fq.x) * (j == 0 ? 1.0 - fq.y : fq.y) * exp(-abs(s.a - z) / (0.1 * z + 0.5)) + 1e-5;
        soft += s.rgb * w;
        ws += w;
      }
    }
    col = mix(col, soft / ws, uSoften * smoothstep(6.0, 30.0, z));
  }
  vec2 p = vUv * uShaftSize - 0.5;
  vec2 f = fract(p);
  vec2 base = (floor(p) + 0.5) / uShaftSize;
  vec3 matched = vec3(0.0), rate = vec3(0.0);
  float wMatched = 0.0, wRate = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec4 s = textureLod(tShafts, base + vec2(i, j) / uShaftSize, 0.0);
      float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-4;
      float wd = w * exp(-abs(s.a - z) / (0.03 * z + 0.05));
      matched += s.rgb * wd;
      wMatched += wd;
      rate += s.rgb / max(s.a, 0.5) * w;
      wRate += w;
    }
  }
  vec3 shafts = mix(rate / wRate * z, matched / max(wMatched, 1e-6), smoothstep(0.02, 0.2, wMatched));
  // The lens's veiling glare: a trace of the water's light over everything, so the deepest shade keeps a little colour.
  vec3 c = max(col + shafts, 0.0) + uVeil;
  // The highlights warm, as the sun's own colour does through little water: the glowing kelp, and most of all the sun and
  // its haze, go cream while the dark water stays cyan.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 rd = normalize(mat3(uCameraWorld) * (uProjectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0)).xyz);
  float warm = smoothstep(0.12, 1.2, l) * mix(0.3, 1.0, smoothstep(0.6, 0.97, dot(rd, uSunDir)));
  outColor = vec4(c * uBalance * mix(vec3(1.0), uHighlight, warm), 1.0);
}
`;

export class UnderwaterRenderer {
  constructor(renderer, { quality = "high" } = {}) {
    this.renderer = renderer;
    this.quality = quality;
    const tier = TIERS[quality];
    this.tier = tier;
    this.msaa = Math.min(tier.msaa, renderer.capabilities.maxSamples);
    setupKelpMaterials(renderer, { msaa: this.msaa > 0 });
    this.exposure = 1;
    // The panel's exposure; the day scales it with the view.
    this.baseExposure = 0.8;
    // Depth (m) at which the exposure is as set, the opening view's.
    this.meterDepth = 22.1;
    this.bloomStrength = 0.08;
    this.bloomRadius = 0.7;
    this.vignette = 0.4;
    this.grain = 0.03;
    this.shafts = 1.8;
    this.shaftsEnabled = true;
    // How much of the far scene is seen through the scattering blur, at 30 m and beyond.
    this.soften = tier.soften ? 0.8 : 0;
    this.frame = 0;

    this.caustics = new Caustics({ size: tier.causticSize, grid: tier.causticGrid });
    this.shadow = new SunShadow({ size: tier.shadowSize });
    this.shaftPass = new Shafts({ steps: tier.shaftSteps, scale: tier.shaftScale });

    this.depthTexture = new DepthTexture(1, 1, FloatType);
    this.hdr = colorTarget({ depthBuffer: true, depthTexture: this.depthTexture, samples: this.msaa });
    this.composite = colorTarget();
    this.softDown = colorTarget();
    this.softH = colorTarget();
    this.softV = colorTarget();
    this.bloomLevels = [];

    const rayUniforms = {
      tDepth: { value: this.depthTexture },
      uProjectionInverse: this.shaftPass.common.uProjectionInverse,
      uCameraWorld: this.shaftPass.common.uCameraWorld,
      cameraPosition: this.shaftPass.common.cameraPosition,
      uSurfaceY: waterUniforms.uSurfaceY,
      uMaxDistance: this.shaftPass.marchMaterial.uniforms.uMaxDistance,
    };
    this.softDownMaterial = quadMaterial(softDownFragment, { tColor: { value: this.hdr.texture }, ...rayUniforms });
    this.softBlurMaterial = quadMaterial(softBlurFragment, { tInput: { value: null }, uStep: { value: new Vector2() } });
    this.compositeMaterial = quadMaterial(compositeFragment, {
      tColor: { value: this.hdr.texture },
      tShafts: { value: null },
      tSoft: { value: this.softV.texture },
      uShaftSize: { value: new Vector2(1, 1) },
      uSoftSize: { value: new Vector2(1, 1) },
      uSoften: { value: this.soften },
      ...rayUniforms,
      // The camera's white balance: a little warmer than the water.
      uBalance: { value: new Vector3(1.22, 1.0, 0.86) },
      uHighlight: { value: new Vector3(1.3, 1.0, 0.68) },
      uSunDir: waterUniforms.uSunDir,
      uVeil: { value: new Vector3(0.0035, 0.0045, 0.005) },
    });
    this.downMaterial = quadMaterial(bloomDownFragment, { tInput: { value: null }, texel: { value: new Vector2() }, karis: { value: 1 }, clampMax: { value: 64 } });
    this.upMaterial = quadMaterial(bloomUpFragment, { tLow: { value: null }, tHigh: { value: null }, texel: { value: new Vector2() }, radius: { value: 1 } });
    this.finalMaterial = quadMaterial(finalFragment, {
      tColor: { value: this.composite.texture },
      tBloom: { value: null },
      tNormalVelocity: { value: null },
      tDepth: { value: this.depthTexture },
      bloomStrength: { value: 0 },
      bloomScale: { value: 1 },
      exposure: { value: 1 },
      vignette: { value: 0 },
      grain: { value: 0 },
      aberration: { value: 0.05 },
      saturation: { value: 1.15 },
      contrast: { value: 1.05 },
      tonemapper: { value: 0 },
      frame: { value: 0 },
      debugView: { value: 0 },
      clipWarning: { value: 0 },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 100 },
      isOrtho: { value: 0 },
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry);
    this.quad.frustumCulled = false;
    this.quadScene = new Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new Vector2();
    this.width = this.height = 0;
    this._clear = new Color();
  }

  setSize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.hdr.setSize(width, height);
    this.composite.setSize(width, height);
    this.shaftPass.setSize(width, height);
    this.compositeMaterial.uniforms.uShaftSize.value.set(this.shaftPass.width, this.shaftPass.height);
    const sw = Math.max(1, Math.round(width / 2));
    const sh = Math.max(1, Math.round(height / 2));
    for (const t of [this.softDown, this.softH, this.softV]) t.setSize(sw, sh);
    this.compositeMaterial.uniforms.uSoftSize.value.set(sw, sh);
    for (const level of this.bloomLevels) {
      level.down.dispose();
      level.up.dispose();
    }
    this.bloomLevels = [];
    let w = width;
    let h = height;
    for (let i = 0; i < 7; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      const down = colorTarget();
      const up = colorTarget();
      down.setSize(w, h);
      up.setSize(w, h);
      this.bloomLevels.push({ down, up, width: w, height: h });
      if (Math.min(w, h) <= 8) break;
    }
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  renderBloom(source) {
    const levels = this.bloomLevels;
    const down = this.downMaterial.uniforms;
    let input = source;
    let iw = this.width;
    let ih = this.height;
    levels.forEach((level, i) => {
      down.tInput.value = input;
      down.texel.value.set(1 / iw, 1 / ih);
      down.karis.value = i === 0 ? 1 : 0;
      this.pass(this.downMaterial, level.down);
      input = level.down.texture;
      iw = level.width;
      ih = level.height;
    });
    const up = this.upMaterial.uniforms;
    let low = levels[levels.length - 1].down;
    let norm = 1;
    for (let i = levels.length - 2; i >= 0; i--) {
      up.tLow.value = low.texture;
      up.tHigh.value = levels[i].down.texture;
      up.texel.value.set(1 / levels[i + 1].width, 1 / levels[i + 1].height);
      up.radius.value = this.bloomRadius;
      this.pass(this.upMaterial, levels[i].up);
      low = levels[i].up;
      norm = 1 + this.bloomRadius * norm;
    }
    return { texture: low.texture, norm };
  }

  // scene: what the eye sees; shadowScene: the casters' shadow stand-ins; depthScene: what to lay down depth for first.
  render(scene, shadowScene, camera, time, depthScene = null) {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(this.size);
    this.setSize(this.size.x, this.size.y);
    const toneMapping = renderer.toneMapping;
    const autoClear = renderer.autoClear;
    renderer.getClearColor(this._clear);
    const clearAlpha = renderer.getClearAlpha();
    renderer.toneMapping = NoToneMapping;
    this.frame++;
    waterUniforms.uWaterTime.value = time;

    this.caustics.update(renderer, time);
    this.shadow.render(renderer, shadowScene);

    renderer.setRenderTarget(this.hdr);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.autoClear = false;
    if (depthScene) renderer.render(depthScene, camera);
    renderer.render(scene, camera);

    const shafts = this.shaftPass.render(renderer, { depthTexture: this.depthTexture, camera, frame: this.frame, strength: this.shaftsEnabled ? this.shafts : 0 });
    if (this.soften > 0) {
      this.pass(this.softDownMaterial, this.softDown);
      // The blur spans an angle, so its reach in pixels grows with the image.
      const reach = Math.max(1, this.height / 720);
      const b = this.softBlurMaterial.uniforms;
      b.tInput.value = this.softDown.texture;
      b.uStep.value.set(reach / this.softDown.width, 0);
      this.pass(this.softBlurMaterial, this.softH);
      b.tInput.value = this.softH.texture;
      b.uStep.value.set(0, reach / this.softDown.height);
      this.pass(this.softBlurMaterial, this.softV);
    }
    const c = this.compositeMaterial.uniforms;
    c.tShafts.value = shafts;
    c.uSoften.value = this.soften;
    this.pass(this.compositeMaterial, this.composite);

    const bloom = this.bloomStrength > 0 ? this.renderBloom(this.composite.texture) : null;
    const f = this.finalMaterial.uniforms;
    f.tBloom.value = bloom?.texture ?? null;
    f.bloomStrength.value = bloom ? this.bloomStrength : 0;
    f.bloomScale.value = bloom ? 1 / bloom.norm : 1;
    // Shallower, the camera stops down as the light grows, as its metering would.
    const depth = Math.max(0, SURFACE_Y - camera.position.y);
    const falloff = waterUniforms.uSigmaLight.value.y / waterUniforms.uSunDir.value.y;
    f.exposure.value = this.exposure * Math.exp(-falloff * (this.meterDepth - depth));
    f.vignette.value = this.vignette;
    f.grain.value = this.grain;
    f.frame.value = this.frame;
    // Debug views go out untonemapped.
    f.debugView.value = waterUniforms.uDebug.value > 0 ? 4 : 0;
    f.cameraNear.value = camera.near;
    f.cameraFar.value = camera.far;
    this.pass(this.finalMaterial, null);

    renderer.toneMapping = toneMapping;
    renderer.autoClear = autoClear;
    renderer.setClearColor(this._clear, clearAlpha);
  }

  // Programs for the passes, compiled alongside the scene's.
  compileAsync(scene, shadowScene, camera, depthScene = null) {
    const renderer = this.renderer;
    const passes = new Scene();
    for (const material of [this.compositeMaterial, this.softDownMaterial, this.softBlurMaterial, this.downMaterial, this.upMaterial, this.finalMaterial, ...this.shaftPass.materials, this.caustics.material]) {
      const mesh = new Mesh(this.quad.geometry, material);
      mesh.frustumCulled = false;
      passes.add(mesh);
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.hdr);
    const jobs = [renderer.compileAsync(scene, camera), renderer.compileAsync(shadowScene, this.shadow.camera), renderer.compileAsync(passes, this.quadCamera)];
    if (depthScene) jobs.push(renderer.compileAsync(depthScene, camera));
    renderer.setRenderTarget(previous);
    return Promise.all(jobs);
  }

  // Sliders into the panel's current section.
  addGUI(gui) {
    const opts = { randomizable: false };
    const add = (label, get, set, min, max, step) => {
      const ctl = gui.addSlider(label, get(), min, max, step, { ...opts, onChange: set });
      return ctl;
    };
    add("Exposure", () => this.baseExposure, (v) => (this.baseExposure = v), 0.1, 4, 0.01);
    add("Light shafts", () => this.shafts, (v) => (this.shafts = v), 0, 3, 0.01);
    add("Caustics", () => waterUniforms.uCaustics.value, (v) => (waterUniforms.uCaustics.value = v), 0, 2, 0.01);
    add("Bloom", () => this.bloomStrength, (v) => (this.bloomStrength = v), 0, 0.3, 0.001);
    add("Far blur", () => this.soften, (v) => (this.soften = v), 0, 1, 0.01);
    add("Vignette", () => this.vignette, (v) => (this.vignette = v), 0, 1, 0.01);
    add("Grain", () => this.grain, (v) => (this.grain = v), 0, 0.15, 0.001);
    gui.addSelect("Debug view", "none", ["none", "shadow", "caustics", "light"], {
      ...opts,
      onChange: (v) => (waterUniforms.uDebug.value = ["none", "shadow", "caustics", "light"].indexOf(v)),
    });
  }
}
