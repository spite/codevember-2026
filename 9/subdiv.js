// One level of Loop subdivision as a fixed stencil, so a deforming shell can be smoothed every frame.
const cache = new WeakMap();

function loopStencil(index, count) {
  if (cache.has(index)) return cache.get(index);
  const neighbors = Array.from({ length: count }, () => new Set());
  const edgeId = new Map();
  const opposite = new Map();
  const key = (a, b) => (a < b ? a * count + b : b * count + a);
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k], b = index[t + ((k + 1) % 3)], c = index[t + ((k + 2) % 3)];
      neighbors[a].add(b);
      neighbors[b].add(a);
      const id = key(a, b);
      if (!edgeId.has(id)) {
        edgeId.set(id, count + edgeId.size);
        opposite.set(id, [a, b, c]);
      } else opposite.get(id).push(c);
    }
  }
  const total = count + edgeId.size;
  const offsets = new Uint32Array(total + 1);
  const src = [];
  const weights = [];
  for (let v = 0; v < count; v++) {
    const n = neighbors[v].size;
    const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
    src.push(v);
    weights.push(1 - n * beta);
    for (const u of neighbors[v]) {
      src.push(u);
      weights.push(beta);
    }
    offsets[v + 1] = src.length;
  }
  const edges = [...edgeId.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id, e] of edges) {
    const [a, b, c, d] = opposite.get(id);
    src.push(a, b, c, d);
    weights.push(3 / 8, 3 / 8, 1 / 8, 1 / 8);
    offsets[e + 1] = src.length;
  }
  const out = new Uint32Array((index.length / 3) * 12);
  let o = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ab = edgeId.get(key(a, b)), bc = edgeId.get(key(b, c)), ca = edgeId.get(key(c, a));
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o);
    o += 12;
  }
  const stencil = { count: total, offsets, src: Uint32Array.from(src), weights: Float32Array.from(weights), index: out };
  cache.set(index, stencil);
  return stencil;
}

// in: 3 floats per source vertex (from offset `base` vertices in), out: 3 floats per subdivided vertex.
function applyStencil(s, input, base, out) {
  const { offsets, src, weights } = s;
  for (let v = 0; v < s.count; v++) {
    let x = 0, y = 0, z = 0;
    for (let e = offsets[v], end = offsets[v + 1]; e < end; e++) {
      const k = (base + src[e]) * 3, w = weights[e];
      x += input[k] * w;
      y += input[k + 1] * w;
      z += input[k + 2] * w;
    }
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
}

function vertexNormals(pos, index, nor) {
  nor.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
    const fx = pos[c] - pos[a], fy = pos[c + 1] - pos[a + 1], fz = pos[c + 2] - pos[a + 2];
    const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  for (let i = 0; i < nor.length; i += 3) {
    const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1;
    nor[i] /= l;
    nor[i + 1] /= l;
    nor[i + 2] /= l;
  }
}

export { loopStencil, applyStencil, vertexNormals };
