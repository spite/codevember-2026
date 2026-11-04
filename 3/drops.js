import { DataTexture, RGBAFormat, FloatType, NearestFilter } from "three";

const GRAVITY = 40;
const DRAG = 0.4;
// Shape wobble after release: an underdamped spring on the lower and upper half-heights.
const WOBBLE_W = 38;
const WOBBLE_ZETA = 0.22;
// Most a falling drop stretches back along its velocity.
const STRETCH_MAX = 1.6;

// Falling drops in world space. Each substep moves them ballistically; one whose centre reaches the floor (or the
// puddle on it) splats into the puddle and frees its slot once it has sunk out of sight. A drop is two half-ellipsoids
// of radius r around its equator, sl·r deep ahead and su·r back along its velocity; it leaves the body with the bulb's
// own proportions and wobbles to a round front and a speed-stretched back, keeping its volume. dropTex holds 3 texels
// per row, (centre, r), (velocity, su) and (sl, 0, 0, 0), in 3 pose bands: now, last frame, and the shutter start.
export function createDrops({ lite = false, floorY, puddle = null }) {
  const MAXD = lite ? 24 : 64;
  const tex = new DataTexture(new Float32Array(3 * 3 * MAXD * 4), 3, 3 * MAXD, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const td = tex.image.data;

  const alive = new Uint8Array(MAXD);
  const x = new Float32Array(MAXD * 3);
  // Position at the start of the last substep: drops render one substep behind, like the pendants.
  const xs = new Float32Array(MAXD * 3);
  const v = new Float32Array(MAXD * 3);
  const r = new Float32Array(MAXD);
  // Volume, and the half-heights over r with their rates.
  const vol = new Float32Array(MAXD);
  const sl = new Float32Array(MAXD);
  const su = new Float32Array(MAXD);
  const slv = new Float32Array(MAXD);
  const suv = new Float32Array(MAXD);
  // Splatted into the puddle; it sinks on until it is out of sight, so a slow drop never pops.
  const sunk = new Uint8Array(MAXD);
  const stats = { live: 0, spawned: 0, splats: 0, dropped: 0 };
  const ledger = { volume: 0, splatted: 0 };
  let primed = true;

  // radius is the equator's; lower and upper the half-heights over it (a sphere by default).
  function spawn(from, to, vel, radius, lower = 1, upper = 1) {
    if (!(radius > 1e-4)) return -1;
    let i = alive.indexOf(0);
    if (i < 0) {
      stats.dropped++;
      return -1;
    }
    alive[i] = 1;
    sunk[i] = 0;
    for (let k = 0; k < 3; k++) {
      xs[i * 3 + k] = from[k];
      x[i * 3 + k] = to[k];
      v[i * 3 + k] = vel[k];
    }
    r[i] = radius;
    sl[i] = lower;
    su[i] = upper;
    slv[i] = suv[i] = 0;
    vol[i] = (2 / 3) * Math.PI * radius ** 3 * (lower + upper);
    stats.spawned++;
    return i;
  }

  function step(h) {
    const damp = Math.exp(-DRAG * h);
    const w2 = WOBBLE_W * WOBBLE_W, c = 2 * WOBBLE_ZETA * WOBBLE_W;
    let live = 0, total = 0;
    for (let i = 0; i < MAXD; i++) {
      if (!alive[i]) continue;
      const o = i * 3;
      v[o + 1] -= GRAVITY * h;
      for (let k = 0; k < 3; k++) {
        v[o + k] *= damp;
        xs[o + k] = x[o + k];
        x[o + k] += v[o + k] * h;
      }
      const back = Math.min(1 + 0.03 * Math.hypot(v[o], v[o + 1], v[o + 2]), STRETCH_MAX);
      slv[i] += (w2 * (1 - sl[i]) - c * slv[i]) * h;
      suv[i] += (w2 * (back - su[i]) - c * suv[i]) * h;
      sl[i] = Math.max(0.4, sl[i] + slv[i] * h);
      su[i] = Math.max(0.4, su[i] + suv[i] * h);
      r[i] = Math.cbrt((3 * vol[i]) / (2 * Math.PI * (sl[i] + su[i])));
      const ground = floorY + (puddle ? puddle.heightAt(x[o], x[o + 2]) : 0);
      if (!sunk[i] && x[o + 1] < ground) {
        const V = vol[i];
        puddle?.splat(x[o], x[o + 2], V, Math.cbrt(V / ((4 / 3) * Math.PI)));
        ledger.splatted += V;
        stats.splats++;
        sunk[i] = 1;
      }
      if (sunk[i] && x[o + 1] + r[i] < floorY) {
        alive[i] = 0;
        r[i] = 0;
        continue;
      }
      live++;
      if (!sunk[i]) total += vol[i];
    }
    stats.live = live;
    ledger.volume = total;
  }

  const put = (row, i, a, b, c, w) => {
    const q = (row * 3 + i) * 4;
    (td[q] = a), (td[q + 1] = b), (td[q + 2] = c), (td[q + 3] = w);
  };

  // Pose bands for the frame: t blends the last substep, dt is the frame time (0 while paused).
  function pack(t, dt, shutter) {
    let count = 0;
    const hs = primed ? 0 : 0.5 * shutter;
    for (let i = 0; i < MAXD; i++) {
      const o = i * 3;
      if (!alive[i]) {
        for (let band = 0; band < 3; band++) {
          put(band * MAXD + i, 0, 0, 0, 0, 0);
          put(band * MAXD + i, 1, 0, 0, 0, 1);
          put(band * MAXD + i, 2, 1, 0, 0, 0);
        }
        continue;
      }
      count = i + 1;
      const px = xs[o] + (x[o] - xs[o]) * t, py = xs[o + 1] + (x[o + 1] - xs[o + 1]) * t, pz = xs[o + 2] + (x[o + 2] - xs[o + 2]) * t;
      const vx = v[o], vy = v[o + 1], vz = v[o + 2];
      const s = su[i];
      put(i, 0, px, py, pz, r[i]);
      put(i, 1, vx, vy, vz, s);
      for (let band = 0; band < 3; band++) put(band * MAXD + i, 2, sl[i], 0, 0, 0);
      // A new drop's previous pose is back along its velocity, so it never streaks from the origin.
      const back = dt > 0 && !primed ? dt : 0;
      put(MAXD + i, 0, px - vx * back, py - vy * back, pz - vz * back, r[i]);
      put(MAXD + i, 1, vx, vy, vz, s);
      // Shutter offset capped at one radius, so the blur streak stays about a drop long.
      const k = hs * Math.min(1, r[i] / Math.max(hs * Math.hypot(vx, vy, vz), 1e-6));
      put(2 * MAXD + i, 0, px - vx * k, py - vy * k, pz - vz * k, r[i]);
      put(2 * MAXD + i, 1, vx, vy, vz, s);
    }
    primed = false;
    tex.needsUpdate = true;
    return count;
  }

  // Largest drops (world centre, world radius), for the occluders.
  function largest(out) {
    let n = 0;
    for (let i = 0; i < MAXD; i++) {
      if (!alive[i] || sunk[i]) continue;
      out.push(x[i * 3], x[i * 3 + 1], x[i * 3 + 2], r[i]);
      n++;
    }
    return n;
  }

  function reset() {
    alive.fill(0);
    r.fill(0);
    primed = true;
  }

  return {
    MAXD,
    tex,
    stats,
    ledger,
    spawn,
    step,
    pack,
    largest,
    reset,
    prime() {
      primed = true;
    },
    dispose: () => tex.dispose(),
  };
}
