// Rest shells of unit size, from a subdivided icosahedron: vertices, triangles and edges, scaled so the enclosed
// volume is that of a unit ball. No dependencies, so it also runs in the physics worker.
const cache = new Map();

const T = (1 + Math.sqrt(5)) / 2;
const ICO_V = [-1, T, 0, 1, T, 0, -1, -T, 0, 1, -T, 0, 0, -1, T, 0, 1, T, 0, -1, -T, 0, 1, -T, T, 0, -1, T, 0, 1, -T, 0, -1, -T, 0, 1];
const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];

// An icosphere with each face split into (detail + 1)^2 triangles, shared vertices merged.
function icosphere(detail) {
  const cols = detail + 1;
  const pos = [];
  const index = [];
  const ids = new Map();
  const vertex = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      ids.set(key, id);
      pos.push(x, y, z);
    }
    return id;
  };
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  for (let f = 0; f < ICO_F.length; f += 3) {
    const a = ICO_V.slice(ICO_F[f] * 3, ICO_F[f] * 3 + 3), b = ICO_V.slice(ICO_F[f + 1] * 3, ICO_F[f + 1] * 3 + 3), c = ICO_V.slice(ICO_F[f + 2] * 3, ICO_F[f + 2] * 3 + 3);
    const v = [];
    for (let i = 0; i <= cols; i++) {
      const aj = lerp(a, c, i / cols), bj = lerp(b, c, i / cols);
      const rows = cols - i;
      v.push([]);
      for (let j = 0; j <= rows; j++) v[i].push(vertex(...(j === 0 && i === cols ? aj : lerp(aj, bj, j / rows))));
    }
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < 2 * (cols - i) - 1; j++) {
        const k = Math.floor(j / 2);
        if (j % 2 === 0) index.push(v[i][k + 1], v[i + 1][k], v[i][k]);
        else index.push(v[i][k + 1], v[i + 1][k + 1], v[i + 1][k]);
      }
  }
  return { pos: Float32Array.from(pos), index: Uint32Array.from(index) };
}

function shell(kind, detail) {
  const key = `${kind}:${detail}`;
  if (cache.has(key)) return cache.get(key);
  const g = icosphere(detail);
  const pos = g.pos;
  const n = pos.length / 3;
  const rest = new Float32Array(n * 3);
  const h = kind === "pill" ? 0.75 : 0;
  for (let i = 0; i < n; i++) {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    if (kind === "cushion") {
      // A superellipsoid: a cube with soft, round edges.
      const e = 5;
      const t = Math.pow(Math.abs(x) ** e + Math.abs(y) ** e + Math.abs(z) ** e, -1 / e);
      x *= t;
      y *= t;
      z *= t;
    } else if (kind === "pill") {
      y += h * Math.max(-1, Math.min(1, y / 0.3));
    } else if (kind === "gumdrop") {
      // Five soft lobes around the middle, fading out toward the poles, and a slightly flattened base.
      const lobes = 1 + 0.16 * Math.cos(5 * Math.atan2(z, x)) * (1 - y * y);
      x *= lobes;
      z *= lobes;
      if (y < 0) y *= 0.8;
    }
    rest[i * 3] = x;
    rest[i * 3 + 1] = y;
    rest[i * 3 + 2] = z;
  }
  const index = g.index;
  // Outward winding, whatever the subdivision produced.
  if (meshVolume(pos, index) < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  const edgeSet = new Set();
  const edges = [];
  for (let t = 0; t < index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = index[t + k], b = index[t + ((k + 1) % 3)];
      const id = a < b ? a * n + b : b * n + a;
      if (!edgeSet.has(id)) {
        edgeSet.add(id);
        edges.push(Math.min(a, b), Math.max(a, b));
      }
    }
  const volume = meshVolume(rest, index);
  const s = Math.cbrt(((4 / 3) * Math.PI) / volume);
  for (let i = 0; i < rest.length; i++) rest[i] *= s;
  const edgeArr = Uint32Array.from(edges);
  const restLen = new Float32Array(edgeArr.length / 2);
  let mean = 0;
  for (let e = 0; e < restLen.length; e++) {
    const a = edgeArr[e * 2] * 3, b = edgeArr[e * 2 + 1] * 3;
    restLen[e] = Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]);
    mean += restLen[e];
  }
  // Rest curvature: each vertex's offset from the mean of its neighbours, for the bending constraint.
  const valence = new Uint16Array(n);
  const lap = new Float32Array(n * 3);
  for (let e = 0; e < edgeArr.length; e += 2) {
    const i = edgeArr[e], j = edgeArr[e + 1];
    valence[i]++;
    valence[j]++;
    for (let k = 0; k < 3; k++) {
      lap[i * 3 + k] += rest[j * 3 + k];
      lap[j * 3 + k] += rest[i * 3 + k];
    }
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) lap[i * 3 + k] = rest[i * 3 + k] - lap[i * 3 + k] / valence[i];
  const result = {
    detail,
    valence,
    lap,
    kind,
    count: n,
    rest,
    index,
    edges: edgeArr,
    restLen,
    edgeMean: mean / restLen.length,
    volume: (4 / 3) * Math.PI,
    // The rest shape's half-length along y beyond its radius, for keeping floaters inside.
    pillH: h * s,
    pillR: s,
    cushion: kind === "cushion" ? s : 0,
    gumdrop: kind === "gumdrop" ? s : 0,
  };
  cache.set(key, result);
  return result;
}

function meshVolume(p, index) {
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// Signed distance (unit-scale rest frame) to the rest shape, approximate for the cushion.
function restSDF(s, x, y, z) {
  // The gumdrop's lobes and base sit outside the ball of its narrowest radius: a safe inside for the floaters.
  if (s.kind === "gumdrop") return Math.hypot(x, y, z) - 0.8 * s.gumdrop;
  if (s.kind === "pill") {
    const yy = y - Math.max(-s.pillH, Math.min(s.pillH, y));
    return Math.hypot(x, yy, z) - s.pillR;
  }
  if (s.kind === "cushion") {
    const e = 5;
    const r = Math.pow(Math.abs(x) ** e + Math.abs(y) ** e + Math.abs(z) ** e, 1 / e);
    return (r - s.cushion) * 0.85;
  }
  return Math.hypot(x, y, z) - 1;
}

export { shell, restSDF };
