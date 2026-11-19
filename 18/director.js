import { Vector3, Spherical, MathUtils } from "three";

// Frames each contraption three-quarter on, from a fresh angle each time, and once nobody has touched the view for a
// few seconds, takes the camera over and drifts it slowly round that angle.

const QUIET = 4;
const FOV = 24;
// The studio's floor runs out at 14 m; the camera stays well inside it.
const FAR = 11;

class Director {
  constructor({ camera, controls, random = Math.random }) {
    this.camera = camera;
    this.controls = controls;
    this.random = random;
    this.enabled = true;
    this.quiet = 0;
    this.amount = 0;
    this.time = 0;
    this.shot = { az: MathUtils.degToRad(30), el: MathUtils.degToRad(14) };
    this.framing = null;
    for (const type of ["pointerdown", "wheel", "keydown", "touchstart"])
      addEventListener(type, () => ((this.quiet = 0), (this.amount = 0)), { capture: true, passive: true });
  }

  // Distance at which the framing box fits the view from (az, el) through a lens of `fov` degrees.
  fit({ width, height, depth }, az, el, fov) {
    const aspect = this.camera.aspect;
    const tanV = Math.tan(MathUtils.degToRad(fov) / 2);
    const wide = width * Math.abs(Math.cos(az)) + depth * Math.abs(Math.sin(az));
    const deep = width * Math.abs(Math.sin(az)) + depth * Math.abs(Math.cos(az));
    const tall = height * Math.cos(el) + deep * Math.sin(el);
    return 1.08 * Math.max(tall / 2 / tanV, wide / 2 / (tanV * aspect)) + deep / 2;
  }

  // The long lens, widened only as far as needed to keep the camera within FAR (inside the studio, e.g. in portrait).
  lens(framing, az, el) {
    let fov = FOV;
    let d = this.fit(framing, az, el, fov);
    for (let i = 0; i < 40 && d > FAR && fov < 55; i++) d = this.fit(framing, az, el, (fov += 1));
    return { fov, distance: Math.min(d, FAR) };
  }

  // A new contraption: a new angle, eased to unless someone is looking around; `now` jumps straight there.
  reframe(framing, now = false) {
    this.framing = framing;
    const side = this.random() < 0.5 ? -1 : 1;
    const [e0, e1] = framing.elevation ?? [9, 18];
    this.shot = { az: side * MathUtils.degToRad(MathUtils.lerp(22, 40, this.random())), el: MathUtils.degToRad(MathUtils.lerp(e0, e1, this.random())), from: this.time };
    if (now) this.place(1);
  }

  // Where the drift has the camera now.
  pose() {
    const { az, el } = this.shot;
    const t = this.time;
    // `orbit` (radians a second, 0 by default): a steady turn on top, for a recording, across the front from the side
    // the shot starts on.
    const a = az + MathUtils.degToRad(9) * Math.sin((t * 2 * Math.PI) / 47) - Math.sign(az) * (this.orbit ?? 0) * (t - (this.shot.from ?? 0));
    const e = el + MathUtils.degToRad(3.5) * Math.sin((t * 2 * Math.PI) / 31 + 1.3);
    const { fov, distance } = this.lens(this.framing, a, e);
    const d = distance * (1 + 0.03 * Math.sin((t * 2 * Math.PI) / 37 + 0.4));
    return { target: this.framing.center, fov, spherical: new Spherical(d, Math.PI / 2 - e, a) };
  }

  // Eases the camera a fraction k of the way to the drift's pose.
  place(k) {
    const { target, spherical, fov } = this.pose();
    const { camera, controls } = this;
    camera.fov += (fov - camera.fov) * k;
    camera.updateProjectionMatrix();
    controls.target.lerp(target, k);
    const current = new Spherical().setFromVector3(new Vector3().subVectors(camera.position, controls.target));
    let dTheta = spherical.theta - current.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    current.theta += dTheta * k;
    current.phi += (spherical.phi - current.phi) * k;
    current.radius += (spherical.radius - current.radius) * k;
    camera.position.setFromSpherical(current).add(controls.target);
    camera.lookAt(controls.target);
  }

  update(dt) {
    this.quiet += dt;
    if (!this.enabled || !this.framing) return;
    this.time += dt;
    // Takes over gently once the view has been left alone.
    this.amount = this.quiet > QUIET ? Math.min(1, this.amount + dt / 3) : 0;
    if (this.amount > 0) this.place(1 - Math.exp(-dt * 0.8 * this.amount));
  }
}

export { Director };
