import {
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  DataTexture,
  FloatType,
  RGBAFormat,
  UnsignedByteType,
  NearestFilter,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  PlaneGeometry,
  Scene,
  OrthographicCamera,
  RedFormat,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
} from "three";
import { shader as simplexNoise3D } from "shaders/perlinSimplex3D.js";
import { LAVA_GLSL } from "./lava.js";

// How bright the lava under each point of the air is right now, relative to its average: the same flowing noise
// the rock's surface shows, evaluated at the nearest surface point with the flow carried there. The glow and the
// light the lava spills on the rock multiply their (static) heat by it, so they pulse and drift with the flow.
const PULSE_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform float uLayer;
uniform float uSize;
uniform float uBound;
uniform sampler3D uFlowVolume;
uniform sampler3D uSdf;
uniform sampler2D uNoiseMap;
uniform float uFlowTime;
uniform float uScale;
uniform vec3 uSeedOffset;
uniform float uNeutral;

${simplexNoise3D}
${LAVA_GLSL}

float sdfAt(vec3 p) {
  return texture(uSdf, clamp(p / (2.0 * uBound) + 0.5, 0.0, 1.0)).r;
}

void main() {
  vec3 q = vec3(vUv, (uLayer + 0.5) / uSize);
  vec4 flow = texture(uFlowVolume, q);
  if (flow.w < 0.0 || uNeutral > 0.999) {
    outColor = vec4(1.0);
    return;
  }
  vec3 p = (q * 2.0 - 1.0) * uBound;
  float h = 0.04;
  vec3 g = vec3(
    sdfAt(p + vec3(h, 0.0, 0.0)) - sdfAt(p - vec3(h, 0.0, 0.0)),
    sdfAt(p + vec3(0.0, h, 0.0)) - sdfAt(p - vec3(0.0, h, 0.0)),
    sdfAt(p + vec3(0.0, 0.0, h)) - sdfAt(p - vec3(0.0, 0.0, h))
  );
  vec3 n = length(g) > 1e-5 ? normalize(g) : normalize(p + 1e-4);
  vec3 surface = p - n * sdfAt(p);
  vec2 lava = sampleFlowingNoise(uNoiseMap, surface, flow.xyz, n, uFlowTime, clamp(flow.w, 0.0, 1.0), uScale, uSeedOffset);
  // The molten surface's brightness factor (liquidMod and its cooling skin), over its mean around the rock (~0.32)
  float pulse = mix(0.28, 1.38, lava.x) * (1.0 - skinOf(lava.x) * 0.55) / 0.32;
  outColor = vec4(mix(pulse, 1.0, uNeutral));
}
`;

// The pulse at a set of points (the ember emitters), packed into bytes for a cheap readback
const PROBE_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uPoints;
uniform sampler3D uPulse;
uniform float uBound;
void main() {
  vec3 p = texelFetch(uPoints, ivec2(gl_FragCoord.xy), 0).xyz;
  float v = texture(uPulse, clamp(p / (2.0 * uBound) + 0.5, 0.0, 1.0)).r;
  outColor = vec4(clamp(v / 3.0, 0.0, 1.0));
}
`;

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

class LavaPulseVolume {
  // shared: the rock material's uniforms (noise map, flow time, scale, seed offset, neutral), read live
  constructor(renderer, { size, bound, flowVolume, shared }) {
    this.renderer = renderer;
    this.size = size;
    this.target = new WebGL3DRenderTarget(size, size, size, {
      format: RedFormat,
      type: HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const tex = this.target.texture;
    tex.minFilter = tex.magFilter = LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: PULSE_FS,
      uniforms: {
        uLayer: { value: 0 },
        uSize: { value: size },
        uBound: { value: bound },
        uFlowVolume: { value: flowVolume },
        uSdf: { value: null },
        uNoiseMap: shared.uNoiseMap,
        uFlowTime: shared.uFlowTime,
        uScale: shared.uScale,
        uSeedOffset: shared.uSeedOffset,
        uNeutral: shared.uNeutral,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new Scene();
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.material));
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // Points: Float32Array with a position every `stride` floats (object space). Returns the pulse at each,
  // refreshed by probe(); a stall of a few hundred bytes, so call it a few times a second at most.
  setProbePoints(points, stride) {
    const count = points.length / stride;
    const w = 64;
    const h = Math.max(1, Math.ceil(count / w));
    const data = new Float32Array(w * h * 4);
    for (let i = 0; i < count; i++) data.set([points[i * stride], points[i * stride + 1], points[i * stride + 2], 1], i * 4);
    this.probeTex?.dispose();
    this.probeTex = new DataTexture(data, w, h, RGBAFormat, FloatType);
    this.probeTex.minFilter = this.probeTex.magFilter = NearestFilter;
    this.probeTex.needsUpdate = true;
    if (!this.probeRT || this.probeRT.height !== h) {
      this.probeRT?.dispose();
      this.probeRT = new WebGLRenderTarget(w, h, { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false });
      this.probeBytes = new Uint8Array(w * h * 4);
    }
    this.probeCount = count;
    this.probeValues = new Float32Array(count).fill(1);
    if (!this.probeMaterial) {
      this.probeMaterial = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: QUAD_VS,
        fragmentShader: PROBE_FS,
        uniforms: { uPoints: { value: null }, uPulse: { value: this.target.texture }, uBound: { value: this.material.uniforms.uBound.value } },
        depthTest: false,
        depthWrite: false,
      });
      this.probeScene = new Scene();
      this.probeScene.add(new Mesh(new PlaneGeometry(2, 2), this.probeMaterial));
    }
    this.probeMaterial.uniforms.uPoints.value = this.probeTex;
    return this.probeValues;
  }

  // Asynchronous readback: the values land a few frames later, without waiting for the GPU
  probe() {
    if (!this.probeCount || this.probePending) return null;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.probeRT);
    this.renderer.render(this.probeScene, this.camera);
    this.renderer.setRenderTarget(prev);
    const values = this.probeValues, bytes = this.probeBytes, count = this.probeCount;
    this.probePending = true;
    this.renderer.readRenderTargetPixelsAsync(this.probeRT, 0, 0, this.probeRT.width, this.probeRT.height, bytes).then(
      () => {
        this.probePending = false;
        if (values !== this.probeValues) return;
        for (let i = 0; i < count; i++) values[i] = (bytes[i * 4] / 255) * 3;
      },
      () => (this.probePending = false),
    );
    return this.probeValues;
  }

  get texture() {
    return this.target.texture;
  }

  update(sdfTexture) {
    const u = this.material.uniforms;
    u.uSdf.value = sdfTexture;
    // Skipped when nothing it reads has changed (paused, or all neutral)
    const flow = u.uFlowVolume.value;
    const neutral = u.uNeutral.value > 0.999;
    const base = neutral ? `n|${flow.version}` : `${sdfTexture.id}|${sdfTexture.version}|${flow.version}`;
    const key = neutral ? base : `${base}|${u.uFlowTime.value}|${u.uScale.value}|${u.uSeedOffset.value.toArray()}|${u.uNeutral.value}`;
    // While only the flow moves on, half the layers per frame (alternating): a frame's lag doesn't show.
    // Once it stops, the other half catches up.
    let half = base === this.lastBase && !neutral;
    if (key === this.lastKey) {
      if (!this.behind) return;
      half = true;
    }
    this.behind = half && key !== this.lastKey;
    this.lastKey = key;
    this.lastBase = base;
    this.parity = half ? 1 - (this.parity ?? 0) : 0;
    const prev = this.renderer.getRenderTarget();
    for (let layer = half ? this.parity : 0; layer < this.size; layer += half ? 2 : 1) {
      this.material.uniforms.uLayer.value = layer;
      this.renderer.setRenderTarget(this.target, layer);
      this.renderer.render(this.scene, this.camera);
    }
    this.renderer.setRenderTarget(prev);
  }
}

export { LavaPulseVolume };
