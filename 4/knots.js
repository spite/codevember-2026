import { DataTexture, FloatType, RGBAFormat, NearestFilter, Quaternion, Euler } from "three";

// A nested coil: flat bands with a rounded-rectangle section lie side by side, wide faces together,
// along one shared closed path that winds p times around a central hole (a (p, q) torus knot with a
// gentle wobble). The bundle twists along the path, so the bands spiral around each other, and
// each band breathes apart from its neighbours, slides and tilts a little. Every phase drifts with
// time, so the coil slowly writhes. Bands are sampled into a float texture: rows 0..MAX_TUBES-1
// hold centre xyz and half-width, rows MAX_TUBES.. the width axis and half-thickness.

const TAU = Math.PI * 2;
export const MAX_TUBES = 5;
export const SAMPLES = 128;
const SIZE = 1.15;
// Offset toward a bend's centre, as a fraction of its radius, where bands start easing out, and the most they reach.
const BEND = 0.45;
// Seconds a morph takes to finish when a new re-tie arrives before it has.
const HURRY = 0.4;
const BEND_SPAN = 0.3;
// While re-tying, the band rounds off over KINK samples either side of a step between neighbouring
// width axes sharper than acos(KINK_COS), fully at a right angle.
const KINK = 4;
const KINK_COS = Math.cos(Math.PI / 3);
// A coil whose band corners stretch less than this along the path somewhere is redrawn: it folds into a scrunchie.
const MIN_STRETCH = 0.2;
// Most a band's half-width or half-thickness may reach of its centreline's radius of curvature while re-tying.
const BEND_LIMIT = 0.7;
// Least span of the new path, in radians, over which turns the old coil has more than the new one shrink away.
const RETIE_SPAN = 1.2;

function randomCoil(n) {
  const r = (a, b) => a + Math.random() * (b - a);
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const wave = (amp, ks) => ({ k: pick(ks), amp, phase: r(0, TAU), speed: r(0.12, 0.3) * sign() });

  const p = pick([1, 2, 2, 2, 3]);
  const q = p === 1 ? 1 : p === 3 && Math.random() < 0.4 ? 2 : 1;
  const stack = 0.26 + 0.07 * n;
  const b = Math.min(0.085, (0.5 * stack) / n / 1.25);
  const a = b * r(2.7, 3.3);
  const half = 0.5 * Math.max(stack, 2 * a) * 0.95;
  const m = p === 1 ? r(0, 0.06) : (half / Math.sin(Math.PI / p)) * r(0.95, 1.1);
  // A single loop gets a wider hole, so its bands come out as thin as in a multi-turn coil.
  const R = m + half + r(0.16, 0.3) * (p === 1 ? 2.5 : 1);
  const scale = SIZE / (R + m + half);
  const twist = sign() * Math.max(1, p + Math.floor(r(-1, 1.6)));
  return {
    n, p, q, R, m, scale,
    my: m * r(0.8, 1.2),
    beta: { phase: r(0, TAU), speed: r(0.04, 0.1) * sign() },
    radial: wave(R * r(0.03, 0.08), [1, 2, 3]),
    lift: wave(r(0.04, 0.12), [1, 2, 3]),
    twist: { k: twist, phase: r(0, TAU), speed: r(0.12, 0.25) * sign(), wobble: wave(r(0.2, 0.6), [1, 2]) },
    // Spun about the hole axis, then tilted a little off facing the camera.
    rotation: new Quaternion().setFromEuler(new Euler(Math.PI / 2 + r(-0.5, 0.5), r(0, TAU), r(-0.45, 0.45), "XZY")),
    bands: Array.from({ length: n }, () => ({
      a: a * r(0.85, 1.12),
      b: b * r(0.85, 1.1),
      gap: wave(b * r(0.4, 0.9), [1, 2, 3, 4]),
      slide: wave(a * r(0.1, 0.45), [1, 2, 3]),
      tilt: wave(r(0.05, 0.3), [1, 2, 3]),
      swell: wave(r(0.05, 0.18), [2, 3, 4, 5]),
    })),
    gap: b * r(0.25, 0.6),
  };
}

// Smallest along-path stretch of any band's section corners over a few moments; at 0 or below the band folds over itself.
function stretch(c) {
  const d = new Float32Array(SAMPLES * MAX_TUBES * 8);
  let min = Infinity;
  for (let s = 0; s < 60; s += 5) {
    sampleCoil(c, s, d, IDENTITY);
    for (let i = 0; i < c.n; i++) {
      for (let j = 0; j < SAMPLES; j++) {
        const o0 = (i * SAMPLES + ((j + SAMPLES - 1) % SAMPLES)) * 4, o1 = (i * SAMPLES + ((j + 1) % SAMPLES)) * 4;
        const f0 = o0 + MAX_TUBES * SAMPLES * 4, f1 = o1 + MAX_TUBES * SAMPLES * 4;
        let tx = d[o1] - d[o0], ty = d[o1 + 1] - d[o0 + 1], tz = d[o1 + 2] - d[o0 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        // Change along the tangent of the width and thickness axes, scaled by the half sizes.
        const da = (d[f1] * d[o1 + 3] - d[f0] * d[o0 + 3]) * tx + (d[f1 + 1] * d[o1 + 3] - d[f0 + 1] * d[o0 + 3]) * ty + (d[f1 + 2] * d[o1 + 3] - d[f0 + 2] * d[o0 + 3]) * tz;
        const b0x = ty * d[f0 + 2] - tz * d[f0 + 1], b0y = tz * d[f0] - tx * d[f0 + 2], b0z = tx * d[f0 + 1] - ty * d[f0];
        const b1x = ty * d[f1 + 2] - tz * d[f1 + 1], b1y = tz * d[f1] - tx * d[f1 + 2], b1z = tx * d[f1 + 1] - ty * d[f1];
        const db = (b1x * d[f1 + 3] - b0x * d[f0 + 3]) * tx + (b1y * d[f1 + 3] - b0y * d[f0 + 3]) * ty + (b1z * d[f1 + 3] - b0z * d[f0 + 3]) * tz;
        min = Math.min(min, (tl - Math.abs(da) - Math.abs(db)) / tl);
      }
    }
  }
  return min;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const at = (w, phi, s) => w.amp * Math.sin(w.k * phi + w.phase + s * w.speed);

function rotationMatrix({ x, y, z, w }) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
}

const path = new Float64Array(SAMPLES * 3);
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Point of coil c's path at angle phi and time s, unscaled and unrotated, into out at o.
function pathPoint(c, phi, s, out, o) {
  const al = c.p * phi, be = c.q * phi + c.beta.phase + s * c.beta.speed;
  const rad = c.R + at(c.radial, phi, s) + c.m * Math.cos(be);
  out[o] = rad * Math.cos(al);
  out[o + 1] = c.my * Math.sin(be) + at(c.lift, phi, s);
  out[o + 2] = rad * Math.sin(al);
}

// Writes every band of coil c at time s into out, laid out like the texture; phis, if given, is
// the path angle of each sample instead of evenly spaced ones.
function sampleCoil(c, s, out, M = (c.matrix ??= rotationMatrix(c.rotation)), phis = null) {
  const { p, scale: k } = c;
  for (let j = 0; j < SAMPLES; j++) pathPoint(c, phis ? phis[j] : (j / SAMPLES) * TAU, s, path, j * 3);
  const n = c.n;
  for (let j = 0; j < SAMPLES; j++) {
    const phi = phis ? phis[j] : (j / SAMPLES) * TAU;
    const j0 = ((j + SAMPLES - 1) % SAMPLES) * 3, j1 = ((j + 1) % SAMPLES) * 3, o = j * 3;
    let tx = path[j1] - path[j0], ty = path[j1 + 1] - path[j0 + 1], tz = path[j1 + 2] - path[j0 + 2];
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    // Curvature vector of the path: how far inside a bend a band can sit before its centreline folds.
    const h2 = 4 / (tl * tl);
    let kx = (path[j1] - 2 * path[o] + path[j0]) * h2, ky = (path[j1 + 1] - 2 * path[o + 1] + path[j0 + 1]) * h2, kz = (path[j1 + 2] - 2 * path[o + 2] + path[j0 + 2]) * h2;
    const kt = kx * tx + ky * ty + kz * tz;
    kx -= kt * tx; ky -= kt * ty; kz -= kt * tz;
    const kk = Math.max(kx * kx + ky * ky + kz * kz, 1e-12);
    // N: away from the hole's axis, square to the path; B completes the frame.
    const al = p * phi;
    const rx = Math.cos(al), rz = Math.sin(al);
    const d = rx * tx + rz * tz;
    let nx = rx - d * tx, ny = -d * ty, nz = rz - d * tz;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const th = c.twist.k * phi + c.twist.phase + s * c.twist.speed + at(c.twist.wobble, phi, s);
    const ct = Math.cos(th), st = Math.sin(th);
    // S stacks the bands, W runs across their width.
    const sx = ct * nx + st * bx, sy = ct * ny + st * by, sz = ct * nz + st * bz;
    const wx = -st * nx + ct * bx, wy = -st * ny + ct * by, wz = -st * nz + ct * bz;
    // Offsets of each band along S: thicknesses plus breathing gaps, centred on the path.
    let total = 0;
    const offs = (c._offs ??= new Float64Array(MAX_TUBES));
    for (let i = 0; i < n; i++) {
      const B = c.bands[i];
      const g = i > 0 ? Math.max(c.gap + at(B.gap, phi, s), -0.3 * B.b) : 0;
      total += (i > 0 ? c.bands[i - 1].b + g : 0) + (i > 0 ? B.b : 0);
      offs[i] = total;
    }
    for (let i = 0; i < n; i++) {
      const B = c.bands[i];
      const off = offs[i] - 0.5 * total;
      const sl = at(B.slide, phi, s);
      const tilt = at(B.tilt, phi, s);
      const sw = 1 + at(B.swell, phi, s);
      let ox = off * sx + sl * wx, oy = off * sy + sl * wy, oz = off * sz + sl * wz;
      // Pulled out of the bend where it would pass its centre of curvature, so the centreline never turns back.
      const bend = ox * kx + oy * ky + oz * kz;
      if (bend > BEND) {
        const pull = (bend - BEND - BEND_SPAN * Math.tanh((bend - BEND) / BEND_SPAN)) / kk;
        ox -= pull * kx; oy -= pull * ky; oz -= pull * kz;
      }
      const x = path[o] + ox, y = path[o + 1] + oy, z = path[o + 2] + oz;
      const cu = Math.cos(tilt), su = Math.sin(tilt);
      const ux = cu * wx + su * sx, uy = cu * wy + su * sy, uz = cu * wz + su * sz;
      const o0 = (i * SAMPLES + j) * 4;
      const o1 = ((MAX_TUBES + i) * SAMPLES + j) * 4;
      out[o0] = k * (M[0] * x + M[3] * y + M[6] * z);
      out[o0 + 1] = k * (M[1] * x + M[4] * y + M[7] * z);
      out[o0 + 2] = k * (M[2] * x + M[5] * y + M[8] * z);
      out[o0 + 3] = k * B.a * sw;
      out[o1] = M[0] * ux + M[3] * uy + M[6] * uz;
      out[o1 + 1] = M[1] * ux + M[4] * uy + M[7] * uz;
      out[o1 + 2] = M[2] * ux + M[5] * uy + M[8] * uz;
      out[o1 + 3] = k * B.b * (0.5 + 0.5 * sw);
    }
  }
}

export class Knots {
  constructor() {
    this.data = new Float32Array(SAMPLES * MAX_TUBES * 8);
    this.texture = new DataTexture(this.data, SAMPLES, MAX_TUBES * 2, RGBAFormat, FloatType);
    this.texture.minFilter = this.texture.magFilter = NearestFilter;
    this.from = null;
    this.to = null;
    this.blend = 1;
    this.count = 0;
    this.bounds = new Float32Array(MAX_TUBES * 4); // per band: centre xyz, radius
  }

  // A new coil; when animate is set, the old one morphs into it. matchTwist lets the morph change the
  // new coil's twist so it needn't tear, which makes it depend on the old coil.
  randomize(n, animate, matchTwist = false) {
    let next = randomCoil(n);
    for (let k = 0; k < 8 && stretch(next) < MIN_STRETCH; k++) next = randomCoil(n);
    // Mid-morph, the running morph hurries to its end first, so the new one starts from what is shown.
    this.pending = animate && this.from && this.blend < 1 ? { next, n, matchTwist } : null;
    if (!this.pending) this._tie(next, n, animate, matchTwist);
  }

  _tie(next, n, animate, matchTwist) {
    this.matchTwist = matchTwist;
    this.from = animate && this.to ? this.to : null;
    this.to = next;
    // Sign of each band's width axis; the section is symmetric, so a re-tie may flip it for good.
    next.flip = new Float64Array(n).fill(1);
    this.ties = [];
    this.blend = this.from ? 0 : 1;
    this.count = n;
    this.align = null;
  }

  // Matches the old coil to the new one: a spin about its hole axis that brings the two rotations
  // closest, then which old path angle each new sample takes and the band order that put samples
  // nearest. Paths keep the same azimuth around the hole except over one span, where the turns one
  // coil has more than the other grow or shrink, so no stretch of band is sent across the hole.
  alignCoils(time) {
    const { from, to } = this;
    const qd = from.rotation.clone().invert().multiply(to.rotation);
    const psi = -2 * Math.atan2(qd.y, qd.w);
    const spin = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, psi);
    const Ms = rotationMatrix(spin);
    const S = SAMPLES, FINE = 1024;
    const pa = new Float64Array(S * 3), pb = new Float64Array(FINE * 3), v = [0, 0, 0];
    for (let j = 0; j < S; j++) {
      pathPoint(to, (j / S) * TAU, time, pa, j * 3);
      for (let c = 0; c < 3; c++) pa[j * 3 + c] *= to.scale;
    }
    for (let j = 0; j < FINE; j++) {
      pathPoint(from, (j / FINE) * TAU, time, v, 0);
      for (let c = 0; c < 3; c++) pb[j * 3 + c] = from.scale * (Ms[c] * v[0] + Ms[3 + c] * v[1] + Ms[6 + c] * v[2]);
    }
    // Rate of old path angle per new one along the span-to-be: a bump of turns over span L.
    const dp = from.p - to.p;
    const L = dp > 0 ? Math.min(TAU, Math.max(RETIE_SPAN, (1.5 * TAU * dp) / from.p)) : dp < 0 ? Math.min(TAU, (1.5 * TAU * -dp) / to.p) : TAU;
    const lam = dp >= 0 ? 1 : Math.min(1, (0.9 * from.p) / -dp / (1.5 * (TAU / L) - 1));
    const G = new Float64Array(S + 1);
    for (let k = 0; k < S; k++) {
      const x = ((k + 0.5) / S) * (TAU / L);
      const bump = x < 1 ? (TAU / L) * 6 * x * (1 - x) : 0;
      G[k + 1] = G[k] + 1 + (dp / from.p) * (lam * (bump - 1));
    }
    for (let k = 0; k <= S; k++) G[k] *= TAU / G[S];
    const phis = new Float64Array(S);
    const fill = (j0, c0) => {
      for (let j = 0; j < S; j++) phis[j] = c0 + G[(j - j0 + S) % S];
    };
    const cost = () => {
      let sum = 0;
      for (let j = 0; j < S; j++) {
        const u = ((((phis[j] / TAU) * FINE) % FINE) + FINE) % FINE;
        const i0 = Math.floor(u), f = u - i0, i1 = (i0 + 1) % FINE;
        for (let c = 0; c < 3; c++) sum += (pb[i0 * 3 + c] + (pb[i1 * 3 + c] - pb[i0 * 3 + c]) * f - pa[j * 3 + c]) ** 2;
      }
      return sum;
    };
    let best = Infinity, bj = 0, bc = 0;
    for (let j0 = 0; j0 < S; j0 += dp ? S / 16 : S) {
      for (let ci = 0; ci < 128; ci++) {
        fill(j0, (ci / 128) * TAU);
        const sum = cost();
        if (sum < best) { best = sum; bj = j0; bc = (ci / 128) * TAU; }
      }
    }
    fill(bj, bc);
    const a = this._a, b = this._b;
    sampleCoil(to, time, a, IDENTITY);
    sampleCoil(from, time, b, Ms, phis);
    const shift = 0, dir = 1;
    const bandCost = (rev) => {
      let cost = 0;
      for (let i = 0; i < to.n && i < from.n; i++) {
        const ib = rev ? from.n - 1 - i : i;
        for (let j = 0; j < SAMPLES; j++) {
          const jb = (((dir * j + shift) % SAMPLES) + SAMPLES) % SAMPLES;
          for (let c = 0; c < 3; c++) cost += (b[(ib * SAMPLES + jb) * 4 + c] - a[(i * SAMPLES + j) * 4 + c]) ** 2;
        }
      }
      return cost;
    };
    const reverse = from.n === to.n && bandCost(true) < bandCost(false);
    // The sample where the blended centreline comes closest to stalling (a turn shrinking to nothing).
    let stall = Infinity, seam = 0;
    const ib = reverse ? from.n - 1 : 0;
    for (let j = 0; j < S; j++) {
      const j0 = (j + S - 1) % S, j1 = (j + 1) % S;
      let ta2 = 0, tb2 = 0, tab = 0;
      for (let c = 0; c < 3; c++) {
        const ta = a[j1 * 4 + c] - a[j0 * 4 + c], tb = b[(ib * S + j1) * 4 + c] - b[(ib * S + j0) * 4 + c];
        ta2 += ta * ta; tb2 += tb * tb; tab += ta * tb;
      }
      const den = ta2 - 2 * tab + tb2;
      const e = den > 1e-12 ? Math.min(1, Math.max(0, (tb2 - tab) / den)) : 0.5;
      const v = Math.sqrt(Math.max(0, (1 - e) ** 2 * tb2 + 2 * e * (1 - e) * tab + e * e * ta2)) / ((1 - e) * Math.sqrt(tb2) + e * Math.sqrt(ta2) || 1);
      if (v < stall) { stall = v; seam = j; }
    }
    this.align = { shift, dir, reverse, phis, seam, spinMatrix: Ms, rotation: from.rotation.clone().multiply(spin.invert()) };
  }

  update(time, dt) {
    if (this.pending) {
      this.blend = Math.min(1, this.blend + dt / HURRY);
      if (this.blend === 1) {
        const { next, n, matchTwist } = this.pending;
        this.pending = null;
        this._tie(next, n, true, matchTwist);
      }
    } else if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / 2);
    const e = this.blend * this.blend * (3 - 2 * this.blend);
    const d = this.data;
    const a = (this._a ??= new Float32Array(d.length));
    const b = (this._b ??= new Float32Array(d.length));
    const from = this.from && this.blend < 1 ? this.from : null;
    const row = SAMPLES * 4;
    if (from) {
      // Both coils are blended unrotated, then turned together by the interpolated rotation.
      const bb = (this._bb ??= new Float32Array(d.length));
      if (!this.align) {
        this.alignCoils(time);
        if (this.matchTwist) this._matchTwist(time, a, b, bb);
      }
      sampleCoil(this.to, time, a, IDENTITY);
      this._remap(time, b, bb);
      for (let i = 0; i < this.count; i++) {
        const both = i < from.n;
        const sa = this.to.flip[i];
        for (let j = 0; j < SAMPLES; j++) {
          const o = i * row + j * 4;
          const f = (MAX_TUBES + i) * row + j * 4;
          if (both) {
            for (let c = 0; c < 4; c++) d[o + c] = bb[o + c] + (a[o + c] - bb[o + c]) * e;
            d[f + 3] = bb[f + 3] + (a[f + 3] - bb[f + 3]) * e;
          } else {
            // Bands that appear while re-tying grow from nothing.
            d[o] = a[o]; d[o + 1] = a[o + 1]; d[o + 2] = a[o + 2]; d[o + 3] = a[o + 3] * e;
            d[f] = sa * a[f]; d[f + 1] = sa * a[f + 1]; d[f + 2] = sa * a[f + 2]; d[f + 3] = a[f + 3] * e;
          }
        }
      }
      this._centreline(a, bb, e);
      for (let i = 0; i < Math.min(this.count, from.n); i++) this._retieFrames(i, a, bb, e);
      // Keep the coil's size: scale the blend about its centre so its RMS radius lerps between the two.
      const rms = (src, n, idx) => {
        let cx = 0, cy = 0, cz = 0, s2 = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < SAMPLES; j++) {
          const o = idx(i) * row + j * 4;
          cx += src[o]; cy += src[o + 1]; cz += src[o + 2];
        }
        const N = n * SAMPLES;
        cx /= N; cy /= N; cz /= N;
        for (let i = 0; i < n; i++) for (let j = 0; j < SAMPLES; j++) {
          const o = idx(i) * row + j * 4;
          s2 += (src[o] - cx) ** 2 + (src[o + 1] - cy) ** 2 + (src[o + 2] - cz) ** 2;
        }
        return [cx, cy, cz, Math.sqrt(s2 / N)];
      };
      const pairs = Math.min(this.count, from.n);
      const id = (i) => i;
      const [cx, cy, cz, r] = rms(d, pairs, id);
      const ra = rms(a, pairs, id)[3], rb = rms(bb, pairs, id)[3];
      const sc = r > 1e-6 ? (rb + (ra - rb) * e) / r : 1;
      const q = (this._q ??= new Quaternion()).copy(this.align.rotation).slerp(this.to.rotation, e);
      const M = rotationMatrix(q);
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < SAMPLES; j++) {
          const o = i * row + j * 4;
          const f = (MAX_TUBES + i) * row + j * 4;
          const x = cx + (d[o] - cx) * sc, y = cy + (d[o + 1] - cy) * sc, z = cz + (d[o + 2] - cz) * sc;
          d[o] = M[0] * x + M[3] * y + M[6] * z;
          d[o + 1] = M[1] * x + M[4] * y + M[7] * z;
          d[o + 2] = M[2] * x + M[5] * y + M[8] * z;
          const ux = d[f], uy = d[f + 1], uz = d[f + 2];
          const ul = Math.hypot(ux, uy, uz) || 1;
          d[f] = (M[0] * ux + M[3] * uy + M[6] * uz) / ul;
          d[f + 1] = (M[1] * ux + M[4] * uy + M[7] * uz) / ul;
          d[f + 2] = (M[2] * ux + M[5] * uy + M[8] * uz) / ul;
        }
      }
      this._capBends(Math.min(1, (1 - e) * 20));
    } else {
      sampleCoil(this.to, time, d);
      for (let i = 0; i < this.count; i++) {
        if (this.to.flip[i] > 0) continue;
        for (let j = 0; j < SAMPLES; j++) {
          const f = (MAX_TUBES + i) * row + j * 4;
          d[f] = -d[f]; d[f + 1] = -d[f + 1]; d[f + 2] = -d[f + 2];
        }
      }
    }
    for (let i = 0; i < this.count; i++) {
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < SAMPLES; j++) {
        const o = i * row + j * 4;
        cx += d[o];
        cy += d[o + 1];
        cz += d[o + 2];
      }
      cx /= SAMPLES;
      cy /= SAMPLES;
      cz /= SAMPLES;
      let rmax = 0;
      for (let j = 0; j < SAMPLES; j++) {
        const o = i * row + j * 4;
        const dx = d[o] - cx, dy = d[o + 1] - cy, dz = d[o + 2] - cz;
        rmax = Math.max(rmax, Math.sqrt(dx * dx + dy * dy + dz * dz) + d[o + 3]);
      }
      const B = this.bounds;
      B[i * 4] = cx;
      B[i * 4 + 1] = cy;
      B[i * 4 + 2] = cz;
      B[i * 4 + 3] = rmax;
    }
    this.texture.needsUpdate = true;
  }

  // Moves the paired bands onto a shared centreline built from blended tangents instead of blended
  // positions, so it never doubles back: each step turns from the old direction to the new one, rising
  // along the hole's axis where they disagree, with the blended length; what is left once around to
  // close the loop is taken off every step in proportion to its length.
  _centreline(a, b, e) {
    const d = this.data;
    const S = SAMPLES, row = S * 4, n = Math.min(this.count, this.from.n);
    const MA = (this._ma ??= new Float64Array(S * 3)), MB = (this._mb ??= new Float64Array(S * 3)), X = (this._mx ??= new Float64Array(S * 3));
    MA.fill(0); MB.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < S * 3; j++) {
        const o = i * row + Math.floor(j / 3) * 4 + (j % 3);
        MA[j] += a[o] / n; MB[j] += b[o] / n;
      }
    }
    let wx = 0, wy = 0, wz = 0, ws = 0;
    for (let j = 0; j < S; j++) {
      const q = j * 3, q1 = ((j + 1) % S) * 3;
      const ax = MA[q1] - MA[q], ay = MA[q1 + 1] - MA[q + 1], az = MA[q1 + 2] - MA[q + 2];
      const bx = MB[q1] - MB[q], by = MB[q1 + 1] - MB[q + 1], bz = MB[q1 + 2] - MB[q + 2];
      const la = Math.hypot(ax, ay, az) || 1e-9, lb = Math.hypot(bx, by, bz) || 1e-9;
      const dot = (ax * bx + ay * by + az * bz) / (la * lb);
      let tx = (1 - e) * bx / lb + e * ax / la, ty = (1 - e) * by / lb + e * ay / la + 2 * e * (1 - e) * (1 - dot), tz = (1 - e) * bz / lb + e * az / la;
      const s = lb + (la - lb) * e, l = s / (Math.hypot(tx, ty, tz) || 1);
      X[q] = tx * l; X[q + 1] = ty * l; X[q + 2] = tz * l;
      wx += X[q]; wy += X[q + 1]; wz += X[q + 2]; ws += s;
    }
    wx /= ws; wy /= ws; wz /= ws;
    // Steps into positions, then moved so their mean lands on the blend of the two centrelines' means.
    let px = 0, py = 0, pz = 0, cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < S; j++) {
      const q = j * 3, s = Math.hypot(X[q], X[q + 1], X[q + 2]);
      const sx = X[q] - s * wx, sy = X[q + 1] - s * wy, sz = X[q + 2] - s * wz;
      X[q] = px; X[q + 1] = py; X[q + 2] = pz;
      cx += px - MB[q] - (MA[q] - MB[q]) * e; cy += py - MB[q + 1] - (MA[q + 1] - MB[q + 1]) * e; cz += pz - MB[q + 2] - (MA[q + 2] - MB[q + 2]) * e;
      px += sx; py += sy; pz += sz;
    }
    cx /= S; cy /= S; cz /= S;
    for (let j = 0; j < S; j++) {
      const q = j * 3;
      const x = X[q] - cx - MB[q] - (MA[q] - MB[q]) * e, y = X[q + 1] - cy - MB[q + 1] - (MA[q + 1] - MB[q + 1]) * e, z = X[q + 2] - cz - MB[q + 2] - (MA[q + 2] - MB[q + 2]) * e;
      for (let i = 0; i < n; i++) {
        const o = i * row + j * 4;
        d[o] += x; d[o + 1] += y; d[o + 2] += z;
      }
    }
  }

  // Narrows and thins each band where its centreline bends tighter than its section can follow
  // (a turn growing or shrinking away while re-tying), so the swept section never folds through itself.
  _capBends(strength) {
    const d = this.data;
    const S = SAMPLES, row = S * 4;
    const cap = (this._cap ??= new Float64Array(S));
    for (let i = 0; i < this.count; i++) {
      for (let j = 0; j < S; j++) {
        const o0 = i * row + ((j + S - 1) % S) * 4, o = i * row + j * 4, o1 = i * row + ((j + 1) % S) * 4;
        let tx = d[o1] - d[o0], ty = d[o1 + 1] - d[o0 + 1], tz = d[o1 + 2] - d[o0 + 2];
        const h = 0.5 * Math.hypot(tx, ty, tz) || 1e-6;
        tx /= 2 * h; ty /= 2 * h; tz /= 2 * h;
        let kx = (d[o1] - 2 * d[o] + d[o0]) / (h * h), ky = (d[o1 + 1] - 2 * d[o + 1] + d[o0 + 1]) / (h * h), kz = (d[o1 + 2] - 2 * d[o + 2] + d[o0 + 2]) / (h * h);
        const kt = kx * tx + ky * ty + kz * tz;
        kx -= kt * tx; ky -= kt * ty; kz -= kt * tz;
        cap[j] = BEND_LIMIT / Math.max(Math.hypot(kx, ky, kz), 1e-6);
      }
      const low = (this._low ??= new Float64Array(S));
      for (let j = 0; j < S; j++) {
        low[j] = Infinity;
        for (let k = -3; k <= 3; k++) low[j] = Math.min(low[j], cap[(j + k + S) % S]);
      }
      for (let j = 0; j < S; j++) {
        let r = 0;
        for (let k = -3; k <= 3; k++) r += Math.min(low[(j + k + S) % S], 10) / 7;
        const o = i * row + j * 4, f = (MAX_TUBES + i) * row + j * 4;
        const w = Math.min(1, r / Math.max(d[o + 3], 1e-6)), t = Math.min(1, r / Math.max(d[f + 3], 1e-6));
        d[o + 3] *= 1 + (w - 1) * strength;
        d[f + 3] *= 1 + (t - 1) * strength;
      }
    }
  }

  // The old coil at time s, remapped to the new one's bands and samples, with its width-axis signs applied.
  _remap(s, b, bb) {
    const { from } = this;
    const { shift, dir, reverse, spinMatrix, phis } = this.align;
    const row = SAMPLES * 4;
    sampleCoil(from, s, b, spinMatrix, phis);
    for (let i = 0; i < Math.min(this.count, from.n); i++) {
      const ib = reverse ? from.n - 1 - i : i;
      const sb = from.flip[ib];
      for (let j = 0; j < SAMPLES; j++) {
        const jb = (((dir * j + shift) % SAMPLES) + SAMPLES) % SAMPLES;
        const o = i * row + j * 4, ob = ib * row + jb * 4;
        const f = (MAX_TUBES + i) * row + j * 4, fb = (MAX_TUBES + ib) * row + jb * 4;
        for (let c = 0; c < 4; c++) bb[o + c] = b[ob + c];
        for (let c = 0; c < 3; c++) bb[f + c] = sb * b[fb + c];
        bb[f + 3] = b[fb + 3];
      }
    }
  }

  // Half turns the new width axes wind about band i relative to the old ones, once around the band.
  _winding(i, a, b, e) {
    const st = this._angles(i, a, b, e);
    let w = 0;
    for (let j = 0; j < SAMPLES; j++) {
      const x = st[((j + 1) % SAMPLES) * 7 + 6] - st[j * 7 + 6];
      w += x - TAU * Math.round(x / TAU);
    }
    return Math.round(w / Math.PI);
  }

  // A closed band can't gain or lose whole turns of twist without tearing, so the new coil's bundle
  // twist is changed by whole turns, never to more than it had, to keep the bands' windings closest.
  _matchTwist(s, a, b, bb) {
    const { to } = this;
    const pairs = Math.min(to.n, this.from.n);
    this._remap(s, b, bb);
    const cost = () => {
      sampleCoil(to, s, a, IDENTITY);
      let c = 0;
      for (let i = 0; i < pairs; i++) c += Math.abs(this._winding(i, a, bb, 0.5));
      return c;
    };
    const k0 = to.twist.k, lim = Math.abs(k0);
    let best = cost(), kb = k0;
    for (let dk = 1; dk <= 2 * lim && best > 0; dk++) {
      for (const k of [k0 + dk, k0 - dk]) {
        if (k === 0 || Math.abs(k) > lim) continue;
        to.twist.k = k;
        const c = cost();
        if (c < best) { best = c; kb = k; }
      }
    }
    to.twist.k = kb;
  }

  // Per sample of band i while re-tying: the blended tangent, the old width axis square to it, and
  // the angle about it from the old axis to the new one.
  _angles(i, a, b, e) {
    const S = SAMPLES, row = S * 4;
    const st = (this._st ??= new Float64Array(S * 7));
    for (let j = 0; j < S; j++) {
      const o0 = i * row + ((j + S - 1) % S) * 4, o1 = i * row + ((j + 1) % S) * 4;
      const f = (MAX_TUBES + i) * row + j * 4;
      // Blended from the two bands' own tangents: the morphed centreline itself may fold.
      let ux = a[o1] - a[o0], uy = a[o1 + 1] - a[o0 + 1], uz = a[o1 + 2] - a[o0 + 2];
      let vx = b[o1] - b[o0], vy = b[o1 + 1] - b[o0 + 1], vz = b[o1 + 2] - b[o0 + 2];
      const ul = Math.hypot(ux, uy, uz) || 1, vl = Math.hypot(vx, vy, vz) || 1;
      ux /= ul; uy /= ul; uz /= ul; vx /= vl; vy /= vl; vz /= vl;
      let tx = e * ux + (1 - e) * vx, ty = e * uy + (1 - e) * vy, tz = e * uz + (1 - e) * vz;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // Each band's axis turned with its tangent onto the blended one by the least rotation, so
      // neither degenerates when an axis lies along the blended tangent.
      const turn = (x, y, z, sx, sy, sz, out) => {
        const c = 1 + sx * tx + sy * ty + sz * tz;
        if (c < 1e-6) { out[0] = x; out[1] = y; out[2] = z; }
        else {
          const hx = sx + tx, hy = sy + ty, hz = sz + tz;
          const k1 = 2 * (sx * x + sy * y + sz * z), k2 = (hx * x + hy * y + hz * z) / c;
          out[0] = x + k1 * tx - k2 * hx; out[1] = y + k1 * ty - k2 * hy; out[2] = z + k1 * tz - k2 * hz;
        }
        const k = out[0] * tx + out[1] * ty + out[2] * tz;
        out[0] -= k * tx; out[1] -= k * ty; out[2] -= k * tz;
        const l = Math.hypot(out[0], out[1], out[2]) || 1;
        out[0] /= l; out[1] /= l; out[2] /= l;
      };
      const W = (this._w ??= [0, 0, 0]);
      turn(b[f], b[f + 1], b[f + 2], vx, vy, vz, W);
      const bx = W[0], by = W[1], bz = W[2];
      turn(a[f], a[f + 1], a[f + 2], ux, uy, uz, W);
      const px = W[0], py = W[1], pz = W[2];
      // Angle from the old axis to the new one about the tangent.
      const cx = by * pz - bz * py, cy = bz * px - bx * pz, cz = bx * py - by * px;
      const q = j * 7;
      st[q] = tx; st[q + 1] = ty; st[q + 2] = tz;
      st[q + 3] = bx; st[q + 4] = by; st[q + 5] = bz;
      st[q + 6] = Math.atan2(cx * tx + cy * ty + cz * tz, bx * px + by * py + bz * pz);
    }
    return st;
  }

  // Width axes of band i while re-tying. The axis at the start (opposite the stall) turns from the
  // old axis toward the new one; every next sample is carried along the drawn centreline, which never
  // doubles back, and turned by the blend of the old and new bands' twists from sample to sample, which
  // depends on no choice of sign, so axes never jump between neighbours or frames. The twist left over once
  // around is spread along the band, and mid-blend it gathers into a step at the stall, where the
  // band is rounded off.
  _retieFrames(i, a, b, e) {
    const d = this.data;
    const S = SAMPLES, row = S * 4;
    const sc = this.align.seam, s0 = (sc + S / 2) % S;
    const T = (this._ft ??= new Float64Array(S * 3)), V = (this._fv ??= new Float64Array(S * 3)), U = (this._fu ??= new Float64Array(S * 3));
    const O = (this._fo ??= new Float64Array(S * 3)), N = (this._fn ??= new Float64Array(S * 3));
    // The propagated frame: tangent and width axis.
    const F = (this._ff ??= new Float64Array(S * 3)), G = (this._fg ??= new Float64Array(S * 3));
    let q;
    const tangents = (src, out) => {
      for (let j = 0; j < S; j++) {
        const o0 = i * row + ((j + S - 1) % S) * 4, o1 = i * row + ((j + 1) % S) * 4;
        const x = src[o1] - src[o0], y = src[o1 + 1] - src[o0 + 1], z = src[o1 + 2] - src[o0 + 2];
        const l = Math.hypot(x, y, z);
        if (l < 1e-9 && j > 0) { out[j * 3] = out[j * 3 - 3]; out[j * 3 + 1] = out[j * 3 - 2]; out[j * 3 + 2] = out[j * 3 - 1]; }
        else { out[j * 3] = x / (l || 1); out[j * 3 + 1] = y / (l || 1); out[j * 3 + 2] = z / (l || 1); }
      }
    };
    tangents(d, T);
    tangents(b, V);
    tangents(a, U);
    const v = (this._fv3 ??= [0, 0, 0]);
    // (x, y, z) square to tangent tg[j], unit, into v.
    const square = (x, y, z, tg, j) => {
      const q = j * 3, k = x * tg[q] + y * tg[q + 1] + z * tg[q + 2];
      x -= k * tg[q]; y -= k * tg[q + 1]; z -= k * tg[q + 2];
      const l = Math.hypot(x, y, z) || 1;
      v[0] = x / l; v[1] = y / l; v[2] = z / l;
    };
    for (let j = 0; j < S; j++) {
      const f = (MAX_TUBES + i) * row + j * 4, q = j * 3;
      square(b[f], b[f + 1], b[f + 2], V, j);
      O[q] = v[0]; O[q + 1] = v[1]; O[q + 2] = v[2];
      square(a[f], a[f + 1], a[f + 2], U, j);
      N[q] = v[0]; N[q + 1] = v[1]; N[q + 2] = v[2];
    }
    // (x, y, z) carried from tangent (ax, ay, az) onto B[j] by the least rotation, square to it and unit, into v.
    const carry = (x, y, z, ax, ay, az, B, j) => {
      const q = j * 3, bx = B[q], by = B[q + 1], bz = B[q + 2];
      const c = 1 + ax * bx + ay * by + az * bz;
      if (c > 1e-6) {
        const hx = ax + bx, hy = ay + by, hz = az + bz;
        const k1 = 2 * (ax * x + ay * y + az * z), k2 = (hx * x + hy * y + hz * z) / c;
        x += k1 * bx - k2 * hx; y += k1 * by - k2 * hy; z += k1 * bz - k2 * hz;
      }
      square(x, y, z, B, j);
    };
    // Angle about T[j] from v to (x, y, z).
    const angle = (x, y, z, j) => {
      const q = j * 3;
      const cx = v[1] * z - v[2] * y, cy = v[2] * x - v[0] * z, cz = v[0] * y - v[1] * x;
      return Math.atan2(cx * T[q] + cy * T[q + 1] + cz * T[q + 2], v[0] * x + v[1] * y + v[2] * z);
    };
    // Old and new axes at the start, each carried from its own tangent onto the drawn one.
    q = s0 * 3;
    carry(N[q], N[q + 1], N[q + 2], U[q], U[q + 1], U[q + 2], T, s0);
    const nx = v[0], ny = v[1], nz = v[2];
    carry(O[q], O[q + 1], O[q + 2], V[q], V[q + 1], V[q + 2], T, s0);
    const ox = v[0], oy = v[1], oz = v[2];
    const x0 = angle(nx, ny, nz, s0);
    let tie = this.ties[i];
    if (!tie) {
      // More than a quarter turn away: the new axis is used reversed.
      const flip = Math.abs(x0) > 0.5 * Math.PI;
      if (flip) this.to.flip[i] = -1;
      tie = this.ties[i] = { u0: x0 + (flip ? (x0 > 0 ? -Math.PI : Math.PI) : 0), delta: 0 };
    }
    const x = x0 + (this.to.flip[i] < 0 ? Math.PI : 0);
    tie.u0 = x + TAU * Math.round((tie.u0 - x) / TAU);
    let c = Math.cos(e * tie.u0), sn = Math.sin(e * tie.u0);
    F[q] = T[q]; F[q + 1] = T[q + 1]; F[q + 2] = T[q + 2];
    G[q] = c * ox + sn * (T[q + 1] * oz - T[q + 2] * oy);
    G[q + 1] = c * oy + sn * (T[q + 2] * ox - T[q] * oz);
    G[q + 2] = c * oz + sn * (T[q] * oy - T[q + 1] * ox);
    // Twist of a band's axis P from sample jp to j about its tangent B, past what carrying it along B turns.
    const twist = (P, B, jp, j) => {
      const p = jp * 3, q = j * 3;
      carry(P[p], P[p + 1], P[p + 2], B[p], B[p + 1], B[p + 2], B, j);
      const cx = v[1] * P[q + 2] - v[2] * P[q + 1], cy = v[2] * P[q] - v[0] * P[q + 2], cz = v[0] * P[q + 1] - v[1] * P[q];
      return Math.atan2(cx * B[q] + cy * B[q + 1] + cz * B[q + 2], v[0] * P[q] + v[1] * P[q + 1] + v[2] * P[q + 2]);
    };
    let jp = s0;
    for (let k = 1; k <= S; k++) {
      const j = (s0 + k) % S;
      // The axis carried along the drawn centreline, turned by the blend of the old and new twists.
      const tw = twist(O, V, jp, j) * (1 - e) + twist(N, U, jp, j) * e;
      const p = jp * 3;
      carry(G[p], G[p + 1], G[p + 2], T[p], T[p + 1], T[p + 2], T, j);
      q = j * 3;
      c = Math.cos(tw); sn = Math.sin(tw);
      const wx = c * v[0] + sn * (T[q + 1] * v[2] - T[q + 2] * v[1]);
      const wy = c * v[1] + sn * (T[q + 2] * v[0] - T[q] * v[2]);
      const wz = c * v[2] + sn * (T[q] * v[1] - T[q + 1] * v[0]);
      if (k === S) {
        // Twist still unmatched once around, followed continuously over time.
        square(wx, wy, wz, T, s0);
        const r = -angle(G[s0 * 3], G[s0 * 3 + 1], G[s0 * 3 + 2], s0);
        tie.delta = r + TAU * Math.round((tie.delta - r) / TAU);
      } else {
        F[q] = T[q]; F[q + 1] = T[q + 1]; F[q + 2] = T[q + 2];
        G[q] = wx; G[q + 1] = wy; G[q + 2] = wz;
      }
      jp = j;
    }
    // Spread along the band from the start, and the rest, mid-blend, as a step at the stall.
    const spread = tie.delta * (1 - smooth(0.3, 0.7, e)), kc = (sc - s0 + S) % S;
    for (let k = 0; k < S; k++) {
      const j = (s0 + k) % S;
      q = j * 3;
      carry(G[q], G[q + 1], G[q + 2], F[q], F[q + 1], F[q + 2], T, j);
      const psi = (spread * k) / S + (k >= kc ? tie.delta - spread : 0);
      c = Math.cos(psi); sn = Math.sin(psi);
      const Tx = T[q], Ty = T[q + 1], Tz = T[q + 2];
      const f = (MAX_TUBES + i) * row + j * 4;
      d[f] = c * v[0] - sn * (Ty * v[2] - Tz * v[1]);
      d[f + 1] = c * v[1] - sn * (Tz * v[0] - Tx * v[2]);
      d[f + 2] = c * v[2] - sn * (Tx * v[1] - Ty * v[0]);
    }
    // Where neighbouring axes still part, round the band off.
    const kink = (this._kink ??= new Float64Array(S));
    kink.fill(0);
    // Fully round at the stall once its step passes 30 degrees.
    const fa = (MAX_TUBES + i) * row + ((sc + S - 1) % S) * 4, fb = (MAX_TUBES + i) * row + sc * 4;
    const cs = d[fa] * d[fb] + d[fa + 1] * d[fb + 1] + d[fa + 2] * d[fb + 2];
    // Also once the axes there actually part by more than 20 degrees, fully by 28.
    const gs = Math.max(smooth(0, 1 - Math.cos(Math.PI / 6), 1 - Math.cos(tie.delta - spread)), smooth(1 - Math.cos(Math.PI / 9), 1 - Math.cos((Math.PI * 28) / 180), 1 - cs));
    for (let k = -KINK; k < KINK; k++) {
      const x = (k < 0 ? -k - 1 : k) / KINK;
      kink[(sc + k + S) % S] = gs * (1 - x * x * (3 - 2 * x));
    }
    for (let j = 0; j < S; j++) {
      const f0 = (MAX_TUBES + i) * row + j * 4, f1 = (MAX_TUBES + i) * row + ((j + 1) % S) * 4;
      const c = d[f0] * d[f1] + d[f0 + 1] * d[f1 + 1] + d[f0 + 2] * d[f1 + 2];
      let g = Math.min(1, Math.max(0, (KINK_COS - c) / KINK_COS));
      g = g * g * (3 - 2 * g);
      if (g === 0) continue;
      for (let k = -KINK; k < KINK; k++) {
        const x = (k < 0 ? -k - 1 : k) / KINK;
        const n = (j + 1 + k + S) % S;
        kink[n] = Math.max(kink[n], g * (1 - x * x * (3 - 2 * x)));
      }
    }
    for (let j = 0; j < S; j++) {
      if (kink[j] === 0) continue;
      const o = i * row + j * 4, f = (MAX_TUBES + i) * row + j * 4;
      d[o + 3] += (Math.min(d[f + 3], d[o + 3]) - d[o + 3]) * kink[j];
    }
  }
}
