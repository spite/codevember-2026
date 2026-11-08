import { BufferGeometry, BufferAttribute, Mesh, ShaderMaterial, Color, Vector2, AdditiveBlending } from "three";

// Line segments drawn as screen-space quads of a fixed width in pixels, with soft edges, since WebGL lines are 1px.
const vertexShader = /* glsl */ `
attribute vec3 pA;
attribute vec3 pB;
attribute vec2 corner;
uniform vec2 resolution;
uniform float width;
varying float vSide;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(pA, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(pB, 1.0);
  vec2 sa = a.xy / a.w * resolution, sb = b.xy / b.w * resolution;
  vec2 d = sb - sa;
  d = dot(d, d) > 1e-8 ? normalize(d) : vec2(1.0, 0.0);
  vec4 p = mix(a, b, corner.x);
  p.xy += vec2(-d.y, d.x) * corner.y * (width + 1.0) / resolution * p.w;
  // Pulled a little toward the camera, so a line drawn on a surface isn't hidden by it.
  p.z -= 0.002 * p.w;
  vSide = corner.y * (width + 1.0) / width;
  gl_Position = p;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float soft;
varying float vSide;
void main() {
  // A crisp core, or (soft) a halo that falls off smoothly from the middle.
  float a = abs(vSide);
  float edge = soft > 0.5 ? (1.0 - a) * (1.0 - a) : 1.0 - smoothstep(1.0 - fwidth(vSide) * 1.5, 1.0, a);
  gl_FragColor = vec4(color, opacity * edge);
}
`;

// soft: an additive halo around the lines rather than the lines themselves.
function createSketchLines({ color, opacity, width, depthTest, soft = false }) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { color: { value: color.isColor ? color : new Color(color) }, opacity: { value: opacity }, width: { value: width }, soft: { value: soft ? 1 : 0 }, resolution: { value: new Vector2(1, 1) } },
    transparent: true,
    ...(soft && { blending: AdditiveBlending }),
    depthTest,
    depthWrite: false,
  });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.frustumCulled = false;
  mesh.userData.noShadow = true;
  return mesh;
}

// Segments as pairs of points (a, b, a, b, ...) into the quads.
function setSegments(mesh, P) {
  const n = P.length / 6;
  const A = new Float32Array(n * 12), B = new Float32Array(n * 12), C = new Float32Array(n * 8);
  const index = new Uint32Array(n * 6);
  const corners = [0, -1, 0, 1, 1, -1, 1, 1];
  for (let s = 0; s < n; s++) {
    for (let k = 0; k < 4; k++) {
      A.set(P.subarray(s * 6, s * 6 + 3), (s * 4 + k) * 3);
      B.set(P.subarray(s * 6 + 3, s * 6 + 6), (s * 4 + k) * 3);
      C[(s * 4 + k) * 2] = corners[k * 2];
      C[(s * 4 + k) * 2 + 1] = corners[k * 2 + 1];
    }
    const v = s * 4;
    index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(A, 3));
  g.setAttribute("pA", new BufferAttribute(A, 3));
  g.setAttribute("pB", new BufferAttribute(B, 3));
  g.setAttribute("corner", new BufferAttribute(C, 2));
  g.setIndex(new BufferAttribute(index, 1));
  mesh.geometry.dispose();
  mesh.geometry = g;
}

export { createSketchLines, setSegments };
