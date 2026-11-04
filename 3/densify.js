import { BufferGeometry, BufferAttribute } from "three";

// One 1:4 split with PN-triangle edge midpoints, shared per edge so the mesh stays watertight. Every other
// float attribute (ao, rim, ...) is averaged at the midpoints; normals are averaged and renormalised.
export function densify(geometry) {
  const pos = geometry.attributes.position.array;
  const nrm = geometry.attributes.normal.array;
  const index = geometry.index.array;
  const nv = pos.length / 3;
  const nf = index.length / 3;

  const edgeId = new Map();
  const edges = [];
  const mid = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < 3; k++) {
      const a = index[f * 3 + k], b = index[f * 3 + ((k + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      let id = edgeId.get(key);
      if (id === undefined) {
        id = nv + edges.length / 2;
        edgeId.set(key, id);
        edges.push(a, b);
      }
      mid[f * 3 + k] = id;
    }

  const total = nv + edges.length / 2;
  const P = new Float32Array(total * 3);
  const N = new Float32Array(total * 3);
  P.set(pos);
  N.set(nrm);
  for (let e = 0; e < edges.length / 2; e++) {
    const i = edges[e * 2], j = edges[e * 2 + 1], o = (nv + e) * 3;
    const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
    const wij = dx * nrm[i * 3] + dy * nrm[i * 3 + 1] + dz * nrm[i * 3 + 2];
    const wji = -(dx * nrm[j * 3] + dy * nrm[j * 3 + 1] + dz * nrm[j * 3 + 2]);
    let l = 0;
    for (let c = 0; c < 3; c++) {
      // Cubic PN edge at t = 1/2.
      P[o + c] = 0.5 * (pos[i * 3 + c] + pos[j * 3 + c]) - 0.125 * (wij * nrm[i * 3 + c] + wji * nrm[j * 3 + c]);
      N[o + c] = nrm[i * 3 + c] + nrm[j * 3 + c];
      l += N[o + c] * N[o + c];
    }
    l = 1 / Math.sqrt(Math.max(l, 1e-20));
    for (let c = 0; c < 3; c++) N[o + c] *= l;
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(P, 3));
  out.setAttribute("normal", new BufferAttribute(N, 3));
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    if (name === "position" || name === "normal" || name === "uv") continue;
    const s = attr.itemSize, src = attr.array;
    const dst = new Float32Array(total * s);
    dst.set(src);
    for (let e = 0; e < edges.length / 2; e++) {
      const i = edges[e * 2], j = edges[e * 2 + 1];
      for (let c = 0; c < s; c++) dst[(nv + e) * s + c] = 0.5 * (src[i * s + c] + src[j * s + c]);
    }
    out.setAttribute(name, new BufferAttribute(dst, s));
  }

  const Index = total > 65535 ? Uint32Array : Uint16Array;
  const idx = new Index(nf * 12);
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3], b = index[f * 3 + 1], c = index[f * 3 + 2];
    const ab = mid[f * 3], bc = mid[f * 3 + 1], ca = mid[f * 3 + 2];
    idx.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], f * 12);
  }
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}
