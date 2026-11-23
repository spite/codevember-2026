// Fisheye: the camera renders a wider perspective view, and this pass remaps it toward an equidistant
// fisheye with the same corners, so the centre stays close to normal and the edges bow outward.
// strength blends from plain perspective (0) to full fisheye (1).

import { Scene, Mesh, PlaneGeometry, OrthographicCamera, ShaderMaterial, GLSL3, WebGLRenderTarget, HalfFloatType, LinearFilter, NoColorSpace } from "three";

const vertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform float uAspect;
  uniform float uTan;
  uniform float uStrength;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
    float r = length(p);
    float corner = length(vec2(uAspect, 1.0));
    float theta = atan(corner * uTan) / corner;
    float ang = mix(atan(r * uTan), r * theta, uStrength);
    vec2 q = r > 1e-5 ? p / r * tan(ang) / uTan : p;
    outColor = texture(tScene, q / vec2(uAspect, 1.0) * 0.5 + 0.5);
  }
`;

export function createLens() {
  const uniforms = { tScene: { value: null }, uAspect: { value: 1 }, uTan: { value: 1 }, uStrength: { value: 0.7 } };
  const material = new ShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });

  function render(renderer, hdr, { camera, width, height }) {
    if (uniforms.uStrength.value <= 0.001) return hdr;
    if (target.width !== width || target.height !== height) target.setSize(width, height);
    uniforms.tScene.value = hdr;
    uniforms.uAspect.value = width / height;
    uniforms.uTan.value = Math.tan((camera.fov * Math.PI) / 360);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, ortho);
    renderer.setRenderTarget(prev);
    return target.texture;
  }

  return { uniforms, render };
}
