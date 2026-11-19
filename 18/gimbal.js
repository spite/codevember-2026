import { Pendulum } from "./pendulum.js";
import { rotationZ, rotationX, rotationY, translation, multiply } from "./rigid.js";

// A pendulum on two hinges, one above the other: the upper arm swings about z through `a`, and the lower arm, hinged
// at its end about the upper arm's x, swings through `b`. Each swing is solved exactly as its own pendulum (the upper
// over the bob's whole distance from the pivot, the lower over its own arm) at a whole-number ratio of frequencies,
// so the bob draws a closed Lissajous loop. The bob sits on a swivel and always faces the way it is going, so every
// gate sees it end on. Three-free, for the cutting worker too.

const _a = new Float64Array(16);
const _b = new Float64Array(16);

class Gimbal {
  // ratio [p, q]: the upper and lower swings' frequencies stand p : q. `phase` shifts the lower swing (seconds).
  constructor({ kind, pivot, length, amplitudeA, amplitudeB, ratio, phase = 0 }) {
    this.pivot = pivot;
    if (kind === "foucault") return;
    this.length = length;
    this.ratio = ratio;
    this.phase = phase;
    this.a = new Pendulum({ length, amplitude: amplitudeA });
    const [p, q] = ratio;
    this.lower = Pendulum.lengthFor((this.a.period * p) / q, amplitudeB);
    this.b = new Pendulum({ length: this.lower, amplitude: amplitudeB });
    this.upper = length - this.lower;
    // The whole loop: p upper swings, q lower ones.
    this.period = this.a.period * p;
  }

  angles(t) {
    return [this.a.angle(t), this.b.angle(t + this.phase)];
  }

  upperMatrix(out, t) {
    return rotationZ(out, this.a.angle(t), this.pivot[0], this.pivot[1], this.pivot[2]);
  }

  // The lower arm's frame, at the hinge.
  lowerMatrix(out, t) {
    const [a, b] = this.angles(t);
    rotationZ(out, a, this.pivot[0], this.pivot[1], this.pivot[2]);
    multiply(out, out, translation(_a, 0, -this.upper, 0));
    return multiply(out, out, rotationX(_b, b));
  }

  bob(t) {
    const m = this.lowerMatrix(new Float64Array(16), t);
    return [m[12] - m[4] * this.lower, m[13] - m[5] * this.lower, m[14] - m[6] * this.lower];
  }

  velocity(t, h = 1e-4) {
    const p0 = this.bob(t - h), p1 = this.bob(t + h);
    return [(p1[0] - p0[0]) / (2 * h), (p1[1] - p0[1]) / (2 * h), (p1[2] - p0[2]) / (2 * h)];
  }

  // The swivel: the bob's turn about the lower arm that points its own X along its velocity.
  yaw(t) {
    const m = this.lowerMatrix(new Float64Array(16), t);
    const v = this.velocity(t);
    const x = v[0] * m[0] + v[1] * m[1] + v[2] * m[2];
    const z = v[0] * m[8] + v[1] * m[9] + v[2] * m[10];
    return Math.atan2(-z, x);
  }

  // The bob's frame: X along its path, Y up its arm, Z across.
  bobMatrix(out, t) {
    this.lowerMatrix(out, t);
    multiply(out, out, translation(_a, 0, -this.lower, 0));
    return multiply(out, out, rotationY(_b, this.yaw(t)));
  }
}

// A Foucault pendulum: one arm swinging in a plane that turns steadily round the upright, a whole turn every `swings`
// swings (an even number), so each swing ends at its own place on a circle and the bob draws a rosette. The same
// interface as the gimbal, with no upper arm and the bob facing along the plane.
class Foucault extends Gimbal {
  constructor(params) {
    super(params);
    const { length, amplitude, swings } = params;
    this.foucault = true;
    this.a = new Pendulum({ length, amplitude });
    this.swings = swings;
    this.upper = 0;
    this.lower = length;
    this.period = this.a.period * swings;
  }

  angles(t) {
    return [this.a.angle(t), 0];
  }

  // The swing plane's turn about the upright.
  precession(t) {
    return (2 * Math.PI * t) / this.period;
  }

  upperMatrix(out, t) {
    return this.lowerMatrix(out, t);
  }

  lowerMatrix(out, t) {
    rotationY(out, this.precession(t));
    multiply(out, out, rotationZ(_b, this.a.angle(t)));
    out[12] = this.pivot[0];
    out[13] = this.pivot[1];
    out[14] = this.pivot[2];
    return out;
  }

  yaw() {
    return 0;
  }
}

// The swinging path a design's params describe.
function swingPath(params) {
  return params.kind === "foucault" ? new Foucault(params) : new Gimbal(params);
}

export { Gimbal, Foucault, swingPath };
