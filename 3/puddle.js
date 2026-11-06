import { DataTexture, RedFormat, FloatType, LinearFilter, ClampToEdgeWrapping, PlaneGeometry, Vector2, Vector4 } from "three";

export { RIPPLES, HMAX };

// Film spreads freely above H0 and stops at HPIN, so a pool settles to a pancake of about that thickness.
const H0 = 0.05;
const HPIN = 0.028;
// Shown height: a pool HMAX above the floor with a rounded meniscus, domed by DOME of any film above HPIN (easing out
// towards DOME_MAX) where a drop just landed; film under FOOT·HPIN and dry cells sit DRY under the floor.
const HMAX = 0.07;
const DOME = 0.5;
const DOME_MAX = 0.04;
const DRY = 0.004;
const FOOT = 0.15;
const ITERATIONS = 4;
const RATE = 0.15;
// Weight of the diagonal neighbours, so pools spread round rather than square.
const DIAG = 0.5;
// The floor soaks film at a constant rate, so the pool shrinks from its edge; past VCAP it soaks faster, so the pool
// stays under the object. Film thinner than THIN dries within THIN_TAU, so splat tails leave no halo.
const ABSORB_TAU = 90;
// The floor only starts soaking HOLD seconds after the last drop landed, easing in over HOLD_RAMP.
const HOLD = 8;
const HOLD_RAMP = 6;
const VCAP = 8e-3;
const KCAP = 20;
const THIN = 0.25 * HPIN;
const THIN_TAU = 0.5;
const EMPTY = 1e-6;
// Film further out than DRIFT_IN pool radii from the pool's centre drifts back in at DRIFT_K per second (at most
// DRIFT_MAX m/s), so stray splats join one pool.
const DRIFT_IN = 0.3;
const DRIFT_K = 4;
const DRIFT_MAX = 0.5;
// Splash rings: the last RIPPLES landings, each RIPPLE_AMP drop radii high.
const RIPPLES = 8;
const RIPPLE_AMP = 0.25;
const WARP = 0.35;

const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// A floor puddle under the object: film thickness H on an N² grid over a SIZE² square centred under it (world xz).
// Drops splat Gaussian volume in; the film flows only above a pinning depth and slowly soaks away. Two R16F textures hold the
// shown height now and last frame.
export function createPuddle({ lite = false, floorY, size = 4.5 }) {
  const N = lite ? 112 : 144;
  const M = lite ? 192 : 256;
  const dx = size / N;
  const rect = new Vector4(-size / 2, -size / 2, size, size);
  let H = new Float32Array(N * N);
  let Hn = new Float32Array(N * N);
  const flux = new Float32Array(N * N);
  const raw = new Float32Array(N * N).fill(-DRY);
  const textures = [0, 1].map(() => {
    const t = new DataTexture(new Float32Array(N * N).fill(-DRY), N, N, RedFormat, FloatType);
    t.internalFormat = "R16F";
    t.minFilter = t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  });
  const uniforms = {
    puddleNow: { value: textures[0] },
    puddlePrev: { value: textures[0] },
    puddleRect: { value: rect },
    puddleTexel: { value: new Vector2(1 / N, 1 / N) },
    floorY: { value: floorY },
    puddleRipples: { value: Array.from({ length: RIPPLES }, () => new Vector4()) },
    puddleTime: { value: 0 },
    puddleTimePrev: { value: 0 },
  };
  let clock = 0, ripple = 0, lastSplat = -Infinity;
  // Cells that may hold film, grown by a cell per iteration as it spreads.
  let i0 = N, i1 = -1, j0 = N, j1 = -1;
  let dirty = true;
  const stats = { volume: 0, cells: 0, splats: 0 };
  let total = 0;
  // Volume-weighted centre (world xz) and equivalent radius of the film.
  let mx = 0, mz = 0, rp = 0;
  const ledger = { splatted: 0, absorbed: 0 };

  const shown = (h) =>
    h <= EMPTY ? -DRY : -DRY + (HMAX + DRY) * Math.sqrt(smoothstep(FOOT * HPIN, HPIN, h)) + DOME_MAX * (1 - Math.exp((-DOME * Math.max(0, h - HPIN)) / DOME_MAX));

  function splat(x, z, V, r) {
    if (!(V > 0)) return;
    // Wider on dry floor, so a landing beside the pool spreads as a dome rather than standing up as a cone.
    const sigma = Math.max(1.2 * dx, r * mix(1.6, 1, smoothstep(0, HPIN, sample(x, z))));
    const cx = (x - rect.x) / dx - 0.5, cz = (z - rect.y) / dx - 0.5;
    const reach = Math.ceil((3 * sigma) / dx);
    const a0 = Math.max(0, Math.floor(cx) - reach), a1 = Math.min(N - 1, Math.ceil(cx) + reach);
    const b0 = Math.max(0, Math.floor(cz) - reach), b1 = Math.min(N - 1, Math.ceil(cz) + reach);
    if (a0 > a1 || b0 > b1) return;
    const k = (dx * dx) / (2 * sigma * sigma);
    let sum = 0;
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) sum += Math.exp(-k * ((i - cx) ** 2 + (j - cz) ** 2));
    const scale = V / (sum * dx * dx);
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) H[j * N + i] += scale * Math.exp(-k * ((i - cx) ** 2 + (j - cz) ** 2));
    (i0 = Math.min(i0, a0)), (i1 = Math.max(i1, a1)), (j0 = Math.min(j0, b0)), (j1 = Math.max(j1, b1));
    ledger.splatted += V;
    lastSplat = clock;
    total += V;
    uniforms.puddleRipples.value[ripple].set(x, z, clock, RIPPLE_AMP * r);
    ripple = (ripple + 1) % RIPPLES;
    dirty = true;
  }

  // Flux between neighbours, by the film's height difference; the thicker side must pass HPIN for any to flow.
  const mob = (a, b) => {
    const m = smoothstep(HPIN, H0, Math.max(a, b));
    return RATE * m;
  };
  // mob(a, b) · (b − a), skipping the exact zero below HPIN.
  const edge = (a, b) => (a > HPIN || b > HPIN ? mob(a, b) * (b - a) : 0);
  const edgeDiag = (a, b) => (a > HPIN || b > HPIN ? DIAG * mob(a, b) * (b - a) : 0);

  function step(h) {
    clock += h;
    if (i1 < 0) return;
    const idle = smoothstep(HOLD, HOLD + HOLD_RAMP, clock - lastSplat);
    const soak = (h * HPIN * (idle + KCAP * Math.max(0, total / VCAP - 1))) / ABSORB_TAU;
    const thin = 1 - Math.exp(-h / THIN_TAU);
    for (let it = 0; it < ITERATIONS; it++) {
      (i0 = Math.max(0, i0 - 1)), (i1 = Math.min(N - 1, i1 + 1)), (j0 = Math.max(0, j0 - 1)), (j1 = Math.min(N - 1, j1 + 1));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const q = j * N + i, a = H[q];
          let d = 0;
          if (i + 1 < N) d += edge(a, H[q + 1]);
          if (i > 0) d += edge(a, H[q - 1]);
          if (j + 1 < N) d += edge(a, H[q + N]);
          if (j > 0) d += edge(a, H[q - N]);
          if (i > 0 && j > 0 && i + 1 < N && j + 1 < N) {
            d += edgeDiag(a, H[q + N + 1]);
            d += edgeDiag(a, H[q + N - 1]);
            d += edgeDiag(a, H[q + 1 - N]);
            d += edgeDiag(a, H[q - 1 - N]);
          }
          flux[q] = d;
        }
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) Hn[j * N + i] = H[j * N + i] + flux[j * N + i];
      const swap = H;
      (H = Hn), (Hn = swap);
    }
    if (rp > 0) drift(h);
    // Shrinks the active box back to the cells that still hold film.
    let a0 = N, a1 = -1, b0 = N, b1 = -1, vol = 0, cells = 0, sx = 0, sz = 0, wet = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const q = j * N + i;
        let v = H[q] - soak;
        if (v < THIN) v -= H[q] * thin;
        if (v < EMPTY) v = 0;
        ledger.absorbed += (H[q] - v) * dx * dx;
        H[q] = v;
        if (v > 0) {
          vol += v;
          sx += v * i;
          sz += v * j;
          if (v > THIN) wet++;
          if (shown(v) > 0) cells++;
          (a0 = Math.min(a0, i)), (a1 = Math.max(a1, i)), (b0 = Math.min(b0, j)), (b1 = Math.max(b1, j));
        }
      }
    // Cells outside the new box were zeroed above or never held film.
    (i0 = a0), (i1 = a1), (j0 = b0), (j1 = b1);
    stats.volume = total = vol * dx * dx;
    mx = vol > 0 ? rect.x + (sx / vol + 0.5) * dx : 0;
    mz = vol > 0 ? rect.y + (sz / vol + 0.5) * dx : 0;
    rp = Math.sqrt(wet / Math.PI) * dx;
    stats.cells = cells;
    dirty = true;
  }

  // Inward speed (m/s, along +axis) at a face whose offset from the centre is (fx, fz) along that axis and across it.
  const inward = (fx, fz) => {
    const r = Math.hypot(fx, fz);
    if (r <= 1e-9) return 0;
    return (-Math.min(DRIFT_K * Math.max(0, r - DRIFT_IN * rp), DRIFT_MAX) * fx) / r;
  };

  // Upwind transport of the film towards the pool's centre; the flow converges, so the active box holds it.
  function drift(h) {
    const c = h / dx;
    for (let j = j0; j <= j1; j++) {
      const z = rect.y + (j + 0.5) * dx - mz;
      for (let i = i0; i < i1; i++) {
        const q = j * N + i;
        if (H[q] === 0 && H[q + 1] === 0) {
          flux[q] = 0;
          continue;
        }
        const u = c * inward(rect.x + (i + 1) * dx - mx, z);
        flux[q] = u > 0 ? u * H[q] : u * H[q + 1];
      }
      for (let i = i1 - 1; i >= i0; i--) {
        const q = j * N + i;
        H[q] -= flux[q];
        H[q + 1] += flux[q];
      }
    }
    for (let i = i0; i <= i1; i++) {
      const x = rect.x + (i + 0.5) * dx - mx;
      for (let j = j0; j < j1; j++) {
        const q = j * N + i;
        if (H[q] === 0 && H[q + N] === 0) {
          flux[q] = 0;
          continue;
        }
        const u = c * inward(rect.y + (j + 1) * dx - mz, x);
        flux[q] = u > 0 ? u * H[q] : u * H[q + N];
      }
      for (let j = j0; j < j1; j++) {
        const q = j * N + i;
        H[q] -= flux[q];
        H[q + N] += flux[q];
      }
    }
  }

  // Film thickness at world (x, z), bilinear over the grid.
  function sample(x, z) {
    const fx = (x - rect.x) / dx - 0.5, fz = (z - rect.y) / dx - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 0;
    const tx = fx - i, tz = fz - j, q = j * N + i;
    return (H[q] * (1 - tx) + H[q + 1] * tx) * (1 - tz) + (H[q + N] * (1 - tx) + H[q + N + 1] * tx) * tz;
  }

  // Shown height at world (x, z), for the drops' landing.
  const heightAt = (x, z) => Math.max(0, shown(sample(x, z)));

  // Writes the shown height; the previous texture holds last frame's (or now's while paused).
  let cur = 0;
  let prevShown = false;
  // Per texture, the cells written above dry (a0, a1, b0, b1), or empty.
  const boxes = [new Int32Array([N, -1, N, -1]), new Int32Array([N, -1, N, -1])];
  function upload(running) {
    uniforms.puddleTimePrev.value = running ? uniforms.puddleTime.value : clock;
    uniforms.puddleTime.value = clock;
    if (!dirty) {
      // Unchanged since the last upload: last frame equals now.
      if (!prevShown) {
        uniforms.puddlePrev.value = textures[cur];
        prevShown = true;
      }
      updateDrawRange();
      return;
    }
    dirty = false;
    prevShown = false;
    const last = cur;
    cur = 1 - cur;
    const d = textures[cur].image.data;
    d.fill(-DRY);
    boxes[cur].set([N, -1, N, -1]);
    if (i1 >= 0) {
      // A [1 2 1]² blur rounds the meniscus and feathers the outline over a couple of cells.
      const a0 = Math.max(0, i0 - 2), a1 = Math.min(N - 1, i1 + 2), b0 = Math.max(0, j0 - 2), b1 = Math.min(N - 1, j1 + 2);
      boxes[cur].set([a0, a1, b0, b1]);
      for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) raw[j * N + i] = shown(H[j * N + i]);
      for (let j = b0; j <= b1; j++)
        for (let i = a0; i <= a1; i++) {
          let sum = 0;
          for (let v = -1; v <= 1; v++)
            for (let u = -1; u <= 1; u++) {
              const ii = Math.min(N - 1, Math.max(0, i + u)), jj = Math.min(N - 1, Math.max(0, j + v));
              sum += (u ? 1 : 2) * (v ? 1 : 2) * raw[jj * N + ii];
            }
          d[j * N + i] = sum / 16;
        }
      for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) raw[j * N + i] = -DRY;
    }
    textures[cur].needsUpdate = true;
    uniforms.puddleNow.value = textures[cur];
    uniforms.puddlePrev.value = running ? textures[last] : textures[cur];
    updateDrawRange();
  }

  // The grid's quads are ordered in square rings out from the centre; only the rings that can reach a wet cell are
  // drawn. Everywhere else the film sits DRY under the floor, hidden by it.
  let grid = null;
  const REACH = 4;
  function updateDrawRange() {
    if (!grid) return;
    let a0 = N, a1 = -1, b0 = N, b1 = -1;
    for (const t of [uniforms.puddleNow.value, uniforms.puddlePrev.value]) {
      const b = boxes[textures.indexOf(t)];
      if (b[1] < 0) continue;
      (a0 = Math.min(a0, b[0])), (a1 = Math.max(a1, b[1])), (b0 = Math.min(b0, b[2])), (b1 = Math.max(b1, b[3]));
    }
    if (a1 < 0) return grid.geometry.setDrawRange(0, 0);
    // Vertices read cells within 3 of their own (B-spline taps, then the normal's offsets).
    const ring = (lo, hi, o) => {
      const x0 = o + (lo - REACH + 0.5) * dx, x1 = o + (hi + REACH + 0.5) * dx;
      let v0 = 0, v1 = M - 1;
      while (v0 < M - 1 && grid.coord[v0] < x0) v0++;
      while (v1 > 0 && grid.coord[v1] > x1) v1--;
      const q0 = Math.max(0, v0 - 1), q1 = Math.min(M - 2, v1);
      return Math.max(Math.abs(2 * q0 - (M - 2)), Math.abs(2 * q1 - (M - 2)));
    };
    const r = Math.max(ring(a0, a1, rect.x), ring(b0, b1, rect.y));
    grid.geometry.setDrawRange(0, grid.ringEnd[r >> 1]);
  }

  function reset() {
    H.fill(0);
    Hn.fill(0);
    i0 = j0 = N;
    i1 = j1 = -1;
    stats.volume = total = 0;
    stats.cells = 0;
    mx = mz = rp = 0;
    for (const r of uniforms.puddleRipples.value) r.set(0, 0, 0, 0);
    dirty = true;
  }

  // Vertices crowd towards the centre (WARP times the even spacing there), where the pool sits, so its outline is fine.
  function createGeometry() {
    const g = new PlaneGeometry(size, size, M - 1, M - 1);
    const pos = g.attributes.position.array;
    const warp = (v) => {
      const u = v / (size / 2);
      return v * (WARP + (1 - WARP) * u * u);
    };
    for (let k = 0; k < pos.length; k += 3) (pos[k] = warp(pos[k])), (pos[k + 1] = warp(pos[k + 1]));
    g.rotateX(-Math.PI / 2);
    g.translate(0, floorY, 0);
    // Same triangles, stably sorted by ring r = max(|2i − (M − 2)|, |2j − (M − 2)|) of their quad (i, j).
    const index = g.index.array;
    const Q = M - 1, rings = M >> 1;
    const ringEnd = new Uint32Array(rings);
    const ringOf = (q) => Math.max(Math.abs(2 * (q % Q) - (M - 2)), Math.abs(2 * Math.floor(q / Q) - (M - 2))) >> 1;
    for (let q = 0; q < Q * Q; q++) ringEnd[ringOf(q)] += 6;
    for (let r = 1; r < rings; r++) ringEnd[r] += ringEnd[r - 1];
    const sorted = new index.constructor(index.length);
    const fill = ringEnd.map((e, r) => (r ? ringEnd[r - 1] : 0));
    for (let q = 0; q < Q * Q; q++) {
      const r = ringOf(q);
      sorted.set(index.subarray(q * 6, q * 6 + 6), fill[r]);
      fill[r] += 6;
    }
    g.index.array.set(sorted);
    // World x of each vertex column, which is also the world z of each row.
    const coord = new Float64Array(M);
    for (let v = 0; v < M; v++) coord[v] = pos[v * 3];
    grid = { geometry: g, ringEnd, coord };
    return g;
  }

  return { N, uniforms, stats, ledger, splat, step, heightAt, upload, reset, createGeometry, prime: () => (dirty = true), dispose: () => textures.forEach((t) => t.dispose()) };
}
