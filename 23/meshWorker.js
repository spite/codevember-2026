import { buildMeshData, setSuzanne } from "./meshData.js";

self.onmessage = (e) => {
  const { id, opts, suzanne } = e.data;
  if (suzanne) {
    const m = setSuzanne(suzanne);
    self.postMessage({ id, m }, Object.values(m).map((a) => a.buffer));
    return;
  }
  const m = buildMeshData(opts);
  const buffers = [m.positions, m.normals, m.uvs, m.dispUvs, m.tangents, m.tileBounds, m.cellTexels, m.indices, m.sdf, m.heat, m.emitters, m.flow].filter(Boolean).map((a) => a.buffer);
  self.postMessage({ id, m }, buffers);
};
