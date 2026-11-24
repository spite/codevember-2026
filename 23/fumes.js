// The smoke around the rock as a fluid simulation (modules/fumes/SmokeGrid.js) in a box fixed in the world, rising on a
// light draught. The rock is a moving obstacle (its morph field, so it follows the melt and the pool) whose turning
// drags and flings the air. The room's billows are the static shaft noise read through offsets the flow carries; the
// hot lava gives off smoke of its own, which buoyancy lifts: thin wisps, or (plume) thick puffs that rise faster, also
// off the rock's underside. The light shaft (shaft.js) marches it; this steps it.
import { Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import { SmokeGrid, gridGLSL, passHeader, maccormackGLSL } from "modules/fumes/SmokeGrid.js";
import { MORPH_GLSL } from "./lava.js";

// Cells: 48 x 56 x 48 of 0.133 (medium 32 x 38 x 32 of 0.2), spanning [-3.2, 3.2] across and [-3, 4.5] up.
const GRIDS = {
  high: { nx: 48, ny: 56, nz: 48, tx: 8, ty: 6, cell: 6.4 / 48, jacobi: 16 },
  medium: { nx: 32, ny: 38, nz: 32, tx: 8, ty: 4, cell: 0.2, jacobi: 10 },
};
const LO = new Vector3(-3.2, -3.0, -3.2);
// The draught, which the billows of the room's smoke also drift with (world units a second): up, and this far sideways
const WIND_UP = 0.22;
const WIND_SIDE = 0.05;
const MIN_STEP = 1 / 75;
const MAX_STEP = 1 / 30;

const UNIFORMS_GLSL = /* glsl */ `uniform mat3 objRot;
uniform vec3 omega;
uniform vec3 wind;
uniform float simTime;
uniform vec3 drift;
uniform vec3 plumeDrift;
uniform float roomScale;
uniform highp sampler3D uSmoke;
`;

// Where the room's smoke at p is read from the shaft's noise: its billows drift with the draught (drift, integrated), and
// offset (the carried field) is how far the flow has moved the air at p from where the draught alone would have.
// The plumes' puffs rise at about the lava smoke's pace instead, turned by a damped offset so the updraft can't streak them.
const HELPERS_GLSL = /* glsl */ `vec3 smokeCoord(vec3 p, vec3 offset) {
  return (p + offset) * (0.16 / roomScale) - drift + vec3(0.01, 0.0, 0.0);
}
vec3 plumeCoord(vec3 p, vec3 offset) {
  return (p + offset * 0.45) * 0.16 - plumeDrift + vec3(0.01, 0.0, 0.0);
}
`;

const obstacleShader = (header) => /* glsl */ `
${header}
${MORPH_GLSL}
void main() {
  vec3 p = cellPos(cellOf(ivec2(gl_FragCoord.xy)));
  fragColor = vec4(cross(omega, p), morphFieldFast(objRot * p));
}
`;

// Air from outside the box moves with the draught and carries none of the lava's smoke.
const advectShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform float dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(tState, px, 0);
  vec3 g = vec3(cellOf(px)) + 0.5 - dt * s.xyz / H;
  vec4 a = sampleGrid(tState, g);
  float outside = smoothstep(0.0, 1.0, max(max(-g.x, g.x - GRID.x), max(max(-g.y, g.y - GRID.y), max(-g.z, g.z - GRID.z))));
  fragColor = mix(a, vec4(wind, 0.0), outside);
}
`;

const fillShader = (header) => /* glsl */ `
${header}
void main() {
  fragColor = vec4(wind, 0.0);
}
`;

// The offset of the room's smoke (see smokeCoord) carried along the flow; it heals slowly back to none.
const carryShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform sampler2D tCarry;
uniform float dt;
uniform float heal;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(tState, px, 0);
  vec3 v = s.xyz;
  vec3 g = vec3(cellOf(px)) + 0.5 - dt * v / H;
  float outside = smoothstep(0.0, 1.0, max(max(-g.x, g.x - GRID.x), max(max(-g.y, g.y - GRID.y), max(-g.z, g.z - GRID.z))));
  vec3 o = sampleGrid(tCarry, g).xyz * (1.0 - outside);
  // w: the lava's smoke, copied so the march reads both in one lookup
  o = (o + (wind - v) * dt) * exp(-dt * heal);
  // Capped, so a steady updraft can't shear the billows into streaks
  fragColor = vec4(o * min(1.0, 0.9 / max(length(o), 1e-4)), s.w);
}
`;

// The draught, the hot rock's updraft, buoyancy of the lava's smoke (state w), the rock's drag on the air touching it,
// and smoke given off by the lava: more where it is hotter, all over while it is molten.
const forcesShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform sampler2D tAdvected;
uniform sampler2D tSolid;
uniform highp sampler3D uHeatVolume;
uniform highp sampler3D uPulseVolume;
uniform float uSdfBound;
uniform float dt;
uniform float emission;
uniform float plumeEmission;
uniform float molten;
uniform float buoyancy;
uniform float lift;
uniform float drag;
uniform float relax;
uniform float thin;
uniform float plume;
uniform float under;
float sdAt(ivec3 c) { return texelFetch(tSolid, clampedPx(c), 0).w; }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec3 p = cellPos(c);
  vec4 solid = texelFetch(tSolid, px, 0);
  float sd = solid.w;
  if (sd < 0.0) {
    fragColor = vec4(solid.xyz, 0.0);
    return;
  }
  vec4 s = texelFetch(tState, px, 0);
  vec4 a = texelFetch(tAdvected, px, 0);
  vec3 g = vec3(c) + 0.5;
${maccormackGLSL}
  d = max(d, 0.0) * exp(-dt * thin);
  vec3 v = mix(a.xyz, wind, 1.0 - exp(-dt * relax));
  float heat = 0.0;
  vec3 op = objRot * p;
  if (sd < 1.2) {
    vec3 q = clamp(op / (2.0 * uSdfBound) + 0.5, 0.0, 1.0);
    heat = min(texture(uHeatVolume, q).r * texture(uPulseVolume, q).r * 0.5, 1.5);
    heat = mix(heat, mix(0.9, 0.6, plume), molten);
  }
  // With plumes, hot air under the rock rises too, and wraps up around its sides
  float below = under * smoothstep(0.2, -0.6, p.y) * (1.0 - smoothstep(0.0, 0.9, sd));
  v.y += dt * (lift * (heat * exp(-sd * 2.0) + 0.6 * below) + buoyancy * d / (1.0 + mix(0.6, 0.4, plume) * d));
  // The air touching the rock goes with its surface
  float shell = 1.0 - smoothstep(0.0, mix(2.5, 1.8, plume) * H, sd);
  v = mix(v, solid.xyz, shell * (1.0 - exp(-dt * drag)));
  float src = 1.0 - smoothstep(H * 0.5, H * (2.5 + 2.5 * below), sd);
  if (src > 0.0 && heat > 0.02) {
    vec3 n = normalize(vec3(sdAt(c + ivec3(1, 0, 0)) - sdAt(c - ivec3(1, 0, 0)), sdAt(c + ivec3(0, 1, 0)) - sdAt(c - ivec3(0, 1, 0)),
      sdAt(c + ivec3(0, 0, 1)) - sdAt(c - ivec3(0, 0, 1))) + 1e-6);
    // The lava's heat on the surface below the cell, where the cracks are
    vec3 qs = clamp((op - objRot * n * sd) / (2.0 * uSdfBound) + 0.5, 0.0, 1.0);
    float hs = min(texture(uHeatVolume, qs).r * texture(uPulseVolume, qs).r * 0.5, 1.5);
    hs = mix(max(max(hs, heat) * (0.4 + 0.6 * hs), 0.3 * below), mix(0.12, 0.045, plume), molten);
    // Wisps in threads from spots on the rock that flare and fade, all over it (a little less off its underside)
    float pattern = 0.0;
    if (plume < 1.0) {
      float spot = texture(uSmoke, op * 0.8 + vec3(0.0, simTime * 0.06, 0.0)).r;
      float flare = texture(uSmoke, op * 0.35 + vec3(simTime * 0.09, 0.0, simTime * 0.05)).g;
      pattern = (1.0 - plume) * 14.0 * (0.15 + 2.0 * smoothstep(0.48, 0.6, spot) * smoothstep(0.4, 0.56, flare)) * (0.6 + 0.4 * smoothstep(-0.8, 0.3, n.y));
    }
    // Plumes in puffs from faster flaring spots, most off its underside
    if (plume > 0.0) {
      float spot = texture(uSmoke, op * 0.8 + vec3(0.0, simTime * 0.1, 0.0)).r;
      float flare = texture(uSmoke, op * 0.35 + vec3(simTime * 0.22, 0.0, simTime * 0.13)).g;
      pattern += plume * plumeEmission * (0.04 + 3.0 * smoothstep(0.52, 0.62, spot) * smoothstep(0.48, 0.6, flare)) * mix(1.8, 0.8, smoothstep(-0.7, 0.3, n.y));
    }
    float e = emission * hs * src * pattern;
    d += dt * e;
    // Off the surface in puffs: a push outward and a stir
    vec3 jitter = texture(uSmoke, p * 0.7 + simTime * vec3(0.11, 0.23, 0.07)).gba - 0.5;
    v += dt * e * (n * 1.3 + jitter * (2.5 + 3.0 * molten));
  }
  fragColor = vec4(v, d);
}
`;

const _dq = new Quaternion(), _q = new Quaternion(), _w = new Vector3(), _m4 = new Matrix4();

class RockSmoke {
  constructor({ quality, morphUniforms, heatVolume, pulseVolume, sdfBound }) {
    const spec = GRIDS[quality] ?? GRIDS.high;
    const grid = { ...spec, lo: LO };
    // The box the sim spans, in world space
    this.box = { lo: LO.clone(), size: new Vector3(spec.nx, spec.ny, spec.nz).multiplyScalar(spec.cell) };
    this.shared = {
      objRot: { value: new Matrix3() },
      omega: { value: new Vector3() },
      wind: { value: new Vector3(0.03, WIND_UP, 0.04) },
      simTime: { value: 0 },
      drift: { value: new Vector3() },
      plumeDrift: { value: new Vector3() },
      roomScale: { value: 1 },
      uSmoke: { value: null },
    };
    // For the march: the grid helpers and their uniforms
    this.chunk = gridGLSL(grid, { uniforms: UNIFORMS_GLSL, helpers: HELPERS_GLSL });
    const header = passHeader(this.chunk);
    this.forces = {
      uHeatVolume: { value: heatVolume },
      uPulseVolume: { value: pulseVolume },
      uSdfBound: { value: sdfBound },
      emission: { value: 1 },
      // Per cell, so less on the coarser grid
      plumeEmission: { value: 8 * (GRIDS.high.cell / spec.cell) },
      plume: { value: 0 },
      under: { value: 0 },
      molten: { value: 0 },
      buoyancy: { value: 0.8 },
      lift: { value: 1.5 },
      drag: { value: 12 },
      relax: { value: 0.35 },
      thin: { value: 0.45 },
    };
    this.heal = { value: 0.08 };
    this.sim = new SmokeGrid({
      grid,
      header,
      shared: { ...this.shared, ...morphUniforms },
      jacobi: spec.jacobi,
      vorticity: 5.0,
      obstacle: { fragmentShader: obstacleShader(header) },
      advect: { fragmentShader: advectShader(header) },
      carry: { fragmentShader: carryShader(header), uniforms: { heal: this.heal } },
      forces: { fragmentShader: forcesShader(header), uniforms: this.forces },
    });
    this.fillMat = this.sim.passes.advect.clone();
    this.fillMat.fragmentShader = fillShader(header);
    this.fillMat.uniforms = { ...this.shared };
    this.carried = { tCarry: { value: this.sim.carried } };
    this.filled = false;
    this.owed = 0;
    this.lastRot = null;
    this.lastTime = 0;
  }

  // The panel's smoke settings, each 1 for the room's own look except plume (0: thin wisps, 1: thick puffs).
  // rise: buoyancy and the rock's updraft; turbulence: vorticity; lifetime: how long the lava's smoke lasts;
  // draught: its strength, angle: its heading in degrees; scale: size of the room's billows; lava, under: smoke given off
  set({ plume = 0, rise = 1, turbulence = 1, lifetime = 1, draught = 1, angle = 53, scale = 1, lava = 1, under = 1 }) {
    const f = this.forces, p = Math.min(Math.max(plume, 0), 1);
    f.plume.value = p;
    f.under.value = p * under;
    f.emission.value = lava;
    f.buoyancy.value = (0.8 + 1.4 * p) * rise;
    f.lift.value = (1.5 + 1.5 * p) * rise;
    f.relax.value = 0.35 - 0.05 * p;
    f.thin.value = (0.45 - 0.1 * p) / Math.max(lifetime, 0.05);
    this.sim.passes.confine.uniforms.vorticity.value = (5 + 7 * p) * turbulence;
    const a = (angle * Math.PI) / 180;
    this.shared.wind.value.set(Math.cos(a) * WIND_SIDE, WIND_UP, Math.sin(a) * WIND_SIDE).multiplyScalar(draught);
    this.shared.roomScale.value = scale;
    this.plumeRise = 0.55 * rise;
  }

  // The march's uniforms (shared objects, so they follow the sim)
  get marchUniforms() {
    return { ...this.shared, ...this.carried };
  }

  compile(renderer) {
    return this.sim.compile(renderer, [this.fillMat]);
  }

  // time: scene time (stopped while paused); mesh: the rock, turning about its centre at the origin; molten 0..1
  update(renderer, time, mesh, { molten = 0 } = {}) {
    const dt = time - this.lastTime;
    this.lastTime = time;
    const s = this.shared;
    s.simTime.value = time;
    // The billows' drift, integrated so draught and scale changes don't jump them
    const w = s.wind.value;
    s.drift.value.addScaledVector(w, (dt * 0.16) / s.roomScale.value);
    s.plumeDrift.value.x += w.x * dt * 0.16;
    s.plumeDrift.value.y += (this.plumeRise ?? 0.55) * dt * 0.16;
    s.plumeDrift.value.z += w.z * dt * 0.16;
    // The rock's spin, from its turn since the last frame
    if (dt > 1e-4 && dt < 0.5 && this.lastRot) {
      _dq.copy(mesh.quaternion).multiply(_q.copy(this.lastRot).invert());
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
      const ang = 2 * Math.acos(Math.min(1, _dq.w));
      const sn = Math.sqrt(Math.max(1 - _dq.w * _dq.w, 1e-12));
      _w.set(_dq.x / sn, _dq.y / sn, _dq.z / sn).multiplyScalar(ang / dt);
      if (_w.length() > 20) _w.setLength(20);
      s.omega.value.lerp(_w, Math.min(1, dt * 20));
    }
    (this.lastRot ??= mesh.quaternion.clone()).copy(mesh.quaternion);
    s.objRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q.copy(mesh.quaternion).invert()));
    this.forces.molten.value = molten;
    const prev = renderer.getRenderTarget();
    if (!this.filled) {
      this.sim.clear(renderer);
      this.sim.fill(renderer, this.fillMat);
      this.filled = true;
    }
    if (dt > 0) {
      this.owed = Math.min(this.owed + dt, 2 * MAX_STEP);
      if (this.owed >= MIN_STEP) {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        const n = Math.ceil(this.owed / MAX_STEP - 1e-6);
        this.sim.dt.value = this.owed / n;
        for (let i = 0; i < n; i++) this.sim.step(renderer);
        this.owed = 0;
        renderer.autoClear = autoClear;
      }
    }
    renderer.setRenderTarget(prev);
    this.carried.tCarry.value = this.sim.carried;
  }
}

export { RockSmoke };
