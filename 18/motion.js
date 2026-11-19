import { rotationX, rotationY, rotationZ, translation, multiply } from "./rigid.js";

// How a gate's moving piece is posed over (pendulum) time, as plain data both threads evaluate the same way:
//   steady:  turns or slides at a constant rate, so each alignment is a coincidence of steady motions.
//   indexed: holds still through every pass and moves between them, either as a clockwork tick right after the bob
//            clears ("tick") or as a late dash that lands just before it arrives ("burst").
//   glide:   turns at a constant rate between passes, landing where `steps` say at each.
//   pulse:   opens for each pass and shuts in between, quickly. wave: the same, swinging smoothly the whole time.
//   keys:    any number of passes a period (two pendulums'), each with its own hold, turning steps[i] in the gap
//            after pass i, eased like a coin, landing just before the next.

function easeOutBack(x, c = 1.4) {
  const y = x - 1;
  return 1 + (c + 1) * y * y * y + c * y * y;
}

function easeInOut(x) {
  return x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function indexedValue(m, t) {
  const { passes, period, steps, step, hold, move, style, v0, drift = 0, delay = 0 } = m;
  // One pass a period (a gimbal's gates) or two (a plane swing's): a move in each gap after a pass.
  const single = passes.length === 1;
  const perCycle = (single ? steps[0] : steps[0] + steps[1]) * step;
  const c = Math.floor((t - passes[0]) / period);
  const tc = t - c * period;
  const base = v0 + c * perCycle;
  let from, to, ta, tb;
  if (single) [from, to, ta, tb] = [base, base + perCycle, passes[0], passes[0] + period];
  else if (tc < passes[1]) [from, to, ta, tb] = [base, base + steps[0] * step, passes[0], passes[1]];
  else [from, to, ta, tb] = [base + steps[0] * step, base + perCycle, passes[1], passes[0] + period];
  // A gap with no steps holds still throughout (no tick, no wind-up).
  if (to === from) return from;
  if (style === "tick") {
    const start = ta + hold + delay;
    const x = Math.min(1, Math.max(0, (tc - start) / move));
    return from + (to - from) * easeOutBack(x);
  }
  // Burst: drifts back a little after the pass, then dashes over and lands as the next one comes.
  const end = tb - hold;
  const start = end - move;
  if (tc < start) return from - drift * smoothstep(ta + hold, start, tc);
  const x = Math.min(1, (tc - start) / move);
  // Spin: the same timing, eased like a coin turning rather than a dash.
  const eased = style === "spin" ? 0.5 - 0.5 * Math.cos(Math.PI * x) : easeInOut(x);
  return from - drift + (to - from + drift) * eased;
}

// Open through every pass, closed in between: rises over `rise` seconds before the hold and falls after it.
function pulseValue(m, t) {
  const { passes, period, hold, rise, closed, open } = m;
  let near = Infinity;
  for (const p of passes) {
    const d = ((((t - p) % period) + period * 1.5) % period) - period / 2;
    near = Math.min(near, Math.abs(d));
  }
  const x = 1 - smoothstep(hold, hold + rise, near);
  return closed + (open - closed) * x;
}

// The gap between passes that t falls in: [time in the cycle, gap start, gap end, index of the gap].
function gapAt(passes, period, t) {
  const tc = ((((t - passes[0]) % period) + period) % period) + passes[0];
  if (passes.length === 1) return [tc, passes[0], passes[0] + period, 0];
  return tc < passes[1] ? [tc, passes[0], passes[1], 0] : [tc, passes[1], passes[0] + period, 1];
}

function glideValue(m, t) {
  const { passes, period, steps, step, v0 } = m;
  const single = passes.length === 1;
  const perCycle = (single ? steps[0] : steps[0] + steps[1]) * step;
  const [tc, ta, tb, i] = gapAt(passes, period, t);
  const base = v0 + Math.floor((t - passes[0]) / period) * perCycle + (i ? steps[0] * step : 0);
  return base + (steps[i] * step * (tc - ta)) / (tb - ta);
}

// Open while the bob is within `hold` of a pass, swinging smoothly shut and back over each gap between; through a gap
// too short for that, it stays open.
function waveValue(m, t) {
  const { passes, period, hold, closed, open } = m;
  const [tc, ta, tb] = gapAt(passes, period, t);
  const span = tb - ta - 2 * hold;
  if (span < 0.35) return open;
  const x = Math.min(1, Math.max(0, (tc - ta - hold) / span));
  return closed + (open - closed) * (0.5 + 0.5 * Math.cos(2 * Math.PI * x));
}

function keysValue(m, t) {
  const { passes, period, steps, step, holds, move, v0 } = m;
  const n = passes.length;
  const perCycle = steps.reduce((a, b) => a + b, 0) * step;
  const c = Math.floor((t - passes[0]) / period);
  const tc = t - c * period;
  let i = n - 1;
  for (let k = 0; k < n - 1; k++) {
    if (tc < passes[k + 1]) {
      i = k;
      break;
    }
  }
  let before = 0;
  for (let k = 0; k < i; k++) before += steps[k];
  const from = v0 + c * perCycle + before * step;
  if (!steps[i]) return from;
  const end = (i === n - 1 ? passes[0] + period : passes[i + 1]) - holds[(i + 1) % n];
  const x = Math.min(1, Math.max(0, (tc - end + move) / move));
  return from + steps[i] * step * (0.5 - 0.5 * Math.cos(Math.PI * x));
}

function motionValue(m, t) {
  if (m.type === "steady") return m.phase + m.rate * t + (m.wobble ? m.wobble * Math.sin((2 * Math.PI * (t - m.mid)) / m.period) : 0);
  if (m.type === "indexed") return indexedValue(m, t);
  if (m.type === "pulse") return pulseValue(m, t);
  if (m.type === "glide") return glideValue(m, t);
  if (m.type === "wave") return waveValue(m, t);
  if (m.type === "keys") return keysValue(m, t);
  return m.value ?? 0;
}

// Axes a piece moves along: "x" turns it in its own plane, "rz" and "ry" turn it about its Z and Y, "z" and "y" slide it.
const TURNS = new Set(["x", "rz", "ry"]);

const _m = new Float64Array(16);
// The piece's world matrix: its frame, then moved by the motion's value.
function posePiece(out, frame, motion, t) {
  const v = motionValue(motion, t);
  const axis = motion.axis ?? "x";
  if (axis === "z") translation(_m, 0, 0, v);
  else if (axis === "y") translation(_m, 0, v, 0);
  else if (axis === "rz") rotationZ(_m, v);
  else if (axis === "ry") rotationY(_m, v);
  else rotationX(_m, v);
  return multiply(out, frame, _m);
}

export { motionValue, posePiece, easeOutBack, easeInOut, smoothstep, TURNS };
