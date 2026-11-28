import { fromDefaults, renderer, camera, controls, render, onResize, onPause, addKey, setRunning, onRandomize, applyUrlState, keysHelp, setDay, showHint, loadingStep, addActionButton, showSoundHint, randomize } from "common";
import { createMusic } from "./music.js";
import { Track } from "batec/track.js";
import { GUI, signal } from "guspira";
import { Scene, Mesh, Group, Vector3, Color, MathUtils, Matrix4, Quaternion } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { SHAPE_LIST, buildSurfaceGeometry } from "./geometries.js";
import { LOOK_PRESETS, createHologramUniforms, createHologramMaterial } from "./hologram.js";
import { createDiorama, SCENES, braggReplay } from "./diorama.js";
import { preloadShatterForms } from "./shatter.js";
import { preloadLightScenes } from "./scenes.js";
import { loadFingerprints, createSmudges } from "./smudge.js";
import { createTunnel, TUNNEL_BY_INTENSITY } from "./tunnel.js";
import { createCardOver } from "./cardOver.js";
import { nativeRandom } from "modules/random.js";

const BACKGROUND = 0x000000;
const CARD_STYLES = { card: 1, glass: 2 };
// Motion blur's shutter (s): the tunnel blurs in its own shader along its streaming, the card in cardOver by its turning.
const SHUTTER = 1 / 50;
// Paused, the frame is shown still: no blur.
let paused = false;
onPause((running) => (paused = !running));

const defaults = {
  shape: "card",
  scene: "gears",
  machines: 1,
  look: "spectrum",
  colour: 575,
  bandwidth: 35,
  swelling: 1,
  zone: 80,
  dispersion: 2,
  border: 0.06,
  foil: 1.75,
  fingerprints: 1,
  depth: 1,
  brightness: 0.4,
  rings: 0.45,
  bowl: 1,
  ringCount: 9,
  dash: 0.6,
  ringTrack: 0,
  haze: 0.03,
  ghost: 0.25,
  graze: 0.8,
  wear: 0.85,
  reflectLift: 4,
  sway: 1,
  orbit: 1,
  roll: 0.25,
  bend: 1,
  streaks: false,
  dots: false,
  speed: 14,
  blur: true,
  auto: true,
  autoTime: 10,
  changeBars: "8",
};
const params = fromDefaults(defaults);
const load = {
  scene: loadingStep(2, "Building the scene…"),
  prints: loadingStep(1, "Leaving fingerprints…"),
  music: loadingStep(2, "Loading the music…"),
  compile: loadingStep(4, "Compiling shaders…"),
};

const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1,
  bloomStrength: 0.3,
  bloomRadius: 0.82,
  saturation: 1.15,
  vignette: 0.3,
  grain: 0.02,
  // The tunnel is all light and the card's frame lies in it: no AO, bounce light or cast shadows to show (their history
  // would lag behind the tunnel's streaming).
  shadows: false,
  gi: false,
  composite: (hdr, info) => cardOver.composite(hdr, info),
});
const cardOver = createCardOver(renderer, pipeline);
const mobile = pipeline.quality === "medium" || pipeline.quality === "low";

// Randomizing picks from [min, max] instead of the slider's whole range.
function randomIn(controller, param, min, max, step) {
  controller.randomize = () => param.set(Math.round((min + Math.random() * (max - min)) / step) * step);
}

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addSection("Card");
gui.addSelect("Card", params.shape, SHAPE_LIST.map((s) => s.id));
gui.addSelect("Scene", params.scene, SCENES);
gui.addSlider("Seed", params.machines, 1, 999, 1);
randomIn(gui.addSlider("Border", params.border, 0.01, 0.2, 0.005, { visibleWhen: () => params.shape() === "card" }), params.border, 0.05, 0.09, 0.005);
randomIn(gui.addSlider("Foil", params.foil, 0, 2, 0.01, { visibleWhen: () => params.shape() === "card" }), params.foil, 1.5, 2, 0.01);
gui.addSection("Hologram");
gui.addSlider("Colour (nm)", params.colour, 500, 640, 1);
randomIn(gui.addSlider("Bandwidth (nm)", params.bandwidth, 0, 200, 1), params.bandwidth, 20, 40, 1);
gui.addSlider("Swelling", params.swelling, 0, 2, 0.01);
gui.addSlider("Viewing zone (°)", params.zone, 10, 80, 1, { randomizable: false });
randomIn(gui.addSlider("Dispersion", params.dispersion, 0, 3, 0.01), params.dispersion, 1.5, 3, 0.01);
gui.addSelect("Look", params.look, Object.keys(LOOK_PRESETS));
gui.addSlider("Depth", params.depth, 0.4, 1.6, 0.01);
gui.addSlider("Brightness", params.brightness, 0.1, 1.5, 0.01, { randomizable: false });
randomIn(gui.addSlider("Ghost", params.ghost, 0, 0.3, 0.01), params.ghost, 0.1, 0.3, 0.01);
gui.addSlider("Grazing distortion", params.graze, 0, 2, 0.01);
gui.addSection("Rings");
gui.addSlider("Rings", params.rings, 0, 2, 0.01);
gui.addSlider("Bowl depth", params.bowl, 0.3, 2, 0.01);
gui.addSlider("Ring count", params.ringCount, 4, 20, 1);
gui.addSlider("Dashes", params.dash, 0.2, 1, 0.01);
// Half the cards have none; the rest a faint solid ring under the dashes.
gui.addSlider("Ring track", params.ringTrack, 0, 1, 0.01).randomize = () => params.ringTrack.set(Math.random() < 0.5 ? 0 : Math.round((0.15 + Math.random() * 0.25) * 100) / 100);
randomIn(gui.addSlider("Haze", params.haze, 0, 1, 0.01), params.haze, 0, 0.1, 0.01);
gui.addSection("Glass");
gui.addSlider("Wear", params.wear, 0, 1.5, 0.01);
gui.addSlider("Fingerprints", params.fingerprints, 0, 2, 0.01);
gui.addSlider("Reflection lift", params.reflectLift, 0, 10, 0.1, { randomizable: false });
gui.addSection("Motion");
gui.addSlider("Sway", params.sway, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Orbit", params.orbit, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Roll", params.roll, -1, 1, 0.01, { randomizable: false });
gui.addSection("Tunnel");
gui.addCheckbox("Light streaks", params.streaks, { randomizable: false });
gui.addCheckbox("Dot spiral", params.dots, { randomizable: false });
gui.addSlider("Bend", params.bend, 0, 2, 0.01, { randomizable: false });
gui.addSlider("Speed (m/s)", params.speed, 0, 40, 0.1, { randomizable: false });
gui.addCheckbox("Motion blur", params.blur, { randomizable: false });
// Auto change, the day's own: with the music it counts the song's bars (in bar() below) and lands each new card on a
// phrase; without it, seconds of no interaction. Off under ?capture, since recordings drive their own changes.
const autoChange = (() => {
  const capture = new URLSearchParams(location.search).has("capture");
  const status = signal("");
  let elapsed = 0, held = false;
  const restart = () => (elapsed = 0);
  const opts = { capture: true, passive: true };
  addEventListener("pointerdown", () => ((held = true), restart()), opts);
  for (const e of ["pointerup", "pointercancel"]) addEventListener(e, () => ((held = false), restart()), opts);
  for (const e of ["wheel", "keydown"]) addEventListener(e, restart, opts);
  onPause(restart);
  gui.addCheckbox("Auto change", params.auto, { randomizable: false });
  gui.addSelect("Change every (bars, with music)", params.changeBars, ["4", "8", "16", "32"], { randomizable: false });
  gui.addSlider("Change every (s, no music)", params.autoTime, 5, 60, 1, { randomizable: false });
  gui.addMonitor("Next change", status);
  const on = () => params.auto() && !capture;
  // The card is between changes: settled, or landing after its swap (bars count from the swap).
  const free = () => (flip.state === "idle" || (flip.state === "landing" && flip.swapped)) && intro.tunnel >= 1;
  return {
    on,
    restart,
    // Driven by the music's bars instead of the clock.
    get musical() {
      return music.audible && !!beat.track;
    },
    update(dt) {
      let text;
      if (!on()) text = "off";
      else if (dt === 0) text = "paused";
      else if (this.musical) {
        const left = beat.swapBar + Number(params.changeBars()) - (beat.track.state.bar ?? 0);
        text = flip.state === "idle" || flip.swapped ? `in ${Math.max(1, left)} bar${left > 1 ? "s" : ""}` : "changing";
        elapsed = 0;
      } else {
        elapsed = !held && free() ? elapsed + dt : 0;
        if (elapsed >= params.autoTime()) {
          elapsed = 0;
          randomize();
        }
        text = held || !free() ? "waiting" : `in ${Math.max(1, Math.ceil(params.autoTime() - elapsed))} s`;
      }
      if (text !== status.peek()) status.set(text);
    },
  };
})();
pipeline.addGUI(gui);
// The soundtrack, downloaded while the page loads; M or the button turns it on and off, pausing pauses it.
const music = createMusic({ onProgress: load.music.set });
load.music.track(music.loaded);
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  music.setEnabled(!music.enabled);
  soundButton.querySelector("img").src = `../assets/${music.enabled ? "sound" : "sound-off"}.svg`;
}
addKey("KeyM", "toggle sound", toggleSound);
onPause((running) => music.setPaused(!running));
showSoundHint(() => !music.running);

// The music's beat map (batec, analysed offline: sound/tunnel.batec.json). While it plays, kicks flash the tunnel and
// send rings of light down it, the travel locks to the beat, snares jolt the card, downbeats pulse it, and the drop
// spins in a new card.
const beat = { bpm: 0, track: null, hat: 0, last: -1, kick: 0, waveAt: -1e9, wave: 0, barrel: 1, auto: 1, valence: 0.25, kickShown: 0, hatShown: 0, intensity: 0.5, intenseLo: 0, intenseHi: 1, swapBar: -1e9, hectic: 0, rawHectic: 0, hecticTop: 1, hecticPeak: 1, streaks: 0, dots: 0, hecticLo: 0, hecticHi: 1, tunnelBar: -1e9 };
const beatMap = fetch(new URL("./sound/tunnel.batec.json", import.meta.url)).then((r) => r.json());
beatMap.then((map) => {
  const track = new Track(map);
  track.on("onset:kick", ({ strength }) => {
    beat.kick = Math.max(beat.kick, 0.5 + 0.5 * strength);
    tunnel.uniforms.tunnelKickN.value = (tunnel.uniforms.tunnelKickN.value + 1) % 997;
    beat.waveAt = tunnel.uniforms.tunnelTravel.value;
    beat.wave = 0.6 + 0.4 * strength;
  });
  // The card glides freely; only a new section of the song (other than the drop, which spins in a new card) gets a
  // barrel roll.
  track.on("section", (sec) => {
    if (!sec.tags?.includes("drop") && beat.barrel >= 1) beat.barrel = 0;
  });
  track.on("bar", ({ bar }) => {
    if (flip.state === "ready") flip.state = "landing";
    // Counted in the song's own bars from the last swap (frame time drifts against the music); the first card's count
    // starts when the music does.
    if (beat.swapBar < -1e8) beat.swapBar = bar;
    const due = autoChange.on() && intro.tunnel >= 1 && bar - beat.swapBar >= Number(params.changeBars()) - 1;
    if (due && bar % 4 === 3 && flip.state === "idle") {
      flip.onBar = true;
      randomize();
    }
  });
  track.on("onset:hat", ({ strength }) => {
    beat.hat = Math.max(beat.hat, 0.4 + 0.6 * strength);
    tunnel.uniforms.tunnelHatN.value = (tunnel.uniforms.tunnelHatN.value + 1) % 997;
  });
  track.on("tag:drop", () => {
    if (autoChange.on() && flip.state === "idle") randomize();
  });
  // How hectic the song is, spread over its own range (5th to 95th percentile, so the quiet ends don't squash it).
  const h = [...(track.map.curves?.hectic ?? [])].filter((v) => v > 0.05).sort((a, b) => a - b);
  beat.hecticLo = h[Math.floor(h.length * 0.05)] ?? 0;
  beat.hecticHi = h[Math.floor(h.length * 0.95)] ?? 1;
  const it = [...(track.map.curves?.intensity ?? [])].filter((v) => v > 0.05).sort((a, b) => a - b);
  beat.intenseLo = it[Math.floor(it.length * 0.05)] ?? 0;
  beat.intenseHi = it[Math.floor(it.length * 0.95)] ?? 1;
  // The song's most hectic stretches: its top quarter, and its top tenth.
  beat.hecticTop = h[Math.floor(h.length * 0.75)] ?? 1;
  beat.hecticPeak = h[Math.floor(h.length * 0.9)] ?? 1;
  beat.track = track;
}, (e) => console.warn("no beat map", e));
// The intro: the card fades in out of the dark, then the tunnel lights up as the music starts. It waits for the music
// (or for sound to be switched off, or for it to fail); recordings and replayed moments start fully lit.
// ?intro keeps the intro in a recording.
const quickStart = (new URLSearchParams(location.search).has("capture") && !new URLSearchParams(location.search).has("intro")) || new URLSearchParams(location.search).has("state");
const intro = { card: quickStart ? 1 : 0, tunnel: quickStart ? 1 : 0, lit: quickStart };
let musicFailed = false;
music.loaded.catch(() => (musicFailed = true));
function updateIntro(dt) {
  // Frames, not the time since load: the first frame's dt can span the whole load.
  dt = Math.min(dt, 1 / 30);
  // The outro (recordings ask for it): the tunnel goes dark, then the card fades out.
  if (intro.out) {
    intro.tunnel = Math.max(0, intro.tunnel - dt / 2.5);
    if (intro.tunnel <= 0) intro.card = Math.max(0, intro.card - dt / 1.8);
    pipeline.exposure = intro.card * intro.card * (3 - 2 * intro.card);
    tunnel.uniforms.tunnelLight.value = (intro.tunnel * intro.tunnel * (3 - 2 * intro.tunnel)) ** 2;
    return;
  }
  // Exposure only while fading in, so the panel's slider still works after.
  if (intro.card < 1) {
    intro.card = Math.min(1, intro.card + dt / 1.8);
    pipeline.exposure = intro.card * intro.card * (3 - 2 * intro.card);
  }
  if (!intro.lit && intro.card >= 1 && (music.audible || !music.enabled || musicFailed)) intro.lit = true;
  if (intro.lit) intro.tunnel = Math.min(1, intro.tunnel + dt / 2.5);
  const e = (x) => x * x * (3 - 2 * x);
  tunnel.uniforms.tunnelLight.value = e(intro.tunnel) ** 2;
}
// With the music, the tunnel's style follows how hectic the song is: the plainest (rings) for the opening 12 s, then on
// each 8-bar phrase (half way in as it starts) one of the three styles at or just under the song's hectic level right now, never the one before.
function pickTunnel(t, st) {
  const first = !tunnel.directed;
  if (t < 12) {
    if (tunnel.style !== TUNNEL_BY_INTENSITY[0]) tunnel.setStyle(TUNNEL_BY_INTENSITY[0], first);
    return;
  }
  const h = MathUtils.clamp(((st.character?.hectic ?? 0) - beat.hecticLo) / Math.max(beat.hecticHi - beat.hecticLo, 1e-3), 0, 1);
  beat.hectic += (h - beat.hectic) * 0.02;
  // The light-speed streaks layer on in the song's most hectic quarter, the dot spiral in its most hectic tenth.
  const raw = st.character?.hectic ?? 0;
  beat.rawHectic += (raw - beat.rawHectic) * 0.02;
  beat.streaks = MathUtils.smoothstep(beat.rawHectic, beat.hecticTop - 0.01, beat.hecticTop + 0.02);
  beat.dots = MathUtils.smoothstep(beat.rawHectic, beat.hecticPeak - 0.005, beat.hecticPeak + 0.015);
  // Decided two bars before the phrase, and sent down the tunnel so the card is half way through it on the phrase.
  if (tunnel.changing || st.bar === beat.tunnelBar || st.bar % 8 !== 6) return;
  const n = TUNNEL_BY_INTENSITY.length;
  const top = Math.round(beat.hectic * (n - 1));
  const now = TUNNEL_BY_INTENSITY.indexOf(tunnel.style);
  // A fixed pick per phrase (the same song plays the same way), stepping past the current style.
  let pick = MathUtils.clamp(top - Math.floor(((Math.sin((st.bar + 2) * 12.9898) * 43758.5453) % 1 + 1) % 1 * 3), 0, n - 1);
  if (pick === now) pick = pick === top ? Math.max(0, pick - 1) : pick + 1;
  beat.tunnelBar = st.bar;
  const lead = (8 - (st.beatInBar + st.beatPhase)) * (60 / (st.bpm || 130));
  tunnel.setStyle(TUNNEL_BY_INTENSITY[pick], first, tunnel.speed * lead);
}
function updateBeat(dt) {
  const k = (rate) => Math.exp(-rate * dt);
  const t = music.audible ? music.time : -1;
  if (beat.track && t >= 0) {
    // The track loops: a jump back is a seek, not a run of events; so is a jump ahead (a tab coming back, a recording).
    if (t < beat.last || t > beat.last + 1) {
      beat.track.seek(t);
    }
    const st = beat.track.update(t);
    // Mood: the song's valence times its energy right now (happy and loud glides fastest).
    beat.valence += ((st.character?.valence ?? 0.5) * (st.character?.energy ?? 0.5) - beat.valence) * (1 - k(0.5));
    tunnel.uniforms.tunnelBeats.value = st.bar * 4 + st.beatInBar + st.beatPhase;
    beat.bpm = st.bpm || 130;
    pickTunnel(t, st);
    beat.last = t;
  } else beat.last = -1;
  beat.auto += ((t >= 0 && beat.track ? 0 : 1) - beat.auto) * (1 - k(2));
  tunnel.beatsFromMusic = t >= 0 && !!beat.track;
  tunnel.directed = tunnel.beatsFromMusic;
  if (!tunnel.directed) beat.streaks = beat.dots = 0;
  // Hits ease in over a few hundredths of a second and out over a few tenths, rather than switch.
  beat.kick *= k(5);
  beat.hat *= k(8);
  beat.kickShown += (beat.kick - beat.kickShown) * (1 - k(beat.kick > beat.kickShown ? 30 : 12));
  beat.hatShown += (beat.hat - beat.hatShown) * (1 - k(beat.hat > beat.hatShown ? 35 : 14));
  tunnel.uniforms.tunnelHat.value = beat.hatShown * (1 - beat.auto);
  // The louder and busier the song, the brighter the whole tunnel burns (and blooms).
  const intensity = MathUtils.clamp(((beat.track && t >= 0 ? beat.track.state.character?.intensity : 0) - beat.intenseLo) / Math.max(beat.intenseHi - beat.intenseLo, 1e-3), 0, 1);
  beat.intensity += ((beat.auto > 0.5 ? 0.5 : intensity) - beat.intensity) * (1 - k(0.8));
  tunnel.uniforms.tunnelGain.value = 0.8 + 0.9 * beat.intensity * beat.intensity;
  if (!music.audible && flip.state === "ready") flip.state = "landing";
  beat.wave *= k(1.2);
  beat.barrel = Math.min(1, beat.barrel + dt / 1.6);
  const u = tunnel.uniforms;
  u.tunnelAutoPulse.value = beat.auto;
  u.tunnelKick.value = beat.kickShown;
  // The ring rides away from the card, down the tunnel, faster than the wall comes.
  u.tunnelWaveS.value = beat.waveAt + (u.tunnelTravel.value - beat.waveAt) * 4;
  u.tunnelWaveAmp.value = beat.wave;
}
// Fullscreen is for watching: the UI hides on entering it and comes back on leaving.
for (const e of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(e, () => document.body.classList.toggle("hide-ui", !!(document.fullscreenElement || document.webkitFullscreenElement)));
}
showHint("Drag to spin the card · Space to pause · F to enjoy", "Drag to spin the card · tap {randomize} for a new card");
gui.show();

const scene = new Scene();
const tunnel = createTunnel(renderer);
tunnel.update(0, 0);
scene.add(tunnel.mesh);

const diorama = createDiorama(renderer, { shadowSize: mobile ? 1024 : 2048 });
// The window render's size, as a share of the screen's pixels.
const PORTAL_SCALE = mobile ? 0.5 : 1;

const u = { ...createHologramUniforms({ portal: diorama.texture, replays: diorama.replayTextures, look: params.look() }), ...tunnel.uniforms };
const hero = new Group();
scene.add(hero);
// One program per card (a trading card, a glass plate), both compiled up front so a flip never waits.
const materials = {};
const geometries = {};
const mesh = new Mesh();
mesh.userData.noShadow = true;
mesh.rotation.order = "YXZ";
mesh.visible = false;
hero.add(mesh);
for (const shape of Object.keys(CARD_STYLES)) {
  geometries[shape] = buildSurfaceGeometry(shape);
  materials[shape] = createHologramMaterial(u, { card: CARD_STYLES[shape] });
}
function putCard(shape) {
  cardOver.setCard(mesh);
  mesh.geometry = geometries[shape];
  mesh.material = materials[shape];
  mesh.visible = true;
}

camera.userData.baseFov = 35;
camera.position.set(0, 0, 5.6);
// Far enough to see down the tunnel behind the card when the camera comes round.
camera.far = 500;
camera.updateProjectionMatrix();
controls.target.set(0, 0, 0);
// The camera is placed by the orbit below; the wheel only sets how far out it is.
let rollAngle = 0;
let glideTime = 0;
// A snapshot of the motion (C copies it), so a moment can be shared and replayed with ?state=.
let timeShift = 0, lastTime = 0;
let turnRate = 0;
const _qNow = new Quaternion(), _qPrev = new Quaternion(), _qDelta = new Quaternion();
let orbitPhase = 0, orbitR = 0, zoom = 5.6, fovBase = 35;
controls.enabled = false;
renderer.domElement.addEventListener("wheel", (e) => {
  zoom = MathUtils.clamp(zoom * Math.exp(e.deltaY * 0.001), 3, 12);
  e.preventDefault();
}, { passive: false });

// Dragging turns the card the way the pointer moves on screen, whatever its pose (a trackball in the camera's frame):
// it keeps turning when let go, and once slow settles back to facing the camera (either face).
const spin = { q: new Quaternion(), w: new Vector3(), id: null, x: 0, y: 0, t: 0 };
const _dq = new Quaternion(), _axis = new Vector3(), _camQ = new Quaternion(), _front = new Quaternion(), _back = new Quaternion(0, 1, 0, 0);
const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  if (spin.id !== null) return;
  spin.id = e.pointerId;
  spin.x = e.clientX;
  spin.y = e.clientY;
  spin.t = performance.now();
  spin.w.set(0, 0, 0);
  canvas.setPointerCapture(e.pointerId);
});
function turnBy(ax, ay, angle) {
  if (angle < 1e-6) return;
  spin.q.premultiply(_dq.setFromAxisAngle(_axis.set(ax, ay, 0).normalize(), angle));
}
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== spin.id) return;
  const k = 4 / innerHeight;
  const dx = (e.clientX - spin.x) * k, dy = (e.clientY - spin.y) * k;
  const now = performance.now();
  const dt = Math.max(8, now - spin.t) / 1000;
  // Right turns it about the view's up axis, down about its right axis (the top comes toward the viewer).
  turnBy(dy, dx, Math.hypot(dx, dy));
  spin.w.lerp(_axis.set(dy / dt, dx / dt, 0), 0.5);
  spin.x = e.clientX;
  spin.y = e.clientY;
  spin.t = now;
});
const release = (e) => {
  if (e.pointerId !== spin.id) return;
  spin.id = null;
  // A drag that stopped before letting go doesn't fling.
  if (performance.now() - spin.t > 80) spin.w.set(0, 0, 0);
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
function updateSpin(dt) {
  if (spin.id !== null) return;
  const speed = spin.w.length();
  turnBy(spin.w.x, spin.w.y, speed * dt);
  spin.w.multiplyScalar(Math.exp(-1.5 * dt));
  // A gentle pull back to facing that fades in as the turn slows, rather than switching on.
  const pull = 0.7 * (1 - MathUtils.smoothstep(speed, 0.5, 4));
  if (pull > 0) {
    const target = Math.abs(spin.q.dot(_front)) >= Math.abs(spin.q.dot(_back)) ? _front : _back;
    spin.q.slerp(target, 1 - Math.exp(-pull * dt));
  }
}
onResize((w, h, dpr) => {
  const t = Math.tan(MathUtils.degToRad(35) / 2);
  fovBase = w < h ? MathUtils.radToDeg(2 * Math.atan(t / (w / h))) : 35;
  camera.fov = fovBase;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(w, h, dpr);
  u.uScreen.value.set(Math.round(w * dpr), Math.round(h * dpr));
  diorama.setSize(Math.max(1, Math.round(w * dpr * PORTAL_SCALE)), Math.max(1, Math.round(h * dpr * PORTAL_SCALE)));
});

// The look's colours, eased to on a change.
const target = { look: { ...LOOK_PRESETS[params.look()] }, tint: new Color(), ramp: [0, 1, 2, 3, 4].map(() => new Color()) };
function setLook(name, snap = false) {
  const look = LOOK_PRESETS[name] ?? LOOK_PRESETS.spectrum;
  Object.assign(target.look, look);
  target.tint.set(look.tintColor);
  look.stops.forEach((hex, i) => target.ramp[i].set(hex));
  if (snap) easeLook(1);
}
const RAMPS = ["uRamp1", "uRamp2", "uRamp3", "uRamp4", "uRamp5"];
const EASED = { uRampMix: "rampMix", uRampCycles: "rampCycles", uSpacing: "spacing", uOrder2: "order2", uOrder3: "order3", uHueShift: "hueShift", uHoloBrightness: "holoBrightness", uHoloSaturation: "holoSaturation", uPurity: "purity", uSoftClip: "softClip", uTintMix: "tintMix", uPlateReflection: "plateReflection" };
function easeLook(k) {
  u.uTintColor.value.lerp(target.tint, k);
  RAMPS.forEach((r, i) => u[r].value.lerp(target.ramp[i], k));
  for (const [name, key] of Object.entries(EASED)) u[name].value += (target.look[key] - u[name].value) * k;
}

// A new card is prepared in the background (its scene merged and lit, its prints drawn, a slice a frame) while the card
// spins, and the new one goes on as it passes edge-on.
const shown = { shape: "", scene: "" };
const sceneKey = (v) => v.scene + "|" + v.machines;
const flip = { wind: 0, windFrom: 0, state: "idle", angle: 0, omega: 0, values: null, prepared: null, swapped: false, target: 0, start: 0, duration: 1, t: 0, request: 0 };
// Spin rate while the next card is made (rad/s), and how it winds down after.
const SPIN = 16;
// The wind-up before it: turned back by WIND_BACK (rad) and forward again over WIND (s), leaving it already turning.
const WIND = 0.45, WIND_BACK = 0.35;
function requestCard(values) {
  const id = ++flip.request;
  // From rest, it winds up first; already turning, it carries on.
  if (flip.state === "idle") {
    flip.wind = 0;
    flip.windFrom = flip.angle;
  } else flip.wind = WIND;
  flip.state = "preparing";
  flip.values = values;
  flip.swapped = false;
  const sceneChanged = sceneKey(values) !== shown.scene;
  Promise.all([sceneChanged ? diorama.prepare(values.scene, values.machines) : null, sceneChanged ? smudges.prepare(values.machines) : true]).then(
    ([prepared]) => {
      if (id !== flip.request) return diorama.discard(prepared);
      diorama.discard(flip.prepared);
      flip.prepared = prepared;
      // On the beat: the swap waits for the next bar to begin.
      flip.state = flip.onBar ? "ready" : "landing";
    },
    (err) => {
      console.error(err);
      // Only the card still wanted settles the flip; a superseded one's failure leaves the newer flip alone.
      if (id === flip.request) flip.state = "idle";
    },
  );
}
function swapCard() {
  const values = flip.values;
  params.$apply(values);
  if (flip.prepared) {
    diorama.show(flip.prepared);
    flip.prepared = null;
    smudges.show();
    u.uSmudge.value = smudges.texture;
    shown.scene = sceneKey(values);
  }
  putCard(values.shape);
  shapeRun = values.shape === shown.shape ? shapeRun + 1 : 1;
  shown.shape = values.shape;
  flip.swapped = true;
  autoChange.restart();
  beat.swapBar = beat.track?.state.bar ?? -1e9;
}
// The card spins up while the next one is made, the new one goes on as it passes edge-on, and it winds down to land
// facing the camera again.
function updateFlip(dt) {
  // Changes made in the panel spin to the card they describe.
  if (flip.state === "idle") {
    const now = params.$snapshot();
    if (sceneKey(now) !== shown.scene || now.shape !== shown.shape) requestCard(now);
    return;
  }
  const prev = flip.angle;
  if (flip.state === "preparing" || flip.state === "ready" || (flip.state === "landing" && !flip.swapped)) {
    if (flip.wind < WIND) {
      flip.wind = Math.min(WIND, flip.wind + dt);
      const x = flip.wind / WIND;
      // -k x^2 (1 - x): from rest, back to WIND_BACK at two thirds, then forward through the start already turning.
      const k = (27 / 4) * WIND_BACK;
      flip.angle = flip.windFrom - k * x * x * (1 - x);
      flip.omega = (-k * (2 * x - 3 * x * x)) / WIND;
      return;
    }
    flip.omega += (SPIN - flip.omega) * (1 - Math.exp(-2.5 * dt));
    flip.angle += flip.omega * dt;
    const edge = (a) => Math.floor((a - Math.PI / 2) / Math.PI);
    if (flip.state === "landing" && flip.omega > SPIN * 0.5 && edge(flip.angle) !== edge(prev)) {
      swapCard();
      // Winds down over the next few turns to rest on a face: an ease-out that starts at the spin's own speed and
      // slows ever more gently, with no jolt at the end.
      flip.start = flip.angle;
      flip.target = Math.ceil((flip.angle + flip.omega * 1.0) / Math.PI) * Math.PI;
      flip.duration = (3 * (flip.target - flip.angle)) / flip.omega;
      flip.t = 0;
    }
    return;
  }
  flip.t = Math.min(1, flip.t + dt / flip.duration);
  flip.angle = flip.start + (flip.target - flip.start) * (1 - (1 - flip.t) ** 3);
  // Its speed along the ease, for the blur.
  flip.omega = ((flip.target - flip.start) * 3 * (1 - flip.t) ** 2) / flip.duration;
  if (flip.t >= 1) {
    flip.angle = flip.target;
    flip.omega = 0;
    flip.state = "idle";
    flip.onBar = false;
    autoChange.restart();
  }
}

// How many cards in a row have had the shape on show.
let shapeRun = 1;

// Randomizing (R, the button, auto change) prepares the next card and flips to it, rather than changing it at once.
let started = false;
// Randomizes the panel, then narrows the bandwidth as the dispersion rises (the bands spread further apart), from
// 20-40 nm at dispersion 1.5 down to 3-15 nm at 3, never under 3.
// The look from the seed alone, so a link reproduces it.
function randomizeLook() {
  gui.randomizeAll();
  const k = MathUtils.clamp((params.dispersion() - 1.5) / 1.5, 0, 1);
  const lo = MathUtils.lerp(20, 3, k), hi = MathUtils.lerp(40, 15, k);
  params.bandwidth.set(Math.max(3, Math.round(lo + Math.random() * (hi - lo))));
}
// Live only, on top of the seed's look: always a different scene from the one showing, and trading card or glass
// plate at even odds, but never three of one in a row.
function liveRules(scene) {
  if (params.scene() === scene) {
    const others = SCENES.filter((name) => name !== scene);
    params.scene.set(others[Math.floor(Math.random() * others.length)]);
  }
  const other = shown.shape === "card" ? "glass" : "card";
  params.shape.set(shapeRun >= 2 || Math.random() < 0.5 ? other : shown.shape);
}
// The next card: randomized, then over (panel values) on top; with onBar it lands on the next bar line. The live rules
// and the staging run just after the seed's values are recorded, so the url names whatever they change and a link
// reproduces the card.
function nextCard(over = {}, onBar = false) {
  const was = params.$snapshot();
  randomizeLook();
  queueMicrotask(() => {
    liveRules(was.scene);
    for (const [key, value] of Object.entries(over)) params[key]?.set(value);
    const next = params.$snapshot();
    params.$apply(was);
    flip.onBar = onBar;
    requestCard(next);
  });
}
// (The bar handler sets flip.onBar before randomizing, so its changes land on the beat.)
onRandomize(() => (started ? nextCard({}, !!flip.onBar) : randomizeLook()));

const camRight = new Vector3(), camUp = new Vector3(), camFwd = new Vector3();
const _center = new Vector3(), _n = new Vector3(), _b = new Vector3(), _p = new Vector3();
const _stage = new Matrix4();
const _halfTurn = new Matrix4().makeRotationY(Math.PI);
const smearState = {};

applyUrlState();
// The first card is always gears, unless the link has a seed or a scene of its own.
if (!["scene", "seed"].some((k) => new URLSearchParams(location.search).has(k))) params.scene.set("gears");

const fingerprintImage = load.prints.track(loadFingerprints());
setLook(params.look(), true);
const smudges = createSmudges(renderer, await fingerprintImage, { size: mobile ? 512 : 1024 });
const first = params.$snapshot();
const prepared = await load.scene.track(Promise.all([diorama.prepare(first.scene, first.machines), smudges.prepare(first.machines)]));
diorama.show(prepared[0]);
smudges.show();
u.uSmudge.value = smudges.texture;
shown.scene = sceneKey(first);
putCard(first.shape);
shown.shape = first.shape;
const compileScene = new Scene();
for (const shape of Object.keys(CARD_STYLES)) compileScene.add(new Mesh(geometries[shape], materials[shape]));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
await load.compile.track(Promise.all([pipeline.compileAsync(compileScene, camera), pipeline.compileAsync(scene, camera), tunnel.prebake(nextFrame), preloadShatterForms(nextFrame), preloadLightScenes()]), 4);
started = true;
// The music starts once the page renders smoothly: the first frames still compile what compileAsync didn't cover (the
// diorama, the card's blur, the prefilter), so it waits for 3 frames in a row with no new program, each under 100 ms.
// Frame times are measured here: the render loop's dt is clamped, and stops while paused.
const musicGate = { programs: -1, smooth: 0, done: false, last: 0 };
function startMusicWhenSmooth() {
  if (musicGate.done) return;
  const now = performance.now(), frame = now - musicGate.last;
  musicGate.last = now;
  const programs = renderer.info.programs?.length ?? 0;
  musicGate.smooth = programs === musicGate.programs && frame < 100 ? musicGate.smooth + 1 : 0;
  musicGate.programs = programs;
  if (musicGate.smooth >= 3) {
    musicGate.done = true;
    music.play();
  }
}

gui.addSeparator();
gui.addText(keysHelp());
window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  camera,
  controls,
  uniforms: u,
  diorama,
  // For recordings: the song (its clock can be driven), and the next card by hand.
  music,
  nextCard,
  // The intro in reverse, over 4.3 s: the tunnel goes dark, then the card fades out.
  outro: () => (intro.out = true),
  // tools/perf times these as their own segments.
  perfSegments: (wrap) => {
    wrap(diorama, "render", "diorama");
  },
};

let lookShown = params.look();
tunnel.jump(nativeRandom() * 2000);
function captureState() {
  return {
    url: location.href,
    time: lastTime,
    orbitPhase,
    zoom,
    flipAngle: flip.angle,
    roll: rollAngle,
    spin: spin.q.toArray(),
    travel: tunnel.uniforms.tunnelTravel.value,
    tunnelTime: tunnel.uniforms.tunnelTime.value,
    size: [innerWidth, innerHeight, devicePixelRatio],
  };
}
addKey("KeyC", "copy this moment (for a bug report)", () => {
  const state = captureState();
  const url = new URL(location.href);
  url.searchParams.set("state", btoa(JSON.stringify(state)));
  console.log(JSON.stringify(state), url.href);
  navigator.clipboard?.writeText(url.href);
});
const stateParam = new URLSearchParams(location.search).get("state");
if (stateParam) {
  try {
    const st = JSON.parse(atob(stateParam));
    timeShift = st.time;
    orbitPhase = st.orbitPhase;
    zoom = st.zoom;
    flip.angle = st.flipAngle;
    rollAngle = st.roll;
    spin.q.fromArray(st.spin);
    tunnel.jump(st.travel);
    tunnel.uniforms.tunnelTime.value = st.tunnelTime;
    // Held still at that moment.
    setRunning(false);
  } catch (e) {
    console.error("bad state", e);
  }
}
render(({ time, dt }) => {
  startMusicWhenSmooth();
  time += timeShift;
  lastTime = time;
  autoChange.update(dt);
  updateFlip(dt);
  if (params.look() !== lookShown) setLook((lookShown = params.look()));
  easeLook(1 - Math.exp(-6 * dt));
  updateIntro(dt);
  updateBeat(dt);
  // With the music the speed is locked to the beat: a whole number of rings a beat, a ring passing the card on each.
  const locked = tunnel.beatsFromMusic && beat.bpm > 0;
  tunnel.update(dt, params.speed(), params.bend(), { streaks: Math.max(params.streaks() ? 1 : 0, beat.streaks), dots: Math.max(params.dots() ? 1 : 0, beat.dots), shutter: params.blur() && !paused ? SHUTTER : 0, bpm: locked ? beat.bpm : 0 });

  // The card dashes down the tunnel: swaying to show its foil and hologram, and spinning for a new one.
  const sway = params.sway();
  const turn = flip.angle;
  // Rolling slowly about its own face, clockwise as the camera sees it, from either side.
  // The glide's pace: with music, the song's mood right now (valence x energy: quiet or sad slower, loud and happy faster).
  const pace = 0.5 + 1.2 * beat.valence * (1 - beat.auto) + 0.5 * beat.auto;
  glideTime += dt * pace;
  const gt = glideTime;
  rollAngle -= dt * pace * params.roll() * Math.sign(Math.cos(turn) || 1);
  updateSpin(dt);
  // Turned well off the camera to show the hologram's angles (its colours, smear and depth), one way then the other,
  // but kept inside its viewing zone and never square on.
  const yaw = 0.42 * Math.tanh(1.8 * Math.sin(gt * 0.31)) + 0.06 * Math.sin(gt * 1.1 + 0.5);
  const pitch = 0.18 * Math.sin(gt * 0.23 + 1) + 0.05 * Math.sin(gt * 0.9) - 0.04;
  // Swaying about the middle of the screen (across the view, whichever way the camera looks), banking into it.
  const sx = (0.62 * Math.sin(gt * 0.47) + 0.14 * Math.sin(gt * 1.23 + 1.2)) * sway;
  const sy = (0.32 * Math.sin(gt * 0.61 + 0.8) + 0.07 * Math.sin(gt * 1.57)) * sway;
  const vx = (0.62 * 0.47 * Math.cos(gt * 0.47) + 0.14 * 1.23 * Math.cos(gt * 1.23 + 1.2)) * sway;
  // The camera circles the card all the way round, always looking at it, rising and dipping on another beat (a
  // Lissajous path), on an ellipsoid narrow enough to stay inside the tunnel; the scroll wheel scales it. Where it comes
  // in closer, at the sides, it widens its view to match, so the card keeps (most of) its size on screen.
  controls.target.set(0, 0, 0);
  orbitPhase += dt * 0.12 * params.orbit();
  const az = orbitPhase;
  const el = 0.45 * Math.sin(orbitPhase * 1.7 + 0.6) + 0.12 * Math.sin(orbitPhase * 3.1);
  const side = Math.min(zoom, 2.3);
  camera.position.set(Math.sin(az) * Math.cos(el) * side, Math.sin(el) * side, Math.cos(az) * Math.cos(el) * zoom).add(controls.target);
  orbitR = camera.position.distanceTo(controls.target);
  camera.lookAt(controls.target);
  const fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(fovBase) / 2) * (zoom / orbitR) ** 0.8));
  if (Math.abs(fov - camera.fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  camera.matrixWorld.extractBasis(camRight, camUp, camFwd);
  hero.position.copy(controls.target).addScaledVector(camRight, sx).addScaledVector(camUp, sy);
  _p.copy(camera.position).sub(hero.position);
  const faceYaw = Math.atan2(_p.x, _p.z), facePitch = -Math.atan2(_p.y, Math.hypot(_p.x, _p.z));
  const amount = Math.min(sway, 1.25);
  mesh.rotation.set(facePitch + pitch * amount, turn + faceYaw + yaw * amount, rollAngle - Math.PI * 2 * beat.barrel * beat.barrel * (3 - 2 * beat.barrel) + Math.sin(gt * 0.29) * 0.05 * amount - vx * 0.25);
  // The drag's turn, in the camera's frame.
  camera.getWorldQuaternion(_camQ);
  mesh.quaternion.premultiply(_dq.copy(_camQ).multiply(spin.q).multiply(_camQ.invert()));
  hero.updateMatrixWorld();
  camera.updateMatrixWorld();
  camera.matrixWorld.extractBasis(camRight, camUp, camFwd);

  const lights = u.uLights.value;
  lights[0].copy(camFwd).multiplyScalar(0.78).addScaledVector(camRight, 0.42).addScaledVector(camUp, 0.45).normalize();
  lights[1].copy(camFwd).multiplyScalar(-0.78).addScaledVector(camRight, -0.52).addScaledVector(camUp, 0.31).normalize();
  lights[2].copy(camFwd).multiplyScalar(0.24).addScaledVector(camRight, -0.26).addScaledVector(camUp, 0.93).normalize();
  // A lamp just above the camera, moving with it.
  lights[3].copy(camFwd).multiplyScalar(0.92).addScaledVector(camRight, 0.1).addScaledVector(camUp, 0.25).normalize();
  u.uModelRot.value.setFromMatrix4(mesh.matrixWorld);
  u.uHeroCenter.value.setFromMatrixPosition(hero.matrixWorld);
  u.uCamRight.value.copy(camRight);
  u.uCamUp.value.copy(camUp);
  u.uCamFwd.value.copy(camFwd);
  u.uTime.value = time;
  u.uDepthScale.value = params.depth();
  u.uRingAmount.value = params.rings();
  u.uBowlDepth.value = params.bowl();
  u.uRingCount.value = params.ringCount();
  u.uRingDash.value = params.dash();
  u.uRingTrack.value = params.ringTrack();
  u.uHaze.value = params.haze();
  u.uGhost.value = params.ghost();
  u.uZone.value = MathUtils.degToRad(params.zone());
  u.uGraze.value = params.graze();
  u.uCardAspect.value = mesh.geometry.userData.aspect ?? 1;
  u.uCardCorner.value = mesh.geometry.userData.corner ?? 0.04;
  // Hats glint the foil, kicks flare the hologram.
  u.uFoil.value = params.foil() * (1 + 0.8 * beat.hat * (1 - beat.auto));
  u.uSmudgeAmount.value = params.fingerprints();
  u.uCardBorder.value = params.shape() === "glass" ? 0.012 : params.border();
  u.uWear.value = params.wear();
  u.uReflectLift.value = params.reflectLift();
  u.uFrameBand.value = 0;
  u.uHoloGain.value = params.brightness();

  // The frozen scene inside is drawn through the glass before the frame, coming out of the side facing the camera, and
  // replayed in bands of wavelength about the plate.
  mesh.updateMatrixWorld();
  // Its turning since last frame (the spin, a throw, anything), as a rate, for the blur; held while paused.
  mesh.getWorldQuaternion(_qNow);
  if (dt > 0) {
    _qDelta.copy(_qNow).multiply(_qPrev.invert());
    if (_qDelta.w < 0) _qDelta.set(-_qDelta.x, -_qDelta.y, -_qDelta.z, -_qDelta.w);
    const angle = 2 * Math.acos(Math.min(1, _qDelta.w));
    const sin = Math.sqrt(Math.max(0, 1 - _qDelta.w * _qDelta.w));
    turnRate = angle / dt;
    if (sin > 1e-6) cardOver.axis.set(_qDelta.x, _qDelta.y, _qDelta.z).divideScalar(sin);
  }
  _qPrev.copy(_qNow);
  cardOver.sweep = params.blur() && !paused ? Math.min(turnRate * SHUTTER, 1.2) : 0;
  _center.setFromMatrixPosition(mesh.matrixWorld);
  _n.setFromMatrixColumn(mesh.matrixWorld, 2).normalize();
  const backSide = _n.dot(_p.copy(camera.position).sub(_center)) < 0;
  if (backSide) _n.negate();
  _b.setFromMatrixColumn(mesh.matrixWorld, 1).normalize();
  _stage.copy(mesh.matrixWorld);
  // Seen from the card's back, the scene is turned round too, so it always shows the side its lights were on.
  if (backSide) _stage.multiply(_halfTurn);
  _stage.elements[12] += _n.x * 0.3;
  _stage.elements[13] += _n.y * 0.3;
  _stage.elements[14] += _n.z * 0.3;
  const view = { matrix: _stage, radius: 0.85, planes: null, id: 0, plate: { p: _center.clone(), n: _n.clone(), up: _b.clone() } };
  _p.copy(camera.position).sub(view.plate.p).normalize();
  const replay = braggReplay(view.plate, _p, u.uLights.value, u.uLightPower.value, params.colour(), smearState, dt);
  view.lambdaB = replay.lambda;
  view.smear = replay.smear;
  const dist = _center.distanceTo(camera.position);
  const bands = mobile ? 6 : 8;
  const bandT = diorama.render(camera, { views: [view], near: dist - 1.6, span: 3.2, bands, bandwidth: params.bandwidth(), disperse: params.dispersion(), jitter: 0 });
  u.uBandT.value.fill(0);
  bandT.forEach((t, k) => (u.uBandT.value[k] = t));
  u.uBandCount.value = bandT.length;
  u.uDisperse.value = params.dispersion();
  u.uBandStep.value.copy(diorama.bandStep);
  u.uPortalNear.value = dist - 1.6;
  u.uPortalSpan.value = 3.2;
  // Screen units per unit of distance across the view, at unit depth.
  const tanHalf = Math.tan(MathUtils.degToRad(camera.fov) / 2);
  u.uProj.value.set(1 / (2 * tanHalf * camera.aspect), 1 / (2 * tanHalf));
  u.tunnelPixelAngle.value = (2 * tanHalf) / u.uScreen.value.y;
  u.uLambda0.value = params.colour();
  u.uBandwidth.value = params.bandwidth();
  u.uSwelling.value = params.swelling();
  // Each card swelled its own way in development.
  const seed = Number(shown.scene.split("|")[1]) || 1;
  u.uSwellSeed.value.set((seed * 12.9898) % 97, (seed * 78.233) % 89, (seed * 37.719) % 83);

  pipeline.render(scene, camera, time);
});
