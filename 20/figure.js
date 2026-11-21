import { SkinnedMesh, Mesh, DoubleSide, BufferGeometry, BufferAttribute, DataTexture, RGBAFormat, FloatType, Color, Vector2, Vector3, Matrix4, AnimationMixer, AnimationUtils, AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { nativeRandom } from "modules/random.js";

// An animated, skinned figure being wound into a cocoon as it moves.
//
// The silk is the figure's own skin, drawn a second time a little way off it: the same vertices, skinned by the same
// bones, pushed out along their normals by the silk's thickness. So it fits the body in every pose for free. It is
// cut away where there is no silk yet: the silk goes on as two sets of bands winding round the body, feet first,
// that widen until they close (uCover, 0 to 1). The pattern lives in the rest pose, so it stays put on the body.
//
// The fuzz is geometry: hair-fine tubes rooted on the skin, each carrying the bone weights of the vertex it grows
// from, so it rides the body too.
//
// Its longer hairs trail behind the body and swing back: every bone has a point that follows it on a spring, and how
// far that point is from the bone (uLag, a texel per bone) is how far a hair's free end is carried.
//
// Ribbons (one mesh, placed in the world each frame) are the silk that is not on the body. Webs: where two parts of
// the wound body come close, a sheet of filaments joins them, stretches and necks as they part, and tears. Wisps:
// a fast-moving part throws off a curl of silk now and then, which drifts down and fades.
//
// Hatching, the shell breaks up into flakes: the silk goes, a patch at a time, and where each patch was a loose chip
// of it is let go (one mesh of small ragged quads, moved here each frame). Nothing is simulated: each chip winds
// outward round the figure on its own spiral, sinking and bobbing and turning over as it goes, so together they are
// a swirl of flakes falling all around; each shrinks away in the air. They are solid, and throw shadows.
//
// PipelineMaterial knows nothing of skinning; its vertex hook does it here, with three's own bone texture and
// uniforms (three sets those for any material drawn on a SkinnedMesh).

// What it can do: a clip, and for some a pose laid over that clip (the model's own additive poses).
const MOTIONS = {
  walk: { base: "walk", gait: true },
  run: { base: "run", gait: true },
  samba: { base: "samba" },
  salsa: { base: "salsa" },
  swing: { base: "swing" },
  house: { base: "house" },
  "hip hop": { base: "hiphop" },
  wave: { base: "wave" },
  belly: { base: "belly" },
  capoeira: { base: "capoeira" },
  sneak: { base: "walk", pose: "sneak_pose", gait: true },
};
export const CLIPS = Object.keys(MOTIONS);
export const DANCES = CLIPS.filter((name) => !MOTIONS[name].gait);
// The clips that are not in the model's own file: each is assets/name.json + name.bin (see loadClip).
export const EXTRA_CLIPS = ["samba", "salsa", "swing", "house", "hiphop", "wave", "belly", "capoeira"];

const SIDES = 3;
// The body as capsules between bones, for what bumps into it (the chips, the lamp): from, to, radius in metres.
const CAPSULES = [
  ["Hips", "Spine1", 0.13], ["Spine1", "Neck", 0.13], ["Neck", "Head", 0.06], ["Head", "HeadTop_End", 0.1],
  ...["Left", "Right"].flatMap((side) => [
    [`${side}Arm`, `${side}ForeArm`, 0.055], [`${side}ForeArm`, `${side}Hand`, 0.045], [`${side}Hand`, `${side}HandMiddle2`, 0.045],
    [`${side}UpLeg`, `${side}Leg`, 0.075], [`${side}Leg`, `${side}Foot`, 0.055], [`${side}Foot`, `${side}ToeBase`, 0.05],
  ]),
];
export const HATCH_SECONDS = 9; // how long the cocoon takes to break open, start to finish
export const STRAIN_SHARE = 0.22; // the first part of that: the figure pushing at the shell from inside, nothing torn yet
const BRIDGES = 40; // webs between parts of the body, at most
const WISPS = 60; // shed curls in the air, at most
const FLAKES = 900; // chips of the shell, hatching
const STRAND_POINTS = 9;
const BRIDGE_SAMPLES = 300; // places on the skin a bridge can hold on to

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _u = new Vector3();
const _d = new Vector3();
const _e = new Vector3();

// Skin space (the rest pose) to the world: three's bone matrices are in the world, bindMatrix takes the mesh's
// vertices to skin space, and bindMatrixInverse brings the result back to the mesh's own space for modelMatrix.
// In the prepass's second run (pipelinePrevPose), last frame's bones, for velocity.
const skinPars = /* glsl */ `
#include <skinning_pars_vertex>
uniform highp sampler2D uPrevBones;
mat4 prevBoneMatrix(float i) {
  int size = textureSize(uPrevBones, 0).x;
  int j = int(i) * 4;
  ivec2 at = ivec2(j % size, j / size);
  return mat4(texelFetch(uPrevBones, at, 0), texelFetch(uPrevBones, at + ivec2(1, 0), 0), texelFetch(uPrevBones, at + ivec2(2, 0), 0), texelFetch(uPrevBones, at + ivec2(3, 0), 0));
}
mat4 boneBlend() {
  if (pipelinePrevPose) return skinWeight.x * prevBoneMatrix(skinIndex.x) + skinWeight.y * prevBoneMatrix(skinIndex.y)
    + skinWeight.z * prevBoneMatrix(skinIndex.z) + skinWeight.w * prevBoneMatrix(skinIndex.w);
  return skinWeight.x * getBoneMatrix(skinIndex.x) + skinWeight.y * getBoneMatrix(skinIndex.y)
    + skinWeight.z * getBoneMatrix(skinIndex.z) + skinWeight.w * getBoneMatrix(skinIndex.w);
}
`;

const bodyVertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  mat4 B = boneBlend();
  n = normalize(mat3(bindMatrixInverse) * (mat3(B) * (mat3(bindMatrix) * n)));
  return (bindMatrixInverse * (B * (bindMatrix * vec4(p, 1.0)))).xyz;
}
`;

// The silk: skinned, then pushed out in the world along the smoothed normal.
const silkVertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  mat4 B = boneBlend();
  mat3 R = mat3(B) * mat3(bindMatrix);
  vec4 rest = bindMatrix * vec4(p, 1.0);
  vec4 world = B * rest;
  vec3 out_ = normalize(R * aSmooth);
  // A band comes down to the body at its edges, so it is a closed strip of silk lying on it, not a sheet held off
  // it that can be seen under.
  float turn1;
  float lift = mix(0.08, 1.0, smoothstep(0.0, 0.35, bandInside(rest.xyz, turn1)));
  // Hatching, a patch comes down to the body just before it breaks, so the shell round each hole slopes down to the
  // skin like a band's edge instead of standing off it, hollow.
  if (uHatch > 0.0) lift = min(lift, mix(0.08, 1.0, 1.0 - smoothstep(-0.4, 0.0, (uHatch - aWhen) * HATCH_SECONDS)));
  // (Before anything breaks, the figure pushes: the shell swells in patches, with uStrain.)
  world.xyz += out_ * lift * (uThick + 0.05 * uStrain * smoothstep(0.35, 0.75, noise3(rest.xyz * 5.0 + 3.0)));
  vWhen = aWhen;
  vRest = rest.xyz;
  vAxisX = normalize(R[0]);
  vAxisY = normalize(R[1]);
  vAxisZ = normalize(R[2]);
  n = normalize(mat3(bindMatrixInverse) * (R * n));
  return (bindMatrixInverse * world).xyz;
}
`;

// A fibre: skinned with its root's weights, and lifted with the silk it grows from.
const flossVertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  mat4 B = boneBlend();
  mat3 R = mat3(B) * mat3(bindMatrix);
  vec4 world = B * (bindMatrix * vec4(p, 1.0));
  world.xyz += normalize(R * aRoot) * uThick;
  vec4 lag = skinWeight.x * texelFetch(uLag, ivec2(int(skinIndex.x), 0), 0) + skinWeight.y * texelFetch(uLag, ivec2(int(skinIndex.y), 0), 0)
    + skinWeight.z * texelFetch(uLag, ivec2(int(skinIndex.z), 0), 0) + skinWeight.w * texelFetch(uLag, ivec2(int(skinIndex.w), 0), 0);
  world.xyz += lag.xyz * aFibre.z;
  vTangent = R * aTangent;
  vFibre = aFibre.xy;
  // Hatching: a hair goes as the strip it stands on lets go.
  if (uHatch > 0.0) vFibre.x *= 1.0 - smoothstep(-0.3, 0.2, (uHatch - aWhen) * HATCH_SECONDS);
  n = normalize(mat3(bindMatrixInverse) * (R * n));
  return (bindMatrixInverse * world).xyz;
}
`;

// A ribbon: already in the world.
const strandVertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  vTangent = aTangent;
  vFibre = aFibre.xy;
  return p;
}
`;

// A chip of the shell: already in the world.
const flakeVertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  vLook = aLook;
  return p;
}
`;

const lampPars = /* glsl */ `
uniform vec3 uLamp; // the lamp, in the world
uniform vec3 uLampColor;
uniform float uCover;
uniform float uHeight;
uniform float uHatch; // 0, or how far the cocoon has broken open, to 1
// How far the silk has got at a height: feet first, the head last.
float coverAt(float y) {
  return clamp(uCover * 1.6 - 0.6 * clamp(y / uHeight, 0.0, 1.0), 0.0, 1.0);
}
`;

// Where the silk is: how far inside a band a rest-pose point is (none there at 0 or less), and the first set of
// bands' turn count there. After lampPars and noisePars.
const bandPars = /* glsl */ `
float bandInside(vec3 p, out float turn1) {
  float angle = atan(p.z, p.x) / 6.2831853;
  float out_ = length(p.xz);
  float wander = noise3(p * 3.0);
  turn1 = p.y * 9.0 + angle + out_ * 4.0 + wander * 0.6;
  float turn2 = p.y * 6.0 - 2.0 * angle - out_ * 3.0 + wander * 0.9 + 0.37;
  float width = coverAt(p.y) * 1.3 * (0.8 + 0.4 * noise3(p * 7.0 + 3.0));
  return max(width - abs(fract(turn1) - 0.5) * 2.0, 0.8 * width - abs(fract(turn2) - 0.5) * 2.0);
}
`;

const noisePars = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// The nearest of a scatter of points, one per unit cell: the way to it (xyz) and its distance squared (w).
vec4 cells(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec4 best = vec4(0.0, 0.0, 0.0, 8.0);
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int xx = -1; xx <= 1; xx++) {
        vec3 g = vec3(float(xx), float(y), float(z));
        vec3 r = g + hash33(i + g) - f;
        float d = dot(r, r);
        if (d < best.w) best = vec4(r, d);
      }
  return best;
}
`;

// Hatching. The shell is in patches: the nearest of a scatter of points (in the rest pose) is a patch's middle, and
// every vertex of the silk, every hair and every chip carries the moment its patch goes (patchWhen, worked out once;
// nothing is searched for in the shaders). First nothing breaks (STRAIN_SHARE of it: the figure pushing). Then the
// cocoon splits down the front: a patch goes sooner the nearer the front it is, the nearer chest height, and the
// nearer the trunk, so the split opens at the breastbone, runs up over the head and down, and works round to the
// back and out along the limbs. uHatch runs 0 to 1 over HATCH_SECONDS.
const PATCHES = 9; // to the metre
const hatchPars = /* glsl */ `
const float HATCH_SECONDS = ${HATCH_SECONDS.toFixed(1)};
`;

function chance(x, y, z, k) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(k + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// When the patch a rest-pose point is in goes, as a share of the hatching.
function patchWhen(x, y, z, height) {
  const qx = x * PATCHES + 11, qy = y * PATCHES + 11, qz = z * PATCHES + 11;
  const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
  let least = Infinity, mx = 0, my = 0, mz = 0, cx = 0, cy = 0, cz = 0;
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++)
      for (let c = -1; c <= 1; c++) {
        const sx = ix + a + chance(ix + a, iy + b, iz + c, 0), sy = iy + b + chance(ix + a, iy + b, iz + c, 1), sz = iz + c + chance(ix + a, iy + b, iz + c, 2);
        const d = (sx - qx) ** 2 + (sy - qy) ** 2 + (sz - qz) ** 2;
        if (d < least) (least = d), (mx = sx), (my = sy), (mz = sz), (cx = ix + a), (cy = iy + b), (cz = iz + c);
      }
  mx = (mx - 11) / PATCHES;
  my = (my - 11) / PATCHES;
  mz = (mz - 11) / PATCHES;
  const round = Math.atan2(Math.abs(mx), mz) / Math.PI;
  return STRAIN_SHARE + 0.2 * round + 0.13 * Math.min(1, Math.abs(my - 0.72 * height) / (0.72 * height)) + 0.1 * Math.min(1, Math.abs(mx) / 0.8) + 0.05 * chance(cx, cy, cz, 3);
}

// How much of the figure the lamp's light has crossed to reach a point. The scene's main file draws the figure's
// depth as the lamp sees it (uLampDepth, through uLampMatrix): that is where the light went in. This point is where
// it comes out, so the difference along the ray is what it went through, limb by limb and pose by pose. A few taps
// round the point soften it, and thin it toward an outline, as scattering would. The body alone is drawn the same
// way (uLampBody): whether it stood in the way tells the silk's own wall, which passes light, from the body in it,
// which does not.
export const depthPars = /* glsl */ `
uniform sampler2D uLampDepth;
uniform sampler2D uLampBody;
uniform mat4 uLampMatrix;
uniform vec2 uLampRange; // the lamp view's near and far
float lampMetres(float depth) {
  float z = depth * 2.0 - 1.0;
  return 2.0 * uLampRange.x * uLampRange.y / (uLampRange.y + uLampRange.x - z * (uLampRange.y - uLampRange.x));
}
// In metres; 0 where the lamp sees the point. r: the point's distance from the lamp. body: how much of the light
// met the body on its way, 0 to 1.
float lampThickness(vec3 P, float r, out float body) {
  body = 0.0;
  vec4 clip = uLampMatrix * vec4(P, 1.0);
  if (clip.w <= 0.0) return 0.0;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 2.399963;
    vec2 at = uv + vec2(cos(a), sin(a)) * (sqrt((float(i) + 0.5) / 12.0) * 0.014);
    // (A texel nothing was drawn in holds the far plane: not a surface, however far the point is.)
    float all = texture(uLampDepth, at).r, inner = texture(uLampBody, at).r;
    sum += all < 0.9999 ? max(0.0, clip.w - lampMetres(all)) : 0.0;
    body += inner < 0.9999 ? step(lampMetres(inner), clip.w - 0.004) : 0.0;
  }
  body /= 12.0;
  return sum / 12.0 * r / clip.w;
}
// How much of the lamp's light is blocked at a point far behind the figure, 0 to 1: the share of a disc of taps
// that something stands in front of, so the edge is soft instead of stepped in the depth map's texels.
float lampShadow(vec3 P) {
  vec4 clip = uLampMatrix * vec4(P, 1.0);
  if (clip.w <= 0.0) return 0.0;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  float blocked = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.399963;
    float d = texture(uLampDepth, uv + vec2(cos(a), sin(a)) * (sqrt((float(i) + 0.5) / 16.0) * 0.02)).r;
    blocked += d < 0.9999 && lampMetres(d) < clip.w - 0.05 ? 1.0 : 0.0;
  }
  return blocked / 16.0;
}
`;

// The body under the silk: plain, and lit by the lamp as well as the studio, where the figure does not stand in the
// lamp's way (colour pass only: the lamp's depth is drawn with this material's own shadow variant).
const bodySurface = /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
  vec3 toLamp = uLamp - vWorldPosition;
  float r2 = dot(toLamp, toLamp);
  float behind;
  float seen = 1.0 - smoothstep(0.02, 0.06, lampThickness(vWorldPosition, sqrt(r2), behind));
  s.emissive += s.albedo * uLampColor * 0.3183 * seen * max(0.0, dot(normalize(s.normal), toLamp * inversesqrt(r2))) / (1.0 + 0.6 * r2);
#endif
}
`;

// The silk. Where: two sets of bands that wind round the body (a turn count from height, the angle round the upright
// axis and the distance from it, so they also cross the outstretched arms), each wide by how far the silk has got
// here. What: felt, crinkled at two scales (a dome over each of a scatter of points; its slope is known, and is
// turned to the world by the bones' own rotation, so the relief moves with the body), with the lay of the thread
// along the bands. Light gets into silk: past the key's terminator it is still lit by what scattered through. The
// lamp lights the side it sees directly; everywhere else gets what is left of its light after crossing the figure
// (lampThickness): most through a hand or an arm, little through the chest, red last, so thin parts glow amber and
// thick ones a dull red, and a limb between the lamp and the body dims what is behind it instead of blacking it out.
const silkSurface = /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vRest;
  float turn1;
  float inside = bandInside(p, turn1);
  // Hatching: a patch goes all but at once, from a scatter of holes (its chips are let go from there).
  if (uHatch > 0.0 && noise3(p * 45.0) < 1.3 * smoothstep(0.0, 0.3, (uHatch - vWhen) * HATCH_SECONDS)) inside = 0.0;
  s.alpha = inside > 0.0 ? 1.0 : 0.0;
  if (inside <= 0.0) return;
#if defined(PIPELINE_SHADOW) || defined(PIPELINE_DEPTH)
  return;
#endif

  vec3 N = normalize(s.normal);
  vec3 V = normalize(cameraPosition - vWorldPosition);
  vec3 L = normalize(lightDirection);
  vec3 bent = p + 0.014 * vec3(noise3(p * 13.0), noise3(p * 13.0 + 7.0), noise3(p * 13.0 + 13.0));
  vec4 cell = cells(bent * 45.0);
  vec4 fine = cells(bent * 100.0 + 3.7);
  float dome = 1.0 - min(cell.w, 1.0);
  float grain = 1.0 - min(fine.w, 1.0);
  vec3 tilt = cell.xyz * 0.45 + fine.xyz * 0.25;
  vec3 slope = vAxisX * tilt.x + vAxisY * tilt.y + vAxisZ * tilt.z;
  s.normal = normalize(N - (slope - dot(slope, N) * N));
  float thread = 0.5 + 0.5 * sin(6.2831853 * turn1 * 7.0);
  // (The lighting below reads the lamp's depth, which the shadow variant is itself drawn into: colour pass only.)
  s.albedo *= (0.74 + 0.26 * dome) * (0.92 + 0.08 * grain) * (0.9 + 0.1 * thread) * mix(0.8, 1.0, smoothstep(0.0, 0.2, inside));


#ifdef PIPELINE_COLOR
  float ndl = dot(N, L);
  float through = smoothstep(-0.7, 0.05, ndl) * (1.0 - smoothstep(0.0, 0.55, ndl));
  float edge = 1.0 - max(dot(N, V), 0.0);
  float rim = edge * edge * edge * (0.4 + 0.6 * max(0.0, dot(V, -L)));
  s.emissive += s.albedo * vec3(1.0, 0.94, 0.86) * lightColor * 0.3183 * (0.3 * through + 0.25 * rim);

  vec3 toLamp = uLamp - vWorldPosition;
  float r = length(toLamp);
  vec3 l = toLamp / r;
  float facing = dot(N, l);
  float behind;
  float crossed = lampThickness(vWorldPosition, r, behind);
  float seen = 1.0 - smoothstep(0.01, 0.06, crossed);
  // Seen by the lamp: lit, and past where a hard surface would go dark, red furthest, as light that went in nearby
  // comes back out.
  vec3 wrapBy = vec3(0.55, 0.3, 0.15);
  vec3 wrap = clamp((facing + wrapBy) / (1.0 + wrapBy), 0.0, 1.0);
  vec3 direct = wrap * wrap * seen * max(0.0, 1.0 + 1.5 * (dot(s.normal, l) - facing));
  // Not seen: what is left after the crossing, less where the felt lies thicker, blue lost first. Through silk alone
  // most of it is left; where the body stood in the way, very little, so the body shows as a shadow in a lit shell.
  // More of it comes out toward an eye that looks at the lamp, and at the outline, where the way out is all silk.
  vec3 left = exp(-crossed * (0.8 + 0.4 * (1.0 - dome)) * mix(vec3(2.5, 5.0, 9.0), vec3(12.0, 26.0, 48.0), behind));
  float phase = 0.35 + 1.2 * pow(max(dot(-V, l), 0.0), 4.0) + 0.5 * edge * edge;
  vec3 lit = s.albedo * 0.3183 * (direct + vec3(1.0, 0.86, 0.7) * left * phase * (1.0 - wrap * wrap * seen));
  s.emissive += uLampColor * lit / (1.0 + 0.6 * r * r);
#endif
}
`;

// A filament: lit round its axis (the pipeline's fibre term) and through from behind, by the key and by the lamp
// (where the figure is not in the lamp's way: lampThickness).
// A hair of the fuzz is there once the silk has reached its root (vUv.x is the root's height, vFibre.y its own
// lateness), and fades in and out at its ends (vUv.y runs along it). A web (vFibre.y -1) is a sheet with vUv.x across
// it: mostly separate filaments, with a little between them. A wisp (-2) is one filament.
const flossSurface = /* glsl */ `
void surface(inout Surface s) {
  vec3 T = normalize(vTangent);
  vec3 V = normalize(cameraPosition - vWorldPosition);
  float there = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  if (vFibre.y > -0.5) there *= smoothstep(vFibre.y, vFibre.y + 0.1, coverAt(vUv.x * uHeight));
  else if (vFibre.y > -1.5) there = 0.35 + 0.65 * pow(abs(sin(vUv.x * 31.0 + 2.5 * sin(vUv.x * 7.0 + vUv.y * 3.0))), 3.0);
  // (A web goes as the cocoon breaks open.)
  if (vFibre.y < -0.5 && vFibre.y > -1.5) there *= 1.0 - smoothstep(0.0, 0.4, uHatch);
  s.alpha *= vFibre.x * there;
  s.fiber = 1.0;
  s.fiberAxis = T;
  s.transmissionForward = 0.5;
  vec3 toLamp = uLamp - vWorldPosition;
  float r2 = dot(toLamp, toLamp);
  vec3 l = toLamp * inversesqrt(r2);
  float tl = dot(T, l);
  // Only where the lamp reaches it: behind the figure a filament gets the little that came through, as the silk does.
  float behind;
  float crossed = lampThickness(vWorldPosition, sqrt(r2), behind);
  vec3 reach = mix(0.5 * exp(-crossed * vec3(9.0, 20.0, 38.0)), vec3(1.0), 1.0 - smoothstep(0.005, 0.04, crossed));
  s.emissive += s.albedo * uLampColor * reach / (1.0 + 0.6 * r2) * sqrt(max(0.0, 1.0 - tl * tl)) * (0.1 + 0.9 * pow(max(dot(-V, l), 0.0), 4.0));
}
`;

// A chip of the shell: a ragged shape cut from its quad (vUv), each its own (vLook.y), felt on both faces, with the
// inside face yellowed; lit by the lamp from either side where nothing is in the way (colour pass only: the lamp's
// depth is drawn with this material's own shadow variant). It is solid, so it throws a shadow; it goes by shrinking.
const flakeSurface = /* glsl */ `
void surface(inout Surface s) {
  vec2 c = vUv * 2.0 - 1.0;
  float ragged = length(c) + 0.5 * (noise3(vec3(vUv * 3.5, vLook.y * 40.0)) - 0.5);
  s.alpha = ragged > 0.85 ? 0.0 : 1.0;
  s.albedo *= (0.8 + 0.2 * noise3(vec3(vUv * 14.0, vLook.y * 40.0))) * (gl_FrontFacing ? vec3(1.0) : vec3(0.8, 0.72, 0.6));
#ifdef PIPELINE_COLOR
  vec3 toLamp = uLamp - vWorldPosition;
  float r2 = dot(toLamp, toLamp);
  float behind;
  float crossed = lampThickness(vWorldPosition, sqrt(r2), behind);
  vec3 reach = mix(0.5 * exp(-crossed * vec3(9.0, 20.0, 38.0)), vec3(1.0), 1.0 - smoothstep(0.01, 0.05, crossed));
  s.emissive += s.albedo * uLampColor * reach * 0.3183 * (0.35 + 0.65 * abs(dot(normalize(s.normal), toLamp * inversesqrt(r2)))) / (1.0 + 0.6 * r2);
#endif
}
`;

// A normal per vertex that is the same for every vertex at the same place, so pushing the skin out along it does
// not open the seams where the model's own normals differ.
function smoothNormals(geometry) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const sums = new Map();
  const keys = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    keys[i] = key;
    let sum = sums.get(key);
    if (!sum) sums.set(key, (sum = [0, 0, 0]));
    sum[0] += nor.getX(i);
    sum[1] += nor.getY(i);
    sum[2] += nor.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = sums.get(keys[i]), len = Math.hypot(s[0], s[1], s[2]) || 1;
    out.set([s[0] / len, s[1] / len, s[2] / len], i * 3);
  }
  return out;
}

export class Figure {
  // gltf: a loaded glTF with skinned meshes and animation clips; extra: more clips for the same skeleton.
  constructor(gltf, extra = []) {
    this.root = gltf.scene;
    this.uniforms = {
      uLamp: { value: new Vector3(0, 1, 3) },
      uLampColor: { value: new Color(0, 0, 0) },
      uCover: { value: 0 },
      uHatch: { value: 0 },
      uStrain: { value: 0 },
      uThick: { value: 0.02 },
      uHeight: { value: 1.8 },
      // The figure's depth from the lamp, drawn by whoever owns the lamp (see depthPars).
      uLampDepth: { value: null },
      uLampBody: { value: null },
      uLag: { value: null },
      uPrevBones: { value: null },
      uLampMatrix: { value: new Matrix4() },
      uLampRange: { value: new Vector2(0.05, 5) },
    };
    const lit = { fragmentPars: lampPars + depthPars, uniforms: this.uniforms };
    this.bodyMaterials = [0, 1].map(() => new PipelineMaterial({ color: 0x333333, roughness: 0.6, vertexPars: skinPars, vertex: bodyVertex, surface: bodySurface, ...lit }));
    this.silkMaterial = new PipelineMaterial({
      color: 0xe4e0d8,
      roughness: 0.92,
      sheen: 0.6,
      sheenRoughness: 0.6,
      defines: { PIPELINE_SOFT_TERMINATOR: "" },
      vertexPars: skinPars + "in vec3 aSmooth;\nin float aWhen;\nuniform float uThick;\nuniform float uStrain;" + lampPars + noisePars + bandPars + hatchPars,
      vertex: silkVertex,
      varyings: { vRest: "vec3", vAxisX: "vec3", vAxisY: "vec3", vAxisZ: "vec3", vWhen: "float" },
      fragmentPars: lampPars + noisePars + bandPars + depthPars + hatchPars,
      surface: silkSurface,
      uniforms: this.uniforms,
    });
    // Blended and out of the prepass and the shadow map: hair this fine would only be noise in either.
    const fibre = () => ({
      color: 0xe4e0d8,
      roughness: 0.45,
      transmission: 0.5,
      thinSheet: true,
      transparent: true,
      depthWrite: false,
      varyings: { vTangent: "vec3", vFibre: "vec2" },
      fragmentPars: lampPars + depthPars,
      surface: flossSurface,
      uniforms: this.uniforms,
    });
    this.flossMaterial = new PipelineMaterial({ ...fibre(), vertexPars: skinPars + "in vec3 aRoot;\nin vec3 aTangent;\nin vec3 aFibre;\nuniform float uThick;\nuniform sampler2D uLag;\nuniform float uHatch;\nin float aWhen;" + hatchPars, vertex: flossVertex });
    this.strandMaterial = new PipelineMaterial({ ...fibre(), side: DoubleSide, vertexPars: "in vec3 aTangent;\nin vec3 aFibre;", vertex: strandVertex });
    this.flakeMaterial = new PipelineMaterial({
      color: 0xe4e0d8,
      roughness: 0.92,
      side: DoubleSide,
      vertexPars: "in vec2 aLook;",
      vertex: flakeVertex,
      varyings: { vLook: "vec2" },
      fragmentPars: lampPars + noisePars + depthPars,
      surface: flakeSurface,
      uniforms: this.uniforms,
    });

    // The model's skinned meshes get the body material, and each a silk copy bound to the same skeleton.
    const bodies = [];
    this.root.traverse((o) => o.isSkinnedMesh && bodies.push(o));
    bodies.sort((a, b) => b.geometry.attributes.position.count - a.geometry.attributes.position.count);
    bodies[0].geometry.computeBoundingBox();
    bodies.forEach((body, i) => {
      body.material = this.bodyMaterials[Math.min(i, 1)];
      body.userData.body = true; // for the lamp's view of the body alone
      body.frustumCulled = false;
      body.geometry.setAttribute("aSmooth", new BufferAttribute(smoothNormals(body.geometry), 3));
      const at = body.geometry.attributes.position, whens = new Float32Array(at.count);
      for (let v = 0; v < at.count; v++) whens[v] = patchWhen(at.getX(v), at.getY(v), at.getZ(v), bodies[0].geometry.boundingBox.max.y);
      body.geometry.setAttribute("aWhen", new BufferAttribute(whens, 1));
      const silk = new SkinnedMesh(body.geometry, this.silkMaterial);
      silk.bind(body.skeleton, body.bindMatrix);
      silk.frustumCulled = false;
      body.parent.add(silk);
    });
    this.skin = bodies[0]; // the largest: what the fuzz grows on
    this.skin.geometry.computeBoundingBox();
    this.uniforms.uHeight.value = this.skin.geometry.boundingBox.max.y;

    this.floss = new SkinnedMesh(new BufferGeometry(), this.flossMaterial);
    this.floss.bind(this.skin.skeleton, this.skin.bindMatrix);
    this.floss.frustumCulled = false;
    this.floss.userData.noShadow = true;
    this.skin.parent.add(this.floss);

    // The bones: where each rests (skin space, as the silk's pattern is), and the point that follows each on a spring.
    const bones = (this.bones = this.skin.skeleton.bones);
    this.boneRest = new Float32Array(bones.length * 3);
    const m = new Matrix4();
    this.skin.skeleton.boneInverses.forEach((inverse, b) => this.boneRest.set(m.copy(inverse).invert().elements.slice(12, 15), b * 3));
    this.follow = new Float32Array(bones.length * 6); // position, velocity
    this.followReady = false;
    this.lag = new DataTexture(new Float32Array(bones.length * 4), bones.length, 1, RGBAFormat, FloatType);
    this.uniforms.uLag.value = this.lag;
    // Last frame's bone matrices, laid out as three's bone texture.
    const side = Math.max(4, Math.ceil(Math.sqrt(bones.length * 4) / 4) * 4);
    this.prevBones = new DataTexture(new Float32Array(side * side * 4), side, side, RGBAFormat, FloatType);
    this.uniforms.uPrevBones.value = this.prevBones;
    this.root.updateMatrixWorld(true);

    // The ribbons, with nothing in them yet: two vertices a step. uv is across and along; aFibre is opacity, the
    // kind (-1 a web, -2 a wisp), 0.
    const size = (BRIDGES + WISPS) * STRAND_POINTS * 2;
    const uvs = new Float32Array(size * 2), looks = new Float32Array(size * 3), indices = [];
    for (let v = 0; v < size; v++) {
      const i = (v >> 1) % STRAND_POINTS;
      uvs[v * 2] = v & 1;
      uvs[v * 2 + 1] = i / (STRAND_POINTS - 1);
      looks[v * 3 + 1] = v < BRIDGES * STRAND_POINTS * 2 ? -1 : -2;
      if (!(v & 1) && i < STRAND_POINTS - 1) indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    const strandGeometry = new BufferGeometry();
    strandGeometry.setAttribute("position", new BufferAttribute(new Float32Array(size * 3), 3));
    strandGeometry.setAttribute("normal", new BufferAttribute(new Float32Array(size * 3), 3));
    strandGeometry.setAttribute("aTangent", new BufferAttribute(new Float32Array(size * 3), 3));
    strandGeometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    strandGeometry.setAttribute("aFibre", new BufferAttribute(looks, 3));
    strandGeometry.setIndex(indices);
    this.strands = new Mesh(strandGeometry, this.strandMaterial);
    this.strands.frustumCulled = false;
    this.strands.userData.noShadow = true;
    this.root.add(this.strands);

    // Places on the skin for webs to hold on to and wisps to come off: where each rests, where it is now and was a
    // frame ago, its nearest neighbour (a web's other corner), and whether a web holds on to it.
    const pos = this.skin.geometry.attributes.position;
    const samples = Math.min(BRIDGE_SAMPLES, pos.count);
    this.samples = new Int32Array(samples);
    this.sampleRest = new Float32Array(samples * 3);
    this.sampleAt = new Float32Array(samples * 3);
    this.sampleWas = new Float32Array(samples * 3);
    this.sampleNear = new Int32Array(samples);
    this.sampleBusy = new Uint8Array(samples);
    for (let i = 0; i < samples; i++) {
      this.samples[i] = Math.floor((i * pos.count) / samples);
      this.sampleRest.set([pos.getX(this.samples[i]), pos.getY(this.samples[i]), pos.getZ(this.samples[i])], i * 3);
    }
    for (let i = 0; i < samples; i++) {
      let least = Infinity;
      for (let j = 0; j < samples; j++) {
        const d = (this.sampleRest[i * 3] - this.sampleRest[j * 3]) ** 2 + (this.sampleRest[i * 3 + 1] - this.sampleRest[j * 3 + 1]) ** 2 + (this.sampleRest[i * 3 + 2] - this.sampleRest[j * 3 + 2]) ** 2;
        if (d > 0.0004 && d < least) (least = d), (this.sampleNear[i] = j);
      }
    }
    this.samplesReady = false;
    this.bridges = []; // { slot, i, j, i2, j2, length (when made), alpha, gone }
    this.freeSlots = Array.from({ length: BRIDGES }, (_, i) => i);
    this.scanFrom = 0;
    this.motion = 0; // how fast the wound skin is moving, metres a second, averaged
    this.shed = 0; // wisps thrown off this frame

    // The wisps: each a fixed curl (a wander of a few centimetres), where it is, how it moves, its age and its span
    // (0: not in use), and how far round it has turned.
    this.wispShape = new Float32Array(WISPS * STRAND_POINTS * 3);
    for (let w = 0; w < WISPS; w++) {
      _a.set(0, 0, 0);
      _t.set(nativeRandom() - 0.5, nativeRandom() - 0.5, nativeRandom() - 0.5).normalize();
      for (let i = 0; i < STRAND_POINTS; i++) {
        _a.toArray(this.wispShape, (w * STRAND_POINTS + i) * 3);
        _t.add(_n.set(nativeRandom() - 0.5, nativeRandom() - 0.5, nativeRandom() - 0.5).multiplyScalar(1.3)).normalize();
        _a.addScaledVector(_t, 0.008 + 0.008 * nativeRandom());
      }
    }
    this.wispAt = new Float32Array(WISPS * 3);
    this.wispMove = new Float32Array(WISPS * 3);
    this.wispAge = new Float32Array(WISPS);
    this.wispSpan = new Float32Array(WISPS);
    this.wispTurn = new Float32Array(WISPS);

    // The chips: where on the skin each comes from and when (with its patch), and while it is in the air its place
    // on its spiral (angle, distance out, height), where that is going (distance out, turns, sink), its age and span
    // (0: not in the air), and its size.
    const flakeFrom = (this.flakeFrom = new Int32Array(FLAKES));
    this.flakeWhen = new Float32Array(FLAKES);
    // (Spread by area, not by vertex, or most would come off the hands and feet, where the mesh is finest: each
    // vertex counts for the triangles round it.)
    const share = new Float32Array(pos.count), index = this.skin.geometry.index;
    for (let t = 0; t < index.count; t += 3) {
      _a.fromBufferAttribute(pos, index.getX(t));
      _b.fromBufferAttribute(pos, index.getX(t + 1));
      _c.fromBufferAttribute(pos, index.getX(t + 2));
      const area = _b.sub(_a).cross(_c.sub(_a)).length();
      for (let k = 0; k < 3; k++) share[index.getX(t + k)] += area;
    }
    let whole = 0;
    for (let v = 0; v < pos.count; v++) whole += share[v];
    for (let i = 0, v = 0, passed = share[0]; i < FLAKES; i++) {
      while (passed < ((i + 0.5) * whole) / FLAKES && v < pos.count - 1) passed += share[++v];
      flakeFrom[i] = v;
      this.flakeWhen[i] = patchWhen(pos.getX(flakeFrom[i]), pos.getY(flakeFrom[i]), pos.getZ(flakeFrom[i]), this.uniforms.uHeight.value) + 0.012 * nativeRandom();
    }
    this.flakeAt = new Float32Array(FLAKES * 3);
    this.flakeKnock = new Float32Array(FLAKES * 3); // a velocity the body gave it, fading in the air
    this.flakeMove = new Float32Array(FLAKES * 3);
    this.flakeAge = new Float32Array(FLAKES);
    this.flakeSpan = new Float32Array(FLAKES);
    this.flakeSize = new Float32Array(FLAKES);
    this.flakeSeed = new Float32Array(FLAKES);
    this.flakeCentre = new Vector3(); // what the spirals wind round: where the figure stood as it began to hatch
    this.hatchWas = 0;
    const flakeUvs = new Float32Array(FLAKES * 8), flakeLooks = new Float32Array(FLAKES * 8), flakeIndex = [];
    for (let i = 0; i < FLAKES; i++) {
      flakeUvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      this.flakeSeed[i] = nativeRandom();
      for (let k = 0; k < 4; k++) flakeLooks[(i * 4 + k) * 2 + 1] = this.flakeSeed[i];
      flakeIndex.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    const flakeGeometry = new BufferGeometry();
    flakeGeometry.setAttribute("position", new BufferAttribute(new Float32Array(FLAKES * 12), 3));
    flakeGeometry.setAttribute("normal", new BufferAttribute(new Float32Array(FLAKES * 12), 3));
    flakeGeometry.setAttribute("uv", new BufferAttribute(flakeUvs, 2));
    flakeGeometry.setAttribute("aLook", new BufferAttribute(flakeLooks, 2));
    flakeGeometry.setIndex(flakeIndex);
    this.flakes = new Mesh(flakeGeometry, this.flakeMaterial);
    this.flakes.frustumCulled = false;
    // (They shadow the key light, which is far off and filtered. Not the lamp: it is among them, and a chip near a
    // small light throws a huge, hard-edged streak across the room where its real shadow would be too soft to see.)
    this.flakes.userData.noLampShadow = true;
    this.flakes.visible = false;
    this.root.add(this.flakes);

    this.mixer = new AnimationMixer(this.root);
    this.bases = {};
    this.poses = {}; // name: { action, weight }
    const motions = Object.values(MOTIONS);
    for (const clip of [...gltf.animations, ...extra]) {
      if (motions.some((m) => m.base === clip.name)) this.bases[clip.name] = this.mixer.clipAction(clip);
      else if (motions.some((m) => m.pose === clip.name)) {
        // Additive, and only its last frame: the first is the reference it is measured from.
        AnimationUtils.makeClipAdditive(clip);
        const action = this.mixer.clipAction(AnimationUtils.subclip(clip, clip.name, 2, 3, 30));
        action.setEffectiveWeight(0).play();
        this.poses[clip.name] = { action, weight: 0 };
      }
    }
    this.base = null;
    this.pose = null;
  }

  // Which way the body faces, flat on the ground: square to the line from its right side to its left (hips and
  // shoulders), as it is posed now.
  facing(out) {
    if (!this.sides) {
      const named = (name) => this.bones.find((bone) => bone.name === `mixamorig${name}`);
      this.sides = [named("LeftUpLeg"), named("RightUpLeg"), named("LeftArm"), named("RightArm")];
    }
    const [lh, rh, ls, rs] = this.sides.map((bone) => new Vector3().setFromMatrixPosition(bone.matrixWorld));
    const across = lh.sub(rh).add(ls.sub(rs));
    return out.set(-across.z, 0, across.x).normalize();
  }

  // Where each capsule's ends are now, and how fast they moved over the last step (real time).
  updateCapsules(dt) {
    if (!this.capsules) {
      const named = (name) => this.bones.find((bone) => bone.name === `mixamorig${name}`);
      this.capsules = CAPSULES.map(([from, to, radius]) => ({ from: named(from), to: named(to), radius, a: new Vector3(), b: new Vector3(), va: new Vector3(), vb: new Vector3(), ready: false }));
    }
    for (const c of this.capsules) {
      _u.setFromMatrixPosition(c.from.matrixWorld);
      _d.setFromMatrixPosition(c.to.matrixWorld);
      if (c.ready && dt > 0) c.va.subVectors(_u, c.a).divideScalar(dt), c.vb.subVectors(_d, c.b).divideScalar(dt);
      else if (!c.ready || dt > 0) c.va.set(0, 0, 0), c.vb.set(0, 0, 0);
      c.a.copy(_u);
      c.b.copy(_d);
      c.ready = true;
    }
  }

  // Pushes p out of the body to margin beyond its capsules. Returns how deep it was (0 if clear); normal and velocity,
  // if given, get the push's direction and the body's velocity there.
  pushOut(p, margin = 0, normal = null, velocity = null) {
    let deepest = 0;
    for (const c of this.capsules ?? []) {
      _t.subVectors(c.b, c.a);
      const t = Math.min(1, Math.max(0, _t.dot(_e.subVectors(p, c.a)) / Math.max(_t.lengthSq(), 1e-9)));
      _e.copy(c.a).addScaledVector(_t, t);
      const away = _e.subVectors(p, _e), d = away.length(), reach = c.radius + margin;
      if (d >= reach) continue;
      if (d > 1e-6) away.divideScalar(d);
      else away.set(0, 1, 0);
      p.addScaledVector(away, reach - d);
      if (reach - d > deepest) {
        deepest = reach - d;
        normal?.copy(away);
        velocity?.copy(c.va).lerp(c.vb, t);
      }
    }
    return deepest;
  }

  setBodyColors({ body, joints }) {
    this.bodyMaterials[0].color.set(body);
    this.bodyMaterials[1].color.set(joints);
  }

  setStyle(style) {
    this.setBodyColors(style);
    this.setSilkColor(style.silk);
  }

  setSilkColor(color) {
    for (const material of [this.silkMaterial, this.flossMaterial, this.strandMaterial, this.flakeMaterial]) material.color.set(color);
    this.silkMaterial.sheenColor.set(color);
  }

  setClip(name) {
    const motion = MOTIONS[name] ?? MOTIONS.walk;
    this.pose = motion.pose ?? null;
    const next = this.bases[motion.base];
    if (!next || next === this.base) return;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    // Warping matches the two clips' speeds through the fade, which keeps the feet in step between two gaits of
    // about the same length. Between a one-second walk and an eighteen-second dance it would play one of them at
    // nineteen times its speed for the length of the fade, so those just cross-fade.
    if (this.base) {
      const a = next.getClip().duration, b = this.base.getClip().duration;
      next.crossFadeFrom(this.base, 0.5, Math.max(a, b) / Math.min(a, b) < 2);
    }
    this.base = next;
  }

  // dt: the animation's time step; realDt: real time, 0 while paused (what hangs in the air and swings on springs
  // goes by it, so it settles while the body is held still); wallDt: real time, for easing; cover: how much of the
  // silk is on, 0 to 1.
  update(dt, realDt, wallDt, cover = 0) {
    const k = 1 - Math.exp(-wallDt * 5);
    for (const [name, pose] of Object.entries(this.poses)) {
      pose.weight += ((name === this.pose ? 1 : 0) - pose.weight) * k;
      pose.action.setEffectiveWeight(pose.weight);
    }
    // The bones as they were drawn last frame (the pose still in place from then), before they move on.
    this.skin.skeleton.update();
    this.prevBones.image.data.set(this.skin.skeleton.boneMatrices);
    this.prevBones.needsUpdate = true;
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    this.updateCapsules(realDt);
    // (The fuzz is not drawn at all while there is no silk for it to show on.)
    this.floss.visible = this.hasFloss && cover > 0;
    this.sway(realDt);
    this.bridge(dt, realDt, cover);
    this.drift(realDt);
    this.flake(realDt);
    const attributes = this.strands.geometry.attributes;
    attributes.position.needsUpdate = attributes.normal.needsUpdate = attributes.aTangent.needsUpdate = attributes.aFibre.needsUpdate = true;
  }

  // How far the silk has got at a rest height (as coverAt in the shaders).
  coverAt(y, cover) {
    return Math.min(1, Math.max(0, cover * 1.6 - 0.6 * Math.min(1, Math.max(0, y / this.uniforms.uHeight.value))));
  }

  // Each bone's follower: pulled to the bone, damped lightly enough to swing past it and back. What the fuzz gets is
  // how far behind it is, no more than a hand's width.
  sway(dt) {
    const h = Math.min(dt, 1 / 30), follow = this.follow, lag = this.lag.image.data;
    this.bones.forEach((bone, b) => {
      const e = bone.matrixWorld.elements;
      let length = 0;
      for (let a = 0; a < 3; a++) {
        const at = b * 6 + a, to = e[12 + a];
        if (!this.followReady) (follow[at] = to), (follow[at + 3] = 0);
        follow[at + 3] += ((to - follow[at]) * 90 - follow[at + 3] * 7) * h;
        follow[at] += follow[at + 3] * h;
        length += (follow[at] - to) ** 2;
      }
      const keep = Math.min(1, 0.07 / (Math.sqrt(length) || 1));
      for (let a = 0; a < 3; a++) {
        const at = b * 6 + a, to = e[12 + a];
        follow[at] = to + (follow[at] - to) * keep;
        lag[b * 4 + a] = follow[at] - to;
      }
    });
    this.followReady = true;
    this.lag.needsUpdate = true;
  }

  // One step along a ribbon: its two edges there (world), the way it runs, and how solid it is.
  ribbon(slot, i, a, b, t, opacity) {
    const attributes = this.strands.geometry.attributes;
    const v = (slot * STRAND_POINTS + i) * 2;
    a.toArray(attributes.position.array, v * 3);
    b.toArray(attributes.position.array, v * 3 + 3);
    _n.subVectors(b, a).cross(t).normalize();
    _n.toArray(attributes.normal.array, v * 3);
    _n.toArray(attributes.normal.array, v * 3 + 3);
    t.toArray(attributes.aTangent.array, v * 3);
    t.toArray(attributes.aTangent.array, v * 3 + 3);
    attributes.aFibre.array[v * 3] = attributes.aFibre.array[v * 3 + 3] = opacity;
  }

  // The webs, and what the skin's own speed sets off. A web is made where two places on the wound skin that rest
  // well apart come within a hand and a half of each other, between them and their neighbours; it stretches, thins and necks
  // as they part, hangs slack if they close, and tears past arm's length. A place moving fast throws off a wisp.
  bridge(dt, realDt, cover) {
    const at = this.sampleAt, was = this.sampleWas, rest = this.sampleRest, busy = this.sampleBusy, near = this.sampleNear, count = this.samples.length;
    const world = this.skin.matrixWorld;
    was.set(at);
    for (let i = 0; i < count; i++) this.skin.getVertexPosition(this.samples[i], _c).applyMatrix4(world).toArray(at, i * 3);
    const wound = (i) => this.coverAt(rest[i * 3 + 1], cover) > 0.5;
    const apart2 = (of, i, j) => (of[i * 3] - of[j * 3]) ** 2 + (of[i * 3 + 1] - of[j * 3 + 1]) ** 2 + (of[i * 3 + 2] - of[j * 3 + 2]) ** 2;

    this.shed = 0;
    let moving = 0;
    const hatching = this.uniforms.uHatch.value > 0;
    // (Straining, nothing has torn yet.)
    const breaking = this.uniforms.uHatch.value > STRAIN_SHARE;
    if (this.samplesReady && dt > 0 && realDt > 0) {
      for (let i = 0; i < count; i++) {
        if (!wound(i)) continue;
        const moved = Math.sqrt((at[i * 3] - was[i * 3]) ** 2 + (at[i * 3 + 1] - was[i * 3 + 1]) ** 2 + (at[i * 3 + 2] - was[i * 3 + 2]) ** 2);
        // As seen: slow in a cocoon that holds the body still, whatever the clip's own pace.
        const speed = moved / realDt;
        moving += speed;
        // (Breaking open throws them off everywhere, whatever the speed.)
        if (this.shed > 1 || nativeRandom() > (breaking ? 0.03 : hatching ? 0 : (speed - 1.6) * realDt * 0.6)) continue;
        const w = this.wispSpan.indexOf(0);
        if (w < 0) continue;
        for (let a = 0; a < 3; a++) {
          this.wispAt[w * 3 + a] = at[i * 3 + a];
          this.wispMove[w * 3 + a] = ((at[i * 3 + a] - was[i * 3 + a]) / realDt) * 0.5 + (breaking ? nativeRandom() - 0.5 : 0);
        }
        this.wispAge[w] = 0;
        this.wispSpan[w] = 1.2 + 1.2 * nativeRandom();
        this.wispTurn[w] = nativeRandom() * 6.28;
        this.shed++;
      }
    }
    this.samplesReady = true;
    this.motion = moving / count;

    const ease = 1 - Math.exp(-realDt * 6);
    for (let n = this.bridges.length - 1; n >= 0; n--) {
      const br = this.bridges[n];
      const d = Math.sqrt(apart2(at, br.i, br.j));
      if (d > 0.4 || !wound(br.i) || !wound(br.j) || hatching) br.gone = true;
      br.alpha += ((br.gone ? 0 : 1) - br.alpha) * ease;
      if (this.uniforms.uHatch.value > 0.4) br.alpha = 0; // faded out with the cocoon by now
      const done = br.gone && br.alpha < 0.02;
      // Its two ends: each the middle of two places and half the way between them. Along it the middle hangs by
      // the slack and the width necks in, the more the further it is pulled.
      const slack = d < br.length ? 0.5 * Math.sqrt(br.length * br.length - d * d) : 0;
      const neck = 0.2 + 0.6 * Math.min(1, d / 0.25);
      const opacity = done ? 0 : br.alpha * Math.max(0.6, Math.min(1, br.length / d));
      _t.fromArray(at, br.j * 3).sub(_a.fromArray(at, br.i * 3)).normalize();
      for (let i = 0; i < STRAND_POINTS; i++) {
        const s = i / (STRAND_POINTS - 1), bow = Math.sin(Math.PI * s);
        _a.fromArray(at, br.i * 3).lerp(_d.fromArray(at, br.j * 3), s);
        _b.fromArray(at, br.i2 * 3).lerp(_d.fromArray(at, br.j2 * 3), s);
        _c.addVectors(_a, _b).multiplyScalar(0.5);
        _c.y -= slack * bow;
        _e.subVectors(_b, _a).multiplyScalar(0.8 * (1 - neck * bow));
        this.ribbon(br.slot, i, _a.subVectors(_c, _e), _b.addVectors(_c, _e), _t, opacity);
      }
      if (done) {
        busy[br.i] = busy[br.j] = 0;
        this.freeSlots.push(br.slot);
        this.bridges.splice(n, 1);
      }
    }
    // A few places looked at each frame, each against all the others.
    for (let q = 0, made = 0; q < 100 && made < 4 && this.freeSlots.length && !hatching; q++) {
      const i = this.scanFrom++ % count;
      if (busy[i] || !wound(i)) continue;
      for (let j = 0; j < count; j++) {
        if (j === i || busy[j] || apart2(at, i, j) > 0.0196 || apart2(rest, i, j) < 0.04 || !wound(j)) continue;
        busy[i] = busy[j] = 1;
        // The neighbours as the web's other two corners; if pairing them would cross the sheet over itself, it comes
        // to a point at this end instead.
        let i2 = near[i], j2 = near[j];
        if (apart2(at, i, j2) + apart2(at, i2, j) < apart2(at, i, j) + apart2(at, i2, j2)) i2 = i;
        this.bridges.push({ slot: this.freeSlots.pop(), i, j, i2, j2, length: Math.sqrt(apart2(at, i, j)), alpha: 0, gone: false });
        made++;
        break;
      }
    }
  }

  // The chips of the shell: let go as their patches go, then taken along their spirals.
  // released: chips let go this frame; flying: chips in the air (both for the sound).
  flake(dt) {
    this.released = 0;
    const h = Math.min(dt, 1 / 30);
    const hatch = this.uniforms.uHatch.value;
    if (hatch < this.hatchWas) this.hatchWas = 0;
    const P = this.flakeAt, G = this.flakeMove, centre = this.flakeCentre;
    if (hatch > 0) {
      if (!this.hatchWas) centre.setFromMatrixPosition(this.bones[0].matrixWorld);
      const world = this.skin.matrixWorld;
      for (let i = 0; i < FLAKES; i++) {
        if (this.flakeWhen[i] <= this.hatchWas || this.flakeWhen[i] > hatch) continue;
        this.skin.getVertexPosition(this.flakeFrom[i], _c).applyMatrix4(world);
        P[i * 3] = Math.atan2(_c.z - centre.z, _c.x - centre.x);
        P[i * 3 + 1] = Math.hypot(_c.x - centre.x, _c.z - centre.z) + 0.03;
        P[i * 3 + 2] = _c.y;
        G[i * 3] = 0.35 + 1.1 * nativeRandom() ** 1.5;
        G[i * 3 + 1] = 1.2 + 1.6 * nativeRandom();
        G[i * 3 + 2] = 0.12 + 0.3 * nativeRandom();
        this.flakeAge[i] = 0;
        this.flakeKnock.fill(0, i * 3, i * 3 + 3);
        this.released++;
        this.flakeSpan[i] = 3 + 3 * nativeRandom();
        this.flakeSize[i] = 0.018 + 0.03 * nativeRandom() ** 2;
      }
    }
    this.hatchWas = hatch;

    const attributes = this.flakes.geometry.attributes;
    const positions = attributes.position.array, normals = attributes.normal.array;
    let any = false;
    this.flying = 0;
    for (let i = 0; i < FLAKES; i++) {
      const span = this.flakeSpan[i];
      if (!span) continue;
      any = true;
      this.flying++;
      const seed = this.flakeSeed[i], size = this.flakeSize[i];
      const age = (this.flakeAge[i] += h);
      // Out to its own distance, quickly at first; round, slower the further out; down, with a first lift off the body.
      P[i * 3 + 1] += (G[i * 3] - P[i * 3 + 1]) * (1 - Math.exp(-0.9 * h));
      P[i * 3] += (G[i * 3 + 1] / (0.6 + P[i * 3 + 1])) * h;
      P[i * 3 + 2] = Math.max(0.03, P[i * 3 + 2] + (0.5 * Math.exp(-3 * age) - G[i * 3 + 2]) * h);
      // The body knocks it: once clear of where it came from, a chip inside a limb or the trunk is put back on the
      // surface and takes up the body's motion there, bouncing a little; the knock carries it, fading in the air,
      // and becomes part of its spiral (nothing pulls it back).
      const K = this.flakeKnock;
      _c.set(centre.x + Math.cos(P[i * 3]) * P[i * 3 + 1] + K[i * 3] * h, P[i * 3 + 2] + K[i * 3 + 1] * h, centre.z + Math.sin(P[i * 3]) * P[i * 3 + 1] + K[i * 3 + 2] * h);
      if (age > 0.25 && h > 0 && this.pushOut(_c, 0.015, _n, _u)) {
        _e.set(K[i * 3] - _u.x, K[i * 3 + 1] - _u.y, K[i * 3 + 2] - _u.z);
        const into = _e.dot(_n);
        if (into < 0) _e.addScaledVector(_n, -1.4 * into);
        _e.multiplyScalar(0.7).add(_u);
        _e.toArray(K, i * 3);
      }
      const fade = Math.exp(-2.5 * h);
      for (let a = 0; a < 3; a++) K[i * 3 + a] *= fade;
      P[i * 3] = Math.atan2(_c.z - centre.z, _c.x - centre.x);
      P[i * 3 + 1] = Math.hypot(_c.x - centre.x, _c.z - centre.z);
      P[i * 3 + 2] = Math.max(0.03, _c.y);
      // (A chip knocked outward keeps its new distance instead of easing back in.)
      if (K[i * 3] ** 2 + K[i * 3 + 2] ** 2 > 0.01) G[i * 3] = Math.max(G[i * 3], P[i * 3 + 1]);
      const out = P[i * 3 + 1] + 0.05 * Math.sin(age * 2.1 + seed * 30);
      const px = centre.x + Math.cos(P[i * 3]) * out, py = P[i * 3 + 2] + 0.03 * Math.sin(age * 3.3 + seed * 50), pz = centre.z + Math.sin(P[i * 3]) * out;
      // Turning over: one edge goes round the upright and rocks; the other is square to it and to an axis of its own.
      const theta = seed * 50 + age * (2 + 5 * seed), phi = 1.1 * Math.sin(age * 2.3 + seed * 20);
      _a.set(Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi));
      _b.set(Math.sin(seed * 91), Math.cos(seed * 57), Math.sin(seed * 33 + age)).cross(_a).normalize();
      _n.crossVectors(_a, _b);
      // It goes by shrinking to nothing: by the end of its span, or sooner if it gets near the floor.
      const done = age >= span;
      const scale = done ? 0 : Math.min(1, age * 10) * Math.min(1, (span - age) / 1.2) * Math.min(1, py / 0.25);
      for (let k = 0; k < 4; k++) {
        const u = (k === 1 || k === 2 ? size : -size) * scale, w = (k > 1 ? size : -size) * scale, o = (i * 4 + k) * 3;
        positions[o] = px + _a.x * u + _b.x * w;
        positions[o + 1] = py + _a.y * u + _b.y * w;
        positions[o + 2] = pz + _a.z * u + _b.z * w;
        normals[o] = _n.x; normals[o + 1] = _n.y; normals[o + 2] = _n.z;
      }
      if (done) this.flakeSpan[i] = 0;
    }
    this.flakes.visible = any;
    if (any) attributes.position.needsUpdate = attributes.normal.needsUpdate = true;
  }

  // The wisps in the air: slowed by it at once, sinking slowly, turning, wandering sideways, and gone in a second or
  // two, well before the floor.
  drift(dt) {
    const at = this.wispAt, move = this.wispMove, shape = this.wispShape;
    for (let w = 0; w < WISPS; w++) {
      if (!this.wispSpan[w]) continue;
      const age = (this.wispAge[w] += dt), span = this.wispSpan[w];
      const done = age >= span;
      const slow = Math.exp(-2.5 * dt);
      move[w * 3] = move[w * 3] * slow + Math.sin(age * 1.7 + w) * 0.05 * dt;
      move[w * 3 + 1] = move[w * 3 + 1] * slow - 0.2 * dt;
      move[w * 3 + 2] = move[w * 3 + 2] * slow + Math.cos(age * 1.3 + w * 2.1) * 0.05 * dt;
      for (let a = 0; a < 3; a++) at[w * 3 + a] += move[w * 3 + a] * dt;
      this.wispTurn[w] += dt * (0.6 + (w % 5) * 0.2);
      const opacity = done ? 0 : 0.8 * Math.min(1, age * 6) * Math.min(1, (span - age) / 0.8);
      const ca = Math.cos(this.wispTurn[w]), sa = Math.sin(this.wispTurn[w]);
      const point = (i, out) => {
        const o = (w * STRAND_POINTS + Math.min(STRAND_POINTS - 1, Math.max(0, i))) * 3;
        return out.set(at[w * 3] + shape[o] * ca + shape[o + 2] * sa, at[w * 3 + 1] + shape[o + 1], at[w * 3 + 2] - shape[o] * sa + shape[o + 2] * ca);
      };
      for (let i = 0; i < STRAND_POINTS; i++) {
        point(i, _c);
        _t.subVectors(point(i + 1, _a), point(i - 1, _b)).normalize();
        _e.set(0, 1, 0).cross(_t);
        if (_e.lengthSq() < 1e-6) _e.set(1, 0, 0);
        _e.setLength(0.0009);
        this.ribbon(BRIDGES + w, i, _a.subVectors(_c, _e), _b.addVectors(_c, _e), _t, opacity);
      }
      if (done) this.wispSpan[w] = 0;
    }
  }

  // The fuzz: amount 0 to 1, rng a 0..1 generator (the same one gives the same fuzz). Built in skin space, which for
  // a glTF is the rest pose in metres.
  buildFloss(amount, rng) {
    const g = this.skin.geometry;
    const pos = g.attributes.position, smooth = g.attributes.aSmooth, index = g.index;
    const skinIndex = g.attributes.skinIndex, skinWeight = g.attributes.skinWeight;
    const height = this.uniforms.uHeight.value;
    const tris = index.count / 3;
    // Roots are spread by area: a running total of the triangles' areas, searched for a random share of it.
    if (!this._areas) {
      this._areas = new Float32Array(tris);
      let total = 0;
      for (let t = 0; t < tris; t++) {
        _a.fromBufferAttribute(pos, index.getX(t * 3));
        _b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
        _c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
        total += _b.sub(_a).cross(_c.sub(_a)).length();
        this._areas[t] = total;
      }
    }
    const areas = this._areas, total = areas[tris - 1];

    const scale = this.flossScale ?? 1;
    const down = amount < 0.02 ? 0 : Math.round((2500 + 9000 * amount) * scale); // a nap of very short hairs: the soft outline
    const frizz = amount < 0.02 ? 0 : Math.round((400 + 2600 * amount) * scale); // longer ones that curl off and back, or stand off
    const fibres = [];
    for (let k = 0; k < down + frizz; k++) {
      const target = rng() * total;
      let lo = 0, hi = tris - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (areas[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const i0 = index.getX(lo * 3), i1 = index.getX(lo * 3 + 1), i2 = index.getX(lo * 3 + 2);
      let u = rng(), v = rng();
      if (u + v > 1) (u = 1 - u), (v = 1 - v);
      const w = 1 - u - v;
      const at = (attr, out) => out.fromBufferAttribute(attr, i0).multiplyScalar(w).addScaledVector(_c.fromBufferAttribute(attr, i1), u).addScaledVector(_c.fromBufferAttribute(attr, i2), v);
      at(pos, _a);
      at(smooth, _n).normalize();
      // It moves with the nearest corner of its triangle.
      const bone = w >= u && w >= v ? i0 : u >= v ? i1 : i2;
      _t.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).addScaledVector(_n, -_t.dot(_n)).normalize();
      _u.crossVectors(_n, _t);

      const short = k < down;
      const n = short ? 3 : 5 + Math.floor(24 * rng() ** 3);
      const free = short || rng() < 0.55;
      const reach = short ? 0.004 + 0.02 * rng() ** 2 : free ? 0.01 + 0.08 * rng() ** 2 : 0.004 + 0.04 * rng() ** 3;
      const step = short ? 0.003 + 0.006 * rng() : 0.006 + 0.012 * rng();
      const points = new Float32Array((n + 1) * 3);
      let heading = rng() * 6.28, curl = (rng() - 0.5) * 1.5, along = 0, across = 0;
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        // Out by its reach (and back, for the ones that land again), drooping a little, wandering over the skin.
        const lift = free ? reach * s ** 0.7 : reach * Math.sin(Math.PI * s);
        points.set([_a.x + _n.x * lift + _t.x * along + _u.x * across, _a.y + _n.y * lift + _t.y * along + _u.y * across - (free ? 0.3 * reach * s * s : 0), _a.z + _n.z * lift + _t.z * along + _u.z * across], i * 3);
        along += Math.cos(heading) * step;
        across += Math.sin(heading) * step;
        heading += curl;
        curl = curl * 0.8 + (rng() - 0.5) * 1.2 + (rng() < 0.06 ? (rng() - 0.5) * 4 : 0);
      }
      fibres.push({ points, root: [_n.x, _n.y, _n.z], bone, free, short, when: patchWhen(_a.x, _a.y, _a.z, height), y: _a.y / height, width: short ? 0.0007 + 0.0007 * rng() : 0.001 + 0.0014 * rng(), opacity: short ? 0.25 + 0.4 * rng() : 0.3 + 0.6 * rng(), late: 0.35 + 0.6 * rng() });
    }

    // Each fibre a three-sided tube, drawn out to nothing at its ends.
    let count = 0, segments = 0;
    for (const f of fibres) {
      count += f.points.length / 3;
      segments += f.points.length / 3 - 1;
    }
    const size = Math.max(1, count * SIDES);
    const positions = new Float32Array(size * 3), normals = new Float32Array(size * 3), tangents = new Float32Array(size * 3), roots = new Float32Array(size * 3);
    const uvs = new Float32Array(size * 2), looks = new Float32Array(size * 3), whens = new Float32Array(size);
    const bones = new Uint16Array(size * 4), weights = new Float32Array(size * 4);
    const indices = new Uint32Array(segments * SIDES * 6);
    let vi = 0, wi = 0;
    for (const f of fibres) {
      const P = f.points, n = P.length / 3;
      const bi = [skinIndex.getX(f.bone), skinIndex.getY(f.bone), skinIndex.getZ(f.bone), skinIndex.getW(f.bone)];
      const bw = [skinWeight.getX(f.bone), skinWeight.getY(f.bone), skinWeight.getZ(f.bone), skinWeight.getW(f.bone)];
      for (let i = 0; i < n; i++) {
        const p = Math.max(0, i - 1) * 3, q = Math.min(n - 1, i + 1) * 3, o = i * 3, s = i / (n - 1);
        _t.set(P[q] - P[p], P[q + 1] - P[p + 1], P[q + 2] - P[p + 2]).normalize();
        _n.set(f.root[0], f.root[1], f.root[2]).addScaledVector(_t, -(f.root[0] * _t.x + f.root[1] * _t.y + f.root[2] * _t.z));
        if (_n.lengthSq() < 1e-8) _n.set(_t.y, _t.z, _t.x).addScaledVector(_t, -(_t.y * _t.x + _t.z * _t.y + _t.x * _t.z));
        _n.normalize();
        _b.crossVectors(_t, _n);
        const half = f.width * 0.5 * Math.max(0.3, Math.sqrt(Math.min(1, 6 * s, 6 * (1 - s))));
        for (let k = 0; k < SIDES; k++) {
          const a = (k / SIDES) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const nx = _n.x * ca + _b.x * sa, ny = _n.y * ca + _b.y * sa, nz = _n.z * ca + _b.z * sa;
          positions.set([P[o] + nx * half, P[o + 1] + ny * half, P[o + 2] + nz * half], vi * 3);
          normals.set([nx, ny, nz], vi * 3);
          tangents.set([_t.x, _t.y, _t.z], vi * 3);
          roots.set(f.root, vi * 3);
          uvs.set([f.y, s], vi * 2);
          // (The last: how much of the body's lag it takes. A free end all of it, a nap hair little, a loop its middle.)
          looks.set([f.opacity, f.late, f.short ? 0.25 * s * s : f.free ? s ** 1.5 : 0.5 * Math.sin(Math.PI * s)], vi * 3);
          whens[vi] = f.when;
          bones.set(bi, vi * 4);
          weights.set(bw, vi * 4);
          if (i < n - 1) {
            const b2 = vi - k + ((k + 1) % SIDES), c2 = vi + SIDES, d2 = b2 + SIDES;
            indices[wi++] = vi; indices[wi++] = b2; indices[wi++] = c2;
            indices[wi++] = b2; indices[wi++] = d2; indices[wi++] = c2;
          }
          vi++;
        }
      }
    }
    this.floss.geometry.dispose();
    const geometry = (this.floss.geometry = new BufferGeometry());
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setAttribute("aTangent", new BufferAttribute(tangents, 3));
    geometry.setAttribute("aRoot", new BufferAttribute(roots, 3));
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    geometry.setAttribute("aFibre", new BufferAttribute(looks, 3));
    geometry.setAttribute("aWhen", new BufferAttribute(whens, 1));
    geometry.setAttribute("skinIndex", new BufferAttribute(bones, 4));
    geometry.setAttribute("skinWeight", new BufferAttribute(weights, 4));
    geometry.setIndex(new BufferAttribute(indices, 1));
    this.hasFloss = fibres.length > 0;
  }
}

// A clip stored as raw floats (name.bin: times, then the hips' positions, then a quaternion track per bone) with
// name.json saying how many frames and which bones.
async function loadClip(url, name) {
  const [meta, data] = await Promise.all([fetch(`${url}.json`).then((r) => r.json()), fetch(`${url}.bin`).then((r) => r.arrayBuffer())]);
  const f = meta.frames, all = new Float32Array(data);
  const times = all.slice(0, f);
  const tracks = [new VectorKeyframeTrack(`${meta.hips}.position`, times, all.slice(f, f * 4))];
  meta.bones.forEach((bone, i) => tracks.push(new QuaternionKeyframeTrack(`${bone}.quaternion`, times, all.slice(f * 4 * (i + 1), f * 4 * (i + 2)))));
  return new AnimationClip(name, -1, tracks);
}

// url: the glTF; clips: { name: url without extension } of extra clips for its skeleton.
export async function loadFigure(url, clips = {}) {
  const [gltf, ...extra] = await Promise.all([new GLTFLoader().loadAsync(url), ...Object.entries(clips).map(([name, at]) => loadClip(at, name))]);
  return new Figure(gltf, extra);
}
