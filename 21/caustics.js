// The light the glass throws on the plinth and the floor. A grid of rays leaves the key light, each one is traced
// through the object's distance field (refracted in, across, reflected back in where it can't leave, refracted out)
// and lands on a horizontal plane, where it is added to a map of that plane as a small splat: where the glass gathers
// the rays the map is bright, where it spreads them it is dim. One map per plane (the plinth's top, the floor), blurred
// a little: the rays are jittered so they don't land as rings, and a jittered few hundred thousand are grainy.
// On its way through a struck object a ray is walked along the figure's own distance field, and loses light at every
// channel it crosses, so the figure throws its shadow into the pattern, branch by branch.
import {
  WebGLRenderTarget, RawShaderMaterial, GLSL3, Points, Mesh, Scene, OrthographicCamera, BufferGeometry, BufferAttribute, HalfFloatType, LinearFilter,
  NoColorSpace, Vector2, Vector4, AdditiveBlending, Color,
} from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { nativeRandom } from "modules/random.js";
import { EXTENT, CELL, sdfGLSL } from "./shapes.js";
import { BAND } from "./band.js";

// The rays cover a square this far either side of the object's centre, in its own units: every shape fits.
const REACH = 1.25;
// Each map covers a square this far either side of where the ray through the object's centre lands, in world units.
const HALF = 2.6;

const vertex = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec3 position;
uniform sampler3D tFigure;
uniform mat3 objectRotation;
uniform vec3 objectCenter;
uniform float objectScale;
uniform vec3 lightDirection;
uniform float ior;
uniform float figure;
uniform float figureVoxel;
uniform float planeY;
uniform vec4 blocker;
uniform vec2 mapCentre;
uniform float flux;
out float vLight;

const float INV = ${(0.5 / EXTENT).toFixed(6)};
const float CELL = ${CELL.toFixed(6)};
const float BOX = ${(EXTENT - CELL).toFixed(4)};

${sdfGLSL}
float transmitted(float cosine, float f0) {
  return 1.0 - (f0 + (1.0 - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0));
}

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 5.0;
  vLight = 0.0;
  vec3 L = normalize(lightDirection);
  vec3 toLight = L * objectRotation;
  vec3 up = abs(toLight.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(up, toLight)), v = cross(toLight, u);
  vec3 ro = (u * position.x + v * position.y) * ${REACH.toFixed(2)} + toLight * 2.5;
  vec3 rd = -toLight;

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 48; i++) {
    float d = sdf(ro + rd * t);
    if (d < 0.002) {
      hit = true;
      break;
    }
    t += d;
    if (t > 5.0) break;
  }
  if (!hit) return;
  vec3 p = ro + rd * t;
  vec3 n = sdfNormal(p);
  float f0 = (ior - 1.0) / (ior + 1.0);
  f0 *= f0;
  float light = transmitted(-dot(rd, n), f0);
  vec3 dir = refract(rd, n, 1.0 / ior);

  // Across the glass to the far side, and out. Where the light meets the far side too obliquely to leave, all of
  // it is reflected back in and crosses again: up to twice, after which the little that is still inside is let go.
  vec3 a = p - n * 0.006, e, m, leaving = vec3(0.0);
  for (int bounce = 0; bounce < 3; bounce++) {
    float s = 0.0;
    for (int i = 0; i < 64; i++) {
      float d = sdf(a + dir * s);
      if (d > -0.0015) break;
      s += max(-d, 0.004);
    }
    // The channels it crosses on the way each stop most of what reaches them (they scatter it, to nowhere in
    // particular). The figure's field says how far the nearest is, in voxels, so the walk strides over clear glass.
    if (figure > 0.0) {
      float t = 0.0;
      for (int i = 0; i < 110; i++) {
        if (t >= s) break;
        float c = (0.5 - textureLod(tFigure, (a + dir * t) * INV + 0.5, 0.0).r) * ${(2 * BAND).toFixed(1)};
        float stride = clamp(c, 0.8, ${BAND.toFixed(1)});
        light *= 1.0 - 0.5 * smoothstep(0.8, -0.2, c);
        t += stride * figureVoxel;
      }
    }
    e = a + dir * s;
    m = sdfNormal(e);
    leaving = refract(dir, -m, ior);
    if (dot(leaving, leaving) > 0.0) break;
    dir = reflect(dir, -m);
    a = e - m * 0.006;
  }
  if (dot(leaving, leaving) == 0.0) return;
  light *= transmitted(dot(leaving, m), f0);

  vec3 world = objectCenter + objectRotation * e * objectScale;
  vec3 worldDir = objectRotation * leaving;
  if (worldDir.y > -0.02) return;
  vec3 landing = world + worldDir * (planeY - world.y) / worldDir.y;
  // On its way to a lower plane, the plinth's top may be in the way.
  if (blocker.w > 0.0 && planeY < blocker.y) {
    vec3 onTop = world + worldDir * (blocker.y - world.y) / worldDir.y;
    if (max(abs(onTop.x - blocker.x), abs(onTop.z - blocker.z)) < blocker.w) return;
  }
  vLight = light * flux;
  gl_Position = vec4((landing.xz - mapCentre) / ${HALF.toFixed(2)}, 0.0, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;
in float vLight;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  outColor = vec4(vec3(vLight * exp(-4.0 * dot(d, d))), 1.0);
}
`;

// One way of a Gaussian blur, nine texels wide in five taps.
const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 direction;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 sum = textureLod(tInput, vUv, 0.0) * 0.227027;
  sum += (textureLod(tInput, vUv + direction * 1.384615, 0.0) + textureLod(tInput, vUv - direction * 1.384615, 0.0)) * 0.316216;
  sum += (textureLod(tInput, vUv + direction * 3.230769, 0.0) + textureLod(tInput, vUv - direction * 3.230769, 0.0)) * 0.070270;
  outColor = sum;
}
`;

// What a 5-pixel splat's weights add up to over the texels it covers: the integral of exp(-4 r²) over its disc.
const SPLAT = 4.9;

class Caustics {
  // rays: per side of the grid; size: of each map, in texels; planes: the heights (world y) of the receivers.
  // blocker: a square slab that stops the light on its way to the planes below it, { x, y, z, half } (y its top).
  constructor(glass, { rays = 384, size = 512, planes, blocker }) {
    const positions = new Float32Array(rays * rays * 3);
    for (let j = 0, o = 0; j < rays; j++)
      for (let i = 0; i < rays; i++) {
        // Jittered in its cell: a regular grid of rays lands as rings and moire.
        positions[o++] = ((i + nativeRandom()) / rays) * 2 - 1;
        positions[o++] = ((j + nativeRandom()) / rays) * 2 - 1;
        o++;
      }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const g = glass.uniforms;
    this.glass = glass;
    this.rays = rays;
    this.size = size;
    this.uniforms = {
      tSdf: g.tSdf, shapeId: g.shapeId, shapeEdge: g.shapeEdge, shapeInflate: g.shapeInflate, tFigure: g.tFigure, objectRotation: g.objectRotation, objectCenter: g.objectCenter, objectScale: g.objectScale,
      lightDirection: globalUniforms.lightDirection, ior: g.ior, figure: g.figure, figureVoxel: g.figureVoxel,
      planeY: { value: 0 }, blocker: { value: new Vector4() }, mapCentre: { value: new Vector2() }, flux: { value: 1 },
    };
    const points = new Points(geometry, new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms,
      blending: AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    }));
    points.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(points);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // Each receiver: its map, and where the map lies (xy: the centre's x and z, z: 1 / its width).
    const map = () => new WebGLRenderTarget(size, size, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });
    this.receivers = planes.map((y) => ({ y, raw: map(), target: map(), rect: new Vector4(0, 0, 1 / (2 * HALF), 0) }));
    this.scratch = map();
    this.blur = { tInput: { value: null }, direction: { value: new Vector2() } };
    const quad = new BufferGeometry();
    quad.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const blurMesh = new Mesh(quad, new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: blurFragment, uniforms: this.blur, depthTest: false, depthWrite: false }));
    blurMesh.frustumCulled = false;
    this.blurScene = new Scene();
    this.blurScene.add(blurMesh);
    if (blocker) this.uniforms.blocker.value.set(blocker.x, blocker.y, blocker.z, blocker.half);
    this.key = "";
    this._clear = new Color();
  }

  compile(renderer) {
    return Promise.all([renderer.compileAsync(this.scene, this.camera), renderer.compileAsync(this.blurScene, this.camera)]);
  }

  // key: anything that changes when the pattern would (the pose, the shape, the figure, the refraction).
  render(renderer, key) {
    if (key === this.key) return;
    this.key = key;
    const u = this.uniforms, g = this.glass.uniforms;
    u.tFigure.value = g.tFigure.value;
    const L = globalUniforms.lightDirection.value;
    const length = L.length();
    const centre = g.objectCenter.value, scale = g.objectScale.value;
    // A ray stands for this much of the beam's cross-section; a texel of the map is this big.
    const ray = ((2 * REACH * scale) / this.rays) ** 2, texel = ((2 * HALF) / this.size) ** 2;
    u.flux.value = ray / texel / SPLAT;
    const prev = renderer.getRenderTarget();
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clear);
    renderer.setClearColor(0x000000, 1);
    for (const r of this.receivers) {
      const down = ((centre.y - r.y) * length) / L.y;
      r.rect.x = centre.x - (L.x / length) * down;
      r.rect.y = centre.z - (L.z / length) * down;
      u.planeY.value = r.y;
      u.mapCentre.value.set(r.rect.x, r.rect.y);
      renderer.setRenderTarget(r.raw);
      renderer.clear(true, false, false);
      renderer.render(this.scene, this.camera);
      // Blurred, across then down, into the map the surfaces read.
      for (const [from, to, x, y] of [[r.raw, this.scratch, 1, 0], [this.scratch, r.target, 0, 1]]) {
        this.blur.tInput.value = from.texture;
        this.blur.direction.value.set(x / this.size, y / this.size);
        renderer.setRenderTarget(to);
        renderer.render(this.blurScene, this.camera);
      }
    }
    renderer.setClearColor(this._clear, alpha);
    renderer.setRenderTarget(prev);
  }
}

export { Caustics };
