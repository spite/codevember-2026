// An ideal pendulum solved exactly (Jacobi's sn), so its timing holds at any amplitude and never drifts.
const G = 9.81;

function agm(a, b) {
  for (let i = 0; i < 32 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return a;
}

// Complete elliptic integral of the first kind, parameter m = k².
function ellipK(m) {
  return Math.PI / (2 * agm(1, Math.sqrt(1 - m)));
}

// Carlson's symmetric integral R_F.
function carlsonRF(x, y, z) {
  for (let n = 0; n < 40; n++) {
    const l = Math.sqrt(x * y) + Math.sqrt(y * z) + Math.sqrt(z * x);
    x = (x + l) / 4;
    y = (y + l) / 4;
    z = (z + l) / 4;
    const a = (x + y + z) / 3;
    if (Math.max(Math.abs(a - x), Math.abs(a - y), Math.abs(a - z)) < 1e-9 * a) break;
  }
  const a = (x + y + z) / 3;
  const X = 1 - x / a;
  const Y = 1 - y / a;
  const Z = -X - Y;
  const e2 = X * Y - Z * Z;
  const e3 = X * Y * Z;
  return (1 - e2 / 10 + e3 / 14 + (e2 * e2) / 24 - (3 * e2 * e3) / 44) / Math.sqrt(a);
}

// Incomplete elliptic integral of the first kind F(phi | m).
function ellipF(phi, m) {
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  return s * carlsonRF(c * c, 1 - m * s * s, 1);
}

// sn and cn of u, parameter m (descending Landen / AGM, as Cephes ellpj).
const _a = new Float64Array(10);
const _c = new Float64Array(10);
function ellipSnCn(u, m) {
  if (m < 1e-12) return [Math.sin(u), Math.cos(u)];
  _a[0] = 1;
  _c[0] = Math.sqrt(m);
  let b = Math.sqrt(1 - m);
  let twon = 1;
  let i = 0;
  while (Math.abs(_c[i] / _a[i]) > 1e-15 && i < 9) {
    const ai = _a[i];
    i++;
    _c[i] = (ai - b) / 2;
    const t = Math.sqrt(ai * b);
    _a[i] = (ai + b) / 2;
    b = t;
    twon *= 2;
  }
  let phi = twon * _a[i] * u;
  for (; i > 0; i--) phi = (Math.asin((_c[i] * Math.sin(phi)) / _a[i]) + phi) / 2;
  return [Math.sin(phi), Math.cos(phi)];
}

class Pendulum {
  // t = 0 is a pass through the bottom, swinging toward +angle.
  constructor({ length = 2, amplitude = Math.PI / 4, g = G } = {}) {
    this.length = length;
    this.amplitude = amplitude;
    this.g = g;
    this.k = Math.sin(amplitude / 2);
    this.m = this.k * this.k;
    this.w0 = Math.sqrt(g / length);
    this.period = (4 * ellipK(this.m)) / this.w0;
  }

  angle(t) {
    return 2 * Math.asin(this.k * ellipSnCn(this.w0 * t, this.m)[0]);
  }

  angularVelocity(t) {
    return 2 * this.k * this.w0 * ellipSnCn(this.w0 * t, this.m)[1];
  }

  // Time after a bottom pass at which the bob first reaches |angle| (up to the amplitude: a quarter period).
  timeTo(angle) {
    const s = Math.min(1, Math.sin(Math.abs(angle) / 2) / this.k);
    return ellipF(Math.asin(s), this.m) / this.w0;
  }

  // Times in one period [0, T) at which the bob passes `angle`, sorted.
  passesInPeriod(angle) {
    const T = this.period;
    if (Math.abs(angle) < 1e-9) return [0, T / 2];
    const ts = this.timeTo(angle);
    return angle > 0 ? [ts, T / 2 - ts] : [T / 2 + ts, T - ts];
  }

  // Length whose swing of `amplitude` takes `period`.
  static lengthFor(period, amplitude, g = G) {
    const k = Math.sin(amplitude / 2);
    return g * (period / (4 * ellipK(k * k))) ** 2;
  }

  // Station angle where the two gaps between passes stand in the ratio short : long = p : q.
  stationForRatio(p, q) {
    const T = this.period;
    return this.angle(T * (0.25 - p / (2 * (p + q))));
  }
}

// The same pendulum `phase` seconds ahead: its angle at t is the pendulum's at t + phase (a pendulum swinging out of
// step with the main one, on the main one's clock).
function phased(pendulum, phase) {
  if (!phase) return pendulum;
  const T = pendulum.period;
  const p = Object.create(pendulum);
  p.phase = phase;
  p.angle = (t) => pendulum.angle(t + phase);
  p.angularVelocity = (t) => pendulum.angularVelocity(t + phase);
  p.passesInPeriod = (angle) => pendulum.passesInPeriod(angle).map((t) => (((t - phase) % T) + T) % T).sort((x, y) => x - y);
  return p;
}

export { Pendulum, phased };
