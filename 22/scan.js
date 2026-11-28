// Echoes as a point cloud. A ping sends rays out from the listener; each travels unseen at the speed of sound,
// and where it hits it leaves a dot coloured by the surface (with a brick or tile
// pattern so the scan shows texture), then bounces on, dimmer, up to a few times. Dots stay and fade,
// so the maze builds up as a map of where you have called.

import { Mesh, PlaneGeometry, DoubleSide, BufferGeometry, BufferAttribute, InstancedBufferGeometry, InstancedBufferAttribute, ShaderMaterial, GLSL3, AdditiveBlending, DynamicDrawUsage, Vector3 } from "three";
import { nativeRandom } from "modules/random.js";


// Landed dots: small discs lying on the surface they hit (dot.xyz is its normal, dot.w the landing time),
// uSize metres across, grown just enough to stay about a pixel wide when far away.
const dotVertex = /* glsl */ `
  in vec3 dotPos;
  in vec4 dot;
  in vec3 tint;
  uniform float uTime;
  uniform float uMemory;
  uniform float uSize;
  uniform float uViewHeight;
  out vec3 vColor;
  out vec2 vUv;
  void main() {
    float age = uTime - dot.w;
    float fade = uMemory > 59.0 ? 1.0 : exp(-max(age, 0.0) / uMemory);
    float flash = 1.0 + 4.0 * exp(-max(age, 0.0) * 6.0);
    vColor = age < 0.0 || dot.w < -1e3 ? vec3(0.0) : tint * fade * flash;
    vec3 n = normalize(dot.xyz);
    vec3 t = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    vec4 mv = viewMatrix * vec4(dotPos, 1.0);
    float px = uSize * projectionMatrix[1][1] * uViewHeight * 0.5 / max(-mv.z, 0.05);
    float grow = (1.0 + exp(-max(age, 0.0) * 6.0)) * max(1.0, 1.5 / max(px, 1e-3));
    vUv = position.xy;
    vec3 p = dotPos + (t * position.x + b * position.y) * uSize * 0.5 * grow;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;
const dotFragment = /* glsl */ `
  in vec3 vColor;
  in vec2 vUv;
  layout(location = 0) out vec4 outColor;
  void main() {
    float r = length(vUv);
    float a = 1.0 - smoothstep(0.4, 1.0, r);
    if (a <= 0.0 || vColor.r + vColor.g + vColor.b < 0.003) discard;
    outColor = vec4(vColor * a, 1.0);
  }
`;
// Surface pattern at a hit: bricks on vertical walls, tiles on the floor, plain ceiling.
function pattern(p, n) {
  if (n.y > 0.5) {
    const u = ((p.x % 0.6) + 0.6) % 0.6;
    const v = ((p.z % 0.6) + 0.6) % 0.6;
    return u < 0.02 || v < 0.02 ? 0.35 : 0.85 + 0.15 * Math.sin(p.x * 7.1 + p.z * 3.3);
  }
  if (n.y < -0.5) return 0.45;
  const along = Math.abs(n.x) > Math.abs(n.z) ? p.z : p.x;
  const row = Math.floor(p.y / 0.22);
  const u = (((along + (row % 2) * 0.24) % 0.48) + 0.48) % 0.48;
  const v = ((p.y % 0.22) + 0.22) % 0.22;
  const brick = 0.8 + 0.2 * Math.sin(row * 12.9 + Math.floor((along + (row % 2) * 0.24) / 0.48) * 78.2);
  return u < 0.018 || v < 0.018 ? 0.3 : brick;
}

export function createScanner(scene, room, { maxDots = 120000 } = {}) {
  const dotPos = new Float32Array(maxDots * 3);
  const dotData = new Float32Array(maxDots * 4);
  for (let i = 0; i < maxDots; i++) dotData.set([0, 1, 0, -1e4], i * 4);
  const dotTint = new Float32Array(maxDots * 3);
  const disc = new PlaneGeometry(2, 2);
  const dotGeo = new InstancedBufferGeometry();
  dotGeo.index = disc.index;
  dotGeo.setAttribute("position", disc.getAttribute("position"));
  const posAttr = new InstancedBufferAttribute(dotPos, 3).setUsage(DynamicDrawUsage);
  const dataAttr = new InstancedBufferAttribute(dotData, 4).setUsage(DynamicDrawUsage);
  const tintAttr = new InstancedBufferAttribute(dotTint, 3).setUsage(DynamicDrawUsage);
  dotGeo.setAttribute("dotPos", posAttr);
  dotGeo.setAttribute("dot", dataAttr);
  dotGeo.setAttribute("tint", tintAttr);
  // Only as many instances as dots written so far.
  dotGeo.instanceCount = 0;
  const dotUniforms = { uTime: { value: 0 }, uMemory: { value: 15 }, uSize: { value: 0.03 }, uViewHeight: { value: 800 } };
  const dots = new Mesh(
    dotGeo,
    new ShaderMaterial({ glslVersion: GLSL3, vertexShader: dotVertex, fragmentShader: dotFragment, uniforms: dotUniforms, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide }),
  );
  let dotHead = 0;
  let dirtyFrom = Infinity;
  let dirtyTo = -1;

  dots.frustumCulled = false;
  dots.userData.noWireframe = true;
  scene.add(dots);

  const dashes = [];

  // shaded: the colour already carries the surface pattern.
  function addDot(p, n, color, energy, time, shaded = false) {
    const i = dotHead;
    dotHead = (dotHead + 1) % maxDots;
    dotGeo.instanceCount = Math.max(dotGeo.instanceCount, i + 1);
    const k = (shaded ? 1 : pattern(p, n)) * energy;
    dotPos.set([p.x + n.x * 0.01, p.y + n.y * 0.01, p.z + n.z * 0.01], i * 3);
    dotData.set([n.x, n.y, n.z, time], i * 4);
    dotTint.set([color.r * k, color.g * k, color.b * k], i * 3);
    dirtyFrom = Math.min(dirtyFrom, i);
    dirtyTo = Math.max(dirtyTo, i);
  }

  // A ray from origin in dir; its dash leaves at time t0 and lands at the first hit.
  function launch(origin, dir, energy, bounces, t0, order) {
    const hit = room.trace(origin, dir, 40, true);
    if (!hit) return;
    dashes.push({ start: origin.clone(), dir: dir.clone(), length: hit.distance, t0, energy, bounces, hit, order });
  }

  // count rays over the sphere, denser ahead of the listener. The first `now` are traced at once (their
  // hits set the echo sound); the rest are traced over the next frames, keeping the call's start time.
  const queued = [];
  let queuedHead = 0;
  // Bounces wait here for the frame's budget too, so a call's landing rays don't trace thousands at once.
  const bounceQueue = [];
  let bounceHead = 0;
  // focus: how strongly rays lean toward where the listener faces (0 = all round).
  function ping(origin, forward, count, intensity, time, bounces, now = 200, focus = 0.4) {
    const echoes = [];
    for (let i = 0; i < count; i++) {
      const z = nativeRandom() * 2 - 1;
      const a = nativeRandom() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const d = new Vector3(r * Math.cos(a), z, r * Math.sin(a)).addScaledVector(forward, focus).normalize();
      const ray = { origin, dir: d, intensity, time, bounces };
      if (i < now) {
        const hit = trace(ray);
        if (hit) echoes.push({ point: hit.point.clone(), distance: hit.distance });
      } else {
        queued.push(ray);
      }
    }
    return echoes;
  }

  function trace({ origin, dir, intensity, time, bounces }) {
    const hit = room.trace(origin, dir, 40, true);
    if (hit) dashes.push({ start: origin.clone(), dir, length: hit.distance, t0: time, energy: intensity, bounces, hit, order: 0 });
    return hit;
  }

  // Rays travel unseen at the speed of sound; each leaves its dot when it lands.
  function update(time, speed, { budget = 600 } = {}) {
    dotUniforms.uTime.value = time;
    // Bounces first (they land soonest), then the call's remaining rays, all within the frame's budget.
    let k = 0;
    for (; k < budget && bounceHead < bounceQueue.length; k++) {
      const b = bounceQueue[bounceHead++];
      launch(b.origin, b.dir, b.energy, b.bounces, b.t0, b.order);
    }
    if (bounceHead >= bounceQueue.length) bounceQueue.length = bounceHead = 0;
    for (; k < budget && queuedHead < queued.length; k++) trace(queued[queuedHead++]);
    if (queuedHead >= queued.length) queued.length = queuedHead = 0;
    for (let i = dashes.length - 1; i >= 0; i--) {
      const s = dashes[i];
      const travelled = (time - s.t0) * speed;
      if (travelled >= s.length) {
        const h = s.hit;
        addDot(h.point, h.normal, h.albedo, Math.min(1.6, s.energy), s.t0 + s.length / speed, h.shade);
        dashes[i] = dashes[dashes.length - 1];
        dashes.pop();
        if (s.bounces > 0 && s.energy * 0.55 > 0.06) {
          const nd = s.dir.clone().reflect(h.normal);
          nd.x += (nativeRandom() - 0.5) * 0.35;
          nd.y += (nativeRandom() - 0.5) * 0.35;
          nd.z += (nativeRandom() - 0.5) * 0.35;
          nd.normalize();
          if (nd.dot(h.normal) < 0.05) nd.addScaledVector(h.normal, 0.1).normalize();
          bounceQueue.push({ origin: h.point.clone().addScaledVector(h.normal, 0.003), dir: nd, energy: s.energy * 0.55, bounces: s.bounces - 1, t0: s.t0 + s.length / speed, order: s.order + 1 });
        }
        continue;
      }
    }
    if (dirtyTo >= 0) {
      for (const [attr, size] of [[posAttr, 3], [dataAttr, 4], [tintAttr, 3]]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(dirtyFrom * size, (dirtyTo - dirtyFrom + 1) * size);
        attr.needsUpdate = true;
      }
      dirtyFrom = Infinity;
      dirtyTo = -1;
    }
  }

  function clear() {
    dashes.length = 0;
    queued.length = queuedHead = 0;
    bounceQueue.length = bounceHead = 0;
    for (let i = 0; i < maxDots; i++) dotData[i * 4 + 3] = -1e4;
    dataAttr.clearUpdateRanges();
    dataAttr.needsUpdate = true;
    dotHead = 0;
    dotGeo.instanceCount = 0;
  }

  return { ping, update, clear, dotUniforms, dashCount: () => dashes.length };
}
