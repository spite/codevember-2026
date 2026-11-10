import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, randomize, addKey, addActionButton, onPause, isRunning } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3, Vector4, TorusGeometry, Quaternion, Color, BufferGeometry, BufferAttribute, SphereGeometry, InstancedMesh, Matrix4, DoubleSide } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { RoundedBoxGeometry } from "third_party/three-rounded-box.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { Container, SHAPES, containerGLSL } from "./container.js";
import { shell } from "./bodies.js";
import { PhysicsClient, LocalPhysics } from "./physics.js";
import { loopStencil, applyStencil, vertexNormals } from "./subdiv.js";
import { VolumePass, lightShadowGLSL } from "./render.js";
import { LOOKS, LIGHTS } from "./looks.js";
import { createSound } from "./sound.js";
import { nativeRandom } from "modules/random.js";

const touch = matchMedia("(pointer: coarse)").matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const CENTER = [0, 1.8, 0];
const MAX_FLOATERS = 200;

const defaults = {
  look: "ruby",
  shape: "cube",
  container: true,
  walls: 0.02,
  frost: 0.1,
  haze: 0.8,
  tumble: 0.35,
  motionBlur: 0.5,
  count: 12,
  variety: 0.5,
  fill: 0.82,
  softness: 0.6,
  spheres: 1,
  cushions: 0,
  pills: 0,
  gumdrops: 0,
  floaters: "core",
  skin: 0.12,
  density: 4,
  milk: 1.4,
  scatter: 0.08,
  refraction: 0.25,
  light: "warm",
  brightness: 1,
  keyLight: 1,
  auto: true,
  autoTime: 12,
};
const params = fromDefaults(defaults);
const load = { studio: loadingStep(1), sound: loadingStep(1), compile: loadingStep(4) };

let volume;
const pipeline = new Pipeline(renderer, {
  background: 0xcdc8c3,
  exposure: 1,
  bloomStrength: 0.03,
  vignette: 0.15,
  grain: 0.02,
  shadow: { autoFit: true, denoise: true },
  // The bodies are drawn outside the pipeline, so its AO/GI only reaches the floor and floaters, invisibly.
  gi: false,
  composite: (hdr, ctx) => volume.render(renderer, hdr, ctx),
});
const lite = ["low", "medium"].includes(pipeline.quality);
volume = new VolumePass({ steps: lite ? 48 : 72, lightSize: lite ? 256 : 512 });
const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, { keyDirection: new Vector3(-0.45, 1, 0.5), keyIntensity: 6, keySize: 0.8, fill: 0.5, floor: 0.35, wall: 0.55, ceiling: 0.5 }),
);

const look = () => LOOKS[params.look()] ?? LOOKS.ruby;

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
const applyLook = (name) => {
  const l = LOOKS[name];
  params.frost.set(l.resin.frost);
  params.haze.set(l.resin.haze);
  params.milk.set(l.jelly.milk);
  params.scatter.set(l.jelly.frost);
  params.density.set(l.jelly.density);
};
const RND = " Click the name to randomize it.";
const tip = (text, opts = {}) => ({ ...opts, title: text + (opts.randomizable === false ? "" : RND) });
const roll = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;

// A look and shape a recording asks for (app.nextLook); randomize builds everything else around them.
const forced = {};
gui.addSelect("Look", params.look, Object.keys(LOOKS),
  tip("The palette: the backdrop, the container's tint, the jelly's colours and the floaters. Choosing one also sets the frost, haze and jelly sliders to suit it.", { onChange: applyLook })).randomize = () =>
  params.look.set(forced.look ?? pick(Object.keys(LOOKS)));

gui.addSection("Container");
gui.addSelect("Shape", params.shape, Object.keys(SHAPES), tip("The container's shape. Changing it morphs the container while a new set of bodies swells in."));
gui.addCheckbox("Visible", params.container,
  tip("Shows or hides the container. Hidden, the bodies are still held in its shape and the shadow on the floor comes from them.", { randomizable: false }));
gui.addSlider("Walls", params.walls, 0, 0.2, 0.01, tip("How thick the container's walls are. 0 is a thin film; thicker walls show a tinted glass rim.")).randomize = () =>
  params.walls.set(roll(0, 0.02));
gui.addSlider("Frost", params.frost, 0, 0.6, 0.01, tip("A satin finish on the walls: what's inside blurs more the further behind the wall it is.")).randomize = () =>
  params.frost.set(roll(0.05, 0.16));
gui.addSlider("Haze", params.haze, 0, 1.5, 0.01, tip("Cloudiness in the walls' material: dims what's behind and adds a glow of the container's colour.")).randomize = () =>
  params.haze.set(look().resin.haze < 0.3 ? roll(0.1, 0.4) : roll(0.2, 1.3));
gui.addSlider("Tumble", params.tumble, 0, 1, 0.01,
  tip("How fast the container turns by itself when left alone. Dragging turns it by hand.", { randomizable: false }));
gui.addSlider("Motion blur", params.motionBlur, 0, 1, 0.01,
  tip("Streaks the container and everything in it as it spins, as a camera shutter would: the share of a frame the shutter stays open.", { randomizable: false }));

gui.addSection("Bodies");
gui.addSlider("Count", params.count, 3, touch ? 14 : 22, 1, tip("How many jelly bodies. Narrow shapes add more, smaller ones, to fill up. Changing it makes a new set.")).randomize = () =>
  params.count.set(Math.round(5 + Math.random() * (touch ? 8 : 13)));
gui.addSlider("Variety", params.variety, 0, 1, 0.01, tip("How different the bodies' sizes are. Changing it makes a new set."));
gui.addSlider("Fill", params.fill, 0.4, 0.95, 0.01, tip("How much of the container the bodies take up: high values pack them in so they squash together. Changing it makes a new set.")).randomize = () =>
  params.fill.set(roll(0.7, 0.92));
gui.addSlider("Softness", params.softness, 0, 1, 0.01, tip("How easily the bodies lose their shape: firm and round at 0, slumping and squeezing into gaps at 1."));
// How much of each body shape goes into a new set, relative to the others.
const SHAPE_MIX = [
  ["Spheres", "spheres", "round balls"],
  ["Cushions", "cushions", "soft cubes with round edges"],
  ["Pills", "pills", "long capsules"],
  ["Gumdrops", "gumdrops", "five-lobed gummies with a flat base"],
];
for (const [label, key, what] of SHAPE_MIX)
  gui.addSlider(label, params[key], 0, 1, 0.01,
    tip(`How many of the bodies are ${what}, in proportion to the other shapes. All at 0 makes spheres. Changing it makes a new set.`)).randomize = () =>
    // Mostly spheres; each other shape joins in now and then.
    params[key].set(key === "spheres" ? roll(0.5, 1) : Math.random() < 0.4 ? roll(0.2, 0.8) : 0);
gui.addSelect("Floaters", params.floaters, ["none", "beads", "core", "both"],
  tip("What floats inside each body: a few beads, one core, both or nothing. Changing it makes a new set.")).randomize = () =>
  // Randomize always puts something inside; "none" is only by hand.
  params.floaters.set(pick(["beads", "core", "both"]));
gui.addSlider("Skin thickness", params.skin, 0, 0.3, 0.01,
  tip("How far inside each body's surface the floaters are held, as a fraction of its radius: they press on the skin but never reach it."));

gui.addSection("Jelly");
gui.addSlider("Colour", params.density, 0, 6, 0.01, tip("How strongly the jelly is coloured: pale and see-through at 0, deep and dark at the top.")).randomize = () =>
  params.density.set(Math.min(6, look().jelly.density * roll(0.5, 1.5)));
gui.addSlider("Milk", params.milk, 0, 2, 0.01, tip("How milky the jelly is: it scatters light, glowing in its own colour and hiding what's inside.")).randomize = () => {
  // Mostly frosty, capped by the jelly's colour so pale jelly doesn't turn white; a clear look stays nearly clear.
  const cap = 0.4 + params.density() * 0.3;
  params.milk.set(look().jelly.milk < 0.2 ? roll(0, 0.2) : Math.min(cap, Math.random() < 0.8 ? roll(0.8, 1.9) : roll(0, 0.5)));
};
gui.addSlider("Scatter", params.scatter, 0, 1, 0.01, tip("How much the jelly blurs what's behind and inside it: clear at 0, softly diffused at 1.")).randomize = () =>
  params.scatter.set(Math.random() < 0.8 ? roll(0.02, 0.12) : roll(0.12, 0.35));
gui.addSlider("Refraction", params.refraction, 0, 1, 0.01, tip("How much the jelly bends what's seen through it, with a little colour split at high values.")).randomize = () =>
  params.refraction.set(roll(0.05, 0.45));

gui.addSection("Light");
gui.addSelect("Colour", params.light, Object.keys(LIGHTS), tip("The light's colour: the key light and the studio's ambient fill, tinted together."));
gui.addSlider("Brightness", params.brightness, 0.6, 1.4, 0.01, tip("How bright the whole studio is.")).randomize = () => params.brightness.set(roll(0.8, 1.2));
gui.addSlider("Key light", params.keyLight, 0.4, 1.6, 0.01,
  tip("The key light against the ambient fill: how contrasty the shading and the shadows are.")).randomize = () => params.keyLight.set(roll(0.7, 1.3));
gui.endSection();
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui });
pipeline.addGUI(gui);
gui.addSeparator();
const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Paused, a drag orbits the camera instead of turning the volume.
onPause((running) => {
  sound.setPaused(!running);
  controls.enableRotate = !running;
  drag.active = false;
});
gui.addText(keysHelp());
showHint("Drag to turn the volume · scroll to zoom · Space, then drag to look around · R for a new one", "Drag to turn the volume · pause, then drag to look around · tap {randomize} for a new one");
showSoundHint(() => !sound.running);
gui.show();

const scene = new Scene();

// A seamless studio sweep: floor, a quarter-round cove and a wall behind.
function sweepGeometry() {
  // Profile as (z, y): from the front of the floor back to the cove, then up the wall.
  const pts = [];
  const R = 3.2, wallZ = -4.5, coveZ = wallZ + R;
  for (let i = 0; i <= 20; i++) pts.push([14 - (i / 20) * (14 - coveZ), 0]);
  for (let i = 1; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 0.5;
    pts.push([coveZ - R * Math.sin(a), R * (1 - Math.cos(a))]);
  }
  for (let i = 1; i <= 6; i++) pts.push([wallZ, R + i * 3]);
  const xs = [-16, 16];
  const pos = [], idx = [];
  for (const [z, y] of pts) for (const x of xs) pos.push(x, y, z);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// The sweep under the volume: the key light coloured by the jelly it crossed (a light-space map from the volume pass)
// and by the container, occlusion from the bodies and the box, and the bodies' colour bounced onto it.
const vu = volume.volumeUniforms;
const floorUniforms = {
  shapeFrom: vu.shapeFrom, shapeTo: vu.shapeTo, shapeMix: vu.shapeMix, shapeBlend: vu.shapeBlend, containerInverse: vu.containerInverse, containerCenter: vu.containerCenter,
  containerShow: vu.containerShow, wall: vu.wall,
  resinColor: volume.look.resinColor, resinDensity: volume.look.resinDensity, haze: volume.look.haze, jellyMilk: volume.look.jellyMilk,
  lightViewProjection: { value: volume.lightViewProjection },
  lightExtent: { value: volume.lightExtent },
  lightMapSize: { value: volume.lightT.width },
  keyAngle: globalUniforms.shadowLightSize,
  bounce: { value: 1 },
  bodySpheres: { value: Array.from({ length: 32 }, () => new Vector4()) },
  bodyTint: { value: Array.from({ length: 32 }, () => new Vector4()) },
  bodyCount: { value: 0 },
};
volume.lightPyr.bind(floorUniforms, "tLight", volume.lightT.texture);
const floorMaterial = new PipelineMaterial({
  color: look().backdrop,
  roughness: 0.92,
  side: DoubleSide,
  uniforms: floorUniforms,
  fragmentPars: /* glsl */ `
uniform mat4 containerInverse;
uniform vec3 containerCenter;
uniform float containerShow;
uniform float wall;
uniform vec3 resinColor;
uniform float resinDensity;
uniform float haze;
uniform float jellyMilk;
uniform mat4 lightViewProjection;
uniform float lightExtent;
uniform float lightMapSize;
uniform float keyAngle;
uniform float bounce;
uniform vec4 bodySpheres[32];
// Per body: colour (rgb) and how opaque it is across (a).
uniform vec4 bodyTint[32];
uniform int bodyCount;
${lightShadowGLSL}
${containerGLSL}
float volumeSDF(vec3 p) { return containerSDF((containerInverse * vec4(p, 1.0)).xyz); }
// Length of the ray inside the volume, and how much of the key light's disc it covers (a soft shadow).
float containerChord(vec3 ro, vec3 rd, out float cover) {
  float res = 1.0, t = 0.05, inside = 0.0;
  for (int i = 0; i < 48; i++) {
    float h = volumeSDF(ro + rd * t);
    res = min(res, 6.0 * h / t);
    float dt = clamp(abs(h), 0.02, 0.5);
    if (h < 0.0) inside += dt;
    t += dt;
    if (t > 8.0) break;
  }
  res = clamp(res, 0.0, 1.0);
  cover = 1.0 - res * res * (3.0 - 2.0 * res);
  return inside;
}
float contactAO(vec3 p, vec3 n) {
  float o = 0.0, w = 1.0;
  for (int i = 1; i <= 5; i++) {
    float h = 0.25 * float(i);
    o += w * max(h - volumeSDF(p + n * h), 0.0);
    w *= 0.6;
  }
  return clamp(1.0 - 0.6 * o, 0.0, 1.0);
}
`,
  surface: /* glsl */ `
void surface(inout Surface s) {
#if !defined(PIPELINE_SHADOW) && !defined(PIPELINE_PREPASS)
  vec3 P = vWorldPosition;
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(lightDirection);

  // The jelly along the key light, blurred by the penumbra: the light's angular size times the gap to the bodies.
  vec4 lc = lightViewProjection * vec4(P, 1.0);
  vec2 luv = lc.xy / lc.w * 0.5 + 0.5;
  float gap = max(dot(containerCenter - P, L), 0.0);
  float radiusPx = keyAngle * gap * lightMapSize / (2.0 * lightExtent);
  vec3 Tj = all(greaterThan(luv, vec2(0.0))) && all(lessThan(luv, vec2(1.0))) ? clamp(tLightBlur(luv, radiusPx).rgb, 0.0, 1.0) : vec3(1.0);

  // The container: a thin glass shell loses a little at each of its four surfaces; a solid block absorbs and
  // scatters along the chord the light crosses (half the scattering still goes forward).
  float cover;
  float chord = containerChord(P, L, cover);
  // The container is always a hollow shell.
  const float hollow = 1.0;
  vec3 sigma = -log(max(resinColor, vec3(1e-3))) * resinDensity * 2.0 + haze * 0.5;
  vec3 Tc = mix(exp(-sigma * chord), vec3(0.85), hollow);
  Tc = mix(vec3(1.0), Tc, cover * containerShow);

  // Only the key light is filtered: scale the albedo by its share of this point's diffuse light.
  vec3 key = lightColor * max(dot(N, L), 0.0) * 0.318310;
  vec3 amb = max(evalSH(envRotation * N), vec3(0.0)) * envIntensity;
  vec3 keyShare = key / max(key + amb, vec3(1e-4));
  s.albedo *= 1.0 - keyShare * (1.0 - Tj * Tc);

  // Occlusion and bounce from the bodies, as spheres: AO by how opaque each is, light by its colour.
  float occ = 0.0;
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= bodyCount) break;
    vec4 sph = bodySpheres[i];
    vec3 D = sph.xyz - P;
    float l = length(D);
    float ff = sph.w * sph.w / max(l * l, sph.w * sph.w) * clamp(dot(N, D / l), 0.0, 1.0);
    occ += ff * bodyTint[i].a;
    glow += ff * bodyTint[i].rgb;
  }
  float box = mix(1.0, contactAO(P, N), containerShow * mix(1.0, 0.25, hollow));
  s.occlusion *= exp(-1.2 * occ) * box;
  // A body's radiance: the studio and the key light, scattered by its milk and tinted by its colour.
  vec3 meanL = max(shIrradiance[0] * 0.282095, vec3(0.0)) * envIntensity;
  float scatter = 0.25 + 0.75 * clamp(jellyMilk, 0.0, 1.0);
  s.emissive += s.albedo * glow * (meanL + lightColor * 0.08) * scatter * bounce;
#endif
}
`,
});
const floor = new Mesh(sweepGeometry(), floorMaterial);
floor.userData.noShadow = true;
scene.add(floor);

camera.position.set(0, 2.55, 5.9);
controls.target.set(...CENTER);
controls.enableRotate = false;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 12;
controls.maxPolarAngle = 1.62;

const capturing = new URLSearchParams(location.search).has("capture");
// Render scale: big screens stay under a pixel budget, and the scale drops while frames are slow and climbs back once
// they keep up with the display.
const view = { w: 1, h: 1, dpr: 1, scale: 1, ema: 16, last: 0, checked: 0 };
const budget = lite ? 2.6e6 : 4.2e6;
const applySize = () => {
  const fit = capturing ? 1 : Math.min(1, Math.sqrt(budget / (view.w * view.h * view.dpr * view.dpr)));
  const ratio = view.dpr * fit * view.scale;
  if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
  pipeline.setSize(view.w, view.h, ratio);
};
onResize((w, h, dpr) => {
  Object.assign(view, { w, h, dpr });
  applySize();
});
function adaptScale(now) {
  const frame = view.last ? now - view.last : 16;
  view.last = now;
  if (capturing || frame > 250) return;
  view.ema += (frame - view.ema) * 0.05;
  if (now - view.checked < 1500) return;
  view.checked = now;
  let s = view.scale;
  if (view.ema > 24 && s > 0.5) s = Math.max(0.5, s * 0.85);
  else if (view.ema < 18 && s < 1) s = Math.min(1, s * 1.1);
  if (Math.abs(s - view.scale) > 0.02) {
    view.scale = s;
    applySize();
  }
}

const container = new Container(params.shape());
container.wall = params.walls();
// The physics runs in a worker; this is its last state, one step behind.
// Recordings step it on the main thread instead, in step with their virtual clock.
const world = new (capturing ? LocalPhysics : PhysicsClient)(container, { capacity: 9000, center: CENTER, substeps: touch ? 5 : 8 });
const detail = touch ? 2 : 3;

// Skins: the shell, pushed out by the particle radius and Loop-subdivided.
const views = new Map();
function viewFor(body) {
  let view = views.get(body);
  if (view) return view;
  const s = body.shell;
  const stencil = loopStencil(s.index, s.count);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(stencil.count * 3), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(stencil.count * 3), 3));
  geometry.setIndex(new BufferAttribute(stencil.index, 1));
  const handle = volume.addBody(geometry);
  view = { geometry, stencil, handle, shellPos: new Float32Array(s.count * 3), shellNor: new Float32Array(s.count * 3) };
  views.set(body, view);
  return view;
}

// Floaters: plain beads, dice and rings, one instanced mesh each, all matte. The physics treats them all as balls of
// their radius; the meshes fit inside it.
const dicePars = /* glsl */ `
// Distance to the nearest pip of face n (1 to 6) at uv in [-0.5, 0.5].
float pipDistance(int n, vec2 uv) {
  float d = 1.0;
  if (n == 1 || n == 3 || n == 5) d = min(d, length(uv));
  if (n >= 2) d = min(d, min(length(uv - vec2(-0.25, -0.25)), length(uv - vec2(0.25, 0.25))));
  if (n >= 4) d = min(d, min(length(uv - vec2(-0.25, 0.25)), length(uv - vec2(0.25, -0.25))));
  if (n == 6) d = min(d, min(length(uv - vec2(-0.25, 0.0)), length(uv - vec2(0.25, 0.0))));
  return d;
}
`;
const diceSurface = /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition / 1.25, a = abs(p);
  int n;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { n = p.x > 0.0 ? 1 : 6; uv = p.yz; }
  else if (a.y >= a.z) { n = p.y > 0.0 ? 2 : 5; uv = p.xz; }
  else { n = p.z > 0.0 ? 3 : 4; uv = p.xy; }
  float pip = 1.0 - smoothstep(0.07, 0.09, pipDistance(n, uv));
  // Dark pips on a light die, light pips on a dark one.
  float light = dot(s.albedo, vec3(0.3, 0.55, 0.15));
  s.albedo = mix(s.albedo, light > 0.35 ? vec3(0.03) : vec3(0.9), pip);
}
`;
const FLOATER_MESHES = {
  plain: [new SphereGeometry(1, 32, 20), { roughness: 0.75 }],
  dice: [new RoundedBoxGeometry(1.25, 1.25, 1.25, 3, 0.18), { roughness: 0.75, fragmentPars: dicePars, surface: diceSurface }],
  ring: [new TorusGeometry(0.72, 0.26, 16, 40), { roughness: 0.75 }],
};
const floaterMeshes = {};
for (const [kind, [geometry, options]] of Object.entries(FLOATER_MESHES)) {
  const mesh = new InstancedMesh(geometry, new PipelineMaterial({ color: 0xffffff, ...options }), MAX_FLOATERS);
  mesh.frustumCulled = false;
  mesh.setColorAt(0, new Color(1, 1, 1));
  mesh.count = 0;
  scene.add(mesh);
  floaterMeshes[kind] = mesh;
}
const _turn = new Quaternion();

const _m = new Matrix4(), _q = new Quaternion(), _p = new Vector3(), _s = new Vector3(), _c = new Color();
const containerMatrix = new Matrix4();
let shownVersion = -1;
function updateViews() {
  const { x, r } = world;
  const fresh = world.version !== shownVersion;
  shownVersion = world.version;
  for (const b of world.bodies) {
    if (b.start < 0 || (!fresh && views.has(b))) continue;
    const view = viewFor(b);
    const { shellPos, shellNor, geometry, stencil } = view;
    const o = b.start;
    for (let i = 0; i < b.count * 3; i++) shellPos[i] = x[o * 3 + i];
    vertexNormals(shellPos, b.shell.index, shellNor);
    for (let i = 0; i < b.count * 3; i++) shellPos[i] += shellNor[i] * b.rp;
    applyStencil(stencil, shellPos, 0, geometry.attributes.position.array);
    vertexNormals(geometry.attributes.position.array, stencil.index, geometry.attributes.normal.array);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
  }
  for (const [b, view] of views)
    if (!b.alive) {
      volume.removeBody(view.handle);
      view.geometry.dispose();
      views.delete(b);
    }
  for (const mesh of Object.values(floaterMeshes)) mesh.count = 0;
  for (const b of world.bodies)
    for (let j = 0; b.start >= 0 && j < b.fcount; j++) {
      const fl = b.floaters[j];
      const mesh = floaterMeshes[fl.kind] ?? floaterMeshes.plain;
      if (mesh.count >= MAX_FLOATERS) continue;
      const f = b.fstart + j;
      _p.set(x[f * 3], x[f * 3 + 1], x[f * 3 + 2]);
      // Each floater keeps its own tilt within its body's turn.
      _q.set(b.q[0], b.q[1], b.q[2], b.q[3]).multiply(_turn.set(...fl.turn));
      _s.setScalar(r[f]);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(mesh.count, _m);
      mesh.setColorAt(mesh.count, _c.set(fl.color));
      mesh.count++;
    }
  for (const mesh of Object.values(floaterMeshes)) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  containerMatrix.compose(_p.set(...CENTER), _q.set(...world.q), _s.setScalar(1));
  const spheres = floorUniforms.bodySpheres.value, tints = floorUniforms.bodyTint.value;
  let ns = 0;
  const d = params.density(), milk = params.milk();
  for (const b of world.bodies) {
    if (ns >= 32) break;
    const rad = b.radius * b.scale + b.rp;
    _c.set(b.data.color);
    // Opaque by its absorption and milk across its diameter.
    const sig = (-Math.log(Math.max(_c.r, 0.02)) - Math.log(Math.max(_c.g, 0.02)) - Math.log(Math.max(_c.b, 0.02))) / 3;
    tints[ns].set(_c.r, _c.g, _c.b, 1 - Math.exp(-(sig * d + milk) * 2 * rad));
    spheres[ns++].set(b.c[0], b.c[1], b.c[2], rad);
  }
  floorUniforms.bodyCount.value = ns;
  volume.setContainer(container, containerMatrix);
}

// Each body's jelly absorbs by its colour; scattering (milk) takes the same colour.
// The light's colour: the key light and the studio's ambient tinted over their neutral values, eased.
const lightBase = { key: new Color(), sh: [] };
const keyTint = new Color(1, 1, 1), fillTint = new Color(1, 1, 1);
function captureLight() {
  lightBase.key.copy(globalUniforms.lightColor.value);
  lightBase.sh = globalUniforms.shIrradiance.value.map((v) => v.clone());
}
function updateLight(dt) {
  const l = LIGHTS[params.light()] ?? LIGHTS.neutral;
  const k = 1 - Math.exp(-dt * 2);
  const b = params.brightness();
  keyTint.lerp(_c.set(l.key).multiplyScalar(b * params.keyLight()), k);
  fillTint.lerp(_c.set(l.fill).multiplyScalar(b), k);
  globalUniforms.lightColor.value.copy(lightBase.key).multiply(keyTint);
  globalUniforms.shIrradiance.value.forEach((v, i) => v.set(lightBase.sh[i].x * fillTint.r, lightBase.sh[i].y * fillTint.g, lightBase.sh[i].z * fillTint.b));
}

function updateLook(dt) {
  // The walls ease to their thickness and the container fades in and out.
  const kw = 1 - Math.exp(-dt * 4);
  container.wall += (params.walls() - container.wall) * kw;
  vu.wall.value = container.wall;
  vu.containerShow.value += ((params.container() ? 1 : 0) - vu.containerShow.value) * kw;
  const l = look();
  const k = 1 - Math.exp(-dt * 3);
  const u = volume.look;
  const num = (un, v) => (un.value += (v - un.value) * k);
  const col = (un, hex) => un.value.lerp(_c.set(hex), k);
  num(u.frost, params.frost());
  num(u.haze, params.haze());
  num(u.surfaceRough, l.resin.rough);
  num(u.dispersion, l.resin.dispersion);
  num(u.resinDensity, l.resin.density);
  col(u.resinColor, l.resin.color);
  col(u.hazeColor, l.resin.hazeColor);
  num(u.jellyRough, l.jelly.rough);
  num(u.jellyFrost, params.scatter());
  num(u.jellyMilk, params.milk());
  num(u.jellyRefract, params.refraction());
  num(u.jellyDensity, params.density());
  num(u.jellyGlow, l.jelly.glow);
  floorMaterial.color.lerp(_c.set(l.backdrop), k);
  for (const b of world.bodies) {
    const view = views.get(b);
    if (!view) continue;
    const un = view.handle.uniforms;
    _c.set(b.data.color);
    const d = params.density();
    un.sigma.value.set(-Math.log(Math.max(_c.r, 0.02)) * d, -Math.log(Math.max(_c.g, 0.02)) * d, -Math.log(Math.max(_c.b, 0.02)) * d);
  }
}

// A new set: bodies sized so their volume fills the container, placed where they fit at their starting size.
const GROW_FROM = 0.3;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const MAX_BODIES = touch ? 18 : 30;
function newBodies() {
  const variety = params.variety();
  const size = () => Math.pow(1 - variety * 0.65 * Math.random(), 1.3);
  const sizes = Array.from({ length: params.count() }, size);
  // Sized for the walls being eased to.
  const wall = container.wall;
  container.wall = params.walls();
  const maxR = container.inner * 0.92;
  const target = (params.fill() * container.volume) / ((4 / 3) * Math.PI);
  container.wall = wall;
  let k;
  // In a narrow volume the bodies are capped by its width, so more of them make up the fill.
  for (;;) {
    const sum = sizes.reduce((s, r) => s + r ** 3, 0);
    k = Math.cbrt(target / sum);
    const big = Math.max(...sizes) * k;
    if (big <= maxR) break;
    k *= maxR / big;
    if (sizes.length >= MAX_BODIES || sum * k ** 3 >= target * 0.97) break;
    sizes.push(size());
  }
  const mode = params.floaters();
  const kinds = { sphere: params.spheres(), cushion: params.cushions(), pill: params.pills(), gumdrop: params.gumdrops() };
  if (Object.values(kinds).every((w) => w <= 0)) kinds.sphere = 1;
  const l = look();
  return sizes.map((s) => {
    const kind = weighted(kinds);
    const visual = s * k;
    const sh = shell(kind, visual < 0.32 ? detail - 1 : detail);
    const radius = visual / (1 + sh.edgeMean * 0.55);
    const floaters = [];
    if (mode === "core" || mode === "both")
      floaters.push({ radius: mode === "both" ? 0.34 : 0.42, mass: 8, color: pick(l.floaters.core), kind: weighted(CORE_KINDS), turn: randomQuat() });
    if (mode === "beads" || mode === "both") {
      const nb = 2 + Math.floor(Math.random() * 4);
      // A body's beads mostly share one kind, with the odd stray.
      const main = weighted(BEAD_KINDS);
      for (let i = 0; i < nb; i++)
        floaters.push({ radius: 0.13 + Math.random() * 0.08, mass: 2, color: pick(l.floaters.beads), kind: Math.random() < 0.75 ? main : weighted(BEAD_KINDS), turn: randomQuat() });
    }
    return { shell: sh, radius, visual, floaters, data: { color: pick(l.jelly.colors) } };
  });
}

const BEAD_KINDS = { plain: 3, dice: 1, ring: 1.5 };
const CORE_KINDS = { plain: 1 };
function weighted(table) {
  let t = Math.random() * Object.values(table).reduce((a, w) => a + w, 0);
  for (const [k, w] of Object.entries(table)) if ((t -= w) < 0) return k;
  return Object.keys(table)[0];
}

function place(specs) {
  const placed = [];
  for (const spec of specs.sort((a, b) => b.visual - a.visual)) {
    const r0 = spec.visual * GROW_FROM;
    let best = null, bestScore = -Infinity;
    for (let tries = 0; tries < 200; tries++) {
      const lx = (Math.random() * 2 - 1) * 1.3, ly = (Math.random() * 2 - 1) * 1.3, lz = (Math.random() * 2 - 1) * 1.3;
      if (Math.max(container.sdf(lx, ly, lz), targetSDF(lx, ly, lz)) > -r0 - 0.03) continue;
      const p = world.toWorld(lx, ly, lz);
      let clear = Infinity;
      for (const o of placed) clear = Math.min(clear, Math.hypot(p[0] - o.p[0], p[1] - o.p[1], p[2] - o.p[2]) - o.r - r0);
      for (const b of world.bodies) clear = Math.min(clear, Math.hypot(p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]) - b.radius * b.scale * 1.2 - r0);
      if (clear > 0.02) {
        best = p;
        break;
      }
      if (clear > bestScore) {
        bestScore = clear;
        best = p;
      }
    }
    if (!best) best = [...CENTER];
    placed.push({ p: best, r: r0 });
    spec.position = best;
  }
  return specs;
}
function targetSDF(x, y, z) {
  const t = container.t;
  container.t = 1;
  const d = container.sdf(x, y, z);
  container.t = t;
  return d;
}

// Transitions: the old bodies shrink away while the volume morphs, then the new ones grow in.
const live = [];
const dying = [];
const transition = { pending: null };
const ease = (x) => 1 - Math.pow(1 - x, 3);

function rebuild(first = false) {
  for (const it of live) {
    it.from = it.body.scale;
    it.t = 0;
    dying.push(it);
  }
  live.length = 0;
  if (params.shape() !== container.name) container.morphTo(params.shape());
  if (first) {
    container.t = 1;
    spawn();
  } else {
    transition.pending = 0.45;
    // The old set gives way and the container reshapes: a suction pop.
    sound.play("stretch", { gain: 1 });
  }
}

function spawn() {
  // The new set swells in, sucked into place, once the growth shows.
  setTimeout(() => sound.play("swell", { gain: 1 }), 250);
  for (const spec of place(newBodies())) {
    const body = world.addBody({ ...spec, scale: GROW_FROM, quaternion: randomQuat() });
    if (body) live.push({ body, t: 0, delay: Math.random() * 0.3 });
  }
}

function randomQuat() {
  const q = new Quaternion().setFromAxisAngle(new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * 6.28);
  return [q.x, q.y, q.z, q.w];
}

function updateTransitions(dt) {
  if (container.t < 1) container.t = Math.min(1, container.t + dt / 1.4);
  if (transition.pending !== null) {
    transition.pending -= dt;
    if (transition.pending <= 0) {
      transition.pending = null;
      spawn();
    }
  }
  for (let i = dying.length - 1; i >= 0; i--) {
    const it = dying[i];
    it.t += dt / 0.5;
    it.body.scale = Math.max(0.05, it.from * (1 - ease(Math.min(it.t, 1))));
    if (it.t >= 1) {
      world.removeBody(it.body);
      dying.splice(i, 1);
    }
  }
  for (const it of live) {
    if (it.t >= 1) continue;
    it.t = Math.min(1, it.t + dt / 1.3);
    const a = ease(Math.max(0, (it.t * 1.3 - it.delay) / 1.0));
    it.body.scale = GROW_FROM + (1 - GROW_FROM) * Math.min(a, 1);
  }
}

// Turning the volume: a drag spins it like a trackball, with inertia; left alone it tumbles slowly.
const drag = { active: false, id: -1, x: 0, y: 0, vx: 0, vy: 0, idle: 99 };
const omega = new Vector3();
const wander = new Vector3();
const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  if (drag.active || !isRunning()) return;
  drag.active = true;
  drag.id = e.pointerId;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.vx = drag.vy = 0;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.active || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.vx += dx;
  drag.vy += dy;
});
for (const type of ["pointerup", "pointercancel"])
  canvas.addEventListener(type, (e) => {
    if (e.pointerId === drag.id) drag.active = false;
  });

const _right = new Vector3(), _up = new Vector3(), _axis = new Vector3();
// A recording can take over the spin: steer(time) returns the angular velocity [x, y, z] to ease toward.
let steer = null;
function updateSpin(dt, time) {
  if (dt <= 0) {
    volume.motion.shutter.value = 0;
    return;
  }
  if (steer) {
    omega.lerp(_axis.set(...steer(time)), 1 - Math.exp(-dt * 4));
  } else if (drag.active) {
    const k = 5.5 / Math.min(innerWidth, innerHeight);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    _axis.copy(_up).multiplyScalar(drag.vx).addScaledVector(_right, drag.vy).multiplyScalar(k / dt);
    omega.lerp(_axis, 1 - Math.exp(-dt * 25));
    drag.vx = drag.vy = 0;
    drag.idle = 0;
  } else {
    // After a drag the spin coasts down; the slow tumble only comes back once it has been left alone a while.
    drag.idle += dt;
    const back = Math.min(Math.max((drag.idle - 2) / 3, 0), 1);
    const s = params.tumble() * back * back * (3 - 2 * back);
    wander.set(Math.sin(time * 0.13) * 0.6 + 0.3, Math.sin(time * 0.071 + 1) * 0.9, Math.cos(time * 0.097) * 0.6).multiplyScalar(s * 0.9);
    omega.lerp(wander, 1 - Math.exp(-dt * (back > 0 ? 0.8 : 1.2)));
  }
  // The motion blur follows the same spin; recordings blur by averaging frames instead.
  volume.motion.omega.value.copy(omega);
  volume.motion.shutter.value = capturing ? 0 : params.motionBlur() / 60;
  world.omega[0] = omega.x;
  world.omega[1] = omega.y;
  world.omega[2] = omega.z;
  updateSwoosh(dt);
}

// A swoosh when the spin picks up or swings to a new axis; not again while it just coasts.
const swooshFrom = new Vector3();
let swooshCool = 0;
function updateSwoosh(dt) {
  swooshCool -= dt;
  const s = omega.length();
  if (s < 1) swooshFrom.set(0, 0, 0);
  if (swooshCool <= 0 && s > 2.5 && omega.distanceTo(swooshFrom) > 2.5 && s > swooshFrom.length() * 0.7) {
    sound.play("swoosh", { gain: 0.3 + 0.7 * Math.min(1, (s - 2.5) / 6), rate: 0.95 + Math.min(s, 10) * 0.01 });
    swooshFrom.copy(omega);
    swooshCool = 0.35;
  }
}

// Sounds from sudden changes of velocity: a body's centre for squishes and thuds, the floaters for soft taps.
const motion = new Map();
const _v = new Vector3();
const soundStats = { squish: 0 };
function panOf(x, y, z) {
  _v.set(x, y, z).project(camera);
  return _v.x * 0.8;
}
let heard = -1;
// While things rest, a body now and then squishes softly, panned to where it sits: no spin, no drag, no new set
// swelling in.
let stillness = 0;
let nextIdle = 2;
function updateIdleSounds(dt) {
  if (dt <= 0) return;
  const busy = omega.length() + (drag.active ? 1 : 0) + (live.some((it) => it.t < 1) || dying.length ? 1 : 0);
  const target = Math.max(0, 1 - busy / 1.2);
  stillness += (target - stillness) * (1 - Math.exp(-dt * (target > stillness ? 0.6 : 3)));
  nextIdle -= dt * stillness;
  if (nextIdle > 0) return;
  nextIdle = 0.8 + nativeRandom() * 2.2;
  const bodies = world.bodies.filter((b) => b.start >= 0 && b.scale > 0.9);
  if (!bodies.length) return;
  const b = bodies[Math.floor(nativeRandom() * bodies.length)];
  const size = Math.min(1, b.radius * b.scale * 2.2);
  sound.play("squish", { gain: 0.18 + 0.12 * nativeRandom(), pan: panOf(...b.c), rate: 0.6 - size * 0.12 });
}

function updateSounds() {
  if (world.version === heard) return;
  heard = world.version;
  const dt = world.stepDt;
  if (dt <= 0) return;
  const { x } = world;
  // Bodies shrinking away or swelling in move fast on purpose: no impact sounds from them.
  const changing = new Set([...dying.map((it) => it.body), ...live.filter((it) => it.t < 1).map((it) => it.body)]);
  for (const b of world.bodies) {
    if (b.start < 0 || changing.has(b)) continue;
    let m = motion.get(b);
    if (!m) {
      m = { c: [...b.c], v: [0, 0, 0], cool: 0.4, f: new Float32Array(b.fcount * 6), fcool: new Float32Array(b.fcount) };
      for (let j = 0; j < b.fcount; j++) for (let a = 0; a < 3; a++) m.f[j * 6 + a] = x[(b.fstart + j) * 3 + a];
      motion.set(b, m);
      continue;
    }
    const vx = (b.c[0] - m.c[0]) / dt, vy = (b.c[1] - m.c[1]) / dt, vz = (b.c[2] - m.c[2]) / dt;
    const dv = Math.hypot(vx - m.v[0], vy - m.v[1], vz - m.v[2]);
    m.v = [vx, vy, vz];
    m.c = [...b.c];
    m.cool -= dt;
    const size = Math.min(1, b.radius * b.scale * 2.2);
    if (m.cool <= 0 && dv > 0.45 && b.scale > 0.6) {
      const g = Math.min(1, (dv - 0.45) / 2) * size;
      const pan = panOf(...b.c);
      soundStats.squish++;
      sound.play("marble", { gain: 0.45 + g * 0.55, pan });
      // A firmer knock adds a deeper voop; a hard one wobbles the jelly.
      if (dv > 1.6) sound.play("deep", { gain: 0.5 + g * 0.5, pan, rate: 0.55 - size * 0.15 });
      if (dv > 2.4) sound.play("bounce", { gain: g, pan, rate: 1.1 - size * 0.3 });
      m.cool = 0.3;
    }
    // Floaters knocking about inside: a marble rolling against rubber.
    for (let j = 0; j < b.fcount; j++) {
      const k = (b.fstart + j) * 3, o = j * 6;
      const fx = (x[k] - m.f[o]) / dt, fy = (x[k + 1] - m.f[o + 1]) / dt, fz = (x[k + 2] - m.f[o + 2]) / dt;
      const fdv = Math.hypot(fx - m.f[o + 3], fy - m.f[o + 4], fz - m.f[o + 5]);
      m.f.set([x[k], x[k + 1], x[k + 2], fx, fy, fz], o);
      m.fcool[j] -= dt;
      if (m.fcool[j] <= 0 && fdv > 2.2 && b.floaters[j].radius < 0.3) {
        sound.play("marble", { gain: Math.min(0.6, (fdv - 2.2) / 4) + 0.3, pan: panOf(x[k], x[k + 1], x[k + 2]) });
        m.fcool[j] = 0.4;
      }
    }
  }
  for (const b of motion.keys()) if (!b.alive) motion.delete(b);
}

// When the solver gets restless (bodies thrashing or crushed out of shape), firm them up and damp them for a moment,
// then ease back to the panel's softness.
const calm = { level: 0, target: 0, hold: 0, trips: 0 };
function watchdog(dt) {
  const { speed, deviation } = world.unrest();
  // Bodies swelling in move fast on purpose; only their shape is watched then. Firming up makes its own burst of
  // speed, so speed doesn't retrigger while calming.
  const growing = live.some((it) => it.t < 1) || dying.length > 0;
  if ((!growing && calm.target === 0 && speed > 12) || deviation > 0.5) {
    if (calm.target === 0) calm.trips++;
    calm.target = 1;
    calm.hold = 0.5;
  } else if (calm.hold > 0) calm.hold -= dt;
  else calm.target = 0;
  // Eases in over a few frames and out over about a second.
  calm.level = calm.target ? Math.min(1, calm.level + dt * 8) : Math.max(0, calm.level - dt);
}

function applyPhysicsParams() {
  const s = params.softness() * (1 - 0.8 * calm.level);
  // Soft bodies keep their volume but let go of their shape: they slump, flatten against each other and bulge.
  world.volumeCompliance = 1e-5 + s * 2e-5;
  world.shapeStiffness = 0.3 * (1 - s) ** 2 + 0.001;
  world.edgeCompliance = 1e-6 + s * s * 6e-4;
  world.bending = 0.003 + 0.1 * (1 - s) ** 2;
  world.gravity = 6 + 4 * params.softness();
  world.damping = 0.3 + 4 * calm.level;
  world.skin = params.skin();
}

onRandomize(() => {
  params.look.set(pick(Object.keys(LOOKS)));
  gui.randomizeAll();
  params.look.set(params.look());
  params.shape.set(forced.shape ?? pick(Object.keys(SHAPES).filter((s) => s !== container.name)));
  // A new look always shows the container; hiding it is only by hand.
  params.container.set(true);
  // Strong refraction through barely scattering jelly looks glassy and busy: soften it a little.
  if (params.refraction() > 0.3) params.scatter.set(Math.max(params.scatter(), 0.1));
});
applyUrlState();

const key = () =>
  [params.look(), params.shape(), params.count(), params.variety(), params.fill(), params.floaters(), params.spheres(), params.cushions(), params.pills(), params.gumdrops()].join();
let built = key();
rebuild(true);
updateViews();
updateLook(1e3);

await studio;
captureLight();
updateLight(1e3);
await load.sound.track(sound.loaded);
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), volume.compile(renderer)]), 4);

window.app = {
  canvas, params, pipeline, camera, controls, world, container, volume, sound, soundStats, calm,
  // A new random look; pick may fix its look and shape: { look, shape }.
  nextLook(pick) {
    Object.assign(forced, pick ?? {});
    randomize();
    for (const k of Object.keys(forced)) delete forced[k];
  },
  steer(fn) {
    steer = fn;
  },
};

render(({ time, dt }) => {
  adaptScale(performance.now());
  autoChange.update(dt);
  if (key() !== built) {
    built = key();
    rebuild();
  }
  applyPhysicsParams();
  updateSpin(dt, time);
  updateTransitions(dt);
  world.step(dt);
  watchdog(dt);
  updateSounds();
  updateIdleSounds(dt);
  updateViews();
  updateLook(Math.max(dt, 1 / 60));
  updateLight(Math.max(dt, 1 / 60));
  controls.update();
  // The sweep turns with the camera, so the backdrop is always behind the volume.
  floor.rotation.y = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  pipeline.render(scene, camera, time);
});
