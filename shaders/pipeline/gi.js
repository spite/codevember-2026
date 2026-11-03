// Screen-space AO + indirect diffuse (visibility bitmask), temporal accumulation,
// joint-bilateral blur, and the in-material depth-aware upsample (giChunk).

// Half-res passes run as RawShaderMaterial GLSL3; half texel h stands for full-res pixel 2h.
export const giCommon = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

#define GI_PI 3.14159265358979
#define GI_HALF_PI 1.57079632679490

uniform vec2 fullRes;
uniform vec2 halfRes;
uniform vec4 projInfo;  // P00, P11, P20 - P30, P21 - P31
uniform vec2 depthInfo; // P22, P32
uniform float isOrtho;

// Ortho depth is measured from the near plane (+1e-3) so it stays > 0; 0 marks background.
float linearDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  return isOrtho > 0.5 ? (-1.0 - ndc) / depthInfo.x + 1e-3 : depthInfo.y / (ndc + depthInfo.x);
}

vec3 viewPosition(vec2 uv, float z) {
  vec2 xy = (uv * 2.0 - 1.0 + projInfo.zw) / projInfo.xy * (isOrtho > 0.5 ? 1.0 : z);
  return vec3(xy, -z);
}

vec2 halfToUv(ivec2 h) {
  return (vec2(h * 2) + 0.5) / fullRes;
}

ivec2 halfToFull(ivec2 h) {
  return min(h * 2, ivec2(fullRes) - 1);
}

vec2 octEncode(vec3 n) {
  n /= abs(n.x) + abs(n.y) + abs(n.z);
  if (n.z < 0.0) {
    vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    n.xy = (1.0 - abs(n.yx)) * s;
  }
  return n.xy;
}

vec3 octDecode(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

export const fullscreenVertex = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Packs the prepass into half res: x = linear depth (0 = background), yz = oct world normal.
export const geometryFragment = /* glsl */ `${giCommon}
uniform sampler2D tDepth;
uniform sampler2D tNormalVelocity;
uniform mat4 uViewInverse;

layout(location = 0) out vec4 outGeo;

void main() {
  ivec2 p = halfToFull(ivec2(gl_FragCoord.xy));
  float d = texelFetch(tDepth, p, 0).r;
  if (d >= 1.0) {
    outGeo = vec4(0.0);
    return;
  }
  vec3 nv = octDecode(texelFetch(tNormalVelocity, p, 0).xy);
  vec3 nw = normalize(mat3(uViewInverse) * nv);
  outGeo = vec4(linearDepth(d), octEncode(nw), 0.0);
}
`;

// Visibility-bitmask slices; sectors are cosine-weighted so bit counts are irradiance fractions.
export const traceFragment = /* glsl */ `${giCommon}
uniform sampler2D tGeo;
uniform sampler2D tNormalVelocity;
uniform sampler2D tPrevColor;
uniform mat4 uView;
uniform float radius;
uniform float thickness;
uniform float thicknessScale;
uniform vec2 depthFade;
uniform float maxRadiusPixels;
uniform float radianceClamp;
uniform float prevColorValid;
uniform float noiseFrame;
uniform int slices;
uniform int steps;

layout(location = 0) out vec4 outGI;

uint popCount(uint v) {
  v = v - ((v >> 1u) & 0x55555555u);
  v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
  return (((v + (v >> 4u)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24u;
}

// Cosine-weighted slice measure (GTAO arc integral) from the view vector to angle x.
float arc(float x, float n, float cn, float sn) {
  return sign(x) * (cn - cos(2.0 * x - n) + 2.0 * x * sn) * 0.25;
}

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  vec4 g = texelFetch(tGeo, h, 0);
  if (g.x <= 0.0) {
    outGI = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 P = viewPosition(halfToUv(h), g.x);
  vec3 N = normalize(mat3(uView) * octDecode(g.yz));
  vec3 V = isOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-P);

  float screenR = radius * projInfo.y * 0.5 * halfRes.y / (isOrtho > 0.5 ? 1.0 : g.x);
  screenR = min(screenR, maxRadiusPixels);
  // Far away the march covers too few texels to resolve depth; fade to neutral.
  float fade = (1.0 - smoothstep(depthFade.x, depthFade.y, g.x)) * smoothstep(1.0, 3.0, screenR);
  if (fade <= 0.0) {
    outGI = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float thick = thickness * (1.0 + thicknessScale * g.x);

  vec2 noiseCoord = gl_FragCoord.xy + 5.588238 * mod(noiseFrame, 64.0);
  float n0 = ign(noiseCoord);
  float n1 = ign(noiseCoord + vec2(47.0, 17.0));

  vec3 gi = vec3(0.0);
  float vis = 0.0;
  float wsum = 0.0;

  for (int i = 0; i < slices; i++) {
    float phi = (float(i) + n0) * GI_PI / float(slices);
    vec3 dir = vec3(cos(phi), sin(phi), 0.0);
    vec3 orthoDir = dir - dot(dir, V) * V;
    vec3 axis = normalize(cross(orthoDir, V));
    vec3 projN = N - axis * dot(N, axis);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;

    float n = sign(dot(orthoDir, projN)) * acos(clamp(dot(projN, V) / projLen, 0.0, 1.0));
    float cn = cos(n);
    float sn = sin(n);
    float lo = arc(n - GI_HALF_PI, n, cn, sn);
    float total = max(cn + n * sn, 1e-4);

    uint occluded = 0u;
    vec3 sliceGI = vec3(0.0);

    for (int side = 0; side < 2; side++) {
      float sd = side == 0 ? 1.0 : -1.0;
      for (int s = 0; s < steps; s++) {
        float t = (float(s) + n1) / float(steps);
        float off = 1.0 + t * t * (screenR - 1.0);
        ivec2 sh = ivec2(floor(gl_FragCoord.xy + dir.xy * sd * off));
        if (any(lessThan(sh, ivec2(0))) || any(greaterThanEqual(sh, ivec2(halfRes)))) break;
        if (sh == h) continue;

        vec4 sg = texelFetch(tGeo, sh, 0);
        if (sg.x <= 0.0) continue;

        vec2 suv = halfToUv(sh);
        vec3 delta = viewPosition(suv, sg.x) - P;
        float dist = length(delta);
        if (dist < 1e-5) continue;

        // Stochastic falloff over the outer half of the radius; temporal accumulation smooths it.
        float rnd = fract(n1 * 7.13 + float(s) * 0.618034 + float(side) * 0.5 + float(i) * 0.31);
        if (dist > radius * mix(0.5, 1.0, rnd)) continue;

        vec3 deltaDir = delta / dist;
        vec2 fb = vec2(dot(deltaDir, V), dot(normalize(delta - V * thick), V));
        fb = sd * acos(clamp(fb, -1.0, 1.0));
        fb = clamp(fb, n - GI_HALF_PI, n + GI_HALF_PI);
        vec2 u = vec2(arc(fb.x, n, cn, sn), arc(fb.y, n, cn, sn));
        u = clamp((u - lo) / total, 0.0, 1.0);

        uint start = uint(round(min(u.x, u.y) * 32.0));
        uint end = uint(round(max(u.x, u.y) * 32.0));
        uint count = end - start;
        uint mask = count > 0u ? (0xFFFFFFFFu >> (32u - count)) << start : 0u;

        uint fresh = popCount(mask & ~occluded);
        if (fresh > 0u && prevColorValid > 0.5) {
          vec2 vel = texelFetch(tNormalVelocity, halfToFull(sh), 0).zw;
          vec2 puv = suv - 0.5 * vel;
          if (all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)))) {
            vec3 L = max(textureLod(tPrevColor, puv, 0.0).rgb, vec3(0.0));
            float peak = max(max(L.r, L.g), L.b);
            L *= min(1.0, radianceClamp / max(peak, 1e-4));
            vec3 Ns = mat3(uView) * octDecode(sg.yz);
            float facing = clamp(dot(Ns, -deltaDir), 0.0, 1.0);
            sliceGI += L * facing * float(fresh) / 32.0;
          }
        }
        occluded |= mask;
      }
    }

    float w = projLen * total;
    vis += w * (1.0 - float(popCount(occluded)) / 32.0);
    gi += w * sliceGI;
    wsum += w;
  }

  vec4 r = wsum > 0.0 ? vec4(gi / wsum, vis / wsum) : vec4(0.0, 0.0, 0.0, 1.0);
  outGI = mix(vec4(0.0, 0.0, 0.0, 1.0), r, fade);
}
`;

// Reprojects history with the prepass velocity, rejects by depth/normal, blends by history length.
// o1 carries this frame's geometry + history length, which becomes next frame's history geometry.
export const temporalFragment = /* glsl */ `${giCommon}
uniform sampler2D tCurrent;
uniform sampler2D tGeo;
uniform sampler2D tHistory;
uniform sampler2D tHistoryGeo;
uniform sampler2D tNormalVelocity;
uniform mat4 uView;
uniform mat4 uViewInverse;
uniform mat4 uPrevViewProjection;
uniform float historyValid;
uniform float maxHistory;
uniform float depthTolerance;
uniform float normalThreshold;
uniform float historyClamp;

layout(location = 0) out vec4 outAccum;
layout(location = 1) out vec4 outGeo;

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  vec4 g = texelFetch(tGeo, h, 0);
  vec4 cur = texelFetch(tCurrent, h, 0);
  if (g.x <= 0.0) {
    outAccum = vec4(0.0, 0.0, 0.0, 1.0);
    outGeo = vec4(0.0);
    return;
  }

  vec4 hist = vec4(0.0);
  float len = 0.0;

  if (historyValid > 0.5) {
    vec2 uv = halfToUv(h);
    vec2 vel = texelFetch(tNormalVelocity, halfToFull(h), 0).zw;
    vec2 puv = uv - 0.5 * vel;

    vec3 P = viewPosition(uv, g.x);
    vec3 nw = octDecode(g.yz);
    vec3 V = isOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-P);
    float expectZ = g.x;
    vec4 pc = uPrevViewProjection * (uViewInverse * vec4(P, 1.0));
    if (isOrtho > 0.5) expectZ = max((-1.0 - pc.z / pc.w) / depthInfo.x + 1e-3, 1e-3);
    else if (pc.w > 0.0) expectZ = pc.w;
    // Grazing surfaces change depth fast across a texel, so widen the tolerance there.
    float grazing = max(abs(dot(mat3(uView) * nw, V)), 0.05);
    float tol = depthTolerance / grazing;

    vec2 f = (puv * fullRes - 0.5) * 0.5;
    ivec2 b = ivec2(floor(f));
    vec2 fr = f - vec2(b);
    float wsum = 0.0;
    for (int i = 0; i < 4; i++) {
      ivec2 o = ivec2(i & 1, i >> 1);
      ivec2 t = b + o;
      if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, ivec2(halfRes)))) continue;
      vec4 hg = texelFetch(tHistoryGeo, t, 0);
      if (hg.x <= 0.0) continue;
      vec2 bw2 = mix(1.0 - fr, fr, vec2(o));
      float dz = abs(hg.x - expectZ) / expectZ;
      float wd = clamp(1.0 - dz / tol, 0.0, 1.0);
      float wn = step(normalThreshold, dot(octDecode(hg.yz), nw));
      float w = bw2.x * bw2.y * wd * wn;
      hist += texelFetch(tHistory, t, 0) * w;
      len += hg.w * w;
      wsum += w;
    }
    if (wsum > 1e-3) {
      hist /= wsum;
      len = len / wsum * clamp(wsum * 2.0, 0.0, 1.0);
    } else {
      len = 0.0;
    }
    // Variance clipping against this frame's 3x3 neighbourhood, so history from moving casters can't trail.
    if (historyClamp > 0.0 && len > 0.0) {
      vec4 m1 = vec4(0.0);
      vec4 m2 = vec4(0.0);
      float n = 0.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          ivec2 t = clamp(h + ivec2(x, y), ivec2(0), ivec2(halfRes) - 1);
          if (texelFetch(tGeo, t, 0).x <= 0.0) continue;
          vec4 c = texelFetch(tCurrent, t, 0);
          m1 += c;
          m2 += c * c;
          n += 1.0;
        }
      }
      m1 /= n;
      vec4 sigma = sqrt(max(m2 / n - m1 * m1, 0.0));
      hist = clamp(hist, m1 - historyClamp * sigma, m1 + historyClamp * sigma);
    }
  }

  len = min(len + 1.0, maxHistory);
  outAccum = mix(hist, cur, 1.0 / len);
  outGeo = vec4(g.xyz, len);
}
`;

// One a-trous iteration (5x5 B3 kernel at stepSize) weighted by plane distance and normal.
export const blurFragment = /* glsl */ `${giCommon}
uniform sampler2D tInput;
uniform sampler2D tGeo;
uniform mat4 uView;
uniform float stepSize;
uniform float planeSigma;
uniform float normalPower;

layout(location = 0) out vec4 outGI;

void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  vec4 g = texelFetch(tGeo, h, 0);
  if (g.x <= 0.0) {
    outGI = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 P = viewPosition(halfToUv(h), g.x);
  vec3 nw = octDecode(g.yz);
  vec3 nv = mat3(uView) * nw;
  float k[3] = float[3](0.375, 0.25, 0.0625);
  int st = int(stepSize);
  float sigma = max(planeSigma * stepSize * g.x, 1e-6);
#ifdef PENUMBRA_LIMIT
  // Shadow mask: taps stay within the PCF kernel radius (.g), so hard and contact edges aren't smeared.
  float reach = max(texelFetch(tInput, h, 0).g, 0.5);
#endif

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      ivec2 t = h + ivec2(x, y) * st;
      if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, ivec2(halfRes)))) continue;
#ifdef PENUMBRA_LIMIT
      if (float(max(abs(x), abs(y)) * st) > reach) continue;
#endif
      vec4 tg = texelFetch(tGeo, t, 0);
      if (tg.x <= 0.0) continue;
      vec3 Pt = viewPosition(halfToUv(t), tg.x);
      float plane = abs(dot(nv, Pt - P));
      float wd = exp(-plane / sigma);
      float wn = pow(max(dot(nw, octDecode(tg.yz)), 0.0), normalPower);
      float w = k[abs(x)] * k[abs(y)] * wd * wn;
      sum += texelFetch(tInput, t, 0) * w;
      wsum += w;
    }
  }
  outGI = wsum > 1e-6 ? sum / wsum : texelFetch(tInput, h, 0);
}
`;

// Included by PipelineMaterial (ShaderMaterial prefix provides isOrthographic).
export const giChunk = /* glsl */ `
#ifndef GI_CHUNK
#define GI_CHUNK
uniform sampler2D giMap;
uniform float giEnabled;
uniform sampler2D depthTexture;
uniform highp sampler2D giGeoMap;
#ifndef PIPELINE_CAMERA_UNIFORMS
#define PIPELINE_CAMERA_UNIFORMS
uniform float cameraNear;
uniform float cameraFar;
#endif

float giLinearDepth(float d) {
  return isOrthographic
    ? d * (cameraFar - cameraNear) + 1e-3
    : cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

vec3 giOctDecode(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

// Upsamples a half-res buffer laid out like giGeoMap: bilinear over the four texels around this
// pixel, weighted by depth and normal similarity; when none match, the best texel of the 3x3.
// Depth tolerance for giUpsample; widens with the pixel's own depth slope (half-res texels are 2 px
// apart). Call it in uniform control flow (it uses derivatives).
float giDepthTolerance() {
  float z = giLinearDepth(gl_FragCoord.z);
  return 0.02 * z + 2.0 * fwidth(z);
}

// match is 1 when a texel matched this pixel, else the fallback's weight (thin geometry missing from
// the half-res buffer gets a low match).
vec4 giUpsample(sampler2D map, vec3 worldNormal, float zTol, out float match) {
  match = 1.0;
  ivec2 hs = textureSize(map, 0);
  float z = giLinearDepth(gl_FragCoord.z);
  // A zero normal (the no-argument overload) disables the normal weight.
  bool useN = dot(worldNormal, worldNormal) > 0.0;
  vec3 n = useN ? normalize(worldNormal) : vec3(0.0);
  vec2 f = (gl_FragCoord.xy - 0.5) * 0.5;
  ivec2 b = ivec2(floor(f));
  vec2 fr = f - vec2(b);

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    ivec2 t = clamp(b + o, ivec2(0), hs - 1);
    vec4 g = texelFetch(giGeoMap, t, 0);
    float dz = abs(g.x - z) / zTol;
    float wn = useN ? pow(max(dot(n, giOctDecode(g.yz)), 0.0), 8.0) : 1.0;
    vec2 bw = mix(1.0 - fr, fr, vec2(o));
    float w = bw.x * bw.y * exp(-dz) * wn;
    sum += texelFetch(map, t, 0) * w;
    wsum += w;
  }
  if (wsum > 0.02) return sum / wsum;

  vec4 best = vec4(0.0, 0.0, 0.0, 1.0);
  float bestW = 0.0;
  ivec2 c = ivec2(round(f));
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 t = clamp(c + ivec2(x, y), ivec2(0), hs - 1);
      vec4 g = texelFetch(giGeoMap, t, 0);
      float dz = abs(g.x - z) / zTol;
      float wn = useN ? pow(max(dot(n, giOctDecode(g.yz)), 0.0), 8.0) : 1.0;
      float w = exp(-dz) * (0.05 + wn);
      if (w > bestW) {
        bestW = w;
        best = texelFetch(map, t, 0);
      }
    }
  }
  match = bestW;
  return best;
}

vec4 giUpsample(sampler2D map, vec3 worldNormal, float zTol) {
  float match;
  return giUpsample(map, worldNormal, zTol, match);
}

vec4 giUpsample(sampler2D map, vec3 worldNormal) {
  return giUpsample(map, worldNormal, giDepthTolerance());
}

vec4 sampleGI(vec3 worldNormal, float zTol) {
  if (giEnabled < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  return giUpsample(giMap, worldNormal, zTol);
}

vec4 sampleGI(vec3 worldNormal) {
  return sampleGI(worldNormal, giDepthTolerance());
}

vec4 sampleGI() {
  return sampleGI(vec3(0.0));
}
#endif
`;
