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

self.onmessage = ({ data: { type, key, seedKey, options, size } }) => {
  if (type === "noise") {
    const data = bakeNoiseVolume(size);
    self.postMessage({ type, data }, [data.buffer]);
    return;
  }
  let built;
  try {
    built = buildLabyrinth({ ...options, rand: seededRandom(seedKey) });
  } catch (error) {
    self.postMessage({ key, error: String(error?.stack ?? error) });
    return;
  }
  const { shape, floorGeometry, wallGeometry, hintGeometry, ...labyrinth } = built;
  const transfer = [];
  labyrinth.floorGeometry = packGeometry(floorGeometry, transfer);
  labyrinth.wallGeometry = packGeometry(wallGeometry, transfer);
  labyrinth.hintGeometry = packGeometry(hintGeometry, transfer);
  self.postMessage({ key, labyrinth }, transfer);
};
