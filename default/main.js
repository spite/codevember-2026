// Template for a new day: copy default/ to N/. It has every shared mechanic a day needs; see CLAUDE.md.
import { fromDefaults, renderer, camera, controls, render, onResize, onRandomize, applyUrlState, keysHelp, setDay, showHint, loadingStep } from "common";
import { GUI } from "guspira";
import { Scene, Mesh, Vector3, TorusKnotGeometry } from "three";
import { Pipeline } from "modules/pipeline/Pipeline.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { createStudioEnvironmentAsync } from "modules/pipeline/studio.js";
import { createAutoChange } from "modules/autoChange.js";

const BACKGROUND = 0xe9e7e3;

const defaults = {
  color: "#c8553d",
  roughness: 0.3,
  metalness: 0,
  spin: 0.3,
  auto: true,
  autoTime: 10,
};
const params = fromDefaults(defaults);
// Load progress: declare every step up front (weights roughly by how long each takes).
const load = { studio: loadingStep(1), compile: loadingStep(4) };

const pipeline = new Pipeline(renderer, {
  background: BACKGROUND,
  exposure: 1,
  bloomStrength: 0.03,
  vignette: 0.15,
  grain: 0.02,
  shadow: { autoFit: true, denoise: true },
});
const studio = load.studio.track(
  createStudioEnvironmentAsync(renderer, { keyDirection: new Vector3(-0.5, 1, 0.3), keyIntensity: 8, keySize: 0.6, fill: 0.4, floor: 0.3, wall: 0.5 }),
);

const gui = new GUI(setDay(), document.querySelector("#gui-container"), { expanded: false });
gui.addColor("Color", params.color);
gui.addSlider("Roughness", params.roughness, 0, 1, 0.01);
gui.addSlider("Metalness", params.metalness, 0, 1, 0.01);
gui.addSlider("Spin", params.spin, 0, 1, 0.01, { randomizable: false });
const autoChange = createAutoChange({ enabled: params.auto, every: params.autoTime, gui });
pipeline.addGUI(gui);
gui.addSeparator();
gui.addText(keysHelp());
showHint("Drag to orbit · scroll to zoom · R for a new one", "Drag to orbit · tap {randomize} for a new one");
gui.show();

const scene = new Scene();
const material = new PipelineMaterial({ color: params.color(), roughness: params.roughness(), metalness: params.metalness() });
const mesh = new Mesh(new TorusKnotGeometry(1, 0.35, 256, 64), material);
scene.add(mesh);

camera.position.set(0, 0.5, 7);
controls.target.set(0, 0, 0);
onResize((w, h, dpr) => pipeline.setSize(w, h, dpr));

onRandomize(() => gui.randomizeAll());
// The url's seed and params before the first build, so it is the one asked for.
applyUrlState();

await studio;
await load.compile.track(pipeline.compileAsync(scene, camera), 4);

// A handle for recording tools (the social-video skill) and the console.
window.app = { canvas: renderer.domElement, params, pipeline, camera, controls };

render(({ time, dt }) => {
  autoChange.update(dt);
  material.color.set(params.color());
  material.roughness = params.roughness();
  material.metalness = params.metalness();
  mesh.rotation.y += dt * params.spin();
  controls.update();
  pipeline.render(scene, camera, time);
});
