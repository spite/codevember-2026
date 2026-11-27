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
// ?pose=jump shows each detection as it comes, like the original demo, instead of playing them back smoothly.
const jump = new URLSearchParams(location.search).get("pose") === "jump";
const DROPOUT = 350;
// The blendshapes a take keeps (the ones the skull uses).
const KEPT_SHAPES = new Set(["jawOpen", "jawLeft", "jawRight", "jawForward", "browDownLeft", "browDownRight", "mouthFrownLeft", "mouthFrownRight"]);
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
    // What's shown: played back smoothly through the latest detections, which come at the camera's rate.
    pose: new Matrix4(),
    blendshapes: {},
    mirrored: true,
    error: "",
  };
  let worker = null;
  let landmarker = null; // main-thread fallback
  let busy = false;
  let stream = null;
  // Whether the camera is wanted now; stop() bumps gen, so a start still waiting on the prompt knows it was cancelled.
  let wanted = false;
  let gen = 0;
  let lastVideoTime = -1;
  let lastTime = 0;
  // The newest camera frame not yet handed to the landmarker, by its capture time (ms).
  let frameTime = 0;
  let sentFrame = 0;
  // Counts for the panel's readout, over the last second.
  const counts = { frames: 0, results: 0, detect: 0, renders: 0, since: performance.now() };
  // The tracker's clock: the page's, or a replayed take's (advanced by the page's dt, so a capture reproduces it).
  let replay = null;
  const clock = () => (replay ? replay.time : performance.now());
  // A take being recorded: every detection, with the time its frame was captured.
  let recording = null;
  state.stats = "";
  const position = new OneEuro(0.5, 0.5);
  let rotation = null;
  let rotationSpeed = 0;
  const target = new Matrix4();
  const targetPosition = new Vector3();
  const targetRotation = new Quaternion();
  // The latest detections, by when their frames were captured. The skull is played back along a smooth curve through
  // them a little behind real time, so when a detection comes back doesn't matter, only when its frame was taken.
  const samples = [];
  let interval = 40; // between captured frames, ms
  let latency = 30; // from capture to detection, ms
  let delay = 80; // how far behind the pose is played back, ms

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
      const w = new Worker(new URL(`./tracker-worker.js?v=${Date.now().toString(36)}`, import.meta.url));
      w.onmessage = ({ data }) => {
        if (data.type === "ready") resolve(w);
        else if (data.type === "error" && !worker) reject(new Error(data.message));
        else if (data.type === "result") {
          busy = false;
          counts.results++;
          counts.detect += data.ms;
          handle(data.found, data.matrix, data.shapes, data.time);
        }
      };
      w.onerror = (e) => reject(new Error(e.message || "tracker worker failed"));
      w.postMessage({ type: "init", vision: VISION, model: MODEL });
    });
  }

  // A start while one is under way waits for that one.
  let starting = null;
  function start() {
    wanted = true;
    if (!starting) {
      const g = gen;
      // Stopped and started again while it was under way: that run gave up, so start over.
      starting = begin().finally(() => {
        starting = null;
        if (wanted && !stream && gen !== g) start();
      });
    }
    return starting;
  }

  async function begin() {
    if (stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      state.status = "failed";
      state.error = "No camera access in this browser";
      return;
    }
    state.status = "asking";
    const g = gen;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (g !== gen) {
        for (const track of s.getTracks()) track.stop();
        return;
      }
      stream = s;
      // Then the fastest frame rate the camera says it has, if that's more than it chose.
      const track = stream.getVideoTracks()[0];
      const max = track?.getCapabilities?.().frameRate?.max;
      if (max && max > (track.getSettings().frameRate ?? 0)) await track.applyConstraints({ frameRate: { ideal: max } }).catch(() => {});
    } catch (e) {
      if (g !== gen) return;
      state.status = e.name === "NotAllowedError" || e.name === "SecurityError" ? "denied" : "failed";
      state.error = e.message;
      return;
    }
    if (!stream) return;
    const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    state.mirrored = settings.facingMode !== "environment";
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!stream) return;
    if (video.requestVideoFrameCallback) {
      const onFrame = (now, meta) => {
        counts.frames++;
        frameTime = meta.captureTime || meta.expectedDisplayTime || now;
        if (stream) video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    state.status = "loading";
    try {
      if (!worker && !landmarker) {
        try {
          // ?tracker=main detects on the main thread, on the GPU, as the original did.
          if (new URLSearchParams(location.search).get("tracker") === "main") throw new Error("main thread asked for");
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
    wanted = false;
    gen++;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
    state.status = "off";
    state.found = false;
  }

  // A detection: filter the pose (One Euro on the position, a speed-dependent slerp on the rotation) into the target.
  function handle(found, matrix, shapes, time) {
    if (recording) {
      const r = (v) => Math.round(v * 1e4) / 1e4;
      recording.events.push({
        t: Math.max(0, Math.round(time - recording.t0)),
        f: found ? 1 : 0,
        ...(found && { m: Array.from(matrix, r), s: Object.fromEntries(shapes.filter(([name]) => KEPT_SHAPES.has(name)).map(([name, v]) => [name, r(v)])) }),
      });
    }
    if (!found) {
      // Fast moves blur a frame or two and the face is missed; under a third of a second, play on as if it were there.
      if (state.found && time - lastTime < DROPOUT) return;
      state.found = false;
      position.reset();
      rotation = null;
      return;
    }
    // Timed by when the frame was captured, not when its detection came back, which varies.
    const dt = lastTime && time > lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;
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
    if (!state.found) samples.length = 0;
    const last = samples.at(-1);
    // Same hemisphere as the last sample, so the curve between them takes the short way round.
    if (last && last.q.dot(targetRotation) < 0) targetRotation.set(-targetRotation.x, -targetRotation.y, -targetRotation.z, -targetRotation.w);
    samples.push({ t: time, p: targetPosition.clone(), q: targetRotation.clone() });
    if (samples.length > 8) samples.shift();
    if (state.found && dt > 0) interval += (Math.min(150, dt * 1000) - interval) * 0.2;
    latency += (Math.min(200, Math.max(0, clock() - time)) - latency) * 0.2;
    for (const name in state.blendshapes) delete state.blendshapes[name];
    for (const [name, score] of shapes) state.blendshapes[name] = score;
    state.found = true;
  }

  // The pose at time t (ms) into _p and _q: Catmull-Rom through the samples, held at either end.
  function sample(t) {
    const n = samples.length;
    if (t <= samples[0].t || n === 1) return void (_p.copy(samples[0].p), _q.copy(samples[0].q));
    if (t >= samples[n - 1].t) {
      // Past the newest: carry on at the speed it had, for up to a frame and a half, rather than stop and jump.
      const b = samples[n - 2];
      const c = samples[n - 1];
      const span = c.t - b.t;
      const k = 1 + Math.min(t - c.t, 1.5 * interval) / Math.max(span, 1);
      _p.lerpVectors(b.p, c.p, k);
      _q.slerpQuaternions(b.q, c.q, k);
      return;
    }
    let i = 0;
    while (samples[i + 1].t <= t) i++;
    const a = samples[Math.max(0, i - 1)];
    const b = samples[i];
    const c = samples[i + 1];
    const d = samples[Math.min(n - 1, i + 2)];
    const u = (t - b.t) / (c.t - b.t);
    const u2 = u * u;
    const u3 = u2 * u;
    const w0 = -0.5 * u3 + u2 - 0.5 * u;
    const w1 = 1.5 * u3 - 2.5 * u2 + 1;
    const w2 = -1.5 * u3 + 2 * u2 + 0.5 * u;
    const w3 = 0.5 * u3 - 0.5 * u2;
    _p.set(0, 0, 0).addScaledVector(a.p, w0).addScaledVector(b.p, w1).addScaledVector(c.p, w2).addScaledVector(d.p, w3);
    _q.set(
      a.q.x * w0 + b.q.x * w1 + c.q.x * w2 + d.q.x * w3,
      a.q.y * w0 + b.q.y * w1 + c.q.y * w2 + d.q.y * w3,
      a.q.z * w0 + b.q.z * w1 + c.q.z * w2 + d.q.z * w3,
      a.q.w * w0 + b.q.w * w1 + c.q.w * w2 + d.q.w * w3,
    ).normalize();
  }

  // Once a frame: hands a new video frame to the landmarker (or the take's next detections to the tracker), and plays the
  // pose back.
  function update(dt) {
    counts.renders++;
    if (replay) {
      if (!replay.paused) replay.time += dt * 1000;
      const events = replay.take.events;
      while (replay.next < events.length && events[replay.next].t <= replay.time) {
        const e = events[replay.next++];
        handle(!!e.f, e.m ?? null, Object.entries(e.s ?? {}), e.t);
      }
      const cues = replay.take.cues ?? [];
      while (replay.nextCue < cues.length && cues[replay.nextCue].t <= replay.time) replay.onCue?.(cues[replay.nextCue++]);
      // A take plays round again from the start.
      if (replay.next >= events.length && replay.loop && replay.time > events.at(-1).t + 100) {
        replay.next = 0;
        replay.nextCue = 0;
        replay.time = 0;
        lastTime = 0;
        samples.length = 0;
        state.found = false;
      }
    }
    if (!video.requestVideoFrameCallback && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      counts.frames++;
      frameTime = performance.now();
    }
    if (state.status === "running" && video.readyState >= 2 && frameTime !== sentFrame) {
      const time = frameTime;
      if (worker && !busy) {
        sentFrame = time;
        busy = true;
        createImageBitmap(video).then(
          (bitmap) => worker.postMessage({ type: "frame", bitmap, time }, [bitmap]),
          () => (busy = false),
        );
      } else if (landmarker) {
        sentFrame = time;
        const t0 = performance.now();
        const result = landmarker.detectForVideo(video, time);
        counts.results++;
        counts.detect += performance.now() - t0;
        const matrix = result.facialTransformationMatrixes?.[0];
        const found = !!(result.faceLandmarks?.[0] && matrix);
        handle(found, found ? matrix.data : null, found ? (result.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]) : [], time);
      }
    }
    const elapsed = performance.now() - counts.since;
    if (elapsed > 1000) {
      const rate = (n) => Math.round((n * 1000) / elapsed);
      const where = worker ? "worker" : landmarker ? "main" : "-";
      const max = stream?.getVideoTracks()[0]?.getCapabilities?.().frameRate?.max;
      const detect = counts.results ? (counts.detect / counts.results).toFixed(0) : "-";
      state.stats = `cam ${rate(counts.frames)}${max ? `/${Math.round(max)}` : ""} · ${detect} ms ${where} · ${rate(counts.renders)} fps`;
      Object.assign(counts, { frames: 0, results: 0, detect: 0, renders: 0, since: performance.now() });
    }
    if (state.found && samples.length) {
      // Behind by the detection's latency and a bit over a frame, so there's nearly always a sample on either side.
      delay += (latency + 1.3 * interval - delay) * Math.min(1, dt * 2);
      sample(jump ? Infinity : clock() - delay);
      state.pose.compose(_p, _q, _s.set(1, 1, 1));
    }
    return state.found;
  }

  // Records the detections until stopTake(), which returns the take (JSON-able).
  function startTake() {
    recording = { mirrored: state.mirrored, events: [], cues: [], t0: performance.now() };
  }
  // Something else that happened during the take (a veil change, a gust), played back at the same moment.
  function addCue(kind, data) {
    if (recording) recording.cues.push({ t: Math.round(performance.now() - recording.t0), kind, ...data });
  }
  function stopTake() {
    const take = recording && { version: 1, mirrored: recording.mirrored, events: recording.events, cues: recording.cues };
    recording = null;
    return take;
  }
  // Plays a recorded take instead of the camera (looping).
  // `start` (seconds) begins partway in, on the look the take had then.
  // `paused` holds it at `start` (on its pose there) until resumeTake().
  function playTake(take, { loop = true, onCue, start = 0, paused = false } = {}) {
    stop();
    state.mirrored = !!take.mirrored;
    const time = start * 1000;
    const cues = take.cues ?? [];
    const look = takeLookAt(take, start);
    if (look) onCue?.({ kind: "look", look });
    replay = {
      take,
      time,
      next: take.events.findIndex((e) => e.t > time - 200),
      nextCue: Math.max(0, cues.findIndex((c) => c.t > time)),
      loop,
      onCue,
      paused,
    };
    if (replay.next < 0) replay.next = take.events.length;
    if (cues.every((c) => c.t <= time)) replay.nextCue = cues.length;
    lastTime = 0;
    samples.length = 0;
    state.found = false;
    state.status = "replay";
  }

  return {
    state,
    video,
    start,
    stop,
    update,
    startTake,
    stopTake,
    addCue,
    playTake,
    resumeTake: () => replay && (replay.paused = false),
    get replaying() {
      return !!replay;
    },
    get recording() {
      return !!recording;
    },
  };
}

// A take's look at `start` seconds: the last one set by then (its first look, changes, skull changes), or null.
function takeLookAt(take, start) {
  const before = (take.cues ?? []).filter((c) => c.t <= start * 1000 && c.kind !== "gust");
  return before.length ? Object.assign({}, ...before.map((c) => c.look)) : null;
}

export { createTracker, takeLookAt };
