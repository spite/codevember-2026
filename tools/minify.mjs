// Copies the git-tracked site into <outDir>, minifying JS (per file, no bundling), GLSL in JS
// template literals, and CSS. Usage: node tools/minify.mjs <outDir> [--verbose]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const esbuild = await import(process.env.ESBUILD_MODULE ? pathToFileURL(process.env.ESBUILD_MODULE).href : "esbuild");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const outArg = args.find((a) => !a.startsWith("--"));
if (!outArg) {
  console.error("usage: node tools/minify.mjs <outDir> [--verbose]");
  process.exit(1);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim();
const outDir = resolve(outArg);

const KEYWORDS_BEFORE_EXPR = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

// Finds template literals (with their raw quasis) and quoted string literals in JS source.
function lex(src) {
  const templates = [];
  const strings = [];
  let i = 0;
  let exprEnd = false; // previous token ends an expression: "/" is division, "`" is a tagged template
  let lastComment = null;

  function skipString(q) {
    const start = i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") i++;
      i++;
    }
    i++;
    strings.push(src.slice(start + 1, i - 1));
  }

  function skipRegex() {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "[") (inClass = true), i++;
      else if (c === "]") (inClass = false), i++;
      else if (c === "/" && !inClass) break;
      else if (c === "\n") throw new Error("unterminated regex");
      else i++;
    }
    i++;
    while (/[a-z]/i.test(src[i] ?? "")) i++;
  }

  function template() {
    const start = i;
    const glslTag = !!lastComment && /^\/\*\s*glsl\s*\*\/$/i.test(lastComment.text) && /^\s*$/.test(src.slice(lastComment.end, start));
    const tagged = exprEnd;
    const quasis = [];
    i++;
    let qs = i;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "`") break;
      else if (c === "$" && src[i + 1] === "{") {
        quasis.push([qs, i]);
        i += 2;
        scan(true);
        i++;
        qs = i;
      } else i++;
    }
    quasis.push([qs, i]);
    i++;
    templates.push({ start, end: i, quasis, glslTag, tagged });
  }

  function scan(inExpr) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        const e = src.indexOf("\n", i);
        i = e < 0 ? src.length : e;
      } else if (c === "/" && n === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) throw new Error("unterminated comment");
        lastComment = { text: src.slice(i, e + 2), end: e + 2 };
        i = e + 2;
      } else if (/\s/.test(c)) i++;
      else if (c === "'" || c === '"') {
        skipString(c);
        exprEnd = true;
      } else if (c === "`") {
        template();
        exprEnd = true;
      } else if (c === "/") {
        if (exprEnd) {
          i++;
          exprEnd = false;
        } else {
          skipRegex();
          exprEnd = true;
        }
      } else if (/[\w$#\\]/.test(c) || c.charCodeAt(0) > 127) {
        const s = i;
        while (i < src.length && (/[\w$#\\]/.test(src[i]) || src.charCodeAt(i) > 127)) i++;
        exprEnd = !KEYWORDS_BEFORE_EXPR.has(src.slice(s, i));
      } else if (c === ")" || c === "]") {
        i++;
        exprEnd = true;
      } else if (c === "{") {
        depth++;
        i++;
        exprEnd = false;
      } else if (c === "}") {
        if (inExpr && depth === 0) return;
        depth--;
        i++;
        exprEnd = false;
      } else if (c === "." && /\d/.test(n ?? "")) {
        i++;
      } else {
        i++;
        exprEnd = false;
      }
    }
  }

  scan(false);
  return { templates, strings };
}

const GLSL_SIGNS = [
  /\b[iub]?vec[234]\b|\bmat[234]\b/,
  /\b(uniform|varying|in|out|attribute)\s+((highp|mediump|lowp)\s+)?\w+\s+\w+(\[\w*\])?\s*;/,
  /\b(void|float|vec[234]|int)\s+\w+\s*\([^)]*\)\s*\{?/,
  /^\s*#\s*(define|undef|ifdef|ifndef|if|elif|else|endif|version|extension|include|pragma)\b/m,
  /\b(texture|mix|clamp|dot|normalize|smoothstep)\s*\(/,
  /\b(const\s+)?(float|int)\s+\w+\s*=\s*-?[\d.]/,
];

function looksLikeGLSL(t, src) {
  if (t.glslTag) return true;
  if (t.tagged) return false;
  const text = t.quasis.map(([a, b]) => src.slice(a, b)).join("");
  if (/<\/?[a-z][\w-]*[\s>]/i.test(text.replace(/#include\s*<[^>\n]*>/g, ""))) return false;
  return GLSL_SIGNS.filter((re) => re.test(text)).length >= 2 && /;\s*$/m.test(text);
}

// Removes comments and redundant whitespace from the raw quasis of one GLSL template.
// Never joins lines, and at interpolations and the literal's ends only collapses whitespace.
function stripGLSL(quasis) {
  let comment = null; // comment still open at the end of the previous quasi: "line" | "block"
  const cleaned = quasis.map((raw) => {
    let out = "";
    let i = 0;
    if (comment === "line") {
      const e = raw.indexOf("\n");
      out += e < 0 ? raw : raw.slice(0, e);
      i = e < 0 ? raw.length : e;
      if (e >= 0) comment = null;
    } else if (comment === "block") {
      const e = raw.indexOf("*/");
      out += e < 0 ? raw : raw.slice(0, e + 2);
      i = e < 0 ? raw.length : e + 2;
      if (e >= 0) comment = null;
    }
    while (i < raw.length) {
      const c = raw[i];
      if (c === "\\") {
        out += raw.slice(i, i + 2);
        i += 2;
      } else if (c === "/" && raw[i + 1] === "/") {
        const e = raw.indexOf("\n", i);
        if (e < 0) {
          out += raw.slice(i);
          comment = "line";
          break;
        }
        i = e;
      } else if (c === "/" && raw[i + 1] === "*") {
        const e = raw.indexOf("*/", i + 2);
        if (e < 0) {
          out += raw.slice(i);
          comment = "block";
          break;
        }
        out += raw.slice(i, e).includes("\n") ? "\n" : " ";
        i = e + 2;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  });
  return cleaned.map((text, qi) => {
    const segs = text.split("\n");
    const kept = [];
    segs.forEach((seg, j) => {
      const first = j === 0;
      const last = j === segs.length - 1;
      let s = seg.replace(/[ \t\r\f\v]+/g, " ");
      if (!first) s = s.replace(/^ /, "");
      if (!last) s = s.replace(/ $/, "");
      if (s === "" && !first && !last) return;
      kept.push(s);
    });
    return kept.join("\n");
  });
}

// \ before a newline is a JS line continuation, so such a literal is left alone.
const hasContinuation = (raw) => /(^|[^\\])(\\\\)*\\\r?\n/.test(raw);

const unescape = (s) => s.replace(/\\(n|t|r|\\|'|"|`)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);

const stats = { glsl: 0, glslUntagged: 0, glslSkipped: 0, js: 0, css: 0, copied: 0, asIs: [] };
const glslBefore = [];
const glslAfter = [];
const literals = new Set();

function minifyGLSLInJS(src, file) {
  const { templates, strings } = lex(src);
  for (const s of strings) if (s.length >= 8 && /[;(#]/.test(s)) literals.add(unescape(s));
  const edits = [];
  for (const t of templates) {
    if (!looksLikeGLSL(t, src)) continue;
    const raws = t.quasis.map(([a, b]) => src.slice(a, b));
    if (raws.some(hasContinuation)) {
      stats.glslSkipped++;
      continue;
    }
    if (!t.glslTag) {
      stats.glslUntagged++;
      if (verbose) console.log(`untagged GLSL: ${file}:${src.slice(0, t.start).split("\n").length}`);
    }
    stats.glsl++;
    const stripped = stripGLSL(raws);
    glslBefore.push(raws.join("\n"));
    glslAfter.push(stripped.join("\n"));
    t.quasis.forEach(([a, b], k) => edits.push([a, b, stripped[k]]));
  }
  // Quasis never overlap: a nested literal sits inside an interpolation of its parent.
  edits.sort((x, y) => x[0] - y[0]);
  let out = "";
  let pos = 0;
  for (const [a, b, text] of edits) {
    out += src.slice(pos, a) + text;
    pos = b;
  }
  out += src.slice(pos);
  const recount = lex(out).templates.length;
  if (recount !== templates.length) throw new Error(`${file}: template count changed (${templates.length} -> ${recount})`);
  return out;
}

const isMinified = (src) => src.length > 20000 && src.length / (src.split("\n").length || 1) > 300;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
if (outDir === root || root.startsWith(outDir + "/") || files.some((f) => join(root, f).startsWith(outDir + "/")))
  throw new Error("outDir must not contain the repo or any tracked file");
rmSync(outDir, { recursive: true, force: true });

for (const file of files) {
  const from = join(root, file);
  const to = join(outDir, file);
  mkdirSync(dirname(to), { recursive: true });
  if (file.endsWith(".js")) {
    const src = readFileSync(from, "utf8");
    if (isMinified(src)) {
      copyFileSync(from, to);
      stats.asIs.push(file);
      continue;
    }
    const glsl = minifyGLSLInJS(src, file);
    const { code } = await esbuild.transform(glsl, {
      loader: "js",
      format: "esm",
      target: "es2022",
      minify: true,
      legalComments: "inline",
      charset: "utf8",
      sourcefile: file,
    });
    writeFileSync(to, code);
    stats.js++;
  } else if (file.endsWith(".css")) {
    const { code } = await esbuild.transform(readFileSync(from, "utf8"), { loader: "css", minify: true, legalComments: "inline", sourcefile: file });
    writeFileSync(to, code);
    stats.css++;
  } else {
    copyFileSync(from, to);
    stats.copied++;
  }
}

// A string the code looks for in a shader (e.g. an onBeforeCompile replace) must survive stripping.
const before = glslBefore.join("\n");
const after = glslAfter.join("\n");
const lost = [...literals].filter((s) => before.includes(s) && !after.includes(s));
if (lost.length) {
  console.error("GLSL stripping removed text that the code searches for:\n" + lost.map((s) => "  " + JSON.stringify(s)).join("\n"));
  process.exit(1);
}

console.log(
  `minified ${stats.js} js (${stats.glsl} GLSL literals, ${stats.glslUntagged} untagged, ${stats.glslSkipped} skipped), ${stats.css} css; ` +
    `copied ${stats.copied} files and ${stats.asIs.length} already-minified (${stats.asIs.join(", ")}) to ${outDir}`,
);
