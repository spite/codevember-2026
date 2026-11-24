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

function createTracker({ onModelProgress } = {}) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");

  const state = {
    status: "idle", // idle | asking | loading | running | denied | failed | off
    found: false,
    pose: new Matrix4(),
    blendshapes: {},
    mirrored: true,
    error: "",
  };
  let landmarker = null;
  let stream = null;
  let lastVideoTime = -1;
  let lastTime = 0;
  const position = new OneEuro(0.5, 0.5);
  let rotation = null;
  let rotationSpeed = 0;

  async function loadLandmarker() {
    const vision = await import(`${VISION}/vision_bundle.mjs`);
    const res = await fetch(MODEL);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) onModelProgress?.(loaded / total);
    }
    const model = new Uint8Array(await new Blob(chunks).arrayBuffer());
    const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetBuffer: model, delegate },
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
      landmarker ??= await loadLandmarker();
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

  // Runs the landmarker once per new video frame; returns whether a face is in view.
  function update() {
    if (state.status !== "running" || video.readyState < 2) return state.found;
    if (video.currentTime === lastVideoTime) return state.found;
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const matrix = result.facialTransformationMatrixes?.[0];
    if (!result.faceLandmarks?.[0] || !matrix) {
      state.found = false;
      position.reset();
      rotation = null;
      return false;
    }
    const dt = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    state.pose.fromArray(matrix.data);
    state.pose.decompose(_p, _q, _s);
    _p.fromArray(position.filter(_p.toArray(), dt));
    if (!rotation || !state.found) {
      rotation = _q.clone();
      rotationSpeed = 0;
    } else if (dt > 0) {
      rotationSpeed += smoothingFactor(dt, 1) * (rotation.angleTo(_q) / dt - rotationSpeed);
      rotation.slerp(_q, smoothingFactor(dt, 0.5 + 5 * rotationSpeed));
    }
    state.pose.compose(_p, rotation, _s.set(1, 1, 1));
    // Mirrored in the world and in the head's own space, so the pose stays a rotation (the skull is symmetric).
    if (state.mirrored) state.pose.premultiply(mirror).multiply(mirror);
    for (const name in state.blendshapes) delete state.blendshapes[name];
    for (const c of result.faceBlendshapes?.[0]?.categories ?? []) state.blendshapes[c.categoryName] = c.score;
    state.found = true;
    return true;
  }

  return { state, video, start, stop, update };
}

export { createTracker };
