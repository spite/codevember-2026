import {
  AlwaysDepth,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { fullscreenVertex, copyFragment } from "shaders/pipeline/copy.js";
import { SURFACE_SIDE, CELLS_SIDE, loadFields, tatteredCells } from "./veil-sim.js";
import { emberGLSL } from "./skull.js";


// A veil of thin cloth draped over the skull. The cloth is simulated in a worker, in the
// skull's own space, so the mesh only has to be a child of the skull: see veil-sim.js.

// How much of the light falling on the far side of the cloth comes out of the near side.
const TRANSLUCENCY = 0.6;
// How much the color of the cloth tints what's seen through it.
const TINT = 0.6;
// How much of its opacity the most worn cloth loses.
const THINNESS = 0.85;
// Cloth within JAW_CONTACT of the jaw moves with it between updates from the worker, and
// cloth out to JAW_REACH partly: see followJaw. In meters.
const JAW_CONTACT = 0.012;
const JAW_REACH = 0.04;
// How opaque the dirtiest cloth is.
const DIRT_OPACITY = 0.5;
// Shared by the near and far side: the tattered outline (g: coverage, r: worn thin), the dirt, and the dissolve that
// takes the veil away and brings the next one (veilFade 1 = all there).
const clothGLSL = /* glsl */ `
uniform sampler2D outlineMap;
uniform sampler2D dirtMap;
uniform float tattered;
uniform float veilOpacity;
uniform float veilFade;
float veilHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float veilNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(veilHash(i), veilHash(i + vec2(1, 0)), f.x), mix(veilHash(i + vec2(0, 1)), veilHash(i + vec2(1, 1)), f.x), f.y);
}
// Coverage of the pixel by cloth, with how thin it's worn and its dirt.
float veilCloth(vec2 uv, out float thin, out vec3 dirt) {
  float coverage = 1.0;
  thin = 0.0;
  dirt = vec3(1.0);
  if (tattered > 0.5) {
    vec4 o = texture(outlineMap, uv);
    coverage = o.g;
    thin = o.r;
    dirt = texture(dirtMap, uv).rgb;
  }
  if (veilFade < 1.0) {
    float n = 0.65 * veilNoise(uv * 14.0) + 0.35 * veilNoise(uv * 41.0);
    coverage *= smoothstep(n - 0.04, n + 0.04, veilFade * 1.1 - 0.05);
  }
  return coverage;
}
`;

function clothUniforms() {
  return {
    outlineMap: { value: null },
    dirtMap: { value: null },
    tattered: { value: 0 },
    veilOpacity: { value: 0.2 },
    veilFade: { value: 0 },
  };
}

// The near side, drawn by the composite over a blurred picture of what's behind it.
function createFrontMaterial(cloth, ember, behind) {
  return new PipelineMaterial({
    color: 0xdedede,
    roughness: 0.9,
    sheen: 0.4,
    sheenRoughness: 0.85,
    transmission: TRANSLUCENCY,
    thinSheet: true,
    transparent: true,
    uniforms: { ...cloth, ...ember, behindMap: behind, veilTint: { value: TINT } },
    fragmentPars: /* glsl */ `
${clothGLSL}
${emberGLSL}
uniform sampler2D behindMap;
uniform float veilTint;
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  float thin;
  vec3 dirt;
  s.alpha = veilCloth(vUv, thin, dirt);
  s.specular = 0.0;
  float dirtiness = 1.0 - dirt.g;
  float op = mix(veilOpacity, 1.0, ${DIRT_OPACITY.toFixed(2)} * dirtiness) * (1.0 - ${THINNESS.toFixed(2)} * thin);
  vec3 cloth = s.albedo * dirt;
  vec3 behind = texture(behindMap, gl_FragCoord.xy / resolution).rgb;
  behind *= mix(vec3(1.0), cloth, mix(veilTint, 1.0, dirtiness));
  s.albedo = cloth * op;
  s.sheenColor *= op;
  s.transmission *= op;
  s.transmissionOcclusion = 0.25;
  vec3 glow = emberIrradiance(vWorldPosition, normalize(s.normal), true);
  s.emissive += behind * (1.0 - op) + cloth * op * ${TRANSLUCENCY.toFixed(2)} * (1.0 / 3.14159265) * glow;
}
`,
  });
}

// The far side, hanging behind the skull, drawn in the main pass. It also casts the whole veil's shadow, half the
// light let through as a checkerboard that the shadow filtering evens out.
function createRearMaterial(cloth, ember) {
  const material = new PipelineMaterial({
    color: 0xdedede,
    roughness: 0.9,
    sheen: 0.4,
    sheenRoughness: 0.85,
    transmission: TRANSLUCENCY,
    side: BackSide,
    transparent: true,
    uniforms: { ...cloth, ...ember },
    fragmentPars: /* glsl */ `
${clothGLSL}
${emberGLSL}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  float thin;
  vec3 dirt;
  float coverage = veilCloth(vUv, thin, dirt);
#ifdef PIPELINE_SHADOW
  float checker = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0);
  s.alpha = coverage > 0.35 && thin < 0.6 ? checker : 0.0;
#else
  s.specular = 0.0;
  float dirtiness = 1.0 - dirt.g;
  float op = mix(veilOpacity, 1.0, ${DIRT_OPACITY.toFixed(2)} * dirtiness) * (1.0 - ${THINNESS.toFixed(2)} * thin);
  s.albedo *= dirt;
  s.alpha = coverage * op;
  vec3 glow = emberIrradiance(vWorldPosition, normalize(s.normal), true);
  s.emissive += s.albedo * ${TRANSLUCENCY.toFixed(2)} * (1.0 / 3.14159265) * glow;
#endif
}
`,
  });
  material.shadowSide = DoubleSide;
  material.depthWrite = false;
  return material;
}

// What's behind the near side, blurred, and the near side drawn over it: a full-screen pass in the Pipeline's
// composite hook. The scene is copied into a multisampled target with its depth (from the prepass), so the cloth is
// hidden where the skull is in front of it, antialiased like the main pass.
const fillFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = texture(tColor, vUv);
  gl_FragDepth = texture(tDepth, vUv).r;
}
`;
const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 direction;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -4; i <= 4; i++) {
    float w = exp(-float(i * i) / 8.0);
    sum += w * texture(tInput, vUv + direction * float(i));
    total += w;
  }
  outColor = sum / total;
}
`;

function target(options = {}) {
  return new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, ...options });
}

class VeilComposite {
  constructor(renderer, { samples = 4 } = {}) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.output = target({ depthBuffer: true, samples });
    this.half = target();
    this.blurA = target();
    this.blurB = target();
    this.behind = { value: this.blurB.texture };
    this.diffusion = 0.2;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = (fragmentShader, uniforms, options = {}) =>
      new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...options });
    this.fill = quad(fillFragment, { tColor: { value: null }, tDepth: { value: null } }, { depthTest: true, depthWrite: true, depthFunc: AlwaysDepth });
    this.blur = quad(blurFragment, { tInput: { value: null }, direction: { value: new Vector2() } });
    this.copy = quad(copyFragment, { tInput: { value: null }, weight: { value: 1 } });
    this.quad = new Mesh(geometry, this.fill);
    this.quad.frustumCulled = false;
    this.quadScene = new Scene().add(this.quad);
    this.quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  pass(material, to) {
    this.quad.material = material;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  blurPass(from, to, x, y) {
    this.blur.uniforms.tInput.value = from.texture;
    this.blur.uniforms.direction.value.set(x / to.width, y / to.height);
    this.pass(this.blur, to);
  }

  render(hdr, { depthTexture, camera, width, height }) {
    if (!this.scene.children.some((o) => o.visible)) return hdr;
    const renderer = this.renderer;
    const w = Math.max(1, Math.round(width / 4));
    const h = Math.max(1, Math.round(height / 4));
    if (this.output.width !== width || this.output.height !== height) this.output.setSize(width, height);
    if (this.blurA.width !== w || this.blurA.height !== h) {
      this.half.setSize(w * 2, h * 2);
      this.blurA.setSize(w, h);
      this.blurB.setSize(w, h);
    }
    // Two rounds, the second twice as wide; past about a texel and a half between taps the first would show its samples.
    this.copy.uniforms.tInput.value = hdr;
    this.pass(this.copy, this.half);
    const step = 0.2 + 1.3 * this.diffusion;
    this.blurPass(this.half, this.blurA, step, 0);
    this.blurPass(this.blurA, this.blurB, 0, step);
    this.blurPass(this.blurB, this.blurA, step * 2, 0);
    this.blurPass(this.blurA, this.blurB, 0, step * 2);

    this.fill.uniforms.tColor.value = hdr;
    this.fill.uniforms.tDepth.value = depthTexture;
    renderer.setRenderTarget(this.output);
    renderer.clear(false, true, false);
    this.pass(this.fill, this.output);
    renderer.render(this.scene, camera);
    return this.output.texture;
  }
}

class Veil {
  // `fieldsUrl`: the skull's distance fields; `offset`: how far off the surface the cloth rides, in metres.
  constructor(fieldsUrl, { offset, ember, composite, fields }) {
    this.draft = 5;
    this.loose = 0;
    this.ready = false;
    this.error = "";
    this.tattered = false;
    this.tatterSeed = -1;
    // Bumped on every drop; surfaces from before the last one are not shown.
    this.generation = 0;
    this.shownGeneration = -1;
    this.surface = new Float32Array(SURFACE_SIDE * SURFACE_SIDE * 3);
    this.prevSurface = new Float32Array(this.surface.length);
    this.normals = new Float32Array(this.surface.length);
    this.prevNormals = new Float32Array(this.surface.length);
    this.display = new Float32Array(this.surface.length);
    // When the last surface came back, and how far apart they come (ms).
    this.arrival = 0;
    this.interval = 25;
    this.jawField = null;
    this.surfaceJawInverse = new Matrix4();
    this.sentJawInverse = new Matrix4();
    this.gradient = [0, 0, 0];
    fields.then(
      ([, jaw]) => (this.jawField = jaw),
      (e) => (this.error = e.message),
    );
    this.tatterTextures = null;

    const M = SURFACE_SIDE;
    const uvs = new Float32Array(M * M * 2);
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        const a = j * M + i;
        uvs[a * 2] = i / (M - 1);
        uvs[a * 2 + 1] = j / (M - 1);
      }
    }
    this.geometry = new BufferGeometry();
    for (const name of ["position", "normal"]) {
      this.geometry.setAttribute(name, new BufferAttribute(new Float32Array(M * M * 3), 3).setUsage(DynamicDrawUsage));
    }
    this.geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    // Never recomputed: around the skull and wherever the hem swings, in its space (metres).
    this.geometry.boundingSphere = new Sphere(new Vector3(0, 0.08, 0.02), 0.3);
    this.setIndex(null);

    this.cloth = clothUniforms();
    this.frontMaterial = createFrontMaterial(this.cloth, ember, composite.behind);
    this.rearMaterial = createRearMaterial(this.cloth, ember);
    // The far side lives in the skull; the near side in the composite's scene, placed where the far side is.
    this.mesh = new Mesh(this.geometry, this.rearMaterial);
    this.mesh.frustumCulled = false;
    this.front = new Mesh(this.geometry, this.frontMaterial);
    this.front.frustumCulled = false;
    this.front.matrixAutoUpdate = false;
    this.mesh.visible = this.front.visible = false;
    composite.scene.add(this.front);
    this.composite = composite;

    this.busy = true;
    this.buffers = null;
    this.pendingTime = 0;
    this.pendingMotion = new Matrix4();
    this.worker = new Worker(new URL("./veil-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = (e) => (this.error = e.message || "The veil's worker failed to load");
    this.worker.postMessage({ type: "init", fields: new URL(fieldsUrl, document.baseURI).href, offset });
  }

  // Triangles for the cells of the cloth that are there: all of them, without `cells`.
  setIndex(cells) {
    const M = SURFACE_SIDE;
    const index = [];
    for (let j = 0; j + 1 < M; j++) {
      for (let i = 0; i + 1 < M; i++) {
        if (cells && !cells[(j >> 1) * CELLS_SIDE + (i >> 1)]) continue;
        const a = j * M + i;
        index.push(a, a + M, a + 1, a + 1, a + M, a + M + 1);
      }
    }
    this.geometry.setIndex(index);
  }

  // Tears the veil to tatters (each seed differently), or makes it whole, and drops it.
  setTattered(tattered, seed) {
    if (tattered === this.tattered && (!tattered || seed === this.tatterSeed)) return this.drop();
    this.tattered = tattered;
    this.tatterSeed = seed;
    const cells = tattered ? tatteredCells(seed) : null;
    this.setIndex(cells);
    if (this.tatterTextures) {
      this.tatterTextures.outline.dispose();
      this.tatterTextures.dirt.dispose();
    }
    // The worker sends the maps of a tattered cut before its first surface.
    this.tatterTextures = null;
    this.cloth.outlineMap.value = this.cloth.dirtMap.value = null;
    this.cloth.tattered.value = 0;
    this.worker.postMessage({ type: "tatter", tattered, seed, generation: ++this.generation });
  }

  // Drops the veil again.
  drop() {
    this.worker.postMessage({ type: "reset", generation: ++this.generation });
  }

  // True once the surface of the last drop has come back.
  get settled() {
    return this.shownGeneration === this.generation;
  }

  receive(data) {
    if (data.type === "error") {
      this.error = data.message;
      return;
    }
    if (data.type === "tatter") {
      if (data.seed === this.tatterSeed && this.tattered) this.setTatterMaps(data);
      return;
    }
    this.buffers = [data.positions, data.normals];
    this.busy = false;
    // A surface from before the last drop goes back unseen: the old veil is already gone.
    if (data.generation !== this.generation) return;
    // Kept with the one before, to draw between them: see present().
    const first = this.shownGeneration !== data.generation;
    this.prevSurface.set(first ? data.positions : this.surface);
    this.prevNormals.set(first ? data.normals : this.normals);
    this.surface.set(data.positions);
    this.normals.set(data.normals);
    const now = performance.now();
    if (!first) this.interval += (Math.min(100, now - this.arrival) - this.interval) * 0.25;
    this.arrival = now;
    this.surfaceJawInverse.copy(this.sentJawInverse);
    this.shownGeneration = data.generation;
    this.ready = true;
  }

  setTatterMaps({ size, outline, dirt }) {
    // Threads are finer than a pixel from any distance, so the outline is averaged down: coverage per pixel.
    const outlineTexture = new DataTexture(outline, size, size);
    outlineTexture.magFilter = LinearFilter;
    outlineTexture.minFilter = LinearMipmapLinearFilter;
    outlineTexture.generateMipmaps = true;
    outlineTexture.anisotropy = 8;
    outlineTexture.needsUpdate = true;
    const dirtTexture = new DataTexture(dirt, size, size);
    dirtTexture.magFilter = LinearFilter;
    dirtTexture.minFilter = LinearMipmapLinearFilter;
    dirtTexture.generateMipmaps = true;
    dirtTexture.colorSpace = SRGBColorSpace;
    dirtTexture.needsUpdate = true;
    this.tatterTextures = { outline: outlineTexture, dirt: dirtTexture };
    this.cloth.outlineMap.value = outlineTexture;
    this.cloth.dirtMap.value = dirtTexture;
    this.cloth.tattered.value = 1;
  }

  setLook({ color, opacity, fade }) {
    this.frontMaterial.color.set(color);
    this.rearMaterial.color.set(color);
    this.cloth.veilOpacity.value = opacity;
    this.cloth.veilFade.value = fade;
  }

  setVisible(visible) {
    const shown = visible && this.ready && this.cloth.veilFade.value > 0.001;
    this.mesh.visible = this.front.visible = shown;
  }

  // The surface comes back from the worker a frame or two late, shaped around where the jaw was then; the cloth on or
  // near the jaw is carried along with it to where it is now.
  // The worker's surfaces come a few frames apart; the cloth is drawn between the last two, one surface behind, so it
  // moves every frame.
  present() {
    const t = Math.min(1, Math.max(0, (performance.now() - this.arrival) / this.interval));
    const { prevSurface, surface, prevNormals, normals, display } = this;
    const normal = this.geometry.getAttribute("normal");
    const n = normal.array;
    for (let i = 0; i < display.length; i++) {
      display[i] = prevSurface[i] + (surface[i] - prevSurface[i]) * t;
      n[i] = prevNormals[i] + (normals[i] - prevNormals[i]) * t;
    }
    normal.needsUpdate = true;
  }

  followJaw(jawMatrix) {
    if (!this.ready) return;
    this.present();
    const { display: surface, gradient } = this;
    const field = this.jawField;
    const position = this.geometry.getAttribute("position");
    const out = position.array;
    if (!field) {
      out.set(surface);
      position.needsUpdate = true;
      return;
    }
    const a = this.surfaceJawInverse.elements;
    const b = jawMatrix.elements;
    for (let o = 0; o < surface.length; o += 3) {
      const x = surface[o];
      const y = surface[o + 1];
      const z = surface[o + 2];
      const qx = a[0] * x + a[4] * y + a[8] * z + a[12];
      const qy = a[1] * x + a[5] * y + a[9] * z + a[13];
      const qz = a[2] * x + a[6] * y + a[10] * z + a[14];
      const d = field.sample(qx, qy, qz, gradient);
      if (d >= JAW_REACH) {
        out[o] = x;
        out[o + 1] = y;
        out[o + 2] = z;
        continue;
      }
      const t = Math.min(1, Math.max(0, (JAW_REACH - d) / (JAW_REACH - JAW_CONTACT)));
      const w = t * t * (3 - 2 * t);
      out[o] = x + (b[0] * qx + b[4] * qy + b[8] * qz + b[12] - x) * w;
      out[o + 1] = y + (b[1] * qx + b[5] * qy + b[9] * qz + b[13] - y) * w;
      out[o + 2] = z + (b[2] * qx + b[6] * qy + b[10] * qz + b[14] - z) * w;
    }
    position.needsUpdate = true;
  }

  // Advances the simulation by dt: gravity is down in the skull's space, jawMatrix/jawInverse take the jaw's rest pose
  // to its current one and back, and delta (if given) is the head's motion since the last update.
  update(dt, gravity, jawMatrix, jawInverse, delta) {
    this.front.matrix.copy(this.mesh.matrixWorld);
    this.front.matrixWorld.copy(this.mesh.matrixWorld);
    this.followJaw(jawMatrix);
    this.pendingTime = Math.min(0.1, this.pendingTime + dt);
    if (delta && delta.determinant() > 0) this.pendingMotion.premultiply(delta);
    else this.pendingMotion.identity();
    if (this.busy) return;
    const [positions, normals] = this.buffers;
    this.sentJawInverse.copy(jawInverse);
    this.worker.postMessage(
      {
        type: "update",
        dt: this.pendingTime,
        draft: this.draft,
        loose: this.loose,
        gravity: gravity.toArray(),
        jawMatrix: jawMatrix.toArray(),
        jawInverse: jawInverse.toArray(),
        delta: this.pendingMotion.toArray(),
        positions,
        normals,
      },
      [positions.buffer, normals.buffer],
    );
    this.busy = true;
    this.buffers = null;
    this.pendingTime = 0;
    this.pendingMotion.identity();
  }
}

export { Veil, VeilComposite, loadFields };
