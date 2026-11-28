// The labyrinth and noise builds, for the worker (build.worker.js) or, when it can't load, the page.
import { buildLabyrinth } from "./maze.js";
import { bakeNoiseVolume } from "./noise.js";

// Same stream as seededRandom() in modules/random.js, which can't load in a worker.
function seededRandom(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function packGeometry(geometry, transfer) {
  const attributes = {};
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    attributes[name] = { array: attr.array, itemSize: attr.itemSize };
    transfer.push(attr.array.buffer);
  }
  const index = geometry.index ? geometry.index.array : null;
  if (index) transfer.push(index.buffer);
  return { attributes, index };
}

// One job: the noise volume or a labyrinth, answered through post(message, transfer) either way.
export function runJob({ type, key, seedKey, options, size }, post) {
  if (type === "noise") {
    // Answered either way: without it the page keeps the flat volume it started with.
    try {
      const data = bakeNoiseVolume(size);
      post({ type, data }, [data.buffer]);
    } catch (error) {
      post({ type, data: null, error: String(error?.stack ?? error) });
    }
    return;
  }
  try {
    const { shape, floorGeometry, wallGeometry, hintGeometry, ...labyrinth } = buildLabyrinth({ ...options, rand: seededRandom(seedKey) });
    const transfer = [];
    labyrinth.floorGeometry = packGeometry(floorGeometry, transfer);
    labyrinth.wallGeometry = packGeometry(wallGeometry, transfer);
    labyrinth.hintGeometry = packGeometry(hintGeometry, transfer);
    post({ key, labyrinth }, transfer);
  } catch (error) {
    post({ key, error: String(error?.stack ?? error) });
  }
}
