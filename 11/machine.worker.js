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

// The last machine's plain geometry, kept here (its buffers are copied to the page, not transferred): a change of finish
// alone (Chamfer, Wear) reuses it and only rebuilds the worn parts.
let last = { key: null, prebuilt: null, dir: null };

onmessage = ({ data: { id, options, period } }) => {
  try {
    const { chamfer, erosion, ...layout } = options;
    const key = JSON.stringify(layout);
    const reuse = last.key === key ? last.prebuilt : null;
    const prebuilt = new Map();
    const m = createMachine({ ...options, ...(reuse ? { prebuilt: reuse } : {}), record: prebuilt });
    if (reuse) for (const [k, v] of reuse) if (!prebuilt.has(k)) prebuilt.set(k, v);
    const results = m.parts.map((p) => {
      if (p.kind === "chain") return null;
      const r = p.build.result;
      if (!r?.position) return null;
      r.weld = weldAttributes(r.position, r.normal, r.index);
      return r;
    });
    // The same layout keeps its view (the page keeps its framing on a change of finish).
    const dir = reuse && last.dir ? last.dir : bestView(m, motion(0, { period, layout: m.escapement.layout }).wheel, 0).toArray();
    last = { key, prebuilt, dir };
    const seen = new Set();
    strip(prebuilt, seen);
    for (const r of results) strip(r, seen);
    // The worn results' buffers are transferred, each once; the prebuilt ones (also a result where nothing wears) stay.
    const kept = new Set(), buffers = new Set();
    const collect = (o, into, visited = new Set()) => {
      if (!o || typeof o !== "object" || visited.has(o)) return;
      visited.add(o);
      if (ArrayBuffer.isView(o)) return void into.add(o.buffer);
      for (const v of o instanceof Map ? o.values() : Object.values(o)) collect(v, into, visited);
    };
    collect(prebuilt, kept);
    collect(results, buffers);
    for (const b of kept) buffers.delete(b);
    postMessage({ id, prebuilt, results, dir }, [...buffers]);
  } catch (e) {
    postMessage({ id, error: String(e?.stack ?? e) });
  }
};
