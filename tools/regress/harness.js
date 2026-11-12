// Injected into each day's page by run.sh: waits for the day to pause itself on frame 600 of the fixed time step, lets the AO/GI history and still accumulation settle, and POSTs the canvas for each view.
(async () => {
  // The page's performance.now() runs on the fixed step once it renders; waits here need real time.
  const realNow = performance.now.bind(performance);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const day = location.pathname.split("/").at(-2);
  const tag = new URLSearchParams(location.search).get("tag");
  const log = (m) => fetch("/__log", { method: "POST", body: `${tag} ${day} ${m}` });
  addEventListener("error", (e) => log("ERR " + e.message));
  const until = async (f, ms) => {
    const t = realNow();
    while (realNow() - t < ms) {
      try {
        if (f()) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  };
  const end = () => log("END");

  if (!(await until(() => window.app && window.__regress, 400000))) return log("FAIL no window.app"), end();
  const r = window.__regress;
  // Days that build asynchronously (workers) say so through app.building.
  await until(() => !window.app.building, 240000);
  // common.js pauses itself on frame 600.
  await until(() => r.frame() > 600 && !r.isRunning(), 240000);

  const app = window.app;
  const camera = app.camera ?? r.camera, controls = app.controls ?? r.controls;
  const canvas = app.canvas ?? document.querySelector("canvas");
  const target = controls.target.clone(), home = camera.position.clone();
  const capture = () => new Promise((res) => (window.__afterRender = () => ((window.__afterRender = null), res(canvas.toDataURL("image/png")))));
  for (const view of ["default", "close"]) {
    if (view === "close") {
      camera.position.copy(home).sub(target).multiplyScalar(0.5).add(target);
      controls.update?.();
    }
    app.pipeline?.gi?.resetHistory?.();
    app.pipeline?.restartAccumulation?.(false);
    await sleep(3500);
    await fetch(`/__save?name=${tag}-${day}-${view}`, { method: "POST", body: await capture() });
  }
  end();
})();
