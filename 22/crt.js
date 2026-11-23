// A CRT displaying the tape's signal, after crt-guest-advanced (libretro slang-shaders, crt/shaders/guest/advanced):
//   - the signal is linearized (gamma 2.4) and each of its 240 lines drawn as an electron beam: a gaussian across
//     the line whose width grows with brightness and shrinks for saturated channels, the two nearest beams summed
//     and kept from exceeding full intensity;
//   - along the line the beam spot is a short gaussian over the signal's samples, red and blue landing a little
//     off (deconvergence);
//   - an aperture-grille mask of RGB phosphor stripes on the screen's own pixels, strong in the dark and weaker on
//     bright beams, with brightness boosted back the same way;
//   - glow and halation: the picture blurred in two passes at a quarter of the signal's size and added back, the
//     halation through the mask;
//   - a slightly curved face filling the view (no frame) and a vignette.
// amount 0 shows the signal flat.

import { Scene, Mesh, PlaneGeometry, OrthographicCamera, ShaderMaterial, GLSL3, WebGLRenderTarget, HalfFloatType, LinearFilter, NoColorSpace } from "three";

const vertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Separable gaussian over the linearized signal.
const blurShader = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uStep;       // one tap, in uv
  uniform float uSigma;     // in taps
  uniform float uLinearize; // 1: the source is gamma-encoded
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  void main() {
    vec3 s = vec3(0.0);
    float w = 0.0;
    for (int k = -8; k <= 8; k++) {
      float wk = exp(-0.5 * float(k * k) / (uSigma * uSigma));
      vec3 c = texture(tSrc, vUv + uStep * float(k)).rgb;
      s += (uLinearize > 0.5 ? pow(max(c, 0.0), vec3(2.4)) : c) * wk;
      w += wk;
    }
    outColor = vec4(s / w, 1.0);
  }
`;

const crtShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tSignal;
  uniform sampler2D tGlow;
  uniform vec2 uSignal;     // samples per line, lines
  uniform vec2 uRes;
  uniform float uAmount;
  uniform float uMaskPx;    // 2: magenta/green, 3: RGB stripes
  uniform float uOut;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;

  // crt-guest-advanced defaults.
  const float BEAM_MIN = 1.3;       // dark beams: narrow
  const float BEAM_MAX = 1.0;       // bright beams: wide
  const float SHAPE_CENTER = 6.0;
  const float SHAPE_EDGE = 8.0;
  const float SCANS = 0.75;         // saturated channels get thinner beams
  const float H_SHARP = 2.4;
  const float MASK_BRIGHT = 0.35;   // mask strength on bright beams
  const float MASK_DARK = 1.0;      // and in the dark
  const float BOOST_DARK = 1.4;
  const float BOOST_BRIGHT = 1.1;
  const float GLOW = 0.03;
  const float HALATION = 0.06;
  const float DECONVERGE = 0.3;     // samples

  // Barrel curvature, zoomed so the bent edges still fill the screen.
  vec2 warp(vec2 uv, float k) {
    vec2 c = uv * 2.0 - 1.0;
    c *= vec2(1.0 + c.y * c.y * 0.045 * k, 1.0 + c.x * c.x * 0.065 * k);
    c /= 1.0 + 0.065 * k;
    return c * 0.5 + 0.5;
  }
  // The signal along one line at x (in samples), through the beam spot's gaussian, linear light.
  vec3 along(float row, float x) {
    float x0 = floor(x - 0.5);
    vec3 s = vec3(0.0);
    float w = 0.0;
    for (int k = -1; k <= 2; k++) {
      float sx = x0 + float(k);
      float d = sx + 0.5 - x;
      float wk = exp2(-H_SHARP * d * d);
      vec3 c = texelFetch(tSignal, ivec2(clamp(sx, 0.0, uSignal.x - 1.0), clamp(row, 0.0, uSignal.y - 1.0)), 0).rgb;
      s += pow(max(c, 0.0), vec3(2.4)) * wk;
      w += wk;
    }
    return s / w;
  }
  vec3 lineColor(float row, float x) {
    return vec3(along(row, x + DECONVERGE).r, along(row, x).g, along(row, x - DECONVERGE).b);
  }
  // A beam's profile at distance f (in lines) from its centre.
  vec3 beam(float f, vec3 c) {
    float mc = max(max(c.r, c.g), c.b) + 1e-6;
    float bright = pow(mc, 1.0 / 2.4);
    float width = mix(BEAM_MIN, BEAM_MAX, bright);
    vec3 sat = mix(vec3(1.0 + SCANS), vec3(1.0), c / mc);
    float shape = mix(SHAPE_CENTER, SHAPE_EDGE, f);
    float ex = f * width;
    return exp2(-shape * ex * ex * sat);
  }

  void main() {
    float a = uAmount;
    vec2 uv = clamp(warp(vUv, a), 0.0, 1.0);
    vec2 sp = uv * uSignal;
    float ty = sp.y - 0.5;
    float r0 = floor(ty);
    float f = ty - r0;
    vec3 c1 = lineColor(r0, sp.x), c2 = lineColor(r0 + 1.0, sp.x);
    vec3 w1 = beam(f, c1), w2 = beam(1.0 - f, c2);
    vec3 ws = w1 + w2;
    float wm = max(max(ws.r, ws.g), ws.b);
    if (wm > 1.0) {
      w1 /= wm;
      w2 /= wm;
    }
    vec3 color = c1 * w1 + c2 * w2;

    // Aperture grille on the screen's pixels; its strength and the boost back both follow brightness.
    float mx = pow(max(max(color.r, color.g), color.b), 1.0 / 2.4);
    float strength = clamp(mix(MASK_DARK, MASK_BRIGHT, mx), 0.0, 1.0);
    float px = mod(floor(gl_FragCoord.x / max(1.0, floor(uRes.x / 2400.0 + 0.5))), uMaskPx);
    vec3 stripe = uMaskPx > 2.5 ? (px < 0.5 ? vec3(1, 0, 0) : px < 1.5 ? vec3(0, 1, 0) : vec3(0, 0, 1)) : (px < 0.5 ? vec3(1, 0, 1) : vec3(0, 1, 0));
    vec3 mask = mix(vec3(1.0), stripe, strength);
    // The mask's average light, given back, then a little more for dark beams.
    float average = uMaskPx > 2.5 ? (1.0 + 2.0 * (1.0 - strength)) / 3.0 : 1.0 - 0.5 * strength;
    color *= mask / average * mix(BOOST_DARK, BOOST_BRIGHT, mx) / BOOST_BRIGHT;

    // Glow over everything, halation through the mask.
    vec3 glow = texture(tGlow, uv).rgb;
    color += glow * GLOW + glow * HALATION * mix(vec3(1.0), mask, 0.35);

    vec2 d = uv - 0.5;
    color *= 1.0 - dot(d, d) * 0.6;
    vec3 flat_ = pow(max(texture(tSignal, uv).rgb, 0.0), vec3(2.4));
    outColor = vec4(mix(flat_, color, a) * uOut, 1.0);
  }
`;

export function createCRT() {
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new PlaneGeometry(2, 2);
  function pass(fragmentShader, uniforms) {
    const mesh = new Mesh(quad, new ShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false }));
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });
    return { scene, uniforms, target };
  }
  const blurU = () => ({ tSrc: { value: null }, uStep: { value: [0, 0] }, uSigma: { value: 1 }, uLinearize: { value: 0 } });
  const blurH = pass(blurShader, blurU());
  const blurV = pass(blurShader, blurU());
  const uniforms = {
    tSignal: { value: null },
    tGlow: { value: blurV.target.texture },
    uSignal: { value: [760, 240] },
    uRes: { value: [1280, 720] },
    uAmount: { value: 1 },
    uMaskPx: { value: 3 },
    uOut: { value: 1.6 },
  };
  const main = pass(crtShader, uniforms);

  function draw(renderer, p) {
    renderer.setRenderTarget(p.target);
    renderer.render(p.scene, ortho);
  }

  // signal: { texture, width, lines } from the VHS.
  function render(renderer, signal, { width, height }) {
    const gw = Math.max(8, Math.round(signal.width / 4)), gh = Math.round(signal.lines / 4);
    if (blurH.target.width !== gw) blurH.target.setSize(gw, signal.lines);
    if (blurV.target.width !== gw) blurV.target.setSize(gw, gh);
    if (main.target.width !== width || main.target.height !== height) main.target.setSize(width, height);
    const prev = renderer.getRenderTarget();
    // Glow: about 16 samples across and 4 lines tall (sigma), on a quarter-size copy.
    const bh = blurH.uniforms, bv = blurV.uniforms;
    bh.tSrc.value = signal.texture;
    bh.uStep.value = [2 / signal.width, 0];
    bh.uSigma.value = 4;
    bh.uLinearize.value = 1;
    draw(renderer, blurH);
    bv.tSrc.value = blurH.target.texture;
    bv.uStep.value = [0, 1 / signal.lines];
    bv.uSigma.value = 4;
    draw(renderer, blurV);
    uniforms.tSignal.value = signal.texture;
    uniforms.uSignal.value = [signal.width, signal.lines];
    uniforms.uRes.value = [width, height];
    // RGB stripes need three pixels a triad; on a narrow canvas, magenta/green pairs.
    uniforms.uMaskPx.value = width >= 1100 ? 3 : 2;
    draw(renderer, main);
    renderer.setRenderTarget(prev);
    return main.target.texture;
  }

  return { uniforms, render };
}
