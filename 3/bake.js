import { BufferGeometry, BufferAttribute, Points, Scene, OrthographicCamera, RawShaderMaterial, WebGLRenderTarget, FloatType, RGBAFormat, NearestFilter, GLSL3, Vector2 } from "three";
import { fieldGLSL } from "./materials.js";

// Rows of this many vertices in the bake targets.
const WIDTH = 1024;

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec3 position;
in vec3 normal;
in float fade;
in float clearance;
uniform vec2 bakeSize;
uniform float bakeShutter;
${fieldGLSL}
flat out vec4 vPose0;
flat out vec4 vNormal0;
flat out vec4 vPose1;
flat out vec4 vPose2;
void main() {
  vec3 n = normal;
  float h;
  vPose0 = vec4(bodySurface(position, n, 0, fade, clearance, h), h);
  vNormal0 = vec4(n, 0.0);
  n = normal;
  vPose1 = vec4(bodySurface(position, n, 1, fade, clearance, h), 0.0);
  vPose2 = vPose1;
  if (bakeShutter > 0.5) {
    n = normal;
    vPose2 = vec4(bodySurface(position, n, 2, fade, clearance, h), 0.0);
  }
  vec2 t = vec2(float(gl_VertexID % ${WIDTH}), float(gl_VertexID / ${WIDTH})) + 0.5;
  gl_Position = vec4(t / bakeSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
flat in vec4 vPose0;
flat in vec4 vNormal0;
flat in vec4 vPose1;
flat in vec4 vPose2;
layout(location = 0) out vec4 outPose0;
layout(location = 1) out vec4 outNormal0;
layout(location = 2) out vec4 outPose1;
layout(location = 3) out vec4 outPose2;
void main() {
  outPose0 = vPose0;
  outNormal0 = vNormal0;
  outPose1 = vPose1;
  outPose2 = vPose2;
}
`;

// GLSL for the body's displace(): reads this frame's baked offset, normal and height for the vertex instead of
// evaluating the melt field again in every pass.
export const bakeGLSL = /* glsl */ `
uniform highp sampler2D bakePose0;
uniform highp sampler2D bakeNormal0;
uniform highp sampler2D bakePose1;
uniform highp sampler2D bakePose2;
ivec2 bakeTexel() { return ivec2(gl_VertexID % ${WIDTH}, gl_VertexID / ${WIDTH}); }
`;

// The body's displaced surface for poses 0 (offset, height, normal), 1 and 2 (offsets), evaluated once per vertex per
// frame by drawing the vertices as points, one texel each.
export function createBodyBake(field, pools) {
  const target = new WebGLRenderTarget(WIDTH, 1, {
    count: 4,
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const uniforms = {
    bakePose0: { value: target.textures[0] },
    bakeNormal0: { value: target.textures[1] },
    bakePose1: { value: target.textures[2] },
    bakePose2: { value: target.textures[3] },
  };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    defines: { ...field.defines, ...pools.defines },
    uniforms: { ...field.uniforms, ...pools.uniforms, bakeSize: { value: new Vector2(WIDTH, 1) }, bakeShutter: { value: 1 } },
    depthTest: false,
    depthWrite: false,
  });
  const points = new Points(new BufferGeometry(), material);
  for (const name of ["position", "normal"]) points.geometry.setAttribute(name, new BufferAttribute(new Float32Array(0), 3));
  points.frustumCulled = false;
  const scene = new Scene();
  scene.add(points);
  const camera = new OrthographicCamera();
  let source = null;
  const wrappers = new WeakMap();

  // Shares the body geometry's attributes, unindexed, so each vertex is drawn once. Never disposed: that would free
  // the body's own GL buffers.
  function setGeometry(geometry) {
    if (geometry === source) return;
    source = geometry;
    let g = wrappers.get(geometry);
    if (!g) {
      g = new BufferGeometry();
      for (const name of ["position", "normal", "fade", "clearance"]) if (geometry.attributes[name]) g.setAttribute(name, geometry.attributes[name]);
      wrappers.set(geometry, g);
    }
    points.geometry = g;
    const n = geometry.attributes.position?.count ?? 0;
    const rows = Math.max(1, Math.ceil(n / WIDTH));
    target.setSize(WIDTH, rows);
    material.uniforms.bakeSize.value.set(WIDTH, rows);
  }

  function render(renderer, geometry, shutter) {
    setGeometry(geometry);
    if (!points.geometry.attributes.position) return;
    material.uniforms.bakeShutter.value = shutter ? 1 : 0;
    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = autoClear;
  }

  return { glsl: bakeGLSL, uniforms, render, compileAsync: (renderer) => renderer.compileAsync(scene, camera), target };
}
