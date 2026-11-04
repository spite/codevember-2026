// node 3/tools/bake.mjs [shape|all]  ->  3/assets/<shape>.bin
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHAPES } from "./sdf.mjs";
import { surfaceNets, compact, meshSdfGrid, topology, relax, sdfNormals, meshNormals, bakeAO, facetAngles, gradient, sdfGrid, gridSampler, aabb } from "./mesher.mjs";
import { encodeAsset, toHalf, octEncode } from "./format.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = `${here}../assets/`;
// Target vertex counts; N per shape is picked from a coarse pass so every shape lands near them.
export const LODS = { hi: { verts: 19000, minN: 72, maxN: 128 }, lo: { verts: 8000, minN: 48, maxN: 88 } };
export const SUZANNE_LEVELS = [3, 2];
const SDF_RES = 48;

function packLod(name, mesh, normals, ao, arrays) {
  const { pos, index } = mesh;
  const nv = pos.length / 3;
  if (nv > 65535) throw new Error(`${name}: ${nv} vertices do not fit Uint16 indices`);
  const { lo, hi } = aabb(pos);
  const qsize = [0, 1, 2].map((k) => hi[k] - lo[k] || 1);
  const q = new Uint16Array(nv * 3), n = new Int16Array(nv * 2), a = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) q[v * 3 + k] = Math.round(((pos[v * 3 + k] - lo[k]) / qsize[k]) * 65535);
    octEncode(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], n, v * 2);
    a[v] = Math.round(Math.max(0, Math.min(1, ao[v])) * 255);
  }
  Object.assign(arrays, { [`${name}.position`]: q, [`${name}.normal`]: n, [`${name}.index`]: Uint16Array.from(index), [`${name}.ao`]: a });
  return { verts: nv, tris: index.length / 3, qmin: lo, qsize, position: `${name}.position`, normal: `${name}.normal`, index: `${name}.index`, ao: `${name}.ao` };
}

function packSdf(grid, arrays) {
  const h = new Uint16Array(grid.data.length);
  for (let i = 0; i < h.length; i++) h[i] = toHalf(grid.data[i]);
  arrays["sdf"] = h;
  return { res: grid.res, min: grid.min, size: grid.size, step: grid.size / grid.res, sampling: "voxel-centres", data: "sdf" };
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function bakeShape(key) {
  const { name, f, bound, genus } = SHAPES[key];
  const t0 = performance.now();
  // Centre and scale to bounding radius 1 from a coarse pass.
  const coarse = compact(surfaceNets(f, bound, 48, { newtonSteps: 2 }));
  const { lo, hi } = aabb(coarse.pos);
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let R = 0;
  for (let v = 0; v < coarse.pos.length; v += 3) R = Math.max(R, Math.hypot(coarse.pos[v] - c[0], coarse.pos[v + 1] - c[1], coarse.pos[v + 2] - c[2]));
  R *= 1.01;
  const g = (x, y, z) => f(x * R + c[0], y * R + c[1], z * R + c[2]) / R;

  const arrays = {};
  const lods = [];
  const stats = { name, genus, expectedEuler: 2 - 2 * genus, lods: [] };
  let hiBox, hiMesh;
  const probe = compact(surfaceNets(g, 1.04, 48, { newtonSteps: 0 })).pos.length / 3;
  for (const [lodName, lod] of Object.entries(LODS)) {
    const N = Math.round(Math.min(lod.maxN, Math.max(lod.minN, 48 * Math.sqrt(lod.verts / probe))));
    const mesh = compact(surfaceNets(g, 1.04, N));
    relax(mesh, g, 3);
    const topo = topology(mesh);
    const normals = sdfNormals(mesh, g);
    const ao = bakeAO(mesh, normals, g, 1);
    const ang = facetAngles(mesh, (x, y, z) => gradient(g, x, y, z));
    lods.push(packLod(lodName, mesh, normals, ao, arrays));
    if (lodName === "hi") { hiBox = aabb(mesh.pos); hiMesh = mesh; }
    let aoMin = 1, aoSum = 0;
    for (const a of ao) { aoMin = Math.min(aoMin, a); aoSum += a; }
    stats.lods.push({ lod: lodName, N, ...topo, componentOf: undefined, facetAngleMean: r4(ang.mean), facetAngleMax: r4(ang.max), flipped: ang.flipped, aoMin: r4(aoMin), aoMean: r4(aoSum / ao.length) });
  }
  // Exact distance to the hi mesh, signed by the analytic field, whose magnitude breaks down away from the surface.
  const grid = meshSdfGrid(hiMesh, (x, y, z) => g(x, y, z) < 0, hiBox.lo, hiBox.hi, SDF_RES, 0.25);
  const sdf = packSdf(grid, arrays);
  const bytes = encodeAsset({ name, key, radius: 1, center: [0, 0, 0], source: { scale: r4(R), center: c.map(r4) }, lods, sdf }, arrays);
  writeFileSync(`${ASSETS}${key}.bin`, bytes);
  stats.bytes = bytes.length;
  stats.seconds = r4((performance.now() - t0) / 1000);
  return stats;
}

async function bakeSuzanne() {
  const { loadSuzanne, suzanneField } = await import("./suzanne.mjs");
  const t0 = performance.now();
  const levels = loadSuzanne(`${ASSETS}suzanne.obj`, [0, ...SUZANNE_LEVELS]);
  const top = levels.find((l) => l.level === Math.max(...SUZANNE_LEVELS));
  const { lo, hi } = aabb(top.pos);
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let R = 0;
  for (let v = 0; v < top.pos.length; v += 3) R = Math.max(R, Math.hypot(top.pos[v] - c[0], top.pos[v + 1] - c[1], top.pos[v + 2] - c[2]));
  R *= 1.01;
  const scale = 1 / R;
  for (const l of levels) for (let v = 0; v < l.pos.length; v += 3) for (let k = 0; k < 3; k++) l.pos[v + k] = (l.pos[v + k] - c[k]) * scale;

  const fine = suzanneField(top, { R: 192, margin: 0.3, sigma: 1 });
  const fineSdf = gridSampler(fine);
  const box = aabb(top.pos);
  const grid = sdfGrid(fineSdf, box.lo, box.hi, SDF_RES, 0.25);
  const coarseSdf = gridSampler(grid);

  const arrays = {};
  const subdiv = [];
  const stats = { name: "Suzanne", components: fine.components, levels: [] };
  for (const l of levels) {
    const topo = topology(l);
    const entry = { level: l.level, verts: topo.verts, tris: topo.tris, euler: topo.euler, boundary: topo.boundary, nonManifold: topo.nonManifold, misoriented: topo.misoriented, components: topo.components };
    if (l.level === 0) { stats.cage = entry; continue; }
    const normals = meshNormals(l);
    const ao = bakeAO(l, normals, fineSdf, 1);
    const a = new Uint8Array(ao.length);
    for (let i = 0; i < ao.length; i++) a[i] = Math.round(Math.max(0, Math.min(1, ao[i])) * 255);
    arrays[`l${l.level}.ao`] = a;
    subdiv.push({ level: l.level, verts: topo.verts, tris: topo.tris, ao: `l${l.level}.ao` });
    const err = (s) => {
      let sum = 0, max = 0;
      for (let v = 0; v < l.pos.length; v += 3) { const d = Math.abs(s(l.pos[v], l.pos[v + 1], l.pos[v + 2])); sum += d; max = Math.max(max, d); }
      return { mean: r4(sum / (l.pos.length / 3)), max: r4(max) };
    };
    const angFine = facetAngles(l, (x, y, z) => gradient(fineSdf, x, y, z, fine.size / fine.res));
    const angCoarse = facetAngles(l, (x, y, z) => gradient(coarseSdf, x, y, z, grid.size / grid.res));
    let aoMin = 1, aoSum = 0;
    for (const x of ao) { aoMin = Math.min(aoMin, x); aoSum += x; }
    stats.levels.push({ ...entry, sdfErrFine: err(fineSdf), sdfErr48: err(coarseSdf), facetVsFine: { mean: r4(angFine.mean), max: r4(angFine.max), flipped: angFine.flipped }, facetVs48: { mean: r4(angCoarse.mean), max: r4(angCoarse.max), flipped: angCoarse.flipped }, aoMin: r4(aoMin), aoMean: r4(aoSum / ao.length) });
  }
  const sdf = packSdf(grid, arrays);
  const header = { name: "Suzanne", key: "suzanne", radius: 1, center: [0, 0, 0], transform: { center: c, scale }, mesh: { source: "assets/suzanne.obj", subdivide: subdiv }, lods: [], sdf };
  const bytes = encodeAsset(header, arrays);
  writeFileSync(`${ASSETS}suzanne.bin`, bytes);
  stats.bytes = bytes.length;
  stats.seconds = r4((performance.now() - t0) / 1000);
  return stats;
}

export const ALL = ["suzanne", ...Object.keys(SHAPES)];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] || "all";
  const keys = arg === "all" ? ALL : arg.split(",");
  for (const key of keys) {
    const stats = key === "suzanne" ? await bakeSuzanne() : bakeShape(key);
    console.log(JSON.stringify(stats));
  }
}
