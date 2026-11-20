// Suspended beach glass physics: weightless drift, soft elastic collisions with spin torque,
// and pointer grab/nudge so pieces can be dragged through each other.
import { Vector3, Quaternion, Color, Mesh } from "three";
import { createGlassPieceSteps, prewarmBaseSpheres } from "./glass.js";
import { nativeRandom } from "modules/random.js";
import { buildShape, sampleShape } from "./collide.js";
import { GLASS_KEYS } from "./render.js";

// Mostly flat slabs and curved shards; the oddities are rare finds. The page's Pieces sliders override these.
export const TYPE_WEIGHTS = {
  pebble: 7, bottle: 5, shard: 5, bowl: 4, fluted: 2,
  marble: 0.35, stopper: 0.3, ring: 0.15, torus: 0.15, rod: 0.25,
};

function pickWeighted(entries, roll) {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let t = roll * total;
  for (const [value, w] of entries) if ((t -= w) < 0) return value;
  return entries[entries.length - 1][0];
}

// Mesh detail per type, relative to the quality tier's: rods and stoppers stretch the base sphere along their length,
// marble veins are fine and thin shells have tight rims, so they need more of it.
const DETAIL_SCALE = { rod: 1.5, stopper: 1.5, marble: 1.5, bottle: 1.4, bowl: 1.4 };

export function prewarmDetail(detail) {
  prewarmBaseSpheres([...new Set([1, ...Object.values(DETAIL_SCALE)].map((k) => Math.round(detail * k)))]);
}

// A palette is a list of colours, or of [colour, weight] pairs to draw by rarity.
export const PALETTES = {
  "Sea glass": [
    ["#e6ece4", 10], ["#8c4c1e", 5], ["#3a9a3e", 7], ["#a6dcc0", 5], ["#aac8e4", 3],
    ["#66cccc", 3], ["#1e8a8c", 2], ["#2440a8", 1.2], ["#a280cc", 0.8], ["#eaaabb", 0.8],
    ["#ecc444", 0.35], ["#d02a22", 0.3], ["#ea6c1c", 0.3],
  ],
  Jewel: [
    "#1048b8", "#1c78e0", "#28b8e0", "#68d6c4", "#24a878",
    "#6cc438", "#e8d618", "#f09418", "#e84820", "#d82048",
    "#9c2c84", "#e8e4dc", "#b4d8cc",
  ],
  Seafoam: [
    "#7ad8c8", "#48b8b0", "#a8e6d8", "#208880", "#d8f0ea",
    "#60a8c8", "#e8e6de", "#3c9870", "#88c8b0",
  ],
  "Cobalt & Amber": [
    "#0c2c78", "#1854c0", "#3888e0", "#d87818", "#f0a828",
    "#8c4410", "#e6e2da", "#287888",
  ],
  Carnelian: [
    "#c81828", "#e84020", "#f08820", "#e8c420", "#b82858",
    "#e090a8", "#782040", "#f0e8e0",
  ],
  Frost: [
    "#eef0ec", "#d0e4dc", "#b8d4e4", "#d8cce0", "#e8dfc8",
    "#a8c8bc", "#c8d0d8",
  ],
};

// A piece's own look: its glass property ranges plus erosion and pattern wear. Pieces keep theirs while a new set
// replaces them one by one; a slider moved by hand sets every piece's target.
export function copyLook(look) {
  return Object.fromEntries(Object.entries(look).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
}

const easeInCubic = (u) => u * u * u;
const easeOutCubic = (u) => 1 - (1 - u) ** 3;

function paletteColor(palette, i, roll) {
  return Array.isArray(palette[0]) ? pickWeighted(palette, roll) : palette[i % palette.length];
}

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces in flight move along their path whatever they hit: infinite mass and inertia in contacts.
const invMass = (p) => (p.anim ? 0 : 1 / p.mass);
const invInertia = (p) => (p.anim ? 0 : p.invInertia);

export class GlassCluster {
  constructor() {
    this.pieces = [];
    this.grabbed = null;
    this.grabTarget = new Vector3();
    this.grabLocal = new Vector3();
    this._gr = new Vector3();
    this._gv = new Vector3();
    this._ga = new Vector3();
    this._tmp = new Vector3();
    this._com = new Vector3();
    this._flow = new Vector3();
    this._vort = new Vector3();
    this._dq = new Quaternion();
    this._axis = new Vector3();
    this._accum = 0;
    this._simTime = 0;
    this.typeWeights = { ...TYPE_WEIGHTS };
    this._pairs = [];
    this._shapeQueue = [];
    this._shapeGen = null;
    this.contacts = new Map();
    this._touch = [];
    for (const k of ["_c", "_rA", "_rB", "_relV", "_w", "_k1", "_k2", "_J", "_t", "_n", "_cp", "_local", "_grad"]) this[k] = new Vector3();
    this._iq = new Quaternion();
    this._sample = { d: 0, gx: 0, gy: 0, gz: 0 };
  }

  // On load: the meshes now, their collision shapes over the next frames (pieces start apart, and one without its shape
  // yet simply doesn't collide).
  build(count, paletteName, seed, detail, look) {
    this._deferShapes = true;
    for (const _ of this.buildSteps(count, paletteName, seed, detail, look));
    this._deferShapes = false;
  }

  // Builds a new set of pieces one per step and swaps it in at the end (used on load).
  *buildSteps(count, paletteName, seed, detail, look) {
    const pieces = [];
    const rng = mulberry32(seed);
    const palette = PALETTES[paletteName] ?? PALETTES["Sea glass"];
    for (let i = 0; i < count; i++) pieces.push(yield* this._pieceSteps(i, count, rng, palette, detail, look));
    for (const p of this.pieces) p.geometry.dispose();
    this.pieces = pieces;
    this.grabbed = null;
  }

  *_pieceSteps(i, count, rng, palette, detail, look) {
    const weights = Object.entries(this.typeWeights).filter(([, w]) => w > 0);
    const type = pickWeighted(weights.length ? weights : Object.entries(TYPE_WEIGHTS), rng());

    const radius = 0.34 + rng() * 0.36;
    const pieceSeed = Math.floor(rng() * 1e6) + i * 97;
    const pieceDetail = Math.round(detail * (DETAIL_SCALE[type] ?? 1));
    const geometry = yield* createGlassPieceSteps({ type, radius, seed: pieceSeed, swirlSeed: i + 1, detail: pieceDetail });

    yield;
    const deferShape = this._deferShapes;
    let shape = null;
    if (!deferShape) shape = yield* buildShape(geometry);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const extents = [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2];
    let reach = 0;
    for (const arr of [geometry.attributes.position.array, geometry.attributes.aRawPos.array]) {
      for (let i = 0; i < arr.length; i += 3) reach = Math.max(reach, Math.hypot(arr[i], arr[i + 1], arr[i + 2]));
    }
    const mass = Math.pow(radius, 3);

    // Golden-angle spherical distribution so pieces start well-spaced in 3D.
    const t = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i + rng() * 0.4;
    const r = 1.05 + Math.pow(rng(), 0.6) * 1.55;

    const pos = new Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.82, r * Math.sin(phi) * Math.sin(theta));
    const vel = new Vector3((rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08);
    const quat = new Quaternion().setFromAxisAngle(
      new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(),
      rng() * Math.PI * 2,
    );
    const angVel = new Vector3((rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2);

    const colorRoll = rng();
    // Where this piece sits inside each glass property's range, from its own stream so the layout stays put
    const glassRng = mulberry32(pieceSeed ^ 0x51ed27);
    const glassRolls = Object.fromEntries(GLASS_KEYS.map((key) => [key, glassRng()]));
    const color = new Color(paletteColor(palette, i, colorRoll));

    const mesh = new Mesh(geometry);
    mesh.position.copy(pos);
    mesh.quaternion.copy(quat);
    mesh.updateMatrixWorld();

    const piece = {
      index: i,
      type,
      radius,
      mass,
      // Scalar rotational inertia of a box with the piece's half-extents
      invInertia: 1 / ((mass * 2 * (extents[0] ** 2 + extents[1] ** 2 + extents[2] ** 2)) / 9),
      collisionRadius: reach + 0.01,
      visualRadius: reach,
      shape,
      // Surface sample points in world space, refreshed each contact iteration
      worldPoints: shape ? new Float32Array(shape.pointsE.length) : null,
      pos,
      prevPos: pos.clone(),
      vel,
      quat,
      prevQuat: quat.clone(),
      angVel,
      color,
      targetColor: color.clone(),
      colorRoll,
      glassRolls,
      look: copyLook(look),
      lookTarget: copyLook(look),
      patternErosion: 1,
      anim: null,
      geometry,
      mesh,
    };
    this._updatePatternErosion(piece);
    if (deferShape) this._shapeQueue.push(piece);
    yield;
    return piece;
  }

  // Replaces the pieces one by one: new ones are generated in the background, then each flies in from off-screen to
  // the place of an old one flying out, both eased. With replaceAll false, only adds or removes pieces to reach count.
  startReplacement({ count, paletteName, seed, detail, look, replaceAll = true, spacing = 0.3 }) {
    const live = this.pieces.filter((p) => p.anim?.mode !== "out");
    const add = replaceAll ? count : Math.max(0, count - live.length);
    const leave = replaceAll ? live.slice() : live.slice(count);
    // Leave in a random order, so the change spreads over the cluster
    for (let i = leave.length - 1; i > 0; i--) {
      const j = Math.floor(nativeRandom() * (i + 1));
      [leave[i], leave[j]] = [leave[j], leave[i]];
    }
    const palette = PALETTES[paletteName] ?? PALETTES["Sea glass"];
    const self = this;
    this._leaveQueue = leave;
    this._ready = [];
    this._spacing = spacing;
    this._launchClock = 0;
    this._gen = (function* () {
      const rng = mulberry32(seed);
      for (let i = 0; i < add; i++) self._ready.push(yield* self._pieceSteps(i, count, rng, palette, detail, look));
    })();
  }

  _stepShapes(budgetMs) {
    const t0 = performance.now();
    while (this._shapeQueue.length && performance.now() - t0 < budgetMs) {
      const p = this._shapeQueue[0];
      this._shapeGen ??= buildShape(p.geometry);
      const step = this._shapeGen.next();
      if (!step.done) continue;
      this._shapeGen = null;
      this._shapeQueue.shift();
      p.shape = step.value;
      p.worldPoints = new Float32Array(p.shape.pointsE.length);
    }
  }

  // A wave sweeps the set away and the backwash brings a new one: every piece leaves along dir (a screen-plane
  // direction), staggered from the leading edge; once they are gone and the new set is generated, the new pieces come
  // back in from the same side to their places, starting in their broken shape and eroding once they land.
  // onSweep("in") fires as the old set goes, onSweep("out") as the new one comes.
  startSweep({ count, paletteName, seed, detail, look, dir, drift = 0.5, erodeTime = 9, hold = 1.5 }) {
    const view = this.view;
    if (!view) return;
    const leaving = this.pieces.filter((p) => p.anim?.mode !== "out");
    const along = (p) => p.pos.dot(dir);
    leaving.sort((a, b) => along(b) - along(a));
    leaving.forEach((p, i) => {
      const delay = (i / Math.max(1, leaving.length)) * 0.8;
      p.anim = { mode: "out", t: -delay, dur: 2.2, from: p.pos.clone(), to: this._offScreen(p.pos, dir, view, p.visualRadius) };
      if (this.grabbed === p) this.grabbed = null;
    });
    // A sweep replaces any one-by-one replacement still under way
    this._gen = null;
    this._ready = this._leaveQueue = null;
    const palette = PALETTES[paletteName] ?? PALETTES["Sea glass"];
    const sweep = { phase: "out", t: 0, dir: dir.clone(), erodeTime, hold, look: copyLook(look), arrivals: [], done: false };
    const self = this;
    sweep.gen = (function* () {
      const rng = mulberry32(seed);
      for (let i = 0; i < count; i++) sweep.arrivals.push(yield* self._pieceSteps(i, count, rng, palette, detail, { ...copyLook(look), erosion: 0 }));
      // Settle the new set on its own, out of sight, so the pieces fly in to places the physics won't push them out of
      const sim = new GlassCluster();
      sim.pieces = sweep.arrivals;
      sim._simTime = self._simTime;
      for (let k = 0; k < 360; k++) {
        sim._step(1 / 120, drift, 1);
        if (k % 12 === 11) yield;
      }
      for (const p of sweep.arrivals) {
        p.vel.set(0, 0, 0);
        p.angVel.multiplyScalar(0.5);
      }
    })();
    this._sweep = sweep;
    this.onSweep?.("in");
  }

  _stepSweep(dt, budgetMs) {
    const sweep = this._sweep;
    if (!sweep) return;
    sweep.t += dt;
    if (sweep.gen) {
      const t0 = performance.now();
      // More time per frame while the old set is leaving, so the new one is generated and settled by the wave out
      while (performance.now() - t0 < Math.max(budgetMs, 8)) {
        const step = sweep.gen.next();
        if (step.done) {
          sweep.gen = null;
          break;
        }
      }
    }
    if (sweep.phase === "out") {
      const gone = !this.pieces.some((p) => p.anim?.mode === "out" || p.anim?.mode === "coast");
      // The backwash of the sweep's wave starts about 2.6 s in
      if (!gone || sweep.gen || sweep.t < 2.6) return;
      sweep.phase = "in";
      const view = this.view;
      // Farthest places first, so later arrivals cross empty space rather than the pieces already landed
      const along = (p) => p.pos.dot(sweep.dir);
      sweep.arrivals.sort((a, b) => along(a) - along(b));
      sweep.arrivals.forEach((p, i) => {
        const delay = (i / Math.max(1, sweep.arrivals.length)) * 0.9;
        const to = p.pos.clone();
        const from = this._offScreen(to, sweep.dir, view, p.visualRadius);
        p.pos.copy(from);
        p.prevPos.copy(from);
        p.vel.set(0, 0, 0);
        p.anim = { mode: "in", t: -delay, dur: 2.4, from, to };
        p.lookTarget.erosion = sweep.look.erosion;
        // Broken pieces rest a beat after landing before the sea starts wearing them down
        p.erode = { t: -(delay + 2.4 + sweep.hold), duration: sweep.erodeTime };
        p.mesh.position.copy(from);
        p.mesh.updateMatrixWorld();
        this.pieces.push(p);
      });
      this.onSweep?.("out");
      return;
    }
    if (!this.pieces.some((p) => p.anim)) this._sweep = null;
  }

  // Pieces wearing down right now: the share of the set, and how far along they are on average (0..1)
  get erosionActivity() {
    let active = 0;
    let progress = 0;
    for (const p of this.pieces) {
      if (!p.erode || p.erode.t < 0) continue;
      active++;
      progress += Math.min(1, p.erode.t / p.erode.duration);
    }
    return { activity: this.pieces.length ? active / this.pieces.length : 0, progress: active ? progress / active : 0 };
  }

  get replacing() {
    return !!(this._sweep || this._gen || this._ready?.length || this._leaveQueue?.length || this.pieces.some((p) => p.anim));
  }

  // Advances generation for up to budgetMs and launches the next pair when its turn comes. view: the camera's position,
  // forward, right and up vectors, tan of half its vertical fov and its aspect, to send pieces fully out of view.
  stepReplacement(dt, budgetMs, view) {
    this.view = view;
    this._stepShapes(budgetMs);
    this._stepSweep(dt, budgetMs);
    if (this._gen) {
      const t0 = performance.now();
      while (performance.now() - t0 < budgetMs) {
        if (this._gen.next().done) {
          this._gen = null;
          break;
        }
      }
    }
    if (!this._ready && !this._leaveQueue) return;
    this._launchClock -= dt;
    if (this._launchClock > 0) return;
    const newcomer = this._ready.shift();
    // Wait for the next new piece unless generation is over and only leavers remain
    if (!newcomer && this._gen) return;
    const leaver = this._leaveQueue.shift();
    if (!newcomer && !leaver) {
      this._ready = this._leaveQueue = null;
      return;
    }
    this._launchClock = this._spacing;

    const slot = new Vector3();
    if (leaver) {
      slot.copy(leaver.pos);
      const dir = this._screenDir(leaver.pos, view) ?? this._randomScreenDir(view);
      leaver.anim = { mode: "out", t: 0, dur: 2.6, from: leaver.pos.clone(), to: this._offScreen(leaver.pos, dir, view, leaver.visualRadius) };
      if (this.grabbed === leaver) this.grabbed = null;
    } else {
      slot.set(nativeRandom() - 0.5, nativeRandom() - 0.5, nativeRandom() - 0.5).multiplyScalar(2.4);
    }
    if (newcomer) {
      const dir = this._randomScreenDir(view);
      const from = this._offScreen(slot, dir, view, newcomer.visualRadius);
      newcomer.pos.copy(from);
      newcomer.prevPos.copy(from);
      newcomer.vel.set(0, 0, 0);
      newcomer.anim = { mode: "in", t: 0, dur: 2.6, from, to: slot.clone() };
      newcomer.mesh.position.copy(from);
      newcomer.mesh.updateMatrixWorld();
      this.pieces.push(newcomer);
    }
  }

  // Where pos sits in the view at its own depth: x and y in camera units, the visible half-width and half-height there.
  _inView(pos, view) {
    const d = this._tmp.subVectors(pos, view.position);
    const depth = Math.max(0.1, d.dot(view.forward));
    const halfH = depth * view.tanHalf;
    return { x: d.dot(view.right), y: d.dot(view.up), halfW: halfH * view.aspect, halfH, depth };
  }

  _visible(p, view) {
    const v = this._inView(p.pos, view);
    const r = p.visualRadius * 1.1;
    return Math.abs(v.x) < v.halfW + r && Math.abs(v.y) < v.halfH + r;
  }

  _screenDir(pos, view) {
    const v = this._inView(pos, view);
    const x = v.x / v.halfW;
    const y = v.y / v.halfH;
    const len = Math.hypot(x, y);
    if (len < 0.05) return null;
    return new Vector3().addScaledVector(view.right, x / len).addScaledVector(view.up, y / len).normalize();
  }

  _randomScreenDir(view) {
    const a = nativeRandom() * Math.PI * 2;
    return new Vector3().addScaledVector(view.right, Math.cos(a)).addScaledVector(view.up, Math.sin(a)).normalize();
  }

  // From pos along dir (in the screen plane, so at constant depth) to past the edge of the view at that depth.
  _offScreen(pos, dir, view, size) {
    const { x: px, y: py, halfW, halfH } = this._inView(pos, view);
    const dx = dir.dot(view.right);
    const dy = dir.dot(view.up);
    const tx = dx > 1e-4 ? (halfW - px) / dx : dx < -1e-4 ? (-halfW - px) / dx : Infinity;
    const ty = dy > 1e-4 ? (halfH - py) / dy : dy < -1e-4 ? (-halfH - py) / dy : Infinity;
    return pos.clone().addScaledVector(dir, Math.max(0, Math.min(tx, ty)) + size * 1.6 + 0.3);
  }

  // Sets the look every piece eases toward (a slider moved by hand).
  setLookTarget(look) {
    for (const p of this.pieces) p.lookTarget = copyLook(look);
    for (const p of this._ready ?? []) p.look = copyLook(look), (p.lookTarget = copyLook(look));
  }

  _updatePatternErosion(p) {
    // Pattern wear 0.5 erodes patterns with the shape; above, they wear away first; below, they outlast it.
    p.patternErosion = Math.pow(p.look.erosion, Math.pow(2, (0.5 - p.look.patternWear) * 4));
  }

  easeLooks(k) {
    for (const p of this.pieces) {
      for (const [key, target] of Object.entries(p.lookTarget)) {
        if (key === "erosion" && p.erode) continue;
        if (Array.isArray(target)) {
          p.look[key][0] += (target[0] - p.look[key][0]) * k;
          p.look[key][1] += (target[1] - p.look[key][1]) * k;
        } else p.look[key] += (target - p.look[key]) * k;
      }
      this._updatePatternErosion(p);
    }
  }

  setPalette(paletteName, snap = false) {
    const palette = PALETTES[paletteName] ?? PALETTES["Sea glass"];
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.targetColor.set(paletteColor(palette, i, p.colorRoll));
      if (snap) p.color.copy(p.targetColor);
    }
  }

  // Holds the piece by the point under the pointer (world space), so dragging it also turns it.
  grab(piece, point) {
    this.grabbed = piece;
    this.grabLocal.subVectors(point, piece.pos).applyQuaternion(this._dq.copy(piece.quat).invert());
    this.grabTarget.copy(point);
  }

  nudge(piece, impulseDir) {
    if (!piece) return;
    piece.vel.addScaledVector(impulseDir, 1.4);
    piece.angVel.x += (nativeRandom() - 0.5) * 3.5;
    piece.angVel.y += (nativeRandom() - 0.5) * 3.5;
    piece.angVel.z += (nativeRandom() - 0.5) * 3.5;
  }

  _step(stepDt, drift, spread) {
    const n = this.pieces.length;
    const tmp = this._tmp;
    this._simTime += stepDt;
    const simT = this._simTime;

    for (let i = 0; i < n; i++) {
      const p = this.pieces[i];
      p.prevPos.copy(p.pos);
      p.prevQuat.copy(p.quat);
    }

    // Pieces flying in or out follow their eased path; they push others aside and are not pushed back.
    for (const p of this.pieces) {
      if (!p.anim) continue;
      if (this.grabbed === p) {
        p.anim = null;
        continue;
      }
      const a = p.anim;
      // Past the end of its path but still in view (the camera moved): keep going until it is out
      if (a.mode === "coast") {
        p.pos.addScaledVector(p.vel, stepDt);
        if (!this.view || !this._visible(p, this.view)) p.removed = true;
        continue;
      }
      a.t += stepDt;
      const u = Math.max(0, Math.min(1, a.t / a.dur));
      const e = a.mode === "in" ? easeOutCubic(u) : easeInCubic(u);
      const de = a.mode === "in" ? 3 * (1 - u) ** 2 : 3 * u * u;
      p.pos.lerpVectors(a.from, a.to, e);
      p.vel.subVectors(a.to, a.from).multiplyScalar(de / a.dur);
      if (u >= 1) {
        if (a.mode === "out") {
          if (this.view && this._visible(p, this.view)) p.anim = { mode: "coast" };
          else p.removed = true;
        } else {
          p.vel.set(0, 0, 0);
          p.anim = null;
        }
      }
    }
    if (this.pieces.some((p) => p.removed)) {
      for (const p of this.pieces) if (p.removed) p.geometry.dispose();
      this.pieces = this.pieces.filter((p) => !p.removed);
    }
    const free = this.pieces.filter((p) => !p.anim);

    // 1. Floating: the shared current, a soft tether around the cluster centre, water drag
    const com = this._com.set(0, 0, 0);
    for (const p of free) com.add(p.pos);
    if (free.length) com.divideScalar(free.length);

    const flow = this._flow;
    const vort = this._vort;

    // Water between pieces: a soft push apart once their bounds overlap, so they keep their distance while drifting
    // and touch only when pressed together.
    const all = this.pieces;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        tmp.subVectors(b.pos, a.pos);
        const reach = (a.visualRadius + b.visualRadius) * 0.6;
        const dSq = tmp.lengthSq();
        if (dSq >= reach * reach || dSq < 1e-8) continue;
        const dist = Math.sqrt(dSq);
        const push = (0.8 * (reach - dist) * stepDt) / dist;
        // Pieces arriving to a settled place neither push nor are pushed
        if (a.anim?.mode === "in" || b.anim?.mode === "in") continue;
        if (!a.anim) a.vel.addScaledVector(tmp, -push / a.mass ** 0.33);
        if (!b.anim) b.vel.addScaledVector(tmp, push / b.mass ** 0.33);
      }
    }

    for (const p of free) {

      // Soft tether to keep the whole cluster centered around the origin
      tmp.subVectors(p.pos, com);
      const d = tmp.length();
      const targetR = 1.9 * spread;
      if (d > 1e-4) {
        // Free drift inside the cluster radius, a spring beyond it
        const pull = d > targetR ? ((d - targetR) * 1.45) / spread : 0;
        p.vel.addScaledVector(tmp, (-pull / d) * stepDt);
      }
      // Also pull cluster centroid gently back toward (0,0,0)
      p.vel.addScaledVector(com, -0.45 * stepDt);

      // A slow, divergence-free current (each component varies only across the others)
      const k = 0.55;
      const px = p.pos.x * k;
      const py = p.pos.y * k;
      const pz = p.pos.z * k;
      const ft = simT * 0.22;
      const A = 0.85 * drift;
      const ax = py * 1.3 + ft, bx = pz * 2.1 - ft * 0.7;
      const ay = pz * 1.2 + ft * 0.85, by = px * 1.9 + ft * 0.6;
      const az = px * 1.4 - ft * 0.9, bz = py * 2.0 + ft * 0.75;
      flow.set(Math.sin(ax) + 0.5 * Math.cos(bx), Math.cos(ay) + 0.5 * Math.sin(by), Math.sin(az) + 0.5 * Math.cos(bz)).multiplyScalar(A);

      // Water drag toward the local current: small pieces follow it faster than big ones
      p.vel.addScaledVector(flow.sub(p.vel), (0.25 * stepDt) / Math.max(p.radius, 0.25));

      // A body in a sheared flow turns at half its vorticity; 4x that, since lopsided pieces also tumble in a current
      vort.set(
        -1.0 * Math.sin(bz) + 1.2 * Math.sin(ay),
        -1.05 * Math.sin(bx) - 1.4 * Math.cos(az),
        0.95 * Math.cos(by) - 1.3 * Math.cos(ax),
      ).multiplyScalar(2.0 * k * A);
      p.angVel.addScaledVector(vort.sub(p.angVel), (0.6 * stepDt) / Math.max(p.radius, 0.25));

      if (this.grabbed === p) {
        // A damped spring on the held point: pulled off-centre, the piece swings round and keeps its spin when let go.
        const r = this._gr.copy(this.grabLocal).applyQuaternion(p.quat);
        const vPoint = this._gv.crossVectors(p.angVel, r).add(p.vel);
        const accel = this._ga.copy(this.grabTarget).sub(p.pos).sub(r).multiplyScalar(18.0).addScaledVector(vPoint, -6.0);
        p.vel.addScaledVector(accel, stepDt);
        p.angVel.addScaledVector(tmp.crossVectors(r, accel), p.mass * p.invInertia * stepDt);
        p.vel.multiplyScalar(Math.exp(-2.0 * stepDt));
        p.angVel.multiplyScalar(Math.exp(-1.5 * stepDt));
      }

      // Light viscous damping so momentum carries through the group
      p.vel.multiplyScalar(Math.exp(-0.95 * stepDt));
      p.angVel.multiplyScalar(Math.exp(-0.95 * stepDt));
    }

    // 2. Integrate tentative positions & orientations
    const axis = this._axis;
    const dq = this._dq;
    for (const p of this.pieces) {
      if (!p.anim) p.pos.addScaledVector(p.vel, stepDt);
      const angSpeed = p.angVel.length();
      if (angSpeed > 1e-5) {
        axis.copy(p.angVel).divideScalar(angSpeed);
        dq.setFromAxisAngle(axis, angSpeed * stepDt);
        p.quat.premultiply(dq).normalize();
      }
    }

    // 3. Contacts (2 iterations) over the pairs whose bounds overlap this step: each piece's surface points against the
    // other's distance field
    const pairs = this._pairs;
    pairs.length = 0;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if ((a.anim && b.anim) || !a.shape || !b.shape || a.anim?.mode === "in" || b.anim?.mode === "in") continue;
        const broad = a.collisionRadius + b.collisionRadius + 0.04;
        if (a.pos.distanceToSquared(b.pos) < broad * broad) pairs.push(a, b);
      }
    }
    if (!pairs.length) return;
    const involved = new Set(pairs);
    for (let iter = 0; iter < 2; iter++) {
      for (const p of involved) this._updateWorldPoints(p);
      let touching = 0;
      for (let k = 0; k < pairs.length; k += 2) {
        // Later iterations only revisit pairs that were in contact
        if (iter > 0 && !this._touch[k]) continue;
        this._touch[k] = this._collidePair(pairs[k], pairs[k + 1], iter) ? 1 : 0;
        touching += this._touch[k];
      }
      if (!touching) break;
    }
  }

  _updateWorldPoints(p) {
    const { pointsE, pointsR } = p.shape;
    const e = p.look.erosion;
    const v = this._tmp;
    const out = p.worldPoints;
    for (let i = 0; i < out.length; i += 3) {
      v.set(pointsR[i] + (pointsE[i] - pointsR[i]) * e, pointsR[i + 1] + (pointsE[i + 1] - pointsR[i + 1]) * e, pointsR[i + 2] + (pointsE[i + 2] - pointsR[i + 2]) * e);
      v.applyQuaternion(p.quat).add(p.pos);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
  }

  // Finds where a and b overlap (surface points inside the other's field), pushes them apart by the deepest reach along
  // the depth-weighted normal, and on the first iteration applies the contact impulse at the weighted contact point.
  _collidePair(a, b, iter) {
    const MARGIN = 0.004;
    const normal = this._n.set(0, 0, 0);
    const point = this._cp.set(0, 0, 0);
    const s = this._sample;
    const local = this._local;
    const grad = this._grad;
    let deepest = 0;
    let weight = 0;
    for (const [P, Q, toward] of [[a, b, -1], [b, a, 1]]) {
      const inv = this._iq.copy(Q.quat).invert();
      const reach2 = (Q.shape.reach + MARGIN) ** 2;
      const w = P.worldPoints;
      for (let i = 0; i < w.length; i += 3) {
        const dx = w[i] - Q.pos.x, dy = w[i + 1] - Q.pos.y, dz = w[i + 2] - Q.pos.z;
        if (dx * dx + dy * dy + dz * dz > reach2) continue;
        local.set(dx, dy, dz).applyQuaternion(inv);
        if (!sampleShape(Q.shape, Q.look.erosion, local.x, local.y, local.z, s) || s.d >= MARGIN) continue;
        const depth = MARGIN - s.d;
        // Q's outward gradient, in world space; the a -> b normal is its opposite when the point is a's
        grad.set(s.gx, s.gy, s.gz).applyQuaternion(Q.quat).normalize();
        normal.addScaledVector(grad, toward * depth);
        point.x += w[i] * depth;
        point.y += w[i + 1] * depth;
        point.z += w[i + 2] * depth;
        weight += depth;
        deepest = Math.max(deepest, depth);
      }
    }
    if (weight === 0 || normal.lengthSq() < 1e-12) return false;
    normal.normalize();
    point.divideScalar(weight);
    const invMa = invMass(a);
    const invMb = invMass(b);
    const invSum = invMa + invMb;
    if (invSum > 0) {
      // Overlaps ease apart (at most 0.004 per step, about half a unit a second) rather than snapping in one step
      const push = Math.min(deepest, 0.004);
      a.pos.addScaledVector(normal, (-push * invMa) / invSum);
      b.pos.addScaledVector(normal, (push * invMb) / invSum);
    }
    if (iter === 0) this._contactImpulse(a, b, point, normal);
    return true;
  }

  _contactImpulse(a, b, c, normal) {
    const rA = this._rA.subVectors(c, a.pos);
    const rB = this._rB.subVectors(c, b.pos);
    const rel = this._relV.crossVectors(b.angVel, rB).add(b.vel).sub(a.vel).sub(this._w.crossVectors(a.angVel, rA));
    const vn = rel.dot(normal);
    this._recordContact(a, b, c, -vn, Math.sqrt(Math.max(0, rel.lengthSq() - vn * vn)));
    if (vn >= 0) return;
    const invMa = invMass(a);
    const invMb = invMass(b);
    const effective = (dir) => {
      const ka = this._k1.crossVectors(rA, dir).lengthSq() * invInertia(a);
      const kb = this._k2.crossVectors(rB, dir).lengthSq() * invInertia(b);
      return invMa + invMb + ka + kb;
    };
    const jn = (-(1 + 0.2) * vn) / effective(normal);
    this._applyImpulse(a, b, rA, rB, this._J.copy(normal).multiplyScalar(jn));

    const tangent = this._t.copy(rel).addScaledVector(normal, -vn);
    const vt = tangent.length();
    if (vt < 1e-6) return;
    tangent.divideScalar(vt);
    const jt = Math.min(vt / effective(tangent), 0.25 * jn);
    this._applyImpulse(a, b, rA, rB, this._J.copy(tangent).multiplyScalar(-jt));
  }

  // Contacts for sound: per pair and step, the hardest approach speed (impact) and the fastest sliding speed.
  _recordContact(a, b, point, impact, slide) {
    const key = a.mesh.id < b.mesh.id ? `${a.mesh.id}:${b.mesh.id}` : `${b.mesh.id}:${a.mesh.id}`;
    const e = this.contacts.get(key);
    if (e) {
      e.impact = Math.max(e.impact, impact);
      e.slide = Math.max(e.slide, slide);
    } else this.contacts.set(key, { a, b, point: point.clone(), impact, slide });
  }

  // The contacts since the last call, then forgets them.
  takeContacts() {
    const list = [...this.contacts.values()];
    this.contacts.clear();
    return list;
  }

  // J acts on b; -J on a.
  _applyImpulse(a, b, rA, rB, J) {
    a.vel.addScaledVector(J, -invMass(a));
    b.vel.addScaledVector(J, invMass(b));
    a.angVel.addScaledVector(this._k1.crossVectors(rA, J), -invInertia(a));
    b.angVel.addScaledVector(this._k1.crossVectors(rB, J), invInertia(b));
  }

  update(dt, wallDt, time, { drift = 0.5, spread = 1.0 } = {}) {
    // Freshly broken pieces erode once they land, in scene time (pausing holds them)
    for (const p of this.pieces) {
      if (!p.erode) continue;
      p.erode.t += dt;
      const u = Math.max(0, Math.min(1, p.erode.t / p.erode.duration));
      p.look.erosion = p.lookTarget.erosion * u * u * (3 - 2 * u);
      this._updatePatternErosion(p);
      if (u >= 1) p.erode = null;
    }
    // Wall-clock color easing so palette changes show while paused.
    const colorAlpha = 1 - Math.exp(-wallDt * 5);
    for (const p of this.pieces) {
      p.color.lerp(p.targetColor, colorAlpha);
    }

    if (dt <= 0) {
      for (const p of this.pieces) {
        p.mesh.position.copy(p.pos);
        p.mesh.quaternion.copy(p.quat);
        p.mesh.updateMatrixWorld();
      }
      return;
    }

    const FIXED_DT = 1 / 120;
    this._accum = Math.min(this._accum + Math.min(dt, 0.05), FIXED_DT * 8);
    while (this._accum >= FIXED_DT) {
      this._step(FIXED_DT, drift, spread);
      this._accum -= FIXED_DT;
    }

    const alpha = this._accum / FIXED_DT;
    for (const p of this.pieces) {
      p.mesh.position.lerpVectors(p.prevPos, p.pos, alpha);
      p.mesh.quaternion.slerpQuaternions(p.prevQuat, p.quat, alpha);
      p.mesh.updateMatrixWorld();
    }
  }
}
