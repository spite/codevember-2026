import {
  AlwaysDepth,
  Color,
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
import { SURFACE_SIDE, CELLS_SIDE, loadFields, tatteredCells, VeilSim } from "./veil-sim.js";
import { emberGLSL } from "./skull.js";
import { nativeRandom } from "modules/random.js";


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
uniform float veilDiffusion;
// The share of light the cloth stops, from how much it hides (op): never none while it's there.
float veilBlocked(float op) {
  return mix(0.15 + 0.3 * veilDiffusion, 1.0, op);
}
float veilHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float veilNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(veilHash(i), veilHash(i + vec2(1, 0)), f.x), mix(veilHash(i + vec2(0, 1)), veilHash(i + vec2(1, 1)), f.x), f.y);
}
// Soft cloth needs no blocker search: a fixed filter, offset toward the light from whichever side faces it. The cloth's
// own shadow is stochastic (redrawn every frame), so it takes many taps over a wide disc to read as an even shade.
float veilShadow(vec3 P, vec3 n) {
  if (shadowEnabled < 0.5) return 1.0;
  vec3 N = dot(n, lightDirection) < 0.0 ? -n : n;
  vec3 row0 = vec3(shadowMatrix[0][0], shadowMatrix[1][0], shadowMatrix[2][0]);
  vec3 row2 = vec3(shadowMatrix[0][2], shadowMatrix[1][2], shadowMatrix[2][2]);
  vec3 L = -normalize(row2);
  float worldPerUV = 2.0 / length(row0);
  float worldPerDepth = 2.0 / length(row2);
  float ndl = dot(N, L);
  if (ndl <= 0.0) return 1.0;
  float texelWorld = worldPerUV / shadowMapSize.x;
  vec4 sc = shadowMatrix * vec4(P + N * (shadowNormalBias + texelWorld * (1.5 + 3.0 * (1.0 - ndl))), 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  vec2 edge = min(c.xy, 1.0 - c.xy);
  float fade = smoothstep(0.0, 0.02, min(edge.x, edge.y)) * step(0.0, c.z);
  if (fade <= 0.0) return 1.0;
  vec2 grad = shadowPlaneGradient(N, ndl, worldPerUV, worldPerDepth);
  float texel = 1.0 / shadowMapSize.x;
  float radius = 9.0 * texel;
  float lit = 0.0;
  for (int i = 0; i < 32; i++) {
    vec2 o = shadowVogel(i, 32, 0.0, 0.5) * radius;
    lit += textureGrad(shadowMapCmp, vec3(c.xy + o, shadowRef(min(c.z, 1.0), grad, o, texel)), vec2(0.0), vec2(0.0));
  }
  return mix(1.0, lit / 32.0, fade * smoothstep(0.0, 0.12, ndl));
}
// Coverage of the pixel by cloth, with how thin it's worn and its dirt.
float veilCloth(vec2 uv, out float thin, out vec3 dirt) {
  float coverage = 1.0;
  thin = 0.0;
  dirt = vec3(1.0);
  if (tattered > 0.5) {
    vec4 o = texture(outlineMap, uv);
    // The edge distance (texels) cut over one pixel, so edges stay smooth however close.
    float d = (o.g - 0.5) * 8.0;
    coverage = clamp(0.5 + d / max(fwidth(d), 1e-4), 0.0, 1.0);
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
    veilDiffusion: { value: 0.2 },
  };
}

// The cloth as seen, from either side, drawn by the composite over a blurred picture of what's behind it.
function createFrontMaterial(cloth, ember, behind) {
  return new PipelineMaterial({
    color: 0xdedede,
    side: DoubleSide,
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
  s.shadow = veilShadow(vWorldPosition, normalize(s.normal));
  vec3 glow = emberIrradiance(vWorldPosition, normalize(s.normal), true);
  s.emissive += behind * (1.0 - op) + cloth * op * ${TRANSLUCENCY.toFixed(2)} * (1.0 / 3.14159265) * glow;
}
`,
  });
}

// The far side, hanging behind the skull, drawn in the main pass. It also casts the whole veil's shadow: as much of the
// light as the cloth stops (see PIPELINE_SHADOW).
function createRearMaterial(cloth, ember) {
  const material = new PipelineMaterial({
    color: 0xdedede,
    roughness: 0.9,
    sheen: 0.4,
    sheenRoughness: 0.85,
    transmission: TRANSLUCENCY,
    side: BackSide,
    transparent: true,
    stochasticShadows: true,
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
  float dirtiness = 1.0 - dirt.g;
  float op = mix(veilOpacity, 1.0, ${DIRT_OPACITY.toFixed(2)} * dirtiness) * (1.0 - ${THINNESS.toFixed(2)} * thin);
#ifdef PIPELINE_SHADOW
  // Any cloth stops some light: its threads cover part of it, and the more it scatters (diffusion) the more of the beam
  // it turns away; what it hides on top of that (opacity) it stops too. That share is the chance of blocking, redrawn
  // every frame (stochasticShadows) and averaged by the shadow filter and its denoiser.
  s.alpha = coverage * veilBlocked(op);
#else
  s.specular = 0.0;
  s.albedo *= dirt;
  s.alpha = coverage * op;
  s.shadow = veilShadow(vWorldPosition, normalize(s.normal));
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
uniform sampler2D tDepth;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  outColor = vec4(0.0);
  gl_FragDepth = texture(tDepth, vUv).r;
}
`;
// The cloth layer (premultiplied) over the frame.
const overFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tLayer;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 layer = texture(tLayer, vUv);
  outColor = vec4(texture(tColor, vUv).rgb * (1.0 - layer.a) + layer.rgb, 1.0);
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
    // The cloth alone, multisampled over the scene's depth, then laid over the frame.
    this.layer = target({ depthBuffer: true, samples });
    this.output = target();
    this.half = target();
    this.blurA = target();
    this.blurB = target();
    this.behind = { value: this.blurB.texture };
    this.diffusion = 0.2;
    this.clearColor = new Color();
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = (fragmentShader, uniforms, options = {}) =>
      new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...options });
    this.fill = quad(fillFragment, { tDepth: { value: null } }, { depthTest: true, depthWrite: true, depthFunc: AlwaysDepth, colorWrite: false });
    this.over = quad(overFragment, { tColor: { value: null }, tLayer: { value: this.layer.texture } });
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
    if (this.output.width !== width || this.output.height !== height) {
      this.output.setSize(width, height);
      this.layer.setSize(width, height);
    }
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

    this.fill.uniforms.tDepth.value = depthTexture;
    renderer.setRenderTarget(this.layer);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.setClearColor(this.clearColor, clearAlpha);
    this.pass(this.fill, this.layer);
    renderer.render(this.scene, camera);
    this.over.uniforms.tColor.value = hdr;
    this.pass(this.over, this.output);
    return this.output.texture;
  }
}

const LOAD_ID = Date.now().toString(36);
const CAPTURE = new URLSearchParams(location.search).has("capture");

// The cloth worker's job done on the page, answering at once (for captures): the same messages as veil-worker.js.
class PageSim {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.sim = null;
    this.created = null;
    this.generation = 0;
  }

  // After the frame's own update is done, as a worker's answer would be.
  send(data) {
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  surface(positions, normals) {
    this.sim.writeSurface(positions, normals);
    this.send({ type: "surface", positions, normals, generation: this.generation });
  }

  async postMessage(data) {
    try {
      if (data.type === "init") {
        this.created = loadFields(data.fields).then((fields) => {
          this.sim = new VeilSim(fields, data.offset);
          this.surface(new Float32Array(SURFACE_SIDE * SURFACE_SIDE * 3), new Float32Array(SURFACE_SIDE * SURFACE_SIDE * 3));
        });
        return;
      }
      if (!this.sim) await this.created;
      const sim = this.sim;
      if (data.type === "update") {
        sim.draft = data.draft;
        sim.loose = data.loose;
        sim.wind = data.wind;
        sim.update(data.dt, data.gravity, data.jawMatrix, data.jawInverse, data.delta);
        this.surface(data.positions, data.normals);
      } else if (data.type === "tatter" || data.type === "reset") {
        this.generation = data.generation;
        sim.dropTilt = [(nativeRandom() - 0.5) * 0.3, (nativeRandom() - 0.5) * 0.3];
        if (data.type === "tatter") sim.setTattered(data.tattered, data.seed, data.live);
        else sim.reset(data.live);
      } else if (data.type === "release") {
        sim.release();
      }
    } catch (e) {
      this.send({ type: "error", message: e.message });
    }
  }
}

class Veil {
  // `fieldsUrl`: the skull's distance fields; `offset`: how far off the surface the cloth rides, in metres.
  constructor(fieldsUrl, { offset, ember, composite, fields }) {
    this.draft = 5;
    this.loose = 0;
    // A gust, as an acceleration in the skull's space (m/s²).
    this.wind = [0, 0, 0];
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
    this.jawWeight = new Float32Array(this.surface.length / 3);
    this.jawIndex = new Int32Array(this.surface.length / 3);
    this.jawCount = 0;
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
    this.maps = new Map();

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
    // A fresh url each load: a worker's imports can come from the HTTP cache even after a hard reload.
    // Captures render slower than real time, so there the cloth is simulated on the page, a step with each frame;
    // otherwise in its worker.
    this.worker = CAPTURE ? new PageSim() : new Worker(new URL(`./veil-worker.js?v=${LOAD_ID}`, import.meta.url), { type: "module" });
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

  // Tears the veil to tatters (each seed differently), or makes it whole, and drops it (live: from above, as it's seen).
  setTattered(tattered, seed, live = false) {
    if (tattered === this.tattered && (!tattered || seed === this.tatterSeed)) return this.drop(live);
    this.tattered = tattered;
    this.tatterSeed = seed;
    const cells = tattered ? tatteredCells(seed) : null;
    this.setIndex(cells);
    if (this.tatterTextures) {
      this.tatterTextures.outline.dispose();
      this.tatterTextures.dirt.dispose();
    }
    // The maps come from their own worker (made ahead by prepareMaps when possible).
    this.tatterTextures = null;
    this.cloth.outlineMap.value = this.cloth.dirtMap.value = null;
    this.cloth.tattered.value = 0;
    if (tattered) this.prepareMaps(seed).then((maps) => {
      if (this.tattered && this.tatterSeed === seed) this.setTatterMaps(maps);
    });
    this.worker.postMessage({ type: "tatter", tattered, seed, live, generation: ++this.generation });
  }

  // Drops the veil again (live: from above, as it's seen).
  drop(live = false) {
    this.worker.postMessage({ type: "reset", live, generation: ++this.generation });
  }

  // Lets go of the head, for the page to blow the veil away.
  release() {
    this.worker.postMessage({ type: "release" });
  }

  // True once the surface of the last drop has come back (and, tattered, its maps).
  get settled() {
    return this.shownGeneration === this.generation && (!this.tattered || !!this.tatterTextures);
  }

  // Starts making the maps of a tattered cut, so they're ready by the time it's dropped. Each seed's are kept.
  prepareMaps(seed) {
    if (!this.maps.has(seed)) {
      this.maps.set(seed, new Promise((resolve) => {
        const worker = new Worker(new URL(`./tatter-worker.js?v=${LOAD_ID}`, import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => {
          worker.terminate();
          resolve(data);
        };
        worker.postMessage({ seed });
      }));
    }
    return this.maps.get(seed);
  }

  receive(data) {
    if (data.type === "error") {
      this.error = data.message;
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
    this.weighJaw();
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

  setLook({ color, opacity, diffusion, fade }) {
    this.cloth.veilDiffusion.value = diffusion;
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
    // On the page each frame's surface is this frame's: nothing to draw between.
    const t = CAPTURE ? 1 : Math.min(1, Math.max(0, (performance.now() - this.arrival) / this.interval));
    const { prevSurface, surface, prevNormals, normals, display } = this;
    const normal = this.geometry.getAttribute("normal");
    const n = normal.array;
    for (let i = 0; i < display.length; i++) {
      display[i] = prevSurface[i] + (surface[i] - prevSurface[i]) * t;
      n[i] = prevNormals[i] + (normals[i] - prevNormals[i]) * t;
    }
    normal.needsUpdate = true;
  }

  // How much of each sample goes with the jaw, from how close the latest surface is to it: worked out once per surface,
  // so a frame only moves the few samples near the jaw.
  weighJaw() {
    const field = this.jawField;
    if (!field) return;
    const { surface, gradient, jawWeight } = this;
    const a = this.surfaceJawInverse.elements;
    let count = 0;
    for (let k = 0, o = 0; o < surface.length; k++, o += 3) {
      const x = surface[o];
      const y = surface[o + 1];
      const z = surface[o + 2];
      const d = field.sample(
        a[0] * x + a[4] * y + a[8] * z + a[12],
        a[1] * x + a[5] * y + a[9] * z + a[13],
        a[2] * x + a[6] * y + a[10] * z + a[14],
        gradient,
      );
      if (d >= JAW_REACH) continue;
      const t = Math.min(1, Math.max(0, (JAW_REACH - d) / (JAW_REACH - JAW_CONTACT)));
      jawWeight[count] = t * t * (3 - 2 * t);
      this.jawIndex[count++] = o;
    }
    this.jawCount = count;
  }

  followJaw(jawMatrix) {
    if (!this.ready) return;
    this.present();
    const { display } = this;
    const position = this.geometry.getAttribute("position");
    const out = position.array;
    out.set(display);
    const a = this.surfaceJawInverse.elements;
    const b = jawMatrix.elements;
    for (let k = 0; k < this.jawCount; k++) {
      const o = this.jawIndex[k];
      const w = this.jawWeight[k];
      const x = display[o];
      const y = display[o + 1];
      const z = display[o + 2];
      const qx = a[0] * x + a[4] * y + a[8] * z + a[12];
      const qy = a[1] * x + a[5] * y + a[9] * z + a[13];
      const qz = a[2] * x + a[6] * y + a[10] * z + a[14];
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
        wind: this.wind,
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
