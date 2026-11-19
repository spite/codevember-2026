// A gate that pops up from a slot in the plinth for its pass. Down, it lies flat in its slot, on the floor; for its pass
// its column pushes it up and it turns upright into place, pivoting on the column's top (its foot), then goes back
// down the same way. Three-free, for the design's checks too.
//
// lift: { up: the gate's frame in place (16, column-major), down: its frame lying in the slot, foot: its foot's height
// in its own frame (negative), hold, rise }, all in world space.

const smooth = (x) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

// How far through coming up or going down a gate is, |t - pass| from its pass: 0 while it is up, 1 down.
function liftProgress(lift, d) {
  return Math.min(1, Math.max(0, (d - lift.hold) / lift.rise));
}

// At x: how far down its column is (1: all the way) and how far turned toward lying flat. It rises first and turns as it
// goes, the turn finishing well after it is up.
function liftPhases(x) {
  return { fall: smooth((x - 0.3) / 0.7), turn: smooth(x / 0.8) };
}

function quatOf(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const tr = a + e + i;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(f - h) * s, (g - c) * s, (b - d) * s, 0.25 / s];
  }
  if (a > e && a > i) {
    const s = 2 * Math.sqrt(1 + a - e - i);
    return [0.25 * s, (d + b) / s, (g + c) / s, (f - h) / s];
  }
  if (e > i) {
    const s = 2 * Math.sqrt(1 + e - a - i);
    return [(d + b) / s, 0.25 * s, (h + f) / s, (g - c) / s];
  }
  const s = 2 * Math.sqrt(1 + i - a - e);
  return [(g + c) / s, (h + f) / s, 0.25 * s, (b - d) / s];
}

function slerp(p, q, t) {
  let dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
  const r = dot < 0 ? q.map((v) => -v) : q;
  dot = Math.abs(dot);
  if (dot > 0.9995) {
    const o = p.map((v, k) => v + (r[k] - v) * t);
    const l = Math.hypot(...o);
    return o.map((v) => v / l);
  }
  const th = Math.acos(dot), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return p.map((v, k) => v * wa + r[k] * wb);
}

// The gate's frame (world) at x.
function liftPose(out, lift, x) {
  const { fall, turn } = liftPhases(x);
  lift.qUp ??= quatOf(lift.up);
  lift.qDown ??= quatOf(lift.down);
  const [qx, qy, qz, qw] = slerp(lift.qUp, lift.qDown, turn);
  out.fill(0);
  out[0] = 1 - 2 * (qy * qy + qz * qz); out[1] = 2 * (qx * qy + qz * qw); out[2] = 2 * (qx * qz - qy * qw);
  out[4] = 2 * (qx * qy - qz * qw); out[5] = 1 - 2 * (qx * qx + qz * qz); out[6] = 2 * (qy * qz + qx * qw);
  out[8] = 2 * (qx * qz + qy * qw); out[9] = 2 * (qy * qz - qx * qw); out[10] = 1 - 2 * (qx * qx + qy * qy);
  out[15] = 1;
  // The foot stays on the column, which only goes up and down.
  const up = lift.up, f = lift.foot;
  const fx = up[12] + up[4] * f, fz = up[14] + up[6] * f;
  const fy0 = up[13] + up[5] * f, fy1 = lift.down[13] + lift.down[5] * f;
  out[12] = fx - out[4] * f;
  out[13] = fy0 + (fy1 - fy0) * fall - out[5] * f;
  out[14] = fz - out[6] * f;
  return out;
}

// Its foot's height at x: the top of its column.
function liftFootY(lift, x) {
  const { fall } = liftPhases(x);
  const up = lift.up, f = lift.foot;
  const fy0 = up[13] + up[5] * f, fy1 = lift.down[13] + lift.down[5] * f;
  return fy0 + (fy1 - fy0) * fall;
}

export { liftProgress, liftPose, liftFootY };
