// MediaPipe's FaceLandmarker off the main thread, on the CPU, so detection never holds up a frame or waits on the GPU.
// A classic worker: MediaPipe loads its wasm with importScripts.
let landmarker = null;

onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      const vision = await import(`${data.vision}/vision_bundle.mjs`);
      const res = await fetch(data.model);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) postMessage({ type: "progress", value: loaded / total });
      }
      const model = new Uint8Array(await new Blob(chunks).arrayBuffer());
      const fileset = await vision.FilesetResolver.forVisionTasks(`${data.vision}/wasm`);
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: true,
      });
      postMessage({ type: "ready" });
    } catch (e) {
      postMessage({ type: "error", message: e.message || String(e) });
    }
  } else if (data.type === "frame") {
    let result = null;
    const t0 = performance.now();
    try {
      result = landmarker.detectForVideo(data.bitmap, data.time);
    } catch (e) {
      postMessage({ type: "error", message: e.message || String(e) });
    }
    data.bitmap.close();
    const matrix = result?.facialTransformationMatrixes?.[0];
    const found = !!(result?.faceLandmarks?.[0] && matrix);
    postMessage({
      type: "result",
      time: data.time,
      ms: performance.now() - t0,
      found,
      matrix: found ? Array.from(matrix.data) : null,
      shapes: found ? (result.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]) : [],
    });
  }
};
