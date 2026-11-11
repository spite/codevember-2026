// The relief, evaluated per pixel: the ornament's primitives live in a grid of cells (data textures), and the
// fragment shader sums the few near each pixel into a height (raised motifs, etched ground, scribed lines) and
// takes its normal by finite differences. The hammer blows displace the mesh in the vertex shader.
import { DataTexture, FloatType, UnsignedIntType, RGBAFormat, RGIntegerFormat, RedIntegerFormat, NearestFilter, Vector3, Matrix3, Color } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { STROKE, LEAF, ROSETTE, BEAD, ARC, FROND, BLOSSOM, DAISY, PEONY, FIVE, CHRYS, BUD, BELL, RIBBON, SCALE, PALMETTE, FRET, ROUNDEL, FLAT, RIBBED, TUBE, NODULE, POD, SPHINCTER, VERTEBRA, VEIN, HOSE, FRIEZE, FEATHER, EGG, REEL, WAVE, GUILLOCHE, ROSE, SUNBURST, WAVES, BARLEYCORN, HOBNAIL, BLADE, BLOOM, POPPY, IRIS } from "./ornament.js";
import { OW, MAX_PER_CELL } from "./pack.js";

function texture(data, w, h, format, type, internal) {
  const t = new DataTexture(data, w, h, format, type);
  if (internal) t.internalFormat = internal;
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Textures from packed arrays (pack.js).
export function buildRelief(p) {
  return {
    prims: texture(p.prims, OW, p.primRows, RGBAFormat, FloatType),
    cells: texture(p.cells, OW, p.cellRows, RGIntegerFormat, UnsignedIntType, "RG32UI"),
    list: texture(p.list, OW, p.listRows, RedIntegerFormat, UnsignedIntType, "R32UI"),
    blows: texture(p.blows, p.blowWidth, 2, RGBAFormat, FloatType),
    blowCount: p.blowCount,
    min: new Vector3(...p.min),
    dim: new Vector3(...p.dim),
    cellSize: p.cellSize,
    stats: p.stats,
  };
}

const common = /* glsl */ `
float ornHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 ornHash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float ornNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ornHash(i), ornHash(i + vec3(1, 0, 0)), f.x), mix(ornHash(i + vec3(0, 1, 0)), ornHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(ornHash(i + vec3(0, 0, 1)), ornHash(i + vec3(1, 0, 1)), f.x), mix(ornHash(i + vec3(0, 1, 1)), ornHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const vertexPars = /* glsl */ `
uniform sampler2D ornBlows;
uniform int ornBlowCount;
uniform float ornHammer;
uniform float dentDepth;
out vec3 vBase;
`;

const vertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  vBase = p;
  vec3 g = vec3(0.0);
  float h = 0.0;
  for (int i = 0; i < 256; i++) {
    if (i >= ornBlowCount) break;
    vec4 b1 = texelFetch(ornBlows, ivec2(i, 1), 0);
    float s = clamp((ornHammer - b1.y) / 0.012, 0.0, 1.0);
    if (s <= 0.0) continue;
    vec4 b0 = texelFetch(ornBlows, ivec2(i, 0), 0);
    vec3 dp = p - b0.xyz;
    float R2 = b0.w * b0.w;
    float x = dot(dp, dp) / R2;
    if (x >= 1.0) continue;
    // The blow overshoots, then the metal springs back a little.
    float amp = dentDepth * b1.x * (1.0 + 0.5 * sin(s * 3.14159));
    float f = 1.0 - x;
    h -= amp * f * f;
    g += amp * 4.0 * f * dp / R2;
  }
  vec3 n0 = n;
  n = normalize(n - (g - n * dot(n, g)));
  return p + n0 * h;
}
`;

const fragmentPars = /* glsl */ `
uniform sampler2D ornPrims;
uniform highp usampler2D ornCells;
uniform highp usampler2D ornList;
uniform vec3 ornMin;
uniform vec3 ornDim;
uniform float ornCellSize;
uniform mat3 ornModel;
uniform int ornSamples;
uniform float ornFar;
uniform float ornDraw;
uniform float ornHammer;
uniform float ornEtch;
uniform float ornPatina;
uniform float ornBurnish;
uniform float ornTime;
uniform float reliefHeight;
uniform float shaveLevel;
uniform float etchDepth;
uniform float wallWidth;
uniform float lineDepth;
uniform float chaseDepth;
uniform float motifCrust;
uniform float groundTone;
uniform float burnishReach;
uniform float matting;
uniform float bubbles;
uniform float acidLine;
uniform float acidRipple;
uniform float etchStain;
uniform vec3 metalColor;
uniform vec3 patinaColor;
uniform vec3 patinaColor2;
uniform float patinaMetal;
uniform float oxideRough;
uniform float depositAmount;
uniform float patinaRough;
uniform float groundRough;
uniform float groundDark;
uniform float blankRough;
uniform float polishRough;
uniform vec3 groundColor;
uniform float guilloche;
uniform float mokume;
uniform float anodize;
uniform float fillPearl;
uniform float cloison;
uniform float fillCushion;
uniform float enamelOn;
uniform float ornFill;
uniform float ornFire;
uniform float ornGrind;
uniform float fillLevel;
uniform float fireLevel;
uniform float fillLines;
uniform float fillKeep;
uniform float fillSag;
uniform vec3 fillColor;
uniform vec3 fillColor2;
uniform float fillBand;
uniform float fillClear;
uniform float fillMetal;
uniform float fillRough;
uniform float fillGlow;
in vec3 vBase;

#define ORN_OW 4096
#define ORN_PI 3.14159265

${common}

vec4 ornTexel(int id, int k) {
  int i = id * 5 + k;
  return texelFetch(ornPrims, ivec2(i % ORN_OW, i / ORN_OW), 0);
}

float ornRaise(float th) {
  // The last blows land within 0.05 of the end: every motif is fully up once the hammering is done.
  float r = max(clamp((ornHammer - th) / 0.05, 0.0, 1.0), step(1.0, ornHammer)) - 1.0;
  return 1.0 + 2.7 * r * r * r + 1.7 * r * r;
}

// res: x = signed distance to the drawn motifs (min), y = height of the raised motifs (max, in object units),
// z = how much the nearby motifs rise over the ground (tangent of their elevation, for occlusion),
// w = how deep in a fold or groove of the top motif this is (0..1, for the patina).
void ornAccum(inout vec4 res, float d, float h, float hs, float reveal, float cav) {
  if (reveal <= 0.0) return;
  res.x = min(res.x, d);
  if (d < 0.0) {
    if (h > res.y) res.yw = vec2(h, cav);
  } else res.z = max(res.z, hs / (d * 2.5 + hs * 0.6 + 1e-5));
}

// Merges one element's result into the pixel's, as ornAccum would have.
void ornMerge(inout vec4 res, vec4 r) {
  res.x = min(res.x, r.x);
  if (r.y > res.y) res.yw = r.yw;
  res.z = max(res.z, r.z);
}

// A stem's cross-section: a rounded swell with a chased line down its length, so it reads as two strands.
float ornStem(float x, float rr, float lw, out float cav) {
  float g = exp(-x * x / 0.035) * smoothstep(2.5, 6.0, rr / lw);
  cav = g;
  return sqrt(1.0 - x * x) * (1.0 - 0.35 * g);
}

// An acanthus blade in its own frame: u from base (0) to tip (1) and v across, in units of its length. wr: half
// width over length, N: lobes per side, hook: how far the tip rolls sideways, bodyW: uncut body either side of the
// midrib, as a fraction of the half width. Returns (signed distance, height, cavity).
vec3 ornAcanthus(float u, float v, float wr, float N, float seed, float hook, float bodyW) {
  v -= hook * wr * u * u * u;
  float av = abs(v);
  float sgn = v >= 0.0 ? 1.0 : -1.0;
  float E = wr * pow(max(sin(ORN_PI * pow(clamp(u, 0.0, 1.0), 0.7)), 0.0), 0.65);
  // Notch lines fan out from sideways at the base to forward at the tip, bending forward as they go out.
  float u0 = (u - 0.05 * av - 0.5 * av * av) / (1.0 + 0.6 * av);
  float sp = 0.86 / (N + 0.4);
  float p = u0 / sp - (sgn > 0.0 ? 0.0 : 0.4);
  float i = floor(p);
  float f = p - i;
  float hi = ornHash(vec3(i, sgn, seed * 57.0));
  // Two forward-pointing fingers per lobe.
  float sc = fract(f * 2.0 + 0.05);
  float tooth = 1.0 - (1.0 - sc) * (1.0 - sc);
  float prof = i > N - 1.0 ? 1.0 : (0.72 + 0.28 * tooth * smoothstep(0.1, 0.3, f)) * (0.75 + 0.25 * sin(ORN_PI * f));
  float reach = E * 1.05 * prof;
  float d = av - reach;
  float perp = (1.0 + 0.6 * av) / sqrt(1.0 + pow(0.05 + 0.6 * u0 + av, 2.0));
  float dn = min(f, 1.0 - f) * sp * perp;
  float Bm = 0.04 * wr + 0.1 * E;
  float Bn = Bm + bodyW * E;
  float j = f < 0.5 ? i : i + 1.0;
  float eye = 0.0;
  if (j >= 0.0 && j <= N) {
    // A deep notch ending in a round eye near the midrib.
    float nw = 0.004 + 0.035 * smoothstep(Bn, Bn + 0.4 * wr, av);
    float notch = min(max(dn - nw, Bn - av), length(vec2(dn, av - Bn)) - 0.018);
    d = max(d, -notch);
    eye = exp(-pow(notch / 0.012, 2.0));
  }
  d = max(d, max(-u, u - 1.0));
  float ar = clamp(av / max(reach, 1e-4), 0.0, 1.0);
  // Each lobe a convex pad with a cupped rim, a short vein and its fingers modeled on the edge.
  float pad = sqrt(max(0.0, sin(ORN_PI * f) * sin(ORN_PI * clamp(0.15 + 0.85 * ar, 0.0, 1.0))));
  float rim = smoothstep(0.6, 0.95, ar) * sin(ORN_PI * sc) * smoothstep(0.1, 0.3, f);
  float vein = exp(-pow((f - 0.55) * 9.0, 2.0)) * smoothstep(0.3, 0.5, ar) * (1.0 - smoothstep(0.7, 0.9, ar));
  float h = 0.45 + 0.4 * pad + 0.15 * rim + (hi - 0.5) * 0.4 * (f - 0.5) - 0.12 * vein + 0.05 * i;
  if (av < Bm) h = max(h, 0.7 + 0.15 * sqrt(max(0.0, 1.0 - av * av / (Bm * Bm))));
  // The whole blade is convex, and rises to its tip, which rolls over.
  h += 0.3 * (1.0 - pow(min(av / max(E * 1.05, 1e-4), 1.0), 2.0)) + 0.35 * smoothstep(0.55, 0.95, u);
  float groove = exp(-pow((av - wr * 0.09) / (wr * 0.03), 2.0));
  h += 0.2 * exp(-pow(v / (wr * 0.05), 2.0)) - 0.1 * groove;
  float cav = clamp(0.9 * vein + 0.8 * groove + 0.5 * eye + 0.35 * (1.0 - pad) * (1.0 - step(av, Bm)), 0.0, 1.0);
  return vec3(d, h, cav);
}

// A rounded shoulder at the outline: 0 on it, 1 a width w inside.
float ornShoulder(float d, float w) {
  float s = clamp(-d / max(w, 1e-6), 0.0, 1.0);
  return sqrt(s * (2.0 - s));
}

// One petal along +x from the origin, in its own frame. len: length, w: half width, rnd: 0 pointed .. 1 round tip,
// notch: depth of the notch at the tip, cup: how much the edges rise, twist: one edge higher (petals overlap).
// Returns (signed distance, height ~0..1, cavity).
vec3 ornPetal(vec2 p, float len, float w, float rnd, float notch, float cup, float twist) {
  float u = p.x / len;
  float uc = clamp(u, 0.0, 1.0);
  float pointed = pow(sin(ORN_PI * pow(uc, 1.25)), 0.7);
  float sr = clamp((uc - 0.5) / 0.5, 0.0, 1.0);
  float round_ = sqrt(max(0.0, 1.0 - sr * sr)) * smoothstep(-0.05, 0.4, uc);
  float hw = w * mix(pointed, round_, rnd) + 1e-6;
  float ay = abs(p.y);
  // notch > 0: one notch at the tip; < 0: a toothed tip (three teeth).
  float umax = notch >= 0.0 ? 1.0 - notch * max(0.0, 1.0 - ay / (0.35 * w)) : 1.0 + notch * pow(abs(sin(ay / w * ORN_PI * 1.5)), 0.6) * smoothstep(1.0, 0.6, ay / w);
  float d = max(max(ay - hw, (u - umax) * len), -p.x);
  float ny = clamp(p.y / hw, -1.0, 1.0);
  float n2 = ny * ny;
  // Cupped across with a soft crease down the middle, swelling then rolling down at the tip, a vein either side.
  float crease = exp(-n2 * 14.0);
  float veins = exp(-pow((abs(ny) - 0.55) * 8.0, 2.0)) * uc;
  float across = 0.6 + cup * 0.4 * n2 - 0.22 * crease - 0.06 * veins;
  float along = 0.6 + 0.4 * sin(ORN_PI * (0.2 + 0.75 * uc));
  float h = across * along * (0.5 + 0.5 * sqrt(1.0 - n2 * 0.9)) + twist * ny * uc;
  // A chased line just inside the outline, so overlapping petals stay distinct.
  float line = exp(-pow(d / (0.08 * w), 2.0));
  h -= 0.12 * line;
  // Soften the outline into a rounded shoulder.
  h *= 0.55 + 0.45 * ornShoulder(d, 0.25 * w);
  return vec3(d, h, clamp(0.7 * crease * uc + 0.5 * veins + line + 0.3 * (1.0 - uc), 0.0, 1.0));
}

// The nearest petals of a ring of P around the origin: (signed distance, height, cavity) of their union.
vec3 ornPetalRing(vec2 xy, float P, float off, float seed, float len, float w, float rnd, float notch, float cup, float twist) {
  float th = atan(xy.y, xy.x) / (2.0 * ORN_PI) * P - off;
  float k0 = floor(th + 0.5);
  float k1 = k0 + (th > k0 ? 1.0 : -1.0);
  vec3 res = vec3(1e3, 0.0, 0.0);
  for (int j = 0; j < 2; j++) {
    float k = j == 0 ? k0 : k1;
    float hk = ornHash(vec3(k, seed * 97.0, 3.1));
    float a = (k + off + (hk - 0.5) * 0.12) / P * 2.0 * ORN_PI;
    vec2 pp = vec2(cos(a) * xy.x + sin(a) * xy.y, -sin(a) * xy.x + cos(a) * xy.y);
    vec3 r = ornPetal(pp, len * (0.9 + 0.16 * hk), w, rnd, notch, cup, twist);
    res.x = min(res.x, r.x);
    if (r.x < 0.0 && r.y > res.y) res.yz = r.yz;
  }
  return res;
}

// Seeded centre of radius rc: a dome of granules, as (height ~0..1, cavity).
vec2 ornSeeds(vec2 xy, float rc) {
  float x = length(xy) / rc;
  float rings = 3.0;
  float ri = floor(x * rings);
  float cnt = max(1.0, floor(6.3 * (ri + 0.5)));
  float a = atan(xy.y, xy.x) / (2.0 * ORN_PI) * cnt + ri * 0.37;
  vec2 cell = vec2(fract(x * rings) - 0.5, (fract(a) - 0.5) * (ri + 0.5) * 2.0 * ORN_PI / cnt * rings * 0.95);
  float g = max(0.0, 1.0 - dot(cell, cell) * 4.5);
  return vec2(sqrt(max(0.0, 1.0 - x * x)) * 0.7 + 0.3 * sqrt(g), 0.7 * (1.0 - sqrt(g)));
}

void ornTangent(vec3 n, vec3 axis, out vec3 ax, out vec3 sd) {
  ax = axis - n * dot(n, axis);
  float l = length(ax);
  ax = l > 1e-4 ? ax / l : normalize(cross(n, abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  sd = cross(n, ax);
}

// A tapered capsule in 2D: (signed distance, distance over radius, along 0..1).
vec3 ornCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 ba = b - a;
  float t = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
  float r = mix(ra, rb, t);
  float dist = length(p - a - ba * t);
  return vec3(dist - r, dist / max(r, 1e-6), t);
}

// Keeps the higher of two parts of a motif, as (signed distance, height, cavity).
void ornUnion(inout vec3 acc, float d, float h, float cav) {
  acc.x = min(acc.x, d);
  if (d < 0.0 && h > acc.y) acc.yz = vec2(h, cav);
}

void ornEval(vec4 t0, vec4 t1, vec4 t2, vec4 t3, vec3 q, vec3 n, float lw, inout vec4 res) {
  int type = int(t0.w + 0.5);
  float progress = clamp((ornDraw - t3.x) / max(t3.y - t3.x, 1e-4), 0.0, 1.0);
  float raise = ornRaise(t3.z);
  // Only the types a piece uses are compiled in (ORN_T<type>), which keeps the program small.
#ifdef ORN_T${STROKE}
  if (type == ${STROKE}) {
    vec3 pa = q - t0.xyz;
    vec3 ba = t1.xyz - t0.xyz;
    float tt = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
    float rr = mix(t1.w, t2.x, tt);
    float dist = length(pa - ba * tt);
    float d = dist - rr;
    float x = clamp(dist / rr, 0.0, 1.0);
    // Half-round.
    float hs = rr * 0.95 * t3.w * raise;
    float cav;
    float h = ornStem(x, rr, lw, cav);
    ornAccum(res, d, hs * h, hs, step(mix(t3.x, t3.y, tt), ornDraw), cav);
  }
#endif
#ifdef ORN_T${ARC}
  if (type == ${ARC}) {
    // A circular arc around t2.xyz from t0 to t1: exact distance to the circle within its wedge, else the ends.
    vec3 C = t2.xyz;
    vec3 u = t0.xyz - C;
    vec3 v = t1.xyz - C;
    vec3 w = q - C;
    float rho = length(u);
    vec3 m = normalize(cross(u, v));
    float wz = dot(w, m);
    vec3 wp = w - m * wz;
    float tt;
    float dist;
    if (dot(cross(u, wp), m) >= 0.0 && dot(cross(wp, v), m) >= 0.0) {
      float total = atan(length(cross(u, v)), dot(u, v));
      float a = atan(length(cross(u, wp)), dot(u, wp));
      tt = clamp(a / max(total, 1e-6), 0.0, 1.0);
      dist = length(vec2(length(wp) - rho, wz));
    } else {
      float da = length(q - t0.xyz);
      float db = length(q - t1.xyz);
      tt = da < db ? 0.0 : 1.0;
      dist = min(da, db);
    }
    float rr = mix(t1.w, t2.w, tt);
    float d = dist - rr;
    float x = clamp(dist / rr, 0.0, 1.0);
    float hs = rr * 0.95 * t3.w * raise;
    float cav;
    float h = ornStem(x, rr, lw, cav);
    ornAccum(res, d, hs * h, hs, step(mix(t3.x, t3.y, tt), ornDraw), cav);
  }
#endif
#ifdef ORN_T${LEAF}
  if (type == ${LEAF}) {
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float y = dot(dv, sd);
    float L = t1.w;
    float W = t2.x;
    float curl = t2.y;
    float u = x;
    float v = y;
    if (abs(curl) > 1e-3) {
      float R = 1.0 / curl;
      float sg = sign(curl);
      u = atan(x, -(y - R) * sg) * abs(R);
      v = R - sg * length(vec2(x, y - R));
    }
    float hook = (fract(t2.w * 7.31) - 0.5) * 2.0;
    vec3 dh = ornAcanthus(u / L, v / L, W / L, t2.z, t2.w, hook, 0.22);
    float d = dh.x * L;
    float pillow = ornShoulder(d, 0.09 * W);
    float hs = L * 0.26 * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(u / L, progress) * step(0.0, u);
    ornAccum(res, d, dh.y * (0.35 + 0.65 * pillow) * hs, hs, reveal, clamp(dh.z + 0.4 * (1.0 - pillow), 0.0, 1.0));
  }
#endif
#ifdef ORN_T${FROND}
  if (type == ${FROND}) {
    // A log spiral is a straight line in log-polar coordinates, so the frond is laid out there at constant size.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float b = abs(t2.x);
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd) * sign(t2.x));
    float rho0 = t1.w;
    float r = max(length(xy), rho0 * 1e-3);
    float hs = r * 0.13 * raise;
    if (r > rho0 * 1.75) {
      ornAccum(res, r - rho0 * 1.4, 0.0, hs, 1.0, 0.0);
      return;
    }
    float ph = atan(xy.y, xy.x);
    ph += ph < 0.0 ? 2.0 * ORN_PI : 0.0;
    float Y = log(r / rho0);
    float k = sqrt(1.0 + b * b);
    float Phi = t2.y;
    float psiEnd = Phi * k;
    float per = 2.0 * ORN_PI * k / t2.z;
    float n0 = floor((-Y / b - ph) / (2.0 * ORN_PI));
    float d = 1e3;
    float h = -1.0;
    float cv = 0.0;
    float fx = 1.0;
    for (int j = 0; j < 2; j++) {
      float X = ph + 2.0 * ORN_PI * (n0 + float(j));
      float psi = (X - b * Y) / k;
      float eta = (b * X + Y) / k;
      float f = clamp(psi / psiEnd, 0.0, 1.0);
      // Midrib, swelling into the eye.
      float wm = 0.085 + 0.08 * smoothstep(0.88, 1.0, f);
      float dm = length(vec2(psi - clamp(psi, 0.0, psiEnd), eta)) - wm;
      if (dm < d) { d = dm; fx = f; }
      if (dm < 0.0) {
        float hm = 0.55 + 0.5 * sqrt(max(0.0, 1.0 - eta * eta / (wm * wm))) + 0.4 * smoothstep(0.85, 1.0, f);
        if (hm > h) { h = hm; cv = 0.4 * exp(-pow(eta / (wm * 0.25), 2.0)) * smoothstep(2.0, 4.0, wm * r / lw); }
      }
      // Leaflets: big ones on the outside, small ones on the inside, leaning toward the eye.
      float side = eta >= 0.0 ? 1.0 : -1.0;
      float ae = abs(eta);
      float off = side > 0.0 ? 0.0 : 0.5;
      const float lean = 0.95;
      float ic = floor((psi - ae * tan(lean)) / per - off);
      for (int m = -1; m <= 1; m++) {
        float i = ic + float(m);
        float pi0 = (i + off + 0.5) * per;
        float fi = pi0 / psiEnd;
        if (fi < 0.02 || fi > 0.9) continue;
        float env = smoothstep(0.0, 0.1, fi) * (1.0 - 0.6 * smoothstep(0.35, 0.9, fi));
        float li = (side > 0.0 ? 0.8 : 0.45) * env + 1e-4;
        vec2 rel = vec2(psi - pi0, ae - wm * 0.4);
        float lu = (rel.x * sin(lean) + rel.y * cos(lean)) / li;
        float lv = (rel.x * cos(lean) - rel.y * sin(lean)) / li;
        float sdi = ornHash(vec3(i, t2.w * 91.0, side));
        vec3 lf = ornAcanthus(lu, lv, 0.48, side > 0.0 && li > 0.45 ? 2.0 : 1.0, sdi, -0.4 - 0.4 * sdi, 0.3);
        float dl = lf.x * li;
        if (dl < d) { d = dl; fx = fi; }
        if (dl < 0.0) {
          float hl = lf.y * li * 2.2 + 0.25;
          if (hl > h) { h = hl; cv = lf.z; }
        }
      }
    }
    // Back to object units: a log-polar length is r times as long.
    d = max(d * r, r - rho0 * 1.4);
    float pillow = ornShoulder(d, 0.035 * rho0);
    float reveal = progress >= 1.0 ? 1.0 : step(fx, progress);
    ornAccum(res, d, max(h, 0.0) * (0.4 + 0.6 * pillow) * hs, hs, reveal, clamp(cv + 0.4 * (1.0 - pillow), 0.0, 1.0));
  }
#endif
#ifdef ORN_T${ROSETTE}
  if (type == ${ROSETTE}) {
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float r = length(xy);
    float R = t1.w;
    float P = t2.x;
    float layers = t2.y;
    float seed = t2.z;
    int kind = int(t2.w + 0.5);
    float hs = R * 0.36 * raise;
    float a = fract(atan(xy.y, xy.x) / (2.0 * ORN_PI) + 0.5 + seed);
    float reveal = progress >= 1.0 ? 1.0 : step(a, progress);
    if (r > R * 1.3) {
      ornAccum(res, r - R * 1.08, 0.0, hs, reveal, 0.0);
      return;
    }
    // Per kind: centre radius, then each layer from the outside in: length, half width (in petal spacings),
    // roundness, notch, cup, base height.
    float rc = kind == ${PEONY} ? 0.13 : kind == ${CHRYS} ? 0.12 : kind == ${FIVE} ? 0.2 : 0.24;
    vec3 acc = vec3(1e3, 0.0, 0.0);
    float tw = (fract(seed * 7.0) < 0.5 ? 1.0 : -1.0) * 0.1;
    for (int l = 0; l < 3; l++) {
      if (float(l) >= layers) break;
      float fl = float(l);
      float len, wsp, rn, notch, cup, base, PP = P, off = fl * 0.5;
      if (kind == ${DAISY}) {
        len = 1.0 - 0.22 * fl; wsp = 1.15; rn = 0.75; notch = fract(seed * 13.0) < 0.5 ? -0.09 : 0.14; cup = 0.8; base = fl * 0.45;
      } else if (kind == ${PEONY}) {
        len = 1.0 - 0.24 * fl; wsp = 1.3 - 0.1 * fl; rn = 1.0; notch = -0.07; cup = 1.0 + 0.3 * fl; base = fl * 0.55;
      } else if (kind == ${FIVE}) {
        // Pointed sepals, then the broad heart-notched petals between them.
        len = l == 0 ? 1.0 : 0.88; wsp = l == 0 ? 0.42 : 1.15; rn = l == 0 ? 0.0 : 0.9; notch = l == 0 ? 0.0 : 0.2;
        cup = l == 0 ? 0.3 : 0.9; base = fl * 0.3;
      } else {
        len = 1.0 - 0.2 * fl; wsp = 1.05; rn = 0.25; notch = 0.0; cup = 1.0; base = fl * 0.5; PP = P - fl * 2.0; off = fl * 0.37;
      }
      float wd = wsp * ORN_PI * R * 0.62 * len / PP;
      vec3 pr = ornPetalRing(xy, PP, off, seed + fl, R * len, wd, rn, notch, cup, tw);
      acc.x = min(acc.x, pr.x);
      if (pr.x < 0.0 && base + pr.y > acc.y) acc.yz = vec2(base + pr.y, pr.z);
    }
    float rcR = R * rc;
    float xc = r / rcR;
    float top = layers * (kind == ${FIVE} ? 0.3 : 0.5) + 0.25;
    if (xc < 1.0) {
      vec2 sv = ornSeeds(xy, rcR);
      acc.yz = vec2(top + 0.45 * sv.x, sv.y);
    } else if (xc < 1.3 && kind != ${PEONY}) {
      // A collar of stamens around the centre.
      float st = abs(fract(atan(xy.y, xy.x) / (2.0 * ORN_PI) * 22.0) - 0.5);
      float hc = top - 0.1 + 0.12 * smoothstep(0.35, 0.1, st) * sin(ORN_PI * (xc - 1.0) / 0.3);
      if (hc > acc.y) acc.yz = vec2(hc, 0.5 * smoothstep(0.1, 0.35, st));
    }
    acc.x = min(acc.x, r - rcR * 1.05);
    ornAccum(res, acc.x, acc.y * hs, hs * 1.3, reveal, acc.z);
  }
#endif
#ifdef ORN_T${BLOSSOM}
  if (type == ${BLOSSOM}) {
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float L = t1.w;
    float W = t2.x;
    int kind = int(t2.y + 0.5);
    float seed = t2.z;
    float u = xy.x / L;
    vec3 acc = vec3(1e3, 0.0, 0.0);
    float tw = (fract(seed * 5.0) < 0.5 ? 1.0 : -1.0) * 0.15;
    if (kind == ${BUD}) {
      // A teardrop with spiral grooves, held by three sepals.
      vec3 body = ornPetal(xy - vec2(L * 0.08, 0.0), L * 0.92, W, 0.2, 0.0, 0.0, 0.0);
      float ny = xy.y / W;
      float sp = exp(-pow((fract(ny * 1.3 - u * 1.6 + seed) - 0.5) * 7.0, 2.0));
      acc = vec3(body.x, body.y * 0.9 + 0.25 - 0.12 * sp, sp);
      for (int j = -1; j <= 1; j++) {
        float a = float(j) * 0.55;
        vec2 pp = vec2(cos(a) * xy.x + sin(a) * xy.y, -sin(a) * xy.x + cos(a) * xy.y);
        vec3 r = ornPetal(pp, L * (j == 0 ? 0.5 : 0.6), W * 0.32, 0.0, 0.0, 0.4, 0.0);
        acc.x = min(acc.x, r.x);
        if (r.x < 0.0 && 0.45 + r.y * 0.8 > acc.y) acc.yz = vec2(0.45 + r.y * 0.8, r.z);
      }
    } else if (kind == ${BELL}) {
      // A bell flaring to a mouth of three pointed lobes, ribbed, on a small calyx.
      float uc = clamp(u, 0.0, 1.0);
      float hw = W * (0.3 + 0.7 * pow(uc, 1.5)) * (1.0 + 0.25 * smoothstep(0.75, 1.0, uc));
      float ny = xy.y / hw;
      float lobe = abs(cos(ny * ORN_PI * 1.5));
      float umax = 0.85 + 0.15 * pow(lobe, 3.0);
      float d = max(max(abs(xy.y) - hw, (u - umax) * L), -xy.x);
      float n2 = min(ny * ny, 1.0);
      float rib = exp(-pow((abs(ny) - 0.33) * 12.0, 2.0)) + exp(-ny * ny * 100.0) * 0.5;
      float lip = smoothstep(0.72, 0.92, uc);
      float h = (0.35 + 0.6 * sqrt(1.0 - n2)) * (0.6 + 0.4 * uc) - 0.12 * rib * (1.0 - lip) + 0.25 * lip * n2;
      // The open mouth: a hollow under the lip.
      float mouth = lip * smoothstep(0.9, 0.5, abs(ny)) * smoothstep(0.86, 0.95, uc) * (1.0 - smoothstep(0.96, 1.0, uc));
      h -= 0.35 * mouth;
      acc = vec3(d, h * (0.55 + 0.45 * ornShoulder(d, 0.2 * W)), clamp(rib * (1.0 - lip) + mouth, 0.0, 1.0));
      for (int j = -1; j <= 1; j += 2) {
        float a = float(j) * 0.5;
        vec2 pp = vec2(cos(a) * xy.x + sin(a) * xy.y, -sin(a) * xy.x + cos(a) * xy.y);
        vec3 r = ornPetal(pp, L * 0.32, W * 0.2, 0.0, 0.0, 0.3, 0.0);
        acc.x = min(acc.x, r.x);
        if (r.x < 0.0 && 0.5 + r.y * 0.6 > acc.y) acc.yz = vec2(0.5 + r.y * 0.6, r.z);
      }
    } else {
      // Side view: a cup of sepals, and a fan of petals opening from it, the front one highest.
      vec2 pv = xy - vec2(L * 0.22, 0.0);
      for (int j = -2; j <= 2; j++) {
        float fj = float(j);
        float a = fj * 0.42;
        vec2 pp = vec2(cos(a) * pv.x + sin(a) * pv.y, -sin(a) * pv.x + cos(a) * pv.y);
        float front = 1.0 - abs(fj) * 0.3;
        vec3 r = ornPetal(pp, L * 0.78 * (0.85 + 0.15 * front), W * 0.42, 0.4, 0.12, 0.8, tw * fj);
        acc.x = min(acc.x, r.x);
        float hp = 0.2 + 0.25 * front + r.y * 0.8;
        if (r.x < 0.0 && hp > acc.y) acc.yz = vec2(hp, r.z);
      }
      for (int j = -1; j <= 1; j += 2) {
        float a = float(j) * 0.75;
        vec2 pp = vec2(cos(a) * xy.x + sin(a) * xy.y, -sin(a) * xy.x + cos(a) * xy.y);
        vec3 r = ornPetal(pp, L * 0.42, W * 0.22, 0.0, 0.0, 0.3, 0.0);
        acc.x = min(acc.x, r.x);
        if (r.x < 0.0 && 0.75 + r.y * 0.5 > acc.y) acc.yz = vec2(0.75 + r.y * 0.5, r.z);
      }
      vec3 cup = ornPetal(xy, L * 0.36, W * 0.36, 0.9, 0.0, 0.2, 0.0);
      acc.x = min(acc.x, cup.x);
      if (cup.x < 0.0 && 0.85 + cup.y * 0.5 > acc.y) acc.yz = vec2(0.85 + cup.y * 0.5, cup.z);
    }
    float hs = W * 0.55 * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(u, progress * 1.05);
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, acc.z);
  }
#endif
#ifdef ORN_T${RIBBON}
  if (type == ${RIBBON}) {
    // A strand of interlace: rounded (knotwork) or flat (strapwork, t1.w < 0, square ends), with two incised lines.
    // t2: the nearest crossing; under it (t2.w > 0) the strand dips and stops short, over it (t2.w < 0) it swells.
    // The segment is a circular arc from t0 to t1 bulging t3.w to the side (n × chord), or straight (straps, where
    // t3.w is the angle of the strap crossing over it).
    vec3 ba = t1.xyz - t0.xyz;
    float l = max(length(ba) * 0.5, 1e-7);
    vec3 ex = ba / (2.0 * l);
    vec3 ey = normalize(cross(n, ex));
    vec3 pm = q - (t0.xyz + t1.xyz) * 0.5;
    vec2 p2 = vec2(dot(pm, ex), dot(pm, ey));
    float sag = t3.w;
    float w = abs(t1.w);
    bool strap = t1.w < 0.0;
    float tt = clamp(p2.x / (2.0 * l) + 0.5, 0.0, 1.0);
    float dist;
    // Across the strand only, as if it ran on past the ends: neighbouring segments share their tangent at a joint,
    // so the profile and the incised lines run through it seamlessly.
    float across = abs(p2.y);
    if (strap || abs(sag) < 1e-4 * l) dist = strap ? abs(p2.y) : length(vec2(p2.x - clamp(p2.x, -l, l), p2.y));
    else {
      vec2 C = vec2(0.0, (sag * sag - l * l) / (2.0 * sag));
      float rho = abs(sag - C.y);
      vec2 u = vec2(-l, 0.0) - C;
      vec2 v = vec2(l, 0.0) - C;
      vec2 wv = p2 - C;
      float cuv = u.x * v.y - u.y * v.x;
      across = abs(length(wv) - rho);
      if ((u.x * wv.y - u.y * wv.x) * cuv >= 0.0 && (wv.x * v.y - wv.y * v.x) * cuv >= 0.0) dist = across;
      else dist = min(length(p2 - vec2(-l, 0.0)), length(p2 - vec2(l, 0.0)));
    }
    float d = strap ? max(dist - w, abs(p2.x) - l) : dist - w;
    float x = clamp((strap ? dist : across) / w, 0.0, 1.0);
    float rc = t2.w;
    // Knot strands pack the crossing strand's angle in the fraction of the radius.
    float kang = 0.0;
    bool hasAng = !strap && abs(rc) >= 1.0;
    if (hasAng) {
      kang = (fract(abs(rc)) - 0.001) / 0.998 * 2.0 * ORN_PI - ORN_PI;
      rc = sign(rc) * floor(abs(rc)) * 1e-5;
    }
    float lift = 1.0;
    float dcut = -1e3;
    if (rc != 0.0) {
      float dc = length(q - t2.xyz);
      if (rc > 0.0) {
        // An under strand is cut by a band along the one over it (at angle t3.w for straps, kang for knots), so it
        // stops short with a straight edge; near the crossing only.
        if (strap || hasAng) {
          float a = strap ? sag : kang;
          vec2 o = vec2(cos(a), sin(a));
          vec3 cq = q - t2.xyz;
          dcut = rc - abs(dot(cq, ex) * o.y - dot(cq, ey) * o.x);
          if (!strap) dcut = min(dcut, rc * 2.6 - dc);
        } else dcut = rc - dc;
        d = max(d, dcut);
        lift = 1.0 - 0.5 * exp(-pow(dc / (rc * 1.7), 2.0));
      } else lift = 1.0 + 0.12 * exp(-pow(dc / (rc * 2.0), 2.0));
    }
    float lod = smoothstep(1.5, 3.5, 0.1 * w / lw);
    float line = exp(-pow((x - 0.58) / 0.11, 2.0)) * lod;
    float h = strap ? 0.55 + 0.45 * ornShoulder(max(dist - w, dcut), 0.35 * w) : 0.4 + 0.6 * sqrt(max(0.0, 1.0 - x * x * x));
    h -= 0.22 * line;
    if (strap) h += 0.06 * (1.0 - x * x);
    float hs = w * 0.8 * raise;
    ornAccum(res, d, hs * h * lift, hs, step(mix(t3.x, t3.y, tt), ornDraw), clamp(line + 0.6 * (1.0 - lift), 0.0, 1.0));
  }
#endif
#ifdef ORN_T${SCALE}
  if (type == ${SCALE}) {
    // An imbricated scale from its base at t0 toward t1.xyz: rising to a domed, rimmed free edge that overlaps the
    // bases of the next rows. Kinds: round (fish, striated), pointed (dragon, keeled), short and keeled (snake).
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float y = dot(dv, sd);
    float L = t1.w;
    float W = t2.x;
    int kindCode = int(t2.y + 0.5);
    int kind = kindCode & 3;
    float hs = W * 0.55 * raise;
    float cx = L - W;
    float d;
    float tipL = L;
    if (kind == 1) {
      float Rk = W * 1.7;
      float o = Rk - W;
      tipL = cx + sqrt(Rk * Rk - o * o);
      d = x > cx ? max(length(vec2(x - cx, y + o)), length(vec2(x - cx, y - o))) - Rk : abs(y) - W;
    } else d = x > cx || kind == 3 ? length(vec2(x - cx, y)) - W : abs(y) - W;
    d = max(d, -x);
    // Cut back a gap from the rims of the scales over it (offsets of their tip circles, packed 12 bits each), so the
    // ground shows in crescents between them.
    int codes[3] = int[3](kindCode >> 2, int(t2.w + 0.5) & 4095, int(t2.w + 0.5) >> 12);
    float dc = 1e3;
    for (int k = 0; k < 3; k++) {
      int c = codes[k];
      if (c == 4095) continue;
      vec2 o = vec2(cx + (float(c >> 6) / 63.0 * 4.0 - 3.5) * W, (float(c & 63) / 63.0 * 4.0 - 2.0) * W);
      dc = min(dc, length(vec2(x, y) - o));
    }
    d = max(d, W * (kind == 3 ? 1.08 : 1.22) - dc);
    float u = clamp(x / tipL, 0.0, 1.0);
    float ny = clamp(y / W, -1.0, 1.0);
    float dome = sqrt(max(0.0, 1.0 - ny * ny));
    float rise = 0.12 + 0.88 * pow(u, 1.3);
    float h = rise * (0.5 + 0.5 * dome) * (0.55 + 0.45 * ornShoulder(d, W * 0.45));
    float rimW = 0.17 * W;
    float lod = smoothstep(1.0, 2.5, rimW * 0.35 / lw);
    float bead = exp(-pow((-d - rimW * 0.55) / (rimW * 0.4), 2.0));
    float groove = exp(-pow((-d - rimW * 1.45) / (rimW * 0.35), 2.0)) * lod;
    h += 0.1 * bead * u - 0.12 * groove * u;
    float cav = groove;
    if (kind == 3) {
      // Seigaiha: flat, with rounded rings round the centre of the free edge and a boss in the middle.
      float rr = min(length(vec2(x - cx, y)) / W, 1.0) * 4.2;
      float f = fract(rr);
      float ridge = rr < 1.0 ? sqrt(1.0 - rr * rr) * 0.6 + 0.4 : sqrt(max(0.0, 1.0 - pow((f - 0.5) / 0.48, 2.0)));
      float rl = smoothstep(1.0, 2.5, W * 0.24 / 4.2 / lw);
      h = (0.55 + 0.45 * mix(0.6, ridge, rl)) * (0.55 + 0.45 * ornShoulder(d, W * 0.12));
      cav = (1.0 - ridge) * rl;
      float reveal = progress >= 1.0 ? 1.0 : step(u, progress);
      ornAccum(res, d, h * hs, hs, reveal, cav);
      return;
    }
    if (kind == 0) {
      // Fine ridges fanning from the base.
      float a = atan(y, x + L * 0.35);
      float st = pow(abs(sin(a * 16.0 + t2.z * 6.0)), 3.0) * smoothstep(0.25, 0.7, u) * smoothstep(-rimW * 1.2, -rimW * 2.4, d) * lod;
      h -= 0.05 * st;
      cav = max(cav, 0.5 * st);
    } else {
      float keel = exp(-pow(y / (0.12 * W), 2.0)) * smoothstep(0.1, 0.75, u);
      h += (kind == 1 ? 0.16 : 0.1) * keel;
    }
    h *= 0.5 + 0.5 * ornShoulder(d, rimW * 0.7);
    float reveal = progress >= 1.0 ? 1.0 : step(u, progress);
    // The strip of each scale that shows under the rim of the one above is in its shadow, and holds the patina.
    ornAccum(res, d, h * hs, hs, reveal, clamp(cav + 1.0 - smoothstep(0.5, 0.8, u), 0.0, 1.0));
  }
#endif
#ifdef ORN_T${PALMETTE}
  if (type == ${PALMETTE}) {
    // A split palmette: two acanthus half-leaves curling apart from a stem, a pointed bud rising between them, on a
    // collar. Mirror-symmetric about its axis, so one blade is evaluated on |y|.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float y = dot(dv, sd);
    float L = t1.w;
    float W = t2.x;
    float seed = t2.z;
    float spread = t2.w;
    float hs = L * 0.2 * raise;
    vec3 acc = vec3(1e3, 0.0, 0.0);
    // The bud.
    vec3 bud = ornPetal(vec2(x - L * 0.1, y), L * 0.82, W * 0.3, 0.1, 0.0, 0.5, 0.0);
    acc.x = bud.x;
    if (bud.x < 0.0) acc.yz = vec2(0.75 + 0.55 * bud.y, bud.z);
    // A blade leaving the axis outward, bending out and rolling over at the tip.
    float phi = 0.25 + 0.45 * spread;
    vec2 pl = vec2(x - L * 0.12, abs(y) - W * 0.08);
    float lu = pl.x * cos(phi) + pl.y * sin(phi);
    float lv = -pl.x * sin(phi) + pl.y * cos(phi);
    float Lb = L * 0.82;
    float R = Lb / (1.2 + 1.6 * spread);
    float bu = atan(lu, R - lv) * R;
    float bv = R - length(vec2(lu, lv - R));
    vec3 bl = ornAcanthus(bu / Lb, bv / Lb, W / L * 0.62, t2.y, seed + (y > 0.0 ? 0.0 : 0.37) * 0.0, 0.7, 0.25);
    float dbl = bl.x * Lb;
    acc.x = min(acc.x, dbl);
    float pillow = ornShoulder(dbl, 0.08 * W);
    float hb = bl.y * (0.35 + 0.65 * pillow) * 1.1;
    if (dbl < 0.0 && hb > acc.y) acc.yz = vec2(hb, clamp(bl.z + 0.4 * (1.0 - pillow), 0.0, 1.0));
    // The collar.
    float dc = length(vec2((x - L * 0.06) / 0.6, y)) - W * 0.2;
    acc.x = min(acc.x, dc);
    if (dc < 0.0) {
      float hc = 0.9 + 0.3 * sqrt(clamp(-dc / (W * 0.2), 0.0, 1.0));
      if (hc > acc.y) acc.yz = vec2(hc, 0.2);
    }
    float reveal = progress >= 1.0 ? 1.0 : step(x / L, progress * 1.05);
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, acc.z);
  }
#endif
#ifdef ORN_T${FRET}
  if (type == ${FRET}) {
    // A straight strap (kind in the type's tenths). Each end is a square cap reaching ext past it, chamfered round
    // the end; a mitre (ext 0: cut along x = k y, overlapping a little, so two straps meet on their bisector with
    // matching profiles); or round (ext < 0). The profile only falls off away from the centreline.
    vec3 ab = t1.xyz - t0.xyz;
    vec3 ax, sd;
    ornTangent(n, ab, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float ys = dot(dv, sd);
    float y = abs(ys);
    float Lp = max(dot(ab, ax), 0.0);
    float w = t1.w;
    bool atA = x < Lp * 0.5;
    float ext = atA ? t2.x : t2.z;
    float ox = (atA ? -x : x - Lp) - (atA ? t2.y : t2.w) * ys;
    int kind = int(fract(t0.w) * 10.0 + 0.5);
    float dc = ext < 0.0 ? length(vec2(max(atA ? -x : x - Lp, 0.0), y)) : ext > 0.0 ? max(y, ox + w - ext) : ox > 0.2 * w ? max(y, 0.8 * w + ox) : y;
    float d = dc - w;
    float s = clamp(-d / w, 0.0, 1.0);
    float h, cav = 0.0;
    if (kind == ${FLAT}) {
      // Flat top, a crisp chamfer.
      h = 0.3 + 0.7 * smoothstep(0.0, 1.0, clamp(s / 0.32, 0.0, 1.0));
      cav = 0.3 * (1.0 - clamp(s / 0.32, 0.0, 1.0));
    } else if (kind == ${RIBBED}) {
      // Chamfered flat with a half-round rib down the middle.
      float c = 1.0 - s;
      h = 0.3 + 0.4 * clamp(s / 0.3, 0.0, 1.0) + (c < 0.3 ? 0.3 * sqrt(1.0 - c * c / 0.09) : 0.0);
      cav = exp(-pow((c - 0.33) / 0.06, 2.0)) * 0.8;
    } else {
      h = sqrt(max(0.0, 1.0 - (1.0 - s) * (1.0 - s)));
    }
    float hs = w * (kind == ${FLAT} ? 0.8 : 0.9) * t3.w * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(x, progress * Lp);
    ornAccum(res, d, hs * h, hs, reveal, cav);
  }
#endif
#ifdef ORN_T${ROUNDEL}
  if (type == ${ROUNDEL}) {
    // A turned medallion: an outer ring (plain or pearled) around a faceted star, a gadrooned boss or stepped
    // polygon terraces, folded into one sector of its N-fold symmetry.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float r = length(xy);
    float R = t1.w;
    float N = t2.x;
    int kind = int(t2.y + 0.5);
    float hs = R * 0.2 * t3.w * raise;
    float ang = atan(xy.y, xy.x);
    float reveal = progress >= 1.0 ? 1.0 : step(fract(ang / (2.0 * ORN_PI) + 1.0 + t2.z), progress);
    if (r > R * 1.25) {
      ornAccum(res, r - R, 0.0, hs, reveal, 0.0);
      return;
    }
    float sec = 2.0 * ORN_PI / N;
    float af = mod(ang + sec * 0.5, sec) - sec * 0.5;
    vec2 pf = r * vec2(cos(af), abs(sin(af)));
    vec3 acc = vec3(1e3, 0.0, 0.0);
    // Outer ring: a bead moulding, or a row of pearls.
    float rr = r / R - 0.93;
    if (t2.w > 0.5) {
      float M = floor(2.0 * ORN_PI * 0.93 / 0.15);
      float pa = (floor(ang / (2.0 * ORN_PI) * M + 0.5)) / M * 2.0 * ORN_PI;
      float x = length(xy - 0.93 * R * vec2(cos(pa), sin(pa))) / (0.066 * R);
      acc = vec3((x - 1.0) * 0.066 * R, 0.62 * sqrt(max(0.0, 1.0 - x * x)), 0.0);
    } else {
      float dr = abs(rr) - 0.065;
      acc = vec3(dr * R, 0.6 * sqrt(max(0.0, 1.0 - rr * rr / (0.065 * 0.065))), 0.0);
    }
    float di, hi, ci = 0.0;
    if (kind == 0) {
      // A faceted star: a plane per edge, ridged along the points and creased along the valleys.
      vec2 P = vec2(0.76 * R, 0.0);
      vec2 V = 0.4 * R * vec2(cos(sec * 0.5), sin(sec * 0.5));
      vec2 e = normalize(V - P);
      vec2 nrm = vec2(e.y, -e.x);
      nrm *= sign(dot(nrm, P));
      di = dot(pf - P, nrm);
      float apex = dot(P, nrm);
      hi = 0.35 + 0.75 * clamp(-di / apex, 0.0, 1.0);
      ci = 0.5 * exp(-pow(abs(sin(af)) * r / (0.02 * R), 2.0)) * step(sec * 0.25, abs(af));
      // A small dome on the apex.
      float dd = r / (0.12 * R);
      if (dd < 1.0) hi = max(hi, 1.0 + 0.25 * sqrt(1.0 - dd * dd));
    } else if (kind == 1) {
      // A gadrooned boss inside a plain fillet.
      float dr2 = abs(r / R - 0.71) - 0.05;
      float dB = r / R - 0.58;
      float x = clamp(r / (0.58 * R), 0.0, 1.0);
      float fl = 0.5 + 0.5 * cos(af / sec * 2.0 * ORN_PI);
      float dome = sqrt(max(0.0, 1.0 - x * x));
      float hb = 0.3 + 0.75 * dome * (0.82 + 0.18 * sqrt(fl)) * (1.0 - 0.1 * x);
      di = min(dr2, dB) * R;
      hi = dB < 0.0 ? hb : 0.45 * sqrt(max(0.0, 1.0 - pow((r / R - 0.71) / 0.05, 2.0)));
      ci = dB < 0.0 ? (1.0 - sqrt(fl)) * x * 0.8 : 0.0;
      float dd = r / (0.1 * R);
      if (dd < 1.0) hi = max(hi, 1.05 + 0.2 * sqrt(1.0 - dd * dd));
    } else {
      // Stepped polygon terraces, a ziggurat seen from above.
      float ap = pf.x;
      float a1 = 0.74, a2 = 0.54, a3 = 0.34;
      di = (ap / R - a1) * R;
      float lv = ap / R;
      float st = lv > a2 ? 0.0 : lv > a3 ? 1.0 : 2.0;
      float edge = lv > a2 ? a1 - lv : lv > a3 ? a2 - lv : a3 - lv;
      hi = 0.4 + 0.3 * st + 0.2 * clamp(edge / 0.04, 0.0, 1.0);
      ci = 0.6 * (1.0 - clamp(edge / 0.04, 0.0, 1.0));
      float dd = r / (0.13 * R);
      if (dd < 1.0) hi = max(hi, 1.1 + 0.2 * sqrt(1.0 - dd * dd));
    }
    acc.x = min(acc.x, di);
    if (di < 0.0 && hi > acc.y) acc.yz = vec2(hi, ci);
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, acc.z);
  }
#endif
#ifdef ORN_T${TUBE}
  if (type == ${TUBE}) {
    // A vessel (smooth, swelling), a corrugated hose, or a bone with a ridge, as a tapered capsule.
    vec3 pa = q - t0.xyz;
    vec3 ba = t1.xyz - t0.xyz;
    float L = length(ba);
    float tt = clamp(dot(pa, ba) / max(L * L, 1e-10), 0.0, 1.0);
    float rr = mix(t1.w, t2.x, tt);
    float dist = length(pa - ba * tt);
    int kind = int(t2.w + 0.5);
    float s = t2.z + tt * L;
    float x = clamp(dist / rr, 0.0, 1.0);
    float h, cav = 0.0;
    if (kind == ${HOSE}) {
      float ph = fract(s * t2.y);
      float groove = exp(-pow((ph - 0.5) * 5.0, 2.0));
      rr *= 1.0 - 0.14 * groove;
      x = clamp(dist / rr, 0.0, 1.0);
      h = sqrt(1.0 - x * x) * (1.0 - 0.3 * groove) * (0.85 + 0.15 * cos(ph * 2.0 * ORN_PI - ORN_PI));
      cav = groove * smoothstep(1.5, 4.0, rr / lw);
    } else if (kind == ${VEIN}) {
      // Slightly flattened on top, with a faint pulse of swellings along it.
      float sw = 1.0 + 0.08 * sin(s * t2.y);
      rr *= sw;
      x = clamp(dist / rr, 0.0, 1.0);
      h = pow(1.0 - x * x, 0.35);
      cav = 0.25 * x * x;
    } else {
      h = sqrt(1.0 - x * x) * 0.8 + 0.25 * exp(-x * x / 0.04);
      cav = 0.3 * exp(-pow((x - 0.35) / 0.12, 2.0)) * smoothstep(2.0, 5.0, rr / lw);
    }
    float d = dist - rr;
    float hs = rr * 0.95 * t3.w * raise;
    ornAccum(res, d, hs * h, hs, step(mix(t3.x, t3.y, tt), ornDraw), cav);
  }
#endif
#ifdef ORN_T${NODULE}
  if (type == ${NODULE}) {
    // A lumpy knot, a smooth bulb, or a cyst with a pore in its crown.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float r = length(xy);
    float R = t1.w;
    float hs = R * 0.75 * raise;
    if (r > R * 1.25) {
      ornAccum(res, r - R * 1.08, 0.0, hs, step(t3.x, ornDraw), 0.0);
      return;
    }
    float th = atan(xy.y, xy.x);
    float lumps = t2.x;
    float seed = t2.z;
    float wob = lumps > 0.0 ? 0.06 * sin(lumps * th + seed * 6.28) + 0.03 * sin((lumps + 1.0) * th - seed * 11.0) : 0.0;
    float Re = R * (1.0 + wob);
    float d = r - Re;
    float x = clamp(r / Re, 0.0, 1.0);
    float h = sqrt(1.0 - x * x);
    float cav = 0.0;
    // Swollen off-centre, as if something pushed up from beneath.
    vec2 sk = xy / R - 0.25 * vec2(cos(seed * 6.28), sin(seed * 6.28));
    h = sqrt(max(0.0, 1.0 - x * x)) * (0.8 + 0.2 * max(0.0, 1.0 - dot(sk, sk)));
    float pore = t2.y;
    if (pore > 0.0) {
      // A raised lip around a pore that opens to the ground.
      float rp = pore * R * (1.0 + 0.07 * sin(3.0 * th + seed * 9.0));
      float lip = exp(-pow((r - rp * 1.35) / (rp * 0.45), 2.0));
      h = h * (0.75 + 0.25 * smoothstep(rp, rp * 2.5, r)) + 0.3 * lip;
      d = max(d, rp - r);
      cav = max(cav, smoothstep(rp * 1.6, rp, r));
    }
    float a = fract(th / (2.0 * ORN_PI) + 0.5 + seed);
    float reveal = progress >= 1.0 ? 1.0 : step(a, progress);
    ornAccum(res, d, h * (0.6 + 0.4 * ornShoulder(d, 0.2 * R)) * hs, hs, reveal, cav);
  }
#endif
#ifdef ORN_T${POD}
  if (type == ${POD}) {
    // A seed pod: a pointed husk with its seeds swelling through, in a row down the middle.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float u = dot(dv, ax);
    float v = dot(dv, sd);
    float Lh = t1.w * 0.6;
    float W = t2.x;
    float N = t2.y;
    float U = clamp(u / Lh, -1.0, 1.0);
    float hw = W * pow(max(1.0 - U * U, 0.0), 0.62) + 1e-5;
    float d = max((abs(v) - hw) * 0.8, abs(u) - Lh);
    float V = clamp(v / hw, -1.0, 1.0);
    float k = (U * 0.5 + 0.5) * N;
    float f = fract(k) - 0.5;
    float sv = V / 0.62;
    float sb = max(0.0, 1.0 - f * f * 4.0 - sv * sv);
    float seedH = sqrt(sb) * (1.0 - U * U * 0.5);
    float husk = sqrt(max(0.0, 1.0 - V * V)) * 0.55;
    // The husk's rim is rolled and its two halves part along the seam.
    float rim = exp(-pow((abs(V) - 0.82) / 0.1, 2.0)) * 0.12;
    float h = max(husk + rim, 0.25 + 0.6 * seedH);
    float cav = clamp((1.0 - smoothstep(0.0, 0.25, seedH)) * smoothstep(0.85, 0.5, abs(V)) + 0.4 * (1.0 - smoothstep(0.0, 0.2, sb)), 0.0, 1.0);
    float hs = W * 0.9 * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(U * 0.5 + 0.5, progress);
    ornAccum(res, d, h * (0.55 + 0.45 * ornShoulder(d, 0.3 * W)) * hs, hs, reveal, cav * smoothstep(2.0, 5.0, W / lw));
  }
#endif
#ifdef ORN_T${SPHINCTER}
  if (type == ${SPHINCTER}) {
    // A ring of puckered folds drawn into an open orifice, inside a rolled rim.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float r = length(xy);
    float R = t1.w;
    float hs = R * 0.42 * raise;
    if (r > R * 1.25) {
      ornAccum(res, r - R * 1.04, 0.0, hs, step(t3.x, ornDraw), 0.0);
      return;
    }
    float th = atan(xy.y, xy.x);
    float F = t2.x;
    float rh0 = t2.y * R;
    float seed = t2.z;
    float tw = t2.w;
    float ph = F * th + tw * 2.2 * log(max(r, rh0 * 0.5) / rh0) + seed * 6.28;
    float fold = 0.5 + 0.5 * cos(ph);
    float ridge = pow(fold, 1.6);
    float rh = rh0 * (1.0 + 0.4 * fold);
    float rimC = R * 0.86;
    float rimW = R * 0.14;
    float d = max(r - R * (1.0 + 0.03 * sin(F * 0.5 * th + seed * 3.0)), rh - r);
    float sr = clamp((r - rh) / max(rimC - rimW * 0.5 - rh, 1e-5), 0.0, 1.0);
    // The folds dive into the hole, sharp-crested, rising to the rim.
    float folds = (0.12 + 0.88 * pow(sr, 0.65)) * (0.3 + 0.7 * ridge) * (0.55 + 0.45 * ornShoulder(rh - r, (rimC - rh) * 0.15));
    float rimH = 0.75 + 0.35 * sqrt(max(0.0, 1.0 - pow((r - rimC) / rimW, 2.0)));
    float h = max(folds, r > rimC - rimW ? rimH : 0.0);
    float groove = exp(-pow((r - (rimC - rimW)) / (rimW * 0.3), 2.0));
    h -= 0.12 * groove;
    float cav = clamp((1.0 - ridge) * (0.35 + 0.65 * (1.0 - sr)) + groove * 0.6, 0.0, 1.0);
    h *= 0.6 + 0.4 * ornShoulder(r - R, 0.15 * R);
    float a = fract(th / (2.0 * ORN_PI) + 0.5 + seed);
    float reveal = progress >= 1.0 ? 1.0 : step(a, progress);
    ornAccum(res, d, h * hs, hs, reveal, cav);
  }
#endif
#ifdef ORN_T${VERTEBRA}
  if (type == ${VERTEBRA}) {
    // A vertebra pointing along +u: its body, a spinous crest running back, transverse processes swept back
    // and ending in knobs, and facets at the front.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 p2 = vec2(dot(dv, ax), abs(dot(dv, sd)));
    float L = t1.w;
    float W = t2.x;
    float sweep = t2.w;
    float hs = L * 0.55 * raise;
    if (length(p2) > length(vec2(L, W)) * 1.1) {
      ornAccum(res, length(p2) - length(vec2(L, W)) * 0.95, 0.0, hs, step(t3.x, ornDraw), 0.0);
      return;
    }
    float bw = min(W * 0.42, L * 0.85);
    vec3 acc = vec3(1e3, 0.0, 0.0);
    // Body: a waisted, rounded block.
    float BL = L * 0.8;
    vec2 bq = vec2(p2.x / BL, p2.y / (bw * (1.0 - 0.15 * exp(-p2.x * p2.x / (BL * BL * 0.15)))));
    float bl = length(pow(abs(bq), vec2(3.0)));
    float bd = (pow(bl, 1.0 / 3.0) - 1.0) * min(BL, bw);
    float bh = 0.55 + 0.3 * sqrt(max(0.0, 1.0 - min(bl, 1.0)));
    ornUnion(acc, bd, bh * (0.6 + 0.4 * ornShoulder(bd, bw * 0.35)), 0.0);
    // Transverse process.
    vec2 pa = vec2(L * 0.1, bw * 0.8);
    vec2 pb = vec2(-L * (0.35 + 0.4 * sweep), W * 0.9);
    vec3 cp = ornCapsule(p2, pa, pb, L * 0.34, L * 0.2);
    float ch = (0.38 + 0.3 * sqrt(max(0.0, 1.0 - cp.y * cp.y))) * (1.0 - 0.2 * cp.z);
    ornUnion(acc, cp.x, ch, 0.25 * smoothstep(0.5, 1.0, cp.y));
    float kd = length(p2 - pb) - L * 0.26;
    ornUnion(acc, kd, 0.5 + 0.25 * sqrt(max(0.0, -kd / (L * 0.26))), 0.0);
    // Spinous crest, highest over the body and running back past it.
    vec3 sp = ornCapsule(p2, vec2(L * 0.6, 0.0), vec2(-L * 1.0, 0.0), bw * 0.26, bw * 0.12);
    float sh = 0.9 + 0.2 * (1.0 - sp.z) - 0.25 * sp.y * sp.y;
    ornUnion(acc, sp.x, sh, 0.0);
    // Facets at the front corners.
    float fd = length(p2 - vec2(L * 0.72, bw * 0.6)) - bw * 0.3;
    ornUnion(acc, fd, 0.7 + 0.2 * sqrt(max(0.0, -fd / (bw * 0.3))), 0.0);
    // A crease where the parts meet.
    float cav = acc.z + 0.6 * exp(-pow(bd / (bw * 0.08), 2.0)) * step(0.0, -cp.x);
    float reveal = progress >= 1.0 ? 1.0 : step(0.5 - 0.5 * p2.x / L, progress * 1.1);
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, clamp(cav, 0.0, 1.0));
  }
#endif
#ifdef ORN_T${FRIEZE}
  if (type == ${FRIEZE}) {
    // One unit of a classical border along t1.xyz, P long and 2B high (in units of B from here on, y up across the
    // band): a fillet along each edge and between them an egg and dart, a bead and reels, a running wave or a
    // guilloche eye. Elements on the seams are whole in both neighbours, so nothing is cut there.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float B = t1.w;
    float Ph = t2.x * 0.5 / B;
    vec2 p = vec2(dot(dv, ax), dot(dv, sd) * t2.w) / B;
    int kind = int(t2.y + 0.5);
    float hs = B * 0.3 * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(p.x / (2.0 * Ph) + 0.5, progress);
    if (abs(p.x) > Ph + 0.45 || abs(p.y) > 1.1) {
      ornAccum(res, (max(abs(p.x) - Ph - 0.35, abs(p.y) - 1.0)) * B, 0.0, hs, reveal, 0.0);
      return;
    }
    vec3 acc = vec3(1e3, 0.0, 0.0);
    float ax2 = abs(p.x);
    if (kind != ${REEL}) {
      // Half-round fillets, running a little past the ends.
      float fy = abs(abs(p.y) - 0.88);
      ornUnion(acc, max(fy - 0.09, ax2 - Ph - 0.3) * B, 0.5 * sqrt(max(0.0, 1.0 - fy * fy / 0.0081)), 0.0);
    }
    if (kind == ${EGG}) {
      // An egg hanging in an open shell, darts on the seams.
      vec2 e = vec2(p.x, p.y + 0.05);
      vec2 er = vec2(0.47 * (1.0 + 0.12 * e.y), 0.56);
      float le = length(e / er);
      float de = (le - 1.0) * min(er.x, er.y);
      ornUnion(acc, de * B, 0.45 + 0.7 * sqrt(max(0.0, 1.0 - le * le)), 0.15 * le * le);
      vec2 sr = er + vec2(0.2, 0.18);
      float ls = length(e / sr);
      float ds = max(max((ls - 1.0) * min(sr.x, sr.y), 0.06 - de), p.y - 0.8);
      float ts = clamp(-ds / 0.07, 0.0, 1.0);
      ornUnion(acc, ds * B, 0.42 + 0.22 * sqrt(ts * (2.0 - ts)), 0.25 * (1.0 - ts));
      float xd = abs(ax2 - Ph);
      float dshaft = max(xd - 0.045, max(p.y - 0.8, -p.y - 0.3));
      float dhead = max((xd - 0.4 * (p.y + 0.78)) * 0.93, p.y + 0.3);
      float dd = min(dshaft, dhead);
      ornUnion(acc, dd * B, 0.5 + 0.12 * (1.0 - clamp(xd / 0.15, 0.0, 1.0)), 0.3 * clamp(xd / 0.15, 0.0, 1.0));
    } else if (kind == ${REEL}) {
      // An oval bead, and a pair of thin reels toward each seam (the far one of each pair is the neighbour's).
      vec2 br = vec2(Ph - 0.48, 0.78);
      float lb = length(p / br);
      ornUnion(acc, (lb - 1.0) * min(br.x, br.y) * B, 0.35 + 0.75 * sqrt(max(0.0, 1.0 - lb * lb)), 0.2 * lb * lb);
      vec2 rr = vec2(0.11, 0.6);
      float lr = length(vec2(ax2 - Ph + 0.17, p.y) / rr);
      ornUnion(acc, (lr - 1.0) * rr.x * B, 0.3 + 0.55 * sqrt(max(0.0, 1.0 - lr * lr)), 0.3 * lr * lr);
    } else if (kind == ${WAVE}) {
      // A wave rising from the trough at the back seam into a crest that curls forward over a spiral.
      vec2 C = vec2(0.25 * Ph - 0.05, 0.06);
      float Rc = 0.56;
      vec2 c = p - C;
      float r = length(c);
      float back = clamp((p.x + Ph - 0.05) / (C.x + Ph - 0.05), 0.0, 1.0);
      float yb = -0.5 + (C.y + Rc + 0.5) * pow(back, 1.7);
      float dBack = max(p.y - yb, p.x - C.x) * 0.6;
      float dBody = min(min(r - Rc, dBack), max(p.y + 0.5, ax2 - Ph - 0.12));
      dBody = max(dBody, -p.y - 0.78);
      // The spiral groove, turning inward clockwise from the crest; ground shows along it.
      float th = atan(-c.y, c.x) / (2.0 * ORN_PI);
      float pitch = 0.17;
      float sp = r / pitch - fract(th + 0.25);
      float gl = abs(fract(sp) - 0.5) * pitch;
      float dg = gl - 0.032;
      if (r < Rc * 0.93 && r > 0.06) dBody = max(dBody, -dg);
      float rim = clamp(gl / (0.5 * pitch), 0.0, 1.0);
      float hb = r < Rc ? 0.5 + 0.38 * sqrt(rim) * smoothstep(0.0, 0.2, r) : 0.5 + 0.12 * clamp(-dBody / 0.2, 0.0, 1.0);
      ornUnion(acc, dBody * B, hb, r < Rc ? 0.4 * (1.0 - rim) : 0.1);
    } else {
      // Two strands crossing on the seams round an eye with a boss; at each seam the strand going down crosses over.
      float A = 0.46;
      float k = ORN_PI / (2.0 * Ph);
      float w = 0.115;
      float s1 = A * cos(k * p.x);
      float g = A * k * sin(k * p.x);
      float inv = inversesqrt(1.0 + g * g);
      float d1 = abs(p.y - s1) * inv;
      float d2 = abs(p.y + s1) * inv;
      float end = ax2 - Ph - 0.07;
      // Over: strand 1 toward +x, strand 2 toward -x.
      bool oneOver = p.x > 0.0;
      float dOver = oneOver ? d1 : d2;
      float dUnder = oneOver ? d2 : d1;
      float nearSeam = smoothstep(Ph - 0.55, Ph, ax2);
      float cut = nearSeam > 0.0 ? -(dOver - w - 0.05) : -1e3;
      float uO = clamp(dOver / w, 0.0, 1.0);
      float uU = clamp(dUnder / w, 0.0, 1.0);
      float line = 0.25 * exp(-pow((uO - 0.55) / 0.12, 2.0));
      ornUnion(acc, max(dOver - w, end) * B, (0.55 + 0.25 * sqrt(1.0 - uO * uO) + 0.08 * nearSeam) - line, line * 2.0);
      float lineU = 0.25 * exp(-pow((uU - 0.55) / 0.12, 2.0));
      ornUnion(acc, max(max(dUnder - w, end), cut) * B, (0.55 + 0.25 * sqrt(1.0 - uU * uU)) * (1.0 - 0.35 * nearSeam) - lineU, lineU * 2.0 + 0.4 * nearSeam);
      float lb = length(p) / 0.24;
      ornUnion(acc, (lb - 1.0) * 0.24 * B, 0.45 + 0.6 * sqrt(max(0.0, 1.0 - lb * lb)), 0.2 * lb * lb);
      float lp = length(vec2(ax2 - Ph, abs(p.y) - 0.6)) / 0.1;
      ornUnion(acc, (lp - 1.0) * 0.1 * B, 0.3 + 0.4 * sqrt(max(0.0, 1.0 - lp * lp)), 0.0);
    }
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, acc.z);
  }
#endif
#ifdef ORN_T${FEATHER}
  if (type == ${FEATHER}) {
    // A segment of a plume, u0..u1 of its length: a rachis down the middle and vanes of fine barbs slanting toward
    // the tip, the outer vane wider. Each end is cut on the bisector with the next segment, overlapping it a little.
    vec3 ab = t1.xyz - t0.xyz;
    vec3 ax, sd;
    ornTangent(n, ab, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float y = dot(dv, sd) * sign(t3.w);
    float Lp = max(dot(ab, ax), 1e-6);
    float W = t1.w;
    // Along the plume, sheared so that both mitres map to the joints: the barbs run on through them.
    float tx = clamp(x / Lp, 0.0, 1.0);
    float u = mix(t2.x, t2.y, (x + y * (t2.z * (1.0 - tx) - t2.w * tx)) / Lp);
    float uc = clamp(u, 0.0, 1.0);
    float ay = abs(y);
    float v = clamp((uc - 0.07) / 0.93, 0.0, 1.0);
    float hw = W * (y > 0.0 ? 1.0 : 0.78) * pow(sin(ORN_PI * pow(v, 0.6)), 0.75);
    // Barbs: their phase runs along the rachis, set back across it; a few split apart at the edge.
    float period = W * 0.11;
    // The plume's length rides in the integer part of t3.w (in thousandths), its layer height in the fraction.
    float Lf = floor(abs(t3.w)) / 1000.0;
    float ph = (u * Lf - ay * (0.6 + 0.6 * ay / W)) / period;
    float bi = floor(ph);
    float bf = ph - bi;
    float split = step(ornHash(vec3(bi, sign(y), t0.x * 31.0)), 0.07);
    float edge = hw * (1.0 - 0.07 * bf - split * 0.45 * smoothstep(0.0, 0.3, bf) * smoothstep(1.0, 0.7, bf));
    float rw = W * (0.1 - 0.05 * uc) * smoothstep(1.0, 0.9, uc);
    float dr = ay - rw;
    float d = min(ay - edge, dr);
    bool atA = x < Lp * 0.5;
    float ox = (atA ? -x : x - Lp) - (atA ? t2.z : t2.w) * y;
    // Past the bisector it only keeps the union's outline away from the joint: the next segment sets the height.
    d = max(d, ox - ((atA ? t2.x : 1.0 - t2.y) > 0.0 ? 0.15 * W : 0.0));
    float lod = smoothstep(1.0, 2.5, period * 0.3 / lw);
    float ridge = sqrt(max(0.0, 1.0 - pow(2.0 * bf - 1.0, 2.0)));
    float s = clamp(ay / max(hw, 1e-6), 0.0, 1.0);
    float h = (0.5 + 0.3 * (1.0 - s * s) + 0.14 * mix(0.6, ridge, lod)) * (0.6 + 0.4 * ornShoulder(ay - edge, 0.2 * W));
    float cav = (1.0 - ridge) * lod * 0.8 + 0.3 * s;
    if (dr < 0.0) {
      h = 0.95 + 0.25 * sqrt(max(0.0, 1.0 - ay * ay / (rw * rw)));
      cav = 0.0;
    }
    float hs = W * 0.42 * (0.5 + fract(abs(t3.w))) * raise * step(ox, 0.0);
    float reveal = progress >= 1.0 ? 1.0 : step(x / Lp, progress);
    ornAccum(res, d, h * hs, hs, reveal, clamp(cav, 0.0, 1.0));
  }
#endif
#ifdef ORN_T${GUILLOCHE}
  if (type == ${GUILLOCHE}) {
    // An engine-turned panel: a convex quad (t2: corners in units of R round t0, 11 bits a coordinate) cut with fine
    // ridges at pitch lam, the motif packed in t3.w. Cut line by line across the panel as it is drawn.
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float R = t1.w;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    vec2 c[4];
    for (int k = 0; k < 4; k++) c[k] = (vec2(mod(t2[k], 2048.0), floor(t2[k] / 2048.0)) / 1023.5 - 1.0) * R;
    float dq = -1e3;
    for (int k = 0; k < 4; k++) {
      vec2 e = normalize(c[(k + 1) & 3] - c[k]);
      dq = max(dq, dot(xy - c[k], vec2(e.y, -e.x)));
    }
    float code = t3.w;
    float kind = mod(code, 8.0);
    float lobes = mod(floor(code / 8.0), 32.0);
    float lam = mod(floor(code / 256.0), 256.0) * 1e-4;
    float amp = mod(floor(code / 65536.0), 64.0) / 63.0;
    float hand = code >= 4194304.0 ? -1.0 : 1.0;
    float r = length(xy);
    float th = atan(xy.y, xy.x);
    // Rays (a multiple of four, so a panel on an axis keeps its symmetry), and the spacing of the ridges here.
    float N = 4.0 * max(1.0, floor(ORN_PI * R * 0.5 / lam));
    float sp = lam;
    float hr;
    // Rayed and grained motifs leave a polished boss where the rays would crowd.
    float rb = r / (lam * 1.8);
    if (kind != ${ROSE}.0 && kind != ${WAVES}.0 && kind != ${HOBNAIL}.0 && rb < 1.6) hr = rb < 1.0 ? 0.8 + 0.4 * sqrt(1.0 - rb * rb) : 0.55;
    else if (kind == ${ROSE}.0) hr = abs(2.0 * fract(r * (1.0 + 0.1 * amp * cos(lobes * th)) / lam) - 1.0);
    else if (kind == ${SUNBURST}.0 || kind > ${HOBNAIL}.5) {
      sp = 2.0 * ORN_PI * r / N;
      hr = abs(2.0 * fract(th / (2.0 * ORN_PI) * N + (kind > ${HOBNAIL}.5 ? hand * r / lam * 0.25 * (0.5 + amp) : 0.0)) - 1.0);
    } else if (kind == ${WAVES}.0) hr = abs(2.0 * fract((xy.y + hand * amp * lam * 3.0 * sin(xy.x / (lam * lobes * 0.5))) / lam) - 1.0);
    else if (kind == ${BARLEYCORN}.0) {
      float u = r / (lam * 1.6);
      vec2 f = 2.0 * fract(vec2(u, th / (2.0 * ORN_PI) * N * 0.5 + 0.5 * floor(u))) - 1.0;
      sp = min(lam * 1.6, 4.0 * ORN_PI * r / N);
      hr = sqrt(max(0.0, (1.0 - f.x * f.x) * (1.0 - f.y * f.y)));
    } else {
      vec2 f = abs(2.0 * fract(vec2(xy.x + xy.y, xy.x - xy.y) / (lam * 2.2)) - 1.0);
      sp = lam * 1.5;
      hr = 1.0 - max(f.x, f.y);
    }
    float lod = smoothstep(1.2, 3.0, sp / lw);
    float h = (0.62 + 0.38 * mix(0.55, hr, lod)) * (0.8 + 0.2 * smoothstep(0.0, 2.0 * lam, -dq));
    float hs = 0.0055 * raise;
    float reveal = progress >= 1.0 ? 1.0 : step(xy.x / R * 0.5 + 0.5, progress);
    ornAccum(res, dq, hs * h, hs, reveal, 0.6 * (1.0 - hr) * lod);
  }
#endif
#ifdef ORN_T${BLADE}
  if (type == ${BLADE}) {
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    float x = dot(dv, ax);
    float y = dot(dv, sd);
    float L = t1.w;
    float W = t2.x;
    float d, h, cav, reveal, hs;
    if (t2.z < 0.5) {
      // A smooth blade bent along an arc, folded on a raised midrib, veined along (narrow) or obliquely (broad).
      float curl = t2.y;
      float u = x;
      float v = y;
      if (abs(curl) > 1e-3) {
        float R = 1.0 / curl;
        float sg = sign(curl);
        u = atan(x, -(y - R) * sg) * abs(R);
        v = R - sg * length(vec2(x, y - R));
      }
      float uc = clamp(u / L, 0.0, 1.0);
      float hw = W * pow(sin(ORN_PI * pow(uc, 0.62)), 0.85) + 1e-5;
      float ny = clamp(v / hw, -1.0, 1.0);
      d = max(abs(v) - hw, max(-u, u - L)) * 0.85;
      float rib = exp(-ny * ny * 150.0);
      float vp = W / L < 0.12 ? abs(ny) * 2.5 + 0.5 : uc * 7.0 - abs(ny) * 1.3;
      float vein = exp(-pow((fract(vp) - 0.5) / 0.08, 2.0)) * smoothstep(0.08, 0.2, abs(ny)) * (1.0 - smoothstep(0.75, 0.95, abs(ny)));
      h = (0.5 + 0.38 * sqrt(1.0 - abs(ny)) + t2.w * ny * 0.16) * (0.75 + 0.25 * sin(ORN_PI * (0.1 + 0.8 * uc))) + 0.1 * rib - 0.07 * vein;
      float pillow = ornShoulder(d, 0.14 * W);
      h *= 0.45 + 0.55 * pillow;
      cav = clamp(0.7 * vein + 0.4 * (1.0 - pillow) + 0.3 * smoothstep(0.03, 0.0, abs(ny)) * (1.0 - rib), 0.0, 1.0);
      hs = W * 0.8 * raise;
      reveal = progress >= 1.0 ? 1.0 : step(u / L, progress) * step(0.0, u);
    } else {
      // A lily pad: round, notched toward the stem, its rim turned up, veins radiating and forking from the centre.
      float r = length(vec2(x, y));
      float th = atan(y, -x);
      float seed = fract(dot(t0.xyz, vec3(17.1, 31.7, 9.3)));
      float rim = L * (1.0 + 0.02 * sin(7.0 * th + seed * 6.28) + 0.012 * sin(17.0 * th + seed * 17.0));
      float rr = r / L;
      d = max(r - rim, r * sin(min(0.17 - abs(th), 1.2)));
      float a = th / (2.0 * ORN_PI) + 0.5;
      float N = 11.0;
      float dv1 = abs(fract(a * N) - 0.5) * 2.0 * ORN_PI * r / N;
      float dv2 = abs(fract(a * N * 2.0 + 0.5) - 0.5) * ORN_PI * r / N;
      float dvn = min(dv1, mix(1e3, dv2, step(0.5, rr)));
      float ridge = exp(-pow(dvn / (L * 0.016), 2.0)) * smoothstep(0.06, 0.18, rr) * (1.0 - smoothstep(0.86, 0.97, rr));
      h = 0.5 + 0.12 * (1.0 - rr * rr) + 0.38 * smoothstep(0.78, 1.0, rr) + 0.12 * ridge + 0.2 * max(0.0, 1.0 - rr / 0.07);
      float pillow = ornShoulder(d, 0.05 * L);
      h *= 0.5 + 0.5 * pillow;
      cav = clamp(0.35 * (1.0 - ridge) * smoothstep(0.2, 0.7, rr) * smoothstep(0.98, 0.8, rr) + 0.4 * (1.0 - pillow), 0.0, 1.0);
      hs = L * 0.2 * raise;
      reveal = progress >= 1.0 ? 1.0 : step(rr, progress * 1.05);
    }
    ornAccum(res, d, h * hs, hs, reveal, cav);
  }
#endif
#ifdef ORN_T${BLOOM}
  if (type == ${BLOOM}) {
    vec3 ax, sd;
    ornTangent(n, t1.xyz, ax, sd);
    vec3 dv = q - t0.xyz;
    vec2 xy = vec2(dot(dv, ax), dot(dv, sd));
    float L = t1.w;
    int kind = int(t2.y + 0.5);
    float seed = t2.z;
    // The petal count rides in the data, so the loop below stays a loop.
    int N = int(t2.w + 0.5);
    float r = length(xy);
    vec3 acc = vec3(1e3, 0.0, 0.0);
    float hs, reveal;
    if (kind == ${POPPY}) {
      hs = L * 0.3 * raise;
      if (r > L * 1.3) {
        ornAccum(res, r - L * 1.08, 0.0, hs, step(t3.x, ornDraw), 0.0);
        return;
      }
      float rr = r / L;
      float th = atan(xy.y, xy.x);
      // Broad petals, alternately under and over, each a crinkled disc off the centre with a dark blotch at its base.
      for (int i = 0; i < N; i++) {
        float fi = float(i);
        float inner = mod(fi, 2.0);
        float a = (fi + 0.08 * (ornHash(vec3(fi, seed, 1.0)) - 0.5)) * 2.0 * ORN_PI / float(N) + seed * 6.28;
        float pr = L * (0.58 - 0.06 * inner);
        vec2 pp = xy - vec2(cos(a), sin(a)) * L * (0.42 - 0.05 * inner);
        float pa = atan(pp.y, pp.x);
        float pd = length(pp) - pr * (1.0 + 0.035 * sin(pa * 9.0 + fi * 2.3) + 0.02 * sin(pa * 23.0 + fi));
        // Cupped, with fine pleats radiating from the base and a soft ripple.
        float pleat = sin(th * 46.0 + fi * 1.3) * smoothstep(0.25, 0.75, rr);
        float ph = 0.3 + 0.28 * inner + 0.3 * ornShoulder(pd, pr * 0.3) + 0.22 * smoothstep(0.35, 1.0, rr) + 0.025 * pleat + 0.03 * sin(rr * 11.0 + fi);
        ph -= 0.1 * exp(-pow(pd / (0.045 * pr), 2.0));
        ornUnion(acc, pd, ph, 0.5 * (1.0 - smoothstep(0.22, 0.42, rr)) + 0.25 * smoothstep(-0.03 * pr, 0.0, pd) + 0.15 * max(pleat, 0.0));
      }
      // The seed capsule with its stigma rays, ringed by stamens.
      float rc = 0.2;
      if (rr < rc) {
        float x = rr / rc;
        float ray = exp(-pow((fract(th / (2.0 * ORN_PI) * 9.0 + seed) - 0.5) * 7.0, 2.0));
        acc.yz = vec2(1.0 + 0.3 * sqrt(1.0 - x * x) + 0.15 * ray * x, 0.5 * (1.0 - ray) * x);
      } else if (rr < rc * 1.7) {
        float g = max(0.0, sin(th * 34.0) * sin((rr / rc - 1.0) / 0.7 * ORN_PI * 2.0));
        float hc = 0.75 + 0.2 * g;
        if (hc > acc.y) acc.yz = vec2(hc, 0.6 * (1.0 - g));
      }
      acc.x = min(acc.x, r - L * rc * 1.05);
      reveal = progress >= 1.0 ? 1.0 : step(fract(th / (2.0 * ORN_PI) + 0.5 + seed), progress);
    } else {
      // Side views from the stem along +x: an iris (three standards up, falls hanging either side, bearded) or a
      // bud in its sepals. Each petal: origin, angle, length, width, bend, base height.
      bool iris = kind == ${IRIS};
      hs = L * (iris ? 0.16 : 0.2) * raise;
      if (length(xy - vec2(L * 0.4, 0.0)) > L * 0.95) {
        ornAccum(res, length(xy - vec2(L * 0.4, 0.0)) - L * 0.75, 0.0, hs, step(t3.x, ornDraw), 0.0);
        return;
      }
      for (int i = 0; i < N; i++) {
        float s = mod(float(i), 2.0) < 0.5 ? 1.0 : -1.0;
        vec2 o = vec2(0.3, 0.0);
        float ang = 0.0, len = 0.62, w = 0.2, bend = 0.0, base = 0.55, beard = 0.0, e = 0.8;
        if (iris) {
          if (i == 0) { len = 0.68; w = 0.13; base = 0.6; }
          else if (i < 3) { ang = 0.78 * s; len = 0.5; w = 0.13; bend = -0.5 * s; base = 0.3; }
          else { ang = 2.15 * s; len = 0.66; w = 0.21; bend = 0.75 * s; base = 0.7; beard = 1.0; e = 1.5; o.y = 0.04 * s; }
        } else if (i == 0) { o.x = 0.05; len = 0.95; w = t2.x / L; base = 0.35; }
        else { o.x = 0.0; ang = 0.42 * s; len = 0.55; w = 0.1; bend = 0.25 * s; base = 0.6; }
        vec2 pv = xy / L - o;
        vec2 pp = vec2(cos(ang) * pv.x + sin(ang) * pv.y, -sin(ang) * pv.x + cos(ang) * pv.y);
        pp.y -= bend * pp.x * pp.x / len;
        float uc = clamp(pp.x / len, 0.0, 1.0);
        float hw = w * pow(max(sin(ORN_PI * pow(uc, e)), 0.0), 0.55) * (iris ? 1.0 + 0.08 * sin(uc * 26.0 + float(i)) * uc : 1.0) + 1e-4;
        float pd = max(abs(pp.y) - hw, max(-pp.x, pp.x - len)) * L * 0.85;
        float ny = clamp(pp.y / hw, -1.0, 1.0);
        float groove = exp(-pow((fract(ny * (iris ? 3.5 : 2.2) + 0.5 + (iris ? 0.0 : uc * 1.5)) - 0.5) * 6.0, 2.0)) * smoothstep(0.1, 0.5, uc) * (iris ? beard * 0.7 + 0.25 : 1.0);
        float bd = beard * exp(-ny * ny * 25.0) * (1.0 - smoothstep(0.3, 0.6, uc));
        float ph = base + 0.38 * sqrt(1.0 - ny * ny) * (0.7 + 0.3 * sin(ORN_PI * uc)) - 0.08 * groove + 0.2 * bd * (0.7 + 0.3 * sin(pp.x * 150.0 + ny * 9.0));
        ph *= 0.6 + 0.4 * ornShoulder(pd, w * L * 0.25);
        // A chased line just inside the outline keeps overlapping petals apart.
        ph -= 0.1 * exp(-pow(pd / (0.05 * w * L), 2.0));
        ornUnion(acc, pd, ph, clamp(0.6 * groove + 0.5 * bd, 0.0, 1.0));
      }
      // The ovary, a swelling where the stem meets the flower.
      if (iris) {
        vec3 ov = ornCapsule(xy, vec2(0.0), vec2(L * 0.3, 0.0), L * 0.05, L * 0.08);
        ornUnion(acc, ov.x, 0.45 + 0.3 * sqrt(max(0.0, 1.0 - ov.y * ov.y)), 0.2 * ov.y);
      }
      reveal = progress >= 1.0 ? 1.0 : step(length(xy - vec2(L * 0.3, 0.0)) / (L * 0.75), progress);
    }
    ornAccum(res, acc.x, acc.y * hs, hs, reveal, acc.z);
  }
#endif
#ifdef ORN_T${BEAD}
  if (type == ${BEAD}) {
    float dist = length(q - t0.xyz);
    float R = t1.w;
    float x = clamp(dist / R, 0.0, 1.0);
    float hs = R * 0.85 * raise;
    ornAccum(res, dist - R, hs * sqrt(1.0 - x * x), hs, step(t3.x, ornDraw), 0.3 * x * x * x);
  }
#endif
}

// How far the acid has bitten (0..1) at distance d from the resist, with agitation n: the front starts at the walls
// and spreads outward over the bite (the etch stage between the bath filling and draining).
float ornEtchAt(float n, float d) {
  float bite = clamp((ornEtch - 0.04) / 0.8, 0.0, 1.0);
  return smoothstep(0.0, 1.0, clamp(bite * 2.2 - n * 0.5 - 0.7 * smoothstep(0.0, 0.012, d), 0.0, 1.0));
}
// How much of the acid bath is on this point (world height under the liquid line, drips trailing as it drains).
float ornWet = 0.0;
vec3 ornN = vec3(0.0, 1.0, 0.0);

// Punch-matted ground: two staggered layers of round punch marks, close enough to overlap.
float ornMatting(vec3 q) {
  float cs = 0.0036;
  float h = 0.0;
  for (int k = 0; k < 2; k++) {
    vec3 qq = q + float(k) * cs * vec3(0.5, 0.31, 0.17);
    vec3 c = floor(qq / cs);
    vec3 j = ornHash3(c + float(k) * 41.0);
    vec3 o = (c + 0.2 + 0.6 * j) * cs;
    float d = length(qq - o) / (cs * (0.42 + 0.12 * j.x));
    if (d < 1.0) h = min(h, -(1.0 - d * d) * (0.75 + 0.25 * j.y));
  }
  return h;
}

// Gas bubbles nucleating on the biting ground, denser where it bites fastest: grow, then pop.
float ornBubble(vec3 q, float dens, float d) {
  float cs = 0.01;
  vec3 c = floor(q / cs);
  vec3 j = ornHash3(c + 17.0);
  float life = fract(ornTime * (0.3 + 0.6 * j.z) + j.x);
  float r = cs * 0.4 * (0.3 + 0.7 * j.z) * mix(0.35, 1.0, smoothstep(wallWidth, wallWidth * 4.0, d)) * sqrt(smoothstep(0.0, 0.95, life)) * step(life, 0.95) * smoothstep(j.y, j.y + 0.2, dens);
  if (r <= 0.0) return 0.0;
  // Its centre dropped onto the surface, so every cell's bubble sits on the ground.
  vec3 dq = q - (c + 0.25 + 0.5 * j) * cs;
  float x = length(dq - ornN * dot(dq, ornN)) / r;
  return x < 1.0 ? r * sqrt(1.0 - x * x) : 0.0;
}

// Fades for detail finer than a pixel.
float ornGuiLod = 1.0;
float ornMatLod = 1.0;
float ornLw = 0.001;
float ornPitLod = 1.0;

// Engine-turned ground: wavy grooves cut around the axis.
float ornGuiU(vec3 q) {
  float lat = atan(q.y, length(q.xz));
  float lon = atan(q.z, q.x);
  return lat * 360.0 + 2.0 * sin(lon * 28.0 + lat * 9.0) + 0.5 * sin(lon * 84.0);
}
float ornGuilloche(vec3 q) {
  float f = abs(2.0 * fract(ornGuiU(q)) - 1.0);
  return mix(-0.55, -(1.0 - f * f * sqrt(f)), ornGuiLod);
}

// Where enamel powder has been laid (0..1): packed from scattered points outward.
float ornFillFront(vec3 q) {
  if (ornFill >= 1.0) return 1.0;
  float cs = 0.32;
  vec3 c = floor(q / cs);
  float f1 = 1e3;
  for (int i = -1; i <= 1; i++)
    for (int j = -1; j <= 1; j++)
      for (int k = -1; k <= 1; k++) {
        vec3 cc = c + vec3(i, j, k);
        f1 = min(f1, length(q - (cc + ornHash3(cc + 5.0)) * cs));
      }
  float r = ornFill * cs * 2.2 + 0.03 * (ornNoise(q * 40.0) - 0.5);
  return clamp((r - f1) / (cs * 0.35), 0.0, 1.0);
}

// Top of the fill: grainy powder rising, then fused glass, sagging a little in the middle of wide cells.
float ornFillTop(float d, vec3 q, float amt, float melt) {
  float packed = mix(-etchDepth * 1.3, fireLevel + 0.0015, amt) + 0.0005 * ornPitLod * (ornNoise(q * 700.0) - 0.5);
  float glass = fireLevel - fillSag * smoothstep(0.0, 0.012, d);
  return mix(packed, glass, melt);
}

// F: the top of the acid film here (its meniscus up the walls, ripples, bubbles).
// Laminated metal (mokume = 1: mokume-gane's copper, silver and brass; 2: Damascus' bright and dark steels): the layer
// coordinate at q, warped like folded and forged billets, its contours cut down through by the height hs.
float ornLam(vec3 q, float hs) {
  if (mokume > 1.5) return q.y * 62.0 + 20.0 * ornNoise(q * 1.9 + 2.0 * ornNoise(q * 4.3)) + 2.5 * ornNoise(q * 10.0) - hs * 260.0;
  return q.y * 34.0 + 14.0 * ornNoise(q * 2.4 + 1.5 * ornNoise(q * 5.0)) + 1.5 * ornNoise(q * 11.0) - hs * 200.0;
}

float ornHeight(vec4 res, vec3 q, float en, out float F) {
  float d = res.x;
  float e = ornEtchAt(en, d);
  float ground = smoothstep(0.0, wallWidth, d);
  // Bitten isotropically: a steep, rounded wall with a cove at its foot; deeper where agitated and in open ground.
  float s = clamp(d / wallWidth, 0.0, 1.0);
  float bitten = mix(ground, s * (2.0 - s), e) * (0.85 + 0.3 * en + 0.2 * smoothstep(wallWidth, 0.012, d)) + 0.25 * e * exp(-pow((d - wallWidth) / (wallWidth * 0.6), 2.0));
  // Grind shaves the motifs flat at shaveLevel rather than scaling them.
  float H = d < 0.0 ? min(reliefHeight * res.y, shaveLevel) : -etchDepth * e * bitten;
  F = 0.0;
  // Cloisonné: the etch leaves only a wire round each motif's rim; its inside sinks to take the enamel.
  if (cloison > 0.0 && d < 0.0) H = mix(H, mix(-etchDepth, max(H, 0.0065 * reliefHeight), 1.0 - smoothstep(cloison * 0.6, cloison, -d)), e);
  // The scribed outline of the drawn motifs, chased into a crisp groove at their foot once etched.
  H -= lineDepth * exp(-d * d / (ornLw * ornLw)) * (1.0 - e);
  float cw = max(ornLw * 1.1, 0.0007);
  H -= e * chaseDepth * exp(-pow((d - cw * 0.4) / cw, 2.0));
  float ge = ground * e;
  // The etch eats the softer layers of a laminate deeper (copper, the carbon steel): the layers stand in relief.
  if (mokume > 0.0 && e > 0.0) {
    float lay = ornLam(q, H);
    float soft = mokume > 1.5 ? 0.5 + 0.5 * cos(6.2832 * lay) : smoothstep(0.3, 0.9, cos(2.0944 * lay));
    H -= e * mix(0.45, 1.0, ground) * etchDepth * (mokume > 1.5 ? 0.3 : 0.22) * soft * ornMatLod;
  }
  if (ge > 0.0) {
    if (ornMatLod > 0.0) H += ge * ornMatLod * matting * etchDepth * 0.3 * ornMatting(q);
    if (guilloche > 0.0) H += ge * guilloche * etchDepth * 0.13 * ornGuilloche(q);
    if (ornPitLod > 0.0) H += ge * ornPitLod * etchDepth * 0.07 * (ornNoise(q * 1100.0) - 0.5);
    float fizz = bubbles * ornWet * e * (0.25 + 2.5 * (1.0 - e)) * (0.3 + 1.5 * exp(-(d - wallWidth) / (wallWidth * 2.0)));
    if (fizz > 0.0) {
      float b = ground * 0.8 * ornBubble(q, fizz, d);
      H += b;
      F += b;
    }
  }
  if (ornWet > 0.0) {
    F += etchDepth * 0.45 * exp(-max(d, 0.0) / (wallWidth * 0.7));
    if (acidRipple > 0.0) F += acidRipple * 0.0004 * (sin(dot(q, vec3(70.0, 31.0, -52.0)) + ornTime * 1.7) + sin(dot(q, vec3(-38.0, 77.0, 45.0)) - ornTime * 1.3));
  }
  return H;
}
`;

const surface = /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
  vec3 p = vBase;
  vec3 n = normalize(vObjectNormal);
  vec3 T = normalize(cross(abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0), n));
  vec3 B = cross(n, T);
  float fp = length(fwidth(p));
  float eps = max(fp * 0.6, 0.00025);
  float lw = max(fp * 0.8, 0.0007);
  ornLw = lw;
  ornMatLod = 1.0 - smoothstep(0.0008, 0.0018, fp);
  ornPitLod = 1.0 - smoothstep(0.0004, 0.0009, fp);
  float near = wallWidth * 1.5 + eps * 2.0 + lw * 3.0;
  vec3 q1 = p + T * eps;
  vec3 q2 = p + B * eps;
  vec4 r0 = vec4(1e3, 0.0, 0.0, 0.0);
  vec4 r1 = r0;
  vec4 r2 = r0;
  ivec3 dim = ivec3(ornDim);
  ivec3 c = clamp(ivec3(floor((p - ornMin) / ornCellSize)), ivec3(0), dim - 1);
  int ci = c.x + dim.x * (c.y + dim.y * c.z);
  uvec2 oc = texelFetch(ornCells, ivec2(ci % ORN_OW, ci / ORN_OW), 0).rg;
  int count = int(oc.y);
  int off = int(oc.x);
  for (int i = 0; i < ${MAX_PER_CELL}; i++) {
    if (i >= count) break;
    int li = off + i;
    int id = int(texelFetch(ornList, ivec2(li % ORN_OW, li / ORN_OW), 0).r);
    vec4 t3 = ornTexel(id, 3);
    if (ornDraw < t3.x) continue;
    // Far from its bounding sphere, an element only adds its distance and the occlusion of its height.
    vec4 t4 = ornTexel(id, 4);
    float fr = floor(t4.w) / 4096.0;
    float fd = length(p - t4.xyz) - fr;
    if (fd > ornFar) {
      float fh = fract(t4.w) * ornRaise(t3.z);
      float occ = fh / (fd * 2.5 + fh * 0.6 + 1e-5);
      r0.x = min(r0.x, fd);
      r1.x = min(r1.x, fd);
      r2.x = min(r2.x, fd);
      r0.z = max(r0.z, occ);
      r1.z = max(r1.z, occ);
      r2.z = max(r2.z, occ);
      continue;
    }
    vec4 t0 = ornTexel(id, 0);
    vec4 t1 = ornTexel(id, 1);
    vec4 t2 = ornTexel(id, 2);
    // One call in a loop the compiler can't unroll: inlined three times, the shader takes minutes to compile on D3D.
    for (int k = 0; k < ornSamples; k++) {
      vec3 q = k == 0 ? p : k == 1 ? q1 : q2;
      vec4 r = vec4(1e3, 0.0, 0.0, 0.0);
      ornEval(t0, t1, t2, t3, q, n, lw, r);
      if (k == 0) {
        ornMerge(r0, r);
        // Beyond its wall it can't change the slope here: the offset samples take the same.
        if (r.x > near) {
          ornMerge(r1, r);
          ornMerge(r2, r);
          break;
        }
      } else if (k == 1) ornMerge(r1, r);
      else ornMerge(r2, r);
    }
  }
  if (guilloche > 0.0) ornGuiLod = 1.0 - smoothstep(0.25, 0.6, fwidth(ornGuiU(p)));
  float en = ornNoise(p * 3.0) * 0.6 + ornNoise(p * 9.0) * 0.4;
  ornN = n;
  vec3 wp = vWorldPosition;
  // The acid as a liquid on the piece (object space, so it turns with it): it spreads from a few places with an
  // irregular front, then the rinse thins it into shrinking patches that hang on longest in the crevices by the walls.
  if (acidLine > -1e2) {
    bool draining = acidLine > 1.0;
    float cov = draining ? 2.0 - acidLine : acidLine;
    float field = 0.65 * ornNoise(p * 1.7 + 11.0) + 0.35 * ornNoise(p * 6.0 + 3.0);
    if (draining) field = 0.55 * ornNoise(p * 4.0 + 29.0) + 0.3 * ornNoise(p * 13.0) + 0.15 * ornNoise(p * 40.0) + 0.3 * (1.0 - smoothstep(0.0, 0.006, r0.x)) * -1.0 + 0.15;
    float edge = draining ? 0.03 : 0.05;
    ornWet = smoothstep(-edge, edge, cov * 1.3 - 0.15 - field);
  } else ornWet = 0.0;
  float h0 = 0.0, h1 = 0.0, h2 = 0.0, F0 = 0.0, F1 = 0.0, F2 = 0.0;
  // As with ornEval: one call in a loop the compiler can't unroll, rather than three inlined copies.
  for (int k = 0; k < ornSamples; k++) {
    float F;
    float h = ornHeight(k == 0 ? r0 : k == 1 ? r1 : r2, k == 0 ? p : k == 1 ? q1 : q2, en, F);
    if (k == 0) {
      h0 = h;
      F0 = F;
    } else if (k == 1) {
      h1 = h;
      F1 = F;
    } else {
      h2 = h;
      F2 = F;
    }
  }
  float e = ornEtchAt(en, r0.x);
  // One sample a pixel: the slope comes from the screen-space derivatives of the height (Mikkelsen's surface gradient).
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  vec3 rx = cross(dpdy, n);
  vec3 ry = cross(n, dpdx);
  float det = dot(dpdx, rx);
  vec3 sgrad = (dFdx(h0) * rx + dFdy(h0) * ry) / (abs(det) > 1e-20 ? det : 1e-20);
  vec3 fgrad = (dFdx(F0) * rx + dFdy(F0) * ry) / (abs(det) > 1e-20 ? det : 1e-20);
  if (ornSamples == 1) {
    r1 = r0;
    r2 = r0;
    h1 = h0 + dot(sgrad, T) * eps;
    h2 = h0 + dot(sgrad, B) * eps;
    F1 = F0 + dot(fgrad, T) * eps;
    F2 = F0 + dot(fgrad, B) * eps;
  }
  vec3 nb = normalize(n - T * (h1 - h0) / eps - B * (h2 - h0) / eps);
  // Enamel or niello: nbM is the metal under it, nb the top; the stone cuts both down to one level.
  vec3 nbM = nb;
  vec3 nRel = nb;
  float fillCov = 0.0;
  float cut = 0.0;
  float stoned = 0.0;
  float thick = 0.0;
  float melt = 0.0;
  if (enamelOn > 0.5) {
    float g = smoothstep(0.0, 1.0, ornGrind);
    float G = ornGrind > 0.0 ? mix(fireLevel + 0.012, fillLevel, g) : 1e3;
    float m0 = min(h0, G);
    float m1 = min(h1, G);
    float m2 = min(h2, G);
    cut = smoothstep(-0.00005, 0.0001, h0 - G);
    nbM = normalize(n - T * (m1 - m0) / eps - B * (m2 - m0) / eps);
    float amt = ornFillFront(p);
    if (amt > 0.0) {
      melt = clamp(ornFire * 2.4 - 0.5 * ornNoise(p * 7.0) - 0.15, 0.0, 1.0);
      float f0 = ornFillTop(r0.x, p, amt, melt);
      stoned = smoothstep(-0.00005, 0.0001, f0 - G);
      f0 = min(f0, G);
      float f1 = min(ornFillTop(r1.x, q1, amt, melt), G);
      float f2 = min(ornFillTop(r2.x, q2, amt, melt), G);
      fillCov = smoothstep(0.0, 0.00012, f0 - m0);
      thick = max(f0 - m0, 0.0);
      float t0 = max(m0, f0);
      nb = normalize(n - T * (max(m1, f1) - t0) / eps - B * (max(m2, f2) - t0) / eps);
    } else nb = nbM;
  }
  // A stone-cut face keeps a little of the modeling under it (fillKeep), as a polished inlay does.
  if (enamelOn > 0.5) nb = normalize(mix(nb, nRel, fillKeep * cut));
  // Cushioned enamel: inside a motif the glass keeps a soft swell of the modeling under it.
  if (fillCushion > 0.0) {
    // From the motif's own modeling (cloisonné sinks the motifs before the glass goes in).
    vec3 nCush = normalize(n - (T * (r1.y - r0.y) + B * (r2.y - r0.y)) * reliefHeight * 0.5 / eps);
    nb = normalize(mix(nb, nCush, fillCushion * fillCov * step(r0.x, 0.0)));
  }
  // The acid film over the exposed ground: level, rising in a meniscus at the walls.
  float wet = ornWet * smoothstep(-0.0002, 0.0004, r0.x);
  vec3 nFilm = wet > 0.0 ? normalize(ornModel * normalize(n - T * (F1 - F0) / eps - B * (F2 - F0) / eps)) : n;
  s.normal = normalize(ornModel * nb);

  float d = r0.x;
  float ground = smoothstep(0.0, wallWidth, d);
  float ge = ground * e;
  float inside = step(d, 0.0);
  float nz = ornNoise(p * 14.0);
  float nz2 = ornNoise(p * 60.0);
  float top = clamp(r0.y / 0.01, 0.0, 1.4) * inside;
  float cav = r0.w * inside;
  // How much the surface leans away from the blank: the motifs' shoulders and walls.
  float slope = clamp(1.0 - dot(nbM, n), 0.0, 1.0);

  // Crevices along the walls hold the dark and the deposits.
  float crevice = ge * (1.0 - smoothstep(wallWidth, wallWidth * 6.0, d));
  // Ground hemmed in by tall motifs sees less of the sky.
  float hemmed = clamp(r0.z * reliefHeight + e * etchDepth / (d + wallWidth), 0.0, 2.0);
  float occlusion = (1.0 - ge * 0.2) * (1.0 - 0.38 * hemmed * ground);
  // Low parts of a motif beside higher ones: its own base, and its folds.
  occlusion *= mix(1.0, 0.7, inside * (1.0 - smoothstep(0.0, 0.004, r0.y)));
  occlusion *= 1.0 - 0.35 * cav;
  float cw = max(lw * 1.1, 0.0007);
  float chase = e * exp(-pow((d - cw * 0.4) / cw, 2.0));
  occlusion *= 1.0 - 0.5 * max(exp(-d * d / (lw * lw)) * (1.0 - e), chase);

  // Matting too fine to resolve still scatters: a rougher, darker ground.
  float matFade = ge * matting * (1.0 - ornMatLod);
  float rough = mix(blankRough, groundRough + 0.25 * matFade, ge) * (0.85 + 0.3 * nz2);
  occlusion *= 1.0 - 0.15 * matFade;
  // Motifs in their own metal (gilt, inlaid) once the patina stage lays it on; the blank and the ground in groundColor.
  float gild = inside * clamp(ornPatina * 1.6 - nz * 0.6, 0.0, 1.0);
  vec3 albedo = mix(groundColor, metalColor, gild) * mix(1.0, groundDark, ge);
  if (mokume > 0.0) {
    // Mokume-gane: wavy copper, silver and brass layers, cut down through by the relief and the etch.
    float hs = d < 0.0 ? min(reliefHeight * r0.y, shaveLevel) : -etchDepth * ge;
    float lay = ornLam(p, hs);
    float aa = 0.08 + min(fwidth(lay), 2.0);
    if (mokume > 1.5) {
      // Damascus: bright nickel steel and carbon steel blackened by the etch.
      float c = smoothstep(-aa, aa, cos(6.2832 * lay));
      vec3 dark = mix(vec3(0.42, 0.42, 0.43), vec3(0.07, 0.07, 0.075), smoothstep(0.0, 1.0, e));
      albedo = mix(dark, vec3(0.78, 0.78, 0.77), mix(c, 0.5, smoothstep(0.6, 2.0, fwidth(lay)))) * mix(1.0, groundDark, ge);
    } else {
      vec3 ph = cos(2.0944 * (lay - vec3(0.0, 1.0, 2.0)));
      vec3 w = smoothstep(vec3(0.5 - aa), vec3(0.5 + aa), ph) + 0.01;
      albedo = (vec3(0.72, 0.31, 0.18) * w.x + vec3(0.93, 0.92, 0.88) * w.y + vec3(0.92, 0.72, 0.38) * w.z) / (w.x + w.y + w.z) * mix(1.0, groundDark, ge);
    }
  }
  vec3 fresh = albedo;
  float metal = 1.0;
  // Stained as it bites: warm metals go brown, rose by the walls, then dark red-black; grey ones a frosty grey.
  float stain = etchStain * ge * smoothstep(0.0, 1.0, e);
  if (stain > 0.0) {
    float warm = clamp((albedo.r - albedo.b) * 4.0 - 0.2, 0.0, 1.0);
    float bloom = exp(-max(d - wallWidth, 0.0) / (wallWidth * 1.2));
    vec3 ws = mix(mix(vec3(0.2, 0.075, 0.035), vec3(0.04, 0.01, 0.008), smoothstep(0.3, 1.0, e)), vec3(0.24, 0.06, 0.05), bloom * 0.6);
    vec3 cs = vec3(dot(albedo, vec3(0.3, 0.5, 0.2))) * (0.8 + 0.15 * nz2) + 0.03;
    albedo = mix(albedo, mix(cs, ws * (0.8 + 0.4 * nz), warm), stain * mix(0.6, 0.9, warm));
    rough = mix(rough, rough + 0.2, stain * (1.0 - warm));
    metal = 1.0 - 0.75 * stain * warm;
  }

  // Patina: an oxide darkens the whole piece, a crust gathers in the crevices, in the motifs' folds and in
  // patches on the ground, then the burnish takes both off the crowns and ridges, highest first.
  float grow = clamp(ornPatina * 1.5 - nz * 0.5, 0.0, 1.0);
  float ridge = min(top, 1.0) * (1.0 - cav) * (1.0 - clamp(slope * 2.5, 0.0, 1.0));
  float polish = smoothstep(-0.2, 0.5, ornBurnish * 1.2 - 1.2 + ridge - burnishReach - 0.25 * (nz - 0.5)) * inside;
  float oxide = grow * mix(0.6, 1.0, max(ground, cav)) * (1.0 - polish * (1.0 - 0.7 * cav));
  float blotch = smoothstep(0.62, 0.8, ornNoise(p * 6.0 + ornNoise(p * 17.0) * 1.5));
  float tight = ge * (1.0 - smoothstep(0.0, wallWidth * 0.8, d - wallWidth * 0.3));
  float onMotif = inside * clamp(cav * 1.2 + motifCrust * (0.75 + 0.5 * nz - 0.6 * ridge), 0.0, 1.0);
  float crust = grow * depositAmount * clamp(tight * 0.6 + chase + blotch * ge * 0.8 * (1.0 - groundTone) + onMotif, 0.0, 1.0);
  crust *= (1.0 - polish * (1.0 - 0.8 * cav)) * (0.8 + 0.3 * nz2);
  albedo = mix(albedo, patinaColor2 * (0.8 + 0.4 * nz2) * (mokume > 0.0 ? albedo : vec3(1.0)), oxide);
  metal = mix(metal, patinaMetal, oxide);
  rough = mix(rough, oxideRough, oxide);
  // The crust lies thick and deep-toned in the folds, thin and chalky over the crowns.
  vec3 cc = patinaColor * (0.75 + 0.5 * ornNoise(p * 40.0));
  cc = mix(cc, cc * 1.35 + 0.04, ridge * (1.0 - cav)) * (1.0 - 0.3 * cav);
  albedo = mix(albedo, cc, crust);
  metal = mix(metal, 0.0, crust);
  rough = mix(rough, patinaRough, crust);
  rough = mix(rough, polishRough, polish);
  occlusion = mix(occlusion, 1.0, crust * 0.3);

  if (anodize > 0.0) {
    // Anodised titanium: thin-film interference, the oxide thicker (straw, bronze, purple, blue, teal) up the relief.
    float th = mix(0.035, 0.097, clamp((h0 + etchDepth) / (etchDepth + 0.009 * reliefHeight), 0.0, 1.0)) + 0.016 * (nz - 0.5) + 0.05 * (ornNoise(p * 1.3) - 0.5);
    vec3 film = 0.47 - 0.45 * cos(30.16 * th / vec3(0.62, 0.54, 0.46) + 2.67);
    albedo = mix(albedo, mix(vec3(0.3), pow(film, vec3(1.5)) * 1.25, 0.92), anodize * grow);
  }
  // Shaved crowns: fresh metal, polished, the patina cut away with them.
  float shaved = inside * smoothstep(shaveLevel - 0.00015, shaveLevel, reliefHeight * r0.y);
  if (shaved > 0.0) {
    albedo = mix(albedo, fresh, shaved);
    metal = mix(metal, 1.0, shaved);
    rough = mix(rough, polishRough * (0.85 + 0.3 * nz2), shaved);
    occlusion = mix(occlusion, 1.0, shaved);
  }

  if (enamelOn > 0.5) {
    // Metal faces cut by the stone: fresh and satin, then polished.
    albedo = mix(albedo, fresh, cut);
    metal = mix(metal, 1.0, cut);
    rough = mix(rough, mix(0.4, polishRough, ornBurnish) * (0.85 + 0.3 * nz2), cut);
    occlusion = mix(occlusion, 1.0, cut);
    // The fill: chalky powder, fused glossy in the kiln, satin from the stone, then polished.
    vec3 ec = fillBand > 0.0 ? mix(fillColor2, fillColor, smoothstep(fillBand * 0.7, fillBand * 1.3, d)) : fillColor;
    // Cloisonné cells shade to white toward the crowns of the motifs they fill.
    if (cloison > 0.0) ec = mix(ec, vec3(0.8, 0.78, 0.72), 0.6 * smoothstep(0.75, 1.4, top));
    // Deeper glass over the hollows of the modeling, thinner and lighter over its crowns.
    if (fillCushion > 0.0) ec *= mix(1.0, 0.55 + 0.75 * smoothstep(0.0, 1.2, top) - 0.35 * cav, fillCushion * inside);
    ec *= 0.9 + 0.2 * ornNoise(p * 30.0);
    vec3 powder = mix(ec, vec3(dot(ec, vec3(0.3, 0.5, 0.2))), 0.35) * 1.3 + 0.04;
    float clear = fillClear * melt;
    vec3 fa = mix(powder, ec, melt);
    // Translucent glass scatters little: its colour comes from the metal under it (below).
    fa = mix(fa, ec * ec * 0.08, clear);
    float fr = mix(0.92, mix(0.06 + 0.04 * nz2, mix(0.45, fillRough, ornBurnish), stoned), melt);
    albedo = mix(albedo, fa, fillCov);
    if (fillPearl > 0.0) {
      // Mother-of-pearl: a pale nacre whose colours shift with the view and with its growth layers.
      float nv = clamp(dot(s.normal, normalize(cameraPosition - vWorldPosition)), 0.0, 1.0);
      float ph = 7.0 * nv + 4.0 * ornNoise(p * 22.0) + 1.5 * ornNoise(p * 85.0);
      vec3 iri = 0.5 + 0.5 * cos(ph + vec3(0.0, 2.1, 4.2));
      vec3 nacre = mix(vec3(0.86, 0.84, 0.8), iri * vec3(0.95, 0.9, 1.0), 0.4 * fillPearl);
      albedo = mix(albedo, nacre, fillCov * melt);
    }
    metal = mix(metal, fillMetal * melt, fillCov);
    rough = mix(rough, fr, fillCov);
    occlusion = mix(occlusion, 1.0, fillCov * 0.85);
    if (fillLines > 0.0) {
      // Niello: once the stone cuts the faces, the line work engraved in the silver shows filled black too.
      float outline = inside * exp(-pow((d + 0.0008) / 0.0005, 2.0));
      // Fades out as the lines get finer than a pixel, so the silver doesn't drown from afar.
      float fine = 1.0 - smoothstep(0.0009, 0.0022, lw);
      float lines = fillLines * fine * cut * smoothstep(0.0, 0.3, ornGrind) * clamp(smoothstep(0.15, 0.5, cav) + outline, 0.0, 1.0);
      albedo = mix(albedo, ec, lines);
      metal = mix(metal, fillMetal, lines);
      rough = mix(rough, fillRough, lines);
    }
    vec3 em = vec3(0.0);
    if (clear * fillCov > 0.0) {
      // Basse-taille: the engine-turned metal seen through the glass, tinted by the path through it.
      vec3 Pw = vWorldPosition;
      vec3 V = normalize(cameraPosition - Pw);
      vec3 nT = s.normal;
      vec3 nU = normalize(ornModel * nbM);
      float NdotV = clamp(dot(nT, V), 0.05, 1.0);
      float Ft = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);
      vec3 tr = pow(max(ec, vec3(1e-3)), vec3((thick + 0.0015) / 0.004 / max(NdotV, 0.3)));
      vec3 R = reflect(-V, nU);
      float ru = 0.14;
      vec3 rad = textureLod(envMap, envRotation * R, envMapMaxLod * ru * (2.0 - ru)).rgb * envIntensity;
      vec3 L = normalize(lightDirection);
      vec3 H = normalize(L + V);
      float a = ru * ru;
      float NdotL = clamp(dot(nU, L), 0.0, 1.0) * smoothstep(-0.1, 0.2, dot(normalize(ornModel * n), L));
      vec3 key = lightColor * NdotL * D_GGX(clamp(dot(nU, H), 0.0, 1.0), a) * V_SmithGGXCorrelated(a, clamp(dot(nU, V), 1e-4, 1.0), NdotL);
      em += clear * fillCov * (1.0 - Ft) * (1.0 - Ft) * tr * groundColor * (rad + key) * occlusion;
    }
    // Kiln heat: a dull red glow, brighter in the glass.
    float heat = smoothstep(0.0, 0.3, ornFire) * (1.0 - smoothstep(0.5, 1.0, ornFire));
    em += fillGlow * 1.2 * heat * heat * vec3(1.0, 0.1, 0.012) * mix(0.25, 1.0, fillCov) * (0.75 + 0.5 * nz);
    albedo *= 1.0 - 0.75 * heat;
    s.emissive = em;
  }

  if (wet > 0.0) {
    // Wet: the metal seen through yellow-green acid, and the film's own sharp reflection on top (its meniscus up
    // the walls catching the light).
    vec3 V = normalize(cameraPosition - vWorldPosition);
    float nv = clamp(dot(nFilm, V), 0.0, 1.0);
    float Ff = 0.03 + 0.97 * pow(1.0 - nv, 5.0);
    albedo *= mix(vec3(1.0), vec3(0.24, 0.29, 0.13) * (1.0 - Ff), wet);
    rough = mix(rough, max(rough, 0.45), wet);
    vec3 L = normalize(lightDirection);
    vec3 Hl = normalize(L + V);
    float a = 0.0025;
    float NdotL = clamp(dot(nFilm, L), 0.0, 1.0);
    vec3 refl = textureLod(envMap, envRotation * reflect(-V, nFilm), envMapMaxLod * 0.06).rgb * envIntensity;
    s.emissive += wet * Ff * (refl * occlusion + lightColor * NdotL * D_GGX(clamp(dot(nFilm, Hl), 0.0, 1.0), a) * V_SmithGGXCorrelated(a, max(nv, 1e-4), NdotL));
  }

  s.albedo = albedo;
  s.metalness = metal;
  s.roughness = rough;
  s.occlusion = occlusion;
#endif
}
`;

export function createReliefMaterial(relief) {
  const material = new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 1,
    vertexPars,
    vertex,
    fragmentPars,
    surface,
    // Per-pixel normals tilt past the geometric terminator: fade the key light there instead of cutting it.
    defines: { PIPELINE_SOFT_TERMINATOR: "" },
    uniforms: {
      ornBlows: { value: null },
      ornBlowCount: { value: 0 },
      dentDepth: { value: 0.012 },
      ornPrims: { value: null },
      ornCells: { value: null },
      ornList: { value: null },
      ornMin: { value: new Vector3() },
      ornDim: { value: new Vector3() },
      ornCellSize: { value: 0.02 },
      ornModel: { value: new Matrix3() },
      ornSamples: { value: 3 },
      ornFar: { value: 0.025 },
      ornDraw: { value: 1 },
      ornHammer: { value: 1 },
      ornEtch: { value: 1 },
      ornPatina: { value: 1 },
      ornBurnish: { value: 1 },
      ornTime: { value: 0 },
      reliefHeight: { value: 1 },
      shaveLevel: { value: 1e3 },
      etchDepth: { value: 0.006 },
      wallWidth: { value: 0.0035 },
      lineDepth: { value: 0.0006 },
      chaseDepth: { value: 0.0012 },
      motifCrust: { value: 0 },
      groundTone: { value: 0 },
      burnishReach: { value: 0.3 },
      matting: { value: 1 },
      bubbles: { value: 1 },
      acidLine: { value: -1e3 },
      acidRipple: { value: 0 },
      etchStain: { value: 1 },
      metalColor: { value: new Color() },
      patinaColor: { value: new Color() },
      patinaColor2: { value: new Color() },
      patinaMetal: { value: 0 },
      oxideRough: { value: 0.5 },
      depositAmount: { value: 1 },
      patinaRough: { value: 0.7 },
      groundRough: { value: 0.45 },
      groundDark: { value: 0.8 },
      blankRough: { value: 0.12 },
      polishRough: { value: 0.1 },
      groundColor: { value: new Color() },
      guilloche: { value: 0 },
      mokume: { value: 0 },
      anodize: { value: 0 },
      fillPearl: { value: 0 },
      cloison: { value: 0 },
      fillCushion: { value: 0 },
      enamelOn: { value: 0 },
      ornFill: { value: 0 },
      ornFire: { value: 0 },
      ornGrind: { value: 0 },
      fillLevel: { value: 0.001 },
      fireLevel: { value: 0.004 },
      fillLines: { value: 0 },
      fillKeep: { value: 0 },
      fillSag: { value: 0.0015 },
      fillColor: { value: new Color() },
      fillColor2: { value: new Color() },
      fillBand: { value: 0 },
      fillClear: { value: 0 },
      fillMetal: { value: 0 },
      fillRough: { value: 0.05 },
      fillGlow: { value: 1 },
    },
  });
  if (relief) setRelief(material, relief);
  return material;
}

export function setRelief(material, relief) {
  const u = material.uniforms;
  for (const k of ["ornPrims", "ornCells", "ornList", "ornBlows"]) u[k].value?.dispose();
  u.ornPrims.value = relief.prims;
  u.ornCells.value = relief.cells;
  u.ornList.value = relief.list;
  u.ornBlows.value = relief.blows;
  u.ornBlowCount.value = relief.blowCount;
  u.ornMin.value.copy(relief.min);
  u.ornDim.value.copy(relief.dim);
  u.ornCellSize.value = relief.cellSize;
}
