// Celtic knotwork: ribbons woven over and under along the medial graph of a mesh over the blank (weave.js), smoothed
// into B-splines. Breaks turn strands back into loops and knots; the under strand dips and stops short of the one
// over it, so the crossing order reads in the relief. Holes the breaks open up get pellets and small rosettes.
import { RIBBON, BEAD, ROSETTE, DAISY, FIVE, rnd, rand, Occupancy, inDomain, createNoise, surfaceLattice } from "../kit.js";
import { weaveMesh, weaveStrands, symmetricBreaks, faceCentre, sub, lerp, len, dot, cross } from "./weave.js";

// Samples a closed uniform cubic B-spline over the controls, `per(i)` points per span.
export function closedBSpline(ctrl, per) {
  const n = ctrl.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i + n - 1) % n];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n];
    const p3 = ctrl[(i + 2) % n];
    const m = per(i);
    for (let k = 0; k < m; k++) {
      const t = k / m;
      const t2 = t * t;
      const t3 = t2 * t;
      const b0 = (1 - t) ** 3 / 6;
      const b1 = (3 * t3 - 6 * t2 + 4) / 6;
      const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
      const b3 = t3 / 6;
      out.push({ i, t, v: p0.v.map((_, c) => b0 * p0.v[c] + b1 * p1.v[c] + b2 * p2.v[c] + b3 * p3.v[c]) });
    }
  }
  return out;
}

/*
 * Lays a closed strand out as ribbon segments. pts: [{p, w}] along the strand (closed); crossings: [{k, over, p}] at
 * point index k. Emits the segments in the fundamental domain. style: 1 knot (rounded), -1 strap (flat).
 */
export function emitStrand(prims, occ, pts, crossings, opts) {
  const { images, style, gap, t0, chunk, owner } = opts;
  const n = pts.length;
  const s = [0];
  for (let k = 1; k <= n; k++) s.push(s[k - 1] + len(sub(pts[k % n].p, pts[k - 1].p)));
  const total = s[n];
  // Arc length from point i, dk points on.
  const sAt = (i, dk) => (i + dk <= n ? s[i + dk] - s[i] : total - s[i] + s[i + dk - n]);
  // Drawn from several starts at once, each spreading both ways.
  const chunks = Math.max(1, Math.round(total / chunk));
  const delays = Array.from({ length: chunks }, () => rand(0, chunk * 0.4));
  const time = (x) => {
    const c = Math.min(chunks - 1, Math.floor((x / total) * chunks));
    const centre = ((c + 0.5) / chunks) * total;
    return t0 + delays[c] + Math.abs(x - centre);
  };
  // The nearest crossing along the strand, for each point.
  const near = new Array(n).fill(null);
  for (const c of crossings)
    for (const dir of [1, -1])
      for (let dk = 0; dk < n; dk++) {
        const k = (((c.k + dir * dk) % n) + n) % n;
        const along = dir > 0 ? sAt(c.k, dk) : sAt(k, dk);
        if (along > c.reach) break;
        if (!near[k] || near[k].arc > along) near[k] = { c, arc: along };
      }
  if (occ)
    for (let k = 0; k < n; k++) {
      const A = pts[k];
      const B = pts[(k + 1) % n];
      const m = Math.max(1, Math.ceil(len(sub(B.p, A.p)) / A.w));
      for (let j = 0; j < m; j++) {
        const p = lerp(A.p, B.p, j / m);
        occ.add(p[0], p[1], p[2], A.w + gap, owner, 0, time(s[k] + (s[k + 1] - s[k]) * (j / m)));
      }
    }
  // Arcs through every `g` points (the middle one sets the bulge); straight for straps.
  const g = style < 0 ? 1 : 2;
  for (let k = 0; k < n; k += g) {
    const k1 = Math.min(n, k + g);
    const A = pts[k];
    const B = pts[k1 % n];
    const M = pts[(k + ((k1 - k) >> 1)) % n];
    const w = (A.w + B.w) / 2;
    let c = null;
    for (let j = k; j <= k1; j++) {
      const q = near[j % n];
      if (q && (!c || q.arc < c.arc)) c = q;
    }
    c = c?.c;
    const mid = lerp(A.p, B.p, 0.5);
    let sag = 0;
    let ang;
    if (style > 0 && k1 - k > 1) {
      const side = cross(M.n, sub(B.p, A.p));
      const l = len(side) || 1;
      sag = dot(sub(M.p, mid), side) / l;
      if (c?.dir) {
        // The crossing strand's angle in this segment's frame, so the cut runs along it.
        const ex = sub(B.p, A.p).map((x) => x / (len(sub(B.p, A.p)) || 1));
        const ey = cross(M.n, ex);
        ang = Math.atan2(dot(c.dir, ey), dot(c.dir, ex));
      }
    } else if (style < 0 && c?.dir) {
      // A strap's slot holds the angle of the one crossing it, in its own frame (along, n × along).
      const ex = sub(B.p, A.p).map((x) => x / (len(sub(B.p, A.p)) || 1));
      const ey = cross(M.n, ex);
      sag = Math.atan2(dot(c.dir, ey), dot(c.dir, ex));
    }
    if (!inDomain(mid, images)) continue;
    let a = A.p.slice();
    let b = B.p.slice();
    if (style < 0) {
      // Square-ended straps run on past a corner by w·tan(turn / 2), so the outer edges meet in a mitre.
      const dir = sub(b, a);
      const l = len(dir) || 1;
      const u = dir.map((x) => x / l);
      const ext = (P, Q) => {
        const v = sub(Q, P);
        const lv = len(v) || 1;
        const c = Math.max(-1, Math.min(1, Math.abs(dot(u, v)) / lv));
        const half = Math.acos(c) / 2;
        return Math.max(w * 0.2, Math.min(w * Math.tan(half), w * 3));
      };
      const ea = ext(pts[(k + n - 1) % n].p, A.p);
      const eb = ext(B.p, pts[(k1 + 1) % n].p);
      a = a.map((x, i) => x - u[i] * ea);
      b = b.map((x, i) => x + u[i] * eb);
    }
    prims.push({
      type: RIBBON,
      a,
      b,
      w: w * style,
      sag,
      c: c ? c.p.slice() : A.p.slice(),
      rc: c ? (c.over ? -c.w : c.w + gap) : 0,
      ang,
      ta: time(s[k]),
      tb: time(s[k1]),
      h: 1,
    });
  }
  return total;
}

/*
 * opts: scale, flow (how many breaks), fill (pellets in the holes), rosettes, seed.
 */
export function knotwork(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const rosettes = opts.rosettes ?? 0.5;
  let images = kit.images;
  let cell = 0.085 * S * rand(0.9, 1.15);
  const mesh = weaveMesh(shape, cell, images);
  cell = mesh.cell ?? cell;
  // No mesh this symmetry maps onto itself: weave the whole surface instead.
  if (!mesh.symmetric) images = [];
  const dom = (p) => inDomain(p, images);
  // Half the pieces get walls: breaks along the edges that follow contours of a noise, which fence the strands into
  // panels; the rest only scattered breaks.
  const noise = createNoise(rnd);
  const nf = 1.1 / S;
  const off = [rand(-50, 50), rand(-50, 50), rand(-50, 50)];
  const nv = (p) => noise(p[0] * nf + off[0], p[1] * nf + off[1], p[2] * nf + off[2]);
  const walled = rnd() < 0.5;
  const l0 = rand(-0.15, 0.15);
  const levels = [l0, l0 + 0.32, l0 - 0.32];
  const wall = (rep, e) => {
    if (!walled) return false;
    // An edge that runs along a level line of the noise, within a third of its length of it, where the noise slopes.
    const ed = sub(e.wp, e.vp);
    const el = len(ed);
    const pd = cross(e.np, ed).map((x) => x / el);
    const h = el * 0.25;
    const gp = (nv([e.mid[0] + pd[0] * h, e.mid[1] + pd[1] * h, e.mid[2] + pd[2] * h]) - nv([e.mid[0] - pd[0] * h, e.mid[1] - pd[1] * h, e.mid[2] - pd[2] * h])) / (2 * h);
    if (Math.abs(gp) < 0.35 * nf) return false;
    const ga = (nv(e.wp) - nv(e.vp)) / el;
    if (Math.abs(ga) > Math.abs(gp) * 0.6) return false;
    const m = nv(e.mid);
    return levels.some((l) => Math.abs((m - l) / gp) < el * 0.34);
  };
  const breaks = symmetricBreaks(images, dom, (walled ? 0.03 : 0.05) + flow * (walled ? 0.12 : 0.3), () => (rnd() < 0.5 ? 1 : 2), wall);
  const { loops } = weaveStrands(mesh, breaks);
  const prims = [];
  const occ = new Occupancy(0.03 * S, shape.bounds);
  const GAP = 0.0025 * S;
  const widthK = rand(0.16, 0.19);
  const centres = mesh.F.map((_, f) => faceCentre(mesh, f));
  const project = (p) => shape.project(p[0], p[1], p[2]);
  let owner = 0;
  for (const steps of loops) {
    // Controls: the corner point of each piece, then the junction at the edge it leaves by.
    const ctrl = [];
    const junction = [];
    for (const st of steps) {
      const { f, u, e } = st;
      const size = (len(sub(mesh.V[e.v], mesh.V[e.w])) + len(sub(mesh.V[st.from.v], mesh.V[st.from.w]))) / 2;
      const w = size * widthK;
      ctrl.push({ v: [...lerp(centres[f], mesh.V[u], 0.45), w] });
      let J = e.mid;
      if (e.kind === 1) J = lerp(e.mid, centres[f], 0.32);
      else if (e.kind === 2) J = lerp(e.mid, mesh.V[u], 0.32);
      junction.push(ctrl.length);
      ctrl.push({ v: [...J, w], st });
    }
    const per = (i) => Math.max(2, Math.ceil(len(sub(ctrl[(i + 1) % ctrl.length].v, ctrl[i].v)) / (ctrl[i].v[3] * 0.9)));
    const samples = closedBSpline(ctrl, per);
    const pts = samples.map((q) => {
      const r = project(q.v);
      return { p: [r[0], r[1], r[2]], n: [r[3], r[4], r[5]], w: q.v[3] };
    });
    // The spline passes through each crossing junction at the start of its span (t = 0 is the middle of the controls
    // around it, which are collinear there).
    const crossings = [];
    samples.forEach((q, k) => {
      if (q.t !== 0) return;
      const c = ctrl[q.i];
      if (!c.st || c.st.e.kind !== 0) return;
      // The strand crossing this one is its mirror image in the edge.
      const e = c.st.e;
      const ed = sub(mesh.V[e.w], mesh.V[e.v]);
      const eu = ed.map((x) => x / (len(ed) || 1));
      const t = sub(pts[(k + 1) % pts.length].p, pts[(k + pts.length - 1) % pts.length].p);
      const d = t.map((x) => x / (len(t) || 1));
      const de = dot(d, eu);
      const dir = eu.map((x, i) => 2 * de * x - d[i]);
      crossings.push({ k, over: c.st.over, p: pts[k].p, w: c.v[3], reach: c.v[3] * 3.2, dir });
    });
    emitStrand(prims, occ, pts, crossings, { images, style: 1, gap: GAP, t0: 0, chunk: 0.5 * S, owner: owner++ });
  }

  // Pellets and rosettes where the breaks leave room.
  const step = cell * 0.12;
  const samples = surfaceLattice(shape, step).filter(dom);
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  occ.images = images;
  const RADII = [0.3, 0.24, 0.19, 0.15, 0.12, 0.095, 0.075].map((r) => r * cell);
  const minR = cell * (0.16 - 0.08 * fill);
  for (const q of samples) {
    const p = [q[0], q[1], q[2]];
    if (occ.hit(p[0], p[1], p[2], minR)) continue;
    let rf = 0;
    for (const r of RADII) if (!occ.hit(p[0], p[1], p[2], r)) {
      rf = r;
      break;
    }
    if (rf < minR) continue;
    const t = (occ.nearestTime(p[0], p[1], p[2], cell) ?? 0) + 0.05;
    const R = rf - GAP;
    occ.add(p[0], p[1], p[2], R, owner++, 0, t);
    if (R > cell * 0.17 && rnd() < 0.3 + rosettes) {
      prims.push({ type: ROSETTE, a: p, b: [1, 0, 0], R, petals: rnd() < 0.5 ? 5 : 6, layers: 2, seed: rnd(), kind: rnd() < 0.5 ? DAISY : FIVE, ta: t, tb: t + R * 4 });
    } else prims.push({ type: BEAD, a: p, R: R * 0.9, ta: t, tb: t + 0.01 });
  }
  prims.whole = !mesh.symmetric;
  return prims;
}
