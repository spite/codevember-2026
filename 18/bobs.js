import { slabGeometry } from "./slab.js";
import { sdStar } from "./field.js";

// A bob in its own frame: X along the swing (its thickness), Y toward the pivot, Z across. `top` is where the rod
// enters (on +Y), `symmetry` how many turns about X map it onto itself.

function starBob({ points = 5, radius = 0.15, inner = 0.46, round = 0.014, thickness = 0.07, bevel = 0.016 } = {}) {
  const r = radius - round;
  const field = (u, v) => sdStar(u, v, r, points, r * inner) - round;
  const R = radius + 0.01;
  const geometry = slabGeometry(field, [-R, -R, R, R], { thickness, bevel, cell: 0.0008 });
  return { geometry, top: radius, symmetry: points, halfDepth: thickness / 2, radius };
}

export { starBob };
