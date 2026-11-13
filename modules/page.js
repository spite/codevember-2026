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
.hero .live:focus-visible { outline: 2px solid var(--accent, var(--candy, currentColor)); outline-offset: 2px; }
.hero figure img { cursor: zoom-in; }
.lightbox { position: fixed; inset: 0; z-index: 1000; background: rgb(12 12 12 / 0.94); overflow: hidden; opacity: 0; transition: opacity 0.25s ease; cursor: zoom-in; touch-action: pan-x pan-y; overscroll-behavior: contain; }
.lightbox.open { opacity: 1; }
.lightbox.zoomed { overflow: auto; cursor: grab; scrollbar-width: none; }
.lightbox::-webkit-scrollbar { display: none; }
.lightbox.dragging { cursor: grabbing; }
.lightbox .frame { min-width: 100%; min-height: 100%; display: grid; place-items: center; }
.fade-images .lightbox img, .lightbox img { opacity: 1; display: block; max-width: none; border-radius: 0; user-select: none; -webkit-user-drag: none; }
.lightbox button { position: fixed; top: 14px; right: 14px; width: 40px; height: 40px; border: 0; border-radius: 50%; background: rgb(255 255 255 / 0.12); color: #fff; font: 400 24px/1 sans-serif; cursor: pointer; }
.lightbox button:hover, .lightbox button:focus-visible { background: rgb(255 255 255 / 0.25); }
@media (prefers-reduced-motion: reduce) { .lightbox { transition: none; } }`;
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

  // Click the hero image to see it full screen; click again for a closer look, drag to pan.
  function lightbox(src, alt) {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", alt);
    box.innerHTML = `<div class="frame"><img alt=""></div><button type="button" aria-label="Close">×</button>`;
    const img = box.querySelector("img"), frame = box.querySelector(".frame"), close = box.querySelector("button");
    img.alt = alt;
    let zoomed = false;
    const layout = (cx, cy) => {
      const w = img.naturalWidth || 1, h = img.naturalHeight || 1, pad = innerWidth < 600 ? 0 : 32;
      const fit = Math.min((innerWidth - pad * 2) / w, (innerHeight - pad * 2) / h);
      const scale = zoomed ? Math.max(1, fit * 2) : fit;
      const fx = cx === undefined ? 0.5 : (cx - img.getBoundingClientRect().left) / img.getBoundingClientRect().width;
      const fy = cy === undefined ? 0.5 : (cy - img.getBoundingClientRect().top) / img.getBoundingClientRect().height;
      img.style.width = `${w * scale}px`;
      img.style.height = `${h * scale}px`;
      box.classList.toggle("zoomed", zoomed);
      if (zoomed) {
        const r = img.getBoundingClientRect();
        box.scrollLeft += r.left + fx * r.width - (cx ?? innerWidth / 2);
        box.scrollTop += r.top + fy * r.height - (cy ?? innerHeight / 2);
      }
    };
    const shut = () => {
      box.classList.remove("open");
      removeEventListener("keydown", key);
      removeEventListener("resize", onResize);
      removeEventListener("pointerup", up);
      document.documentElement.style.overflow = "";
      setTimeout(() => box.remove(), 250);
    };
    const key = (e) => {
      if (e.key === "Escape") shut();
    };
    const onResize = () => layout();
    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      if (e.target === close || e.pointerType !== "mouse") return;
      drag = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, moved: false };
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      box.classList.add("dragging");
      box.scrollLeft = drag.sl - dx;
      box.scrollTop = drag.st - dy;
    });
    const up = () => setTimeout(() => ((drag = null), box.classList.remove("dragging")));
    addEventListener("pointerup", up);
    box.addEventListener("click", (e) => {
      if (e.target === close || drag?.moved) return;
      if (e.target !== img && !zoomed) return shut();
      zoomed = !zoomed;
      layout(e.clientX, e.clientY);
    });
    close.addEventListener("click", shut);
    addEventListener("keydown", key);
    addEventListener("resize", onResize);
    img.addEventListener("load", () => layout(), { once: true });
    img.src = src;
    if (img.complete) layout();
    document.documentElement.style.overflow = "hidden";
    document.body.append(box);
    requestAnimationFrame(() => box.classList.add("open"));
    close.focus({ preventScroll: true });
  }

  const zoomable = () => {
    for (const img of document.querySelectorAll(".hero figure img")) {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.title = "View full size";
      const open = () => lightbox(img.currentSrc || img.src, img.alt);
      img.addEventListener("click", open);
      img.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
    }
  };

  const ready = () => {
    sweep();
    zoomable();
    document.querySelectorAll(".formula, code").forEach(highlight);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
