// First-person walking in the gallery: drag to look, WASD/arrows to walk, and on touch, press and hold
// to walk forward. Kept at eye height, inside the room and clear of the sculptures. When nobody has
// touched it for a while it strolls the corridors on its own (kiosk mode), walking like a person.

import { Vector3, Euler } from "three";
import { CELL } from "./world.js";

const EYE = 1.6;
const SPEED = 1.8;

export function createWalker(camera, dom, room) {
  const pos = new Vector3(0.4, EYE, 5.2);
  let yaw = 0;
  let pitch = -0.08;
  const keys = new Set();
  let drag = null;
  let holdWalk = false;
  let holdTimer = 0;
  let idle = 0;
  const euler = new Euler(0, 0, 0, "YXZ");
  const fwd = new Vector3();
  const right = new Vector3();
  const look = new Vector3();
  const p = new Vector3();

  // Passive (just watching): input is ignored and the stroll never waits.
  let passive = false;
  const touched = () => (idle = 0);
  addEventListener("keydown", (e) => {
    if (passive || e.target instanceof HTMLInputElement) return;
    keys.add(e.code);
    touched();
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  // Keys and drags released while the page is away never send their up events.
  const release = () => {
    keys.clear();
    clearTimeout(holdTimer);
    holdWalk = false;
    drag = null;
  };
  addEventListener("blur", release);
  document.addEventListener("visibilitychange", release);
  addEventListener("pointercancel", release);
  // Pointer lock (mouse only): the first click captures the mouse without calling; then moving it looks
  // around and every click calls. Esc lets go.
  let locked = false;
  let lockClick = false;
  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === dom;
    drag = null;
  });
  document.addEventListener("pointerlockerror", () => (lockClick = false));
  dom.addEventListener("pointerdown", (e) => {
    if (passive) return;
    if (e.pointerType === "mouse" && e.button === 0 && !locked && dom.requestPointerLock) {
      lockClick = true;
      Promise.resolve(dom.requestPointerLock()).catch(() => (lockClick = false));
    }
    drag = { x: e.clientX, y: e.clientY, moved: 0, touch: e.pointerType === "touch" };
    try {
      dom.setPointerCapture?.(e.pointerId);
    } catch {}
    touched();
    if (drag.touch) holdTimer = setTimeout(() => (holdWalk = true), 350);
  });
  addEventListener("pointermove", (e) => {
    if (locked) {
      yaw -= e.movementX * 0.0025;
      pitch = Math.max(-1.2, Math.min(1.2, pitch - e.movementY * 0.0025));
      touched();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    yaw -= dx * 0.004;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * 0.004));
    if (drag.moved > 8) clearTimeout(holdTimer);
    touched();
  });
  addEventListener("pointerup", () => {
    clearTimeout(holdTimer);
    holdWalk = false;
    drag = null;
  });

  // A click is a press that didn't turn the view (with the mouse locked, any press but the one that locked it).
  const wasClick = () => {
    if (lockClick) {
      lockClick = false;
      return false;
    }
    return locked || (!holdWalk && (!drag || drag.moved < 6));
  };

  // Stroll: wander the corridors cell by cell (see world.wander) like a person would: easing in and out
  // of speed, slowing into turns and looking toward the next opening before reaching it, and now and
  // then stopping at a junction to look left and right (that is when it calls out).
  let target = null;
  let nextTarget = null;
  let heading = [0, -1];
  let floorY = 0;
  let speed = 0;
  let stride = 0;
  let side = 1;
  let breath = 0;
  let pause = null;
  let wobble = 0;
  let yawRate = 0;
  let headYaw = 0;
  let headPitch = 0;
  let headYawVel = 0;
  let headPitchVel = 0;
  let glance = null;
  let glanceIn = Infinity;
  // The route: cells to a destination, their waypoints (off toward the walls) and headings; k is the next one.
  let route = null;
  let straight = 0;
  let sinceDecision = 99;
  let stall = 0;
  let orbit = null;
  let orbitCooldown = 0;
  let lookCheck = 0;
  let lookPoint = new Vector3();
  let lookAt = 0;
  let bestD = Infinity;
  // Keeping close to the walls: targets sit HUG metres off the cell's centre toward a wall beside the path,
  // on the same side as before when there is one.
  const HUG = 0.6;
  let hugSide = 1;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // The body turns like a body (a critically damped turn rate) and always the short way round; only a turn of
  // nearly half a circle, where both ways are the same, keeps going the way it already turns.
  // The most open direction near `around` (a world yaw), from the eyes: 17 rays across ±spread, the longest
  // free distance winning, weighted toward `around` (width: how strongly). Keeps looks off walls.
  const _eye = new Vector3();
  const _ray = new Vector3();
  function openYaw(around, spread, width) {
    let best = around, bestScore = -1;
    _eye.set(pos.x, pos.y, pos.z);
    for (let k = -8; k <= 8; k++) {
      const a = around + (k / 8) * spread;
      _ray.set(-Math.sin(a), 0, -Math.cos(a));
      const hit = room.see(_eye, _ray, 14);
      const score = Math.min(hit ? hit.distance : 14, 12) * Math.exp(-(((a - around) / width) ** 2));
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }

  function turnBody(goal, dt) {
    let dy = wrap(goal - yaw);
    if (Math.abs(dy) > Math.PI - 0.15 && yawRate !== 0) dy = Math.sign(yawRate) * Math.abs(dy);
    yawRate += (dy * 2.6 - yawRate * 3.2) * dt;
    yawRate = Math.max(-0.9, Math.min(0.9, yawRate));
    yaw += yawRate * dt;
  }
  const wallsAt = (p) => {
    const open = room.openings(p);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => !open.some(([c, d]) => c === a && d === b));
  };
  function hugWall(t, [hi, hj]) {
    const walls = wallsAt(t);
    for (const s of [hugSide, -hugSide]) {
      const di = -hj * s, dj = hi * s;
      if (walls.some(([a, b]) => a === di && b === dj)) {
        hugSide = s;
        t.x += di * HUG;
        t.z += dj * HUG;
        return;
      }
    }
  }
  const STEP = 0.72;
  const events = { steps: [], call: false, breath: 0, inhale: false, moving: 0 };

  // A route from here: waypoints keep to a wall beside the path, and a corner is taken wide, through its
  // outer corner, after which it keeps to that outer wall.
  function replan(random, avoid = null) {
    stall = 0;
    bestD = Infinity;
    let r = room.plan(pos, heading, random, avoid);
    // Nothing to plan toward: one step the old way.
    if (!r || !r.cells.length) {
      const w = room.wander(pos, heading, random);
      if (w) r = { from: [Math.floor(pos.x / CELL), Math.floor(pos.z / CELL)], cells: [[Math.floor(w.target.x / CELL), Math.floor(w.target.z / CELL)]] };
    }
    if (!r || !r.cells.length) {
      route = null;
      return;
    }
    const points = [], headings = [];
    let prev = r.from;
    r.cells.forEach((c, k) => {
      const hin = [c[0] - prev[0], c[1] - prev[1]];
      const next = r.cells[k + 1];
      const hout = next ? [next[0] - c[0], next[1] - c[1]] : hin;
      const t = new Vector3((c[0] + 0.5) * CELL, 0, (c[1] + 0.5) * CELL);
      if (hout[0] !== hin[0] || hout[1] !== hin[1]) {
        const walls = wallsAt(t);
        const has = (a, b) => walls.some(([x, y]) => x === a && y === b);
        if (has(hin[0], hin[1])) t.add(new Vector3(hin[0] * HUG, 0, hin[1] * HUG));
        if (has(-hout[0], -hout[1])) t.add(new Vector3(-hout[0] * HUG, 0, -hout[1] * HUG));
        hugSide = -hout[1] === hin[0] && hout[0] === hin[1] ? 1 : -1;
      } else hugWall(t, hin);
      points.push(t);
      headings.push(hin);
      prev = c;
    });
    route = { cells: r.cells, points, headings, k: 0 };
  }

  // A stop at a fork or room: back to a wall if one is within a small turn, then a look down each way out
  // (left to right, not the way it came), calling as it starts; the route is chosen when it's done.
  function decide(ways, random, weirdness) {
    let back = null;
    const ci = Math.floor(pos.x / CELL), cj = Math.floor(pos.z / CELL);
    for (const [wi, wj] of wallsAt(pos)) {
      const face = Math.atan2(wi, wj);
      const turn = Math.abs(wrap(face - yaw));
      if (turn < 1.3 && (!back || turn < back.turn)) {
        const point = new Vector3(wi ? (ci + 0.5) * CELL + wi * HUG : pos.x, 0, wj ? (cj + 0.5) * CELL + wj * HUG : pos.z);
        back = { yaw: face, turn, point };
      }
    }
    const base = back ? back.yaw : yaw;
    const relative = ([di, dj]) => wrap(Math.atan2(-di, -dj) - base);
    const options = ways.filter(([di, dj]) => !(di === -heading[0] && dj === -heading[1])).map(relative).filter((a) => Math.abs(a) < 1.9);
    options.sort((a, b) => b - a);
    const glances = [{ yaw: 0, pitch: 0, hold: back ? 0.3 + back.turn * 0.9 : 0.3 }];
    for (const a of options) glances.push({ yaw: Math.max(-1.6, Math.min(1.6, wrap(openYaw(base + a, 0.35, 0.4) - base))), pitch: (random() - 0.5) * 0.1, hold: (0.7 + random() * 0.4) * (1 - 0.2 * weirdness) });
    pause = { t: 0, glances, length: glances.reduce((a, x) => a + x.hold, 0), called: false, back, base };
  }

  // weirdness 0..1 quickens the breath.
  // speedScale speeds up walking with the keys (the debug view uses it to get around quickly).
  function setPassive(v) {
    passive = v;
    keys.clear();
    drag = null;
    if (v && document.pointerLockElement === dom) document.exitPointerLock();
  }

  function update(dt, { autoStroll = false, strollSpeed = 1.1, random = Math.random, weirdness = 0, speedScale = 1 } = {}) {
    idle = passive ? Math.max(idle + dt, 99) : idle + dt;
    events.steps.length = 0;
    events.call = false;
    events.inhale = false;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(-fwd.z, 0, fwd.x);
    let mx = 0;
    let mz = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp") || holdWalk) mz += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) mz -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
    let lookYaw = 0;
    let lookPitch = 0;
    let headRate = 2.2;
    let moved = 0;
    if (mx || mz) {
      target = null;
      pause = null;
      speed += (SPEED * 0.75 * speedScale - speed) * (1 - Math.exp(-dt * 4));
      look.set(0, 0, 0).addScaledVector(fwd, mz).addScaledVector(right, mx).normalize();
      p.copy(pos).addScaledVector(look, speed * dt);
      floorY = room.collide(p, 0.35);
      moved = Math.hypot(p.x - pos.x, p.z - pos.z);
      pos.x = p.x;
      pos.z = p.z;
    } else if (autoStroll && idle > 6) {
      if (pause) {
        // At a fork or in a room: back to a wall if it's close by, a call, a look down each way, then decide.
        pause.t += dt;
        let acc = 0;
        let g = pause.glances[pause.glances.length - 1];
        for (const x of pause.glances) {
          acc += x.hold;
          if (pause.t < acc) {
            g = x;
            break;
          }
        }
        // Backing up against a wall first, turning so the wall is behind.
        const b = pause.back;
        if (b) {
          look.set(b.point.x - pos.x, 0, b.point.z - pos.z);
          const d = look.length();
          if (d > 0.02) {
            p.copy(pos).addScaledVector(look.divideScalar(d), Math.min(d, 0.45 * dt));
            floorY = room.collide(p, 0.35);
            moved = Math.hypot(p.x - pos.x, p.z - pos.z);
            pos.x = p.x;
            pos.z = p.z;
          }
          turnBody(b.yaw, dt);
        }
        lookYaw = Math.max(-1.6, Math.min(1.6, wrap(pause.base + g.yaw - yaw)));
        lookPitch = g.pitch;
        headRate = 3.3;
        if (!pause.called && pause.t > (pause.back ? pause.glances[0].hold : 0.2)) {
          pause.called = true;
          events.call = true;
        }
        speed += (0 - speed) * (1 - Math.exp(-dt * 5));
        if (pause.t >= pause.length) {
          // Decided: a destination from what it now knows, and maybe a look back as it sets off.
          pause = null;
          sinceDecision = 0;
          replan(random);
          if (random() < 0.6) glanceIn = 0.8;
        }
      } else if (orbit) {
        // Circling a sculpture: slower, the head on it, calling out halfway round.
        orbit.t += dt;
        const k = Math.min(1, orbit.t / orbit.length);
        const ease = k * k * (3 - 2 * k);
        const a = orbit.a0 + orbit.sweep * ease;
        const goal = new Vector3(orbit.center.x + Math.cos(a) * orbit.r, 0, orbit.center.z + Math.sin(a) * orbit.r);
        look.set(goal.x - pos.x, 0, goal.z - pos.z);
        const d = look.length();
        if (d > 1e-4) look.divideScalar(d);
        speed += (0.55 - speed) * (1 - Math.exp(-dt * 2));
        p.copy(pos).addScaledVector(look, Math.min(d, speed * dt * 1.5));
        floorY = room.collide(p, 0.35);
        moved = Math.hypot(p.x - pos.x, p.z - pos.z);
        pos.x = p.x;
        pos.z = p.z;
        // Body turns along the path; the head turns to the sculpture.
        const along = Math.atan2(-look.x, -look.z);
        turnBody(along, dt);
        const toC = Math.atan2(-(orbit.center.x - pos.x), -(orbit.center.z - pos.z));
        lookYaw = Math.max(-1.5, Math.min(1.5, Math.atan2(Math.sin(toC - yaw), Math.cos(toC - yaw))));
        lookPitch = -0.12;
        lookPoint = orbit.center;
        if (!orbit.called && k > 0.5) {
          orbit.called = true;
          events.call = true;
        }
        if (k >= 1) {
          orbit = null;
          target = null;
          nextTarget = null;
          route = null;
          orbitCooldown = 12;
        }
      } else {
        // Stuck (a shape in the way, a ledge): after a second without getting closer, plan around that cell.
        if (target) {
          const d = Math.hypot(target.x - pos.x, target.z - pos.z);
          if (d < bestD - 0.03) {
            bestD = d;
            stall = 0;
          } else stall += dt;
        }
        if (route && stall > 1.1) {
          const c = route.cells[Math.min(route.k, route.cells.length - 1)];
          replan(random, `${c[0]},${c[1]}`);
        }
        if (!route || route.k >= route.cells.length) replan(random);
        if (route && Math.hypot(route.points[route.k].x - pos.x, route.points[route.k].z - pos.z) < 0.6) {
          // Into the route's next cell.
          const h = route.headings[route.k];
          straight = h[0] === heading[0] && h[1] === heading[1] ? straight + 1 : 0;
          heading = h;
          route.k++;
          sinceDecision++;
          stall = 0;
          bestD = Infinity;
          // Well into a long corridor: sometimes a look back over the shoulder.
          if (straight === 4 && random() < 0.5) glanceIn = 0;
          const ways = room.openings(pos);
          if (ways.length >= 3 && sinceDecision >= 3 && random() < 0.75) decide(ways, random, weirdness);
          else if (route.k >= route.cells.length) replan(random);
        }
        target = route && !pause ? route.points[route.k] : null;
        nextTarget = target && route.k + 1 < route.points.length ? { target: route.points[route.k + 1], heading: route.headings[route.k + 1] } : null;
        orbitCooldown -= dt;
        if (target) {
          // Shapes near the path: a destination inside one moves out to free space, and one in the way
          // is passed on its near side. A room's sculpture is sometimes circled instead.
          const obstacles = room.objectsNear(pos, 3.5).filter((o) => o.center.y - o.radius < pos.y && o.center.y + o.radius > pos.y - 1.5);
          for (const o of obstacles) {
            const reach = o.radius * 0.85 + 0.5;
            const dx = target.x - o.center.x, dz = target.z - o.center.z;
            const dd = Math.hypot(dx, dz);
            if (dd < reach) {
              if (dd < 1e-3) target.x += reach;
              else {
                target.x = o.center.x + (dx / dd) * reach;
                target.z = o.center.z + (dz / dd) * reach;
              }
            }
            if (o.kind === "plinth" && orbitCooldown <= 0 && Math.hypot(o.center.x - pos.x, o.center.z - pos.z) < reach + 1.2) {
              orbitCooldown = 12;
              if (random() < 0.5) {
                const a0 = Math.atan2(pos.z - o.center.z, pos.x - o.center.x);
                orbit = { center: o.center.clone(), r: reach + 0.25, a0, sweep: (random() < 0.5 ? -1 : 1) * Math.PI * (1 + random() * 0.5), t: 0, length: 6 + random() * 3, called: false };
              }
            }
          }
          look.set(target.x - pos.x, 0, target.z - pos.z);
          const d = look.length();
          look.normalize();
          let block = null;
          let blockAlong = Infinity;
          for (const o of obstacles) {
            const reach = o.radius * 0.85 + 0.45;
            const ox = o.center.x - pos.x, oz = o.center.z - pos.z;
            const along = ox * look.x + oz * look.z;
            if (along < 0 || along > d) continue;
            const across = Math.abs(ox * look.z - oz * look.x);
            if (across < reach && along < blockAlong) {
              block = { o, reach, ox, oz };
              blockAlong = along;
            }
          }
          if (block) {
            // Aim past the obstacle's side nearer the current line.
            const side = Math.sign(block.ox * look.z - block.oz * look.x) || 1;
            const px = -look.z * side, pz = look.x * side;
            const aimX = block.o.center.x + px * (block.reach + 0.15) - pos.x;
            const aimZ = block.o.center.z + pz * (block.reach + 0.15) - pos.z;
            const al = Math.hypot(aimX, aimZ);
            look.set(aimX / al, 0, aimZ / al);
          }
          // Close to a waypoint, start turning toward the next.
          const aim = look.clone();
          if (nextTarget) {
            const n = new Vector3(nextTarget.target.x - target.x, 0, nextTarget.target.z - target.z).normalize();
            aim.lerp(n, Math.max(0, 1 - d / 1.1) * 0.8).normalize();
          }
          // Corners become arcs; the head looks a little further into the turn than the body has gone.
          turnBody(Math.atan2(-aim.x, -aim.z), dt);
          lookCheck -= dt;
          if (lookCheck <= 0) {
            lookCheck = 0.25;
            // Eyes on the way ahead: the farthest route point it can see, up to five cells on.
            const cands = route.points.slice(route.k, route.k + 6).reverse();
            const eye = new Vector3(pos.x, pos.y, pos.z);
            lookPoint = cands[cands.length - 1];
            for (const c of cands) {
              const dir = new Vector3(c.x - eye.x, 0, c.z - eye.z);
              const dist = dir.length();
              if (dist < 0.3) continue;
              const hit = room.trace(eye, dir.divideScalar(dist), dist);
              if (!hit || hit.distance > dist - 0.25) {
                lookPoint = c;
                break;
              }
            }
            // Then the most open direction around it, so the eyes rest on a hallway or a room, never a wall.
            const around = yaw + Math.max(-1.3, Math.min(1.3, wrap(Math.atan2(-(lookPoint.x - pos.x), -(lookPoint.z - pos.z)) - yaw)));
            lookAt = openYaw(around, 0.8, 0.7);
          }
          // As far round as a head goes (about 85 degrees) when the opening is off to the side.
          lookYaw = Math.max(-1.5, Math.min(1.5, wrap(lookAt - yaw)));
          // A quick look back over a shoulder, when set off by the stops and corridors above.
          glanceIn -= dt;
          if (glanceIn <= 0 && !glance) {
            // Over a shoulder, at whatever is most open back there.
            const side = random() < 0.5 ? -1 : 1;
            glance = { t: 0, yaw: side * Math.min(2.9, Math.abs(wrap(openYaw(yaw + side * 2.5, 0.45, 0.8) - yaw))), hold: 0.6 + random() * 0.4 };
            glanceIn = Infinity;
          }
          if (glance) {
            glance.t += dt;
            lookYaw = glance.yaw;
            headRate = 3.3;
            if (glance.t > glance.hold) glance = null;
          }
          // Slow into turns, with a little wander in pace.
          wobble += dt * 0.37;
          // Nearly stops to turn round; slows into ordinary turns.
          const want = strollSpeed * (0.9 + 0.12 * Math.sin(wobble * 2.3) + 0.06 * Math.sin(wobble * 5.1)) * Math.max(0.05, 1 - 0.75 * Math.min(1, Math.abs(wrap(Math.atan2(-aim.x, -aim.z) - yaw)) / 1.3));
          speed += (want - speed) * (1 - Math.exp(-dt * 1.8));
          // Walk where the body faces (drifting slightly toward the target), not straight at it.
          const facing = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
          facing.lerp(look, 0.25).normalize();
          p.copy(pos).addScaledVector(facing, speed * dt);
          floorY = room.collide(p, 0.35);
          moved = Math.hypot(p.x - pos.x, p.z - pos.z);
          pos.x = p.x;
          pos.z = p.z;
          pitch += (-0.05 - pitch) * (1 - Math.exp(-dt * 1.5));
        }
      }
    } else {
      speed += (0 - speed) * (1 - Math.exp(-dt * 6));
    }

    // Gait: a step every STEP metres, alternating feet; the head bobs, sways and rolls with it.
    const before = Math.floor(stride / STEP);
    stride += moved;
    if (Math.floor(stride / STEP) > before) {
      side = -side;
      events.steps.push({ x: pos.x + right.x * side * 0.12, y: floorY, z: pos.z + right.z * side * 0.12, side, strength: Math.min(1, speed / 1.2) });
    }
    const phase = stride / STEP;
    const gait = Math.min(1, speed / 1.1);
    const bob = 0.032 * gait * (Math.abs(Math.sin(Math.PI * phase)) - 0.5);
    const sway = 0.016 * gait * Math.sin(Math.PI * phase);
    const roll = 0.01 * gait * Math.sin(Math.PI * phase);
    const nod = 0.006 * gait * Math.cos(2 * Math.PI * phase);

    // Breathing: slow and shallow near the start, quicker and heavier deeper in and while walking.
    const rate = 0.22 + 0.25 * weirdness + 0.08 * gait;
    // A new breath starts each time the cycle wraps.
    if (Math.floor(breath + dt * rate) > Math.floor(breath)) events.inhale = true;
    breath += dt * rate;
    const b = Math.sin(breath * Math.PI * 2);
    events.breath = 0.5 + 0.5 * b;
    events.moving = gait;
    const breathe = (0.004 + 0.004 * weirdness) * b;

    // Eye height follows the floor, easing over steps.
    pos.y += (floorY + EYE - pos.y) * (1 - Math.exp(-dt * 10));
    camera.position.copy(pos).addScaledVector(right, sway);
    camera.position.y += bob + breathe;
    // The head's own turn eases in and out too.
    // A critically damped spring: head turns ease in and out instead of starting with a jolt.
    headYawVel += (headRate * headRate * (lookYaw - headYaw) - 2 * headRate * headYawVel) * dt;
    headPitchVel += (headRate * headRate * (lookPitch - headPitch) - 2 * headRate * headPitchVel) * dt;
    headYaw += headYawVel * dt;
    headPitch += headPitchVel * dt;
    euler.set(pitch + headPitch + nod + breathe * 0.6, yaw + headYaw, roll);
    camera.quaternion.setFromEuler(euler);
    camera.updateMatrixWorld();
    return events;
  }

  function reset() {
    pos.set(room.startPos.x, EYE, room.startPos.z);
    floorY = 0;
    // Face an open way out of the first cell.
    const open = room.wander(pos, [0, -1], () => 0.5);
    yaw = open ? Math.atan2(-open.heading[0], -open.heading[1]) : 0;
    heading = open ? open.heading : [0, -1];
    pitch = -0.04;
    yawRate = 0;
    headYaw = headPitch = headYawVel = headPitchVel = 0;
    stall = 0;
    bestD = Infinity;
    orbitCooldown = 0;
    glanceIn = Infinity;
    lookAt = yaw;
    route = null;
    straight = 0;
    sinceDecision = 99;
    target = null;
    nextTarget = null;
    pause = null;
    glance = null;
    orbit = null;
    speed = 0;
  }

  function teleport(x, z, toYaw = yaw) {
    pos.set(x, EYE, z);
    floorY = room.collide(pos, 0.35);
    pos.y = floorY + EYE;
    yaw = toYaw;
    target = null;
    route = null;
  }

  // For the debug map: where the stroll is going and looking.
  const debugState = () => ({ target, nextTarget: nextTarget?.target ?? null, dest: route ? route.points[route.points.length - 1] : null, lookPoint, pausing: !!pause || !!orbit, orbiting: !!orbit });

  return { update, reset, teleport, debugState, wasClick, setPassive, get idle() { return idle; } };
}
