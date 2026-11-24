// A smoke simulation (stable fluids) on a 3D grid whose z slices are tiled in a 2D atlas, so each pass is one
// full-screen draw: the day's own obstacle pass (velocity and signed distance of what is in the air), advection, the
// day's own forces pass (buoyancy, emission, drag), vorticity confinement, then a Jacobi pressure solve that makes the
// flow divergence free around the obstacle. State: velocity (xyz) and density (w) per cell. Days 10 and 23.
import {
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  WebGLRenderTarget,
  HalfFloatType,
  RGBAFormat,
  RGFormat,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  NoColorSpace,
  Data3DTexture,
  UnsignedByteType,
  Color,
} from "three";
import { nativeRandom } from "modules/random.js";

export const vertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Cells <-> atlas texels and trilinear lookups. grid: { nx, ny, nz, tx, ty, cell, lo } (tx * ty >= nz slices, lo the
// grid's low corner); uniforms and helpers are the day's own GLSL, placed before and after the helpers.
export function gridGLSL({ nx, ny, nz, tx, ty, cell, lo }, { uniforms = "", helpers = "" } = {}) {
  return /* glsl */ `
#define NX ${nx}
#define NY ${ny}
#define NZ ${nz}
#define TX ${tx}
#define TY ${ty}
const vec3 GRID = vec3(NX, NY, NZ);
const float H = ${cell.toFixed(4)};
const vec3 LO = vec3(${lo.x.toFixed(3)}, ${lo.y.toFixed(3)}, ${lo.z.toFixed(3)});
${uniforms}
ivec2 atlasPx(ivec3 c) {
  return ivec2(c.x + (c.z % TX) * NX, c.y + (c.z / TX) * NY);
}
ivec3 cellOf(ivec2 px) {
  int tx = px.x / NX, ty = px.y / NY;
  return ivec3(px.x - tx * NX, px.y - ty * NY, tx + ty * TX);
}
bool inGrid(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(NX, NY, NZ)));
}
ivec2 clampedPx(ivec3 c) {
  return atlasPx(clamp(c, ivec3(0), ivec3(NX - 1, NY - 1, NZ - 1)));
}
// g in cells (centres at i + 0.5); hardware bilinear within a slice, blended across two.
vec4 sampleGrid(sampler2D t, vec3 g) {
  g = clamp(g, vec3(0.5), GRID - 0.5);
  float z = g.z - 0.5;
  int z0 = int(floor(z));
  int z1 = min(z0 + 1, NZ - 1);
  vec2 inv = 1.0 / vec2(NX * TX, NY * TY);
  vec4 a = texture(t, (g.xy + vec2((z0 % TX) * NX, (z0 / TX) * NY)) * inv);
  vec4 b = texture(t, (g.xy + vec2((z1 % TX) * NX, (z1 / TX) * NY)) * inv);
  return mix(a, b, z - float(z0));
}
vec3 cellPos(ivec3 c) {
  return LO + (vec3(c) + 0.5) * H;
}
${helpers}`;
}

// What every pass starts with, given gridGLSL's chunk.
export function passHeader(chunk) {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 fragColor;
${chunk}
`;
}

// Semi-Lagrangian advection of velocity and density: the value where each cell's air came from. Still, clean air comes
// in from outside the box.
const advectShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform float dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(tState, px, 0);
  vec3 g = vec3(cellOf(px)) + 0.5 - dt * s.xyz / H;
  vec4 a = sampleGrid(tState, g);
  // Clean, still air comes in from outside.
  float outside = max(max(-g.x, g.x - GRID.x), max(max(-g.y, g.y - GRID.y), max(-g.z, g.z - GRID.z)));
  fragColor = a * (1.0 - smoothstep(0.0, 1.0, outside));
}
`;

// The flow's curl (xyz) and its length (w).
const curlShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
vec3 vel(ivec3 c) {
  return texelFetch(tState, clampedPx(c), 0).xyz;
}
void main() {
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy));
  vec3 l = vel(c - ivec3(1, 0, 0)), r = vel(c + ivec3(1, 0, 0));
  vec3 b = vel(c - ivec3(0, 1, 0)), t = vel(c + ivec3(0, 1, 0));
  vec3 k = vel(c - ivec3(0, 0, 1)), f = vel(c + ivec3(0, 0, 1));
  vec3 w = vec3((t.z - b.z) - (f.y - k.y), (f.x - k.x) - (r.z - l.z), (r.y - l.y) - (t.x - b.x)) * (0.5 / H);
  fragColor = vec4(w, length(w));
}
`;

// Vorticity confinement: puts back the swirl the coarse grid smears out.
const confineShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform sampler2D tCurl;
uniform float dt;
uniform float vorticity;
float mag(ivec3 c) {
  return texelFetch(tCurl, clampedPx(c), 0).w;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec4 s = texelFetch(tState, px, 0);
  vec3 eta = vec3(mag(c + ivec3(1, 0, 0)) - mag(c - ivec3(1, 0, 0)), mag(c + ivec3(0, 1, 0)) - mag(c - ivec3(0, 1, 0)),
    mag(c + ivec3(0, 0, 1)) - mag(c - ivec3(0, 0, 1)));
  float l = length(eta);
  if (l > 1e-5) {
    vec3 w = texelFetch(tCurl, px, 0).xyz;
    // Stronger where there is vapour to show it.
    s.xyz += dt * vorticity * H * (0.3 + 0.7 * min(s.w * 2.0, 1.0)) * cross(eta / l, w);
  }
  fragColor = s;
}
`;

// Divergence (r) and whether the cell is solid (g). Neighbours inside the obstacle move with its surface; outside the
// box the velocity carries on as it is.
const divergenceShader = (header) => /* glsl */ `
${header}
uniform sampler2D tState;
uniform sampler2D tSolid;
vec3 vel(ivec3 c, vec3 v0) {
  if (!inGrid(c)) return v0;
  ivec2 px = atlasPx(c);
  vec4 solid = texelFetch(tSolid, px, 0);
  return solid.w < 0.0 ? solid.xyz : texelFetch(tState, px, 0).xyz;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec3 v0 = texelFetch(tState, px, 0).xyz;
  float d = vel(c + ivec3(1, 0, 0), v0).x - vel(c - ivec3(1, 0, 0), v0).x + vel(c + ivec3(0, 1, 0), v0).y
    - vel(c - ivec3(0, 1, 0), v0).y + vel(c + ivec3(0, 0, 1), v0).z - vel(c - ivec3(0, 0, 1), v0).z;
  fragColor = vec4(0.5 * d / H, texelFetch(tSolid, px, 0).w < 0.0 ? 1.0 : 0.0, 0.0, 0.0);
}
`;

// Pressure (r) carries the solid flag (g) along, so a neighbour's both come in one fetch: zero outside the box
// (open), mirrored at the obstacle (no flow through it).
const pressureChunk = /* glsl */ `
uniform sampler2D tPressure;
float pr(ivec3 c, float p0) {
  if (!inGrid(c)) return 0.0;
  vec2 v = texelFetch(tPressure, atlasPx(c), 0).rg;
  return v.g > 0.5 ? p0 : v.r;
}
`;

const jacobiShader = (header) => /* glsl */ `
${header}
${pressureChunk}
uniform sampler2D tDivergence;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  float p0 = texelFetch(tPressure, px, 0).r;
  vec2 div = texelFetch(tDivergence, px, 0).rg;
  float s = pr(c + ivec3(1, 0, 0), p0) + pr(c - ivec3(1, 0, 0), p0) + pr(c + ivec3(0, 1, 0), p0) + pr(c - ivec3(0, 1, 0), p0)
    + pr(c + ivec3(0, 0, 1), p0) + pr(c - ivec3(0, 0, 1), p0);
  fragColor = vec4((s - H * H * div.r) / 6.0, div.g, 0.0, 0.0);
}
`;

const projectShader = (header) => /* glsl */ `
${header}
${pressureChunk}
uniform sampler2D tState;
uniform sampler2D tSolid;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(px);
  vec4 s = texelFetch(tState, px, 0);
  vec4 solid = texelFetch(tSolid, px, 0);
  if (solid.w < 0.0) {
    fragColor = vec4(solid.xyz, 0.0);
    return;
  }
  float p0 = texelFetch(tPressure, px, 0).r;
  vec3 grad = vec3(pr(c + ivec3(1, 0, 0), p0) - pr(c - ivec3(1, 0, 0), p0), pr(c + ivec3(0, 1, 0), p0) - pr(c - ivec3(0, 1, 0), p0),
    pr(c + ivec3(0, 0, 1), p0) - pr(c - ivec3(0, 0, 1), p0)) * (0.5 / H);
  fragColor = vec4(s.xyz - grad, s.w);
}
`;

// MacCormack correction for the density (traced back forward to estimate the error, clamped to the cells it came
// from): a GLSL snippet for a forces pass, with s this cell's state before advection, a after, c and g its cell.
export const maccormackGLSL = /* glsl */ `
  vec3 back = g - dt * s.xyz / H;
  float d = a.w;
  if (all(greaterThan(back, vec3(0.5))) && all(lessThan(back, GRID - 0.5))) {
    float err = s.w - sampleGrid(tAdvected, g + dt * s.xyz / H).w;
    ivec3 b0 = ivec3(floor(back - 0.5));
    float lo = 1e9, hi = -1e9;
    for (int k = 0; k < 8; k++) {
      float w = texelFetch(tState, clampedPx(b0 + ivec3(k & 1, (k >> 1) & 1, k >> 2)), 0).w;
      lo = min(lo, w);
      hi = max(hi, w);
    }
    d = clamp(d + 0.5 * err, lo, hi);
  }`;

// A tiling smooth random field, four independent channels: white noise blurred twice by a [1 2 1] kernel on each axis.
// Built a pass at a time, yielding between them, so it never holds up a frame.
export async function noiseTexture(n = 48) {
  const size = n * n * n;
  const idle = () => new Promise((resolve) => setTimeout(resolve, 0));
  let a = new Float32Array(size * 4), b = new Float32Array(size * 4);
  for (let i = 0; i < a.length; i++) a[i] = nativeRandom();
  for (let pass = 0; pass < 6; pass++) {
    await idle();
    const axis = pass % 3, st = 4 * n ** axis;
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++) {
        const row = 4 * n * (y + n * z);
        const c0 = axis === 1 ? y : z;
        for (let x = 0; x < n; x++) {
          const c = axis === 0 ? x : c0;
          const k = row + 4 * x;
          const m = k - (c === 0 ? 1 - n : 1) * st, p = k + (c === n - 1 ? 1 - n : 1) * st;
          for (let j = 0; j < 4; j++) b[k + j] = 0.25 * (a[m + j] + a[p + j]) + 0.5 * a[k + j];
        }
      }
    [a, b] = [b, a];
  }
  await idle();
  // Stretched back to the full range.
  const data = new Uint8Array(size * 4);
  for (let k = 0; k < 4; k++) {
    let mean = 0, sq = 0;
    for (let i = k; i < a.length; i += 4) mean += a[i];
    mean /= size;
    for (let i = k; i < a.length; i += 4) sq += (a[i] - mean) ** 2;
    const scale = 255 / (5 * Math.sqrt(sq / size));
    for (let i = k; i < a.length; i += 4) data[i] = Math.max(0, Math.min(255, Math.round(127.5 + (a[i] - mean) * scale)));
  }
  const t = new Data3DTexture(data, n, n, n);
  t.format = RGBAFormat;
  t.type = UnsignedByteType;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export const target = (filter, w = 1, h = 1, format = RGBAFormat) =>
  new WebGLRenderTarget(w, h, {
    type: HalfFloatType,
    format,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    colorSpace: NoColorSpace,
    depthBuffer: false,
  });

// A scene with one full-screen triangle.
export const quad = (material) => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  return scene;
};

const _clear = new Color();

// grid: as gridGLSL. header: passHeader's output for it. shared: uniforms every pass gets (the obstacle's pose, ...).
// obstacle, forces: { fragmentShader, uniforms } of the day's two passes; advect replaces the default one. The forces
// pass gets tState (before advection), tAdvected, tSolid and dt on top of its own. carry (optional): a pass run after
// each step that carries a field of the day's own along the new flow, given tState and tCarry (its last value), e.g.
// texture coordinates; this.carried is its texture. jacobi: pressure iterations.
export class SmokeGrid {
  constructor({ grid, header, shared = {}, obstacle, forces, advect = null, carry = null, jacobi = 18, vorticity = 4.0 }) {
    this.grid = grid;
    this.jacobi = jacobi;
    const AW = grid.nx * grid.tx, AH = grid.ny * grid.ty;
    this.states = [target(LinearFilter, AW, AH), target(LinearFilter, AW, AH), target(LinearFilter, AW, AH)];
    this.solid = target(NearestFilter, AW, AH);
    this.curl = target(NearestFilter, AW, AH);
    this.divergence = target(NearestFilter, AW, AH, RGFormat);
    this.pressure = [target(NearestFilter, AW, AH, RGFormat), target(NearestFilter, AW, AH, RGFormat)];
    this.dt = { value: 1 / 75 };
    const material = (fragmentShader, uniforms) =>
      new RawShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, depthTest: false, depthWrite: false, uniforms: { ...shared, ...uniforms } });
    const dtU = this.dt;
    this.passes = {
      obstacle: material(obstacle.fragmentShader, obstacle.uniforms ?? {}),
      advect: advect
        ? material(advect.fragmentShader, { tState: { value: null }, dt: dtU, ...advect.uniforms })
        : material(advectShader(header), { tState: { value: null }, dt: dtU }),
      forces: material(forces.fragmentShader, {
        tState: { value: null },
        tAdvected: { value: null },
        tSolid: { value: this.solid.texture },
        dt: dtU,
        ...forces.uniforms,
      }),
      curl: material(curlShader(header), { tState: { value: null } }),
      confine: material(confineShader(header), { tState: { value: null }, tCurl: { value: this.curl.texture }, dt: dtU, vorticity: { value: vorticity } }),
      divergence: material(divergenceShader(header), { tState: { value: null }, tSolid: { value: this.solid.texture } }),
      jacobi: material(jacobiShader(header), { tPressure: { value: null }, tDivergence: { value: this.divergence.texture } }),
      project: material(projectShader(header), { tState: { value: null }, tSolid: { value: this.solid.texture }, tPressure: { value: null } }),
    };
    if (carry) {
      this.carries = [target(LinearFilter, AW, AH), target(LinearFilter, AW, AH)];
      this.passes.carry = material(carry.fragmentShader, { tState: { value: null }, tCarry: { value: null }, dt: dtU, ...carry.uniforms });
    }
    this.scene = quad(this.passes.advect);
    this.mesh = this.scene.children[0];
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // The current state: velocity (xyz) and density (w) per cell, in the atlas.
  get texture() {
    return this.states[0].texture;
  }

  get carried() {
    return this.carries?.[0].texture ?? null;
  }

  compile(renderer, extra = []) {
    return Promise.all([...Object.values(this.passes), ...extra].map((m) => renderer.compileAsync(quad(m), this.camera)));
  }

  run(renderer, material, out) {
    this.mesh.material = material;
    renderer.setRenderTarget(out);
    renderer.render(this.scene, this.camera);
  }

  // Everything to zero: no smoke, still air.
  clear(renderer) {
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(_clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [...this.states, ...this.pressure, this.solid, this.curl, this.divergence, ...(this.carries ?? [])]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(_clear, alpha);
    renderer.setRenderTarget(prev);
  }

  // Writes material's output as the state (e.g. a day's initial smoke).
  fill(renderer, material) {
    const prev = renderer.getRenderTarget();
    this.run(renderer, material, this.states[0]);
    renderer.setRenderTarget(prev);
  }

  // One step of this.dt.value seconds. Leaves the render target changed; the caller restores it.
  step(renderer) {
    const s = this.passes, state = this.states, pressure = this.pressure;
    this.run(renderer, s.obstacle, this.solid);
    s.advect.uniforms.tState.value = state[0].texture;
    this.run(renderer, s.advect, state[1]);
    s.forces.uniforms.tState.value = state[0].texture;
    s.forces.uniforms.tAdvected.value = state[1].texture;
    this.run(renderer, s.forces, state[2]);
    s.curl.uniforms.tState.value = state[2].texture;
    this.run(renderer, s.curl, this.curl);
    s.confine.uniforms.tState.value = state[2].texture;
    this.run(renderer, s.confine, state[0]);
    s.divergence.uniforms.tState.value = state[0].texture;
    this.run(renderer, s.divergence, this.divergence);
    // Warm started from the last step's pressure.
    for (let i = 0; i < this.jacobi; i++) {
      s.jacobi.uniforms.tPressure.value = pressure[0].texture;
      this.run(renderer, s.jacobi, pressure[1]);
      pressure.reverse();
    }
    s.project.uniforms.tState.value = state[0].texture;
    s.project.uniforms.tPressure.value = pressure[0].texture;
    this.run(renderer, s.project, state[1]);
    [state[0], state[1]] = [state[1], state[0]];
    if (s.carry) {
      s.carry.uniforms.tState.value = state[0].texture;
      s.carry.uniforms.tCarry.value = this.carries[0].texture;
      this.run(renderer, s.carry, this.carries[1]);
      this.carries.reverse();
    }
  }
}
