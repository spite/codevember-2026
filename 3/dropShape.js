// Pendant drop outlines from the Young–Laplace equation, tabulated once. Lengths are in capillary lengths, the apex is at
// z = 0 and z points up to the root, a circle of radius κ on the skin. A drop's root narrows as it fills (from κ0 to
// κ1), so it goes from a shallow lens through a hemisphere to a pear that tapers to a narrow root, filleted broadly into
// the skin; a synthetic neck pinches it off.
const KAPPAS = [0.18, 0.24, 0.32, 0.42, 0.55, 0.72];
// Stages per table, evenly spaced in volume from 0 to the largest stable drop, and arc samples per outline.
const STAGES = 20;
const K = 64;
const SUB = 4;
// Fillet into the skin: radius over max(κ, FILLET_W·W).
const FILLET = 0.75;
const FILLET_W = 0.6;
// Neck, lengths over the bulb radius: its height above the equator, the closed bulb's top, the thread at the snap over
// the neck's radius, how far the bulb sinks while it necks, the bulb–thread smoothing, and the remnant cone's profile
// (straight, then flaring) and least top radius.
const NECK_UP = 0.8;
const BULB_TOP = 0.9;
const NU_END = 0.03;
const NECK_SINK = 1.0;
const NECK_SOFT = 0.22;
const CONE_POW = [1, 1.6];
const CONE_TOP = 0.85;
const NM = 56;
const NF = 20;
const MAXPTS = 2 * (K + 1) + NM + NF + 4;

// Integrates φ' = 2/b − z − sin φ / x over arc length S from the apex (apex radius b); writes K + 1 samples when out.
function shoot(b, S, out = null, o = 0) {
  let x = 0, z = 0, f = 0, V = 0;
  const n = K * SUB, h = S / n;
  const df = (x, z, f) => 2 / b - z - (x > 1e-9 ? Math.sin(f) / x : 1 / b);
  if (out) (out.x[o] = 0), (out.z[o] = 0);
  for (let i = 1; i <= n; i++) {
    const c1 = Math.cos(f), s1 = Math.sin(f), d1 = df(x, z, f);
    const f2 = f + 0.5 * h * d1, c2 = Math.cos(f2), s2 = Math.sin(f2), d2 = df(x + 0.5 * h * c1, z + 0.5 * h * s1, f2);
    const f3 = f + 0.5 * h * d2, c3 = Math.cos(f3), s3 = Math.sin(f3), d3 = df(x + 0.5 * h * c2, z + 0.5 * h * s2, f3);
    const f4 = f + h * d3, c4 = Math.cos(f4), s4 = Math.sin(f4), d4 = df(x + h * c3, z + h * s3, f4);
    const nx = x + (h / 6) * (c1 + 2 * c2 + 2 * c3 + c4);
    const nz = z + (h / 6) * (s1 + 2 * s2 + 2 * s3 + s4);
    f += (h / 6) * (d1 + 2 * d2 + 2 * d3 + d4);
    V += (Math.PI / 3) * (x * x + x * nx + nx * nx) * (nz - z);
    x = nx;
    z = nz;
    if (out && i % SUB === 0) (out.x[o + i / SUB] = x), (out.z[o + i / SUB] = z);
  }
  return { x, z, f, V };
}

// Root arc length S → apex radius b by secant continuation, until the volume peaks (the largest stable drop).
function buildTable(kappa) {
  const fam = [];
  let b0 = 50, b1 = 50, Vprev = 0;
  const S1 = 3.5 * kappa + 1.5;
  for (let i = 1; i <= 120; i++) {
    const S = kappa * 1.0005 + (S1 - kappa) * (i / 120) ** 1.3;
    const g = (l) => shoot(Math.exp(l), S).x - kappa;
    let la = i > 2 ? 2 * Math.log(b1) - Math.log(b0) : Math.log(b1);
    let ga = g(la), lc = la - 0.05, gc = g(lc);
    for (let it = 0; it < 30 && Math.abs(gc) > 1e-7; it++) {
      const ln = lc - (gc * (lc - la)) / (gc - ga || 1e-12);
      (la = lc), (ga = gc);
      lc = Math.min(Math.max(ln, lc - 0.5), lc + 0.5);
      gc = g(lc);
    }
    if (Math.abs(gc) > 1e-5) break;
    const b = Math.exp(lc), V = shoot(b, S).V;
    if (V < Vprev) break;
    fam.push({ S, b, V });
    (b0 = b1), (b1 = b), (Vprev = V);
  }
  const Vmax = fam[fam.length - 1].V;
  const t = { kappa, Vmax, x: new Float64Array(STAGES * (K + 1)), z: new Float64Array(STAGES * (K + 1)) };
  // Stage 0 is the flat root disc.
  for (let i = 0; i <= K; i++) t.x[i] = (kappa * i) / K;
  let j = 0;
  for (let s = 1; s < STAGES; s++) {
    const V = (Vmax * s) / (STAGES - 1);
    while (j < fam.length - 1 && fam[j + 1].V < V) j++;
    const a = j === 0 && V < fam[0].V ? { S: kappa, b: 1e4, V: 0 } : fam[j], c = fam[Math.min(j + 1, fam.length - 1)];
    const u = c.V > a.V ? Math.min(1, Math.max(0, (V - a.V) / (c.V - a.V))) : 1;
    shoot(a.b + (c.b - a.b) * u, a.S + (c.S - a.S) * u, t, s * (K + 1));
  }
  return t;
}

let tables = null;
export const dropTables = () => (tables ??= KAPPAS.map(buildTable));

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
// Table pair and weight for root radius κ.
function bracket(kappa) {
  let i = 0;
  while (i < KAPPAS.length - 2 && KAPPAS[i + 1] < kappa) i++;
  return [i, clamp((kappa - KAPPAS[i]) / (KAPPAS[i + 1] - KAPPAS[i]), 0, 1)];
}

// Largest stable volume for root radius κ, in capillary units.
export function dropVmax(kappa) {
  const t = dropTables(), [i, w] = bracket(kappa);
  return Math.exp(Math.log(t[i].Vmax) + (Math.log(t[i + 1].Vmax) - Math.log(t[i].Vmax)) * w);
}

// Root radius of a drop at fill v that starts as a lens on κ0 and hangs from κ1 once full.
const rootAt = (k0, k1, v) => k1 + (k0 - k1) * (1 - smoothstep(0.03, 0.8, v));

// One outline: n points (r, z) from the tip (z = 0) up to the skin, z non-decreasing; volumes in capillary units.
export function createOutline() {
  return { r: new Float64Array(MAXPTS), z: new Float64Array(MAXPTS), n: 0, H: 0, V: 0, W: 0, zEq: 0, zNeck: 0, zCut: 0, zN0: 0, zN1: 0, Vbelow: 0, root: 0 };
}

const bx = new Float64Array(K + 1), bz = new Float64Array(K + 1);
// Base radius at height z on the stage outline in bx, bz.
function baseR(z) {
  if (z <= 0) return 0;
  if (z >= bz[K]) return bx[K];
  let lo = 0, hi = K;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (bz[m] <= z) lo = m;
    else hi = m;
  }
  const t = (z - bz[lo]) / Math.max(bz[hi] - bz[lo], 1e-12);
  return bx[lo] + (bx[hi] - bx[lo]) * t;
}

// Unnecked outline of volume V on root κ into bx, bz, stretched by s above the equator at the same volume; returns
// the equator index.
function base(kappa, V, s) {
  const t = dropTables(), [i, w] = bracket(kappa);
  const A = t[i], B = t[i + 1];
  const st = (T) => {
    const u = clamp(V / T.Vmax, 0, 1) * (STAGES - 1), s0 = Math.min(Math.floor(u), STAGES - 2);
    return [s0 * (K + 1), u - s0];
  };
  const [a0, fa] = st(A), [b0, fb] = st(B);
  for (let j = 0; j <= K; j++) {
    const ax = A.x[a0 + j] + (A.x[a0 + K + 1 + j] - A.x[a0 + j]) * fa, az = A.z[a0 + j] + (A.z[a0 + K + 1 + j] - A.z[a0 + j]) * fa;
    const bxx = B.x[b0 + j] + (B.x[b0 + K + 1 + j] - B.x[b0 + j]) * fb, bzz = B.z[b0 + j] + (B.z[b0 + K + 1 + j] - B.z[b0 + j]) * fb;
    bx[j] = ax + (bxx - ax) * w;
    bz[j] = az + (bzz - az) * w;
  }
  let ie = 0;
  for (let j = 1; j <= K; j++) {
    if (bz[j] < bz[j - 1]) bz[j] = bz[j - 1];
    if (bx[j] > bx[ie]) ie = j;
  }
  if (s > 1.0001 && ie < K) {
    // Viscous drips hang longer above the bulb: the taper stretches, the round bottom barely does.
    const sb = s ** 0.2, zE = bz[ie];
    let V0 = 0, V1 = 0;
    for (let j = 1; j <= K; j++) {
      const a = (Math.PI / 3) * (bx[j - 1] ** 2 + bx[j - 1] * bx[j] + bx[j] ** 2);
      const z0 = bz[j - 1], z1 = bz[j];
      const m = (z) => (z <= zE ? z * sb : zE * sb + (z - zE) * s);
      V0 += a * (z1 - z0);
      V1 += a * (m(z1) - m(z0));
    }
    for (let j = 0; j <= K; j++) bz[j] = bz[j] <= zE ? bz[j] * sb : zE * sb + (bz[j] - zE) * s;
    const k = Math.sqrt(V0 / Math.max(V1, 1e-12));
    for (let j = 0; j <= K; j++) bx[j] *= k;
  }
  return ie;
}

// Polynomial smooth max and min with blend width k.
const smax = (a, b, k) => {
  if (k <= 1e-9) return Math.max(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return a + (b - a) * h + k * h * (1 - h);
};
const smin = (a, b, k) => -smax(-a, -b, k);

// Outline of a drop that starts as a lens on root κ0 and hangs from κ1, at fill v (share of κ1's largest stable volume),
// stretched by s above its equator. pinch (0..1) necks it above the bulb; cut keeps only the remnant above a closed neck.
export function dropOutline(o, k0, k1, v, s, pinch = 0, cut = false) {
  o.n = 0;
  o.H = o.V = o.W = o.zEq = o.zNeck = o.zCut = o.zN0 = o.zN1 = o.Vbelow = 0;
  const kappa = rootAt(k0, k1, v);
  o.root = kappa;
  if (!(v > 1e-5)) return o;
  const ie = base(kappa, v * dropVmax(k1), s);
  const W = bx[ie], zEq = bz[ie], Hb = bz[K];
  o.W = W;
  o.zEq = zEq;
  const r = o.r, z = o.z;
  let n = 0;
  if (pinch > 0 && Hb > zEq + 0.3 * W) {
    // The bulb closes round below the neck at zc and sinks by d; above, a thread thinnest at the bulb opens into a cone
    // that meets the taper, which rides up by d.
    const e = pinch;
    const zn = Math.min(zEq + NECK_UP * W, 0.5 * (zEq + Hb));
    const rc = baseR(zn);
    // The bulb's top rounds up to BULB_TOP·W over the equator; the taper above the neck rides up out of its way.
    const zc = zn + Math.max(0, zEq + BULB_TOP * W - zn) * smoothstep(0, 0.6, e);
    const d = zc - zn + NECK_SINK * W * e * e;
    const hc = zc - zEq;
    const rn = rc * Math.max(NU_END, (1 - e) ** 0.7);
    const k = NECK_SOFT * W * smoothstep(0, 0.4, e);
    const fade = (1 - e) ** 2;
    const top = Hb + d;
    // Above the neck the taper gives way to a cone from the root down to the thread, from the neck upwards over a share
    // tau of the remnant's length.
    const tau = mix(0.05, 1.3, smoothstep(0, 0.6, e));
    const Lc = Math.min(tau, 1) * (top - zc);
    const kr = Math.max(bx[K], CONE_TOP * W);
    const pw = mix(CONE_POW[0], CONE_POW[1], e * e);
    o.zNeck = o.zCut = zc;
    const rAt = (zz) => {
      if (zz <= zEq) return baseR(zz);
      if (zz < zc) {
        const env = baseR(zEq + ((zz - zEq) * (zn - zEq)) / hc), u = (zz - zEq) / hc;
        return smax(smin(env, W * Math.sqrt(Math.max(0, 1 - u * u)), k * smoothstep(0, 0.6, u)), rn + (env - rc) * fade, k);
      }
      const t = (zz - zc) / (top - zc);
      const T = baseR(zn + t * (Hb - zn));
      const cone = rn + (kr - rn) * t ** pw;
      return smax(0, T + (cone - T) * (1 - smoothstep(0, tau, t)), k);
    };
    const z0 = zEq, z1 = Math.min(zc + Lc + 0.3 * W, top - 1e-4);
    const shift = cut ? zc : 0;
    // The join of bulb and thread, which pendants.js gives extra vertices.
    o.zN0 = Math.max(zc - 0.35 * W - shift, 0);
    o.zN1 = zc + 0.5 * W - shift;
    if (cut) (r[n] = 0), (z[n++] = 0);
    else for (let i = 0; i <= K && bz[i] < z0; i++) (r[n] = bx[i]), (z[n++] = bz[i]);
    for (let j = 0; j <= NM; j++) {
      // Denser near the neck.
      const u = j / NM;
      const zj = u < 0.5 ? z0 + (zc - z0) * (1 - (1 - 2 * u) ** 1.6) : zc + (z1 - zc) * (2 * u - 1) ** 1.6;
      if (cut && zj <= zc) continue;
      r[n] = rAt(zj);
      z[n++] = zj - shift;
    }
    for (let i = 0; i <= K; i++) if (bz[i] + d > z1) (r[n] = rAt(bz[i] + d)), (z[n++] = bz[i] + d - shift);
  } else for (let i = 0; i <= K; i++) (r[n] = bx[i]), (z[n++] = bz[i]);
  // Fillet: a concave arc of radius F from the highest point where it still lands on the skin plane by the root's
  // height, turning the outline's tangent back to the skin.
  const F = FILLET * Math.max(kappa, FILLET_W * W) * smoothstep(0, 0.15, v);
  const H0 = z[n - 1];
  if (F > 1e-6 && n > 3) {
    let i = n - 2, ph = 0;
    for (; i > 1; i--) {
      ph = Math.atan2(z[i + 1] - z[i - 1], r[i + 1] - r[i - 1]);
      if (z[i] + F * (1 - Math.cos(ph)) <= H0) break;
    }
    if (ph > 1e-3) {
      const cx = r[i] + F * Math.sin(ph), cz = z[i] - F * Math.cos(ph);
      n = i + 1;
      for (let j = 1; j <= NF; j++) {
        const a = ph * (1 - j / NF);
        r[n] = cx - F * Math.sin(a);
        z[n] = Math.max(cz + F * Math.cos(a), z[n - 1]);
        n++;
      }
    }
  }
  o.n = n;
  o.H = z[n - 1];
  o.root = r[n - 1];
  let V = 0, Vb = 0;
  for (let i = 1; i < n; i++) {
    const dv = (Math.PI / 3) * (r[i - 1] ** 2 + r[i - 1] * r[i] + r[i] ** 2) * (z[i] - z[i - 1]);
    V += dv;
    if (z[i] <= o.zCut) Vb += dv;
  }
  o.V = V;
  o.Vbelow = Vb;
  return o;
}

// Radius of outline o at height z above its tip.
export function outlineR(o, zz) {
  const n = o.n, z = o.z, r = o.r;
  if (n < 2 || zz <= 0) return n ? r[0] : 0;
  if (zz >= z[n - 1]) return r[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (z[m] <= zz) lo = m;
    else hi = m;
  }
  const t = (zz - z[lo]) / Math.max(z[hi] - z[lo], 1e-12);
  return r[lo] + (r[hi] - r[lo]) * t;
}
