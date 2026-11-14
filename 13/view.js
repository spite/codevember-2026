// Keeps the marble in view of the orbit camera while auto tilt drives: tests whether the piece hides it and finds
// the nearest unobstructed direction on the orbit sphere.
import { Vector3, Quaternion } from "../third_party/three.core.js";

const worldPos = new Vector3();
const worldNormal = new Vector3();
const toCam = new Vector3();
const probe = new Vector3();
const invQuat = new Quaternion();
const candidate = new Vector3();
const candidatePos = new Vector3();
const tangentA = new Vector3();
const tangentB = new Vector3();
const UP = new Vector3(0, 1, 0);

const MIN_ELEVATION = Math.sin((8 * Math.PI) / 180);
const MAX_ELEVATION = Math.sin((78 * Math.PI) / 180);

// True when the marble faces the camera and no part of the piece lies between them (walls are ignored).
function seesMarble(labyrinth, shapeQuat, marble, camPos) {
  worldPos.copy(marble.pos).applyQuaternion(shapeQuat);
  worldNormal.copy(marble.normal).applyQuaternion(shapeQuat);
  toCam.copy(camPos).sub(worldPos);
  const dist = toCam.length();
  toCam.divideScalar(dist);
  if (worldNormal.dot(toCam) < 0.2) return false;
  invQuat.copy(shapeQuat).invert();
  const start = labyrinth.marbleRadius * 2.5;
  const span = Math.min(dist, 3) - start;
  const shape = labyrinth.shape;
  for (let k = 1; k <= 24; k++) {
    probe.copy(worldPos).addScaledVector(toCam, start + (span * k) / 24).applyQuaternion(invQuat);
    if (shape.sdf(probe.x, probe.y, probe.z) < 0.01) return false;
  }
  return true;
}

// Writes into `out` the visible camera direction (unit, from the orbit target) closest to `currentDir`, or returns
// false if none of the candidates sees the marble.
function findVisibleDirection(labyrinth, shapeQuat, marble, currentDir, radius, out) {
  worldNormal.copy(marble.normal).applyQuaternion(shapeQuat);
  tangentA.crossVectors(worldNormal, Math.abs(worldNormal.y) < 0.9 ? UP : toCam.set(1, 0, 0)).normalize();
  tangentB.crossVectors(worldNormal, tangentA);
  let best = -2;
  for (let ring = 0; ring <= 3; ring++) {
    const tilt = ring * 0.4;
    const steps = ring === 0 ? 1 : 10;
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      candidate
        .copy(worldNormal)
        .multiplyScalar(Math.cos(tilt))
        .addScaledVector(tangentA, Math.sin(tilt) * Math.cos(a))
        .addScaledVector(tangentB, Math.sin(tilt) * Math.sin(a))
        .normalize();
      if (candidate.y < MIN_ELEVATION || candidate.y > MAX_ELEVATION) continue;
      const score = candidate.dot(currentDir);
      if (score <= best) continue;
      if (!seesMarble(labyrinth, shapeQuat, marble, candidatePos.copy(candidate).multiplyScalar(radius))) continue;
      best = score;
      out.copy(candidate);
    }
  }
  return best > -2;
}

// Glides the camera along its orbit (around the origin) to a view of the marble once it has been hidden a moment.
function createViewKeeper({ hideDelay = 0.25, rate = 1.5, maxSpeed = 0.7, accel = 1.2 } = {}) {
  let hidden = 0;
  let recheck = 0;
  let moving = false;
  let speed = 0;
  const goal = new Vector3();
  const dir = new Vector3();
  const axis = new Vector3();
  const step = new Quaternion();
  return {
    reset() {
      hidden = 0;
      moving = false;
      speed = 0;
    },
    // Moves `camPos` in place; returns true while it is steering the camera.
    update(dt, labyrinth, shapeQuat, marble, camPos) {
      const radius = camPos.length();
      dir.copy(camPos).divideScalar(radius);
      recheck -= dt;
      if (!moving) {
        hidden = seesMarble(labyrinth, shapeQuat, marble, camPos) ? 0 : hidden + dt;
        if (hidden > hideDelay && recheck <= 0) {
          recheck = 0.5;
          moving = findVisibleDirection(labyrinth, shapeQuat, marble, dir, radius, goal);
        }
      } else if (recheck <= 0) {
        recheck = 0.5;
        moving = findVisibleDirection(labyrinth, shapeQuat, marble, dir, radius, goal);
      }
      if (!moving) {
        speed = 0;
        return false;
      }
      const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(goal))));
      if (angle < 0.01) {
        moving = false;
        hidden = 0;
        speed = 0;
        return false;
      }
      axis.crossVectors(dir, goal);
      if (axis.lengthSq() < 1e-10) axis.set(0, 1, 0);
      axis.normalize();
      // Ease out toward the goal, but ramp the speed up gently so a glide never starts with a jolt.
      const wanted = dt > 0 ? Math.min(angle * (1 - Math.exp(-dt * rate)), maxSpeed * dt) / dt : 0;
      speed = Math.min(wanted, speed + accel * dt);
      const turn = speed * dt;
      step.setFromAxisAngle(axis, turn);
      camPos.copy(dir.applyQuaternion(step)).multiplyScalar(radius);
      return true;
    },
  };
}

export { seesMarble, findVisibleDirection, createViewKeeper };
