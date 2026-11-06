// Engraved motifs as distance fields to their stroke centrelines, in a unit disc (strokes stay inside
// radius ~0.95). Five sets of eight: geometric, arcane, medieval, sidereal and a generated alien script.
export const MOTIF_SETS = ["geometric", "arcane", "medieval", "sidereal", "alien", "mixed"];

import { WebGLRenderTarget, HalfFloatType, LinearFilter, ShaderMaterial, GLSL3, Mesh, PlaneGeometry, OrthographicCamera, Scene, RedFormat } from "three";

const COLUMNS = 8, ROWS = 5, CELL = 128;
// Motifs live in an atlas cell over [-EXTENT, EXTENT].
const EXTENT = 1.15;

// The library only goes into the atlas shader; engraving shaders sample the atlas.
const LIBRARY = /* glsl */ `
#define MPI 3.14159265359
uniform float motifSeed;
float mSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float mRing(vec2 p, vec2 c, float r) { return abs(length(p - c) - r); }
float mDot(vec2 p, vec2 c, float r) { return max(length(p - c) - r, 0.0); }
vec2 mDir(float a) { return vec2(cos(a), sin(a)); }
// Arc of radius r around c, centred on angle mid and spanning +-span.
float mArc(vec2 p, vec2 c, float r, float mid, float span) {
  vec2 d = p - c;
  float da = mod(atan(d.y, d.x) - mid + MPI, 2.0 * MPI) - MPI;
  if (abs(da) <= span) return abs(length(d) - r);
  return length(d - r * mDir(mid + sign(da) * span));
}
// Star polygon {n/k}: k = 1 is the plain polygon.
float mStar(vec2 p, float r, int n, int k, float rot) {
  float d = 1e3;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float a0 = rot + 2.0 * MPI * float(i) / float(n);
    float a1 = rot + 2.0 * MPI * float(i + k) / float(n);
    d = min(d, mSeg(p, r * mDir(a0), r * mDir(a1)));
  }
  return d;
}

float motifGeometric(int id, vec2 p) {
  float r = length(p);
  if (id == 0) return min(min(mRing(p, vec2(0), 0.9), mRing(p, vec2(0), 0.5)), min(mSeg(p, vec2(-0.9, 0), vec2(0.9, 0)), mSeg(p, vec2(0, -0.9), vec2(0, 0.9))));
  if (id == 1) return min(min(mStar(p, 0.9, 3, 1, MPI * 0.5), mStar(p, 0.9, 3, 1, -MPI * 0.5)), mRing(p, vec2(0), 0.3));
  if (id == 2) return min(mRing(p, vec2(0), 0.9), min(mStar(p, 0.9, 4, 1, 0.0), mStar(p, 0.636, 4, 1, MPI * 0.25)));
  if (id == 3) {
    float d = min(mRing(p, vec2(0), 0.9), mRing(p, vec2(0), 0.3));
    for (int i = 0; i < 6; i++) d = min(d, mRing(p, 0.3 * mDir(float(i) * MPI / 3.0), 0.3));
    return d;
  }
  if (id == 4) return min(min(mStar(p, 0.9, 3, 1, MPI * 0.5), mRing(p, vec2(0), 0.45)), mDot(p, vec2(0), 0.08));
  if (id == 5) {
    float s = 0.27;
    float a = atan(p.y, p.x) / (2.0 * MPI);
    float k = (r - a * s) / s;
    float d = abs(fract(k + 0.5) - 0.5) * s;
    return min(r > 0.9 ? 1e3 : d, mRing(p, vec2(0), 0.95));
  }
  if (id == 6) return min(mStar(p, 0.9, 8, 3, 0.0), min(mRing(p, vec2(0), 0.3), mDot(p, vec2(0), 0.07)));
  return min(min(mStar(p, 0.9, 5, 1, MPI * 0.5), mStar(p, 0.9, 5, 2, MPI * 0.5)), mRing(p, vec2(0), 0.35));
}

float motifArcane(int id, vec2 p) {
  if (id == 0) {
    float d = min(mRing(p, vec2(0), 0.62), mDot(p, vec2(0), 0.12));
    for (int i = 0; i < 8; i++) d = min(d, mSeg(p, 0.76 * mDir(float(i) * MPI * 0.25), 0.95 * mDir(float(i) * MPI * 0.25)));
    return d;
  }
  if (id == 1) return abs(max(length(p) - 0.85, -(length(p - vec2(0.38, 0.12)) - 0.7)));
  if (id == 2) return min(min(mRing(p, vec2(0, 0.18), 0.3), mArc(p, vec2(0, 0.78), 0.28, -MPI * 0.5, MPI * 0.42)), min(mSeg(p, vec2(0, -0.12), vec2(0, -0.92)), mSeg(p, vec2(-0.3, -0.56), vec2(0.3, -0.56))));
  if (id == 3) {
    // A constellation: star rings joined in a chain, each line stopping at the rings.
    float d = 1e3;
    vec2 prev = vec2(0);
    float prevR = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i) + motifSeed * 7.0;
      vec2 s = 0.8 * vec2(fract(sin(fi * 91.7) * 4375.5) * 2.0 - 1.0, fract(sin(fi * 47.3) * 2531.7) * 2.0 - 1.0);
      s *= min(1.0, 0.85 / max(length(s), 1e-3));
      float r = i == 2 ? 0.12 : 0.075;
      vec2 span = s - prev;
      float len = length(span);
      if (i > 0 && len > prevR + r + 0.04) {
        vec2 u = span / len;
        d = min(d, mSeg(p, prev + u * prevR, s - u * r));
      }
      d = min(d, mRing(p, s, r));
      prev = s;
      prevR = r;
    }
    return d;
  }
  if (id == 4) {
    float lens = abs(max(length(p - vec2(0, 0.34)) - 0.5, length(p + vec2(0, 0.34)) - 0.5));
    return min(min(mStar(p - vec2(0, 0.05), 0.95, 3, 1, MPI * 0.5), lens * 1.0), mDot(p, vec2(0, -0.02), 0.11));
  }
  if (id == 5) return min(mRing(p, vec2(0), 0.92), mStar(p, 0.92, 5, 2, MPI * 0.5));
  if (id == 6) return min(mRing(p, vec2(0, 0.33), 0.4), min(mSeg(p, vec2(0, -0.07), vec2(0, -0.92)), mSeg(p, vec2(-0.32, -0.55), vec2(0.32, -0.55))));
  float d = mRing(p, vec2(0), 0.26);
  for (int i = 0; i < 3; i++) {
    vec2 u = mDir(MPI * 0.5 + float(i) * 2.0 * MPI / 3.0);
    d = min(d, min(mSeg(p, u * 0.26, u * 0.66), mRing(p, u * 0.8, 0.14)));
  }
  return d;
}

float motifMedieval(int id, vec2 p) {
  vec2 q = vec2(abs(p.x), p.y);
  if (id == 0) {
    // Fleur-de-lis: a tall central petal, two curled side petals, a band and a short foot.
    float petal = abs(max(length(p - vec2(0.3, 0.12)) - 0.42, length(p + vec2(0.3, -0.12)) - 0.42));
    petal = p.y < -0.18 ? 1e3 : petal;
    float curl = mArc(q, vec2(0.52, 0.02), 0.3, MPI * 0.55, MPI * 0.72);
    float band = min(mSeg(p, vec2(-0.5, -0.24), vec2(0.5, -0.24)), mSeg(p, vec2(-0.5, -0.36), vec2(0.5, -0.36)));
    float foot = mArc(q, vec2(0.0, -0.95), 0.5, MPI * 0.25, MPI * 0.2);
    return min(min(petal, curl), min(band, foot));
  }
  if (id == 1) {
    float d = 1e3;
    for (int i = 0; i < 3; i++) d = min(d, mRing(p, 0.4 * mDir(MPI * 0.5 + float(i) * 2.0 * MPI / 3.0), 0.48));
    return d;
  }
  if (id == 2) {
    // Cross pattee: four flared arms, outlined.
    vec2 a = abs(p);
    if (a.y > a.x) a = a.yx;
    float arm = max(max(a.y - (0.1 + 0.42 * clamp((a.x - 0.1) / 0.8, 0.0, 1.0)), a.x - 0.9), -a.x);
    return abs(arm) * 0.9;
  }
  if (id == 3) {
    float shield = min(min(mSeg(p, vec2(-0.72, 0.82), vec2(0.72, 0.82)), mSeg(q, vec2(0.72, 0.82), vec2(0.72, 0.05))), mArc(q, vec2(-0.25, 0.05), 0.97, -MPI * 0.25, MPI * 0.25));
    float chevron = min(mSeg(q, vec2(0.0, 0.42), vec2(0.62, -0.12)), mSeg(q, vec2(0.0, 0.16), vec2(0.6, -0.36)));
    return min(shield, chevron);
  }
  if (id == 4) {
    // Rose window: eight petals touching each other, the centre and the rim (r = D sin(pi/8), D + r = 0.92).
    float D = 0.92 / (1.0 + sin(MPI / 8.0));
    float r = D * sin(MPI / 8.0);
    float d = min(mRing(p, vec2(0), 0.92), mRing(p, vec2(0), D - r));
    for (int i = 0; i < 8; i++) d = min(d, mRing(p, D * mDir(float(i) * MPI * 0.25), r));
    return d;
  }
  if (id == 5) {
    float u = 1e3;
    for (int i = 0; i < 4; i++) u = min(u, length(p - 0.44 * mDir(float(i) * MPI * 0.5)) - 0.44);
    return min(abs(u), mStar(p, 0.3, 4, 1, MPI * 0.25));
  }
  if (id == 6) {
    float d = min(mSeg(p, vec2(-0.72, -0.55), vec2(0.72, -0.55)), mSeg(p, vec2(-0.72, -0.25), vec2(0.72, -0.25)));
    d = min(d, mSeg(q, vec2(0.72, -0.55), vec2(0.72, 0.55)));
    d = min(d, min(mSeg(q, vec2(0.72, 0.55), vec2(0.36, 0.05)), mSeg(q, vec2(0.36, 0.05), vec2(0.0, 0.7))));
    return min(d, min(mDot(q, vec2(0.72, 0.68), 0.08), mDot(p, vec2(0, 0.83), 0.08)));
  }
  float blade = min(mSeg(q, vec2(0.11, 0.42), vec2(0.11, -0.66)), mSeg(q, vec2(0.11, -0.66), vec2(0.0, -0.95)));
  return min(min(blade, mSeg(p, vec2(-0.5, 0.42), vec2(0.5, 0.42))), min(mSeg(p, vec2(0, 0.42), vec2(0, 0.68)), mRing(p, vec2(0, 0.8), 0.12)));
}

float motifSidereal(int id, vec2 p) {
  vec2 q = vec2(abs(p.x), p.y);
  // Aries: two horns curling out from a stem.
  if (id == 0) return min(mArc(q, vec2(0.34, 0.38), 0.34, MPI * 0.75, MPI * 0.75), mSeg(p, vec2(0, 0.38), vec2(0, -0.9)));
  // Taurus: a ring under an open arc.
  if (id == 1) return min(mRing(p, vec2(0, -0.3), 0.45), mArc(p, vec2(0, 0.62), 0.5, -MPI * 0.5, MPI * 0.5));
  // Gemini: two pillars between curved lintels.
  if (id == 2) return min(min(mSeg(q, vec2(0.32, 0.6), vec2(0.32, -0.6)), mArc(p, vec2(0, 1.6), 1.05, -MPI * 0.5, 0.45)), mArc(p, vec2(0, -1.6), 1.05, MPI * 0.5, 0.45));
  // Libra: a raised arc over a beam.
  if (id == 3) return min(min(mSeg(p, vec2(-0.85, -0.45), vec2(0.85, -0.45)), mSeg(q, vec2(0.38, -0.08), vec2(0.85, -0.08))), mArc(p, vec2(0, 0.12), 0.4, MPI * 0.5, MPI * 0.85));
  // Sagittarius: an arrow with a crossbar.
  if (id == 4) return min(min(mSeg(p, vec2(-0.75, -0.75), vec2(0.75, 0.75)), mSeg(p, vec2(0.75, 0.75), vec2(0.2, 0.75))), min(mSeg(p, vec2(0.75, 0.75), vec2(0.75, 0.2)), mSeg(p, vec2(-0.55, 0.05), vec2(0.05, -0.55))));
  // Aquarius: two zigzag waves.
  if (id == 5) {
    float d = 1e3;
    for (int row = 0; row < 2; row++) {
      float y = row == 0 ? 0.25 : -0.25;
      for (int i = 0; i < 4; i++) {
        float x0 = -0.85 + float(i) * 0.425;
        d = min(d, mSeg(p, vec2(x0, y - 0.15), vec2(x0 + 0.2125, y + 0.15)));
        d = min(d, mSeg(p, vec2(x0 + 0.2125, y + 0.15), vec2(x0 + 0.425, y - 0.15)));
      }
    }
    return d;
  }
  // Pisces: two arcs back to back, tied by a bar.
  if (id == 6) return min(mArc(q, vec2(1.05, 0), 0.82, MPI, 0.85), mSeg(p, vec2(-0.6, 0), vec2(0.6, 0)));
  // A two-armed spiral galaxy around a bright core.
  float r = length(p);
  float a = atan(p.y, p.x);
  float arm = 1e3;
  for (int k = 0; k < 2; k++) {
    float t = log(max(r, 1e-3) / 0.12) / 0.32;
    float phase = a - t - float(k) * MPI;
    float off = mod(phase + MPI, 2.0 * MPI) - MPI;
    arm = min(arm, abs(off) * r * 0.55);
  }
  arm = r < 0.14 || r > 0.92 ? 1e3 : arm;
  return min(arm, min(mDot(p, vec2(0), 0.14), mRing(p, vec2(0), 0.97) + 0.04));
}

// Alien script: a stroked path across a 3x3 grid, with a dot and sometimes a ring, all seeded.
float motifAlien(int id, vec2 p) {
  float seed = float(id) * 13.17 + motifSeed * 101.3;
  float d = 1e3;
  vec2 prev = vec2(0);
  for (int i = 0; i < 5; i++) {
    float h = fract(sin((seed + float(i)) * 53.71) * 43758.5);
    float k = floor(h * 9.0);
    vec2 g = vec2(mod(k, 3.0) - 1.0, floor(k / 3.0) - 1.0) * 0.72;
    if (i > 0 && length(g - prev) > 0.01) d = min(d, mSeg(p, prev, g));
    prev = g;
  }
  float hr = fract(sin(seed * 7.13) * 9341.7);
  vec2 c = vec2(mod(floor(hr * 9.0), 3.0) - 1.0, floor(floor(hr * 9.0) / 3.0) - 1.0) * 0.72;
  d = min(d, hr > 0.5 ? mRing(p, c, 0.22) : mDot(p, c, 0.1));
  float hd = fract(sin(seed * 3.71) * 2717.3);
  return min(d, mDot(p, vec2(hd * 1.2 - 0.6, hd > 0.5 ? 0.92 : -0.92), 0.08));
}

float motif(int set, int id, vec2 p) {
  if (set == 0) return motifGeometric(id, p);
  if (set == 1) return motifArcane(id, p);
  if (set == 2) return motifMedieval(id, p);
  if (set == 3) return motifSidereal(id, p);
  return motifAlien(id, p);
}
`;

// One row per set, one column per motif: squared distance in motif units.
export function createMotifAtlas(renderer) {
  const target = new WebGLRenderTarget(COLUMNS * CELL, ROWS * CELL, { type: HalfFloatType, format: RedFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { motifSeed: { value: 0 } },
    vertexShader: "out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: LIBRARY + `
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 g = vUv * vec2(${COLUMNS}.0, ${ROWS}.0);
  vec2 q = (fract(g) * 2.0 - 1.0) * ${EXTENT};
  // Squared distance: smooth across a stroke, so filtering doesn't clip the minimum on its centreline.
  float d = min(motif(int(g.y), int(g.x), q), 4.0);
  outColor = vec4(d * d, 0.0, 0.0, 1.0);
}`,
  });
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const camera = new OrthographicCamera();
  let drawn = null;
  return {
    texture: target.texture,
    compile: () => renderer.compileAsync(scene, camera),
    // The alien script and constellations depend on the seed, so the atlas is redrawn when it changes.
    draw(seed) {
      if (seed === drawn) return;
      drawn = seed;
      material.uniforms.motifSeed.value = seed;
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
    },
  };
}

export const MOTIFS = /* glsl */ `
uniform sampler2D motifAtlas;
uniform float motifSet;
uniform float motifVariety;
uniform float motifSeed;
float motif(int set, int id, vec2 p) {
  vec2 cell = clamp(p / ${EXTENT} * 0.5 + 0.5, vec2(0.5 / ${CELL}.0), vec2(1.0 - 0.5 / ${CELL}.0));
  return sqrt(max(textureLod(motifAtlas, (vec2(float(id), float(set)) + cell) / vec2(${COLUMNS}.0, ${ROWS}.0), 0.0).r, 0.0));
}

// Which motif a part shows: variety 0 gives every part the same one, 1 a different one for almost every part.
void motifPick(float part, out int set, out int id) {
  // An integer hash of the part: a sine hash amplifies tiny differences in its input from pixel to pixel.
  uint x = uint(part + 0.5) * 747796405u + uint(motifSeed * 65536.0) * 2891336453u + 1u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  float h = float(x & 0xffffu) / 65536.0;
  float h2 = float(x >> 16u) / 65536.0;
  float count = 1.0 + floor(motifVariety * 7.999);
  id = int(mod(floor(motifSeed * 8.0) + floor(h * count), 8.0));
  float s = motifSet;
  if (s > 4.5) s = mod(floor(motifSeed * 5.0) + floor(h2 * (1.0 + 4.0 * motifVariety)), 5.0);
  set = int(s + 0.5);
}
// Size of a pixel on the unit sphere; taken outside any branch, where screen derivatives are reliable.
float motifPixel(vec3 p) {
  return max(max(length(dFdx(p)), length(dFdy(p))), 1e-7);
}
// Distance to a motif of the given radius centred on c, its up direction towards up. A motif only a few pixels
// across can't show its strokes, so it fades out instead of breaking into speckles.
float motifAt(vec3 p, vec3 c, vec3 up, float radius, float part, float pixel) {
  float shown = smoothstep(3.5, 7.0, radius / pixel);
  if (shown <= 0.0) return 1e3;
  float w = dot(p, c);
  if (w < 0.0) return 1e3;
  vec3 y = normalize(up - c * dot(up, c));
  vec3 x = cross(y, c);
  vec2 q = vec2(dot(p, x), dot(p, y)) / (w * radius);
  if (dot(q, q) > 1.6) return 1e3;
  int set, id;
  motifPick(part, set, id);
  return motif(set, id, q) * radius + (1.0 - shown) * radius * 0.6;
}
`;
