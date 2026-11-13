// Motion for open forms: a head moves through space leaving a trail, and the body is the last stretch of that trail,
// so it slides along its own path like a snake and the feathers ride it. What steers the head is pluggable: a curl
// field here; flocking or other fields can supply their own steer(head, dir, path) => desired direction.
import { Vector3, Quaternion } from "three";
import { createNoise } from "./noise.js";

const DS = 0.03;

// The head's trail: points DS apart, newest last.
class Path {
  constructor(capacity) {
    this.capacity = capacity;
    this.points = Array.from({ length: capacity }, () => new Vector3());
    this.count = 0;
  }
  push(p) {
    this.points[this.count % this.capacity].copy(p);
    this.count++;
  }
  // The k-th point back from the newest.
  back(k) {
    return this.points[(this.count - 1 - Math.min(k, this.count - 1)) % this.capacity];
  }
}

// A head turning no tighter than minRadius toward what steer asks, with its trail.
class Swimmer {
  constructor({ start, dir, steer, minRadius, capacity }) {
    this.head = start.clone();
    this.dir = dir.clone().normalize();
    this.steer = steer;
    this.minRadius = minRadius;
    this.path = new Path(capacity);
    this.path.push(this.head);
    // Distance travelled past the newest point.
    this.carry = 0;
  }
  step() {
    const want = this.steer(this.head, this.dir, this.path);
    const angle = this.dir.angleTo(want);
    if (angle > 1e-6) {
      _axis.crossVectors(this.dir, want);
      if (_axis.lengthSq() > 1e-12) this.dir.applyAxisAngle(_axis.normalize(), Math.min(angle, DS / this.minRadius)).normalize();
    }
    this.head.addScaledVector(this.dir, DS);
    this.path.push(this.head);
  }
  advance(distance) {
    this.carry += distance;
    while (this.carry >= DS) {
      this.step();
      this.carry -= DS;
    }
  }
  // The point s behind the head (along the trail, smoothly between steps).
  sample(s, out) {
    const x = s / DS + 1 - this.carry / DS;
    const k = Math.floor(x), f = x - k;
    // The newest point plus the bit travelled past it.
    if (x < 1) return out.copy(this.path.back(0)).addScaledVector(this.dir, this.carry - s);
    return out.lerpVectors(this.path.back(k - 1), this.path.back(k), f);
  }
}

// Steering through a curl-noise field (seeded by random), back toward the centre beyond half of bound, and away
// from the trail's older stretches (past skip points) closer than clear, so a tube around it never passes through
// itself.
function curlSteer(random, { frequency = 0.32, bound = 2.6, clear, skip, reach }) {
  const noise = [createNoise(random), createNoise(random), createNoise(random)];
  const e = 1e-3;
  const pot = (x, y, z, o) => o.set(noise[0](x, y, z), noise[1](x + 31.4, y - 12.7, z), noise[2](x - 17.1, y + 44.3, z));
  const want = new Vector3(), away = new Vector3();
  return (p, dir, path) => {
    const x = p.x * frequency, y = p.y * frequency, z = p.z * frequency;
    pot(x, y + e, z, _a1); pot(x, y - e, z, _a0);
    const dyz = _a1.z - _a0.z, dyx = _a1.x - _a0.x;
    pot(x, y, z + e, _a1); pot(x, y, z - e, _a0);
    const dzy = _a1.y - _a0.y, dzx = _a1.x - _a0.x;
    pot(x + e, y, z, _a1); pot(x - e, y, z, _a0);
    const dxz = _a1.z - _a0.z, dxy = _a1.y - _a0.y;
    want.set(dyz - dzy, dzx - dxz, dxy - dyx).normalize();
    const out = Math.max(0, (p.length() - 0.5 * bound) / (0.5 * bound));
    want.addScaledVector(p, (-3 * out * out) / Math.max(p.length(), 1e-4));
    const n = Math.min(path.count, reach);
    for (let k = skip; k < n; k += 2) {
      away.subVectors(p, path.back(k));
      const d = away.length();
      if (d < clear && d > 1e-4) want.addScaledVector(away, (40 * (1 - d / clear) ** 2) / d);
    }
    return want.normalize();
  };
}

// The body: the last `length` of a swimmer's trail, n segments, head at u = 0, as a centre line ({ P, T, N, B }).
// Its normal is carried from frame to frame at the head and transported down the body, so the coat doesn't roll.
class Spine {
  constructor(swimmer, length, n, taper = 0) {
    this.swimmer = swimmer;
    this.length = length;
    this.n = n;
    this.taper = taper;
    this.closed = false;
    this.P = Array.from({ length: n + 1 }, () => new Vector3());
    this.T = Array.from({ length: n + 1 }, () => new Vector3());
    this.N = Array.from({ length: n + 1 }, () => new Vector3());
    this.B = Array.from({ length: n + 1 }, () => new Vector3());
    this.headNormal = null;
    this.update();
  }
  update() {
    const { P, T, N, B, n } = this;
    for (let i = 0; i <= n; i++) this.swimmer.sample((i / n) * this.length, P[i]);
    // Along u, from the head toward the tail.
    for (let i = 0; i <= n; i++) T[i].subVectors(P[Math.min(i + 1, n)], P[Math.max(i - 1, 0)]).normalize();
    if (!this.headNormal) {
      this.headNormal = new Vector3(0, 1, 0).cross(T[0]);
      if (this.headNormal.lengthSq() < 1e-6) this.headNormal.set(1, 0, 0).cross(T[0]);
    }
    N[0].copy(this.headNormal).addScaledVector(T[0], -this.headNormal.dot(T[0])).normalize();
    this.headNormal.copy(N[0]);
    for (let i = 1; i <= n; i++) {
      N[i].copy(N[i - 1]).applyQuaternion(_q.setFromUnitVectors(T[i - 1], T[i]));
      N[i].addScaledVector(T[i], -N[i].dot(T[i])).normalize();
    }
    for (let i = 0; i <= n; i++) B[i].crossVectors(T[i], N[i]);
    return this;
  }
}

const _axis = new Vector3(), _a0 = new Vector3(), _a1 = new Vector3();
const _q = new Quaternion();

export { DS, Swimmer, Spine, curlSteer };
