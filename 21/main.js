import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, loadSeed, getSeed, keysHelp, setDay, showHint, showSoundHint, loadingStep, addKey, addActionButton, onPause, isRunning } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector2, Vector3, Color, BoxGeometry, LatheGeometry, Raycaster, DoubleSide, Spherical } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { shapeNames, FACETED, loadSuzanne, bake, trace, sample, EXTENT, CELL } from "./shapes.js";
import { Glass } from "./glass.js";
import { Caustics } from "./caustics.js";
import { Bolt } from "./bolt.js";
import { createSound } from "./sound.js";

const BACKGROUND = 0x2a2b2e;
const SCALE = 1.15;
// A concrete slab about as wide as the glass, on a darker, recessed foot.
const SLAB = { width: 2.4, height: 0.22 };
const FOOT = { width: 2.1, height: 0.08 };
const FLOOR_Y = -SLAB.height - FOOT.height;
// The seamless backdrop: a floor disc that sweeps up into a round wall.
const CYC = { floor: 9, arc: 4 };
// A strike, in scene seconds: the charge gathers on the glass for at least this long, and until the figure is ready;
// then the leader comes down in a dash, and the stroke answers.
const CHARGE_MIN = 1.1;
const DASH = 0.08;
// A strike that hasn't landed after this long, in wall-clock seconds, is called off.
const LEADER_MAX = 10;
// How long the discharge takes to run out through the glass from where it went in, in seconds; it slows as it spreads.
const REVEAL = 1.1;

const defaults = {
  shape: "sphere",
  edge: 0.05,
  inflate: 0.2,
  density: 0.5,
  wander: 0.5,
  ior: 1.5,
  spin: 0.12,
  lamp: 0.6,
  auto: true,
  autoTime: 12,
};
const params = fromDefaults(defaults);
const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  shapes: loadingStep(1, "Casting the glass…"),
  sound: loadingStep(1, "Fetching the sounds…"),
  compile: loadingStep(4, "Compiling shaders…"),
};

const BLOOM = 0.12;
const DEBUG_CAUSTICS = new URLSearchParams(location.search).get("debug") === "caustics";
const glass = new Glass();
const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1,
  bloomStrength: BLOOM,
  vignette: 0.3,
  grain: 0.03,
  shadow: { autoFit: true, denoise: true },
  // ?debug=caustics shows the floor's light map instead of the picture.
  composite: (hdr, view) => {
    if (DEBUG_CAUSTICS) return caustics.receivers[1].target.texture;
    const light = bolt.render(renderer, view.camera, view.width, view.height);
    glass.uniforms.tBolt.value = light;
    glass.uniforms.boltOn.value = light ? 1 : 0;
    return glass.render(renderer, hdr, view);
  },
});
// The key from the side and behind, so the figure is lit against a dark room.
const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, { keyDirection: new Vector3(-0.8, 0.65, -0.45), keyIntensity: 6, keySize: 0.5, fill: 0.2, fillColor: 0xff9850, floor: 0.2, wall: 0.2 }),
);
const suzanne = load.shapes.track(loadSuzanne());

// The finer grids are for GPUs that can march them.
const GROW = { low: { G: 64, T: 192 }, medium: { G: 80, T: 288 }, high: { G: 88, T: 320 }, capture: { G: 88, T: 320 } }[pipeline.quality];
// The caustics: rays a side, and the size of each map.
const CAUSTICS = { low: { rays: 256, size: 384 }, medium: { rays: 384, size: 512 }, high: { rays: 512, size: 768 }, capture: { rays: 512, size: 768 } }[pipeline.quality];
// The stride through empty glass; near the figure the march takes the field's own distances.
glass.uniforms.stepLength.value = 0.012;

const sound = createSound({ onProgress: load.sound.set });
load.sound.track(sound.loaded);
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Shape", params.shape, shapeNames);
gui.addSlider("Edges", params.edge, 0, 0.25, 0.005, { randomizable: false, title: "How round the edges of the faceted shapes (block, cube, octahedron, dodecahedron, icosahedron) are. Changing it brings a fresh, clear object." });
gui.addSlider("Inflate", params.inflate, 0, 1, 0.01, { randomizable: false, title: "How far the faceted shapes swell, their faces bulging toward a ball. Changing it brings a fresh, clear object." });
gui.addSlider("Density", params.density, 0, 1, 0.01, { title: "How closely the figure's branches fill the glass. Low: a few long fronds. High: a thicket." });
gui.addSlider("Wander", params.wander, 0, 1, 0.01, { title: "How much the branches stray on their way. Low: straight, like frost. High: gnarled." });
gui.addSlider("Refraction", params.ior, 1.1, 2, 0.01, { randomizable: false });
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Lamp", params.lamp, 0, 1, 0.01, { randomizable: false, title: "The warm lamp in the plinth, under the glass, that lights the figure from below." });
gui.addButton("Strike", () => strikeAnywhere());
// Each object gets the auto change's seconds: struck by itself if nobody has struck it near the end, and then held
// long enough to watch the figure form before the next one.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui });
const AUTO_STRIKE = 5;
const HOLD = 6;
pipeline.addGUI(gui);
gui.addSeparator();
addKey("KeyS", "strike", () => strikeAnywhere());
addKey("KeyC", "clear the figure", () => {
  clearFigure();
  autoChange.restart();
});
addKey("KeyM", "toggle sound", toggleSound);
gui.addText(keysHelp());
showHint("Click the glass to strike it · drag to orbit · R for a new one", "Tap the glass to strike it · {randomize} for a new one");
showSoundHint(() => !sound.running);
gui.show();

// The plinth and the floor take the bolt's light as three point lights up its channel, and the figure's afterglow as a
// fourth, in the glass.
const bolt = new Bolt();
glass.uniforms.boltSpine.value = bolt.spine;
const lamps = {
  lampPosition: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
  lampColor: { value: [new Color(0, 0, 0), new Color(0, 0, 0), new Color(0, 0, 0), new Color(0, 0, 0)] },
};
// How much of the channel's light each of the three gives.
const LAMPS = [30, 70, 130];
// They are also behind the glass, as the key sees it. The key's ray from each point is walked through the object's
// distance field: where it crosses glass, the light that would have come straight is gone, and what the glass did
// with it instead comes from the caustics map of that surface.
const caustics = new Caustics(glass, { ...CAUSTICS, planes: [0, FLOOR_Y], blocker: { x: 0, y: 0, z: 0, half: SLAB.width / 2 } });
// pre: GLSL run first in surface(), to set the albedo and roughness the lighting below uses.
// stack: the receiver also takes the slab's own shadow (soft, from its box), which overriding s.shadow drops.
const receiver = ({ target, rect }, { pars = "", pre = "", stack = false } = {}) => ({
  uniforms: {
    ...lamps, glassSdf: glass.uniforms.tSdf, glassInverse: glass.uniforms.objectInverse,
    causticMap: { value: target.texture }, causticRect: { value: rect },
  },
  fragmentPars: /* glsl */ `
precision highp sampler3D;
uniform vec3 lampPosition[4];
uniform vec3 lampColor[4];
uniform sampler3D glassSdf;
uniform mat4 glassInverse;
uniform sampler2D causticMap;
uniform vec4 causticRect;
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(0.0, 1.0);
  return mix(mix(mix(hash3(i), hash3(i + o.yxx), f.x), mix(hash3(i + o.xyx), hash3(i + o.yyx), f.x), f.y),
    mix(mix(hash3(i + o.xxy), hash3(i + o.yxy), f.x), mix(hash3(i + o.xyy), hash3(i + o.yyy), f.x), f.y), f.z);
}
${pars}
float boxSd(vec3 p, vec3 c, vec3 b) {
  vec3 q = abs(p - c) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float stackSd(vec3 p) {
  return min(boxSd(p, vec3(0.0, ${(-SLAB.height / 2).toFixed(3)}, 0.0), vec3(${(SLAB.width / 2).toFixed(3)}, ${(SLAB.height / 2).toFixed(3)}, ${(SLAB.width / 2).toFixed(3)})),
    boxSd(p, vec3(0.0, ${(-SLAB.height - FOOT.height / 2).toFixed(3)}, 0.0), vec3(${(FOOT.width / 2).toFixed(3)}, ${(FOOT.height / 2).toFixed(3)}, ${(FOOT.width / 2).toFixed(3)})));
}
// Soft shadow of the slab and its foot, penumbra by the key's size.
float stackShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.02;
  for (int i = 0; i < 32; i++) {
    float h = stackSd(ro + rd * t);
    res = min(res, h / (t * 0.12));
    t += clamp(h, 0.02, 0.4);
    if (res < 0.0 || t > 8.0) break;
  }
  return smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}
`,
  surface: /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
  s.specular = 0.15;
  ${pre}
  vec3 n = normalize(s.normal);
  vec3 p = (glassInverse * vec4(vWorldPosition, 1.0)).xyz;
  // The flash throws the glass's shadow too: hard, and away from the channel.
  float lit = 1.0;
  if (lampColor[1].b > 0.001) {
    vec3 toLamp = normalize(mat3(glassInverse) * (lampPosition[1] - vWorldPosition));
    float glass = 0.0;
    for (int i = 0; i < 26; i++) {
      vec3 q = p + toLamp * (0.03 + float(i) * 0.08);
      if (max(abs(q.x), max(abs(q.y), abs(q.z))) > ${(EXTENT - CELL).toFixed(4)}) continue;
      glass += 0.08 * smoothstep(0.02, -0.02, textureLod(glassSdf, q * ${(0.5 / EXTENT).toFixed(6)} + 0.5, 0.0).r);
    }
    lit = 1.0 - 0.75 * smoothstep(0.0, 0.1, glass);
  }
  for (int i = 0; i < 4; i++) {
    vec3 d = lampPosition[i] - vWorldPosition;
    float l2 = dot(d, d);
    s.emissive += s.albedo * lampColor[i] * max(dot(n, d) * inversesqrt(l2), 0.0) / (l2 + 0.15) * (i < 3 ? lit : 1.0);
  }
  vec3 d = normalize(mat3(glassInverse) * normalize(lightDirection));
  float thickness = 0.0;
  for (int i = 0; i < 44; i++) {
    vec3 q = p + d * (0.03 + float(i) * 0.06);
    if (max(abs(q.x), max(abs(q.y), abs(q.z))) > ${(EXTENT - CELL).toFixed(4)}) continue;
    thickness += 0.06 * smoothstep(0.02, -0.02, textureLod(glassSdf, q * ${(0.5 / EXTENT).toFixed(6)} + 0.5, 0.0).r);
  }
  s.shadow = 1.0 - smoothstep(0.0, 0.2, thickness);
  ${stack ? "s.shadow *= stackShadow(vWorldPosition, normalize(lightDirection));" : ""}
  // The map holds irradiance on a level surface, in units of the key's.
  vec2 uv = (vWorldPosition.xz - causticRect.xy) * causticRect.z + 0.5;
  if (n.y > 0.5 && uv == clamp(uv, 0.0, 1.0)) s.emissive += s.albedo * lightColor * textureLod(causticMap, uv, 0.0).r * 0.3183;
#endif
}
`,
});
const scene = new Scene();
// Cast concrete: mottled, with fine pits that hold less light.
const concrete = /* glsl */ `
  vec3 cp = vWorldPosition;
  // Octaves on rotated, offset lattices, so no grid shows through.
  const mat3 turn = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  vec3 cq = cp * 1.7;
  float mottle = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++) {
    mottle += amp * vnoise(cq);
    cq = turn * cq * 2.13 + 7.31;
    amp *= 0.5;
  }
  float grain = vnoise(turn * cp * 260.0) - 0.5;
  float pits = smoothstep(0.9, 0.95, vnoise(turn * turn * cp * 120.0 + 3.1));
  s.albedo *= (0.9 + 0.2 * (mottle - 0.47)) * (1.0 + 0.08 * grain) * (1.0 - 0.35 * pits);
  s.roughness = clamp(s.roughness + (mottle - 0.47) * 0.1, 0.0, 1.0);
`;
const slab = new Mesh(new BoxGeometry(SLAB.width, SLAB.height, SLAB.width), new PipelineMaterial({ color: 0x6d6b68, roughness: 0.85, ...receiver(caustics.receivers[0], { pre: concrete }) }));
slab.position.y = -SLAB.height / 2;
const foot = new Mesh(new BoxGeometry(FOOT.width, FOOT.height, FOOT.width), new PipelineMaterial({ color: 0x161616, roughness: 0.8 }));
foot.position.y = -SLAB.height - FOOT.height / 2;

function cycGeometry() {
  const points = [];
  for (let i = 0; i <= 12; i++) points.push(new Vector2((CYC.floor * i) / 12, FLOOR_Y));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(CYC.floor + CYC.arc * Math.sin(a), FLOOR_Y + CYC.arc * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 6; i++) points.push(new Vector2(CYC.floor + CYC.arc, FLOOR_Y + CYC.arc + i * 6));
  return new LatheGeometry(points, 128);
}
const backdrop = new Mesh(cycGeometry(), new PipelineMaterial({ color: 0x4a4a4a, roughness: 0.95, side: DoubleSide, ...receiver(caustics.receivers[1], { stack: true }) }));
scene.add(slab, foot, backdrop);

camera.position.set(0.7, 0.6, 5.6);
controls.target.set(0, 0.95, 0);
controls.minDistance = 3;
controls.maxDistance = 8.5;
controls.maxPolarAngle = 1.66;
controls.minPolarAngle = 0.35;

// Left alone, the camera comes round to show the strike: in front of the glass, so the key backlights the figure, low,
// a little to one side (a different side for each object), swaying slowly. Any input hands it back.
const IDLE = 4;
const view = { azimuth: 0.12, polar: 1.63, radius: 5.6, idle: IDLE };
const CAPTURE = new URLSearchParams(location.search).has("capture");
for (const e of ["pointerdown", "wheel", "keydown"]) addEventListener(e, () => (view.idle = 0), { capture: true, passive: true });
const _orbit = new Spherical(), _goal = new Spherical();
function frameCamera(dt, time) {
  view.idle += dt;
  if (CAPTURE || view.idle < IDLE) return;
  const k = 1 - Math.exp(-dt / 1.6);
  controls.target.y += (center.y * 0.92 - controls.target.y) * k;
  controls.target.x += -controls.target.x * k;
  controls.target.z += -controls.target.z * k;
  _orbit.setFromVector3(_o.copy(camera.position).sub(controls.target));
  _goal.set(view.radius, view.polar + 0.03 * Math.sin(time * 0.11), view.azimuth + 0.1 * Math.sin(time * 0.13));
  let turn = _goal.theta - _orbit.theta;
  turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
  _orbit.theta += turn * k;
  _orbit.phi += (_goal.phi - _orbit.phi) * k;
  _orbit.radius += (_goal.radius - _orbit.radius) * k;
  camera.position.setFromSpherical(_orbit).add(controls.target);
}
onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

// phase: clear (waiting to be struck), leader (the bolt coming down while the figure grows), struck.
const state = { phase: "clear", shape: null, grid: null, minY: 0, angle: 0, job: 0, start: 0, wall: 0, dash: -1, at: 0, entry: null, strokes: null, result: null };
const center = new Vector3();
// One job at a time, and a job can't be told to stop: a strike that is called off takes its worker with it, so the
// next one never waits behind it.
let worker = null;
function startWorker() {
  worker = new Worker(new URL("./grow.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.id !== state.job || state.phase !== "leader") return;
    if (data.error) abandon(`the figure failed to grow: ${data.error}`);
    else state.result = data;
  };
  worker.onerror = (e) => abandon(`the growth worker failed: ${e.message}`);
}
startWorker();
// Calls off a strike that is on its way, rather than leave it humming: the object stays clear, to be struck again.
function abandon(reason) {
  if (reason) console.error(`Bolt: ${reason}`);
  if (state.phase !== "leader") return;
  Object.assign(state, { phase: "clear", job: state.job + 1, result: null });
  bolt.clear();
  sound.stopLeader();
  worker.terminate();
  startWorker();
}
// The leader runs on scene time, which a pause stops: a strike on its way is called off, and none starts while paused.
onPause((running) => !running && abandon());

// What the object is made from: a change in any of it makes a new one.
const shapeKey = () => `${params.shape()} ${FACETED.includes(params.shape()) ? `${params.edge()} ${params.inflate()}` : ""}`;
// The object as it was before it was struck: no figure, no bolt, ready to be struck again.
function clearFigure() {
  abandon();
  Object.assign(state, { phase: "clear", job: state.job + 1, result: null });
  glass.uniforms.figure.value = 0;
  glass.uniforms.glow.value = 0;
  glass.uniforms.flash.value = 0;
  bolt.clear();
  sound.stopStrike();
  for (const c of lamps.lampColor.value) c.setRGB(0, 0, 0);
}
function newObject() {
  clearFigure();
  const { grid, minY } = bake(params.shape(), params.edge(), params.inflate());
  Object.assign(state, { shape: shapeKey(), grid, minY });
  glass.setShape(grid, params.shape(), params.edge(), params.inflate());
  center.set(0, -minY * SCALE, 0);
  view.azimuth = (nativeRandom() < 0.5 ? -1 : 1) * (0.1 + nativeRandom() * 0.35);
  glass.uniforms.basePoint.value.set(0, minY + 0.02, 0);
}

const raycaster = new Raycaster();
const _o = new Vector3(), _d = new Vector3(), _hit = new Vector3(), _n = new Vector3();
// The object's surface under a point of the screen (NDC), in the object's own space.
function pick(x, y) {
  raycaster.setFromCamera(new Vector2(x, y), camera);
  _o.copy(raycaster.ray.origin).sub(center).applyAxisAngle(UP, -state.angle).divideScalar(SCALE);
  _d.copy(raycaster.ray.direction).applyAxisAngle(UP, -state.angle);
  return trace(state.grid, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z);
}
const UP = new Vector3(0, 1, 0);
// A world point put back on the glass's surface, lifted off it by `lift` (object units), and the normal there.
bolt.surface = (p, lift) => {
  const g = state.grid;
  if (!g) return null;
  const o = _so.copy(p).sub(center).applyAxisAngle(UP, -state.angle).divideScalar(SCALE);
  const e = CELL;
  for (let k = 0; k < 4; k++) {
    const d = sample(g, o.x, o.y, o.z);
    _sn.set(sample(g, o.x + e, o.y, o.z) - sample(g, o.x - e, o.y, o.z), sample(g, o.x, o.y + e, o.z) - sample(g, o.x, o.y - e, o.z), sample(g, o.x, o.y, o.z + e) - sample(g, o.x, o.y, o.z - e)).normalize();
    o.addScaledVector(_sn, -d);
  }
  o.addScaledVector(_sn, lift);
  return { point: toWorld([o.x, o.y, o.z], new Vector3()), normal: _sn.clone().applyAxisAngle(UP, state.angle) };
};
const _so = new Vector3(), _sn = new Vector3();
const toWorld = (p, out) => out.set(p[0], p[1], p[2]).multiplyScalar(SCALE).applyAxisAngle(UP, state.angle).add(center);

let now = 0;
// Strikes wait for the first frame: before it there may be no object, and no sound may play.
let started = false;
function strike(hit) {
  if (!started || state.phase !== "clear" || !hit || !isRunning()) return false;
  const seed = Math.floor(Math.random() * 2 ** 31);
  Object.assign(state, { phase: "leader", start: now, wall: performance.now(), dash: -1, entry: hit.point, normal: hit.normal, result: null, job: state.job + 1 });
  state.strokes = bolt.strike(toWorld(hit.point, _hit), seededRandom(seed));
  worker.postMessage({
    id: state.job, grid: state.grid, entry: hit.point, normal: hit.normal, seed,
    branches: 120 + 560 * params.density(), wander: params.wander() * 1.4, T: GROW.T,
  });
  sound.leader();
  autoChange.hold(HOLD);
  return true;
}
// Somewhere on the side the camera sees, toward the top, where a bolt from above would land.
function strikeAnywhere() {
  if (!started || state.phase !== "clear") return;
  const c = center.clone().project(camera);
  let best = null;
  for (let i = 0; i < 40; i++) {
    const hit = pick(c.x + (Math.random() - 0.5) * 0.5, c.y + (Math.random() - 0.3) * 0.6);
    if (hit && (!best || hit.point[1] > best.point[1])) best = hit;
    if (best && i > 12) break;
  }
  strike(best);
}

const canvas = renderer.domElement;
// Only a single primary-button press strikes: a second finger (a pinch) or another button cancels it.
const press = { x: 0, y: 0, time: 0, id: null };
canvas.addEventListener("pointerdown", (e) =>
  Object.assign(press, { x: e.clientX, y: e.clientY, time: performance.now(), id: e.isPrimary && e.button === 0 ? e.pointerId : null }),
);
canvas.addEventListener("pointercancel", () => (press.id = null));
canvas.addEventListener("pointerup", (e) => {
  const tap = e.pointerId === press.id;
  press.id = null;
  // A click, not the end of a drag.
  if (!tap || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 || performance.now() - press.time > 500) return;
  const rect = canvas.getBoundingClientRect();
  strike(pick(((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2));
});

// Ignored until the shapes have loaded; the object is built from the params then.
// R during that wait still picks the seed (and puts it in the url): it is replayed once the shapes are in.
let booted = false;
let randomizedEarly = false;
onRandomize(() => {
  if (!booted) return void (randomizedEarly = true);
  const was = params.shape();
  gui.randomizeAll();
  // Always another shape.
  if (params.shape() === was) {
    const others = shapeNames.filter((name) => name !== was);
    params.shape.set(others[Math.floor(Math.random() * others.length)]);
  }
  newObject();
});
// Every shape is needed before the url's seed and params are applied: the seed's handler builds the object.
await suzanne;
booted = true;
applyUrlState();
if (randomizedEarly) loadSeed(getSeed());
newObject();
await studio;
// A cool key; the fill (and so the room on the other side) is warm.
globalUniforms.lightColor.value.multiply(new Color(0.75, 0.9, 1.15));
await load.compile.track(Promise.all([pipeline.compileAsync(scene, camera), glass.compile(renderer), caustics.compile(renderer), bolt.compile(renderer, camera)]), 4);
// The page works without its sounds.
await sound.loaded.catch((e) => console.error(`Bolt: the sounds failed to load: ${e}`));

// A handle for recording tools (the social-video skill) and the console.
window.app = {
  canvas: renderer.domElement, params, pipeline, camera, controls, strike: strikeAnywhere, state, sound, center,
  // A new clear object of this shape, turned to this angle about the vertical (radians; 0 shows its front to +z).
  show(shape, angle = 0) {
    params.shape.set(shape);
    newObject();
    state.angle = angle;
  },
};

const flashColor = glass.uniforms.flashColor.value;
const glowColor = glass.uniforms.glowColor.value;
const BASE = new Color(1.0, 0.62, 0.3), ARC = new Color(0.45, 0.6, 1.0), _c = new Color();
const HOT = new Color(0.3, 0.55, 1.0), COOL = new Color(0.12, 0.25, 1.0);

let bloom = BLOOM, flashBloom = 0;
let pendingShape = null, pendingSince = 0;
function frame({ time, dt }) {
  started = true;
  now = time;
  autoChange.update(dt);
  if (state.phase === "clear" && autoChange.remaining < Math.min(AUTO_STRIKE, params.autoTime() * 0.6)) strikeAnywhere();
  // Edges and Inflate rebake the whole grid: a drag rebuilds once it rests. A new shape goes at once.
  const wantShape = shapeKey();
  if (wantShape !== state.shape) {
    if (wantShape !== pendingShape) (pendingShape = wantShape), (pendingSince = performance.now());
    if (wantShape.split(" ")[0] !== state.shape?.split(" ")[0] || performance.now() - pendingSince > 150) newObject();
  }
  state.angle += dt * params.spin();
  glass.setPose(center, state.angle, SCALE);
  glass.uniforms.ior.value = params.ior();
  const occluder = globalUniforms.occluders.value[0];
  occluder.set(center.x, center.y, center.z, 0.75 * SCALE);
  globalUniforms.occluderCount.value = 1;
  globalUniforms.occluderStrength.value = 0.5;

  const u = glass.uniforms;
  if (state.phase === "leader" && state.result && state.dash < 0 && time - state.start > CHARGE_MIN) state.dash = time;
  if (state.phase === "leader" && state.dash >= 0 && time - state.dash > DASH) {
    state.phase = "struck";
    state.at = time;
    sound.strike(state.strokes, REVEAL);
    autoChange.hold(HOLD);
    glass.setFigure(state.result.data, state.result.T, state.result.arrival);
    u.figure.value = 1;
  }
  // Only for want of a figure: one that is ready lands, however long the page was away.
  if (state.phase === "leader" && !state.result && performance.now() - state.wall > LEADER_MAX * 1000) abandon("the figure took too long to grow");
  let flash = 0, glow = 0, arcs = 0;
  if (state.phase !== "clear") {
    const hit = toWorld(state.entry, _hit);
    if (state.phase === "leader") {
      const charge = Math.min(1, (time - state.start) / CHARGE_MIN);
      _n.fromArray(state.normal).applyAxisAngle(UP, state.angle);
      bolt.leader(state.dash < 0 ? 0 : (time - state.dash) / DASH, time, hit, charge, _n);
      // The arcs light the room, flickering.
      arcs = charge * (0.6 + 0.4 * nativeRandom());
    } else {
      const e = time - state.at;
      const x = e / REVEAL;
      u.grown.value = x < 1 ? 1 - (1 - x) ** 1.8 : x;
      _n.fromArray(state.normal).applyAxisAngle(UP, state.angle);
      if (bolt.active) flash = bolt.struck(e, time, hit, _n);
      glow = Math.exp(-e / 2.2);
    }
    lamps.lampPosition.value[0].copy(bolt.spine[0]).addScaledVector(UP, 0.12);
    lamps.lampPosition.value[1].copy(bolt.spine[2]);
    lamps.lampPosition.value[2].copy(bolt.spine[4]);
    for (let i = 0; i < 3; i++) lamps.lampColor.value[i].copy(flashColor).multiplyScalar(flash * LAMPS[i]);
    if (arcs > 0) {
      lamps.lampPosition.value[0].copy(hit).addScaledVector(_n, 0.15);
      lamps.lampColor.value[0].copy(ARC).multiplyScalar(arcs * 5);
    }

    // The channel on screen, for the air it lights.
    const chord = u.boltChord.value;
    _o.copy(bolt.spine[0]).project(camera);
    chord.x = (_o.x * 0.5 + 0.5) * camera.aspect;
    chord.y = _o.y * 0.5 + 0.5;
    _o.copy(bolt.spine[4]).project(camera);
    chord.z = (_o.x * 0.5 + 0.5) * camera.aspect;
    chord.w = _o.y * 0.5 + 0.5;
  }
  u.flash.value = flash * 6;
  u.white.value = bolt.active ? bolt.white : 0;
  // The flash blooms, over whatever the panel's bloom is set to.
  if (flashBloom === 0) bloom = pipeline.bloomStrength;
  flashBloom = Math.min(flash, 1.2) * 0.3 + arcs * 0.12;
  pipeline.bloomStrength = bloom + flashBloom;
  u.glow.value = glow * 6;
  // The lamp under the glass: the figure scatters it, so once there is one it lights the slab and the haze.
  u.baseColor.value.copy(BASE).multiplyScalar(params.lamp() * 4);
  lamps.lampPosition.value[3].set(0, center.y * 0.6, 0);
  lamps.lampColor.value[3].copy(BASE).multiplyScalar(params.lamp() * u.figure.value * Math.min(u.grown.value, 1) * 0.6).add(_c.copy(glowColor).multiplyScalar(glow * 1.5));
  u.haloColor.value.copy(BASE).multiplyScalar(params.lamp() * u.figure.value * Math.min(u.grown.value, 1) * 1.5).add(_c.copy(glowColor).multiplyScalar(glow * 1.5));
  // The afterglow goes from a pale blue to a deep one as it fades.
  glowColor.copy(COOL).lerp(HOT, glow * glow);

  caustics.render(renderer, `${state.shape} ${state.angle} ${u.figure.value ? state.job : 0} ${params.ior()}`);
  frameCamera(dt, time);
  controls.update();
  pipeline.render(scene, camera, time);
}
render(frame);
