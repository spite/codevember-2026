import { restSDF } from "./bodies.js";

// Position-based soft bodies: each one is a shell of particles held by edge springs, a pressure (volume) constraint
// and a soft pull toward its best-fit rest shape. Floaters are heavier particles kept inside their own body's shell.
// Everything collides with the rotating container's field; shells of different bodies collide through a spatial hash.

const SHELL = 0;
const FLOATER = 1;

class SoftWorld {
  constructor(container, { capacity = 8000, center = [0, 0, 0] } = {}) {
    this.container = container;
    this.cap = capacity;
    this.x = new Float32Array(capacity * 3);
    this.px = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.w = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.owner = new Int32Array(capacity);
    this.contact = new Float32Array(capacity * 3);
    this.clear = new Float32Array(capacity);
    this.grad = new Float32Array(capacity * 3);
    this.n = 0;
    this.bodies = [];
    this.nextId = 0;

    this.center = center;
    this.q = [0, 0, 0, 1];
    this.omega = [0, 0, 0];
    this.gravity = 6;
    this.damping = 0.3;
    // Coulomb friction against the walls, as fractions of how far a particle was pushed back out.
    this.staticFriction = 0.4;
    this.kineticFriction = 0.25;
    this.substeps = 8;
    this.edgeCompliance = 2e-5;
    this.volumeCompliance = 2e-4;
    this.shapeStiffness = 0.25;
    this.bending = 0.25;
    this.skin = 0.12;
    this.floaterStiffness = 1;

    this.cellStart = new Int32Array(1);
    this.cellEntries = new Int32Array(capacity);
    this.cellKey = new Int32Array(capacity);
    this.cellXYZ = new Int32Array(capacity * 3);
    this.queryIds = new Int32Array(capacity);
    this._s = [0, 0, 0, 0];
  }

  // shell: from bodies.js. radius: the shell's radius at scale 1. floaters: [{ radius (fraction of the body's), mass }].
  addBody({ shell, radius, position, scale = 1, quaternion = [0, 0, 0, 1], floaters = [], data = {} }) {
    const count = shell.count, fcount = floaters.length;
    if (this.n + count + fcount > this.cap) return null;
    const body = {
      shell, radius, scale, start: this.n, count, fstart: this.n + count, fcount, floaters, data,
      q: [...quaternion], c: [...position], omega: [0, 0, 0], volume: 0, alive: true, id: this.nextId++,
      restQ: null,
    };
    const { x, px, v, w, kind, owner } = this;
    const R = radius * scale;
    for (let i = 0; i < count; i++) {
      const k = body.start + i;
      const l = rotate(body.q, shell.rest[i * 3] * R, shell.rest[i * 3 + 1] * R, shell.rest[i * 3 + 2] * R);
      x[k * 3] = px[k * 3] = position[0] + l[0];
      x[k * 3 + 1] = px[k * 3 + 1] = position[1] + l[1];
      x[k * 3 + 2] = px[k * 3 + 2] = position[2] + l[2];
      v[k * 3] = v[k * 3 + 1] = v[k * 3 + 2] = 0;
      w[k] = 1;
      this.clear[k] = 0;
      kind[k] = SHELL;
      owner[k] = body.id;
    }
    for (let j = 0; j < fcount; j++) {
      const k = body.fstart + j;
      const f = floaters[j];
      // Spread around the centre, well inside.
      const a = Math.random() * Math.PI * 2, z = Math.random() * 2 - 1, s = Math.sqrt(1 - z * z);
      const d = fcount > 1 ? R * 0.35 : 0;
      x[k * 3] = px[k * 3] = position[0] + Math.cos(a) * s * d;
      x[k * 3 + 1] = px[k * 3 + 1] = position[1] + z * d;
      x[k * 3 + 2] = px[k * 3 + 2] = position[2] + Math.sin(a) * s * d;
      v[k * 3] = v[k * 3 + 1] = v[k * 3 + 2] = 0;
      w[k] = 1 / f.mass;
      this.clear[k] = 0;
      kind[k] = FLOATER;
      owner[k] = body.id;
    }
    this.n += count + fcount;
    this.bodies.push(body);
    this.updateRadii(body);
    return body;
  }

  removeBody(body) {
    const i = this.bodies.indexOf(body);
    if (i < 0) return;
    const size = body.count + body.fcount;
    const from = body.start + size, to = body.start, tail = this.n - from;
    for (const a of [this.x, this.px, this.v, this.contact, this.grad]) a.copyWithin(to * 3, from * 3, (from + tail) * 3);
    for (const a of [this.w, this.r, this.kind, this.owner, this.clear]) a.copyWithin(to, from, from + tail);
    this.n -= size;
    this.bodies.splice(i, 1);
    for (let j = i; j < this.bodies.length; j++) {
      this.bodies[j].start -= size;
      this.bodies[j].fstart -= size;
    }
    body.alive = false;
  }

  // Particle radii follow the body's current scale.
  updateRadii(body) {
    const R = body.radius * body.scale;
    const rp = body.shell.edgeMean * R * 0.55;
    body.rp = rp;
    for (let i = 0; i < body.count; i++) this.r[body.start + i] = rp;
    if (!body.fcount) return;
    // The floaters shrink to fit the room inside the skin: loosely packed, none wider than most of it.
    const room = Math.max(R - rp - this.skin * R, 1e-3);
    let sum = 0, big = 0;
    for (const f of body.floaters) {
      const rf = f.radius * (R + rp);
      sum += rf ** 3;
      big = Math.max(big, rf);
    }
    const fit = Math.min(1, Math.cbrt((0.35 * room ** 3) / sum), (0.7 * room) / big);
    for (let j = 0; j < body.fcount; j++) this.r[body.fstart + j] = body.floaters[j].radius * (R + rp) * fit;
  }

  step(dt) {
    dt = Math.min(dt, 1 / 30);
    if (dt <= 0) return;
    for (const b of this.bodies) this.updateRadii(b);
    // Substeps of a fixed length (substeps per 1/60 s), so the solver behaves the same at any frame rate; a slow frame
    // gets at most half again as many, and the rest of its time is dropped.
    const h = 1 / (60 * this.substeps);
    this.carry = (this.carry ?? 0) + dt;
    const n = Math.min(Math.floor(this.carry / h), Math.ceil(this.substeps * 1.5));
    this.carry = n === Math.ceil(this.substeps * 1.5) ? 0 : this.carry - n * h;
    if (n === 0) return;
    dt = n * h;
    let vmax = 0;
    for (let i = 0; i < this.n; i++) vmax = Math.max(vmax, Math.abs(this.v[i * 3]) + Math.abs(this.v[i * 3 + 1]) + Math.abs(this.v[i * 3 + 2]));
    this.findPairs(Math.min(1.5 * vmax * dt + 0.005, 0.05));
    // How far anything can move toward a wall in one substep: its own travel plus the wall's.
    const om = Math.hypot(this.omega[0], this.omega[1], this.omega[2]);
    this.wallStep = (vmax * 1.5 + om * 1.8 + 0.5) * h + (this.container.t < 1 ? 0.02 : 0);
    for (let s = 0; s < n; s++) this.substep(h);
  }

  substep(h) {
    const { x, px, v, w, n } = this;
    // The container turns.
    const om = this.omega;
    const ang = Math.hypot(om[0], om[1], om[2]) * h;
    if (ang > 1e-9) {
      const sa = Math.sin(ang / 2) / (ang / h);
      this.q = qmul([om[0] * sa, om[1] * sa, om[2] * sa, Math.cos(ang / 2)], this.q);
      qnormalize(this.q);
    }
    const g = this.gravity * h;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      v[k + 1] -= g;
      px[k] = x[k];
      px[k + 1] = x[k + 1];
      px[k + 2] = x[k + 2];
      x[k] += v[k] * h;
      x[k + 1] += v[k + 1] * h;
      x[k + 2] += v[k + 2] * h;
    }
    const h2 = h * h;
    for (const b of this.bodies) {
      this.solveEdges(b, this.edgeCompliance / h2);
      this.solveVolume(b, this.volumeCompliance / h2);
      this.solveShape(b, 1 - Math.pow(1 - this.shapeStiffness, 1 / this.substeps));
      this.solveBending(b, 1 - Math.pow(1 - this.bending, 1 / this.substeps));
      this.solveFloaters(b);
    }
    this.solveShellCollisions();
    this.solveContainer(h);
    // Velocities: nothing keeps moving into a wall.
    const inv = 1 / h;
    const damp = Math.exp(-this.damping * h);
    const C = this.center, contact = this.contact;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      let vx = (x[k] - px[k]) * inv, vy = (x[k + 1] - px[k + 1]) * inv, vz = (x[k + 2] - px[k + 2]) * inv;
      const cx = contact[k], cy = contact[k + 1], cz = contact[k + 2];
      if (cx !== 0 || cy !== 0 || cz !== 0) {
        const rx = x[k] - C[0], ry = x[k + 1] - C[1], rz = x[k + 2] - C[2];
        const ux = om[1] * rz - om[2] * ry, uy = om[2] * rx - om[0] * rz, uz = om[0] * ry - om[1] * rx;
        let ax = vx - ux, ay = vy - uy, az = vz - uz;
        const vn = ax * cx + ay * cy + az * cz;
        const vnc = Math.max(vn, 0) - vn;
        vx += vnc * cx;
        vy += vnc * cy;
        vz += vnc * cz;
      }
      v[k] = vx * damp;
      v[k + 1] = vy * damp;
      v[k + 2] = vz * damp;
    }
  }

  solveEdges(b, alpha) {
    const { x, w } = this;
    const E = b.shell.edges, L = b.shell.restLen, s = b.radius * b.scale, o = b.start;
    for (let e = 0; e < L.length; e++) {
      const i = o + E[e * 2], j = o + E[e * 2 + 1];
      const wi = w[i], wj = w[j];
      const ki = i * 3, kj = j * 3;
      const dx = x[ki] - x[kj], dy = x[ki + 1] - x[kj + 1], dz = x[ki + 2] - x[kj + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const C = d - L[e] * s;
      const lambda = -C / (wi + wj + alpha) / d;
      x[ki] += dx * lambda * wi;
      x[ki + 1] += dy * lambda * wi;
      x[ki + 2] += dz * lambda * wi;
      x[kj] -= dx * lambda * wj;
      x[kj + 1] -= dy * lambda * wj;
      x[kj + 2] -= dz * lambda * wj;
    }
  }

  solveVolume(b, alpha) {
    const { x, w, grad } = this;
    const I = b.shell.index, o = b.start;
    for (let i = 0; i < b.count; i++) grad[(o + i) * 3] = grad[(o + i) * 3 + 1] = grad[(o + i) * 3 + 2] = 0;
    let V = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = (o + I[t]) * 3, c = (o + I[t + 1]) * 3, d = (o + I[t + 2]) * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const bx = x[c], by = x[c + 1], bz = x[c + 2];
      const cx = x[d], cy = x[d + 1], cz = x[d + 2];
      // Relative to the first vertex keeps it precise far from the origin.
      const ex = bx - ax, ey = by - ay, ez = bz - az, fx = cx - ax, fy = cy - ay, fz = cz - az;
      const crx = ey * fz - ez * fy, cry = ez * fx - ex * fz, crz = ex * fy - ey * fx;
      V += ax * crx + ay * cry + az * crz;
      // dV/dx for each corner: cross of the other two (in order).
      grad[a] += by * cz - bz * cy;
      grad[a + 1] += bz * cx - bx * cz;
      grad[a + 2] += bx * cy - by * cx;
      grad[c] += cy * az - cz * ay;
      grad[c + 1] += cz * ax - cx * az;
      grad[c + 2] += cx * ay - cy * ax;
      grad[d] += ay * bz - az * by;
      grad[d + 1] += az * bx - ax * bz;
      grad[d + 2] += ax * by - ay * bx;
    }
    V /= 6;
    b.volume = V;
    const s = b.radius * b.scale;
    const C = V - b.shell.volume * s * s * s;
    let denom = alpha;
    for (let i = 0; i < b.count; i++) {
      const k = (o + i) * 3;
      denom += w[o + i] * (grad[k] * grad[k] + grad[k + 1] * grad[k + 1] + grad[k + 2] * grad[k + 2]) / 36;
    }
    if (denom < 1e-12) return;
    const lambda = -C / denom / 6;
    for (let i = 0; i < b.count; i++) {
      const k = (o + i) * 3, wi = w[o + i] * lambda;
      x[k] += grad[k] * wi;
      x[k + 1] += grad[k + 1] * wi;
      x[k + 2] += grad[k + 2] * wi;
    }
  }

  // Pull toward the rest shape under the best-fit rotation (shape matching), which keeps shells from tangling.
  solveShape(b, k) {
    const { x } = this;
    const rest = b.shell.rest, o = b.start, nb = b.count;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < nb; i++) {
      cx += x[(o + i) * 3];
      cy += x[(o + i) * 3 + 1];
      cz += x[(o + i) * 3 + 2];
    }
    cx /= nb;
    cy /= nb;
    cz /= nb;
    b.c[0] = cx;
    b.c[1] = cy;
    b.c[2] = cz;
    // A = sum (x - c) rest^T, by columns.
    let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
    for (let i = 0; i < nb; i++) {
      const p = (o + i) * 3, q = i * 3;
      const dx = x[p] - cx, dy = x[p + 1] - cy, dz = x[p + 2] - cz;
      const qx = rest[q], qy = rest[q + 1], qz = rest[q + 2];
      a00 += dx * qx; a01 += dx * qy; a02 += dx * qz;
      a10 += dy * qx; a11 += dy * qy; a12 += dy * qz;
      a20 += dz * qx; a21 += dz * qy; a22 += dz * qz;
    }
    extractRotation(b.q, a00, a01, a02, a10, a11, a12, a20, a21, a22);
    // A body squashed far past a normal squish (crushed under others) firms up until it recovers.
    const crush = Math.min(Math.max(((b.deviation ?? 0) - 0.22) * 1.5, 0), 0.3);
    k = Math.max(k, crush);
    if (k <= 0) return;
    const s = b.radius * b.scale;
    const m = qmat(b.q);
    let dev = 0;
    for (let i = 0; i < nb; i++) {
      const p = (o + i) * 3, q = i * 3;
      const qx = rest[q] * s, qy = rest[q + 1] * s, qz = rest[q + 2] * s;
      const gx = cx + m[0] * qx + m[3] * qy + m[6] * qz;
      const gy = cy + m[1] * qx + m[4] * qy + m[7] * qz;
      const gz = cz + m[2] * qx + m[5] * qy + m[8] * qz;
      dev += Math.hypot(gx - x[p], gy - x[p + 1], gz - x[p + 2]);
      x[p] += (gx - x[p]) * k;
      x[p + 1] += (gy - x[p + 1]) * k;
      x[p + 2] += (gz - x[p + 2]) * k;
    }
    b.deviation = dev / nb / s;
  }

  // Keeps the skin's local curvature: each particle toward its neighbours' mean plus its rotated rest offset, so a
  // soft shell squashes and stretches without folding into creases.
  solveBending(b, k) {
    if (k <= 0) return;
    const { x, grad } = this;
    const { edges: E, valence, lap } = b.shell;
    const o = b.start, n = b.count, s = b.radius * b.scale;
    for (let i = 0; i < n * 3; i++) grad[o * 3 + i] = 0;
    for (let e = 0; e < E.length; e += 2) {
      const i = (o + E[e]) * 3, j = (o + E[e + 1]) * 3;
      grad[i] += x[j];
      grad[i + 1] += x[j + 1];
      grad[i + 2] += x[j + 2];
      grad[j] += x[i];
      grad[j + 1] += x[i + 1];
      grad[j + 2] += x[i + 2];
    }
    const m = qmat(b.q);
    for (let v = 0; v < n; v++) {
      const p = (o + v) * 3, q = v * 3, inv = 1 / valence[v];
      const lx = lap[q] * s, ly = lap[q + 1] * s, lz = lap[q + 2] * s;
      const tx = grad[p] * inv + m[0] * lx + m[3] * ly + m[6] * lz;
      const ty = grad[p + 1] * inv + m[1] * lx + m[4] * ly + m[7] * lz;
      const tz = grad[p + 2] * inv + m[2] * lx + m[5] * ly + m[8] * lz;
      x[p] += (tx - x[p]) * k;
      x[p + 1] += (ty - x[p + 1]) * k;
      x[p + 2] += (tz - x[p + 2]) * k;
    }
  }

  // Floaters push the shell's particles and each other, and never leave the rest shape (under the best fit).
  solveFloaters(b) {
    if (!b.fcount) return;
    const { x, w, r } = this;
    const s = b.radius * b.scale;
    // The skin's thickness: floaters stay this far inside the shell's particles, so they never reach its surface.
    const skin = this.skin * s;
    const m = qmat(b.q);
    const c = b.c;
    for (let j = 0; j < b.fcount; j++) {
      const f = b.fstart + j, kf = f * 3, rf = r[f], wf = w[f];
      for (let i = 0; i < b.count; i++) {
        const p = b.start + i, kp = p * 3;
        const dx = x[kf] - x[kp], dy = x[kf + 1] - x[kp + 1], dz = x[kf + 2] - x[kp + 2];
        const min = rf + r[p] + skin;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= min * min || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const corr = (min - d) / (wf + w[p]) / d;
        x[kf] += dx * corr * wf;
        x[kf + 1] += dy * corr * wf;
        x[kf + 2] += dz * corr * wf;
        x[kp] -= dx * corr * w[p];
        x[kp + 1] -= dy * corr * w[p];
        x[kp + 2] -= dz * corr * w[p];
      }
      for (let jj = j + 1; jj < b.fcount; jj++) {
        const g = b.fstart + jj, kg = g * 3;
        const dx = x[kf] - x[kg], dy = x[kf + 1] - x[kg + 1], dz = x[kf + 2] - x[kg + 2];
        const min = rf + r[g];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= min * min || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const corr = (min - d) / (wf + w[g]) / d;
        x[kf] += dx * corr * wf;
        x[kf + 1] += dy * corr * wf;
        x[kf + 2] += dz * corr * wf;
        x[kg] -= dx * corr * w[g];
        x[kg + 1] -= dy * corr * w[g];
        x[kg + 2] -= dz * corr * w[g];
      }
      // Backstop: inside the matched rest shape.
      const dx = x[kf] - c[0], dy = x[kf + 1] - c[1], dz = x[kf + 2] - c[2];
      const lx = (m[0] * dx + m[1] * dy + m[2] * dz) / s, ly = (m[3] * dx + m[4] * dy + m[5] * dz) / s, lz = (m[6] * dx + m[7] * dy + m[8] * dz) / s;
      const d = restSDF(b.shell, lx, ly, lz) * s + rf + skin;
      if (d > 0) {
        const len = Math.hypot(dx, dy, dz) || 1;
        const pull = Math.min(d, len) / len;
        x[kf] -= dx * pull;
        x[kf + 1] -= dy * pull;
        x[kf + 2] -= dz * pull;
      }
    }
  }

  // Candidate pairs of shell particles from different bodies, gathered once per frame with room for the frame's travel.
  findPairs(margin) {
    const { x, r, kind, owner, n, cellEntries, cellKey, cellXYZ } = this;
    let maxR = 0;
    for (let i = 0; i < n; i++) if (kind[i] === SHELL && r[i] > maxR) maxR = r[i];
    this.pairCount = 0;
    if (maxR <= 0) return;
    const reach = 2 * maxR + margin;
    const invS = 1 / reach;
    // A power-of-two table about twice the particle count, so clearing it costs as little as filling it.
    let hashSize = 1024;
    while (hashSize < n * 2) hashSize *= 2;
    const mask = hashSize - 1;
    if (this.cellStart.length !== hashSize + 1) this.cellStart = new Int32Array(hashSize + 1);
    const cellStart = this.cellStart;
    const hash = (ix, iy, iz) => (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481)) & mask;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      if (kind[i] !== SHELL) continue;
      const ix = Math.floor(x[i * 3] * invS), iy = Math.floor(x[i * 3 + 1] * invS), iz = Math.floor(x[i * 3 + 2] * invS);
      cellXYZ[i * 3] = ix;
      cellXYZ[i * 3 + 1] = iy;
      cellXYZ[i * 3 + 2] = iz;
      const hsh = hash(ix, iy, iz);
      cellKey[i] = hsh;
      cellStart[hsh]++;
    }
    let start = 0;
    for (let i = 0; i < hashSize; i++) {
      start += cellStart[i];
      cellStart[i] = start;
    }
    cellStart[hashSize] = start;
    for (let i = 0; i < n; i++) if (kind[i] === SHELL) cellEntries[--cellStart[cellKey[i]]] = i;
    let pairs = this.pairs ?? (this.pairs = new Int32Array(1 << 16));
    let count = 0;
    // Own cell (later particles only) and the 13 cells "ahead" of it: each neighbouring pair of cells is visited once.
    const AHEAD = this.ahead ?? (this.ahead = aheadCells());
    for (let i = 0; i < n; i++) {
      if (kind[i] !== SHELL) continue;
      const ki = i * 3;
      const xi = x[ki], yi = x[ki + 1], zi = x[ki + 2];
      const ix = cellXYZ[ki], iy = cellXYZ[ki + 1], iz = cellXYZ[ki + 2];
      const oi = owner[i], ri = r[i] + margin;
      for (let c = 0; c < AHEAD.length; c += 3) {
        const own = c === 0;
        const hsh = hash(ix + AHEAD[c], iy + AHEAD[c + 1], iz + AHEAD[c + 2]);
        for (let e = cellStart[hsh], end = cellStart[hsh + 1]; e < end; e++) {
          const j = cellEntries[e];
          if ((own && j <= i) || j === i || owner[j] === oi) continue;
          const kj = j * 3;
          const dx = xi - x[kj], dy = yi - x[kj + 1], dz = zi - x[kj + 2];
          const lim = ri + r[j];
          if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
          if (count * 2 + 2 > pairs.length) {
            const grown = new Int32Array(pairs.length * 2);
            grown.set(pairs);
            pairs = this.pairs = grown;
          }
          pairs[count * 2] = i;
          pairs[count * 2 + 1] = j;
          count++;
        }
      }
    }
    this.pairCount = count;
  }

  solveShellCollisions() {
    const { x, w, r, pairs, pairCount } = this;
    for (let p = 0; p < pairCount; p++) {
      const i = pairs[p * 2], j = pairs[p * 2 + 1];
      const ki = i * 3, kj = j * 3;
      const dx = x[ki] - x[kj], dy = x[ki + 1] - x[kj + 1], dz = x[ki + 2] - x[kj + 2];
      const min = r[i] + r[j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= min * min || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const corr = (min - d) / (w[i] + w[j]) / d;
      x[ki] += dx * corr * w[i];
      x[ki + 1] += dy * corr * w[i];
      x[ki + 2] += dz * corr * w[i];
      x[kj] -= dx * corr * w[j];
      x[kj + 1] -= dy * corr * w[j];
      x[kj + 2] -= dz * corr * w[j];
    }
  }

  solveContainer(h) {
    const { x, px, r, n, contact, container, clear, wallStep } = this;
    const om = this.omega, muS = this.staticFriction, muK = this.kineticFriction;
    const C = this.center, s = this._s;
    const m = qmat(this.q);
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      // Well inside: skip until it could have reached a wall.
      if (clear[i] > 0) {
        contact[k] = contact[k + 1] = contact[k + 2] = 0;
        clear[i] -= wallStep;
        continue;
      }
      const dx = x[k] - C[0], dy = x[k + 1] - C[1], dz = x[k + 2] - C[2];
      // World to container: the transpose.
      const lx = m[0] * dx + m[1] * dy + m[2] * dz, ly = m[3] * dx + m[4] * dy + m[5] * dz, lz = m[6] * dx + m[7] * dy + m[8] * dz;
      contact[k] = contact[k + 1] = contact[k + 2] = 0;
      container.sample(lx, ly, lz, s);
      const pen = s[0] + r[i];
      if (pen <= 0) {
        clear[i] = -pen - wallStep;
        continue;
      }
      // Normal back to world.
      const nx = m[0] * s[1] + m[3] * s[2] + m[6] * s[3], ny = m[1] * s[1] + m[4] * s[2] + m[7] * s[3], nz = m[2] * s[1] + m[5] * s[2] + m[8] * s[3];
      x[k] -= nx * pen;
      x[k + 1] -= ny * pen;
      x[k + 2] -= nz * pen;
      // Slip along the wall this substep, relative to the wall's own motion.
      let tx = x[k] - px[k] - (om[1] * dz - om[2] * dy) * h, ty = x[k + 1] - px[k + 1] - (om[2] * dx - om[0] * dz) * h, tz = x[k + 2] - px[k + 2] - (om[0] * dy - om[1] * dx) * h;
      const tn = tx * nx + ty * ny + tz * nz;
      tx -= tn * nx;
      ty -= tn * ny;
      tz -= tn * nz;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-9) {
        const f = tl < muS * pen ? 1 : Math.min(1, (muK * pen) / tl);
        x[k] -= tx * f;
        x[k + 1] -= ty * f;
        x[k + 2] -= tz * f;
      }
      contact[k] = -nx;
      contact[k + 1] = -ny;
      contact[k + 2] = -nz;
    }
  }

  // How restless the bodies are: the fastest particle relative to the container's own spin, and the most deformed
  // body (mean distance from its best-fit rest shape, in radii). Both spike when the solver goes unstable.
  unrest() {
    const { x, v, n, center: C, omega: om } = this;
    let vmax = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const rx = x[k] - C[0], ry = x[k + 1] - C[1], rz = x[k + 2] - C[2];
      const vx = v[k] - (om[1] * rz - om[2] * ry), vy = v[k + 1] - (om[2] * rx - om[0] * rz), vz = v[k + 2] - (om[0] * ry - om[1] * rx);
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > vmax) vmax = s2;
    }
    let deviation = 0;
    for (const b of this.bodies) if (b.scale > 0.9) deviation = Math.max(deviation, b.deviation ?? 0);
    return { speed: Math.sqrt(vmax), deviation };
  }

  // The world position of a point given in container coordinates.
  toWorld(lx, ly, lz) {
    const p = rotate(this.q, lx, ly, lz);
    return [p[0] + this.center[0], p[1] + this.center[1], p[2] + this.center[2]];
  }
}

function aheadCells() {
  const out = [0, 0, 0];
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++)
      for (let c = -1; c <= 1; c++) if (a > 0 || (a === 0 && (b > 0 || (b === 0 && c > 0)))) out.push(a, b, c);
  return Int32Array.from(out);
}

function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qnormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l;
  q[1] /= l;
  q[2] /= l;
  q[3] /= l;
  return q;
}

// Column-major rotation matrix of a unit quaternion.
function qmat(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}

function rotate(q, x, y, z) {
  const m = qmat(q);
  return [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
}

// Rotational part of A (Müller et al. 2016), warm-started from q, which it updates.
function extractRotation(q, a00, a01, a02, a10, a11, a12, a20, a21, a22) {
  for (let it = 0; it < 4; it++) {
    const m = qmat(q);
    // Columns of R: (m0,m1,m2), (m3,m4,m5), (m6,m7,m8); columns of A: (a00,a10,a20), ...
    const ox = m[1] * a20 - m[2] * a10 + (m[4] * a21 - m[5] * a11) + (m[7] * a22 - m[8] * a12);
    const oy = m[2] * a00 - m[0] * a20 + (m[5] * a01 - m[3] * a21) + (m[8] * a02 - m[6] * a22);
    const oz = m[0] * a10 - m[1] * a00 + (m[3] * a11 - m[4] * a01) + (m[6] * a12 - m[7] * a02);
    const dot = m[0] * a00 + m[1] * a10 + m[2] * a20 + m[3] * a01 + m[4] * a11 + m[5] * a21 + m[6] * a02 + m[7] * a12 + m[8] * a22;
    const inv = 1 / (Math.abs(dot) + 1e-9);
    const wx = ox * inv, wy = oy * inv, wz = oz * inv;
    const angle = Math.hypot(wx, wy, wz);
    if (angle < 1e-9) break;
    const s = Math.sin(angle / 2) / angle;
    const r = qmul([wx * s, wy * s, wz * s, Math.cos(angle / 2)], q);
    q[0] = r[0];
    q[1] = r[1];
    q[2] = r[2];
    q[3] = r[3];
    qnormalize(q);
  }
}

export { SoftWorld, SHELL, FLOATER, qmat, qmul, qnormalize, rotate };
