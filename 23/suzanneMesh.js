// Suzanne's own mesh and atlas (suzanne-mesh.bin, from tools/suzanne-mesh.mjs): parsing, the bake's atlas-space
// geometry, and the adaptively refined mesh. Worker-safe: plain typed arrays, no three.js.

// Same layout as tools/suzanne-mesh.mjs writes
function parseSuzanne(buffer) {
  let o = 0;
  const take = (Type, n) => {
    const a = new Type(buffer, o, n);
    o += Math.ceil((n * Type.BYTES_PER_ELEMENT) / 4) * 4;
    return a;
  };
  const [magic, nPos, nVert, nTri, nChart] = take(Uint32Array, 5);
  if (magic !== 0x315a5553) throw new Error("suzanne-mesh.bin: bad magic");
  const head = take(Float32Array, 8);
  const pq = take(Uint16Array, nPos * 3), nq = take(Int16Array, nPos * 3);
  const vertPos = take(Uint16Array, nVert), vertChart = take(Uint16Array, nVert), uq = take(Uint16Array, nVert * 2);
  const chartAxes = take(Float32Array, nChart * 6);
  const tris = take(Uint16Array, nTri * 3);
  const positions = new Float32Array(nPos * 3), normals = new Float32Array(nPos * 3);
  for (let i = 0; i < nPos * 3; i++) {
    positions[i] = head[i % 3] + (pq[i] / 65535) * head[3 + (i % 3)];
    normals[i] = nq[i] / 32767;
  }
  for (let i = 0; i < nPos; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    for (let a = 0; a < 3; a++) normals[i * 3 + a] /= l;
  }
  const uvs = Float32Array.from(uq, (v) => v / 65535);
  const mesh = { nPos, nVert, nTri, positions, normals, vertPos, vertChart, uvs, chartAxes, tris, scale: head[6], skirt: head[7] };
  prepare(mesh);
  return mesh;
}

// Per vertex: tangent and distance to the chart border (atlas units, 1 = a face); per triangle: welded neighbours
function prepare(mesh) {
  const { nVert, nTri, tris, uvs, vertPos, vertChart, chartAxes, normals } = mesh;
  mesh.tangents = new Float32Array(nVert * 4);
  for (let v = 0; v < nVert; v++) tangentAt(mesh, vertChart[v], normals, vertPos[v] * 3, mesh.tangents, v * 4);

  // Border edges: used by one triangle among the split vertices
  const edgeUse = new Map();
  const ekey = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  for (let t = 0; t < nTri * 3; t += 3) for (let e = 0; e < 3; e++) {
    const k = ekey(tris[t + e], tris[t + ((e + 1) % 3)]);
    edgeUse.set(k, (edgeUse.get(k) || 0) + 1);
  }
  const dist = new Float64Array(nVert).fill(Infinity);
  const nbs = Array.from({ length: nVert }, () => []);
  for (const [k, n] of edgeUse) {
    const a = Math.floor(k / 65536), b = k % 65536;
    nbs[a].push(b);
    nbs[b].push(a);
    if (n === 1) dist[a] = dist[b] = 0;
  }
  // Dijkstra from the borders over atlas-space edge lengths (atlas units: the atlas is 3 x 2)
  const heap = [];
  const push = (d, v) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
        if (heap[i][0] <= heap[c][0]) break;
        [heap[c], heap[i]] = [heap[i], heap[c]];
        i = c;
      }
    }
    return top;
  };
  for (let v = 0; v < nVert; v++) if (dist[v] === 0) push(0, v);
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    for (const w of nbs[v]) {
      const nd = d + Math.hypot((uvs[w * 2] - uvs[v * 2]) * 3, (uvs[w * 2 + 1] - uvs[v * 2 + 1]) * 2);
      if (nd < dist[w]) {
        dist[w] = nd;
        push(nd, w);
      }
    }
  }
  mesh.borderDist = dist;

  // Triangle neighbours across welded edges (-1 on the open rims round the eyes)
  const owner = new Map();
  mesh.adj = new Int32Array(nTri * 3).fill(-1);
  for (let t = 0; t < nTri; t++) for (let e = 0; e < 3; e++) {
    const k = ekey(vertPos[tris[t * 3 + e]], vertPos[tris[t * 3 + ((e + 1) % 3)]]);
    const other = owner.get(k);
    if (other === undefined) owner.set(k, t * 3 + e);
    else {
      mesh.adj[t * 3 + e] = Math.floor(other / 3);
      mesh.adj[other] = t;
    }
  }
  // Copies of a point on a seam displace by the uv of one of them, so they move alike and the seam stays closed:
  // a welded position's first copy, a welded edge's first triangle
  mesh.edgeOwner = owner;
  mesh.canonVert = new Int32Array(mesh.nPos).fill(-1);
  for (let v = 0; v < nVert; v++) if (mesh.canonVert[vertPos[v]] < 0) mesh.canonVert[vertPos[v]] = v;
}

// The chart's atlas-u axis made tangent to normal n; charts are right-handed, so w is always 1
function tangentAt(mesh, chart, n, i, out, o) {
  const ax = mesh.chartAxes, c = chart * 6;
  const nx = n[i], ny = n[i + 1], nz = n[i + 2];
  const d = ax[c] * nx + ax[c + 1] * ny + ax[c + 2] * nz;
  let tx = ax[c] - nx * d, ty = ax[c + 1] - ny * d, tz = ax[c + 2] - nz * d;
  const l = Math.hypot(tx, ty, tz) || 1;
  tx /= l; ty /= l; tz /= l;
  out[o] = tx;
  out[o + 1] = ty;
  out[o + 2] = tz;
  out[o + 3] = 1;
}

// Geometry the baker rasterises in atlas space: every chart plus a skirt that carries it on, flat along the chart's
// plane, into the gutter (drawn first, so the charts overwrite where skirts overlap them)
function suzanneBakeArrays(mesh) {
  const { nVert, nTri, tris, uvs, vertPos, vertChart, positions, normals, chartAxes, scale, skirt } = mesh;
  const pos = [], nrm = [], tan = [], uv = [];
  const add = (v, du, dv) => {
    const p = vertPos[v] * 3, c = vertChart[v] * 6;
    // du, dv in atlas units; the chart's world axes along atlas u and v map them back to the surface
    for (let a = 0; a < 3; a++) pos.push(positions[p + a] + (chartAxes[c + a] * du + chartAxes[c + 3 + a] * dv) / scale);
    nrm.push(normals[p], normals[p + 1], normals[p + 2]);
    for (let k = 0; k < 4; k++) tan.push(mesh.tangents[v * 4 + k]);
    uv.push(uvs[v * 2] + du / 3, uvs[v * 2 + 1] + dv / 2);
    return pos.length / 3 - 1;
  };
  for (let v = 0; v < nVert; v++) add(v, 0, 0);

  const ekey = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  const uses = new Map();
  for (let t = 0; t < nTri * 3; t += 3) for (let e = 0; e < 3; e++) {
    const k = ekey(tris[t + e], tris[t + ((e + 1) % 3)]);
    uses.set(k, (uses.get(k) || 0) + 1);
  }
  const outward = new Map();
  const skirtIndex = [];
  for (let t = 0; t < nTri * 3; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (uses.get(ekey(a, b)) !== 1) continue;
    // Charts wind counter-clockwise in the atlas: outward is to the right of a -> b
    let dx = (uvs[b * 2 + 1] - uvs[a * 2 + 1]) * 2, dy = -(uvs[b * 2] - uvs[a * 2]) * 3;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const a2 = add(a, dx * skirt, dy * skirt), b2 = add(b, dx * skirt, dy * skirt);
    skirtIndex.push(a, a2, b2, a, b2, b);
    for (const v of [a, b]) {
      if (!outward.has(v)) outward.set(v, []);
      outward.get(v).push([dx, dy]);
    }
  }
  // Round the convex corners: a fan between each pair of a vertex's outward directions
  for (const [v, dirs] of outward) {
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      const a0 = Math.atan2(dirs[i][1], dirs[i][0]);
      let da = Math.atan2(dirs[j][1], dirs[j][0]) - a0;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(da) / 0.5));
      let prev = add(v, dirs[i][0] * skirt, dirs[i][1] * skirt);
      for (let s = 1; s <= steps; s++) {
        const an = a0 + (da * s) / steps;
        const next = add(v, Math.cos(an) * skirt, Math.sin(an) * skirt);
        if (da > 0) skirtIndex.push(v, prev, next);
        else skirtIndex.push(v, next, prev);
        prev = next;
      }
    }
  }
  const index = skirtIndex;
  for (let i = 0; i < nTri * 3; i++) index.push(tris[i]);
  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nrm),
    tangent: new Float32Array(tan),
    uv: new Float32Array(uv),
    index: pos.length / 3 > 65535 ? new Uint32Array(index) : new Uint16Array(index),
  };
}

const MAX_LEVEL = 4;
const PHONG = 0.75;

// Refines each base triangle to the lowest level within tol of the displaced surface, balanced across neighbours
function buildSuzanneMesh(mesh, { radius, heightAt, texelsU, texelsV, levels, tol, maxTriangles, dispAmp, faceTexels }) {
  const { nTri, tris, uvs, vertPos, positions: P, normals: Nn, adj } = mesh;
  const minCell = faceTexels / (1 << levels);
  const edgeTex = new Float32Array(nTri);
  const cap = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    let sum = 0;
    for (let e = 0; e < 3; e++) {
      const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
      sum += Math.hypot((uvs[b * 2] - uvs[a * 2]) * texelsU, (uvs[b * 2 + 1] - uvs[a * 2 + 1]) * texelsV);
    }
    edgeTex[t] = sum / 3;
    cap[t] = Math.max(0, Math.min(MAX_LEVEL, Math.ceil(Math.log2(edgeTex[t] / (1.2 * minCell)))));
  }

  // Error of triangle t at level L: the most a sub-triangle's flat interpolation misses the baked height by
  const errCache = new Float32Array(nTri * (MAX_LEVEL + 1)).fill(-1);
  const errorAt = (t, L) => {
    const c = errCache[t * (MAX_LEVEL + 1) + L];
    if (c >= 0) return c;
    const a = tris[t * 3], b = tris[t * 3 + 1], cc = tris[t * 3 + 2];
    const n = 1 << L;
    const k = Math.max(2, Math.min(6, Math.round(edgeTex[t] / n / 6)));
    const m = n * k;
    // Heights on the fine grid, compared with the sub-triangle's corners' blend
    const H = new Float32Array((m + 1) * (m + 2) / 2);
    const id = (i, j) => (j * (2 * m + 3 - j)) / 2 + i;
    for (let j = 0; j <= m; j++) for (let i = 0; i + j <= m; i++) {
      const wb = i / m, wc = j / m, wa = 1 - wb - wc;
      H[id(i, j)] = heightAt(uvs[a * 2] * wa + uvs[b * 2] * wb + uvs[cc * 2] * wc, uvs[a * 2 + 1] * wa + uvs[b * 2 + 1] * wb + uvs[cc * 2 + 1] * wc);
    }
    let dev = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i + j < n; i++) {
      for (let up = 0; up < 2; up++) {
        if (up && i + j + 1 >= n) continue;
        // Corners of the sub-triangle on the fine grid
        const c0 = up ? [i + 1, j] : [i, j], c1 = up ? [i + 1, j + 1] : [i + 1, j], c2 = [i, j + 1];
        const h0 = H[id(c0[0] * k, c0[1] * k)], h1 = H[id(c1[0] * k, c1[1] * k)], h2 = H[id(c2[0] * k, c2[1] * k)];
        for (let s = 0; s <= k; s++) for (let r = 0; r + s <= k; r++) {
          const w1 = r / k, w2 = s / k, w0 = 1 - w1 - w2;
          const fi = Math.round((c0[0] * w0 + c1[0] * w1 + c2[0] * w2) * k), fj = Math.round((c0[1] * w0 + c1[1] * w1 + c2[1] * w2) * k);
          dev = Math.max(dev, Math.abs(H[id(fi, fj)] - (h0 * w0 + h1 * w1 + h2 * w2)));
        }
      }
    }
    return (errCache[t * (MAX_LEVEL + 1) + L] = dev * dispAmp);
  };

  const level = new Uint8Array(nTri);
  let count = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (let t = 0; t < nTri; t++) {
      let L = 0;
      while (L < cap[t] && errorAt(t, L) > tol) L++;
      level[t] = L;
    }
    balance(level, adj, nTri);
    count = 0;
    for (let t = 0; t < nTri; t++) {
      count += 1 << (2 * level[t]);
      for (let e = 0; e < 3; e++) if (adj[t * 3 + e] >= 0 && level[adj[t * 3 + e]] > level[t]) count += 1 << level[t];
    }
    if (count <= maxTriangles) break;
    tol *= 1.5;
    for (let t = 0; t < nTri; t++) cap[t] = Math.max(0, cap[t] - (attempt % 2));
  }

  // Vertices: corners and edge points shared by key, interior points per triangle
  const out = { positions: [], normals: [], uvs: [], dispUvs: [], tangents: [], tileBounds: [], indices: [], cellTexels: [] };
  const D = 1 << (MAX_LEVEL + 1);
  const shared = new Map();
  const tmp = new Float32Array(4);
  const vertex = (t, wa, wb, wc, texels, dispUv) => {
    const sv = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    const w = [wa, wb, wc];
    // Canonical order by welded position, so seam copies of a point come out bit-identical
    const order = [0, 1, 2].filter((i) => w[i] > 0).sort((x, y) => vertPos[sv[x]] - vertPos[sv[y]]);
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, u = 0, v = 0, bd = 0;
    for (const i of order) {
      const p = vertPos[sv[i]] * 3;
      px += P[p] * w[i]; py += P[p + 1] * w[i]; pz += P[p + 2] * w[i];
      nx += Nn[p] * w[i]; ny += Nn[p + 1] * w[i]; nz += Nn[p + 2] * w[i];
    }
    // Phong tessellation: the flat point pulled toward each corner's tangent plane
    let qx = 0, qy = 0, qz = 0;
    for (const i of order) {
      const p = vertPos[sv[i]] * 3;
      const d = (px - P[p]) * Nn[p] + (py - P[p + 1]) * Nn[p + 1] + (pz - P[p + 2]) * Nn[p + 2];
      qx += (px - Nn[p] * d) * w[i]; qy += (py - Nn[p + 1] * d) * w[i]; qz += (pz - Nn[p + 2] * d) * w[i];
    }
    px += (qx - px) * PHONG; py += (qy - py) * PHONG; pz += (qz - pz) * PHONG;
    for (let i = 0; i < 3; i++) {
      u += uvs[sv[i] * 2] * w[i];
      v += uvs[sv[i] * 2 + 1] * w[i];
      bd += mesh.borderDist[sv[i]] * w[i];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    out.positions.push(px * radius, py * radius, pz * radius);
    out.normals.push(nx / nl, ny / nl, nz / nl);
    out.uvs.push(u, v);
    if (dispUv) out.dispUvs.push(dispUv[0], dispUv[1]);
    else out.dispUvs.push(u, v);
    tangentAt(mesh, mesh.vertChart[sv[0]], [nx / nl, ny / nl, nz / nl], 0, tmp, 0);
    out.tangents.push(tmp[0], tmp[1], tmp[2], tmp[3]);
    out.tileBounds.push(0, 0, 1, 1);
    // Mip footprint kept inside the chart and its skirt; small at the border so seam copies displace alike
    out.cellTexels.push(Math.min(texels, 4 + (bd * texelsV) / 2));
    return out.positions.length / 3 - 1;
  };
  const sharedVertex = (key, t, wa, wb, wc, texels, dispUv) => {
    let id = shared.get(key);
    if (id === undefined) shared.set(key, (id = vertex(t, wa, wb, wc, texels, dispUv)));
    else out.cellTexels[id] = Math.min(out.cellTexels[id], texels);
    return id;
  };

  // Displacement uv of the point at f along split edge x -> y: on the edge's first triangle, from its lower welded end
  const edgeDispUv = (x, y, f) => {
    if (vertPos[x] > vertPos[y]) [x, y, f] = [y, x, 1 - f];
    const o = mesh.edgeOwner.get(vertPos[x] * 65536 + vertPos[y]);
    const t3 = o - (o % 3);
    let a = tris[o], b = tris[t3 + (((o % 3) + 1) % 3)];
    if (vertPos[a] !== vertPos[x]) [a, b] = [b, a];
    return [uvs[a * 2] + (uvs[b * 2] - uvs[a * 2]) * f, uvs[a * 2 + 1] + (uvs[b * 2 + 1] - uvs[a * 2 + 1]) * f];
  };

  for (let t = 0; t < nTri; t++) {
    const L = level[t], n = 1 << L;
    const texels = edgeTex[t] / n;
    const sv = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    // Edge e runs from corner e to corner e + 1; finer when the neighbour across it is
    const fine = [0, 1, 2].map((e) => adj[t * 3 + e] >= 0 && level[adj[t * 3 + e]] > L);
    // Point at grid (i, j) or an edge midpoint (doubled coordinates I, J on a 2n grid)
    const point = (I, J, m) => {
      const wb = I / m, wc = J / m, wa = 1 - wb - wc;
      const onAB = J === 0, onCA = I === 0, onBC = I + J === m;
      if ((onAB && onCA) || (onAB && onBC) || (onCA && onBC)) {
        const corner = onAB && onCA ? 0 : onAB ? 1 : 2;
        const c = mesh.canonVert[vertPos[sv[corner]]];
        return sharedVertex(-1 - sv[corner], t, corner === 0 ? 1 : 0, corner === 1 ? 1 : 0, corner === 2 ? 1 : 0, texels, [uvs[c * 2], uvs[c * 2 + 1]]);
      }
      if (onAB || onCA || onBC) {
        const [x, y, f] = onAB ? [sv[0], sv[1], wb] : onBC ? [sv[1], sv[2], wc] : [sv[2], sv[0], wa];
        const lo = Math.min(x, y), hi = Math.max(x, y);
        const num = Math.round((x === lo ? f : 1 - f) * D);
        return sharedVertex((lo * 65536 + hi) * (D + 1) + num, t, wa, wb, wc, texels, edgeDispUv(x, y, f));
      }
      return vertex(t, wa, wb, wc, texels);
    };
    const grid = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const at = (i, j) => {
      const k = j * (n + 1) + i;
      if (grid[k] < 0) grid[k] = point(i, j, n);
      return grid[k];
    };
    for (let j = 0; j < n; j++) for (let i = 0; i + j < n; i++) {
      // Up triangle (i, j), (i + 1, j), (i, j + 1): its sides may lie on edges AB (j = 0), CA (i = 0), BC (i + j + 1 = n)
      const ring = [{ v: at(i, j) }];
      if (j === 0 && fine[0]) ring.push({ v: point(2 * i + 1, 0, 2 * n), mid: true });
      ring.push({ v: at(i + 1, j) });
      if (i + j + 1 === n && fine[1]) ring.push({ v: point(2 * i + 1, 2 * j + 1, 2 * n), mid: true });
      ring.push({ v: at(i, j + 1) });
      if (i === 0 && fine[2]) ring.push({ v: point(0, 2 * j + 1, 2 * n), mid: true });
      emitRing(ring, out.indices);
      if (i + j + 1 < n) out.indices.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return out;
}

// Triangulates a triangle whose sides carry 0-3 midpoints ({ v, mid } in winding order): cuts each corner between two
// midpoints, then fans the rest from a midpoint
function emitRing(ring, indices) {
  const r = ring.slice();
  for (let k = 0; k < r.length && r.length > 3; ) {
    const prev = r[(k + r.length - 1) % r.length], next = r[(k + 1) % r.length];
    if (!r[k].mid && prev.mid && next.mid) {
      indices.push(prev.v, r[k].v, next.v);
      r.splice(k, 1);
    } else k++;
  }
  const m = Math.max(0, r.findIndex((e) => e.mid));
  for (let k = 1; k + 1 < r.length; k++) indices.push(r[m].v, r[(m + k) % r.length].v, r[(m + k + 1) % r.length].v);
}

// Raises levels until no two neighbours differ by more than one
function balance(level, adj, nTri) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let t = 0; t < nTri; t++) for (let e = 0; e < 3; e++) {
      const nb = adj[t * 3 + e];
      if (nb >= 0 && level[nb] > level[t] + 1) {
        level[t] = level[nb] - 1;
        changed = true;
      }
    }
  }
}

export { parseSuzanne, suzanneBakeArrays, buildSuzanneMesh };
