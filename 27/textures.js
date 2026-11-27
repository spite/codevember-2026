// The baked volumes as three textures, and the bake split between the page (seeded primitives) and a worker.
import { Data3DTexture, RGBAFormat, UnsignedByteType, HalfFloatType, LinearFilter, ClampToEdgeWrapping, RepeatWrapping } from "three";
import { BLOCK_SPECS, NOISE_SIZE, sharedNoiseBytes, buildBurrowPrimitives, rasterizeBurrow } from "./volume.js";

function volumeTexture(data, size, type, wrap) {
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = type;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = wrap;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

let noiseTex = null;
export function getSharedNoiseTexture() {
  noiseTex ??= volumeTexture(sharedNoiseBytes(), NOISE_SIZE, UnsignedByteType, RepeatWrapping);
  return noiseTex;
}

function toVolume(shape, r) {
  return {
    shape,
    spec: BLOCK_SPECS[shape] || BLOCK_SPECS.cube,
    burrowTex: volumeTexture(r.burrowData, r.T, HalfFloatType, ClampToEdgeWrapping),
    glowTex: volumeTexture(r.glowData, r.G, UnsignedByteType, ClampToEdgeWrapping),
    voxel: r.voxel,
    bandWorld: r.bandWorld,
  };
}

let worker = null;
let nextId = 0;
const pending = new Map();
function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL("./bake-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data: { id, r } }) => {
      pending.get(id)?.(r);
      pending.delete(id);
    };
  } catch {
    worker = false;
  }
  return worker;
}

// Draws the seeded primitives now (so seeds replay the same piece), rasterizes in the worker. Resolves to the volume.
export function bakeBurrowVolumes({ archetype, shape, complexity, T, G }) {
  const job = { ...buildBurrowPrimitives({ archetype, shape, complexity }), T, G };
  const w = getWorker();
  if (!w) return Promise.resolve(toVolume(shape, rasterizeBurrow(job)));
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (r) => resolve(toVolume(shape, r)));
    w.postMessage({ id, job });
  });
}
