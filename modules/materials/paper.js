import {
  ShaderMaterial,
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  NearestFilter,
  RGBAFormat,
  Texture,
  UnsignedByteType,
} from "three";
import { ShaderTexture } from "../ShaderTexture.js";

// Tileable paper detail baked once: R = height, G = fibre tone (0.5 neutral),
// BA = height slope along u, v (0.5 + slope / 8). Mipmaps average the slope, so bump fades with distance.
const bakeShader = /* glsl */ `
precision highp float;
precision highp int;

uniform float size;
uniform float tile;
uniform int seed;
uniform float lowOctave;

in vec2 vUv;
out vec4 outColor;

uint hashu(ivec2 c, int k) {
  uvec2 q = uvec2(c + 65536) + uvec2(uint(k) * 747796405u, uint(seed) * 2891336453u);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = (h ^ (h >> 16)) * 0x45d9f3bu;
  return h ^ (h >> 16);
}

float hash(ivec2 c, int k) {
  return float(hashu(c, k)) * (1.0 / 4294967295.0);
}

// Periodic gradient noise, period cells per tile.
float gnoise(vec2 p, int period, int k) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float v[4];
  for (int j = 0; j < 4; j++) {
    ivec2 o = ivec2(j & 1, j >> 1);
    ivec2 c = ((ivec2(i) + o) % period + period) % period;
    float a = hash(c, k) * 6.283185307;
    v[j] = dot(vec2(cos(a), sin(a)), f - vec2(o));
  }
  return mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y);
}

// Periodic Worley distance (F1) with a jittered point per cell.
float worley(vec2 p, int period, int k) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 c = ((ivec2(i) + ivec2(x, y)) % period + period) % period;
      vec2 jit = vec2(hash(c, k), hash(c, k + 1));
      d = min(d, length(vec2(x, y) + jit - f));
    }
  }
  return d;
}

// Height in units where the slope is ~1: each octave is scaled by 1 / (2 pi frequency).
float height(vec2 p) {
  float h = 0.0;
  float freq[3] = float[3](220.0, 440.0, 880.0);
  float weight[3] = float[3](1.0, 0.75, 0.5);
  for (int o = 0; o < 3; o++) {
    int period = int(freq[o] * tile + 0.5);
    h += weight[o] * gnoise(p * float(period), period, o) / (6.283185 * freq[o]);
  }
  // Optional coarse octave at ~50 cycles per tile, so a little tooth survives into the lower mips.
  if (lowOctave > 0.0) h += lowOctave * gnoise(p * 50.0, 50, 9) / (6.283185 * 50.0 / tile);
  int felt = int(90.0 * tile + 0.5);
  float w = worley(p * float(felt), felt, 7);
  h += 0.7 * (0.5 - w * w) / (6.283185 * 90.0);
  return h;
}

// Sparse short fibres: a random segment in some cells.
float fibres(vec2 p) {
  int period = int(60.0 * tile + 0.5);
  vec2 q = p * float(period);
  vec2 i = floor(q);
  float v = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 c = ((ivec2(i) + ivec2(x, y)) % period + period) % period;
      if (hash(c, 11) > 0.35) continue;
      vec2 centre = i + vec2(x, y) + vec2(hash(c, 12), hash(c, 13));
      float a = hash(c, 14) * 6.283185;
      vec2 d = vec2(cos(a), sin(a));
      vec2 r = q - centre;
      float along = dot(r, d);
      float across = abs(dot(r, vec2(-d.y, d.x)));
      float len = 0.4 + 0.5 * hash(c, 15);
      float line = (1.0 - smoothstep(0.02, 0.06, across)) * (1.0 - smoothstep(len * 0.7, len, abs(along)));
      v = max(v, line * (hash(c, 16) * 2.0 - 1.0));
    }
  }
  return v;
}

void main() {
  vec2 p = vUv;
  float e = 1.0 / size;
  float worldTexel = tile / size;
  float h = height(p);
  vec2 g = vec2(height(p + vec2(e, 0.0)) - height(p - vec2(e, 0.0)), height(p + vec2(0.0, e)) - height(p - vec2(0.0, e)))
    / (2.0 * worldTexel);
  outColor = vec4(clamp(0.5 + h * 600.0, 0.0, 1.0), 0.5 + 0.5 * fibres(p), clamp(0.5 + g * 0.125, 0.0, 1.0));
}
`;

const bakeVertex = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// tile: world units (of the uv) one texture repeat covers; lowOctave: weight of an extra coarse octave (0 = off).
function createPaperTexture(renderer, { size = 1024, tile = 0.5, seed = 0, lowOctave = 0 } = {}) {
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { size: { value: size }, tile: { value: tile }, seed: { value: seed }, lowOctave: { value: lowOctave } },
    vertexShader: bakeVertex,
    fragmentShader: bakeShader,
  });
  const baker = new ShaderTexture(
    renderer,
    material,
    size,
    size,
    RGBAFormat,
    UnsignedByteType,
    LinearMipmapLinearFilter,
    LinearFilter,
    RepeatWrapping,
    RepeatWrapping,
  );
  const texture = baker.texture;
  texture.generateMipmaps = true;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const prevTarget = renderer.getRenderTarget();
  baker.render();
  renderer.setRenderTarget(prevTarget);
  material.dispose();
  baker.orthoQuad.geometry.dispose();
  return { texture, tile, dispose: () => baker.fbo.dispose() };
}

// Same packing from photographed paper: a height image (0.5 = mean) and a tone image, both grayscale and tileable.
const convertShader = /* glsl */ `
precision highp float;

uniform sampler2D heightMap;
uniform sampler2D toneMap;
uniform float slope;
uniform float slopeLimit;
uniform float heightMean;
uniform float heightScale;

in vec2 vUv;
out vec4 outColor;

float h(ivec2 c, ivec2 size) {
  return texelFetch(heightMap, (c % size + size) % size, 0).r;
}

void main() {
  ivec2 size = textureSize(heightMap, 0);
  ivec2 c = ivec2(vUv * vec2(size));
  vec2 g = vec2(h(c + ivec2(1, 0), size) - h(c - ivec2(1, 0), size), h(c + ivec2(0, 1), size) - h(c - ivec2(0, 1), size)) * 0.5 * slope;
  // Soft-limit steep slopes (specks in the photo) so they don't sparkle at grazing light.
  g /= sqrt(1.0 + dot(g, g) / (slopeLimit * slopeLimit));
  float tone = texture(toneMap, vUv).r;
  outColor = vec4(clamp(heightMean + (h(c, size) - 0.5) * heightScale, 0.0, 1.0), tone, clamp(0.5 + g * 0.125, 0.0, 1.0));
}
`;

async function loadImageTexture(url, filter) {
  const blob = await (await fetch(url)).blob();
  const texture = new Texture(await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }));
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = filter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

// tile: world units one repeat covers; slope: height slope per texel step of the height image (bump strength),
// soft-limited to slopeLimit; heightMean/heightScale map the height image into R (used for grain masks).
async function loadPaperTexture(
  renderer,
  {
    height = new URL("../../assets/paper-height.webp", import.meta.url).href,
    tone = new URL("../../assets/paper-tone.webp", import.meta.url).href,
    tile = 0.35,
    slope = 8,
    slopeLimit = 0.6,
    heightMean = 0.7,
    heightScale = 1.3,
  } = {},
) {
  const [heightMap, toneMap] = await Promise.all([loadImageTexture(height, NearestFilter), loadImageTexture(tone, LinearFilter)]);
  const { width, height: h } = heightMap.image;
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      heightMap: { value: heightMap },
      toneMap: { value: toneMap },
      slope: { value: slope },
      slopeLimit: { value: slopeLimit },
      heightMean: { value: heightMean },
      heightScale: { value: heightScale },
    },
    vertexShader: bakeVertex,
    fragmentShader: convertShader,
  });
  const baker = new ShaderTexture(
    renderer,
    material,
    width,
    h,
    RGBAFormat,
    UnsignedByteType,
    LinearMipmapLinearFilter,
    LinearFilter,
    RepeatWrapping,
    RepeatWrapping,
  );
  const texture = baker.texture;
  texture.generateMipmaps = true;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const prevTarget = renderer.getRenderTarget();
  baker.render();
  renderer.setRenderTarget(prevTarget);
  material.dispose();
  baker.orthoQuad.geometry.dispose();
  heightMap.dispose();
  toneMap.dispose();
  heightMap.image.close();
  toneMap.image.close();
  return { texture, tile, dispose: () => baker.fbo.dispose() };
}

function paperUniforms(paper, { bump = 0.05, tone = 0.025, fibreTone = 0.02, bumpRoughness = 0, bumpGrazing = 0 } = {}) {
  return {
    paperMap: { value: paper.texture },
    paperTile: { value: paper.tile },
    paperBump: { value: bump },
    paperTone: { value: tone },
    paperFibreTone: { value: fibreTone },
    paperBumpRoughness: { value: bumpRoughness },
    paperBumpGrazing: { value: bumpGrazing },
  };
}

// For PipelineMaterial fragmentPars; call applyPaper(s, vUv) from surface().
// paperBump is the peak slope in radians, paperTone the formation mottle amplitude,
// paperBumpRoughness how much sub-pixel slope variance raises roughness (0 = off), paperBumpGrazing how much the
// bump grows toward the key's grazing angle (0 = off). applyPaper(s, uv, bumpScale) scales the bump, e.g. to fade it on creases.
const paperGLSL = /* glsl */ `
uniform sampler2D paperMap;
uniform float paperTile;
uniform float paperBump;
uniform float paperTone;
uniform float paperFibreTone;
uniform float paperBumpRoughness;
uniform float paperBumpGrazing;

float paperHash(vec2 c) {
  uvec2 q = uvec2(ivec2(c) + 65536);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = (h ^ (h >> 16)) * 0x45d9f3bu;
  h ^= h >> 16;
  return float(h) * (1.0 / 4294967295.0);
}

float paperValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(paperHash(i), paperHash(i + vec2(1.0, 0.0)), u.x),
    mix(paperHash(i + vec2(0.0, 1.0)), paperHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

void applyPaper(inout Surface s, vec2 uv, float bumpScale) {
  vec4 t = texture(paperMap, uv / paperTile);
  float grazing = 1.0 - clamp(dot(normalize(s.normal), normalize(lightDirection)), 0.0, 1.0);
  bumpScale *= mix(1.0, mix(0.6, 1.4, grazing), paperBumpGrazing);
  vec2 g = (t.ba - 0.5) * 8.0 * paperBump * bumpScale;

  float formation = paperValueNoise(uv * 4.0 + 11.0) * 0.6 + paperValueNoise(uv * 18.0 - 5.0) * 0.4;
  s.albedo *= 1.0 + paperTone * 2.0 * (formation - 0.5) + paperFibreTone * 2.0 * (t.g - 0.5);
  s.roughness = clamp(s.roughness + 0.08 * (formation - 0.5), 0.0, 1.0);
  // Bump detail too fine for the pixel turns into roughness instead of vanishing.
  float slopeVar = paperBumpRoughness * length(fwidth(g));
  s.roughness = min(max(s.roughness, sqrt(s.roughness * s.roughness + slopeVar)), 1.0);

  // g is the height slope per uv unit; perturb as in three's perturbNormalArb.
  vec2 uvx = dFdx(uv);
  vec2 uvy = dFdy(uv);
  vec2 dH = vec2(dot(g, uvx), dot(g, uvy));
  vec3 dpx = dFdx(vWorldPosition);
  vec3 dpy = dFdy(vWorldPosition);
  vec3 r1 = cross(dpy, s.normal);
  vec3 r2 = cross(s.normal, dpx);
  float det = dot(dpx, r1) * (gl_FrontFacing ? 1.0 : -1.0);
  // Near-degenerate screen derivatives (thin, stretched triangles) get no bump instead of a noisy one.
  float detWeight = smoothstep(0.02, 0.1, abs(det) / max(length(dpx) * length(dpy), 1e-20));
  if (abs(det) > 1e-12 && detWeight > 0.0) {
    vec3 grad = sign(det) * detWeight * (dH.x * r1 + dH.y * r2);
    s.normal = normalize(abs(det) * s.normal - grad);
  }
}

void applyPaper(inout Surface s, vec2 uv) {
  applyPaper(s, uv, 1.0);
}
`;

export { createPaperTexture, loadPaperTexture, paperUniforms, paperGLSL };
