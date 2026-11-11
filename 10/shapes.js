// The blanks: closed surfaces with a closest-point projection, exact for the analytic ones and by Newton steps on a
// distance field for the rest, meshed as fine grids, tubes or surface nets. No imports, so the build worker can load it.

import { pillow, twist, blob, knot, knot25, suzanne, gyroid, dodeca, icosa, lens, moebius } from "./fields.js";
import { surfaceNets, knotMesh, twistMesh, knotGrid, twistGrid, moebiusMesh, moebiusGrid, meshArea } from "./mesher.js";

// A coarse quad grid over the tube-like blanks with cells about `cell` across, for the interlace patterns (weave.js).
for (const k of [knot, knot25]) k.quadGrid = (cell) => knotGrid(k, Math.round(k.length / cell / k.period) * k.period, Math.max(k.ringMin, Math.round((2 * Math.PI * k.r) / cell / k.ring) * k.ring));
twist.quadGrid = (cell) => twistGrid(twist, Math.round((2 * Math.PI * twist.R) / cell / 2) * 2, Math.max(6, Math.round((6 * twist.t + 2 * Math.PI * twist.rr) / cell / 3) * 3));
moebius.quadGrid = (cell) => moebiusGrid(moebius, Math.round((2 * Math.PI * moebius.R) / cell / 2) * 2, Math.max(8, Math.round((4 * moebius.w + 2 * Math.PI * moebius.rr) / cell / 2) * 2));

// The gyroid's grid: surface nets of a thicker sheet (so coarse cells still see both faces), in the gyroid's own
// axes so the symmetries map it onto itself. Cells are capped at what the channels allow, and reported back.
gyroid.quadGrid = (cell) => {
  const h = Math.min(cell, 0.12);
  const fr = gyroid.framed(Math.max(gyroid.t, 0.9 * h));
  const { pos, quads } = surfaceNets(fr, h, 8, true);
  const out = [];
  for (let i = 0; i < pos.length; i += 3) out.push(...fr.toShape(pos[i], pos[i + 1], pos[i + 2]));
  return { pos: out, quads, cell: h };
};

// Where the ray from the centre through p leaves a star-shaped blank.
function radialCast(shape, p) {
  const l = Math.hypot(p[0], p[1], p[2]);
  const d = [p[0] / l, p[1] / l, p[2] / l];
  let t = l;
  for (let i = 0; i < 100; i++) {
    const s = shape.sdf(d[0] * t, d[1] * t, d[2] * t);
    t += s;
    if (Math.abs(s) < 1e-9) break;
  }
  return [d[0] * t, d[1] * t, d[2] * t];
}

// A rounded polyhedron's grid: each face split into kites (centre, edge midpoint, corner, edge midpoint), each
// an n × n grid, cast out from the centre: every symmetry of the solid maps it onto itself.
const polyGrid = (solid) => (cell) => {
  const { normals: N, corners: V, inner: h } = solid;
  const edge = Math.hypot(...V[0].map((v, k) => (v - V[1][k]) * h)) || 1;
  const n = Math.max(1, Math.round(((edge / 2) * 1.25) / cell));
  const pos = [], quads = [], ids = new Map();
  const vid = (p) => {
    const key = p.map((v) => Math.round(v * 1e5)).join();
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = pos.length / 3)), pos.push(...radialCast(solid, p));
    return id;
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (const nf of N) {
    const c = nf.map((v) => v * h);
    // The face's corners in order round it.
    const ring = V.filter((v) => Math.abs(v[0] * nf[0] + v[1] * nf[1] + v[2] * nf[2] - 1) < 1e-9).map((v) => v.map((x) => x * h));
    const u = ring[0].map((x, k) => x - c[k]);
    const w = [nf[1] * u[2] - nf[2] * u[1], nf[2] * u[0] - nf[0] * u[2], nf[0] * u[1] - nf[1] * u[0]];
    const ang = (v) => Math.atan2((v[0] - c[0]) * w[0] + (v[1] - c[1]) * w[1] + (v[2] - c[2]) * w[2], (v[0] - c[0]) * u[0] + (v[1] - c[1]) * u[1] + (v[2] - c[2]) * u[2]);
    ring.sort((a, b) => ang(a) - ang(b));
    const m = ring.length;
    for (let k = 0; k < m; k++) {
      const P = ring[k], A = lerp(ring[(k + m - 1) % m], P, 0.5), B = lerp(P, ring[(k + 1) % m], 0.5);
      const g = [];
      for (let j = 0; j <= n; j++)
        for (let i = 0; i <= n; i++) g.push(vid(lerp(lerp(c, A, i / n), lerp(B, P, i / n), j / n)));
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) quads.push([g[j * (n + 1) + i], g[j * (n + 1) + i + 1], g[(j + 1) * (n + 1) + i + 1], g[(j + 1) * (n + 1) + i]]);
    }
  }
  return { pos, quads };
};
dodeca.quadGrid = polyGrid(dodeca);
icosa.quadGrid = polyGrid(icosa);

const norm = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

// Each shape: project(x, y, z) → [px, py, pz, nx, ny, nz], the closest surface point and its normal.
const SHAPES = {
  sphere: {
    bounds: [1, 1, 1],
    area: 4 * Math.PI,
    sdf: (x, y, z) => Math.hypot(x, y, z) - 1,
    project(x, y, z) {
      const [nx, ny, nz] = norm(x, y, z);
      return [nx, ny, nz, nx, ny, nz];
    },
  },
  torus: {
    R: 0.74,
    r: 0.36,
    get bounds() {
      return [this.R + this.r, this.r, this.R + this.r];
    },
    get area() {
      return 4 * Math.PI * Math.PI * this.R * this.r;
    },
    sdf(x, y, z) {
      return Math.hypot(Math.hypot(x, z) - this.R, y) - this.r;
    },
    project(x, y, z) {
      const l = Math.hypot(x, z) || 1;
      const cx = (x / l) * this.R;
      const cz = (z / l) * this.R;
      const [nx, ny, nz] = norm(x - cx, y, z - cz);
      return [cx + nx * this.r, ny * this.r, cz + nz * this.r, nx, ny, nz];
    },
  },
  box: {
    h: 0.74,
    r: 0.24,
    get bounds() {
      return [this.h, this.h, this.h];
    },
    get area() {
      const a = 2 * (this.h - this.r);
      return 6 * a * a + 6 * Math.PI * this.r * a + 4 * Math.PI * this.r * this.r;
    },
    sdf(x, y, z) {
      const c = this.h - this.r;
      const qx = Math.abs(x) - c;
      const qy = Math.abs(y) - c;
      const qz = Math.abs(z) - c;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - this.r;
    },
    project(x, y, z) {
      const c = this.h - this.r;
      const qx = Math.max(-c, Math.min(c, x));
      const qy = Math.max(-c, Math.min(c, y));
      const qz = Math.max(-c, Math.min(c, z));
      let dx = x - qx;
      let dy = y - qy;
      let dz = z - qz;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-9) {
        // Inside the core: push out through the nearest face.
        const ax = c - Math.abs(x);
        const ay = c - Math.abs(y);
        const az = c - Math.abs(z);
        if (ax <= ay && ax <= az) dx = Math.sign(x) || 1;
        else if (ay <= az) dy = Math.sign(y) || 1;
        else dz = Math.sign(z) || 1;
      }
      const [nx, ny, nz] = norm(dx, dy, dz);
      return [qx + nx * this.r, qy + ny * this.r, qz + nz * this.r, nx, ny, nz];
    },
  },
  pillow,
  knot,
  twist,
  moebius,
  blob,
  suzanne,
  gyroid,
  dodeca,
  icosa,
  lens,
  knot25,
};

// Six grids on a cube, projected onto the shape: equiangular for the sphere, uniform for the box.
function cubeGeometry(shape, n, equiangular) {
  const pos = [];
  const nor = [];
  const index = [];
  const faces = [
    [0, 1, 2, 1],
    [0, 1, 2, -1],
    [1, 2, 0, 1],
    [1, 2, 0, -1],
    [2, 0, 1, 1],
    [2, 0, 1, -1],
  ];
  const s = shape.bounds[0];
  for (const [a, b, c, sign] of faces) {
    const base = pos.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        let u = (i / n) * 2 - 1;
        let v = (j / n) * 2 - 1;
        if (equiangular) {
          u = Math.tan((u * Math.PI) / 4);
          v = Math.tan((v * Math.PI) / 4);
        }
        const p = [0, 0, 0];
        p[c] = sign * s;
        p[a] = u * s * sign;
        p[b] = v * s;
        const q = shape.project(p[0], p[1], p[2]);
        pos.push(q[0], q[1], q[2]);
        nor.push(q[3], q[4], q[5]);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = base + j * (n + 1) + i;
        index.push(k, k + 1, k + n + 2, k, k + n + 2, k + n + 1);
      }
    }
  }
  return build(pos, nor, index);
}

function torusGeometry(shape, n) {
  const { R, r } = shape;
  const nu = Math.round(n * 4);
  const nv = Math.round((n * 4 * r) / R) + 8;
  const pos = [];
  const nor = [];
  const index = [];
  for (let j = 0; j <= nv; j++) {
    const v = (j / nv) * Math.PI * 2;
    for (let i = 0; i <= nu; i++) {
      const u = (i / nu) * Math.PI * 2;
      const nx = Math.cos(v) * Math.cos(u);
      const ny = Math.sin(v);
      const nz = Math.cos(v) * Math.sin(u);
      pos.push(R * Math.cos(u) + r * nx, r * ny, R * Math.sin(u) + r * nz);
      nor.push(nx, ny, nz);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * (nu + 1) + i;
      index.push(k, k + nu + 1, k + nu + 2, k, k + nu + 2, k + 1);
    }
  }
  return build(pos, nor, index);
}

function build(pos, nor, index) {
  return { position: new Float32Array(pos), normal: new Float32Array(nor), index: new Uint32Array(index) };
}

// n: grid cells along a cube face edge. Returns plain arrays: position, normal, index.
function shapeMesh(name, n) {
  const shape = SHAPES[name];
  // Same spacing as the sphere's grid at its equator.
  const h = (Math.PI / 2) / n;
  if (shape.curve) return knotMesh(shape, h);
  if (name === "twist") return twistMesh(shape, h);
  if (name === "moebius") return moebiusMesh(shape, h);
  if (shape.field) return surfaceNets(shape, h * 1.15);
  if (name === "torus") return torusGeometry(shape, n);
  return cubeGeometry(shape, n, name === "sphere");
}

export { SHAPES, shapeMesh };
