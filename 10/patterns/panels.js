// Framed panels, shared by girih and guilloché: the quads of a mesh over the blank (weave.js) become panels, each
// with a (u, v) chart from its four edges (curves on the surface, so a panel can wrap round a thin tube), a raised
// frame along every edge and a boss at every corner. A panel's contents are laid in its chart; the symmetry images
// copy them, and a panel an image maps onto itself says how (its stabilizer) so its contents can match.
import { FRET, BEAD, rnd, applyImage, inDomain, surfacePoint } from "../kit.js";
import { weaveMesh, sub, add, scale, dot, cross, len } from "./weave.js";

const normalize = (a) => scale(a, 1 / (len(a) || 1));

export function framedPanels(shape, cell, images) {
  const mesh = weaveMesh(shape, cell, images);
  if (!mesh.symmetric) images = [];
  const onSurf = (p) => shape.project(p[0], p[1], p[2]);

  // Each edge as a curve on the surface: chord midpoints projected, recursively, to pieces under `maxPiece`.
  const maxPiece = 0.045;
  const curves = new Map();
  function curve(a, b) {
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    let c = curves.get(key);
    if (!c) {
      const pts = [mesh.V[Math.min(a, b)], mesh.V[Math.max(a, b)]];
      for (let depth = 0; depth < 6; depth++) {
        let longest = 0;
        for (let i = 1; i < pts.length; i++) longest = Math.max(longest, len(sub(pts[i], pts[i - 1])));
        if (longest < maxPiece) break;
        for (let i = pts.length - 1; i > 0; i--) {
          const q = onSurf(scale(add(pts[i], pts[i - 1]), 0.5));
          pts.splice(i, 0, [q[0], q[1], q[2]]);
        }
      }
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1]));
      c = { pts, L, a: Math.min(a, b), b: Math.max(a, b) };
      curves.set(key, c);
    }
    return c;
  }
  // The point at parameter t from vertex `from` along an edge curve.
  function along(c, from, t) {
    const n = c.pts.length - 1;
    let x = (from === c.a ? t : 1 - t) * n;
    const i = Math.max(0, Math.min(n - 1, Math.floor(x)));
    x -= i;
    const p = c.pts[i];
    const q = c.pts[i + 1];
    return [p[0] + (q[0] - p[0]) * x, p[1] + (q[1] - p[1]) * x, p[2] + (q[2] - p[2]) * x];
  }

  const panels = [];
  mesh.F.forEach((loop) => {
    if (loop.length !== 4) return;
    const [i0, i1, i2, i3] = loop;
    const C = loop.map((i) => mesh.V[i]);
    const e0 = curve(i0, i1);
    const e1 = curve(i1, i2);
    const e2 = curve(i3, i2);
    const e3 = curve(i0, i3);
    // Coons patch of the four edge curves, projected.
    const raw = (u, v) => {
      const a = along(e0, i0, u);
      const b = along(e2, i3, u);
      const c = along(e3, i0, v);
      const d = along(e1, i1, v);
      const out = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        out[k] = (1 - v) * a[k] + v * b[k] + (1 - u) * c[k] + u * d[k] - ((1 - u) * (1 - v) * C[0][k] + u * (1 - v) * C[1][k] + u * v * C[2][k] + (1 - u) * v * C[3][k]);
      return out;
    };
    const map = (u, v) => onSurf(raw(u, v));
    const Lu = (e0.L + e2.L) / 2;
    const Lv = (e3.L + e1.L) / 2;
    const q = map(0.5, 0.5);
    const c = [q[0], q[1], q[2]];
    const n = [q[3], q[4], q[5]];
    const du = sub(map(0.55, 0.5), map(0.45, 0.5));
    const ex = normalize(sub(du, scale(n, dot(du, n))));
    const ey = cross(n, ex);
    // The images that map this panel onto itself: any mirror, and any that swaps its axes.
    let mirror = false;
    let quarter = false;
    let fixed = false;
    for (const m of images) {
      const mc = applyImage(m, c);
      if (len(sub(mc, c)) > 1e-4) continue;
      fixed = true;
      if (m.det < 0) mirror = true;
      if (Math.abs(dot(applyImage(m, ex), ey)) > 0.5) quarter = true;
    }
    panels.push({ loop, corners: C, map, Lu, Lv, c, n, ex, ey, fixed, mirror, quarter, own: inDomain(c, images) });
  });
  return { mesh, images, panels, curve, along };
}

// The drawing spreads from one point over the blank.
export function waveFrom(shape) {
  const o = surfacePoint(shape);
  return (p) => Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
}

/*
 * The frame: a strap along every edge (round-capped pieces along its curve) and a boss at every corner, each emitted
 * once per orbit. opts: w (half width), kind (FRET profile), boss (radius), gap, occ, when (time of a point), owner.
 */
export function emitFrames(prims, P, opts) {
  const { w, kind, boss, gap, occ, when, images } = opts;
  const dom = (p) => inDomain(p, images);
  let owner = opts.owner ?? 1e6;
  const done = new Set();
  for (const pn of P.panels)
    for (let k = 0; k < 4; k++) {
      const a = pn.loop[k];
      const b = pn.loop[(k + 1) % 4];
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      if (done.has(key)) continue;
      done.add(key);
      const c = P.curve(a, b);
      const pts = c.pts;
      if (!dom(pts[pts.length >> 1])) continue;
      const id = owner++;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        for (let j = 0; j < 3; j++) {
          const x = [p[0] + ((q[0] - p[0]) * j) / 3, p[1] + ((q[1] - p[1]) * j) / 3, p[2] + ((q[2] - p[2]) * j) / 3];
          occ.add(x[0], x[1], x[2], w + gap, id, 0, when(x));
        }
        const [s0, s1] = when(p) <= when(q) ? [p, q] : [q, p];
        prims.push({ type: FRET, a: s0.slice(), b: s1.slice(), w, ext: -1, extB: -1, kind, ta: when(s0), tb: when(s1), h: 1 });
      }
    }
  P.mesh.V.forEach((v, i) => {
    if (!dom(v) || !P.panels.some((pn) => pn.loop.includes(i))) return;
    occ.add(v[0], v[1], v[2], boss + gap, owner++, 0, when(v));
    prims.push({ type: BEAD, a: v.slice(), R: boss, ta: when(v) + 0.05, tb: when(v) + 0.1, h: 1 });
  });
  return owner;
}

// A segment's parameters [t0, t1] inside the box |x| <= X, |y| <= Y (Liang-Barsky), or null.
export function clipBox(p, q, X, Y) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0] + X], [dx, X - p[0]], [-dy, p[1] + Y], [dy, Y - p[1]]]) {
    if (Math.abs(pp) < 1e-12) {
      if (qq < 0) return null;
      continue;
    }
    const r = qq / pp;
    if (pp < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

export const pick = (list) => list[Math.floor(rnd() * list.length)];
