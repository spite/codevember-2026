import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  RGBAFormat,
  HalfFloatType,
  FloatType,
  NearestFilter,
  UnsignedByteType,
  CustomBlending,
  OneFactor,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  NoColorSpace,
  Scene,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  Vector2,
  Vector3,
} from "three";
import { shader as simplexNoise3D } from "shaders/perlinSimplex3D.js";
import { seededRandom } from "modules/random.js";

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Suzanne: her mesh drawn in atlas space (uv as the position) into one band of rows, shifted by the bake's sub-texel
// jitter; writes each texel's surface point (w = 1 where she is)
const FRAME_VS = /* glsl */ `
in vec3 position;
in vec2 uv;
uniform vec3 uBand; // first row, rows in the frame target, rows in the atlas
uniform vec2 uJitter;
out vec3 vPos;
void main() {
  vPos = position;
  vec2 a = uv - uJitter;
  gl_Position = vec4(a.x * 2.0 - 1.0, (a.y * uBand.z - uBand.x) / uBand.y * 2.0 - 1.0, 0.0, 1.0);
}
`;
const FRAME_FS = /* glsl */ `
precision highp float;
in vec3 vPos;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(vPos, 1.0);
}
`;
// Suzanne's flow pass: her mesh in atlas space, with its frame
const MESH_FLOW_VS = /* glsl */ `
in vec3 position;
in vec3 normal;
in vec4 aTangent;
in vec2 uv;
out vec2 vUv;
out vec3 vPos;
out vec3 vNrm;
out vec4 vTan;
void main() {
  vUv = uv;
  vPos = position;
  vNrm = normal;
  vTan = aTangent;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Pass 1: Solidifies the Navier-Stokes fluid-advected 3D coordinates (uSimCoord) into RAZOR-SHARP
// Substance-Designer-grade solid volcanic rock PBR maps (80-88% hard dark stone + narrow fiery veins)!
// Zero bilinear blur: all IQ Voronoi cracks, chipped bevels, pahoehoe folds & scoria pores are
// evaluated analytically at full 2K-3K atlas resolution in the fluid-advected coordinate frame!
const BAKE_SOLID_FROM_FLUID_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor; // R = height (0..1), G = heat (0..1.25), B = crustMask (0..1), A = plateId

uniform sampler2D uSimCoord; // xyz = Navier-Stokes advected 3D sphere dir, w = fluid strain (+rift, -compression)
// uStyle is a compile-time constant (one program per style, see STYLE_COUNT), so only one style's code is compiled
// Loop bounds as uniforms (always 1 and 4) keep the Direct3D compiler from unrolling and inlining
// every Voronoi and noise loop, which made this shader take seconds to compile
uniform int uOne;
uniform int uFour;
uniform int uShapeMode;      // 0: cube atlas (radial shapes), 1: torus, 2: trefoil knot, 3: twisted ring, 5: Suzanne
// Suzanne (mode 5): her surface point per texel of this band (rows from uFrameY0), rasterised from her mesh
uniform highp sampler2D uFrame;
uniform int uFrameY0;

uniform float uCrust;
uniform float uScale;
uniform float uFluidFlow;
uniform float uPad;
uniform vec3 uSeedOff;
uniform vec2 uJitter;

${simplexNoise3D}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

const mat3 FBM_ROT = mat3(
   0.00,  0.80,  0.60,
  -0.80,  0.36, -0.48,
  -0.60, -0.48,  0.64
);

float fbm4(vec3 p) {
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < uFour; i++) {
    f += a * snoise(p);
    p = FBM_ROT * p * 2.03 + vec3(17.1, 31.7, 13.3);
    a *= 0.5;
  }
  return f;
}

float ridged4(vec3 p) {
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < uFour; i++) {
    float n = 1.0 - abs(snoise(p));
    f += a * n * n;
    p = FBM_ROT * p * 2.06 + vec3(9.2, 21.4, 5.7);
    a *= 0.5;
  }
  return f;
}

// True 2-pass IQ Euclidean 3D Voronoi: razor-sharp uniform-width rock fractures!
vec3 gVorR;

// Returns (edge distance, centre distance, cell id); gVorR is the offset to the nearest centre.
vec3 voronoi3D(vec3 x) {
  vec3 n = floor(x);
  vec3 f = fract(x);

  vec3 mg, mr;
  float md = 8.0;
  float cellId = 0.0;

  for (int k = -uOne; k <= uOne; k++) {
    for (int j = -uOne; j <= uOne; j++) {
      for (int i = -uOne; i <= uOne; i++) {
        vec3 g = vec3(float(i), float(j), float(k));
        vec3 o = hash33(n + g);
        vec3 r = g + o - f;
        float d = dot(r, r);
        if (d < md) {
          md = d;
          mr = r;
          mg = g;
          cellId = fract(o.x * 13.37 + o.y * 7.13 + o.z * 23.71);
        }
      }
    }
  }

  float edgeDist = 8.0;
  for (int k = -uOne; k <= uOne; k++) {
    for (int j = -uOne; j <= uOne; j++) {
      for (int i = -uOne; i <= uOne; i++) {
        vec3 g = mg + vec3(float(i), float(j), float(k));
        vec3 o = hash33(n + g);
        vec3 r = g + o - f;
        if (dot(mr - r, mr - r) > 1e-5) {
          edgeDist = min(edgeDist, dot(0.5 * (mr + r), normalize(r - mr)));
        }
      }
    }
  }

  gVorR = mr;
  return vec3(edgeDist, sqrt(md), cellId);
}

// Voronoi with cells stretched along dir by stretch (distances shrink along it). Returns (F2 - F1, F1, cell id);
// gVorR is the true offset to the nearest centre.
vec3 voronoiAniso(vec3 x, vec3 dir, float stretch) {
  vec3 n = floor(x);
  vec3 f = fract(x);
  float k = 1.0 - 1.0 / stretch;
  float d1 = 8.0, d2 = 8.0, cellId = 0.0;
  vec3 mr = vec3(0.0);
  int reach = uOne * 2;
  for (int kz = -reach; kz <= reach; kz++) {
    for (int j = -reach; j <= reach; j++) {
      for (int i = -reach; i <= reach; i++) {
        vec3 g = vec3(float(i), float(j), float(kz));
        vec3 o = hash33(n + g);
        vec3 r = g + o - f;
        vec3 rm = r - dir * dot(r, dir) * k;
        float d = length(rm);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          mr = r;
          cellId = fract(o.x * 13.37 + o.y * 7.13 + o.z * 23.71);
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }
  gVorR = mr;
  return vec3(d2 - d1, d1, cellId);
}

// A swirling direction field over the rock (tangent to it), the grain the anisotropic looks follow
vec3 grainDir(vec3 dir, vec3 p) {
  vec3 axis = normalize(sin(uSeedOff * 1.3) + vec3(0.2, 0.8, 0.1));
  vec3 t = cross(axis, dir) + 0.55 * vec3(snoise(p * 0.45), snoise(p * 0.45 + 3.1), snoise(p * 0.45 + 6.2));
  t -= dir * dot(t, dir);
  return normalize(t + 1e-5);
}

// Bilinear lookup in an octahedral map whose taps fold across its outer edges like the sphere does
vec4 octTexel(sampler2D tex, ivec2 t, int n) {
  if (t.x < 0) { t.x = -1 - t.x; t.y = n - 1 - t.y; }
  else if (t.x >= n) { t.x = 2 * n - 1 - t.x; t.y = n - 1 - t.y; }
  if (t.y < 0) { t.y = -1 - t.y; t.x = n - 1 - t.x; }
  else if (t.y >= n) { t.y = 2 * n - 1 - t.y; t.x = n - 1 - t.x; }
  return texelFetch(tex, t, 0);
}
vec4 octBilinear(sampler2D tex, vec2 uv) {
  int n = textureSize(tex, 0).x;
  vec2 g = uv * float(n) - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = g - floor(g);
  return mix(
    mix(octTexel(tex, i, n), octTexel(tex, i + ivec2(1, 0), n), f.x),
    mix(octTexel(tex, i + ivec2(0, 1), n), octTexel(tex, i + ivec2(1, 1), n), f.x),
    f.y);
}

vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    n.xy = (1.0 - abs(n.yx)) * s;
  }
  return n.xy * 0.5 + 0.5;
}

vec3 trefoilCenter(float t) {
  float c2 = cos(2.0 * t);
  float s2 = sin(2.0 * t);
  float c3 = cos(3.0 * t);
  float s3 = sin(3.0 * t);
  return vec3((2.0 + c3) * c2, (2.0 + c3) * s2, s3) * 0.46;
}


// Twisted ring surface; must match twistedRingPos in meshData.js
vec3 twistedRingPos(vec2 uv) {
  float phi = uv.x * 6.2831853;
  float theta = uv.y * 6.2831853;
  float rho = 0.42 * (1.0 + 0.22 * cos(3.0 * (theta - phi)));
  float radial = 0.95 + rho * cos(theta);
  return vec3(radial * cos(phi), radial * sin(phi), rho * sin(theta));
}


vec3 tubePos(int mode, vec2 uv) {
  return twistedRingPos(uv);
}

vec3 atlasUVToDir(vec2 uv) {
  if (uShapeMode >= 3) return tubePos(uShapeMode, uv) / 1.15;
  if (uShapeMode == 1) {
    // Upright XY-plane Torus 3D surface position scaled to unit-sphere range
    float phi = uv.x * 6.2831853;
    float theta = uv.y * 6.2831853;
    float R = 0.98;
    float r = 0.44;
    vec3 pos = vec3((R + r * cos(theta)) * cos(phi), (R + r * cos(theta)) * sin(phi), r * sin(theta));
    return pos / 1.15;
  }
  if (uShapeMode == 2) {
    // Trefoil Knot 3D surface position scaled to unit-sphere range (matches geometry.js negated theta!)
    float phi = uv.x * 6.2831853;
    float theta = -uv.y * 6.2831853;
    vec3 c = trefoilCenter(phi);
    vec3 cN = trefoilCenter(phi + 0.002);
    vec3 cP = trefoilCenter(phi - 0.002);
    vec3 tanV = normalize(cN - cP);
    vec3 binorm = normalize(cross(tanV, normalize(c)));
    vec3 normV = normalize(cross(binorm, tanV));
    vec3 pos = c + (normV * cos(theta) + binorm * sin(theta)) * 0.30;
    return pos / 1.15;
  }

  vec2 g = uv * vec2(3.0, 2.0);
  int col = clamp(int(floor(g.x)), 0, 2);
  int row = clamp(int(floor(g.y)), 0, 1);
  int face = row * 3 + col;
  vec2 local = fract(g);
  vec2 fuv = (local - uPad) / (1.0 - 2.0 * uPad);
  vec2 st = fuv * 2.0 - 1.0;

  vec3 c;
  if (face == 0)      c = vec3( 1.0,  st.y, -st.x);
  else if (face == 1) c = vec3(-1.0,  st.y,  st.x);
  else if (face == 2) c = vec3( st.x,  1.0, -st.y);
  else if (face == 3) c = vec3( st.x, -1.0,  st.y);
  else if (face == 4) c = vec3( st.x,  st.y,  1.0);
  else                c = vec3(-st.x,  st.y, -1.0);

  vec3 c2 = c * c;
  vec3 s;
  s.x = c.x * sqrt(max(0.0, 1.0 - c2.y * 0.5 - c2.z * 0.5 + (c2.y * c2.z) / 3.0));
  s.y = c.y * sqrt(max(0.0, 1.0 - c2.z * 0.5 - c2.x * 0.5 + (c2.z * c2.x) / 3.0));
  s.z = c.z * sqrt(max(0.0, 1.0 - c2.x * 0.5 - c2.y * 0.5 + (c2.x * c2.y) / 3.0));
  return normalize(s);
}

void main() {
  vec3 dir;
  if (uShapeMode == 5) {
    vec4 frame = texelFetch(uFrame, ivec2(gl_FragCoord.xy) - ivec2(0, uFrameY0), 0);
    // Outside her charts and skirts
    if (frame.w < 0.5) {
      outColor = vec4(0.0);
      return;
    }
    dir = frame.xyz;
  } else {
    dir = atlasUVToDir(vUv + uJitter);
  }
  // Always sample the sphere-wrapped Navier-Stokes field via octEncode(normalize(dir))!
  // Because dir is 100% periodic on Torus & Trefoil Knot (pos(0,v)==pos(1,v), pos(u,0)==pos(u,1)),
  // every baked map tiles seamlessly across u=0/1 and v=0/1 with zero seam!
  vec3 unitDir = normalize(dir + 1e-6);
  vec2 octUv = octEncode(unitDir);

  // Sample Navier-Stokes fluid-advected 3D coordinate & accumulated fluid strain!
  vec4 sim = octBilinear(uSimCoord, octUv);
  vec3 advDir = (uShapeMode == 0)
    ? normalize(mix(unitDir, normalize(sim.xyz), clamp(uFluidFlow, 0.0, 1.0)))
    : (dir + (normalize(sim.xyz) - unitDir) * clamp(uFluidFlow * 0.45, 0.0, 0.5));
  float strain = sim.w; // > 0 tensile rift opening, < 0 compressive pahoehoe buckling
  float riftBoost = clamp(strain * 0.5 + 0.5, 0.0, 1.0);

  float s = uScale;

  // High-frequency Substance volcanic rock porosity & grain evaluated in fluid-advected space
  float macroBoulder = fbm4(dir * 1.15 + uSeedOff * 0.37) * 0.095;
  float rockGrain = fbm4(advDir * (14.0 * s) + uSeedOff) * 0.042;
  float scoriaPores = (1.0 - smoothstep(0.0, 0.30, ridged4(advDir * (24.0 * s) + uSeedOff * 1.7))) * 0.026;

  float height = 0.5;
  float heat = 0.0;
  float crustMask = 1.0;
  float plateId = 0.5;

  if (uStyle == 0) {
    // Cracked Plates: angular basalt slabs, tilted and faceted, parted over fissures that open into rivers with rafts
    vec3 p = advDir * (s * 2.0) + uSeedOff;
    vec3 jag = vec3(fbm4(p * 1.3), fbm4(p * 1.3 + 4.1), fbm4(p * 1.3 + 8.7)) * 0.2;
    vec3 v1 = voronoi3D(p + jag);
    vec3 toCentre = gVorR;
    vec3 v2 = voronoi3D(p * 2.7 + jag * 1.2 + vec3(2.3, 6.7, 4.1));
    vec3 toSub = gVorR;

    float open = smoothstep(-0.25, 0.45, fbm4(p * 0.55 + 3.3));
    // Hairlines over most of the rock, wide rivers where it opens up
    float gap = mix(0.075, 0.014, uCrust) * (0.35 + 1.2 * open + 2.6 * open * open * open) * (0.8 + 0.4 * riftBoost);
    float across = clamp(1.0 - v1.x / gap, 0.0, 1.0);
    float bevel = smoothstep(gap * 0.7, gap + 0.045, v1.x);
    float shoulder = pow(bevel, 0.45);
    float subCrack = (1.0 - smoothstep(0.0, 0.014, v2.x)) * bevel;
    float subGlow = smoothstep(0.1, 0.5, fbm4(p * 1.7 + 9.1));

    vec3 tiltAxis = normalize(hash33(vec3(v1.z * 91.7, v1.z * 13.1, v1.z * 47.3)) - 0.5);
    vec3 subAxis = normalize(hash33(vec3(v2.z * 37.3, v2.z * 71.9, v2.z * 19.7)) - 0.5);
    float plateTop = 0.6 + (v1.z - 0.5) * 0.16 + dot(toCentre, tiltAxis) * 0.2 + dot(toSub, subAxis) * 0.05;
    float chip = fbm4(p * 3.4 + vec3(v1.z * 11.0)) * 0.06;

    // Rafts: small crust chunks floating in the widest rivers
    vec3 v3 = voronoi3D(p * 6.0 + jag * 2.0 + vec3(5.1, 1.7, 8.3));
    float raftZone = smoothstep(0.45, 0.85, open) * smoothstep(0.2, 0.55, across) * step(0.35, fract(v3.z * 5.7));
    float raft = smoothstep(0.035, 0.075, v3.x) * raftZone;

    float h = 0.08 + macroBoulder * 0.45 + shoulder * (plateTop + chip) - subCrack * 0.13 + (rockGrain * 0.9 - scoriaPores * 1.2) * bevel;
    h += raft * (0.2 + v3.z * 0.1 + rockGrain);
    height = clamp(h, 0.0, 1.0);
    crustMask = clamp(max(bevel * (1.0 - subCrack * 0.5 * subGlow), raft), 0.0, 1.0);
    // Deep red at the fissure walls rising to a hot core; hairlines glow only in patches
    heat = (0.34 + 0.5 * pow(across, 2.5)) * step(0.001, across) + (1.0 - bevel) * 0.1 + subCrack * subGlow * 0.4;
    heat += (1.0 - smoothstep(0.0, gap * 0.35, v1.x)) * (0.3 + 0.35 * open);
    heat *= 1.0 - raft;
    plateId = mix(v1.z, v3.z, raft);
  } else if (uStyle == 1) {
    // Pillow Lava: plump round glossy domes that fill their cells, blistered toes, thin white-hot seams
    vec3 p = advDir * (s * 1.9) + uSeedOff;
    vec3 warp = vec3(snoise(p * 0.9), snoise(p * 0.9 + 3.7), snoise(p * 0.9 + 7.9)) * 0.22;
    vec3 v1 = voronoi3D(p + warp);
    vec3 v2 = voronoi3D(p * 4.4 + vec3(3.1, 6.4, 2.7));
    vec3 v3 = voronoi3D(p * 9.5 + vec3(7.2, 1.9, 5.4));

    float seamW = mix(0.075, 0.016, uCrust) * (0.8 + 0.36 * riftBoost);
    float seam = 1.0 - smoothstep(0.0, seamW, v1.x);
    float fill = smoothstep(seamW * 0.3, seamW + 0.22, v1.x);
    // Hemispherical profile: centre distance against distance to the border
    float r = v1.y / (v1.y + v1.x + 1e-4);
    float bulge = sqrt(max(0.0, 1.0 - r * r));
    float dome = mix(sqrt(fill), bulge, 0.55) * fill;
    float flank = smoothstep(0.15, 0.6, 1.0 - fill) * (1.0 - seam);
    float blister = pow(clamp(1.0 - v2.y * 0.92, 0.0, 1.0), 0.55) * flank;
    float micro = pow(clamp(1.0 - v3.y * 0.96, 0.0, 1.0), 0.65) * flank;

    float h = 0.06 + macroBoulder * 0.55 + dome * (0.78 + (v1.z - 0.5) * 0.14) + blister * 0.1 + micro * 0.04 + rockGrain * 0.2 * (1.0 - seam);
    height = clamp(h, 0.0, 1.0);
    crustMask = clamp(1.0 - seam, 0.0, 1.0);
    heat = 0.4 * smoothstep(0.0, 0.5, seam) + 0.8 * seam * seam + (1.0 - smoothstep(seamW * 0.2, seamW + 0.05, v1.x)) * 0.18;
    heat = clamp(heat, 0.0, 1.2);
    heat += (1.0 - smoothstep(0.0, seamW * 0.28, v1.x)) * 0.35;
    plateId = v1.z;
  } else if (uStyle == 2) {
    // Pahoehoe Coils: meandering lobes wound with concentric rope ridges that spiral into a glowing eye, hot seams between
    vec3 p = advDir * (s * 2.05) + uSeedOff;
    vec3 warp = vec3(snoise(p * 0.75), snoise(p * 0.75 + 3.7), snoise(p * 0.75 + 7.9)) * 0.34;
    vec3 v1 = voronoi3D(p + warp);
    vec3 r = gVorR;
    vec3 t1 = normalize(cross(advDir, vec3(0.31, 0.95, 0.12)));
    vec3 t2 = cross(advDir, t1);
    float ang = atan(dot(r, t2), dot(r, t1));
    float arms = v1.z > 0.5 ? 1.0 : -1.0;

    float open = smoothstep(-0.2, 0.5, fbm4(p * 0.45 + 5.1));
    float seamW = mix(0.06, 0.012, uCrust) * (0.5 + 1.1 * open * open) * (0.8 + 0.4 * riftBoost);
    float seam = 1.0 - smoothstep(0.0, seamW, v1.x);
    float lobe = sqrt(smoothstep(seamW * 0.35, seamW + 0.05, v1.x));

    // Rings follow the lobe outline (edge distance), rounded toward the centre, wound into a spiral
    float ringD = mix(v1.x, 0.62 - v1.y, 0.4);
    float coilPhase = ringD * 82.0 + ang * arms + snoise(p * 2.6) * 0.9;
    float k = fract(coilPhase / 6.2831853);
    float rope = sqrt(clamp(sin(3.14159 * k), 0.0, 1.0));
    float groove = 1.0 - smoothstep(0.0, 0.2, min(k, 1.0 - k));
    // Fine transverse wrinkles across each rope
    float wrinkle = (snoise(vec3(ang * 5.0, coilPhase * 0.5, v1.z * 31.0)) * 0.5 + 0.5) * rope;
    float eye = (1.0 - smoothstep(0.06, 0.12, v1.y)) * step(0.35, fract(v1.z * 7.3)) * lobe;

    float h = 0.1 + macroBoulder * 0.4 + lobe * (0.42 + (v1.z - 0.5) * 0.08 + rope * 0.3 - groove * 0.1 + wrinkle * 0.04)
      + rockGrain * 0.6 * lobe - scoriaPores * 1.3 * lobe - eye * 0.22;
    height = clamp(h, 0.0, 1.0);
    crustMask = clamp((1.0 - seam) * (1.0 - eye * 0.92), 0.0, 1.0);
    // Grooves next to a seam glow from the lava underneath
    float grooveGlow = groove * (1.0 - smoothstep(seamW, seamW + 0.07, v1.x)) * mix(0.5, 0.25, uCrust);
    heat = clamp(seam * (0.95 + 0.3 * open) + eye * 1.15 + grooveGlow, 0.0, 1.25);
    // White-yellow thread down the middle of wide seams and in the eyes
    heat += (1.0 - smoothstep(0.0, seamW * 0.3, v1.x)) * (0.1 + 0.3 * open) + eye * (1.0 - smoothstep(0.0, 0.04, v1.y)) * 0.3;
    plateId = clamp(0.2 + 0.65 * rope * lobe + 0.15 * v1.z, 0.0, 1.0);
  } else if (uStyle == 3) {
    // Obsidian: knapped volcanic glass. Big blocks parted by a few hot veins, each chipped into concave
    // conchoidal scallops with sharp ridges between them
    vec3 p = advDir * (s * 1.45) + uSeedOff;
    vec3 warp = vec3(fbm4(p * 0.9), fbm4(p * 0.9 + 4.1), fbm4(p * 0.9 + 8.7)) * 0.28;
    vec3 v1 = voronoi3D(p + warp);
    vec3 v2 = voronoi3D(p * 1.7 + warp * 1.6 + vec3(6.1, 3.3, 1.9));
    vec3 v3 = voronoi3D(p * 5.3 + vec3(2.7, 9.1, 4.4));

    float gap = mix(0.05, 0.016, uCrust);
    float block = smoothstep(gap * 0.4, gap + 0.07, v1.x);
    // Scallops: low in each chip's centre, rising to a crisp ridge on its border; small chips knock the ridges
    float shell = clamp(v2.y * 1.4, 0.0, 1.0);
    float chip = smoothstep(0.0, 0.7, v3.y);
    float tilt = dot(advDir, normalize(vec3(sin(v1.z * 19.3), cos(v1.z * 31.7), sin(v1.z * 47.1)))) * 0.16;
    float h = 0.08 + macroBoulder * 0.5 + block * (0.48 + tilt + v1.z * 0.12 + shell * 0.32 + chip * shell * 0.035);
    // Only some seams run hot; the rest close into dark creases
    float veinOn = smoothstep(-0.5, -0.1, snoise(p * 0.55 + 3.7));
    float seam = (1.0 - smoothstep(0.0, gap, v1.x)) * veinOn;
    height = clamp(h - seam * 0.04, 0.0, 1.0);
    crustMask = clamp(1.0 - seam, 0.0, 1.0);
    // Glass near a hot vein glows faintly from inside
    heat = clamp(seam * 1.2 + exp(-v1.x * 9.0) * veinOn * 0.32 * (1.0 - seam), 0.0, 1.25);
    heat += (1.0 - smoothstep(0.0, gap * 0.3, v1.x)) * veinOn * 0.32;
    plateId = clamp(0.5 + 0.5 * shell - (1.0 - block) * 0.3, 0.0, 1.0);
  } else if (uStyle == 4) {
    // Flow Bands: stacked layers folded into S-curves, sharp ragged risers over sloping treads, lava welling in
    // lens-shaped slots under a few of the risers
    vec3 axis = normalize(sin(uSeedOff * 1.7) + vec3(0.0, 0.6, 0.0));
    vec3 p = advDir * (s * 1.2) + uSeedOff;
    vec3 w1 = vec3(snoise(p * 0.6), snoise(p * 0.6 + 5.2), snoise(p * 0.6 + 9.4));
    vec3 w2 = vec3(snoise(p * 1.5 + w1), snoise(p * 1.5 + w1 + 2.8), snoise(p * 1.5 + w1 + 6.1));
    vec3 q = advDir + w1 * 0.4 + w2 * 0.13;
    float f = dot(q, axis) * 1.4;
    float L = f * (4.2 * s);
    float band = floor(L);
    float t = fract(L);
    float bandH = fract(sin(band * 12.9898 + 78.233) * 43758.5453);

    // Sawtooth terrace with a ragged lip: steep riser, then a long tread sloping down to the next one
    float rag = fbm4(p * 7.0 + vec3(band * 1.7)) * 0.08;
    float riser = smoothstep(0.0, 0.1, t + rag);
    float tread = riser * (1.0 - 0.6 * t);
    // Thin stacked sheets inside each band, each ending in a dark crease
    float m = fract(L * 3.0 + rag * 2.0);
    float layer = smoothstep(0.0, 0.2, m) * (1.0 - 0.6 * m);
    float crease = 1.0 - smoothstep(0.0, 0.08, m);

    // Lava slots: lens-shaped openings along some risers, widest in the middle of each lens
    float openN = snoise(p * 1.6 + vec3(band * 2.31, band * 0.7, 0.0)) * 0.5 + 0.5;
    float open = smoothstep(mix(0.45, 0.62, uCrust), 0.9, openN) * step(0.35, bandH) * (0.75 + 0.5 * riftBoost);
    float gapW = mix(0.42, 0.26, uCrust) * open;
    float gapMask = (1.0 - smoothstep(gapW * 0.45, gapW + 0.02, t + rag * 0.4)) * smoothstep(0.02, 0.2, open);

    vec3 vc = voronoi3D(p * 3.4);
    float crack = (1.0 - smoothstep(0.0, 0.01, vc.x)) * riser;

    float h = 0.1 + macroBoulder * 0.5 + tread * (0.56 + (bandH - 0.5) * 0.14) + layer * 0.15 * riser - crease * 0.06 * riser
      - crack * 0.07 + rockGrain * 0.7 * riser - scoriaPores * 0.6 * riser - gapMask * 0.3;
    height = clamp(h, 0.0, 1.0);
    crustMask = clamp((1.0 - gapMask) * (1.0 - crack * 0.35), 0.0, 1.0);
    heat = clamp(gapMask * (0.95 + 0.3 * open) + (1.0 - riser) * (0.06 + 0.2 * smoothstep(0.3, 0.7, openN)) + crack * 0.35 * smoothstep(0.3, 0.7, openN), 0.0, 1.25);
    // White-yellow core in the widest part of each slot
    heat += gapMask * (1.0 - smoothstep(0.0, gapW * 0.35, t)) * smoothstep(0.4, 0.9, open) * 0.4;
    plateId = clamp(0.25 + 0.35 * bandH + 0.4 * layer * riser, 0.0, 1.0);

  } else if (uStyle == 5) {
    // Shard Scales: long straight glass blades laid like scales along a slow swirl, each lifted at one end with
    // its tail sunk in the molten light welling between them
    vec3 p = advDir * (s * 3.3) + uSeedOff;
    vec3 tdir = grainDir(normalize(advDir), p * 0.3);
    vec3 v = voronoiAniso(p, tdir, 4.0);
    vec3 r = gVorR;
    vec3 side = normalize(cross(advDir, tdir));
    float along = dot(-r, tdir) / 1.8;
    float across = dot(-r, side);
    float gap = mix(0.1, 0.03, uCrust);
    float edge = smoothstep(gap * 0.5, gap + 0.035, v.x);
    float lift = clamp(0.5 + along * 0.85, 0.0, 1.0);
    // Faceted roof: a sharp spine down the blade with flat bevels either side
    float ridge = 1.0 - min(abs(across) * 2.6, 1.0);
    float shard = edge * (0.34 + 0.5 * lift + 0.1 * ridge + (v.z - 0.5) * 0.14);
    float crackle = 1.0 - smoothstep(0.0, 0.02, voronoi3D(p * 2.6 + vec3(4.2, 1.3, 7.7)).x);
    height = clamp(0.06 + macroBoulder * 0.3 + shard - crackle * edge * 0.015, 0.0, 1.0);
    float tail = 1.0 - smoothstep(0.0, 0.09, lift);
    crustMask = clamp(smoothstep(gap * 0.3, gap * 0.9, v.x) * (1.0 - tail * 0.45), 0.0, 1.0);
    float molten = 1.0 - crustMask;
    // Lava: dark crackle lines in the pool, a white-yellow core along the narrowest gaps
    heat = clamp(molten * mix(0.66, 1.08, 1.0 - smoothstep(0.0, gap * 0.8, v.x)) * (1.0 - crackle * 0.5), 0.0, 1.25);
    heat += (1.0 - smoothstep(0.0, gap * 0.3, v.x)) * 0.4;
    plateId = v.z;
  } else if (uStyle == 6) {
    // Strata Plates: big slabs of layered basalt whose edges step down in stacked ledges to thin hot cracks
    vec3 p = advDir * (s * 1.45) + uSeedOff;
    vec3 jag = vec3(fbm4(p * 1.6), fbm4(p * 1.6 + 4.1), fbm4(p * 1.6 + 8.7)) * 0.22;
    vec3 v1 = voronoi3D(p + jag);
    vec3 toCentre = gVorR;
    vec3 v2 = voronoi3D(p * 3.0 + jag * 2.0 + vec3(2.3, 6.7, 4.1));
    // Where the flow stretched the pattern, narrow the cracks so they stay hairlines on the surface
    float stretch = sqrt((dot(dFdx(advDir), dFdx(advDir)) + dot(dFdy(advDir), dFdy(advDir))) /
                         max(dot(dFdx(dir), dFdx(dir)) + dot(dFdy(dir), dFdy(dir)), 1e-12));
    float open = smoothstep(-0.2, 0.5, fbm4(p * 0.6 + 2.0));
    float gap = mix(0.03, 0.005, uCrust) * (0.45 + 1.6 * open * open) * clamp(stretch, 0.4, 1.0);
    float crack = 1.0 - smoothstep(0.0, gap, v1.x);
    float lip = smoothstep(gap * 0.6, gap * 1.4, v1.x);
    // Stacked ledges climbing from the crack to the slab top, their risers frayed by noise
    float e = max(v1.x - gap + fbm4(p * 4.0 + v1.z * 5.0) * 0.035, 0.0) / 0.022;
    float ledge = min(floor(e) + smoothstep(0.0, 0.6, fract(e)), 3.0) / 3.0;
    vec3 tiltAxis = normalize(hash33(vec3(v1.z * 71.3, v1.z * 17.9, v1.z * 37.1)) - 0.5);
    float top = 0.5 + (v1.z - 0.5) * 0.22 + dot(toCentre, tiltAxis) * 0.24;
    // Fine laminations across the slab faces
    float L = (dot(advDir * (s * 2.0), tiltAxis) + fbm4(p * 1.1) * 0.6) * 26.0;
    float lam = smoothstep(0.0, 0.2, fract(L)) * (1.0 - fract(L) * 0.5);
    float sub = (1.0 - smoothstep(0.0, 0.008, v2.x)) * lip * smoothstep(0.05, 0.3, fbm4(p * 0.9 + 5.0));
    float slab = top * (0.45 + 0.55 * ledge) + 0.06 * smoothstep(0.0, 0.3, v1.x) + lam * 0.01 * ledge;
    height = clamp(0.1 + macroBoulder * 0.5 + slab - sub * 0.06 + rockGrain * 0.5 * lip, 0.0, 1.0);
    crustMask = clamp(lip * (1.0 - sub * 0.5), 0.0, 1.0);
    heat = clamp(crack * (0.95 + 0.25 * open) + sub * mix(0.6, 0.3, uCrust) + (1.0 - lip) * 0.15, 0.0, 1.25);
    heat += (1.0 - smoothstep(0.0, gap * 0.35, v1.x)) * (0.3 + 0.2 * open);
    plateId = clamp(v1.z * 0.6 + ledge * 0.25 + lam * 0.15, 0.0, 1.0);
  } else if (uStyle == 7) {
    // Charred Grain: split blocks of charcoal-like rock with fine grain lines, cross checks and end-grain
    // rings on some faces, a wide jagged lava rift running through
    vec3 p = advDir * (s * 1.6) + uSeedOff;
    vec3 jag = vec3(fbm4(p * 1.4), fbm4(p * 1.4 + 4.1), fbm4(p * 1.4 + 8.7)) * 0.3;
    vec3 v1 = voronoi3D(p + jag);
    vec3 c = gVorR;
    vec3 gdir = normalize(hash33(vec3(v1.z * 53.1, v1.z * 29.7, v1.z * 11.3)) - 0.5);
    vec3 side = normalize(cross(unitDir, gdir) + 1e-5);
    vec3 q = advDir * (s * 2.0);
    float warp = fbm4(q * 2.2 + v1.z * 7.0) * 3.5;
    // Long grain: thin sharp grooves between wide flat ridges, a finer grain between them
    float grain = dot(q, gdir) * 85.0 + warp * 1.3;
    float groove = smoothstep(0.0, 0.3, abs(sin(grain))) * (0.85 + 0.15 * smoothstep(0.0, 0.5, abs(sin(grain * 2.7 + warp))));
    // End grain on some blocks: rings around the block's own centre
    float endGrain = step(0.68, fract(v1.z * 5.3));
    float rr = length(c - unitDir * dot(c, unitDir));
    float ring = smoothstep(0.0, 0.35, abs(sin(rr * 70.0 + warp * 0.8)));
    groove = mix(groove, ring, endGrain);
    // Checks: short cracks across the grain
    float checks = (1.0 - smoothstep(0.0, 0.06, abs(sin(dot(q, side) * 16.0 + warp)))) * smoothstep(-0.05, 0.2, fbm4(q * 3.0 + 1.3)) * (1.0 - endGrain);
    float open = smoothstep(-0.2, 0.4, fbm4(p * 0.5 + 7.7));
    float gap = mix(0.05, 0.009, uCrust) * (0.3 + 3.2 * open * open);
    float rift = 1.0 - smoothstep(0.0, gap, v1.x);
    float lip = smoothstep(gap * 0.6, gap * 1.3, v1.x);
    float bevel = smoothstep(gap * 0.5, gap + 0.03, v1.x);
    float split = (1.0 - smoothstep(0.0, 0.03, abs(sin(grain * 0.25 + v1.z * 9.0)))) * step(0.82, fract(v1.z * 17.3)) * bevel;
    vec3 tiltAxis = normalize(hash33(vec3(v1.z * 19.7, v1.z * 61.3, v1.z * 7.9)) - 0.5);
    float block = sqrt(bevel) * (0.58 + (v1.z - 0.5) * 0.24 + dot(c, tiltAxis) * 0.3);
    // Chipped, uneven block faces
    float chunk = fbm4(p * 3.0 + v1.z * 13.0) * 0.05 * bevel;
    height = clamp(0.06 + macroBoulder * 0.4 + block + chunk - (1.0 - groove) * 0.035 * bevel - checks * 0.07 * bevel - split * 0.06, 0.0, 1.0);
    // Charred flakes drifting in the wide parts of the rift
    float flakes = smoothstep(0.56, 0.66, fbm4(p * 5.0 + 3.1) * 0.5 + 0.5) * rift * open;
    crustMask = clamp(max(lip * (1.0 - split * 0.7), flakes), 0.0, 1.0);
    heat = clamp(rift * (0.85 + 0.3 * open) * (1.0 - flakes * 0.7) + split * 0.6 + checks * 0.12 * open + (1.0 - bevel) * 0.2, 0.0, 1.25);
    heat += (1.0 - smoothstep(0.0, gap * 0.25, v1.x)) * 0.2 * open;
    plateId = clamp((0.35 + 0.65 * groove) * (1.0 - checks * 0.6) * (0.75 + 0.25 * v1.z), 0.0, 1.0);
  } else if (uStyle == 8) {
    // Ropy Strands: bundles of fibrous crust ropes drawn out along the flow, fanning and pinching; thin lava
    // threads run between some of the bundles
    vec3 axis = normalize(sin(uSeedOff * 1.7) + vec3(0.0, 0.6, 0.0));
    vec3 b1 = normalize(cross(axis, vec3(0.31, 0.83, 0.47)));
    vec3 b2 = cross(axis, b1);
    vec2 ar = vec2(dot(advDir, b1), dot(advDir, b2));
    float rad = length(ar) + 1e-4;
    vec2 around = ar / rad;
    float lat = dot(advDir, axis);
    // Bundles: latitude warped slowly so they fan apart and pinch together along their length
    vec3 wq = vec3(around * 1.2, lat * 1.6) + uSeedOff * 0.1;
    float g = (lat + snoise(wq) * 0.2 + snoise(wq * 2.4 + 3.1) * 0.06) * (3.6 * s);
    float bid = floor(g);
    float bk = fract(g);
    float bh = fract(sin(bid * 12.9898 + 78.233) * 43758.5453);
    float edgeW = sin(3.14159 * bk);
    // Ropes inside a bundle, braided by a wave along the length that vanishes at the bundle's edges
    float braid = snoise(vec3(around * 2.5 * s, bid * 1.3)) * 0.45 * edgeW;
    float f = bk * floor(3.0 + bh * 3.0) + braid;
    float k = fract(f);
    float rid = floor(f) + bid * 11.0;
    float rh = fract(sin(rid * 39.346 + 11.135) * 43758.5453);
    float rope = sqrt(max(sin(3.14159 * k), 0.0));
    float dome = pow(edgeW, 0.35);
    // Bark: fibres stretched along each rope, crossed by short transverse checks
    vec2 al = around * rad * s;
    float fA = snoise(vec3(f * 5.0, al * 18.0));
    float fB = snoise(vec3(f * 13.0 + 7.0, al * 45.0));
    float bark = 0.5 + 0.35 * fA + 0.15 * fB;
    float check = smoothstep(0.9, 0.99, 1.0 - abs(snoise(vec3(f * 0.8 + rid * 3.1, al * 35.0))));
    height = clamp(0.08 + macroBoulder * 0.35 + dome * 0.18 + rope * (0.42 + rh * 0.1) + (bark - 0.5) * 0.3 * rope - check * 0.08 * rope + rockGrain * 0.3, 0.0, 1.0);
    // Lava between bundles, opening and closing along the seam
    float bnd = bk < 0.5 ? bid : bid + 1.0;
    float bnh = fract(sin(bnd * 12.9898 + 78.233) * 43758.5453);
    float open = step(mix(0.2, 0.5, uCrust), fract(bnh * 7.13)) * smoothstep(-0.3, 0.1, snoise(vec3(around * 1.6 * s, bnd * 0.7) + uSeedOff * 0.2));
    float db = min(bk, 1.0 - bk);
    float gapW = mix(0.055, 0.028, uCrust) * (0.7 + 0.6 * bnh);
    float gap = (1.0 - smoothstep(0.0, gapW, db)) * open;
    float core = (1.0 - smoothstep(0.0, gapW * 0.6, db)) * open;
    // A few grooves between ropes glow dimly deep down
    float groove = (1.0 - smoothstep(0.0, 0.09, min(k, 1.0 - k))) * step(0.78, fract(rh * 5.3)) * edgeW;
    crustMask = clamp(1.0 - gap, 0.0, 1.0);
    heat = clamp(gap * 1.1 + core * 0.45 + (1.0 - smoothstep(0.0, gapW * 2.2, db)) * open * 0.2 + groove * 0.6, 0.0, 1.5);
    plateId = clamp(0.2 + 0.45 * bark + 0.25 * rh - check * 0.2, 0.0, 1.0);
  } else {
    // Marbled Glass: fire marbled through clear glass. A twice-warped field folds into ribbons: black voids,
    // a deep red body streaked along its isolines, bright flame ribbons with hot filaments
    vec3 q = advDir * (s * 1.1) + uSeedOff;
    vec3 w = vec3(fbm4(q * 0.9), fbm4(q * 0.9 + 5.2), fbm4(q * 0.9 + 9.7));
    float m = fbm4(q * 1.3 + w * 4.0);
    float m2 = fbm4(q * 2.7 + w * 5.0 + 3.3);
    float streak = sin((m * 8.0 + m2 * 1.5) * 6.2831853) * 0.5 + 0.5;
    float fine = sin((m * 24.0 + w.x * 4.0) * 6.2831853) * 0.5 + 0.5;
    float flame = smoothstep(0.1, 0.34, m + m2 * 0.3);
    flame *= flame;
    float voidMask = smoothstep(0.0, -0.14, m - m2 * 0.2);
    float t = 0.1 + 0.07 * streak;
    t = mix(t, 0.42 + 0.22 * streak + 0.32 * pow(fine, 6.0), flame);
    height = 0.5;
    crustMask = voidMask;
    heat = clamp(t * mix(1.0, 0.12, voidMask), 0.0, 1.5);
    plateId = streak;
  }

  // One of four sub-texel samples, summed by additive blending
  outColor = vec4(height, heat, crustMask, plateId) * 0.25;
}
`;

// Pass 2: 8-tap Sobel Tangent-Space Normal Map + Multi-Radius Baked AO
const BAKE_NORMAL_AO_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uHeightMap;
uniform vec2 uTexel;
uniform float uNormalStrength;
uniform float uAoRadius;

void main() {
  float hTL = texture(uHeightMap, vUv + vec2(-uTexel.x,  uTexel.y)).r;
  float hT  = texture(uHeightMap, vUv + vec2( 0.0,       uTexel.y)).r;
  float hTR = texture(uHeightMap, vUv + vec2( uTexel.x,  uTexel.y)).r;
  float hL  = texture(uHeightMap, vUv + vec2(-uTexel.x,  0.0     )).r;
  float hC  = texture(uHeightMap, vUv).r;
  float hR  = texture(uHeightMap, vUv + vec2( uTexel.x,  0.0     )).r;
  float hBL = texture(uHeightMap, vUv + vec2(-uTexel.x, -uTexel.y)).r;
  float hB  = texture(uHeightMap, vUv + vec2( 0.0,      -uTexel.y)).r;
  float hBR = texture(uHeightMap, vUv + vec2( uTexel.x, -uTexel.y)).r;

  float dX = (hTR + 2.0 * hR + hBR) - (hTL + 2.0 * hL + hBL);
  float dY = (hTL + 2.0 * hT + hTR) - (hBL + 2.0 * hB + hBR);

  vec3 n = normalize(vec3(-dX * uNormalStrength, -dY * uNormalStrength, 1.0));

  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    vec2 dir = vec2(cos(ang), sin(ang)) * uTexel;
    float h1 = texture(uHeightMap, vUv + dir * 3.0 * uAoRadius).r;
    float h2 = texture(uHeightMap, vUv + dir * 8.0 * uAoRadius).r;
    occ += max(0.0, h1 - hC) * 1.45 + max(0.0, h2 - hC) * 0.95;
  }
  float ao = clamp(1.0 - occ * 1.15, 0.12, 1.0);

  outColor = vec4(n * 0.5 + 0.5, ao);
}
`;

// Pass 3: Mesh info read back for the mesh worker, at half the atlas resolution:
// R = mean height, G = mean heat over the texel's footprint
const BAKE_MESH_INFO_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uHeightMap;
uniform vec2 uInfoTexel;
void main() {
  vec2 hh = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) / 4.0;
      hh += textureLod(uHeightMap, vUv + o * uInfoTexel, 0.0).rg;
    }
  }
  hh /= 16.0;
  outColor = vec4(clamp(hh.x, 0.0, 1.0), clamp(hh.y, 0.0, 1.0), 0.0, 1.0);
}
`;

// Pass 5: Bake 3x2 cube-face tangent-space Flow Map for live swirling liquid magma advection!
// Combines the Navier-Stokes fluid velocity field (projected onto each face's tangent basis)
// with the channel-parallel rotated height gradient so lava flows along fissures AND swirls in open pools.
const BAKE_FLOW_MAP_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor; // RG = tangent-space flow dir (0..1), B = speed, A = phase jitter

uniform sampler2D uSimVel;
uniform sampler2D uHeightMap;
uniform vec2 uTexel;
uniform float uPad;
uniform int uShapeMode;
#ifdef MESH_FRAME
// Suzanne: drawn from her mesh in atlas space, so the frame comes from it
in vec3 vPos;
in vec3 vNrm;
in vec4 vTan;
#endif

vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    n.xy = (1.0 - abs(n.yx)) * s;
  }
  return n.xy * 0.5 + 0.5;
}

vec3 octDecode(vec2 uv) {
  vec2 f = uv * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = clamp(-n.z, 0.0, 1.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

// Twisted ring surface; must match twistedRingPos in meshData.js
vec3 twistedRingPos(vec2 uv) {
  float phi = uv.x * 6.2831853;
  float theta = uv.y * 6.2831853;
  float rho = 0.42 * (1.0 + 0.22 * cos(3.0 * (theta - phi)));
  float radial = 0.95 + rho * cos(theta);
  return vec3(radial * cos(phi), radial * sin(phi), rho * sin(theta));
}


vec3 tubePos(int mode, vec2 uv) {
  return twistedRingPos(uv);
}

void atlasUVToFrame(vec2 uv, out vec3 dir, out vec3 T, out vec3 B) {
  vec2 g = uv * vec2(3.0, 2.0);
  int col = clamp(int(floor(g.x)), 0, 2);
  int row = clamp(int(floor(g.y)), 0, 1);
  int face = row * 3 + col;
  vec2 local = fract(g);
  vec2 fuv = (local - uPad) / (1.0 - 2.0 * uPad);
  vec2 st = fuv * 2.0 - 1.0;

  vec3 c, dU, dV;
  if (face == 0)      { c = vec3( 1.0,  st.y, -st.x); dU = vec3( 0.0, 0.0, -1.0); dV = vec3(0.0, 1.0, 0.0); }
  else if (face == 1) { c = vec3(-1.0,  st.y,  st.x); dU = vec3( 0.0, 0.0,  1.0); dV = vec3(0.0, 1.0, 0.0); }
  else if (face == 2) { c = vec3( st.x,  1.0, -st.y); dU = vec3( 1.0, 0.0,  0.0); dV = vec3(0.0, 0.0, -1.0); }
  else if (face == 3) { c = vec3( st.x, -1.0,  st.y); dU = vec3( 1.0, 0.0,  0.0); dV = vec3(0.0, 0.0,  1.0); }
  else if (face == 4) { c = vec3( st.x,  st.y,  1.0); dU = vec3( 1.0, 0.0,  0.0); dV = vec3(0.0, 1.0, 0.0); }
  else                { c = vec3(-st.x,  st.y, -1.0); dU = vec3(-1.0, 0.0,  0.0); dV = vec3(0.0, 1.0, 0.0); }

  vec3 c2 = c * c;
  vec3 s;
  s.x = c.x * sqrt(max(0.0, 1.0 - c2.y * 0.5 - c2.z * 0.5 + (c2.y * c2.z) / 3.0));
  s.y = c.y * sqrt(max(0.0, 1.0 - c2.z * 0.5 - c2.x * 0.5 + (c2.z * c2.x) / 3.0));
  s.z = c.z * sqrt(max(0.0, 1.0 - c2.x * 0.5 - c2.y * 0.5 + (c2.x * c2.y) / 3.0));
  dir = normalize(s);
  T = normalize(dU - dir * dot(dU, dir));
  B = normalize(cross(dir, T));
  if (dot(B, dV) < 0.0) B = -B;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 trefoilCenterFlow(float t) {
  float c2 = cos(2.0 * t);
  float s2 = sin(2.0 * t);
  float c3 = cos(3.0 * t);
  float s3 = sin(3.0 * t);
  return vec3((2.0 + c3) * c2, (2.0 + c3) * s2, s3) * 0.46;
}

void main() {
  vec3 dir, T, B;
#ifdef MESH_FRAME
  // Her mesh's frame, as the mesh worker gives it to the rendered mesh
  dir = normalize(vPos);
  vec3 nrm = normalize(vNrm);
  T = normalize(vTan.xyz - nrm * dot(vTan.xyz, nrm));
  B = cross(nrm, T) * vTan.w;
#else
  if (uShapeMode == 0) {
    atlasUVToFrame(vUv, dir, T, B);
  } else if (uShapeMode == 1) {
    float phi = vUv.x * 6.2831853;
    float theta = vUv.y * 6.2831853;
    float cp = cos(phi), sp = sin(phi), ct = cos(theta), st = sin(theta);
    vec3 pos = vec3((0.98 + 0.44 * ct) * cp, (0.98 + 0.44 * ct) * sp, 0.44 * st);
    dir = normalize(pos);
    T = normalize(vec3(-sp, cp, 0.0));
    B = normalize(vec3(-st * cp, -st * sp, ct));
  } else if (uShapeMode >= 3) {
    vec3 pos = tubePos(uShapeMode, vUv);
    dir = normalize(pos);
    T = normalize(tubePos(uShapeMode, vUv + vec2(0.002, 0.0)) - tubePos(uShapeMode, vUv - vec2(0.002, 0.0)) + 1e-6);
    B = tubePos(uShapeMode, vUv + vec2(0.0, 0.002)) - tubePos(uShapeMode, vUv - vec2(0.0, 0.002));
    B = normalize(B - T * dot(B, T) + 1e-6);
  } else {
    float phi = vUv.x * 6.2831853;
    float theta = -vUv.y * 6.2831853;
    vec3 c = trefoilCenterFlow(phi);
    vec3 tanV = normalize(trefoilCenterFlow(phi + 0.002) - trefoilCenterFlow(phi - 0.002));
    vec3 binorm = normalize(cross(tanV, normalize(c)));
    vec3 normV = normalize(cross(binorm, tanV));
    float ct = cos(theta), st = sin(theta);
    vec3 pos = c + (normV * ct + binorm * st) * 0.30;
    dir = normalize(pos);
    T = tanV;
    B = normalize(normV * st - binorm * ct);
  }
#endif

  // Project octahedral Navier-Stokes velocity onto the surface's seamless tangent basis (T, B)
  vec2 octUv = octEncode(dir);
  vec2 simV = texture(uSimVel, octUv).xy;
  vec3 dOctU = normalize(octDecode(clamp(octUv + vec2(0.004, 0.0), 0.0, 1.0)) - dir + 1e-6);
  vec3 dOctV = normalize(octDecode(clamp(octUv + vec2(0.0, 0.004), 0.0, 1.0)) - dir + 1e-6);
  vec3 vel3D = dOctU * simV.x + dOctV * simV.y;
  vec2 nsFlow = vec2(dot(vel3D, T), dot(vel3D, B));

  // Channel-parallel tangent from rotated height gradient (keeps flow streaming smoothly along cracks!)
  vec2 step = uTexel * 4.0;
  float hL = texture(uHeightMap, vUv - vec2(step.x, 0.0)).r;
  float hR = texture(uHeightMap, vUv + vec2(step.x, 0.0)).r;
  float hB = texture(uHeightMap, vUv - vec2(0.0, step.y)).r;
  float hT = texture(uHeightMap, vUv + vec2(0.0, step.y)).r;
  vec2 grad = vec2(hR - hL, hT - hB);
  vec2 channelTan = vec2(-grad.y, grad.x);
  // Orient channel tangent consistently with Navier-Stokes flow so neighboring fissures never fight
  if (dot(channelTan, nsFlow) < 0.0) channelTan = -channelTan;

  vec2 flow = nsFlow * 2.2 + channelTan * 2.6;
  // Guarantee strong, smooth, coherent swirling flow everywhere in molten pools
  float spd = length(flow);
  if (spd < 0.25) {
    vec2 fallback = normalize(vec2(dir.z - dir.y * 0.5, -dir.x + dir.z * 0.3) + 1e-4);
    flow = mix(fallback * 0.55, flow, spd / 0.25);
    spd = length(flow);
  }
  vec2 flowDir = flow / max(spd, 1e-4);
  float normSpd = clamp(spd * 0.85, 0.45, 1.0);
  // Smooth low-frequency spatial phase (NOT per-pixel white noise!) so waves travel coherently without static!
  float smoothPhase = 0.5 + 0.5 * sin(dir.x * 3.1 + dir.y * 2.7 + dir.z * 3.5);

  outColor = vec4(flowDir * 0.5 + 0.5, normSpd, smoothPhase);
}
`;

// Pass 6 (once at startup): Seamless periodic 512x512 grayscale turbulence noise texture for flow-map lava advection
const BAKE_TILE_NOISE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// Periodic 2D value-noise hash so the texture tiles 100% seamlessly in U and V
float hash21p(vec2 p, vec2 period) {
  p = mod(p, period);
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float pnoise(vec2 uv, float freq) {
  vec2 period = vec2(freq);
  vec2 p = uv * period;
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21p(i + vec2(0.0, 0.0), period);
  float b = hash21p(i + vec2(1.0, 0.0), period);
  float c = hash21p(i + vec2(0.0, 1.0), period);
  float d = hash21p(i + vec2(1.0, 1.0), period);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float pfbm(vec2 uv, float baseFreq) {
  float f = 0.0;
  float amp = 0.55;
  float freq = baseFreq;
  for (int i = 0; i < 3; i++) {
    f += amp * pnoise(uv, freq);
    freq *= 2.0;
    amp *= 0.45;
  }
  return f;
}

void main() {
  // Low-frequency smooth domain-warped periodic grayscale billows (reads clearly as rolling thermal waves!)
  vec2 w = vec2(pfbm(vUv + vec2(0.17, 0.43), 2.0), pfbm(vUv + vec2(0.61, 0.29), 2.0)) - 0.5;
  float billow = pfbm(vUv + w * 0.32, 2.0);
  float ridge = 1.0 - abs(pfbm(vUv + w * 0.45, 3.0) * 2.0 - 1.0);
  ridge = pow(clamp(ridge, 0.0, 1.0), 1.4);
  float grain = pfbm(vUv, 6.0);
  outColor = vec4(billow, ridge, grain, 1.0);
}
`;

const STYLE_COUNT = 10;

class MagmaTextureBaker {
  constructor(renderer, fluid, faceSize = 768) {
    this.renderer = renderer;
    this.fluid = fluid;
    this.faceSize = faceSize;
    this.padFraction = Math.ceil(12 * faceSize / 768) / faceSize;
    const width = faceSize * 3;
    const height = faceSize * 2;

    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    const rtOpts = (type, mipmaps = false) => ({
      type,
      format: RGBAFormat,
      minFilter: mipmaps ? LinearMipmapLinearFilter : LinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      colorSpace: NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mipmaps,
    });

    this.heightHeatRT = new WebGLRenderTarget(width, height, rtOpts(HalfFloatType, true));
    this.normalAoRT = new WebGLRenderTarget(width, height, rtOpts(UnsignedByteType, true));
    this.flowRT = new WebGLRenderTarget(Math.floor(width / 2), Math.floor(height / 2), rtOpts(UnsignedByteType, true));
    this.noiseRT = new WebGLRenderTarget(512, 512, rtOpts(UnsignedByteType, true));
    this.infoWidth = width / 2;
    this.infoHeight = height / 2;
    this.infoRT = new WebGLRenderTarget(this.infoWidth, this.infoHeight, rtOpts(UnsignedByteType, false));
    this.infoPixels = new Uint8Array(this.infoWidth * this.infoHeight * 4);
    this.flowPixels = new Uint8Array(this.infoWidth * this.infoHeight * 4);
    this.serial = 0;
    // Allocated with their mip chains up front: bands render with mipmap generation off (_runBand)
    renderer.initRenderTarget(this.heightHeatRT);
    renderer.initRenderTarget(this.normalAoRT);
    this.ready = Promise.resolve(true);

    const texel = new Vector2(1 / width, 1 / height);

    const heightUniforms = {
      uFrame: { value: null },
      uFrameY0: { value: 0 },
      uSimCoord: { value: fluid.coordTexture },
      uShapeMode: { value: 0 },
      uCrust: { value: 0.72 },
      uScale: { value: 1.2 },
      uFluidFlow: { value: 0.58 },
      uPad: { value: this.padFraction },
      uSeedOff: { value: new Vector3(1.7, 3.1, 2.3) },
      uJitter: { value: new Vector2() },
      uOne: { value: 1 },
      uFour: { value: 4 },
    };
    this.styleIndex = 0;
    this.heightMats = Array.from({ length: STYLE_COUNT }, (_, style) => new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: `#define uStyle ${style}\n` + BAKE_SOLID_FROM_FLUID_FS,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      uniforms: heightUniforms,
    }));

    this.normalMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: BAKE_NORMAL_AO_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uHeightMap: { value: this.heightHeatRT.texture },
        uTexel: { value: texel },
        uNormalStrength: { value: 6.2 },
        uAoRadius: { value: faceSize / 768 },
      },
    });

    this.infoMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: BAKE_MESH_INFO_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uHeightMap: { value: this.heightHeatRT.texture },
        uInfoTexel: { value: new Vector2(1 / this.infoWidth, 1 / this.infoHeight) },
      },
    });

    this.flowMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: BAKE_FLOW_MAP_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSimVel: { value: fluid.velocityTexture },
        uHeightMap: { value: this.heightHeatRT.texture },
        uTexel: { value: texel },
        uPad: { value: this.padFraction },
        uShapeMode: { value: 0 },
      },
    });

    // Suzanne (shape mode 5): her surface rasterised band by band (setSuzanneMesh), and her flow pass
    this.bands = faceSize >= 1024 ? 6 : 4;
    this.frameMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FRAME_VS,
      fragmentShader: FRAME_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: { uBand: { value: new Vector3() }, uJitter: { value: new Vector2() } },
    });
    this.meshFlowMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: MESH_FLOW_VS,
      fragmentShader: "#define MESH_FRAME\n" + BAKE_FLOW_MAP_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: this.flowMat.uniforms,
    });

    this.noiseMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: BAKE_TILE_NOISE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this._run(this.noiseMat, this.noiseRT);
  }

  get heightMat() {
    return this.heightMats[this.styleIndex];
  }

  // The programs a bake of this style needs; the other styles' height programs can compile later
  materialsFor(style) {
    return [this.heightMats[style], this.normalMat, this.infoMat, this.flowMat, this.frameMat, this.meshFlowMat];
  }

  get heightHeatTexture() { return this.heightHeatRT.texture; }
  get normalAoTexture() { return this.normalAoRT.texture; }

  // Suzanne's atlas-space geometry (MeshBuilder.setSuzanne): her charts, and skirts that run them on into the gutters
  setSuzanneMesh(geometry) {
    this.suzanne = new Mesh(geometry, this.frameMat);
    this.suzanne.frustumCulled = false;
    this.suzanneScene = new Scene();
    this.suzanneScene.add(this.suzanne);
  }

  // Allocated on her first bake, so other shapes don't pay for it
  get frameRT() {
    this._frameRT ||= new WebGLRenderTarget(this.heightHeatRT.width, Math.ceil(this.heightHeatRT.height / this.bands) + 1, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    return this._frameRT;
  }

  // Draws her mesh into target with mat, cleared first to (clear, clear, clear, alpha)
  _drawSuzanne(mat, target, clear, alpha) {
    const prev = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.suzanne.material = mat;
    const autoClear = this.renderer.autoClear;
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(new Color(clear, clear, clear), alpha);
    this.renderer.clear(true, false, false);
    this.renderer.autoClear = false;
    this.renderer.render(this.suzanneScene, this.camera);
    this.renderer.autoClear = autoClear;
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setRenderTarget(prev);
  }

  get flowTexture() { return this.flowRT.texture; }
  get noiseTexture() { return this.noiseRT.texture; }

  _run(mat, target) {
    const prev = this.renderer.getRenderTarget();
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  bake(opts, readInfo = true) {
    for (const _ of this.bakeSteps(opts, readInfo));
  }

  // The bake in slices (yields between them), so it can be spread over frames while the rock is hidden.
  // this.ready resolves to true once infoPixels and flowPixels hold this bake's data (read back asynchronously),
  // or to false when a newer bake replaced it.
  bakeSteps(opts, readInfo = true) {
    const serial = readInfo ? ++this.serial : this.serial;
    if (readInfo) {
      this._resolveReady?.(false);
      this.ready = new Promise((resolve) => (this._resolveReady = resolve));
    }
    return this._bakeSteps(opts, readInfo, serial);
  }

  *_bakeSteps({ styleIndex, shapeMode = 0, crust, scale, fluidFlow, relief, seed }, readInfo, serial) {
    const rng = seededRandom(`solid-bake:${seed}`);
    this.heightMat.uniforms.uSimCoord.value = this.fluid.coordTexture;
    this.styleIndex = styleIndex;
    this.heightMat.uniforms.uShapeMode.value = shapeMode;
    this.heightMat.uniforms.uCrust.value = crust;
    this.heightMat.uniforms.uScale.value = scale;
    this.heightMat.uniforms.uFluidFlow.value = fluidFlow;
    this.heightMat.uniforms.uSeedOff.value.set(
      (rng() - 0.5) * 24,
      (rng() - 0.5) * 24,
      (rng() - 0.5) * 24,
    );

    this.normalMat.uniforms.uNormalStrength.value = (3.8 + relief * 5.6) * (this.faceSize / 768);
    this.flowMat.uniforms.uSimVel.value = this.fluid.velocityTexture;
    this.flowMat.uniforms.uShapeMode.value = shapeMode;

    // Supersampled: four rotated-grid sub-texel samples, so sharp crack edges don't alias
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.heightHeatRT);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setRenderTarget(prevTarget);
    const bands = this.bands;
    const mesh = shapeMode === 5 && this.suzanne;
    if (!mesh && this._frameRT) {
      this._frameRT.dispose();
      this._frameRT = null;
      this.heightMat.uniforms.uFrame.value = null;
    }
    const jitters = [[0.125, 0.375], [0.375, -0.125], [-0.125, -0.375], [-0.375, 0.125]];
    for (let k = 0; k < jitters.length; k++) {
      const [jx, jy] = jitters[k];
      for (let b = 0; b < bands; b++) {
        this.heightMat.uniforms.uJitter.value.set(jx / this.heightHeatRT.width, jy / this.heightHeatRT.height);
        if (mesh) {
          const y0 = Math.round((b * this.heightHeatRT.height) / bands);
          this.frameMat.uniforms.uBand.value.set(y0, this.frameRT.height, this.heightHeatRT.height);
          this.frameMat.uniforms.uJitter.value.copy(this.heightMat.uniforms.uJitter.value);
          this._drawSuzanne(this.frameMat, this.frameRT, 0, 0);
          this.heightMat.uniforms.uFrame.value = this.frameRT.texture;
          this.heightMat.uniforms.uFrameY0.value = y0;
        }
        const autoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this._runBand(this.heightMat, this.heightHeatRT, b, bands, k === jitters.length - 1 && b === bands - 1);
        this.renderer.autoClear = autoClear;
        yield;
      }
    }
    for (let b = 0; b < bands; b++) {
      this._runBand(this.normalMat, this.normalAoRT, b, bands, b === bands - 1);
      yield;
    }
    // Alpha 1: three premultiplies the clear colour, and 0.5 is zero flow
    if (mesh) this._drawSuzanne(this.meshFlowMat, this.flowRT, 0.5, 1);
    else this._run(this.flowMat, this.flowRT);

    if (readInfo) {
      yield;
      this._run(this.infoMat, this.infoRT);
      const info = new Uint8Array(this.infoWidth * this.infoHeight * 4);
      const flow = new Uint8Array(this.infoWidth * this.infoHeight * 4);
      const resolve = this._resolveReady;
      Promise.all([
        this.renderer.readRenderTargetPixelsAsync(this.infoRT, 0, 0, this.infoWidth, this.infoHeight, info),
        this.renderer.readRenderTargetPixelsAsync(this.flowRT, 0, 0, this.infoWidth, this.infoHeight, flow),
      ]).then(() => {
        if (serial !== this.serial) return;
        this.infoPixels = info;
        this.flowPixels = flow;
        resolve(true);
      });
    }
  }

  // One horizontal band of a full-target pass; mipmaps only after the last one
  _runBand(mat, target, band, bands, last) {
    const h = target.height;
    const y0 = Math.round((band * h) / bands), y1 = Math.round(((band + 1) * h) / bands);
    target.scissor.set(0, y0, target.width, y1 - y0);
    target.scissorTest = true;
    target.texture.generateMipmaps = last;
    this._run(mat, target);
    target.scissorTest = false;
    target.texture.generateMipmaps = true;
  }
}

export { MagmaTextureBaker };
