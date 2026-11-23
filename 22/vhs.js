// A camcorder recording to VHS, modelled as a signal the way ntsc-rs does it (github.com/valadaptive/ntsc-rs), on
// the GPU at the signal's own resolution: 240 lines per field, 4 samples per colour subcarrier cycle.
//   1. camera: the picture (with the camcorder's display burned in) to gamma-encoded YIQ.
//   2. encode: band-limit I and Q, modulate them onto the subcarrier and add luma: one composite signal per line.
//      Noise, snow, the head-switching skew at the bottom and tracking trouble happen to that signal, so a
//      displaced line also shifts the subcarrier's phase and its colour goes wrong, as on a real tape.
//   3. decode: notch the subcarrier out for luma, demodulate what is left into I and Q (dot crawl and rainbows
//      come from what the notch lets through), add tape noise, chroma phase noise and chroma loss.
//   4. tape: the VHS record/playback filters: luma low-passed then sharpened (ringing beside edges), chroma
//      low-passed to a fraction of that, all lines wobbling with the edge wave.
//   5. output: chroma blended with the line above (the playback comb), back to RGB.
// Every filter is ntsc-rs's IIR filter, as its impulse response (computed here) run as a causal FIR, so the
// smear trails to the right as on tape. render() returns the signal (W x 240, gamma-encoded RGB) for the CRT.

import { drawText, drawCassette, drawBattery, drawCorners, textWidth, CELL } from "./osdfont.js";
import { Scene, Mesh, PlaneGeometry, OrthographicCamera, ShaderMaterial, GLSL3, WebGLRenderTarget, HalfFloatType, LinearFilter, NearestFilter, NoColorSpace, CanvasTexture, DataTexture, RedFormat, FloatType } from "three";

// Definition: 1 is a real field (240 lines, ~427 samples per picture height, filters at their true bandwidth).
// Above 1, more lines and samples; the filters work per sample, so they blur that much less of the picture,
// while the wobbles, the tear and the tracking band keep their size on screen.
const DETAIL = 1.5;
const LINES = Math.round(240 * DETAIL);
const FSC = 315e6 / 88;
// Filters are designed at the true sample rate, 4 samples per subcarrier cycle (ntsc-rs designs them at 4x that,
// which spreads every filter over 4x as many samples).
const RATE = FSC * 4;
const KERNEL_MAX = 256;

// ---- Filter design (ntsc-rs ntsc.rs / filter.rs), as impulse responses ----

// IIR impulse response: y[n] = sum num[k] x[n-k] - sum den[k] y[n-1-k].
function impulse(num, den, n = KERNEL_MAX) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = i < num.length ? num[i] : 0;
    for (let k = 0; k < den.length && i - 1 - k >= 0; k++) v -= den[k] * y[i - 1 - k];
    y[i] = v;
  }
  return y;
}
const delta = () => impulse([1], []);
function convolve(a, b) {
  const y = new Float64Array(KERNEL_MAX);
  for (let i = 0; i < KERNEL_MAX; i++) {
    if (!a[i]) continue;
    for (let j = 0; i + j < KERNEL_MAX; j++) y[i + j] += a[i] * b[j];
  }
  return y;
}
const chain = (...ks) => ks.reduce((a, b) => convolve(a, b));
// with_scale(s): s * H + (1 - s); negative s sharpens.
const withScale = (h, s) => h.map((v, i) => s * v + (i === 0 ? 1 - s : 0));
// Part filter, part straight through; the straight part sits at the filter's own delay, so a blend softens the
// smear instead of showing two copies.
const mixDelta = (h, a) => {
  const at = Math.round(centroid(h));
  return h.map((v, i) => a * v + (i === at ? 1 - a : 0));
};
function lowpass(cutoff, rate = RATE) {
  const dt = 1 / rate;
  const tau = 1 / (cutoff * 2 * Math.PI);
  const alpha = dt / (tau + dt);
  return impulse([alpha], [-(1 - alpha)]);
}
// Three one-pole lowpasses in a row (composite-video-simulator's "constant k" filter).
const lowpass3 = (cutoff, rate) => chain(lowpass(cutoff, rate), lowpass(cutoff, rate), lowpass(cutoff, rate));
function notch(freq, quality) {
  const bandwidth = (freq / quality) * Math.PI;
  const f = freq * Math.PI;
  const beta = Math.tan(bandwidth * 0.5);
  const gain = 1 / (1 + beta);
  return impulse([gain, -2 * Math.cos(f) * gain, gain], [-2 * Math.cos(f) * gain, 2 * gain - 1]);
}
// Delay of a kernel, in samples: the centre of its energy (works for band-pass kernels too).
const centroid = (h) => {
  let s = 0, w = 0;
  h.forEach((v, i) => ((s += v * v * i), (w += v * v)));
  return w ? s / w : 0;
};
const trimmed = (h) => {
  const total = h.reduce((a, v) => a + Math.abs(v), 0);
  let n = h.length, tail = 0;
  while (n > 1 && tail + Math.abs(h[n - 1]) < total * 2e-4) tail += Math.abs(h[--n]);
  return n;
};

// SP tape (ntsc-rs's VHSTapeSpeed::SP), sharpening 0.25, luma smear 0.5, composite sharpening 1.
const TAPE = { lumaCut: 2.4e6, chromaCut: 320e3, chromaDelay: 4, sharpen: 0.25, smear: 0.5, compositeSharpen: 1 };

// The kernels, one per row of a float texture: [kernel, delay to take back out when reading].
function designKernels(amount) {
  const rows = [];
  const notchY = notch(0.5, 2);
  // 0-2: encode: input luma notch, I and Q band limits (their delay taken back out, as encoders do).
  const lpI = lowpass3(1.3e6), lpQ = lowpass3(0.6e6);
  rows.push([notchY, 0], [lpI, Math.round(centroid(lpI))], [lpQ, Math.round(centroid(lpQ))]);
  // 3-4: decode: luma = smear(notch(pre(c))), chroma = (1 - notch)(pre(c)), chroma realigned with luma.
  const pre = withScale(lowpass(FSC / 2), -TAPE.compositeSharpen);
  const smear = lowpass(Math.pow(2, -4 * TAPE.smear) * 0.25, 1);
  const kL = chain(pre, notchY, smear);
  const kC = convolve(pre, delta().map((v, i) => v - notchY[i]));
  // Shifting the modulated signal by a sample turns its hue 90 degrees, so only whole subcarrier cycles.
  rows.push([kL, 0], [kC, 4 * Math.round((centroid(kC) - centroid(kL)) / 4)]);
  // 5-7: tape: luma lowpass, the -1.6 single-pole sharpen, VHS sharpening; chroma lowpass then the decoder's
  // output lowpass. Chroma lands TAPE.chromaDelay samples late, as ntsc-rs keeps it.
  const tapeL = mixDelta(chain(lowpass3(TAPE.lumaCut), withScale(lowpass(TAPE.lumaCut), -1.6), withScale(lowpass3(TAPE.lumaCut * 4), -TAPE.sharpen * 2)), amount);
  const tapeC = lowpass3(TAPE.chromaCut);
  const tapeI = mixDelta(convolve(tapeC, lowpass3(1.3e6)), amount);
  const tapeQ = mixDelta(convolve(tapeC, lowpass3(0.6e6)), amount);
  const lag = centroid(tapeL) + TAPE.chromaDelay * amount;
  rows.push([tapeL, 0], [tapeI, Math.round(centroid(tapeI) - lag)], [tapeQ, Math.round(centroid(tapeQ) - lag)]);
  return rows;
}

const vertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const common = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform sampler2D tKern;
  uniform int uLen[8];
  uniform int uDelay[8];
  uniform int uField;
  uniform float uAmount;
  uniform int uW;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  const int LINES = ${LINES};
  const float DETAIL = ${DETAIL.toFixed(3)};

  float kern(int row, int n) {
    return texelFetch(tKern, ivec2(n, row), 0).r;
  }
  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  // Smooth value noise along a line, in [-1, 1].
  float noise1(float x, float seed) {
    float i = floor(x), f = fract(x);
    float a = hash(vec3(i, seed, 1.7)), b = hash(vec3(i + 1.0, seed, 1.7));
    return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
  }
  float fbm1(float x, float seed, int octaves) {
    float s = 0.0, amp = 1.0, norm = 0.0;
    for (int o = 0; o < 5; o++) {
      if (o >= octaves) break;
      s += noise1(x, seed + float(o) * 17.0) * amp;
      norm += amp;
      x *= 2.0;
      amp *= 0.7;
    }
    return s / norm;
  }
  // Smooth value noise over a plane, in [-1, 1].
  float noise2(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(vec3(i, seed)), b = hash(vec3(i + vec2(1, 0), seed));
    float c = hash(vec3(i + vec2(0, 1), seed)), d = hash(vec3(i + vec2(1, 1), seed));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
  }
  // The subcarrier's phase at a sample: it flips every line and every field.
  int phaseOf(int x, int line) {
    return (x + ((uField + line * 2) & 2)) & 3;
  }
  float iMult(int p) { return p == 0 ? 1.0 : p == 2 ? -1.0 : 0.0; }
  float qMult(int p) { return p == 1 ? 1.0 : p == 3 ? -1.0 : 0.0; }
`;

// 1. Camera: average the picture over each sample's footprint, compress the highlights (the camera's knee),
// gamma-encode, burn in the display, to YIQ.
const cameraShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tOSD;
  uniform float uGain;
  uniform float uGrain;
  uniform float uBlue;
  uniform float uRoll;
  vec3 toYIQ(vec3 c) {
    return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.5959, -0.2746, -0.3213)), dot(c, vec3(0.2115, -0.5227, 0.3112)));
  }
  void main() {
    vec2 px = vec2(1.0 / float(uW), 1.0 / float(LINES));
    // Rolling (the tape winding): the picture slides up, the blanking between frames passing as a black bar.
    vec2 suv = vec2(vUv.x, fract(vUv.y + uRoll));
    vec3 c = vec3(0.0);
    for (int i = 0; i < 2; i++)
      for (int j = 0; j < 3; j++) c += texture(tScene, suv + px * vec2((float(i) - 0.5) * 0.5, (float(j) - 1.0) * 0.33)).rgb;
    c = max(c / 6.0, 0.0) * uGain;
    if (uRoll > 0.0) c *= smoothstep(0.0, 0.03, suv.y) * smoothstep(1.0, 0.97, suv.y);
    c = c / (1.0 + c * 0.6);
    c = pow(c, vec3(1.0 / 2.2));
    // Low light: the camera's gain is up, and so is its sensor noise, most in the dark and in colour.
    vec3 h = vec3(gl_FragCoord.xy, float(uField));
    vec3 n = vec3(hash(h), hash(h + 19.1), hash(h + 37.3)) - 0.5;
    c += n * uGrain * (1.0 - 0.7 * dot(c, vec3(0.3, 0.6, 0.1))) * uAmount;
    // Standing by: the camcorder's flat blue screen.
    c = mix(c, vec3(0.08, 0.16, 0.78), uBlue);
    vec4 o = texture(tOSD, vUv);
    c = mix(c, o.rgb, o.a);
    outColor = vec4(toYIQ(c), 1.0);
  }
`;

// 2. Encode to composite, with what happens to that signal: noise, snow, head switching, tracking.
const encodeShader = /* glsl */ `
  uniform sampler2D tCam;
  uniform float uTrack;      // strength of the rolling tracking band
  uniform float uTrackPos;   // its centre line
  vec3 cam(int x, int line) {
    return texelFetch(tCam, ivec2(clamp(x, 0, uW - 1), LINES - 1 - line), 0).rgb;
  }
  float composite(int n, int line) {
    if (n < 0 || n >= uW) return 0.0;
    float y = 0.0, i = 0.0, q = 0.0;
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[0]) break;
      y += kern(0, k) * cam(n - k, line).x;
    }
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[1]) break;
      i += kern(1, k) * cam(n - k + uDelay[1], line).y;
    }
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[2]) break;
      q += kern(2, k) * cam(n - k + uDelay[2], line).z;
    }
    int p = phaseOf(n, line);
    return y + i * iMult(p) + q * qMult(p);
  }
  // Snow: short decaying ringing transients, one starting somewhere in a 64-sample cell now and then.
  float speckles(float x, float line, float rate, float seed) {
    float s = 0.0;
    float cell = floor(x / 64.0);
    for (int c = -1; c <= 0; c++) {
      float ci = cell + float(c);
      vec3 h = vec3(ci, line, seed);
      if (hash(h) > rate) continue;
      float start = ci * 64.0 + hash(h + 1.3) * 64.0;
      float len = 8.0 + hash(h + 2.9) * 56.0;
      float freq = len * (3.0 + 2.0 * hash(h + 4.1));
      float d = x - start;
      if (d < 0.0 || d > len) continue;
      s += cos(d * 3.14159 / freq) * pow(1.0 - d / len, 2.0) * (hash(h + 5.7) * 3.0 - 1.0);
    }
    return s;
  }
  void main() {
    int x = int(gl_FragCoord.x);
    int line = LINES - 1 - int(gl_FragCoord.y);
    float fl = float(line), field = float(uField), a = uAmount;
    float shift = 0.0;
    // Head switching: the last lines of the field skew right, more toward the bottom.
    float hs = (fl - float(LINES) + 6.0 * DETAIL) / DETAIL;
    if (hs >= 0.0) shift += (36.0 * pow((hs + 3.0) / 8.0, 1.5) + hash(vec3(floor(fl / DETAIL), field, 3.0)) - 0.5) * DETAIL * a;
    // Tracking: a band of lines wavering sideways, noisier toward its centre.
    float band = uTrack * smoothstep(9.0 * DETAIL, 0.0, abs(fl - uTrackPos));
    shift += band * noise1(fl / DETAIL * 0.5, field) * 15.0 * 0.5 * DETAIL;
    float c = composite(x - int(floor(shift + 0.5)), line);
    // Composite noise, snow, and the tracking band's own noise and snow.
    c += fbm1(float(x) * 0.5, fl * 7.1 + field * 131.0, 1) * 0.05 * 0.25 * 2.0 * a;
    c += speckles(float(x), fl, 0.012 * a, field) * 0.35;
    c += band * (fbm1(float(x) * 0.25, fl * 3.3 + field * 71.0, 1) * band + speckles(float(x), fl, 0.6 * band * band, field + 9.0) * 0.6);
    outColor = vec4(c, 0.0, 0.0, 1.0);
  }
`;

// 3. Decode: notch for luma, demodulate the rest; then the tape's noise in each plane.
const decodeShader = /* glsl */ `
  uniform sampler2D tComp;
  uniform sampler2D tCam;
  float comp(int x, int line) {
    return texelFetch(tComp, ivec2(clamp(x, 0, uW - 1), LINES - 1 - line), 0).r;
  }
  float chromaAt(int m, int line) {
    float s = 0.0;
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[4]) break;
      s += kern(4, k) * comp(m - k + uDelay[4], line);
    }
    return s;
  }
  void main() {
    int x = int(gl_FragCoord.x);
    int line = LINES - 1 - int(gl_FragCoord.y);
    float fl = float(line), field = float(uField), a = uAmount;
    float y = 0.0;
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[3]) break;
      y += kern(3, k) * comp(x - k, line);
    }
    vec2 iq = vec2(0.0);
    for (int d = -1; d <= 1; d++) {
      float ch = chromaAt(x + d, line) * (d == 0 ? 1.0 : 0.5);
      int p = phaseOf(x + d, line);
      iq += ch * vec2(iMult(p), qMult(p));
    }
    // Tape noise (fine in luma, blotchy in chroma), chroma phase noise per line, lines that lose their colour.
    y += fbm1(float(x) * 0.5, fl * 3.7 + field * 29.0, 1) * 0.01 * 0.25 * 3.0 * a;
    iq += vec2(fbm1(float(x) * 0.05, fl * 5.3 + field * 41.0, 2), fbm1(float(x) * 0.05, fl * 2.9 + field * 53.0, 2)) * 0.1 * 0.25 * 1.5 * a;
    float ph = (hash(vec3(fl, field, 11.0)) - 0.5) * 2.0 * 0.004 * a * 6.2832;
    iq = mat2(cos(ph), sin(ph), -sin(ph), cos(ph)) * iq;
    if (hash(vec3(fl, field, 17.0)) < 0.0015 * a) iq = vec2(0.0);
    vec3 dec = vec3(y, iq);
    vec3 clean = texelFetch(tCam, ivec2(x, LINES - 1 - line), 0).rgb;
    outColor = vec4(mix(clean, dec, smoothstep(0.0, 0.5, a)), 1.0);
  }
`;

// 4. Tape: VHS filters, every line displaced by the edge wave.
const tapeShader = /* glsl */ `
  uniform sampler2D tDec;
  vec3 dec(float x, int line) {
    return texture(tDec, vec2((x + 0.5) / float(uW), (float(LINES - 1 - line) + 0.5) / float(LINES))).rgb;
  }
  void main() {
    int x = int(gl_FragCoord.x);
    int line = LINES - 1 - int(gl_FragCoord.y);
    // Edge wave: tape stretch and the drum's timebase error, as noise over lines and time that changes shape
    // rather than travelling: a few octaves, a strength that wanders between calm and wobbly, a little jitter
    // per line every field, and now and then a jolt that kinks a few lines.
    float fl = float(line), t = float(uField) / 59.94;
    float wave = 0.0, amp = 1.0;
    vec2 p = vec2(fl / DETAIL * 0.035, t * 0.9);
    for (int o = 0; o < 4; o++) {
      wave += noise2(p, 5.0 + float(o)) * amp;
      p = p * vec2(2.1, 1.7) + 3.1;
      amp *= 0.5;
    }
    float calm = 0.35 + 0.65 * smoothstep(-0.3, 0.6, noise1(t * 0.15, 8.0));
    wave *= 3.2 * calm * DETAIL;
    wave += (hash(vec3(floor(fl / DETAIL), float(uField), 23.0)) - 0.5) * 0.7 * DETAIL;
    float jolt = noise1(t * 0.7, 9.0);
    if (jolt > 0.75) {
      float at = hash(vec3(floor(t * 2.0), 2.0, 31.0)) * float(LINES);
      wave += (jolt - 0.75) * 24.0 * DETAIL * exp(-abs(fl - at) * 0.25 / DETAIL) * sign(noise1(t * 3.0, 10.0));
    }
    wave *= uAmount;
    float xs = float(x) - wave;
    float y = 0.0, i = 0.0, q = 0.0;
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[5]) break;
      y += kern(5, k) * dec(xs - float(k), line).x;
    }
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[6]) break;
      i += kern(6, k) * dec(xs - float(k - uDelay[6]), line).y;
    }
    for (int k = 0; k < ${KERNEL_MAX}; k++) {
      if (k >= uLen[7]) break;
      q += kern(7, k) * dec(xs - float(k - uDelay[7]), line).z;
    }
    outColor = vec4(y, i, q, 1.0);
  }
`;

// 5. Output: chroma averaged with the line above, then RGB (still gamma-encoded, as the CRT receives it).
const outputShader = /* glsl */ `
  uniform sampler2D tTape;
  vec3 toRGB(vec3 y) {
    return vec3(y.x + 0.956 * y.y + 0.619 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z);
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 c = texelFetch(tTape, p, 0).rgb;
    vec2 above = texelFetch(tTape, ivec2(p.x, min(p.y + 1, LINES - 1)), 0).yz;
    c.yz = mix(c.yz, 0.5 * (c.yz + above), uAmount);
    vec3 rgb = toRGB(c);
    // A worn tape's lifted, slightly green blacks.
    rgb = rgb * (1.0 - 0.04 * uAmount) + vec3(0.012, 0.02, 0.014) * uAmount;
    outColor = vec4(max(rgb, 0.0), 1.0);
  }
`;

export function createVHS() {
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new PlaneGeometry(2, 2);
  const kernData = new Float32Array(KERNEL_MAX * 8);
  const kernTex = new DataTexture(kernData, KERNEL_MAX, 8, RedFormat, FloatType);
  kernTex.minFilter = kernTex.magFilter = NearestFilter;
  const shared = {
    tKern: { value: kernTex },
    uLen: { value: new Int32Array(8) },
    uDelay: { value: new Int32Array(8) },
    uField: { value: 0 },
    uAmount: { value: 0.85 },
    uW: { value: 760 },
  };
  let designedFor = -1;
  function design(amount) {
    const a = Math.round(amount * 100) / 100;
    if (a === designedFor) return;
    designedFor = a;
    designKernels(a).forEach(([k, d], row) => {
      const n = trimmed(k);
      for (let i = 0; i < KERNEL_MAX; i++) kernData[row * KERNEL_MAX + i] = i < n ? k[i] : 0;
      shared.uLen.value[row] = n;
      shared.uDelay.value[row] = d;
    });
    kernTex.needsUpdate = true;
  }

  function pass(fragment, own, filter = NearestFilter) {
    const uniforms = { ...shared, ...own };
    const mesh = new Mesh(quad, new ShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader: common + fragment, uniforms, depthTest: false, depthWrite: false }));
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: filter, magFilter: filter, depthBuffer: false, colorSpace: NoColorSpace });
    return { scene, uniforms, target };
  }

  // The camcorder's display, drawn on a canvas in screen proportions: big chunky white characters with
  // dark drop shadows. REC blinks, the battery drains, the date and clock are live.
  const osd = document.createElement("canvas");
  osd.height = 540;
  osd.width = 960;
  const ctx = osd.getContext("2d", { willReadFrequently: true });
  const osdTex = new CanvasTexture(osd);
  osdTex.colorSpace = NoColorSpace;
  // A camcorder's character generator is coarse: the display is drawn this many pixels tall, its edges cut hard
  // (no antialiasing) and blown up blocky, then the tape smears it like everything else.
  const OSD_ROWS = 112;
  osdTex.minFilter = osdTex.magFilter = NearestFilter;
  osdTex.generateMipmaps = false;

  const camera = pass(cameraShader, { tScene: { value: null }, tOSD: { value: osdTex }, uGain: { value: 1.4 }, uGrain: { value: 0.09 }, uBlue: { value: 0 }, uRoll: { value: 0 } });
  const encode = pass(encodeShader, { tCam: { value: camera.target.texture }, uTrack: { value: 0 }, uTrackPos: { value: 0 } });
  const decode = pass(decodeShader, { tComp: { value: encode.target.texture }, tCam: { value: camera.target.texture } }, LinearFilter);
  const tape = pass(tapeShader, { tDec: { value: decode.target.texture } });
  const output = pass(outputShader, { tTape: { value: tape.target.texture } }, LinearFilter);
  const passes = [camera, encode, decode, tape, output];

  // The clock runs on scene time from the moment the page opened, so a recorded video's clock keeps real pace.
  const openedAt = Date.now();
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  let lastKey = "";

  // The display, laid out like a camcorder's viewfinder: corner brackets; REC and the battery top left; tape
  // speed, the counter (with frames) and tape left top right; the voice meter, time and date bottom left.
  // state: "standby" (STBY), "rec", "stop" or "rewind" (REW); message: blinking in the middle (TAPE END).
  function drawOSD(time, { voice = 1, hoarse = false, counter: counterTime = time, state = "rec", message = "", tapeMinutes = 60 } = {}) {
    const standby = state === "standby";
    const now = new Date(openedAt + time * 1000);
    const blink = Math.floor(time * 1.4) % 2 === 0;
    const fastBlink = Math.floor(time * 4) % 2 === 0;
    const ct = Math.max(0, counterTime);
    const s = Math.floor(ct);
    const two = (v) => String(v).padStart(2, "0");
    const counter = `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(Math.floor((ct % 1) * 30))}`;
    const left = `${Math.max(0, Math.ceil(tapeMinutes - ct / 60))}min`;
    const hh = now.getHours() % 12 || 12;
    const clock = `${hh}:${two(now.getMinutes())} ${now.getHours() < 12 ? "AM" : "PM"}`;
    const date = `${now.getDate()}. ${MONTHS[now.getMonth()]}. ${now.getFullYear()}`;
    const segments = voice === null ? -1 : Math.ceil(voice * 10 - 1e-3);
    // Spent: blinking until a whole bar is back.
    const low = voice !== null && (hoarse || segments <= 2);
    const key = `${state}|${message}|${osd.width}|${osd.height}|${blink}|${fastBlink}|${counter}|${left}|${clock}|${date}|${segments}|${low}`;
    if (key === lastKey) return;
    lastKey = key;
    const W = osd.width, H = osd.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const m = 14, line = 10;
    // Drawn twice: a dark copy a pixel down and right (the character generator's edging), then the colours.
    for (const shadow of [true, false]) {
      const o = shadow ? 1 : 0;
      const ink = (color) => (ctx.fillStyle = shadow ? "rgba(0,0,0,0.8)" : color);
      ctx.setTransform(1, 0, 0, 1, o, o);
      ink("#eeeeea");
      drawCorners(ctx, W, H, 8, 11);
      // Top left: REC in red (the dot blinks), and a battery about to die: empty, blinking.
      if (state !== "rec") drawText(ctx, standby ? "STBY" : state === "stop" ? "STOP" : "◀◀ REW", m, m);
      else {
        ink("#ff3328");
        if (blink) drawText(ctx, "●", m, m);
        drawText(ctx, "REC", m + CELL + 1, m);
        ink("#eeeeea");
      }
      if (fastBlink) drawBattery(ctx, m + 1, m + line + 1, 0);
      // Top right: speed and play, the counter, tape left.
      drawText(ctx, state === "rec" ? "SP ▶" : "SP", W - m, m, "right");
      drawText(ctx, counter, W - m, m + line, "right");
      drawText(ctx, left, W - m, m + 2 * line + 1, "right");
      drawCassette(ctx, W - m - textWidth(left) - 14, m + 2 * line + 1);
      // Bottom left: voice (not with a real one), time, date.
      if (voice !== null && state === "rec") {
        const vy = H - m - 7 - 2 * line - 2;
        drawText(ctx, "VOICE", m, vy);
        if (low) ink("#ff3328");
        for (let k = 0; k < 10; k++) {
          const x = m + textWidth("VOICE") + 4 + k * 3;
          if (k < segments) {
            if (!(low && !fastBlink)) ctx.fillRect(x, vy, 2, 7);
          } else ctx.fillRect(x, vy + 6, 2, 1);
        }
        ink("#eeeeea");
      }
      drawText(ctx, clock, m, H - m - 7 - line);
      drawText(ctx, date, m, H - m - 7);
      if (message && blink) drawText(ctx, message, Math.round((W - textWidth(message)) / 2), Math.round(H / 2 - 4));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Hard edges: every pixel fully on or off.
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] < 110 ? 0 : 255;
    ctx.putImageData(img, 0, 0);
    osdTex.needsUpdate = true;
  }

  // Rolling tracking trouble: now and then a band of torn lines crawls up the picture for a few seconds.
  function trackingAt(time) {
    const on = Math.max(0, Math.sin(time * 0.23) * 0.5 + 0.5 + 0.25 * Math.sin(time * 0.71) - 0.55) / 0.3;
    return { amount: Math.min(1, on), pos: LINES * (1 - ((time * 0.06) % 1)) };
  }

  let W = 0;
  function render(renderer, scene, { width, height }) {
    // About 427 samples per picture height (the 16:9 density) times DETAIL, and never fewer across, so portrait stays legible.
    const w = Math.round((427 * DETAIL * Math.max(width, height)) / height);
    if (w !== W) {
      W = w;
      for (const p of passes) p.target.setSize(W, LINES);
    }
    shared.uW.value = W;
    const short = Math.min(width, height);
    const ow = Math.round((OSD_ROWS * width) / short), oh = Math.round((OSD_ROWS * height) / short);
    if (osd.width !== ow || osd.height !== oh) {
      osd.width = ow;
      osd.height = oh;
      osdTex.dispose();
      lastKey = "";
    }
    camera.uniforms.tScene.value = scene;
    // Off: the camera's signal goes straight to the output, clean.
    const on = shared.uAmount.value > 0.001;
    output.uniforms.tTape.value = on ? tape.target.texture : camera.target.texture;
    const prev = renderer.getRenderTarget();
    for (const p of on ? passes : [camera, output]) {
      renderer.setRenderTarget(p.target);
      renderer.render(p.scene, ortho);
    }
    renderer.setRenderTarget(prev);
    return { texture: output.target.texture, width: W, lines: LINES };
  }

  // counter: what the tape counter shows (seconds); scene time unless given.
  // osd: what the display shows (see drawOSD); standby turns the picture to the blue screen. roll (0..1) rolls the
  // picture vertically, as a tape being wound does, with heavy tracking noise.
  function update(time, amount, osd = {}, roll = 0) {
    const standby = osd.state === "standby";
    camera.uniforms.uBlue.value = standby ? 1 : 0;
    camera.uniforms.uRoll.value = roll;
    shared.uField.value = Math.floor(time * 59.94);
    shared.uAmount.value = amount;
    design(amount);
    const tr = trackingAt(time);
    encode.uniforms.uTrack.value = roll > 0 ? 1 : tr.amount * amount;
    encode.uniforms.uTrackPos.value = roll > 0 ? LINES * (1 - ((time * 0.9) % 1)) : tr.pos;
    drawOSD(time, { ...osd, counter: standby ? 0 : osd.counter ?? time });
  }

  return { render, update };
}
