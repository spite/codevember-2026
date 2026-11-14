// Tileable RGBA half-float noise volume for the finishes; baked in the build worker.
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);

function toHalfFloat(val) {
  if (val <= 6.11e-5) return 0;
  if (val >= 1.0) return 0x3c00;
  f32Buf[0] = val;
  const bits = u32Buf[0];
  const exp = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exp <= 0) return 0;
  return (exp << 10) | ((bits >>> 13) & 0x03ff);
}

export function bakeNoiseVolume(size = 64) {
  const data = new Uint16Array(size * size * size * 4);

  function hashInt(ix, iy, iz, seed) {
    let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1597334677) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function quintic(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function periodicValueNoise(ux, uy, uz, period, seed) {
    const px = ux * period;
    const py = uy * period;
    const pz = uz * period;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const fx = quintic(px - ix);
    const fy = quintic(py - iy);
    const fz = quintic(pz - iz);
    const x0 = ((ix % period) + period) % period;
    const y0 = ((iy % period) + period) % period;
    const z0 = ((iz % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const z1 = (z0 + 1) % period;

    const c000 = hashInt(x0, y0, z0, seed);
    const c100 = hashInt(x1, y0, z0, seed);
    const c010 = hashInt(x0, y1, z0, seed);
    const c110 = hashInt(x1, y1, z0, seed);
    const c001 = hashInt(x0, y0, z1, seed);
    const c101 = hashInt(x1, y0, z1, seed);
    const c011 = hashInt(x0, y1, z1, seed);
    const c111 = hashInt(x1, y1, z1, seed);

    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;
    const y0v = x00 + (x10 - x00) * fy;
    const y1v = x01 + (x11 - x01) * fy;
    return y0v + (y1v - y0v) * fz;
  }

  const worleyP = 10;
  const worleyPts = new Float32Array(worleyP * worleyP * worleyP * 3);
  for (let z = 0; z < worleyP; z++) {
    for (let y = 0; y < worleyP; y++) {
      for (let x = 0; x < worleyP; x++) {
        const idx = ((z * worleyP + y) * worleyP + x) * 3;
        worleyPts[idx] = x + 0.12 + 0.76 * hashInt(x, y, z, 31);
        worleyPts[idx + 1] = y + 0.12 + 0.76 * hashInt(x, y, z, 37);
        worleyPts[idx + 2] = z + 0.12 + 0.76 * hashInt(x, y, z, 41);
      }
    }
  }

  let ptr = 0;
  for (let z = 0; z < size; z++) {
    const uz = z / size;
    for (let y = 0; y < size; y++) {
      const uy = y / size;
      for (let x = 0; x < size; x++) {
        const ux = x / size;

        const warp =
          0.66 * periodicValueNoise(ux, uy, uz, 3, 1) +
          0.34 * periodicValueNoise(ux, uy, uz, 6, 2);

        const fbm =
          0.46 * periodicValueNoise(ux, uy, uz, 4, 5) +
          0.28 * periodicValueNoise(ux, uy, uz, 8, 7) +
          0.16 * periodicValueNoise(ux, uy, uz, 16, 11) +
          0.10 * periodicValueNoise(ux, uy, uz, 32, 19);

        const wx = ux * worleyP;
        const wy = uy * worleyP;
        const wz = uz * worleyP;
        const cx = Math.floor(wx);
        const cy = Math.floor(wy);
        const cz = Math.floor(wz);
        let d1Sq = 99;
        let d2Sq = 99;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = (((cz + dz) % worleyP) + worleyP) % worleyP;
          const oz = cz + dz - nz;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = (((cy + dy) % worleyP) + worleyP) % worleyP;
            const oy = cy + dy - ny;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = (((cx + dx) % worleyP) + worleyP) % worleyP;
              const ox = cx + dx - nx;
              const k = ((nz * worleyP + ny) * worleyP + nx) * 3;
              const rx = worleyPts[k] + ox - wx;
              const ry = worleyPts[k + 1] + oy - wy;
              const rz = worleyPts[k + 2] + oz - wz;
              const dSq = rx * rx + ry * ry + rz * rz;
              if (dSq < d1Sq) {
                d2Sq = d1Sq;
                d1Sq = dSq;
              } else if (dSq < d2Sq) {
                d2Sq = dSq;
              }
            }
          }
        }
        const f1 = Math.sqrt(d1Sq);
        const f2 = Math.sqrt(d2Sq);
        const pit = Math.max(0, 1 - (f1 / 0.54) ** 2);
        const vein = Math.exp(-(((f2 - f1) / 0.085) ** 2));

        data[ptr++] = toHalfFloat(warp);
        data[ptr++] = toHalfFloat(fbm);
        data[ptr++] = toHalfFloat(pit);
        data[ptr++] = toHalfFloat(vein);
      }
    }
  }

  return data;
}
