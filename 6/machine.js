// The clockwork: tokens ride the channels node to node in timed ticks. Each tick the turntables
// turn first (carrying any token on them onto another circle), then every token that has room moves
// one edge. Tokens sort onto the circles of their colour, orbit for a while, then get scrambled.
import { dot, cross, normalize, scale, circlePoint, angle, plateField, perpendicular } from "./layout.js";

const TAU = Math.PI * 2;
export const DIAL_STEP = TAU / 24;
const ROTATE = [0.02, 0.4]; // phase A, fraction of a tick
const MOVE = [0.44, 0.96]; // phase B
const ORBIT_TICKS = 10;
const SCRAMBLE_TICKS = 7;
const SORT_TICKS = 60;
export const POP_TIME = 1.25;
export const PLATE_POP_TIME = 2.4;
// Dials stay out longer than turntables, so their full turn reads clearly.
export const DIAL_POP_TIME = 1.8;

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Shortest turn that lines a slot (symmetric, so modulo pi) up with angle a.
function slotTurn(psi, a) {
  let d = (a - psi) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d <= -Math.PI / 2) d += Math.PI;
  return d;
}

function inOutBack(t, s) {
  t *= 2;
  if (t < 1) return 0.5 * (t * t * ((s + 1) * t - s));
  t -= 2;
  return 0.5 * (t * t * ((s + 1) * t + s) + 2);
}
// Eases with a small wind-up and a settle past the stop, like an escapement.
export const clockEase = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : inOutBack(t, 0.9));
const outBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class Anim {
  constructor(value = 0) {
    this.from = value;
    this.to = value;
    this.start = 0;
    this.duration = 0;
    this.ease = clockEase;
  }
  value(t) {
    if (this.duration <= 0 || t >= this.start + this.duration) return this.to;
    if (t <= this.start) return this.from;
    return this.from + (this.to - this.from) * this.ease((t - this.start) / this.duration);
  }
  busy(t) {
    return this.duration > 0 && t < this.start + this.duration;
  }
  set(t, to, start, duration, ease = clockEase) {
    this.from = this.value(t);
    this.to = to;
    this.start = start;
    this.duration = duration;
    this.ease = ease;
  }
}

function liftOf(pops, i, time) {
  const pop = pops[i];
  if (!pop) return 0;
  const u = (time - pop.start) / pop.duration;
  if (u <= 0) return 0;
  if (u >= 1) {
    pops[i] = null;
    return 0;
  }
  if (u < 0.24) return outBack(u / 0.24);
  if (u < 0.74) return 1;
  return 1 - inOutCubic((u - 0.74) / 0.26);
}

// The largest k (up to 12) for which turning the plate by TAU / k about its centre maps its outline onto itself.
function symmetryOf(face) {
  const field = plateField(face);
  const c = face.center, e1 = perpendicular(c), e2 = cross(c, e1);
  const at = (a, t) => {
    const d = [e1[0] * Math.cos(a) + e2[0] * Math.sin(a), e1[1] * Math.cos(a) + e2[1] * Math.sin(a), e1[2] * Math.cos(a) + e2[2] * Math.sin(a)];
    return normalize([c[0] * Math.cos(t) + d[0] * Math.sin(t), c[1] * Math.cos(t) + d[1] * Math.sin(t), c[2] * Math.cos(t) + d[2] * Math.sin(t)]);
  };
  const samples = [];
  for (let i = 0; i < 48; i++) for (const t of [0.35, 0.7, 0.9, 1.0]) samples.push([(i / 48) * TAU, t * face.reach]);
  const base = samples.map(([a, t]) => field(at(a, t)));
  for (let k = 12; k >= 2; k--) {
    if (samples.every(([a, t], i) => Math.abs(field(at(a + TAU / k, t)) - base[i]) < 2e-3)) return k;
  }
  return 1;
}

export class Machine {
  constructor(layout, { density = 0.45, colours = 3, random = Math.random } = {}) {
    this.layout = layout;
    this.random = random;
    const { circles, nodes, faces } = layout;
    this.time = 0;
    // Called with (type, start, info) for everything that moves, at the moment it's scheduled; start is in
    // machine time and may be in the future. Types: move, turn, notch, pop, sorted.
    this.onEvent = null;
    this.tickLength = 1.4;
    this.tickStart = 0;
    this.mode = "sort";
    this.modeTicks = 0;
    this.stuck = 0;
    this.sorted = 0;

    const order = shuffle(circles.map((_, i) => i), random);
    const m = Math.max(1, Math.min(colours, circles.length));
    this.colours = m;
    this.circleColour = [];
    order.forEach((c, i) => (this.circleColour[c] = i % m));
    this.circleDir = circles.map(() => (random() < 0.5 ? 1 : -1));

    // phi of each node on each of its circles
    this.phi = nodes.map(() => ({}));
    circles.forEach((C, c) => C.nodes.forEach((e) => (this.phi[e.node][c] = e.phi)));

    this.psi = nodes.map((node) => new Anim(node.alpha[random() < 0.5 ? 0 : 1]));
    this.pops = nodes.map(() => null);
    this.forced = new Set();
    this.dials = faces.map(() => new Anim(random() * 24 * DIAL_STEP));
    this.dialPops = faces.map(() => null);
    this.platePops = faces.map(() => null);
    this.plateQueue = new Set();
    this.plateTurn = faces.map(() => new Anim(0));
    // How many ways each plate fits its own hole: a turn of a multiple of TAU / k seats it again.
    this.plateFold = faces.map((face) => symmetryOf(face));
    // Pop-outs per second that happen on their own.
    this.autoRate = 0.3;
    // Pop-outs keep their own pace in real time: machine time runs at Speed, so their length is scaled by it.
    this.popScale = 1;
    this.autoClock = 2;

    const count = Math.max(m, Math.min(Math.round(density * nodes.length), Math.floor(nodes.length * 0.62)));
    const free = shuffle(nodes.map((_, i) => i), random);
    this.tokens = [];
    for (let i = 0; i < count; i++) {
      const node = free[i];
      const colour = i % m;
      const k = this.slotCircleIndex(node);
      this.tokens.push({ id: i, node, circle: nodes[node].circles[k], colour, dir: random() < 0.5 ? 1 : -1, xs: 1, kicked: 0, blocked: 0, move: null });
    }
    this.occupant = nodes.map(() => null);
    for (const t of this.tokens) this.occupant[t.node] = t;
  }

  // Tells the listener (the sound) about an event; whatever goes wrong there never stops the mechanism.
  emit(type, start, info) {
    try {
      this.onEvent?.(type, start, info);
    } catch (e) {
      console.warn("machine event", type, e);
    }
  }

  // Which of the node's two circles its slot lines up with right now.
  slotCircleIndex(n, t = this.time) {
    const psi = this.psi[n].value(t);
    const a = this.layout.nodes[n].alpha;
    let best = 0;
    for (let k = 1; k < a.length; k++) if (Math.abs(slotTurn(psi, a[k])) < Math.abs(slotTurn(psi, a[best]))) best = k;
    return best;
  }

  // The other circles through a node: one is picked when a token changes circle there.
  others(n, c) {
    return this.layout.nodes[n].circles.filter((k) => k !== c);
  }
  pick(list) {
    return list[Math.floor(this.random() * list.length)];
  }

  owns(token, c) {
    return this.circleColour[c] === token.colour;
  }

  update(dt) {
    this.time += dt;
    for (const f of [...this.plateQueue]) this.popPlate(f);
    this.autoClock -= dt * this.autoRate;
    if (this.autoClock <= 0) {
      this.autoClock = 0.6 + this.random() * 0.8;
      this.autoPop();
    }
    while (this.time >= this.tickStart + this.tickLength) this.tick(this.tickStart + this.tickLength);
  }

  finishMoves() {
    for (const t of this.tokens) {
      if (!t.move) continue;
      t.node = t.move.to;
      t.xs = t.move.arriveXs;
      t.move = null;
    }
    this.occupant.fill(null);
    for (const t of this.tokens) this.occupant[t.node] = t;
  }

  tick(start) {
    this.finishMoves();
    this.tickStart = start;
    const T = this.tickLength;
    const { nodes, circles } = this.layout;

    this.sorted = this.tokens.filter((t) => this.owns(t, t.circle) && !t.kicked).length;
    this.modeTicks++;
    if (this.mode === "sort" && this.sorted === this.tokens.length) {
      this.mode = "orbit";
      this.modeTicks = 0;
      this.emit("sorted", start, {});
    }
    else if (this.mode === "orbit" && this.modeTicks >= ORBIT_TICKS) (this.mode = "scramble"), (this.modeTicks = 0);
    else if (this.mode === "scramble" && this.modeTicks >= SCRAMBLE_TICKS) (this.mode = "sort"), (this.modeTicks = 0);
    else if (this.mode === "sort" && (this.stuck >= 6 || this.modeTicks >= SORT_TICKS)) (this.mode = "scramble"), (this.modeTicks = SCRAMBLE_TICKS - 3), (this.stuck = 0);

    const r0 = start + ROTATE[0] * T, rd = (ROTATE[1] - ROTATE[0]) * T;
    const m0 = start + MOVE[0] * T, md = (MOVE[1] - MOVE[0]) * T;
    for (const n of [...this.forced]) {
      if (this.nodeUnderPlate(n)) continue;
      this.pop(n, start);
      this.forced.delete(n);
    }
    // A popped-out turntable takes no part in this tick.
    const locked = (n) => this.pops[n] && this.pops[n].start + this.pops[n].duration > r0;

    // Desires
    for (const t of this.tokens) {
      const node = nodes[t.node];
      const others = this.others(t.node, t.circle);
      const owned = others.find((k) => this.owns(t, k));
      let c = t.circle, dir = t.dir;
      t.key = this.random();
      if (locked(t.node)) {
        t.want = null;
        continue;
      }
      if (this.mode === "scramble") {
        if (this.random() < 0.45) c = this.pick(others);
        if (this.random() < 0.3) dir = -dir;
      } else if (t.kicked > 0) {
        t.kicked--;
      } else if (this.owns(t, c)) {
        dir = this.circleDir[c];
      } else if (owned !== undefined) {
        c = owned;
        dir = this.circleDir[c];
      }
      if (t.blocked >= 3 && this.mode !== "orbit") {
        if (this.random() < 0.5) dir = -dir;
        if (t.blocked >= 5 && !(this.mode === "sort" && this.owns(t, c)) && this.random() < 0.5) c = this.pick(others);
      }
      t.want = { circle: c, dir, to: node.next[c][dir] };
    }

    // Claims: one token per target node, the longest waiting first.
    const order = this.tokens.filter((t) => t.want).sort((a, b) => b.blocked - a.blocked || a.key - b.key);
    const claimed = new Map();
    const valid = new Set();
    for (const t of order) {
      if (claimed.has(t.want.to) || locked(t.want.to)) continue;
      claimed.set(t.want.to, t);
      valid.add(t);
    }
    // A move needs its target empty or emptied by a token leaving on the same circle; no head-on swaps.
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of valid) {
        const o = this.occupant[t.want.to];
        if (!o) continue;
        if (!valid.has(o) || o.want.circle !== t.want.circle || o.want.to === t.node) {
          valid.delete(t);
          if (o.want?.to === t.node) valid.delete(o);
          changed = true;
        }
      }
    }
    if (valid.size === 0 && this.mode === "sort") this.stuck++;
    else if (valid.size) this.stuck = 0;

    // Turntables: line up for the token on them, or for the one arriving.
    const align = (n, c) => {
      const node = nodes[n];
      const a = node.alpha[node.circles.indexOf(c)];
      const psi = this.psi[n].to;
      const d = slotTurn(psi, a);
      if (Math.abs(d) > 1e-4) {
        this.psi[n].set(this.time, psi + d, r0, rd);
        this.emit("turn", r0, { node: n, angle: d, duration: rd });
      }
    };
    for (const t of this.tokens) {
      if (!t.want) continue;
      align(t.node, t.want.circle);
      t.circle = t.want.circle;
    }
    for (const t of valid) if (!this.occupant[t.want.to]) align(t.want.to, t.want.circle);

    for (const t of this.tokens) {
      const moving = valid.has(t);
      t.blocked = moving ? 0 : t.blocked + 1;
      if (!moving) continue;
      const c = t.want.circle, dir = t.want.dir;
      const from = t.node, to = t.want.to;
      let phiA = this.phi[from][c], phiB = this.phi[to][c];
      if (dir > 0 && phiB <= phiA) phiB += TAU;
      if (dir < 0 && phiB >= phiA) phiB -= TAU;
      // Carriage axis sign relative to the circle's tangent, carried over from the slot it sits in.
      const fromNode = nodes[from], toNode = nodes[to];
      const slotNow = this.slotDir(from, this.psi[from].to);
      const tangentFrom = normalize(cross(circles[c].n, fromNode.p));
      const along = t.xs * Math.sign(dot(slotNow, tangentFrom) || 1);
      const slotTo = this.slotDir(to, this.psi[to].to);
      const tangentTo = normalize(cross(circles[c].n, toNode.p));
      const arriveXs = along * Math.sign(dot(slotTo, tangentTo) || 1);
      t.move = { from, to, circle: c, phiA, phiB, start: m0, duration: md, along, arriveXs };
      this.emit("move", m0, { from, to, duration: md });
      t.dir = dir;
      // Moving a token turns the dials either side of its channel a notch, as if geared to it.
      const edge = this.layout.edges[this.layout.edgeKey.get(`${from}|${to}|${c}`)];
      for (const f of edge?.faces ?? []) {
        const face = this.layout.faces[f];
        const side = Math.sign(dot(face.center, circles[c].n) - circles[c].h);
        // A popped-out dial is clear of the rack, so passing beads don't turn it.
        if (this.dialPops[f]) continue;
        const dial = this.dials[f];
        // A dial still spinning from a click just takes the notch on board.
        if (dial.busy(this.time)) dial.to += side * dir * DIAL_STEP;
        else dial.set(this.time, dial.to + side * dir * DIAL_STEP, m0, md);
        this.emit("notch", m0 + md * 0.85, { face: f });
      }
    }
  }

  // World direction of a node's slot at angle psi (the turntable mesh's local +x).
  slotDir(n, psi) {
    const { x, z } = this.layout.nodes[n].frame;
    return normalize([x[0] * Math.cos(psi) - z[0] * Math.sin(psi), x[1] * Math.cos(psi) - z[1] * Math.sin(psi), x[2] * Math.cos(psi) - z[2] * Math.sin(psi)]);
  }

  // Unit position and carriage axis of a token now.
  tokenPose(t, time = this.time) {
    const m = t.move;
    if (m && time > m.start) {
      const k = clockEase((time - m.start) / m.duration);
      const C = this.layout.circles[m.circle];
      const phi = m.phiA + (m.phiB - m.phiA) * k;
      const p = circlePoint(C, phi);
      return { p, x: scale(normalize(cross(C.n, p)), m.along), lift: 0 };
    }
    const p = this.layout.nodes[t.node].p;
    return { p, x: scale(this.slotDir(t.node, this.psi[t.node].value(time)), t.xs), lift: this.lift(t.node, time) };
  }

  // How far a clicked turntable is popped out, 0 to 1: up with a little overshoot, held while it turns, back down.
  lift(n, time = this.time) {
    return liftOf(this.pops, n, time);
  }

  dialLift(f, time = this.time) {
    return liftOf(this.dialPops, f, time);
  }

  plateLift(f, time = this.time) {
    return liftOf(this.platePops, f, time);
  }

  // A raised plate sweeps over its corner turntables, so neither may pop while the other is up.
  plateBusy(f) {
    return !!this.platePops[f];
  }
  nodeUnderPlate(n) {
    return this.layout.faces.some((face, f) => this.platePops[f] && face.verts.includes(n));
  }

  // Lifts a plate clear of the beads, turns it a full revolution and lets it down. One at a time.
  // Several plates may be up at once as long as their sweeps can't meet.
  popPlate(f) {
    const face = this.layout.faces[f];
    if (this.platePops[f] || this.platePops.some((pop, g) => pop && !this.clear(face, this.layout.faces[g]))) return false;
    if (this.dialPops[f] || face.verts.some((n) => this.pops[n] || this.forced.has(n))) return false;
    this.plateQueue.delete(f);
    const D = PLATE_POP_TIME * this.popScale;
    this.platePops[f] = { start: this.time, duration: D };
    this.emit("pop", this.time, { face: f, kind: "plate", duration: D });
    const turn = this.plateTurn[f];
    // A symmetric plate may turn just part of the way, as long as it seats again: m / k of a turn, m from 1 to k.
    const k = this.plateFold[f];
    const part = (1 + Math.floor(this.random() * k)) / k;
    turn.set(this.time, turn.to + TAU * part * (this.random() < 0.5 ? 1 : -1), this.time + 0.22 * D, 0.54 * D, inOutCubic);
    return true;
  }

  // Two plates turning in the air clear each other when their swept discs don't overlap and they share no corner.
  clear(a, b) {
    if (a === b) return false;
    return angle(a.center, b.center) > a.reach + b.reach && !a.verts.some((n) => b.verts.includes(n));
  }

  // A plate clicked while it can't pop yet goes up as soon as it can.
  queuePlate(f) {
    if (!this.popPlate(f)) this.plateQueue.add(f);
  }

  // Whether anything is out of the sphere (or about to be).
  get popping() {
    return this.pops.some(Boolean) || this.dialPops.some(Boolean) || this.platePops.some(Boolean) || this.forced.size > 0 || this.plateQueue.size > 0;
  }

  autoPop() {
    const r = this.random();
    const faces = this.layout.faces;
    if (r < 0.45) {
      const dials = faces.map((face, f) => f).filter((f) => faces[f].dial && !this.dialPops[f] && !this.platePops[f]);
      if (dials.length) this.popDial(dials[Math.floor(this.random() * dials.length)]);
    } else if (r < 0.82) {
      const nodes = this.layout.nodes.map((_, n) => n).filter((n) => !this.pops[n] && !this.forced.has(n));
      if (nodes.length) this.poke(nodes[Math.floor(this.random() * nodes.length)]);
    } else {
      this.popPlate(Math.floor(this.random() * faces.length));
    }
  }

  // Clicking a turntable pops it out now if it is free this tick, otherwise at the start of the next one.
  poke(n) {
    if (this.pops[n]) return;
    if (this.nodeUnderPlate(n)) return this.forced.add(n);
    const t = this.occupant[n];
    const arriving = this.tokens.some((k) => k.move && k.move.to === n);
    if (arriving || t?.move || this.psi[n].busy(this.time)) this.forced.add(n);
    else this.pop(n, this.time);
  }

  // Pops a turntable out, turns it while it is up (its token onto the other circle), and lets it back in.
  pop(n, start) {
    if (this.pops[n]) return;
    const D = POP_TIME * this.popScale;
    this.pops[n] = { start, duration: D };
    this.emit("pop", start, { node: n, kind: "turntable", duration: D });
    const node = this.layout.nodes[n];
    const t = this.occupant[n];
    const psi = this.psi[n].to;
    // A full revolution: a half turn of the two mirrored halves would look like no turn at all.
    const spin = TAU * (this.random() < 0.5 ? 1 : -1);
    let turn = spin;
    if (t) {
      const other = this.pick(this.others(n, t.circle));
      // Spin the way the slot has to go, so the turn is always more than a full revolution.
      const align = slotTurn(psi, node.alpha[node.circles.indexOf(other)]);
      turn = align + (Math.abs(align) > 1e-6 ? Math.sign(align) * TAU : spin);
      t.circle = other;
      t.kicked = 3;
      t.dir = this.random() < 0.5 ? 1 : -1;
    }
    this.psi[n].set(this.time, psi + turn, start + 0.24 * D, 0.5 * D, inOutCubic);
  }

  // A clicked dial pops out like a turntable and spins a full turn while it is up.
  popDial(f) {
    // A dial rides on its plate, so it stays put while the plate is out (and the other way round).
    if (this.dialPops[f] || this.platePops[f]) return;
    const D = DIAL_POP_TIME * this.popScale;
    this.dialPops[f] = { start: this.time, duration: D };
    this.emit("pop", this.time, { face: f, kind: "dial", duration: D });
    const dial = this.dials[f];
    dial.set(this.time, dial.to + TAU * (this.random() < 0.5 ? 1 : -1), this.time + 0.2 * D, 0.58 * D, inOutCubic);
  }

  // Starts a full scramble.
  scramble() {
    this.mode = "scramble";
    this.modeTicks = 0;
  }
}
