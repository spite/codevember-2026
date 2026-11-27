// Procedural burrow volumes, in object space [-EXTENT, +EXTENT]³:
//   - tBurrow (T³, RGBA half float): R = narrow-band distance (0.5 = surface, > 0.5 inside the metal), G = resting heat,
//     B = when the stream reaches it, A = when the pool fills it.
//   - tGlow (G³, RGBA8): R = blurred ember glow, G = frost wisps, B = frost blotches.
// No imports: the heavy part of the bake runs in a worker (bake-worker.js); textures.js wraps the results for three.

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
// Float to half float bits (normal range, rounded to nearest).
function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >> 16) & 0x8000;
  const e = ((x >> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((x >> 13) & 0x3ff) + ((x >> 12) & 1));
}

export const EXTENT = 1.65; // half-size of the 3D texture volume in object units
export const BAND = 8.0; // narrow band, in voxels: how far a sphere-trace step can jump

export const BLOCK_SPECS = {
  cube: { type: 0, hx: 0.96, hy: 0.96, hz: 0.96, bevel: 0.052, holeR: 0.088, strata: 0.0 },
  cylinder: { type: 1, hx: 0.86, hy: 1.04, hz: 0.86, bevel: 0.064, holeR: 0.082, strata: 0.0 },
  column: { type: 2, hx: 0.50, hy: 1.48, hz: 0.50, bevel: 0.042, holeR: 0.072, strata: 0.65 },
  hex: { type: 3, hx: 0.94, hy: 1.02, hz: 0.94, bevel: 0.048, holeR: 0.084, strata: 0.0 },
  slab: { type: 4, hx: 1.24, hy: 0.96, hz: 0.42, bevel: 0.042, holeR: 0.078, strata: 0.0 },
  dome: { type: 5, hx: 0.88, hy: 1.12, hz: 0.88, bevel: 0.048, holeR: 0.082, strata: 0.0 },
  monolith: { type: 6, hx: 1.04, hy: 1.06, hz: 1.04, bevel: 0.048, holeR: 0.080, strata: 0.25 },
  paperweight: { type: 7, hx: 1.12, hy: 0.86, hz: 1.12, bevel: 0.055, holeR: 0.082, strata: 0.0 },
};

export const ARCHETYPE_NAMES = ["dendritic", "antcast", "brood", "shaft", "filigree", "termite"];
export const SHAPE_NAMES = Object.keys(BLOCK_SPECS);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function rnd(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

// Fast smooth isotropic-ish 3D value/trig fBm for baking static 3D wisps, frost blotches, and cast gnarl on CPU.
function hash3(ix, iy, iz) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1274126177);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function fbmCPU(x, y, z, octaves = 3) {
  let a = 0, w = 0.5;
  for (let i = 0; i < octaves; i++) {
    a += w * vnoise3(x, y, z);
    const nx = x * 0.8 - y * 0.6;
    const ny = x * 0.6 + y * 0.8;
    x = nx * 2.07 + 13.1;
    y = ny * 2.07 + 7.7;
    z = z * 2.07 + 19.3;
    w *= 0.5;
  }
  return a;
}

// Shared tileable 48³ noise: R = value, GBA = its gradient.
//   R   = seamless value noise (0..1)
//   GBA = smooth 3D gradient (0..1 mapped from -1..+1)
export const NOISE_SIZE = 48;
export function sharedNoiseBytes() {
  const S = NOISE_SIZE;
  const P = 12; // integer period so noise tiles seamlessly at S
  const hashP = (ix, iy, iz) => {
    const x = ((ix % P) + P) % P;
    const y = ((iy % P) + P) % P;
    const z = ((iz % P) + P) % P;
    return hash3(x + 17, y + 31, z + 53);
  };
  const tileNoise = (u, v, w) => {
    const x = u * P, y = v * P, z = w * P;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    fz = fz * fz * (3 - 2 * fz);
    const c000 = hashP(ix, iy, iz), c100 = hashP(ix + 1, iy, iz);
    const c010 = hashP(ix, iy + 1, iz), c110 = hashP(ix + 1, iy + 1, iz);
    const c001 = hashP(ix, iy, iz + 1), c101 = hashP(ix + 1, iy, iz + 1);
    const c011 = hashP(ix, iy + 1, iz + 1), c111 = hashP(ix + 1, iy + 1, iz + 1);
    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;
    return x00 + (x10 - x00) * fy + (x01 + (x11 - x01) * fy - (x00 + (x10 - x00) * fy)) * fz;
  };
  const vals = new Float32Array(S * S * S);
  const S2 = S * S;
  for (let k = 0; k < S; k++) {
    const w = k / S;
    for (let j = 0; j < S; j++) {
      const v = j / S;
      for (let i = 0; i < S; i++) {
        const u = i / S;
        // 2-octave rotated seamless noise for isotropic grain without axis-aligned squares.
        const n1 = tileNoise(u, v, w);
        const n2 = tileNoise(u * 2 + v, v * 2 - w, w * 2 + u);
        vals[i + j * S + k * S2] = n1 * 0.65 + n2 * 0.35;
      }
    }
  }
  const bytes = new Uint8Array(S * S * S * 4);
  for (let k = 0; k < S; k++) {
    const km = (k + S - 1) % S, kp = (k + 1) % S;
    for (let j = 0; j < S; j++) {
      const jm = (j + S - 1) % S, jp = (j + 1) % S;
      for (let i = 0; i < S; i++) {
        const im = (i + S - 1) % S, ip = (i + 1) % S;
        const idx = i + j * S + k * S2;
        const gx = (vals[ip + j * S + k * S2] - vals[im + j * S + k * S2]) * 2.4;
        const gy = (vals[i + jp * S + k * S2] - vals[i + jm * S + k * S2]) * 2.4;
        const gz = (vals[i + j * S + kp * S2] - vals[i + j * S + km * S2]) * 2.4;
        const o = idx * 4;
        bytes[o] = Math.round(clamp(vals[idx], 0, 1) * 255);
        bytes[o + 1] = Math.round(clamp(gx * 0.5 + 0.5, 0, 1) * 255);
        bytes[o + 2] = Math.round(clamp(gy * 0.5 + 0.5, 0, 1) * 255);
        bytes[o + 3] = Math.round(clamp(gz * 0.5 + 0.5, 0, 1) * 255);
      }
    }
  }
  return bytes;
}

// Signed distance to the encasing block in centered object space [-hy, +hy].
function sdBlockCentered(x, y, z, spec) {
  if (spec.type === 1) {
    const wx = Math.hypot(x, z) - (spec.hx - spec.bevel);
    const wy = Math.abs(y) - (spec.hy - spec.bevel);
    return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - spec.bevel;
  }
  if (spec.type === 3) {
    // Hexagonal prism in XZ (rotated 30° so 3 facets face the default 3/4 view cleanly).
    const r = spec.hx * 0.8660254;
    let qx = Math.abs(z), qz = Math.abs(x);
    const dot = -0.8660254 * qx + 0.5 * qz;
    if (dot < 0) {
      qx -= 2 * dot * -0.8660254;
      qz -= 2 * dot * 0.5;
    }
    const cx = clamp(qx, -0.57735027 * r, 0.57735027 * r);
    const dx = Math.hypot(qx - cx, qz - r) * Math.sign(qz - r);
    const dy = Math.abs(y) - spec.hy;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  if (spec.type === 5) {
    // Bell jar / cloche: cylinder crowned by hemisphere of radius hx.
    const hCyl = spec.hy - spec.hx;
    const dCap = Math.hypot(x, Math.max(y - hCyl, 0), z) - spec.hx;
    return Math.max(dCap, -spec.hy - y);
  }
  if (spec.type === 6) {
    // Tapered square monolith frustum.
    const t = clamp((y + spec.hy) / (2 * spec.hy), 0, 1);
    const rad = lerp(spec.hx, spec.hx * 0.6, t);
    const qx = Math.abs(x) - rad, qz = Math.abs(z) - rad;
    const dSide = (Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)) * 0.985;
    const dY = Math.abs(y) - spec.hy;
    return Math.max(dSide, dY);
  }
  if (spec.type === 7) {
    // Flat-bottomed spherical paperweight lens.
    const cy = -spec.hy + 0.6;
    const dSph = Math.hypot(x, y - cy, z) - 1.12;
    return Math.max(dSph, -spec.hy - y);
  }
  const qx = Math.abs(x) - (spec.hx - spec.bevel);
  const qy = Math.abs(y) - (spec.hy - spec.bevel);
  const qz = Math.abs(z) - (spec.hz - spec.bevel);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - spec.bevel;
}

// Pull any candidate point radially inward until it sits at least `margin` inside the active case SDF.
function clampInsideBlock(x, y, z, spec, margin) {
  const cy = clamp(y, -spec.hy + margin, spec.hy - margin);
  if (sdBlockCentered(x, cy, z, spec) <= -margin) return [x, cy, z];
  let lo = 0.0, hi = 1.0;
  for (let i = 0; i < 8; i++) {
    const mid = 0.5 * (lo + hi);
    if (sdBlockCentered(x * mid, cy, z * mid, spec) <= -margin) lo = mid;
    else hi = mid;
  }
  return [x * lo, cy, z * lo];
}

// Approximate usable interior half-extents [rx, rz] at height y for anisotropic shape-filling layouts.
function usableExtentsAtY(y, spec, margin) {
  let rx = Math.max(spec.hx - margin, 0.08);
  let rz = Math.max(spec.hz - margin, 0.08);
  if (spec.type === 3) {
    rx = Math.max(spec.hx * 0.866 - margin, 0.08);
    rz = Math.max(spec.hz * 0.866 - margin, 0.08);
  } else if (spec.type === 5) {
    const hCyl = spec.hy - spec.hx;
    const r = y > hCyl ? Math.sqrt(Math.max(0.01, spec.hx * spec.hx - (y - hCyl) * (y - hCyl))) : spec.hx;
    rx = rz = Math.max(r - margin, 0.08);
  } else if (spec.type === 6) {
    const tf = clamp((y + spec.hy) / (2 * spec.hy), 0, 1);
    rx = rz = Math.max(lerp(spec.hx, spec.hx * 0.6, tf) - margin, 0.08);
  } else if (spec.type === 7) {
    const dy = y - (-spec.hy + 0.60);
    const r = Math.sqrt(Math.max(0.01, 1.12 * 1.12 - dy * dy));
    rx = rz = Math.max(r - margin, 0.08);
  }
  return [rx, rz];
}

// Space colonization inside the block: naturally spaced branching that fills the case's silhouette.
function buildColonizedTree(spec, { attrCount, stepLen, baseRadius, minRadius, wander, broodChance, heatPower }) {
  const topY = spec.hy;
  const botY = -spec.hy;
  const spanY = topY - botY;
  const nodes = []; // { x, y, z, parent, children, depth, radius, heat }
  const attractors = [];

  // Tighter frosted border so branches visibly reach out to echo the selected case shape.
  const margin = Math.min(0.11, Math.min(spec.hx, spec.hz) * 0.24);
  const shellTarget = Math.round(attrCount * 0.45);
  let shellCount = 0;
  let tries = 0;
  while (attractors.length < attrCount && tries < attrCount * 22) {
    tries++;
    const x = rnd(-spec.hx + margin, spec.hx - margin);
    const y = rnd(botY + margin, topY - 0.16);
    const z = rnd(-spec.hz + margin, spec.hz - margin);
    const d = sdBlockCentered(x, y, z, spec);
    if (d > -margin) continue;
    // Reserve ~45% of attractors near the outer walls & lower corners so the burrow fills the full case volume.
    if (shellCount < shellTarget) {
      if (d < -0.32 && y > botY + spanY * 0.28) continue;
      shellCount++;
    }
    if (y > topY - 0.30 && Math.hypot(x, z) < 0.18 && Math.random() < 0.7) continue;
    attractors.push({ x, y, z, spent: false });
  }

  // Single enclosed upper hub inside the glass volume (no vertical nib on top).
  nodes.push({ x: 0, y: topY - 0.20, z: 0, parent: -1, children: 0, depth: 0, radius: baseRadius * 0.96, heat: 0 });

  // Seed initial splayed stubs scaled anisotropically to the case shape (e.g. wide left/right in slab).
  const initBranches = spec.type === 2 ? 4 : spec.type === 4 ? 6 : 5;
  for (let i = 0; i < initBranches; i++) {
    const ny = topY - rnd(0.22, 0.34);
    const [rx, rz] = usableExtentsAtY(ny, spec, margin);
    const a = (i / initBranches) * Math.PI * 2 + rnd(-0.26, 0.26);
    const scale = rnd(0.28, 0.46);
    const [nx, cy, nz] = clampInsideBlock(Math.cos(a) * rx * scale, ny, Math.sin(a) * rz * scale, spec, margin);
    nodes.push({ x: nx, y: cy, z: nz, parent: 0, children: 0, depth: 1, radius: baseRadius * 0.85, heat: 0 });
    nodes[0].children++;
  }

  const influence = Math.max(spec.hx, spec.hy, spec.hz) * 1.6;
  const killDist = stepLen * 2.05;

  for (let iter = 0; iter < 76; iter++) {
    const pullX = new Float32Array(nodes.length);
    const pullY = new Float32Array(nodes.length);
    const pullZ = new Float32Array(nodes.length);
    const pullN = new Uint16Array(nodes.length);

    let active = 0;
    for (let a = 0; a < attractors.length; a++) {
      const att = attractors[a];
      if (att.spent) continue;
      let best = influence;
      let bestI = -1;
      for (let i = 1; i < nodes.length; i++) {
        const nd = nodes[i];
        const d = Math.hypot(att.x - nd.x, att.y - nd.y, att.z - nd.z);
        if (d < killDist) {
          att.spent = true;
          bestI = -1;
          break;
        }
        if (d < best) {
          best = d;
          bestI = i;
        }
      }
      if (bestI >= 0) {
        const nd = nodes[bestI];
        const inv = 1 / Math.max(best, 1e-4);
        pullX[bestI] += (att.x - nd.x) * inv;
        pullY[bestI] += (att.y - nd.y) * inv;
        pullZ[bestI] += (att.z - nd.z) * inv;
        pullN[bestI]++;
        active++;
      }
    }
    if (active === 0 || nodes.length > 340) break;

    const countBefore = nodes.length;
    for (let i = 1; i < countBefore; i++) {
      if (!pullN[i]) continue;
      const nd = nodes[i];
      let dx = pullX[i] / pullN[i] + rnd(-wander, wander);
      let dy = pullY[i] / pullN[i] + rnd(-wander * 0.45, wander * 0.35) - 0.14;
      let dz = pullZ[i] / pullN[i] + rnd(-wander, wander);
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const nx = nd.x + dx * stepLen;
      const ny = nd.y + dy * stepLen;
      const nz = nd.z + dz * stepLen;
      if (sdBlockCentered(nx, ny, nz, spec) > -margin * 0.85) continue;
      // No creeping along the floor: low branches end instead of spreading flat across it.
      if (ny < botY + margin + 0.08 && dy > -0.6) continue;
      nodes.push({ x: nx, y: ny, z: nz, parent: i, children: 0, depth: nd.depth + 1, radius: minRadius, heat: 0 });
      nd.children++;
    }
  }

  // Pipe-model radius propagation from tips back to root (Murray's law: r^2.4 = sum(child r^2.4)).
  const weight = new Float32Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (nd.children === 0) {
      weight[i] = 1.0;
    }
    if (nd.parent >= 0) {
      weight[nd.parent] += weight[i];
    }
  }
  const maxW = Math.max(weight[0], 1);
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const frac = Math.pow(weight[i] / maxW, 0.42);
    nd.radius = lerp(minRadius, baseRadius, frac);
    // Heat concentrates toward the lower half and the tips.
    const lowFrac = smoothstep(topY * 0.25, botY * 0.82, nd.y);
    const tipBoost = nd.children === 0 ? 0.32 : 0.0;
    nd.heat = clamp(Math.pow(lowFrac, heatPower) + tipBoost * smoothstep(topY * 0.35, botY * 0.35, nd.y), 0, 1);
  }

  const capsules = [];
  const spheres = [];
  for (let i = 1; i < nodes.length; i++) {
    const b = nodes[i];
    const a = nodes[b.parent];
    // Tag each capsule with its branch segment chain so consecutive segments join cleanly without metaball beading.
    capsules.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra: a.radius, rb: b.radius, ha: a.heat, hb: b.heat, chain: a.children === 1 ? a.parent : i });
    // Swollen brood chambers along mid-sized tunnels.
    if (broodChance > 0 && b.children > 0 && b.depth >= 3 && Math.random() < broodChance) {
      const cr = b.radius * rnd(1.65, 2.25);
      spheres.push({ cx: b.x, cy: b.y, cz: b.z, rx: cr * rnd(0.9, 1.2), ry: cr * rnd(0.8, 1.1), rz: cr * rnd(0.9, 1.2), heat: b.heat });
    }
    // Fine dead-end capillary spurs off larger branches for natural cast-in-soil intricacy.
    if (b.depth >= 2 && b.radius > minRadius * 1.4 && Math.random() < 0.24 && b.y > botY + margin + 0.2) {
      // A short wandering spur in three bent, tapering segments, as warm as the branch it leaves.
      let ang = rnd(0, 6.28);
      const sLen = rnd(0.08, 0.19) / 3;
      let px = b.x, py = b.y, pz = b.z, pr = b.radius * 0.52;
      for (let k = 0; k < 3; k++) {
        ang += rnd(-0.7, 0.7);
        const r = lerp(b.radius * 0.52, minRadius * 0.6, (k + 1) / 3);
        const [sx, sy, sz] = clampInsideBlock(px + Math.cos(ang) * sLen, py - rnd(0.005, 0.05), pz + Math.sin(ang) * sLen, spec, margin);
        capsules.push({ ax: px, ay: py, az: pz, bx: sx, by: sy, bz: sz, ra: pr, rb: r, ha: b.heat, hb: b.heat, chain: 10000 + i });
        px = sx; py = sy; pz = sz; pr = r;
      }
    }
    // Organic tapered teardrop tip on some hot lower terminations (varied, not identical spheres on every tip).
    if (b.children === 0 && b.heat > 0.6 && Math.random() < 0.55) {
      const tr = b.radius * rnd(1.15, 1.65);
      spheres.push({ cx: b.x, cy: b.y - tr * 0.38, cz: b.z, rx: tr * rnd(0.75, 1.0), ry: tr * rnd(1.2, 1.65), rz: tr * rnd(0.75, 1.0), heat: clamp(b.heat * 1.15, 0, 1) });
    }
  }
  return { capsules, spheres, discs: [] };
}

function buildAntcastPrimitives(spec, complexity) {
  // Authentic cast-aluminum ant-nest architecture (Tschinkel Pogonomyrmex / Solenopsis style)
  // adapted to fill the active case volume (wide panoramic chambers in slab, flared base in monolith,
  // equatorial spread in paperweight, tall tiered shelves in column).
  const topY = spec.hy;
  const botY = -spec.hy;
  const spanY = topY - botY;
  const margin = Math.min(0.11, Math.min(spec.hx, spec.hz) * 0.24);
  const radScale = Math.max(spec.hx, spec.hz) * 0.88;
  const isSlab = spec.type === 4;
  const capsules = [];
  const spheres = [];
  const discs = [];
  let chainId = 1;

  // Build an organic multi-lobed horizontal chamber (2-4 overlapping thin wafers jutting asymmetrically).
  function addLobedChamber(cx, cy, cz, baseRadius, heat, dirAngle) {
    const lobes = Math.random() < 0.3 ? 2 : Math.random() < 0.72 ? 3 : 4;
    const tiltX = rnd(-0.07, 0.07);
    const tiltZ = rnd(-0.07, 0.07);
    const [rxAtY, rzAtY] = usableExtentsAtY(cy, spec, margin);
    const maxDiscR = Math.min(baseRadius * 1.15, Math.min(rxAtY, rzAtY) * (isSlab ? 0.85 : 0.46));
    for (let l = 0; l < lobes; l++) {
      const a = isSlab
        ? (Math.random() < 0.5 ? 0 : Math.PI) + rnd(-0.55, 0.55)
        : dirAngle + (l === 0 ? 0 : rnd(-1.35, 1.35));
      const off = l === 0 ? baseRadius * rnd(0.18, 0.45) : baseRadius * rnd(0.38, 0.95);
      const lr = Math.min(baseRadius * (l === 0 ? rnd(0.75, 1.05) : rnd(0.45, 0.85)), maxDiscR);
      const [lx, ly, lz] = clampInsideBlock(cx + Math.cos(a) * off, cy + rnd(-0.012, 0.012), cz + Math.sin(a) * off, spec, margin + lr * 0.65);
      const thick = rnd(0.014, 0.022);
      discs.push({
        cx: lx,
        cy: ly,
        cz: lz,
        radius: Math.max(lr, 0.06),
        thickness: thick,
        tiltX: tiltX + rnd(-0.04, 0.04),
        tiltZ: tiltZ + rnd(-0.04, 0.04),
        phase: rnd(0, 6.28),
        wobble: rnd(0.18, 0.32),
        heat,
      });
    }
  }

  // Enclosed upper nest cluster (no top pour nib).
  const entryY = topY - spanY * 0.13;

  // Dense upper colony cluster of overlapping multi-lobed shelves just below the entrance.
  const upperChambers = Math.round(lerp(4, 6, complexity));
  const [entryRx, entryRz] = usableExtentsAtY(entryY - 0.1, spec, margin);
  for (let i = 0; i < upperChambers; i++) {
    const a = (i / upperChambers) * Math.PI * 2 + rnd(-0.35, 0.35);
    const frac = rnd(0.18, 0.52);
    const cy = entryY - i * rnd(0.038, 0.062);
    const [ux, uy, uz] = clampInsideBlock(Math.cos(a) * entryRx * frac, cy, Math.sin(a) * entryRz * frac, spec, margin + 0.08);
    addLobedChamber(ux, uy, uz, radScale * rnd(0.24, 0.36), 0.0, a);
    capsules.push({
      ax: 0, ay: entryY, az: 0,
      bx: ux, by: uy, bz: uz,
      ra: 0.028, rb: 0.022, ha: 0, hb: 0, chain: chainId++,
    });
  }

  // 2-4 slender, organically wandering shafts filling the full cross-section of the case.
  const numShafts = spec.type === 2 ? 2 : isSlab ? Math.round(lerp(3, 5, complexity)) : Math.round(lerp(3, 4, complexity));
  for (let s = 0; s < numShafts; s++) {
    const cId = chainId++;
    const startAng = isSlab
      ? (s / Math.max(numShafts - 1, 1) < 0.5 ? Math.PI : 0) + rnd(-0.22, 0.22)
      : (s / numShafts) * Math.PI * 2 + rnd(-0.45, 0.45);
    const startFrac = isSlab ? Math.abs((s / Math.max(numShafts - 1, 1)) * 2 - 1) * 0.72 + 0.08 : (s === 0 ? rnd(0.10, 0.24) : rnd(0.36, 0.62));
    const py0 = entryY - rnd(0.05, 0.16);
    const [srx, srz] = usableExtentsAtY(py0, spec, margin + 0.08);
    const dirSign = isSlab ? ((s / Math.max(numShafts - 1, 1)) * 2 - 1) : 1;
    let [px, py, pz] = isSlab
      ? clampInsideBlock(dirSign * srx * 0.78 + rnd(-0.08, 0.08), py0, rnd(-srz * 0.35, srz * 0.35), spec, margin + 0.06)
      : clampInsideBlock(Math.cos(startAng) * srx * startFrac, py0, Math.sin(startAng) * srz * startFrac, spec, margin + 0.06);

    // Connect top entry to shaft origin.
    capsules.push({ ax: 0, ay: entryY, az: 0, bx: px, by: py, bz: pz, ra: 0.03, rb: 0.024, ha: 0, hb: 0, chain: cId });

    const endY = botY + margin + spanY * rnd(0.05, 0.14);
    const segs = 28;
    const helixDir = s % 2 === 0 ? 1 : -1;
    const helixTurns = rnd(1.0, 2.0);
    const helixPhase = rnd(0, 6.28);
    // Normalized radial anchor so shafts flare out automatically into wider lower zones (monolith/paperweight/dome).
    const anchorNormX = px / Math.max(srx, 0.12);
    const anchorNormZ = pz / Math.max(srz, 0.12);
    const driftNormX = rnd(-0.22, 0.22);
    const driftNormZ = rnd(-0.22, 0.22);
    let prevR = 0.025;
    let prevH = 0;

    const chamberCount = Math.round(lerp(5, 8, complexity));
    const chamberTs = [];
    for (let c = 0; c < chamberCount; c++) {
      chamberTs.push(clamp((c + rnd(0.15, 0.85)) / chamberCount, 0.07, 0.94));
    }
    let nextChamber = 0;

    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const nyTarget = lerp(py, endY, 1 / (segs - i + 1));
      const [rxY, rzY] = usableExtentsAtY(nyTarget, spec, margin + 0.06);
      const ang = helixPhase + helixDir * t * helixTurns * Math.PI * 2 + Math.sin(t * 7.3 + s) * 0.45;
      const swayFrac = lerp(0.18, 0.11, t) * (0.7 + 0.5 * Math.sin(t * 9.1 + helixPhase));
      const tx = (anchorNormX + driftNormX * t) * rxY * 0.92 + Math.cos(ang) * rxY * swayFrac;
      const tz = (anchorNormZ + driftNormZ * t) * rzY * 0.92 + Math.sin(ang) * rzY * swayFrac;
      const [nx, ny, nz] = clampInsideBlock(tx, nyTarget, tz, spec, margin + 0.05);
      const curR = lerp(0.026, 0.017, t) * rnd(0.86, 1.14);
      const curH = smoothstep(0.60, 0.98, t);

      capsules.push({ ax: px, ay: py, az: pz, bx: nx, by: ny, bz: nz, ra: prevR, rb: curR, ha: prevH, hb: curH, chain: cId });

      while (nextChamber < chamberTs.length && t >= chamberTs[nextChamber]) {
        const sizeScale = lerp(0.32, 0.18, t) * rnd(0.78, 1.25);
        const shelfDir = ang + rnd(-1.2, 1.2);
        addLobedChamber(nx, ny, nz, Math.max(rxY, rzY) * sizeScale, curH * 0.92, shelfDir);

        if (i < segs - 4 && Math.random() < 0.35) {
          const loopAng = shelfDir + rnd(0.8, 1.8);
          const loopR = rnd(0.08, 0.17);
          const [mx, my, mz] = clampInsideBlock(nx + Math.cos(loopAng) * loopR, ny - rnd(0.07, 0.14), nz + Math.sin(loopAng) * loopR, spec, margin + 0.04);
          const loopId = chainId++;
          capsules.push({ ax: nx, ay: ny, az: nz, bx: mx, by: my, bz: mz, ra: 0.018, rb: 0.016, ha: curH, hb: curH, chain: loopId });
          capsules.push({ ax: mx, ay: my, az: mz, bx: nx, by: Math.max(endY, my - rnd(0.08, 0.14)), bz: nz, ra: 0.016, rb: 0.018, ha: curH, hb: clamp(curH + 0.12, 0, 1), chain: loopId });
        }
        nextChamber++;
      }

      px = nx; py = ny; pz = nz; prevR = curR; prevH = curH;
    }

    const stalactites = Math.random() < 0.5 ? 1 : 2;
    for (let d = 0; d < stalactites; d++) {
      const tipId = chainId++;
      const a = rnd(0, 6.28);
      const [tx, ty, tz] = clampInsideBlock(px + Math.cos(a) * rnd(0.03, 0.12), Math.max(botY + margin, py - rnd(0.14, 0.26)), pz + Math.sin(a) * rnd(0.03, 0.12), spec, margin);
      capsules.push({ ax: px, ay: py, az: pz, bx: tx, by: ty, bz: tz, ra: 0.022, rb: 0.015, ha: 0.82, hb: 1.0, chain: tipId });
      spheres.push({ cx: tx, cy: ty - 0.015, cz: tz, rx: 0.022, ry: 0.036, rz: 0.022, heat: 1.0 });
    }
  }

  return { capsules, spheres, discs };
}

function buildShaftPrimitives(spec, complexity) {
  const topY = spec.hy;
  const botY = -spec.hy;
  const spanY = topY - botY;
  const margin = Math.min(0.10, Math.min(spec.hx, spec.hz) * 0.22);
  const isSlab = spec.type === 4;
  const capsules = [];
  const spheres = [];

  // Organic multi-frequency meandering main shaft filling the vertical span.
  const p1 = rnd(0, 6.28), p2 = rnd(0, 6.28), p3 = rnd(0, 6.28);
  const segs = 28;
  const shaftPts = [];
  let cx = 0, cy = topY - 0.16, cz = 0;
  shaftPts.push({ x: cx, y: cy, z: cz, r: 0.070, h: 0 });

  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const nyTarget = lerp(topY - 0.16, lerp(topY, botY, 0.82), t);
    const [rxY, rzY] = usableExtentsAtY(nyTarget, spec, margin + 0.04);
    const env = Math.sin(Math.min(t * 1.15, 1.0) * Math.PI * 0.92);
    const wx = (Math.sin(t * 4.2 + p1) * 0.65 + Math.cos(t * 9.7 + p2) * 0.25 + Math.sin(t * 17.3 + p3) * 0.1) * rxY * 0.58 * env;
    const wz = (Math.cos(t * 3.6 + p2) * 0.65 + Math.sin(t * 8.9 + p3) * 0.25 + Math.cos(t * 15.1 + p1) * 0.1) * rzY * 0.58 * env;
    const [nx, ny, nz] = clampInsideBlock(wx, nyTarget, wz, spec, margin);
    const pinch = 0.82 + 0.34 * (0.5 + 0.5 * Math.sin(t * 19.0 + p1));
    const r = lerp(0.070, 0.036, t) * pinch;
    const h = smoothstep(0.55, 0.98, t) * 0.78;
    capsules.push({
      ax: cx, ay: cy, az: cz, bx: nx, by: ny, bz: nz,
      ra: shaftPts[i - 1].r, rb: r, ha: shaftPts[i - 1].h, hb: h,
      chain: 1,
    });
    shaftPts.push({ x: nx, y: ny, z: nz, r, h });
    cx = nx; cy = ny; cz = nz;
  }

  // Recursive organic sub-branch helper that reaches outward into the full case silhouette.
  let chainCounter = 2;
  function addFork(start, dirX, dirY, dirZ, startR, len, steps, startH, endH, depth, maxDepth) {
    const chainId = chainCounter++;
    let px = start.x, py = start.y, pz = start.z;
    let vx = dirX, vy = dirY, vz = dirZ;
    const stepL = len / steps;
    let prevR = startR;
    let prevH = startH;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      vx += rnd(-0.34, 0.34);
      vy += rnd(-0.24, 0.12) - 0.14;
      vz += rnd(-0.34, 0.34) * (isSlab ? 0.35 : 1.0);
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      const [nx, ny, nz] = clampInsideBlock(px + vx * stepL, Math.max(botY + margin, py + vy * stepL), pz + vz * stepL, spec, margin);
      const curR = Math.max(0.017, lerp(startR, startR * 0.36, t) * rnd(0.86, 1.14));
      const curH = lerp(startH, endH, t);
      capsules.push({ ax: px, ay: py, az: pz, bx: nx, by: ny, bz: nz, ra: prevR, rb: curR, ha: prevH, hb: curH, chain: chainId });

      if (depth < maxDepth && s >= 2 && s < steps - 1 && Math.random() < 0.46) {
        const ang = Math.atan2(vz, vx) + (Math.random() < 0.5 ? 1 : -1) * rnd(0.55, 1.4);
        addFork(
          { x: nx, y: ny, z: nz },
          Math.cos(ang) * rnd(0.45, 0.9),
          rnd(-0.85, -0.3),
          Math.sin(ang) * rnd(0.45, 0.9) * (isSlab ? 0.35 : 1.0),
          curR * rnd(0.68, 0.86),
          len * rnd(0.5, 0.78),
          Math.max(4, Math.floor(steps * 0.68)),
          curH,
          clamp(curH + rnd(0.28, 0.55), 0, 1),
          depth + 1,
          maxDepth,
        );
      }
      px = nx; py = ny; pz = nz; prevR = curR; prevH = curH;
    }

    if (prevH > 0.52 && Math.random() < 0.72) {
      const tr = prevR * rnd(1.5, 2.3);
      spheres.push({
        cx: px + rnd(-0.012, 0.012),
        cy: py - tr * 0.45,
        cz: pz + rnd(-0.012, 0.012),
        rx: tr * rnd(0.75, 1.15),
        ry: tr * rnd(1.25, 1.75),
        rz: tr * rnd(0.75, 1.15),
        heat: clamp(prevH * 1.18, 0, 1),
      });
    }
  }

  // Peel staggered asymmetric branches off the main shaft from 22% down to 100%, scaled to the case extents.
  const numForks = Math.round(lerp(7, 12, complexity));
  const maxSpan = Math.max(spec.hx, spec.hz) * 2.0;
  for (let i = 0; i < numForks; i++) {
    const idx = Math.min(segs, Math.max(5, Math.floor(lerp(segs * 0.22, segs, (i + rnd(0.1, 0.85)) / numForks))));
    const origin = shaftPts[idx];
    const [rxO, rzO] = usableExtentsAtY(origin.y, spec, margin);
    const az = isSlab
      ? (i % 2 === 0 ? 0 : Math.PI) + rnd(-0.38, 0.38)
      : i * 2.39996 + rnd(-0.4, 0.4);
    const isUpperSpur = idx < segs * 0.55;
    const reachScale = Math.max(rxO, rzO) / Math.max(Math.min(spec.hx, spec.hz), 0.35);
    const forkLen = Math.max(spanY * 0.34, maxSpan * 0.42) * (isUpperSpur ? rnd(0.65, 0.95) : rnd(0.85, 1.25)) * Math.min(reachScale, 1.45);
    addFork(
      origin,
      Math.cos(az) * rxO,
      isUpperSpur ? rnd(-0.75, -0.25) : rnd(-1.05, -0.55),
      Math.sin(az) * rzO,
      origin.r * (isUpperSpur ? rnd(0.58, 0.78) : rnd(0.75, 0.92)),
      forkLen,
      isUpperSpur ? 7 : 9,
      origin.h,
      isUpperSpur ? clamp(origin.h + 0.38, 0, 0.85) : 1.0,
      0,
      isUpperSpur ? 1 : 2,
    );
  }
  return { capsules, spheres, discs: [] };
}

// Cathedral termite mound: smoothly arched vertical fluted chimneys bridged by curved galleries.
function buildTermitePrimitives(spec, complexity) {
  const topY = spec.hy;
  const botY = -spec.hy;
  const spanY = topY - botY;
  const margin = Math.min(0.11, Math.min(spec.hx, spec.hz) * 0.24);
  const isSlab = spec.type === 4;
  const capsules = [];
  const spheres = [];
  let chainId = 1;

  const numChimneys = spec.type === 2 ? 3 : Math.round(lerp(4, 6, complexity));
  const chimneyPaths = [];

  for (let c = 0; c < numChimneys; c++) {
    const cId = chainId++;
    const segs = 26;
    const isCenter = !isSlab && c === 0;
    const ang = isSlab ? 0 : ((c - 1) / Math.max(numChimneys - 1, 1)) * Math.PI * 2 + rnd(-0.34, 0.34);
    const slabNormX = isSlab ? ((c / Math.max(numChimneys - 1, 1)) * 2 - 1) * 0.80 : 0;
    const targetFrac = isCenter ? rnd(0.06, 0.18) : rnd(0.50, 0.78);
    const phase = rnd(0, 6.28);
    const archSpan = rnd(0.32, 0.52); // a gradual shoulder, not an elbow
    const pts = [];

    let px = 0, py = topY - 0.16, pz = 0;
    let prevR = isCenter ? 0.062 : 0.052;
    let prevH = 0;
    pts.push({ x: px, y: py, z: pz, h: 0 });

    const endY = botY + margin + spanY * rnd(0.04, 0.14);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const nyTarget = lerp(topY - 0.16, endY, t);
      const [rxY, rzY] = usableExtentsAtY(nyTarget, spec, margin + 0.06);
      // A smooth flare from the crown into the outer chimney.
      const flare = smoothstep(0.0, archSpan, t);
      const sway = Math.sin(t * 7.2 + phase) * 0.11 * flare;
      const rad = targetFrac * flare;
      const tx = isSlab ? (slabNormX * flare + sway * 0.7) * rxY : Math.cos(ang + sway) * rxY * rad;
      const tz = isSlab ? Math.cos(t * 5.8 + phase) * rzY * 0.28 * flare : Math.sin(ang + sway) * rzY * rad;
      const [nx, ny, nz] = clampInsideBlock(tx, nyTarget, tz, spec, margin + 0.04);
      // Organic cathedral fluting / ribbing along the descending chimney.
      const flute = 0.78 + 0.38 * (0.5 + 0.5 * Math.sin(t * 25.0 + phase));
      const curR = lerp(0.050, 0.028, t) * flute * (isCenter ? 1.2 : 1.0);
      const curH = smoothstep(0.56, 0.98, t);
      capsules.push({ ax: px, ay: py, az: pz, bx: nx, by: ny, bz: nz, ra: prevR, rb: curR, ha: prevH, hb: curH, chain: cId });
      pts.push({ x: nx, y: ny, z: nz, h: curH });
      if (i > 6 && i < segs - 2 && Math.random() < 0.16) {
        const ar = curR * rnd(1.4, 2.0);
        spheres.push({ cx: nx, cy: ny, cz: nz, rx: ar * 1.15, ry: ar * 0.78, rz: ar * 1.15, heat: curH });
      }
      px = nx; py = ny; pz = nz; prevR = curR; prevH = curH;
    }
    chimneyPaths.push(pts);
  }

  // Arched cross-galleries bridging neighboring chimneys at staggered elevations.
  const bridges = Math.round(lerp(8, 15, complexity));
  for (let b = 0; b < bridges; b++) {
    const aIdx = b % numChimneys;
    const bIdx = isSlab ? Math.min(numChimneys - 1, aIdx + 1) : (aIdx + 1 + Math.floor(rnd(0, Math.max(1, numChimneys - 2)))) % numChimneys;
    if (aIdx === bIdx) continue;
    const pa = chimneyPaths[aIdx];
    const pb = chimneyPaths[bIdx];
    const rowA = Math.floor(rnd(6, pa.length - 2));
    const rowB = clamp(rowA + Math.round(rnd(-3, 3)), 6, pb.length - 2);
    const p1 = pa[rowA], p2 = pb[rowB];
    const mid = clampInsideBlock(0.5 * (p1.x + p2.x) + rnd(-0.05, 0.05), 0.5 * (p1.y + p2.y) + rnd(0.05, 0.14), 0.5 * (p1.z + p2.z) + rnd(-0.05, 0.05), spec, margin);
    const hMid = 0.5 * (p1.h + p2.h);
    const bId = chainId++;
    capsules.push({ ax: p1.x, ay: p1.y, az: p1.z, bx: mid[0], by: mid[1], bz: mid[2], ra: 0.025, rb: 0.020, ha: p1.h, hb: hMid, chain: bId });
    capsules.push({ ax: mid[0], ay: mid[1], az: mid[2], bx: p2.x, by: p2.y, bz: p2.z, ra: 0.020, rb: 0.025, ha: hMid, hb: p2.h, chain: bId });
  }
  return { capsules, spheres, discs: [] };
}

// The seeded part of the bake (uses Math.random, so it runs on the page): the burrow's primitives.
export function buildBurrowPrimitives({ archetype = "dendritic", shape = "cube", complexity = 0.65 }) {
  const spec = BLOCK_SPECS[shape] || BLOCK_SPECS.cube;
  let prims;
  let blendK = 0.048;

  if (archetype === "antcast") {
    prims = buildAntcastPrimitives(spec, complexity);
    blendK = 0.022;
  } else if (archetype === "shaft") {
    prims = buildShaftPrimitives(spec, complexity);
    blendK = 0.024;
  } else if (archetype === "termite") {
    prims = buildTermitePrimitives(spec, complexity);
    blendK = 0.028;
  } else if (archetype === "brood") {
    prims = buildColonizedTree(spec, {
      attrCount: Math.round(lerp(80, 155, complexity)),
      stepLen: 0.095,
      baseRadius: 0.088,
      minRadius: 0.018,
      wander: 0.36,
      broodChance: 0.3,
      heatPower: 1.5,
    });
    blendK = 0.026;
  } else if (archetype === "filigree") {
    prims = buildColonizedTree(spec, {
      attrCount: Math.round(lerp(130, 220, complexity)),
      stepLen: 0.078,
      baseRadius: 0.056,
      minRadius: 0.014,
      wander: 0.44,
      broodChance: 0.0,
      heatPower: 1.8,
    });
    blendK = 0.018;
  } else {
    // dendritic hero archetype
    prims = buildColonizedTree(spec, {
      attrCount: Math.round(lerp(90, 170, complexity)),
      stepLen: 0.09,
      baseRadius: 0.088,
      minRadius: 0.018,
      wander: 0.40,
      broodChance: 0.08,
      heatPower: 1.55,
    });
    blendK = 0.024;
  }
  return { prims, blendK, shape };
}

// The heavy, deterministic part: rasterize, flood the pour, pack. Returns plain arrays (transferable from a worker).
export function rasterizeBurrow({ prims, blendK, shape, T = 112, G = 48 }) {
  const spec = BLOCK_SPECS[shape] || BLOCK_SPECS.cube;
  const voxel = (2 * EXTENT) / T;
  const bandWorld = BAND * voxel;
  const N = T * T * T;
  const distGrid = new Float32Array(N);
  const heatGrid = new Float32Array(N);
  const streamGrid = new Float32Array(N);
  const chainGrid = new Int32Array(N);
  distGrid.fill(bandWorld);
  streamGrid.fill(1.0);
  chainGrid.fill(-1);

  const smin = (a, b, k) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  };

  const toIdx = (v) => clamp(Math.floor((v + EXTENT) / voxel), 0, T - 1);
  const pad = bandWorld + blendK;

  // Each primitive only into its own bounding box of voxels.
  for (let p = 0; p < prims.capsules.length; p++) {
    const c = prims.capsules[p];
    const rMax = Math.max(c.ra, c.rb) + pad;
    const ix0 = toIdx(Math.min(c.ax, c.bx) - rMax);
    const ix1 = toIdx(Math.max(c.ax, c.bx) + rMax);
    const iy0 = toIdx(Math.min(c.ay, c.by) - rMax);
    const iy1 = toIdx(Math.max(c.ay, c.by) + rMax);
    const iz0 = toIdx(Math.min(c.az, c.bz) - rMax);
    const iz1 = toIdx(Math.max(c.az, c.bz) + rMax);
    const dx = c.bx - c.ax;
    const dy = c.by - c.ay;
    const dz = c.bz - c.az;
    const lenSq = Math.max(dx * dx + dy * dy + dz * dz, 1e-8);

    for (let k = iz0; k <= iz1; k++) {
      const z = -EXTENT + (k + 0.5) * voxel;
      const pz = z - c.az;
      const kOff = k * T * T;
      for (let j = iy0; j <= iy1; j++) {
        const y = -EXTENT + (j + 0.5) * voxel;
        const py = y - c.ay;
        const jkOff = kOff + j * T;
        for (let i = ix0; i <= ix1; i++) {
          const x = -EXTENT + (i + 0.5) * voxel;
          const px = x - c.ax;
          const t = clamp((px * dx + py * dy + pz * dz) / lenSq, 0, 1);
          const d = Math.hypot(px - dx * t, py - dy * t, pz - dz * t) - (c.ra + (c.rb - c.ra) * t);
          if (d < bandWorld) {
            const idx = jkOff + i;
            const prev = distGrid[idx];
            // Use sharp min along the same branch chain to eliminate metaball sausage-beading;
            // use tight smin only at distinct branch junctions.
            const cid = c.chain ?? -2;
            const merged = cid >= 0 && chainGrid[idx] === cid ? Math.min(prev, d) : smin(prev, d, blendK);
            if (merged < prev) {
              const hNew = c.ha + (c.hb - c.ha) * t;
              const w = smoothstep(blendK, -blendK * 0.5, d - prev);
              heatGrid[idx] = prev >= bandWorld * 0.99 ? hNew : lerp(heatGrid[idx], hNew, w);
              distGrid[idx] = merged;
              if (d < prev) chainGrid[idx] = cid;
            }
          }
        }
      }
    }
  }

  for (let p = 0; p < prims.spheres.length; p++) {
    const s = prims.spheres[p];
    const rMax = Math.max(s.rx, s.ry, s.rz) + pad;
    const ix0 = toIdx(s.cx - rMax);
    const ix1 = toIdx(s.cx + rMax);
    const iy0 = toIdx(s.cy - rMax);
    const iy1 = toIdx(s.cy + rMax);
    const iz0 = toIdx(s.cz - rMax);
    const iz1 = toIdx(s.cz + rMax);
    for (let k = iz0; k <= iz1; k++) {
      const z = -EXTENT + (k + 0.5) * voxel;
      const qz = z - s.cz;
      const kOff = k * T * T;
      for (let j = iy0; j <= iy1; j++) {
        const y = -EXTENT + (j + 0.5) * voxel;
        const qy = y - s.cy;
        const jkOff = kOff + j * T;
        for (let i = ix0; i <= ix1; i++) {
          const x = -EXTENT + (i + 0.5) * voxel;
          const qx = x - s.cx;
          const k0 = Math.hypot(qx / s.rx, qy / s.ry, qz / s.rz);
          const k1 = Math.hypot(qx / (s.rx * s.rx), qy / (s.ry * s.ry), qz / (s.rz * s.rz)) || 1e-6;
          const d = (k0 * (k0 - 1)) / k1;
          if (d < bandWorld) {
            const idx = jkOff + i;
            const prev = distGrid[idx];
            const merged = smin(prev, d, blendK);
            if (merged < prev) {
              const w = smoothstep(blendK, -blendK * 0.5, d - prev);
              heatGrid[idx] = prev >= bandWorld * 0.99 ? s.heat : lerp(heatGrid[idx], s.heat, w);
              distGrid[idx] = merged;
            }
          }
        }
      }
    }
  }

  for (let p = 0; p < prims.discs.length; p++) {
    const dc = prims.discs[p];
    const rMax = dc.radius * (1 + dc.wobble) + pad;
    const hMax = dc.thickness * 2.2 + dc.radius * 0.2 + pad;
    const ix0 = toIdx(dc.cx - rMax);
    const ix1 = toIdx(dc.cx + rMax);
    const iy0 = toIdx(dc.cy - hMax);
    const iy1 = toIdx(dc.cy + hMax);
    const iz0 = toIdx(dc.cz - rMax);
    const iz1 = toIdx(dc.cz + rMax);
    for (let k = iz0; k <= iz1; k++) {
      const z = -EXTENT + (k + 0.5) * voxel;
      const qz = z - dc.cz;
      const kOff = k * T * T;
      for (let j = iy0; j <= iy1; j++) {
        const y = -EXTENT + (j + 0.5) * voxel;
        const qy = y - dc.cy;
        const jkOff = kOff + j * T;
        for (let i = ix0; i <= ix1; i++) {
          const x = -EXTENT + (i + 0.5) * voxel;
          const qx = x - dc.cx;
          const ly = qy - qx * dc.tiltX - qz * dc.tiltZ;
          const ang = Math.atan2(qz, qx);
          const rim = 1 + dc.wobble * (0.6 * Math.sin(ang * 3 + dc.phase) + 0.4 * Math.cos(ang * 5 - dc.phase * 1.4));
          const radial = Math.hypot(qx, qz) - dc.radius * rim;
          const yScale = ly > 0 ? dc.thickness * 0.72 : dc.thickness * 1.25;
          const vert = Math.abs(ly) - yScale;
          const d = Math.min(Math.max(radial, vert), 0) + Math.hypot(Math.max(radial, 0), Math.max(vert, 0)) - 0.015;
          if (d < bandWorld) {
            const idx = jkOff + i;
            const prev = distGrid[idx];
            const merged = smin(prev, d, blendK);
            if (merged < prev) {
              const w = smoothstep(blendK, -blendK * 0.5, d - prev);
              heatGrid[idx] = prev >= bandWorld * 0.99 ? dc.heat : lerp(heatGrid[idx], dc.heat, w);
              distGrid[idx] = merged;
            }
          }
        }
      }
    }
  }

  // Exact 3D voxel Dijkstra from the top pour hole through the connected metal interior:
  // guarantees a continuous path to the end of every arm first (sorted longest -> shortest),
  // before the bottom-to-top pool swells each reached branch/chamber to full thickness.
  const T2 = T * T;
  {
    const insideThresh = 0.010;
    const dijkDist = new Float32Array(N).fill(1e9);
    const dijkParent = new Int32Array(N).fill(-1);
    const visited = new Uint8Array(N);
    const visitOrder = new Int32Array(N);
    let visitCount = 0;

    // Typed-array binary min-heap for fast O(M log M) Dijkstra on interior voxels.
    const heapIdx = new Int32Array(N);
    const heapKey = new Float32Array(N);
    let heapSize = 0;
    const heapPush = (idx, key) => {
      let c = heapSize++;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heapKey[p] <= key) break;
        heapIdx[c] = heapIdx[p];
        heapKey[c] = heapKey[p];
        c = p;
      }
      heapIdx[c] = idx;
      heapKey[c] = key;
    };
    const heapPop = () => {
      const top = heapIdx[0];
      heapSize--;
      if (heapSize > 0) {
        const lastIdx = heapIdx[heapSize];
        const lastKey = heapKey[heapSize];
        let p = 0;
        while (true) {
          let l = (p << 1) + 1;
          if (l >= heapSize) break;
          let r = l + 1;
          let s = r < heapSize && heapKey[r] < heapKey[l] ? r : l;
          if (lastKey <= heapKey[s]) break;
          heapIdx[p] = heapIdx[s];
          heapKey[p] = heapKey[s];
          p = s;
        }
        heapIdx[p] = lastIdx;
        heapKey[p] = lastKey;
      }
      return top;
    };

    // Seed all interior voxels near the upper enclosed crown of the burrow.
    const seedR2 = (spec.holeR + 0.18) * (spec.holeR + 0.18);
    const seedYMin = spec.hy - 0.34;
    let bestFallbackIdx = -1;
    let bestFallbackY = -1e9;
    for (let k = 0; k < T; k++) {
      const z = -EXTENT + (k + 0.5) * voxel;
      const kOff = k * T2;
      for (let j = 0; j < T; j++) {
        const y = -EXTENT + (j + 0.5) * voxel;
        const jkOff = kOff + j * T;
        for (let i = 0; i < T; i++) {
          const idx = jkOff + i;
          if (distGrid[idx] > insideThresh) continue;
          if (y > bestFallbackY) { bestFallbackY = y; bestFallbackIdx = idx; }
          if (y >= seedYMin) {
            const x = -EXTENT + (i + 0.5) * voxel;
            if (x * x + z * z <= seedR2) {
              const d0 = Math.max(0, (spec.hy - y) * 0.5);
              dijkDist[idx] = d0;
              heapPush(idx, d0);
            }
          }
        }
      }
    }
    if (heapSize === 0 && bestFallbackIdx >= 0) {
      dijkDist[bestFallbackIdx] = 0;
      heapPush(bestFallbackIdx, 0);
    }

    // 6-neighbor gravity-biased Dijkstra (down=0.65, sideways=1.0, up=1.50):
    // forms a solid, continuous flowing channel from the top hole down to the ends of the paths.
    const nOff = [-1, 1, -T, T, -T2, T2];
    const nCost = [1.0, 1.0, 0.65, 1.50, 1.0, 1.0];
    while (heapSize > 0) {
      const u = heapPop();
      if (visited[u]) continue;
      visited[u] = 1;
      visitOrder[visitCount++] = u;
      const du = dijkDist[u];
      const i = u % T;
      const rem = (u - i) / T;
      const j = rem % T;
      const k = (rem - j) / T;
      for (let dir = 0; dir < 6; dir++) {
        if ((dir === 0 && i === 0) || (dir === 1 && i === T - 1)) continue;
        if ((dir === 2 && j === 0) || (dir === 3 && j === T - 1)) continue;
        if ((dir === 4 && k === 0) || (dir === 5 && k === T - 1)) continue;
        const v = u + nOff[dir];
        if (visited[v] || distGrid[v] > insideThresh) continue;
        const nd = du + nCost[dir];
        if (nd < dijkDist[v]) {
          dijkDist[v] = nd;
          dijkParent[v] = u;
          heapPush(v, nd);
        }
      }
    }

    // Normalize pure connected Dijkstra arrival time (0 at top pour hole -> 1 at deepest ends)
    // so every cross-section flows as one solid continuous channel without skin-voxel lag.
    let globalMax = 1e-4;
    for (let q = 0; q < visitCount; q++) {
      const dv = dijkDist[visitOrder[q]];
      if (dv > globalMax) globalMax = dv;
    }
    const invGlobalMax = 1 / globalMax;
    for (let q = 0; q < visitCount; q++) {
      const v = visitOrder[q];
      streamGrid[v] = clamp(dijkDist[v] * invGlobalMax, 0.01, 0.99);
    }

    // Dilate streamT into the narrow exterior band (distGrid < bandWorld) so trilinear
    // interpolation right at the d=0 isosurface is exact and never lags toward 1.0.
    const filled = new Uint8Array(visited);
    for (let pass = 0; pass < 4; pass++) {
      const nextFilled = new Uint8Array(filled);
      for (let k = 1; k < T - 1; k++) {
        const kOff = k * T2;
        for (let j = 1; j < T - 1; j++) {
          const jkOff = kOff + j * T;
          for (let i = 1; i < T - 1; i++) {
            const idx = jkOff + i;
            if (filled[idx] || distGrid[idx] >= bandWorld) continue;
            let best = 2.0;
            for (let dir = 0; dir < 6; dir++) {
              const nb = idx + nOff[dir];
              if (filled[nb] && streamGrid[nb] < best) best = streamGrid[nb];
            }
            if (best < 1.5) {
              streamGrid[idx] = best;
              nextFilled[idx] = 1;
            }
          }
        }
      }
      filled.set(nextFilled);
    }
  }

  // Pack into RGBA half floats:
  //   R = narrow-band SDF, G = resting heat, B = Dijkstra longest-first stream arrival, A = bottom-to-top fill level.
  let minMetalY = spec.hy;
  for (let j = 0; j < T; j++) {
    const y = -EXTENT + (j + 0.5) * voxel;
    let found = false;
    for (let k = 0; k < T && !found; k++) {
      const jkOff = k * T2 + j * T;
      for (let i = 0; i < T; i++) {
        if (distGrid[jkOff + i] <= 0) { found = true; break; }
      }
    }
    if (found) { minMetalY = y; break; }
  }

  // Half floats: at 8 bits the distance's rounding showed in the normals and made highlights shimmer as the cast turned.
  const burrowBytes = new Uint16Array(N * 4);
  const half = toHalf;
  const inv2Band = 1 / (2 * bandWorld);
  const invPoolY = 1 / Math.max(spec.hy - minMetalY, 0.2);
  for (let k = 0; k < T; k++) {
    const z = -EXTENT + (k + 0.5) * voxel;
    const kOff = k * T2;
    for (let j = 0; j < T; j++) {
      const y = -EXTENT + (j + 0.5) * voxel;
      const yPool = clamp((y - minMetalY) * invPoolY, 0.01, 0.99);
      const jkOff = kOff + j * T;
      for (let i = 0; i < T; i++) {
        const idx = jkOff + i;
        let d = distGrid[idx];
        if (Math.abs(d) < 0.055) {
          const x = -EXTENT + (i + 0.5) * voxel;
          const macro = (vnoise3(x * 7.5, y * 7.5, z * 7.5) - 0.55) * 0.011;
          const ridge = (Math.abs(vnoise3(x * 17.0, y * 17.0, z * 17.0) * 2 - 1) - 0.52) * 0.008;
          d += clamp(macro + ridge, -0.014, 0.0055);
        }
        const s = clamp(0.5 - d * inv2Band, 0, 1);
        const h = clamp(heatGrid[idx], 0, 1);
        const f = clamp(streamGrid[idx], 0.01, 0.99);
        const o = idx * 4;
        burrowBytes[o] = half(s);
        burrowBytes[o + 1] = half(h);
        burrowBytes[o + 2] = half(f);
        burrowBytes[o + 3] = half(yPool);
      }
    }
  }

  // Build 3D volumetric ember glow field (G³) by downsampling molten heat where inside/near metal,
  // then blurred.
  const GN = G * G * G;
  let glowA = new Float32Array(GN);
  let glowB = new Float32Array(GN);
  const scaleT = T / G;
  for (let k = 0; k < G; k++) {
    const tk = clamp(Math.floor((k + 0.5) * scaleT), 0, T - 1);
    for (let j = 0; j < G; j++) {
      const tj = clamp(Math.floor((j + 0.5) * scaleT), 0, T - 1);
      for (let i = 0; i < G; i++) {
        const ti = clamp(Math.floor((i + 0.5) * scaleT), 0, T - 1);
        const idxT = ti + tj * T + tk * T * T;
        const d = distGrid[idxT];
        if (d < voxel * 1.5) {
          const h = heatGrid[idxT];
          if (h > 0.18) {
            glowA[i + j * G + k * G * G] = Math.pow(h, 1.45);
          }
        }
      }
    }
  }

  // 4 separable box-blur passes.
  const G2 = G * G;
  for (let pass = 0; pass < 4; pass++) {
    // X pass
    for (let k = 0; k < G; k++) {
      for (let j = 0; j < G; j++) {
        const row = j * G + k * G2;
        for (let i = 0; i < G; i++) {
          let sum = glowA[row + i] * 0.4;
          sum += glowA[row + Math.max(i - 1, 0)] * 0.22 + glowA[row + Math.min(i + 1, G - 1)] * 0.22;
          sum += glowA[row + Math.max(i - 2, 0)] * 0.08 + glowA[row + Math.min(i + 2, G - 1)] * 0.08;
          glowB[row + i] = sum;
        }
      }
    }
    // Y pass
    for (let k = 0; k < G; k++) {
      const slice = k * G2;
      for (let i = 0; i < G; i++) {
        for (let j = 0; j < G; j++) {
          let sum = glowB[slice + j * G + i] * 0.4;
          sum += glowB[slice + Math.max(j - 1, 0) * G + i] * 0.22 + glowB[slice + Math.min(j + 1, G - 1) * G + i] * 0.22;
          sum += glowB[slice + Math.max(j - 2, 0) * G + i] * 0.08 + glowB[slice + Math.min(j + 2, G - 1) * G + i] * 0.08;
          glowA[slice + j * G + i] = sum;
        }
      }
    }
    // Z pass
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const col = j * G + i;
        for (let k = 0; k < G; k++) {
          let sum = glowA[col + k * G2] * 0.4;
          sum += glowA[col + Math.max(k - 1, 0) * G2] * 0.22 + glowA[col + Math.min(k + 1, G - 1) * G2] * 0.22;
          sum += glowA[col + Math.max(k - 2, 0) * G2] * 0.08 + glowA[col + Math.min(k + 2, G - 1) * G2] * 0.08;
          glowB[col + k * G2] = sum;
        }
      }
    }
    const tmp = glowA;
    glowA = glowB;
    glowB = tmp;
  }

  let maxGlow = 0.01;
  for (let i = 0; i < GN; i++) if (glowA[i] > maxGlow) maxGlow = glowA[i];
  // Pack tGlow: R = ember glow, G = frost wisps, B = frost blotches, read in one fetch.
  const glowBytes = new Uint8Array(GN * 4);
  const gVoxel = (2 * EXTENT) / G;
  for (let k = 0; k < G; k++) {
    const z = -EXTENT + (k + 0.5) * gVoxel;
    const kOff = k * G2;
    for (let j = 0; j < G; j++) {
      const y = -EXTENT + (j + 0.5) * gVoxel;
      const jkOff = kOff + j * G;
      for (let i = 0; i < G; i++) {
        const x = -EXTENT + (i + 0.5) * gVoxel;
        const idx = jkOff + i;
        const v = clamp(glowA[idx] / maxGlow, 0, 1);
        const rByte = Math.round(Math.pow(v, 0.72) * 255);

        const wisp = fbmCPU(x * 1.45 + 1.3, y * 1.45 - 0.7, z * 1.45 + 2.9, 3);
        const gByte = Math.round(smoothstep(0.28, 0.74, wisp) * 255);

        const wx = vnoise3(x * 1.3 + 1.7, y * 1.3 + 4.3, z * 1.3 + 2.9) - 0.5;
        const wy = vnoise3(x * 1.3 + 8.1, y * 1.3 + 2.4, z * 1.3 + 6.2) - 0.5;
        const wz = vnoise3(x * 1.3 + 3.9, y * 1.3 + 7.7, z * 1.3 + 1.3) - 0.5;
        const macro = fbmCPU((x + wx * 0.45) * 1.25, (y + wy * 0.45) * 1.25, (z + wz * 0.45) * 1.25, 3);
        const med = fbmCPU(x * 3.6 + wx * 0.5, y * 3.6 + wy * 0.5, z * 3.6 + wz * 0.5, 2);
        const bByte = Math.round(smoothstep(0.24, 0.78, macro * 0.68 + med * 0.32) * 255);

        const o = idx * 4;
        glowBytes[o] = rByte;
        glowBytes[o + 1] = gByte;
        glowBytes[o + 2] = bByte;
        glowBytes[o + 3] = 255;
      }
    }
  }

  return { burrowData: burrowBytes, glowData: glowBytes, T, G, voxel, bandWorld };
}
