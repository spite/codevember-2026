// The bolt in the air, as lightning goes about it, and about as fast. Streamers flicker up from the glass while the
// charge gathers. Then a leader comes down from above the frame in a dash of a few frames, forking on the way into
// branches that grow beside it, and the moment it connects the return stroke runs back up the channel, many times
// brighter, lighting the branches as it passes where they leave. A stroke or two more follow down the same channel
// within a quarter of a second, the branches dark by then, and what is left fades unevenly, breaking into beads.
// The channel is tortuous at every scale (midpoint displacement, the same proportion at each level). It is drawn as
// one instanced quad per piece, facing the camera, a hot core in a halo, into a target of its own with MAX blending, so
// that pieces overlapping at a joint don't add up to a bright knot. glass.js colours it and lays it over the picture.
import {
  WebGLRenderTarget, RawShaderMaterial, GLSL3, Mesh, Scene, InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute, HalfFloatType, LinearFilter,
  NoColorSpace, Vector2, Vector3, Matrix4, Color, CustomBlending, MaxEquation, OneFactor,
} from "three";
import { nativeRandom } from "modules/random.js";

const MAX_PIECES = 2560;
// Pieces kept free of the channel for the charge's filaments, and how many of those there are at most.
const TENDRIL_PIECES = 640;
const FILAMENTS = 12;
const UP = new Vector3(0, 1, 0);
// Jumps the leader takes on the way down.
const STEPS = 26;
// How bright the first return stroke is, against a leader step's 1.
const PEAK = 45;
// How long the return stroke takes to run up the channel, in seconds.
const RETURN = 0.012;

const vertex = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 pieceA;
in vec3 pieceB;
in vec4 pieceInfo; // arrival, anchor, width, level (at b)
in vec4 pieceMore; // height for the return stroke (1 at the glass, 0 at the top), noise, kind (0 channel, 1 branch, 2 streamer)
in vec3 pieceStart; // width, level and height at a
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 resolution;
uniform vec3 shift;
uniform float struck;
uniform float headStep;
uniform float stepAge;
uniform float time;
uniform float wave;
uniform float wave1;
uniform float levelNow;
uniform float levelBefore;
uniform float branchLevel;
uniform float bead;
uniform float streamer;
out vec2 vPixel;
flat out float vLength;
flat out vec2 vRadius;
flat out vec2 vLevel;
flat out float vKind;
flat out vec3 vA;
flat out vec3 vB;

// A hash of a place: both pieces meeting at a joint see the same value there, so nothing steps.
float placeNoise(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
// How bright the bolt is at one end of a piece: taper is the piece's own level there, height how far up the channel.
float levelAt(float taper, float height, vec3 p) {
  float arrival = pieceInfo.x, kind = pieceMore.z, noise = placeNoise(p);
  float level;
  if (kind > 1.5) {
    level = streamer * (0.35 + 0.65 * fract(noise * 7.0 + floor(time * 40.0) * 0.37)) * taper;
  } else if (struck < 0.5) {
    // The leader: what it has laid glows faintly, the newest step flashes.
    float age = headStep - floor(arrival * ${STEPS.toFixed(1)});
    level = age < 0.0 ? 0.0 : 0.25 + (age < 0.5 ? 2.5 : age < 2.5 ? 0.9 : 0.0) * exp(-stepAge / 0.045);
    level *= taper * (0.8 + 0.2 * sin(time * 120.0 + noise * 50.0));
  } else {
    float up = 1.0 - height;
    if (kind < 0.5) {
      level = mix(levelBefore, levelNow, step(up, wave));
      // The front of the stroke, on its way up.
      level += levelNow * 1.2 * exp(-abs(up - wave) * 22.0) * step(wave, 1.15);
    } else {
      level = arrival > 0.985 ? 0.0 : branchLevel * taper * step(up, wave1);
    }
    level *= mix(1.0, 0.35 + 1.3 * noise * noise, bead) * (0.88 + 0.12 * sin(time * 150.0 + noise * 60.0));
  }
  return level;
}

void main() {
  float kind = pieceMore.z;
  vec3 wa = pieceA + shift * pieceInfo.y, wb = pieceB + shift * pieceInfo.y;
  vLevel = vec2(levelAt(pieceStart.y, pieceStart.z, pieceA), levelAt(pieceInfo.w, pieceMore.x, pieceB));
  vKind = kind;
  vA = wa;
  vB = wb;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (max(vLevel.x, vLevel.y) < 0.0008) return;

  vec4 a = viewMatrix * vec4(wa, 1.0), b = viewMatrix * vec4(wb, 1.0);
  // A piece with an end behind the camera would project to nonsense.
  if (max(a.z, b.z) > -0.05) return;
  vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
  vec2 pa = ca.xy / ca.w * resolution * 0.5, pb = cb.xy / cb.w * resolution * 0.5;
  vec2 along = pb - pa;
  float len = length(along);
  along = len > 1e-4 ? along / len : vec2(1.0, 0.0);
  // The glow's radius at each end, in pixels: a world size, never so thin on screen that the core falls between
  // pixels (tendrils are hairlines). Joined pieces agree where they meet, so the channel has no steps.
  float scale = 0.14 * projectionMatrix[1][1] * resolution.y * 0.5, least = kind > 1.5 ? 9.0 : 14.0;
  vRadius = vec2(max(scale * pieceStart.x / -a.z, least), max(scale * pieceInfo.z / -b.z, least));
  float radius = max(vRadius.x, vRadius.y);
  vec2 corner = (position.x < 0.0 ? pa : pb) + along * position.x * radius + vec2(-along.y, along.x) * position.y * radius;
  vPixel = vec2(position.x < 0.0 ? -radius : len + radius, position.y * radius);
  vLength = len;
  gl_Position = vec4(corner / (resolution * 0.5), 0.0, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;
in vec2 vPixel;
flat in float vLength;
flat in vec2 vRadius;
flat in vec2 vLevel;
flat in float vKind;
flat in vec3 vA;
flat in vec3 vB;
layout(location = 0) out vec4 outColor;
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(0.0, 1.0);
  return mix(mix(mix(hash31(i), hash31(i + o.yxx), f.x), mix(hash31(i + o.xyx), hash31(i + o.yyx), f.x), f.y),
    mix(mix(hash31(i + o.xxy), hash31(i + o.yxy), f.x), mix(hash31(i + o.xyy), hash31(i + o.yyy), f.x), f.y), f.z);
}
void main() {
  float t = vLength > 0.0 ? clamp(vPixel.x / vLength, 0.0, 1.0) : 0.0;
  float d = length(vec2(vPixel.x - clamp(vPixel.x, 0.0, vLength), vPixel.y)) / mix(vRadius.x, vRadius.y, t);
  if (d >= 1.0) discard;
  float level = mix(vLevel.x, vLevel.y, t);
  // Every term falls to nothing at the quad's edge, or the quads show.
  float fade = (1.0 - d) * (1.0 - d);
  if (vKind > 1.5) {
    // An arc of the charge: a hairline core in a wide blue glow, which goes to its own channel so it stays blue.
    float hot = exp(-d * d * 260.0);
    outColor = vec4(level * hot, level * hot, level * fade * exp(-d * 4.0) * 0.3, 1.0);
    return;
  }
  // The detail, from where along the channel this is (in the world, so it runs on across joints): the hot core
  // wanders inside its glow, a fainter strand splits off it and rejoins, and the glow is fibrous.
  vec3 P = mix(vA, vB, t);
  float r = mix(vRadius.x, vRadius.y, t);
  float cap = (vPixel.x - clamp(vPixel.x, 0.0, vLength)) / r, across = vPixel.y / r;
  float n1 = noise3(P * 12.0), n2 = noise3(P * 20.0 + 7.3), n3 = noise3(P * 34.0 + 3.1);
  float c1 = across - 0.22 * (n1 - 0.5), c2 = across - 0.6 * (n2 - 0.5);
  float core = exp(-(cap * cap + c1 * c1) * 70.0) + 0.35 * exp(-(cap * cap + c2 * c2) * 220.0) * smoothstep(0.35, 0.7, n2);
  float halo = 0.05 * fade / (d + 0.05) * (0.8 + 0.4 * n3);
  // r: the light. g: how much of it is the core, which is what turns white. b: a wide blue glow, as the filaments have.
  outColor = vec4(level * (core + halo), level * core, level * fade * exp(-d * 3.0) * 0.12, 1.0);
}
`;

// from → to as a jagged path of 2^levels pieces: each midpoint pushed off its chord, across it, by the same share of
// the chord's length at every level (or by amount(level)).
function displaced(from, to, levels, amount, random) {
  let points = [from, to];
  const chord = new Vector3(), side = new Vector3(), other = new Vector3();
  for (let l = 0; l < levels; l++) {
    const next = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      chord.subVectors(b, a);
      const length = chord.length();
      side.set(random() - 0.5, random() - 0.5, random() - 0.5).cross(chord).normalize();
      other.crossVectors(chord, side).normalize();
      const share = typeof amount === "function" ? amount(l) : amount;
      const r = (0.4 + 0.6 * random()) * length * share, angle = random() * Math.PI * 2;
      next.push(a.clone().add(b).multiplyScalar(0.5).addScaledVector(side, Math.cos(angle) * r).addScaledVector(other, Math.sin(angle) * r), b);
    }
    points = next;
  }
  return points;
}

class Bolt {
  constructor() {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.arrays = { pieceA: new Float32Array(MAX_PIECES * 3), pieceB: new Float32Array(MAX_PIECES * 3), pieceInfo: new Float32Array(MAX_PIECES * 4), pieceMore: new Float32Array(MAX_PIECES * 4), pieceStart: new Float32Array(MAX_PIECES * 3) };
    for (const [name, array] of Object.entries(this.arrays)) geometry.setAttribute(name, new InstancedBufferAttribute(array, array.length / MAX_PIECES));
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.uniforms = {
      viewMatrix: { value: new Matrix4() }, projectionMatrix: { value: new Matrix4() }, resolution: { value: new Vector2(1, 1) },
      shift: { value: new Vector3() }, struck: { value: 0 }, headStep: { value: 0 }, stepAge: { value: 0 }, time: { value: 0 },
      wave: { value: 0 }, wave1: { value: 0 }, levelNow: { value: 0 }, levelBefore: { value: 0 }, branchLevel: { value: 0 }, bead: { value: 0 },
      streamer: { value: 0 },
    };
    const mesh = new Mesh(geometry, new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms,
      blending: CustomBlending, blendEquation: MaxEquation, blendSrc: OneFactor, blendDst: OneFactor, depthTest: false, depthWrite: false, transparent: true,
    }));
    mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(mesh);
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });
    this.active = false;
    this.white = 0;
    this.hit = new Vector3();
    // A few points down the channel, from the glass up: where its light comes from, for whatever it lights.
    this.spine = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this._spine = this.spine.map(() => new Vector3());
    this.strokes = [];
    this._step = -1;
    this._stepAt = 0;
    this._clear = new Color();
  }

  // hit: where it lands, in world space. Returns the return strokes, [{ at, level }], seconds after the first.
  strike(hit, random) {
    const { pieceA, pieceB, pieceInfo, pieceMore, pieceStart } = this.arrays;
    let n = 0;
    // width, level, height: at b; start: [width, level, height] at a, the same unless given.
    const add = (a, b, arrival, anchor, width, level, height, kind, start = [width, level, height]) => {
      if (n >= MAX_PIECES - TENDRIL_PIECES) return;
      pieceA.set([a.x, a.y, a.z], n * 3);
      pieceB.set([b.x, b.y, b.z], n * 3);
      pieceInfo.set([arrival, anchor, width, level], n * 4);
      pieceMore.set([height, random(), kind, 0], n * 4);
      pieceStart.set(start, n * 3);
      n++;
    };
    const top = hit.clone().add(new Vector3((random() - 0.5) * 2, 6.5, (random() - 0.5) * 1.6 - 0.6));
    // It comes down more or less straight: the wander is in the small scales.
    const main = displaced(top, hit.clone(), 7, (l) => (l < 2 ? 0.1 : 0.28), random);
    const last = main.length - 1;
    let total = 0;
    for (let i = 1; i <= last; i++) total += main[i].distanceTo(main[i - 1]);
    for (let i = 1; i <= last; i++) add(main[i - 1], main[i], i / last, i / last, 1, 1, i / last, 0, [1, 1, (i - 1) / last]);

    // A branch leaves the channel at u and grows as fast as the leader does, so it is still growing, and short, if it
    // left late. It thins and dims toward its tip, and may fork again.
    const branch = (from, direction, length, u, width, level, depth) => {
      const end = from.clone().addScaledVector(direction, length);
      const path = displaced(from.clone(), end, length > 1.4 ? 5 : length > 0.6 ? 4 : 3, (l) => (l < 1 ? 0.16 : 0.24), random);
      let run = 0;
      for (let i = 1; i < path.length; i++) {
        const piece = path[i].distanceTo(path[i - 1]), t = i / (path.length - 1);
        run += piece;
        const arrival = u + (run / total) * 1.15;
        const t0 = (i - 1) / (path.length - 1);
        add(path[i - 1], path[i], arrival, u, width * (1 - 0.5 * t), level * (1 - 0.7 * t), u - (arrival - u) * 0.5, 1, [width * (1 - 0.5 * t0), level * (1 - 0.7 * t0), u - (arrival - u) * 0.5]);
        if (depth < 2 && i > 2 && i < path.length - 2 && random() < (depth ? 0.07 : 0.11)) {
          const way = path[i].clone().sub(path[i - 1]).normalize();
          branch(path[i], lean(way, 0.35 + random() * 0.5), length * (1 - t) * (0.4 + random() * 0.5), arrival, width * (1 - 0.5 * t) * 0.75, level * (1 - 0.7 * t) * 0.7, depth + 1);
        }
      }
    };
    // A direction turned away from `way` by `angle`, any way round, but never climbing.
    const lean = (way, angle) => {
      const side = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).cross(way).normalize();
      const out = way.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
      if (out.y > -0.15) out.y = -0.15 - random() * 0.3;
      return out.normalize();
    };
    const branches = 8 + Math.floor(random() * 5);
    for (let k = 0; k < branches; k++) {
      // Most of them in the part of the channel the frame shows.
      const u = k < 4 ? 0.62 + 0.3 * random() : 0.25 + 0.67 * random();
      const i = Math.max(1, Math.min(last - 1, Math.round(u * last)));
      const way = main[i + 1].clone().sub(main[i - 1]).normalize();
      const below = (1 - u) * total;
      branch(main[i], lean(way, 0.4 + random() * 0.6), Math.min(2.8, below * (0.35 + random() * 0.75) + 0.25), i / last, 0.7, 0.55, 0);
    }
    for (const attribute of Object.values(this.geometry.attributes)) attribute.needsUpdate = true;
    this.geometry.instanceCount = n;
    // The filaments go after the channel, rewritten while the charge gathers.
    this.fixed = n;
    this.filaments = [];

    [1, 0.93, 0.82, 0.66, 0.45].forEach((u, i) => this._spine[i].copy(main[Math.round(u * last)]));
    this.hit.copy(hit);
    this.strokes = [{ at: 0, level: 1 }];
    const more = 1 + Math.floor(random() * 3);
    for (let k = 0, at = 0; k < more; k++) this.strokes.push({ at: (at += 0.04 + random() * 0.05), level: 0.3 + random() * 0.5 });
    this.active = true;
    this._step = -1;
    this.pieces = n;
    this.leader(0, 0, hit);
    return this.strokes;
  }

  clear() {
    this.active = false;
    this.white = 0;
  }

  // Where the hit point is now: the channel leans to follow it, most at the bottom.
  _follow(hit) {
    const shift = this.uniforms.shift.value.subVectors(hit, this.hit);
    [1, 0.93, 0.82, 0.66, 0.45].forEach((u, i) => this.spine[i].copy(this._spine[i]).addScaledVector(shift, u));
  }

  // The charge's filaments, as in a plasma ball: each leaves the impact and bows through the air in an arc of a circle
  // to a spot on the glass nearby, and that spot wanders about, smoothly, so the arc sweeps round with it. More of them,
  // reaching further, as the charge grows. Written as pieces after the channel, in world space, every frame.
  _filaments(time, hit, charge, normal) {
    const r = nativeRandom;
    if (!this.filaments.length)
      for (let k = 0; k < FILAMENTS; k++)
        this.filaments.push({
          angle: r() * Math.PI * 2,
          phase: [r() * 6.3, r() * 6.3, r() * 6.3, r() * 6.3],
          speed: [0.6 + r() * 1.2, 1.3 + r() * 2, 0.5 + r() * 1.2],
          bulge: 0.3 + r() * 0.35,
          reach: 0.6 + r() * 0.6,
          start: new Vector3((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.03),
        });
    const t1 = new Vector3(1, 0, 0).addScaledVector(normal, -normal.x);
    if (t1.lengthSq() < 0.01) t1.set(0, 0, 1).addScaledVector(normal, -normal.z);
    t1.normalize();
    const t2 = new Vector3().crossVectors(normal, t1);
    const { pieceA, pieceB, pieceInfo, pieceMore, pieceStart } = this.arrays;
    let n = this.fixed;
    const put = (a, b, width, level, levelA = level) => {
      if (n >= MAX_PIECES) return;
      pieceA.set([a.x, a.y, a.z], n * 3);
      pieceB.set([b.x, b.y, b.z], n * 3);
      // Anchored to nothing: they are made where the glass is now.
      pieceInfo.set([1, 0, width, level], n * 4);
      pieceMore.set([1, r(), 2, 0], n * 4);
      pieceStart.set([width, levelA, 1], n * 3);
      n++;
    };
    const count = Math.round(3 + charge * (FILAMENTS - 3));
    const start = new Vector3(), end = new Vector3(), endNormal = new Vector3(), chord = new Vector3(), up = new Vector3();
    const centre = new Vector3(), from = new Vector3(), to = new Vector3(), axis = new Vector3(), p = new Vector3(), prev = new Vector3();
    for (let k = 0; k < count; k++) {
      const f = this.filaments[k];
      // Where it lands: round the impact, wandering in angle and in reach.
      const angle = f.angle + 0.9 * Math.sin(time * f.speed[0] + f.phase[0]) + 0.4 * Math.sin(time * f.speed[1] + f.phase[1]);
      const reach = (0.07 + 0.22 * charge) * f.reach * (0.75 + 0.25 * Math.sin(time * f.speed[2] + f.phase[2]));
      start.copy(hit).addScaledVector(t1, f.start.x).addScaledVector(t2, f.start.z);
      end.copy(hit).addScaledVector(t1, Math.cos(angle) * reach).addScaledVector(t2, Math.sin(angle) * reach);
      endNormal.copy(normal);
      const on = this.surface?.(end, 0.004);
      if (on) end.copy(on.point), endNormal.copy(on.normal);
      // An arc of a circle from start to end, bowed out from the glass.
      chord.subVectors(end, start);
      const L = chord.length();
      if (L < 1e-3) continue;
      chord.divideScalar(L);
      up.copy(normal).add(endNormal);
      up.addScaledVector(chord, -up.dot(chord)).normalize();
      const h = L * f.bulge * (0.9 + 0.1 * Math.sin(time * 7 + f.phase[3]));
      const R = (L * L * 0.25 + h * h) / (2 * h);
      centre.copy(start).addScaledVector(chord, L / 2).addScaledVector(up, h - R);
      from.subVectors(start, centre);
      to.subVectors(end, centre);
      axis.crossVectors(from, to).normalize();
      const span = from.angleTo(to);
      const STEPS = 40;
      prev.copy(start);
      for (let i = 1; i <= STEPS; i++) {
        const s = i / STEPS;
        p.copy(from).applyAxisAngle(axis, span * s).add(centre);
        // Ripples running along it, both ways across, and a fine flicker; none at the ends.
        const ends = Math.sin(Math.PI * s);
        const a = L * (0.07 * Math.sin(s * 15 - time * 26 + f.phase[3]) + 0.02 * Math.sin(s * 37 + time * 37 + f.phase[0]));
        const b = L * (0.07 * Math.cos(s * 13 - time * 23 + f.phase[1]) + 0.02 * Math.sin(s * 33 - time * 31 + f.phase[2]));
        p.addScaledVector(up, (a + (r() - 0.5) * 0.004) * ends).addScaledVector(axis, (b + (r() - 0.5) * 0.004) * ends);
        // Brighter where it leaves and where it lands.
        const s0 = (i - 1) / STEPS;
        put(prev.clone(), p.clone(), 0.6, 0.55 + 0.45 * Math.max(1 - s * 4, s * s), 0.55 + 0.45 * Math.max(1 - s0 * 4, s0 * s0));
        prev.copy(p);
      }
      // Where it touches the glass, a spot of light.
      put(end, end.clone().addScaledVector(endNormal, 0.004), 0.7, 0.6 + 0.4 * r());
    }
    // And where they all leave from.
    put(hit, hit.clone().addScaledVector(normal, 0.01), 1.2, 0.5 + 0.5 * charge);
    for (const attribute of Object.values(this.geometry.attributes)) attribute.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  // The leader on its way: head is how far down it has come, 0..1. It holds just short of the glass until the stroke.
  // charge: how far the charge has gathered, 0..1; normal: the glass's, where the strike lands.
  leader(head, time, hit, charge = 0, normal = UP) {
    const u = this.uniforms;
    this._follow(hit);
    this._filaments(time, hit, charge, normal);
    const step = Math.min(STEPS - 2, Math.floor(head * STEPS));
    if (step !== this._step) {
      this._step = step;
      this._stepAt = time;
    }
    // Held at the last step, it keeps pulsing.
    const age = time - this._stepAt;
    u.struck.value = 0;
    u.headStep.value = step;
    u.stepAge.value = step === STEPS - 2 ? age % 0.11 : age;
    u.time.value = time;
    u.streamer.value = 0.5 + 1.8 * charge;
  }

  // e seconds after the first return stroke. Returns how much light the channel gives, 1 at the first stroke's peak.
  struck(e, time, hit, normal = UP) {
    const u = this.uniforms;
    this._follow(hit);
    // What a stroke of this level still gives, this long after it: a spike, then the current that keeps flowing.
    const glow = (age) => Math.exp(-age / 0.022) + 0.06 * Math.exp(-age / 0.1);
    let k = 0, light = 0, white = 0;
    this.strokes.forEach((s, i) => {
      if (e < s.at) return;
      k = i;
      light += s.level * glow(e - s.at);
      white = Math.max(white, (i ? s.level * 0.6 : 1) * Math.exp(-(e - s.at) / 0.04));
    });
    // The whole frame whiting out: all of it at the first stroke, less at the ones after.
    this.white = white;
    const now = this.strokes[k], since = e - now.at;
    u.struck.value = 1;
    u.time.value = time;
    // The filaments flare with the stroke where it went in, then die away.
    const flare = 2.5 * Math.exp(-e / 0.22);
    u.streamer.value = flare;
    if (flare > 0.05) this._filaments(time, hit, 1, normal);
    else this.geometry.instanceCount = this.fixed;
    u.wave.value = since / RETURN;
    u.wave1.value = e / RETURN;
    u.levelNow.value = PEAK * now.level * glow(since);
    u.levelBefore.value = k ? PEAK * this.strokes[k - 1].level * 0.06 * Math.exp(-(e - this.strokes[k - 1].at) / 0.1) : 0.25;
    u.branchLevel.value = PEAK * (Math.exp(-e / 0.05) + 0.04 * Math.exp(-e / 0.25));
    const end = e - this.strokes[this.strokes.length - 1].at;
    u.bead.value = Math.min(1, Math.max(0, (end - 0.03) / 0.15));
    if (end > 0.4) {
      this.active = false;
      this.white = 0;
    }
    return light;
  }

  compile(renderer, camera) {
    return renderer.compileAsync(this.scene, camera);
  }

  // The bolt's light as a texture the size of the frame, or null when there is no bolt.
  render(renderer, camera, width, height) {
    if (!this.active) return null;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const u = this.uniforms;
    u.viewMatrix.value.copy(camera.matrixWorldInverse);
    u.projectionMatrix.value.copy(camera.projectionMatrix);
    u.resolution.value.set(width, height);
    const prev = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clear);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    renderer.render(this.scene, camera);
    renderer.setClearColor(this._clear, alpha);
    renderer.setRenderTarget(prev);
    return this.target.texture;
  }
}

export { Bolt };
