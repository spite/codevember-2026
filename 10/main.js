import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, addKey, addActionButton, addActionLink, onPause, isRunning, randomize, loadSeed, getSeed } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3, BufferGeometry, BufferAttribute, Box3, Quaternion, Euler, Matrix4 } from "three";
import { createBackdrop } from "./backdrop.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironment, createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { SHAPES } from "./shapes.js";
import { buildRelief, createReliefMaterial, createBlankMaterial, setRelief } from "./relief.js";
import { createSound } from "./sound.js";
import { createFumes } from "./fumes.js";
import { PATTERNS } from "./patterns/index.js";
import { nativeRandom, setSeed } from "modules/random.js";

// Each metal with its patina, and the backdrop and studio that suit it.
const LOOKS = {
  copper: {
    metal: [0.86, 0.46, 0.3],
    oxide: [0.07, 0.025, 0.014],
    oxideMetal: 0.4,
    oxideRough: 0.55,
    crust: [0.15, 0.47, 0.39],
    crustRough: 0.8,
    deposit: 1,
    motifCrust: 0.75,
    groundTone: 0.85,
    matting: 0.5,
    burnish: 0.68,
    groundDark: 0.6,
    groundRough: 0.45,
    blankRough: 0.17,
    polishRough: 0.2,
    background: 0x1d1a18,
    studio: { tint: 0xfff1e4, wall: 0.12, floor: 0.2 },
  },
  silver: {
    metal: [0.95, 0.93, 0.89],
    oxide: [0.035, 0.03, 0.026],
    oxideMetal: 0.6,
    oxideRough: 0.35,
    crust: [0.012, 0.011, 0.01],
    crustRough: 0.6,
    deposit: 0.85,
    motifCrust: 0,
    groundTone: 0,
    burnish: -0.45,
    groundDark: 0.55,
    groundRough: 0.55,
    blankRough: 0.18,
    polishRough: 0.16,
    background: 0x8a8986,
    studio: { tint: 0xf4f6f8, wall: 0.6, floor: 0.5 },
  },
  gilt: {
    metal: [1.0, 0.71, 0.32],
    oxide: [0.05, 0.03, 0.012],
    oxideMetal: 0.5,
    oxideRough: 0.45,
    crust: [0.12, 0.16, 0.08],
    crustRough: 0.75,
    deposit: 0.5,
    groundDark: 0.6,
    groundRough: 0.45,
    background: 0x2a1610,
    studio: { tint: 0xffeedd, wall: 0.18, floor: 0.25 },
  },
  steel: {
    metal: [0.56, 0.57, 0.58],
    oxide: [0.03, 0.035, 0.05],
    oxideMetal: 0.8,
    oxideRough: 0.3,
    crust: [0.2, 0.07, 0.02],
    crustRough: 0.8,
    deposit: 0.25,
    groundDark: 0.6,
    groundRough: 0.4,
    background: 0x0b0b0c,
    studio: { tint: 0xeef2ff, wall: 0.08, floor: 0.15 },
  },
  niello: {
    metal: [0.95, 0.93, 0.89],
    oxide: [0.3, 0.27, 0.24],
    oxideMetal: 0.9,
    oxideRough: 0.4,
    crust: [0.02, 0.02, 0.02],
    crustRough: 0.6,
    deposit: 0,
    groundDark: 0.55,
    groundRough: 0.55,
    blankRough: 0.16,
    polishRough: 0.12,
    fill: { color: [0.018, 0.018, 0.02], metal: 0.45, rough: 0.14, glow: 0.5, lines: 1, keep: 0.45 },
    background: 0x8e8c88,
    studio: { tint: 0xf4f6f8, wall: 0.6, floor: 0.5 },
  },
  "parcel-gilt": {
    metal: [1.0, 0.68, 0.28],
    ground: [0.93, 0.92, 0.89],
    oxide: [0.45, 0.43, 0.4],
    oxideMetal: 0.85,
    oxideRough: 0.4,
    crust: [0.015, 0.013, 0.012],
    crustRough: 0.6,
    deposit: 0.35,
    burnish: -0.2,
    groundDark: 0.85,
    groundRough: 0.5,
    blankRough: 0.18,
    polishRough: 0.15,
    background: 0x403c38,
    studio: { tint: 0xfff6ee, wall: 0.3, floor: 0.3 },
  },
  damascene: {
    metal: [1.0, 0.72, 0.33],
    ground: [0.5, 0.51, 0.53],
    oxide: [0.012, 0.013, 0.018],
    oxideMetal: 0.85,
    oxideRough: 0.32,
    crust: [0.01, 0.01, 0.012],
    crustRough: 0.5,
    deposit: 0.2,
    burnish: 0.55,
    groundDark: 0.5,
    groundRough: 0.4,
    background: 0x141110,
    studio: { tint: 0xfff0e0, wall: 0.1, floor: 0.18 },
  },
  bronze: {
    metal: [0.74, 0.5, 0.27],
    oxide: [0.03, 0.017, 0.008],
    oxideMetal: 0.3,
    oxideRough: 0.5,
    crust: [0.08, 0.075, 0.035],
    crustRough: 0.85,
    deposit: 0.7,
    motifCrust: 0.3,
    groundTone: 0.6,
    burnish: 0.62,
    groundDark: 0.6,
    groundRough: 0.5,
    blankRough: 0.26,
    polishRough: 0.24,
    background: 0x221c16,
    studio: { tint: 0xffefdc, wall: 0.14, floor: 0.22 },
  },
  "champlevé turquoise": {
    metal: [1.0, 0.7, 0.3],
    oxide: [0.06, 0.025, 0.012],
    oxideMetal: 0.4,
    oxideRough: 0.6,
    crust: [0.02, 0.01, 0.01],
    deposit: 0,
    groundDark: 0.6,
    groundRough: 0.45,
    polishRough: 0.24,
    fill: { color: [0.04, 0.42, 0.37], color2: [0.75, 0.15, 0.07], band: 0.0016, rough: 0.05, lines: 1, keep: 0.4 },
    background: 0x2a1d16,
    studio: { tint: 0xfff1e4, wall: 0.16, floor: 0.24 },
  },
  "champlevé cobalt": {
    metal: [1.0, 0.7, 0.3],
    oxide: [0.06, 0.025, 0.012],
    oxideMetal: 0.4,
    oxideRough: 0.6,
    crust: [0.02, 0.01, 0.01],
    deposit: 0,
    groundDark: 0.6,
    groundRough: 0.45,
    polishRough: 0.24,
    fill: { color: [0.012, 0.03, 0.25], color2: [0.78, 0.78, 0.74], band: 0.0016, rough: 0.05, lines: 1, keep: 0.4 },
    background: 0xb0aba3,
    studio: { tint: 0xf6f4f0, wall: 0.55, floor: 0.45 },
  },
  "champlevé oxblood": {
    metal: [1.0, 0.7, 0.3],
    oxide: [0.06, 0.025, 0.012],
    oxideMetal: 0.4,
    oxideRough: 0.6,
    crust: [0.02, 0.01, 0.01],
    deposit: 0,
    groundDark: 0.6,
    groundRough: 0.45,
    polishRough: 0.24,
    fill: { color: [0.2, 0.006, 0.008], rough: 0.05, lines: 1, keep: 0.4 },
    background: 0x191615,
    studio: { tint: 0xfff4ea, wall: 0.1, floor: 0.18 },
  },
  "basse-taille": {
    metal: [1.0, 0.75, 0.4],
    ground: [0.95, 0.93, 0.89],
    oxide: [0.3, 0.27, 0.24],
    oxideMetal: 0.9,
    oxideRough: 0.4,
    crust: [0.02, 0.02, 0.02],
    deposit: 0,
    matting: 0,
    guilloche: 1,
    groundDark: 1,
    groundRough: 0.2,
    fill: { color: [0.18, 0.3, 0.9], clear: 1, rough: 0.03, glow: 0.8, lines: 1, keep: 0.4 },
    background: 0x6c6870,
    studio: { tint: 0xf8f4ff, wall: 0.35, floor: 0.35 },
  },
  shakudō: {
    metal: [1.0, 0.7, 0.28],
    ground: [0.42, 0.3, 0.26],
    oxide: [0.011, 0.015, 0.032],
    oxideMetal: 0.35,
    oxideRough: 0.38,
    crust: [0.008, 0.009, 0.014],
    crustRough: 0.5,
    deposit: 0.3,
    burnish: -0.3,
    groundDark: 0.8,
    groundRough: 0.4,
    blankRough: 0.32,
    polishRough: 0.16,
    background: 0x3a3632,
    studio: { tint: 0xfff2e6, wall: 0.28, floor: 0.32 },
  },
  "mokume-gane": {
    metal: [0.9, 0.7, 0.5],
    oxide: [0.78, 0.7, 0.66],
    oxideMetal: 0.85,
    oxideRough: 0.4,
    crust: [0.06, 0.03, 0.02],
    crustRough: 0.7,
    deposit: 0.4,
    mokume: 1,
    burnish: 0.4,
    // Little punch matting, so the etched layers read.
    matting: 0.2,
    groundDark: 0.75,
    groundRough: 0.4,
    blankRough: 0.26,
    polishRough: 0.18,
    background: 0x2b2522,
    studio: { tint: 0xfff3e8, wall: 0.16, floor: 0.24 },
  },
  damascus: {
    metal: [0.7, 0.7, 0.7],
    oxide: [0.5, 0.5, 0.52],
    oxideMetal: 0.9,
    oxideRough: 0.35,
    crust: [0.02, 0.02, 0.022],
    crustRough: 0.6,
    deposit: 0.25,
    mokume: 2,
    burnish: 0.5,
    // Little punch matting, so the etched layers read.
    matting: 0.2,
    groundDark: 0.8,
    groundRough: 0.42,
    blankRough: 0.24,
    polishRough: 0.16,
    background: 0x24272a,
    studio: { tint: 0xf2f5ff, wall: 0.16, floor: 0.24 },
  },
  titanium: {
    metal: [0.56, 0.55, 0.53],
    oxide: [0.5, 0.5, 0.5],
    oxideMetal: 1,
    oxideRough: 0.3,
    crust: [0.03, 0.03, 0.035],
    crustRough: 0.6,
    deposit: 0,
    anodize: 1,
    burnish: 2,
    groundDark: 0.85,
    groundRough: 0.38,
    blankRough: 0.3,
    polishRough: 0.22,
    background: 0x15171a,
    studio: { tint: 0xf2f5ff, wall: 0.1, floor: 0.18 },
  },
  cloisonné: {
    metal: [1.0, 0.74, 0.36],
    oxide: [0.06, 0.03, 0.012],
    oxideMetal: 0.5,
    oxideRough: 0.5,
    crust: [0.02, 0.01, 0.01],
    deposit: 0,
    cloison: 0.003,
    groundDark: 0.7,
    groundRough: 0.4,
    polishRough: 0.12,
    fill: { color: [0.012, 0.27, 0.34], color2: [0.72, 0.11, 0.045], band: 0.0002, rough: 0.05, keep: 0.25, cushion: 0.45 },
    background: 0x1e2a2c,
    studio: { tint: 0xfff4ea, wall: 0.14, floor: 0.22 },
  },
  gunmetal: {
    metal: [0.2, 0.2, 0.22],
    oxide: [0.03, 0.03, 0.035],
    oxideMetal: 0.9,
    oxideRough: 0.18,
    crust: [0.015, 0.015, 0.018],
    crustRough: 0.4,
    deposit: 0.25,
    burnish: 0.4,
    groundDark: 0.55,
    groundRough: 0.35,
    blankRough: 0.12,
    polishRough: 0.07,
    background: 0x2c2d30,
    studio: { tint: 0xf0f4ff, wall: 0.3, floor: 0.32 },
  },
  excavated: {
    metal: [0.72, 0.5, 0.28],
    oxide: [0.05, 0.035, 0.018],
    oxideMetal: 0.2,
    oxideRough: 0.75,
    crust: [0.2, 0.42, 0.3],
    crustRough: 0.95,
    deposit: 1,
    motifCrust: 0.8,
    groundTone: 0.2,
    burnish: -0.15,
    groundDark: 0.6,
    groundRough: 0.6,
    blankRough: 0.4,
    polishRough: 0.32,
    background: 0x6a6253,
    studio: { tint: 0xfff0dc, wall: 0.4, floor: 0.38 },
  },
  "rusted iron": {
    metal: [0.95, 0.94, 0.91],
    ground: [0.36, 0.34, 0.32],
    oxide: [0.06, 0.04, 0.03],
    oxideMetal: 0.3,
    oxideRough: 0.7,
    crust: [0.36, 0.13, 0.04],
    crustRough: 0.95,
    deposit: 0.85,
    groundTone: 0,
    burnish: -0.7,
    groundDark: 0.7,
    groundRough: 0.7,
    blankRough: 0.45,
    polishRough: 0.12,
    background: 0x3b2f28,
    studio: { tint: 0xfff0e2, wall: 0.25, floor: 0.3 },
  },
  "mother-of-pearl": {
    metal: [0.95, 0.93, 0.89],
    oxide: [0.3, 0.27, 0.24],
    oxideMetal: 0.9,
    oxideRough: 0.35,
    crust: [0.02, 0.02, 0.02],
    crustRough: 0.6,
    deposit: 0,
    groundDark: 0.6,
    groundRough: 0.5,
    blankRough: 0.16,
    polishRough: 0.12,
    fill: { color: [0.86, 0.84, 0.8], metal: 0, rough: 0.22, glow: 0, lines: 1, keep: 0.4, pearl: 1 },
    background: 0x3a4048,
    studio: { tint: 0xf4f6ff, wall: 0.3, floor: 0.32 },
  },
};

// The finish code a look needs compiled into the relief shader (the rest is left out of its program).
function finishDefines(name) {
  const look = LOOKS[name];
  const f = look.fill;
  const d = [];
  if (f) d.push("ORN_FILL");
  if (look.guilloche) d.push("ORN_GUILLOCHE");
  if (f?.clear) d.push("ORN_CLEAR");
  if (look.cloison || f?.cushion) d.push("ORN_CLOISON");
  if (look.mokume) d.push("ORN_LAM");
  if (look.anodize) d.push("ORN_ANODIZE");
  return d;
}

// The process, in seconds at speed 1: [start, end] of each stage.
const STAGES = {
  draw: [0.3, 6.5],
  hammer: [7, 11.5],
  etch: [12, 20],
  patina: [19.8, 23.3],
  burnish: [23.6, 26.3],
};
const PROCESS_END = 26.8;
// Enamel and niello: after the etch the fill is laid, fused in the kiln (which scales the bare metal), ground flush
// with a stone and polished.
const FILL_STAGES = {
  ...STAGES,
  fill: [20.3, 23.1],
  fire: [23.3, 26.1],
  patina: [23.3, 26.1],
  grind: [26.5, 29.9],
  burnish: [30.1, 32.7],
};
const FILL_END = 33.2;
// The etch (stage fraction): the bath rises over the piece, bites, then drains off it.
// Fractions of the etch: the acid spreads over the piece, then the rinse thins it away.
const ACID = { flood: 0.2, drain: [0.66, 0.97] };
let lookShown;
const shown = { relief: 1, grind: 0, etch: 1, matting: 1 };
const syncShown = () => {
  shown.relief = params.relief();
  shown.grind = params.grind();
  shown.etch = params.etch();
  shown.matting = params.matting();
};
// From the metal on show, which can lag the panel's while pieces change over.
const shownLook = () => LOOKS[lookShown ?? params.look()];
const stages = () => (shownLook().fill ? FILL_STAGES : STAGES);
const processEnd = () => (shownLook().fill ? FILL_END : PROCESS_END);

const defaults = {
  shape: "sphere",
  look: "copper",
  pattern: 1,
  scale: 1.3,
  motif: "rinceau",
  symmetry: "none",
  flow: 0.5,
  leafiness: 0.5,
  rosettes: 0.5,
  lobes: 3,
  fill: 0.7,
  relief: 1,
  grind: 0,
  etch: 1,
  matting: 1,
  studio: true,
  spin: 0.06,
  speed: 1,
  auto: true,
  // Counted once the process has finished: how long a finished piece stays up.
  autoTime: 10,
};
// The low tier starts without the studio (as its default, so the url doesn't record it).
if (new URLSearchParams(location.search).get("quality") === "low") defaults.studio = false;
const params = fromDefaults(defaults);
const load = { studio: loadingStep(1), build: loadingStep(1), sound: loadingStep(1), compile: loadingStep(1) };
// three's check of every program's info log stalls the frame a program is first used in.
renderer.debug.checkShaderErrors = new URLSearchParams(location.search).has("debug");

const pipeline = new Pipeline(renderer, {
  background: LOOKS.copper.background,
  exposure: 1,
  bloomStrength: 0.04,
  vignette: 0.35,
  grain: 0.02,
  stillSamples: 32,
  // Blur from the piece's own motion (spin, drags, the hammer's jolts, the shake-off), measured each frame.
  motionBlur: { shutter: 1 / 50, samples: 16, reusePrepass: true },
  shadow: { autoFit: true, denoise: true },
});

const studios = {};
// A change of metal cross-fades the backdrop, the studio lighting and the material over FADE seconds; the reflections
// swap at the middle, under a dip in their strength.
const FADE = 0.9;
const fade = { t: 1, from: null, to: null, env: null, envBase: 1 };
const FLAGS = ["enamelOn", "fillClear", "fillPearl", "fillCushion", "fillLines", "cloison", "mokume", "anodize", "guilloche"];
function lookState() {
  const g = globalUniforms;
  const st = {
    sh: g.shIrradiance.value.map((v) => v.clone()),
    lightDirection: g.lightDirection.value.clone(),
    lightColor: g.lightColor.value.clone(),
    shadowLightSize: g.shadowLightSize.value,
    background: pipeline.background.clone(),
    m: {},
  };
  for (const [k, u] of Object.entries(material.uniforms)) {
    // The look's uniforms only: the piece's own (orn*, set by setRelief and each frame) must not be faded back.
    if (g[k] === u || k.startsWith("orn")) continue;
    if (typeof u.value === "number") st.m[k] = u.value;
    else if (u.value?.isColor) st.m[k] = u.value.clone();
  }
  return st;
}
function setLookState(a, b, x) {
  const g = globalUniforms;
  for (let i = 0; i < 9; i++) g.shIrradiance.value[i].lerpVectors(a.sh[i], b.sh[i], x);
  g.lightDirection.value.lerpVectors(a.lightDirection, b.lightDirection, x).normalize();
  g.lightColor.value.lerpColors(a.lightColor, b.lightColor, x);
  g.shadowLightSize.value = a.shadowLightSize + (b.shadowLightSize - a.shadowLightSize) * x;
  pipeline.background.lerpColors(a.background, b.background, x);
  const m = material.uniforms;
  // Hidden (between pieces), the material goes straight to the new metal.
  if (fade.snap) x = 1;
  for (const k in b.m) {
    if (!m[k] || !(k in a.m)) continue;
    if (FLAGS.includes(k)) m[k].value = x < 0.5 ? a.m[k] : b.m[k];
    else if (b.m[k].isColor) m[k].value.lerpColors(a.m[k], b.m[k], x);
    else m[k].value = a.m[k] + (b.m[k] - a.m[k]) * x;
  }
}
function updateFade(dt) {
  if (fade.t >= 1 || !fade.to) return;
  let t = Math.min(1, fade.t + dt / FADE);
  // A metal whose finish needs another program changes over to it at the middle, with the flags: short of it until
  // that program is ready.
  if (fade.material && t >= 0.5) {
    if (!fade.material.userData.compiled) t = Math.min(t, 0.4999);
    else {
      if (fade.material !== material) switchMaterial(fade.material);
      fade.material = null;
    }
  }
  fade.t = t;
  const x = fade.t * fade.t * (3 - 2 * fade.t);
  setLookState(fade.from, fade.to, x);
  const g = globalUniforms;
  if (fade.t >= 0.5 && fade.env) {
    g.envMap.value = fade.env.envMap;
    g.envMapMaxLod.value = Math.max(fade.env.envMap.mipmaps.length - 1, 0);
    fade.env = null;
  }
  g.envIntensity.value = fade.envBase * (1 - 0.55 * Math.sin(Math.PI * fade.t));
  if (fade.t >= 1) g.envIntensity.value = fade.envBase;
  pipeline.restartAccumulation(false);
}

// target: the material the piece changes over to at the middle of the fade, when the finish needs another program.
function applyLook(name, instant = false, snapMaterial = false, target = null) {
  const before = instant ? null : lookState();
  if (!instant && fade.t < 1) globalUniforms.envIntensity.value = fade.envBase;
  applyLookNow(name);
  if (instant) return;
  const after = lookState();
  fade.from = before;
  fade.to = after;
  fade.t = 0;
  fade.snap = snapMaterial;
  fade.material = target && target !== material ? target : null;
  fade.envBase = globalUniforms.envIntensity.value;
  // The reflections wait for the middle of the fade.
  fade.env = { envMap: globalUniforms.envMap.value };
  globalUniforms.envMap.value = before.envMap ?? lastEnv;
  setLookState(before, after, 0);
}
let lastEnv = null;
const studioOptions = (name) => ({
  keyDirection: new Vector3(-0.6, 0.9, 0.5),
  keyIntensity: 8,
  keySize: 0.4,
  fill: 0.35,
  ceiling: 0.3,
  apply: false,
  ...LOOKS[name].studio,
});
function applyLookNow(name) {
  const look = LOOKS[name];
  lastEnv = globalUniforms.envMap.value;
  studios[name] ??= createStudioEnvironment(renderer, studioOptions(name));
  const s = studios[name];
  const u = globalUniforms;
  u.envMap.value = s.envMap;
  u.envMapMaxLod.value = Math.max(s.envMap.mipmaps.length - 1, 0);
  for (let i = 0; i < 9; i++) u.shIrradiance.value[i].copy(s.sh[i]);
  u.lightDirection.value.copy(s.lightDirection);
  u.lightColor.value.copy(s.lightColor);
  u.shadowLightSize.value = s.shadowLightSize;
  pipeline.background.set(look.background);
  backdrop.setColor(look.background);
  const m = material.uniforms;
  m.metalColor.value.setRGB(...look.metal);
  m.patinaColor.value.setRGB(...look.crust);
  m.patinaColor2.value.setRGB(...look.oxide);
  m.patinaMetal.value = look.oxideMetal;
  m.oxideRough.value = look.oxideRough;
  m.patinaRough.value = look.crustRough;
  m.depositAmount.value = look.deposit;
  m.groundDark.value = look.groundDark;
  m.groundRough.value = look.groundRough;
  m.motifCrust.value = look.motifCrust ?? 0;
  m.groundTone.value = look.groundTone ?? 0;
  m.burnishReach.value = look.burnish ?? 0.3;
  m.blankRough.value = look.blankRough ?? 0.2;
  m.polishRough.value = look.polishRough ?? 0.18;
  m.groundColor.value.setRGB(...(look.ground ?? look.metal));
  m.guilloche.value = look.guilloche ?? 0;
  m.mokume.value = look.mokume ?? 0;
  m.anodize.value = look.anodize ?? 0;
  m.fillPearl.value = 0;
  m.fillCushion.value = 0;
  m.cloison.value = look.cloison ?? 0;
  const f = look.fill;
  m.enamelOn.value = f ? 1 : 0;
  if (f) {
    m.fillColor.value.setRGB(...f.color);
    m.fillColor2.value.setRGB(...(f.color2 ?? f.color));
    m.fillBand.value = f.band ?? 0;
    m.fillClear.value = f.clear ?? 0;
    m.fillMetal.value = f.metal ?? 0;
    m.fillRough.value = f.rough ?? 0.05;
    m.fillGlow.value = f.glow ?? 1;
    m.fillLines.value = f.lines ?? 0;
    m.fillKeep.value = f.keep ?? 0;
    m.fillPearl.value = f.pearl ?? 0;
    m.fillCushion.value = f.cushion ?? 0;
  }
  pipeline.restartAccumulation();
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
// Grouped by what they change: the blank, the ornament grown on it (these rebuild), the relief's shading, the metal,
// the process, the view.
gui.addSection("Blank");
gui.addSelect("Shape", params.shape, Object.keys(SHAPES), { onChange: () => fitSymmetry() });
gui.addSection("Ornament");
gui.addSelect("Pattern", params.motif, Object.keys(PATTERNS), { onChange: () => fitSymmetry() });
gui.addSlider("Variation", params.pattern, 1, 9999, 1);
const SYMMETRIES = ["none", "mirror", "2 planes", "3 planes", "3-fold", "4-fold", "6-fold"];
// Groups a pattern can't use on a shape: interlace needs a cell mesh the symmetry maps onto itself (the knot and
// twist grids have none for these), scale rows pile up in the pillow's 8-fold corners and the dodecahedron's
// pyritohedral ones, and nouveau's big flowers don't fit the narrowest domains.
const WEAVE_SKIP = { knot: ["2-fold", "6-fold"], knot25: ["2-fold", "10-fold"], twist: ["2-fold"] };
const ROW_SKIP = { pillow: ["8-fold"], dodeca: ["pyritohedral"], icosa: ["pyritohedral"] };
const SKIP = {
  knotwork: WEAVE_SKIP,
  arabesque: WEAVE_SKIP,
  girih: WEAVE_SKIP,
  guilloche: WEAVE_SKIP,
  scales: ROW_SKIP,
  seigaiha: ROW_SKIP,
  nouveau: { box: ["6-fold"], dodeca: ["pyritohedral"], icosa: ["pyritohedral"] },
};
const symmetryList = () => {
  const shape = SHAPES[params.shape()];
  const list = shape?.symmetries ? Object.keys(shape.symmetries) : SYMMETRIES;
  const skip = SKIP[params.motif()]?.[params.shape()] ?? [];
  return list.filter((s) => !skip.includes(s));
};
const symmetrySelect = gui.addSelect("Symmetry", params.symmetry, SYMMETRIES);
gui.addSlider("Scale", params.scale, 0.7, 2, 0.01, { randomizable: false });
// The Symmetry select lists the groups the shape has (a knot has no mirrors, a blob none at all).
let symmetryKey = "";
function fitSymmetry() {
  const key = params.shape() + "/" + params.motif();
  if (!SHAPES[params.shape()] || symmetryKey === key) return;
  symmetryKey = key;
  const list = symmetryList();
  symmetrySelect.setOptions(list);
  if (!list.includes(params.symmetry())) params.symmetry.set("none");
}
fitSymmetry();
// Each pattern shows the sliders it reads, named for what they do in it.
const OPTIONS = {
  rinceau: { flow: "Flow", leafiness: "Leaves", rosettes: "Rosettes", lobes: "Lobes", fill: "Fill" },
  arabesque: { flow: "Breaks", rosettes: "Bosses", lobes: "Lobes", fill: "Fill" },
  knotwork: { flow: "Breaks", rosettes: "Bosses", fill: "Fill" },
  scales: { flow: "Wander" },
  seigaiha: { flow: "Wander" },
  paisley: { flow: "Turn", leafiness: "Leaves", rosettes: "Flowers", fill: "Fill" },
  feathers: { flow: "Wander", leafiness: "Curl", rosettes: "Flowers", fill: "Fill" },
  friezes: { flow: "Wander", rosettes: "Rosettes", fill: "Fill" },
  meander: { flow: "Turns", fill: "Walkers" },
  strapwork: { rosettes: "Stars", fill: "Medallions" },
  veins: { flow: "Wander", leafiness: "Pods", rosettes: "Knots", fill: "Fill" },
  biomech: { flow: "Flow", leafiness: "Ribs", rosettes: "Orifices", fill: "Fill" },
  girih: { flow: "Panels", rosettes: "Rosettes", fill: "Fill" },
  guilloche: { flow: "Panels", rosettes: "Motifs", lobes: "Lobes", fill: "Splits" },
  nouveau: { flow: "Sway", leafiness: "Leaves", rosettes: "Flowers", fill: "Fill" },
  coral: { flow: "Wander", leafiness: "Texture", rosettes: "Forks", fill: "Pores" },
};
const RANGES = { flow: [0, 1, 0.01], leafiness: [0, 1, 0.01], rosettes: [0, 1, 0.01], lobes: [2, 6, 1], fill: [0, 1, 0.01] };
const optionRows = {};
for (const [pattern, names] of Object.entries(OPTIONS))
  for (const [key, label] of Object.entries(names)) {
    const rows = (optionRows[key + "/" + label] ??= []);
    rows.push(pattern);
  }
const ORDER = Object.keys(RANGES);
for (const [id, patterns] of Object.entries(optionRows).sort((a, b) => ORDER.indexOf(a[0].split("/")[0]) - ORDER.indexOf(b[0].split("/")[0]))) {
  const [key, label] = id.split("/");
  gui.addSlider(label, params[key], ...RANGES[key], { visibleWhen: () => patterns.includes(params.motif()) });
}
gui.addSection("Relief");
// Randomized only over a moderate range: low relief loses the detail, high relief swamps it.
gui.addSlider("Relief", params.relief, 0, 2, 0.01).randomize = () => params.relief.set(Math.round((0.85 + Math.random() * 0.4) * 100) / 100);
gui.addSlider("Grind", params.grind, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Bite", params.etch, 0, 2, 0.01);
gui.addSlider("Matting", params.matting, 0, 1, 0.01);
gui.addSection("Finish");
gui.addSelect("Metal", params.look, Object.keys(LOOKS));
gui.addSection("Process");
gui.addSlider("Speed", params.speed, 0.25, 3, 0.01, { randomizable: false });
// Auto change counts once the process has finished: autoTime is how long a finished piece stays up.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, max: 90, onChange: () => autoNext(), ready: () => !busy && (built === buildKey() || buildKey() === failedKey) && swap.phase === "idle" && clock >= processEnd() });
gui.addSection("View");
gui.addSlider("Spin", params.spin, 0, 0.5, 0.01, { randomizable: false });
gui.addCheckbox("Studio", params.studio, { randomizable: false });
pipeline.addGUI(gui);
gui.addSeparator();

let clock = 0;
const replay = () => ((clock = 0), fumes.reset(), autoChange.restart());
addKey("KeyE", "replay the etching", replay);
gui.addText('<a href="gallery/">The Etcher\'s Pattern Book</a>: every shape, pattern and finish, rendered.');
gui.addText(keysHelp());
showHint("Drag to spin the piece · scroll to zoom · Space, then drag to look around · R for a new piece", "Drag to spin the piece · pause, then drag to look around · tap {randomize} for a new piece");

const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
addActionLink("../assets/gallery.svg", "Gallery: The Etcher's Pattern Book", "gallery/");
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
// Paused, a drag orbits the camera instead of spinning the piece.
onPause((running) => {
  sound.setPaused(!running);
  controls.enableRotate = !running;
  drag.active = false;
});
showSoundHint(() => !sound.running);
const soundStats = { tinks: 0, splashes: 0 };
gui.show();

const scene = new Scene();
// Phones (medium and low tiers) take one relief sample a pixel and the slope from screen derivatives.
const RELIEF_SAMPLES = pipeline.quality === "high" || pipeline.quality === "capture" ? 3 : 1;
// On first load the bare blank goes up in a program that compiles at once, while the relief's own compiles.
const blankMaterial = createBlankMaterial();
blankMaterial.uniforms.ornSamples.value = RELIEF_SAMPLES;
let material = blankMaterial;
const mesh = new Mesh(undefined, material);
// One material per set of primitive types and finish (the shader only compiles the types a piece uses, and the
// finish code its metal needs), each compiled once.
const materials = {};
const RELIEF_TEXTURES = ["ornPrims", "ornCells", "ornList", "ornBlows"];
function materialFor(types, look) {
  const finish = finishDefines(look);
  const key = types.join(",") + "/" + finish.join(",");
  if (!materials[key]) {
    const m = createReliefMaterial();
    m.defines = { ...m.defines, ...Object.fromEntries([...types.map((t) => "ORN_T" + t), ...finish].map((d) => [d, ""])), ...(RELIEF_SAMPLES === 1 ? { ORN_SAMPLES_1: "" } : {}) };
    m.uniforms.ornSamples.value = RELIEF_SAMPLES;
    m.userData.key = key;
    materials[key] = m;
  }
  return materials[key];
}
// Compiles a material off to the side (the piece on show keeps rendering meanwhile), once.
function compileMaterial(m, geometry) {
  if (!m.userData.compiling) {
    const side = new Scene();
    side.add(new Mesh(geometry, m));
    const t0 = performance.now();
    m.userData.compiling = pipeline.compileAsync(side, camera).then(() => {
      m.userData.compiled = true;
      m.userData.ms = performance.now() - t0;
    });
  }
  return m.userData.compiling;
}
// The material a wait is for (the making pill says the GPU is at it).
let awaited = null;
// Whether m is ready to go on; if not, its compile is under way and the pill counts it.
function awaitMaterial(m, geometry) {
  if (m === material || m.userData.compiled) return true;
  if (awaited !== m) {
    awaited = m;
    making.compiling = performance.now();
  }
  compileMaterial(m, geometry);
  return false;
}
// The piece on show changes program (a metal whose finish needs another), keeping its ornament.
function switchMaterial(next) {
  takeOver(next);
  for (const k of RELIEF_TEXTURES) {
    next.uniforms[k].value = material.uniforms[k].value;
    material.uniforms[k].value = null;
  }
  material = next;
  mesh.material = material;
  pipeline.restartAccumulation();
}
// The next piece's material takes over the look and the process state from the current one, as it goes on (the look
// may have changed while it compiled).
function takeOver(next) {
  if (next === material) return;
  for (const k in material.uniforms) {
    if (globalUniforms[k] === material.uniforms[k] || RELIEF_TEXTURES.includes(k) || !next.uniforms[k]) continue;
    const v = material.uniforms[k].value;
    next.uniforms[k].value = v?.clone ? v.clone() : v;
  }
}
scene.add(mesh);
// The studio: a floor and sweep under the floating piece, taking its soft shadow. Off by default on the low tier.
const backdrop = createBackdrop();
backdrop.mesh.renderOrder = 1;
scene.add(backdrop.mesh);
// Vapour off the acid, and ripples in its film: high tier only.
const ACID_FX = pipeline.quality === "high" || pipeline.quality === "capture";
const fumes = createFumes();
if (ACID_FX) {
  // The vapour goes over the lit image.
  pipeline.composite = (hdr, ctx) => fumes.render(renderer, hdr, ctx);
}
const _box = new Box3();
const shownPose = new Matrix4();

const geometries = {};
// Finer meshes would only add small triangles the relief shader pays for in partly covered pixel blocks.
const DETAIL = pipeline.quality === "capture" ? 160 : 110;
const ORIENT = { sphere: [0.3, 0, 0], torus: [1.0, 0, 0.25], box: [0.62, 0.785, 0], pillow: [0.42, 0.55, 0.1], knot: [1.15, 0, 0.1], twist: [0.95, 0.3, 0.2], moebius: [0.55, 0.4, 0.15], blob: [0.25, 0.6, -0.15], suzanne: [-0.37, 0.5, 0, "YXZ"], gyroid: [0.5, 0, 0.12], dodeca: [-1.0172, 0, 0, "YXZ"], icosa: [-1.0172, 0, 0, "YXZ"], lens: [0.48, 0, 0.3], knot25: [1.15, 0, 0.1] };

// Pieces are grown in a worker; the current one stays up until the next is ready.
const workerUrl = new URL("./build.worker.js", import.meta.url);
const worker = new Worker(workerUrl, { type: "module" });
let built = "";
let requested = "";
let busy = false;
let blows = [];
// How many motifs are being scribed at each point of the drawing, for the scratch's loudness.
let activity = new Float32Array(64);
// On first load, the blank on show (its shape) while the relief's program compiles; the process waits for it.
let blank = null;
// The shape on show, and the fumes' obstacle field of each shape (baked in the worker).
let shownShape = null;
let shownTypes = [];
// A metal change on the piece on show waiting for its finish's program.
let lookPending = null;
const fields = {};
let firstShow;
const firstShown = new Promise((resolve) => (firstShow = resolve));
const buildKey = (p = params) => [p.shape(), p.pattern(), p.scale(), p.motif(), p.symmetry(), p.flow(), p.leafiness(), p.rosettes(), p.lobes(), p.fill()].join();
const buildRequest = (id, p, prefetch = false) => ({
  id,
  prefetch,
  shape: p.shape(),
  mesh: geometries[p.shape()] ? 0 : DETAIL,
  field: ACID_FX,
  opts: {
    seed: p.pattern(),
    scale: p.scale(),
    pattern: p.motif(),
    symmetry: p.symmetry(),
    flow: p.flow(),
    leafiness: p.leafiness(),
    rosettes: p.rosettes(),
    lobes: p.lobes(),
    fill: p.fill(),
  },
});
function requestBuild() {
  const key = buildKey();
  if (busy || key === requested) return;
  requested = key;
  busy = true;
  // Grown ahead (kiosk mode): straight on, or as soon as it comes.
  if (prefetch.key === key && (prefetch.result || !prefetch.done)) {
    const d = prefetch.result;
    prefetch.result = null;
    if (d) applyBuild(d).catch((err) => buildFailed(key, err));
    else prefetch.taken = true;
    return;
  }
  // Grown ahead for a recording (app.preload).
  if (grown.has(key)) {
    const d = grown.get(key);
    grown.delete(key);
    applyBuild(d).catch((err) => buildFailed(key, err));
    return;
  }
  worker.postMessage(buildRequest(key, params));
}
// Recordings: pieces grown and compiled ahead (app.preload), put on when their params come up (app.nextLook).
const grown = new Map();
const growing = new Map();
let preloadWorker = null;
async function preloadPieces(picks = []) {
  preloadWorker ??= Object.assign(new Worker(workerUrl, { type: "module" }), { onmessage: onWorkerMessage });
  for (const pick of picks) {
    // The pick as the page would fit it (symmetries the shape and pattern allow).
    const was = params.$snapshot(params.$keys);
    let values;
    try {
      params.$apply({ ...was, ...pick });
      symmetryKey = "";
      fitSymmetry();
      values = params.$snapshot(params.$keys);
    } finally {
      params.$apply(was);
      symmetryKey = "";
      fitSymmetry();
    }
    const sig = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, () => v]));
    const key = buildKey(sig);
    if (grown.has(key)) continue;
    const d = await new Promise((resolve) => {
      growing.set(key, resolve);
      preloadWorker.postMessage(buildRequest(key, sig, "preload"));
    });
    growing.delete(key);
    await compileMaterial(materialFor(d.types, values.look), geometries[d.shape]);
  }
  while (blank || busy || built !== buildKey() || swap.phase !== "idle") await new Promise((r) => setTimeout(r, 100));
}
// { clear: hold }: once the piece on show is finished and held `hold` seconds, it shrinks away for good.
let clearing = null;
function nextPiece(pick = {}) {
  if (pick.clear !== undefined) return void (clearing = { hold: pick.clear });
  for (const [k, v] of Object.entries(pick)) params[k]?.set(v);
}
// A piece that can't be built (or compiled) is logged and given up on: the page carries on with the one on show (or,
// on first load, clears the loader), rather than waiting for it forever.
let failedKey = null;
function buildFailed(id, err) {
  console.error("build", id, err);
  busy = false;
  making.compiling = 0;
  awaited = null;
  failedKey = id;
  swap.ready = null;
  if (blank) blank.failed = true;
  if (built && swap.phase === "out") (swap.phase = "in"), (swap.t = 0);
  firstShow();
}
worker.onerror = (e) => buildFailed(requested, e.message);
function onWorkerMessage(e) {
  const d = e.data;
  if (d.error) {
    if (!d.prefetch) buildFailed(d.id, d.error);
    else if (d.id === prefetch.key) {
      prefetch.done = true;
      if (prefetch.taken) buildFailed(d.id, d.error);
    }
    return;
  }
  if (d.kind === "mesh") return addMesh(d);
  if (d.kind === "field") {
    fields[d.shape] ??= d.field;
    if (ACID_FX && shownShape === d.shape) fumes.setShape(fields[d.shape]);
    return;
  }
  if (d.prefetch === "preload") return grown.set(d.id, d), growing.get(d.id)?.(d);
  if (d.prefetch) return prefetched(d);
  applyBuild(d).catch((err) => buildFailed(d.id, err));
}
worker.onmessage = onWorkerMessage;
function addMesh({ shape, mesh: m, grid, prefetch: pre }) {
  if (grid && SHAPES[shape].adopt && !SHAPES[shape].grid) SHAPES[shape].adopt(grid);
  if (!geometries[shape]) {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(m.position, 3));
    g.setAttribute("normal", new BufferAttribute(m.normal, 3));
    g.setIndex(new BufferAttribute(m.index, 1));
    g.computeBoundingSphere();
    geometries[shape] = g;
  }
  // First load: the blank goes up at once, while its ornament grows and its program compiles.
  if (!pre && !built && !blank && shape === params.shape()) {
    putBlank(shape);
    firstShow();
  }
}
async function applyBuild(d) {
  const { id, shape, packed, blows: b, activity: a, types } = d;
  // A newer request supersedes this one.
  if (id !== buildKey()) {
    busy = false;
    return requestBuild();
  }
  const relief = buildRelief(packed);
  console.log("ornament", shape, packed.ms.toFixed(0) + " ms", relief.stats);
  // Compiled for the metal it will have (updateSwap checks again, in case that changes meanwhile).
  const next = materialFor(types, params.look());
  if (!awaitMaterial(next, geometries[shape])) await compileMaterial(next, geometries[shape]);
  busy = false;
  // The first piece goes on as soon as it is ready (updateSwap), later ones once the current has shrunk away.
  swap.ready = { id, shape, next, types, relief, b, a };
}

// Kiosk mode: while a piece plays out, the next one (what the next auto change's seed gives) is grown in a worker of its
// own and its program compiled, so the change rarely waits.
const prefetch = { state: "", pending: "", since: 0, seed: null, key: null, look: null, result: null, done: false, taken: false, worker: null };
const stateKey = () => getSeed() + "|" + JSON.stringify(params.$snapshot(params.$keys));
// What randomizing with this seed would set, without changing anything on show.
function predict(seed) {
  const was = { seed: getSeed(), random: Math.random, values: params.$snapshot(params.$keys) };
  try {
    setSeed(seed);
    randomizePiece();
    return params.$snapshot(params.$keys);
  } finally {
    params.$apply(was.values);
    setSeed(was.seed);
    Math.random = was.random;
    symmetryKey = "";
    fitSymmetry();
  }
}
function updatePrefetch(now) {
  if (!params.auto() || capturing || !built || blank || busy || built !== buildKey() || swap.phase !== "idle") return;
  const st = stateKey();
  if (st === prefetch.state) return;
  // Once the panel has been left alone a moment.
  if (st !== prefetch.pending) {
    prefetch.pending = st;
    prefetch.since = now;
  }
  if (now - prefetch.since < 1500) return;
  const seed = Math.floor(nativeRandom() * 0xffffffff).toString(36);
  const next = predict(seed);
  const sig = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, () => v]));
  Object.assign(prefetch, { state: st, seed, key: buildKey(sig), look: next.look, result: null, done: false, taken: false });
  if (!prefetch.worker) {
    prefetch.worker = new Worker(workerUrl, { type: "module" });
    prefetch.worker.onmessage = onWorkerMessage;
  }
  prefetch.worker.postMessage(buildRequest(prefetch.key, sig, true));
}
function prefetched(d) {
  if (d.id !== prefetch.key) return;
  prefetch.done = true;
  if (prefetch.taken && requested === d.id && busy) {
    prefetch.taken = false;
    applyBuild(d).catch((err) => buildFailed(d.id, err));
    return;
  }
  prefetch.result = d;
  // Lowest priority: the piece on show compiled long ago.
  compileMaterial(materialFor(d.types, prefetch.look), geometries[d.shape]).catch((err) => console.error("prefetch", err));
}
// An auto change takes the seed grown ahead, unless something has changed since.
function autoNext() {
  if (prefetch.seed && prefetch.state === stateKey()) loadSeed(prefetch.seed);
  else randomize();
}

// Changing pieces: the current one shrinks away while the next is grown in the worker, then the next comes up
// spinning, and only then is it scribed.
const SHRINK = 0.45;
const GROW = 0.9;
const swap = { phase: "in", t: 0, ready: null, scale: 0, spin: 1 };
// How long the turn on rising takes to settle.
const SETTLE = 2.4;
const easeInCubic = (x) => x * x * x;
const easeOutBack = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
// Sets a new blank in its designed pose, to rise.
function placePiece(shape) {
  // Held by a drag, it doesn't turn in on its own.
  swap.spin = drag.active ? 1 : 0;
  mesh.geometry = geometries[shape];
  shownShape = shape;
  if (ACID_FX) fumes.setShape(fields[shape] ?? null);
  const [rx, ry, rz, order = "XYZ"] = ORIENT[shape];
  qBase.setFromEuler(_euler.set(rx, ry, rz, order));
  qSpin.identity();
  mesh.scale.setScalar(1);
  mesh.quaternion.copy(qBase);
  mesh.updateMatrixWorld();
  backdrop.place(_box.setFromObject(mesh).min.y);
  clock = 0;
  swap.phase = "in";
  swap.t = 0;
  // It turns as it rises (updateSpin), landing on its designed view.
  omega.set(0, 0, 0);
}
function putBlank(shape) {
  blank = { shape };
  material = blankMaterial;
  mesh.material = material;
  placePiece(shape);
  pipeline.restartAccumulation();
}
// place: a new blank rising; otherwise the blank on show takes its ornament where it is.
function putOn({ id, shape, next, types, relief, b, a }, place = true) {
  // The material going off gives up its piece's textures (it stays cached for its program, not its data).
  const old = material !== next ? material : null;
  // A new piece takes its metal at once (a fade under way goes on in the studio), in the program made for it.
  if (place) {
    fade.material = null;
    fade.snap = true;
  }
  takeOver(next);
  setRelief(next, relief);
  material = next;
  mesh.material = material;
  if (old) for (const k of RELIEF_TEXTURES) old.uniforms[k].value?.dispose(), (old.uniforms[k].value = null);
  blows = b;
  activity = a;
  shownTypes = types;
  if (place) placePiece(shape);
  blank = null;
  built = id;
  clock = 0;
  pipeline.restartAccumulation();
  autoChange.restart();
  firstShow();
}
// What the workshop is up to while the next piece is made: a pill in the centre, with a rough progress bar (from how
// long the last build of this pattern took) and a line that changes every couple of seconds.
const MAKING = [
  "Persuading the acanthus to curl…",
  "Counting the petals twice…",
  "Untangling the knotwork…",
  "Arguing with a volute…",
  "Herding tendrils…",
  "Warming up the acid…",
  "Asking the vines nicely…",
  "Sharpening the gravers…",
  "Teaching the rosettes to share…",
  "Bribing the hammer…",
  "Looking for the end of the scroll…",
  "Smoothing a leaf's feelings…",
  "Feeding the coral…",
  "Measuring twice, chasing once…",
];
const COMPILING = [
  "Explaining ornament to the graphics card…",
  "The GPU is reading the pattern book…",
  "Translating flowers into shader…",
  "Compiling a new set of punches…",
];
const making = { el: document.querySelector("#making"), started: 0, compiling: 0, line: "", lineAt: 0, shown: false, took: {} };
// Changes the pill's line: the old text fades, the pill eases to the new width, the new text fades in.
function setPillText(span, text) {
  let b = span.firstElementChild;
  if (!b) {
    b = document.createElement("b");
    span.textContent = "";
    span.append(b);
  }
  const from = span.getBoundingClientRect().width;
  const measure = () => {
    span.style.width = "auto";
    b.textContent = text;
    const to = span.getBoundingClientRect().width;
    span.style.width = `${from}px`;
    span.getBoundingClientRect();
    span.style.width = `${to}px`;
  };
  if (!from || !b.textContent) {
    b.textContent = text;
    span.style.width = "auto";
    return;
  }
  b.style.opacity = "0";
  clearTimeout(span._t);
  span._t = setTimeout(() => {
    measure();
    b.style.opacity = "1";
  }, 180);
}

function updateMaking(now) {
  if (awaited?.userData.compiled) {
    awaited = null;
    making.compiling = 0;
  }
  // First load: the blank waits for its ornament and program (once the loader's hint has gone); a metal changing on a
  // piece on show waits for its finish's program.
  const blankWait = !!blank && !blank.failed && !document.getElementById("loading");
  const lookWait = !!lookPending && !lookPending.userData.compiled && now - making.compiling > 1000;
  const swapWait = built && (busy || swap.ready || (swap.phase === "out" && swap.t >= 1));
  const waiting = blankWait || lookWait || swapWait;
  if (waiting && !making.started) making.started = now;
  if (!waiting && making.started) {
    making.took[params.motif()] = now - making.started;
    making.started = 0;
  }
  // Only once it has been empty for a moment, so quick builds don't flash it.
  const on = waiting && (blankWait || lookWait || (swap.phase === "out" && swap.t >= 1)) && now - making.started > 150;
  if (on !== making.shown) {
    making.shown = on;
    making.el.classList.toggle("on", on);
  }
  if (!on) return;
  const list = making.compiling ? COMPILING : MAKING;
  if (now - making.lineAt > 2200 || !list.includes(making.line)) {
    let line;
    do line = list[Math.floor(nativeRandom() * list.length)];
    while (line === making.line && list.length > 1);
    making.line = line;
    making.lineAt = now;
    setPillText(making.el.firstElementChild, line);
  }
  const est = making.took[params.motif()] ?? 1800;
  const el = now - making.started;
  const p = making.compiling ? 0.85 + 0.13 * (1 - Math.exp(-(now - making.compiling) / 4000)) : 0.85 * (1 - Math.exp((-2 * el) / est));
  making.el.style.setProperty("--progress", p.toFixed(3));
}

// Whether a piece is ready to go on: its program, for the metal it goes on in, compiled.
function readyToGo(r) {
  r.next = materialFor(r.types, lookShown);
  return awaitMaterial(r.next, geometries[r.shape]);
}
function updateSwap(dt) {
  if (clearing && built && swap.phase === "idle" && clock >= processEnd() && (clearing.hold -= dt) <= 0) {
    swap.phase = "out";
    swap.t = 0;
    fumes.reset();
  }
  // A new piece asked for: shrink the one on show, from wherever it is.
  if (swap.phase !== "out" && requested !== built && requested !== failedKey && built) {
    swap.phase = "out";
    swap.t = 1 - Math.cbrt(Math.min(1, Math.max(0, swap.scale)));
    fumes.reset();
  }
  if (swap.ready && swap.ready.id !== buildKey()) swap.ready = null;
  // The first piece goes on as soon as it is ready: onto the blank on show, where it is.
  if (!built && swap.ready && readyToGo(swap.ready)) {
    const r = swap.ready;
    swap.ready = null;
    putOn(r, !(blank && blank.shape === r.shape));
  }
  if (swap.phase === "out") {
    swap.t = Math.min(1, swap.t + dt / SHRINK);
    swap.scale = 1 - easeInCubic(swap.t);
    // Gone: the studio fades to the new metal while the next piece is made; the material is set at once, unseen.
    if (swap.t >= 1 && params.look() !== lookShown) applyLook((lookShown = params.look()), false, true);
    if (swap.t >= 1) syncShown();
    if (swap.t >= 1 && swap.ready && readyToGo(swap.ready)) {
      putOn(swap.ready);
      swap.ready = null;
    }
  } else if (swap.phase === "in" && (built || blank)) {
    swap.t = Math.min(1, swap.t + dt / GROW);
    swap.scale = easeOutBack(swap.t);
    if (swap.t >= 1) swap.phase = "idle";
  }
  mesh.visible = swap.scale > 1e-3;
  mesh.scale.setScalar(Math.max(swap.scale, 1e-3));
}

camera.near = 0.02;
camera.updateProjectionMatrix();
camera.position.set(0.4, 0.5, 3.6);
controls.target.set(0, 0, 0);
// Running, a drag spins the piece like a trackball, with inertia (after day 9); left alone it turns about the vertical
// at Spin, settling back upright.
controls.enableRotate = false;
const qBase = new Quaternion();
const qSpin = new Quaternion();
const omega = new Vector3();
const _euler = new Euler();
const _q = new Quaternion();
const _right = new Vector3();
const _upv = new Vector3();
const _upAxis = new Vector3(0, 1, 0);
const stir = { next: 1 };
// A recording can ask for the stirring the kiosk does (app.stir).
let stirAlways = false;
const capturing = new URLSearchParams(location.search).has("capture");
const _axis = new Vector3();
const drag = { active: false, id: -1, x: 0, y: 0, vx: 0, vy: 0, idle: 99 };
const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  if (drag.active || !isRunning() || e.button !== 0) return;
  drag.active = true;
  // Grabbing it ends the settling turn where it is.
  swap.spin = 1;
  drag.id = e.pointerId;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.vx = drag.vy = 0;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.active || e.pointerId !== drag.id) return;
  drag.vx += e.clientX - drag.x;
  drag.vy += e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
});
for (const type of ["pointerup", "pointercancel"])
  canvas.addEventListener(type, (e) => {
    if (e.pointerId === drag.id) drag.active = false;
  });
// The camera eases out as the acid goes on, so the whole smoke column is in view for the etch, and back in
// once the etch is over. Whatever the viewer sets (orbit, zoom) becomes the base it works from.
const framing = { f: 1, lift: 0, user: false };
controls.addEventListener("start", () => (framing.user = true));
controls.addEventListener("end", () => (framing.user = false));
const _ft = new Vector3();
function updateFraming(dt) {
  const st = stages();
  const wide = swap.phase === "idle" ? smooth(st.etch[0] - 0.3, st.etch[0] + 2.2, clock) * (1 - smooth(st.etch[1] + 0.3, st.etch[1] + 3.3, clock)) : 0;
  // While the viewer moves the camera, theirs is the framing; this picks up from there afterwards.
  if (framing.user) return;
  const k = 1 - Math.exp(-(dt || 0) * 1.6);
  const f = framing.f + (1 + 0.65 * wide - framing.f) * k;
  const lift = framing.lift + (0.45 * wide - framing.lift) * k;
  // Back to the viewer's own framing, then out to this frame's.
  const base = _ft.copy(controls.target);
  base.y -= framing.lift;
  const dir = camera.position.clone().sub(controls.target);
  const dist = dir.length() / framing.f;
  dir.normalize();
  controls.target.copy(base).y += lift;
  camera.position.copy(controls.target).addScaledVector(dir, dist * f);
  framing.f = f;
  framing.lift = lift;
}

function updateSpin(dt) {
  if (dt <= 0) return;
  // Rising: one full turn about the vertical, easing out onto the shape's designed view (ORIENT), not wherever a
  // momentum spin would have left it.
  if (swap.spin < 1 && !drag.active) {
    swap.spin = Math.min(1, swap.spin + dt / SETTLE);
    // A long, soft tail: most of the turn early, the last degrees drifting in.
    const e = 1 - (1 - swap.spin) ** 4;
    qSpin.setFromAxisAngle(_upAxis, -2 * Math.PI * (1 - e));
    omega.set(0, 0, 0);
    drag.idle = 0;
    mesh.quaternion.multiplyQuaternions(qSpin, qBase);
    return;
  }
  if (drag.active) {
    const k = 5.5 / Math.min(innerWidth, innerHeight);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _upv.setFromMatrixColumn(camera.matrixWorld, 1);
    _axis.copy(_upv).multiplyScalar(drag.vx).addScaledVector(_right, drag.vy).multiplyScalar(k / dt);
    omega.lerp(_axis, 1 - Math.exp(-dt * 25));
    drag.vx = drag.vy = 0;
    drag.idle = 0;
  } else {
    // After a drag it coasts down; the slow turn comes back once it has been left alone a while.
    drag.idle += dt;
    const back = Math.min(Math.max((drag.idle - 1.5) / 3, 0), 1);
    // A face (Suzanne) doesn't turn its back: instead of the slow turn it sways about its designed view (below).
    const faced = SHAPES[params.shape()]?.faced;
    _axis.set(0, faced ? 0 : params.spin() * back * back * (3 - 2 * back), 0);
    omega.lerp(_axis, 1 - Math.exp(-dt * (back > 0 ? 0.8 : 1.2)));
    // Auto mode, left alone during the etch: now and then a stir, a spin or a nudge, to swirl the fumes.
    const etchNow = stage("etch");
    const stirring = params.auto() && (!capturing || stirAlways) && swap.phase === "idle" && etchNow > 0.06 && etchNow < ACID.drain[0] - 0.04 && drag.idle > 3;
    if (stirring && (stir.next -= dt) <= 0) {
      stir.next = 1.8 + 1.6 * nativeRandom();
      const r = nativeRandom;
      _axis.set((r() - 0.5) * 1.2, 1, (r() - 0.5) * 1.2).normalize().multiplyScalar((r() < 0.5 ? -1 : 1) * (2.2 + 2.2 * r()));
      omega.add(_axis);
    }
    // And tips back upright: toward the turn about the vertical alone that it is closest to.
    if (back > 0 && !stirring) {
      if (faced) _q.setFromAxisAngle(_upAxis, Math.min(0.5, params.spin() * 6) * Math.sin(performance.now() / 1000 * 0.35));
      else _q.set(0, qSpin.y, 0, qSpin.w).normalize();
      qSpin.slerp(_q, 1 - Math.exp(-dt * 0.6 * back));
    }
  }
  const a = omega.length();
  if (a > 1e-6) {
    _q.setFromAxisAngle(_axis.copy(omega).divideScalar(a), a * dt);
    qSpin.premultiply(_q);
  }
  mesh.quaternion.multiplyQuaternions(qSpin, qBase);
}
controls.minDistance = 1.25;
controls.maxDistance = 8;
// Render scale: a safety net for slow devices, dropped one step at a time only while frames stay well under 25 fps, never raised.
const adaptive = !new URLSearchParams(location.search).has("capture") && !new URLSearchParams(location.search).has("noadapt") && pipeline.quality !== "capture";
const view = { w: 1, h: 1, dpr: 1, scale: 1, ema: 16, last: 0, checked: 0, slow: 0 };
// The pipeline follows the canvas's drawing buffer, so the scale goes through the renderer's pixel ratio.
const applySize = () => {
  renderer.setPixelRatio(view.dpr * view.scale);
  pipeline.setSize(view.w, view.h, view.dpr * view.scale);
};
onResize((w, h, dpr) => {
  Object.assign(view, { w, h, dpr });
  applySize();
});
function adaptScale(now) {
  const frame = view.last ? now - view.last : 16;
  view.last = now;
  if (!adaptive || frame > 250) return;
  // The empty frames while pieces change over would make it climb, only to drop again when the next piece is up.
  if (swap.phase !== "idle") return;
  view.ema += (frame - view.ema) * 0.05;
  if (now - view.checked < 1500) return;
  view.checked = now;
  view.slow = view.ema > 40 ? view.slow + 1 : 0;
  if (view.slow < 4 || view.scale <= 0.5) return;
  view.slow = 0;
  view.ema = 16;
  view.scale = Math.max(0.5, view.scale * 0.8);
  applySize();
}

function randomizePiece() {
  gui.randomizeAll();
  params.pattern.set(1 + Math.floor(Math.random() * 9999));
  // Smaller scales multiply the motifs (and the build time): keep to the range that reads well.
  params.scale.set(Math.round((1.05 + Math.random() * 0.6) * 100) / 100);
  // Enamel needs ground to lie in: scales, seigaiha and turned panels leave almost none.
  const groundless = ["scales", "seigaiha", "guilloche"];
  const patterns = Object.keys(PATTERNS).filter((p) => !groundless.includes(p));
  if (LOOKS[params.look()].fill && groundless.includes(params.motif())) params.motif.set(patterns[Math.floor(Math.random() * patterns.length)]);
  const avoid = SHAPES[params.shape()].avoid ?? [];
  if (avoid.includes(params.motif())) {
    const ok = patterns.filter((p) => !avoid.includes(p));
    params.motif.set(ok[Math.floor(Math.random() * ok.length)]);
  }
  fitSymmetry();
  if (Math.random() < 0.4) params.symmetry.set("none");
}
onRandomize(randomizePiece);
applyUrlState();
fitSymmetry();

let liveShown = "";
requestBuild();
studios[params.look()] = await load.studio.track(createStudioEnvironmentAsync(renderer, studioOptions(params.look())));
applyLook(params.look(), true);
backdrop.snap();
lookShown = params.look();
// The blank goes up as soon as its mesh comes (the relief's program compiles meanwhile, and the process waits for it).
await load.build.track(firstShown);
await load.sound.track(sound.loaded);
await load.compile.track(pipeline.compileAsync(scene, camera), 1);
// The fumes aren't needed until the etch: their noise and shaders are made once the piece is up.
if (ACID_FX) setTimeout(() => fumes.prepare(renderer), 300);

window.app = { preload: preloadPieces, nextLook: nextPiece, set stir(v) { stirAlways = v; }, canvas: renderer.domElement, params, pipeline, camera, controls, mesh, get material() { return material; }, replay, sound, soundStats, fumes, get building() { return busy || !!blank || built !== buildKey() || swap.phase !== "idle" || swap.spin < 1; }, get clock() { return clock; }, set clock(v) { clock = v; } };

const stage = (name) => {
  const s = stages()[name];
  // A stage this look doesn't have counts as done once the process is (a finished enamel piece turning to plain metal).
  if (!s) return clock >= processEnd() ? 1 : 0;
  const [a, b] = s;
  return Math.min(1, Math.max(0, (clock - a) / (b - a)));
};

const _p = new Vector3();
const _n = new Vector3();
const _d = new Vector3();
// The piece sways gently while it is scribed, and at each hammer blow jolts (a stiff spring) and swings (a soft one,
// in rotation), settling between blows.
const shake = { x: new Vector3(), v: new Vector3(), r: new Vector3(), w: new Vector3(), s: new Vector3(), sw: new Vector3(), sway: 0 };
const _sq = new Quaternion();
function spring(x, v, k, zeta, h) {
  v.addScaledVector(x, -k * h).multiplyScalar(Math.max(0, 1 - 2 * Math.sqrt(k) * zeta * h));
  x.addScaledVector(v, h);
}
function updateShake(dt, t) {
  if (dt <= 0) return;
  const h = Math.min(dt, 1 / 30);
  spring(shake.x, shake.v, 700, 0.28, h);
  spring(shake.r, shake.w, 700, 0.28, h);
  spring(shake.s, shake.sw, 28, 0.12, h);
  // The scribing sway eases in and out with the drawing.
  const draw = stage("draw");
  const target = swap.phase === "idle" && draw > 0 && draw < 1 ? 0.6 + 0.4 * activity[Math.round(draw * 63)] : 0;
  shake.sway += (target - shake.sway) * (1 - Math.exp(-dt * 1.5));
  const a = 0.035 * shake.sway;
  const rx = a * (Math.sin(t * 1.3) + 0.4 * Math.sin(t * 2.9 + 1)) + shake.r.x + shake.s.x;
  const rz = a * (Math.sin(t * 1.05 + 2) + 0.4 * Math.sin(t * 2.3 + 4)) + shake.r.z + shake.s.z;
  // Rinsing: shaken off, brisk side-to-side swings with a tilt, dying away over the drain, and one quick spin.
  const etch = stage("etch");
  const off = swap.phase === "idle" && etch > ACID.drain[0] && etch < 1 ? smooth(ACID.drain[0], ACID.drain[0] + 0.03, etch) * (1 - smooth(ACID.drain[0], ACID.drain[1], etch)) : 0;
  if (off > 0 && !shake.flicked) {
    shake.flicked = true;
    if (!drag.active) omega.y += (nativeRandom() < 0.5 ? -1 : 1) * 6;
  }
  if (etch < ACID.drain[0]) shake.flicked = false;
  // A shake, not a sway: bursts of quick jerks with hard reversals (a squared-off wave), the burst and its strength
  // dying away over the drain.
  const tl = (etch - ACID.drain[0]) * (stages().etch[1] - stages().etch[0]);
  const ph = tl * 1.15 - Math.floor(tl * 1.15);
  const burst = off * smooth(0, 0.06, ph) * (1 - smooth(0.42, 0.55, ph));
  // In real time, so a fast Speed doesn't push the jerks past the frame rate into jitter.
  const jerk = (f, o) => {
    const v = Math.sin((performance.now() / 1000) * 2 * Math.PI * f + o);
    return Math.sign(v) * Math.abs(v) ** 0.3;
  };
  const jx = burst * jerk(5.6, 0), jz = burst * jerk(5.6, 1.9);
  mesh.position.copy(shake.x).y += 0.006 * shake.sway * Math.sin(t * 1.7 + 0.5);
  mesh.position.x += 0.065 * jx;
  mesh.position.z += 0.025 * jz;
  mesh.position.y += 0.012 * burst * jerk(11.2, 0.7);
  _sq.setFromEuler(_euler.set(rx + 0.05 * jz, 0.08 * jx, rz - 0.16 * jx));
  mesh.quaternion.premultiply(_sq);
}

function playSound(prevHammer, hammer, dt) {
  // Pieces changing over: the workshop falls quiet (the loops fade out quickly).
  if (swap.phase !== "idle") {
    for (const name of ["scratch", "torch", "stone", "fizz", "rub", "hiss"]) sound.setLoop(name, 0, 1);
    return;
  }
  for (const b of blows) {
    if (b.t <= prevHammer || b.t > hammer) continue;
    _p.fromArray(b.p).applyMatrix4(mesh.matrixWorld);
    _n.fromArray(b.n).transformDirection(mesh.matrixWorld);
    // The blow knocks the piece back along it, and twists it a little.
    shake.v.addScaledVector(_n, -0.22 * (0.5 + b.depth));
    shake.w.x += (nativeRandom() - 0.5) * 0.5;
    shake.w.z += (nativeRandom() - 0.5) * 0.5;
    // And swings it away from where it was struck, about the axis across the blow.
    _axis.set(0, 1, 0).cross(_n).multiplyScalar(-0.09 * (0.5 + b.depth));
    shake.sw.x += _axis.x;
    shake.sw.z += _axis.z;
    // Blows on the far side sound duller.
    const facing = _n.dot(_d.copy(camera.position).sub(_p).normalize());
    _p.project(camera);
    if (sound.tink({ gain: (0.35 + 0.5 * b.depth) * (0.55 + 0.45 * Math.max(0, facing)), pan: _p.x * 0.7, rate: 1.15 - b.R * 0.6 + 0.1 * Math.max(0, facing) })) soundStats.tinks++;
  }
  const speed = params.speed();
  const draw = stage("draw");
  const scribing = draw > 0 && draw < 1 ? 0.15 + 0.5 * activity[Math.round(draw * 63)] : 0;
  // The enamel powder being packed: a lighter, lower scratch.
  const fill = stage("fill");
  const packing = fill > 0 && fill < 1 ? 0.18 * Math.sin(Math.PI * fill) ** 0.3 : 0;
  sound.setLoop("scratch", scribing || packing, Math.sqrt(speed) * (scribing ? 1 : 0.6));
  const fire = stage("fire");
  sound.setLoop("torch", fire > 0 && fire < 1 ? 0.5 * Math.sin(Math.PI * fire) ** 0.3 : 0, 1);
  const grind = stage("grind");
  sound.setLoop("stone", grind > 0 && grind < 1 ? 0.6 * Math.sin(Math.PI * grind) ** 0.4 : 0, Math.sqrt(speed));
  // The acid's sizzle follows the bite and the fumes, the fizz of its bubbles under it, both brighter while it eats fastest.
  const etch = stage("etch");
  const wet = Math.min(1, etch / ACID.flood);
  sound.setLoop("fizz", 0.45 * acid.rate * wet, (0.8 + 0.35 * acid.rate) * Math.sqrt(speed));
  sound.setLoop("hiss", 0.5 * acid.rate * wet * (0.6 + 0.4 * Math.min(1, acid.fumes * 1.5)), (0.92 + 0.12 * acid.rate) * Math.sqrt(speed));
  // The rinse: a splash as the bath drains off.
  const rinsing = etch >= ACID.drain[0] && etch < 1;
  if (rinsing && acid.rinsed && sound.splash({ gain: 0.7 })) soundStats.splashes++;
  acid.rinsed = !rinsing && etch < ACID.drain[0];
  const burnish = stage("burnish");
  sound.setLoop("rub", burnish > 0 && burnish < 1 ? 0.5 * Math.sin(Math.PI * burnish) ** 0.5 : 0, Math.sqrt(speed));
}
// The acid's cover on the piece as it spreads and rinses off, and the vapour it gives off.
const acid = { rate: 0, prevBite: 0, fumes: 0, rinsed: true };
// The fumes' own time: the process clock's pace, but it runs on while pieces change over, so the vapour drifts off.
let fumeTime = 0;
function updateAcid(u, dt) {
  const etch = stage("etch");
  const level = Math.min(smooth(0, ACID.flood, etch), 1 - smooth(ACID.drain[0], ACID.drain[1], etch));
  // How much of the surface the acid covers: 0..1 spreading, 1..2 retreating (relief.js reads which).
  const draining = etch >= ACID.drain[0];
  u.acidLine.value = etch > 0 && etch < 1 && level > 0.001 ? (draining ? 2 - level : level) : -1e3;
  u.acidRipple.value = ACID_FX ? 1 : 0;
  // How fast the ground is being eaten: the bite front sweeps out from the walls over the middle of the etch.
  const bite = Math.min(1, Math.max(0, (etch - 0.04) / 0.8));
  const rate = bite > 0 && etch < ACID.drain[0] ? 0.3 + 0.7 * Math.sin(Math.PI * bite) ** 0.6 : 0;
  acid.rate += (rate - acid.rate) * (1 - Math.exp(-(dt || 0) * 3));
  acid.fumes = ACID_FX && swap.phase === "idle" ? level * (0.35 + 0.65 * acid.rate) : 0;
  const mc = shownLook().metal;
  // The fumes come off where the acid lies on the piece.
  fumes.update(fumeTime, acid.fumes, u.acidLine.value, mesh, Math.min(1, Math.max(0, (mc[0] - mc[2]) * 1.6)));
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

render(({ dt }) => {
  adaptScale(performance.now());
  autoChange.update(dt);
  fitSymmetry();
  requestBuild();
  // While pieces change over, a new metal waits for the old piece to be gone (updateSwap puts it on with the next).
  const swapping = built && (requested !== built || busy || swap.ready || swap.phase === "out");
  if (params.look() === lookShown || swapping) lookPending = null;
  else {
    // The piece on show keeps its metal until the new finish's program is compiled, then fades over to it.
    const target = built ? materialFor(shownTypes, params.look()) : material;
    if (awaitMaterial(target, mesh.geometry)) {
      lookPending = null;
      // A finished piece changing metal shows the new one finished, rather than replaying its later stages.
      const finished = clock >= (LOOKS[lookShown].fill ? FILL_END : PROCESS_END);
      applyLook((lookShown = params.look()), false, false, target);
      if (finished) {
        clock = processEnd();
        pipeline.restartAccumulation();
      }
    } else lookPending = target;
  }
  updateSwap(dt);
  updateFade(dt || 1 / 60);
  updateMaking(performance.now());
  updatePrefetch(performance.now());
  const before = clock;
  // The process waits while pieces change over.
  if (swap.phase === "idle" && !blank) clock = Math.min(processEnd(), clock + dt * params.speed());
  fumeTime += dt * params.speed();
  const u = material.uniforms;
  u.ornDraw.value = stage("draw");
  const prevHammer = u.ornHammer.value;
  u.ornHammer.value = stage("hammer");
  u.ornEtch.value = stage("etch");
  u.ornPatina.value = stage("patina");
  u.ornBurnish.value = stage("burnish");
  u.ornFill.value = stage("fill");
  u.ornFire.value = stage("fire");
  u.ornGrind.value = stage("grind");
  u.ornTime.value = clock;
  updateAcid(u, dt);
  // The relief settings on show follow the panel, except while pieces change over: then they wait until the old
  // piece is gone (updateSwap), so it never shows the next piece's settings.
  if (!swapping) syncShown();
  u.reliefHeight.value = shown.relief;
  u.etchDepth.value = 0.006 * shown.etch;
  u.matting.value = shown.matting * (shownLook().matting ?? 1);
  // Live settings the pipeline can't see: a change starts the still over.
  // Grind lowers a flat cutting level from above the tallest motifs to near the ground.
  u.shaveLevel.value = shown.grind > 0 ? 0.013 * (1 - shown.grind) * shown.relief + 0.0006 : 1e3;
  const live = [shown.relief, shown.grind, shown.etch, shown.matting, params.studio()].join();
  if (live !== liveShown) {
    liveShown = live;
    pipeline.restartAccumulation();
  }
  updateSpin(dt);
  backdrop.mesh.visible = params.studio();
  backdrop.update(dt || 1 / 60);
  // Inside the studio the camera stays above the floor and within the sweep.
  updateFraming(dt);
  controls.maxDistance = (params.studio() ? 5 : 8) * framing.f;
  controls.maxPolarAngle = params.studio() ? Math.PI * 0.56 : Math.PI;
  playSound(clock > before ? prevHammer : u.ornHammer.value, u.ornHammer.value, dt);
  updateShake(dt, clock);
  mesh.updateMatrixWorld();
  u.ornModel.value.setFromMatrix4(mesh.matrixWorld);
  controls.update();
  // The pipeline can't see the spin (the bounds don't change), nor the process; paused, nothing moves, so the still accumulates.
  // Any change of the piece's pose (spin, the settle back upright, the springs of the shake), measured on the matrix
  // itself: the pipeline can't see it, and averaging frames of different poses leaves a ghost.
  const moved = !mesh.matrixWorld.equals(shownPose) && mesh.matrixWorld.elements.some((v, i) => Math.abs(v - shownPose.elements[i]) > 1e-6);
  // Motion blur from the piece's real motion: its pose a frame ago as the shutter's (the pipeline's own guess, from
  // the last motion it measured, keeps blurring a piece that has come to rest).
  mesh.userData.shutterManual = true;
  (mesh.userData.shutterMatrixWorld ??= new Matrix4()).copy(shownPose);
  shownPose.copy(mesh.matrixWorld);
  if (clock !== before || swap.phase !== "idle" || moved) pipeline.restartAccumulation(false);
  pipeline.render(scene, camera, clock);
});
