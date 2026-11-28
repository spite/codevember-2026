import {
  Data3DTexture,
  DataTexture,
  WebGL3DRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  RedFormat,
  RGBAFormat,
  RGBAIntegerFormat,
  FloatType,
  HalfFloatType,
  UnsignedByteType,
  UnsignedShortType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
} from "three";

// Waves on the coat: a height field on the body's surface mesh (object space), moved by the damped wave equation
//   h'' = c² ∆h − β ∆²h − k h − γ h' + ν ∆h' + forcing
// with the cotangent Laplacian. The k h term pulls the coat back to an even thickness, so the lowest modes ring
// (the whole volume wobbles) instead of drifting. Volume is kept by removing the mean each step. The heights are
// splatted into a coarse 3D texture over the body's box, which the water shader reads as extra coat thickness: the CPU
// uploads the vertex heights, and a GPU pass fills each voxel from up to 4 vertices of a fixed map (built by a worker).

export const WAVES = {
  speed: 1.1, // world units / s
  restore: 25, // k: about 0.8 Hz for the whole-volume wobble
  damping: 0.35, // γ, 1/s
  viscosity: 0.0015, // ν: damps waves near the mesh's spacing (which the soft limits feed) much harder than long ones
  capillary: 0, // β (world units⁴ / s²): dispersion, so short ripples run ahead
  inertia: 0.2, // steady coat rise (world units) per unit of outward inertial acceleration, times restore
};

const GRID = 64;
const HEIGHT_WIDTH = 256;

let pass = null;
function splatPass() {
  if (pass) return pass;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
    fragmentShader: /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp sampler3D;
uniform usampler3D indexTex;
uniform sampler3D weightTex;
uniform sampler2D heights;
uniform int layer;
uniform float scale;
out vec4 outColor;
float heightOf(uint i) {
  int w = textureSize(heights, 0).x;
  return texelFetch(heights, ivec2(int(i) % w, int(i) / w), 0).r;
}
void main() {
  ivec3 v = ivec3(ivec2(gl_FragCoord.xy), layer);
  uvec4 i = texelFetch(indexTex, v, 0);
  vec4 w = texelFetch(weightTex, v, 0);
  float h = w.x * heightOf(i.x) + w.y * heightOf(i.y) + w.z * heightOf(i.z) + w.w * heightOf(i.w);
  outColor = vec4(h * scale, 0.0, 0.0, 1.0);
}
`,
    uniforms: { indexTex: { value: null }, weightTex: { value: null }, heights: { value: null }, layer: { value: 0 }, scale: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  pass = { scene: new Scene().add(mesh), camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
  return pass;
}

let worker = null, nextId = 0, workerDead = false;
const pending = new Map();
const emptyMap = () => ({ voxel: new Int32Array(0), index: new Int32Array(0), weight: new Float32Array(0) });
function requestSplat(pos, sdf, box, edge) {
  if (workerDead) return Promise.resolve(emptyMap());
  if (!worker) {
    worker = new Worker(new URL("./splat.worker.js", import.meta.url));
    worker.onmessage = (e) => {
      if (e.data.error) console.error("Splat worker:", e.data.error);
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    // Failed to load: every map comes back empty (no waves on the surface), so nothing waits on it.
    worker.onerror = (e) => {
      console.error("Splat worker failed", e.message);
      workerDead = true;
      for (const done of pending.values()) done(emptyMap());
      pending.clear();
    };
  }
  const id = nextId++;
  const field = { data: sdf.texture.image.data, res: sdf.res, min: sdf.min, size: sdf.size };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, pos, field, box, grid: GRID, edge });
  });
}

export class SurfaceWaves {
  // walk: the surface mesh (BufferGeometry, object space); topo: its topology (cotangent weights, vertex areas);
  // sdf: day 3's CPU field (sample, grad); box: { min, size } of the texture, in object space.
  constructor(renderer, walk, topo, sdf, box, scale) {
    this.scale = scale;
    const pos = walk.attributes.position.array;
    const nor = walk.attributes.normal.array;
    const n = topo.nv;
    this.n = n;
    this.pos = pos;
    this.nor = nor;
    this.topo = topo;
    this.h = new Float32Array(n);
    this.v = new Float32Array(n);
    this.f = new Float32Array(n);
    this.lap = new Float32Array(n);
    this.lh2 = new Float32Array(n);
    // Vertex areas floored at half the mean, so a few sliver triangles don't force a tiny time step on everything.
    let meanArea = 0;
    for (let i = 0; i < n; i++) meanArea += topo.areas[i];
    meanArea /= n;
    this.invArea = new Float32Array(n);
    for (let i = 0; i < n; i++) this.invArea[i] = 1 / Math.max(topo.areas[i], 0.5 * meanArea);
    // Largest eigenvalue bound of the Laplacian, for the stable time step.
    let lmax = 0, edgeSum = 0, edges = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = topo.offsets[i]; k < topo.offsets[i + 1]; k++) {
        s += topo.weights[k];
        const j = topo.neighbours[k];
        edgeSum += Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]);
        edges++;
      }
      lmax = Math.max(lmax, 2 * s * this.invArea[i]);
    }
    this.lmax = lmax;
    this.edge = edgeSum / edges;
    this.box = box;
    this.map = null;
    // The voxel-to-vertex map is built by a worker; until it arrives the texture stays flat.
    this.ready = requestSplat(pos, sdf, box, this.edge).then((map) => this.buildMap(map));
    const rows = Math.ceil(n / HEIGHT_WIDTH);
    this.heights = new DataTexture(new Float32Array(HEIGHT_WIDTH * rows), HEIGHT_WIDTH, rows, RedFormat, FloatType);
    this.heights.minFilter = this.heights.magFilter = NearestFilter;
    this.target = new WebGL3DRenderTarget(GRID, GRID, GRID, { format: RedFormat, type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.target.texture.wrapS = this.target.texture.wrapT = this.target.texture.wrapR = ClampToEdgeWrapping;
    this.texture = this.target.texture;
    this.renderer = renderer;
    this.cleared = false;
    // Edge lengths, for the slope.
    this.edgeLength = new Float32Array(topo.neighbours.length);
    for (let i = 0; i < n; i++)
      for (let k = topo.offsets[i]; k < topo.offsets[i + 1]; k++) {
        const j = topo.neighbours[k];
        this.edgeLength[k] = Math.max(Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]), 1e-6);
      }
    this.slope = 0;
  }

  // Object-space gaussian around c (radius in object units): adds amount to each vertex's velocity.
  kick(c, amount, radius) {
    const { pos, v, n } = this;
    const r2 = 2 * radius * radius;
    for (let i = 0; i < n; i++) {
      const e = (pos[i * 3] - c.x) ** 2 + (pos[i * 3 + 1] - c.y) ** 2 + (pos[i * 3 + 2] - c.z) ** 2;
      if (e < 9 * r2) v[i] += amount * Math.exp(-e / r2);
    }
  }

  // Object-space gaussian around c: adds amount (object units) to each vertex's height.
  raise(c, amount, radius) {
    const { pos, h, n } = this;
    const r2 = 2 * radius * radius;
    for (let i = 0; i < n; i++) {
      const e = (pos[i * 3] - c.x) ** 2 + (pos[i * 3 + 1] - c.y) ** 2 + (pos[i * 3 + 2] - c.z) ** 2;
      if (e < 9 * r2) h[i] += amount * Math.exp(-e / r2);
    }
  }

  // presses: [{ c (object space), pressure, radius }]; inertial(x, y, z, nx, ny, nz) -> outward acceleration
  // (object space, world units / s²) or null; depth, crest: the deepest trough and highest crest (world units),
  // approached softly.
  step(dt, presses, inertial, depth = Infinity, crest = Infinity) {
    const { h, v, f, lap, n, topo, pos, nor } = this;
    const T = WAVES;
    const c = T.speed / this.scale;
    const beta = T.capillary / (this.scale * this.scale);
    const omega = Math.sqrt(c * c * this.lmax + beta * this.lmax * this.lmax + T.restore);
    // Both the waves and the viscous damping are explicit: the step stays inside both stability limits.
    const maxDt = Math.min((0.8 * 2) / omega, (0.8 * 2) / Math.max(T.viscosity * this.lmax, 1e-6));
    const lh2 = this.lh2;
    const steps = Math.max(1, Math.ceil(dt / maxDt));
    const h_ = dt / steps;
    f.fill(0);
    for (const p of presses) {
      const r2 = 2 * p.radius * p.radius;
      for (let i = 0; i < n; i++) {
        const e = (pos[i * 3] - p.c.x) ** 2 + (pos[i * 3 + 1] - p.c.y) ** 2 + (pos[i * 3 + 2] - p.c.z) ** 2;
        if (e < 9 * r2) f[i] -= p.pressure * Math.exp(-e / r2);
      }
    }
    if (inertial)
      for (let i = 0; i < n; i++) f[i] += (T.inertia / this.scale) * inertial(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]);
    const { offsets, neighbours, weights } = topo;
    const invArea = this.invArea;
    for (let s = 0; s < steps; s++) {
      // ∆h and ∆v share the neighbour walk.
      for (let i = 0; i < n; i++) {
        let lh = 0, lv = 0;
        const hi = h[i], vi = v[i];
        for (let k = offsets[i]; k < offsets[i + 1]; k++) {
          const j = neighbours[k], w = weights[k];
          lh += w * (h[j] - hi);
          lv += w * (v[j] - vi);
        }
        const a = invArea[i];
        lh2[i] = lh * a;
        lap[i] = c * c * lh * a - T.restore * hi - T.damping * vi + T.viscosity * lv * a + f[i];
      }
      // Capillary term −β∆²h: short waves outrun long ones, so a tap spreads into a train of ripples.
      if (beta > 0)
        for (let i = 0; i < n; i++) {
          let l = 0;
          const li = lh2[i];
          for (let k = offsets[i]; k < offsets[i + 1]; k++) l += weights[k] * (lh2[neighbours[k]] - li);
          lap[i] -= beta * l * invArea[i];
        }
      let mean = 0;
      for (let i = 0; i < n; i++) {
        v[i] += lap[i] * h_;
        mean += v[i];
      }
      mean /= n;
      const floor = -depth / this.scale, top = crest / this.scale;
      for (let i = 0; i < n; i++) {
        v[i] -= mean;
        h[i] += v[i] * h_;
        // The coat can't thin past its floor: troughs level off and lose their speed into it.
        if (h[i] < 0.5 * floor) {
          const over = (0.5 * floor - h[i]) / (-0.5 * floor);
          h[i] = 0.5 * floor * (1 + over / (1 + over));
          if (v[i] < 0) v[i] *= 0.5;
        } else if (h[i] > 0.5 * top) {
          // Crests level off the same way, so a recoil can't shoot up into a spike.
          const over = (h[i] - 0.5 * top) / (0.5 * top);
          h[i] = 0.5 * top * (1 + over / (1 + over));
          if (v[i] > 0) v[i] *= 0.5;
        }
      }
    }
  }

  // The voxel-to-vertex map as two 3D textures: vertex indices (RGBA16UI) and weights (RGBA8).
  buildMap({ voxel, index, weight }) {
    const total = GRID ** 3;
    const ids = new Uint16Array(total * 4), ws = new Uint8Array(total * 4);
    for (let m = 0; m < voxel.length; m++) {
      const v = voxel[m];
      for (let k = 0; k < 4; k++) {
        ids[v * 4 + k] = index[m * 4 + k];
        ws[v * 4 + k] = Math.round(weight[m * 4 + k] * 255);
      }
    }
    const tex = (data, format, type) => {
      const t = new Data3DTexture(data, GRID, GRID, GRID);
      t.format = format;
      t.type = type;
      t.minFilter = t.magFilter = NearestFilter;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      return t;
    };
    const indexTex = tex(ids, RGBAIntegerFormat, UnsignedShortType);
    indexTex.internalFormat = "RGBA16UI";
    this.map = { index: indexTex, weight: tex(ws, RGBAFormat, UnsignedByteType) };
  }

  // Uploads the heights, splats them into the texture (world units), and measures the steepest slope, for the march.
  upload() {
    const { h, topo, renderer } = this;
    if (!this.map) return;
    this.heights.image.data.set(h);
    this.heights.needsUpdate = true;
    const p = splatPass();
    const u = p.material.uniforms;
    u.indexTex.value = this.map.index;
    u.weightTex.value = this.map.weight;
    u.heights.value = this.heights;
    u.scale.value = this.scale;
    const previous = renderer.getRenderTarget();
    for (let z = 0; z < GRID; z++) {
      u.layer.value = z;
      renderer.setRenderTarget(this.target, z);
      renderer.render(p.scene, p.camera);
    }
    renderer.setRenderTarget(previous);
    let slope = 0;
    const { offsets, neighbours } = topo, len = this.edgeLength;
    for (let i = 0; i < this.n; i += 3) {
      const hi = h[i];
      for (let k = offsets[i]; k < offsets[i + 1]; k++) slope = Math.max(slope, Math.abs(h[neighbours[k]] - hi) / len[k]);
    }
    // A blow-up (slope far beyond any real wave, or NaN) resets the coat instead of shattering it.
    if (!(slope < 4)) {
      this.reset();
      slope = 0;
    }
    this.slope = slope;
  }

  reset() {
    this.h.fill(0);
    this.v.fill(0);
  }
}
