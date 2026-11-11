// Meshes for the field blanks: surface nets (after day 7's surface.js) relaxed along the surface with the shape's
// own projection, a tube along the knot, and a (u, v) grid for the twisted ring. Import-free, for the build worker.

function finish(shape, pos, index) {
  const nv = pos.length / 3;
  const P = new Float32Array(nv * 3);
  const N = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const q = shape.project(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    P.set([q[0], q[1], q[2]], v * 3);
    N.set([q[3], q[4], q[5]], v * 3);
  }
  return { position: P, normal: N, index: index instanceof Uint32Array ? index : new Uint32Array(index) };
}

// Surface nets of shape.sdf at cell size h, sampled finely only in blocks the (1-Lipschitz) field says the surface
// may cross, then relaxed tangentially and projected. With quads, the grid is centred on the origin and the result is
// the quads themselves ({ pos, quads }), for interlace grids.
export function surfaceNets(shape, h, relax = 3, quads = false) {
  const SC = 4;
  const nc = shape.bounds.map((b) => Math.ceil((2 * b + 4 * h) / (h * SC)));
  const lo = quads ? nc.map((c) => (-c * SC * h) / 2) : shape.bounds.map((b) => -b - 2 * h);
  const [nx, ny, nz] = nc.map((c) => c * SC + 1);
  const NXY = nx * ny;
  const F = new Float32Array(NXY * nz).fill(NaN);
  const blocks = [];
  const reach = SC * h * 0.87 + 0.5 * h;
  for (let k = 0; k < nc[2]; k++)
    for (let j = 0; j < nc[1]; j++)
      for (let i = 0; i < nc[0]; i++) {
        const v = shape.sdf(lo[0] + (i + 0.5) * SC * h, lo[1] + (j + 0.5) * SC * h, lo[2] + (k + 0.5) * SC * h);
        if (Math.abs(v) < reach) blocks.push(i, j, k);
      }
  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * SC, j0 = blocks[b + 1] * SC, k0 = blocks[b + 2] * SC;
    for (let k = k0; k <= k0 + SC; k++)
      for (let j = j0; j <= j0 + SC; j++)
        for (let i = i0; i <= i0 + SC; i++) {
          const o = i + nx * j + NXY * k;
          if (F[o] === F[o]) continue;
          F[o] = shape.sdf(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
        }
  }
  const CX = nx - 1, CXY = (nx - 1) * (ny - 1);
  const cellVert = new Int32Array(CXY * (nz - 1)).fill(-1);
  const P = [];
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
          cellVert[i + CX * j + CXY * k] = P.length / 3;
          P.push(lo[0] + (i + x / n) * h, lo[1] + (j + y / n) * h, lo[2] + (k + z / n) * h);
        }
  }
  const T = [];
  const Q = quads ? [] : null;
  const dd = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    if (Q) return void Q.push([a, b, c, d]);
    if (dd(a, c) <= dd(b, d)) T.push(a, b, c, a, c, d);
    else T.push(a, b, d, b, c, d);
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
  // Umbrella relaxation: each vertex moves halfway to the mean of its neighbours (edges counted per triangle), then
  // back onto the surface.
  const nv = P.length / 3;
  const sum = new Float64Array(nv * 3);
  const cnt = new Uint32Array(nv);
  for (let r = 0; r < relax; r++) {
    sum.fill(0);
    cnt.fill(0);
    const E = Q ? Q.flat() : T, K = Q ? 4 : 3;
    for (let t = 0; t < E.length; t += K)
      for (let e = 0; e < K; e++) {
        const a = E[t + e], b = E[t + ((e + 1) % K)];
        sum[a * 3] += P[b * 3], sum[a * 3 + 1] += P[b * 3 + 1], sum[a * 3 + 2] += P[b * 3 + 2], cnt[a]++;
        sum[b * 3] += P[a * 3], sum[b * 3 + 1] += P[a * 3 + 1], sum[b * 3 + 2] += P[a * 3 + 2], cnt[b]++;
      }
    for (let v = 0; v < nv; v++) {
      if (!cnt[v]) continue;
      const q = shape.project(P[v * 3] * 0.5 + (sum[v * 3] / cnt[v]) * 0.5, P[v * 3 + 1] * 0.5 + (sum[v * 3 + 1] / cnt[v]) * 0.5, P[v * 3 + 2] * 0.5 + (sum[v * 3 + 2] / cnt[v]) * 0.5);
      P[v * 3] = q[0], P[v * 3 + 1] = q[1], P[v * 3 + 2] = q[2];
    }
  }
  if (Q) return { pos: P, quads: Q };
  return finish(shape, P, T);
}

// A tube along the knot with rotation-minimizing frames, the leftover twist spread evenly so it closes.
export function knotMesh(shape, h) {
  const { pos, quads } = knotGrid(shape, Math.ceil(shape.length / h), Math.ceil((2 * Math.PI * shape.r) / h));
  return orientOutward(finish(shape, pos, triangulate(quads)));
}

const triangulate = (quads) => quads.flatMap(([a, b, c, d]) => [a, d, c, a, c, b]);

// The tube as a grid of nu × nv vertices (flat [x, y, z, ...]) and quads [(i, j), (i+1, j), (i+1, j+1), (i, j+1)].
export function knotGrid(shape, nu, nv) {
  shape.init();
  const C = [], Tn = [];
  for (let i = 0; i < nu; i++) {
    const t = (i / nu) * 2 * Math.PI;
    const d = [0, 0, 0];
    C.push(shape.curve(t, [0, 0, 0], d));
    const l = Math.hypot(d[0], d[1], d[2]);
    Tn.push([d[0] / l, d[1] / l, d[2] / l]);
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  // Double reflection (Wang et al.) for the frame's reference axis.
  const U = [nrm(cross(Tn[0], [0, 1, 0.3]))];
  for (let i = 0; i < nu; i++) {
    const j = (i + 1) % nu;
    const v1 = sub(C[j], C[i]);
    const c1 = dot(v1, v1);
    const r = U[i];
    const rL = sub(r, v1.map((x) => (x * 2 * dot(v1, r)) / c1));
    const tL = sub(Tn[i], v1.map((x) => (x * 2 * dot(v1, Tn[i])) / c1));
    const v2 = sub(Tn[j], tL);
    const c2 = dot(v2, v2);
    U.push(nrm(sub(rL, v2.map((x) => (x * 2 * dot(v2, rL)) / c2))));
  }
  const end = U[nu];
  const W0 = cross(Tn[0], U[0]);
  const twist = Math.atan2(dot(end, W0), dot(end, U[0]));
  const pos = [];
  for (let i = 0; i < nu; i++) {
    const a = (-twist * i) / nu;
    const u = U[i];
    const w = cross(Tn[i], u);
    const e1 = u.map((x, k) => x * Math.cos(a) + w[k] * Math.sin(a));
    const e2 = cross(Tn[i], e1);
    for (let j = 0; j < nv; j++) {
      const b = (j / nv) * 2 * Math.PI;
      const cb = Math.cos(b), sb = Math.sin(b);
      pos.push(...[0, 1, 2].map((k) => C[i][k] + shape.r * (e1[k] * cb + e2[k] * sb)));
    }
  }
  const quads = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) quads.push([i * nv + j, ((i + 1) % nu) * nv + j, ((i + 1) % nu) * nv + ((j + 1) % nv), i * nv + ((j + 1) % nv)]);
  return { pos, quads };
}

// The ring on a (u, v) grid: v runs round the section by arc length, and after a full turn the section has turned a
// third, so the last ring of vertices joins the first a third of the way round.
export function twistMesh(shape, h) {
  const per = 6 * shape.t + 2 * Math.PI * shape.rr;
  const { pos, quads } = twistGrid(shape, Math.ceil((2 * Math.PI * (shape.R + 0.4)) / h), Math.ceil(per / h / 3) * 3);
  return orientOutward(finish(shape, pos, triangulate(quads)));
}

export function twistGrid(shape, nu, nv) {
  const { R, t, rr } = shape;
  const per = 6 * t + 2 * Math.PI * rr;
  // Rounded triangle outline in the section's (a, b) frame: vertices on the a axis side, mirror symmetric about it.
  const k = Math.sqrt(3);
  const V = [0, 1, 2].map((i) => {
    const ang = (i * 2 * Math.PI) / 3;
    return [Math.cos(ang) * ((2 * t) / k), Math.sin(ang) * ((2 * t) / k)];
  });
  const outline = [];
  for (let j = 0; j < nv; j++) {
    let s = (j / nv) * per;
    for (let i = 0; i < 3; i++) {
      const A = V[i], B = V[(i + 1) % 3];
      const ex = [(B[0] - A[0]) / (2 * t), (B[1] - A[1]) / (2 * t)];
      const nO = [ex[1], -ex[0]];
      // Outward normal of side A→B.
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      if (nO[0] * mid[0] + nO[1] * mid[1] < 0) (nO[0] = -nO[0]), (nO[1] = -nO[1]);
      if (s < 2 * t) {
        outline.push([A[0] + ex[0] * s + nO[0] * rr, A[1] + ex[1] * s + nO[1] * rr]);
        s = -1;
        break;
      }
      s -= 2 * t;
      const arc = (2 * Math.PI * rr) / 3;
      if (s < arc) {
        const a0 = Math.atan2(nO[1], nO[0]);
        const sgn = Math.sign(ex[0] * nO[1] - ex[1] * nO[0]) * -1;
        const ang = a0 + sgn * (s / rr);
        outline.push([B[0] + Math.cos(ang) * rr, B[1] + Math.sin(ang) * rr]);
        s = -1;
        break;
      }
      s -= arc;
    }
    if (s >= 0) outline.push(outline[0]);
  }
  const pos = [];
  for (let i = 0; i < nu; i++) {
    const phi = (i / nu) * 2 * Math.PI;
    const th = phi / 3;
    const c = Math.cos(th), sn = Math.sin(th);
    for (const [a, b] of outline) {
      const s = a * c - b * sn, y = a * sn + b * c;
      pos.push((R + s) * Math.cos(phi), y, (R + s) * Math.sin(phi));
    }
  }
  // Which outline index the last ring's j continues into after the seam.
  const shift = (() => {
    const last = (nu - 1) * nv;
    let best = 0, bd = Infinity;
    for (let m = 0; m < nv; m++) {
      const d = (pos[last * 3] - pos[m * 3]) ** 2 + (pos[last * 3 + 1] - pos[m * 3 + 1]) ** 2 + (pos[last * 3 + 2] - pos[m * 3 + 2]) ** 2;
      if (d < bd) (bd = d), (best = m);
    }
    return best;
  })();
  const quads = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const j1 = (j + 1) % nv;
      const a = i * nv + j, d = i * nv + j1;
      const b = i + 1 < nu ? (i + 1) * nv + j : (j + shift) % nv;
      const c = i + 1 < nu ? (i + 1) * nv + j1 : (j1 + shift) % nv;
      quads.push([a, d, c, b]);
    }
  return { pos, quads };
}

// Flips the winding if the first triangle faces against its normal.
function orientOutward(m) {
  const I = m.index, P = m.position, N = m.normal;
  const [a, b, c] = [I[0] * 3, I[1] * 3, I[2] * 3];
  const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (n[0] * N[a] + n[1] * N[a + 1] + n[2] * N[a + 2] < 0)
    for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
  return m;
}

export function meshArea(m) {
  const I = m.index, P = m.position;
  let A = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    A += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  }
  return A;
}

// The Möbius band: rings of its stadium outline, each turned by half the angle round, the last ring joining the first
// with the outline shifted by half its length (a stadium turned by π).
export function moebiusGrid(shape, nu, nv) {
  const { R, w, rr } = shape;
  const per = 4 * w + 2 * Math.PI * rr;
  const outline = [];
  for (let j = 0; j < nv; j++) {
    let s = (j / nv) * per;
    for (const side of [1, -1]) {
      if (s < 2 * w) {
        outline.push([side * (w - s), side * rr]);
        s = -1;
        break;
      }
      s -= 2 * w;
      if (s < Math.PI * rr) {
        outline.push([side * -w + side * -Math.sin(s / rr) * rr, side * Math.cos(s / rr) * rr]);
        s = -1;
        break;
      }
      s -= Math.PI * rr;
    }
  }
  const pos = [];
  for (let i = 0; i < nu; i++) {
    const phi = (i / nu) * 2 * Math.PI;
    const th = phi / 2;
    const c = Math.cos(th), sn = Math.sin(th);
    for (const [a, b] of outline) {
      const s = a * c - b * sn, y = a * sn + b * c;
      pos.push((R + s) * Math.cos(phi), y, (R + s) * Math.sin(phi));
    }
  }
  const shift = nv / 2;
  const quads = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const j1 = (j + 1) % nv;
      const a = i * nv + j, d = i * nv + j1;
      const b = i + 1 < nu ? (i + 1) * nv + j : (j + shift) % nv;
      const c = i + 1 < nu ? (i + 1) * nv + j1 : (j1 + shift) % nv;
      quads.push([a, d, c, b]);
    }
  return { pos, quads };
}

export function moebiusMesh(shape, h) {
  const per = 4 * shape.w + 2 * Math.PI * shape.rr;
  const { pos, quads } = moebiusGrid(shape, Math.ceil((2 * Math.PI * (shape.R + shape.w)) / h), Math.ceil(per / h / 2) * 2);
  return orientOutward(finish(shape, pos, triangulate(quads)));
}
