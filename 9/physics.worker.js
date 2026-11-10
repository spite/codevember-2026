// The soft-body world, stepped off the main thread. Each "step" message carries the frame's time, settings, body
// scales and any added or removed bodies; the reply is the particles and each body's pose.
import { SoftWorld } from "./soft.js";
import { Container } from "./container.js";
import { shell } from "./bodies.js";

let world, container;
const byId = new Map();

onmessage = ({ data }) => {
  if (data.type === "init") {
    container = new Container("cube");
    world = new SoftWorld(container, { capacity: data.capacity, center: data.center });
    world.substeps = data.substeps;
    return;
  }
  if (data.shape) {
    container.from = data.shape.from;
    container.to = data.shape.to;
  }
  container.t = data.t;
  container.wall = data.wall;
  Object.assign(world, data.settings);
  world.omega = data.omega;
  for (const c of data.commands) {
    if (c.type === "add") {
      const body = world.addBody({ shell: shell(c.kind, c.detail), radius: c.radius, position: c.position, scale: c.scale, quaternion: c.quaternion, floaters: c.floaters });
      if (body) byId.set(c.id, body);
    } else {
      const body = byId.get(c.id);
      if (body) world.removeBody(body);
      byId.delete(c.id);
    }
  }
  for (const [id, scale] of data.scales) {
    const body = byId.get(id);
    if (body) body.scale = scale;
  }
  world.step(data.dt);
  const x = world.x.slice(0, world.n * 3);
  const r = world.r.slice(0, world.n);
  const bodies = [];
  for (const [id, b] of byId) bodies.push({ id, start: b.start, count: b.count, fstart: b.fstart, fcount: b.fcount, c: b.c, q: b.q, rp: b.rp, deviation: b.deviation ?? 0 });
  postMessage({ x, r, n: world.n, bodies, q: world.q, unrest: world.unrest(), dt: data.dt }, [x.buffer, r.buffer]);
};
