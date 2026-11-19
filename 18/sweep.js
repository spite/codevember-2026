// What a moving solid cuts out of a piece: every cell of the piece's (u, v) = (Z, Y) grid that the solid covers while
// inside the piece's slab (|X| <= half its thickness), over the sampled times. Solids are triangle soups (9 floats a
// triangle) in their own frames; `relative(t, index, out)` writes solid -> piece at time t.

const _m = new Float64Array(16);

// Polygon clip buffers: up to 5 vertices after two planes.
const _px = new Float64Array(8), _py = new Float64Array(8), _pz = new Float64Array(8);
const _qx = new Float64Array(8), _qy = new Float64Array(8), _qz = new Float64Array(8);

// Keeps sign * X <= limit.
function clipAgainst(n, sx, sy, sz, dx, dy, dz, limit, sign) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ai = sign * sx[i] - limit;
    const aj = sign * sx[j] - limit;
    if (ai <= 0) {
      dx[m] = sx[i]; dy[m] = sy[i]; dz[m] = sz[i]; m++;
    }
    if ((ai <= 0) !== (aj <= 0)) {
      const t = ai / (ai - aj);
      dx[m] = sx[i] + (sx[j] - sx[i]) * t;
      dy[m] = sy[i] + (sy[j] - sy[i]) * t;
      dz[m] = sz[i] + (sz[j] - sz[i]) * t;
      m++;
    }
  }
  return m;
}

function rasterizeSweep(grid, solids, times, relative, halfThickness) {
  const hx = halfThickness;
  const uMin = grid.u0, vMin = grid.v0, uMax = grid.u0 + grid.nx * grid.h, vMax = grid.v0 + grid.ny * grid.h;
  const e = _m;
  for (const t of times) {
    for (let s = 0; s < solids.length; s++) {
      const solid = solids[s];
      relative(t, s, e);
      const [cx0, cy0, cz0] = solid.centre;
      const cx = e[0] * cx0 + e[4] * cy0 + e[8] * cz0 + e[12];
      const cy = e[1] * cx0 + e[5] * cy0 + e[9] * cz0 + e[13];
      const cz = e[2] * cx0 + e[6] * cy0 + e[10] * cz0 + e[14];
      const r = solid.radius;
      if (Math.abs(cx) > hx + r || cz + r < uMin || cz - r > uMax || cy + r < vMin || cy - r > vMax) continue;
      const p = solid.positions;
      for (let k = 0; k < p.length; k += 9) {
        for (let q = 0; q < 3; q++) {
          const x = p[k + 3 * q], y = p[k + 3 * q + 1], z = p[k + 3 * q + 2];
          _px[q] = e[0] * x + e[4] * y + e[8] * z + e[12];
          _py[q] = e[1] * x + e[5] * y + e[9] * z + e[13];
          _pz[q] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        const out0 = _px[0] > hx, out1 = _px[1] > hx, out2 = _px[2] > hx;
        const in0 = _px[0] < -hx, in1 = _px[1] < -hx, in2 = _px[2] < -hx;
        if ((out0 && out1 && out2) || (in0 && in1 && in2)) continue;
        if (!(out0 || out1 || out2 || in0 || in1 || in2)) {
          grid.fillTriangle(_pz[0], _py[0], _pz[1], _py[1], _pz[2], _py[2]);
          continue;
        }
        let n = clipAgainst(3, _px, _py, _pz, _qx, _qy, _qz, hx, 1);
        n = clipAgainst(n, _qx, _qy, _qz, _px, _py, _pz, hx, -1);
        for (let i = 1; i + 1 < n; i++) grid.fillTriangle(_pz[0], _py[0], _pz[i], _py[i], _pz[i + 1], _py[i + 1]);
      }
    }
  }
}

export { rasterizeSweep };
