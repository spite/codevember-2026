// Grows an ornament and packs it for the relief shader, off the main thread.
import { SHAPES, shapeMesh } from "./shapes.js";
import { generateOrnament } from "./ornament.js";
import { packRelief } from "./pack.js";

function bounds(position) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], position[i + k]);
      max[k] = Math.max(max[k], position[i + k]);
    }
  return { min, max };
}
// The blank's signed distance on a 32^3 grid over its bounds (padded), in its own frame, from its closest-point
// projection: the fumes' obstacle.
function bakeField(shape, { min, max }) {
  const pad = 0.12 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const lo = min.map((v) => v - pad);
  const size = max.map((v, k) => v - min[k] + 2 * pad);
  const n = 32;
  const data = new Float32Array(n * n * n);
  for (let z = 0, i = 0; z < n; z++) {
    const pz = lo[2] + ((z + 0.5) / n) * size[2];
    for (let y = 0; y < n; y++) {
      const py = lo[1] + ((y + 0.5) / n) * size[1];
      for (let x = 0; x < n; x++, i++) {
        const px = lo[0] + ((x + 0.5) / n) * size[0];
        const q = shape.project(px, py, pz);
        const sd = (px - q[0]) * q[3] + (py - q[1]) * q[4] + (pz - q[2]) * q[5];
        data[i] = Number.isFinite(sd) ? sd : -1;
      }
    }
  }
  return { lo, size, data };
}

function build({ id, shape, opts, mesh: detail, field, prefetch }) {
  // The blank's mesh, the first time a shape is asked for: sent ahead, so the page can put the blank up while the
  // ornament grows.
  const mesh = detail ? shapeMesh(shape, detail) : null;
  const box = mesh && bounds(mesh.position);
  if (mesh) {
    // A sampled blank's grid goes along with its mesh, for the fumes' simulation (it never loads it itself).
    const grid = SHAPES[shape].adopt && SHAPES[shape].grid ? SHAPES[shape].grid.slice() : null;
    const transfer = [mesh.position.buffer, mesh.normal.buffer, mesh.index.buffer];
    if (grid) transfer.push(grid.buffer);
    self.postMessage({ id, kind: "mesh", prefetch, shape, mesh, grid }, transfer);
  }
  const t0 = performance.now();
  const ornament = generateOrnament(SHAPES[shape], opts);
  const packed = packRelief(SHAPES[shape], ornament);
  // How many motifs are being scribed at each point of the drawing, for the scratch's loudness.
  const activity = new Float32Array(64);
  for (const p of ornament.prims) {
    for (let i = Math.floor(p.ta * 63); i <= Math.min(63, Math.ceil(p.tb * 63)); i++) activity[i]++;
  }
  const peak = Math.max(...activity) || 1;
  for (let i = 0; i < 64; i++) activity[i] /= peak;
  const blows = ornament.blows.map(({ p, n, R, depth, t }) => ({ p, n, R, depth, t }));
  packed.ms = performance.now() - t0;
  const transfer = [packed.prims.buffer, packed.cells.buffer, packed.list.buffer, packed.blows.buffer, activity.buffer];
  // The primitive types in this piece: the shader is compiled with just those.
  const types = [...new Set(ornament.prims.map((p) => p.type))].sort((x, y) => x - y);
  self.postMessage({ id, kind: "piece", prefetch, shape, packed, blows, activity, types }, transfer);
  // The fumes' obstacle, once a shape (its mesh's bounds, which only the first build of a shape has).
  if (field && mesh && SHAPES[shape].project) {
    const f = bakeField(SHAPES[shape], box);
    self.postMessage({ id, kind: "field", prefetch, shape, field: f }, [f.data.buffer]);
  }
}

self.onmessage = (e) => {
  try {
    build(e.data);
  } catch (err) {
    self.postMessage({ id: e.data.id, prefetch: e.data.prefetch, error: String(err?.stack || err) });
  }
};
