// Keeps the prepared surface of the current sculpture and cuts it at whatever erosion is asked for.
import { prepare, mesh, distanceGrid } from "./hollow.js";
import { sketch } from "./previz.js";

let state = null;

self.onmessage = (e) => {
  const { id, desc, E, look } = e.data;
  try {
    if (desc.sketch) {
      const out = sketch(desc, look);
      self.postMessage({ id, key: desc.key, ...out }, [out.lines.buffer, out.sites.buffer, out.surface.buffer, out.normal.buffer, out.index.buffer]);
      return;
    }
    if (!state || state.key !== desc.key) {
      state = null;
      state = prepare(desc, (f) => self.postMessage({ id, progress: f }));
    }
    const t0 = performance.now();
    const out = mesh(state, E, look);
    out.ms = performance.now() - t0;
    const transfer = [out.position.buffer, out.normal.buffer, out.vel.buffer, out.data.buffer, out.index.buffer];
    // The open lattice's clearance, for the light to find its way through the holes.
    if (E >= 1) {
      const R = 1.35 * state.meta.radius;
      out.passGrid = distanceGrid(out.position, desc.lite ? 0.022 : 0.015, { lo: [-R, -R, -R], hi: [R, R, R] }).data;
      transfer.push(out.passGrid.D.buffer);
    }
    self.postMessage({ id, key: desc.key, ...out }, transfer);
  } catch (err) {
    self.postMessage({ id, key: desc.key, error: String(err?.stack ?? err) });
  }
};
