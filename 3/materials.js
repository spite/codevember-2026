import { Color, Vector2, Vector3, Vector4 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";
import { RIPPLES, HMAX as HMAX_SHOWN } from "./puddle.js";

// One material for the shape and its blobs: colour, roughness dry and wet, metalness, specular; the reflection env
// that suits it, how bright that env's surround is (black lacquer needs a dark one to read as black) and, per
// set, the horizon band's brightness; cards are reflection-only panels near the camera.
// Small panels around the default view: every dome catches a highlight from one of them while flat faces stay black.
const LACQUER_CARDS = [
  { direction: new Vector3(0.65, 0.55, 1), size: new Vector2(0.12, 0.12), intensity: 6 },
  { direction: new Vector3(-0.1, -0.85, 1), size: new Vector2(0.22, 0.1), intensity: 1.2 },
  { direction: new Vector3(1, 0.05, 0.45), size: new Vector2(0.1, 0.3), intensity: 4 },
];

export const FINISHES = {
  Lacquer: { body: ["#0b0b0c", 0.06, 0.03, 0, 1.3], reflections: "softbox", surround: 0.14, horizon: { Light: 0.35, Dark: 0.18 }, cards: LACQUER_CARDS },
  Blueberry: { body: ["#2f5f9e", 0.38, 0.06, 0, 1.1], reflections: "softbox" },
  Candy: { body: ["#7a0a12", 0.08, 0.03, 0, 1.3], reflections: "softbox" },
  Mercury: { body: ["#d4d4d6", 0.05, 0.035, 1, 1], reflections: "softbox" },
  Wax: { body: ["#d6c29c", 0.5, 0.12, 0, 0.9], reflections: "softbox", wax: [1.0, 0.4], scatter: [0.75, 1, 0.6] },
};

// One set of look uniforms, shared by every melt material.
export const lookUniforms = {
  bodyColor: { value: new Color() },
  bodyFinish: { value: new Vector4() },
  roughNoise: { value: 0.012 },
  // Wax: bump strength and sheen on the dry surface.
  waxLook: { value: new Vector2() },
  // Subsurface: share of diffuse that scatters, mean free path scale, wrap past the terminator.
  waxScatter: { value: new Vector3() },
  shapeSdf: { value: null },
  shapeSdfMin: { value: new Vector3() },
  shapeSdfSize: { value: 1 },
};

export function applyFinish(name) {
  const [color, roughDry, roughWet, metal, specular] = FINISHES[name].body;
  lookUniforms.bodyColor.value.set(color);
  lookUniforms.bodyFinish.value.set(roughDry, roughWet, metal, specular);
  lookUniforms.waxLook.value.fromArray(FINISHES[name].wax ?? [0, 0]);
  lookUniforms.waxScatter.value.fromArray(FINISHES[name].scatter ?? [0, 0, 0]);
}

export const lacquerGLSL = /* glsl */ `
uniform vec3 bodyColor;
uniform vec4 bodyFinish;
uniform float roughNoise;
uniform vec2 waxLook;
uniform vec3 waxScatter;
#if !defined(PIPELINE_SHADOW) && !defined(PIPELINE_PREPASS)
#define WAX_LIT
uniform highp sampler3D shapeSdf;
uniform vec3 shapeSdfMin;
uniform float shapeSdfSize;
// Path length from p along l (object space) to where it leaves the shape, sphere tracing the inside.
float shapeThickness(vec3 p, vec3 l) {
  float t = 0.0;
  for (int i = 0; i < 10; i++) {
    float d = textureLod(shapeSdf, (p + l * t - shapeSdfMin) / shapeSdfSize, 0.0).r;
    if (d > 0.0) break;
    t += max(-d, 0.02);
  }
  return t;
}
// Red travels furthest through wax, blue least.
const vec3 WAX_MFP = vec3(0.16, 0.085, 0.045);
// Diffusion approximation: a share of the diffuse light wraps past the terminator (red widest) and the key shines
// through parts thinner than the mean free path; the rest stays ordinary diffuse. nGeom is the unbumped normal.
void waxScatterLight(inout Surface s, vec3 nGeom, float thick) {
  float k = waxScatter.x;
  if (k <= 0.0) return;
  vec3 L = normalize(lightDirection);
  vec3 V = normalize(cameraPosition - vWorldPosition);
  float ndl = dot(nGeom, L);
  vec3 w = waxScatter.z * WAX_MFP / WAX_MFP.r;
  vec3 wrap = max((ndl + w) / ((1.0 + w) * (1.0 + w)), 0.0);
  float shadow = ndl > -0.25 ? getShadowFixed(vWorldPosition, nGeom, 4.0) : 0.0;
  wrap *= mix(1.0, shadow, smoothstep(-0.1, 0.35, ndl));
  vec3 trans = exp(-thick / (waxScatter.y * WAX_MFP)) * clamp(0.6 - ndl, 0.0, 1.0) * (0.5 + 0.5 * pow(clamp(dot(V, -L), 0.0, 1.0), 2.0));
  vec3 amb = max(evalSH(envRotation * nGeom), vec3(0.0)) * envIntensity * s.occlusion;
  vec3 a = s.albedo * (1.0 - s.metalness);
  s.emissive += k * a * (lightColor * PIPELINE_INV_PI * (wrap + trans) + amb);
  s.albedo *= 1.0 - k;
}
#endif
float lqHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float lqNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lqHash(i), lqHash(i + vec3(1, 0, 0)), f.x), mix(lqHash(i + vec3(0, 1, 0)), lqHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(lqHash(i + vec3(0, 0, 1)), lqHash(i + vec3(1, 0, 1)), f.x), mix(lqHash(i + vec3(0, 1, 1)), lqHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void lacquer(inout Surface s, float wet, vec3 q) {
  s.albedo = bodyColor;
  s.metalness = bodyFinish.z;
  s.specular = bodyFinish.w;
  float n = 0.6 * lqNoise(q * 7.0) + 0.4 * lqNoise(q * 19.0);
  s.roughness = mix(bodyFinish.x, bodyFinish.y, wet) + roughNoise * (n - 0.5) * (1.0 - 0.6 * wet);
#ifndef PIPELINE_SHADOW
  float dry = 1.0 - wet;
  if (waxLook.x > 0.0) {
    // Hammered, slightly lumpy wax: a derivative bump of noise in rest space, gone where fresh melt has smoothed it.
    float b = waxLook.x * dry * (0.0025 * lqNoise(q * 9.0) + 0.0012 * lqNoise(q * 23.0) + 0.0004 * lqNoise(q * 61.0));
    vec3 dpx = dFdx(vWorldPosition), dpy = dFdy(vWorldPosition);
    vec3 r1 = cross(dpy, s.normal), r2 = cross(s.normal, dpx);
    float det = dot(dpx, r1);
    vec3 g = sign(det) * (dFdx(b) * r1 + dFdy(b) * r2);
    s.normal = normalize(abs(det) * s.normal - g);
    s.roughness += 0.12 * dry * (n - 0.5);
    s.sheenColor = bodyColor * waxLook.y * dry;
    s.sheenRoughness = 0.55;
  }
#endif
}
`;

// Blob and trail kernels from field.js, evaluated on the rest surface; shared by the vertex and fragment stages.
export const fieldGLSL = /* glsl */ `
uniform highp sampler2D blobTex;
uniform highp sampler2D trailTex;
uniform highp sampler2D gridTex;
uniform vec3 gridMin;
uniform float gridSize;
uniform int blobCount;
uniform int trailCount;
uniform float blobP;
uniform float trailAspect;
uniform vec3 gravityObj[3];
uniform float sagK;

// One blob's kernel, accumulated into the p-norm sums; facing keeps thin parts' far side untouched. A running blob
// narrows towards its tail, so it flows into its trail.
void addBlob(int i, int pose, vec3 p, vec3 n, inout float sum, inout vec3 gsum) {
  int row = pose * 3;
  vec4 c = texelFetch(blobTex, ivec2(i, row), 0);
  vec4 m = texelFetch(blobTex, ivec2(i, row + 2), 0);
  vec3 d = p - c.xyz;
  if (dot(d, d) >= m.w * m.w) return;
  float facing = smoothstep(0.0, 0.45, dot(n, m.xyz));
  if (facing <= 0.0) return;
  vec4 t = texelFetch(blobTex, ivec2(i, row + 1), 0);
  if (t.w <= 0.0) return;
  float tail = length(t.xyz);
  vec3 down = t.xyz / tail;
  vec3 side = cross(m.xyz, down);
  float u = dot(d, down), v = dot(d, side), w = dot(d, m.xyz);
  float ax = c.w * (u < 0.0 ? tail : BLOB_FRONT);
  float tp = u < 0.0 ? BLOB_TAPER * 0.5 * (tail - 1.0) : 0.0;
  float tt = clamp(-u / ax, 0.0, 1.0);
  float av = c.w * (1.0 - tp * tt);
  float dav = (u < 0.0 && tt < 1.0) ? c.w * tp / ax : 0.0;
  // The normal axis spans the bound, so the kernel fades to zero inside it on tight curvature.
  float iu = 1.0 / (ax * ax), iv = 1.0 / (av * av), iw = 1.0 / (m.w * m.w);
  float s2 = u * u * iu + v * v * iv + w * w * iw;
  if (s2 >= 1.0) return;
  float q = 1.0 - s2;
  float k = t.w * facing;
  float h = k * q * q;
  vec3 dh = -4.0 * k * q * ((u * iu - v * v * iv / av * dav) * down + v * iv * side + w * iw * m.xyz);
  float hp = pow(h, blobP - 1.0);
  sum += hp * h;
  gsum += hp * dh;
}

// One trail: flat-topped film of thickness th and half-width trailAspect*sqrt(th) around the polyline, smooth-maxed
// into its chain's value cv (gradient cg). Free chain ends fade in height; the blend widens with the bend, so joints
// have no crease. Mirrors trails.js.
float tsDeriv(float x) { return (x <= 0.0 || x >= 1.0) ? 0.0 : 6.0 * x * (1.0 - x); }
void addTrail(int j, vec3 p, vec3 n, inout float cv, inout vec3 cg) {
  vec4 b = texelFetch(trailTex, ivec2(0, j), 0);
  vec3 db = p - b.xyz;
  if (dot(db, db) >= b.w * b.w) return;
  vec4 tp = texelFetch(trailTex, ivec2(TRAIL_POINTS + 1, j), 0);
  vec4 a = texelFetch(trailTex, ivec2(1, j), 0);
  vec3 prevDir = vec3(0.0);
  float cum = 0.0;
  for (int k = 2; k <= TRAIL_POINTS; k++) {
    vec4 e = texelFetch(trailTex, ivec2(k, j), 0);
    if (e.w <= 0.0) break;
    vec3 ab = e.xyz - a.xyz;
    float l2 = max(dot(ab, ab), 1e-10);
    float ll = sqrt(l2);
    float fu = dot(p - a.xyz, ab) / l2;
    float f = clamp(fu, 0.0, 1.0);
    float inside = (fu > 0.0 && fu < 1.0) ? 1.0 : 0.0;
    vec3 r = p - a.xyz - f * ab;
    float th = max(mix(a.w, e.w, f), 1e-7);
    float sq = sqrt(th);
    float iw = 1.0 / (trailAspect * trailAspect * th);
    // Offsets along the rest normal fade the film, so it never reaches through to the far side of thin parts.
    float D = 0.7 * trailAspect * sq + 0.006;
    float rn = dot(r, n) / D;
    float r2 = dot(r, r);
    float s = r2 * iw + rn * rn;
    vec3 dir = ab / ll;
    if (s < 1.0) {
      float dist = (cum + f * ll) * tp.y;
      float xh = tp.z + dist, xt = tp.w - dist;
      float sH = smoothstep(0.0, 1.0, xh), sT = smoothstep(0.0, 1.0, xt);
      float tf = sH * sT;
      vec3 dtf = inside * tp.y * (tsDeriv(xh) * sT - sH * tsDeriv(xt)) / ll * ab;
      float Q = 1.0 - s * s;
      float T = th * tf;
      float v = T * Q * Q;
      vec3 dth = inside * (e.w - a.w) / l2 * ab;
      vec3 dT = tf * dth + th * dtf;
      vec3 drn = n - inside * ab * (dot(ab, n) / l2);
      vec3 ds = 2.0 * iw * r + (-r2 * iw / th - 2.0 * rn * rn / D * 0.35 * trailAspect / sq) * dth + 2.0 * rn / D * drn;
      vec3 g = Q * Q * dT - 4.0 * T * s * Q * ds;
      float cosb = k > 2 ? dot(prevDir, dir) : 1.0;
      // Narrowed where either side fades out, so the blend never steps at a film edge.
      float kc = 0.03 + 0.4 * (1.0 - cosb);
      float kb = min(T * kc, min(v, cv));
      float t = kb > 1e-12 ? clamp(0.5 + 0.5 * (v - cv) / kb, 0.0, 1.0) : step(cv, v);
      vec3 dk = kb == v ? g : kb == cv ? cg : kc * dT;
      cv = mix(cv, v, t) + kb * t * (1.0 - t);
      cg = mix(cg, g, t) + t * (1.0 - t) * dk;
    }
    prevDir = dir;
    a = e;
    cum += ll;
  }
}

// Height of blobs and trails over rest point p with rest normal n; grad is its object-space gradient. Trails merge
// within a chain by smooth max and across chains by a CHAIN_P-norm; that union joins the blobs' blobP-norm, so a
// trail fades into its blob. A cell's trail ids arrive grouped by chain.
float blobField(vec3 p, vec3 n, int pose, out vec3 grad) {
  ivec3 g = clamp(ivec3(floor((p - gridMin) / gridSize * float(GRID))), ivec3(0), ivec3(GRID - 1));
  int cell = g.x + GRID * (g.y + GRID * g.z);
  float sum = 0.0, tsum = 0.0, cv = 0.0, cid = -1.0;
  vec3 gsum = vec3(0.0), tg = vec3(0.0), cg = vec3(0.0);
  int count = int(texelFetch(gridTex, ivec2(cell, 0), 0).x + 0.5);
  bool brute = count > GRID_SLOTS;
  int n0 = brute ? blobCount + trailCount : count;
  for (int k = 0; k < MAX_BLOBS + MAX_TRAILS; k++) {
    if (k >= n0) break;
    int id = brute ? (k < blobCount ? k : MAX_BLOBS + k - blobCount) : int(texelFetch(gridTex, ivec2(cell, (k + 1) >> 2), 0)[(k + 1) & 3] + 0.5);
    if (id < MAX_BLOBS) { addBlob(id, pose, p, n, sum, gsum); continue; }
    int j = id - MAX_BLOBS;
    float ch = texelFetch(trailTex, ivec2(TRAIL_POINTS + 1, j), 0).x;
    if (ch != cid) {
      if (cv > 0.0) { float hp = pow(cv, CHAIN_P - 1.0); tsum += hp * cv; tg += hp * cg; }
      cid = ch; cv = 0.0; cg = vec3(0.0);
    }
    addTrail(j, p, n, cv, cg);
  }
  if (cv > 0.0) { float hp = pow(cv, CHAIN_P - 1.0); tsum += hp * cv; tg += hp * cg; }
  if (tsum > 1e-30) {
    float T = pow(tsum, 1.0 / CHAIN_P);
    vec3 dT = tg * pow(T, 1.0 - CHAIN_P);
    float tp = pow(T, blobP - 1.0);
    sum += tp * T;
    gsum += tp * dT;
  }
  grad = vec3(0.0);
  if (sum <= 1e-30) return 0.0;
  float H = pow(sum, 1.0 / blobP);
  grad = gsum * pow(H, 1.0 - blobP);
  return H;
}

#ifdef MAX_POOLS
uniform highp sampler2D poolTex;
uniform int poolCount;
// Profile knot i of a pool (radius, depth, flatten): mirrored through the axis below 0, the bare skin past ρ0.
vec3 poolKnot(int row, int i, float dr) {
  if (i < 0) { vec3 s = texelFetch(poolTex, ivec2(POOL_HEAD - i, row), 0).xyz; return vec3(-s.x, s.yz); }
  if (i >= POOL_N) return vec3(float(i) * dr, 0.0, 0.0);
  return texelFetch(poolTex, ivec2(POOL_HEAD + i, row), 0).xyz;
}
// Hanging pools (pendants.js): skin at distance s < ρ0 from the apex a maps onto the profile at s. Flattened (w), it
// lands on the lathe: radius r in the plane of the fitted normal nb, depth z along the bulb axis g, so the bulb is clean
// however the skin curves there, a sharp tip included; above the depth zs the lathe keeps the skin's rise along its ray,
// so a tip carries on into the pool. Elsewhere it moves towards the apex to distance r and
// drops by z. t1, t2 are the skin tangents, carried through the same map.
void addPools(vec3 p, vec3 nRest, inout vec3 off, inout vec3 t1, inout vec3 t2, inout float h) {
  for (int k = 0; k < MAX_POOLS; k++) {
    if (k >= poolCount) break;
    vec4 a = texelFetch(poolTex, ivec2(0, k), 0);
    if (a.w <= 0.0) continue;
    vec3 d = p + off - a.xyz;
    float s = length(d);
    if (s >= a.w) continue;
    vec3 nb = texelFetch(poolTex, ivec2(2, k), 0).xyz;
    // Leaves the far side of thin parts alone.
    float face = smoothstep(-0.3, 0.1, dot(nRest, nb));
    if (face <= 0.0) continue;
    float hn = dot(d, nb);
    vec3 pv = d - nb * hn;
    float rho = length(pv);
    vec4 gz = texelFetch(poolTex, ivec2(1, k), 0);
    vec3 g = gz.xyz;
    vec3 rad = rho > 1e-6 ? pv / rho : normalize(cross(nb, abs(nb.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
    float dr = a.w / float(POOL_N - 1);
    float u = s / dr;
    int i = int(u);
    float t = u - float(i);
    vec3 k0 = poolKnot(k, i - 1, dr), k1 = poolKnot(k, i, dr), k2 = poolKnot(k, i + 1, dr), k3 = poolKnot(k, i + 2, dr);
    vec3 cb = k2 - k0, cc = 2.0 * k0 - 5.0 * k1 + 4.0 * k2 - k3, cd = 3.0 * (k1 - k2) + k3 - k0;
    vec3 c = 0.5 * (2.0 * k1 + t * (cb + t * (cc + t * cd)));
    vec3 dc = 0.5 * (cb + t * (2.0 * cc + t * 3.0 * cd)) / dr;
    float r = c.x, z = c.y, w = c.z;
    vec3 e = s > 1e-6 ? d / s : nb;
    float q = s > 1e-6 ? r / s : dc.x, dq = s > 1e-6 ? (dc.x - q) / s : 0.0;
    float rr = rho > 1e-6 ? r / rho : dc.x;
    float x = clamp(z / max(gz.w, 1e-5), 0.0, 1.0), keep = 1.0 - x * x * (3.0 - 2.0 * x);
    float dkeep = -6.0 * x * (1.0 - x) / max(gz.w, 1e-5) * dc.y;
    // Moved to distance r, skin keeps the rise a paraboloid through it would have there, so a curved underside is not cut into.
    float q2 = q * q;
    vec3 sk = pv * q + nb * (hn * q2);
    vec3 m = mix(sk, rad * r + nb * (hn * q2 * keep), w) + g * z;
    // Tangent of the mapped point along each skin tangent; the face weight blends it in as a constant.
    vec3 lath = rad * r + nb * (hn * q2 * keep) - sk;
    float a1 = dot(rad, t1), b1 = dot(nb, t1), e1 = dot(e, t1), h1 = b1 * q2 + 2.0 * hn * q * dq * e1;
    vec3 m1 = (1.0 - w) * ((t1 - nb * b1) * q + pv * (dq * e1) + nb * h1) + w * ((t1 - nb * b1 - rad * a1) * rr + rad * (dc.x * e1) + nb * (h1 * keep + hn * q2 * dkeep * e1)) + (lath * dc.z + g * dc.y) * e1;
    float a2 = dot(rad, t2), b2 = dot(nb, t2), e2 = dot(e, t2), h2 = b2 * q2 + 2.0 * hn * q * dq * e2;
    vec3 m2 = (1.0 - w) * ((t2 - nb * b2) * q + pv * (dq * e2) + nb * h2) + w * ((t2 - nb * b2 - rad * a2) * rr + rad * (dc.x * e2) + nb * (h2 * keep + hn * q2 * dkeep * e2)) + (lath * dc.z + g * dc.y) * e2;
    off += (m - d) * face;
    t1 = mix(t1, m1, face);
    t2 = mix(t2, m2, face);
    h = max(h, z * face);
  }
}
#endif

// Offset of the displaced surface from rest point p (sagging downhill by sagK) and its normal; n is the rest normal on
// input. fade eases bulges out at open boundaries; the height is soft-limited to a share of the concave radius room.
vec3 bodySurface(vec3 p, inout vec3 n, int pose, float fade, float room, out float h) {
  vec3 grad;
  h = fade * blobField(p, n, pose, grad);
  float cl = CLEAR_K * room, e = exp(-h / cl);
  h = cl * (1.0 - e);
  grad *= fade * e;
  vec3 gv = gravityObj[pose];
  vec3 m = n + sagK * (gv - n * dot(n, gv));
  vec3 e1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(n, e1);
  vec3 t1 = e1 + dot(grad, e1) * m, t2 = e2 + dot(grad, e2) * m;
  vec3 off = h * m;
#ifdef MAX_POOLS
  addPools(p, n, off, t1, t2, h);
#endif
  n = normalize(cross(t1, t2));
  return off;
}
`;

// The body with its blobs, trails and hanging pools; pools = { defines, uniforms } from pendantLayout. The vertex
// stages read the displaced surface from bake (createBodyBake), evaluated once per frame.
export function createBodyMaterial(field, pools, bake) {
  return new PipelineMaterial({
    // Half-res screen AO steps the glossy highlights through specular occlusion; the baked AO carries most of it.
    uniforms: { ...lookUniforms, ...field.uniforms, ...pools.uniforms, ...bake.uniforms, aoIntensity: { value: 0.2 } },
    defines: { ...field.defines, ...pools.defines },
    varyings: { vAo: "float", vFade: "float", vRoom: "float", vH: "float", vRest: "vec3", vRestN: "vec3" },
    vertexPars: bake.glsl + "in float ao;\nin float fade;\nin float clearance;\nuniform float motionPass;\nfloat bodyH;\n",
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  ivec2 t = bakeTexel();
  if (pipelinePrevPose) return p + (motionPass > 0.5 ? texelFetch(bakePose2, t, 0) : texelFetch(bakePose1, t, 0)).xyz;
  vec4 o = texelFetch(bakePose0, t, 0);
  n = texelFetch(bakeNormal0, t, 0).xyz;
  bodyH = o.w;
  return p + o.xyz;
}
`,
    vertexMain: "vAo = ao; vFade = fade; vRoom = clearance; vH = bodyH; vRest = position; vRestN = normal;",
    fragmentPars: lacquerGLSL + fieldGLSL + "uniform mat3 bodyRotation;\nuniform float motionPass;\n",
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_PREPASS
  // Motion blur reads only the velocity.
  if (motionPass > 0.5) return;
#endif
#ifndef PIPELINE_SHADOW
  float h = vH;
#ifndef NO_PIXEL_FIELD
  // Per pixel, so bump highlights do not depend on mesh density.
  vec3 n = normalize(vRestN);
  bodySurface(vRest, n, 0, vFade, vRoom, h);
  s.normal = normalize(bodyRotation * n);
#endif
  vec3 nGeom = s.normal;
  lacquer(s, smoothstep(0.0005, 0.006, h), vRest);
#ifdef WAX_LIT
  if (waxScatter.x > 0.0) {
    vec3 lo = normalize(lightDirection * bodyRotation);
    // Starts a voxel deep, so the coarse grid's sign noise at the skin does not speckle the glow.
    float inset = 1.2 * shapeSdfSize / 48.0;
    // Light only shines through where the surface faces away from it (see waxScatterLight).
    float thick = dot(nGeom, normalize(lightDirection)) < 0.6 ? shapeThickness(vRest - normalize(vRestN) * inset, lo) + inset + h : 0.0;
    waxScatterLight(s, nGeom, thick);
  }
#endif
  s.occlusion *= vAo;
  s.albedo *= mix(1.0, vAo, 0.4);
#endif
}
`,
  });
}

// Falling drops: one world-space instance per drop slot, a sphere with its back and front halves stretched along its velocity.
export function createDropMaterial(drops) {
  return new PipelineMaterial({
    uniforms: { ...lookUniforms, dropTex: { value: drops.tex }, maxDrops: { value: drops.MAXD } },
    varyings: { vRest: "vec3" },
    vertexPars: "uniform highp sampler2D dropTex;\nuniform int maxDrops;\nuniform float motionPass;\nvec3 dropRest;\n",
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  int pose = pipelinePrevPose ? (motionPass > 0.5 ? 2 : 1) : 0;
  int row = gl_InstanceID + pose * maxDrops;
  vec4 a = texelFetch(dropTex, ivec2(0, row), 0);
  vec4 b = texelFetch(dropTex, ivec2(1, row), 0);
  float lower = texelFetch(dropTex, ivec2(2, row), 0).x;
  float sp = length(b.xyz);
  vec3 ax = sp > 1e-4 ? -b.xyz / sp : vec3(0.0, 1.0, 0.0);
  float along = dot(p, ax);
  float s = along > 0.0 ? b.w : lower;
  n = normalize(n - ax * dot(n, ax) * (1.0 - 1.0 / s));
  if (!pipelinePrevPose) dropRest = p + float(gl_InstanceID) * 7.31;
  return a.xyz + (p + ax * along * (s - 1.0)) * a.w;
}
`,
    vertexMain: "vRest = dropRest;",
    fragmentPars: lacquerGLSL + "uniform float motionPass;\n",
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_PREPASS
  if (motionPass > 0.5) return;
#endif
#ifndef PIPELINE_SHADOW
  vec3 nGeom = s.normal;
  lacquer(s, 1.0, vRest);
#ifdef WAX_LIT
  waxScatterLight(s, nGeom, 0.09);
#endif
#endif
}
`,
  });
}

// The floor puddle: a world-space grid lifted by the puddle's shown height, normals from its slope per pixel.
export function createPuddleMaterial(puddle) {
  const pars = /* glsl */ `
uniform highp sampler2D puddleNow;
uniform highp sampler2D puddlePrev;
uniform vec4 puddleRect;
uniform vec2 puddleTexel;
uniform float floorY;
uniform vec4 puddleRipples[${RIPPLES}];
uniform float puddleTime;
uniform float puddleTimePrev;
float puddleH(highp sampler2D t, vec2 xz) { return texture(t, (xz - puddleRect.xy) / puddleRect.zw).r; }
// Cubic B-spline from four bilinear taps, so the outline on the floor follows a smooth curve rather than the grid.
float puddleHC(highp sampler2D t, vec2 xz) {
  vec2 st = (xz - puddleRect.xy) / puddleRect.zw / puddleTexel - 0.5;
  vec2 i = floor(st), f = st - i, g = 1.0 - f;
  vec2 w0 = g * g * g / 6.0, w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0, w2 = (4.0 - 6.0 * g * g + 3.0 * g * g * g) / 6.0, w3 = f * f * f / 6.0;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 c0 = (i - 0.5 + w1 / s0) * puddleTexel, c1 = (i + 1.5 + w3 / s1) * puddleTexel;
  float h = s0.y * (s0.x * texture(t, vec2(c0.x, c0.y)).r + s1.x * texture(t, vec2(c1.x, c0.y)).r)
          + s1.y * (s0.x * texture(t, vec2(c0.x, c1.y)).r + s1.x * texture(t, vec2(c1.x, c1.y)).r);
  // Lifts the toe so the wall meets the floor steeply instead of flaring out like a brim.
  const float HM = ${HMAX_SHOWN.toFixed(4)};
  return h > 0.0 ? HM * pow(min(h / HM, 1.0), 0.6) + max(h - HM, 0.0) : h;
}
// Splash rings (height, d/dx, d/dz) at time T: a raised ring expanding from each landing, only on the pool's top.
vec3 puddleRipple(vec2 xz, float T, float h) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = puddleRipples[i];
    float a = T - r.z;
    if (r.w <= 0.0 || a < 0.0 || a > 1.0) continue;
    vec2 d = xz - r.xy;
    float dist = length(d) + 1e-5;
    float x = (dist - 0.4 * a) / 0.035;
    // Shows once the ring has left the landing's dome, so it never reads as a crater.
    float g = r.w * exp(-x * x - 3.0 * a) / (1.0 + 5.0 * a) * smoothstep(1.2, 2.2, 0.1 * a / r.w);
    sum += vec3(g, (-2.0 * x * g / 0.035) * d / dist);
  }
  return sum * smoothstep(${(0.5 * HMAX_SHOWN).toFixed(4)}, ${(0.85 * HMAX_SHOWN).toFixed(4)}, h);
}
vec3 puddleNormal(highp sampler2D t, vec2 xz, float steep, vec2 rg) {
  vec2 e = puddleTexel * puddleRect.zw;
  float hx = puddleHC(t, xz + vec2(e.x, 0.0)) - puddleHC(t, xz - vec2(e.x, 0.0));
  float hz = puddleHC(t, xz + vec2(0.0, e.y)) - puddleHC(t, xz - vec2(0.0, e.y));
  return normalize(vec3(-steep * hx / (2.0 * e.x) - rg.x, 1.0, -steep * hz / (2.0 * e.y) - rg.y));
}
`;
  return new PipelineMaterial({
    uniforms: { ...lookUniforms, ...puddle.uniforms },
    vertexPars: pars,
    vertex: /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  float h = pipelinePrevPose ? puddleHC(puddlePrev, p.xz) : puddleHC(puddleNow, p.xz);
  vec3 r = puddleRipple(p.xz, pipelinePrevPose ? puddleTimePrev : puddleTime, h);
#ifndef PIPELINE_PREPASS
  // The prepass takes its normal from surface().
  n = pipelinePrevPose ? puddleNormal(puddlePrev, p.xz, 1.0, r.yz) : puddleNormal(puddleNow, p.xz, 1.0, r.yz);
#endif
  return vec3(p.x, floorY + h + r.x, p.z);
}
`,
    fragmentPars: lacquerGLSL + pars + "uniform float motionPass;\n",
    surface: /* glsl */ `
void surface(inout Surface s) {
#ifdef PIPELINE_PREPASS
  if (motionPass > 0.5) return;
#endif
#ifndef PIPELINE_SHADOW
  // The grid is coarser than a real meniscus: a steeper shading slope lets the rim catch the lights.
  vec3 r = puddleRipple(vWorldPosition.xz, puddleTime, puddleH(puddleNow, vWorldPosition.xz));
  s.normal = puddleNormal(puddleNow, vWorldPosition.xz, 2.0, r.yz);
  vec3 nGeom = s.normal;
  lacquer(s, 1.0, vWorldPosition * 2.0);
#ifdef WAX_LIT
  waxScatterLight(s, nGeom, 0.03);
#endif
#endif
}
`,
  });
}
