// Builds the map from the wave texture's voxels to the surface mesh's vertices, off the main thread: each voxel near
// the surface reads up to 4 vertices around its closest surface point.
// In: { id, pos (Float32Array), field: { data (Uint16Array halves), res, min, size }, box: { min, size }, grid, edge }.
// Out: { id, voxel (Int32Array), index (Int32Array, 4 per voxel), weight (Float32Array, 4 per voxel) }.

function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// Day 3's CPU field: voxel-centred trilinear lookup, clamped at the border, and its central-difference gradient.
function sampler({ data, res, min, size }) {
  const f = new Float32Array(data.length);
  for (let i = 0; i < f.length; i++) f[i] = fromHalf(data[i]);
  const step = size / res;
  const at = (i, j, k) => f[Math.min(res - 1, Math.max(0, i)) + res * (Math.min(res - 1, Math.max(0, j)) + res * Math.min(res - 1, Math.max(0, k)))];
  const sample = (x, y, z) => {
    const fx = (x - min[0]) / step - 0.5, fy = (y - min[1]) / step - 0.5, fz = (z - min[2]) / step - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c00 = at(i, j, k) + (at(i + 1, j, k) - at(i, j, k)) * tx;
    const c10 = at(i, j + 1, k) + (at(i + 1, j + 1, k) - at(i, j + 1, k)) * tx;
    const c01 = at(i, j, k + 1) + (at(i + 1, j, k + 1) - at(i, j, k + 1)) * tx;
    const c11 = at(i, j + 1, k + 1) + (at(i + 1, j + 1, k + 1) - at(i, j + 1, k + 1)) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
  const grad = (x, y, z, out) => {
    const e = step;
    out[0] = sample(x + e, y, z) - sample(x - e, y, z);
    out[1] = sample(x, y + e, z) - sample(x, y - e, z);
    out[2] = sample(x, y, z + e) - sample(x, y, z - e);
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 1e-8) (out[0] /= l), (out[1] /= l), (out[2] /= l);
    else (out[0] = 0), (out[1] = 1), (out[2] = 0);
  };
  return { sample, grad, step };
}

function build({ pos, field, box, grid, edge }) {
  const { sample, grad, step: fieldStep } = sampler(field);
  const n = pos.length / 3;
  const { min, size } = box;
  const step = size / grid;
  // Heights only matter where the water's surface can be: just outside the body, out to a thick coat on a big wave.
  const inner = -0.15, outer = 0.75;

  // Vertices bucketed in a dense cell grid over their bounding box.
  const cell = edge * 2;
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) (bmin[i % 3] = Math.min(bmin[i % 3], pos[i])), (bmax[i % 3] = Math.max(bmax[i % 3], pos[i]));
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((bmax[k] - bmin[k]) / cell) + 1));
  const cellOf = (v, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor((v - bmin[k]) / cell)));
  const cellCount = dims[0] * dims[1] * dims[2];
  const start = new Int32Array(cellCount + 1), items = new Int32Array(n), fill = new Int32Array(cellCount), cellIndex = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cellOf(pos[i * 3], 0) + dims[0] * (cellOf(pos[i * 3 + 1], 1) + dims[1] * cellOf(pos[i * 3 + 2], 2));
    cellIndex[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cellCount; c++) start[c + 1] += start[c];
  for (let i = 0; i < n; i++) items[start[cellIndex[i]] + fill[cellIndex[i]]++] = i;

  const total = grid ** 3;
  const voxel = new Int32Array(total), index = new Int32Array(total * 4), weight = new Float32Array(total * 4);
  let count = 0;
  const g = [0, 0, 0];
  const lo = field.min.map((v) => v + fieldStep * 0.5), hi = field.min.map((v) => v + field.size - fieldStep * 0.5);
  const near = new Float64Array(4), id = new Int32Array(4);
  for (let z = 0; z < grid; z++)
    for (let y = 0; y < grid; y++)
      for (let x = 0; x < grid; x++) {
        const px = min[0] + (x + 0.5) * step, py = min[1] + (y + 0.5) * step, pz = min[2] + (z + 0.5) * step;
        // Beyond the field's grid, project from the nearest point inside it.
        const qx = Math.min(hi[0], Math.max(lo[0], px)), qy = Math.min(hi[1], Math.max(lo[1], py)), qz = Math.min(hi[2], Math.max(lo[2], pz));
        const d = sample(qx, qy, qz);
        const dist = d + Math.hypot(px - qx, py - qy, pz - qz);
        if (dist < inner || dist > outer) continue;
        grad(qx, qy, qz, g);
        const sx = qx - g[0] * d, sy = qy - g[1] * d, sz = qz - g[2] * d;
        near.fill(Infinity);
        id.fill(-1);
        // The 2×2×2 block of cells nearest the point: cells are two edges wide, so the 4 nearest vertices lie inside it.
        const cx = Math.floor((sx - bmin[0]) / cell - 0.5), cy = Math.floor((sy - bmin[1]) / cell - 0.5), cz = Math.floor((sz - bmin[2]) / cell - 0.5);
        for (let c = Math.max(0, cz); c <= Math.min(dims[2] - 1, cz + 1); c++)
          for (let b = Math.max(0, cy); b <= Math.min(dims[1] - 1, cy + 1); b++)
            for (let a = Math.max(0, cx); a <= Math.min(dims[0] - 1, cx + 1); a++) {
              const cc = a + dims[0] * (b + dims[1] * c);
              for (let m = start[cc]; m < start[cc + 1]; m++) {
                const i = items[m];
                const e = (pos[i * 3] - sx) ** 2 + (pos[i * 3 + 1] - sy) ** 2 + (pos[i * 3 + 2] - sz) ** 2;
                if (e >= near[3]) continue;
                let k = 3;
                while (k > 0 && near[k - 1] > e) (near[k] = near[k - 1]), (id[k] = id[k - 1]), k--;
                (near[k] = e), (id[k] = i);
              }
            }
        if (id[0] < 0) continue;
        let sum = 0;
        for (let k = 0; k < 4; k++) if (id[k] >= 0) sum += 1 / (near[k] + 1e-6);
        voxel[count] = x + grid * (y + grid * z);
        for (let k = 0; k < 4; k++) {
          index[count * 4 + k] = Math.max(id[k], id[0]);
          weight[count * 4 + k] = id[k] >= 0 ? 1 / (near[k] + 1e-6) / sum : 0;
        }
        count++;
      }
  return { voxel: voxel.slice(0, count), index: index.slice(0, count * 4), weight: weight.slice(0, count * 4) };
}

self.onmessage = (e) => {
  try {
    const { voxel, index, weight } = build(e.data);
    self.postMessage({ id: e.data.id, voxel, index, weight }, [voxel.buffer, index.buffer, weight.buffer]);
  } catch (error) {
    // Answered either way: an empty map leaves the surface without waves rather than the page waiting.
    self.postMessage({ id: e.data.id, error: String(error?.stack ?? error), voxel: new Int32Array(0), index: new Int32Array(0), weight: new Float32Array(0) });
  }
};
