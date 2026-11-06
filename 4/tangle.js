import {
  WebGLRenderTarget,
  FloatType,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  Scene,
  OrthographicCamera,
  DataTexture,
  Sphere,
  Color,
  Vector2,
  Vector3,
  Vector4,
  Matrix4,
} from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { MAX_TUBES, SAMPLES } from "./knots.js";

// The coil is an ordinary mesh: one ring-and-sides band per curve, its rings placed on the band's
// rounded-rectangle section, whose vertices are pulled onto the merged distance field (bands
// smooth-unioned) once per frame in a GPU pass. The pass
// writes position and normal per vertex into float textures; the material's displace() fetches
// them, and last frame's positions give the prepass its velocity. A coarse distance volume, baked
// in the same update, lets the chrome trace one reflection ray so the tubes mirror each other.

const CHUNK = 8;
const _clearColor = new Color();
const CHUNKS = SAMPLES / CHUNK;
// Corner radius as a fraction of the half-thickness, and how much denser the outline is around corners;
// relief depths of the section shapes at full amount, in half-thicknesses, and flutes per face.
const SECTION_DEFINES = { CORNER: "0.8", CORNER_DENSITY: "2.0", PINCH: "0.45", PINCH_OUT: "0.18", FLUTE: "0.1", FLUTES: "3.0", LENS: "0.5" };

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Rounded-rectangle section of a band, its outline pushed along the normal by the relief of the shapes
// weighted in sectionShape; a point off the outline takes the relief of its nearest point on the rectangle.
const SECTION = /* glsl */ `
uniform vec3 sectionShape; // pinched, fluted, lens

// Relief on a wide face at u = x / its half-length: offset along the normal (x) and its rate in u (y).
vec2 reliefFace(float u, float ht) {
  float v = 1.0 - u * u;
  float a = 1.5707963 * FLUTES * (u + 1.0);
  float sa = sin(a), ca = cos(a);
  float off = -sectionShape.x * PINCH * v * v - sectionShape.y * FLUTE * sa * sa - sectionShape.z * LENS * (1.0 - v * v);
  float rate = 4.0 * u * v * (sectionShape.x * PINCH - sectionShape.z * LENS) - sectionShape.y * FLUTE * 3.1415927 * FLUTES * sa * ca;
  return ht * vec2(off, rate);
}

// Relief on a corner arc at unit normal n (first quadrant): offset (x) and its rate in angle (y).
vec2 reliefArc(vec2 n, float ht) {
  float s2 = 2.0 * n.x * n.y, c2 = n.x * n.x - n.y * n.y;
  return ht * vec2(sectionShape.x * PINCH_OUT * s2 * s2 - sectionShape.z * LENS, sectionShape.x * PINCH_OUT * 4.0 * s2 * c2);
}

vec3 section(vec2 q, vec2 h) {
  float rc = h.y * CORNER;
  vec2 s = vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0);
  vec2 e = h - rc;
  vec2 d = abs(q) - e;
  vec3 r;
  if (d.x > 0.0 && d.y > 0.0) {
    float l = length(d);
    vec2 n = d / l;
    vec2 k = reliefArc(n, h.y);
    r = vec3(n - k.y / max(l, 0.25 * rc) * vec2(-n.y, n.x), l - rc - k.x);
  } else if (d.x > d.y) {
    r = vec3(1.0, 0.0, d.x - rc + sectionShape.z * LENS * h.y);
  } else {
    float ex = max(e.x, 1e-5);
    vec2 k = reliefFace(clamp(abs(q.x) / ex, 0.0, 1.0), h.y);
    r = vec3(-k.y / ex, 1.0, d.y - rc - k.x);
  }
  return vec3(s * r.xy, r.z) * inversesqrt(dot(r.xy, r.xy));
}

// Point (xy) and normal (zw) at fraction f of the outline, one quarter per quadrant.
vec4 outline(float f, vec2 h) {
  float rc = h.y * CORNER;
  vec2 e = h - rc;
  float arc = 1.5707963 * rc * CORNER_DENSITY;
  float k = floor(f * 4.0);
  float g = fract(f * 4.0);
  if (mod(k, 2.0) == 1.0) g = 1.0 - g;
  float t = g * (e.y + arc + e.x);
  vec4 r;
  if (t < e.y) r = vec4(h.x - sectionShape.z * LENS * h.y, t, 1.0, 0.0);
  else if (t < e.y + arc) {
    float a = (t - e.y) / arc * 1.5707963;
    vec2 n = vec2(cos(a), sin(a));
    vec2 o = reliefArc(n, h.y);
    r = vec4(e + (rc + o.x) * n, normalize(n - o.y / max(rc + o.x, 0.25 * rc) * vec2(-n.y, n.x)));
  } else {
    float x = e.x - (t - e.y - arc);
    float ex = max(e.x, 1e-5);
    vec2 o = reliefFace(clamp(x / ex, 0.0, 1.0), h.y);
    r = vec4(x, h.y + o.x, normalize(vec2(-o.y / ex, 1.0)));
  }
  vec2 m = vec2(k == 1.0 || k == 2.0 ? -1.0 : 1.0, k >= 2.0 ? -1.0 : 1.0);
  return r * m.xyxy;
}
`;

// The exact field of the bands, shared by the projection and the colour pass: quadratic Bezier
// pieces between sample midpoints with the rounded-rectangle section swept along them.
const FIELD = /* glsl */ `
float dot2(vec3 v) { return dot(v, v); }

float capsule(vec3 p, vec4 a, vec4 b) {
  vec3 pa = p - a.xyz, ba = b.xyz - a.xyz;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(a.w, b.w, h);
}

// Distance to a quadratic Bezier and the curve parameter of the closest point (Inigo Quilez).
vec2 bezier(vec3 pos, vec3 A, vec3 B, vec3 C) {
  vec3 a = B - A;
  vec3 b = A - 2.0 * B + C + vec3(1e-5);
  vec3 c = a * 2.0;
  vec3 d = A - pos;
  float kk = 1.0 / max(dot(b, b), 1e-12);
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float p = ky - kx * kx;
  float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = q * q + 4.0 * p * p * p;
  vec2 res;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    res = vec2(dot2(d + (c + b * t) * t), t);
  } else {
    float z = sqrt(-p);
    float v = acos(clamp(q / min(p * z * 2.0, -1e-30), -1.0, 1.0)) / 3.0;
    float m = cos(v);
    float n = sin(v) * 1.732050808;
    vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
    float dx = dot2(d + (c + b * t.x) * t.x);
    float dy = dot2(d + (c + b * t.y) * t.y);
    res = dx < dy ? vec2(dx, t.x) : vec2(dy, t.y);
  }
  return vec2(sqrt(res.x), res.y);
}

${SECTION}

vec4 curveAt(int t, int i) { return texelFetch(tCurve, ivec2((i + ${SAMPLES}) % ${SAMPLES}, t), 0); }
vec4 frameAt(int t, int i) { return texelFetch(tCurve, ivec2((i + ${SAMPLES}) % ${SAMPLES}, t + ${MAX_TUBES}), 0); }

// Keeps in best (centreline distance, parameter, sample) the nearer of it and segment i: the
// quadratic Bezier from the midpoint before sample i to the midpoint after.
void closest(vec3 p, vec4 prev, vec4 cur, vec4 next, int i, inout vec3 best) {
  vec2 dt = bezier(p, 0.5 * (prev.xyz + cur.xyz), cur.xyz, 0.5 * (cur.xyz + next.xyz));
  if (dt.x < best.x) best = vec3(dt, float(i));
}

// The swept section of band t around its closest centreline point: gradient (xyz), distance (w).
// The gradient includes how the frame turns and the section changes along the band.
vec4 band(vec3 p, int t, vec3 best) {
  int i = int(best.z);
  float u = best.y;
  vec4 c1 = curveAt(t, i), f1 = frameAt(t, i);
  vec4 A = 0.5 * (curveAt(t, i - 1) + c1), C = 0.5 * (c1 + curveAt(t, i + 1));
  vec4 FA = 0.5 * (frameAt(t, i - 1) + f1), FC = 0.5 * (f1 + frameAt(t, i + 1));
  vec4 q = mix(mix(A, c1, u), mix(c1, C, u), u);
  vec4 dq = 2.0 * mix(c1 - A, C - c1, u);
  vec4 f = mix(mix(FA, f1, u), mix(f1, FC, u), u);
  vec4 df = 2.0 * mix(f1 - FA, FC - f1, u);
  float l2 = max(dot(dq.xyz, dq.xyz), 1e-10);
  vec3 T = dq.xyz * inversesqrt(l2);
  vec3 w = f.xyz - dot(f.xyz, T) * T;
  float wl = max(length(w), 1e-6);
  w /= wl;
  vec3 b = cross(T, w);
  vec3 o = p - q.xyz;
  vec2 x = vec2(dot(o, w), dot(o, b));
  vec3 g = section(x, vec2(q.w, f.w));
  float twist = dot(b, df.xyz) / wl;
  float along = g.x * (x.y * twist - sign(x.x) * dq.w) - g.y * (x.x * twist + sign(x.y) * df.w);
  return vec4(g.x * w + g.y * b + along * dq.xyz / l2, g.z);
}

// Distance to the stretch of band t within LOCAL samples of i0.
vec4 localBand(vec3 p, int t, int i0) {
  vec3 best = vec3(1e9, 0.0, 0.0);
  vec4 prev = curveAt(t, i0 - LOCAL - 1);
  vec4 cur = curveAt(t, i0 - LOCAL);
  for (int k = -LOCAL; k <= LOCAL; k++) {
    vec4 next = curveAt(t, i0 + k + 1);
    closest(p, prev, cur, next, i0 + k, best);
    prev = cur;
    cur = next;
  }
  return band(p, t, best);
}

// Segments of each band within reach of a point, as 128-bit masks (found once, before the iterations).
uvec4 near[${MAX_TUBES}];

// Marks in near the segments of every band but skip within reach of p; capsules bound them.
bool gather(vec3 p, float reach, int skip) {
  bool found = false;
  for (int t = 0; t < ${MAX_TUBES}; t++) {
    near[t] = uvec4(0u);
    if (t >= tubeCount || t == skip || reach <= 0.0) continue;
    for (int k = 0; k < ${CHUNKS}; k++) {
      vec4 ch = chunks[t * ${CHUNKS} + k];
      if (length(p - ch.xyz) - ch.w >= reach) continue;
      vec4 s0 = curveAt(t, k * ${CHUNK});
      for (int j = 0; j < ${CHUNK}; j++) {
        int i = k * ${CHUNK} + j;
        vec4 s1 = curveAt(t, i + 1);
        // The capsule from sample i to i + 1 bounds the halves of segments i and i + 1 it spans.
        if (capsule(p, s0, s1) < reach) {
          int i1 = (i + 1) % ${SAMPLES};
          near[t][i >> 5] |= 1u << uint(i & 31);
          near[t][i1 >> 5] |= 1u << uint(i1 & 31);
          found = true;
        }
        s0 = s1;
      }
    }
  }
  return found;
}

// Band t's nearest centreline point (distance, parameter, sample) over its segments in reach.
vec3 nearestIn(vec3 p, int t) {
  vec3 best = vec3(1e9, 0.0, 0.0);
  for (int w = 0; w < 4; w++) {
    uint m = near[t][w];
    while (m != 0u) {
      uint bit = m & (~m + 1u);
      m ^= bit;
      int i = w * 32 + int(log2(float(bit)) + 0.5);
      closest(p, curveAt(t, i - 1), curveAt(t, i), curveAt(t, i + 1), i, best);
    }
  }
  return best;
}

vec4 tube(vec3 p, int t) { return band(p, t, nearestIn(p, t)); }

// d smooth-unioned with b (the polynomial smin) where d is the nearer one; where b is nearer, a C1
// continuation that stays inside the union and saturates, so vertices never jump onto b's surface.
vec4 swell(vec4 d, vec4 b) {
  float x = d.w - b.w;
  if (blend < 1e-4 || x <= -blend) return d;
  float s, ds;
  if (x <= 0.0) {
    s = (blend + x) * (blend + x) / (4.0 * blend);
    ds = (blend + x) / (2.0 * blend);
  } else {
    float th = tanh(min(x / blend, 15.0));
    s = blend * (0.25 + 0.5 * th);
    ds = 0.5 * (1.0 - th * th);
  }
  return vec4(d.xyz - ds * (d.xyz - b.xyz), d.w - s);
}
`;

const PROJECT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tCurve;
uniform sampler2D tRings;
uniform vec4 chunks[${MAX_TUBES * CHUNKS}];
uniform int tubeCount;
uniform float blend;
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outNormal;

${FIELD}

// The field this vertex's band contributes, with its gradient: its own stretch of band, swollen by
// the smin blend toward the other bands but never replaced by them. Every band is drawn closed and
// the depth test takes the union.
vec4 field(vec3 p, int own, int i0) {
  vec4 d = localBand(p, own, i0);
  for (int t = 0; t < ${MAX_TUBES}; t++) {
    if (any(notEqual(near[t], uvec4(0u)))) d = swell(d, tube(p, t));
  }
  return d;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int own = px.y / RINGS;
  int ring = px.y - own * RINGS;
  if (own >= tubeCount) {
    outPosition = vec4(0.0, 0.0, 0.0, -1.0);
    outNormal = vec4(0.0, 1.0, 0.0, -1.0);
    return;
  }
  vec4 c = texelFetch(tRings, ivec2(ring, own * 4), 0);
  vec4 w = texelFetch(tRings, ivec2(ring, own * 4 + 1), 0);
  vec4 T = texelFetch(tRings, ivec2(ring, own * 4 + 2), 0);
  vec2 dh = texelFetch(tRings, ivec2(ring, own * 4 + 3), 0).xy;
  vec3 b = cross(T.xyz, w.xyz);
  // The band alone: the vertex sits on its section, with the normal of the swept surface.
  vec4 o = outline((float(px.x) + 0.5 * float(ring & 1)) / float(SIDES), vec2(c.w, w.w));
  vec3 p = c.xyz + o.x * w.xyz + o.y * b;
  float along = o.z * (o.y * T.w - sign(o.x) * dh.x) - o.w * (o.x * T.w + sign(o.y) * dh.y);
  vec3 n0 = normalize(o.z * w.xyz + o.w * b + along * T.xyz);
  int i0 = int(floor(float(ring * ${SAMPLES}) / float(RINGS) + 0.5)) % ${SAMPLES};
  // Only stretches of other bands close enough to swell this vertex count.
  bool found = gather(p, blend < 1e-4 ? 0.0 : blend * 1.75 + 0.02, own);
  // w: the nearest sample of the two other bands nearest the vertex (band * SAMPLES + sample, -1
  // for none), so the colour pass can swell the surface the same way.
  if (!found) {
    outPosition = vec4(p, -1.0);
    outNormal = vec4(n0, -1.0);
    return;
  }

  // Newton steps onto field = 0; the last gradient gives the normal.
  vec3 g = n0;
  for (int i = 0; i < ITERATIONS; i++) {
    vec4 f = field(p, own, i0);
    float g2 = dot(f.xyz, f.xyz);
    if (g2 < 1e-4) break;
    g = f.xyz;
    p -= clamp(f.w / g2, -0.1, 0.1) * f.xyz;
  }
  vec2 ids = vec2(-1.0), dist = vec2(1e9);
  for (int t = 0; t < ${MAX_TUBES}; t++) {
    if (all(equal(near[t], uvec4(0u)))) continue;
    vec3 best = nearestIn(p, t);
    float id = float(t * ${SAMPLES}) + best.z;
    if (best.x < dist.x) {
      dist = vec2(best.x, dist.x);
      ids = vec2(id, ids.x);
    } else if (best.x < dist.y) {
      dist.y = best.x;
      ids.y = id;
    }
  }
  outPosition = vec4(p, ids.x);
  outNormal = vec4(normalize(g), ids.y);
}
`;

// The merged field, coarsely (nearest sample found on straight segments), for the reflection volume:
// VOL^3 voxels stored as an atlas of slices, VOL_TILES to a row.
const BAKE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tCurve;
uniform vec4 chunks[${MAX_TUBES * CHUNKS}];
uniform int tubeCount;
uniform float blend;
uniform vec4 volumeBox;
out vec4 outColor;

vec3 safeNormalize(vec3 v, vec3 fallback) {
  float l2 = dot(v, v);
  return l2 > 1e-20 ? v * inversesqrt(l2) : fallback;
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / max(k, 1e-5);
  return min(a, b) - h * h * k * 0.25;
}

${SECTION}

float capsule(vec3 p, vec4 a, vec4 b) {
  vec3 pa = p - a.xyz, ba = b.xyz - a.xyz;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(a.w, b.w, h);
}

// The section is placed on the same quadratic Bezier pieces (midpoint to midpoint) the mesh is
// projected onto, so the field has no creases at the samples. pv and nx are the samples around a, b.
float swept(vec3 p, vec4 pv, vec4 a, vec4 b, vec4 nx, vec4 fpv, vec4 fa, vec4 fb, vec4 fnx) {
  vec3 ba = b.xyz - a.xyz;
  float l2 = max(dot(ba, ba), 1e-8);
  float raw = dot(p - a.xyz, ba) / l2;
  float h = clamp(raw, 0.0, 1.0);
  bool first = h < 0.5;
  vec4 A = 0.5 * (first ? pv + a : a + b), c1 = first ? a : b, C = 0.5 * (first ? a + b : b + nx);
  vec4 FA = 0.5 * (first ? fpv + fa : fa + fb), f1 = first ? fa : fb, FC = 0.5 * (first ? fa + fb : fb + fnx);
  float u = first ? h + 0.5 : h - 0.5;
  vec4 q = mix(mix(A, c1, u), mix(c1, C, u), u);
  vec4 f = mix(mix(FA, f1, u), mix(f1, FC, u), u);
  vec3 T = safeNormalize(mix(c1.xyz - A.xyz, C.xyz - c1.xyz, u), vec3(0.0, 0.0, 1.0));
  vec3 w = safeNormalize(f.xyz - dot(f.xyz, T) * T, abs(T.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0));
  vec3 o = p - q.xyz;
  float d = section(vec2(dot(o, w), dot(o, cross(T, w))), vec2(q.w, f.w)).z;
  // Beyond the segment's ends the overshoot along it counts too, so its tangent line isn't a surface.
  float e = (raw - h) * sqrt(l2);
  return d > 0.0 ? length(vec2(d, e)) : d;
}

// Distances to band t from p and from p one voxel up in z (each slice also stores the next), and
// the sample nearest p.
vec2 tube(vec3 p, float dz, int t, vec2 d, inout float seg) {
  vec3 q = p + vec3(0.0, 0.0, dz);
  for (int c = 0; c < ${CHUNKS}; c++) {
    vec4 ch = chunks[t * ${CHUNKS} + c];
    if (length(p - ch.xyz) - ch.w > max(d.x, d.y) + dz) continue;
    int i0 = c * ${CHUNK} + ${SAMPLES};
    vec4 pv = texelFetch(tCurve, ivec2((i0 - 1) % ${SAMPLES}, t), 0);
    vec4 fpv = texelFetch(tCurve, ivec2((i0 - 1) % ${SAMPLES}, t + ${MAX_TUBES}), 0);
    vec4 a = texelFetch(tCurve, ivec2(i0 % ${SAMPLES}, t), 0);
    vec4 fa = texelFetch(tCurve, ivec2(i0 % ${SAMPLES}, t + ${MAX_TUBES}), 0);
    vec4 b = texelFetch(tCurve, ivec2((i0 + 1) % ${SAMPLES}, t), 0);
    vec4 fb = texelFetch(tCurve, ivec2((i0 + 1) % ${SAMPLES}, t + ${MAX_TUBES}), 0);
    for (int j = 1; j <= ${CHUNK}; j++) {
      int i = (i0 + j + 1) % ${SAMPLES};
      vec4 nx = texelFetch(tCurve, ivec2(i, t), 0);
      vec4 fnx = texelFetch(tCurve, ivec2(i, t + ${MAX_TUBES}), 0);
      // The capsule around the section's half-width is a lower bound; only beat it when it may win.
      if (min(capsule(p, a, b) - d.x, capsule(q, a, b) - d.y) < 0.0) {
        float e = swept(p, pv, a, b, nx, fpv, fa, fb, fnx);
        if (e < d.x) {
          d.x = e;
          seg = float((i0 + j - 1) % ${SAMPLES});
        }
        d.y = min(d.y, swept(q, pv, a, b, nx, fpv, fa, fb, fnx));
      }
      pv = a;
      fpv = fa;
      a = b;
      fa = fb;
      b = nx;
      fb = fnx;
    }
  }
  return d;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 tile = px / VOL;
  vec3 v = vec3(px - tile * VOL, tile.y * VOL_TILES + tile.x);
  float voxel = volumeBox.w / float(VOL);
  vec3 p = volumeBox.xyz + (v + 0.5) * voxel;
  // Beyond a few voxels the chunks' bounding spheres give the distance (a lower bound), so far
  // voxels skip the segments.
  float bound = 1e9;
  for (int k = 0; k < ${MAX_TUBES * CHUNKS}; k++) {
    if (k >= tubeCount * ${CHUNKS}) break;
    bound = min(bound, length(p - chunks[k].xyz) - chunks[k].w);
  }
  bound -= 0.25 * blend;
  float cap = 8.0 * voxel;
  if (bound > cap) {
    outColor = vec4(min(bound, 6e4), min(bound, 6e4) - voxel, -1.0, -1.0);
    return;
  }
  vec2 d = vec2(cap);
  // The nearest sample of the two nearest bands (band * SAMPLES + sample, -1 for none), from which
  // the reflections evaluate the exact field around a hit.
  vec2 near = vec2(1e9), ids = vec2(-1.0);
  for (int t = 0; t < ${MAX_TUBES}; t++) {
    if (t >= tubeCount) break;
    float seg = -1.0;
    // Two voxels past the blend, so a band a hit anywhere in this voxel may blend with is found.
    vec2 e = tube(p, voxel, t, d + blend + 2.0 * voxel, seg);
    if (seg >= 0.0) {
      float id = float(t * ${SAMPLES}) + seg;
      if (e.x < near.x) {
        near = vec2(e.x, near.x);
        ids = vec2(id, ids.x);
      } else if (e.x < near.y) {
        near.y = e.x;
        ids.y = id;
      }
    }
    d = vec2(smin(d.x, e.x, blend), smin(d.y, e.y, blend));
  }
  outColor = vec4(max(d, vec2(bound, bound - voxel)), ids);
}
`;

const CHROME_PARS = /* glsl */ `
uniform vec3 tint;
uniform float chromeRoughness;
uniform vec2 filmRange; // thickness in nm, thin to thick
uniform float filmIor;
uniform vec3 filmWavelengths; // nm, at which red, green and blue are evaluated
uniform float filmStrength;
uniform vec2 filmShape; // power that deepens the hues, gain
uniform float filmFlow;
uniform float filmFacing; // how far the surface orientation shifts the thickness
uniform float filmRim; // how far grazing angles wash the film out to silver
uniform vec2 filmLift; // env floor, reflected brightness that washes the film out to silver
uniform vec3 bodyColor;
uniform vec3 absorption;
uniform sampler2D tVolume;
uniform samplerCube backdropMap;
uniform vec4 volumeBox; // min corner, side
uniform highp sampler2D tSceneDepth;
uniform highp sampler2D tCurve;
uniform highp sampler2D tPosition;
uniform highp sampler2D tNormal;
uniform highp sampler2D tReflection;
uniform vec4 chunks[${MAX_TUBES * CHUNKS}];
uniform int tubeCount;
uniform float blend;
uniform vec3 finishWeights; // holographic, pearl, glass

// Non-finite test on the bits, which fast-math can't assume away like isnan.
bool finite4(vec4 c) { return all(lessThan(floatBitsToUint(c) & 0x7f800000u, uvec4(0x7f800000u))); }

// smoothstep's formula, defined for inverted or equal edges as D3D evaluates it.
float sstep(float a, float b, float x) {
  float dd = b - a;
  float t = clamp((x - a) / (abs(dd) < 1e-12 ? 1e-12 : dd), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// 1 / r with exact zeros nudged, so the slab test never multiplies 0 by Inf.
vec3 safeInverse(vec3 r) { return 1.0 / vec3(r.x == 0.0 ? 1e-12 : r.x, r.y == 0.0 ? 1e-12 : r.y, r.z == 0.0 ? 1e-12 : r.z); }

#if FINISH == 3
// Cross-fading: the lean finishes add up here, and the lit colour is scaled by pearl's weight.
vec3 leanColor = vec3(0.0);
#define WEIGHT(i) finishWeights[i]
// Mixed in a compressed range, so a bright finish doesn't swamp a dark one mid-fade.
vec3 blendSpace(vec3 c) { return c / (1.0 + c); }
#else
#define WEIGHT(i) 1.0
#define blendSpace(c) (c)
#endif

${FIELD}

// Band t's centreline point nearest p, by a Newton step from continuous sample position s.
float stepToward(int t, float s, vec3 p) {
  float i = floor(s + 0.5);
  float u = s - i + 0.5;
  int k = int(clamp(i, -float(${SAMPLES}), 2.0 * float(${SAMPLES})));
  vec3 c1 = curveAt(t, k).xyz;
  vec3 A = 0.5 * (curveAt(t, k - 1).xyz + c1), C = 0.5 * (c1 + curveAt(t, k + 1).xyz);
  vec3 c = mix(mix(A, c1, u), mix(c1, C, u), u);
  vec3 dc = 2.0 * mix(c1 - A, C - c1, u);
  return mod(s + clamp(dot(p - c, dc) / max(dot(dc, dc), 1e-10), -2.0, 2.0) + ${SAMPLES}.0, ${SAMPLES}.0);
}

// The swept section of band t around its point nearest p, found by Newton steps from sample i0.
vec4 bandNear(vec3 p, int t, int i0) {
  float s = stepToward(t, stepToward(t, float(i0), p), p);
  float i = floor(s + 0.5);
  return band(p, t, vec3(0.0, s - i + 0.5, i));
}

vec4 smoothUnion(vec4 d, vec4 b) { return d.w <= b.w ? swell(d, b) : swell(b, d); }

// The fragment's own band, which its reflection ray starts from.
int ownBand = -1;

// The normal of the surface the mesh was projected onto, at p. ring: the cos and sin of the
// fragment's ring's and side's angles, which interpolate across the wrap of the indices. The band's closest point is where the ring interpolates to; near other bands the
// surface is swollen toward them as in the projection.
vec3 exactNormal(vec3 p, vec3 n, float bandIndex, vec4 ring) {
  int own = int(bandIndex + 0.5);
  float s = atan(ring.y, ring.x) / 6.2831853 * float(${SAMPLES});
  float i = floor(s + 0.5);
  ownBand = own;
  vec4 d = band(p, own, vec3(0.0, s - i + 0.5, i));
  // The other bands the nearest vertex was swollen toward.
  int r = (int(floor(s * float(RINGS) / float(${SAMPLES}) + 0.5)) + RINGS) % RINGS;
  int k = (int(floor(atan(ring.w, ring.z) / 6.2831853 * float(SIDES) - 0.5 * float(r & 1) + 0.5)) + SIDES) % SIDES;
  ivec2 vertex = ivec2(k, own * RINGS + r);
  int a = int(floor(texelFetch(tPosition, vertex, 0).w + 0.5)), b = int(floor(texelFetch(tNormal, vertex, 0).w + 0.5));
  // Both meshes at a seam shade the same symmetric smooth union, a Newton step from the facet onto the surface.
  for (int it = 0; it < 2 && a >= 0; it++) {
    if (it > 0) {
      p -= d.w * d.xyz / max(dot(d.xyz, d.xyz), 1e-6);
      d = band(p, own, vec3(0.0, s - i + 0.5, i));
    }
    d = smoothUnion(d, bandNear(p, a / ${SAMPLES}, a % ${SAMPLES}));
    if (b >= 0) d = smoothUnion(d, bandNear(p, b / ${SAMPLES}, b % ${SAMPLES}));
  }
  float g2 = dot(d.xyz, d.xyz);
  return g2 > 1e-6 ? d.xyz * inversesqrt(g2) : n;
}

// The ids of the bands nearest p as baked in its voxel (band * SAMPLES + sample, -1 for none).
ivec2 volumeIds(vec3 p) {
  ivec3 v = clamp(ivec3((p - volumeBox.xyz) / volumeBox.w * float(VOL)), 0, VOL - 1);
  ivec2 tile = ivec2(v.z % VOL_TILES, v.z / VOL_TILES);
  return ivec2(floor(texelFetch(tVolume, tile * VOL + v.xy, 0).ba + 0.5));
}

// Set per pixel from the normal's screen derivatives, so curvature the pixel can't resolve widens it.
float specPower = 700.0;
// The least env mip, from how fast the reflected direction turns across the pixel.
float coneLod = 0.0;

vec3 envAt(vec3 r) {
  return textureLod(envMap, envRotation * r, max(envMapMaxLod * chromeRoughness * (2.0 - chromeRoughness), coneLod)).rgb * envIntensity;
}

// Mirror metal, unshadowed and unoccluded: what it reflects tinted by F0, plus the key's highlight.
vec3 chrome(vec3 n, vec3 v, vec3 reflected) {
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  vec3 f = tint + (1.0 - tint) * pow(1.0 - ndv, 5.0);
  vec3 h = normalize(normalize(lightDirection) + v);
  float spec = pow(clamp(dot(n, h), 0.0, 1.0), specPower) * 5.0 * (specPower + 2.0) / 702.0;
  return f * reflected + lightColor * spec;
}

// A band seen in a reflection: it mostly darkens the env, with a little of its own blurred reflection.
vec3 reflectedBand(vec3 n2, vec3 r, vec3 env, float lod) {
  float ndv = clamp(-dot(n2, r), 0.0, 1.0);
  vec3 f = tint + (1.0 - tint) * pow(1.0 - ndv, 5.0);
  vec3 band = f * textureLod(envMap, envRotation * reflect(r, n2), envMapMaxLod * lod).rgb * envIntensity;
  vec3 soft = min(textureLod(envMap, envRotation * r, envMapMaxLod * max(lod, 0.6)).rgb * envIntensity, env);
  return min(mix(0.3 * soft, band, 0.15), env);
}

// Thin-film interference: reflectance of a film of thickness d (nm) at the cosine of incidence,
// from the optical path difference evaluated at red, green and blue wavelengths.
vec3 thinFilm(float d, float ndv) {
  float sinT2 = (1.0 - ndv * ndv) / (filmIor * filmIor);
  float cosT = sqrt(max(1.0 - sinT2, 0.0));
  vec3 phase = 6.2831853 * 2.0 * filmIor * d * cosT / filmWavelengths + 3.14159265;
  return clamp(0.5 + 0.5 * cos(phase), 0.0, 1.0);
}

// Film thickness drifts slowly over the surface, so the colours swim like oil on water, and follows
// the surface's facing, so each band's faces, folds and rims take different hues.
float filmThickness(vec3 p, vec3 n) {
  float tm = time * filmFlow;
  float w = 0.5 + 0.25 * sin(dot(p, vec3(2.1, 1.3, -1.7)) + tm) + 0.15 * sin(dot(p, vec3(-3.7, 2.9, 1.1)) - tm * 1.3) + 0.1 * sin(dot(p, vec3(1.3, -4.9, 3.3)) + tm * 0.7);
  w += filmFacing * dot(n, vec3(0.62, 0.47, -0.62));
  return mix(filmRange.x, filmRange.y, clamp(w, 0.0, 1.0));
}

// Each slice holds its own distance in r and the next slice's in g, so one fetch interpolates in z.
float volumeAt(vec3 p) {
  vec3 v = clamp((p - volumeBox.xyz) / volumeBox.w * float(VOL) - 0.5, 0.0, float(VOL - 1));
  float z0 = floor(v.z);
  vec2 tile = vec2(mod(z0, float(VOL_TILES)), floor(z0 / float(VOL_TILES)));
  vec2 d = texture(tVolume, (tile * float(VOL) + v.xy + 0.5) / float(VOL * VOL_TILES)).rg;
  return mix(d.x, d.y, v.z - z0);
}

// Band t's frame at continuous sample position s: centre and half-width (c), unit width axis and
// half-thickness (f), unit tangent (T); returns the centreline's length per sample.
float frameAlong(int t, float s, out vec4 c, out vec4 f, out vec3 T) {
  float i = floor(s + 0.5);
  float u = s - i + 0.5;
  int k = int(clamp(i, -float(${SAMPLES}), 2.0 * float(${SAMPLES})));
  vec4 c1 = curveAt(t, k), f1 = frameAt(t, k);
  vec4 A = 0.5 * (curveAt(t, k - 1) + c1), C = 0.5 * (c1 + curveAt(t, k + 1));
  vec4 FA = 0.5 * (frameAt(t, k - 1) + f1), FC = 0.5 * (f1 + frameAt(t, k + 1));
  c = mix(mix(A, c1, u), mix(c1, C, u), u);
  f = mix(mix(FA, f1, u), mix(f1, FC, u), u);
  vec3 dc = 2.0 * mix(c1.xyz - A.xyz, C.xyz - c1.xyz, u);
  float speed = max(length(dc), 1e-6);
  T = dc / speed;
  vec3 wv = f.xyz - dot(f.xyz, T) * T;
  float wl = dot(wv, wv);
  f.xyz = wl > 1e-20 ? wv * inversesqrt(wl) : (abs(T.x) < 0.9 ? normalize(cross(T, vec3(1.0, 0.0, 0.0))) : normalize(cross(T, vec3(0.0, 1.0, 0.0))));
  return speed;
}

// Where the ray o + r t passes band id (band * SAMPLES + sample) near tc, exactly. The band is taken
// as its section swept straight along its tangent at the point the ray passes, which the ray meets
// in closed form; that point is refined by Newton steps along the band until it no longer depends
// on tc or id. Returns the pixel's coverage (x, antialiased over the cone, faded for hits only a few
// voxels away), the distance (y), how far the ray misses the band (z, negative inside) and the
// normal's spread over the ray's footprint (w); n2 is the band's normal where the ray enters it or
// passes closest.
vec4 exactHit(vec3 o, vec3 r, float tc, int id, float cone, float voxel, out vec3 n2) {
  int t = id / ${SAMPLES};
  float s = float(id % ${SAMPLES});
  float th = tc, m = 1e9, exit = tc, spread = 0.0;
  vec3 q = o + r * tc;
  // First onto the point nearest where the ray came closest in the march.
  s = stepToward(t, stepToward(t, s, q), q);
  for (int pass = 0; pass < EXACT_PASSES; pass++) {
    vec4 c, f;
    vec3 T;
    float speed = frameAlong(t, s, c, f, T);
    vec3 b = cross(T, f.xyz);
    vec2 p0 = vec2(dot(o - c.xyz, f.xyz), dot(o - c.xyz, b));
    vec2 d = vec2(dot(r, f.xyz), dot(r, b));
    float d2 = max(dot(d, d), 1e-8);
    vec2 h = vec2(c.w, f.w);
    float rc = h.y * CORNER;
    vec2 e = h - rc;
    // Corners pushed out by the relief grow the rounded rectangle the line meets first, which bounds it.
    rc += sectionShape.x * PINCH_OUT * h.y;
    vec2 hb = e + rc;
    // The line's normal, toward the side the section lies on, and how far the line passes outside it.
    vec2 nu = vec2(-d.y, d.x) * inversesqrt(d2);
    float side = dot(nu, p0);
    nu *= side > 0.0 ? -1.0 : 1.0;
    m = abs(side) - (e.x * abs(nu.x) + e.y * abs(nu.y) + rc);
    vec2 g = -nu;
    vec2 at = -sign(nu) * e - nu * rc;
    vec2 tx = vec2(th);
    float into = 1e9;
    if (m < 0.0) {
      // Entry: through the bounding box, then onto the corner's circle if it lands in a corner.
      vec2 inv = 1.0 / (abs(d) + 1e-8) * sign(d + 1e-12);
      vec2 tn = min((-hb - p0) * inv, (hb - p0) * inv);
      tx = max((-hb - p0) * inv, (hb - p0) * inv);
      float te = max(tn.x, tn.y);
      vec2 pe = p0 + d * te;
      g = tn.x > tn.y ? vec2(sign(pe.x), 0.0) : vec2(0.0, sign(pe.y));
      vec2 k = abs(pe) - e;
      into = -max(k.x, k.y);
      if (k.x > 0.0 && k.y > 0.0) {
        vec2 kk = p0 - sign(pe) * e;
        float bk = dot(kk, d), ck = dot(kk, kk) - rc * rc;
        te = (-bk - sqrt(max(bk * bk - d2 * ck, 0.0))) / d2;
        pe = p0 + d * te;
        vec2 gc = pe - sign(pe) * e;
        float gl = dot(gc, gc);
        g = gl > 1e-20 ? gc * inversesqrt(gl) : g;
        into = rc * min(abs(g.x), abs(g.y));
      }
      at = pe;
      if (any(greaterThan(sectionShape, vec3(0.0)))) {
        // The relief has no closed form: sphere-traced along the line from where it enters the bound.
        float tl = dot(pe - p0, d) / d2, tm = tl, sp = sqrt(d2), tOut = min(tx.x, tx.y);
        vec3 fm = vec3(g, 1e9);
        for (int j = 0; j < SECTION_STEPS; j++) {
          vec3 fj = section(p0 + d * tl, h);
          if (fj.z < fm.z) { fm = fj; tm = tl; }
          if (fj.z < 1e-4 * h.y || tl > tOut) break;
          tl += 0.9 * fj.z / sp;
        }
        g = fm.xy;
        at = p0 + d * tm;
        m = fm.z < 1e-4 * h.y ? min(fm.z, section(p0 + d * 0.5 * (tm + tOut), h).z) : fm.z;
      }
    }
    // Rounded corners turn the normal fast: their curvature over the ray's footprint, eased in at their ends.
    float foot = th * cone + 1e-4;
    spread = foot / max(rc - sectionShape.z * LENS * h.y, max(0.1 * rc, 1e-6)) * sstep(-foot, foot, into);
    // The relief's own curvature, roughly at its most.
    spread += foot * h.y * (sectionShape.y * FLUTE * 2.0 * pow(1.5707963 * FLUTES, 2.0) + 4.0 * (sectionShape.x * PINCH + sectionShape.z * LENS)) / max(e.x * e.x, 1e-8);
    th = clamp(dot(at - p0, d) / d2, tc - 0.5 * tc - 8.0 * voxel, tc + 0.5 * tc + 8.0 * voxel);
    exit = m < 0.0 ? min(tx.x, tx.y) : th;
    n2 = g.x * f.xyz + g.y * b;
    q = o + r * th;
    if (pass + 1 < EXACT_PASSES) s = mod(s + clamp(dot(q - c.xyz, T) / speed, -2.0, 2.0) + ${SAMPLES}.0, ${SAMPLES}.0);
  }
  float w = th * (cone + 0.25 * chromeRoughness) + 1e-4;
  // Faded by where the ray leaves the band, so the stretch it starts from never counts as a hit.
  float away = smoothstep(1.5 * voxel, 5.0 * voxel, exit);
  return vec4((1.0 - sstep(-w, w, m)) * away, th, m + 1.0 - away, max(spread, 0.0));
}

// Keeps band k (band * SAMPLES + sample) as one of the first three bands the ray passes, at the
// step t where it is nearest (d); its own band only once it has got away from it.
void candidate(int k, float d, float t, bool away, inout ivec3 id, inout vec3 cd, inout vec3 ct) {
  if (k < 0) return;
  int band = k / ${SAMPLES};
  if (band == ownBand && !away) return;
  if (id.x < 0 || id.x / ${SAMPLES} == band) {
    if (id.x < 0 || d < cd.x) { id.x = k; cd.x = d; ct.x = t; }
  } else if (id.y < 0 || id.y / ${SAMPLES} == band) {
    if (id.y < 0 || d < cd.y) { id.y = k; cd.y = d; ct.y = t; }
  } else if (id.z < 0 || id.z / ${SAMPLES} == band) {
    if (id.z < 0 || d < cd.z) { id.z = k; cd.z = d; ct.z = t; }
  }
}

// A band seen in a reflection, from its exact hit h and normal n2.
vec3 hitShade(vec4 h, vec3 n2, vec3 r, vec3 env, float voxel) {
  // The band's normal turns over the ray's footprint at its rounded edges; blur by as much.
  float lod = max(0.5 + 0.3 * smoothstep(2.0 * voxel, 16.0 * voxel, h.y) + chromeRoughness, min((log2(max(2.0 * h.w, 0.0) + 1e-6) + envMapMaxLod - 0.65) / envMapMaxLod, 4.0));
  return reflectedBand(n2, r, env, lod);
}

// The reflection ray marched through the coarse volume only to find which bands it passes close to
// (the first three, each where it comes closest); each is then hit exactly, so neither the edges nor
// the shading of a reflected band step with the voxels. Bands are hit in the order the ray met them
// until they cover the pixel, then composited front to back. cone is the ray's spread per unit length.
// How much of the pixel the last traced() reflection gave to the bands rather than the env.
float tracedCover = 0.0;

vec3 traced(vec3 p, vec3 n, vec3 r, vec3 env, float cone) {
  vec3 inv = safeInverse(r);
  vec3 t0 = (volumeBox.xyz - p) * inv, t1 = (volumeBox.xyz + volumeBox.w - p) * inv;
  vec3 tf = max(t0, t1);
  float end = min(min(tf.x, tf.y), tf.z);
  float voxel = volumeBox.w / float(VOL);
  vec3 o = p + n * 0.5 * voxel;
  float t = 2.0 * voxel;
  // Per candidate band: id at its closest step, distance there, t there.
  ivec3 id = ivec3(-1);
  vec3 cd = vec3(1e9), ct = vec3(0.0);
  bool away = false;
  for (int i = 0; i < REFLECTION_STEPS; i++) {
    if (t > end) break;
    vec3 q = o + r * t;
    float d = volumeAt(q);
    float step = max(abs(d), max(0.5 * voxel, 0.12 * t));
    if (d < max(1.5 * voxel, 0.6 * step)) {
      ivec2 ks = volumeIds(q);
      candidate(ks.x, d, t, away, id, cd, ct);
      candidate(ks.y, d, t, away, id, cd, ct);
      // Well inside a band with three found, or some way past the first: nothing behind shows.
      if (d < -voxel && (id.z >= 0 || id.x >= 0 && t > ct.x + 4.0 * voxel)) break;
    }
    away = away || d > voxel;
    t += step;
  }
  if (id.x < 0) return env;
  float fade = 1.0 - smoothstep(0.2, 0.6, chromeRoughness);
  vec4 h0, h1 = vec4(0.0, 1e9, 1e9, 0.0), h2 = h1;
  vec3 n0, n1 = vec3(0.0), n2 = vec3(0.0);
  h0 = exactHit(o, r, ct.x, id.x, cone, voxel, n0);
  if (id.y >= 0 && h0.x < 0.995) h1 = exactHit(o, r, ct.y, id.y, cone, voxel, n1);
  if (id.z >= 0 && 1.0 - (1.0 - h0.x) * (1.0 - h1.x) < 0.995) h2 = exactHit(o, r, ct.z, id.z, cone, voxel, n2);
  // Passing within the blend of a band counts, for the fillet between two.
  float reach = blend + 1e-3;
  vec3 c0 = hitShade(h0, n0, r, env, voxel), c1 = h1.x > 1e-3 || h1.z < reach ? hitShade(h1, n1, r, env, voxel) : env, c2 = h2.x > 1e-3 || h2.z < reach ? hitShade(h2, n2, r, env, voxel) : env;
  // Front to back.
  if (h1.y < h0.y) { vec4 th = h0; h0 = h1; h1 = th; vec3 tc = c0; c0 = c1; c1 = tc; }
  if (h2.y < h1.y) { vec4 th = h1; h1 = h2; h2 = th; vec3 tc = c1; c1 = c2; c2 = tc; }
  if (h1.y < h0.y) { vec4 th = h0; h0 = h1; h1 = th; vec3 tc = c0; c0 = c1; c1 = tc; }
  vec3 a = vec3(h0.x, h1.x, h2.x) * fade;
  vec3 c = mix(mix(mix(env, c2, a.z), c1, a.y), c0, a.x);
  // The fillet where the front two bands meet: their smooth union, where the ray passes them close together.
  float k = max(blend, 1e-4);
  float g = max(k - abs(h0.z - h1.z), 0.0) / k;
  float mu = min(h0.z, h1.z) - g * g * k * 0.25;
  float w = h0.y * (cone + 0.25 * chromeRoughness) + 1e-4;
  float joined = (1.0 - sstep(-w, w, mu)) * (1.0 - smoothstep(k, 3.0 * k, abs(h0.y - h1.y))) * fade;
  float covered = 1.0 - (1.0 - a.x) * (1.0 - a.y);
  float extra = max(joined - covered, 0.0) / max(1.0 - covered, 1e-3);
  tracedCover = 1.0 - (1.0 - a.x) * (1.0 - a.y) * (1.0 - a.z) * (1.0 - extra);
  return mix(c, mix(c0, c1, clamp(0.5 + 0.5 * (h0.z - h1.z) / k, 0.0, 1.0)), extra);
}

// The reflection's bands as premultiplied colour (rgb) over the env, and their coverage (a).
vec4 reflectionBands(vec3 p, vec3 n, vec3 r, float cone) {
  float grazing = smoothstep(0.03, 0.2, dot(n, r));
  if (grazing <= 0.0) return vec4(0.0);
  vec3 env = envAt(r);
  tracedCover = 0.0;
  vec3 c = traced(p, n, r, env, cone);
  float a = grazing * tracedCover;
  return vec4(grazing * c - env * (grazing - a), a);
}

// The reflection with the bands from the accumulated reflection pass, over this pixel's own env.
vec3 accumulated(vec3 r) {
  vec4 b = texelFetch(tReflection, ivec2(gl_FragCoord.xy), 0);
  if (!finite4(b)) b = vec4(0.0);
  return envAt(r) * (1.0 - b.a) + b.rgb;
}

// The refracted ray marched through the coarse volume from the back of its own band: the length it
// travels through the bands behind, with a soft occupancy so it doesn't step with the voxels (x), and
// how much of what it passes is a band's surface seen edge-on (y), which reads as a dark outline.
vec2 pathBehind(vec3 p, vec3 r) {
  vec3 inv = safeInverse(r);
  vec3 t0 = (volumeBox.xyz - p) * inv, t1 = (volumeBox.xyz + volumeBox.w - p) * inv;
  vec3 tf = max(t0, t1);
  float end = min(min(tf.x, tf.y), tf.z);
  float voxel = volumeBox.w / float(VOL);
  float t = 0.0;
  float path = 0.0;
  float edges = 0.0;
  float prev = 0.0;
  for (int i = 0; i < REFLECTION_STEPS; i++) {
    if (t > end) break;
    float d = volumeAt(p + r * t);
    float step = max(abs(d), 0.35 * voxel);
    path += step * clamp(0.5 - d / voxel, 0.0, 1.0);
    // Near a surface the ray barely gets closer to it when it runs along it.
    if (i > 0 && abs(d) < 0.5 * voxel) edges += (1.0 - smoothstep(0.1, 0.7, abs(d - prev) / step)) * smoothstep(0.5 * voxel, 0.0, abs(d));
    prev = d;
    t += step;
  }
  return vec2(path, edges);
}`;

const CHROME_SURFACE = /* glsl */ `
void surface(inout Surface s) {
  vec3 n = normalize(s.normal);
#ifdef PIPELINE_COLOR
  // Only the front-most fragment (per the prepass depth) pays for the exact normal and the traced reflection.
  bool front = gl_FragCoord.z <= texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r + 2e-5;
  if (front) n = exactNormal(vWorldPosition, n, vBand, vRing);
#endif
  vec3 v = normalize(cameraPosition - vWorldPosition);
  vec3 r = reflect(-v, n);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
#ifdef PIPELINE_COLOR
  // Normal variance across the pixel widens the highlight (Toksvig-style).
  vec3 dn = fwidth(n);
  float variance = dot(dn, dn);
  specPower = 700.0 / (1.0 + 700.0 * variance);
  // From the exact normal (the mesh one shows its facets), or the mesh one where only part of the quad is front.
  vec3 nc = fwidth(front ? 1.0 : 0.0) > 0.0 ? normalize(s.normal) : n;
  coneLod = min(log2(length(fwidth(reflect(-v, nc))) + 1e-6) + envMapMaxLod - 1.65, 3.0);
#if FINISH != 2
  vec3 reflected = front ? accumulated(r) : envAt(r);
#endif
  vec3 film = mix(vec3(1.0), pow(max(thinFilm(filmThickness(vWorldPosition, n), ndv), vec3(1e-7)), vec3(filmShape.x)) * filmShape.y, filmStrength);
  float fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 lean = vec3(0.0);
#if FINISH == 0 || FINISH == 3
  if (WEIGHT(0) > 0.0) {
    // Holographic chrome: the reflection tinted by the film, soft-floored so dark env stays coloured, silver where bright.
    vec3 lifted = sqrt(reflected * reflected + filmLift.x * filmLift.x * envIntensity * envIntensity);
    float bright = dot(lifted, vec3(0.333));
    float silver = max(smoothstep(filmLift.y, 3.0 * filmLift.y, bright), filmRim * pow(1.0 - ndv, 3.0));
    lean += WEIGHT(0) * blendSpace(chrome(n, v, lifted * mix(film, vec3(1.0), silver)));
  }
#endif
#if FINISH == 1 || FINISH == 3
  // Soap / pearl: a pale lit body (the pipeline's own lighting) under an iridescent clear coat.
  // Nacre: the film colours the body a little and its sheen a lot.
  // The film's colour, saturated, shows most toward the rim and in the highlights.
  vec3 nacre = max(mix(vec3(dot(film, vec3(0.333))), film, 1.0 + 0.8 * filmStrength), 0.0);
  float rim = pow(1.0 - ndv, 1.5);
  s.albedo = bodyColor * mix(vec3(1.0), nacre, mix(0.2, 0.75, rim) * filmStrength) * 0.85;
  s.roughness = 0.35;
  s.specular = 0.0;
  s.sheenColor = nacre * 0.8;
  vec3 h = normalize(normalize(lightDirection) + v);
  float spec = pow(clamp(dot(n, h), 0.0, 1.0), 0.5 * specPower) * 2.0;
  s.emissive = (reflected * mix(0.3, 1.2, max(fresnel, rim * 0.6)) + lightColor * spec) * nacre;
#endif
#if FINISH == 2 || FINISH == 3
  if (WEIGHT(2) > 0.0) {
  // Tinted glass: the backdrop refracted through the bands, absorbed over the path the ray travels
  // inside them, so edges and overlaps deepen; the Fresnel reflection carries the highlights.
  vec3 t = refract(-v, n, 1.0 / 1.45);
  // The bands are about three voxels thick; the path through this one grows toward its silhouette.
  float thickness = 3.0 * volumeBox.w / float(VOL);
  float own = thickness / max(-dot(n, t), 0.2);
  vec2 behind = front ? pathBehind(vWorldPosition + t * own, t) : vec2(0.0);
  // Thin glass seen face-on is nearly clear; the colour builds where light travels far, through overlaps.
  float path = thickness * (0.06 + 9.0 * pow(1.0 - ndv, 2.5)) + 1.3 * behind.x;
  // Bent like a thick lens, so the floor, its shadow and the key swing into view across the band.
  vec3 bent = envRotation * normalize(t - 1.4 * (n - ndv * v));
  vec3 seen = textureLod(backdropMap, bent, envMapMaxLod * 0.05).rgb * envIntensity;
  // Rays bent far off the view line see the rest of the room rather than the backdrop behind.
  seen = mix(seen, textureLod(envMap, bent, envMapMaxLod * 0.1).rgb * envIntensity, smoothstep(0.1, 0.5, 1.0 + dot(bent, envRotation * v)));
  vec3 absorbed = exp(-absorption * 1.6 * path);
  // Near the silhouette the light inside reflects off the back faces instead, so the rim darkens to the deep tint.
  vec3 body = seen * absorbed * mix(0.12, 1.0, smoothstep(0.08, 0.55, ndv));
#if FINISH == 3
  vec3 coatReflected = ndv < 0.7 ? reflected : envAt(r);
#else
  vec3 coatReflected = front && ndv < 0.7 ? accumulated(r) : envAt(r);
#endif
  vec3 coat = mix(vec3(1.0), film, 0.35);
  vec3 h = normalize(normalize(lightDirection) + v);
  float spec = pow(clamp(dot(n, h), 0.0, 1.0), specPower) * 20.0 * (specPower + 2.0) / 702.0;
  lean += WEIGHT(2) * blendSpace(mix(body, coatReflected * coat, 0.04 + 0.96 * pow(1.0 - ndv, 4.0)) + lightColor * spec);
  }
#endif
#if FINISH == 3
  leanColor = lean;
#elif FINISH != 1
  s.emissive = lean;
#endif
#endif
}`;

// The colour pass of the chrome: PipelineMaterial's inputs and surface() hook, without its lighting.
const CHROME_FRAGMENT = /* glsl */ `
uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float time;

in vec3 vObjectPosition;
in vec3 vObjectNormal;
in vec3 vWorldPosition;
in vec3 vWorldNormal;
in vec2 vUv;
in vec3 vColor;
in vec4 vRing;
in float vBand;

layout(location = 0) out vec4 outColor;

struct Surface {
  vec3 albedo;
  float alpha;
  float roughness;
  float metalness;
  vec3 normal;
  vec3 emissive;
  vec3 sheenColor;
  float sheenRoughness;
  float occlusion;
  vec3 transmission;
  float specular;
};

${CHROME_PARS}
${CHROME_SURFACE}

void main() {
  Surface s;
  s.albedo = vec3(0.0);
  s.alpha = 1.0;
  s.roughness = 0.06;
  s.metalness = 1.0;
  s.normal = normalize(vWorldNormal);
  s.emissive = vec3(0.0);
  s.sheenColor = vec3(0.0);
  s.sheenRoughness = 0.5;
  s.occlusion = 1.0;
  s.transmission = vec3(0.0);
  s.specular = 1.0;
  surface(s);
  outColor = vec4(s.emissive, 1.0);
}
`;

// The inter-band reflections, traced once per front pixel along a ray jittered within a small cone
// each frame: the bands' premultiplied colour and coverage, and where the point was last frame.
const REFLECT_VERT = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec2 uv;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 previousViewProjection;
uniform highp sampler2D tPosition;
uniform highp sampler2D tNormal;
uniform highp sampler2D tPreviousPosition;
out vec3 vWorldPosition;
out vec3 vWorldNormal;
out vec4 vPrevClip;
out vec4 vRing;
out float vBand;
void main() {
  ivec2 c = ivec2(uv);
  float ring = mod(uv.y, float(RINGS));
  float side = 6.2831853 * (uv.x + 0.5 * mod(ring, 2.0)) / float(SIDES);
  ring *= 6.2831853 / float(RINGS);
  vRing = vec4(cos(ring), sin(ring), cos(side), sin(side));
  vBand = floor(uv.y / float(RINGS));
  vec4 world = modelMatrix * vec4(texelFetch(tPosition, c, 0).xyz, 1.0);
  vWorldPosition = world.xyz;
  vWorldNormal = mat3(modelMatrix) * texelFetch(tNormal, c, 0).xyz;
  vPrevClip = previousViewProjection * modelMatrix * vec4(texelFetch(tPreviousPosition, c, 0).xyz, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const REFLECT_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
uniform vec3 cameraPosition;
uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float time;
uniform float glassCut;
uniform float reflectionGloss;
uniform float jitterFrame;
in vec3 vWorldPosition;
in vec3 vWorldNormal;
in vec4 vPrevClip;
in vec4 vRing;
in float vBand;
layout(location = 0) out vec4 outBands;
layout(location = 1) out vec4 outInfo;

${CHROME_PARS}

void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 v = normalize(cameraPosition - vWorldPosition);
  vec3 nm = n;
  bool front = gl_FragCoord.z <= texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r + 2e-5;
  if (front) n = exactNormal(vWorldPosition, n, vBand, vRing);
  // As in the colour pass, so the env under the bands matches it.
  coneLod = min(log2(length(fwidth(reflect(-v, fwidth(front ? 1.0 : 0.0) > 0.0 ? nm : n))) + 1e-6) + envMapMaxLod - 1.65, 3.0);
  vec3 r = reflect(-v, n);
  float cone = length(fwidth(r));
  if (!front) discard;
  outInfo = vec4(vPrevClip.w > 1e-4 ? vPrevClip.xy / vPrevClip.w * 0.5 + 0.5 : vec2(-1.0), vPrevClip.w, 1.0 / gl_FragCoord.w);
  outBands = vec4(0.0);
  if (dot(n, v) >= glassCut) return;
  // Interleaved gradient noise per pixel, stepped along the R2 sequence per frame.
  vec2 g = vec2(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)), dot(gl_FragCoord.xy + vec2(47.0, 17.0), vec2(0.06711056, 0.00583715)));
  vec2 xi = fract(fract(52.9829189 * fract(g)) + jitterFrame * vec2(0.7548777, 0.5698403));
  // Across the pixel's footprint and a narrow gloss lobe.
  float spread = 0.5 * cone + reflectionGloss * chromeRoughness;
  vec3 t1 = normalize(cross(r, abs(r.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(r, t1);
  float a = 6.2831853 * xi.y;
  vec3 rj = normalize(r + spread * sqrt(xi.x) * (cos(a) * t1 + sin(a) * t2));
  float below = dot(rj, n);
  if (below < 0.0) rj -= 2.0 * below * n;
  outBands = reflectionBands(vWorldPosition, n, rj, cone);
  outBands = finite4(outBands) ? clamp(outBands, -6e4, 6e4) : vec4(0.0);
}
`;

// Folds this frame's jittered reflections into the history, reprojected to where each point was:
// history from another surface is dropped by depth and, unless nothing moved, clamped to the
// neighbourhood of this frame's samples.
const RESOLVE = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D tBands;
uniform highp sampler2D tInfo;
uniform highp sampler2D tHistory;
uniform highp sampler2D tHistoryInfo;
uniform float still;
uniform float maxCount;
layout(location = 0) out vec4 outBands;
layout(location = 1) out vec4 outInfo;

bool finite4(vec4 c) { return all(lessThan(floatBitsToUint(c) & 0x7f800000u, uvec4(0x7f800000u))); }

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 info = texelFetch(tInfo, px, 0);
  if (info.w <= 0.0) {
    outBands = vec4(0.0);
    outInfo = vec4(0.0);
    return;
  }
  vec4 cur = texelFetch(tBands, px, 0);
  if (!finite4(cur)) cur = vec4(0.0);
  ivec2 size = textureSize(tBands, 0);
  vec4 m1 = vec4(0.0), m2 = vec4(0.0);
  float k = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 q = clamp(px + ivec2(x, y), ivec2(0), size - 1);
      if (texelFetch(tInfo, q, 0).w <= 0.0) continue;
      vec4 c = texelFetch(tBands, q, 0);
      if (!finite4(c)) continue;
      m1 += c;
      m2 += c * c;
      k += 1.0;
    }
  k = max(k, 1.0);
  m1 /= k;
  vec4 sigma = sqrt(max(m2 / k - m1 * m1, 0.0));
  // Bilinear history over the taps on the same surface.
  vec2 hp = info.xy * vec2(size) - 0.5;
  ivec2 h0 = ivec2(floor(hp));
  vec2 f = hp - floor(hp);
  vec4 history = vec4(0.0);
  float hw = 0.0, count = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    ivec2 q = h0 + o;
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) continue;
    vec4 hi = texelFetch(tHistoryInfo, q, 0);
    if (hi.x <= 0.0 || abs(hi.x - info.z) > 0.02 * info.z + 0.01) continue;
    float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    vec4 hv = texelFetch(tHistory, q, 0);
    if (w <= 0.0 || !finite4(hv) || !finite4(vec4(hi.y))) continue;
    history += w * hv;
    count += w * hi.y;
    hw += w;
  }
  float n = 1.0;
  outBands = cur;
  if (hw > 0.05) {
    history /= hw;
    count /= hw;
    if (still < 0.5) history = clamp(history, min(m1 - 1.25 * sigma, cur), max(m1 + 1.25 * sigma, cur));
    n = min(count + 1.0, maxCount);
    outBands = mix(history, cur, 1.0 / n);
  }
  outBands = finite4(outBands) ? clamp(outBands, -6e4, 6e4) : cur;
  outInfo = vec4(info.w, n, 0.0, 0.0);
}
`;

export class Tangle {
  constructor(knots, { rings = 256, sides = 36, iterations = 3, volume = 64, reflectionSteps = 24 } = {}) {
    this.knots = knots;
    this.vol = volume;
    this.volTiles = Math.ceil(Math.sqrt(volume));
    this.reflectionSteps = reflectionSteps;
    this.rings = rings;
    this.sides = sides;
    const height = rings * MAX_TUBES;
    const rt = () =>
      new WebGLRenderTarget(sides, height, { count: 2, type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, colorSpace: NoColorSpace });
    this.targets = [rt(), rt()];
    this.current = 0;

    this.ringData = new Float32Array(rings * MAX_TUBES * 4 * 4);
    this.ringTexture = new DataTexture(this.ringData, rings, MAX_TUBES * 4, RGBAFormat, FloatType);
    this.ringTexture.minFilter = this.ringTexture.magFilter = NearestFilter;

    this.chunks = Array.from({ length: MAX_TUBES * CHUNKS }, () => new Vector4());
    this.uniforms = {
      tCurve: { value: knots.texture },
      tRings: { value: this.ringTexture },
      chunks: { value: this.chunks },
      tubeCount: { value: 0 },
      blend: { value: 0.12 },
      volumeBox: { value: new Vector4() },
      // Weights of the pinched, fluted and lens section shapes (0 for all: the plain rounded rectangle).
      sectionShape: { value: new Vector3() },
    };
    const side = this.vol * this.volTiles;
    this.volume = new WebGLRenderTarget(side, side, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });
    this.bakeMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: BAKE,
      uniforms: this.uniforms,
      defines: { VOL: this.vol, VOL_TILES: this.volTiles, ...SECTION_DEFINES },
      depthTest: false,
      depthWrite: false,
    });
    this.projectMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: PROJECT,
      uniforms: this.uniforms,
      defines: { RINGS: rings, SIDES: sides, ITERATIONS: iterations, LOCAL: 1, ...SECTION_DEFINES },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new BufferGeometry();
    quad.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new Mesh(quad, this.projectMaterial);
    this.quad.frustumCulled = false;
    this.quadScene = new Scene().add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.mesh = new Mesh(this._geometry(), this.material(0));
    this.mesh.frustumCulled = false;
    this.lastKey = null;
    this._initReflections();
  }

  // The reflection pass runs inside the pipeline's colour pass, just before the bands draw, so it
  // sees this frame's prepass depth and camera (lens and sample jitter included).
  _initReflections() {
    const target = (type) =>
      new WebGLRenderTarget(1, 1, { count: 2, type, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, colorSpace: NoColorSpace });
    this.bandsTarget = target(FloatType);
    this.historyTargets = [target(HalfFloatType), target(HalfFloatType)];
    this.history = 0;
    this.meshUniforms.tReflection.value = this.historyTargets[0].textures[0];
    this.previousViewProjection = new Matrix4();
    this.viewProjection = new Matrix4();
    this.updates = 0;
    this.reflectedUpdate = -1;
    this.reflectFrame = 0;
    const g = globalUniforms;
    this.reflectUniforms = {
      ...this.meshUniforms,
      tPreviousPosition: { value: null },
      previousViewProjection: { value: this.previousViewProjection },
      envMap: g.envMap,
      envMapMaxLod: g.envMapMaxLod,
      envIntensity: g.envIntensity,
      envRotation: g.envRotation,
      lightDirection: g.lightDirection,
      lightColor: g.lightColor,
      time: g.time,
      glassCut: { value: 2 },
      reflectionGloss: { value: 0.75 },
      jitterFrame: { value: 0 },
    };
    this.reflectMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: REFLECT_VERT,
      fragmentShader: REFLECT_FRAG,
      uniforms: this.reflectUniforms,
      defines: { VOL: this.vol, VOL_TILES: this.volTiles, REFLECTION_STEPS: this.reflectionSteps, EXACT_PASSES: 3, SECTION_STEPS: 6, FINISH: -1, RINGS: this.rings, SIDES: this.sides, LOCAL: 1, ...SECTION_DEFINES },
      depthTest: false,
      depthWrite: false,
    });
    this.resolveMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: RESOLVE,
      uniforms: {
        tBands: { value: this.bandsTarget.textures[0] },
        tInfo: { value: this.bandsTarget.textures[1] },
        tHistory: { value: null },
        tHistoryInfo: { value: null },
        still: { value: 0 },
        maxCount: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(this.mesh.geometry, this.reflectMaterial);
    mesh.frustumCulled = false;
    this.reflectScene = new Scene().add(mesh);
    this.colorMaterial = this.mesh.material;
    this.mesh.onBeforeRender = (renderer, scene, camera, geometry, material) => {
      if (material === this.colorMaterial) this._renderReflections(renderer, camera);
    };
  }

  _renderReflections(renderer, camera) {
    const main = renderer.getRenderTarget();
    if (!main) return;
    const { width, height } = main;
    let reset = false;
    if (this.bandsTarget.width !== width || this.bandsTarget.height !== height) {
      for (const rt of [this.bandsTarget, ...this.historyTargets]) rt.setSize(width, height);
      reset = true;
    }
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Between two updates the bands hold still, whatever tPrevPosition says.
    const moved = this.updates !== this.reflectedUpdate;
    this.reflectedUpdate = this.updates;
    const still = !moved && this.viewProjection.equals(this.previousViewProjection);
    const u = this.reflectUniforms;
    u.tPreviousPosition.value = moved ? this.meshUniforms.tPrevPosition.value : this.meshUniforms.tPosition.value;
    u.jitterFrame.value = this.reflectFrame++ % 1024;

    const clearColor = renderer.getClearColor(_clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.bandsTarget);
    renderer.clear(true, false, false);
    renderer.render(this.reflectScene, camera);

    const source = this.historyTargets[this.history];
    this.history ^= 1;
    const dest = this.historyTargets[this.history];
    if (reset) {
      renderer.setRenderTarget(source);
      renderer.clear(true, false, false);
    }
    const r = this.resolveMaterial.uniforms;
    r.tHistory.value = source.textures[0];
    r.tHistoryInfo.value = source.textures[1];
    r.still.value = still ? 1 : 0;
    r.maxCount.value = still ? 64 : 16;
    this.quad.material = this.resolveMaterial;
    renderer.setRenderTarget(dest);
    renderer.render(this.quadScene, this.quadCamera);
    this.meshUniforms.tReflection.value = dest.textures[0];
    this.previousViewProjection.copy(this.viewProjection);

    renderer.setRenderTarget(main);
    renderer.setClearColor(clearColor, clearAlpha);
  }

  // Compiles the reflection passes, which otherwise compile on the first frame.
  compileAsync(renderer, camera) {
    const quad = this.quad.material;
    this.quad.material = this.resolveMaterial;
    const done = Promise.all([renderer.compileAsync(this.reflectScene, camera), renderer.compileAsync(this.quadScene, this.quadCamera)]);
    this.quad.material = quad;
    return done;
  }

  _geometry() {
    const { rings, sides } = this;
    const nv = rings * sides * MAX_TUBES;
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nv * 3), 3));
    const uv = new Float32Array(nv * 2);
    for (let row = 0; row < rings * MAX_TUBES; row++)
      for (let k = 0; k < sides; k++) {
        const v = (row * sides + k) * 2;
        uv[v] = k;
        uv[v + 1] = row;
      }
    geo.setAttribute("uv", new BufferAttribute(uv, 2));
    const index = new Uint32Array(rings * sides * 6 * MAX_TUBES);
    let o = 0;
    for (let t = 0; t < MAX_TUBES; t++)
      for (let r = 0; r < rings; r++) {
        const r2 = (r + 1) % rings;
        // Odd rings are turned half a side, so the quads become a triangle lattice.
        const shift = r & 1;
        for (let k = 0; k < sides; k++) {
          const k2 = (k + 1) % sides;
          const a = (t * rings + r) * sides + k;
          const b = (t * rings + r) * sides + k2;
          const c = (t * rings + r2) * sides + k;
          const d = (t * rings + r2) * sides + k2;
          if (shift) index.set([a, b, d, a, d, c], o);
          else index.set([a, b, c, b, d, c], o);
          o += 6;
        }
      }
    geo.setIndex(new BufferAttribute(index, 1));
    geo.boundingSphere = new Sphere(new Vector3(), 1.6);
    this.indicesPerTube = rings * sides * 6;
    return geo;
  }

  // Finishes: 0 holographic chrome, 1 soap / pearl (lit by the pipeline), 2 tinted glass, 3 a mix of
  // all three by meshUniforms.finishWeights, for cross-fades.
  setFinish(finish) {
    if (finish === this.finish) return;
    this.finish = finish;
    this.mesh.material = this.colorMaterial = this.material(finish);
    this.reflectUniforms.glassCut.value = finish === 2 ? 0.7 : 2;
  }

  material(finish) {
    this.materials ??= [];
    return (this.materials[finish] ??= this._material(finish));
  }

  _material(finish = 0) {
    this.meshUniforms ??= {
      tPosition: { value: null },
      tNormal: { value: null },
      tPrevPosition: { value: null },
      tVolume: { value: this.volume.texture },
      volumeBox: this.uniforms.volumeBox,
      tSceneDepth: { value: null },
      tCurve: this.uniforms.tCurve,
      chunks: this.uniforms.chunks,
      tubeCount: this.uniforms.tubeCount,
      blend: this.uniforms.blend,
      sectionShape: this.uniforms.sectionShape,
      tint: { value: new Vector3(0.96, 0.95, 0.94) },
      chromeRoughness: { value: 0.06 },
      filmRange: { value: new Vector2(250, 650) },
      // A dense film (like titanium oxide) keeps the colours from swinging far with viewing angle.
      filmIor: { value: 2.0 },
      filmWavelengths: { value: new Vector3(650, 532, 450) },
      filmStrength: { value: 1 },
      filmShape: { value: new Vector2(1, 1.6) },
      filmFlow: { value: 0.15 },
      filmFacing: { value: 0 },
      filmRim: { value: 0 },
      filmLift: { value: new Vector2(0, 1e6) },
      bodyColor: { value: new Color(0.92, 0.9, 0.95) },
      absorption: { value: new Vector3(0.6, 0.25, 0.1) },
      // What glass refracts: the studio the backdrop is lit by, whatever the reflections show.
      backdropMap: { value: null },
      finishWeights: { value: new Vector3(1, 0, 0) },
      tReflection: { value: null },
    };
    this.finish ??= finish;
    const material = new PipelineMaterial({
      defines: { VOL: this.vol, VOL_TILES: this.volTiles, REFLECTION_STEPS: this.reflectionSteps, EXACT_PASSES: 3, SECTION_STEPS: 6, FINISH: finish, RINGS: this.rings, SIDES: this.sides, LOCAL: 1, ...SECTION_DEFINES },
      color: 0x000000,
      metalness: finish === 1 || finish === 3 ? 0 : 1,
      roughness: 0.06,
      uniforms: this.meshUniforms,
      vertexPars: /* glsl */ `
uniform highp sampler2D tPosition;
uniform highp sampler2D tNormal;
uniform highp sampler2D tPrevPosition;`,
      varyings: { vRing: "vec4", vBand: "float" },
      vertexMain: /* glsl */ `
  float ring = mod(uv.y, float(RINGS));
  float side = 6.2831853 * (uv.x + 0.5 * mod(ring, 2.0)) / float(SIDES);
  ring *= 6.2831853 / float(RINGS);
  vRing = vec4(cos(ring), sin(ring), cos(side), sin(side));
  vBand = floor(uv.y / float(RINGS));`,
      vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  ivec2 c = ivec2(uv);
  if (pipelinePrevPose) return texelFetch(tPrevPosition, c, 0).xyz;
  n = texelFetch(tNormal, c, 0).xyz;
  return texelFetch(tPosition, c, 0).xyz;
}`,
      fragmentPars: CHROME_PARS,
      surface: CHROME_SURFACE,
    });
    // Chrome and glass are all emissive, so their colour pass skips the pipeline's PBR (shadow, GI,
    // AO); pearl keeps it for its lit body.
    if (finish === 0 || finish === 2) {
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = CHROME_FRAGMENT;
      };
      material.customProgramCacheKey = () => `tangle-lean-${finish}`;
    } else if (finish === 3) {
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace("outColor = vec4(color, 1.0);", "vec3 mixed = blendSpace(clamp(color, vec3(0.0), vec3(6e4))) * finishWeights.y + leanColor;\n  outColor = vec4(mixed / max(1.0 - mixed, 1e-3), 1.0);");
      };
      material.customProgramCacheKey = () => "tangle-mix";
    }
    return material;
  }

  // Per ring of each band, on its Bezier chain (as the field evaluates it): centre and half-width,
  // width axis and half-thickness, tangent and twist rate, and the section's rate of change.
  _updateRings() {
    const { data, count } = this.knots;
    const { rings } = this;
    const R = this.ringData;
    const row = SAMPLES * 4;
    const v = new Float64Array(8), dv = new Float64Array(8);
    for (let t = 0; t < count; t++) {
      for (let r = 0; r < rings; r++) {
        const s = (r * SAMPLES) / rings;
        const i = Math.round(s);
        const f = s - i + 0.5;
        const g = 1 - f;
        const ja = ((i - 1 + SAMPLES) % SAMPLES) * 4, jb = (i % SAMPLES) * 4, jc = ((i + 1) % SAMPLES) * 4;
        for (let c = 0; c < 8; c++) {
          const base = c < 4 ? t * row + c : (MAX_TUBES + t) * row + c - 4;
          const a0 = 0.5 * (data[base + ja] + data[base + jb]), b0 = data[base + jb], c0 = 0.5 * (data[base + jb] + data[base + jc]);
          v[c] = g * g * a0 + 2 * g * f * b0 + f * f * c0;
          dv[c] = 2 * g * (b0 - a0) + 2 * f * (c0 - b0);
        }
        const l2 = Math.max(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2], 1e-10);
        const tl = Math.sqrt(l2);
        const tx = dv[0] / tl, ty = dv[1] / tl, tz = dv[2] / tl;
        const d = v[4] * tx + v[5] * ty + v[6] * tz;
        let wx = v[4] - d * tx, wy = v[5] - d * ty, wz = v[6] - d * tz;
        const wl = Math.max(Math.hypot(wx, wy, wz), 1e-6);
        wx /= wl; wy /= wl; wz /= wl;
        const bx = ty * wz - tz * wy, by = tz * wx - tx * wz, bz = tx * wy - ty * wx;
        const twist = (bx * dv[4] + by * dv[5] + bz * dv[6]) / wl / tl;
        const o = (t * 4 * rings + r) * 4;
        R[o] = v[0]; R[o + 1] = v[1]; R[o + 2] = v[2]; R[o + 3] = Math.max(v[3], 0);
        R[o + rings * 4] = wx; R[o + rings * 4 + 1] = wy; R[o + rings * 4 + 2] = wz; R[o + rings * 4 + 3] = Math.max(v[7], 0);
        R[o + rings * 8] = tx; R[o + rings * 8 + 1] = ty; R[o + rings * 8 + 2] = tz; R[o + rings * 8 + 3] = twist;
        R[o + rings * 12] = dv[3] / tl; R[o + rings * 12 + 1] = dv[7] / tl;
      }
    }
    this.ringTexture.needsUpdate = true;
  }

  // Bounding spheres per chunk of each curve (for the field) and for the whole tangle (for shadows).
  _updateBounds() {
    const { data, count } = this.knots;
    const pad = this.uniforms.blend.value;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let t = 0; t < count; t++) {
      for (let c = 0; c < CHUNKS; c++) {
        let x = 0, y = 0, z = 0;
        for (let j = -1; j <= CHUNK; j++) {
          const o = (t * SAMPLES + ((c * CHUNK + j + SAMPLES) % SAMPLES)) * 4;
          x += data[o];
          y += data[o + 1];
          z += data[o + 2];
        }
        x /= CHUNK + 2;
        y /= CHUNK + 2;
        z /= CHUNK + 2;
        let r = 0;
        for (let j = -1; j <= CHUNK; j++) {
          const o = (t * SAMPLES + ((c * CHUNK + j + SAMPLES) % SAMPLES)) * 4;
          const dx = data[o] - x, dy = data[o + 1] - y, dz = data[o + 2] - z;
          r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz) + data[o + 3]);
        }
        this.chunks[t * CHUNKS + c].set(x, y, z, r + pad);
        cx += x;
        cy += y;
        cz += z;
        n++;
      }
    }
    cx /= n;
    cy /= n;
    cz /= n;
    let R = 0;
    for (let i = 0; i < count * CHUNKS; i++) {
      const ch = this.chunks[i];
      R = Math.max(R, Math.hypot(ch.x - cx, ch.y - cy, ch.z - cz) + ch.w);
    }
    this.mesh.geometry.boundingSphere.set(new Vector3(cx, cy, cz), R);
    this.uniforms.volumeBox.value.set(cx - R, cy - R, cz - R, 2 * R);
    this.uniforms.tubeCount.value = count;
  }

  // Re-projects the vertices and re-bakes the volume when the curves or the blend changed; call
  // before pipeline.render with the pipeline's prepass depth.
  update(renderer, key, sceneDepth) {
    const u = this.meshUniforms;
    u.tSceneDepth.value = sceneDepth;
    const fullKey = `${key}|${this.uniforms.blend.value}|${this.knots.count}|${this.uniforms.sectionShape.value.toArray()}`;
    if (fullKey === this.lastKey) {
      const cur = this.targets[this.current];
      u.tPrevPosition.value = cur.textures[0];
      return;
    }
    this.lastKey = fullKey;
    this.updates++;
    this._updateRings();
    this._updateBounds();
    const prev = this.targets[this.current];
    this.current ^= 1;
    const cur = this.targets[this.current];
    const rt = renderer.getRenderTarget();
    this.quad.material = this.projectMaterial;
    renderer.setRenderTarget(cur);
    renderer.render(this.quadScene, this.quadCamera);
    this.quad.material = this.bakeMaterial;
    renderer.setRenderTarget(this.volume);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.setRenderTarget(rt);
    u.tPosition.value = cur.textures[0];
    u.tNormal.value = cur.textures[1];
    u.tPrevPosition.value = prev.textures[0];
    this.mesh.geometry.setDrawRange(0, this.knots.count * this.indicesPerTube);
  }
}
