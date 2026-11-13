// Shared helpers for the landing page and explainers: images fade in once loaded, and code
// (`.formula` blocks and inline <code>) gets syntax colours. Load as a classic script in <head>.
(() => {
  const root = document.documentElement;
  root.classList.add("fade-images");

  const css = `
.fade-images img:not(.loaded) { opacity: 0; }
.fade-images img { transition: opacity 0.6s ease; }
@media (prefers-reduced-motion: reduce) { .fade-images img { transition: none; } }
:root { --hl-fn: var(--accent, var(--candy, currentColor)); --hl-num: var(--second, color-mix(in oklab, var(--hl-fn) 50%, var(--muted, currentColor))); }
.hl-f { color: var(--hl-fn); }
.hl-n { color: var(--hl-num); }
.hl-k { font-weight: 600; }
.hl-s { color: var(--hl-num); }
.hl-c { color: var(--muted, currentColor); }
.eyebrow a { color: inherit; text-decoration: none; }
.eyebrow a:hover { color: var(--ink, currentColor); text-decoration: underline; }
.eyebrow a::before { content: ""; display: inline-block; margin-right: 0.55em; vertical-align: 0.02em; border-style: solid; border-width: 0.36em 0.5em 0.36em 0; border-color: transparent currentColor transparent transparent; transition: transform 0.2s ease; }
.eyebrow a:hover::before { transform: translateX(-3px); }
footer > .meta { margin-bottom: 12px; }
.hero .live { display: inline-flex; align-self: flex-start; align-items: center; gap: 9px; padding: 12px 16px; border-radius: 3px; font: 600 13px/1 var(--mono, monospace); letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; color: var(--bg, #fff); background: var(--accent, var(--candy, var(--ink, #000))); transition: background 0.2s ease; }
.hero .live:hover, .hero .live:focus-visible { background: var(--ink, #000); }
.hero .live:focus-visible { outline: 2px solid var(--accent, var(--candy, currentColor)); outline-offset: 2px; }`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const done = (img) => img.classList.add("loaded");
  // load and error don't bubble, so catch them on the way down.
  document.addEventListener("load", (e) => e.target.tagName === "IMG" && done(e.target), true);
  document.addEventListener("error", (e) => e.target.tagName === "IMG" && done(e.target), true);
  const sweep = () => {
    for (const img of document.images) if (img.complete) done(img);
  };

  const KEYWORDS = new Set("if else return const let var for while break continue true false null new function uniform varying void float int bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D".split(" "));
  const ID = "[A-Za-z_\\u00C0-\\u024F\\u0370-\\u03FF][\\w\\u00C0-\\u024F\\u0370-\\u03FF]*";
  const TOKEN = new RegExp(`(\\/\\/.*$)|("[^"\\n]*")|(${ID})(?=\\s*\\()|(${ID})|((?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|\\.\\d+))`, "gu");

  function highlightText(node) {
    const text = node.nodeValue;
    TOKEN.lastIndex = 0;
    let m, last = 0, frag = null;
    const span = (cls, s) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = s;
      return el;
    };
    while ((m = TOKEN.exec(text))) {
      let cls = null;
      if (m[1]) cls = "hl-c";
      else if (m[2]) cls = "hl-s";
      else if (m[3]) cls = KEYWORDS.has(m[3]) ? "hl-k" : "hl-f";
      else if (m[4]) cls = KEYWORDS.has(m[4]) ? "hl-k" : null;
      else if (m[5]) cls = "hl-n";
      if (!cls) continue;
      frag ??= document.createDocumentFragment();
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(span(cls, m[0]));
      last = m.index + m[0].length;
    }
    if (!frag) return;
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }

  function highlight(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest(".c, [class^='hl-'], .no-hl") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(highlightText);
  }

  const ready = () => {
    sweep();
    document.querySelectorAll(".formula, code").forEach(highlight);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
