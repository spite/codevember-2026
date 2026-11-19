import { Vector3 } from "three";

// The sounds of a contraption's own motion, read off each gate's motion profile and scheduled a little ahead on the
// audio clock: ticks and clacks for clockwork steps, a slide and a latch for a dash that lands just in time, slides
// opening and a clack shutting for shutters, bars and irises, a swish each time the bob slips through a gate, a kiss
// when it docks in a socket, and the air rushing past the bobs.

const AHEAD = 0.12;
const _p = new Vector3();

class Foley {
  constructor(sound, camera) {
    this.sound = sound;
    this.camera = camera;
    this.until = null;
  }

  pan(position) {
    _p.copy(position).project(this.camera);
    return Math.max(-0.85, Math.min(0.85, _p.x * 0.8));
  }

  // Events of one piece's motion in [from, to): [time, name, options].
  pieceEvents(m, from, to, size) {
    const out = [];
    const rate = size > 6 ? 1.15 : size > 1 ? 1 : 0.9;
    const gain = 1 / Math.sqrt(Math.max(1, size));
    if (m.type === "indexed") {
      const T = m.period;
      for (let c = Math.floor((from - m.passes[0]) / T) - 1; c * T + m.passes[0] < to + T; c++) {
        const segments = [
          [m.passes[0] + c * T, m.passes[1] + c * T, m.steps[0]],
          [m.passes[1] + c * T, m.passes[0] + (c + 1) * T, m.steps[1]],
        ];
        for (const [ta, tb, steps] of segments) {
          if (!steps) continue;
          if (m.style === "tick") {
            const start = ta + m.hold + (m.delay ?? 0);
            out.push([start, "tick", { gain: 0.3 * gain, rate }], [start + m.move * 0.9, "clack", { gain: 0.22 * gain, rate: rate * 1.1 }]);
          } else {
            const end = tb - m.hold;
            out.push([end - m.move, "slide", { gain: 0.12 * gain, rate, duration: m.move }], [end - 0.01, "latch", { gain: 0.34 * gain, rate }]);
          }
        }
      }
    } else if (m.type === "wave") {
      // A long soft slide as it swings open for each pass.
      const T = m.period;
      const turning = (m.axis ?? "x") === "x";
      const next = m.passes.map((p, i) => (i + 1 < m.passes.length ? m.passes[i + 1] : m.passes[0] + T));
      for (let c = Math.floor(from / T) - 1; c * T < to + T; c++) {
        m.passes.forEach((p, i) => {
          const span = next[i] - p - 2 * m.hold;
          if (span >= 0.35) out.push([next[i] + c * T - m.hold - span / 2, turning ? "shift" : "slide", { gain: 0.07 * gain, rate, duration: span / 2 }]);
        });
      }
    } else if (m.type === "pulse") {
      const T = m.period;
      const turning = (m.axis ?? "x") === "x";
      for (let c = Math.floor(from / T) - 1; c * T < to + T; c++) {
        for (const p of m.passes) {
          const t = p + c * T;
          out.push([t - m.hold - m.rise, turning ? "shift" : "slide", { gain: (turning ? 0.16 : 0.12) * gain, rate, duration: m.rise }]);
          out.push([t + m.hold + m.rise, "clack", { gain: 0.24 * gain, rate }]);
        }
      }
    }
    return out.filter(([t]) => t >= from && t < to);
  }

  // t: pendulum time now; speed: pendulum seconds a real second.
  // slow(t): how slowed time is at pendulum time t (slow motion), 1 at normal pace: sounds play slowed and lowered by it.
  update(c, t, speed, slow = () => 1) {
    const { sound } = this;
    if (!c || speed <= 0) {
      this.until = null;
      sound.air(0, 0, 0);
      return;
    }
    if (this.until === null || this.until < t - 0.25 || this.until > t + 1) this.until = t;
    const from = this.until, to = t + AHEAD * speed;
    // Real seconds until pendulum time `time`, with the pace changing on the way.
    const base = speed / slow(t);
    const realDelay = (time) => {
      const n = 8, h = (time - t) / n;
      let d = 0;
      for (let i = 0; i < n; i++) d += h / (base * slow(t + (i + 0.5) * h));
      return d;
    };
    const play = (time, name, opts, where) => {
      const delay = realDelay(time);
      const pan = where ? this.pan(where) : 0;
      const a = Math.max(0.15, slow(time));
      if (name === "swish") sound.swish({ ...opts, pan, delay, pitch: (opts.pitch ?? 1) * a, duration: 0.16 / a });
      else sound.play(name, { ...opts, pan, delay, rate: (opts.rate ?? 1) * a, duration: opts.duration ? opts.duration / a : 0 });
    };
    const { pendulum } = c;
    for (const gate of c.gates) {
      const moving = gate.pieces.filter((p) => p.mesh && p.motion.type !== "static");
      const where = gate.group.position;
      // Linked pieces (an iris's blades) sound once.
      const seen = new Set();
      for (const p of moving) {
        if (p.link) {
          if (seen.has(p.link)) continue;
          seen.add(p.link);
        }
        for (const [time, name, opts] of this.pieceEvents(p.motion, from, to, moving.length)) play(time, name, opts, where);
      }
      // The bob slipping through.
      if (c.gimbal) {
        const T = c.gimbal.period;
        for (let k = Math.floor(from / T) - 1; k * T < to; k++) {
          const time = gate.pass + k * T;
          if (time < from || time >= to) continue;
          const v = c.gimbal.velocity(time);
          const w = Math.min(1, Math.hypot(v[0], v[1], v[2]) / 3.2);
          play(time, "swish", { gain: 0.25 + 0.5 * w, pitch: 0.8 + 0.5 * w }, where);
          // A rising gate slides up out of the floor, and thumps back down.
          if (gate.lift) {
            const { rise, hold } = gate.lift;
            play(time - hold - rise, "slide", { gain: 0.16, rate: 0.8, duration: rise }, where);
            play(time + hold + rise, "clack", { gain: 0.2, rate: 0.7 }, where);
          }
        }
        continue;
      }
      // A crossing pendulum's gates go by its own swing.
      const swing = gate.rig.pendulum ?? pendulum;
      for (let k = Math.floor(from / swing.period) - 1; k * swing.period < to; k++) {
        for (const tp of swing.passesInPeriod(gate.station)) {
          const time = tp + k * swing.period;
          if (time < from || time >= to) continue;
          const w = Math.abs(swing.angularVelocity(time)) / swing.w0 / (2 * swing.k);
          if (gate.kind === "socket") play(time - 0.05, "pop", { gain: 0.2, rate: 0.75 }, where);
          else play(time, "swish", { gain: 0.25 + 0.5 * w, pitch: 0.8 + 0.5 * w }, where);
        }
      }
    }
    this.until = to;
    // Air past the bobs, by how fast each moves.
    if (c.gimbal) {
      const v = c.gimbal.velocity(t);
      sound.air(0, (slow(t) * Math.hypot(v[0], v[1], v[2])) / 3.4, this.pan(c.bobPosition(t)));
      return;
    }
    const fastest = 2 * pendulum.k * pendulum.w0 / slow(t);
    sound.air(0, Math.abs(pendulum.angularVelocity(t)) / fastest, this.pan(c.bobPosition(t)));
    c.crossers.forEach((x, i) => sound.air(i + 1, (slow(t) * Math.abs(x.pendulum.angularVelocity(t + x.phase))) / (2 * x.pendulum.k * x.pendulum.w0), this.pan(x.arm.position), 0.6));
  }
}

export { Foley };
