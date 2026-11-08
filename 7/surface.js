// Base surfaces as indexed triangle meshes, fair enough for a glossy glaze. Parametric sheets are evaluated on a
// (u, v) grid spaced by arc length, cut cleanly along their clip lines, and welded at seams and poles. Implicit
// surfaces are meshed by sparse surface nets, relaxed, and projected back onto the field with Newton steps.
// Normals come from the parametrisation or the field gradient. A non-orientable sheet is cut along a seam into
// vertex copies with consistent normals; the copies of a seam vertex keep identical data.

const lerp = (a, b, t) => a + (b - a) * t;

class Buf {
  constructor(Type, n = 1 << 14) {
    this.T = Type;
    this.a = new Type(n);
    this.n = 0;
  }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2;
    while (m < this.n + k) m *= 2;
    const b = new this.T(m);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push(x) {
    if (this.n >= this.a.length) this.reserve(1);
    this.a[this.n++] = x;
  }
  push3(x, y, z) {
    this.reserve(3);
    const a = this.a, n = this.n;
    a[n] = x; a[n + 1] = y; a[n + 2] = z;
    this.n = n + 3;
  }
  get view() { return this.a.subarray(0, this.n); }
  slice() { return this.a.slice(0, this.n); }
}

// Binary min-heap of (key, value) with lazy deletion.
class Heap {
  constructor(n = 1024) {
    this.k = new Float64Array(n);
    this.v = new Int32Array(n);
    this.n = 0;
  }
  push(key, val) {
    if (this.n >= this.k.length) {
      const k = new Float64Array(this.k.length * 2), v = new Int32Array(this.k.length * 2);
      k.set(this.k); v.set(this.v);
      this.k = k; this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p];
      i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const val = V[0];
    this.key = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c];
        i = c;
      }
      K[i] = key; V[i] = v;
    }
    return val;
  }
}

// ---------- parametric sheets ----------

// Parameter values along one axis, spaced so the longest step across the patch is about h.
function spacing(d, h, maxN, a0, a1) {
  const C = d.length;
  let total = 0;
  for (let i = 0; i < C; i++) total += d[i];
  const floor = (0.03 * total) / C;
  const c = new Float64Array(C + 1);
  for (let i = 0; i < C; i++) c[i + 1] = c[i] + Math.max(d[i], floor);
  total = c[C];
  const n = Math.max(8, Math.min(maxN, Math.ceil(total / h)));
  const out = new Float64Array(n + 1);
  let i = 0;
  for (let k = 0; k <= n; k++) {
    const target = (total * k) / n;
    while (i < C - 1 && c[i + 1] < target) i++;
    const f = (target - c[i]) / Math.max(c[i + 1] - c[i], 1e-12);
    out[k] = a0 + ((a1 - a0) * (i + Math.min(1, Math.max(0, f)))) / C;
  }
  out[0] = a0;
  out[n] = a1;
  return out;
}

const finite = (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

// One patch: rows of constant v, each sampled along u by its own length (so a pole or a short row isn't oversampled)
// and zipped to the next row. Positions, stencils (fn a step along u and along v, for the normal once warped),
// triangles, and the row-end vertices that may weld to others. Triangles crossing clip = 0 are cut in (u, v).
// The axis whose rows vary most in length is taken as u.
function paramPatch(part0, h, out, maxN = 1000) {
  const C = 64;
  const sampleCoarse = (part) => {
    const { fn, clip } = part, [u0, u1] = part.u, [v0, v1] = part.v;
    const g = new Array((C + 1) * (C + 1));
    for (let j = 0; j <= C; j++)
      for (let i = 0; i <= C; i++) {
        const u = lerp(u0, u1, i / C), v = lerp(v0, v1, j / C);
        const p = clip && clip(u, v) >= 0 ? null : fn(u, v);
        g[j * (C + 1) + i] = finite(p) ? p : null;
      }
    return g;
  };
  const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0);
  let part = part0, coarse = sampleCoarse(part);
  // Row lengths along u (per v line) and column lengths along v (per u line).
  const lengths = (g) => {
    const rowLen = new Float64Array(C + 1), colLen = new Float64Array(C + 1);
    for (let j = 0; j <= C; j++) for (let i = 0; i < C; i++) rowLen[j] += dist(g[j * (C + 1) + i], g[j * (C + 1) + i + 1]);
    for (let i = 0; i <= C; i++) for (let j = 0; j < C; j++) colLen[i] += dist(g[j * (C + 1) + i], g[(j + 1) * (C + 1) + i]);
    return { rowLen, colLen };
  };
  let { rowLen, colLen } = lengths(coarse);
  const spread = (L) => { let mx = 0, mn = Infinity; for (const x of L) if (x > 0) { mx = Math.max(mx, x); mn = Math.min(mn, x); } return mx / Math.max(mn, mx * 1e-3); };
  if (spread(colLen) > 1.5 * spread(rowLen)) {
    const { fn, clip } = part0;
    part = { fn: (u, v) => fn(v, u), clip: clip ? (u, v) => clip(v, u) : null, split: part0.split ? (u, v) => part0.split(v, u) : null, u: part0.v, v: part0.u };
    coarse = sampleCoarse(part);
    ({ rowLen, colLen } = lengths(coarse));
  }
  const { fn, clip, split } = part;
  const [u0, u1] = part.u, [v0, v1] = part.v;
  // Densities along u (max over rows, normalised per row) and along v (max over columns).
  const du = new Float64Array(C), dv = new Float64Array(C);
  for (let j = 0; j <= C; j++) {
    if (!(rowLen[j] > 0)) continue;
    for (let i = 0; i < C; i++) du[i] = Math.max(du[i], dist(coarse[j * (C + 1) + i], coarse[j * (C + 1) + i + 1]) / rowLen[j]);
  }
  for (let j = 0; j < C; j++)
    for (let i = 0; i <= C; i++) dv[j] = Math.max(dv[j], dist(coarse[j * (C + 1) + i], coarse[(j + 1) * (C + 1) + i]));
  const vs = spacing(dv, h, maxN, v0, v1);
  const nv = vs.length - 1;
  // u positions for n steps, following the u density.
  const cu = new Float64Array(C + 1);
  {
    let tot = 0;
    for (let i = 0; i < C; i++) tot += du[i];
    const floor = (0.03 * tot) / C;
    for (let i = 0; i < C; i++) cu[i + 1] = cu[i] + Math.max(du[i], floor);
  }
  const uAt = (n) => {
    const outU = new Float64Array(n + 1);
    let i = 0;
    for (let k = 0; k <= n; k++) {
      const target = (cu[C] * k) / n;
      while (i < C - 1 && cu[i + 1] < target) i++;
      const f = (target - cu[i]) / Math.max(cu[i + 1] - cu[i], 1e-12);
      outU[k] = u0 + ((u1 - u0) * (i + Math.min(1, Math.max(0, f)))) / C;
    }
    outU[0] = u0;
    outU[n] = u1;
    return outU;
  };
  // Each row's length, measured on the row itself.
  const rows = [];
  let M = 0;
  for (let j = 0; j <= nv; j++) {
    const v = vs[j];
    // Visible length, and the share of the u samples that land on the visible part.
    let len = 0, prev = null, frac = 0;
    for (let i = 0; i <= C; i++) {
      const u = lerp(u0, u1, i / C);
      const p = clip && clip(u, v) >= 0 ? null : fn(u, v);
      const q = finite(p) ? p : null;
      if (prev && q) {
        len += dist(prev, q);
        frac += (cu[i] - cu[i - 1]) / cu[C];
      }
      prev = q;
    }
    const n = Math.max(4, Math.min(maxN, Math.ceil((len * 1.03) / (h * Math.max(frac, 0.02)))));
    rows.push({ us: uAt(n), start: M });
    M += n + 1;
  }
  const U = new Float64Array(M), Vv = new Float64Array(M), G = new Float64Array(M * 3), Q = new Float64Array(M), ok = new Uint8Array(M), edge = new Uint8Array(M);
  for (let j = 0; j <= nv; j++) {
    const { us, start } = rows[j], n = us.length - 1;
    for (let i = 0; i <= n; i++) {
      const k = start + i, u = us[i], v = vs[j];
      U[k] = u; Vv[k] = v;
      edge[k] = i === 0 || i === n || j === 0 || j === nv ? 1 : 0;
      Q[k] = clip ? clip(u, v) : -1;
      if (Q[k] >= 0) continue;
      const p = fn(u, v);
      if (!finite(p)) continue;
      G[k * 3] = p[0]; G[k * 3 + 1] = p[1]; G[k * 3 + 2] = p[2];
      ok[k] = 1;
    }
  }
  const eu = (u1 - u0) * 2e-5, ev = (v1 - v0) * 2e-5;
  const ids = new Int32Array(M).fill(-1);
  const P = out.P, S = out.S;
  const UV = new Map();
  const addVertex = (u, v, p, isEdge) => {
    const id = P.n / 3;
    if (split) UV.set(id, [u, v]);
    P.push3(p[0], p[1], p[2]);
    // Forward (or, at the far edge, backward) steps: the normal's sign is settled later from the triangles.
    const ub = u + eu <= u1 ? u + eu : u - eu, vb = v + ev <= v1 ? v + ev : v - ev;
    for (const q of [fn(ub, v), fn(u, vb)]) {
      if (finite(q)) S.push3(q[0], q[1], q[2]);
      else S.push3(NaN, NaN, NaN);
    }
    out.cand.push(isEdge ? 1 : 0);
    return id;
  };
  const gridVertex = (k) => {
    if (ids[k] < 0) ids[k] = addVertex(U[k], Vv[k], [G[k * 3], G[k * 3 + 1], G[k * 3 + 2]], edge[k]);
    return ids[k];
  };
  const cuts = new Map();
  const cutVertex = (ka, kb) => {
    const key = ka < kb ? ka * M + kb : kb * M + ka;
    if (cuts.has(key)) return cuts.get(key);
    // A cut right next to an inside sample uses the sample, so the cut leaves no slivers.
    const kin = Q[ka] < 0 ? ka : kb, kout = kin === ka ? kb : ka;
    if (Q[kin] / (Q[kin] - Q[kout]) < 0.2 && ok[kin]) {
      const id = gridVertex(kin);
      cuts.set(key, id);
      return id;
    }
    const ua = U[ka], va = Vv[ka], ub = U[kb], vb = Vv[kb];
    let t0 = 0, t1 = 1, q0 = Q[ka], q1 = Q[kb];
    let t = q0 / (q0 - q1);
    for (let it = 0; it < 3; it++) {
      const q = clip(lerp(ua, ub, t), lerp(va, vb, t));
      if (q < 0 === q0 < 0) { t0 = t; q0 = q; } else { t1 = t; q1 = q; }
      t = t0 + ((t1 - t0) * q0) / (q0 - q1);
    }
    const u = lerp(ua, ub, t), v = lerp(va, vb, t), p = fn(u, v);
    const id = finite(p) ? addVertex(u, v, p, false) : -1;
    cuts.set(key, id);
    return id;
  };
  const T = out.T;
  const fan = (pv) => { for (let m = 1; m + 1 < pv.length; m++) T.push3(pv[0], pv[m], pv[m + 1]); };
  // With a split, polygons are also cut along split = 0, keeping both sides; the points on it may weld to another
  // patch's (where two sheets of a Riemann surface cross over).
  const splits = new Map();
  const splitVertex = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (splits.has(key)) return splits.get(key);
    const [ua, va] = UV.get(a), [ub, vb] = UV.get(b);
    let t0 = 0, t1 = 1, q0 = split(ua, va), q1 = split(ub, vb);
    let t = q0 / (q0 - q1);
    for (let it = 0; it < 8; it++) {
      const q = split(lerp(ua, ub, t), lerp(va, vb, t));
      if (q < 0 === q0 < 0) { t0 = t; q0 = q; } else { t1 = t; q1 = q; }
      t = t0 + ((t1 - t0) * q0) / (q0 - q1);
    }
    const u = lerp(ua, ub, t), v = lerp(va, vb, t), p = fn(u, v);
    const id = finite(p) ? addVertex(u, v, p, true) : -1;
    splits.set(key, id);
    return id;
  };
  const face = (pv) => {
    if (!split) return fan(pv);
    const q = pv.map((id) => { const [u, v] = UV.get(id); return split(u, v); });
    if (q.every((x) => x < 0) || q.every((x) => x >= 0)) return fan(pv);
    const lo = [], hi = [];
    for (let m = 0; m < pv.length; m++) {
      const n = (m + 1) % pv.length;
      (q[m] < 0 ? lo : hi).push(pv[m]);
      if (q[m] < 0 !== q[n] < 0) {
        const c = splitVertex(pv[m], pv[n]);
        if (c < 0) return;
        lo.push(c);
        hi.push(c);
      }
    }
    fan(lo);
    fan(hi);
  };
  const tri = (ka, kb, kc) => {
    const ia = Q[ka] < 0, ib = Q[kb] < 0, ic = Q[kc] < 0;
    if (ia && ib && ic) {
      if (ok[ka] && ok[kb] && ok[kc]) face([gridVertex(ka), gridVertex(kb), gridVertex(kc)]);
      return;
    }
    if (!ia && !ib && !ic) return;
    const ks = [ka, kb, kc], poly = [];
    for (let m = 0; m < 3; m++) {
      const k1 = ks[m], k2 = ks[(m + 1) % 3], in1 = Q[k1] < 0, in2 = Q[k2] < 0;
      if (in1) {
        if (!ok[k1]) return;
        poly.push(gridVertex(k1));
      }
      if (in1 !== in2) {
        const c = cutVertex(k1, k2);
        if (c < 0) return;
        poly.push(c);
      }
    }
    const pv = poly.filter((x, i) => x !== poly[(i + 1) % poly.length]);
    face(pv);
  };
  const d2 = (a, b) => (ok[a] && ok[b] ? (G[a * 3] - G[b * 3]) ** 2 + (G[a * 3 + 1] - G[b * 3 + 1]) ** 2 + (G[a * 3 + 2] - G[b * 3 + 2]) ** 2 : Infinity);
  // Zips row j to row j + 1, advancing along whichever row keeps the new diagonal shorter.
  for (let j = 0; j < nv; j++) {
    const A = rows[j], B = rows[j + 1];
    const na = A.us.length - 1, nb = B.us.length - 1;
    let i = 0, k = 0;
    while (i < na || k < nb) {
      const a = A.start + i, b = B.start + k;
      let stepA;
      if (i >= na) stepA = false;
      else if (k >= nb) stepA = true;
      else {
        const ta = A.us[i + 1], tb = B.us[k + 1];
        const da = d2(a + 1, b), db = d2(a, b + 1);
        stepA = da === db ? ta <= tb : da < db;
      }
      if (stepA) { tri(a, a + 1, b); i++; }
      else { tri(a, b + 1, b); k++; }
    }
  }
}


// All patches of a sheet, with grid-edge vertices welded where they coincide (seams, poles).
function paramMesh(parts, h) {
  const out = { P: new Buf(Float64Array), S: new Buf(Float64Array), T: new Buf(Uint32Array), cand: new Buf(Uint8Array) };
  for (const part of parts) paramPatch(part, h, out);
  const P = out.P.slice(), S = out.S.slice(), T = out.T.slice(), cand = out.cand.slice();
  const nv = P.length / 3;
  let ext = 0;
  for (let i = 0; i < P.length; i++) ext = Math.max(ext, Math.abs(P[i]));
  const w = weld(P, T, cand, ext * 2e-5);
  const m = manifold(w.P, w.T);
  return { P: m.P, S: compactStencil(compactStencil(S, w.keep), m.keep), T: m.T };
}

// Splits where sheets only touch: an edge shared by 4+ triangles (two sheets crossing along a welded line) pairs
// them opposite each other around it, so each sheet carries straight on; vertices are copied per connected fan.
function manifold(P, T) {
  const nv = P.length / 3;
  const E = edgesOf(T, nv);
  const rep = new Int32Array(T.length).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) x = rep[x] = rep[rep[x]]; return x; };
  const corner = (t, v) => t * 3 + (T[t * 3] === v ? 0 : T[t * 3 + 1] === v ? 1 : 2);
  const join = (t, u, a, b) => {
    for (const v of [a, b]) {
      const x = find(corner(t, v)), y = find(corner(u, v));
      if (x !== y) rep[x] = y;
    }
  };
  const many = new Map();
  for (let h = 0; h < T.length; h++) {
    const id = E.triEdge[h];
    if (E.nt[id] <= 2) continue;
    if (!many.has(id)) many.set(id, []);
    many.get(id).push((h / 3) | 0);
  }
  for (let id = 0; id < E.count; id++) if (E.nt[id] === 2) join(E.t0[id], E.t1[id], E.a[id], E.b[id]);
  for (const [id, tris] of many) {
    if (tris.length % 2) continue;
    const a = E.a[id], b = E.b[id];
    const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    const d = [dx / dl, dy / dl, dz / dl];
    const e1 = Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [-d[2], 0, d[0]];
    const l1 = Math.hypot(...e1);
    for (let k = 0; k < 3; k++) e1[k] /= l1;
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const ang = tris.map((t) => {
      const c = T[t * 3] !== a && T[t * 3] !== b ? T[t * 3] : T[t * 3 + 1] !== a && T[t * 3 + 1] !== b ? T[t * 3 + 1] : T[t * 3 + 2];
      const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
      return { t, a: Math.atan2(wx * e2[0] + wy * e2[1] + wz * e2[2], wx * e1[0] + wy * e1[1] + wz * e1[2]) };
    }).sort((x, y) => x.a - y.a);
    const half = ang.length / 2;
    for (let i = 0; i < half; i++) join(ang[i].t, ang[i + half].t, a, b);
  }
  const copy = new Int32Array(T.length).fill(-1);
  const keep = [];
  const Tn = new Uint32Array(T.length);
  for (let h = 0; h < T.length; h++) {
    const r = find(h);
    if (copy[r] < 0) { copy[r] = keep.length; keep.push(T[h]); }
    Tn[h] = copy[r];
  }
  const Pn = new Float64Array(keep.length * 3);
  keep.forEach((v, i) => { Pn[i * 3] = P[v * 3]; Pn[i * 3 + 1] = P[v * 3 + 1]; Pn[i * 3 + 2] = P[v * 3 + 2]; });
  return { P: Pn, T: Tn, keep: Int32Array.from(keep) };
}

function compactStencil(S, keep) {
  const out = new Float64Array(keep.length * 6);
  for (let i = 0; i < keep.length; i++) out.set(S.subarray(keep[i] * 6, keep[i] * 6 + 6), i * 6);
  return out;
}

// Welds candidate vertices closer than tol, drops degenerate triangles and unused vertices.
function weld(P, T, cand, tol) {
  const nv = P.length / 3;
  const rep = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) x = rep[x] = rep[rep[x]]; return x; };
  const list = [];
  for (let i = 0; i < nv; i++) if (cand[i]) list.push(i);
  list.sort((a, b) => P[a * 3] - P[b * 3]);
  for (let m = 0; m < list.length; m++) {
    const a = list[m];
    for (let q = m + 1; q < list.length; q++) {
      const b = list[q];
      if (P[b * 3] - P[a * 3] > tol) break;
      if (Math.abs(P[a * 3 + 1] - P[b * 3 + 1]) <= tol && Math.abs(P[a * 3 + 2] - P[b * 3 + 2]) <= tol) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) rep[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const Tn = new Buf(Uint32Array, T.length);
  for (let t = 0; t < T.length; t += 3) {
    const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]);
    if (a === b || b === c || a === c) continue;
    Tn.push3(a, b, c);
  }
  return compact(P, Tn.slice());
}

// Drops unused vertices; keep[i] is the old index of new vertex i.
function compact(P, T) {
  const nv = P.length / 3;
  const map = new Int32Array(nv).fill(-1);
  const keep = [];
  for (let t = 0; t < T.length; t++) {
    const v = T[t];
    if (map[v] < 0) { map[v] = keep.length; keep.push(v); }
  }
  const Pn = new Float64Array(keep.length * 3);
  keep.forEach((v, i) => { Pn[i * 3] = P[v * 3]; Pn[i * 3 + 1] = P[v * 3 + 1]; Pn[i * 3 + 2] = P[v * 3 + 2]; });
  const Tn = new Uint32Array(T.length);
  for (let t = 0; t < T.length; t++) Tn[t] = map[T[t]];
  return { P: Pn, T: Tn, keep: Int32Array.from(keep) };
}


// Removes edges shorter than `short` by moving one end onto the other (half-edge collapse), so every vertex left is
// one of the exact samples. A collapse is skipped if it would fold a triangle, make an edge longer than `long`,
// pinch the mesh (link condition), or pull a vertex off an open edge. Returns the kept vertex indices too.
function decimate(P, T, short, long, passes = 3) {
  const nv = P.length / 3;
  let Tc = T.slice();
  const fn = (t, out, moved = -1, to = -1) => {
    const a = (Tc[t * 3] === moved ? to : Tc[t * 3]) * 3, b = (Tc[t * 3 + 1] === moved ? to : Tc[t * 3 + 1]) * 3, c = (Tc[t * 3 + 2] === moved ? to : Tc[t * 3 + 2]) * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return out;
  };
  const n0 = new Float64Array(3), n1 = new Float64Array(3);
  const mark = new Int32Array(nv), ringA = new Int32Array(4096), ringB = new Int32Array(4096);
  let stamp = 0;
  const short2 = short * short, long2 = long * long;
  for (let pass = 0; pass < passes; pass++) {
    const E = edgesOf(Tc, nv);
    // Vertex -> triangles.
    const vs = new Uint32Array(nv + 1);
    for (let i = 0; i < Tc.length; i++) vs[Tc[i] + 1]++;
    for (let v = 0; v < nv; v++) vs[v + 1] += vs[v];
    const vt = new Uint32Array(Tc.length), fill = vs.slice(0, nv);
    for (let i = 0; i < Tc.length; i++) vt[fill[Tc[i]]++] = (i / 3) | 0;
    const onBnd = new Uint8Array(nv);
    for (let e = 0; e < E.count; e++) if (E.nt[e] !== 2) onBnd[E.a[e]] = onBnd[E.b[e]] = 1;
    // Short edges, shortest first (bucketed).
    const NB = 32, bucket = new Uint8Array(E.count), cnt = new Uint32Array(NB + 1);
    let nShort = 0;
    for (let e = 0; e < E.count; e++) {
      const a = E.a[e] * 3, b = E.b[e] * 3;
      const l2 = (P[a] - P[b]) ** 2 + (P[a + 1] - P[b + 1]) ** 2 + (P[a + 2] - P[b + 2]) ** 2;
      if (l2 >= short2) { bucket[e] = 255; continue; }
      bucket[e] = Math.min(NB - 1, Math.floor((Math.sqrt(l2 / short2)) * NB));
      cnt[bucket[e] + 1]++;
      nShort++;
    }
    if (!nShort) break;
    for (let k = 0; k < NB; k++) cnt[k + 1] += cnt[k];
    const order = new Uint32Array(nShort);
    for (let e = 0; e < E.count; e++) if (bucket[e] !== 255) order[cnt[bucket[e]]++] = e;
    const lock = new Uint8Array(nv);
    // Rings gathered with stamps rather than sets.
    const ringOf = (v, buf) => {
      stamp++;
      let n = 0;
      for (let i = vs[v]; i < vs[v + 1]; i++) {
        const t = vt[i] * 3;
        for (let k = 0; k < 3; k++) {
          const x = Tc[t + k];
          if (x !== v && mark[x] !== stamp) { mark[x] = stamp; buf[n++] = x; }
        }
      }
      return n;
    };
    let done = 0;
    const tryCollapse = (from, to, e) => {
      if (onBnd[from] && (!onBnd[to] || E.nt[e] !== 1)) return false;
      const nb = ringOf(to, ringB);
      const sb = stamp;
      const na = ringOf(from, ringA);
      let common = 0;
      for (let i = 0; i < nb; i++) if (mark[ringB[i]] === stamp) common++;
      if (common !== E.nt[e]) return false;
      const tx = P[to * 3], ty = P[to * 3 + 1], tz = P[to * 3 + 2];
      for (let i = 0; i < na; i++) {
        const x = ringA[i] * 3;
        if ((P[x] - tx) ** 2 + (P[x + 1] - ty) ** 2 + (P[x + 2] - tz) ** 2 > long2) return false;
      }
      for (let i = vs[from]; i < vs[from + 1]; i++) {
        const t = vt[i];
        if (Tc[t * 3] === to || Tc[t * 3 + 1] === to || Tc[t * 3 + 2] === to) continue;
        fn(t, n0);
        fn(t, n1, from, to);
        const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
        if (!(l1 > 0) || n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0.5 * l0 * l1) return false;
      }
      return sb >= 0;
    };
    for (const e of order) {
      const a = E.a[e], b = E.b[e];
      if (lock[a] || lock[b]) continue;
      let from = -1, to = -1;
      if (tryCollapse(b, a, e)) { from = b; to = a; }
      else if (tryCollapse(a, b, e)) { from = a; to = b; }
      if (from < 0) continue;
      lock[from] = lock[to] = 1;
      const na = ringOf(from, ringA);
      for (let i = 0; i < na; i++) lock[ringA[i]] = 1;
      const nb = ringOf(to, ringB);
      for (let i = 0; i < nb; i++) lock[ringB[i]] = 1;
      done++;
      for (let i = vs[from]; i < vs[from + 1]; i++) {
        const t = vt[i];
        for (let k = 0; k < 3; k++) if (Tc[t * 3 + k] === from) Tc[t * 3 + k] = to;
      }
    }
    const Tn = new Buf(Uint32Array, Tc.length);
    for (let t = 0; t < Tc.length; t += 3) {
      const a = Tc[t], b = Tc[t + 1], c = Tc[t + 2];
      if (a !== b && b !== c && a !== c) Tn.push3(a, b, c);
    }
    Tc = Tn.slice();
    if (done < nv * 0.002) break;
  }
  return compact(P, Tc);
}

// ---------- implicit surfaces ----------

// Gradient of f at p by forward differences (f0 = f(p)).
function gradient(f, x, y, z, f0, e, out) {
  out[0] = (f(x + e, y, z) - f0) / e;
  out[1] = (f(x, y + e, z) - f0) / e;
  out[2] = (f(x, y, z + e) - f0) / e;
  return out;
}

// Surface nets of f = 0 over a box at cell size h, sampled finely only near the surface (found on a 4x coarser
// grid), then relaxed along the surface and projected onto it. Keeps the largest connected piece and any at least
// `keep` of its size. Triangles face along the gradient (outward for a field negative inside). With an offset, meshes
// f / |∇f| + offset = 0 instead: the surface inset by about that much.
function implicitMesh(f, lo, hi, h, { keep = Infinity, relax = 2, onProgress = null, offset = null } = {}) {
  const SC = 4;
  const nc = [0, 1, 2].map((a) => Math.max(2, Math.ceil((hi[a] - lo[a]) / (h * SC))));
  const [nx, ny, nz] = nc.map((c) => c * SC + 1);
  const NXY = nx * ny;
  const [cx, cy, cz] = nc, cnx = cx + 1, cny = cy + 1;
  const Cv = new Float32Array(cnx * cny * (cz + 1));
  for (let k = 0, o = 0; k <= cz; k++)
    for (let j = 0; j <= cy; j++)
      for (let i = 0; i <= cx; i++, o++) {
        const v = f(lo[0] + i * SC * h, lo[1] + j * SC * h, lo[2] + k * SC * h);
        Cv[o] = Number.isFinite(v) ? v : 1e3;
      }
  if (offset !== null) normalise(Cv, cnx, cny, cz + 1, SC * h, offset);
  // A coarse cell is near the surface if its corners change sign or its smallest value is within reach of the
  // steepest slope along its edges.
  const act = new Uint8Array(cx * cy * cz);
  const reach = SC * h * 1.8;
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const o = i + cnx * (j + cny * k);
        const c = [Cv[o], Cv[o + 1], Cv[o + cnx], Cv[o + cnx + 1], Cv[o + cnx * cny], Cv[o + cnx * cny + 1], Cv[o + cnx * cny + cnx], Cv[o + cnx * cny + cnx + 1]];
        let neg = 0, mn = Infinity, slope = 0;
        for (let m = 0; m < 8; m++) {
          if (c[m] < 0) neg++;
          mn = Math.min(mn, Math.abs(c[m]));
          for (let b = 1; b <= 4; b <<= 1) if (!(m & b)) slope = Math.max(slope, Math.abs(c[m] - c[m | b]));
        }
        if ((neg > 0 && neg < 8) || mn < (slope / (SC * h)) * reach) act[i + cx * (j + cy * k)] = 1;
      }
  const act2 = new Uint8Array(act.length);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        if (!act[i + cx * (j + cy * k)]) continue;
        for (let c = Math.max(0, k - 1); c <= Math.min(cz - 1, k + 1); c++)
          for (let b = Math.max(0, j - 1); b <= Math.min(cy - 1, j + 1); b++)
            for (let a = Math.max(0, i - 1); a <= Math.min(cx - 1, i + 1); a++) act2[a + cx * (b + cy * c)] = 1;
      }
  const F = new Float32Array(NXY * nz).fill(NaN);
  const blocks = [];
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) if (act2[i + cx * (j + cy * k)]) blocks.push(i, j, k);
  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * SC, j0 = blocks[b + 1] * SC, k0 = blocks[b + 2] * SC;
    for (let k = k0; k <= k0 + SC; k++)
      for (let j = j0; j <= j0 + SC; j++)
        for (let i = i0; i <= i0 + SC; i++) {
          const o = i + nx * j + NXY * k;
          if (F[o] === F[o]) continue;
          const v = f(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
          F[o] = Number.isFinite(v) ? v : 1e3;
        }
  }
  if (offset !== null) normalise(F, nx, ny, nz, h, offset);
  onProgress?.(0.5);
  const CX = nx - 1, CXY = (nx - 1) * (ny - 1);
  const cellVert = new Int32Array(CXY * (nz - 1)).fill(-1);
  const P = new Buf(Float64Array);
  const corner = [0, 1, nx, nx + 1, NXY, NXY + 1, NXY + nx, NXY + nx + 1];
  const c8 = new Float64Array(8);
  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * SC, j0 = blocks[b + 1] * SC, k0 = blocks[b + 2] * SC;
    for (let k = k0; k < k0 + SC; k++)
      for (let j = j0; j < j0 + SC; j++)
        for (let i = i0; i < i0 + SC; i++) {
          const o = i + nx * j + NXY * k;
          let neg = 0, bad = false;
          for (let m = 0; m < 8; m++) {
            const v = F[o + corner[m]];
            if (v !== v) { bad = true; break; }
            c8[m] = v;
            if (v < 0) neg++;
          }
          if (bad || neg === 0 || neg === 8) continue;
          let x = 0, y = 0, z = 0, n = 0;
          for (let m = 0; m < 8; m++)
            for (let bit = 1; bit <= 4; bit <<= 1) {
              if (m & bit || c8[m] < 0 === c8[m | bit] < 0) continue;
              const t = c8[m] / (c8[m] - c8[m | bit]);
              x += (m & 1) + (bit === 1 ? t : 0);
              y += ((m >> 1) & 1) + (bit === 2 ? t : 0);
              z += (m >> 2) + (bit === 4 ? t : 0);
              n++;
            }
          cellVert[i + CX * j + CXY * k] = P.n / 3;
          P.push3(lo[0] + (i + x / n) * h, lo[1] + (j + y / n) * h, lo[2] + (k + z / n) * h);
        }
  }
  const T = new Buf(Uint32Array);
  const Pv = P.view;
  const dd = (a, b) => (Pv[a * 3] - Pv[b * 3]) ** 2 + (Pv[a * 3 + 1] - Pv[b * 3 + 1]) ** 2 + (Pv[a * 3 + 2] - Pv[b * 3 + 2]) ** 2;
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    if (dd(a, c) <= dd(b, d)) { T.push3(a, b, c); T.push3(a, c, d); }
    else { T.push3(a, b, d); T.push3(b, c, d); }
  };
  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * SC, j0 = blocks[b + 1] * SC, k0 = blocks[b + 2] * SC;
    for (let k = k0; k < k0 + SC; k++)
      for (let j = j0; j < j0 + SC; j++)
        for (let i = i0; i < i0 + SC; i++) {
          if (i < 1 || j < 1 || k < 1) continue;
          const o = i + nx * j + NXY * k;
          const v0 = F[o];
          if (v0 !== v0) continue;
          const c0 = i + CX * j + CXY * k;
          const s0 = v0 < 0;
          const fx = F[o + 1], fy = F[o + nx], fz = F[o + NXY];
          if (fx === fx && fx < 0 !== s0) quad(cellVert[c0 - CX - CXY], cellVert[c0 - CXY], cellVert[c0], cellVert[c0 - CX], !s0);
          if (fy === fy && fy < 0 !== s0) quad(cellVert[c0 - 1 - CXY], cellVert[c0 - 1], cellVert[c0], cellVert[c0 - CXY], !s0);
          if (fz === fz && fz < 0 !== s0) quad(cellVert[c0 - 1 - CX], cellVert[c0 - CX], cellVert[c0], cellVert[c0 - 1], !s0);
        }
  }
  let mesh = keepComponents(P.slice(), T.slice(), keep);
  onProgress?.(0.7);

  // Tangential relaxation, projected back with the sampled field.
  const sample = (x, y, z) => {
    let fx = (x - lo[0]) / h, fy = (y - lo[1]) / h, fz = (z - lo[2]) / h;
    fx = Math.min(nx - 1.001, Math.max(0, fx)); fy = Math.min(ny - 1.001, Math.max(0, fy)); fz = Math.min(nz - 1.001, Math.max(0, fz));
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
    const o = i + nx * j + NXY * k;
    const a = F[o], b = F[o + 1], c = F[o + nx], d = F[o + nx + 1], e = F[o + NXY], g = F[o + NXY + 1], q = F[o + NXY + nx], r = F[o + NXY + nx + 1];
    const a0 = a + (b - a) * tx, a1 = c + (d - c) * tx, a2 = e + (g - e) * tx, a3 = q + (r - q) * tx;
    const b0 = a0 + (a1 - a0) * ty, b1 = a2 + (a3 - a2) * ty;
    return b0 + (b1 - b0) * tz;
  };
  const { P: MP, T: MT } = mesh;
  const nv = MP.length / 3;
  const adj = adjacency(MT, nv);
  const g = new Float64Array(3);
  const next = new Float64Array(MP.length);
  for (let r = 0; r < relax; r++) {
    for (let v = 0; v < nv; v++) {
      const x = MP[v * 3], y = MP[v * 3 + 1], z = MP[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      const e0 = adj.start[v], e1 = adj.start[v + 1];
      for (let e = e0; e < e1; e++) { const u = adj.list[e] * 3; sx += MP[u]; sy += MP[u + 1]; sz += MP[u + 2]; }
      const n = e1 - e0;
      const f0 = sample(x, y, z);
      const ex = 0.5 * h;
      g[0] = sample(x + ex, y, z) - sample(x - ex, y, z);
      g[1] = sample(x, y + ex, z) - sample(x, y - ex, z);
      g[2] = sample(x, y, z + ex) - sample(x, y, z - ex);
      const gl = Math.hypot(g[0], g[1], g[2]);
      if (!n || !(gl > 0) || f0 !== f0) { next[v * 3] = x; next[v * 3 + 1] = y; next[v * 3 + 2] = z; continue; }
      g[0] /= gl; g[1] /= gl; g[2] /= gl;
      let dx = sx / n - x, dy = sy / n - y, dz = sz / n - z;
      const dn = dx * g[0] + dy * g[1] + dz * g[2];
      dx = (dx - dn * g[0]) * 0.5; dy = (dy - dn * g[1]) * 0.5; dz = (dz - dn * g[2]) * 0.5;
      const px = x + dx, py = y + dy, pz = z + dz;
      const f1 = sample(px, py, pz);
      const step = Math.max(-0.5 * h, Math.min(0.5 * h, f1 / (gl / h)));
      next[v * 3] = px - step * g[0]; next[v * 3 + 1] = py - step * g[1]; next[v * 3 + 2] = pz - step * g[2];
    }
    MP.set(next);
  }

  // Newton steps on the field itself; the last gradient is the normal.
  const N = new Float64Array(MP.length);
  const e = h * 0.01;
  for (let v = 0; v < nv; v++) {
    let x = MP[v * 3], y = MP[v * 3 + 1], z = MP[v * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const f0 = f(x, y, z);
      gradient(f, x, y, z, f0, e, g);
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (!(gg > 1e-20)) break;
      let k = offset === null ? f0 / gg : (f0 / Math.sqrt(gg) + offset) / Math.sqrt(gg);
      const len = Math.abs(k) * Math.sqrt(gg);
      if (len > 0.6 * h) k *= (0.6 * h) / len;
      x -= k * g[0]; y -= k * g[1]; z -= k * g[2];
    }
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    MP[v * 3] = x; MP[v * 3 + 1] = y; MP[v * 3 + 2] = z;
    N[v * 3] = g[0] / gl; N[v * 3 + 1] = g[1] / gl; N[v * 3 + 2] = g[2] / gl;
  }
  return { P: MP, T: MT, N };
}


// In place: v / |∇v| + offset on a grid (central differences, one-sided at the edges and next to unsampled nodes).
function normalise(F, nx, ny, nz, h, offset) {
  const NXY = nx * ny, out = new Float32Array(F.length);
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        const v = F[o];
        if (v !== v) { out[o] = NaN; continue; }
        const d = (a, b, step) => {
          const p = b ? F[o + step] : NaN, m = a ? F[o - step] : NaN;
          if (p === p && m === m) return (p - m) / (2 * h);
          if (p === p) return (p - v) / h;
          if (m === m) return (v - m) / h;
          return 0;
        };
        const gx = d(i > 0, i < nx - 1, 1), gy = d(j > 0, j < ny - 1, nx), gz = d(k > 0, k < nz - 1, NXY);
        const gl = Math.hypot(gx, gy, gz);
        out[o] = gl > 1e-12 ? v / gl + offset : v > 0 ? 1e3 : -1e3;
      }
  F.set(out);
}

// Keeps the largest connected piece (by triangles) and any at least `keep` of its size.
function keepComponents(P, T, keep = Infinity) {
  const nv = P.length / 3;
  const rep = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) x = rep[x] = rep[rep[x]]; return x; };
  for (let t = 0; t < T.length; t += 3) {
    const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]);
    rep[b] = a;
    rep[find(c)] = a;
  }
  const size = new Uint32Array(nv);
  for (let t = 0; t < T.length; t += 3) size[find(T[t])]++;
  let max = 0;
  for (let v = 0; v < nv; v++) max = Math.max(max, size[v]);
  const Tn = new Buf(Uint32Array, T.length);
  for (let t = 0; t < T.length; t += 3) {
    const s = size[find(T[t])];
    if (s === max || s >= keep * max) Tn.push3(T[t], T[t + 1], T[t + 2]);
  }
  return compact(P, Tn.slice());
}

// ---------- topology ----------

// Vertex adjacency (CSR, each neighbour once).
function adjacency(T, nv) {
  const edges = edgesOf(T, nv);
  const cnt = new Uint32Array(nv + 1);
  for (let e = 0; e < edges.count; e++) { cnt[edges.a[e] + 1]++; cnt[edges.b[e] + 1]++; }
  for (let v = 0; v < nv; v++) cnt[v + 1] += cnt[v];
  const list = new Uint32Array(cnt[nv]);
  const fill = cnt.slice(0, nv);
  for (let e = 0; e < edges.count; e++) {
    list[fill[edges.a[e]]++] = edges.b[e];
    list[fill[edges.b[e]]++] = edges.a[e];
  }
  return { start: cnt, list, edges };
}

// Unique edges: endpoints (a < b), up to two triangles each (t0, t1; -1 if none; nt counts all), and the edge of
// every triangle side (side e of triangle t joins corners e and e + 1).
function edgesOf(T, nv) {
  const nt = T.length / 3;
  const cnt = new Uint32Array(nv + 1);
  for (let h = 0; h < T.length; h++) {
    const a = T[h], b = T[h % 3 === 2 ? h - 2 : h + 1];
    cnt[Math.min(a, b) + 1]++;
  }
  for (let v = 0; v < nv; v++) cnt[v + 1] += cnt[v];
  const hb = new Uint32Array(T.length), hh = new Uint32Array(T.length);
  const fill = cnt.slice(0, nv);
  for (let h = 0; h < T.length; h++) {
    const a = T[h], b = T[h % 3 === 2 ? h - 2 : h + 1];
    const lo = Math.min(a, b), p = fill[lo]++;
    hb[p] = Math.max(a, b);
    hh[p] = h;
  }
  const triEdge = new Int32Array(T.length);
  const A = new Buf(Uint32Array, T.length / 2 + 16), B = new Buf(Uint32Array, T.length / 2 + 16);
  const T0 = new Buf(Int32Array, T.length / 2 + 16), T1 = new Buf(Int32Array, T.length / 2 + 16), NT = new Buf(Uint8Array, T.length / 2 + 16);
  for (let v = 0; v < nv; v++) {
    const s = cnt[v], e = cnt[v + 1];
    for (let p = s; p < e; p++) {
      if (hb[p] === 0xffffffff) continue;
      const b = hb[p], id = A.n;
      A.push(v); B.push(b); T0.push((hh[p] / 3) | 0); T1.push(-1);
      let n = 1;
      triEdge[hh[p]] = id;
      for (let q = p + 1; q < e; q++) {
        if (hb[q] !== b) continue;
        hb[q] = 0xffffffff;
        triEdge[hh[q]] = id;
        if (n === 1) T1.a[id] = (hh[q] / 3) | 0;
        n++;
      }
      NT.push(Math.min(n, 255));
    }
  }
  // Side e of triangle t: triEdge is indexed by half-edge h = 3t + e.
  return { count: A.n, a: A.slice(), b: B.slice(), t0: T0.slice(), t1: T1.slice(), nt: NT.slice(), triEdge, nTri: nt };
}

// Winds every triangle consistently with its neighbours; where it can't (a non-orientable sheet), the edge becomes
// a seam and the vertices on it are split, one copy per side. Returns the new triangles, canon (the welded vertex of
// every copy) and the welded edges that are true boundaries (one triangle).
function orient(T, nv) {
  const nt = T.length / 3;
  const E = edgesOf(T, nv);
  const flip = new Uint8Array(nt), seen = new Uint8Array(nt), seam = new Uint8Array(E.count);
  const dir = (t, a) => {
    // +1 if a comes before its successor in t's winding.
    const c = T[t * 3] === a ? 0 : T[t * 3 + 1] === a ? 1 : 2;
    return c;
  };
  const sameDir = (t, u, a, b) => {
    // Does edge a->b run the same way in t and in u (as currently wound)?
    const ca = dir(t, a), cb = dir(t, b);
    let ft = (cb - ca + 3) % 3 === 1;
    if (flip[t]) ft = !ft;
    const ua = dir(u, a), ub = dir(u, b);
    let fu = (ub - ua + 3) % 3 === 1;
    if (flip[u]) fu = !fu;
    return ft === fu;
  };
  const stack = new Int32Array(nt);
  for (let s = 0; s < nt; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    let top = 0;
    stack[top++] = s;
    while (top) {
      const t = stack[--top];
      for (let e = 0; e < 3; e++) {
        const id = E.triEdge[t * 3 + e];
        if (E.nt[id] !== 2) continue;
        const u = E.t0[id] === t ? E.t1[id] : E.t0[id];
        if (u === t) continue;
        const a = E.a[id], b = E.b[id];
        if (!seen[u]) {
          seen[u] = 1;
          if (sameDir(t, u, a, b)) flip[u] = 1;
          stack[top++] = u;
        } else if (sameDir(t, u, a, b)) seam[id] = 1;
      }
    }
  }
  // Corners joined across every consistent manifold edge share a vertex copy.
  const rep = new Int32Array(T.length).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) x = rep[x] = rep[rep[x]]; return x; };
  const cornerOf = (t, v) => t * 3 + dir(t, v);
  for (let id = 0; id < E.count; id++) {
    if (E.nt[id] !== 2 || seam[id]) continue;
    const t = E.t0[id], u = E.t1[id];
    for (const v of [E.a[id], E.b[id]]) {
      const x = find(cornerOf(t, v)), y = find(cornerOf(u, v));
      if (x !== y) rep[x] = y;
    }
  }
  const copy = new Int32Array(T.length).fill(-1);
  const canon = new Buf(Int32Array, nv + 16);
  const Tn = new Uint32Array(T.length);
  for (let h = 0; h < T.length; h++) {
    const r = find(h);
    if (copy[r] < 0) { copy[r] = canon.n; canon.push(T[h]); }
    Tn[h] = copy[r];
  }
  for (let t = 0; t < nt; t++) {
    if (!flip[t]) continue;
    const x = Tn[t * 3 + 1];
    Tn[t * 3 + 1] = Tn[t * 3 + 2];
    Tn[t * 3 + 2] = x;
  }
  // Welded boundary edges as pairs.
  const bnd = new Buf(Uint32Array);
  for (let id = 0; id < E.count; id++) if (E.nt[id] === 1) { bnd.push(E.a[id]); bnd.push(E.b[id]); }
  return { T: Tn, canon: canon.slice(), seams: seam.reduce((s, x) => s + x, 0), boundary: bnd.slice(), welded: E };
}

export { Buf, Heap, decimate, paramMesh, implicitMesh, adjacency, edgesOf, orient, compact, gradient };
