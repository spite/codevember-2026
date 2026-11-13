// Lays the feathers out over the straightened tube and packs them for the instanced mesh, off the main thread.
import { spreadFeathers } from "./tube.js";

// modules/random.js's seededRandom (that module reads window, which a worker hasn't got).
function seededRandom(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

onmessage = ({ data }) => {
  const { id, flat, r, length, top, spread, under, seed } = data;
  const random = seededRandom(seed);
  // The coat, and under it (optionally) a layer of short, wide feathers lying flat; the coat is rooted over it.
  const list = spreadFeathers(flat, r, { random, length, spacing: top });
  if (under) {
    for (const fe of spreadFeathers(flat, r, { random, length: 0.7 * length, spacing: 0.28 * spread, sweep: 0.3 })) list.push(Object.assign(fe, { under: true }));
  }
  const n = list.length;
  const roots = new Float32Array(n * 4), norms = new Float32Array(n * 4), dirs = new Float32Array(n * 4);
  const skins = new Float32Array(n * 4), shapes = new Float32Array(n * 4);
  list.forEach((fe, i) => {
    // Round a closed form; on a curl from the head (the palette's colour) to the tail (white).
    const pal = ((fe.u % 1) + 1) % 1;
    const seedValue = random(), rand = random();
    roots.set([fe.p.x, fe.p.y, fe.p.z, fe.l], i * 4);
    norms.set([fe.n.x, fe.n.y, fe.n.z, r], i * 4);
    dirs.set([fe.d.x, fe.d.y, fe.d.z, pal], i * 4);
    skins.set(fe.hs, i * 4);
    // Width before the vane's aspect: build() scales it.
    shapes.set([fe.l * (fe.width ?? 1) * (fe.under ? 1.3 : 1) * (0.95 + 0.1 * rand), fe.under ? 1 : 0, seedValue, 0], i * 4);
  });
  postMessage({ id, n, roots, norms, dirs, skins, shapes }, [roots.buffer, norms.buffer, dirs.buffer, skins.buffer, shapes.buffer]);
};
