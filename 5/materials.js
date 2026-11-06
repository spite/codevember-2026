import { ShaderMaterial, GLSL3, Color, Data3DTexture, RGBAFormat, UnsignedByteType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, Matrix3 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const noiseGLSL = /* glsl */ `
float fHash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float fNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fHash(i), fHash(i + vec3(1, 0, 0)), f.x), mix(fHash(i + vec3(0, 1, 0)), fHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(fHash(i + vec3(0, 0, 1)), fHash(i + vec3(1, 0, 1)), f.x), mix(fHash(i + vec3(0, 1, 1)), fHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

// Moss thickness from the baked rank (uv.x): coverage sweeps from the best spots outwards.
const mossVertexPars = /* glsl */ `
in vec4 cushion;
in float species;
uniform float growth;
uniform float mossDepth;
uniform float mossEdge;
uniform float bodyFraction;
float mossCover(float rank) {
  return smoothstep(1.0 - growth, 1.0 - growth + mossEdge, rank);
}
float speciesHeight(float s) { return s < 0.42 ? 0.7 : s < 0.7 ? 0.85 : s < 0.88 ? 1.15 : 1.0; }
float mossThickness(float rank, float cover) {
  float core = smoothstep(1.0 - growth, 1.0, rank);
  return cover * mossDepth * cushion.w * speciesHeight(species) * (0.45 + 0.55 * sqrt(core));
}
vec3 mossNormal(vec3 n, float cover) {
  return normalize(n - cushion.xyz * mossDepth * cover * 1.4);
}
`;

const paletteGLSL = /* glsl */ `
uniform vec3 mossTips[4];
uniform vec3 mossRoot;
int speciesIndex(float s) { return s < 0.42 ? 0 : s < 0.7 ? 3 : s < 0.88 ? 1 : 2; }
vec3 speciesTip(float s) { return mossTips[speciesIndex(s)]; }
`;

const PALETTES = {
  forest: { root: 0x0c1004, tips: [0x4f5e18, 0x66881c, 0x9cc02a, 0x5d7a3c] },
  lime: { root: 0x101804, tips: [0x6a8a18, 0x8db222, 0xb4dc30, 0x7a9a32] },
  bluegreen: { root: 0x08120a, tips: [0x355a2e, 0x4c7a3c, 0x7aa644, 0x608a6a] },
  autumn: { root: 0x161006, tips: [0x6e5a1c, 0x86801e, 0xa89a2c, 0x7a7a3a] },
};

const STONES = {
  bone: { color: 0xc4bcab, rough: 0.86 },
  limestone: { color: 0xa9a598, rough: 0.9 },
  bark: { color: 0x4a4136, rough: 0.95 },
  clay: { color: 0x9c7a63, rough: 0.88 },
};

function paletteUniforms() {
  return {
    mossTips: { value: [new Color(), new Color(), new Color(), new Color()] },
    mossRoot: { value: new Color() },
  };
}

function applyPalette(materials, name) {
  const p = PALETTES[name] ?? PALETTES.forest;
  for (const m of materials) {
    m.uniforms.mossRoot.value.setHex(p.root);
    p.tips.forEach((c, i) => m.uniforms.mossTips.value[i].setHex(c));
  }
}

// Tileable 3D Voronoi: R = shoot profile (1 at the stem), G = height, B = tint, 8 cells per axis.
function createShootTexture(size = 64, cells = 8) {
  const data = new Uint8Array(size * size * size * 4);
  const h = (x, y, z, s) => {
    let v = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(s, 2654435761);
    v = Math.imul(v ^ (v >>> 15), 2246822519);
    v = Math.imul(v ^ (v >>> 13), 3266489917);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  // Per cell: its point and the random height and tint.
  const C3 = cells ** 3, cell = new Float32Array(C3 * 5);
  for (let i = 0; i < C3; i++) {
    const x = i % cells, y = Math.floor(i / cells) % cells, z = Math.floor(i / cells / cells);
    for (let s = 0; s < 5; s++) cell[i * 5 + s] = (s < 3 ? 0.15 + 0.7 * h(x, y, z, s + 1) : h(x, y, z, s + 1));
  }
  const k = cells / size;
  let t = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++, t += 4) {
        const px = (x + 0.5) * k, py = (y + 0.5) * k, pz = (z + 0.5) * k;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        let d1 = 9, hh = 0, tint = 0;
        for (let c = -1; c <= 1; c++)
          for (let b = -1; b <= 1; b++)
            for (let a = -1; a <= 1; a++) {
              const cx = ix + a, cy = iy + b, cz = iz + c;
              const o = (((cx + cells) % cells) + cells * (((cy + cells) % cells) + cells * ((cz + cells) % cells))) * 5;
              const dx = cx + cell[o] - px, dy = cy + cell[o + 1] - py, dz = cz + cell[o + 2] - pz;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < d1) { d1 = d; hh = cell[o + 3]; tint = cell[o + 4]; }
            }
        data[t] = Math.round(Math.max(0, 1 - Math.sqrt(d1) / 0.75) * 255);
        data[t + 1] = Math.round(hh * 255);
        data[t + 2] = Math.round(tint * 255);
        data[t + 3] = 255;
      }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function mossUniforms(shared) {
  return {
    growth: shared.growth,
    mossDepth: shared.mossDepth,
    mossEdge: shared.mossEdge,
    bodyFraction: shared.bodyFraction,
    stain: shared.stain,
    ...paletteUniforms(),
  };
}

function createShared() {
  return {
    growth: { value: 0 },
    mossDepth: { value: 0.05 },
    mossEdge: { value: 0.14 },
    bodyFraction: { value: 0.4 },
    stain: { value: 0.35 },
    stoneColor: { value: new Color(STONES.bone.color) },
    stoneRough: { value: STONES.bone.rough },
    aoBake: { value: 0.75 },
    shoots: { value: createShootTexture() },
    shootSize: { value: 0.016 },
    lean: { value: 0.6 },
    layers: { value: 16 },
    layerStride: { value: 1 },
    heroBasis: { value: new Matrix3() },
    splay: { value: 0.0015 },
    weathering: { value: 0.5 },
  };
}

// Value noise with its gradient, and the nearest cell of a 3D Voronoi (offset to its point, its random value).
const stoneNoiseGLSL = /* glsl */ `
// pcg3d hash: no lattice patterns, unlike fHash on integer cells.
vec4 cellHash(vec3 c) {
  uvec3 v = uvec3(ivec3(c) + 32768) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec4(v, v.x ^ v.y ^ v.z) * (1.0 / 4294967296.0);
}
// Simplex noise in [0, 1] with its gradient (xyz of the result in yzw), free of the axis-aligned creases
// of value noise (Ashima / Gustavson).
vec4 sMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 sMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sPermute(vec4 x) { return sMod289(((x * 34.0) + 10.0) * x); }
vec4 fNoiseD(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - 0.5;
  i = sMod289(i);
  vec4 p = sPermute(sPermute(sPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec4 j = p - 49.0 * floor(p * (1.0 / 49.0));
  vec4 x_ = floor(j * (1.0 / 7.0));
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * (2.0 / 7.0) + (0.5 / 7.0 - 1.0), y = y_ * (2.0 / 7.0) + (0.5 / 7.0 - 1.0);
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0, s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = normalize(vec3(a0.xy, h.x)), p1 = normalize(vec3(a0.zw, h.y)), p2 = normalize(vec3(a1.xy, h.z)), p3 = normalize(vec3(a1.zw, h.w));
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m, m4 = m2 * m2;
  vec4 px = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 t = m2 * m * px;
  vec3 grad = -6.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3) + m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return vec4(0.5 + 52.5 * dot(m4, px), 52.5 * grad);
}
float sNoise(vec3 p) { return fNoiseD(p).x; }
// Points sit 0.2-0.8 into their cell, so the 2x2x2 cells nearest p hold every point within 0.5 of it.
vec4 fCell(vec3 p) {
  vec3 i = floor(p + 0.5) - 1.0;
  float d1 = 9.0;
  vec4 best = vec4(0.0);
  for (int z = 0; z <= 1; z++)
  for (int y = 0; y <= 1; y++)
  for (int x = 0; x <= 1; x++) {
    vec3 c = i + vec3(x, y, z);
    vec4 h = cellHash(c);
    vec3 o = c + 0.2 + 0.6 * h.xyz - p;
    float d = dot(o, o);
    if (d < d1) { d1 = d; best = vec4(o, h.w); }
  }
  return best;
}
`;

// The sculpture with the moss mat: displaced by the dense lower part of the moss.
function createBodyMaterial(shared) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.85,
    sheen: 1,
    sheenColor: 0x000000,
    sheenRoughness: 0.5,
    uniforms: {
      ...mossUniforms(shared),
      stoneColor: shared.stoneColor,
      stoneRough: shared.stoneRough,
      aoBake: shared.aoBake,
      heroBasis: shared.heroBasis,
      weathering: shared.weathering,
    },
    varyings: { vRoot: "vec3", vCover: "float", vSpecies: "float", vCurve: "float" },
    vertexPars: mossVertexPars + "in float curve; float bodyCover;",
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  float c = mossCover(uv.x);
  if (!pipelinePrevPose) bodyCover = c;
  float h = mossThickness(uv.x, c) * bodyFraction;
  vec3 q = p + n * h;
  n = mossNormal(n, c);
  return q;
}`,
    vertexMain: "vRoot = position; vCover = bodyCover; vSpecies = species; vCurve = curve;",
    fragmentPars: noiseGLSL + stoneNoiseGLSL + paletteGLSL + /* glsl */ `
uniform float growth;
uniform float mossEdge;
uniform float stain;
uniform vec3 stoneColor;
uniform float stoneRough;
uniform float aoBake;
uniform mat3 heroBasis;
uniform float weathering;
// Detail of this frequency fades out once a pixel covers half its period.
float detail(float fw, float freq) { return 1.0 - smoothstep(0.25, 0.6, fw * freq); }
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifndef PIPELINE_SHADOW
  float rank = vUv.x;
  float ao = vUv.y;
  vec3 p = vRoot;
  float fw = length(fwidth(p));
  float m = smoothstep(0.0, 0.35, vCover);
  float wear = weathering;

  // Relief: a slow swell, grit and fine grain, plus scattered pits; g is the height's gradient (world units).
  vec4 n1 = fNoiseD(p * 9.0);
  vec4 n2 = fNoiseD(p * 34.0 + 7.1);
  vec4 n3 = fNoiseD(p * 100.0 + 3.7);
  float k2 = detail(fw, 34.0), k3 = detail(fw, 100.0), kp = detail(fw, 26.0);
  vec3 g = n1.yzw * 0.04 + n2.yzw * (0.08 * k2) + n3.yzw * (0.065 * k3);
  // Solution grooves: creases where a warped noise crosses its midpoint.
  vec4 n4 = fNoiseD(p * 15.0 + n1.yzw * 0.08 + 2.3);
  float gv = n4.x - 0.5, groove = 1.0 - smoothstep(0.0, 0.28, abs(gv));
  groove *= groove;
  g += sign(gv) * n4.yzw * (0.05 * groove) * detail(fw, 15.0);
  vec4 pc = fCell(p * 26.0);
  float pd = length(pc.xyz), pr = mix(0.12, 0.38, fract(pc.w * 7.13));
  float pit = pc.w < 0.25 + 0.3 * wear ? 1.0 - smoothstep(0.0, pr, pd) : 0.0;
  // A pit gets shallower away from its point (along -pc.xyz).
  g -= pc.xyz / max(pd, 1e-4) * (pit / pr) * 0.06 * kp;
#ifdef PIPELINE_PREPASS
  // The prepass only needs the bent normal.
  vec3 gp = heroBasis * g * (1.0 - m);
  s.normal = normalize(s.normal - (gp - s.normal * dot(gp, s.normal)));
#else
  float grain = mix(0.5, n3.x, k3) * 0.45 + n2.x * 0.55;

  // Colour: mineral mottling, faint strata and grit.
  float blot = sNoise(p * 6.0 + 3.1);
  float patchy = smoothstep(0.35, 0.75, sNoise(p * 2.6 + 5.7) * 0.7 + blot * 0.3);
  vec3 stone = stoneColor * (0.76 + 0.42 * grain) * mix(0.78, 1.12, blot);
  float bleach = smoothstep(0.6, 0.85, sNoise(p * 3.7 + 9.1));
  stone = mix(stone, stone * vec3(0.72, 0.68, 0.6), patchy * 0.75);
  stone = mix(stone, stone * 1.15 + vec3(0.03, 0.03, 0.025), bleach * 0.6);
  stone *= mix(vec3(1.05, 1.0, 0.93), vec3(0.95, 0.99, 1.05), n1.x);
  float strata = 0.5 + 0.5 * sin(p.y * 46.0 + n1.x * 5.0 + n2.x * 1.5);
  stone *= mix(1.0, 0.94 + 0.06 * strata, 0.5);
  stone *= 1.0 - 0.35 * pit * kp;
  stone *= 1.0 - (0.03 + 0.05 * wear) * groove * detail(fw, 15.0);

  // Weathering: worn, paler ridges; grime in the hollows; streaks run down the sides.
  float ridge = smoothstep(0.1, 0.6, vCurve), hollow = smoothstep(0.05, 0.45, -vCurve);
  vec3 N0 = normalize(vObjectNormal);
  stone = mix(stone, stone * 1.18 + 0.02, ridge * (0.4 + 0.6 * wear));
  stone = mix(stone, stone * vec3(0.45, 0.46, 0.36), hollow * (0.35 + 0.55 * wear));
  float side = 1.0 - smoothstep(0.4, 0.85, abs(N0.y));
  float streak = smoothstep(0.55, 0.85, sNoise(vec3(p.x * 38.0, p.y * 2.5, p.z * 38.0)) * (0.7 + 0.6 * blot));
  stone *= 1.0 - 0.22 * streak * side * wear * detail(fw, 38.0);

  // Crustose lichen on open, upward stone: rosettes with a ragged, granular edge, a paler rim and cracked areoles.
  float open = smoothstep(0.2, 0.5, ao) * smoothstep(-0.85, -0.2, N0.y) * (1.0 - smoothstep(0.0, 0.15, vCover));
  float lichen = 0.0, rim = 0.0;
  vec3 lp = p * 10.0 + 11.3 + (n1.yzw - 0.5) * 0.2;
  vec4 lc = open > 0.0 ? fCell(lp) : vec4(1.0);
  if (lc.w < 0.15 + 0.5 * wear) {
    float ld = length(lc.xyz) + (n2.x - 0.5) * 0.16;
    float lr = mix(0.16, 0.44, pow(fract(lc.w * 5.37), 1.4));
    // Lobes around the rim, broken up by grit.
    float lobes = fNoiseD(normalize(lc.xyz + 1e-5) * 3.0 + lc.w * 31.0).x;
    float edge = lr * (0.75 + 0.45 * lobes) - ld + (n3.x - 0.5) * 0.16 * k3 + (n2.x - 0.5) * 0.1;
    lichen = smoothstep(0.0, 0.03, edge) * open;
    float kind = fract(lc.w * 13.7);
    // Tinted from the stone under it, so the crust sits in the same light: grey-green, pale grey, rarely ochre.
    float base = mix(dot(stone, vec3(0.3, 0.55, 0.15)), 0.42, 0.5);
    vec3 lcol = base * (kind < 0.45 ? vec3(0.95, 1.18, 0.74) : kind < 0.86 ? vec3(1.28, 1.32, 1.2) : vec3(1.5, 0.98, 0.32));
    rim = 1.0 - smoothstep(0.0, 0.08, edge);
    float crack = (1.0 - smoothstep(0.0, 0.05, abs(fNoiseD(lp * 7.0).x - 0.5))) * k3;
    float areole = fNoiseD(lp * 22.0 + 4.1).x;
    lcol *= mix(0.82, 1.1, rim) * (1.0 - 0.45 * crack) * mix(1.0, 0.6 + 0.8 * areole, k3) * (0.8 + 0.4 * n3.x);
    // A dark margin (the prothallus) just outside the crust.
    float margin = smoothstep(-0.05, -0.01, edge) * (1.0 - smoothstep(0.0, 0.03, edge)) * open;
    stone *= 1.0 - 0.4 * margin;
    stone = mix(stone, lcol, lichen * (0.55 + 0.35 * smoothstep(0.2, 0.7, n2.x)));
    // The crust stands slightly proud: a ridge where it starts.
    g -= lc.xyz / max(length(lc.xyz), 1e-4) * lichen * rim * 0.12;
  }

  // Green stain ahead of the moss front and in the damp hollows.
  float ahead = smoothstep(1.0 - growth - 0.25, 1.0 - growth, rank) * (1.0 - vCover);
  float damp = (1.0 - ao) * 0.5;
  vec3 stainCol = mix(mossRoot * 2.5, speciesTip(vSpecies) * 0.55, 0.5);
  stone = mix(stone, stainCol, clamp((ahead * 0.8 + damp * growth + hollow * 0.3 * wear) * stain * (0.6 + 0.8 * blot), 0.0, 0.85));
  stone *= mix(0.45, 1.0, smoothstep(0.15, 0.85, ao));
  vec3 mat = mix(mossRoot, speciesTip(vSpecies) * 0.5, 0.35 * grain);
  s.albedo = mix(stone, mat, m);

  // The relief bends the normal, along the surface only, and fades under the moss.
  vec3 gw = heroBasis * g * (1.0 - m);
  s.normal = normalize(s.normal - (gw - s.normal * dot(gw, s.normal)));

  float stoneRgh = stoneRough - 0.1 * grain - 0.12 * ridge + 0.06 * hollow + 0.08 * pit - 0.1 * lichen * (1.0 - rim);
  s.roughness = mix(mix(stoneRgh, 0.6, damp * growth), 0.9, m);
  s.specular = mix(mix(1.0, 0.6, lichen), 0.4, m);
  s.sheenColor = speciesTip(vSpecies) * 0.35 * m;
  s.occlusion *= mix(aoBake, 1.0, ao) * (1.0 - 0.25 * pit * kp) * (1.0 - 0.08 * groove);
#endif
#endif
}`,
  });
}

// Fur shells: one instance per layer (outermost first), each an alpha-tested slice through the shoots.
function createShellMaterial(shared, { lite = false } = {}) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness: 0.75,
    sheen: 1,
    sheenColor: 0x000000,
    sheenRoughness: 0.35,
    defines: { SHADOW_PCF_SAMPLES: lite ? 4 : 8, SHADOW_BLOCKER_SAMPLES: lite ? 4 : 8, MOSS_TRANSMISSION: lite ? 0 : 1 },
    uniforms: {
      ...mossUniforms(shared),
      shoots: shared.shoots,
      shootSize: shared.shootSize,
      lean: shared.lean,
      layers: shared.layers,
      layerStride: shared.layerStride,
      aoBake: shared.aoBake,
      heroBasis: shared.heroBasis,
      splay: shared.splay,
    },
    varyings: { vRoot: "vec3", vLayer: "float", vCover: "float", vSpecies: "float", vCushion: "vec4", vSpacing: "float" },
    vertexPars: mossVertexPars + "uniform float layers; uniform float layerStride; float shellCover; float shellSpacing;",
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  float t = (layers - float(gl_InstanceID) * layerStride) / layers;
  float c = mossCover(uv.x);
  float m = mossThickness(uv.x, c);
  if (!pipelinePrevPose) { shellCover = c; shellSpacing = m * (1.0 - bodyFraction) / layers; }
  float h = m * mix(bodyFraction, 1.0, t);
  vec3 q = p + n * h;
  n = mossNormal(n, c);
  return q;
}`,
    vertexMain: "vRoot = position; vLayer = (layers - float(gl_InstanceID) * layerStride) / layers; vCover = shellCover; vSpecies = species; vCushion = cushion; vSpacing = shellSpacing;",
    fragmentPars: noiseGLSL + paletteGLSL + /* glsl */ `
uniform highp sampler3D shoots;
uniform float shootSize;
uniform float lean;
uniform float aoBake;
uniform float layers;
uniform mat3 heroBasis;
uniform float splay;
#ifdef MOSS_ZFILL
// Same program as the lit shells, so depth matches exactly; without an output the lighting compiles away.
vec4 mossZfillSink;
#define outColor mossZfillSink
#endif
// Per species: height, leaf length, leaf count, lean.
const vec4 SPECIES[4] = vec4[4](
  vec4(0.55, 0.30, 3.0, 1.4), vec4(0.75, 0.38, 5.0, 0.2),
  vec4(0.70, 0.55, 7.0, 0.5), vec4(0.62, 0.22, 6.0, 0.1));
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  // Per-fragment slice jitter hides the gaps between layers.
  float t = vLayer + (fHash(vRoot * 4000.0) - 0.5) / layers;
  int k = speciesIndex(vSpecies);
  vec4 sp = SPECIES[k];
  vec3 n0 = normalize(vObjectNormal);
  vec3 down = vec3(0.0, -1.0, 0.0);
  vec3 droop = down - n0 * dot(down, n0);
  vec3 off = droop * (t * t * lean * sp.w * shootSize) - vCushion.xyz * (t * splay);
  vec3 q = (vRoot + off) / (shootSize * 8.0);
  vec3 qx = dFdx(q);
  vec3 qy = dFdy(q);
  float lod = clamp(log2(max(length(qx), length(qy)) * 64.0 + 1e-6) / 3.0, 0.0, 1.0);
  // Under a few pixels per shoot the canopy turns to velvet.
  float far = smoothstep(0.9, 1.8, length(abs(qx) + abs(qy)) * 8.0);
  float grown = smoothstep(0.0, 0.5, vCover) * mix(0.55, 1.0, smoothstep(0.1, 0.6, vCushion.w));
  // Above the tallest shoot this cell can have: empty whatever the texture says.
  if (t > max(sp.x * 1.3 * grown, 1e-3)) discard;
  vec4 sh = texture(shoots, q);
  float d = (1.0 - sh.r) * 0.75;
  float hgt = sp.x * (0.6 + 0.4 * sh.g) * (sh.g > 0.94 ? 1.3 : 1.0) * grown;
  float tt = t / max(hgt, 1e-3);
  float env = smoothstep(0.05, 0.3, tt) * (1.0 - smoothstep(0.7, 1.0, tt));
  float reach0 = mix(0.6, 0.16, pow(tt, 1.3));
  float lodScale = mix(1.0, 1.4, lod);
  float velvet = 0.75 * (1.0 - tt * tt);
  float alive = step(fract(sh.b * 31.7), mix(0.12, 1.0, vCover));
  // Leaves: lobes around each stem, from the direction to its centre.
  vec3 T = normalize(cross(n0, vec3(0.48, 0.6, 0.64)));
  vec3 B = cross(n0, T);
  vec2 g = vec2(texture(shoots, q + T / 64.0).r, texture(shoots, q + B / 64.0).r) - sh.r;
  vec2 radial = -normalize(g + 1e-5);
  float leaves = pow(0.5 + 0.5 * cos(sp.z * atan(radial.y, radial.x) + sh.b * 6.283 + tt * 5.0), 4.0);
  float reach = mix((reach0 + sp.y * 0.6 * leaves * env) * lodScale, velvet, far);
  s.alpha = max(step(d, reach) * step(tt, 1.0) * alive, step(tt, 0.06) * step(0.3, vCover));
#if defined(PIPELINE_COLOR) && !defined(MOSS_ZFILL)
  // The depth-only shells did the alpha test, unless the layers are too close to tell apart in depth.
  vec3 toEye = vWorldPosition - cameraPosition;
  if (vSpacing > 4e-6 * dot(toEye, toEye)) s.alpha = 1.0;
#endif
#ifndef PIPELINE_SHADOW
  vec3 rW = heroBasis * (T * radial.x + B * radial.y);
  s.normal = normalize(s.normal + rW * (1.0 - far) * mix(1.3, 0.5, tt));
  vec3 base = mossTips[k] * mix(0.75, 1.15, fNoise(vRoot * 12.0 + float(k) * 7.3));
  vec3 stem = mix(mossRoot, base * vec3(0.55, 0.5, 0.35), smoothstep(0.0, 0.5, tt));
  vec3 young = base * vec3(1.2, 1.25, 0.7);
  vec3 col = mix(stem, base, smoothstep(0.25, 0.75, tt));
  col = mix(col, young, smoothstep(0.75, 1.0, tt)) * (0.9 + 0.2 * sh.b);
  // Moss above this fragment toward the key darkens it; s.occlusion only reaches indirect light.
  vec3 L = normalize(lightDirection);
  float cosL = max(dot(normalize(vWorldNormal), L), 0.15);
  float above = max(hgt - t, 0.0);
  s.albedo = col * mix(0.15, 1.0, exp(-2.5 * above / cosL));
  s.occlusion *= mix(0.4, 1.0, exp(-2.5 * above)) * mix(aoBake, 1.0, vUv.y);
  s.roughness = mix(0.8, 0.5, tt);
  s.specular = 0.6;
  s.sheenColor = young * 0.5 * smoothstep(0.6, 1.0, tt);
#if MOSS_TRANSMISSION
  s.transmission = vec3(1.0, 1.1, 0.55) * base * 0.9 * smoothstep(0.5, 1.0, tt);
#endif
#endif
}`,
  });
}

// Depth-only shells for the main pass, so the lit shells (EqualDepth) shade one layer per pixel.
function createShellDepthMaterial(shell) {
  const defines = { ...shell.defines, MOSS_ZFILL: "" };
  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: shell.uniforms,
    vertexShader: shell.vertexShader,
    fragmentShader: shell.fragmentShader,
    defines,
    side: shell.side,
    colorWrite: false,
  });
  m.toneMapped = false;
  m.customProgramCacheKey = () => "pipeline-color";
  return m;
}

export { createShellDepthMaterial, createShared, createBodyMaterial, createShellMaterial, applyPalette, PALETTES, STONES };
