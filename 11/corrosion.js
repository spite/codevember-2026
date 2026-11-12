// Corrosion patterns baked into a tiling 3D texture, grown rather than noise:
//   r: when rust reaches each point, spreading from many small pits (first-passage growth through random costs, so
//      fronts are ragged like real corrosion), 0 = first, 1 = last
//   g: the same from a few big patches, some starting late
//   b: spots: distance to the nearest seed over that seed's own radius (< 1 inside), for pits and droplet marks
//   a: cracks: distance to the nearest Voronoi edge, for mill scale breaking into islands
// followed by a second texture of ids: r a random value per crack cell, g per spot, b white noise.
// Baked offline by bake.mjs into corrosion.bin (it takes seconds); the page only loads the result.
export const CORROSION_SIZE = 64;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A binary heap of (time, index).
function heap(n) {
  const t = new Float32Array(n), id = new Int32Array(n);
  let size = 0;
  return {
    get size() { return size; },
    push(time, i) {
      let k = size++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (t[p] <= time) break;
        t[k] = t[p], id[k] = id[p];
        k = p;
      }
      t[k] = time, id[k] = i;
    },
    pop() {
      const top = id[0], tt = t[0];
      const lt = t[--size], li = id[size];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= size) break;
        if (c + 1 < size && t[c + 1] < t[c]) c++;
        if (t[c] >= lt) break;
        t[k] = t[c], id[k] = id[c];
        k = c;
      }
      t[k] = lt, id[k] = li;
      return [tt, top];
    },
  };
}

// Arrival times of growth from seeds (each with a start delay) through random per-cell costs, on a periodic grid.
function growth(N, rand, seeds, roughness) {
  const n = N * N * N;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) cost[i] = -Math.log(1 - rand() * 0.999) * roughness + (1 - roughness);
  const time = new Float32Array(n).fill(Infinity);
  const h = heap(n * 7);
  for (const [x, y, z, delay] of seeds) {
    const i = x + y * N + z * N * N;
    if (delay < time[i]) {
      time[i] = delay;
      h.push(delay, i);
    }
  }
  const M = N - 1;
  while (h.size) {
    const [t, i] = h.pop();
    if (t > time[i]) continue;
    const x = i % N, y = ((i / N) | 0) % N, z = (i / (N * N)) | 0;
    const nb = [((x + 1) & M) + y * N + z * N * N, ((x + M) & M) + y * N + z * N * N, x + ((y + 1) & M) * N + z * N * N, x + ((y + M) & M) * N + z * N * N, x + y * N + ((z + 1) & M) * N * N, x + y * N + ((z + M) & M) * N * N];
    for (const j of nb) {
      const tj = t + 0.5 * (cost[i] + cost[j]);
      if (tj < time[j]) {
        time[j] = tj;
        h.push(tj, j);
      }
    }
  }
  // Ranked, so the values spread evenly over 0..1: coverage at threshold a is a.
  const order = Array.from(time.keys()).sort((a, b) => time[a] - time[b]);
  const out = new Float32Array(n);
  order.forEach((idx, k) => (out[idx] = k / (n - 1)));
  return out;
}

function randomSeeds(N, rand, count, maxDelay) {
  return Array.from({ length: count }, () => [Math.floor(rand() * N), Math.floor(rand() * N), Math.floor(rand() * N), rand() ** 2 * maxDelay]);
}

// Periodic distance between grid points.
const pd = (a, b, N) => {
  const d = Math.abs(a - b);
  return Math.min(d, N - d);
};

export function bakeCorrosion(N = CORROSION_SIZE) {
  const rand = mulberry32(911);
  const n = N * N * N;
  const fine = growth(N, rand, randomSeeds(N, rand, 260, 30), 0.85);
  const coarse = growth(N, rand, randomSeeds(N, rand, 18, 60), 0.9);
  // Spots of power-law sizes.
  const spots = Array.from({ length: 160 }, () => [rand() * N, rand() * N, rand() * N, 0.8 + 5 * rand() ** 3]);
  const cracks = Array.from({ length: 90 }, () => [rand() * N, rand() * N, rand() * N]);
  const data = new Uint8Array(n * 4);
  // Second half: a random value per crack cell (r) and per spot (g), white noise (b).
  const ids = new Uint8Array(n * 4);
  const cellValue = cracks.map(() => Math.round(rand() * 255));
  const spotValue = spots.map(() => Math.round(rand() * 255));
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = x + y * N + z * N * N;
        let spot = Infinity;
        for (const [sx, sy, sz, r] of spots) {
          const d = Math.hypot(pd(x, sx, N), pd(y, sy, N), pd(z, sz, N)) / r;
          if (d < spot) spot = d;
        }
        let f1 = Infinity, f2 = Infinity, cell = 0, spotId = 0;
        cracks.forEach(([cx, cy, cz], k) => {
          const d = Math.hypot(pd(x, cx, N), pd(y, cy, N), pd(z, cz, N));
          if (d < f1) (f2 = f1), (f1 = d), (cell = k);
          else if (d < f2) f2 = d;
        });
        spots.forEach(([sx, sy, sz, r], k) => {
          if (Math.hypot(pd(x, sx, N), pd(y, sy, N), pd(z, sz, N)) / r <= spot + 1e-6) spotId = k;
        });
        ids[i * 4] = cellValue[cell];
        ids[i * 4 + 1] = spotValue[spotId];
        ids[i * 4 + 2] = Math.round(rand() * 255);
        ids[i * 4 + 3] = 255;
        data[i * 4] = Math.round(fine[i] * 255);
        data[i * 4 + 1] = Math.round(coarse[i] * 255);
        data[i * 4 + 2] = Math.round(Math.min(1, spot / 2) * 255);
        data[i * 4 + 3] = Math.round(Math.min(1, (f2 - f1) / 6) * 255);
      }
  const out = new Uint8Array(n * 8);
  out.set(data);
  out.set(ids, n * 4);
  return out;
}
