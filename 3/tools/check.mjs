// node 3/tools/check.mjs [shape|all]: decodes each baked asset and prints its mesh and SDF statistics.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHAPES } from "./sdf.mjs";
import { topology, facetAngles, gradient, gridSampler } from "./mesher.mjs";
import { decodeAsset, decodeLod, decodeSdf } from "./format.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = `${here}../assets/`;
const r3 = (x) => Math.round(x * 1e3) / 1e3;

function vertexError(pos, sdf) {
  let sum = 0, max = 0;
  for (let v = 0; v < pos.length; v += 3) {
    const d = Math.abs(sdf(pos[v], pos[v + 1], pos[v + 2]));
    sum += d;
    max = Math.max(max, d);
  }
  return `${r3(sum / (pos.length / 3))}/${r3(max)}`;
}

function normalError(pos, normals, sdf) {
  let sum = 0, max = 0;
  for (let v = 0; v < pos.length; v += 3) {
    const g = gradient(sdf, pos[v], pos[v + 1], pos[v + 2]);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    const dot = (g[0] * normals[v] + g[1] * normals[v + 1] + g[2] * normals[v + 2]) / gl;
    const a = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    sum += a;
    max = Math.max(max, a);
  }
  return `${r3(sum / (pos.length / 3))}/${r3(max)}`;
}

function row(label, mesh, extra) {
  const t = topology(mesh);
  return { shape: label, verts: t.verts, tris: t.tris, chi: t.euler, boundary: t.boundary, nonManifold: t.nonManifold, misoriented: t.misoriented, components: t.components, ...extra };
}

const keys = process.argv[2] && process.argv[2] !== "all" ? process.argv[2].split(",") : ["suzanne", ...Object.keys(SHAPES)];
const rows = [];
let suzanneGeometry;
for (const key of keys) {
  const file = `${ASSETS}${key}.bin`;
  const buf = readFileSync(file);
  const { header, arrays } = decodeAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const grid = { ...header.sdf, data: decodeSdf(header.sdf, arrays) };
  const s48 = gridSampler(grid);
  const g48 = (x, y, z) => gradient(s48, x, y, z, grid.step);
  const kb = Math.round(statSync(file).size / 1024);
  if (key === "suzanne") {
    if (!suzanneGeometry) ({ suzanneGeometry } = await import("./suzanne.mjs").then(() => import("../suzanneMesh.js")));
    const text = readFileSync(`${ASSETS}suzanne.obj`, "utf8");
    for (const lvl of header.mesh.subdivide) {
      const geo = suzanneGeometry(text, lvl.level, header.transform);
      const mesh = { pos: Float64Array.from(geo.attributes.position.array), index: Uint32Array.from(geo.index.array) };
      if (mesh.pos.length / 3 !== lvl.verts || arrays[lvl.ao].length !== lvl.verts) throw new Error(`suzanne L${lvl.level}: vertex count mismatch`);
      const a48 = facetAngles(mesh, g48);
      rows.push(row(`Suzanne L${lvl.level}`, mesh, { "facet-vs-sdf48 mean/max": `${r3(a48.mean)}/${r3(a48.max)}`, "flipped(>90)": a48.flipped, "|sdf48| at verts mean/max": vertexError(mesh.pos, s48), "vnormal-vs-sdf": "-", KB: kb }));
    }
    continue;
  }
  const { scale, center } = header.source;
  const f = SHAPES[key].f;
  const sdf = (x, y, z) => f(x * scale + center[0], y * scale + center[1], z * scale + center[2]) / scale;
  for (const lod of header.lods) {
    const d = decodeLod(lod, arrays);
    const mesh = { pos: Float64Array.from(d.position), index: Uint32Array.from(d.index) };
    const aS = facetAngles(mesh, (x, y, z) => gradient(sdf, x, y, z));
    const a48 = facetAngles(mesh, g48);
    rows.push(row(`${header.name} ${Object.keys(header.lods).length > 1 ? (lod === header.lods[0] ? "hi" : "lo") : ""}`, mesh, {
      "facet-vs-sdf mean/max": `${r3(aS.mean)}/${r3(aS.max)}`,
      "facet-vs-sdf48 mean/max": `${r3(a48.mean)}/${r3(a48.max)}`,
      "flipped(>90)": aS.flipped,
      "|sdf48| at verts mean/max": vertexError(mesh.pos, s48),
      "vnormal-vs-sdf": normalError(mesh.pos, d.normal, sdf),
      KB: kb,
    }));
  }
}
console.table(rows);
