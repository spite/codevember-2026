import { Vector3, Quaternion } from "three";
import { getSolid, normalizeSolid } from "modules/polyhedra/solids.js";

const MAX_FACES = 64;
const MAX_TUBES = 512;

// Prisms, antiprisms and bipyramids, which the solids module doesn't have.
const ring = (n, y, phase = 0) => Array.from({ length: n }, (_, i) => [Math.cos(((i + phase) / n) * 2 * Math.PI), y, Math.sin(((i + phase) / n) * 2 * Math.PI)]);
const range = (n, k = 0) => Array.from({ length: n }, (_, i) => i + k);
const FAMILIES = {
  prism: (n) => {
    const h = Math.sin(Math.PI / n);
    const faces = [range(n), range(n, n).reverse(), ...range(n).map((i) => [i, (i + 1) % n, n + ((i + 1) % n), n + i])];
    return { vertices: [...ring(n, h), ...ring(n, -h)], faces };
  },
  antiprism: (n) => {
    const s2 = 2 - 2 * Math.cos((2 * Math.PI) / n), c2 = 2 - 2 * Math.cos(Math.PI / n);
    const h = Math.sqrt(Math.max(s2 - c2, 0)) / 2;
    const faces = [range(n), range(n, n).reverse()];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + i], [(i + 1) % n, n + ((i + 1) % n), n + i]);
    return { vertices: [...ring(n, h), ...ring(n, -h, 0.5)], faces };
  },
  bipyramid: (n) => {
    const faces = [];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n], [(i + 1) % n, i, n + 1]);
    return { vertices: [...ring(n, 0), [0, 1.4, 0], [0, -1.4, 0]], faces };
  },
};
const SIDES = { triangular: 3, square: 4, pentagonal: 5, hexagonal: 6, octagonal: 8 };

// Solids already built by the worker, by name.
const prebuilt = new Map();

// Starts building the named solids in a worker, so picking one later doesn't stall a frame.
function prebuild(names) {
  const wanted = names.filter((n) => !FAMILIES[n.split(" ")[1]]);
  if (!wanted.length || typeof Worker === "undefined") return;
  const worker = new Worker(new URL("./solids.worker.js", import.meta.url), { type: "module" });
  let left = wanted.length;
  worker.onmessage = ({ data }) => {
    prebuilt.set(data.name, data);
    if (--left === 0) worker.terminate();
  };
  worker.postMessage(wanted);
}

// "pentagonal antiprism" and the like, or a solid from the solids module.
function solidNamed(name) {
  const [sides, family] = name.split(" ");
  if (FAMILIES[family] && SIDES[sides]) return normalizeSolid(FAMILIES[family](SIDES[sides]));
  return prebuilt.get(name) ?? getSolid(name);
}

// Keeps the part of a convex polygon (in a plane) where n·p <= d.
// Drops the corners a sliver's cut leaves behind: repeats and points along a straight side.
function simplify(poly) {
  let out = poly.filter((p, k) => p.distanceTo(poly[(k + 1) % poly.length]) > 1e-6);
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let k = 0; k < out.length && out.length > 3; k++) {
      const a = out[(k + out.length - 1) % out.length], p = out[k], b = out[(k + 1) % out.length];
      _s.subVectors(p, a);
      if (_e1.subVectors(b, p).cross(_s).length() < 1e-7 * _s.length() + 1e-9) {
        out.splice(k, 1);
        changed = true;
      }
    }
  }
  return out.length > 2 ? out : [];
}

function clip(poly, n, d) {
  const out = [], L = poly.length;
  if (!L) return out;
  const d0 = n.dot(poly[0]) - d;
  let da = d0;
  for (let i = 0; i < L; i++) {
    const a = poly[i], b = poly[(i + 1) % L];
    const db = i + 1 < L ? n.dot(b) - d : d0;
    if (da <= 0) out.push(a);
    if (da * db < 0) out.push(a.clone().lerp(b, da / (da - db)));
    da = db;
  }
  return out;
}

// A solid of circumradius 1 as planes { n, d } and its vertices, turned so vertex 0 points straight down.
function solidPlanes(name) {
  const solid = solidNamed(name);
  const verts = solid.vertices.map((v) => new Vector3(...v));
  const q = new Quaternion().setFromUnitVectors(verts[0].clone().normalize(), new Vector3(0, -1, 0));
  for (const v of verts) v.applyQuaternion(q);
  const planes = solid.faces.map((f) => {
    const poly = f.map((i) => verts[i]);
    const c = poly.reduce((s, p) => s.add(p), new Vector3()).divideScalar(poly.length);
    const n = new Vector3().subVectors(poly[1], poly[0]).cross(new Vector3().subVectors(poly[2], poly[0])).normalize();
    if (n.dot(c) < 0) n.negate();
    return { n, d: n.dot(poly[0]) };
  });
  return { planes, verts };
}

// The solids in between A and B (t from 0 to 1): every face direction of both, each plane at the blend of the two
// solids' support distances. At t = 0 B's planes only touch A, at t = 1 A's only touch B.
function morphPlanes(A, B, t) {
  const support = (S, n) => {
    let m = -Infinity;
    for (const v of S.verts) m = Math.max(m, n.dot(v));
    return m;
  };
  const out = [];
  for (const S of [A, B])
    for (const p of S.planes) {
      const d = (1 - t) * support(A, p.n) + t * support(B, p.n);
      if (!out.some((q) => q.n.dot(p.n) > 1 - 1e-6)) out.push({ n: p.n.clone(), d });
    }
  return out;
}

// The face polygons of the convex solid { n·p <= d } (faces that are only touched are dropped).
function facesOf(planes) {
  const faces = [];
  planes.forEach((pl, i) => {
    const u = new Vector3(1, 0, 0).cross(pl.n);
    if (u.lengthSq() < 1e-6) u.set(0, 1, 0).cross(pl.n);
    u.normalize();
    const v = new Vector3().crossVectors(pl.n, u);
    const o = pl.n.clone().multiplyScalar(pl.d);
    let poly = [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([x, y]) => o.clone().addScaledVector(u, x).addScaledVector(v, y));
    planes.forEach((q, j) => {
      if (j !== i && poly.length) poly = clip(poly, q.n, q.d);
    });
    poly = poly.filter((p, k) => p.distanceTo(poly[(k + 1) % poly.length]) > 1e-5);
    if (poly.length < 3 || polygonArea(poly) < 1e-4) return;
    const c = poly.reduce((s, p) => s.add(p), new Vector3()).divideScalar(poly.length);
    faces.push({ poly, n: pl.n.clone(), d: pl.d, c });
  });
  return faces;
}

const _s = new Vector3(), _e1 = new Vector3(), _e2 = new Vector3();
function polygonArea(p) {
  _s.set(0, 0, 0);
  for (let k = 1; k + 1 < p.length; k++) _s.add(_e1.subVectors(p[k], p[0]).cross(_e2.subVectors(p[k + 1], p[0])));
  return _s.length() / 2;
}

// The distinct corners of a set of faces.
function uniqueVerts(faces) {
  const seen = new Map();
  for (const f of faces)
    for (const p of f.poly) {
      const key = `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
      if (!seen.has(key)) seen.set(key, p);
    }
  return [...seen.values()];
}

// Unique edges of a set of faces, as [a, b] pairs.
function edgesOf(faces) {
  const out = [];
  for (const f of faces)
    f.poly.forEach((a, k) => {
      const b = f.poly[(k + 1) % f.poly.length];
      if (a.distanceTo(b) < 1e-3) return;
      if (!out.some(([p, q]) => (p.distanceTo(a) < 1e-4 && q.distanceTo(b) < 1e-4) || (p.distanceTo(b) < 1e-4 && q.distanceTo(a) < 1e-4))) out.push([a, b]);
    });
  return out;
}

// The sculpture's geometry for a convex solid given as planes, circumradius about 1.
// rim: frame width as a fraction of the mean edge length (less on small faces); lift: how far the frame stands proud of
// the glass; tubes sit just under the frame's inner edge, below the glass.
function makeSculpture(planes, { rim = 0.08, lift = 0.018 } = {}) {
  let faces = facesOf(planes);
  // Mid-morph between two large solids: keep the biggest faces, the rest are slivers.
  if (faces.length > MAX_FACES) {
    for (const f of faces) f.area = polygonArea(f.poly);
    const kept = [...faces].sort((a, b) => b.area - a.area).slice(0, MAX_FACES);
    faces = facesOf(kept.map((f) => ({ n: f.n, d: f.d })));
  }
  const verts = faces.flatMap((f) => f.poly);

  const inradii = faces.map((f) => {
    let perimeter = 0;
    f.poly.forEach((p, k) => (perimeter += p.distanceTo(f.poly[(k + 1) % f.poly.length])));
    return (2 * polygonArea(f.poly)) / Math.max(perimeter, 1e-9);
  });
  // How much a face's edges inset its neighbours' windows: all of it, unless it is a sliver fading out of a morph.
  const presence = inradii.map((r) => {
    const x = Math.min(r / 0.08, 1);
    return x * x * (3 - 2 * x);
  });

  // The window of a face: where the in-plane distance to every other face's plane is at least `inset`.
  const inner = (fi, inset) => {
    const f = faces[fi];
    let poly = f.poly;
    faces.forEach((g, gi) => {
      if (gi === fi) return;
      const s = _s.crossVectors(f.n, g.n).length();
      if (s < 1e-6) return;
      poly = clip(poly, g.n, g.d - inset * s * presence[gi]);
    });
    return poly;
  };

  // Mean edge length, weighted by length and by the face's presence so the slivers of a morph don't count.
  // An edge is a straight run of the outline, however many vertices a sliver puts along it.
  let edges = 0, count = 0;
  faces.forEach((f, i) => {
    const P = f.poly;
    const segs = [];
    P.forEach((p, k) => {
      const d = P[(k + 1) % P.length].clone().sub(p);
      const l = d.length();
      if (l < 1e-6) return;
      const last = segs[segs.length - 1];
      if (last && last.d.dot(d) > 0.9998 * l) last.l += l;
      else segs.push({ d: d.divideScalar(l), l });
    });
    if (segs.length > 1 && segs[0].d.dot(segs[segs.length - 1].d) > 0.9998) segs[0].l += segs.pop().l;
    for (const { l: run } of segs) {
      const l = run * presence[i];
      edges += l * l;
      count += l;
    }
  });
  const w = (rim * edges) / count;
  // Tubes in proportion to the edges, so small faces keep the look; never wider than a bar can hide.
  const edge = edges / count;
  const radius = Math.min(0.011, 0.0105 * edge);
  // Each face's bar is at most a share of its inradius, so small and narrow faces keep a real window.
  const widths = inradii.map((r) => Math.min(w, Math.min(3.5 * rim, 0.35) * r));
  const tube = { radius, depth: Math.min(0.025, 2.4 * radius) };
  const offsets = widths.map((wi) => Math.max(wi - 0.35 * radius, radius));
  const windows = faces.map((_, i) => simplify(inner(i, widths[i])));
  // Tubes dim as their loop shrinks to nothing, so a face fading out of a morph doesn't pop.
  const fades = inradii.map((r, i) => {
    const x = Math.min(Math.max((r - offsets[i] - radius) / (6 * radius), 0), 1);
    return x * x * (3 - 2 * x);
  });

  // Light tubes: one along each edge of each window, a little under the frame and below the glass.
  const tubes = [];
  faces.forEach((f, i) => {
    const poly = inner(i, offsets[i]).map((p) => p.clone().addScaledVector(f.n, -tube.depth));
    for (let k = 0; k < poly.length && poly.length > 2; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      // Pulled in at the ends so tubes meeting at a corner don't overlap; short ones fade in as they grow.
      const length = a.distanceTo(b) - 2 * tube.radius;
      if (length <= 1e-4) continue;
      const x = Math.min(length / (4 * tube.radius), 1);
      const dir = b.clone().sub(a).normalize();
      if (tubes.length < MAX_TUBES) tubes.push([a.clone().addScaledVector(dir, tube.radius), b.clone().addScaledVector(dir, -tube.radius), i, x * x * (3 - 2 * x) * fades[i]]);
    }
  });

  // How much of the solid's surface is tube and how much open window, for the tracer's estimate of deep bounces.
  const area = polygonArea;
  const faceArea = faces.reduce((s, f) => s + area(f.poly), 0);
  const tubeArea = tubes.reduce((s, [a, b, , fade]) => s + a.distanceTo(b) * 2 * tube.radius * fade, 0);
  const winArea = windows.reduce((s, p) => s + (p.length > 2 ? area(p) : 0), 0);
  const cover = tubeArea / faceArea, open = Math.max(winArea - tubeArea, 0) / faceArea;
  const bound = Math.max(...verts.map((v) => v.length())) + lift;
  return { faces, windows, widths, fades, presence, tubes, frame: frameGeometry(faces, windows, lift), w, lift, tube, cover, open, bound };
}

// The frame: on every face, the band between the face (raised by lift) and its window, and the window's walls.
function frameGeometry(faces, windows, lift) {
  // rim per vertex: 0 on the bar's outer ridge (or at the glass, for walls), 1 at the window's lip.
  const band = { pos: [], rim: [] }, walls = { pos: [], rim: [] };
  let out = band;
  const tri = (a, b, c, ra, rb, rc) => {
    out.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    out.rim.push(ra, rb, rc);
  };
  // The raised faces meet along raised edges: the outer outline of each band is the face of the grown solid.
  const grown = faces.map((f, fi) => {
    // A large square on the raised plane, cut down by the other raised planes.
    const u = new Vector3(Math.abs(f.n.x) < 0.9 ? 1 : 0, Math.abs(f.n.x) < 0.9 ? 0 : 1, 0).cross(f.n).normalize().multiplyScalar(4);
    const v = new Vector3().crossVectors(f.n, u);
    const o = f.n.clone().multiplyScalar(f.d + lift);
    let poly = [o.clone().add(u).add(v), o.clone().sub(u).add(v), o.clone().sub(u).sub(v), o.clone().add(u).sub(v)];
    faces.forEach((g, gi) => {
      if (gi !== fi) poly = clip(poly, g.n, g.d + lift);
    });
    return poly;
  });
  faces.forEach((f, i) => {
    const outer = grown[i];
    const win = windows[i];
    if (outer.length < 3) return;
    if (win.length < 3) {
      for (let k = 1; k + 1 < outer.length; k++) tri(outer[0], outer[k], outer[k + 1], 1, 1, 1);
      return;
    }
    const top = win.map((p) => p.clone().addScaledVector(f.n, lift));
    // Band: the annulus between the two loops, walked together in angle order around the window's centre,
    // which both loops surround (the face's own centre can fall outside a lopsided window).
    const c = top.reduce((m, p) => m.add(p), new Vector3()).divideScalar(top.length);
    const u = new Vector3().subVectors(outer[0], c).projectOnPlane(f.n).normalize();
    const v = new Vector3().crossVectors(f.n, u);
    const base = (p) => {
      const r = new Vector3().subVectors(p, c);
      const a = Math.atan2(r.dot(v), r.dot(u));
      return a < -1e-9 ? a + 2 * Math.PI : a;
    };
    const O = outer.map((p) => ({ p, a: base(p) })).sort((x, y) => x.a - y.a);
    const I = top.map((p) => ({ p, a: base(p) })).sort((x, y) => x.a - y.a);
    const at = (L, k) => L[k % L.length].a + Math.floor(k / L.length) * 2 * Math.PI;
    let oi = 0, ii = 0;
    while (oi < O.length || ii < I.length) {
      const o0 = O[oi % O.length].p, i0 = I[ii % I.length].p;
      if (ii >= I.length || (oi < O.length && at(O, oi + 1) <= at(I, ii + 1))) {
        tri(o0, O[(oi + 1) % O.length].p, i0, 0, 0, 1);
        oi++;
      } else {
        tri(o0, I[(ii + 1) % I.length].p, i0, 0, 1, 1);
        ii++;
      }
    }
    // Window walls, from the glass up to the band.
    out = walls;
    for (let k = 0; k < win.length; k++) {
      const a = win[k], b = win[(k + 1) % win.length];
      const a1 = top[k], b1 = top[(k + 1) % win.length];
      tri(a, a1, b1, 0, 1, 1);
      tri(a, b1, b, 0, 1, 0);
    }
    out = band;
  });
  return { band: toArrays(band), walls: toArrays(walls) };
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _n = new Vector3();
// Triangle soup as arrays: every triangle turned outwards (away from the centre), with flat normals.
function toArrays({ pos, rim }) {
  const position = new Float32Array(pos), rims = new Float32Array(rim), normal = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 9) {
    _a.fromArray(position, k);
    _b.fromArray(position, k + 3);
    _c.fromArray(position, k + 6);
    _n.subVectors(_b, _a).cross(_e1.subVectors(_c, _a));
    if (_n.dot(_e2.copy(_a).add(_b).add(_c)) < 0) {
      _b.toArray(position, k + 6);
      _c.toArray(position, k + 3);
      const v = k / 3;
      [rims[v + 1], rims[v + 2]] = [rims[v + 2], rims[v + 1]];
      _n.negate();
    }
    _n.normalize();
    for (let j = 0; j < 3; j++) _n.toArray(normal, k + 3 * j);
  }
  return { position, rim: rims, normal };
}

export { makeSculpture, solidPlanes, prebuild, morphPlanes, facesOf, edgesOf, polygonArea, uniqueVerts, MAX_FACES, MAX_TUBES };
