import { SURFACE } from "./kelpBuilder.js";

// The swell, as exact linear waves over the reef: [period s, direction rad, surface amplitude m]. One long wave dominates,
// so the forest sways steadily back and forth; the others only roughen it.
const SWELL = [
  [10, 0.12, 0.75],
  [6.3, 0.5, 0.12],
  [4.1, -0.7, 0.05],
];
// A surge: a pulse of flow that builds, pushes and eases off (seconds).
const SURGE_RISE = 1.8;
const SURGE_HOLD = 1.2;
const SURGE_FALL = 3.5;
// The mean current along the forest's stream (m/s).
const CURRENT = 0.05;

// A coarse incompressible 3D fluid on the CPU around a kinematic sea. The swell and the mean current are evaluated on the
// grid every step; the simulated field carries only what stirs the water (the probe's wake, stirs, the pointer and slow
// eddies) with vorticity confinement, semi-Lagrangian advection by the total flow and a Gauss-Seidel pressure projection.
// The kelp, the probe and the marine snow sample the sum. The grid covers x [-16, 16], y [-7, 18.5], z [-16, 16].
export class FluidSim3D {
  constructor(nx = 24, ny = 18, nz = 24) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.n = nx * ny * nz;
    this.min = [-16, -7, -16];
    this.size = [32, 25.5, 32];
    this.cell = [this.size[0] / (nx - 1), this.size[1] / (ny - 1), this.size[2] / (nz - 1)];

    // u, v, w: the simulated perturbation; tu, tv, tw: the total flow everything samples.
    for (const k of ["u", "v", "w", "u0", "v0", "w0", "tu", "tv", "tw", "p", "div", "curlX", "curlY", "curlZ", "curlMag"]) this[k] = new Float32Array(this.n);
    // Eddy phases per column (x, z) and per row (x, y), so the forcing needs no trig per cell.
    this.colCos1 = new Float32Array(nx * nz);
    this.colSin1 = new Float32Array(nx * nz);
    this.colCos2 = new Float32Array(nx * nz);
    this.colSin2 = new Float32Array(nx * nz);
    this.rowSinE = new Float32Array(nx * ny);
    this.rowCosE = new Float32Array(nx * ny);
    this.time = 0;

    this.current = { x: CURRENT, y: 0, z: 0 };
    this.pulse = { x: 0, z: 0, start: -1e9 };
    // Orbital speeds per row for each wave (horizontal and vertical, per metre of amplitude times surge). Vertical motion
    // vanishes on the floor and is held down near the surface, which is drawn flat.
    const depth = SURFACE - this.min[1];
    this.swell = SWELL.map(([T, dir, a], s) => {
      const w = (2 * Math.PI) / T;
      let k = (w * w) / 9.81;
      for (let i = 0; i < 30; i++) k = (w * w) / (9.81 * Math.tanh(k * depth));
      const sh = Math.sinh(k * depth);
      const hy = new Float32Array(ny);
      const vy = new Float32Array(ny);
      for (let j = 0; j < ny; j++) {
        const y = Math.min(SURFACE, this.min[1] + j * this.cell[1]);
        const h = y - this.min[1];
        const t = Math.min(1, Math.max(0, (y - (SURFACE - 6)) / 6));
        hy[j] = (a * w * Math.cosh(k * h)) / sh;
        vy[j] = ((a * w * Math.sinh(k * h)) / sh) * (1 - 0.7 * t * t * (3 - 2 * t));
      }
      return { w, kx: k * Math.cos(dir), kz: k * Math.sin(dir), cx: Math.cos(dir), cz: Math.sin(dir), hy, vy, phase: s * 2.1 };
    });
    this.updateTotal(1);
  }

  // Points the mean current along the forest's stream (x, y, z).
  setStream(stream, speed = CURRENT) {
    const len = Math.hypot(stream[0], stream[2]) || 1;
    this.current.x = (stream[0] / len) * speed;
    this.current.z = (stream[2] / len) * speed;
  }

  // Starts a surge along the stream (dx, dz turn it; strength in m/s at full surge).
  surge(strength = 0.55, turn = 0) {
    const len = Math.hypot(this.current.x, this.current.z) || 1;
    const c = Math.cos(turn), s = Math.sin(turn);
    const x = this.current.x / len, z = this.current.z / len;
    this.pulse.x = (x * c - z * s) * strength;
    this.pulse.z = (x * s + z * c) * strength;
    this.pulse.start = this.time;
  }

  pulseAt(t) {
    const a = t - this.pulse.start;
    if (a < 0 || a > SURGE_RISE + SURGE_HOLD + SURGE_FALL) return 0;
    const e = (x) => x * x * (3 - 2 * x);
    if (a < SURGE_RISE) return e(a / SURGE_RISE);
    if (a < SURGE_RISE + SURGE_HOLD) return 1;
    return 1 - e((a - SURGE_RISE - SURGE_HOLD) / SURGE_FALL);
  }

  idx(i, j, k) {
    return i + this.nx * (j + this.ny * k);
  }

  toGrid(p) {
    return [((p.x - this.min[0]) / this.size[0]) * (this.nx - 1), ((p.y - this.min[1]) / this.size[1]) * (this.ny - 1), ((p.z - this.min[2]) / this.size[2]) * (this.nz - 1)];
  }

  // A moving sphere: the water inside moves with it; around it the water flows as past a sphere and is partly dragged
  // along, blended in toward that rather than added, so it never builds up past it.
  applyMovingSphere(pos, vel, radius = 0.58, bowRadius = 2.8) {
    const { nx, ny, nz, cell, u, v, w, tu, tv, tw } = this;
    const [fx, fy, fz] = this.toGrid(pos);
    const rGrid = bowRadius / cell[0];
    const r3 = 0.5 * radius * radius * radius;
    const i0 = Math.max(1, Math.floor(fx - rGrid)), i1 = Math.min(nx - 2, Math.ceil(fx + rGrid));
    const j0 = Math.max(1, Math.floor(fy - rGrid)), j1 = Math.min(ny - 2, Math.ceil(fy + rGrid));
    const k0 = Math.max(1, Math.floor(fz - rGrid)), k1 = Math.min(nz - 2, Math.ceil(fz + rGrid));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = (i - fx) * cell[0], dy = (j - fy) * cell[1], dz = (k - fz) * cell[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5;
          if (d >= bowRadius) continue;
          const id = this.idx(i, j, k);
          // The sphere's velocity through the water there.
          const ux = vel.x - (tu[id] - u[id]), uy = vel.y - (tv[id] - v[id]), uz = vel.z - (tw[id] - w[id]);
          if (d <= radius) {
            u[id] = ux;
            v[id] = uy;
            w[id] = uz;
          } else {
            const rx = dx / d, ry = dy / d, rz = dz / d;
            const q = r3 / (d * d * d);
            const ur = 3 * q * (rx * ux + ry * uy + rz * uz);
            const falloff = 1 - (d - radius) / (bowRadius - radius);
            const drag = 0.25 * falloff;
            const blend = 0.5 * falloff;
            u[id] += (ur * rx - q * ux + drag * ux - u[id]) * blend;
            v[id] += (ur * ry - q * uy + drag * uy - v[id]) * blend;
            w[id] += (ur * rz - q * uz + drag * uz - w[id]) * blend;
          }
        }
      }
    }
  }

  addImpulse(pos, force, radius = 4.5) {
    const { nx, ny, nz } = this;
    const [fx, fy, fz] = this.toGrid(pos);
    const rGrid = (radius / this.size[0]) * nx;
    const r2 = rGrid * rGrid;
    const i0 = Math.max(1, Math.floor(fx - rGrid)), i1 = Math.min(nx - 2, Math.ceil(fx + rGrid));
    const j0 = Math.max(1, Math.floor(fy - rGrid)), j1 = Math.min(ny - 2, Math.ceil(fy + rGrid));
    const k0 = Math.max(1, Math.floor(fz - rGrid)), k1 = Math.min(nz - 2, Math.ceil(fz + rGrid));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - fx, dy = j - fy, dz = k - fz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r2) continue;
          const falloff = Math.exp(-d2 / (r2 * 0.45));
          const id = this.idx(i, j, k);
          this.u[id] += force.x * falloff;
          this.v[id] += force.y * falloff;
          this.w[id] += force.z * falloff;
        }
      }
    }
  }

  // Trilinear sample of three fields at grid coordinates, into out[o..o+2].
  sample3(fu, fv, fw, x, y, z, out, o = 0) {
    const { nx, ny, nz } = this;
    const cx = x < 0.5 ? 0.5 : x > nx - 1.5 ? nx - 1.5 : x;
    const cy = y < 0.5 ? 0.5 : y > ny - 1.5 ? ny - 1.5 : y;
    const cz = z < 0.5 ? 0.5 : z > nz - 1.5 ? nz - 1.5 : z;
    const i0 = cx | 0, j0 = cy | 0, k0 = cz | 0;
    const sx = cx - i0, sy = cy - j0, sz = cz - k0;
    const a = i0 + nx * (j0 + ny * k0), b = a + 1, c = a + nx, d = c + 1;
    const sk = nx * ny, e = a + sk, f = b + sk, g = c + sk, h = d + sk;
    const tx = 1 - sx, ty = 1 - sy, tz = 1 - sz;
    const w00 = tx * ty * tz, w10 = sx * ty * tz, w01 = tx * sy * tz, w11 = sx * sy * tz;
    const w02 = tx * ty * sz, w12 = sx * ty * sz, w03 = tx * sy * sz, w13 = sx * sy * sz;
    out[o] = fu[a] * w00 + fu[b] * w10 + fu[c] * w01 + fu[d] * w11 + fu[e] * w02 + fu[f] * w12 + fu[g] * w03 + fu[h] * w13;
    out[o + 1] = fv[a] * w00 + fv[b] * w10 + fv[c] * w01 + fv[d] * w11 + fv[e] * w02 + fv[f] * w12 + fv[g] * w03 + fv[h] * w13;
    out[o + 2] = fw[a] * w00 + fw[b] * w10 + fw[c] * w01 + fw[d] * w11 + fw[e] * w02 + fw[f] * w12 + fw[g] * w03 + fw[h] * w13;
  }

  // The total flow at world (x, y, z), into out[o..o+2].
  sample(x, y, z, out, o = 0) {
    this.sample3(
      this.tu,
      this.tv,
      this.tw,
      ((x - this.min[0]) / this.size[0]) * (this.nx - 1),
      ((y - this.min[1]) / this.size[1]) * (this.ny - 1),
      ((z - this.min[2]) / this.size[2]) * (this.nz - 1),
      out,
      o,
    );
  }

  sampleVelocityWorld(p, out) {
    const s = this._s ?? (this._s = new Float32Array(3));
    this.sample(p.x, p.y, p.z, s);
    out.x = s[0];
    out.y = s[1];
    out.z = s[2];
    return out;
  }

  // The total flow: the simulated perturbation plus the swell (scaled by surge) and the current.
  updateTotal(surge) {
    const { nx, ny, nz, cell, u, v, w, tu, tv, tw } = this;
    const [A, B, C] = this.swell;
    const p = this.pulseAt(this.time) * surge;
    const current = { x: this.current.x + this.pulse.x * p, y: this.current.y, z: this.current.z + this.pulse.z * p };
    for (let k = 0; k < nz; k++) {
      const wz = this.min[2] + k * cell[2];
      for (let i = 0; i < nx; i++) {
        const wx = this.min[0] + i * cell[0];
        const pa = A.kx * wx + A.kz * wz - A.w * this.time + A.phase;
        const pb = B.kx * wx + B.kz * wz - B.w * this.time + B.phase;
        const pc = C.kx * wx + C.kz * wz - C.w * this.time + C.phase;
        const ca = Math.cos(pa) * surge, cb = Math.cos(pb) * surge, cc = Math.cos(pc) * surge;
        const sa = Math.sin(pa) * surge, sb = Math.sin(pb) * surge, sc = Math.sin(pc) * surge;
        const ax = ca * A.cx, bx = cb * B.cx, cx = cc * C.cx;
        const az = ca * A.cz, bz = cb * B.cz, cz = cc * C.cz;
        for (let j = 0, id = i + nx * ny * k; j < ny; j++, id += nx) {
          const ha = A.hy[j], hb = B.hy[j], hc = C.hy[j];
          tu[id] = u[id] + current.x + ha * ax + hb * bx + hc * cx;
          tv[id] = v[id] + current.y + A.vy[j] * sa + B.vy[j] * sb + C.vy[j] * sc;
          tw[id] = w[id] + current.z + ha * az + hb * bz + hc * cz;
        }
      }
    }
  }

  step(dt, surge = 1) {
    if (dt <= 0) return;
    this.time += dt;
    const { nx, ny, nz, u, v, w, u0, v0, w0, tu, tv, tw, p, div, cell } = this;
    const t = this.time;
    const sj = nx, sk = nx * ny;

    // 1. Slow eddies a few metres across, stronger toward the surface.
    for (let k = 0; k < nz; k++) {
      const wz = this.min[2] + k * cell[2];
      for (let i = 0; i < nx; i++) {
        const wx = this.min[0] + i * cell[0];
        const ph1 = 0.45 * wx + 0.3 * wz - 0.31 * t;
        const ph2 = -0.38 * wx + 0.52 * wz - 0.42 * t + 1.4;
        const c = i + nx * k;
        this.colCos1[c] = Math.cos(ph1);
        this.colSin1[c] = Math.sin(ph1);
        this.colCos2[c] = Math.cos(ph2);
        this.colSin2[c] = Math.sin(ph2);
      }
    }
    for (let j = 0; j < ny; j++) {
      const wy = this.min[1] + j * cell[1];
      for (let i = 0; i < nx; i++) {
        const wx = this.min[0] + i * cell[0];
        const ph = 0.5 * wy + 0.25 * wx - 0.37 * t;
        this.rowSinE[i + nx * j] = Math.sin(ph);
        this.rowCosE[i + nx * j] = Math.cos(ph);
      }
    }
    const damp = 1 - 0.18 * dt;
    const gain = dt * surge;
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        const wy = this.min[1] + j * cell[1];
        const atten = Math.exp(-Math.max(0, (SURFACE - wy) / 25) * 0.95);
        for (let i = 1; i < nx - 1; i++) {
          const id = i + sj * j + sk * k;
          const c = i + nx * k, r = i + nx * j;
          const c1 = this.colCos1[c], s1 = this.colSin1[c], c2 = this.colCos2[c], s2 = this.colSin2[c];
          const se = this.rowSinE[r], ce = this.rowCosE[r];
          const fx = (se * 0.03 + c2 * s1 * 0.025) * atten;
          const fy = ce * 0.012 * atten;
          const fz = (-se * 0.025 + c1 * s2 * 0.025) * atten;
          u[id] = (u[id] + fx * gain) * damp;
          v[id] = (v[id] + fy * gain) * damp;
          w[id] = (w[id] + fz * gain) * damp;
        }
      }
    }

    // 2. Vorticity confinement keeps the eddies and wakes swirling.
    const { curlX, curlY, curlZ, curlMag } = this;
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const id = i + sj * j + sk * k;
          const dwdy = (w[id + sj] - w[id - sj]) * 0.5;
          const dvdz = (v[id + sk] - v[id - sk]) * 0.5;
          const dudz = (u[id + sk] - u[id - sk]) * 0.5;
          const dwdx = (w[id + 1] - w[id - 1]) * 0.5;
          const dvdx = (v[id + 1] - v[id - 1]) * 0.5;
          const dudy = (u[id + sj] - u[id - sj]) * 0.5;
          const cx = dwdy - dvdz, cy = dudz - dwdx, cz = dvdx - dudy;
          curlX[id] = cx;
          curlY[id] = cy;
          curlZ[id] = cz;
          curlMag[id] = Math.sqrt(cx * cx + cy * cy + cz * cz);
        }
      }
    }
    const vort = 0.8 * dt;
    for (let k = 2; k < nz - 2; k++) {
      for (let j = 2; j < ny - 2; j++) {
        for (let i = 2; i < nx - 2; i++) {
          const id = i + sj * j + sk * k;
          let gx = curlMag[id + 1] - curlMag[id - 1];
          let gy = curlMag[id + sj] - curlMag[id - sj];
          let gz = curlMag[id + sk] - curlMag[id - sk];
          const len = Math.sqrt(gx * gx + gy * gy + gz * gz) + 1e-5;
          gx /= len;
          gy /= len;
          gz /= len;
          u[id] += (gy * curlZ[id] - gz * curlY[id]) * vort;
          v[id] += (gz * curlX[id] - gx * curlZ[id]) * vort;
          w[id] += (gx * curlY[id] - gy * curlX[id]) * vort;
        }
      }
    }

    // 3. Semi-Lagrangian advection by the total flow, so wakes drift with the swell and the current.
    u0.set(u);
    v0.set(v);
    w0.set(w);
    const ax = dt / cell[0], ay = dt / cell[1], az = dt / cell[2];
    const s = this._adv ?? (this._adv = new Float32Array(3));
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const id = i + sj * j + sk * k;
          this.sample3(u0, v0, w0, i - tu[id] * ax, j - tv[id] * ay, k - tw[id] * az, s);
          u[id] = s[0];
          v[id] = s[1];
          w[id] = s[2];
        }
      }
    }

    // 4. Pressure projection (div u = 0).
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const id = i + sj * j + sk * k;
          div[id] = (-0.5 * (u[id + 1] - u[id - 1] + (v[id + sj] - v[id - sj]) + (w[id + sk] - w[id - sk]))) / 3;
          p[id] = 0;
        }
      }
    }
    for (let iter = 0; iter < 10; iter++) {
      for (let k = 1; k < nz - 1; k++) {
        for (let j = 1; j < ny - 1; j++) {
          for (let i = 1; i < nx - 1; i++) {
            const id = i + sj * j + sk * k;
            p[id] = (div[id] + p[id - 1] + p[id + 1] + p[id - sj] + p[id + sj] + p[id - sk] + p[id + sk]) / 6;
          }
        }
      }
    }
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const id = i + sj * j + sk * k;
          u[id] -= 0.5 * (p[id + 1] - p[id - 1]);
          v[id] -= 0.5 * (p[id + sj] - p[id - sj]);
          w[id] -= 0.5 * (p[id + sk] - p[id - sk]);
        }
      }
    }

    // No slip on the seafloor, little vertical flow at the surface.
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        const bot = this.idx(i, 0, k);
        u[bot] = v[bot] = w[bot] = 0;
        v[this.idx(i, ny - 1, k)] *= 0.25;
      }
    }
    this.updateTotal(surge);
  }
}
