import {
  WebGLRenderTarget,
  DepthTexture,
  FloatType,
  RedFormat,
  NearestFilter,
  LinearFilter,
  LessEqualCompare,
  ClampToEdgeWrapping,
  OrthographicCamera,
  Matrix4,
  Quaternion,
  Sphere,
  Vector3,
  Color,
} from "three";
import { globalUniforms } from "./uniforms.js";
import { renderVariant } from "./variants.js";

const _m = new Matrix4();
const _q = new Quaternion();
const _qi = new Quaternion();
const _c = new Vector3();
const _up = new Vector3();
const _origin = new Vector3();
const _clearColor = new Color();

const castsShadow = (object) => !object.userData.noShadow;

class ShadowPass {
  constructor({ mapSize = 2048 } = {}) {
    this.mapSize = mapSize;
    // A texture can't be sampled both raw and with hardware comparison, so the shadow variant also writes its depth
    // (gl_FragCoord.z, the value the depth buffer stores) to a float colour target for the raw reads.
    this.compareTexture = new DepthTexture(mapSize, mapSize, FloatType);
    this.compareTexture.minFilter = LinearFilter;
    this.compareTexture.magFilter = LinearFilter;
    this.compareTexture.wrapS = ClampToEdgeWrapping;
    this.compareTexture.wrapT = ClampToEdgeWrapping;
    this.compareTexture.compareFunction = LessEqualCompare;
    this.target = new WebGLRenderTarget(mapSize, mapSize, {
      format: RedFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: true,
      depthTexture: this.compareTexture,
      generateMipmaps: false,
    });
    this.depthTexture = this.target.texture;
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 3);
    this.bounds = new Sphere(new Vector3(), 5);
    this.filter = castsShadow;
  }

  // Bounds of the shadow casters; the light direction is read from the globals on every render.
  fit(box3OrSphere) {
    if (box3OrSphere.isBox3) box3OrSphere.getBoundingSphere(this.bounds);
    else this.bounds.copy(box3OrSphere);
    this.updateCamera();
  }

  updateCamera() {
    const L = globalUniforms.lightDirection.value;
    // Quantised radius keeps the texel size, and so the snapping, stable while bounds wobble.
    const r = Math.pow(2, Math.ceil(Math.log2(Math.max(this.bounds.radius, 1e-3)) * 8) / 8);
    const texel = (2 * r) / this.mapSize;

    _up.set(0, 1, 0);
    if (Math.abs(L.y) > 0.99) _up.set(0, 0, 1);
    _m.lookAt(L, _origin, _up);
    _q.setFromRotationMatrix(_m);
    _qi.copy(_q).invert();

    _c.copy(this.bounds.center).applyQuaternion(_qi);
    _c.x = Math.round(_c.x / texel) * texel;
    _c.y = Math.round(_c.y / texel) * texel;
    _c.applyQuaternion(_q);

    const camera = this.camera;
    camera.quaternion.copy(_q);
    camera.position.copy(_c).addScaledVector(L, 2 * r);
    camera.left = -r;
    camera.right = r;
    camera.top = r;
    camera.bottom = -r;
    camera.near = 0;
    camera.far = 3 * r + texel;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  render(renderer, scene) {
    this.updateCamera();
    const camera = this.camera;

    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.getClearColor(_clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    // The raw map clears to the far plane, like the depth.
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, true, false);
    renderer.setClearColor(_clearColor, clearAlpha);
    renderer.autoClear = false;
    renderVariant(renderer, scene, camera, "shadow", this.target, this.filter);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prevTarget);

    const u = globalUniforms;
    u.shadowMap.value = this.depthTexture;
    u.shadowMapCmp.value = this.compareTexture;
    u.shadowMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.shadowMapSize.value.set(this.mapSize, this.mapSize);
    u.shadowEnabled.value = 1;
  }

  dispose() {
    this.target.dispose();
    this.compareTexture.dispose();
    if (globalUniforms.shadowMap.value === this.depthTexture) {
      globalUniforms.shadowMap.value = null;
      globalUniforms.shadowMapCmp.value = null;
      globalUniforms.shadowEnabled.value = 0;
    }
  }
}

export { ShadowPass };
