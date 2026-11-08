// Fractal solids as implicit fields: folded IFS (Menger, Sierpinski octahedron, sphereflake) and a Mandelbulb.
// Few iterations, smooth folds and smooth unions keep them chunky enough to read once shelled and hollowed.

const SQ3 = Math.sqrt(3);

// Smooth fold: like |t| but rounded over k, still 1-Lipschitz.
const sabs = (t, k) => Math.sqrt(t * t + k * k);

// Polynomial smooth min/max: convex blends of the gradients, so 1-Lipschitz.
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a, b, k) => -smin(-a, -b, k);

function roundBox(x, y, z, b, r) {
  const dx = Math.abs(x) - b + r, dy = Math.abs(y) - b + r, dz = Math.abs(z) - b + r;
  const mx = Math.max(dx, 0), my = Math.max(dy, 0), mz = Math.max(dz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(dx, dy, dz), 0) - r;
}

function rotation(ax, ay, az) {
  const ca = Math.cos(ax), sa = Math.sin(ax), cb = Math.cos(ay), sb = Math.sin(ay), cc = Math.cos(az), sc = Math.sin(az);
  return [
    cb * cc, -cb * sc, sb,
    sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
    -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb,
  ];
}

const lerp = (a, b, t) => a + (b - a) * t;
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

// Twist about z by `rate` radians per unit, with the distance divided by the warp's local stretch.
function twisted(f, rate) {
  if (!rate) return f;
  return (x, y, z) => {
    const a = rate * z, c = Math.cos(a), s = Math.sin(a);
    const d = f(c * x - s * y, s * x + c * y, z);
    return d / Math.sqrt(1 + rate * rate * (x * x + y * y));
  };
}

// --- Raw fields in their own frames (normalised afterwards) -----------------------------------------------

const mod2 = (t) => t - 2 * Math.floor(t / 2) - 1;

function menger(p) {
  const { level, hole, round, blend, frame } = p;
  return (x, y, z) => {
    let d = roundBox(x, y, z, 1, frame);
    let s = 1;
    for (let i = 0; i < level; i++) {
      const ax = mod2(x * s), ay = mod2(y * s), az = mod2(z * s);
      s *= 3;
      const rx = 1 - 3 * Math.abs(ax), ry = 1 - 3 * Math.abs(ay), rz = 1 - 3 * Math.abs(az);
      const ux = Math.abs(rx), uy = Math.abs(ry), uz = Math.abs(rz);
      const c = (Math.min(Math.max(ux, uy), Math.max(uy, uz), Math.max(uz, ux)) - hole) / s;
      d = smax(d, c, blend / s);
    }
    return d - round;
  };
}

// Octahedral IFS: six copies along the axes, base octahedron or sphere.
function octa(p) {
  const { iter, scale, k, round, base, soft = 0.2 } = p;
  const n = 1 / Math.SQRT2;
  const off = scale - 1;
  return (x, y, z) => {
    let m = 1;
    for (let i = 0; i < iter; i++) {
      x = sabs(x, k); y = sabs(y, k); z = sabs(z, k);
      let t = (x - y) * n, f = (sabs(t, k) - t) * n; x += f; y -= f;
      t = (x - z) * n; f = (sabs(t, k) - t) * n; x += f; z -= f;
      x = scale * x - off; y *= scale; z *= scale;
      m *= scale;
    }
    let d;
    if (base === "sphere") d = Math.sqrt(x * x + y * y + z * z) - 0.75;
    else {
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      d = smax(smax((ax + ay + az - 1) / SQ3, ax - 0.98, soft), smax(ay - 0.98, az - 0.98, soft), soft);
    }
    return d / m - round;
  };
}

// Sphereflake-style IFS: a ball (or rounded cube) with smaller copies on the folded directions, every level kept.
function flake(p) {
  const { iter, ratio, k, dir, rot, base, blend } = p;
  const R = rotation(rot[0], rot[1], rot[2]);
  const n = 1 / Math.SQRT2;
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  const ox = (dir[0] / dl) * (1 + ratio * 0.85), oy = (dir[1] / dl) * (1 + ratio * 0.85), oz = (dir[2] / dl) * (1 + ratio * 0.85);
  return (x, y, z) => {
    let m = 1, d = 1e9;
    for (let i = 0; i <= iter; i++) {
      const prim = base === "cube" ? roundBox(x, y, z, 0.8, 0.25) : Math.sqrt(x * x + y * y + z * z) - 1;
      d = smin(d, prim * m, blend * m);
      if (i === iter) break;
      x = sabs(x, k); y = sabs(y, k); z = sabs(z, k);
      let t = (x - y) * n, g = (sabs(t, k) - t) * n; x += g; y -= g;
      t = (x - z) * n; g = (sabs(t, k) - t) * n; x += g; z -= g;
      t = (y - z) * n; g = (sabs(t, k) - t) * n; y += g; z -= g;
      x -= ox; y -= oy; z -= oz;
      const rx = R[0] * x + R[1] * y + R[2] * z, ry = R[3] * x + R[4] * y + R[5] * z, rz = R[6] * x + R[7] * y + R[8] * z;
      x = rx / ratio; y = ry / ratio; z = rz / ratio;
      m *= ratio;
    }
    return d;
  };
}

// Mandelbulb with few iterations: a spiky urchin. Log of the final radius, unioned with a core so the origin's fixed point stays inside.
function bulb(p) {
  const { power, iter, core, round } = p;
  return (cx, cy, cz) => {
    let zx = cx, zy = cy, zz = cz, r = 0;
    for (let i = 0; i < iter; i++) {
      r = Math.sqrt(zx * zx + zy * zy + zz * zz);
      if (r > 4) break;
      const rho = Math.sqrt(zx * zx + zy * zy);
      const tr = r > 1e-12 ? zz / r : 1, ti = r > 1e-12 ? rho / r : 0;
      const pr = rho > 1e-12 ? zx / rho : 1, pi = rho > 1e-12 ? zy / rho : 0;
      let ctr = 1, cti = 0, cpr = 1, cpi = 0, ar = tr, ai = ti, br = pr, bi = pi;
      for (let e = power; e > 0; e >>= 1) {
        if (e & 1) {
          let t = ctr * ar - cti * ai; cti = ctr * ai + cti * ar; ctr = t;
          t = cpr * br - cpi * bi; cpi = cpr * bi + cpi * br; cpr = t;
        }
        let t = ar * ar - ai * ai; ai = 2 * ar * ai; ar = t;
        t = br * br - bi * bi; bi = 2 * br * bi; br = t;
      }
      const zr = Math.pow(r, power);
      zx = zr * cti * cpr + cx;
      zy = zr * cti * cpi + cy;
      zz = zr * ctr + cz;
    }
    r = Math.sqrt(zx * zx + zy * zy + zz * zz);
    const d = Math.log(Math.max(r, 1e-6));
    const inner = Math.sqrt(cx * cx + cy * cy + cz * cz) - core;
    return Math.max(-3, Math.min(d, inner)) - round;
  };
}

// --- Normalisation ------------------------------------------------------------------------------------------

// Scales the raw field into the unit sphere and twists it. sites: points of the raw field (a lattice of cell sites),
// mapped into the normalised frame with it.
function normalise(raw, extent, { twist = 0, sites = null, siteKeep = null, siteSpacing = 0 } = {}) {
  const G = 36;
  let rMax = 0;
  const cell = (2 * extent) / G;
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) for (let l = 0; l <= G; l++) {
    const x = -extent + i * cell, y = -extent + j * cell, z = -extent + l * cell;
    if (raw(x, y, z) < 0.5 * cell) rMax = Math.max(rMax, Math.hypot(x, y, z));
  }
  const fit = 1 / Math.max(rMax, 1e-3);
  const scaled = (x, y, z) => raw(x / fit, y / fit, z / fit) * fit;
  const out = { kind: "solid", f: twisted(scaled, twist), extent: 1.25, keep: Infinity };
  if (sites) {
    out.sites = new Float32Array(sites.length);
    for (let o = 0; o < sites.length; o += 3) {
      const x = sites[o] * fit, y = sites[o + 1] * fit, z = sites[o + 2] * fit;
      const a = -twist * z, c = Math.cos(a), s = Math.sin(a);
      out.sites.set([c * x - s * y, s * x + c * y, z], o);
    }
    out.siteSpacing = siteSpacing * fit;
    out.siteKeep = siteKeep;
  }
  return out;
}

// --- Catalogue ----------------------------------------------------------------------------------------------

const sign = (rand) => (rand() < 0.5 ? -1 : 1);

export const SHAPES = [
  {
    id: "menger",
    name: "Menger sponge",
    family: "fractal",
    kind: "solid",
    albedo: 0.8,
    cellFloor: 0.5,
    cells: 0.6,
    random(rand) {
      // The first level: the hollowing opens the second.
      return {
        level: 1,
        hole: lerp(0.9, 1.2, rand()),
        frame: lerp(0.05, 0.16, rand()),
        blend: lerp(0.25, 0.5, rand()),
        round: lerp(0.01, 0.03, rand()),
        twist: rand() < 0.6 ? 0 : sign(rand) * lerp(0.3, 0.6, rand()),
      };
    },
    build(p) {
      return normalise(menger(p), 1.3, { twist: p.twist });
    },
  },

  {
    id: "octahedron",
    name: "Sierpinski octahedron",
    family: "fractal",
    kind: "solid",
    cellFloor: 0.5,
    random(rand) {
      const sphere = rand() < 0.2;
      return {
        base: sphere ? "sphere" : "octa",
        iter: sphere ? 2 : rand() < 0.5 ? 2 : 3,
        scale: sphere ? lerp(1.8, 1.95, rand()) : lerp(1.85, 2.0, rand()),
        k: lerp(0.02, 0.05, rand()),
        soft: lerp(0.2, 0.3, rand()),
        round: lerp(0.015, 0.03, rand()),
        twist: rand() < 0.7 ? 0 : sign(rand) * lerp(0.3, 0.6, rand()),
      };
    },
    build(p) {
      return normalise(octa(p), 1.6, { twist: p.twist });
    },
  },
  {
    id: "sphereflake",
    name: "Sphereflake",
    family: "fractal",
    kind: "solid",
    cellFloor: 0.5,
    // Few, big cells, so the small spheres open into calm rings rather than a froth.
    cells: 0.55,
    random(rand) {
      const dir = pick(rand, [[1, 0, 0], [1, 0, 0], [1, 1, 1], [1, 1, 0]]);
      const a = () => (rand() - 0.5) * 0.8;
      const p = {
        base: "sphere",
        dir,
        ratio: lerp(0.38, 0.5, rand()),
        k: lerp(0.01, 0.03, rand()),
        rot: rand() < 0.5 ? [0, 0, 0] : [a(), a(), a()],
        blend: lerp(0.08, 0.2, rand()),
      };
      // A third level only where its copies stay big and aligned enough to survive the hollowing.
      p.iter = dir[1] === 0 && p.ratio > 0.45 && !p.rot[0] && rand() < 0.6 ? 3 : 2;
      return p;
    },
    build(p) {
      return normalise(flake(p), 3);
    },
  },

  {
    id: "mandelbulb",
    name: "Mandelbulb",
    family: "fractal",
    kind: "solid",
    cellFloor: 0.5,
    random(rand) {
      return { power: 6 + Math.floor(rand() * 4), iter: 5, core: 0.25, round: 0.01 };
    },
    build(p) {
      return normalise(bulb(p), 1.6);
    },
  },
];
