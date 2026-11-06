import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, randomize, keysHelp, setDay, addKey } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3 } from "three";
import { Easings } from "easings";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createBackdrop } from "./backdrop.js";
import { loadReflections } from "./reflections.js";
import { Knots, MAX_TUBES } from "./knots.js";
import { Tangle } from "./tangle.js";

const BACKDROP = "#dcdad6";
const FLOOR_Y = -1.7;
// The Merge slider in blend radius; the bands are thin, so its range is scaled down to keep them distinct.
const MERGE_SCALE = 0.4;
const KEY_DIRECTION = new Vector3(-0.5, 0.85, 0.5);
const lite = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;

// Thin-film colour ranges: film thickness in nm, picked where the interference colour runs through
// the palette's hues; glass absorbs the complementary colours.
const PALETTES = {
  "purple-cyan": { film: [278, 326], wavelengths: [650, 520, 470], absorption: [0.9, 1.6, 0.25], shape: [2.4, 3], tint: [0.75, 0.82, 1], lift: [0, 1.5], studio: 0.4, facing: 0.35, rim: 0.8 },
  "gold-green": { film: [203, 238], absorption: [0.2, 0.5, 1.8] },
  "pink-orange": { film: [95, 135], absorption: [0.2, 1.4, 1.0] },
};
const FINISHES = { holographic: 0, pearl: 1, glass: 2 };
const FADE = 1.2;

// Eases from wherever it is to the latest target over FADE seconds.
class Fade {
  constructor(target) {
    this.value = target.slice();
    this.from = target.slice();
    this.target = target.slice();
    this.p = 1;
  }
  // Returns whether it is still moving.
  update(target, dt) {
    if (target.some((v, i) => v !== this.target[i])) {
      this.from = this.value.slice();
      this.target = target.slice();
      this.p = 0;
    }
    if (this.p >= 1) return false;
    this.p = Math.min(1, this.p + dt / FADE);
    const e = Easings.InOutCubic(this.p);
    for (let i = 0; i < target.length; i++) this.value[i] = this.p < 1 ? this.from[i] + (this.target[i] - this.from[i]) * e : this.target[i];
    return true;
  }
}

// Everything a finish and palette set, flat: weights (3), film (2), absorption (3), shape (2), tint (3),
// lift floor and inverse threshold (2), wavelengths (3), facing, rim.
function shadingTarget() {
  const finish = FINISHES[params.finish()];
  const palette = PALETTES[params.palette()];
  const [power, gain] = palette.shape ?? [1, 1.6];
  // The bright baked studio washes saturated chrome out to pastel, so a palette can dim it.
  const dim = finish === 0 && params.reflections() === "studio" ? palette.studio ?? 1 : 1;
  const [floor, threshold] = palette.lift ?? [0, Infinity];
  return [
    ...[0, 1, 2].map((i) => (i === finish ? 1 : 0)),
    ...palette.film,
    ...palette.absorption,
    power,
    gain * dim,
    ...(palette.tint ?? [0.96, 0.95, 0.94]),
    floor,
    1 / threshold,
    ...(palette.wavelengths ?? [650, 532, 450]),
    palette.facing ?? 0,
    palette.rim ?? 0,
  ];
}
// Band sections as weights of the pinched, fluted and lens reliefs on the rounded rectangle.
const SECTIONS = { squircle: [0, 0, 0], pinched: [1, 0, 0], fluted: [0, 1, 0], lens: [0, 0, 1] };
const SECTION_MORPH = 1;

const defaults = {
  dof: 0.006,
  auto: 10,
  finish: "holographic",
  palette: "purple-cyan",
  film: 1,
  tubes: 3,
  merge: 0.12,
  section: "squircle",
  sectionAmount: 0.7,
  motion: 1,
  reflections: "studio",
};
const params = fromDefaults(defaults);
// Recordings and captures drive their own looks.
const capture = new URLSearchParams(location.search).has("capture");

const knots = new Knots();
const tangle = new Tangle(knots, lite ? { rings: 192, sides: 28, volume: 32, reflectionSteps: 12 } : {});

const pipeline = new Pipeline(renderer, {
  background: BACKDROP,
  exposure: 1.5,
  bloomStrength: 0.03,
  vignette: 0.15,
  grain: 0.02,
  shadow: { autoFit: true, denoise: true },
  depthOfField: { aperture: 0, maxBlur: 0.03, lensSamples: 24 },
});
globalUniforms.aoIntensity.value = 1;
globalUniforms.aoMin.value = 0.06;
globalUniforms.lightSpecular.value = 0;
globalUniforms.specularShadow.value = 1;

const studio = createStudioEnvironmentAsync(renderer, {
  keyDirection: KEY_DIRECTION,
  keyIntensity: 30,
  keySize: 0.35,
  fill: 0.4,
  floor: 0.45,
  wall: 0.5,
  ceiling: 0.04,
  tint: 0xfffcf8,
  size: 512,
});

// Reflection-only environments: the baked studio, or a photographed studio HDR.
const envs = {};
studio.then((env) => (envs.studio = { envMap: env.envMap, maxLod: Math.max(env.envMap.mipmaps.length - 1, 0) }));
let hdrLoad = null;
function loadHdr() {
  return (hdrLoad ??= studio
    .then((env) => loadReflections(renderer, "../assets/studio_small_03_2k.hdr", { keyDirection: KEY_DIRECTION, match: env.envMap }))
    .then((env) => (envs.hdr = env)));
}
function updateReflections() {
  const choice = params.reflections();
  if (choice === "hdr" && !envs.hdr) loadHdr();
  const env = envs[choice] ?? envs.studio;
  if (!env) return;
  globalUniforms.envMap.value = env.envMap;
  globalUniforms.envMapMaxLod.value = env.maxLod;
  tangle.meshUniforms.backdropMap.value = envs.studio.envMap;
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"));
gui.addSelect("Finish", params.finish, Object.keys(FINISHES));
gui.addSelect("Palette", params.palette, Object.keys(PALETTES));
gui.addSlider("Iridescence", params.film, 0, 1, 0.01);
gui.addSlider("Bands", params.tubes, 2, MAX_TUBES, 1);
gui.addSlider("Merge", params.merge, 0, 0.3, 0.005);
// Picked after the knot when randomizing (see onRandomize), so seeds from before keep their coil.
gui.addSelect("Section", params.section, Object.keys(SECTIONS), { randomizable: false });
gui.addSlider("Section amount", params.sectionAmount, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Motion", params.motion, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Auto change", params.auto, 0, 30, 1, { randomizable: false });
gui.addSelect("Reflections", params.reflections, ["studio", "hdr"], { randomizable: false });
gui.addSlider("Depth of field", params.dof, 0, 0.03, 0.001, { randomizable: false });
gui.addButton("Re-tie", () => retie());
pipeline.addGUI(gui);
gui.addSeparator();
addKey("KeyT", "re-tie the knot", () => retie());
gui.addText(keysHelp());
gui.show();

const scene = new Scene();
const backdrop = createBackdrop({ floorY: FLOOR_Y, color: BACKDROP });
backdrop.mesh.renderOrder = 1;
scene.add(backdrop.mesh);
scene.add(tangle.mesh);

camera.near = 0.1;
camera.far = 80;
camera.position.set(0.3, 0.5, 4.2);
controls.target.set(0, 0, 0);
controls.enablePan = false;
controls.minDistance = 2;
controls.maxDistance = 9;

// The section eases from where it is to the chosen one over SECTION_MORPH seconds of wall time, so it morphs while paused too.
const sectionShape = tangle.uniforms.sectionShape.value;
const sectionMorph = { from: new Vector3(), to: new Vector3(), start: -Infinity };
function updateSection(snap) {
  const to = new Vector3(...SECTIONS[params.section()]).multiplyScalar(params.sectionAmount());
  const now = performance.now() / 1000;
  if (!to.equals(sectionMorph.to)) {
    sectionMorph.from.copy(sectionShape);
    sectionMorph.to.copy(to);
    sectionMorph.start = snap ? -Infinity : now;
  }
  const k = Math.min((now - sectionMorph.start) / SECTION_MORPH, 1);
  if (k >= 1 && sectionShape.equals(to)) return;
  sectionShape.lerpVectors(sectionMorph.from, sectionMorph.to, k * k * (3 - 2 * k));
  pipeline.restartAccumulation();
}

let tubesBuilt = 0;
// Seconds of unpaused play since the last randomize; Auto change randomizes when it reaches the slider.
let sinceChange = 0;
let ties = 0;
// Re-ties from a seed or the Bands slider stay reproducible; T and Re-tie may keep the old twist to avoid tearing.
function retie(animate = true, matchTwist = true) {
  knots.randomize(params.tubes(), animate, matchTwist);
  tubesBuilt = params.tubes();
  ties++;
}

onResize((w, h, dpr) => {
  pipeline.setSize(w, h, dpr);
});
onRandomize(() => {
  sinceChange = 0;
  gui.randomizeAll();
  retie(tubesBuilt > 0, false);
  const shapes = Object.keys(SECTIONS);
  params.section.set(Math.random() < 0.4 ? "squircle" : shapes[1 + Math.floor(Math.random() * (shapes.length - 1))]);
  params.sectionAmount.set(0.4 + 0.6 * Math.random());
});

retie(false);
updateSection(true);
knots.update(0, 0);
tangle.update(renderer, 0, pipeline.depthTexture);
await studio;
updateReflections();
await Promise.all([pipeline.compileAsync(scene, camera), tangle.compileAsync(renderer, camera)]);
// The other finishes and the cross-fade build in the background, so changing finish never stalls.
const finishes = new Scene();
for (let f = 0; f < 4; f++) {
  const mesh = new Mesh(tangle.mesh.geometry, tangle.material(f));
  mesh.frustumCulled = false;
  finishes.add(mesh);
}
pipeline.compileAsync(finishes, camera);

// A handle for recording tools.
window.app = { canvas: renderer.domElement, params, pipeline, camera, controls, retie, preload: () => loadHdr() };

let t = 0;
let shading = null;
// Merge and Iridescence ease toward their slider values, so a randomize doesn't snap the shape.
let eased = null;
let last = performance.now();
render(({ time, dt, frame }) => {
  // Never orbit under the floor: the lowest tilt depends on how far out the camera is.
  const distance = camera.position.distanceTo(controls.target);
  controls.maxPolarAngle = Math.acos(Math.max(-1, Math.min(1, (FLOOR_Y + 0.35 - controls.target.y) / distance)));
  controls.update();
  backdrop.keepInsideCyc(camera, controls.target);
  if (params.tubes() !== tubesBuilt) retie(true, false);
  updateReflections();
  sinceChange = dt > 0 ? sinceChange + dt : 0;
  if (params.auto() > 0 && sinceChange >= params.auto() && !capture) randomize();
  t += dt * params.motion();
  knots.update(t, dt);
  // The first frame takes a seed's section as it is.
  updateSection(frame === 0);
  // Finish and palette changes fade in wall-clock time, so they also play while paused.
  const now = performance.now();
  const target = shadingTarget();
  shading ??= new Fade(target);
  if (shading.update(target, Math.min((now - last) / 1000, 0.1))) pipeline.restartAccumulation();
  const k = 1 - Math.exp(-Math.min((now - last) / 1000, 0.1) * 3);
  last = now;
  eased ??= { merge: params.merge(), film: params.film() };
  eased.merge += (params.merge() - eased.merge) * k;
  eased.film += (params.film() - eased.film) * k;
  if (Math.abs(params.merge() - eased.merge) + Math.abs(params.film() - eased.film) > 1e-4) pipeline.restartAccumulation();
  tangle.uniforms.blend.value = eased.merge * MERGE_SCALE;
  const v = shading.value;
  const u = tangle.meshUniforms;
  u.finishWeights.value.set(v[0], v[1], v[2]);
  const solo = v.slice(0, 3).indexOf(1);
  tangle.setFinish(solo >= 0 ? solo : 3);
  u.filmRange.value.set(v[3], v[4]);
  u.absorption.value.set(v[5], v[6], v[7]);
  u.filmShape.value.set(v[8], v[9]);
  u.tint.value.set(v[10], v[11], v[12]);
  u.filmLift.value.set(v[13], 1 / Math.max(v[14], 1e-6));
  u.filmWavelengths.value.set(v[15], v[16], v[17]);
  u.filmFacing.value = v[18];
  u.filmRim.value = v[19];
  tangle.meshUniforms.filmStrength.value = eased.film;
  tangle.update(renderer, `${t}|${knots.blend}|${ties}`, pipeline.depthTexture);
  // Focus on the near side of the coil.
  pipeline.dof.focus = Math.max(0.5, camera.position.distanceTo(controls.target) - 0.45);
  pipeline.dof.aperture = params.dof();
  pipeline.render(scene, camera, time);
});

