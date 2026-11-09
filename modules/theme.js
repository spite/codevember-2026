// Light / dark / system theme for the landing page, explainers and galleries. Load as a classic
// script in <head> so the saved choice applies before the first paint.
(() => {
  const KEY = "codevember-theme";
  const root = document.documentElement;
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  };
  const apply = (mode) => {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    for (const b of document.querySelectorAll(".theme-switch button")) b.setAttribute("aria-pressed", String(b.value === mode));
  };
  apply(read());

  const ICONS = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  };
  const CSS = `
.theme-switch { position: absolute; top: 10px; right: max(10px, env(safe-area-inset-right, 0px)); z-index: 50; display: flex; gap: 2px; padding: 2px;
  border-radius: 999px; background: color-mix(in srgb, Canvas 82%, transparent); color: CanvasText;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, CanvasText 16%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.theme-switch button { all: unset; box-sizing: border-box; width: 26px; height: 24px; display: grid; place-items: center; border-radius: 999px; cursor: pointer; opacity: 0.55; }
.theme-switch button:hover { opacity: 0.9; }
.theme-switch button[aria-pressed="true"] { opacity: 1; background: color-mix(in srgb, CanvasText 12%, transparent); }
.theme-switch button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.theme-switch svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
@media print { .theme-switch { display: none; } }`;

  const mount = () => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const bar = document.createElement("div");
    bar.className = "theme-switch";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Colour theme");
    for (const [mode, label] of [["light", "Light"], ["dark", "Dark"], ["system", "System"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.value = mode;
      b.title = `${label} theme`;
      b.setAttribute("aria-label", `${label} theme`);
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[mode]}</svg>`;
      b.addEventListener("click", () => {
        try {
          if (mode === "system") localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, mode);
        } catch {}
        apply(mode);
      });
      bar.append(b);
    }
    document.body.prepend(bar);
    apply(read());
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
  // Another tab changed it.
  addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) apply(read());
  });
})();
