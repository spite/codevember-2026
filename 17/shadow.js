// The sun's shadow map, along the refracted sun, in the shared pipeline's layout: a float colour target with the raw
// depth (blocker search, layers of kelp above) and a comparison depth texture (hardware PCF).
import {
  WebGLRenderTarget,
  DepthTexture,
  FloatType,
  RedFormat,
  NearestFilter,
  LinearFilter,
  LessEqualCompare,
  ClampToEdgeWrapping,
  OrthographicCamera,
  Matrix4,
  Quaternion,
  Vector2,
  Vector3,
  Color,
} from "three";
import { waterUniforms } from "./water.js";

export const shadowUniforms = {
  shadowMap: { value: null },
  shadowMapCmp: { value: null },
  shadowMatrix: { value: new Matrix4() },
  shadowMapSize: { value: new Vector2(1, 1) },
  // Penumbra per metre between blocker and receiver: the sun spread by the waves and forward scattering.
  shadowLightSize: { value: 0.06 },
  // Light through one blade: amber.
  kelpTransmit: { value: new Color(0.48, 0.36, 0.05) },
  // What a full canopy lets through of the light from above: olive gold.
  uCanopyTint: { value: new Color(0.22, 0.15, 0.04) },
  // How much of the water's diffuse light kelp overhead takes away; the rest comes in from the open water around.
  uForestShade: { value: 0.7 },
};

const _m = new Matrix4();
const _q = new Quaternion();
const _qi = new Quaternion();
const _c = new Vector3();
const _up = new Vector3(0, 1, 0);
const _origin = new Vector3();
const _clear = new Color();

export class SunShadow {
  constructor({ size = 2048, center = new Vector3(0, 4, -3), radius = 26 } = {}) {
    this.size = size;
    this.center = center.clone();
    this.radius = radius;
    this.compareTexture = new DepthTexture(size, size, FloatType);
    this.compareTexture.minFilter = LinearFilter;
    this.compareTexture.magFilter = LinearFilter;
    this.compareTexture.wrapS = this.compareTexture.wrapT = ClampToEdgeWrapping;
    this.compareTexture.compareFunction = LessEqualCompare;
    this.target = new WebGLRenderTarget(size, size, {
      format: RedFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: true,
      depthTexture: this.compareTexture,
      generateMipmaps: false,
    });
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 3);
    shadowUniforms.shadowMap.value = this.target.texture;
    shadowUniforms.shadowMapCmp.value = this.compareTexture;
    shadowUniforms.shadowMapSize.value.set(size, size);
  }

  updateCamera() {
    const L = waterUniforms.uSunDir.value;
    const r = this.radius;
    const texel = (2 * r) / this.size;
    _m.lookAt(L, _origin, _up);
    _q.setFromRotationMatrix(_m);
    _qi.copy(_q).invert();
    // Snapped to whole texels, so the map doesn't shimmer.
    _c.copy(this.center).applyQuaternion(_qi);
    _c.x = Math.round(_c.x / texel) * texel;
    _c.y = Math.round(_c.y / texel) * texel;
    _c.applyQuaternion(_q);
    const camera = this.camera;
    camera.quaternion.copy(_q);
    camera.position.copy(_c).addScaledVector(L, 2 * r);
    camera.left = camera.bottom = -r;
    camera.right = camera.top = r;
    camera.near = 0;
    camera.far = 4 * r;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    shadowUniforms.shadowMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  render(renderer, scene) {
    this.updateCamera();
    const previous = renderer.getRenderTarget();
    renderer.getClearColor(_clear);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);
    renderer.setClearColor(_clear, alpha);
    renderer.setRenderTarget(previous);
  }
}

// Depth in the shadow map, for the casters' shadow materials.
export const shadowDepthFragment = /* glsl */ `
  void main() {
    gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
  }
`;

export const shadowGLSL = /* glsl */ `
uniform highp sampler2D shadowMap;
uniform highp sampler2DShadow shadowMapCmp;
uniform mat4 shadowMatrix;
uniform vec2 shadowMapSize;
uniform float shadowLightSize;
uniform vec3 kelpTransmit;
uniform vec3 uCanopyTint;
uniform float uForestShade;

vec3 shadowCoord(vec3 p) {
  vec4 c = shadowMatrix * vec4(p, 1.0);
  return c.xyz / c.w * 0.5 + 0.5;
}

float shadowInside(vec3 c) {
  vec2 e = min(c.xy, 1.0 - c.xy);
  return smoothstep(0.0, 0.02, min(e.x, e.y)) * step(c.z, 1.0);
}

// Metres per unit of shadow depth and per unit of shadow uv.
float shadowDepthScale() {
  return 2.0 / length(vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]));
}
float shadowUVScale() {
  return 2.0 / length(vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]));
}

// Light let through by kelp above: a fraction lit plus what passes the blades, and at least floorLight, what forward
// scattering carries into a shadow. Each further blade dims it but keeps one blade's amber: a filter per layer drifts to red.
vec3 throughKelp(float lit, float layers, vec3 floorLight) {
  float l1 = dot(kelpTransmit, vec3(0.2126, 0.7152, 0.0722));
  return max(vec3(lit) + (1.0 - lit) * kelpTransmit * pow(l1, layers - 1.0), floorLight);
}

// Layers of kelp between p and the sun: one close up, about one more per 2.5 m below the first blocker.
float kelpLayers(float gap) {
  return clamp(1.0 + gap / 2.5, 1.0, 4.0);
}

// The light left in a shadow (amount): warmer under the canopy (openSky 0..1), half as gold as its tint, since the blade
// it lights filters it again.
vec3 shadowFloor(float amount, float openSky) {
  vec3 tint = mix(vec3(1.0), uCanopyTint / dot(uCanopyTint, vec3(0.2126, 0.7152, 0.0722)), 0.5);
  return amount * mix(tint, vec3(1.0), openSky);
}

// The sun let through to p by the kelp above, for the shafts: one raw tap (shifted by offset in shadow uv), the layers
// from the gap to the first blocker, and no floor. metresPerDepth: shadowDepthScale(), hoisted out of the march.
vec3 sunThroughKelpFast(vec3 p, float metresPerDepth, vec2 offset) {
  vec3 c = shadowCoord(p);
  float inside = shadowInside(c);
  float d = textureLod(shadowMap, c.xy + offset, 0.0).r;
  if (inside <= 0.0 || d >= c.z - 0.0006) return vec3(1.0);
  return mix(vec3(1.0), throughKelp(0.0, kelpLayers((c.z - d) * metresPerDepth), vec3(0.0)), inside);
}

// The water's diffuse light left at p, given the sun let through there (sunThroughKelpFast).
vec3 forestShade(vec3 through) {
  return 1.0 - uForestShade * (1.0 - through);
}

// The sun let through to a marine snow speck: one filtered tap (2x2 PCF), so a speck doesn't flicker as the map moves,
// and the layers from the raw depth.
vec3 sunThroughKelpSoft(vec3 p, float metresPerDepth) {
  vec3 c = shadowCoord(p);
  float inside = shadowInside(c);
  if (inside <= 0.0) return vec3(1.0);
  float lit = textureGrad(shadowMapCmp, vec3(c.xy, c.z - 0.0006), vec2(0.0), vec2(0.0));
  float d = textureLod(shadowMap, c.xy, 0.0).r;
  return mix(vec3(1.0), throughKelp(lit, kelpLayers(max(c.z - d, 0.0) * metresPerDepth), vec3(0.0)), inside);
}

// Metres from p up to the kelp that shades it (0 where nothing does), from a few raw taps around it. Run per vertex and
// interpolated, it changes smoothly over a surface, as no per-pixel search of the nearest texels can.
float shadowGapAt(vec3 p) {
  vec3 c = shadowCoord(p + uSunDir * 0.05);
  if (shadowInside(c) <= 0.0) return 0.0;
  float r = 0.2 / shadowUVScale();
  float sum = 0.0, count = 0.0;
  for (int i = 0; i < 5; i++) {
    float a = float(i) * 1.5707963;
    float d = textureLod(shadowMap, c.xy + (i == 0 ? vec2(0.0) : r * vec2(cos(a), sin(a))), 0.0).r;
    if (d < c.z - 0.0004) { sum += c.z - d; count += 1.0; }
  }
  return count > 0.0 ? sum / count * shadowDepthScale() : 0.0;
}

// Soft shadow with a penumbra that grows with gap (shadowGapAt, metres), Vogel PCF taps all over it, and floorLight the
// least light left in it.
vec3 sunShadow(vec3 p, vec3 n, float taps, vec3 floorLight, float gap) {
  float ndl = dot(n, uSunDir);
  float texelWorld = shadowUVScale() / shadowMapSize.x;
  vec3 c = shadowCoord(p + n * texelWorld * (1.5 + 2.5 * (1.0 - abs(ndl))) * sign(ndl + 1e-4));
  float inside = shadowInside(c);
  if (inside <= 0.0) return vec3(1.0);
  float radius = clamp(max(gap, 1.0) * shadowLightSize / shadowUVScale(), 2.0 / shadowMapSize.x, 0.012);
  float lit = 0.0;
  int n2 = int(2.0 * taps);
  float spiral = 2.0 * taps;
  for (int i = 0; i < 32; i++) {
    if (i >= n2) break;
    float k = float(i);
    float r = sqrt((k + 0.5) / spiral) * radius;
    float a = 0.4 + k * 2.3999632;
    lit += textureGrad(shadowMapCmp, vec3(c.xy + r * vec2(cos(a), sin(a)), c.z - 0.0004), vec2(0.0), vec2(0.0));
  }
  return mix(vec3(1.0), throughKelp(lit / spiral, kelpLayers(gap), floorLight), inside);
}

// Soft shadow with a penumbra that grows with the gap to the blockers (one raw search ring, then Vogel PCF taps), and
// floorLight the least light left in it.
vec3 sunShadow(vec3 p, vec3 n, float taps, vec3 floorLight) {
  float ndl = dot(n, uSunDir);
  float texelWorld = shadowUVScale() / shadowMapSize.x;
  vec3 c = shadowCoord(p + n * texelWorld * (1.5 + 2.5 * (1.0 - abs(ndl))) * sign(ndl + 1e-4));
  float inside = shadowInside(c);
  if (inside <= 0.0) return vec3(1.0);
  float metresPerDepth = shadowDepthScale();
  // The same taps for every pixel: rotated per pixel, they leave a fixed hatch, as nothing averages them over frames.
  const float phi = 0.4;
  float bias = 0.0004;
  // Blockers: the mean depth of what's nearer the sun around p.
  float search = clamp(shadowLightSize * 6.0 / shadowUVScale(), 2.0 / shadowMapSize.x, 0.012);
  float sum = 0.0, count = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = phi + float(i) * 1.0471976;
    float r = (float(i & 1) * 0.5 + 0.5) * search;
    float d = textureLod(shadowMap, c.xy + r * vec2(cos(a), sin(a)), 0.0).r;
    if (d < c.z - bias) { sum += d; count += 1.0; }
  }
  float dC = textureLod(shadowMap, c.xy, 0.0).r;
  if (dC < c.z - bias) { sum += dC; count += 1.0; }
  // The penumbra from the blockers' gap, eased in as more of the ring finds them so neighbouring pixels agree; with
  // none, the taps still cover half the ring.
  float gap = count > 0.0 ? (c.z - sum / count) * metresPerDepth : 0.0;
  float radius = mix(0.5 * search, clamp(gap * shadowLightSize / shadowUVScale(), 2.0 / shadowMapSize.x, 0.012), smoothstep(0.0, 3.0, count));
  // A Vogel spiral of twice the taps, all of them everywhere: a fixed pattern that switched counts would step.
  float lit = 0.0;
  int n2 = int(2.0 * taps);
  float spiral = 2.0 * taps;
  for (int i = 0; i < 32; i++) {
    if (i >= n2) break;
    float k = float(i);
    float r = sqrt((k + 0.5) / spiral) * radius;
    float a = phi + k * 2.3999632;
    lit += textureGrad(shadowMapCmp, vec3(c.xy + r * vec2(cos(a), sin(a)), c.z - bias), vec2(0.0), vec2(0.0));
  }
  lit /= spiral;
  return mix(vec3(1.0), throughKelp(lit, kelpLayers(gap), floorLight), inside);
}

// With the open water's grey floor: for the probe.
vec3 sunShadow(vec3 p, vec3 n, float taps) {
  return sunShadow(p, n, taps, vec3(0.1));
}

// The canopy's share of the light from above: wide, coarse taps of the map.
float canopyOcclusion(vec3 p) {
  vec3 c = shadowCoord(p);
  float inside = shadowInside(c);
  if (inside <= 0.0) return 1.0;
  float r = 1.6 / shadowUVScale();
  float lit = 0.0;
  for (int i = 0; i < 5; i++) {
    float a = float(i) * 2.3999632;
    vec2 o = (i == 0 ? vec2(0.0) : r * sqrt(float(i) / 5.0) * vec2(cos(a), sin(a)));
    lit += textureGrad(shadowMapCmp, vec3(c.xy + o, c.z - 0.002), vec2(0.0), vec2(0.0));
  }
  return mix(1.0, lit / 5.0, inside);
}
`;
