import { clearance } from "./clearance.js";
import { fetchWithProgress } from "common";
import {
  BufferGeometry,
  BufferAttribute,
  Data3DTexture,
  RedFormat,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  Sphere,
  Vector3,
} from "three";
import { decodeAsset, decodeLod, fromHalf } from "./tools/format.mjs";
import { suzanneGeometry } from "./suzanneMesh.js";
import { densify as densifyGeometry } from "./densify.js";

// GUI name -> asset key, display scale (Suzanne's ears set its bounding radius, so the head reads small).
export const SHAPES = {
  Suzanne: { key: "suzanne", scale: 1.22 },
  Heart: { key: "heart", scale: 1 },
  Blob: { key: "blob", scale: 1 },
  Sphube: { key: "sphube", scale: 1 },
  Torus: { key: "torus", scale: 1 },
  Knot: { key: "knot", scale: 1 },
  Star: { key: "star", scale: 1 },
  Icosahedron: { key: "icosahedron", scale: 1 },
  Dodecahedron: { key: "dodecahedron", scale: 1 },
};

const base = new URL("./assets/", import.meta.url);
const cache = new Map();

// Resolves to { name, key, radius, center, geometry (render mesh, densified on request), walk (undensified mesh the
// sim walks on), level (Loop subdivision level, Suzanne only), sdf: { texture, min, size, step, res, sample, grad,
// raycast }, topology() (of walk) }.
// onProgress(fraction) follows the download.
export function loadShape(name, { lite = false, densify = false, onProgress } = {}) {
  const id = `${name}|${lite}|${densify}`;
  if (!cache.has(id)) {
    const promise = build(name, lite, densify, onProgress);
    cache.set(id, promise);
    promise.catch(() => cache.delete(id));
  }
  return cache.get(id);
}

// Downloads are kept, so prefetchShapes() can fetch every shape ahead of its first use.
const files = new Map();
function download(url, onProgress) {
  const key = String(url);
  if (!files.has(key)) {
    const promise = fetchWithProgress(url, onProgress).then((res) => {
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return res.arrayBuffer();
    });
    files.set(key, promise);
    promise.catch(() => files.delete(key));
  }
  return files.get(key);
}

async function get(url, type, onProgress) {
  const buffer = await download(url, onProgress);
  return type === "text" ? new TextDecoder().decode(buffer) : buffer;
}

export function prefetchShapes() {
  for (const { key } of Object.values(SHAPES)) download(new URL(`${key}.bin`, base)).catch(() => {});
  download(new URL("suzanne.obj", base)).catch(() => {});
}

async function build(name, lite, densify, onProgress) {
  const { key } = SHAPES[name];
  // Suzanne's cage comes from its .obj, fetched alongside the .bin.
  const objUrl = key === "suzanne" ? new URL("suzanne.obj", base).href : null;
  const objFetch = objUrl && get(objUrl, "text");
  objFetch?.catch(() => {});
  const buffer = await get(new URL(`${key}.bin`, base), "arrayBuffer", onProgress);
  const { header, arrays } = decodeAsset(buffer);

  let geometry;
  let level = null;
  if (header.mesh) {
    // Suzanne: the cage is Loop-subdivided at load time; AO is baked per level in the same vertex order.
    const url = new URL(header.mesh.source.replace(/^assets\//, ""), base).href;
    const objText = await (url === objUrl ? objFetch : get(url, "text"));
    const levels = header.mesh.subdivide;
    const entry = lite ? levels.reduce((a, b) => (b.level < a.level ? b : a)) : levels.reduce((a, b) => (b.level > a.level ? b : a));
    level = entry.level;
    geometry = suzanneGeometry(objText, level, header.transform);
    if (geometry.attributes.position.count !== entry.verts) throw new Error(`Suzanne L${entry.level}: vertex count does not match the baked AO`);
    geometry.computeVertexNormals();
    const a = arrays[entry.ao];
    const ao = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) ao[i] = a[i] / 255;
    geometry.setAttribute("ao", new BufferAttribute(ao, 1));
  } else {
    const lod = header.lods[lite ? 1 : 0];
    const { position, normal, ao, index } = decodeLod(lod, arrays);
    geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(position, 3));
    geometry.setAttribute("normal", new BufferAttribute(normal, 3));
    geometry.setAttribute("ao", new BufferAttribute(ao, 1));
    geometry.setIndex(new BufferAttribute(new Uint16Array(index), 1));
  }
  const topology = buildTopology(geometry);
  geometry.setAttribute("rim", new BufferAttribute(rimWeights(topology), 1));
  geometry.setAttribute("fade", new BufferAttribute(boundaryFade(topology, geometry.attributes.position.array), 1));
  geometry.setAttribute("clearance", new BufferAttribute(clearance(geometry), 1));
  const walk = geometry;
  if (densify) geometry = densifyGeometry(walk);
  const count = geometry.attributes.position.count;
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(count * 2), 2));
  // Room for the blobs and sag that displace() adds later.
  geometry.boundingSphere = new Sphere(new Vector3(...header.center), 1.5 * header.radius);

  return {
    name,
    key,
    radius: header.radius,
    center: header.center,
    geometry,
    walk,
    level,
    sdf: buildSdf(header.sdf, arrays, header.center, header.radius),
    topology: () => topology,
  };
}

const RIM_RINGS = 4;

// 0 on open boundaries (Suzanne's eye rims), rising to 1 over RIM_RINGS edge rings; 1 everywhere on closed shapes.
function rimWeights({ nv, offsets, neighbours, boundary }) {
  const rim = new Float32Array(nv).fill(1);
  let front = [];
  for (let i = 0; i < nv; i++) if (boundary[i]) (rim[i] = 0), front.push(i);
  for (let ring = 1; ring < RIM_RINGS && front.length; ring++) {
    const next = [];
    for (const i of front)
      for (let k = offsets[i]; k < offsets[i + 1]; k++) {
        const j = neighbours[k];
        if (rim[j] === 1) (rim[j] = ring / RIM_RINGS), next.push(j);
      }
    front = next;
  }
  return rim;
}

const FADE_WIDTH = 0.06;

// Displacement weight for rendering: rises from 0 on open boundaries over FADE_WIDTH of surface distance, so bulges
// ease out wide enough not to fold; 1 everywhere on closed shapes.
function boundaryFade({ nv, offsets, neighbours, boundary }, pos) {
  const d = new Float64Array(nv).fill(FADE_WIDTH);
  let any = false;
  for (let i = 0; i < nv; i++) if (boundary[i]) (d[i] = 0), (any = true);
  for (let changed = any; changed; ) {
    changed = false;
    for (let i = 0; i < nv; i++) {
      if (d[i] >= FADE_WIDTH) continue;
      for (let k = offsets[i]; k < offsets[i + 1]; k++) {
        const j = neighbours[k];
        const e = d[i] + Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]);
        if (e < d[j]) (d[j] = e), (changed = true);
      }
    }
  }
  for (let i = 0; i < nv; i++) {
    const t = d[i] / FADE_WIDTH;
    d[i] = t * t * (3 - 2 * t);
  }
  return new Float32Array(d);
}

// Voxel-centred grid: texel i covers [min + i*step, min + (i+1)*step], so uvw = (q - min) / size.
function buildSdf(info, arrays, center, radius) {
  const { res, min, size } = info;
  const step = size / res;
  const half = arrays[info.data];
  const texture = new Data3DTexture(new Uint16Array(half), res, res, res);
  texture.format = RedFormat;
  texture.type = HalfFloatType;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  const data = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) data[i] = fromHalf(half[i]);
  const at = (i, j, k) =>
    data[Math.min(res - 1, Math.max(0, i)) + res * (Math.min(res - 1, Math.max(0, j)) + res * Math.min(res - 1, Math.max(0, k)))];

  // Trilinear, clamped at the border like the texture.
  function sample(x, y, z) {
    const fx = (x - min[0]) / step - 0.5, fy = (y - min[1]) / step - 0.5, fz = (z - min[2]) / step - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c00 = at(i, j, k) + (at(i + 1, j, k) - at(i, j, k)) * tx;
    const c10 = at(i, j + 1, k) + (at(i + 1, j + 1, k) - at(i, j + 1, k)) * tx;
    const c01 = at(i, j, k + 1) + (at(i + 1, j, k + 1) - at(i, j, k + 1)) * tx;
    const c11 = at(i, j + 1, k + 1) + (at(i + 1, j + 1, k + 1) - at(i, j + 1, k + 1)) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  // Normalised central-difference gradient, written into out.
  function grad(x, y, z, out = new Vector3()) {
    const e = step;
    out.set(
      sample(x + e, y, z) - sample(x - e, y, z),
      sample(x, y + e, z) - sample(x, y - e, z),
      sample(x, y, z + e) - sample(x, y, z - e),
    );
    const l = out.length();
    return l > 1e-8 ? out.multiplyScalar(1 / l) : out.set(0, 1, 0);
  }

  // Sphere-traces the ray o + t·d (d unit) from the bounding sphere; returns t at the surface or -1 on a miss.
  function raycast(o, d, steps = 64, eps = 1e-3) {
    const bound = 1.05 * radius;
    const ox = o.x - center[0], oy = o.y - center[1], oz = o.z - center[2];
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - bound * bound;
    const disc = b * b - c;
    if (disc < 0) return -1;
    let t = Math.max(0, -b - Math.sqrt(disc));
    const tEnd = -b + Math.sqrt(disc);
    for (let i = 0; i < steps && t < tEnd; i++) {
      const s = sample(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
      if (s < eps) return t;
      t += Math.max(s, eps);
    }
    return -1;
  }

  return { texture, res, min, size, step, sample, grad, raycast };
}

// CSR one-ring with clamped cotangent weights, barycentric vertex areas, rest face normals, boundary flags and
// vertex-to-face CSR.
function buildTopology(geometry) {
  const pos = geometry.attributes.position.array;
  const index = geometry.index.array;
  const nv = pos.length / 3;
  const nf = index.length / 3;

  const areas = new Float32Array(nv);
  const faceNormals = new Float32Array(nf * 3);
  // Open-addressed edge table; edge ids follow first occurrence.
  let cap = 2;
  while (cap < nf * 6) cap <<= 1;
  const slotA = new Int32Array(cap).fill(-1), slotB = new Int32Array(cap), slotId = new Int32Array(cap);
  const eA = new Int32Array(nf * 3), eB = new Int32Array(nf * 3), eW = new Float64Array(nf * 3), eUse = new Uint8Array(nf * 3);
  let ne = 0;
  const edgeId = (a, b) => {
    if (a > b) {
      const t = a;
      (a = b), (b = t);
    }
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) & (cap - 1);
    for (;;) {
      if (slotA[h] === -1) {
        (slotA[h] = a), (slotB[h] = b), (slotId[h] = ne), (eA[ne] = a), (eB[ne] = b);
        return ne++;
      }
      if (slotA[h] === a && slotB[h] === b) return slotId[h];
      h = (h + 1) & (cap - 1);
    }
  };
  const v = [0, 0, 0], px = [0, 0, 0], py = [0, 0, 0], pz = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const i = (v[k] = index[f * 3 + k]);
      (px[k] = pos[i * 3]), (py[k] = pos[i * 3 + 1]), (pz[k] = pos[i * 3 + 2]);
    }
    const ux = px[1] - px[0], uy = py[1] - py[0], uz = pz[1] - pz[0];
    const wx = px[2] - px[0], wy = py[2] - py[0], wz = pz[2] - pz[0];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const len = Math.hypot(cx, cy, cz);
    const area = 0.5 * len;
    faceNormals[f * 3] = len > 0 ? cx / len : 0;
    faceNormals[f * 3 + 1] = len > 0 ? cy / len : 0;
    faceNormals[f * 3 + 2] = len > 0 ? cz / len : 0;
    for (let k = 0; k < 3; k++) areas[v[k]] += area / 3;
    for (let k = 0; k < 3; k++) {
      // The angle at corner k weights the opposite edge.
      const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
      const ax = px[k1] - px[k], ay = py[k1] - py[k], az = pz[k1] - pz[k];
      const bx = px[k2] - px[k], by = py[k2] - py[k], bz = pz[k2] - pz[k];
      const rx = ay * bz - az * by, ry = az * bx - ax * bz, rz = ax * by - ay * bx;
      const cot = (ax * bx + ay * by + az * bz) / Math.max(Math.hypot(rx, ry, rz), 1e-12);
      const e = edgeId(v[k1], v[k2]);
      eW[e] += 0.5 * cot;
      eUse[e]++;
    }
  }

  const degree = new Uint32Array(nv);
  for (let e = 0; e < ne; e++) degree[eA[e]]++, degree[eB[e]]++;
  const offsets = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) offsets[i + 1] = offsets[i] + degree[i];
  const neighbours = new Uint32Array(offsets[nv]);
  const weights = new Float32Array(offsets[nv]);
  const fill = offsets.slice(0, nv);
  const boundary = new Uint8Array(nv);
  for (let e = 0; e < ne; e++) {
    const a = eA[e], b = eB[e];
    const cw = Math.max(eW[e], 0.05);
    neighbours[fill[a]] = b;
    weights[fill[a]++] = cw;
    neighbours[fill[b]] = a;
    weights[fill[b]++] = cw;
    if (eUse[e] !== 2) boundary[a] = boundary[b] = 1;
  }

  const vfOffsets = new Uint32Array(nv + 1);
  for (let i = 0; i < index.length; i++) vfOffsets[index[i] + 1]++;
  for (let i = 0; i < nv; i++) vfOffsets[i + 1] += vfOffsets[i];
  const vfFaces = new Uint32Array(index.length);
  const vfFill = vfOffsets.slice(0, nv);
  for (let i = 0; i < index.length; i++) vfFaces[vfFill[index[i]]++] = (i / 3) | 0;

  return { nv, nf, offsets, neighbours, weights, areas, index, faceNormals, boundary, vfOffsets, vfFaces };
}
