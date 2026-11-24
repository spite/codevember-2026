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
  Vector2,
  Vector3,
  RedFormat,
} from "three";
import { MORPH_GLSL } from "./lava.js";

const PLUME_N = 48;
const PLUME_COLS = 8;
const PLUME_ROWS = 6;

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Pass 1: Extract only warm fiery HDR lava & embers (rejects cool/neutral specular highlights on basalt)
const EXTRACT_LAVA_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uHdr;
uniform vec2 uTexel;

vec3 pickFiery(vec2 uv) {
  vec3 c = texture(uHdr, uv).rgb;
  float warmth = clamp((c.r - c.b * 1.3) / max(c.r + 0.12, 0.12), 0.0, 1.0);
  float hot = max(0.0, c.r - 0.3);
  vec3 fiery = vec3(hot, max(0.0, c.g - 0.06) * 0.85, max(0.0, c.b - 0.03) * 0.12);
  // Soft knee keeps bright cores from blowing out while preserving rich orange-red scatter
  fiery = fiery / (1.0 + fiery * 0.18);
  return fiery * warmth;
}

void main() {
  vec2 d = uTexel * 0.5;
  vec3 c =
    pickFiery(vUv + vec2(-d.x, -d.y)) +
    pickFiery(vUv + vec2( d.x, -d.y)) +
    pickFiery(vUv + vec2(-d.x,  d.y)) +
    pickFiery(vUv + vec2( d.x,  d.y));
  outColor = vec4(c * 0.25, 1.0);
}
`;

// Smooth 13-tap energy-preserving downsample (zero ringing, zero streaks)
const DOWN_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + vec2(-2.0 * t.x,  2.0 * t.y)).rgb;
  vec3 b = texture(uSrc, vUv + vec2( 0.0,        2.0 * t.y)).rgb;
  vec3 c = texture(uSrc, vUv + vec2( 2.0 * t.x,  2.0 * t.y)).rgb;
  vec3 d = texture(uSrc, vUv + vec2(-2.0 * t.x,  0.0      )).rgb;
  vec3 e = texture(uSrc, vUv                               ).rgb;
  vec3 f = texture(uSrc, vUv + vec2( 2.0 * t.x,  0.0      )).rgb;
  vec3 g = texture(uSrc, vUv + vec2(-2.0 * t.x, -2.0 * t.y)).rgb;
  vec3 h = texture(uSrc, vUv + vec2( 0.0,       -2.0 * t.y)).rgb;
  vec3 i = texture(uSrc, vUv + vec2( 2.0 * t.x, -2.0 * t.y)).rgb;
  vec3 j = texture(uSrc, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 k = texture(uSrc, vUv + vec2( t.x,  t.y)).rgb;
  vec3 l = texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 m = texture(uSrc, vUv + vec2( t.x, -t.y)).rgb;
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  outColor = vec4(col, 1.0);
}
`;

// Smooth 9-tap tent upsample combining current mip + broader scattered mip
const UP_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uLow;
uniform sampler2D uHigh;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 low =
    texture(uLow, vUv + vec2(-t.x,  t.y)).rgb * 1.0 +
    texture(uLow, vUv + vec2( 0.0,  t.y)).rgb * 2.0 +
    texture(uLow, vUv + vec2( t.x,  t.y)).rgb * 1.0 +
    texture(uLow, vUv + vec2(-t.x,  0.0)).rgb * 2.0 +
    texture(uLow, vUv                  ).rgb * 4.0 +
    texture(uLow, vUv + vec2( t.x,  0.0)).rgb * 2.0 +
    texture(uLow, vUv + vec2(-t.x, -t.y)).rgb * 1.0 +
    texture(uLow, vUv + vec2( 0.0, -t.y)).rgb * 2.0 +
    texture(uLow, vUv + vec2( t.x, -t.y)).rgb * 1.0;
  low /= 16.0;
  vec3 high = texture(uHigh, vUv).rgb;
  outColor = vec4(high * 0.55 + low * uWeight, 1.0);
}
`;

// True 3D isotropic caldera haze shell (depth-occluded against scene depthTexture, ZERO radial crack lookup!)
const VOLUMETRIC_HAZE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform float uRockDist;

float viewDistAt(vec2 uv) {
  float d = texture(uDepth, uv).r;
  if (d >= 0.9999) return 1e9;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return length(v.xyz / v.w);
}
uniform mat4 uInvView;
uniform mat4 uInvModel;
uniform vec3 uCamLocal;

uniform float uFalloff;
uniform float uTime;
uniform float uHeat;
uniform highp sampler3D uHeatVolume;
uniform highp sampler3D uPulseVolume;
uniform vec3 uLocalUp;
uniform vec2 uEdgeRadius;
uniform float uSurfaceWeight;
uniform float uShellWeight;
// A uniform bound keeps the Direct3D compiler from unrolling the march
uniform int uSteps;

${MORPH_GLSL}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The rising heat (PLUME_FS), baked on the heat volume's grid into an atlas of z slices
uniform sampler2D uPlume;
float plumeAt(vec3 q) {
  const float N = ${PLUME_N}.0;
  vec2 xy = clamp(q.xy, 0.5 / N, 1.0 - 0.5 / N) / vec2(${PLUME_COLS}.0, ${PLUME_ROWS}.0);
  float z = clamp(q.z * N - 0.5, 0.0, N - 1.0);
  float z0 = floor(z);
  float z1 = min(z0 + 1.0, N - 1.0);
  vec2 tiles = vec2(${PLUME_COLS}.0, ${PLUME_ROWS}.0);
  float a = textureLod(uPlume, vec2(mod(z0, tiles.x), floor(z0 / tiles.x)) / tiles + xy, 0.0).r;
  float b = textureLod(uPlume, vec2(mod(z1, tiles.x), floor(z1 / tiles.x)) / tiles + xy, 0.0).r;
  return mix(a, b, z - z0);
}

// Exact near the surface, where the shell glow and the air mask change fast
float evalShapeDist(vec3 p) {
  float d = morphFieldFast(p);
  return uFieldBaked > 0.5 && d < 0.5 ? morphField(p) : d;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 viewNear = uInvProj * vec4(ndc, -1.0, 1.0);
  viewNear /= viewNear.w;
  vec4 viewFar = uInvProj * vec4(ndc, 1.0, 1.0);
  viewFar /= viewFar.w;

  vec3 lNear = (uInvModel * (uInvView * viewNear)).xyz;
  vec3 lFar = (uInvModel * (uInvView * viewFar)).xyz;
  vec3 ro = uCamLocal;
  vec3 rd = normalize(lFar - lNear);

  float R = 2.25;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  float sDisc = sqrt(disc);
  float tStart = max(0.0, -b - sDisc);
  float tEnd = -b + sDisc;
  if (tEnd <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  // Two integrals: all the air along the ray (smooth across the silhouette by construction) and only the
  // air in front of the rock (right for its face). Pixels blend from the first to the second with distance
  // inside the silhouette, so the glow never steps or dips at the rock's edge.
  // "Background" is whatever lies behind the rock's centre (the sky, the ground beyond it), not just empty pixels
  float tScene = 1e9;
  float depthSample = texture(uDepth, vUv).r;
  float background = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    background += step(uRockDist, viewDistAt(vUv + vec2(cos(a), sin(a)) * uEdgeRadius));
  }
  float useAll = viewDistAt(vUv) >= uRockDist ? 1.0 : smoothstep(0.0, 0.5, background / 8.0);
  if (depthSample < 0.9999) {
    vec4 clipPos = vec4(ndc, depthSample * 2.0 - 1.0, 1.0);
    vec4 viewPos = uInvProj * clipPos;
    viewPos /= viewPos.w;
    vec3 localHit = (uInvModel * (uInvView * viewPos)).xyz;
    tScene = dot(localHit - ro, rd);
  }

  if (tEnd <= tStart + 0.005) {
    outColor = vec4(0.0);
    return;
  }

  float stepLen = (tEnd - tStart) / float(uSteps);
  float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 31.0);

  vec3 accum = vec3(0.0);
  float hotAir = 0.0;
  for (int i = 0; i < uSteps; i++) {
    float t = tStart + (float(i) + jitter) * stepLen;
    // Past the rock's face nothing more is seen
    if (useAll <= 0.0 && t > tScene) break;
    vec3 p = ro + rd * t;
    // Haze lives in the air only. The distance field is the undisplaced shape and the cracks sit up to ~0.09
    // below it, so only deeper counts as inside the rock
    float dShape = evalShapeDist(p);
    float air = smoothstep(-0.16, -0.09, dShape);
    float seen = air * mix(step(t, tScene), 1.0, useAll);
    if (seen <= 0.0) continue;
    // Air lit by the hot surface near it (any side of the rock), plus an even shell while it is all molten
    vec3 q = p / (2.0 * uSdfBound) + 0.5;
    // Squared so air near the big lava pours stands out from the thin glow around scattered cracks
    // Pulses with the lava's flow below it, like the surface does
    float pulseHere = texture(uPulseVolume, clamp(q, 0.0, 1.0)).r;
    float heatHere = texture(uHeatVolume, clamp(q, 0.0, 1.0)).r * pulseHere;
    float surfaceHeat = uSurfaceWeight * heatHere * heatHere;
    float shell = 0.0;
    if (uShellWeight > 0.001) {
      shell = uShellWeight * exp(-max(dShape, 0.0) * uFalloff) * smoothstep(-0.15, 0.04, dShape);
    }
    // Hot air rises: the shimmer at this point also carries the heat from below it, so plumes stand over the lava
    float plume = plumeAt(clamp(q, 0.0, 1.0));
    hotAir += (plume + shell) * stepLen * seen;

    float density = surfaceHeat + shell;
    if (density < 0.002) continue;

    vec3 np = p * 1.45 + vec3(0.0, -uTime * 0.32, 0.0);
    float mist = 0.6 + 0.4 * snoise(np);
    // Dense hot air near the lava is orange, thin air further out deep red
    vec3 col = mix(vec3(0.45, 0.03, 0.004), vec3(1.1, 0.26, 0.02), smoothstep(0.0, 0.6, density));
    accum += col * (density * mist * stepLen * seen);
  }

  // Alpha: hot air along the ray, which drives the heat shimmer
  outColor = vec4(accum * (0.25 + 0.75 * uHeat), hotAir * uHeat);
}
`;

// Hot air rises: the shimmer at a point also carries the heat from below it, so plumes stand over the lava
const PLUME_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
layout(location = 0) out vec4 outColor;
uniform sampler3D uHeatVolume;
uniform sampler3D uPulseVolume;
uniform vec3 uLocalUp;
uniform float uSdfBound;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 voxel = vec3(float(px.x % ${PLUME_N}), float(px.y % ${PLUME_N}), float(px.x / ${PLUME_N} + (px.y / ${PLUME_N}) * ${PLUME_COLS})) + 0.5;
  vec3 p = (voxel / ${PLUME_N}.0 - 0.5) * 2.0 * uSdfBound;
  float plume = 0.0;
  for (int k = 0; k <= 4; k++) {
    vec3 below = clamp((p - uLocalUp * (float(k) * 0.14)) / (2.0 * uSdfBound) + 0.5, 0.0, 1.0);
    plume += texture(uHeatVolume, below).r * texture(uPulseVolume, below).r * (k == 0 ? 1.0 : 1.0 - float(k) * 0.17);
  }
  outColor = vec4(plume);
}
`;

const COMPOSITE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uHdr;
uniform sampler2D uScatter;
uniform sampler2D uHaze;
uniform vec2 uHazeTexel;
uniform float uStrength;
uniform sampler2D uDepth;
uniform vec2 uCoverRadius;
uniform float uOverRock;
uniform mat4 uInvProjC;
uniform float uRockDistC;

// Covered: something nearer than just behind the rock's centre (the rock, or ground in front of it)
float coveredAt(vec2 p) {
  float d = texture(uDepth, p).r;
  if (d >= 0.9999) return 0.0;
  vec4 v = uInvProjC * vec4(p * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return step(length(v.xyz / v.w), uRockDistC + 0.6);
}
uniform float uShimmer;
uniform float uTime;
uniform sampler2D uNoise;
uniform float uAspect;
// The light shaft (LightShaft.march), added here instead of in a pass of its own
uniform sampler2D uShaft;
uniform vec2 uShaftTexel;
uniform vec3 uShaftColor;
uniform vec3 uShaftWarm;
uniform float uShaftStrength;
const float SMOKE_VEIL = 0.5;

void main() {
  // Heat shimmer: a rising, wobbling offset where the air along the view is hottest
  // Two octaves of the tileable noise scrolling upward, stretched into vertical streaks
  float hotAir = texture(uHaze, vUv).a;
  vec2 nuv = vec2(vUv.x * uAspect, vUv.y);
  vec2 n1 = texture(uNoise, nuv * vec2(2.4, 0.9) + vec2(0.0, -uTime * 0.13)).rg - 0.5;
  vec2 n2 = texture(uNoise, nuv * vec2(5.5, 2.0) + vec2(0.37, -uTime * 0.29)).gb - 0.5;
  vec2 wobble = (n1 + n2 * 0.6) * vec2(1.0, 0.5);
  vec2 offset = wobble * uShimmer * smoothstep(0.0, 0.3, hotAir);
  // Everything samples through the same distortion, so the rock's edge and its glow move together
  vec2 uv = vUv + offset;
  vec4 base = texture(uHdr, uv);
  if (uShaftStrength > 0.0) {
    vec2 st = uShaftTexel;
    vec3 sh = texture(uShaft, uv).rgb * 0.4
      + (texture(uShaft, uv + vec2(st.x, st.y)).rgb + texture(uShaft, uv + vec2(-st.x, st.y)).rgb
       + texture(uShaft, uv + vec2(st.x, -st.y)).rgb + texture(uShaft, uv + vec2(-st.x, -st.y)).rgb) * 0.15;
    // The smoke veils what is behind it (b: its transmittance), then adds its light
    base.rgb *= mix(1.0, sh.z, SMOKE_VEIL * min(uShaftStrength * 2.0, 1.0));
    base.rgb += (uShaftColor * sh.x + uShaftWarm * sh.y) * uShaftStrength;
  }
  vec3 scatter = texture(uScatter, uv).rgb;
  // Soft 5-tap smooth over half-res 3D haze
  vec2 t = uHazeTexel * 1.5;
  vec3 haze = (
    texture(uHaze, uv).rgb * 2.0 +
    texture(uHaze, uv + vec2( t.x, 0.0)).rgb +
    texture(uHaze, uv + vec2(-t.x, 0.0)).rgb +
    texture(uHaze, uv + vec2(0.0,  t.y)).rgb +
    texture(uHaze, uv + vec2(0.0, -t.y)).rgb
  ) / 6.0;

  // Glow over the rock's face lifts its dark crust and flattens it, so it is held back there; coverage is
  // averaged over a wide ring, which keeps the change across the silhouette as soft as the glow itself
  float cover = coveredAt(uv) * 2.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    cover += coveredAt(uv + vec2(cos(a), sin(a)) * uCoverRadius);
    cover += coveredAt(uv + vec2(cos(a + 0.39), sin(a + 0.39)) * uCoverRadius * 0.5);
  }
  cover /= 18.0;
  vec3 glow = scatter * vec3(1.2, 0.38, 0.04) * 0.9 + haze * 0.42;
  outColor = vec4(base.rgb + glow * uStrength * mix(1.0, uOverRock, cover), base.a);
}
`;

function makeRT() {
  return new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function makePass(fragmentShader, uniforms) {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: QUAD_VS,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

class VolumetricLavaGlow {
  constructor(renderer, morphUniforms, noiseTexture) {
    this._localUp = new Vector3(0, 1, 0);
    this._rockPos = new Vector3();
    this._rockDist = 5;
    this.renderer = renderer;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    // 5-level mip pyramid for wide, silky, ray-free isotropic fiery glow (1/2 .. 1/32)
    this.levels = 5;
    this.downRTs = Array.from({ length: this.levels }, () => makeRT());
    this.upRTs = Array.from({ length: this.levels - 1 }, () => makeRT());
    this.hazeRT = makeRT();
    this.plumeRT = new WebGLRenderTarget(PLUME_N * PLUME_COLS, PLUME_N * PLUME_ROWS, {
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
    this.outRT = makeRT();
    this._invModel = new Matrix4();
    this._camLocal = new Vector3();
    this._w = 0;
    this._h = 0;

    this.extractMat = makePass(EXTRACT_LAVA_FS, {
      uHdr: { value: null },
      uTexel: { value: new Vector2(1 / 256, 1 / 256) },
    });
    this.downMat = makePass(DOWN_FS, {
      uSrc: { value: null },
      uTexel: { value: new Vector2(1 / 256, 1 / 256) },
    });
    this.upMat = makePass(UP_FS, {
      uLow: { value: null },
      uHigh: { value: null },
      uTexel: { value: new Vector2(1 / 256, 1 / 256) },
      uRadius: { value: 1.0 },
      uWeight: { value: 0.65 },
    });
    this.hazeMat = makePass(VOLUMETRIC_HAZE_FS, {
      uDepth: { value: null },
      uInvProj: { value: new Matrix4() },
      uInvView: { value: new Matrix4() },
      uInvModel: { value: this._invModel },
      uCamLocal: { value: this._camLocal },
      ...morphUniforms,
      uFalloff: { value: 6.5 },
      uTime: { value: 0 },
      uHeat: { value: 0.75 },
      uHeatVolume: { value: null },
      uPulseVolume: { value: null },
      uLocalUp: { value: this._localUp },
      uRockDist: { value: 5 },
      uEdgeRadius: { value: new Vector2(0.01, 0.01) },
      uSurfaceWeight: { value: 1 },
      uShellWeight: { value: 0 },
      uSteps: { value: 18 },
      uPlume: { value: this.plumeRT.texture },
    });
    this.plumeMat = makePass(PLUME_FS, {
      uHeatVolume: { value: null },
      uPulseVolume: { value: null },
      uLocalUp: { value: this._localUp },
      uSdfBound: morphUniforms.uSdfBound,
    });
    this.compositeMat = makePass(COMPOSITE_FS, {
      uHdr: { value: null },
      uScatter: { value: this.upRTs[0].texture },
      uHaze: { value: this.hazeRT.texture },
      uShimmer: { value: 0.0025 },
      uTime: { value: 0 },
      uNoise: { value: noiseTexture },
      uAspect: { value: 1 },
      uHazeTexel: { value: new Vector2(1 / 256, 1 / 256) },
      uStrength: { value: 0.75 },
      uDepth: { value: null },
      uCoverRadius: { value: new Vector2(0.02, 0.02) },
      uOverRock: { value: 0.2 },
      uInvProjC: { value: new Matrix4() },
      uRockDistC: { value: 5 },
      uShaft: { value: null },
      uShaftTexel: { value: new Vector2() },
      uShaftColor: { value: new Vector3() },
      uShaftWarm: { value: new Vector3() },
      uShaftStrength: { value: 0 },
    });
  }

  _run(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  apply(hdrTexture, { depthTexture, camera, width, height }, { mesh, strength, heatVolume, pulseVolume, surfaceGlow = 1, shellGlow = 0, shimmer = 0.006, spread = 0.45, heat, time, shaft = null }) {
    if (strength <= 0.005 || !depthTexture || !mesh) return hdrTexture;

    if (width !== this._w || height !== this._h) {
      this._w = width;
      this._h = height;
      this.outRT.setSize(width, height);
      let lw = width;
      let lh = height;
      for (let i = 0; i < this.levels; i++) {
        lw = Math.max(1, Math.floor(lw * 0.5));
        lh = Math.max(1, Math.floor(lh * 0.5));
        this.downRTs[i].setSize(lw, lh);
        if (i < this.levels - 1) this.upRTs[i].setSize(lw, lh);
      }
      this.hazeRT.setSize(this.downRTs[0].width, this.downRTs[0].height);
    }

    const prev = this.renderer.getRenderTarget();

    // 1. Multi-mip isotropic fiery scatter pyramid (zero rays!)
    this.extractMat.uniforms.uHdr.value = hdrTexture;
    this.extractMat.uniforms.uTexel.value.set(1 / width, 1 / height);
    this._run(this.extractMat, this.downRTs[0]);

    for (let i = 1; i < this.levels; i++) {
      const src = this.downRTs[i - 1];
      this.downMat.uniforms.uSrc.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._run(this.downMat, this.downRTs[i]);
    }

    const s = Math.max(0, Math.min(1, spread));
    const upRadius = 0.65 + s * 0.90;
    const upWeight = 0.5 + s * 0.7;
    let lowRT = this.downRTs[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      const highRT = this.downRTs[i];
      this.upMat.uniforms.uLow.value = lowRT.texture;
      this.upMat.uniforms.uHigh.value = highRT.texture;
      this.upMat.uniforms.uTexel.value.set(1 / lowRT.width, 1 / lowRT.height);
      this.upMat.uniforms.uRadius.value = upRadius;
      this.upMat.uniforms.uWeight.value = upWeight;
      this._run(this.upMat, this.upRTs[i]);
      lowRT = this.upRTs[i];
    }

    // 2. Smooth isotropic 3D depth-occluded caldera haze (zero radial crack streaks!)
    mesh.updateMatrixWorld();
    this._invModel.copy(mesh.matrixWorld).invert();
    this._camLocal.copy(camera.position).applyMatrix4(this._invModel);

    const hu = this.hazeMat.uniforms;
    hu.uDepth.value = depthTexture;
    hu.uInvProj.value.copy(camera.projectionMatrixInverse);
    hu.uInvView.value.copy(camera.matrixWorld);
    hu.uFalloff.value = 11.5 - s * 8.5;
    hu.uTime.value = time;
    hu.uHeat.value = heat;
    hu.uHeatVolume.value = heatVolume;
    hu.uPulseVolume.value = pulseVolume;
    hu.uEdgeRadius.value.set(24 / width, 24 / height);
    this._localUp.set(0, 1, 0).transformDirection(this._invModel);
    this._rockDist = camera.position.distanceTo(mesh.getWorldPosition(this._rockPos));
    hu.uRockDist.value = this._rockDist;
    hu.uSurfaceWeight.value = surfaceGlow;
    hu.uShellWeight.value = shellGlow;
    this.plumeMat.uniforms.uHeatVolume.value = heatVolume;
    this.plumeMat.uniforms.uPulseVolume.value = pulseVolume;
    this._run(this.plumeMat, this.plumeRT);
    this._run(this.hazeMat, this.hazeRT);

    // 3. Composite onto HDR buffer before Pipeline's tonemapper & bloom
    this.compositeMat.uniforms.uHdr.value = hdrTexture;
    this.compositeMat.uniforms.uScatter.value = this.upRTs[0].texture;
    this.compositeMat.uniforms.uHazeTexel.value.set(1 / this.hazeRT.width, 1 / this.hazeRT.height);
    this.compositeMat.uniforms.uStrength.value = strength;
    this.compositeMat.uniforms.uDepth.value = depthTexture;
    this.compositeMat.uniforms.uInvProjC.value.copy(camera.projectionMatrixInverse);
    this.compositeMat.uniforms.uRockDistC.value = this._rockDist;
    this.compositeMat.uniforms.uCoverRadius.value.set(40 / width, 40 / height);
    this.compositeMat.uniforms.uShimmer.value = shimmer;
    this.compositeMat.uniforms.uTime.value = time;
    this.compositeMat.uniforms.uAspect.value = width / height;
    const cu = this.compositeMat.uniforms;
    cu.uShaftStrength.value = shaft ? shaft.strength : 0;
    if (shaft) {
      cu.uShaft.value = shaft.texture;
      cu.uShaftTexel.value.copy(shaft.texel);
      cu.uShaftColor.value.set(shaft.color.r, shaft.color.g, shaft.color.b);
      cu.uShaftWarm.value.set(shaft.warm.r, shaft.warm.g, shaft.warm.b);
    }
    this._run(this.compositeMat, this.outRT);

    this.renderer.setRenderTarget(prev);
    return this.outRT.texture;
  }
}

export { VolumetricLavaGlow };
