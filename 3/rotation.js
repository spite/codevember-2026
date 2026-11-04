import { Quaternion, Vector3, Vector2 } from "three";

const MODES = ["Rock", "Tumble", "Still"];
const ROCK_TILT = 0.55;
const ROCK_PERIOD = 22;
// The rock axis turns relative to the body, so the low point sweeps a rosette over the underside.
const ROCK_PRECESSION = (2 * Math.PI) / 37;
const TUMBLE_RATE = 0.09;
const FLIP_TIME = 2.5;
const DECAY = 2;
const MAX_SPIN = 10;
const BLEND_TIME = 1.5;

const Y = new Vector3(0, 1, 0);
const _a = new Vector3();
const _v = new Vector3();
const _q = new Quaternion();
const _r = new Quaternion();
const _m = new Quaternion();
const _mi = new Quaternion();
const _tilt = new Quaternion();
const _tiltAxis = new Vector3();

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInOutCubicSlope = (t) => (t < 0.5 ? 12 * t * t : 3 * Math.pow(-2 * t + 2, 2));

// Exp map: rotation by vector w (axis * angle) into out.
function expMap(out, w, scale = 1) {
  const angle = w.length() * scale;
  if (Math.abs(angle) < 1e-9) return out.identity();
  return out.setFromAxisAngle(_a.copy(w).normalize(), angle);
}

// Body orientation q = M(mode) · U. M is the automatic motion about world axes; U collects drag, inertia and Flip.
// With hit and press, a press on the object is a hold (press.start/release) until it moves past a few pixels, when it
// cancels and turns the object instead; hit(x, y) returns null off the object, which leaves the press to OrbitControls.
export function createRotation({ body, camera, controls, domElement, radius = () => 1, mode = () => "Rock", spin = () => 0.12, shutter = () => 1 / 30, hit = null, press = null }) {
  const user = new Quaternion();
  const omega = new Vector3(); // world angular velocity of drag/inertia
  const flipOmega = new Vector3();
  const state = { spin: 0, rock: 0, precession: 0, tumble: 0 };
  let currentMode = mode();
  let weight = 1; // how much of the mode's own rate is running; 0 while dragging
  let flip = null;
  let dragging = null;
  let pressing = null;
  const pending = new Vector2();
  let pinch = null;
  const touches = new Map();
  let controlsWas = true;

  function modeQuaternion(out, m, s) {
    out.setFromAxisAngle(Y, m === "Still" ? 0 : s.spin);
    if (m === "Rock") {
      const p = s.precession;
      out.multiply(_tilt.setFromAxisAngle(_tiltAxis.set(Math.cos(p), 0, Math.sin(p)), ROCK_TILT * Math.sin(s.rock)));
    } else if (m === "Tumble") {
      out.multiply(_tilt.setFromAxisAngle(_tiltAxis.set(1, 0, 0), s.tumble));
    }
    return out;
  }

  function advance(s, m, dt, w) {
    if (m !== "Still") s.spin += spin() * dt * w;
    if (m === "Rock") {
      s.rock += ((2 * Math.PI) / ROCK_PERIOD) * dt * w;
      s.precession += ROCK_PRECESSION * dt * w;
    }
    if (m === "Tumble") s.tumble += TUMBLE_RATE * dt * w;
    return s;
  }

  // Applies a world-space rotation to the body while keeping M untouched: U ← M⁻¹ · R · M · U.
  function rotateWorld(r) {
    modeQuaternion(_m, currentMode, state);
    _mi.copy(_m).invert();
    user.premultiply(_q.copy(_m)).premultiply(r).premultiply(_mi).normalize();
  }

  function compose(out) {
    return modeQuaternion(out, currentMode, state).multiply(user);
  }

  function setMode(m) {
    if (m === currentMode || !MODES.includes(m)) return;
    // Keep the pose: re-express U against the new mode at fresh phases, then blend the new motion in.
    compose(_q);
    currentMode = m;
    state.rock = 0;
    state.tumble = 0;
    modeQuaternion(_m, currentMode, state);
    user.copy(_m.invert()).multiply(_q).normalize();
    weight = 0;
  }

  function startFlip() {
    if (flip) return;
    const axis = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    axis.y = 0;
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    flip = { axis: axis.normalize(), t: 0 };
  }

  // ------------------------------------------------------------ pointer

  const center = new Vector3();
  function screenCircle() {
    const rect = domElement.getBoundingClientRect();
    body.getWorldPosition(center);
    const dist = center.distanceTo(camera.position);
    const ndc = center.clone().project(camera);
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const r = radius() / Math.max(dist, 1e-3);
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      r: (Math.min(r, 0.99) / Math.sqrt(1 - Math.min(r * r, 0.98))) / tanHalf * (rect.height / 2),
    };
  }

  function grab() {
    if (!controls) return;
    controlsWas = controls.enabled;
    controls.enabled = false;
  }

  function ungrab() {
    if (controls) controls.enabled = controlsWas;
  }

  // Synthetic or already-released pointers throw here.
  function capture(id) {
    try {
      domElement.setPointerCapture?.(id);
    } catch {}
  }

  function startDrag(id, x, y) {
    dragging = { id, x, y, r: Math.max(screenCircle().r, 40), moved: performance.now() };
    omega.set(0, 0, 0);
  }

  function onPointerDown(e) {
    if (e.target !== domElement) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger on a body press or drag turns it into a pinch zoom; OrbitControls never saw the first finger.
    if ((dragging || pressing) && e.pointerType === "touch" && touches.size === 2) {
      if (pressing) press.cancel();
      pressing = null;
      endDrag(false);
      pinch = { spread: spread() };
      return;
    }
    if (dragging || pressing || pinch || touches.size > 1) return;
    if (hit && press) {
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      grab();
      pressing = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), slop: e.pointerType === "mouse" ? 5 : 10 };
      press.start(h);
      capture(e.pointerId);
      return;
    }
    const c = screenCircle();
    if (Math.hypot(e.clientX - c.x, e.clientY - c.y) > c.r) return;
    grab();
    startDrag(e.pointerId, e.clientX, e.clientY);
    pending.set(0, 0);
    capture(e.pointerId);
  }

  function spread() {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  function onPointerMove(e) {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const s = spread();
      const dir = camera.position.clone().sub(controls.target);
      const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, (dir.length() * pinch.spread) / s));
      camera.position.copy(controls.target).add(dir.setLength(d));
      pinch.spread = s;
      return;
    }
    if (pressing && e.pointerId === pressing.id) {
      const dx = e.clientX - pressing.x0, dy = e.clientY - pressing.y0;
      if (Math.hypot(dx, dy) <= pressing.slop) return;
      press.cancel();
      pressing = null;
      // The motion up to here turns the object too.
      startDrag(e.pointerId, e.clientX, e.clientY);
      pending.set(dx, dy);
      return;
    }
    if (!dragging || e.pointerId !== dragging.id) return;
    pending.x += e.clientX - dragging.x;
    pending.y += e.clientY - dragging.y;
    dragging.x = e.clientX;
    dragging.y = e.clientY;
  }

  function endDrag(release) {
    if (!dragging) return;
    if (domElement.hasPointerCapture?.(dragging.id)) domElement.releasePointerCapture(dragging.id);
    if (!release) omega.set(0, 0, 0);
    dragging = null;
  }

  function endPress(e) {
    if (domElement.hasPointerCapture?.(pressing.id)) domElement.releasePointerCapture(pressing.id);
    if (e && e.type === "pointerup") press.release((performance.now() - pressing.t0) / 1000);
    else press.cancel();
    pressing = null;
  }

  function onPointerUp(e) {
    touches.delete(e.pointerId);
    if (pressing && e.pointerId === pressing.id) {
      endPress(e);
      ungrab();
      return;
    }
    if (pinch) {
      if (touches.size < 2) {
        pinch = null;
        ungrab();
      }
      return;
    }
    if (dragging && e.pointerId === dragging.id) {
      endDrag(e.type === "pointerup");
      ungrab();
    }
  }

  // Capture phase so this runs before OrbitControls' own pointerdown.
  domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // ------------------------------------------------------------ frame

  const dragRot = new Quaternion();
  const measured = new Vector3();
  const shutterQ = new Quaternion();
  const back = { spin: 0, rock: 0, precession: 0, tumble: 0 };

  function update(dt) {
    if (mode() !== currentMode) setMode(mode());

    if (dragging) {
      const now = performance.now();
      // Rolling-ball trackball: one radian per projected radius of drag, about the camera-space axis ⟂ to the drag.
      const len = pending.length();
      if (len > 0) {
        const angle = len / dragging.r;
        _v.set(pending.y / len, pending.x / len, 0).applyQuaternion(camera.quaternion);
        rotateWorld(dragRot.setFromAxisAngle(_v, angle));
        if (dt > 0) measured.copy(_v).multiplyScalar(angle / Math.max(dt, (now - dragging.moved) / 1000));
        dragging.moved = now;
        pending.set(0, 0);
      } else if (now - dragging.moved > 50) measured.set(0, 0, 0);
      if (dt > 0) omega.lerp(measured, 1 - Math.exp(-dt / 0.04));
      if (omega.length() > MAX_SPIN) omega.setLength(MAX_SPIN);
      weight = Math.max(0, weight - dt * 4);
    } else if (dt > 0) {
      rotateWorld(expMap(dragRot, omega, dt));
      omega.multiplyScalar(Math.exp(-DECAY * dt));
      if (omega.lengthSq() < 1e-6) omega.set(0, 0, 0);
      // The mode comes back as the throw dies down.
      const settle = Math.min(1, Math.max(0, 1 - omega.length() / 0.5));
      weight = Math.min(settle, weight + dt / BLEND_TIME);
    }

    flipOmega.set(0, 0, 0);
    if (flip && dt > 0) {
      const t0 = flip.t;
      flip.t = Math.min(1, t0 + dt / FLIP_TIME);
      const angle = Math.PI * (easeInOutCubic(flip.t) - easeInOutCubic(t0));
      rotateWorld(dragRot.setFromAxisAngle(flip.axis, angle));
      if (flip.t >= 1) flip = null;
      else flipOmega.copy(flip.axis).multiplyScalar((Math.PI / FLIP_TIME) * easeInOutCubicSlope(flip.t));
    } else if (flip) {
      flipOmega.copy(flip.axis).multiplyScalar((Math.PI / FLIP_TIME) * easeInOutCubicSlope(flip.t));
    }

    advance(state, currentMode, dt, weight);
    compose(body.quaternion);
    body.updateMatrixWorld();
    updateShutter();
  }

  // Pose at time − shutter/2: the mode evaluated at its earlier phases, and U rolled back by the user's ω.
  function updateShutter() {
    const h = shutter() / 2;
    Object.assign(back, state);
    advance(back, currentMode, -h, weight);
    _a.copy(omega).add(flipOmega);
    expMap(_r, _a, -h);
    modeQuaternion(_m, currentMode, state);
    // q_sh = M(t−h) · M(t)⁻¹ · exp(−ω h) · q
    shutterQ.copy(body.quaternion).premultiply(_r).premultiply(_mi.copy(_m).invert());
    shutterQ.premultiply(modeQuaternion(_m, currentMode, back)).normalize();
    const d = body.userData;
    d.shutterMatrixWorld.compose(body.getWorldPosition(_v), shutterQ, body.getWorldScale(_a));
  }

  // World angular velocity of the body, for the drips and the debug overlay.
  function angularVelocity(out = new Vector3()) {
    const h = 1 / 240;
    Object.assign(back, state);
    advance(back, currentMode, -h, weight);
    modeQuaternion(_m, currentMode, back).invert();
    modeQuaternion(_q, currentMode, state).multiply(_m);
    if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
    const angle = 2 * Math.acos(Math.min(1, _q.w));
    const s = Math.sqrt(Math.max(1 - _q.w * _q.w, 0));
    out.set(0, 0, 0);
    if (s > 1e-9) out.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(angle / h);
    return out.add(omega).add(flipOmega);
  }

  function reset() {
    if (pressing) {
      endPress(null);
      ungrab();
    }
    if (dragging) {
      endDrag(false);
      if (!pinch) ungrab();
    }
    pending.set(0, 0);
    measured.set(0, 0, 0);
    user.identity();
    omega.set(0, 0, 0);
    flipOmega.set(0, 0, 0);
    weight = 1;
    flip = null;
    Object.assign(state, { spin: 0, rock: 0, precession: 0, tumble: 0 });
  }

  function dispose() {
    if (pressing) endPress(null);
    endDrag(false);
    domElement.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  }

  return {
    update,
    flip: startFlip,
    reset,
    dispose,
    angularVelocity,
    omega,
    get flipping() {
      return flip !== null;
    },
    get dragging() {
      return dragging !== null;
    },
    get pressing() {
      return pressing !== null;
    },
    get mode() {
      return currentMode;
    },
  };
}

export const MOTION_MODES = MODES;
