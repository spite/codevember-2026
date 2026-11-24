import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  Scene,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  Matrix4,
  Vector2,
  Vector3,
  Color,
  Data3DTexture,
  UnsignedByteType,
  RepeatWrapping,
} from "three";
import { MORPH_GLSL } from "./lava.js";

const QUAD_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// A shaft of light falling on the rock from the key's direction, seen through drifting smoke. Marched at half
// resolution in the rock's frame: the smoke is 3D noise, and the rock (its distance field, morphs included)
// shadows the shaft below it.
const SHAFT_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform mat4 uInvModel;
uniform vec3 uLightWorld;
uniform vec3 uCentre;
uniform float uRadius;
uniform float uVolumeR;
uniform float uTime;
uniform int uSteps;
uniform int uShadowSteps;
#ifdef SIM
uniform sampler2D tCarry;
const float LAVA_SMOKE = 0.35;
const float WISP_HAZE = 0.006;
const float WISP_DENSITY = 0.55;
const float WARM_NEAR = 3.0;
const float PUFF_GAIN = 1.0;
const float PUFF_DENSITY = 0.75;
const float EMBER_GAIN = 3.0;
uniform float uFrame;
uniform float uMolten;
// Panel: room billows, wisps and plumes' puffs; overall density; lava and ember light on the smoke
uniform float uRoom;
uniform float uWisps;
uniform float uPlumes;
uniform float uDensity;
uniform float uLavaLight;
uniform float uEmberLight;
uniform highp sampler3D uEmbers;
SIM_CHUNK
#else
uniform highp sampler3D uSmoke;
#endif

${MORPH_GLSL}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Billowing smoke from a baked tileable 3D noise (makeSmokeTexture): a large, slowly rising billow and finer wisps
vec3 smokeRise() {
  return vec3(0.01, uTime * 0.035, 0.006 * uTime);
}

float smokeBillow(vec3 p) {
  return smoothstep(0.40, 0.70, texture(uSmoke, p * 0.16 - smokeRise()).r);
}

// Billows carrying thin curling sheets where the warped finer noise crosses its middle, so the smoke reads as wisps
float smoke(vec3 p) {
  vec3 rise = smokeRise();
  vec4 big = texture(uSmoke, p * 0.16 - rise);
  vec4 fine = texture(uSmoke, p * 0.47 - rise * 2.3 + (big.bag - 0.5) * 0.35);
  // Billows with their edges eaten away by the finer noise, so puffs have soft, torn rims and dense cores
  float base = smoothstep(0.36, 0.66, big.r - (1.0 - fine.g) * 0.18);
  return base * base;
}

#ifdef SIM
// How much of the sim to use at grid point g: none near the box's walls. Its carried field (fumes.js) holds how far
// the flow has moved the room's smoke (xyz) and the lava's smoke (w)
float simWeight(vec3 g) {
  vec3 e = min(g, GRID - g);
  return smoothstep(0.5, 4.0, min(min(e.x, e.y), e.z));
}

// As smoke(): the room's smoke where the flow has carried it (scaled by envelope), plus the lava's as thin wisps and
// thick puffs. c: its coordinate, e: the lava's smoke. Returns the room's billows only.
float simSmoke(vec3 p, float envelope, out vec3 c, out float e, out float wisp, out float puff) {
  vec3 g = (p - LO) / H;
  float w = simWeight(g);
  vec3 offset = vec3(0.0);
  e = 0.0;
  if (w > 0.0) {
    vec4 carried = sampleGrid(tCarry, g) * w;
    offset = carried.xyz;
    e = carried.w;
  }
  c = smokeCoord(p, offset);
  vec4 big = texture(uSmoke, c);
  // Warped more sideways than the static noise, so a steady updraft can't comb it into straight strands
  vec4 fine = texture(uSmoke, c * (0.47 / 0.16) + vec3(0.0, uTime * 0.0226, 0.0) + (big.bag - 0.5) * vec3(0.7, 0.35, 0.7));
  float base = smoothstep(0.36, 0.66, big.r - (1.0 - fine.g) * 0.18);
  float dens = base * base * envelope * uRoom;
  wisp = 0.0;
  puff = 0.0;
  if (e > 0.01) {
    // Curling sheets where the fine noise crosses its middle; wider and denser where there is more
    float k = 2.0 * (1.0 - exp(-0.8 * e));
    float sheet = 1.0 - smoothstep(0.0, 0.06 + 0.04 * k, abs(fine.g - 0.5));
    wisp = k * (WISP_HAZE + sheet) * WISP_DENSITY * uWisps;
    if (uPlumes > 0.0) {
      // Puffs: the sim's density eroded by billow noise and finer detail, read where the flow has moved them, so they
      // have dense cores, torn rolling rims and clear air between
      vec3 pc = plumeCoord(p, offset);
      vec4 pb = texture(uSmoke, pc);
      vec4 pf = texture(uSmoke, pc * (0.47 / 0.16) + vec3(0.0, uTime * 0.0226, 0.0) + (pb.bag - 0.5) * vec3(0.7, 0.35, 0.7));
      float det = texture(uSmoke, pc * 5.0 + (pf.ba - 0.5).xyx * 0.2).g;
      float n = pb.r * 0.4 + pf.g * 0.3 + det * 0.3;
      float kp = 1.0 - exp(-PUFF_GAIN * e);
      puff = smoothstep(0.0, 1.2 * H, kp * 1.4 - (1.0 - n) * 2.4 + 0.95) * smoothstep(0.0, 0.08, kp) * PUFF_DENSITY * uPlumes;
    }
  }
  return dens;
}


// The billow toward dir, plus the lava's smoke e taken as the same there
float simBillow(vec3 c, float e, vec3 dir) {
  return smoothstep(0.40, 0.70, texture(uSmoke, c + dir * (0.45 * 0.16)).r + min(e, 2.0) * LAVA_SMOKE);
}
#endif

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vn = uInvProj * vec4(ndc, -1.0, 1.0);
  vec4 vf = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = (uInvView * vec4(vn.xyz / vn.w, 1.0)).xyz;
  vec3 rd = normalize((uInvView * vec4(vf.xyz / vf.w, 1.0)).xyz - ro);

  // Scene depth along the ray
  float tScene = 1e9;
  float d = texture(uDepth, vUv).r;
  if (d < 0.9999) {
    vec4 v = uInvProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
    tScene = length(v.xyz / v.w);
  }

  // Smoke fills the air around the rock (a sphere of radius uVolumeR, thicker above it as it rises); the shaft
  // lights it from above, shadowed by the rock, and the lava lights it from below
  vec3 L = uLightWorld;
  vec3 oc = ro - uCentre;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uVolumeR * uVolumeR;
  float disc = b * b - c;
  if (disc <= 0.0) { outColor = vec4(0.0, 0.0, 1.0, 1.0); return; }
  float sq = sqrt(disc);
  float t0 = max(-b - sq, 0.0);
  float t1 = min(-b + sq, min(tScene, 30.0));
  if (t1 <= t0) { outColor = vec4(0.0, 0.0, 1.0, 1.0); return; }

  // Steps bunched around the ray's closest approach to the rock (t = tc + a tan(theta), theta even), sparse far out
  const float A = 1.8;
  float tc = -b;
  float th0 = atan((t0 - tc) / A);
  float dth = (atan((t1 - tc) / A) - th0) / float(uSteps);
#ifdef SIM
  // Interleaved gradient noise, shifted each frame for the temporal resolve
  vec2 jp = gl_FragCoord.xy + 5.588238 * uFrame;
  float jitter = fract(52.9829189 * fract(dot(jp, vec2(0.06711056, 0.00583715))));
  float tSum = 0.0, wSum = 0.0;
#else
  float jitter = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
#endif
  float acc = 0.0;
  float warmAcc = 0.0;
  float trans = 1.0;
  vec3 lL = normalize((uInvModel * vec4(L, 0.0)).xyz);
  for (int i = 0; i < uSteps; i++) {
    float th = th0 + (float(i) + jitter) * dth;
    float ct = cos(th);
    float t = tc + A * tan(th);
    float stepLen = A * dth / (ct * ct);
    vec3 p = ro + rd * t;
    vec3 q = p - uCentre;
    float dist = length(q);
    float envelope = (1.0 - smoothstep(uVolumeR * 0.45, uVolumeR, dist)) * mix(0.35, 1.0, smoothstep(-1.5, 1.5, q.y));
#ifdef SIM
    if (envelope < 0.002 && dist > 2.5) continue;
    vec3 sc;
    float lavaSmoke, wisp, puff;
    float dens = simSmoke(p, envelope, sc, lavaSmoke, wisp, puff) + wisp + puff;
#else
    if (envelope < 0.002) continue;
    float dens = smoke(p) * envelope;
#endif
    if (dens < 0.004) continue;
    float along = dot(q, L);
    float r = length(q - L * along);
    float beam = (1.0 - smoothstep(uRadius * 0.5, uRadius * 1.05, r)) * smoothstep(-6.0, -1.0, along);
    // Shadow from the rock toward the light, only where the shaft reaches
    vec3 lp = (uInvModel * vec4(p, 1.0)).xyz;
    float lit = beam;
    float near = morphFieldFast(lp);
#ifdef SIM
    // None inside the rock or the liquid, and nothing behind the liquid (it isn't in the depth buffer)
    if (near < -0.08) break;
    // Wisps thicker where they leave the surface, so the ones over the rock's face show too
    float room = dens - puff + wisp * 1.5 * exp(-max(near, 0.0) * 5.0);
    // Puffs fresh off the lava are hot and clear and thicken as they cool; molten, it smokes thinly near the liquid
    puff *= (1.0 - 0.7 * (1.0 - smoothstep(0.0, 0.4, near))) * mix(1.0, smoothstep(0.1, 1.1, near), 0.85 * uMolten);
    dens = (room + puff) * smoothstep(-0.06, 0.02, near) * uDensity;
    // How much of it is puffs, which are lit as their own
    float pf = puff / max(room + puff, 1e-4);
#endif
    if (beam > 0.01) {
      float s = 0.08;
      float tc = max(-dot(lp, lL), s);
      int shadowSteps = length(lp + lL * tc) > uFieldClear ? 0 : uShadowSteps;
      for (int k = 0; k < shadowSteps; k++) {
        float sd = morphFieldFast(lp + lL * s);
        lit = min(lit, beam * smoothstep(-0.02, 0.18, sd));
        s += max(sd, 0.12);
        if (s > 4.0 || lit < 0.01) break;
      }
    }
    // Self-shadowing: puffs are lit on the side toward each light and dark in their cores
    vec3 toRock = normalize(-q);
#ifdef SIM
    float towardShaft = exp(-simBillow(sc, lavaSmoke, L) * 2.8);
    float towardLava = exp(-simBillow(sc, lavaSmoke, toRock) * 2.4);
#else
    float towardShaft = exp(-smokeBillow(p + L * 0.45) * 2.8);
    float towardLava = exp(-smokeBillow(p + toRock * 0.45) * 2.4);
#endif
    float sigma = dens * 5.0;
    acc += trans * sigma * (lit * (0.15 + 0.85 * towardShaft) + 0.035) * stepLen;
#ifdef SIM
    // The lava lights the smoke close to it strongly, its own smoke most
    float closeness = exp(-max(near, 0.0) * mix(2.4, 3.2, pf));
    warmAcc += trans * sigma * (0.3 + 0.7 * towardLava) * (closeness * mix(WARM_NEAR, 1.6, pf) * (1.0 + min(lavaSmoke, 1.5)) + exp(-max(near, 0.0) * 1.0) * 0.2) * stepLen * uLavaLight;
    float wt = trans * (1.0 - exp(-sigma * stepLen * 0.7));
    tSum += t * wt;
    wSum += wt;
#else
    warmAcc += trans * sigma * towardLava * exp(-max(near, 0.0) * 1.6) * stepLen;
#endif
    trans *= exp(-sigma * stepLen * 0.7);
    if (trans < 0.02) break;
  }
#ifdef SIM
  // Where the smoke mostly is along the ray, for reprojecting it
  float tMean = wSum > 1e-3 ? tSum / wSum : clamp(tc, t0, t1);
  // Embers light the smoke around them (their glow splatted into a grid, see emberLight.js), read once where the smoke
  // mostly is and scaled by how much of it there is: orange, so a little white too
  if (uEmberLight > 0.0 && trans < 0.98) {
    float ember = texture(uEmbers, (ro + rd * tMean - LO) / (GRID * H)).r * EMBER_GAIN * uEmberLight * (1.0 - trans);
    warmAcc += ember;
    acc += ember * 0.04;
  }
  outColor = vec4(acc, warmAcc, trans, tMean);
#else
  outColor = vec4(acc, warmAcc, trans, 1.0);
#endif
}
`;

// Temporal resolve of the half-res march: last frame's result, reprojected at the smoke's depth and clamped to this
// frame's neighbourhood, blended with this frame's
const RESOLVE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform mat4 uPrevViewProj;
uniform float uBlend;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(uCur, 0) - 1;
  vec4 cur = texelFetch(uCur, px, 0);
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 v = texelFetch(uCur, clamp(px + ivec2(i, j), ivec2(0), hi), 0).rgb;
    m1 += v;
    m2 += v * v;
  }
  m1 /= 9.0;
  vec3 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vn = uInvProj * vec4(ndc, -1.0, 1.0);
  vec4 vf = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = (uInvView * vec4(vn.xyz / vn.w, 1.0)).xyz;
  vec3 rd = normalize((uInvView * vec4(vf.xyz / vf.w, 1.0)).xyz - ro);
  vec4 clip = uPrevViewProj * vec4(ro + rd * cur.a, 1.0);
  vec2 prev = clip.xy / clip.w * 0.5 + 0.5;
  float a = uBlend;
  if (clip.w <= 0.0 || any(lessThan(prev, vec2(0.0))) || any(greaterThan(prev, vec2(1.0)))) a = 1.0;
  vec3 h = clamp(texture(uHist, prev).rgb, m1 - sd * 1.25, m1 + sd * 1.25);
  outColor = vec4(mix(h, cur.rgb, a), cur.a);
}
`;

const COMPOSITE_FS = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D uHdr;
uniform sampler2D uShaft;
uniform vec2 uTexel;
uniform vec3 uColor;
uniform vec3 uWarm;
uniform float uStrength;
void main() {
  vec2 t = uTexel;
  vec3 s = texture(uShaft, vUv).rgb * 0.4
    + (texture(uShaft, vUv + vec2(t.x, t.y)).rgb + texture(uShaft, vUv + vec2(-t.x, t.y)).rgb
     + texture(uShaft, vUv + vec2(t.x, -t.y)).rgb + texture(uShaft, vUv + vec2(-t.x, -t.y)).rgb) * 0.15;
  vec4 base = texture(uHdr, vUv);
  // The smoke veils what is behind it (b: its transmittance), then adds its light
  base.rgb *= mix(1.0, s.z, 0.5 * min(uStrength * 2.0, 1.0));
  outColor = vec4(base.rgb + (uColor * s.x + uWarm * s.y) * uStrength, base.a);
}
`;

// A 64³ tileable noise: R a warped 4-octave fbm (the billows), G a finer one, BA the warp (to offset the detail)
function makeSmokeTexture(n = 64) {
  const lattice = (period, seed) => {
    const v = new Float32Array(period ** 3);
    let s = seed;
    for (let i = 0; i < v.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      v[i] = s / 4294967296;
    }
    return (x, y, z) => {
      const fx = x * period, fy = y * period, fz = z * period;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const tx = fx - ix, ty = fy - iy, tz = fz - iz;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), sz = tz * tz * (3 - 2 * tz);
      const at = (a, b, c) => v[((((c % period) + period) % period) * period + (((b % period) + period) % period)) * period + (((a % period) + period) % period)];
      const l = (a, b, t) => a + (b - a) * t;
      return l(
        l(l(at(ix, iy, iz), at(ix + 1, iy, iz), sx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), sx), sy),
        l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), sx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), sx), sy),
        sz,
      );
    };
  };
  const octaves = [4, 8, 16, 32].map((p, i) => lattice(p, 17 + i * 31));
  const fine = [8, 16, 32].map((p, i) => lattice(p, 101 + i * 13));
  const warpA = lattice(4, 7), warpB = lattice(4, 9);
  const fbm = (fns, x, y, z) => {
    let a = 0.5, s = 0, w = 0;
    for (const f of fns) {
      s += a * f(x, y, z);
      w += a;
      a *= 0.5;
    }
    return s / w;
  };
  const data = new Uint8Array(n * n * n * 4);
  for (let k = 0, i = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let h = 0; h < n; h++, i += 4) {
        const x = h / n, y = j / n, z = k / n;
        const wa = warpA(x, y, z) - 0.5, wb = warpB(x, y, z) - 0.5;
        const r = fbm(octaves, x + wa * 0.25, y + wb * 0.25, z - wa * 0.2);
        const g = fbm(fine, x - wb * 0.15, y + wa * 0.15, z);
        data[i] = Math.round(r * 255);
        data[i + 1] = Math.round(g * 255);
        data[i + 2] = Math.round((wa + 0.5) * 255);
        data[i + 3] = Math.round((wb + 0.5) * 255);
      }
    }
  }
  const texture = new Data3DTexture(data, n, n, n);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function makePass(fragmentShader, uniforms) {
  return new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

class LightShaft {
  // smoke: a RockSmoke (fumes.js) to march instead of the static noise, or null
  constructor(renderer, morphUniforms, noiseTexture, smoke = null) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.scene.add(this.quad);
    const opts = { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, colorSpace: NoColorSpace, depthBuffer: false };
    this.shaftRT = new WebGLRenderTarget(4, 4, opts);
    this.outRT = new WebGLRenderTarget(4, 4, opts);
    // With the sim: the march goes to shaftRT and resolves into these (ping-pong)
    this.histRTs = smoke ? [new WebGLRenderTarget(4, 4, opts), new WebGLRenderTarget(4, 4, opts)] : null;
    this._prevViewProj = new Matrix4();
    this._hasHist = false;
    this._out = this.shaftRT.texture;
    this._invModel = new Matrix4();
    const smokeTexture = makeSmokeTexture();
    if (smoke) smoke.shared.uSmoke.value = smokeTexture;
    this.shaftMat = makePass(smoke ? "#define SIM\n" + SHAFT_FS.replace("SIM_CHUNK", () => smoke.chunk) : SHAFT_FS, {
      ...(smoke ? smoke.marchUniforms : {}),
      ...morphUniforms,
      uDepth: { value: null },
      uNoise: { value: noiseTexture },
      uInvProj: { value: new Matrix4() },
      uInvView: { value: new Matrix4() },
      uInvModel: { value: this._invModel },
      uLightWorld: { value: new Vector3(0, 1, 0) },
      uCentre: { value: new Vector3() },
      uRadius: { value: 1.5 },
      uVolumeR: { value: 4.5 },
      uTime: { value: 0 },
      uSteps: { value: smoke ? 14 : 28 },
      uFrame: { value: 0 },
      uMolten: { value: 0 },
      uRoom: { value: 1 },
      uWisps: { value: 1 },
      uPlumes: { value: 0 },
      uDensity: { value: 1 },
      uLavaLight: { value: 1 },
      uEmberLight: { value: 0 },
      uEmbers: { value: null },
      uShadowSteps: { value: 6 },
      uSmoke: smoke ? smoke.shared.uSmoke : { value: smokeTexture },
    });
    this.compositeMat = makePass(COMPOSITE_FS, {
      uHdr: { value: null },
      uShaft: { value: this.shaftRT.texture },
      uTexel: { value: new Vector2() },
      uColor: { value: new Color(0.64, 0.66, 0.71) },
      uWarm: { value: new Color(0.22, 0.04, 0.003) },
      uStrength: { value: 0.1 },
    });
    this.resolveMat = makePass(RESOLVE_FS, {
      uCur: { value: this.shaftRT.texture },
      uHist: { value: null },
      uInvProj: { value: new Matrix4() },
      uInvView: { value: new Matrix4() },
      uPrevViewProj: { value: this._prevViewProj },
      uBlend: { value: 0.2 },
    });
  }

  // The panel's smoke look (see the SIM uniforms); embers: the ember light's 3D texture (emberLight.js)
  setLook({ room = 1, wisps = 1, plumes = 0, density = 1, lavaLight = 1, emberLight = 0, embers = null }) {
    const u = this.shaftMat.uniforms;
    if (!u.uRoom) return;
    u.uRoom.value = room;
    u.uWisps.value = wisps;
    u.uPlumes.value = plumes;
    u.uDensity.value = density;
    u.uLavaLight.value = lavaLight;
    u.uEmberLight.value = embers ? emberLight : 0;
    u.uEmbers.value = embers;
  }

  _run(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  // Marches the shaft only and returns what a composite needs to add it (see VolumetricLavaGlow), or null
  march(ctx, opts) {
    if (opts.strength <= 0.001 || !ctx.depthTexture) return null;
    const prev = this.renderer.getRenderTarget();
    this._march(ctx, opts);
    this.renderer.setRenderTarget(prev);
    const c = this.compositeMat.uniforms;
    return { texture: this._out, texel: c.uTexel.value, color: c.uColor.value, warm: c.uWarm.value, strength: opts.strength };
  }

  _march({ depthTexture, camera, width, height }, { mesh, lightDirection, time, molten = 0 }) {
    const hw = Math.max(1, Math.floor(width / 2)), hh = Math.max(1, Math.floor(height / 2));
    if (this.shaftRT.width !== hw || this.shaftRT.height !== hh) this.shaftRT.setSize(hw, hh);
    mesh.updateMatrixWorld();
    this._invModel.copy(mesh.matrixWorld).invert();
    const u = this.shaftMat.uniforms;
    u.uDepth.value = depthTexture;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uLightWorld.value.copy(lightDirection).normalize();
    mesh.getWorldPosition(u.uCentre.value);
    u.uTime.value = time;
    if (u.uMolten) u.uMolten.value = molten;
    this.compositeMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this._run(this.shaftMat, this.shaftRT);
    this._resolve(camera, hw, hh);
  }

  _resolve(camera, hw, hh) {
    this._out = this.shaftRT.texture;
    if (!this.histRTs) return;
    this.shaftMat.uniforms.uFrame.value = (this.shaftMat.uniforms.uFrame.value + 1) % 64;
    const [prev, next] = this.histRTs;
    if (next.width !== hw || next.height !== hh) {
      prev.setSize(hw, hh);
      next.setSize(hw, hh);
      this._hasHist = false;
    }
    const r = this.resolveMat.uniforms;
    r.uInvProj.value.copy(camera.projectionMatrixInverse);
    r.uInvView.value.copy(camera.matrixWorld);
    r.uHist.value = prev.texture;
    r.uBlend.value = this._hasHist ? 0.2 : 1;
    this._run(this.resolveMat, next);
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._hasHist = true;
    this.histRTs.reverse();
    this._out = next.texture;
  }

  apply(hdr, { depthTexture, camera, width, height }, { mesh, strength, lightDirection, time, molten = 0 }) {
    if (strength <= 0.001 || !depthTexture) return hdr;
    const hw = Math.max(1, Math.floor(width / 2)), hh = Math.max(1, Math.floor(height / 2));
    if (this.shaftRT.width !== hw || this.shaftRT.height !== hh) this.shaftRT.setSize(hw, hh);
    if (this.outRT.width !== width || this.outRT.height !== height) this.outRT.setSize(width, height);
    mesh.updateMatrixWorld();
    this._invModel.copy(mesh.matrixWorld).invert();
    const u = this.shaftMat.uniforms;
    u.uDepth.value = depthTexture;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uLightWorld.value.copy(lightDirection).normalize();
    mesh.getWorldPosition(u.uCentre.value);
    u.uTime.value = time;
    if (u.uMolten) u.uMolten.value = molten;
    const prev = this.renderer.getRenderTarget();
    this._run(this.shaftMat, this.shaftRT);
    this._resolve(camera, hw, hh);
    const c = this.compositeMat.uniforms;
    c.uShaft.value = this._out;
    c.uHdr.value = hdr;
    c.uTexel.value.set(1 / hw, 1 / hh);
    c.uStrength.value = strength;
    this._run(this.compositeMat, this.outRT);
    this.renderer.setRenderTarget(prev);
    return this.outRT.texture;
  }
}

export { LightShaft };
