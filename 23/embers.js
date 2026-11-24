import { InstancedMesh, SphereGeometry, Matrix4, Matrix3, Vector3, Quaternion, Color, DynamicDrawUsage, DataUtils } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { nativeRandom } from "modules/random.js";

const UP = new Vector3(0, 1, 0);

// Embers keep this far outside the undisplaced shape's surface (plates stand up to ~0.09 above it)
const CLEARANCE = 0.1;

// Half float to float, by table
const HALF = new Float32Array(65536);
for (let i = 0; i < 65536; i++) HALF[i] = DataUtils.fromHalfFloat(i);

// Turbulent air: the curl of a vector potential made of drifting plane waves, so it is divergence-free
// and full of eddies. For psi = sum A sin(k.p + w t + f), curl psi = sum cos(k.p + w t + f) (k x A).
const WAVES = (() => {
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 10 }, () => {
    const k = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(1.1 + r() * 2.6);
    const a = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(0.3 / k.length());
    return { k, c: new Vector3().crossVectors(k, a), w: 0.15 + r() * 0.45, f: r() * Math.PI * 2 };
  });
})();

function airFlow(p, t, out) {
  out.set(0, 0, 0);
  for (const { k, c, w, f } of WAVES) out.addScaledVector(c, Math.cos(k.dot(p) + w * t + f));
  return out;
}

// Embers leave the hot surface with a small kick, rise on buoyancy that fades as they cool, and are carried
// by turbulent air with some inertia, so they get caught in eddies, spiral and drift on. They flicker and cool.
class EmberSystem {
  constructor(quality = "high") {
    this.count = quality === "low" ? 90 : 220;
    this.uniforms = { uHeat: { value: 0.72 } };
    this.material = new PipelineMaterial({
      color: 0x110502,
      roughness: 0.3,
      metalness: 0.0,
      uniforms: this.uniforms,
      fragmentPars: /* glsl */ `
uniform float uHeat;
vec3 emberBlackbody(float t) {
  float x = clamp(t, 0.0, 1.25);
  vec3 c1 = vec3(0.45, 0.02, 0.0);
  vec3 c2 = vec3(2.0, 0.2, 0.0);
  vec3 c3 = vec3(5.0, 1.5, 0.0);
  vec3 c4 = vec3(9.0, 4.4, 0.4);
  vec3 col = mix(vec3(0.0), c1, smoothstep(0.05, 0.25, x));
  col = mix(col, c2, smoothstep(0.22, 0.5, x));
  col = mix(col, c3, smoothstep(0.48, 0.82, x));
  col = mix(col, c4, smoothstep(0.80, 1.15, x));
  return col;
}
`,
      surface: /* glsl */ `
void surface(inout Surface s) {
  float temp = vColor.r * mix(0.4, 1.2, uHeat);
  s.albedo = vec3(0.02, 0.005, 0.002);
  s.emissive = emberBlackbody(temp);
}
`,
    });

    this.geometry = new SphereGeometry(0.012, 10, 6);
    this.mesh = new InstancedMesh(this.geometry, this.material, this.count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;

    this.emitters = null;
    this.source = null;
    this.time = 0;
    this._embers = Array.from({ length: this.count }, () => this._blank());
    this._mat = new Matrix4();
    this._normalMat = new Matrix3();
    this._quat = new Quaternion();
    this._scale = new Vector3();
    this._col = new Color();
    this._p = new Vector3();
    this._n = new Vector3();
    this._dir = new Vector3();
    this._draw = new Vector3();
    this._air = new Vector3();
    this._prevWorld = new Matrix4();
    this._hasPrev = false;
    this._surfVel = new Vector3();
    this._local = new Vector3();
    this._invWorld = new Matrix4();
    this.collider = null;
    this._field = null;

    this.reset();
    for (let i = 0; i < this.count; i++) this.mesh.setColorAt(i, this._col.setRGB(1, 1, 1));
    this.mesh.instanceColor.needsUpdate = true;
  }

  _blank() {
    return {
      pos: new Vector3(),
      vel: new Vector3(),
      age: 0,
      life: 0,
      alive: false,
      size: 1,
      heat: 1,
      inertia: 0.4,
      flicker: 0,
      glow: 0,
    };
  }

  // Collider: a function returning the shown shape's distance field { data (half floats), size, bound } in the
  // source mesh's object space, or null while there is no solid rock
  setCollider(getField) {
    this.collider = getField;
  }

  // Signed distance at an object-space point, trilinear
  _distance(x, y, z) {
    const { data, size: n, bound } = this._field;
    const g = (c) => Math.min(n - 1.001, Math.max(0, ((c / bound) * 0.5 + 0.5) * n - 0.5));
    const gx = g(x), gy = g(y), gz = g(z);
    const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz);
    const fx = gx - i, fy = gy - j, fz = gz - k;
    const at = (a, b, c) => HALF[data[(c * n + b) * n + a]];
    const lerp = (a, b, t) => a + (b - a) * t;
    const c00 = lerp(at(i, j, k), at(i + 1, j, k), fx);
    const c10 = lerp(at(i, j + 1, k), at(i + 1, j + 1, k), fx);
    const c01 = lerp(at(i, j, k + 1), at(i + 1, j, k + 1), fx);
    const c11 = lerp(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), fx);
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
  }

  // Embers stay in the air; the rock pushes them aside as it moves: a soft cushion above the surface, no
  // velocity into it relative to the surface's own motion, and a hard floor just above the plate tops
  _collide(e, dt) {
    this._local.copy(e.pos).applyMatrix4(this._invWorld);
    const { x, y, z } = this._local;
    const d = this._distance(x, y, z);
    const cushion = 0.08;
    if (d >= CLEARANCE + cushion) return;
    const h = 0.03;
    this._n.set(
      this._distance(x + h, y, z) - this._distance(x - h, y, z),
      this._distance(x, y + h, z) - this._distance(x, y - h, z),
      this._distance(x, y, z + h) - this._distance(x, y, z - h),
    );
    if (this._n.lengthSq() < 1e-12) return;
    this._n.normalize().applyMatrix3(this._normalMat).normalize();
    // Velocity of the rock's surface at this point, from its pose last frame
    if (dt > 0) this._surfVel.copy(this._local).applyMatrix4(this._prevWorld).sub(e.pos).multiplyScalar(-1 / dt);
    else this._surfVel.set(0, 0, 0);
    const push = 1 - (d - CLEARANCE) / cushion;
    e.vel.addScaledVector(this._n, Math.min(push, 2) * 1.5 * dt);
    const into = e.vel.dot(this._n) - this._surfVel.dot(this._n);
    if (d < CLEARANCE && into < 0) e.vel.addScaledVector(this._n, Math.min(-into, 0.6));
    const floor = CLEARANCE * 0.9;
    if (d < floor) e.pos.addScaledVector(this._n, floor - d);
  }

  // Emitters: Float32Array of (position, normal, heat) per point in the source mesh's object space
  get particles() {
    return this._embers;
  }

  get anyAlive() {
    return this._embers.some((e) => e.alive);
  }

  setEmitters(emitters, source) {
    this.emitters = emitters && emitters.length ? emitters : null;
    this.source = source;
  }

  // Everyone dead, each with a staggered delay so the stream starts gradually
  reset() {
    for (const e of this._embers) {
      e.alive = false;
      e.age = -nativeRandom() * 4;
    }
  }

  _launch(e, pos, normal, heat) {
    const r = nativeRandom;
    e.pos.copy(pos).addScaledVector(normal, CLEARANCE);
    e.vel.copy(normal).multiplyScalar(0.12 + r() * 0.25);
    e.vel.y += 0.08 + r() * 0.15;
    e.age = 0;
    e.life = 2.5 + r() * 3.5;
    e.alive = true;
    e.size = 0.5 + r() * 0.9;
    e.heat = 0.8 + heat * 0.45;
    e.inertia = 0.25 + r() * 0.5;
    e.flicker = r() * 100;
  }

  // weights: one per emitter, how bright the flowing lava there is right now (null: all equal)
  setSpawnWeights(weights) {
    this.spawnWeights = weights;
  }

  _spawnFromEmitter(e) {
    const em = this.emitters;
    const count = em.length / 7;
    // Favour emitters where the flowing lava is bright right now: rejection against the current pulse
    let idx = Math.floor(nativeRandom() * count);
    const w = this.spawnWeights;
    if (w && w.length === count) {
      for (let tries = 0; tries < 12; tries++) {
        if (nativeRandom() * 2.2 < w[idx] * w[idx]) break;
        idx = Math.floor(nativeRandom() * count);
      }
    }
    const k = idx * 7;
    this.source.updateMatrixWorld();
    this._p.set(em[k], em[k + 1], em[k + 2]).applyMatrix4(this.source.matrixWorld);
    this._normalMat.getNormalMatrix(this.source.matrixWorld);
    this._n.set(em[k + 3], em[k + 4], em[k + 5]).applyMatrix3(this._normalMat).normalize();
    this._launch(e, this._p, this._n, em[k + 6]);
    // Leaves with the speed of the rock's surface where it was born
    if (this._hasPrev && this._dt > 0) {
      this._local.set(em[k], em[k + 1], em[k + 2]).applyMatrix4(this._prevWorld);
      this._surfVel.subVectors(this._p, this._local).divideScalar(this._dt);
      if (this._surfVel.lengthSq() < 9) e.vel.add(this._surfVel);
    }
  }

  // A few embers from an arbitrary point (used while the rock melts)
  burst(worldPoint, count = 8) {
    let n = 0;
    for (const e of this._embers) {
      if (n >= count) break;
      if (!e.alive || e.age > e.life * 0.6) {
        this._n.copy(worldPoint).normalize();
        this._launch(e, worldPoint, this._n, 0.8);
        n++;
      }
    }
  }

  // spawn: false lets the live embers play out without starting new ones (while paused)
  update(dt, state, { spawn = true } = {}) {
    this.uniforms.uHeat.value = state.heat;
    const amt = state.embers;
    this.mesh.visible = amt > 0.01;
    if (!this.mesh.visible) return;
    this.time += dt;
    this._dt = dt;
    const time = this.time;
    const active = Math.round(this.count * amt);
    const solid = this.emitters && this.source && this.source.visible;
    const canSpawn = solid && spawn;
    this._field = solid && this.collider ? this.collider() : null;
    if (this._field) {
      this.source.updateMatrixWorld();
      this._invWorld.copy(this.source.matrixWorld).invert();
      this._normalMat.getNormalMatrix(this.source.matrixWorld);
      if (!this._hasPrev) this._prevWorld.copy(this.source.matrixWorld);
    }

    for (let i = 0; i < this.count; i++) {
      const e = this._embers[i];
      if (i >= active) {
        e.alive = false;
        this._hide(i);
        continue;
      }
      e.age += dt;
      if (!e.alive || e.age >= e.life) {
        e.alive = false;
        if (e.age >= 0 && canSpawn) this._spawnFromEmitter(e);
        else if (e.age >= e.life) e.age = -nativeRandom() * 0.5;
        if (!e.alive) {
          this._hide(i);
          continue;
        }
      }

      const t = e.age / e.life;
      const p = e.pos;
      // Fly straight off the rock at first, then the air takes hold within ~half a second and eddies curl them
      const x = Math.min(1, Math.max(0, (e.age - 0.06) / 0.4));
      const grip = x * x * (3 - 2 * x);
      airFlow(p, time, this._air).multiplyScalar(0.1 + 0.8 * grip);
      // Downdrafts never pull them back into the rock
      this._air.y = Math.max(this._air.y + 0.34 * (1 - t) + 0.12, 0.03);
      // Quadratic air drag: anything faster than the air (a shove from the rock) dies off within a fraction of a second
      this._n.subVectors(e.vel, this._air);
      const excess = this._n.length();
      this._n.multiplyScalar(Math.exp(-dt * (0.8 + grip * (1 / e.inertia + 14 * excess))));
      e.vel.addVectors(this._air, this._n);
      p.addScaledVector(e.vel, dt);
      if (this._field) this._collide(e, dt);
      this._draw.copy(p);

      // Streaked along the direction of travel
      this._dir.copy(e.vel);
      const speed = this._dir.length();
      if (speed > 1e-4) this._quat.setFromUnitVectors(UP, this._dir.multiplyScalar(1 / speed));
      const fade = Math.min(1, t / 0.08) * (1 - Math.pow(t, 2.2));
      const sz = e.size * fade;
      // A slight oval along the direction of travel, capped so fast embers stay ember-sized
      const stretch = Math.min(1 + speed * 1.2, 1.7);
      this._scale.set(sz * 0.8, sz * stretch, sz * 0.8);
      this._mat.compose(this._draw, this._quat, this._scale);
      this.mesh.setMatrixAt(i, this._mat);

      const flick = 0.78 + 0.22 * Math.sin(e.age * 23 + e.flicker) * Math.sin(e.age * 7.3 + e.flicker * 0.7);
      const temp = e.heat * (1 - Math.pow(t, 1.4) * 0.85) * flick;
      this.mesh.setColorAt(i, this._col.setRGB(temp, temp, temp));
      e.glow = temp * sz;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.source) {
      this._prevWorld.copy(this.source.matrixWorld);
      this._hasPrev = true;
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  _hide(i) {
    this._scale.set(0, 0, 0);
    this._mat.compose(this._p.set(0, -100, 0), this._quat.identity(), this._scale);
    this.mesh.setMatrixAt(i, this._mat);
  }
}

export { EmberSystem };
