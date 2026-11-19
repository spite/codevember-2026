import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Matrix4, Vector2, Vector3, ShapeUtils } from "three";

// Shape (u, v) goes to a piece's (Z, Y) and the extrusion to its X: pieces are thin along X, their path's direction.
const SHAPE_TO_PIECE = new Matrix4().makeBasis(new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(-1, 0, 0));

// Per-vertex outward normals of a loop (solid on its left), with the miter scale for offsetting.
function loopNormals(loop) {
  const n = loop.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
    let e1x = b[0] - a[0], e1y = b[1] - a[1];
    let e2x = c[0] - b[0], e2y = c[1] - b[1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // Right-hand normals point out of the solid.
    let nx = e1y + e2y, ny = -e1x - e2x;
    const ln = Math.hypot(nx, ny) || 1;
    nx /= ln; ny /= ln;
    const miter = Math.min(2, 1 / Math.max(0.5, nx * e1y - ny * e1x));
    out.push([nx, ny, miter]);
  }
  return out;
}

// A slab of the shapes, `thickness` along w, its edges rounded with radius `bevel`. The side walls run through the
// loops themselves; the caps are inset by the bevel.
function roundedSlab(shapes, { thickness, bevel, segments = 6 }) {
  const b = Math.min(bevel, thickness * 0.49);
  const half = thickness / 2;
  // Ring profile from the front cap edge round to the back one: [offset, w, normal radial, normal w].
  const profile = [];
  for (let k = 0; k <= segments; k++) {
    const phi = (k / segments) * Math.PI * 0.5;
    profile.push([-b * (1 - Math.sin(phi)), half - b + b * Math.cos(phi), Math.sin(phi), Math.cos(phi)]);
  }
  for (let k = segments; k >= 0; k--) {
    const phi = (k / segments) * Math.PI * 0.5;
    profile.push([-b * (1 - Math.sin(phi)), -(half - b + b * Math.cos(phi)), Math.sin(phi), -Math.cos(phi)]);
  }
  const R = profile.length;
  const positions = [];
  const normals = [];
  const index = [];
  const vertex = (x, y, z, nx, ny, nz) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return positions.length / 3 - 1;
  };
  for (const { outer, holes } of shapes) {
    const loops = [outer, ...holes];
    const capFront = [];
    const capBack = [];
    const capLoops = [];
    for (const loop of loops) {
      const nrm = loopNormals(loop);
      const n = loop.length;
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        const [x, y] = loop[i];
        const [nx, ny, m] = nrm[i];
        for (let k = 0; k < R; k++) {
          const [off, w, nr, nw] = profile[k];
          vertex(x + nx * off * m, y + ny * off * m, w, nx * nr, ny * nr, nw);
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        for (let k = 0; k < R - 1; k++) {
          // Rings k = segments and segments + 1 are the side wall.
          const A = base + i * R + k, B = base + j * R + k, C = base + j * R + k + 1, D = base + i * R + k + 1;
          index.push(A, D, C, A, C, B);
        }
      }
      // Triangulated on the loop itself: inset by the bevel, a corner tighter than it folds over and loses faces.
      capLoops.push(loop.map(([x, y]) => new Vector2(x, y)));
      for (let i = 0; i < n; i++) {
        capFront.push(base + i * R);
        capBack.push(base + i * R + R - 1);
      }
    }
    const faces = ShapeUtils.triangulateShape(capLoops[0], capLoops.slice(1));
    const flat = capLoops.flat();
    for (const [a, c, d] of faces) {
      const area = (flat[c].x - flat[a].x) * (flat[d].y - flat[a].y) - (flat[d].x - flat[a].x) * (flat[c].y - flat[a].y);
      if (area > 0) {
        index.push(capFront[a], capFront[c], capFront[d], capBack[a], capBack[d], capBack[c]);
      } else {
        index.push(capFront[a], capFront[d], capFront[c], capBack[a], capBack[c], capBack[d]);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setIndex(new Uint32BufferAttribute(index, 1));
  return geometry;
}

// Geometry for nested loops from the cutter ({ outer, holes } as flat (u, v) arrays), in the piece frame (thin along
// X) or, with toPiece false, extruded along Z.
function slabFromShapes(shapes, { thickness, bevel, segments = 6, toPiece = true }) {
  if (!shapes.length) return null;
  const pairs = (a) => {
    const out = [];
    for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
    return out;
  };
  const geometry = roundedSlab(
    shapes.map((s) => ({ outer: pairs(s.outer), holes: s.holes.map(pairs) })),
    { thickness, bevel, segments },
  );
  if (toPiece) geometry.applyMatrix4(SHAPE_TO_PIECE);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

// The flat caps of a prism (shapes extruded `thickness` along X), as a triangle soup for the cutter: a prism's
// silhouette along X is its caps.
function capSoup(shapes, thickness) {
  const out = [];
  const half = thickness / 2;
  for (const s of shapes) {
    const loops = [s.outer, ...s.holes].map((a) => {
      const pts = [];
      for (let i = 0; i < a.length; i += 2) pts.push(new Vector2(a[i], a[i + 1]));
      return pts;
    });
    const flat = loops.flat();
    for (const [a, b, c] of ShapeUtils.triangulateShape(loops[0], loops.slice(1))) {
      for (const x of [half, -half]) for (const k of [a, b, c]) out.push(x, flat[k].y, flat[k].x);
    }
  }
  return new Float32Array(out);
}

// Any geometry as a triangle soup, with its bounding sphere for culling.
function soup(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = Float32Array.from(g.attributes.position.array);
  if (g !== geometry) g.dispose();
  return positions;
}

function bounds(positions) {
  let cx = 0, cy = 0, cz = 0;
  const n = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) [cx, cy, cz] = [cx + positions[i], cy + positions[i + 1], cz + positions[i + 2]];
  [cx, cy, cz] = [cx / n, cy / n, cz / n];
  let r = 0;
  for (let i = 0; i < positions.length; i += 3) r = Math.max(r, Math.hypot(positions[i] - cx, positions[i + 1] - cy, positions[i + 2] - cz));
  return { centre: [cx, cy, cz], radius: r };
}

export { slabFromShapes, roundedSlab, capSoup, soup, bounds, SHAPE_TO_PIECE };
