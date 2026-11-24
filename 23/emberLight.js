// The embers' light on the smoke: each live ember's glow splatted (a gaussian about 0.25 across) into a coarse 3D grid
// spanning the smoke sim's box, which the light shaft's march reads (shaft.js).
import { Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping } from "three";

const CELL = 0.25;
const SIGMA = 0.22;
// Cells each ember reaches: the 4 nearest per axis (trilinear filtering smooths the rest)
const SPAN = 4;

class EmberLight {
  // box: { lo, size } of the sim (RockSmoke.box), world space
  constructor(box) {
    this.lo = box.lo.clone();
    this.n = [0, 1, 2].map((i) => Math.ceil(box.size.getComponent(i) / CELL));
    // Cell size per axis, so the grid spans the box exactly as the march's normalised coordinate does
    this.h = this.n.map((n, i) => box.size.getComponent(i) / n);
    const [nx, ny, nz] = this.n;
    this.sum = new Float32Array(nx * ny * nz);
    this.data = new Uint8Array(nx * ny * nz);
    this.texture = new Data3DTexture(this.data, nx, ny, nz);
    this.texture.format = RedFormat;
    this.texture.type = UnsignedByteType;
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
    this.texture.wrapS = this.texture.wrapT = this.texture.wrapR = ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;
    this.wx = new Float32Array(SPAN);
    this.wy = new Float32Array(SPAN);
    this.wz = new Float32Array(SPAN);
    // Cells written last time (min x, y, z, max x, y, z), cleared before the next splat
    this.dirty = null;
  }

  // embers: EmberSystem; its live embers have pos (world) and glow
  update(embers) {
    const { sum, lo, h, n, wx, wy, wz } = this;
    const [nx, ny, nz] = n;
    const box = [nx, ny, nz, -1, -1, -1];
    const inv = 1 / (2 * SIGMA * SIGMA);
    if (this.dirty) this._fill(this.dirty, false);
    const list = embers.mesh.visible ? embers.particles : [];
    for (const e of list) {
      if (!e.alive || e.glow < 0.01) continue;
      const gx = (e.pos.x - lo.x) / h[0] - 0.5, gy = (e.pos.y - lo.y) / h[1] - 0.5, gz = (e.pos.z - lo.z) / h[2] - 0.5;
      const x0 = Math.max(Math.floor(gx) - 1, 0), y0 = Math.max(Math.floor(gy) - 1, 0), z0 = Math.max(Math.floor(gz) - 1, 0);
      const x1 = Math.min(Math.floor(gx) + 2, nx - 1), y1 = Math.min(Math.floor(gy) + 2, ny - 1), z1 = Math.min(Math.floor(gz) + 2, nz - 1);
      if (x1 < x0 || y1 < y0 || z1 < z0) continue;
      for (let k = 0; k < SPAN; k++) {
        const dx = (x0 + k - gx) * h[0], dy = (y0 + k - gy) * h[1], dz = (z0 + k - gz) * h[2];
        wx[k] = Math.exp(-dx * dx * inv);
        wy[k] = Math.exp(-dy * dy * inv);
        wz[k] = Math.exp(-dz * dz * inv) * e.glow;
      }
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const wyz = wy[y - y0] * wz[z - z0];
          if (wyz < 1e-3) continue;
          const row = (z * ny + y) * nx;
          for (let x = x0; x <= x1; x++) sum[row + x] += wx[x - x0] * wyz;
        }
      }
      box[0] = Math.min(box[0], x0); box[1] = Math.min(box[1], y0); box[2] = Math.min(box[2], z0);
      box[3] = Math.max(box[3], x1); box[4] = Math.max(box[4], y1); box[5] = Math.max(box[5], z1);
    }
    const any = box[3] >= 0;
    if (!any && !this.dirty) return;
    if (this.dirty) this._fill(this.dirty, true);
    if (any) this._fill(box, true);
    this.dirty = any ? box : null;
    this.texture.needsUpdate = true;
  }

  // Over a box of cells: clears the sums, or writes them to the texture, saturating so a cluster reads brighter than
  // one ember without clipping the 8 bits
  _fill([x0, y0, z0, x1, y1, z1], write) {
    const { sum, data } = this;
    const [nx, ny] = this.n;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        const row = (z * ny + y) * nx;
        if (write) for (let i = row + x0; i <= row + x1; i++) data[i] = (255 * sum[i]) / (sum[i] + 1.5);
        else sum.fill(0, row + x0, row + x1 + 1);
      }
    }
  }
}

export { EmberLight };
