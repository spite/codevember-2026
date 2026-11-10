import {
  WebGLRenderTarget, RawShaderMaterial, GLSL3, Mesh, Scene, OrthographicCamera, BufferGeometry, Float32BufferAttribute, HalfFloatType, LinearFilter,
  NearestFilter, NoColorSpace, Matrix4, Matrix3, Vector2, Vector3, Vector4, Color, MathUtils, DoubleSide, CustomBlending, OneFactor, AddEquation,
} from "three";
import { fullscreenVertex, copyFragment } from "shaders/pipeline/copy.js";
import { brdf } from "shaders/pipeline/brdf.js";
import { shGLSL } from "modules/pipeline/studio.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { containerGLSL } from "./container.js";

// The soft bodies and the volume are drawn over the lit frame (the floor and the floaters):
// 1. the bodies' nearest surface (normal, distance) and, additively, their thickness along each pixel's ray, signed by
//    facing and clipped at the opaque depth, weighted by each body's absorption and scattering;
// 2. the jelly over the frame: what's behind is absorbed and blurred by the jelly it crosses;
// 3. the volume, sphere-traced from its field: refraction (split per channel at the edges), then the jelly image
//    behind, blurred and hazed by the resin it crosses.
// Blur comes from a Gaussian pyramid of each image.

const bodyVertex = /* glsl */ `
in vec3 position;
in vec3 normal;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vWorld = position;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const lightVertex = /* glsl */ `
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorld;
void main() {
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const frontFragment = /* glsl */ `
precision highp float;
uniform vec3 cameraPos;
in vec3 vWorld;
in vec3 vNormal;
out vec4 outColor;
void main() {
  outColor = vec4(normalize(vNormal), distance(vWorld, cameraPos));
}
`;

const thickFragment = /* glsl */ `
precision highp float;
uniform vec3 cameraPos;
uniform sampler2D tDepth;
uniform mat4 inverseProjection;
uniform vec2 size;
uniform float refDist;
uniform vec3 sigma;
in vec3 vWorld;
out vec4 outAbsorb;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  float z = texture(tDepth, uv).r;
  vec4 v = inverseProjection * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  float sceneDist = length(v.xyz / v.w);
  float d = min(distance(vWorld, cameraPos), sceneDist) - refDist;
  float s = gl_FrontFacing ? -d : d;
  outAbsorb = vec4(sigma * s, s);
}
`;

// Optical depth of the jelly along the key light, from the light's orthographic view: front faces subtract their
// distance along the light, back faces add it, so the sum is each ray's thickness, weighted by absorption.
const lightFragment = /* glsl */ `
precision highp float;
uniform vec3 sigma;
uniform vec3 lightOrigin;
uniform vec3 lightTravel;
in vec3 vWorld;
out vec4 outAbsorb;
void main() {
  float t = dot(vWorld - lightOrigin, lightTravel);
  float s = gl_FrontFacing ? -t : t;
  outAbsorb = vec4(sigma * s, s);
}
`;

const bicubicGLSL = /* glsl */ `
// Cubic B-spline from four bilinear taps (Sigg and Hadwiger): smooth where a coarse level is magnified a lot.
vec4 bicubic(sampler2D t, vec2 uv, vec2 texel) {
  vec2 st = uv / texel - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) * texel, h1 = (i + 1.0 + w3 / g1 + 0.5) * texel;
  return g0.y * (g0.x * texture(t, vec2(h0.x, h0.y)) + g1.x * texture(t, vec2(h1.x, h0.y)))
    + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, vec2(h1.x, h1.y)));
}
`;

const common = /* glsl */ `
uniform mat4 inverseViewProjection;
uniform mat4 viewProjection;
uniform mat4 inverseProjection;
uniform vec3 cameraPos;
uniform float pixelAngle;
uniform vec2 sceneSize;

uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 shIrradiance[9];
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float lightSpecular;

#define PI 3.14159265
${brdf}
${shGLSL}

vec3 env(vec3 d, float rough) {
  return textureLod(envMap, envRotation * d, envMapMaxLod * rough * (2.0 - rough)).rgb * envIntensity;
}
vec3 project(vec3 p) {
  vec4 c = viewProjection * vec4(p, 1.0);
  return vec3(c.xy / c.w * 0.5 + 0.5, c.w);
}
vec3 rayDir(vec2 uv) {
  vec4 far = inverseViewProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(far.xyz / far.w - cameraPos);
}
float sceneDistance(sampler2D depth, vec2 uv) {
  float z = texture(depth, uv).r;
  vec4 v = inverseProjection * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return length(v.xyz / v.w);
}
${bicubicGLSL}
// Specular of a dielectric surface: environment and key light.
vec3 surfaceSpec(vec3 n, vec3 V, float rough, float f0, out float F) {
  float NdotV = clamp(dot(n, V), 1e-4, 1.0);
  rough = clamp(rough, 0.03, 1.0);
  vec2 dfg = EnvBRDFApprox(rough, NdotV);
  F = f0 * dfg.x + dfg.y;
  vec3 L = normalize(lightDirection);
  vec3 H = normalize(L + V);
  float NdotL = clamp(dot(n, L), 0.0, 1.0);
  float a = rough * rough;
  vec3 key = lightColor * NdotL * F_Schlick(clamp(dot(V, H), 0.0, 1.0), vec3(f0)) * D_GGX(clamp(dot(n, H), 0.0, 1.0), a)
    * V_SmithGGXCorrelated(a, NdotV, NdotL) * lightSpecular;
  return env(reflect(-V, n), rough) * F + key;
}
`;

// A Gaussian pyramid: level i is blurred by about 2^i pixels; Blur() picks between levels by radius.
// A Gaussian pyramid packed in one atlas: level i is blurred by about 2^i pixels; Blur() picks between levels by
// radius. One texture and no branching per level keeps the shaders small for the D3D compiler.
const pyramidGLSL = (prefix, levels = 6) => /* glsl */ `
uniform sampler2D ${prefix}0;
uniform sampler2D ${prefix}Atlas;
uniform vec4 ${prefix}Rect[${levels}];
vec4 ${prefix}Level(int i, vec2 uv) {
  if (i <= 0) return texture(${prefix}0, uv);
  vec4 r = ${prefix}Rect[i - 1];
  vec2 size = vec2(textureSize(${prefix}Atlas, 0));
  vec2 px = r.zw * size;
  uv = clamp(uv, 1.5 / px, 1.0 - 1.5 / px);
  return bicubic(${prefix}Atlas, r.xy + uv * r.zw, 1.0 / size);
}
vec4 ${prefix}Blur(vec2 uv, float radiusPx) {
  float lod = clamp(log2(max(radiusPx, 1.0)), 0.0, ${levels}.0);
  int l = int(floor(lod));
  return mix(${prefix}Level(l, uv), ${prefix}Level(min(l + 1, ${levels}), uv), fract(lod));
}
`;

const jellyFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform sampler2D tFront;
uniform float refDist;
uniform float jellyRough;
uniform float jellyFrost;
uniform float jellyGlow;
uniform float jellyMilk;
uniform float jellyRefract;
uniform float jellyDensity;
in vec2 vUv;
out vec4 outColor;
${common}
${pyramidGLSL("tScene")}
${pyramidGLSL("tAbsorb", 5)}
void main() {
  vec4 front = texture(tFront, vUv);
  float sceneDist = sceneDistance(tDepth, vUv);
  if (front.a <= 0.0) {
    outColor = vec4(texture(tScene0, vUv).rgb, sceneDist);
    return;
  }
  vec3 rd = rayDir(vUv);
  vec3 n = normalize(front.xyz);
  vec3 V = -rd;
  if (dot(n, V) < 0.02) n = normalize(n + V * (0.02 - dot(n, V)));
  vec4 ab = texture(tAbsorb0, vUv);
  float thick = max(ab.a, 0.0);
  // Refraction: what's behind is shifted by the surface's slope and a smoothed thickness (the raw one drops at every
  // floater's outline and would draw lines there). The tint is read at the same shifted point, so floaters stay
  // solid under the jelly in front of them; red and blue shift a little more and less, for dispersion.
  vec2 uv = vUv, off = vec2(0.0);
  if (jellyRefract > 0.0) {
    float smoothThick = max(tAbsorbBlur(vUv, sceneSize.y * 0.03).a, 0.0);
    off = (mat3(viewProjection) * n).xy * jellyRefract * min(smoothThick, 0.8) * 0.12;
    uv = clamp(vUv - off, 0.0, 1.0);
    ab = texture(tAbsorb0, uv);
    thick = max(ab.a, 0.0);
  }
  float behindDist = min(sceneDist, front.a + thick);
  // Light scatters inside the jelly: what's behind blurs with the depth it crosses, and so does the jelly's colour.
  float blur = jellyFrost * thick * (1.0 + jellyMilk * 0.15) / (pixelAngle * max(behindDist, 0.1));
  float r = blur * 0.6;
  if (r > 1.0) ab = tAbsorbBlur(uv, r);
  vec3 tau = max(ab.rgb, vec3(0.0));
  vec3 behind = tSceneBlur(uv, blur).rgb;
  if (jellyRefract > 0.3) {
    float split = (jellyRefract - 0.3) * 0.25;
    behind.r = tSceneBlur(clamp(vUv - off * (1.0 + split), 0.0, 1.0), blur).r;
    behind.b = tSceneBlur(clamp(vUv - off * (1.0 - split), 0.0, 1.0), blur).b;
  }

  // Scattering follows the jelly's own colour, recovered from its absorption per unit length.
  float sAmount = jellyMilk * max(ab.a, 0.0);
  vec3 sColor = ab.a > 1e-3 ? exp(-tau / max(ab.a * jellyDensity, 1e-3)) : vec3(1.0);
  float sT = exp(-sAmount);
  // In-scattered studio light, isotropic, plus the key light scattered forward (Henyey-Greenstein, g = 0.5).
  vec3 ambient = max(shIrradiance[0] * 0.282095, vec3(0.0)) * envIntensity * 3.0;
  float cosT = dot(rd, normalize(lightDirection));
  float hg = 0.75 / pow(1.25 + cosT, 1.5) * 0.0796 * 4.0;
  vec3 inscatter = sColor * (ambient + lightColor * (0.06 + hg * 0.25)) * (1.0 - sT) * 0.8;
  // Light carried through the jelly from the backdrop picks up its colour.
  vec3 glow = sColor * jellyGlow * (1.0 - sT) * max(evalSH(envRotation * -n), vec3(0.0)) * envIntensity;

  float F;
  vec3 spec = surfaceSpec(n, V, jellyRough, 0.025, F);
  vec3 through = behind * exp(-tau) * sT + inscatter * exp(-tau * 0.5) + glow;
  outColor = vec4(spec + through * (1.0 - F), front.a);
}
`;

const volumeFragment = /* glsl */ `
precision highp float;
uniform sampler2D tFirst;
uniform sampler2D tFront;
uniform mat4 containerInverse;
uniform mat3 containerRotation;
uniform vec3 containerCenter;
uniform float boundRadius;
uniform float ior;
uniform float dispersion;
uniform float surfaceRough;
uniform float frost;
uniform float haze;
uniform vec3 hazeColor;
uniform vec3 resinColor;
uniform float resinDensity;
uniform float wall;
uniform float containerShow;
uniform int shellSteps;
// A loop bound as a uniform, so ANGLE's D3D backend keeps it a loop instead of unrolling it.
uniform int marchSteps;
in vec2 vUv;
out vec4 outColor;
${common}
${containerGLSL}
${pyramidGLSL("tJelly")}

vec3 toLocal(vec3 p) { return (containerInverse * vec4(p, 1.0)).xyz; }
vec3 dirLocal(vec3 d) { return transpose(containerRotation) * d; }
vec3 normalAt(vec3 lp) {
  const float h = 0.0015;
  vec3 g = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    vec3 o = j == 0 ? vec3(1, -1, -1) : j == 1 ? vec3(-1, -1, 1) : j == 2 ? vec3(-1, 1, -1) : vec3(1, 1, 1);
    g += o * containerSDF(lp + o * h);
  }
  return normalize(g);
}

vec3 jellyAt(vec3 p, float blurWorld) {
  vec3 sp = project(p);
  return tJellyBlur(clamp(sp.xy, 0.0, 1.0), blurWorld / (pixelAngle * max(sp.z, 0.1))).rgb;
}

// Unpolarised Fresnel reflectance of a smooth dielectric interface, eta = n_from / n_to; 1 on total internal reflection.
float fresnelDielectric(float cosI, float eta) {
  cosI = clamp(cosI, 0.0, 1.0);
  float sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - sin2T);
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

// The studio's mean radiance over all directions (the key panel is not in the SH; lightColor carries it).
vec3 meanRadiance() { return max(shIrradiance[0] * 0.282095, vec3(0.0)) * envIntensity; }

// Light scattered into a ray travelling along dir: the studio, isotropically, and the key light (Henyey-Greenstein).
vec3 scatterSource(vec3 dir) {
  const float g = 0.3;
  float c = dot(dir, normalize(lightDirection));
  float hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * c, 1.5));
  return meanRadiance() + lightColor * hg;
}

// Beer-Lambert across s of resin: absorption tints, scattering dims what's behind and adds the light it scatters in.
void medium(float s, float sigmaS, vec3 dir, inout vec3 thr, inout vec3 acc) {
  vec3 sigmaA = -log(max(resinColor, vec3(1e-3))) * resinDensity * 2.0;
  vec3 sigmaT = sigmaA + sigmaS;
  vec3 tr = exp(-sigmaT * s);
  acc += thr * hazeColor * scatterSource(dir) * (sigmaS / max(sigmaT, vec3(1e-5))) * (1.0 - tr);
  thr *= tr;
}

// A hollow shell with thin walls. A ray through a thin wall leaves parallel to how it entered, so each wall only tints
// and reflects (Fresnel at each face, no bending, no light trapped inside): no marks along the inner outline, and the
// eye ray crosses the inside straight, in register with the jelly image. Where the ray grazes the wall and never
// reaches the inside, it's the rim: a long path through glass, bent, tinted and darkened.
vec4 shadeShell(vec3 P, vec3 rd, float t, vec3 n, vec3 spec, float F) {
  float first = texelFetch(tFirst, ivec2(gl_FragCoord.xy), 0).a;
  float f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  vec3 lp = toLocal(P), ld = dirLocal(rd);
  vec3 acc = spec, thr = vec3(1.0 - F);
  // Through the front wall: to the inside, or out again at the rim.
  float s = 0.002;
  bool inside = false;
  for (int i = 0; i < shellSteps; i++) {
    float d = containerSDF(lp + ld * s);
    if (d + wall < 0.0005) { inside = true; break; }
    if (d > 0.0005 && s > 0.004) break;
    s += max(min(d + wall, -d), 0.002);
  }
  if (!inside) {
    // The rim: glass all the way, bent like a lens.
    medium(s, haze * 2.0, rd, thr, acc);
    thr *= pow(max(resinColor, vec3(0.05)), vec3(s * 8.0));
    vec3 bent = refract(rd, n, 1.0 / ior);
    vec3 through = jellyAt(P + normalize(rd + (bent - rd) * 3.0) * 1.2, frost * 0.6 + 0.02);
    return vec4(acc + thr * through * (1.0 - F), 1.0);
  }
  medium(s, haze * 2.0, rd, thr, acc);
  vec3 P2 = P + rd * s;
  vec3 n2 = normalize(containerRotation * normalAt(toLocal(P2)));
  // The inner face of a thin slab reflects as much as the outer one at the same angle (no total internal reflection).
  float F2 = fresnelDielectric(abs(dot(rd, n2)), 1.0 / ior);
  acc += thr * F2 * env(reflect(rd, n2), surfaceRough);
  thr *= 1.0 - F2;
  // Across the inside, straight: the jelly, or the far wall.
  vec3 lp2 = toLocal(P2);
  float c = 0.004;
  for (int i = 0; i < shellSteps; i++) {
    float d = -(containerSDF(lp2 + ld * c) + wall);
    if (d < 0.0005) break;
    c += max(d, 0.003);
    if (c > 4.0) break;
  }
  float L = first - t - s;
  if (L < c) return vec4(acc + thr * jellyAt(P2 + rd * max(L, 0.0), frost * max(L, 0.0)), 1.0);
  // The far wall: it reflects a little of the inside back, and passes the rest, tinted, to what's behind.
  vec3 P3 = P2 + rd * c;
  vec3 n3 = normalize(containerRotation * normalAt(toLocal(P3)));
  float cosB = abs(dot(rd, n3));
  float F3 = fresnelDielectric(cosB, 1.0 / ior);
  acc += thr * F3 * jellyAt(P3 + reflect(rd, n3) * max(c, 0.3), frost * c + 0.01);
  thr *= (1.0 - F3) * (1.0 - F3);
  medium(wall / max(cosB, 0.15), haze * 2.0, rd, thr, acc);
  return vec4(acc + thr * jellyAt(P3 + rd * 1.2, frost * c + 0.01), 1.0);
}

vec4 shade(vec3 ro, vec3 rd, float t) {
  vec3 P = ro + rd * t;
  vec3 lp = toLocal(P);
  vec3 nl = normalAt(lp);
  vec3 n = normalize(containerRotation * nl);
  vec3 V = -rd;
  if (dot(n, V) < 0.02) n = normalize(n + V * (0.02 - dot(n, V)));
  float F;
  vec3 spec = surfaceSpec(n, V, surfaceRough, pow((ior - 1.0) / (ior + 1.0), 2.0), F);
  return shadeShell(P, rd, t, n, spec, F);
}

vec2 sphereHit(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd), cc = dot(oc, oc) - r * r;
  float h = b * b - cc;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

void main() {
  vec3 ro = cameraPos;
  vec3 rd = rayDir(vUv);
  vec3 base = texture(tJelly0, vUv).rgb;
  // Alpha is the distance to what turns with the container (its surface, or the jelly where it's hidden), 0 for the
  // backdrop: the motion blur works out each pixel's motion there.
  float jelly = texture(tFront, vUv).a;
  if (containerShow <= 0.001) { outColor = vec4(base, jelly); return; }
  vec2 sh = sphereHit(ro, rd, containerCenter, boundRadius);
  if (sh.y < 0.0) { outColor = vec4(base, jelly); return; }
  float t = max(sh.x, 0.0);
  vec3 lro = toLocal(ro), lrd = dirLocal(rd);
  float best = 1e9, tBest = t;
  bool hit = false;
  for (int i = 0; i < marchSteps; i++) {
    float d = containerSDF(lro + lrd * t);
    float fp = pixelAngle * t;
    float r = d / fp;
    if (r < best) { best = r; tBest = t; }
    if (d < 0.25 * fp) { hit = true; break; }
    t += max(d, 0.3 * fp);
    if (t > sh.y) break;
  }
  // One call site, so the shading is compiled once: a hit, or the near miss that antialiases the silhouette.
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.25, 1.2, best);
  if (cover <= 0.0) { outColor = vec4(base, jelly); return; }
  outColor = vec4(mix(base, shade(ro, rd, hit ? t : tBest).rgb, cover * containerShow), cover * containerShow > 0.5 ? (hit ? t : tBest) : jelly);
}
`;

// Motion blur of everything turning with the container: each pixel's velocity is the container's spin at the depth
// of its centre, and the image is gathered along it over the shutter. Moving pixels average their path; the backdrop
// takes in what sweeps across it, so silhouettes smear outward.
const motionFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform vec3 omega;
uniform vec3 center;
uniform float shutter;
uniform float reach;
uniform mat4 viewProjection;
uniform mat4 inverseViewProjection;
uniform vec3 cameraPos;
uniform vec2 sceneSize;
in vec2 vUv;
out vec4 outColor;
vec2 project(vec3 p) {
  vec4 c = viewProjection * vec4(p, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}
void main() {
  vec4 c = texture(tColor, vUv);
  vec4 far = inverseViewProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(far.xyz / far.w - cameraPos);
  vec3 fwd = normalize(center - cameraPos);
  // On the moving surface where there is one; over the backdrop, the near half of the container, where most of what
  // sweeps across it is.
  float d = c.a > 0.0 ? c.a : (dot(center - cameraPos, fwd) - reach * 0.4) / dot(rd, fwd);
  vec3 P = cameraPos + rd * d;
  vec3 vel = cross(omega, P - center) * shutter;
  vec2 a = project(P - vel * 0.5), b = project(P + vel * 0.5);
  if (length(P - center) > reach * 1.2 || length((b - a) * sceneSize) < 1.0) { outColor = vec4(c.rgb, 1.0); return; }
  vec3 all_ = vec3(0.0), moving = vec3(0.0);
  float cover = 0.0;
  for (int i = 0; i < 9; i++) {
    vec4 s = texture(tColor, mix(a, b, (float(i) + 0.5) / 9.0));
    float m = s.a > 0.0 ? 1.0 : 0.0;
    all_ += s.rgb;
    moving += s.rgb * m;
    cover += m;
  }
  vec3 col = c.a > 0.0 ? all_ / 9.0 : mix(c.rgb, moving / max(cover, 1e-4), cover / 9.0);
  outColor = vec4(col, 1.0);
}
`;

// 13-tap downsample (Jimenez).
const downFragment = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 texel;
in vec2 vUv;
out vec4 outColor;
vec4 s(vec2 o) { return texture(tSource, vUv + o * texel); }
void main() {
  vec4 c = s(vec2(0.0)) * 0.125;
  c += (s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1))) * 0.125;
  c += (s(vec2(-2, -2)) + s(vec2(2, -2)) + s(vec2(-2, 2)) + s(vec2(2, 2))) * 0.03125;
  c += (s(vec2(0, -2)) + s(vec2(0, 2)) + s(vec2(-2, 0)) + s(vec2(2, 0))) * 0.0625;
  outColor = c;
}
`;

function fullscreen(material) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  return scene;
}

const rt = (opts = {}) =>
  new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace, ...opts });

const copyScene = fullscreen(new RawShaderMaterial({
  glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: copyFragment,
  uniforms: { tInput: { value: null }, weight: { value: 1 } }, depthTest: false, depthWrite: false,
}));
const copyCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

// Built level by level (each from the one above), then copied into one atlas for sampling.
class Pyramid {
  constructor(levels = 6) {
    this.levels = Array.from({ length: levels }, () => rt());
    this.atlas = rt();
    this.rects = Array.from({ length: levels }, () => new Vector4());
    this.pixels = [];
    this.cleared = false;
  }
  setSize(w, h) {
    const pad = 4;
    const sizes = this.levels.map((t, i) => [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))]);
    this.levels.forEach((t, i) => t.setSize(...sizes[i]));
    // Level 1 on the left, the rest stacked in a column to its right.
    const col = pad + sizes[0][0] + pad;
    let y = pad;
    this.pixels = sizes.map(([lw, lh], i) => {
      if (i === 0) return [pad, pad, lw, lh];
      const r = [col, y, lw, lh];
      y += lh + pad;
      return r;
    });
    const aw = col + (sizes[1]?.[0] ?? 0) + pad, ah = Math.max(pad + sizes[0][1] + pad, y);
    this.atlas.setSize(aw, ah);
    this.pixels.forEach(([x, py, lw, lh], i) => this.rects[i].set(x / aw, py / ah, lw / aw, lh / ah));
    this.cleared = false;
  }
  build(renderer, pass, source, sw, sh) {
    let tex = source, w = sw, h = sh;
    for (const t of this.levels) {
      pass.uniforms.tSource.value = tex;
      pass.uniforms.texel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(t);
      renderer.render(pass.scene, pass.camera);
      tex = t.texture;
      w = t.width;
      h = t.height;
    }
    const atlas = this.atlas;
    if (!this.cleared) {
      atlas.viewport.set(0, 0, atlas.width, atlas.height);
      renderer.setRenderTarget(atlas);
      renderer.clear(true, false, false);
      this.cleared = true;
    }
    const u = copyScene.children[0].material.uniforms;
    this.levels.forEach((t, i) => {
      atlas.viewport.set(...this.pixels[i]);
      u.tInput.value = t.texture;
      renderer.setRenderTarget(atlas);
      renderer.render(copyScene, copyCamera);
    });
    atlas.viewport.set(0, 0, atlas.width, atlas.height);
  }
  bind(uniforms, prefix, base) {
    uniforms[`${prefix}0`] = { value: base };
    uniforms[`${prefix}Atlas`] = { value: this.atlas.texture };
    uniforms[`${prefix}Rect`] = { value: this.rects };
  }
}

class VolumePass {
  constructor({ steps = 72, lightSize = 512 } = {}) {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.front = rt({ minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true });
    this.thick = rt();
    this.jelly = rt();
    this.output = rt();
    this.blurred = rt();
    this.motion = {
      tColor: { value: this.output.texture },
      omega: { value: new Vector3() },
      center: { value: new Vector3() },
      shutter: { value: 0 },
      reach: { value: 2.2 },
    };
    this.scenePyr = new Pyramid();
    this.jellyPyr = new Pyramid();
    this.absorbPyr = new Pyramid(5);
    // The jelly's absorption seen from the key light, for coloured shadows.
    this.lightMap = rt({ depthBuffer: false });
    this.lightMap.setSize(lightSize, lightSize);
    this.lightT = rt({ depthBuffer: false });
    this.lightT.setSize(lightSize, lightSize);
    this.lightPyr = new Pyramid(5);
    this.lightPyr.setSize(lightSize, lightSize);
    this.lightCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    this.lightScene = new Scene();
    this.lightUniforms = { lightOrigin: { value: new Vector3() }, lightTravel: { value: new Vector3(0, -1, 0) } };
    // Light-space projection and the map's half extent (world units), for receivers.
    this.lightViewProjection = new Matrix4();
    this.lightExtent = 1.9;

    this.view = {
      inverseViewProjection: { value: new Matrix4() },
      viewProjection: { value: new Matrix4() },
      inverseProjection: { value: new Matrix4() },
      cameraPos: { value: new Vector3() },
      pixelAngle: { value: 0.001 },
      sceneSize: { value: new Vector2(1, 1) },
      envMap: globalUniforms.envMap,
      envMapMaxLod: globalUniforms.envMapMaxLod,
      envIntensity: globalUniforms.envIntensity,
      envRotation: globalUniforms.envRotation,
      shIrradiance: globalUniforms.shIrradiance,
      lightDirection: globalUniforms.lightDirection,
      lightColor: globalUniforms.lightColor,
      lightSpecular: globalUniforms.lightSpecular,
    };
    this.bodyUniforms = {
      viewMatrix: { value: new Matrix4() },
      projectionMatrix: { value: new Matrix4() },
      cameraPos: this.view.cameraPos,
      tDepth: { value: null },
      inverseProjection: this.view.inverseProjection,
      size: { value: new Vector2(1, 1) },
      refDist: { value: 6 },
    };
    this.frontScene = new Scene();
    this.thickScene = new Scene();
    this.frontMaterial = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: bodyVertex, fragmentShader: frontFragment, uniforms: this.bodyUniforms,
    });

    const down = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: downFragment,
      uniforms: { tSource: { value: null }, texel: { value: new Vector2() } }, depthTest: false, depthWrite: false,
    });
    this.down = { scene: fullscreen(down), camera: this.camera, uniforms: down.uniforms };

    this.look = {
      jellyRough: { value: 0.08 },
      jellyFrost: { value: 0.05 },
      jellyGlow: { value: 0.3 },
      jellyMilk: { value: 0.3 },
      jellyRefract: { value: 0 },
      jellyDensity: { value: 1 },
      ior: { value: 1.5 },
      dispersion: { value: 0.02 },
      surfaceRough: { value: 0.25 },
      frost: { value: 0.15 },
      haze: { value: 0.3 },
      hazeColor: { value: new Color(1, 1, 1) },
      resinColor: { value: new Color(1, 1, 1) },
      resinDensity: { value: 0 },
    };
    const jellyUniforms = {
      ...this.view,
      tDepth: this.bodyUniforms.tDepth,
      tFront: { value: this.front.texture },
      refDist: this.bodyUniforms.refDist,
      jellyRough: this.look.jellyRough,
      jellyFrost: this.look.jellyFrost,
      jellyGlow: this.look.jellyGlow,
      jellyMilk: this.look.jellyMilk,
      jellyRefract: this.look.jellyRefract,
      jellyDensity: this.look.jellyDensity,
    };
    this.scenePyr.bind(jellyUniforms, "tScene", null);
    this.absorbPyr.bind(jellyUniforms, "tAbsorb", this.thick.texture);
    this.jellyUniforms = jellyUniforms;
    this.jellyScene = fullscreen(new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: jellyFragment, uniforms: jellyUniforms, depthTest: false, depthWrite: false,
    }));

    this.shape = { from: Array.from({ length: 4 }, () => new Vector4()), to: Array.from({ length: 4 }, () => new Vector4()), t: 1, blend: new Vector2() };
    const volumeUniforms = {
      ...this.view,
      ...this.look,
      tFirst: { value: this.jelly.texture },
      tFront: { value: this.front.texture },
      containerInverse: { value: new Matrix4() },
      containerRotation: { value: new Matrix3() },
      containerCenter: { value: new Vector3() },
      boundRadius: { value: 1.7 },
      shapeFrom: { value: this.shape.from },
      shapeTo: { value: this.shape.to },
      shapeMix: { value: 1 },
      shapeBlend: { value: this.shape.blend },
      wall: { value: 0 },
      containerShow: { value: 1 },
      shellSteps: { value: 32 },
      marchSteps: { value: steps },
    };
    this.jellyPyr.bind(volumeUniforms, "tJelly", this.jelly.texture);
    this.volumeUniforms = volumeUniforms;
    this.volumeScene = fullscreen(new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: volumeFragment, uniforms: volumeUniforms,
      depthTest: false, depthWrite: false,
    }));
    this.motionScene = fullscreen(new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: motionFragment,
      uniforms: {
        ...this.motion,
        viewProjection: this.view.viewProjection,
        inverseViewProjection: this.view.inverseViewProjection,
        cameraPos: this.view.cameraPos,
        sceneSize: this.view.sceneSize,
      },
      depthTest: false, depthWrite: false,
    }));
    const transmit = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: transmitFragment,
      uniforms: { tSource: { value: this.lightMap.texture }, jellyMilk: this.look.jellyMilk }, depthTest: false, depthWrite: false,
    });
    this.transmitScene = fullscreen(transmit);
    this._vp = new Matrix4();
  }

  // A body's skin: drawn into the front and thickness passes. Returns a handle with its look uniforms.
  addBody(geometry) {
    const front = new Mesh(geometry, this.frontMaterial);
    front.frustumCulled = false;
    front.matrixAutoUpdate = false;
    const uniforms = { ...this.bodyUniforms, sigma: { value: new Vector3(1, 1, 1) } };
    const material = new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: bodyVertex, fragmentShader: thickFragment, uniforms, side: DoubleSide, depthTest: false, depthWrite: false,
      transparent: true, blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
      blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor,
    });
    const thick = new Mesh(geometry, material);
    thick.frustumCulled = false;
    thick.matrixAutoUpdate = false;
    const light = new Mesh(geometry, new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: lightVertex, fragmentShader: lightFragment, uniforms: { sigma: uniforms.sigma, ...this.lightUniforms },
      side: DoubleSide, depthTest: false, depthWrite: false, transparent: true, blending: CustomBlending, blendEquation: AddEquation,
      blendSrc: OneFactor, blendDst: OneFactor, blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor,
    }));
    light.frustumCulled = false;
    light.matrixAutoUpdate = false;
    this.frontScene.add(front);
    this.thickScene.add(thick);
    this.lightScene.add(light);
    return { front, thick, light, uniforms };
  }

  removeBody(handle) {
    this.frontScene.remove(handle.front);
    this.thickScene.remove(handle.thick);
    this.lightScene.remove(handle.light);
    handle.thick.material.dispose();
    handle.light.material.dispose();
  }

  setContainer(container, matrixWorld) {
    container.uniforms(this.shape);
    this.volumeUniforms.shapeMix.value = this.shape.t;
    this.volumeUniforms.containerInverse.value.copy(matrixWorld).invert();
    this.volumeUniforms.containerRotation.value.setFromMatrix4(matrixWorld);
    this.volumeUniforms.containerCenter.value.setFromMatrixPosition(matrixWorld);
  }

  // The bodies from the key light, orthographic around the volume.
  renderLight(renderer) {
    const L = globalUniforms.lightDirection.value;
    const c = this.volumeUniforms.containerCenter.value;
    const cam = this.lightCamera, e = this.lightExtent;
    cam.left = cam.bottom = -e;
    cam.right = cam.top = e;
    cam.position.copy(L).normalize().multiplyScalar(8).add(c);
    cam.up.set(0, 1, 0);
    if (Math.abs(L.y) > 0.99 * L.length()) cam.up.set(0, 0, 1);
    cam.lookAt(c);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    this.lightViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.lightUniforms.lightOrigin.value.copy(cam.position);
    this.lightUniforms.lightTravel.value.copy(L).normalize().negate();
    renderer.setRenderTarget(this.lightMap);
    renderer.clear(true, false, false);
    renderer.render(this.lightScene, cam);
    renderer.setRenderTarget(this.lightT);
    renderer.render(this.transmitScene, this.camera);
    this.lightPyr.build(renderer, this.down, this.lightT.texture, this.lightT.width, this.lightT.height);
  }

  compile(renderer, camera) {
    return Promise.all([this.jellyScene, this.volumeScene, this.down.scene, this.transmitScene, this.motionScene].map((s) => renderer.compileAsync(s, this.camera)));
  }

  render(renderer, hdr, { depthTexture, camera, width, height }) {
    if (this.jelly.width !== width || this.jelly.height !== height) {
      for (const t of [this.front, this.thick, this.jelly, this.output, this.blurred]) t.setSize(width, height);
      this.scenePyr.setSize(width, height);
      this.jellyPyr.setSize(width, height);
      this.absorbPyr.setSize(width, height);
    }
    const prev = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new Color()), clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    const v = this.view;
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    v.viewProjection.value.copy(this._vp);
    v.inverseViewProjection.value.copy(this._vp).invert();
    v.inverseProjection.value.copy(camera.projectionMatrixInverse);
    v.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    v.pixelAngle.value = (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / (camera.zoom * height);
    v.sceneSize.value.set(width, height);
    const b = this.bodyUniforms;
    b.viewMatrix.value.copy(camera.matrixWorldInverse);
    b.projectionMatrix.value.copy(camera.projectionMatrix);
    b.tDepth.value = depthTexture;
    b.size.value.set(width, height);

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.front);
    renderer.clear(true, true, false);
    renderer.render(this.frontScene, camera);
    renderer.setRenderTarget(this.thick);
    renderer.clear(true, false, false);
    renderer.render(this.thickScene, camera);

    this.renderLight(renderer);
    this.scenePyr.build(renderer, this.down, hdr, width, height);
    this.absorbPyr.build(renderer, this.down, this.thick.texture, width, height);
    this.jellyUniforms.tScene0.value = hdr;
    renderer.setRenderTarget(this.jelly);
    renderer.render(this.jellyScene, this.camera);

    this.jellyPyr.build(renderer, this.down, this.jelly.texture, width, height);
    renderer.setRenderTarget(this.output);
    renderer.render(this.volumeScene, this.camera);
    let result = this.output.texture;
    const m = this.motion;
    if (m.shutter.value > 0 && m.omega.value.lengthSq() > 1e-4) {
      m.center.value.copy(this.volumeUniforms.containerCenter.value);
      renderer.setRenderTarget(this.blurred);
      renderer.render(this.motionScene, this.camera);
      result = this.blurred.texture;
    }

    renderer.setRenderTarget(prev);
    renderer.setClearColor(clear, clearAlpha);
    renderer.autoClear = autoClear;
    return result;
  }
}

const transmitFragment = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform float jellyMilk;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 a = texture(tSource, vUv);
  // Milk scatters light out of the beam; about half of it still goes on forward.
  outColor = vec4(exp(-max(a.rgb, vec3(0.0)) - jellyMilk * 0.5 * max(a.a, 0.0)), 1.0);
}
`;

// For receivers of the coloured shadow: the light map's pyramid, sampled by blur radius in texels.
const lightShadowGLSL = bicubicGLSL + pyramidGLSL("tLight", 5);

export { VolumePass, lightShadowGLSL };
