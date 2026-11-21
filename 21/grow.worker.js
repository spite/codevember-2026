// Grows the figure the discharge leaves in the glass, off the main thread. The charge the discharge is after is
// scattered evenly through the object, a point every `spacing` or so; the tree starts where the bolt entered and
// grows a short step at a time toward the points near it (each point pulls the node nearest to it), and a point is
// spent once a branch comes within reach of it. So the tree stops when it has been everywhere, and its branches end up
// about a spacing apart wherever they are: the whole volume, with clear glass between. (Space colonisation, Runions
// et al.; the dielectric breakdown model this replaced filled whatever was nearest and stopped.)
// The tree is then drawn into a T³ texture as the distance to the channels' walls, with hairline cracks raked off
// every piece, which is the feathering. Both stop at a deadline, since the bolt is waiting.
import { EXTENT, CELL, sample } from "./shapes.js";
import { BAND } from "./band.js";

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How far a step of the tree is, in the object's units.
const STEP = 0.034;
// How strongly growth is pushed away from the entry, against the pull of the charge.
const FAN = 0.7;

// branches: how many points of charge the object holds, which is about how many branches it ends up with. wander: how much each step strays from where it is pulled.
// budget: how long the growth may take, in ms; drawing the hairs stops at half as much again.
function grow({ grid, entry, normal, seed, branches, wander, T, budget = 2000 }) {
  const start = performance.now();
  const random = mulberry32(seed);
  const h = STEP;
  const inside = (x, y, z, margin) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) < EXTENT - 0.03 && sample(grid, x, y, z) < -margin;

  // As many points in a small object as in a large one, so one is no busier than the other: the spacing follows
  // from the volume.
  let cells = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] < 0) cells++;
  const spacing = Math.cbrt((cells * CELL ** 3) / branches);

  // The charge: a point in every cell of a grid of the spacing, anywhere in the cell, if that is well inside the glass.
  // It comes in two lots. A sparse one first, which draws a few long fronds right across the object; then, once
  // those are grown, a fine one, which they answer with side branches all along their length. That order is what
  // gives a figure its hierarchy, and the hierarchy is what keeps a dense one legible.
  const charge = [], nearest = [], nearestD = [], spent = [];
  const position = [], parent = [], children = [];
  let reach = 0;
  const scatter = (gap) => {
    reach = gap * 0.75;
    for (let z = -EXTENT; z < EXTENT; z += gap)
      for (let y = -EXTENT; y < EXTENT; y += gap)
        for (let x = -EXTENT; x < EXTENT; x += gap) {
          const px = x + random() * gap, py = y + random() * gap, pz = z + random() * gap;
          // Well inside where the glass is thick, and anywhere inside where it is thin (an ear), so thin parts get some.
          const depth = -sample(grid, px, py, pz);
          if (depth < 0.006 || (depth < 0.05 && random() < 0.5)) continue;
          // The node nearest to it so far; none, if a branch is already within reach.
          let best = Infinity, at = 0;
          for (let i = 0; i < parent.length; i++) {
            const d = Math.hypot(px - position[i * 3], py - position[i * 3 + 1], pz - position[i * 3 + 2]);
            if (d < best) (best = d), (at = i);
          }
          if (best < reach) continue;
          charge.push(px, py, pz);
          nearest.push(at);
          nearestD.push(best);
          spent.push(0);
        }
  };
  const add = (x, y, z, from) => {
    const i = parent.length;
    position.push(x, y, z);
    parent.push(from);
    children.push(0);
    if (from >= 0) children[from]++;
    for (let p = 0; p < spent.length; p++) {
      if (spent[p]) continue;
      const d = Math.hypot(charge[p * 3] - x, charge[p * 3 + 1] - y, charge[p * 3 + 2] - z);
      if (d < reach) spent[p] = 1;
      else if (d < nearestD[p]) (nearestD[p] = d), (nearest[p] = i);
    }
    return i;
  };
  // The first node: in from where the bolt hit, until inside.
  let rx = entry[0], ry = entry[1], rz = entry[2];
  for (let k = 0; k < 20 && !inside(rx, ry, rz, 0.01); k++) (rx -= normal[0] * 0.01), (ry -= normal[1] * 0.01), (rz -= normal[2] * 0.01);
  add(rx, ry, rz, -1);

  const pull = new Map();
  let primary = 0;
  for (const gap of [spacing * 2.6, spacing]) {
    scatter(gap);
    for (let round = 0; round < 400 && parent.length < 9000; round++) {
      if (performance.now() - start > budget) break;
      // Every point left pulls its nearest node toward itself.
      pull.clear();
      for (let p = 0; p < spent.length; p++) {
        if (spent[p]) continue;
        const n = nearest[p];
        let v = pull.get(n);
        if (!v) pull.set(n, (v = [0, 0, 0]));
        const dx = charge[p * 3] - position[n * 3], dy = charge[p * 3 + 1] - position[n * 3 + 1], dz = charge[p * 3 + 2] - position[n * 3 + 2];
        const d = Math.hypot(dx, dy, dz) || 1;
        v[0] += dx / d;
        v[1] += dy / d;
        v[2] += dz / d;
      }
      if (!pull.size) break;
      let grew = 0;
      for (const [n, v] of pull) {
        // A node pulled evenly both ways would dither on the spot; one that has forked twice has done its part.
        const l = Math.hypot(v[0], v[1], v[2]);
        if (l < 0.25 || children[n] >= 3) continue;
        // The field drives the discharge away from where it came in: fronds fan out from the entry, side by side.
        const ox = position[n * 3] - rx, oy = position[n * 3 + 1] - ry, oz = position[n * 3 + 2] - rz;
        const ol = Math.hypot(ox, oy, oz) || 1;
        let dx = v[0] / l + (ox / ol) * FAN + (random() - 0.5) * wander, dy = v[1] / l + (oy / ol) * FAN + (random() - 0.5) * wander, dz = v[2] / l + (oz / ol) * FAN + (random() - 0.5) * wander;
        const dl = Math.hypot(dx, dy, dz) || 1;
        let x = position[n * 3] + (dx / dl) * STEP, y = position[n * 3 + 1] + (dy / dl) * STEP, z = position[n * 3 + 2] + (dz / dl) * STEP;
        if (!inside(x, y, z, 0.004)) {
          // A step out of the glass is turned back along its surface, so a branch can follow a thin part.
          const d = sample(grid, x, y, z), e = CELL;
          let gx = sample(grid, x + e, y, z) - sample(grid, x - e, y, z), gy = sample(grid, x, y + e, z) - sample(grid, x, y - e, z), gz = sample(grid, x, y, z + e) - sample(grid, x, y, z - e);
          const gl = Math.hypot(gx, gy, gz) || 1;
          const push = d + 0.008;
          x -= (gx / gl) * push;
          y -= (gy / gl) * push;
          z -= (gz / gl) * push;
          if (!inside(x, y, z, 0.004)) continue;
        }
        add(x, y, z, n);
        grew++;
      }
      if (!grew) {
        // Nothing could move: the points still pulling are out of reach (behind a wall, or balanced). Let them go.
        let dropped = 0;
        for (let p = 0; p < spent.length; p++) if (!spent[p] && pull.has(nearest[p])) (spent[p] = 1), dropped++;
        if (!dropped) break;
      }
    }
    if (!primary) primary = parent.length;
  }
  const points = spent.length;
  let left = 0;
  for (let p = 0; p < points; p++) if (!spent[p]) left++;

  const grownAt = performance.now();
  // What each node feeds, and how far along the tree it is from the entry.
  const count = parent.length;
  const feeds = new Float32Array(count).fill(1);
  const depth = new Float32Array(count);
  for (let i = count - 1; i > 0; i--) feeds[parent[i]] += feeds[i];
  for (let i = 1; i < count; i++) depth[i] = depth[parent[i]] + 1;

  const pos = Float32Array.from(position);
  // The trunk comes out to the surface where the bolt went in.
  pos.set(entry, 0);
  // Straight runs with sharp kinks, as a crack has, rather than the lattice's wiggle: the nodes that keep their place
  // are the forks, the tips and every few along a run; the ones between go onto the line between those.
  const kids = new Uint16Array(count), child = new Int32Array(count).fill(-1);
  for (let i = 1; i < count; i++) {
    kids[parent[i]]++;
    child[parent[i]] = i;
  }
  const RUN = 5;
  const fixed = (i) => i === 0 || kids[i] !== 1 || depth[i] % RUN === 0;
  const above = new Int32Array(count), below = new Int32Array(count);
  for (let i = 1; i < count; i++) above[i] = fixed(parent[i]) ? parent[i] : above[parent[i]];
  for (let i = count - 1; i > 0; i--) if (!fixed(i)) below[i] = fixed(child[i]) ? child[i] : below[child[i]];
  const placed = pos.slice();
  for (let i = 1; i < count; i++) {
    if (fixed(i)) continue;
    const a = above[i], b = below[i];
    const t = (depth[i] - depth[a]) / (depth[b] - depth[a]);
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = placed[a * 3 + k] + (placed[b * 3 + k] - placed[a * 3 + k]) * t;
  }

  const vox = (2 * EXTENT) / T;
  const data = new Uint8Array(T * T * T);
  // When the discharge reaches each place, 0 at the entry and 1 at the farthest tip, at half the resolution: the arrival
  // of the nearest piece of channel, 255 where there is none.
  const H = T >> 1;
  const arrival = new Uint8Array(H * H * H).fill(255);
  const closest = new Float32Array(H * H * H).fill(Infinity);
  const along = new Float32Array(count);
  for (let i = 1; i < count; i++) {
    const p = parent[i];
    along[i] = along[p] + Math.hypot(pos[i * 3] - pos[p * 3], pos[i * 3 + 1] - pos[p * 3 + 1], pos[i * 3 + 2] - pos[p * 3 + 2]);
  }
  let longest = 0;
  for (let i = 0; i < count; i++) longest = Math.max(longest, along[i]);
  const arrive = (length) => Math.min(254, Math.round((length / (longest * 1.06)) * 254));
  const toVox = (v) => (v + EXTENT) / vox - 0.5;
  // Draws one straight piece of channel, radius r in voxels, between two points given in voxels.
  function draw(ax, ay, az, bx, by, bz, r, at0, at1) {
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const ll = ex * ex + ey * ey + ez * ez || 1;
    const pad = r + BAND;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad)), x1 = Math.min(T - 1, Math.ceil(Math.max(ax, bx) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad)), y1 = Math.min(T - 1, Math.ceil(Math.max(ay, by) + pad));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz) - pad)), z1 = Math.min(T - 1, Math.ceil(Math.max(az, bz) + pad));
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / ll));
          const px = x - ax - ex * t, py = y - ay - ey * t, pz = z - az - ez * t;
          const d = Math.sqrt(px * px + py * py + pz * pz);
          // The distance to the channel's wall, BAND voxels either way: glass.js sphere-traces this field.
          const v = Math.round(Math.min(1, Math.max(0, 0.5 + (r - d) / (2 * BAND))) * 255);
          const o = x + T * (y + T * z);
          if (v > data[o]) data[o] = v;
          const h = (x >> 1) + H * ((y >> 1) + H * (z >> 1));
          if (d < closest[h]) {
            closest[h] = d;
            arrival[h] = Math.round(at0 + (at1 - at0) * t);
          }
        }
  }
  const cellVox = h / vox;
  let hairs = true;
  for (let i = 1; i < count; i++) {
    const p = parent[i];
    const ax = toVox(pos[i * 3]), ay = toVox(pos[i * 3 + 1]), az = toVox(pos[i * 3 + 2]);
    const bx = toVox(pos[p * 3]), by = toVox(pos[p * 3 + 1]), bz = toVox(pos[p * 3 + 2]);
    const share = (feeds[i] / count) ** 0.5;
    const atI = arrive(along[i]), atP = arrive(along[p]);
    draw(ax, ay, az, bx, by, bz, 0.6 + 1.4 * share, atI, atP);
    // The feathering: hairline cracks off every piece, raked forward the way the discharge was going and set round
    // the branch like a bottle brush, so a frond is feathered from wherever it is seen. Longest off the main
    // branches, shortening toward the tips.
    if ((i & 63) === 0 && performance.now() - start > budget * 1.5) hairs = false;
    if (!hairs) continue;
    let fx = ax - bx, fy = ay - by, fz = az - bz;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // Two directions across the branch.
    let ux = fy, uy = -fx, uz = 0;
    if (Math.abs(fz) > 0.9) (ux = 0), (uy = fz), (uz = -fy);
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = fy * uz - fz * uy, wy = fz * ux - fx * uz, wz = fx * uy - fy * ux;
    for (let k = 0; k < 3; k++) {
      const t = random(), roll = random() * 6.2832, c = Math.cos(roll), sn = Math.sin(roll);
      const ox = bx + (ax - bx) * t, oy = by + (ay - by) * t, oz = bz + (az - bz) * t;
      const rake = 0.6 + random() * 0.6;
      const dx = fx * rake + ux * c + wx * sn, dy = fy * rake + uy * c + wy * sn, dz = fz * rake + uz * c + wz * sn;
      const length = (cellVox * (0.4 + random() * 0.9 + share * 7)) / Math.hypot(dx, dy, dz);
      // No thinner: the field of a line under about half a voxel falls between the texture's samples.
      // A hair cracks a moment after the channel it leaves.
      const at = atP + (atI - atP) * t;
      draw(ox, oy, oz, ox + dx * length, oy + dy * length, oz + dz * length, 0.55, at + 2, Math.min(254, at + 2 + length * vox * 254 / longest));
    }
  }
  return { data, arrival, T, count, primary, points, left, spacing, grownMs: grownAt - start };
}

self.onmessage = ({ data: job }) => {
  const start = performance.now();
  try {
    const result = grow(job);
    self.postMessage({ id: job.id, ...result, ms: performance.now() - start }, [result.data.buffer, result.arrival.buffer]);
  } catch (error) {
    // The page must hear back either way, or its leader waits for ever.
    self.postMessage({ id: job.id, error: String(error?.stack ?? error) });
  }
};
