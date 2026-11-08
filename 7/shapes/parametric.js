// Parametric and implicit surfaces turned into sheets. build() returns the surface itself: (u, v) patches, or an
// implicit field clipped to a region, plus a warp applied once the sheet is fitted into the unit sphere. The mesher
// samples them directly. No three.js and no DOM: runs in the mesher worker and on the page.

const TAU = Math.PI * 2;
const FIT = 0.9;

const lerp = (a, b, t) => a + (b - a) * t;
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const range = (rand, a, b) => a + (b - a) * rand();

// Rough extent of a parametric patch.
function paramExtent(fn, [u0, u1], [v0, v1], clip = null) {
  let r = 0;
  const pts = [];
  for (let j = 0; j <= 40; j++)
    for (let i = 0; i <= 40; i++) {
      const u = lerp(u0, u1, i / 40), v = lerp(v0, v1, j / 40);
      const p = clip && clip(u, v) >= 0 ? null : fn(u, v);
      if (p && isFinite(p[0] + p[1] + p[2])) pts.push(p);
    }
  const c = [0, 1, 2].map((k) => (Math.min(...pts.map((p) => p[k])) + Math.max(...pts.map((p) => p[k]))) / 2);
  for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  return r || 1;
}

function randomWarp(rand, strength = 1) {
  const w = { twist: 0, bend: 0, wave: 0, freq: 0, phase: [0, 0, 0], axis: [0, 0, 1] };
  if (rand() < 0.6) w.twist = range(rand, -1.6, 1.6) * strength;
  if (rand() < 0.45) w.bend = range(rand, -0.8, 0.8) * strength;
  if (rand() < 0.5) {
    w.wave = range(rand, 0.03, 0.07) * strength;
    w.freq = range(rand, 2.5, 4.5);
    w.phase = [rand() * TAU, rand() * TAU, rand() * TAU];
  }
  const th = rand() * TAU, ph = Math.acos(range(rand, -1, 1));
  w.axis = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
  return w;
}


// Twist about, then bend along, a random axis, plus a sinusoidal domain wobble. Applied to the fitted soup.
function warp(T, w) {
  if (!w || (!w.twist && !w.bend && !w.wave)) return T;
  const [ax, ay, az] = w.axis;
  // Orthonormal frame (e1, e2, a).
  let e1 = Math.abs(ax) < 0.9 ? [0, az, -ay] : [-az, 0, ax];
  const l1 = Math.hypot(...e1);
  e1 = e1.map((v) => v / l1);
  const e2 = [ay * e1[2] - az * e1[1], az * e1[0] - ax * e1[2], ax * e1[1] - ay * e1[0]];
  for (let i = 0; i < T.length; i += 3) {
    const x = T[i], y = T[i + 1], z = T[i + 2];
    let p = x * e1[0] + y * e1[1] + z * e1[2], q = x * e2[0] + y * e2[1] + z * e2[2], h = x * ax + y * ay + z * az;
    if (w.twist) {
      const a = w.twist * h, c = Math.cos(a), s = Math.sin(a);
      [p, q] = [c * p - s * q, s * p + c * q];
    }
    if (w.bend) {
      // Bends the h axis into an arc of curvature `bend` in the (p, h) plane.
      const k = w.bend, a = k * h, c = Math.cos(a), s = Math.sin(a);
      const r = 1 / k - p;
      [p, h] = [1 / k - r * c, r * s];
    }
    if (w.wave) {
      const f = w.freq, [a, b, d] = w.phase;
      const dp = Math.sin(f * q + a) * Math.cos(f * h + b), dq = Math.sin(f * h + b) * Math.cos(f * p + d), dh = Math.sin(f * p + d) * Math.cos(f * q + a);
      p += w.wave * dp;
      q += w.wave * dq;
      h += w.wave * dh;
    }
    T[i] = p * e1[0] + q * e2[0] + h * ax;
    T[i + 1] = p * e1[1] + q * e2[1] + h * ay;
    T[i + 2] = p * e1[2] + q * e2[2] + h * az;
  }
  return T;
}


function boyPt(phi, rho) {
  const wr = rho * Math.cos(phi), wi = rho * Math.sin(phi);
  const mul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];
  const div = (ar, ai, br, bi) => {
    const d = br * br + bi * bi;
    return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
  };
  const [w2r, w2i] = mul(wr, wi, wr, wi);
  const [w3r, w3i] = mul(w2r, w2i, wr, wi);
  const [w4r, w4i] = mul(w3r, w3i, wr, wi);
  const [w6r, w6i] = mul(w3r, w3i, w3r, w3i);
  const S5 = Math.sqrt(5);
  const Dr = w6r + S5 * w3r - 1, Di = w6i + S5 * w3i;
  const [n1r, n1i] = mul(wr, wi, 1 - w4r, -w4i);
  const [n2r, n2i] = mul(wr, wi, 1 + w4r, w4i);
  const g1 = -1.5 * div(n1r, n1i, Dr, Di)[1];
  const g2 = -1.5 * div(n2r, n2i, Dr, Di)[0];
  const g3 = div(1 + w6r, w6i, Dr, Di)[1] - 0.5;
  const g = g1 * g1 + g2 * g2 + g3 * g3;
  return [g1 / g, g2 / g, g3 / g];
}

// The classic bottle with its neck passing back through the side (u in [0, π), v around the tube).
function kleinBottle(u, v, neck, fat) {
  const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
  const c2 = cu * cu, c3 = c2 * cu, c4 = c2 * c2, c5 = c4 * cu, c6 = c4 * c2, c7 = c6 * cu;
  // `fat` widens the tube everywhere, most where it is thinnest.
  const k = (3 + fat + 5 * cu * su) / (3 + 5 * cu * su);
  const x = (-2 / 15) * cu * (3 * cv * k - 30 * su + 90 * c4 * su - 60 * c6 * su + 5 * cu * cv * su * k);
  const y = (-1 / 15) * su * ((3 * cv - 3 * c2 * cv - 48 * c4 * cv + 48 * c6 * cv + 5 * cu * cv * su - 5 * c3 * cv * su - 80 * c5 * cv * su + 80 * c7 * cv * su) * k - 60 * su);
  const z = (2 / 15) * (3 + fat + 5 * cu * su) * sv * neck;
  return [x, y, z];
}

function romanPt(u, v) {
  const sx = Math.cos(u) * Math.sin(v), sy = Math.sin(u) * Math.sin(v), sz = Math.cos(v);
  return [sy * sz, sz * sx, sx * sy];
}

function crosscapPt(u, v) {
  const s2 = Math.sin(2 * v);
  return [Math.cos(u) * s2, Math.sin(u) * s2, Math.cos(v) ** 2 - Math.cos(u) ** 2 * Math.sin(v) ** 2];
}

// Enneper of order n from the Weierstrass data g = z^n over the disc |z| < R.
function enneperN(r, t, n) {
  const m = 2 * n + 1;
  const zr = r * Math.cos(t), zi = r * Math.sin(t);
  const rm = Math.pow(r, m), am = m * t, rn = Math.pow(r, n + 1), an = (n + 1) * t;
  const wr = (rm * Math.cos(am)) / m, wi = (rm * Math.sin(am)) / m;
  return [zr - wr, -(zi + wi), ((2 * rn) / (n + 1)) * Math.cos(an)];
}

function associatePt(u, v, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [c * Math.cosh(v) * Math.cos(u) + s * Math.sinh(v) * Math.sin(u), c * Math.cosh(v) * Math.sin(u) - s * Math.sinh(v) * Math.cos(u), c * v + s * u];
}

// Costa's surface (Gray's parametrization through the Weierstrass ζ and ℘ on the square lattice).
const G2 = 189.072772, E1 = 6.87519, NTERM = 42;
const COSTA_A = (() => {
  const a = new Array(NTERM + 1).fill(0);
  a[1] = G2 / 20;
  for (let k = 3; k <= NTERM; k++) {
    let s = 0;
    for (let m = 1; m <= k - 2; m++) s += a[m] * a[k - 1 - m];
    a[k] = (3 / ((2 * k + 3) * (k - 2))) * s;
  }
  return a;
})();

function weier(zr, zi) {
  const m = Math.round(zr), n = Math.round(zi);
  const x = zr - m, y = zi - n;
  const z2r = x * x - y * y, z2i = 2 * x * y;
  const d2 = z2r * z2r + z2i * z2i;
  let pr = z2r / d2, pi = -z2i / d2;
  const d1 = x * x + y * y;
  let zetR = x / d1, zetI = -y / d1;
  let pwr = 1, pwi = 0;
  for (let k = 1; k <= NTERM; k++) {
    const nr = pwr * z2r - pwi * z2i, ni = pwr * z2i + pwi * z2r;
    pwr = nr;
    pwi = ni;
    const ak = COSTA_A[k];
    if (ak !== 0) {
      pr += ak * pwr;
      pi += ak * pwi;
      const f = ak / (2 * k + 1);
      zetR -= f * (pwr * x - pwi * y);
      zetI -= f * (pwr * y + pwi * x);
    }
  }
  return [pr, pi, zetR + m * Math.PI, zetI - n * Math.PI];
}

function costaPt(u, v) {
  const pi = Math.PI, pe = pi / (2 * E1), c0 = (pi * pi) / (4 * E1);
  const a = weier(u, v), b = weier(u - 0.5, v), c = weier(u, v - 0.5);
  const x = 0.5 * (-a[2] + pi * u + c0 + pe * (b[2] - c[2]));
  const y = 0.5 * (a[3] + pi * v + c0 + pe * (b[3] - c[3]));
  const num = Math.hypot(a[0] - E1, a[1]), den = Math.hypot(a[0] + E1, a[1]);
  return [x, y, 0.25 * Math.sqrt(2 * pi) * Math.log(num / (den || 1e-9))];
}

// Negative away from the ends: the planar end at the lattice corners, the catenoid ends at the half-periods.
function costaClip(clip, planarClip) {
  const planar = [[0, 0], [1, 0], [0, 1], [1, 1]], catenoidal = [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]];
  const near = (u, v, ends) => Math.min(...ends.map(([a, b]) => Math.hypot(u - a, v - b)));
  return (u, v) => Math.max(planarClip - near(u, v, planar), clip - near(u, v, catenoidal));
}

function seashellPt(t, u, p) {
  const g = Math.exp(p.growth * t);
  const ct = Math.cos(t), st = Math.sin(t);
  const rib = 1 + p.rib * Math.pow(Math.abs(Math.sin(p.ribs * t * 0.5)), 6);
  const rad = p.tube * g * rib * (1 + p.flare * Math.cos(u) ** 2);
  const cu = Math.cos(u);
  return [g * ct + rad * cu * ct, g * st + rad * cu * st, -p.cone * g + rad * p.ell * Math.sin(u)];
}

function superFormula(phi, a, b, m, n1, n2, n3) {
  const s = Math.pow(Math.abs(Math.cos((m * phi) / 4) / a), n2) + Math.pow(Math.abs(Math.sin((m * phi) / 4) / b), n3);
  return s === 0 ? 0 : Math.pow(s, -1 / n1);
}

function supershapePt(theta, phi, A, B) {
  const r1 = superFormula(theta, 1, 1, A.m, A.n1, A.n2, A.n3);
  const r2 = superFormula(phi, 1, 1, B.m, B.n1, B.n2, B.n3);
  return [r1 * Math.cos(theta) * r2 * Math.cos(phi), r1 * Math.sin(theta) * r2 * Math.cos(phi), r2 * Math.sin(phi)];
}

const reSqrt = (a, b) => Math.sqrt(Math.max(0, (Math.hypot(a, b) + a) * 0.5));


// ---------- the shapes ----------

const W = (rand, s = 1) => (rand() < 0.75 ? randomWarp(rand, s) : null);

// A sheet from (u, v) patches; rails are segments (pairs of points, in the patches' frame) that stay solid like
// its open edges.
const sheet = (parts, w, rails = null) => ({ kind: "sheet", parts, rails, deform: w ? (T) => warp(T, w) : null });
const patch = (fn, u, v, clip = null, split = null) => ({ fn, u, v, clip, split });

const CATALOGUE = [
  {
    id: "boy",
    name: "Boy's surface",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ rho: range(rand, 0.92, 1), warp: W(rand, 0.8) }),
    build: (p) => sheet([patch(boyPt, [0, TAU], [0, p.rho])], p.warp),
  },
  {
    id: "klein-bottle",
    name: "Klein bottle",
    family: "parametric",
    kind: "sheet",
    cells: 0.8,
    random: (rand) => ({ neck: range(rand, 0.85, 1.2), fat: range(rand, 0.8, 1.6), warp: W(rand, 0.6) }),
    build: (p) => sheet([patch((u, v) => kleinBottle(u, v, p.neck, p.fat), [0, Math.PI], [0, TAU])], p.warp),
  },
  {
    id: "roman",
    name: "Roman surface",
    family: "parametric",
    kind: "sheet",
    cells: 0.8,
    random: (rand) => ({ squash: range(rand, 0.75, 1.25), warp: W(rand, 1) }),
    build: (p) => sheet([patch((u, v) => romanPt(u, v).map((c, i) => (i === 2 ? c * p.squash : c)), [0, TAU], [0, Math.PI / 2])], p.warp),
  },
  {
    id: "crosscap",
    name: "Cross-cap",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ height: range(rand, 0.8, 1.4), warp: W(rand, 1) }),
    build: (p) => sheet([patch((u, v) => crosscapPt(u, v).map((c, i) => (i === 2 ? c * p.height : c)), [0, TAU], [0, Math.PI / 2])], p.warp),
  },
  {
    id: "enneper",
    name: "Enneper surface",
    family: "parametric",
    kind: "sheet",
    random: (rand) => {
      const n = pick(rand, [1, 2, 2, 3, 3, 4]);
      return { n, R: range(rand, 1.05, 1.3) * [0, 1.5, 1.22, 1.13, 1.09][n], warp: W(rand, 0.7) };
    },
    build: (p) => sheet([patch((r, t) => enneperN(r, t, p.n), [0, p.R], [0, TAU])], p.warp),
  },
  {
    id: "costa",
    name: "Costa surface",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ clip: range(rand, 0.05, 0.09), planar: range(rand, 0.13, 0.2), warp: W(rand, 0.6) }),
    build: (p) => sheet([patch(costaPt, [0, 1], [0, 1], costaClip(p.clip, p.planar))], p.warp),
  },
  {
    id: "scherk-saddles",
    name: "Scherk saddles",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ cells: range(rand, 1.3, 1.7), height: range(rand, 2.5, 3.5), warp: W(rand, 0.8) }),
    build: (p) => {
      const R = p.cells * Math.PI, H = p.height;
      const f = (x, y, z) => Math.exp(z / 2) * Math.cos(x) - Math.exp(-z / 2) * Math.cos(y);
      const clip = (x, y, z) => Math.max(x * x + y * y + z * z * 1.6 - R * R, (Math.abs(z) - H) * 2 * R);
      return { kind: "sheet", implicit: { f, lo: [-R, -R, -H], hi: [R, R, H], clip }, deform: p.warp ? (T) => warp(T, p.warp) : null };
    },
  },
  {
    id: "associate",
    name: "Catenoid–helicoid",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ theta: range(rand, 0.35, 1.25), turns: range(rand, 1.2, 2), v: range(rand, 1.1, 1.5), warp: W(rand, 0.6) }),
    build: (p) => sheet([patch((u, v) => associatePt(u, v, p.theta), [0, TAU * p.turns], [-p.v, p.v])], p.warp),
  },
  {
    id: "seashell",
    name: "Seashell",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({
      turns: range(rand, 2.6, 4.2),
      growth: range(rand, 0.16, 0.28),
      tube: range(rand, 0.35, 0.6),
      cone: rand() < 0.35 ? range(rand, 0, 0.25) : range(rand, 0.6, 1.6),
      ell: range(rand, 0.8, 1.4),
      rib: rand() < 0.6 ? range(rand, 0.06, 0.16) : 0,
      ribs: Math.round(range(rand, 6, 14)),
      flare: range(rand, 0, 0.25),
      warp: rand() < 0.4 ? randomWarp(rand, 0.4) : null,
    }),
    build: (p) => {
      const T1 = p.turns * TAU, fn = (t, u) => seashellPt(t, u, p);
      const s = FIT / paramExtent(fn, [T1 - TAU, T1], [0, TAU]);
      // Starts the coil where the tube is still a few struts thick once fitted.
      const t0 = Math.max(0, Math.log(0.06 / (p.tube * s)) / p.growth);
      return sheet([patch(fn, [t0, T1], [0, TAU])], p.warp);
    },
  },
  {
    id: "supershape",
    name: "Supershape",
    family: "parametric",
    kind: "sheet",
    random: (rand) => {
      const A = { m: pick(rand, [5, 6, 7, 8, 9]), n1: range(rand, 0.32, 0.6), n2: range(rand, 0.6, 1.8), n3: range(rand, 0.6, 1.8) };
      const B = { m: pick(rand, [3, 4, 5, 6]), n1: range(rand, 0.35, 0.9), n2: range(rand, 0.5, 2.2), n3: range(rand, 0.5, 2.2) };
      return { A, B, warp: W(rand, 0.6) };
    },
    // Fewer cells, so the spikes still read once it has opened.
    cells: 0.7,
    build: (p) => sheet([patch((t, f) => supershapePt(t, f, p.A, p.B), [-Math.PI, Math.PI], [-Math.PI / 2, Math.PI / 2])], p.warp),
  },
  {
    id: "riemann",
    name: "Riemann surface",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ n: pick(rand, [2, 3, 3, 4]), R: range(rand, 1, 1.4), ht: range(rand, 0.7, 1.1), warp: W(rand, 0.7) }),
    build: (p) => {
      const fn = (r, th) => [r * Math.cos(th), r * Math.sin(th), p.ht * 1.1 * Math.pow(Math.max(r, 0), 1 / p.n) * Math.cos(th / p.n) * p.R];
      return sheet([patch(fn, [0, p.R], [0, TAU * p.n])], p.warp);
    },
  },
  {
    id: "riemann-elliptic",
    name: "Two-sheeted Riemann surface",
    family: "parametric",
    kind: "sheet",
    random: (rand) => ({ P: pick(rand, ["z3-z", "z3-1", "z4-1", "z2-1"]), ht: range(rand, 0.6, 1), warp: W(rand, 0.7) }),
    build: (p) => {
      const evalP = (x, y) => {
        const z2 = [x * x - y * y, 2 * x * y];
        const z3 = [z2[0] * x - z2[1] * y, z2[0] * y + z2[1] * x];
        const z4 = [z2[0] * z2[0] - z2[1] * z2[1], 2 * z2[0] * z2[1]];
        return { "z2-1": [z2[0] - 1, z2[1]], "z3-z": [z3[0] - x, z3[1] - y], "z3-1": [z3[0] - 1, z3[1]], "z4-1": [z4[0] - 1, z4[1]] }[p.P];
      };
      const E = 1.6;
      let peak = 0;
      for (let i = 0; i <= 32; i++) for (let j = 0; j <= 32; j++) {
        const x = -E + (2 * E * i) / 32, y = -E + (2 * E * j) / 32;
        if (x * x + y * y > E * E) continue;
        const P = evalP(x, y);
        peak = Math.max(peak, reSqrt(P[0], P[1]));
      }
      const hs = (p.ht * 0.8 * E) / peak;
      // Each sheet is cut where P is real, so along the branch cuts (P < 0) it can weld to the other sheet's far side
      // and carry on smoothly instead of creasing. Its seam is turned off the real axis, where P is often real.
      const part = (s) => patch((r, th) => {
        const x = r * Math.cos(th), y = r * Math.sin(th), P = evalP(x, y);
        return [x, y, s * reSqrt(P[0], P[1]) * hs];
      }, [0, E], [0.3, 0.3 + TAU], null, (r, th) => evalP(r * Math.cos(th), r * Math.sin(th))[1]);
      return sheet([part(1), part(-1)], p.warp);
    },
  },
];

export const SHAPES = CATALOGUE;
export { FIT };
