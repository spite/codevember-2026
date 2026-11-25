// Runs the veil's simulation off the main thread. The page sends the state of the head once
// a frame, with a pair of buffers, and gets them back holding the surface to draw.
// Imported with the worker's own query, so a new page load never runs a cached copy (see Veil). The handler is set
// at once and waits for them, so no message is lost while they load.
const modules = Promise.all([import(`./veil-sim.js${self.location.search}`)]);
let VeilSim, loadFields, SURFACE_SIDE;

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
      // Creating the simulation drops the veil and lets it settle. Set before any await, so later messages wait on it.
      created = modules
        .then(([simModule]) => {
          ({ VeilSim, loadFields, SURFACE_SIDE } = simModule);
          return loadFields(data.fields);
        })
        .then((fields) => {
          sim = new VeilSim(fields, data.offset);
          sendSurface(new Float32Array(SURFACE_SIDE * SURFACE_SIDE * 3), new Float32Array(SURFACE_SIDE * SURFACE_SIDE * 3));
        });
      await created;
      return;
    }
    // Messages sent before the fields are in wait for them, in order.
    await created;
    if (data.type === "update") {
      sim.draft = data.draft;
      sim.loose = data.loose;
      sim.wind = data.wind;
      sim.update(data.dt, data.gravity, data.jawMatrix, data.jawInverse, data.delta);
      sendSurface(data.positions, data.normals);
    } else if (data.type === "tatter") {
      generation = data.generation;
      sim.dropTilt = [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3];
      sim.setTattered(data.tattered, data.seed, data.live);
    } else if (data.type === "reset") {
      generation = data.generation;
      sim.dropTilt = [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3];
      sim.reset(data.live);
    } else if (data.type === "release") {
      sim.release();
    }
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
};
