// A meander labyrinth, after the Greek key and the thunder pattern on archaic bronzes: walkers step one unit at a
// time along a square lattice laid over the blank and turn only by right angles, always trying to turn the same way
// first. Alone, a walker winds a square spiral; hemmed in, it runs along the lines already laid, one unit off, so the
// frets interlock into a labyrinth of corridors as wide as the straps. All the walkers grow at once, then every node
// still free gets one of its own, down to a single square stud.
import { FRET, FLAT, RIBBED, rnd, rand, Occupancy, surfacePoint, radialPoint } from "../kit.js";

/*
 * opts: scale, flow (0..1: how eagerly the walk turns, from long runs to tight keys), fill (0..1: how many walkers
 * start at once, against how much is left to the last sweep).
 */
export function meander(shape, opts, kit) {
  const S = opts.scale ?? 1;
  const flow = opts.flow ?? 0.5;
  const fill = opts.fill ?? 0.7;
  const U = 0.03 * S;
  const graph = latticeGraph(shape, U);
  const { nodes } = graph;
  const occ = new Occupancy(U * 1.2, shape.bounds);
  occ.images = kit.images;
  const prims = [];
  const kind = rnd() < 0.6 ? FLAT : RIBBED;
  const used = new Uint8Array(nodes.length);
  let ownerId = 0;

  const free = (p, r, owner, s) => !occ.hit(p[0], p[1], p[2], r, owner, s, 1.01);
  const R = (v) => nodes[v].h * 0.4;

  function spawn(v, t0, maxSteps) {
    const nd = nodes[v];
    if (used[v] || !free(nd.p, R(v))) return null;
    const id = ownerId++;
    used[v] = 1;
    occ.add(nd.p[0], nd.p[1], nd.p[2], R(v), id, 0, t0);
    return { v, prev: -1, d: null, id, i: 0, c: rnd() < 0.5 ? 1 : -1, run: 0, minRun: rnd() < 0.7 ? 1 : 2, turns: 0, flipAfter: Math.floor(rand(5, 14)), start: v, t0, t: t0, maxSteps, runDir: null };
  }

  // A straight run from the run's start to node end; e: the direction it turns into there (null at a free end,
  // which gets a square cap). Joints are mitred.
  function emit(k, end, t, e) {
    const a = nodes[k.start].p;
    const b = nodes[end].p;
    const w = 0.26 * (nodes[k.start].h + nodes[end].h) * 0.5;
    const kB = e ? mitre(k.runDir, e, nodes[end].n) : 0;
    // Widths follow the lattice's spacing, heights stay level (h scales the height by the width).
    prims.push({ type: FRET, a: a.slice(), b: b.slice(), w, ext: k.kA === undefined ? w : 0, kA: k.kA ?? 0, extB: e ? 0 : w, kB, kind, ta: k.t0, tb: t, h: (0.26 * U) / w });
    k.kA = kB;
  }
  // The slope of the bisector at a joint from direction d into e (n: the normal there), as x = k y in either
  // strap's frame.
  const mitre = (d, e, n) => {
    const c = Math.max(-1, Math.min(1, d[0] * e[0] + d[1] * e[1] + d[2] * e[2]));
    const side = (n[1] * d[2] - n[2] * d[1]) * e[0] + (n[2] * d[0] - n[0] * d[2]) * e[1] + (n[0] * d[1] - n[1] * d[0]) * e[2];
    return -Math.sign(side) * Math.tan(Math.acos(c) / 2);
  };

  // The lattice neighbours of the walker's node, as turns: 0 straight on, 1 left, -1 right.
  function moves(k) {
    const nd = nodes[k.v];
    const out = [];
    for (const u of nd.nb) {
      if (u === k.prev) continue;
      const q = nodes[u].p;
      const e = [q[0] - nd.p[0], q[1] - nd.p[1], q[2] - nd.p[2]];
      const l = Math.hypot(e[0], e[1], e[2]);
      e[0] /= l, e[1] /= l, e[2] /= l;
      let a = 0;
      if (k.d) {
        const c = e[0] * k.d[0] + e[1] * k.d[1] + e[2] * k.d[2];
        if (c < -0.5) continue;
        if (c < 0.6) {
          const n = nd.n;
          const side = [n[1] * k.d[2] - n[2] * k.d[1], n[2] * k.d[0] - n[0] * k.d[2], n[0] * k.d[1] - n[1] * k.d[0]];
          a = side[0] * e[0] + side[1] * e[1] + side[2] * e[2] > 0 ? 1 : -1;
        }
      } else a = out.length === 0 ? 0 : rnd() < 0.5 ? 1 : -1;
      out.push({ u, a, e });
    }
    return out;
  }

  // One unit on, turning first if it can; false once boxed in.
  function advance(k, t) {
    if (k.i >= k.maxSteps) return false;
    const turnFirst = k.run >= k.minRun && rnd() < 0.45 + 0.5 * flow;
    const pref = turnFirst ? [k.c, 0, -k.c] : [0, k.c, -k.c];
    const ms = moves(k).sort((x, y) => pref.indexOf(x.a) - pref.indexOf(y.a));
    for (const m of ms) {
      if (used[m.u]) continue;
      const p = nodes[m.u].p;
      const pv = nodes[k.v].p;
      const mid = [(p[0] + pv[0]) / 2, (p[1] + pv[1]) / 2, (p[2] + pv[2]) / 2];
      if (!free(mid, R(k.v), k.id, k.i + 0.5) || !free(p, R(m.u), k.id, k.i + 1)) continue;
      // A turn, or a bend in the blank itself (the box's rounded edges), closes the straight run.
      const bend = k.runDir && k.runDir[0] * m.e[0] + k.runDir[1] * m.e[1] + k.runDir[2] * m.e[2] < 0.985;
      if (k.run > 0 && (m.a !== 0 || bend)) {
        emit(k, k.v, t, m.e);
        k.start = k.v;
        k.t0 = t;
        k.run = 0;
      }
      if (k.run === 0) k.runDir = m.e;
      if (m.a !== 0 && k.d && ++k.turns >= k.flipAfter) (k.c = -k.c), (k.turns = 0), (k.flipAfter = Math.floor(rand(5, 14)));
      used[m.u] = 1;
      occ.add(mid[0], mid[1], mid[2], R(k.v), k.id, k.i + 0.5, t + 0.5);
      occ.add(p[0], p[1], p[2], R(m.u), k.id, k.i + 1, t + 1);
      k.prev = k.v;
      k.v = m.u;
      k.d = m.e;
      k.i++;
      k.run++;
      k.t = t + 1;
      return true;
    }
    return false;
  }

  function finish(k) {
    if (k.run > 0) emit(k, k.v, k.t);
    else if (k.i === 0) {
      // Boxed in from the start: a square stud, square to the lattice.
      const nd = nodes[k.v];
      const w = 0.26 * nd.h;
      const n = nd.n;
      const q = nd.nb.length ? nodes[nd.nb[0]].p : null;
      const e = q ? [q[0] - nd.p[0], q[1] - nd.p[1], q[2] - nd.p[2]] : Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [0, -n[2], n[1]];
      prims.push({ type: FRET, a: nd.p.slice(), b: nd.p.map((x, j) => x + e[j] * 1e-4), w, ext: w, kind: FLAT, ta: k.t, tb: k.t + 1, h: (0.26 * U) / w });
    }
  }

  // Seeds spread over the blank, all walking at once, starting a little apart in time.
  const spacing = U * (14 - 7 * fill);
  const count = Math.round(shape.area / (spacing * spacing));
  const active = [];
  const seedOcc = new Occupancy(spacing, shape.bounds);
  seedOcc.images = kit.images;
  for (let n = 0, tries = 0; n < count && tries < count * 5; tries++) {
    const q = surfacePoint(shape);
    if (seedOcc.hit(q[0], q[1], q[2], spacing * 0.5)) continue;
    const v = graph.nearest(q);
    const k = v >= 0 && spawn(v, Math.floor(rand(0, 12)), Math.floor(rand(40, 260)));
    if (k) active.push(k), n++, seedOcc.add(q[0], q[1], q[2], 0, 0, 0, 0);
  }
  let tick = 0;
  for (; active.length; tick++) {
    for (let j = active.length - 1; j >= 0; j--) {
      const k = active[j];
      if (k.t > tick) continue;
      if (!advance(k, tick)) finish(k), active.splice(j, 1);
    }
  }

  // Every node still free starts a walker of its own, timed from the lines around it.
  const order = nodes.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const v of order) {
    if (used[v]) continue;
    const p = nodes[v].p;
    const t0 = (occ.nearestTime(p[0], p[1], p[2], U * 3) ?? tick) + 1;
    const k = spawn(v, t0, 400);
    if (!k) continue;
    while (advance(k, k.t));
    finish(k);
  }
  return prims;
}

// A square lattice over the blank, about U apart: a blank's own quad grid or surface nets, the torus by its two
// angles, anything else by a cube projected onto it (equal-angle on round shapes, so the lines are great circles on the sphere; each cube corner is a node
// with three neighbours).
export function latticeGraph(shape, U) {
  const nodes = [];
  if (shape.quadGrid) {
    const { pos, quads } = shape.quadGrid(U);
    const nb = Array.from({ length: pos.length / 3 }, () => new Set());
    for (const f of quads)
      for (let k = 0; k < 4; k++) nb[f[k]].add(f[(k + 1) % 4]), nb[f[(k + 1) % 4]].add(f[k]);
    for (let i = 0; i < nb.length; i++) {
      const q = shape.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      nodes.push({ p: [q[0], q[1], q[2]], n: [q[3], q[4], q[5]], nb: [...nb[i]], h: 0 });
    }
  } else if (shape.R !== undefined && shape.r !== undefined && shape.h === undefined) {
    const NT = Math.max(8, Math.round((2 * Math.PI * shape.R) / U));
    const NP = Math.max(4, Math.round((2 * Math.PI * shape.r) / U));
    for (let i = 0; i < NT; i++)
      for (let j = 0; j < NP; j++) {
        const th = (2 * Math.PI * i) / NT;
        const ph = (2 * Math.PI * j) / NP;
        const rr = shape.R + shape.r * Math.cos(ph);
        const q = shape.project(rr * Math.cos(th), shape.r * Math.sin(ph), rr * Math.sin(th));
        const nb = [((i + 1) % NT) * NP + j, ((i + NT - 1) % NT) * NP + j, i * NP + ((j + 1) % NP), i * NP + ((j + NP - 1) % NP)];
        nodes.push({ p: [q[0], q[1], q[2]], n: [q[3], q[4], q[5]], nb, h: 0 });
      }
  } else {
    const box = shape.h !== undefined;
    const b = shape.bounds;
    const M = Math.max(4, Math.round((box ? shape.h : (Math.PI / 4) * Math.max(...b)) / U));
    const map = (c) => (box ? c / M : Math.tan(((Math.PI / 4) * c) / M));
    const index = new Map();
    const key = (x, y, z) => x + "," + y + "," + z;
    const cells = [];
    for (let x = -M; x <= M; x++)
      for (let y = -M; y <= M; y++)
        for (let z = -M; z <= M; z++) {
          if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== M) continue;
          let d = [map(x), map(y), map(z)];
          if (box) d = d.map((v) => v * shape.h);
          else {
            const l = Math.hypot(d[0], d[1], d[2]);
            d = d.map((v, k) => (v / l) * b[k] * 1.05);
            if (shape.radial) d = radialPoint(shape, d);
          }
          const q = shape.project(d[0], d[1], d[2]);
          index.set(key(x, y, z), nodes.length);
          cells.push([x, y, z]);
          nodes.push({ p: [q[0], q[1], q[2]], n: [q[3], q[4], q[5]], nb: [], h: 0 });
        }
    cells.forEach(([x, y, z], i) => {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const j = index.get(key(x + dx, y + dy, z + dz));
        if (j !== undefined) nodes[i].nb.push(j);
      }
    });
  }
  // Links stretched far past the spacing (rays grazing a lobe) would lay oversized straps: they are cut.
  for (const nd of nodes) nd.nb = nd.nb.filter((u) => Math.hypot(nodes[u].p[0] - nd.p[0], nodes[u].p[1] - nd.p[1], nodes[u].p[2] - nd.p[2]) < U * 2.2);
  for (const nd of nodes) {
    if (!nd.nb.length) {
      nd.h = U;
      continue;
    }
    let s = 0;
    for (const u of nd.nb) s += Math.hypot(nodes[u].p[0] - nd.p[0], nodes[u].p[1] - nd.p[1], nodes[u].p[2] - nd.p[2]);
    nd.h = s / nd.nb.length;
  }
  // Nearest node to a point, through a coarse hash.
  const hc = U * 2;
  const hash = new Map();
  const hk = (p) => Math.floor(p[0] / hc) + "," + Math.floor(p[1] / hc) + "," + Math.floor(p[2] / hc);
  nodes.forEach((nd, i) => {
    const k = hk(nd.p);
    (hash.get(k) ?? hash.set(k, []).get(k)).push(i);
  });
  function nearest(p) {
    let best = -1;
    let bd = Infinity;
    const [cx, cy, cz] = p.map((v) => Math.floor(v / hc));
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let z = cz - 1; z <= cz + 1; z++)
          for (const i of hash.get(x + "," + y + "," + z) ?? []) {
            const d = (nodes[i].p[0] - p[0]) ** 2 + (nodes[i].p[1] - p[1]) ** 2 + (nodes[i].p[2] - p[2]) ** 2;
            if (d < bd) (bd = d), (best = i);
          }
    return best;
  }
  return { nodes, nearest };
}
