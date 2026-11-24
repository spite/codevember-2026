// What a tattered veil looks like, as two maps over the cloth, made in the veil's worker. Lengths are in cells of the
// cloth (CELLS_SIDE a side); the cloth hangs from the crown, so "down" is away from it.
//
// outline: g is how much of the texel is cloth (holes, ragged hem, loose threads hanging off edges), r how thin it has
// worn (sheer around holes and toward the hem). dirt: what the cloth's colour is multiplied by: an aged tint, grime
// toward the hem and round the holes, water stains with darker tide lines, mildew specks.
import { CELLS_SIDE, tatteredCloth } from "./veil-sim.js";

const TATTER_TEXELS = 16;
const CROWN = [CELLS_SIDE / 2, CELLS_SIDE / 2 - 6];
// How far in from the hem holes, wear and grime reach.
const HOLE_REACH = 13;
const WEAR_REACH = 1.6;
const GRIME_REACH = 16;
// Loose threads hang this far (cells) below edges facing down.
const FRINGE = 2.2;
// Stained and grimy colours, linear-ish sRGB 0..255: a grey-brown grime, a yellow-brown stain.
const GRIME = [92, 84, 72];
const STAIN = [150, 118, 76];
const TIDE = [96, 70, 44];
const AGED = [246, 238, 222];

function hasher(seed) {
  const s = Math.imul(seed + 1, 0x9e3779b1);
  return (x, y) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ s;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

// Value noise in [-1, 1], wrapping in x every `wrap` units when given.
function noiseFn(hash) {
  return (x, y, wrap = 0) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const x0 = wrap ? ((ix % wrap) + wrap) % wrap : ix;
    const x1 = wrap ? (x0 + 1) % wrap : ix + 1;
    const a = hash(x0, iy);
    const b = hash(x1, iy);
    const c = hash(x0, iy + 1);
    const d = hash(x1, iy + 1);
    return (a + (b - a) * u + (c - a + (d - c - b + a) * u) * v) * 2 - 1;
  };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function createTatterData(seed) {
  const T = TATTER_TEXELS;
  const size = CELLS_SIDE * T;
  const n = size * size;
  const noise = noiseFn(hasher(seed));
  const noise2 = noiseFn(hasher(seed + 101));
  const threadHash = hasher(seed + 7);
  // Patterns that hang from the crown: `count` bumps round it (so they meet at the back), `period` cells long.
  const hanging = (turn, along, count, period, layer) => noise(turn * count + layer * 7.3, along / period + layer * 31.7, count + 0);
  const fbm = (x, y) => 0.55 * noise2(x, y) + 0.3 * noise2(x * 2.1 + 5.2, y * 2.1 + 1.3) + 0.15 * noise2(x * 4.3 + 9.1, y * 4.3 + 4.7);

  const edge = new Float32Array(n); // signed distance-ish to the nearest edge of cloth, cells, > 0 inside
  const turnOf = new Float32Array(n);
  const downX = new Float32Array(n);
  const downY = new Float32Array(n);
  const hemOf = new Float32Array(n);
  const insideOf = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cx = (x + 0.5) / T;
      const cy = (y + 0.5) / T;
      const dx = cx - CROWN[0];
      const dy = cy - CROWN[1];
      const along = Math.hypot(dx, dy) || 1e-3;
      const turn = Math.atan2(dx, dy) / (2 * Math.PI) + 0.5;
      turnOf[i] = turn;
      downX[i] = dx / along;
      downY[i] = dy / along;
      // The hem wanders a little, and holes are eaten in toward it: ragged, longer than wide, running down.
      const outlineInside = tatteredCloth(cx, cy, seed);
      insideOf[i] = outlineInside;
      const inside = outlineInside - 0.25 * noise(cx * 1.3, cy * 1.3) - 0.12 * noise(cx * 4.1, cy * 4.1);
      const hem = smooth(HOLE_REACH, 0, inside);
      hemOf[i] = hem;
      const warp = 0.35 * noise2(cx * 0.35, cy * 0.35);
      const eaten = 0.55 * hanging(turn + 0.01 * warp, along, 64, 9, 1) + 0.28 * hanging(turn, along + 2 * warp, 131, 3.5, 2) + 0.17 * hanging(turn, along, 211, 1.1, 3);
      // Higher where the hem is near; a few big rips start further in.
      const rip = hanging(turn, along, 23, 12, 4);
      const level = Math.max(eaten - (0.9 - 0.72 * hem), rip - (1.05 - 0.45 * hem));
      edge[i] = Math.min(inside, -level * 7);
    }
  }

  // Only cloth joined to the crown hangs: islands cut off by holes would float, so they go. What's outside is then
  // measured from the joined cloth alone (chamfer distance), for the loose threads and the wear.
  const joined = new Uint8Array(n);
  const stack = [Math.floor(CROWN[1] * T) * size + Math.floor(CROWN[0] * T)];
  joined[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % size;
    const y = (i - x) / size;
    for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1]) {
      if (j < 0 || joined[j] || edge[j] < 0) continue;
      joined[j] = 1;
      stack.push(j);
    }
  }
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = joined[i] ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - size] + 1);
        if (x > 0) d = Math.min(d, dist[i - size - 1] + D);
        if (x < size - 1) d = Math.min(d, dist[i - size + 1] + D);
      }
      dist[i] = d;
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      let d = dist[i];
      if (x < size - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < size - 1) {
        d = Math.min(d, dist[i + size] + 1);
        if (x < size - 1) d = Math.min(d, dist[i + size + 1] + D);
        if (x > 0) d = Math.min(d, dist[i + size - 1] + D);
      }
      dist[i] = d;
    }
  }
  for (let i = 0; i < n; i++) if (!joined[i]) edge[i] = -dist[i] / T;

  const outline = new Uint8Array(n * 4);
  const dirt = new Uint8Array(n * 4);
  const at = (x, y) => edge[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const e = edge[i];
      const cx = (x + 0.5) / T;
      const cy = (y + 0.5) / T;
      let cloth = 0;
      if (e >= 0) {
        cloth = 1;
      } else if (e > -FRINGE) {
        // Outside an edge: loose threads, only where the edge faces down (they hang from the cloth above them).
        const gx = at(x + 1, y) - at(x - 1, y);
        const gy = at(x, y + 1) - at(x, y - 1);
        const l = Math.hypot(gx, gy) || 1;
        const facing = Math.max(0, -(gx * downX[i] + gy * downY[i]) / l);
        // Fine threads across, each with its own length, a little wavy.
        const along = Math.hypot(cx - CROWN[0], cy - CROWN[1]);
        const across = turnOf[i] * 1100 + 1.4 * noise(cx * 1.7, cy * 1.7) + 0.5 * noise(cx * 6, cy * 6);
        const thread = Math.floor(across);
        const h = threadHash(thread, 0);
        const width = Math.abs(across - thread - 0.5) * 2;
        const length = FRINGE * Math.sqrt(facing) * (0.1 + 0.9 * h ** 3) * (0.6 + 0.4 * noise(thread * 0.37, along * 0.2));
        if (h > 0.4 && width < 0.35 + 0.25 * threadHash(thread, 1) && -e < length) cloth = 1;
      }
      // Worn sheer around every edge, and in patches toward the hem.
      const patches = Math.max(0, fbm(cx * 0.45, cy * 0.45) - 0.15) * hemOf[i] * hemOf[i];
      // Loose threads are whole thread, not gauze, so they show.
      const thin = e < 0 ? 0.15 * cloth : Math.max(0.85 * (1 - smooth(0, WEAR_REACH, e)), Math.min(0.8, patches * 1.6));
      const o = i * 4;
      outline[o] = Math.round(255 * thin);
      outline[o + 1] = outline[o + 2] = cloth * 255;
      outline[o + 3] = 255;

      // Dirt: grime gathers toward the hem and round the edges, in blotches and along the hanging folds.
      const grimeReach = smooth(GRIME_REACH, 0, Math.max(0, insideOf[i]));
      const fromCrown = Math.hypot(cx - CROWN[0], cy - CROWN[1]);
      const nearEdge = 1 - smooth(0, 2.5, Math.max(0, e));
      const blotch = fbm(cx * 0.22 + 3.1, cy * 0.22 + 7.4);
      const streak = noise(turnOf[i] * 260, fromCrown / 6, 260) * smooth(6, 14, fromCrown);
      const grime = e < 0 ? 0.7 : Math.min(1, Math.max(0, 0.75 * grimeReach + 0.45 * nearEdge + 0.35 * blotch + 0.08 * streak * grimeReach - 0.18));
      // Water stains: dried pools, paler inside, with a darker tide line round each.
      const s = fbm(cx * 0.13 + 11.3, cy * 0.13 + 2.9) + 0.06 * noise(cx * 0.8, cy * 0.8) + 0.25 * grimeReach;
      const stain = smooth(0.42, 0.5, s);
      const tide = Math.exp(-(((s - 0.46) / 0.025) ** 2));
      // Mildew: sparse dark specks where it's grimy.
      const speck = Math.max(0, noise(cx * 9, cy * 9) - 0.72) * 4 * grime;
      for (let k = 0; k < 3; k++) {
        let c = AGED[k] + 6 * blotch;
        c += (STAIN[k] - c) * 0.25 * stain;
        c += (TIDE[k] - c) * 0.4 * tide;
        c += (GRIME[k] - c) * 0.85 * grime;
        c *= 1 - 0.6 * Math.min(1, speck);
        dirt[o + k] = Math.round(Math.min(255, Math.max(0, c)));
      }
      dirt[o + 3] = 255;
    }
  }
  // Threads that don't reach the cloth would float too: keep what's joined to the crown (8-connected).
  const kept = new Uint8Array(n);
  const start = Math.floor(CROWN[1] * T) * size + Math.floor(CROWN[0] * T);
  const queue = [start];
  kept[start] = 1;
  while (queue.length) {
    const i = queue.pop();
    const x = i % size;
    for (let dy = -size; dy <= size; dy += size) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy + dx;
        if (j < 0 || j >= n || x + dx < 0 || x + dx >= size || kept[j] || !outline[j * 4 + 1]) continue;
        kept[j] = 1;
        queue.push(j);
      }
    }
  }
  for (let i = 0; i < n; i++) if (!kept[i]) outline[i * 4] = outline[i * 4 + 1] = outline[i * 4 + 2] = 0;
  return { size, outline, dirt };
}

export { createTatterData };
