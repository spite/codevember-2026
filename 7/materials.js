import {
  Color,
  Vector3,
  Matrix3,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  CubeCamera,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  LinearMipmapLinearFilter,
  CustomBlending,
  AddEquation,
  MaxEquation,
  OneFactor,
  DoubleSide,
  Scene,
  Mesh,
  GLSL3,
} from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

// Body colours: shell (porcelain layers), glass (amber layers), backdrop and how much light the shell's wall stops
// (sigma, relative).
const PALETTES = {
  white: { shell: 0xf2eee7, glass: 0xd94a00, backdrop: 0xd6d3cd, glassInner: false },
  bone: { shell: 0xe9dfcd, glass: 0xd94a00, backdrop: 0xcfc6b8, glassInner: false },
  blush: { shell: 0xf0cdca, glass: 0xe0581e, backdrop: 0xe6c0bd, glassInner: false, sigma: 0.8 },
  magenta: { shell: 0x9c1a6c, glass: 0xd94a00, backdrop: 0xefecec, glassInner: false, sigma: 0.5 },
};

// What the shell is made of: roughness, F0 scale, sheen, the key light let through thin walls, how much of the glow
// gets through (glow) and how much the wall stops (sigma), saturation, value and tint of the body colour, wax (wrapped,
// scattered light) and glaze (colour pooling in the hollows).
const FINISHES = {
  glossy: { rough: 0.08, specular: 1.45, sheen: 0, transmission: 0.05, glow: 0.5, sigma: 1.7, sat: 1.12, value: 0.88, wax: 0, glaze: 1 },
  plastic: { rough: 0.22, specular: 1.15, sheen: 0.05, transmission: 0.06, glow: 0.75, sigma: 1.35, sat: 1.25, value: 0.93, wax: 0, glaze: 0 },
  porcelain: { rough: 0.46, specular: 1, sheen: 0.25, transmission: 0.25, glow: 1, sigma: 1, sat: 1, value: 1, wax: 0, glaze: 0 },
  wax: { rough: 0.32, specular: 1, sheen: 0.12, transmission: 0.5, glow: 1.4, sigma: 0.5, sat: 0.92, value: 0.86, tint: 0xfff5e0, wax: 1, glaze: 0 },
};

// Cube taps per lit pixel; set before any material is made.
const lampConfig = { taps: 6 };

// Shared by everything the bulb lights: its cube of wall thickness, where it is and how bright.
const lampUniforms = {
  lampThickness: { value: null },
  lampPos: { value: new Vector3() },
  lampRot: { value: new Matrix3() },
  lampColor: { value: new Color(0, 0, 0) },
  lampRadius: { value: 0.07 },
  lampShell: { value: 0.5 },
  lampTexel: { value: 2 / 512 },
  lampSigma: { value: [new Vector3(), new Vector3(), new Vector3()] },
  lampOcc: { value: new Array(17).fill(0.5) },
  lampAxis: { value: new Vector3(0, 1, 0) },
  lampFree: { value: 0 },
  lampOpen: { value: 0 },
  lampWall: { value: 0.03 },
};

const lampChunk = () => /* glsl */ `
#define LAMP_TAPS ${lampConfig.taps}
uniform samplerCube lampThickness;
uniform vec3 lampPos;
uniform mat3 lampRot;
uniform vec3 lampColor;
uniform float lampRadius;
uniform float lampShell;
uniform float lampTexel;
uniform vec3 lampSigma[3];
uniform float lampOcc[17];
uniform vec3 lampAxis;
uniform float lampFree;
uniform float lampOpen;
uniform float lampWall;

// Distance from the glow to the outer skin, by the cosine of the angle from lampAxis.
float lampOccluder(float cy) {
  float f = clamp(cy * 0.5 + 0.5, 0.0, 1.0) * 16.0;
  int i = int(min(f, 15.0));
  return mix(lampOcc[i], lampOcc[i + 1], f - float(i));
}

// Transmittance from the bulb to P through the walls of the layers in mask, less sub, softened by the bulb's size (times
// soft) over the gap between the occluder (the nearest shell, or the outer one with outer = 1) and P. A fixed
// spiral of taps (no per-pixel rotation, which shows as a checker without TAA), each blurred by the mips to
// overlap its neighbours.
vec3 lampTransmit(vec3 P, vec3 mask, vec3 sub, float soft, float outer) {
  vec3 D = lampRot * (P - lampPos);
  float dist = length(D);
  vec3 dir = D / max(dist, 1e-4);
  float occ = mix(lampShell, lampOccluder(dot(dir, lampAxis)), outer);
  float pen = max(soft * lampRadius * max(dist - occ, 0.0) / max(occ * dist, 1e-3), 0.003);
  float lod = clamp(log2(pen / lampTexel) + mix(0.6, -0.2, outer), 0.0, 6.0);
  const int taps = LAMP_TAPS;
  vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(dir, t1);
  const float a0 = 0.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < taps; i++) {
    float r = sqrt((float(i) + 0.5) / float(taps)) * pen * 0.8;
    float a = a0 + float(i) * 2.3999632;
    vec3 d = normalize(dir + (t1 * cos(a) + t2 * sin(a)) * r);
    vec3 th = max(max(textureLod(lampThickness, d, lod).rgb, vec3(0.0)) * mask - sub, vec3(0.0));
    sum += exp(-(lampSigma[0] * th.r + lampSigma[1] * th.g + lampSigma[2] * th.b));
  }
  sum /= float(taps);
  // Receivers get a firmer edge to the projected holes than the mip blur leaves.
  return mix(sum, sum * sum * (3.0 - 2.0 * sum), 0.7 * outer);
}

// Receivers: a falloff gentler than 1/d^2 past a metre, so the pattern still reaches the sweep, and a penumbra
// from the outer skin, so the hole shapes read. wrap lets light wrap round the receiver.
vec3 lampDiffuse(vec3 P, vec3 n, vec3 albedo, float wrap) {
  if (lampColor.r + lampColor.g + lampColor.b <= 0.0) return vec3(0.0);
  vec3 Lv = lampPos - P;
  float d2 = max(dot(Lv, Lv), 1e-3);
  float ndl = (dot(n, Lv * inversesqrt(d2)) + wrap) / (1.0 + wrap);
  if (ndl <= 0.0) return vec3(0.0);
  float fall = 1.0 / min(d2, pow(d2, 0.55));
  return albedo * PIPELINE_INV_PI * lampColor * fall * ndl * lampTransmit(P, vec3(1.0), vec3(0.0), 0.5, 1.0);
}
`;

const noiseChunk = /* glsl */ `
float n3hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(n3hash(i), n3hash(i + vec3(1, 0, 0)), f.x), mix(n3hash(i + vec3(0, 1, 0)), n3hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(n3hash(i + vec3(0, 0, 1)), n3hash(i + vec3(1, 0, 1)), f.x), mix(n3hash(i + vec3(0, 1, 1)), n3hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s / 0.9375;
}
`;

const shellShared = () => ({
  erosionNow: { value: 0 },
  meshErosion: { value: 0 },
  displaceMax: { value: 0.02 },
  bulbLocal: { value: new Vector3() },
});

// The hollowed shells. Per vertex: occlusion, layer and wall coordinate, the velocity with erosion that carries the
// surface on between meshes.
function createShellMaterial(shared) {
  return new PipelineMaterial({
    color: 0xf2eee7,
    roughness: 0.45,
    sheen: 0.25,
    sheenColor: 0xfff6ea,
    sheenRoughness: 0.6,
    transmission: 0.25,
    transmissionColor: 0xffd9b0,
    uniforms: {
      ...lampUniforms,
      ...shared,
      layerColor: { value: [new Color(), new Color(), new Color()] },
      layerRough: { value: [0.45, 0.45, 0.45] },
      layerGlass: { value: [0, 0, 0] },
      layerGlow: { value: [1, 1, 1] },
      glow: { value: 1 },
      glowTint: { value: new Color(1, 0.88, 0.76) },
      lampFill: { value: new Color(0, 0, 0) },
      aoBake: { value: 0.5 },
      finishSpecular: { value: 1 },
      finishWax: { value: 0 },
      finishGlaze: { value: 0 },
      scatterColor: { value: new Color(1, 0.8, 0.56) },
      scatterDist: { value: 0.03 },
    },
    vertexPars: /* glsl */ `
in vec4 shellData;
in vec3 shellVel;
uniform float erosionNow;
uniform float meshErosion;
uniform float displaceMax;
`,
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  vec3 d = shellVel * (erosionNow - meshErosion);
  float l = length(d);
  return p + (l > displaceMax ? d * (displaceMax / l) : d);
}
`,
    varyings: { vAO: "float", vLayer: "float", vWall: "float" },
    vertexMain: "vAO = shellData.x; vLayer = shellData.y; vWall = shellData.z;",
    fragmentPars: /* glsl */ `
${lampChunk()}
${noiseChunk}
uniform vec3 layerColor[3];
uniform float layerRough[3];
uniform float layerGlass[3];
uniform float layerGlow[3];
uniform float glow;
uniform vec3 glowTint;
uniform vec3 lampFill;
uniform float aoBake;
uniform float finishSpecular;
uniform float finishWax;
uniform float finishGlaze;
uniform vec3 scatterColor;
uniform float scatterDist;

`,
    surface: /* glsl */ `
void surface(inout Surface s) {
  int layer = clamp(int(vLayer + 0.5), 0, 2);
  vec3 op = vObjectPosition;
  float glassLayer = layerGlass[layer];
  float glass = glassLayer;
  s.albedo = layerColor[layer];
  s.roughness = layerRough[layer];
  s.specular = finishSpecular;
  float wax = finishWax * (1.0 - glass);
  // Glaze pools in the hollows, deepening the colour there.
  float pool = finishGlaze * (1.0 - glass) * (1.0 - smoothstep(0.35, 0.95, vAO));
  s.albedo *= mix(vec3(1.0), s.albedo * 0.85, 0.55 * pool);
  float dens = 1.0, clear = 0.0;
  if (glassLayer > 0.5) {
    // Amber: glass reflects little diffusely, so its colour is mostly the bulb's light coming through (below). Deep
    // orange, finely mottled, with a few clear windows and faint darker veins.
    dens = 0.3 + 0.7 * smoothstep(0.25, 0.72, fbm3(op * 9.0 + 1.7));
    clear = (1.0 - smoothstep(0.24, 0.32, fbm3(op * 3.2 + 5.0))) * glass;
    float vein = 1.0 - smoothstep(0.0, 0.02, abs(fbm3(op * 4.5 + 3.0) - 0.5));
    vec3 amber = mix(vec3(0.3, 0.04, 0.0), vec3(0.62, 0.17, 0.0), dens);
    amber = mix(amber, vec3(0.2, 0.03, 0.0), vein * 0.2);
    s.albedo = amber;
    s.sheenColor *= 1.0 - glass;
    s.transmission *= 1.0 - glass;
    s.specular = mix(1.0, 0.5, glass);
    s.roughness = mix(s.roughness, 0.04, glass);
  }
  vec3 V = normalize(cameraPosition - vWorldPosition);
  s.occlusion = mix(1.0, clamp(vAO, 0.0, 1.0), aoBake);

#ifdef PIPELINE_COLOR
  if (lampColor.r + lampColor.g + lampColor.b > 0.0) {
    vec3 P = vWorldPosition;
    vec3 Lv = lampPos - P;
    float d2 = max(dot(Lv, Lv), 1e-3);
    vec3 L = Lv * inversesqrt(d2);
    vec3 Eb = lampColor / d2;
    vec3 n = normalize(s.normal);
    float facing = dot(normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0), L);
    // Faces turned from the bulb see it through their own wall.
    float own = smoothstep(0.25, -0.25, facing);
    // A light moved off its interior point can sit behind other walls (alpha: 1 / the nearest wall's distance). There
    // P's own layer counts too, less P's own wall, and outer layers count about half (their near side) once the
    // light is mostly outside.
    vec3 Dl = lampRot * (P - lampPos);
    float aNear = textureLod(lampThickness, Dl, 1.5).a;
    float behind = lampFree * smoothstep(0.3, 0.9, (length(Dl) - 1.0 / max(aNear, 1e-3)) / lampWall);
    float ownM = mix(own, 1.0, behind);
    float ownSub = behind * (1.0 - own) * (2.4 * abs(vWall) / max(abs(facing), 0.3) + 0.003);
    float outerM = 0.5 * lampFree * smoothstep(0.1, 0.4, lampOpen);
    vec3 mask = layer == 0 ? vec3(ownM, 1.0, 1.0) : layer == 1 ? vec3(outerM, ownM, 1.0) : vec3(outerM, outerM, ownM);
    vec3 sub = layer == 0 ? vec3(ownSub, 0.0, 0.0) : layer == 1 ? vec3(0.0, ownSub, 0.0) : vec3(0.0, 0.0, ownSub);
    vec3 T = lampTransmit(P, mask, sub, 1.0, 0.0);
    float ndl = max(dot(n, L), 0.0);
    float ndlWrap = max((dot(n, L) + 0.4 * wax) / (1.0 + 0.4 * wax), 0.0);
    vec3 direct = s.albedo * PIPELINE_INV_PI * Eb * ndlWrap * T;
    // What comes through the wall leaves its far side diffusely, tinted by the body (brighter than its albedo).
    vec3 body = pow(s.albedo, vec3(0.6)) * glowTint * mix(vec3(1.0), scatterColor, wax);
    // The wall's own absorption already reddens it; this keeps it orange rather than salmon, and dim enough that the
    // tonemapper doesn't bleach it.
    vec3 amber = mix(vec3(1.0, 0.26, 0.0), vec3(1.0, 0.42, 0.015), dens) * (0.06 + 0.32 * dens * dens) * (1.0 - 0.45 * clear);
    vec3 tint = mix(body, amber, glass);
    vec3 through = tint * PIPELINE_INV_PI * Eb * T * own * glow * layerGlow[layer];
    vec3 H = normalize(L + V);
    float rough = clamp(s.roughness, 0.08, 1.0), a = rough * rough;
    float NdotV = clamp(dot(n, V), 1e-4, 1.0);
    vec3 spec = Eb * T * ndl * F_Schlick(clamp(dot(V, H), 0.0, 1.0), vec3(0.04 * s.specular)) * D_GGX(clamp(dot(n, H), 0.0, 1.0), a) * V_SmithGGXCorrelated(a, NdotV, ndl);
    s.emissive += direct * mix(1.0, 0.3, glass) + through + spec;
    // The glow bounced back by the room, mostly from the floor below and the side facing the camera, so the outer
    // skin keeps its form at night.
    float bounce = clamp(0.55 - 0.45 * n.y + 0.25 * dot(n, V), 0.0, 1.0);
    s.emissive += s.albedo * lampFill * (0.25 + 0.75 * bounce) * s.occlusion * (1.0 - 0.7 * glass);
  }
  if (wax > 0.0) {
    // Wax: the key wraps past the terminator, redder the further it goes, and comes through walls thinner than the
    // scattering distance (the shadow is looked up that far toward the light); the room glows through from behind.
    vec3 n = normalize(s.normal);
    vec3 L = normalize(lightDirection);
    float x = dot(n, L);
    vec3 w = vec3(0.45, 0.24, 0.13) * wax;
    vec3 wrapD = max((vec3(x) + w) / (1.0 + w) - max(x, 0.0), vec3(0.0));
    float bleed = getShadowFixed(vWorldPosition + L * scatterDist, L, 5.0);
    s.emissive += s.albedo * scatterColor * lightColor * wrapD * bleed * PIPELINE_INV_PI;
    vec3 back = max(evalSH(envRotation * -n), vec3(0.0)) * envIntensity;
    s.emissive += s.albedo * scatterColor * back * 0.05 * wax * s.occlusion;
  }
  if (glass > 0.0) {
    // Glass: the studio reflected with a strong Fresnel rim even where the outer layer shades it, and the room seen through
    // it, deep orange through the body and paler through the clear patches. Its diffuse part is kept low, so the
    // outer layer's bounce light doesn't wash it out.
    vec3 n = normalize(s.normal);
    float c = clamp(dot(n, V), 0.0, 1.0);
    float F = 0.05 + 0.95 * pow(1.0 - c, 5.0);
    vec3 R = reflect(-V, n);
    vec3 refl = textureLod(envMap, envRotation * R, 0.6).rgb * envIntensity;
    // Mostly the bright parts of the studio: an even grey reflection over the orange reads as a milky film.
    vec3 hi = max(refl - 0.8 * textureLod(envMap, envRotation * R, envMapMaxLod).rgb * envIntensity, vec3(0.0));
    vec3 behind = textureLod(envMap, envRotation * -V, 4.0).rgb * envIntensity;
    vec3 seen = mix(mix(vec3(0.5, 0.05, 0.0), vec3(0.85, 0.24, 0.0), dens) * 0.8, vec3(0.34, 0.22, 0.13), clear);
    s.albedo *= mix(1.0, 0.4, glass) * (1.0 - 0.5 * clear);
    s.emissive += glass * (refl * F * 0.5 + hi * (F * 1.5 + 0.025) + behind * seen * (1.0 - F));
  }
#endif
}
`,
  });
}

// Wall thickness seen from the bulb, one layer per channel: entering faces subtract their distance and
// leaving faces add it, so each texel sums to the length of wall along its ray. Alpha keeps the nearest wall, as
// 1 / distance under max blending.
function createThicknessMaterial(shared) {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { ...shared },
    vertexShader: /* glsl */ `
in vec4 shellData;
in vec3 shellVel;
uniform float erosionNow;
uniform float meshErosion;
uniform float displaceMax;
out vec3 vPos;
flat out int vLayer;
void main() {
  vec3 d = shellVel * (erosionNow - meshErosion);
  float l = length(d);
  vec3 p = position + (l > displaceMax ? d * (displaceMax / l) : d);
  vPos = p;
  vLayer = int(shellData.y + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 bulbLocal;
in vec3 vPos;
flat in int vLayer;
layout(location = 0) out vec4 outColor;
void main() {
  float d = distance(vPos, bulbLocal) * (gl_FrontFacing ? -1.0 : 1.0);
  outColor = vec4(vLayer == 0 ? d : 0.0, vLayer == 1 ? d : 0.0, vLayer == 2 ? d : 0.0, 1.0 / max(abs(d), 1e-3));
}
`,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendEquationAlpha: MaxEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
}

// The cube the glow sees, rendered in the sculpture's own frame so tumbling it doesn't redraw it.
class LampShadow {
  constructor(renderer, shared, size) {
    this.renderer = renderer;
    this.target = new WebGLCubeRenderTarget(size, {
      type: HalfFloatType,
      format: RGBAFormat,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.camera = new CubeCamera(0.005, 20, this.target);
    this.scene = new Scene();
    this.scene.add(this.camera);
    this.material = createThicknessMaterial(shared);
    this.mesh = null;
    lampUniforms.lampThickness.value = this.target.texture;
    lampUniforms.lampTexel.value = 2 / size;
  }

  setGeometry(geometry) {
    if (!this.mesh) {
      this.mesh = new Mesh(geometry, this.material);
      this.mesh.frustumCulled = false;
      this.scene.add(this.mesh);
    }
    // A geometry made only for the glow (a sketch's) is dropped when replaced.
    if (this.mesh.geometry !== geometry && this.mesh.geometry.userData.sketch) this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  compileAsync() {
    return this.mesh ? this.renderer.compileAsync(this.mesh, this.camera.children[0], this.scene) : Promise.resolve();
  }

  render(bulbLocal) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    r.setClearColor(0x000000, 0);
    r.autoClear = true;
    this.camera.position.copy(bulbLocal);
    this.camera.updateMatrixWorld();
    this.camera.update(r, this.scene);
    r.autoClear = prevAuto;
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prevTarget);
  }
}

// Anything lit by the glow as a plain diffuse receiver.
function createReceiverMaterial({ wrap = 0, ...params } = {}) {
  return new PipelineMaterial({
    ...params,
    uniforms: { ...lampUniforms, lampWrap: { value: wrap }, ...(params.uniforms ?? {}) },
    fragmentPars: lampChunk() + "uniform float lampWrap;" + (params.fragmentPars ?? ""),
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_COLOR
  s.emissive += lampDiffuse(vWorldPosition, normalize(s.normal), s.albedo, lampWrap);
#endif
}
`,
  });
}

function createBulbMaterial() {
  return new PipelineMaterial({
    color: 0xfff4e6,
    roughness: 0.55,
    uniforms: { bulbGlow: { value: new Color(0, 0, 0) } },
    fragmentPars: "uniform vec3 bulbGlow;",
    surface: /* glsl */ `
void surface(inout Surface s) {
  // Opal globe: an even glow that fades softly toward its rim.
  vec3 V = normalize(cameraPosition - vWorldPosition);
  float f = clamp(dot(normalize(s.normal), V), 0.0, 1.0);
  s.emissive += bulbGlow * (0.25 + 0.75 * sqrt(f));
}
`,
  });
}

export { PALETTES, FINISHES, lampUniforms, lampConfig, shellShared, createShellMaterial, createReceiverMaterial, createBulbMaterial, LampShadow };
