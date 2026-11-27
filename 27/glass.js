// The frosted resin block and the cast inside it, drawn over the pipeline's lit frame (its composite):
//   1. Interior: rays refract into the block and sphere-trace the cast's distance volume (tBurrow), with one internal
//      bounce, the ember glow integrated along the way, and the metal shaded where they land.
//   2. Pyramid: the interior, masked to the glass, blurred at 1/2, 1/4, 1/8 (and 1/16 in Ultra).
//   3. Final: the frost blur by depth (and the streaks), the surface (Fresnel, satin, bevels, plinth reflection), the
//      cast in open air above the resin, the spot's beam and dust.
//   4. Resolve: the glass's own temporal antialiasing.
import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Matrix4,
  Vector2,
  Vector3,
  Color,
} from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { EXTENT, BAND } from "./volume.js";
import { getSharedNoiseTexture } from "./textures.js";

export const COMMON_SDF_GLSL = /* glsl */ `
float hash2(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

// Analytic SDF for all 8 encasing shapes with rounded fillets and vertical fill level (0..1, anchored at y = -hy):
//   0 = cube, 1 = cylinder, 2 = column, 3 = hex, 4 = slab, 5 = dome, 6 = monolith, 7 = paperweight
float sdBlock(vec3 p, int shapeType, vec3 halfSize, float bevel, float holeR, float level) {
  float curHy = max(halfSize.y * level, 0.004);
  float topCur = -halfSize.y + curHy * 2.0;
  float curBevel = min(bevel, min(curHy * 0.85, min(halfSize.x, halfSize.z) * 0.45));
  vec3 ps = vec3(p.x, p.y - (-halfSize.y + curHy), p.z);
  float d;
  if (shapeType == 1) {
    vec2 w = vec2(length(ps.xz) - (halfSize.x - curBevel), abs(ps.y) - (curHy - curBevel));
    d = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - curBevel;
  } else if (shapeType == 3) {
    // Hexagonal prism (6 crisp crystal facets, rotated 30° for balanced 3-facet 3/4 framing).
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    float r = halfSize.x * 0.866025404 - curBevel;
    vec2 q = abs(ps.zx);
    q -= 2.0 * min(dot(k.xy, q), 0.0) * k.xy;
    vec2 d2 = vec2(
      length(q - vec2(clamp(q.x, -k.z * r, k.z * r), r)) * sign(q.y - r),
      abs(ps.y) - (curHy - curBevel)
    );
    d = min(max(d2.x, d2.y), 0.0) + length(max(d2, 0.0)) - curBevel;
  } else if (shapeType == 5) {
    // Bell jar / cloche: cylindrical walls crowned by a smooth hemispherical dome.
    float hCyl = halfSize.y - halfSize.x;
    float dCap = length(vec3(p.x, max(p.y - hCyl, 0.0), p.z)) - halfSize.x;
    float dBase = (-halfSize.y) - p.y;
    d = smax(dCap, dBase, curBevel);
    if (level < 0.995) d = smax(d, p.y - topCur, curBevel);
  } else if (shapeType == 6) {
    // Tapered square monolith frustum (wide base tapering up toward top pour hole).
    float tf = clamp((p.y + halfSize.y) / (2.0 * halfSize.y), 0.0, 1.0);
    float rad = mix(halfSize.x, halfSize.x * 0.60, tf) - curBevel;
    vec2 qxz = abs(p.xz) - vec2(rad);
    float dSide = (length(max(qxz, 0.0)) + min(max(qxz.x, qxz.y), 0.0)) * 0.985;
    float dY = abs(ps.y) - (curHy - curBevel);
    d = min(max(dSide, dY), 0.0) + length(max(vec2(dSide, dY), 0.0)) - curBevel;
  } else if (shapeType == 7) {
    // Flat-bottomed spherical paperweight lens.
    float dSph = length(p - vec3(0.0, -halfSize.y + 0.60, 0.0)) - 1.12;
    float dBase = (-halfSize.y) - p.y;
    d = smax(dSph, dBase, curBevel);
    if (level < 0.995) d = smax(d, p.y - topCur, curBevel);
  } else {
    // Cube (0), Column (2), Slab (4): rounded box.
    vec3 b = vec3(halfSize.x, curHy, halfSize.z) - vec3(curBevel);
    vec3 q = abs(ps) - b;
    d = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - curBevel;
  }
  return d;
}

// Tetrahedral gradient offsets; the taps loop so the distance function is compiled once.
vec3 tetraOffset(int i) {
  return i == 0 ? vec3(1.0, -1.0, -1.0) : i == 1 ? vec3(-1.0, -1.0, 1.0) : i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0);
}

vec3 blockNormal(vec3 p, int shapeType, vec3 halfSize, float bevel, float holeR, float level) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < 4 + uLoop; i++) {
    vec3 k = tetraOffset(i) * 0.0016;
    g += k * sdBlock(p + k, shapeType, halfSize, bevel, holeR, level);
  }
  return normalize(g);
}

vec2 intersectBox(vec3 ro, vec3 rd, vec3 rad) {
  vec3 m = 1.0 / rd;
  vec3 n = m * ro;
  vec3 k = abs(m) * rad;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}

vec3 toLocal(vec3 w, float hy, float rot) {
  float c = cos(-rot), s = sin(-rot);
  vec3 p = w - vec3(0.0, hy, 0.0);
  return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
}

vec3 dirToLocal(vec3 d, float rot) {
  float c = cos(-rot), s = sin(-rot);
  return vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
}

vec3 dirToWorld(vec3 d, float rot) {
  float c = cos(rot), s = sin(rot);
  return vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
}

vec3 posToWorld(vec3 p, float hy, float rot) {
  float c = cos(rot), s = sin(rot);
  return vec3(p.x * c - p.z * s, p.y + hy, p.x * s + p.z * c);
}

`;

const INTERIOR_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
// Always 0: a bound the shader compiler can't see through keeps loops as loops (Direct3D unrolls fixed ones, slowly).
uniform int uLoop;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler3D tBurrow;
uniform sampler3D tGlow;
uniform sampler3D tNoise;
uniform float uMarks;
uniform float uMarkScale;

// Solid frost: a 3D field in the block's own space, read wherever the ray meets the glass, so every shape gets it
// without any mapping; tNoise carries each sample's gradient for the sheen.
// How frosted the surface is at p: an even sanded haze, softly uneven, heavier toward the edges.
float surfaceFrost3D(vec3 p, vec3 n, vec3 halfSize) {
  vec3 ap = abs(p) / max(halfSize, vec3(0.01));
  float faceEdge = max(min(ap.x, ap.z), max(min(ap.x, ap.y), min(ap.y, ap.z)));
  float edgeBoost = smoothstep(0.6, 0.98, faceEdge) * 0.22;
  float uneven = textureLod(tNoise, p * 0.06 + 0.41, 0.0).r;
  return clamp(0.45 + 0.3 * (uneven - 0.5) + edgeBoost, 0.05, 1.0);
}

uniform mat4 inverseViewProjection;
uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform vec3 uPlinthHalf;
uniform float uPixelAngle;
uniform float uLift;
uniform vec2 uJitter;

uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 lightDirection;
uniform vec3 lightColor;

uniform int uShapeType;
uniform vec3 uHalfSize;
uniform float uBevel;
uniform float uHoleR;
uniform float uStrata;
uniform float uBlockRot;
uniform float uGlassMix;
uniform float uFrost;
uniform float uIor;
uniform float uHeatIntensity;
uniform float uGrain;
uniform float uBubbles;
uniform float uPour;
uniform float uPourHeat;
uniform float uPourClock;
uniform float uPourRate;
uniform float uCoolTime;
uniform float uPulseTime;
uniform float uVoxel;
uniform float uUltra;

uniform vec3 uMetalColor;
uniform float uMetalRough;
uniform float uMetalness;
uniform float uUnderRough;
uniform float uFinishMode;

in vec2 vUv;
layout(location = 0) out vec4 outColor;

const float EXTENT = ${EXTENT.toFixed(4)};
const float INV_2EXT = ${(0.5 / EXTENT).toFixed(6)};
const float TWO_BAND = ${(2 * BAND).toFixed(2)};

${COMMON_SDF_GLSL}

vec3 sampleEnv(vec3 d, float rough) {
  return textureLod(envMap, envRotation * d, envMapMaxLod * clamp(rough, 0.0, 1.0)).rgb * envIntensity;
}

vec3 sampleBackground(vec3 worldPos, vec3 worldDir, float dist) {
  // Heading down onto the plinth top (y = 0, the block's base): stop there, not somewhere inside the plinth.
  if (worldDir.y < -0.01) {
    float tTop = worldPos.y / -worldDir.y;
    vec3 hitTop = worldPos + worldDir * tTop;
    if (tTop < dist && all(lessThan(abs(hitTop.xz), uPlinthHalf.xz))) dist = max(tTop, 0.0);
  }
  vec4 clip = viewProjection * vec4(worldPos + worldDir * dist, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
  float on = clip.w > 0.0 ? edge.x * edge.y : 0.0;
  return mix(sampleEnv(worldDir, 0.25), textureLod(tScene, clamp(uv, 0.002, 0.998), 0.0).rgb, on);
}

// One lookup of tBurrow: R = distance, G = resting heat, B = when the stream reaches it, A = when the pool fills it.
float burrowSdf(vec3 q, out float heat) {
  vec3 uvw = q * INV_2EXT + 0.5;
  if (any(lessThan(uvw, vec3(0.005))) || any(greaterThan(uvw, vec3(0.995)))) {
    heat = 0.0;
    return TWO_BAND * 0.5 * uVoxel;
  }
  vec4 s = textureLod(tBurrow, uvw, 0.0);
  float restHeat = s.y;
  float streamT = s.z;
  float poolT = s.w;
  float d = (0.5 - s.x) * TWO_BAND * uVoxel;
  if (uPour < 0.999) {
    // Stage 1 (0 -> 0.48): leading front of falling molten blobs races from the top pour hole to the branch ends.
    float streamProg = clamp(uPour / 0.48, 0.0, 1.0);
    float frontT = mix(-0.04, 1.08, streamProg);
    float dStreamTip = (streamT - frontT) * 0.55;

    // Smooth, C-infinity downward-traveling blob waves driven strictly monotonically by uPour
    // (no fract() discontinuities and no uPulseTime phase rewind at the end of the pour).
    float blobAmp = 1.0 - smoothstep(0.72, 0.95, uPour);
    float ph1 = (streamT * 4.8 - uPour * 6.4) * 6.283185 + 0.65 * sin(q.x * 2.4 + q.z * 2.1);
    float ph2 = (streamT * 7.6 - uPour * 9.0) * 6.283185 + 0.75 * cos(q.z * 2.8 - q.x * 2.0);
    float w1 = 0.5 + 0.5 * cos(ph1);
    w1 *= w1;
    float w2 = 0.5 + 0.5 * cos(ph2);
    w2 *= w2;
    float leadBlob = smoothstep(0.14, 0.0, abs((frontT - 0.04) - streamT));
    float blobMask = clamp(max(max(w1, w2 * 0.72), leadBlob), 0.0, 1.0);

    // Pinch between globs into rounded falling molten droplets, fading smoothly to 0 near full.
    float gapShrink = mix(0.032, 0.012, smoothstep(0.0, 0.85, streamT)) * blobAmp;
    float blobShrink = mix(gapShrink, 0.0, blobMask);
    float dBlobs = smax(d + blobShrink, dStreamTip, 0.018);

    // Stage 2 (0.32 -> 0.96): falling blobs accumulate at the bottom ends and back-fill bottom-to-top to full cast.
    float poolProg = smoothstep(0.32, 0.96, uPour);
    float dPoolLevel = (poolT - mix(-0.04, 1.08, poolProg)) * 0.60;
    float dPool = smax(d, max(dPoolLevel, dStreamTip), 0.024);

    // Smooth viscous meniscus where falling blobs merge into the rising pool;
    // conservative 0.65 Lipschitz scale preserves the exact zero isosurface while preventing raymarch overstepping.
    float dPour = smin(dBlobs, dPool, 0.020);
    float activePour = 1.0 - smoothstep(0.95, 0.998, uPour);
    d = mix(d, dPour * 0.65, activePour);
  }
  // Temperature: the embers at rest (orange), and the poured metal: molten from when the front reaches it until the
  // pour ends, then cooling, the first metal in first (the deep ends last), with the fresh front hotter still.
  heat = restHeat * uHeatIntensity * 0.85;
  float arrived = 0.48 * (streamT + 0.04) / 1.12 / uPourRate;
  float age = uPourClock - arrived;
  if (age > -0.05) {
    float since = uPourClock - 1.0 / uPourRate - arrived * uPourRate * 1.5;
    float molten = 1.1 * exp(-max(since, 0.0) / uCoolTime);
    float front = 1.3 * exp(-max(age, 0.0) / 0.5);
    heat = max(heat, max(molten, front));
  }
  return d;
}

float burrowSdfOnly(vec3 q) {
  float h;
  return burrowSdf(q, h);
}

vec3 burrowNormal(vec3 q) {
  float e = max(uVoxel * 0.75, 0.005);
  vec3 g = vec3(0.0);
  for (int i = 0; i < 4 + uLoop; i++) {
    vec3 k = tetraOffset(i) * e;
    g += k * burrowSdfOnly(q + k);
  }
  float gl = length(g);
  return gl > 1e-5 ? g / gl : vec3(0.0, 1.0, 0.0);
}

vec3 sampleGlowWispBlotch(vec3 q) {
  vec3 uvw = q * INV_2EXT + 0.5;
  if (any(lessThan(uvw, vec3(0.01))) || any(greaterThan(uvw, vec3(0.99)))) return vec3(0.0, 0.4, 0.5);
  return textureLod(tGlow, uvw, 0.0).rgb;
}

vec3 moltenRamp(float t) {
  t = clamp(t, 0.0, 1.4);
  vec3 c1 = vec3(0.75, 0.08, 0.005);
  vec3 c2 = vec3(1.0, 0.24, 0.01);
  vec3 c3 = vec3(1.0, 0.46, 0.05);
  vec3 c4 = vec3(1.0, 0.94, 0.72);
  vec3 col = mix(vec3(0.0), c1, smoothstep(0.16, 0.42, t));
  col = mix(col, c2, smoothstep(0.38, 0.66, t));
  col = mix(col, c3, smoothstep(0.62, 0.92, t));
  col = mix(col, c4, smoothstep(0.88, 1.28, t));
  return col;
}

// GGX key + studio environment, with sand-cast relief and pores from the tileable tNoise.
vec3 shadeMetal(vec3 q, vec3 nObj, vec3 viewDirObj, float heat, vec3 toLightObj, float breath) {
  float underside = smoothstep(-0.15, -0.78, nObj.y);
  // Keep a permanent visible cast-metal sand grain floor even at Grain=0 and on undersides.
  float grainEff = mix(0.2, 1.25, uGrain);
  float gMask = grainEff * mix(1.0, 0.52, underside);

  // Detail is faded out once its features get under about two pixels (they would only sparkle), and roughness takes
  // over what is lost. tNoise has 12 features per unit of its coordinates.
  float footprint = length(posToWorld(q, uHalfSize.y + uLift, uBlockRot) - cameraPos) * uPixelAngle;
  float wFine = smoothstep(1.5, 3.0, 1.0 / (12.0 * 6.5) / footprint);
  float wGrit = smoothstep(1.5, 3.0, 1.0 / (12.0 * 19.5) / footprint);
  vec4 nCoarse = textureLod(tNoise, q * 1.8, 0.0);
  vec4 nFine = textureLod(tNoise, q * 6.5 + vec3(0.37, 0.19, 0.61), 0.0);
  vec4 nGrit = textureLod(tNoise, q * 19.5 + vec3(0.71, 0.43, 0.17), 0.0);
  vec3 bumpG = (nCoarse.gba * 2.0 - 1.0) * 0.42 + (nFine.gba * 2.0 - 1.0) * 0.36 * wFine + (nGrit.gba * 2.0 - 1.0) * 0.44 * wGrit;
  float gritCoarse = nCoarse.r;
  float ridge = abs(nFine.r * 2.0 - 1.0);
  float fineVal = nFine.r * 0.45 + nGrit.r * 0.55;
  float pit = smoothstep(0.24, 0.76, gritCoarse) * 0.42 + ridge * 0.24 + fineVal * 0.34;

  vec3 N = normalize(nObj - bumpG * 0.68 * gMask);

  // Crisp round trapped-gas pores & pinholes on the cast metal surface (3 scales, patchy upward clustering).
  float poreAO = 1.0;
  if (uBubbles > 0.01) {
    float patchMask = smoothstep(0.20, 0.72, gritCoarse) * (0.62 + 0.38 * smoothstep(-0.25, 0.65, nObj.y));
    float density = clamp(uBubbles * (0.55 + 0.75 * patchMask), 0.0, 1.0);
    // Layer 1: medium-large round air-pocket holes (freq 18).
    vec3 p1 = q * 18.0;
    vec3 c1 = floor(p1);
    float h1 = hash31(c1 + 19.3);
    float th1 = mix(0.96, 0.12, density);
    if (h1 > th1 && footprint < 0.006) {
      vec3 off1 = (vec3(hash31(c1 + 3.1), hash31(c1 + 7.7), hash31(c1 + 13.9)) - 0.5) * 0.32;
      vec3 v1 = fract(p1) - 0.5 - off1;
      float d1 = length(v1);
      float r1 = mix(0.13, 0.31, clamp((h1 - th1) / max(1.0 - th1, 1e-3), 0.0, 1.0)) * (0.72 + 0.34 * uBubbles);
      if (d1 < r1) {
        float inside1 = 1.0 - smoothstep(r1 * 0.68, r1, d1);
        vec3 tang1 = v1 - nObj * dot(v1, nObj);
        float tl1 = length(tang1);
        if (tl1 > 1e-4) {
          vec3 bowlN = normalize(nObj * 0.32 - (tang1 / tl1) * 0.95);
          N = normalize(mix(N, bowlN, inside1 * 0.94));
        }
        poreAO = min(poreAO, mix(1.0, 0.04, inside1 * smoothstep(r1, r1 * 0.35, d1)));
      }
    }
    // Layer 2: small circular pinholes (freq 34).
    vec3 p2 = q * 34.0;
    vec3 c2 = floor(p2);
    float h2 = hash31(c2 + 41.7);
    float th2 = mix(0.94, 0.06, density);
    if (h2 > th2 && footprint < 0.0035) {
      vec3 off2 = (vec3(hash31(c2 + 5.3), hash31(c2 + 11.1), hash31(c2 + 29.7)) - 0.5) * 0.32;
      vec3 v2 = fract(p2) - 0.5 - off2;
      float d2 = length(v2);
      float r2 = mix(0.13, 0.29, clamp((h2 - th2) / max(1.0 - th2, 1e-3), 0.0, 1.0)) * (0.72 + 0.32 * uBubbles);
      if (d2 < r2) {
        float inside2 = 1.0 - smoothstep(r2 * 0.64, r2, d2);
        vec3 tang2 = v2 - nObj * dot(v2, nObj);
        float tl2 = length(tang2);
        if (tl2 > 1e-4) {
          vec3 bowlN2 = normalize(nObj * 0.28 - (tang2 / tl2) * 0.96);
          N = normalize(mix(N, bowlN2, inside2 * 0.94));
        }
        poreAO = min(poreAO, mix(1.0, 0.05, inside2 * smoothstep(r2, r2 * 0.30, d2)));
      }
    }
    // Layer 3: dense fine micro-pinholes at higher Bubbles settings (freq 58).
    if (uBubbles > 0.20 && footprint < 0.002) {
      vec3 p3 = q * 58.0;
      vec3 c3 = floor(p3);
      float h3 = hash31(c3 + 73.1);
      float th3 = mix(0.94, 0.08, clamp((density - 0.15) * 1.18, 0.0, 1.0));
      if (h3 > th3) {
        vec3 off3 = (vec3(hash31(c3 + 2.7), hash31(c3 + 9.3), hash31(c3 + 17.5)) - 0.5) * 0.32;
        vec3 v3 = fract(p3) - 0.5 - off3;
        float d3 = length(v3);
        float r3 = mix(0.14, 0.28, clamp((h3 - th3) / max(1.0 - th3, 1e-3), 0.0, 1.0));
        if (d3 < r3) {
          float inside3 = 1.0 - smoothstep(r3 * 0.55, r3, d3);
          poreAO = min(poreAO, mix(1.0, 0.07, inside3));
        }
      }
    }
  }

  vec3 Nw = normalize(dirToWorld(N, uBlockRot));
  vec3 Vw = normalize(dirToWorld(viewDirObj, uBlockRot));
  vec3 Lw = normalize(lightDirection);

  float aoTap[2];
  for (int i = 0; i < 2 + uLoop; i++) {
    float h = i == 0 ? 0.045 : 0.12;
    aoTap[i] = clamp(burrowSdfOnly(q + nObj * h) / h, 0.0, 1.0);
  }
  float ao1 = aoTap[0], ao2 = aoTap[1];
  float ao = mix(0.24, 1.0, ao1 * 0.55 + ao2 * 0.45) * poreAO;

  float localGlow = sampleGlowWispBlotch(q + nObj * 0.06).r * max(uHeatIntensity, uPourHeat * 0.85) * breath;
  float heatJitter = (gritCoarse - 0.5) * 0.22 * uGrain;
  float temp = clamp((heat + heatJitter * smoothstep(0.08, 0.4, heat)) * breath, 0.0, 1.35);

  vec3 albedo = uMetalColor * mix(mix(0.52, 1.24, pit), 1.15, underside * 0.65);
  float rough = clamp(mix(uMetalRough + (0.55 - pit) * 0.42 * gMask, uUnderRough, underside * 0.82) + 0.08 * gMask * (1.0 - wGrit) + 0.06 * (1.0 - wFine), 0.06, 0.88);
  float metal = uMetalness;

  // Mode 1: Copper with subtle oxidized turquoise-verdigris patina in deep recesses.
  if (uFinishMode > 0.5 && uFinishMode < 1.5) {
    float patina = smoothstep(0.76, 0.30, ao) * smoothstep(0.62, 0.22, pit) * (0.55 + 0.45 * gritCoarse);
    albedo = mix(albedo, vec3(0.24, 0.58, 0.48), patina * 0.82);
    rough = mix(rough, 0.78, patina * 0.85);
    metal = mix(metal, 0.08, patina * 0.9);
  }

  // Mode 2: Oxidized bismuth with thin-film iridescent oxide interference (cobalt, violet, gold, teal).
  if (uFinishMode > 1.5 && uFinishMode < 2.5) {
    float ndvI = clamp(dot(Nw, Vw), 0.0, 1.0);
    float phase = (1.0 - ndvI) * 5.6 + gritCoarse * 3.8 + q.y * 1.15;
    vec3 irid = 0.56 + 0.44 * cos(phase + vec3(0.0, 2.094, 4.189));
    albedo = mix(albedo, irid * vec3(1.06, 0.96, 1.18), 0.74 * (0.45 + 0.55 * ao));
  }

  // Mode 3: Heat-tempered / blued steel with straw -> violet -> royal indigo temper bands above the molten zone.
  if (uFinishMode > 2.5) {
    float temper = clamp(heat * (0.65 + 0.45 * uHeatIntensity) + (gritCoarse - 0.5) * 0.14 + smoothstep(0.35, -0.75, q.y / max(uHalfSize.y, 0.1)) * 0.28, 0.0, 1.0);
    vec3 straw = vec3(0.84, 0.68, 0.36);
    vec3 violet = vec3(0.48, 0.24, 0.56);
    vec3 indigo = vec3(0.14, 0.32, 0.78);
    vec3 tealBlue = vec3(0.24, 0.48, 0.72);
    vec3 tCol = albedo;
    tCol = mix(tCol, straw, smoothstep(0.08, 0.22, temper) * (1.0 - smoothstep(0.22, 0.34, temper)));
    tCol = mix(tCol, violet, smoothstep(0.20, 0.34, temper) * (1.0 - smoothstep(0.34, 0.48, temper)));
    tCol = mix(tCol, indigo, smoothstep(0.30, 0.46, temper) * (1.0 - smoothstep(0.56, 0.76, temper)));
    tCol = mix(tCol, tealBlue, smoothstep(0.52, 0.72, temper) * (1.0 - smoothstep(0.76, 0.95, temper)));
    albedo = mix(albedo, tCol, 0.88);
  }

  float moltenZone = smoothstep(0.22, 0.85, temp);
  albedo *= mix(1.0, 0.18, smoothstep(0.14, 0.55, temp));
  rough = mix(rough, 0.22, moltenZone * 0.7);
  metal = mix(metal, 0.25, moltenZone * 0.85);

  float ndv = max(dot(Nw, Vw), 0.001);
  float ndl = max(dot(Nw, Lw), 0.0);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);

  vec3 R = reflect(-Vw, Nw);
  vec3 envSpec = sampleEnv(R, rough);
  vec3 envDiff = sampleEnv(Nw, 0.92);

  vec3 H = normalize(Lw + Vw);
  float ndh = max(dot(Nw, H), 0.0);
  float a2 = rough * rough;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / max(3.14159 * denom * denom, 1e-4);
  vec3 directSpec = lightColor * (D * 0.18) * F * ndl;
  vec3 directDiff = lightColor * (1.0 - metal) * albedo * (ndl / 3.14159) * 0.52;

  vec3 warmBounce = vec3(1.0, 0.38, 0.06) * localGlow * albedo * (0.45 + 0.55 * underside) * 0.85;

  vec3 lit = (directDiff + directSpec + envDiff * albedo * (1.0 - metal) * 0.78 + envSpec * F * (1.15 - rough * 0.45)) * ao + warmBounce;

  if (temp > 0.14) {
    // Moderate, so tone mapping keeps the orange instead of washing it to peach.
    float glowPow = pow(temp, 1.7) * 3.4;
    lit += moltenRamp(temp) * glowPow;
  }
  return lit;
}

vec3 shadeMetalTIR(vec3 q, vec3 nObj, vec3 viewDirObj, float heat, float breath) {
  vec3 Nw = normalize(dirToWorld(nObj, uBlockRot));
  vec3 Vw = normalize(dirToWorld(viewDirObj, uBlockRot));
  vec3 Lw = normalize(lightDirection);
  float ndv = clamp(dot(Nw, Vw), 0.001, 0.9999);
  float temp = clamp(heat * breath, 0.0, 1.35);
  vec3 baseCol = uMetalColor;
  if (uFinishMode > 1.5 && uFinishMode < 2.5) {
    baseCol = mix(baseCol, 0.56 + 0.44 * cos((1.0 - ndv) * 5.6 + q.y * 1.15 + vec3(0.0, 2.094, 4.189)), 0.72);
  } else if (uFinishMode > 2.5) {
    baseCol = mix(baseCol, vec3(0.18, 0.36, 0.78), smoothstep(0.15, 0.65, heat));
  }
  vec3 F0 = mix(vec3(0.04), baseCol, uMetalness);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
  vec3 envSpec = sampleEnv(reflect(-Vw, Nw), uMetalRough + 0.08);
  vec3 albedo = baseCol * mix(1.0, 0.2, smoothstep(0.14, 0.55, temp));
  // Polished metal has almost no diffuse: the key shows as a highlight, not a matte wash.
  vec3 H = normalize(Lw + Vw);
  float spec = pow(max(dot(Nw, H), 0.0), 2.0 / max(uMetalRough * uMetalRough, 0.004)) * 0.6;
  vec3 lit = envSpec * F + lightColor * max(dot(Nw, Lw), 0.0) * (albedo * 0.35 * (1.0 - uMetalness) + F * spec);
  if (temp > 0.14) {
    lit += moltenRamp(temp) * pow(temp, 1.7) * 3.4;
  }
  return lit;
}

// Decoupled 3D crossing:
//   A: sphere-trace tBurrow to the metal or out of the glass.
//   B: integrate the glow and wisps (tGlow) over that stretch in a few fixed steps.
vec4 crossing(vec3 p, vec3 dir, float jitter, vec3 toLightObj, float breath, bool isTIR, out vec3 exitPoint, out float hitDist, out float metalHeat) {
  float curHy = max(uHalfSize.y * uGlassMix, 0.004);
  vec3 pBox = vec3(p.x, p.y - (-uHalfSize.y + curHy), p.z);
  float tExitEst = max(intersectBox(pBox, dir, vec3(uHalfSize.x, curHy, uHalfSize.z)).y, 0.02);
  bool isBoxShape = (uShapeType == 0 || uShapeType == 2 || uShapeType == 4);
  float checkGlassAfter = isBoxShape ? max(tExitEst - uBevel * 1.8 - 0.04, 0.0) : 0.0;

  // Phase A: Pure burrow SDF sphere-trace.
  float t = 0.008;
  float lastD = -0.002;
  float lastStride = 0.008;
  bool hitMetal = false;
  bool leftGlass = false;
  float hitHeat = 0.0;
  int maxSteps = isTIR ? 36 : 48;
  float minStride = isTIR ? 0.009 : 0.007;

  // Steps also stop short of the glass's surface, so where the ray leaves never depends on how far the metal is.
  float glassRoom = 1e3;
  for (int i = 0; i < 48 + uLoop; i++) {
    if (i >= maxSteps) break;
    vec3 q = p + dir * t;
    if (t >= checkGlassAfter) {
      float dGlass = sdBlock(q, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
      if (dGlass > 0.0) {
        if (i > 0) {
          t -= lastStride * dGlass / max(dGlass - lastD, 1e-4);
          leftGlass = true;
          break;
        }
        dGlass = -0.002;
      }
      lastD = dGlass;
      glassRoom = -dGlass;
    }

    float heat;
    // The reflected bounce ignores the metal: it carries only the smooth glow and what lies beyond, so its mirrored
    // copies stay soft instead of flickering cast-shaped edges.
    heat = 0.0;
    float dBurrow = isTIR ? 1.0 : burrowSdf(q, heat);
    if (dBurrow < 0.002) {
      // Binary-refine the metal surface hit on both primary and TIR rays to eliminate step-slice contour rings.
      float tLo = max(t - lastStride, 0.0);
      float tHi = t;
      for (int r = 0; r < 4 + uLoop; r++) {
        float tm = 0.5 * (tLo + tHi);
        if (burrowSdfOnly(p + dir * tm) < 0.0) tHi = tm;
        else tLo = tm;
      }
      t = tHi;
      burrowSdf(p + dir * t, heat);
      hitHeat = heat;
      hitMetal = true;
      break;
    }

    float stride = max(min(dBurrow * 0.90, glassRoom), minStride);
    if (t < checkGlassAfter) stride = min(stride, max(tExitEst - t, minStride));
    lastStride = stride;
    t += stride;
    if (t > tExitEst + 0.04) {
      t = tExitEst;
      leftGlass = true;
      break;
    }
  }

  if (!hitMetal && !leftGlass) {
    for (int i = 0; i < 12 + uLoop; i++) {
      float d = sdBlock(p + dir * t, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
      if (d > 0.0) break;
      t += max(-d, 0.025);
    }
  }

  hitDist = max(t, 0.005);
  exitPoint = p + dir * hitDist;

  // Phase B: Decoupled volumetric scattering integration along [0, hitDist]
  // Fast: 6 steps (3 for the bounce). Ultra: 12 (6), plus seed bubbles.
  int volSteps = uUltra > 0.5 ? (isTIR ? 6 : 12) : (isTIR ? 3 : 6);
  float ds = hitDist / float(volSteps);
  vec3 acc = vec3(0.0);
  float through = 1.0;
  vec3 lastCell = vec3(-1e3);

  for (int i = 0; i < 12 + uLoop; i++) {
    if (i >= volSteps) break;
    float st = (float(i) + 0.15 + jitter * 0.7) * ds;
    vec3 q = p + dir * st;

    float strata = 0.0;
    if (uStrata > 0.01) {
      float b1 = sin(q.y * 13.5 + 0.7 * sin(q.x * 2.4)) * 0.5 + 0.5;
      float b2 = sin(q.y * 29.0 + 1.3) * 0.5 + 0.5;
      strata = uStrata * (smoothstep(0.55, 0.92, b1) * 0.7 + smoothstep(0.65, 0.95, b2) * 0.3);
    }

    vec3 gwb = sampleGlowWispBlotch(q);
    float pourGlowScale = smoothstep(0.16, 0.92, uPour) * (1.0 + 0.35 * uPourHeat);
    float gVal = gwb.r * uHeatIntensity * breath * pourGlowScale;
    float wispMask = gwb.g;
    vec3 emberScatter = mix(vec3(1.0, 0.26, 0.02), vec3(1.0, 0.68, 0.18), gVal) * gVal * (0.42 + (0.65 + 0.55 * wispMask) * uFrost + strata * 0.35);
    float frostDensity = (0.10 + (0.22 + 0.34 * wispMask) * uFrost + strata * 0.38);
    // In a dark gallery the frost inside scatters little light of its own: a faint grey veil, not fog.
    vec3 frostCol = vec3(0.045, 0.047, 0.05) * (0.68 + 0.32 * clamp(q.y / uHalfSize.y, -1.0, 1.0)) * (0.78 + 0.45 * wispMask);
    float atten = exp(-frostDensity * ds);
    acc += through * (frostCol * (1.0 - atten) + emberScatter * ds * 1.3);
    through *= atten * (1.0 - 0.10 * ds);

    // Fine suspended seed micro-bubbles in Ultra mode (bounce 1).
    if (uUltra > 0.5 && !isTIR && uGlassMix > 0.5) {
      vec3 cell = floor(q * 18.0);
      if (cell != lastCell) {
        lastCell = cell;
        if (hash31(cell + 3.7) > 0.992) {
          vec3 c = (cell + 0.25 + 0.5 * vec3(hash31(cell + 1.1), hash31(cell + 2.2), hash31(cell + 5.5))) / 18.0;
          float r = length(cross(c - p, dir));
          float speck = smoothstep(0.0055, 0.0, r);
          acc += through * speck * (vec3(0.45) + emberScatter * 1.6);
        }
      }
    }
  }

  // A metal hit is shaded by the caller (one shading call site for every hit); .a is then its weight.
  metalHeat = hitMetal ? hitHeat : -1.0;
  return vec4(acc, through);
}

// The cast where a ray hit it.
vec3 shadeHit(vec3 q, vec3 dir, float heat, bool tir, vec3 toLightObj, float breath) {
  vec3 nB = burrowNormal(q);
  return (tir && uUltra < 0.5) ? shadeMetalTIR(q, nB, -dir, heat, breath) : shadeMetal(q, nB, -dir, heat, toLightObj, breath);
}

void main() {
  vec3 baseScene = textureLod(tScene, vUv, 0.0).rgb;
  // Rays nudged by this frame's sub-pixel jitter (the glass's own TAA resolves it).
  vec2 ndc = (vUv + uJitter) * 2.0 - 1.0;
  vec4 pNear = inverseViewProjection * vec4(ndc, -1.0, 1.0);
  vec4 pFar = inverseViewProjection * vec4(ndc, 1.0, 1.0);
  vec3 roW = cameraPos;
  vec3 rdW = normalize(pFar.xyz / pFar.w - pNear.xyz / pNear.w);

  float rawDepth = textureLod(tDepth, vUv, 0.0).r;
  float sceneDist = 1e5;
  if (rawDepth < 0.99995) {
    vec4 pSceneClip = inverseViewProjection * vec4(ndc, rawDepth * 2.0 - 1.0, 1.0);
    sceneDist = dot(pSceneClip.xyz / pSceneClip.w - roW, rdW);
  }

  vec3 ro = toLocal(roW, uHalfSize.y + uLift, uBlockRot);
  vec3 rd = dirToLocal(rdW, uBlockRot);
  vec2 boxHit = intersectBox(ro, rd, uHalfSize + vec3(0.008));
  if (boxHit.x > boxHit.y || boxHit.y < 0.0) {
    outColor = vec4(baseScene, 0.0);
    return;
  }

  vec3 toLightObj = dirToLocal(normalize(lightDirection), uBlockRot);
  float breath = 0.90 + 0.10 * sin(uPulseTime * 1.45);
  float jitter = hash2(gl_FragCoord.xy);

  // 1) Find where the ray hits the frosted glass encasing using a tight AABB matched to the current fill level.
  float glassFade = smoothstep(0.003, 0.09, uGlassMix);
  float tGlass = 1e5;
  bool hitGlass = false;
  if (glassFade > 0.001) {
    float curHy = max(uHalfSize.y * uGlassMix, 0.004);
    vec3 gCenter = vec3(0.0, -uHalfSize.y + curHy, 0.0);
    vec2 gBox = intersectBox(ro - gCenter, rd, vec3(uHalfSize.x, curHy, uHalfSize.z) + vec3(0.0002));
    if (gBox.x <= gBox.y && gBox.y > 0.0) {
      float tg = max(gBox.x, 0.0);
      float tMax = min(gBox.y + 0.01, sceneDist);
      for (int i = 0; i < 64 + uLoop; i++) {
        float d = sdBlock(ro + rd * tg, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
        if (d < 0.0008) {
          hitGlass = true;
          tGlass = tg;
          break;
        }
        tg += max(d, 0.0005);
        if (tg > tMax) break;
      }
    }
  }

  // Metal hits along the way, shaded together at the end: where, from which direction, how hot, with what weight.
  vec3 hitQ[2];
  vec3 hitDir[2];
  float hitHeat[2];
  vec3 hitW[2];
  bool hitTIR[2];
  for (int k = 0; k < 2; k++) { hitQ[k] = vec3(0.0); hitDir[k] = vec3(0.0, 1.0, 0.0); hitHeat[k] = -1.0; hitW[k] = vec3(0.0); hitTIR[k] = false; }

  // 2) The cast in open air before the ray reaches the glass (skipped when fully encased).
  float airT = -1.0;
  float tAirLimit = min(min(boxHit.y, sceneDist), hitGlass ? tGlass : 1e5);
  if (uGlassMix < 0.995 && tAirLimit > max(boxHit.x, 0.0) + 0.002) {
    float tm = max(boxHit.x, 0.0);
    float lastAirStride = 0.008;
    bool hitM = false;
    for (int i = 0; i < 48 + uLoop; i++) {
      vec3 q = ro + rd * tm;
      float d = burrowSdfOnly(q);
      if (d < 0.0016) {
        float tLo = max(tm - lastAirStride, 0.0);
        float tHi = tm;
        for (int r = 0; r < 3 + uLoop; r++) {
          float tMid = 0.5 * (tLo + tHi);
          if (burrowSdfOnly(ro + rd * tMid) < 0.0) tHi = tMid;
          else tLo = tMid;
        }
        tm = tHi;
        hitM = true;
        break;
      }
      lastAirStride = max(d * 0.90, 0.007);
      tm += lastAirStride;
      if (tm > tAirLimit) break;
    }
    if (hitM && tm < tAirLimit) {
      airT = tm;
      hitQ[0] = ro + rd * tm;
      hitDir[0] = rd;
      float heat;
      burrowSdf(hitQ[0], heat);
      hitHeat[0] = heat;
      hitW[0] = vec3(1.0);
    }
  }

  if (airT < 0.0 && (!hitGlass || tGlass > sceneDist)) {
    outColor = vec4(baseScene, 0.0);
    return;
  }

  vec3 inside = vec3(0.0);
  float coc = 0.0;
  if (airT < 0.0) {
    vec3 pFront = ro + rd * tGlass;
    vec3 nFront = blockNormal(pFront, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
    float iorEff = mix(1.0, uIor, glassFade);
    vec3 dir = refract(rd, nFront, 1.0 / iorEff);
    if (length(dir) < 0.001) dir = rd;

    float f0 = (iorEff - 1.0) / (iorEff + 1.0);
    f0 *= f0;

    // Both crossings through one call site (Direct3D's compiler inlines every call): the way in, then, where the far
    // face reflects, back across the block (total internal reflection).
    vec3 beyond = vec3(0.0);
    vec3 firstExit = pFront;
    float firstA = 0.0, leave = 1.0, hitDist = 0.0, effBlurDist = 0.0, tirShare = 0.0;
    vec3 cp = pFront - nFront * 0.004, cd = dir;
    for (int bounce = 0; bounce < 2 + uLoop; bounce++) {
      vec3 ex;
      float hd, mh;
      vec4 cr = crossing(cp, cd, jitter, toLightObj, breath, bounce == 1, ex, hd, mh);
      float cA = mh >= 0.0 ? 0.0 : cr.a;
      if (mh >= 0.0) {
        hitQ[bounce] = cp + cd * hd;
        hitDir[bounce] = cd;
        hitHeat[bounce] = mh;
        hitTIR[bounce] = bounce == 1;
      }
      vec3 m = blockNormal(ex, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
      if (bounce == 0) {
        inside = cr.rgb;
        hitW[0] = vec3(mh >= 0.0 ? cr.a : 0.0);
        firstA = cA;
        hitDist = hd;
        effBlurDist = hd;
        firstExit = ex;
        if (cA <= 0.02) break;
        vec3 out1 = refract(cd, -m, iorEff);
        leave = dot(out1, out1) > 0.0
          ? 1.0 - (f0 + (1.0 - f0) * pow(1.0 - clamp(dot(out1, m), 0.0, 1.0), 5.0))
          : 0.0;
        beyond = leave > 0.0 ? sampleBackground(posToWorld(ex, uHalfSize.y + uLift, uBlockRot), dirToWorld(out1, uBlockRot), 1.4) * leave : vec3(0.0);
        if (!(leave < 0.96 && glassFade > 0.05)) {
          effBlurDist = max(effBlurDist, 0.55);
          break;
        }
        cp = ex - m * 0.005;
        cd = reflect(cd, -m);
      } else {
        vec3 out2 = refract(cd, -m, iorEff);
        if (dot(out2, out2) == 0.0) out2 = reflect(cd, -m);
        tirShare = firstA * (1.0 - leave);
        // Frosted faces scatter most of what they would mirror back out of the block: the copies are dim as well as blurred.
      float tirKeep = mix(0.2, 0.04, uFrost);
      beyond += (1.0 - leave) * glassFade * tirKeep * (cr.rgb + cA * sampleBackground(posToWorld(ex, uHalfSize.y + uLift, uBlockRot), dirToWorld(out2, uBlockRot), 1.4));
        // The metal's mirrored copies are left out (the reference shows none); its glow still reflects, faintly.
        hitW[1] = vec3(0.0);
        effBlurDist = max(effBlurDist, hitDist + hd * 0.52 + 0.14);
      }
    }
    if (firstA > 0.02) {
      float path = length(firstExit - pFront);
      vec3 absorb = exp(-vec3(0.26, 0.24, 0.22) * path * glassFade);
      inside += firstA * beyond * absorb;
      hitW[1] *= firstA * absorb;
    } else {
      hitW[1] = vec3(0.0);
    }

    float localFrost = surfaceFrost3D(pFront, nFront, uHalfSize);
    float maxSpan = max(uHalfSize.x, uHalfSize.z) * 2.0;
    float depthFrac = clamp(effBlurDist / maxSpan, 0.0, 1.0);
    float depthCoC = smoothstep(0.05, 0.78, depthFrac);
    float surfaceCoC = localFrost * localFrost * 0.22 * smoothstep(0.03, 0.28, depthFrac);
    coc = clamp(uFrost * (depthCoC * (0.65 + 0.55 * localFrost) + surfaceCoC), 0.012, 1.0) * glassFade;
  }

  // Every metal hit shaded at this one call site.
  for (int k = 0; k < 2 + uLoop; k++) {
    if (hitHeat[k] < 0.0 || max(hitW[k].x, max(hitW[k].y, hitW[k].z)) <= 0.0) continue;
    inside += hitW[k] * shadeHit(hitQ[k], hitDir[k], hitHeat[k], hitTIR[k], toLightObj, breath);
  }

  if (airT >= 0.0) {
    // Encode exact bare-metal hit distance in negative alpha (HalfFloat) so the final pass
    // stops the volumetric spotlight shaft at the exact pixel silhouette without re-marching.
    outColor = vec4(inside, -airT);
    return;
  }
  outColor = vec4(mix(baseScene, inside, glassFade), coc);
}
`;

// Separable Gaussian blur for the frost pyramid (1/2, 1/4, 1/8), masked to the glass only: whatever is behind it,
// near or far, spreads.
const PYRAMID_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uDir;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  const float w0 = 0.2270270270;
  const float w1 = 0.3162162162;
  const float w2 = 0.0702702703;
  vec4 s0 = textureLod(tInput, vUv, 0.0);
  vec4 s1a = textureLod(tInput, clamp(vUv + uDir * 1.38461538, vec2(0.002), vec2(0.998)), 0.0);
  vec4 s1b = textureLod(tInput, clamp(vUv - uDir * 1.38461538, vec2(0.002), vec2(0.998)), 0.0);
  vec4 s2a = textureLod(tInput, clamp(vUv + uDir * 3.23076923, vec2(0.002), vec2(0.998)), 0.0);
  vec4 s2b = textureLod(tInput, clamp(vUv - uDir * 3.23076923, vec2(0.002), vec2(0.998)), 0.0);

  float m0 = step(0.008, s0.a);
  float m1a = step(0.008, s1a.a);
  float m1b = step(0.008, s1b.a);
  float m2a = step(0.008, s2a.a);
  float m2b = step(0.008, s2b.a);

  float tw = w0 * m0 + w1 * (m1a + m1b) + w2 * (m2a + m2b);
  if (tw < 1e-4) {
    outColor = vec4(0.0);
    return;
  }
  vec4 acc = s0 * (w0 * m0) + (s1a * m1a + s1b * m1b) * w1 + (s2a * m2a + s2b * m2b) * w2;
  outColor = acc / tw;
}
`;

// Final pass: the frost blur of the interior, the glass surface over it, the cast in open air, the spot and dust.
const FINAL_GLASS_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
// Always 0: a bound the shader compiler can't see through keeps loops as loops (Direct3D unrolls fixed ones, slowly).
uniform int uLoop;

uniform sampler2D tL0;
uniform sampler2D tL1;
uniform sampler2D tL2;
uniform sampler2D tL3;
uniform sampler2D tL4;
uniform sampler2D tDepth;
uniform sampler2D tScene;
uniform vec3 uPlinthHalf;
uniform float uPlinthCenterY;
uniform sampler3D tBurrow;
uniform sampler3D tGlow;
uniform sampler3D tNoise;
uniform float uMarks;
uniform float uMarkScale;

// Solid frost: a 3D field in the block's own space, read wherever the ray meets the glass, so every shape gets it
// without any mapping; tNoise carries each sample's gradient for the sheen.
// How frosted the surface is at p: an even sanded haze, softly uneven, heavier toward the edges.
float surfaceFrost3D(vec3 p, vec3 n, vec3 halfSize) {
  vec3 ap = abs(p) / max(halfSize, vec3(0.01));
  float faceEdge = max(min(ap.x, ap.z), max(min(ap.x, ap.y), min(ap.y, ap.z)));
  float edgeBoost = smoothstep(0.6, 0.98, faceEdge) * 0.22;
  float uneven = textureLod(tNoise, p * 0.06 + 0.41, 0.0).r;
  return clamp(0.45 + 0.3 * (uneven - 0.5) + edgeBoost, 0.05, 1.0);
}

uniform vec2 uAspectScale;
uniform mat4 inverseViewProjection;
uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform float uPixelAngle;
uniform float uLift;
uniform vec2 uJitter;

uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 lightDirection;
uniform vec3 lightColor;

uniform int uShapeType;
uniform vec3 uHalfSize;
uniform float uBevel;
uniform float uHoleR;
uniform float uBlockRot;
uniform float uGlassMix;
uniform float uFrost;
uniform float uIor;
uniform float uHeatIntensity;
uniform float uPour;
uniform float uPulseTime;
uniform float uVoxel;
uniform float uUltra;
uniform vec3 uMetalColor;
uniform float uMetalRough;
uniform float uFinishMode;
uniform float uSpotShaft;
uniform float uPoolGain;

in vec2 vUv;
layout(location = 0) out vec4 outColor;

const float EXTENT = ${EXTENT.toFixed(4)};
const float INV_2EXT = ${(0.5 / EXTENT).toFixed(6)};
const float TWO_BAND = ${(2 * BAND).toFixed(2)};

${COMMON_SDF_GLSL}

vec3 sampleEnv(vec3 d, float rough) {
  return textureLod(envMap, envRotation * d, envMapMaxLod * clamp(rough, 0.0, 1.0)).rgb * envIntensity;
}

float sceneDistFromDepth(vec2 ndc, vec3 roW) {
  float depth = textureLod(tDepth, vUv, 0.0).r;
  if (depth >= 0.9999) return 14.0;
  vec4 wp = inverseViewProjection * vec4(ndc, depth * 2.0 - 1.0, 1.0);
  return length(wp.xyz / wp.w - roW);
}

float burrowSdfFast(vec3 q) {
  vec3 uvw = q * INV_2EXT + 0.5;
  if (any(lessThan(uvw, vec3(0.005))) || any(greaterThan(uvw, vec3(0.995)))) return TWO_BAND * 0.5 * uVoxel;
  vec4 s = textureLod(tBurrow, uvw, 0.0);
  float d = (0.5 - s.x) * TWO_BAND * uVoxel;
  if (uPour < 0.999) {
    float streamProg = clamp(uPour / 0.48, 0.0, 1.0);
    float dStreamTip = (s.z - mix(-0.04, 1.08, streamProg)) * 0.55;
    float dStream = smax(d + 0.008, dStreamTip, 0.016);
    float poolProg = smoothstep(0.32, 0.96, uPour);
    float dPool = smax(d, max((s.w - mix(-0.04, 1.08, poolProg)) * 0.60, dStreamTip), 0.022);
    d = smin(dStream, dPool, 0.018);
  }
  return d;
}

// Lightweight 12-step jittered volumetric gallery spotlight shaft aligned with key lightDirection,
// with exact shape-matched glass shadow (sdBlock), cast-metal burrow shadow (burrowSdfFast),
// plinth occlusion, and subtle drifting tNoise air dust.
// How much of the spot reaches p: blocked by the plinth, dimmed through the frosted glass, shadowed by the cast.
// How much of the spot reaches p looking back along Lw: blocked by the plinth (when asked), dimmed through the frosted
// glass, shadowed by the cast.
float spotVisibility(vec3 p, vec3 Lw, bool withPlinth, vec3 gCenter, vec3 gHalf) {
  vec3 lDirLocal = dirToLocal(Lw, uBlockRot);
  vec2 pHit = intersectBox(p - vec3(0.0, -0.925, 0.0), Lw, vec3(1.325, 0.925, 1.325));
  if (withPlinth && pHit.x <= pHit.y && pHit.y > 0.02) return 0.0;
  float occ = 1.0;
  vec3 pLoc = toLocal(p, uHalfSize.y + uLift, uBlockRot);
  if (uGlassMix > 0.02) {
    vec2 gHit = intersectBox(pLoc - gCenter, lDirLocal, gHalf);
    if (gHit.x <= gHit.y && gHit.y > 0.02) {
      float ts = max(gHit.x, 0.01);
      float minDg = 1.0;
      for (int s = 0; s < 6 + uLoop; s++) {
        float dg = sdBlock(pLoc + lDirLocal * ts, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
        minDg = min(minDg, dg);
        if (dg < 0.004) break;
        ts += max(dg, 0.03);
        if (ts > gHit.y) break;
      }
      float inGlass = 1.0 - smoothstep(-0.01, 0.035, minDg);
      // On surfaces (no plinth test) the frosted block scatters the light it passes: a paler shadow.
      occ *= mix(1.0, withPlinth ? mix(0.70, 0.30, uGlassMix) : mix(0.85, 0.6, uGlassMix), inGlass);
    }
  }
  vec2 mHit = intersectBox(pLoc, lDirLocal, uHalfSize);
  if (mHit.x <= mHit.y && mHit.y > 0.02) {
    float ts = max(mHit.x, 0.01);
    float minDm = 1.0;
    for (int s = 0; s < 8 + uLoop; s++) {
      float dm = burrowSdfFast(pLoc + lDirLocal * ts);
      minDm = min(minDm, dm);
      if (dm < 0.005) break;
      ts += max(dm * 0.9, 0.04);
      if (ts > mHit.y) break;
    }
    // Through frosted glass the cast's shadow spreads out and fades; in the haze it stays crisp.
    float spread = withPlinth ? 0.045 : 0.045 + 0.35 * uFrost * uGlassMix;
    occ *= mix(1.0, smoothstep(-0.005, spread, minDm), withPlinth ? 1.0 : 1.0 - 0.45 * uFrost * uGlassMix);
  }
  return occ;
}

// Where the beam lands on the plinth, floor or backdrop: how much brighter the surface gets.
// On surfaces inside the cone: x how much the glass and the cast shade them (along the key, so they line up with the
// key's own plinth shadow), y how much brighter the beam makes them when the room is lit too.
vec2 spotPool(vec3 p) {
  if (uSpotShaft < 0.005) return vec2(0.0);
  vec3 Lw = normalize(lightDirection);
  vec3 spotPos = vec3(0.0, uHalfSize.y * 0.65, 0.0) + Lw * 6.8;
  vec3 v = p - spotPos;
  float radial = smoothstep(0.962, 0.992, dot(normalize(v), -Lw));
  if (radial <= 0.001) return vec2(0.0);
  float curHy = max(uHalfSize.y * uGlassMix, 0.004);
  float vis = spotVisibility(p + Lw * 0.02, Lw, false, vec3(0.0, -uHalfSize.y + curHy, 0.0), vec3(uHalfSize.x, curHy, uHalfSize.z));
  return vec2(radial * (1.0 - vis), radial * vis * uSpotShaft * 1.6 * uPoolGain / (1.0 + dot(v, v) * 0.02));
}

// Gallery spot along the key: a beam of lit haze with a defined edge, brighter looking into it (forward scattering),
// shadowed by the plinth, the glass and the cast, with dust motes drifting through it.
vec3 computeSpotShaft(vec3 roW, vec3 rdW, float tMax) {
  if (uSpotShaft < 0.005) return vec3(0.0);
  vec3 Lw = normalize(lightDirection);
  vec3 spotTarget = vec3(0.0, uHalfSize.y * 0.65, 0.0);
  vec3 spotPos = spotTarget + Lw * 6.8;
  vec3 spotDir = -Lw;

  // Bounds: the whole cone, from the lamp down past the floor.
  vec3 sc = roW - (spotTarget + Lw * 1.7);
  float b = dot(sc, rdW);
  float c = dot(sc, sc) - 6.2 * 6.2;
  float disc = b * b - c;
  if (disc <= 0.0) return vec3(0.0);
  float sDisc = sqrt(disc);
  float t0 = max(0.15, -b - sDisc);
  float t1 = min(min(tMax, 24.0), -b + sDisc);
  if (t1 <= t0) return vec3(0.0);

  float curHy = max(uHalfSize.y * uGlassMix, 0.004);
  vec3 gCenter = vec3(0.0, -uHalfSize.y + curHy, 0.0);
  vec3 gHalf = vec3(uHalfSize.x, curHy, uHalfSize.z);

  // Henyey-Greenstein, relative to isotropic.
  const float g = 0.45;
  float cosT = dot(rdW, Lw);
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);

  const int STEPS = 20;
  float dt = (t1 - t0) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float acc = 0.0;
  for (int i = 0; i < STEPS + uLoop; i++) {
    vec3 p = roW + rdW * (t0 + (float(i) + jitter) * dt);
    vec3 v = p - spotPos;
    float dist = length(v);
    float radial = smoothstep(0.966, 0.99, dot(v / max(dist, 1e-4), spotDir));
    if (radial <= 0.001) continue;
    float occ = spotVisibility(p, normalize(spotPos - p), true, gCenter, gHalf);
    if (occ <= 0.001) continue;
    // Out of the dark near the lamp, then a gentle falloff all the way to where it lands.
    float falloff = smoothstep(0.6, 3.0, dist) / (1.0 + dist * dist * 0.02);
    float haze = 0.6 + 0.8 * textureLod(tNoise, p * 0.16 + vec3(0.0, -uPulseTime * 0.012, uPulseTime * 0.007), 0.0).r;
    acc += pow(radial, 1.3) * falloff * occ * haze * dt;
  }
  vec3 beam = vec3(0.98, 0.95, 0.91) * acc * phase * uSpotShaft * 0.3;

  // Dust motes: one per few grid cells, found by walking the cells the ray crosses inside the beam.
  const float CELL = 0.16;
  // The air's slow drift, turning over time; each mote also wanders on its own within its cell.
  float tt = uPulseTime;
  vec3 drift = vec3(0.012 * tt + 0.05 * sin(tt * 0.031), -0.012 * tt + 0.04 * sin(tt * 0.023 + 1.0), 0.006 * tt + 0.05 * cos(tt * 0.027));
  float focusDist = length(cameraPos - vec3(0.0, uHalfSize.y, 0.0));
  // Walk the cells around where the view ray passes closest to the beam's axis.
  vec3 w0 = roW - spotPos;
  float bd = dot(rdW, spotDir), dd = dot(rdW, w0), ed = dot(spotDir, w0);
  float tAxis = clamp((bd * ed - dd) / max(1.0 - bd * bd, 1e-4), t0, t1);
  float ts = max(t0, tAxis - 2.6);
  float te = min(t1, tAxis + 2.6);
  vec3 ro = (roW + rdW * ts + drift) / CELL;
  vec3 cell = floor(ro);
  vec3 stepDir = sign(rdW);
  vec3 tDelta = abs(1.0 / max(abs(rdW), vec3(1e-5)));
  vec3 tNext = (stepDir * (cell - ro) + stepDir * 0.5 + 0.5) * tDelta;
  float tCells = (te - ts) / CELL;
  vec3 motes = vec3(0.0);
  for (int i = 0; i < 64 + uLoop; i++) {
    vec3 h = vec3(hash31(cell + 11.7), hash31(cell + 23.1), hash31(cell + 37.9));
    if (h.x > 0.955) {
      vec3 h2 = vec3(hash31(cell + 51.3), hash31(cell + 67.7), hash31(cell + 83.1));
      vec3 wob = vec3(sin(tt * (0.11 + 0.2 * h2.x) + h2.y * 30.0), sin(tt * (0.09 + 0.17 * h2.y) + h2.z * 30.0), sin(tt * (0.13 + 0.15 * h2.z) + h2.x * 30.0));
      vec3 m = (cell + 0.5 + (h - 0.5) * 0.5 + wob * 0.2) * CELL - drift;
      vec3 v = m - spotPos;
      float radial = smoothstep(0.966, 0.99, dot(normalize(v), spotDir));
      float along = dot(m - roW, rdW);
      float vis = radial > 0.0 && along > t0 && along < tMax ? spotVisibility(m, normalize(spotPos - m), true, gCenter, gHalf) : 0.0;
      vis *= smoothstep(0.6, 3.0, length(v)) / (1.0 + dot(v, v) * 0.02);
      if (vis > 0.0) {
        float r = length(cross(m - roW, rdW));
        float px = along * uPixelAngle;
        // Many faint specks, a few large flakes.
        float grain = h.y * h.y * h.y;
        float size = mix(0.5, 2.6, grain) * px;
        // Out of focus away from the piece: a soft disc holding the same light.
        float blur = abs(along - focusDist) * 0.018;
        float radius = max(size, blur);
        float energy = (size * size) / (radius * radius);
        // Tumbling flakes catch the light now and then.
        float spin = sin(tt * (0.7 + 1.9 * h2.x) + h.z * 50.0) * sin(tt * (0.37 + 0.8 * h2.z) + h2.y * 20.0);
        float glint = 0.35 + 2.2 * pow(max(spin, 0.0), 6.0) * step(0.4, h.z);
        float disc = smoothstep(radius * 1.3, radius * (blur > size ? 0.8 : 0.0), r);
        motes += vec3(1.0, 0.97, 0.92) * disc * energy * (0.4 + 1.6 * grain) * radial * vis * glint * (0.5 + 0.5 * phase) * 1.6;
      }
    }
    float tmin = min(tNext.x, min(tNext.y, tNext.z));
    if (tmin > tCells) break;
    vec3 msk = step(tNext.xyz, vec3(tmin) + 1e-6);
    cell += stepDir * msk;
    tNext += tDelta * msk;
  }
  return beam + motes * uSpotShaft;
}

// Single-level mip pick (Fast) vs full 4-level linearly interpolated pyramid (Ultra).
// One bilinear tap of pyramid level i (0 = full resolution).
vec4 levelTap(int i, vec2 uv) {
  if (i <= 0) return textureLod(tL0, uv, 0.0);
  if (i == 1) return textureLod(tL1, uv, 0.0);
  if (i == 2) return textureLod(tL2, uv, 0.0);
  if (i == 3) return textureLod(tL3, uv, 0.0);
  return textureLod(tL4, uv, 0.0);
}

// Cubic B-spline lookup of level i from four bilinear taps, so the low-resolution levels upsample without blocks.
vec4 levelCubic(int i, vec2 uv) {
  if (i <= 0) return textureLod(tL0, uv, 0.0);
  vec2 size = vec2(i == 1 ? textureSize(tL1, 0) : i == 2 ? textureSize(tL2, 0) : i == 3 ? textureSize(tL3, 0) : textureSize(tL4, 0));
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  vec2 c = p - f;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (c - 0.5 + w1 / g0) / size, h1 = (c + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * levelTap(i, vec2(h0.x, h0.y)) + g1.x * levelTap(i, vec2(h1.x, h0.y))) +
    g1.y * (g0.x * levelTap(i, vec2(h0.x, h1.y)) + g1.x * levelTap(i, vec2(h1.x, h1.y)));
}

// The frost pyramid at a fractional level, blended between levels (level 4 only in Ultra).
vec4 samplePyramidSmooth(vec2 uv, float lvl) {
  uv = clamp(uv, vec2(0.002), vec2(0.998));
  float top = uUltra < 0.5 ? 3.0 : 4.0;
  lvl = clamp(lvl, 0.0, top);
  int i0 = int(min(floor(lvl), top - 1.0));
  float f = lvl - float(i0);
  vec4 a = levelCubic(i0, uv);
  vec4 b = levelCubic(i0 + 1, uv);
  return mix(a, b, f);
}

// The interior seen through the frosted face: blurred by depth from the silhouette-masked pyramid, and with streak > 0
// stretched along dirPx (a screen direction) and narrowed across it, by a line of taps each blurred across.
vec3 frostInterior(vec3 c, float coc, vec2 dirPx, float streak) {
  if (uFrost <= 0.02 || coc <= 0.0) return c;
  bool ultra = uUltra > 0.5;
  vec2 size = vec2(textureSize(tL0, 0));
  // One blur for the region: the depth blur averaged over a wide neighbourhood, so it changes smoothly across the
  // face instead of jumping at every silhouette behind it.
  float depthRatio = coc / max(uFrost, 0.05);
  // Near the face, its own small blur; deeper, the region's.
  float cocArea = mix(coc, max(levelCubic(2, vUv).a, coc * 0.5), smoothstep(0.15, 0.55, depthRatio));
  // Frost mostly veils: what is inside the block softens gently; the strong blur is for what lies beyond it.
  float blurPx = (ultra ? 0.054 : 0.050) * cocArea * cocArea * size.y * 0.4;
  float across = blurPx * mix(1.0, 0.5, streak);
  float alongPx = blurPx * streak * 3.0 * uMarkScale;
  // Each tap blurred at least as wide as the gap between taps along the streak, so the streak is continuous.
  float gap = 2.0 * alongPx / 8.0;
  float lvl = clamp(log2(max(max(across * 0.6, gap * 1.1), 1.0)), 0.0, ultra ? 4.0 : 3.0);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  if (streak > 0.01 && dot(dirPx, dirPx) > 0.5) {
    const int N = 9;
    for (int i = 0; i < N + uLoop; i++) {
      float s = (float(i) / float(N - 1)) * 2.0 - 1.0;
      vec4 g = samplePyramidSmooth(vUv + dirPx * s * alongPx / size, lvl);
      float w = exp(-2.0 * s * s) * step(0.005, g.a);
      sum += g.rgb * w;
      wsum += w;
    }
  } else {
    vec4 g = samplePyramidSmooth(vUv, lvl);
    sum = g.rgb * step(0.005, g.a);
    wsum = step(0.005, g.a);
  }
  vec3 gathered = wsum > 0.0 ? sum / wsum : c;
  vec4 deepWash = levelCubic(ultra ? 4 : 3, vUv);
  if (deepWash.a > 0.01) gathered = mix(gathered, deepWash.rgb, smoothstep(0.35, 1.0, cocArea) * 0.32);
  // What lies close behind the face stays sharp over that blur (its light still spreads into the blur around it).
  float near = 1.0 - smoothstep(0.12, 0.5, depthRatio);
  return mix(gathered, c, near);
}

void main() {
  vec4 center = textureLod(tL0, vUv, 0.0);
  float coc = center.a;
  // Rays nudged by this frame's sub-pixel jitter (the glass's own TAA resolves it).
  vec2 ndc = (vUv + uJitter) * 2.0 - 1.0;
  vec4 pNear = inverseViewProjection * vec4(ndc, -1.0, 1.0);
  vec4 pFar = inverseViewProjection * vec4(ndc, 1.0, 1.0);
  vec3 roW = cameraPos;
  vec3 rdW = normalize(pFar.xyz / pFar.w - pNear.xyz / pNear.w);
  float sceneDist = sceneDistFromDepth(ndc, roW);

  // The spotlight (beam and pool) is added once at the end: each branch only says where it stops.
  vec3 base;
  float poolAt = -1.0;
  float shaftMax = sceneDist;
  float shaftGain = 1.0;
  float frontT = 0.0;
  if (coc < 0.002 || uGlassMix < 0.003) {
    base = center.rgb;
    shaftMax = coc < -0.001 ? min(sceneDist, -coc) : sceneDist;
    poolAt = coc > -0.001 && sceneDist < 1e4 ? sceneDist : -1.0;
  } else {

  // 2) Front-surface Fresnel studio reflection + rounded bevel catchlights + tileable tNoise satin grit.
  vec3 ro = toLocal(roW, uHalfSize.y + uLift, uBlockRot);
  vec3 rd = dirToLocal(rdW, uBlockRot);
  float curHy = max(uHalfSize.y * uGlassMix, 0.004);
  vec3 gCenter = vec3(0.0, -uHalfSize.y + curHy, 0.0);
  vec2 boxHit = intersectBox(ro - gCenter, rd, vec3(uHalfSize.x, curHy, uHalfSize.z) + vec3(0.0002));

  float t = max(boxHit.x, 0.0);
  bool hit = false;
  if (boxHit.x <= boxHit.y && boxHit.y > 0.0) {
    for (int i = 0; i < 64 + uLoop; i++) {
      float d = sdBlock(ro + rd * t, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix);
      if (d < 0.0008) {
        hit = true;
        break;
      }
      t += max(d, 0.0005);
      if (t > boxHit.y + 0.01) break;
    }
  }

  if (hit) frontT = t;
  // The frosted face blurs what is behind it, longer down the face than across it (sanded in one direction): the
  // direction is vertical laid onto the surface, round where the surface is level.
  vec3 pFront = ro + rd * t;
  vec3 nFront = hit ? blockNormal(pFront, uShapeType, uHalfSize, uBevel, uHoleR, uGlassMix) : vec3(0.0, 1.0, 0.0);
  vec2 streakDir = vec2(0.0);
  float streak = 0.0;
  if (hit) {
    vec3 nW = dirToWorld(nFront, uBlockRot);
    vec3 down = vec3(0.0, 1.0, 0.0) - nW * nW.y;
    float side = length(down);
    if (side > 0.05) {
      vec3 pW = posToWorld(pFront, uHalfSize.y + uLift, uBlockRot);
      vec4 c0 = viewProjection * vec4(pW, 1.0);
      vec4 c1 = viewProjection * vec4(pW + down / side * 0.05, 1.0);
      vec2 dPx = (c1.xy / c1.w - c0.xy / c0.w) * vec2(textureSize(tL0, 0));
      if (dot(dPx, dPx) > 1e-8) streakDir = normalize(dPx);
      streak = uMarks * smoothstep(0.1, 0.6, side);
    }
  }
  vec3 interiorCol = frostInterior(center.rgb, coc, streakDir, streak);

  if (!hit) {
    base = interiorCol;
    poolAt = sceneDist < 1e4 ? sceneDist : -1.0;
  } else {

  float edgeMask = 1.0 - max(max(abs(nFront.x), abs(nFront.y)), abs(nFront.z));
  float bevelFactor = smoothstep(0.06, 0.35, edgeMask);
  float glassVis = smoothstep(0.003, 0.09, uGlassMix);

  vec3 gwbFront = textureLod(tGlow, clamp(pFront * INV_2EXT + 0.5, vec3(0.01), vec3(0.99)), 0.0).rgb;
  float localFrost = surfaceFrost3D(pFront, nFront, uHalfSize);
  float frostAmt = uFrost * localFrost;

  // Fine sanded grain on the normal, less on the polished bevels: hashed per tiny cell, so it never repeats.
  vec3 gc = floor(pFront * 320.0);
  vec3 grainN = vec3(hash31(gc), hash31(gc + 17.3), hash31(gc + 41.9)) * 2.0 - 1.0;
  // Gone where a grain cell gets smaller than a pixel, so it never sparkles.
  float grainVis = 1.0 - smoothstep(0.5, 1.0, length(fwidth(pFront)) * 320.0);
  float fineGrit = mix(0.5, hash31(gc + 7.7), grainVis);
  vec3 nMic = normalize(nFront + (grainN - nFront * dot(grainN, nFront)) * (0.01 + 0.02 * frostAmt) * grainVis * (1.0 - bevelFactor));
  vec3 nMicW = normalize(dirToWorld(nMic, uBlockRot));
  vec3 nFrontW = normalize(dirToWorld(nFront, uBlockRot));

  float ndv = clamp(dot(-rdW, nMicW), 0.0, 0.9999);
  float f0 = (uIor - 1.0) / (uIor + 1.0);
  f0 *= f0;
  float fresnel = (f0 + (1.0 - f0) * pow(max(1.0 - ndv, 1e-4), 3.8)) * glassVis;

  vec3 reflDir = reflect(rdW, nMicW);
  float surfRough = mix(0.03, 0.46, frostAmt) * mix(1.0, 0.22, bevelFactor);
  vec3 envRefl = sampleEnv(reflDir, surfRough);
  vec3 crispRefl = sampleEnv(reflect(rdW, nFrontW), 0.04 + 0.08 * frostAmt);
  vec3 totalEnvRefl = mix(envRefl, crispRefl, clamp(0.28 + 0.52 * bevelFactor - 0.18 * frostAmt, 0.08, 0.85));

  // The plinth in the reflection: the reflected ray against the plinth's box. Its colour is the frame's where that
  // point is on screen and not hidden, else dark slate warmed by the embers.
  {
    vec3 pW = posToWorld(pFront, uHalfSize.y + uLift, uBlockRot) + nFrontW * 0.003;
    vec2 ph = intersectBox(pW - vec3(0.0, uPlinthCenterY, 0.0), reflDir, uPlinthHalf);
    if (ph.x <= ph.y && ph.y > 0.0) {
      vec3 H = pW + reflDir * max(ph.x, 0.0);
      vec3 plinthCol = vec3(0.012, 0.012, 0.013) + vec3(1.0, 0.38, 0.08) * 0.08 * uHeatIntensity * exp(-length(H.xz) * 1.2);
      vec4 clip = viewProjection * vec4(H, 1.0);
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (clip.w > 0.0 && all(greaterThan(uv, vec2(0.002))) && all(lessThan(uv, vec2(0.998)))) {
        vec4 seen = inverseViewProjection * vec4(uv * 2.0 - 1.0, textureLod(tDepth, uv, 0.0).r * 2.0 - 1.0, 1.0);
        // Blended by how well the frame's surface there matches the hit, so the switch never flickers.
        plinthCol = mix(plinthCol, textureLod(tScene, uv, 0.0).rgb, 1.0 - smoothstep(0.03, 0.15, length(seen.xyz / seen.w - H)));
      }
      // Soft where the ray only grazes a corner of the box.
      totalEnvRefl = mix(totalEnvRefl, plinthCol, smoothstep(0.0, 0.03, ph.y - max(ph.x, 0.0)));
    }
  }

  // Top-face reflection of exposed upper sculpture when glass is partially lowered.
  float topReflMask = smoothstep(0.42, 0.85, nFront.y) * smoothstep(0.98, 0.88, uGlassMix);
  if (topReflMask > 0.005 && burrowSdfFast(pFront) > 0.006) {
    vec3 rdR = reflect(rd, nFront);
    vec3 roR = pFront + nFront * 0.014;
    float tr = 0.02;
    for (int i = 0; i < 24 + uLoop; i++) {
      vec3 qr = roR + rdR * tr;
      float dr = burrowSdfFast(qr);
      if (dr < 0.004) {
        float eR = max(uVoxel * 0.85, 0.006);
        vec3 nRg = vec3(0.0);
        for (int j = 0; j < 4 + uLoop; j++) {
          vec3 k = tetraOffset(j) * eR;
          nRg += k * burrowSdfFast(qr + k);
        }
        vec3 nRW = normalize(dirToWorld(length(nRg) > 1e-5 ? normalize(nRg) : vec3(0.0, 1.0, 0.0), uBlockRot));
        vec3 vRW = normalize(dirToWorld(-rdR, uBlockRot));
        float ndlR = max(dot(nRW, normalize(lightDirection)), 0.0);
        vec3 envR = sampleEnv(reflect(-vRW, nRW), uMetalRough + 0.12);
        float gR = textureLod(tGlow, clamp(qr * INV_2EXT + 0.5, vec3(0.01), vec3(0.99)), 0.0).r * uHeatIntensity;
        vec3 mRefl = uMetalColor * (envR * 0.85 + lightColor * ndlR * 0.28) + vec3(1.0, 0.36, 0.05) * gR * 1.2;
        float atten = exp(-tr * 1.35) * (1.0 - 0.55 * frostAmt) * topReflMask;
        totalEnvRefl = mix(totalEnvRefl, mRefl, clamp(atten * 0.80, 0.0, 0.80));
        break;
      }
      tr += max(dr * 0.9, 0.018);
      if (tr > 1.8) break;
    }
  }

  vec3 Lw = normalize(lightDirection);
  vec3 H = (Lw - rdW) / max(length(Lw - rdW), 1e-4);
  float ndh = clamp(dot(nMicW, H), 1e-4, 1.0);
  float specPow = mix(220.0, 22.0, frostAmt) * mix(1.0, 3.2, bevelFactor);
  vec3 keySpec = lightColor * pow(ndh, specPow) * mix(0.08, 0.24, bevelFactor) * glassVis;

  float breath = 0.90 + 0.10 * sin(uPulseTime * 1.45);
  float edgeGlow = gwbFront.r * uHeatIntensity * breath;
  float keyDiff = max(dot(nFrontW, Lw), 0.0);
  float topSheen = smoothstep(0.55, 0.98, nFront.y);
  float grazing = pow(1.0 - ndv, 2.0);
  vec3 satinLight = (vec3(0.16, 0.163, 0.17) * (0.35 + 0.85 * keyDiff + 0.55 * topSheen) + sampleEnv(nFrontW, 0.85) * 0.25) * (0.7 + 0.6 * fineGrit);
  vec3 warmSkin = vec3(1.0, 0.38, 0.06) * edgeGlow * (0.38 + 0.45 * frostAmt);
  // The frosted skin itself: a light film, heavier toward the edges and at grazing angles.
  float satinAlpha = clamp(localFrost * (0.15 + 0.35 * uFrost) * (0.35 + 0.5 * grazing + 0.15 * topSheen) * (0.94 + 0.12 * fineGrit) * (1.0 - bevelFactor * 0.72), 0.0, 0.5) * glassVis;

  vec3 bevelCol = (vec3(0.20, 0.21, 0.23) * (0.45 + 0.55 * keyDiff) + vec3(1.0, 0.42, 0.06) * edgeGlow * 0.6) * bevelFactor * (0.35 + 0.5 * (1.0 - ndv)) * glassVis;
  float botRim = smoothstep(-uHalfSize.y + 0.1, -uHalfSize.y + 0.004, pFront.y);
  vec3 botCol = vec3(1.0, 0.38, 0.05) * edgeGlow * botRim * 0.28 * glassVis;

  vec3 bodyCol = mix(interiorCol, satinLight, satinAlpha) + warmSkin * satinAlpha * 1.4;
  float reflGain = (0.88 + 0.65 * bevelFactor + 0.35 * topSheen);
  vec3 finalCol = bodyCol * (1.0 - fresnel * 0.45) + totalEnvRefl * fresnel * reflGain + keySpec + bevelCol + botCol;
  base = finalCol;
  shaftMax = min(sceneDist, t);
  shaftGain = 0.65;
  }
  }
  vec2 pool = poolAt >= 0.0 ? spotPool(roW + rdW * poolAt) : vec2(0.0);
  // Alpha: how far the glass is along this ray (0 off the glass), for the temporal resolve.
  outColor = vec4(base * (1.0 + pool.y) + computeSpotShaft(roW, rdW, shaftMax) * shaftGain, frontT);
}
`;

// The glass's own temporal antialiasing: where the glass is, this frame (jittered) is blended with last frame's result
// at the same point of the glass (reprojected through the camera and the block's spin), clamped to this frame's
// neighbourhood so nothing ghosts. Elsewhere this frame passes through (the pipeline already antialiased it).
const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform mat4 inverseViewProjection;
uniform mat4 prevViewProjection;
uniform vec3 cameraPos;
uniform float dRot;
uniform float dLift;
uniform float hasHistory;
uniform float feedback;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 cur = textureLod(tCurrent, vUv, 0.0);
  if (cur.a <= 0.0 || hasHistory < 0.5) { outColor = vec4(cur.rgb, 1.0); return; }
  vec4 far = inverseViewProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 p = cameraPos + normalize(far.xyz / far.w - cameraPos) * cur.a;
  // Where that point of the glass was before this frame's spin about the vertical axis.
  p.y -= dLift;
  float c = cos(dRot), s = sin(dRot);
  p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  vec4 pc = prevViewProjection * vec4(p, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { outColor = vec4(cur.rgb, 1.0); return; }
  vec2 texel = 1.0 / vec2(textureSize(tCurrent, 0));
  // Variance clip: the history is kept within the neighbourhood's mean +- 1.25 sigma, which holds steady where a
  // small highlight comes and goes with the jitter instead of letting it through.
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 n = textureLod(tCurrent, vUv + vec2(x, y) * texel, 0.0).rgb;
    m1 += n;
    m2 += n * n;
  }
  m1 /= 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec3 hist = clamp(textureLod(tHistory, puv, 0.0).rgb, m1 - 1.25 * sigma, m1 + 1.25 * sigma);
  outColor = vec4(mix(cur.rgb, hist, feedback), 1.0);
}
`;

function makeTarget(w, h) {
  return new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

export class GlassBurrow {
  constructor() {
    this.quadGeo = new BufferGeometry();
    this.quadGeo.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      tScene: { value: null },
      tDepth: { value: null },
      tBurrow: { value: null },
      tGlow: { value: null },
      tNoise: { value: getSharedNoiseTexture() },
      inverseViewProjection: { value: new Matrix4() },
      viewProjection: { value: new Matrix4() },
      cameraPos: { value: new Vector3() },
      envMap: globalUniforms.envMap,
      envMapMaxLod: globalUniforms.envMapMaxLod,
      envIntensity: globalUniforms.envIntensity,
      envRotation: globalUniforms.envRotation,
      lightDirection: globalUniforms.lightDirection,
      lightColor: globalUniforms.lightColor,
      uShapeType: { value: 0 },
      uHalfSize: { value: new Vector3(0.96, 0.96, 0.96) },
      uBevel: { value: 0.052 },
      uHoleR: { value: 0.088 },
      uStrata: { value: 0.0 },
      uBlockRot: { value: 0.0 },
      uGlassMix: { value: 1.0 },
      uFrost: { value: 0.65 },
      uIor: { value: 1.5 },
      uHeatIntensity: { value: 1.0 },
      uGrain: { value: 0.8 },
      uBubbles: { value: 0.45 },
      uPour: { value: 1.0 },
      uPourHeat: { value: 0.0 },
      uPourClock: { value: 1e3 },
      uPourRate: { value: 0.24 },
      uCoolTime: { value: 1.6 },
      uPulseTime: { value: 0.0 },
      uVoxel: { value: 0.03 },
      uUltra: { value: 0.0 },
      uMetalColor: { value: new Color("#dfe4ea") },
      uMetalRough: { value: 0.28 },
      uMetalness: { value: 0.96 },
      uUnderRough: { value: 0.11 },
      uFinishMode: { value: 0.0 },
      uSpotShaft: { value: 0.42 },
      uLoop: { value: 0 },
      uMarks: { value: 0.35 },
      uMarkScale: { value: 1 },
      uPoolGain: { value: 0 },
      uPixelAngle: { value: 0.001 },
      uLift: { value: 0 },
      uJitter: { value: new Vector2() },
      uPlinthHalf: { value: new Vector3(1.325, 0.89, 1.325) },
      uPlinthCenterY: { value: -0.89 },
    };

    this.interiorMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: INTERIOR_FRAGMENT,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.interiorScene = new Scene();
    this.interiorScene.add(new Mesh(this.quadGeo, this.interiorMat));

    this.pyrBlurMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: PYRAMID_BLUR_FRAGMENT,
      uniforms: {
        tInput: { value: null },
        uDir: { value: new Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pyrBlurScene = new Scene();
    this.pyrBlurScene.add(new Mesh(this.quadGeo, this.pyrBlurMat));

    this.finalMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: FINAL_GLASS_FRAGMENT,
      uniforms: {
        ...this.uniforms,
        tL0: { value: null },
        tL1: { value: null },
        tL2: { value: null },
        tL3: { value: null },
        tL4: { value: null },
        uAspectScale: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.finalScene = new Scene();
    this.finalScene.add(new Mesh(this.quadGeo, this.finalMat));

    this.resolveMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: RESOLVE_FRAGMENT,
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        inverseViewProjection: { value: new Matrix4() },
        prevViewProjection: { value: new Matrix4() },
        cameraPos: this.uniforms.cameraPos,
        dRot: { value: 0 },
        dLift: { value: 0 },
        hasHistory: { value: 0 },
        feedback: { value: 0.92 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.resolveScene = new Scene();
    this.resolveScene.add(new Mesh(this.quadGeo, this.resolveMat));
    this.history = [null, null];
    this.historyIndex = 0;
    this.hasHistory = false;
    this.frame = 0;
    this._prevVP = new Matrix4();
    this._prevRot = 0;
    this._prevLift = 0;
    this._prevMix = 0;
    this._prevPour = 0;

    this.tA = null;
    this.tOut = null;
    this.pyrA = [null, null, null, null];
    this.pyrB = [null, null, null, null];
    this.width = 0;
    this.height = 0;
    this._vp = new Matrix4();
  }

  _ensureTargets(w, h) {
    if (this.width === w && this.height === h && this.tOut) return;
    this.width = w;
    this.height = h;
    this.tA?.dispose();
    this.tOut?.dispose();
    this.tA = makeTarget(w, h);
    this.tOut = makeTarget(w, h);
    for (let i = 0; i < 2; i++) {
      this.history[i]?.dispose();
      this.history[i] = makeTarget(w, h);
    }
    this.hasHistory = false;
    const scales = [2, 4, 8, 16];
    for (let i = 0; i < 4; i++) {
      this.pyrA[i]?.dispose();
      this.pyrB[i]?.dispose();
      const bw = Math.max(1, Math.floor(w / scales[i]));
      const bh = Math.max(1, Math.floor(h / scales[i]));
      this.pyrA[i] = makeTarget(bw, i === 0 ? h : Math.max(1, Math.floor(h / scales[i - 1])));
      this.pyrB[i] = makeTarget(bw, bh);
    }
  }

  // Compiles the three passes in parallel while loading, each with a target bound as when it draws.
  compile(renderer) {
    this._ensureTargets(Math.max(this.width, 2), Math.max(this.height, 2));
    const prev = renderer.getRenderTarget();
    const jobs = [];
    for (const scene of [this.interiorScene, this.pyrBlurScene, this.finalScene, this.resolveScene]) {
      renderer.setRenderTarget(this.tA);
      jobs.push(renderer.compileAsync(scene, this.camera));
    }
    renderer.setRenderTarget(prev);
    return Promise.all(jobs);
  }

  setVolume({ spec, burrowTex, glowTex, voxel }) {
    this.uniforms.uShapeType.value = spec.type;
    this.uniforms.uHalfSize.value.set(spec.hx, spec.hy, spec.hz);
    this.uniforms.uBevel.value = spec.bevel;
    this.uniforms.uHoleR.value = spec.holeR;
    this.uniforms.uStrata.value = spec.strata;
    this.uniforms.tBurrow.value = burrowTex;
    this.uniforms.tGlow.value = glowTex;
    this.uniforms.uVoxel.value = voxel;
  }

  render(renderer, hdr, { depthTexture, camera, width, height }) {
    if (!this.uniforms.tBurrow.value) return hdr;
    this._ensureTargets(width, height);
    const prev = renderer.getRenderTarget();

    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.uniforms.viewProjection.value.copy(this._vp);
    this.uniforms.inverseViewProjection.value.copy(this._vp).invert();
    this.uniforms.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    this.uniforms.uPixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (camera.zoom * height);
    const k = (this.frame++ % 8) + 1;
    this.uniforms.uJitter.value.set((halton(k, 2) - 0.5) / width, (halton(k, 3) - 0.5) / height);
    this.uniforms.tScene.value = hdr;
    this.uniforms.tDepth.value = depthTexture;

    // Pass 1: Decoupled 3D raymarch + 6-step volumetric scatter + fast TIR.
    renderer.setRenderTarget(this.tA);
    renderer.render(this.interiorScene, this.camera);

    // Pass 2: 3-level (Fast) or 4-level (Ultra) silhouette-masked Gaussian pyramid.
    const levels = this.uniforms.uUltra.value > 0.5 ? 4 : 3;
    if (this.uniforms.uGlassMix.value > 0.003 && this.uniforms.uFrost.value > 0.02) {
      let src = this.tA.texture;
      const scales = [2, 4, 8, 16];
      // Each level halves the one above separably: across in the source's own texels (into pyrA, half as wide), then
      // down in pyrA's (half as tall), so every texel of the larger image is filtered before it is dropped.
      let srcW = width;
      for (let i = 0; i < levels; i++) {
        const prevH = i === 0 ? height : Math.max(1, Math.floor(height / scales[i - 1]));
        this.pyrBlurMat.uniforms.tInput.value = src;
        this.pyrBlurMat.uniforms.uDir.value.set(1.0 / srcW, 0);
        renderer.setRenderTarget(this.pyrA[i]);
        renderer.render(this.pyrBlurScene, this.camera);

        this.pyrBlurMat.uniforms.tInput.value = this.pyrA[i].texture;
        this.pyrBlurMat.uniforms.uDir.value.set(0, 1.0 / prevH);
        renderer.setRenderTarget(this.pyrB[i]);
        renderer.render(this.pyrBlurScene, this.camera);
        src = this.pyrB[i].texture;
        srcW = Math.max(1, Math.floor(width / scales[i]));
      }
    }

    // Pass 3: frost blur and the glass surface.
    this.finalMat.uniforms.tL0.value = this.tA.texture;
    this.finalMat.uniforms.tL1.value = this.pyrB[0].texture;
    this.finalMat.uniforms.tL2.value = this.pyrB[1].texture;
    this.finalMat.uniforms.tL3.value = this.pyrB[2].texture;
    this.finalMat.uniforms.tL4.value = this.pyrB[3].texture;
    this.finalMat.uniforms.uAspectScale.value.set(height / Math.max(width, 1), 1.0);
    renderer.setRenderTarget(this.tOut);
    renderer.render(this.finalScene, this.camera);

    // Temporal resolve into the history ping-pong.
    const r = this.resolveMat.uniforms;
    r.tCurrent.value = this.tOut.texture;
    r.tHistory.value = this.history[this.historyIndex].texture;
    r.inverseViewProjection.value.copy(this._vp).invert();
    r.prevViewProjection.value.copy(this._prevVP);
    r.dRot.value = this.uniforms.uBlockRot.value - this._prevRot;
    r.dLift.value = this.uniforms.uLift.value - this._prevLift;
    // While the resin level or the metal changes, last frame's image is of a different shape: no history (it trails).
    const u = this.uniforms;
    const reshaping = Math.abs(u.uGlassMix.value - this._prevMix) > 1e-5 || Math.abs(u.uPour.value - this._prevPour) > 1e-5;
    this._prevMix = u.uGlassMix.value;
    this._prevPour = u.uPour.value;
    r.hasHistory.value = this.hasHistory && !reshaping ? 1 : 0;
    this.historyIndex = 1 - this.historyIndex;
    renderer.setRenderTarget(this.history[this.historyIndex]);
    renderer.render(this.resolveScene, this.camera);
    this.hasHistory = true;
    this._prevVP.copy(this._vp);
    this._prevRot = this.uniforms.uBlockRot.value;
    this._prevLift = this.uniforms.uLift.value;

    renderer.setRenderTarget(prev);
    return this.history[this.historyIndex].texture;
  }

  dispose() {
    this.tA?.dispose();
    this.tOut?.dispose();
    for (const h of this.history) h?.dispose();
    for (let i = 0; i < 4; i++) {
      this.pyrA[i]?.dispose();
      this.pyrB[i]?.dispose();
    }
    this.quadGeo.dispose();
    this.interiorMat.dispose();
    this.pyrBlurMat.dispose();
    this.finalMat.dispose();
    this.resolveMat.dispose();
  }
}
