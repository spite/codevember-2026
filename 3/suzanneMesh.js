import { BufferAttribute, BufferGeometry } from "three";
import { subdivide } from "./subdivide.js";

// Non-indexed triangle soup in file order, fan-triangulated. Repeated triangles and fins (a triangle
// hanging off an edge shared by more than two, with a corner no other triangle uses) are dropped.
export function parseOBJ(text) {
  const v = [];
  const tris = [];
  const key = (p) => p.map((x) => Math.round(x / 1e-5)).join(",");
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v") v.push([+parts[1], +parts[2], +parts[3]]);
    else if (parts[0] === "f") {
      const idx = parts.slice(1).map((s) => {
        const i = parseInt(s.split("/")[0], 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        const p = [v[idx[0]], v[idx[k]], v[idx[k + 1]]];
        tris.push({ p, k: p.map(key) });
      }
    }
  }
  const seen = new Set();
  const unique = tris.filter((t) => {
    const id = [...t.k].sort().join("|");
    return !seen.has(id) && seen.add(id);
  });
  const uses = new Map(), edges = new Map();
  const edge = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  for (const { k } of unique) {
    for (const x of k) uses.set(x, (uses.get(x) || 0) + 1);
    for (let e = 0; e < 3; e++) edges.set(edge(k[e], k[(e + 1) % 3]), (edges.get(edge(k[e], k[(e + 1) % 3])) || 0) + 1);
  }
  const fin = ({ k }) => k.some((x) => uses.get(x) === 1) && [0, 1, 2].some((e) => edges.get(edge(k[e], k[(e + 1) % 3])) > 2);
  return Float32Array.from(unique.filter((t) => !fin(t)).flatMap((t) => t.p.flat()));
}

// Indexed, Loop-subdivided Suzanne, mapped by the asset's transform: p' = (p - center) * scale.
// The vertex order matches the per-vertex AO baked into assets/suzanne.bin for the same level.
export function suzanneGeometry(objText, level, transform) {
  const soup = new BufferGeometry();
  soup.setAttribute("position", new BufferAttribute(parseOBJ(objText), 3));
  const geo = subdivide(soup, level, 1e9);
  if (transform) {
    const p = geo.attributes.position.array, [cx, cy, cz] = transform.center, s = transform.scale;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = (p[i] - cx) * s;
      p[i + 1] = (p[i + 1] - cy) * s;
      p[i + 2] = (p[i + 2] - cz) * s;
    }
  }
  return geo;
}
