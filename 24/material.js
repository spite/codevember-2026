import { Color } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { shader as simplex } from "shaders/perlinSimplex3D.js";
import { DOLL_HEIGHT, SPLIT_H } from "./geometry.js";

function createDollMaterial(patternIdx = 0) {
  return new PipelineMaterial({
    defines: { DOLL_PATTERN: patternIdx | 0 },
    stochasticShadows: true,
    color: 0xffffff,
    roughness: 0.45,
    metalness: 0,
    uniforms: {
      uBaseColor: { value: new Color("#efe6d5") },
      uColor1: { value: new Color("#b43922") },
      uColor2: { value: new Color("#1e3758") },
      uColor3: { value: new Color("#d69422") },
      uAccent: { value: new Color("#1c1c1f") },
      uSkin: { value: new Color("#f2eadc") },
      uBlush: { value: new Color("#d98b78") },
      uWood: { value: new Color("#dfc7a3") },
      uPattern: { value: 0 },
      uFinish: { value: 0 },
      uFace: { value: 0 },
      uVariant: { value: 0.5 },
      uPhase: { value: 0 },
      uGold: { value: 0.5 },
      uSeamGap: { value: 0 },
      uRoughnessBias: { value: 0 },
      uFade: { value: 0 },
      uShadowAlpha: { value: 1 },
      uBgColor: { value: new Color("#e6dfd4") },
      uBgLevel: { value: 0.42 },
      uBgWallFill: { value: 0.32 },
    },
    varyings: {
      vPart: "float",
      vCavity: "float",
      vH: "float",
    },
    vertexPars: /* glsl */ `
in float aPart;
in float aCavity;
in float aH;
`,
    vertexMain: /* glsl */ `
vPart = aPart;
vCavity = aCavity;
vH = aH;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uBaseColor;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec3 uAccent;
uniform vec3 uSkin;
uniform vec3 uBlush;
uniform vec3 uWood;
uniform float uPattern;
uniform float uFinish;
uniform float uFace;
uniform float uVariant;
uniform float uPhase;
uniform float uGold;
uniform float uSeamGap;
uniform float uRoughnessBias;
uniform float uFade;
uniform float uShadowAlpha;
uniform vec3 uBgColor;
uniform float uBgLevel;
uniform float uBgWallFill;

// Interleaved Gradient Noise for clean sub-pixel final dissolve
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

${simplex}

const float PI_D = 3.14159265359;
const float TAU_D = 6.28318530718;
const float DOLL_H = ${DOLL_HEIGHT.toFixed(3)};
const float SPLIT_H_VAL = ${SPLIT_H.toFixed(3)};

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Screen-space surface gradient bump (Mikkelsen)
vec3 bumpNormal(vec3 n, float h) {
  vec3 dpdx = dFdx(vWorldPosition);
  vec3 dpdy = dFdy(vWorldPosition);
  float dhdx = dFdx(h);
  float dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  if (abs(det) < 1e-10) return n;
  vec3 g = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - g);
}

// Pixel footprint in object units, set once in uniform control flow: derivatives inside branches make D3D flatten them.
float gAA = 0.0018;
float gPxH = 0.0006;

// Analytic AA mask from signed distance (d < 0 is inside)
float aaMask(float d) {
  float w = gAA;
  return smoothstep(w, -w, d);
}

// Discontinuity-free AA mask for tiled/fract() SDFs (avoids 1px fwidth spikes at cell boundaries)
float aaCell(float d, float fw) {
  float w = clamp(fw, 0.0018, 0.06);
  return smoothstep(w, -w, d);
}

// Procedural linden wood grain in object space
void woodGrain(vec3 p, out vec3 col, out float height) {
  vec3 q = p * vec3(5.5, 1.35, 5.5);
  float warp = snoise(q * 0.85) * 0.55 + snoise(q * 2.2) * 0.2;
  float rings = sin((length(p.xz * 12.0 + vec2(0.8, -0.5)) + warp * 2.6) * 3.8);
  float ringBand = smoothstep(-0.7, 0.8, rings);
  float pores = snoise(vec3(p.x * 38.0, p.y * 8.0, p.z * 38.0));
  // Concentric lathe turning micro-grooves
  float lathe = sin(p.y * 230.0) * 0.5 + 0.5;
  col = mix(uWood * 0.87, uWood * 1.05, ringBand * 0.65 + 0.25);
  col *= 1.0 + pores * 0.045 - (1.0 - lathe) * 0.018;
  height = ringBand * 0.00018 + pores * 0.00012 + lathe * 0.00014;
}

// Smooth minimum (polynomial) for organic viscous paint fillets
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Distance to segment in 2D
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// Rounded rectangle SDF in 2D
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Pointed vesica leaf SDF in 2D (vertical axis along +Y, half-height len, plumpness k)
float sdLeaf(vec2 p, float len, float w) {
  float r = (len * len + w * w) / (2.0 * w);
  float cx = r - w;
  return max(length(p - vec2(cx, 0.0)) - r, length(p + vec2(cx, 0.0)) - r);
}

// Evaluate pattern: outputs color, metallic mask (0..1), rawWood mask (0..1), bump height, roughness offset
void evalPattern(
  int pat,
  vec3 p,
  float theta,
  float h,
  out vec3 col,
  out float metalMask,
  out float rawWoodMask,
  out float bumpH,
  out float roughMod
) {
  col = uBaseColor;
  metalMask = 0.0;
  rawWoodMask = 0.0;
  bumpH = 0.0;
  roughMod = 0.0;

  // Normalized angle in [-1, 1] with 0 at front (+Z)
  float ang = theta / PI_D;
  float side = sin(theta + uPhase * 0.15);
  // Isotropic unwrapped coordinates around the doll (x wraps seamlessly in periods of 1.0)
  float uWrap = theta / TAU_D + 0.5;
  // Continuous pixel size in normalized height units (never wraps or jumps across seams)
  float pxH = gPxH;

#if DOLL_PATTERN == 0
    // 0: BAUHAUS (Exact 1:1 reproduction of the 4 reference dolls + 5th sibling)
    // g.x in [-1.45, +1.45] around front (+Z is 0), g.y = h in [0, 1]
    // iso is true isotropic world-unit arc length (x = theta * 0.48, y = h * DOLL_H) so circles are truly round!
    vec2 g = vec2(ang * 1.45, h);
    vec2 iso = vec2(theta * 0.48, h * DOLL_H);
    col = uBaseColor;

    if (uVariant < 0.2) {
      // Doll 1: Burnt sienna sweeping left arch, black D-disc tucked under split seam, deep navy base
      float navyTop = 0.14 + 0.09 * smoothstep(-0.1, 0.55, g.x);
      float mNavy = aaMask(h - navyTop);
      col = mix(col, uColor2, mNavy);

      // Large sweeping burnt sienna arch on the left, peaking cleanly below the face (h <= 0.70)
      float dRed = length((g - vec2(-0.34, 0.36)) * vec2(0.95, 1.35)) - 0.46;
      float mRed = aaMask(max(dRed, g.x - 0.17));
      col = mix(col, uColor1, mRed);

      // Black D-shaped half-disc strictly below SPLIT_H_VAL, flat right edge at x = +0.17
      float dDisc = length(iso - vec2(0.11, 0.25 * DOLL_H)) - 0.38;
      float mDisc = aaMask(max(max(dDisc, h - SPLIT_H_VAL), g.x - 0.17));
      col = mix(col, uAccent, mDisc);
    } else if (uVariant < 0.4) {
      // Doll 2: Mustard ochre upper-left quarter-circle above split (staying cleanly below the face), warm sand lower-left, deep navy lower-right & base
      float mLower = aaMask(h - SPLIT_H_VAL);
      col = mix(col, uColor2, mLower);

      float dSand = length((g - vec2(-0.28, 0.39)) * vec2(1.0, 1.0)) - 0.34;
      float mSand = aaMask(max(max(dSand, h - SPLIT_H_VAL), g.x - 0.06));
      col = mix(col, uColor3, mSand);

      // Upper-left sweeping mustard ochre quarter-circle strictly above SPLIT_H_VAL, peaking at h ~ 0.69 below the face
      float dOchre = length((g - vec2(-0.32, SPLIT_H_VAL)) * vec2(0.95, 1.75)) - 0.46;
      float mOchre = aaMask(max(dOchre, SPLIT_H_VAL - h));
      col = mix(col, uColor1, mOchre);
    } else if (uVariant < 0.6) {
      // Doll 3: White left half + charcoal black right half-plane with a single smooth rounded top-left corner (zero notch!)
      vec2 corner = vec2(max(0.14 - g.x, 0.0), max(h - 0.52, 0.0));
      float dBlack = length(corner) - 0.16;
      float mBlack = aaMask(dBlack);
      col = mix(col, uColor1, mBlack);

      // Truly round burnt sienna circle strictly below SPLIT_H_VAL crossing the vertical split
      float dCirc = length(iso - vec2(-0.08, 0.225 * DOLL_H)) - 0.36;
      float mCirc = aaMask(dCirc);
      col = mix(col, uColor2, mCirc);
    } else if (uVariant < 0.8) {
      // Doll 4: White head, solid deep navy body below h = 0.66, truly round mustard ochre circle rising from base
      float mNavy = aaMask(h - 0.66);
      col = mix(col, uColor1, mNavy);

      float dOchre = length(iso - vec2(0.0, 0.175 * DOLL_H)) - 0.395;
      float mOchre = aaMask(dOchre);
      col = mix(col, uColor2, mOchre);
    } else {
      // Doll 5: Cohesive Bauhaus sibling — deep navy upper-left arch below the face, burnt sienna lower-left, black lower-right, truly round mustard disc
      float mLower = aaMask(h - SPLIT_H_VAL);
      col = mix(col, mix(uColor2, uAccent, aaMask(-g.x)), mLower);

      float dNavyArch = length((g - vec2(-0.30, SPLIT_H_VAL)) * vec2(0.95, 1.70)) - 0.45;
      col = mix(col, uColor1, aaMask(max(dNavyArch, SPLIT_H_VAL - h)));

      float dOchre = length(iso - vec2(0.02, 0.225 * DOLL_H)) - 0.34;
      col = mix(col, uColor3, aaMask(max(dOchre, h - SPLIT_H_VAL)));
    }

    // Silky architectural satin finish like the reference ceramic/matte-lacquered wood
    roughMod = 0.12;
#elif DOLL_PATTERN == 1
    // 1: DRIP (Exact C1-continuous alternating semicircle-and-wall drips — zero flat corners, zero stepped shoulders)
    float dripBaseH = mix(0.45, 0.50, uVariant);
    float dripBaseY = dripBaseH * DOLL_H;
    float yW = h * DOLL_H;

    // Gentle monotonic domain warp varies drip & arch widths smoothly while preserving exact C1 tangency
    float uWarped = uWrap
      + 0.014 * sin(theta * 2.0 + uPhase)
      + 0.008 * sin(theta * 5.0 - uPhase * 1.3);

    // Must be EVEN so alternating even (white drip) / odd (pastel arch) columns wrap seamlessly at the back
    float cols = 24.0;
    float colPitch = (TAU_D * 0.50) / cols;
    float R = 0.5 * colPitch;
    float cx = fract(uWarped + uPhase * 0.05) * cols;
    float ci = floor(cx);
    float cf = fract(cx) - 0.5;
    float seedRow = floor(uVariant * 37.0) + 1.0;

    bool isWhiteDrip = mod(ci, 2.0) < 0.5;
    float sideSign = cf >= 0.0 ? 1.0 : -1.0;
    float adjIdx = mod(ci + sideSign + cols, cols);
    float rVal = hash21(vec2(ci, seedRow + 11.3));
    float rAdj = hash21(vec2(adjIdx, seedRow + 11.3));
    float dWhite;

    if (isWhiteDrip) {
      // White drip hanging down to yTip - R; neighbor is a pastel arch rising to yArchAdj + R
      float len = 0.015 + pow(rVal, 1.25) * 0.28;
      float riseAdj = 0.015 + pow(rAdj, 1.35) * 0.22;
      float yTip = dripBaseY - len;
      float yArchAdj = dripBaseY + riseAdj;
      if (yW < yTip) {
        dWhite = length(vec2(cf * colPitch, yW - yTip)) - R;
      } else if (yW > yArchAdj) {
        // Above the neighboring pastel arch: distance to neighbor's semicircle (strictly negative in solid white!)
        dWhite = R - length(vec2((1.0 - abs(cf)) * colPitch, yW - yArchAdj));
      } else {
        dWhite = -(0.5 - abs(cf)) * colPitch;
      }
    } else {
      // Pastel arch rising up to yArch + R; neighbor is a white drip hanging to yTipAdj - R
      float rise = 0.015 + pow(rVal, 1.35) * 0.22;
      float lenAdj = 0.015 + pow(rAdj, 1.25) * 0.28;
      float yArch = dripBaseY + rise;
      float yTipAdj = dripBaseY - lenAdj;
      if (yW > yArch) {
        dWhite = R - length(vec2(cf * colPitch, yW - yArch));
      } else if (yW < yTipAdj) {
        // Below the neighboring white drip: distance to neighbor's semicircle (strictly positive in solid pastel!)
        dWhite = length(vec2((1.0 - abs(cf)) * colPitch, yW - yTipAdj)) - R;
      } else {
        dWhite = (0.5 - abs(cf)) * colPitch;
      }
    }

    float mColor = aaCell(-dWhite, pxH * DOLL_H * 1.35); // 1 on pastel lower body, 0 on white upper drips
    float meniscus = exp(-pow(dWhite / 0.016, 2.0));
    col = mix(uBaseColor, uColor1, mColor);
    col = mix(col, mix(uColor1, uColor2, 0.35), mColor * smoothstep(0.35, 0.02, h) * 0.3);
    bumpH += (1.0 - mColor) * 0.00042 + meniscus * 0.00048;
    roughMod = mix(-0.04, -0.08, mColor);
#elif DOLL_PATTERN == 2
    // 2: MOSAIC (Ref #6) - seamless triangular geometric tessellation aligned exactly to the waist split
    float cols = 10.0;
    float rowH = SPLIT_H_VAL / 4.0; // Exactly 4 rows below SPLIT_H_VAL so row boundary lands dead-on the split
    vec2 uv = vec2(uWrap * cols, h / rowH);
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    // Alternate diagonal split per checkerboard cell for diamond/prism rhythm
    float parity = mod(cell.x + cell.y, 2.0);
    float diag = parity < 0.5 ? (f.x + f.y - 1.0) : (f.x - f.y);
    float triId = diag > 0.0 ? 1.0 : 0.0;
    // Wrap cell.x modulo cols so the back seam is 100% seamless!
    vec2 tid = vec2(mod(cell.x, cols), cell.y * 2.0 + triId);
    float rnd = hash21(tid + floor(uVariant * 37.0));

    if (rnd < 0.24) col = uBaseColor;
    else if (rnd < 0.52) col = uColor1;
    else if (rnd < 0.78) col = uColor2;
    else col = uColor3;

    // Subtle per-triangle tonal nuance + clean grout micro-bevel
    col *= 0.94 + 0.12 * hash21(tid + 19.3);
    float edgeDist = min(min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)), abs(diag) * 0.707);
    float bevel = smoothstep(0.0, 0.06, edgeDist);
    bumpH += bevel * 0.00028;
    roughMod = (hash21(tid + 7.1) - 0.5) * 0.18;

    // Solid painted foot band like Ref #6
    float mFoot = aaMask(h - 0.085);
    col = mix(col, uColor1, mFoot);
    bumpH = mix(bumpH, 0.0002, mFoot);
#elif DOLL_PATTERN == 3
    // 3: BOTANICAL (Ref #1 & #5) - modern folk leaves/tulips/daisy + raised gold leaf dots
    col = uBaseColor;
    float cols = 7.0;
    float rows = 4.5;
    vec2 uv = vec2(uWrap * cols, h * rows);
    // Offset alternating rows (brick pattern)
    float rowIdx = floor(uv.y);
    uv.x += mod(rowIdx, 2.0) * 0.5;
    vec2 cell = floor(uv);
    vec2 f = fract(uv) - 0.5;
    vec2 cid = vec2(mod(cell.x, cols), cell.y);

    // Whole-row mask below the face region (zero mid-motif fade)
    float bodyMask = (rowIdx >= 0.0 && rowIdx <= 2.0) ? 1.0 : 0.0;
    float cellFw = pxH * rows * 1.25;

    if (uVariant < 0.5) {
      // Stylized tilted leaves with center vein (Ref #1)
      float tilt = (hash21(cid + 3.1) - 0.5) * 1.1;
      float ca = cos(tilt), sa = sin(tilt);
      vec2 lf = mat2(ca, -sa, sa, ca) * f;
      // Vesica piscis leaf SDF
      float dLeaf = max(length(lf - vec2(0.18, 0.0)) - 0.31, length(lf + vec2(0.18, 0.0)) - 0.31);
      float dInner = max(length(lf - vec2(0.20, 0.0)) - 0.25, length(lf + vec2(0.20, 0.0)) - 0.25);
      float mOutline = aaCell(dLeaf, cellFw) * (1.0 - aaCell(dInner, cellFw) * 0.55) * bodyMask;
      float mVein = aaCell(sdSegment(lf, vec2(0.0, -0.22), vec2(0.0, 0.22)) - 0.014, cellFw) * bodyMask;
      float mBot = clamp(mOutline + mVein, 0.0, 1.0);
      float bBot = smoothstep(0.024, -0.024, dLeaf) * bodyMask;
      col = mix(col, uColor1, mBot);
      bumpH += bBot * 0.00055;
    } else {
      // Modern folk 3-petal tulip blossom with leaf on stem (Ref #1 left doll)
      float tilt = (hash21(cid + 5.7) - 0.5) * 0.45;
      float ca = cos(tilt), sa = sin(tilt);
      vec2 tf = mat2(ca, -sa, sa, ca) * f;
      // Upward-blooming 3-petal folk tulip (Ref #1 left doll)
      float dMid = length((tf - vec2(0.0, 0.12)) * vec2(2.0, 0.85)) - 0.12;
      // Left petal flares up-and-left, right petal flares up-and-right
      vec2 tl = mat2(0.86, -0.5, 0.5, 0.86) * (tf - vec2(-0.075, 0.11));
      vec2 tr = mat2(0.86, 0.5, -0.5, 0.86) * (tf - vec2(0.075, 0.11));
      float dPetL = length(tl * vec2(2.1, 0.9)) - 0.11;
      float dPetR = length(tr * vec2(2.1, 0.9)) - 0.11;
      float dCupBase = length((tf - vec2(0.0, 0.03)) * vec2(1.15, 1.4)) - 0.105;
      float dStem = sdSegment(tf, vec2(0.0, -0.26), vec2(0.0, 0.02)) - 0.018;
      // Small side leaf angling upward off the stem
      vec2 sl = mat2(0.7, 0.7, -0.7, 0.7) * (tf - vec2(0.08, -0.14));
      float dSLeaf = length(sl * vec2(1.2, 2.5)) - 0.095;
      float dFl = min(min(min(min(dMid, dCupBase), min(dPetL, dPetR)), dStem), dSLeaf);
      float mFl = aaCell(dFl, cellFw) * bodyMask;
      float bFl = smoothstep(0.024, -0.024, dFl) * bodyMask;
      col = mix(col, uColor1, mFl);
      bumpH += bFl * 0.00058;
    }

    // Signature raised metallic gold-leaf bead dots nestled cleanly in the corners between motifs (Ref #1)
    float sx = hash21(cid + 11.7) > 0.5 ? 1.0 : -1.0;
    float sy = hash21(cid + 23.4) > 0.5 ? 1.0 : -1.0;
    vec2 dotPos = vec2(sx * 0.32, sy * 0.28);
    float dDot = length(f - dotPos) - 0.044;
    float goldEnv = (rowIdx >= 0.0 && rowIdx <= 3.0) ? 1.0 : 0.0;
    float mGold = aaCell(dDot, cellFw) * goldEnv;
    if (hash21(cid + 41.2) > 0.3) {
      col = mix(col, vec3(0.88, 0.72, 0.36), mGold);
      metalMask = max(metalMask, mGold * 0.94);
      bumpH += smoothstep(0.022, -0.022, dDot) * goldEnv * 0.00075;
      roughMod = mix(roughMod, -0.38, mGold);
    }
#elif DOLL_PATTERN == 4
    // 4: CITY STRIPE (Ref #3) - staggered vertical architectural color-block bars
    float cols = 18.0;
    float colIdx = floor(uWrap * cols);
    float wrappedCol = mod(colIdx, cols);
    float colF = fract(uWrap * cols);

    // Three staggered elevation tiers per vertical column
    float h1 = 0.18 + 0.32 * hash21(vec2(wrappedCol, 1.0 + floor(uVariant * 20.0)));
    float h2 = h1 + 0.18 + 0.26 * hash21(vec2(wrappedCol, 5.0 + floor(uVariant * 20.0)));
    float tier = h < h1 ? 0.0 : (h < h2 ? 1.0 : 2.0);
    float rnd = hash21(vec2(wrappedCol, tier * 7.3 + floor(uVariant * 19.0)));

    if (tier < 0.5) {
      col = mix(uColor1, uAccent, rnd * 0.45);
    } else if (tier < 1.5) {
      col = rnd < 0.45 ? uColor1 : (rnd < 0.8 ? uColor2 : uColor3);
    } else {
      col = rnd < 0.5 ? uBaseColor : mix(uBaseColor, uColor3, 0.65);
    }

    // Crisp micro-step between vertical bars
    float edge = smoothstep(0.0, 0.08, min(colF, 1.0 - colF));
    bumpH += edge * 0.00018;
    roughMod = (rnd - 0.5) * 0.1;
#elif DOLL_PATTERN == 5
    // 5: DIPPED (Ref #7) - pure sculptural raw wood + saturated dipped coat + optional brass ring
    float dipH = mix(0.28, 0.38, uVariant);
    float dDip = h - dipH;
    float mPaint = aaMask(-dDip); // painted above dipH, raw wood below (like Ref #7)
    vec3 wCol;
    float wH;
    woodGrain(p, wCol, wH);
    col = mix(wCol, uColor1, mPaint);
    rawWoodMask = 1.0 - mPaint;
    bumpH += mPaint * 0.00032 + (1.0 - mPaint) * wH;

    // Optional crisp metallic brass band at the dip line
    if (uGold > 0.45) {
      float dBand = abs(h - dipH) - 0.011;
      float mBand = aaMask(dBand);
      col = mix(col, vec3(0.86, 0.71, 0.38), mBand);
      metalMask = max(metalMask, mBand * 0.94);
      rawWoodMask *= (1.0 - mBand);
      bumpH += mBand * 0.00035;
    }
#elif DOLL_PATTERN == 6
    // 6: FOLK GRAPHIC (Ref #8) - glossy lacquered chevrons, herringbone, and bands with clean bevelled paint-edge bump
    col = uColor1;
    float motif = fract(uVariant * 3.0);
    if (motif < 0.34) {
      // Bold rhythmic chevrons running cleanly to the base, ending on whole chevron bands (zero sliced triangles)
      float zig = abs(fract(uWrap * 6.0) - 0.5) * 0.22;
      float cy = (h + zig) * 4.5;
      float chevIdx = floor(cy);
      float band = fract(cy);
      float dChev = (abs(band - 0.5) - 0.16) / 4.5;
      float inBands = (chevIdx >= 0.0 && chevIdx <= 3.0) ? 1.0 : 0.0;
      float mChev = aaCell(dChev, pxH * 1.4) * inBands;
      float bevel = smoothstep(0.008, -0.008, dChev) * inBands;
      col = mix(col, uColor2, mChev);
      bumpH += bevel * 0.00062;
      roughMod = mix(0.05, -0.05, mChev);
    } else if (motif < 0.67) {
      // Horizontal color-block bands with crisp bevelled lacquer edges, aligned to the waist split
      float dB1 = abs(h - 0.22) - 0.065;
      float dB2 = abs(h - (SPLIT_H_VAL + 0.065)) - 0.065;
      float dB3 = abs(h - 0.72) - 0.018;
      float b1 = aaMask(dB1);
      float b2 = aaMask(dB2);
      float b3 = aaMask(dB3);
      float bevel12 = smoothstep(0.008, -0.008, min(dB1, dB2));
      float bevel3 = smoothstep(0.006, -0.006, dB3);
      col = mix(col, uColor2, clamp(b1 + b2, 0.0, 1.0));
      col = mix(col, uColor3, b3);
      metalMask = b3 * uGold * 0.9;
      bumpH += bevel12 * 0.00056 + bevel3 * 0.00068;
      roughMod = mix(0.05, -0.05, clamp(b1 + b2, 0.0, 1.0));
    } else {
      // Stylized botanical wheat / herringbone spine — runs cleanly to the base with whole ribs (zero floating fragments)
      float spineU = abs(fract(uWrap * 4.0 + 0.5) - 0.5);
      float dStem = max(spineU - 0.014, h - 0.78);
      float ry = h * 11.0 - spineU * 4.0;
      float ribIdx = floor(ry);
      float ribs = fract(ry);
      float dRib = max((abs(ribs - 0.5) - 0.16) / 11.0, spineU - 0.18);
      if (ribIdx < 0.0 || ribIdx > 7.0) dRib = 1.0;
      float dUnified = min(dStem, dRib);
      float mPat = aaCell(dUnified, pxH * 1.4);
      float bevel = smoothstep(0.006, -0.006, dUnified);
      col = mix(col, uColor3, mPat);
      bumpH += bevel * 0.00062;
      roughMod = mix(0.05, -0.05, mPat);
    }
#elif DOLL_PATTERN == 7
    // 7: PATCHWORK (Ref #9) - glossy jewel color-blocked curves with the face always centered cleanly inside the upper arching curve
    float amp1 = mix(0.36, 0.44, uVariant);
    float amp2 = mix(0.34, 0.42, fract(uVariant * 2.3));
    float d1 = h * 1.35 - cos(theta) * amp1 - 0.44; // symmetric arch framing the face at theta = 0 (h ~ 0.62)
    float d2 = h * 1.25 + cos(theta) * amp2 - mix(0.54, 0.62, uVariant); // lower contrasting curve sweeping opposite
    float d3 = h * 1.15 - cos(theta) * 0.28 - mix(0.14, 0.20, fract(uVariant * 1.7)); // deep lower jewel panel
    float m1 = aaMask(d1);
    float m2 = aaMask(d2);
    float m3 = aaMask(d3);

    col = uBaseColor;
    col = mix(col, uColor1, m1);
    col = mix(col, uColor2, m2 * (1.0 - m1 * 0.5));
    col = mix(col, uColor3, m3 * (1.0 - m2));
    // Bold contrasting wedge centered cleanly at the base
    float dWedge = length(vec2(ang * 1.35, (h - 0.11) * 1.4)) - 0.22;
    float mWedge = aaMask(dWedge);
    col = mix(col, uAccent, mWedge * 0.9);
    float b1 = smoothstep(0.018, -0.018, d1);
    float b2 = smoothstep(0.018, -0.018, d2);
    float b3 = smoothstep(0.018, -0.018, d3);
    float bW = smoothstep(0.016, -0.016, dWedge);
    bumpH += (b1 * 0.00042 + b2 * 0.00038 + b3 * 0.00036 + bW * 0.00045);
#elif DOLL_PATTERN == 8
    // 8: MONOCHROME LACQUER - 5 distinct B&W graphic siblings (scallops/diamonds, white dots, clouds, harlequin, black dots)
    col = uBaseColor;
    float mInk = 0.0;
    float bInk = 0.0;

    if (uVariant < 0.2) {
      // Sibling 0: White hood + bold black/white geometric bands (unified SDFs so zero interior bump lines appear)
      float fx8 = fract(uWrap * 8.0) - 0.5;
      float x8 = abs(fx8) * 2.0; // 0..1 triangle wave

      // Lower band: crisp foot + tall sawtooth diamonds below SPLIT_H_VAL (unified SDF)
      float dSawLower = (h - 0.305) - 0.115 * (1.0 - x8);
      float dLower = max(dSawLower, h - (SPLIT_H_VAL - 0.008));

      // Upper band: downward-hanging scallops seamlessly fused to upward triangle teeth across h = 0.54
      float dScallop = (length(vec2(fx8, (h - 0.54) * 8.5)) - 0.50) / 8.5;
      float dTri = (h - 0.54) - 0.105 * x8;
      float dUpper = h >= 0.54 ? dTri : dScallop;

      float dBand = min(dLower, dUpper);
      mInk = aaCell(dBand, pxH * 1.4);
      bInk = smoothstep(0.008, -0.008, dBand);
    } else if (uVariant < 0.4 || uVariant >= 0.8) {
      // Sibling 1 (black w/ white polka dots) & Sibling 4 (white w/ black polka dots) — whole-row cutoff, zero fade
      float cols = 9.0;
      float rows = 7.0;
      vec2 uv = vec2(uWrap * cols, h * rows);
      float dotRow = floor(uv.y);
      uv.x += mod(dotRow, 2.0) * 0.5;
      vec2 f = fract(uv) - 0.5;
      float rDot = uVariant >= 0.8 ? 0.13 : 0.11;
      float dDot = length(f) - rDot;
      float env = (dotRow >= 0.0 && dotRow <= 5.0) ? 1.0 : 0.0;
      mInk = aaCell(dDot, pxH * rows * 1.3) * env;
      bInk = smoothstep(0.025, -0.025, dDot) * env;
    } else if (uVariant < 0.6) {
      // Sibling 2: Glossy jet black with bold puffy white clouds — whole-row cutoff below face, zero fade
      float cols = 3.0;
      float rows = 3.0;
      vec2 uv = vec2(uWrap * cols + 0.15, h * rows);
      float cloudRow = floor(uv.y);
      uv.x += mod(cloudRow, 2.0) * 0.5;
      vec2 f = fract(uv) - 0.5;
      // Puffy 3-lobe cloud with a smooth rounded flat-bottomed pill base (zero underside notch!)
      float cBase = sdSegment(f, vec2(-0.18, -0.06), vec2(0.18, -0.06)) - 0.11;
      float c1 = length(f - vec2(-0.15, 0.01)) - 0.14;
      float c2 = length(f - vec2(0.01, 0.09)) - 0.185;
      float c3 = length(f - vec2(0.17, -0.01)) - 0.13;
      float dCloud = min(cBase, min(min(c1, c2), c3));
      float env = (cloudRow >= 0.0 && cloudRow <= 1.0) ? 1.0 : 0.0;
      mInk = aaCell(dCloud, pxH * rows * 1.4) * env;
      bInk = smoothstep(0.020, -0.020, dCloud) * env;
    } else {
      // Sibling 3: Bold B&W harlequin diamond/checker skirt below white head
      float cols = 8.0;
      float rowH = SPLIT_H_VAL / 2.0;
      vec2 uv = vec2(uWrap * cols, h / rowH);
      vec2 f = fract(uv);
      float inSkirt = aaMask(h - 0.62);
      float dHarl = abs(f.x - 0.5) + abs(f.y - 0.5) - 0.5;
      float mHarl = aaCell(dHarl, pxH / rowH * 1.3) * inSkirt;
      float dCollar = abs(h - 0.62) - 0.012;
      float mCollar = aaMask(dCollar);
      mInk = clamp(mHarl + mCollar, 0.0, 1.0);
      bInk = max(smoothstep(0.032, -0.032, dHarl) * inSkirt, smoothstep(0.006, -0.006, dCollar));
    }

    col = mix(uBaseColor, uColor1, mInk);
    bumpH += bInk * 0.00058;
    roughMod = mix(0.02, -0.03, mInk);
#elif DOLL_PATTERN == 9
    // 9: PORCELAIN SHAWL - glossy pastel hood/cloak parting in an inverted-V over a white floral tulip apron
    // Inverted-V cape opening centered at front (theta = 0): dips to h = 0.61 at center chest, sweeps down to SPLIT_H_VAL around sides/back
    float frontOpen = exp(-pow(theta / 0.52, 2.0));
    float capeLine = SPLIT_H_VAL + 0.19 * frontOpen;
    float dCape = h - capeLine;
    float mCape = aaCell(-dCape, pxH * 1.5); // 1 on upper shawl/hood, 0 on lower white floral apron

    // White porcelain apron with scattered mini folk tulips (alternating red/pink/sky) & green stems/leaves
    vec3 apronCol = uBaseColor;
    float cols = 9.0;
    float rows = 5.5;
    vec2 uv = vec2(uWrap * cols, h * rows);
    uv.x += mod(floor(uv.y), 2.0) * 0.5;
    vec2 cell = floor(uv);
    vec2 f = fract(uv) - 0.5;
    vec2 cid = vec2(mod(cell.x, cols), cell.y);
    float cellFw = pxH * rows * 1.3;

    float tilt = (hash21(cid + 2.3) - 0.5) * 0.85;
    float ca = cos(tilt), sa = sin(tilt);
    vec2 tf = mat2(ca, -sa, sa, ca) * f;

    // Mini upward-blooming tulip blossom
    float dMid = length((tf - vec2(0.0, 0.11)) * vec2(2.0, 0.9)) - 0.11;
    vec2 tl = mat2(0.86, -0.5, 0.5, 0.86) * (tf - vec2(-0.07, 0.10));
    vec2 tr = mat2(0.86, 0.5, -0.5, 0.86) * (tf - vec2(0.07, 0.10));
    float dPet = min(min(dMid, length(tl * vec2(2.1, 0.9)) - 0.10), length(tr * vec2(2.1, 0.9)) - 0.10);
    float dBaseCup = length((tf - vec2(0.0, 0.03)) * vec2(1.2, 1.4)) - 0.095;
    float dBlossom = min(dPet, dBaseCup);
    float footEnv = 1.0;
    float mBlossom = aaCell(dBlossom, cellFw);

    // Green stem & tiny side leaf
    float dStem = sdSegment(tf, vec2(0.0, -0.24), vec2(0.0, 0.02)) - 0.017;
    vec2 sl = mat2(0.7, 0.7, -0.7, 0.7) * (tf - vec2(0.08, -0.13));
    float dLeaf = length(sl * vec2(1.2, 2.5)) - 0.088;
    float dGreen = min(dStem, dLeaf);
    float mGreen = aaCell(dGreen, cellFw) * footEnv;

    float pick = hash21(cid + 19.7);
    vec3 flowerCol = pick < 0.45 ? uColor2 : (pick < 0.78 ? uColor1 : mix(uColor2, uBaseColor, 0.45));
    apronCol = mix(apronCol, uColor3, mGreen);
    apronCol = mix(apronCol, flowerCol, mBlossom);

    // Crisp dark piping along the shawl edge + round clasp button at front chest
    float mTrim = aaCell(abs(dCape) - 0.006, pxH * 1.5);
    vec2 bp = vec2(theta * 0.45, (h - 0.615) * DOLL_H);
    float dButton = length(bp) - 0.034;
    float mButton = aaMask(dButton);

    col = mix(apronCol, uColor1, mCape);
    col = mix(col, uColor1 * 0.65, mTrim);
    col = mix(col, uColor2, mButton);

    // Thin matching pastel rim at the very foot
    float dFoot = h - 0.035;
    float mFoot = aaMask(dFoot);
    col = mix(col, uColor1, mFoot);
    float bFloral = smoothstep(0.028, -0.028, min(dBlossom, dGreen)) * footEnv * (1.0 - mCape);
    float bCape = smoothstep(0.009, -0.009, -dCape);
    float bButton = smoothstep(0.010, -0.010, dButton);
    float bFoot = smoothstep(0.008, -0.008, dFoot);
    bumpH += bCape * 0.00056 + bButton * 0.00085 + bFloral * 0.00056 + bFoot * 0.00045;
#elif DOLL_PATTERN == 10
    // 10: CRIMSON BABUSHKA - glossy headscarf hood tied in a crisp V-notched bow under the chin over contrasting lacquer body
    float frontV = exp(-pow(theta / 0.62, 2.0));
    float hoodLine = 0.64 - 0.12 * frontV;
    float dHood = -(h - hoodLine);
    float mHood = aaCell(dHood, pxH * 1.5);

    // Two distinct ribbon tails splaying down-and-outward (/ \) from a centered knot under the chin
    vec2 sp = vec2(theta * 0.45, (h - 0.515) * DOLL_H);
    vec2 sl = mat2(0.88, 0.47, -0.47, 0.88) * (sp - vec2(-0.065, -0.055));
    vec2 sr = mat2(0.88, -0.47, 0.47, 0.88) * (sp - vec2(0.065, -0.055));
    float dTailL = length(sl * vec2(2.3, 0.72)) - 0.088;
    float dTailR = length(sr * vec2(2.3, 0.72)) - 0.088;
    float dKnot = length((sp - vec2(0.0, 0.032)) * vec2(1.0, 1.15)) - 0.048;
    float dBow = min(min(dTailL, dTailR), dKnot);
    float mScarf = aaMask(dBow);
    float mKnotCrease = aaMask(abs(dKnot) - 0.008) * mScarf;

    // Thin contrasting lacquer rim at the very base
    float dFoot = h - 0.042;
    float mFoot = aaMask(dFoot);

    col = uBaseColor;
    float mRed = clamp(mHood + mScarf, 0.0, 1.0);
    col = mix(col, uColor1, mRed);
    // Subtle deeper shading on the knot crease so the tied bow reads crisply
    col = mix(col, uColor1 * 0.72, mKnotCrease * 0.55);
    col = mix(col, uColor1, mFoot);
    float bHood = smoothstep(0.009, -0.009, dHood);
    float bBow = smoothstep(0.010, -0.010, dBow);
    float bKnot = smoothstep(0.008, -0.008, dKnot);
    float bFoot = smoothstep(0.008, -0.008, dFoot);
    bumpH += max(bHood, bBow) * 0.00056 + bKnot * 0.00034 + bFoot * 0.00045;
#elif DOLL_PATTERN == 11
    // 11: BALLOON - minimalist glossy porcelain white with a single iconic teardrop balloon & wavy black string
    col = uBaseColor;
    vec2 bp = vec2(theta * 0.48, (h - 0.735) * DOLL_H);
    // Subtle teardrop balloon: fuller rounded top, gently tapering bottom into tiny triangular knot
    float taper = mix(1.0, 1.24, smoothstep(0.10, -0.26, bp.y));
    float dBulb = length(vec2(bp.x * taper, bp.y * 0.80)) - 0.215;
    // Tiny triangular balloon knot at bottom tip (bp.y ~ -0.275)
    vec2 kp = bp - vec2(0.0, -0.278);
    float dKnot = max(abs(kp.x) - (0.011 + max(0.0, -kp.y) * 0.55), abs(kp.y + 0.008) - 0.022);
    float dBalloon = min(dBulb, dKnot);
    float mBalloon = aaMask(dBalloon);

    // Delicate sinuous wavy black string running cleanly from balloon knot down across the waist split (crisp ends)
    float sx = 0.056 * sin((h - 0.58) * 14.5) - 0.024 * sin((h - 0.58) * 6.8);
    float dStr = max(abs(theta * 0.48 - sx) - 0.0055, max(0.14 - h, h - 0.585) * DOLL_H);
    float mStr = aaMask(dStr) * (abs(theta) < 0.45 ? 1.0 : 0.0);

    col = mix(col, uColor3, mStr);
    col = mix(col, uColor1, mBalloon);
    float bBal = smoothstep(0.010, -0.010, dBalloon);
    float bStr = smoothstep(0.006, -0.006, dStr) * (abs(theta) < 0.45 ? 1.0 : 0.0);
    bumpH += bBal * 0.00062 + bStr * 0.00032;
    roughMod = mix(0.0, -0.05, mBalloon);
#elif DOLL_PATTERN == 12
    // 12: GEL OVERLAP - bold hood sweeping down in an inverted-V over translucent overprinted color-gel rounded rectangles
    float frontV = exp(-pow(theta / 0.56, 2.0));
    float capeLine = 0.53 + 0.14 * frontV;
    float dCape = -(h - capeLine);
    float mCape = aaCell(dCape, pxH * 1.5);

    // Skirt base color with 6 overlapping translucent rounded rectangles (silkscreen multiply/alpha blend)
    vec3 skirt = uBaseColor;
    vec2 q = vec2(theta * 0.52, h * DOLL_H);
    // Repeat cleanly around the full circumference by wrapping theta into [-PI, PI]
    float bGel = 0.0;

    // 6 richly staggered translucent gel rectangles covering front, sides, and back
    vec3 gCol0 = mix(uColor3, vec3(0.96, 0.44, 0.14), 0.55); // warm orange-amber gel
    vec3 gCol1 = uColor2;                                     // cool cyan-teal gel
    vec3 gCol2 = uColor3;                                     // bright lemon-yellow gel
    vec3 gCol3 = mix(uColor2, uColor3, 0.52);                 // vibrant lime-chartreuse gel
    vec3 gCol4 = mix(uColor1, uColor2, 0.48);                 // violet-plum gel
    vec3 gCol5 = mix(uColor2, vec3(0.92, 0.96, 0.98), 0.48);  // pale ice-aqua gel

    float d0 = sdRoundBox(vec2(sin(theta + 0.30) * 0.52, h - 0.48), vec2(0.24, 0.12), 0.038);
    float d1 = sdRoundBox(vec2(sin(theta - 0.55) * 0.52, h - 0.34), vec2(0.22, 0.16), 0.042);
    float d2 = sdRoundBox(vec2(sin(theta + 0.48) * 0.52, h - 0.41), vec2(0.24, 0.12), 0.038);
    float d3 = sdRoundBox(vec2(sin(theta - 0.08) * 0.52, h - 0.28), vec2(0.21, 0.13), 0.036);
    float d4 = sdRoundBox(vec2(sin(theta + 0.72) * 0.52, h - 0.16), vec2(0.18, 0.10), 0.032);
    float d5 = sdRoundBox(vec2(sin(theta - 0.42) * 0.52, h - 0.14), vec2(0.19, 0.12), 0.034);

    // Translucent silkscreen overprint blending (multiplicative + alpha mix)
    float m0 = aaMask(d0); skirt = mix(skirt, mix(skirt * gCol0 * 1.15, gCol0, 0.62), m0 * 0.82);
    float m1 = aaMask(d1); skirt = mix(skirt, mix(skirt * gCol1 * 1.15, gCol1, 0.60), m1 * 0.80);
    float m2 = aaMask(d2); skirt = mix(skirt, mix(skirt * gCol2 * 1.12, gCol2, 0.68), m2 * 0.84);
    float m3 = aaMask(d3); skirt = mix(skirt, mix(skirt * gCol3 * 1.15, gCol3, 0.64), m3 * 0.82);
    float m4 = aaMask(d4); skirt = mix(skirt, mix(skirt * gCol4 * 1.18, gCol4, 0.62), m4 * 0.78);
    float m5 = aaMask(d5); skirt = mix(skirt, mix(skirt * gCol5 * 1.12, gCol5, 0.66), m5 * 0.80);

    bGel = max(max(smoothstep(0.014, -0.014, d0), smoothstep(0.014, -0.014, d1)),
               max(max(smoothstep(0.014, -0.014, d2), smoothstep(0.014, -0.014, d3)),
                   max(smoothstep(0.014, -0.014, d4), smoothstep(0.014, -0.014, d5))));

    col = mix(skirt, uColor1, mCape);
    float bCape = smoothstep(0.010, -0.010, dCape);
    bumpH += max(bCape * 0.00055, bGel * (1.0 - mCape) * 0.00038);
#elif DOLL_PATTERN == 13
    // 13: MODERN FOLK - navy cloak + coral-red hood with gold crown dot & pink corners + cream floral emblem apron
    vec3 pinkAcc = vec3(0.93, 0.50, 0.72);
    // Front cream apron panel (centered at theta = 0, below h = 0.56)
    float apronHalfW = 0.54;
    float dApron = max(abs(theta) - apronHalfW, h - 0.58);
    float mApron = aaMask(dApron);

    // Side navy cloak with bold pink polka dots & gold teardrops
    vec3 cloak = uColor2;
    vec2 sp = vec2(abs(theta), h);
    float dSideDot = length(vec2((sp.x - 0.88) * 0.52, (sp.y - 0.36) * DOLL_H)) - 0.072;
    float dSidePetal = sdLeaf(mat2(0.86, 0.5, -0.5, 0.86) * vec2((sp.x - 0.85) * 0.52, (sp.y - 0.56) * DOLL_H), 0.13, 0.055);
    float dGoldSide = length(vec2((sp.x - 1.12) * 0.52, (sp.y - 0.25) * DOLL_H)) - 0.11;
    cloak = mix(cloak, uColor3, aaMask(dGoldSide));
    cloak = mix(cloak, pinkAcc, clamp(aaMask(dSideDot) + aaMask(dSidePetal), 0.0, 1.0));

    // Cream apron with centered geometric folk botanical emblem
    vec3 apron = uBaseColor;
    vec2 ap = vec2(theta * 0.48, h * DOLL_H);
    // Vertical dark stem
    float dStem = sdSegment(ap, vec2(0.0, 0.08), vec2(0.0, 0.58)) - 0.0085;
    // 3 stacked navy dots above stem
    float dDots = min(min(length(ap - vec2(0.0, 0.64)), length(ap - vec2(0.0, 0.71))), length(ap - vec2(0.0, 0.78))) - 0.022;
    // Lower pair of navy leaves flaring up-and-out
    vec2 llL = mat2(0.76, -0.65, 0.65, 0.76) * (ap - vec2(-0.105, 0.49));
    vec2 llR = mat2(0.76, 0.65, -0.65, 0.76) * (ap - vec2(0.105, 0.49));
    float dLowLeaves = min(sdLeaf(llL, 0.145, 0.068), sdLeaf(llR, 0.145, 0.068));
    // Mid-left red leaf & mid-right gold leaf flaring outward
    vec2 mlL = mat2(0.84, -0.54, 0.54, 0.84) * (ap - vec2(-0.145, 0.77));
    vec2 mlR = mat2(0.84, 0.54, -0.54, 0.84) * (ap - vec2(0.145, 0.77));
    float dMidL = sdLeaf(mlL, 0.17, 0.075);
    float dMidR = sdLeaf(mlR, 0.17, 0.075);
    // Top center pink blossom petal
    float dTopPet = sdLeaf(ap - vec2(0.0, 0.99), 0.165, 0.078);
    // Bottom corner accent wedges inside apron
    float dBotCornerL = (ap.x + 0.06) + (ap.y - 0.16) * 0.95;
    float dBotCornerR = (-ap.x + 0.06) + (ap.y - 0.16) * 0.95;
    float mBotL = aaMask(dBotCornerL) * aaMask(-ap.x);
    float mBotR = aaMask(dBotCornerR) * aaMask(ap.x);

    apron = mix(apron, uColor1, mBotL);
    apron = mix(apron, pinkAcc, mBotR);
    apron = mix(apron, uColor2, clamp(aaMask(dStem) + aaMask(dDots) + aaMask(dLowLeaves), 0.0, 1.0));
    apron = mix(apron, uColor1, aaMask(dMidL));
    apron = mix(apron, uColor3, aaMask(dMidR));
    apron = mix(apron, pinkAcc, aaMask(dTopPet));

    float dEmblem = min(min(min(dStem, dDots), dLowLeaves), min(min(dMidL, dMidR), dTopPet));

    col = mix(cloak, apron, mApron);

    // Coral-red headscarf hood + golden crown sun dot + two splayed red scarf tails + gold clasp button
    float frontV = exp(-pow(theta / 0.58, 2.0));
    float hoodLine = 0.65 - 0.09 * frontV;
    float dHood = -(h - hoodLine);
    float mHood = aaCell(dHood, pxH * 1.5);

    vec2 tp = vec2(theta * 0.45, (h - 0.55) * DOLL_H);
    vec2 tl = mat2(0.84, 0.54, -0.54, 0.84) * (tp - vec2(-0.085, -0.075));
    vec2 tr = mat2(0.84, -0.54, 0.54, 0.84) * (tp - vec2(0.085, -0.075));
    float dTails = min(sdLeaf(tl, 0.135, 0.056), sdLeaf(tr, 0.135, 0.056));
    float dClasp = length(tp - vec2(0.0, 0.048)) - 0.036;
    float dCrownDot = length(vec2(theta * 0.42, (h - 0.955) * DOLL_H)) - 0.078;

    col = mix(col, uColor1, clamp(mHood + aaMask(dTails), 0.0, 1.0));
    col = mix(col, uColor3, aaMask(dCrownDot) * mHood);
    col = mix(col, uColor3, aaMask(dClasp));

    // Crisp navy foot band
    float dFoot = h - 0.055;
    col = mix(col, uColor2, aaMask(dFoot));

    float bEmblem = smoothstep(0.012, -0.012, dEmblem) * mApron;
    float bHood = smoothstep(0.010, -0.010, min(dHood, dTails));
    float bClasp = smoothstep(0.010, -0.010, dClasp);
    bumpH += max(max(bHood * 0.00055, bEmblem * 0.00052), bClasp * 0.00080);
#else
    // 14: SCANDI EMBLEM - editorial mid-century hood with sharp collar tabs, cream buttoned chest w/ mini sprigs, geometric color-block skirt
    vec3 pinkTri = vec3(0.95, 0.67, 0.72);
    vec3 blueSide = mix(uColor2, vec3(0.08, 0.30, 0.62), 0.68);
    col = uBaseColor;

    // Lower geometric color-blocked skirt (below SPLIT_H_VAL)
    float inSkirt = aaMask(h - SPLIT_H_VAL);
    vec2 sp = vec2(theta * 0.50, h * DOLL_H);
    float splitY = SPLIT_H_VAL * DOLL_H;

    // Left teal side curve & right deep-blue side curve
    float dSideL = (sp.x + 0.14) - (splitY - sp.y) * 0.25;
    float dSideR = (-sp.x + 0.14) - (splitY - sp.y) * 0.25;
    // Upper-skirt left pink triangle & right gold triangle meeting at center (theta = 0, h = SPLIT_H_VAL)
    float dTriL = max(sp.x, (splitY - sp.y) - (-sp.x) * 1.15);
    float dTriR = max(-sp.x, (splitY - sp.y) - (sp.x) * 1.15);
    // Centered dark crescent/bowl below the triangles
    float dBowlOuter = length((sp - vec2(0.0, splitY - 0.17)) * vec2(0.85, 1.15)) - 0.22;
    float dBowlCut = length((sp - vec2(0.0, splitY - 0.04)) * vec2(0.95, 1.15)) - 0.18;
    float dBowl = max(dBowlOuter, -dBowlCut);
    // Centered cream lower column with 3 pairs of black leaves rising from red base
    float dBotCol = max(abs(sp.x) - 0.115, sp.y - (splitY - 0.36));

    vec3 skirtCol = uBaseColor;
    skirtCol = mix(skirtCol, uColor2, aaMask(dSideL) * aaMask(-sp.x));
    skirtCol = mix(skirtCol, blueSide, aaMask(dSideR) * aaMask(sp.x));
    skirtCol = mix(skirtCol, pinkTri, aaMask(dTriL));
    skirtCol = mix(skirtCol, uColor3, aaMask(dTriR));
    skirtCol = mix(skirtCol, uAccent, aaMask(dBowl));
    skirtCol = mix(skirtCol, uBaseColor, aaMask(dBotCol));

    // 3 pairs of crisp black leaves in the lower center cream strip
    float dBotSprig = sdSegment(sp, vec2(0.0, 0.09), vec2(0.0, splitY - 0.39)) - 0.007;
    for (int k = 0; k < 3; k++) {
      float ly = 0.16 + float(k) * 0.11;
      vec2 lf = vec2(abs(sp.x) - 0.052, sp.y - ly);
      vec2 rl = mat2(0.75, 0.66, -0.66, 0.75) * lf;
      dBotSprig = min(dBotSprig, sdLeaf(rl, 0.058, 0.026));
    }
    skirtCol = mix(skirtCol, uAccent, aaMask(dBotSprig) * aaMask(dBotCol));
    col = mix(col, skirtCol, inSkirt);

    // Upper chest: 3 stacked black buttons down center + 2 symmetrical mini sprigs flanking left & right
    float dBtns = min(min(length(sp - vec2(0.0, splitY + 0.08)), length(sp - vec2(0.0, splitY + 0.17))),
                      length(sp - vec2(0.0, splitY + 0.26))) - 0.024;
    vec2 sprigP = vec2(abs(sp.x) - 0.23, sp.y - splitY);
    float dSpStem = sdSegment(sprigP, vec2(0.0, 0.0), vec2(0.0, 0.22)) - 0.007;
    vec2 spL1 = mat2(0.75, 0.66, -0.66, 0.75) * vec2(abs(sprigP.x) - 0.044, sprigP.y - 0.075);
    vec2 spL2 = mat2(0.75, 0.66, -0.66, 0.75) * vec2(abs(sprigP.x) - 0.042, sprigP.y - 0.165);
    float dSpLeaves = min(sdLeaf(spL1, 0.052, 0.024), sdLeaf(spL2, 0.048, 0.022));
    float dSpDot = length(sprigP - vec2(0.0, 0.25)) - 0.028;

    float mChestInk = clamp(aaMask(dBtns) + aaMask(min(dSpStem, dSpLeaves)), 0.0, 1.0) * (1.0 - inSkirt);
    float mChestDot = aaMask(dSpDot) * (1.0 - inSkirt);
    col = mix(col, uAccent, mChestInk);
    col = mix(col, uColor3, mChestDot);

    // Vivid hood with sharp pointed collar tabs framing the center buttons
    float collarDip = 0.095 * exp(-pow((abs(theta) - 0.28) / 0.14, 2.0));
    float frontNotch = 0.045 * exp(-pow(theta / 0.11, 2.0));
    float dHood = -(h - (0.645 - collarDip + frontNotch));
    float mHood = aaCell(dHood, pxH * 1.5);
    col = mix(col, uColor1, mHood);

    // Crisp red foot rim
    float dFoot = h - 0.045;
    col = mix(col, uColor1, aaMask(dFoot));

    float bDetails = max(smoothstep(0.010, -0.010, dHood),
                         max(smoothstep(0.008, -0.008, min(dBtns, min(dSpLeaves, dSpDot))) * (1.0 - inSkirt),
                             smoothstep(0.008, -0.008, min(dBowl, dBotSprig)) * inSkirt));
    bumpH += bDetails * 0.00054;
#endif
}

// Overlay expressive emoji-inspired faces (0..7), Minimal Bauhaus (8), or None (9) on the front (+Z) of the head
void evalFace(
  int faceStyle,
  float theta,
  float h,
  inout vec3 col,
  inout float metalMask,
  inout float rawWoodMask,
  inout float bumpH,
  inout float roughMod
) {
  if (faceStyle == 9) return; // None (faceless)

  const int pat = DOLL_PATTERN;
  int fin = int(uFinish + 0.5);
  float lacqScale = (fin == 1 || fin == 2) ? 1.15 : 0.72;
  vec2 fp = vec2(theta * 0.43, (h - 0.79) * DOLL_H);

  // 8: MINIMAL BAUHAUS (Bauhaus framed face medallion: crisp ink border ring + wide arched parted bangs + two dot eyes)
  if (faceStyle == 8) {
    if (pat == 0) {
      vec2 bp = vec2(theta * 0.43, (h - 0.798) * DOLL_H);
      float dMed = length(bp * vec2(0.92, 1.02)) - 0.258;
      if (dMed > 0.030) return;
      float mMed = aaMask(dMed);
      float bMed = smoothstep(0.011, -0.011, dMed);
      float dRing = abs(dMed) - 0.010;
      float dPartL = length(bp - vec2(-0.175, -0.095)) - 0.215;
      float dPartR = length(bp - vec2(0.175, -0.095)) - 0.215;
      float dHair = max(dMed, -min(dPartL, dPartR));
      dHair = max(dHair, -bp.y - 0.015);
      float dEye = min(length(bp - vec2(-0.105, -0.025)), length(bp - vec2(0.105, -0.025))) - 0.028;
      float dFeat = min(min(dHair, dEye), dRing);
      vec3 fCol = mix(uBaseColor, uSkin, 0.72);
      col = mix(col, fCol, mMed);
      float mFeat = aaMask(dFeat);
      col = mix(col, uAccent, mFeat);
      metalMask *= (1.0 - max(mMed, mFeat));
      rawWoodMask *= (1.0 - max(mMed, mFeat));
      float bFeat = smoothstep(0.008, -0.008, dFeat);
      bumpH = mix(bumpH, 0.0, bMed) + (bMed * 0.00044 + bFeat * 0.00050) * lacqScale;
      roughMod = mix(roughMod, 0.0, mMed);
      return;
    }
    float dDome = length(fp * vec2(0.95, 1.02)) - 0.275;
    if (dDome > 0.025) return;
    float mDome = aaMask(dDome);
    float bDome = smoothstep(0.011, -0.011, dDome);
    vec3 fCol = uSkin;
    float dArchOuter = length(fp - vec2(0.0, 0.045)) - 0.25;
    float dPartL = length(fp - vec2(-0.155, -0.025)) - 0.185;
    float dPartR = length(fp - vec2(0.155, -0.025)) - 0.185;
    float dHair = max(max(dArchOuter, -min(dPartL, dPartR)), -fp.y - 0.015);
    fCol = mix(fCol, uAccent, aaMask(dHair));
    float dEye = min(length(fp - vec2(-0.105, -0.005)), length(fp - vec2(0.105, -0.005))) - 0.027;
    fCol = mix(fCol, uAccent, aaMask(dEye));
    float bFeat = smoothstep(0.008, -0.008, min(dHair, dEye)) * bDome;
    col = mix(col, fCol, mDome);
    metalMask *= (1.0 - mDome);
    rawWoodMask *= (1.0 - mDome);
    bumpH = mix(bumpH, 0.0, bDome) + (bDome * 0.00048 + bFeat * 0.00046) * lacqScale;
    roughMod = mix(roughMod, 0.0, mDome);
    return;
  }

  // Opaque face medallion for emoji expressions 0..7
  float faceR = 0.268;
  float dFace = length(fp * vec2(0.98, 1.04)) - faceR;
  if (dFace > 0.025) return;
  float mFace = aaMask(dFace);
  float bFace = smoothstep(0.011, -0.011, dFace);

  vec3 fCol = uSkin;
  float dHair = 1e3;

  // Family-appropriate hair framing (keeps each family's recognizable visual identity)
  if (pat == 1 || pat == 3 || pat == 4 || pat == 9) {
    // Scalloped bangs (Pastel Drip uses bright pastel hair, Terracotta Folk uses deep earthy tint, Porcelain Shawl uses warm ginger)
    float scallop = 0.018 * cos(fp.x * 28.0);
    dHair = -(fp.y - 0.122 + scallop);
    vec3 hairCol = pat == 1 ? uColor1 : (pat == 9 ? uAccent : uColor1 * 0.72);
    fCol = mix(fCol, hairCol, aaMask(dHair));
  } else if (pat == 5) {
    // Sleek asymmetric side-part for Dipped Studio (kept clear of raised brows)
    float dSide = max(length(fp - vec2(-0.06, 0.11)) - 0.24, -(fp.y - 0.095 + 0.26 * fp.x));
    dHair = min(dSide, -(fp.y - 0.152));
    fCol = mix(fCol, uAccent, aaMask(dHair));
  } else if (pat == 12 || pat == 13 || pat == 14) {
    // Center-parted arched curtain bangs (golden blonde for Gel Overlap, sleek jet black for Modern Folk & Scandi Emblem)
    float dPartL = length(fp - vec2(-0.19, -0.02)) - 0.215;
    float dPartR = length(fp - vec2(0.19, -0.02)) - 0.215;
    dHair = max(-min(dPartL, dPartR), -(fp.y - 0.075));
    vec3 hairCol = pat == 12 ? vec3(0.95, 0.80, 0.14) : uAccent;
    fCol = mix(fCol, hairCol, aaMask(dHair));
  } else {
    // Sleek arched hair cap (Monochrome, Babushka, Patchwork, Mosaic, Folk Graphic, Bauhaus override)
    dHair = -(fp.y - 0.128 + 0.16 * fp.x * fp.x);
    fCol = mix(fCol, uAccent, aaMask(dHair));
    if (pat == 6) {
      // Crisp outline ring on Folk Graphic
      float dRing = abs(dFace) - 0.012;
      fCol = mix(fCol, uAccent, aaMask(dRing));
      dHair = min(dHair, dRing);
    }
  }

  // Soft rosy cheeks helper (used on warm/happy emoji expressions)
  float dBlush = min(length(fp - vec2(-0.152, -0.048)), length(fp - vec2(0.152, -0.048))) - 0.046;
  float mBlush = smoothstep(0.022, -0.022, dBlush);

  // Eye coordinates & unified SDF accumulator for raised lacquered paint edges on facial features
  vec2 eyeL = vec2(-0.098, 0.012);
  vec2 eyeR = vec2(0.098, 0.012);
  float dFeat = 1e3;

  if (faceStyle == 0) {
    // 0: 😊 HAPPY — happy upward-curved closed eyes (◠ ◠) + sweet curved smile + rosy cheeks
    fCol = mix(fCol, uBlush, mBlush * 0.62);
    vec2 ep = vec2(abs(fp.x) - 0.10, fp.y - 0.012);
    float dEye = max(abs(length(ep - vec2(0.0, -0.048)) - 0.062) - 0.009, max(abs(ep.x) - 0.042, -(ep.y + 0.012)));
    fCol = mix(fCol, uAccent, aaMask(dEye));
    vec2 sp = fp - vec2(0.0, -0.028);
    float dSmile = max(abs(length(sp) - 0.048) - 0.0085, sp.y + 0.016);
    fCol = mix(fCol, uAccent, aaMask(dSmile));
    dFeat = min(dEye, dSmile);
  } else if (faceStyle == 1) {
    // 1: 😉 WINK — left bright dot eye with catchlight, right happy wink arc (◠) + cheeky smile + blush
    fCol = mix(fCol, uBlush, mBlush * 0.58);
    float dEyeL = length(fp - eyeL) - 0.027;
    fCol = mix(fCol, uAccent, aaMask(dEyeL));
    fCol = mix(fCol, vec3(1.0), aaMask(length(fp - (eyeL + vec2(-0.008, 0.009))) - 0.0085) * 0.92);
    vec2 er = fp - vec2(0.102, 0.012);
    float dWink = max(abs(length(er - vec2(0.0, -0.045)) - 0.058) - 0.009, max(abs(er.x) - 0.040, -(er.y + 0.010)));
    fCol = mix(fCol, uAccent, aaMask(dWink));
    // Playful slightly tilted smile
    vec2 sp = fp - vec2(0.01, -0.032);
    float dSmile = max(abs(length(sp) - 0.048) - 0.0085, sp.y + 0.014 - sp.x * 0.25);
    fCol = mix(fCol, uAccent, aaMask(dSmile));
    dFeat = min(min(dEyeL, dWink), dSmile);
  } else if (faceStyle == 2) {
    // 2: 😮 SURPRISED — wide bright eyes, tiny raised brows, cute round "o" mouth
    fCol = mix(fCol, uBlush, mBlush * 0.45);
    float dEye = min(length(fp - eyeL), length(fp - eyeR)) - 0.030;
    fCol = mix(fCol, uAccent, aaMask(dEye));
    float dSpark = min(length(fp - (eyeL + vec2(-0.009, 0.010))), length(fp - (eyeR + vec2(-0.009, 0.010)))) - 0.0095;
    fCol = mix(fCol, vec3(1.0), aaMask(dSpark) * 0.92);
    // Raised little brows
    vec2 bp = vec2(abs(fp.x) - 0.10, fp.y - 0.072);
    float dBrow = max(abs(length(bp - vec2(0.0, -0.055)) - 0.065) - 0.007, max(abs(bp.x) - 0.032, -(bp.y + 0.008)));
    fCol = mix(fCol, uAccent, aaMask(dBrow));
    // Cute round "o" mouth
    vec2 mp = (fp - vec2(0.0, -0.072)) * vec2(1.12, 0.92);
    float dO = length(mp) - 0.034;
    fCol = mix(fCol, uAccent, aaMask(dO));
    fCol = mix(fCol, uBlush * 0.85, aaMask(dO + 0.014));
    dFeat = min(min(dEye, dBrow), dO);
  } else if (faceStyle == 3) {
    // 3: 😌 SERENE — peaceful downward-curved closed eyes (◡ ◡) + gentle smile + soft blush
    fCol = mix(fCol, uBlush, mBlush * 0.55);
    vec2 ep = vec2(abs(fp.x) - 0.10, fp.y - 0.014);
    float dEye = max(abs(length(ep - vec2(0.0, 0.048)) - 0.060) - 0.0085, max(abs(ep.x) - 0.040, ep.y - 0.010));
    fCol = mix(fCol, uAccent, aaMask(dEye));
    vec2 sp = fp - vec2(0.0, -0.028);
    float dSmile = max(abs(length(sp) - 0.044) - 0.008, sp.y + 0.018);
    fCol = mix(fCol, uAccent, aaMask(dSmile));
    dFeat = min(dEye, dSmile);
  } else if (faceStyle == 4) {
    // 4: 😏 SMIRK — cool dot eyes glancing slightly aside + angled brows + asymmetric smirk
    vec2 glance = vec2(0.012, 0.0);
    float dEye = min(length(fp - (eyeL + glance)), length(fp - (eyeR + glance))) - 0.025;
    fCol = mix(fCol, uAccent, aaMask(dEye));
    // Asymmetric confident brows
    float dBrowL = sdSegment(fp, vec2(-0.132, 0.056), vec2(-0.064, 0.052)) - 0.0075;
    float dBrowR = sdSegment(fp, vec2(0.064, 0.058), vec2(0.134, 0.072)) - 0.0075;
    float dBrows = min(dBrowL, dBrowR);
    fCol = mix(fCol, uAccent, aaMask(dBrows));
    // Asymmetric side smirk
    vec2 sp = fp - vec2(0.032, -0.038);
    float dSmirk = max(abs(length(sp) - 0.052) - 0.0085, max(sp.y + 0.018, -sp.x - 0.028));
    fCol = mix(fCol, uAccent, aaMask(dSmirk));
    dFeat = min(min(dEye, dBrows), dSmirk);
  } else if (faceStyle == 5) {
    // 5: 😁 GRIN — happy curved eyes + wide D-shaped open beaming grin!
    fCol = mix(fCol, uBlush, mBlush * 0.65);
    vec2 ep = vec2(abs(fp.x) - 0.102, fp.y - 0.016);
    float dEye = max(abs(length(ep - vec2(0.0, -0.046)) - 0.058) - 0.009, max(abs(ep.x) - 0.040, -(ep.y + 0.010)));
    fCol = mix(fCol, uAccent, aaMask(dEye));
    // Wide D-shaped open smile with crisp white teeth inside dark outline
    vec2 gp = fp - vec2(0.0, -0.046);
    float dGrin = max(length(gp * vec2(0.88, 1.15)) - 0.064, gp.y);
    fCol = mix(fCol, uAccent, aaMask(dGrin));
    fCol = mix(fCol, vec3(0.99, 0.98, 0.96), aaMask(dGrin + 0.011));
    dFeat = min(dEye, dGrin);
  } else if (faceStyle == 6) {
    // 6: 🤨 CURIOUS — dot eyes, one flat brow, one high arched brow, tiny tilted "hmm" mouth
    float dEye = min(length(fp - eyeL), length(fp - eyeR)) - 0.026;
    fCol = mix(fCol, uAccent, aaMask(dEye));
    float dSpark = min(length(fp - (eyeL + vec2(-0.008, 0.008))), length(fp - (eyeR + vec2(-0.008, 0.008)))) - 0.008;
    fCol = mix(fCol, vec3(1.0), aaMask(dSpark) * 0.9);
    // Left flat brow, right raised arched brow
    float dBrowL = sdSegment(fp, vec2(-0.132, 0.054), vec2(-0.066, 0.054)) - 0.0075;
    vec2 br = fp - vec2(0.10, 0.074);
    float dBrowR = max(abs(length(br - vec2(0.0, -0.048)) - 0.060) - 0.0075, max(abs(br.x) - 0.036, -(br.y + 0.008)));
    float dBrows = min(dBrowL, dBrowR);
    fCol = mix(fCol, uAccent, aaMask(dBrows));
    // Tiny thoughtful straight/tilted mouth
    float dMouth = sdSegment(fp, vec2(-0.030, -0.068), vec2(0.032, -0.060)) - 0.008;
    fCol = mix(fCol, uAccent, aaMask(dMouth));
    dFeat = min(min(dEye, dBrows), dMouth);
  } else {
    // 7: 🥰 BLISS — happy eyes + sweet smile + extra warm rosy cheeks + cute tiny cheek hearts
    fCol = mix(fCol, uBlush, mBlush * 0.78);
    vec2 ep = vec2(abs(fp.x) - 0.10, fp.y - 0.012);
    float dEye = max(abs(length(ep - vec2(0.0, -0.048)) - 0.062) - 0.009, max(abs(ep.x) - 0.042, -(ep.y + 0.012)));
    fCol = mix(fCol, uAccent, aaMask(dEye));
    vec2 sp = fp - vec2(0.0, -0.028);
    float dSmile = max(abs(length(sp) - 0.048) - 0.0085, sp.y + 0.016);
    fCol = mix(fCol, uAccent, aaMask(dSmile));
    // Cute tiny rosy heart accents near the cheeks
    vec2 hp = vec2(abs(fp.x) - 0.155, fp.y + 0.048);
    float dH1 = length(hp - vec2(-0.011, 0.008)) - 0.014;
    float dH2 = length(hp - vec2(0.011, 0.008)) - 0.014;
    float dHTip = length((hp - vec2(0.0, -0.008)) * vec2(1.25, 1.0)) - 0.016;
    float dHeart = min(min(dH1, dH2), dHTip);
    fCol = mix(fCol, uBlush * 0.82, aaMask(dHeart) * 0.9);
    dFeat = min(min(dEye, dSmile), dHeart);
  }

  float bHair = smoothstep(0.009, -0.009, dHair) * bFace;
  float bFeat = smoothstep(0.006, -0.006, dFeat) * bFace;

  col = mix(col, fCol, mFace);
  metalMask *= (1.0 - mFace);
  rawWoodMask *= (1.0 - mFace);
  bumpH = mix(bumpH, 0.0, bFace) + (bFace * 0.00050 + bHair * 0.00042 + bFeat * 0.00048) * lacqScale;
  roughMod = mix(roughMod, 0.0, mFace);
}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifndef PIPELINE_COLOR
  if (uFade > 0.85 && ign(gl_FragCoord.xy) < (uFade - 0.85) / 0.15) discard;
  #ifdef PIPELINE_SHADOW
  s.alpha = uShadowAlpha;
  #endif
  return;
#endif
  gAA = max(length(fwidth(vObjectPosition)), 0.0018);
  gPxH = max(fwidth(vH), 0.0006);
  float bumpOut = 0.0;
  vec3 p = vObjectPosition;
  const int pat = DOLL_PATTERN;
  int fin = int(uFinish + 0.5);
  int faceStyle = int(uFace + 0.5);

  // Raw wooden / bisque interior & rabbet lip
  if (vPart > 0.5) {
    if (uFade > 0.85 && ign(gl_FragCoord.xy) < (uFade - 0.85) / 0.15) discard;
    vec3 wCol;
    float wH;
    woodGrain(p, wCol, wH);
    // Ceramic finish has pale warm unglazed bisque stoneware rim & interior
    if (fin == 2) {
      float speck = snoise(p * 42.0) * 0.035;
      wCol = vec3(0.84, 0.79, 0.72) * (1.0 + speck);
      wH = snoise(p * 55.0) * 0.00018;
    }
    // Rich hollow cavity occlusion
    float cavAO = mix(1.0, 0.42, clamp(vCavity, 0.0, 1.0));
    s.albedo = wCol * cavAO;
    s.roughness = fin == 2 ? 0.86 : 0.76;
    s.metalness = 0.0;
    s.occlusion *= mix(1.0, 0.65, clamp(vCavity, 0.0, 1.0));
    bumpOut = wH;
    if (uFade > 0.001) {
      vec3 dir = normalize(vWorldPosition - cameraPosition);
      float grad = smoothstep(-0.65, 0.75, dir.y);
      float radial = mix(1.6, 0.32, smoothstep(0.0, 0.8, length((gl_FragCoord.xy - 0.5 * resolution) / resolution.y)));
      vec3 bgCol = uBgColor * uBgLevel * mix(0.84, 1.12, grad) * radial * (1.0 + uBgWallFill * 1.45);
      s.albedo *= (1.0 - uFade);
      s.specular *= (1.0 - uFade);
      s.roughness = mix(s.roughness, 1.0, uFade);
      s.emissive = mix(s.emissive, bgCol, uFade);
    }
  } else {
    if (uFade > 0.85 && ign(gl_FragCoord.xy) < (uFade - 0.85) / 0.15) discard;

    float theta = atan(p.x, p.z);
    float h = clamp(vH, 0.0, 1.0);

    vec3 col;
    float metalMask;
    float rawWoodMask;
    float bumpH;
    float roughMod;
    evalPattern(pat, p, theta, h, col, metalMask, rawWoodMask, bumpH, roughMod);
    evalFace(faceStyle, theta, h, col, metalMask, rawWoodMask, bumpH, roughMod);

    // Micro-surface texture & material finish physics
    vec3 wCol;
    float wH;
    woodGrain(p, wCol, wH);
    float microGrain = snoise(p * 48.0) * 0.00012;
    float cloud = snoise(p * 5.2) * 0.018;

    float baseRough = 0.52;
    float specF0 = 1.0;

    if (fin == 0) {
      // Matte Painted Wood (Refs #1, #5, #7)
      baseRough = 0.66;
      col *= 1.0 + cloud + (wH * 28.0);
      bumpH += wH * 0.45 + microGrain * 0.7;
      s.sheenColor = col * 0.12;
      s.sheenRoughness = 0.72;
    } else if (fin == 1) {
      // Glossy Lacquer (Refs #2, #3, #9)
      baseRough = 0.13;
      specF0 = 1.5;
      bumpH += snoise(p * 14.0) * 0.00004;
    } else if (fin == 2) {
      // Glazed Ceramic (Ref #4)
      baseRough = 0.27;
      specF0 = 1.25;
      float kilnSpeck = smoothstep(0.68, 0.82, snoise(p * 52.0)) * 0.06;
      col *= (1.0 + cloud * 0.6 - kilnSpeck);
      bumpH += snoise(p * 26.0) * 0.00007;
    } else if (fin == 3) {
      // Raw & Dipped (Ref #7)
      baseRough = mix(0.36, 0.75, rawWoodMask);
      bumpH += mix(microGrain * 0.6, wH * 0.9, rawWoodMask);
      col *= 1.0 + cloud * 0.5;
    } else {
      // Satin Enamel & Brushed Brass
      baseRough = 0.38;
      specF0 = 1.15;
      bumpH += microGrain * 0.5;
    }

    // Raw wood areas override roughness/grain regardless of base finish
    if (rawWoodMask > 0.01) {
      baseRough = mix(baseRough, 0.76, rawWoodMask);
      specF0 = mix(specF0, 0.85, rawWoodMask);
    }

    // Metallic gold/brass inlays
    if (metalMask > 0.01) {
      float brush = snoise(vec3(p.x * 6.0, p.y * 140.0, p.z * 6.0)) * 0.05;
      baseRough = mix(baseRough, clamp(0.24 + brush, 0.14, 0.4), metalMask);
      s.metalness = metalMask;
    } else {
      s.metalness = 0.0;
    }

    // Subtle crafted waist seam hairline when closed
    float seamDist = abs(h - SPLIT_H_VAL);
    float seamLine = smoothstep(0.0055, 0.0, seamDist) * (1.0 - clamp(uSeamGap * 4.0, 0.0, 1.0));
    col *= 1.0 - seamLine * 0.28;
    bumpH -= seamLine * 0.0004;

    // Blend slightly into raw wood right at the micro-bevel lip (vPart in 0..0.5)
    float lipMix = smoothstep(0.05, 0.45, vPart);
    col = mix(col, wCol, lipMix);
    baseRough = mix(baseRough, 0.75, lipMix);

    s.albedo = col;
    s.roughness = clamp(baseRough + roughMod + uRoughnessBias, 0.06, 0.96);
    s.specular = specF0;
    bumpOut = bumpH;

    // Smooth atmospheric melt into the studio backdrop color as the separated halves exit
    if (uFade > 0.001) {
      vec3 dir = normalize(vWorldPosition - cameraPosition);
      float grad = smoothstep(-0.65, 0.75, dir.y);
      float radial = mix(1.6, 0.32, smoothstep(0.0, 0.8, length((gl_FragCoord.xy - 0.5 * resolution) / resolution.y)));
      vec3 bgCol = uBgColor * uBgLevel * mix(0.84, 1.12, grad) * radial * (1.0 + uBgWallFill * 1.45);
      s.albedo *= (1.0 - uFade);
      s.metalness *= (1.0 - uFade);
      s.specular *= (1.0 - uFade);
      s.sheenColor *= (1.0 - uFade);
      s.roughness = mix(s.roughness, 1.0, uFade);
      s.emissive = mix(s.emissive, bgCol, uFade);
    }
  }
  s.normal = bumpNormal(s.normal, bumpOut);
}
`,
  });
}

function applyDollSpec(material, spec, roughnessBias = 0) {
  const u = material.uniforms;
  u.uBaseColor.value.copy(spec.colors.base);
  u.uColor1.value.copy(spec.colors.c1);
  u.uColor2.value.copy(spec.colors.c2);
  u.uColor3.value.copy(spec.colors.c3);
  u.uAccent.value.copy(spec.colors.accent);
  u.uSkin.value.copy(spec.colors.skin);
  u.uBlush.value.copy(spec.colors.blush);
  u.uWood.value.copy(spec.colors.wood);
  u.uPattern.value = spec.patternIdx;
  u.uFinish.value = spec.finishIdx;
  u.uFace.value = spec.faceIdx;
  u.uVariant.value = spec.variant;
  u.uPhase.value = spec.phase;
  u.uGold.value = spec.goldAmount;
  u.uRoughnessBias.value = roughnessBias;
}

export { createDollMaterial, applyDollSpec };
