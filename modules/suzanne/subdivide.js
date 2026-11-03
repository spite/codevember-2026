import { BufferGeometry, BufferAttribute } from "three";

// Loop subdivision for triangle BufferGeometry.
//
// third_party/SubdivisionModifier.js does the same job, but it is written against the legacy
// `Geometry` / `Face3` classes and imports them from the r113 copy of three that also sits in
// third_party. The build the sketches actually run on ("three" in the import map) is a modern
// one with neither class in it — so using that modifier would mean pulling a second, 1.2 MB
// copy of three into the page and then handing the renderer a geometry type it cannot consume.
// This is the same subdivision scheme written against the array layout everything here uses.
//
// Loop is the right scheme for these models: it is defined for triangle meshes (Catmull–Clark
// wants quads) and its limit surface is C² away from extraordinary vertices, which is what
// takes the facets off a low-poly cage like Suzanne.

// OBJLoader hands back a non-indexed soup where every triangle carries its own three vertices,
// so neighbouring faces share no indices at all. Loop needs adjacency, so positions are welded
// back together first — quantised, because the same corner written by two faces can differ in
// the last bits.
function weld(geo, eps = 1e-5) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const count = idx ? idx.count : pos.count;

  const map = new Map();
  const verts = [];
  const faces = [];

  const lookup = (vi) => {
    const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
    const k = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      map.set(k, id);
    }
    return id;
  };

  for (let i = 0; i + 2 < count; i += 3) {
    const a = lookup(idx ? idx.getX(i)     : i);
    const b = lookup(idx ? idx.getX(i + 1) : i + 1);
    const c = lookup(idx ? idx.getX(i + 2) : i + 2);
    // Welding can collapse a sliver triangle onto a line; it carries no area and would only
    // pollute the adjacency.
    if (a === b || b === c || c === a) continue;
    faces.push(a, b, c);
  }
  return { verts, faces };
}

// One Loop step: every triangle becomes four, and every original vertex moves.
function loopStep({ verts, faces }) {
  const nv = verts.length / 3;
  const nf = faces.length / 3;

  // Edge -> the two vertices across it. Two opposites means an interior edge, one means a
  // boundary, which takes different weights throughout.
  const edges = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

  const touch = (a, b, opposite) => {
    const k = key(a, b);
    let e = edges.get(k);
    if (!e) { e = { a, b, opp: [], point: -1 }; edges.set(k, e); }
    e.opp.push(opposite);
    return e;
  };

  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    touch(a, b, c); touch(b, c, a); touch(c, a, b);
  }

  // Adjacency, split so boundary vertices can be moved by their boundary neighbours alone —
  // dragging them with the interior rule would shrink and round off open edges.
  const neighbours = Array.from({ length: nv }, () => new Set());
  const boundaryNb = Array.from({ length: nv }, () => []);
  for (const e of edges.values()) {
    neighbours[e.a].add(e.b);
    neighbours[e.b].add(e.a);
    if (e.opp.length < 2) { boundaryNb[e.a].push(e.b); boundaryNb[e.b].push(e.a); }
  }

  const out = [];
  const V = (i, k) => verts[i * 3 + k];

  // Odd (new) vertices, one per edge.
  for (const e of edges.values()) {
    e.point = nv + out.length / 3;
    if (e.opp.length >= 2) {
      const [o0, o1] = e.opp;
      for (let k = 0; k < 3; k++) {
        out.push(0.375 * (V(e.a, k) + V(e.b, k)) + 0.125 * (V(o0, k) + V(o1, k)));
      }
    } else {
      for (let k = 0; k < 3; k++) out.push(0.5 * (V(e.a, k) + V(e.b, k)));
    }
  }

  // Even (original) vertices, repositioned.
  const moved = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const bnb = boundaryNb[v];
    if (bnb.length === 2) {
      // Boundary: a curve rule that only sees the edge it lies on.
      for (let k = 0; k < 3; k++) {
        moved[v * 3 + k] = 0.75 * V(v, k) + 0.125 * (V(bnb[0], k) + V(bnb[1], k));
      }
      continue;
    }
    const nb = [...neighbours[v]];
    const n = nb.length;
    if (n === 0) { for (let k = 0; k < 3; k++) moved[v * 3 + k] = V(v, k); continue; }
    // Warren's beta. At n = 3 it comes out to exactly 3/16, the usual special case.
    const t = 0.375 + 0.25 * Math.cos((2 * Math.PI) / n);
    const beta = (1 / n) * (0.625 - t * t);
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (const j of nb) sum += V(j, k);
      moved[v * 3 + k] = (1 - n * beta) * V(v, k) + beta * sum;
    }
  }

  const newVerts = new Array(nv * 3 + out.length);
  for (let i = 0; i < nv * 3; i++) newVerts[i] = moved[i];
  for (let i = 0; i < out.length; i++) newVerts[nv * 3 + i] = out[i];

  // Each triangle splits into three corner triangles plus the middle one.
  const newFaces = [];
  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    const ab = edges.get(key(a, b)).point;
    const bc = edges.get(key(b, c)).point;
    const ca = edges.get(key(c, a)).point;
    newFaces.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }

  return { verts: newVerts, faces: newFaces };
}

function toBufferGeometry({ verts, faces }) {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(Float32Array.from(verts), 3));
  geo.setIndex(new BufferAttribute(
    verts.length / 3 > 65535 ? Uint32Array.from(faces) : Uint16Array.from(faces), 1
  ));
  return geo;
}

// `maxFaces` is a ceiling on the result, not on the input: every level multiplies the face
// count by four, so a level too far on a heavy model is the difference between a smoother
// silhouette and a locked tab. Levels stop early rather than the whole call refusing.
export function subdivide(geo, levels = 1, maxFaces = 200000) {
  let mesh = weld(geo);
  for (let i = 0; i < levels; i++) {
    if ((mesh.faces.length / 3) * 4 > maxFaces) break;
    mesh = loopStep(mesh);
  }
  return toBufferGeometry(mesh);
}

// How many levels `maxFaces` actually allows, so the UI can say what it will do.
export function affordableLevels(faceCount, levels, maxFaces = 200000) {
  let n = 0, f = faceCount;
  while (n < levels && f * 4 <= maxFaces) { f *= 4; n++; }
  return n;
}
