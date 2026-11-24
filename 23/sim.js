import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  NoColorSpace,
  Scene,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  Vector2,
  Vector3,
} from "three";
import { shader as simplexNoise3D } from "shaders/perlinSimplex3D.js";
import { seededRandom } from "modules/random.js";

const STYLES = ["Cracked Plates", "Pillow Lava", "Pahoehoe Coils", "Obsidian", "Flow Bands", "Shard Scales", "Strata Plates", "Charred Grain", "Ropy Strands", "Marbled Glass"];

const STYLE_PROFILES = {
  "Shard Scales": { crust: 0.8, fluidFlow: 0.16, turbulence: 0.2, relief: 0.94, heat: 0.84, gloss: 0.9, scale: 1.0 },
  "Strata Plates": { crust: 0.9, fluidFlow: 0.45, turbulence: 0.35, relief: 0.92, heat: 0.82, gloss: 0.3, scale: 1.0 },
  "Charred Grain": { crust: 0.84, fluidFlow: 0.25, turbulence: 0.25, relief: 0.92, heat: 0.8, gloss: 0.42, scale: 1.0 },
  "Marbled Glass": { crust: 0.5, fluidFlow: 0.9, turbulence: 0.75, relief: 0.2, heat: 0.8, gloss: 0.95, scale: 1.0 },
  "Ropy Strands": { crust: 0.8, fluidFlow: 0.4, turbulence: 0.4, relief: 0.9, heat: 0.86, gloss: 0.15, scale: 1.0 },
  "Cracked Plates": {
    backdrop: "Obsidian",
    crust: 0.84,
    fluidFlow: 0.35,
    turbulence: 0.32,
    relief: 0.94,
    heat: 0.78,
    gloss: 0.34,
    scale: 1.2,
  },
  "Pillow Lava": {
    backdrop: "Obsidian",
    crust: 0.84,
    fluidFlow: 0.2,
    turbulence: 0.32,
    relief: 0.88,
    heat: 0.80,
    gloss: 0.82,
    scale: 1.35,
  },
  "Pahoehoe Coils": {
    backdrop: "Obsidian",
    crust: 0.84,
    fluidFlow: 0.28,
    turbulence: 0.30,
    relief: 0.84,
    heat: 0.82,
    gloss: 0.38,
    scale: 1.0,
  },
  Obsidian: {
    backdrop: "Obsidian",
    crust: 0.86,
    fluidFlow: 0.10,
    turbulence: 0.12,
    relief: 0.95,
    heat: 0.8,
    gloss: 0.92,
    scale: 1.2,
  },
  "Flow Bands": {
    backdrop: "Charcoal",
    crust: 0.80,
    fluidFlow: 0.45,
    turbulence: 0.40,
    relief: 0.82,
    heat: 0.84,
    gloss: 0.24,
    scale: 1.1,
  },
};

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Exact octahedral sphere-boundary reflection for seamless 2D Navier-Stokes on the closed sphere
const OCT_BOUNDARY_GLSL = /* glsl */ `
uniform vec2 uTexel;

vec3 wrapOct(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  float flip = 1.0;
  if (p.x > 1.0) { p.x = 2.0 - p.x; p.y = -p.y; flip = -flip; }
  else if (p.x < -1.0) { p.x = -2.0 - p.x; p.y = -p.y; flip = -flip; }
  if (p.y > 1.0) { p.y = 2.0 - p.y; p.x = -p.x; flip = -flip; }
  else if (p.y < -1.0) { p.y = -2.0 - p.y; p.x = -p.x; flip = -flip; }
  return vec3(clamp(p * 0.5 + 0.5, 0.0, 1.0), flip);
}

vec4 sampleOct(sampler2D tex, vec2 uv) {
  return texture(tex, wrapOct(uv).xy);
}

vec4 sampleVelOct(sampler2D tex, vec2 uv) {
  vec3 w = wrapOct(uv);
  vec4 v = texture(tex, w.xy);
  v.xy *= w.z;
  return v;
}

// Bilinear lookup in an octahedral map whose taps fold across its outer edges like the sphere does
vec4 octTexel(sampler2D tex, ivec2 t, int n) {
  if (t.x < 0) { t.x = -1 - t.x; t.y = n - 1 - t.y; }
  else if (t.x >= n) { t.x = 2 * n - 1 - t.x; t.y = n - 1 - t.y; }
  if (t.y < 0) { t.y = -1 - t.y; t.x = n - 1 - t.x; }
  else if (t.y >= n) { t.y = 2 * n - 1 - t.y; t.x = n - 1 - t.x; }
  return texelFetch(tex, t, 0);
}
vec4 octBilinear(sampler2D tex, vec2 uv) {
  int n = textureSize(tex, 0).x;
  vec2 g = uv * float(n) - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = g - floor(g);
  return mix(
    mix(octTexel(tex, i, n), octTexel(tex, i + ivec2(1, 0), n), f.x),
    mix(octTexel(tex, i + ivec2(0, 1), n), octTexel(tex, i + ivec2(1, 1), n), f.x),
    f.y);
}

vec2 octEncodeSim(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    n.xy = (1.0 - abs(n.yx)) * s;
  }
  return n.xy * 0.5 + 0.5;
}

vec3 octDecode(vec2 uv) {
  vec2 f = uv * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = clamp(-n.z, 0.0, 1.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

// Pass 1: Navier-Stokes velocity advection + viscous diffusion + 3D curl vortices + upwelling plumes
const VELOCITY_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uVel;
uniform float uDt;
uniform float uTime;
uniform float uTurbulence;
uniform vec3 uSeedOff;
uniform vec4 uPlumes[6];

${simplexNoise3D}
${OCT_BOUNDARY_GLSL}

void main() {
  vec4 curVel = texture(uVel, vUv);
  vec2 vel = sampleVelOct(uVel, vUv - curVel.xy * uDt * 0.45).xy;

  // Viscous diffusion
  vec2 vL = sampleVelOct(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = sampleVelOct(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = sampleVelOct(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = sampleVelOct(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  vel += (vL + vR + vB + vT - 4.0 * vel) * 0.14 * min(uDt * 20.0, 0.22);

  // Seamless 3D curl forcing (creates real swirling magma vortices and shear bands)
  vec3 d3 = octDecode(vUv);
  vec3 np = d3 * 1.9 + uSeedOff + vec3(0.0, -uTime * 0.06, uTime * 0.04);
  float eps = 0.025;
  float n0 = snoise(np);
  vec3 grad3 = vec3(
    snoise(np + vec3(eps, 0.0, 0.0)) - n0,
    snoise(np + vec3(0.0, eps, 0.0)) - n0,
    snoise(np + vec3(0.0, 0.0, eps)) - n0
  ) / eps;

  vec3 dU = normalize(octDecode(wrapOct(vUv + vec2(uTexel.x * 2.0, 0.0)).xy) - d3 + 1e-6);
  vec3 dV = normalize(octDecode(wrapOct(vUv + vec2(0.0, uTexel.y * 2.0)).xy) - d3 + 1e-6);
  vec2 curlF = vec2(dot(grad3, dV), -dot(grad3, dU));
  vel += curlF * mix(0.35, 1.35, uTurbulence) * uDt;

  // Swirling thermal vortices (tangential curl eddies + gentle upwelling) — creates organic S-curves without radial blowout
  float plumePush = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 toP = d3 - uPlumes[i].xyz;
    float dist = length(toP);
    float falloff = exp(-(dist * dist) / (0.34 * 0.34)) * uPlumes[i].w;
    if (falloff > 0.002) {
      vec3 outDir = toP / max(dist, 0.02);
      float signDir = (i % 2 == 0) ? 1.0 : -1.0;
      vec2 radUV = vec2(dot(outDir, dU), dot(outDir, dV));
      vec2 tanUV = vec2(-radUV.y, radUV.x) * signDir;
      vel += (tanUV * 1.05 + radUV * 0.14) * falloff * uDt;
      plumePush += falloff * 0.35;
    }
  }

  vel *= pow(0.982, uDt * 60.0);
  float spd = length(vel);
  if (spd > 1.2) vel *= 1.2 / spd;

  outColor = vec4(vel, curVel.b, plumePush);
}
`;

const DIVERGENCE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uVel;
${OCT_BOUNDARY_GLSL}
void main() {
  vec4 c = texture(uVel, vUv);
  vec2 vL = sampleVelOct(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = sampleVelOct(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = sampleVelOct(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = sampleVelOct(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  float div = 0.5 * ((vR.x - vL.x) + (vT.y - vB.y));
  outColor = vec4(c.xy, c.b, div - c.a * 0.014);
}
`;

const PRESSURE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uVel;
${OCT_BOUNDARY_GLSL}
void main() {
  vec4 c = texture(uVel, vUv);
  float pL = sampleOct(uVel, vUv - vec2(uTexel.x, 0.0)).b;
  float pR = sampleOct(uVel, vUv + vec2(uTexel.x, 0.0)).b;
  float pB = sampleOct(uVel, vUv - vec2(0.0, uTexel.y)).b;
  float pT = sampleOct(uVel, vUv + vec2(0.0, uTexel.y)).b;
  outColor = vec4(c.xy, (pL + pR + pB + pT - c.a) * 0.25, c.a);
}
`;

const GRADIENT_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uVel;
${OCT_BOUNDARY_GLSL}
void main() {
  vec4 c = texture(uVel, vUv);
  float pL = sampleOct(uVel, vUv - vec2(uTexel.x, 0.0)).b;
  float pR = sampleOct(uVel, vUv + vec2(uTexel.x, 0.0)).b;
  float pB = sampleOct(uVel, vUv - vec2(0.0, uTexel.y)).b;
  float pT = sampleOct(uVel, vUv + vec2(0.0, uTexel.y)).b;
  vec2 gradP = 0.5 * vec2(pR - pL, pT - pB);
  outColor = vec4(c.xy - gradP * 0.78, c.b, c.a);
}
`;

// Pass 5: Advect 3D Unit-Sphere Material Coordinates (xyz) + Accumulated Fluid Strain (w)
// Advecting the 3D coordinate instead of a blurred scalar preserves 100% razor-sharp solid rock geometry
// while imparting genuine Navier-Stokes swirls, shear folds, and divergent rift strain!
const ADVECT_COORD_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uCoord; // xyz = advected unit sphere dir, w = signed fluid strain (+ = tensile rift, - = compressive fold)
uniform sampler2D uVel;
uniform float uDt;
uniform float uFlowAmt;

${OCT_BOUNDARY_GLSL}

void main() {
  vec2 vel = texture(uVel, vUv).xy;
  vec2 vL = sampleVelOct(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = sampleVelOct(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = sampleVelOct(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = sampleVelOct(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  float divV = ((vR.x - vL.x) + (vT.y - vB.y)) * 5.0;

  float advScale = mix(0.06, 0.22, uFlowAmt);
  // Backtrack on the sphere, not in the map: the map's stretch jumps across the octahedron's edges, which
  // sheared the field into visible lines there. The velocity is in sphere units along the local frame.
  vec3 restDir = octDecode(vUv);
  vec3 dU = normalize(octDecode(wrapOct(vUv + vec2(uTexel.x * 2.0, 0.0)).xy) - restDir + 1e-6);
  vec3 dV = normalize(octDecode(wrapOct(vUv + vec2(0.0, uTexel.y * 2.0)).xy) - restDir + 1e-6);
  vec3 back = normalize(restDir - (vel.x * dU + vel.y * dV) * uDt * advScale * 2.0);
  vec4 prev = octBilinear(uCoord, octEncodeSim(back));
  // Gentle elastic restoring spring toward rest sphere coordinate prevents Jacobian collapse / bald pools
  vec3 dirAdv = normalize(mix(normalize(prev.xyz), restDir, clamp(uDt * 0.65, 0.0, 0.10)));

  // Accumulate smooth signed strain along streamlines (positive = divergence/rift, negative = convergence/buckling)
  float strain = clamp(prev.w * 0.985 + divV * uDt * 0.65, -1.0, 1.0);

  outColor = vec4(dirAdv, strain);
}
`;

// Pass 6: 3x3 Gaussian smoothing of advected 3D coordinates (with octahedral wrapping & unit-sphere re-normalization)
// Eliminates high-shear texel stair-stepping at extreme close-ups while preserving organic fluid swirls.
const SMOOTH_COORD_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uCoord;
${OCT_BOUNDARY_GLSL}
void main() {
  vec4 acc = vec4(0.0);
  acc += sampleOct(uCoord, vUv + vec2(-uTexel.x,  uTexel.y)) * 1.0;
  acc += sampleOct(uCoord, vUv + vec2( 0.0,       uTexel.y)) * 2.0;
  acc += sampleOct(uCoord, vUv + vec2( uTexel.x,  uTexel.y)) * 1.0;
  acc += sampleOct(uCoord, vUv + vec2(-uTexel.x,  0.0     )) * 2.0;
  acc += sampleOct(uCoord, vUv                             ) * 4.0;
  acc += sampleOct(uCoord, vUv + vec2( uTexel.x,  0.0     )) * 2.0;
  acc += sampleOct(uCoord, vUv + vec2(-uTexel.x, -uTexel.y)) * 1.0;
  acc += sampleOct(uCoord, vUv + vec2( 0.0,      -uTexel.y)) * 2.0;
  acc += sampleOct(uCoord, vUv + vec2( uTexel.x, -uTexel.y)) * 1.0;
  acc /= 16.0;
  outColor = vec4(normalize(acc.xyz), acc.w);
}
`;

// Pass 7: the map's outer edges fold onto themselves ((u, 1) is the same point as (1 - u, 1), and so on), but
// the sim never forces both sides to agree there. Pull each side's edge value to their mean, fading over a band.
const SEAM_SYNC_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uTex;
uniform float uIsVel;
uniform float uBand;
${OCT_BOUNDARY_GLSL}
vec4 partnerFix(vec2 edge, vec2 partner) {
  vec4 a = texture(uTex, edge);
  vec4 b = texture(uTex, partner);
  // Across the fold, uv-space velocity points the other way
  if (uIsVel > 0.5) b.xy = -b.xy;
  return 0.5 * (b - a);
}
void main() {
  vec4 c = texture(uTex, vUv);
  vec2 h = uTexel * 0.5;
  vec4 fix = vec4(0.0);
  float w;
  w = 1.0 - smoothstep(0.0, uBand, 1.0 - vUv.y);
  if (w > 0.0) fix += w * partnerFix(vec2(vUv.x, 1.0 - h.y), vec2(1.0 - vUv.x, 1.0 - h.y));
  w = 1.0 - smoothstep(0.0, uBand, vUv.y);
  if (w > 0.0) fix += w * partnerFix(vec2(vUv.x, h.y), vec2(1.0 - vUv.x, h.y));
  w = 1.0 - smoothstep(0.0, uBand, vUv.x);
  if (w > 0.0) fix += w * partnerFix(vec2(h.x, vUv.y), vec2(h.x, 1.0 - vUv.y));
  w = 1.0 - smoothstep(0.0, uBand, 1.0 - vUv.x);
  if (w > 0.0) fix += w * partnerFix(vec2(1.0 - h.x, vUv.y), vec2(1.0 - h.x, 1.0 - vUv.y));
  c += fix;
  if (uIsVel < 0.5) c.xyz = normalize(c.xyz);
  outColor = c;
}
`;

const INIT_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform int uMode; // 0 = coord (unit sphere dir, strain=0), 1 = vel (0)
${OCT_BOUNDARY_GLSL}
void main() {
  if (uMode == 1) {
    outColor = vec4(0.0);
    return;
  }
  outColor = vec4(octDecode(vUv), 0.0);
}
`;

function createRT(size) {
  return new WebGLRenderTarget(size, size, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function makePass(fragmentShader, uniforms) {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: QUAD_VS,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

class MagmaFluidField {
  constructor(renderer, size = 384) {
    this.renderer = renderer;
    this.size = size;
    this.simTime = 0;

    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.scene.add(this.quad);

    this.vel = [createRT(size), createRT(size)];
    this.coord = [createRT(size), createRT(size)];

    this.seedOff = new Vector3(2.3, 4.1, 1.7);
    this.plumes = Array.from({ length: 6 }, () => ({
      pos: new Vector3(1, 0, 0),
      axis: new Vector3(0, 1, 0),
      speed: 0.16,
      phase: 0,
      strength: 1,
    }));
    this.plumeData = new Float32Array(24);

    const shared = {
      uTexel: { value: new Vector2(1 / size, 1 / size) },
      uSeedOff: { value: this.seedOff },
    };

    this.initMat = makePass(INIT_FS, { ...shared, uMode: { value: 0 } });
    this.velMat = makePass(VELOCITY_FS, {
      ...shared,
      uVel: { value: null },
      uDt: { value: 0.025 },
      uTime: { value: 0 },
      uTurbulence: { value: 0.55 },
      uPlumes: { value: this.plumeData },
    });
    this.divMat = makePass(DIVERGENCE_FS, { ...shared, uVel: { value: null } });
    this.pressMat = makePass(PRESSURE_FS, { ...shared, uVel: { value: null } });
    this.gradMat = makePass(GRADIENT_FS, { ...shared, uVel: { value: null } });
    this.coordMat = makePass(ADVECT_COORD_FS, {
      ...shared,
      uCoord: { value: null },
      uVel: { value: null },
      uDt: { value: 0.025 },
      uFlowAmt: { value: 0.6 },
    });
    this.smoothCoordMat = makePass(SMOOTH_COORD_FS, {
      ...shared,
      uCoord: { value: null },
    });
    this.seamMat = makePass(SEAM_SYNC_FS, {
      ...shared,
      uTex: { value: null },
      uIsVel: { value: 0 },
      uBand: { value: 16 / size },
    });

    this.reset(1);
  }

  get materials() {
    return [this.initMat, this.velMat, this.divMat, this.pressMat, this.gradMat, this.coordMat, this.smoothCoordMat, this.seamMat];
  }

  get coordTexture() { return this.coord[0].texture; }
  get velocityTexture() { return this.vel[0].texture; }

  _run(mat, target) {
    const prev = this.renderer.getRenderTarget();
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  _swap(pair) {
    const tmp = pair[0];
    pair[0] = pair[1];
    pair[1] = tmp;
  }

  _updatePlumes(time) {
    for (let i = 0; i < 6; i++) {
      const p = this.plumes[i];
      const v = p.pos.clone().applyAxisAngle(p.axis, time * p.speed + p.phase).normalize();
      this.plumeData[i * 4 + 0] = v.x;
      this.plumeData[i * 4 + 1] = v.y;
      this.plumeData[i * 4 + 2] = v.z;
      this.plumeData[i * 4 + 3] = p.strength;
    }
  }

  reset(seed) {
    const rng = seededRandom(`magma-ns:${seed}`);
    this.seedOff.set((rng() - 0.5) * 18, (rng() - 0.5) * 18, (rng() - 0.5) * 18);
    this.simTime = 0;
    for (let i = 0; i < 6; i++) {
      const theta = rng() * Math.PI * 2;
      const u = rng() * 2 - 1;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      this.plumes[i].pos.set(s * Math.cos(theta), u, s * Math.sin(theta)).normalize();
      this.plumes[i].axis.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
      this.plumes[i].speed = 0.1 + rng() * 0.15;
      this.plumes[i].phase = rng() * Math.PI * 2;
      this.plumes[i].strength = 0.7 + rng() * 0.6;
    }
    this._updatePlumes(0);

    this.initMat.uniforms.uMode.value = 0;
    this._run(this.initMat, this.coord[0]);
    this.initMat.uniforms.uMode.value = 1;
    this._run(this.initMat, this.vel[0]);
  }

  smoothCoord(passes = 2) {
    for (let i = 0; i < passes; i++) {
      this.smoothCoordMat.uniforms.uCoord.value = this.coord[0].texture;
      this._run(this.smoothCoordMat, this.coord[1]);
      this._swap(this.coord);
    }
  }

  // Run N steps of Navier-Stokes fluid advection to develop swirling 3D flow coordinates & strain
  develop(steps, opts) {
    for (const _ of this.developSteps(steps, opts));
  }

  // develop() in slices of perSlice steps (yields between them)
  *developSteps(steps, { turbulence, fluidFlow }, perSlice = 8) {
    for (let i = 0; i < steps; i++) {
      this.step(0.028, { turbulence, fluidFlow }, true);
      if ((i + 1) % perSlice === 0 && i + 1 < steps) yield;
    }
    this.smoothCoord(2);
    this.syncSeams();
  }

  // Makes both sides of the map's folded outer edges agree, so the sim leaves no line on the sphere there
  syncSeams() {
    for (const [pair, isVel] of [[this.coord, 0], [this.vel, 1]]) {
      this.seamMat.uniforms.uTex.value = pair[0].texture;
      this.seamMat.uniforms.uIsVel.value = isVel;
      this._run(this.seamMat, pair[1]);
      this._swap(pair);
    }
  }

  step(dt, { turbulence, fluidFlow }, fast = false) {
    if (dt <= 0) return;
    const clampedDt = Math.min(dt, 0.04);
    this.simTime += clampedDt;
    this._updatePlumes(this.simTime);

    this.velMat.uniforms.uVel.value = this.vel[0].texture;
    this.velMat.uniforms.uDt.value = clampedDt;
    this.velMat.uniforms.uTime.value = this.simTime;
    this.velMat.uniforms.uTurbulence.value = turbulence;
    this._run(this.velMat, this.vel[1]);
    this._swap(this.vel);

    this.divMat.uniforms.uVel.value = this.vel[0].texture;
    this._run(this.divMat, this.vel[1]);
    this._swap(this.vel);

    const iters = fast ? 3 : 5;
    for (let i = 0; i < iters; i++) {
      this.pressMat.uniforms.uVel.value = this.vel[0].texture;
      this._run(this.pressMat, this.vel[1]);
      this._swap(this.vel);
    }

    this.gradMat.uniforms.uVel.value = this.vel[0].texture;
    this._run(this.gradMat, this.vel[1]);
    this._swap(this.vel);

    this.coordMat.uniforms.uCoord.value = this.coord[0].texture;
    this.coordMat.uniforms.uVel.value = this.vel[0].texture;
    this.coordMat.uniforms.uDt.value = clampedDt;
    this.coordMat.uniforms.uFlowAmt.value = fluidFlow;
    this._run(this.coordMat, this.coord[1]);
    this._swap(this.coord);
  }
}

export { MagmaFluidField, STYLES, STYLE_PROFILES };
