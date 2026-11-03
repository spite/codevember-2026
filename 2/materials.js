import { Color, Vector4 } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const noiseGLSL = /* glsl */ `
float fHash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float fNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fHash(i), fHash(i + vec3(1, 0, 0)), f.x), mix(fHash(i + vec3(0, 1, 0)), fHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(fHash(i + vec3(0, 0, 1)), fHash(i + vec3(1, 0, 1)), f.x), mix(fHash(i + vec3(0, 1, 1)), fHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// Distances to the nearest and second nearest cell points.
vec2 fWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 c = i + o;
    vec3 d = o + vec3(fHash(c), fHash(c + 17.31), fHash(c + 41.77)) - f;
    float l = dot(d, d);
    if (l < d1) { d2 = d1; d1 = l; }
    else if (l < d2) d2 = l;
  }
  return vec2(sqrt(d1), sqrt(d2));
}

// Screen-space bump from a height field (Mikkelsen).
vec3 fBump(vec3 N, vec3 pos, float h, float scale) {
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  float dhdx = dFdx(h);
  float dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, N);
  vec3 r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * N - scale * grad);
}
`;

// The shell, for big pieces and chips alike: `shell` runs from 1 outside to 0 inside, so torn edges
// show the outer layer as a rim over the inner one. Patterns: 0 plain, 1 citrus glands, 2 speckle,
// 3 ripple, 4 plaster over rock, 5 bronze over verdigris, 6 obsidian. `glow` lights the inside from within.
function createShellMaterial() {
  return new PipelineMaterial({
    roughness: 0.5,
    sheen: 1,
    sheenColor: 0x000000,
    sheenRoughness: 0.6,
    uniforms: {
      outerColor: { value: new Color() },
      innerColor: { value: new Color() },
      outerRough: { value: 0.3 },
      innerRough: { value: 0.8 },
      rim: { value: 0.2 },
      pattern: { value: 0 },
      outerSpecular: { value: 1 },
      through: { value: 0 },
      outerMetal: { value: 0 },
      glowColor: { value: new Color() },
      glow: { value: 0 },
      rimColor: { value: new Color() },
      film: { value: new Vector4(1.38, 2.6, 260, 620) },
    },
    varyings: { vShell: "float", vHome: "vec3" },
    vertexPars: "in float shell;\nin vec3 home;",
    vertexMain: "vShell = shell;\nvHome = home;",
    fragmentPars:
      noiseGLSL +
      `uniform vec3 outerColor;
uniform vec3 innerColor;
uniform float outerRough;
uniform float innerRough;
uniform float rim;
uniform float pattern;
uniform float outerSpecular;
uniform float through;
uniform float outerMetal;
uniform vec3 glowColor;
uniform float glow;
uniform vec3 rimColor;
uniform vec4 film;
` + rockMetalGLSL,
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition;
  if (pattern > 3.5) {
    rockOrMetal(s, p);
    return;
  }
  float o = smoothstep(1.0 - rim, 1.0 - rim * 0.6, vShell);
  float h = 0.0;
  vec3 outer = outerColor;
  float rough = outerRough;
  if (pattern > 0.5 && pattern < 1.5) {
    // Citrus: oil glands pitting a waxy skin.
    float gland = smoothstep(0.05, 0.55, fWorley(p * 42.0).x);
    outer *= (0.8 + 0.2 * gland) * (0.92 + 0.16 * fNoise(p * 7.0));
    rough += 0.2 * (1.0 - gland);
    h = gland * 0.7;
  } else if (pattern > 1.5 && pattern < 2.5) {
    // Speckle: an eggshell's spots and pores.
    float spot = smoothstep(0.62, 0.75, fNoise(p * 22.0)) * 0.5 + smoothstep(0.7, 0.8, fNoise(p * 60.0)) * 0.3;
    outer *= (1.0 - spot) * (0.94 + 0.12 * fNoise(p * 5.0));
    h = fNoise(p * 120.0) * 0.3;
  } else if (pattern > 2.5) {
    // Ripple: a tempered coating's soft waves.
    h = fNoise(p * 6.0) * 0.6;
  }
  float grain = fNoise(p * 34.0) * 0.6 + fNoise(p * 90.0) * 0.4;
  vec3 inner = innerColor * (0.9 + 0.1 * grain);
  s.albedo = mix(inner, outer, o);
  s.roughness = mix(innerRough, rough, o);
  s.specular = mix(1.0, outerSpecular, o);
  s.sheenColor = vec3(0.1) * (1.0 - o);
  s.transmission = innerColor * through * (1.0 - o);
  h = mix(grain * 0.5, h, o);
  s.normal = fBump(s.normal, vWorldPosition, h * 0.004, 1.0);
}
`,
  });
}

// Patterns 4 to 7, which need more than a tint: faceted glowing rock, metal with a patina, black glass,
// and an interference coating.
const rockMetalGLSL = /* glsl */ `
// CIE 1931 colour matching, as sums of Gaussians (Wyman, Sloan & Shirley 2013).
vec3 cie(float nm) {
  float t1 = (nm - 442.0) * (nm < 442.0 ? 0.0624 : 0.0374);
  float t2 = (nm - 599.8) * (nm < 599.8 ? 0.0264 : 0.0323);
  float t3 = (nm - 501.1) * (nm < 501.1 ? 0.0490 : 0.0382);
  float x = 0.362 * exp(-0.5 * t1 * t1) + 1.056 * exp(-0.5 * t2 * t2) - 0.065 * exp(-0.5 * t3 * t3);
  float u1 = (nm - 568.8) * (nm < 568.8 ? 0.0213 : 0.0247);
  float u2 = (nm - 530.9) * (nm < 530.9 ? 0.0613 : 0.0322);
  float y = 0.821 * exp(-0.5 * u1 * u1) + 0.286 * exp(-0.5 * u2 * u2);
  float v1 = (nm - 437.0) * (nm < 437.0 ? 0.0845 : 0.0278);
  float v2 = (nm - 459.0) * (nm < 459.0 ? 0.0385 : 0.0725);
  float z = 1.217 * exp(-0.5 * v1 * v1) + 0.681 * exp(-0.5 * v2 * v2);
  return vec3(x, y, z);
}

// Reflectance of a film of index n2 and thickness d (nm) on a backing of index n3, seen at cosine
// cos1 from air: the Airy sum of the two reflected waves, for s and p polarisation, per wavelength,
// integrated against the colour matching functions into linear sRGB.
vec3 thinFilm(float cos1, float n2, float n3, float d) {
  float sin1 = sqrt(max(1.0 - cos1 * cos1, 0.0));
  float cos2 = sqrt(max(1.0 - sin1 * sin1 / (n2 * n2), 0.0));
  float cos3 = sqrt(max(1.0 - sin1 * sin1 / (n3 * n3), 0.0));
  float rs12 = (cos1 - n2 * cos2) / (cos1 + n2 * cos2);
  float rp12 = (n2 * cos1 - cos2) / (n2 * cos1 + cos2);
  float rs23 = (n2 * cos2 - n3 * cos3) / (n2 * cos2 + n3 * cos3);
  float rp23 = (n3 * cos2 - n2 * cos3) / (n3 * cos2 + n2 * cos3);
  vec3 xyz = vec3(0.0);
  float white = 0.0;
  for (int i = 0; i < 16; i++) {
    float nm = 400.0 + 20.0 * float(i);
    float c = cos(4.0 * 3.14159265 * n2 * d * cos2 / nm);
    float rs = (rs12 * rs12 + rs23 * rs23 + 2.0 * rs12 * rs23 * c) / (1.0 + rs12 * rs12 * rs23 * rs23 + 2.0 * rs12 * rs23 * c);
    float rp = (rp12 * rp12 + rp23 * rp23 + 2.0 * rp12 * rp23 * c) / (1.0 + rp12 * rp12 * rp23 * rp23 + 2.0 * rp12 * rp23 * c);
    vec3 m = cie(nm);
    xyz += m * 0.5 * (rs + rp);
    white += m.y;
  }
  xyz /= white;
  return max(mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz, 0.0);
}

// An interference coating over a dark backing: its whole reflectance, colour included, comes from
// thinFilm at this angle, so it rides on the real reflections. Thickness wanders across the shape.
void filmSurface(inout Surface s, float o) {
  vec3 V = normalize(cameraPosition - vWorldPosition);
  float cosV = clamp(dot(s.normal, V), 0.0, 1.0);
  float wander = fNoise(vHome * 1.2 + 2.0) * 0.7 + fNoise(vHome * 3.1) * 0.3;
  float d = mix(film.z, film.w, wander);
  vec3 r = thinFilm(cosV, film.x, film.y, d);
  // The coated face reflects like a metal of that colour (its reflectance already holds the Fresnel
  // rise); the broken edges and the inside are the bare backing.
  s.albedo = mix(innerColor, r, o);
  s.metalness = o;
  s.roughness = mix(innerRough, outerRough, o);
  s.specular = mix(1.0, outerSpecular, o);
}

void rockOrMetal(inout Surface s, vec3 p) {
  float o = smoothstep(1.0 - rim, 1.0 - rim * 0.6, vShell);
  float inside = 1.0 - vShell;
  if (pattern > 6.5) {
    filmSurface(s, o);
  } else if (pattern > 5.5) {
    // Smooth black glass outside, burning inside with hotter streaks, running up the broken edges to
    // the rim. Thin glowing cracks web the outside, and a cool rim light catches its edges.
    vec3 q = p * 3.0 + vec3(fNoise(p * 2.0), fNoise(p * 2.0 + 5.2), fNoise(p * 2.0 + 9.7)) * 1.5;
    float f = fNoise(q) * 0.55 + fNoise(q * 2.3) * 0.3 + fNoise(q * 5.1) * 0.15;
    float hot = smoothstep(0.5, 0.75, f);
    vec3 fire = (glowColor * (0.3 + 2.0 * f * f) + vec3(1.0, 0.6, 0.25) * hot * 1.5) * glow;
    vec3 wp = p + vec3(fNoise(p * 4.0), fNoise(p * 4.0 + 3.3), fNoise(p * 4.0 + 6.1)) * 0.12;
    vec2 w = fWorley(wp * 5.0);
    float line = (1.0 - smoothstep(0.0, 0.04, w.y - w.x)) * smoothstep(0.3, 0.6, fNoise(p * 2.0 + 11.0));
    float wall = step(1e-5, fwidth(vShell));
    vec3 V = normalize(cameraPosition - vWorldPosition);
    float rimLight = pow(1.0 - max(dot(s.normal, V), 0.0), 6.0);
    vec3 white = vec3(1.0, 0.8, 0.5);
    s.albedo = mix(vec3(0.08, 0.01, 0.0), outerColor, o) * (1.0 - line * o);
    s.roughness = mix(1.0, outerRough * (0.8 + 0.4 * fNoise(p * 8.0)), o);
    s.specular = mix(0.0, outerSpecular, o);
    // The light lives in the breaks: walls and crack lines burn hot, the inside faces only smoulder.
    s.emissive = fire * (1.0 - o) * mix(0.25, 1.0, wall) + (glowColor + white) * glow * wall * (1.0 - o) * 0.8;
    s.emissive += ((glowColor + white * line) * glow * line + rimColor * rimLight) * o;
  } else if (pattern < 4.5) {
    // Plaster: a coarse tooth. Rock: big flat facets from cell distances, hot only in thin cracks.
    float tooth = fNoise(p * 45.0) * 0.5 + fNoise(p * 110.0) * 0.3 + fNoise(p * 260.0) * 0.2;
    vec2 w = fWorley(p * 9.0);
    float facet = w.x * 0.7 + fWorley(p * 23.0).x * 0.3;
    float seam = 1.0 - smoothstep(0.0, 0.1, w.y - w.x);
    vec3 plaster = outerColor * (0.86 + 0.14 * tooth);
    vec3 rock = innerColor * (0.7 + 0.6 * fNoise(p * 5.0)) * (1.0 - 0.6 * seam);
    s.albedo = mix(rock, plaster, o);
    s.roughness = mix(innerRough, outerRough, o);
    s.specular = mix(1.0, outerSpecular, o);
    float h = mix(facet * 1.8, tooth * 0.6, o);
    s.normal = fBump(s.normal, vWorldPosition, h * 0.01, 1.0);
    // Thin wandering cracks where two noise layers ridge, hot only near the inside.
    float ridge = 1.0 - abs(2.0 * fNoise(p * 4.0 + fNoise(p * 9.0)) - 1.0);
    float crack = smoothstep(0.88, 0.985, ridge) * (0.5 + 0.5 * seam);
    float deep = pow(inside, 3.0);
    float heat = glow * (1.0 - o) * deep * (crack + 0.025 + 0.04 * fNoise(p * 2.0));
    s.emissive = glowColor * heat;
  } else {
    // Bronze: dark worn metal, brighter where rubbed; inside, rough corroded metal with verdigris patches.
    float mottle = fNoise(p * 6.0) * 0.6 + fNoise(p * 19.0) * 0.4;
    float pits = smoothstep(0.08, 0.3, fWorley(p * 30.0).x);
    vec3 bronze = outerColor * mix(0.45, 1.1, mottle * mottle) * mix(0.55, 1.0, pits);
    float green = fNoise(p * 5.0) * 0.6 + fNoise(p * 14.0) * 0.4;
    float spots = smoothstep(0.45, 0.62, green + 0.25 * (1.0 - o) - 0.15);
    vec3 corroded = outerColor * 0.35 * (0.75 + 0.5 * fNoise(p * 18.0));
    vec3 verdigris = innerColor * (0.65 + 0.5 * fNoise(p * 22.0));
    vec3 inner = mix(corroded, verdigris, spots);
    s.albedo = mix(inner, bronze, o);
    s.metalness = mix(1.0 - spots, outerMetal, o);
    s.roughness = mix(mix(0.6, innerRough, spots), mix(0.28, outerRough + 0.2, mottle * (1.0 - 0.5 * pits)), o);
    float h = mix(green * 1.2 + fWorley(p * 20.0).x * 0.6, pits * 0.3 + mottle * 0.15, o);
    s.normal = fBump(s.normal, vWorldPosition, h * 0.006, 1.0);
  }
}
`;

// Molten rock: dark crust plates with glowing cracks between them, or all glowing (molten 0..1 crust).
// `burn` turns the glow into turbulent flame: deep red with hotter streaks.
const moltenGLSL = /* glsl */ `
uniform vec3 glowColor;
uniform float glow;
uniform float molten;
uniform float burn;
void moltenSurface(inout Surface s, vec3 p) {
  if (glow <= 0.0) return;
  float flame = 1.0, hot = 0.0;
  if (burn > 0.0) {
    vec3 q = p * 3.0 + vec3(fNoise(p * 2.0), fNoise(p * 2.0 + 5.2), fNoise(p * 2.0 + 9.7)) * 1.5;
    float f = fNoise(q) * 0.55 + fNoise(q * 2.3) * 0.3 + fNoise(q * 5.1) * 0.15;
    hot = smoothstep(0.5, 0.75, f) * burn;
    flame = mix(1.0, 0.3 + 2.0 * f * f, burn);
    s.specular *= 1.0 - burn;
    s.roughness = mix(s.roughness, 1.0, burn);
  }
  vec2 w = fWorley(p * 7.0);
  float crack = 1.0 - smoothstep(0.0, 0.1 + 0.08 * fNoise(p * 9.0), w.y - w.x);
  float crust = molten * (1.0 - crack);
  s.albedo = mix(s.albedo, vec3(0.03, 0.025, 0.022), crust);
  s.roughness = mix(s.roughness, 0.85, crust);
  s.transmission *= 1.0 - crust;
  s.normal = fBump(s.normal, vWorldPosition, crust * w.x * 0.01, 1.0);
  s.emissive = (glowColor * flame + vec3(1.0, 0.42, 0.08) * hot * 2.5) * glow * mix(1.0, crack * (0.6 + 0.8 * fNoise(p * 4.0)), molten);
}
`;
const moltenUniforms = () => ({ glowColor: { value: new Color() }, glow: { value: 0 }, molten: { value: 0 }, burn: { value: 0 } });

// What was inside: smooth and glossy, or citrus juice sacs; lit through.
function createFillMaterial() {
  return new PipelineMaterial({
    roughness: 0.2,
    sheen: 1,
    sheenColor: 0x000000,
    sheenRoughness: 0.4,
    uniforms: { fillColor: { value: new Color() }, fillRough: { value: 0.1 }, fillThrough: { value: 1 }, sacs: { value: 0 }, ...moltenUniforms() },
    fragmentPars: noiseGLSL + moltenGLSL + "uniform vec3 fillColor;\nuniform float fillRough;\nuniform float fillThrough;\nuniform float sacs;",
    surface: /* glsl */ `
void surface(inout Surface s) {
  vec3 p = vObjectPosition;
  // Juice sacs run along the chunk's length.
  vec2 w = fWorley(vec3(p.x * 1.6, p.y * 6.0, p.z * 6.0));
  float sac = mix(1.0, smoothstep(0.02, 0.35, w.y - w.x), sacs);
  float glow = fNoise(p * 4.0);
  s.albedo = fillColor * mix(0.6, 1.1, sac) * (0.92 + 0.16 * glow);
  s.roughness = mix(0.35, fillRough, sac);
  s.transmission = fillColor * fillThrough;
  s.sheenColor = vec3(0.14) * sac;
  s.specular = 1.4;
  moltenSurface(s, p);
}
`,
  });
}

// A plain solid, for the core and for liquid drops.
function createPlainMaterial({ roughness = 0.05, specular = 1.6, through = 1 } = {}) {
  return new PipelineMaterial({
    roughness,
    uniforms: { plainColor: { value: new Color() }, plainSpecular: { value: specular }, plainThrough: { value: through }, ...moltenUniforms() },
    fragmentPars: noiseGLSL + moltenGLSL + "uniform vec3 plainColor;\nuniform float plainSpecular;\nuniform float plainThrough;",
    surface: /* glsl */ `
void surface(inout Surface s) {
  s.albedo = plainColor * (0.94 + 0.12 * fNoise(vObjectPosition * 30.0));
  s.transmission = plainColor * plainThrough;
  s.specular = plainSpecular;
  moltenSurface(s, vObjectPosition);
}
`,
  });
}

function applySubject(materials, subject) {
  const sh = materials.shell.uniforms;
  const c = subject.shell;
  sh.outerColor.value.set(c.outer);
  sh.innerColor.value.set(c.inner);
  sh.outerRough.value = c.outerRough;
  sh.innerRough.value = c.innerRough;
  sh.rim.value = c.rim;
  sh.pattern.value = c.pattern;
  sh.outerSpecular.value = c.specular;
  sh.through.value = c.through;
  sh.outerMetal.value = c.metal ?? 0;
  sh.glowColor.value.set(c.glowColor ?? 0);
  sh.glow.value = c.glow ?? 0;
  if (c.film) sh.film.value.set(c.film.index, c.film.base, c.film.thin, c.film.thick);
  sh.rimColor.value.set(c.rimColor ?? 0).multiplyScalar(c.rimLight ?? 0);
  const molten = (m, g) => {
    m.uniforms.glowColor.value.set(g?.glowColor ?? 0);
    m.uniforms.glow.value = g?.glow ?? 0;
    m.uniforms.molten.value = g?.molten ?? 0;
    m.uniforms.burn.value = g?.burn ?? 0;
  };
  molten(materials.fill, subject.fill);
  molten(materials.fleck, subject.fill);
  molten(materials.core, subject.core);
  molten(materials.drop, subject.spray.dropGlow);
  if (subject.fill) {
    for (const m of [materials.fill, materials.fleck]) {
      const f = m.uniforms;
      f.fillColor.value.set(subject.fill.color);
      f.fillRough.value = subject.fill.rough;
      f.fillThrough.value = subject.fill.through;
      f.sacs.value = subject.fill.sacs;
    }
  }
  if (subject.core) {
    const u = materials.core.uniforms;
    u.plainColor.value.set(subject.core.color);
    u.plainSpecular.value = subject.core.specular;
    u.roughness.value = subject.core.rough;
  }
  if (subject.spray.dropColor !== undefined) materials.drop.uniforms.plainColor.value.set(subject.spray.dropColor);
}

export { createShellMaterial, createFillMaterial, createPlainMaterial, applySubject };
