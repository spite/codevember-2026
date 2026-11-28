import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, showSoundHint, loadingStep, addKey, addActionButton, onPause, randomize } from "common";
import { GUI, signal } from "guspira";
import { Scene, Mesh, Vector2, Vector3, Color, LatheGeometry, SphereGeometry, BackSide, Sphere, PerspectiveCamera, WebGLRenderTarget, RedFormat, FloatType, NearestFilter } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync, applyEnvironment } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { renderVariant } from "modules/pipeline/variants.js";
import { createAutoChange } from "modules/autoChange.js";
import { seededRandom, nativeRandom } from "modules/random.js";
import { STYLES, STYLE_NAMES } from "./looks.js";
import { CLIPS, DANCES, EXTRA_CLIPS, HATCH_SECONDS, STRAIN_SHARE, loadFigure, depthPars } from "./figure.js";
import { createSound } from "./sound.js";

const WRAP_SECONDS = 10; // how long the silk takes to go on, or come off
const CLOSED = 0.87; // how much of the silk is on when the bands have closed over the head, the last place they do
const LAMP_COLOR = new Color("#ffd9a8");

const defaults = {
  style: "Studio",
  clip: "samba",
  thickness: 0.02,
  floss: 0.6,
  lamp: 1,
  orbit: 1,
  speed: 1,
  auto: true,
  autoTime: 4,
};
const params = fromDefaults(defaults);
const styleOf = (name) => STYLES[name] ?? STYLES[defaults.style];

const load = { figure: loadingStep(2, "Fetching the figure…"), studio: loadingStep(1, "Lighting the studio…"), sound: loadingStep(1, "Fetching the sounds…"), compile: loadingStep(4, "Compiling shaders…") };

const initialStyle = styleOf(defaults.style);
const pipeline = new Pipeline(renderer, {
  background: initialStyle.background,
  exposure: initialStyle.exposure,
  bloomStrength: 0.1,
  bloomRadius: 0.65,
  vignette: 0.25,
  grain: 0.025,
  // Fitted by hand below: the automatic fit goes by each mesh's rest bounds and its own transform, which says
  // nothing of where a skinned mesh's bones have put it.
  shadow: { autoFit: false, denoise: true },
  gi: true,
});

// Each look's studio, baked once.
const studios = new Map();
function getStudio(name) {
  if (!studios.has(name)) {
    const style = styleOf(name);
    studios.set(
      name,
      createStudioEnvironmentAsync(renderer, { keyDirection: new Vector3(-0.6, 0.85, 0.55), keyIntensity: style.keyIntensity, keySize: 0.48, fill: style.studioFill, floor: 0.22, wall: 0.35, apply: false }),
    );
  }
  return studios.get(name);
}
// A change of look blends everything it lights with, wall, backdrop, exposure, studio light and silk, from where it
// is now. (The studios' reflections swap halfway: on surfaces this rough they hardly differ.)
const LOOK_SECONDS = 2;
const look = { mix: 1, from: null, to: null };
const snapshot = (wall, background, exposure, silk, studio) => ({
  wall: new Color(wall),
  background: new Color(background),
  exposure,
  silk: new Color(silk),
  sh: studio.sh.map((v) => v.clone()),
  lightColor: new Color(studio.lightColor),
  envMap: studio.envMap,
});
function showStudio(name) {
  getStudio(name).then((studio) => {
    if (params.style() !== name) return;
    const u = globalUniforms, to = styleOf(name);
    look.from = snapshot(eased.wall, eased.background, eased.exposure, figure.silkMaterial.color, { sh: u.shIrradiance.value, lightColor: u.lightColor.value, envMap: u.envMap.value });
    look.to = snapshot(to.wall, to.background, to.exposure, to.silk, studio);
    look.mix = 0;
  });
}
function blendLook(wallDt) {
  if (look.mix >= 1) return;
  look.mix = Math.min(1, look.mix + wallDt / LOOK_SECONDS);
  const t = look.mix * look.mix * (3 - 2 * look.mix), { from, to } = look, u = globalUniforms;
  eased.wall.lerpColors(from.wall, to.wall, t);
  eased.background.lerpColors(from.background, to.background, t);
  eased.exposure = from.exposure + (to.exposure - from.exposure) * t;
  figure.setSilkColor(target.lerpColors(from.silk, to.silk, t));
  for (let i = 0; i < 9; i++) u.shIrradiance.value[i].lerpVectors(from.sh[i], to.sh[i], t);
  u.lightColor.value.lerpColors(from.lightColor, to.lightColor, t);
  const envMap = t < 0.5 ? from.envMap : to.envMap;
  if (u.envMap.value !== envMap) {
    u.envMap.value = envMap;
    u.envMapMaxLod.value = Math.max(envMap.mipmaps.length - 1, 0);
  }
}
const initialStudio = load.studio.track(getStudio(defaults.style));
// A stand-in: three.js's Xbot example model (a Mixamo character with walk and run clips and two poses), and the
// samba from its Michelle example model, retargeted to Xbot's skeleton.
const asset = (name) => new URL(`./assets/${name}`, import.meta.url).href;
// The samples download and decode alongside the figure; the first frame waits for both.
const sound = createSound({ onProgress: load.sound.set });
const soundLoaded = load.sound.track(sound.loaded);
const figure = await load.figure.track(loadFigure(asset("Xbot.glb"), Object.fromEntries(EXTRA_CLIPS.map((name) => [name, asset(name)]))));
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setMuted(!sound.muted);
  soundButton.querySelector("img").src = `../assets/${sound.muted ? "sound-off" : "sound"}.svg`;
}
showSoundHint(() => !sound.running);
let running = true;
onPause((r) => {
  running = r;
  sound.setPaused(!r);
});
// Before the panel is built, so they are listed in its key help.
addKey("KeyM", "toggle sound", toggleSound);

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Style", params.style, STYLE_NAMES);
gui.addSelect("Motion", params.clip, CLIPS);
// Where the cocoon is in its life, in words.
const state = signal("");
gui.addMonitor("Cocoon", state);
gui.addSlider("Thickness", params.thickness, 0.005, 0.05, 0.001);
gui.addSlider("Floss", params.floss, 0, 1, 0.01);
gui.addSlider("Lamp", params.lamp, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Lamp orbit", params.orbit, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Speed", params.speed, 0, 2, 0.01, { randomizable: false });

const scene = new Scene();
scene.add(figure.root);

// A cyc under and behind the figure, to stand on and to catch its shadow and a little of the lamp's light, with the
// shadow the figure throws in it (how much of the lamp's light met anything on its way here: figure.js).
const lampOnWall = /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
  vec3 toLamp = uLamp - vWorldPosition;
  float r2 = dot(toLamp, toLamp);
  float shadowed = smoothstep(0.0, 1.0, lampShadow(vWorldPosition));
  s.emissive += s.albedo * uLampColor * (1.0 - shadowed) / (1.0 + 0.6 * r2) * 0.3183 * max(0.0, dot(normalize(s.normal), toLamp * inversesqrt(r2)));
#endif
}
`;
const backdropPoints = [];
for (let i = 0; i <= 12; i++) backdropPoints.push(new Vector2((4.2 * i) / 12, 0));
for (let i = 1; i <= 18; i++) {
  const a = (i / 18) * Math.PI * 0.5;
  backdropPoints.push(new Vector2(4.2 + 2.8 * Math.sin(a), 2.8 * (1 - Math.cos(a))));
}
for (let i = 1; i <= 4; i++) backdropPoints.push(new Vector2(7.0, 2.8 + i * 3.5));
const backdrop = new Mesh(
  new LatheGeometry(backdropPoints, 64),
  new PipelineMaterial({
    color: initialStyle.wall,
    roughness: 0.94,
    side: BackSide,
    fragmentPars: "uniform vec3 uLamp;\nuniform vec3 uLampColor;" + depthPars,
    surface: lampOnWall,
    uniforms: figure.uniforms,
  }),
);
backdrop.userData.noShadow = true;
scene.add(backdrop);
pipeline.shadow.fit(new Sphere(new Vector3(0, 0.9, 0), 2));

// A small lamp that circles the figure.
const lamp = new Mesh(new SphereGeometry(0.03, 16, 12), new PipelineMaterial({ color: 0x000000, roughness: 1 }));
lamp.userData.noShadow = true;
scene.add(lamp);

// The figure as the lamp sees it: its depth, for how much of it the lamp's light has to cross (figure.js). The
// materials' shadow variants write depth as colour, which is what the pipeline's own shadow map is made of.
const lampView = new PerspectiveCamera(110, 1, 0.05, 5);
const depthTarget = () => new WebGLRenderTarget(512, 512, { format: RedFormat, type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
const lampDepth = depthTarget(); // everything that casts a shadow
const lampBody = depthTarget(); // the body under the silk alone
figure.uniforms.uLampDepth.value = lampDepth.texture;
figure.uniforms.uLampBody.value = lampBody.texture;
figure.uniforms.uLampRange.value.set(lampView.near, lampView.far);
const clearWas = new Color();
function drawLampDepth() {
  lampView.position.copy(lamp.position);
  lampView.lookAt(0, 0.95, 0);
  lampView.updateMatrixWorld();
  figure.uniforms.uLampMatrix.value.multiplyMatrices(lampView.projectionMatrix, lampView.matrixWorldInverse);
  const target = renderer.getRenderTarget(), autoClear = renderer.autoClear, alpha = renderer.getClearAlpha();
  renderer.getClearColor(clearWas);
  renderer.setClearColor(0xffffff, 1); // the far plane
  renderer.autoClear = false;
  for (const [to, which] of [[lampDepth, (object) => !object.userData.noShadow && !object.userData.noLampShadow], [lampBody, (object) => object.userData.body]]) {
    renderer.setRenderTarget(to);
    renderer.clear(true, true, false);
    renderVariant(renderer, scene, lampView, "shadow", to, which);
  }
  renderer.autoClear = autoClear;
  renderer.setClearColor(clearWas, alpha);
  renderer.setRenderTarget(target);
}

// A new one: bare, then wound. Its fuzz keeps its seed, so the panel reshapes the same one.
let seed = 0;
let style = styleOf(params.style());
let styleName = params.style();
let wrapped = 0; // how much of the silk is on, 0 to 1
let hatch = 0; // 0, or how far the cocoon has broken open for a new figure to come out, before it is wound again
let tint = {}; // the figure's own colours, once it has changed in the cocoon; until then the look's
let closedWith = null; // the colours the figure had when this cocoon started
// The figure's colours: eight hues a turn apart, each at least two steps (90°) round from the one it has (r: 0..1).
const HUES = 8;
function tintAfter(r) {
  const step = tint.step === undefined ? Math.floor(r * HUES) : (tint.step + 2 + Math.floor(r * (HUES - 3))) % HUES;
  const hue = step / HUES + 0.03;
  return { step, body: new Color().setHSL(hue, 0.65, step % 2 ? 0.36 : 0.28), joints: new Color().setHSL((hue + 0.06) % 1, 0.6, 0.58) };
}
let nextSeed = 0; // the fuzz of the cocoon that comes after a hatch
let built = false;
let builtFloss = -1;
let flossWanted = -1;
let flossAsked = 0;
// Fewer fibres where the GPU is smaller.
figure.flossScale = { low: 0.35, medium: 0.6 }[pipeline.quality] ?? 1;
function buildFloss() {
  builtFloss = flossWanted = params.floss();
  figure.buildFloss(builtFloss, seededRandom(seed));
}
// A new cocoon: nothing on yet, and its own fuzz.
function startOver(fuzz) {
  seed = fuzz;
  buildFloss();
  wrapped = 0;
  built = true;
  closedWith = tint;
}

// A closed cocoon, all but still, hatches "Change every" seconds after it closes.
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui, min: 2, max: 30, ready: () => !hatch && wrapped >= CLOSED });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Drag to orbit · scroll to zoom · R to hatch a new one", "Drag to orbit · tap {randomize} to hatch a new one");
gui.show();

const HOME_TARGET = new Vector3(0, 0.95, 0);
const HOME_OFFSET = new Vector3(0.9, 0.35, 4.4); // a little to the side and above, 4.5 m out
camera.position.addVectors(HOME_TARGET, HOME_OFFSET);
controls.target.copy(HOME_TARGET);
controls.minDistance = 1;
controls.maxDistance = 6;

// The cyc in (distance from the axis, height): a floor out to FLAT, then a cove of radius COVE up into the wall.
const FLAT = 4.2, COVE = 2.8;
// Keeps a point inside the studio, at least margin from the floor, the cove and the wall, and under top.
function keepInStudio(p, margin, top) {
  let r = Math.hypot(p.x, p.z);
  let y = Math.min(top, Math.max(margin, p.y));
  if (r > FLAT && y < COVE) {
    const dr = r - FLAT, dy = y - COVE, d = Math.hypot(dr, dy), most = COVE - margin;
    if (d > most) (r = FLAT + (dr * most) / d), (y = COVE + (dy * most) / d);
  } else r = Math.min(r, FLAT + COVE - margin);
  const was = Math.hypot(p.x, p.z);
  if (was > 1e-6) (p.x *= r / was), (p.z *= r / was);
  p.y = y;
}
onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

// A finished cocoon hatches: the figure has taken another colour under the silk, comes out, and only then takes up
// its new motion and is wound again. An unfinished one stays on, and the figure just changes motion in it.
// Its fuzz, and on load its colour, are drawn here, right after the panel, so a seed in the url gives the one that hatched.
onRandomize(() => {
  const was = params.clip();
  gui.randomizeAll();
  // A walk, run or sneak is always followed by a dance.
  const dance = DANCES[Math.floor(Math.random() * DANCES.length)];
  if (!DANCES.includes(was) && !DANCES.includes(params.clip())) params.clip.set(dance);
  const pick = Math.random();
  const fuzz = Math.random();
  if (!built) {
    // Loading a seed: start as the cocoon that hatched with it.
    tint = tintAfter(pick);
    seed = fuzz;
    return;
  }
  if (wrapped < CLOSED || hatch) return;
  // (Its colour changed as the cocoon closed; the new look, fuzz and wall wait for the next one.)
  nextSeed = fuzz;
  hatch = 1e-4;
});

// The url's seed and params before the first build, so it is the one asked for.
seed = Math.random();
applyUrlState();
styleName = params.style();
style = styleOf(styleName);
figure.setStyle({ ...style, ...tint });
startOver(seed);

await initialStudio;
applyEnvironment(await getStudio(styleName));
globalUniforms.shadowLightSize.value = 0.032;
// White silk fills its own hollows with light bounced inside them.
globalUniforms.aoMultiBounce.value = 1;
await soundLoaded;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

// A handle for recording tools and the console.
window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  scene,
  figure,
  sound,
  // Where the cocoon is: how much silk is on, and how far a hatch has got (0 when not hatching).
  get wrapped() {
    return wrapped;
  },
  get hatch() {
    return hatch;
  },
  // A new cocoon from bare, with the current fuzz: for a recording to start from the beginning.
  restart() {
    hatch = 0;
    lastFrame = performance.now();
    startOver(seed);
  },
  // The idle camera is off under ?capture; a recording that wants it turns it back on.
  idleCamera(on) {
    idle.directed = !on;
  },
};

// What the panel sets eases on the wall clock, so it shows while paused.
const eased = { pace: 1, lamp: params.lamp(), thickness: params.thickness(), wall: new Color(style.wall), background: new Color(style.background), exposure: style.exposure };
const target = new Color();
// The other looks' studios bake in the background, so a change of look never waits for one.
for (const name of STYLE_NAMES) getStudio(name);
let lastWall = performance.now();
let lastFrame = lastWall;
let lampAngle = 0;
const lampPath = new Vector3(), lampAside = new Vector3(), lampDodge = new Vector3();
let tearing = 0; // how fast the shell is breaking, eased, for the sound
let strainWas = 0, strainRising = false; // for a push at the height of each shove
let broke = false, fluttered = false, ripIn = 0;

// Left alone for a few seconds, the camera comes round slowly to the home framing on the figure's front (a little to
// the side and above), and sways a little there.
const IDLE_SECONDS = 3;
const idle = { still: 0, held: false, facing: null, clock: 0, directed: new URLSearchParams(location.search).has("capture") };
const HOME_AZIMUTH = Math.atan2(HOME_OFFSET.x, HOME_OFFSET.z);
const HOME_POLAR = Math.acos(HOME_OFFSET.y / HOME_OFFSET.length());
const HOME_DISTANCE = HOME_OFFSET.length();
const wake = () => (idle.still = 0);
addEventListener("pointerdown", () => ((idle.held = true), wake()), { capture: true, passive: true });
for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => ((idle.held = false), wake()), { capture: true, passive: true });
addEventListener("wheel", wake, { capture: true, passive: true });
const turn = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
const facing = new Vector3(), offset = new Vector3();
function idleOrbit(dt) {
  if (idle.directed || dt === 0) return;
  idle.still = idle.held ? 0 : idle.still + dt;
  idle.clock += dt;
  // The body's front, smoothed over a few seconds: a dance turns it back and forth.
  figure.facing(facing);
  const front = Math.atan2(facing.x, facing.z);
  idle.facing = idle.facing === null ? front : idle.facing + turn(front - idle.facing) * (1 - Math.exp(-dt / 3));
  const engage = Math.min(1, Math.max(0, (idle.still - IDLE_SECONDS) / 3));
  if (engage <= 0) return;
  const k = (1 - Math.exp(-dt * 0.4)) * engage;
  controls.target.lerp(HOME_TARGET, k);
  offset.subVectors(camera.position, controls.target);
  let r = offset.length();
  let azimuth = Math.atan2(offset.x, offset.z);
  let polar = Math.acos(Math.min(1, Math.max(-1, offset.y / r)));
  const t = idle.clock;
  const goalAzimuth = idle.facing + HOME_AZIMUTH + 0.2 * Math.sin(t * 0.23) + 0.06 * Math.sin(t * 0.61);
  const goalPolar = HOME_POLAR + 0.05 * Math.sin(t * 0.17);
  azimuth += Math.max(-0.35 * dt, Math.min(0.35 * dt, turn(goalAzimuth - azimuth) * k));
  polar += (goalPolar - polar) * k;
  r += (HOME_DISTANCE - r) * k;
  offset.set(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)).multiplyScalar(r);
  camera.position.addVectors(controls.target, offset);
}
let travel = 0; // how far the wound body has moved since its last rustle, metres

render(({ time, dt }) => {
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;
  autoChange.update(dt);

  if (params.style() !== styleName && !hatch) {
    styleName = params.style();
    style = styleOf(styleName);
    figure.setBodyColors({ ...style, ...tint });
    showStudio(styleName);
  }
  blendLook(wallDt);
  if (!hatch) figure.setClip(params.clip());
  // Rebuilt once the slider rests, not on every step of a drag.
  if (params.floss() !== flossWanted) (flossWanted = params.floss()), (flossAsked = now);
  if (flossWanted !== builtFloss && now - flossAsked > 150 && !hatch) buildFloss();
  // The silk holds it: it slows as the cocoon closes, and is all but still in a finished one. Hatching, it stays
  // held while it pushes at the shell, then breaks into its motion faster than before, and settles.
  const strain = hatch ? Math.min(1, hatch / STRAIN_SHARE) : 0;
  const pace = hatch ? (strain < 1 ? 0.03 : 1 + 0.8 * Math.max(0, 1 - (hatch - STRAIN_SHARE) / 0.3)) : 1 - 0.97 * Math.min(1, Math.max(0, (wrapped - 0.6) / (CLOSED - 0.6))) ** 2;
  eased.pace += (pace - eased.pace) * (1 - Math.exp(-wallDt * 4));
  // The pushes: a few, each quicker and harder than the last.
  figure.uniforms.uStrain.value = strain < 1 ? strain * Math.sin(Math.PI * 4.5 * strain * strain) ** 2 : 0;
  figure.update(dt * params.speed() * eased.pace, dt, wallDt, wrapped);

  // The silk goes on, or comes off, at its own pace.
  // (Real time even at a low frame rate: only a long stall is cut short.)
  const before = wrapped;
  const frameStep = running ? Math.min(0.5, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  if (hatch) {
    // Breaking open; once it has, the silk is gone and starts again.
    hatch += frameStep / HATCH_SECONDS;
    if (hatch >= 1) {
      hatch = 0;
      startOver(nextSeed);
    }
  } else {
    const wrapStep = frameStep / WRAP_SECONDS;
    wrapped = Math.min(1, wrapped + wrapStep);
    // As the cocoon closes the figure changes colour, out of sight, so it never comes out the colour it went in.
    if (before < CLOSED && wrapped >= CLOSED && tint === closedWith) {
      tint = tintAfter(nativeRandom());
      figure.setBodyColors(tint);
    }
    if (wrapped < 0.3) closedWith = tint;
  }
  figure.uniforms.uHatch.value = hatch;
  const share = (v) => `${Math.round(v * 100)}%`;
  const says = hatch
    ? hatch < STRAIN_SHARE ? "straining" : `hatching ${share((hatch - STRAIN_SHARE) / (1 - STRAIN_SHARE))}`
    : wrapped >= 1 ? "complete: randomize to hatch" : `winding ${share(wrapped)}`;
  if (says !== state.peek()) state.set(says);
  // The silk rustles as the wound body moves: one every 6–12 cm it travels, as loud as it is fast and as the silk is
  // thick, so a fast move is a quick, loud run of them and a body held still is silent. Winding, the silk going on
  // rustles too, louder the further it has got.
  const winding = !hatch && wrapped > before;
  travel += (figure.motion + (winding ? 0.12 : 0)) * frameStep;
  if (travel > 0.06 + 0.06 * nativeRandom()) {
    travel = 0;
    // (Quieter under a hatch, so the rip and the chips come through.)
    sound.rustle(Math.min(1, figure.motion / 1.2 + (winding ? 0.15 : 0)) * (0.35 + 0.65 * wrapped) * (hatch ? 0.5 : 1));
  }

  const k = 1 - Math.exp(-wallDt * 6);
  eased.lamp += (params.lamp() - eased.lamp) * k;
  if (!hatch) eased.thickness += (params.thickness() - eased.thickness) * k;
  backdrop.material.color.copy(eased.wall);
  pipeline.background.copy(eased.background);
  // The studio steps back as the lamp comes up, so that what the lamp sends through the silk is what is seen.
  pipeline.exposure = eased.exposure * (1 - 0.75 * Math.min(eased.lamp, 1));
  figure.uniforms.uCover.value = wrapped;
  // The first turns lie on the skin; the wall builds as more goes on.
  figure.uniforms.uThick.value = eased.thickness * (0.25 + 0.75 * wrapped);

  // The lamp, once round every twelve seconds or so at full speed, rising and falling a little. It starts in front.
  lampAngle += dt * 0.5 * params.orbit();
  // It steps round the body: where its circle passes through a limb, it is eased out to 18 cm clear of it, and never
  // closer than 10 cm.
  lampPath.set(Math.sin(lampAngle) * 1.1, 1.05 + 0.35 * Math.sin(lampAngle * 0.62), Math.cos(lampAngle) * 1.1);
  lampAside.copy(lampPath);
  figure.pushOut(lampAside, 0.18);
  figure.pushOut(lampAside, 0.18);
  lampDodge.lerp(lampAside.sub(lampPath), 1 - Math.exp(-wallDt * 8));
  lamp.position.addVectors(lampPath, lampDodge);
  figure.pushOut(lamp.position, 0.1);
  lamp.visible = eased.lamp > 0.01;
  lamp.material.emissive.copy(LAMP_COLOR).multiplyScalar(50 * eased.lamp);
  figure.uniforms.uLamp.value.copy(lamp.position);
  figure.uniforms.uLampColor.value.copy(LAMP_COLOR).multiplyScalar(90 * eased.lamp);

  // Hatching is heard as a push at the height of each shove, a rip as the shell splits and more while it keeps
  // breaking (chips let go a second, against about 300 at the height of it), and the chips fluttering off and down.
  const strainNow = figure.uniforms.uStrain.value;
  if (strainNow < strainWas && strainRising && strainWas > 0.08) sound.push(strainWas);
  strainRising = strainNow > strainWas ? true : strainNow < strainWas ? false : strainRising;
  strainWas = strainNow;
  tearing += (Math.min(1, figure.released / Math.max(frameStep, 1e-3) / 300) - tearing) * (1 - Math.exp(-wallDt * 8));
  const breaking = hatch > STRAIN_SHARE;
  if (breaking && !broke) (broke = true), sound.tear(1), (ripIn = 0.5 + 0.4 * nativeRandom());
  ripIn -= frameStep;
  if (breaking && tearing > 0.35 && ripIn <= 0) sound.tear(tearing * 0.7), (ripIn = 0.5 + 0.4 * nativeRandom());
  if (breaking && !fluttered && figure.flying > 300) (fluttered = true), sound.flutter();
  if (!hatch && broke) (broke = fluttered = false), sound.fall();
  sound.update();
  if (figure.shed && !hatch) sound.rustle(0.3);
  idleOrbit(dt);
  controls.update();
  keepInStudio(controls.target, 0.2, 2.5);
  keepInStudio(camera.position, 0.25, 6);
  camera.lookAt(controls.target);
  // The lamp's depth only matters while it gives light.
  if (lamp.visible) drawLampDepth();
  pipeline.render(scene, camera, time);
});
