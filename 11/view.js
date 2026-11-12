// The direction to look at a machine from that shows most of it: mostly the gears' faces (each gear's disc projected
// along the direction, summed, favouring three-quarter views), tempered by occlusion. Candidate directions are scored by rendering the
// parts' vertices into a small depth buffer (orthographic, along each direction) and counting how much of every part
// stays visible: each part counts by the square root of what shows, so a view that shows every part a little beats one
// that shows a few parts fully, and gear faces seen face-on (large silhouettes) win over edge-on ones.
import { Vector3 } from "three";

const N = 64;
const depth = new Float32Array(N * N);
const owner = new Int32Array(N * N);

// Points per part, in the part's frame: a subsample of its mesh vertices.
function partPoints(part, max = 600) {
  const pos = part.build?.result?.position;
  if (!pos) return null;
  const n = pos.length / 3, step = Math.max(1, Math.floor(n / max));
  const out = [];
  for (let i = 0; i < n; i += step) out.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
  return out;
}

export function bestView(machine, q = 0, anchor = 0, { minElevation = -0.25, maxElevation = 0.9 } = {}) {
  const parts = machine.parts
    .map((part, id) => ({ id, pts: partPoints(part), m: part.pose(q, anchor) }))
    .filter((p) => p.pts);
  // World points, once.
  const world = parts.map(({ pts, m }) => {
    const e = m.elements, w = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      w[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      w[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      w[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return w;
  });
  const R = machine.bounds?.radius ?? 0.7;
  const dir = new Vector3(), u = new Vector3(), v = new Vector3(), up = new Vector3(0, 1, 0);
  // Pixels each part covers unoccluded, per candidate direction.
  const cands = [];
  for (let a = 0; a < 24; a++)
    for (let b = 0; b < 6; b++) {
      const az = (a / 24) * Math.PI * 2, el = minElevation + ((b + 0.5) / 6) * (maxElevation - minElevation);
      dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      u.crossVectors(up, dir).normalize();
      v.crossVectors(dir, u);
      depth.fill(-Infinity);
      owner.fill(-1);
      world.forEach((w, p) => {
        for (let i = 0; i < w.length; i += 3) {
          const px = Math.floor(((w[i] * u.x + w[i + 1] * u.y + w[i + 2] * u.z) / R * 0.5 + 0.5) * N);
          const py = Math.floor(((w[i] * v.x + w[i + 1] * v.y + w[i + 2] * v.z) / R * 0.5 + 0.5) * N);
          if (px < 0 || py < 0 || px >= N || py >= N) continue;
          const d = w[i] * dir.x + w[i + 1] * dir.y + w[i + 2] * dir.z, k = px + py * N;
          if (d > depth[k]) {
            depth[k] = d;
            owner[k] = p;
          }
        }
      });
      const seen = new Float32Array(parts.length);
      for (let k = 0; k < N * N; k++) if (owner[k] >= 0) seen[owner[k]]++;
      cands.push({ dir: dir.clone(), el, seen });
    }
  // Each part against the most of it any view shows, so big parts don't outvote small ones.
  const most = new Float32Array(parts.length);
  for (const c of cands) for (let p = 0; p < parts.length; p++) most[p] = Math.max(most[p], c.seen[p]);
  // Each gear as a disc: its projected area along a direction is pi r^2 |cos|, between its axle and the view.
  const discs = [];
  for (const part of machine.parts) {
    const r = part.build?.result;
    const rad = r?.outerRadius ?? r?.tipRadius ?? (r?.pitchRadius ? r.pitchRadius * 1.08 : 0);
    if (!rad || !part.axle) continue;
    const a = new Vector3(...part.axle.dir).normalize();
    discs.push({ a, area: Math.PI * rad * rad });
  }
  let best = null, bestScore = -1;
  for (const c of cands) {
    let disc = 0, discMax = 0;
    // A three-quarter view: each disc counts most seen some 38 degrees off its axle (c^0.8 (1 - c^2)^0.25 peaks at
    // c^2 = 0.62), so faces read large and the teeth and thickness show too; dead face-on looks flat.
    for (const d of discs) {
      const cs = Math.abs(d.a.dot(c.dir));
      disc += d.area * Math.pow(cs, 0.8) * Math.pow(1 - cs * cs, 0.25);
      discMax += d.area * 0.6;
    }
    let vis = 0;
    for (let p = 0; p < parts.length; p++) if (most[p] > 0) vis += Math.sqrt(c.seen[p] / most[p]);
    // Mostly the gears' projected disc area, tempered by how much of every part stays unhidden.
    let score = (discMax > 0 ? disc / discMax : 0.5) * (0.5 + 0.5 * vis / Math.max(1, parts.length));
    // A gentle preference for views from a little above, as one looks at a machine on a bench.
    score *= 1 + 0.08 * Math.sin(Math.max(0, c.el));
    if (score > bestScore) {
      bestScore = score;
      best = c.dir;
    }
  }
  return best ?? new Vector3(0.4, 0.3, 1).normalize();
}

// The machine's vertices in world space (a subsample per part), for framing and grounding.
export function machinePoints(machine, q = 0, anchor = 0, max = 400) {
  const out = [];
  for (const part of machine.parts) {
    const pos = part.build?.result?.position;
    if (!pos) continue;
    const e = part.pose(q, anchor).elements;
    const n = pos.length / 3, step = Math.max(1, Math.floor(n / max));
    for (let i = 0; i < n; i += step) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      out.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
  }
  return Float32Array.from(out);
}

// How far along `dir` (unit, from target toward the camera) the camera must be for every point to fit the view.
export function fitDistance(points, target, dir, fov, aspect, margin = 0.88) {
  const tv = Math.tan((fov * Math.PI) / 360) * margin, th = tv * aspect;
  const up = Math.abs(dir.y) > 0.99 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const u = new Vector3().crossVectors(up, dir).normalize(), v = new Vector3().crossVectors(dir, u);
  let D = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - target.x, y = points[i + 1] - target.y, z = points[i + 2] - target.z;
    const px = x * u.x + y * u.y + z * u.z, py = x * v.x + y * v.y + z * v.z, pz = x * dir.x + y * dir.y + z * dir.z;
    D = Math.max(D, pz + Math.abs(px) / th, pz + Math.abs(py) / tv);
  }
  return D;
}
