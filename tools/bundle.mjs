// Bundles each day page (N/index.html + N/main.js) into N/bundle-<hash>.js and points the deployed page at it; a day that fails stays per-file.
// What every day runs first, in the same order, goes in a shared chunks/vendor-<hash>.js, so modules run in per-file order (no esbuild splitting).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

const IMPORTMAP = /[ \t]*<script type="importmap">([\s\S]*?)<\/script>[ \t]*\r?\n?/;
const ENTRY_TAG = '<script type="module" src="main.js"></script>';
const OUTPUT_PATH = /^[^/]+\/[^/]+\.js$/; // day bundles and chunks sit one level below the site root
const VENDOR = "\0vendor";

// Site-relative paths for a page's importmap: exact keys and "prefix/" keys, longest key first.
function readImportMap(html, day) {
  const m = html.match(IMPORTMAP);
  const { imports = {}, scopes } = m ? JSON.parse(m[1]) : {};
  if (scopes) throw new Error("importmap scopes are not supported");
  const map = Object.entries(imports).map(([key, value]) => {
    if (/^[a-z]+:|^\//i.test(value)) throw new Error(`importmap target ${value} is not page-relative`);
    let target = posix.normalize(posix.join(day, value));
    if (value.endsWith("/") && !target.endsWith("/")) target += "/";
    return [key, target];
  });
  return map.sort((a, b) => b[0].length - a[0].length);
}

function resolveBare(map, spec) {
  for (const [key, target] of map) {
    if (key === spec) return target;
    if (key.endsWith("/") && spec.startsWith(key)) return target + spec.slice(key.length);
  }
  return null;
}

// import.meta.url becomes the source file's own url, computed from the output file's url.
const pinImportMeta = (src, file) => src.replace(/\bimport\.meta\.url\b/g, `new URL(${JSON.stringify("../" + file)},import.meta.url).href`);

// Resolves specifiers like the page would (importmap, relative paths) to tracked files and loads
// their GLSL-stripped source. With `vendor.file` set, vendor modules become re-exports of that chunk.
function sitePlugin({ root, map, tracked, sources, vendor }) {
  return {
    name: "site",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return args.path === VENDOR ? { path: VENDOR, namespace: "vendor-entry" } : { path: posix.normalize(args.path), namespace: "site" };
        if (args.namespace === "vendor-ref") return { path: "../" + vendor.file, external: true };
        const spec = args.path;
        let file;
        if (args.namespace === "vendor-entry") file = spec;
        else if (/^\.{0,2}\//.test(spec)) file = spec.startsWith("/") ? null : posix.normalize(posix.join(posix.dirname(args.importer), spec));
        else if (!/^[a-z]+:/i.test(spec)) file = resolveBare(map, spec);
        if (!file || !tracked.has(file)) return { errors: [{ text: `cannot resolve ${spec} from ${args.importer}` }] };
        if (vendor?.file && vendor.names.has(file)) return { path: file, namespace: "vendor-ref" };
        return { path: file, namespace: "site" };
      });
      b.onLoad({ filter: /.*/, namespace: "site" }, (args) => {
        const src = sources.get(args.path) ?? (args.path.endsWith(".mjs") ? readFileSync(join(root, args.path), "utf8") : undefined);
        if (src === undefined) return { errors: [{ text: `${args.path} is not a tracked script` }] };
        return { contents: pinImportMeta(src, args.path), loader: "js", resolveDir: root };
      });
      b.onLoad({ filter: /.*/, namespace: "vendor-entry" }, () => ({
        contents: [...vendor.names].map(([file, names]) => `export { ${names.map(([n, id]) => `${n} as ${id}`).join(", ")} } from ${JSON.stringify(file)};`).join("\n"),
        loader: "js",
        resolveDir: root,
      }));
      b.onLoad({ filter: /.*/, namespace: "vendor-ref" }, (args) => ({
        contents: `export { ${vendor.names.get(args.path).map(([n, id]) => `${id} as ${n}`).join(", ")} } from "vendor";`,
        loader: "js",
        resolveDir: root,
      }));
    },
  };
}

const common = { bundle: true, format: "esm", target: "es2022", charset: "utf8", write: false, metafile: true, logLevel: "silent" };
const minified = {
  minify: true,
  ignoreAnnotations: true, // keeps /*@__PURE__*/ objects, whose uuids draw from the seeded Math.random
  legalComments: "inline",
};

const errorText = (e) => e.errors?.map((x) => x.text).join("; ") || e.message;

// The order the browser evaluates a day's modules in: post-order over static imports.
async function evaluationOrder(esbuild, ctx, day) {
  const { metafile } = await esbuild.build({ ...common, entryPoints: [`${day}/main.js`], absWorkingDir: ctx.root, outdir: ctx.root, plugins: [sitePlugin(ctx)] });
  const key = (p) => p.replace(/^site:/, "");
  const inputs = Object.fromEntries(Object.entries(metafile.inputs).map(([k, v]) => [key(k), v]));
  const order = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const imp of inputs[file]?.imports ?? []) if (imp.kind === "import-statement") visit(key(imp.path));
    order.push(file);
  };
  visit(`${day}/main.js`);
  return order;
}

async function exportNames(esbuild, ctx, file) {
  const { metafile } = await esbuild.build({ ...common, entryPoints: [file], absWorkingDir: ctx.root, outdir: ctx.root, plugins: [sitePlugin(ctx)] });
  return Object.values(metafile.outputs).find((o) => o.entryPoint)?.exports ?? [];
}

const outputsOf = (root, result, tracked) =>
  result.outputFiles.map((f) => {
    const path = relative(root, f.path).split(sep).join("/");
    if (!OUTPUT_PATH.test(path)) throw new Error(`output ${path} is not one level below the site root`);
    if (tracked.has(path)) throw new Error(`output ${path} would overwrite a tracked file`);
    return { path, text: f.text };
  });

async function buildGroup(esbuild, ctx, days, log) {
  const orders = [];
  const ok = [];
  for (const day of days) {
    try {
      orders.push(await evaluationOrder(esbuild, ctx, day));
      ok.push(day);
    } catch (e) {
      ctx.skipped.push(`${day} (${errorText(e)})`);
    }
  }
  if (!ok.length) return;

  // Longest run of modules that every day evaluates first, in the same order.
  let n = 0;
  if (ok.length > 1) while (orders.every((o) => o[n] !== undefined && o[n] === orders[0][n])) n++;
  let vendor = null;
  const outputs = [];
  if (n > 0) {
    try {
      let id = 0;
      const names = new Map();
      for (const file of orders[0].slice(0, n)) names.set(file, (await exportNames(esbuild, ctx, file)).map((name) => [name, `e${(id++).toString(36)}`]));
      const pending = { names, file: null };
      const result = await esbuild.build({ ...common, ...minified, entryPoints: [VENDOR], entryNames: "chunks/vendor-[hash]", absWorkingDir: ctx.root, outdir: ctx.root, plugins: [sitePlugin({ ...ctx, vendor: pending })] });
      const [out] = outputsOf(ctx.root, result, ctx.tracked);
      vendor = { names, file: out.path };
      outputs.push(out);
      log(`bundle: ${n} modules that ${ok.join(", ")} all run first go in ${out.path}`);
    } catch (e) {
      log(`bundle: no vendor chunk for ${ok.join(", ")} (${errorText(e)}), each day bundles everything`);
    }
  }

  const built = [];
  for (const day of ok) {
    try {
      const result = await esbuild.build({
        ...common,
        ...minified,
        entryPoints: { [`${day}/bundle`]: `${day}/main.js` },
        entryNames: "[dir]/[name]-[hash]", // hashed, so a cached page never pairs with a vendor chunk from another deploy
        absWorkingDir: ctx.root,
        outdir: ctx.root,
        plugins: [sitePlugin({ ...ctx, vendor })],
      });
      const [out] = outputsOf(ctx.root, result, ctx.tracked);
      outputs.push(out);
      built.push([day, posix.basename(out.path)]);
    } catch (e) {
      ctx.skipped.push(`${day} (${errorText(e)})`);
    }
  }
  if (!built.length) return;

  for (const { path, text } of outputs) {
    mkdirSync(dirname(join(ctx.outDir, path)), { recursive: true });
    writeFileSync(join(ctx.outDir, path), text);
  }
  for (const [day, script] of built) {
    const tags = [...(vendor ? [`<link rel="modulepreload" href="../${vendor.file}" />`] : []), `<script type="module" src="${script}"></script>`];
    const html = readFileSync(join(ctx.root, day, "index.html"), "utf8").replace(IMPORTMAP, "").replace(ENTRY_TAG, tags.join("\n    "));
    writeFileSync(join(ctx.outDir, day, "index.html"), html);
    ctx.bundled.push(day);
  }
}

export async function bundleDays({ esbuild, root, outDir, files, sources, log = console.log }) {
  const tracked = new Set(files);
  const groups = new Map();
  const ctx = { root, outDir, tracked, sources, bundled: [], skipped: [] };
  for (const file of files) {
    const day = file.match(/^([^/]+)\/index\.html$/)?.[1];
    if (!day || !tracked.has(`${day}/main.js`)) continue;
    const html = readFileSync(join(root, file), "utf8");
    try {
      if (html.split(ENTRY_TAG).length !== 2) throw new Error(`needs exactly one ${ENTRY_TAG}`);
      if (/<script type="module"(?! src="main\.js")/.test(html)) throw new Error("has other module scripts");
      const map = readImportMap(html, day);
      const key = JSON.stringify(map);
      if (!groups.has(key)) groups.set(key, { map, days: [] });
      groups.get(key).days.push(day);
    } catch (e) {
      ctx.skipped.push(`${day} (${e.message})`);
    }
  }
  // Days with the same importmap resolve every module alike, so they can share a vendor chunk.
  for (const { map, days } of groups.values()) await buildGroup(esbuild, { ...ctx, map }, days, log);
  log(`bundled ${ctx.bundled.length} days (${ctx.bundled.join(", ")})` + (ctx.skipped.length ? `; left per-file: ${ctx.skipped.join(", ")}` : ""));
  return { bundled: ctx.bundled, skipped: ctx.skipped };
}
