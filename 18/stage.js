// Brings contraptions on and off, piece by piece. The gates fly up one at a time as soon as the pendulum's last swing
// has passed them, the pendulum is caught at the top of that swing and lifted out, and the base goes last. With the stage empty the look
// changes; then the new base comes down, its gates drop in one by one, each settling as it lands, and the pendulum is
// lowered in and let go from the top of its swing. A bob that rests in a socket at the top travels with that socket;
// inside the ring the pendulum can't be lifted out, so it goes with the ring, and the ring's gates slide out to the
// front, clear of it, before they fly.

import { Matrix4 } from "three";

const easeIn = (x) => x * x * x;
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Brought down from `h` over x in 0..1: a quick descent that brakes into place, then a centimetre's dip as it settles.
const LANDED = 0.82;
function land(x, h) {
  if (x < LANDED) return h * (1 - easeInOut(clamp01(x / LANDED)));
  const u = clamp01((x - LANDED) / (1 - LANDED));
  return -0.012 * Math.sin(Math.PI * u) * (1 - u);
}

// How much shadow a piece casts `h` metres off its place: all of it on the ground, none once well clear, so no shadow is
// left on the floor as it flies off (or appears before it comes down).
const shadowAt = (h) => 1 - clamp01((h - 0.1) / 1.3) ** 2 * (3 - 2 * clamp01((h - 0.1) / 1.3));

const _scale = new Matrix4();
// A piece casting less shadow is drawn shrunk toward its own origin in the shadow pass only (its shadow shrinks and
// pales into its penumbra), and not at all once it casts none.
function shade(object, f, shadowCamera) {
  object.traverse((m) => {
    if (!m.isMesh) return;
    if (!m.userData.shadeHooked) {
      m.userData.shadeHooked = true;
      m.userData.ownNoShadow = !!m.userData.noShadow;
      const saved = new Matrix4();
      let shrunk = false;
      m.onBeforeRender = (renderer, scene, camera) => {
        const k = m.userData.shadowScale ?? 1;
        if (k >= 1 || camera !== shadowCamera()) return;
        saved.copy(m.matrixWorld);
        m.matrixWorld.multiply(_scale.makeScale(k, k, k));
        shrunk = true;
      };
      m.onAfterRender = () => {
        if (shrunk) m.matrixWorld.copy(saved);
        shrunk = false;
      };
    }
    m.userData.shadowScale = f;
    m.userData.noShadow = m.userData.ownNoShadow || f <= 0.001;
  });
}

// Seconds for one gate to fly out or drop in, and the longest gap between two in the sweep.
const GATE = 0.85;
const STAGGER = 0.22;

class Stage {
  // shadowCamera(): the camera the shadow map is drawn with.
  constructor({ scene, onLook, onSettled, onArrive, onCue, shadowCamera = () => null }) {
    this.scene = scene;
    this.shadowCamera = shadowCamera;
    this.onLook = onLook;
    this.onSettled = onSettled;
    this.onArrive = onArrive;
    // onCue(name, gate or null): "off" as a piece lifts away, "land" as one comes down.
    this.onCue = onCue;
    this.state = "idle";
    this.current = null;
    this.time = 0;
  }

  // Shows a contraption at once, swinging from `time`.
  show(entry, time = 0) {
    this.current = entry;
    this.time = time;
    this.scene.add(entry.contraption.group);
    this.onLook(entry.look, entry.look, 1);
    this.state = "idle";
    this.pose(entry.contraption, { arm: 0, gate: () => [0, 0], base: 0 });
  }

  // Swaps straight to `entry`, no transition (for recordings and tests).
  replace(entry, time = 0) {
    if (this.current) {
      this.scene.remove(this.current.contraption.group);
      this.current.contraption.dispose();
    }
    this.pending = this.next = null;
    this.show(entry, time);
  }

  // Swaps in whatever `next` (a promise of { contraption, look }) resolves to.
  change(next) {
    // One built but not yet brought in is dropped for the newer one.
    this.next?.contraption.dispose();
    this.next = null;
    this.pending = next;
    next.then(
      (entry) => {
        if (this.pending === next) this.next = entry;
        else entry.contraption.dispose();
      },
      (error) => console.error("day 18: building a contraption failed", error),
    );
    if (this.state === "idle") {
      if (!this.current) return this.enter("empty");
      const c = this.current.contraption;
      const T = c.pendulum.period;
      // The next top of the swing, where the bob is at rest and clear of every gate; a gimbal's bob is never at rest,
      // so it is held at the next moment it is clear of them all.
      this.apex = c.gimbal || c.phased ? clearTime(c, this.time) : T / 4 + Math.ceil((this.time - T / 4) / (T / 2)) * (T / 2);
      this.planned = this.plan(c, this.apex, this.time);
      this.enter("leave");
    } else if (this.state === "arrive") {
      // Mid-arrival: let it land, then go again.
      this.queued = true;
    }
  }

  get busy() {
    return this.state !== "idle";
  }

  enter(state) {
    this.state = state;
    this.clock = 0;
    this.top = undefined;
  }

  // Offsets (metres): the pendulums raised by `arm`, gate i moved by gate(i) ([up, along z]), the base raised by `base`.
  pose(c, { arm, gate, base }) {
    const camera = this.shadowCamera;
    c.arm.position.set(c.pivot.x, c.pivot.y + arm, c.pivot.z);
    shade(c.arm, shadowAt(arm), camera);
    for (const x of c.crossers) {
      x.arm.position.set(x.pivot.x, x.pivot.y + arm, x.pivot.z);
      shade(x.arm, shadowAt(arm), camera);
    }
    c.gates.forEach((g, i) => {
      const e = g.frame.elements;
      const [dy, dz] = gate(i);
      g.group.position.set(e[12], e[13] + dy, e[14] + dz);
      shade(g.group, shadowAt(dy), camera);
    });
    c.base.position.y = base;
    shade(c.base, shadowAt(base), camera);
  }

  // How a contraption comes apart, worked out once per transition: the sweep's order (from the gate furthest from the
  // bob at `t` to the nearest), which socket (if any) holds the bob, and how far everything travels. Leaving from
  // `from`, also the soonest each gate may go (seconds after `from`): once the swing on its way to its top at `t` has
  // passed it for good, and for one the arm still hangs over (or on a gimbal, any), once the arm is lifted away.
  plan(c, t, from) {
    const enclosed = c.design.layout === "ring";
    const bob = c.bobPosition(t);
    const far = (g) => -Math.hypot(g.frame.elements[12] - bob.x, g.frame.elements[13] - bob.y, g.frame.elements[14] - bob.z);
    const angle = c.gimbal ? 0 : c.pendulum.angle(t);
    const docked = c.gates.findIndex((g) => g.kind === "socket" && Math.sign(g.station) === Math.sign(angle));
    const order = c.gates.map((g, i) => i).filter((i) => i !== docked).sort((a, b) => far(c.gates[a]) - far(c.gates[b]));
    const rank = new Array(c.gates.length).fill(0);
    order.forEach((g, r) => (rank[g] = r));
    const n = order.length;
    const free = c.gates.map((g) => {
      if (from === undefined) return 0;
      const lifted = t - from + 0.22;
      if (c.gimbal || c.phased) return lifted;
      const P = g.rig.pendulum ?? c.pendulum;
      const T = P.period;
      const w = Math.max(0.1, ...g.pieces.map((q) => q.motion.hold ?? 0)) + 0.12;
      let last = -Infinity;
      for (const tp of P.passesInPeriod(g.station)) {
        for (let k = Math.floor(from / T) - 1; k <= Math.ceil(t / T) + 1; k++) if (tp + k * T >= from && tp + k * T <= t) last = Math.max(last, tp + k * T);
      }
      const passed = last > -Infinity ? last + w - from : 0;
      return !enclosed && g.station * Math.sign(P.angle(t)) > 0.02 ? Math.max(passed, lifted) : passed;
    });
    return {
      enclosed,
      docked,
      rank,
      n,
      stagger: Math.min(STAGGER, 1.6 / Math.max(1, n - 1)),
      lift: Math.max(c.height, c.pivot.y) + 2,
      // Inside the ring a gate first slides out to the front, clear of the ring and the hub behind it.
      slide: enclosed ? c.baseDepth / 2 + 0.8 : 0,
      duration: enclosed ? GATE * 1.3 : GATE,
      free,
      sent: new Set(),
    };
  }

  // A gate's offset at progress u (0..1) of its flight out: straight up, or for the ring, out to the front, then up.
  flyOut(p, u) {
    if (!p.slide) return [p.lift * easeIn(u), 0];
    return [p.lift * easeIn(clamp01((u - 0.45) / 0.55)), p.slide * easeInOut(clamp01(u / 0.45))];
  }

  // The same on the way in, at progress x: dropped straight in, or down in front of the ring and slid into place.
  dropIn(p, x) {
    if (!p.slide) return [land(x, p.lift), 0];
    return [p.lift * (1 - easeInOut(clamp01(x / 0.5))), land(clamp01((x - 0.5) / 0.5), p.slide)];
  }

  cue(name, key, gate) {
    if (this.planned.sent.has(key)) return;
    this.planned.sent.add(key);
    this.onCue?.(name, gate);
  }

  // `pace` (1 by default) speeds the comings and goings up, for a recording: flights, the base and the drop-in.
  update(dt) {
    const pace = this.pace ?? 1;
    // The swing keeps its own time until it reaches the top; only what follows is sped up.
    const swinging = this.state === "idle" || (this.state === "leave" && this.time < this.apex);
    this.clock += swinging ? dt : dt * pace;
    const entry = this.current;
    const c = entry?.contraption;
    if (this.state === "idle") {
      // A gimbal, let go mid-swing, eases up to speed.
      this.ramp = Math.min(1, (this.ramp ?? 1) + dt / 0.9);
      this.time += dt * this.ramp * this.ramp * (3 - 2 * this.ramp);
      c?.update(this.time);
      return;
    }
    if (this.state === "leave") {
      this.time += dt;
      c.update(this.time);
      // The pendulum swings on to the top of its swing and is held there.
      c.holdArms(Math.min(this.time, this.apex));
      const p = this.planned;
      const t = this.clock;
      // When it reached the top, on the stage's clock (which runs faster from then on).
      if (this.time >= this.apex) this.top ??= this.apex - (this.time - t);
      const top = this.top ?? this.apex - (this.time - t);
      // Away quicker than they came: shorter flights, closer together, each as soon as the swing allows.
      const fly = p.duration * 0.6;
      const stagger = Math.min(0.09, 0.6 / Math.max(1, p.n - 1));
      const launch = p.free.map((f, i) => Math.max(f, (p.enclosed ? 0.1 : 0.25) + p.rank[i] * stagger));
      const baseAt = Math.max(top + (p.enclosed ? 0 : 0.25), ...launch.filter((x, i) => i !== p.docked).map((x) => x + fly * 0.5));
      const base = p.lift * easeIn(clamp01((t - baseAt) / 0.6));
      // The pendulum is whisked up the moment it reaches the top.
      const arm = p.enclosed ? base : p.lift * clamp01((t - top) / 0.45) ** 2;
      this.pose(c, {
        arm,
        base,
        gate: (i) => {
          if (i === p.docked) return [arm, 0];
          const u = clamp01((t - launch[i]) / fly);
          if (u > 0) this.cue("off", i, c.gates[i]);
          return this.flyOut(p, u);
        },
      });
      if (t > baseAt) this.cue("off", "base", null);
      if (t > baseAt + 0.65) {
        this.scene.remove(c.group);
        c.dispose();
        this.previousLook = entry.look;
        this.current = null;
        this.enter("empty");
      }
      return;
    }
    if (this.state === "empty") {
      const from = this.previousLook;
      if (this.next && from) this.onLook(from, this.next.look, easeOut(clamp01(this.clock / 0.6)));
      if (this.next && (!from || this.clock > 0.6)) {
        this.current = this.next;
        this.next = null;
        this.pending = null;
        if (!from) this.onLook(this.current.look, this.current.look, 1);
        const nc = this.current.contraption;
        const T = nc.pendulum.period;
        // Let go from the top of the swing; a gimbal's from the first moment after it that its bob is clear of the gates.
        this.letGo = nc.gimbal || nc.phased ? clearTime(nc, T / 4) : T / 4;
        this.planned = this.plan(nc, this.letGo);
        const p = this.planned;
        const lastLanded = 0.75 + (p.n - 1) * p.stagger + p.duration;
        this.lowerAt = p.enclosed ? Infinity : lastLanded - 0.25;
        this.release = p.enclosed ? lastLanded + 0.2 : this.lowerAt + 1.35;
        this.scene.add(nc.group);
        this.onArrive?.(nc);
        this.enter("arrive");
        this.update(0);
      }
      return;
    }
    if (this.state === "arrive") {
      const p = this.planned;
      const t = this.clock;
      // Gates run up to the moment of release, so everything is in step when the bob is let go.
      this.time = this.letGo - Math.max(0, this.release - t);
      c.update(this.time);
      c.holdArms(this.letGo);
      const xb = clamp01(t / 1.0);
      const base = land(xb, p.lift);
      if (xb >= LANDED) this.cue("land", "base", null);
      const arm = p.enclosed ? base : p.lift * (1 - easeOut(clamp01((t - this.lowerAt) / 1.2)));
      this.pose(c, {
        arm,
        base,
        gate: (i) => {
          if (i === p.docked) return [arm, 0];
          const x = clamp01((t - 0.75 - p.rank[i] * p.stagger) / p.duration);
          if (x >= LANDED) this.cue("land", i, c.gates[i]);
          return this.dropIn(p, x);
        },
      });
      if (t >= this.release) {
        this.time = this.letGo;
        this.ramp = c.gimbal || c.phased ? 0 : 1;
        this.enter("idle");
        this.onSettled?.();
        if (this.queued) {
          this.queued = false;
          if (this.pending) this.change(this.pending);
        }
      }
    }
  }
}

// The first moment from t at which a gimbal's bob (and the arm above it) is clear of every gate; for a contraption
// with a pendulum out of step, at which nothing swinging is near one.
function clearTime(c, t) {
  const T = c.pendulum.period;
  if (!c.gimbal) {
    for (let s = t; s < t + T; s += 0.01) if (c.clearAt(s)) return s;
    return t;
  }
  const windows = c.gates.map((g) => ({ at: g.pass ?? 0, w: Math.max(0.12, ...g.pieces.map((p) => p.motion.hold ?? 0)) + 0.15 }));
  const near = (s) => windows.some(({ at, w }) => Math.abs(((((s - at) % T) + 1.5 * T) % T) - T / 2) < w);
  for (let s = t; s < t + T; s += 0.01) if (!near(s)) return s;
  return t;
}

export { Stage };
