import {
  fromDefaults,
  renderer,
  camera,
  controls as sharedControls,
  render,
  onResize,
  onRandomize,
  applyUrlState,
  keysHelp,
  setDay,
  showHint,
  loadingStep,
  getSeed,
  addKey,
  showSoundHint,
  addActionButton,
  onPause,
} from "common";
import { GUI } from "guspira";
import { Scene, Group, Mesh, Vector3, Quaternion, Color, MathUtils } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { createBackdrop } from "./backdrop.js";
import { SHAPES, createDollGeometries } from "./geometry.js";
import {
  FAMILY_SIZE,
  PATTERNS,
  FINISHES,
  FACES,
  BACKDROPS,
  PALETTE_NAMES,
  getDollSpec,
  getBackdropForFamily,
  setFamilyOrder,
  hashGen,
} from "./palettes.js";
import { createDollMaterial, applyDollSpec } from "./material.js";
import { createSound } from "./sound.js";
import { OrbitControls as FreeOrbitControls } from "modules/FreeOrbitControls.js";

// Adapted from spite/infinite-gift:
// Each inner doll sits coaxially aligned inside its mother doll at scale exp(-FACTOR).
// As `nestU` advances continuously, the container scales exponentially by exp(FACTOR * frac) while
// the mother doll's two halves separate cleanly up and down and glide out of frame — revealing the
// aligned inner doll growing smoothly into the hero spot, forever, without floating-point overflow.
const FACTOR = 0.35; // exp(-0.35) ≈ 0.705 — snug, authentic coaxial Matryoshka fit
const SLOT_COUNT = 4; // Active ring: prev (exiting), hero (opening), next (revealed), deep (nested)
const TWIST_END = 0.26; // share of each opening spent unscrewing: ~1.1 s at the default speed, the opening sound's length

const defaults = {
  pattern: "Family",
  finish: "Family",
  palette: "Family",
  faces: "Family",
  shape: "Family",
  backdrop: "Family",
  direction: "Open",
  speed: 0.24,
  gloss: 0.0,
  orbit: 0.65,
  roll: 0.70,
};

const params = fromDefaults(defaults);

// The shared orbit locks at the poles; this one turns the camera's up with it, so it orbits over and under the doll.
sharedControls.dispose();
const controls = new FreeOrbitControls(camera, renderer.domElement);
const load = {
  studio: loadingStep(1, "Lighting the studio…"),
  wood: loadingStep(1, "Turning linden wood…"),
  sound: loadingStep(1),
  compile: loadingStep(3, "Compiling shaders…"),
};

const initBackdrop = BACKDROPS[params.backdrop()] || BACKDROPS["Warm plaster"];
const pipeline = new Pipeline(renderer, {
  background: initBackdrop.bg,
  exposure: 1.06,
  bloomStrength: 0.025,
  vignette: 0.18,
  grain: 0.018,
  saturation: 1.06,
  contrast: 1.03,
  shadow: { autoFit: true, denoise: true },
});

const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, {
    keyDirection: new Vector3(-0.55, 0.92, 0.58),
    keyIntensity: 8.8,
    keySize: 0.52,
    fill: 0.48,
    floor: 0.38,
    wall: 0.56,
  }),
);

const sound = createSound({ onProgress: load.sound.set });
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.setEnabled(!sound.enabled);
  soundButton.querySelector("img").src = `../assets/${sound.enabled ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.setPaused(!running));

let nestU = 0.28; // Start mid-reveal so the first frame shows the nested doll inside
let targetStepBonus = 0;
let soundU = nestU;

function popNext() {
  const dirSign = params.direction() === "Close" ? -1 : 1;
  if (dirSign > 0) {
    const target = Math.floor(nestU + targetStepBonus + 0.05) + 1.0;
    targetStepBonus = Math.max(targetStepBonus, target - nestU);
  } else {
    const target = Math.ceil(nestU + targetStepBonus - 0.05) - 1.0;
    targetStepBonus = Math.min(targetStepBonus, target - nestU);
  }
}

addKey("KeyN", "pop next doll", popNext);
addKey("KeyM", "toggle sound", toggleSound);
showSoundHint(() => !sound.running);

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSelect("Pattern", params.pattern, ["Family", ...PATTERNS], { randomizable: false });
gui.addSelect("Finish", params.finish, ["Family", ...FINISHES], { randomizable: false });
gui.addSelect("Palette", params.palette, ["Family", ...PALETTE_NAMES], { randomizable: false });
gui.addSelect("Faces", params.faces, ["Family", ...FACES], { randomizable: false });
gui.addSelect("Shape", params.shape, ["Family", ...SHAPES], { randomizable: false });
gui.addSelect("Backdrop", params.backdrop, ["Family", ...Object.keys(BACKDROPS)], { randomizable: false });
gui.addSelect("Direction", params.direction, ["Open", "Close"], { randomizable: false });
gui.addSlider("Speed", params.speed, 0, 0.8, 0.01, { randomizable: false });
gui.addSlider("Finish polish", params.gloss, -0.35, 0.35, 0.01, { randomizable: false });
gui.addSlider("Orbit", params.orbit, 0, 1, 0.01, { randomizable: false });
gui.addSlider("Roll", params.roll, 0, 1, 0.01, { randomizable: false });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Drag to orbit · click or N to open the next doll · R for new dolls", "Drag to orbit · tap to open the next doll · tap {randomize} for new dolls");
gui.show();

const scene = new Scene();
const backdrop = createBackdrop({ color: initBackdrop.cyc });
scene.add(backdrop.mesh);

const radialSegs = pipeline.quality === "low" ? 64 : 96;
const shapeGeoms = {};
for (const s of SHAPES) {
  shapeGeoms[s] = createDollGeometries(s, radialSegs);
}
load.wood.done();

// Outer rig adds gentle infinite-gift style drift/roll without fighting OrbitControls;
// nestRoot carries the exponential scale + quaternion slerp between generations.
const nestRig = new Group();
const nestRoot = new Group();
nestRig.add(nestRoot);
scene.add(nestRig);

const slots = [];
for (let i = 0; i < SLOT_COUNT; i++) {
  const group = new Group();
  const material = createDollMaterial(0);
  const bottom = new Mesh(shapeGeoms.Nordic.bottom, material);
  const top = new Mesh(shapeGeoms.Nordic.top, material);
  group.add(bottom, top);
  nestRoot.add(group);
  slots.push({
    group,
    bottom,
    top,
    material,
    materials: new Map([[0, material]]),
    assignedGen: null,
    specKey: "",
    yaw: 0,
  });
}

const compiledPatterns = new Set();
let compileReady = false;

// One small program per pattern; each slot keeps its own material per pattern for its uniforms.
function slotMaterial(slot, patternIdx) {
  let m = slot.materials.get(patternIdx);
  if (!m) {
    m = createDollMaterial(patternIdx);
    slot.materials.set(patternIdx, m);
  }
  return m;
}

function applySlotSpec(slot, spec, roughnessBias) {
  const m = slotMaterial(slot, spec.patternIdx);
  slot.material = slot.bottom.material = slot.top.material = m;
  applyDollSpec(m, spec, roughnessBias);
  applySlotShape(slot, spec.shape);
}

function applySlotShape(slot, shapeName) {
  const g = shapeGeoms[shapeName] || shapeGeoms.Nordic;
  if (slot.bottom.geometry !== g.bottom) slot.bottom.geometry = g.bottom;
  if (slot.top.geometry !== g.top) slot.top.geometry = g.top;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

// Each doll's face turns a little from its mother's; the rig turns the hero to the camera (orientNest).
const dollYaw = (g) => (hashGen(seedForGen(g), g, 311) - 0.5) * 0.7;

let mixFamilies = false;
let familyOrderKey = "";
const currentOpts = () => ({
  mixFamilies,
  familyOrderKey,
  patternMode: params.pattern(),
  finishMode: params.finish(),
  paletteMode: params.palette(),
  faceMode: params.faces(),
  shapeMode: params.shape(),
});

// R gives the dolls not yet on screen a new seed: each epoch's seed applies from its first generation on.
const seedEpochs = [{ fromGen: -Infinity, seed: 0 }];
function seedForGen(gen) {
  for (let i = seedEpochs.length - 1; i > 0; i--) if (gen >= seedEpochs[i].fromGen) return seedEpochs[i].seed;
  return getSeed();
}

const smoother = (x) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

// Plays a cue once per doll when u crosses gen + at, in the direction the nest moves.
function crossed(at, from, to) {
  return Math.floor(to - at) !== Math.floor(from - at);
}

function updateNest(u, sceneTime, glossBias) {
  const baseGen = Math.floor(u);
  const frac = u - baseGen;
  const opts = currentOpts();
  const modeKey = `${opts.mixFamilies}|${opts.familyOrderKey}|${opts.patternMode}|${opts.finishMode}|${opts.paletteMode}|${opts.faceMode}|${opts.shapeMode}`;

  const isClosing = params.direction() === "Close";
  if (u > soundU) {
    if (crossed(0.0, soundU, u)) sound.play("open", { gain: 0.6 });
  } else if (u < soundU) {
    if (crossed(0.08, soundU, u)) sound.play("close", { gain: 0.6 });
  }
  soundU = u;

  // Exponential scale on nestRoot (spite/infinite-gift trick, bounded to [1, exp(FACTOR)])
  nestRoot.scale.setScalar(Math.exp(FACTOR * frac));

  // Active generations: baseGen - 1 (just passed), baseGen (opening), baseGen + 1 (inside), baseGen + 2 (deep)
  for (let offset = -1; offset <= 2; offset++) {
    const gen = baseGen + offset;
    const slotIdx = ((gen % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
    const slot = slots[slotIdx];

    const specKey = `${modeKey}|${seedForGen(gen)}`;
    if (slot.assignedGen !== gen || slot.specKey !== specKey) {
      const spec = getDollSpec(gen, seedForGen(gen), opts);
      applySlotSpec(slot, spec, -glossBias);
      slot.yaw = dollYaw(gen);
      slot.assignedGen = gen;
      slot.specKey = specKey;
    } else {
      slot.material.uniforms.uRoughnessBias.value = -glossBias;
    }

    const p = u - gen; // = frac - offset

    // Hide grandchild (offset === 2) while its parent (offset === 1) is still closed.
    if (p <= -1.0 || p > 1.05) {
      slot.group.visible = false;
      continue;
    }
    slot.group.visible = true;

    // Local scale inside nestRoot:
    // offset = -1 -> exp(+FACTOR), offset = 0 -> 1, offset = 1 -> exp(-FACTOR)
    // Multiplied by nestRoot.scale = exp(FACTOR * frac) -> world scale = exp(FACTOR * p) seamlessly!
    slot.group.scale.setScalar(Math.exp(-FACTOR * offset));
    slot.group.position.set(0, 0, 0);
    slot.group.rotation.set(0, slot.yaw, 0);

    // Halves leaving stop casting (and stop widening the shadow fit) once their shadow has faded out.
    slot.material.uniforms.uShadowAlpha.value = 1 - smoothstep(TWIST_END + 0.05, 0.6, p);
    const skipShadow = p > 0.62;
    slot.bottom.userData.noShadow = skipShadow;
    slot.top.userData.noShadow = skipShadow;

    const dir = gen % 2 === 0 ? 1 : -1;

    if (p <= 0) {
      // Closed doll aligned coaxially inside its mother doll
      slot.top.visible = true;
      slot.bottom.visible = true;
      slot.top.position.set(0, 0, 0);
      slot.top.rotation.set(0, 0, 0);
      slot.bottom.position.set(0, 0, 0);
      slot.bottom.rotation.set(0, 0, 0);
      slot.material.uniforms.uSeamGap.value = 0;
      slot.material.uniforms.uFade.value = 0;
    } else {
      // The halves unscrew (tw: fast at first, easing off but never stopping, mostly done by TWIST_END while the opening
      // sound plays) and part along their own asymmetric arcs (s, from rest, overlapping the end of the twist), so the
      // motion never stops between the two. Reversible in Close mode.
      const tw = 1 - Math.exp((-1.6 * p) / TWIST_END);
      const sLin = clamp01((p - TWIST_END * 0.55) / (1.02 - TWIST_END * 0.55));
      const s = sLin * sLin * (2 - sLin);
      const s2 = s * s;
      const s3 = s2 * s;

      const r0 = hashGen(seedForGen(gen), gen, 201);
      const r1 = hashGen(seedForGen(gen), gen, 202);
      const r2 = hashGen(seedForGen(gen), gen, 203);
      const r3 = hashGen(seedForGen(gen), gen, 204);
      const r4 = hashGen(seedForGen(gen), gen, 205);
      const r5 = hashGen(seedForGen(gen), gen, 206);
      const r6 = hashGen(seedForGen(gen), gen, 207);
      const r7 = hashGen(seedForGen(gen), gen, 208);

      const twistDir = r0 < 0.5 ? 1 : -1;
      const baseTwist = (0.9 + r2 * 0.8) * tw + (0.35 + r3 * 0.6) * s;
      // Asymmetric torque split (like unscrewing by hand: one half twists more than the other)
      const topSplit = 0.55 + r4 * 0.90;
      const botSplit = 2.0 - topSplit;
      const topUnscrew = baseTwist * topSplit * twistDir;
      const botUnscrew = -baseTwist * botSplit * twistDir;

      // Both halves peel away behind the doll (local -Z, the face is +Z), one to each side, so none comes at the camera.
      const side = r5 < 0.5 ? 1 : -1;
      const topAz = -Math.PI / 2 + side * (0.35 + r6 * 0.5);
      const botAz = -Math.PI / 2 - side * (0.35 + r7 * 0.5);
      const trx = Math.cos(topAz);
      const trz = Math.sin(topAz);
      const brx = Math.cos(botAz);
      const brz = Math.sin(botAz);

      const topPow = 2.7 + r1 * 0.7;
      const botPow = 2.7 + r4 * 0.7;
      const topLift = 2.45 + r3 * 0.55;
      const botDrop = 2.15 + r7 * 0.55;

      const topY = 0.06 * tw + topLift * s + (0.35 + r5 * 0.40) * s2 - 0.65 * s3;
      const topRad = (2.9 + r2 * 1.5) * Math.pow(s, topPow);
      const topPitch = (1.05 + r6 * 0.85) * Math.pow(s, 2.0 + r5 * 0.4);
      const topBank = (r7 - 0.5) * 0.85 * Math.pow(s, 2.3);

      slot.top.visible = p < 1.04;
      slot.top.position.set(trx * topRad, topY, trz * topRad);
      slot.top.rotation.order = "XZY";
      slot.top.rotation.set(trz * topPitch + trx * topBank, topUnscrew, -trx * topPitch + trz * topBank);

      const botY = -(0.02 * tw + botDrop * s + (0.30 + r6 * 0.35) * s2 - 0.35 * s3);
      const botRad = (2.7 + r3 * 1.5) * Math.pow(s, botPow);
      const botPitch = (0.95 + r2 * 0.85) * Math.pow(s, 2.0 + r7 * 0.4);
      const botBank = (r5 - 0.5) * 0.85 * Math.pow(s, 2.3);

      slot.bottom.visible = p < 1.04;
      slot.bottom.position.set(brx * botRad, botY, brz * botRad);
      slot.bottom.rotation.order = "XZY";
      slot.bottom.rotation.set(brz * botPitch + brx * botBank, botUnscrew, -brx * botPitch + brz * botBank);

      slot.material.uniforms.uSeamGap.value = clamp01(tw * 0.25 + s * 5.0);
      // Smoothly melt separated halves into the studio backdrop color before disappearing
      slot.material.uniforms.uFade.value = smoothstep(0.48, 0.98, s);
    }

    // Keep each slot's fade target synced to the live backdrop color/lighting
    slot.material.uniforms.uBgColor.value.copy(backdrop.material.color);
    slot.material.uniforms.uBgLevel.value = backdrop.material.uniforms.backdropLevel.value;
    slot.material.uniforms.uBgWallFill.value = backdrop.material.uniforms.wallFill.value;
  }
}

// Click / tap on canvas (without dragging) pops the next doll
let downX = 0;
let downY = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) < 6) {
    popNext();
  }
});

// Centered studio framing around the Matryoshka with full 3D orbit + roll
camera.position.set(0.25, 0.35, 4.6);
controls.target.set(0, 0, 0);
controls.minDistance = 2.2;
controls.maxDistance = 10.0;
controls.enableDamping = true;

let isUserOrbiting = false;
controls.addEventListener("start", () => {
  isUserOrbiting = true;
});
controls.addEventListener("end", () => {
  isUserOrbiting = false;
});

let rollPhase = 0;
let orbitPhase = 0;
const turnQ = new Quaternion();
const turnAxis = new Vector3();
const turnOffset = new Vector3();

// Turns the camera about the target in its own frame (yaw about its up, pitch about its right, roll about its view
// axis), like the free orbit does, so the automatic motion never locks at a pole either.
function turnCamera(yaw, pitch, roll) {
  const up = camera.up;
  turnOffset.copy(camera.position).sub(controls.target);
  turnQ.setFromAxisAngle(up, yaw);
  turnOffset.applyQuaternion(turnQ);
  up.applyQuaternion(turnQ);
  turnAxis.copy(up).cross(turnOffset).normalize();
  turnQ.setFromAxisAngle(turnAxis, pitch);
  turnOffset.applyQuaternion(turnQ);
  up.applyQuaternion(turnQ);
  up.applyAxisAngle(turnAxis.copy(turnOffset).normalize(), roll).normalize();
  camera.position.copy(controls.target).add(turnOffset);
}

onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));
let booted = false;
onRandomize(() => {
  if (!booted) return;
  // The dolls on screen keep their paint; the new seed starts past them and two quick openings bring it in.
  seedEpochs.push({ fromGen: Math.floor(nestU) + 3, seed: getSeed() });
  if (seedEpochs.length > 8) seedEpochs.splice(1, 1);
  popNext();
  popNext();
  precompilePatterns();
});

applyUrlState();
booted = true;

function getTargetBackdrop(u) {
  const mode = params.backdrop();
  if (mode !== "Family") return BACKDROPS[mode] || BACKDROPS["Warm plaster"];
  const baseGen = Math.floor(u);
  const frac = u - baseGen;
  const isClosing = params.direction() === "Close";
  const activeGen = isClosing ? (frac < 0.65 ? baseGen : baseGen + 1) : frac > 0.35 ? baseGen + 1 : baseGen;
  const familyIndex = mixFamilies ? activeGen : Math.floor(activeGen / FAMILY_SIZE);
  return getBackdropForFamily(familyIndex, seedForGen(activeGen)) || BACKDROPS["Warm plaster"];
}

// Snap initial backdrop immediately before first render
const startBackdrop = getTargetBackdrop(nestU);
const bgColor = new Color(startBackdrop.bg);
const cycColor = new Color(startBackdrop.cyc);
const targetBgColor = new Color();
const targetCycColor = new Color();
pipeline.background.copy(bgColor);
backdrop.material.color.copy(cycColor);
backdrop.material.uniforms.backdropLevel.value = startBackdrop.level;
backdrop.material.uniforms.wallFill.value = startBackdrop.wallFill;
let smoothGloss = params.gloss();

await studio;
updateNest(nestU, 0, smoothGloss);
await load.compile.track(pipeline.compileAsync(scene, camera), 3);
compileReady = true;

// Compiles the other patterns' programs in the background, nearest families first, so a change never stalls.
for (const slot of slots) compiledPatterns.add(slot.material.defines.DOLL_PATTERN);
let precompiling = null;
function precompilePatterns() {
  if (!compileReady) return;
  precompiling ??= compileRemaining().finally(() => (precompiling = null));
  return precompiling;
}
async function compileRemaining() {
  const order = [];
  const base = Math.floor(nestU);
  for (let k = 0; order.length < PATTERNS.length && k < FAMILY_SIZE * 64; k += FAMILY_SIZE) {
    for (const gen of [base + k, base - k]) {
      const idx = getDollSpec(gen, seedForGen(gen), currentOpts()).patternIdx;
      if (!order.includes(idx)) order.push(idx);
    }
  }
  for (let i = 0; i < PATTERNS.length; i++) if (!order.includes(i)) order.push(i);
  for (const idx of order) {
    if (compiledPatterns.has(idx)) continue;
    compiledPatterns.add(idx);
    const holder = new Scene();
    holder.add(new Mesh(shapeGeoms.Nordic.bottom, slotMaterial(slots[0], idx)));
    await pipeline.compileAsync(holder, camera);
  }
}

// Keeps the camera in a window in front of the hero doll's face (in its own frame): the view direction is softly
// squeezed into the window (tanh, so there is no edge where a correction suddenly starts) and the whole nest turns at a
// steady rate toward the rotation that would put the camera there.
const FACE_AZ = 0.5;
const FACE_EL_DOWN = 0.0;
const FACE_EL_UP = 0.45;
const heroQ = new Quaternion();
const yawQ = new Quaternion();
const fixQ = new Quaternion();
const rigTarget = new Quaternion();
const camDir = new Vector3();
const wantDir = new Vector3();
const yAxis = new Vector3(0, 1, 0);
function orientNest(u, dt) {
  const g = Math.floor(u);
  const f = u - g;
  const yaw = MathUtils.lerp(dollYaw(g), dollYaw(g + 1), smoothstep(TWIST_END, 0.7, f));
  yawQ.setFromAxisAngle(yAxis, yaw);
  heroQ.multiplyQuaternions(nestRig.quaternion, yawQ);
  camDir.copy(camera.position).sub(controls.target).normalize().applyQuaternion(fixQ.copy(heroQ).invert());
  const az = Math.atan2(camDir.x, camDir.z);
  const el = Math.asin(MathUtils.clamp(camDir.y, -1, 1));
  const az1 = FACE_AZ * Math.tanh(az / FACE_AZ);
  const elMid = (FACE_EL_UP - FACE_EL_DOWN) / 2;
  const elHalf = (FACE_EL_UP + FACE_EL_DOWN) / 2;
  const el1 = elMid + elHalf * Math.tanh((el - elMid) / elHalf);
  wantDir.set(Math.sin(az1) * Math.cos(el1), Math.sin(el1), Math.cos(az1) * Math.cos(el1));
  fixQ.setFromUnitVectors(wantDir, camDir);
  rigTarget.multiplyQuaternions(heroQ, fixQ).multiply(yawQ.invert());
  nestRig.quaternion.slerp(rigTarget, 1 - Math.exp(-2.5 * dt));
}

window.app = {
  canvas: renderer.domElement,
  renderer,
  scene,
  params,
  pipeline,
  camera,
  controls,
  sound,
  popNext,
  // Every doll from a different family (for videos); the page plays the families in turn.
  // order: optional FAMILIES indices to play in that order instead of the seeded shuffle.
  setMixFamilies(v, order) {
    mixFamilies = !!v;
    setFamilyOrder(order);
    familyOrderKey = order ? order.join(",") : "";
  },
  get nestU() {
    return nestU;
  },
  set nestU(v) {
    nestU = v;
    updateNest(nestU, 0, smoothGloss);
  },
};

render(({ time, dt, frame }) => {
  if (frame === 0) sound.start();
  const k = 1 - Math.exp(-8 * dt);


  const kBg = 1 - Math.exp(-2.2 * dt);
  const bSpec = getTargetBackdrop(nestU);
  targetBgColor.set(bSpec.bg);
  targetCycColor.set(bSpec.cyc);
  bgColor.lerp(targetBgColor, kBg);
  cycColor.lerp(targetCycColor, kBg);
  pipeline.background.copy(bgColor);
  backdrop.material.color.copy(cycColor);
  backdrop.material.uniforms.backdropLevel.value = MathUtils.lerp(
    backdrop.material.uniforms.backdropLevel.value,
    bSpec.level,
    kBg,
  );
  backdrop.material.uniforms.wallFill.value = MathUtils.lerp(
    backdrop.material.uniforms.wallFill.value,
    bSpec.wallFill,
    kBg,
  );

  smoothGloss = MathUtils.lerp(smoothGloss, params.gloss(), k);

  const dirSign = params.direction() === "Close" ? -1 : 1;
  nestU += dirSign * dt * params.speed();
  if (Math.abs(targetStepBonus) > 0.0005) {
    const step = targetStepBonus * (1 - Math.exp(-4.2 * dt));
    nestU += step;
    targetStepBonus -= step;
  } else {
    targetStepBonus = 0;
  }

  updateNest(nestU, time, smoothGloss);

  // Orbit (paused while the user drags) with a swinging pitch that carries over and under the doll, and a roll that
  // keeps turning, applied as small turns of the camera's own frame.
  const orbitAmt = params.orbit();
  const rollAmt = params.roll();
  let yaw = 0;
  let pitch = 0;
  if (!isUserOrbiting && orbitAmt > 0) {
    const dPhase = dt * (0.5 + orbitAmt * 0.65);
    orbitPhase += dPhase;
    yaw = dt * orbitAmt * 1.05;
    pitch = Math.cos(orbitPhase * 0.55) * 0.55 * dPhase * 0.95 * orbitAmt;
  }
  const dRoll = dt * rollAmt * 0.72;
  rollPhase += dRoll;
  const roll = dRoll * (1 + Math.cos(rollPhase * 0.55) * 0.55 * 0.35 * rollAmt);
  if (yaw || pitch || roll) turnCamera(yaw, pitch, roll);

  controls.update();
  orientNest(nestU, dt);

  pipeline.render(scene, camera, time);
});

requestAnimationFrame(() => precompilePatterns());
