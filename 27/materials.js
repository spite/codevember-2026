// Plinth and gallery backdrop PipelineMaterials for Day 27 (Burrow).
// Plinth samples the same 3D volumetric tGlow texture as the frosted glass so the matte slate
// top reflects warm orange light directly beneath the glowing burrow tips.
import { Vector2, Vector3, Color, DoubleSide } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { EXTENT, BAND } from "./volume.js";
import { COMMON_SDF_GLSL } from "./glass.js";

export const METAL_FINISHES = {
  aluminum: { color: "#e4e8ee", roughness: 0.16, metalness: 0.98, undersideRough: 0.08, mode: 0 },
  bronze: { color: "#c2925c", roughness: 0.28, metalness: 0.94, undersideRough: 0.12, mode: 0 },
  gold: { color: "#e0ba60", roughness: 0.24, metalness: 0.97, undersideRough: 0.10, mode: 0 },
  copper: { color: "#d47850", roughness: 0.26, metalness: 0.95, undersideRough: 0.11, mode: 1 },
  iron: { color: "#3d424b", roughness: 0.44, metalness: 0.88, undersideRough: 0.22, mode: 0 },
  bismuth: { color: "#c9d0dc", roughness: 0.20, metalness: 0.96, undersideRough: 0.09, mode: 2 },
  blued: { color: "#7c8796", roughness: 0.26, metalness: 0.94, undersideRough: 0.12, mode: 3 },
};

export const FINISH_NAMES = Object.keys(METAL_FINISHES);

// The gallery spot: the plinth and backdrop are lit only inside its cone, plus as much of the room as uRoom lets in.
export const spotUniforms = {
  uSpotPos: { value: new Vector3(0, 8, 0) },
  uSpotDir: { value: new Vector3(0, -1, 0) },
  uRoom: { value: 0 },
};
// The warm strip tucked under the plinth: it lights the floor around the base and the plinth's lowest edges.
export const baseUniforms = {
  uBaseLight: { value: 1 },
  uBaseColor: { value: new Color(1.0, 0.62, 0.3) },
  uPlinthHalf: { value: new Vector2(1.325, 1.325) },
};
export const BASE_INSET = 0.09;
export const BASE_GAP = 0.07;
export const FLOOR_Y = -1.85;
const BASE_GLSL = /* glsl */ `
uniform float uBaseLight;
uniform vec3 uBaseColor;
uniform vec2 uPlinthHalf;
// Distance outside the strip's rectangle (the toe's outline) on the floor plane.
float baseDistance(vec3 p) {
  vec2 q = abs(p.xz) - (uPlinthHalf - ${BASE_INSET.toFixed(3)});
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
`;
const SPOT_GLSL = /* glsl */ `
uniform vec3 uSpotPos;
uniform vec3 uSpotDir;
uniform float uRoom;
float spotLight(vec3 p) {
  return mix(smoothstep(0.962, 0.992, dot(normalize(p - uSpotPos), uSpotDir)), 1.0, uRoom);
}
`;

const NOISE_GLSL = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
      mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
      mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x),
      f.y
    ),
    f.z
  );
}

float fbm3(vec3 p) {
  float a = 0.0;
  float w = 0.5;
  for (int i = 0; i < 4; i++) {
    a += w * vnoise(p);
    p = p * 2.07 + vec3(13.1, 7.7, 19.3);
    w *= 0.5;
  }
  return a;
}
`;

export function createPlinthMaterial() {
  const uniforms = {
    tGlow: { value: null },
    uHasGlow: { value: 0.0 },
    uHeatIntensity: { value: 1.0 },
    uGlassMix: { value: 1.0 },
    uBlockHalf: { value: new Vector3(0.96, 0.96, 0.96) },
    uBlockType: { value: 0 },
    uBlockRot: { value: 0.0 },
    uPulseTime: { value: 0.0 },
    uBevel: { value: 0.05 },
    uHoleR: { value: 0.08 },
    uLift: { value: 0 },
    uLoop: { value: 0 },
    uKeyLightDir: globalUniforms.lightDirection,
    ...spotUniforms,
    ...baseUniforms,
  };

  return new PipelineMaterial({
    color: "#111215",
    roughness: 0.78,
    metalness: 0.04,
    uniforms,
    fragmentPars: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D tGlow;
      uniform float uHasGlow;
      uniform float uHeatIntensity;
      uniform float uGlassMix;
      uniform vec3 uBlockHalf;
      uniform int uBlockType;
      uniform float uBlockRot;
      uniform float uPulseTime;
      uniform vec3 uKeyLightDir;
      uniform float uBevel;
      uniform float uHoleR;
      uniform float uLift;
      uniform int uLoop;
      ${COMMON_SDF_GLSL.replace(/\bhash(31|2)\b/g, "sdfHash$1")}
      const float INV_2EXT = ${(0.5 / EXTENT).toFixed(6)};
      const float TWO_BAND = ${(2 * BAND).toFixed(2)};
      ${NOISE_GLSL}
      ${SPOT_GLSL}
      ${BASE_GLSL}
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        vec3 wp = vWorldPosition;
        // An even matte finish: only a fine grain, no clouding.
        float slate = mix(0.5, vnoise(wp * 90.0), 0.5);
        float lit = spotLight(wp);
        s.albedo *= mix(0.95, 1.05, slate) * lit;
        s.specular *= lit;
        // The strip's glow coming back up off the floor onto the plinth's lowest edges.
        float low = exp(-max(wp.y - (${(FLOOR_Y + BASE_GAP).toFixed(3)}), 0.0) * 7.0) * (1.0 - abs(s.normal.y));
        s.emissive += uBaseColor * uBaseLight * low * 0.25;
        s.roughness = 0.72 + (0.5 - slate) * 0.04;

        float c = cos(-uBlockRot);
        float sn = sin(-uBlockRot);
        vec2 lp = vec2(wp.x * c - wp.z * sn, wp.x * sn + wp.z * c);
        float topFace = smoothstep(0.6, 0.95, s.normal.y) * smoothstep(-0.04, 0.01, wp.y);

        // The frosted case's shadow, from the spot: dimmer by how far the light travels through it. Worked out here
        // rather than in the shadow map, where a partial shadow is random speckle that only settles on a still view.
        if (uGlassMix > 0.003 && wp.y > -0.05) {
          vec3 lw = normalize(uSpotPos - wp);
          vec3 ld = vec3(lw.x * c - lw.z * sn, lw.y, lw.x * sn + lw.z * c);
          vec3 q0 = vec3(lp.x, wp.y - uBlockHalf.y - uLift, lp.y);
          // Sampled only where the ray crosses the block's bounds.
          vec2 hit = intersectBox(q0, ld, uBlockHalf + 0.05);
          float glass = 0.0;
          if (hit.y > max(hit.x, 0.0)) {
            float t0 = max(hit.x, 0.0);
            float stepLen = (hit.y - t0) / 16.0;
            for (int i = 0; i < 16 + uLoop; i++) {
              float d = sdBlock(q0 + ld * (t0 + (float(i) + 0.5) * stepLen), uBlockType, uBlockHalf, uBevel, uHoleR, uGlassMix);
              // How much of this step's stretch is inside, softened by the lamp's size: a continuous edge.
              glass += clamp(0.5 - d / (stepLen + 0.06), 0.0, 1.0);
            }
            glass *= stepLen;
          }
          float dim = (0.25 * smoothstep(0.0, 0.06, glass) + 0.6 * (1.0 - exp(-0.8 * glass))) * smoothstep(0.003, 0.09, uGlassMix);
          s.albedo *= 1.0 - dim;
          s.specular *= 1.0 - dim;
        }

        if (topFace > 0.01) {
          float footD;
          if (uBlockType == 1 || uBlockType == 5) {
            footD = length(lp) - uBlockHalf.x;
          } else if (uBlockType == 7) {
            // Paperweight flat base radius = sqrt(1.12^2 - 0.60^2) ≈ 0.945.
            footD = length(lp) - 0.945;
          } else if (uBlockType == 3) {
            const vec3 hk = vec3(-0.8660254, 0.5, 0.57735027);
            float hr = uBlockHalf.x * 0.8660254;
            vec2 hq = abs(lp.yx);
            hq -= 2.0 * min(dot(hk.xy, hq), 0.0) * hk.xy;
            footD = length(hq - vec2(clamp(hq.x, -hk.z * hr, hk.z * hr), hr)) * sign(hq.y - hr);
          } else {
            vec2 q = abs(lp) - uBlockHalf.xz;
            footD = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
          }
          // Contact shadow right under and just outside the block's footprint.
          float glassVis = smoothstep(0.0, 0.15, uGlassMix);
          float glassDiff = smoothstep(0.05, 0.45, uGlassMix);
          float onPlinth = exp(-uLift * 6.0);
          float glassShadow = (1.0 - smoothstep(-0.02, 0.22, footD)) * glassVis * onPlinth;

          float bareContact = exp(-dot(lp, lp) * 2.2) * (1.0 - glassVis) * 0.35 * onPlinth;
          float totalShadow = clamp(glassShadow + bareContact, 0.0, 0.92);
          s.occlusion *= mix(1.0, 0.20, totalShadow);

          // Warm orange-amber ember light spill:
          // - Encased: diffused lantern wash radiating softly out from the frosted glass base.
          // - Excavated: sharper, hotter direct pools right underneath each exposed glowing tip.
          if (uHasGlow > 0.5 && uHeatIntensity > 0.001) {
            float breath = 0.90 + 0.10 * sin(uPulseTime * 1.45);
            vec2 edgeXZ = mix(lp, clamp(lp, -uBlockHalf.xz * 0.84, uBlockHalf.xz * 0.84), glassDiff);
            vec3 pLow = vec3(edgeXZ.x, -uBlockHalf.y + 0.20, edgeXZ.y);
            vec3 pMid = vec3(edgeXZ.x * 0.68, -uBlockHalf.y + 0.44, edgeXZ.y * 0.68);
            vec3 uvw1 = clamp(pLow * INV_2EXT + 0.5, vec3(0.01), vec3(0.99));
            vec3 uvw2 = clamp(pMid * INV_2EXT + 0.5, vec3(0.01), vec3(0.99));
            float gNear = textureLod(tGlow, uvw1, 0.0).r;
            float gBroad = textureLod(tGlow, uvw2, 0.0).r;
            float dOut = max(footD, 0.0);
            // Bare tips cast sharper, brighter local pools directly beneath them; frosted glass diffuses wider & softer.
            float nearFall = exp(-dOut * mix(5.8, 3.4, glassDiff));
            float wideFall = exp(-dOut * mix(4.2, 2.2, glassDiff));
            float directPool = pow(max(gNear, 1e-4), 1.25) * nearFall * mix(1.45, 0.92, glassDiff);
            float softWash = gBroad * wideFall * mix(0.16, 0.36, glassDiff);
            float spill = (directPool + softWash) * uHeatIntensity * breath;
            vec3 glowCol = mix(vec3(1.0, 0.26, 0.025), vec3(1.0, 0.60, 0.18), clamp(directPool * 1.25, 0.0, 1.0));
            s.emissive += glowCol * spill * (0.72 + 0.45 * slate) * 0.85 * topFace;
          }
        }
      }
    `,
  });
}

// The recessed toe under the plinth, black, with the warm strip along its top edge.
export function createToeMaterial() {
  return new PipelineMaterial({
    color: "#050506",
    roughness: 0.8,
    uniforms: { ...baseUniforms },
    fragmentPars: BASE_GLSL,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        float strip = smoothstep(${(FLOOR_Y + BASE_GAP - 0.022).toFixed(3)}, ${(FLOOR_Y + BASE_GAP - 0.014).toFixed(3)}, vWorldPosition.y) * (1.0 - abs(s.normal.y));
        s.emissive += uBaseColor * uBaseLight * strip * 30.0;
      }
    `,
  });
}

// An invisible box around the block that only exists in the shadow pass, where it raymarches the cast's distance
// volume toward the key: the cast then shadows the plinth and floor like any mesh, blocked by whatever is in the way.
// The frosted glass blocks the key stochastically, by how much glass the light crosses, so its shadow is partial.
export function createCastShadowMaterial() {
  const uniforms = {
    tBurrow: { value: null },
    uVoxel: { value: 0.03 },
    uPour: { value: 1 },
    uKeyLightDir: globalUniforms.lightDirection,
  };
  return new PipelineMaterial({
    color: "#000000",
    uniforms,
    fragmentPars: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D tBurrow;
      uniform float uVoxel;
      uniform float uPour;
      uniform vec3 uKeyLightDir;
      uniform mat4 modelMatrix;
      const float INV_2EXT = ${(0.5 / EXTENT).toFixed(6)};
      const float TWO_BAND = ${(2 * BAND).toFixed(2)};
      float castSdf(vec3 q) {
        vec3 uvw = q * INV_2EXT + 0.5;
        if (any(lessThan(uvw, vec3(0.005))) || any(greaterThan(uvw, vec3(0.995)))) return 0.05;
        vec4 bs = textureLod(tBurrow, uvw, 0.0);
        float d = (0.5 - bs.x) * TWO_BAND * uVoxel;
        // Mid-pour, only what the front has reached.
        if (uPour < 0.999) d = max(d, (bs.z - mix(-0.04, 1.08, clamp(uPour / 0.48, 0.0, 1.0))) * 0.55);
        return d;
      }
    `,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        s.alpha = 0.0;
      #ifdef PIPELINE_SHADOW
        // From this face of the box, away from the light through the volume: any metal on the way casts.
        vec3 L = normalize(transpose(mat3(modelMatrix)) * normalize(uKeyLightDir));
        float t = 0.0;
        for (int i = 0; i < 64; i++) {
          float d = castSdf(vObjectPosition - L * t);
          if (d < 0.002) { s.alpha = 1.0; break; }
          t += max(d * 0.9, 0.008);
          if (t > 4.5) break;
        }
      #endif
      }
    `,
  });
}

export function createBackdropMaterial() {
  return new PipelineMaterial({
    color: "#151619",
    roughness: 0.94,
    metalness: 0.0,
    side: DoubleSide,
    uniforms: { ...spotUniforms, ...baseUniforms },
    fragmentPars: SPOT_GLSL + BASE_GLSL,
    surface: /* glsl */ `
      void surface(inout Surface s) {
        float r = length(vWorldPosition.xz);
        float h = clamp(vWorldPosition.y * 0.14, 0.0, 1.0);
        float grad = mix(1.1, 0.52, smoothstep(1.5, 11.0, r)) * mix(1.0, 0.68, h);
        float lit = spotLight(vWorldPosition);
        s.albedo *= grad * lit;
        s.specular *= lit;
        // The strip under the plinth: brightest just under its edge, falling off across the floor.
        if (vWorldPosition.y < ${(FLOOR_Y + 0.05).toFixed(3)}) {
          float d = baseDistance(vWorldPosition);
          float pool = smoothstep(-0.02, 0.02, d) * (3.0 * exp(-max(d, 0.0) * 14.0) + 1.2 * exp(-max(d, 0.0) * 4.0) + 0.3 * exp(-max(d, 0.0) * 1.2));
          s.emissive += uBaseColor * uBaseLight * pool * 0.9;
        }
      }
    `,
  });
}
