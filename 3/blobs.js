import { seededRandom, nativeRandom } from "modules/random.js";
import { createState } from "./surfaceWalk.js";

export const FREE = 0, SEEP = 1, RUN = 2, MERGE = 3, HANG = 4, HELD = 5, HEAL = 6;

const A_MAX = 0.085;
// Pointer blobs stand taller, so a big held blob reads as a dome rather than a swelling.
const A_MAX_USER = 0.12;
// Rest height over radius tends to A_RATIO for big blobs and drops for small ones, so beads never read as pimples.
const A_RATIO = 0.52;
const A_SOFT = 0.03;
// Downhill half-axis over a; matches BLOB_FRONT in field.js.
export const FRONT = 1.1;
// Radius at which weight balances a stick of 1 on a vertical wall.
const DRIVE_A = 0.085;
// Volume of the (1 − s²)² kernel is A·π·a²·(FRONT + tail)·VK.
const VK = 1 / 6;
// Merge once centres are this close relative to a_i + a_j; pull rate per unit overlap before that.
const MERGE_AT = 0.6;
const ATTRACT = 1.5;
const TRAIL_FOLLOW = 0.5;
const SPILL_EVERY = 0.15;
// A merging blob closes its gap to the survivor with this time constant while its volume flows across.
const GLIDE_TAU = 0.2;
const V_MAX = 0.6;
const KN_TAU = 0.1;
// Pointer: a press shorter than TAP_TIME is a tap; a hold grows towards HOLD_A with time constant HOLD_TAU; a tap
// finishes growing over TAP_GROW seconds.
const TAP_TIME = 0.25;
const HOLD_TAU = 1.5;
const TAP_GROW = 0.6;
const HOLD_A = 0.25;
// Volume per second a hold feeds back into a dome its pendant drains.
const HOLD_FEED = 2e-3;
// Fastest a running blob's height may rise, per second.
const A_RATE = 0.6;
// Hanging: smallest dome that grows a pendant, how far it still slides, and how often a site is retried.
const HANG_A = 0.045;
const HANG_SLIDE = 0.3;
const HANG_RETRY = 0.3;

const restHeight = (a, cap = A_MAX) => Math.min((A_RATIO * a * a) / (a + A_SOFT), cap);

export function volumeOf(a, tail = 1, cap = A_MAX) {
  return restHeight(a, cap) * Math.PI * a * a * (FRONT + tail) * VK;
}

// Radius at which the rest height reaches cap.
const capRadius = (cap) => (cap + Math.sqrt(cap * cap + 4 * A_RATIO * cap * A_SOFT)) / (2 * A_RATIO);

// Inverse of volumeOf: a⁴ = W·(a + A_SOFT) by Newton from above below the cap, closed form above it.
export function radiusOf(V, tail = 1, cap = A_MAX) {
  if (V <= 0) return 0;
  const base = Math.PI * (FRONT + tail) * VK;
  const flat = Math.sqrt(V / (cap * base));
  if (flat >= capRadius(cap)) return flat;
  const W = V / (A_RATIO * base);
  let a = Math.cbrt(W) + Math.sqrt(Math.sqrt(W * A_SOFT));
  for (let k = 0; k < 8; k++) a -= (a * a * a * a - W * (a + A_SOFT)) / (4 * a * a * a - W);
  return a;
}

// Largest volume a merged blob grows to.
const V_CAP = volumeOf(0.3);
// Trail thickness over blob height, its cap, and the merge hand-over time.
const TRAIL_K = 0.17;
const TRAIL_MAX = 0.0068;
const MERGE_TAU = 0.2;

function heightOf(V, a, tail) {
  return a > 1e-6 ? V / (Math.PI * a * a * (FRONT + tail) * VK) : 0;
}

const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Seeded 3-D value noise in [0, 1].
function valueNoise(rng) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) (perm[i] = i), (vals[i] = rng());
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const lat = (i, j, k) => vals[perm[perm[perm[i & 255] + (j & 255)] + (k & 255)]];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const u = fade(x - i), v = fade(y - j), w = fade(z - k);
    const a = mix(lat(i, j, k), lat(i + 1, j, k), u), b = mix(lat(i, j + 1, k), lat(i + 1, j + 1, k), u);
    const c = mix(lat(i, j, k + 1), lat(i + 1, j, k + 1), u), d = mix(lat(i, j + 1, k + 1), lat(i + 1, j + 1, k + 1), u);
    return mix(mix(a, b, v), mix(c, d, v), w);
  };
}

// Blob pool (SoA) on the walk mesh: seeping out of the skin, running down the gravity-projected tangent, healing back.
export function createBlobs(walk, { lite = false, maxBlobs = 64, seed = "", trails = null } = {}) {
  const MAXB = maxBlobs;
  const aMin = lite ? 0.09 : 0.06;
  // Phones get fewer, larger blobs so the coat still reads at a small size.
  const aMed = lite ? [0.12, 0.2] : [0.09, 0.18];
  const eyeFloor = lite ? 0.15 : 0.3;
  // Phones favour the key-lit side, where a small bump still catches a highlight.
  const keyFloor = lite ? 0.3 : 0.6;
  const rng = seededRandom(`${seed}:melt:blobs`);
  const pinNoise = valueNoise(rng);
  const meanderNoise = valueNoise(rng);

  const state = new Uint8Array(MAXB);
  const c = new Float32Array(MAXB * 3);
  const n = new Float32Array(MAXB * 3);
  const dir = new Float32Array(MAXB * 3);
  const speed = new Float32Array(MAXB);
  const V = new Float32Array(MAXB);
  const Vgoal = new Float32Array(MAXB);
  const a = new Float32Array(MAXB);
  const A = new Float32Array(MAXB);
  const tail = new Float32Array(MAXB).fill(1);
  // Height cap: A_MAX, or A_MAX_USER for blobs the pointer made or fed.
  const cap = new Float32Array(MAXB).fill(A_MAX);
  const pin = new Float32Array(MAXB);
  const bseed = new Float32Array(MAXB);
  const age = new Float32Array(MAXB);
  const still = new Float32Array(MAXB);
  const stillLimit = new Float32Array(MAXB);
  const healTau = new Float32Array(MAXB);
  const vtx = new Int32Array(MAXB);
  const face = new Int32Array(MAXB);
  const bary = new Float32Array(MAXB * 3);
  const resetPrev = new Uint8Array(MAXB);
  const under = new Float32Array(MAXB);
  const underLimit = new Float32Array(MAXB);
  // Kernel normal: n eased over time, so a blob rounding a sharp tip does not flip its footprint.
  const kn = new Float32Array(MAXB * 3);
  const into = new Int16Array(MAXB);
  // Pointer growth of a HELD blob: 1 while held, 2 while a tap finishes; volume grows from growFrom by growExtra.
  const growMode = new Uint8Array(MAXB);
  const growT = new Float32Array(MAXB);
  const growFrom = new Float32Array(MAXB);
  const growExtra = new Float32Array(MAXB);
  const growDone = new Float32Array(MAXB);
  let hold = -1;
  let holdFresh = false;
  // Tap volume still owed to a blob that a new press took over.
  let holdCarry = 0;
  const trail = new Int16Array(MAXB).fill(-1);
  // Pendant slot of a hanging (or held) blob, and the time until it may try to hang again.
  const pnd = new Int16Array(MAXB).fill(-1);
  const hangT = new Float32Array(MAXB);
  // A blob whose site does not fit a pendant creeps to the lowest vertex nearby (seek ≥ 0) and tries again there.
  const seek = new Int32Array(MAXB).fill(-1);
  let pendants = null;
  // Basin spill: steering direction and the drop to the lowest rim point over a, refreshed every SPILL_EVERY.
  const spill = new Float32Array(MAXB * 3);
  const spillDrop = new Float32Array(MAXB);
  const spillT = new Float32Array(MAXB);
  // State at the start of the last substep, for interpolated packing.
  const prev = { c: new Float32Array(MAXB * 3), n: new Float32Array(MAXB * 3), dir: new Float32Array(MAXB * 3), a: new Float32Array(MAXB), A: new Float32Array(MAXB), tail: new Float32Array(MAXB).fill(1) };
  const view = { c: new Float32Array(MAXB * 3), n: new Float32Array(MAXB * 3), dir: new Float32Array(MAXB * 3), a: new Float32Array(MAXB), A: new Float32Array(MAXB), tail: new Float32Array(MAXB).fill(1) };

  const params = { amount: 0.4, viscosity: 0.5, size: 0.5, dripLength: 0.5 };
  const stats = { alive: 0, target: 0, healing: 0, merging: 0, used: 0, spawned: 0, healed: 0, merges: 0, spills: 0, pressed: 0, fed: 0, healReasons: { rim: 0, small: 0, stuck: 0, under: 0, orphan: 0 }, hanging: 0 };
  // Volume ledger: seeped in = in blobs + laid as trail + healed back + lost (cap, merge tails).
  const ledger = { seeped: 0, trail: 0, healed: 0, lost: 0, blobs: 0 };
  let clock = 0;

  // Area CDF over the walk mesh's faces, plus face normals and the minimum corner rim.
  const { position: pos, index, nf } = walk;
  const cdf = new Float64Array(nf);
  const faceN = new Float32Array(nf * 3);
  const faceRim = new Float32Array(nf);
  let total = 0;
  for (let f = 0; f < nf; f++) {
    const ia = index[f * 3] * 3, ib = index[f * 3 + 1] * 3, ic = index[f * 3 + 2] * 3;
    const ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
    const vx = pos[ic] - pos[ia], vy = pos[ic + 1] - pos[ia + 1], vz = pos[ic + 2] - pos[ia + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz);
    total += 0.5 * l;
    cdf[f] = total;
    if (l > 0) (faceN[f * 3] = cx / l), (faceN[f * 3 + 1] = cy / l), (faceN[f * 3 + 2] = cz / l);
    faceRim[f] = Math.min(walk.rim(index[f * 3]), walk.rim(index[f * 3 + 1]), walk.rim(index[f * 3 + 2]));
  }

  function pickFace() {
    const x = rng() * total;
    let lo = 0, hi = nf - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function gauss(r = rng) {
    return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  }

  const ws = createState();
  const load = (i) => {
    for (let k = 0; k < 3; k++) (ws.p[k] = c[i * 3 + k]), (ws.n[k] = n[i * 3 + k]), (ws.bary[k] = bary[i * 3 + k]);
    ws.vtx = vtx[i];
    ws.face = face[i];
    return ws;
  };
  const store = (i) => {
    for (let k = 0; k < 3; k++) (c[i * 3 + k] = ws.p[k]), (n[i * 3 + k] = ws.n[k]), (bary[i * 3 + k] = ws.bary[k]);
    vtx[i] = ws.vtx;
    face[i] = ws.face;
  };

  // Projects v onto the tangent plane of blob i and normalises it into dir; keeps the old dir if v is tangent-free.
  function setDir(i, vx, vy, vz) {
    const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
    const d = vx * nx + vy * ny + vz * nz;
    vx -= d * nx;
    vy -= d * ny;
    vz -= d * nz;
    let l = Math.hypot(vx, vy, vz);
    if (l < 1e-8) {
      // Any tangent will do.
      vx = dir[i * 3] - n[i * 3] * (dir[i * 3] * nx + dir[i * 3 + 1] * ny + dir[i * 3 + 2] * nz);
      vy = dir[i * 3 + 1] - ny * (dir[i * 3] * nx + dir[i * 3 + 1] * ny + dir[i * 3 + 2] * nz);
      vz = dir[i * 3 + 2] - nz * (dir[i * 3] * nx + dir[i * 3 + 1] * ny + dir[i * 3 + 2] * nz);
      l = Math.hypot(vx, vy, vz);
      if (l < 1e-8) {
        const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = 1 - ax;
        vx = ay * nz;
        vy = -ax * nz;
        vz = ax * ny - ay * nx;
        l = Math.hypot(vx, vy, vz);
      }
    }
    dir[i * 3] = vx / l;
    dir[i * 3 + 1] = vy / l;
    dir[i * 3 + 2] = vz / l;
  }

  function aliveTarget() {
    return Math.round(lite ? mix(8, 36, params.amount) : mix(10, 60, params.amount));
  }

  function spawn(g, eye, key) {
    let slot = -1;
    for (let i = 0; i < MAXB; i++) if (state[i] === FREE) {
      slot = i;
      break;
    }
    if (slot < 0) return false;
    // A few dominant blobs among many small ones.
    const boost = rng() < 0.2 ? 1.6 : 0.95;
    const aGoal = Math.min(0.25, Math.max(aMin, mix(aMed[0], aMed[1], params.size) * boost * Math.exp(0.45 * gauss())));
    for (let attempt = 0; attempt < 5; attempt++) {
      // Area-weighted, favouring faces that look up, slope enough to run, and face the camera and key light.
      let f = -1;
      for (let k = 0; k < 24; k++) {
        const cand = pickFace();
        const fx = faceN[cand * 3], fy = faceN[cand * 3 + 1], fz = faceN[cand * 3 + 2];
        const up = -(fx * g[0] + fy * g[1] + fz * g[2]);
        const toEye = eye ? fx * eye[0] + fy * eye[1] + fz * eye[2] : 1;
        const toKey = key ? fx * key[0] + fy * key[1] + fz * key[2] : 1;
        if (up < -0.5) continue;
        const runnable = 0.2 + 0.8 * smoothstep(0.25, 0.7, Math.sqrt(Math.max(0, 1 - up * up)));
        const w = (0.5 + 0.5 * Math.max(0, up)) * runnable * (eyeFloor + (1 - eyeFloor) * Math.max(0, toEye)) * (keyFloor + (1 - keyFloor) * Math.max(0, toKey));
        if (rng() < w) {
          f = cand;
          break;
        }
      }
      if (f < 0 || faceRim[f] < 1) continue;
      let u = rng(), v = rng();
      if (u + v > 1) (u = 1 - u), (v = 1 - v);
      walk.atFace(f, u, v, ws);
      let clear = true;
      for (let j = 0; j < MAXB && clear; j++) {
        if (state[j] === FREE) continue;
        const d = Math.hypot(ws.p[0] - c[j * 3], ws.p[1] - c[j * 3 + 1], ws.p[2] - c[j * 3 + 2]);
        if (d < (Math.max(a[j], state[j] === SEEP ? radiusOf(Vgoal[j], 1, cap[j]) : 0) + aGoal)) clear = false;
      }
      if (!clear) continue;
      store(slot);
      init(slot, SEEP, g, rng);
      Vgoal[slot] = volumeOf(aGoal);
      stats.spawned++;
      return true;
    }
    return false;
  }

  // Fresh slot at the walk state already stored in it; r draws its per-blob randomness.
  function init(slot, st, g, r) {
    state[slot] = st;
    Vgoal[slot] = 0;
    V[slot] = 0;
    a[slot] = 0;
    A[slot] = 0;
    tail[slot] = 1;
    cap[slot] = A_MAX;
    speed[slot] = 0;
    age[slot] = 0;
    still[slot] = 0;
    pin[slot] = Math.min(1.6, Math.max(0.6, Math.exp(0.3 * gauss(r))));
    bseed[slot] = r() * 100;
    stillLimit[slot] = 3 + 3 * r();
    under[slot] = 0;
    underLimit[slot] = 1.8 + 1.2 * r();
    trail[slot] = -1;
    spillT[slot] = r() * SPILL_EVERY;
    spillDrop[slot] = 0;
    healTau[slot] = 1.5;
    growMode[slot] = 0;
    pnd[slot] = -1;
    hangT[slot] = 0;
    seek[slot] = -1;
    resetPrev[slot] = 1;
    setDir(slot, g[0], g[1], g[2]);
    kn.set(n.subarray(slot * 3, slot * 3 + 3), slot * 3);
    snapshot(slot);
  }

  const lastG = [0, -1, 0];

  // Pointer press at a walk state: feeds the live blob under it, or starts a new one there. Returns the slot or -1.
  function press(hit) {
    if (hold >= 0) cancel();
    let best = -1, bestD = Infinity;
    for (let i = 0; i < MAXB; i++) {
      if (!(state[i] === SEEP || state[i] === RUN || state[i] === HANG || (state[i] === HELD && growMode[i] === 2))) continue;
      const d = Math.hypot(hit.p[0] - c[i * 3], hit.p[1] - c[i * 3 + 1], hit.p[2] - c[i * 3 + 2]);
      if (d < Math.max(a[i], 0.04) && d < bestD) (bestD = d), (best = i);
    }
    let i = best;
    holdFresh = i < 0;
    holdCarry = i >= 0 && state[i] === HELD ? growExtra[i] - growDone[i] : 0;
    if (i < 0) {
      for (let j = 0; j < MAXB; j++) if (state[j] === FREE) {
        i = j;
        break;
      }
      if (i < 0) return -1;
      for (let k = 0; k < 3; k++) (ws.p[k] = hit.p[k]), (ws.n[k] = hit.n[k]), (ws.bary[k] = hit.bary[k]);
      ws.vtx = hit.vtx;
      ws.face = hit.face;
      store(i);
      init(i, HELD, lastG, nativeRandom);
    } else {
      dropTrail(i);
      state[i] = HELD;
      if (pnd[i] >= 0) pendants?.revive(pnd[i]);
      stats.fed++;
    }
    hold = i;
    cap[i] = A_MAX_USER;
    // Blobs the user made last longer before they sink back in.
    stillLimit[i] = Math.max(stillLimit[i], 8 + 4 * nativeRandom());
    underLimit[i] = Math.max(underLimit[i], 5 + 2 * nativeRandom());
    grow(i, 1, volumeOf(HOLD_A, 1, A_MAX_USER) - V[i]);
    stats.pressed++;
    return i;
  }

  function grow(i, mode, extra) {
    growMode[i] = mode;
    growT[i] = 0;
    growFrom[i] = V[i];
    growExtra[i] = Math.max(0, Math.min(V_CAP - V[i], extra));
    growDone[i] = 0;
  }

  // Ends the hold: a tap finishes as a medium blob (or feeds the one under it), a longer hold lets the blob run.
  // A hold that grew nothing (the sim was paused) counts as a tap.
  function release(seconds) {
    const i = hold;
    hold = -1;
    if (i < 0 || state[i] !== HELD) return;
    if (Math.min(seconds ?? growT[i], growT[i]) < TAP_TIME) {
      const tapV = volumeOf(mix(aMed[0], aMed[1], params.size));
      grow(i, 2, holdFresh ? tapV - V[i] : 0.5 * tapV - (V[i] - growFrom[i]) + holdCarry);
    } else toRun(i);
  }

  // The pointer turned the object instead: a new blob sinks back in, a fed one runs on with what it got.
  function cancel() {
    const i = hold;
    hold = -1;
    if (i < 0 || state[i] !== HELD) return;
    if (holdFresh) heal(i, 0.25);
    else if (holdCarry > 0) grow(i, 2, holdCarry);
    else toRun(i);
  }

  // A blob with a pendant goes back to hanging.
  function toRun(i) {
    state[i] = pnd[i] >= 0 ? HANG : RUN;
    growMode[i] = 0;
    still[i] = 0;
    speed[i] = 0;
    under[i] = 0;
  }

  // A pendant is pulled back in first; the blob heals once it is gone.
  function heal(i, tau = 1.1) {
    if (pnd[i] >= 0) {
      pendants.retract(pnd[i], true, "heal");
      state[i] = HANG;
      growMode[i] = 0;
      return;
    }
    state[i] = HEAL;
    healTau[i] = tau;
    dropTrail(i);
  }

  function dropTrail(i) {
    trails?.release(trail[i], i);
    trail[i] = -1;
  }

  // Moves blob i by up to dist towards point (x, y, z) along its tangent plane.
  function moveToward(i, x, y, z, dist) {
    let dx = x - c[i * 3], dy = y - c[i * 3 + 1], dz = z - c[i * 3 + 2];
    const dn = dx * n[i * 3] + dy * n[i * 3 + 1] + dz * n[i * 3 + 2];
    dx -= dn * n[i * 3];
    dy -= dn * n[i * 3 + 1];
    dz -= dn * n[i * 3 + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-7) return;
    const s = Math.min(dist, l) / l;
    walk.move(load(i), dx * s, dy * s, dz * s);
    store(i);
  }

  const mergeable = (st) => st === SEEP || st === RUN || st === HANG || st === HELD;

  // Pairs that touch reach for each other; pairs that overlap enough start a gradual merge into the bigger one.
  function mergePass(h, g) {
    for (let i = 0; i < MAXB; i++) {
      if (!mergeable(state[i])) continue;
      for (let j = i + 1; j < MAXB; j++) {
        if (!mergeable(state[j]) || !mergeable(state[i])) continue;
        const dx = c[j * 3] - c[i * 3], dy = c[j * 3 + 1] - c[i * 3 + 1], dz = c[j * 3 + 2] - c[i * 3 + 2];
        const R = a[i] + a[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) continue;
        if (n[i * 3] * n[j * 3] + n[i * 3 + 1] * n[j * 3 + 1] + n[i * 3 + 2] * n[j * 3 + 2] < 0.5) continue;
        const d = Math.sqrt(d2);
        const hi = state[i] === HELD, hj = state[j] === HELD;
        if (hi && hj) continue;
        if (d < MERGE_AT * R) {
          let v = i, s = j;
          const dv = V[i] - V[j];
          // A held blob always survives, so the pointer keeps its blob.
          if (hi || hj) (v = hi ? j : i), (s = hi ? i : j);
          // A dome with a pendant keeps it: runners that reach it feed the drip.
          else if ((pnd[i] >= 0) !== (pnd[j] >= 0)) (v = pnd[i] >= 0 ? j : i), (s = pnd[i] >= 0 ? i : j);
          else if (Math.abs(dv) < 0.01 * Math.max(V[i], V[j])) {
            // Tie: the higher one flows into the lower.
            if (c[i * 3] * g[0] + c[i * 3 + 1] * g[1] + c[i * 3 + 2] * g[2] > c[j * 3] * g[0] + c[j * 3 + 1] * g[1] + c[j * 3 + 2] * g[2]) (v = j), (s = i);
          } else if (dv > 0) (v = j), (s = i);
          // A hanging victim pulls its pendant back in before it can merge.
          if (pnd[v] >= 0) {
            pendants.retract(pnd[v], false, "merge");
            continue;
          }
          state[v] = MERGE;
          into[v] = s;
          cap[s] = Math.max(cap[s], cap[v]);
          stillLimit[s] = Math.max(stillLimit[s], stillLimit[v]);
          underLimit[s] = Math.max(underLimit[s], underLimit[v]);
          dropTrail(v);
          // The rest of a seeping survivor's volume never arrives; it runs from here.
          if (state[s] === SEEP) state[s] = RUN;
          stats.merges++;
          continue;
        }
        const step = ATTRACT * (R - d) * h;
        if (state[i] !== SEEP && state[i] !== HANG && !hi) moveToward(i, c[j * 3], c[j * 3 + 1], c[j * 3 + 2], step);
        if (state[j] !== SEEP && state[j] !== HANG && !hj) moveToward(j, c[i * 3], c[i * 3 + 1], c[i * 3 + 2], step);
      }
    }
  }

  const _sp = createState();
  // Lowest of 6 rim points at radius a, projected to the surface; steers a blob out of a shallow basin.
  function findSpill(i, g) {
    const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
    const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = 1 - ax;
    let e1x = ay * nz, e1y = -ax * nz, e1z = ax * ny - ay * nx;
    const l = Math.hypot(e1x, e1y, e1z);
    (e1x /= l), (e1y /= l), (e1z /= l);
    const e2x = ny * e1z - nz * e1y, e2y = nz * e1x - nx * e1z, e2z = nx * e1y - ny * e1x;
    const cx = c[i * 3], cy = c[i * 3 + 1], cz = c[i * 3 + 2];
    const h0 = cx * g[0] + cy * g[1] + cz * g[2];
    let best = 0, bx = 0, by = 0, bz = 0;
    for (let k = 0; k < 6; k++) {
      const t = (k * Math.PI) / 3, ct = Math.cos(t) * a[i], st = Math.sin(t) * a[i];
      walk.project(cx + ct * e1x + st * e2x, cy + ct * e1y + st * e2y, cz + ct * e1z + st * e2z, vtx[i], _sp);
      const drop = _sp.p[0] * g[0] + _sp.p[1] * g[1] + _sp.p[2] * g[2] - h0;
      if (drop > best) (best = drop), (bx = _sp.p[0] - cx), (by = _sp.p[1] - cy), (bz = _sp.p[2] - cz);
    }
    if (best > 0.1 * a[i]) {
      const bl = Math.hypot(bx, by, bz);
      spill[i * 3] = bx / bl;
      spill[i * 3 + 1] = by / bl;
      spill[i * 3 + 2] = bz / bl;
      spillDrop[i] = best / a[i];
      stats.spills++;
    } else spillDrop[i] = 0;
  }

  function snapshot(i) {
    for (let k = 0; k < 3; k++) (prev.c[i * 3 + k] = c[i * 3 + k]), (prev.n[i * 3 + k] = kn[i * 3 + k]), (prev.dir[i * 3 + k] = dir[i * 3 + k]);
    prev.a[i] = a[i];
    prev.A[i] = A[i];
    prev.tail[i] = tail[i];
  }

  // State blended between the last two substeps (t in [0, 1]), so the pose moves every frame on fast displays.
  function interpolate(t) {
    for (let i = 0; i < MAXB; i++) {
      if (state[i] === FREE) continue;
      for (let j = i * 3; j < i * 3 + 3; j++) {
        view.c[j] = prev.c[j] + (c[j] - prev.c[j]) * t;
        view.n[j] = prev.n[j] + (kn[j] - prev.n[j]) * t;
        view.dir[j] = prev.dir[j] + (dir[j] - prev.dir[j]) * t;
      }
      view.a[i] = prev.a[i] + (a[i] - prev.a[i]) * t;
      view.A[i] = prev.A[i] + (A[i] - prev.A[i]) * t;
      view.tail[i] = prev.tail[i] + (tail[i] - prev.tail[i]) * t;
    }
    return view;
  }

  const _tp = createState();
  const _tg = [0, 0, 0];
  const _tc = [0, 0, 0];

  function step(h, g, eye, key) {
    clock += h;
    lastG[0] = g[0];
    lastG[1] = g[1];
    lastG[2] = g[2];
    for (let i = 0; i < MAXB; i++) if (state[i] !== FREE) snapshot(i);
    const visc = params.viscosity;
    const vScale = 1.2 * Math.exp(-3 * visc);
    const tauS = mix(0.15, 0.6, visc);
    const Ts = mix(1.2, 2.5, visc);
    const relax = 1 - Math.exp(-h / tauS);
    const relaxGrow = 1 - Math.exp(-h / 0.12);

    // Blobs gathering on the underside count half, so the visible side stays covered.
    let alive = 0;
    for (let i = 0; i < MAXB; i++) if (state[i] === SEEP || state[i] === RUN || state[i] === HANG || state[i] === HELD) alive += under[i] > 0.4 ? 0.5 : 1;
    const N = aliveTarget();
    stats.target = N;
    if (alive < N) {
      // Poisson arrivals at 2·(N − alive) per second.
      const L = Math.exp(-2 * (N - alive) * h);
      let p = rng(), k = 0;
      while (p > L && k < 8) (p *= rng()), k++;
      for (let s = 0; s < k; s++) spawn(g, eye, key);
    }

    let healing = 0, merging = 0, used = 0;
    alive = 0;
    for (let i = 0; i < MAXB; i++) {
      const st = state[i];
      if (st === FREE) continue;
      used++;
      age[i] += h;
      if (st === HEAL) {
        healing++;
        // The height sinks back into the skin faster than the footprint narrows.
        const v0 = V[i];
        A[i] *= Math.exp(-h / healTau[i]);
        a[i] *= Math.exp(-h / (3 * healTau[i]));
        V[i] = A[i] * Math.PI * a[i] * a[i] * (FRONT + tail[i]) * VK;
        speed[i] *= Math.exp(-h / 0.12);
        if (A[i] < 1e-4) {
          state[i] = FREE;
          V[i] = 0;
          A[i] = a[i] = 0;
          stats.healed++;
        }
        ledger.healed += v0 - V[i];
        continue;
      }
      if (st === MERGE) {
        merging++;
        let s = into[i];
        while (state[s] === MERGE && s !== i) s = into[s];
        if (s === i || !(state[s] === RUN || state[s] === HANG || state[s] === SEEP || state[s] === HELD)) {
          heal(i, 0.4);
          stats.healReasons.orphan++;
          continue;
        }
        into[i] = s;
        if (state[s] === SEEP) state[s] = RUN;
        // Volume and momentum flow into the survivor while the victim glides into it.
        const dv = V[i] * (1 - Math.exp(-h / MERGE_TAU));
        V[i] -= dv;
        const Vs = V[s] + dv, kept = Math.min(Vs, V_CAP);
        ledger.lost += Vs - kept;
        speed[s] = (speed[s] * V[s] + speed[i] * dv) / Vs;
        const w = dv / Vs;
        setDir(s, dir[s * 3] * (1 - w) + dir[i * 3] * w, dir[s * 3 + 1] * (1 - w) + dir[i * 3 + 1] * w, dir[s * 3 + 2] * (1 - w) + dir[i * 3 + 2] * w);
        V[s] = kept;
        const gap = Math.hypot(c[s * 3] - c[i * 3], c[s * 3 + 1] - c[i * 3 + 1], c[s * 3 + 2] - c[i * 3 + 2]);
        moveToward(i, c[s * 3], c[s * 3 + 1], c[s * 3 + 2], gap * (1 - Math.exp(-h / GLIDE_TAU)) + speed[s] * h);
        a[i] += (radiusOf(V[i], tail[i], cap[i]) - a[i]) * relax;
        A[i] = Math.min(heightOf(V[i], a[i], tail[i]), cap[i]);
        if (A[i] < 1e-4) {
          ledger.lost += V[i];
          state[i] = FREE;
          V[i] = A[i] = a[i] = 0;
        }
        continue;
      }
      alive++;

      if (st === SEEP) {
        const f = smoothstep(0, Ts, age[i]);
        ledger.seeped += Vgoal[i] * f - V[i];
        V[i] = Vgoal[i] * f;
        // Footprint first, so the dome wells up low instead of as a pimple.
        a[i] = radiusOf(Vgoal[i], tail[i], cap[i]) * (0.6 + 0.4 * f);
        A[i] = heightOf(V[i], a[i], tail[i]);
        if (age[i] >= Ts) state[i] = RUN;
        // Pinned while the dome wells up out of the skin.
        if (age[i] < 0.7 * Ts) continue;
      } else if (st === HELD) {
        // Pinned; a hold wells up out of nothing for the first 80 ms, so a press that turns into a drag shows nothing.
        const t = (growT[i] += h);
        const f = growMode[i] === 1 ? (1 - Math.exp(-t / HOLD_TAU)) * smoothstep(0.08, 0.3, t) : smoothstep(0, TAP_GROW, t);
        const dv = growExtra[i] * f - growDone[i];
        growDone[i] += dv;
        V[i] += dv;
        ledger.seeped += dv;
        const aWas = radiusOf(V[i] - dv, tail[i], cap[i]);
        tail[i] += (1 - tail[i]) * (1 - Math.exp(-h / 0.2));
        const aEq = radiusOf(V[i], tail[i], cap[i]);
        // The footprint keeps up with the pointer's own growth at once, eases after merged volume and never shrinks
        // while held; the height never passes the rest shape's, so feeding never pops up a pimple.
        if (aEq > a[i]) a[i] = Math.min(aEq, Math.max(a[i] + aEq - aWas, a[i] + (aEq - a[i]) * relaxGrow));
        A[i] = Math.min(heightOf(V[i], a[i], tail[i]), restHeight(a[i], cap[i]));
        // The hold tops up what its pendant draws off, so a held underside blob drips like a tap.
        if (pnd[i] >= 0 && growMode[i] === 1) {
          const top = Math.min(growFrom[i] + growDone[i] - V[i], HOLD_FEED * h);
          if (top > 0) {
            V[i] += top;
            ledger.seeped += top;
          }
        }
        speed[i] = 0;
        still[i] = 0;
        // Held on the underside: the pendant grows while the hold keeps the dome topped up.
        if (pendants && pnd[i] < 0 && t > 0.3 && (hangT[i] -= h) <= 0) {
          hangT[i] = HANG_RETRY;
          const pd = n[i * 3] * g[0] + n[i * 3 + 1] * g[1] + n[i * 3 + 2] * g[2];
          if (pd > 0.55 && a[i] > HANG_A) pnd[i] = pendants.create(i, g, nativeRandom);
        }
        if (growMode[i] === 2 && t >= TAP_GROW) toRun(i);
        continue;
      } else {
        // A footprint grows faster than it shrinks, so merged volume spreads instead of piling up.
        const aEq = radiusOf(V[i], tail[i], cap[i]);
        a[i] += (aEq - a[i]) * (aEq > a[i] ? relaxGrow : relax);
        // Capped while the footprint catches up with merged volume, and rate-limited so merges never pop.
        A[i] = Math.min(heightOf(V[i], a[i], tail[i]), cap[i], A[i] + A_RATE * h);
      }

      const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
      const pend = nx * g[0] + ny * g[1] + nz * g[2];
      let gtx = g[0] - nx * pend, gty = g[1] - ny * pend, gtz = g[2] - nz * pend;
      let slope = Math.hypot(gtx, gty, gtz);
      if (slope < 0.15 && st === RUN) {
        spillT[i] -= h;
        if (spillT[i] <= 0) {
          spillT[i] = SPILL_EVERY;
          findSpill(i, g);
        }
        if (spillDrop[i] > 0) {
          // Steers towards the lip and drives as if on the slope down to it.
          const s = Math.max(slope, Math.min(0.5, spillDrop[i]));
          gtx = spill[i * 3] * s;
          gty = spill[i * 3 + 1] * s;
          gtz = spill[i * 3 + 2] * s;
          slope = s;
        }
      } else spillDrop[i] = 0;
      const cx = c[i * 3], cy = c[i * 3 + 1], cz = c[i * 3 + 2];
      // Grip fatigues while a blob sits still, so beads creep on instead of stalling.
      const stick = 0.12 * pin[i] * (0.4 + 1.2 * pinNoise(4 * cx + 17.3, 4 * cy, 4 * cz)) * (1 - 0.6 * smoothstep(0.5, 3, still[i]));
      const drive = (a[i] / DRIVE_A) ** 2 * slope;
      // A hanging blob only creeps, towards a local low point.
      const vT = vScale * Math.max(0, drive - stick) * (st === HANG ? (slope > 0.2 ? HANG_SLIDE : 0) : 1);
      speed[i] += (Math.min(vT, V_MAX) - speed[i]) * (1 - Math.exp(-h / 0.12));

      const t = 0.25 * clock + bseed[i];
      const mx = 2 * meanderNoise(3 * cx + t, 3 * cy, 3 * cz) - 1;
      const my = 2 * meanderNoise(3 * cx, 3 * cy + t + 31.7, 3 * cz) - 1;
      const mz = 2 * meanderNoise(3 * cx, 3 * cy, 3 * cz + t + 63.1) - 1;
      const inv = slope > 1e-4 ? 1 / slope : 0;
      let wx = gtx * inv + 0.2 * mx, wy = gty * inv + 0.2 * my, wz = gtz * inv + 0.2 * mz;
      if (seek[i] >= 0 && st === RUN) {
        const v = seek[i] * 3, P = walk.position;
        const sx = P[v] - cx, sy = P[v + 1] - cy, sz = P[v + 2] - cz;
        const sl = Math.hypot(sx, sy, sz);
        if (sl < 0.004 || pend < 0.55) {
          seek[i] = -1;
          hangT[i] = 0;
        } else {
          (wx = sx / sl), (wy = sy / sl), (wz = sz / sl);
          speed[i] = Math.max(speed[i], Math.min(0.05, sl / h));
        }
      }
      if (trails && speed[i] > 0.01 && seek[i] < 0) {
        // Old channels pull runners in, so later blobs follow earlier paths.
        (_tc[0] = cx), (_tc[1] = cy), (_tc[2] = cz);
        trails.heightAt(_tc, _tg, trail[i], n.subarray(i * 3, i * 3 + 3));
        const gl = Math.hypot(_tg[0], _tg[1], _tg[2]);
        const k = (TRAIL_FOLLOW * Math.min(gl, 1)) / Math.max(gl, 1e-9);
        (wx += _tg[0] * k), (wy += _tg[1] * k), (wz += _tg[2] * k);
      }
      const k = seek[i] >= 0 ? 1 : 1 - Math.exp(-h / 0.08);
      // Downhill turning back on itself (a tip or a trough): brake, so the blob settles instead of orbiting it.
      if (seek[i] < 0 && wx * dir[i * 3] + wy * dir[i * 3 + 1] + wz * dir[i * 3 + 2] < 0) speed[i] *= Math.exp(-h / 0.05);
      setDir(i, dir[i * 3] + (wx - dir[i * 3]) * k, dir[i * 3 + 1] + (wy - dir[i * 3 + 1]) * k, dir[i * 3 + 2] + (wz - dir[i * 3 + 2]) * k);

      const tailGoal = 1 + (2 * speed[i]) / (speed[i] + 0.12);
      tail[i] = Math.min(3, Math.max(1, tail[i] + (tailGoal - tail[i]) * (1 - Math.exp(-h / 0.2))));

      if (speed[i] > 1e-5) {
        const s = speed[i] * h;
        walk.move(load(i), dir[i * 3] * s, dir[i * 3 + 1] * s, dir[i * 3 + 2] * s);
        // Speed is what the blob actually covered, so a blob jammed in a tip or crease reads as still.
        const moved = Math.hypot(ws.p[0] - cx, ws.p[1] - cy, ws.p[2] - cz) / h;
        speed[i] = Math.min(speed[i], 1.05 * moved + 0.005);
        store(i);
        setDir(i, dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]);
      }
      still[i] = speed[i] < 0.01 ? still[i] + h : 0;
      under[i] = pend > 0.6 ? under[i] + h : 0;

      if (trails && speed[i] > 0.01 && st === RUN) {
        // The trail leaves from the blob's tail end and costs the blob its volume.
        const back = 0.5 * a[i] * tail[i];
        walk.project(c[i * 3] - dir[i * 3] * back, c[i * 3 + 1] - dir[i * 3 + 1] * back, c[i * 3 + 2] - dir[i * 3 + 2] * back, vtx[i], _tp);
        const t0 = Math.min(TRAIL_K * A[i], TRAIL_MAX);
        trail[i] = trails.extend(trail[i], i, _tp.p[0], _tp.p[1], _tp.p[2], t0, Math.max(0.05, 0.9 * a[i]));
        if (trail[i] >= 0) {
          const cost = Math.min(V[i], trails.section(t0) * speed[i] * h);
          V[i] -= cost;
          ledger.trail += cost;
        }
      }

      if (state[i] === HANG) {
        if (pend < 0.3) pendants.retract(pnd[i], false, "turned");
        continue;
      }
      if (state[i] !== RUN) continue;
      // Gathered on the underside: hang. Sites that do not fit a pendant gather, then sink back in.
      if (pendants && seek[i] < 0 && (hangT[i] -= h) <= 0 && pend > 0.55 && (speed[i] < 0.03 || pend > 0.8) && a[i] > HANG_A && (under[i] > 0.4 || still[i] > 0.3)) {
        hangT[i] = HANG_RETRY;
        const p = pendants.create(i, g);
        if (p >= 0) {
          state[i] = HANG;
          pnd[i] = p;
          speed[i] = 0;
          dropTrail(i);
          continue;
        }
        if (pendants.lastReject === "fit") {
          const v = walk.lowest(load(i), g, a[i]);
          const P = walk.position;
          if (Math.hypot(P[v * 3] - c[i * 3], P[v * 3 + 1] - c[i * 3 + 1], P[v * 3 + 2] - c[i * 3 + 2]) > 0.006) seek[i] = v;
        }
      }
      // A growing tail lowers a_eq, hence the 0.8.
      const stuckAfter = stillLimit[i] * (slope < 0.35 ? 0.5 : 1);
      const why = walk.rim(vtx[i]) < 0.5 ? "rim" : a[i] < 0.8 * aMin ? "small" : still[i] > stuckAfter && pend < 0.55 ? "stuck" : under[i] > underLimit[i] || (still[i] > 2 && pend >= 0.55) ? "under" : null;
      if (why) {
        heal(i);
        stats.healReasons[why]++;
      }
    }
    mergePass(h, g);
    const kk = 1 - Math.exp(-h / KN_TAU);
    for (let i = 0; i < MAXB; i++) {
      if (state[i] === FREE) continue;
      const o = i * 3;
      const x = kn[o] + (n[o] - kn[o]) * kk, y = kn[o + 1] + (n[o + 1] - kn[o + 1]) * kk, z = kn[o + 2] + (n[o + 2] - kn[o + 2]) * kk;
      const l = 1 / Math.max(Math.hypot(x, y, z), 1e-9);
      (kn[o] = x * l), (kn[o + 1] = y * l), (kn[o + 2] = z * l);
    }
    let vb = 0, hanging = 0;
    for (let i = 0; i < MAXB; i++) (vb += V[i]), (hanging += pnd[i] >= 0);
    stats.hanging = hanging;
    ledger.blobs = vb;
    stats.alive = alive;
    stats.healing = healing;
    stats.merging = merging;
    stats.used = used;
  }

  function reset() {
    hold = -1;
    pnd.fill(-1);
    cap.fill(A_MAX);
    growMode.fill(0);
    state.fill(FREE);
    trail.fill(-1);
    V.fill(0);
    a.fill(0);
    A.fill(0);
    speed.fill(0);
    prev.a.fill(0);
    prev.A.fill(0);
    resetPrev.fill(1);
  }

  return {
    MAXB,
    state,
    c,
    n,
    dir,
    speed,
    V,
    a,
    A,
    tail,
    resetPrev,
    params,
    stats,
    ledger,
    step,
    interpolate,
    reset,
    press,
    release,
    cancel,
    get hold() {
      return hold;
    },
    pnd,
    setPendants(p) {
      pendants = p;
    },
    walkState(i, out) {
      for (let k = 0; k < 3; k++) (out.p[k] = c[i * 3 + k]), (out.n[k] = n[i * 3 + k]), (out.bary[k] = bary[i * 3 + k]);
      out.vtx = vtx[i];
      out.face = face[i];
      return out;
    },
    isHeld: (i) => state[i] === HELD,
    // A pendant has gone back into blob i: it runs on (or sinks in, when heal), or stays held.
    pendantFreed(i, healAfter) {
      pnd[i] = -1;
      hangT[i] = 1;
      if (state[i] !== HANG) return;
      if (healAfter) {
        heal(i);
        stats.healReasons.under++;
      } else toRun(i);
    },
    seed,
  };
}
