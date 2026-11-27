// The 3D scene inside the hologram, frozen in time: a spray of chunky gears (clockwork.js) or day 2's burst
// (shatter.js), merged into one mesh. As a hologram records its subject once, its lighting is baked once, on the GPU:
// a softbox key with soft shadows, a rim light and the sky's occlusion, from a few hundred directions, into a texture
// read per vertex; reflections stay live.
//
// Each frame it's drawn from the real camera, as if through the glass (once per face window in Faces mode, clipped to
// the window), into two buffers:
// - the record (r: brightness, g: depth as 1 nearest .. 0.1 farthest, 0 empty, b: window id), unsheared;
// - the replay: the scene drawn again for a few bands of wavelength, each sheared about the plate along its reference
//   direction in proportion to how far that band is from the plate's Bragg wavelength, and added in that band's colour.
//   That is how a white-light hologram rebuilds each colour a little apart: points on the plate stay sharp, those in
//   front or behind fan into spectra, with true parallax and occlusion.
import { Scene, Mesh, Points, BufferGeometry, BufferAttribute, MeshStandardMaterial, MeshBasicMaterial, ShaderMaterial, GLSL3, DoubleSide, BackSide, WebGLRenderTarget, HalfFloatType, FloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter, Color, Vector3, Matrix4, Matrix3, SphereGeometry, PlaneGeometry, PMREMGenerator, OrthographicCamera, NoBlending, AdditiveBlending, Vector4 } from "three";
import { buildGearSpray } from "./clockwork.js";
import { buildShatter, BURSTS } from "./shatter.js";
import { buildLightScene, LIGHT_SCENES } from "./scenes.js";

export const SCENES = ["gears", "shatter", ...LIGHT_SCENES];

// The recording's lights, in the scene's frame: a softbox key above and to the left, and a rim behind on the right.
const KEY = new Vector3(-1.6, 2.4, 2.2).normalize();
const RIM = new Vector3(2, 1, -2).normalize();
const BAKE_WIDTH = 2048;

// Waits for the next frame: long work is cut into slices so the page keeps its framerate.
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const mulberry = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// How the plate replays for this view. Its fringes lie half way between the plate's normal and the reference beam it
// was recorded with (from the front and above); each light is mirrored by them toward the eye in a band whose centre
// shortens as the angle opens (lambda0 cos(theta) inside the gelatin), weighted by how near the mirror direction it is.
// The colours spread within the plane holding the light and the plate's normal, so the smear runs along the lights'
// direction across the plate, longer the further they are from the reference angle. The smear is an axis (a band and
// its opposite are drawn alike), averaged as one: each light by how far it leans across the plate (one nearly square
// on has no steady direction), with a share of the reference's own vertical. state (optional, kept between calls):
// eases the axis over time, by dt.
// Returns { lambda: the band's centre (nm), smear: the shear direction and strength, in the plate's plane }.
export function braggReplay({ n, up }, view, lights, powers, lambda0, state = null, dt = 0) {
  const R = n.clone().add(up).normalize();
  const nf = n.clone().add(R).normalize();
  const cosIn = (c) => Math.sqrt(1 - (1 - c * c) / (1.52 * 1.52));
  const cosRec = cosIn(R.dot(nf));
  const side = new Vector3().crossVectors(n, up).normalize();
  const t = new Vector3();
  let sum = 0, weight = 0, mismatch = 0;
  let ax = 0, ay = 0;
  lights.forEach((L, i) => {
    if (L.dot(n) <= 0) return;
    const h = L.clone().add(view).normalize();
    const lobe = powers[i] * (0.15 + 0.85 * Math.exp((h.dot(nf) - 1) / 0.3));
    sum += ((lambda0 * cosIn(Math.min(1, Math.max(0, L.dot(nf))))) / cosRec) * lobe;
    weight += lobe;
    t.copy(L).addScaledVector(n, -L.dot(n));
    const lean = t.length();
    if (lean > 1e-4) {
      const phi = Math.atan2(t.dot(side), t.dot(up));
      ax += Math.cos(2 * phi) * lean * lobe;
      ay += Math.sin(2 * phi) * lean * lobe;
    }
    mismatch += (1 - L.dot(R)) * lobe;
  });
  if (weight <= 1e-4) return { lambda: lambda0, smear: up.clone().multiplyScalar(0.5) };
  ax += 0.3 * weight;
  if (state) {
    const k = state.ax === undefined ? 1 : 1 - Math.exp(-3 * dt);
    state.ax = (state.ax ?? ax) + (ax - (state.ax ?? ax)) * k;
    state.ay = (state.ay ?? ay) + (ay - (state.ay ?? ay)) * k;
    ax = state.ax;
    ay = state.ay;
  }
  const phi = 0.5 * Math.atan2(ay, ax);
  const smear = up.clone().multiplyScalar(Math.cos(phi)).addScaledVector(side, Math.sin(phi));
  smear.multiplyScalar(0.35 + 0.65 * Math.min(1, mismatch / weight));
  return { lambda: sum / weight, smear };
}

// Merges the scene's meshes (and live instances) into one geometry in its own frame, centred: position, normal, and
// surf (metalness, roughness, albedo) per vertex.
async function mergeScene(group) {
  group.updateMatrixWorld(true);
  const parts = [];
  const _m = new Matrix4(), _i = new Matrix4(), _n = new Matrix3();
  group.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const surf = o.userData.surf ?? [0.5, 0.4, 0.8];
    const add = (matrix) => {
      if (Math.abs(matrix.determinant()) < 1e-12) return;
      parts.push({ geometry: o.geometry, matrix: matrix.clone(), surf });
    };
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, _i);
        add(_m.multiplyMatrices(o.matrixWorld, _i));
      }
    } else add(o.matrixWorld);
  });
  let nv = 0, ni = 0;
  for (const p of parts) {
    nv += p.geometry.attributes.position.count;
    ni += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count;
  }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), S = new Float32Array(nv * 3), I = new Uint32Array(ni);
  const v = new Vector3();
  let ov = 0, oi = 0, flipped = 0;
  // A frame's share of the work: about 15k vertices or triangles, big parts split too.
  let budget = 0;
  const share = async (n) => {
    budget += n;
    if (budget > 15000) {
      budget = 0;
      await nextFrame();
    }
  };
  for (const p of parts) {
    const g = p.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    _n.getNormalMatrix(p.matrix);
    for (let k = 0; k < pos.count; k++) {
      if ((k & 1023) === 1023) await share(1024);
      const o = (ov + k) * 3;
      v.fromBufferAttribute(pos, k).applyMatrix4(p.matrix);
      P[o] = v.x, P[o + 1] = v.y, P[o + 2] = v.z;
      if (nor) v.fromBufferAttribute(nor, k).applyMatrix3(_n).normalize();
      else v.set(0, 0, 1);
      N[o] = v.x, N[o + 1] = v.y, N[o + 2] = v.z;
      S[o] = p.surf[0], S[o + 1] = p.surf[1], S[o + 2] = p.surf[2];
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) I[oi + k] = g.index.getX(k) + ov;
    else for (let k = 0; k < pos.count; k++) I[oi + k] = k + ov;
    // Triangles wound to face along their normals (counter-clockwise from outside), whatever the source did: a
    // double-sided material lights a face it thinks is a back face as the inside of a shell.
    const n = oi + (g.index ? g.index.count : pos.count);
    for (let t = oi; t < n; t += 3) {
      if ((t - oi) % 3072 === 3069) await share(1024);
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
      if (cx * nx + cy * ny + cz * nz < 0) {
        const swap = I[t + 1];
        I[t + 1] = I[t + 2];
        I[t + 2] = swap;
        flipped++;
      }
    }
    ov += pos.count;
    oi += g.index ? g.index.count : pos.count;
  }
  await nextFrame();
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(P, 3));
  geometry.setAttribute("normal", new BufferAttribute(N, 3));
  geometry.setAttribute("surf", new BufferAttribute(S, 3));
  geometry.setIndex(new BufferAttribute(I, 1));
  geometry.userData.flipped = flipped;
  geometry.computeBoundingSphere();
  await nextFrame();
  const c = geometry.boundingSphere.center.clone();
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.computeBoundingSphere();
  return geometry;
}

// Bakes the frozen lighting per vertex: r = the key softbox (soft shadows), g = the sky's visibility (cosine
// weighted, 1 when open), b = the rim. Each direction renders the scene's depth from that side, then every vertex
// (drawn as a point at its own texel) tests itself against it and adds its share. Resolves with the target.
async function bakeLighting(renderer, geometry, { keyCount = 64, skyCount = 160, rimCount = 24, batch = 8 } = {}) {
  const count = geometry.attributes.position.count;
  const height = Math.ceil(count / BAKE_WIDTH);
  const floatOk = renderer.extensions.has("EXT_color_buffer_float");
  const type = floatOk ? FloatType : HalfFloatType;
  const acc = new WebGLRenderTarget(BAKE_WIDTH, height, { type, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const depthSize = 1024;
  const depth = new WebGLRenderTarget(depthSize, depthSize, { type, minFilter: NearestFilter, magFilter: NearestFilter });
  const R = geometry.boundingSphere.radius * 1.02;
  const cam = new OrthographicCamera(-R, R, R, -R, 0, 4 * R);
  const depthMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    side: DoubleSide,
    vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "out vec4 o; void main() { o = vec4(gl_FragCoord.z); }",
  });
  const depthScene = new Scene();
  const depthMesh = new Mesh(geometry, depthMaterial);
  depthMesh.frustumCulled = false;
  depthScene.add(depthMesh);
  // The same vertices, unindexed: each drawn once, as a point.
  const pointsGeometry = new BufferGeometry();
  pointsGeometry.setAttribute("position", geometry.attributes.position);
  pointsGeometry.setAttribute("normal", geometry.attributes.normal);
  // Shares the scene's buffers, so it goes when the scene does.
  geometry.addEventListener("dispose", () => pointsGeometry.dispose());
  const texel = (2 * R) / depthSize;
  const pointsMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    uniforms: {
      lightVP: { value: new Matrix4() },
      dir: { value: new Vector3() },
      shadow: { value: depth.texture },
      size: { value: [BAKE_WIDTH, height] },
      offset: { value: 2.5 * texel },
      bias: { value: (1.5 * texel) / (4 * R) },
      gain: { value: new Vector3() },
    },
    vertexShader: /* glsl */ `
      uniform mat4 lightVP;
      uniform vec3 dir;
      uniform sampler2D shadow;
      uniform vec2 size;
      uniform float offset;
      uniform float bias;
      uniform vec3 gain;
      out vec3 vC;
      void main() {
        int w = int(size.x);
        vec2 t = vec2(float(gl_VertexID % w), float(gl_VertexID / w));
        gl_Position = vec4((t + 0.5) / size * 2.0 - 1.0, 0.0, 1.0);
        gl_PointSize = 1.0;
        vec3 n = normalize(normal);
        float c = dot(n, dir);
        vec4 lp = lightVP * vec4(position + n * offset * sign(c), 1.0);
        vec3 q = lp.xyz / lp.w * 0.5 + 0.5;
        float vis = q.z - bias <= texture(shadow, q.xy).r ? 1.0 : 0.0;
        vC = gain * max(c, 0.0) * vis;
      }
    `,
    fragmentShader: "in vec3 vC; out vec4 o; void main() { o = vec4(vC, 1.0); }",
  });
  const pointsScene = new Scene();
  const points = new Points(pointsGeometry, pointsMaterial);
  points.frustumCulled = false;
  pointsScene.add(points);

  // Directions: the softbox (a disc of 0.35 rad round the key), the rim's (0.2 rad), the whole sky (Fibonacci sphere).
  const rand = mulberry(7);
  const cone = (axis, spread) => {
    const u = new Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
    const w = new Vector3().crossVectors(axis, u);
    const r = spread * Math.sqrt(rand()), a = rand() * Math.PI * 2;
    return axis.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(w, Math.sin(a) * r).normalize();
  };
  const passes = [];
  for (let i = 0; i < keyCount; i++) passes.push({ dir: cone(KEY, 0.35), gain: new Vector3(1 / keyCount, 0, 0) });
  for (let i = 0; i < rimCount; i++) passes.push({ dir: cone(RIM, 0.2), gain: new Vector3(0, 0, 1 / rimCount) });
  for (let i = 0; i < skyCount; i++) {
    const y = 1 - (2 * (i + 0.5)) / skyCount, r = Math.sqrt(1 - y * y), a = i * 2.39996323;
    passes.push({ dir: new Vector3(Math.cos(a) * r, y, Math.sin(a) * r), gain: new Vector3(0, 4 / skyCount, 0) });
  }

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(acc);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  for (let i = 0; i < passes.length; i++) {
    const { dir, gain } = passes[i];
    cam.position.copy(dir).multiplyScalar(2 * R);
    cam.up.set(Math.abs(dir.y) > 0.99 ? 1 : 0, Math.abs(dir.y) > 0.99 ? 0 : 1, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    renderer.setRenderTarget(depth);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(depthScene, cam);
    pointsMaterial.uniforms.lightVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    pointsMaterial.uniforms.dir.value.copy(dir);
    pointsMaterial.uniforms.gain.value.copy(gain);
    renderer.setRenderTarget(acc);
    renderer.render(pointsScene, cam);
    // The first pass alone (it uploads the geometry), then batch a frame.
    if (i === 0 || (i + 1) % batch === 0) {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      await nextFrame();
      renderer.autoClear = false;
    }
  }
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  depth.dispose();
  depthMaterial.dispose();
  pointsMaterial.dispose();
  return acc;
}

// The key light's shadow map, rendered once in the scene's own frame (the scene is frozen and the key rides with
// it, so it holds from every view). Depth as gl_FragCoord.z from an orthographic camera along the key.
function keyShadowMap(renderer, geometry, size) {
  const floatOk = renderer.extensions.has("EXT_color_buffer_float");
  const target = new WebGLRenderTarget(size, size, { type: floatOk ? FloatType : HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter });
  const R = geometry.boundingSphere.radius * 1.02;
  const cam = new OrthographicCamera(-R, R, R, -R, 0, 4 * R);
  cam.position.copy(KEY).multiplyScalar(2 * R);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const depthMaterial = new ShaderMaterial({
    glslVersion: GLSL3,
    side: DoubleSide,
    vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "out vec4 o; void main() { o = vec4(gl_FragCoord.z); }",
  });
  const depthScene = new Scene();
  const m = new Mesh(geometry, depthMaterial);
  m.frustumCulled = false;
  depthScene.add(m);
  const prev = renderer.getRenderTarget();
  const prevClear = new Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.render(depthScene, cam);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevClear, prevAlpha);
  depthMaterial.dispose();
  const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return { target, vp, texel: (2 * R) / size, depthRange: 4 * R };
}

// A small studio for live reflections: two softboxes, a strip and a floor glow in a dark room.
function studioEnvironment(renderer) {
  const room = new Scene();
  room.add(new Mesh(new SphereGeometry(10, 32, 16), new MeshBasicMaterial({ color: 0x050506, side: BackSide })));
  const panel = (w, h, intensity, pos) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(intensity, intensity, intensity), side: DoubleSide }));
    m.position.copy(pos);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  panel(4, 3, 6, KEY.clone().multiplyScalar(7));
  panel(3, 5, 2.5, new Vector3(5, 1, 2));
  panel(8, 8, 0.6, new Vector3(0, -6, 0));
  panel(2, 6, 4, RIM.clone().multiplyScalar(7));
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(room, 0.03).texture;
  pmrem.dispose();
  return env;
}

// The key's shadow from its map: a blocker search, then a percentage-closer filter as wide as the penumbra (wider the
// further the blocker), over a rotated Poisson disc.
const KEY_SHADOW_GLSL = /* glsl */ `
const vec2 holoDisc[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064),
  vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
float keyShadow(vec3 p) {
  vec4 lp = uKeyVP * vec4(p, 1.0);
  vec3 q = lp.xyz / lp.w * 0.5 + 0.5;
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  float search = 14.0 * uKeyTexel / (2.0 * uKeyRange) * 4.0;
  float blockers = 0.0, sum = 0.0;
  for (int i = 0; i < 12; i++) {
    float d = texture2D(uKeyShadow, q.xy + rot * holoDisc[i] * search).r;
    if (d < q.z - 0.0015) { blockers += d; sum += 1.0; }
  }
  if (sum < 0.5) return 1.0;
  float gap = (q.z - blockers / sum) * uKeyRange;
  float radius = clamp(gap * 0.18, 1.5 * uKeyTexel, 24.0 * uKeyTexel) / (2.0 * uKeyRange) * 4.0;
  float lit = 0.0;
  for (int i = 0; i < 12; i++) lit += step(q.z - 0.0015, texture2D(uKeyShadow, q.xy + rot * holoDisc[i] * radius).r);
  return lit / 12.0;
}
`;

// The scene placed about the plate: held shallow round it, as display holograms are (far in front or behind it
// everything would blur away), and sheared by depth for a band.
const SHEAR_VERTEX_PARS = "uniform vec3 uShear;\nuniform vec3 uPlateP;\nuniform vec3 uPlateN;\nuniform float uDepthKeep;\n";
const SHEAR_PROJECT = `vec4 holoWorld = modelMatrix * vec4(transformed, 1.0);
  float holoDepth = dot(holoWorld.xyz - uPlateP, uPlateN);
  holoWorld.xyz -= uPlateN * holoDepth * (1.0 - uDepthKeep);
  holoWorld.xyz += uShear * holoDepth * uDepthKeep;
  vec4 mvPosition = viewMatrix * holoWorld;
  gl_Position = projectionMatrix * mvPosition;`;

// The recording material: baked diffuse light, live reflections occluded by the bake; output as the record or as one
// band of the replay, sheared about the plate.
function recordingMaterial(uniforms) {
  const m = new MeshStandardMaterial({ side: DoubleSide, color: 0xffffff, metalness: 1, roughness: 1 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      SHEAR_VERTEX_PARS + "uniform sampler2D bakeTex;\nattribute vec3 surf;\nvarying vec3 vSurf;\nvarying vec3 vBake;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\n" +
      shader.vertexShader
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
  vSurf = surf;
  vLocal = transformed;
  vLocalN = normalize(objectNormal);
  vBake = texelFetch(bakeTex, ivec2(gl_VertexID % ${BAKE_WIDTH}, gl_VertexID / ${BAKE_WIDTH}), 0).rgb;`,
        )
        .replace("#include <project_vertex>", SHEAR_PROJECT);
    shader.fragmentShader =
      "uniform float nearZ;\nuniform float span;\nuniform float windowId;\nuniform float uPass;\nuniform vec4 uChannel;\nuniform sampler2D uKeyShadow;\nuniform mat4 uKeyVP;\nuniform vec3 uKey;\nuniform float uKeyTexel;\nuniform float uKeyRange;\nvarying vec3 vSurf;\nvarying vec3 vBake;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\n" + KEY_SHADOW_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb *= vSurf.z;")
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = vSurf.y;")
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n  metalnessFactor = vSurf.x;")
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
  // The key with its shadow map (soft, sharper near contact); the rim and the sky baked per vertex; reflections dimmed
  // where the sky is hidden and in the key's shadow.
  vec3 holoN = normalize(vLocalN) * (gl_FrontFacing ? 1.0 : -1.0);
  // Shadows lift to a third of the key, not black: in a hologram a black part reads as a hole cut in it.
  float keyLit = max(dot(holoN, uKey), 0.0) * mix(0.35, 1.0, keyShadow(vLocal + holoN * uKeyTexel * 1.5));
  reflectedLight.indirectDiffuse = material.diffuseColor * (keyLit * 1.8 + vBake.b * 0.9 + 0.12 + vBake.g * 0.6);
  reflectedLight.indirectSpecular *= clamp(vBake.g * 1.3, 0.08, 1.0) * (0.45 + 0.55 * keyLit);`,
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
  float holoLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float holoDepth = 0.1 + 0.9 * clamp(1.0 - (vViewPosition.z - nearZ) / span, 0.0, 1.0);
  if (uPass > 0.5) {
    // Each band is written into its own channel only (diorama.render masks the others), its nearest surface winning.
    gl_FragColor = uChannel * holoLum;
  } else gl_FragColor = vec4(holoLum, holoDepth, windowId, 1.0);`,
        );
  };
  return m;
}

export function createDiorama(renderer, { shadowSize = 2048 } = {}) {
  const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true };
  const record = new WebGLRenderTarget(1, 1, opts);
  // The bands, four to a buffer. Mipmapped, for the ghostly halo's wide, soft reads.
  const replays = [0, 1, 2].map(() => new WebGLRenderTarget(1, 1, { ...opts, generateMipmaps: true, minFilter: LinearMipmapLinearFilter }));
  // Renders nothing: drawn into a target, it has three build that target's mipmaps once.
  const empty = new Scene();
  const bandStep = new Vector3();
  const uniforms = {
    nearZ: { value: 1 },
    span: { value: 2 },
    windowId: { value: 0 },
    uPass: { value: 0 },
    uChannel: { value: new Vector4() },
    uShear: { value: new Vector3() },
    uPlateP: { value: new Vector3() },
    uPlateN: { value: new Vector3(0, 0, 1) },
    bakeTex: { value: null },
    uKeyShadow: { value: null },
    uKeyVP: { value: new Matrix4() },
    uKey: { value: KEY.clone() },
    uKeyTexel: { value: 0.002 },
    uKeyRange: { value: 4 },
    uDepthKeep: { value: 0.5 },
  };
  const material = recordingMaterial(uniforms);
  material.blending = NoBlending;
  const gl = renderer.getContext();
  const colorState = renderer.state.buffers.color;
  const scene = new Scene();
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 0.9;
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  let content = null;
  let version = 0;
  const clear = new Color(0, 0, 0);
  const prevClear = new Color();
  const _fit = new Matrix4();
  const _up = new Vector3();
  const _v = new Vector3();

  return {
    texture: record.texture,
    replayTextures: replays.map((r) => r.texture),
    // How far apart neighbouring bands' copies are drawn, per unit of (squashed) depth from the plate, in world units.
    bandStep,
    record,
    // Prepares a new frozen scene from seed (a spray of gears, or one of day 2's bursts at a moment of its flight),
    // merged and lit, a little each frame so the one on show keeps running smoothly. Resolves with it, not shown;
    // null if a newer one was asked for meanwhile.
    async prepare(kind, seed) {
      const v = ++version;
      let built;
      if (kind === "shatter") {
        const r = mulberry(seed * 7919);
        const pick = BURSTS[Math.floor(r() * BURSTS.length)];
        const burst = await buildShatter({ seed, ...pick, material, spray: 0.5, yieldFrame: nextFrame });
        // Halfway through day 2's burst.
        burst.place(0.3);
        built = burst;
      } else if (kind === "gears") built = await buildGearSpray(seed, { yieldFrame: nextFrame });
      else built = await buildLightScene(kind, seed, { yieldFrame: nextFrame });
      await nextFrame();
      const geometry = await mergeScene(built.group);
      built.dispose();
      if (v !== version) {
        geometry.dispose();
        return null;
      }
      const bake = await bakeLighting(renderer, geometry);
      if (v !== version) {
        geometry.dispose();
        bake.dispose();
        return null;
      }
      await nextFrame();
      if (v !== version) {
        geometry.dispose();
        bake.dispose();
        return null;
      }
      const shadow = keyShadowMap(renderer, geometry, shadowSize);
      // fill: how much of the window the scene takes (1 fills it; less sets it further back).
      return { kind, geometry, bake, shadow, fill: built.fill ?? 1 };
    },
    // Frees a prepared scene that will never be shown.
    discard(p) {
      p?.geometry.dispose();
      p?.bake.dispose();
      p?.shadow.target.dispose();
    },
    // Puts a prepared scene on show, freeing the one before.
    show(next) {
      if (!next) return;
      this.discard(content);
      content = next;
      mesh.geometry = next.geometry;
      uniforms.bakeTex.value = next.bake.texture;
      uniforms.uKeyShadow.value = next.shadow.target.texture;
      uniforms.uKeyVP.value.copy(next.shadow.vp);
      uniforms.uKeyTexel.value = next.shadow.texel;
      uniforms.uKeyRange.value = next.shadow.depthRange;
      mesh.visible = true;
    },
    get kind() {
      return content?.kind;
    },
    setSize(w, h) {
      record.setSize(w, h);
      // The bands at half resolution: a quarter of the fill, and softer.
      for (const r of replays) r.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    },
    // Draws the record and the replay. views: { matrix (where the scene sits, world), radius (how big it may be),
    // planes (clip to a window, or null), id, plate: { p, n, up } (world), lambdaB, smear (the shear per unit of
    // lambda / lambdaB - 1, before disperse) }. bands: how many bands of the
    // replay, bandwidth (nm), disperse (shear per unit of lambda / lambdaB - 1), jitter (-0.5..0.5, per frame).
    // near/span: the depth range to encode. Only the first ceil(bands / 4) replay buffers are written.
    render(camera, { views, near, span, bands = 6, bandwidth = 35, disperse = 1, jitter = 0 }) {
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      const prevAutoClear = renderer.autoClear;
      renderer.getClearColor(prevClear);
      renderer.setClearColor(clear, 0);
      renderer.autoClear = false;
      renderer.localClippingEnabled = true;
      const bandT = Array.from({ length: Math.min(12, bands) }, (_, k) => ((k + 0.5 + jitter) / Math.min(12, bands)) * 2 - 1);
      const used = replays.slice(0, Math.ceil(bandT.length / 4));
      for (const t of [record, ...used]) {
        if (t !== record) t.texture.generateMipmaps = false;
        renderer.setRenderTarget(t);
        renderer.clear();
      }
      if (content) {
        uniforms.nearZ.value = near;
        uniforms.span.value = span;
        const R = content.geometry.boundingSphere.radius;
        for (const view of views) {
          const s = (view.radius * (content.fill ?? 1)) / R;
          mesh.matrix.multiplyMatrices(view.matrix, _fit.makeScale(s, s, s));
          mesh.matrixWorld.copy(mesh.matrix);
          material.clippingPlanes = view.planes;
          uniforms.windowId.value = view.id;
          uniforms.uPlateP.value.copy(view.plate.p);
          uniforms.uPlateN.value.copy(view.plate.n);
          _v.copy(camera.position).sub(view.plate.p).normalize();
          const vn = Math.max(_v.dot(view.plate.n), 0.02);
          // Off-axis, the image blurs more (about 1 / cos of the angle), up to half as much again.
          const blur = Math.min(1.5, 1 / vn);
          _up.copy(view.smear ?? view.plate.up);
          bandStep.copy(_up).multiplyScalar(((2 / bandT.length) * 2 * bandwidth * disperse * blur) / view.lambdaB);
          // The record.
          uniforms.uPass.value = 0;
          uniforms.uShear.value.set(0, 0, 0);
          renderer.setRenderTarget(record);
          renderer.render(scene, camera);
          // The replay: the scene once per band of wavelength, sheared by how far the band is from the plate's centre,
          // its brightness written into its own channel (four bands to a buffer, the others masked off, so each band
          // keeps just its nearest surfaces); hologram.js colours each band per pixel.
          uniforms.uPass.value = 1;
          colorState.setMask(true);
          for (let k = 0; k < bandT.length; k++) {
            renderer.setRenderTarget(replays[k >> 2]);
            uniforms.uChannel.value.set(k % 4 === 0 ? 1 : 0, k % 4 === 1 ? 1 : 0, k % 4 === 2 ? 1 : 0, k % 4 === 3 ? 1 : 0);
            uniforms.uShear.value.copy(_up).multiplyScalar(((bandT[k] * 2 * bandwidth) / view.lambdaB) * disperse * blur);
            renderer.clearDepth();
            // Locked, so three keeps the channel mask through the draw.
            gl.colorMask(k % 4 === 0, k % 4 === 1, k % 4 === 2, k % 4 === 3);
            colorState.setLocked(true);
            renderer.render(scene, camera);
            colorState.setLocked(false);
            gl.colorMask(true, true, true, true);
          }
        }
        material.clippingPlanes = null;
      }
      for (const t of used) {
        t.texture.generateMipmaps = true;
        renderer.setRenderTarget(t);
        renderer.render(empty, camera);
      }
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      return bandT;
    },
  };
}
