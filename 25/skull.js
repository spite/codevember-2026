// The skulls: glTF heads with a two-bone skin (cranium and jaw), drawn with one PipelineMaterial each. The jaw is
// swung in displace() from its skin weights, so it reaches shadows, AO and velocity. Embers glow in the sockets and
// light the bone around them (see emberGLSL).
import { Group, Mesh, SphereGeometry, Vector3, Matrix4, Color, BufferAttribute } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const SKULLS = {
  evil: { label: "Evil", model: "./assets/skull-evil.glb", fields: "./assets/skull-evil.sdf.bin", roughness: 0.62 },
  realistic: { label: "Realistic", model: "./assets/skull.glb", fields: "./assets/skull.sdf.bin", roughness: 0.6 },
  // Suzanne's sockets are bigger, and so are her embers; her brow and ears are sharp, so the cloth rides further off.
  suzanne: { label: "Suzanne", model: "./assets/suzanne.glb", fields: "./assets/suzanne.sdf.bin", roughness: 0.7, eyeScale: 1.8, veilOffset: 0.008 },
};

// Centre of the left eye socket, in the skull's space (metres), and the ember's half-sizes there.
const EYE = new Vector3(0.032, 0.115, 0.054);
const EMBER_SIZE = new Vector3(0.0055, 0.003, 0.003);
const EMBER_SLANT = 0.3;
// The sockets open forward, a little outward and down; light escapes through a mouth this far in front of the ember.
const SOCKET_AXIS = new Vector3(0.25, -0.12, 1).normalize();
const SOCKET_MOUTH = 0.016;
const SOCKET_RADIUS = 0.02;

// Light of the two embers, for any surface near the skull: inside a socket it lights the walls from the ember itself,
// outside it leaves through the socket's mouth as a forward-facing disc (so only what's in front of a socket is lit).
// World space; emberPos/emberMouth/emberAxis are set per frame, emberRadiance is the colour times the glow.
const emberGLSL = /* glsl */ `
uniform vec3 emberPos[2];
uniform vec3 emberMouth[2];
uniform vec3 emberAxis[2];
uniform vec3 emberRadiance;
uniform float socketRadius;
// Irradiance from both embers at P with normal n; twoSided for a thin sheet lit from either side.
vec3 emberIrradiance(vec3 P, vec3 n, bool twoSided) {
  vec3 E = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec3 L = emberPos[i] - P;
    float d2 = dot(L, L);
    vec3 l = L * inversesqrt(d2);
    float inside = 1.0 - smoothstep(0.7 * socketRadius, 1.3 * socketRadius, sqrt(d2));
    float nl = twoSided ? abs(dot(n, l)) : max(dot(n, l), 0.0);
    E += inside * nl / (d2 + 0.25 * socketRadius * socketRadius);
    vec3 M = emberMouth[i] - P;
    float m2 = dot(M, M);
    vec3 m = M * inversesqrt(m2);
    float facing = max(dot(emberAxis[i], -m), 0.0);
    float nm = twoSided ? abs(dot(n, m)) : max(dot(n, m), 0.0);
    E += (1.0 - inside) * facing * nm / (m2 + 0.5 * socketRadius * socketRadius) * 0.5;
  }
  return E * emberRadiance;
}
`;

function emberUniforms() {
  return {
    emberPos: { value: [new Vector3(), new Vector3()] },
    emberMouth: { value: [new Vector3(), new Vector3()] },
    emberAxis: { value: [new Vector3(0, 0, 1), new Vector3(0, 0, 1)] },
    emberRadiance: { value: new Color(0, 0, 0) },
    socketRadius: { value: 0.1 },
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
      jawMatrix: { value: new Matrix4() },
      ...ember,
    },
    vertexPars: /* glsl */ `
in float jawWeight;
uniform mat4 jawMatrix;
`,
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
  s.emissive += s.albedo * (1.0 / 3.14159265) * emberIrradiance(vWorldPosition, normalize(s.normal), false);
#endif
}
`,
  });
}

// The embers: flattened, slanted, hot in the middle where they face the eye, split by a vertical slit.
function createEmberMaterial() {
  return new PipelineMaterial({
    color: 0x000000,
    roughness: 1,
    uniforms: { emberGlow: { value: 0 } },
    fragmentPars: /* glsl */ `uniform float emberGlow;`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo = vec3(0.0);
  s.specular = 0.0;
  vec3 V = normalize(cameraPosition - vWorldPosition);
  float core = pow(clamp(dot(normalize(s.normal), V), 0.0, 1.0), 3.0);
  vec3 c = mix(vec3(1.0, 0.025, 0.0), vec3(1.0, 0.16, 0.03), core) * (0.2 + 0.8 * core);
  vec3 o = vObjectPosition;
  float width = 0.1 * sqrt(max(0.0, 1.0 - o.y * o.y));
  float slit = smoothstep(width, width + 0.06, abs(o.x));
  c *= mix(0.03, 1.0, max(slit, step(o.z, 0.0)));
  s.emissive = c * emberGlow;
}
`,
  });
}

const emberGeometry = new SphereGeometry(1, 32, 16);
const loader = new GLTFLoader();
const _v = new Vector3();
const _axis = new Vector3();

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
  for (const name of ["skinIndex", "skinWeight", "tangent"]) geometry.deleteAttribute(name);
  geometry.computeBoundingSphere();

  const ember = emberUniforms();
  const eyeScale = spec.eyeScale ?? 1;
  ember.socketRadius.value = SOCKET_RADIUS * eyeScale;
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
  const mesh = new Mesh(geometry, material);
  root.add(mesh);

  const emberMaterial = createEmberMaterial();
  const embers = [];
  for (const side of [-1, 1]) {
    const ball = new Mesh(emberGeometry, emberMaterial);
    ball.position.set(side * EYE.x, EYE.y, EYE.z);
    ball.scale.copy(EMBER_SIZE).multiplyScalar(eyeScale);
    ball.rotation.z = side * EMBER_SLANT;
    ball.userData.noShadow = true;
    ball.visible = false;
    embers.push(ball);
    root.add(ball);
  }

  const skull = {
    name,
    spec,
    root,
    mesh,
    material,
    ember,
    embers,
    emberMaterial,
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
function setEmbers(skull, glow, seconds, intensity) {
  const flicker = 0.9 + 0.07 * Math.sin(seconds * 9) + 0.03 * Math.sin(seconds * 23 + 1);
  const level = glow * flicker;
  for (const ball of skull.embers) ball.visible = level > 0.005;
  skull.emberMaterial.uniforms.emberGlow.value = 14 * level;
  const world = skull.root.matrixWorld;
  const scale = _v.setFromMatrixColumn(world, 0).length();
  const u = skull.ember;
  u.socketRadius.value = SOCKET_RADIUS * skull.eyeScale * scale;
  [-1, 1].forEach((side, i) => {
    const eye = _v.set(side * EYE.x, EYE.y, EYE.z);
    u.emberPos.value[i].copy(eye).applyMatrix4(world);
    _axis.set(side * SOCKET_AXIS.x, SOCKET_AXIS.y, SOCKET_AXIS.z);
    u.emberMouth.value[i].copy(eye).addScaledVector(_axis, SOCKET_MOUTH * skull.eyeScale).applyMatrix4(world);
    u.emberAxis.value[i].copy(_axis).transformDirection(world);
  });
  // Radiant power scales with the ember's area, so the irradiance it gives in world units does too.
  const area = (skull.eyeScale * scale) ** 2;
  u.emberRadiance.value.setRGB(1, 0.06, 0.012).multiplyScalar(level * intensity * area * 0.0016);
}

export { SKULLS, loadSkull, poseJaw, setEmbers, emberGLSL, emberUniforms };
