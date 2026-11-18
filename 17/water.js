// The water: one light model shared by every material and pass (the sun refracted at the surface, red absorbed first,
// diffuse light from above), the surface waves, the caustics they focus, the deep-water backdrop and the surface seen
// from below (Snell's window).
import {
  Vector3,
  Color,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  BufferAttribute,
  ShaderMaterial,
  RawShaderMaterial,
  GLSL3,
  WebGLRenderTarget,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  NoColorSpace,
  CustomBlending,
  AddEquation,
  OneFactor,
  BackSide,
  DoubleSide,
  SphereGeometry,
  CircleGeometry,
} from "three";

export const SURFACE_Y = 17.8;
// Caustics are computed on a square of water this wide (metres) that tiles, focused this far below the surface.
export const CAUSTIC_TILE = 14;
export const CAUSTIC_FOCUS = 9;
const IOR = 1.333;

// Toward the sun under water (refracted), and in the air above.
const SUN = new Vector3(0.14, 0.8, -0.58).normalize();
function airDirection(w) {
  const h = Math.hypot(w.x, w.z);
  const sinA = Math.min(1, h * IOR);
  return new Vector3((w.x / h) * sinA, Math.sqrt(1 - sinA * sinA), (w.z / h) * sinA);
}

export const waterUniforms = {
  uSurfaceY: { value: SURFACE_Y },
  uSunDir: { value: SUN },
  uSunAirDir: { value: airDirection(SUN) },
  // Sunlight just under the surface, and the diffuse light coming down there.
  uSunColor: { value: new Color(1.0, 0.94, 0.82).multiplyScalar(14) },
  uAmbient: { value: new Color(0.55, 0.8, 1.0).multiplyScalar(1.25) },
  // Extinction and scattering per metre along the eye's ray (red goes first)...
  uSigma: { value: new Vector3(0.055, 0.04, 0.036) },
  // ...and along the light's way down, kept nearly neutral: the colours a photographer's white balance restores.
  uSigmaLight: { value: new Vector3(0.05, 0.042, 0.042) },
  // Coastal water's teal: more green scattered than in the open ocean.
  uScatter: { value: new Vector3(0.0027, 0.0085, 0.0135) },
  // The sun scattered forward by particles, nearly grey: as bright as uScatter, without its blue.
  uScatterSun: { value: new Vector3(0.0072, 0.0072, 0.0072) },
  uCaustics: { value: 1 },
  uMurk: { value: 0 },
  uWaterTime: { value: 0 },
  tCaustics: { value: null },
  // 0: the picture; 1: sun shadow, 2: caustics, 3: the light reaching surfaces (no water in between).
  uDebug: { value: 0 },
};

// Silt stirred up between forests: everything but the deep water fades into it (0..1).
export const murk = waterUniforms.uMurk;

// The surface: a sum of waves whose wave vectors fit the caustic tile, so the waves (and caustics) tile too.
// [m, n, amplitude (m), speed]: wave vector 2π/TILE · (m, n).
const WAVES = [
  [2, 1, 0.16, 1],
  [-1, 3, 0.09, 1],
  [3, -2, 0.06, 1],
  [5, 3, 0.035, 1.1],
  [7, -4, 0.022, 1],
  [4, 7, 0.02, 0.9],
  [9, 5, 0.014, 1.05],
  [-6, 8, 0.012, 1],
  [11, -3, 0.01, 0.95],
  [13, 7, 0.0075, 1.1],
  [-9, -11, 0.006, 1],
  [16, 9, 0.0045, 1],
];
const waveTable = WAVES.map(([m, n, a, s], i) => {
  const kx = ((2 * Math.PI) / CAUSTIC_TILE) * m;
  const kz = ((2 * Math.PI) / CAUSTIC_TILE) * n;
  const w = Math.sqrt(9.81 * Math.hypot(kx, kz)) * s * 0.55;
  return `vec4(${kx.toFixed(6)}, ${kz.toFixed(6)}, ${(a * 0.6).toFixed(6)}, ${w.toFixed(6)}), vec4(${(i * 2.39996).toFixed(4)})`;
});

// Value noise (with its gradient) and fbm, for the surface's ripples and the materials.
export const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 noise2DGrad(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise2D(p);
    p = rot * p * 2.04;
    a *= 0.5;
  }
  return v;
}
`;

export const waveGLSL = /* glsl */ `
const vec4 WAVES[${WAVES.length * 2}] = vec4[](${waveTable.join(", ")});
// The surface's upward normal at xz.
vec3 waveNormal(vec2 xz, float t) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${WAVES.length}; i++) {
    vec4 w = WAVES[i * 2];
    float ph = dot(w.xy, xz) - w.w * t + WAVES[i * 2 + 1].x;
    g += w.z * w.xy * cos(ph);
  }
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;

export const waterGLSL = /* glsl */ `
uniform float uSurfaceY;
uniform vec3 uSunDir;
uniform vec3 uSunAirDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uSigma;
uniform vec3 uSigmaLight;
uniform vec3 uScatter;
uniform vec3 uScatterSun;
uniform float uCaustics;
uniform float uMurk;
uniform float uWaterTime;
uniform sampler2D tCaustics;
uniform int uDebug;

#define CAUSTIC_TILE ${CAUSTIC_TILE.toFixed(1)}
#define CAUSTIC_FOCUS ${CAUSTIC_FOCUS.toFixed(1)}

float depthAt(vec3 p) {
  return max(uSurfaceY - p.y, 0.0);
}

// Sunlight left at p after its refracted path down from the surface.
vec3 sunAt(vec3 p) {
  return uSunColor * exp(-uSigmaLight * depthAt(p) / uSunDir.y);
}

// Diffuse light in the water, mostly from above, fading with depth.
vec3 ambientAt(vec3 p, vec3 n) {
  vec3 down = uAmbient * exp(-uSigmaLight * 1.15 * depthAt(p));
  float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  return down * (0.12 + 0.88 * up * sqrt(up));
}

// The surface's focusing pattern, projected down along the sun: sharp near the focus depth, softer away from it.
float causticAt(vec3 p) {
  float d = depthAt(p);
  vec2 q = (p.xz + uSunDir.xz / uSunDir.y * d) / CAUSTIC_TILE;
  float lod = clamp(log2(1.0 + abs(d - CAUSTIC_FOCUS) * 0.55), 0.0, 6.0);
  float c = textureLod(tCaustics, q, lod).r;
  return max(mix(1.0, c, uCaustics), 0.0);
}

// Diffuse light scattered toward the eye along t metres of the ray (the sun's own share is the shafts pass).
vec3 waterInscatter(vec3 ro, vec3 rd, float t) {
  vec3 sa = uSigmaLight * 1.15;
  vec3 k = uSigma - sa * rd.y;
  // At least 1e-4 from zero, keeping its sign (0 counts as positive).
  k = mix(vec3(-1.0), vec3(1.0), step(0.0, k)) * max(abs(k), vec3(1e-4));
  vec3 a0 = uAmbient * exp(-sa * depthAt(ro));
  return uScatter * a0 * (1.0 - exp(-k * t)) / k;
}

// How far the eye sees along rd: to the surface going up, effectively forever going down.
float waterDistance(vec3 ro, vec3 rd) {
  return rd.y > 1e-4 ? max(uSurfaceY - ro.y, 0.0) / rd.y : 400.0;
}

// The deep water seen along rd from ro.
vec3 waterBackground(vec3 ro, vec3 rd) {
  return waterInscatter(ro, rd, waterDistance(ro, rd));
}

// Silt stirred up between forests: a dull grey-green, nearly the same in every direction.
vec3 siltColor(vec3 rd) {
  vec3 c = waterBackground(cameraPosition, normalize(vec3(rd.x, 0.3 + 0.3 * rd.y, rd.z)));
  return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 0.55) * vec3(1.1, 1.0, 0.72);
}

// Light from p as it reaches the eye through the water; murk fades it into the silt.
vec3 applyWater(vec3 color, vec3 p) {
  vec3 v = p - cameraPosition;
  float t = length(v);
  vec3 rd = v / max(t, 1e-4);
  vec3 c = color * exp(-uSigma * t) + waterInscatter(cameraPosition, rd, t);
  if (uMurk > 0.0) c = mix(c, siltColor(rd), uMurk);
  return c;
}
`;

// The deep water all around: what's left past everything else.
export function createBackdrop() {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: { ...waterUniforms },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${waterGLSL}
      void main() {
        vec3 rd = normalize(vDir);
        vec3 c = waterBackground(cameraPosition, rd);
        if (uMurk > 0.0) c = mix(c, siltColor(rd), uMurk);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new Mesh(new SphereGeometry(90, 48, 24), material);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (renderer, scene, camera) => mesh.position.copy(camera.position);
  return mesh;
}

// The surface from below: inside the critical angle the sky (and the sun, broken up by the waves), outside it the
// deep reflected back.
export function createSurface({ radius = 60 } = {}) {
  const material = new ShaderMaterial({
    side: DoubleSide,
    depthWrite: false,
    transparent: true,
    uniforms: { ...waterUniforms, uSky: { value: 3.2 }, uSunDisc: { value: 900 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying float vEdge;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vEdge = length(position.xy) / ${radius.toFixed(1)};
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uSky;
      uniform float uSunDisc;
      varying vec3 vWorldPos;
      varying float vEdge;
      ${waterGLSL}
      ${waveGLSL}
      ${NOISE_GLSL}

      vec3 sky(vec3 r) {
        // A clear sky, deep blue overhead and paler toward the horizon: it stays blue through the camera's warm balance.
        vec3 c = mix(vec3(0.36, 0.6, 1.0), vec3(0.82, 0.9, 1.0), pow(1.0 - r.y, 3.0)) * uSky;
        float mu = max(dot(r, uSunAirDir), 0.0);
        // The sun's glints are thousands of times brighter than the water: they go first when silt clouds it.
        float clear = pow(1.0 - uMurk, 4.0);
        c += uSunColor * (smoothstep(0.99955, 0.99975, mu) * uSunDisc * clear + pow(mu, 400.0) * 4.0 + pow(mu, 24.0) * 0.25) / 10.0;
        // A broad warm aureole: the low sun seen through the air's haze.
        c += uSunColor * vec3(1.0, 0.85, 0.6) * (pow(mu, 8.0) * 0.1 + pow(mu, 48.0) * 0.25);
        return c;
      }

      void main() {
        float px = length(fwidth(vWorldPos.xz));
        vec3 I = normalize(vWorldPos - cameraPosition);
        // The surface seen from above the water: nothing to draw (the camera stays below).
        if (I.y <= 0.0) discard;
        vec3 n = waveNormal(vWorldPos.xz, uWaterTime);
        // Fine ripples on the swell: they break the window's edge into a sparkling band and carry the sun's glints. Each set
        // fades out before it aliases.
        vec3 r1 = noise2DGrad(vWorldPos.xz * 1.7 + uWaterTime * vec2(0.5, 0.3)) * smoothstep(0.4, 0.15, px);
        vec3 r2 = noise2DGrad(vWorldPos.xz * 4.3 - uWaterTime * vec2(0.4, 0.7)) * smoothstep(0.18, 0.07, px);
        n = normalize(n - vec3(r1.y * 0.11 + r2.y * 0.09, 0.0, r1.z * 0.11 + r2.z * 0.09));
        vec3 N = -n;
        vec3 R = refract(I, N, ${IOR.toFixed(3)});
        vec3 reflected = waterBackground(vWorldPos - vec3(0.0, 0.01, 0.0), reflect(I, N));
        vec3 col;
        if (dot(R, R) < 1e-6) {
          col = reflected;
        } else {
          float cosT = max(R.y, 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
          col = sky(R) * (1.0 - F) + reflected * F;
        }
        col = applyWater(col, vWorldPos);
        float alpha = 1.0 - smoothstep(0.8, 1.0, vEdge);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const mesh = new Mesh(new CircleGeometry(radius, 96), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = SURFACE_Y;
  mesh.renderOrder = -1;
  return mesh;
}

// Caustics: a grid on the surface tile refracts the sun, each cell lands where its light goes at the focus depth, and its
// brightness is how much its area shrank on the way (the area ratio, from screen-space derivatives).
export class Caustics {
  constructor({ size = 512, grid = 192 } = {}) {
    this.target = new WebGLRenderTarget(size, size, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      colorSpace: NoColorSpace,
    });
    waterUniforms.tCaustics.value = this.target.texture;
    // The grid covers the tile and a quarter beyond each side, so light crossing the edges lands on the far side too.
    const n = grid + 1;
    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 3;
        positions[o] = -0.25 + (1.5 * i) / grid;
        positions[o + 1] = -0.25 + (1.5 * j) / grid;
      }
    }
    const index = new Uint32Array(grid * grid * 6);
    let k = 0;
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const a = j * n + i;
        index[k++] = a;
        index[k++] = a + 1;
        index[k++] = a + n;
        index[k++] = a + 1;
        index[k++] = a + n + 1;
        index[k++] = a + n;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { uTime: { value: 0 }, uSunAirDir: waterUniforms.uSunAirDir, uSunDir: waterUniforms.uSunDir },
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      vertexShader: /* glsl */ `
        precision highp float;
        in vec3 position;
        uniform float uTime;
        uniform vec3 uSunAirDir;
        uniform vec3 uSunDir;
        out vec2 vP0;
        out vec2 vP1;
        ${waveGLSL}
        void main() {
          vec2 p0 = position.xy;
          vec3 n = waveNormal(p0 * ${CAUSTIC_TILE.toFixed(1)}, uTime);
          vec3 r = refract(-uSunAirDir, n, ${(1 / IOR).toFixed(5)});
          vec3 r0 = -uSunDir;
          vec2 shift = (r.xz / -r.y - r0.xz / -r0.y) * ${CAUSTIC_FOCUS.toFixed(1)};
          vec2 p1 = p0 + shift / ${CAUSTIC_TILE.toFixed(1)};
          vP0 = p0;
          vP1 = p1;
          gl_Position = vec4(p1 * 2.0 - 1.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vP0;
        in vec2 vP1;
        out vec4 outColor;
        void main() {
          float a0 = length(dFdx(vP0)) * length(dFdy(vP0));
          float a1 = length(dFdx(vP1)) * length(dFdy(vP1));
          float c = min(a0 / max(a1, 1e-14), 24.0);
          outColor = vec4(c, c, c, 1.0);
        }
      `,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.mesh);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  update(renderer, time) {
    this.material.uniforms.uTime.value = time;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
  }
}
