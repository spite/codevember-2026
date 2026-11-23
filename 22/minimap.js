// Debug map: a top-down view of the labyrinth around the listener, north up. Heard cells are shaded,
// raised floors lighter, ceilingless rooms hatched; walls, sunken shapes, presences, watchers, the
// listener and where the stroll is heading and looking are drawn on top.

import { CELL } from "./world.js";

export function createMinimap(world, walker, { size = 320, range = 20 } = {}) {
  const canvas = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = size * dpr;
  Object.assign(canvas.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "8px",
    pointerEvents: "none",
    zIndex: 4,
    display: "none",
  });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const trail = [];
  const m = world.map;

  function draw(position, yaw, time) {
    const scale = (size * dpr) / (range * 2);
    const W = size * dpr;
    const sx = (x) => (x - position.x) * scale + W / 2;
    const sz = (z) => (z - position.z) * scale + W / 2;
    ctx.fillStyle = "rgba(8,8,10,0.82)";
    ctx.fillRect(0, 0, W, W);

    const i0 = Math.floor((position.x - range) / CELL), i1 = Math.floor((position.x + range) / CELL);
    const j0 = Math.floor((position.z - range) / CELL), j1 = Math.floor((position.z + range) / CELL);
    const c = CELL * scale;
    // Cells: heard or not, floor height, missing ceiling.
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const x = sx(i * CELL), z = sz(j * CELL);
        const f = m.floor(i, j);
        const heard = m.heard(i, j);
        const v = (heard ? 60 : 22) + Math.min(80, f * 30);
        ctx.fillStyle = heard ? `rgb(${v + 20},${v + 12},${v - 10})` : `rgb(${v},${v},${v + 4})`;
        ctx.fillRect(x, z, c + 0.5, c + 0.5);
        if (m.ceil(i, j) >= m.void) {
          ctx.strokeStyle = "rgba(120,140,200,0.35)";
          ctx.lineWidth = dpr;
          ctx.beginPath();
          for (let k = -1; k <= 2; k++) {
            ctx.moveTo(x + (k * c) / 2, z + c);
            ctx.lineTo(x + ((k + 2) * c) / 2, z);
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, z, c, c);
          ctx.clip();
          ctx.beginPath();
          for (let k = -1; k <= 2; k++) {
            ctx.moveTo(x + (k * c) / 2, z + c);
            ctx.lineTo(x + ((k + 2) * c) / 2, z);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    // Walls.
    ctx.strokeStyle = "rgb(225,210,150)";
    ctx.lineWidth = Math.max(1.5 * dpr, 0.2 * scale);
    ctx.lineCap = "square";
    ctx.beginPath();
    for (let i = i0 - 1; i <= i1; i++) {
      for (let j = j0 - 1; j <= j1; j++) {
        if (m.wallE(i, j)) {
          ctx.moveTo(sx((i + 1) * CELL), sz(j * CELL));
          ctx.lineTo(sx((i + 1) * CELL), sz((j + 1) * CELL));
        }
        if (m.wallS(i, j)) {
          ctx.moveTo(sx(i * CELL), sz((j + 1) * CELL));
          ctx.lineTo(sx((i + 1) * CELL), sz((j + 1) * CELL));
        }
      }
    }
    ctx.stroke();
    // Sunken shapes and presences (each drawn once).
    const drawn = new Set();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const o of m.objects(i, j)) {
          if (drawn.has(o)) continue;
          drawn.add(o);
          ctx.beginPath();
          ctx.arc(sx(o.center.x), sz(o.center.z), Math.max(2 * dpr, o.radius * scale), 0, Math.PI * 2);
          ctx.fillStyle = o.presence ? "rgba(230,70,220,0.85)" : "rgba(170,170,180,0.55)";
          ctx.fill();
        }
      }
    }
    // Watchers, facing the listener.
    for (const w of world.watchersList()) {
      const x = sx(w.feet.x), z = sz(w.feet.z);
      const a = Math.atan2(w.sin, w.cos);
      ctx.fillStyle = "rgb(235,60,50)";
      ctx.beginPath();
      ctx.arc(x, z, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(235,60,50)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, z);
      ctx.lineTo(x - Math.sin(a) * 9 * dpr, z - Math.cos(a) * 9 * dpr);
      ctx.stroke();
    }
    // The recent path.
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(last.x - position.x, last.z - position.z) > 0.3) trail.push({ x: position.x, z: position.z });
    if (trail.length > 400) trail.shift();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    trail.forEach((p, k) => (k ? ctx.lineTo(sx(p.x), sz(p.z)) : ctx.moveTo(sx(p.x), sz(p.z))));
    ctx.stroke();
    // Where the stroll is going (cyan) and looking (yellow).
    const st = walker.debugState();
    if (st.lookPoint && st.target) {
      ctx.strokeStyle = "rgba(255,220,60,0.8)";
      ctx.beginPath();
      ctx.moveTo(sx(position.x), sz(position.z));
      ctx.lineTo(sx(st.lookPoint.x), sz(st.lookPoint.z));
      ctx.stroke();
    }
    // The destination: a double ring.
    if (st.dest) {
      ctx.strokeStyle = "rgb(60,220,240)";
      ctx.lineWidth = 1.5 * dpr;
      for (const r of [6, 10]) {
        ctx.beginPath();
        ctx.arc(sx(st.dest.x), sz(st.dest.z), r * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const [p, filled] of [[st.target, true], [st.nextTarget, false]]) {
      if (!p) continue;
      ctx.strokeStyle = ctx.fillStyle = "rgb(60,220,240)";
      ctx.beginPath();
      ctx.arc(sx(p.x), sz(p.z), 4 * dpr, 0, Math.PI * 2);
      filled ? ctx.fill() : ctx.stroke();
    }
    // The listener: an arrow pointing where the view faces.
    const x = W / 2, z = W / 2;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    ctx.fillStyle = st.pausing && Math.sin(time * 12) > 0 ? "rgb(255,200,80)" : "white";
    ctx.beginPath();
    ctx.moveTo(x + fx * 10 * dpr, z + fz * 10 * dpr);
    ctx.lineTo(x - fx * 5 * dpr - fz * 6 * dpr, z - fz * 5 * dpr + fx * 6 * dpr);
    ctx.lineTo(x - fx * 5 * dpr + fz * 6 * dpr, z - fz * 5 * dpr - fx * 6 * dpr);
    ctx.closePath();
    ctx.fill();
  }

  return {
    draw,
    setVisible: (v) => (canvas.style.display = v ? "block" : "none"),
    clearTrail: () => (trail.length = 0),
  };
}
