// Per-vertex room for outward displacement before neighbouring normals converge and the surface folds: the smallest
// concave radius along the vertex's edges, spread and eased over a few rings. Large where the surface is convex.
export function clearance(geometry, { spread = 2, ease = 3, max = 4 } = {}) {
  const p = geometry.attributes.position.array;
  const n = geometry.attributes.normal.array;
  const index = geometry.index.array;
  const nv = p.length / 3;
  let R = new Float32Array(nv).fill(max);
  const raw = R;
  const edges = [];
  for (let t = 0; t < index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const i = index[t + k], j = index[t + ((k + 1) % 3)];
      if (i < j) edges.push(i, j);
      let d2 = 0, kn = 0;
      for (let c = 0; c < 3; c++) {
        const dx = p[j * 3 + c] - p[i * 3 + c];
        d2 += dx * dx;
        kn += (n[j * 3 + c] - n[i * 3 + c]) * dx;
      }
      // Normal curvature along the edge; negative where the surface is concave.
      if (kn < 0 && d2 > 0) {
        const r = -d2 / kn;
        if (r < R[i]) R[i] = r;
        if (r < R[j]) R[j] = r;
      }
    }
  R = R.slice();
  let next = new Float32Array(nv);
  for (let it = 0; it < spread; it++) {
    next.set(R);
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e], j = edges[e + 1];
      if (R[j] < next[i]) next[i] = R[j];
      if (R[i] < next[j]) next[j] = R[i];
    }
    [R, next] = [next, R];
  }
  const cnt = new Float32Array(nv);
  for (let it = 0; it < ease; it++) {
    next.set(R);
    cnt.fill(1);
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e], j = edges[e + 1];
      next[i] += R[j];
      next[j] += R[i];
      cnt[i]++;
      cnt[j]++;
    }
    for (let i = 0; i < nv; i++) next[i] /= cnt[i];
    [R, next] = [next, R];
  }
  // Easing never lifts a vertex above its own limit.
  for (let i = 0; i < nv; i++) R[i] = Math.min(R[i], raw[i]);
  return R;
}
