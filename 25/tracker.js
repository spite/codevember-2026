// Webcam head tracking with MediaPipe's FaceLandmarker: the head's pose (metric, in centimetres, camera at the
// origin looking down -z) and its blendshapes. MediaPipe is imported at run time from its CDN.
import { Matrix4, Vector3, Quaternion } from "three";

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// One Euro filter (Casiez et al. 2012): little smoothing when fast, a lot when still.
function smoothingFactor(dt, cutoff) {
  return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
}

class OneEuro {
  constructor(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.values = null;
  }

  filter(values, dt) {
    if (!this.values || dt <= 0) {
      this.values ??= Float64Array.from(values);
      this.speeds ??= new Float64Array(values.length);
      return values.map((v, i) => this.values[i]);
    }
    const ad = smoothingFactor(dt, 1);
    return values.map((v, i) => {
      this.speeds[i] += ad * ((v - this.values[i]) / dt - this.speeds[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.speeds[i]);
      this.values[i] += smoothingFactor(dt, cutoff) * (v - this.values[i]);
      return this.values[i];
    });
  }

  reset() {
    this.values = null;
    this.speeds = null;
  }
}

const mirror = new Matrix4().makeScale(-1, 1, 1);
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();

function createTracker() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");

  const state = {
    status: "idle", // idle | asking | loading | running | denied | failed | off
    found: false,
    // What's shown: eased every frame toward the latest detection, which comes at the camera's rate.
    pose: new Matrix4(),
    blendshapes: {},
    mirrored: true,
    error: "",
  };
  let worker = null;
  let landmarker = null; // main-thread fallback
  let busy = false;
  let stream = null;
  let lastVideoTime = -1;
  let lastTime = 0;
  let snap = true;
  const position = new OneEuro(0.5, 0.5);
  let rotation = null;
  let rotationSpeed = 0;
  const target = new Matrix4();
  const targetPosition = new Vector3();
  const targetRotation = new Quaternion();
  const shownPosition = new Vector3();
  const shownRotation = new Quaternion();

  async function loadLandmarker() {
    const vision = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: true,
    });
    try {
      return await vision.FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch (e) {
      console.warn("FaceLandmarker: GPU delegate unavailable, using the CPU", e);
      return vision.FaceLandmarker.createFromOptions(fileset, options("CPU"));
    }
  }

  // The landmarker in its own worker; on the main thread if a worker can't run it.
  function loadWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./tracker-worker.js", import.meta.url));
      w.onmessage = ({ data }) => {
        if (data.type === "ready") resolve(w);
        else if (data.type === "error" && !worker) reject(new Error(data.message));
        else if (data.type === "result") {
          busy = false;
          handle(data.found, data.matrix, data.shapes);
        }
      };
      w.onerror = (e) => reject(new Error(e.message || "tracker worker failed"));
      w.postMessage({ type: "init", vision: VISION, model: MODEL });
    });
  }

  async function start() {
    if (stream || state.status === "asking" || state.status === "loading") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      state.status = "failed";
      state.error = "No camera access in this browser";
      return;
    }
    state.status = "asking";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (e) {
      state.status = "denied";
      state.error = e.message;
      return;
    }
    const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    state.mirrored = settings.facingMode !== "environment";
    video.srcObject = stream;
    await video.play().catch(() => {});
    state.status = "loading";
    try {
      if (!worker && !landmarker) {
        try {
          worker = await loadWorker();
        } catch (e) {
          console.warn("FaceLandmarker worker unavailable, detecting on the main thread", e);
          landmarker = await loadLandmarker();
        }
      }
      state.status = stream ? "running" : "off";
    } catch (e) {
      console.error(e);
      state.status = "failed";
      state.error = e.message;
    }
  }

  function stop() {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
    state.status = "off";
    state.found = false;
  }

  // A detection: filter the pose (One Euro on the position, a speed-dependent slerp on the rotation) into the target.
  function handle(found, matrix, shapes) {
    if (!found) {
      state.found = false;
      position.reset();
      rotation = null;
      snap = true;
      return;
    }
    const now = performance.now();
    const dt = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    target.fromArray(matrix);
    target.decompose(_p, _q, _s);
    _p.fromArray(position.filter(_p.toArray(), dt));
    if (!rotation || !state.found) {
      rotation = _q.clone();
      rotationSpeed = 0;
    } else if (dt > 0) {
      rotationSpeed += smoothingFactor(dt, 1) * (rotation.angleTo(_q) / dt - rotationSpeed);
      rotation.slerp(_q, smoothingFactor(dt, 0.5 + 5 * rotationSpeed));
    }
    target.compose(_p, rotation, _s.set(1, 1, 1));
    // Mirrored in the world and in the head's own space, so the pose stays a rotation (the skull is symmetric).
    if (state.mirrored) target.premultiply(mirror).multiply(mirror);
    target.decompose(targetPosition, targetRotation, _s);
    for (const name in state.blendshapes) delete state.blendshapes[name];
    for (const [name, score] of shapes) state.blendshapes[name] = score;
    state.found = true;
  }

  // Once a frame: hands a new video frame to the landmarker, and eases the shown pose toward the latest detection.
  function update(dt) {
    if (state.status === "running" && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      if (worker && !busy) {
        lastVideoTime = video.currentTime;
        busy = true;
        createImageBitmap(video).then(
          (bitmap) => worker.postMessage({ type: "frame", bitmap, time: performance.now() }, [bitmap]),
          () => (busy = false),
        );
      } else if (landmarker) {
        lastVideoTime = video.currentTime;
        const result = landmarker.detectForVideo(video, performance.now());
        const matrix = result.facialTransformationMatrixes?.[0];
        const found = !!(result.faceLandmarks?.[0] && matrix);
        handle(found, found ? matrix.data : null, found ? (result.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]) : []);
      }
    }
    if (state.found) {
      const k = snap ? 1 : 1 - Math.exp(-dt / 0.045);
      snap = false;
      shownPosition.lerp(targetPosition, k);
      shownRotation.slerp(targetRotation, k);
      state.pose.compose(shownPosition, shownRotation, _s.set(1, 1, 1));
    }
    return state.found;
  }

  return { state, video, start, stop, update };
}

export { createTracker };
