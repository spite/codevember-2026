import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, loadingStep, getSeed, addKey, addActionButton, randomize, onPause, showSoundHint } from "common";
import { GUI, signal } from "guspira";
import { Scene, Group, Vector3, Vector4, Color, Raycaster, Vector2, Matrix4, Quaternion, Mesh, SphereGeometry, ShaderMaterial, BackSide } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync, applyEnvironment } from "modules/pipeline/studio.js";
import { createAutoChange } from "modules/autoChange.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { KNOT_CURVES, knotLine, centreLine, frameAt, straightLine, clearance, tubeArea, tubeGeometry } from "./tube.js";
import { DS, Swimmer, Spine, curlSteer } from "./motion.js";
import { createFeathers, createSpine } from "./feathers.js";
import { createSound } from "./sound.js";

// Feather colours, as pigment over the white keratin: downy base, body, dark markings, accent.
const PALETTES = {
  white: ["#ffffff", "#ffffff", "#dcdad6", "#ffffff"],
  pheasant: ["#efe4d2", "#c98a3e", "#2a1d14", "#e8b35a"],
  owl: ["#efe8dc", "#b9a083", "#3c2e24", "#f1e5cf"],
  dove: ["#eeece9", "#a8a5a2", "#3e3c3b", "#dad7d3"],
  jay: ["#e9eef3", "#a8a29c", "#1e2b3f", "#5584bd"],
  flamingo: ["#ffe9e2", "#f2a094", "#5a2e2a", "#f8c8bc"],
  golden: ["#fff4d9", "#dca553", "#6c4220", "#f2d59e"],
  ink: ["#f6f6f4", "#c8c8c6", "#121212", "#f6f6f4"],
  // White, flecked brown (a snowy owl's or a pale hawk's).
  snowy: ["#ffffff", "#f5f2ed", "#6e5848", "#dccbb6"],
};
const PATTERNS = ["plain", "gradient", "barred", "streaked", "mottled", "mixed"];

// Light: a pale high-key studio. Dark: a near-black set, raked from the side. Both keyed from the camera's side (the
// camera stays put and the form turns), so what's seen is lit.
const LOOKS = {
  // backgroundGain lifts the backdrop above 1 (linear), so after AgX it reads as the paper white it is.
  light: {
    background: "#f3f2ef",
    backgroundGain: 2.2,
    exposure: 1,
    // Half strength: a white coat fills its own crevices with light, so they never go dark like dirt.
    ao: 0.5,
    aoMin: 0.1,
    shadowSoftness: 1,
    // The shadows' light size (tan of its angular radius): the softbox is big, but a light that wide would wash out
    // every shadow a feather casts.
    shadowLightSize: 0.07,
    bloom: 0.015,
    vignette: 0.04,
    contrast: 1.08,
    // The studio around it as bright as the backdrop it's seen against (a white cyc), so the shaded side is lit by it.
    studio: { keyDirection: new Vector3(0.65, 0.6, 0.45), keyIntensity: 13, keySize: 0.5, fill: 0.9, floor: 0.95, wall: 0.95, ceiling: 0.6 },
  },
  dark: {
    background: "#0e0d0c",
    backgroundGain: 1,
    exposure: 1,
    ao: 0.6,
    aoMin: 0.05,
    shadowSoftness: 1.75,
    shadowLightSize: 0.09,
    bloom: 0.035,
    vignette: 0.18,
    contrast: 1,
    studio: { keyDirection: new Vector3(0.75, 0.55, 0.15), keyIntensity: 28, keySize: 0.6, fill: 0.18, floor: 0.04, wall: 0.025 },
  },
};

const defaults = {
  shape: "knot",
  p: 2,
  q: 3,
  curlLength: 16,
  curliness: 0.32,
  room: 1,
  taper: 0.6,
  speed: 0.3,
  ringRadius: 2.2,
  knotSize: 2.6,
  thickness: 0.45,
  palette: "white",
  pattern: "mixed",
  patternAmount: 0.56,
  featherLength: 1.43,
  featherWidth: 1.27,
  density: 350,
  feathers: 9000,
  underLayer: false,
  underShade: 1,
  internalShadow: 0.56,
  gradientAmount: 0,
  gradientRepeat: 1,
  ruffle: 0,
  curl: 1.5,
  angle: 1.89,
  lean: 0,
  seeThrough: 1,
  spin: 0.25,
  look: "light",
  shadows: "stochastic",
  backdrop: 0.35,
  shadowLight: 0.6,
  auto: true,
  autoTime: 10,
  transition: "morph",
};
const params = fromDefaults(defaults);
const load = { layout: loadingStep(1), studio: loadingStep(1), compile: loadingStep(4) };

// Temporal antialiasing (one jittered sample per pixel, resolved over frames) instead of MSAA, so the stochastic
// transparency and shadows average out in motion too; ?taa=0 goes back to MSAA for comparison.
const temporal = new URLSearchParams(location.search).get("taa") !== "0";
const pipeline = new Pipeline(renderer, {
  temporal: temporal ? { feedback: 0.9 } : undefined,
  background: LOOKS.light.background,
  exposure: 1,
  bloomStrength: 0.03,
  vignette: 0.12,
  grain: 0.02,
  // Averages paused frames, so the stochastic transparency and shadows converge.
  stillSamples: 32,
  shadow: { autoFit: true, denoise: true, mask: { maxHistory: 16, historyClamp: 3, pcfSamples: 32 } },
  // Feather-scale AO: a short reach and an edge-preserving blur, so it darkens each overlap rather than smudging.
  giOptions: { thickness: 0.1, radius: 0.35, blurPasses: 1, normalPower: 32, planeSigma: 0.005 },
});
// Light through feathers: the key's specular comes from the environment's softbox (not twice), thin sheets are
// shadowed from the side the light reaches, feather layers pass part of the key (warmly), and a white coat fills its
// own crevices with interreflections.
globalUniforms.lightSpecular.value = 0;
globalUniforms.specularShadow.value = 1;
globalUniforms.shadowTwoSided.value = 1;
globalUniforms.shadowNormalBias.value = 0.006;
globalUniforms.aoMultiBounce.value = 1;
globalUniforms.giIntensity.value = 1.2;

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
const knotOnly = { visibleWhen: () => params.shape() === "knot" };
const anyKnot = { visibleWhen: () => params.shape() !== "torus" && params.shape() !== "curl" };
gui.addSection("Form");
// The curl (a line swimming through a curl field) is kept, but not offered for now.
// Torus, torus knots (windings and loops), and other classic knots.
const SHAPES = [["torus", "torus"], ["knot", "torus knot"], ...Object.keys(KNOT_CURVES).map((k) => [k, k])];
// The centre line of a closed shape, size: its ring radius or knot size.
const lineFor = (shape, size, p, q, n) => (shape === "torus" ? centreLine(1, 0, size, n) : shape === "knot" ? centreLine(p, q, size, n) : knotLine(shape, size, n));
// Never the shape already on show.
gui.addSelect("Shape", params.shape, SHAPES).randomize = () => {
  const weights = { torus: 0.1, knot: 0.25, trefoil: 0.2, "figure-eight": 0.15, saddle: 0.1, crown: 0.1, star: 0.1 };
  delete weights[params.shape()];
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b);
  for (const [k, w] of Object.entries(weights)) if ((r -= w) < 0) return params.shape.set(k);
};
// Windings round the axis and through the hole; equal or sharing a factor gives a link, not a knot.
// Randomized toward full, chunky forms: knots with few crossings, sized up so the tube can be thick, and as thick as
// they allow; fat rings.
const KNOTS = [[2, 3], [2, 3], [2, 3], [3, 2], [3, 2], [2, 5], [3, 4]];
gui.addSlider("Windings", params.p, 1, 7, 1, knotOnly).randomize = () => {
  const [p, q] = KNOTS[Math.floor(Math.random() * KNOTS.length)];
  params.p.set(p);
  params.q.set(q);
};
gui.addSlider("Loops", params.q, 1, 9, 1, { ...knotOnly, randomizable: false });
const torusOnly = { visibleWhen: () => params.shape() === "torus" };
const curlOnly = { visibleWhen: () => params.shape() === "curl" };
gui.addSlider("Ring radius", params.ringRadius, 1.2, 3, 0.01, torusOnly).randomize = () => params.ringRadius.set(Math.round((1.5 + 0.7 * Math.random()) * 100) / 100);
gui.addSlider("Knot size", params.knotSize, 1.5, 3.5, 0.01, anyKnot).randomize = () => params.knotSize.set(Math.round((2.6 + 0.8 * Math.random()) * 100) / 100);
// Curl: a line traced through a curl-noise field: how long, how tightly it winds, how much room it has, and how
// much thinner its tail is than its head.
gui.addSlider("Length", params.curlLength, 6, 40, 0.5, curlOnly);
gui.addSlider("Curliness", params.curliness, 0.1, 0.8, 0.01, curlOnly);
gui.addSlider("Room", params.room, 0.6, 2, 0.01, curlOnly);
gui.addSlider("Taper", params.taper, 0, 0.9, 0.01, curlOnly);
// How fast it swims along its path (it slides through its own trail, feathers and all).
gui.addSlider("Speed", params.speed, 0, 1.5, 0.01, { randomizable: false, ...curlOnly });
gui.addSlider("Thickness", params.thickness, 0.2, 0.8, 0.01).randomize = () => {
  // A knot's tube about a seventh of its size (never more than it allows); a ring's (plain or waved) about a quarter of
  // its radius.
  const shape = params.shape();
  const ring = ["torus", "saddle", "crown"].includes(shape);
  const size = shape === "torus" ? params.ringRadius() : params.knotSize();
  const cap = shape === "torus" ? 0.34 * size : Math.min(0.34 * size, 0.38 * clearance(lineFor(shape, size, params.p(), params.q(), 256)));
  const most = Math.min(cap, size * (ring ? 0.25 + 0.08 * Math.random() : 0.12 + 0.06 * Math.random()) / 0.9);
  params.thickness.set(Math.round(most * (0.8 + 0.2 * Math.random()) * 100) / 100);
};
gui.addSection("Feathers");
// Mostly the coloured palettes; white now and then (truly white), the greys rarely.
gui.addSelect("Palette", params.palette, Object.keys(PALETTES)).randomize = () => {
  const weights = { white: 2, pheasant: 3, golden: 3, flamingo: 3, jay: 3, owl: 2, snowy: 1, dove: 1, ink: 1 };
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b);
  for (const [k, w] of Object.entries(weights)) if ((r -= w) < 0) return params.palette.set(k);
};
// Each feather's own colouring: a pale base, then a gradient, bars, a streak or mottling (mixed: each its own).
// Randomized so it's never a bland mid-grey: white stays white (plain or a faint pattern); any colour gets a clear
// pattern and a strong gradient.
const white = () => params.palette() === "white";
gui.addSelect("Pattern", params.pattern, PATTERNS).randomize = () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  params.pattern.set(white() ? pick(["plain", "plain", "gradient"]) : pick(["gradient", "gradient", "gradient", "barred", "barred", "mottled", "mixed"]));
};
gui.addSlider("Pattern amount", params.patternAmount, 0, 1, 0.01).randomize = () => {
  // Colours stay very subtle (the gradient carries them); white takes more, as it barely shows.
  params.patternAmount.set(Math.round((white() ? 0.4 + 0.2 * Math.random() : 0.08 * Math.random()) * 100) / 100);
}
// How many feathers: Density per unit of the form's area, up to Max feathers; they are sized to cover the form, then
// stretched by length and width (roots stay put).
gui.addSlider("Density", params.density, 20, 600, 1, { randomizable: false });
gui.addSlider("Max feathers", params.feathers, 2000, 40000, 500, { randomizable: false });
gui.addSlider("Feather length", params.featherLength, 0.5, 2, 0.01).randomize = () => params.featherLength.set(Math.round((1.35 + 0.15 * Math.random()) * 100) / 100);
gui.addSlider("Feather width", params.featherWidth, 0.5, 2, 0.01).randomize = () => params.featherWidth.set(Math.round((1.2 + 0.15 * Math.random()) * 100) / 100);
// Short, wide, flat feathers under the coat, so its gaps show feathers rather than skin.
gui.addCheckbox("Under-layer", params.underLayer, { randomizable: false });
gui.addSlider("Under-layer shade", params.underShade, 0, 1, 0.01, { randomizable: false, visibleWhen: () => params.underLayer() });
// Randomized close to the default look: barely ruffled, curled and lifted, lying straight.
gui.addSlider("Ruffle", params.ruffle, 0, 1.5, 0.01).randomize = () => params.ruffle.set(Math.round(0.15 * Math.random() * 100) / 100);
gui.addSlider("Curl", params.curl, 0, 1.5, 0.01).randomize = () => params.curl.set(Math.round((1.3 + 0.2 * Math.random()) * 100) / 100);
gui.addSlider("Angle", params.angle, 0.3, 3, 0.01).randomize = () => params.angle.set(Math.round((1.85 + 0.4 * Math.random()) * 100) / 100);
gui.addSlider("Lean", params.lean, -1, 1, 0.01).randomize = () => params.lean.set(Math.round((Math.random() - 0.5) * 10) / 100);
// How much a feather lets you see through it: barb gaps, thin margins and down (stochastic transparency).
// How much each feather's base, covered by the ones in front, darkens.
gui.addSlider("Internal shadow", params.internalShadow, 0, 1, 0.01, { randomizable: false });
gui.addSlider("See-through", params.seeThrough, 0, 1, 0.01, { randomizable: false });
// Along the form the palette's body colour shifts toward its dark one: round a torus or knot (whole cycles), head
// to tail on a curl (and back, repeated).
gui.addSlider("Gradient", params.gradientAmount, 0, 1, 0.01).randomize = () => params.gradientAmount.set(Math.round((white() ? 0 : 0.35 + 0.15 * Math.random()) * 100) / 100);
gui.addSlider("Repeat", params.gradientRepeat, 1, 8, 1).randomize = () => params.gradientRepeat.set(1 + Math.floor(Math.random() * 2));
gui.addSection("Light");
gui.addSegmented("Look", params.look, Object.keys(LOOKS), { randomizable: false });
// How much the backdrop darkens toward the edges (0: flat).
gui.addSlider("Backdrop", params.backdrop, 0, 0.8, 0.01, { randomizable: false });
gui.addSegmented("Shadows", params.shadows, ["opaque", "translucent", "stochastic"], { randomizable: false });
// The light one layer of feathers passes on to what's under it (translucent and stochastic shadows).
gui.addSlider("Shadow light", params.shadowLight, 0, 0.9, 0.01, { randomizable: false, visibleWhen: () => params.shadows() !== "opaque" });
gui.addSlider("Spin", params.spin, 0, 0.5, 0.01, { randomizable: false });
// How a new variation comes in: the form morphs into it, or shrinks away and the new one grows.
gui.addSegmented("Transition", params.transition, ["morph", "shrink"], { randomizable: false });
// Performance: frames per second, the time the GPU spends on a frame (when the browser can measure it; otherwise the
// time between frames, which can't go below the screen's refresh), feathers drawn, and about how many this device
// could draw at 60 fps (feather cost scaled to the frame budget; optimistic, as some of a frame doesn't scale).
gui.addSection("Performance", { open: false });
const stats = { fps: signal(0), ms: signal("–"), feathers: signal(0), budget: signal("–"), next: signal("–") };
gui.addMonitor("FPS", stats.fps);
gui.addMonitor("Frame", stats.ms);
gui.addMonitor("Feathers drawn", stats.feathers);
gui.addMonitor("At 60 fps", stats.budget);
gui.addMonitor("Next build", stats.next);
gui.endSection();
// The running average of the 60 fps estimate caps the next build; until there is one, the tier's cap (none under capture).
const perf = { sum: 0, n: 0 };
function featherBudget() {
  if (pipeline.quality === "capture") return Infinity;
  if (perf.n) return Math.max(2000, perf.sum / perf.n);
  return pipeline.quality === "high" ? Infinity : 6000;
}
// Sound: breathing and the rustle of the plumage, synthesized.
const sound = createSound();
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Pausing stops only the spin (and auto change): the plumage keeps breathing, rousing and answering the pointer.
let paused = false;
onPause((running) => (paused = !running));
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, ready: () => !morph && !change && !building() });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Drag to turn it · scroll to zoom · move close to stir the feathers · R for a new one", "Drag to turn it · touch to stir the feathers · tap {randomize} for a new one");
showSoundHint(() => !sound.running);
gui.show();

const scene = new Scene();
// The backdrop: the background colour, lit at the centre (a little above the form) and falling off toward the edges,
// like a studio sweep. Drawn behind everything (a huge inward sphere), outside the pipeline's lighting.
const backdrop = new Mesh(
  new SphereGeometry(500, 32, 16),
  new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: { base: { value: pipeline.background }, falloff: { value: 0.35 }, resolution: globalUniforms.resolution },
    vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 base;
      uniform float falloff;
      uniform vec2 resolution;
      void main() {
        vec2 p = (gl_FragCoord.xy - resolution * vec2(0.5, 0.56)) / resolution.y;
        float d = length(p * vec2(0.85, 1.0));
        gl_FragColor = vec4(base * mix(1.0, 1.0 - falloff, smoothstep(0.15, 0.95, d)), 1.0);
      }
    `,
  }),
);
backdrop.frustumCulled = false;
backdrop.renderOrder = -1;
const group = new Group();
scene.add(group, backdrop);
// Two feather sets: the form shown, and while morphing, the one it is turning into. Both are bent onto one centre line.
const sets = [createFeathers({ alphaToCoverage: pipeline.msaa > 0 }), createFeathers({ alphaToCoverage: pipeline.msaa > 0 })];
for (const set of sets) group.add(set.mesh, set.skin);
const spine = createSpine();
const SPINE_SAMPLES = 2049;
const MORPH_TIME = 2.4;
let cur = 0;
// The form shown ({ line, r, shape, mover }), and the morph to the next one ({ from, to, t, offset, dir }).
let form = null;
let morph = null;

// Roots a Poisson disc keeps, per square of its spacing (measured).
const DENSITY = 1.81;

// The feathers are laid out in a worker; the latest request wins.
const layoutWorker = new Worker(new URL("./layout.worker.js", import.meta.url), { type: "module" });
const layoutJobs = new Map();
let layoutId = 0;
layoutWorker.onmessage = ({ data }) => {
  for (const [id, done] of layoutJobs) if (id < data.id) layoutJobs.delete(id), done(null);
  layoutJobs.get(data.id)?.(data);
  layoutJobs.delete(data.id);
};
const layout = (job) => new Promise((done) => {
  const id = ++layoutId;
  layoutJobs.set(id, done);
  layoutWorker.postMessage({ id, ...job });
});
const building = () => layoutJobs.size > 0;

// The form and its feathers; resolves true once it's on (false if a later rebuild took over). preview: the bare form
// only (while a slider is being dragged), at once. direct: into the shown set (no morph).
async function rebuild(preview = false, direct = false) {
  const shape = params.shape();
  let mover = null;
  let line, r;
  if (shape === "curl") {
    // Turning no tighter than three radii and kept four and a half clear of itself, in room for its length and
    // girth; thinned if it still comes too close.
    const t = params.thickness();
    const bound = 2.6 * params.room() * Math.cbrt((params.curlLength() / 16) * (t / 0.45) ** 2);
    const L = params.curlLength();
    const random = seededRandom(`curl-${getSeed()}`);
    const start = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.6 * bound);
    const dir = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5);
    const reach = Math.ceil(L / DS) + 40;
    const steer = curlSteer(random, { frequency: params.curliness(), bound, clear: 4.5 * t, skip: Math.ceil((Math.PI * 3 * t) / DS), reach });
    const swimmer = new Swimmer({ start, dir, steer, minRadius: 3 * t, capacity: reach + 200 });
    // Swims a body length (and a bit) first, so it starts whole.
    swimmer.advance(L + 1);
    line = new Spine(swimmer, L, Math.min(2000, Math.round(L / 0.02)), params.taper());
    r = Math.min(t, clearance(line) / 2.4);
    mover = { swimmer, spine: line };
  } else {
    line = lineFor(shape, shape === "torus" ? params.ringRadius() : params.knotSize(), params.p(), params.q());
    // Never so thick the tube (and its coat) runs into itself.
    r = Math.min(params.thickness(), 0.38 * clearance(line));
  }
  // Laid out on the tube straightened, then bent onto the line in the shaders: into the shown set, or (morphing) the
  // other one.
  const next = { line, r, mover, shape: new Vector4(line.length, r, line.closed ? 1 : 0, line.taper ?? 0) };
  const flat = straightLine(line);
  const skin = tubeGeometry(flat, r);
  // Feather length from the budget: a Poisson disc keeps about one root per DENSITY * spacing^2 of skin, so with
  // spacing s (in feather lengths) N feathers of length l cover area / (DENSITY * s^2 * l^2); both layers count.
  // Never longer than twice the tube's radius: past that the roots spread out instead, so the budget still holds.
  const under = params.underLayer();
  const per = 1 / 0.22 ** 2 * (under ? 1 : (0.22 / 0.17) ** 2) + (under ? 1 / (0.28 * 0.7) ** 2 : 0);
  const area = tubeArea(line, r);
  // Phones and low-end devices draw fewer feathers (larger, so the form stays covered).
  const count = Math.min(params.density() * area, params.feathers(), featherBudget());
  const ideal = Math.sqrt((per * area) / (DENSITY * count));
  const length = Math.min(ideal, 2 * r);
  const spread = ideal / length;
  const top = (under ? 0.22 : 0.17) * spread;
  // Feather length and width stretch each feather from there, without moving any root.
  // Laid out at length 1; Feather length and width are applied live in the shader.
  const stretch = 1;
  if (preview) {
    if (morph) finishMorph();
    sets[cur].build(EMPTY, skin, length * stretch);
    show(next);
    return true;
  }
  const packed = await layout({ flat, r, length, top, spread, under, seed: `feathers-${getSeed()}` });
  if (!packed) return false;
  if (morph) finishMorph();
  const into = !form || direct ? cur : 1 - cur;
  const feathers = sets[into];
  feathers.uniforms.gradientClosed.value = line.closed ? 1 : 0;
  feathers.uniforms.underLift.value = under ? 0.03 * length * stretch : 0;
  feathers.build(packed, skin, length);
  if (into === cur) show(next);
  else startMorph(next);
  return true;
}
const EMPTY = { n: 0, roots: new Float32Array(0), norms: new Float32Array(0), dirs: new Float32Array(0), skins: new Float32Array(0), shapes: new Float32Array(0) };
// Shows a form at once (no morph).
function show(next) {
  form = next;
  morph = null;
  const set = sets[cur];
  set.mesh.visible = set.skin.visible = true;
  sets[1 - cur].mesh.visible = sets[1 - cur].skin.visible = false;
  for (const s of sets) {
    s.uniforms.shapeA.value.copy(next.shape);
    s.uniforms.shapeB.value.copy(next.shape);
    s.uniforms.morphT.value = 0;
  }
  set.uniforms.layoutIsB.value = 0;
  set.uniforms.fadeDir.value = 0;
  set.uniforms.uMap.value.set(0, 1);
  updateSpine(false);
}
// Morphs from the shown form into next (already built into the other set): the line and the tube's radius blend,
// the old feathers shrink away and the new ones grow in. Closed loops are lined up first (turned, and reversed if
// that matches better), so the coat doesn't swirl round.
function startMorph(next) {
  // Between a loop and an open curl the line would sweep through itself: the old form thins away instead, and the new
  // one grows out of its own line.
  if (!form.line.closed || !next.line.closed) {
    morph = { from: form, to: next, t: 0, offset: 0, dir: 1, swap: true, phase: 0 };
    const a = sets[cur], b = sets[1 - cur];
    for (const s of sets) {
      s.uniforms.shapeA.value.copy(form.shape);
      s.uniforms.shapeB.value.copy(form.shape).setY(form.shape.y * 0.01);
    }
    a.uniforms.layoutIsB.value = 0;
    a.uniforms.fadeDir.value = -1;
    b.mesh.visible = b.skin.visible = false;
    return;
  }
  let offset = 0, dir = 1;
  if (form.line.closed && next.line.closed) {
    let best = Infinity;
    for (const d of [1, -1]) for (let o = 0; o < 128; o++) {
      let cost = 0;
      for (let i = 0; i < 64; i++) {
        const u = i / 64;
        frameAt(form.line, u, _pa, _ta, _na, _ba);
        frameAt(next.line, d > 0 ? u - o / 128 : o / 128 - u, _pb, _tb, _nb, _bb);
        cost += _pa.distanceToSquared(_pb);
      }
      if (cost < best) (best = cost), (offset = o / 128), (dir = d);
    }
  }
  morph = { from: form, to: next, t: 0, offset, dir };
  const a = sets[cur], b = sets[1 - cur];
  for (const s of sets) {
    s.uniforms.shapeA.value.copy(form.shape);
    s.uniforms.shapeB.value.copy(next.shape);
    s.uniforms.morphT.value = 0;
  }
  a.uniforms.layoutIsB.value = 0;
  a.uniforms.fadeDir.value = -1;
  b.uniforms.layoutIsB.value = 1;
  b.uniforms.fadeDir.value = 1;
  b.uniforms.uMap.value.set(offset, dir);
  b.mesh.visible = true;
}
function finishMorph() {
  const to = morph.to;
  cur = 1 - cur;
  show(to);
}
// The centre line now: the shown form's, or between the two while morphing.
function updateSpine(keepPrev) {
  let m = morph;
  let t = m ? m.t * m.t * (3 - 2 * m.t) : 0;
  // A swap: each half on its own line, the old form thinning away, then the new one swelling up.
  let only = m ? null : form;
  if (m?.swap) {
    const h = m.t < 0.5 ? 2 * m.t : 2 * m.t - 1;
    t = h * h * (3 - 2 * h);
    only = m.t < 0.5 ? m.from : m.to;
    if (m.t >= 0.5 && m.phase === 0) {
      m.phase = 1;
      const a = sets[cur], b = sets[1 - cur];
      a.mesh.visible = a.skin.visible = false;
      b.mesh.visible = b.skin.visible = true;
      for (const s of sets) {
        s.uniforms.shapeA.value.copy(m.to.shape).setY(m.to.shape.y * 0.01);
        s.uniforms.shapeB.value.copy(m.to.shape);
      }
      b.uniforms.layoutIsB.value = 1;
      b.uniforms.fadeDir.value = 1;
      b.uniforms.uMap.value.set(0, 1);
      keepPrev = false;
    }
    m = null;
  }
  const { texture, extent } = spine.set(SPINE_SAMPLES, (u, P, T, N) => {
    if (!m) return frameAt(only.line, u, P, T, N, _ba);
    frameAt(m.from.line, u, _pa, _ta, _na, _ba);
    frameAt(m.to.line, m.dir > 0 ? u - m.offset : m.offset - u, _pb, _tb, _nb, _bb);
    _tb.multiplyScalar(m.dir);
    P.lerpVectors(_pa, _pb, t);
    T.lerpVectors(_ta, _tb, t).normalize();
    N.lerpVectors(_na, _nb, t);
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-6) N.copy(_na).addScaledVector(T, -_na.dot(T));
    N.normalize();
  }, keepPrev);
  const length = m ? m.from.line.length + (m.to.line.length - m.from.line.length) * t : only.line.length;
  const r = m ? Math.max(m.from.r, m.to.r) : only.r;
  for (const s of sets) {
    s.uniforms.spineTex.value = texture;
    s.uniforms.spineCount.value = SPINE_SAMPLES;
    s.uniforms.spineLength.value = length;
    s.uniforms.morphT.value = t;
    s.setExtent(extent + r + 3 * s.uniforms.featherScale.value);
  formRadius = extent + r + s0Feather();
  }
}
// The form's bounding radius (centre line, tube and feathers), and the camera fitted to it: the whole form in view with a
// margin, whatever the screen's shape, from the camera's current direction; the form back to its rest orientation.
let formRadius = 3;
const s0Feather = () => 1.5 * sets[cur].uniforms.featherScale.value * Math.max(1, params.featherLength());
function frame(reset = true) {
  const vfov = (camera.fov * Math.PI) / 360;
  const hfov = Math.atan(Math.tan(vfov) * camera.aspect);
  const dist = (1.12 * formRadius) / Math.sin(Math.min(vfov, hfov));
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  camera.updateMatrixWorld();
  if (reset) group.quaternion.identity();
  controls.update();
}
const _pa = new Vector3(), _ta = new Vector3(), _na = new Vector3(), _ba = new Vector3();
const _pb = new Vector3(), _tb = new Vector3(), _nb = new Vector3(), _bb = new Vector3();

const shapeSignature = () => [getSeed(), params.shape(), params.p(), params.q(), params.ringRadius(), params.knotSize(), params.curlLength(), params.curliness(), params.room(), params.taper()].join();
let builtShape = "";
let fitPending = true;
const signature = () => [getSeed(), params.shape(), params.p(), params.q(), params.curlLength(), params.curliness(), params.room(), params.taper(), params.ringRadius(), params.knotSize(), params.thickness(), params.density(), params.feathers(), params.underLayer()].join();

// A new variation, in strict order: the form shrinks away (as it is); once it's gone the new values are drawn and
// the new form built, unseen; the background fades to its own; then the new form grows in, feathered.
// Stage lengths (seconds); recordings make them quicker.
const timing = { shrink: 0.8, background: 0.5, grow: 1 };
let change = null;
let backgroundFrom = null;
// The values are drawn at once (they belong to the new seed), but the form on show keeps reading the old ones (its
// geometry is built, and its look is held) until it's gone.
const LOOK_KEYS = ["palette", "pattern", "patternAmount", "ruffle", "curl", "angle", "lean", "gradientAmount", "gradientRepeat", "underShade", "seeThrough", "featherLength", "featherWidth", "internalShadow"];
const lookNow = () => Object.fromEntries(LOOK_KEYS.map((k) => [k, params[k]()]));
let pendingHeld = null;
// A new variation: set applies its values; the form then morphs into it or shrinks away (see Transition).
function vary(set) {
  const held = pendingHeld ?? (form ? lookNow() : null);
  set();
  if (!form) return;
  if (params.transition() === "morph" && !change) {
    // The new form is laid out while the old one stays on in its own look; then one morphs (and blends) into the other.
    built = signature();
    builtShape = shapeSignature();
    pendingHeld = held;
    rebuild().then((ok) => {
      if (ok && morph) morph.held = held;
      if (ok) pendingHeld = null;
    });
  } else change ??= { stage: "shrink", t: 0, held };
}
onRandomize(() => vary(() => gui.randomizeAll()));
const ease = (x) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};
function runChange(dt) {
  change.t += dt;
  if (change.stage === "shrink") {
    // Holds its size, then goes quickly (so little empty space follows).
    const x = Math.min(1, change.t / timing.shrink);
    const k = 1 - x * x * x;
    // Hidden rather than scaled to nothing (degenerate matrices).
    group.visible = k > 0.03;
    group.scale.setScalar(Math.max(0.03, k));
    if (change.t < timing.shrink) return;
    group.visible = false;
    built = signature();
    builtShape = shapeSignature();
    change = { stage: "build", t: 0 };
    rebuild(false, true).then((ok) => {
      if (!ok || change?.stage !== "build") return;
      fitPending = true;
      backgroundFrom = pipeline.background.clone();
      change = { stage: "background", t: 0 };
    });
  } else if (change.stage === "build") {
    // Hidden until the new form is laid out.
  } else if (change.stage === "background") {
    const look = LOOKS[params.look()];
    _bg.set(look.background).multiplyScalar(look.backgroundGain);
    pipeline.background.copy(backgroundFrom).lerp(_bg, ease(change.t / timing.background));
    if (change.t >= timing.background) change = { stage: "grow", t: 0 };
  } else {
    // Comes up quickly from its first frames, then settles into its size.
    const x = Math.min(1, change.t / timing.grow);
    const k = 1 - (1 - x) ** 3;
    group.visible = k > 0.03;
    group.scale.setScalar(Math.max(0.03, k));
    if (change.t < timing.grow) return;
    group.visible = true;
    group.scale.setScalar(1);
    change = null;
  }
}
const _bg = new Color();
applyUrlState();
await load.layout.track(rebuild());
builtShape = shapeSignature();
let built = signature();

// Each look's studio is baked once; a switch waits for its bake, then swaps everything at once.
const bakes = {};
const bake = (look) => (bakes[look] ??= createStudioEnvironmentAsync(renderer, { ...LOOKS[look].studio, apply: false }));
let shownLook = "";
async function updateLook() {
  const look = params.look();
  if (look === shownLook) return;
  shownLook = look;
  const env = await bake(look);
  if (params.look() !== look) return;
  applyEnvironment(env);
  pipeline.background.set(LOOKS[look].background).multiplyScalar(LOOKS[look].backgroundGain);
  pipeline.exposure = LOOKS[look].exposure;
  pipeline.bloomStrength = LOOKS[look].bloom;
  pipeline.vignette = LOOKS[look].vignette;
  pipeline.contrast = LOOKS[look].contrast;
  globalUniforms.aoIntensity.value = LOOKS[look].ao;
  globalUniforms.aoMin.value = LOOKS[look].aoMin;
  globalUniforms.shadowSoftness.value = LOOKS[look].shadowSoftness;
  globalUniforms.shadowLightSize.value = LOOKS[look].shadowLightSize;
  pipeline.restartAccumulation();
  document.querySelector("#loading")?.style.setProperty("--loading-background", LOOKS[look].background);
}
const studio = load.studio.track(updateLook());

camera.position.set(0, 1.5, 9);
controls.target.set(0, 0, 0);
// The camera stays where the light is right (controls only zoom); dragging turns the form itself, with a little
// momentum.
controls.enableRotate = false;
controls.enablePan = false;
const turn = { active: false, x: 0, y: 0, vx: 0, vy: 0 };
renderer.domElement.addEventListener("pointerdown", (e) => {
  turn.active = true;
  turn.x = e.clientX;
  turn.y = e.clientY;
  turn.vx = turn.vy = 0;
});
addEventListener("pointermove", (e) => {
  if (!turn.active) return;
  const k = 4 / Math.max(innerHeight, 1);
  turn.vx = (e.clientX - turn.x) * k;
  turn.vy = (e.clientY - turn.y) * k;
  turn.x = e.clientX;
  turn.y = e.clientY;
  rotateForm(turn.vx, turn.vy);
});
for (const e of ["pointerup", "pointercancel"]) addEventListener(e, () => (turn.active = false));
const _qa = new Quaternion(), _qb = new Quaternion(), _up = new Vector3(), _right = new Vector3();
// Turns the form about the camera's up (dx) and right (dy) axes.
function rotateForm(dx, dy) {
  _up.setFromMatrixColumn(camera.matrixWorld, 1);
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  _qa.setFromAxisAngle(_up, dx);
  _qb.setFromAxisAngle(_right, dy);
  group.quaternion.premultiply(_qa).premultiply(_qb).normalize();
}
onResize((w, h, dpr) => {
  pipeline.setSize(w, h, dpr);
  fitPending ||= "resize";
});

await studio;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  group,
  sound,
  timing,
  get feathers() {
    return sets[cur];
  },
  // For recordings: a given look ({ param: value }), brought in as randomizing would (see Transition).
  nextLook(look) {
    if (!look) return randomize();
    vary(() => {
      for (const [k, v] of Object.entries(look)) params[k]?.set(v);
    });
  },
  // The first look grows in from nothing.
  bounce() {
    change = { stage: "grow", t: 0 };
    group.visible = false;
  },
  // A rouse or a swipe this many seconds from now.
  rouseIn: (s) => (rouseAt = s),
  swipeIn: (s) => (swipeAt = s),
};
// The other look bakes in the background, so switching never waits.
for (const look of Object.keys(LOOKS)) bake(look);

// Life: the form breathes, now and then rouses its plumage like a bird, and stirs where the pointer passes close.
const gust = { t: 99, peak: 0, rise: 1, fall: 1, pan: 0, dir: new Vector3(1, 0, 0) };
let gustAt = 6 + 10 * nativeRandom();
const swipe = { t: 9, from: 0, span: 0, side: 0, time: 1, count: 0 };
let swipeAt = 3 + 6 * nativeRandom();
let rouseCount = 0, rouseT = 99, rouseLength = 1.4, shakeHz = 7, shakeAmp = 0, rouseFront = 2, rouseSpeed = 1, rouse = 0, rouseAt = 4 + 6 * nativeRandom(), breathPrev = 1;
const pointer = { ndc: new Vector2(), moved: 0, inside: false, stir: 0 };
addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -((e.clientY - r.top) / r.height) * 2 + 1;
  pointer.moved += Math.hypot(x - pointer.ndc.x, y - pointer.ndc.y);
  pointer.ndc.set(x, y);
  pointer.inside = true;
});
addEventListener("pointerleave", () => (pointer.inside = false));
const raycaster = new Raycaster();
const _inv = new Matrix4();
const _pw = new Vector3();
const _qInv = new Quaternion();
const rouseShape = new Vector4(0, 1, 0.12, 0);
function updateLife(time, dt) {
  const breath = 1 + 0.018 * Math.sin(time * 1.6) + 0.006 * Math.sin(time * 0.53);
  // A rouse now and then, like an owl's: the plumage puffs up in a fast wave from a random point (one way or
  // both ways), holds, the body shakes side to side a few times (6-8 Hz, fading), and it all sleeks back down.
  rouseAt -= dt;
  if (rouseAt <= 0) {
    const both = nativeRandom() < 0.4;
    rouse = 0.75 + 0.25 * nativeRandom();
    rouseT = 0;
    rouseFront = -0.03;
    rouseSpeed = (both ? 0.5 : 1) / (0.18 + 0.12 * nativeRandom());
    rouseShape.set(nativeRandom(), nativeRandom() < 0.5 ? 1 : -1, 0.6, both ? 1 : 0);
    shakeHz = 6 + 2 * nativeRandom();
    shakeAmp = (0.035 + 0.025 * nativeRandom()) * (nativeRandom() < 0.5 ? 1 : -1);
    rouseLength = 1.2 + 0.4 * nativeRandom();
    rouseCount++;
    // Irregular: often another right after (a quick double or triple), otherwise a pause of anything from 2 to 20 s.
    rouseAt = nativeRandom() < 0.35 ? 0.35 + 0.8 * nativeRandom() : Math.min(20, 2 - 6 * Math.log(1 - nativeRandom()));
  }
  rouseT += dt;
  rouseFront += dt * rouseSpeed;
  // Puffed while it spreads and shakes, then settling over the last half second.
  const settle = Math.min(1, Math.max(0, (rouseLength - rouseT) / 0.5));
  const rouseNow = rouseT < rouseLength ? rouse * settle * settle * (3 - 2 * settle) : 0;
  // The shake: from 0.3 s, a few fading swings.
  const ts = rouseT - 0.3;
  const swing = rouseNow > 0 && ts > 0 ? Math.exp(-ts * 4) * Math.sin(2 * Math.PI * shakeHz * ts) : 0;
  // Now and then a swipe, as if a hand ran quickly along the form: a band travelling along the tube (all round it),
  // over a stretch of it, in under a second.
  swipeAt -= dt;
  if (swipeAt <= 0) {
    swipe.t = 0;
    swipe.from = nativeRandom();
    swipe.span = (0.25 + 0.35 * nativeRandom()) * (nativeRandom() < 0.5 ? 1 : -1);
    swipe.side = nativeRandom() * Math.PI * 2;
    swipe.time = 0.45 + 0.35 * nativeRandom();
    swipe.count++;
    swipeAt = 5 + 14 * nativeRandom();
  }
  swipe.t += dt / swipe.time;
  const swipeOn = swipe.t < 1.4;
  const swipeU = swipe.from + swipe.span * Math.min(1, swipe.t);
  // Gusts of wind now and then, each from its own direction: a swell over a second or two and a slower fade.
  gustAt -= dt;
  if (gustAt <= 0) {
    gust.t = 0;
    gust.peak = 0.5 + 0.5 * nativeRandom();
    gust.rise = 0.8 + 1.2 * nativeRandom();
    gust.fall = 1.5 + 2.5 * nativeRandom();
    const a = nativeRandom() * Math.PI * 2;
    gust.dir.set(Math.cos(a), (nativeRandom() - 0.5) * 0.4, Math.sin(a)).normalize();
    // Heard from the side it comes from.
    gust.pan = -gust.dir.x * 0.8;
    gustAt = 8 + 22 * nativeRandom();
  }
  gust.t += dt;
  const gustNow = gust.t < gust.rise ? gust.peak * Math.sin((Math.PI / 2) * (gust.t / gust.rise)) ** 2 : gust.peak * Math.max(0, 1 - (gust.t - gust.rise) / gust.fall) ** 2;
  // The pointer stirs while it moves near the form, settling once it stops.
  pointer.stir = Math.min(1, pointer.stir * Math.exp(-dt / 0.5) + pointer.moved * 6);
  pointer.moved = 0;
  raycaster.setFromCamera(pointer.ndc, camera);
  _inv.copy(group.matrixWorld).invert();
  const origin = raycaster.ray.origin.clone().applyMatrix4(_inv);
  const dir = raycaster.ray.direction.clone().transformDirection(_inv);
  for (const set of sets) {
    const u = set.uniforms;
    u.breath.value.set(breath, breathPrev);
    u.rouse.value = rouseNow;
    u.gust.value = gustNow;
    // The wind blows in the world; the form turns, so it's carried into the form's own frame.
    u.gustDir.value.copy(gust.dir).applyQuaternion(_qInv.copy(group.quaternion).invert());
    u.rouseFront.value = rouseFront;
    u.rouseShape.value.copy(rouseShape);
    u.rouseSwing.value = swing;
    u.swipe.value.set(((swipeU % 1) + 1) % 1, swipe.side, swipeOn ? Math.min(1, swipe.t * 6) * Math.min(1, (1.4 - swipe.t) / 0.4) : 0, 0.05);
    u.pointerOrigin.value.copy(origin);
    u.pointerDir.value.copy(dir);
    u.pointerStir.value = pointer.inside ? pointer.stir : 0;
  }
  breathPrev = breath;
  // The pointer is heard only where it stirs the feathers: near the form (its centre line, within its girth and a bit).
  let near = 0;
  if (pointer.inside && form && group.visible) {
    let best = Infinity;
    const P = form.line.P, step = Math.max(1, Math.floor(P.length / 256));
    for (let i = 0; i < P.length; i += step) best = Math.min(best, raycaster.ray.distanceSqToPoint(_pw.copy(P[i]).applyMatrix4(group.matrixWorld)));
    near = Math.exp(-(Math.max(0, Math.sqrt(best) - form.r) ** 2) / 0.3);
  }
  // Sound runs on real time (a slowed recording's audio still lines up with its frames).
  const slow = window.app?.timeScale ?? 1;
  sound.update(realDt, { breath, rouse: rouseNow, stir: pointer.stir * near, pan: pointer.ndc.x, lap: rouseLength / slow, shakeHz: shakeHz * slow, rouseCount, swipe: swipe.t < 1 ? 1 : 0, swipePan: Math.sin(swipe.side) * 0.6, gust: gustNow, gustPan: gust.pan });
}

// The meter: GPU time from timer queries where the browser has them, frame intervals otherwise; reported twice a second.
const meter = (() => {
  const gl = renderer.getContext();
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending = [];
  let gpuSum = 0, gpuN = 0, frames = 0, since = performance.now(), last = since, intervalSum = 0;
  const started = since;
  return {
    begin() {
      if (!ext || pending.length > 4) return;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      pending.push(q);
      this.open = true;
    },
    // running: false while paused (the still settles, then stops rendering): nothing is counted or shown then.
    end(running) {
      if (this.open) gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.open = false;
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift();
        if (running && !gl.getParameter(ext.GPU_DISJOINT_EXT)) (gpuSum += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6), gpuN++;
        gl.deleteQuery(q);
      }
      const now = performance.now();
      if (!running) {
        gpuSum = gpuN = frames = intervalSum = 0;
        since = last = now;
        return;
      }
      intervalSum += now - last;
      last = now;
      frames++;
      if (now - since < 500) return;
      const ms = gpuN ? gpuSum / gpuN : intervalSum / frames;
      const drawn = sets.reduce((n, s) => n + (s.mesh.visible ? s.count : 0), 0);
      stats.fps.set(Math.round((frames * 1000) / (now - since)));
      stats.ms.set(`${ms.toFixed(1)} ms${gpuN ? " GPU" : ""}`);
      stats.feathers.set(drawn);
      // Without GPU timing, frame intervals only say something once they're longer than the screen's refresh.
      // Stalled windows (a hidden tab, a compile) say nothing about the steady cost.
      const estimate = drawn && frames >= 10 && (gpuN || (!ext && ms > 18)) ? (drawn * 16.7) / ms : 0;
      if (estimate && !change && now - started > 3000) (perf.sum += estimate), perf.n++;
      stats.budget.set(perf.n ? `~${(perf.sum / perf.n / 1000).toFixed(1)}k avg` : "–");
      const cap = featherBudget();
      stats.next.set(Number.isFinite(cap) ? `≤ ${Math.round(cap)} feathers` : "no cap");
      gpuSum = gpuN = frames = intervalSum = 0;
      since = now;
    },
  };
})();

const shownPalette = ["", ""];
const smooth = (t) => t * t * (3 - 2 * t);
function blendLook(a, b, old, t) {
  const out = {};
  for (const k of LOOK_KEYS) out[k] = typeof a[k] === "number" && k !== "gradientRepeat" ? a[k] + (b[k] - a[k]) * t : old ? a[k] : b[k];
  return out;
}
const _palA = new Color(), _palB = new Color();
const blendPalette = (a, b, t) => PALETTES[a].map((c, i) => new Color().lerpColors(_palA.set(c), _palB.set(PALETTES[b][i]), t));
let previewing = false;
let pointerHeld = false;
let stillKey = null, movingKey = null;
addEventListener("pointerdown", () => (pointerHeld = true), true);
for (const e of ["pointerup", "pointercancel"]) addEventListener(e, () => (pointerHeld = false), true);
// Recordings can slow the whole piece down (timeScale < 1): the clock everything runs on.
let sceneTime = 0, realDt = 0, lastNow = 0;
render(({ time, dt }) => {
  // While paused the base's dt is 0: the frame's own interval keeps everything but the spin going.
  const now = performance.now();
  const measured = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;
  const spinDt = dt * (window.app?.timeScale ?? 1);
  autoChange.update(spinDt);
  realDt = paused ? measured : dt;
  dt = realDt * (window.app?.timeScale ?? 1);
  sceneTime += dt;
  time = sceneTime;
  // While a pointer is held (dragging a slider) the form is rebuilt bare; feathered on release.
  if (fitPending) {
    frame(fitPending !== "resize");
    fitPending = false;
  }
  if (change) runChange(dt);
  // Changes from the panel apply at once (a new shape is reframed); only randomizing plays the shrink and grow.
  else if (signature() !== built) {
    previewing = pointerHeld;
    const reshaped = shapeSignature() !== builtShape;
    rebuild(previewing, true).then((ok) => ok && reshaped && frame(false));
    built = signature();
    builtShape = shapeSignature();
  } else if (previewing && !pointerHeld) {
    previewing = false;
    rebuild(false, true);
  }
  updateLook();
  backdrop.material.uniforms.falloff.value = params.backdrop();
  const shadowMode = params.shadows();
  // While the old form shrinks away it keeps its own look.
  const shown = change?.stage === "shrink" && change.held ? change.held : pendingHeld ?? lookNow();
  for (const [i, set] of sets.entries()) {
    const u = set.uniforms;
    // While morphing, both forms blend from the old look to the new; a pattern's kind and repeat stay each form's own.
    const look = morph?.held ? blendLook(morph.held, shown, i === cur, smooth(morph.t)) : shown;
    if (morph?.held) set.setPalette(blendPalette(morph.held.palette, shown.palette, smooth(morph.t))), (shownPalette[i] = "");
    else if (shownPalette[i] !== look.palette) set.setPalette(PALETTES[(shownPalette[i] = look.palette)]);
    u.ruffle.value = look.ruffle;
    u.featherCurl.value = look.curl;
    u.featherAngle.value = look.angle;
    u.featherLean.value = look.lean;
    // Each opening shades the feather below: capped on phones.
    u.seeThrough.value = pipeline.quality === "high" || pipeline.quality === "capture" ? look.seeThrough : Math.min(look.seeThrough, 0.4);
    u.patternKind.value = PATTERNS.indexOf(look.pattern);
    u.patternAmount.value = look.patternAmount;
    u.underShade.value = look.underShade;
    u.gradientAmount.value = look.gradientAmount;
    u.gradientRepeat.value = look.gradientRepeat;
    u.featherStretch.value = look.featherLength;
    u.internalShadow.value = look.internalShadow;
    u.featherWidthScale.value = look.featherWidth;
    u.stochasticShadow.value = shadowMode === "stochastic" ? 1 : 0;
  }
  // Feather shadows: opaque cutouts; translucent by the depth gap to the blockers; or a screen door averaged over
  // a wide disc.
  globalUniforms.shadowLayerT.value = params.shadowLight();
  globalUniforms.shadowTranslucency.value = shadowMode === "translucent" ? 1 : 0;
  globalUniforms.shadowMinTexels.value = shadowMode === "stochastic" ? 7 : 0;
  // One layer of the coat is about a feather's lift.
  globalUniforms.shadowLayerSpacing.value = 0.02 * (sets[cur].uniforms.featherScale.value / 0.36);
  // Spin about the vertical, plus the drag's momentum once let go.
  group.quaternion.premultiply(_qa.setFromAxisAngle(_up.set(0, 1, 0), spinDt * params.spin()));
  if (!turn.active && Math.abs(turn.vx) + Math.abs(turn.vy) > 1e-5) {
    const f = Math.exp(-dt * 3);
    turn.vx *= f;
    turn.vy *= f;
    rotateForm(turn.vx, turn.vy);
  }
  updateLife(time, dt);
  // Swimming forms move on; a morph runs its course; then the line is written for this frame.
  const swimming = [form, morph?.to].filter((f) => f?.mover);
  if (params.speed() > 0) for (const f of swimming) f.mover.swimmer.advance(dt * params.speed()), f.mover.spine.update();
  if (morph) {
    morph.t = Math.min(1, morph.t + dt / MORPH_TIME);
    if (!morph.swap) {
      const a = sets[cur], b = sets[1 - cur];
      a.skin.visible = morph.t < 0.9;
      b.skin.visible = morph.t >= 0.15;
    }
  }
  if (morph || (swimming.length && params.speed() > 0)) updateSpine(true);
  // The camera follows the form's size through a morph.
  if (morph) frame(false);
  if (morph?.t >= 1) finishMorph();
  controls.update();
  const still = [signature(), params.ruffle(), params.curl(), params.palette(), params.shadows(), params.shadowLight(), params.angle(), params.lean(), params.seeThrough(), params.look(), params.backdrop(), params.pattern(), params.patternAmount(), params.underShade(), params.gradientAmount(), params.gradientRepeat(), params.featherLength(), params.featherWidth(), params.internalShadow()].join();
  // Everything else that moves the image (the form turned, transitions, rousing, breathing, the pointer stirring): while
  // paused, those frames render live instead of into the still average, which would smear.
  const u0 = sets[cur].uniforms;
  const moving = [group.quaternion.toArray().map((v) => v.toFixed(5)).join(), group.scale.x.toFixed(4), group.visible, change?.stage ?? "", change?.t.toFixed(3) ?? "", morph?.t.toFixed(3) ?? "", u0.breath.value.x.toFixed(5), u0.rouse.value.toFixed(4), u0.gust.value.toFixed(4), u0.rouseFront.value.toFixed(4), u0.pointerStir.value.toFixed(4), u0.pointerStir.value > 0 ? u0.pointerOrigin.value.toArray().map((v) => v.toFixed(3)).join() : "", u0.swipe.value.toArray().map((v) => v.toFixed(4)).join()].join("|");
  if (still !== stillKey) pipeline.restartAccumulation(false);
  if (moving !== movingKey) pipeline.markMoving();
  stillKey = still;
  movingKey = moving;
  meter.begin();
  pipeline.render(scene, camera, time);
  meter.end(dt > 0);
});
