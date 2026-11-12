// Rusted machine parts. Patterns live in each part's own space (they turn with it); gravity effects use the direction
// that was up for the part before it started turning, as for a machine that sat still for years. Gears know their own
// zones (tooth roots, flanks, tips, bore) from their local coordinates: z is the axle, radius from it.
import { Data3DTexture, DataArrayTexture, DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, NearestFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, Vector3, Vector4, Color } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { CORROSION_SIZE } from "./corrosion.js";

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function texture3D(data, size, nearest = false) {
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = tex.magFilter = nearest ? NearestFilter : LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// Smooth tiling noise in four channels: blurred white noise, contrast restored.
function noiseTexture(size = 64) {
  const rand = mulberry32(1234);
  const n = size ** 3;
  let a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = rand();
  const idx = (x, y, z) => ((x & (size - 1)) + (y & (size - 1)) * size + (z & (size - 1)) * size * size) * 4;
  for (let pass = 0; pass < 2; pass++)
    for (let axis = 0; axis < 3; axis++) {
      const dx = axis === 0 ? 1 : 0, dy = axis === 1 ? 1 : 0, dz = axis === 2 ? 1 : 0;
      for (let z = 0; z < size; z++)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const o = idx(x, y, z), m = idx(x - dx, y - dy, z - dz), p = idx(x + dx, y + dy, z + dz);
            for (let c = 0; c < 4; c++) b[o + c] = 0.25 * a[m + c] + 0.5 * a[o + c] + 0.25 * a[p + c];
          }
      [a, b] = [b, a];
    }
  const data = new Uint8Array(n * 4);
  for (let c = 0; c < 4; c++) {
    let mean = 0, sq = 0;
    for (let i = c; i < a.length; i += 4) mean += a[i];
    mean /= n;
    for (let i = c; i < a.length; i += 4) sq += (a[i] - mean) ** 2;
    const sd = Math.sqrt(sq / n);
    for (let i = c; i < a.length; i += 4) data[i] = Math.max(0, Math.min(255, Math.round((0.5 + ((a[i] - mean) / sd) * 0.18) * 255)));
  }
  return texture3D(data, size);
}

async function pixels(blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return { data: new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer), width: bitmap.width, height: bitmap.height };
}

function tiled(tex, srgb) {
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// The shared textures: grown corrosion fields (corrosion.bin, see tools/bake.mjs), noise, and the CC0 rust scans.
export async function loadRustTextures({ corrosion, color, normal, data }) {
  const [c, nm, d] = await Promise.all([pixels(color), pixels(normal), pixels(data)]);
  const n = CORROSION_SIZE ** 3 * 4;
  return {
    corrosionTex: texture3D(corrosion.subarray(0, n), CORROSION_SIZE),
    cellTex: texture3D(corrosion.slice(n), CORROSION_SIZE, true),
    noiseTex: noiseTexture(),
    scanColor: tiled(new DataArrayTexture(c.data, c.width, c.height / 2, 2), true),
    scanNormal: tiled(new DataArrayTexture(nm.data, nm.width, nm.height / 2, 2), false),
    scanData: tiled(new DataTexture(d.data, d.width, d.height), false),
  };
}

// Rust eats edges round and heaves the surface: vertices sink along their crease-smoothed normal (material removal
// only, so meshed teeth never touch), more where the rust is older.
const vertexPars = /* glsl */ `
in vec3 aSmooth;
in float aCavity;
in float aConvex;
uniform highp sampler3D noiseTex;
uniform float age;
uniform float seed;
uniform float brass;
`;

const vertex = /* glsl */ `
float heave(vec3 p) {
  vec3 q = p + seed * 3.7;
  float a = textureLod(noiseTex, q * 9.0, 0.0).x, b = textureLod(noiseTex, q * 23.0 + 0.4, 0.0).y;
  return smoothstep(0.35, 0.7, a * 0.65 + b * 0.35);
}
// The prepass calls displace twice (this pose and last frame's); the rust doesn't move, so the second call reuses it.
vec3 rmDisplaced;
bool rmHasDisplaced = false;
vec3 displace(vec3 p, inout vec3 n) {
  if (rmHasDisplaced) return rmDisplaced;
  vSmooth = aSmooth;
  vCavity = aCavity;
  vConvex = aConvex;
  // Brass only tarnishes: it barely heaves or rounds.
  float k = 1.0 - 0.85 * brass;
  float hv = heave(p);
  // Rust swells: the crust puffs out a fraction of a millimetre in lumps (under the gears' backlash, so meshed teeth
  // stay clear) and only softens the edges a little.
  float amount = smoothstep(0.15, 0.9, age);
  float puff = amount * (0.00022 + 0.00016 * (hv - 0.5));
  float eaten = aConvex * smoothstep(0.3, 1.0, age) * 0.0012 * (0.6 + 0.8 * hv);
  rmDisplaced = p + aSmooth * (k * (puff - eaten));
  rmHasDisplaced = true;
  return rmDisplaced;
}
`;

const fragmentPars = /* glsl */ `
uniform highp sampler3D corrosionTex;
uniform highp sampler3D cellTex;
uniform highp sampler3D noiseTex;
uniform highp sampler2DArray scanColor;
uniform highp sampler2DArray scanNormal;
uniform sampler2D scanData;
uniform float age;       // 0 bare, 1 heavily rusted
uniform float inUse;     // 1 a running machine (polished flanks, fresh grease), 0 abandoned
uniform float grease;
uniform float brass;
uniform float meshing;   // 1 when this part's teeth run against another part
uniform float seed;
uniform vec4 gearZones;  // root radius, pitch radius, tip radius, bore radius (0: not a gear)
uniform vec3 rustYoung;  // the palette: fresh margins, mature crust, oldest scale, and a second hue patches lean to
uniform vec3 rustMature;
uniform vec3 rustOld;
uniform vec3 rustAlt;
uniform float rustRough;
uniform float rustMix;  // 0..1 patches of other rust colours over the base
uniform float flaking;  // 0..1 crust crazing into plates that lift, curl and fall away
uniform float visible;  // 0..1 screen-door dissolve for parts arriving and leaving
uniform float grime;    // 0..1 soot and dirt packed into crevices
uniform float edgePits; // 0..1 strength of the pitting along edges
uniform vec4 gearBody;  // rim radius, hub radius, half thickness of the sunk web (0: solid), half hub width
uniform float halfWidth; // half the gear's face width along its axle (0: unknown)
uniform vec3 localUp;
uniform float pixelAngle;
uniform mat4 modelMatrix;
uniform float instanced; // chain links: modelMatrix isn't the link's own, so the scanned normals are left out

const mat3 ROT = mat3(0.36, 0.48, -0.8, -0.8, 0.6, 0.0, 0.48, 0.64, 0.6);

// iq's texture-repetition fix (technique 3) on a 3D texture.
vec4 noTile(highp sampler3D tex, vec3 p) {
  vec3 dx = dFdx(p), dy = dFdy(p);
  float l = textureLod(noiseTex, p * 0.07 + 0.5, 0.0).x * 8.0;
  float i = floor(l), f = fract(l);
  vec4 a = textureGrad(tex, p + sin(vec3(3.0, 7.0, 11.0) * i) * 7.3, dx, dy);
  if (f < 0.2) return a;
  vec4 b = textureGrad(tex, p + sin(vec3(3.0, 7.0, 11.0) * (i + 1.0)) * 7.3, dx, dy);
  return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * (a.x - b.x + a.y - b.y)));
}

// The same for the 2D scans, triplanar in the part's space. Gradients come in from outside, so planes with no weight
// can be skipped in a branch (most pixels need one of the three).
vec4 scanNT(vec2 uv, vec2 dx, vec2 dy, float layer, float salt) {
  float l = textureLod(noiseTex, vec3(uv * 0.07, salt), 0.0).x * 8.0;
  float i = floor(l), f = fract(l);
  vec4 a = textureGrad(scanColor, vec3(uv + sin(vec2(3.0, 7.0) * i) * 7.3, layer), dx, dy);
  if (f < 0.2) return a;
  vec4 b = textureGrad(scanColor, vec3(uv + sin(vec2(3.0, 7.0) * (i + 1.0)) * 7.3, layer), dx, dy);
  return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * dot(a.rgb - b.rgb, vec3(1.0))));
}
vec3 triW(vec3 n) {
  vec3 w = pow(abs(n), vec3(8.0));
  w /= w.x + w.y + w.z;
  w = max(w - 0.02, 0.0);
  return w / (w.x + w.y + w.z);
}
vec3 scanTri(vec3 p, vec3 w, float layer) {
  vec3 dx = dFdx(p), dy = dFdy(p);
  vec3 c = vec3(0.0);
  if (w.x > 0.0) c += scanNT(p.zy, dx.zy, dy.zy, layer, 0.1).rgb * w.x;
  if (w.y > 0.0) c += scanNT(p.xz, dx.xz, dy.xz, layer, 0.4).rgb * w.y;
  if (w.z > 0.0) c += scanNT(p.xy, dx.xy, dy.xy, layer, 0.7).rgb * w.z;
  return c;
}

// The scanned rust normals, triplanar in the part's space (whiteout blend), returned in the part's space.
vec3 normalNT(vec2 uv, vec2 dx, vec2 dy, float layer, float salt) {
  float l = textureLod(noiseTex, vec3(uv * 0.07, salt), 0.0).x * 8.0;
  float i = floor(l), f = fract(l);
  vec3 a = textureGrad(scanNormal, vec3(uv + sin(vec2(3.0, 7.0) * i) * 7.3, layer), dx, dy).xyz;
  if (f < 0.2) return a * 2.0 - 1.0;
  vec3 b = textureGrad(scanNormal, vec3(uv + sin(vec2(3.0, 7.0) * (i + 1.0)) * 7.3, layer), dx, dy).xyz;
  return mix(a, b, smoothstep(0.2, 0.8, f)) * 2.0 - 1.0;
}
vec3 scanNormalTri(vec3 p, vec3 n, vec3 w, float layer, float strength) {
  vec3 dx = dFdx(p), dy = dFdy(p);
  vec3 acc = vec3(0.0);
  if (w.x > 0.0) {
    vec3 t = normalNT(p.zy, dx.zy, dy.zy, layer, 0.1);
    t.xy *= strength;
    acc += vec3(t.xy + n.zy, abs(t.z) * n.x).zyx * w.x;
  }
  if (w.y > 0.0) {
    vec3 t = normalNT(p.xz, dx.xz, dy.xz, layer, 0.4);
    t.xy *= strength;
    acc += vec3(t.xy + n.xz, abs(t.z) * n.y).xzy * w.y;
  }
  if (w.z > 0.0) {
    vec3 t = normalNT(p.xy, dx.xy, dy.xy, layer, 0.7);
    t.xy *= strength;
    acc += vec3(t.xy + n.xy, abs(t.z) * n.z) * w.z;
  }
  return normalize(acc);
}

// Bump from a height field (Mikkelsen's surface gradient), in world space.
float mmGear() { return gearZones.z > gearZones.y ? gearZones.z - gearZones.y : 0.012; }
vec3 bump(vec3 N, vec3 P, float h, float scale) {
  vec3 dpx = dFdx(P), dpy = dFdy(P);
  float dhx = dFdx(h) * scale, dhy = dFdy(h) * scale;
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  if (abs(det) < 1e-12) return N;
  vec3 g = (dhx * r1 + dhy * r2) / det;
  return normalize(N - g);
}
`;

const surface = /* glsl */ `
void surface(inout Surface s) {
  // Dissolve: a stable per-pixel threshold against how visible the part is (every pass, so shadows and depth follow).
  if (visible < 1.0) {
    vec2 fc = floor(gl_FragCoord.xy);
    float th = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
    if (th >= visible) {
      s.alpha = 0.0;
      return;
    }
  }
#if defined(PIPELINE_SHADOW) || defined(PIPELINE_PREPASS)
  return;
#else
  // Fragments the prepass found hidden behind another part skip all of this (overlapping gears overdraw a lot).
  float zPre = texelFetch(depthTexture, ivec2(gl_FragCoord.xy), 0).r;
  if (giLinearDepth(gl_FragCoord.z) > giLinearDepth(zPre) * 1.003 + 0.002) {
    // (MSAA samples at an overlap's edge can land here: they get the base rust colour, not black.)
    s.albedo = rustMature;
    s.roughness = rustRough;
    s.metalness = 0.0;
    return;
  }
#endif
  vec3 p = vObjectPosition;
  vec3 nl = normalize(vObjectNormal);
  vec3 qs = p + seed * 3.7;
  float px = pixelAngle * length(vWorldPosition - cameraPosition);

  // Where on a gear: tooth roots, running flanks, tips, the bore.
  float r = length(p.xy);
  float isGear = step(0.0001, gearZones.y);
  float m = (gearZones.z - gearZones.y);
  vec2 radial = r > 1e-5 ? p.xy / r : vec2(1.0, 0.0);
  float side = 1.0 - abs(nl.z);
  float flankness = side * (1.0 - abs(dot(normalize(nl.xy + 1e-5), radial)));
  float root = isGear * (1.0 - smoothstep(gearZones.x, gearZones.x + 0.6 * m, r)) * step(gearZones.x - 0.3 * m, r) * mix(0.2, 1.0, side);
  float flank = isGear * smoothstep(0.35, 0.7, flankness) * smoothstep(gearZones.x + 0.2 * m, gearZones.y - 0.2 * m, r) * (1.0 - smoothstep(gearZones.z - 0.4 * m, gearZones.z, r));
  float bore = isGear * (1.0 - smoothstep(gearZones.w, gearZones.w + 0.6 * m, r)) * smoothstep(0.6, 0.9, side);
  float up = dot(nl, localUp);

  // Grown fields at a few scales.
  // Anti-tiling only where a repeat could show: patterns fine enough or broad enough not to read as tiles skip it.
  vec4 c1 = noTile(corrosionTex, qs * 2.3);
  vec4 c2 = noTile(corrosionTex, ROT * qs * 6.1 + 0.37);
  vec4 c3 = noTile(corrosionTex, ROT * ROT * qs * 15.0 + 0.71);
  vec4 n1 = noTile(noiseTex, qs * 21.0 + 0.31);
  vec4 n2 = texture(noiseTex, ROT * qs * 53.0 + 0.77);

  // How long rust has been at each point: sooner in roots and crevices, on what faces up, later where it runs.
  float arrive = min(c1.r * 0.8 + c2.r * 0.2, c1.g * 1.05 + 0.05) + (c3.r - 0.5) * 0.08;
  arrive -= 0.18 * root + 0.1 * max(up, 0.0) - 0.15 * flank * meshing * inUse;
  // Old rust covers everything: past ~0.7 the last bare islands close over.
  float rusting = age * 1.2 - 0.08 - arrive + smoothstep(0.65, 0.95, age) * 0.6;
  float covered = smoothstep(-0.01, 0.01, rusting);
  float t = clamp(rusting / 0.5, 0.0, 1.0);

  // Bare metal: oxidised steel or brass.
  // Steel: dark and oxidised, blue-grey to brown-grey, with lathe rings turned into the faces.
  float lathe = 0.5 + (0.5 * sin(r * 2200.0 + n1.x * 3.0)) * smoothstep(1.5, 3.0, 0.0029 / px);
  // Mill scale / oxide: a dark grey satin layer, half metallic, not a black mirror.
  vec3 steel = mix(vec3(0.17, 0.17, 0.18), vec3(0.27, 0.25, 0.23), c2.g * 0.7 + n1.x * 0.3);
  steel *= 0.97 + 0.04 * lathe * smoothstep(0.7, 0.95, abs(nl.z)) * (0.5 + n2.z);
  vec3 brassC = mix(vec3(0.55, 0.38, 0.16), vec3(0.42, 0.28, 0.12), c2.g);
  vec3 base = mix(steel, brassC, brass);
  float rough = mix(0.42, 0.58, c3.g) + 0.03 * (lathe - 0.5) * smoothstep(0.7, 0.95, abs(nl.z));
  float metal = mix(0.85, 1.0, brass);

  // Rust: bright young margins, the scanned mature crust, dark pitted crust where it's oldest and dampest.
  vec3 w = triW(nl);
  vec4 mid4 = texture(noiseTex, qs * 0.9 + 0.27);
  vec3 mature = scanTri(qs / 0.4, w, 0.0);
  // The scan's fine streaks read as wood grain on flat faces: its colour, little of its contrast.
  // The scans give the pattern (their brightness); the palette gives the colour, with large patches leaning to its
  // second hue (redder, blacker, more purple or ochre, by palette).
  const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
  vec3 matureC = mix(rustMature, rustAlt, smoothstep(0.35, 0.75, c1.g * 0.7 + mid4.y * 0.3));
  // Mixed rust: patches of ochre, red-orange, weathered grey-teal and dark brown over the base, as on old plate.
  if (rustMix > 0.0) {
    vec4 big = texture(noiseTex, qs * 0.45 + 0.61);
    float fOchre = smoothstep(0.45, 0.65, mid4.x * 0.6 + c1.b * 0.4);
    float fRed = smoothstep(0.45, 0.68, big.y * 0.7 + c2.r * 0.3);
    float fTeal = smoothstep(0.48, 0.66, big.z * 0.6 + mid4.z * 0.4);
    float fDark = smoothstep(0.55, 0.75, big.w * 0.6 + c1.g * 0.4);
    matureC = mix(matureC, vec3(0.42, 0.06, 0.012), fRed * rustMix);
    matureC = mix(matureC, vec3(0.5, 0.26, 0.04), fOchre * rustMix);
    matureC = mix(matureC, vec3(0.2, 0.19, 0.15) * (0.8 + 0.4 * mid4.w), fTeal * rustMix * 0.6);
    matureC = mix(matureC, vec3(0.045, 0.02, 0.01), fDark * rustMix * 0.7);
  }
  mature = matureC * mix(1.0, dot(mature, LUM) / 0.075, 0.35) * (0.8 + 0.4 * c2.g) * (0.85 + 0.3 * c1.g);
#ifdef RUST_LITE
  vec3 old = rustOld * (0.7 + 0.6 * c2.g);
#else
  vec3 old = scanTri(ROT * qs / 0.35, w, 1.0);
  old = rustOld * clamp(dot(old, LUM) / 0.026, 0.4, 2.0);
#endif
  vec3 young = rustYoung * (0.75 + 0.35 * c3.b);
  vec3 rust = mix(young, mature, smoothstep(0.0, 0.35, t));
  rust = mix(rust, old, smoothstep(0.5, 1.0, t) * (0.4 + 0.6 * root) * (0.5 + 0.5 * c1.g));
  // Grains: lighter and darker specks, faded to their average under two pixels.
  float fade = smoothstep(1.2, 2.5, 0.0012 / px);
  float orange = smoothstep(0.64, 0.69, n2.y) * fade, grit = smoothstep(0.62, 0.68, n2.w) * fade;
  vec4 n3 = noTile(noiseTex, ROT * qs * 9.0 + 0.13);
  float orange2 = smoothstep(0.66, 0.71, n3.x) * smoothstep(1.2, 2.5, 0.003 / px);
  rust = mix(rust, rustYoung * 1.1, max(orange, orange2) * 0.7 * smoothstep(0.0, 0.3, t));
  rust = mix(rust, vec3(0.04, 0.025, 0.02), grit * 0.65 * smoothstep(0.0, 0.3, t));
  // Below two pixels the grains leave their average behind.
  rust *= 1.0 - 0.08 * (1.0 - fade);
  // Brass doesn't rust in patches. Its whole surface tarnishes as a thin film (still metal, darker and browner, the
  // lathe rings still showing), and only crevices, roots and scattered pits crust over with verdigris.
  float tarnish = 0.0;
  if (brass > 0.5) {
    tarnish = smoothstep(0.0, 0.9, age) * (0.75 + 0.25 * c3.g);
    float vg = smoothstep(0.35, 0.95, age) * clamp(max(root * side, smoothstep(0.05, 0.4, vCavity)) * (0.6 + 0.4 * n1.w)
      + (1.0 - smoothstep(0.07, 0.14, c2.b)) * smoothstep(0.5, 1.0, age), 0.0, 1.0);
    vec3 verdigris = mix(vec3(0.12, 0.26, 0.21), vec3(0.24, 0.36, 0.28), n2.x) * (0.85 + 0.3 * n3.y);
    rust = verdigris;
    covered = vg;
    t = vg;
    base = mix(brassC, brassC * vec3(0.42, 0.3, 0.2), tarnish);
  }

  // Ahead of each patch the steel is already stained brown.
  float stain = smoothstep(-0.12, 0.0, rusting) * (1.0 - covered) * (1.0 - brass);
  base = mix(base, base * vec3(1.25, 0.85, 0.6) + vec3(0.03, 0.01, 0.0), stain * 0.8);
  vec3 col = mix(base, rust, covered);
  rough = mix(rough, rustRough + 0.08 * (n1.z - 0.5), covered);
  // Black magnetite packs the pits, roots and crevices, semi-glossy; fresh ochre gathers along the runs.
  float blackOx = covered * smoothstep(0.3, 0.9, age) * clamp(max(root * side, smoothstep(0.05, 0.4, vCavity)) * (0.5 + 0.5 * n1.w), 0.0, 1.0);
  col = mix(col, vec3(0.014, 0.012, 0.011) * (0.8 + 0.5 * n2.x), blackOx * 0.75 * (1.0 - brass));
  rough = mix(rough, 0.5, blackOx * 0.6);
  metal = mix(metal, 0.0, covered);
  rough = mix(rough, 0.3 + 0.3 * tarnish, brass * (1.0 - covered));

  // The crust has body: it thickens with age, stands up in granules of a few sizes and blisters, and ends in a raised
  // lip where it meets bare steel. Height in units of ~1 mm.
  vec4 g1 = noTile(noiseTex, qs * 7.0 + 0.17);
  vec4 g2 = texture(noiseTex, ROT * qs * 17.0 + 0.53);
  // Fine granular crust: most of the relief at a millimetre or less, only a little at the lump scale.
  float granules = (g1.x - 0.5) * 0.5 + (g2.y - 0.5) * 1.0 * smoothstep(1.2, 2.5, 0.002 / px) + (n1.z - 0.5) * 1.1 * fade + (n2.x - 0.5) * 0.9 * smoothstep(1.2, 2.5, 0.0009 / px);
  float blisters = smoothstep(0.55, 0.75, c1.g * 0.7 + g1.w * 0.5) * smoothstep(0.3, 0.9, t);
  float lip = smoothstep(-0.01, 0.02, rusting) * (1.0 - smoothstep(0.02, 0.08, rusting)) * (1.0 - brass);
  float crust = covered * (0.35 + 0.65 * t + granules * (0.4 + 0.6 * t) + blisters * 0.8) + lip * 0.5;
  // Its lows are darker and its highs catch the light.
  float relief = covered * (granules * (0.4 + 0.6 * t) + blisters * 0.8);
  col *= 1.0 + covered * clamp(relief, -1.0, 1.0) * 0.28;
  float h = crust;

  // Pits: dark holes with a rim, as bump and colour; deeper and denser with age.
  float pitR = min(c2.b, c1.b * 1.6);
  float pit = covered * smoothstep(0.15, 0.7, age) * (1.0 - smoothstep(0.1, 0.19, pitR));
  float rim = covered * smoothstep(0.15, 0.7, age) * smoothstep(0.15, 0.21, pitR) * (1.0 - smoothstep(0.24, 0.32, pitR));
  col = mix(col, vec3(0.03, 0.015, 0.01), pit * 0.85);
  col = mix(col, col * 1.25, rim * 0.5);
  h += -pit * 1.6 + rim * 0.4;

  // Edges. Every edge carries a 45 degree chamfer, whose normal in the part's frame is half cap, half wall: that finds
  // them exactly. The edge zone then reaches about a module onto the walls (by height along the axle) and the tips.
  float mm = m > 0.0 ? m : 0.012;
  // A 45 degree bevel has |nz| ~ 0.71; faces whose smoothed normals only dip a little stay out.
  float bevel = smoothstep(0.4, 0.55, abs(nl.z)) * (1.0 - smoothstep(0.8, 0.88, abs(nl.z)));
  float wallEdge = halfWidth > 0.0 ? side * smoothstep(halfWidth - (1.0 + 1.5 * edgePits) * mm, halfWidth - 0.15 * mm, abs(p.z)) : 0.0;
  float tipEdge2 = isGear * (1.0 - side) * smoothstep(gearZones.z - (0.6 + 0.8 * edgePits) * m, gearZones.z - 0.15 * m, r);
  float edgeZone = max(bevel, max(wallEdge * 0.85, tipEdge2 * 0.7));
  // Corrosion bites hardest at edges: denser, bigger, deeper pits there, each with a rust halo.
  vec4 e1 = noTile(corrosionTex, ROT * qs * 11.0 + 0.91);
  float edgeAge = mix(smoothstep(0.1, 0.6, age), 1.0, 0.5 * edgePits) * edgeZone * step(0.001, edgePits);
  // Two spot fields at different sizes, so pits come in clusters of big and small.
  vec4 e2 = texture(corrosionTex, qs * 27.0 + 0.43);
  float pf = min(e1.b, e2.b * 1.15);
  float ePit = edgeAge * (1.0 - smoothstep(0.16 + 0.32 * edgePits, 0.24 + 0.36 * edgePits, pf));
  float eHalo = edgeAge * (1.0 - smoothstep(0.26 + 0.38 * edgePits, 0.4 + 0.45 * edgePits, pf)) * (1.0 - ePit);
  col = mix(col, mix(vec3(0.3, 0.11, 0.03), rust, 0.5), eHalo * 0.6 * (1.0 - brass));
  col = mix(col, vec3(0.025, 0.012, 0.008), ePit * 0.9);
  rough = mix(rough, 0.9, max(ePit, eHalo * 0.6));
  metal = mix(metal, 0.0, max(ePit, eHalo * 0.6));
  h += -ePit * (1.5 + 2.0 * edgePits) + eHalo * 0.35;

  // Flaking: old crust crazes into plates along cracks; plates sit at their own heights, their edges curl up and catch
  // the light, and some have fallen away to show the dark scale or fresher rust beneath. Fine crazing between.
#ifndef RUST_LITE
  vec3 fq = ROT * qs * 11.0 + 0.37;
  vec3 fo = sin(vec3(3.0, 7.0, 11.0) * floor(texture(noiseTex, fq * 0.07 + 0.5).x * 8.0)) * 7.3;
  float crackD = texture(corrosionTex, fq + fo).a;
  float cellV = texture(cellTex, fq + fo).r;
  float craze = texture(corrosionTex, qs * 29.0 + fo + 0.5).a;
  float flk = flaking * covered * smoothstep(0.15, 0.6, age) * (1.0 - brass);
  float crack = flk * (1.0 - smoothstep(0.025, 0.06, crackD)) * smoothstep(0.3, 0.6, mid4.x + 0.3 * flaking);
  float crazeL = flk * (1.0 - smoothstep(0.03, 0.07, craze)) * 0.6 * smoothstep(1.2, 2.5, 0.0015 / px);
  // Plates come away in a few areas, not everywhere.
  float area = smoothstep(0.55, 0.7, mid4.y * 0.7 + c1.g * 0.3 + 0.15 * flaking);
  float gone = flk * area * step(0.6, cellV) * smoothstep(0.06, 0.12, crackD);
  float curl = flk * (1.0 - smoothstep(0.08, 0.3, crackD)) * (1.0 - gone);
  vec3 under = mix(old * 0.7, young * 0.75, step(0.5, fract(cellV * 13.7)));
  col *= mix(1.0, 0.92 + 0.16 * fract(cellV * 7.31), flk);
  col = mix(col, under, gone);
  col = mix(col, col * 1.25, curl * 0.5);
  col = mix(col, vec3(0.02, 0.012, 0.008), max(crack, crazeL) * 0.85);
  rough = mix(rough, 0.95, gone * 0.5);
  h += flk * cellV * 0.5 + curl * 0.8 * smoothstep(0.3, 0.6, mid4.x + 0.3 * flaking) - crack * 1.6 - crazeL * 0.7 - gone * 1.4;
#endif

  // Edges rub back to lighter rust and steel.
  // Edges are the chamfer band (derivatives of the normal would also flag every edge of a triangle fan).
  float curv = bevel * 2.0;
  float rub = smoothstep(0.6, 2.0, curv) * smoothstep(0.4, 0.7, c3.g + 0.3 * (n1.w - 0.5)) * (0.3 + 0.7 * inUse);
  col = mix(col, mix(vec3(0.34, 0.33, 0.32), rustYoung * 1.15, covered), rub * 0.5);
  // Exposed edges and tips catch the freshest, lightest rust; the recesses go dark brown, like an AO map.
  float exposed = max(bevel, isGear * smoothstep(gearZones.y, gearZones.z, r) * side);
  col = mix(col, col * 1.35 + rustYoung * 0.08, exposed * covered * 0.6);
  // Raised and sunk read differently, as on old cast gears: the proud faces (rim, hub, tooth tops) go bright orange in
  // broad patches; the sunk web keeps dark blue-black scale under a scatter of orange flecks.
  if (gearBody.z > 0.0) {
    float face2 = (1.0 - side);
    float sunkWeb = face2 * step(abs(p.z), gearBody.z + 0.2 * mmGear()) * smoothstep(gearBody.y, gearBody.y + 0.6 * m, r) * (1.0 - smoothstep(gearBody.x - 0.6 * m, gearBody.x, r));
    float proud = face2 * (1.0 - sunkWeb) * step(gearBody.z + 0.2 * mmGear(), abs(p.z));
    vec3 scale = mix(vec3(0.035, 0.037, 0.042), rustOld, 0.35) * (0.75 + 0.5 * c2.g);
    float flecks = smoothstep(0.66, 0.72, g1.x * 0.6 + c3.b * 0.4) * fade + 0.4 * smoothstep(0.66, 0.8, mid4.x);
    vec3 webC = mix(scale, rustYoung * (0.9 + 0.3 * n2.x), clamp(flecks, 0.0, 1.0));
    col = mix(col, webC, sunkWeb * covered * smoothstep(0.35, 0.8, age) * (1.0 - brass) * 0.85);
    float bright = smoothstep(0.35, 0.65, mid4.y * 0.6 + c1.g * 0.4);
    col = mix(col, rustYoung * vec3(1.2, 0.85, 0.45) * (0.85 + 0.3 * g1.y), proud * bright * covered * 0.6 * (1.0 - brass));
  }

  // Running surfaces: tooth flanks that mesh, and the bore, polished back to steel with fine scratches.
  // The contact pattern: a band either side of the pitch circle on the flanks that drive, burnished by sliding.
  // Running machines show it bright; abandoned ones keep it as a smoother, lighter band under thinner rust.
  float band = 1.0 - smoothstep(0.3 * m, 0.7 * m, abs(r - gearZones.y + 0.1 * m));
  float contact = flank * meshing * band;
  // Sliding marks run across the tooth's width: lines of constant height along the axle.
  float lineFade = smoothstep(1.2, 2.5, 0.0004 / px);
  vec4 scr = texture(noiseTex, vec3(p.z * 260.0, r * 6.0, seed));
  float lines = mix(0.5, scr.x, lineFade);
  float patchy = smoothstep(0.25, 0.5, n1.x * 0.6 + c3.g * 0.4 + 0.15);
  float polish = max(contact * patchy, bore * 0.6 * patchy) * mix(0.5, 1.0, inUse);
  // Long idle, even the running surfaces have rusted over.
  polish *= 1.0 - smoothstep(0.55, 0.95, age) * (1.0 - 0.5 * inUse);
  // On rusted gears the running band is burnished dark rust-steel, not bright metal.
  float rustOver = covered * mix(0.6, 0.35, inUse) * smoothstep(0.3, 0.8, age) + (1.0 - inUse) * covered * 0.3;
  vec3 bright = mix(vec3(0.58, 0.57, 0.55), vec3(0.66, 0.5, 0.26), brass) * (0.85 + 0.3 * lines);
  col = mix(col, mix(bright, col * 1.15, rustOver), polish);
  rough = mix(rough, mix(0.22 + 0.2 * lines, rough * 0.85, rustOver), polish);
  metal = mix(metal, mix(1.0, metal, rustOver), polish);
  // Worn into the flank: the band slightly scooped with a small step at its lower edge, and spalled pits along the
  // pitch line on old gears.
  float step2 = smoothstep(0.62 * m, 0.7 * m, gearZones.y - 0.1 * m - r) * (1.0 - smoothstep(0.7 * m, 0.85 * m, gearZones.y - 0.1 * m - r));
  float spall = contact * smoothstep(0.4, 0.9, age) * (1.0 - smoothstep(0.05, 0.12, c3.b)) * (1.0 - smoothstep(0.25 * m, 0.4 * m, abs(r - gearZones.y)));
  col = mix(col, vec3(0.05, 0.03, 0.02), spall * 0.8);
  h = mix(h, -0.5 - 0.3 * (lines - 0.5), polish) + flank * meshing * step2 * 0.6 - spall * 1.2;
  // Tooth tips: their edges rub bright too.
  float tipEdge = isGear * smoothstep(gearZones.z - 0.35 * m, gearZones.z - 0.1 * m, r) * smoothstep(0.6, 2.0, curv) * mix(0.3, 1.0, inUse);
  col = mix(col, bright * 0.9, tipEdge * 0.6 * (1.0 - rustOver));
  metal = mix(metal, 1.0, tipEdge * 0.6);

  // Crevices, like an AO map of the gear: the bottoms of the tooth gaps, the corners where the sunk web meets the rim
  // and the hub (on the web's face and up the walls), and the bore. Grime and grease gather there.
  float mmC = m > 0.0 ? m : 0.012;
  // More grime reaches further out of each crevice.
  // Like AO: dark right in the corner, gone a few millimetres out; more grime reaches a little further.
  float reachG = mix(0.7, 1.3, grime);
  float gapAO = isGear * side * smoothstep(gearZones.x - 0.4 * mmC, gearZones.x - 0.1 * mmC, r) * exp(-max(r - gearZones.x, 0.0) / (0.35 * reachG * mmC));
  float webCorner = 0.0;
  if (gearBody.z > 0.0) {
    float onWeb = step(abs(p.z), gearBody.z + 0.3 * mmC);
    float dRim = gearBody.x - r, dHub = r - gearBody.y;
    float faceAO = onWeb * (1.0 - side) * (exp(-max(dRim, 0.0) / (0.22 * reachG * mmC)) + exp(-max(dHub, 0.0) / (0.22 * reachG * mmC)));
    // Up the rim's inner wall and the hub's outer wall, from the web's face.
    float wallAO = (step(gearBody.x - 0.3 * mmC, r) * (1.0 - step(gearZones.x - 0.5 * mmC, r)) + step(r, gearBody.y + 0.3 * mmC) * step(gearZones.w + 0.3 * mmC, r))
      * side * exp(-max(abs(p.z) - gearBody.z, 0.0) / (0.22 * reachG * mmC));
    webCorner = clamp(faceAO + wallAO, 0.0, 1.0);
  }
  // (Per-vertex concavity only off gears: a gear's flat faces are a few big triangles, which smear it across.)
  float crevice = clamp(max(max(gapAO, webCorner), max(bore * 0.5, (1.0 - isGear) * smoothstep(0.1, 0.5, vCavity))), 0.0, 1.0);

  // Grease: packed into the roots and smeared up the flanks of the teeth that run, a ring of it round the hub with
  // glossy and lumpy; old grease goes dark and gathers grit.
  float hubRing = isGear * smoothstep(gearZones.w, gearZones.w + 0.2 * m, r) * (1.0 - smoothstep(gearZones.w + 1.2 * m, gearZones.w + 3.0 * m, r));
  float flankSmear = flank * meshing * (1.0 - smoothstep(gearZones.y - 0.2 * m, gearZones.y + 0.5 * m, r));
  float g = grease * clamp(max(crevice * 0.9, max(flankSmear * 0.35, max(bore, hubRing * 0.8))), 0.0, 1.0);
  // Broad, smooth-edged patches, not speckle.
  g *= smoothstep(0.25, 0.45, mid4.y * 0.6 + c2.g * 0.4);
  // Fresh it's amber and translucent-looking; old it's near black with grit.
  vec3 greaseC = mix(vec3(0.075, 0.035, 0.008), vec3(0.018, 0.012, 0.008), smoothstep(0.2, 0.8, age + 0.3 * (n2.x - 0.5)));
  greaseC = mix(greaseC, vec3(0.1, 0.08, 0.06), smoothstep(0.66, 0.74, g1.z) * 0.4 * age);
  col = mix(col, greaseC, g);
  rough = mix(rough, 0.22 + 0.25 * age + 0.15 * smoothstep(0.45, 0.65, g1.y), g);
  metal = mix(metal, 0.0, g);
  h = mix(h, 0.6 + (mid4.w - 0.5) * 3.0 + (g1.w - 0.5) * 0.8, g);

  // Runs down from what was up, on the sides: thin dark streaks.
  vec3 t1 = normalize(cross(localUp, nl) + 1e-4);
  vec4 run = texture(noiseTex, vec3(dot(p, t1) * 40.0, dot(p, localUp) * 1.5, seed));
  float streak = (1.0 - abs(up)) * covered * smoothstep(0.62, 0.78, run.x) * age;
  col = mix(col, col * vec3(0.55, 0.45, 0.4), streak * 0.7);

  // Grime: soot and dirt packed into what's concave (roots, the hub's step, inside corners), thicker on old machines,
  // dark and matte, wiping the polish where it lies.
  float cav = smoothstep(0.03, 0.35, vCavity);
  // Recesses darken on old rust whatever the grime setting: deep brown in the gaps and inside corners.
  col *= mix(1.0, 0.4, smoothstep(0.05, 0.9, crevice) * covered * smoothstep(0.3, 0.9, age));
  // A packed deposit, not a shade: it fills the crevice up to a ragged edge (higher with more grime), clumpy, matte,
  // a dark brown-black that reads against grey steel and against rust.
  // Uneven: in some crevices it's packed to the brim, in others there's barely any, in big irregular stretches, with a
  // broken edge and gaps where it fell out.
  float amountHere = smoothstep(0.25, 0.75, mid4.z * 0.6 + c1.b * 0.4);
  float fillLine = mix(0.75, 0.25, grime) + 0.45 * (0.5 - amountHere) + 0.25 * (c2.r - 0.5) + 0.12 * (g1.z - 0.5);
  float dirt = step(0.001, grime) * smoothstep(fillLine - 0.05, fillLine + 0.05, crevice);
  dirt *= smoothstep(0.15, 0.3, c2.g + 0.1 * grime);
  dirt *= 1.0 - 0.5 * polish * inUse;
  // Over rust it's grimy rust: the rust's colour and grain darkened and browned, not a separate paint.
  vec3 sootSteel = mix(vec3(0.05, 0.036, 0.025), vec3(0.1, 0.078, 0.055), smoothstep(0.3, 0.7, c2.b));
  vec3 sootRust = col * vec3(0.32, 0.27, 0.24);
  vec3 soot = mix(sootSteel, sootRust, covered * 0.85);
  col = mix(col, soot, dirt);
  rough = mix(rough, 0.95, dirt);
  metal = mix(metal, 0.0, dirt);
  // Clumps stand up from the deposit; its edge is a small ridge.
  float edgeR = dirt * smoothstep(fillLine - 0.06, fillLine, crevice) * (1.0 - smoothstep(fillLine, fillLine + 0.08, crevice));
  h = mix(h, 0.8 + (g1.y - 0.5) * 1.2, dirt) + edgeR * grime * 0.6;

  s.albedo = col;
  s.roughness = rough;
  s.metalness = metal;
  s.specular = mix(mix(1.0, 0.5, covered), 1.2, g);
  // Under the crust, the scanned rust's own relief (in the part's space, back to world).
#ifdef RUST_LITE
  vec3 nRust = s.normal;
#else
  vec3 nScan = scanNormalTri(qs / 0.4, nl, w, mix(0.0, 1.0, smoothstep(0.5, 1.0, t)), 1.4);
  vec3 nRust = normalize(mat3(modelMatrix) * nScan);
#endif
  vec3 nBase = normalize(mix(s.normal, nRust, covered * (1.0 - polish) * (1.0 - g) * (1.0 - instanced)));
  // Old rust rounds the chamfers over: on the bevel band the shading leans to the crease-smoothed normal.
  float soften = smoothstep(0.2, 0.9, age) * max(covered, dirt) * max(bevel, smoothstep(0.05, 0.4, vConvex)) * (1.0 - instanced);
  nBase = normalize(mix(nBase, normalize(mat3(modelMatrix) * vSmooth), soften));
  // The heaved surface in the shading too (the vertex shader's field, in the bump's units).
  float amount = smoothstep(0.15, 0.9, age) * (1.0 - 0.85 * brass);
  vec3 hq = vObjectPosition + seed * 3.7;
  float heaveF = smoothstep(0.35, 0.7, textureLod(noiseTex, hq * 9.0, 0.0).x * 0.65 + textureLod(noiseTex, hq * 23.0 + 0.4, 0.0).y * 0.35);
  h += amount * heaveF * 0.35;
  s.normal = bump(nBase, vWorldPosition, h, 0.0018);
}
`;

// Rust palettes (sRGB, measured from photos): fresh margins, mature crust, oldest scale, a second hue, roughness.
export const RUST_PALETTES = {
  mixed: { young: 0xb4561a, mature: 0x76381a, old: 0x3a1c10, alt: 0x9c481d, rough: 0.9, mix: 1 },
  orange: { young: 0xbc5c16, mature: 0x7e3c16, old: 0x2c140a, alt: 0x8a3412, rough: 0.9 },
  red: { young: 0x9c481d, mature: 0x7a3415, old: 0x4c200f, alt: 0x672e20, rough: 0.9 },
  ochre: { young: 0xc18d35, mature: 0x986436, old: 0x5a3418, alt: 0xac7839, rough: 0.93 },
  black: { young: 0x8d4822, mature: 0x3a302c, old: 0x13120c, alt: 0x51434b, rough: 0.6 },
  purple: { young: 0x8b5544, mature: 0x664c4b, old: 0x451d1a, alt: 0x782d23, rough: 0.78 },
  green: { young: 0x8e532f, mature: 0x6b6655, old: 0x464035, alt: 0x4f6b5e, rough: 0.9 },
};

export function setRustPalette(material, palette, shift = 0) {
  const u = material.uniforms;
  u.rustYoung.value.set(palette.young);
  u.rustMature.value.set(palette.mature).multiplyScalar(1 + shift);
  u.rustOld.value.set(palette.old);
  u.rustAlt.value.set(palette.alt).multiplyScalar(1 + shift);
  u.rustRough.value = palette.rough;
  u.rustMix.value = palette.mix ?? 0;
}

// A part's material; `info` says what it is and how it has lived.
// lite: for the lower quality tiers, without the scanned normals and old crust, and without flaking.
export function createRustMaterial(textures, info, { lite = false } = {}) {
  return new PipelineMaterial({
    defines: lite ? { RUST_LITE: "" } : {},
    vertexPars,
    vertex,
    varyings: { vSmooth: "vec3", vCavity: "float", vConvex: "float" },
    fragmentPars,
    surface,
    uniforms: {
      ...Object.fromEntries(Object.entries(textures).map(([k, v]) => [k, { value: v }])),
      age: { value: info.age ?? 0.5 },
      inUse: { value: info.inUse ?? 0.5 },
      grease: { value: info.grease ?? 0.5 },
      brass: { value: info.brass ? 1 : 0 },
      meshing: { value: info.meshing ? 1 : 0 },
      seed: { value: info.seed ?? 0 },
      gearZones: { value: new Vector4(...(info.zones ?? [0, 0, 0, 0])) },
      halfWidth: { value: info.halfWidth ?? 0 },
      gearBody: { value: new Vector4(...(info.body ?? [0, 0, 0, 0])) },
      edgePits: { value: 0.6 },
      grime: { value: 0.5 },
      visible: { value: 1 },
      rustYoung: { value: new Color(0x9c5a2a) },
      rustMature: { value: new Color(0x7a442c) },
      rustOld: { value: new Color(0x3a1c10) },
      rustAlt: { value: new Color(0x7a3415) },
      rustRough: { value: 0.88 },
      rustMix: { value: 0 },
      flaking: { value: 0.5 },
      localUp: { value: new Vector3(...(info.up ?? [0, 1, 0])) },
      pixelAngle: { value: 0.001 },
      instanced: { value: info.instanced ? 1 : 0 },
    },
  });
}
