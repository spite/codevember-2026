// Grows an ornament and packs it for the relief shader, off the main thread.
import { SHAPES, shapeMesh } from "./shapes.js";
import { generateOrnament } from "./ornament.js";
import { packRelief } from "./pack.js";

self.onmessage = (e) => {
  const { id, shape, opts, mesh: detail } = e.data;
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
  // The blank's mesh, the first time a shape is asked for.
  const mesh = detail ? shapeMesh(shape, detail) : null;
  // A sampled blank's grid goes along with its mesh, for the main thread's focus (it never loads it itself).
  const grid = mesh && SHAPES[shape].adopt && SHAPES[shape].grid ? SHAPES[shape].grid.slice() : null;
  const transfer = [packed.prims.buffer, packed.cells.buffer, packed.list.buffer, packed.blows.buffer, activity.buffer];
  if (mesh) transfer.push(mesh.position.buffer, mesh.normal.buffer, mesh.index.buffer);
  // The primitive types in this piece: the shader is compiled with just those.
  const types = [...new Set(ornament.prims.map((p) => p.type))].sort((x, y) => x - y);
  if (grid) transfer.push(grid.buffer);
  self.postMessage({ id, shape, packed, blows, activity, mesh, types, grid }, transfer);
};
