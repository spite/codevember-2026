import { Mesh, Group, Matrix4, Vector3, Quaternion, TorusGeometry, SphereGeometry } from "three";
import { slabFromShapes } from "./slab.js";
import { motionValue } from "./motion.js";
import { Knock } from "./knock.js";

const TAU = Math.PI * 2;
const STATIC = { type: "static" };

// A gate stands across the path at angle `station`: its frame has X along the path, Y toward the pivot, Z across.
// `base` (pivot, and the swing plane turned) is for a pendulum that swings across the main one.
function gateFrame(pendulum, pivot, station, base = null) {
  const L = pendulum.length;
  if (base) return base.clone().multiply(new Matrix4().makeRotationZ(station).setPosition(L * Math.sin(station), -L * Math.cos(station), 0));
  return new Matrix4().makeRotationZ(station).setPosition(pivot.x + L * Math.sin(station), pivot.y - L * Math.cos(station), pivot.z);
}

// The bob's passes through `station` in [0, periods * T).
function passTimes(pendulum, station, periods) {
  const out = [];
  for (let n = 0; n < periods; n++) for (const t of pendulum.passesInPeriod(station)) out.push(t + n * pendulum.period);
  return out;
}

const circle = (r, c = [0, 0]) => ({ type: "circle", c, r });
const rect = (u0, v0, u1, v1, r) => ({ type: "roundRect", c: [(u0 + u1) / 2, (v0 + v1) / 2], h: [(u1 - u0) / 2, (v1 - v0) / 2], r });

// A gate is a set of pieces, each a slab the cutter shapes: its outline, minus whatever the bob and its rod sweep
// through it as it moves. A piece's frame is the gate's, then `base`; its motion turns it about its own X or slides
// it along Z or Y. Parts below the cradle's top are simply hidden inside it.
class Gate {
  // `at` is a station on a plane swing, or for a gimbal { frame (Matrix4), pass } (its one pass in a loop).
  constructor(rig, at) {
    this.rig = rig;
    if (typeof at === "number") {
      this.station = at;
      this.frame = gateFrame(rig.pendulum, rig.pivot, at, rig.base);
    } else {
      this.station = 0;
      this.frame = at.frame;
      this.pass = at.pass;
    }
    this.group = new Group();
    this.frame.decompose(this.group.position, this.group.quaternion, this.group.scale);
    this.pieces = [];
  }

  // Where the bob crosses a piece set `dx` along the gate's X.
  stationAt(dx = 0) {
    return this.rig.pendulum ? this.station + dx / this.rig.pendulum.length : 0;
  }

  // `station` is where the bob crosses the piece (by default, the gate's moved along X by the base).
  // `support` says what holds the piece up, for the physical check: by default its bottom, down in the base.
  addPiece({ base = new Matrix4(), bounds, cell = 0.002, outline, thickness, bevel = 0.008, motion = STATIC, material, smooth, station, link, support, track, uncut }) {
    const world = this.frame.clone().multiply(base);
    const at = station ?? this.stationAt(base.elements[12]);
    // A gimbal's gate is passed once a loop; its loops repeat whole, so one pass is enough to cut.
    const passes = this.pass !== undefined ? [this.pass] : passTimes(this.rig.pendulum, at, this.rig.cyclePeriods);
    // An uncut piece is sent no sweep at all, so nothing is ever cut from it.
    const sweep = uncut ? undefined : { frame: Float64Array.from(world.elements), motion, passes, thickness, station: at };
    const job = { bounds, cell, outline, smooth, sweep };
    this.pieces.push({ base, motion, material, thickness, bevel, job, link, track, station: at, support: support ?? { kind: "bottom", v: bounds[1] + 0.05 } });
  }

  get jobs() {
    return this.pieces.map((p) => p.job);
  }

  // On a gimbal, which way the lower arm runs from the bob through the gate at its pass: radians from the gate's up.
  rodAngle() {
    const m = this.rig.gimbal.lowerMatrix(new Float64Array(16), this.pass);
    const d = new Vector3(m[4], m[5], m[6]).applyMatrix4(new Matrix4().extractRotation(this.frame).invert());
    return Math.atan2(d.z, d.y);
  }

  apply(results, materials) {
    this.dropped = 0;
    this.pieces.forEach((p, i) => {
      // Physically, a cut fragment that nothing holds up would fall: it goes.
      const shapes = results[i];
      const kept = this.rig.physical ? supported(shapes, p.support) : shapes;
      this.dropped += shapes.length - kept.length;
      p.floating = floating(shapes, p.support);
      const geometry = slabFromShapes(kept, { thickness: p.thickness, bevel: p.bevel });
      if (!geometry) return;
      const holder = new Group();
      p.base.decompose(holder.position, holder.quaternion, holder.scale);
      p.mesh = new Mesh(geometry, materials[p.material]);
      p.mesh.userData.gate = this;
      p.mesh.userData.piece = p;
      p.shapes = kept;
      holder.add(p.mesh);
      this.group.add(holder);
      if (p.motion.type !== "static") p.knock = p.link?.knock ?? this.knockFor(p);
      if (p.link) p.link.knock = p.knock;
    });
  }

  // A piece's knock: when the arm is near it, and which offsets its cut pattern repeats under.
  knockFor(p) {
    if (this.rig.gimbal) return this.knockForGimbal(p);
    const { pendulum } = this.rig;
    const L = pendulum.length;
    const axis = p.motion.axis ?? "x";
    const [u0, v0, u1, v1] = p.job.bounds;
    const radius = Math.max(Math.hypot(u0, v0), Math.hypot(u1, v1), Math.hypot(u0, v1), Math.hypot(u1, v0));
    const rIn = Math.max(0.2, L - v1);
    // Turned about its own Y, a piece reaches its radius along the path.
    const reach = (p.thickness / 2 + this.rig.xExtent + 0.03 + (axis === "ry" || axis === "rz" ? radius : 0)) / rIn;
    const station = p.station;
    const near = (t) => Math.abs(pendulum.angle(t) - station) < reach;
    // Turning parts settle whole turns, so their grand-alignment markers come back round with them.
    let step = 0, sign = 0;
    const opens = p.motion.type === "pulse" || p.motion.type === "wave";
    if ((axis === "x" || axis === "ry") && !opens) step = TAU;
    if (opens) sign = Math.sign(p.motion.open - p.motion.closed) || 1;
    return new Knock({ near, step, sign, period: pendulum.period });
  }

  // On a gimbal, the bob is near a piece while within its reach of the piece's frame: found once over a loop.
  knockForGimbal(p) {
    const { gimbal } = this.rig;
    const axis = p.motion.axis ?? "x";
    const [u0, v0, u1, v1] = p.job.bounds;
    const radius = Math.max(Math.hypot(u0, v0), Math.hypot(u1, v1), Math.hypot(u0, v1), Math.hypot(u1, v0));
    const world = this.frame.clone().multiply(p.base);
    const origin = new Vector3().setFromMatrixPosition(world);
    const reach = radius + this.rig.bobRadius + 0.08 + (axis === "ry" || axis === "rz" ? radius : 0);
    const T = gimbal.period;
    const close = [];
    for (let t = 0; t < T; t += 0.004) {
      const b = gimbal.bob(t);
      close.push(Math.hypot(b[0] - origin.x, b[1] - origin.y, b[2] - origin.z) < reach);
    }
    const near = (t) => close[Math.floor((((t % T) + T) % T) / 0.004) % close.length];
    let step = 0, sign = 0;
    const opens = p.motion.type === "pulse" || p.motion.type === "wave";
    if ((axis === "x" || axis === "ry") && !opens) step = TAU;
    if (opens) sign = Math.sign(p.motion.open - p.motion.closed) || 1;
    return new Knock({ near, step, sign, period: T });
  }

  // A click on one of the gate's meshes, along `ray` (world), at `point`: jolts the piece hit, or if that was a fixed
  // part, every moving piece. True if anything moved.
  knock(mesh, point, ray, t) {
    const hit = mesh.userData.piece;
    const targets = hit?.knock ? [hit] : this.pieces.filter((p) => p.knock);
    let moved = false;
    for (const p of targets) moved = this.kickPiece(p, point, ray, t) || moved;
    return moved;
  }

  kickPiece(p, point, ray, t) {
    const axis = p.motion.axis ?? "x";
    const world = p.mesh.parent.matrixWorld;
    const origin = new Vector3().setFromMatrixPosition(world);
    const along = new Vector3().setFromMatrixColumn(world, axis === "z" ? 2 : axis === "y" || axis === "ry" ? 1 : axis === "rz" ? 2 : 0).normalize();
    let speed;
    if (axis === "z" || axis === "y") {
      speed = 0.9 * (Math.sign(ray.dot(along)) || 1);
    } else {
      // Spun the way the click pushes it, harder the further from its axis.
      const torque = new Vector3().subVectors(point, origin).cross(ray).dot(along);
      speed = 9 * Math.sign(torque || 1) * Math.min(1, Math.abs(torque) / 0.12 + 0.3);
    }
    return p.knock.kick(t, speed);
  }

  update(t) {
    for (const p of this.pieces) {
      if (p.motion.type === "static" || !p.mesh) continue;
      let v = motionValue(p.motion, t) + (p.knock ? p.knock.offset(t) : 0);
      // A knock can't slide it past the ends of its track.
      if (p.track) v = Math.min(p.track[1], Math.max(p.track[0], v));
      const axis = p.motion.axis ?? "x";
      if (axis === "z") p.mesh.position.z = v;
      else if (axis === "y") p.mesh.position.y = v;
      else if (axis === "rz") p.mesh.rotation.z = v % TAU;
      else if (axis === "ry") p.mesh.rotation.y = v % TAU;
      else p.mesh.rotation.x = v % TAU;
    }
  }
}

function loopSpan(a) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, area = 0;
  for (let i = 0, n = a.length; i < n; i += 2) {
    const j = (i + 2) % n;
    [u0, u1, v0, v1] = [Math.min(u0, a[i]), Math.max(u1, a[i]), Math.min(v0, a[i + 1]), Math.max(v1, a[i + 1])];
    area += a[i] * a[j + 1] - a[j] * a[i + 1];
  }
  return { u0, u1, v0, v1, area: Math.abs(area) / 2 };
}

// Whether (u, v) is inside a loop, and how far it is from the loop's edges.
function probe(a, u, v) {
  let inside = false, near = Infinity;
  for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
    const [x0, y0, x1, y1] = [a[j], a[j + 1], a[i], a[i + 1]];
    if (y1 > v !== y0 > v && u < ((x0 - x1) * (v - y1)) / (y0 - y1) + x1) inside = !inside;
    const dx = x1 - x0, dy = y1 - y0;
    const k = Math.max(0, Math.min(1, ((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy || 1)));
    near = Math.min(near, Math.hypot(x0 + k * dx - u, y0 + k * dy - v));
  }
  return { inside, near };
}

// Whether a pin of radius r at (u, v) goes through the shape's material.
function pinned(shape, u, v, r) {
  const o = probe(shape.outer, u, v);
  if (!o.inside || o.near < r) return false;
  return shape.holes.every((h) => {
    const q = probe(h, u, v);
    return !q.inside && q.near >= r;
  });
}

// Whether a cut fragment reaches what holds it: the base below, its housing's rim, a column at either end, a pin or
// spindle; or for a piece held only from below by rollers, being the piece itself.
function holds(shape, support, largest) {
  const s = loopSpan(shape.outer);
  switch (support.kind) {
    case "single": return shape === largest;
    case "rim": {
      let r = 0;
      for (let i = 0; i < shape.outer.length; i += 2) r = Math.max(r, Math.hypot(shape.outer[i], shape.outer[i + 1]));
      return r > support.r - 0.012;
    }
    case "guide":
      return slid(support.range, (d) => support.columns.some(([a, b]) => Math.min(b, s.u1 + d) - Math.max(a, s.u0 + d) >= support.grip));
    case "point": return pinned(shape, support.u, support.v, 0.006);
    default:
      if (!(s.v0 < support.v)) return false;
      return !support.span || slid(support.range, (d) => Math.min(support.span, s.u1 + d) - Math.max(-support.span, s.u0 + d) >= 0.04);
  }
}

// Whether `held(d)` holds all along a slide over `range`.
function slid([lo, hi], held) {
  for (let k = 0; k <= 8; k++) if (!held(lo + ((hi - lo) * k) / 8)) return false;
  return true;
}

function supported(shapes, support) {
  const largest = shapes.reduce((a, b) => (!a || loopSpan(b.outer).area > loopSpan(a.outer).area ? b : a), null);
  return shapes.filter((sh) => holds(sh, support, largest));
}

// How many fragments of a piece nothing holds up.
function floating(shapes, support) {
  return shapes.length - supported(shapes, support).length;
}

// A plate across the path with a disc turning in it.
class KeyholeGate extends Gate {
  constructor(rig, { station, motion, discRadius = 0.24, halfWidth = 0.3, above = 0.1, depth, thickness = 0.06, gap = 0.003 }) {
    super(rig, station);
    const top = discRadius + above;
    this.addPiece({
      bounds: [-halfWidth - 0.01, -depth - 0.01, halfWidth + 0.01, top + 0.01],
      outline: { add: [rect(-halfWidth, -depth, halfWidth, top, 0.03)], sub: [circle(discRadius + gap)] },
      thickness,
      material: "slab",
    });
    const R = discRadius + 0.005;
    // Held at its rim by the plate's housing.
    this.addPiece({ bounds: [-R, -R, R, R], cell: 0.00125, outline: { add: [circle(discRadius)] }, thickness: thickness * 0.92, motion, material: "disc", support: { kind: "rim", r: discRadius } });
  }
}

// Thin discs one after another along the path, each square to it at its own station, rising out of the cradle and
// turning its own way: their holes line up into a tunnel only as the bob comes through.
class TumblerGate extends Gate {
  constructor(rig, { station, motions, pitch = 0.033, thickness, discRadius = 0.31, radii, gap = 0.007 }) {
    super(rig, station);
    this.kind = "tumbler";
    this.discRadius = discRadius;
    const count = motions.length;
    thickness ??= pitch - gap;
    // On a gimbal each disc is its own gate, square to the path where it stands.
    const planar = typeof station === "number";
    const L = rig.pendulum?.length ?? 1;
    const inverse = this.frame.clone().invert();
    motions.forEach((motion, i) => {
      const radius = radii?.[i] ?? discRadius;
      const R = radius + 0.005;
      const at = planar ? station + ((i - (count - 1) / 2) * pitch) / L : 0;
      this.addPiece({
        base: planar ? inverse.clone().multiply(gateFrame(rig.pendulum, rig.pivot, at, rig.base)) : new Matrix4(),
        station: at,
        bounds: [-R, -R, R, R],
        cell: 0.00125,
        outline: { add: [circle(radius)] },
        thickness,
        bevel: 0.005,
        motion,
        material: i % 2 ? "disc" : "disc2",
        // Nothing but rollers in the cradle under it: it has to be all one piece.
        support: { kind: "single" },
      });
      this.pieces[this.pieces.length - 1].radius = radius;
    });
  }
}

// Two halves meeting on the path that part as the bob comes; whatever they don't clear is notched out of their edges.
class ShutterGate extends Gate {
  // `post`: the half-width of the pedestal it stands on, if not the base.
  constructor(rig, { station, motions, halfWidth = 0.3, top = 0.32, depth, thickness = 0.06, post }) {
    super(rig, station);
    // Physically on a gimbal, the halves meet along the lower arm above the bob, so it runs between them, not through.
    const seam = rig.physical && rig.gimbal ? this.rodAngle() : 0;
    [-1, 1].forEach((side, i) => {
      const [u0, u1] = seam ? [-halfWidth, halfWidth] : side < 0 ? [-halfWidth, 0] : [0, halfWidth];
      const m = motions[i];
      const outline = { add: [rect(u0, -depth, u1, top, 0.02)] };
      if (seam) {
        // Its side of the seam: straight down from the bob, along the arm up from it.
        const [a0, a1] = side < 0 ? [Math.PI / 2 - seam, 1.5 * Math.PI] : [-Math.PI / 2, Math.PI / 2 - seam];
        const steps = Math.ceil((a1 - a0) / 0.4);
        outline.clip = [{ type: "poly", points: [[0, 0], ...Array.from({ length: steps + 1 }, (_, k) => [5 * Math.cos(a0 + ((a1 - a0) * k) / steps), 5 * Math.sin(a0 + ((a1 - a0) * k) / steps)])] }];
      }
      this.addPiece({
        bounds: [u0 - 0.01, -depth - 0.01, u1 + 0.01, top + 0.01],
        outline,
        thickness,
        motion: m,
        material: side < 0 ? "slab" : "slab2",
        support: { kind: "bottom", v: -depth + 0.04, span: post, range: [Math.min(m.closed, m.open), Math.max(m.closed, m.open)] },
      });
    });
  }
}

// A wall of bars stacked across the path, each sliding sideways out of line between passes and back into line for
// each one, when their notches form the bob's outline.
class WallGate extends Gate {
  constructor(rig, { station, motions, halfWidth = 0.42, top = 0.4, depth, bar = 0.06, gap = 0.004, thickness = 0.07 }) {
    super(rig, station);
    const count = motions.length;
    const bottom = top - count * (bar + gap) + gap;
    // Each column's plates span c0..c1 either side; a bar is held while `grip` of it is between them.
    const c0 = halfWidth - 0.07, c1 = halfWidth + 0.02, grip = 0.02;
    motions.forEach((motion, i) => {
      const v0 = bottom + i * (bar + gap);
      const lo = Math.min(motion.closed, motion.open), hi = Math.max(motion.closed, motion.open);
      // Physically, split by the bob, each half has to stay between its column's plates all along the slide.
      const left = rig.physical ? Math.max(halfWidth, c0 + grip + 0.02 + hi) : halfWidth;
      const right = rig.physical ? Math.max(halfWidth, c0 + grip + 0.02 - lo) : halfWidth;
      this.addPiece({
        bounds: [-left - 0.01, v0 - 0.01, right + 0.01, v0 + bar + 0.01],
        cell: 0.0015,
        outline: { add: [rect(-left, v0, right, v0 + bar, 0.012)] },
        thickness,
        bevel: 0.006,
        motion,
        material: i % 2 ? "disc" : "disc2",
        support: { kind: "guide", columns: [[c0, c1], [-c1, -c0]], range: [lo, hi], grip },
        track: rig.physical ? [lo, hi] : undefined,
      });
    });
    // Columns either side, down into the cradle: each a pair of plates, before and behind the bars, which slide
    // between them.
    const plate = 0.016;
    for (const side of [-1, 1]) {
      const u0 = Math.min(side * (halfWidth - 0.07), side * (halfWidth + 0.02)), u1 = Math.max(side * (halfWidth - 0.07), side * (halfWidth + 0.02));
      for (const face of [-1, 1]) {
        this.addPiece({
          base: new Matrix4().makeTranslation(face * (thickness / 2 + 0.003 + plate / 2), 0, 0),
          bounds: [u0 - 0.01, -depth - 0.01, u1 + 0.01, top + 0.06],
          outline: { add: [rect(u0, -depth, u1, top + 0.05, 0.012)] },
          thickness: plate,
          bevel: 0.005,
          material: "slab",
        });
      }
    }
    // The bars stop at the bottom one; under it, a solid foot down into the cradle.
    this.addPiece({
      bounds: [-halfWidth - 0.01, -depth - 0.01, halfWidth + 0.01, bottom - gap + 0.01],
      outline: { add: [rect(-halfWidth + 0.02, -depth, halfWidth - 0.02, bottom - gap, 0.01)] },
      thickness,
      material: "slab",
    });
  }
}

// An iris as a camera's is built: five broad lobed blades round the aperture, each turning on a fixed pivot near its
// inner end (C) as the actuator ring, through a pin on each, turns them all together. Open, their inner edges ring the
// aperture, the blades hidden behind the housing's front plate; turned 60 degrees about their pivots, they swing in,
// overlapping, and shut it. Open, the blades stand a little apart, and the iris is turned so one of those gaps lies
// under the rod (straight up on a plane swing, along the lower arm on a gimbal): it comes down between two blades and
// cuts none. The housing closes round them: front and back plates, and a rim between them outside the blades' reach.
class IrisGate extends Gate {
  // `blade`: each blade's layer, a thin sheet like a camera's, so the five lie all but in one plane.
  constructor(rig, { station, motions, aperture, lean = 1, outer, depth, blade = 0.0015 }) {
    super(rig, station);
    const n = motions.length;
    const Ra = aperture;
    const Rh = outer;
    const stack = n * blade;
    // Front and back plates of the housing, its blades between them.
    for (const x of [stack / 2 + 0.015, -stack / 2 - 0.015]) {
      this.addPiece({
        base: new Matrix4().makeTranslation(x, 0, 0),
        bounds: [-Rh - 0.01, -depth - 0.01, Rh + 0.01, Rh + 0.01],
        outline: { add: [circle(Rh), rect(-Rh * 0.55, -depth, Rh * 0.55, 0, 0.02)], sub: [circle(Ra)] },
        thickness: 0.03,
        material: "slab",
      });
    }
    // The rim between the plates, closing the housing round the blades: from just beyond where any blade reaches, at
    // any turn it makes, out to the plates' edge (and their foot, down into the base).
    // Mirrored for an iris that turns the other way.
    const hand = Math.sign(lean) || 1;
    const turns = motions.flatMap((m) => [m.closed * hand, m.open * hand]);
    let reach = 0;
    for (let i = 0; i <= 12; i++) {
      const b = Math.min(...turns) + ((Math.max(...turns) - Math.min(...turns)) * i) / 12;
      for (const q of IRIS_BLADE) reach = Math.max(reach, turned(q, b));
    }
    this.addPiece({
      bounds: [-Rh - 0.01, -depth - 0.01, Rh + 0.01, Rh + 0.01],
      outline: { add: [circle(Rh), rect(-Rh * 0.55, -depth, Rh * 0.55, 0, 0.02)], sub: [circle(reach * Ra + 0.006)] },
      thickness: stack + 0.002,
      bevel: 0.002,
      material: "slab",
    });
    // Round the centre by `turn` degrees (clockwise from up), mirrored, then turned so the top gap faces the rod.
    const up = rig.gimbal ? this.rodAngle() : 0;
    const cu = Math.cos(up), su = Math.sin(up);
    const at = ([r, a], turn) => {
      const t = ((a + turn) * Math.PI) / 180;
      const x = hand * r * Ra * Math.sin(t), y = r * Ra * Math.cos(t);
      return [x * cu + y * su, y * cu - x * su];
    };
    const link = {};
    motions.forEach((motion, k) => {
      const turn = (k * 360) / n - IRIS_GAP;
      const [pu, pv] = at(IRIS_PIVOT, turn);
      const points = IRIS_BLADE.map((q) => {
        const [u, v] = at(q, turn);
        return [u - pu, v - pv];
      });
      const us = points.map((q) => q[0]), vs = points.map((q) => q[1]);
      this.addPiece({
        base: new Matrix4().makeTranslation(-stack / 2 + (k + 0.5) * blade, pv, pu),
        bounds: [Math.min(...us) - 0.01, Math.min(...vs) - 0.01, Math.max(...us) + 0.01, Math.max(...vs) + 0.01],
        cell: 0.0016,
        outline: { add: [{ type: "poly", points }] },
        thickness: blade * 0.85,
        bevel: 0.0004,
        motion,
        material: k % 2 ? "disc" : "disc2",
        link,
        // Held on its pivot; a knock can't turn it past open or shut.
        support: { kind: "point", u: 0, v: 0 },
        track: [Math.min(motion.closed, motion.open), Math.max(motion.closed, motion.open)],
      });
    });
  }
}

// One blade as it lies open, traced from a drawing of a camera iris (radius in aperture radii, degrees clockwise from
// up): a broad lobe round the outside and an inner edge on the aperture's rim, its pivot near the inner end. Its lobe
// is drawn out a third further, and its leading end trimmed back to 26 degrees so open blades stand apart with room
// for the rod between two; that way five still shut with no gap (turned 82 degrees).
const IRIS_START = 26;
const IRIS_BLADE = [
  [1.05, IRIS_START],
  ...[[1.57, 31.0], [1.74, 37.9], [1.86, 44.8], [1.87, 51.2], [1.8, 58.0], [1.66, 66.9], [1.54, 74.2], [1.39, 81.0], [1.25, 85.2], [1.11, 86.4], [1.03, 86.1]].map(([r, a]) => [1 + (r - 1) * 1.35, a]),
  ...Array.from({ length: 24 }, (_, i) => [1, 86 - ((86 - IRIS_START) * i) / 23]),
];
const IRIS_PIVOT = [1.158, 77.4];
// Where the gap between one blade's end and the next blade's start lies (degrees from up), turned to the top.
const IRIS_GAP = (86.1 - 72 + IRIS_START) / 2;

// How far from the iris centre (aperture radii) a blade point [r, degrees] lies once its blade has turned `b` (radians,
// as the motion turns it) about the pivot.
function turned([r, a], b) {
  const toXY = ([rr, aa]) => [rr * Math.sin((aa * Math.PI) / 180), rr * Math.cos((aa * Math.PI) / 180)];
  const [px, py] = toXY(IRIS_PIVOT);
  const [x, y] = toXY([r, a]);
  const c = Math.cos(b), s = Math.sin(b);
  const dx = x - px, dy = y - py;
  return Math.hypot(px + dx * c + dy * s, py + dy * c - dx * s);
}

// Rings one inside another on a spindle up from the cradle, spinning like coins at their own rates and all turning
// face on to the path as the bob comes through them. With `solid`, the innermost is a disc, the bob's outline cut
// through it.
class RingsGate extends Gate {
  constructor(rig, { station, motions, outer = 0.42, width = 0.045, gap = 0.014, thickness = 0.035, solid = false, depth }) {
    super(rig, station);
    motions.forEach((motion, k) => {
      const R = outer - k * (width + gap);
      const disc = solid && k === motions.length - 1;
      this.addPiece({
        bounds: [-R - 0.01, -R - 0.01, R + 0.01, R + 0.01],
        cell: 0.0012,
        outline: disc ? { add: [circle(R)] } : { add: [circle(R)], sub: [circle(R - width)] },
        thickness,
        bevel: 0.007,
        motion,
        material: k % 2 ? "disc2" : "disc",
        // Held on the spindle at its bottom.
        support: { kind: "point", u: 0, v: -R + width / 2 },
      });
    });
    // The spindle, from the cradle to the outer ring.
    this.addPiece({
      bounds: [-0.03, -depth - 0.01, 0.03, -outer + 0.005],
      outline: { add: [rect(-0.018, -depth, 0.018, -outer + 0.004, 0.006)] },
      thickness: 0.036,
      material: "rod",
    });
  }
}

// A socket at the top of the swing: a block with a pocket the bob slides into and stops in, a hair from its back,
// before swinging away again. `side` is +1 at the +angle end of the swing, -1 at the other.
class SocketGate extends Gate {
  constructor(rig, { station, side, bobThickness, halfWidth = 0.28, top = 0.3, depth, back = 0.05, motion }) {
    super(rig, station);
    this.kind = "socket";
    const gap = rig.clearance;
    // The pocket takes the whole bob; the back is just past where it stops.
    const front = bobThickness + 0.02;
    const xFront = side * (bobThickness / 2 + gap - front / 2);
    const xBack = side * (bobThickness / 2 + gap + back / 2);
    const outline = { add: [rect(-halfWidth, -depth, halfWidth, top, 0.04)] };
    const bounds = [-halfWidth - 0.01, -depth - 0.01, halfWidth + 0.01, top + 0.01];
    this.addPiece({ base: new Matrix4().makeTranslation(xFront, 0, 0), station, bounds, outline, thickness: front, bevel: 0.01, material: "slab", motion });
    this.addPiece({ base: new Matrix4().makeTranslation(xBack, 0, 0), station, bounds, outline, thickness: back, bevel: 0.01, material: "slab2" });
  }
}

// A torus round the path, its tube parted at the top: a slit for the rod. It spins on its upright axis (along its
// pendulum's rod) like a coin and stands face on whenever a bob goes through its hole; the slit, on that axis, stays
// over the rod whichever way it faces. Pendulums swinging across can share it, their rods through a slit opened up to
// one side as far as they need. It stands on the base by its lowest point, which stays put on the spin axis, like a
// coin spinning on a table. It isn't cut: its hole is made to clear the balls and its slit the rods.
class TorusGate extends Gate {
  // `passers`: other pendulums through it ({ segment(t): its rod's ends in world space, near(t) }).
  constructor(rig, { station, motion, tube, major, rod = 0.009, depth, passers = [] }) {
    super(rig, station);
    this.kind = "torus";
    this.tube = tube;
    this.major = major;
    this.depth = depth;
    this.passers = passers;
    const P = rig.pendulum, L = P.length, pivot = rig.pivot;
    const own = (t) => {
      const a = P.angle(t);
      return [pivot.clone(), new Vector3(pivot.x + L * Math.sin(a), pivot.y - L * Math.cos(a), pivot.z)];
    };
    // The slit, as angles round the tube from straight up (toward the gate's Z when face on): every angle at which a rod
    // comes within reach of the tube's centre line, the torus turning under it, and room for the domed ends.
    const toLocal = this.frame.clone().invert();
    const reachOf = tube + rod + rig.clearance;
    let lo = 0, hi = 0;
    const a = new Vector3(), b = new Vector3(), q = new Vector3();
    for (const segment of [own, ...passers.map((r) => r.segment)]) {
      for (let t = 0; t < P.period; t += 0.002) {
        const [wa, wb] = segment(t);
        a.copy(wa).applyMatrix4(toLocal);
        b.copy(wb).applyMatrix4(toLocal);
        const v = motionValue(motion, t), c = Math.cos(v), s = Math.sin(v);
        const n = 240;
        for (let i = 0; i <= n; i++) {
          q.lerpVectors(a, b, i / n);
          if (Math.abs(q.length() - major) > reachOf) continue;
          const x = q.x * c - q.z * s, z = q.x * s + q.z * c;
          if (Math.hypot(Math.hypot(z, q.y) - major, x) > reachOf) continue;
          const angle = Math.atan2(z, q.y);
          lo = Math.min(lo, angle);
          hi = Math.max(hi, angle);
        }
      }
    }
    const end = (rod + rig.clearance + 0.004 + 0.15 * tube) / (major - tube);
    this.slit = [Math.max(-1.4, lo - end), Math.min(1.4, hi + end)];
    const R = major + tube;
    this.pieces.push({ base: new Matrix4(), motion, material: "disc", thickness: 2 * tube, job: { bounds: [-R, -R, R, R] }, station: this.station, support: { kind: "single" } });
  }

  get jobs() {
    return [];
  }

  // A knock has to be over before any of its pendulums comes near.
  knockFor(p) {
    const knock = super.knockFor(p);
    const near = knock.near;
    knock.near = (t) => near(t) || this.passers.some((r) => r.near(t));
    return knock;
  }

  apply(results, materials) {
    this.dropped = 0;
    const p = this.pieces[0];
    const { tube, major } = this;
    const [lo, hi] = this.slit;
    const arc = 2 * Math.PI - (hi - lo);
    // Built round its own Z (three's torus) from the slit's far end, then laid face on to the path (round the gate's
    // X) with the slit at the top.
    const ring = new Group();
    ring.quaternion
      .setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2 - lo));
    ring.add(new Mesh(new TorusGeometry(major, tube, 40, 200, arc), materials[p.material]));
    // Each end closed by a low dome, gold, so the slit reads.
    const ends = [
      [0, [0, -1, 0]],
      [arc, [-Math.sin(arc), Math.cos(arc), 0]],
    ];
    for (const [a, out] of ends) {
      const cap = new Mesh(new SphereGeometry(tube, 32, 16), materials.accent ?? materials[p.material]);
      cap.position.set(major * Math.cos(a), major * Math.sin(a), 0);
      cap.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...out));
      cap.scale.set(1, 0.15, 1);
      ring.add(cap);
    }
    p.mesh = new Group();
    p.mesh.add(ring);
    p.mesh.traverse((m) => {
      m.userData.gate = this;
      m.userData.piece = p;
    });
    p.shapes = null;
    p.floating = 0;
    const holder = new Group();
    holder.add(p.mesh);
    this.group.add(holder);
    p.knock = this.knockFor(p);
  }
}

export { Gate, KeyholeGate, TumblerGate, ShutterGate, WallGate, IrisGate, RingsGate, SocketGate, TorusGate, gateFrame, passTimes };
