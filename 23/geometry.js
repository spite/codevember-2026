import {
  BufferGeometry,
  BufferAttribute,
  Data3DTexture,
  RedFormat,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  ClampToEdgeWrapping,
} from "three";
import { isPeriodicShape, SDF_SIZE, SDF_BOUND, HEAT_SIZE, FLOW_SIZE } from "./meshData.js";

const SHAPES = ["Sphere", "Boulder", "Meteorite", "Rounded Cube", "Crystal", "Dodecahedron", "Icosahedron", "Star", "Torus", "Twisted Ring", "Trefoil Knot", "Suzanne"];

// Builds meshes and their distance fields in a worker.
class MeshBuilder {
  constructor() {
    this.worker = new Worker(new URL("./meshWorker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.nextId = 0;
    this.worker.onmessage = (e) => {
      const { id, m } = e.data;
      this.pending.get(id)?.(m);
      this.pending.delete(id);
    };
  }

  // Resolves to { geometry, sdf, heat, emitters, volumeRadius }; the readback is copied, so the baker can rebake at once.
  build({ radius, baker, shape, seed, levels, tol, maxTriangles, dispAmp }) {
    const id = this.nextId++;
    const opts = {
      radius,
      shape,
      seed,
      levels,
      tol,
      maxTriangles,
      dispAmp,
      pad: baker.padFraction,
      faceTexels: baker.faceSize * (1 - 2 * baker.padFraction),
      info: { data: baker.infoPixels.slice(), flow: baker.flowPixels.slice(), width: baker.infoWidth, height: baker.infoHeight },
    };
    return new Promise((resolve) => {
      this.pending.set(id, (m) => resolve({ geometry: toGeometry(m), sdf: m.sdf, heat: m.heat, emitters: m.emitters, flow: m.flow, volumeRadius: m.volumeRadius }));
      this.worker.postMessage({ id, opts }, [opts.info.data.buffer, opts.info.flow.buffer]);
    });
  }
}

// A half-float volume over [-SDF_BOUND, SDF_BOUND]^3. Distance fields start empty (all outside, 4.0).
function createVolumeTexture(n, fill) {
  const texture = new Data3DTexture(new Uint16Array(n * n * n).fill(fill), n, n, n);
  texture.format = RedFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.unpackAlignment = 2;
  texture.needsUpdate = true;
  return texture;
}

const createSdfTexture = () => createVolumeTexture(SDF_SIZE, 0x4400);
const createHeatTexture = () => createVolumeTexture(HEAT_SIZE, 0);

// Flow around the rock (xyz direction, w phase; see buildFlowVolume), starting as "no flow anywhere"
function createFlowTexture() {
  const n = FLOW_SIZE;
  const data = new Uint16Array(n * n * n * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 0xbc00;
  const texture = new Data3DTexture(data, n, n, n);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function writeVolume(texture, data) {
  texture.image.data = data;
  texture.needsUpdate = true;
}

function toGeometry(m) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(m.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(m.normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(m.uvs, 2));
  geometry.setAttribute("aTangent", new BufferAttribute(m.tangents, 4));
  geometry.setAttribute("aTileBounds", new BufferAttribute(m.tileBounds, 4));
  geometry.setAttribute("aCellTexels", new BufferAttribute(m.cellTexels, 1));
  geometry.setIndex(new BufferAttribute(m.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export { MeshBuilder, SHAPES, isPeriodicShape, createSdfTexture, createHeatTexture, createFlowTexture, writeVolume, SDF_BOUND, SDF_SIZE, FLOW_SIZE };
