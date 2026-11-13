// A tube around a line: a closed torus knot (or a plain torus) of constant radius, or an open line traced through a
// curl-noise field, rounded off at both tips. Feathers spread over it: roots by area with no two closer than a
// fraction of their length (Poisson disc), each pointing along the line.
import { Vector3, Quaternion, BufferGeometry, BufferAttribute } from "three";

const TAU = Math.PI * 2;

// A (p, q) torus knot of overall radius R (q = 0: a circle, the torus).
function knotPoint(p, q, R, t, out) {
  if (q === 0) return out.set(Math.cos(t) * R, Math.sin(t) * R, 0);
  const r = (2 + Math.cos(q * t)) / 3;
  return out.set(r * Math.cos(p * t), r * Math.sin(p * t), Math.sin(q * t) / 3).multiplyScalar(R);
}

// A centre line from a polyline: n points evenly spaced by arc length, tangents and twist-free normals (which close
// up, for a closed line).
function lineFromPoints(raw, closed, n = 1024) {
  const L = [0];
  for (let i = 1; i < raw.length; i++) L.push(L[i - 1] + raw[i].distanceTo(raw[i - 1]));
  const length = L[L.length - 1];
  const P = [];
  let j = 0;
  const count = closed ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const target = (i / n) * length;
    while (j < raw.length - 2 && L[j + 1] < target) j++;
    P.push(new Vector3().lerpVectors(raw[j], raw[j + 1], Math.min(1, (target - L[j]) / (L[j + 1] - L[j]))));
  }
  const m = P.length;
  const at = (i) => P[closed ? (i + m) % m : Math.min(Math.max(i, 0), m - 1)];
  const T = P.map((_, i) => new Vector3().subVectors(at(i + 1), at(i - 1)).normalize());
  const N = [];
  const nv = new Vector3(0, 0, 1).cross(T[0]);
  if (nv.lengthSq() < 1e-6) nv.set(1, 0, 0).cross(T[0]);
  nv.normalize();
  const n0 = nv.clone();
  const q4 = new Quaternion();
  for (let i = 0; i < m; i++) {
    if (i > 0) nv.applyQuaternion(q4.setFromUnitVectors(T[i - 1], T[i])).addScaledVector(T[i], -nv.dot(T[i])).normalize();
    N.push(nv.clone());
  }
  if (closed) {
    // The twist left at the seam, spread along the loop.
    const back = nv.clone().applyQuaternion(q4.setFromUnitVectors(T[m - 1], T[0]));
    const seam = Math.atan2(new Vector3().crossVectors(back, n0).dot(T[0]), back.dot(n0));
    for (let i = 0; i < m; i++) N[i].applyAxisAngle(T[i], (seam * i) / m);
  }
  const B = T.map((t, i) => new Vector3().crossVectors(t, N[i]));
  return { P, T, N, B, n, length, closed };
}

// Other closed knots, as curves over t in 0..2pi (any scale; they are fitted to the size asked for).
const KNOT_CURVES = {
  // The classic trefoil.
  trefoil: (t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)],
  "figure-eight": (t) => [(2 + Math.cos(2 * t)) * Math.cos(3 * t), (2 + Math.cos(2 * t)) * Math.sin(3 * t), Math.sin(4 * t)],
  // A ring with a saddle's double wave, and a crown's triple one.
  saddle: (t) => [Math.cos(t), Math.sin(t), 0.35 * Math.cos(2 * t)],
  crown: (t) => [Math.cos(t), Math.sin(t), 0.3 * Math.cos(3 * t)],
  // A star knot, looping out five times.
  star: (t) => [Math.cos(t) + 2 * Math.cos(3 * t), Math.sin(t) - 2 * Math.sin(3 * t), 1.2 * Math.sin(4 * t)],
};

// A named knot fitted so its furthest point is R from its centre.
function knotLine(name, R, n = 1024) {
  const fn = KNOT_CURVES[name];
  const fine = n * 8;
  const raw = [];
  const c = new Vector3();
  for (let i = 0; i <= fine; i++) raw.push(new Vector3(...fn((i / fine) * TAU)));
  for (const p of raw) c.add(p);
  c.divideScalar(raw.length);
  let max = 0;
  for (const p of raw) max = Math.max(max, p.sub(c).length());
  for (const p of raw) p.multiplyScalar(R / max);
  return lineFromPoints(raw, true, n);
}

function centreLine(p, q, R, n = 1024) {
  const fine = n * 8;
  const raw = [];
  for (let i = 0; i <= fine; i++) raw.push(knotPoint(p, q, R, (i / fine) * TAU, new Vector3()));
  return lineFromPoints(raw, true, n);
}

// The same tube straightened: its axis along x from 0 to length (y and z across). Feathers are laid out on it, and
// the shaders bend them onto the real centre line (spine texture), so the form can move or change under them.
function straightLine(line) {
  return { straight: true, closed: line.closed, length: line.length, taper: line.taper ?? 0, n: 1024 };
}

// The tube's radius at arc parameter u, as a fraction of its full radius, and its slope (per unit of length). An
// open line tapers along its length (line.taper: how much thinner the tail is) and rounds off at both tips.
function profile(line, r, u) {
  if (line.closed) return [1, 0];
  const L = line.length;
  const s = Math.min(Math.max(u, 0), 1) * L;
  const taper = line.taper ?? 0;
  const w = 1 - (taper * s) / L;
  const dw = -taper / L;
  const head = 1.4 * r, tail = 1.4 * r * (1 - taper);
  let c = 1, dc = 0;
  if (s < head) {
    const x = 1 - s / head;
    c = Math.sqrt(Math.max(1 - x * x, 1e-6));
    dc = x / c / head;
  } else if (L - s < tail) {
    const x = 1 - (L - s) / tail;
    c = Math.sqrt(Math.max(1 - x * x, 1e-6));
    dc = -x / c / tail;
  }
  return [w * c, dw * c + w * dc];
}

// Surface area of the tube of radius r, in feather-sized units (see spreadFeathers).
function tubeArea(line, r) {
  if (line.closed) return 2 * Math.PI * r * line.length;
  let a = 0;
  const steps = 400;
  // Weighted by the number of feathers it takes: they shrink with the taper.
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps;
    a += profile(line, r, u)[0] / Math.max(0.3, 1 - (line.taper ?? 0) * u) ** 2;
  }
  return 2 * Math.PI * r * line.length * (a / steps);
}

// The closest the centre line comes to itself across its own normal planes (where another stretch passes beside
// it, not along it): tubes thicker than half of it would cross.
function clearance(line) {
  const { P, T, n } = line;
  let min = Infinity;
  const d = new Vector3();
  for (let i = 0; i < n; i += 2) for (let j = i + 4; j < n; j += 2) {
    d.subVectors(P[j], P[i]);
    const l2 = d.lengthSq();
    if (l2 >= min) continue;
    const l = Math.sqrt(l2);
    if (Math.abs(d.dot(T[i])) < 0.25 * l && Math.abs(d.dot(T[j])) < 0.25 * l) min = l2;
  }
  return Math.sqrt(min);
}

// Interpolated frame at arc parameter u (0..1, wrapping round a closed line, clamped on an open one).
function frameAt(line, u, P, T, N, B) {
  if (line.straight) {
    P.set((line.closed ? u : Math.min(Math.max(u, 0), 1)) * line.length, 0, 0);
    T.set(1, 0, 0);
    N.set(0, 1, 0);
    B.set(0, 0, 1);
    return;
  }
  const m = line.P.length;
  let x, i0, i1;
  if (line.closed) {
    x = (((u % 1) + 1) % 1) * line.n;
    i0 = Math.floor(x) % m;
    i1 = (i0 + 1) % m;
  } else {
    x = Math.min(Math.max(u, 0), 1) * line.n;
    i0 = Math.min(Math.floor(x), m - 2);
    i1 = i0 + 1;
  }
  const f = x - Math.floor(x) + (line.closed ? 0 : Math.floor(x) - i0);
  P.lerpVectors(line.P[i0], line.P[i1], f);
  T.lerpVectors(line.T[i0], line.T[i1], f).normalize();
  N.lerpVectors(line.N[i0], line.N[i1], f);
  N.addScaledVector(T, -N.dot(T)).normalize();
  B.crossVectors(T, N);
}

// The point of the skin at (u, around angle a), and its outward normal (tilted where the tips round off).
function surfacePoint(line, r, u, a, out, nrm) {
  frameAt(line, u, _P, _T, _N, _B);
  const [v, slope] = profile(line, r, u);
  nrm.copy(_N).multiplyScalar(Math.cos(a)).addScaledVector(_B, Math.sin(a));
  out.copy(_P).addScaledVector(nrm, r * v);
  nrm.addScaledVector(_T, -slope * r).normalize();
  return out;
}

// The skin: a grid over the tube (closed round it, and along it for a closed line).
function tubeGeometry(line, r, along = 512, around = 48) {
  // A straightened closed tube keeps a last row at its far end (not joined back to the first), so it can open.
  const rows = line.closed && !line.straight ? along : along + 1;
  const pos = new Float32Array(rows * around * 3);
  const nrm = new Float32Array(rows * around * 3);
  for (let i = 0; i < rows; i++) for (let j = 0; j < around; j++) {
    surfacePoint(line, r, i / along, (j / around) * TAU, _p, _n);
    _p.toArray(pos, (i * around + j) * 3);
    _n.toArray(nrm, (i * around + j) * 3);
  }
  const index = [];
  for (let i = 0; i < along; i++) for (let j = 0; j < around; j++) {
    const i1 = line.closed && !line.straight ? (i + 1) % along : i + 1;
    const a = i * around + j, b = i1 * around + j, c = i1 * around + ((j + 1) % around), d = i * around + ((j + 1) % around);
    // Counter-clockwise seen from outside.
    index.push(a, c, b, a, d, c);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nrm, 3));
  g.setIndex(index);
  return g;
}

// The tube's nearest centre-line sample to q (searched around arc parameter u).
function nearest(line, r, q, u) {
  const m = line.P.length;
  let best = Infinity, bi = 0;
  const c = Math.round(u * line.n);
  const w = Math.ceil((4 * r) / (line.length / line.n)) + 8;
  for (let k = c - w; k <= c + w; k++) {
    if (!line.closed && (k < 0 || k >= m)) continue;
    const i = ((k % m) + m) % m;
    const d = line.P[i].distanceToSquared(q);
    if (d < best) (best = d), (bi = i);
  }
  return bi;
}
// q moved onto the skin of the tube of radius r (along the line from its nearest centre-line point).
function projectToSurface(line, r, q, u, out) {
  if (line.straight) {
    const x = line.closed ? q.x : Math.min(Math.max(q.x, 0), line.length);
    _pq.set(0, q.y, q.z);
    if (_pq.lengthSq() < 1e-12) _pq.set(0, 1, 0);
    _pq.normalize();
    return out.set(x, 0, 0).addScaledVector(_pq, r * profile(line, r, x / line.length)[0]);
  }
  const i = nearest(line, r, q, u);
  const m = line.P.length;
  // Refine on the two segments around the nearest sample.
  let bestD = Infinity, bestU = 0;
  for (const j of [i - 1, i]) {
    if (!line.closed && (j < 0 || j >= m - 1)) continue;
    const j0 = (j + m) % m;
    const a = line.P[j0], b = line.P[(j0 + 1) % m];
    _pe.subVectors(b, a);
    const t = Math.min(1, Math.max(0, _pq.subVectors(q, a).dot(_pe) / _pe.lengthSq()));
    _pc.copy(a).addScaledVector(_pe, t);
    const d = _pc.distanceToSquared(q);
    if (d < bestD) (bestD = d), _pb.copy(_pc), (bestU = (j0 + t) / line.n);
  }
  _pq.subVectors(q, _pb).normalize();
  return out.copy(_pb).addScaledVector(_pq, r * profile(line, r, bestU)[0]);
}
const _pe = new Vector3(), _pq = new Vector3(), _pc = new Vector3(), _pb = new Vector3();

// The skin's outward normal at the point nearest p.
function surfaceNormalNear(line, r, p, u) {
  if (line.straight) {
    _sn.set(0, p.y, p.z).normalize();
    const [, slope] = profile(line, r, p.x / line.length);
    return _sn.addScaledVector(_T.set(1, 0, 0), -slope * r).normalize();
  }
  const i = nearest(line, r, p, u);
  frameAt(line, i / line.n, _P, _T, _N, _B);
  _sn.subVectors(p, _P);
  _sn.addScaledVector(_T, -_sn.dot(_T)).normalize();
  const [, slope] = profile(line, r, i / line.n);
  return _sn.addScaledVector(_T, -slope * r).normalize();
}
const _sn = new Vector3();

// Feathers over an open line's rounded head, in a golden-angle spiral from the tip: as many as cover it at the local
// size (which grows from a third of the regular one at the tip to all of it at head), each pointing away from the tip
// along the skin.
function headSpiral(line, r, { random, length, spacing, stretch, head, scaleAt }) {
  const L = line.length;
  const size = (sArc) => length * scaleAt(sArc / L) * (0.5 + 0.5 * smooth01(sArc / head));
  // Cumulative feather count along the head (area over the area one feather of that size takes).
  const steps = 200;
  const cum = [0];
  for (let i = 0; i < steps; i++) {
    const s0 = (head * i) / steps, s1 = (head * (i + 1)) / steps, sm = 0.5 * (s0 + s1);
    const [v, slope] = profile(line, r, sm / L);
    const dA = 2 * Math.PI * r * v * Math.sqrt(1 + (r * slope) ** 2) * (s1 - s0);
    cum.push(cum[i] + dA / (DENSITY * (spacing * size(sm)) ** 2));
  }
  const n = Math.round(cum[steps]);
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const phase = random() * TAU;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = k + 0.5;
    while (j < steps - 1 && cum[j + 1] < target) j++;
    const sArc = (head * (j + (target - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9))) / steps;
    const u = sArc / L, a = phase + k * golden;
    const p = new Vector3(), nn = new Vector3();
    surfacePoint(line, r, u, a, p, nn);
    frameAt(line, u, _P, _T, _N, _B);
    const [, slope] = profile(line, r, u);
    // Away from the tip: along the line, and outward as fast as the head widens.
    const e = _N.clone().multiplyScalar(Math.cos(a)).addScaledVector(_B, Math.sin(a));
    const d = _T.clone().addScaledVector(e, r * slope);
    d.addScaledVector(nn, -d.dot(nn)).normalize();
    const kf = size(sArc) / length;
    out.push({ p, n: nn, u, a, k: kf, d, l: length * kf * stretch * (0.95 + 0.1 * random()), spiral: true });
  }
  return out;
}
// The tail's plume: rings of long, narrow feathers rooted round the tail's rounded tip, pointing on past it and fanned
// out a little more the further back they are rooted, so the outer rings sheathe the inner ones.
function tailPlume(line, r, { random, length, spacing, stretch, tailLen, scaleAt }) {
  const L = line.length;
  const out = [];
  const kTip = scaleAt(1);
  const lt = length * kTip;
  const rings = 4;
  const golden = Math.PI * (3 - Math.sqrt(5));
  let k = 0;
  for (let ring = 0; ring < rings; ring++) {
    // From right at the tip (closing it) back over the rounded end.
    const back = tailLen * (0.02 + (1.0 * ring) / rings);
    const u = 1 - back / L;
    const [v] = profile(line, r, u);
    const around = Math.max(5, Math.round((2 * Math.PI * r * v) / (spacing * 1.6 * lt)));
    for (let j = 0; j < around; j++, k++) {
      const a = k * golden + random() * 0.3;
      const p = new Vector3(), nn = new Vector3();
      surfacePoint(line, r, u, a, p, nn);
      frameAt(line, u, _P, _T, _N, _B);
      const e = _N.clone().multiplyScalar(Math.cos(a)).addScaledVector(_B, Math.sin(a));
      const d = _T.clone().addScaledVector(e, 0.03 + 0.05 * ring).normalize();
      const n = e.clone().addScaledVector(d, -e.dot(d)).normalize();
      out.push({ p, n, u, a, k: kTip, d, l: lt * stretch * (2.6 - 0.3 * ring) * (0.9 + 0.2 * random()), spiral: true, plume: true, width: 0.5 });
    }
  }
  return out;
}
const smooth01 = (x) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};
// Roots a Poisson disc keeps, per square of its spacing.
const DENSITY = 1.81;

// Feathers over the tube. length: feather length; spacing: closest roots as a fraction of it.
// stretch: drawn length over the length the roots are spaced for.
function spreadFeathers(line, r, { random, length, spacing = 0.22, sweep = 0.12, stretch = 1 }) {
  // Candidates per cell of a fine grid, by its area.
  const along = Math.ceil(line.length / (0.3 * spacing * length));
  const around = Math.max(12, Math.ceil((TAU * r) / (0.3 * spacing * length)));
  const candidates = [];
  const sp = spacing * length;
  // Feathers (and their spacing) shrink with a tapering tube.
  const scaleAt = (u) => (line.closed ? 1 : Math.max(0.3, 1 - (line.taper ?? 0) * Math.min(Math.max(u, 0), 1)));
  for (let i = 0; i < along; i++) for (let j = 0; j < around; j++) {
    const u0 = i / along, a0 = (j / around) * TAU;
    surfacePoint(line, r, u0, a0, _p, _n);
    surfacePoint(line, r, u0 + 1 / along, a0, _q, _n);
    surfacePoint(line, r, u0, a0 + TAU / around, _c, _n);
    const area = _e.subVectors(_q, _p).cross(_best.subVectors(_c, _p)).length();
    const k0 = scaleAt(u0);
    const expected = (4 * area) / (sp * sp * k0 * k0);
    for (let k = Math.floor(expected) + (random() < expected % 1 ? 1 : 0); k > 0; k--) {
      const u = u0 + random() / along, a = a0 + (random() * TAU) / around;
      const p = new Vector3(), nn = new Vector3();
      surfacePoint(line, r, u, a, p, nn);
      candidates.push({ p, n: nn, u, a, k: scaleAt(u) });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  // Poisson disc over a hash grid (wrapping round a closed straightened line, so its seam doesn't show).
  const wrap = line.straight && line.closed;
  const CX = wrap ? Math.max(3, Math.floor(line.length / sp)) : 0;
  const cellX = wrap ? line.length / CX : sp;
  const cell = sp;
  const gxOf = (x) => {
    const g = Math.floor(x / cellX);
    return wrap ? ((g % CX) + CX) % CX : g;
  };
  const gxAdd = (g, d) => (wrap ? (((g + d) % CX) + CX) % CX : g + d);
  const dist2 = (a, b) => {
    let dx = a.x - b.x;
    if (wrap) dx -= line.length * Math.round(dx / line.length);
    return dx * dx + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  };
  const key = (x, y, z) => (gxOf(x) + 512) * 1048576 + (Math.floor(y / cell) + 512) * 1024 + (Math.floor(z / cell) + 512);
  const grid = new Map();
  const kept = [];
  // An open line's head is finished with a spiral of feathers (golden angle), tiny at the tip and growing into the
  // regular ones, each pointing away from the tip; the rest are spaced around them.
  const head = line.closed ? 0 : 1.6 * r;
  if (head > 0) {
    for (const f of headSpiral(line, r, { random, length, spacing, stretch, head, scaleAt })) {
      kept.push(f);
      const k = key(f.p.x, f.p.y, f.p.z);
      if (grid.has(k)) grid.get(k).push(f);
      else grid.set(k, [f]);
    }
  }
  // And its tail ends in a light plume: long, narrow feathers carrying on past the tip, fanning out a little.
  const tailLen = line.closed ? 0 : 1.4 * r * Math.max(0.1, 1 - (line.taper ?? 0));
  if (tailLen > 0) kept.push(...tailPlume(line, r, { random, length, spacing, stretch, tailLen, scaleAt }));
  for (const f of candidates) {
    if (f.u * line.length < 0.8 * head || (1 - f.u) * line.length < 0.9 * tailLen) continue;
    const gx = gxOf(f.p.x), gy = Math.floor(f.p.y / cell), gz = Math.floor(f.p.z / cell);
    let ok = true;
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
      for (const g of grid.get((gxAdd(gx, dx) + 512) * 1048576 + (gy + dy + 512) * 1024 + (gz + dz + 512)) ?? []) {
        if (dist2(g.p, f.p) < (sp * Math.min(f.k, g.k)) ** 2) { ok = false; break; }
      }
    }
    if (!ok) continue;
    kept.push(f);
    const k = key(f.p.x, f.p.y, f.p.z);
    if (grid.has(k)) grid.get(k).push(f);
    else grid.set(k, [f]);
  }
  // Direction along the tube, with a little sweep of its own; then levels, different for neighbours side by side, that
  // stagger their roots so overlapping vanes never meet at the same height.
  const side = new Vector3(), rel = new Vector3();
  for (const f of kept) {
    if (f.spiral) continue;
    frameAt(line, f.u, _P, _T, _N, _B);
    const s = (random() - 0.5) * 2 * sweep;
    side.crossVectors(f.n, _T);
    f.d = _T.clone().multiplyScalar(Math.cos(s)).addScaledVector(side, Math.sin(s)).normalize();
    if (!f.spiral) f.l = length * f.k * stretch * (0.92 + 0.16 * random());
  }
  const cell2 = 0.6 * length;
  const CX2 = wrap ? Math.max(3, Math.floor(line.length / cell2)) : 0;
  const cellX2 = wrap ? line.length / CX2 : cell2;
  const gx2 = (x) => {
    const g = Math.floor(x / cellX2);
    return wrap ? ((g % CX2) + CX2) % CX2 : g;
  };
  const gx2Add = (g, d) => (wrap ? (((g + d) % CX2) + CX2) % CX2 : g + d);
  const key2 = (x, y, z) => (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
  const grid2 = new Map();
  for (const f of kept) {
    const k = key2(gx2(f.p.x), Math.floor(f.p.y / cell2), Math.floor(f.p.z / cell2));
    if (grid2.has(k)) grid2.get(k).push(f);
    else grid2.set(k, [f]);
  }
  for (const f of kept) {
    if (f.spiral) {
      f.level = 0;
      continue;
    }
    side.crossVectors(f.n, f.d);
    const taken = new Set();
    const gx = gx2(f.p.x), gy = Math.floor(f.p.y / cell2), gz = Math.floor(f.p.z / cell2);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const g of grid2.get(key2(gx2Add(gx, dx), gy + dy, gz + dz)) ?? []) {
        if (g === f || g.level === undefined) continue;
        rel.subVectors(g.p, f.p);
        if (wrap) rel.x -= line.length * Math.round(rel.x / line.length);
        if (Math.abs(rel.dot(f.d)) < 0.35 * f.l && Math.abs(rel.dot(side)) < 0.45 * f.l) taken.add(g.level);
      }
    }
    const free = [0, 1, 2, 3, 4].filter((v) => !taken.has(v));
    f.level = free.length ? free[Math.floor(random() * free.length)] : Math.floor(random() * 5);
  }
  // Stagger, then the skin's height under each feather at a quarter, half, three quarters and all of its length.
  for (const f of kept) {
    if (f.plume) {
      f.hs = [0, 0, 0, 0];
      continue;
    }
    f.p.addScaledVector(f.d, f.level * 0.045 * f.l);
    f.u += (f.level * 0.045 * f.l) / line.length;
    projectToSurface(line, r, f.p, f.u, f.p);
    f.n.copy(surfaceNormalNear(line, r, f.p, f.u));
    f.d.addScaledVector(f.n, -f.d.dot(f.n)).normalize();
    f.hs = [];
    // The plume carries on past the tip: nothing under it to follow.
    if (f.plume) {
      f.hs = [0, 0, 0, 0];
      continue;
    }
    for (let i = 1; i <= 4; i++) {
      _q.copy(f.p).addScaledVector(f.d, (f.l * i) / 4);
      projectToSurface(line, r, _q, f.u, _q);
      f.hs.push(_q.sub(f.p).dot(f.n));
    }
  }
  return kept;
}

const _P = new Vector3(), _T = new Vector3(), _N = new Vector3(), _B = new Vector3();
const _p = new Vector3(), _n = new Vector3(), _q = new Vector3(), _c = new Vector3(), _e = new Vector3(), _best = new Vector3();
const _src = new Vector3();

export { KNOT_CURVES, knotLine, centreLine, frameAt, straightLine, clearance, tubeArea, tubeGeometry, spreadFeathers };
