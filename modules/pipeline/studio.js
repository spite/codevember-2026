import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  CircleGeometry,
  SphereGeometry,
  Scene,
  SpotLight,
  HemisphereLight,
  Color,
  Vector3,
  BackSide,
  DoubleSide,
  PMREMGenerator,
  WebGLRenderTarget,
  ShaderMaterial,
  PerspectiveCamera,
  HalfFloatType,
  OrthographicCamera,
  FloatType,
  RGBAFormat,
  NearestFilter,
  GLSL3,
} from "three";
import { UltraHDRLoader } from "third_party/UltraHDRLoader.js";
import { globalUniforms } from "./uniforms.js";

// Studio layout in env units (the env is captured from the origin).
const FLOOR_Y = -2;
const CYC_START = -6; // z where the floor starts sweeping up
const CYC_RADIUS = 5;
const CYC_TOP = 22;
const CYC_HALF_WIDTH = 44;
const FLOOR_FRONT = 44;
const SURROUND_RADIUS = 46;
const SURROUND_RADIANCE = 0.035;
const WALL_ALBEDO = 0.82;
const KEY_DISTANCE = 7;

const _v = new Vector3();

// Seamless cyc: floor, quarter-circle sweep, back wall; albedo in the color attribute.
function cycGeometry(floorAlbedo, wallAlbedo) {
  const profile = []; // [z, y, floorness]
  const floorSegs = 24;
  for (let i = 0; i <= floorSegs; i++) {
    const t = i / floorSegs;
    profile.push([FLOOR_FRONT + (CYC_START - FLOOR_FRONT) * t, FLOOR_Y, 1]);
  }
  const arcSegs = 24;
  for (let i = 1; i <= arcSegs; i++) {
    const a = (i / arcSegs) * Math.PI * 0.5;
    profile.push([
      CYC_START - CYC_RADIUS * Math.sin(a),
      FLOOR_Y + CYC_RADIUS * (1 - Math.cos(a)),
      1 - i / arcSegs,
    ]);
  }
  const wallZ = CYC_START - CYC_RADIUS;
  const wallBottom = FLOOR_Y + CYC_RADIUS;
  const wallSegs = 12;
  for (let i = 1; i <= wallSegs; i++) {
    profile.push([wallZ, wallBottom + ((CYC_TOP - wallBottom) * i) / wallSegs, 0]);
  }

  const xSegs = 16;
  const positions = [];
  const colors = [];
  const index = [];
  for (let j = 0; j <= xSegs; j++) {
    const x = -CYC_HALF_WIDTH + (2 * CYC_HALF_WIDTH * j) / xSegs;
    for (const [z, y, f] of profile) {
      positions.push(x, y, z);
      const a = wallAlbedo + (floorAlbedo - wallAlbedo) * f;
      colors.push(a, a, a);
    }
  }
  const n = profile.length;
  for (let j = 0; j < xSegs; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + n;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// Softbox panel: bright diffuser with a slightly hotter centre and a feathered edge.
// Returns the mesh and its radiance-weighted area.
function softbox(direction, angularSize, radiance, aspect = 1) {
  const half = KEY_DISTANCE * Math.tan(angularSize);
  const w = 2 * half * Math.sqrt(aspect);
  const h = (2 * half) / Math.sqrt(aspect);
  const geometry = new PlaneGeometry(w, h, 32, 32);
  const pos = geometry.attributes.position;
  const colors = [];
  let sum = 0;
  for (let i = 0; i < pos.count; i++) {
    const u = (2 * pos.getX(i)) / w;
    const v = (2 * pos.getY(i)) / h;
    const r = Math.pow(u ** 4 + v ** 4, 0.25);
    const edge = 1 - smoothstep(0.82, 1, r);
    const c = radiance * (1.15 - 0.3 * r * r) * edge;
    colors.push(c, c, c);
    sum += c;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const mesh = new Mesh(geometry, null);
  mesh.position.copy(direction).multiplyScalar(KEY_DISTANCE);
  if (Math.abs(direction.y) > 0.99) mesh.up.set(0, 0, -1);
  mesh.lookAt(0, 0, 0);
  mesh.updateMatrixWorld();
  return { mesh, power: (sum / pos.count) * w * h };
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// Lambertian panel approximated as a wide spot so the cyc gets cos falloff from it.
function panelLight(panel, color) {
  const light = new SpotLight(color, panel.power, 0, Math.PI / 2, 1, 2);
  light.position.copy(panel.mesh.position);
  light.target.position.set(0, 0, 0);
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
  return light;
}

function floorIrradiance(lightPos, power) {
  _v.set(0, FLOOR_Y, 0).sub(lightPos);
  const d2 = _v.lengthSq();
  _v.normalize();
  const cosEmit = Math.max(-_v.dot(lightPos.clone().normalize()), 0);
  const cosRecv = Math.max(-_v.y, 0);
  return (power * cosEmit * cosRecv) / d2;
}

function applyEnvironment(result) {
  const u = globalUniforms;
  u.envMap.value = result.envMap;
  u.envMapMaxLod.value = Math.max(result.envMap.mipmaps.length - 1, 0);
  for (let i = 0; i < 9; i++) u.shIrradiance.value[i].copy(result.sh[i]);
  u.lightDirection.value.copy(result.lightDirection);
  if (result.lightColor) u.lightColor.value.copy(result.lightColor);
  if (result.shadowLightSize !== undefined) u.shadowLightSize.value = result.shadowLightSize;
}

// Renders a procedural photo studio (seamless cyc, big softbox key, fill, floor bounce) into a
// cube → PMREM. Returns { envMap, sh: Vector3[9], lightDirection: Vector3, lightColor: Color } and
// writes the globals (envMap, envMapMaxLod, shIrradiance, lightDirection, lightColor) when apply = true.
// The key panel is in envMap (reflections) but not in sh: lightColor carries its diffuse share.
// fillColor tints the fill panel only. Also sets shadowLightSize from keySize so shadow penumbrae match the softbox. `ceiling` adds a
// dim overhead bounce panel (radiance), lifting the floor and shadows more than the sides.
function createStudioEnvironment(renderer, options = {}) {
  return bakeStudio(renderer, studioScene(options), options);
}

// Same result, but the studio's programs compile without blocking first (KHR_parallel_shader_compile).
async function createStudioEnvironmentAsync(renderer, options = {}) {
  const studio = studioScene(options);
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  const prevTarget = renderer.getRenderTarget();
  // The bake draws into render targets, which select the linear, untonemapped programs.
  renderer.setRenderTarget(target);
  const compiled = renderer.compileAsync(studio.scene, new PerspectiveCamera());
  renderer.setRenderTarget(prevTarget);
  await compiled;
  target.dispose();
  return bakeStudio(renderer, studio, options);
}

function studioScene({
  keyDirection = new Vector3(-0.55, 0.72, 0.45),
  keyIntensity = 8,
  keySize = 0.4,
  fill = 0.6,
  fillColor = 0xffffff,
  floor = 0.9,
  tint = 0xffffff,
  ceiling = 0,
  wall = WALL_ALBEDO,
}) {
  const tintColor = new Color(tint);
  const keyDir = keyDirection.clone().normalize();
  const fillDir = new Vector3(-keyDir.x || 1, 0.15, Math.abs(keyDir.z) + 0.4).normalize();

  const scene = new Scene();
  scene.background = new Color(0, 0, 0);

  const emissive = new MeshBasicMaterial({ color: tintColor, vertexColors: true, side: DoubleSide });
  const cycMaterial = new MeshLambertMaterial({ color: tintColor, vertexColors: true, side: DoubleSide });
  const surroundMaterial = new MeshBasicMaterial({
    color: tintColor.clone().multiplyScalar(SURROUND_RADIANCE),
    side: BackSide,
  });

  const surround = new Mesh(new SphereGeometry(SURROUND_RADIUS, 32, 16), surroundMaterial);
  const cyc = new Mesh(cycGeometry(floor, wall), cycMaterial);

  const key = softbox(keyDir, keySize, keyIntensity, 0.8);
  const fillPanel = softbox(fillDir, keySize * 1.6, fill, 0.7);
  const fillTint = tintColor.clone().multiply(new Color(fillColor));
  const fillEmissive = new MeshBasicMaterial({ color: fillTint, vertexColors: true, side: DoubleSide });
  key.mesh.material = emissive;
  fillPanel.mesh.material = fillEmissive;

  scene.add(surround, cyc, key.mesh, fillPanel.mesh);
  const ceilingMaterial = new MeshBasicMaterial({ color: tintColor.clone().multiplyScalar(ceiling), side: DoubleSide });
  if (ceiling > 0) {
    const panel = new Mesh(new CircleGeometry(24, 48), ceilingMaterial);
    panel.position.y = 18;
    panel.rotation.x = Math.PI / 2;
    scene.add(panel);
  }
  scene.add(panelLight(key, tintColor), panelLight(fillPanel, fillTint));

  // One bounce of the floor and the dark room, lighting the wall and the sweep's inside.
  const floorE =
    floorIrradiance(key.mesh.position, key.power) + floorIrradiance(fillPanel.mesh.position, fillPanel.power);
  const ground = tintColor.clone().multiplyScalar(floor * floorE * 0.6);
  const sky = tintColor.clone().multiplyScalar(Math.PI * SURROUND_RADIANCE + 0.15 * floorE + 1.5 * ceiling);
  scene.add(new HemisphereLight(sky, ground, 1));
  const materials = [emissive, fillEmissive, cycMaterial, surroundMaterial, ceilingMaterial];
  return { scene, key, tintColor, keyDir, keySize, materials };
}

function bakeStudio(renderer, { scene, key, tintColor, keyDir, keySize, materials }, { apply = true, size = 256 }) {
  const pmrem = new PMREMGenerator(renderer);
  const renderTarget = pmrem.fromScene(scene, 0, 0.1, 100, { size });
  key.mesh.visible = false;
  const noKeyTarget = pmrem.fromScene(scene, 0, 0.1, 100, { size });
  key.mesh.visible = true;
  pmrem.dispose();
  const sh = computeSH(renderer, noKeyTarget.texture);
  noKeyTarget.dispose();

  scene.traverse((o) => o.geometry?.dispose());
  for (const m of materials) m.dispose();

  const envMap = renderTarget.texture;
  const result = {
    envMap,
    renderTarget,
    sh,
    lightDirection: keyDir,
    lightColor: tintColor.clone().multiplyScalar(key.power / (KEY_DISTANCE * KEY_DISTANCE)),
    shadowLightSize: Math.tan(keySize) * 0.8,
  };
  if (apply) applyEnvironment(result);
  return result;
}

// UltraHDR (.jpg) or .hdr. Leaves lightColor alone: set it to match the HDR's sun if needed.
async function loadHDREnvironment(renderer, url, { apply = true } = {}) {
  const isHDR = /\.hdr($|\?)/i.test(url);
  let loader;
  if (isHDR) {
    const { HDRLoader } = await import("three/addons/loaders/HDRLoader.js");
    loader = new HDRLoader();
  } else {
    loader = new UltraHDRLoader();
  }
  const texture = await loader.loadAsync(url);

  const pmrem = new PMREMGenerator(renderer);
  const renderTarget = pmrem.fromEquirectangular(texture);
  pmrem.dispose();
  texture.dispose();

  const envMap = renderTarget.texture;
  const sh = computeSH(renderer, envMap);
  const result = { envMap, renderTarget, sh, lightDirection: dominantDirection(sh) };
  if (apply) applyEnvironment(result);
  return result;
}

const SH_W = 128;
const SH_H = 64;

const latLongMaterial = () =>
  new ShaderMaterial({
    glslVersion: GLSL3,
    depthTest: false,
    depthWrite: false,
    uniforms: { envMap: { value: null }, flip: { value: 1 }, lod: { value: 0 }, size: { value: [SH_W, SH_H] } },
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform samplerCube envMap;
      uniform float flip;
      uniform float lod;
      uniform vec2 size;
      out vec4 fragColor;
      void main() {
        vec2 uv = gl_FragCoord.xy / size;
        float theta = uv.y * 3.141592653589793;
        float phi = uv.x * 6.283185307179586;
        vec3 d = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
        fragColor = vec4(textureLod(envMap, vec3(flip * d.x, d.yz), lod).rgb, 1.0);
      }
    `,
  });

// Band factors of the clamped-cosine convolution, divided by pi.
const BAND = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];

// SH9 of a cube env (three's SphericalHarmonics3 order and basis). Coefficients are
// cosine-convolved and divided by pi: sum(sh[i] * Y_i(n)) is the radiance a white
// Lambertian surface with normal n reflects, so multiply it by albedo directly.
function computeSH(renderer, envTexture) {
  const target = new WebGLRenderTarget(SH_W, SH_H, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const material = latLongMaterial();
  material.uniforms.envMap.value = envTexture;
  material.uniforms.flip.value = envTexture.isRenderTargetTexture ? 1 : -1;
  // A wide prefiltered level spreads small bright sources (a sun) over many sample cells.
  material.uniforms.lod.value = Math.max((envTexture.mipmaps?.length ?? 1) - 3, 0);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new Mesh(geometry, material);
  quad.frustumCulled = false;
  const camera = new OrthographicCamera();

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(quad, camera);
  const pixels = new Float32Array(SH_W * SH_H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, SH_W, SH_H, pixels);
  renderer.setRenderTarget(prevTarget);

  target.dispose();
  material.dispose();
  geometry.dispose();

  const sh = Array.from({ length: 9 }, () => new Vector3());
  const dTheta = Math.PI / SH_H;
  const dPhi = (2 * Math.PI) / SH_W;
  const Y = new Array(9);
  for (let j = 0; j < SH_H; j++) {
    const theta = ((j + 0.5) / SH_H) * Math.PI;
    const st = Math.sin(theta);
    const y = Math.cos(theta);
    const dOmega = st * dTheta * dPhi;
    for (let i = 0; i < SH_W; i++) {
      const phi = ((i + 0.5) / SH_W) * 2 * Math.PI;
      const x = st * Math.cos(phi);
      const z = st * Math.sin(phi);
      shBasis(x, y, z, Y);
      const k = (j * SH_W + i) * 4;
      const r = pixels[k] * dOmega;
      const g = pixels[k + 1] * dOmega;
      const b = pixels[k + 2] * dOmega;
      for (let c = 0; c < 9; c++) {
        sh[c].x += r * Y[c];
        sh[c].y += g * Y[c];
        sh[c].z += b * Y[c];
      }
    }
  }
  for (let c = 0; c < 9; c++) sh[c].multiplyScalar(BAND[c]);
  return sh;
}

function shBasis(x, y, z, out) {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

// Centroid of the light from band 1 (more stable than the brightest texel).
function dominantDirection(sh) {
  const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
  const d = new Vector3(lum(sh[3]), lum(sh[1]), lum(sh[2]));
  return d.lengthSq() > 1e-12 ? d.normalize() : new Vector3(0, 1, 0);
}

// GLSL evaluation of computeSH's coefficients; needs `uniform vec3 shIrradiance[9]`.
const shGLSL = /* glsl */ `
vec3 evalSH(vec3 n) {
  return shIrradiance[0] * 0.282095
    + shIrradiance[1] * (0.488603 * n.y)
    + shIrradiance[2] * (0.488603 * n.z)
    + shIrradiance[3] * (0.488603 * n.x)
    + shIrradiance[4] * (1.092548 * n.x * n.y)
    + shIrradiance[5] * (1.092548 * n.y * n.z)
    + shIrradiance[6] * (0.315392 * (3.0 * n.z * n.z - 1.0))
    + shIrradiance[7] * (1.092548 * n.x * n.z)
    + shIrradiance[8] * (0.546274 * (n.x * n.x - n.y * n.y));
}
`;

export { createStudioEnvironment, createStudioEnvironmentAsync, loadHDREnvironment, computeSH, dominantDirection, shGLSL };
