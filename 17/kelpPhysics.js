import { DataTexture, RGBAFormat, FloatType, NearestFilter } from "three";
import { SEGS_PER_COL, COLUMN_STRIDE, BLADE_STRIDE, KINDS, SURFACE } from "./kelpBuilder.js";
import { BLADE_ROW } from "./kelpVertex.js";

const S = SEGS_PER_COL;
// Each kind's blades: how far they may swing from rest (rad) and how stiffly they spring back (1/s²). Every blade varies
// the stiffness a little, so neighbours don't swing in lockstep.
const HINGES = {
  [KINDS.giant]: { maxAngle: 1.6, hinge: 2.5 },
  [KINDS.bull]: { maxAngle: 2.2, hinge: 0.3 },
  [KINDS.palm]: { maxAngle: 1.0, hinge: 2.5 },
};
// Velocity kept per step, and how fast a blade tip takes up the flow past it (1/s).
const DAMPING = 0.995;
const BLADE_DRAG = 20;

// The four nodes and Catmull-Rom weights at height h (0..1) on a stipe, exactly as kelpVertex.js's stipeNode() reads them.
function catmullRom(h, nodes, weights, o) {
  const f = Math.max(0, Math.min(1, h)) * (S - 1);
  const i = Math.min(Math.floor(f), S - 2);
  const t = f - i, t2 = t * t, t3 = t2 * t;
  nodes[o] = Math.max(i - 1, 0);
  nodes[o + 1] = i;
  nodes[o + 2] = i + 1;
  nodes[o + 3] = Math.min(i + 2, S - 1);
  weights[o] = 0.5 * (2 * t2 - t - t3);
  weights[o + 1] = 0.5 * (2 - 5 * t2 + 3 * t3);
  weights[o + 2] = 0.5 * (t + 4 * t2 - 3 * t3);
  weights[o + 3] = 0.5 * (t3 - t2);
  return t;
}

const hash = (i) => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Every stipe is a chain of SEGS_PER_COL inextensible Verlet nodes pinned at its holdfast; every simulated blade is a tip
// particle hinged to its point on the stipe. The built forest is the forest at rest in the mean current, so stipes and
// blades are dragged by the flow that differs from it (the swell, eddies, wakes and stirs), and come to rest where they
// were built. Fluid drag, a cone limit on the hinge, the blade length and the probe sphere are solved together, so a
// blade pushed past its hinge range pulls the stipe with it. Buoyant stipes float up to the surface and no further.
// A blade hangs from its stipe's Catmull-Rom curve through the nodes (as the shader draws it) plus a fixed offset to where
// it was drawn.
// The shaders read three float textures: per stipe its node offsets from rest (and the flow past each node), then the
// plant's kind, age and blade flexibility; per blade its rotation, and its rest direction and length (negative for a blade
// without physics, which leans with its stipe in the shader instead).
export class KelpPhysicsSim {
  // columns and blades: the packed layout from buildKelpForestGeometry. maxSimulated caps the blades simulated; past it
  // the shortest ones only lean with their stipe.
  constructor({ columns, blades }, { maxSimulated = Infinity } = {}) {
    const nc = (this.numCols = columns.length / COLUMN_STRIDE);
    this.rest = new Float32Array(nc * S * 3);
    this.segLen = new Float32Array(nc * (S - 1));
    this.speed = new Float32Array(nc * S);
    this.colDrag = new Float32Array(nc);
    this.colStiff = new Float32Array(nc);
    this.colBuoy = new Float32Array(nc);
    this.colTop = new Float32Array(nc);
    this.colLid = new Float32Array(nc);
    this.colActive = new Uint8Array(nc);
    const kinds = new Uint8Array(nc);
    const info = new Float32Array(nc * 4);
    for (let c = 0; c < nc; c++) {
      const o = c * COLUMN_STRIDE;
      this.rest.set(columns.subarray(o, o + S * 3), c * S * 3);
      for (let i = 0; i < S - 1; i++) {
        const a = o + i * 3, b = a + 3;
        this.segLen[c * (S - 1) + i] = Math.hypot(columns[b] - columns[a], columns[b + 1] - columns[a + 1], columns[b + 2] - columns[a + 2]);
      }
      const [swayAmp, stiffness, buoyancy, topBuoy, kind, age, flex] = columns.subarray(o + S * 3, o + COLUMN_STRIDE);
      this.colDrag[c] = 3 * swayAmp;
      this.colStiff[c] = stiffness;
      this.colBuoy[c] = buoyancy;
      this.colTop[c] = topBuoy;
      // The highest a node may float: just under the surface (a bull kelp's float a little lower), and never below where
      // it was built.
      let lid = kind === KINDS.bull ? SURFACE - 0.25 : SURFACE - 0.1;
      for (let i = 1; i < S; i++) lid = Math.max(lid, columns[o + i * 3 + 1]);
      this.colLid[c] = lid;
      kinds[c] = kind;
      info.set([kind, age, flex, 0], c * 4);
    }
    this.pos = this.rest.slice();
    this.prev = this.rest.slice();
    this.target = this.rest.slice();
    this.balance(kinds);

    // The blades with physics: the longest, up to maxSimulated.
    const nb = blades.length / BLADE_STRIDE;
    let sim = [];
    for (let b = 0; b < nb; b++) if (blades[b * BLADE_STRIDE + 12] > 0.5) sim.push(b);
    if (sim.length > maxSimulated) {
      sim.sort((a, b) => blades[b * BLADE_STRIDE + 8] - blades[a * BLADE_STRIDE + 8] || a - b);
      sim = sim.slice(0, maxSimulated).sort((a, b) => a - b);
    }
    const n = (this.numSim = sim.length);
    this.simIndex = Int32Array.from(sim);
    this.simNode = new Int32Array(n * 4);
    this.simW = new Float32Array(n * 4);
    this.simPush = new Float32Array(n * 2);
    this.simOff = new Float32Array(n * 3);
    this.tip = new Float32Array(n * 3);
    this.prevTip = new Float32Array(n * 3);
    this.restDir = new Float32Array(n * 3);
    this.len = new Float32Array(n);
    this.halfW = new Float32Array(n);
    this.cosMax = new Float32Array(n);
    this.sinMax = new Float32Array(n);
    this.hinge = new Float32Array(n);
    const nodes = new Int32Array(4);
    for (let k = 0; k < n; k++) {
      const b = sim[k], o = b * BLADE_STRIDE;
      const col = blades[o];
      this.colActive[col] = 1;
      const t = catmullRom(blades[o + 1], nodes, this.simW, k * 4);
      for (let j = 0; j < 4; j++) this.simNode[k * 4 + j] = (col * S + nodes[j]) * 3;
      // The stipe takes a blade's pushes at its two nearest nodes; the holdfast never moves.
      this.simPush[k * 2] = nodes[1] > 0 ? 1 - t : 0;
      this.simPush[k * 2 + 1] = t;
      const L = blades[o + 8];
      for (let j = 0; j < 3; j++) {
        let cr = 0;
        for (let q = 0; q < 4; q++) cr += this.rest[this.simNode[k * 4 + q] + j] * this.simW[k * 4 + q];
        const attach = blades[o + 2 + j], dir = blades[o + 5 + j];
        this.simOff[k * 3 + j] = attach - cr;
        this.restDir[k * 3 + j] = dir;
        this.tip[k * 3 + j] = this.prevTip[k * 3 + j] = attach + dir * L;
      }
      const { maxAngle, hinge } = HINGES[kinds[col]] ?? HINGES[KINDS.giant];
      this.len[k] = L;
      this.halfW[k] = blades[o + 9];
      this.cosMax[k] = Math.cos(maxAngle);
      this.sinMax[k] = Math.sin(maxAngle);
      this.hinge[k] = hinge * (0.7 + 0.6 * hash(b));
    }

    // Stipe rows: node offsets from rest (xyz) and the flow past them (w), then the plant's info.
    this.deltaData = new Float32Array((S + 1) * nc * 4);
    this.deltaTexture = makeTexture(this.deltaData, S + 1, nc);
    for (let c = 0; c < nc; c++) this.deltaData.set(info.subarray(c * 4, c * 4 + 4), (c * (S + 1) + S) * 4);
    // Blade textures, one texel per blade: rest direction and signed length (static), and rotation (only rows that hold
    // simulated blades are uploaded; the shader never reads the others).
    const rows = Math.max(1, Math.ceil(nb / BLADE_ROW));
    this.bladeRestData = new Float32Array(BLADE_ROW * rows * 4);
    this.bladeRestTexture = makeTexture(this.bladeRestData, BLADE_ROW, rows);
    this.bladeQuatData = new Float32Array(BLADE_ROW * rows * 4);
    this.bladeQuatTexture = makeTexture(this.bladeQuatData, BLADE_ROW, rows);
    const simulated = new Uint8Array(nb);
    for (const b of sim) simulated[b] = 1;
    for (let b = 0; b < nb; b++) {
      const o = b * BLADE_STRIDE;
      this.bladeRestData.set(blades.subarray(o + 5, o + 8), b * 4);
      this.bladeRestData[b * 4 + 3] = simulated[b] ? blades[o + 8] : -blades[o + 8];
      this.bladeQuatData[b * 4 + 3] = 1;
    }
    // Per row, the span of simulated blades to upload: [start, count] in floats.
    this.quatRanges = [];
    for (let k = 0; k < n; ) {
      const row = Math.floor(sim[k] / BLADE_ROW);
      let last = k;
      while (last + 1 < n && Math.floor(sim[last + 1] / BLADE_ROW) === row) last++;
      this.quatRanges.push([sim[k] * 4, (sim[last] - sim[k] + 1) * 4]);
      k = last + 1;
    }

    this._f = new Float32Array(3);
    this.uploadTextures();
  }

  // Buoyancy pulls a curved giant stipe straighter; its spring is aimed past the built pose by as much, so the stipe
  // rests where it was built. Found by a few damped static solves of the stipes alone.
  balance(kinds, passes = 2, steps = 60) {
    const { numCols: nc, rest, target, segLen, colStiff, colBuoy, colTop, colLid } = this;
    const p = new Float32Array(rest.length);
    const q = new Float32Array(rest.length);
    const dt = 0.1, dt2 = dt * dt;
    for (let pass = 0; pass < passes; pass++) {
      for (let c = 0; c < nc; c++) {
        if (kinds[c] !== KINDS.giant) continue;
        const o = c * S * 3;
        p.set(rest.subarray(o, o + S * 3), o);
        q.set(rest.subarray(o, o + S * 3), o);
        const k = colStiff[c], lid = colLid[c];
        // Critically damped, so it settles in a few time constants.
        const keep = Math.max(0, 1 - 2 * Math.sqrt(k) * dt);
        for (let s = 0; s < steps; s++) {
          for (let i = 1; i < S; i++) {
            const i3 = o + i * 3;
            const lift = colBuoy[c] + (i === S - 1 ? colTop[c] : 0);
            for (let j = 0; j < 3; j++) {
              const x = p[i3 + j];
              const v = (x - q[i3 + j]) * keep;
              q[i3 + j] = x;
              p[i3 + j] = x + v + ((target[i3 + j] - x) * k + (j === 1 ? lift : 0)) * dt2;
            }
          }
          for (let it = 0; it < 2; it++) {
            for (let i = 0; i < S - 1; i++) {
              const a = o + i * 3, b = a + 3;
              const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
              const diff = (dist - segLen[c * (S - 1) + i]) / dist;
              const wa = i === 0 ? 0 : 0.5, wb = i === 0 ? 1 : 0.5;
              p[a] += dx * diff * wa;
              p[a + 1] += dy * diff * wa;
              p[a + 2] += dz * diff * wa;
              p[b] -= dx * diff * wb;
              p[b + 1] -= dy * diff * wb;
              p[b + 2] -= dz * diff * wb;
            }
            for (let i = 1; i < S; i++) if (p[o + i * 3 + 1] > lid) p[o + i * 3 + 1] = lid;
          }
        }
        for (let i = 1; i < S; i++) {
          const i3 = o + i * 3;
          target[i3] -= p[i3] - rest[i3];
          target[i3 + 2] -= p[i3 + 2] - rest[i3 + 2];
          // A node buoyed against the surface keeps its height there.
          if (p[i3 + 1] < lid - 1e-3) target[i3 + 1] -= p[i3 + 1] - rest[i3 + 1];
        }
      }
    }
  }

  step(dt, fluid, spherePos, sphereRadius, sphereOn, iterations = 4) {
    if (dt <= 0) return;
    const { numCols: nc, numSim: n, pos, prev, target, speed, colDrag, colStiff, colBuoy, colTop, simNode, simW, simOff, tip, prevTip, restDir, len, hinge } = this;
    const f = this._f;
    const cur = fluid.current;
    const dt2 = dt * dt;
    const idt = 1 / dt;

    // 1. Verlet for the stipe nodes: drag toward the water beyond the mean current, a spring to rest (balanced), buoyancy.
    for (let c = 0; c < nc; c++) {
      const drag = colDrag[c], stiff = colStiff[c], buoy = colBuoy[c], top = colTop[c];
      for (let i = 1; i < S; i++) {
        const i3 = (c * S + i) * 3;
        const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
        const vx = (px - prev[i3]) * DAMPING, vy = (py - prev[i3 + 1]) * DAMPING, vz = (pz - prev[i3 + 2]) * DAMPING;
        prev[i3] = px;
        prev[i3 + 1] = py;
        prev[i3 + 2] = pz;
        fluid.sample(px, py, pz, f);
        // The flow past the node, for the shader's flutter.
        const rx = f[0] - vx * idt, ry = f[1] - vy * idt, rz = f[2] - vz * idt;
        speed[c * S + i] = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const ax = (rx - cur.x) * drag + (target[i3] - px) * stiff;
        const ay = (ry - cur.y) * drag + (target[i3 + 1] - py) * stiff + buoy + (i === S - 1 ? top : 0);
        const az = (rz - cur.z) * drag + (target[i3 + 2] - pz) * stiff;
        pos[i3] = px + vx + ax * dt2;
        pos[i3 + 1] = py + vy + ay * dt2;
        pos[i3 + 2] = pz + vz + az * dt2;
      }
      speed[c * S] = speed[c * S + 1];
    }

    // 2. Verlet for the blade tips: drag by the flow past the blade beyond the mean current (its rest pose already hangs
    // in that), and a spring back to the rest direction.
    for (let k = 0; k < n; k++) {
      const k3 = k * 3, k4 = k * 4;
      const n0 = simNode[k4], n1 = simNode[k4 + 1], n2 = simNode[k4 + 2], n3 = simNode[k4 + 3];
      const w0 = simW[k4], w1 = simW[k4 + 1], w2 = simW[k4 + 2], w3 = simW[k4 + 3];
      const ax = pos[n0] * w0 + pos[n1] * w1 + pos[n2] * w2 + pos[n3] * w3 + simOff[k3];
      const ay = pos[n0 + 1] * w0 + pos[n1 + 1] * w1 + pos[n2 + 1] * w2 + pos[n3 + 1] * w3 + simOff[k3 + 1];
      const az = pos[n0 + 2] * w0 + pos[n1 + 2] * w1 + pos[n2 + 2] * w2 + pos[n3 + 2] * w3 + simOff[k3 + 2];
      const tx = tip[k3], ty = tip[k3 + 1], tz = tip[k3 + 2];
      const vx = (tx - prevTip[k3]) * DAMPING, vy = (ty - prevTip[k3 + 1]) * DAMPING, vz = (tz - prevTip[k3 + 2]) * DAMPING;
      prevTip[k3] = tx;
      prevTip[k3 + 1] = ty;
      prevTip[k3 + 2] = tz;
      fluid.sample((ax + tx) * 0.5, (ay + ty) * 0.5, (az + tz) * 0.5, f);
      const L = len[k], h = hinge[k];
      const fx = (f[0] - cur.x - vx * idt) * BLADE_DRAG + (ax + restDir[k3] * L - tx) * h;
      const fy = (f[1] - cur.y - vy * idt) * BLADE_DRAG + (ay + restDir[k3 + 1] * L - ty) * h;
      const fz = (f[2] - cur.z - vz * idt) * BLADE_DRAG + (az + restDir[k3 + 2] * L - tz) * h;
      tip[k3] = tx + vx + fx * dt2;
      tip[k3 + 1] = ty + vy + fy * dt2;
      tip[k3 + 2] = tz + vz + fz * dt2;
    }

    // 3. Constraints: blades (sphere, hinge cone, length) feeding back into their stipes, then the stipes.
    for (let iter = 0; iter < iterations; iter++) {
      if (n > 0) this.solveBlades(spherePos, sphereRadius, sphereOn);
      this.solveStipes(iter, spherePos, sphereRadius, sphereOn);
    }
  }

  solveBlades(sp, sr, sphereOn) {
    const { numSim: n, pos, simNode, simW, simPush, simOff, tip, restDir, len, halfW, cosMax, sinMax } = this;
    const lid = SURFACE - 0.05;
    for (let k = 0; k < n; k++) {
      const k3 = k * 3, k4 = k * 4;
      const n0 = simNode[k4], n1 = simNode[k4 + 1], n2 = simNode[k4 + 2], n3 = simNode[k4 + 3];
      const w0 = simW[k4], w1 = simW[k4 + 1], w2 = simW[k4 + 2], w3 = simW[k4 + 3];
      const push1 = simPush[k * 2], push2 = simPush[k * 2 + 1];
      const ox = simOff[k3], oy = simOff[k3 + 1], oz = simOff[k3 + 2];
      let ax = pos[n0] * w0 + pos[n1] * w1 + pos[n2] * w2 + pos[n3] * w3 + ox;
      let ay = pos[n0 + 1] * w0 + pos[n1 + 1] * w1 + pos[n2 + 1] * w2 + pos[n3 + 1] * w3 + oy;
      let az = pos[n0 + 2] * w0 + pos[n1 + 2] * w1 + pos[n2 + 2] * w2 + pos[n3 + 2] * w3 + oz;
      let tx = tip[k3], ty = tip[k3 + 1], tz = tip[k3 + 2];
      const L = len[k];

      if (sphereOn) {
        const clearBladeR = sr + halfW[k] * 0.85 + 0.14;
        const bdx = tx - ax, bdy = ty - ay, bdz = tz - az;
        const len2 = bdx * bdx + bdy * bdy + bdz * bdz + 1e-6;
        let u = ((sp.x - ax) * bdx + (sp.y - ay) * bdy + (sp.z - az) * bdz) / len2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = ax + bdx * u - sp.x, dy = ay + bdy * u - sp.y, dz = az + bdz * u - sp.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < clearBladeR * clearBladeR) {
          const d = Math.sqrt(d2) + 1e-5;
          const corr = (clearBladeR - d) / d;
          const px = dx * corr, py = dy * corr, pz = dz * corr;
          // The tip takes more of the push the nearer the contact is to it, the stipe the rest.
          const tipShare = 0.25 + 0.75 * u;
          const s1 = (1 - tipShare) * 0.55 * push1, s2 = (1 - tipShare) * 0.55 * push2;
          tx += px * tipShare;
          ty += py * tipShare;
          tz += pz * tipShare;
          pos[n1] += px * s1;
          pos[n1 + 1] += py * s1;
          pos[n1 + 2] += pz * s1;
          pos[n2] += px * s2;
          pos[n2 + 1] += py * s2;
          pos[n2 + 2] += pz * s2;
          ax = pos[n0] * w0 + pos[n1] * w1 + pos[n2] * w2 + pos[n3] * w3 + ox;
          ay = pos[n0 + 1] * w0 + pos[n1 + 1] * w1 + pos[n2 + 1] * w2 + pos[n3 + 1] * w3 + oy;
          az = pos[n0 + 2] * w0 + pos[n1 + 2] * w1 + pos[n2 + 2] * w2 + pos[n3 + 2] * w3 + oz;
        }
      }

      // Past the hinge cone the blade is pulled back onto it, and the stipe pulled toward it.
      let bdx = tx - ax, bdy = ty - ay, bdz = tz - az;
      let dist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz) + 1e-6;
      const ux = bdx / dist, uy = bdy / dist, uz = bdz / dist;
      const rx0 = restDir[k3], ry0 = restDir[k3 + 1], rz0 = restDir[k3 + 2];
      const dotRest = ux * rx0 + uy * ry0 + uz * rz0;
      const cm = cosMax[k];
      if (dotRest < cm) {
        const rx = ux - dotRest * rx0, ry = uy - dotRest * ry0, rz = uz - dotRest * rz0;
        const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-6;
        const sm = sinMax[k] / rLen;
        const ex = ax + (rx0 * cm + rx * sm) * L - tx;
        const ey = ay + (ry0 * cm + ry * sm) * L - ty;
        const ez = az + (rz0 * cm + rz * sm) * L - tz;
        tx += ex * 0.55;
        ty += ey * 0.55;
        tz += ez * 0.55;
        const s1 = 0.28 * push1, s2 = 0.28 * push2;
        pos[n1] -= ex * s1;
        pos[n1 + 1] -= ey * s1;
        pos[n1 + 2] -= ez * s1;
        pos[n2] -= ex * s2;
        pos[n2 + 1] -= ey * s2;
        pos[n2 + 2] -= ez * s2;
        ax = pos[n0] * w0 + pos[n1] * w1 + pos[n2] * w2 + pos[n3] * w3 + ox;
        ay = pos[n0 + 1] * w0 + pos[n1 + 1] * w1 + pos[n2 + 1] * w2 + pos[n3 + 1] * w3 + oy;
        az = pos[n0 + 2] * w0 + pos[n1 + 2] * w1 + pos[n2 + 2] * w2 + pos[n3 + 2] * w3 + oz;
      }

      // Inextensible blade.
      bdx = tx - ax;
      bdy = ty - ay;
      bdz = tz - az;
      dist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz) + 1e-6;
      const lenDiff = (dist - L) / dist;
      tx -= bdx * lenDiff * 0.85;
      ty -= bdy * lenDiff * 0.85;
      tz -= bdz * lenDiff * 0.85;
      const s1 = lenDiff * 0.15 * push1, s2 = lenDiff * 0.15 * push2;
      pos[n1] += bdx * s1;
      pos[n1 + 1] += bdy * s1;
      pos[n1 + 2] += bdz * s1;
      pos[n2] += bdx * s2;
      pos[n2 + 1] += bdy * s2;
      pos[n2 + 2] += bdz * s2;
      // Blade tips stay in the water.
      tip[k3] = tx;
      tip[k3 + 1] = ty > lid ? lid : ty;
      tip[k3 + 2] = tz;
    }
  }

  solveStipes(iter, sp, sr, sphereOn) {
    const { numCols: nc, pos, rest, segLen, colLid, colActive } = this;
    const clearStipeR = sr + 0.36;
    for (let c = 0; c < nc; c++) {
      // Stipes with no simulated blades pulling on them hold their length in two passes.
      if (iter > 1 && !colActive[c]) continue;
      const base = c * S * 3;
      pos[base] = rest[base];
      pos[base + 1] = rest[base + 1];
      pos[base + 2] = rest[base + 2];
      for (let i = 0; i < S - 1; i++) {
        const a = base + i * 3, b = a + 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
        const diff = (dist - segLen[c * (S - 1) + i]) / dist;
        if (i === 0) {
          pos[b] -= dx * diff;
          pos[b + 1] -= dy * diff;
          pos[b + 2] -= dz * diff;
        } else {
          const h = diff * 0.5;
          pos[a] += dx * h;
          pos[a + 1] += dy * h;
          pos[a + 2] += dz * h;
          pos[b] -= dx * h;
          pos[b + 1] -= dy * h;
          pos[b + 2] -= dz * h;
        }
      }
      if (sphereOn) {
        for (let i = 1; i < S; i++) {
          const i3 = base + i * 3;
          const dx = pos[i3] - sp.x, dy = pos[i3 + 1] - sp.y, dz = pos[i3 + 2] - sp.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < clearStipeR * clearStipeR) {
            const s = clearStipeR / (Math.sqrt(d2) + 1e-5);
            pos[i3] = sp.x + dx * s;
            pos[i3 + 1] = sp.y + dy * s;
            pos[i3 + 2] = sp.z + dz * s;
          }
        }
      }
      const lid = colLid[c];
      for (let i = 1; i < S; i++) if (pos[base + i * 3 + 1] > lid) pos[base + i * 3 + 1] = lid;
    }
  }

  uploadTextures() {
    const { numCols: nc, numSim: n, pos, rest, speed, deltaData, simIndex, simNode, simW, simOff, tip, restDir, bladeQuatData } = this;
    for (let c = 0; c < nc; c++) {
      for (let i = 0; i < S; i++) {
        const i3 = (c * S + i) * 3;
        const o = (c * (S + 1) + i) * 4;
        deltaData[o] = pos[i3] - rest[i3];
        deltaData[o + 1] = pos[i3 + 1] - rest[i3 + 1];
        deltaData[o + 2] = pos[i3 + 2] - rest[i3 + 2];
        deltaData[o + 3] = speed[c * S + i];
      }
    }
    // Each simulated blade's rotation from its rest direction to its tip (as Quaternion.setFromUnitVectors).
    for (let k = 0; k < n; k++) {
      const k3 = k * 3, k4 = k * 4;
      const n0 = simNode[k4], n1 = simNode[k4 + 1], n2 = simNode[k4 + 2], n3 = simNode[k4 + 3];
      const w0 = simW[k4], w1 = simW[k4 + 1], w2 = simW[k4 + 2], w3 = simW[k4 + 3];
      let dx = tip[k3] - (pos[n0] * w0 + pos[n1] * w1 + pos[n2] * w2 + pos[n3] * w3 + simOff[k3]);
      let dy = tip[k3 + 1] - (pos[n0 + 1] * w0 + pos[n1 + 1] * w1 + pos[n2 + 1] * w2 + pos[n3 + 1] * w3 + simOff[k3 + 1]);
      let dz = tip[k3 + 2] - (pos[n0 + 2] * w0 + pos[n1 + 2] * w1 + pos[n2 + 2] * w2 + pos[n3 + 2] * w3 + simOff[k3 + 2]);
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const rx = restDir[k3], ry = restDir[k3 + 1], rz = restDir[k3 + 2];
      let qx, qy, qz;
      let qw = rx * dx + ry * dy + rz * dz + 1;
      if (qw < 1e-8) {
        qw = 0;
        if (Math.abs(rx) > Math.abs(rz)) [qx, qy, qz] = [-ry, rx, 0];
        else [qx, qy, qz] = [0, -rz, ry];
      } else {
        qx = ry * dz - rz * dy;
        qy = rz * dx - rx * dz;
        qz = rx * dy - ry * dx;
      }
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      const o = simIndex[k] * 4;
      bladeQuatData[o] = qx / ql;
      bladeQuatData[o + 1] = qy / ql;
      bladeQuatData[o + 2] = qz / ql;
      bladeQuatData[o + 3] = qw / ql;
    }
    this.deltaTexture.needsUpdate = true;
    const tex = this.bladeQuatTexture;
    tex.clearUpdateRanges();
    for (const [start, count] of this.quatRanges) tex.addUpdateRange(start, count);
    tex.needsUpdate = true;
  }

  dispose() {
    this.deltaTexture.dispose();
    this.bladeRestTexture.dispose();
    this.bladeQuatTexture.dispose();
  }
}

function makeTexture(data, w, h) {
  const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
