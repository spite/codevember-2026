import { Color, DataTexture, RGBAFormat, FloatType, NearestFilter, Vector4 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { R, RF, RC, DIAL_GAP, SCALE, plateField, angle } from "./layout.js";
import { MOTIFS } from "./motifs.js";

export const MAX_PLATES = 128;
export const MAX_CIRCLES = 20;
export const MAX_HOLES = 8;
// Per plate: centre, counts, up to 12 corners, then 12 walls as (normal, h) and (u, side).
const MAX_SIDES = 12;
const DATA_WIDTH = 2 + MAX_SIDES * 3;

// Metal finishes: plates, the inlay in their engraving, turntables, core and carriages.
export const FINISHES = {
  brass: { plate: "#d1aa62", plateRough: 0.32, inlay: "#2a1c0c", inlayMetal: 0.4, inlayRough: 0.75, turntable: "#c9ccd0", turntableRough: 0.24, carriage: "#8a8c92" },
  copper: { plate: "#c97d58", plateRough: 0.3, inlay: "#2a120a", inlayMetal: 0.4, inlayRough: 0.7, turntable: "#d3b06c", turntableRough: 0.26, carriage: "#8c8a88" },
  steel: { plate: "#b9bcc1", plateRough: 0.27, inlay: "#16171a", inlayMetal: 0.5, inlayRough: 0.6, turntable: "#d4ad66", turntableRough: 0.28, carriage: "#9a9ca2" },
  gunmetal: { plate: "#4b4d52", plateRough: 0.34, inlay: "#e0b866", inlayMetal: 1, inlayRough: 0.3, turntable: "#c49a52", turntableRough: 0.26, carriage: "#7a7c82" },
  // Gold lines in the black plates; on the gold dials and turntables the engraving is filled with black, champleve style.
  "black enamel": { plate: "#0b0b0d", plateRough: 0.1, plateMetal: 0, inlay: "#e8bb5e", inlayMetal: 1, inlayRough: 0.22, turntable: "#dcb062", turntableRough: 0.2, carriage: "#2b2b2f", gear: "#c99c4c", partInlay: "#0b0b0d", partInlayMetal: 0, partInlayRough: 0.1 },
  bronze: { plate: "#6a4a2a", plateRough: 0.42, inlay: "#1a1008", inlayMetal: 0.3, inlayRough: 0.8, turntable: "#dcbb72", turntableRough: 0.22, carriage: "#8a8680" },
};

// Bead sets: colours plus a shared roughness and metalness.
export const BEADS = {
  enamel: { colours: ["#a3201b", "#e6dfcb", "#151515", "#1d4c9c"], roughness: 0.18, metalness: 0 },
  jewel: { colours: ["#8a0d24", "#0f5a3a", "#14327a", "#c27a10"], roughness: 0.05, metalness: 0 },
  metal: { colours: ["#f0c060", "#d8dadf", "#d0805a", "#38383c"], roughness: 0.14, metalness: 1 },
  stone: { colours: ["#c8bfae", "#2b2b2d", "#7c3a26", "#5d6b62"], roughness: 0.5, metalness: 0 },
};

const COMMON = /* glsl */ `
#define TAU 6.28318530718
uniform float mechScale;
#define MS mechScale
#define W_CH (0.078 * MS)
#define BEVEL (0.011 * MS)
float machineHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float machineNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(machineHash(i), machineHash(i + vec3(1, 0, 0)), f.x), mix(machineHash(i + vec3(0, 1, 0)), machineHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(machineHash(i + vec3(0, 0, 1)), machineHash(i + vec3(1, 0, 1)), f.x), mix(machineHash(i + vec3(0, 1, 1)), machineHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 machinePerp(vec3 n) {
  return abs(n.x) < 0.8 ? normalize(cross(n, vec3(1.0, 0.0, 0.0))) : normalize(cross(n, vec3(0.0, 1.0, 0.0)));
}
float machineAngle(vec3 a, vec3 b) { return acos(clamp(dot(a, b), -1.0, 1.0)); }
// Gradient of a scalar along the surface, from screen-space derivatives.
vec3 machineSurfGrad(vec3 N, float f) {
  vec3 dpdx = dFdx(vWorldPosition), dpdy = dFdy(vWorldPosition);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  det = abs(det) < 1e-14 ? 1e-14 : det;
  return (dFdx(f) * r1 + dFdy(f) * r2) / det;
}
// Cuts a groove of half width hw around the centreline at distance d: tilts the normal on its walls and
// returns how much of the pixel is inside it, faded out once it gets thinner than a pixel.
float machineGroove(inout Surface s, float d, float hw, float depth) {
  hw = max(hw, 1e-6);
  float fw = max(fwidth(d), 1e-6);
  float vis = smoothstep(1.0, 3.0, hw / fw);
  float x = clamp(d / hw, 0.0, 1.0);
  // The slope comes from d squared, which is smooth through the centreline where d itself has a kink
  // that screen derivatives can't follow: grad h = 3 depth (1 - x) / hw^2 * grad(d^2).
  vec3 g = machineSurfGrad(s.normal, d * d);
  // For a true distance |grad d^2| = 2d; anything steeper is a jump in d, not a slope.
  g *= min(1.0, (3.0 * d + fw) / max(length(g), 1e-9));
  s.normal = normalize(s.normal - depth * 3.0 * (1.0 - x) / (hw * hw) * vis * vis * g);
  // Coverage: a line thinner than a pixel is widened to half a pixel and dimmed to match, so it stays continuous.
  float w = max(hw, fw * 0.5);
  return (1.0 - smoothstep(w * 0.55 - fw * 0.5, w + fw * 0.5, d)) * (hw / w);
}
// A shallow engine-turned pattern of line spacing spacing: fades out well before its lines get close
// enough on screen to beat against the pixels.
// How fast an angle from atan() changes per pixel, ignoring the jump where it wraps: the two readings
// wrap on opposite sides, so one of them is always clean.
float machineAngleWidth(float theta) {
  return min(fwidth(theta), fwidth(mod(theta + TAU, TAU)));
}
// density: lines per pixel, from the continuous phases (derivatives of the folded distance can't be trusted).
float machineTurned(inout Surface s, float fa, float fb, float spacing, float depth, float density) {
  float fade = 1.0 - smoothstep(1.0 / 16.0, 1.0 / 8.0, density);
  float d = min(abs(fract(fa) - 0.5), abs(fract(fb) - 0.5)) * spacing;
  return machineGroove(s, d, spacing * 0.15, depth * fade) * fade;
}
// How much a piece faces sideways (its walls), and their milled finish: fine lines around the piece
// at constant height, faded out before they get too fine for the pixels.
float machineWall() {
  return 1.0 - smoothstep(0.3, 0.8, abs(dot(normalize(vObjectNormal), normalize(vObjectPosition))));
}
void machineMilled(inout Surface s, vec3 rest, float wall) {
  float h = length(rest);
  float period = TAU / 2600.0;
  float fade = smoothstep(4.0, 8.0, period / max(fwidth(h), 1e-7)) * wall;
  s.roughness = clamp(s.roughness * mix(1.0, mix(0.8, 1.2, 0.5 + 0.5 * sin(h * 2600.0)), fade), 0.05, 1.0);
}
// Specular antialiasing (Tokuyoshi and Kaplanyan): widens the lobe where the normal varies within a pixel.
void machineSpecularAA(inout Surface s) {
  vec3 dx = dFdx(s.normal), dy = dFdy(s.normal);
  float kernel = min(0.5 * (dot(dx, dx) + dot(dy, dy)), 0.18);
  float a = s.roughness * s.roughness;
  s.roughness = sqrt(sqrt(clamp(a * a + kernel, 0.0, 1.0)));
}
// Dissolves a part with a fine dither as amount goes from 1 to 0; also in shadows and the prepass.
void machineDissolve(float amount) {
  if (amount >= 1.0) return;
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (n >= amount) discard;
}
// Distance to a tick: angular position f (in steps of size step, at radius r) between radii lo and hi.
float machineTick(float a, float step, float r, float lo, float hi) {
  float f = a / step;
  float along = abs(f - floor(f + 0.5)) * step * r;
  float across = r - clamp(r, lo, hi);
  return length(vec2(along, across));
}
`;

// The gear trains: turned brass, oily and darker the deeper they sit (height is the distance from the centre).
const GEAR_SHADING = /* glsl */ `
void machineGear(inout Surface s, float height, float radial) {
  s.albedo = gearColor * mix(0.8, 1.05, machineNoise(vec3(radial * 300.0, height * 300.0, 0.0)));
  s.roughness = 0.3 + 0.15 * machineNoise(vec3(radial * 600.0, 0.0, 0.0));
  s.occlusion *= mix(0.55, 1.0, smoothstep(R_FLOOR - 0.12, R_FLOOR, height));
}
`;

const FINISH_PARS = /* glsl */ `
uniform vec3 inlayColor;
uniform float inlayMetal;
uniform float inlayRough;
// The fill for engraving on dials and turntables.
uniform vec3 partInlayColor;
uniform float partInlayMetal;
uniform float partInlayRough;
uniform float engrave;
`;

// Per-plate data: centre and dial radius; counts; corner nodes; channel walls (normal, then u).
export function createPlateData() {
  const data = new Float32Array(DATA_WIDTH * MAX_PLATES * 4);
  const texture = new DataTexture(data, DATA_WIDTH, MAX_PLATES, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  return texture;
}

// Where along the spoke towards corner V its motif goes, and how big: the spot with the most room,
// packed as (angle from the centre in thousandths) + radius * 10.
function spokeMotif(face, V) {
  const c = face.center;
  const L = angle(c, V);
  const k = SCALE;
  const belt = face.dial ? face.dial + DIAL_GAP + 0.086 * k : 0;
  const start = belt && belt < face.inradius - 0.035 * k ? belt + 0.015 * k : face.dial ? face.dial + DIAL_GAP + 0.05 * k : 0.05 * k;
  const field = plateField(face);
  const Vt = V.map((v, k) => v - c[k] * (V[0] * c[0] + V[1] * c[1] + V[2] * c[2]));
  const len = Math.hypot(...Vt);
  let best = { t: L - RC - 0.048 * k, r: 0 };
  for (let t = L - RC - 0.05 * k; t > start + 0.03 * k; t -= 0.004 * k) {
    const E = c.map((v, k) => v * Math.cos(t) + (Vt[k] / len) * Math.sin(t));
    const r = Math.min(0.03 * k, field(E) - 0.036 * k, t - start - 0.01 * k);
    if (r > best.r + 0.002 * k) best = { t, r };
  }
  if (best.r < 0.014 * k) best.r = 0;
  return Math.round(best.t * 1000) + best.r * 10;
}

export function writePlateData(texture, layout) {
  const data = texture.image.data;
  data.fill(0);
  layout.faces.forEach((face, i) => {
    const row = i * DATA_WIDTH * 4;
    const put = (x, v) => data.set(v, row + x * 4);
    put(0, [...face.center, face.dial]);
    put(1, [face.points.length, face.walls.length, i, face.inradius]);
    face.points.slice(0, MAX_SIDES).forEach((p, j) => put(2 + j, [...p, spokeMotif(face, p)]));
    face.walls.slice(0, MAX_SIDES).forEach((w, j) => {
      const C = layout.circles[w.circle];
      put(2 + MAX_SIDES + j, [...w.n, w.h]);
      put(2 + MAX_SIDES * 2 + j, [...C.u, w.s]);
    });
  });
  texture.needsUpdate = true;
}

function createPlateState() {
  const texture = new DataTexture(new Float32Array(MAX_PLATES * 3 * 4), MAX_PLATES, 3, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  return texture;
}

export function createShared() {
  return {
    plateData: { value: createPlateData() },
    // Per plate, this frame (row 0) and last (row 1): offset into the sphere, plate turn, dial turn, dial lift.
    // Row 2: how much of the plate is there (1 solid, 0 dissolved), while it flies off or back.
    plateState: { value: createPlateState() },
    // Openings in the core under whatever is popped out: direction and angular radius.
    holes: { value: Array.from({ length: MAX_HOLES }, () => new Vector4()) },
    holeCount: { value: 0 },
    inlayColor: { value: new Color() },
    gearColor: { value: new Color() },
    partInlayColor: { value: new Color() },
    partInlayMetal: { value: 0.4 },
    partInlayRough: { value: 0.7 },
    inlayMetal: { value: 0.4 },
    inlayRough: { value: 0.7 },
    engrave: { value: 1 },
    mechScale: { value: 1 },
    popHeight: { value: 0.15 },
    motifSet: { value: 0 },
    motifVariety: { value: 0.5 },
    motifSeed: { value: 0 },
    motifAtlas: { value: null },
    // Core rack lines: old and new circles, cross-faded during a rebuild.
    coreN: { value: Array.from({ length: MAX_CIRCLES * 2 }, () => new Vector4()) },
    coreU: { value: Array.from({ length: MAX_CIRCLES * 2 }, () => new Vector4()) },
  };
}

const PLATE_VERTEX = /* glsl */ `
in float plate;
in float edge;
uniform sampler2D plateData;
uniform sampler2D plateState;
vec3 machineRotate(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

export function createPlateMaterial(shared) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 1,
    uniforms: shared,
    varyings: { vPlate: "float", vEdge: "float", vRest: "vec3" },
    vertexPars: PLATE_VERTEX,
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  int i = int(plate + 0.5);
  vec3 c = texelFetch(plateData, ivec2(0, i), 0).xyz;
  vec4 st = texelFetch(plateState, ivec2(i, pipelinePrevPose ? 1 : 0), 0);
  float s = st.x, a = st.y;
  n = machineRotate(n, c, a);
  return machineRotate(p, c, a) - c * s;
}`,
    vertexMain: "vPlate = plate; vEdge = edge; vRest = position;",
    fragmentPars: COMMON + FINISH_PARS + /* glsl */ `
uniform sampler2D plateData;
uniform sampler2D plateState;
#define RC_CUT (0.097 * MS)
#define DIAL_GAP (0.008 * MS)
#define R_TOP ${R.toFixed(4)}
#define R_FLOOR ${RF.toFixed(4)}
` + MOTIFS,
    surface: /* glsl */ `
void surface(inout Surface s) {
  int i = int(vPlate + 0.5);
  machineDissolve(texelFetch(plateState, ivec2(i, 2), 0).x);
  vec4 t0 = texelFetch(plateData, ivec2(0, i), 0);
  vec4 t1 = texelFetch(plateData, ivec2(1, i), 0);
  vec3 c = t0.xyz;
  float dial = t0.w;
  int nv = int(t1.x + 0.5), nw = int(t1.y + 0.5);
  vec3 p = normalize(vRest);
  float e = vEdge;
  float rc = machineAngle(p, c);

  // Wear: broad patina, fine speckle, polished bevels, grime down the walls.
  float broad = machineNoise(vRest * 5.0 + t1.z * 3.1);
  float fine = machineNoise(vRest * 90.0);
  float wallDepth = smoothstep(R_FLOOR, R_TOP - BEVEL, length(vRest));
  float onBevel = 1.0 - smoothstep(BEVEL * 0.6, BEVEL * 1.1, e);
  s.albedo *= mix(0.78, 1.04, broad) * mix(0.55, 1.0, wallDepth);
  s.roughness = clamp(s.roughness * mix(0.8, 1.25, broad) + (fine - 0.5) * 0.08 - onBevel * 0.12, 0.08, 1.0);
  s.albedo *= 1.0 + onBevel * 0.12;
  machineMilled(s, vRest, machineWall());

  // Engraving only matters to the lit pass; shadows and the prepass skip it.
#ifdef PIPELINE_COLOR
  float d = 1e3;
  // The one motif this pixel is near (dial belt, centre or a spoke end), drawn once at the end.
  vec3 mC = c, mUp = c;
  float mR = 0.0, mPart = 0.0;
  // A rule just inside the rim.
  d = min(d, abs(e - (0.027 * MS)));
  // Graduations along each channel, in steps of 2 degrees of its orbit with a long one every 10.
  for (int k = 0; k < ${MAX_SIDES}; k++) {
    if (k >= nw) break;
    vec4 nh = texelFetch(plateData, ivec2(${2 + 12} + k, i), 0);
    vec4 us = texelFetch(plateData, ivec2(${2 + 24} + k, i), 0);
    vec3 n = nh.xyz, u = us.xyz;
    float wd = us.w * (asin(clamp(dot(p, n), -1.0, 1.0)) - asin(nh.w)) - W_CH * 0.5;
    if (wd - e > (0.004 * MS)) continue;
    vec3 v = cross(n, u);
    float a = atan(dot(p, v), dot(p, u));
    float step = TAU / 180.0;
    float f = floor(a / step + 0.5);
    bool major = mod(f + 360.0, 5.0) < 0.5;
    float along = abs(a / step - f) * step;
    d = min(d, length(vec2(along, wd - clamp(wd, major ? (0.009 * MS) : (0.014 * MS), (0.021 * MS)))));
  }
  vec3 e1 = machinePerp(c), e2 = cross(c, e1);
  float theta = atan(dot(p, e2), dot(p, e1));
  // Inner edge of the open metal, where the guilloche starts.
  float inner;
  float belt = 0.0;
  if (dial > 0.0) {
    float rr = dial + DIAL_GAP;
    d = min(d, abs(rc - rr - (0.02 * MS)));
    d = min(d, machineTick(theta, TAU / 24.0, rc, rr + (0.03 * MS), rr + (0.042 * MS)));
    inner = rr + (0.05 * MS);
    // A belt of small motifs between two rules around the dial, where the plate has room.
    float b0 = rr + (0.052 * MS), b1 = rr + (0.086 * MS);
    if (b1 < t1.w - (0.035 * MS)) {
      belt = b1;
      inner = b1 + (0.006 * MS);
      d = min(d, min(abs(rc - b0), abs(rc - b1)));
      float rm = (b0 + b1) * 0.5;
      float count = max(6.0, floor(TAU * sin(rm) / (0.036 * MS)));
      float step = TAU / count;
      float k = mod(floor((theta + TAU) / step), count);
      float a = (k + 0.5) * step;
      vec3 out_ = e1 * cos(a) + e2 * sin(a);
      vec3 mc = c * cos(rm) + out_ * sin(rm);
      if (abs(rc - rm) < (0.016 * MS)) (mC = mc), (mUp = out_), (mR = (0.0125 * MS)), (mPart = float(i) * 64.0 + 300.0 + mod(k, 24.0));
    }
  } else {
    // No dial: a motif in the middle, in a ring.
    float mr = clamp(t1.w - (0.06 * MS), (0.03 * MS), (0.09 * MS));
    d = min(d, abs(rc - mr - (0.012 * MS)));
    (mC = c), (mUp = e1), (mR = mr), (mPart = float(i) * 16.0);
    inner = mr + (0.02 * MS);
  }

  // Engine-turned guilloche over the open metal: waves, sunburst, basket weave or a crossed-spiral rosette.
  float gType = mod(float(i) * 3.0 + floor(motifSeed * 4.0), 4.0);
  float fa, fb, spacing, density;
  float thetaW = machineAngleWidth(theta);
  if (gType < 0.5) {
    spacing = (0.0055 * MS);
    fa = fb = (rc + (0.0025 * MS) * sin(theta * 24.0)) / spacing;
    density = fwidth(fa);
  } else if (gType < 1.5) {
    spacing = max((TAU / 240.0) * sin(rc), 1e-5);
    fa = fb = theta / TAU * 240.0;
    density = thetaW * 240.0 / TAU;
  } else if (gType < 2.5) {
    spacing = (0.007 * MS);
    vec2 g = vec2(dot(p, e1), dot(p, e2)) / dot(p, c);
    g = vec2(g.x + g.y, g.x - g.y) * 0.7071;
    fa = g.x / spacing;
    fb = g.y / spacing;
    density = max(fwidth(fa), fwidth(fb));
  } else {
    spacing = (0.008 * MS);
    float a = rc / spacing, b = theta * 14.0 / TAU;
    fa = a + b;
    fb = a - b;
    density = fwidth(a) + thetaW * 14.0 / TAU;
  }
  float turned = smoothstep(inner, inner + (0.004 * MS), rc) * smoothstep((0.034 * MS), (0.038 * MS), e) * min(engrave, 1.0);
  float gg = machineTurned(s, fa, fb, spacing, (0.0004 * MS) * turned, density) * turned;
  s.roughness = clamp(s.roughness + gg * 0.08, 0.05, 1.0);
  s.albedo *= 1.0 - 0.12 * gg;
  // Spokes from the dial out towards each turntable, ending in a motif.
  for (int k = 0; k < ${MAX_SIDES}; k++) {
    if (k >= nv) break;
    vec4 vk = texelFetch(plateData, ivec2(2 + k, i), 0);
    vec3 V = vk.xyz;
    vec3 Vt = normalize(V - c * dot(V, c));
    float tE = floor(vk.w) / 1000.0, mr = fract(vk.w) / 10.0;
    float start = belt > 0.0 ? belt + (0.015 * MS) : dial > 0.0 ? dial + DIAL_GAP + (0.05 * MS) : (0.05 * MS);
    float end = tE - max(mr, (0.006 * MS)) - (0.003 * MS);
    if (end - start < (0.02 * MS)) continue;
    vec3 nrm = normalize(cross(c, V));
    float off = asin(clamp(dot(p, nrm), -1.0, 1.0));
    float along = atan(dot(p, Vt), dot(p, c));
    float seg = length(vec2(off, along - clamp(along, start, end)));
    vec3 E = c * cos(tE) + Vt * sin(tE);
    d = min(d, seg);
    float pe = machineAngle(p, E);
    if (mr > 0.0 && pe < mr * 1.2) (mC = E), (mUp = Vt), (mR = mr), (mPart = float(i) * 16.0 + 1.0 + float(k));
    else if (mr == 0.0) d = min(d, abs(pe - (0.006 * MS)));
  }
  float pixel = motifPixel(p);
  if (mR > 0.0) d = min(d, motifAt(p, mC, mUp, mR, mPart, pixel));
  float top = smoothstep(BEVEL, BEVEL + (0.004 * MS), e);
  float cut = machineGroove(s, d, (0.0022 * MS) * engrave + 1e-4, (0.0012 * MS) * engrave) * top * min(engrave, 1.0);
  s.albedo = mix(s.albedo, inlayColor * mix(0.8, 1.1, fine), cut);
  s.metalness = mix(s.metalness, inlayMetal, cut);
  s.roughness = mix(s.roughness, inlayRough, cut);
  s.occlusion *= 1.0 - 0.35 * cut;
  machineSpecularAA(s);
#endif
}
`,
  });
}

export function createDialMaterial(shared) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.28,
    metalness: 1,
    uniforms: shared,
    varyings: { vPlate: "float", vEdge: "float", vRest: "vec3" },
    vertexPars: PLATE_VERTEX + /* glsl */ `
in float spin;
in float rider;
uniform float popHeight;`,
    // Everything here turns and rises with its plate; the dial and its gears (rider) also with the dial.
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  int i = int(plate + 0.5);
  vec3 c = texelFetch(plateData, ivec2(0, i), 0).xyz;
  vec4 st = texelFetch(plateState, ivec2(i, pipelinePrevPose ? 1 : 0), 0);
  float a = st.y + st.z * spin;
  float s = st.x - st.w * popHeight * rider;
  n = machineRotate(n, c, a);
  return machineRotate(p, c, a) - c * s;
}`,
    vertexMain: "vPlate = plate; vEdge = edge; vRest = position;",
    fragmentPars: COMMON + FINISH_PARS + `uniform sampler2D plateData;\nuniform sampler2D plateState;\nuniform vec3 gearColor;\n#define R_FLOOR ${RF.toFixed(4)}\n` + GEAR_SHADING + MOTIFS,
    surface: /* glsl */ `
void surface(inout Surface s) {
  machineDissolve(texelFetch(plateState, ivec2(int(vPlate + 0.5), 2), 0).x);
  if (vEdge < -1.5) {
    machineGear(s, length(vRest), length(cross(vRest, texelFetch(plateData, ivec2(0, int(vPlate + 0.5)), 0).xyz)));
    return;
  }
  int i = int(vPlate + 0.5);
  vec4 t0 = texelFetch(plateData, ivec2(0, i), 0);
  vec3 c = t0.xyz;
  float rd = t0.w;
  vec3 p = normalize(vRest);
  float r = machineAngle(p, c);
  vec3 e1 = machinePerp(c), e2 = cross(c, e1);
  float theta = atan(dot(p, e2), dot(p, e1));
  float fine = machineNoise(vRest * 110.0);
  float onBevel = 1.0 - smoothstep(BEVEL * 0.6, BEVEL * 1.1, vEdge);
  s.roughness = clamp(s.roughness + (fine - 0.5) * 0.06 - onBevel * 0.1, 0.06, 1.0);
  // Brushed in circles.
  float wall = machineWall();
  s.roughness *= mix(mix(0.85, 1.1, machineNoise(vec3(r * 900.0, 0.0, float(i)))), 1.0, wall);
  machineMilled(s, vRest, wall);

#ifdef PIPELINE_COLOR
  // A fine sunburst turned into the face.
  float sunSpacing = max((TAU / 180.0) * r, 1e-5);
  float sun = abs(fract(theta / TAU * 180.0) - 0.5) * sunSpacing;
  float turned = smoothstep((0.012 * MS), (0.016 * MS), r) * smoothstep(BEVEL, BEVEL + (0.004 * MS), vEdge) * min(engrave, 1.0);
  s.albedo *= 1.0 - 0.1 * machineTurned(s, theta / TAU * 180.0, theta / TAU * 180.0, sunSpacing, (0.00035 * MS) * turned, machineAngleWidth(theta) * 180.0 / TAU) * turned;
  float d = abs(r - (rd - (0.017 * MS)));
  float f = floor(theta / (TAU / 24.0) + 0.5);
  bool major = mod(f + 48.0, 6.0) < 0.5;
  d = min(d, machineTick(theta, TAU / 24.0, r, rd - (major ? (0.038 * MS) : (0.03 * MS)), rd - (0.02 * MS)));
  // An index mark on the rim, like a bezel's: a bold inlaid bar that shows every turn of the dial.
  float bar = length(vec2(abs(theta) < 1.5 ? r * sin(theta) : 1.0, r - clamp(r, rd - (0.05 * MS), rd - (0.016 * MS))));
  d = min(d, max(bar - (0.005 * MS), 0.0));
  // An emblem on the face, or just a pointer on small dials.
  float emblem = rd - (0.046 * MS);
  float pixel = motifPixel(p);
  if (emblem > (0.022 * MS)) d = min(d, motifAt(p, c, e1, emblem, 1000.0 + float(i), pixel));
  else d = min(d, min(length(vec2(abs(theta) < 1.5 ? r * sin(theta) : 1.0, r - clamp(r, (0.016 * MS), rd - (0.042 * MS)))), abs(r - (0.01 * MS))));
  float top = smoothstep(BEVEL, BEVEL + (0.003 * MS), vEdge);
  float cut = machineGroove(s, d, (0.0028 * MS) * engrave + 1e-4, (0.0013 * MS) * engrave) * top * min(engrave, 1.0);
  s.albedo = mix(s.albedo, partInlayColor, cut);
  s.metalness = mix(s.metalness, partInlayMetal, cut);
  s.roughness = mix(s.roughness, partInlayRough, cut);
  machineSpecularAA(s);
#endif
}
`,
  });
}

export function createTurntableMaterial(shared) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.24,
    metalness: 1,
    instanceMotion: true,
    uniforms: shared,
    varyings: { vEdge: "float", vRest: "vec3", vNode: "float", vFade: "float" },
    vertexPars: "in float edge;\nin float fade;",
    vertexMain: "vEdge = edge; vRest = position; vNode = float(gl_InstanceID); vFade = fade;",
    fragmentPars: COMMON + FINISH_PARS + `uniform vec3 gearColor;\n#define RT (0.088 * MS)\n#define R_FLOOR ${RF.toFixed(4)}\n` + GEAR_SHADING + MOTIFS,
    surface: /* glsl */ `
void surface(inout Surface s) {
  machineDissolve(vFade);
  vec3 p = normalize(vRest);
  float r = acos(clamp(p.y, -1.0, 1.0));
  float theta = atan(p.z, p.x);
  float onBevel = 1.0 - smoothstep(BEVEL * 0.6, BEVEL * 1.1, vEdge);
  float wall = machineWall();
  s.roughness = clamp(s.roughness * mix(mix(0.85, 1.1, machineNoise(vec3(r * 1100.0, 0.0, 0.0))), 1.0, wall) - onBevel * 0.1, 0.06, 1.0);
  machineMilled(s, vRest, wall);
  if (vEdge < -2.5) {
    // Inside a well in the core: dark, oily, dimmer further down.
    s.albedo = gearColor * 0.16;
    s.metalness = 0.8;
    s.roughness = 0.55;
    s.occlusion *= mix(0.25, 1.0, smoothstep(R_FLOOR - 0.12, R_FLOOR, vRest.y));
    return;
  }
  if (vEdge < -1.5) {
    machineGear(s, vRest.y, length(vRest.xz));
    return;
  }
  if (vEdge < -0.5) {
    // Slot floor: a toothed rack the carriages ride on.
    s.albedo *= 0.35;
    s.roughness = 0.45;
    float pitch = (0.012 * MS);
    float dr = abs(fract(p.x / pitch) - 0.5) * pitch;
    float g = machineGroove(s, max(dr, (abs(p.z) - W_CH * 0.2) * 4.0 + (0.003 * MS)), (0.003 * MS), (0.002 * MS));
    s.albedo *= 1.0 - 0.5 * g;
    s.occlusion *= 0.75;
    return;
  }
#ifdef PIPELINE_COLOR
  // Fine concentric turning, then a ring near the rim and a motif on each half, pointing out from the slot.
  float turned = smoothstep(BEVEL, BEVEL + (0.003 * MS), vEdge) * min(engrave, 1.0);
  machineTurned(s, r / (0.0042 * MS), r / (0.0042 * MS), (0.0042 * MS), (0.0003 * MS) * turned, fwidth(r / (0.0042 * MS)));
  float d = abs(r - (RT - (0.0165 * MS)));
  float side = p.z > 0.0 ? 1.0 : -1.0;
  vec3 mc = normalize(vec3(0.0, cos((0.058 * MS)), side * sin((0.058 * MS))));
  d = min(d, motifAt(p, mc, vec3(0.0, 0.0, side), (0.011 * MS), 2000.0 + vNode * 2.0 + (side > 0.0 ? 1.0 : 0.0), motifPixel(p)));
  float top = smoothstep(BEVEL, BEVEL + (0.003 * MS), vEdge);
  float cut = machineGroove(s, d, (0.0024 * MS) * engrave + 1e-4, (0.0011 * MS) * engrave) * top * min(engrave, 1.0);
  s.albedo = mix(s.albedo, partInlayColor, cut);
  s.metalness = mix(s.metalness, partInlayMetal, cut);
  s.roughness = mix(s.roughness, partInlayRough, cut);
  machineSpecularAA(s);
#endif
}
`,
  });
}

export function createCoreMaterial(shared) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 1,
    uniforms: shared,
    fragmentPars: COMMON + /* glsl */ `
uniform vec4 coreN[${MAX_CIRCLES * 2}];
uniform vec4 coreU[${MAX_CIRCLES * 2}];
uniform vec4 holes[${MAX_HOLES}];
uniform int holeCount;
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = normalize(vObjectPosition);
  for (int k = 0; k < ${MAX_HOLES}; k++) {
    if (k >= holeCount) break;
    if (dot(p, holes[k].xyz) > cos(holes[k].w)) discard;
  }
  float in_ = 0.0;
  float cut = 0.0;
  s.albedo *= mix(0.7, 1.0, machineNoise(p * 40.0));
  // Each circle's rack and rails, scaled by its weight so a rebuild can fade them out and in.
  for (int k = 0; k < ${MAX_CIRCLES * 2}; k++) {
    vec4 nw = coreN[k];
    if (nw.w <= 0.001) continue;
    float lat = asin(clamp(dot(p, nw.xyz), -1.0, 1.0)) - asin(coreU[k].w);
    if (abs(lat) > W_CH * 0.5) continue;
    vec3 u = coreU[k].xyz, v = cross(nw.xyz, u);
    float a = atan(dot(p, v), dot(p, u));
    float pitch = 0.012 * MS;
    float teeth = max(abs(fract(a / pitch) - 0.5) * pitch, (abs(lat) - W_CH * 0.17) * 4.0 + 0.003 * MS);
    float rail = abs(abs(lat) - W_CH * 0.3);
    cut = max(cut, nw.w * machineGroove(s, min(teeth, rail), 0.0028 * MS, 0.0018 * MS * nw.w));
    in_ = max(in_, nw.w * (1.0 - smoothstep(W_CH * 0.4, W_CH * 0.5, abs(lat))));
  }
  s.albedo *= 1.0 - 0.6 * cut;
  // Matte black, with a faint sheen only along the worn rails.
  s.roughness = mix(0.85, 0.55, in_);
  s.specular = mix(0.35, 0.8, in_);
  s.occlusion *= 1.0 - 0.4 * cut;
  machineSpecularAA(s);
}
`,
  });
}

// Carriages and beads fade (per instance) as they fly off and back.
const FADING = {
  varyings: { vFade: "float" },
  vertexPars: "in float fade;",
  vertexMain: "vFade = fade;",
  fragmentPars: COMMON,
  surface: "void surface(inout Surface s) { machineDissolve(vFade); }",
};

export function createCarriageMaterial() {
  return new PipelineMaterial({ color: 0xffffff, roughness: 0.3, metalness: 1, instanceMotion: true, ...FADING });
}

export function createBeadMaterial() {
  return new PipelineMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0, instanceMotion: true, ...FADING });
}
