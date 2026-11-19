import { Pendulum } from "./pendulum.js";
import { designCrossing, crossingAt } from "./crossing.js";
import { swingPath } from "./gimbal.js";
import { invertRigid } from "./rigid.js";
import { liftProgress, liftPose, liftFootY } from "./lift.js";

// A contraption as plain data, drawn from a random source: the swing, the bob, a hero mechanism, supporting gates
// along the arc, and sometimes sockets the bob docks in at the top of each swing.

const TAU = Math.PI * 2;

function pick(random, items, weights) {
  if (!weights) return items[Math.floor(random() * items.length)];
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
}

const range = (random, a, b) => a + (b - a) * random();

// The bob's lowest point over the floor, for layouts standing on it.
const LOWEST = 0.62;
const FLOOR = 0;

// A copy of the stream from here on, so both gates of a mirrored pair draw the same choices.
function fork(random) {
  let a = Math.floor(random() * 4294967296);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bobs are prisms of an outline (thin along the swing), with the rod into their top. `symmetry` is how many turns
// about the swing's direction map them onto themselves.
function designBob(random, want = "any") {
  const drawn = pick(random, ["star", "polygon", "cross", "gear", "flower", "key", "sphere", "suzanne"], [4, 3, 2, 2, 1, 2, 1.5, 1.5]);
  const kind = want === "any" ? drawn : want;
  const radius = range(random, 0.13, 0.16);
  const thickness = range(random, 0.06, 0.085);
  // Solid bobs, cut from their whole mesh: a ball, and Suzanne looking where she's going.
  if (kind === "sphere") return { kind, radius: 0.13, thickness: 0.26, symmetry: pick(random, [4, 6]), solid: "sphere" };
  if (kind === "suzanne") return { kind, radius: 0.155, thickness: 0.19, symmetry: 1, solid: "suzanne", scale: 0.112 };
  if (kind === "key") {
    // A literal key: its bow up (the rod goes in there), the bit at the bottom. The bow is solid, since a ring would
    // leave an island in every hole it cut.
    const r = 0.012;
    const add = [
      { type: "circle", c: [0, 0.088], r: 0.066 },
      { type: "roundRect", c: [0, 0.018], h: [0.03, 0.009], r: 0.004 },
      { type: "roundRect", c: [0, -0.07], h: [0.014, 0.1], r: 0.006 },
      { type: "roundRect", c: [0.03, -0.152], h: [0.022, 0.014], r },
      { type: "roundRect", c: [0.026, -0.118], h: [0.018, 0.011], r: r * 0.7 },
      { type: "roundRect", c: [0.032, -0.088], h: [0.024, 0.009], r: r * 0.6 },
    ];
    return { kind, radius: 0.17, thickness: 0.034, symmetry: 1, outline: { add } };
  }
  if (kind === "star") {
    const n = pick(random, [4, 5, 6, 8], [2, 4, 2, 1]);
    const inner = range(random, n > 5 ? 0.55 : 0.42, n > 5 ? 0.68 : 0.55);
    return { kind, radius, thickness, symmetry: n, outline: { add: [{ type: "star", r: radius, n, inner, round: radius * 0.09 }] } };
  }
  if (kind === "polygon") {
    const n = pick(random, [3, 4, 5, 6], [3, 2, 1, 1]);
    const r = n === 3 ? radius * 1.08 : radius;
    return { kind, radius: r, thickness, symmetry: n, outline: { add: [{ type: "polygon", r, n, vertexUp: n % 2 === 1 || n === 4, round: radius * 0.12 }] } };
  }
  if (kind === "cross") {
    const w = radius * range(random, 0.36, 0.48);
    const r = radius * 0.1;
    return {
      kind,
      radius,
      thickness,
      symmetry: 4,
      outline: { add: [{ type: "roundRect", h: [w, radius], r }, { type: "roundRect", h: [radius, w], r }] },
    };
  }
  if (kind === "gear") {
    const n = pick(random, [6, 8, 10, 12]);
    const body = radius * 0.78;
    const tooth = radius * 0.4 * Math.sin(Math.PI / n) * 2;
    const add = [{ type: "circle", r: body }];
    for (let k = 0; k < n; k++) add.push({ type: "roundRect", c: [0, body], h: [tooth / 2, radius - body], r: tooth * 0.2, rot: (k * TAU) / n });
    return { kind, radius, thickness, symmetry: n, outline: { add } };
  }
  const n = pick(random, [4, 5, 6]);
  const petal = radius * 0.42;
  const add = [{ type: "circle", r: radius * 0.45 }];
  for (let k = 0; k < n; k++) add.push({ type: "circle", c: [0, radius - petal], r: petal, rot: (k * TAU) / n });
  return { kind: "flower", radius, thickness, symmetry: n, outline: { add } };
}

// Stations where the gaps between passes stand p : q (short : long); a steady gate there turns (p + q) steps a period.
const RATIOS = [
  [3, 4],
  [2, 3],
  [3, 5],
  [1, 2],
  [2, 5],
  [1, 3],
  [1, 4],
  [1, 5],
  [1, 6],
  [1, 8],
  [1, 10],
  [1, 14],
];

function steady(pendulum, station, p, q, step, dir, axis = "x") {
  const T = pendulum.period;
  const rate = (dir * step * (p + q)) / T;
  const first = pendulum.passesInPeriod(station)[0];
  return { axis, type: "steady", rate, phase: -rate * first };
}

// Holds through each pass, moving `steps` (between the two passes of a period) in between: a tick right after the bob
// clears, or a burst that lands just before it comes.
function indexed(pendulum, station, step, steps, style, random, axis = "x", hold = 0.1) {
  const T = pendulum.period;
  const passes = pendulum.passesInPeriod(station);
  const gaps = passes.length === 1 ? [T] : [passes[1] - passes[0], passes[0] + T - passes[1]];
  // Too close to the top of the swing to move between its two passes there: hold through that gap.
  if (passes.length > 1 && gaps[0] < 2 * hold + 0.35) steps = [0, steps[0] + steps[1]];
  const room = Math.min(...gaps.map((g, i) => (steps[i] ? g : Infinity))) - 2 * hold - 0.08;
  const move = Math.max(0.12, Math.min(style === "tick" ? range(random, 0.22, 0.4) : range(random, 0.24, 0.42), room));
  return {
    axis,
    type: "indexed",
    style,
    passes,
    period: T,
    steps,
    step,
    hold,
    move,
    delay: style === "tick" ? range(random, 0, 0.12) : 0,
    drift: style === "burst" ? step * range(random, 0.08, 0.3) : 0,
    v0: 0,
  };
}

// How long either side of a pass a piece must hold still: while the arm is within `reach` (radians) of its station,
// plus a hair. Pieces lock into line that late, in the nick of time.
function lockTime(pendulum, station, reach) {
  let half = 0;
  for (const tp of pendulum.passesInPeriod(station)) {
    for (const dir of [-1, 1]) {
      let t = tp;
      while (Math.abs(pendulum.angle(t + dir * 0.002) - station) < reach && Math.abs(t - tp) < pendulum.period / 2) t += dir * 0.002;
      half = Math.max(half, Math.abs(t - tp));
    }
  }
  return half + 0.02;
}

// The arm's reach (radians) to a piece `half` thick along the path whose top is `top` over it.
const reachTo = (pendulum, bob, half, top) => (1.1 * (half + bob.thickness / 2 + 0.012)) / (pendulum.length - top);

// `open` through every pass, `closed` in between.
function pulse(pendulum, station, axis, closed, open, rise, hold = 0.1) {
  return { axis, type: "pulse", passes: pendulum.passesInPeriod(station), period: pendulum.period, hold, rise, closed, open };
}

// Every turning part makes a whole number of turns (for even bobs, half turns) a period, so the lot comes back
// round together: the grand alignment, every `loop` periods. `unit` is how many steps a period that takes.
function loopFor(n) {
  return n % 2 ? { loop: 1, unit: n } : { loop: 2, unit: n / 2 };
}

// A tunnel's discs: how far apart they stand along the path.
const TUMBLER_PITCH = 0.033;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const divisors = (n) => Array.from({ length: n }, (_, i) => i + 1).filter((d) => n % d === 0);

// The iris: five blades (see IrisGate), each turned this far about its pivot to shut, in a housing this many aperture
// radii across (every pose of the blades inside it).
const IRIS = { blades: 5, shut: (82 * Math.PI) / 180, housing: 2.42 };

// Physically, a turning part makes whole turns between passes: it then comes to every pass at the same angle, so
// its rod is cut a single slot and it stays one piece.
let physical = false;
let constant = false;

// Physically, a steady part held to whole turns between passes would spin too fast to read far from the bottom: it
// dashes round a turn before each pass instead (drawing nothing from the design's random sequence).
function wholeTurns(pendulum, station, dir, hold) {
  return indexed(pendulum, station, dir * TAU, [1, 1], "burst", () => 0.5, "x", hold);
}

// Steps for the two gaps of a period, adding up to a whole loop's worth: [k0, k1]; whole turns when physical.
function loopSteps(random, unit, i = Math.floor(random() * 3), n = unit) {
  if (physical) return [n, n];
  const total = unit <= 2 ? 2 * unit : unit;
  const k0 = 1 + (i % (total - 1));
  return [k0, total - k0];
}

// How far along the arc (metres) a gate reaches either side of its station.
function reach(g) {
  if (g.family === "torus") return g.major + g.tube + 0.05;
  const r = { keyhole: 0.1, shutter: 0.09, wall: 0.1, iris: 0.1, socket: 0.12 }[g.family];
  if (r) return r;
  if (g.family === "tumbler") return (g.count * TUMBLER_PITCH) / 2 + 0.05;
  return g.outer + 0.05;
}

// The torus round the path: its tube's radius, and the radius to the tube's centre, clearing a ball of `radius`.
function torusSize(radius) {
  const tube = 0.06 + 0.1 * radius;
  return { tube, major: radius + 0.05 + tube };
}

// The radius to the tube's centre at which a torus spinning at `rate` (face on at each pass of `station`) clears the bob
// going through along the path (a disc of its radius and thickness) and, if shared, the crosser's ball going through
// across the path at the quarter periods, by `gap` beyond the tube; opened up from the still torus's until it does.
function torusClear(pendulum, station, rate, bob, tube, shared, gap = 0.012) {
  const L = pendulum.length;
  const ring = Array.from({ length: 64 }, (_, i) => (i / 64) * TAU);
  const h = bob.thickness / 2;
  const least = (R) => {
    let d = Infinity;
    for (const tp of pendulum.passesInPeriod(station)) {
      for (let dt = -0.3; dt <= 0.3; dt += 0.003) {
        const x = L * (pendulum.angle(tp + dt) - station);
        if (Math.abs(x) > R + tube + h) continue;
        const sp = Math.sin(rate * dt), cp = Math.cos(rate * dt);
        for (const a of ring) {
          // The tube's centre line, turned from face on; its distance to the bob as a short cylinder along the path.
          const px = R * Math.cos(a) * sp, py = R * Math.sin(a), pz = R * Math.cos(a) * cp;
          d = Math.min(d, Math.hypot(Math.max(0, Math.hypot(py, pz) - bob.radius), Math.max(0, Math.abs(px - x) - h)));
        }
      }
    }
    if (shared) {
      const sp0 = shared.pendulum, Lc = sp0.length;
      for (const tp of sp0.passesInPeriod(0)) {
        for (let dt = -0.3; dt <= 0.3; dt += 0.003) {
          const ph = sp0.angle(tp + dt), z = Lc * Math.sin(ph), lift = Lc * (1 - Math.cos(ph));
          if (Math.abs(z) > R + tube + shared.radius) continue;
          const bx = lift * Math.sin(station), by = lift * Math.cos(station);
          // A quarter turn round from face on to the main path, and turning on.
          const sp = Math.sin(Math.PI / 2 + rate * dt), cp = Math.cos(Math.PI / 2 + rate * dt);
          for (const a of ring) {
            const px = R * Math.cos(a) * sp, py = R * Math.sin(a), pz = R * Math.cos(a) * cp;
            d = Math.min(d, Math.hypot(px - bx, py - by, pz - z) - shared.radius);
          }
        }
      }
    }
    return d - tube;
  };
  let R = Math.max(bob.radius, shared?.radius ?? 0) + 0.05 + tube;
  for (let i = 0; i < 10; i++) {
    const d = least(R);
    if (d >= gap) break;
    R += gap - d + 0.004;
  }
  return R;
}

function heroGate(random, pendulum, bob, family, station, side = 1, below = 0.27, shared = null) {
  const dir = (random() < 0.5 ? 1 : -1) * side;
  const style = pick(random, ["tick", "burst"], [1, 3]);
  if (family === "wall") {
    // From its top (0.4 over the path) down to just above whatever it stands on, so no bar slides out of the base.
    const count = Math.max(6, Math.min(Math.round(range(random, 9, 12)), Math.floor((0.4 + below - 0.03) / 0.064)));
    // The bars the bob goes through lock last, the ones further up and down a little before.
    const lock = lockTime(pendulum, station, reachTo(pendulum, bob, 0.04, 0.42));
    const mid = (count - 1) * 0.55;
    // Physically, a bar the bob splits slides no further than keeps both halves between the columns' plates.
    const most = physical ? Math.max(0.1, 0.4 - bob.radius) : 0.26;
    const motions = Array.from({ length: count }, (_, i) => {
      const raw = range(random, 0.08, 0.26);
      const offset = (i % 2 ? -1 : 1) * (physical ? 0.08 + ((raw - 0.08) * (most - 0.08)) / 0.18 : raw);
      return pulse(pendulum, station, "z", offset, 0, range(random, 0.14, 0.24), lock + 0.012 * Math.abs(i - mid));
    });
    return { family, station, motions };
  }
  if (family === "iris") {
    // A camera iris: shut between passes, its blades turning back into the ring as the bob comes.
    // Drawn as before (a blade count, an opening), so the rest of the design stays the same.
    pick(random, [6, 7, 8, 9]);
    if (random() >= 0.3) range(random, 0.4, 0.5);
    const rise = range(random, 0.16, 0.26);
    const Ra = bob.radius + 0.05;
    const outer = IRIS.housing * Ra + 0.02;
    const lock = lockTime(pendulum, station, reachTo(pendulum, bob, 0.05, outer));
    return { family, station, aperture: Ra, lean: dir, outer, motions: Array.from({ length: IRIS.blades }, () => pulse(pendulum, station, "x", -IRIS.shut * dir, 0, rise, lock)) };
  }
  if (family === "torus") {
    // A torus round the path, a slit at its top for the rod: like the rings it spins steadily on its upright axis, a
    // half turn between passes (or a whole one), and is face on each time the bob goes through. Shared with a pendulum
    // swinging across, a quarter period out of step, it spins at the single rate, which turns it face on to that one
    // in between. Its hole is opened up until, spinning, it clears the ball going through.
    const turns = shared ? shared.turns ?? 1 : pick(random, [1, 1, 2]);
    const { tube } = torusSize(bob.radius);
    const motion = steady(pendulum, station, 1, 1, Math.PI, dir * turns, "ry");
    const major = torusClear(pendulum, station, motion.rate, bob, tube, shared);
    return { family, station, motions: [motion], tube, major, through: shared ? [shared.crosser] : [] };
  }
  if (family === "rings") {
    const count = pick(random, [3, 4], [2, 1]);
    const centre = Math.abs(station) < 1e-6;
    const motions = Array.from({ length: count }, (_, k) => {
      // Each turns steadily at its own speed, neighbours opposite ways: the middle a half turn between passes, each
      // ring out one more, so they all come face on together as the bob comes through.
      const d = (k % 2 ? -1 : 1) * dir;
      const turns = count - k;
      // Drawn as before, so the rest of the design stays the same.
      if (!(centre && random() < 0.5)) indexed(pendulum, station, Math.PI, [1, 1], style, random, "ry");
      return steady(pendulum, station, 1, 1, Math.PI, d * turns, "ry");
    });
    // Two in three have a solid disc in the middle, the bob's outline cut through it. Read off what is already drawn,
    // so the rest of the design stays as it was.
    const solid = dir > 0 || count === 4;
    return { family, station, motions, outer: 0.44, solid };
  }
  if (family === "tunnel") {
    const count = Math.round(range(random, 8, 12));
    const step = TAU / bob.symmetry;
    const motions = Array.from({ length: count }, (_, i) => {
      const at = station + ((i - (count - 1) / 2) * TUMBLER_PITCH) / pendulum.length;
      const lock = lockTime(pendulum, at, reachTo(pendulum, bob, 0.015, 0.31));
      return indexed(pendulum, at, (i % 2 ? -1 : 1) * dir * step, loopSteps(random, loopFor(bob.symmetry).unit, i, bob.symmetry), "burst", random, "x", lock);
    });
    return { family: "tumbler", station, motions, count, hero: true, pitch: TUMBLER_PITCH };
  }
  // Turning k steps a pass: as few as keep it to whole loops.
  const { unit } = loopFor(bob.symmetry);
  const k = unit / gcd(unit, 2);
  if (physical) return { family: "keyhole", station, motion: steady(pendulum, station, 1, 1, TAU, dir) };
  return { family: "keyhole", station, motion: steady(pendulum, station, 1, 1, TAU / bob.symmetry, dir * k) };
}

function supportGate(random, pendulum, bob, family, s, dir, style, k) {
  const step = TAU / bob.symmetry;
  const { unit } = loopFor(bob.symmetry);
  if (family === "keyhole") {
    // Steady only where its (p + q) steps a period keep to whole loops.
    const motion =
      style === "steady" && (s.p + s.q) % unit === 0
        ? physical && s.p + s.q > 4
          ? wholeTurns(pendulum, s.angle, dir, lockTime(pendulum, s.angle, reachTo(pendulum, bob, 0.035, 0.36)))
          : steady(pendulum, s.angle, s.p, s.q, physical ? TAU : step, dir)
        : indexed(pendulum, s.angle, dir * step, loopSteps(random, unit, k, bob.symmetry), style === "steady" ? "burst" : style, random, "x", lockTime(pendulum, s.angle, reachTo(pendulum, bob, 0.035, 0.36)));
    return { family, station: s.angle, motion };
  }
  if (family === "shutter") {
    const open = random() < 0.5 ? 0.03 : bob.radius + 0.03;
    const rise = range(random, 0.12, 0.24);
    const lock = lockTime(pendulum, s.angle, reachTo(pendulum, bob, 0.035, 0.34));
    return { family, station: s.angle, motions: [-1, 1].map((z) => pulse(pendulum, s.angle, "z", 0, z * open, rise, lock)) };
  }
  const count = pick(random, [3, 4, 5]);
  const tStyle = style === "steady" ? "burst" : style;
  const motions = Array.from({ length: count }, (_, i) => {
    const at = s.angle + ((i - (count - 1) / 2) * TUMBLER_PITCH) / pendulum.length;
    return indexed(pendulum, at, (i % 2 ? -1 : 1) * dir * step, loopSteps(random, unit, i, bob.symmetry), tStyle, random, "x", lockTime(pendulum, at, reachTo(pendulum, bob, 0.015, 0.31)));
  });
  return { family: "tumbler", station: s.angle, motions, count, pitch: TUMBLER_PITCH };
}

function designGates(random, pendulum, bob, want = {}) {
  const L = pendulum.length;
  const A = pendulum.amplitude;
  const gates = [];
  const hero = want.hero && want.hero !== "any" ? want.hero : pick(random, ["wall", "iris", "rings", "tunnel", "torus"]);
  const sockets = random() < 0.55 && want.sockets !== false;

  // The hero at the bottom of the swing, or a mirrored pair of them part way up.
  let edge;
  if (random() < 0.72 || hero === "rings" || hero === "torus" || want.keepOut || want.shared) {
    const g = heroGate(random, pendulum, bob, hero, 0, 1, want.below, want.shared);
    gates.push(g);
    edge = reach(g) / L;
  } else {
    const pair = fork(random);
    const probe = heroGate(fork(random), pendulum, bob, hero, 0, 1, want.below);
    let angle = Math.max(reach(probe) / L + 0.04, A * range(random, 0.3, 0.45));
    // Turning steadily, a tunnel goes where its discs come round into line: the nearest such station further out.
    if (constant && hero === "tunnel") {
      const fit = RATIOS.map(([p, q]) => pendulum.stationForRatio(p, q)).filter((a) => a >= angle && fitsSteady(pendulum, a, TAU / bob.symmetry, loopFor(bob.symmetry).loop));
      if (fit.length) angle = Math.min(...fit);
    }
    const seed = Math.floor(pair() * 4294967296);
    for (const side of [1, -1]) {
      let a = seed;
      gates.push(heroGate(fork(() => (a++ % 4294967296) / 4294967296), pendulum, bob, hero, side * angle, side, want.below));
    }
    edge = angle + reach(gates[gates.length - 1]) / L;
  }

  // Sockets at the top of each swing.
  const limit = sockets ? A - (reach({ family: "socket" }) + 0.08) / L : A - 0.07;
  if (sockets) for (const side of [1, -1]) gates.push({ family: "socket", station: side * A, side });

  // Supporting gates in mirrored pairs between.
  const stations = RATIOS.map(([p, q]) => ({ p, q, angle: pendulum.stationForRatio(p, q) }));
  const pairs = pick(random, want.pairs ?? [1, 1, 2, 2, 3]);
  for (let k = 0; k < pairs; k++) {
    const family = pick(random, ["keyhole", "shutter", "tumbler"], [4, 2, 2]);
    const probe = { family, count: 5 };
    const need = edge + (reach(probe) + 0.05) / L;
    const clear = (s) => !want.keepOut || Math.abs(s.angle - want.keepOut.station) * L > reach(probe) + want.keepOut.radius + 0.06;
    const fits = (s) => family === "shutter" || fitsSteady(pendulum, s.angle, TAU / bob.symmetry, loopFor(bob.symmetry).loop);
    const free = stations.filter((s) => s.angle >= need && s.angle + reach(probe) / L <= limit && clear(s) && fits(s));
    if (!free.length) break;
    const s = free[Math.floor(random() * Math.min(free.length, 2))];
    const dir = random() < 0.5 ? 1 : -1;
    const style = pick(random, ["steady", "tick", "burst"], [2, 1, 4]);
    const steps = pick(random, [1, 1, 2]);
    const seed = random();
    for (const side of [1, -1]) gates.push(supportGate(fork(() => seed), pendulum, bob, family, { ...s, angle: side * s.angle }, dir * side, style, steps));
    edge = s.angle + reach(gates[gates.length - 1]) / L;
  }
  return { gates, hero };
}

const LAYOUTS = ["block", "rocker", "posts", "ring", "gimbal", "foucault"];

// A gimbal pendulum's gates, along the loop its bob draws. Each gate stands square to the path where the bob passes,
// on a post, and only where nothing else of the swing ever comes near it: not the bob or its lower rod at any other
// time, not the upper arm, and nothing near its post.
// A gate popping up from its slot for its pass: seconds to come up (and go down), and to stay up either side of the pass.
const LIFT = { rise: 0.45, hold: 0.14 };

// A gate's frame lying in its slot: flat (its face up, or down), along the swing or turned across it, its foot on the
// floor straight below where it is in place.
function slotFrame(U, face, turn, foot) {
  const z0 = [U[8], U[9], U[10]];
  const x = [0, face, 0];
  const y0 = [z0[1] * x[2] - z0[2] * x[1], z0[2] * x[0] - z0[0] * x[2], z0[0] * x[1] - z0[1] * x[0]];
  const c = Math.cos(turn), s = Math.sin(turn);
  // Turned about the upright.
  const rot = (v) => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
  const y = rot(y0), z = rot(z0);
  const fx = U[12] + U[4] * foot, fz = U[14] + U[6] * foot;
  const fy = FLOOR + 0.035;
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, fx - y[0] * foot, fy - y[1] * foot, fz - y[2] * foot, 1];
}

// The slot a gate lies in: the corners (x, z) of its plate, from `y0` to `y1` up it and `w` either side, lying in `D`.
function footprint(D, y0, y1, w) {
  return [[y0, -w], [y1, -w], [y1, w], [y0, w]].map(([y, z]) => [D[12] + D[4] * y + D[8] * z, D[14] + D[6] * y + D[10] * z]);
}

// Whether two convex outlines come within `gap` of each other (separating axes).
function overlaps(a, b, gap) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      const l = Math.hypot(x1 - x0, y1 - y0), nx = (y1 - y0) / l, ny = -(x1 - x0) / l;
      const span = (p) => p.map(([x, y]) => x * nx + y * ny);
      const pa = span(a), pb = span(b);
      if (Math.min(...pa) > Math.max(...pb) + gap || Math.min(...pb) > Math.max(...pa) + gap) return false;
    }
  }
  return true;
}

// A Foucault pendulum's swing: whole turns of its plane every `swings` swings (even, or the path retraces itself half
// way round), and its amplitude in degrees.
const FOUCAULT = [{ swings: 6, amp: 44 }, { swings: 8, amp: 44 }];

function designGimbal(random, want) {
  const foucault = !!want.foucault;
  const ratio = want.ratio ?? pick(random, [[1, 2], [2, 3]], [3, 2]);
  const length = 2.2;
  const rad = (d) => (d * Math.PI) / 180;
  // Wide enough that the loop's lobes keep clear of each other's gates.
  // A Foucault pendulum's plane turns a whole turn every six swings, or eight.
  const option = foucault ? FOUCAULT[random() < 0.5 ? 0 : 1] : null;
  const amplitudeA = foucault ? rad(option.amp + range(random, -1.5, 1.5)) : rad(ratio[1] === 2 ? range(random, 24, 30) : range(random, 36, 42));
  const amplitudeB = rad(ratio[1] === 2 ? range(random, 52, 62) : range(random, 46, 54));
  // A Foucault pendulum's plane turns a whole turn every few swings (six, or four), each swing ending at its own place
  // on a circle: as many places as fit a gate apiece.
  const swings = foucault ? option.swings : 0;
  const params = foucault
    ? { kind: "foucault", pivot: [0, LOWEST + length, 0], length, amplitude: amplitudeA, swings }
    : { pivot: [0, LOWEST + length, 0], length, amplitudeA, amplitudeB, ratio, phase: 0 };
  const gimbal = swingPath(params);
  const bob = designBob(random, want.bob);
  const below = bob.radius + 0.12;
  const T = gimbal.period;
  const dt = 0.004;
  const n = Math.ceil(T / dt);
  // The swing sampled over a loop: the bob, the lower hinge, and the pivot (fixed).
  const bobs = [], hinges = [];
  const m = new Float64Array(16);
  for (let i = 0; i < n; i++) {
    bobs.push(gimbal.bob(i * dt));
    gimbal.lowerMatrix(m, i * dt);
    hinges.push([m[12], m[13], m[14]]);
  }
  const P = params.pivot;
  const R = bob.radius + 0.03;

  // Does a box in a frame (|x| <= hx, z within hw, y from -depth to top) take in point p (padded by r)?
  const inBox = (inv, p, box, r) => {
    const x = inv[0] * p[0] + inv[4] * p[1] + inv[8] * p[2] + inv[12];
    const y = inv[1] * p[0] + inv[5] * p[1] + inv[9] * p[2] + inv[13];
    const z = inv[2] * p[0] + inv[6] * p[1] + inv[10] * p[2] + inv[14];
    return Math.abs(x) < box.hx + r && Math.abs(z) < box.hw + r && y > -box.depth - r && y < box.top + r;
  };
  const segBox = (inv, a, b, box, r) => {
    for (let k = 0; k <= 8; k++) {
      const f = k / 8;
      if (inBox(inv, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], box, r)) return true;
    }
    return false;
  };
  const segSeg = (a, b, c, d) => {
    let best = Infinity;
    for (let i = 0; i <= 12; i++) {
      const p = [a[0] + ((b[0] - a[0]) * i) / 12, a[1] + ((b[1] - a[1]) * i) / 12, a[2] + ((b[2] - a[2]) * i) / 12];
      const e = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      const t = Math.max(0, Math.min(1, ((p[0] - c[0]) * e[0] + (p[1] - c[1]) * e[1] + (p[2] - c[2]) * e[2]) / (e[0] ** 2 + e[1] ** 2 + e[2] ** 2)));
      best = Math.min(best, Math.hypot(p[0] - c[0] - e[0] * t, p[1] - c[1] - e[1] * t, p[2] - c[2] - e[2] * t));
    }
    return best;
  };

  // A gate standing where the bob is at time t: its frame, and whether it is clear of everything else, all loop.
  // Upright, and square to the path's heading where the bob is (it climbs and drops through at a slant).
  const uprightFrame = (t) => {
    // A Foucault pendulum's gates stand where its swings end, square to the swing there and leaning in with the arm, so
    // the bob comes in face on.
    if (foucault) return gimbal.bobMatrix(new Float64Array(16), t);
    const p = gimbal.bob(t);
    const v = gimbal.velocity(t);
    const lh = Math.hypot(v[0], v[2]);
    const x = [v[0] / lh, 0, v[2] / lh];
    return Float64Array.from([x[0], 0, x[2], 0, 0, 1, 0, 0, -x[2], 0, x[0], 0, p[0], p[1], p[2], 1]);
  };
  // `lift`: a gate that pops up from its slot only for its pass (see lift.js) is checked only while it is up or on its
  // way, in the pose it has at each moment.
  const placement = (t, box, lift = null, at = null) => {
    t = ((t % T) + T) % T;
    const frame = at ?? uprightFrame(t);
    const inv = invertRigid(new Float64Array(16), frame);
    const i0 = Math.round(t / dt) % n;
    // Times the bob or its lower rod reach the gate: one run, round its own pass.
    const touch = (i, m = inv) => inBox(m, bobs[i], box, R) || segBox(m, bobs[i], hinges[i], box, 0.02);
    let a = i0, b = i0;
    while (touch((a - 1 + n) % n) && i0 - a < n / 2) a--;
    while (touch((b + 1) % n) && b - i0 < n / 2) b++;
    if (lift) {
      // `lift(frame)` makes the lift for a gate standing in `frame`.
      const l = lift(frame);
      const m = new Float64Array(16), mi = new Float64Array(16);
      const span = Math.ceil((l.rise + l.hold) / dt);
      const fx = frame[12] + frame[4] * l.foot, fz = frame[14] + frame[6] * l.foot;
      for (let k = i0 - span; k <= i0 + span; k++) {
        const x = liftProgress(l, Math.abs(k - i0) * dt);
        if (x >= 1) continue;
        const i = ((k % n) + n) % n;
        // Its column, from the floor up to its foot, clear of the bob and its rod all the while.
        if (segSeg(bobs[i], hinges[i], [fx, FLOOR, fz], [fx, liftFootY(l, x), fz]) < R + 0.05) return null;
        if (k >= a && k <= b) continue;
        if (touch(i, invertRigid(mi, liftPose(m, l, x)))) return null;
      }
      return { frame, window: ((b - a) * dt) / 2 + 0.02, centre: [frame[12], frame[13], frame[14]], lift: l };
    }
    for (let k = b + 1; k < a + n; k++) if (touch(k % n)) return null;
    // The upper arm never.
    for (let i = 0; i < n; i += 3) if (segBox(inv, P, hinges[i], box, 0.03)) return null;
    // Its post: straight down from under it, clear of the bob and its lower rod.
    const foot = [frame[12] - frame[4] * box.depth, frame[13] - frame[5] * box.depth, frame[14] - frame[6] * box.depth];
    const floor = [foot[0], FLOOR, foot[2]];
    for (let i = 0; i < n; i += 2) if (segSeg(bobs[i], hinges[i], foot, floor) < R + 0.08) return null;
    return { frame, window: ((b - a) * dt) / 2 + 0.02, centre: [frame[12], frame[13], frame[14]] };
  };

  const step = TAU / bob.symmetry;
  const dir = () => (random() < 0.5 ? 1 : -1);
  // Boxes reach down past the pedestal each gate stands on.
  const keyBox = { hx: 0.07, hw: 0.33, depth: below + 0.22, top: 0.37 };
  const gates = [];
  const taken = [];
  const slotted = [];
  const free = (c, gap) => taken.every((q) => Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]) > gap);
  // Candidate times round the loop, in a seeded order.
  const order = Array.from({ length: Math.floor(T / 0.025) }, (_, i) => i * 0.025 + 0.01).sort(() => random() - 0.5);
  if (foucault) {
    // A gate for each swing, on one of its lobe's long sides, somewhere part way out: it rises from the floor just in
    // time for the bob to go through, and sinks again before the next one comes up, so only one is ever up.
    const T0 = gimbal.a.period;
    const gap = 2 * (LIFT.rise + LIFT.hold) + 0.05;
    let last = -Infinity;
    for (let k = 0; k < 2 * swings; k++) {
      const ts = gimbal.a.timeTo(Math.asin(range(random, 0.45, 0.85) * Math.sin(amplitudeA)));
      const first = random() < 0.5;
      for (const out of [first, !first]) {
        const t = (k * T0) / 2 + (out ? ts : T0 / 2 - ts);
        if (t - last < gap || (gates.length && t + gap > T + gates[0].pass)) continue;
        if (tryLifted(t)) {
          last = t;
          break;
        }
      }
    }
    const loop = [];
    for (let i = 0; i < n; i += 2) loop.push(bobs[i][0], bobs[i][2]);
    return constantly(want, { layout: "gimbal", foucault: true, gimbal: params, length, amplitude: amplitudeA, bob, gates, hero: "keyhole", below, crossing: null, loop: 1, path: loop });
  }
  const hero = want.hero === "tunnel" || (want.hero !== "iris" && random() < 0.5) ? "tunnel" : "iris";

  // The hero first: an iris, or a straight stack of thin discs square to the path. An iris that finds no room anywhere on the
  // loop gives way to the discs.
  let placed = false;
  for (const kind of hero === "iris" ? ["iris", "tunnel"] : ["tunnel"]) {
    for (const t of order) {
      if (kind === "iris") {
        const Ra = bob.radius + 0.05;
        const Rh = IRIS.housing * Ra + 0.02;
        const p = placement(t, { hx: 0.07, hw: Rh, depth: below + 0.22, top: Rh });
        if (!p) continue;
        range(random, 0.4, 0.5);
        const rises = Array.from({ length: pick(random, [6, 7, 8]) }, () => range(random, 0.16, 0.26));
        // The blades move together, as the one actuator ring turns them all.
        const motions = Array.from({ length: IRIS.blades }, () => ({ axis: "x", type: "pulse", passes: [t], period: T, hold: p.window, rise: rises[0], closed: -IRIS.shut, open: 0 }));
        gates.push({ family: "iris", frame: [...p.frame], pass: t, aperture: Ra, lean: 1, outer: Rh, motions, post: { thickness: 0.12, width: 0.24 } });
        taken.push(p.centre);
        placed = true;
        break;
      }
      // Discs a little apart along the path: each its own gate, all clear.
      const count = pick(random, [5, 6, 7, 8]);
      const v = gimbal.velocity(t);
      const gap = 0.034 / Math.hypot(v[0], v[1], v[2]);
      const run = [];
      // One straight stack, square to the path at its middle disc: each disc along that axis, passed in turn.
      const mid = uprightFrame(t);
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * 0.034;
        const ti = (((t + (i - (count - 1) / 2) * gap) % T) + T) % T;
        const at = Float64Array.from(mid);
        for (let k = 0; k < 3; k++) at[12 + k] += mid[k] * off;
        const p = placement(ti, { hx: 0.03, hw: 0.32, depth: below + 0.22, top: 0.32 }, null, at);
        if (!p) break;
        run.push({ t: ti, p });
      }
      if (run.length < count) continue;
      const d = dir();
      for (const [i, { t: ti, p }] of run.entries()) {
        const motion = indexed({ passesInPeriod: () => [ti], period: T }, ti, (i % 2 ? -1 : 1) * d * step, [bob.symmetry], "burst", random, "x", p.window);
        // The middle disc carries the run's one pedestal, long enough to take them all.
        const post = i === run.length >> 1 ? { thickness: run.length * 0.034 + 0.03, width: 0.26 } : null;
        gates.push({ family: "tumbler", frame: [...p.frame], pass: ti, motions: [motion], count: 1, post });
        taken.push(p.centre);
      }
      placed = true;
      break;
    }
    if (placed) break;
  }
  // Keyholes and shutters evenly round the rest of the loop, like a slalom: each tries the times nearest its slot.
  const supports = pick(random, [6, 7, 8, 9]);
  const start = random() * T;
  const slots = Array.from({ length: supports }, (_, k) => start + (k * T) / supports);
  const near = (slot) => Array.from({ length: 13 }, (_, j) => slot + (((j + 1) >> 1) * (j % 2 ? 1 : -1) * T) / (supports * 14));
  for (const t of slots.flatMap((slot) => [near(slot)]).map((ts) => ts.map((x) => ((x % T) + T) % T))) {
    let placed = false;
    for (const tt of t) {
      if (placed) break;
      placed = trySupport(tt);
    }
  }
  // A gate that pops up from its slot in the plinth for its pass: a keyhole, a pair of shutters or an iris. Down, it lies
  // flat in the slot, face up or face down, along the swing or across it; whichever way keeps its slot clear of the
  // others'.
  function tryLifted(t) {
    const family = pick(random, ["keyhole", "shutter", "iris"], [3, 2, 1.4]);
    const depth = below + 0.22;
    const post = { thickness: 0.06, width: 0.24 };
    let box, width, make;
    if (family === "keyhole") {
      const size = { discRadius: bob.radius + 0.045, halfWidth: bob.radius + 0.08, above: 0.045 };
      box = { ...keyBox, hw: size.halfWidth, top: size.discRadius + size.above };
      width = size.halfWidth;
      const d = dir();
      make = (p) => ({ family, size, post: { ...post, width: 2 * size.halfWidth - 0.06 }, motion: indexed({ passesInPeriod: () => [t], period: T }, t, d * step, [bob.symmetry], "burst", random, "x", p.window) });
    } else if (family === "shutter") {
      const open = random() < 0.5 ? 0.03 : bob.radius + 0.03;
      const rise = range(random, 0.12, 0.22);
      box = { ...keyBox, hw: 0.31 + open };
      width = 0.31;
      make = (p) => ({ family, post, motions: [-1, 1].map((z) => ({ axis: "z", type: "pulse", passes: [t], period: T, hold: p.window, rise, closed: 0, open: z * open })) });
    } else {
      const Ra = bob.radius + 0.05;
      const Rh = IRIS.housing * Ra + 0.02;
      const rise = range(random, 0.16, 0.26);
      box = { hx: 0.07, hw: Rh, depth, top: Rh };
      width = Rh;
      make = (p) => ({ family, aperture: Ra, lean: 1, outer: Rh, post, motions: Array.from({ length: IRIS.blades }, () => ({ axis: "x", type: "pulse", passes: [t], period: T, hold: p.window, rise, closed: -IRIS.shut, open: 0 })) });
    }
    // Its foot: the bottom of its pedestal, on top of its column (as the contraption builds it).
    const foot = -(below + 0.15);
    const ways = [[1, 0], [-1, 0], [1, Math.PI / 2], [-1, Math.PI / 2]].sort(() => random() - 0.5);
    for (const [face, turn] of ways) {
      const lift = (U) => ({ ...LIFT, up: [...U], down: slotFrame(U, face, turn, foot), foot });
      const p = placement(t, box, lift);
      if (!p) continue;
      const slot = footprint(p.lift.down, foot - 0.08, box.top + 0.012, width + 0.012);
      if (slotted.some((q) => overlaps(q, slot, 0.03))) continue;
      slotted.push(slot);
      gates.push({ ...make(p), frame: [...p.frame], pass: t, lift: { ...p.lift, slot } });
      return true;
    }
    return false;
  }
  function trySupport(t, only) {
    const family = only ?? pick(random, ["keyhole", "shutter"], [3, 1]);
    const open = random() < 0.5 ? 0.03 : bob.radius + 0.03;
    // A Foucault pendulum's keyholes are cut down to the bob, so the swings either side of one keep clear of it.
    const size = foucault ? { discRadius: bob.radius + 0.045, halfWidth: bob.radius + 0.08, above: 0.045 } : null;
    const box = family === "shutter" ? { ...keyBox, hw: 0.31 + open } : size ? { ...keyBox, hw: size.halfWidth, top: size.discRadius + size.above } : keyBox;
    const p = placement(t, box);
    if (!p || !free(p.centre, size ? 2 * size.halfWidth + 0.05 : 0.62)) return false;
    if (family === "shutter") {
      const rise = range(random, 0.12, 0.22);
      gates.push({ family, frame: [...p.frame], pass: t, motions: [-1, 1].map((z) => ({ axis: "z", type: "pulse", passes: [t], period: T, hold: p.window, rise, closed: 0, open: z * open })), post: { thickness: 0.12, width: 0.24 } });
    } else if (!foucault && random() < 0.4) {
      // A whole turn (or two) a loop, steadily, round to line up as the bob comes.
      const rate = (dir() * TAU * pick(random, [1, 1, 2])) / T;
      gates.push({ family, frame: [...p.frame], pass: t, motion: { axis: "x", type: "steady", rate, phase: -rate * t }, post: { thickness: 0.12, width: 0.24 } });
    } else {
      const motion = indexed({ passesInPeriod: () => [t], period: T }, t, dir() * step, [bob.symmetry], "burst", random, "x", p.window);
      gates.push({ family, frame: [...p.frame], pass: t, motion, post: { thickness: 0.12, width: size ? 2 * size.halfWidth - 0.06 : 0.24 }, ...(size && { size }) });
    }
    taken.push(p.centre);
    return true;
  }
  // The loop itself, for the line drawn on the plinth.
  const loop = [];
  for (let i = 0; i < n; i += 4) loop.push(bobs[i][0], bobs[i][2]);
  // Too crowded a loop for a few gates: the figure eight instead.
  if (gates.length < 3 && ratio[1] !== 2) return designGimbal(random, { ...want, ratio: [1, 2] });
  return constantly(want, { layout: "gimbal", gimbal: params, length, amplitude: amplitudeA, bob, gates, hero, below, crossing: null, loop: 1, path: loop });
}

function designContraption(random, want = {}) {
  physical = !!want.physical;
  constant = want.motion === "constant";
  const layout = want.layout && want.layout !== "any" ? want.layout : pick(random, LAYOUTS.slice(0, 5), [3, 3, 1, 2, 2.5]);
  // The Foucault pendulum only when asked for: never drawn at random.
  if (layout === "gimbal" || layout === "foucault") return designGimbal(random, { ...want, foucault: layout === "foucault" });
  const ring = layout === "ring";
  // The ring swings a shorter pendulum most of the way round, slowing to a crawl near the top.
  const length = ring ? range(random, 1.25, 1.45) : 2;
  const amplitude = ((ring ? range(random, 115, 150) : range(random, 40, 55)) * Math.PI) / 180;
  const pendulum = new Pendulum({ length, amplitude });
  const bob = designBob(random, want.bob);
  // Sometimes a pair of pendulums swinging across the main one, just missing its bob either side of the bottom.
  let crossing = null;
  if (!ring && (want.crossing ?? random() < 0.45)) crossing = designCrossing(random, pendulum, bob, { pivot: [0, LOWEST + length, 0], swing: [24, 34] });
  const hero = want.hero && want.hero !== "any" ? want.hero : pick(random, ["wall", "iris", "rings", "tunnel", "torus"]);
  // With the torus, a pendulum swinging across shares it instead: one, its bottom at the bottom of the main swing, a
  // quarter period out of step, so it goes through the torus while the main bob is at the top of its swing.
  let shared = null;
  if (crossing && hero === "torus") {
    const c0 = crossing.crossers[0];
    const phase = pendulum.period / 4;
    if (random() < 0.5) {
      crossing = { station: 0, shared: true, crossers: [{ x: 0, side: c0.side, pivot: [0, LOWEST + c0.length, 0], length: c0.length, amplitude: c0.amplitude, radius: c0.radius, phase }] };
      shared = { pendulum: new Pendulum({ length: c0.length, amplitude: c0.amplitude }), radius: c0.radius, crosser: 0 };
    } else {
      // Or both crossers, each through a torus of its own where it crosses the main path, an eighth of a period after
      // the main bob's bottom: spinning at the double rate, each is face on to the main bob as it passes and a quarter
      // turn round, face on to its crosser, as that one passes, at the main swing's bottom.
      crossing = crossingAt(pendulum, bob, crossing, pendulum.angle(pendulum.period / 8), { pivot: [0, LOWEST + length, 0] });
      if (crossing) crossing.tori = true;
    }
  }
  // The crossers' tori, sized to clear both balls going through.
  let tori = [];
  if (crossing?.tori) {
    const c0 = crossing.crossers[0];
    const cp = new Pendulum({ length: c0.length, amplitude: c0.amplitude });
    const { tube } = torusSize(Math.max(bob.radius, c0.radius));
    tori = crossing.crossers.map((c, i) => {
      const station = (i ? -1 : 1) * crossing.station;
      const motion = steady(pendulum, station, 1, 1, Math.PI, (random() < 0.5 ? 2 : -2));
      motion.axis = "ry";
      const major = torusClear(pendulum, station, motion.rate, bob, tube, { pendulum: cp, radius: c0.radius });
      return { family: "torus", station, motions: [motion], tube, major, through: [i] };
    });
  }
  const torusReach = tori.length ? tori[0].major + tori[0].tube : crossing?.crossers[0].radius;
  // The hero has to fit between the crossers.
  if (crossing && !shared && heroReach(hero) + torusReach + 0.06 > crossing.station * length) [crossing, tori] = [null, []];
  const keepOut = crossing && !shared && { station: crossing.station, radius: torusReach };
  // The rings and the torus turn edge-on through a sphere their size, so the base drops away under them.
  const torus = torusSize(Math.max(bob.radius, shared?.radius ?? 0, tori.length ? crossing.crossers[0].radius : 0));
  const below = hero === "rings" ? 0.5 : hero === "torus" ? torus.major + torus.tube + 0.15 : bob.radius + 0.12;
  const loop = loopFor(bob.symmetry).loop;
  if (crossing && !shared) for (const c of crossing.crossers) c.gates = crosserGates(random, c, loop);
  const { gates } = designGates(random, pendulum, bob, {
    ...want,
    hero,
    keepOut,
    shared,
    below,
    sockets: layout === "block" ? false : undefined,
    pairs: ring ? [2, 3, 3, 4] : undefined,
  });
  // The torus stands on the base by its lowest point, spinning on it like a coin on a table: the base comes up to just
  // under it, and no further.
  // All the tori the same size, so they all stand on it.
  gates.push(...tori);
  const all = gates.filter((g) => g.family === "torus");
  const size = all.reduce((m, g) => (g.major > m.major ? g : m), all[0] ?? {});
  for (const g of all) [g.major, g.tube] = [size.major, size.tube];
  const under = all.length ? size.major + size.tube - 0.002 : below;
  return constantly(want, { layout, length, amplitude, bob, gates, hero, below: under, crossing, loop });
}

// Constant motion (want.motion "constant"): every piece keeps moving instead of waiting and snapping into line. A
// turning part turns at one steady rate, like the rings and the torus, at whatever whole number of steps a period
// (kept to whole loops, so the grand alignment holds) brings it round most nearly into line at both passes; what is
// left over is shared between the two. An opening part swings smoothly shut and back between passes. Made from the
// quick design, so a seed builds the same contraption either way.
function constantly(want, design) {
  if (want.motion !== "constant") return design;
  // A Foucault pendulum's gates are up only about a second each: a keyhole spins steadily all the while, landing in line
  // as the bob goes through, and shutters and irises keep their quick opening, which is all that shows.
  if (design.foucault) {
    for (const g of design.gates) {
      if (g.motion?.type !== "indexed") continue;
      const { passes, step } = g.motion;
      const rate = Math.sign(step) * TAU * (0.3 + 0.2 * ((passes[0] * 7.3) % 1));
      g.motion = { axis: "x", type: "steady", rate, phase: -rate * passes[0] };
    }
    return design;
  }
  const main = design.layout === "gimbal" ? null : new Pendulum({ length: design.length, amplitude: design.amplitude });
  const sigma = TAU / (physical ? 1 : design.bob.symmetry);
  // A gate's turning parts all turn at one rate (a tunnel's discs together), each its own way.
  const turnAll = (g, motions, pendulum, step) => {
    if (g.family === "tumbler" && !physical && pendulum) return motions.map((m, i) => slitted(g, m, i, pendulum));
    const turning = motions.map((m) => (m.axis ?? "x") === "x" && pendulum && ["indexed", "steady", "glide"].includes(m.type));
    const passes = motions.map((m, i) => (turning[i] ? m.passes ?? pendulum.passesInPeriod(g.station) : null));
    const two = passes.filter((p) => p && p.length > 1);
    const size = physical ? TAU : step;
    const n = two.length ? steadySteps(two, pendulum.period, size, design.loop) : 0;
    return motions.map((m, i) => (turning[i] && passes[i].length > 1 ? steadyMotion(passes[i], pendulum.period, size, n, Math.sign(m.step ?? m.rate) || 1, m.v0 ?? 0) : constantMotion(m)));
  };
  // A tunnel's discs each take a number of slits for the rod (a divisor of the bob's symmetry, so its hole still fits):
  // a disc lines up again every slit, so each turns at its own speed, the fewer slits the faster. Read off each disc's
  // distance from the middle, so the tunnel is symmetric and no random draw moves.
  const counts = divisors(design.bob.symmetry).reverse();
  const slitted = (g, m, i, pendulum) => {
    const passes = m.passes ?? pendulum.passesInPeriod(g.station);
    if (passes.length < 2) return constantMotion(m);
    const k = counts[Math.round(Math.abs(i - (g.count - 1) / 2)) % counts.length];
    const step = TAU / k;
    const n = steadySteps([passes], pendulum.period, step, design.loop, 0.3, k);
    return steadyMotion(passes, pendulum.period, step, n, Math.sign(m.step) || 1, m.v0 ?? 0);
  };
  const each = (g, pendulum, step) => {
    if (g.motion) [g.motion] = turnAll(g, [g.motion], pendulum, step);
    if (g.motions) g.motions = turnAll(g, g.motions, pendulum, step);
  };
  for (const g of design.gates) each(g, main, sigma);
  for (const c of design.crossing?.crossers ?? []) {
    const cp = new Pendulum({ length: c.length, amplitude: c.amplitude });
    for (const g of c.gates ?? []) each(g, cp, TAU / 6);
  }
  return design;
}

// With constant motion, whether a turning part at `station` comes round steadily into line at both its passes.
function fitsSteady(pendulum, station, step, loop) {
  if (!constant) return true;
  const passes = pendulum.passesInPeriod(station);
  if (passes.length < 2) return true;
  const size = physical ? TAU : step;
  return steadySwell(passes, pendulum.period, size, steadySteps([passes], pendulum.period, size, loop, 0.01)).swell < 0.01;
}

// A part turning n steps a period: how much its speed has to swell and ease (as a fraction of its rate, once a
// period) to land exactly on both passes.
function steadySwell(passes, period, step, n) {
  const g0 = passes[1] - passes[0];
  const rate = (n * step) / period;
  const a = Math.min(n - 1, Math.max(1, Math.round((n * g0) / period)));
  const wobble = (a * step - rate * g0) / (2 * Math.sin((Math.PI * g0) / period));
  return { a, rate, wobble, swell: (Math.abs(wobble) * TAU) / period / rate };
}

// Steps a period for parts turning together: whole turns every `loop` periods, at least a step a gap, the fewest that
// keep the swell within `tolerance` at up to a turn a period (three whole turns physically), then at up to two; or
// else the least swell.
function steadySteps(passesList, period, step, loop, tolerance = 0.3, slits = 0) {
  let best = null;
  for (const cap of [1, 2]) {
    for (let n = 2; n * step <= Math.max(cap * TAU, 3 * step) + 1e-9; n++) {
      const whole = (loop * n * step) / TAU;
      if (Math.abs(whole - Math.round(whole)) > 1e-6) continue;
      // With `slits`, every slit has to come round under the rod: the steps in a gap and a period share no factor with it.
      if (slits && gcd(gcd(steadySwell(passesList[0], period, step, n).a, n), slits) !== 1) continue;
      const swell = Math.max(...passesList.map((p) => steadySwell(p, period, step, n).swell));
      if (swell <= tolerance) return n;
      if (!best || swell < best.swell - 1e-9) best = { swell, n };
    }
  }
  return best ? best.n : steadySteps(passesList, period, step, loop, tolerance);
}

// The steady turn: n steps a period at a constant rate, plus a gentle swell of speed once a period (none where the
// passes split the period as the steps do) so it lands on each pass exactly.
function steadyMotion(passes, period, step, n, sign, v0) {
  const { rate, wobble } = steadySwell(passes, period, step, n);
  const mid = (passes[0] + passes[1]) / 2;
  const r = sign * rate, w = sign * wobble;
  return { axis: "x", type: "steady", rate: r, wobble: w, mid, period, phase: v0 - r * passes[0] - w * Math.sin((TAU * (passes[0] - mid)) / period) };
}

function constantMotion(m) {
  if (m.type === "pulse") return { ...m, type: "wave" };
  if (m.type !== "indexed") return m;
  const { axis, passes, period, step, v0 } = m;
  let steps = m.steps;
  if (passes.length > 1 && steps[0] > 0) {
    // Physically a disc still turns whole turns between passes, so it keeps its single slot.
    const quantum = physical && (axis ?? "x") === "x" ? Math.max(1, Math.round(TAU / Math.abs(step))) : 1;
    const g0 = passes[1] - passes[0], g1 = period - g0;
    // Up to three times the turns a period, if that's what it takes to keep the speed nearly even across a pass.
    let best = null;
    for (let times = 1; times <= 3; times++) {
      const total = (steps[0] + steps[1]) * times;
      if (total < 2 * quantum) continue;
      const k0 = Math.min(total - quantum, Math.max(quantum, quantum * Math.round((total / quantum) * (g0 / period))));
      const r = k0 / g0 / ((total - k0) / g1);
      const change = Math.max(r, 1 / r);
      if (!best || change < best.change - 1e-9) best = { change, split: [k0, total - k0] };
      if (change <= 1.5) break;
    }
    if (best) steps = best.split;
  }
  return { axis, type: "glide", passes, period, steps, step, v0 };
}

// Gates on a crossing pendulum's own arc, a pair either side of its bottom (where the main pendulum's path is), far
// enough out to clear the main pendulum and its gates: keyholes and shutters sized for its ball. Their turns keep to
// the main loop, so the grand alignment holds.
function crosserGates(random, c, loop) {
  const cp = new Pendulum({ length: c.length, amplitude: c.amplitude });
  const ball = { thickness: 2 * c.radius, radius: c.radius };
  const step = TAU / 6;
  const unit = 6 / loop;
  const out = [];
  const stations = RATIOS.map(([p, q]) => ({ p, q, angle: cp.stationForRatio(p, q) })).filter(
    (s) => c.length * Math.sin(s.angle) > 0.52 && s.angle < c.amplitude - 0.06 && fitsSteady(cp, s.angle, step, loop),
  );
  if (!stations.length) return out;
  const picks = random() < 0.4 && stations.length > 2 ? [stations[0], stations[stations.length - 1]] : [stations[Math.floor(random() * stations.length)]];
  for (const s of picks) {
    if (out.length && Math.abs(out[out.length - 1].station - s.angle) * c.length < 0.3) continue;
    const family = pick(random, ["keyhole", "shutter"], [3, 1]);
    const dir = random() < 0.5 ? 1 : -1;
    for (const side of [1, -1]) {
      const station = side * s.angle;
      const lock = lockTime(cp, station, reachTo(cp, ball, 0.035, 0.27));
      if (family === "shutter") {
        const open = c.radius + 0.03;
        out.push({ family, station, size: "small", motions: [-1, 1].map((z) => pulse(cp, station, "z", 0, z * open, range(random, 0.12, 0.22), lock)) });
      } else {
        const motion =
          (s.p + s.q) % unit === 0 && random() < 0.5
            ? physical && s.p + s.q > 4
              ? wholeTurns(cp, station, dir * side, lock)
              : steady(cp, station, s.p, s.q, physical ? TAU : step, dir * side)
            : indexed(cp, station, dir * side * step, loopSteps(random, unit, undefined, 6), "burst", random, "x", lock);
        out.push({ family, station, size: "small", motion });
      }
    }
  }
  return out;
}

// How far each hero reaches along the arc, at most.
function heroReach(hero) {
  return { wall: 0.1, iris: 0.1, rings: 0.49, tunnel: (12 * TUMBLER_PITCH) / 2 + 0.05, torus: 0.5 }[hero];
}

export { designContraption, indexed, steady, pulse, pick, range, LAYOUTS };
