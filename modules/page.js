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
.hero figure img, .zoomable { cursor: zoom-in; }
.lightbox { position: fixed; inset: 0; z-index: 1000; overflow: hidden; cursor: zoom-out; touch-action: none; overscroll-behavior: contain; }
.lightbox::before { content: ""; position: fixed; inset: 0; background: rgb(14 14 16 / 0.62); -webkit-backdrop-filter: blur(18px) saturate(1.2); backdrop-filter: blur(18px) saturate(1.2); opacity: 0; transition: opacity 0.35s ease; }
.lightbox.open::before { opacity: 1; }
.lightbox.zoomed { overflow: auto; touch-action: pan-x pan-y; cursor: grab; scrollbar-width: none; }
.lightbox::-webkit-scrollbar { display: none; }
.lightbox.dragging { cursor: grabbing; }
.lightbox .frame { position: relative; min-width: 100%; min-height: 100%; display: grid; place-items: center; }
.fade-images .lightbox img, .lightbox img { opacity: 1; display: block; max-width: none; border-radius: 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 0.18), 0 24px 70px rgb(0 0 0 / 0.42); cursor: zoom-in; user-select: none; -webkit-user-drag: none; transform-origin: 0 0; will-change: transform; }
.lightbox.zoomed img { cursor: inherit; }
.lightbox.moving img { transition: transform 0.42s cubic-bezier(0.2, 0.9, 0.25, 1), clip-path 0.42s cubic-bezier(0.2, 0.9, 0.25, 1); }
.lightbox button { position: fixed; top: 14px; right: 14px; width: 40px; height: 40px; border: 1px solid rgb(255 255 255 / 0.18); border-radius: 50%; background: rgb(30 30 34 / 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: #fff; font: 300 24px/1 sans-serif; cursor: pointer; opacity: 0; transition: opacity 0.3s ease, background 0.2s ease; }
.lightbox.open button { opacity: 1; }
.lightbox button:hover, .lightbox button:focus-visible { background: rgb(60 60 66 / 0.7); }
@media (prefers-reduced-motion: reduce) { .lightbox::before, .lightbox button, .lightbox.moving img { transition: none; } }`;
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

  // Click the hero image (or any image on an explainer) to see it floating as large as it fits; click again for a closer look, drag to pan.
  function lightbox(thumb) {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", thumb.alt);
    box.innerHTML = `<div class="frame"><img alt=""></div><button type="button" aria-label="Close">×</button>`;
    const img = box.querySelector("img"), close = box.querySelector("button");
    img.alt = thumb.alt;
    let zoomed = false, closing = false;
    const margin = () => (innerWidth < 600 ? 12 : 40);
    const layout = (cx, cy) => {
      const w = img.naturalWidth || thumb.naturalWidth || 1, h = img.naturalHeight || thumb.naturalHeight || 1, pad = margin();
      // Fit the window, but never past the image's own size until the visitor zooms in.
      const fit = Math.min(1, (innerWidth - pad * 2) / w, (innerHeight - pad * 2) / h);
      const scale = zoomed ? Math.max(1, fit * 2) : fit;
      const before = img.getBoundingClientRect();
      const fx = cx === undefined ? 0.5 : (cx - before.left) / before.width;
      const fy = cy === undefined ? 0.5 : (cy - before.top) / before.height;
      img.style.width = `${w * scale}px`;
      img.style.height = `${h * scale}px`;
      box.classList.toggle("zoomed", zoomed);
      if (zoomed) {
        const r = img.getBoundingClientRect();
        box.scrollLeft += r.left + fx * r.width - (cx ?? innerWidth / 2);
        box.scrollTop += r.top + fy * r.height - (cy ?? innerHeight / 2);
      }
    };
    // Transform and clip that put the floating image over the thumbnail, cropped the way the thumbnail is.
    const fromThumb = () => {
      const t = thumb.getBoundingClientRect(), f = img.getBoundingClientRect();
      const s = Math.max(t.width / f.width, t.height / f.height);
      const ix = (f.width - t.width / s) / 2, iy = (f.height - t.height / s) / 2;
      const radius = parseFloat(getComputedStyle(thumb).borderRadius) / s || 0;
      img.style.transform = `translate(${t.left - f.left - ix * s}px, ${t.top - f.top - iy * s}px) scale(${s})`;
      img.style.clipPath = `inset(${iy}px ${ix}px round ${radius}px)`;
    };
    const settle = () => {
      img.style.transform = "";
      img.style.clipPath = "inset(0 round 8px)";
    };
    const shut = () => {
      if (closing) return;
      closing = true;
      removeEventListener("keydown", key);
      removeEventListener("resize", onResize);
      removeEventListener("pointerup", up);
      box.classList.remove("open");
      if (zoomed) {
        zoomed = false;
        layout();
      }
      box.classList.add("moving");
      fromThumb();
      setTimeout(() => {
        thumb.style.visibility = "";
        box.remove();
      }, 420);
    };
    const key = (e) => {
      if (e.key === "Escape") shut();
      else if (!zoomed && [" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key) && !(e.key === " " && e.target === close)) e.preventDefault();
    };
    const onResize = () => layout();
    let drag = null;
    // The page keeps its scrollbar (hiding it shifts the layout), so the page under the lightbox mustn't scroll.
    box.addEventListener("wheel", (e) => !zoomed && e.preventDefault(), { passive: false });
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
      if (e.target === close || drag?.moved || closing) return;
      if (e.target !== img && !zoomed) return shut();
      box.classList.remove("moving");
      zoomed = !zoomed;
      layout(e.clientX, e.clientY);
    });
    close.addEventListener("click", shut);
    addEventListener("keydown", key);
    addEventListener("resize", onResize);
    img.addEventListener("load", () => !closing && layout(), { once: true });
    img.src = thumb.currentSrc || thumb.src;
    document.body.append(box);
    layout();
    fromThumb();
    thumb.style.visibility = "hidden";
    box.getBoundingClientRect();
    box.classList.add("open", "moving");
    settle();
    close.focus({ preventScroll: true });
  }

  const zoomable = () => {
    const explainer = /\/explainer(\.html)?$/.test(location.pathname);
    for (const img of document.querySelectorAll(explainer ? "img:not(a img)" : ".hero figure img")) {
      img.classList.add("zoomable");
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.title = "View full size";
      const open = () => lightbox(img);
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
