import { DataTexture, RGBAFormat, FloatType, NearestFilter } from "three";
import { seededRandom, nativeRandom } from "modules/random.js";
import { createState } from "./surfaceWalk.js";
import { volumeOf } from "./blobs.js";
import { dropVmax, dropOutline, createOutline, outlineR } from "./dropShape.js";

// Quadric fits with a larger residual (creases, ear rims, star valleys) are rejected.
const FIT_RMS = 5e-4;
const EASE_TAU = 0.15;
const REFIT_EVERY = 0.2;
const RETRACT_TAU = 0.25;
// Fill (share of the largest stable drop) at which a drop lets go, and below which a pool cannot neck at all.
const RELEASE = [0.72, 0.97];
const NECK_MIN = 0.45;
// Seconds from the first sign of a neck to the snap.
const PINCH_TIME = [0.12, 0.28];
// Remnant recoil: an underdamped spring from the snapped cone to the rounded nub.
const RECOIL_W = 24;
const RECOIL_ZETA = [0.45, 0.75];
const SATELLITE = 0.35;
// Fastest the pool fills, per second; liquid draining down the body tops its dome up at DRAIN per second.
const FEED_MAX = 5e-4;
const DRAIN = 6e-4;
// A pool that stops filling for IDLE_WAIT lets go or sinks back in.
const IDLE_WAIT = 5;
// Radius of a sphere holding a released drop's volume, randomised per pool before the sliders scale it.
const R_PINCH = [0.06, 0.115];
// Root radii in capillary lengths: a pool starts as a lens on KAPPA_LENS and hangs as a pear from KAPPA_HANG once full.
const KAPPA_LENS = [0.5, 0.7];
const KAPPA_HANG = [0.27, 0.38];
// Pause after a snap before the remnant fills again, in seconds.
const REFILL_WAIT = [0.1, 1.6];
// Mean curvature times the drop radius over which a sharp tip gets a broader root and a larger drop.
const TIP_CURV = [0.35, 0.9];
// The light mesh carries smaller drops.
const LITE_SIZE = 0.85;
// Most seeded pools at once.
const MAX_LIVE = 4;
// Time constant of the hanging direction as the body turns, so the drop swings a little.
const SWING_TAU = 0.1;
// Share of the way the drop's axis turns from the skin normal to straight down; the rest would shear it into a crease
// on the uphill side of a sloping underside.
const HANG = 0.6;
// Volume a dome keeps while feeding its pool, and the least the drain may top it up to.
const V_MIN = volumeOf(0.04);
const V_DOME = volumeOf(0.2);
// Depth over the root radius below which the lathe keeps the skin's rise, so a pointed tip runs on into the pool.
const ZS = 0.6;
// Outline samples per profile build, and per remnant morph.
const OUTLINE = 128;
const MORPH = 96;
// Extra outline weight per unit length in the necking window, over the bulb radius.
const NECK_WEIGHT = 5;
const sphereV = (r) => (4 / 3) * Math.PI * r ** 3;

const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Pool slots, profile samples and the shader defines for a tier. areaK bounds how much pool surface each unit of skin
// area is stretched over: the dense mesh can spare more, the light one keeps the drop's vertices closer together.
export function pendantLayout(lite) {
  const MAXP = lite ? 8 : 16;
  const N = lite ? 40 : 64;
  const HEAD = 3;
  return { MAXP, N, HEAD, areaK: lite ? [1, 1.8] : [1.5, 3.5], defines: { MAX_POOLS: MAXP, POOL_N: N, POOL_HEAD: HEAD } };
}

// Pools on the underside: a blob that settles at a low point swells into a hanging drop. The drop is part of the body
// surface: inside a disc of radius ρ0 around the dome apex the skin is remapped onto a lathe profile hanging along the
// (eased) down direction. The profile is a Young–Laplace pendant drop for the pool's volume (dropShape.js): a lens,
// then a pear tapering to a root filleted into the skin. Past its release volume a neck pinches the bulb off, the bulb
// falls as a drop and the remnant recoils into a nub. poolTex holds a row of (HEAD + N) texels per slot, in object
// space: (apex on the displaced skin, ρ0), (drop axis, depth zs above which the lathe keeps the skin's rise), (fitted
// normal, 0), then N profile samples (radius, depth, flatten) at ρ = i·ρ0/(N − 1).
export function createPendants({ lite = false, walk, field, sdf, blobs, drops = null, seed = "", floorY = -Infinity }) {
  const { MAXP, N, HEAD, areaK } = pendantLayout(lite);
  const W = HEAD + N;
  const tex = new DataTexture(new Float32Array(W * MAXP * 4), W, MAXP, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const td = tex.image.data;
  const rng = seededRandom(`${seed}:melt:pendants`);

  const alive = new Uint8Array(MAXP);
  const blob = new Int16Array(MAXP).fill(-1);
  // 0 filling, 2 retracting, 3 pinching.
  const phase = new Uint8Array(MAXP);
  const pinch = new Float32Array(MAXP);
  // Pointer pools draw their sizes from nativeRandom, so they leave the seeded melt alone.
  const userRand = new Uint8Array(MAXP);
  const thenHeal = new Uint8Array(MAXP);
  const resetPrev = new Uint8Array(MAXP);
  // Released in the current substep run, so the render shows the remnant without blending through the drop.
  const handed = new Uint8Array(MAXP);
  const Vb = new Float32Array(MAXP);
  const VbMax = new Float32Array(MAXP);
  const idle = new Float32Array(MAXP);
  // Most the drain tops the dome up to: its volume as the pool started, or V_DOME.
  const Vtop = new Float32Array(MAXP);
  const idleMax = new Float32Array(MAXP);
  // Lens and hanging root radii (capillary lengths) and the capillary length in object units, fixed for the pool's life.
  // Per drop: elongation at full fill, how fast the body drains into it, pinch time, and the wait before it refills.
  const kap0 = new Float32Array(MAXP);
  const kap1 = new Float32Array(MAXP);
  const cap = new Float32Array(MAXP);
  const elong = new Float32Array(MAXP);
  const drain = new Float32Array(MAXP);
  const pinchT = new Float32Array(MAXP);
  const wait = new Float32Array(MAXP);
  // Remnant recoil: 0 at the snap to 1 settled (with overshoot), its rate and damping, and the fill and stretch at the
  // snap that rebuild the remnant's cone.
  const rec = new Float32Array(MAXP);
  const recV = new Float32Array(MAXP);
  const recZ = new Float32Array(MAXP);
  const snapV = new Float32Array(MAXP);
  const snapS = new Float32Array(MAXP);
  // State at the start of the last substep, for the render's blend.
  const VbS = new Float32Array(MAXP);
  const pinchS = new Float32Array(MAXP);
  const recS = new Float32Array(MAXP);
  // Equator depth under the skin and bulb radius, from the last shape.
  const L = new Float32Array(MAXP);
  const Rd = new Float32Array(MAXP);
  // Root radius on the skin, eased.
  const rF = new Float32Array(MAXP);
  // Outline and disc radii from before the pinch; the pinch eases onto them so its stretch stays in the drop.
  const rhoAH = new Float32Array(MAXP);
  const rho0H = new Float32Array(MAXP);
  // Hanging direction (object space), and at the start of the last substep.
  const gd = new Float32Array(MAXP * 3);
  const gdS = new Float32Array(MAXP * 3);
  const refitT = new Float32Array(MAXP);
  // Eased fitted normal and its target.
  const nb = new Float32Array(MAXP * 3);
  const nbT = new Float32Array(MAXP * 3);
  const room = new Float32Array(MAXP);
  const fade = new Float32Array(MAXP);
  // World bulb equator now and one substep before, for the drops, the occluders and the harness.
  const x = new Float32Array(MAXP * 3);
  const xS = new Float32Array(MAXP * 3);

  const params = { viscosity: 0.5, dripLength: 0.5, size: 0.5, amount: 0.4 };
  // Why the last create failed: "slots", "near", "path" or "fit".
  let lastReject = "";
  const stats = { live: 0, pinches: 0, satellites: 0, pinchLog: [], created: 0, rejectFit: 0, rejectNear: 0, rejectSlots: 0, rejectPath: 0, freed: 0, retracts: 0, maxR: 0, why: {} };
  const ledger = { volume: 0, dropped: 0, drained: 0 };

  const ws = createState();
  const fit = {};
  const S = [0, 0, 0], nS = [0, 0, 0];
  const _a = [0, 0, 0];
  const shape = createOutline(), remnant = createOutline(), nub = createOutline();
  let clock = 0;

  // Fits over a patch sized to the dome, then a smaller one if that is not quadric enough (Suzanne's chin).
  function fitAt(b, g) {
    blobs.walkState(b, ws);
    let f = null;
    for (const r of [Math.min(0.14, Math.max(0.06, 0.9 * blobs.a[b])), 0.1, 0.075, 0.05]) {
      f = walk.fitQuadric(ws, g, r, fit);
      if (f && f.rms <= FIT_RMS) break;
    }
    return f;
  }

  // Whether a drop falling along g from object-space point (cx, cy, cz) stays clear of the body once it has left it.
  function pathClear(cx, cy, cz, g, len) {
    let out = false;
    for (let t = 0.015; t < len; t += 0.015) {
      const d = sdf.sample(cx + g[0] * t, cy + g[1] * t, cz + g[2] * t);
      if (d > 0.012) out = true;
      else if (out && d < 0.004) return false;
    }
    return true;
  }

  // Released drop radius for a new pool, scaled by the size, viscosity and drip length sliders.
  const pinchRadius = (rand) => mix(R_PINCH[0], R_PINCH[1], rand()) * (lite ? LITE_SIZE : 1) * mix(0.8, 1.2, params.size) * mix(0.9, 1.15, params.viscosity) * mix(0.9, 1.12, params.dripLength);
  const vmax = (p) => dropVmax(kap1[p]) * cap[p] ** 3;
  // Stretch along the axis at fill v: viscous, long-drip pools hang as longer, more finger-like pears.
  const stretch = (p, v) => 1 + elong[p] * Math.min(v, 1) ** 2;

  // Release fill, stretch, supply and pinch time of the next drop.
  function nextDrop(p, rand) {
    VbMax[p] = mix(RELEASE[0], RELEASE[1], rand()) * vmax(p);
    elong[p] = (0.06 + 0.4 * params.viscosity) * mix(0.5, 1.5, params.dripLength) * mix(0.8, 1.2, rand()) * (lite ? 0.7 : 1);
    drain[p] = mix(0.45, 1.6, rand());
    pinchT[p] = mix(PINCH_TIME[0], PINCH_TIME[1], rand()) * mix(0.8, 1.3, params.viscosity);
    recZ[p] = mix(RECOIL_ZETA[0], RECOIL_ZETA[1], params.viscosity);
    idleMax[p] = IDLE_WAIT * (0.75 + 0.5 * rand());
  }

  // Starts a pool on blob b (object-space down g); returns the slot or −1 when no slot is free, another pool is too
  // close, the surface there is not a clean quadric, or the drop would fall through the body.
  function create(b, g, rand = rng) {
    let p = -1;
    for (let q = 0; q < MAXP; q++) if (!alive[q]) {
      p = q;
      break;
    }
    if (p < 0) {
      lastReject = "slots";
      stats.rejectSlots++;
      return -1;
    }
    const cb = blobs.c;
    const user = rand !== rng;
    let n = 0;
    for (let q = 0; q < MAXP; q++) if (alive[q] && phase[q] !== 2 && !userRand[q]) n++;
    if (!user && n >= (lite ? 3 : MAX_LIVE)) {
      lastReject = "slots";
      stats.rejectSlots++;
      return -1;
    }
    for (let q = 0; q < MAXP; q++) {
      // A hold only keeps clear of live pools, not ones draining back.
      if (!alive[q] || (user && phase[q] === 2)) continue;
      const j = blob[q];
      const d = Math.hypot(cb[b * 3] - cb[j * 3], cb[b * 3 + 1] - cb[j * 3 + 1], cb[b * 3 + 2] - cb[j * 3 + 2]);
      // Clear of the other pools' discs at their largest.
      if (d < (user ? 0.05 + 3 * R_PINCH[1] : Math.max(0.36, 0.12 + 0.5 * (blobs.a[b] + blobs.a[j])))) {
        lastReject = "near";
        stats.rejectNear++;
        return -1;
      }
    }
    if (!pathClear(cb[b * 3], cb[b * 3 + 1], cb[b * 3 + 2], g, 0.3)) {
      lastReject = "path";
      stats.rejectPath++;
      return -1;
    }
    const f = fitAt(b, g);
    if (!f || f.rms > FIT_RMS) {
      lastReject = "fit";
      stats.rejectFit++;
      return -1;
    }
    const R = pinchRadius(rand);
    const tip = smoothstep(TIP_CURV[0], TIP_CURV[1], Math.abs(f.k1 + f.k3) * R);
    for (let k = 0; k < 3; k++) {
      nb[p * 3 + k] = nbT[p * 3 + k] = f.n[k];
      gd[p * 3 + k] = gdS[p * 3 + k] = g[k];
    }
    room[p] = walk.attrAt("clearance", ws, 4);
    fade[p] = walk.attrAt("fade", ws, 1);
    alive[p] = 1;
    blob[p] = b;
    phase[p] = 0;
    pinch[p] = pinchS[p] = 0;
    rec[p] = recS[p] = 1;
    recV[p] = 0;
    userRand[p] = user;
    thenHeal[p] = 0;
    resetPrev[p] = 1;
    Vb[p] = VbS[p] = L[p] = Rd[p] = rF[p] = rhoAH[p] = rho0H[p] = 0;
    idle[p] = 0;
    Vtop[p] = Math.max(blobs.V[b], V_DOME);
    refitT[p] = REFIT_EVERY;
    // The light mesh keeps to broader roots, which need fewer vertices than a long taper; a sharp tip hangs a larger drop
    // from a broader root, so the lathe takes over from the tip's own cone, and starts as a bead rather than a lens.
    kap1[p] = mix(mix(KAPPA_HANG[0], KAPPA_HANG[1], rand()) + (lite ? 0.04 : 0), 0.46, tip);
    kap0[p] = mix(mix(KAPPA_LENS[0], KAPPA_LENS[1], rand()), kap1[p] + 0.06, tip);
    wait[p] = 0;
    cap[p] = Math.cbrt(sphereV(R * mix(1, 1.35, tip)) / (mix(RELEASE[0], RELEASE[1], 0.5) * dropVmax(kap1[p])));
    nextDrop(p, rand);
    stats.created++;
    return p;
  }

  // Drains the pool back into its dome; heal: the blob sinks in afterwards instead of running on.
  function retract(p, heal = false, why = "blob") {
    if (p < 0 || !alive[p]) return;
    if (phase[p] === 3) return;
    if (phase[p] !== 2) {
      stats.retracts++;
      stats.why[why] = (stats.why[why] ?? 0) + 1;
    }
    phase[p] = 2;
    if (heal) thenHeal[p] = 1;
  }

  // A pool too small to neck sinks back in instead.
  function startPinch(p) {
    if (phase[p] !== 0) return;
    if (Vb[p] < NECK_MIN * vmax(p)) return retract(p, true, "small");
    phase[p] = 3;
    pinch[p] = 0;
  }

  function free(p) {
    const b = blob[p];
    blobs.V[b] += Vb[p];
    alive[p] = 0;
    blob[p] = -1;
    Vb[p] = L[p] = Rd[p] = 0;
    stats.freed++;
    blobs.pendantFreed(b, !!thenHeal[p]);
  }

  // Apex of slot p's dome on the displaced skin (object space), for anchor (walk point) cx, into S.
  function apex(p, cx, cy, cz) {
    _a[0] = cx;
    _a[1] = cy;
    _a[2] = cz;
    field.surfaceAt(_a, nb.subarray(p * 3, p * 3 + 3), S, nS, fade[p], room[p]);
    return S;
  }

  // Outline of slot p at volume vb, pinch e and recoil w, in capillary lengths, into shape.
  function shapeOf(p, vb, e, w) {
    const v = vb / vmax(p);
    if (w >= 1 - 1e-3 && Math.abs(recV[p]) < 0.05) return dropOutline(shape, kap0[p], kap1[p], v, stretch(p, v), e);
    // Morph from the snapped cone to the nub of the same volume, at matching heights from the tip.
    dropOutline(remnant, kap0[p], kap1[p], snapV[p], snapS[p], 1, true);
    dropOutline(nub, kap0[p], kap1[p], v, stretch(p, v));
    const H = Math.max(mix(remnant.H, nub.H, w), 1e-4);
    shape.n = MORPH;
    shape.W = shape.zEq = shape.zNeck = shape.zCut = shape.zN0 = shape.zN1 = shape.Vbelow = 0;
    for (let j = 0; j < MORPH; j++) {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * j) / (MORPH - 1));
      const r = Math.max(0, mix(outlineR(remnant, u * remnant.H), outlineR(nub, u * nub.H), w));
      shape.r[j] = r;
      shape.z[j] = u * H;
      if (r > shape.W) (shape.W = r), (shape.zEq = u * H);
    }
    shape.r[0] = 0;
    shape.H = H;
    shape.root = shape.r[MORPH - 1];
    return shape;
  }

  const oz = new Float64Array(OUTLINE + 1), orr = new Float64Array(OUTLINE + 1), orho = new Float64Array(OUTLINE + 1);
  // Lathe profile of outline o (capillary lengths, scaled by a) as N samples (radius, depth, flatten) into out at off,
  // uniform in the rest disc radius ρ; returns ρ0 (0: nothing to draw). The outline is spread over the disc by area
  // plus a share of length, so thin necks still get vertices, and drawn from about the root's own disc so the skin moves
  // sideways little; the skirt past the fillet eases back to the skin's own radius.
  function profile(o, a, out, off, p, pe) {
    const zt = o.H * a;
    const rd = Math.max(o.W * a, 1e-4);
    if (o.n < 2 || zt < 2e-4) return 0;
    const cR = 0.5 * rd;
    let mu = 0, lastAng = 0;
    for (let j = 0; j <= OUTLINE; j++) {
      const z = (0.5 + 0.5 * Math.cos((Math.PI * j) / OUTLINE)) * zt;
      const r = j === 0 ? 0 : a * outlineR(o, (zt - z) / a);
      if (j > 0) {
        const ds = Math.hypot(r - orr[j - 1], z - oz[j - 1]);
        const rm = 0.5 * (r + orr[j - 1]);
        // Thin necks and sharp bends get extra weight, so they keep a few vertices.
        const tip = smoothstep(0, 0.5 * rd, zt - z);
        const ang = Math.atan2(z - oz[j - 1], r - orr[j - 1]);
        if (j > 1) mu += 0.6 * rd * rd * tip * Math.abs(Math.atan2(Math.sin(ang - lastAng), Math.cos(ang - lastAng)));
        lastAng = ang;
        mu += (rm + cR * tip * (2 - smoothstep(0, 0.5 * rd, rm))) * ds;
        // The hourglass gets its own share as it closes, so the thread is spanned by rings of vertices, not torn.
        const zo = (zt - z) / a;
        if (zo > o.zN0 && zo < o.zN1) mu += pe * (lite ? 0.5 : 1) * NECK_WEIGHT * rd * ds;
      }
      oz[j] = z;
      orr[j] = r;
      orho[j] = mu;
    }
    const r1 = orr[OUTLINE];
    const rhoN = Math.sqrt((2 * mu) / Math.min(Math.max((2 * mu) / (r1 * r1), areaK[0]), areaK[1]));
    const rho0N = Math.max(rhoN, r1) + 0.5 * rd + 0.02 + 0.5 * Math.abs(rhoN - r1);
    if (pe <= 0 || !(rhoAH[p] > 0)) (rhoAH[p] = rhoN), (rho0H[p] = rho0N);
    const rhoA = mix(rhoN, rhoAH[p], pe);
    const rho0 = Math.max(mix(rho0N, rho0H[p], pe), Math.max(rhoA, r1) + 0.01);
    const k = (2 * mu) / (rhoA * rhoA);
    for (let j = 0; j <= OUTLINE; j++) orho[j] = Math.sqrt((2 * orho[j]) / k);
    // Depth of the neck; while it closes everything below it is a clean lathe, however the skin curves there.
    const zn = o.zNeck > 0 ? (o.H - o.zNeck) * a : 0.5 * zt;
    const span = rho0 - rhoA;
    const sec = (rho0 - r1) / span;
    const m0 = Math.min(Math.max((k * rhoA) / (r1 + cR), 0.2 * sec), 3 * sec);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const rho = (rho0 * i) / (N - 1);
      let r, z;
      if (rho <= rhoA) {
        while (j < OUTLINE - 1 && orho[j + 1] < rho) j++;
        const t = Math.min(1, Math.max(0, (rho - orho[j]) / Math.max(orho[j + 1] - orho[j], 1e-9)));
        r = mix(orr[j], orr[j + 1], t);
        z = mix(oz[j], oz[j + 1], t);
      } else {
        // Hermite from (ρa, r1) with the outline's spread to (ρ0, ρ0) with slope 1.
        const t = (rho - rhoA) / span, t2 = t * t, t3 = t2 * t;
        r = (2 * t3 - 3 * t2 + 1) * r1 + (t3 - 2 * t2 + t) * m0 * span + (-2 * t3 + 3 * t2) * rho0 + (t3 - t2) * span;
        z = 0;
      }
      const q = off + (HEAD + i) * 4;
      out[q] = r;
      out[q + 1] = z;
      // The drop hangs from the apex's tangent plane; the fillet eases onto the skin's own curve.
      out[q + 2] = Math.max(1 - smoothstep(0.4 * rhoA, rhoA, rho), pe * smoothstep(0.15, 0.6, z / zn));
      out[q + 3] = 0;
    }
    return rho0;
  }

  // World point at depth dpt along the axis from the apex in S, into out.
  function world(e, dpt, out, o = 0) {
    const cx = S[0] + ax[0] * dpt, cy = S[1] + ax[1] * dpt, cz = S[2] + ax[2] * dpt;
    out[o] = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
    out[o + 1] = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
    out[o + 2] = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
  }

  const _sat = [0, 0, 0], _satS = [0, 0, 0];
  // The neck has closed: the bulb below it falls with its own volume, width and height, and the remnant above it starts
  // its recoil. o is the outline at the snap; the drop's centre is the bulb's equator, where the pool's x tracks it.
  function release(p, h, e, scale, o) {
    const t = p * 3, a = cap[p];
    const v = [(x[t] - xS[t]) / h, (x[t + 1] - xS[t + 1]) / h, (x[t + 2] - xS[t + 2]) / h];
    // The bulb as drawn, so the drop leaves at exactly its volume.
    let fell = Math.min(Vb[p], o.Vbelow * a ** 3);
    const rw = o.W * a * scale;
    const sl = o.zEq / o.W;
    const su = Math.min(Math.max((3 * fell * scale ** 3) / (2 * Math.PI * rw ** 3) - sl, 0.5), 3);
    drops?.spawn(xS.subarray(t, t + 3), x.subarray(t, t + 3), v, rw, sl, su);
    const rand = userRand[p] ? nativeRandom : rng;
    if (rand() < SATELLITE) {
      // A bead from the thread, at the neck.
      const rs = mix(0.1, 0.16, rand()) * o.W * a;
      const dn = (o.H - o.zCut) * a;
      world(e, dn, _sat);
      for (let k = 0; k < 3; k++) _satS[k] = _sat[k] - v[k] * h;
      drops?.spawn(_satS, _sat, [0.6 * v[0], 0.6 * v[1], 0.6 * v[2]], rs * scale);
      fell = Math.min(Vb[p], fell + sphereV(rs));
      stats.satellites++;
    }
    ledger.dropped += fell;
    stats.pinches++;
    if (stats.pinchLog.length < 256) stats.pinchLog.push({ p, t: +clock.toFixed(2), R: +(o.W * a).toFixed(3), V: +fell.toExponential(2) });
    snapV[p] = Vb[p] / vmax(p);
    snapS[p] = stretch(p, snapV[p]);
    Vb[p] -= fell;
    rec[p] = 0;
    recV[p] = 0;
    phase[p] = 0;
    idle[p] = 0;
    wait[p] = mix(REFILL_WAIT[0], REFILL_WAIT[1], rand());
    nextDrop(p, rand);
    handed[p] = 1;
    resetPrev[p] = 1;
  }

  // Drop axis between the skin normal n and down g, into ax.
  const ax = [0, 0, 0];
  function axis(n, g) {
    for (let k = 0; k < 3; k++) ax[k] = n[k] + (g[k] - n[k]) * HANG;
    const l = 1 / (Math.hypot(ax[0], ax[1], ax[2]) || 1);
    for (let k = 0; k < 3; k++) ax[k] *= l;
  }

  // One substep: feed, pinch or drain, then the shape. M is the body's matrixWorld, g world down in object space.
  function step(h, M, g) {
    const e = M.elements;
    const scale = Math.hypot(e[0], e[1], e[2]);
    const visc = params.viscosity;
    const kFeed = mix(1.5, 0.3, visc);
    const feedMax = FEED_MAX * mix(1.4, 0.6, visc);
    const supply = DRAIN * mix(0.5, 1.5, params.amount) * mix(1.3, 0.7, visc);
    const ease = 1 - Math.exp(-h / EASE_TAU);
    const back = 1 - Math.exp(-h / RETRACT_TAU);
    const swing = 1 - Math.exp(-h / SWING_TAU);
    clock += h;
    let live = 0, vol = 0;
    for (let p = 0; p < MAXP; p++) {
      if (!alive[p]) continue;
      const b = blob[p];
      const o3 = p * 3;
      if (handed[p]) handed[p] = 0;
      VbS[p] = Vb[p];
      pinchS[p] = pinch[p];
      recS[p] = rec[p];
      for (let k = 0; k < 3; k++) {
        gdS[o3 + k] = gd[o3 + k];
        xS[o3 + k] = x[o3 + k];
      }

      // Refit as the anchor creeps; the frame eases towards the new fit.
      if ((refitT[p] -= h) <= 0) {
        refitT[p] = REFIT_EVERY;
        const f = fitAt(b, g);
        if (f && f.rms <= 2 * FIT_RMS) for (let k = 0; k < 3; k++) nbT[o3 + k] = f.n[k];
        // Turned off the low point, or so a drop would fall through the body: it runs on as a blob.
        if (phase[p] === 0 && !pathClear(blobs.c[b * 3], blobs.c[b * 3 + 1], blobs.c[b * 3 + 2], g, L[p] + 2 * Rd[p] + 0.05)) retract(p, false, "path");
      }
      let nl = 0;
      for (let k = 0; k < 3; k++) nl += (nb[o3 + k] += (nbT[o3 + k] - nb[o3 + k]) * ease) ** 2;
      nl = 1 / Math.sqrt(nl);
      for (let k = 0; k < 3; k++) nb[o3 + k] *= nl;
      let gl = 0;
      for (let k = 0; k < 3; k++) gl += (gd[o3 + k] += (g[k] - gd[o3 + k]) * swing) ** 2;
      gl = 1 / Math.sqrt(gl);
      for (let k = 0; k < 3; k++) gd[o3 + k] *= gl;

      const bn = blobs.n;
      const pend = bn[b * 3] * g[0] + bn[b * 3 + 1] * g[1] + bn[b * 3 + 2] * g[2];
      const held = blobs.isHeld(b);
      if (phase[p] === 0 && pend < 0.5) retract(p, false, "turned");
      if (phase[p] === 0) {
        // Liquid running down the body keeps the dome topped up, below the fill cap so the dome settles.
        const top = Math.min(Math.min(supply * drain[p], 0.9 * feedMax) * smoothstep(0.5, 0.8, pend) * h, Math.max(0, Vtop[p] - blobs.V[b]));
        blobs.V[b] += top;
        ledger.drained += top;
        // A recoiling remnant waits for the nub to settle, and a while longer, before it fills again; each drop fills at
        // its own rate so neighbours drift out of step.
        if (rec[p] >= 0.9) wait[p] = Math.max(0, wait[p] - h);
        const dv = rec[p] < 0.9 || wait[p] > 0 ? 0 : Math.min(kFeed * Math.max(0, pend - 0.4) * Math.max(0, blobs.V[b] - V_MIN), feedMax * drain[p] * (held ? 1.5 : 1)) * h;
        blobs.V[b] -= dv;
        Vb[p] += dv;
        idle[p] = dv < 0.05 * feedMax * h && wait[p] <= 0 ? idle[p] + h : 0;
        if (Vb[p] >= VbMax[p]) startPinch(p);
        else if (idle[p] > idleMax[p] && !held) {
          // Stopped filling: a big enough pool lets go, a small one sinks back in.
          if (Vb[p] >= 0.75 * VbMax[p]) startPinch(p);
          else retract(p, true, "idle");
        }
      } else if (phase[p] === 2) {
        const dv = Vb[p] * back;
        blobs.V[b] += dv;
        Vb[p] -= dv;
        if (Vb[p] < 1e-7 && rec[p] > 0.9) {
          free(p);
          continue;
        }
      }
      if (phase[p] === 3) pinch[p] = Math.min(1, pinch[p] + h / pinchT[p]);
      // The disc eases back after a snap.
      else pinch[p] = Math.max(0, pinch[p] - h / 0.25);
      if (rec[p] < 1 || Math.abs(recV[p]) > 1e-3) {
        const w = RECOIL_W, z = recZ[p];
        recV[p] += (w * w * (1 - rec[p]) - 2 * z * w * recV[p]) * h;
        rec[p] += recV[p] * h;
        if (Math.abs(1 - rec[p]) < 2e-3 && Math.abs(recV[p]) < 1e-2) (rec[p] = 1), (recV[p] = 0);
      }

      const o = shapeOf(p, Vb[p], phase[p] === 3 ? pinch[p] : 0, rec[p]);
      const a = cap[p];
      L[p] = (o.H - o.zEq) * a;
      Rd[p] = o.W * a;
      if (Rd[p] > stats.maxR) stats.maxR = Rd[p];
      const rf = Math.max(o.root * a, 0.02);
      rF[p] = rF[p] > 0 ? rF[p] + (rf - rF[p]) * (1 - Math.exp(-h / 0.4)) : rf;

      // World bulb equator, for the drop hand-over and the occluders.
      apex(p, blobs.c[b * 3], blobs.c[b * 3 + 1], blobs.c[b * 3 + 2]);
      axis(nb.subarray(o3, o3 + 3), gd.subarray(o3, o3 + 3));
      world(e, L[p], x, o3);
      if (resetPrev[p]) for (let k = 0; k < 3; k++) xS[o3 + k] = x[o3 + k];
      resetPrev[p] = 0;
      // Never reaches the floor in practice; a drop that would lets go there.
      if (phase[p] === 0 && x[o3 + 1] - (o.zEq * a + 0.02) * scale < floorY + 0.02) startPinch(p);
      if (phase[p] === 3 && pinch[p] >= 1) release(p, h, e, scale, o);
      live++;
      vol += Vb[p];
    }
    stats.live = live;
    ledger.volume = vol;
  }

  const gb = [0, 0, 0];

  // Writes the pool rows. view holds the blobs' interpolated state (rendered one substep behind, t the blend). There is
  // one pose: as the map changes, skin vertices slide along the surface, which motion vectors would read as a smear.
  function pack(view, t) {
    let count = 0;
    for (let p = 0; p < MAXP; p++) {
      const r0 = p * W * 4;
      if (!alive[p]) {
        td.fill(0, r0, r0 + W * 4);
        continue;
      }
      count = p + 1;
      const b = blob[p];
      const o3 = p * 3;
      for (let k = 0; k < 3; k++) gb[k] = gdS[o3 + k] + (gd[o3 + k] - gdS[o3 + k]) * t;
      axis(nb.subarray(o3, o3 + 3), gb);
      apex(p, view.c[b * 3], view.c[b * 3 + 1], view.c[b * 3 + 2]);
      const now = handed[p] ? 1 : t;
      const e = pinchS[p] + (pinch[p] - pinchS[p]) * now;
      const o = shapeOf(p, VbS[p] + (Vb[p] - VbS[p]) * now, phase[p] === 3 ? e : 0, recS[p] + (rec[p] - recS[p]) * now);
      const rho0 = profile(o, cap[p], td, r0, p, smoothstep(0, 1, e));
      (td[r0] = S[0]), (td[r0 + 1] = S[1]), (td[r0 + 2] = S[2]), (td[r0 + 3] = rho0);
      (td[r0 + 4] = ax[0]), (td[r0 + 5] = ax[1]), (td[r0 + 6] = ax[2]), (td[r0 + 7] = ZS * rF[p]);
      (td[r0 + 8] = nb[o3]), (td[r0 + 9] = nb[o3 + 1]), (td[r0 + 10] = nb[o3 + 2]), (td[r0 + 11] = 0);
    }
    tex.needsUpdate = true;
    return count;
  }

  function prime() {
    resetPrev.fill(1);
  }

  function reset() {
    alive.fill(0);
    blob.fill(-1);
    Vb.fill(0);
    L.fill(0);
    Rd.fill(0);
    pinch.fill(0);
    prime();
  }

  return {
    MAXP,
    // Bulb equators (world) and radii (object units) of live pools, for the occluders.
    bulbs(out) {
      let n = 0;
      for (let p = 0; p < MAXP; p++) {
        if (!alive[p] || Rd[p] < 0.01) continue;
        out.push(x[p * 3], x[p * 3 + 1], x[p * 3 + 2], Rd[p]);
        n++;
      }
      return n;
    },
    tex,
    params,
    stats,
    ledger,
    alive,
    blob,
    phase,
    pinch,
    rec,
    L,
    Vb,
    VbMax,
    Rd,
    rF,
    kap0,
    kap1,
    cap,
    x,
    vmax,
    create,
    retract,
    // A press on a pool that is draining makes it fill again.
    revive(p) {
      if (p < 0 || !alive[p] || phase[p] !== 2) return;
      phase[p] = 0;
      thenHeal[p] = 0;
      idle[p] = 0;
    },
    step,
    pack,
    prime,
    reset,
    dispose: () => tex.dispose(),
    get lastReject() {
      return lastReject;
    },
  };
}
