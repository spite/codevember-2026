// The main thread's view of the soft-body world in physics.worker.js: the same shape as SoftWorld for what the page
// reads (particles, bodies with their pose, the container's rotation), one step behind. step() sends the frame's
// changes when the worker is free; frames that arrive while it is busy add up into the next step.
import { rotate, SoftWorld } from "./soft.js";

const SETTINGS = ["volumeCompliance", "shapeStiffness", "edgeCompliance", "bending", "gravity", "damping", "skin"];

class PhysicsClient {
  constructor(container, { capacity, center, substeps }) {
    this.container = container;
    this.center = center;
    this.q = [0, 0, 0, 1];
    this.omega = [0, 0, 0];
    this.x = new Float32Array(0);
    this.r = new Float32Array(0);
    this.n = 0;
    this.bodies = [];
    this.byId = new Map();
    this.nextId = 0;
    this.commands = [];
    this.pending = 0;
    this.busy = false;
    // Counts states received; stepDt is the time the last one covered, for anything that differentiates positions.
    this.version = 0;
    this.stepDt = 0;
    this.last = { speed: 0, deviation: 0 };
    this.sentShape = null;
    for (const k of SETTINGS) this[k] = 0;
    this.worker = new Worker(new URL("./physics.worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this.receive(e.data);
    this.worker.postMessage({ type: "init", capacity, center, substeps });
  }

  addBody({ shell, radius, position, scale, quaternion, floaters, data }) {
    const id = this.nextId++;
    const body = { id, shell, radius, scale, floaters, data, c: [...position], q: [...quaternion], rp: 0, deviation: 0, alive: true, start: -1, count: 0, fstart: -1, fcount: 0 };
    this.bodies.push(body);
    this.byId.set(id, body);
    this.commands.push({ type: "add", id, kind: shell.kind, detail: shell.detail, radius, position, scale, quaternion, floaters: floaters.map((f) => ({ radius: f.radius, mass: f.mass })) });
    return body;
  }

  removeBody(body) {
    body.alive = false;
    this.bodies.splice(this.bodies.indexOf(body), 1);
    this.byId.delete(body.id);
    this.commands.push({ type: "remove", id: body.id });
  }

  step(dt) {
    this.pending += dt;
    if (this.busy || (this.pending <= 0 && !this.commands.length)) return;
    const c = this.container;
    const shapeChanged = this.sentShape?.from !== c.from || this.sentShape?.to !== c.to;
    const settings = {};
    for (const k of SETTINGS) settings[k] = this[k];
    this.worker.postMessage({
      type: "step",
      dt: Math.min(this.pending, 1 / 20),
      omega: [...this.omega],
      settings,
      shape: shapeChanged ? { from: c.from, to: c.to } : null,
      t: c.t,
      wall: c.wall,
      commands: this.commands,
      scales: this.bodies.map((b) => [b.id, b.scale]),
    });
    if (shapeChanged) this.sentShape = { from: c.from, to: c.to };
    this.commands = [];
    this.pending = 0;
    this.busy = true;
  }

  receive(state) {
    this.busy = false;
    this.x = state.x;
    this.r = state.r;
    this.n = state.n;
    this.q = state.q;
    this.last = state.unrest;
    for (const b of this.bodies) b.start = -1;
    for (const s of state.bodies) {
      const b = this.byId.get(s.id);
      if (!b) continue;
      Object.assign(b, s);
    }
    this.version++;
    this.stepDt = state.dt;
  }

  unrest() {
    return this.last;
  }

  toWorld(lx, ly, lz) {
    const p = rotate(this.q, lx, ly, lz);
    return [p[0] + this.center[0], p[1] + this.center[1], p[2] + this.center[2]];
  }
}

// The same world stepped on the main thread, in step with the page's clock: for recordings, whose virtual time a
// worker can't follow frame by frame.
class LocalPhysics extends SoftWorld {
  constructor(container, { capacity, center, substeps }) {
    super(container, { capacity, center });
    this.substeps = substeps;
    this.version = 0;
    this.stepDt = 0;
  }

  step(dt) {
    if (dt <= 0) return;
    super.step(dt);
    this.version++;
    this.stepDt = dt;
  }
}

export { PhysicsClient, LocalPhysics };
