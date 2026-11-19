import { Pendulum } from "./pendulum.js";
import { Gimbal, swingPath } from "./gimbal.js";
import { Grid, compileOutline, regionLoops } from "./field.js";
import { rasterizeSweep } from "./sweep.js";
import { rotationZ, multiply, invertRigid } from "./rigid.js";
import { posePiece, motionValue, TURNS } from "./motion.js";

// Cuts slab outlines, three-free so it runs in the worker. A batch is
//   { rig: { length, amplitude, pivot, solids, xExtent, clearance } | null, jobs: [job...] }
// and each job { bounds, cell, outline, smooth, sweep? } becomes nested loops [{ outer, holes }] as flat
// Float32Arrays of (u, v). A job's `sweep` { frame, motion, passes, thickness } cuts out, with the rig's clearance
// all round, whatever the bob and its rod sweep through the piece at each of its passes.

const _piece = new Float64Array(16);
const _inv = new Float64Array(16);
const _arm = new Float64Array(16);
const _rz = new Float64Array(16);

// Whether any solid reaches into the piece's slab (|X| <= hx, within its (u, v) bounds) at time t: the bob as a
// ball, rods as segments. `solidAt(t, s, out)` writes solid -> piece.
const _q = new Float64Array(16);
function touches(t, rig, solidAt, hx, b) {
  for (let s = 0; s < rig.solids.length; s++) {
    const solid = rig.solids[s];
    const e = solidAt(t, s, _q);
    const r = solid.radius;
    if (solid.segment) {
      const [ax, ay, az, bx, by, bz] = solid.segment;
      const pa = [e[0] * ax + e[4] * ay + e[8] * az + e[12], e[1] * ax + e[5] * ay + e[9] * az + e[13], e[2] * ax + e[6] * ay + e[10] * az + e[14]];
      const pb = [e[0] * bx + e[4] * by + e[8] * bz + e[12], e[1] * bx + e[5] * by + e[9] * bz + e[13], e[2] * bx + e[6] * by + e[10] * bz + e[14]];
      const lim = hx + solid.thick;
      if ((pa[0] > lim && pb[0] > lim) || (pa[0] < -lim && pb[0] < -lim)) continue;
      // The part of the rod inside the slab, and whether it falls within the piece's outline box.
      const t0 = Math.abs(pb[0] - pa[0]) < 1e-9 ? 0 : Math.max(0, Math.min(1, (-lim - pa[0]) / (pb[0] - pa[0])));
      const t1 = Math.abs(pb[0] - pa[0]) < 1e-9 ? 1 : Math.max(0, Math.min(1, (lim - pa[0]) / (pb[0] - pa[0])));
      const [s0, s1] = [Math.min(t0, t1), Math.max(t0, t1)];
      const v = [pa[1] + (pb[1] - pa[1]) * s0, pa[1] + (pb[1] - pa[1]) * s1], u = [pa[2] + (pb[2] - pa[2]) * s0, pa[2] + (pb[2] - pa[2]) * s1];
      if (Math.max(...u) < b[0] - lim || Math.min(...u) > b[2] + lim || Math.max(...v) < b[1] - lim || Math.min(...v) > b[3] + lim) continue;
      return true;
    }
    const [cx0, cy0, cz0] = solid.centre;
    const cx = e[0] * cx0 + e[4] * cy0 + e[8] * cz0 + e[12], cy = e[1] * cx0 + e[5] * cy0 + e[9] * cz0 + e[13], cz = e[2] * cx0 + e[6] * cy0 + e[10] * cz0 + e[14];
    if (Math.abs(cx) < hx + r && cz > b[0] - r && cz < b[2] + r && cy > b[1] - r && cy < b[3] + r) return true;
  }
  return false;
}

function sweepDistance(grid, rig, pendulum, sweep) {
  if (rig.gimbal) return sweepGimbal(grid, rig, sweep);
  const { frame, motion, passes, thickness } = sweep;
  const hx = thickness / 2 + 5e-4;
  const L = pendulum.length;
  const rIn = Math.max(0.2, L - (grid.v0 + grid.ny * grid.h));
  const extent = Math.hypot(Math.max(Math.abs(grid.u0), Math.abs(grid.u0 + grid.nx * grid.h)), Math.max(Math.abs(grid.v0), Math.abs(grid.v0 + grid.ny * grid.h)));
  const relative = (t, s, out) => {
    // The swing plane: x-y about the pivot, or turned (rig.base) for a pendulum swinging across.
    if (rig.base) multiply(_arm, rig.base, rotationZ(_rz, pendulum.angle(t)));
    else rotationZ(_arm, pendulum.angle(t), rig.pivot[0], rig.pivot[1], rig.pivot[2]);
    multiply(out, _arm, rig.solids[s].offset);
    posePiece(_piece, frame, motion, t);
    invertRigid(_inv, _piece);
    return multiply(out, _inv, out);
  };
  const seen = new Set();
  const turn = TURNS.has(motion.axis ?? "x");
  // The arm is clear of the slab once it is this far (in angle) from the piece's station.
  const reach = (hx + rig.xExtent + 0.01) / rIn;
  const station = sweep.station;
  for (const tp of passes) {
    const w = pendulum.angularVelocity(tp);
    let value = motionValue(motion, tp);
    if (turn) value = ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const key = `${Math.round(value * 1e4) % Math.round(2e4 * Math.PI)}:${Math.sign(Math.round(w * 1e3))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Out from the pass until the arm is clear on both sides; near the top of the swing it comes back within it.
    const near = (t) => Math.abs(pendulum.angle(t) - station) < reach;
    const scan = 2e-3;
    let t0 = tp, t1 = tp;
    while (near(t0 - scan) && tp - t0 < pendulum.period / 2) t0 -= scan;
    while (near(t1 + scan) && t1 - tp < pendulum.period / 2) t1 += scan;
    t0 -= scan;
    t1 += scan;
    const fastest = Math.max(Math.abs(w), Math.abs(pendulum.angularVelocity(t0)), Math.abs(pendulum.angularVelocity(t1)), 1e-3);
    // How fast the piece itself moves over the window.
    const dv = Math.abs(motionValue(motion, t1) - motionValue(motion, t0)) / (t1 - t0) + (sweep.spin ?? 0);
    const inPlane = (turn ? dv * extent : dv) + 0.03;
    const step = Math.min(1e-3 / inPlane, (hx * 0.8) / (fastest * L));
    const n = Math.min(500, Math.ceil((t1 - t0) / step) + 1);
    const times = [];
    for (let i = 0; i < n; i++) times.push(t0 + ((t1 - t0) * i) / (n - 1));
    rasterizeSweep(grid, rig.solids, times, relative, hx);
  }
  return grid.distance();
}

// The same for a gimbal: its solids hang from the upper arm, the lower arm or the bob, and each pass's window runs
// out from it for as long as any of them reaches into the piece.
function sweepGimbal(grid, rig, sweep) {
  const { gimbal } = rig;
  const { frame, motion, passes, thickness } = sweep;
  const hx = thickness / 2 + 5e-4;
  const bounds = [grid.u0, grid.v0, grid.u0 + grid.nx * grid.h, grid.v0 + grid.ny * grid.h];
  const extent = Math.hypot(Math.max(Math.abs(bounds[0]), Math.abs(bounds[2])), Math.max(Math.abs(bounds[1]), Math.abs(bounds[3])));
  const turn = TURNS.has(motion.axis ?? "x");
  const link = (t, s, out) => {
    const solid = rig.solids[s];
    if (solid.link === "upper") gimbal.upperMatrix(out, t);
    else if (solid.link === "lower") gimbal.lowerMatrix(out, t);
    else gimbal.bobMatrix(out, t);
    return multiply(out, out, solid.offset);
  };
  const relative = (t, s, out) => {
    link(t, s, out);
    posePiece(_piece, frame, motion, t);
    invertRigid(_inv, _piece);
    return multiply(out, _inv, out);
  };
  const seen = new Set();
  for (const tp of passes) {
    let value = motionValue(motion, tp);
    if (turn) value = ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const key = `${Math.round(value * 1e4) % Math.round(2e4 * Math.PI)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scan = 2e-3;
    let t0 = tp, t1 = tp;
    while (touches(t0 - scan, rig, relative, hx, bounds) && tp - t0 < gimbal.period / 2) t0 -= scan;
    while (touches(t1 + scan, rig, relative, hx, bounds) && t1 - tp < gimbal.period / 2) t1 += scan;
    t0 -= scan;
    t1 += scan;
    const v = gimbal.velocity(tp);
    const speed = Math.hypot(v[0], v[1], v[2]) + 0.1;
    const dv = Math.abs(motionValue(motion, t1) - motionValue(motion, t0)) / (t1 - t0);
    const inPlane = (turn ? dv * extent : dv) + 0.03 + speed * 0.02;
    const step = Math.min(1e-3 / inPlane, (hx * 0.8) / speed);
    const n = Math.min(600, Math.ceil((t1 - t0) / step) + 1);
    const times = [];
    for (let i = 0; i < n; i++) times.push(t0 + ((t1 - t0) * i) / (n - 1));
    rasterizeSweep(grid, rig.solids, times, relative, hx);
  }
  return grid.distance();
}

function cutJob(job, rig, pendulum) {
  const grid = new Grid(...job.bounds, job.cell);
  const dist = job.sweep ? sweepDistance(grid, rig, pendulum, job.sweep) : null;
  const values = new Float32Array(grid.nx * grid.ny);
  const clearance = rig?.clearance ?? 0;
  const outline = compileOutline(job.outline);
  for (let j = 0; j < grid.ny; j++) {
    const v = grid.v(j);
    for (let i = 0; i < grid.nx; i++) {
      const k = j * grid.nx + i;
      const o = outline(grid.u(i), v);
      values[k] = dist ? Math.max(o, clearance - dist[k]) : o;
    }
  }
  const flat = (loop) => {
    const a = new Float32Array(loop.length * 2);
    loop.forEach((p, i) => ((a[2 * i] = p[0]), (a[2 * i + 1] = p[1])));
    return a;
  };
  return regionLoops(grid, (i, j) => values[j * grid.nx + i], { smooth: job.smooth ?? 12 }).map((s) => ({
    outer: flat(s.outer),
    holes: s.holes.map(flat),
  }));
}

function cutBatch({ rig, jobs }) {
  const pendulum = rig && !rig.gimbal ? new Pendulum({ length: rig.length, amplitude: rig.amplitude }) : null;
  if (rig?.gimbal && !(rig.gimbal instanceof Gimbal)) rig = { ...rig, gimbal: swingPath(rig.gimbal) };
  return jobs.map((job) => cutJob(job, rig, pendulum));
}

export { cutBatch };
