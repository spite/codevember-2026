// Knocking a gate: a jolt on top of a piece's scheduled motion that always dies away before the bob next comes near
// it, so the gate is back in line in time. The jolt is a quintic from the piece's offset and speed at the knock to an
// offset the piece's own cut pattern repeats under (a whole symmetry step for turning parts, zero for sliding ones),
// at rest, by the next time the arm comes within reach. The later the knock, the gentler the jolt.

const TAU = Math.PI * 2;

// Quintic from (a, b) to (d, 0) over h, with zero acceleration at both ends; value and speed at time s after the start.
function quintic(a, b, d, h, s) {
  const x = Math.min(1, Math.max(0, s / h));
  const x3 = x * x * x, x4 = x3 * x, x5 = x4 * x;
  const p0 = 1 - 10 * x3 + 15 * x4 - 6 * x5;
  const v0 = x - 6 * x3 + 8 * x4 - 3 * x5;
  const p1 = 10 * x3 - 15 * x4 + 6 * x5;
  const value = a * p0 + b * h * v0 + d * p1;
  const dp0 = (-30 * x * x + 60 * x3 - 30 * x4) / h;
  const dv0 = 1 - 18 * x * x + 32 * x3 - 15 * x4;
  const dp1 = (30 * x * x - 60 * x3 + 30 * x4) / h;
  const speed = x >= 1 ? 0 : a * dp0 + b * dv0 + d * dp1;
  return { value, speed };
}

class Knock {
  // `near(t)`: whether the arm is within reach of the piece at time t. `step`: offsets the piece's pattern repeats
  // under (0: none). `sign`: +1 or -1 if the piece may only be pushed one way (a shutter half that must not close).
  constructor({ near, step, sign = 0, period }) {
    this.near = near;
    this.step = step;
    this.sign = sign;
    this.period = period;
    this.base = 0;
    this.curve = null;
  }

  // Offset at time t.
  offset(t) {
    const c = this.curve;
    if (!c) return this.base;
    const { value } = quintic(c.a, c.b, c.d, c.h, t - c.t0);
    if (t >= c.t0 + c.h) {
      this.base = c.d;
      this.curve = null;
      return c.d;
    }
    return value;
  }

  // A jolt of `speed` (rad/s or m/s) at time t; false when the bob is too close for any.
  kick(t, speed) {
    if (this.near(t)) return false;
    // The jolt has to be over this long before the arm next comes near.
    let end = t;
    const limit = t + this.period;
    while (end < limit && !this.near(end)) end += 0.005;
    const h = end - t - 0.04;
    if (h < 0.12) return false;
    if (this.sign) speed = this.sign * Math.abs(speed);
    // Later knocks hit softer: the spin has to be undone in what time is left.
    const scale = Math.min(1, h / 0.9);
    const b0 = speed * scale;
    let a = this.base, b = 0;
    if (this.curve) {
      const c = this.curve;
      ({ value: a, speed: b } = quintic(c.a, c.b, c.d, c.h, t - c.t0));
    }
    b += b0;
    // Where it would coast to, rounded to an offset the pattern repeats under.
    const d = this.step > 0 ? Math.round((a + (b * h) / 2) / this.step) * this.step : 0;
    this.curve = { t0: t, a, b, d, h };
    return true;
  }
}

// The offsets a turning piece's pattern repeats under, from its values at every pass of a cycle: an even spacing
// of them, or a full turn.
function symmetryStep(values) {
  const angles = [...new Set(values.map((v) => Math.round((((v % TAU) + TAU) % TAU) * 1e3) % Math.round(TAU * 1e3)))].sort((a, b) => a - b);
  if (angles.length < 2) return TAU;
  const gap = (TAU * 1e3) / angles.length;
  const even = angles.every((a, i) => Math.abs(a - angles[0] - i * gap) < 4);
  return even ? TAU / angles.length : TAU;
}

export { Knock, symmetryStep };
