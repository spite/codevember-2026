// Feathers over a static form: each a rigid card rooted on the skin (its root, normal, direction and the skin's
// height under it are worked out once on the CPU), pitched up just enough to clear the skin ahead of it and the
// feathers under it there, bent and cupped (Curl), lifted (Angle, Ruffle). The vane, rachis, barbs and down are cut
// and shaded procedurally.
import { Vector3, InstancedBufferGeometry, InstancedBufferAttribute, PlaneGeometry, Mesh, Sphere, DoubleSide, Color, DataTexture, RGBAFormat, FloatType, NearestFilter, Vector2, Vector4 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

// Height off the skin as a function of distance d from the root (in feather lengths): it lifts off the skin, then
// lies down along it. Every feather uses the same increasing curve, so overlapping feathers stay stacked by root
// order and never cross.
const LIFT = 0.006;
const SLOPE = 0.09;
const HUG = 0.025;
const HUG_LENGTH = 0.07;
// The quad is wider than the vane, to leave room for the down at its base.
const PLANE_WIDTH = 1.3;
// Vane width over length.
const ASPECT = 0.42;
const f = (x) => x.toFixed(4);

const featherSurface = /* glsl */ `
uniform vec3 transmissionTint;
uniform float vaneTransmission;
uniform float barbCount;
uniform float featherAlbedo;
uniform float featherCurl;
uniform float stochasticShadow;
uniform float seeThrough;
uniform vec3 palette[4];
// 0 plain, 1 gradient, 2 barred, 3 streaked, 4 mottled, 5 mixed (each feather its own).
uniform float patternKind;
uniform float patternAmount;
// The under-layer's colour, relative to the coat's.
uniform float underShade;
// How dark a feather's covered base gets (0: none).
uniform float internalShadow;
// How much the gradient along the form (vPal.x: the palette's colour to white) replaces the body colour.
uniform float gradientAmount;

float fhash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float vnoise1(float x) {
  float i = floor(x), t = fract(x);
  return mix(fhash(i), fhash(i + 1.0), t * t * (3.0 - 2.0 * t));
}

// A feather's own colouring, like real ones: a pale downy base turning to the body colour, and over it a pattern
// (palette: base, body, dark markings, accent). y runs base to tip, e rachis (0) to edge (1); side picks the vane.
// Markings follow the barbs, so bands bend into chevrons toward the tip.
vec3 featherPigment(float x, float y, float e, float side, float seed, float down, float rc) {
  float h = fhash(seed + 21.7);
  float kind = patternKind > 4.5 ? floor(h * 4.999) + 1.0 : patternKind;
  float amount = patternAmount * (0.75 + 0.5 * fhash(seed + 4.1));
  // Along the form the gradient runs from the palette's colour (its dark one) to white; Gradient sets how much it
  // replaces the plain body colour.
  vec3 ramp = mix(palette[2], vec3(1.0), vPal.x);
  vec3 body = mix(palette[1], ramp, gradientAmount);
  vec3 base = mix(palette[0], mix(palette[0], ramp, 0.6), gradientAmount);
  vec3 c = mix(base, body, smoothstep(0.08, 0.45, y));
  float tip = smoothstep(0.6, 1.0, y);
  float yb = y - 0.16 * e;
  float wob = vnoise1(y * 9.0 + seed * 3.0 + side * 5.0) - 0.5;
  if (kind > 0.5 && kind < 1.5) {
    // Gradient: darkening to the tip, the outer vane a little darker than the inner.
    c = mix(c, palette[2], tip * amount * mix(0.8, 1.0, step(0.0, side)));
  } else if (kind < 2.5 && kind > 1.5) {
    // Barred: bands across the vane, irregular in width, accent between them.
    float freq = mix(5.0, 9.0, fhash(seed + 2.3));
    float rag = vnoise1(e * 7.0 + y * 31.0 + seed) - 0.5;
    float band = fract(yb * freq + 0.25 * wob + 0.12 * rag + h);
    float width = 0.3 + 0.15 * fhash(floor(yb * freq + h) + seed);
    float dark = smoothstep(0.5 - width, 0.62 - width, band) * (1.0 - smoothstep(0.82, 0.95, band));
    c = mix(mix(c, palette[3], 0.6 * amount * smoothstep(0.2, 0.5, y)), palette[2], 0.85 * dark * amount * smoothstep(0.15, 0.35, y));
  } else if (kind < 3.5 && kind > 2.5) {
    // Streaked: a dark wedge along the rachis, widening toward the tip, and pale margins.
    float wedge = 1.0 - smoothstep(0.15 + 0.35 * y, 0.3 + 0.4 * y + 0.1 * wob, e);
    c = mix(c, palette[2], wedge * amount * smoothstep(0.2, 0.5, y));
    c = mix(c, palette[3], smoothstep(0.75, 0.95, e) * 0.6 * amount);
  } else if (kind > 3.5) {
    // Mottled: speckles and blotches, densest toward the tip.
    float n = vnoise1(yb * 23.0 + seed) * 0.6 + vnoise1((yb + x * 0.4) * 47.0 + seed * 1.7) * 0.4;
    float spot = smoothstep(0.55, 0.62, n + 0.15 * tip);
    c = mix(mix(c, palette[3], 0.4 * amount * tip), palette[2], spot * amount * smoothstep(0.2, 0.5, y));
  }
  // The down stays pale; the rachis is pale near the base, darker toward the tip.
  c = mix(c, base, down);
  c = mix(c, mix(base, palette[2], 0.6 * tip * amount), rc * 0.7);
  return c;
}

// A stripe of the given duty cycle over phase q, box-filtered over the pixel footprint w (in stripes).
float filteredStripe(float q, float duty, float w) {
  float a = q - 0.5 * w, b = q + 0.5 * w;
  float ia = floor(a) * duty + min(fract(a), duty);
  float ib = floor(b) * duty + min(fract(b), duty);
  return w > 1e-4 ? (ib - ia) / w : step(fract(q), duty);
}
// The same with a wider filter, settling on its mean before the box filter starts to ring.
float stripeAA(float q, float duty, float w) {
  w = max(w * 1.5, 1e-4);
  return mix(filteredStripe(q, duty, w), duty, smoothstep(0.3, 0.7, w));
}

void surface(inout Surface s) {
  float x = vFeather.x * 2.0 * ${f(PLANE_WIDTH)};   // across, in units of the vane's half width
  float y = vFeather.y;                              // base 0 .. tip 1
  // Snapped: the interpolated varying wobbles a little per pixel, which the sine hashes would turn into grain.
  float seed = floor(vFeather.z * 4096.0 + 0.5) * 0.2239;
  float flight = vFeather.w;                         // 0 coverts .. 1 flight feathers
  float len = vSize.x;
  float halfW = 0.5 * vSize.y;
  float ax = abs(x);
  float side = x < 0.0 ? -1.0 : 1.0;
  float face = gl_FrontFacing ? 1.0 : -1.0;
  float ax_aa = max(fwidth(ax), 1e-4);

  // Barbs leave the rachis leaning toward the tip, curving further near the edge; their spacing is mostly absolute,
  // and slightly irregular and different on the two vanes.
  float lean = 1.1 * (0.9 + 0.4 * fhash(seed + 1.7)) * (1.0 + 0.5 * ax);
  float spacing = mix(len, vSize.z, 0.7) / barbCount;
  float q = (y * len - ax * halfW * lean) / spacing;
  q += side * 0.37 + 0.6 * vnoise1(y * 4.0 + seed + side * 13.0);
  float fq = max(fwidth(q), 1e-4);
  // Barb relief only while barbs are several pixels wide: finer, their normals alias into specular sparkle.
  float resolved = 1.0 - smoothstep(0.06, 0.14, fq);
  // Cut detail (fray, splits, loose down) only once barbs are clearly resolved: below that it reads as holes.
  float rf = 1.0 - smoothstep(0.06, 0.13, fq);
  float barb = floor(q);

  // Barbs clump in groups of about seven: the groups' ends make the outline ragged.
  float g = q / 7.0 + fhash(seed) * 7.0;
  float gi = floor(g);
  float clump = mix(fhash(gi + seed * 3.1), fhash(gi + 1.0 + seed * 3.1), smoothstep(0.8, 1.0, fract(g)));
  float groupsResolved = 1.0 - smoothstep(0.3, 0.7, fq / 7.0);

  // Vane outline: rounded tip, outer vane narrower on flight feathers, ragged barb ends.
  float t = clamp((y - 0.03) / 0.97, 0.0, 1.0);
  float w = pow(sin(3.14159 * pow(t, 0.7 + 0.25 * fhash(seed + 3.3))), 0.55);
  // A wing's flight feathers are long with blunt, rounded tips.
  if (vCup > 0.5 && flight > 0.9) w = sqrt(smoothstep(0.0, 0.2, t)) * sqrt(max(1.0 - pow(max(0.0, (t - 0.78) / 0.22), 2.0), 0.0));
  w *= side > 0.0 ? 1.0 : 1.0 - 0.4 * flight;
  w *= 1.0 - 0.12 * clump * smoothstep(0.4, 1.0, t) * groupsResolved;
  w *= 1.0 - 0.08 * mix(fhash(barb + seed), 0.5, 1.0 - rf);
  w -= (1.0 - rf) * 0.04;
  float vane = 1.0 - smoothstep(w - ax_aa, w + ax_aa, ax);

  // Toward the edge the barbs separate into visible fibres.
  float edge = smoothstep(0.88, 1.0, ax / max(w, 1e-3));
  vane *= mix(1.0, mix(1.0, stripeAA(q, 0.62, fq), rf), edge * 0.7);

  // Splits: at some group boundaries the barbs come apart from the edge inward, in a V-notch.
  float bi = floor(g + 0.5);
  float boundary = abs(g - bi) * 7.0;
  float gh = fhash(bi + seed * 3.1);
  float splitDepth = gh > 0.72 ? 0.25 + 0.6 * fhash(bi + seed) : 0.0;
  float gw = max(1.0, 1.2 * fq) * (1.0 + 1.5 * ax / max(w, 1e-3));
  float gap = 1.0 - smoothstep(gw - fq, gw + fq, boundary);
  float cut = w * (1.0 - splitDepth);
  float inSplit = smoothstep(cut - ax_aa, cut + ax_aa, ax) * gap * (1.0 - smoothstep(0.03, 0.06, fq)) * step(0.001, splitDepth);
  vane *= 1.0 - inSplit;

  // Down at the base: wider than the vane, with loose wavy fibres at its edge; dimmer once they are subpixel.
  float downEnd = mix(0.34, 0.14, flight);
  float down = 1.0 - smoothstep(downEnd - 0.08, downEnd + 0.04, y);
  float qd0 = q * 0.5;
  float rd = 1.0 - smoothstep(0.06, 0.13, fwidth(qd0));
  float qd = qd0 + 0.35 * rd * sin(ax * 9.0 + seed);
  float wDown = (0.55 + 0.7 * smoothstep(0.0, downEnd, y)) * (1.0 - 0.25 * mix(fhash(floor(qd0) + seed), 0.5, 1.0 - rd)) - (1.0 - rd) * 0.1;
  float downOutline = 1.0 - smoothstep(wDown - ax_aa, wDown + ax_aa, ax);
  // Solid inside: only the fringe is loose fibre, and only while the fibres are a few pixels wide.
  float fringe = smoothstep(0.6, 1.0, ax / max(wDown, 1e-3));
  float fibres = mix(1.0, stripeAA(qd, 0.4, max(fwidth(qd), 1e-4)), rd * fringe) * downOutline;
  float cover = mix(vane, fibres, down);

  // Rachis: a tapering shaft, bare at the base (calamus).
  float rw = len * 0.02 * (1.0 - 0.8 * y) / halfW;
  float rc = (1.0 - smoothstep(rw - ax_aa, rw + ax_aa, ax)) * (1.0 - smoothstep(0.95, 0.98, y));
  cover = max(cover * smoothstep(0.02, 0.04, y), rc);
  float coverRaw = cover;
  // One pixel of edge, so the prepass (AO, GI, shadow mask) cuts where the colour pass covers.
  s.alpha = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0);

  // Shading frame: along the feather, across it, and its normal.
  vec3 n = normalize(s.normal);
  vec3 A = normalize(vAlong - dot(vAlong, n) * n);
  vec3 C = normalize(vAcross - dot(vAcross, n) * n - dot(vAcross, A) * A);
  // Cupped vane: a sheet convex on top, so its edges face outward; seen from below the tilt reverses.
  vec3 nn = n + C * x * 0.3 * face * vCup;
  // Barbs and rachis are cylinders: their normals point away from their axes from either side. Across a barb the
  // normal sweeps toward increasing q, gently, and only while the barbs are a few pixels wide.
  vec3 Pb = normalize(A - side * lean * C);
  float profile = sin(6.2831853 * q);
  nn += Pb * profile * 0.12 * (1.0 - smoothstep(0.03, 0.08, fq)) * (1.0 - down);
  // Wing and tail feathers are stacked too tightly to bend in geometry: their own twist and bow are shaded instead.
  if (vCup > 0.5) {
    float tw = (fhash(seed + 5.1) - 0.5) * 0.6 * y;
    float bow = (fhash(seed + 8.2) - 0.3) * 0.5 * (y - 0.4);
    nn += featherCurl * face * (C * tw + A * bow);
  }
  float rachisResolved = smoothstep(0.5, 2.0, rw / ax_aa);
  nn += C * clamp(x / max(rw, 1e-3), -1.0, 1.0) * 0.35 * rc * rachisResolved;
  // The vane dips into a shallow trough along the rachis.
  nn -= C * side * 0.06 * exp(-ax / (3.0 * max(rw, 1e-3))) * face * rachisResolved * (1.0 - rc);
  s.normal = normalize(nn);

  // White keratin (n ~1.56) full of air: it scatters, it barely absorbs. A dense vane reflects ~0.62 and passes ~0.3;
  // thin tips, margins and loose fibres pass more and reflect less; the foam-filled rachis reflects most and passes
  // little. R + T stays at ~0.95.
  float thin = max(max(smoothstep(0.6, 1.0, ax / max(w, 1e-3)), smoothstep(0.7, 1.0, y)), edge * rf);
  float thick = 1.0 - thin;
  float groupTone = 0.97 + 0.06 * fhash(gi + seed * 5.7);
  float groove = mix(1.0, 0.9 + 0.1 * (0.5 + 0.5 * profile), resolved * (1.0 - down));
  vec3 pal = featherPigment(x, y, ax / max(w, 1e-3), side, seed, down, rc);
  pal *= 0.95 + 0.1 * fhash(seed + 11.3);
  // The under-layer can be shaded darker, for depth between the coat's feathers.
  pal *= vLayer > 0.5 ? underShade : 1.0;
  s.albedo *= pal;
  s.albedo *= featherAlbedo * groupTone * groove * mix(0.82, 1.0, thick) * mix(1.0, 1.12, rc) * mix(1.0, 0.9, down * (1.0 - rd));
  // Transmitted light is warmer the thicker the sheet it went through.
  vec3 tint = pow(transmissionTint, vec3(mix(0.6, 1.6, thick)));
  float tr = mix(mix(0.85, 0.5, thick), 0.15, rc);
  // Where a vane covers others, the light they send back through it brightens it (R of the stack ~0.75).
  float lifted = smoothstep(1.1, 2.0, vRuffle) * smoothstep(0.3, 0.9, y);
  // The underside faces the coat, which sends back much of what it receives (screen-space GI can't see it, hidden
  // behind the feather): it gets the same lift.
  float boost = face > 0.0 ? mix(1.0, 1.2, (1.0 - lifted) * (1.0 - 0.5 * thin) * (1.0 - rc)) : mix(1.0, 1.25, 1.0 - rc);
  s.albedo *= boost;
  // Pigment absorbs the light passing through too, so backlit colour is deeper.
  s.transmission = tint * pal * tr / boost;
  // Smooth keratin cortex: a tight lobe along the barbs, wide across them (a satin streak).
  float rough = 0.42 + 0.1 * (1.0 - resolved) * (1.0 - down);
  rough = mix(rough, 0.3, rc);
  rough = mix(rough, 0.85, down);
  // Specular antialiasing: roughness grows with the normal's variation across the pixel, and the anisotropy fades.
  vec3 dn = fwidth(s.normal);
  float sv = clamp(2.0 * dot(dn, dn), 0.0, 0.18);
  rough = sqrt(clamp(rough * rough + sv, 0.0, 1.0));
  s.roughness = rough;
  s.specular = 1.2;
  s.sheenColor = vec3(mix(0.1, 0.45, max(down, edge * rf)));
  s.sheenRoughness = mix(0.5, 0.7, down);
  s.anisotropy = 0.8 * (1.0 - down) * (1.0 - rc) * (1.0 - smoothstep(0.02, 0.12, sv));
  s.anisotropyDirection = Pb;
  // Thin vanes and loose fibres scatter forward: backlit edges and tips glow toward the light.
  s.transmissionForward = mix(0.3, 0.65, max(thin, down)) * (1.0 - rc);
  // Outside, the far side is the body and the lit feathers below, open where a lifted tip clears them.
  s.transmissionOcclusion = face > 0.0 ? mix(vCup > 0.5 ? 0.35 : 0.2, 0.6, lifted * smoothstep(0.5, 1.0, y)) : mix(0.45, 1.0, smoothstep(0.35, 1.0, y));
  // At the silhouette a vane's tip is seen edge-on with nothing but open sky behind it: it passes the background's
  // light through, so the outline glows rather than greys.
  float grazing = 1.0 - abs(dot(normalize(cameraPosition - vWorldPosition), normalize(s.normal)));
  s.transmissionOcclusion = mix(s.transmissionOcclusion, 1.0, smoothstep(0.55, 0.95, grazing) * smoothstep(0.4, 0.9, y));
  // The base is buried under the feathers before it (screen-space AO does the rest).
  // Where the feathers in front cover it: the base of each vane is buried, so it gets less of everything (the key
  // through the layers above, and the sky); the exposed tip gets all of it. Internal shadow scales it.
  float buried = (1.0 - smoothstep(0.1, 0.7, y)) * (1.0 - 0.5 * lifted) * step(0.0, face);
  // Seen edge-on the vane is a row of round barbs, lit from any side the eye is on, not a flat sheet edge-on to the key.
  s.fiber = smoothstep(0.4, 0.9, grazing) * (1.0 - rc);
  s.fiberAxis = Pb;
  // Seen edge-on at the silhouette, the base isn't hidden behind the feathers in front: no darkening there.
  buried *= 1.0 - smoothstep(0.45, 0.85, grazing);
  s.occlusion = mix(1.0, 0.35, buried * internalShadow);
  s.albedo *= mix(1.0, 0.6, buried * internalShadow);
  s.transmission *= mix(1.0, 0.5, buried * internalShadow);
#ifdef PIPELINE_SHADOW
  if (stochasticShadow > 0.5) {
    // A screen door: the feather blocks the light at a fraction of points equal to the light it doesn't pass on. The
    // points are pinned to the feather (no flicker), and the shadow lookups average them over a wide disc
    // (shadowMinTexels), so stacked feathers multiply into partial, layered shadow.
    float opacity = coverRaw * clamp(1.0 - shadowLayerT * mix(1.0, 1.4, thin) * mix(1.0, 0.3, rc), 0.0, 1.0);
    vec2 cell = floor(vFeather.xy * vec2(60.0, 140.0)) + floor(vFeather.z * 4096.0) * vec2(7.0, 3.0);
    float thresh = fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
    s.alpha = opacity > thresh ? 1.0 : 0.0;
  } else {
    s.alpha = coverRaw;
  }
#else
  if (seeThrough > 0.0 && vLayer < 0.5) {
    // Stochastic transparency: each covered pixel is kept with the feather's opacity, drawn afresh per frame and per
    // feather, so stacked feathers multiply and the still average converges to the layered blend. Each opening shows
    // (and shades) the feather below, so it is capped, and the under-layer stays opaque, as the floor it opens onto.
    float open = min(seeThrough * mix(mix(0.25, 0.7, thin), 0.85, down), 0.6) * (1.0 - rc);
    vec2 np = gl_FragCoord.xy + 5.588238 * mod(frame, 64.0) + 512.0 * vec2(fhash(seed + 1.7), fhash(seed + 2.9));
    if (fract(52.9829189 * fract(dot(floor(np), vec2(0.06711056, 0.00583715)))) < open) s.alpha = 0.0;
  }
#endif
}
`;

// The centre line the forms are bent onto: count samples evenly spread over u = 0..1 (rows: position + T.x, N + T.y,
// B + T.z; then last frame's), spineLength long. Each feather set is laid out on its own straightened tube (x along,
// y and z across; shape: length, radius, closed, taper) and mapped onto it by u. While a form morphs from shapeA to
// shapeB (morphT), the tube's radius blends between theirs and each set is scaled from its own to it.
const spineGLSL = /* glsl */ `
uniform sampler2D spineTex;
uniform float spineCount;
uniform float spineLength;
uniform vec4 shapeA;
uniform vec4 shapeB;
uniform float morphT;
uniform float layoutIsB;
// Breathing: the tube's girth scale now and last frame.
uniform vec2 breath;
// Where this set's u sits on the spine: offset and direction.
uniform vec2 uMap;
float formRadius(vec4 sh, float u) {
  if (sh.z > 0.5) return sh.y;
  float L = sh.x, r = sh.y, tp = sh.w;
  float d = clamp(u, 0.0, 1.0) * L;
  float w = 1.0 - tp * d / L;
  float head = 1.4 * r, tail = 1.4 * r * (1.0 - tp);
  float c = 1.0;
  if (d < head) {
    float x = 1.0 - d / head;
    c = sqrt(max(1.0 - x * x, 1e-6));
  } else if (L - d < tail) {
    float x = 1.0 - (L - d) / tail;
    c = sqrt(max(1.0 - x * x, 1e-6));
  }
  return r * w * c;
}
void spineFrame(float u, out vec3 P, out vec3 T, out vec3 N, out vec3 B) {
  int base = pipelinePrevPose ? 3 : 0;
  float n = spineCount - 1.0;
  float fx = u * n;
  float f = clamp(fx, 0.0, n - 0.001);
  // Past the ends, straight on.
  float extra = (fx - f) * spineLength / n;
  int i0 = int(floor(f));
  float t = f - float(i0);
  int i1 = i0 + 1;
  vec4 a0 = texelFetch(spineTex, ivec2(i0, base), 0), a1 = texelFetch(spineTex, ivec2(i1, base), 0);
  vec4 b0 = texelFetch(spineTex, ivec2(i0, base + 1), 0), b1 = texelFetch(spineTex, ivec2(i1, base + 1), 0);
  vec4 c0 = texelFetch(spineTex, ivec2(i0, base + 2), 0), c1 = texelFetch(spineTex, ivec2(i1, base + 2), 0);
  T = normalize(mix(vec3(a0.w, b0.w, c0.w), vec3(a1.w, b1.w, c1.w), t));
  P = mix(a0.xyz, a1.xyz, t) + T * extra;
  N = normalize(mix(b0.xyz, b1.xyz, t));
  N = normalize(N - dot(N, T) * T);
  B = cross(T, N);
}
// A point of this set's straightened layout onto the line; F takes its vectors there.
vec3 toSpine(vec3 X, out mat3 F) {
  vec4 own = layoutIsB > 0.5 ? shapeB : shapeA;
  // A closed layout wraps only past its ends, so its far end stays at u = 1 (where a loop opens).
  float x = own.z > 0.5 && (X.x < 0.0 || X.x > own.x) ? mod(X.x, own.x) : X.x;
  float u = x / own.x;
  float us = uMap.y > 0.0 ? u + uMap.x : uMap.x - u;
  if (own.z > 0.5) us = fract(us);
  vec3 P, T, N, B;
  spineFrame(us, P, T, N, B);
  T *= uMap.y;
  B *= uMap.y;
  float ref = formRadius(own, u);
  float rad = mix(formRadius(shapeA, u), formRadius(shapeB, u), morphT);
  float k = ref > 1e-4 ? clamp(rad / ref, 0.0, 1.6) : 1.0;
  F = mat3(T, N, B);
  return P + (N * X.y + B * X.z) * k * (pipelinePrevPose ? breath.y : breath.x);
}
`;

const vertexPars = /* glsl */ `
in vec4 aRoot;
in vec4 aNorm;
in vec4 aDir;
in vec4 aSkin;
in vec4 aShape;
${spineGLSL}
uniform float ruffle;
uniform float featherScale;
uniform float featherAngle;
uniform float featherLean;
uniform float featherCurl;
// How far the top layer's roots sit above the skin, over the under-layer (0 without one).
uniform float underLift;
// Feather length and width as multipliers on the laid-out feathers (live: nothing is rebuilt).
uniform float featherStretch;
uniform float featherWidthScale;
// -1 while this set fades out of a morph, 1 while it grows in.
uniform float fadeDir;
// A rouse now and then (0..1, like a bird shaking its plumage), and the pointer: a ray (object space) and how much it
// stirs the feathers near it.
uniform float rouse;
// Where the rouse's wave front is along the form (u, 0..1; it travels once round).
uniform float rouseFront;
// The rouse's origin (u), direction (1 or -1), settling length (u), and whether it spreads both ways (1).
uniform vec4 rouseShape;
// The body's shake now (-1..1): stirred feathers swing with it.
uniform float rouseSwing;
// A swipe along the form: where (u), which side (angle round the tube), strength, and half width (u).
uniform vec4 swipe;
// A gust of wind (0..1): lifts the whole plumage a little, unevenly, and makes it flutter.
uniform float gust;
// Which way it blows (object space, unit).
uniform vec3 gustDir;
uniform vec3 pointerOrigin;
uniform vec3 pointerDir;
uniform float pointerStir;
// The gradient's cycles along the form; round a closed one it wraps, on an open one it runs head to tail and back.
uniform float gradientRepeat;
uniform float gradientClosed;
vec3 featherAlong;
vec3 featherAcross;
float featherRuffle;

float rhash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float rnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rhash(i), rhash(i + vec3(1, 0, 0)), f.x), mix(rhash(i + vec3(0, 1, 0)), rhash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(rhash(i + vec3(0, 0, 1)), rhash(i + vec3(1, 0, 1)), f.x), mix(rhash(i + vec3(0, 1, 1)), rhash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// How much feathers lift at a point of the skin: a fixed pattern a couple of feathers across that breathes slowly in
// place. It depends on the point only, so every feather stacked there is scaled alike and their order is kept.
float ruffleAt(vec3 R) {
  vec3 q = R / (1.6 * featherScale);
  float n = rnoise(q) * 0.7 + rnoise(q * 2.3 + 7.1) * 0.3;
  float breathe = 1.0 + 0.08 * sin(time * 0.5 + n * 6.2831853);
  return max(1.0 + ruffle * (n * 2.0 - 1.0), 0.35) * breathe;
}
// How far an arc of curvature k drops below its tangent d along it.
float arcOffset(float k, float d) { return abs(k) < 1e-3 ? 0.5 * k * d * d : (1.0 - cos(k * d)) / k; }
// How far a feather has to rise off the skin d along it (k: its size over the nominal one).
float liftCurve(float d, float k) {
  float dk = d / k;
  return k * (${f(LIFT)} + ${f(SLOPE)} * dk + ${f(HUG)} * (1.0 - exp(-dk / ${f(HUG_LENGTH)})));
}
`;

const vertex = /* glsl */ `
vec3 displace(vec3 p, inout vec3 n) {
  vec3 R = aRoot.xyz;
  float L = aRoot.w * featherStretch;
  vec3 n0 = aNorm.xyz;
  float r0 = aNorm.w;
  float k = 1.0;
  vec3 dir = normalize(cos(featherLean) * aDir.xyz + sin(featherLean) * cross(n0, aDir.xyz));
  vec3 across = cross(n0, dir);
  // The under-layer (aShape.y) lies flatter, close to the skin; the top layer is rooted on top of it.
  bool under = aShape.y > 0.5;
  float m = clamp(ruffleAt(R), 0.35, 2.0) * featherAngle * (under ? 0.5 : 1.0);
  // Rousing and the pointer lift the feathers and shake them, each at its own phase; the rouse runs round the form
  // as a wave.
  float ph = fract(aShape.z * 53.1) * 6.2831853;
  // The rouse runs along the form as a wave: feathers puff up as its front reaches them and settle behind it. Each
  // rouse has its own origin, direction and width, and runs one way or spreads both ways from its origin.
  vec4 ownS = layoutIsB > 0.5 ? shapeB : shapeA;
  float uR = R.x / ownS.x;
  float x = (uR - rouseShape.x) * rouseShape.y;
  x = ownS.z > 0.5 ? fract(x) : clamp(x, -1.0, 2.0);
  if (rouseShape.w > 0.5) x = ownS.z > 0.5 ? min(x, 1.0 - x) : abs(uR - rouseShape.x);
  float behind = rouseFront - x;
  float stir = rouse > 0.0 ? rouse * (behind < 0.0 ? exp(-behind * behind / 0.0016) : exp(-behind / rouseShape.z)) : 0.0;
  // Wind: feathers facing it are pressed flat, those on the lee side lift and flutter, all lean downwind, and the
  // flutter runs across the form with the gust (a ripple along the wind).
  vec3 windL = vec3(0.0);
  if (gust > 0.0) {
    mat3 Fw;
    vec3 rootW = toSpine(R, Fw);
    windL = transpose(Fw) * gustDir;
    float facing = dot(n0, windL);
    float ripple = 0.5 + 0.5 * sin(dot(rootW, gustDir) * 4.0 - time * 9.0);
    m *= 1.0 - 0.45 * gust * smoothstep(0.0, 0.6, -facing);
    stir += gust * smoothstep(-0.2, 0.6, facing) * (0.3 + 0.9 * ripple);
  }
  float stirR = stir;
  // The swipe stirs a short stretch of the tube, all the way round it, as it passes (and those behind it settle).
  if (swipe.z > 0.0) {
    float du = uR - swipe.x;
    if (ownS.z > 0.5) du -= floor(du + 0.5);
    stir += swipe.z * exp(-du * du / (swipe.w * swipe.w)) * 2.0;
  }
  if (pointerStir > 0.0) {
    mat3 Fr;
    vec3 root = toSpine(R, Fr);
    vec3 d = root - pointerOrigin;
    float along = max(dot(d, pointerDir), 0.0);
    float dist = length(d - pointerDir * along);
    stir += pointerStir * exp(-dist * dist / (0.35 * featherScale + 0.25));
  }
  stir = min(stir, 1.5);
  // The rouse swings with the body's shake (each feather a little late); the pointer makes them quiver.
  float stirP = max(stir - stirR, 0.0);
  float shake = (stirR * mix(rouseSwing, sin(time * 34.0 + ph), 0.25) + stirP * sin(time * 34.0 + ph)) / max(stirR + stirP, 1e-3);
  m *= 1.0 + stir * (1.0 + 0.4 * shake);
  // The skin drops away under a feather as the square of its length (a curved surface).
  float hs[4] = float[4](aSkin.x, aSkin.y, aSkin.z, aSkin.w);
  for (int i = 0; i < 4; i++) hs[i] *= featherStretch * featherStretch;
  // Each feather has its own shape: curved down toward its tip by its own amount (sometimes slightly up), cupped more
  // or less, and twisted along its length. The pitch below accounts for the bend, so it still clears.
  float r1 = fract(aShape.z * 7.31), r2 = fract(aShape.z * 13.7), r3 = fract(aShape.z * 29.3);
  // Bends as far as the skin does; like a real rachis it rises steeply off the root to clear the feathers under it
  // there, then bends down so its tip rests on the coat.
  float bendDown = max(0.0, 8.0 * (4.0 * liftCurve(0.25 * L, k) - liftCurve(L, k)) * m / (3.0 * L * L));
  float kb = clamp(-4.0 * (hs[3] - 2.0 * hs[1]) / (L * L) + featherCurl * mix(-0.2, 0.9, r1) / L + bendDown, -0.4 / L, 3.0 / L);
  float tanPitch = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = L * float(i + 1) / 4.0;
    tanPitch = max(tanPitch, (hs[i] + arcOffset(kb, d) + liftCurve(d, k) * m) / d);
  }
  // Stirred feathers stand up (by up to ~35 degrees) and swing side to side.
  float pitch = atan(tanPitch) + stir * (0.45 + 0.15 * shake);
  // Side to side: the rouse swings its feathers strongly (neighbours nearly together), the pointer gently.
  float swingR = sin(time * 38.0 + 6.2831853 * 6.0 * uR + 0.6 * ph);
  dir = normalize(dir + cross(n0, dir) * (stirR * 0.9 * swingR + stirP * 0.35 * shake) + (windL - n0 * dot(windL, n0)) * gust * 0.8);
  across = cross(n0, dir);
  vec3 fwd = cos(pitch) * dir + sin(pitch) * n0;
  vec3 up = cos(pitch) * n0 - sin(pitch) * dir;
  float a = p.y * L;
  float b = p.x * aShape.x * featherWidthScale;
  float W = max(aShape.x * featherWidthScale, 1e-3);
  // Cupped across like the skin it lies on, plus its own cup.
  float bendAcross = min(1.0 / max(r0, 1e-3), 0.7 / W) + featherCurl * mix(-0.3, 1.0, r2) / W;
  float twist = featherCurl * (r3 - 0.5) * 0.6 * a / L;
  // Bent along an arc, so the feather keeps its length.
  float ka = kb * a;
  vec3 along = abs(kb) < 1e-3 ? fwd * a - up * 0.5 * kb * a * a : fwd * (sin(ka) / kb) - up * ((1.0 - cos(ka)) / kb);
  vec3 dA = cos(ka) * fwd - sin(ka) * up;
  vec3 acrossT = cos(twist) * across + sin(twist) * up;
  vec3 dB = acrossT - up * (bendAcross * b);
  vec3 X = R + n0 * (${f(LIFT)} * k + (under ? 0.0 : underLift)) + along + acrossT * b - up * 0.5 * bendAcross * b * b;
  // While morphing, the set leaving shrinks away feather by feather and the arriving one grows in.
  if (fadeDir != 0.0) {
    // Where the two shapes differ most in girth (an open form's rounded ends against a loop), the arriving feathers
    // grow in last and the leaving ones go first, so neither is stretched far.
    vec4 own = layoutIsB > 0.5 ? shapeB : shapeA, other = layoutIsB > 0.5 ? shapeA : shapeB;
    float ur = (own.z > 0.5 ? mod(R.x, own.x) : R.x) / own.x;
    float ratio = formRadius(other, ur) / max(formRadius(own, ur), 1e-4);
    float rnd = fract(aShape.z * 41.7);
    float t0 = 0.85 * rnd;
    if (fadeDir > 0.0 && ratio > 1.4 && ratio < 20.0) t0 = 0.55 + 0.15 * rnd;
    if (fadeDir < 0.0 && ((ratio < 0.7 && ratio > 0.05) || ratio > 1.4)) t0 = 0.1 * rnd;
    float g = smoothstep(t0, t0 + 0.15, morphT);
    X = R + (X - R) * (fadeDir > 0.0 ? g : 1.0 - g);
  }
  // Onto the real line, where this point of the feather is.
  mat3 F;
  vec3 world = toSpine(X, F);
  n = normalize(F * cross(dA, dB));
  if (!pipelinePrevPose) {
    featherAlong = normalize(F * dA);
    featherAcross = normalize(F * dB);
    featherRuffle = m / max(featherAngle, 1e-3);
  }
  return world;
}
`;

// Keratin is faintly cream.
function createFeathers({ color = new Color(1.0, 0.985, 0.955), alphaToCoverage = true } = {}) {
  const uniforms = {
    ruffle: { value: 0.8 },
    featherAngle: { value: 1 },
    featherLean: { value: 0 },
    featherCurl: { value: 0.6 },
    underLift: { value: 0 },
    featherStretch: { value: 1 },
    featherWidthScale: { value: 1 },
    featherScale: { value: 0.36 },
    spineTex: { value: null },
    spineCount: { value: 2 },
    spineLength: { value: 1 },
    shapeA: { value: new Vector4(1, 1, 1, 0) },
    shapeB: { value: new Vector4(1, 1, 1, 0) },
    morphT: { value: 0 },
    layoutIsB: { value: 0 },
    uMap: { value: new Vector2(0, 1) },
    fadeDir: { value: 0 },
    breath: { value: new Vector2(1, 1) },
    rouse: { value: 0 },
    rouseFront: { value: 0 },
    rouseShape: { value: new Vector4(0, 1, 0.12, 0) },
    rouseSwing: { value: 0 },
    swipe: { value: new Vector4(0, 0, 0, 0.03) },
    gust: { value: 0 },
    gustDir: { value: new Vector3(1, 0, 0) },
    pointerOrigin: { value: new Vector3() },
    pointerDir: { value: new Vector3(0, 0, -1) },
    pointerStir: { value: 0 },
    stochasticShadow: { value: 0 },
    seeThrough: { value: 0 },
    transmissionTint: { value: new Color(1, 0.95, 0.86) },
    vaneTransmission: { value: 0.7 },
    featherAlbedo: { value: 0.62 },
    barbCount: { value: 70 },
    palette: { value: [new Color(1, 1, 1), new Color(1, 1, 1), new Color(1, 1, 1), new Color(1, 1, 1)] },
    patternKind: { value: 5 },
    patternAmount: { value: 1 },
    underShade: { value: 1 },
    internalShadow: { value: 0.6 },
    gradientAmount: { value: 0 },
    gradientRepeat: { value: 1 },
    gradientClosed: { value: 1 },
  };
  const bounds = new Sphere();
  // Rigid cards: a few segments carry their curl and cup.
  const plane = new PlaneGeometry(1, 1, 2, 6).translate(0, 0.5, 0);
  // Feathers map x across and y along, so the plane's front would face the skin: flip it outward.
  const ix = plane.index.array;
  for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
  const geometry = new InstancedBufferGeometry();
  geometry.index = plane.index;
  for (const k of ["position", "normal", "uv"]) geometry.setAttribute(k, plane.getAttribute(k));
  geometry.boundingSphere = bounds;
  const material = new PipelineMaterial({
    color,
    side: DoubleSide,
    alphaToCoverage,
    thinSheet: true,
    anisotropy: true,
    uniforms,
    varyings: { vFeather: "vec4", vSize: "vec3", vAlong: "vec3", vAcross: "vec3", vRuffle: "float", vCup: "float", vPal: "vec3", vLayer: "float" },
    vertexPars,
    vertex,
    vertexMain: /* glsl */ `
      vFeather = vec4(position.x, position.y, aShape.z, aShape.w);
      vCup = 0.15;
      vLayer = aShape.y;
      // Where the feather is for its colour: across the form's palette, a body feather, not a flight feather.
      float gu = aDir.w;
      vPal = vec3(0.5 - 0.5 * cos((gradientClosed > 0.5 ? 6.2831853 : 3.1415927) * gu * gradientRepeat), 0.0, 0.0);
      vSize = vec3(aRoot.w * featherStretch, aShape.x * featherWidthScale / ${f(PLANE_WIDTH)}, aRoot.w * featherStretch);
      vAlong = normalize(mat3(modelMatrix) * featherAlong);
      vAcross = normalize(mat3(modelMatrix) * featherAcross);
      vRuffle = featherRuffle;
    `,
    surface: featherSurface,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  // The skin under the feathers: dense down, seen only through gaps.
  const skinMaterial = new PipelineMaterial({
    color: new Color(color).multiplyScalar(0.85),
    roughness: 0.9,
    sheen: 0.8,
    sheenRoughness: 0.6,
    uniforms,
    vertexPars: spineGLSL,
    vertex: /* glsl */ `
      vec3 displace(vec3 p, inout vec3 n) {
        mat3 F;
        vec3 world = toSpine(p, F);
        n = normalize(F * n);
        return world;
      }
    `,
  });
  const skin = new Mesh(undefined, skinMaterial);

  // skinGeometry: the form.
  // width: vane width over the standard (ASPECT of the length).
  // packed: { n, roots, norms, dirs, skins, shapes } from the layout worker (shapes' x before the vane's aspect).
  function build(packed, skinGeometry, size, width = 1) {
    const { n, roots, norms, dirs, skins, shapes } = packed;
    for (let i = 0; i < n; i++) shapes[i * 4] *= ASPECT * width * PLANE_WIDTH;
    // three caches the instance limit of the first attributes it binds; a larger rebuild would be clipped to it.
    delete geometry._maxInstanceCount;
    geometry.setAttribute("aRoot", new InstancedBufferAttribute(roots, 4));
    geometry.setAttribute("aNorm", new InstancedBufferAttribute(norms, 4));
    geometry.setAttribute("aDir", new InstancedBufferAttribute(dirs, 4));
    geometry.setAttribute("aSkin", new InstancedBufferAttribute(skins, 4));
    geometry.setAttribute("aShape", new InstancedBufferAttribute(shapes, 4));
    geometry.instanceCount = n;
    uniforms.featherScale.value = size;
    bounds.center.set(0, 0, 0);
    skin.geometry?.dispose();
    skin.geometry = skinGeometry;
  }

  // The radius of a sphere holding everything.
  function setExtent(radius) {
    bounds.radius = radius;
  }

  // Colours (any CSS/hex): downy base, body, dark markings, accent.
  function setPalette(colors) {
    colors.forEach((c, i) => uniforms.palette.value[i].set(c));
    // The skin is the feathers' own base colour (their down), a little toward the body colour, so gaps fade in.
    skinMaterial.color.set(colors[0]).lerp(new Color(colors[1]), 0.4).multiplyScalar(0.85);
  }

  return { mesh, skin, material, uniforms, build, setExtent, setPalette, get count() { return geometry.instanceCount; } };
}

// The shared centre line: count samples over u = 0..1 from a sampler (u, P, T, N); keepPrev keeps last frame's for
// velocity. Returns the texture and its radius (the furthest sample from the origin).
function createSpine() {
  let tex = null;
  const P = new Vector3(), T = new Vector3(), N = new Vector3(), B = new Vector3();
  function set(count, sample, keepPrev = false) {
    if (!tex || tex.image.width !== count) {
      tex?.dispose();
      tex = new DataTexture(new Float32Array(count * 6 * 4), count, 6, RGBAFormat, FloatType);
      tex.minFilter = tex.magFilter = NearestFilter;
      keepPrev = false;
    }
    const d = tex.image.data;
    const row = count * 4;
    if (keepPrev) d.copyWithin(3 * row, 0, 3 * row);
    let extent = 0;
    for (let i = 0; i < count; i++) {
      sample(i / (count - 1), P, T, N);
      B.crossVectors(T, N);
      d.set([P.x, P.y, P.z, T.x], i * 4);
      d.set([N.x, N.y, N.z, T.y], row + i * 4);
      d.set([B.x, B.y, B.z, T.z], 2 * row + i * 4);
      extent = Math.max(extent, P.length());
    }
    if (!keepPrev) d.copyWithin(3 * row, 0, 3 * row);
    tex.needsUpdate = true;
    return { texture: tex, extent };
  }
  return { set };
}

export { createFeathers, createSpine };
