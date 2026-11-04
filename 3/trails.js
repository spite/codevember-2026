// Wet trails left by running blobs: polylines of (x, y, z, thickness) on the rest surface, newest point first.
// A full trail chains into a new slot, so thick points are never dropped; points leave the old end once healed.
// The slots of one chain blend with a smooth max, so a chain reads as one stream; separate chains add as a p-norm.
// The cross-section is a low flat-topped film; free chain ends fade in height over TAPER_LEN.
export const TRAIL_ASPECT = 0.8;
// p of the union between chains: below the blob union's, so side-by-side trails fill in to a sheet.
export const CHAIN_P = 1.6;
// Film cross-section th·(1 − r⁴/w⁴)² integrates to th·w·64/45.
const SECTION = 64 / 45;
const TURN = Math.cos((12 * Math.PI) / 180);
const MIN_TH = 4.5e-4;
const STEAL_TH = 1.1e-3;
const TAPER_LEN = 0.3;
// Smooth-max width over th: a floor, plus a share that grows with the bend, which rounds the crease at a joint.
const BLEND_K0 = 0.03;
const BLEND_K1 = 0.4;

export function createTrails({ maxTrails = 128, points = 8 } = {}) {
  const MAXT = maxTrails;
  const P = points;
  const owner = new Int16Array(MAXT).fill(-1);
  const count = new Uint8Array(MAXT);
  const pts = new Float32Array(MAXT * P * 4);
  // Chain links: the slot this trail's tail continues from, and the slot its head continues into.
  const prevT = new Int16Array(MAXT).fill(-1);
  const nextT = new Int16Array(MAXT).fill(-1);
  const chain = new Float32Array(MAXT);
  let chainId = 0;
  // Per slot: 1 / taper length, and the taper coordinates (in taper lengths) of its head point from the chain's free
  // head (1e4 when the head is held) and from the chain's tail.
  const taper = new Float32Array(MAXT * 3);
  const slotLen = new Float32Array(MAXT);
  // Per slot: bounding sphere of its film (centre, radius), refreshed with slotLen when its points change.
  const bnd = new Float64Array(MAXT * 4);
  const lenDirty = new Uint8Array(MAXT).fill(1);
  let taperDirty = true;
  // Live slots sorted by chain; rebuilt when it changes.
  const order = new Int16Array(MAXT);
  let orderN = 0;
  let orderDirty = true;
  const params = { viscosity: 0.5 };
  const stats = { used: 0, chained: 0, starved: 0, stolen: 0, dropped: 0, volume: 0 };

  const at = (j, k) => (j * P + k) * 4;

  function unlink(j) {
    taperDirty = true;
    if (prevT[j] >= 0) nextT[prevT[j]] = -1;
    if (nextT[j] >= 0) prevT[nextT[j]] = -1;
    prevT[j] = nextT[j] = -1;
  }

  function free(j) {
    count[j] = 0;
    lenDirty[j] = 1;
    owner[j] = -1;
    unlink(j);
    orderDirty = true;
  }

  function alloc(blob) {
    let thin = -1, thinTh = STEAL_TH;
    for (let j = 0; j < MAXT; j++) {
      if (count[j] === 0) {
        owner[j] = blob;
        unlink(j);
        orderDirty = true;
        return j;
      }
      // The thinnest orphan can be taken when the pool runs out; its head is its thickest point.
      if (owner[j] < 0 && pts[at(j, 0) + 3] < thinTh) (thin = j), (thinTh = pts[at(j, 0) + 3]);
    }
    if (thin < 0) {
      stats.starved++;
      return -1;
    }
    stats.stolen++;
    unlink(thin);
    owner[thin] = blob;
    orderDirty = true;
    return thin;
  }

  // Head of blob's trail j follows p with thickness th; returns the slot that now carries the head (or -1).
  // spacing is the path length between points.
  function extend(j, blob, x, y, z, th, spacing) {
    taperDirty = true;
    if (j < 0 || owner[j] !== blob) {
      j = alloc(blob);
      if (j < 0) return -1;
      const o = at(j, 0);
      for (let q = o; q <= o + 4; q += 4) (pts[q] = x), (pts[q + 1] = y), (pts[q + 2] = z), (pts[q + 3] = th);
      count[j] = 2;
      lenDirty[j] = 1;
      chain[j] = chainId = (chainId + 1) % 16777216;
      return j;
    }
    const o0 = at(j, 0), o1 = at(j, 1);
    lenDirty[j] = 1;
    pts[o0] = x;
    pts[o0 + 1] = y;
    pts[o0 + 2] = z;
    pts[o0 + 3] = th;
    const dx = x - pts[o1], dy = y - pts[o1 + 1], dz = z - pts[o1 + 2];
    const len = Math.hypot(dx, dy, dz);
    let push = len > spacing;
    if (!push && count[j] > 2 && len > 0.4 * spacing) {
      const o2 = at(j, 2);
      const ex = pts[o1] - pts[o2], ey = pts[o1 + 1] - pts[o2 + 1], ez = pts[o1 + 2] - pts[o2 + 2];
      const el = Math.hypot(ex, ey, ez);
      push = el > 1e-6 && (dx * ex + dy * ey + dz * ez) / (len * el) < TURN;
    }
    if (!push) return j;
    if (count[j] === P) {
      // Chain: the old trail is orphaned whole and a new one starts from its head.
      const n = alloc(blob);
      if (n < 0) {
        // No slot: the oldest point goes, so the head segment never stretches past spacing.
        pts.copyWithin(at(j, 1), o0, at(j, P - 1));
        if (prevT[j] >= 0) (nextT[prevT[j]] = -1), (prevT[j] = -1);
        stats.dropped++;
        return j;
      }
      owner[j] = -1;
      const a = at(n, 0);
      pts.copyWithin(a + 4, o0, o0 + 4);
      pts.copyWithin(a, o0, o0 + 4);
      count[n] = 2;
      lenDirty[n] = 1;
      chain[n] = chain[j];
      prevT[n] = j;
      nextT[j] = n;
      stats.chained++;
      return n;
    }
    pts.copyWithin(at(j, 1), o0, at(j, count[j]));
    count[j]++;
    return j;
  }

  function release(j, blob) {
    if (j >= 0 && owner[j] === blob) (owner[j] = -1), (taperDirty = true);
  }

  function step(h) {
    const k = Math.exp(-h / (1.5 + 3 * params.viscosity));
    // Short loose ends heal faster, so they never linger as grains.
    const kShort = k * k * k;
    let used = 0;
    for (let j = 0; j < MAXT; j++) {
      if (count[j] === 0) continue;
      const loose = owner[j] < 0 && count[j] <= 3 && prevT[j] < 0 && nextT[j] < 0;
      const kj = loose ? kShort : k;
      // The owned head is refreshed by its blob each substep.
      for (let i = owner[j] >= 0 ? 1 : 0; i < count[j]; i++) pts[at(j, i) + 3] *= kj;
      while (count[j] > 2 && pts[at(j, count[j] - 1) + 3] < MIN_TH && pts[at(j, count[j] - 2) + 3] < MIN_TH) (count[j]--), (lenDirty[j] = 1), (taperDirty = true);
      if (owner[j] < 0 && pts[at(j, 0) + 3] < MIN_TH && pts[at(j, 1) + 3] < MIN_TH) free(j);
      if (count[j]) used++;
    }
    stats.used = used;
  }

  function sortOrder() {
    if (!orderDirty) return;
    orderN = 0;
    for (let j = 0; j < MAXT; j++) if (count[j] >= 2) order[orderN++] = j;
    order.subarray(0, orderN).sort((x, y) => chain[x] - chain[y] || x - y);
    orderDirty = false;
  }

  // Arc lengths along each chain, walked from its tail slot, for the end tapers.
  function updateTaper() {
    if (!taperDirty) return;
    taperDirty = false;
    for (let j = 0; j < MAXT; j++) {
      if (!lenDirty[j]) continue;
      lenDirty[j] = 0;
      let l = 0;
      for (let i = 1; i < count[j]; i++) {
        const a = at(j, i - 1), b = at(j, i);
        l += Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]);
      }
      slotLen[j] = l;
      // Thickness only decays between refreshes, so the bound stays conservative.
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, th = 1e-7;
      for (let i = 0; i < count[j]; i++) {
        const q = at(j, i);
        x0 = Math.min(x0, pts[q]), y0 = Math.min(y0, pts[q + 1]), z0 = Math.min(z0, pts[q + 2]);
        x1 = Math.max(x1, pts[q]), y1 = Math.max(y1, pts[q + 1]), z1 = Math.max(z1, pts[q + 2]);
        th = Math.max(th, pts[q + 3]);
      }
      const b = j * 4;
      bnd[b] = 0.5 * (x0 + x1);
      bnd[b + 1] = 0.5 * (y0 + y1);
      bnd[b + 2] = 0.5 * (z0 + z1);
      bnd[b + 3] = count[j] ? 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) + TRAIL_ASPECT * Math.sqrt(th) + 1e-6 : 0;
    }
    for (let j = 0; j < MAXT; j++) {
      if (count[j] < 2 || (prevT[j] >= 0 && count[prevT[j]] >= 2)) continue;
      let total = 0, head = j;
      for (let k = j, n = 0; k >= 0 && n < MAXT; k = nextT[k], n++) (total += slotLen[k]), (head = k);
      const free = owner[head] < 0;
      const L = Math.max(Math.min(TAPER_LEN, (free ? 0.45 : 0.9) * total), 1e-4);
      let off = 0;
      for (let k = j, n = 0; k >= 0 && n < MAXT; k = nextT[k], n++) {
        off += slotLen[k];
        taper[k * 3] = 1 / L;
        taper[k * 3 + 1] = free ? (total - off) / L : 1e4;
        taper[k * 3 + 2] = off / L;
      }
    }
  }

  const _cg = [0, 0, 0];
  const sstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const dsstep = (x) => (x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x));
  // One trail's film at p into the chain's smooth max (value returned, gradient in cg). Mirrors addTrail().
  function chainAdd(j, p, n, cv, cg) {
    const invL = taper[j * 3], uH = taper[j * 3 + 1], uT = taper[j * 3 + 2];
    let ax = pts[at(j, 0)], ay = pts[at(j, 0) + 1], az = pts[at(j, 0) + 2], aw = pts[at(j, 0) + 3];
    let px = 0, py = 0, pz = 0, cum = 0;
    for (let i = 1; i < count[j]; i++) {
      const b = at(j, i);
      const ex = pts[b], ey = pts[b + 1], ez = pts[b + 2], ew = pts[b + 3];
      const abx = ex - ax, aby = ey - ay, abz = ez - az;
      const l2 = Math.max(abx * abx + aby * aby + abz * abz, 1e-10);
      const ll = Math.sqrt(l2);
      const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
      const fu = (apx * abx + apy * aby + apz * abz) / l2;
      const f = Math.min(1, Math.max(0, fu));
      const inside = fu > 0 && fu < 1;
      const rx = apx - f * abx, ry = apy - f * aby, rz = apz - f * abz;
      const th = Math.max(aw + (ew - aw) * f, 1e-7);
      const sq = Math.sqrt(th);
      const iw = 1 / (TRAIL_ASPECT * TRAIL_ASPECT * th);
      const D = 0.7 * TRAIL_ASPECT * sq + 0.006;
      const rdn = n ? rx * n[0] + ry * n[1] + rz * n[2] : 0;
      const rn = rdn / D;
      const r2 = rx * rx + ry * ry + rz * rz;
      const s = r2 * iw + rn * rn;
      if (s < 1) {
        const xh = uH + (cum + f * ll) * invL, xt = uT - (cum + f * ll) * invL;
        const sH = sstep(xh), sT = sstep(xt);
        const tf = sH * sT;
        const dtf = inside ? (invL * (dsstep(xh) * sT - sH * dsstep(xt))) / ll : 0;
        const Q = 1 - s * s, T = th * tf, v = T * Q * Q;
        const dthk = inside ? (ew - aw) / l2 : 0;
        const abn = n ? (abx * n[0] + aby * n[1] + abz * n[2]) / l2 : 0;
        const c1 = (2 * rn) / D, c2 = -(r2 * iw) / th - ((2 * rn * rn) / D) * ((0.35 * TRAIL_ASPECT) / sq);
        const dthx = dthk * abx, dthy = dthk * aby, dthz = dthk * abz;
        const dTx = tf * dthx + th * dtf * abx, dTy = tf * dthy + th * dtf * aby, dTz = tf * dthz + th * dtf * abz;
        const drnx = n ? n[0] - (inside ? abx * abn : 0) : 0;
        const drny = n ? n[1] - (inside ? aby * abn : 0) : 0;
        const drnz = n ? n[2] - (inside ? abz * abn : 0) : 0;
        const dsx = 2 * iw * rx + c2 * dthx + c1 * drnx, dsy = 2 * iw * ry + c2 * dthy + c1 * drny, dsz = 2 * iw * rz + c2 * dthz + c1 * drnz;
        const gx = Q * Q * dTx - 4 * T * s * Q * dsx, gy = Q * Q * dTy - 4 * T * s * Q * dsy, gz = Q * Q * dTz - 4 * T * s * Q * dsz;
        const cosb = i > 1 ? (px * abx + py * aby + pz * abz) / ll : 1;
        const kc = BLEND_K0 + BLEND_K1 * (1 - cosb);
        const k = Math.min(T * kc, v, cv);
        // Polynomial smooth max of cv and v over width k; t is v's weight.
        let nv, t;
        if (k <= 1e-12) (nv = v >= cv ? v : cv), (t = v >= cv ? 1 : 0);
        else (t = Math.min(1, Math.max(0, 0.5 + (0.5 * (v - cv)) / k))), (nv = cv + (v - cv) * t + k * t * (1 - t));
        // d(smax)/dk = t(1 − t), with dk from whichever term set k.
        const w = t * (1 - t), kind = k === v ? 1 : k === cv ? 2 : 0;
        cg[0] += (gx - cg[0]) * t + w * (kind === 1 ? gx : kind === 2 ? cg[0] : kc * dTx);
        cg[1] += (gy - cg[1]) * t + w * (kind === 1 ? gy : kind === 2 ? cg[1] : kc * dTy);
        cg[2] += (gz - cg[2]) * t + w * (kind === 1 ? gz : kind === 2 ? cg[2] : kc * dTz);
        cv = nv;
      }
      (px = abx / ll), (py = aby / ll), (pz = abz / ll);
      (ax = ex), (ay = ey), (az = ez), (aw = ew);
      cum += ll;
    }
    return cv;
  }

  // Union of all trails at p (rest normal n fades it off the far side of thin parts): smooth max within a chain,
  // CHAIN_P-norm between chains. Returns the height, gradient into grad; skips slot skip.
  function heightAt(p, grad, skip = -1, n = null) {
    sortOrder();
    updateTaper();
    let sum = 0, cid = -1, cv = 0, gx = 0, gy = 0, gz = 0;
    grad[0] = grad[1] = grad[2] = 0;
    const px = p[0], py = p[1], pz = p[2];
    for (let o = 0; o < orderN; o++) {
      const j = order[o];
      if (j === skip || count[j] < 2) continue;
      // A slot whose film cannot reach p leaves its chain's value and gradient as they are.
      const b = j * 4, ex = px - bnd[b], ey = py - bnd[b + 1], ez = pz - bnd[b + 2];
      if (ex * ex + ey * ey + ez * ez >= bnd[b + 3] * bnd[b + 3]) continue;
      if (chain[j] !== cid) {
        if (cv > 0) {
          const hp = Math.pow(cv, CHAIN_P - 1);
          sum += hp * cv;
          (gx += hp * _cg[0]), (gy += hp * _cg[1]), (gz += hp * _cg[2]);
        }
        cid = chain[j];
        cv = 0;
        _cg[0] = _cg[1] = _cg[2] = 0;
      }
      cv = chainAdd(j, p, n, cv, _cg);
    }
    if (cv > 0) {
      const hp = Math.pow(cv, CHAIN_P - 1);
      sum += hp * cv;
      (gx += hp * _cg[0]), (gy += hp * _cg[1]), (gz += hp * _cg[2]);
    }
    if (sum <= 1e-30) return 0;
    const T = Math.pow(sum, 1 / CHAIN_P);
    const k = Math.pow(T, 1 - CHAIN_P);
    (grad[0] = gx * k), (grad[1] = gy * k), (grad[2] = gz * k);
    return T;
  }

  // Writes rows of (bound, points..., (chain, taper)) sorted by chain for the GLSL; th ≤ 0 ends a row. Returns the row count.
  function pack(td, rowP) {
    sortOrder();
    updateTaper();
    const W = (rowP + 2) * 4;
    let vol = 0;
    for (let o = 0; o < orderN; o++) {
      const j = order[o];
      const r = o * W;
      const n = count[j];
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let wMax = 0;
      for (let i = 0; i < n; i++) {
        const q = at(j, i);
        (x0 = Math.min(x0, pts[q])), (y0 = Math.min(y0, pts[q + 1])), (z0 = Math.min(z0, pts[q + 2]));
        (x1 = Math.max(x1, pts[q])), (y1 = Math.max(y1, pts[q + 1])), (z1 = Math.max(z1, pts[q + 2]));
        wMax = Math.max(wMax, TRAIL_ASPECT * Math.sqrt(Math.max(pts[q + 3], 0)));
        td[r + 4 + i * 4] = pts[q];
        td[r + 5 + i * 4] = pts[q + 1];
        td[r + 6 + i * 4] = pts[q + 2];
        td[r + 7 + i * 4] = pts[q + 3];
        if (i > 0) {
          const a = at(j, i - 1);
          const len = Math.hypot(pts[q] - pts[a], pts[q + 1] - pts[a + 1], pts[q + 2] - pts[a + 2]);
          const ta = pts[a + 3], tb = pts[q + 3];
          vol += 0.5 * (ta * Math.sqrt(ta) + tb * Math.sqrt(tb)) * TRAIL_ASPECT * SECTION * len;
        }
      }
      td[r] = 0.5 * (x0 + x1);
      td[r + 1] = 0.5 * (y0 + y1);
      td[r + 2] = 0.5 * (z0 + z1);
      td[r + 3] = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) + wMax;
      if (n < rowP) td.fill(0, r + 4 + n * 4, r + 4 + rowP * 4);
      td.fill(0, r + 4 + rowP * 4, r + W);
      td[r + 4 + rowP * 4] = chain[j];
      td[r + 5 + rowP * 4] = taper[j * 3];
      td[r + 6 + rowP * 4] = taper[j * 3 + 1];
      td[r + 7 + rowP * 4] = taper[j * 3 + 2];
    }
    td.fill(0, orderN * W, MAXT * W);
    stats.volume = vol;
    return orderN;
  }

  function reset() {
    count.fill(0);
    lenDirty.fill(1);
    owner.fill(-1);
    prevT.fill(-1);
    nextT.fill(-1);
    orderDirty = taperDirty = true;
  }

  // Cross-section volume per unit length for thickness th.
  const section = (th) => th * TRAIL_ASPECT * Math.sqrt(th) * SECTION;

  return { MAXT, P, count, pts, owner, prevT, nextT, chain, params, stats, extend, release, step, heightAt, pack, reset, section };
}
