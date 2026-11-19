import { Pendulum } from "./pendulum.js";

// Pendulums swinging across the main one's plane, one either side of the bottom of its arc, in step with it: each
// crosses the main plane as the main bob passes the bottom, and the main bob then passes just behind it. Same period,
// smaller swing, so each is at rest at the top of its swing whenever the main one is.

function segmentPointDistance(ax, ay, az, bx, by, bz, px, py, pz) {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / (ex * ex + ey * ey + ez * ez || 1)));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t, pz - az - ez * t);
}

// Closest approach over a period between the main arm and a crosser at `x` (both bobs, both rods), as a gap.
function closest(main, bob, cross) {
  const { pendulum, pivot } = main;
  const L = pendulum.length;
  let least = Infinity;
  const T = pendulum.period;
  for (let t = 0; t < T; t += 0.002) {
    const th = main.pendulum.angle(t);
    const mx = pivot[0] + L * Math.sin(th), my = pivot[1] - L * Math.cos(th);
    const ph = cross.side * cross.pendulum.angle(t);
    const qx = cross.x, qy = cross.pivot[1] - cross.length * Math.cos(ph), qz = cross.length * Math.sin(ph);
    // Main bob: a disc square to its path (radius R, half-thickness h); crosser: a ball.
    const dx = qx - mx, dy = qy - my, dz = qz;
    const nx = Math.cos(th), ny = Math.sin(th);
    const along = Math.abs(dx * nx + dy * ny) - bob.thickness / 2;
    const ix = dx - (dx * nx + dy * ny) * nx, iy = dy - (dx * nx + dy * ny) * ny;
    const radial = Math.max(0, Math.hypot(ix, iy, dz) - bob.radius);
    const bobs = Math.hypot(Math.max(0, along), radial) - cross.radius;
    // Main rod against the ball; the crosser's rod against the main bob (as a ball round it).
    const rod = segmentPointDistance(pivot[0], pivot[1], 0, mx, my, 0, qx, qy, qz) - cross.radius - 0.01;
    const rod2 = segmentPointDistance(cross.x, cross.pivot[1], 0, qx, qy, qz, mx, my, 0) - bob.radius - 0.006;
    least = Math.min(least, bobs, rod, rod2);
  }
  return least;
}

// The crossers for a main pendulum and bob, missing it by `gap` at their closest, or null if they can't.
function designCrossing(random, pendulum, bob, { gap = 0.025, pivot, swing = [16, 26] }) {
  const T = pendulum.period;
  const L = pendulum.length;
  const amplitude = ((swing[0] + random() * (swing[1] - swing[0])) * Math.PI) / 180;
  const length = Pendulum.lengthFor(T, amplitude);
  const cp = new Pendulum({ length, amplitude });
  const radius = 0.075 + random() * 0.02;
  // The two swing in opposition: as one comes forward the other goes back, scissoring past each other.
  const r = random() < 0.5 ? 1 : -1;
  const sides = [r, r];
  const z = (t) => length * Math.sin(cp.angle(t));
  // Crossers where the main bob passes once the crosser is `zMiss` to the side (it crossed at the bottom).
  const place = (zMiss) => {
    let a = 0, b = T / 4;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      if (z(m) < zMiss) a = m;
      else b = m;
    }
    const station = pendulum.angle(b);
    const x = L * Math.sin(station);
    // Its bottom is on the main path; its pivot is higher than the main rod ever reaches over x.
    const top = pivot[1] - L * Math.cos(station) + length;
    const crossers = [1, -1].map((s, i) => ({ x: s * x, side: s * sides[i], pivot: [s * x, top, 0], length, amplitude, radius, pendulum: cp }));
    const least = Math.min(...crossers.map((c) => closest({ pendulum, pivot }, bob, c)));
    return { station, crossers, least };
  };
  let lo = bob.radius + radius, hi = z(T / 4) - 0.04;
  if (hi <= lo) return null;
  for (let i = 0; i < 16; i++) {
    const m = (lo + hi) / 2;
    if (place(m).least < gap) lo = m;
    else hi = m;
  }
  const best = place(hi);
  if (best.least < gap * 0.8 || best.station > pendulum.amplitude - 0.12) return null;
  return {
    station: best.station,
    least: best.least,
    crossers: best.crossers.map(({ x, side, pivot, length, amplitude, radius }) => ({ x, side, pivot, length, amplitude, radius })),
  };
}

// The same crossers moved to cross the main path at `station` (either side), or null if they'd come within `gap`.
function crossingAt(pendulum, bob, crossing, station, { gap = 0.025, pivot }) {
  const L = pendulum.length;
  const { length, amplitude, radius } = crossing.crossers[0];
  const cp = new Pendulum({ length, amplitude });
  const x = L * Math.sin(station);
  const top = pivot[1] - L * Math.cos(station) + length;
  const crossers = crossing.crossers.map((c, i) => {
    const s = i ? -1 : 1;
    return { x: s * x, side: c.side, pivot: [s * x, top, 0], length, amplitude, radius };
  });
  const least = Math.min(...crossers.map((c) => closest({ pendulum, pivot }, bob, { ...c, pendulum: cp })));
  return least < gap ? null : { station, least, crossers };
}

export { designCrossing, crossingAt };
