import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, addKey, addActionButton, onPause, isRunning } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3, BufferGeometry, BufferAttribute, Box3, Quaternion, Euler } from "three";
import { createBackdrop } from "./backdrop.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createAutoChange } from "modules/autoChange.js";
import { SHAPES } from "./shapes.js";
import { buildRelief, createReliefMaterial, setRelief } from "./relief.js";
import { createSound } from "./sound.js";
import { createFumes } from "./fumes.js";
import { PATTERNS } from "./patterns/index.js";
import { nativeRandom } from "modules/random.js";

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
    blankRough: 0.24,
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
  aperture: 0.004,
  studio: true,
  spin: 0.06,
  speed: 1,
  auto: true,
  // Counted once the process has finished: how long a finished piece stays up.
  autoTime: 10,
};
const params = fromDefaults(defaults);
const load = { build: loadingStep(1), sound: loadingStep(1), compile: loadingStep(4) };

const pipeline = new Pipeline(renderer, {
  background: LOOKS.copper.background,
  exposure: 1,
  bloomStrength: 0.04,
  vignette: 0.35,
  grain: 0.02,
  stillSamples: 32,
  depthOfField: { aperture: 0, maxBlur: 0.02, lensSamples: 48 },
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
    if (g[k] === u) continue;
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
  fade.t = Math.min(1, fade.t + dt / FADE);
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

function applyLook(name, instant = false, snapMaterial = false) {
  const before = instant ? null : lookState();
  if (!instant && fade.t < 1) globalUniforms.envIntensity.value = fade.envBase;
  applyLookNow(name);
  if (instant) return;
  const after = lookState();
  fade.from = before;
  fade.to = after;
  fade.t = 0;
  fade.snap = snapMaterial;
  fade.envBase = globalUniforms.envIntensity.value;
  // The reflections wait for the middle of the fade.
  fade.env = { envMap: globalUniforms.envMap.value };
  globalUniforms.envMap.value = before.envMap ?? lastEnv;
  setLookState(before, after, 0);
}
let lastEnv = null;
function applyLookNow(name) {
  const look = LOOKS[name];
  lastEnv = globalUniforms.envMap.value;
  studios[name] ??= createStudioEnvironment(renderer, {
    keyDirection: new Vector3(-0.6, 0.9, 0.5),
    keyIntensity: 9,
    keySize: 0.5,
    fill: 0.35,
    ceiling: 0.3,
    apply: false,
    ...look.studio,
  });
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

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
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
// Auto change counts from 22.5 s before the end, so a finished piece stays up for autoTime - 22.5 s.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, max: 90, ready: () => !busy && built === buildKey() && swap.phase === "idle" && clock >= processEnd() });
gui.addSection("View");
gui.addSlider("Aperture", params.aperture, 0, 0.02, 0.0005, { randomizable: false });
gui.addSlider("Spin", params.spin, 0, 0.5, 0.01, { randomizable: false });
gui.addCheckbox("Studio", params.studio, { randomizable: false });
pipeline.addGUI(gui);
gui.addSeparator();

let clock = 0;
const replay = () => ((clock = 0), autoChange.restart());
addKey("KeyE", "replay the etching", replay);
gui.addText(keysHelp());
showHint("Drag to spin the piece · scroll to zoom · Space, then drag to look around · R for a new piece", "Drag to spin the piece · pause, then drag to look around · tap {randomize} for a new piece");

const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
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
let material = createReliefMaterial();
// Phones (medium and low tiers) take one relief sample a pixel and the slope from screen derivatives.
const RELIEF_SAMPLES = pipeline.quality === "high" || pipeline.quality === "capture" ? 3 : 1;
material.uniforms.ornSamples.value = RELIEF_SAMPLES;
const mesh = new Mesh(undefined, material);
// One material per set of primitive types (the shader only compiles the types a piece uses), each compiled once.
const materials = {};
const RELIEF_TEXTURES = ["ornPrims", "ornCells", "ornList", "ornBlows"];
function materialFor(types) {
  const key = types.join(",");
  if (!materials[key]) {
    const m = createReliefMaterial();
    m.defines = { ...m.defines, ...Object.fromEntries(types.map((t) => ["ORN_T" + t, ""])) };
    materials[key] = m;
  }
  const next = materials[key];
  // It takes over the look and the process state from the current one.
  if (next !== material) {
    for (const k in material.uniforms) {
      if (globalUniforms[k] === material.uniforms[k] || RELIEF_TEXTURES.includes(k) || !next.uniforms[k]) continue;
      const v = material.uniforms[k].value;
      next.uniforms[k].value = v?.clone ? v.clone() : v;
    }
  }
  return next;
}
scene.add(mesh);
// The studio: a floor and sweep under the floating piece, taking its soft shadow. Off by default on the low tier.
const backdrop = createBackdrop();
scene.add(backdrop.mesh);
// Vapour off the acid, and ripples in its film: high tier only.
const ACID_FX = pipeline.quality === "high" || pipeline.quality === "capture";
const fumes = createFumes();
if (ACID_FX) scene.add(fumes.mesh);
if (pipeline.quality === "low" && !new URLSearchParams(location.search).has("studio")) params.studio.set(false);
const _box = new Box3();
const focus = { value: null };

const geometries = {};
const DETAIL = pipeline.quality === "high" || pipeline.quality === "capture" ? 160 : 110;
const ORIENT = { sphere: [0.3, 0, 0], torus: [1.0, 0, 0.25], box: [0.62, 0.785, 0], pillow: [0.42, 0.55, 0.1], knot: [1.15, 0, 0.1], twist: [0.42, 0.3, 0.22], moebius: [0.55, 0.4, 0.15], blob: [0.25, 0.6, -0.15], suzanne: [-0.37, 0.5, 0, "YXZ"], gyroid: [0.5, 0, 0.12], dodeca: [-1.0172, 0, 0, "YXZ"], icosa: [-1.0172, 0, 0, "YXZ"], lens: [0.48, 0, 0.3], knot25: [1.15, 0, 0.1] };

// Pieces are grown in a worker; the current one stays up until the next is ready.
const worker = new Worker(new URL("./build.worker.js", import.meta.url), { type: "module" });
let built = "";
let requested = "";
let busy = false;
let blows = [];
// How many motifs are being scribed at each point of the drawing, for the scratch's loudness.
let activity = new Float32Array(64);
let firstBuild;
const firstBuilt = new Promise((resolve) => (firstBuild = resolve));
const buildKey = () => [params.shape(), params.pattern(), params.scale(), params.motif(), params.symmetry(), params.flow(), params.leafiness(), params.rosettes(), params.lobes(), params.fill()].join();
function requestBuild() {
  const key = buildKey();
  if (busy || key === requested) return;
  requested = key;
  busy = true;
  worker.postMessage({
    id: key,
    shape: params.shape(),
    mesh: geometries[params.shape()] ? 0 : DETAIL,
    opts: {
      seed: params.pattern(),
      scale: params.scale(),
      pattern: params.motif(),
      symmetry: params.symmetry(),
      flow: params.flow(),
      leafiness: params.leafiness(),
      rosettes: params.rosettes(),
      lobes: params.lobes(),
      fill: params.fill(),
    },
  });
}
// A failure applying a piece is logged and the page carries on, rather than leaving the loader up.
worker.onmessage = (e) =>
  applyBuild(e).catch((err) => {
    console.error("build", err);
    busy = false;
    firstBuild();
  });
async function applyBuild(e) {
  const { id, shape, packed, blows: b, activity: a, mesh: m, types, grid } = e.data;
  if (grid && SHAPES[shape].adopt && !SHAPES[shape].grid) SHAPES[shape].adopt(grid);
  if (m && !geometries[shape]) {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(m.position, 3));
    g.setAttribute("normal", new BufferAttribute(m.normal, 3));
    g.setIndex(new BufferAttribute(m.index, 1));
    g.computeBoundingSphere();
    geometries[shape] = g;
  }
  // A newer request supersedes this one.
  if (id !== buildKey()) {
    busy = false;
    return requestBuild();
  }
  const relief = buildRelief(packed);
  console.log("ornament", shape, packed.ms.toFixed(0) + " ms", relief.stats);
  const next = materialFor(types);
  if (next !== material && !next.userData.compiled) {
    // Compiled off to the side, so the current piece keeps rendering meanwhile.
    const side = new Scene();
    side.add(new Mesh(geometries[shape], next));
    making.compiling = performance.now();
    await pipeline.compileAsync(side, camera);
    making.compiling = 0;
    next.userData.compiled = true;
  }
  busy = false;
  const ready = { id, shape, next, relief, b, a };
  // The very first piece goes straight on (the page waits for it); later ones once the current has shrunk away.
  if (!built) {
    putOn(ready);
    swap.phase = "in";
    swap.t = 0;
    omega.set(0, 0, 0);
  } else swap.ready = ready;
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
function putOn({ id, shape, next, relief, b, a }) {
  swap.spin = 0;
  setRelief(next, relief);
  material = next;
  mesh.material = material;
  blows = b;
  activity = a;
  mesh.geometry = geometries[shape];
  const [rx, ry, rz, order = "XYZ"] = ORIENT[shape];
  qBase.setFromEuler(_euler.set(rx, ry, rz, order));
  qSpin.identity();
  mesh.scale.setScalar(1);
  mesh.quaternion.copy(qBase);
  mesh.updateMatrixWorld();
  backdrop.place(_box.setFromObject(mesh).min.y);
  built = id;
  clock = 0;
  pipeline.restartAccumulation();
  autoChange.restart();
  firstBuild();
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
  const waiting = built && (busy || making.compiling || swap.ready || (swap.phase === "out" && swap.t >= 1));
  if (waiting && !making.started) making.started = now;
  if (!waiting && making.started) {
    making.took[params.motif()] = now - making.started;
    making.started = 0;
  }
  // Only once it has been empty for a moment, so quick builds don't flash it.
  const on = waiting && swap.phase === "out" && swap.t >= 1 && now - making.started > 150;
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

function updateSwap(dt) {
  // A new piece asked for: shrink the one on show, from wherever it is.
  if (swap.phase !== "out" && requested !== built && built) {
    swap.phase = "out";
    swap.t = 1 - Math.cbrt(Math.min(1, Math.max(0, swap.scale)));
  }
  if (swap.ready && swap.ready.id !== buildKey()) swap.ready = null;
  if (swap.phase === "out") {
    swap.t = Math.min(1, swap.t + dt / SHRINK);
    swap.scale = 1 - easeInCubic(swap.t);
    // Gone: the studio fades to the new metal while the next piece is made; the material is set at once, unseen.
    if (swap.t >= 1 && params.look() !== lookShown) applyLook((lookShown = params.look()), false, true);
    if (swap.t >= 1) syncShown();
    if (swap.t >= 1 && swap.ready) {
      putOn(swap.ready);
      swap.ready = null;
      swap.phase = "in";
      swap.t = 0;
      // It turns as it rises (updateSpin), landing on its designed view.
      omega.set(0, 0, 0);
    }
  } else if (swap.phase === "in" && built) {
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
    _axis.set(0, params.spin() * back * back * (3 - 2 * back), 0);
    omega.lerp(_axis, 1 - Math.exp(-dt * (back > 0 ? 0.8 : 1.2)));
    // And tips back upright: toward the turn about the vertical alone that it is closest to.
    if (back > 0) {
      _q.set(0, qSpin.y, 0, qSpin.w).normalize();
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
// Render scale: drops while frames are slow, climbs back once they keep up with the display.
const adaptive = !new URLSearchParams(location.search).has("capture") && !new URLSearchParams(location.search).has("noadapt") && pipeline.quality !== "capture";
const view = { w: 1, h: 1, dpr: 1, scale: 1, ema: 16, last: 0, checked: 0 };
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
  let s = view.scale;
  if (view.ema > 26 && s > 0.5) s = Math.max(0.5, s * 0.85);
  else if (view.ema < 18.5 && s < 1) s = Math.min(1, s * 1.1);
  if (Math.abs(s - view.scale) > 0.02) {
    view.scale = s;
    applySize();
  }
}

onRandomize(() => {
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
});
applyUrlState();
fitSymmetry();

applyLook(params.look(), true);
backdrop.snap();
lookShown = params.look();
let liveShown = "";
requestBuild();
await load.build.track(firstBuilt);
await load.sound.track(sound.loaded);
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

window.app = { canvas: renderer.domElement, params, pipeline, camera, controls, mesh, get material() { return material; }, replay, sound, soundStats, get building() { return busy || built !== buildKey() || swap.phase !== "idle" || swap.spin < 1; }, get clock() { return clock; }, set clock(v) { clock = v; } };

const stage = (name) => {
  const s = stages()[name];
  if (!s) return 0;
  const [a, b] = s;
  return Math.min(1, Math.max(0, (clock - a) / (b - a)));
};

// Focus on the surface under the screen's centre: march the shape's distance along the view axis.
const _o = new Vector3();
const _d = new Vector3();
function focusDistance() {
  const shape = SHAPES[params.shape()];
  // A sampled blank whose grid hasn't arrived yet: focus on the target.
  if (shape.adopt && !shape.grid) return camera.position.distanceTo(controls.target);
  mesh.updateMatrixWorld();
  const inv = mesh.matrixWorld.clone().invert();
  _o.copy(camera.position).applyMatrix4(inv);
  _d.copy(controls.target).sub(camera.position).normalize().transformDirection(inv);
  let t = 0;
  for (let i = 0; i < 64; i++) {
    const x = _o.x + _d.x * t;
    const y = _o.y + _d.y * t;
    const z = _o.z + _d.z * t;
    const q = shape.project(x, y, z);
    const s = (x - q[0]) * q[3] + (y - q[1]) * q[4] + (z - q[2]) * q[5];
    if (Math.abs(s) < 1e-4) return t;
    t += Math.max(Math.abs(s) * 0.9, 1e-4) * Math.sign(s);
    if (t > 20) break;
  }
  return camera.position.distanceTo(controls.target);
}

const _p = new Vector3();
const _n = new Vector3();
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
  mesh.position.copy(shake.x).y += 0.006 * shake.sway * Math.sin(t * 1.7 + 0.5);
  _sq.setFromEuler(_euler.set(rx, 0, rz));
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
  // The fizz follows the bite rate, louder and brighter while it eats fastest; a soft hiss with the fumes.
  const etch = stage("etch");
  sound.setLoop("fizz", 0.75 * acid.rate * Math.min(1, etch / ACID.flood), (0.8 + 0.35 * acid.rate) * Math.sqrt(speed));
  sound.setLoop("hiss", 0.35 * acid.fumes, 1.6);
  // The rinse: a splash as the bath drains off.
  const rinsing = etch >= ACID.drain[0] && etch < 1;
  if (rinsing && acid.rinsed && sound.splash({ gain: 0.7 })) soundStats.splashes++;
  acid.rinsed = !rinsing && etch < ACID.drain[0];
  const burnish = stage("burnish");
  sound.setLoop("rub", burnish > 0 && burnish < 1 ? 0.5 * Math.sin(Math.PI * burnish) ** 0.5 : 0, Math.sqrt(speed));
}
// The acid bath's surface (world height) as it rises over the piece and drains off it, and the vapour above it.
const _c = new Vector3();
const acid = { rate: 0, prevBite: 0, fumes: 0, rinsed: true };
function updateAcid(u, dt) {
  const etch = stage("etch");
  const g = mesh.geometry;
  const R = (g?.boundingSphere?.radius ?? 1) * mesh.scale.x;
  _c.copy(g?.boundingSphere?.center ?? _c.set(0, 0, 0)).applyMatrix4(mesh.matrixWorld);
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
  fumes.update(clock, acid.fumes, _c, R, Math.min(1, Math.max(0, (mc[0] - mc[2]) * 1.6)));
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
  if (params.look() !== lookShown && !swapping) {
    // A finished piece changing metal shows the new one finished, rather than replaying its later stages.
    const finished = clock >= (LOOKS[lookShown].fill ? FILL_END : PROCESS_END);
    applyLook((lookShown = params.look()));
    if (finished) {
      clock = processEnd();
      pipeline.restartAccumulation();
    }
  }
  updateSwap(dt);
  updateFade(dt || 1 / 60);
  updateMaking(performance.now());
  const before = clock;
  // The process waits while pieces change over.
  if (swap.phase === "idle") clock = Math.min(processEnd(), clock + dt * params.speed());
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
  controls.maxDistance = params.studio() ? 5 : 8;
  controls.maxPolarAngle = params.studio() ? Math.PI * 0.56 : Math.PI;
  playSound(clock > before ? prevHammer : u.ornHammer.value, u.ornHammer.value, dt);
  updateShake(dt, clock);
  mesh.updateMatrixWorld();
  u.ornModel.value.setFromMatrix4(mesh.matrixWorld);
  controls.update();
  // Focus eases to the surface under the centre, and holds while pieces change over (with no piece there it would
  // fall back to the orbit centre and the background's blur would jump).
  if (swap.phase === "idle" || focus.value === null) {
    const f = focusDistance();
    focus.value = focus.value === null ? f : focus.value + (f - focus.value) * (1 - Math.exp(-(dt || 1 / 60) * 6));
  }
  pipeline.dof.focus = focus.value;
  pipeline.dof.aperture = params.aperture();
  // The pipeline can't see the spin (the bounds don't change), nor the process; paused, nothing moves, so the still accumulates.
  if (clock !== before || swap.phase !== "idle" || (dt > 0 && (swap.spin < 1 || omega.lengthSq() > 1e-8))) pipeline.restartAccumulation(false);
  pipeline.render(scene, camera, clock);
});
