// The glass, the figure in it and the bolt, drawn over the lit frame in one full-screen pass. The object isn't a mesh:
// each pixel's ray is sphere-traced to the baked distance field, refracted in, and taken across the glass, where the
// figure is a second distance field (the channels' walls, lit as chipped white fractures in a haze of finer ones,
// glowing while the strike fades). At the far side it is split by Fresnel: what leaves shows the frame behind, bent;
// what stays crosses the object once more, which is where the mirrored copies in a block's faces come from. The bolt
// (bolt.js draws its light) is laid over the picture, with the air it lights and its reflection in the glass.
import {
  WebGLRenderTarget, RawShaderMaterial, GLSL3, Mesh, Scene, OrthographicCamera, BufferGeometry, Float32BufferAttribute, HalfFloatType, LinearFilter, NearestFilter,
  NoColorSpace, Matrix4, Matrix3, Vector2, Vector3, Vector4, Color, Data3DTexture, RedFormat, UnsignedByteType, DataUtils,
} from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { globalUniforms } from "modules/pipeline/uniforms.js";
import { N, EXTENT, CELL, sdfGLSL, shapeNames } from "./shapes.js";
import { BAND } from "./band.js";


const fragment = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler3D tFigure;
uniform sampler3D tArrival;
uniform float grown;
uniform vec3 frontColor;
uniform mat4 inverseViewProjection;
uniform mat4 viewProjection;
uniform mat4 inverseProjection;
uniform vec3 cameraPos;
uniform vec2 sceneSize;
uniform mat4 objectInverse;
uniform mat3 objectRotation;
uniform vec3 objectCenter;
uniform float objectScale;
uniform samplerCube envMap;
uniform float envMapMaxLod;
uniform float envIntensity;
uniform mat3 envRotation;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float ior;
uniform vec3 absorption;
uniform float figure;
uniform float figureVoxel;
uniform float figureFrost;
uniform float figureGain;
uniform float stepLength;
uniform vec3 glowColor;
uniform float glow;
uniform float flash;
uniform vec3 flashColor;
uniform float behind;
uniform float pixelAngle;
uniform sampler2D tBolt;
uniform float boltOn;
uniform float white;
uniform vec4 boltChord;
uniform vec3 boltSpine[5];
uniform vec3 basePoint;
uniform vec3 baseColor;
uniform float hazeDensity;
uniform float hazeLevel;
uniform vec3 haloColor;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

const float EXTENT = ${EXTENT.toFixed(4)};
const float CELL = ${CELL.toFixed(6)};
const float INV = ${(0.5 / EXTENT).toFixed(6)};

${sdfGLSL}
vec3 environment(vec3 d, float rough) {
  return textureLod(envMap, envRotation * d, envMapMaxLod * rough).rgb * envIntensity;
}
// The frame behind the glass, where a ray leaving it at p (world) along d would land; the studio where that is off screen.
vec3 background(vec3 p, vec3 d) {
  vec4 clip = viewProjection * vec4(p + d * behind, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
  float on = clip.w > 0.0 ? edge.x * edge.y : 0.0;
  return mix(environment(d, 0.0), textureLod(tScene, clamp(uv, 0.0, 1.0), 0.0).rgb, on);
}
float hash(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// The figure's field: distance to the nearest channel wall in object units, negative inside, known to BAND voxels
// either way (grow.worker.js).
float channel(vec3 q) {
  return (0.5 - textureLod(tFigure, q * INV + 0.5, 0.0).r) * ${(2 * BAND).toFixed(1)} * figureVoxel;
}
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(0.0, 1.0);
  return mix(
    mix(mix(hash31(i), hash31(i + o.yxx), f.x), mix(hash31(i + o.xyx), hash31(i + o.yyx), f.x), f.y),
    mix(mix(hash31(i + o.xxy), hash31(i + o.yxy), f.x), mix(hash31(i + o.xyy), hash31(i + o.yyy), f.x), f.y), f.z);
}
// The lamp in the plinth under the glass, shining up into it: what the figure scatters of it, by distance.
vec3 baseLight(vec3 q) {
  vec3 d = q - basePoint;
  return baseColor / (0.03 + dot(d, d));
}
// One crossing of the glass from p along dir (object space): rgb the figure's light, a what is left of the light
// behind it. A channel is not a tube but a run of shattered glass: a hard core, its wall broken up by noise and lit
// as small facets that each face their own way, some catching the key outright, inside a haze of hairline cracks that
// thins away from it. exitPoint is where the ray meets the glass again.
vec4 crossing(vec3 p, vec3 dir, float ds, float jitter, vec3 toLight, vec3 ambient, out vec3 exitPoint) {
  vec3 acc = vec3(0.0);
  float through = 1.0;
  float stride = ds * (0.3 + jitter);
  float t = stride;
  float last = -0.001;
  float v = figureVoxel;
  bool left = false;
  vec3 lastCell = vec3(-1e3);
  for (int i = 0; i < 320; i++) {
    vec3 q = p + dir * t;
    float d = sdf(q);
    if (d > 0.0) {
      if (i > 1) {
        t -= stride * d / (d - last);
        left = true;
        break;
      }
      d = -0.001;
    }
    float taken = stride;
    stride = ds;
    if (figure > 0.0) {
      float c = channel(q);
      // Not reached yet: clear glass. Just reached: white hot, cooling behind the front.
      float since = grown - textureLod(tArrival, q * INV + 0.5, 0.0).r * 1.0039;
      if (since < 0.0) c = max(c, v * 2.5);
      vec3 front = since >= 0.0 ? frontColor * exp(-since * 22.0) : vec3(0.0);
      stride = clamp((c - v) * 0.9, v * 0.5, ds * 3.0);
      if (c < v * 2.0) {
        // The haze: grainy, so it reads as many fine cracks rather than a glow.
        float close = 1.0 - clamp(c / (v * 1.6), 0.0, 1.0);
        float grain = noise3(q / (v * 0.7));
        float a = 1.0 - exp(-close * close * grain * grain * grain * figureFrost * taken / v);
        acc += through * a * ((lightColor * 0.7 + ambient + baseLight(q) + flashColor * flash) * figureGain + glowColor * glow * 0.6 + front * 0.5);
        through *= 1.0 - a * 0.8;
        // The wall, chipped.
        c += (noise3(q / (v * 1.5)) - 0.35) * v * 0.9;
        if (c < v * 0.1) {
          vec2 e = vec2(v, 0.0);
          vec3 n = vec3(channel(q + e.xyy) - channel(q - e.xyy), channel(q + e.yxy) - channel(q - e.yxy), channel(q + e.yyx) - channel(q - e.yyx));
          vec3 cell = floor(q / (v * 1.1));
          n = normalize(normalize(n + 1e-6) + (vec3(hash31(cell), hash31(cell + 19.19), hash31(cell + 47.3)) - 0.5) * 2.2);
          float facing = abs(dot(n, toLight));
          float glint = pow(max(dot(reflect(dir, n), toLight), 0.0), 20.0);
          vec3 lit = (lightColor * (0.4 + 0.25 * facing + 2.0 * glint) + ambient + baseLight(q) * (0.6 + 0.6 * abs(dot(n, normalize(basePoint - q)))) + flashColor * flash) * figureGain;
          lit += glowColor * glow + front;
          float depth = -channel(q - normalize(n) * v * 1.2) / v;
          float solid = mix(0.3, 0.92, smoothstep(0.3, 1.4, depth));
          acc += through * solid * lit;
          through *= 1.0 - solid;
          stride = v * 2.0;
        }
        if (through < 0.03) break;
      }
    }
    // Specks: a seed bubble in a cell here and there, lit by the lamp and the key.
    vec3 cell = floor(q * 22.0);
    if (cell != lastCell) {
      lastCell = cell;
      if (hash31(cell + 3.7) > 0.9975) {
        vec3 c = (cell + 0.25 + 0.5 * vec3(hash31(cell + 1.1), hash31(cell + 2.2), hash31(cell + 5.5))) / 22.0;
        float r = length(cross(c - p, dir));
        float speck = smoothstep(0.004, 0.0, r);
        acc += through * speck * (lightColor * 0.25 + ambient + baseLight(c) * 0.5 + glowColor * glow * 0.3) * figureGain;
      }
    }
    last = d;
    t += stride;
  }
  // Stopped short, by the figure or by the step count: the rest of the way out, on the glass's own distances.
  if (!left) {
    for (int i = 0; i < 48; i++) {
      float d = sdf(p + dir * t);
      if (d > 0.0) break;
      t += max(-d, ds * 0.5);
    }
  }
  exitPoint = p + dir * t;
  return vec4(acc, through);
}

// How squarely a ray from o along d (world) looks at the bolt's channel, taken as a few straight pieces: its
// reflection in the glass.
float boltGlint(vec3 o, vec3 d) {
  float g = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 a = boltSpine[i], u = boltSpine[i + 1] - a, w = o - a;
    float B = dot(d, u), C = dot(u, u), D = dot(d, w), E = dot(u, w);
    float s = clamp((E - B * D) / max(C - B * B, 1e-5), 0.0, 1.0);
    float t = max(B * s - D, 0.0);
    float angle = length(w + d * t - u * s) / max(t, 0.2);
    g = max(g, exp(-angle * angle * 700.0));
  }
  return g;
}

void main() {
  vec3 color = textureLod(tScene, vUv, 0.0).rgb;
  vec4 far = inverseViewProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rayWorld = normalize(far.xyz / far.w - cameraPos);
  vec3 ro = (objectInverse * vec4(cameraPos, 1.0)).xyz;
  vec3 rd = normalize(mat3(objectInverse) * rayWorld);

  // The grid's box, a cell in so samples never clamp.
  float B = EXTENT - CELL;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-B - ro) * inv, t1 = (B - ro) * inv;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  float near = max(max(lo.x, lo.y), max(lo.z, 0.0)), end = min(min(hi.x, hi.y), hi.z);

  // How far the eye sees along the ray: the glass if it is hit, else what is behind it.
  vec4 behindView = inverseProjection * vec4(vUv * 2.0 - 1.0, textureLod(tDepth, vUv, 0.0).r * 2.0 - 1.0, 1.0);
  float seen = length(behindView.xyz / behindView.w);
  if (near < end) {
    vec4 v = inverseProjection * vec4(vUv * 2.0 - 1.0, textureLod(tDepth, vUv, 0.0).r * 2.0 - 1.0, 1.0);
    end = min(end, length(v.xyz / v.w) / objectScale);
    float t = near;
    bool hit = false;
    // The nearest the ray came, for the silhouette.
    float closest = 1e3, closestAt = near;
    for (int i = 0; i < 96; i++) {
      float d = sdf(ro + rd * t);
      if (d < 0.0015) {
        hit = true;
        break;
      }
      if (d < closest) {
        closest = d;
        closestAt = t;
      }
      t += max(d, 0.002);
      if (t > end) break;
    }
    if (hit) {
      vec3 p = ro + rd * t;
      seen = t * objectScale;
      vec3 n = sdfNormal(p);
      vec3 toLight = lightDirection * objectRotation;
      vec3 ambient = environment(vec3(0.0, 1.0, 0.0), 1.0);
      float jitter = hash(gl_FragCoord.xy);

      float cosine = clamp(-dot(rd, n), 0.0, 1.0);
      float f0 = (ior - 1.0) / (ior + 1.0);
      f0 *= f0;
      float fresnel = f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
      vec3 mirrored = objectRotation * reflect(rd, n);
      vec3 reflected = environment(mirrored, 0.0);
      // While it flashes, the bolt shows in the glass, and the room it lights.
      if (flash > 0.0) reflected = reflected * (1.0 + flash * 0.5) + flashColor * flash * 4.0 * boltGlint(objectCenter + objectRotation * p * objectScale, mirrored);

      vec3 dir = refract(rd, n, 1.0 / ior);
      vec3 exitPoint;
      vec4 first = crossing(p - n * 0.004, dir, stepLength, jitter, toLight, ambient, exitPoint);
      vec3 inside = first.rgb;
      if (first.a > 0.02) {
        vec3 m = sdfNormal(exitPoint);
        vec3 out1 = refract(dir, -m, ior);
        float leave = dot(out1, out1) > 0.0 ? 1.0 - (f0 + (1.0 - f0) * pow(1.0 - clamp(dot(out1, m), 0.0, 1.0), 5.0)) : 0.0;
        vec3 worldExit = objectCenter + objectRotation * exitPoint * objectScale;
        vec3 beyond = leave > 0.0 ? background(worldExit, objectRotation * out1) * leave : vec3(0.0);
        if (leave < 0.97) {
          // The part that stays in: one more crossing, then out whichever way it can.
          vec3 dir2 = reflect(dir, -m);
          vec3 exit2;
          vec4 second = crossing(exitPoint - m * 0.004, dir2, stepLength, jitter, toLight, ambient, exit2);
          vec3 m2 = sdfNormal(exit2);
          vec3 out2 = refract(dir2, -m2, ior);
          if (dot(out2, out2) == 0.0) out2 = reflect(dir2, -m2);
          vec3 world2 = objectCenter + objectRotation * exit2 * objectScale;
          beyond += (1.0 - leave) * (second.rgb + second.a * background(world2, objectRotation * out2));
        }
        float path = length(exitPoint - p);
        inside += first.a * beyond * exp(-absorption * path);
      }
      color = mix(inside, reflected, fresnel);
    } else {
      // A near miss covers part of the pixel: at a grazing angle glass is a mirror, so that part shows the room.
      float cover = 1.0 - smoothstep(0.0, pixelAngle * closestAt * 1.5, closest - 0.0015);
      color = mix(color, environment(rayWorld, 0.0), cover);
    }
  }

  // Haze: the room's light scattered toward the eye along the way, and the glass's own light round it.
  {
    float dist = min(seen, 40.0);
    float f = 1.0 - exp(-dist * hazeDensity);
    color = mix(color, environment(rayWorld, 1.0) * hazeLevel, f);
    vec3 c = objectCenter - cameraPos;
    // The glass's light comes from all of it, not its centre: a source half a unit across, so nothing peaks there.
    float tc = dot(c, rayWorld), h = sqrt(dot(c - rayWorld * tc, c - rayWorld * tc) + 0.25);
    color += haloColor * hazeDensity * (atan((dist - tc) / h) + atan(tc / h)) / h;
  }

  vec2 screen = vUv * vec2(sceneSize.x / sceneSize.y, 1.0);
  if (boltOn > 0.5) {
    // r: all its light; g: the core's share, white hot. The rest is the halo, the blue-violet of air it has ionised.
    // b: the glow of the charge's arcs, a deeper blue.
    vec3 b = textureLod(tBolt, vUv, 0.0).rgb;
    color += (b.r - b.g) * vec3(0.35, 0.52, 1.0) * 4.0 + b.g * vec3(0.9, 0.95, 1.0) * 5.0 + b.b * vec3(0.12, 0.35, 1.0) * 3.0;
  }
  if (flash > 0.0) {
    // The air the flash lights: most along the channel, a little everywhere; and the glare where it meets the glass.
    vec2 pa = screen - boltChord.xy, ba = boltChord.zw - boltChord.xy;
    float d = length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
    float glare = dot(pa, pa);
    color += flashColor * flash * (0.02 / (1.0 + d * d * 40.0) + 0.012 / (1.0 + d * 60.0) + 0.006 + 0.0002 / (glare + 0.00025));
    // And the eye, or the camera, takes more than it can hold.
    color *= 1.0 + flash * 0.3;
  }
  // The strike whites the frame out.
  color += flashColor * white * white * 1.5;
  outColor = vec4(color, 1.0);
}
`;

class Glass {
  constructor() {
    this.sdfTexture = new Data3DTexture(new Uint16Array(N * N * N), N, N, N);
    this.sdfTexture.format = RedFormat;
    this.sdfTexture.type = HalfFloatType;
    this.sdfTexture.minFilter = this.sdfTexture.magFilter = LinearFilter;
    this.sdfTexture.unpackAlignment = 1;
    this.figureTexture = null;

    this.uniforms = {
      tScene: { value: null },
      tDepth: { value: null },
      tSdf: { value: this.sdfTexture },
      shapeId: { value: 0 },
      shapeEdge: { value: 0.03 },
      shapeInflate: { value: 0 },
      tFigure: { value: null },
      tArrival: { value: null },
      // How far the discharge has run through the figure, in arrival time (1: everywhere).
      grown: { value: 10 },
      frontColor: { value: new Color(0.4, 0.58, 1.0).multiplyScalar(14) },
      inverseViewProjection: { value: new Matrix4() },
      viewProjection: { value: new Matrix4() },
      inverseProjection: { value: new Matrix4() },
      cameraPos: { value: new Vector3() },
      sceneSize: { value: new Vector2(1, 1) },
      objectInverse: { value: new Matrix4() },
      objectRotation: { value: new Matrix3() },
      objectCenter: { value: new Vector3() },
      objectScale: { value: 1 },
      envMap: globalUniforms.envMap,
      envMapMaxLod: globalUniforms.envMapMaxLod,
      envIntensity: globalUniforms.envIntensity,
      envRotation: globalUniforms.envRotation,
      lightDirection: globalUniforms.lightDirection,
      lightColor: globalUniforms.lightColor,
      ior: { value: 1.5 },
      absorption: { value: new Vector3(0.1, 0.06, 0.05) },
      figure: { value: 0 },
      figureVoxel: { value: 0.01 },
      figureFrost: { value: 0.22 },
      figureGain: { value: 0.2 },
      stepLength: { value: 0.016 },
      glowColor: { value: new Color(0.3, 0.5, 1) },
      glow: { value: 0 },
      flash: { value: 0 },
      flashColor: { value: new Color(0.75, 0.85, 1) },
      behind: { value: 1.5 },
      pixelAngle: { value: 0.001 },
      tBolt: { value: null },
      boltOn: { value: 0 },
      white: { value: 0 },
      // Where the channel meets the glass and a point far up it, on screen (x scaled by the aspect).
      boltChord: { value: new Vector4() },
      boltSpine: { value: null },
      basePoint: { value: new Vector3(0, -0.9, 0) },
      baseColor: { value: new Color(0, 0, 0) },
      hazeDensity: { value: 0.03 },
      hazeLevel: { value: 0.12 },
      haloColor: { value: new Color(0, 0, 0) },
    };
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mesh = new Mesh(geometry, new RawShaderMaterial({
      glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader: fragment, uniforms: this.uniforms, depthTest: false, depthWrite: false,
    }));
    mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(mesh);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, colorSpace: NoColorSpace });
    // Something to bind until the first strike.
    this.setFigure(new Uint8Array(8), 2, new Uint8Array(1));
    this._vp = new Matrix4();
    this._object = new Matrix4();
    this._rotation = new Matrix4();
  }

  // The shape's baked grid (what Suzanne is traced from) and its name (what the others are).
  setShape(grid, name, edge, inflate) {
    this.uniforms.shapeId.value = shapeNames.indexOf(name);
    this.uniforms.shapeEdge.value = edge;
    this.uniforms.shapeInflate.value = inflate;
    const data = this.sdfTexture.image.data;
    for (let i = 0; i < data.length; i++) data[i] = DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, grid[i])));
    this.sdfTexture.needsUpdate = true;
  }

  // A byte per voxel of a T³ grid, and the arrival times on a grid of half that (grow.worker.js).
  setFigure(data, T, arrival) {
    const H = T >> 1;
    this.arrivalTexture?.dispose();
    const a = new Data3DTexture(arrival, H, H, H);
    a.format = RedFormat;
    a.type = UnsignedByteType;
    a.minFilter = a.magFilter = NearestFilter;
    a.unpackAlignment = 1;
    a.needsUpdate = true;
    this.arrivalTexture = a;
    this.uniforms.tArrival.value = a;
    if (!this.figureTexture || this.figureTexture.image.width !== T) {
      this.figureTexture?.dispose();
      const texture = new Data3DTexture(data, T, T, T);
      texture.format = RedFormat;
      texture.type = UnsignedByteType;
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      this.figureTexture = texture;
      this.uniforms.tFigure.value = texture;
    } else this.figureTexture.image.data = data;
    this.figureTexture.needsUpdate = true;
    this.uniforms.figureVoxel.value = (2 * EXTENT) / T;
  }

  // The object's pose: where its centre is, its turn about the vertical, its size.
  setPose(center, angle, scale) {
    this._rotation.makeRotationY(angle);
    this.uniforms.objectRotation.value.setFromMatrix4(this._rotation);
    this.uniforms.objectCenter.value.copy(center);
    this.uniforms.objectScale.value = scale;
    this._object.makeRotationY(angle).scale(new Vector3(scale, scale, scale)).setPosition(center);
    this.uniforms.objectInverse.value.copy(this._object).invert();
  }

  compile(renderer) {
    return renderer.compileAsync(this.scene, this.camera);
  }

  render(renderer, hdr, { depthTexture, camera, width, height }) {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const u = this.uniforms;
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.viewProjection.value.copy(this._vp);
    u.inverseViewProjection.value.copy(this._vp).invert();
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.sceneSize.value.set(width, height);
    u.pixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (camera.zoom * height);
    u.tScene.value = hdr;
    u.tDepth.value = depthTexture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    return this.target.texture;
  }
}

export { Glass };
