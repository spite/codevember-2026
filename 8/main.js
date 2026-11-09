import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, randomize, keysHelp, setDay, showHint, applyUrlState, loadingStep } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, MeshBasicMaterial, BufferGeometry, BufferAttribute, DynamicDrawUsage, SphereGeometry, BackSide, MOUSE, TOUCH, Vector3, Matrix4, Quaternion, DoubleSide, DataTexture, FloatType, RGBAFormat, NearestFilter } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { makeSculpture, solidPlanes, prebuild, morphPlanes, facesOf, edgesOf, polygonArea, uniqueVerts, MAX_FACES } from "./sculpture.js";
import { InfinityPass } from "./infinity.js";

// Convex solids with up to 64 faces (MAX_FACES).
const SOLIDS = [
  "icosahedron",
  "dodecahedron",
  "octahedron",
  "cube",
  "tetrahedron",
  "cuboctahedron",
  "icosidodecahedron",
  "truncatedTetrahedron",
  "truncatedOctahedron",
  "truncatedCube",
  "truncatedIcosahedron",
  "truncatedDodecahedron",
  "truncatedCuboctahedron",
  "truncatedIcosidodecahedron",
  "rhombicuboctahedron",
  "rhombicosidodecahedron",
  "snubCube",
  "rhombicDodecahedron",
  "rhombicTriacontahedron",
  "triakisTetrahedron",
  "triakisOctahedron",
  "tetrakisHexahedron",
  "deltoidalIcositetrahedron",
  "pentagonalIcositetrahedron",
  "disdyakisDodecahedron",
  "triakisIcosahedron",
  "pentakisDodecahedron",
  "deltoidalHexecontahedron",
  "pentagonalHexecontahedron",
  "triangular prism",
  "pentagonal prism",
  "hexagonal prism",
  "octagonal prism",
  "square antiprism",
  "pentagonal antiprism",
  "hexagonal antiprism",
  "octagonal antiprism",
  "triangular bipyramid",
  "pentagonal bipyramid",
  "hexagonal bipyramid",
];
prebuild(SOLIDS);
// LED colours, at about equal brightness; the first one is used alone.
const LIGHTS = {
  white: [[1, 1.06, 1.02]],
  "warm white": [[1.15, 0.98, 0.78]],
  "cool white": [[0.9, 1.02, 1.15]],
  rgb: [[1.5, 0.2, 0.2], [0.25, 1.15, 0.3], [0.3, 0.45, 1.7]],
  sunset: [[1.5, 0.25, 0.6], [1.4, 0.6, 0.15], [1.2, 0.9, 0.4]],
  ocean: [[0.2, 0.9, 1.3], [0.3, 0.45, 1.6], [0.7, 1.0, 1.1]],
  neon: [[1.4, 0.2, 1.1], [0.2, 1.1, 1.2]],
  aurora: [[0.3, 1.2, 0.6], [0.2, 0.9, 1.1], [0.9, 0.35, 1.3]],
  fire: [[1.6, 0.25, 0.08], [1.4, 0.6, 0.12], [1.2, 1.0, 0.45]],
  "white & red": [[1, 1.06, 1.02], [1.6, 0.15, 0.12]],
};
const TUBES = { frosted: 0, "LED pixels": 1, neon: 2, filament: 3 };
const ANIMATIONS = ["none", "breathe", "wave", "scan", "sequence", "flicker", "chase"];
const GLASSES = { mirror: 0, dichroic: 1, smoked: 2, cracked: 3, open: 4 };
const INNERS = ["none", "tesseract", "same", "tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron", "cuboctahedron"];
const PATTERNS = { solid: 0, "per window": 1, "per tube": 2, segments: 3, gradient: 4 };

const CENTER_Y = 1.15;
const FLOOR_Y = -0.55;
const WALL_Z = -2.7;

const defaults = {
  solid: "cube",
  rim: 0.005,
  brightness: 1,
  mirror: 0.82,
  window: 0.25,
  warp: 0.2,
  ripple: 0.1,
  tilt: 0.15,
  uneven: 0.25,
  lights: "white",
  dark: 0,
  nodes: true,
  glass: "mirror",
  amount: 0.4,
  inner: "tesseract",
  innerSize: 0.5,
  innerSpin: 0.3,
  pattern: "solid",
  segments: 4,
  gap: 0.1,
  bounces: 14,
  room: "sphere",
  shadows: 0.1,
  tubes: "frosted",
  aperture: 0,
  focus: 0,
  haze: 0.75,
  gloss: 0.5,
  animation: "none",
  speed: 0.5,
  spill: 1,
  spin: 0.25,
  auto: true,
  autoTime: 20,
};
const params = fromDefaults(defaults);
const touch = matchMedia("(pointer: coarse)").matches;
const load = { studio: loadingStep(1), compile: loadingStep(3), trace: loadingStep(5) };

const pipeline = new Pipeline(renderer, {
  background: 0x070808,
  exposure: 1.0,
  bloomStrength: 0.07,
  bloomRadius: 0.5,
  vignette: 0.5,
  grain: 0.025,
  stillSamples: 32,
  depthOfField: { aperture: 0, maxBlur: 0.025, lensSamples: 48 },
  shadow: { autoFit: true, denoise: true },
  // The room is two flat planes.
  giOptions: { skipFlat: true },
  composite: (hdr, ctx) => infinity.render(renderer, hdr, ctx),
});

const fullQuality = pipeline.quality === "high" || pipeline.quality === "capture";
// Bounce caps per tier, for most solids and for the dense ones.
const BOUNCE_CAP = { low: [8, 6], medium: [12, 8] }[pipeline.quality] ?? [48, 10];
const infinity = new InfinityPass({ dirSize: fullQuality ? 512 : 256 });
infinity.dof = pipeline.dof;
infinity.dofOn = () => pipeline.dofEnabled;
// Solids with more faces than this get no extra rays and fewer bounces.
const DENSE = 30;

// A dim room: the sculpture is the light.
const studio = load.studio.track(createStudioEnvironmentAsync(renderer, {
  keyDirection: new Vector3(-0.3, 1.0, 0.2),
  keyIntensity: 0.16,
  keySize: 0.9,
  fill: 0.02,
  floor: 0.03,
  wall: 0.04,
  ceiling: 0.01,
  tint: 0xe9f2ee,
}));
globalUniforms.giIntensity.value = 1;
globalUniforms.aoIntensity.value = 1;

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
const section = { shape: gui.addSection("Shape"), light: gui.addSection("Lighting"), glass: gui.addSection("Surface"), room: gui.addSection("Room"), camera: gui.addSection("Camera") };
// Controls go in in their original order, which is the order randomize draws them in, so seeds keep their looks.
gui.into(section.shape);
gui.addSelect("Solid", params.solid, SOLIDS);
// Randomizing keeps the rim moderate: wide rims close the narrow windows of some solids.
gui.addSlider("Rim", params.rim, 0.005, 0.2, 0.005).randomize = () => params.rim.set(Math.round((0.03 + Math.random() * 0.09) * 200) / 200);
gui.into(section.light);
gui.addSlider("Brightness", params.brightness, 0.3, 2, 0.01);
gui.addSelect("Lights", params.lights, Object.keys(LIGHTS));
gui.addSelect("Tubes", params.tubes, Object.keys(TUBES));
gui.addSelect("Pattern", params.pattern, Object.keys(PATTERNS));
gui.addSlider("Segments", params.segments, 2, 12, 1, { visibleWhen: () => params.pattern() === "segments" });
gui.addSlider("Gaps", params.gap, 0, 0.5, 0.01, { visibleWhen: () => params.pattern() === "segments" });
// Randomizing leaves every window lit half the time, and otherwise only a few dark.
gui.addSlider("Dark windows", params.dark, 0, 0.8, 0.01).randomize = () => {
  const r = Math.random();
  params.dark.set(r < 0.5 ? 0 : Math.round((0.1 + (r - 0.5) * 0.7) * 100) / 100);
};
gui.addSelect("Animation", params.animation, ANIMATIONS);
gui.addSlider("Speed", params.speed, 0.05, 2, 0.01, { visibleWhen: () => params.animation() !== "none", randomizable: false });
gui.into(section.shape);
gui.addCheckbox("Nodes", params.nodes);
gui.into(section.glass);
gui.addSelect("Glass", params.glass, Object.keys(GLASSES));
gui.addSlider("Amount", params.amount, 0, 1, 0.01, { visibleWhen: () => params.glass() !== "mirror" });
gui.into(section.shape);
gui.addSelect("Inside", params.inner, INNERS);
gui.addSlider("Inside size", params.innerSize, 0.25, 0.6, 0.01, { visibleWhen: () => params.inner() !== "none" });
gui.addSlider("Inside spin", params.innerSpin, 0, 1, 0.01, { visibleWhen: () => params.inner() !== "none" && params.inner() !== "tesseract", randomizable: false });
gui.into(section.glass);
gui.addSlider("Inner mirror", params.mirror, 0.6, 0.97, 0.01);
gui.addSlider("See-through", params.window, 0.1, 0.8, 0.01);
gui.addSlider("Warp", params.warp, 0, 1, 0.01);
gui.addSlider("Ripple", params.ripple, 0, 1, 0.01);
gui.addSlider("Tilt", params.tilt, 0, 1, 0.01);
gui.addSlider("Uneven", params.uneven, 0, 1, 0.01);
gui.addSlider("Bounces", params.bounces, 2, 48, 1, { randomizable: false });
gui.into(section.room);
gui.addSelect("Room", params.room, ["sphere", "gallery"], { randomizable: false });
gui.addSlider("Haze", params.haze, 0, 1, 0.01);
gui.addSlider("Floor gloss", params.gloss, 0, 1, 0.01, { visibleWhen: () => params.room() === "gallery" });
gui.addSlider("Room light", params.spill, 0, 3, 0.01, { randomizable: false });
gui.addSlider("Shadow sharpness", params.shadows, 0, 1, 0.01);
gui.into(section.camera);
gui.addSlider("Aperture", params.aperture, 0, 0.03, 0.001, { randomizable: false });
// Focus: how far in front of (-) or behind (+) the sculpture's centre, in sculpture radii.
gui.addSlider("Focus", params.focus, -1.5, 1.5, 0.01, { randomizable: false, visibleWhen: () => params.aperture() > 0 });
gui.into(section.shape);
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
gui.endSection();
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => morph.t >= 1 });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(
  touch
    ? "<p>Drag to turn the sculpture, two fingers to move around it and zoom, tap a window to switch its light.</p>"
    : `<p>Drag to turn the sculpture, right-drag to move around it, scroll to zoom, click a window to switch its light.</p>${keysHelp()}`,
);
showHint("Drag to turn · right-drag to orbit · click a window · R for another", "Drag to turn · two fingers to orbit · tap {randomize} for another");
gui.show();
// Floating free: each new one turns up at its own angle.
// It eases from the old angle to the new one over the morph.
const tumble = new Quaternion(), tumbleFrom = new Quaternion(), tumbleTo = new Quaternion();
// A new one is another solid at its own angle, with its own glass flaws, haze and room light.
onRandomize(() => {
  clicked.clear();
  const r = Math.random;
  const others = SOLIDS.filter((n) => n !== params.solid());
  params.solid.set(others[Math.floor(r() * others.length)]);
  tumbleFrom.copy(tumble);
  tumbleTo.setFromAxisAngle(new Vector3(r() - 0.5, 0, r() - 0.5).normalize(), r() * 0.6);
  const range = (a, b) => Math.round((a + r() * (b - a)) * 100) / 100;
  // Mostly empty inside; now and then a nested solid, which grows in.
  const kinds = INNERS.filter((n) => n !== "none");
  params.inner.set(r() < 0.2 ? kinds[Math.floor(r() * kinds.length)] : "none");
  // White light half the time, as most of the real pieces are; colours otherwise.
  const lights = Object.keys(LIGHTS);
  tween.paletteFrom = shownColors;
  params.lights.set(r() < 0.5 ? lights[Math.floor(r() * 3)] : lights[3 + Math.floor(r() * (lights.length - 3))]);
  const look = { brightness: range(0.7, 1.5), mirror: range(0.6, 0.8), warp: range(0, 0.2), ripple: range(0, 0.2), tilt: range(0, 0.2), haze: range(0.5, 1), spill: range(0.75, 2) };
  // On load they apply at once; later they ease in alongside the morph.
  tween.t = shown ? 0 : 1;
  tween.last = {};
  for (const [key, value] of Object.entries(look)) {
    tween.from[key] = params[key]();
    tween.to[key] = value;
    if (!shown) params[key].set(value);
  }
});
const tween = { from: {}, to: {}, last: {}, t: 1 };
function updateTween(dt) {
  if (tween.t >= 1) return;
  tween.t = Math.min(1, tween.t + dt / MORPH_TIME);
  const e = ease(tween.t);
  if (tween.paletteFrom) {
    updateLight();
    if (tween.t >= 1) tween.paletteFrom = null;
  }
  for (const key in tween.to) {
    // A slider moved by hand mid-way keeps its value.
    if (key in tween.last && params[key]() !== tween.last[key]) {
      delete tween.to[key];
      continue;
    }
    tween.last[key] = tween.t < 1 ? tween.from[key] + (tween.to[key] - tween.from[key]) * e : tween.to[key];
    params[key].set(tween.last[key]);
  }
}

// ---------------------------------------------------------------- scene

const scene = new Scene();

// The sculpture lights the room through its windows: each window facing a point is a uniform polygon light,
// integrated exactly (Heitz's edge integral). The bars between windows cast their soft shadows by themselves.
const MAX_WIN = 32;
// Per face: texel 0 (normal, window corner count), 1..count the corners, MAX_WIN + 1 (plane d, window radius),
// MAX_WIN + 2 (window centre, area). Window lights are in
// infinity.faceTexture, and the face each direction from the centre leaves through in infinity's direction map.
const windowTexture = new DataTexture(new Float32Array(MAX_FACES * (MAX_WIN + 3) * 4), MAX_WIN + 3, MAX_FACES, RGBAFormat, FloatType);
windowTexture.minFilter = windowTexture.magFilter = NearestFilter;
const glow = {
  glowCenter: { value: new Vector3() },
  glowRot: infinity.material.uniforms.sculptRot,
  glowColor: { value: new Vector3() },
  glowWindows: { value: windowTexture },
  glowWindowCount: { value: 0 },
  glowSharp: { value: 0.5 },
  glowGobo: { value: 1 },
  glowFaces: { value: infinity.faceTexture },
  glowDirs: { value: infinity.dirTarget.texture },
  glowDirSize: infinity.material.uniforms.dirSize,
};
// Solid angle of a polygon seen from the origin (a fan of Van Oosterom-Strackee triangles).
function solidAngle(poly) {
  let sum = 0;
  const a = poly[0], la = a.length();
  for (let k = 1; k + 1 < poly.length; k++) {
    const b = poly[k], c = poly[k + 1], lb = b.length(), lc = c.length();
    const num = Math.abs(a.dot(_v.crossVectors(b, c)));
    sum += 2 * Math.atan2(num, la * lb * lc + a.dot(b) * lc + a.dot(c) * lb + b.dot(c) * la);
  }
  return sum;
}
const _v = new Vector3();
// The windows' shapes, once per build.
function writeWindows(s) {
  const data = windowTexture.image.data;
  s.omega ??= s.windows.map((w) => (w.length < 3 ? 0 : solidAngle(w)));
  s.area ??= s.windows.map((w) => (w.length < 3 ? 0 : polygonArea(w)));
  s.faces.forEach((f, i) => {
    const w = s.windows[i];
    const k = w.length < 3 ? 0 : Math.min(w.length, MAX_WIN), row = i * (MAX_WIN + 3) * 4;
    f.n.toArray(data, row);
    data[row + 3] = k;
    for (let j = 0; j < k; j++) {
      w[j].toArray(data, row + (j + 1) * 4);
      data[row + (j + 1) * 4 + 3] = 0;
    }
    data[row + (MAX_WIN + 1) * 4] = f.d;
    // Centre and radius, for treating the window as a point from far enough away.
    _c.set(0, 0, 0);
    for (let j = 0; j < k; j++) _c.add(w[j]);
    if (k) _c.divideScalar(k);
    let radius = 0;
    for (let j = 0; j < k; j++) radius = Math.max(radius, _c.distanceTo(w[j]));
    data[row + (MAX_WIN + 1) * 4 + 1] = radius;
    _c.toArray(data, row + (MAX_WIN + 2) * 4);
    data[row + (MAX_WIN + 2) * 4 + 3] = s.area[i];
  });
  windowTexture.needsUpdate = true;
  glow.glowWindowCount.value = s.faces.length;
}
// The soft light runs per vertex (the room's meshes are dense where it changes); the sharp one per pixel.
const glowSoftPars = /* glsl */ `
uniform vec3 glowCenter;
uniform mat3 glowRot;
uniform highp sampler2D glowWindows;
uniform int glowWindowCount;
uniform float glowSharp;
uniform highp sampler2D glowFaces;
vec3 edgeVec(vec3 a, vec3 b) {
  float x = dot(a, b), y = abs(x);
  float v = (0.8543985 + (0.4965155 + 0.0145206 * y) * y) / (3.4175940 + (4.1616724 + y) * y);
  return cross(a, b) * (x > 0.0 ? v : 0.5 * inversesqrt(max(1.0 - x * x, 1e-7)) - v);
}
// Form factor of the windows facing P (the convex solid hides the others). Windows far away for their size count as
// points; near ones are integrated exactly.
float windowFormFactor(vec3 P, vec3 N) {
  mat3 toLocal = transpose(glowRot);
  vec3 p = toLocal * (P - glowCenter), n = toLocal * N;
  float F = 0.0;
  for (int f = 0; f < ${MAX_FACES}; f++) {
    if (f >= glowWindowCount) break;
    vec4 h = texelFetch(glowWindows, ivec2(0, f), 0);
    if (h.w < 3.0) continue;
    float lit = texelFetch(glowFaces, ivec2(f, 0), 0).z;
    if (lit <= 0.0) continue;
    vec4 cA = texelFetch(glowWindows, ivec2(${MAX_WIN + 2}, f), 0);
    float R = texelFetch(glowWindows, ivec2(${MAX_WIN + 1}, f), 0).y;
    vec3 L = cA.xyz - p;
    float r2 = dot(L, L);
    float far = smoothstep(16.0, 36.0, r2 / max(R * R, 1e-8));
    float Fp = 0.0, Fe = 0.0;
    if (far > 0.0) {
      vec3 l = L * inversesqrt(r2);
      // In the same units as the edge integral below, which the room's brightness was set by.
      Fp = cA.w * abs(dot(n, l)) * max(-dot(h.xyz, l), 0.0) / (3.14159265 * r2) * 0.15915494;
    }
    if (far < 1.0) {
      vec3 v0 = texelFetch(glowWindows, ivec2(1, f), 0).xyz;
      if (dot(h.xyz, p - v0) > 0.0) {
        int count = int(h.w);
        vec3 first = normalize(v0 - p), a = first, sum = vec3(0.0);
        for (int k = 1; k < ${MAX_WIN}; k++) {
          if (k >= count) break;
          vec3 b = normalize(texelFetch(glowWindows, ivec2(k + 1, f), 0).xyz - p);
          sum += edgeVec(a, b);
          a = b;
        }
        sum += edgeVec(a, first);
        Fe = abs(dot(sum, n)) * 0.15915494;
      }
    }
    F += mix(Fe, Fp, far) * lit;
  }
  return F;
}

`;
const glowPars = /* glsl */ `
uniform vec3 glowColor;
uniform float roomSpecular;
uniform float glowGobo;
uniform highp sampler2D glowDirs;
uniform float glowDirSize;
// The same light as if it all came from the centre through the windows: their shapes, and the bars' shadows,
// cast sharply on the room.
float windowGobo(vec3 P, vec3 N) {
  mat3 toLocal = transpose(glowRot);
  vec3 p = toLocal * (P - glowCenter), n = toLocal * N;
  float r = length(p);
  vec3 u = p / r;
  // The face u leaves through, from the tracer's octahedral direction map.
  vec3 o = u / (abs(u.x) + abs(u.y) + abs(u.z));
  if (o.z < 0.0) o.xy = (1.0 - abs(o.yx)) * vec2(o.x >= 0.0 ? 1.0 : -1.0, o.y >= 0.0 ? 1.0 : -1.0);
  vec2 octUv = o.xy * 0.5 + 0.5;
  int face = int(floor(texelFetch(glowDirs, ivec2(min(octUv * glowDirSize, vec2(glowDirSize - 1.0))), 0).g + 0.5));
  if (face < 0 || face >= glowWindowCount) return 0.0;
  vec4 h = texelFetch(glowWindows, ivec2(0, face), 0);
  int count = int(h.w);
  float dn = dot(h.xyz, u);
  if (count < 3 || dn <= 1e-4) return 0.0;
  vec3 q = u * (texelFetch(glowWindows, ivec2(${MAX_WIN + 1}, face), 0).x / dn);
  // Signed distance inside the window polygon, whatever its winding.
  vec3 a0 = texelFetch(glowWindows, ivec2(1, face), 0).xyz;
  vec3 a1 = texelFetch(glowWindows, ivec2(2, face), 0).xyz;
  vec3 a2 = texelFetch(glowWindows, ivec2(3, face), 0).xyz;
  float wind = sign(dot(cross(a1 - a0, a2 - a0), h.xyz));
  float m = 1e9;
  vec3 a = a0;
  for (int k = 1; k <= ${MAX_WIN}; k++) {
    if (k > count) break;
    vec3 b = k == count ? a0 : texelFetch(glowWindows, ivec2(k + 1, face), 0).xyz;
    vec3 e = b - a;
    m = min(m, wind * dot(cross(e, q - a), h.xyz) / max(length(e), 1e-6));
    a = b;
  }
  float lit = texelFetch(glowFaces, ivec2(face, 0), 0).z;
  return glowGobo * lit * smoothstep(-0.015, 0.015, m) * max(dot(n, -u), 0.0) / (r * r);
}
`;
const glowSurface = /* glsl */ `
void surface(inout Surface s) {
  s.specular = roomSpecular;
  vec3 N = normalize(s.normal);
  float spread = vSoft;
  float sharp = glowSharp > 0.0 ? windowGobo(vWorldPosition, N) : 0.0;
  s.emissive += s.albedo * glowColor * mix(spread, sharp, glowSharp);
}
`;
const glowVertex = /* glsl */ `
#if !defined(PIPELINE_PREPASS) && !defined(PIPELINE_SHADOW)
  vSoft = glowSharp < 1.0 ? windowFormFactor(vWorldPosition, vWorldNormal) : 0.0;
#else
  vSoft = 0.0;
#endif
`;
const roomMaterial = (color, roughness, specular) =>
  new PipelineMaterial({
    color,
    roughness,
    uniforms: { ...glow, roomSpecular: { value: specular } },
    vertexPars: glowSoftPars,
    vertexMain: glowVertex,
    varyings: { vSoft: "float" },
    fragmentPars: glowSoftPars + glowPars,
    surface: glowSurface,
  });

// A plane with its vertices bunched around (cx, cy), where the windows' soft light changes fastest.
function focusedPlane(width, height, cx, cy, segments) {
  const axis = (size, c) => {
    const out = [];
    for (let i = -segments; i <= segments; i++) {
      const u = i / segments;
      out.push(c + (u < 0 ? c + size / 2 : size / 2 - c) * u * u * u);
    }
    return out;
  };
  const xs = axis(width, cx), ys = axis(height, cy), n = xs.length;
  const position = new Float32Array(n * n * 3), normal = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      position.set([xs[i], ys[j], 0], k * 3);
      normal[k * 3 + 2] = 1;
      uv.set([xs[i] / width + 0.5, ys[j] / height + 0.5], k * 2);
    }
  const index = [];
  for (let j = 0; j + 1 < n; j++)
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i;
      index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(position, 3));
  g.setAttribute("normal", new BufferAttribute(normal, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

// Gallery: a floor and a back wall, far wider than any view. Sphere: a matte dome all around, which catches the
// light of every window.
const floor = new Mesh(focusedPlane(400, 400, 0, 0, 120).rotateX(-Math.PI / 2), roomMaterial(0xd0d4d1, 0.78, 0.5));
floor.position.y = FLOOR_Y;
const wall = new Mesh(focusedPlane(400, 200, 0, CENTER_Y - FLOOR_Y - 100, 120), roomMaterial(0x6b7070, 0.92, 1));
wall.position.set(0, FLOOR_Y + 100, WALL_Z);
const DOME_RADIUS = 7.5;
const domeMaterial = roomMaterial(0xd6d9d7, 0.9, 0.3);
domeMaterial.side = BackSide;
const dome = new Mesh(new SphereGeometry(DOME_RADIUS, 160, 96), domeMaterial);
dome.position.y = CENTER_Y;
scene.add(floor, wall, dome);

function setRoom() {
  const sphere = params.room() === "sphere";
  dome.visible = sphere;
  floor.visible = wall.visible = !sphere;
  // Inside the dome the camera goes all the way round, but stays inside.
  controls.maxDistance = sphere ? DOME_RADIUS * 0.85 : 9;
  controls.minPolarAngle = sphere ? 0.05 : 0;
  controls.maxPolarAngle = sphere ? Math.PI - 0.05 : 1.65;
  controls.target.y = sphere ? CENTER_Y : 0.95;
  pipeline.restartAccumulation();
}

// The frame: painted steel. Its window walls catch the tubes right beside them.
const rimVarying = { vertexPars: "in float rim;", varyings: { vRim: "float" }, vertexMain: "vRim = rim;" };
const frameMaterial = new PipelineMaterial({
  color: 0x1c1d1e,
  roughness: 0.42,
  ...rimVarying,
  uniforms: { frameCenter: glow.glowCenter },
  fragmentPars: "uniform vec3 frameCenter;",
  surface: `void surface(inout Surface s) {
    // A rounded outer edge: near the ridge the normal turns towards the neighbouring face.
    float e = smoothstep(0.1, 0.0, vRim);
    s.normal = normalize(mix(s.normal, normalize(vWorldPosition - frameCenter), 0.65 * e));
    s.roughness = mix(s.roughness, 0.3, e);
  }`,
});
const wallMaterial = new PipelineMaterial({
  color: 0x1c1d1e,
  roughness: 0.5,
  side: DoubleSide,
  ...rimVarying,
  uniforms: { tubeLight: { value: new Vector3() } },
  fragmentPars: "uniform vec3 tubeLight;",
  // Lit by the tube right below the glass, falling off towards the lip.
  surface: "void surface(inout Surface s) { s.emissive += tubeLight * mix(1.0, 0.25, vRim); }",
});
const frame = new Mesh(new BufferGeometry(), frameMaterial);
const walls = new Mesh(new BufferGeometry(), wallMaterial);
frame.castShadow = walls.castShadow = true;
scene.add(frame, walls);

let sculpture = null;
const pose = new Quaternion();
let spinAngle = 0;

// The solid on show, as planes and vertices; a change of solid morphs from it to the next.
let shown = null;
const morph = { from: null, to: null, t: 1 };
const MORPH_TIME = 2.2;

// Depth of field reads the prepass depth, where the traced inside is not: give it the solid's.
const proxy = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ colorWrite: false }));
const proxyScene = new Scene();
proxyScene.add(proxy);
infinity.afterTrace = (r, cam) => {
  if (!pipeline.dofEnabled || !(pipeline.dof?.aperture > 0) || !pipeline.prepassTarget) return;
  r.setRenderTarget(pipeline.prepassTarget);
  r.render(proxyScene, cam);
};

// Writes { name: [array, itemSize] } into a mesh's geometry, reusing its buffers while they are big enough.
function fillGeometry(mesh, attrs) {
  const entries = Object.entries(attrs);
  const n = entries[0][1][0].length / entries[0][1][1];
  let g = mesh.geometry;
  if (!g.attributes.position || g.attributes.position.count < n) {
    g.dispose();
    g = mesh.geometry = new BufferGeometry();
    const capacity = Math.ceil(n * 1.25) + 96;
    for (const [name, [, size]] of entries) g.setAttribute(name, new BufferAttribute(new Float32Array(capacity * size), size).setUsage(DynamicDrawUsage));
    g.userData.used = 0;
  }
  const used = g.userData.used;
  for (const [name, [array, size]] of entries) {
    const attr = g.attributes[name];
    attr.array.set(array);
    if (used > n) attr.array.fill(0, array.length, used * size);
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(used, n) * size);
    attr.needsUpdate = true;
  }
  g.userData.used = n;
  g.setDrawRange(0, n);
  g.boundingSphere = g.boundingBox = null;
}

// The proxy's hull, only while depth of field needs it.
let proxyOf = null;
function updateProxy() {
  if (!(params.aperture() > 0) || proxyOf === sculpture) return;
  proxyOf = sculpture;
  let count = 0;
  for (const f of sculpture.faces) count += 9 * (f.poly.length - 2);
  const hull = new Float32Array(count);
  let k = 0;
  for (const f of sculpture.faces)
    for (let j = 1; j + 1 < f.poly.length; j++) {
      f.poly[0].toArray(hull, k);
      f.poly[j].toArray(hull, k + 3);
      f.poly[j + 1].toArray(hull, k + 6);
      k += 9;
    }
  fillGeometry(proxy, { position: [hull, 3] });
}

function build(planes) {
  const prev = sculpture;
  sculpture = makeSculpture(planes, { rim: params.rim() });
  faceKeys = sculpture.faces.map((f) => faceKey(f.n));
  if (prev) carryWindows(prev.faces, sculpture.faces);
  const { band, walls: wallArrays } = sculpture.frame;
  fillGeometry(frame, { position: [band.position, 3], normal: [band.normal, 3], rim: [band.rim, 1] });
  fillGeometry(walls, { position: [wallArrays.position, 3], normal: [wallArrays.normal, 3], rim: [wallArrays.rim, 1] });
  updateProxy();
  infinity.setSculpture(sculpture);
  const u = infinity.material.uniforms;
  u.nodeRadius.value = params.nodes() ? 1.7 * sculpture.tube.radius : 0;
  // Pixels whose path goes deep get two more rays, at full quality and on the sparser solids.
  const faces = morph.t < 1 ? Math.max(morph.from.planes.length, morph.to.planes.length) : sculpture.faces.length;
  u.deepStart.value = fullQuality && faces <= DENSE ? 3 : 99;
  writeWindows(sculpture);
  frame.position.set(0, CENTER_Y, 0);
  walls.position.copy(frame.position);
  // Only the planes that make faces, so interrupted morphs don't pile up planes.
  shown = { planes: sculpture.faces.map((f) => ({ n: f.n, d: f.d })), verts: uniqueVerts(sculpture.faces) };
  if (innerType === "tesseract") {
    setInner();
    updateInner(0);
  }
  updateLight();
}

function setSculpture(animate) {
  const target = solidPlanes(params.solid());
  const morphing = animate && shown;
  if (morphing) {
    morph.from = shown;
    morph.to = target;
    morph.t = 0;
  } else {
    morph.t = 1;
    build(target.planes);
  }
  setWindowsLit();
  // A fresh build starts with its dark windows already dark.
  if (!morphing) {
    infinity.faceLight.set(lightTarget);
    infinity.writeLights();
    updateLit();
  }
  pipeline.restartAccumulation(false);
}

const ease = (x) => x * x * (3 - 2 * x);
// Returns true while morphing.
function updateMorph(dt) {
  if (morph.t >= 1) return false;
  morph.t = Math.min(1, morph.t + dt / MORPH_TIME);
  build(morph.t < 1 ? morphPlanes(morph.from, morph.to, ease(morph.t)) : morph.to.planes);
  return true;
}

// Window lights: which are meant to be on (a seeded share is dark, and clicks switch them), and their fade.
// Each window is known by its plane's normal, so its state follows it when a morph adds, drops or reorders faces.
const lightTarget = new Float32Array(MAX_FACES).fill(1);
let lightSeed = 0;
let faceKeys = [];
const faceKey = (n) => Math.round(n.x * 1000) * 0.0731 + Math.round(n.y * 1000) * 0.0517 + Math.round(n.z * 1000) * 0.0389;
const hash = (x) => {
  const h = Math.sin(x) * 43758.5453;
  return h - Math.floor(h);
};
// Windows switched by a click, by face key; they hold over the seeded pattern until the next randomize.
const clicked = new Map();
const darkAt = (f) => {
  if (f >= faceKeys.length) return 1;
  const own = clicked.get(faceKeys[f]);
  if (own !== undefined) return own;
  return hash(faceKeys[f] * 12.9898 + lightSeed * 78.233) < params.dark() ? 0 : 1;
};
function setWindowsLit() {
  for (let f = 0; f < MAX_FACES; f++) lightTarget[f] = darkAt(f);
}
function carryWindows(before, after) {
  const light = infinity.faceLight, anim = infinity.faceAnim;
  const oldLight = light.slice(), oldAnim = anim.slice(), oldTarget = lightTarget.slice();
  after.forEach((f, i) => {
    const j = before.findIndex((g) => g.n.dot(f.n) > 1 - 1e-6);
    if (j >= 0) {
      light[i] = oldLight[j];
      anim[i] = oldAnim[j];
      lightTarget[i] = oldTarget[j];
    } else {
      lightTarget[i] = light[i] = darkAt(i);
      anim[i] = 1;
    }
  });
}
function updateWindowLights(dt) {
  const light = infinity.faceLight;
  let moved = false;
  for (let f = 0; f < MAX_FACES; f++) {
    const goal = lightTarget[f];
    if (light[f] === goal) continue;
    light[f] = goal > light[f] ? Math.min(goal, light[f] + dt * 6) : Math.max(goal, light[f] - dt * 4);
    moved = true;
  }
  if (!moved) return false;
  infinity.writeLights();
  updateLit();
  return true;
}

// A click (not a drag) on a window switches its light.
const canvas = renderer.domElement;
let press = null;
// Only the left button or a lone finger: right drags orbit, and two fingers are a gesture.
canvas.addEventListener("pointerdown", (e) => (press = e.button === 0 && touches.size === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null));

// Left drag or one finger turns the sculpture in your hand; a flick keeps it turning a while.
const userQ = new Quaternion();
const userOmega = new Vector3();
const touches = new Set();
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") {
    touches.add(e.pointerId);
    if (touches.size > 1) {
      drag = null;
      press = null;
      userOmega.set(0, 0, 0);
      return;
    }
  } else if (e.button !== 0) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
  userOmega.set(0, 0, 0);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  const now = performance.now(), dt = Math.max((now - drag.t) / 1000, 1e-3);
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.t = now;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const axis = up.multiplyScalar(dx).addScaledVector(right, dy).normalize();
  const angle = (len / Math.min(innerWidth, innerHeight)) * Math.PI * 1.4;
  // The turn is applied under the spin, so it reads as turning the piece in place.
  const spin = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.35 + spinAngle);
  const local = axis.clone().applyQuaternion(spin.clone().invert());
  userQ.premultiply(new Quaternion().setFromAxisAngle(local, angle)).normalize();
  userOmega.lerp(local.multiplyScalar(angle / dt), 0.5);
  pipeline.restartAccumulation(false);
});
const release = (e) => {
  touches.delete(e.pointerId);
  if (drag && e.pointerId === drag.id) {
    if (performance.now() - drag.t > 80) userOmega.set(0, 0, 0);
    drag = null;
  }
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
function updateTurn(dt) {
  if (drag || dt === 0) return false;
  userOmega.multiplyScalar(Math.exp(-1.5 * dt));
  const w = userOmega.length();
  if (w < 1e-4) return false;
  userQ.premultiply(new Quaternion().setFromAxisAngle(userOmega.clone().divideScalar(w), w * dt)).normalize();
  return true;
}
canvas.addEventListener("pointerup", (e) => {
  if (!press || e.pointerId !== press.id || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5 || performance.now() - press.t > 400) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new Vector3(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 1);
  const inv = pose.clone().invert();
  const o = camera.position.clone().sub(frame.position).applyQuaternion(inv);
  const d = ndc.unproject(camera).sub(camera.position).normalize().applyQuaternion(inv);
  let tIn = -Infinity, tOut = Infinity, face = -1;
  sculpture.faces.forEach((f, i) => {
    const dn = f.n.dot(d), t = (f.d - f.n.dot(o)) / dn;
    if (dn < 0 && t > tIn) {
      tIn = t;
      face = i;
    } else if (dn > 0) tOut = Math.min(tOut, t);
  });
  if (face < 0 || tIn > tOut || tIn < 0) return;
  lightTarget[face] = lightTarget[face] > 0.5 ? 0 : 1;
  clicked.set(faceKeys[face], lightTarget[face]);
  autoChange.restart();
});

// Animated windows: a brightness per window over time, for the tubes, the room's light and the haze alike.
// t: the animation's phase, integrated from the speed so changing it doesn't jump.
function updateAnimation(t) {
  const mode = params.animation();
  const anim = infinity.faceAnim;
  const u = infinity.material.uniforms;
  u.chase.value = mode === "chase" ? t * 0.25 : 0;
  if (mode === "none" || mode === "chase") {
    if (anim.some((a) => a !== 1)) anim.fill(1);
    else return false;
  } else {
    const faces = sculpture.faces, F = faces.length;
    const rank = (f) => hash(faceKeys[f] * 91.17 + lightSeed);
    for (let f = 0; f < F; f++) {
      const y = faces[f].c.y, r = rank(f);
      let a = 1;
      if (mode === "breathe") a = 0.55 + 0.45 * Math.sin(t * 1.5);
      else if (mode === "wave") a = 0.5 + 0.5 * Math.sin(y * 3 - t * 3);
      else if (mode === "scan") {
        const pos = Math.sin(t * 1.2) * 1.1;
        a = 0.08 + 0.92 * Math.exp(-(((y - pos) / 0.4) ** 2));
      } else if (mode === "sequence") {
        // One window after another lights up, then they go out in the same order.
        const x = (t * 3) % 2;
        a = x < 1 ? Math.min(1, Math.max(0, (x - r) * 12)) : 1 - Math.min(1, Math.max(0, (x - 1 - r) * 12));
      } else if (mode === "flicker") {
        // A few faulty tubes stutter.
        if (r < 0.25) {
          const n = Math.sin(Math.floor(t * 14 + r * 50) * 12.9898 + faceKeys[f]) * 43758.5453;
          a = n - Math.floor(n) < 0.35 ? 0.1 : 1;
        }
      }
      anim[f] = a;
    }
  }
  infinity.writeLights();
  updateLit();
  return true;
}

// The nested solid: a smaller mirror solid with a tube on every edge, turning slowly inside.
// "same" on a solid with more than 32 faces nests a related one with fewer; icosahedral ones get the icosidodecahedron.
const INNER_FALLBACK = { snubCube: "rhombicuboctahedron", disdyakisDodecahedron: "rhombicuboctahedron" };
let innerShape = null;
let innerAngle = 0;
// The kind of nested solid on show, which lags Inside while the old one shrinks away; grow: its size, 0 to 1.
let innerType = null;
const grow = { v: 1, target: 1 };
const GROW_TIME = 0.9;
const innerAxis = new Vector3(0.3, 1, 0.2).normalize();
function setInner() {
  const name = innerType === "same" ? params.solid() : innerType;
  innerLast.shape = null;
  if (innerType === "none") {
    innerShape = null;
    infinity.setInner(null);
    return;
  }
  if (innerType === "tesseract") {
    // The outer solid itself, shrunk and aligned, each vertex joined to its outer one.
    const verts = uniqueVerts(sculpture.faces), inset = 2.5 * sculpture.tube.radius;
    innerShape = {
      planes: sculpture.faces.map((f) => ({ n: f.n, d: f.d })),
      edges: edgesOf(sculpture.faces),
      links: verts.map((v) => [v, v.clone().multiplyScalar(1 - inset / v.length())]),
      aligned: true,
    };
    return;
  }
  let S = solidPlanes(name);
  if (S.planes.length > 32) S = solidPlanes(INNER_FALLBACK[name] ?? "icosidodecahedron");
  if (S.planes.length > 32) S = solidPlanes("icosahedron");
  innerShape = { planes: S.planes, edges: edgesOf(facesOf(S.planes)) };
}
const _q = new Quaternion();
// What the nested solid was last written with, so an unchanged one isn't uploaded again.
const innerLast = { shape: null, angle: 0, s: 0, radius: 0, fade: 1 };
// A change of Inside shrinks the old solid away, then grows the new one in. Returns true while it does.
function updateGrow(dt) {
  if (params.inner() !== innerType) {
    if (grow.v > 0 && innerShape) grow.target = 0;
    else {
      innerType = params.inner();
      setInner();
      grow.v = innerShape ? 0 : 1;
      grow.target = 1;
    }
  }
  if (grow.v === grow.target) return false;
  grow.v = grow.target > grow.v ? Math.min(1, grow.v + dt / GROW_TIME) : Math.max(0, grow.v - dt / GROW_TIME);
  return true;
}
function updateInner(dt) {
  if (!innerShape) return;
  if (!innerShape.aligned) innerAngle += dt * params.innerSpin() * 0.5;
  // Its circumradius stays inside the outer solid's inradius, whichever way it turns.
  let inradius = Infinity;
  for (const f of sculpture.faces) inradius = Math.min(inradius, f.d);
  const fade = ease(grow.v);
  const s = (innerShape.aligned ? params.innerSize() : Math.min(params.innerSize(), 0.85 * inradius)) * Math.max(fade, 1e-3);
  const radius = 1.2 * sculpture.tube.radius;
  const L = innerLast;
  if (L.shape === innerShape && L.angle === innerAngle && L.s === s && L.radius === radius && L.fade === fade) return;
  Object.assign(L, { shape: innerShape, angle: innerAngle, s, radius, fade });
  _q.setFromAxisAngle(innerAxis, innerShape.aligned ? 0 : innerAngle);
  infinity.setInner(innerShape, _q, s, radius, fade);
}

const _m4 = new Matrix4();
const UP = new Vector3(0, 1, 0);
function writePose(time, dt, drift) {
  spinAngle += params.spin() * dt * 0.4;
  tumble.slerpQuaternions(tumbleFrom, tumbleTo, morph.t < 1 ? ease(morph.t) : 1);
  pose.setFromAxisAngle(UP, 0.35 + spinAngle).multiply(userQ).multiply(tumble);
  // Hanging in the air, it drifts a little.
  frame.position.y = CENTER_Y + 0.03 * drift * Math.sin(time * 0.5);
  walls.position.copy(frame.position);
  frame.quaternion.copy(pose);
  walls.quaternion.copy(pose);
  proxy.position.copy(frame.position);
  proxy.quaternion.copy(pose);
  const u = infinity.material.uniforms;
  u.sculptRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(pose));
  u.sculptCenter.value.copy(frame.position);
  glow.glowCenter.value.copy(frame.position);
}

const SMOKE = new Vector3(0.62, 0.63, 0.64);
const _c = new Vector3();
// The mean colour the tubes give off, and the mean light of the bounces past the last one with every window lit.
const lighting = { average: new Vector3(), mean: 0 };
let shownColors = LIGHTS.white;
function updateLight() {
  const u = infinity.material.uniforms;
  const b = params.brightness();
  u.tubeColor.value.setScalar(10 * b);
  // A new set of lights blends in from the colours on show.
  let colors = LIGHTS[params.lights()] ?? LIGHTS.white;
  if (tween.paletteFrom && tween.t < 1) {
    const from = tween.paletteFrom, e = ease(tween.t);
    colors = colors.map((c, i) => c.map((x, j) => from[i % from.length][j] + (x - from[i % from.length][j]) * e));
  }
  shownColors = colors;
  const pattern = PATTERNS[params.pattern()] ?? 0;
  let peak = 0;
  colors.forEach((c, i) => {
    u.palette.value[i].fromArray(c);
    peak = Math.max(peak, c[0], c[1], c[2]);
  });
  u.paletteCount.value = colors.length;
  u.pattern.value = pattern;
  u.segments.value = Math.round(params.segments());
  u.gap.value = params.gap();
  // The mean colour the tubes give off, for the deep bounces and the room.
  const used = pattern === 0 ? 1 : colors.length;
  const average = lighting.average.set(0, 0, 0);
  for (let i = 0; i < used; i++) average.add(_c.fromArray(colors[i]));
  average.multiplyScalar((pattern === 3 ? 1 - params.gap() : 1) / used);
  u.tubeMax.value = 10 * b * peak;
  u.innerReflect.value = params.mirror();
  const glass = GLASSES[params.glass()] ?? 0;
  u.glass.value = glass;
  u.glassAmount.value = params.amount();
  // Smoked glass: darker, greyer bounces and less of the inside showing.
  const smoke = glass === 2 ? params.amount() : 0;
  u.glassTint.value.set(0.86, 0.96, 0.91).lerp(SMOKE, smoke);
  u.outerTransmit.value = params.window() * (1 - 0.6 * smoke);
  u.outerReflect.value = Math.min(0.85 - params.window(), 0.6);
  // Mid-morph the cap eases between the two solids' caps, so the depth doesn't jump.
  const cap = (count) => BOUNCE_CAP[count > DENSE ? 1 : 0];
  const capped = morph.t < 1 ? cap(morph.from.planes.length) + (cap(morph.to.planes.length) - cap(morph.from.planes.length)) * ease(morph.t) : cap(sculpture.faces.length);
  const bounces = Math.min(Math.round(params.bounces()), capped);
  u.bounces.value = Math.ceil(bounces);
  u.lastWeight.value = bounces - Math.ceil(bounces) + 1;
  u.aberration.value = 0.4 * params.warp() + 1.2 * params.ripple();
  // Mean light of the bounces past the last one: tubes seen at the rate they cover the walls, over a geometric
  // series of mirror bounces through the open glass.
  const tint = u.glassTint.value, R = (params.mirror() * (tint.x + tint.y + tint.z)) / 3;
  lighting.mean = (0.8 * sculpture.cover) / (1 - sculpture.open * R);
  u.warp.value = params.warp();
  u.ripple.value = params.ripple();
  u.tilt.value = params.tilt();
  u.uneven.value = params.uneven();
  // The haze is lit by the same windows; its colour comes from the window it is lit through.
  u.meanColor.value.copy(average).divideScalar(Math.max(average.x, average.y, average.z, 1e-3));
  u.fog.value = params.haze();
  u.tubeType.value = TUBES[params.tubes()] ?? 0;
  glow.glowSharp.value = params.shadows();
  u.floorGloss.value = params.room() === "gallery" ? params.gloss() : 0;
  u.floorY.value = FLOOR_Y;
  wallMaterial.uniforms.tubeLight.value.copy(u.tubeColor.value).multiply(average).multiplyScalar(0.012);
  updateLit();
}

// What follows the windows' lights: run whenever they switch, fade or animate.
function updateLit() {
  const u = infinity.material.uniforms, s = sculpture;
  let share = 0, area = 0, omega = 0;
  for (let f = 0; f < s.faces.length; f++) {
    const lit = infinity.faceLight[f] * infinity.faceAnim[f];
    share += lit;
    area += lit * s.area[f];
    omega += lit * s.omega[f];
  }
  share /= s.faces.length;
  // The gobo carries the windows' power through their solid angle, so on average it matches the form factor.
  glow.glowGobo.value = omega > 1e-6 ? area / omega : 0;
  u.tail.value.copy(u.tubeColor.value).multiply(lighting.average).multiply(u.glassTint.value).multiplyScalar(lighting.mean * share);
  u.haze.value.copy(u.tail.value).multiplyScalar(0.03);
  // A window's radiance is the inside's mean radiance through the two-way glass.
  glow.glowColor.value.copy(u.tail.value).multiplyScalar(params.window() * 14 * params.spill());
  // Roughly what the lit room gives back, seen through an open panel.
  u.roomGlow.value.copy(glow.glowColor.value).multiplyScalar(params.room() === "sphere" ? 0.006 : 0.04);
  u.fogColor.value.copy(u.tail.value).divide(_c.copy(u.meanColor.value).addScalar(1e-3)).multiplyScalar(params.window() * 0.18);
}

// ---------------------------------------------------------------- camera

camera.near = 0.05;
camera.far = 60;
camera.updateProjectionMatrix();
camera.position.set(2.2, 2.6, 5.6);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
// Left drag turns the sculpture; right drag and two fingers orbit.
controls.mouseButtons = { LEFT: -1, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
controls.touches = { ONE: -1, TWO: TOUCH.DOLLY_ROTATE };
controls.enablePan = false;
controls.minDistance = 2.2;
camera.lookAt(controls.target);

onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

// ---------------------------------------------------------------- frame

const keys = () => ({
  solid: params.solid(),
  rim: `${params.rim()}|${params.nodes()}`,
  dark: params.dark(),
  inner: `${params.inner()}|${params.solid()}`,
  innerSize: params.innerSize(),
  room: params.room(),
  animation: params.animation(),
  light: `${params.brightness()}|${params.mirror()}|${params.window()}|${params.bounces()}|${params.warp()}|${params.ripple()}|${params.tilt()}|${params.uneven()}|${params.lights()}|${params.pattern()}|${params.segments()}|${params.gap()}|${params.glass()}|${params.amount()}|${params.spill()}|${params.haze()}|${params.gloss()}|${params.room()}|${params.tubes()}|${params.shadows()}`,
});
// The url and seed are applied before the first build, so a page never opens with a morph.
applyUrlState();
let last = keys();
setSculpture(false);
setRoom();
innerType = params.inner();
setInner();
updateInner(0);
// While something keeps moving the drift runs; otherwise it settles and time holds, so the still and the lens average
// converge. Morphs and flicks restart the accumulation themselves.
const animating = () => params.spin() > 0 || params.animation() !== "none" || (innerShape !== null && !innerShape.aligned && params.innerSpin() > 0);
let drift = animating() ? 1 : 0;
writePose(0, 0, drift);
await Promise.all([load.compile.track(pipeline.compileAsync(scene, camera), 3), load.trace.track(infinity.compile(renderer), 6), studio]);
// Only a trace of the studio's key: the sculpture lights the room.
globalUniforms.lightColor.value.multiplyScalar(0.08);

window.app = {
  canvas,
  params,
  pipeline,
  camera,
  controls,
  infinity,
  preload: () => Promise.resolve(),
  nextLook: (look) => (look ? Object.entries(look).forEach(([k, v]) => params[k]?.set(v)) : randomize()),
  get morphing() {
    return morph.t < 1;
  },
};

let lastNow = null;
let last2 = null;
let animPhase = 0;
// Scene time, held while nothing moves so the pipeline sees a still frame.
let heldTime = 0;
render(({ dt }) => {
  // Morphs and lights switching run on the wall clock, so a change made while paused still lands.
  const now = performance.now();
  const clock = Math.min((now - (lastNow ?? now)) / 1000, 0.1);
  lastNow = now;
  autoChange.update(dt);
  updateTween(clock);
  const k = keys();
  if (k.solid !== last.solid) setSculpture(true);
  else if (k.rim !== last.rim) build(morph.t < 1 ? morphPlanes(morph.from, morph.to, ease(morph.t)) : shown.planes);
  if (k.dark !== last.dark) setWindowsLit();
  // In "same" the nested solid follows a change of solid at once; a change of Inside goes through updateGrow.
  if (k.inner !== last.inner && params.inner() === innerType && innerType === "same") setInner();
  if (k.inner !== last.inner || k.innerSize !== last.innerSize) pipeline.restartAccumulation(false);
  if (k.room !== last.room) setRoom();
  if (k.light !== last.light) {
    updateLight();
    pipeline.restartAccumulation();
  }
  last = k;
  animPhase += dt * params.speed();
  const changing = updateMorph(clock) | updateWindowLights(clock) | (dt > 0 || k.animation !== last2 ? updateAnimation(animPhase) : false);
  last2 = k.animation;
  const growing = updateGrow(clock);
  updateInner(dt);
  if (growing) pipeline.restartAccumulation(false);
  if (updateTurn(dt)) pipeline.restartAccumulation(false);
  if (changing || (innerShape && !innerShape.aligned && dt > 0 && params.innerSpin() > 0)) pipeline.restartAccumulation(false);
  const moving = animating();
  drift = moving ? Math.min(1, drift + dt * 0.5) : drift * Math.exp(-dt * 1.5);
  if (!moving && drift < 1e-3) drift = 0;
  if (moving || drift > 0) heldTime += dt;
  writePose(heldTime, dt, drift);
  controls.update();
  // In the gallery the camera stays in front of the back wall.
  if (params.room() === "gallery" && camera.position.z < WALL_Z + 0.3) {
    camera.position.z = WALL_Z + 0.3;
    camera.lookAt(controls.target);
  }
  pipeline.dof.focus = Math.max(0.2, camera.position.distanceTo(frame.position) + params.focus());
  pipeline.dof.aperture = params.aperture();
  updateProxy();
  infinity.bake(renderer);
  pipeline.render(scene, camera, heldTime);
});
