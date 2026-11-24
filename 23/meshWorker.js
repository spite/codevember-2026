import { buildMeshData } from "./meshData.js";

self.onmessage = (e) => {
  const { id, opts } = e.data;
  const m = buildMeshData(opts);
  const buffers = [m.positions, m.normals, m.uvs, m.tangents, m.tileBounds, m.cellTexels, m.indices, m.sdf, m.heat, m.emitters, m.flow].filter(Boolean).map((a) => a.buffer);
  self.postMessage({ id, m }, buffers);
};
