// How every kelp vertex moves: the shared vertex code of the kelp's main, depth and shadow materials.

// Blades per row of the blade textures (one texel per blade); kelpPhysics.js writes them the same way.
export const BLADE_ROW = 2048;

export const kelpUniforms = {
  uTime: { value: 0 },
  uSurge: { value: 1 },
  uStipeDeltaTex: { value: null },
  uBladeQuatTex: { value: null },
  uBladeRestTex: { value: null },
};

// Every kelp vertex moves with its stipe, drawn as a Catmull-Rom curve through the physics nodes. A blade turns toward its
// tip particle and bends along a circular arc, so a flexible blade keeps its base and curves to meet the tip; a blade
// without physics leans with its stipe's sway. Slow waves and a twist run down every blade at a pace of its own, tilting
// its normal so bands of light sweep along it.
export const KELP_VERTEX_GLSL = /* glsl */ `
uniform float uTime;
uniform float uSurge;
uniform sampler2D uStipeDeltaTex;
uniform sampler2D uBladeQuatTex;
uniform sampler2D uBladeRestTex;

attribute vec3 aColumnSeed; // x: column, y: blade age, z: variation
attribute vec4 aBladeParam; // x: height on the stipe, y: blade u, z: blade v, w: thickness
attribute vec3 aAttachPos;
attribute float aBladeId;

vec3 rotateAbout(vec3 v, vec3 a, float angle) {
  float c = cos(angle), s = sin(angle);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

float kelpSpeed;  // the flow past the stipe there (m/s)
vec4 kelpInfo;    // kind, age, blade flexibility
vec3 kelpAlong;   // a blade's direction along and across, for the bumps
vec3 kelpAcross;

// A stipe's offset from rest (xyz) and the flow past it (w) at height h, Catmull-Rom through its nodes.
vec4 stipeNode(int col, float h) {
  float f = clamp(h, 0.0, 1.0) * float(SEGS - 1);
  float i0 = min(floor(f), float(SEGS - 2));
  float t = f - i0;
  int i = int(i0);
  vec4 p0 = texelFetch(uStipeDeltaTex, ivec2(max(i - 1, 0), col), 0);
  vec4 p1 = texelFetch(uStipeDeltaTex, ivec2(i, col), 0);
  vec4 p2 = texelFetch(uStipeDeltaTex, ivec2(i + 1, col), 0);
  vec4 p3 = texelFetch(uStipeDeltaTex, ivec2(min(i + 2, SEGS - 1), col), 0);
  float t2 = t * t, t3 = t2 * t;
  return 0.5 * (p0 * (2.0 * t2 - t - t3) + p1 * (2.0 - 5.0 * t2 + 3.0 * t3) + p2 * (t + 4.0 * t2 - 3.0 * t3) + p3 * (t3 - t2));
}

void kelpDeform(inout vec3 pos, inout vec3 nrm) {
  int col = int(aColumnSeed.x + 0.5);
  vec4 node = stipeNode(col, aBladeParam.x);
  kelpSpeed = max(node.w, 0.0);
  kelpInfo = texelFetch(uStipeDeltaTex, ivec2(SEGS, col), 0);
  kelpAlong = vec3(0.0, 1.0, 0.0);
  kelpAcross = vec3(1.0, 0.0, 0.0);
  if (aBladeId >= 0.0) {
    int b = int(aBladeId + 0.5);
    ivec2 tc = ivec2(b % ${BLADE_ROW}, b / ${BLADE_ROW});
    vec4 rest = texelFetch(uBladeRestTex, tc, 0);
    float L = abs(rest.w);
    float alpha = 0.0;
    vec3 axis = vec3(0.0, 1.0, 0.0);
    if (rest.w > 0.0) {
      vec4 q = texelFetch(uBladeQuatTex, tc, 0);
      alpha = 2.0 * acos(clamp(q.w, -1.0, 1.0));
      float sa = length(q.xyz);
      if (sa > 1e-5) axis = q.xyz / sa;
    } else {
      // Without physics of its own, a blade leans the way its stipe sways.
      vec3 ax = cross(rest.xyz, node.xyz);
      float la = length(ax);
      if (la > 1e-4) {
        axis = ax / la;
        alpha = min(la * 0.35, 0.6);
      }
    }
    // The chord turns by alpha; the blade curves through phi along it, capped so a soft ribbon never curls into a loop.
    float phi = min(2.0 * alpha * kelpInfo.z, 2.4);
    float base = alpha - 0.5 * phi;
    vec3 r = pos - aAttachPos;
    float s = dot(r, rest.xyz);
    vec3 lat = r - s * rest.xyz;
    vec3 f0 = rotateAbout(rest.xyz, axis, base);
    vec3 b0 = cross(axis, f0);
    float k = phi / max(L, 1e-3);
    float ang = k * s;
    vec3 c = abs(k) > 1e-4 ? f0 * (sin(ang) / k) + b0 * ((1.0 - cos(ang)) / k) : f0 * s;
    vec3 along = f0 * cos(ang) + b0 * sin(ang);
    vec3 n1 = rotateAbout(nrm, axis, base + ang);

    // Waves and a twist about the centre line run from base to tip at the blade's own steady pace (linear in time, so
    // they never chirp), larger in faster flow past it.
    float u = aBladeParam.y;
    float h1 = fract(aBladeId * 0.618034), h2 = fract(aBladeId * 0.371);
    float rel = min(kelpSpeed, 0.5);
    float calm = 0.4 + 0.6 * uSurge;
    float D = uTime * (0.12 + 0.12 * h1);
    float kb = 6.2831 / (0.5 * L + 0.3), kt = 6.2831 / (1.1 * L + 0.4);
    float gain = kelpInfo.x < 0.5 ? 1.0 : (kelpInfo.x < 1.5 ? 1.5 : 0.5);
    float ab = gain * L * (0.02 + 0.09 * rel) * u * sqrt(u) * calm;
    float pb = kb * (s - D) + h2 * 6.2831;
    float tw = gain * (0.15 + 0.6 * rel) * u * sin(kt * (s - 0.7 * D) + h1 * 6.2831) * calm;
    vec3 across = normalize(cross(along, n1) + vec3(0.0, 1e-6, 0.0));
    float ct = cos(tw), st = sin(tw);
    vec3 nT = n1 * ct + across * st;
    float wave = sin(pb) * ab;
    // uv.y is the distance across the blade from its centre line.
    pos = aAttachPos + c + rotateAbout(lat, axis, base + ang) + uv.y * (across * (ct - 1.0) - n1 * st) + nT * wave;
    nrm = normalize(nT - along * (ab * kb * cos(pb)));
    kelpAlong = along;
    kelpAcross = normalize(cross(along, nrm) + vec3(0.0, 1e-6, 0.0));
  }
  pos += node.xyz;
}
`;
