// Builds a machine off the main thread: its layout's plain geometry (sent back as a prebuilt cache, so the page's own
// createMachine only lays the parts out), every part's worn geometry with its rust attributes, and the best view.
import { createMachine } from "./train.js";
import { motion } from "./escapement.js";
import { bestView } from "./view.js";
import { weldAttributes } from "./weld.js";

// Functions (a gear's tooth half-width) can't be posted, and nothing on the page reads them.
function strip(o, seen) {
  if (!o || typeof o !== "object" || seen.has(o) || ArrayBuffer.isView(o)) return;
  seen.add(o);
  if (o instanceof Map) for (const v of o.values()) strip(v, seen);
  else for (const [k, v] of Object.entries(o)) typeof v === "function" ? delete o[k] : strip(v, seen);
}

onmessage = ({ data: { id, options, period } }) => {
  try {
    const prebuilt = new Map();
    const m = createMachine({ ...options, record: prebuilt });
    const results = m.parts.map((p) => {
      if (p.kind === "chain") return null;
      const r = p.build.result;
      if (!r?.position) return null;
      r.weld = weldAttributes(r.position, r.normal, r.index);
      return r;
    });
    const dir = bestView(m, motion(0, { period, layout: m.escapement.layout }).wheel, 0).toArray();
    const seen = new Set();
    strip(prebuilt, seen);
    for (const r of results) strip(r, seen);
    // Each buffer once in the transfer list (a result can be the same geometry as its prebuilt entry).
    const buffers = new Set();
    const collect = (o, visited = new Set()) => {
      if (!o || typeof o !== "object" || visited.has(o)) return;
      visited.add(o);
      if (ArrayBuffer.isView(o)) return void buffers.add(o.buffer);
      for (const v of o instanceof Map ? o.values() : Object.values(o)) collect(v, visited);
    };
    collect(prebuilt);
    collect(results);
    postMessage({ id, prebuilt, results, dir }, [...buffers]);
  } catch (e) {
    postMessage({ id, error: String(e?.stack ?? e) });
  }
};
