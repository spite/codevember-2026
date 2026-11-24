// Runs the veil's simulation off the main thread. The page sends the state of the head once
// a frame, with a pair of buffers, and gets them back holding the surface to draw.
import { VeilSim, loadFields, SURFACE_SIDE } from "./veil-sim.js";
import { createTatterData } from "./tatter.js";

const SURFACE_FLOATS = SURFACE_SIDE * SURFACE_SIDE * 3;
let sim = null;
// Bumped by every drop, so the page can tell a surface from before it.
let generation = 0;
let created = null;

function sendSurface(positions, normals) {
  sim.writeSurface(positions, normals);
  postMessage({ type: "surface", positions, normals, generation }, [positions.buffer, normals.buffer]);
}

onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      // Creating the simulation drops the veil and lets it settle.
      created = loadFields(data.fields).then((fields) => {
        sim = new VeilSim(fields, data.offset);
        sendSurface(new Float32Array(SURFACE_FLOATS), new Float32Array(SURFACE_FLOATS));
      });
      await created;
      return;
    }
    // Messages sent before the fields are in wait for them, in order.
    await created;
    if (data.type === "update") {
      sim.draft = data.draft;
      sim.loose = data.loose;
      sim.update(data.dt, data.gravity, data.jawMatrix, data.jawInverse, data.delta);
      sendSurface(data.positions, data.normals);
    } else if (data.type === "tatter") {
      generation = data.generation;
      if (data.tattered) {
        const maps = createTatterData(data.seed);
        postMessage({ type: "tatter", seed: data.seed, ...maps }, [maps.outline.buffer, maps.dirt.buffer]);
      }
      sim.setTattered(data.tattered, data.seed);
    } else if (data.type === "reset") {
      generation = data.generation;
      sim.reset();
    }
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
