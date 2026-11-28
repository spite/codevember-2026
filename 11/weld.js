// Per vertex, for the rust: a normal smoothed across creases (vertices welded by position; displacing along it keeps
// the mesh closed, and blending to it rounds edges), and how concave the surface is there (grime gathers in it).
// Plain arrays in and out, so the machine worker can do it too.
export function weldAttributes(P, N, I) {
  const nv = P.length / 3;
  // Welded by position rounded to 1e-5, through an open-addressing table of the rounded integers (no string keys).
  const weld = new Int32Array(nv), Q = new Int32Array(nv * 3);
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1), first = new Int32Array(nv);
  let nw = 0;
  for (let v = 0; v < nv; v++) {
    const x = (Q[3 * v] = Math.round(P[3 * v] * 1e5)), y = (Q[3 * v + 1] = Math.round(P[3 * v + 1] * 1e5)), z = (Q[3 * v + 2] = Math.round(P[3 * v + 2] * 1e5));
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const w = table[h];
      if (w < 0) {
        table[h] = nw;
        first[nw] = v;
        weld[v] = nw++;
        break;
      }
      const f = 3 * first[w];
      if (Q[f] === x && Q[f + 1] === y && Q[f + 2] === z) {
        weld[v] = w;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }
  const S = new Float32Array(nw * 3);
  for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) S[3 * weld[v] + c] += N[3 * v + c];
  for (let w = 0; w < nw; w++) {
    const l = Math.hypot(S[3 * w], S[3 * w + 1], S[3 * w + 2]) || 1;
    S[3 * w] /= l, S[3 * w + 1] /= l, S[3 * w + 2] /= l;
  }
  // Concavity: neighbours rising above the vertex's tangent plane, as the sine of the angle, averaged over its edges.
  const sum = new Float32Array(nw), cnt = new Float32Array(nw);
  for (let t = 0; t < I.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const dx = P[3 * b] - P[3 * a], dy = P[3 * b + 1] - P[3 * a + 1], dz = P[3 * b + 2] - P[3 * a + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) continue;
      const wa = weld[a], wb = weld[b];
      sum[wa] += (S[3 * wa] * dx + S[3 * wa + 1] * dy + S[3 * wa + 2] * dz) / l, cnt[wa]++;
      sum[wb] -= (S[3 * wb] * dx + S[3 * wb + 1] * dy + S[3 * wb + 2] * dz) / l, cnt[wb]++;
    }
  const smooth = new Float32Array(nv * 3), cav = new Float32Array(nv), vex = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const w = weld[v], k = sum[w] / Math.max(cnt[w], 1);
    smooth.set(S.subarray(3 * w, 3 * w + 3), 3 * v);
    cav[v] = Math.max(0, Math.min(1, k * 8));
    vex[v] = Math.max(0, Math.min(1, -k * 4));
  }
  return { smooth, cav, vex };
}
