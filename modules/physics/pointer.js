import { Raycaster, Vector2, Vector3, Plane, Matrix4, Quaternion } from "three";

const defaults = {
  enabled: true,
  grabStrength: 60, // drive spring stiffness toward the pointer
  throwStrength: 0.6, // fraction of pointer velocity added on release
  maxThrow: 12,
  hoverStrength: 0.01, // per-frame (at 60fps) push impulse along the ray
  hoverRadius: 0.6,
  tapStrength: 1.2, // burst impulse when tapping empty space
  tapRadius: 0.8,
  tapSpin: 1,
  falloff: "soft",
  tapDistance: 6, // px of movement still counted as a tap
  tapTime: 300, // ms
  grabAtPoint: false, // drag by the grabbed point (shapes swing and spin) instead of the centre
};

// Drag a body to shove others, release to throw it; tap empty space to burst, hover to nudge.
// Call update(dt) every frame before physics.step(dt).
export function createPointer({ physics, camera, domElement, controls = null, space = null, filter = null, ...options }) {
  const settings = { ...defaults, ...options };
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const plane = new Plane();
  const hit = new Vector3();
  const local = new Vector3();
  const prevLocal = new Vector3();
  const velocity = new Vector3();
  const offset = new Vector3();
  const target = new Vector3();
  const dir = new Vector3();
  const tmp = new Vector3();
  const viewDir = new Vector3();
  const inverse = new Matrix4();
  const anchor = new Vector3();
  const unrotate = new Quaternion();

  let over = false;
  let grabbed = null;
  let grabId = -1;
  let controlsWas = true;
  let down = null;
  let hasPrev = false;

  function setPointer(e) {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
  }

  function spaceOf(entry) {
    return space ?? entry?.object.parent ?? physics.bodies[0]?.object.parent ?? null;
  }

  function toLocal(point, parent) {
    if (parent) parent.worldToLocal(point);
    return point;
  }

  function localDir(out, parent) {
    out.copy(raycaster.ray.direction);
    if (parent) out.transformDirection(inverse.copy(parent.matrixWorld).invert());
    return out;
  }

  function pick() {
    const map = new Map();
    const objects = [];
    for (const entry of physics.bodies) {
      if (entry.kinematic || (filter && !filter(entry))) continue;
      map.set(entry.object, entry);
      objects.push(entry.object);
    }
    const hits = raycaster.intersectObjects(objects, true);
    for (const h of hits) {
      for (let o = h.object; o; o = o.parent) {
        const entry = map.get(o);
        if (entry) return { entry, point: h.point };
      }
    }
    return null;
  }

  // Plane facing the camera through `point` (world space).
  function planeThrough(point) {
    camera.getWorldDirection(viewDir);
    plane.setFromNormalAndCoplanarPoint(viewDir, point);
  }

  function pointerOnPlane(out) {
    return raycaster.ray.intersectPlane(plane, out) !== null;
  }

  function scenePlane() {
    const parent = spaceOf(null);
    if (controls?.target) planeThrough(controls.target);
    else planeThrough(parent ? parent.getWorldPosition(tmp) : tmp.set(0, 0, 0));
    if (!pointerOnPlane(hit)) return null;
    return toLocal(local.copy(hit), parent);
  }

  function release(throwIt) {
    if (!grabbed) return;
    const entry = grabbed;
    entry.grabbed = false;
    entry.freeSpin = false;
    grabbed = null;
    if (throwIt && settings.throwStrength > 0) {
      const speed = velocity.length();
      const k = speed > settings.maxThrow ? settings.maxThrow / speed : 1;
      physics.impulse(entry, tmp.copy(velocity).multiplyScalar(entry.mass * settings.throwStrength * k));
    }
    if (controls) controls.enabled = controlsWas;
    if (grabId >= 0 && domElement.hasPointerCapture?.(grabId)) domElement.releasePointerCapture(grabId);
    grabId = -1;
  }

  function onPointerDown(e) {
    if (!settings.enabled || e.target !== domElement) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (grabbed) return;
    setPointer(e);
    over = true;
    down = { x: e.clientX, y: e.clientY, time: performance.now(), id: e.pointerId };
    const found = pick();
    if (!found) return;

    grabbed = found.entry;
    grabbed.grabbed = true;
    grabId = e.pointerId;
    planeThrough(found.point);
    const parent = spaceOf(grabbed);
    toLocal(local.copy(found.point), parent);
    offset.copy(grabbed.object.position).sub(local);
    if (settings.grabAtPoint) {
      // The grabbed point in the body's own frame, so it stays put on the shape as it turns.
      anchor.copy(local).sub(grabbed.object.position).applyQuaternion(unrotate.copy(grabbed.object.quaternion).invert());
      grabbed.freeSpin = true;
    }
    prevLocal.copy(local);
    velocity.set(0, 0, 0);
    hasPrev = true;
    if (controls) {
      controlsWas = controls.enabled;
      controls.enabled = false;
    }
    domElement.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    if (grabbed && e.pointerId !== grabId) return;
    setPointer(e);
    over = e.target === domElement || grabbed !== null;
  }

  function onPointerUp(e) {
    if (grabbed) {
      if (e.pointerId === grabId) release(true);
      down = null;
      return;
    }
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.time < settings.tapTime;
    down = null;
    if (!settings.enabled || moved > settings.tapDistance || !quick) return;
    setPointer(e);
    const point = scenePlane();
    if (!point) return;
    localDir(dir, spaceOf(null));
    physics.burst(point, dir, settings.tapStrength, settings.tapRadius, settings.falloff, settings.tapSpin);
  }

  function onPointerCancel(e) {
    if (grabbed && e.pointerId === grabId) release(false);
    down = null;
  }

  function onLeave() {
    if (!grabbed) over = false;
  }

  // Capture phase on the canvas so we run before OrbitControls' own pointerdown.
  domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  domElement.addEventListener("pointerleave", onLeave);

  function update(dt) {
    if (!settings.enabled) {
      release(false);
      return;
    }
    if (grabbed) {
      if (!physics.bodies.includes(grabbed) || grabbed.kinematic) {
        release(false);
        return;
      }
      if (!pointerOnPlane(hit)) return;
      const parent = spaceOf(grabbed);
      toLocal(local.copy(hit), parent);
      if (hasPrev && dt > 0) {
        tmp.copy(local).sub(prevLocal).divideScalar(dt);
        velocity.lerp(tmp, Math.min(1, dt * 20));
      }
      prevLocal.copy(local);
      hasPrev = true;
      // Paused frames never step, so a drive force would pile up in Bullet until the next step.
      if (settings.grabAtPoint) {
        if (dt > 0) physics.drive(grabbed, local, settings.grabStrength, anchor);
      } else {
        target.copy(local).add(offset);
        if (dt > 0) physics.drive(grabbed, target, settings.grabStrength);
      }
      return;
    }
    if (over && settings.hoverStrength > 0 && dt > 0) {
      const point = scenePlane();
      if (!point) return;
      localDir(dir, spaceOf(null)).multiplyScalar(0.25);
      physics.push(point, dir, settings.hoverStrength * dt * 60, settings.hoverRadius, settings.falloff);
    }
  }

  function dispose() {
    release(false);
    domElement.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    domElement.removeEventListener("pointerleave", onLeave);
  }

  return {
    settings,
    update,
    dispose,
    release: () => release(false),
    get grabbed() {
      return grabbed;
    },
    get grabbing() {
      return grabbed !== null;
    },
  };
}
