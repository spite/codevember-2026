// Signed distance functions for the Melt shapes, f < 0 inside. The bake normalises each to radius 1.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

export function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

// Ported from bumpy-metaballs-2026/shaders/shapes.js.
function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function sdRoundStar(x, y, z, size) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const arm = 0.26 * size, tip = 0.05 * size;
  let arms = sdRoundCone(ax, ay, az, 0, 0, 0, size, 0, 0, arm, tip);
  arms = Math.min(arms, sdRoundCone(ax, ay, az, 0, 0, 0, 0, size, 0, arm, tip));
  arms = Math.min(arms, sdRoundCone(ax, ay, az, 0, 0, 0, 0, 0, size, arm, tip));
  return smin(len3(x, y, z) - 0.42 * size, arms, 0.12 * size);
}

function sdSphube(x, y, z, radius, squareness) {
  const qx = x / radius, qy = y / radius, qz = z / radius;
  const x2 = qx * qx, y2 = qy * qy, z2 = qz * qz;
  const s2 = squareness * squareness;
  const pot = x2 + y2 + z2 - s2 * (x2 * y2 + y2 * z2 + z2 * x2) + s2 * s2 * x2 * y2 * z2 - 1;
  const gx = 2 * qx * (1 - s2 * (y2 + z2) + s2 * s2 * y2 * z2);
  const gy = 2 * qy * (1 - s2 * (x2 + z2) + s2 * s2 * x2 * z2);
  const gz = 2 * qz * (1 - s2 * (x2 + y2) + s2 * s2 * x2 * y2);
  const d = (pot / Math.max(len3(gx, gy, gz), 1e-3)) * radius;
  const bx = Math.abs(x) - radius, by = Math.abs(y) - radius, bz = Math.abs(z) - radius;
  const box = len3(Math.max(bx, 0), Math.max(by, 0), Math.max(bz, 0)) + Math.min(Math.max(bx, by, bz), 0);
  return Math.max(d, box);
}

// Trefoil tube: nearest of two strands found on a coarse sampling, then refined by Newton on t.
function trefoil(radius) {
  const S = 192, dt = (2 * Math.PI) / S;
  const at = (t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)];
  const vel = (t) => [Math.cos(t) + 4 * Math.cos(2 * t), -Math.sin(t) + 4 * Math.sin(2 * t), -3 * Math.cos(3 * t)];
  const acc = (t) => [-Math.sin(t) - 8 * Math.sin(2 * t), -Math.cos(t) + 8 * Math.cos(2 * t), 9 * Math.sin(3 * t)];
  const P = Array.from({ length: S }, (_, i) => at(i * dt));
  const d2 = (c, x, y, z) => (c[0] - x) ** 2 + (c[1] - y) ** 2 + (c[2] - z) ** 2;
  return (x, y, z) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < S; i++) {
      const d = d2(P[i], x, y, z);
      if (d < best) { best = d; bi = i; }
    }
    let other = Infinity, oi = 0;
    for (let i = 0; i < S; i++) {
      const g = Math.abs(i - bi);
      if (Math.min(g, S - g) <= S / 8) continue;
      const d = d2(P[i], x, y, z);
      if (d < other) { other = d; oi = i; }
    }
    let nearest = Math.min(best, other);
    for (const i0 of [bi, oi]) {
      let t = i0 * dt;
      for (let it = 0; it < 5; it++) {
        const c = at(t), v = vel(t), a = acc(t);
        const rx = c[0] - x, ry = c[1] - y, rz = c[2] - z;
        const bend = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + rx * a[0] + ry * a[1] + rz * a[2];
        if (bend > 0) t -= clamp((rx * v[0] + ry * v[1] + rz * v[2]) / bend, -dt, dt);
      }
      nearest = Math.min(nearest, d2(at(t), x, y, z));
    }
    return Math.sqrt(nearest) - radius;
  };
}

// Two round cones from each lobe down to the tip, blended across the middle; flattened front to back.
function heart(x, y, z) {
  const flat = 0.72;
  const zz = z / flat;
  const lobe = (sx) => sdRoundCone(x, y, zz, sx * 0.42, 0.28, 0, 0, -0.78, 0, 0.5, 0.06);
  return smin(lobe(1), lobe(-1), 0.16) * flat;
}

const BLOB = [
  [0, 0, 0, 0.75],
  [0.5, 0.32, 0.12, 0.55],
  [-0.42, 0.22, -0.28, 0.6],
  [0.06, -0.4, 0.38, 0.58],
];
function blob(x, y, z) {
  let d = Infinity;
  for (const [cx, cy, cz, r] of BLOB) {
    const s = len3(x - cx, y - cy, z - cz) - r;
    d = d === Infinity ? s : smin(d, s, 0.35);
  }
  return d;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const nrm = (v) => { const l = len3(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const ICO = [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1], [0, 1, PHI + 1], [0, -1, PHI + 1],
  [PHI + 1, 0, 1], [-PHI - 1, 0, 1], [1, PHI + 1, 0], [-1, PHI + 1, 0]].map(nrm);
const DOD = [[0, PHI, 1], [0, -PHI, 1], [1, 0, PHI], [-1, 0, PHI], [PHI, 1, 0], [-PHI, 1, 0]].map(nrm);

// Smooth max of |p·n| over the face normals (a 32-norm): a polyhedron with softened edges. From dof curl-over-sdf.
const polyhedron = (normals, r) => (x, y, z) => {
  let s = 0;
  for (const n of normals) s += (x * n[0] + y * n[1] + z * n[2]) ** 32;
  return Math.pow(s, 1 / 32) - r;
};

export const SHAPES = {
  heart: { name: "Heart", f: heart, bound: 1.3, genus: 0 },
  blob: { name: "Blob", f: blob, bound: 1.6, genus: 0 },
  sphube: { name: "Sphube", f: (x, y, z) => sdSphube(x, y, z, 0.9, 0.7), bound: 1.2, genus: 0 },
  torus: { name: "Torus", f: (x, y, z) => len3(Math.hypot(x, z) - 0.62, y, 0) - 0.36, bound: 1.2, genus: 1 },
  knot: { name: "Knot", f: trefoil(0.42), bound: 3.8, genus: 1 },
  star: { name: "Star", f: (x, y, z) => sdRoundStar(x, y, z, 1), bound: 1.3, genus: 0 },
  icosahedron: { name: "Icosahedron", f: polyhedron(ICO, 0.95), bound: 1.3, genus: 0 },
  dodecahedron: { name: "Dodecahedron", f: polyhedron(DOD, 0.95), bound: 1.3, genus: 0 },
};
