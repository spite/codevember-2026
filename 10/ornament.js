// Generates an ornament: the chosen pattern lays out its primitives (patterns/), then they are copied to each
// symmetry image, their growth times normalized, and the hammer blows planned.
// Output: primitives with a growth order (ta, tb in 0..1) and a hammer time (th), and the blows.
import { LEAF, FROND, SCALE, FRET, GUILLOCHE, BLADE, seedRandom, symmetryImages, hammerBlows } from "./kit.js";
import { PATTERNS } from "./patterns/index.js";

export * from "./kit.js";
export { PATTERNS };

/*
 * opts: pattern (a key of PATTERNS), seed, scale, symmetry, plus the pattern's own options.
 * A pattern is (shape, opts, kit) => prims, where kit.images are the symmetry images (3×3 matrices): it gives them to
 * its Occupancy (occ.images = kit.images) so motifs grow up to the planes; the copies are made here.
 */
export function generateOrnament(shape, opts = {}) {
  seedRandom(opts.seed ?? 1);
  const S = opts.scale ?? 1;
  let images = symmetryImages(opts.symmetry ?? "none", shape);
  const generate = PATTERNS[opts.pattern] ?? PATTERNS.rinceau;
  const prims = generate(shape, opts, { images });
  // A pattern that had to cover the whole surface itself.
  if (prims.whole) images = [];

  // Growth order → [0, 1].
  let tMax = 0;
  for (const p of prims) tMax = Math.max(tMax, p.tb);
  for (const p of prims) {
    p.ta /= tMax;
    p.tb /= tMax;
  }

  // Every motif at each symmetry image; mirror images curl the other way.
  const count = prims.length;
  // A motif that lies on a mirror is its own image: keep one copy.
  const key = (q) => [q.type, ...q.a, ...(q.b ?? []), ...(q.c ?? []), q.curl ?? 0, q.spiral ?? 0, q.kA ?? 0, q.kB ?? 0].map((v) => Math.round(v * 1e5)).join();
  const seen = new Set(images.length ? prims.map(key) : []);
  for (const m of images) {
    const T = (v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const flip = m.det < 0 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const p = prims[i];
      const q = { ...p, a: T(p.a), b: p.b && T(p.b), c: p.c && T(p.c) };
      if (p.type === LEAF || p.type === BLADE) q.curl = (p.curl ?? 0) * flip;
      if (p.type === FROND) q.spiral = p.spiral * flip;
      if (p.twist !== undefined) q.twist = p.twist * flip;
      if (p.type === SCALE && flip < 0) q.nb = p.nb?.map(([u, v]) => [u, -v]);
      // Strap crossings whose cut angle is in the strap's own (handed) frame.
      if (p.flipSag) q.sag = p.sag * flip;
      // A panel's corners, in its own (handed) frame, stay counter-clockwise.
      if (p.type === GUILLOCHE && flip < 0) q.corners = p.corners.map(([x, y]) => [x, -y]).reverse();
      if (p.type === FRET) (q.kA = (p.kA ?? 0) * flip), (q.kB = (p.kB ?? 0) * flip);
      const k = key(q);
      if (seen.has(k)) continue;
      seen.add(k);
      prims.push(q);
    }
  }

  // Scales stacked on one spot (rows folding into a corner of the symmetry) keep only the first.
  const stack = new Map();
  const kept = prims.filter((p) => {
    if (p.type !== SCALE) return true;
    const r = p.W * 0.15;
    const k = p.a.map((v) => Math.floor(v / r));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const q of stack.get(`${k[0] + dx},${k[1] + dy},${k[2] + dz}`) ?? [])
            if (Math.hypot(q.a[0] - p.a[0], q.a[1] - p.a[1], q.a[2] - p.a[2]) < r && q.b[0] * p.b[0] + q.b[1] * p.b[1] + q.b[2] * p.b[2] > 0.98) return false;
    const key = k.join();
    stack.set(key, [...(stack.get(key) ?? []), p]);
    return true;
  });
  prims.length = 0;
  prims.push(...kept);

  const blows = hammerBlows(shape, prims, S);
  return { prims, blows };
}
