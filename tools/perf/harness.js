// Injected into each day's page by run.sh: times frames while the day animates on the fixed step ("live") and once it is
// paused and its still has settled ("still"), then POSTs the numbers as one JSON line.
(async () => {
  const realNow = performance.now.bind(performance);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const day = location.pathname.split("/").at(-2);
  const tag = new URLSearchParams(location.search).get("tag") ?? "b";
  const log = (m) => fetch("/__log", { method: "POST", body: `${tag} ${day} ${m}` });
  addEventListener("error", (e) => log("ERR " + e.message));
  const until = async (f, ms) => {
    const t = realNow();
    while (realNow() - t < ms) {
      try {
        if (f()) return true;
      } catch {}
      await sleep(100);
    }
    return false;
  };
  const end = () => log("END");

  if (!(await until(() => window.app && window.__perf, 400000))) return log("FAIL no window.app"), end();
  const p = window.__perf;
  await until(() => !window.app.building, 240000);
  const startFrame = p.frame();
  await until(() => p.frame() > startFrame + 240, 240000);

  const gl = window.app.renderer?.getContext?.() ?? (window.app.canvas ?? document.querySelector("canvas")).getContext("webgl2");
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuName = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  // Per frame: CPU time of the frame callback, and GPU time from timer queries (or, without the extension, the time
  // until a 1 px readback returns, which serialises CPU and GPU). Queries can't nest, so the frame is a chain of
  // back-to-back segments, switched at the pipeline's pass boundaries by the wrappers below; they add up to the total.
  const T = ext?.TIME_ELAPSED_EXT;
  let segments = null, label = "other";
  const switchTo = (next) => {
    label = next;
    if (!segments) return;
    if (segments.length) gl.endQuery(T);
    const q = gl.createQuery();
    gl.beginQuery(T, q);
    segments.push({ label: next, q });
  };
  // Inside obj[name] the time goes to `as`; afterwards to `then`, or back to what ran before.
  const wrap = (obj, name, as, then) => {
    const orig = obj?.[name];
    if (!orig || orig.__perf) return;
    obj[name] = function (...args) {
      const prev = label;
      switchTo(as);
      try {
        return orig.apply(this, args);
      } finally {
        switchTo(then ?? prev);
      }
    };
    obj[name].__perf = true;
  };
  // A pass object's _pass(renderer, material, rt): each draw is timed as "<prefix>.<material key>" (gi.trace, ...).
  const wrapStages = (obj, prefix) => {
    const orig = obj?._pass;
    if (!orig || orig.__perf) return;
    obj._pass = function (renderer, material, rt) {
      const key = Object.keys(this).find((k) => k.endsWith("Material") && this[k] === material);
      const prev = label;
      switchTo(`${prefix}.${key ? key.slice(0, -8) : "other"}`);
      try {
        return orig.call(this, renderer, material, rt);
      } finally {
        switchTo(prev);
      }
    };
    obj._pass.__perf = true;
  };
  const instrument = () => {
    const pl = window.app.pipeline;
    if (!pl || !ext) return;
    // The prepass runs right after the shadow map; "post" is motion blur, composite, DoF gather, TAA and the final pass.
    wrap(pl.shadow, "render", "shadow", "prepass");
    wrap(pl.gi, "render", "gi", "other");
    wrap(pl.gi, "renderGeometry", "gi");
    wrap(pl.shadowMask, "render", "shadowMask", "other");
    wrap(pl, "_renderMain", "main", "post");
    wrap(pl, "_renderBloom", "bloom");
    wrap(pl, "_renderMotion", "motion");
    wrap(pl, "_renderMotionBlur", "motion");
    wrap(pl.dof, "gather", "dof");
    wrap(pl.dof, "accumulate", "dof");
    wrapStages(pl.gi, "gi");
    wrapStages(pl.shadowMask, "shadowMask");
  };
  const collect = (count) =>
    new Promise((resolve) => {
      const cpu = [], gpu = [], passes = {}, pending = [];
      let t0 = 0, done = false;
      const pixel = new Uint8Array(4);
      const poll = () => {
        while (pending.length && pending[0].every((g) => gl.getQueryParameter(g.q, gl.QUERY_RESULT_AVAILABLE))) {
          const frame = pending.shift();
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            const sums = {};
            for (const g of frame) sums[g.label] = (sums[g.label] ?? 0) + gl.getQueryParameter(g.q, gl.QUERY_RESULT) / 1e6;
            gpu.push(Object.values(sums).reduce((a, b) => a + b, 0));
            for (const k of new Set([...Object.keys(passes), ...Object.keys(sums)])) (passes[k] ??= new Array(gpu.length - 1).fill(0)).push(sums[k] ?? 0);
          }
          for (const g of frame) gl.deleteQuery(g.q);
        }
      };
      p.before = () => {
        if (ext) {
          instrument();
          segments = [];
          switchTo("other");
        }
        t0 = realNow();
      };
      p.after = () => {
        cpu.push(realNow() - t0);
        if (ext) {
          gl.endQuery(T);
          pending.push(segments);
          segments = null;
          label = "other";
          poll();
        } else {
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          gpu.push(realNow() - t0);
        }
        if (cpu.length >= count && !done) {
          done = true;
          p.before = p.after = null;
          const drain = () => (poll(), pending.length && ext ? setTimeout(drain, 16) : resolve({ cpu, gpu, passes }));
          drain();
        }
      };
    });
  const stats = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const q = (f) => +(s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? NaN).toFixed(3);
    return { med: q(0.5), p90: q(0.9), n: s.length };
  };
  const passMedians = (passes) => Object.fromEntries(Object.entries(passes).map(([k, v]) => [k, stats(v).med]));

  const live = await collect(300);
  p.setRunning(false);
  await sleep(5000);
  const still = await collect(120);
  const canvas = window.app.canvas ?? document.querySelector("canvas");
  const result = {
    gpu: stats(live.gpu), cpu: stats(live.cpu), stillGpu: stats(still.gpu), stillCpu: stats(still.cpu),
    passes: passMedians(live.passes), stillPasses: passMedians(still.passes),
    method: ext ? "timer-query" : "readback", gpuName, width: canvas.width, height: canvas.height,
    quality: window.app.pipeline?.quality ?? null,
  };
  await log("RESULT " + JSON.stringify(result));
  end();
})();
