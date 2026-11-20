// Collision shapes from a piece's own geometry: a coarse signed distance grid of each pose (worn and broken), blended
// by erosion like the mesh, plus points sampled on its surface. Two pieces touch where one's surface points reach
// into the other's field, so concave shapes (bowls, rings) collide as they look.

const RES = 22; // grid cells along the piece's longest side
const FIELD_SAMPLES = 480; // surface points the distances are measured to
const CONTACT_SAMPLES = 128; // surface points tested against other pieces

function evenIndices(count, n) {
  const out = [];
  for (let i = 0; i < Math.min(n, count); i++) out.push(Math.floor((i * count) / Math.min(n, count)));
  return out;
}

// Built in steps (one grid slice per step), to spread the work over frames.
export function* buildShape(geometry) {
  const pe = geometry.attributes.position.array;
  const pr = geometry.attributes.aRawPos.array;
  const ne = geometry.attributes.normal.array;
  const nr = geometry.attributes.aRawNormal.array;
  const count = pe.length / 3;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let reach = 0;
  for (const arr of [pe, pr]) {
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], arr[i + k]);
        max[k] = Math.max(max[k], arr[i + k]);
      }
      reach = Math.max(reach, Math.hypot(arr[i], arr[i + 1], arr[i + 2]));
    }
  }
  const pad = 0.05;
  for (let k = 0; k < 3; k++) {
    min[k] -= pad;
    max[k] += pad;
  }
  const h = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / RES;
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;

  // Signed distance to the nearest surface sample; inside where the point is behind that sample's normal.
  const fieldIdx = evenIndices(count, FIELD_SAMPLES);
  function* field(pos, nrm) {
    const sx = new Float32Array(fieldIdx.length * 6);
    fieldIdx.forEach((v, j) => {
      for (let k = 0; k < 3; k++) {
        sx[j * 6 + k] = pos[v * 3 + k];
        sx[j * 6 + 3 + k] = nrm[v * 3 + k];
      }
    });
    const grid = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      const gz = min[2] + z * h;
      for (let y = 0; y < ny; y++) {
        const gy = min[1] + y * h;
        for (let x = 0; x < nx; x++) {
          const gx = min[0] + x * h;
          let best = Infinity;
          let bj = 0;
          for (let j = 0; j < sx.length; j += 6) {
            const dx = gx - sx[j], dy = gy - sx[j + 1], dz = gz - sx[j + 2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < best) {
              best = d;
              bj = j;
            }
          }
          const side = (gx - sx[bj]) * sx[bj + 3] + (gy - sx[bj + 1]) * sx[bj + 4] + (gz - sx[bj + 2]) * sx[bj + 5];
          grid[(z * ny + y) * nx + x] = side < 0 ? -Math.sqrt(best) : Math.sqrt(best);
        }
      }
      yield;
    }
    return grid;
  }
  const gridE = yield* field(pe, ne);
  const gridR = yield* field(pr, nr);

  const contactIdx = evenIndices(count, CONTACT_SAMPLES);
  const pointsE = new Float32Array(contactIdx.length * 3);
  const pointsR = new Float32Array(contactIdx.length * 3);
  contactIdx.forEach((v, j) => {
    for (let k = 0; k < 3; k++) {
      pointsE[j * 3 + k] = pe[v * 3 + k];
      pointsR[j * 3 + k] = pr[v * 3 + k];
    }
  });

  return { min, h, nx, ny, nz, gridE, gridR, pointsE, pointsR, reach, extents: [0, 1, 2].map((k) => (max[k] - min[k] - 2 * pad) / 2) };
}

// Signed distance and its gradient (pointing out of the piece) at a point in the piece's local space, at erosion e.
// Writes { d, gx, gy, gz } to out; false outside the grid.
export function sampleShape(shape, e, x, y, z, out) {
  const { min, h, nx, ny, nz, gridE, gridR } = shape;
  const fx = (x - min[0]) / h;
  const fy = (y - min[1]) / h;
  const fz = (z - min[2]) / h;
  if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return false;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const at = (i, j, k) => {
    const n = ((iz + k) * ny + iy + j) * nx + ix + i;
    return gridR[n] + (gridE[n] - gridR[n]) * e;
  };
  const c000 = at(0, 0, 0), c100 = at(1, 0, 0), c010 = at(0, 1, 0), c110 = at(1, 1, 0);
  const c001 = at(0, 0, 1), c101 = at(1, 0, 1), c011 = at(0, 1, 1), c111 = at(1, 1, 1);
  const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
  const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
  out.d = y0 + (y1 - y0) * tz;
  // Derivatives of the trilinear blend
  const dx0 = (c100 - c000) + ((c110 - c010) - (c100 - c000)) * ty;
  const dx1 = (c101 - c001) + ((c111 - c011) - (c101 - c001)) * ty;
  out.gx = (dx0 + (dx1 - dx0) * tz) / h;
  out.gy = ((x10 - x00) + ((x11 - x01) - (x10 - x00)) * tz) / h;
  out.gz = (y1 - y0) / h;
  return true;
}
