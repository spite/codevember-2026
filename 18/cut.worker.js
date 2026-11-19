import { cutBatch } from "./cutter.js";

self.onmessage = (e) => {
  const { id, batch } = e.data;
  try {
    const results = cutBatch(batch);
    const transfer = [];
    for (const shapes of results) for (const s of shapes) transfer.push(s.outer.buffer, ...s.holes.map((h) => h.buffer));
    self.postMessage({ id, results }, transfer);
  } catch (err) {
    self.postMessage({ id, error: `${err.message}\n${err.stack}` });
  }
};
