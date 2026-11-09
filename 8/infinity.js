import {
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  WebGLRenderTarget,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  DataTexture,
  FloatType,
  NearestFilter,
  Matrix3,
  Matrix4,
  Vector2,
  Vector3,
  Vector4,
  MathUtils,
} from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { MAX_FACES, MAX_TUBES } from "./sculpture.js";

const vertexShader = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// The inside of the sculpture, ray traced over the lit image: the glass faces are two-way mirrors, so a ray
// that gets in bounces between them, picking up the light tubes along the windows until it fades.
const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#define MAX_FACES ${MAX_FACES}
#define MAX_TUBES ${MAX_TUBES}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform mat4 inverseViewProjection;
uniform vec3 cameraPos;
uniform vec4 planes[MAX_FACES];
uniform int faceCount;
uniform highp sampler2D tubes; // texels 2i and 2i + 1: tube i's ends (the first one's w: its length)
uniform highp sampler2D faceData; // texel f: face f's first tube, tube count, light, rim width
uniform highp sampler2D facePresence; // x: how much face f's edges inset its neighbours' windows; y: its seed
uniform highp sampler2D innerTubes; // the nested solid's tubes, laid out as tubes
uniform sampler2D dirMap; // per direction from the centre: how lit the haze is through the window (r), the face (g)
uniform float dirSize;
uniform float warp;
uniform float ripple;
uniform float tilt;
uniform float uneven;
uniform int glass; // 0 mirror, 1 dichroic, 2 smoked, 3 cracked, 4 open panels
uniform float glassAmount;
uniform float nodeRadius;
uniform vec4 innerPlanes[64];
uniform int innerCount;
uniform int innerTubeCount;
uniform float innerTubeRadius;
uniform float innerBound;
uniform float floorY;
uniform float floorGloss;
uniform float floorRough;
uniform vec3 roomGlow; // mean light of the room, for bounced rays leaving through an open panel
uniform float fog;
uniform vec3 fogColor;
uniform vec3 meanColor;
uniform float chase;
uniform int tubeType; // 0 frosted diffuser, 1 LED pixels, 2 neon, 3 filament
uniform int deepStart; // supersample pixels whose path took at least this many bounces
uniform vec2 texel;
uniform vec2 jitter;
uniform vec3 cameraForward;
uniform float cocScale; // depth of field: blur in pixels is cocScale * |1 - dofFocus / depth|
uniform float dofFocus;
uniform float tubeRadius;
uniform vec3 tubeColor;
uniform float frameWidth;
uniform vec3 frameBack;
uniform mat3 sculptRot;
uniform vec3 sculptCenter;
uniform float sculptScale;
uniform float outerReflect;
uniform float outerTransmit;
uniform float innerReflect;
uniform vec3 glassTint;
uniform int bounces;
uniform float lastWeight; // how much of the last bounce counts; the rest is the tail estimate
uniform float tubeReach;
uniform float pixelAngle;
uniform float aberration;
uniform float maxFootprint;
uniform float tubeMax;
uniform vec3 haze;
uniform vec3 tail;
uniform float boundRadius;
uniform vec3 palette[4];
uniform int paletteCount;
uniform int pattern; // 0 one colour, 1 per window, 2 per tube, 3 segments, 4 gradient
uniform float segments;
uniform float gap;
uniform samplerCube envMap;
uniform mat3 envRotation;
uniform float envIntensity;
uniform float envMapMaxLod;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// Entry (from outside) or exit (from inside) through the polytope: distance and the face crossed.
float crossFace(vec3 o, vec3 d, bool entering, out int face) {
  float tIn = -1e9, tOut = 1e9;
  int fIn = -1, fOut = -1;
  for (int i = 0; i < faceCount; i++) {
    float dn = dot(planes[i].xyz, d);
    float dist = planes[i].w - dot(planes[i].xyz, o);
    if (abs(dn) < 1e-9) {
      if (dist < 0.0) tIn = 1e9;
      continue;
    }
    float t = dist / dn;
    if (dn < 0.0) {
      if (t > tIn) { tIn = t; fIn = i; }
    } else if (t < tOut) { tOut = t; fOut = i; }
  }
  face = entering ? fIn : fOut;
  if (entering) return tIn <= tOut && tIn > 0.0 ? tIn : -1.0;
  return max(tOut, 0.0);
}

// Whether p (on face f) is in f's window rather than behind the frame (the frame mesh's test), and which faces'
// tubes are within reach of p: all of a face's tubes lie in a slab under it, so a straight run can only meet them
// if one of its ends is near that face.
bool probe(vec3 p, int f, out uvec2 near) {
  vec3 n = planes[f].xyz;
  bool inside = true;
  float fw = texelFetch(faceData, ivec2(f, 0), 0).w;
  near = uvec2(0u);
  for (int j = 0; j < faceCount; j++) {
    float dj = planes[j].w - dot(planes[j].xyz, p);
    if (dj < tubeReach) {
      if (j < 32) near.x |= 1u << uint(j);
      else near.y |= 1u << uint(j - 32);
    }
    // The face's inset is at most fw, so only planes that close can put p behind the frame.
    if (j != f && dj < fw) {
      float c = dot(n, planes[j].xyz);
      float s = sqrt(max(1.0 - c * c, 0.0));
      if (s > 1e-6 && dj < fw * s * texelFetch(facePresence, ivec2(j, 0), 0).x) inside = false;
    }
  }
  return inside;
}

// Closest approach of the ray o + d t (t >= 0) to the segment a-b: (t, distance, position along a-b).
vec3 raySegment(vec3 o, vec3 d, vec3 a, vec3 b) {
  vec3 ba = b - a, oa = o - a;
  float baba = dot(ba, ba), bad = dot(ba, d), baoa = dot(ba, oa), doa = dot(d, oa);
  float den = baba - bad * bad;
  float s = den > 1e-9 ? clamp((baoa - bad * doa) / den, 0.0, 1.0) : 0.0;
  float t = max(bad * s - doa, 0.0);
  s = clamp((baoa + bad * t) / baba, 0.0, 1.0);
  return vec3(t, length(oa + d * t - ba * s), s);
}

vec3 paletteAt(int k) {
  k = k % paletteCount;
  return k == 0 ? palette[0] : k == 1 ? palette[1] : k == 2 ? palette[2] : palette[3];
}

// The colour of tube i (on face f) at s along it; w: the footprint as a fraction of the tube's length.
vec3 lightColor(int i, int f, float s, float w) {
  s = fract(s + chase);
  if (pattern == 1) return paletteAt(f);
  if (pattern == 2) return paletteAt(i);
  if (pattern == 4) {
    float x = s * float(paletteCount);
    return mix(paletteAt(int(x) + i), paletteAt(int(x) + i + 1), smoothstep(0.0, 1.0, fract(x)));
  }
  if (pattern == 3) {
    float x = s * segments;
    float e = abs(fract(x) - 0.5) * 2.0;
    // Dark joints between segments, softened over the footprint.
    float k = max(w * segments, 1e-3);
    float lit = gap > 0.0 ? smoothstep(gap - k, gap + k, 1.0 - e) : 1.0;
    return paletteAt(int(x) + i) * lit;
  }
  return palette[0];
}

vec4 hash41(float p) {
  vec4 p4 = fract(vec4(p) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// Face f's own number, from its direction, so it keeps its look when a morph adds or drops faces.
float faceSeed(int f) {
  return texelFetch(facePresence, ivec2(f, 0), 0).y;
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 noise3(vec3 p) {
  vec3 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash33(i), hash33(i + vec3(1, 0, 0)), f.x), mix(hash33(i + vec3(0, 1, 0)), hash33(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash33(i + vec3(0, 0, 1)), hash33(i + vec3(1, 0, 1)), f.x), mix(hash33(i + vec3(0, 1, 1)), hash33(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

bool panelOpen(int f) {
  return glass == 4 && hash41(faceSeed(f) + 11.0).y < glassAmount;
}

// The glass of face f at p as built, not as drawn: each panel bows (more or less, in or out), sits a little
// askew, and ripples. The surface stays where it is; only its normal is bent, as for any thin warped sheet.
// A cracked panel breaks into shards, each at its own angle; crack: how much the dark seams let through.
vec3 panelNormal(int f, vec3 p, out float crack, out vec4 shard) {
  vec3 n = planes[f].xyz;
  float seed = faceSeed(f);
  vec4 h = hash41(seed + 7.0);
  vec3 r = p - n * planes[f].w;
  vec3 b = r * warp * (h.x * 2.0 - 1.0) * 0.35;
  b += (h.yzw - 0.5) * tilt * 0.08;
  if (ripple > 0.0) b += (noise3(p * 4.0 + seed * 3.1) - 0.5) * ripple * 0.05;
  crack = 1.0;
  shard = vec4(0.0);
  if (glass == 3 && hash41(seed + 3.0).x < glassAmount) {
    // Shards: Voronoi cells in the plane of the glass.
    vec3 ax = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec2 q = vec2(dot(p, ax), dot(p, cross(n, ax))) * 5.0 + seed * 7.3;
    vec2 i = floor(q), fr = q - i;
    float d1 = 8.0, d2 = 8.0;
    vec2 cell2 = vec2(0.0);
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(x, y);
        vec2 v = g + hash33(vec3(i + g, seed)).xy - fr;
        float dd = dot(v, v);
        if (dd < d1) { d2 = d1; d1 = dd; cell2 = i + g; } else if (dd < d2) d2 = dd;
      }
    vec3 cell = vec3(cell2, seed);
    // Each shard is its own pane, set at its own angle.
    shard = vec4(hash33(cell + 5.0) - 0.5, 1.0);
    b += shard.xyz * 0.3;
    crack = smoothstep(0.0, 0.06, sqrt(d2) - sqrt(d1));
  }
  return normalize(n + b - n * dot(b, n));
}

// Dichroic coating: thin-film interference, its colour shifting with the angle (and a little across the panel).
vec3 filmColor(int f, vec3 p, float cosi) {
  if (glass != 1) return vec3(1.0);
  float thickness = 0.32 + 0.22 * hash41(faceSeed(f) + 5.0).x + 0.04 * noise3(p * 2.0).x;
  float cost = sqrt(1.0 - (1.0 - cosi * cosi) / (1.45 * 1.45));
  vec3 phase = 4.0 * 3.14159265 * 1.45 * thickness * cost / vec3(0.65, 0.53, 0.45);
  vec3 c = 0.5 + 0.5 * cos(phase);
  return c / max(dot(c, vec3(0.3, 0.59, 0.11)), 0.05) * 0.5;
}

// Entry into the nested solid (planes already in this space): distance and its outward normal, or -1.
float innerHit(vec3 o, vec3 d, out vec3 nIn) {
  float tIn = -1e9, tOut = 1e9;
  nIn = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < innerCount; i++) {
    vec4 pl = innerPlanes[i];
    float dn = dot(pl.xyz, d);
    float dist = pl.w - dot(pl.xyz, o);
    if (abs(dn) < 1e-9) {
      if (dist < 0.0) tIn = 1e9;
      continue;
    }
    float t = dist / dn;
    if (dn < 0.0) {
      if (t > tIn) { tIn = t; nIn = pl.xyz; }
    } else tOut = min(tOut, t);
  }
  return tIn <= tOut && tIn > 1e-5 ? tIn : -1.0;
}

// Which faces' tubes are within reach of p.
uvec2 nearMask(vec3 p) {
  uvec2 near = uvec2(0u);
  for (int j = 0; j < faceCount; j++) {
    if (planes[j].w - dot(planes[j].xyz, p) >= tubeReach) continue;
    if (j < 32) near.x |= 1u << uint(j);
    else near.y |= 1u << uint(j - 32);
  }
  return near;
}

vec3 env(vec3 d, float rough) {
  return textureLod(envMap, envRotation * d, envMapMaxLod * rough).rgb * envIntensity;
}

// The sculpture seen along a world ray (origin ro, direction rd), up to tLimit; travelled: distance already behind
// the ray (for its footprint); spread: extra footprint angle (a glossy floor's blur), from where the ray starts;
// behind: what lies beyond the sculpture along rd. a: 1 where it shows, else 0.
vec4 traceSculpture(vec3 ro, vec3 rd, float tLimit, float travelledBefore, float spread, vec3 behind, out float tEntry, out float used) {
  used = 0.0;
  mat3 toLocal = transpose(sculptRot);
  vec3 o = toLocal * (ro - sculptCenter) / sculptScale;
  vec3 d = toLocal * rd;
  tEntry = 1e9;
  float bo = dot(o, d);
  if (bo * bo - dot(o, o) + boundRadius * boundRadius < 0.0) return vec4(0.0);

  int face;
  float t = crossFace(o, d, true, face);
  // Missed, behind something nearer (the frame's mesh), or on the frame band.
  if (t < 0.0 || t * sculptScale > tLimit * 1.0005 + 1e-3) return vec4(0.0);
  tEntry = t * sculptScale;
  o += d * t;
  uvec2 nearO;
  if (!probe(o, face, nearO)) return vec4(0.0);

  // The outside of a two-way mirror: a faint reflection of the room (more at grazing angles), and some of the inside.
  // An open panel lets everything in.
  float crack;
  vec4 shard;
  vec3 n = panelNormal(face, o, crack, shard);
  bool openIn = panelOpen(face);
  float cosIn = abs(dot(d, n));
  float F = openIn ? 0.0 : pow(1.0 - cosIn, 5.0);
  vec3 film = filmColor(face, o, cosIn);
  vec3 color = openIn ? vec3(0.0) : mix(outerReflect, 1.0, F) * crack * mix(vec3(1.0), film, glassAmount) * env(sculptRot * reflect(d, n), 0.05);
  // A dichroic coating passes the colours it doesn't reflect.
  vec3 thr = openIn ? vec3(1.0) : outerTransmit * (1.0 - F) * crack * (glass == 1 ? mix(vec3(1.0), 1.0 - 0.5 * film, glassAmount) : vec3(1.0));
  // Through a shard of broken glass the view is bent and shifted, pane by pane.
  bool remask = false;
  if (shard.w > 0.0) {
    vec3 side = shard.xyz - n * dot(shard.xyz, n);
    vec3 nf = planes[face].xyz;
    vec3 shift = (side - nf * dot(side, nf)) * 0.07;
    // The shift stops short of the frame, so the ray stays in the window.
    float k = 1.0;
    for (int j = 0; j < faceCount; j++) {
      float c = dot(nf, planes[j].xyz), toward = dot(planes[j].xyz, shift);
      float s = sqrt(max(1.0 - c * c, 0.0));
      if (j != face && s > 1e-6 && toward > 0.0) k = min(k, max(planes[j].w - dot(planes[j].xyz, o) - frameWidth * s, 0.0) / toward);
    }
    o += shift * k;
    d = normalize(d + side * 0.25);
    remask = true;
  }
  float travelledFloor = travelledBefore / sculptScale;
  float travelled = t + travelledFloor;
  bool alive = true, straight = !remask;
  vec3 cut = vec3(-1.0);
  for (int b = 0; b < bounces; b++) {
    used = float(b + 1);
    if (b == bounces - 1 && lastWeight < 1.0) cut = color + thr * tail;
    // The segment starts somewhere else than where its mask was taken (a shard's offset).
    if (remask) { nearO = nearMask(o); remask = false; }
    int exitFace;
    float tExit = crossFace(o, d, false, exitFace);
    if (exitFace < 0) { color += thr * frameBack; alive = false; break; }
    // The nested solid, a mirror, may come first.
    vec3 innerN = vec3(0.0);
    // Only where the ray passes the nested solid's bounding sphere before it leaves.
    float ib = dot(o, d), idisc = ib * ib - dot(o, o) + innerBound * innerBound;
    bool nearInner = innerCount > 0 && idisc > 0.0 && -ib + sqrt(idisc) > 0.0 && -ib - sqrt(idisc) < tExit;
    float tInner = nearInner ? innerHit(o, d, innerN) : -1.0;
    bool atInner = tInner > 0.0 && tInner < tExit;
    float tEnd = atInner ? tInner : tExit;
    vec3 e = o + d * tEnd;
    uvec2 nearE;
    bool open = true;
    if (atInner) nearE = nearMask(e);
    else open = probe(e, exitFace, nearE);
    // The ray's footprint: a pixel's width, widened by the warped glass, plus the floor's blur from the floor on;
    // at q.x along the segment it is w0 + dw * q.x. Tubes are box-filtered against it.
    float cone = pixelAngle * (1.0 + float(b) * aberration);
    float w0 = cone * travelled + spread * (travelled - travelledFloor), dw = cone + spread;
    float tHit = tEnd, hitH = 0.0, hitW = 1.0, hitS = 0.0, hitL = 1.0, hitR = 1.0;
    int hit = -1, hitFace = 0, hitKind = 0;
    uvec2 mask = nearO | nearE;
    for (int f = 0; f < faceCount; f++) {
      uint bits = f < 32 ? mask.x >> uint(f) : mask.y >> uint(f - 32);
      if ((bits & 1u) == 0u) continue;
      vec4 fd = texelFetch(faceData, ivec2(f, 0), 0);
      for (int i = int(fd.x); i < int(fd.x + fd.y); i++) {
        vec4 aL = texelFetch(tubes, ivec2(2 * i, 0), 0);
        vec3 a = aL.xyz;
        vec3 c = texelFetch(tubes, ivec2(2 * i + 1, 0), 0).xyz;
        vec3 q = raySegment(o, d, a, c);
        float w = max(min(w0 + dw * q.x, maxFootprint), 1e-5);
        if (q.x > 1e-4 && q.x < tHit && q.y < tubeRadius + 0.5 * w) { tHit = q.x; hit = i; hitH = q.y; hitW = w; hitS = q.z; hitFace = f; hitL = aL.w; hitKind = 0; hitR = tubeRadius; }
        // The corner node where this tube starts.
        if (nodeRadius > 0.0) {
          vec3 corner = a + (a - c) * (tubeRadius / aL.w);
          float tq = dot(corner - o, d);
          float dist = length(o + d * tq - corner);
          float wn = max(min(w0 + dw * tq, maxFootprint), 1e-5);
          if (tq > 1e-4 && tq < tHit && dist < nodeRadius + 0.5 * wn) { tHit = tq; hit = i; hitH = dist; hitW = wn; hitS = 0.0; hitFace = f; hitL = aL.w; hitKind = 1; hitR = nodeRadius; }
        }
      }
    }
    int innerTubesNear = nearInner ? innerTubeCount : 0;
    for (int i = 0; i < innerTubesNear; i++) {
      vec4 aL = texelFetch(innerTubes, ivec2(2 * i, 0), 0);
      vec3 c = texelFetch(innerTubes, ivec2(2 * i + 1, 0), 0).xyz;
      vec3 q = raySegment(o, d, aL.xyz, c);
      float w = max(min(w0 + dw * q.x, maxFootprint), 1e-5);
      if (q.x > 1e-4 && q.x < tHit && q.y < innerTubeRadius + 0.5 * w) { tHit = q.x; hit = i; hitH = q.y; hitW = w; hitS = q.z; hitFace = -1; hitL = aL.w; hitKind = 2; hitR = innerTubeRadius; }
    }
    if (hit >= 0) {
      float cov = clamp((min(hitH + 0.5 * hitW, hitR) - max(hitH - 0.5 * hitW, -hitR)) / hitW, 0.0, 1.0);
      cov *= hitKind == 2 ? texelFetch(innerTubes, ivec2(2 * hit + 1, 0), 0).w : texelFetch(tubes, ivec2(2 * hit + 1, 0), 0).w;
      float x = min(hitH / hitR, 1.0);
      // Frosted diffuser: a bright core, dimmer towards the silhouette; no two LEDs quite alike.
      float profile = mix(0.3, 1.2, sqrt(sqrt(1.0 - x * x)));
      float core = 0.0;
      if (tubeType == 1 && hitKind != 1) {
        // LED pixels: bright dots along the strip, box-filtered over the footprint.
        float pitch = 0.035, fw = hitW / pitch;
        float dd = 1.0 - smoothstep(0.3 - fw, 0.3 + fw, abs(fract(hitS * hitL / pitch) - 0.5));
        // Wide footprints fade to the strip's mean (0.6 of it lit).
        float dots = mix(dd, 0.6, smoothstep(0.25, 0.45, fw));
        profile = mix(0.05, 2.4, dots) * mix(0.5, 1.0, sqrt(1.0 - x * x));
      } else if (tubeType == 2) {
        // Neon: a white-hot core inside a saturated glow.
        core = pow(max(1.0 - x * x, 0.0), 8.0);
        profile = 0.6 + 0.9 * core;
      } else if (tubeType == 3 && hitKind != 1) {
        // A filament in clear glass: a thin glowing thread, the tube itself barely there.
        float fw = hitW / hitR;
        profile = mix(0.04, 3.2, 1.0 - smoothstep(0.25 - fw, 0.25 + fw, x));
      }
      // Tubes are known by their face's seed and their place on it, which a morph keeps.
      int tubeId = hitKind == 2 ? hit + 1000 : int(faceSeed(hitFace)) * 16 + hit - int(texelFetch(faceData, ivec2(hitFace, 0), 0).x);
      vec4 h = hash41(float(tubeId) + 0.5);
      vec3 led = mix(vec3(1.0), (0.55 + 0.9 * h.x) * mix(vec3(1.0, 0.94, 0.86), vec3(0.88, 0.97, 1.0), h.y), uneven);
      float on = hitKind == 2 ? 1.0 : texelFetch(faceData, ivec2(hitFace, 0), 0).z;
      // Nodes are frosted connectors, lit by the tubes that meet in them.
      float kind = hitKind == 1 ? 0.55 : 1.0;
      vec3 lc = lightColor(tubeId + (hitKind == 2 ? 7 : 0), hitKind == 2 ? 0 : int(faceSeed(hitFace)), hitS, hitW / hitL);
      if (tubeType == 2) lc = mix(lc, vec3(max(lc.r, max(lc.g, lc.b))), 0.8 * core);
      if (tubeType == 3) lc *= vec3(1.0, 0.72, 0.42);
      vec3 emit = tubeColor * led * lc * profile * kind * on;
      color += thr * cov * emit;
      thr *= 1.0 - cov;
      if (cov > 0.99) { alive = false; break; }
    }
    travelled += tEnd;
    o = e;
    vec3 tint = innerReflect * glassTint;
    if (atInner) {
      d = reflect(d, innerN);
      o += innerN * 1e-4;
    } else {
      if (!open) { color += thr * frameBack; alive = false; break; }
      // Through an open panel the ray leaves into the room: straight through, what the raster shows beyond.
      if (panelOpen(exitFace)) { color += thr * (straight ? behind : env(sculptRot * d, 0.3) * 0.5 + roomGlow); alive = false; break; }
      // The inside of the glass: the mirror sends it back in.
      float crackE;
      vec4 shardE;
      vec3 m = panelNormal(exitFace, o, crackE, shardE);
      vec3 N = planes[exitFace].xyz;
      vec3 din = d;
      d = reflect(din, m);
      // A steep bend can't send it out through the glass it just met.
      if (dot(d, N) > -1e-3) d = reflect(din, N);
      o -= N * 1e-4;
      // Each shard's mirror sits at its own depth, so the reflection jumps from pane to pane.
      if (shardE.w > 0.0) {
        o -= N * (0.015 + 0.05 * abs(shardE.x)) + (shardE.xyz - N * dot(shardE.xyz, N)) * 0.04;
        remask = true;
      }
      // The film's colour, kept from gaining light in any channel.
      vec3 fc = filmColor(exitFace, o, abs(dot(din, m))) * 1.4;
      fc /= max(1.0, max(fc.r, max(fc.g, fc.b)));
      tint *= crackE * mix(vec3(1.0), fc, glass == 1 ? glassAmount : 0.0);
    }
    straight = false;
    nearO = nearE;
    thr *= tint;
    color += thr * haze;
    if (max(thr.r, max(thr.g, thr.b)) * tubeMax < 0.02) break;
  }
  // What the remaining bounces would have added, on average.
  if (alive) color += thr * tail;
  if (cut.x >= 0.0) color = mix(cut, color, lastWeight);
  return vec4(color, 1.0);
}

// Octahedral map of directions to [0, 1]^2.
vec2 octEncode(vec3 n) {
  n /= abs(n.x) + abs(n.y) + abs(n.z);
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return n.xy * 0.5 + 0.5;
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Light the haze scatters towards the eye along a ray from o, over [0, T]: equiangular samples around the sculpture,
// each lit through the window its direction from the centre goes out of (or not, behind a bar).
vec3 hazeAlong(vec3 o, vec3 d, float T) {
  if (fog <= 0.0) return vec3(0.0);
  vec3 c = sculptCenter;
  float delta = dot(c - o, d);
  float D = max(length(o + d * delta - c), 0.02);
  float ta = atan(-delta, D), tb = atan(min(T, 60.0) - delta, D);
  if (tb <= ta) return vec3(0.0);
  mat3 toLocal = transpose(sculptRot);
  // Varies between the frames the pipeline averages while still.
  float j0 = ign(gl_FragCoord.xy + jitter * 1731.0);
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 6; k++) {
    float t = delta + D * tan(mix(ta, tb, (float(k) + j0) / 6.0));
    vec3 q = toLocal * (o + d * t - c) / sculptScale;
    float r = length(q);
    if (r < 1e-3) continue;
    // The window this direction leaves through and how far inside it, baked per direction.
    vec2 e = octEncode(q / r);
    float cover = textureLod(dirMap, e, 0.0).r;
    if (cover <= 0.0) continue;
    int f = int(floor(texelFetch(dirMap, ivec2(min(e * dirSize, vec2(dirSize - 1.0))), 0).g + 0.5));
    if (f < 0) continue;
    float lit = cover * texelFetch(faceData, ivec2(f, 0), 0).z;
    sum += lit * (pattern == 1 ? paletteAt(int(faceSeed(f))) : meanColor);
  }
  return fog * fogColor * (tb - ta) / D * sum / 6.0;
}

void main() {
  vec2 uv = vUv;
  vec4 scene = texture(tScene, uv);
  vec4 far = inverseViewProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 view = normalize(far.xyz / far.w - cameraPos);
  float depth = textureLod(tDepth, uv, 0.0).r;
  vec4 wp = inverseViewProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 surface = wp.xyz / wp.w;
  float tLimit = depth >= 1.0 ? 1e9 : length(surface - cameraPos);
  // The camera ray, and on a glossy floor its mirror image: one call site for the tracer.
  bool onFloor = floorGloss > 0.0 && depth < 1.0 && abs(surface.y - floorY) < 2e-3 + 2e-3 * tLimit && view.y < 0.0;
  // Rays: 0 through the pixel's centre; 1-2 more across it where the path went deep (fine lattices); 3 the floor's
  // mirror image. One call site for the tracer.
  float tFirst = tLimit;
  vec3 sum = vec3(0.0), floorLight = vec3(0.0);
  float count = 0.0;
  bool deep = false;
  for (int k = 0; k < 4; k++) {
    if (k >= 1 && k <= 2 && !deep) continue;
    if (k == 3 && !onFloor) break;
    bool mirrored = k == 3;
    vec3 rd = view, behind = scene.rgb;
    float tLim = tLimit;
    if (k >= 1 && k <= 2) {
      // An offset ray has its own depth and, where it misses, its own raster colour.
      vec2 uvk = uv + (k == 1 ? vec2(0.33, 0.25) : vec2(-0.33, -0.25)) * texel;
      vec4 f2 = inverseViewProjection * vec4(uvk * 2.0 - 1.0, 1.0, 1.0);
      rd = normalize(f2.xyz / f2.w - cameraPos);
      float dk = textureLod(tDepth, uvk, 0.0).r;
      vec4 wk = inverseViewProjection * vec4(uvk * 2.0 - 1.0, dk * 2.0 - 1.0, 1.0);
      tLim = dk >= 1.0 ? 1e9 : length(wk.xyz / wk.w - cameraPos);
      behind = textureLod(tScene, uvk, 0.0).rgb;
    }
    if (mirrored) {
      rd = reflect(view, vec3(0.0, 1.0, 0.0));
      behind = roomGlow;
    }
    float tEntry, used;
    vec4 c = traceSculpture(mirrored ? surface : cameraPos, rd, mirrored ? 1e9 : tLim, mirrored ? tLimit : 0.0, mirrored ? floorRough : 0.0, behind, tEntry, used);
    if (mirrored) {
      // A satin floor: Fresnel from a dielectric, more at grazing angles.
      float F = 0.04 + 0.96 * pow(1.0 - max(-view.y, 0.0), 5.0);
      floorLight = c.rgb * c.a * F * floorGloss;
    } else {
      sum += c.a > 0.0 ? c.rgb : behind;
      count += 1.0;
      if (k == 0) {
        if (c.a > 0.0) tFirst = tEntry;
        // Extra rays only where they show: not while the pipeline already averages jittered frames, nor where
        // depth of field blurs the pixel anyway.
        float z = tEntry * max(dot(view, cameraForward), 1e-3);
        float blur = cocScale * abs(1.0 - dofFocus / z);
        deep = c.a > 0.0 && used >= float(deepStart) && jitter == vec2(0.0) && blur < 1.0;
      }
    }
  }
  vec3 color = sum / count + floorLight;
  color += hazeAlong(cameraPos, view, tFirst);
  outColor = vec4(color, 1.0);
}
`;

// Per direction from the sculpture's centre (octahedral map, sculpture space): the face that direction leaves
// through (g), and how far inside that face's window it does, softened like light from tubes spread over the
// window (r). It only changes with the solid.
const directionShader = /* glsl */ `
precision highp float;
precision highp int;
#define MAX_FACES ${MAX_FACES}
uniform vec4 planes[MAX_FACES];
uniform int faceCount;
uniform highp sampler2D faceData;
uniform highp sampler2D facePresence;
uniform float dirSize;
layout(location = 0) out vec4 outColor;

vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

void main() {
  vec3 u = octDecode(gl_FragCoord.xy / dirSize);
  float best = 1e9;
  int f = -1;
  for (int j = 0; j < faceCount; j++) {
    float dn = dot(planes[j].xyz, u);
    if (dn > 1e-4 && planes[j].w / dn < best) { best = planes[j].w / dn; f = j; }
  }
  if (f < 0) { outColor = vec4(0.0, -1.0, 0.0, 1.0); return; }
  vec3 p = u * best;
  float fw = texelFetch(faceData, ivec2(f, 0), 0).w;
  float margin = 1e9;
  for (int j = 0; j < faceCount; j++) {
    float dj = planes[j].w - dot(planes[j].xyz, p);
    // Planes farther than this can't bring the margin under the smoothstep's top.
    if (j == f || dj >= fw + 0.06) continue;
    float c2 = dot(planes[f].xyz, planes[j].xyz);
    float sj = sqrt(max(1.0 - c2 * c2, 0.0));
    // A fading sliver's plane counts for less: as it goes, its margin grows out of reach.
    if (sj > 1e-6) margin = min(margin, dj / max(texelFetch(facePresence, ivec2(j, 0), 0).x, 1e-3) - fw * sj);
  }
  outColor = vec4(smoothstep(-0.02, 0.06, margin), float(f), 0.0, 1.0);
}
`;

const MAX_INNER_TUBES = 512;

const target = () =>
  new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
  });

// Tube i's ends into texels 2i and 2i + 1, its length in the first one's w.
// fade: how much of the tube is there (0 to 1), for tubes growing in or shrinking away.
function writeTube(data, i, a, b, fade = 1) {
  const k = i * 8;
  data[k] = a.x;
  data[k + 1] = a.y;
  data[k + 2] = a.z;
  data[k + 3] = Math.max(a.distanceTo(b), 1e-6);
  data[k + 4] = b.x;
  data[k + 5] = b.y;
  data[k + 6] = b.z;
  data[k + 7] = fade;
}

// The pipeline's composite pass: the sculpture's inside, laid over the lit image where its windows show.
const dataTexture = (width) => {
  const t = new DataTexture(new Float32Array(width * 4), width, 1, RGBAFormat, FloatType);
  t.minFilter = t.magFilter = NearestFilter;
  return t;
};
const _v = new Vector3(), _a = new Vector3(), _b = new Vector3();

class InfinityPass {
  // dirSize: the side of the per-direction map.
  constructor({ dirSize = 256 } = {}) {
    this.output = target();
    this.tubeTexture = dataTexture(MAX_TUBES * 2);
    this.faceTexture = dataTexture(MAX_FACES);
    this.presenceTexture = dataTexture(MAX_FACES);
    this.innerTexture = dataTexture(MAX_INNER_TUBES * 2);
    this.dirTarget = new WebGLRenderTarget(dirSize, dirSize, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      colorSpace: NoColorSpace,
      depthBuffer: false,
    });
    this.dirDirty = true;
    // Light of each window, 0 to 1.
    this.faceLight = new Float32Array(MAX_FACES).fill(1);
    // Animation of each window's light, 0 to 1.
    this.faceAnim = new Float32Array(MAX_FACES).fill(1);
    this.faceFade = new Float32Array(MAX_FACES).fill(1);
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        inverseViewProjection: { value: new Matrix4() },
        cameraPos: { value: new Vector3() },
        planes: { value: Array.from({ length: MAX_FACES }, () => new Vector4()) },
        faceCount: { value: 0 },
        tubes: { value: this.tubeTexture },
        faceData: { value: this.faceTexture },
        facePresence: { value: this.presenceTexture },
        innerTubes: { value: this.innerTexture },
        dirMap: { value: this.dirTarget.texture },
        dirSize: { value: dirSize },
        innerBound: { value: 0 },
        floorY: { value: -1 },
        floorGloss: { value: 0 },
        floorRough: { value: 0.02 },
        roomGlow: { value: new Vector3() },
        fog: { value: 0 },
        fogColor: { value: new Vector3() },
        meanColor: { value: new Vector3(1, 1, 1) },
        chase: { value: 0 },
        tubeType: { value: 0 },
        deepStart: { value: 99 },
        texel: { value: new Vector2() },
        cameraForward: { value: new Vector3() },
        cocScale: { value: 0 },
        dofFocus: { value: 1 },
        jitter: globalUniforms.jitter,
        glass: { value: 0 },
        glassAmount: { value: 0.5 },
        nodeRadius: { value: 0 },
        innerPlanes: { value: Array.from({ length: 64 }, () => new Vector4()) },
        innerCount: { value: 0 },
        innerTubeCount: { value: 0 },
        innerTubeRadius: { value: 0.008 },
        tubeReach: { value: 0.06 },
        pixelAngle: { value: 0.001 },
        aberration: { value: 0 },
        maxFootprint: { value: 0.033 },
        tubeMax: { value: 10 },
        haze: { value: new Vector3() },
        tail: { value: new Vector3() },
        boundRadius: { value: 1.05 },
        palette: { value: Array.from({ length: 4 }, () => new Vector3(1, 1, 1)) },
        paletteCount: { value: 1 },
        pattern: { value: 0 },
        segments: { value: 4 },
        gap: { value: 0 },
        warp: { value: 0 },
        ripple: { value: 0 },
        tilt: { value: 0 },
        uneven: { value: 0 },
        tubeRadius: { value: 0.016 },
        tubeColor: { value: new Vector3(6, 6.4, 6.1) },
        frameWidth: { value: 0.085 },
        frameBack: { value: new Vector3(0.02, 0.02, 0.02) },
        sculptRot: { value: new Matrix3() },
        sculptCenter: { value: new Vector3() },
        sculptScale: { value: 1 },
        outerReflect: { value: 0.3 },
        outerTransmit: { value: 0.35 },
        innerReflect: { value: 0.9 },
        glassTint: { value: new Vector3(0.86, 0.96, 0.91) },
        bounces: { value: 24 },
        lastWeight: { value: 1 },
        envMap: globalUniforms.envMap,
        envRotation: globalUniforms.envRotation,
        envIntensity: globalUniforms.envIntensity,
        envMapMaxLod: globalUniforms.envMapMaxLod,
      },
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._vp = new Matrix4();
    const u = this.material.uniforms;
    this.dirMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader: directionShader,
      depthTest: false,
      depthWrite: false,
      uniforms: { planes: u.planes, faceCount: u.faceCount, faceData: u.faceData, facePresence: u.facePresence, dirSize: u.dirSize },
    });
    const dirQuad = new Mesh(geometry, this.dirMaterial);
    dirQuad.frustumCulled = false;
    this.dirScene = new Scene();
    this.dirScene.add(dirQuad);
  }

  setSculpture(s) {
    const u = this.material.uniforms;
    s.faces.forEach((f, i) => u.planes.value[i].set(f.n.x, f.n.y, f.n.z, f.d));
    u.faceCount.value = s.faces.length;
    const data = this.tubeTexture.image.data, faces = this.faceTexture.image.data;
    faces.fill(0);
    const count = Math.min(s.tubes.length, MAX_TUBES);
    for (let i = 0; i < count; i++) {
      const [a, b, f, fade] = s.tubes[i];
      writeTube(data, i, a, b, fade);
      if (faces[f * 4 + 1] === 0) faces[f * 4] = i;
      faces[f * 4 + 1]++;
    }
    s.widths.forEach((w, f) => f < MAX_FACES && (faces[f * 4 + 3] = w));
    const presence = this.presenceTexture.image.data;
    presence.fill(0);
    s.faces.forEach((face, f) => {
      if (f >= MAX_FACES) return;
      presence[f * 4] = s.presence[f];
      const n = face.n, k = Math.round(n.x * 1000) * 0.0731 + Math.round(n.y * 1000) * 0.0517 + Math.round(n.z * 1000) * 0.0389;
      presence[f * 4 + 1] = Math.floor(((Math.sin(k) * 43758.5453) % 1 + 1) % 1 * 1000);
    });
    this.presenceTexture.needsUpdate = true;
    this.faceFade.fill(1);
    s.fades.forEach((x, f) => f < MAX_FACES && (this.faceFade[f] = x));
    this.writeLights();
    this.tubeTexture.needsUpdate = true;
    this.dirDirty = true;
    u.maxFootprint.value = 3 * s.tube.radius;
    u.nodeRadius.value = 1.7 * s.tube.radius;
    u.tubeReach.value = s.tube.depth + u.nodeRadius.value + 0.5 * u.maxFootprint.value + 1e-3;
    u.boundRadius.value = s.bound;
    u.tubeRadius.value = s.tube.radius;
    u.frameWidth.value = s.w;
  }

  // Window lights (0 off to 1 on) into the per-face texture.
  writeLights() {
    const data = this.faceTexture.image.data;
    for (let f = 0; f < MAX_FACES; f++) data[f * 4 + 2] = this.faceLight[f] * this.faceAnim[f] * this.faceFade[f];
    this.faceTexture.needsUpdate = true;
  }

  // The nested solid ({ planes, edges } of circumradius 1, or null), turned by q and scaled by s into the
  // sculpture's space.
  // fade: how much of its tubes is there, as it grows in or shrinks away.
  setInner(shape, q, s, radius, fade = 1) {
    const u = this.material.uniforms;
    if (!shape) {
      u.innerCount.value = u.innerTubeCount.value = 0;
      return;
    }
    shape.planes.forEach((p, i) => {
      _v.copy(p.n).applyQuaternion(q);
      u.innerPlanes.value[i].set(_v.x, _v.y, _v.z, p.d * s);
    });
    u.innerCount.value = shape.planes.length;
    const data = this.innerTexture.image.data;
    let count = Math.min(shape.edges.length, MAX_INNER_TUBES);
    for (let i = 0; i < count; i++) {
      const [a, b] = shape.edges[i];
      writeTube(data, i, _a.copy(a).applyQuaternion(q).multiplyScalar(s), _b.copy(b).applyQuaternion(q).multiplyScalar(s), fade);
    }
    // Links: tubes given end to end in the sculpture's space, e.g. joining the nested solid to the outer one.
    let reach = s;
    for (const [a, b] of shape.links ?? []) {
      if (count >= MAX_INNER_TUBES) break;
      writeTube(data, count++, _a.copy(a).applyQuaternion(q).multiplyScalar(s), _b.copy(b), fade);
      reach = Math.max(reach, b.length());
    }
    u.innerTubeCount.value = count;
    u.innerTubeRadius.value = radius;
    u.innerBound.value = reach + radius + 0.5 * u.maxFootprint.value + 1e-3;
    this.innerTexture.needsUpdate = true;
  }

  // Renders the per-direction map if the solid changed; before the frame, as the room's light reads it too.
  bake(renderer) {
    if (!this.dirDirty) return;
    this.dirDirty = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.dirTarget);
    renderer.render(this.dirScene, this.camera);
    renderer.setRenderTarget(prev);
  }

  compile(renderer) {
    return Promise.all([renderer.compileAsync(this.scene, this.camera), renderer.compileAsync(this.dirScene, this.camera)]);
  }

  render(renderer, hdr, { depthTexture, camera, width, height }) {
    if (this.output.width !== width || this.output.height !== height) this.output.setSize(width, height);
    const u = this.material.uniforms;
    u.tScene.value = hdr;
    u.tDepth.value = depthTexture;
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.inverseViewProjection.value.copy(this._vp).invert();
    u.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.texel.value.set(1 / width, 1 / height);
    camera.getWorldDirection(u.cameraForward.value);
    u.cocScale.value = this.dofOn?.() ? (this.dof?.aperture ?? 0) * height : 0;
    u.dofFocus.value = this.dof?.focus ?? 1;
    u.pixelAngle.value = (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / (camera.zoom * height);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.output);
    renderer.render(this.scene, this.camera);
    this.afterTrace?.(renderer, camera);
    renderer.setRenderTarget(prev);
    return this.output.texture;
  }
}

export { InfinityPass };
