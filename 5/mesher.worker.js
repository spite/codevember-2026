// Meshes the reaction-diffusion field and bakes the per-vertex data the moss needs.

function hash(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerp = (a, b, t) => a + (b - a) * t;

function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  return lerp(
    lerp(lerp(hash(ix, iy, iz), hash(ix + 1, iy, iz), fx), lerp(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), fx), fy),
    lerp(lerp(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), fx), lerp(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}

function fbm(x, y, z, octaves = 4) {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * vnoise(x, y, z);
    n += a;
    a *= 0.5;
    x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.2;
  }
  return s / n;
}

// Nearest cell: its squared distance, random value and offset to its point, left in W.
const W = { d2: 0, id: 0, dx: 0, dy: 0, dz: 0 };
function worley(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let d1 = 9, bx = 0, by = 0, bz = 0, ox = 0, oy = 0, oz = 0;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i, cy = iy + j, cz = iz + k;
        const dx = cx + hash(cx, cy, cz) - x;
        const dy = cy + hash(cx + 31, cy, cz) - y;
        const dz = cz + hash(cx, cy + 57, cz) - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d1) { d1 = d; bx = cx; by = cy; bz = cz; ox = dx; oy = dy; oz = dz; }
      }
  W.d2 = d1; W.id = hash(bx, by, bz + 91); W.dx = ox; W.dy = oy; W.dz = oz;
  return W;
}

// Keeps the connected pieces that are at least a few percent of the largest one.
function dropFragments(index, nv) {
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]);
    parent[find(index[t + 1])] = a;
    parent[find(index[t + 2])] = a;
  }
  const size = new Uint32Array(nv);
  for (let t = 0; t < index.length; t += 3) size[find(index[t])]++;
  let max = 0;
  for (let v = 0; v < nv; v++) max = Math.max(max, size[v]);
  const out = new Uint32Array(index.length);
  let n = 0;
  for (let t = 0; t < index.length; t += 3) {
    if (size[find(index[t])] < max * 0.04) continue;
    out[n++] = index[t]; out[n++] = index[t + 1]; out[n++] = index[t + 2];
  }
  return out.slice(0, n);
}

// Lowest point and bounding-box centre of the vertices the triangles use.
function bounds(pos, index) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < index.length; t++)
    for (let a = 0; a < 3; a++) {
      const v = pos[index[t] * 3 + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  if (!index.length) return { minY: 0, center: [0, 0, 0] };
  return { minY: lo[1], center: [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2) };
}

function mesh({ field, N, extent, seed, cushionScale, preview, rotation }) {
  const h = (2 * extent) / N;
  const world = (g) => (g + 0.5) * h - extent;
  const C = N - 1;

  // Surface nets: one vertex per sign-changing cell of the voxel-centre lattice.
  const cellVert = new Int32Array(C * C * C).fill(-1);
  let pos = new Float32Array(1 << 20);
  let nv = 0;
  const c = new Float32Array(8);
  const NN = N * N;
  const inside = new Uint8Array(field.length);
  for (let v = 0; v < field.length; v++) inside[v] = field[v] < 0 ? 1 : 0;
  const corner = [0, 1, N, N + 1, NN, NN + 1, NN + N, NN + N + 1];
  for (let k = 0; k < C; k++)
    for (let j = 0; j < C; j++)
      for (let i = 0, o = N * j + NN * k; i < C; i++, o++) {
        const neg = inside[o] + inside[o + 1] + inside[o + N] + inside[o + N + 1] + inside[o + NN] + inside[o + NN + 1] + inside[o + NN + N] + inside[o + NN + N + 1];
        if (neg === 0 || neg === 8) continue;
        for (let m = 0; m < 8; m++) c[m] = field[o + corner[m]];
        let x = 0, y = 0, z = 0, n = 0;
        for (let m = 0; m < 8; m++)
          for (let bit = 1; bit <= 4; bit <<= 1) {
            if (m & bit || (c[m] < 0) === (c[m | bit] < 0)) continue;
            const t = c[m] / (c[m] - c[m | bit]);
            x += (m & 1) + (bit === 1 ? t : 0);
            y += ((m >> 1) & 1) + (bit === 2 ? t : 0);
            z += (m >> 2) + (bit === 4 ? t : 0);
            n++;
          }
        if (nv * 3 + 3 > pos.length) { const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2; }
        cellVert[i + C * (j + C * k)] = nv;
        pos[nv * 3] = i + x / n; pos[nv * 3 + 1] = j + y / n; pos[nv * 3 + 2] = k + z / n;
        nv++;
      }
  pos = pos.subarray(0, nv * 3);

  let index = new Uint32Array(1 << 21);
  let nt = 0;
  const d2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  const push = (a, b, cc) => {
    if (nt * 3 + 3 > index.length) { const i2 = new Uint32Array(index.length * 2); i2.set(index); index = i2; }
    index[nt * 3] = a; index[nt * 3 + 1] = b; index[nt * 3 + 2] = cc;
    nt++;
  };
  const quad = (a, b, cc, d, flip) => {
    if (flip) [b, d] = [d, b];
    if (d2(a, cc) <= d2(b, d)) { push(a, b, cc); push(a, cc, d); }
    else { push(a, b, d); push(b, cc, d); }
  };
  const CC = C * C;
  for (let k = 1; k < C; k++)
    for (let j = 1; j < C; j++)
      for (let i = 1, o = 1 + N * j + NN * k, c0 = 1 + C * j + CC * k; i < C; i++, o++, c0++) {
        const v0 = inside[o];
        const ex = v0 !== inside[o + 1], ey = v0 !== inside[o + N], ez = v0 !== inside[o + NN];
        if (!(ex || ey || ez)) continue;
        if (ex) quad(cellVert[c0 - C - CC], cellVert[c0 - CC], cellVert[c0], cellVert[c0 - C], !v0);
        if (ey) quad(cellVert[c0 - 1 - CC], cellVert[c0 - 1], cellVert[c0], cellVert[c0 - CC], !v0);
        if (ez) quad(cellVert[c0 - 1 - C], cellVert[c0 - C], cellVert[c0], cellVert[c0 - 1], !v0);
      }
  index = index.slice(0, nt * 3);
  index = dropFragments(index, nv);

  // Trilinear field in grid units, clamped to the grid.
  const sample = (x, y, z) => {
    let i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    let tx = x - i, ty = y - j, tz = z - k;
    if (i < 0) { i = 0; tx = 0; } else if (i >= C) { i = C - 1; tx = 1; }
    if (j < 0) { j = 0; ty = 0; } else if (j >= C) { j = C - 1; ty = 1; }
    if (k < 0) { k = 0; tz = 0; } else if (k >= C) { k = C - 1; tz = 1; }
    const o = i + N * j + NN * k;
    const a0 = field[o] + (field[o + 1] - field[o]) * tx;
    const a1 = field[o + N] + (field[o + N + 1] - field[o + N]) * tx;
    const a2 = field[o + NN] + (field[o + NN + 1] - field[o + NN]) * tx;
    const a3 = field[o + NN + N] + (field[o + NN + N + 1] - field[o + NN + N]) * tx;
    const b0 = a0 + (a1 - a0) * ty, b1 = a2 + (a3 - a2) * ty;
    return b0 + (b1 - b0) * tz;
  };
  // Halved copies keeping the most solid value, so far steps of the occlusion march stay in cache.
  const mips = [{ f: field, n: N }];
  while (mips.length < 3) {
    const { f, n } = mips[mips.length - 1], m = n >> 1, g = new Float32Array(m * m * m);
    for (let k = 0; k < m; k++)
      for (let j = 0; j < m; j++)
        for (let i = 0; i < m; i++) {
          let v = Infinity;
          for (let c = 0; c < 8; c++) v = Math.min(v, f[(2 * i + (c & 1)) + n * ((2 * j + ((c >> 1) & 1)) + n * (2 * k + (c >> 2)))]);
          g[i + m * (j + m * k)] = v;
        }
    mips.push({ f: g, n: m });
  }
  const mipF = mips.map((m) => m.f), mipN = mips.map((m) => m.n);
  const coarse = (x, y, z, l) => {
    const f = mipF[l], n = mipN[l], sc = 1 / (1 << l), c = n - 1;
    const i = Math.min(c, Math.max(0, Math.floor((x + 0.5) * sc))), j = Math.min(c, Math.max(0, Math.floor((y + 0.5) * sc))), k = Math.min(c, Math.max(0, Math.floor((z + 0.5) * sc)));
    return f[i + n * (j + n * k)];
  };
  const grad = (x, y, z, out) => {
    out[0] = sample(x + 0.7, y, z) - sample(x - 0.7, y, z);
    out[1] = sample(x, y + 0.7, z) - sample(x, y - 0.7, z);
    out[2] = sample(x, y, z + 0.7) - sample(x, y, z - 0.7);
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return l / 1.4;
  };

  // Neighbour lists (CSR) for smoothing.
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < index.length; t++) deg[index[t] + 1] += 2;
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const adj = new Uint32Array(deg[nv]);
  const fill = deg.slice(0, nv);
  for (let t = 0; t < index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)];
      adj[fill[a]++] = b;
      adj[fill[b]++] = a;
    }

  // Tangential smoothing, then a step back onto the iso surface.
  const g = new Float32Array(3);
  const next = new Float32Array(pos.length);
  for (let r = 0; r < 3; r++) {
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let cx = 0, cy = 0, cz = 0;
      const n = deg[v + 1] - deg[v];
      for (let e = deg[v]; e < deg[v + 1]; e++) { const u = adj[e]; cx += pos[u * 3]; cy += pos[u * 3 + 1]; cz += pos[u * 3 + 2]; }
      let dx = n ? cx / n - x : 0, dy = n ? cy / n - y : 0, dz = n ? cz / n - z : 0;
      const gl = grad(x, y, z, g);
      const dn = dx * g[0] + dy * g[1] + dz * g[2];
      dx = (dx - dn * g[0]) * 0.5; dy = (dy - dn * g[1]) * 0.5; dz = (dz - dn * g[2]) * 0.5;
      let px = x + dx, py = y + dy, pz = z + dz;
      const f = sample(px, py, pz);
      const step = Math.max(-0.5, Math.min(0.5, f / Math.max(gl, 0.2)));
      px -= step * g[0]; py -= step * g[1]; pz -= step * g[2];
      next[v * 3] = px; next[v * 3 + 1] = py; next[v * 3 + 2] = pz;
    }
    pos.set(next);
  }

  const normal = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    grad(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], g);
    normal.set(g, v * 3);
  }

  // Mean curvature from the umbrella operator (positive on ridges, negative in hollows), smoothed over a few
  // rings so the voxel-scale zigzag of the mesh drops out.
  let curve = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let lx = 0, ly = 0, lz = 0, e2 = 0;
    for (let e = deg[v]; e < deg[v + 1]; e++) {
      const u = adj[e], dx = pos[u * 3] - x, dy = pos[u * 3 + 1] - y, dz = pos[u * 3 + 2] - z;
      lx += dx; ly += dy; lz += dz; e2 += dx * dx + dy * dy + dz * dz;
    }
    curve[v] = e2 > 0 ? (-4 * (lx * normal[v * 3] + ly * normal[v * 3 + 1] + lz * normal[v * 3 + 2])) / e2 : 0;
  }
  let spare = new Float32Array(nv);
  for (let r = 0; r < 4; r++) {
    for (let v = 0; v < nv; v++) {
      let c = curve[v];
      for (let e = deg[v]; e < deg[v + 1]; e++) c += curve[adj[e]];
      spare[v] = c / (1 + deg[v + 1] - deg[v]);
    }
    [curve, spare] = [spare, curve];
  }
  for (let v = 0; v < nv; v++) curve[v] = Math.max(-1, Math.min(1, curve[v] * 4 * (128 / N)));

  // Hemisphere occlusion by marching the field along a few directions around the normal.
  const dirs = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 2.39996, r = Math.sqrt((i + 0.5) / 6) * 0.85;
    dirs.push([Math.cos(a) * r, Math.sin(a) * r, Math.sqrt(1 - r * r)]);
  }
  const ao = new Float32Array(nv);
  // The same reach in world units on coarser preview grids.
  const reach = (110 * N) / 128;
  for (let v = 0; v < nv; v++) {
    const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
    const side = Math.abs(nx) < 0.9;
    let tx = side ? 0 : -nz, ty = side ? nz : 0, tz = side ? -ny : nx;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    let open = 0;
    for (const d of dirs) {
      const rx = tx * d[0] + bx * d[1] + nx * d[2];
      const ry = ty * d[0] + by * d[1] + ny * d[2];
      const rz = tz * d[0] + bz * d[1] + nz * d[2];
      let vis = 1;
      for (let s = 1.5; s < reach; s *= 1.45) {
        const x = pos[v * 3] + rx * s, y = pos[v * 3 + 1] + ry * s, z = pos[v * 3 + 2] + rz * s;
        const f = s < 4 ? sample(x, y, z) : coarse(x, y, z, s < 12 ? 0 : s < 30 ? 1 : 2);
        if (f < 0) { vis = 0.35 * Math.min(1, s / reach) ** 2; break; }
      }
      open += vis;
    }
    ao[v] = open / dirs.length;
  }

  // Grid units to world units, turned to the sculpture's orientation (column-major 3x3).
  const Q = rotation ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    const x = world(pos[o]), y = world(pos[o + 1]), z = world(pos[o + 2]);
    pos[o] = Q[0] * x + Q[3] * y + Q[6] * z;
    pos[o + 1] = Q[1] * x + Q[4] * y + Q[7] * z;
    pos[o + 2] = Q[2] * x + Q[5] * y + Q[8] * z;
    const nx = normal[o], ny = normal[o + 1], nz = normal[o + 2];
    normal[o] = Q[0] * nx + Q[3] * ny + Q[6] * nz;
    normal[o + 1] = Q[1] * nx + Q[4] * ny + Q[7] * nz;
    normal[o + 2] = Q[2] * nx + Q[5] * ny + Q[8] * nz;
  }

  // Previews of the growing form keep the shape and its occlusion, and skip what the moss needs.
  if (preview) {
    const uv = new Float32Array(nv * 2);
    for (let v = 0; v < nv; v++) uv[v * 2 + 1] = ao[v];
    return { position: pos, normal, uv, curve, cushion: new Float32Array(nv * 4), species: new Float32Array(nv), index, binStart: new Uint32Array(33), ...bounds(pos, index) };
  }

  // Where moss settles first: tops, outward faces, open areas, broken up by noise.
  const [sx, sy, sz] = seed;
  const score = new Float32Array(nv);
  const species = new Float32Array(nv);
  const cushion = new Float32Array(nv * 4);
  const cf = 9 / cushionScale;
  const vc = (x, y, z) => vnoise(x * cf * 0.4 + sz, y * cf * 0.4, z * cf * 0.4 + sx);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
    const rl = Math.hypot(x, y, z) || 1;
    const outward = (nx * x + ny * y + nz * z) / rl;
    const up = Math.min(1, Math.max(0, (ny + 0.45) / 1.35));
    const n1 = fbm(x * 2.2 + sx, y * 2.2 + sy, z * 2.2 + sz);
    const n2 = vnoise(x * 9 + sz, y * 9 + sx, z * 9 + sy);
    score[v] = 1.1 * up * up + 0.25 * outward + 0.45 * ao[v] + 1.0 * (n1 - 0.5) * 2 + 0.25 * n2;

    // Species patches, with small islands of a second one.
    const id = worley(x * 2.4 + sy, y * 2.4 + sz, z * 2.4 + sx).id;
    const isl = worley(x * 8 + sz, y * 8 + sx, z * 8 + sy);
    species[v] = isl.d2 < 0.32 * 0.32 && isl.id > 0.55 ? isl.id : id;

    // Cushion height (a dome per cell, scaled by noise) and its gradient along the surface.
    const cw = worley(x * cf + sx, y * cf + sy, z * cf + sz);
    const dome = Math.max(0, 1 - cw.d2 * 1.3);
    const e = 0.006;
    const n0 = vc(x, y, z), amp = 0.5 + n0;
    const dp = Math.pow(dome, 0.75);
    const c0 = 0.06 + 0.94 * dp * amp;
    // d(dome)/dp = 2.6 * cf * (offset to the cell point), clamped near the dome's edge.
    const k = dome > 0 ? 0.94 * amp * 0.75 * Math.pow(Math.max(dome, 0.02), -0.25) * 2.6 * cf : 0;
    let gx = k * cw.dx + 0.94 * dp * (vc(x + e, y, z) - n0) / e;
    let gy = k * cw.dy + 0.94 * dp * (vc(x, y + e, z) - n0) / e;
    let gz = k * cw.dz + 0.94 * dp * (vc(x, y, z + e) - n0) / e;
    const gn = gx * nx + gy * ny + gz * nz;
    gx -= gn * nx; gy -= gn * ny; gz -= gn * nz;
    cushion[v * 4] = gx; cushion[v * 4 + 1] = gy; cushion[v * 4 + 2] = gz; cushion[v * 4 + 3] = c0;
  }

  // Ranks, so a coverage of x covers that fraction of the vertices.
  const used = new Uint8Array(nv);
  for (let t = 0; t < index.length; t++) used[index[t]] = 1;
  // Counting sort on the quantised score.
  let lo = Infinity, hi = -Infinity, M = 0;
  for (let v = 0; v < nv; v++) if (used[v]) { M++; lo = Math.min(lo, score[v]); hi = Math.max(hi, score[v]); }
  const Q16 = 1 << 16, qs = (Q16 - 1) / Math.max(hi - lo, 1e-9);
  const count = new Uint32Array(Q16 + 1);
  for (let v = 0; v < nv; v++) if (used[v]) count[((score[v] - lo) * qs | 0) + 1]++;
  for (let b = 0; b < Q16; b++) count[b + 1] += count[b];
  const uv = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) if (used[v]) { const r = count[(score[v] - lo) * qs | 0]++; uv[v * 2] = M > 1 ? r / (M - 1) : 1; }
  for (let v = 0; v < nv; v++) uv[v * 2 + 1] = ao[v];

  // Triangles sorted by rank, highest first, so the shells can draw only the grown prefix.
  const BINS = 32;
  const binOf = (t) => Math.min(BINS - 1, Math.floor(Math.max(uv[index[t] * 2], uv[index[t + 1] * 2], uv[index[t + 2] * 2]) * BINS));
  const binStart = new Uint32Array(BINS + 1);
  for (let t = 0; t < index.length; t += 3) binStart[BINS - binOf(t)]++;
  for (let s = 0; s < BINS; s++) binStart[s + 1] += binStart[s];
  const fillAt = binStart.slice();
  const sorted = new Uint32Array(index.length);
  for (let t = 0; t < index.length; t += 3) {
    const o = fillAt[BINS - 1 - binOf(t)]++ * 3;
    sorted[o] = index[t]; sorted[o + 1] = index[t + 1]; sorted[o + 2] = index[t + 2];
  }


  return { position: pos, normal, uv, curve, cushion, species, index: sorted, binStart, ...bounds(pos, index) };
}

self.onmessage = (e) => {
  const { id } = e.data;
  try {
    const out = mesh(e.data);
    self.postMessage({ id, ...out }, [out.position.buffer, out.normal.buffer, out.uv.buffer, out.curve.buffer, out.cushion.buffer, out.species.buffer, out.index.buffer, out.binStart.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
