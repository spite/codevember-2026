// Guilloché: engine-turned panels, as on a Fabergé case. The blank is framed into panels (panels.js) by plain raised
// borders; some are split again by finer beaded or plain fillets, and each panel is cut with its own turned motif
// (rose-engine rings, sunburst, waves, barleycorn, hobnail or spiral rays) from a small palette per piece. A panel
// whose surface turns too much to be cut flat is split until it doesn't. Drawn panel by panel from one point,
// each cut line by line across it.
import { GUILLOCHE, FRET, FLAT, RIBBED, BEADED, ROSE, SUNBURST, WAVES, BARLEYCORN, HOBNAIL, SPIRAL, rnd, rand, Occupancy, inDomain, applyImage } from "../kit.js";
import { framedPanels, waveFrom, emitFrames, pick } from "./panels.js";
import { sub, add, scale, dot, cross, len } from "./weave.js";

const normalize = (a) => scale(a, 1 / (len(a) || 1));
// The motifs a panel on a symmetry axis or plane can take (they look the same turned a quarter or mirrored).
const SYMMETRIC = [ROSE, SUNBURST, BARLEYCORN, HOBNAIL];

/*
 * opts: scale, flow (panel size), fill (how many panels are split), rosettes (how many motifs a piece mixes),
 * lobes (the rose engine's lobes), seed.
 */
export function guilloche(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const mix = opts.rosettes ?? 0.5;
  const lobes = opts.lobes ?? 3;
  const P = framedPanels(shape, 0.3 * S * (0.75 + 0.75 * flow), kit.images);
  const images = P.images;
  const dom = (p) => inDomain(p, images);
  const prims = [];
  const occ = new Occupancy(0.03 * S, shape.bounds);
  occ.images = images;
  const GAP = 0.0028 * S;
  const wf = 0.0062 * S * rand(0.9, 1.15);
  const wd = wf * 0.55;
  const wave = waveFrom(shape);
  const when = (p) => wave(p) * 3;
  const owner = emitFrames(prims, P, { w: wf, kind: rnd() < 0.6 ? FLAT : RIBBED, boss: wf * 1.6, gap: GAP, occ, when, images });
  const divider = rnd() < 0.5 ? BEADED : FLAT;
  // The piece's palette: one to three motifs, a pitch, a hand.
  const all = [ROSE, SUNBURST, WAVES, BARLEYCORN, HOBNAIL, SPIRAL];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const palette = all.slice(0, 1 + Math.round(mix * 2));
  const pitch = Math.min(0.0255, 0.0072 * S * rand(0.85, 1.2));
  const hand = rnd() < 0.5 ? 1 : -1;

  for (const pn of P.panels) {
    if (!pn.own) continue;
    const t0 = when(pn.c) + 0.2;
    const keep = (p) => !pn.fixed || dom(p);
    const at = (u, v) => {
      const q = pn.map(u, v);
      return { p: [q[0], q[1], q[2]], n: [q[3], q[4], q[5]] };
    };
    // A part as the shader will see it: corners in the tangent frame at its centre, inset from the frame or fillet
    // along each side, and how far its sides along u and along v stray from where they should be (the outline is
    // straight in that frame, the part's sides bow on a bending surface).
    const ins = (outer) => (outer ? wf : wd) + GAP;
    const fit = (u0, u1, v0, v1) => {
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      const { p: c, n } = at(um, vm);
      const du = sub(at(um + 0.02 * (u1 - u0), vm).p, at(um - 0.02 * (u1 - u0), vm).p);
      const ex = normalize(sub(du, scale(n, dot(du, n))));
      const ey = cross(n, ex);
      const flat = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => {
        const q = sub(at(u, v).p, c);
        return [dot(q, ex), dot(q, ey)];
      });
      const sides = [v0 === 0, u1 === 1, v1 === 1, u0 === 0].map(ins);
      // Corner k sits between side k - 1 and side k (bottom, right, top, left), where their inset lines meet.
      const corners = flat.map((p, k) => {
        const a = flat[(k + 3) % 4];
        const b = flat[(k + 1) % 4];
        const n1 = normalize2([p[1] - a[1], a[0] - p[0]]);
        const n2 = normalize2([b[1] - p[1], p[0] - b[0]]);
        const det = n1[0] * n2[1] - n1[1] * n2[0];
        if (Math.abs(det) < 1e-9) return p;
        const c1 = n1[0] * p[0] + n1[1] * p[1] - sides[(k + 3) % 4];
        const c2 = n2[0] * p[0] + n2[1] * p[1] - sides[k];
        return [(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det];
      });
      const err = [0, 0];
      for (let k = 0; k < 4; k++)
        for (const f of [0.25, 0.5, 0.75]) {
          const [u, v] = [[u0 + (u1 - u0) * f, v0], [u1, v0 + (v1 - v0) * f], [u0 + (u1 - u0) * f, v1], [u0, v0 + (v1 - v0) * f]][k];
          const { p: P, n: N } = at(u, v);
          const ax = normalize(sub(ex, scale(N, dot(N, ex))));
          const sd = cross(N, ax);
          const dv = sub(P, c);
          const x = dot(dv, ax);
          const y = dot(dv, sd);
          const A = corners[k];
          const B = corners[(k + 1) % 4];
          const e = normalize2([B[0] - A[0], B[1] - A[1]]);
          const dq = (x - A[0]) * e[1] - (y - A[1]) * e[0];
          err[k & 1] = Math.max(err[k & 1], Math.abs(dq - sides[k]));
        }
      return { c, n, ex, corners, err };
    };
    // Split in two along the longer side, or in four, and wherever a part's sides stray too far.
    const parts = [];
    const lines = [];
    const split = (u0, u1, v0, v1, depth) => {
      const f = fit(u0, u1, v0, v1);
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      // (Not below a size: where the surface folds that tightly the frames hide the rest.)
      let su = depth < 4 && f.err[0] > 0.005 * S && (u1 - u0) * pn.Lu > 0.07 * S;
      let sv = depth < 4 && f.err[1] > 0.005 * S && (v1 - v0) * pn.Lv > 0.07 * S;
      if (!su && !sv && depth === 0 && rnd() < fill * 0.8 && Math.min(pn.Lu, pn.Lv) > 0.14 * S) {
        if (rnd() < 0.5) su = sv = true;
        else if (pn.Lu >= pn.Lv) su = true;
        else sv = true;
      }
      // A panel the symmetry maps onto itself only splits in four, so the parts map onto each other.
      if (pn.fixed && (su || sv)) su = sv = true;
      if (!su && !sv) return parts.push({ ...f, uv: [u0, u1, v0, v1] });
      if (su) lines.push([um, um, v0, v1]);
      if (sv) lines.push([u0, u1, vm, vm]);
      for (const [a, b] of su ? [[u0, um], [um, u1]] : [[u0, u1]]) for (const [c, d] of sv ? [[v0, vm], [vm, v1]] : [[v0, v1]]) split(a, b, c, d, depth + 1);
    };
    split(0, 1, 0, 1, 0);

    // The fillets between the parts.
    for (const [u0, u1, v0, v1] of lines) {
      const m = Math.max(2, Math.ceil(Math.max((u1 - u0) * pn.Lu, (v1 - v0) * pn.Lv) / 0.03));
      let prev = at(u0, v0).p;
      for (let i = 1; i <= m; i++) {
        const cur = at(u0 + ((u1 - u0) * i) / m, v0 + ((v1 - v0) * i) / m).p;
        const mid = scale(add(prev, cur), 0.5);
        if (keep(mid)) {
          const t = t0 + len(sub(mid, pn.c)) * 3;
          prims.push({ type: FRET, a: prev, b: cur, w: wd, ext: -1, extB: -1, kind: divider, ta: t, tb: t + 0.05, h: 1 });
        }
        prev = cur;
      }
    }

    for (const { c, n, ex, corners, uv } of parts) {
      if (!keep(c)) continue;
      const [u0, u1, v0, v1] = uv;
      const R = Math.max(...corners.map(([x, y]) => Math.hypot(x, y))) * 1.02;
      if (R < 0.01 * S) continue;
      const fixed = images.some((m) => len(sub(applyImage(m, c), c)) < 1e-4);
      const kind = pick(fixed ? palette.filter((k) => SYMMETRIC.includes(k)).concat(palette.some((k) => SYMMETRIC.includes(k)) ? [] : [ROSE]) : palette);
      const lob = fixed ? 4 * Math.max(1, Math.round(lobes / 2)) : Math.max(3, Math.round(lobes * rand(1, 2.5)));
      const up = add(c, scale(n, R * 0.8));
      const fr = Math.max(...[[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => len(sub(at(u, v).p, up)))) + 0.004;
      const t = t0 + len(sub(c, pn.c)) * 3 + 0.1;
      prims.push({ type: GUILLOCHE, a: c, b: ex, c: up, fr, R, corners, kind, lobes: Math.min(31, lob), pitch, amp: rand(0.4, 1), twist: hand, ta: t, tb: t + 0.3 + R * 2, h: 1 });
    }
  }
  prims.whole = !P.mesh.symmetric;
  return prims;
}

const normalize2 = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
