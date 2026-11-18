// Light shafts: the sun scattered toward the eye along every view ray, marched at reduced resolution through the
// shadow map and the caustics (so they fan out from the sun and break behind the kelp), then blurred with the depth as a
// guide and added back at full resolution. The same march takes out the diffuse light's glow (waterInscatter) where kelp
// overhead shades the water, so the forest's water is darker than the open water's.
import { Mesh, Scene, OrthographicCamera, BufferGeometry, Float32BufferAttribute, RawShaderMaterial, GLSL3, WebGLRenderTarget, HalfFloatType, RGBAFormat, LinearFilter, NearestFilter, ClampToEdgeWrapping, NoColorSpace, Matrix4, Vector2, Vector3 } from "three";
import { fullscreenVertex } from "shaders/pipeline/copy.js";
import { waterUniforms, waterGLSL } from "./water.js";
import { shadowUniforms, shadowGLSL } from "./shadow.js";

function target(filter = LinearFilter) {
  return new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
    colorSpace: NoColorSpace,
  });
}

// waterGLSL reads three's cameraPosition, which a raw shader doesn't get.
const header = /* glsl */ `
precision highp float;
precision highp sampler2DShadow;
uniform vec3 cameraPosition;
`;

export class Shafts {
  constructor({ steps = 32, scale = 0.5 } = {}) {
    this.scale = scale;
    this.march = target(NearestFilter);
    this.blurH = target(NearestFilter);
    this.blurV = target(NearestFilter);
    this.common = {
      tDepth: { value: null },
      uProjectionInverse: { value: new Matrix4() },
      uCameraWorld: { value: new Matrix4() },
      cameraPosition: { value: new Vector3() },
      uNear: { value: 0.1 },
      uFar: { value: 100 },
    };
    this.marchMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
      defines: { STEPS: steps },
      uniforms: { ...waterUniforms, ...shadowUniforms, ...this.common, uStrength: { value: 1 }, uFrame: { value: 0 }, uMaxDistance: { value: 70 } },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `${header}
        uniform sampler2D tDepth;
        uniform mat4 uProjectionInverse;
        uniform mat4 uCameraWorld;
        uniform float uStrength;
        uniform float uFrame;
        uniform float uMaxDistance;
        in vec2 vUv;
        layout(location = 0) out vec4 outColor;
        ${waterGLSL}
        ${shadowGLSL}

        float hg(float mu, float g) {
          float d = 1.0 + g * g - 2.0 * g * mu;
          return (1.0 - g * g) / (12.566371 * d * sqrt(d));
        }

        void main() {
          float depth = textureLod(tDepth, vUv, 0.0).r;
          vec4 v = uProjectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec3 viewPos = v.xyz / v.w;
          vec3 rd = normalize(mat3(uCameraWorld) * viewPos);
          float dist = depth >= 1.0 ? 1e4 : length(viewPos);
          float tEnd = min(min(dist, waterDistance(cameraPosition, rd)), uMaxDistance);
          if (uMurk >= 1.0) {
            outColor = vec4(0.0, 0.0, 0.0, tEnd);
            return;
          }
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * mod(uFrame, 64.0), vec2(0.06711056, 0.00583715))));
          vec3 acc = vec3(0.0);
          vec3 shade = vec3(0.0);
          float metresPerDepth = shadowDepthScale();
          // Each step's shadow lookup spreads over a disc across the sun, wider the deeper it is below the canopy, as the
          // sun's spread does: a blade's thin shadow or a narrow gap washes out of the shafts, while wide gaps stay.
          float spread = 1.0 / shadowUVScale();
          float spin = fract(jitter * 7.13 + 0.37) * 6.2831853;
          // waterInscatter's integrand along the ray, from the diffuse light at the eye.
          vec3 sa = uSigmaLight * 1.15;
          vec3 k = sa * rd.y - uSigma;
          // Denser near the eye, where the shafts' edges are widest on screen.
          for (int i = 0; i < STEPS; i++) {
            float u0 = (float(i) + jitter) / float(STEPS);
            float t = tEnd * u0 * u0;
            float dt = tEnd * (2.0 * u0) / float(STEPS);
            vec3 p = cameraPosition + rd * t;
            float d = depthAt(p);
            vec3 light = exp(-uSigmaLight * d / uSunDir.y - uSigma * t);
            float a = spin + float(i) * 2.3999632;
            vec2 offset = sqrt(fract(float(i) * 0.618034 + jitter)) * (0.12 + 0.045 * d) * spread * vec2(cos(a), sin(a));
            vec3 through = sunThroughKelpFast(p, metresPerDepth, offset);
            if (uStrength > 0.0) acc += light * through * causticAt(p) * dt;
            shade += exp(k * t) * (1.0 - forestShade(through)) * dt;
          }
          float mu = dot(rd, uSunDir);
          float phase = 0.55 * hg(mu, 0.82) + 0.45 * hg(mu, 0.25);
          vec3 a0 = uAmbient * exp(-sa * depthAt(cameraPosition));
          vec3 L = (acc * uSunColor * uScatterSun * phase * uStrength - shade * a0 * uScatter) * (1.0 - uMurk);
          // Alpha: how far the ray went, the guide for the blur and the upsampling.
          outColor = vec4(L, tEnd);
        }
      `,
    });
    // Separable blur that doesn't cross depth edges (the alpha holds the distance).
    const blurFragment = /* glsl */ `
      precision highp float;
      uniform sampler2D tInput;
      uniform vec2 uStep;
      in vec2 vUv;
      layout(location = 0) out vec4 outColor;
      void main() {
        vec4 c = textureLod(tInput, vUv, 0.0);
        float z = c.a;
        vec3 sum = c.rgb;
        float wsum = 1.0;
        for (int i = 1; i <= 4; i++) {
          for (int s = -1; s <= 1; s += 2) {
            vec4 t = textureLod(tInput, vUv + uStep * float(i * s), 0.0);
            float w = exp(-float(i * i) / 8.0) * exp(-abs(t.a - z) / (0.04 * z + 0.05));
            sum += t.rgb * w;
            wsum += w;
          }
        }
        outColor = vec4(sum / wsum, z);
      }
    `;
    this.blurMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: { tInput: { value: null }, uStep: { value: new Vector2() } },
      vertexShader: fullscreenVertex,
      fragmentShader: blurFragment,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new Mesh(geometry, this.marchMaterial);
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = this.height = 1;
  }

  get materials() {
    return [this.marchMaterial, this.blurMaterial];
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.round(width * this.scale));
    this.height = Math.max(1, Math.round(height * this.scale));
    for (const t of [this.march, this.blurH, this.blurV]) t.setSize(this.width, this.height);
  }

  pass(renderer, material, target) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  render(renderer, { depthTexture, camera, frame, strength }) {
    const c = this.common;
    c.tDepth.value = depthTexture;
    c.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    c.uCameraWorld.value.copy(camera.matrixWorld);
    c.cameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
    const m = this.marchMaterial.uniforms;
    m.uFrame.value = frame;
    m.uStrength.value = strength;
    this.pass(renderer, this.marchMaterial, this.march);
    const b = this.blurMaterial.uniforms;
    b.tInput.value = this.march.texture;
    b.uStep.value.set(1 / this.width, 0);
    this.pass(renderer, this.blurMaterial, this.blurH);
    b.tInput.value = this.blurH.texture;
    b.uStep.value.set(0, 1 / this.height);
    this.pass(renderer, this.blurMaterial, this.blurV);
    return this.blurV.texture;
  }
}
