// The skulls: glTF heads with a two-bone skin (cranium and jaw), drawn with one PipelineMaterial each. The jaw is
// swung in displace() from its skin weights, so it reaches shadows, AO and velocity. When the eyes light up, an unseen
// red light deep in each socket lights the bone around it (see emberGLSL).
import { Group, Mesh, Vector3, Matrix4, Color, BufferAttribute } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const SKULLS = {
  evil: { label: "Evil", model: "./assets/skull-evil.glb", fields: "./assets/skull-evil.sdf.bin", roughness: 0.62 },
  realistic: { label: "Realistic", model: "./assets/skull.glb", fields: "./assets/skull.sdf.bin", roughness: 0.6 },
  // Suzanne has eyes, which glow themselves, and no nasal cavity; her brow and ears are sharp, so the cloth rides further off.
  suzanne: { label: "Suzanne", model: "./assets/suzanne.glb", fields: "./assets/suzanne.sdf.bin", roughness: 0.7, eyeScale: 1.8, veilOffset: 0.008, nose: false, eyeballs: true, throughBone: 0.04 },
};

// Where the light sits in the left eye socket, in the skull's space (metres).
const EYE = new Vector3(0.032, 0.115, 0.054);
// The sockets open forward, a little outward and down; light escapes through a mouth this far in front of it.
const SOCKET_AXIS = new Vector3(0.25, -0.12, 1).normalize();
const SOCKET_MOUTH = 0.016;
const SOCKET_RADIUS = 0.02;
// In each half of the nasal cavity (either side of the septum), behind the nose's opening, which faces forward and a
// little down.
const NOSE = new Vector3(0.006, 0.085, 0.076);
const NOSE_AXIS = new Vector3(0, -0.3, 1).normalize();
const NOSE_MOUTH = 0.01;
const NOSE_WEIGHT = 0.3;

// The light in both sockets, and weaker ones in the nose, which the sockets open into. For any surface near the
// skull: inside a cavity it lights the walls from where it sits, outside it leaves through the cavity's mouth as a
// forward-facing disc (so only what's in front is lit). World space; set per frame. emberWeight scales each light (the
// nose's is lower, and none for a head without a nasal cavity), emberRadiance is the colour times the glow.
const EMBERS = 4;
const emberGLSL = /* glsl */ `
uniform vec3 emberPos[${EMBERS}];
uniform vec3 emberMouth[${EMBERS}];
uniform vec3 emberAxis[${EMBERS}];
uniform float emberWeight[${EMBERS}];
uniform vec3 emberRadiance;
uniform float socketRadius;
// How much glows through the head around each light (bone is a little translucent).
uniform float throughBone;
// Irradiance from the lights at P with normal n; twoSided for a thin sheet lit from either side.
vec3 emberIrradiance(vec3 P, vec3 n, bool twoSided) {
  vec3 E = vec3(0.0);
  for (int i = 0; i < ${EMBERS}; i++) {
    if (emberWeight[i] <= 0.0) continue;
    vec3 L = emberPos[i] - P;
    float d2 = dot(L, L);
    vec3 l = L * inversesqrt(d2);
    float inside = 1.0 - smoothstep(0.7 * socketRadius, 1.3 * socketRadius, sqrt(d2));
    float nl = twoSided ? abs(dot(n, l)) : max(dot(n, l), 0.0);
    vec3 M = emberMouth[i] - P;
    float m2 = dot(M, M);
    vec3 m = M * inversesqrt(m2);
    float facing = max(dot(emberAxis[i], -m), 0.0);
    float nm = twoSided ? abs(dot(n, m)) : max(dot(n, m), 0.0);
    E += emberWeight[i] * (inside * nl / (d2 + 0.25 * socketRadius * socketRadius)
      + (1.0 - inside) * facing * nm / (m2 + 0.5 * socketRadius * socketRadius) * 0.5);
  }
  return E * emberRadiance;
}
// Bone is a little translucent: light glows through it near each light, whichever way the surface faces, falling off
// over about a centimetre.
vec3 emberThroughBone(vec3 P) {
  float g = 0.0;
  for (int i = 0; i < ${EMBERS}; i++) {
    g += emberWeight[i] * exp(-length(emberPos[i] - P) / (0.55 * socketRadius));
  }
  return throughBone * g * emberRadiance / (socketRadius * socketRadius);
}
`;

function emberUniforms() {
  return {
    emberPos: { value: Array.from({ length: EMBERS }, () => new Vector3()) },
    emberMouth: { value: Array.from({ length: EMBERS }, () => new Vector3()) },
    emberAxis: { value: Array.from({ length: EMBERS }, () => new Vector3(0, 0, 1)) },
    emberWeight: { value: [1, 1, 0, 0] },
    emberRadiance: { value: new Color(0, 0, 0) },
    socketRadius: { value: 0.1 },
    throughBone: { value: 0.25 },
  };
}

function createBoneMaterial({ map, normalMap, normalScale = 1, roughness, ember }) {
  return new PipelineMaterial({
    color: 0xffffff,
    roughness,
    metalness: 0,
    uniforms: {
      boneMap: { value: map },
      boneNormal: { value: normalMap },
      normalStrength: { value: normalMap ? normalScale : 0 },
      veilBlock: { value: 0 },
      veilFilter: { value: new Color(1, 1, 1) },
      jawMatrix: { value: new Matrix4() },
      eyeGlow: { value: 0 },
      ...ember,
    },
    vertexPars: /* glsl */ `
in float jawWeight;
in float eyeball;
uniform mat4 jawMatrix;
`,
    varyings: { vEyeball: "float" },
    vertexMain: "vEyeball = eyeball;",
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  if (jawWeight <= 0.0) return p;
  vec3 q = (jawMatrix * vec4(p, 1.0)).xyz;
  n = normalize(mix(n, mat3(jawMatrix) * n, jawWeight));
  return mix(p, q, jawWeight);
}
`,
    fragmentPars: /* glsl */ `
uniform sampler2D boneMap;
uniform sampler2D boneNormal;
uniform float normalStrength;
// Eyes that are there glow themselves (eyeball = 1 on them).
uniform float eyeGlow;
// The share of the surrounding light the veil stops (0 without one).
uniform float veilBlock;
// What the light that came through the veil is multiplied by: the cloth's colour, as much as it covers.
uniform vec3 veilFilter;
${emberGLSL}
vec3 perturbNormal(vec3 N, vec3 p, vec2 uv, vec3 mapN) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  return normalize(mat3(T * invmax, B * invmax, N) * mapN);
}
`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo *= texture(boneMap, vUv).rgb;
#if !defined(PIPELINE_SHADOW) && !defined(PIPELINE_DEPTH)
  if (normalStrength > 0.0) {
    vec3 t = texture(boneNormal, vUv).xyz * 2.0 - 1.0;
    // glTF's green points up the image; the derivative frame's bitangent points down it.
    t.xy *= vec2(normalStrength, -normalStrength);
    s.normal = perturbNormal(s.normal, vWorldPosition, vUv, normalize(t));
  }
#endif
#ifdef PIPELINE_COLOR
  s.emissive += s.albedo * ((1.0 / 3.14159265) * emberIrradiance(vWorldPosition, normalize(s.normal), false) + emberThroughBone(vWorldPosition));
  s.emissive += vEyeball * eyeGlow * emberRadiance;
#endif
#if !defined(PIPELINE_SHADOW) && !defined(PIPELINE_DEPTH)
  // Under the veil the studio's soft light comes through the cloth too, cut by as much as the key is; the hem is open
  // underneath, so what faces down gets a little more.
  float down = clamp(-normalize(s.normal).y, 0.0, 1.0);
  s.occlusion *= 1.0 - veilBlock * (1.0 - 0.35 * down);
  // Light from outside came through the cloth and took its colour (the eyes' light is inside, added above).
  s.albedo *= veilFilter;
#endif
}
`,
  });
}

const loader = new GLTFLoader();
const _v = new Vector3();
const _axis = new Vector3();

// 1 on the vertices of eyeballs, for a head that has them: the asset marks them in its vertex colour.
function eyeballs(geometry) {
  const color = geometry.getAttribute("color");
  const out = new Float32Array(geometry.getAttribute("position").count);
  if (color) for (let i = 0; i < out.length; i++) out[i] = color.getX(i);
  return new BufferAttribute(out, 1);
}

// The weight of the jaw bone (joint 1) at each vertex, from the skin.
function jawWeights(geometry) {
  const index = geometry.getAttribute("skinIndex");
  const weight = geometry.getAttribute("skinWeight");
  const out = new Float32Array(index.count);
  for (let i = 0; i < index.count; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (index.getComponent(i, k) === 1) w += weight.getComponent(i, k);
    out[i] = w;
  }
  return new BufferAttribute(out, 1);
}

async function loadSkull(name, { onProgress } = {}) {
  const spec = SKULLS[name];
  const gltf = await loader.loadAsync(spec.model, (e) => e.total && onProgress?.(e.loaded / e.total));
  let source = null;
  let jawBone = null;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh) source = o;
    if (o.name === "JawBone") jawBone = o;
  });
  const geometry = source.geometry;
  geometry.setAttribute("jawWeight", jawWeights(geometry));
  geometry.setAttribute("eyeball", eyeballs(geometry));
  for (const name of ["skinIndex", "skinWeight", "tangent", "color"]) geometry.deleteAttribute(name);
  geometry.computeBoundingSphere();

  const ember = emberUniforms();
  const eyeScale = spec.eyeScale ?? 1;
  ember.socketRadius.value = SOCKET_RADIUS * eyeScale;
  ember.throughBone.value = spec.throughBone ?? 0.25;
  const std = source.material;
  const material = createBoneMaterial({
    map: std.map,
    normalMap: std.normalMap,
    normalScale: std.normalScale ? Math.abs(std.normalScale.x) : 1,
    roughness: spec.roughness,
    ember,
  });
  // The skull's own space, in metres: resting on y = 0, facing +z.
  const root = new Group();
  material.uniforms.eyeGlow.value = spec.eyeballs ? 1.5 : 0;
  const mesh = new Mesh(geometry, material);
  root.add(mesh);

  const skull = {
    name,
    spec,
    root,
    mesh,
    material,
    ember,
    jawRest: jawBone.position.clone(),
    // The jaw's pose as skull space to skull space (rest → now), and its parts.
    jawMatrix: material.uniforms.jawMatrix.value,
    jawOpen: 0,
    jawSide: 0,
    jawForward: 0,
    eyeScale,
  };
  return skull;
}

const _rot = new Matrix4();
const _t = new Matrix4();
// JAW_SLIDE: sideways, JAW_FORWARD: forward, in metres at a score of 1.
const JAW_SIDE = 0.2;
const JAW_SLIDE = 0.008;
const JAW_FORWARD = 0.006;

// Swings the jaw on its joint (open, side to side) and slides it; same matrix as the veil's jaw field uses.
function poseJaw(skull, open, side, forward) {
  const r = skull.jawRest;
  _rot.makeRotationY(side * JAW_SIDE).multiply(_t.makeRotationX(open));
  skull.jawMatrix
    .makeTranslation(r.x + side * JAW_SLIDE, r.y, r.z + forward * JAW_FORWARD)
    .multiply(_rot)
    .multiply(_t.makeTranslation(-r.x, -r.y, -r.z));
}

// Places the embers' light in the world and sets their glow (0..), with a flicker.
// The eyes' light: a colour, and a strength that makes each read about as strongly through the veil.
const EYE_LIGHTS = {
  hellfire: { label: "Hellfire", color: [1, 0.03, 0.008], strength: 1 },
  pale: { label: "Pale", color: [0.86, 0.93, 1], strength: 1.1 },
  sick: { label: "Sick", color: [0.4, 1, 0.1], strength: 0.9 },
};

function setEmbers(skull, glow, seconds, intensity, eyes = "hellfire") {
  const flicker = 0.9 + 0.07 * Math.sin(seconds * 9) + 0.03 * Math.sin(seconds * 23 + 1);
  const level = glow * flicker;
  const world = skull.root.matrixWorld;
  const scale = _v.setFromMatrixColumn(world, 0).length();
  const u = skull.ember;
  u.socketRadius.value = SOCKET_RADIUS * skull.eyeScale * scale;
  [-1, 1].forEach((side, i) => {
    // Eyeballs hold the light in: they glow themselves, and only a little spills round them.
    u.emberWeight.value[i] = skull.spec.eyeballs ? 0.12 : 1;
    const eye = _v.set(side * EYE.x, EYE.y, EYE.z);
    u.emberPos.value[i].copy(eye).applyMatrix4(world);
    _axis.set(side * SOCKET_AXIS.x, SOCKET_AXIS.y, SOCKET_AXIS.z);
    u.emberMouth.value[i].copy(eye).addScaledVector(_axis, SOCKET_MOUTH * skull.eyeScale).applyMatrix4(world);
    u.emberAxis.value[i].copy(_axis).transformDirection(world);
  });
  [-1, 1].forEach((side, k) => {
    const i = 2 + k;
    const nose = _v.set(side * NOSE.x, NOSE.y, NOSE.z);
    u.emberMouth.value[i].copy(nose).addScaledVector(NOSE_AXIS, NOSE_MOUTH).applyMatrix4(world);
    u.emberPos.value[i].copy(nose).applyMatrix4(world);
    u.emberAxis.value[i].copy(NOSE_AXIS).transformDirection(world);
    u.emberWeight.value[i] = skull.spec.nose === false ? 0 : NOSE_WEIGHT;
  });
  // Radiant power scales with the ember's area, so the irradiance it gives in world units does too.
  const area = (skull.eyeScale * scale) ** 2;
  const light = EYE_LIGHTS[eyes] ?? EYE_LIGHTS.hellfire;
  u.emberRadiance.value.setRGB(...light.color).multiplyScalar(level * intensity * light.strength * area * 0.0085);
}

export { SKULLS, EYE_LIGHTS, loadSkull, poseJaw, setEmbers, emberGLSL, emberUniforms };
