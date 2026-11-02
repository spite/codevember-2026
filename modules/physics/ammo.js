// Loads the UMD ammo.wasm.js build from an ES module, no <script> tag needed.

const defaultURL = new URL("../../third_party/ammo.wasm.js", import.meta.url);

let pending = null;

async function evaluateFactory(url) {
  if (typeof globalThis.Ammo === "function") return globalThis.Ammo;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Ammo: ${response.status} loading ${url}`);
  const source = await response.text();
  // Shadow the UMD/CommonJS globals so the build always returns its factory.
  const run = new Function(
    "module",
    "exports",
    "define",
    "__dirname",
    "__filename",
    `${source}\nreturn Ammo;\n//# sourceURL=${url}`,
  );
  return run();
}

// Resolves to the Ammo module; the instance is shared by every caller.
export function loadAmmo({ url = defaultURL, wasmBinary } = {}) {
  if (pending) return pending;
  const href = new URL(url, import.meta.url).href;
  pending = evaluateFactory(href).then((factory) => {
    const options = { locateFile: (file) => new URL(file, href).href };
    if (wasmBinary) options.wasmBinary = wasmBinary;
    return factory(options);
  });
  pending.catch(() => (pending = null));
  return pending;
}
