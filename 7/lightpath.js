// Ways for the light through the hollowed lattice: A* over a clearance grid of the final mesh, shortcut by line of
// sight, so the light goes round the struts and through the holes instead of jumping across a wall.
import { Heap } from "./surface.js";

const NB = [];
for (let c = -1; c <= 1; c++)
  for (let b = -1; b <= 1; b++)
    for (let a = -1; a <= 1; a++) if (a || b || c) NB.push([a, b, c, Math.hypot(a, b, c)]);

class LightPath {
  // grid: { D, lo, n, g } with every node finite; at: its trilinear sampler.
  constructor(grid, at) {
    this.D = grid.D;
    this.lo = grid.lo;
    this.n = grid.n;
    this.g = grid.g;
    this.at = at;
    const N = this.D.length;
    this.cost = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.seen = new Uint32Array(N);
    this.stamp = 0;
    const [nx, ny] = this.n;
    this.off = NB.map(([a, b, c, w]) => [a + nx * (b + ny * c), w, a, b, c]);
    this.heap = new Heap(4096);
  }

  node(x, y, z) {
    const [nx, ny, nz] = this.n, g = this.g, o = this.lo;
    const i = Math.min(nx - 2, Math.max(1, Math.round((x - o[0]) / g)));
    const j = Math.min(ny - 2, Math.max(1, Math.round((y - o[1]) / g)));
    const k = Math.min(nz - 2, Math.max(1, Math.round((z - o[2]) / g)));
    return i + nx * (j + ny * k);
  }

  point(q, out) {
    const [nx, ny] = this.n, g = this.g, o = this.lo;
    const k = Math.floor(q / (nx * ny)), r = q - k * nx * ny, j = Math.floor(r / nx), i = r - j * nx;
    out[0] = o[0] + i * g; out[1] = o[1] + j * g; out[2] = o[2] + k * g;
    return out;
  }

  // Whether the straight segment a→b keeps at least c from every wall.
  clear(a, b, c) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    const steps = Math.ceil(len / (0.4 * this.g));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.at(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t) < c) return false;
    }
    return true;
  }

  // Points from `from` toward `to` through space with clearance c. If `to` can't be reached (inside a wall, or cut
  // off), the way ends at the reachable point nearest to it. Null if `from` itself is boxed in.
  plan(from, to, c, keep = c, maxExpand = 6000) {
    const D = this.D, [nx, ny] = this.n, NXY = nx * ny;
    const stamp = ++this.stamp;
    const p = [0, 0, 0];
    let start = this.node(...from);
    if (D[start] < c) {
      // Inside a wall (a strut swept into it): start from the nearest free node, a few nodes out at most.
      const [sx, sy, sz] = [start % nx, ((start / nx) | 0) % ny, (start / NXY) | 0];
      let best = -1, bd = Infinity;
      for (let r = 1; r <= 4 && best < 0; r++)
        for (let k = -r; k <= r; k++)
          for (let j = -r; j <= r; j++)
            for (let i = -r; i <= r; i++) {
              if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
              const x = sx + i, y = sy + j, z = sz + k;
              if (x < 1 || y < 1 || z < 1 || x >= nx - 1 || y >= this.n[1] - 1 || z >= this.n[2] - 1) continue;
              const q = x + nx * (y + ny * z), d2 = i * i + j * j + k * k;
              if (D[q] >= c && d2 < bd) { bd = d2; best = q; }
            }
      if (best < 0) return null;
      start = best;
    }
    const goal = this.node(...to);
    const gi = goal % nx, gj = ((goal / nx) | 0) % ny, gk = (goal / NXY) | 0;
    const h = (q) => Math.hypot((q % nx) - gi, (((q / nx) | 0) % ny) - gj, ((q / NXY) | 0) - gk);
    this.heap.n = 0;
    this.seen[start] = stamp;
    this.cost[start] = 0;
    this.parent[start] = -1;
    this.heap.push(h(start), start);
    let best = start, bestH = h(start), expanded = 0;
    while (this.heap.n && expanded++ < maxExpand) {
      const q = this.heap.pop();
      const hq = h(q);
      if (hq < bestH) { bestH = hq; best = q; }
      if (q === goal) break;
      // Border nodes are dead ends: a step from one would wrap to the far side of the grid.
      const qi = q % nx, qj = ((q / nx) | 0) % ny, qk = (q / NXY) | 0;
      if (qi === 0 || qj === 0 || qk === 0 || qi === nx - 1 || qj === ny - 1 || qk === this.n[2] - 1) continue;
      const cq = this.cost[q];
      for (const [o, w] of this.off) {
        const r = q + o;
        if (r < 0 || r >= D.length || D[r] < c) continue;
        // Ways closer than `keep` to a wall cost more, so the light keeps its distance where it can.
        const cr = cq + w * (1 + 1.5 * Math.max(0, keep - D[r]) / keep);
        if (this.seen[r] === stamp && cr >= this.cost[r]) continue;
        this.seen[r] = stamp;
        this.cost[r] = cr;
        this.parent[r] = q;
        this.heap.push(cr + 2 * h(r), r);
      }
    }
    const way = [];
    for (let q = best; q >= 0; q = this.parent[q]) way.push(this.point(q, p).slice());
    way.reverse();
    if (best === goal && this.at(...to) >= c) way.push([...to]);
    return way;
  }
}

export { LightPath };
