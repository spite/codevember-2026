import { BufferGeometry, Float32BufferAttribute, IcosahedronGeometry, Vector3 } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";

// ---------------------------------------------------------------- random, noise

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Value noise in [-1, 1].
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const s = (t) => t * t * (3 - 2 * t);
  const ux = s(fx), uy = s(fy), uz = s(fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return (
    l(
      l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
      l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy),
      uz,
    ) * 2 - 1
  );
}

function randomDirection(rand, out = new Vector3()) {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, Math.sin(a) * r, z);
}

// ---------------------------------------------------------------- peel

// A surface torn into curved shells. Each point belongs to the nearest of `count` centres spread
// over the surface, measured with noise so the tears wander; triangles that straddle a tear are cut
// along it, so the edges are smooth. Each piece is pushed in along the normals for thickness, with
// walls along its torn edge. `shell` runs from 1 on the outside to 0 on the inside.
// `warp` is how much the tears wander; `stretch` < 1 draws pieces out into splinters pointing away
// from `impact`, a point on or near the surface.
function peelPieces({ seed, count, shape, thickness = 0.09, warp: wander = 0.22, stretch = 1, impact = null }) {
  const rand = mulberry32(seed);
  // Centres spread evenly: the farthest of a few random candidates each time.
  const candidates = Array.from({ length: count * 12 }, () => shape.sample(rand));
  const centres = [candidates[0]];
  const nearest = candidates.map((c) => c.distanceToSquared(centres[0]));
  while (centres.length < count) {
    let best = 0;
    for (let i = 1; i < candidates.length; i++) if (nearest[i] > nearest[best]) best = i;
    centres.push(candidates[best]);
    for (let i = 0; i < candidates.length; i++) nearest[i] = Math.min(nearest[i], candidates[i].distanceToSquared(candidates[best]));
  }
  const warped = new Vector3();
  const warp = (p) => {
    const w = wander;
    return warped.set(
      p.x + noise3(p.x * 4 + 11, p.y * 4, p.z * 4) * w,
      p.y + noise3(p.x * 4, p.y * 4 + 23, p.z * 4) * w,
      p.z + noise3(p.x * 4, p.y * 4, p.z * 4 + 37) * w,
    );
  };
  // Distance with the part along each centre's way out from the impact shrunk, so cells run long that way.
  const outward = centres.map((c) => (impact ? c.clone().sub(impact).normalize() : null));
  const squeeze = 1 - stretch * stretch;
  const _d = new Vector3();
  const distance = (q, k) => {
    _d.subVectors(q, centres[k]);
    const d2 = _d.lengthSq();
    if (!impact) return d2;
    const along = _d.dot(outward[k]);
    return d2 - squeeze * along * along;
  };
  const score = (p, k) => -distance(warp(p), k);
  const owner = (p) => {
    const q = warp(p);
    let best = 0, bd = Infinity;
    for (let k = 0; k < centres.length; k++) {
      const d = distance(q, k);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  };
  const key = (v) => `${Math.round(v.p.x * 1e5)},${Math.round(v.p.y * 1e5)},${Math.round(v.p.z * 1e5)}`;
  // Where the tear between pieces a and b crosses an edge, computed the same way from either side.
  const crossing = (u, v, a, b) => {
    const [p, q] = key(u) < key(v) ? [u, v] : [v, u];
    const fp = score(p.p, a) - score(p.p, b), fq = score(q.p, a) - score(q.p, b);
    const t = fp / (fp - fq);
    return { p: p.p.clone().lerp(q.p, t), n: p.n.clone().lerp(q.n, t).normalize(), room: p.room + (q.room - p.room) * t };
  };

  const { position, normal, index, room } = shape;
  const vertices = [];
  for (let i = 0; i < position.length; i += 3)
    vertices.push({ p: new Vector3(position[i], position[i + 1], position[i + 2]), n: new Vector3(normal[i], normal[i + 1], normal[i + 2]), room: room[i / 3] });
  const owners = vertices.map((v) => owner(v.p));
  const polygons = centres.map(() => []);
  for (let t = 0; t < index.length; t += 3) {
    const tri = [vertices[index[t]], vertices[index[t + 1]], vertices[index[t + 2]]];
    const o = [owners[index[t]], owners[index[t + 1]], owners[index[t + 2]]];
    const distinct = [...new Set(o)];
    if (distinct.length === 1) polygons[o[0]].push(tri);
    else if (distinct.length === 2) {
      const [a, b] = distinct;
      const f = tri.map((v) => score(v.p, a) - score(v.p, b));
      for (const [cell, sign] of [[a, 1], [b, -1]]) {
        const poly = [];
        for (let e = 0; e < 3; e++) {
          const u = tri[e], v = tri[(e + 1) % 3];
          const fu = f[e] * sign, fv = f[(e + 1) % 3] * sign;
          if (fu >= 0) poly.push(u);
          if (fu >= 0 !== fv >= 0) poly.push(crossing(u, v, a, b));
        }
        if (poly.length >= 3) polygons[cell].push(poly);
      }
    } else {
      // Three pieces meet: the whole triangle goes to whichever owns its middle.
      polygons[owner(tri[0].p.clone().add(tri[1].p).add(tri[2].p).divideScalar(3))].push(tri);
    }
  }

  const _in = new Vector3();
  return polygons
    .map((polys) => {
      if (!polys.length) return null;
      const P = [], N = [], S = [];
      const push = (p, n, sh) => {
        P.push(p.x, p.y, p.z);
        N.push(n.x, n.y, n.z);
        S.push(sh);
      };
      // Thinner where the shape is thin, so the inside never comes out through the far side.
      const inner = (v) => _in.copy(v.p).addScaledVector(v.n, -Math.min(thickness, v.room));
      const edges = new Map();
      const facing = new Vector3();
      for (const poly of polys) {
        for (let i = 1; i < poly.length - 1; i++) {
          const tri = [poly[0], poly[i], poly[i + 1]];
          for (const v of tri) push(v.p, v.n, 1), facing.add(v.n);
          for (const v of [tri[0], tri[2], tri[1]]) push(inner(v), v.n.clone().negate(), 0);
        }
        for (let e = 0; e < poly.length; e++) {
          const a = poly[e], b = poly[(e + 1) % poly.length];
          const ka = key(a), kb = key(b);
          const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const seen = edges.get(id);
          if (seen) seen.count++;
          else edges.set(id, { a, b, count: 1 });
        }
      }
      // Walls along the torn edge: edges used by one polygon only, wound to face outwards.
      const tear = [];
      for (const { a: A, b: B, count } of edges.values()) {
        if (count !== 1) continue;
        tear.push({ p: A.p.clone().add(B.p).multiplyScalar(0.5), n: A.n.clone().add(B.n).normalize() });
        const n = new Vector3().crossVectors(B.p.clone().sub(A.p), A.n.clone().add(B.n)).normalize();
        push(A.p, n, 1);
        push(inner(B), n, 0);
        push(B.p, n, 1);
        push(A.p, n, 1);
        push(inner(A), n, 0);
        push(inner(B), n, 0);
      }
      // Where each vertex was on the whole shape, so patterns run on across the cracks.
      const home = Float32Array.from(P);
      // Centred on the piece, which turns about its middle.
      const centre = new Vector3();
      for (let i = 0; i < P.length; i += 3) centre.x += P[i], centre.y += P[i + 1], centre.z += P[i + 2];
      centre.divideScalar(P.length / 3);
      for (let i = 0; i < P.length; i += 3) P[i] -= centre.x, P[i + 1] -= centre.y, P[i + 2] -= centre.z;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(P, 3));
      geometry.setAttribute("normal", new Float32BufferAttribute(N, 3));
      geometry.setAttribute("shell", new Float32Attribute(S));
      geometry.setAttribute("home", new Float32BufferAttribute(home, 3));
      geometry.computeBoundingSphere();
      // Flies out along the way it faced, leaning away from the middle.
      const direction = facing.normalize().add(centre.clone().normalize().multiplyScalar(0.5)).normalize();
      return { geometry, centre, direction, tear };
    })
    .filter(Boolean);
}

function Float32Attribute(values) {
  return new Float32BufferAttribute(values, 1);
}

// ---------------------------------------------------------------- flesh

// A lumpy chunk of flesh: an icosphere pushed about by noise, stretched a little.
function fleshGeometry(seed) {
  const geometry = mergeVertices(new IcosahedronGeometry(1, 4));
  const p = geometry.attributes.position;
  const o = seed * 7.31;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = noise3(v.x * 1.6 + o, v.y * 1.6, v.z * 1.6) * 0.35 + noise3(v.x * 4 + o, v.y * 4, v.z * 4) * 0.1;
    v.multiplyScalar(1 + n);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// A juice sac: a spindle, pointed at both ends along z.
function sacGeometry() {
  const geometry = mergeVertices(new IcosahedronGeometry(1, 2));
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const taper = Math.sqrt(Math.max(0, 1 - z * z)) * (1 - 0.4 * Math.abs(z));
    const r = Math.hypot(p.getX(i), p.getY(i)) || 1;
    p.setXYZ(i, (p.getX(i) / r) * taper, (p.getY(i) / r) * taper, z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// A chip of shell: a thin irregular slab, its top (shell 1) the outer layer and its bottom (0) the inner.
function chipGeometry(seed, sides = 4) {
  const rand = mulberry32(seed);
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = ((i + (rand() - 0.5) * 0.6) / sides) * Math.PI * 2;
    const r = 0.6 + 0.5 * rand();
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const h = 0.12 + 0.1 * rand();
  const P = [], N = [], S = [];
  const tri = (a, b, c, sh) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = new Vector3(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]).normalize();
    for (const [p, s] of [[a, sh[0]], [b, sh[1]], [c, sh[2]]]) {
      P.push(...p);
      N.push(n.x, n.y, n.z);
      S.push(s);
    }
  };
  for (let i = 1; i < sides - 1; i++) {
    tri([...ring[0], h], [...ring[i], h], [...ring[i + 1], h], [1, 1, 1]);
    tri([...ring[0], -h], [...ring[i + 1], -h], [...ring[i], -h], [0, 0, 0]);
  }
  for (let i = 0; i < sides; i++) {
    const a = ring[i], b = ring[(i + 1) % sides];
    tri([...a, h], [...a, -h], [...b, -h], [1, 0, 0]);
    tri([...a, h], [...b, -h], [...b, h], [1, 0, 1]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(P, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(N, 3));
  geometry.setAttribute("shell", new Float32BufferAttribute(S, 1));
  geometry.setAttribute("home", new Float32BufferAttribute(P, 3));
  return geometry;
}

export { peelPieces, fleshGeometry, sacGeometry, chipGeometry, mulberry32, noise3, randomDirection };
