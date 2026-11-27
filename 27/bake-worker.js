// Rasterizes a burrow off the page, so a new piece never stalls a frame.
import { rasterizeBurrow } from "./volume.js";

self.onmessage = ({ data: { id, job } }) => {
  const r = rasterizeBurrow(job);
  self.postMessage({ id, r }, [r.burrowData.buffer, r.glowData.buffer]);
};
