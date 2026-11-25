// The simulation behind the veil: a square of thin cloth as a grid of particles, solved
// with position-based dynamics and colliding with distance fields baked from the skull and
// with itself. It has no dependencies, so it can run in a worker.
//
// Everything is in the skull's own space, in meters. Gravity and the motion of the head are
// passed in, already expressed in that space.

const N = 64; // particles per side
const SIZE = 0.52; // side of the cloth
const CENTER_Z = 0.05; // the cloth sits forward, to hang lower over the face
const START_Y = 0.225;
const PIN_RADIUS = 0.015; // around the crown, at x = z = 0
const SETTLE_STEPS = 20; // the veil lands before it's pinned
const WARM_STEPS = 120; // simulated before it's first shown
// A live drop starts this high, above the frame, and falls onto the head as it's seen; the crown is pinned when it
// lands, and the veil gets its leash once it has had this long to drape.
const DROP_Y = 0.5;
const DROP_SETTLE = 1.6;
// Per step, the share of the way back to the drape a veil is pulled.
const DRAPE_PULL = 0.012;
const OFFSET = 0.006; // the cloth rides this far off the surface, unless told otherwise
const STEP = 1 / 90;
const MAX_STEPS = 3; // per update
const ITERATIONS = 5;
const DAMPING = 0.97;
const MAX_MOVE = 0.012; // per step, so a particle can't jump deep into the skull
const FRICTION = 0.3;
// Stiffness of the links two particles apart, which resist bending.
const BEND = 1;
// And of links four particles apart, from every other particle, which keep folds from
// collapsing flat into a pinch.
const BEND_FAR = 0.4;
const TETHER_SLACK = 1.02;
// Particles this close to the skull at the start of a step collide with it during the step.
const CONTACT_RANGE = 0.045;
const GRAVITY = 9.81;
// Layers of cloth are kept this far apart, so folds stack instead of passing through
// each other.
const SELF_DISTANCE = SIZE / (N - 1);
// Neighbours stretched further apart than this are checked for something caught between.
const SNAG_STRETCH = 2.5;
const SNAG_RANGE = 0.04; // from the skull
const SNAG_LIFT = 0.003; // per step
// Head motion further than this in one update is a jump of the tracker, not something to
// react to.
const MAX_HEAD_MOVE = 0.05;
// The furthest a particle is left behind by the head in one update. Further, and cloth
// in front of the face could end up inside the skull and come out of the other side.
const MAX_LAG = 0.012;
// Three things keep the veil over the face however the head turns. Gravity never leans
// more than this from the skull's own down, in radians, so the cloth can't pour off.
const MAX_GRAVITY_TILT = 0.85;
// And no particle strays further from where it settled than a leash, short at the crown
// and longer toward the hem, which is free to swing.
const LEASH = 0.03;
const LEASH_GROWTH = 0.35;
// Within CROWN_REACH of the crown along the cloth, how far off the skull the cloth may
// lift, beyond its offset: CROWN_LIFT, plus CROWN_LIFT_GROWTH per meter from the crown.
const CROWN_REACH = 0.07;
const CROWN_LIFT = 0.006;
const CROWN_LIFT_GROWTH = 0.15;
// How many times longer the leash and the lag get when the veil is let loose.
const LOOSE_SLACK = 8;
// The surface that's drawn has twice the particles per side.
const SURFACE_SIDE = 2 * N - 1;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// A signed distance field on a grid, positive outside.
class Field {
  constructor(nx, ny, nz, origin, voxel, sd) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.origin = origin;
    this.voxel = voxel;
    this.sd = sd;
  }

  // Trilinear distance at a point, with its gradient written to `grad`. Far from the grid
  // counts as free space.
  sample(px, py, pz, grad) {
    const { nx, ny, nz, voxel, sd, origin } = this;
    const fx = (px - origin[0]) / voxel;
    const fy = (py - origin[1]) / voxel;
    const fz = (pz - origin[2]) / voxel;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) {
      grad[0] = grad[1] = grad[2] = 0;
      return 1;
    }
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const z = Math.floor(fz);
    const tx = fx - x;
    const ty = fy - y;
    const tz = fz - z;
    const a = (z * ny + y) * nx + x;
    const b = a + nx * ny;
    const c000 = sd[a];
    const c100 = sd[a + 1];
    const c010 = sd[a + nx];
    const c110 = sd[a + nx + 1];
    const c001 = sd[b];
    const c101 = sd[b + 1];
    const c011 = sd[b + nx];
    const c111 = sd[b + nx + 1];
    const c00 = c000 + (c100 - c000) * tx;
    const c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx;
    const c11 = c011 + (c111 - c011) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    const dx0 = c100 - c000 + (c110 - c010 - (c100 - c000)) * ty;
    const dx1 = c101 - c001 + (c111 - c011 - (c101 - c001)) * ty;
    grad[0] = (dx0 + (dx1 - dx0) * tz) / voxel;
    grad[1] = (c10 - c00 + (c11 - c01 - (c10 - c00)) * tz) / voxel;
    grad[2] = (c1 - c0) / voxel;
    return c0 + (c1 - c0) * tz;
  }
}

// Loads the fields baked by bake_sdf: the cranium with the upper teeth, then the jaw with
// the lower teeth, both in the skull's rest space.
async function loadFields(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x31464453) throw new Error(`${url} isn't a distance field`);
  const count = view.getUint32(4, true);
  const fields = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    const nx = view.getUint32(offset, true);
    const ny = view.getUint32(offset + 4, true);
    const nz = view.getUint32(offset + 8, true);
    const origin = [
      view.getFloat32(offset + 12, true),
      view.getFloat32(offset + 16, true),
      view.getFloat32(offset + 20, true),
    ];
    const voxel = view.getFloat32(offset + 24, true);
    const min = view.getFloat32(offset + 28, true);
    const max = view.getFloat32(offset + 32, true);
    offset += 36;
    const n = nx * ny * nz;
    const bytes = new Uint8Array(buffer, offset, n);
    const sd = new Float32Array(n);
    for (let j = 0; j < n; j++) sd[j] = min + ((max - min) * bytes[j]) / 255;
    offset += n + ((4 - (n % 4)) % 4);
    fields.push(new Field(nx, ny, nz, origin, voxel, sd));
  }
  return fields;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A tattered veil has its hem cut into spikes all around: notches that are wide at the hem
// and come to a point further in, deepest at the front, where it hangs over the mouth.
// It's the same every time. Lengths here are in cells, of which the cloth has CELLS_SIDE a side.
const CELLS_SIDE = N - 1;
// For each edge (front, back, left, right), its notches: where along it, how deep, how
// wide. Each `seed` gives a different set. Over the mouth they're narrower as well as
// deeper, so the cloth there hangs in thin shreds rather than leaving a window.
const tatterNotches = new Map();
function notchesFor(seed) {
  if (tatterNotches.has(seed)) return tatterNotches.get(seed);
  let state = 2024 + seed * 7919;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const edges = [];
  for (let edge = 0; edge < 4; edge++) {
    const notches = [];
    let at = random() * 2;
    while (at < CELLS_SIDE) {
      const middle = edge === 0 ? Math.max(0, 1 - Math.abs(at + 1.5 - CELLS_SIDE / 2) / 16) : 0;
      const width = (3 + random() * 3.5) * (1 - 0.5 * middle);
      const reach = edge === 0 ? 6 + 5 * middle : 5;
      notches.push({ center: at + width / 2, depth: reach * (0.5 + 0.5 * random()), halfWidth: width * 0.55 });
      at += width;
    }
    edges.push(notches);
  }
  tatterNotches.set(seed, edges);
  return edges;
}

// How far inside the tattered cloth a point is, at (x, y) in cells from the back left
// corner: positive where there's cloth.
function tatteredCloth(x, y, seed = 0) {
  const C = CELLS_SIDE;
  const notches = notchesFor(seed);
  let inside = Infinity;
  const sides = [
    [C - y, x],
    [y, x],
    [x, y],
    [C - x, y],
  ];
  for (let edge = 0; edge < 4; edge++) {
    const [depth, along] = sides[edge];
    let cut = 0;
    for (const notch of notches[edge]) {
      cut = Math.max(cut, notch.depth * (1 - Math.abs(along - notch.center) / notch.halfWidth));
    }
    inside = Math.min(inside, depth - cut);
  }
  return inside;
}

// The cells, between four particles each, that have any of the tattered cloth in them:
// CELLS_SIDE * CELLS_SIDE of them, 1 where there's some.
function tatteredCells(seed = 0) {
  const C = CELLS_SIDE;
  const cells = new Uint8Array(C * C);
  for (let j = 0; j < C; j++) {
    for (let i = 0; i < C; i++) {
      for (let k = 0; k < 9 && !cells[j * C + i]; k++) {
        if (tatteredCloth(i + (k % 3) / 2, j + Math.floor(k / 3) / 2, seed) > 0) cells[j * C + i] = 1;
      }
    }
  }
  // Scraps cut off from the rest are dropped: only what's joined to the crown stays.
  const kept = new Uint8Array(C * C);
  const open = [Math.floor(C / 2) * C + Math.floor(C / 2)];
  kept[open[0]] = 1;
  while (open.length) {
    const c = open.pop();
    const i = c % C;
    for (const n of [i > 0 ? c - 1 : -1, i < C - 1 ? c + 1 : -1, c - C, c + C]) {
      if (n < 0 || n >= C * C || !cells[n] || kept[n]) continue;
      kept[n] = 1;
      open.push(n);
    }
  }
  return kept;
}

class VeilSim {
  // `offset` is how far off the surface the cloth rides, in meters. Heads with sharp
  // features need more, or they show through between particles.
  constructor([cranium, jaw], offset = OFFSET) {
    this.cranium = cranium;
    this.jaw = jaw;
    this.offset = offset;
    // Acceleration of a draft blowing the front of the cloth back onto the face. It's the
    // same everywhere in front, so it presses the cloth on without gathering it anywhere.
    this.draft = 5;
    // A passing gust, as an acceleration in the skull's space (m/s²); it varies over the cloth and in time (see step).
    this.wind = [0, 0, 0];
    this.clock = 0;
    // How much of the head's motion the cloth is left behind by: 0 moves with the head, 1
    // stays where it was.
    this.inertia = 0.6;
    // From 0 to 1, how far the limits that keep the veil over the face are let go: the
    // leash, the cap on its lag and the cone gravity is kept in. At 1 it just hangs. Below
    // 0 the leash is shortened instead, by that fraction, to draw the veil back into place.
    this.loose = 0;

    const count = N * N;
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.prev = new Float32Array(count * 3);
    this.pinned = new Uint8Array(count);
    // Distance from each particle to the crown along the flat cloth.
    this.tether = new Float32Array(count);
    // Where each particle settled when the veil was dropped, and how far it may stray.
    this.rest = new Float32Array(count * 3);
    this.leash = new Float32Array(count);
    this.hasRest = false;
    // The surface near each particle at the start of a step, as a plane.
    this.planeP = new Float32Array(count * 3);
    this.planeN = new Float32Array(count * 3);
    this.planeD = new Float32Array(count);
    this.anchor = [0, 0, 0];
    this.hasAnchor = false;
    // Jaw rest space to skull space, and back, as column-major 4x4 matrices.
    this.jawMatrix = IDENTITY.slice();
    this.jawInverse = IDENTITY.slice();
    this.normal = [0, 0, 0];
    this.gradient = [0, 0, 0];
    this.time = 0;
    this.steps = 0;
    // Bins for self-collision.
    this.cellHead = new Int32Array(0);
    this.cellNext = new Int32Array(count);
    this.cellOf = new Int32Array(count);
    // Scratch for the surface: positions and tangents along the rows.
    this.rowP = new Float32Array(N * SURFACE_SIDE * 3);
    this.rowD = new Float32Array(N * SURFACE_SIDE * 3);

    // Which cells of the grid have cloth: all of them, unless the veil is tattered.
    this.cells = new Uint8Array(CELLS_SIDE * CELLS_SIDE).fill(1);
    // Whether each particle is joined to the next one along its row, and down its column,
    // and whether it's part of no cell at all.
    this.linkH = new Uint8Array(count);
    this.linkV = new Uint8Array(count);
    this.gone = new Uint8Array(count);

    // A live drop is a little askew, a different way each time.
    this.dropTilt = [0, 0];
    this.falling = false;
    this.fallTime = 0;
    this.buildConstraints();
    this.reset();
  }

  // Lets go of the head: nothing holds the cloth any more (for the page to blow it away).
  release() {
    this.pinned.set(this.gone);
    this.hasAnchor = false;
    this.hasRest = false;
    this.falling = false;
  }

  // Whether the patch at the crown has come down onto the skull.
  crownLanded() {
    for (let i = 0; i < this.count; i++) {
      if (this.tether[i] > PIN_RADIUS) continue;
      const o = i * 3;
      if (this.distance(this.pos[o], this.pos[o + 1], this.pos[o + 2]) < this.offset + 0.004) return true;
    }
    return false;
  }

  // Tears the veil to tatters, or makes it whole again, and drops it.
  setTattered(tattered, seed, live = false) {
    if (tattered) this.cells = tatteredCells(seed);
    else this.cells.fill(1);
    this.buildConstraints();
    this.reset(live);
  }

  buildConstraints() {
    const spacing = SIZE / (N - 1);
    const diagonal = spacing * Math.SQRT2;
    const list = [];
    const { cells, linkH, linkV, gone } = this;
    const C = CELLS_SIDE;
    const cell = (i, j) => i >= 0 && j >= 0 && i < C && j < C && cells[j * C + i] === 1;
    // Two particles are joined when there's cloth on either side of the line between them.
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i;
        linkH[a] = cell(i, j - 1) || cell(i, j) ? 1 : 0;
        linkV[a] = cell(i - 1, j) || cell(i, j) ? 1 : 0;
        gone[a] = cell(i - 1, j - 1) || cell(i, j - 1) || cell(i - 1, j) || cell(i, j) ? 0 : 1;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i;
        if (linkH[a]) list.push([a, a + 1, spacing, 1]);
        if (linkV[a]) list.push([a, a + N, spacing, 1]);
        if (cell(i, j)) {
          list.push([a, a + N + 1, diagonal, 1]);
          list.push([a + 1, a + N, diagonal, 1]);
        }
        // Cloth only resists bending where it's whole.
        const across = (n) => {
          for (let k = 0; k < n; k++) if (!linkH[a + k]) return false;
          return true;
        };
        const down = (n) => {
          for (let k = 0; k < n; k++) if (!linkV[a + k * N]) return false;
          return true;
        };
        if (across(2)) list.push([a, a + 2, spacing * 2, BEND]);
        if (down(2)) list.push([a, a + 2 * N, spacing * 2, BEND]);
        if (i % 2 === 0 && across(4)) list.push([a, a + 4, spacing * 4, BEND_FAR]);
        if (j % 2 === 0 && down(4)) list.push([a, a + 4 * N, spacing * 4, BEND_FAR]);
      }
    }
    // Solving in grid order drags the cloth to one side and gathers it into one big fold.
    // A fixed shuffle spreads the error around instead.
    let seed = 12345;
    for (let k = list.length - 1; k > 0; k--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const other = (seed >>> 8) % (k + 1);
      const swap = list[k];
      list[k] = list[other];
      list[other] = swap;
    }
    this.constraintA = new Int32Array(list.length);
    this.constraintB = new Int32Array(list.length);
    this.constraintRest = new Float32Array(list.length);
    this.constraintStiffness = new Float32Array(list.length);
    list.forEach(([a, b, rest, stiffness], k) => {
      this.constraintA[k] = a;
      this.constraintB[k] = b;
      this.constraintRest[k] = rest;
      this.constraintStiffness[k] = stiffness;
    });
  }

  // Lays the cloth flat above the skull and lets it fall and settle, mouth closed and upright. Live, it starts higher,
  // a little askew, and falls as the page watches (see update).
  reset(live = false) {
    const { pos, prev, pinned, tether } = this;
    const spacing = SIZE / (N - 1);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i;
        const x = (i - (N - 1) * 0.5) * spacing;
        const z = CENTER_Z + (j - (N - 1) * 0.5) * spacing;
        pos[a * 3] = x;
        pos[a * 3 + 1] = START_Y;
        pos[a * 3 + 2] = z;
        tether[a] = Math.hypot(x, z);
      }
    }
    prev.set(pos);
    // Particles with no cloth around them stay where they are, out of the way.
    pinned.set(this.gone);
    this.hasAnchor = false;
    this.hasRest = false;
    this.time = 0;
    this.falling = live;
    this.fallTime = 0;
    this.leashBlend = 1;
    const live_ = live;
    const jawMatrix = this.jawMatrix;
    const jawInverse = this.jawInverse;
    this.jawMatrix = IDENTITY;
    this.jawInverse = IDENTITY;
    // Settled in still air: the gust that blew the last veil away is still set until the page sends the next update.
    const wind = this.wind;
    this.wind = [0, 0, 0];
    for (let s = 0; s < WARM_STEPS; s++) {
      if (s === SETTLE_STEPS) this.pin();
      this.step(0, -GRAVITY, 0);
    }
    this.jawMatrix = jawMatrix;
    this.jawInverse = jawInverse;
    this.wind = wind;
    this.rest.set(pos);
    for (let i = 0; i < this.count; i++) this.leash[i] = LEASH + LEASH_GROWTH * tether[i];
    this.hasRest = true;
    if (!live_) return;
    // Live: the drape just worked out is where the leash will ease it once it lands (see update); the cloth itself
    // starts over, high above, and falls as it's seen.
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i;
        const x = (i - (N - 1) * 0.5) * spacing;
        const z = CENTER_Z + (j - (N - 1) * 0.5) * spacing;
        pos[a * 3] = x;
        pos[a * 3 + 1] = DROP_Y + this.dropTilt[0] * x + this.dropTilt[1] * z;
        pos[a * 3 + 2] = z;
      }
    }
    prev.set(pos);
    pinned.set(this.gone);
    this.hasAnchor = false;
    this.hasRest = false;
  }

  // Pins the patch resting on the crown where it is. From then on no particle can be
  // further from it than it is along the flat cloth, which stops the veil from stretching.
  pin() {
    const { pos, pinned, tether, anchor } = this;
    anchor[0] = anchor[1] = anchor[2] = 0;
    let count = 0;
    for (let i = 0; i < this.count; i++) {
      if (tether[i] > PIN_RADIUS) continue;
      pinned[i] = 1;
      anchor[0] += pos[i * 3];
      anchor[1] += pos[i * 3 + 1];
      anchor[2] += pos[i * 3 + 2];
      count++;
    }
    anchor[0] /= count;
    anchor[1] /= count;
    anchor[2] /= count;
    this.hasAnchor = true;
  }

  // Distance from a point to the skull, cranium or jaw, whichever is closer, with the
  // gradient in the skull's space left in this.normal.
  distance(x, y, z) {
    const n = this.normal;
    const g = this.gradient;
    const dc = this.cranium.sample(x, y, z, n);
    const m = this.jawInverse;
    const dj = this.jaw.sample(
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
      g
    );
    if (dj < dc) {
      const r = this.jawMatrix;
      n[0] = r[0] * g[0] + r[4] * g[1] + r[8] * g[2];
      n[1] = r[1] * g[0] + r[5] * g[1] + r[9] * g[2];
      n[2] = r[2] * g[0] + r[6] * g[1] + r[10] * g[2];
      return dj;
    }
    return dc;
  }

  // Pushes particles out of the skull, sampling the fields.
  collide() {
    const { pos, prev, pinned, normal } = this;
    for (let i = 0; i < this.count; i++) {
      if (pinned[i]) continue;
      const o = i * 3;
      const d = this.distance(pos[o], pos[o + 1], pos[o + 2]);
      // Around the crown, where it's pinned, the cloth can't slide when it's pushed back,
      // as when the head looks up. It would buckle and stand up in folds, so there it's
      // also kept from lifting far off the skull.
      const lift = this.offset + CROWN_LIFT + CROWN_LIFT_GROWTH * this.tether[i];
      if (d >= this.offset && (d <= lift || this.tether[i] > CROWN_REACH)) continue;
      const l = Math.hypot(normal[0], normal[1], normal[2]);
      if (l < 1e-6) continue;
      const nx = normal[0] / l;
      const ny = normal[1] / l;
      const nz = normal[2] / l;
      if (d > lift) {
        pos[o] -= nx * (d - lift);
        pos[o + 1] -= ny * (d - lift);
        pos[o + 2] -= nz * (d - lift);
        continue;
      }
      const push = this.offset - d;
      pos[o] += nx * push;
      pos[o + 1] += ny * push;
      pos[o + 2] += nz * push;
      // Friction: lose part of the velocity along the surface.
      const vx = pos[o] - prev[o];
      const vy = pos[o + 1] - prev[o + 1];
      const vz = pos[o + 2] - prev[o + 2];
      const vn = vx * nx + vy * ny + vz * nz;
      prev[o] += (vx - nx * vn) * FRICTION;
      prev[o + 1] += (vy - ny * vn) * FRICTION;
      prev[o + 2] += (vz - nz * vn) * FRICTION;
    }
    // Two neighbours can end up on either side of something thin, an ear or a brow, held
    // apart by it however hard the cloth pulls them together. They give themselves away by
    // being too far apart; lifting both off the skull, from the middle of the gap, takes
    // them over the top to the same side.
    const reach = (SNAG_STRETCH * SELF_DISTANCE) ** 2;
    for (let i = 0; i < this.count; i++) {
      for (const j of [this.linkH[i] ? i + 1 : -1, this.linkV[i] ? i + N : -1]) {
        if (j < 0) continue;
        const a = i * 3;
        const b = j * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (gap * gap < reach) continue;
        const d = this.distance(pos[a] + dx / 2, pos[a + 1] + dy / 2, pos[a + 2] + dz / 2);
        if (d >= SNAG_RANGE) continue;
        const l = Math.hypot(normal[0], normal[1], normal[2]);
        if (l < 1e-6) continue;
        const push = Math.min(SNAG_LIFT, (gap - SELF_DISTANCE) / 2) / l;
        for (const o of [a, b]) {
          if (pinned[o / 3]) continue;
          pos[o] += normal[0] * push;
          pos[o + 1] += normal[1] * push;
          pos[o + 2] += normal[2] * push;
        }
      }
    }
  }

  // Pushes particles out of the half-spaces recorded at the start of the step.
  collidePlanes() {
    const { pos, pinned, planeP, planeN, planeD } = this;
    for (let i = 0; i < this.count; i++) {
      if (pinned[i] || planeD[i] > CONTACT_RANGE) continue;
      const o = i * 3;
      const d =
        planeD[i] +
        planeN[o] * (pos[o] - planeP[o]) +
        planeN[o + 1] * (pos[o + 1] - planeP[o + 1]) +
        planeN[o + 2] * (pos[o + 2] - planeP[o + 2]);
      if (d < this.offset) {
        pos[o] += planeN[o] * (this.offset - d);
        pos[o + 1] += planeN[o + 1] * (this.offset - d);
        pos[o + 2] += planeN[o + 2] * (this.offset - d);
      }
    }
  }

  // Keeps particles that aren't neighbors in the cloth from passing through each other.
  // They're binned in a grid of cells the size of the distance, over the bounds of the
  // cloth, and each looks at the cells around it.
  collideSelf() {
    const { pos, pinned, cellNext, cellOf, count } = this;
    const d = SELF_DISTANCE;
    const inv = 1 / d;
    const d2 = d * d;
    let lx = Infinity;
    let ly = Infinity;
    let lz = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    let hz = -Infinity;
    for (let o = 0; o < count * 3; o += 3) {
      if (pos[o] < lx) lx = pos[o];
      if (pos[o] > hx) hx = pos[o];
      if (pos[o + 1] < ly) ly = pos[o + 1];
      if (pos[o + 1] > hy) hy = pos[o + 1];
      if (pos[o + 2] < lz) lz = pos[o + 2];
      if (pos[o + 2] > hz) hz = pos[o + 2];
    }
    // One empty cell all around, so neighbors never need a bounds check.
    const nx = Math.floor((hx - lx) * inv) + 3;
    const ny = Math.floor((hy - ly) * inv) + 3;
    const nz = Math.floor((hz - lz) * inv) + 3;
    const cells = nx * ny * nz;
    if (this.cellHead.length < cells) this.cellHead = new Int32Array(cells * 2);
    const cellHead = this.cellHead;
    cellHead.fill(-1, 0, cells);
    for (let i = 0; i < count; i++) {
      cellOf[i] = -1;
      if (this.gone[i]) continue;
      const o = i * 3;
      const c =
        (Math.floor((pos[o + 2] - lz) * inv) + 1) * ny * nx +
        (Math.floor((pos[o + 1] - ly) * inv) + 1) * nx +
        Math.floor((pos[o] - lx) * inv) +
        1;
      cellOf[i] = c;
      cellNext[i] = cellHead[c];
      cellHead[c] = i;
    }
    for (let i = 0; i < count; i++) {
      if (cellOf[i] < 0) continue;
      const gi = i % N;
      const gj = (i - gi) / N;
      const oi = i * 3;
      const wa = pinned[i] ? 0 : 1;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const row = cellOf[i] + (dz * ny + dy) * nx;
          for (let c = row - 1; c <= row + 1; c++) {
            for (let j = cellHead[c]; j >= 0; j = cellNext[j]) {
              if (j <= i) continue;
              const hi = j % N;
              const hj = (j - hi) / N;
              if (Math.abs(hi - gi) <= 2 && Math.abs(hj - gj) <= 2) continue;
              const oj = j * 3;
              const vx = pos[oj] - pos[oi];
              const vy = pos[oj + 1] - pos[oi + 1];
              const vz = pos[oj + 2] - pos[oi + 2];
              const l2 = vx * vx + vy * vy + vz * vz;
              if (l2 >= d2 || l2 < 1e-12) continue;
              const wb = pinned[j] ? 0 : 1;
              if (wa + wb === 0) continue;
              const l = Math.sqrt(l2);
              const s = (d - l) / l / (wa + wb);
              pos[oi] -= vx * s * wa;
              pos[oi + 1] -= vy * s * wa;
              pos[oi + 2] -= vz * s * wa;
              pos[oj] += vx * s * wb;
              pos[oj + 1] += vy * s * wb;
              pos[oj + 2] += vz * s * wb;
            }
          }
        }
      }
    }
  }

  // One step of the simulation, under the given gravity.
  step(gx, gy, gz) {
    const { pos, prev, pinned, normal, planeP, planeN, planeD, tether, anchor, draft } = this;
    const h2 = STEP * STEP;

    for (let i = 0; i < this.count; i++) {
      planeD[i] = 1;
      if (pinned[i]) continue;
      const o = i * 3;
      // The gust is patchy: stronger in some places than others, and moving over the cloth.
      const px = pos[o];
      const py = pos[o + 1];
      const pz = pos[o + 2];
      // Mostly the hanging part: the cloth lying on the head is sheltered by it.
      const exposed = smoothstep(0.05, 0.2, this.tether[i]);
      const gust = exposed * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(px * 37 + py * 23 + this.clock * 3.1) * Math.sin(pz * 29 - py * 41 - this.clock * 2.3)));
      const ax = gx + this.wind[0] * gust;
      const ay = gy + this.wind[1] * gust;
      // The draft fades out behind the face.
      const az = gz + this.wind[2] * gust - draft * smoothstep(-0.03, 0.05, pos[o + 2]);
      const d = this.distance(pos[o], pos[o + 1], pos[o + 2]);
      const l = Math.hypot(normal[0], normal[1], normal[2]);
      if (l > 1e-6) {
        const nx = normal[0] / l;
        const ny = normal[1] / l;
        const nz = normal[2] / l;
        planeP[o] = pos[o];
        planeP[o + 1] = pos[o + 1];
        planeP[o + 2] = pos[o + 2];
        planeN[o] = nx;
        planeN[o + 1] = ny;
        planeN[o + 2] = nz;
        planeD[i] = d;
      }
      let vx = (pos[o] - prev[o]) * DAMPING + ax * h2;
      let vy = (pos[o + 1] - prev[o + 1]) * DAMPING + ay * h2;
      let vz = (pos[o + 2] - prev[o + 2]) * DAMPING + az * h2;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > MAX_MOVE) {
        const k = MAX_MOVE / speed;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] += vx;
      pos[o + 1] += vy;
      pos[o + 2] += vz;
    }

    const { constraintA, constraintB, constraintRest, constraintStiffness } = this;
    const constraints = constraintA.length;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let k = 0; k < constraints; k++) {
        const a = constraintA[k];
        const b = constraintB[k];
        const wa = pinned[a] ? 0 : 1;
        const wb = pinned[b] ? 0 : 1;
        if (wa + wb === 0) continue;
        const oa = a * 3;
        const ob = b * 3;
        const dx = pos[ob] - pos[oa];
        const dy = pos[ob + 1] - pos[oa + 1];
        const dz = pos[ob + 2] - pos[oa + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < 1e-9) continue;
        const s = (((l - constraintRest[k]) / l) * constraintStiffness[k]) / (wa + wb);
        pos[oa] += dx * s * wa;
        pos[oa + 1] += dy * s * wa;
        pos[oa + 2] += dz * s * wa;
        pos[ob] -= dx * s * wb;
        pos[ob + 1] -= dy * s * wb;
        pos[ob + 2] -= dz * s * wb;
      }
      if (this.hasAnchor) {
        for (let i = 0; i < this.count; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const dx = pos[o] - anchor[0];
          const dy = pos[o + 1] - anchor[1];
          const dz = pos[o + 2] - anchor[2];
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const reach = tether[i] * TETHER_SLACK;
          if (l > reach) {
            const k = reach / l;
            pos[o] = anchor[0] + dx * k;
            pos[o + 1] = anchor[1] + dy * k;
            pos[o + 2] = anchor[2] + dz * k;
          }
        }
      }
      if (this.hasRest) {
        const { rest, leash } = this;
        const slack = 1 + (this.loose > 0 ? LOOSE_SLACK : 1) * this.loose;
        for (let i = 0; i < this.count; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const dx = pos[o] - rest[o];
          const dy = pos[o + 1] - rest[o + 1];
          const dz = pos[o + 2] - rest[o + 2];
          const l2 = dx * dx + dy * dy + dz * dz;
          const reach = leash[i] * slack * (1 + 6 * (1 - this.leashBlend));
          // A faint pull back to the drape, so a veil a gust or a turn pushed aside works its way back over a few
          // seconds (none while it's let loose).
          if (this.loose <= 0 && it === 0) {
            const k = DRAPE_PULL * this.leashBlend;
            pos[o] -= dx * k;
            pos[o + 1] -= dy * k;
            pos[o + 2] -= dz * k;
          }
          if (l2 > reach * reach) {
            const k = reach / Math.sqrt(l2);
            pos[o] = rest[o] + dx * k;
            pos[o + 1] = rest[o + 1] + dy * k;
            pos[o + 2] = rest[o + 2] + dz * k;
          }
        }
      }
      // Sampling the fields is the expensive part, so between constraint passes the cloth
      // collides with the plane found at each particle at the start of the step.
      if (it < ITERATIONS - 1) {
        this.collidePlanes();
      } else {
        // Folds cross slowly, so every other step is enough to keep them apart.
        if (this.steps++ & 1) this.collideSelf();
        this.collide();
      }
    }
  }

  // Leaves the cloth behind when the head moves. `m` takes a point from the skull's space
  // before the move to its space after, for a point that stayed still in the world.
  applyHeadMotion(m) {
    // Where a point in front of the face, at (0, 0.1, 0.1), ends up tells a tracking jump
    // from a real move.
    const tx = (m[4] + m[8]) * 0.1 + m[12];
    const ty = (m[5] + m[9]) * 0.1 + m[13] - 0.1;
    const tz = (m[6] + m[10]) * 0.1 + m[14] - 0.1;
    if (Math.hypot(tx, ty, tz) > MAX_HEAD_MOVE) return;
    const w = this.inertia;
    const maxLag = MAX_LAG * (1 + LOOSE_SLACK * Math.max(0, this.loose));
    const { pos, prev, pinned } = this;
    for (let i = 0; i < this.count; i++) {
      if (pinned[i]) continue;
      const o = i * 3;
      const x = pos[o];
      const y = pos[o + 1];
      const z = pos[o + 2];
      let dx = w * (m[0] * x + m[4] * y + m[8] * z + m[12] - x);
      let dy = w * (m[1] * x + m[5] * y + m[9] * z + m[13] - y);
      let dz = w * (m[2] * x + m[6] * y + m[10] * z + m[14] - z);
      const l = Math.hypot(dx, dy, dz);
      if (l > maxLag) {
        const k = maxLag / l;
        dx *= k;
        dy *= k;
        dz *= k;
      }
      // The previous position moves the same way, so the velocity carries over.
      pos[o] += dx;
      pos[o + 1] += dy;
      pos[o + 2] += dz;
      prev[o] += dx;
      prev[o + 1] += dy;
      prev[o + 2] += dz;
    }
  }

  // Advances the simulation by `dt` seconds. `gravity` is the direction of down in the
  // skull's space, `jawMatrix` takes the jaw from its rest pose to its current one and
  // `jawInverse` back, as arrays of 16, and `delta`, if given, is the motion of the head
  // since the last update. Returns the number of steps taken.
  update(dt, gravity, jawMatrix, jawInverse, delta) {
    this.jawMatrix = jawMatrix;
    this.jawInverse = jawInverse;
    // Until it has landed, a dropped veil is carried with the head: left behind, it would miss the crown.
    if (delta && !(this.falling && !this.hasAnchor)) this.applyHeadMotion(delta);
    if (this.falling) {
      if (!this.hasAnchor && (this.crownLanded() || this.fallTime > 2)) {
        this.pin();
        this.pinnedAt = this.fallTime;
        // The leash to the drape worked out at the drop comes in loose and tightens as it settles.
        this.hasRest = true;
      }
      if (this.hasAnchor) {
        const t = Math.min(1, (this.fallTime - this.pinnedAt) / DROP_SETTLE);
        this.leashBlend = t * t * (3 - 2 * t);
        // The crown, pinned wherever it landed, slides to where the drape has it, and the tether's anchor with it.
        const { pos, prev, rest, pinned, tether, anchor } = this;
        const k = Math.min(1, dt * 3);
        anchor[0] = anchor[1] = anchor[2] = 0;
        let count = 0;
        for (let i = 0; i < this.count; i++) {
          if (!pinned[i] || tether[i] > PIN_RADIUS) continue;
          const o = i * 3;
          for (let c = 0; c < 3; c++) {
            pos[o + c] += (rest[o + c] - pos[o + c]) * k;
            prev[o + c] = pos[o + c];
            anchor[c] += pos[o + c];
          }
          count++;
        }
        for (let c = 0; c < 3; c++) anchor[c] /= Math.max(1, count);
        if (t >= 1) this.falling = false;
      }
    }
    // Gravity is kept within a cone around the skull's own down; while a dropped veil lands it's the skull's down, so
    // the cloth comes down on the crown however the head is tilted.
    let [gx, gy, gz] = this.falling && !this.hasAnchor ? [0, -1, 0] : gravity;
    const lean = Math.hypot(gx, gz);
    const tilt = MAX_GRAVITY_TILT + (Math.PI - MAX_GRAVITY_TILT) * Math.max(0, this.loose);
    if (-gy < Math.cos(tilt) * Math.hypot(lean, gy)) {
      const k = lean > 1e-6 ? Math.sin(tilt) / lean : 0;
      gx *= k;
      gz *= k;
      gy = -Math.cos(tilt);
    }
    this.time += dt;
    let steps = 0;
    while (this.time >= STEP && steps < MAX_STEPS) {
      this.step(gx * GRAVITY, gy * GRAVITY, gz * GRAVITY);
      this.time -= STEP;
      this.clock += STEP;
      // Timed in the simulation's own steps, which fall behind the page's when it can't keep up.
      if (this.falling) this.fallTime += STEP;
      steps++;
    }
    // If it can't keep up, the cloth runs slow instead of falling further behind.
    if (this.time >= STEP) this.time = 0;
    return steps;
  }

  // Writes the surface to draw: a uniform cubic B-spline through the particles, sampled at
  // each particle and halfway between, with its normals. The spline smooths out the facets
  // of the grid. `positions` and `normals` hold SURFACE_SIDE * SURFACE_SIDE * 3 floats.
  writeSurface(positions, normals) {
    const { pos, rowP, rowD, linkH, linkV, cells } = this;
    const M = SURFACE_SIDE;
    // Along each row of particles: positions and tangents at M samples. The spline stops
    // at the edges of the cloth and at its tears, repeating the last particle.
    for (let j = 0; j < N; j++) {
      for (let s = 0; s < M; s++) {
        const i = s >> 1;
        const a = j * N + i;
        const next = linkH[a] ? a + 1 : a;
        const p0 = (i > 0 && linkH[a - 1] ? a - 1 : a) * 3;
        const p1 = a * 3;
        const p2 = next * 3;
        const p3 = (next > a && linkH[next] ? next + 1 : next) * 3;
        const o = (j * M + s) * 3;
        for (let k = 0; k < 3; k++) {
          if (s & 1) {
            rowP[o + k] = (pos[p0 + k] + 23 * pos[p1 + k] + 23 * pos[p2 + k] + pos[p3 + k]) / 48;
            rowD[o + k] = (-pos[p0 + k] - 5 * pos[p1 + k] + 5 * pos[p2 + k] + pos[p3 + k]) / 8;
          } else {
            rowP[o + k] = (pos[p0 + k] + 4 * pos[p1 + k] + pos[p2 + k]) / 6;
            rowD[o + k] = (pos[p2 + k] - pos[p0 + k]) / 2;
          }
        }
      }
    }
    // Then down each column of samples.
    for (let t = 0; t < M; t++) {
      const j = t >> 1;
      for (let s = 0; s < M; s++) {
        // Whether the cloth carries on from row k to the next, at this sample.
        const joined = (k) =>
          k >= 0 && k < N - 1 && (s & 1 ? cells[k * CELLS_SIDE + (s >> 1)] : linkV[k * N + (s >> 1)]) === 1;
        const after = joined(j) ? j + 1 : j;
        const r0 = (joined(j - 1) ? j - 1 : j) * M;
        const r1 = j * M;
        const r2 = after * M;
        const r3 = (after > j && joined(after) ? after + 1 : after) * M;
        const a = (r0 + s) * 3;
        const b = (r1 + s) * 3;
        const c = (r2 + s) * 3;
        const d = (r3 + s) * 3;
        const o = (t * M + s) * 3;
        let ux;
        let uy;
        let uz;
        let vx;
        let vy;
        let vz;
        if (t & 1) {
          for (let k = 0; k < 3; k++) {
            positions[o + k] = (rowP[a + k] + 23 * rowP[b + k] + 23 * rowP[c + k] + rowP[d + k]) / 48;
          }
          ux = (rowD[a] + 23 * rowD[b] + 23 * rowD[c] + rowD[d]) / 48;
          uy = (rowD[a + 1] + 23 * rowD[b + 1] + 23 * rowD[c + 1] + rowD[d + 1]) / 48;
          uz = (rowD[a + 2] + 23 * rowD[b + 2] + 23 * rowD[c + 2] + rowD[d + 2]) / 48;
          vx = (-rowP[a] - 5 * rowP[b] + 5 * rowP[c] + rowP[d]) / 8;
          vy = (-rowP[a + 1] - 5 * rowP[b + 1] + 5 * rowP[c + 1] + rowP[d + 1]) / 8;
          vz = (-rowP[a + 2] - 5 * rowP[b + 2] + 5 * rowP[c + 2] + rowP[d + 2]) / 8;
        } else {
          for (let k = 0; k < 3; k++) {
            positions[o + k] = (rowP[a + k] + 4 * rowP[b + k] + rowP[c + k]) / 6;
          }
          ux = (rowD[a] + 4 * rowD[b] + rowD[c]) / 6;
          uy = (rowD[a + 1] + 4 * rowD[b + 1] + rowD[c + 1]) / 6;
          uz = (rowD[a + 2] + 4 * rowD[b + 2] + rowD[c + 2]) / 6;
          vx = (rowP[c] - rowP[a]) / 2;
          vy = (rowP[c + 1] - rowP[a + 1]) / 2;
          vz = (rowP[c + 2] - rowP[a + 2]) / 2;
        }
        // The front faces up before the cloth drapes, and out afterwards.
        const nx = vy * uz - vz * uy;
        const ny = vz * ux - vx * uz;
        const nz = vx * uy - vy * ux;
        const l = Math.hypot(nx, ny, nz) || 1;
        normals[o] = nx / l;
        normals[o + 1] = ny / l;
        normals[o + 2] = nz / l;
        // Particles stay off the skull, but the surface between two of them can still cut
        // through a sharp ridge, which would then show in front of the veil. Around a thin
        // part the way out bends, so it's followed in two steps.
        for (let tries = 0; tries < 2; tries++) {
          const gap = this.offset - this.distance(positions[o], positions[o + 1], positions[o + 2]);
          if (gap <= 0) break;
          const g = this.normal;
          const gl = Math.hypot(g[0], g[1], g[2]);
          if (gl < 1e-6) break;
          positions[o] += (g[0] / gl) * gap;
          positions[o + 1] += (g[1] / gl) * gap;
          positions[o + 2] += (g[2] / gl) * gap;
        }
      }
    }
  }
}

export { VeilSim, loadFields, tatteredCells, tatteredCloth, SURFACE_SIDE, CELLS_SIDE };
