// Surface-hugged rolling marble solver in the labyrinth's rotating frame, with spatial-hashed capsule
// wall collisions, exact no-slip rolling spin, pocket capture, and smooth SO(3) auto-tilt steering.
import { Vector3, Quaternion, Matrix4 } from "three";

const WORLD_DOWN = new Vector3(0, -1, 0);
const WORLD_UP = new Vector3(0, 1, 0);

const RESTITUTION_BY_MATERIAL = {
  wood: 0.24,
  stone: 0.31,
  metal: 0.38,
};

export function createMarbleState() {
  return {
    foot: new Vector3(0, 1, 0),
    normal: new Vector3(0, 1, 0),
    pos: new Vector3(0, 1, 0),
    vel: new Vector3(),
    spinQuat: new Quaternion(),
    smoothAimDir: new Vector3(0, 0, 1),
    smoothTilt: 0.2,
    stallTime: 0,
    splineIdx: 0,
    currentCellId: 0,
    pocketDip: 0,
    captured: false,
    captureTime: 0,
    prevShapeQuat: new Quaternion(),
    prevLocalOmega: new Vector3(),
    seenCapsules: new Set(),
  };
}

export function placeMarbleAtStart(state, labyrinth) {
  const start = labyrinth.startCell;
  state.foot.fromArray(start.center);
  state.normal.fromArray(start.normal);
  state.vel.set(0, 0, 0);
  state.pocketDip = -labyrinth.marbleRadius * 0.2;
  state.pos.copy(state.foot).addScaledVector(state.normal, labyrinth.marbleRadius + state.pocketDip);
  state.currentCellId = labyrinth.startCellId;
  state.smoothTilt = 0.2;
  state.autoSlope = null;
  state.autoYaw = 0;
  state.stallTime = 0;
  state.splineIdx = 0;
  state.captured = false;
  state.captureTime = 0;
  state.bestRemDist = undefined;
  state.noProgressTime = 0;
  state.prevLocalOmega.set(0, 0, 0);

  const nextId = labyrinth.nextTowardGoal[labyrinth.startCellId];
  if (nextId >= 0) {
    const nextC = labyrinth.complex.cells[nextId].center;
    state.smoothAimDir
      .set(nextC[0] - start.center[0], nextC[1] - start.center[1], nextC[2] - start.center[2])
      .addScaledVector(state.normal, -state.normal.dot(state.smoothAimDir));
    if (state.smoothAimDir.lengthSq() > 1e-8) state.smoothAimDir.normalize();
  }
}

const invQuat = new Quaternion();
const deltaQuat = new Quaternion();
const rollQuat = new Quaternion();
const localGravity = new Vector3();
const localOmega = new Vector3();
const localAlpha = new Vector3();
const eulerKick = new Vector3();
const centrifugal = new Vector3();
const accelTan = new Vector3();
const prevFoot = new Vector3();
const stepDelta = new Vector3();
const rollAxis = new Vector3();
const pushDir = new Vector3();
const goalVec = new Vector3();
const startVec = new Vector3();
const projBuf = new Float64Array(6);

// Updates currentCellId by stepping strictly across open doorways along exact Voronoi hub bisectors!
function updateCurrentCell(state, labyrinth) {
  const cells = labyrinth.complex.cells;
  const edges = labyrinth.complex.edges;
  const openSet = labyrinth.openEdgeSet;
  const fx = state.foot.x;
  const fy = state.foot.y;
  const fz = state.foot.z;

  let bestId = state.currentCellId;
  if (bestId < 0 || bestId >= cells.length) bestId = 0;
  const distSqToHub = (c) => {
    const dx = fx - c.center[0];
    const dy = fy - c.center[1];
    const dz = fz - c.center[2];
    return dx * dx + dy * dy + dz * dz;
  };
  let bestScore = distSqToHub(cells[bestId]);

  let improved = true;
  let hops = 0;
  while (improved && hops++ < 6) {
    improved = false;
    const cell = cells[bestId];
    for (const edgeId of cell.edgeIds) {
      if (!openSet.has(edgeId)) continue;
      const e = edges[edgeId];
      const nb = e.c0 === bestId ? e.c1 : e.c0;
      if (nb < 0) continue;
      const score = distSqToHub(cells[nb]);
      if (score < bestScore) {
        bestScore = score;
        bestId = nb;
        improved = true;
      }
    }
  }

  // Fallback global check only if marble teleported far across the shape.
  const maxLocalR = Math.max(0.24, cells[bestId].inradius * 3.2);
  if (bestScore > maxLocalR * maxLocalR) {
    let bestRawSq = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const cn = cells[i].normal;
      if (cn[0] * state.normal.x + cn[1] * state.normal.y + cn[2] * state.normal.z < -0.2) continue;
      const dSq = distSqToHub(cells[i]);
      if (dSq < bestRawSq) {
        bestRawSq = dSq;
        bestId = i;
      }
    }
  }
  state.currentCellId = bestId;
}

export function stepMarble(state, labyrinth, shapeQuat, dt, {
  gravity = 6.4,
  materialKind = "wood",
  wallsActive = true,
} = {}) {
  const result = {
    maxImpact: 0,
    impactGoalRim: false,
    impactLocalPos: null,
    scrapeSpeed: 0,
    justCaptured: false,
  };
  // Frames that don't simulate still track the pose, so the next step sees no fake rotation.
  if (!labyrinth || dt <= 0 || state.captured) {
    state.prevShapeQuat.copy(shapeQuat);
    state.prevLocalOmega.set(0, 0, 0);
  }
  if (!labyrinth || dt <= 0) return result;

  if (state.captured) {
    state.captureTime += dt;
    const goal = labyrinth.goalCell;
    state.foot.lerp(goalVec.fromArray(goal.center), 1 - Math.exp(-dt * 18));
    labyrinth.shape.project(state.foot.x, state.foot.y, state.foot.z, projBuf);
    state.foot.set(projBuf[0], projBuf[1], projBuf[2]);
    state.normal.set(projBuf[3], projBuf[4], projBuf[5]);
    state.pocketDip += (-labyrinth.marbleRadius * 0.68 - state.pocketDip) * (1 - Math.exp(-dt * 16));
    state.pos.copy(state.foot).addScaledVector(state.normal, labyrinth.marbleRadius + state.pocketDip);
    state.vel.multiplyScalar(Math.exp(-dt * 20));
    return result;
  }

  // Compute local-frame gravity and clamped rotational inertia from shapeQuat change.
  invQuat.copy(shapeQuat).invert();
  localGravity.copy(WORLD_DOWN).multiplyScalar(gravity).applyQuaternion(invQuat);

  deltaQuat.copy(state.prevShapeQuat).invert().premultiply(shapeQuat);
  if (deltaQuat.w < 0) {
    deltaQuat.x = -deltaQuat.x;
    deltaQuat.y = -deltaQuat.y;
    deltaQuat.z = -deltaQuat.z;
    deltaQuat.w = -deltaQuat.w;
  }
  const sinHalf = Math.hypot(deltaQuat.x, deltaQuat.y, deltaQuat.z);
  if (sinHalf > 1e-6) {
    const angle = 2 * Math.atan2(sinHalf, deltaQuat.w);
    localOmega
      .set(deltaQuat.x / sinHalf, deltaQuat.y / sinHalf, deltaQuat.z / sinHalf)
      .multiplyScalar(angle / dt)
      .applyQuaternion(invQuat);
  } else {
    localOmega.set(0, 0, 0);
  }
  if (localOmega.length() > 9) localOmega.setLength(9);

  localAlpha.copy(localOmega).sub(state.prevLocalOmega).divideScalar(dt);
  if (localAlpha.length() > 35) localAlpha.setLength(35);
  state.prevLocalOmega.copy(localOmega);
  state.prevShapeQuat.copy(shapeQuat);

  const rBall = labyrinth.marbleRadius;
  const minWallDist = rBall + labyrinth.wallHalfWidth;
  const restitution = RESTITUTION_BY_MATERIAL[materialKind] ?? 0.28;
  const goalCenter = labyrinth.goalCell.center;
  const goalNormal = labyrinth.goalCell.normal;
  const startCenter = labyrinth.startCell.center;
  const pocketR = labyrinth.pocketRadius;
  const inGoalApproach =
    state.currentCellId === labyrinth.goalCellId ||
    labyrinth.nextTowardGoal[state.currentCellId] === labyrinth.goalCellId;
  const grabRadius = inGoalApproach ? Math.max(pocketR * 2.25, rBall * 2.8) : pocketR * 1.35;

  const speedEst = state.vel.length() + gravity * dt;
  const substeps = Math.max(4, Math.min(16, Math.ceil((speedEst * dt) / (rBall * 0.26))));
  const h = dt / substeps;

  for (let sub = 0; sub < substeps; sub++) {
    prevFoot.copy(state.foot);

    // Rotational pseudo-accelerations in local frame (subtle so handheld flicks feel lively).
    eulerKick.crossVectors(localAlpha, state.foot).multiplyScalar(-0.14);
    centrifugal.crossVectors(localOmega, state.foot);
    centrifugal.crossVectors(localOmega, centrifugal).multiplyScalar(-0.1);

    accelTan.copy(localGravity).add(eulerKick).add(centrifugal);

    // Goal funnel grab slope and gentle Start dish dimple.
    goalVec.set(goalCenter[0] - state.foot.x, goalCenter[1] - state.foot.y, goalCenter[2] - state.foot.z);
    const dGoal = goalVec.length();
    const sameGoalSheet =
      goalNormal[0] * state.normal.x + goalNormal[1] * state.normal.y + goalNormal[2] * state.normal.z > 0.55;
    let targetDip = 0;
    if (sameGoalSheet && dGoal < grabRadius && dGoal > 1e-6) {
      const tGrab = 1 - dGoal / grabRadius;
      const pull = 9.5 * tGrab + 24.0 * tGrab * tGrab;
      accelTan.addScaledVector(goalVec, pull / dGoal);
      state.vel.multiplyScalar(Math.exp(-(2.4 + 8.0 * tGrab * tGrab) * h));
      if (dGoal < pocketR * 1.35) {
        const u = dGoal / (pocketR * 1.35);
        targetDip = -rBall * 0.72 * Math.cos(u * Math.PI * 0.5) ** 1.35;
      }
    } else {
      startVec.set(startCenter[0] - state.foot.x, startCenter[1] - state.foot.y, startCenter[2] - state.foot.z);
      const dStart = startVec.length();
      if (dStart < pocketR * 0.85) {
        const u = dStart / (pocketR * 0.85);
        targetDip = -rBall * 0.2 * (1 - u * u);
      }
    }

    // Project acceleration strictly onto tangent plane; solid sphere rolls at 5/7 of tangent acceleration.
    accelTan.addScaledVector(state.normal, -accelTan.dot(state.normal));
    state.vel.addScaledVector(accelTan, (5 / 7) * h);
    state.vel.multiplyScalar(Math.exp(-1.15 * h));

    // Clamp max rolling speed so audio & physics stay crisp.
    const maxSpeed = 3.2;
    if (state.vel.lengthSq() > maxSpeed * maxSpeed) {
      state.vel.setLength(maxSpeed);
    }

    // Step along tangent and project back to exact surface manifold.
    const speedBefore = state.vel.length();
    state.foot.addScaledVector(state.vel, h);
    labyrinth.shape.project(state.foot.x, state.foot.y, state.foot.z, projBuf);
    state.foot.set(projBuf[0], projBuf[1], projBuf[2]);
    state.normal.set(projBuf[3], projBuf[4], projBuf[5]);

    // Parallel-transport tangent velocity onto new surface normal, preserving kinetic energy round bends.
    state.vel.addScaledVector(state.normal, -state.vel.dot(state.normal));
    const projSpeed = state.vel.length();
    if (projSpeed > 1e-6 && speedBefore > 1e-6) {
      state.vel.multiplyScalar(speedBefore / projSpeed);
    }

    // Zero-allocation O(1) CSR grid capsule wall collision.
    if (wallsActive) {
      const gRes = labyrinth.gridRes;
      const gHalf = labyrinth.gridHalf;
      const gInv = labyrinth.gridInv;
      let gx = ((state.foot.x + gHalf) * gInv) | 0;
      let gy = ((state.foot.y + gHalf) * gInv) | 0;
      let gz = ((state.foot.z + gHalf) * gInv) | 0;
      if (gx < 0) gx = 0;
      else if (gx >= gRes) gx = gRes - 1;
      if (gy < 0) gy = 0;
      else if (gy >= gRes) gy = gRes - 1;
      if (gz < 0) gz = 0;
      else if (gz >= gRes) gz = gRes - 1;
      const cellIdx = (gz * gRes + gy) * gRes + gx;
      const startIdx = labyrinth.gridOffsets[cellIdx];
      const endIdx = labyrinth.gridOffsets[cellIdx + 1];
      const capData = labyrinth.capsuleData;
      const gItems = labyrinth.gridItems;

      for (let pass = 0; pass < 4; pass++) {
        const px = state.foot.x + state.normal.x * rBall;
        const py = state.foot.y + state.normal.y * rBall;
        const pz = state.foot.z + state.normal.z * rBall;

        for (let k = startIdx; k < endIdx; k++) {
          const base = gItems[k] * 12;
          const ax = capData[base] + capData[base + 3] * rBall;
          const ay = capData[base + 1] + capData[base + 4] * rBall;
          const az = capData[base + 2] + capData[base + 5] * rBall;
          const bx = capData[base + 6] + capData[base + 9] * rBall;
          const by = capData[base + 7] + capData[base + 10] * rBall;
          const bz = capData[base + 8] + capData[base + 11] * rBall;

          const ex = bx - ax;
          const ey = by - ay;
          const ez = bz - az;
          const eLenSq = ex * ex + ey * ey + ez * ez;
          const t = eLenSq > 1e-12
            ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / eLenSq))
            : 0;
          const cnx = capData[base + 3] + (capData[base + 9] - capData[base + 3]) * t;
          const cny = capData[base + 4] + (capData[base + 10] - capData[base + 4]) * t;
          const cnz = capData[base + 5] + (capData[base + 11] - capData[base + 5]) * t;
          if (cnx * state.normal.x + cny * state.normal.y + cnz * state.normal.z < -0.28) continue;
          const qx = ax + ex * t;
          const qy = ay + ey * t;
          const qz = az + ez * t;

          pushDir.set(px - qx, py - qy, pz - qz);
          const nDot = pushDir.dot(state.normal);
          pushDir.addScaledVector(state.normal, -nDot);
          let dist = pushDir.length();
          if (Math.abs(nDot) > 0.022 + dist * 0.95) continue;

          if (dist < minWallDist) {
            if (dist < 1e-7) {
              pushDir.set(-ey, ex, 0);
      pushDir.addScaledVector(state.normal, -pushDir.dot(state.normal));
              if (pushDir.lengthSq() < 1e-8) pushDir.set(1, 0, 0);
              pushDir.normalize();
              dist = 0;
            } else {
              pushDir.divideScalar(dist);
            }

            const overlap = minWallDist - dist;
            state.foot.addScaledVector(pushDir, overlap);
            labyrinth.shape.project(state.foot.x, state.foot.y, state.foot.z, projBuf);
            state.foot.set(projBuf[0], projBuf[1], projBuf[2]);
            state.normal.set(projBuf[3], projBuf[4], projBuf[5]);

            const vn = -state.vel.dot(pushDir);
            if (vn > 0) {
              // Remove inward normal velocity + bounce; damp tangential rub slightly.
              state.vel.addScaledVector(pushDir, vn * (1 + (vn > 0.12 ? restitution : 0)));
              state.vel.multiplyScalar(Math.max(0.88, 1 - 1.2 * h));
              state.vel.addScaledVector(state.normal, -state.vel.dot(state.normal));

              if (vn > 0.11 && vn > result.maxImpact) {
                result.maxImpact = vn;
                result.impactLocalPos = state.foot.clone();
                result.impactGoalRim = dGoal < pocketR * 1.45;
              }
            }

            const slideSpeed = state.vel.length();
            if (vn < 0.14 && slideSpeed > 0.08) {
              result.scrapeSpeed = Math.max(result.scrapeSpeed, slideSpeed);
            }
          }
        }
      }
    }

    // Update rolling spin quaternion from true geodesic step along the floor.
    stepDelta.copy(state.foot).sub(prevFoot);
    const stepLen = stepDelta.length();
    if (stepLen > 1e-7) {
      rollAxis.crossVectors(state.normal, stepDelta);
      if (rollAxis.lengthSq() > 1e-12) {
        rollAxis.normalize();
        rollQuat.setFromAxisAngle(rollAxis, stepLen / rBall);
        state.spinQuat.premultiply(rollQuat).normalize();
      }
    }

    state.pocketDip += (targetDip - state.pocketDip) * Math.min(1, 24 * h);
    state.pos.copy(state.foot).addScaledVector(state.normal, rBall + state.pocketDip);

    // Check Goal pocket capture!
    const finalGoalDist = Math.hypot(
      goalCenter[0] - state.foot.x,
      goalCenter[1] - state.foot.y,
      goalCenter[2] - state.foot.z,
    );
    const sameSheetFinal =
      goalNormal[0] * state.normal.x + goalNormal[1] * state.normal.y + goalNormal[2] * state.normal.z > 0.55;
    if (
      wallsActive &&
      sameSheetFinal &&
      ((finalGoalDist < pocketR * 0.88 && state.vel.length() < 1.75) || finalGoalDist < pocketR * 0.52)
    ) {
      state.captured = true;
      state.captureTime = 0;
      result.justCaptured = true;
      break;
    }
  }

  updateCurrentCell(state, labyrinth);
  return result;
}

// Computes a human-like, expressive target world quaternion: tracks the smooth racing-line solution spline
// (falling back to BFS doorways if the user rolled off-route), looks ahead for sharp bends, forks, and narrow gates,
// and visibly levels the labyrinth up (~7-11 deg) to slow down through tricky parts before leaning in (~33 deg) on straightaways!
const localB = new Vector3();
const localT = new Vector3();
const worldN = new Vector3();
const worldT = new Vector3();
const worldB = new Vector3();
const camHoriz = new Vector3();
const deltaAuto = new Quaternion();
const yawAuto = new Quaternion();
const projAuto = new Float64Array(6);
const lookTarget = new Vector3();
const tanNow = new Vector3();
const tanAhead = new Vector3();

function findGateBetween(labyrinth, ca, cb) {
  if (ca < 0 || cb < 0) return null;
  const cells = labyrinth.complex.cells;
  const edges = labyrinth.complex.edges;
  for (const edgeId of cells[ca].edgeIds) {
    if (!labyrinth.openEdgeSet.has(edgeId)) continue;
    const e = edges[edgeId];
    if (e.c0 === cb || e.c1 === cb) return e;
  }
  return null;
}

function gateCoords(labyrinth, edge, fallbackCell) {
  if (!edge) return labyrinth.complex.cells[fallbackCell].center;
  if (edge.gatePoint) return edge.gatePoint;
  const va = labyrinth.complex.vertices[edge.v0].pos;
  const vb = labyrinth.complex.vertices[edge.v1].pos;
  return [(va[0] + vb[0]) * 0.5, (va[1] + vb[1]) * 0.5, (va[2] + vb[2]) * 0.5];
}

function openDegreeOfCell(labyrinth, cellId) {
  if (cellId < 0) return 0;
  let deg = 0;
  for (const edgeId of labyrinth.complex.cells[cellId].edgeIds) {
    if (labyrinth.openEdgeSet.has(edgeId)) deg++;
  }
  return deg;
}

// Auto tilt profiles. `steady`: a slow marble on gentle slopes with slow filters, so the piece can follow it calmly
// and keep it in view. `optimal`: tight, lively tracking that solves the most mazes.
export const AUTO_PROFILES = {
  steady: {
    cruiseSpeed: 0.2,
    speedDrop: 0.15,
    tiltBase: 0.2,
    tiltDrop: 0.12,
    unstickGain: 0.5,
    overGain: 0.5,
    underGain: 0.15,
    minTilt: -0.06,
    maxTilt: 0.24,
    aimRate: 3,
    tiltRate: 2,
    targetRate: 2,
    drift: 0.3,
    driftMax: 0.4,
    stallWeave: 0.15,
    stallFreq: 0.8,
    progressWeave: 0.15,
    progressFreq: 0.8,
    hubWeave: 0,
    lookAhead: 3.5,
    lookAheadMin: 0.09,
    yawMax: 0.12,
    hullBias: 0.4,
  },
  optimal: {
    cruiseSpeed: 0.8,
    speedDrop: 0.64,
    tiltBase: 0.49,
    tiltDrop: 0.31,
    unstickGain: 1,
    overGain: 0.72,
    underGain: 0.22,
    minTilt: -0.26,
    maxTilt: 0.54,
    aimRate: 11,
    tiltRate: 7.8,
    targetRate: Infinity,
    drift: 0.68,
    driftMax: 0.62,
    stallWeave: 0.5,
    stallFreq: 7.5 / (Math.PI * 2),
    progressWeave: 0.34,
    progressFreq: 6 / (Math.PI * 2),
    hubWeave: 0.35,
    lookAhead: 2.5,
    lookAheadMin: 0.07,
    yawMax: 0,
    hullBias: 0,
  },
};

const routeCache = new WeakMap();
function routeCells(labyrinth) {
  let cells = routeCache.get(labyrinth);
  if (!cells) {
    cells = new Set();
    for (let c = labyrinth.startCellId; c >= 0 && !cells.has(c); c = labyrinth.nextTowardGoal[c]) cells.add(c);
    routeCache.set(labyrinth, cells);
  }
  return cells;
}

function pursueSolutionPath(state, labyrinth, out, auto) {
  const path = labyrinth.solutionPathPoints;
  if (!path || path.length < 2) return;
  const { x, y, z } = state.foot;
  const distSq = (i) => (path[i][0] - x) ** 2 + (path[i][1] - y) ** 2 + (path[i][2] - z) ** 2;
  let best = Math.min(Math.max(0, state.splineIdx | 0), path.length - 1);
  let bestSq = distSq(best);
  for (let i = Math.max(0, best - 60); i < Math.min(path.length, best + 160); i++) {
    const d = distSq(i);
    if (d < bestSq) {
      bestSq = d;
      best = i;
    }
  }
  const maxOff = Math.max(0.06, labyrinth.marbleRadius * 3);
  if (bestSq > maxOff * maxOff) {
    for (let i = 0; i < path.length; i++) {
      const d = distSq(i);
      if (d < bestSq) {
        bestSq = d;
        best = i;
      }
    }
  }
  state.splineIdx = best;
  if (bestSq > maxOff * maxOff) {
    // Off the path but inside a route cell: head back to the path first.
    if (routeCells(labyrinth).has(state.currentCellId)) out.fromArray(path[best]);
    return;
  }
  const lookAhead = Math.max(auto.lookAheadMin, labyrinth.marbleRadius * auto.lookAhead);
  let i = best;
  let travelled = 0;
  while (i < path.length - 1 && travelled < lookAhead) {
    travelled += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]);
    i++;
  }
  out.fromArray(path[i]);
}

export function computeAutoTiltQuat(state, labyrinth, cameraPosition, outQuat, dt, shapeQuat, auto = AUTO_PROFILES.steady) {
  const cells = labyrinth.complex.cells;
  const fx = state.foot.x;
  const fy = state.foot.y;
  const fz = state.foot.z;

  const c0 = state.currentCellId;
  const c1 = labyrinth.nextTowardGoal[c0];
  const c2 = c1 >= 0 ? labyrinth.nextTowardGoal[c1] : -1;
  const c3 = c2 >= 0 ? labyrinth.nextTowardGoal[c2] : -1;
  const gate01 = c1 >= 0 ? findGateBetween(labyrinth, c0, c1) : null;
  const gate12 = c2 >= 0 ? findGateBetween(labyrinth, c1, c2) : null;
  const gate23 = c3 >= 0 ? findGateBetween(labyrinth, c2, c3) : null;

  let turnHazard = 0;
  let forkHazard = 0;
  let squeezeHazard = 0;
  let distGate = 0;

  if (c0 === labyrinth.goalCellId || c1 < 0) {
    lookTarget.fromArray(labyrinth.goalCell.center);
  } else if (gate01) {
    const g1 = gateCoords(labyrinth, gate01, c1);
    const nextCenter = cells[c1].center;
    const p2 = gate12 ? gateCoords(labyrinth, gate12, c2) : nextCenter;
    distGate = Math.hypot(g1[0] - fx, g1[1] - fy, g1[2] - fz);
    const nearGoalGate = c1 === labyrinth.goalCellId && distGate < labyrinth.marbleRadius * 2.2;
    const blendNext = nearGoalGate ? 1.0 : distGate < labyrinth.marbleRadius * 0.70 ? 0.36 : 0.05;
    lookTarget.set(
      g1[0] * (1 - blendNext) + nextCenter[0] * blendNext,
      g1[1] * (1 - blendNext) + nextCenter[1] * blendNext,
      g1[2] * (1 - blendNext) + nextCenter[2] * blendNext,
    );

    // Look 2-3 gates ahead (c0 -> g1 -> g2 -> g3) so the solver starts braking BEFORE reaching a sharp turn or fork!
    tanNow.set(g1[0] - fx, g1[1] - fy, g1[2] - fz);
    const l1 = tanNow.length();
    if (l1 > 1e-5) {
      tanNow.divideScalar(l1);
      tanAhead.set(p2[0] - g1[0], p2[1] - g1[1], p2[2] - g1[2]);
      const l2 = tanAhead.length();
      if (l2 > 1e-5) {
        tanAhead.divideScalar(l2);
        const turnCos1 = tanNow.dot(tanAhead);
        const brakeSpan = Math.max(0.42, labyrinth.marbleRadius * 6.5);
        const prox1 = 1 - Math.min(1, Math.max(0, (distGate - labyrinth.marbleRadius * 0.75) / brakeSpan));
        turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.94 - turnCos1) / 1.0)) * (0.50 + 0.50 * prox1));

        if (c2 >= 0) {
          const p3 = gate23 ? gateCoords(labyrinth, gate23, c3) : cells[c2].center;
          const d23x = p3[0] - p2[0];
          const d23y = p3[1] - p2[1];
          const d23z = p3[2] - p2[2];
          const l3 = Math.hypot(d23x, d23y, d23z);
          if (l3 > 1e-5) {
            const turnCos2 = (tanAhead.x * d23x + tanAhead.y * d23y + tanAhead.z * d23z) / l3;
            const prox2 = 1 - Math.min(1, (distGate + l2) / 0.56);
            turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.90 - turnCos2) / 1.05)) * prox2 * 0.95);
          }
        }
      }
    }

    const deg0 = openDegreeOfCell(labyrinth, c0);
    const deg1 = openDegreeOfCell(labyrinth, c1);
    const deg2 = openDegreeOfCell(labyrinth, c2);
    if ((deg0 >= 3 || deg1 >= 3 || deg2 >= 3) && turnHazard > 0.12) {
      const forkProx = 1 - Math.min(1, distGate / 0.26);
      forkHazard = (deg1 >= 4 || deg0 >= 4 ? 0.92 : 0.78) * (0.45 + 0.55 * forkProx);
    }

    const minPassDiam = (labyrinth.marbleRadius + labyrinth.wallHalfWidth) * 2;
    const gateSpan = gate01.clearSpan ?? gate01.length;
    const gateRatio = gateSpan / Math.max(1e-4, minPassDiam);
    if (gateRatio < 1.18) {
      squeezeHazard = Math.min(0.65, (1.18 - gateRatio) / 0.16);
    }
  } else {
    lookTarget.fromArray(cells[c1].center);
  }

  // On the solution route, chase a point a little ahead along the wall-clear path rather than the straight line to
  // the gate, which can cut through the wall of a curved cell.
  if (c0 !== labyrinth.goalCellId) pursueSolutionPath(state, labyrinth, lookTarget, auto);

  const goalC = labyrinth.goalCell.center;
  const distGoal = Math.hypot(goalC[0] - fx, goalC[1] - fy, goalC[2] - fz);
  const goalHazard = distGoal < labyrinth.pocketRadius * 2.5
    ? Math.min(0.78, 1 - distGoal / (labyrinth.pocketRadius * 2.5))
    : 0;

  localT.copy(lookTarget).sub(state.foot);
  localT.addScaledVector(state.normal, -localT.dot(state.normal));
  if (localT.lengthSq() < 1e-8) {
    localT.copy(state.smoothAimDir);
  } else {
    localT.normalize();
  }

  // Counter-steer laterally against cross-corridor drift so the ball carves cleanly into turns instead of overshooting forks!
  localB.crossVectors(state.normal, localT).normalize();
  const rawSpeed = state.vel.length();
  const driftCross = state.vel.dot(localB);
  if (rawSpeed > 0.18) {
    const velAlign = state.vel.dot(localT) / rawSpeed;
    turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.86 - velAlign) / 0.95)));
  }
  localT.addScaledVector(localB, -Math.max(-auto.driftMax, Math.min(auto.driftMax, driftCross * auto.drift))).normalize();

  const curRemDist = labyrinth.distToGoal[c0];
  if (state.bestRemDist === undefined || state.bestGoalCellId !== labyrinth.goalCellId || curRemDist < state.bestRemDist) {
    state.bestGoalCellId = labyrinth.goalCellId;
    state.bestRemDist = curRemDist;
    state.noProgressTime = 0;
  } else {
    state.noProgressTime = (state.noProgressTime ?? 0) + dt;
    if (state.noProgressTime > 5.3) {
      state.bestRemDist = curRemDist;
      state.noProgressTime = 0;
    }
  }

  if (rawSpeed < 0.14) {
    state.stallTime = Math.min(3.5, (state.stallTime ?? 0) + dt);
  } else {
    state.stallTime = Math.max(0, (state.stallTime ?? 0) - dt * 3.2);
  }
  // Human-like recenter-and-thread reflex: if bouncing across a fork or rubbing a post for > 4.05s without advancing closer to Goal,
  // briefly pull back to the current cell's high-clearance hub (4.05..4.60s) then weave through the gate (4.60..5.30s) and reset!
  if (state.noProgressTime > 4.05 && state.noProgressTime < 4.60) {
    const hub = cells[c0].center;
    localT.set(hub[0] - fx, hub[1] - fy, hub[2] - fz);
    localT.addScaledVector(state.normal, -localT.dot(state.normal));
    if (localT.lengthSq() > 1e-7) {
      localT.normalize();
    } else {
      localT.copy(state.smoothAimDir).negate();
    }
    localT.addScaledVector(localB, Math.sin(state.noProgressTime * 6.0) * auto.hubWeave).normalize();
  } else if (state.stallTime > 0.45) {
    localT.addScaledVector(localB, Math.sin(state.stallTime * auto.stallFreq * Math.PI * 2) * auto.stallWeave).normalize();
  } else if (state.noProgressTime > 4.6) {
    localT.addScaledVector(localB, Math.sin(state.noProgressTime * auto.progressFreq * Math.PI * 2) * auto.progressWeave).normalize();
  }
  state.smoothAimDir.lerp(localT, 1 - Math.exp(-dt * auto.aimRate));
  state.smoothAimDir.addScaledVector(state.normal, -state.normal.dot(state.smoothAimDir));
  if (state.smoothAimDir.lengthSq() < 1e-8) {
    state.smoothAimDir.set(0, 0, 1).addScaledVector(state.normal, -state.normal.z);
  }
  state.smoothAimDir.normalize();

  localB.crossVectors(state.normal, state.smoothAimDir).normalize();
  localT.crossVectors(localB, state.normal).normalize();

  const tricky = Math.max(turnHazard, forkHazard, squeezeHazard, goalHazard);
  // Cruise briskly (~0.80) on open straightaways, slow right down (~0.16) before sharp radial turns & forks!
  const desiredSpeed = auto.cruiseSpeed - auto.speedDrop * Math.pow(tricky, 0.7);
  const speedAlong = state.vel.dot(localT);
  const unstickBoost = state.stallTime > 0.2 ? Math.min(0.34, (state.stallTime - 0.2) * 0.55) : 0;

  // Lean toward the aim on open runs, flatten (barely past level) to brake before turns and forks.
  const cruiseTilt = auto.tiltBase - auto.tiltDrop * tricky + unstickBoost * auto.unstickGain;
  const speedError = desiredSpeed - speedAlong;
  const targetTilt = Math.max(
    auto.minTilt,
    Math.min(auto.maxTilt, cruiseTilt + (speedError < 0 ? speedError * auto.overGain : speedError * auto.underGain)),
  );
  state.smoothTilt += (targetTilt - state.smoothTilt) * (1 - Math.exp(-dt * auto.tiltRate));

  camHoriz.set(cameraPosition.x, 0, cameraPosition.z);
  if (camHoriz.lengthSq() < 1e-6) camHoriz.set(0, 0, 1);
  else camHoriz.normalize();

  // Smallest rotation that puts the marble's surface normal at the wanted slope toward its aim,
  // so the piece never spends its turning on yaw while the marble slides off the top.
  // Level the surface between the marble and its next gate, so edges and bends ahead are already flattened.
  labyrinth.shape.project(lookTarget.x, lookTarget.y, lookTarget.z, projAuto);
  worldN.set(projAuto[3], projAuto[4], projAuto[5]).multiplyScalar(0.3).add(state.normal);
  // On rings and knots an up-facing spot can be inside the hole, under the far rim: also lift the marble's position.
  if (labyrinth.shape.genus === 1) worldN.addScaledVector(state.pos, auto.hullBias / Math.max(1e-6, state.pos.length()));
  worldN.normalize().applyQuaternion(shapeQuat);
  worldT.copy(localT).applyQuaternion(shapeQuat);
  worldT.y = 0;
  if (worldT.lengthSq() < 1e-6) worldT.copy(camHoriz).negate();
  worldT.normalize();
  worldB.copy(WORLD_UP).multiplyScalar(Math.cos(state.smoothTilt)).addScaledVector(worldT, Math.sin(state.smoothTilt));
  // Ease the wanted slope in world space, so gate-to-gate aim changes become slow sways instead of jerks.
  if (!state.autoSlope) state.autoSlope = worldB.clone();
  state.autoSlope.lerp(worldB, 1 - Math.exp(-dt * auto.targetRate)).normalize();
  deltaAuto.setFromUnitVectors(worldN, state.autoSlope);
  // Turning about the vertical costs no slope: swing the marble round to the side of the piece facing the camera,
  // where no other part of the piece can hide it.
  worldT.copy(state.pos).applyQuaternion(shapeQuat);
  worldT.y = 0;
  const offAxis = worldT.length();
  let yawTarget = 0;
  if (offAxis > 1e-4) {
    const yawErr = Math.atan2(worldT.z * camHoriz.x - worldT.x * camHoriz.z, worldT.dot(camHoriz));
    yawTarget = Math.max(-auto.yawMax, Math.min(auto.yawMax, yawErr)) * Math.min(1, offAxis / 0.3);
  }
  state.autoYaw = (state.autoYaw ?? 0) + (yawTarget - (state.autoYaw ?? 0)) * (1 - Math.exp(-dt * auto.targetRate));
  yawAuto.setFromAxisAngle(WORLD_UP, state.autoYaw);
  outQuat.copy(shapeQuat).premultiply(deltaAuto).premultiply(yawAuto).normalize();
  return outQuat;
}

// The first auto tilt: holds a full target orientation (aim facing the camera) with lively braking and weaving.
const matLocal = new Matrix4();
const matWorld = new Matrix4();
const targetRotMat = new Matrix4();

export function computeAutoTiltQuatOriginal(state, labyrinth, cameraPosition, outQuat, dt) {
  const cells = labyrinth.complex.cells;
  const fx = state.foot.x;
  const fy = state.foot.y;
  const fz = state.foot.z;

  const c0 = state.currentCellId;
  const c1 = labyrinth.nextTowardGoal[c0];
  const c2 = c1 >= 0 ? labyrinth.nextTowardGoal[c1] : -1;
  const c3 = c2 >= 0 ? labyrinth.nextTowardGoal[c2] : -1;
  const gate01 = c1 >= 0 ? findGateBetween(labyrinth, c0, c1) : null;
  const gate12 = c2 >= 0 ? findGateBetween(labyrinth, c1, c2) : null;
  const gate23 = c3 >= 0 ? findGateBetween(labyrinth, c2, c3) : null;

  let turnHazard = 0;
  let forkHazard = 0;
  let squeezeHazard = 0;
  let distGate = 0;

  if (c0 === labyrinth.goalCellId || c1 < 0) {
    lookTarget.fromArray(labyrinth.goalCell.center);
  } else if (gate01) {
    const g1 = gateCoords(labyrinth, gate01, c1);
    const nextCenter = cells[c1].center;
    const p2 = gate12 ? gateCoords(labyrinth, gate12, c2) : nextCenter;
    distGate = Math.hypot(g1[0] - fx, g1[1] - fy, g1[2] - fz);
    const nearGoalGate = c1 === labyrinth.goalCellId && distGate < labyrinth.marbleRadius * 2.2;
    const blendNext = nearGoalGate ? 1.0 : distGate < labyrinth.marbleRadius * 0.70 ? 0.36 : 0.05;
    lookTarget.set(
      g1[0] * (1 - blendNext) + nextCenter[0] * blendNext,
      g1[1] * (1 - blendNext) + nextCenter[1] * blendNext,
      g1[2] * (1 - blendNext) + nextCenter[2] * blendNext,
    );

    // Look 2-3 gates ahead (c0 -> g1 -> g2 -> g3) so the solver starts braking BEFORE reaching a sharp turn or fork!
    tanNow.set(g1[0] - fx, g1[1] - fy, g1[2] - fz);
    const l1 = tanNow.length();
    if (l1 > 1e-5) {
      tanNow.divideScalar(l1);
      tanAhead.set(p2[0] - g1[0], p2[1] - g1[1], p2[2] - g1[2]);
      const l2 = tanAhead.length();
      if (l2 > 1e-5) {
        tanAhead.divideScalar(l2);
        const turnCos1 = tanNow.dot(tanAhead);
        const brakeSpan = Math.max(0.42, labyrinth.marbleRadius * 6.5);
        const prox1 = 1 - Math.min(1, Math.max(0, (distGate - labyrinth.marbleRadius * 0.75) / brakeSpan));
        turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.94 - turnCos1) / 1.0)) * (0.50 + 0.50 * prox1));

        if (c2 >= 0) {
          const p3 = gate23 ? gateCoords(labyrinth, gate23, c3) : cells[c2].center;
          const d23x = p3[0] - p2[0];
          const d23y = p3[1] - p2[1];
          const d23z = p3[2] - p2[2];
          const l3 = Math.hypot(d23x, d23y, d23z);
          if (l3 > 1e-5) {
            const turnCos2 = (tanAhead.x * d23x + tanAhead.y * d23y + tanAhead.z * d23z) / l3;
            const prox2 = 1 - Math.min(1, (distGate + l2) / 0.56);
            turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.90 - turnCos2) / 1.05)) * prox2 * 0.95);
          }
        }
      }
    }

    const deg0 = openDegreeOfCell(labyrinth, c0);
    const deg1 = openDegreeOfCell(labyrinth, c1);
    const deg2 = openDegreeOfCell(labyrinth, c2);
    if ((deg0 >= 3 || deg1 >= 3 || deg2 >= 3) && turnHazard > 0.12) {
      const forkProx = 1 - Math.min(1, distGate / 0.26);
      forkHazard = (deg1 >= 4 || deg0 >= 4 ? 0.92 : 0.78) * (0.45 + 0.55 * forkProx);
    }

    const minPassDiam = (labyrinth.marbleRadius + labyrinth.wallHalfWidth) * 2;
    const gateSpan = gate01.clearSpan ?? gate01.length;
    const gateRatio = gateSpan / Math.max(1e-4, minPassDiam);
    if (gateRatio < 1.18) {
      squeezeHazard = Math.min(0.65, (1.18 - gateRatio) / 0.16);
    }
  } else {
    lookTarget.fromArray(cells[c1].center);
  }

  const goalC = labyrinth.goalCell.center;
  const distGoal = Math.hypot(goalC[0] - fx, goalC[1] - fy, goalC[2] - fz);
  const goalHazard = distGoal < labyrinth.pocketRadius * 2.5
    ? Math.min(0.78, 1 - distGoal / (labyrinth.pocketRadius * 2.5))
    : 0;

  localT.copy(lookTarget).sub(state.foot);
  localT.addScaledVector(state.normal, -localT.dot(state.normal));
  if (localT.lengthSq() < 1e-8) {
    localT.copy(state.smoothAimDir);
  } else {
    localT.normalize();
  }

  // Counter-steer laterally against cross-corridor drift so the ball carves cleanly into turns instead of overshooting forks!
  localB.crossVectors(state.normal, localT).normalize();
  const rawSpeed = state.vel.length();
  const driftCross = state.vel.dot(localB);
  if (rawSpeed > 0.18) {
    const velAlign = state.vel.dot(localT) / rawSpeed;
    turnHazard = Math.max(turnHazard, Math.min(1, Math.max(0, (0.86 - velAlign) / 0.95)));
  }
  localT.addScaledVector(localB, -Math.max(-0.62, Math.min(0.62, driftCross * 0.68))).normalize();

  const curRemDist = labyrinth.distToGoal[c0];
  if (state.bestRemDist === undefined || state.bestGoalCellId !== labyrinth.goalCellId || curRemDist < state.bestRemDist) {
    state.bestGoalCellId = labyrinth.goalCellId;
    state.bestRemDist = curRemDist;
    state.noProgressTime = 0;
  } else {
    state.noProgressTime = (state.noProgressTime ?? 0) + dt;
    if (state.noProgressTime > 5.3) {
      state.bestRemDist = curRemDist;
      state.noProgressTime = 0;
    }
  }

  if (rawSpeed < 0.14) {
    state.stallTime = Math.min(3.5, (state.stallTime ?? 0) + dt);
  } else {
    state.stallTime = Math.max(0, (state.stallTime ?? 0) - dt * 3.2);
  }
  // Human-like recenter-and-thread reflex: if bouncing across a fork or rubbing a post for > 4.05s without advancing closer to Goal,
  // briefly pull back to the current cell's high-clearance hub (4.05..4.60s) then weave through the gate (4.60..5.30s) and reset!
  if (state.noProgressTime > 4.05 && state.noProgressTime < 4.60) {
    const hub = cells[c0].center;
    localT.set(hub[0] - fx, hub[1] - fy, hub[2] - fz);
    localT.addScaledVector(state.normal, -localT.dot(state.normal));
    if (localT.lengthSq() > 1e-7) {
      localT.normalize();
    } else {
      localT.copy(state.smoothAimDir).negate();
    }
    localT.addScaledVector(localB, Math.sin(state.noProgressTime * 6.0) * 0.35).normalize();
  } else if (state.stallTime > 0.45) {
    const weave = Math.sin(state.stallTime * 7.5) * 0.50;
    localT.addScaledVector(localB, weave).normalize();
  } else if (state.noProgressTime > 4.60) {
    const gentleWeave = Math.sin(state.noProgressTime * 6.0) * 0.34;
    localT.addScaledVector(localB, gentleWeave).normalize();
  }
  state.smoothAimDir.lerp(localT, 1 - Math.exp(-dt * 11.0));
  state.smoothAimDir.addScaledVector(state.normal, -state.normal.dot(state.smoothAimDir));
  if (state.smoothAimDir.lengthSq() < 1e-8) {
    state.smoothAimDir.set(0, 0, 1).addScaledVector(state.normal, -state.normal.z);
  }
  state.smoothAimDir.normalize();

  localB.crossVectors(state.normal, state.smoothAimDir).normalize();
  localT.crossVectors(localB, state.normal).normalize();

  const tricky = Math.max(turnHazard, forkHazard, squeezeHazard, goalHazard);
  // Cruise briskly (~0.80) on open straightaways, slow right down (~0.16) before sharp radial turns & forks!
  const desiredSpeed = 0.80 - 0.64 * Math.pow(tricky, 0.70);
  const speedAlong = state.vel.dot(localT);
  const unstickBoost = state.stallTime > 0.2 ? Math.min(0.34, (state.stallTime - 0.2) * 0.55) : 0;

  // Signed board tilt: +28 deg (+0.49 rad) on open runs, ~10 deg (+0.18 rad) feathering turns,
  // and rocks into REVERSE UPHILL TILT (down to -15 deg = -0.26 rad) to visibly brake before tricky forks/bends!
  const cruiseTilt = 0.49 - 0.31 * tricky + unstickBoost;
  const speedError = desiredSpeed - speedAlong;
  const targetTilt = Math.max(
    -0.26,
    Math.min(0.54, cruiseTilt + (speedError < 0 ? speedError * 0.72 : speedError * 0.22)),
  );

  state.smoothTilt = (state.smoothTilt ?? 0.42) + (targetTilt - (state.smoothTilt ?? 0.42)) * (1 - Math.exp(-dt * 7.8));

  camHoriz.set(cameraPosition.x, 0, cameraPosition.z);
  if (camHoriz.lengthSq() < 1e-6) camHoriz.set(0, 0, 1);
  else camHoriz.normalize();

  // Continuous, singularity-free basis through smoothTilt = 0 into negative uphill braking!
  const tiltMag = Math.abs(state.smoothTilt);
  const tiltSign = state.smoothTilt >= 0 ? 1 : -1;
  worldN
    .copy(WORLD_UP)
    .multiplyScalar(Math.cos(tiltMag))
    .addScaledVector(camHoriz, tiltSign * Math.sin(tiltMag))
    .normalize();

  worldT.copy(camHoriz).addScaledVector(worldN, -camHoriz.dot(worldN)).normalize();
  worldB.crossVectors(worldN, worldT).normalize();

  matLocal.makeBasis(localB, state.normal, localT);
  matWorld.makeBasis(worldB, worldN, worldT);
  targetRotMat.copy(matLocal).transpose().premultiply(matWorld);
  outQuat.setFromRotationMatrix(targetRotMat).normalize();
  return outQuat;
}
