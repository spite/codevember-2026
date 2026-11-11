// Packs the ornament for the relief shader: primitives (5 texels each, the last a bounding sphere), a grid of cells over the shape listing the
// primitives near each, and the hammer blows. No imports beyond the ornament, so the build worker can load it.
import { STROKE, LEAF, ROSETTE, ARC, FROND, BLOSSOM, RIBBON, SCALE, PALMETTE, FRET, ROUNDEL, TUBE, NODULE, POD, SPHINCTER, VERTEBRA, FRIEZE, FEATHER, GUILLOCHE, BLADE, BLOOM, PAD, POPPY, CLOSED } from "./ornament.js";

export const OW = 4096;
export const MAX_PER_CELL = 96;
const MARGIN = 0.012;

function footprint(p, shape) {
  if (p.type === ARC) {
    const mid = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    const rho = Math.hypot(p.a[0] - p.c[0], p.a[1] - p.c[1], p.a[2] - p.c[2]);
    const dm = Math.hypot(mid[0] - p.c[0], mid[1] - p.c[1], mid[2] - p.c[2]);
    const half = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2;
    return [mid, Math.max(half, rho - dm) + Math.max(p.ra, p.rb)];
  }
  if (p.type === STROKE || p.type === TUBE) {
    const c = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    return [c, Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2 + Math.max(p.ra, p.rb)];
  }
  if (p.type === BLOSSOM) {
    const c = [p.a[0] + p.b[0] * p.L * 0.5, p.a[1] + p.b[1] * p.L * 0.5, p.a[2] + p.b[2] * p.L * 0.5];
    return [c, p.L * 0.55 + p.W];
  }
  if (p.type === LEAF) {
    const c = [p.a[0] + p.b[0] * p.L * 0.5, p.a[1] + p.b[1] * p.L * 0.5, p.a[2] + p.b[2] * p.L * 0.5];
    return [c, p.L * 0.6 + p.W * 1.2];
  }
  if (p.type === BLADE) {
    if (p.kind === PAD) return [p.a, p.L * 1.06];
    const c = [p.a[0] + p.b[0] * p.L * 0.5, p.a[1] + p.b[1] * p.L * 0.5, p.a[2] + p.b[2] * p.L * 0.5];
    return [c, p.L * 0.55 + p.W * 1.1];
  }
  if (p.type === BLOOM) {
    if (p.kind === POPPY) return [p.a, p.L * 1.1];
    const k = p.kind === CLOSED ? 0.5 : 0.4;
    return [[p.a[0] + p.b[0] * p.L * k, p.a[1] + p.b[1] * p.L * k, p.a[2] + p.b[2] * p.L * k], p.L * (p.kind === CLOSED ? 0.6 : 0.78)];
  }
  if (p.type === FROND) return [p.a, p.R * 1.42];
  // Centred above the panel (c), so a sphere through its corners leaves out the far side of a thin tube.
  if (p.type === GUILLOCHE) return [p.c, p.fr];
  if (p.type === POD) return [p.a, p.L * 0.62];
  if (p.type === VERTEBRA) return [p.a, Math.hypot(p.L, p.W) * 1.05];
  if (p.type === NODULE) return [p.a, p.R * 1.18];
  if (p.type === RIBBON) {
    const c = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    return [c, Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2 + Math.abs(p.w) + (p.w > 0 ? Math.abs(p.sag) : 0)];
  }
  if (p.type === SCALE) {
    // Only the part round its tip shows: the rest is cut back from the rims of the scales above it.
    const k = p.L - p.W * 1.3;
    return [[p.a[0] + p.b[0] * k, p.a[1] + p.b[1] * k, p.a[2] + p.b[2] * k], p.W * 1.45];
  }
  if (p.type === PALMETTE) {
    const c = [p.a[0] + p.b[0] * p.L * 0.5, p.a[1] + p.b[1] * p.L * 0.5, p.a[2] + p.b[2] * p.L * 0.5];
    return [c, p.L * 0.55 + p.W * 0.75];
  }
  if (p.type === FRET) {
    // A capsule: the cells are tested against the segment itself.
    const c = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    const cap = Math.max(p.ext, p.extB ?? p.ext, 0) + p.w * (1.42 + Math.max(Math.abs(p.kA ?? 0), Math.abs(p.kB ?? 0))) + sag(shape, c);
    return [c, Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2 + cap, cap];
  }
  if (p.type === FRIEZE) return [p.a, Math.hypot(p.P * 0.62, p.B) * 1.04];
  if (p.type === FEATHER) {
    const c = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    const cap = p.W * 1.05 + sag(shape, c);
    return [c, Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2 + cap, cap];
  }
  return [p.a, p.R * 1.02];
}

// How far a chord's midpoint lies off the surface, which its capsule must reach across.
function sag(shape, c) {
  if (!shape?.project) return 0;
  const q = shape.project(c[0], c[1], c[2]);
  return Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
}

// Packs primitives, cells and blows into typed arrays, with the grid's layout.
export function packRelief(shape, { prims, blows }, cellSize = 0.016) {
  const n = prims.length;
  const rows = Math.ceil((n * 5) / OW) || 1;
  const pd = new Float32Array(OW * rows * 4);
  prims.forEach((p, i) => {
    const o = i * 20;
    pd.set([p.a[0], p.a[1], p.a[2], p.type === FRET ? p.type + p.kind * 0.1 : p.type], o);
    if (p.type === STROKE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.ra], o + 4);
      pd.set([p.rb, 0, 0, 0], o + 8);
    } else if (p.type === ARC) {
      pd.set([p.b[0], p.b[1], p.b[2], p.ra], o + 4);
      pd.set([p.c[0], p.c[1], p.c[2], p.rb], o + 8);
    } else if (p.type === LEAF) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set([p.W, p.curl, p.lobes, p.seed], o + 8);
    } else if (p.type === FROND) {
      pd.set([p.b[0], p.b[1], p.b[2], p.R], o + 4);
      pd.set([p.spiral, p.turns, p.leaflets, p.seed], o + 8);
    } else if (p.type === ROSETTE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.R], o + 4);
      pd.set([p.petals, p.layers, p.seed, p.kind ?? 0], o + 8);
    } else if (p.type === FRET) {
      pd.set([p.b[0], p.b[1], p.b[2], p.w], o + 4);
      pd.set([p.ext, p.kA ?? 0, p.extB ?? p.ext, p.kB ?? 0], o + 8);
    } else if (p.type === GUILLOCHE) {
      // Corners in units of R, 11 bits a coordinate.
      pd.set([p.b[0], p.b[1], p.b[2], p.R], o + 4);
      pd.set(p.corners.map(([x, y]) => Math.round((x / p.R + 1) * 1023.5) + 2048 * Math.round((y / p.R + 1) * 1023.5)), o + 8);
    } else if (p.type === ROUNDEL) {
      pd.set([p.b[0], p.b[1], p.b[2], p.R], o + 4);
      pd.set([p.points, p.kind, p.seed, p.pearls ?? 0], o + 8);
    } else if (p.type === BLOSSOM) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set([p.W, p.kind, p.seed, 0], o + 8);
    } else if (p.type === RIBBON) {
      pd.set([p.b[0], p.b[1], p.b[2], p.w], o + 4);
      // A knot strand's crossing angle rides in the fraction of its cut radius (integer part: radius in 1e-5).
      const rc = p.ang === undefined || !p.rc ? p.rc : Math.sign(p.rc) * (Math.round(Math.abs(p.rc) * 1e5) + 0.001 + ((p.ang + Math.PI) / (2 * Math.PI)) * 0.998);
      pd.set([p.c[0], p.c[1], p.c[2], rc], o + 8);
    } else if (p.type === SCALE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      // Up to three neighbours' tip circles, 12 bits each (6 along, 6 across); 4095 = none.
      const code = (k) => {
        const v = p.nb?.[k];
        if (!v) return 4095;
        const qu = Math.max(0, Math.min(62, Math.round(((v[0] + 3.5) / 4) * 63)));
        const qv = Math.max(0, Math.min(63, Math.round(((v[1] + 2) / 4) * 63)));
        return qu * 64 + qv;
      };
      pd.set([p.W, p.kind + 4 * code(0), p.seed, code(1) + 4096 * code(2)], o + 8);
    } else if (p.type === PALMETTE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set([p.W, p.lobes, p.seed, p.spread ?? 0.5], o + 8);
    } else if (p.type === BLADE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set([p.W, p.curl ?? 0, p.kind, p.twist ?? 0], o + 8);
    } else if (p.type === BLOOM) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set([p.W ?? 0, p.kind, p.seed, p.petals], o + 8);
    } else if (p.type === TUBE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.ra], o + 4);
      pd.set([p.rb, p.ribs, p.s0, p.kind], o + 8);
    } else if (p.type === NODULE || p.type === SPHINCTER) {
      pd.set([p.b[0], p.b[1], p.b[2], p.R], o + 4);
      pd.set(p.type === NODULE ? [p.lumps, p.pore, p.seed, p.kind] : [p.folds, p.hole, p.seed, p.twist], o + 8);
    } else if (p.type === POD || p.type === VERTEBRA) {
      pd.set([p.b[0], p.b[1], p.b[2], p.L], o + 4);
      pd.set(p.type === POD ? [p.W, p.seeds, p.seed, 0] : [p.W, p.kind ?? 0, p.seed, p.sweep ?? 0.5], o + 8);
    } else if (p.type === FRIEZE) {
      pd.set([p.b[0], p.b[1], p.b[2], p.B], o + 4);
      pd.set([p.P, p.kind, p.seed, p.twist], o + 8);
    } else if (p.type === FEATHER) {
      pd.set([p.b[0], p.b[1], p.b[2], p.W], o + 4);
      pd.set([p.u0, p.u1, p.kA, p.kB], o + 8);
    } else {
      pd.set([0, 0, 1, p.R], o + 4);
    }
    // A turned panel's motif in place of h: kind, lobes, pitch (1e-4), amplitude (/63), hand.
    const motif = (p) => p.kind + 8 * p.lobes + 256 * Math.round(p.pitch * 1e4) + 65536 * Math.round(p.amp * 63) + (p.twist < 0 ? 4194304 : 0);
    const w3 = p.type === RIBBON ? p.sag : p.type === FEATHER ? p.twist * (Math.round(p.Lf * 1000) + Math.min(0.499, (p.h ?? 1) - 0.5)) : p.type === GUILLOCHE ? motif(p) : p.h ?? 1;
    pd.set([p.ta, p.tb, p.th, w3], o + 12);
    // Bounding sphere, and a rough height (integer part: radius in 1/4096ths; fraction: height), for far pixels.
    const [fc, fr] = footprint(p, shape);
    const H = p.type === STROKE || p.type === ARC || p.type === TUBE ? Math.max(p.ra, p.rb) * 0.95 * (p.h ?? 1) : Math.min(fr * 0.3, 0.012);
    pd.set([fc[0], fc[1], fc[2], Math.ceil(fr * 4096) + Math.min(H, 0.99)], o + 16);
  });

  const b = shape.bounds.map((x) => x + 0.04);
  const min = b.map((x) => -x);
  const dim = b.map((x) => Math.ceil((2 * x) / cellSize));
  const cells = dim[0] * dim[1] * dim[2];
  // Two passes over the cells each footprint touches: count, then fill, straight into typed arrays.
  const half = cellSize * 0.866;
  const fps = prims.map((p) => footprint(p, shape));
  // Cells well off the surface, which no pixel looks up (tested lazily, for large footprints only): 1 near, 2 far.
  const near = new Uint8Array(cells);
  // The fields are distances to within a few percent (the gyroid's a little over).
  const reach = (half + MARGIN + 0.01) * 1.15;
  const bdim = dim.map((d) => Math.ceil(d / 4));
  const block = new Uint8Array(bdim[0] * bdim[1] * bdim[2]);
  const at = (i, j, k, s) => Math.abs(shape.sdf(min[0] + (i + s) * cellSize, min[1] + (j + s) * cellSize, min[2] + (k + s) * cellSize));
  const isNear = (ci, i, j, k) => {
    if (!near[ci]) {
      // Blocks of 4³ cells first.
      const bi = (i >> 2) + bdim[0] * ((j >> 2) + bdim[1] * (k >> 2));
      if (!block[bi]) block[bi] = at(i & ~3, j & ~3, k & ~3, 2) > reach + 4 * half ? 2 : 1;
      near[ci] = block[bi] === 2 || at(i, j, k, 0.5) > reach ? 2 : 1;
    }
    return near[ci] === 1;
  };
  function visit(id, fn) {
    const p = prims[id];
    const [c, r0, cap] = fps[id];
    const r = r0 + MARGIN;
    let ab, abl;
    if (cap !== undefined) (ab = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]]), (abl = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-12);
    const i0 = Math.max(0, Math.floor((c[0] - r - min[0]) / cellSize)), i1 = Math.min(dim[0] - 1, Math.floor((c[0] + r - min[0]) / cellSize));
    const j0 = Math.max(0, Math.floor((c[1] - r - min[1]) / cellSize)), j1 = Math.min(dim[1] - 1, Math.floor((c[1] + r - min[1]) / cellSize));
    const k0 = Math.max(0, Math.floor((c[2] - r - min[2]) / cellSize)), k1 = Math.min(dim[2] - 1, Math.floor((c[2] + r - min[2]) / cellSize));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          // Distance from the footprint's centre to the cell box.
          const dx = Math.max(min[0] + i * cellSize - c[0], 0, c[0] - (min[0] + (i + 1) * cellSize));
          const dy = Math.max(min[1] + j * cellSize - c[1], 0, c[1] - (min[1] + (j + 1) * cellSize));
          const dz = Math.max(min[2] + k * cellSize - c[2], 0, c[2] - (min[2] + (k + 1) * cellSize));
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          if (cap !== undefined) {
            const px = min[0] + (i + 0.5) * cellSize - p.a[0];
            const py = min[1] + (j + 0.5) * cellSize - p.a[1];
            const pz = min[2] + (k + 0.5) * cellSize - p.a[2];
            const s = Math.max(0, Math.min(1, (px * ab[0] + py * ab[1] + pz * ab[2]) / abl));
            const sd = Math.hypot(px - ab[0] * s, py - ab[1] * s, pz - ab[2] * s);
            if (sd > cap + MARGIN + half) continue;
          }
          const ci = i + dim[0] * (j + dim[1] * k);
          if (r0 > cellSize * 2 && shape.sdf && !isNear(ci, i, j, k)) continue;
          fn(ci);
        }
  }
  const counts = new Uint32Array(cells);
  for (let id = 0; id < n; id++) visit(id, (ci) => counts[ci]++);
  const cellRows = Math.ceil(cells / OW);
  const cd = new Uint32Array(OW * cellRows * 2);
  let total = 0;
  let maxCount = 0;
  let used = 0;
  for (let ci = 0; ci < cells; ci++) {
    // The cap drops the last (smallest, latest) ones.
    const c = Math.min(counts[ci], MAX_PER_CELL);
    if (!c) continue;
    cd[ci * 2] = total;
    total += c;
    used++;
    maxCount = Math.max(maxCount, c);
  }
  const listRows = Math.ceil(total / OW) || 1;
  const ld = new Uint32Array(OW * listRows);
  counts.fill(0);
  for (let id = 0; id < n; id++)
    visit(id, (ci) => {
      const k = counts[ci]++;
      if (k < MAX_PER_CELL) ld[cd[ci * 2] + k] = id;
    });
  for (let ci = 0; ci < cells; ci++) cd[ci * 2 + 1] = Math.min(counts[ci], MAX_PER_CELL);

  const bw = Math.max(1, blows.length);
  const bd = new Float32Array(bw * 2 * 4);
  blows.forEach((bl, i) => {
    bd.set([bl.p[0], bl.p[1], bl.p[2], bl.R], i * 4);
    bd.set([bl.depth, bl.t, 0, 0], (bw + i) * 4);
  });

  return {
    prims: pd,
    primRows: rows,
    cells: cd,
    cellRows,
    list: ld,
    listRows,
    blows: bd,
    blowWidth: bw,
    blowCount: blows.length,
    min,
    dim,
    cellSize,
    stats: { prims: n, refs: total, maxCount, cells: used },
  };
}
