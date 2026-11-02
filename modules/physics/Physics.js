import { Vector3, Quaternion } from "three";
import { loadAmmo } from "./ammo.js";

const FORCE_CUTOFF = 0.01;
const CF_KINEMATIC_OBJECT = 2;
const DISABLE_DEACTIVATION = 4;
const TAU = Math.PI * 2;

// Accepts Vector3[] / {x,y,z}[] / flat number arrays; returns a flat array, scaled and deduplicated.
function flattenPoints(points, scale) {
  const out = [];
  const seen = new Set();
  const push = (x, y, z) => {
    x *= scale.x;
    y *= scale.y;
    z *= scale.z;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(x, y, z);
  };
  if (points.length && typeof points[0] === "number") {
    for (let i = 0; i + 2 < points.length; i += 3) push(points[i], points[i + 1], points[i + 2]);
  } else {
    for (const p of points) push(p.x, p.y, p.z);
  }
  return out;
}

// Keeps only the support points along `count` Fibonacci-sphere directions.
function reducePoints(flat, count) {
  const n = flat.length / 3;
  if (n <= count) return flat;
  const keep = new Set();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const dx = Math.cos(golden * i) * r;
    const dz = Math.sin(golden * i) * r;
    let best = 0;
    let bestDot = -Infinity;
    for (let j = 0; j < n; j++) {
      const d = flat[j * 3] * dx + flat[j * 3 + 1] * y + flat[j * 3 + 2] * dz;
      if (d > bestDot) {
        bestDot = d;
        best = j;
      }
    }
    keep.add(best);
  }
  const out = [];
  for (const j of keep) out.push(flat[j * 3], flat[j * 3 + 1], flat[j * 3 + 2]);
  return out;
}

function readVector(v, out) {
  if (Array.isArray(v)) return out.set(v[0], v[1], v[2]);
  return out.set(v.x, v.y, v.z);
}

class Physics {
  constructor(ammo) {
    this.ammo = ammo;
    this.bodies = [];
    this.byId = new Map();
    this.nextId = 1;

    this.config = new ammo.btDefaultCollisionConfiguration();
    this.dispatcher = new ammo.btCollisionDispatcher(this.config);
    this.broadphase = new ammo.btDbvtBroadphase();
    this.solver = new ammo.btSequentialImpulseConstraintSolver();
    this.world = new ammo.btDiscreteDynamicsWorld(
      this.dispatcher,
      this.broadphase,
      this.solver,
      this.config,
    );

    this.transform = new ammo.btTransform();
    this.vec = new ammo.btVector3(0, 0, 0);
    this.vec2 = new ammo.btVector3(0, 0, 0);
    this.quat = new ammo.btQuaternion(0, 0, 0, 1);
    this.tmpQ = new Quaternion();

    this.contacts = [];
    this.cooldown = new Map();
    this.minImpulse = 0.02;
    this.contactCooldown = 0.08;
    this.clock = 0;
    this.idleStrength = 0;
    this.homeStrength = 2.5;
    this.homeTorque = 1.5;
    this.damping = 0.05;
    this.angularDamping = 0.05;
    this.bounce = 0.35;
    this.friction = 0.5;
    this.gravity = new Vector3();
    this.maxStep = 1 / 30;
    this.substeps = 4;
    this.fixedStep = 1 / 120;

    this.vec.setValue(0, 0, 0);
    this.world.setGravity(this.vec);
  }

  // options: { url, wasmBinary } for the Ammo loader plus configure() keys, or an Ammo factory.
  static async create(options = {}) {
    if (typeof options === "function") return new Physics(await options());
    const { url, wasmBinary, ...settings } = options;
    const ammo = await loadAmmo({ url, wasmBinary });
    const physics = new Physics(ammo);
    physics.configure(settings);
    return physics;
  }

  createHullShape(points, scale, { margin, maxPoints = 256 } = {}) {
    const ammo = this.ammo;
    const flat = reducePoints(flattenPoints(points, scale), maxPoints);
    if (flat.length < 12) throw new Error("Physics: a hull needs at least 4 distinct points");
    let radius = 0;
    const hull = new ammo.btConvexHullShape();
    const n = flat.length / 3;
    for (let i = 0; i < n; i++) {
      const x = flat[i * 3];
      const y = flat[i * 3 + 1];
      const z = flat[i * 3 + 2];
      radius = Math.max(radius, Math.hypot(x, y, z));
      this.vec.setValue(x, y, z);
      hull.addPoint(this.vec, i === n - 1);
    }
    hull.setMargin(margin ?? Math.min(0.01, radius * 0.01));
    return { shape: hull, radius };
  }

  makeSphere(radius) {
    return new this.ammo.btSphereShape(radius);
  }

  localInertia(shape, mass) {
    const inertia = new this.ammo.btVector3(0, 0, 0);
    if (mass > 0) shape.calculateLocalInertia(mass, inertia);
    const scalar = mass > 0 ? (inertia.x() + inertia.y() + inertia.z()) / 3 : 1;
    return { inertia, scalar };
  }

  writeTransform(object) {
    const t = this.transform;
    t.setIdentity();
    this.vec.setValue(object.position.x, object.position.y, object.position.z);
    t.setOrigin(this.vec);
    const q = object.quaternion;
    this.quat.setValue(q.x, q.y, q.z, q.w);
    t.setRotation(this.quat);
    return t;
  }

  // Bodies live in object.parent's space: object.position/quaternion are read and written directly.
  addBody(object, shape, options = {}) {
    const ammo = this.ammo;
    const mass = Math.max(options.mass ?? 1, 1e-3);
    const { inertia, scalar } = this.localInertia(shape, mass);

    const motionState = new ammo.btDefaultMotionState(this.writeTransform(object));
    const info = new ammo.btRigidBodyConstructionInfo(mass, motionState, shape, inertia);
    const body = new ammo.btRigidBody(info);
    ammo.destroy(info);
    ammo.destroy(inertia);

    const id = this.nextId++;
    body.setUserIndex(id);
    body.setDamping(this.damping, this.angularDamping);
    body.setRestitution(options.bounce ?? this.bounce);
    body.setFriction(options.friction ?? this.friction);
    body.setActivationState(DISABLE_DEACTIVATION);
    if (options.ccd) {
      body.setCcdMotionThreshold(options.radius * 0.5);
      body.setCcdSweptSphereRadius(options.radius * 0.4);
    }

    const entry = {
      id,
      body,
      object,
      motionState,
      shape,
      mass,
      inertia: scalar,
      radius: options.radius ?? 0.1,
      home: options.home ? readVector(options.home, new Vector3()) : object.position.clone(),
      homeQuaternion: options.homeQuaternion?.clone() ?? object.quaternion.clone(),
      homeStrength: options.homeStrength ?? null,
      homeTorque: options.homeTorque ?? null,
      kinematic: false,
      grabbed: false,
      flags: body.getCollisionFlags(),
      phase: [Math.random() * TAU, Math.random() * TAU, Math.random() * TAU],
      userData: options.userData ?? {},
    };

    this.world.addRigidBody(body);
    this.bodies.push(entry);
    this.byId.set(id, entry);
    if (options.kinematic) this.setKinematic(entry, true);
    return entry;
  }

  // hullPoints are in the object's local space; object.scale is baked in (call replaceHull if it changes).
  addConvex(object, hullPoints, options = {}) {
    const { shape, radius } = this.createHullShape(hullPoints, object.scale, options);
    return this.addBody(object, shape, { ...options, radius: options.radius ?? radius });
  }

  addSphere(object, radius, options = {}) {
    const r = radius * Math.max(object.scale.x, object.scale.y, object.scale.z);
    return this.addBody(object, this.makeSphere(r), { ...options, radius: r });
  }

  // Static infinite plane: normal · p = constant.
  addPlane(normal = { x: 0, y: 1, z: 0 }, constant = 0, { bounce, friction } = {}) {
    const ammo = this.ammo;
    this.vec.setValue(normal.x, normal.y, normal.z);
    const shape = new ammo.btStaticPlaneShape(this.vec, constant);
    const t = new ammo.btTransform();
    t.setIdentity();
    const motionState = new ammo.btDefaultMotionState(t);
    const zero = new ammo.btVector3(0, 0, 0);
    const info = new ammo.btRigidBodyConstructionInfo(0, motionState, shape, zero);
    const body = new ammo.btRigidBody(info);
    ammo.destroy(info);
    ammo.destroy(zero);
    ammo.destroy(t);
    body.setRestitution(bounce ?? this.bounce);
    body.setFriction(friction ?? this.friction);
    this.world.addRigidBody(body);
    const entry = { id: 0, body, motionState, shape, static: true, bounce, friction };
    this.statics ??= [];
    this.statics.push(entry);
    return entry;
  }

  // Kinematic bodies follow their object3d (set it yourself) and still shove dynamic ones.
  setKinematic(entry, kinematic) {
    if (entry.kinematic === kinematic) return;
    const ammo = this.ammo;
    const body = entry.body;
    this.world.removeRigidBody(body);

    const t = this.writeTransform(entry.object);
    body.setWorldTransform(t);
    body.getMotionState().setWorldTransform(t);

    if (kinematic) {
      body.setCollisionFlags(entry.flags | CF_KINEMATIC_OBJECT);
      const zero = new ammo.btVector3(0, 0, 0);
      body.setMassProps(0, zero);
      ammo.destroy(zero);
      this.vec.setValue(0, 0, 0);
      body.setLinearVelocity(this.vec);
      body.setAngularVelocity(this.vec);
    } else {
      body.setCollisionFlags(entry.flags & ~CF_KINEMATIC_OBJECT);
      const { inertia } = this.localInertia(entry.shape, entry.mass);
      body.setMassProps(entry.mass, inertia);
      ammo.destroy(inertia);
    }
    body.updateInertiaTensor();
    body.clearForces();
    entry.kinematic = kinematic;

    this.world.addRigidBody(body);
    body.setActivationState(DISABLE_DEACTIVATION);
    body.activate();
  }

  replaceHull(entry, points, options = {}) {
    const { shape, radius } = this.createHullShape(points, entry.object.scale, options);
    this.replaceShape(entry, shape);
    entry.radius = options.radius ?? radius;
  }

  replaceShape(entry, shape) {
    const ammo = this.ammo;
    const body = entry.body;
    this.world.removeRigidBody(body);
    body.setCollisionShape(shape);
    ammo.destroy(entry.shape);
    entry.shape = shape;

    const { inertia, scalar } = this.localInertia(shape, entry.mass);
    entry.inertia = scalar;
    if (!entry.kinematic) {
      body.setMassProps(entry.mass, inertia);
      body.updateInertiaTensor();
    }
    ammo.destroy(inertia);

    this.world.addRigidBody(body);
    body.activate();
  }

  remove(entry) {
    const ammo = this.ammo;
    if (entry.static) {
      const at = this.statics?.indexOf(entry) ?? -1;
      if (at < 0) return;
      this.statics.splice(at, 1);
    } else {
      const at = this.bodies.indexOf(entry);
      if (at < 0) return;
      this.bodies.splice(at, 1);
      this.byId.delete(entry.id);
    }
    this.world.removeRigidBody(entry.body);
    ammo.destroy(entry.body);
    ammo.destroy(entry.motionState);
    ammo.destroy(entry.shape);
  }

  setMass(entry, value) {
    const mass = Math.max(value, 1e-3);
    if (Math.abs(mass - entry.mass) < 1e-6) return;
    const { inertia, scalar } = this.localInertia(entry.shape, mass);
    entry.mass = mass;
    entry.inertia = scalar;
    if (!entry.kinematic) {
      entry.body.setMassProps(mass, inertia);
      entry.body.updateInertiaTensor();
      entry.body.activate();
    }
    this.ammo.destroy(inertia);
  }

  setVelocity(entry, linear, angular) {
    if (linear) {
      this.vec.setValue(linear.x, linear.y, linear.z);
      entry.body.setLinearVelocity(this.vec);
    }
    if (angular) {
      this.vec.setValue(angular.x, angular.y, angular.z);
      entry.body.setAngularVelocity(this.vec);
    }
    entry.body.activate();
  }

  impulse(entry, impulse) {
    if (entry.kinematic) return;
    this.vec.setValue(impulse.x, impulse.y, impulse.z);
    entry.body.applyCentralImpulse(this.vec);
    entry.body.activate();
  }

  // Critically damped spring of one body toward target (used for grabbing).
  drive(entry, target, strength) {
    if (entry.kinematic) return;
    const kp = strength;
    const kd = 2 * Math.sqrt(kp);
    entry.body.getMotionState().getWorldTransform(this.transform);
    const o = this.transform.getOrigin();
    const v = entry.body.getLinearVelocity();
    entry.body.activate();
    this.vec.setValue(
      entry.mass * ((target.x - o.x()) * kp - v.x() * kd),
      entry.mass * ((target.y - o.y()) * kp - v.y() * kd),
      entry.mass * ((target.z - o.z()) * kp - v.z() * kd),
    );
    entry.body.applyCentralForce(this.vec);
  }

  applyForces() {
    for (const entry of this.bodies) {
      if (entry.kinematic) continue;
      const body = entry.body;
      body.getMotionState().getWorldTransform(this.transform);
      const o = this.transform.getOrigin();
      const x = o.x();
      const y = o.y();
      const z = o.z();

      let fx = 0;
      let fy = 0;
      let fz = 0;

      const homeStrength = entry.grabbed ? 0 : (entry.homeStrength ?? this.homeStrength);
      if (homeStrength > 0) {
        const kp = homeStrength;
        const kd = 2 * Math.sqrt(kp);
        const v = body.getLinearVelocity();
        fx += entry.mass * ((entry.home.x - x) * kp - v.x() * kd);
        fy += entry.mass * ((entry.home.y - y) * kp - v.y() * kd);
        fz += entry.mass * ((entry.home.z - z) * kp - v.z() * kd);
      }

      const t = this.clock;
      const p = entry.phase;
      if (this.idleStrength > 0) {
        const a = this.idleStrength * entry.mass;
        fx += a * Math.sin(t * 0.83 + p[0]) * Math.sin(t * 0.29 + p[1]);
        fy += a * Math.sin(t * 0.97 + p[1]) * Math.sin(t * 0.37 + p[2]);
        fz += a * Math.sin(t * 0.71 + p[2]) * Math.sin(t * 0.23 + p[0]);
      }

      if (fx !== 0 || fy !== 0 || fz !== 0) {
        this.vec.setValue(fx, fy, fz);
        body.applyCentralForce(this.vec);
      }

      let tx = 0;
      let ty = 0;
      let tz = 0;

      const homeTorque = entry.homeTorque ?? this.homeTorque;
      if (homeTorque > 0) {
        const r = this.transform.getRotation();
        // Error rotation home * conj(current), in world space.
        const e = this.tmpQ.set(-r.x(), -r.y(), -r.z(), r.w()).premultiply(entry.homeQuaternion);
        let qx = e.x;
        let qy = e.y;
        let qz = e.z;
        let qw = e.w;
        if (qw < 0) {
          qx = -qx;
          qy = -qy;
          qz = -qz;
          qw = -qw;
        }
        const s = Math.sqrt(qx * qx + qy * qy + qz * qz);
        const kp = homeTorque;
        const kd = 2 * Math.sqrt(kp);
        const w = body.getAngularVelocity();
        let ax = 0;
        let ay = 0;
        let az = 0;
        if (s > 1e-6) {
          const angle = 2 * Math.atan2(s, qw);
          ax = (qx / s) * angle;
          ay = (qy / s) * angle;
          az = (qz / s) * angle;
        }
        tx += entry.inertia * (ax * kp - w.x() * kd);
        ty += entry.inertia * (ay * kp - w.y() * kd);
        tz += entry.inertia * (az * kp - w.z() * kd);
      }

      if (this.idleStrength > 0) {
        const a = this.idleStrength * entry.inertia * 1.5;
        tx += a * Math.sin(t * 0.61 + p[2]);
        ty += a * Math.sin(t * 0.79 + p[0]);
        tz += a * Math.sin(t * 0.53 + p[1]);
      }

      if (tx !== 0 || ty !== 0 || tz !== 0) {
        this.vec2.setValue(tx, ty, tz);
        body.applyTorque(this.vec2);
      }
    }
  }

  falloff(dist, radius, mode) {
    const t = dist / Math.max(radius, 1e-5);
    if (mode === "sharp") return Math.exp(-2 * t * t);
    if (mode === "point") {
      const k = Math.max(0, 1 - t);
      return k * k * 3;
    }
    return 1 / (1 + t * t);
  }

  eachInRange(origin, radius, mode, visit) {
    for (const entry of this.bodies) {
      if (entry.kinematic) continue;
      entry.body.getMotionState().getWorldTransform(this.transform);
      const o = this.transform.getOrigin();
      const dx = o.x() - origin.x;
      const dy = o.y() - origin.y;
      const dz = o.z() - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const falloff = this.falloff(dist, radius, mode);
      if (falloff < FORCE_CUTOFF) continue;
      entry.body.activate();
      visit(entry, dx, dy, dz, dist, falloff);
    }
  }

  // Impulse along direction plus a little outward from origin; strength is an impulse (call per frame × dt for a breeze).
  push(origin, direction, strength, radius, mode = "soft") {
    this.eachInRange(origin, radius, mode, (entry, dx, dy, dz, dist, falloff) => {
      const k = strength * falloff;
      this.vec.setValue(
        (dx * 0.5 + direction.x) * k,
        (dy * 0.5 + direction.y) * k,
        (dz * 0.5 + direction.z) * k,
      );
      entry.body.applyCentralImpulse(this.vec);
    });
  }

  // Off-centre impulse so bodies tumble as well as fly.
  burst(origin, direction, strength, radius, mode = "soft", spin = 1) {
    this.eachInRange(origin, radius, mode, (entry, dx, dy, dz, dist, falloff) => {
      const d = Math.max(dist, 1e-5);
      const nx = -dx / d;
      const ny = -dy / d;
      const nz = -dz / d;
      const mag = strength * falloff;
      const arm = Math.min(d, entry.radius) * spin;
      this.vec.setValue(
        (direction.x * 0.75 - nx * 0.25) * mag,
        (direction.y * 0.75 - ny * 0.25) * mag,
        (direction.z * 0.75 - nz * 0.25) * mag,
      );
      this.vec2.setValue(nx * arm, ny * arm, nz * arm);
      entry.body.applyImpulse(this.vec, this.vec2);
    });
  }

  // Spring every body toward origin, leaving a dead zone of `radius` around it.
  pull(origin, strength, radius = 0, bodies = this.bodies) {
    if (strength <= 0) return;
    const kp = strength;
    const kd = 2 * Math.sqrt(kp);
    for (const entry of bodies) {
      if (entry.kinematic) continue;
      entry.body.getMotionState().getWorldTransform(this.transform);
      const o = this.transform.getOrigin();
      const v = entry.body.getLinearVelocity();
      let dx = origin.x - o.x();
      let dy = origin.y - o.y();
      let dz = origin.z - o.z();
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1e-5) {
        const reach = Math.max(dist - radius, 0) / dist;
        dx *= reach;
        dy *= reach;
        dz *= reach;
      }
      entry.body.activate();
      this.vec.setValue(
        entry.mass * (dx * kp - v.x() * kd),
        entry.mass * (dy * kp - v.y() * kd),
        entry.mass * (dz * kp - v.z() * kd),
      );
      entry.body.applyCentralForce(this.vec);
    }
  }

  setGravity(x, y, z) {
    const g = this.gravity;
    if (x === g.x && y === g.y && z === g.z) return;
    g.set(x, y, z);
    this.vec.setValue(x, y, z);
    this.world.setGravity(this.vec);
  }

  // Partial updates: only the keys present change.
  configure(settings = {}) {
    for (const key of ["homeStrength", "homeTorque", "idleStrength", "minImpulse", "contactCooldown"]) {
      if (settings[key] !== undefined) this[key] = settings[key];
    }
    for (const key of ["maxStep", "substeps", "fixedStep"]) {
      if (settings[key] !== undefined) this[key] = settings[key];
    }
    const damping = settings.damping ?? this.damping;
    const angularDamping = settings.angularDamping ?? settings.damping ?? this.angularDamping;
    if (damping !== this.damping || angularDamping !== this.angularDamping) {
      this.damping = damping;
      this.angularDamping = angularDamping;
      for (const entry of this.bodies) entry.body.setDamping(damping, angularDamping);
    }
    if (settings.bounce !== undefined && settings.bounce !== this.bounce) {
      this.bounce = settings.bounce;
      for (const entry of this.bodies) entry.body.setRestitution(this.bounce);
      for (const entry of this.statics ?? []) if (entry.bounce === undefined) entry.body.setRestitution(this.bounce);
    }
    if (settings.friction !== undefined && settings.friction !== this.friction) {
      this.friction = settings.friction;
      for (const entry of this.bodies) entry.body.setFriction(this.friction);
      for (const entry of this.statics ?? []) if (entry.friction === undefined) entry.body.setFriction(this.friction);
    }
    if (settings.gravity !== undefined) {
      const g = readVector(settings.gravity, new Vector3());
      this.setGravity(g.x, g.y, g.z);
    }
  }

  // Returns [{ impulse, a, b, x, y, z }] for this step; a/b are body entries (null for statics).
  collectContacts() {
    this.contacts.length = 0;
    const count = this.dispatcher.getNumManifolds();
    for (let i = 0; i < count; i++) {
      const manifold = this.dispatcher.getManifoldByIndexInternal(i);
      const points = manifold.getNumContacts();
      if (points === 0) continue;

      let impulse = 0;
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let j = 0; j < points; j++) {
        const p = manifold.getContactPoint(j);
        const value = p.getAppliedImpulse();
        if (value > impulse) {
          impulse = value;
          const w = p.get_m_positionWorldOnB();
          px = w.x();
          py = w.y();
          pz = w.z();
        }
      }
      if (impulse < this.minImpulse) continue;

      const a = manifold.getBody0().getUserIndex();
      const b = manifold.getBody1().getUserIndex();
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      const last = this.cooldown.get(key) ?? -1e9;
      if (this.clock - last < this.contactCooldown) continue;
      this.cooldown.set(key, this.clock);

      this.contacts.push({
        impulse,
        a: this.byId.get(a) ?? null,
        b: this.byId.get(b) ?? null,
        x: px,
        y: py,
        z: pz,
      });
    }
    if (this.cooldown.size > 64) {
      for (const [key, time] of this.cooldown) if (this.clock - time >= this.contactCooldown) this.cooldown.delete(key);
    }
    return this.contacts;
  }

  step(dt) {
    if (!(dt > 0)) return;
    this.clock += dt;

    for (const entry of this.bodies) {
      if (entry.kinematic) entry.body.getMotionState().setWorldTransform(this.writeTransform(entry.object));
    }

    this.applyForces();
    this.world.stepSimulation(Math.min(dt, this.maxStep), this.substeps, this.fixedStep);
    this.collectContacts();

    for (const entry of this.bodies) {
      if (entry.kinematic) continue;
      entry.body.getMotionState().getWorldTransform(this.transform);
      const o = this.transform.getOrigin();
      const q = this.transform.getRotation();
      entry.object.position.set(o.x(), o.y(), o.z());
      entry.object.quaternion.set(q.x(), q.y(), q.z(), q.w());
    }
  }

  dispose() {
    for (const entry of [...this.bodies, ...(this.statics ?? [])]) this.remove(entry);
    const ammo = this.ammo;
    ammo.destroy(this.world);
    ammo.destroy(this.solver);
    ammo.destroy(this.broadphase);
    ammo.destroy(this.dispatcher);
    ammo.destroy(this.config);
    ammo.destroy(this.transform);
    ammo.destroy(this.vec);
    ammo.destroy(this.vec2);
    ammo.destroy(this.quat);
    this.cooldown.clear();
  }
}

export { Physics, loadAmmo };
