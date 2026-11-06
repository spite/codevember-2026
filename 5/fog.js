import { WebGLRenderTarget, RawShaderMaterial, GLSL3, Mesh, Scene, OrthographicCamera, BufferGeometry, BufferAttribute, HalfFloatType, LinearFilter, NoColorSpace, Color, Matrix4 } from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";

// Depth haze over the lit image: distance fades into the mist, which also pools on the floor.
const fogFragment = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform mat4 invProj;
uniform mat4 camWorld;
uniform float floorY;
uniform float groundMist;
uniform float mistHeight;
uniform float veil;
uniform float start;
uniform float density;
uniform vec3 mistLow;
uniform vec3 mistHigh;
uniform float amount;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 c = texture(tScene, vUv);
  float d = texture(tDepth, vUv).r;
  vec4 vp = invProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  float z = length(vp.xyz);
  float f = 1.0 - exp(-max(z - start, 0.0) * density);
  vec3 wp = (camWorld * vec4(vp.xyz, 1.0)).xyz;
  float ground = groundMist * exp(-max(wp.y - floorY, 0.0) / mistHeight) * (1.0 - exp(-z * 0.25));
  f = clamp(max(f + ground, veil), 0.0, 1.0) * amount;
  vec3 mist = mix(mistLow, mistHigh, smoothstep(0.1, 1.0, vUv.y));
  outColor = vec4(mix(c.rgb, mist, f), c.a);
}
`;

class FogPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, colorSpace: NoColorSpace, depthBuffer: false });
    this.uniforms = {
      tScene: { value: null },
      tDepth: { value: null },
      invProj: { value: new Matrix4() },
      camWorld: { value: new Matrix4() },
      floorY: { value: 0 },
      groundMist: { value: 0.35 },
      mistHeight: { value: 0.5 },
      veil: { value: 0.06 },
      start: { value: 4 },
      density: { value: 0.08 },
      mistLow: { value: new Color(0.5, 0.54, 0.5) },
      mistHigh: { value: new Color(0.8, 0.84, 0.8) },
      amount: { value: 1 },
    };
    this.material = new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: fogFragment, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(mesh);
    this.camera = new OrthographicCamera();
  }

  render(hdr, { depthTexture, camera, width, height }) {
    if (this.uniforms.amount.value <= 0) return hdr;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const u = this.uniforms;
    u.tScene.value = hdr;
    u.tDepth.value = depthTexture;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    return this.target.texture;
  }
}

export { FogPass };
