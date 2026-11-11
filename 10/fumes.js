// The acid's fumes: soft curling wisps rising off the piece while it bites, in world space (they don't turn with the
// piece), alpha-blended so they show on light and dark backdrops; drawn in the main pass only (a plain ShaderMaterial,
// so the pipeline's prepass and shadows skip them).
import { nativeRandom } from "modules/random.js";
import { InstancedBufferGeometry, InstancedBufferAttribute, PlaneGeometry, Mesh, ShaderMaterial, Color, Vector3, NormalBlending } from "three";

const COUNT = 90;

const vertexShader = /* glsl */ `
in vec4 seed;
uniform float time;
uniform float strength;
uniform float radius;
uniform vec3 center;
out vec2 vUv;
out float vAlpha;
out vec4 vSeed;
out float vLife;
void main() {
  float life = fract(time * (0.11 + 0.07 * seed.w) + seed.x);
  // Off a point on the upper part of the piece, rising and curling as it spreads.
  float az = seed.y * 6.2832;
  float el = mix(-0.2, 1.0, seed.z);
  vec3 dir = vec3(cos(az) * sqrt(1.0 - el * el), el, sin(az) * sqrt(1.0 - el * el));
  vec3 p = center + dir * radius * 0.95;
  float rise = life * radius * (0.9 + 0.5 * seed.w);
  p.y += rise;
  p.xz += dir.xz * rise * 0.35;
  p.x += radius * 0.18 * life * sin(time * 0.7 + seed.w * 9.0 + life * 4.0);
  p.z += radius * 0.18 * life * cos(time * 0.5 + seed.y * 7.0 + life * 3.0);
  float size = radius * (0.12 + 0.55 * life) * (0.7 + 0.6 * seed.w);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float ang = 0.5 * sin(seed.y * 9.0 + time * 0.3 + life * 2.0);
  float c = cos(ang), s = sin(ang);
  // Taller than wide while young: a wisp, widening into haze.
  mv.xy += mat2(c, s, -s, c) * position.xy * vec2(1.0, mix(2.2, 1.2, life)) * size;
  gl_Position = projectionMatrix * mv;
  vAlpha = strength * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.35, 1.0, life)) * (el > 0.0 ? 1.0 : 0.5);
  vUv = uv;
  vSeed = seed;
  vLife = life;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform vec3 color;
in vec2 vUv;
in float vAlpha;
in vec4 vSeed;
in float vLife;
uniform float time;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  // Curling wisps: noise scrolling up through the sprite, warped sideways by more noise.
  vec2 w = vec2(vUv.x * 2.2, vUv.y * 1.6 - time * 0.35 - vLife * 1.5) + vSeed.xy * 17.0;
  w.x += 0.9 * (noise(w * 1.3 + 7.0) - 0.5);
  float n = 0.6 * noise(w * 1.8) + 0.4 * noise(w * 4.1 + 3.0);
  float a = exp(-2.6 * dot(q * vec2(1.4, 1.0), q * vec2(1.4, 1.0))) * smoothstep(0.3, 0.8, n);
  fragColor = vec4(color, a * vAlpha);
}
`;

export function createFumes() {
  const plane = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  const seeds = new Float32Array(COUNT * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = nativeRandom();
  geometry.setAttribute("seed", new InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = COUNT;
  const material = new ShaderMaterial({
    glslVersion: "300 es",
    vertexShader,
    fragmentShader,
    uniforms: { time: { value: 0 }, strength: { value: 0 }, radius: { value: 1 }, center: { value: new Vector3() }, color: { value: new Color() } },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.userData.noShadow = true;
  mesh.userData.noWireframe = true;
  mesh.visible = false;
  mesh.renderOrder = 10;
  const _c = new Color();
  return {
    mesh,
    // strength 0..1; warm: how coppery the metal is (nitric acid on copper gives off brown fumes, others pale ones).
    update(time, strength, center, radius, warm) {
      mesh.visible = strength > 0.001;
      const u = material.uniforms;
      u.time.value = time;
      u.strength.value = 0.55 * strength;
      u.center.value.copy(center);
      u.radius.value = radius;
      u.color.value.setRGB(0.82, 0.8, 0.76).lerp(_c.setRGB(0.55, 0.3, 0.12), warm);
    },
  };
}
