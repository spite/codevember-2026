import {
  fromDefaults,
  getCamera,
  getOrthoCamera,
  renderer,
  controls as defaultControls,
  render,
  onResize,
  onRandomize,
  applyUrlState,
  keysHelp,
  setDay,
  showHint,
  showSoundHint,
  addActionButton,
  onPause,
  loadingStep,
  addKey,
  randomize,
  Maf,
} from "common";
import { GUI } from "guspira";
import {
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  LineBasicMaterial,
  Mesh,
  RawShaderMaterial,
  Scene,
  Vector3,
  Color,
  Vector4,
  Quaternion,
} from "three";
import { shader as simplex } from "shaders/perlinSimplex3D.js";
import { OrbitControls } from "modules/FreeOrbitControls.js";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { createStudioEnvironmentAsync, applyEnvironment } from "modules/pipeline/studio.js";
import { createAutoChange } from "modules/autoChange.js";
import { createSound } from "./sound.js";
import { nativeRandom } from "modules/random.js";
import { Easings } from "easings";
import { AnamorphicRig, createShadowState } from "./anamorph.js";
import { OBJECTS, OBJECT_NAMES } from "./objects.js";

const FRUSTUM_HEIGHT = 4.3;
const ORTHO_SWEET_DISTANCE = 12;
const SWEET_UP = new Vector3(0, 1, 0);
const ORIGIN = new Vector3(0, 0, 0);
const _sweetPos = new Vector3(0, 0, ORTHO_SWEET_DISTANCE);
const _tmpDir = new Vector3();

const MAX_LOOPS = 8;
// Fixed build angles: isometric tilt, and the roll every build is tuned for.
const TILT = 45;
const ROLL = 53;

const LOOKS = {
  painted: {
    background: "#b8b2a8",
    bgInner: [0.62, 0.6, 0.56],
    bgTop: [0.42, 0.405, 0.38],
    bgEdge: [0.25, 0.24, 0.225],
    body: "#e4ddd0",
    edge: "#1b1c20",
    shadowTint: "#ffffff",
    painted: true,
    aoDirect: 0.35,
    roughness: 0.62,
    specular: 0.6,
    exposure: 1,
    vignette: 0.1,
    studio: {
      keyDirection: new Vector3(-0.55, 0.62, 0.56),
      keyIntensity: 6.5,
      keySize: 0.5,
      fill: 0.32,
      floor: 0.22,
      wall: 0.42,
    },
  },
  dark: {
    background: "#040405",
    bgInner: [0.038, 0.043, 0.058],
    bgTop: [0.011, 0.013, 0.019],
    bgEdge: [0.0028, 0.0033, 0.0052],
    body: "#17181f",
    edge: "#e8e8ec",
    shadowTint: "#030305",
    roughness: 0.68,
    specular: 0.11,
    exposure: 1,
    vignette: 0.08,
    studio: {
      keyDirection: new Vector3(-0.68, 0.52, 0.85),
      keyIntensity: 5.8,
      keySize: 0.72,
      fill: 0.36,
      floor: 0.14,
      wall: 0.16,
    },
  },
  studio: {
    background: "#c8ccd3",
    backgroundRgb: [1.1, 1.13, 1.2],
    bgInner: [1.58, 1.6, 1.66],
    bgTop: [0.64, 0.69, 0.79],
    bgEdge: [0.43, 0.48, 0.58],
    body: "#f6f4ef",
    edge: "#1b1c20",
    shadowTint: "#282c36",
    aoDirect: 0.92,
    roughness: 0.54,
    specular: 0.19,
    exposure: 1,
    vignette: 0.06,
    studio: {
      keyDirection: new Vector3(-0.64, 0.6, 0.76),
      keyIntensity: 9.2,
      keySize: 0.65,
      fill: 0.56,
      floor: 0.46,
      wall: 0.6,
    },
  },
  wireframe: {
    background: "#040405",
    bgInner: [0.022, 0.026, 0.036],
    bgTop: [0.007, 0.009, 0.014],
    bgEdge: [0.0022, 0.0027, 0.0044],
    body: "#040405",
    edge: "#eef0f5",
    shadowTint: "#040405",
    aoDirect: 0,
    roughness: 1,
    specular: 0,
    exposure: 1,
    vignette: 0.06,
    studio: {
      keyDirection: new Vector3(0, 0, 1),
      keyIntensity: 0,
      keySize: 0.7,
      fill: 0,
      floor: 0,
      wall: 0,
    },
  },
};

const defaults = {
  object: "ring",
  projection: "ortho",
  fov: 52,
  segmented: true,
  blockLength: 2.2,
  splitStyle: "together",
  pool: "all",
  gap: 0.11,
  radius: 1.04,
  thickness: 0.44,
  chamfer: 0.1,
  speed: 0.07,
  cameraSway: 14,
  reverse: false,
  autoSnap: true,
  look: "painted",
  shadows: 0.7,
  edges: false,
  auto: true,
  autoTime: 14,
  growTime: 0.6,
  orbitTime: 7,
  splitTime: 4,
  exitTime: 1.2,
};

const params = fromDefaults(defaults);
const load = { studio: loadingStep(1), sound: loadingStep(1), compile: loadingStep(3) };

const sound = createSound({ onProgress: load.sound.set });
load.sound.track(sound.loaded);
const soundButton = addActionButton("../assets/sound.svg", "Sound", () => toggleSound());
function toggleSound() {
  sound.on = !sound.on;
  soundButton.querySelector("img").src = `../assets/${sound.on ? "sound" : "sound-off"}.svg`;
}
onPause((running) => sound.pause(!running));

defaultControls.enabled = false;

const orthoCamera = getOrthoCamera(FRUSTUM_HEIGHT, 0.1, 60);
orthoCamera.position.set(0, 0, ORTHO_SWEET_DISTANCE);
orthoCamera.up.copy(SWEET_UP);
orthoCamera.lookAt(ORIGIN);

const orthoControls = new OrbitControls(orthoCamera, renderer.domElement);
orthoControls.target.copy(ORIGIN);
orthoControls.enablePan = false;
orthoControls.enableDamping = true;
orthoControls.dampingFactor = 0.08;
orthoControls.minZoom = 0.45;
orthoControls.maxZoom = 2.6;

const perspCamera = getCamera(defaults.fov, 0.08, 90);
const perspControls = new OrbitControls(perspCamera, renderer.domElement);
perspControls.target.copy(ORIGIN);
perspControls.enablePan = false;
perspControls.enableDamping = true;
perspControls.dampingFactor = 0.08;
perspControls.minDistance = 1.8;
perspControls.maxDistance = 26;

function syncPerspFov(fovDeg) {
  if (perspCamera.userData.baseFov !== fovDeg) {
    perspCamera.userData.baseFov = fovDeg;
    const aspect = perspCamera.aspect || 1;
    if (aspect < 1) {
      const t = Math.tan(Maf.toRadians(fovDeg) / 2);
      perspCamera.fov = Maf.toDegrees(2 * Math.atan(t / aspect));
    } else {
      perspCamera.fov = fovDeg;
    }
    perspCamera.updateProjectionMatrix();
  }
}

function getPerspSweetDistance() {
  syncPerspFov(params.fov());
  const halfRad = Maf.toRadians(perspCamera.fov) * 0.5;
  return FRUSTUM_HEIGHT / Math.max(1e-4, 2 * Math.tan(halfRad));
}

const initPerspDist = getPerspSweetDistance();
perspCamera.position.set(0, 0, initPerspDist);
perspCamera.up.copy(SWEET_UP);
perspCamera.lookAt(ORIGIN);

// Shadows and screen-space AO/GI stay off: both read real depth, which breaks at the sightline portals. Key shadows
// and AO are traced in illusion space instead.
const pipeline = new Pipeline(renderer, {
  background: LOOKS.dark.background,
  exposure: 1,
  bloomStrength: 0.02,
  vignette: 0.12,
  grain: 0.006,
  shadows: false,
  shadow: { autoFit: false },
  gi: false,
});

const studios = {
  painted: createStudioEnvironmentAsync(renderer, LOOKS.painted.studio),
  dark: createStudioEnvironmentAsync(renderer, LOOKS.dark.studio),
  studio: createStudioEnvironmentAsync(renderer, LOOKS.studio.studio),
  wireframe: createStudioEnvironmentAsync(renderer, LOOKS.wireframe.studio),
};
load.studio.track(Promise.all(Object.values(studios)));

let snapping = false;
let dragging = false;

function snapToSweetSpot() {
  snapping = true;
  show.drive = false;
}

// Shape changes are staged: the old shape grows and dithers out where it stands, the camera jumps (unseen, the scene
// is empty) to the orbit's start, and swings around the new shape until it clicks into the sweet spot.
const SHAPE_KEYS = ["object", "blockLength", "gap", "radius", "thickness", "chamfer", "splitStyle"];
// Segmentable figures land whole, open their gaps while marching, and close them again before leaving.
const EXIT_SCALE = 1.5;
const ORBIT_SWEEP = Math.PI * 2.2;
const ORBIT_PITCH = 0.5;
const ORBIT_DOLLY = 1.35;
const show = {
  phase: "orbit",
  t: 0,
  duration: 6,
  scale: 0,
  scale0: 0,
  dissolve: 0,
  roll: 0,
  swayT: 0,
  held: null,
  drive: true,
  started: false,
  side: nativeRandom() < 0.5 ? -1 : 1,
  wave: nativeRandom() * Math.PI * 2,
  from: { yaw: 0, pitch: 0, dist: 1, zoom: 1 },
  spring: { x: [0, 0, 1, 1], v: [0, 0, 0, 0] },
  settled: true,
  split: 0,
};

const canSegmentShown = () => params.segmented() && segmentable(shapeParam("object"));

const shapeParam = (k) => (show.held ? show.held[k] : params[k]());

function cameraAngles(cam) {
  const p = cam.position;
  const d = p.length() || 1;
  return { yaw: Math.atan2(p.x, p.z), pitch: Math.asin(Maf.clamp(p.y / d, -1, 1)), dist: d, zoom: cam.zoom };
}

function placeCamera(cam, ctrl, yaw, pitch, dist, zoom) {
  cam.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
  cam.up.copy(SWEET_UP);
  ctrl.target.copy(ORIGIN);
  cam.lookAt(ORIGIN);
  if (cam.isOrthographicCamera && cam.zoom !== zoom) {
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
  }
}

function startPhase(phase) {
  show.phase = phase;
  show.t = 0;
  show.scale0 = show.scale;
  show.from = cameraAngles(getActiveCamera());
}

// Phase durations come from the Transition section; auto change counts across all of them.
function startOrbit(sweetDist) {
  show.held = null;
  show.scale = 0;
  show.dissolve = 0;
  show.side = nativeRandom() < 0.5 ? -1 : 1;
  show.wave = nativeRandom() * Math.PI * 2;
  show.split = 0;
  show.landed = false;
  sound.whoosh({ gain: 0.5 });
  show.duration = params.orbitTime();
  // The sway passes upright exactly as the orbit lands, and keeps rolling while the figure is on screen.
  show.swayT = -show.duration;
  if (!dragging) {
    show.drive = true;
    snapping = false;
    const cam = getActiveCamera();
    placeCamera(cam, getActiveControls(), -show.side * ORBIT_SWEEP, ORBIT_PITCH * Math.sin(show.wave),
      sweetDist * (cam.isOrthographicCamera ? 1 : ORBIT_DOLLY), cam.isOrthographicCamera ? 1 / ORBIT_DOLLY : 1);
  }
  startPhase("orbit");
  show.settled = false;
  if (show.drive) {
    show.from.yaw = -show.side * ORBIT_SWEEP;
    const g0 = orbitGuide(0, sweetDist);
    const g1 = orbitGuide(1e-3, sweetDist);
    show.spring = { x: g0, v: g0.map((g, i) => ((g1[i] - g) / 1e-3) / show.duration) };
  }
}

function requestShapeChange() {
  if (!show.started) return;
  show.held ??= Object.fromEntries(SHAPE_KEYS.map((k) => [k, params[k]()]));
  if (show.phase === "exit" || show.phase === "merge") return;
  show.drive = !dragging;
  if (show.split > 0 && canSegmentShown()) {
    show.phase = "merge";
  } else {
    startPhase("exit");
  }
}


function updateShow(dt, sweetDist) {
  if (!show.started) {
    show.started = true;
    startOrbit(sweetDist);
  }
  const cam = getActiveCamera();
  const ctrl = getActiveControls();
  show.t += dt;
  if (show.phase === "merge") {
    show.split = Math.max(0, show.split - dt / params.splitTime());
    if (show.split <= 0) startPhase("exit");
  } else if (show.phase === "click" && canSegmentShown() && (show.settled || !show.drive)) {
    show.split = Math.min(1, show.split + dt / params.splitTime());
  }
  if (show.phase === "exit") {
    const u = Maf.clamp(show.t / params.exitTime(), 0, 1);
    show.scale = Maf.lerp(show.scale0, EXIT_SCALE, Easings.InQuad(u));
    show.dissolve = Easings.InOutSine(u);
    if (u >= 1) startOrbit(sweetDist);
  } else if (show.phase === "orbit") {
    const u = Maf.clamp(show.t / show.duration, 0, 1);
    show.scale = Easings.OutCubic(Maf.clamp(show.t / params.growTime(), 0, 1));
    if (show.drive) followSpring(cam, ctrl, orbitGuide(u, sweetDist), dt);
    if (u >= 1) startPhase("click");
  } else if (show.phase === "click" && show.drive && !show.settled) {
    // The spring lags the guide, so it lands here: settle, then pin the exact sweet spot.
    const target = [0, 0, sweetDist, 1];
    followSpring(cam, ctrl, target, dt);
    const err = show.spring.x.reduce((m, x, i) => Math.max(m, Math.abs(x - target[i]) / (i === 2 ? sweetDist : 1)), 0);
    const vel = show.spring.v.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (err < 2e-4 && vel < 2e-3) {
      show.settled = true;
      placeCamera(cam, ctrl, 0, 0, sweetDist, 1);
      ctrl.saveState();
    }
  }
}

// The orbit's guide path: a long swing that glides into the sweet spot. [yaw, pitch, dist, zoom]
function orbitGuide(u, sweetDist) {
  const k = Easings.OutCubic(u);
  const settle = 1 - k;
  return [
    // Fast for most of the swing, then a long smooth brake into the sweet spot.
    show.from.yaw * (1 - Easings.OutQuart(u)),
    show.from.pitch * settle + 0.22 * Math.sin(show.wave + u * Math.PI * 3) * settle,
    Maf.lerp(show.from.dist, sweetDist, Easings.InOutCubic(u)),
    Maf.lerp(show.from.zoom, 1, Easings.InOutCubic(u)),
  ];
}

// Under-damped spring chasing the guide: a soft overshoot and settle instead of an eased stop.
const SPRING_OMEGA = 7;
const SPRING_ZETA = 0.7;
function followSpring(cam, ctrl, target, dt) {
  const { x, v } = show.spring;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let n = 0; n < steps; n++) {
    for (let i = 0; i < 4; i++) {
      v[i] += (SPRING_OMEGA * SPRING_OMEGA * (target[i] - x[i]) - 2 * SPRING_ZETA * SPRING_OMEGA * v[i]) * h;
      x[i] += v[i] * h;
    }
  }
  placeCamera(cam, ctrl, x[0], x[1], x[2], x[3]);
}

for (const ctrl of [orthoControls, perspControls]) {
  ctrl.addEventListener("start", () => {
    dragging = true;
    snapping = false;
    show.drive = false;
  });
  ctrl.addEventListener("end", () => {
    dragging = false;
    if (params.autoSnap()) snapping = true;
  });
}

function stepObject(delta) {
  const idx = OBJECT_NAMES.indexOf(params.object());
  const next = OBJECT_NAMES[((idx < 0 ? 0 : idx) + delta + OBJECT_NAMES.length) % OBJECT_NAMES.length];
  params.object.set(next);
}

function toggleProjection() {
  params.projection.set(params.projection() === "perspective" ? "ortho" : "perspective");
}

addKey("KeyL", "snap to sweet spot", snapToSweetSpot);
addKey("KeyM", "toggle sound", toggleSound);
showSoundHint(() => !sound.running);
addKey("KeyO", "toggle ortho / perspective", toggleProjection);
addKey("KeyS", "toggle segments", () => params.segmented.set(!params.segmented()));
addKey("KeyE", "toggle edge outlines", () => params.edges.set(!params.edges()));
addKey("BracketLeft", "previous object", () => stepObject(-1));
addKey("BracketRight", "next object", () => stepObject(1));

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
const section = {
  geometry: gui.addSection("Geometry"),
  motion: gui.addSection("Motion & View"),
  surface: gui.addSection("Look"),
  transition: gui.addSection("Transition"),
};

// Figures that march cleanly in segments; the others always show as one continuous piece.
const SEGMENT_OK = new Set([
  "ring", "figure-8", "trefoil", "triangle", "star", "stairs",
  "s-hook", "triquetra", "double-tribar", "borromean", "hourglass",
  "square", "diamond", "pentagon", "hexagon", "reutersvard", "hooked-tribar", "cross", "pinwheel", "frame", "meander",
  "waterfall", "archway", "ladder", "spiral-tribar",
  "divided-diamond", "hex-cross", "valknut", "borromean-tribar",
]);
const segmentable = (name) => SEGMENT_OK.has(name);
const SPLIT_STYLES = ["together", "wave", "alternate", "halving", "joins", "both ways", "slide"];
const canSegment = () => segmentable(params.object());
const notSegmented = () => !params.segmented() || !canSegment();
const notPerspective = () => params.projection() !== "perspective";
const isWireframe = () => params.look() === "wireframe";

gui.into(section.geometry);
gui.addSelect("Object", params.object, OBJECT_NAMES);
gui.addSegmented("Randomize from", params.pool, ["all", "segmented", "solid"], { randomizable: false });
gui.addCheckbox("Segmented (S)", params.segmented, { randomizable: false, disabledWhen: () => !canSegment() });
gui.addSelect("Split", params.splitStyle, SPLIT_STYLES, { randomizable: false, disabledWhen: notSegmented });
gui.addSlider("Block length", params.blockLength, 1.2, 4, 0.1, { randomizable: false, disabledWhen: notSegmented });
gui.addSlider("Gap", params.gap, 0.07, 0.45, 0.01, { disabledWhen: notSegmented });
gui.addSlider("Radius", params.radius, 0.65, 1.35, 0.01);
gui.addSlider("Thickness", params.thickness, 0.22, 0.58, 0.01);
gui.addSlider("Chamfer", params.chamfer, 0, 0.45, 0.01, { randomizable: false });

gui.into(section.motion);
gui.addSegmented("Projection (O)", params.projection, ["perspective", "ortho"], { randomizable: false });
gui.addSlider("FOV", params.fov, 28, 70, 1, { randomizable: false, disabledWhen: notPerspective });
gui.addSlider("Speed", params.speed, 0, 0.35, 0.005, { randomizable: false, disabledWhen: notSegmented });
gui.addSlider("Camera sway (°)", params.cameraSway, 0, 30, 1, { randomizable: false });
gui.addCheckbox("Reverse", params.reverse, { randomizable: false, disabledWhen: notSegmented });
gui.addCheckbox("Auto-snap", params.autoSnap, { randomizable: false });
gui.addButton("Snap to sweet spot (L)", snapToSweetSpot);

gui.into(section.surface);
gui.addSegmented("Look", params.look, ["painted", "dark", "studio", "wireframe"], { randomizable: false });
gui.addSlider("Shadows", params.shadows, 0, 1, 0.01, { randomizable: false, disabledWhen: isWireframe });
gui.addCheckbox("Edges (E)", params.edges, { randomizable: false });
gui.endSection();

gui.into(section.transition);
gui.addSlider("Grow in (s)", params.growTime, 0.1, 3, 0.1, { randomizable: false });
gui.addSlider("Orbit (s)", params.orbitTime, 1, 15, 0.5, { randomizable: false });
gui.addSlider("Split / merge (s)", params.splitTime, 0.5, 10, 0.5, { randomizable: false });
gui.addSlider("Exit (s)", params.exitTime, 0.3, 4, 0.1, { randomizable: false });
gui.endSection();

const autoChange = createAutoChange({
  enabled: params.auto,
  every: params.autoTime,
  gui,
  ready: () => show.phase !== "exit" && show.phase !== "merge",
});
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint(
  "Drag to orbit and break the illusion · L to realign · R for a new figure",
  "Drag to break the illusion · tap {randomize} for a new figure",
);
gui.show();

const scene = new Scene();

const backdropUniforms = {
  uBgInner: { value: new Vector3(...LOOKS.studio.bgInner) },
  uBgTop: { value: new Vector3(...LOOKS.studio.bgTop) },
  uBgEdge: { value: new Vector3(...LOOKS.studio.bgEdge) },
  uIsWireframe: { value: 0 },
  resolution: globalUniforms.resolution,
  pipelineDebug: globalUniforms.pipelineDebug,
};

const BACKDROP_GRADIENT_GLSL = /* glsl */ `
  vec3 evalBackdropGradient(vec2 uv, vec2 res, vec3 bgInner, vec3 bgTop, vec3 bgEdge) {
    float aspect = res.x / max(res.y, 1.0);
    float sweep = clamp(0.68 * uv.y + 0.32 * (1.0 - uv.x), 0.0, 1.0);
    vec3 base = mix(bgInner, bgTop, smoothstep(0.02, 0.98, sweep));
    vec2 p = (uv - vec2(0.52, 0.46)) * vec2(clamp(aspect, 0.75, 1.35), 1.0);
    float rad = smoothstep(0.12, 0.92, length(p));
    vec3 col = mix(base, bgEdge, rad * 0.74);
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    return max(vec3(0.0), col + dither * 0.002 * max(col, vec3(0.02)));
  }
`;

const backdropGeo = new BufferGeometry();
backdropGeo.setAttribute(
  "position",
  new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
);
const backdropMaterial = new RawShaderMaterial({
  glslVersion: GLSL3,
  uniforms: backdropUniforms,
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */ `
    in vec3 position;
    out vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.9999, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec3 uBgInner;
    uniform vec3 uBgTop;
    uniform vec3 uBgEdge;
    uniform vec2 resolution;
    uniform float pipelineDebug;
    in vec2 vUv;
    layout(location = 0) out vec4 outColor;
    ${BACKDROP_GRADIENT_GLSL}
    void main() {
      if (pipelineDebug > 0.5) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      outColor = vec4(evalBackdropGradient(vUv, resolution, uBgInner, uBgTop, uBgEdge), 1.0);
    }
  `,
});
const backdropMesh = new Mesh(backdropGeo, backdropMaterial);
backdropMesh.frustumCulled = false;
backdropMesh.renderOrder = -1000;
scene.add(backdropMesh);

const shadowState = createShadowState();
const paintUniforms = {
  uPainted: { value: 1 },
  uDissolve: { value: 0 },
  uLoopInfo: { value: Array.from({ length: MAX_LOOPS }, () => new Vector4()) },
};
const bodyMaterial = new PipelineMaterial({
  color: LOOKS.dark.body,
  roughness: LOOKS.dark.roughness,
  metalness: 0,
  specular: LOOKS.dark.specular,
  uniforms: {
    ...shadowState.uniforms,
    ...paintUniforms,
    uBgInner: backdropUniforms.uBgInner,
    uBgTop: backdropUniforms.uBgTop,
    uBgEdge: backdropUniforms.uBgEdge,
    uIsWireframe: backdropUniforms.uIsWireframe,
  },
  varyings: {
    vSweetPos: "vec3",
    vSweetNorm: "vec3",
    vSweetTag: "vec4",
  },
  vertexPars: /* glsl */ `
    in vec3 sweetPos;
    in vec3 sweetNorm;
    in vec4 sweetTag;
  `,
  vertexMain: /* glsl */ `
    vSweetPos = sweetPos;
    vSweetNorm = sweetNorm;
    vSweetTag = sweetTag;
  `,
  fragmentPars: /* glsl */ `
    uniform sampler2D uShadowBoxes;
    uniform int uShadowBoxCount;
    uniform int uShadowWasherMode;
    uniform int uShadowCurveMode;
    uniform vec4 uShadowCurveA;
    uniform vec4 uShadowCurveB;
    uniform vec4 uShadowCurveC;
    uniform int uShadowSegmented;
    uniform float uShadowStrength;
    uniform float uShadowGap;
    uniform vec3 uShadowLightDir;
    uniform vec3 uShadowTint;
    uniform vec3 uBgInner;
    uniform vec3 uBgTop;
    uniform vec3 uBgEdge;
    uniform int uIsWireframe;
    uniform float uPainted;
    uniform float uDissolve;
    uniform vec4 uLoopInfo[${MAX_LOOPS}];
    ${BACKDROP_GRADIENT_GLSL}
    ${simplex}

    // Painted wood: strokes run along the loop and ride with the conveyor; across = sweet-view offset across the beam,
    // so the pattern welds across portals from the sweet spot.
    void paintSurface(inout Surface s) {
      int packed = int(vSweetTag.x + 0.5);
      vec4 info = uLoopInfo[min(packed / 16384, ${MAX_LOOPS - 1})];
      float sv = vSweetTag.y;
      // Loop position wrapped onto a circle of the loop's length: seamless around the loop and across closed gaps,
      // and it rides with the conveyor.
      float a = 6.2831853 * (sv - info.x);
      vec2 ring = vec2(cos(a), sin(a)) * (info.z / 6.2831853);
      vec2 gx = dFdx(vSweetPos.xy), gy = dFdy(vSweetPos.xy);
      vec2 ds = vec2(dFdx(sv), dFdy(sv));
      ds -= floor(ds + 0.5);
      mat2 M = mat2(gx.x, gy.x, gx.y, gy.y);
      float det = determinant(M);
      vec2 t = abs(det) > 1e-12 ? inverse(M) * ds : vec2(1.0, 0.0);
      t = length(t) > 1e-8 ? normalize(t) : vec2(1.0, 0.0);
      float across = dot(vSweetPos.xy, vec2(-t.y, t.x));

      // End caps and edge-on faces have no beam direction: fade the directional strokes out there.
      float dirOk = smoothstep(0.2, 0.6, length(ds) / max(1e-6, length(gx) + length(gy)) * info.z);
      float seed = float(packed / 16384) * 7.3;
      // Slow tone drift, like paint laid on unevenly; nothing at a scale that repeats across a beam.
      float drift = mix(snoise(vec3(vSweetPos.xy * 0.45, seed)), snoise(vec3(ring * 0.45, across * 0.45 + seed)), dirOk);
      // Brush lines: long along the beam, fine across it, warped so they never line up.
      float warp = snoise(vec3(ring * 0.6, across * 3.0 + seed + 11.0));
      float lines = snoise(vec3(ring * 0.35, (across + 0.012 * warp) * 55.0 + seed + 5.0)) * dirOk;
      lines *= 0.5 + 0.5 * snoise(vec3(ring * 0.9, across * 2.0 + seed + 3.0));

      s.albedo *= 1.0 + 0.012 * drift + 0.004 * lines;
      // The lines mostly show in the highlight, as a satin finish does.
      s.roughness = clamp(s.roughness + 0.05 * lines + 0.03 * drift, 0.3, 0.95);

      // Faint brush ridges as a derivative bump on the shading normal.
      float h = lines * 0.35;
      vec3 dpx = dFdx(vWorldPosition), dpy = dFdy(vWorldPosition);
      vec3 n = s.normal;
      vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
      float d = dot(dpx, r1);
      vec3 grad = sign(d) * (dFdx(h) * r1 + dFdy(h) * r2);
      s.normal = normalize(abs(d) * n - grad * 0.0006);
    }

    float anamorphSdBox(vec3 p, vec3 b) {
      vec3 q = abs(p) - b;
      return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
    }

    float anamorphSdShearedOct(float dn, float dz, float bN, float halfW, float halfDs, float chamfer) {
      float k = bN / max(1e-5, halfDs);
      float invShear = inversesqrt(1.0 + k * k);
      float dSide = (abs(dn - k * dz) - halfW) * invShear;
      float dZ = abs(dz) - halfDs;
      float saSign = (dn - k * dz) >= 0.0 ? 1.0 : -1.0;
      float sbSign = dz >= 0.0 ? 1.0 : -1.0;
      float invW = 1.0 / max(1e-5, halfW);
      float invD = 1.0 / max(1e-5, halfDs);
      float gx = saSign * invW;
      float gz = -saSign * k * invW + sbSign * invD;
      float dCham = (abs(dn - k * dz) * invW + abs(dz) * invD - (2.0 - chamfer))
        * inversesqrt(max(1e-10, gx * gx + gz * gz));
      float sd2d = max(dSide, max(dZ, dCham));
      if (dSide > 0.0 && dZ > 0.0) {
        sd2d = max(length(vec2(dSide, dZ)), dCham);
      }
      return sd2d;
    }

    void anamorphEvalFig8(
      float uIn,
      out vec2 pOut,
      out vec2 dpOut,
      out vec2 t0Out,
      out vec2 n0Out,
      out vec2 bVecOut,
      out float zRawOut
    ) {
      float figR = uShadowCurveA.x;
      float splitJumpS = uShadowCurveA.y;
      float leanX = uShadowCurveB.x;
      float leanY = uShadowCurveB.y;
      float zAmpS = uShadowCurveC.x;
      float u = clamp(uIn, 1e-5, 1.0 - 1e-5);
      vec2 c0;
      if (u < 0.25) {
        float a = 12.566370614 * u;
        float ca = cos(a);
        float sa = sin(a);
        c0 = vec2(figR * sa, figR + figR * ca);
        t0Out = vec2(ca, -sa);
      } else if (u < 0.75) {
        float b = 12.566370614 * (u - 0.25);
        float cb = cos(b);
        float sb = sin(b);
        c0 = vec2(-figR * sb, -figR + figR * cb);
        t0Out = vec2(-cb, -sb);
      } else {
        float a = 3.14159265359 + 12.566370614 * (u - 0.75);
        float ca = cos(a);
        float sa = sin(a);
        c0 = vec2(figR * sa, figR + figR * ca);
        t0Out = vec2(ca, -sa);
      }
      n0Out = vec2(-t0Out.y, t0Out.x);
      float invR = 1.0 / max(1e-4, figR);
      vec2 bev = vec2(leanX, leanY) * (c0.x * invR);
      pOut = c0 + 0.5 * bev;
      bVecOut = -0.5 * bev;
      float spd = 12.566370614 * figR;
      dpOut = spd * (t0Out + 0.5 * vec2(leanX, leanY) * invR * t0Out.x);
      zRawOut = zAmpS * sin(6.28318530718 * u) + splitJumpS * (0.5 - u);
    }

    void anamorphEvalTrefoil(
      float u,
      int pi,
      out vec2 pOut,
      out vec2 dpOut,
      out vec2 t0Out,
      out vec2 n0Out,
      out float bNOut,
      out float zRawOut
    ) {
      float rMaj = uShadowCurveA.x;
      float rMin = uShadowCurveA.y;
      float lean = uShadowCurveB.x;
      float zAmpS = uShadowCurveC.x;
      float a = 12.566370614 * u;
      float b = -6.28318530718 * u;
      float ca = cos(a);
      float sa = sin(a);
      float cb = cos(b);
      float sb = sin(b);
      vec2 c0 = vec2(rMaj * ca + rMin * cb, rMaj * sa + rMin * sb);
      vec2 v = vec2(
        -12.566370614 * rMaj * sa + 6.28318530718 * rMin * sb,
         12.566370614 * rMaj * ca - 6.28318530718 * rMin * cb
      );
      vec2 d2 = vec2(
        -157.91367042 * rMaj * ca - 39.47841760 * rMin * cb,
        -157.91367042 * rMaj * sa - 39.47841760 * rMin * sb
      );
      float vLenSq = max(dot(v, v), 1e-8);
      float invVLen = inversesqrt(vLenSq);
      t0Out = v * invVLen;
      n0Out = vec2(-t0Out.y, t0Out.x);
      float flip = sin(18.8495559215 * u) * lean;
      pOut = c0 + 0.5 * flip * n0Out;
      bNOut = -0.5 * flip;
      float dFlip = 18.8495559215 * cos(18.8495559215 * u) * lean;
      float kn = (v.x * d2.y - v.y * d2.x) / vLenSq;
      dpOut = v + 0.5 * (dFlip * n0Out - flip * kn * t0Out);
      float wLoc = (u - float(pi) * 0.33333333) * 3.0;
      zRawOut = zAmpS * cos(3.14159265359 * wLoc);
    }

    float anamorphClosestTRayBox2D(
      vec2 y0,
      vec2 yd,
      vec2 b,
      float tLo,
      float tHi
    ) {
      float tx0 = -1e9;
      float tx1 = 1e9;
      if (abs(yd.x) > 1e-6) {
        float a0 = (-b.x - y0.x) / yd.x;
        float a1 = ( b.x - y0.x) / yd.x;
        tx0 = min(a0, a1);
        tx1 = max(a0, a1);
      } else if (abs(y0.x) > b.x) {
        tx0 = 1e9;
        tx1 = -1e9;
      }

      float tz0 = -1e9;
      float tz1 = 1e9;
      if (abs(yd.y) > 1e-6) {
        float c0 = (-b.y - y0.y) / yd.y;
        float c1 = ( b.y - y0.y) / yd.y;
        tz0 = min(c0, c1);
        tz1 = max(c0, c1);
      } else if (abs(y0.y) > b.y) {
        tz0 = 1e9;
        tz1 = -1e9;
      }

      float sEnter = max(tLo, max(tx0, tz0));
      float sExit = min(tHi, min(tx1, tz1));
      if (sEnter <= sExit) {
        return 0.5 * (sEnter + sExit);
      }

      float yd2 = max(dot(yd, yd), 1e-8);
      float tMidA = clamp(-dot(y0, yd) / yd2, tLo, tHi);
      vec2 pMid = y0 + tMidA * yd;
      vec2 corn = vec2(pMid.x >= 0.0 ? b.x : -b.x, pMid.y >= 0.0 ? b.y : -b.y);
      float tCorn = clamp(dot(corn - y0, yd) / yd2, tLo, tHi);

      float cands[7];
      cands[0] = tLo;
      cands[1] = tHi;
      cands[2] = clamp(tx0, tLo, tHi);
      cands[3] = clamp(tx1, tLo, tHi);
      cands[4] = clamp(tz0, tLo, tHi);
      cands[5] = clamp(tz1, tLo, tHi);
      cands[6] = tCorn;

      float bestT = tLo;
      float bestD = 1e9;
      for (int i = 0; i < 7; i++) {
        vec2 q = abs(y0 + cands[i] * yd) - b;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        if (d < bestD) {
          bestD = d;
          bestT = cands[i];
        }
      }
      return bestT;
    }

    float anamorphSdWasher(
      vec3 p,
      vec3 b,
      float aRatio,
      float pieceFlag,
      float scalePlanar,
      float scaleN,
      float bandW
    ) {
      float u = p.x;
      float w = p.y;
      float v = p.z;
      float rSq = b.x;
      float halfT = b.y;
      float rC = b.z;

      vec2 qOut = abs(vec2(u, v)) - vec2(rSq);
      float sdOut = length(max(qOut, 0.0)) + min(max(qOut.x, qOut.y), 0.0);

      float sdHole;
      float r = length(vec2(u, v));
      if (r < 1e-5) {
        sdHole = rC;
      } else if (u >= 0.0 && v <= 0.0) {
        vec2 qIn = vec2(u - rC, -v - rC);
        sdHole = -(length(max(qIn, 0.0)) + min(max(qIn.x, qIn.y), 0.0));
      } else if (u <= 0.0 && v >= 0.0) {
        sdHole = rC - r;
      } else {
        float ca = u > 0.0 ? (u / r) : (-v / r);
        float sa = u > 0.0 ? (v / r) : (-u / r);
        if (sa <= aRatio * ca) {
          sdHole = u > 0.0 ? (rC - u) : (rC + v);
        } else {
          float c1 = 3.0 - sqrt(2.0 * (1.0 - aRatio));
          float s = sqrt(clamp((1.0 - sa) / max(1e-4, 1.0 - aRatio), 0.0, 1.0));
          for (int it = 0; it < 3; it++) {
            float om = 1.0 - s;
            float x = 1.0 - om * om * om * (1.0 + c1 * s);
            float dx = om * om * ((3.0 - c1) + 4.0 * c1 * s);
            float y = 1.0 - (1.0 - aRatio) * s * s;
            float dy = -2.0 * (1.0 - aRatio) * s;
            s = clamp(s - (x * sa - y * ca) / max(dx * sa - dy * ca, 1e-5), 0.0, 1.0);
          }
          float om = 1.0 - s;
          float x = 1.0 - om * om * om * (1.0 + c1 * s);
          float dx = om * om * ((3.0 - c1) + 4.0 * c1 * s);
          float y = 1.0 - (1.0 - aRatio) * s * s;
          float dy = -2.0 * (1.0 - aRatio) * s;
          float rUnit = sqrt(x * x + y * y);
          float tx = dx;
          float ty = dy;
          float tLen = max(length(vec2(tx, ty)), 1e-5);
          // Outward hole normal (pointing into solid washer): (-ty, tx) / tLen -> radial cos = (x*(-ty) + y*tx)/(rUnit*tLen)
          float cosRad = abs(-x * ty + y * tx) / max(rUnit * tLen, 1e-5);
          sdHole = (rC * rUnit - r) * max(cosRad, 0.7);
        }
      }

      // bandW > 0: the rim is a band of that width around the hole instead of a square plate.
      float sd2D = bandW > 0.0 ? max(sdHole, -sdHole - bandW) : max(sdOut, sdHole);
      if (pieceFlag < -150.0) {
        // Left post only (Plate liB == (liA + 2) % 3 crossing over liA; excludes BotBar which passes under liA)
        float sdPost = max(v, u + 0.52 * rSq);
        sd2D = max(sd2D, sdPost);
      } else if (pieceFlag < -50.0) {
        // Full Piece 0 overpass (Plate liB == (liA + 1) % 3 crossing over liA)
        float sdClip0 = max(v, (u + 0.85 * v - 0.1 * rSq) * 0.76194);
        sd2D = max(sd2D, sdClip0);
      }

      vec2 d3 = vec2(sd2D * scalePlanar, (abs(w) - halfT) * scaleN);
      return length(max(d3, 0.0)) + min(max(d3.x, d3.y), 0.0);
    }

    float anamorphSdMiterPrismFast(
      vec3 pLocal,
      vec3 b,
      float kBev,
      float invBevMin,
      float qc0,
      float qc1
    ) {
      vec3 ap = abs(pLocal);
      float q1 = ap.y - b.y;
      float q2 = ap.z - b.z;
      float qCross = invBevMin > 0.0
        ? max(max(q1, q2), (ap.y / b.y + ap.z / b.z - kBev) * invBevMin)
        : (length(max(vec2(q1, q2), 0.0)) + min(max(q1, q2), 0.0));
      float qCap = max(ap.x - b.x, max(qc0, qc1));
      return length(max(vec2(qCross, qCap), 0.0)) + min(max(qCross, qCap), 0.0);
    }

    vec2 traceSpecialShadow(
      vec3 pA,
      vec3 nA,
      vec4 tagA,
      vec3 rayDir,
      float penumbraSlope,
      float baseSoft,
      float maxReach,
      float crossReach
    ) {
      float ndl = dot(nA, rayDir);
      if (ndl <= 0.01) return vec2(1.0);
      float receiverGate = smoothstep(0.01, 0.18, ndl);
      vec3 ro = pA + nA * 0.015;
      int liA = int(tagA.x + 0.5) / 16384;
      float sA = tagA.y;
      float zpA = tagA.z;
      float minVis = 1.0;
      float minTight = 1.0;
      int zero = min(uShadowBoxCount, 0);

      if (uShadowWasherMode == 1) {
        int washerCount = min(uShadowBoxCount, 3);
        for (int i = 0; i < washerCount; i++) {
          vec4 r0 = texelFetch(uShadowBoxes, ivec2(i, 0), 0);
          vec4 r1 = texelFetch(uShadowBoxes, ivec2(i, 1), 0);
          vec4 r2 = texelFetch(uShadowBoxes, ivec2(i, 2), 0);
          vec4 r3 = texelFetch(uShadowBoxes, ivec2(i, 3), 0);
          vec4 r4 = texelFetch(uShadowBoxes, ivec2(i, 4), 0);

          int liB = int(r0.w + 0.5) / 16384;
          bool sameLoop = liA == liB;
          float boxZ;
          float isCross;
          float clipFlag;

          if (sameLoop) {
            boxZ = r0.z - r4.z + zpA;
            isCross = 0.0;
            clipFlag = 0.0;
          } else {
            boxZ = pA.z + uShadowGap;
            isCross = 1.0;
            int cyc = liB - liA;
            if (cyc < 0) cyc += 3;
            clipFlag = (cyc == 1) ? -100.0 : -200.0;
          }

          float effReach = mix(maxReach, min(maxReach, crossReach), isCross);
          float maxPad = baseSoft + penumbraSlope * effReach;

          vec3 cU = cross(r2.xyz, r3.xyz);
          float detInv = dot(r1.xyz, cU);
          float invD0 = abs(detInv) > 1e-8 ? (1.0 / detInv) : 1.0;
          vec3 colU = cU * invD0;
          vec3 colV = cross(r3.xyz, r1.xyz) * invD0;
          vec3 colW = cross(r1.xyz, r2.xyz) * invD0;
          float scalePlanar = min(length(colU), length(colW));
          float scaleN = length(colV);

          vec4 washerBand = texelFetch(uShadowBoxes, ivec2(i, 5), 0);
          float extentUV = max(r1.w, washerBand.y);
          vec3 boxCenter = vec3(r0.xy, boxZ);
          float maxProtrusion = dot(boxCenter - pA, nA)
            + extentUV * abs(dot(colU, nA))
            + r2.w * abs(dot(colV, nA))
            + extentUV * abs(dot(colW, nA));
          if (maxProtrusion <= 0.018) continue;
          float protrusionGate = smoothstep(0.018, 0.058, maxProtrusion);

          vec3 rel = ro - boxCenter;
          vec3 p0 = vec3(dot(rel, r1.xyz), dot(rel, r2.xyz), dot(rel, r3.xyz));
          vec3 d  = vec3(dot(rayDir, r1.xyz), dot(rayDir, r2.xyz), dot(rayDir, r3.xyz));
          vec3 bBound = vec3(extentUV, r2.w, extentUV);
          vec3 bPad = bBound + vec3(
            maxPad / max(scalePlanar, 1e-4),
            maxPad / max(scaleN, 1e-4),
            maxPad / max(scalePlanar, 1e-4)
          );

          vec3 invD = 1.0 / (mix(vec3(1.0), vec3(-1.0), lessThan(d, vec3(0.0))) * max(abs(d), vec3(1e-5)));
          vec3 t0s = (-bPad - p0) * invD;
          vec3 t1s = ( bPad - p0) * invD;
          vec3 tMinV = min(t0s, t1s);
          vec3 tMaxV = max(t0s, t1s);
          float minStart = sameLoop ? 0.22 : 0.0;
          float tEnter = max(max(tMinV.x, tMinV.y), max(tMinV.z, minStart));
          float tExit  = min(min(tMaxV.x, tMaxV.y), min(tMaxV.z, effReach));
          if (tExit <= tEnter) continue;

          vec3 bWasher = vec3(r1.w, r2.w, r3.w);
          int bestKw = 0;
          float bestFw = 1e9;
          int kwLim = 8 + zero;
          for (int kw = 0; kw <= kwLim; kw++) {
            float tk = tEnter + (tExit - tEnter) * (float(kw) * 0.125);
            float fk = anamorphSdWasher(p0 + tk * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
            if (fk < bestFw) {
              bestFw = fk;
              bestKw = kw;
            }
          }
          float loW = tEnter + (tExit - tEnter) * (float(max(0, bestKw - 1)) * 0.125);
          float hiW = tEnter + (tExit - tEnter) * (float(min(8, bestKw + 1)) * 0.125);
          float cW = loW + (hiW - loW) * 0.38196601;
          float dW = loW + (hiW - loW) * 0.61803399;
          float fcW = anamorphSdWasher(p0 + cW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          float fdW = anamorphSdWasher(p0 + dW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          int gsLimW = 7 + zero;
          for (int k = 0; k < gsLimW; k++) {
            if (fcW < fdW) {
              hiW = dW;
              dW = cW;
              fdW = fcW;
              cW = loW + (hiW - loW) * 0.38196601;
              fcW = anamorphSdWasher(p0 + cW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
            } else {
              loW = cW;
              cW = dW;
              fcW = fdW;
              dW = loW + (hiW - loW) * 0.61803399;
              fdW = anamorphSdWasher(p0 + dW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
            }
          }
          float midW = 0.5 * (loW + hiW);
          float fLoW = anamorphSdWasher(p0 + loW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          float fMidW = anamorphSdWasher(p0 + midW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          float fHiW = anamorphSdWasher(p0 + hiW * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          float denW = fLoW - 2.0 * fMidW + fHiW;
          float tBest = denW > 1e-7
            ? clamp(midW + 0.25 * (hiW - loW) * (fLoW - fHiW) / denW, loW, hiW)
            : (fcW < fdW ? cW : dW);
          float sd = anamorphSdWasher(p0 + tBest * d, bWasher, r4.y, clipFlag, scalePlanar, scaleN, washerBand.x);
          float selfRimGate = sameLoop ? smoothstep(0.22, 0.34, tBest) : 1.0;

          float soft = baseSoft + penumbraSlope * tBest;
          float distFade = 1.0 - smoothstep(effReach * 0.65, effReach, tBest);
          float occ = (1.0 - smoothstep(-soft * 0.65, soft, sd)) * distFade * protrusionGate * selfRimGate;
          minVis = min(minVis, 1.0 - occ * receiverGate);

          float tightSoft = 0.015 + 0.095 * tBest;
          float tightFade = 1.0 - smoothstep(0.24, 0.48, tBest);
          float tightOcc = (1.0 - smoothstep(-tightSoft * 0.6, tightSoft, sd)) * tightFade * protrusionGate * selfRimGate;
          minTight = min(minTight, 1.0 - tightOcc * receiverGate);
        }
        return vec2(minVis, minTight);
      }

      float cr = uShadowCurveB.z;
      float sr = uShadowCurveB.w;
      vec3 roU = vec3(cr * ro.x + sr * ro.y, -sr * ro.x + cr * ro.y, ro.z);
      vec3 rdU = vec3(cr * rayDir.x + sr * rayDir.y, -sr * rayDir.x + cr * rayDir.y, rayDir.z);
      float effReach = min(maxReach, crossReach);
      float maxPad = baseSoft + penumbraSlope * effReach;
      float halfW = uShadowCurveA.z;
      float halfDs = uShadowCurveA.w;
      float chamfer = uShadowCurveC.y;

      float tEnter = 0.0;
      float tExit = effReach;
      if (abs(rdU.z) > 1e-4) {
        float tz0 = (pA.z - halfDs - maxPad - roU.z) / rdU.z;
        float tz1 = (pA.z + uShadowGap + halfDs + maxPad - roU.z) / rdU.z;
        tEnter = max(0.0, min(tz0, tz1));
        tExit = min(effReach, max(tz0, tz1));
      }
      if (tExit <= tEnter) return vec2(1.0);
      float tMidRay = 0.5 * (tEnter + tExit);
      vec2 mRayXY = roU.xy + tMidRay * rdU.xy;

      int numPieces = (uShadowCurveMode == 1 ? 1 : 3) + zero;
      int seedLim = 6 + zero;
      int altLim = 6 + zero;
      for (int pi = 0; pi < numPieces; pi++) {
        float uLo = (uShadowCurveMode == 1) ? 0.04 : (float(pi) * 0.33333333);
        float uHi = (uShadowCurveMode == 1) ? 0.46 : (float(pi + 1) * 0.33333333);
        float u = 0.5 * (uLo + uHi);
        float bestD2 = 1e9;

        for (int ks = 0; ks <= seedLim; ks++) {
          float us = uLo + (uHi - uLo) * (float(ks) / 6.0);
          if (abs(fract(us - sA + 0.5) - 0.5) < 0.085) continue;
          vec2 ps;
          if (uShadowCurveMode == 1) {
            vec2 dps, ts, ns, bs;
            float zs;
            anamorphEvalFig8(us, ps, dps, ts, ns, bs, zs);
          } else {
            float a = 12.566370614 * us;
            float b = -6.28318530718 * us;
            ps = vec2(
              uShadowCurveA.x * cos(a) + uShadowCurveA.y * cos(b),
              uShadowCurveA.x * sin(a) + uShadowCurveA.y * sin(b)
            );
          }
          vec2 dxy = ps - mRayXY;
          float d2 = dot(dxy, dxy);
          if (d2 < bestD2) {
            bestD2 = d2;
            u = us;
          }
        }
        if (bestD2 > 0.90) continue;

        float tBest = tMidRay;
        for (int it = 0; it < altLim; it++) {
          vec3 pt = roU + tBest * rdU;
          vec2 ps, dps, ts, ns;
          float bN, zRaw;
          if (uShadowCurveMode == 1) {
            vec2 bs;
            anamorphEvalFig8(u, ps, dps, ts, ns, bs, zRaw);
            float dzR = zRaw - pA.z;
            float czS = dzR > 0.0
              ? pA.z + uShadowGap * (1.0 - exp(-dzR / max(0.05, uShadowGap)))
              : zRaw;
            float sbEst = clamp((pt.z - czS) / max(1e-5, halfDs), -1.0, 1.0);
            vec2 rxy = (ps + sbEst * dot(bs, ts) * ts) - pt.xy;
            u = clamp(u - dot(rxy, dps) / max(dot(dps, dps), 2.0), uLo, uHi);
            anamorphEvalFig8(u, ps, dps, ts, ns, bs, zRaw);
            bN = dot(bs, ns);
          } else {
            anamorphEvalTrefoil(u, pi, ps, dps, ts, ns, bN, zRaw);
            vec2 rxy = ps - pt.xy;
            u = clamp(u - dot(rxy, dps) / max(dot(dps, dps), 2.0), uLo, uHi);
            anamorphEvalTrefoil(u, pi, ps, dps, ts, ns, bN, zRaw);
          }
          float dzRaw = zRaw - pA.z;
          float cz = dzRaw > 0.0
            ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
            : zRaw;
          float kSh = bN / max(1e-5, halfDs);
          float q0n = dot(roU.xy - ps, ns);
          float q0z = roU.z - cz;
          float qdn = dot(rdU.xy, ns);
          tBest = anamorphClosestTRayBox2D(
            vec2(q0n - kSh * q0z, q0z),
            vec2(qdn - kSh * rdU.z, rdU.z),
            vec2(halfW, halfDs),
            tEnter,
            tExit
          );
        }

        float ds = fract(u - sA + 0.5) - 0.5;
        if (abs(ds) < 0.085) continue;
        vec2 ps, dps, ts, ns;
        float bT = 0.0;
        float bN = 0.0;
        float zRawBest = 0.0;
        if (uShadowCurveMode == 1) {
          vec2 bs;
          anamorphEvalFig8(u, ps, dps, ts, ns, bs, zRawBest);
          bT = dot(bs, ts);
          bN = dot(bs, ns);
        } else {
          anamorphEvalTrefoil(u, pi, ps, dps, ts, ns, bN, zRawBest);
        }
        float overGate = smoothstep(0.04, 0.28, zRawBest + halfDs - pA.z);
        if (overGate <= 1e-4) continue;

        float dzRaw = zRawBest - pA.z;
        float cz = dzRaw > 0.0
          ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
          : zRawBest;
        vec3 ptBest = roU + tBest * rdU;
        vec2 dxy = ptBest.xy - ps;
        float dz = ptBest.z - cz;
        float dt = dot(dxy, ts) - clamp(dz / max(1e-5, halfDs), -1.0, 1.0) * bT;
        float dn = dot(dxy, ns);
        float sd2 = anamorphSdShearedOct(dn, dz, bN, halfW, halfDs, chamfer);
        bool onEnd = (u <= uLo + 1e-6 && dt < 0.0) || (u >= uHi - 1e-6 && dt > 0.0);
        float sd = (onEnd && (sd2 > 0.0 || abs(dt) > 0.0))
          ? length(vec2(max(sd2, 0.0), dt))
          : sd2;

        float soft = baseSoft + penumbraSlope * tBest;
        float distFade = 1.0 - smoothstep(effReach * 0.65, effReach, tBest);
        float occ = (1.0 - smoothstep(-soft * 0.65, soft, sd)) * distFade * overGate;
        minVis = min(minVis, 1.0 - occ * receiverGate);

        float tightSoft = 0.015 + 0.095 * tBest;
        float tightFade = 1.0 - smoothstep(0.24, 0.48, tBest);
        float tightOcc = (1.0 - smoothstep(-tightSoft * 0.6, tightSoft, sd)) * tightFade * overGate;
        minTight = min(minTight, 1.0 - tightOcc * receiverGate);
      }
      return vec2(minVis, minTight);
    }

    void evalRayPrismOcc(
      vec3 p0,
      vec3 rayDir,
      float effReach,
      float maxPad,
      float baseSoft,
      float penumbraSlope,
      float receiverGate,
      vec3 r1xyz,
      vec3 r2xyz,
      vec3 r3xyz,
      vec3 b,
      vec3 c0,
      float pc00,
      vec3 c0b,
      float pc0b0,
      vec3 c1,
      float pc10,
      vec3 c1b,
      float pc1b0,
      float e1z,
      float e2z,
      float baseBlockerZ,
      float pAz,
      float isCross,
      bool forceOver,
      float kBev,
      float invBevMin,
      float protrusionGate,
      int gsLimB,
      bool wantTight,
      inout float minVis,
      inout float minTight
    ) {
      vec3 d = vec3(dot(rayDir, r1xyz), dot(rayDir, r2xyz), dot(rayDir, r3xyz));
      vec3 bPad = b + vec3(maxPad);
      vec3 invD = 1.0 / (mix(vec3(1.0), vec3(-1.0), lessThan(d, vec3(0.0))) * max(abs(d), vec3(1e-5)));
      vec3 t0s = (-bPad - p0) * invD;
      vec3 t1s = ( bPad - p0) * invD;
      vec3 tMinV = min(t0s, t1s);
      vec3 tMaxV = max(t0s, t1s);
      float tEnter = max(max(tMinV.x, tMinV.y), max(tMinV.z, 0.0));
      float tExit  = min(min(tMaxV.x, tMaxV.y), min(tMaxV.z, effReach));

      float pc0 = pc00 - maxPad;
      float dc0 = dot(rayDir, c0);
      if (abs(dc0) <= 1e-5) {
        if (pc0 > 0.0) return;
      } else if (dc0 > 0.0) {
        tExit = min(tExit, -pc0 / dc0);
      } else {
        tEnter = max(tEnter, -pc0 / dc0);
      }

      float pc0b = pc0b0 - maxPad;
      float dc0b = dot(rayDir, c0b);
      if (abs(dc0b) <= 1e-5) {
        if (pc0b > 0.0) return;
      } else if (dc0b > 0.0) {
        tExit = min(tExit, -pc0b / dc0b);
      } else {
        tEnter = max(tEnter, -pc0b / dc0b);
      }

      float pc1 = pc10 - maxPad;
      float dc1 = dot(rayDir, c1);
      if (abs(dc1) <= 1e-5) {
        if (pc1 > 0.0) return;
      } else if (dc1 > 0.0) {
        tExit = min(tExit, -pc1 / dc1);
      } else {
        tEnter = max(tEnter, -pc1 / dc1);
      }

      float pc1b = pc1b0 - maxPad;
      float dc1b = dot(rayDir, c1b);
      if (abs(dc1b) <= 1e-5) {
        if (pc1b > 0.0) return;
      } else if (dc1b > 0.0) {
        tExit = min(tExit, -pc1b / dc1b);
      } else {
        tEnter = max(tEnter, -pc1b / dc1b);
      }

      if (tExit <= tEnter) return;

      float lo = tEnter;
      float hi = tExit;
      float cB = lo + (hi - lo) * 0.38196601;
      float dB = lo + (hi - lo) * 0.61803399;
      float fcB = anamorphSdMiterPrismFast(p0 + cB * d, b, kBev, invBevMin, max(pc00 + cB * dc0, pc0b0 + cB * dc0b), max(pc10 + cB * dc1, pc1b0 + cB * dc1b));
      float fdB = anamorphSdMiterPrismFast(p0 + dB * d, b, kBev, invBevMin, max(pc00 + dB * dc0, pc0b0 + dB * dc0b), max(pc10 + dB * dc1, pc1b0 + dB * dc1b));
      for (int k = 0; k < gsLimB; k++) {
        if (fcB < fdB) {
          hi = dB;
          dB = cB;
          fdB = fcB;
          cB = lo + (hi - lo) * 0.38196601;
          fcB = anamorphSdMiterPrismFast(p0 + cB * d, b, kBev, invBevMin, max(pc00 + cB * dc0, pc0b0 + cB * dc0b), max(pc10 + cB * dc1, pc1b0 + cB * dc1b));
        } else {
          lo = cB;
          cB = dB;
          fcB = fdB;
          dB = lo + (hi - lo) * 0.61803399;
          fdB = anamorphSdMiterPrismFast(p0 + dB * d, b, kBev, invBevMin, max(pc00 + dB * dc0, pc0b0 + dB * dc0b), max(pc10 + dB * dc1, pc1b0 + dB * dc1b));
        }
      }
      float midB = 0.5 * (lo + hi);
      float fLoB = anamorphSdMiterPrismFast(p0 + lo * d, b, kBev, invBevMin, max(pc00 + lo * dc0, pc0b0 + lo * dc0b), max(pc10 + lo * dc1, pc1b0 + lo * dc1b));
      float fMidB = anamorphSdMiterPrismFast(p0 + midB * d, b, kBev, invBevMin, max(pc00 + midB * dc0, pc0b0 + midB * dc0b), max(pc10 + midB * dc1, pc1b0 + midB * dc1b));
      float fHiB = anamorphSdMiterPrismFast(p0 + hi * d, b, kBev, invBevMin, max(pc00 + hi * dc0, pc0b0 + hi * dc0b), max(pc10 + hi * dc1, pc1b0 + hi * dc1b));
      float denB = fLoB - 2.0 * fMidB + fHiB;
      float tBest = denB > 1e-7
        ? clamp(midB + 0.25 * (hi - lo) * (fLoB - fHiB) / denB, lo, hi)
        : (fcB < fdB ? cB : dB);
      vec3 pLocal = p0 + tBest * d;
      float sd = anamorphSdMiterPrismFast(pLocal, b, kBev, invBevMin, max(pc00 + tBest * dc0, pc0b0 + tBest * dc0b), max(pc10 + tBest * dc1, pc1b0 + tBest * dc1b));

      float overGate = 1.0;
      if (!forceOver && isCross > 1e-4) {
        float uCl = clamp(pLocal.x, -b.x, b.x);
        float s1Cl = clamp(pLocal.y / b.y, -1.0, 1.0);
        float s2Cl = clamp(pLocal.z / b.z, -1.0, 1.0);
        float zBlocker = baseBlockerZ + uCl * r1xyz.z + s1Cl * e1z + s2Cl * e2z;
        overGate = mix(1.0, smoothstep(0.04, 0.28, zBlocker - pAz), isCross);
        if (overGate <= 1e-4) return;
      }

      float soft = baseSoft + penumbraSlope * tBest;
      float distFade = 1.0 - smoothstep(effReach * 0.65, effReach, tBest);
      float sliverGate = uShadowSegmented == 1
        ? smoothstep(0.0, max(soft * 1.35, 0.038), b.x)
        : 1.0;
      float occ = (1.0 - smoothstep(-soft * 0.65, soft, sd)) * distFade * protrusionGate * overGate * sliverGate;
      minVis = min(minVis, 1.0 - occ * receiverGate);

      if (wantTight) {
        float tightSoft = 0.015 + 0.095 * tBest;
        float tightFade = 1.0 - smoothstep(0.24, 0.48, tBest);
        float tightSliver = uShadowSegmented == 1
          ? smoothstep(0.0, max(tightSoft * 1.35, 0.030), b.x)
          : 1.0;
        float tightOcc = (1.0 - smoothstep(-tightSoft * 0.6, tightSoft, sd)) * tightFade * protrusionGate * overGate * tightSliver;
        minTight = min(minTight, 1.0 - tightOcc * receiverGate);
      }
    }

    vec3 evalBoxShadowsFused(
      vec3 pA,
      vec3 nA,
      vec4 tagA,
      vec3 keyDir,
      float keyCrossReach,
      vec3 aoDir,
      float aoCrossReach
    ) {
      float ndlK = dot(nA, keyDir);
      float ndlA = dot(nA, aoDir);
      bool activeK = ndlK > 0.01;
      bool activeA = ndlA > 0.01;
      if (!activeK && !activeA) return vec3(1.0);

      float gateK = smoothstep(0.01, 0.18, ndlK);
      float gateA = smoothstep(0.01, 0.18, ndlA);
      vec3 ro = pA + nA * 0.015;

      int packedA = int(tagA.x + 0.5);
      int liA = packedA / 16384;
      int remSA = packedA - liA * 16384;
      bool selfCrossA = remSA >= 8192;
      int rem0A = selfCrossA ? (remSA - 8192) : remSA;
      bool hasPortalsA = rem0A >= 4096;
      int remA = hasPortalsA ? (rem0A - 4096) : rem0A;
      int numBarsA = remA / 64;
      int barIdA = remA - numBarsA * 64;
      bool isUnwoundRecA =
        !hasPortalsA && numBarsA == 0 && (barIdA == 60 || (barIdA >= 50 && barIdA <= 57));

      float sA = tagA.y;
      float zpA = tagA.z;
      float lapJumpA = tagA.w;
      float minVisK = 1.0;
      float dummyTightK = 1.0;
      float minVisA = 1.0;
      float minTightA = 1.0;
      int zero = min(uShadowBoxCount, 0);
      int gsLimB = 6 + zero;
      int fBoxLimit = min(uShadowBoxCount, 220);

      for (int i = 0; i < fBoxLimit; i++) {
        vec4 r0 = texelFetch(uShadowBoxes, ivec2(i, 0), 0);
        vec4 r4 = texelFetch(uShadowBoxes, ivec2(i, 4), 0);
        int packedB = int(r0.w + 0.5);
        int liB = packedB / 16384;
        int remSB = packedB - liB * 16384;
        bool selfCrossB = remSB >= 8192;
        int rem0B = selfCrossB ? (remSB - 8192) : remSB;
        bool hasPortalsB = rem0B >= 4096;
        int remB = hasPortalsB ? (rem0B - 4096) : rem0B;
        int numBarsB = remB / 64;
        int barIdB = remB - numBarsB * 64;

        bool sameLoop = liA == liB;
        bool isOpenB = r4.w < 0.0;
        float halfSB = abs(r4.w);

        float boxZ = r0.z;
        float dzRaw = r0.z - pA.z;
        float isCross = 1.0;
        float branchFade = 1.0;
        bool forceOver = false;

        bool isWeldBridge = (numBarsB == 0 && barIdB == 61) || (numBarsA == 0 && barIdA == 61);
        bool useBarTable =
          hasPortalsA &&
          hasPortalsB &&
          !isOpenB &&
          numBarsA > 0 &&
          numBarsB > 0 &&
          barIdA < 14 &&
          barIdB < 14 &&
          (!sameLoop || selfCrossA);

        if (useBarTable) {
          float rawDiff = r4.x - sA;
          float ds = fract(rawDiff + 0.5) - 0.5;
          if (sameLoop) {
            int dBar = abs(barIdA - barIdB);
            dBar = min(dBar, numBarsA - dBar);
            if (uShadowSegmented == 0) {
              if (dBar == 0) continue;
            } else if (abs(ds) < r4.y) {
              continue;
            }
          }
          int gA = liA * numBarsA + barIdA;
          int gB = liB * numBarsB + barIdB;
          vec4 ct = texelFetch(uShadowBoxes, ivec2(gA * 14 + gB, 10), 0);
          if (ct.w > 0.5) {
            if (ct.x < 0.5) continue;
            if (ct.x > 1.5) {
              vec4 r9 = texelFetch(uShadowBoxes, ivec2(i, 9), 0);
              float fSA = fract(sA);
              float zp0A = zpA - floor(sA + 1e-6) * lapJumpA;
              float zpBarA = (barIdA == 0 && fSA > ct.z) ? (zp0A - lapJumpA) : zp0A;
              boxZ = r9.x + zpBarA + ct.y + uShadowGap;
              isCross = 1.0;
              forceOver = true;
            } else {
              float lapDiff = floor(rawDiff - ds + 0.5);
              boxZ = r0.z - r4.z + zpA + lapDiff * lapJumpA;
              isCross = 0.0;
              if (abs(lapJumpA) > 1e-4) {
                branchFade = 1.0 - smoothstep(0.38, 0.48, abs(ds));
                if (branchFade <= 1e-4) continue;
              }
            }
          } else {
            boxZ = dzRaw > 0.0
              ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
              : r0.z;
            isCross = 1.0;
          }
        } else if (sameLoop) {
          float rawDiff = r4.x - sA;
          float ds = isOpenB ? rawDiff : (fract(rawDiff + 0.5) - 0.5);
          float lapDiff = isOpenB ? 0.0 : floor(rawDiff - ds + 0.5);
          float zUnwound = r0.z - r4.z + zpA + lapDiff * lapJumpA;
          float crossBlend = 0.0;
          if (numBarsA > 0 && numBarsB > 0) {
            int dBar = abs(barIdA - barIdB);
            dBar = min(dBar, numBarsA - dBar);
            if (uShadowSegmented == 0) {
              if (dBar == 0) continue;
            } else if (abs(ds) < r4.y) {
              continue;
            }
          } else if (isOpenB && uShadowSegmented == 0) {
            if (abs(ds) < halfSB + 0.01) continue;
          } else {
            if (abs(ds) < r4.y) continue;
            if (!isOpenB && barIdA != 62) {
              float dSpan = max(0.0, abs(ds) - halfSB);
              crossBlend = smoothstep(0.075, 0.125, dSpan);
            }
          }
          if (!isOpenB && abs(lapJumpA) > 1e-4) {
            branchFade = mix(1.0 - smoothstep(0.38, 0.48, abs(ds)), 1.0, crossBlend);
            if (branchFade <= 1e-4) continue;
          }
          float zCross = dzRaw > 0.0
            ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
            : r0.z;
          boxZ = mix(zUnwound, zCross, crossBlend);
          isCross = crossBlend;
        } else if (barIdA == 62 && barIdB == 62) {
          int cyc = liB - liA;
          if (cyc < 0) cyc += 3;
          float sb = fract(r4.x);
          bool overWeave = (cyc == 1)
            ? (sb < 0.345 || sb > 0.96)
            : (sb < 0.165 || sb > 0.94);
          if (!overWeave) continue;
          boxZ = pA.z + uShadowGap;
          isCross = 1.0;
          forceOver = true;
        } else if (
          (numBarsB == 0 && barIdB >= 1 && barIdB <= 30) ||
          (numBarsA == 0 && barIdA >= 1 && barIdA <= 30)
        ) {
          bool unwound = false;
          if (numBarsB == 0 && barIdB >= 1 && barIdB <= 30) {
            int targetB = (barIdB - 1) / 2;
            int underB = (barIdB - 1) - targetB * 2;
            if (underB == 1 || liA != targetB || abs(r4.z - zpA) <= 1e-3) unwound = true;
          }
          if (numBarsA == 0 && barIdA >= 1 && barIdA <= 30) {
            int targetA = (barIdA - 1) / 2;
            int underA = (barIdA - 1) - targetA * 2;
            if (underA == 0 || liB != targetA || abs(r4.z - zpA) <= 1e-3) unwound = true;
          }
          if (unwound) {
            boxZ = r0.z - r4.z + zpA;
            isCross = 0.0;
          } else {
            boxZ = dzRaw > 0.0
              ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
              : r0.z;
            isCross = 1.0;
          }
        } else if (isWeldBridge) {
          if (numBarsA == 0 && barIdA == 61 && numBarsB == 0 && barIdB == 61) continue;
          float bestDz = abs(dzRaw);
          if (numBarsA == 0 && barIdA == 61) {
            float z0A = (r0.z - r4.z) + zpA;
            float z1A = z0A - lapJumpA;
            float d0A = abs(z0A - pA.z);
            float d1A = abs(z1A - pA.z);
            if (d0A <= d1A) {
              boxZ = z0A;
              bestDz = d0A;
            } else {
              boxZ = z1A;
              bestDz = d1A;
            }
          } else {
            vec4 r9 = texelFetch(uShadowBoxes, ivec2(i, 9), 0);
            float z0B = (r0.z - r4.z) + zpA;
            float z1B = z0B + r9.w;
            float d0B = abs(z0B - pA.z);
            float d1B = abs(z1B - pA.z);
            if (d0B <= d1B) {
              boxZ = z0B;
              bestDz = d0B;
            } else {
              boxZ = z1B;
              bestDz = d1B;
            }
          }
          isCross = 0.0;
          branchFade = 1.0 - smoothstep(1.15, 1.75, bestDz);
          if (branchFade <= 1e-4) continue;
        } else if (
          (numBarsB == 0 && barIdB == 58) ||
          (numBarsA == 0 && barIdA == 58)
        ) {
          if (numBarsA == 0 && barIdA == 58 && numBarsB == 0 && barIdB == 58) continue;
          if (numBarsA == 0 && barIdA == 58) {
            if (barIdB != 1 && barIdB != 3) continue;
            if (barIdB == 3) {
              if (lapJumpA <= 0.0) continue;
              boxZ = r0.z + zpA;
            } else {
              if (lapJumpA >= 0.0) continue;
              boxZ = r0.z + zpA - lapJumpA;
            }
          } else {
            if (barIdA != 1 && barIdA != 3) continue;
            vec4 r9 = texelFetch(uShadowBoxes, ivec2(i, 9), 0);
            float jumpB = r9.w;
            if (barIdA == 3) {
              if (jumpB >= 0.0) continue;
              boxZ = r0.z - r4.z;
            } else {
              if (jumpB <= 0.0) continue;
              boxZ = r0.z - r4.z + jumpB;
            }
          }
          isCross = 1.0;
          forceOver = true;
        } else if (numBarsB == 0 && barIdB >= 50 && barIdB <= 57 && hasPortalsA) {
          int attachedBar = barIdB - 50;
          if (barIdA != attachedBar) continue;
          boxZ = r0.z;
          isCross = 0.0;
        } else if (hasPortalsB && isUnwoundRecA) {
          float dzUnw = (r0.z - r4.z) - pA.z;
          float crossW = smoothstep(0.9, 1.5, dzUnw);
          float zCr = dzUnw > 0.0
            ? pA.z + uShadowGap * (1.0 - exp(-dzUnw / max(0.05, uShadowGap)))
            : (r0.z - r4.z);
          boxZ = mix(r0.z - r4.z, zCr, crossW);
          isCross = crossW;
        } else if (
          (numBarsB == 0 && barIdB == 59) ||
          (numBarsA == 0 && barIdA == 59)
        ) {
          if (numBarsA == 0 && barIdA == 59 && numBarsB == 0 && barIdB == 59) continue;
          if (numBarsA == 0 && barIdA == 59) {
            if (barIdB >= 1 && barIdB <= 3) {
              boxZ = r0.z - r4.z;
              isCross = 0.0;
            } else {
              if ((liA == 1 && barIdB == 0) || (liA == 2 && barIdB == 4)) continue;
              boxZ = pA.z + uShadowGap;
              isCross = 1.0;
              forceOver = true;
            }
          } else {
            if (barIdA < 1 || barIdA > 3) continue;
            boxZ = r0.z + zpA;
            isCross = 0.0;
          }
        } else if (!hasPortalsA && !hasPortalsB) {
          boxZ = r0.z;
          isCross = 0.0;
        } else if (!hasPortalsB && hasPortalsA) {
          if (numBarsB == 0 && barIdB == 60) {
            float rawW = 0.66 - sA;
            float dsW = fract(rawW + 0.5) - 0.5;
            float lapW = abs(lapJumpA) > 1e-4 ? floor(rawW - dsW + 0.5) : 0.0;
            if (abs(lapJumpA) > 1e-4) {
              branchFade = 1.0 - smoothstep(0.38, 0.48, abs(dsW));
              if (branchFade <= 1e-4) continue;
            }
            boxZ = (r0.z - r4.z) + zpA + lapW * lapJumpA;
          } else {
            float zpA0 = zpA - floor(sA + 1e-6) * lapJumpA;
            boxZ = r0.z + zpA0;
          }
          isCross = 0.0;
        } else {
          boxZ = dzRaw > 0.0
            ? pA.z + uShadowGap * (1.0 - exp(-dzRaw / max(0.05, uShadowGap)))
            : r0.z;
          isCross = 1.0;
        }

        float baseMaxReachK = isWeldBridge
          ? 0.88
          : (sameLoop && hasPortalsA ? clamp(uShadowGap * 2.35, 0.48, 0.64) : 2.45);
        float reachK = mix(baseMaxReachK, min(2.45, keyCrossReach), isCross);
        float padK = 0.013 + 0.072 * reachK;

        float reachA = mix(0.68, min(0.68, aoCrossReach), isCross);
        float padA = 0.022 + 0.14 * reachA;

        vec4 r7 = texelFetch(uShadowBoxes, ivec2(i, 7), 0);
        vec3 boxCenter = vec3(r0.xy, boxZ);
        vec3 rel = ro - boxCenter;

        bool candK = false;
        if (activeK) {
          float tk = clamp(-dot(rel, keyDir), 0.0, reachK);
          vec3 dk = rel + tk * keyDir;
          float limK = r7.w + padK;
          candK = dot(dk, dk) < limK * limK;
        }
        bool candA = false;
        if (activeA) {
          float ta = clamp(-dot(rel, aoDir), 0.0, reachA);
          vec3 da = rel + ta * aoDir;
          float limA = r7.w + padA;
          candA = dot(da, da) < limA * limA;
        }
        if (!candK && !candA) continue;

        vec4 r1 = texelFetch(uShadowBoxes, ivec2(i, 1), 0);
        vec4 r2 = texelFetch(uShadowBoxes, ivec2(i, 2), 0);
        vec4 r3 = texelFetch(uShadowBoxes, ivec2(i, 3), 0);
        vec4 r5 = texelFetch(uShadowBoxes, ivec2(i, 5), 0);
        vec4 r6 = texelFetch(uShadowBoxes, ivec2(i, 6), 0);
        vec4 r8 = texelFetch(uShadowBoxes, ivec2(i, 8), 0);

        float capScale0 = length(r5.xyz);
        float chB = clamp(capScale0 - 1.0, 0.0, 0.48);
        vec3 c0 = capScale0 > 1e-5 ? (r5.xyz / capScale0) : -r1.xyz;
        float d0 = r5.w;
        float capScale1 = length(r6.xyz);
        vec3 c1 = capScale1 > 1e-5 ? (r6.xyz / capScale1) : r1.xyz;
        float d1 = r6.w;
        int cap3Flags = int(floor(max(0.0, (capScale1 - 1.0) * 2.0 + 0.25)));
        bool hasCap0b = (cap3Flags == 1 || cap3Flags == 3);
        bool hasCap1b = (cap3Flags >= 2);
        vec3 c0b = vec3(0.0);
        float d0b = 1e6;
        if (hasCap0b) {
          vec4 r11 = texelFetch(uShadowBoxes, ivec2(i, 11), 0);
          c0b = r11.xyz;
          d0b = r11.w;
        }
        vec3 c1b = vec3(0.0);
        float d1b = 1e6;
        if (hasCap1b) {
          vec4 r12 = texelFetch(uShadowBoxes, ivec2(i, 12), 0);
          c1b = r12.xyz;
          d1b = r12.w;
        }

        vec3 b = vec3(r1.w, r2.w, r3.w);
        vec3 e1 = r7.xyz;
        vec3 e2 = r8.xyz;

        float baseProt = dot(boxCenter - pA, nA);
        float e1n = dot(e1, nA);
        float e2n = dot(e2, nA);
        float unA = dot(r1.xyz, nA);
        float k1Oct = 1.0 - chB;
        float axialSup = b.x * abs(unA) + max(abs(e1n), abs(e2n)) + k1Oct * min(abs(e1n), abs(e2n));

        float uc0 = min(-1e-4, dot(r1.xyz, c0));
        float uN0 = unA / uc0;
        float a0p = abs(e1n - dot(e1, c0) * uN0);
        float b0p = abs(e2n - dot(e2, c0) * uN0);
        float prot0 = min(d0 * uN0 + max(a0p, b0p) + k1Oct * min(a0p, b0p), axialSup);
        if (hasCap0b) {
          float uc0b = min(-1e-4, dot(r1.xyz, c0b));
          float uN0b = unA / uc0b;
          float a0pb = abs(e1n - dot(e1, c0b) * uN0b);
          float b0pb = abs(e2n - dot(e2, c0b) * uN0b);
          prot0 = min(prot0, d0b * uN0b + max(a0pb, b0pb) + k1Oct * min(a0pb, b0pb));
        }

        float uc1 = max(1e-4, dot(r1.xyz, c1));
        float uN1 = unA / uc1;
        float a1p = abs(e1n - dot(e1, c1) * uN1);
        float b1p = abs(e2n - dot(e2, c1) * uN1);
        float prot1 = min(d1 * uN1 + max(a1p, b1p) + k1Oct * min(a1p, b1p), axialSup);
        if (hasCap1b) {
          float uc1b = max(1e-4, dot(r1.xyz, c1b));
          float uN1b = unA / uc1b;
          float a1pb = abs(e1n - dot(e1, c1b) * uN1b);
          float b1pb = abs(e2n - dot(e2, c1b) * uN1b);
          prot1 = min(prot1, d1b * uN1b + max(a1pb, b1pb) + k1Oct * min(a1pb, b1pb));
        }

        float maxProtrusion = baseProt + max(prot0, prot1);
        if (maxProtrusion <= 0.014) continue;
        float protrusionGate = smoothstep(0.014, 0.052, maxProtrusion) * branchFade;

        vec3 p0 = vec3(dot(rel, r1.xyz), dot(rel, r2.xyz), dot(rel, r3.xyz));
        float pc00 = dot(rel, c0) - d0;
        float pc0b0 = hasCap0b ? (dot(rel, c0b) - d0b) : -1e6;
        float pc10 = dot(rel, c1) - d1;
        float pc1b0 = hasCap1b ? (dot(rel, c1b) - d1b) : -1e6;
        float kBev = 2.0 - chB;
        float invBevMin = r8.w;
        float baseBlockerZ = (hasPortalsB && isUnwoundRecA) ? (r0.z - r4.z) : r0.z;

        if (candK) {
          evalRayPrismOcc(
            p0,
            keyDir,
            reachK,
            padK,
            0.013,
            0.072,
            gateK,
            r1.xyz,
            r2.xyz,
            r3.xyz,
            b,
            c0,
            pc00,
            c0b,
            pc0b0,
            c1,
            pc10,
            c1b,
            pc1b0,
            e1.z,
            e2.z,
            baseBlockerZ,
            pA.z,
            isCross,
            forceOver,
            kBev,
            invBevMin,
            protrusionGate,
            gsLimB,
            false,
            minVisK,
            dummyTightK
          );
        }

        if (candA) {
          evalRayPrismOcc(
            p0,
            aoDir,
            reachA,
            padA,
            0.022,
            0.14,
            gateA,
            r1.xyz,
            r2.xyz,
            r3.xyz,
            b,
            c0,
            pc00,
            c0b,
            pc0b0,
            c1,
            pc10,
            c1b,
            pc1b0,
            e1.z,
            e2.z,
            baseBlockerZ,
            pA.z,
            isCross,
            forceOver,
            kBev,
            invBevMin,
            protrusionGate,
            gsLimB,
            true,
            minVisA,
            minTightA
          );
        }
      }
      return vec3(minVisK, minVisA, minTightA);
    }
  `,
  surface: /* glsl */ `
    void surfaceBase(inout Surface s) {
      #ifndef PIPELINE_COLOR
      return;
      #endif
      if (uIsWireframe == 1) {
        vec2 screenUv = gl_FragCoord.xy / max(resolution, vec2(1.0));
        s.albedo = vec3(0.0);
        s.specular = 0.0;
        s.emissive = evalBackdropGradient(screenUv, resolution, uBgInner, uBgTop, uBgEdge);
        return;
      }
      if (uPainted > 0.5) paintSurface(s);
      if (uShadowStrength <= 0.001 || (uShadowBoxCount <= 0 && uShadowCurveMode == 0)) return;
      vec3 nSweet = normalize(vSweetNorm);
      vec3 keyDir = normalize(uShadowLightDir);
      float keyCrossReach = clamp(uShadowGap * 2.7, 0.52, 0.86);
      vec3 aoDir = normalize(nSweet * 0.48 + vec3(0.0, 0.0, 0.88));
      float aoCrossReach = clamp(uShadowGap * 2.1, 0.42, 0.60);

      vec3 shadRes;
      if (uShadowWasherMode == 1 || uShadowCurveMode > 0) {
        vec2 keyRes = traceSpecialShadow(vSweetPos, nSweet, vSweetTag, keyDir, 0.072, 0.013, 2.45, keyCrossReach);
        vec2 aoRes = traceSpecialShadow(vSweetPos, nSweet, vSweetTag, aoDir, 0.14, 0.022, 0.68, aoCrossReach);
        shadRes = vec3(keyRes.x, aoRes.x, aoRes.y);
      } else {
        shadRes = evalBoxShadowsFused(vSweetPos, nSweet, vSweetTag, keyDir, keyCrossReach, aoDir, aoCrossReach);
      }

      if (uPainted > 0.5) {
        s.shadow = mix(1.0, shadRes.x, uShadowStrength);
        float aoVis = mix(1.0, shadRes.y, 0.7) * mix(1.0, shadRes.z, 0.85);
        s.occlusion *= mix(1.0, aoVis, uShadowStrength);
        return;
      }
      float keyDrop = (1.0 - shadRes.x) * uShadowStrength;
      float aoSoft = (1.0 - shadRes.y) * uShadowStrength;
      float aoTight = (1.0 - shadRes.z) * uShadowStrength;

      float occVis = clamp(
        (1.0 - keyDrop * 0.85) * (1.0 - aoSoft * 0.50) * (1.0 - aoTight * 0.38),
        0.0,
        1.0
      );
      float tintMix = clamp(max(keyDrop * 0.78, aoSoft * 0.48 + aoTight * 0.34), 0.0, 1.0);

      s.albedo *= mix(vec3(1.0), uShadowTint, tintMix);
      s.occlusion *= mix(0.08, 1.0, occVis);
      s.specular *= mix(0.12, 1.0, (1.0 - keyDrop * 0.9) * (1.0 - aoTight * 0.5));
      s.roughness = mix(s.roughness, min(0.92, s.roughness + 0.16), keyDrop * 0.65);
    }

    // The exit fades the figure into the backdrop behind it: its own light goes and the backdrop's colour comes in.
    void surface(inout Surface s) {
      surfaceBase(s);
      #ifdef PIPELINE_COLOR
      if (uDissolve > 0.0) {
        float f = smoothstep(0.0, 1.0, uDissolve);
        vec2 screenUv = gl_FragCoord.xy / max(resolution, vec2(1.0));
        s.albedo *= 1.0 - f;
        s.specular *= 1.0 - f;
        s.emissive = mix(s.emissive, evalBackdropGradient(screenUv, resolution, uBgInner, uBgTop, uBgEdge), f);
      }
      #endif
    }
  `,
});
const edgeMaterial = new LineBasicMaterial({
  color: LOOKS.dark.edge,
});

const rig = new AnamorphicRig({ bodyMaterial, edgeMaterial, shadowState });
scene.add(rig.group);

onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));


onRandomize(() => {
  requestShapeChange();
  const r = Math.random;
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const snapStep = (v, step) => Math.round(v / step) * step;
  const pool = OBJECT_NAMES.filter((n) =>
    params.pool() === "segmented" ? segmentable(n) : params.pool() === "solid" ? !segmentable(n) : true,
  );
  const others = pool.filter((n) => n !== params.object());
  const nextObj = pick(others.length ? others : pool);
  params.object.set(nextObj);
  params.gap.set(snapStep(0.08 + r() * 0.14, 0.01));
  params.radius.set(snapStep(0.92 + r() * 0.22, 0.01));
  params.thickness.set(snapStep(0.34 + r() * 0.14, 0.01));
  params.splitStyle.set(pick(SPLIT_STYLES));
});

applyUrlState();

// Re-align perspective camera to initial URL-loaded FOV at startup
{
  const startDist = getPerspSweetDistance();
  perspCamera.position.set(0, 0, startDist);
  perspCamera.up.copy(SWEET_UP);
  perspCamera.lookAt(ORIGIN);
}

const resolvedStudios = {
  painted: await studios.painted,
  dark: await studios.dark,
  studio: await studios.studio,
  wireframe: await studios.wireframe,
};

const LOCK_IN = Maf.toRadians(2.5);
const LOCK_OUT = Maf.toRadians(7);
const Z_AXIS = new Vector3(0, 0, 1);
const keyDirection = new Vector3(0, 0, 1);
const _camDir = new Vector3();
const _localCam = new Vector3();
const _lockQ = new Quaternion();
const _invLockQ = new Quaternion();

let activeLook = "";
function syncLook(lookName) {
  const name = LOOKS[lookName] ? lookName : "painted";
  if (name === activeLook) return;
  activeLook = name;
  const cfg = LOOKS[name];
  if (cfg.backgroundRgb) {
    pipeline.background = new Color().setRGB(
      cfg.backgroundRgb[0],
      cfg.backgroundRgb[1],
      cfg.backgroundRgb[2],
    );
  } else {
    pipeline.background = new Color(cfg.background);
  }
  pipeline.exposure = cfg.exposure;
  pipeline.vignette = cfg.vignette;
  bodyMaterial.color.set(cfg.body);
  bodyMaterial.roughness = cfg.roughness;
  bodyMaterial.specular = cfg.specular;
  edgeMaterial.color.set(cfg.edge);
  backdropUniforms.uBgInner.value.set(...cfg.bgInner);
  backdropUniforms.uBgTop.value.set(...cfg.bgTop);
  backdropUniforms.uBgEdge.value.set(...cfg.bgEdge);
  backdropUniforms.uIsWireframe.value = name === "wireframe" ? 1 : 0;
  paintUniforms.uPainted.value = cfg.painted ? 1 : 0;
  globalUniforms.aoDirect.value = cfg.aoDirect ?? 0.65;
  shadowState.uniforms.uShadowTint.value.set(cfg.shadowTint);
  keyDirection.copy(cfg.studio.keyDirection).normalize();
  applyEnvironment(resolvedStudios[name]);
  pipeline.resetAccumulation?.();
}

syncLook(params.look());

let conveyorPhase = 0;
let activeProjection = params.projection() === "ortho" ? "ortho" : "perspective";
let lastSweetPerspDist = getPerspSweetDistance();

function syncProjectionMode() {
  const mode = params.projection() === "ortho" ? "ortho" : "perspective";
  const perspDist = getPerspSweetDistance();

  // If the user drags the FOV slider while seated at the sweet spot, keep the camera locked to the moving sweet spot!
  if (mode === "perspective" && Math.abs(perspDist - lastSweetPerspDist) > 1e-6) {
    _sweetPos.set(0, 0, lastSweetPerspDist);
    if (perspCamera.position.distanceToSquared(_sweetPos) < 2e-3 && !dragging) {
      perspCamera.position.set(0, 0, perspDist);
      perspCamera.lookAt(ORIGIN);
    }
    lastSweetPerspDist = perspDist;
  }

  if (mode !== activeProjection) {
    const prevCam = activeProjection === "perspective" ? perspCamera : orthoCamera;
    const nextCam = mode === "perspective" ? perspCamera : orthoCamera;
    const nextDist = mode === "perspective" ? perspDist : ORTHO_SWEET_DISTANCE;
    const prevSweetDist = activeProjection === "perspective" ? perspDist : ORTHO_SWEET_DISTANCE;
    const distRatio = prevCam.position.length() / Math.max(1e-4, prevSweetDist);

    _tmpDir.copy(prevCam.position);
    if (_tmpDir.lengthSq() < 1e-8) _tmpDir.set(0, 0, 1);
    else _tmpDir.normalize();

    nextCam.position.copy(_tmpDir).multiplyScalar(
      mode === "perspective" ? Maf.clamp(nextDist * distRatio, 2.0, 24) : ORTHO_SWEET_DISTANCE,
    );
    nextCam.up.copy(prevCam.up);
    if (mode === "ortho") {
      orthoCamera.zoom = Maf.clamp(1 / Math.max(0.25, distRatio), 0.45, 2.6);
      orthoCamera.updateProjectionMatrix();
    }
    nextCam.lookAt(ORIGIN);
    activeProjection = mode;
    pipeline.resetAccumulation?.();
  }

  perspControls.enabled = mode === "perspective";
  orthoControls.enabled = mode === "ortho";
  return { mode, perspDist };
}

syncProjectionMode();

function getActiveCamera() {
  return activeProjection === "perspective" ? perspCamera : orthoCamera;
}

function getActiveControls() {
  return activeProjection === "perspective" ? perspControls : orthoControls;
}

function getOffAxisState(camPos, sweetDist) {
  _sweetPos.set(0, 0, sweetDist);
  const distSq = camPos.distanceToSquared(_sweetPos);
  const relScale = sweetDist / ORTHO_SWEET_DISTANCE;
  const epsSq = 1.5e-3 * relScale * relScale;
  if (distSq <= epsSq) return { offAxis: false, offAxisBlend: 0 };
  const t = Maf.clamp((Math.sqrt(distSq) - 0.04 * relScale) / (0.85 * relScale), 0, 1);
  return { offAxis: true, offAxisBlend: t * t * (3 - 2 * t) };
}

const _loopPts = Array.from({ length: 8 }, () => new Vector3());
const _loopSample = { pos: new Vector3(), a: new Vector3(), b: new Vector3() };
const loopLengths = new WeakMap();

// Length of a loop's centre line in the sweet-view plane, so the paint pattern is scaled in world units.
function loopLength(loop) {
  let len = loopLengths.get(loop);
  if (len !== undefined) return len;
  const ring = loop.ringCount ?? 4;
  const centre = (s) => {
    if (loop.sampleCorners) {
      loop.sampleCorners(s, 0, _loopPts);
      let x = 0, y = 0;
      for (let c = 0; c < ring; c++) (x += _loopPts[c].x), (y += _loopPts[c].y);
      return [x / ring, y / ring];
    }
    loop.sample(s, 0, _loopSample);
    return [_loopSample.pos.x, _loopSample.pos.y];
  };
  len = 0;
  let prev = centre(0);
  for (let i = 1; i <= 256; i++) {
    const p = centre(Math.min(i / 256, 1 - 1e-6));
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  loopLengths.set(loop, len);
  return len;
}

// Every figure's blocks come out about blockLength * BLOCK_UNIT long on screen. Loops with corners prefer a multiple of
// their corner count (the same pattern on every beam) when that stays within 12% of the target.
const BLOCK_UNIT = 0.28;
function balanceSegments(form, blockLength) {
  const target = blockLength * BLOCK_UNIT;
  for (const loop of form.loops) {
    const len = loopLength(loop);
    if (len <= 1e-4) continue;
    const n = len / target;
    const k = loop.open ? 1 : Math.max(1, loop.corners?.length ?? 1);
    const even = k * Math.max(1, Math.round(n / k));
    const plain = Math.max(1, Math.round(n));
    loop.segments = Math.max(3, Math.abs(len / even - target) <= 0.12 * target ? even : plain);
  }
  return form;
}

function updateLoopInfo(form, isSegmented) {
  const info = paintUniforms.uLoopInfo.value;
  for (let li = 0; li < MAX_LOOPS; li++) {
    const loop = form.loops[li];
    if (!loop) {
      info[li].set(0, 0, 1, 0);
      continue;
    }
    // The paint follows the march phase even while the figure is whole, so it never jumps when the gaps open or close.
    const raw = conveyorPhase * (loop.phaseScale ?? 1) + (loop.phaseOffset ?? 0);
    const phase = raw - Math.floor(raw);
    const marching = isSegmented && !loop.open;
    info[li].set(loop.open ? 0 : phase, marching ? Math.max(1, loop.segments | 0) : 0, loopLength(loop), 0);
  }
}

let cachedForm = null;
let cachedFormKey = "";
let lastRigForm = null;
let lastRigSegmented = null;
let lastRigPhase = NaN;
let lastRigOffAxis = null;
let lastRigOffAxisBlend = NaN;
let lastRigDepthScale = NaN;
let lastRigPerspDist = NaN;
let lastRigZCompress = NaN;
let lastRigSplit = -1;

function rebuildGeometry() {
  const { mode, perspDist } = syncProjectionMode();
  const isPersp = mode === "perspective";
  const sweetDist = isPersp ? perspDist : ORTHO_SWEET_DISTANCE;
  const activeCam = isPersp ? perspCamera : orthoCamera;

  const key = OBJECTS[shapeParam("object")] ? shapeParam("object") : "ring";
  const isSegmented = params.segmented() && segmentable(key) && show.split > 0;
  const blockLengthVal = shapeParam("blockLength");
  const gapVal = shapeParam("gap");
  const radiusVal = shapeParam("radius");
  const thicknessVal = shapeParam("thickness");
  const chamferVal = shapeParam("chamfer");
  const depthScale = 1;

  const formKey = `${key}|${isSegmented ? 1 : 0}|${blockLengthVal}|${gapVal}|${radiusVal}|${thicknessVal}|${chamferVal}`;
  if (formKey !== cachedFormKey || !cachedForm) {
    cachedFormKey = formKey;
    const buildOpts = {
      segmented: isSegmented,
      segments: 11,
      gap: gapVal,
      radius: radiusVal,
      thickness: thicknessVal,
      chamfer: chamferVal,
      tilt: TILT,
      roll: ROLL,
    };
    cachedForm = balanceSegments(OBJECTS[key].build(buildOpts), blockLengthVal);
  }

  updateLoopInfo(cachedForm, isSegmented);

  // Near the sweet spot the figure turns its sightline onto the camera (and, in perspective, takes its distance), so
  // a camera a few degrees off still sees the split edge-on instead of a sliver of the front piece's side.
  const camLen = activeCam.position.length() || 1;
  _camDir.copy(activeCam.position).divideScalar(camLen);
  // Only for a hand-placed camera: the staged orbit lands exactly, and turning the figure as it glides in reads as a
  // second motion on top of the camera's.
  const camAngle = Math.acos(Maf.clamp(_camDir.z, -1, 1));
  const lock = show.drive
    ? 0
    : 1 - Maf.smoothStep(LOCK_IN, LOCK_OUT, camAngle);
  _lockQ.setFromUnitVectors(Z_AXIS, _camDir);
  rig.group.quaternion.identity().slerp(_lockQ, lock);
  _invLockQ.copy(rig.group.quaternion).invert();
  _localCam.copy(activeCam.position).applyQuaternion(_invLockQ);
  const lockedDist = isPersp ? Maf.lerp(perspDist, camLen, lock) : sweetDist;
  shadowState.uniforms.uShadowLightDir.value.copy(keyDirection).applyQuaternion(_invLockQ);

  const { offAxis, offAxisBlend } = getOffAxisState(_localCam, lockedDist);
  // Deterministic non-breathing depth compression so (D + z_s) stays strictly above minDenom across all FOV & slider bounds
  const maxExtentZ = 5.1 * depthScale * radiusVal;
  const zCompress = isPersp ? Math.min(1, (0.62 * lockedDist) / Math.max(0.5, maxExtentZ)) : 1;
  const effPerspDist = isPersp ? lockedDist : 0;
  const phaseKey = isSegmented ? conveyorPhase : 0;

  const edgesVal = params.edges();
  if (rig.showEdges !== edgesVal) {
    rig.setEdgesVisible(edgesVal);
  }
  // Shadows fade out as the exiting shape grows past the camera: unreadable there, and the trace is per pixel.
  // Shadows are cast in illusion space, so they only hold near the sweet spot: fade them out as the camera leaves it.
  const offAngle = Math.acos(Maf.clamp(_camDir.z, -1, 1));
  const shadowOnAxis = 1 - Maf.smoothStep(Maf.toRadians(3), Maf.toRadians(15), offAngle);
  shadowState.uniforms.uShadowStrength.value =
    params.look() === "wireframe"
      ? 0
      : params.shadows() * Maf.clamp((1.5 - show.scale) / 0.4, 0, 1) * shadowOnAxis;

  if (
    cachedForm !== lastRigForm ||
    isSegmented !== lastRigSegmented ||
    phaseKey !== lastRigPhase ||
    offAxis !== lastRigOffAxis ||
    offAxisBlend !== lastRigOffAxisBlend ||
    depthScale !== lastRigDepthScale ||
    effPerspDist !== lastRigPerspDist ||
    zCompress !== lastRigZCompress ||
    show.split !== lastRigSplit
  ) {
    lastRigForm = cachedForm;
    lastRigSegmented = isSegmented;
    lastRigPhase = phaseKey;
    lastRigOffAxis = offAxis;
    lastRigOffAxisBlend = offAxisBlend;
    lastRigDepthScale = depthScale;
    lastRigPerspDist = effPerspDist;
    lastRigZCompress = zCompress;
    lastRigSplit = show.split;
    rig.update(cachedForm, conveyorPhase, {
      segmented: isSegmented,
      offAxis,
      offAxisBlend,
      shadeBlend: 0,
      split: Easings.InOutSine(show.split),
      splitStyle: shapeParam("splitStyle"),
      solidOpenLoops: true,
      depthScale,
      perspDist: effPerspDist,
      zCompress,
    });
  }
}

rebuildGeometry();
await load.compile.track(pipeline.compileAsync(scene, getActiveCamera()), 3);

window.app = {
  canvas: renderer.domElement,
  params,
  pipeline,
  get camera() {
    return getActiveCamera();
  },
  get controls() {
    return getActiveControls();
  },
  perspCamera,
  orthoCamera,
  perspControls,
  orthoControls,
  resetView: snapToSweetSpot,
  snapToSweetSpot,
  setPhase(p) {
    conveyorPhase = ((p % 1) + 1) % 1;
  },
  rig,
  objectNames: OBJECT_NAMES,
  sound,
  // Recording: restart the staged entrance now, and move to a new figure ({ object, splitStyle } or random).
  restartShow() {
    show.started = false;
    show.held = null;
  },
  nextLook(pick) {
    if (!pick) return randomize();
    requestShapeChange();
    if (pick.object) params.object.set(pick.object);
    if (pick.splitStyle) params.splitStyle.set(pick.splitStyle);
  },
  show,
};

let lastWallTime = performance.now();

let soundStarted = false;
let prevOpenGaps = 0;
const _prevCamDir = new Vector3(0, 0, 1);
const _camNow = new Vector3();

render(({ time, dt }) => {
  if (!soundStarted) {
    soundStarted = true;
    sound.start();
  }
  const now = performance.now();
  const wallDt = Maf.clamp((now - lastWallTime) / 1000, 0, 0.1);
  lastWallTime = now;

  autoChange.update(dt);
  syncLook(params.look());

  const dir = params.reverse() ? -1 : 1;
  // The march belongs to the figure on screen (during a merge the panel already shows the next one), and only runs while
  // its gaps are open, so a whole figure holds still.
  if (canSegmentShown() && show.split > 0) {
    conveyorPhase = (conveyorPhase + dt * params.speed() * dir) % 1;
    if (conveyorPhase < 0) conveyorPhase += 1;
  }

  const isPersp = params.projection() !== "ortho";
  const sweetDist = isPersp ? getPerspSweetDistance() : ORTHO_SWEET_DISTANCE;
  const cam = isPersp ? perspCamera : orthoCamera;
  const ctrl = isPersp ? perspControls : orthoControls;

  updateShow(dt, sweetDist);
  rig.group.scale.setScalar(Math.max(1e-3, show.scale));
  rig.group.visible = show.scale > 1e-3 && show.dissolve < 1;
  paintUniforms.uDissolve.value = show.dissolve;
  edgeMaterial.transparent = show.dissolve > 0;
  edgeMaterial.opacity = 1 - show.dissolve;
  // A slow sway about the sightline, centred on upright, so every figure keeps its intended orientation.
  if (!dragging) show.swayT += dt;
  show.roll = Maf.toRadians(params.cameraSway()) * Math.sin((show.swayT * Math.PI * 2) / 14);

  if (snapping && !dragging) {
    const alpha = 1 - Math.exp(-wallDt * 9);
    _sweetPos.set(0, 0, sweetDist);
    if (isPersp) {
      const nextLen = Maf.lerp(cam.position.length(), sweetDist, alpha);
      cam.position.lerp(_sweetPos, alpha).setLength(nextLen);
      cam.up.lerp(SWEET_UP, alpha).normalize();
      ctrl.target.lerp(ORIGIN, alpha);
      if (cam.position.distanceToSquared(_sweetPos) < 1e-5) {
        cam.position.copy(_sweetPos);
        cam.up.copy(SWEET_UP);
        ctrl.target.copy(ORIGIN);
        ctrl.saveState();
        ctrl.reset();
        snapping = false;
      }
    } else {
      cam.position.lerp(_sweetPos, alpha).setLength(sweetDist);
      cam.up.lerp(SWEET_UP, alpha).normalize();
      ctrl.target.lerp(ORIGIN, alpha);
      orthoCamera.zoom = Maf.lerp(orthoCamera.zoom, 1, alpha);
      orthoCamera.updateProjectionMatrix();
      if (
        cam.position.distanceToSquared(_sweetPos) < 1e-5 &&
        Math.abs(orthoCamera.zoom - 1) < 1e-3
      ) {
        cam.position.copy(_sweetPos);
        cam.up.copy(SWEET_UP);
        ctrl.target.copy(ORIGIN);
        orthoCamera.zoom = 1;
        orthoCamera.updateProjectionMatrix();
        ctrl.saveState();
        ctrl.reset();
        snapping = false;
      }
    }
  }

  ctrl.update();
  // Swoosh by how fast the camera swings around the figure.
  _camNow.copy(cam.position).normalize();
  if (dt > 0) {
    const turn = Math.acos(Maf.clamp(_camNow.dot(_prevCamDir), -1, 1));
    // A cut between orbits jumps the camera: not a swing.
    const speed = turn / dt;
    sound.swoosh(speed > 20 ? 0 : speed, _camNow.x);
  } else sound.swoosh(0, 0);
  _prevCamDir.copy(_camNow);
  // The figure setting into place: once per orbit, as the camera reaches the sweet spot.
  if (show.phase === "orbit" || show.phase === "click") {
    // At 0.12° the pieces' depth offsets shift them less than a pixel: that's when they visibly lock together.
    if (!show.landed && show.drive && show.scale > 0.5 && _camNow.z > Math.cos(Maf.toRadians(0.12))) {
      show.landed = true;
      sound.land({ gain: 1 });
    }
  }
  // Rolling the camera about the sightline keeps the sweet-spot alignment and the light fixed on the shape.
  cam.rotateZ(show.roll);
  rebuildGeometry();
  // A wooden click for each gap that opens or closes, a burst when they go together.
  const openGaps = rig.openGapCount ?? 0;
  const changed = Math.min(8, Math.abs(openGaps - prevOpenGaps));
  for (let i = 0; i < changed; i++) {
    const opening = openGaps > prevOpenGaps;
    sound.split({
      gain: (opening ? 0.9 : 0.65) / Math.sqrt(changed),
      rate: opening ? 1 : 0.85,
      delay: changed > 1 ? i * 0.012 + nativeRandom() * 0.02 : 0,
      pan: nativeRandom() * 1.2 - 0.6,
    });
  }
  prevOpenGaps = openGaps;
  pipeline.render(scene, getActiveCamera(), time);
});
