// Every shape family, and the seeded parameters of a shape. Shared by the page and the mesher workers.
import { SHAPES as PARAMETRIC } from "./parametric.js";
import { SHAPES as WARPED } from "./warped.js";
import { SHAPES as FRACTAL } from "./fractal.js";
import { SHAPES as VOLUMES } from "./volumes.js";

const SHAPES = [...PARAMETRIC, ...WARPED, ...FRACTAL, ...VOLUMES];
// Only the volumes are offered; the other families stay available by id.
const FAMILIES = { volumes: "Volumes" };

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const shapeById = (id) => SHAPES.find((s) => s.id === id);
const shapeParams = (id, form) => shapeById(id).random(mulberry32(hashString(`${id}:${form}`)));
// A shape's build parameters from its sliders' values; shapes without sliders (and the blend's variant) are seeded.
function shapeConfig(id, values, form = 0) {
  const def = shapeById(id);
  if (def.fromSliders && values) return def.fromSliders(values);
  if (def.sliders?.length && values) return shapeParams(id, Object.values(values).join(","));
  return shapeParams(id, form);
}

export { SHAPES, FAMILIES, shapeById, shapeParams, shapeConfig, mulberry32 };
