// Motion recordings: the camera's pose every frame plus what happened (calls, footsteps, breaths), in scene
// time, so a take played back with a fixed time step (the video recorder) reproduces it exactly.
// Format: { version, seed, mode, params, duration, frames: [[t, x, y, z, qx, qy, qz, qw, moving]...],
//           events: [[t, "call", intensity] | [t, "step", x, y, z, strength] | [t, "breath"]...] }

import { Vector3, Quaternion } from "three";

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export function createMotionRecorder() {
  let take = null;
  let playing = null;

  function start(time, meta) {
    take = { version: 1, ...meta, start: time, frames: [], events: [] };
  }
  function stop() {
    if (!take) return null;
    const t = take;
    take = null;
    t.duration = t.frames.length ? t.frames[t.frames.length - 1][0] : 0;
    delete t.start;
    return t;
  }
  function frame(time, camera, moving) {
    if (!take) return;
    const p = camera.position, q = camera.quaternion;
    take.frames.push([round(time - take.start, 4), round(p.x), round(p.y), round(p.z), round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5), round(moving, 2)]);
  }
  function event(time, ...data) {
    if (take) take.events.push([round(time - take.start, 4), ...data.map((v) => (typeof v === "number" ? round(v) : v))]);
  }

  // Playback: pose(time) sets the camera and returns the events since the last call, and whether it ended.
  const qa = new Quaternion(), qb = new Quaternion();
  function play(data, time) {
    playing = { data, start: time, frame: 0, event: 0 };
  }
  function pose(time, camera) {
    const p = playing;
    if (!p) return null;
    const t = time - p.start;
    const f = p.data.frames;
    while (p.frame < f.length - 2 && f[p.frame + 1][0] <= t) p.frame++;
    const a = f[p.frame], b = f[Math.min(p.frame + 1, f.length - 1)];
    const k = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
    camera.position.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    camera.quaternion.slerpQuaternions(qa.set(a[4], a[5], a[6], a[7]), qb.set(b[4], b[5], b[6], b[7]), k);
    camera.updateMatrixWorld();
    const events = [];
    const e = p.data.events;
    while (p.event < e.length && e[p.event][0] <= t) events.push(e[p.event++]);
    const ended = t >= p.data.duration;
    if (ended) playing = null;
    return { events, moving: a[8] + (b[8] - a[8]) * k, ended, time: t };
  }

  return {
    start,
    stop,
    frame,
    event,
    play,
    pose,
    stopPlaying: () => (playing = null),
    get recording() {
      return !!take;
    },
    get playing() {
      return !!playing;
    },
    get elapsed() {
      return take && take.frames.length ? take.frames[take.frames.length - 1][0] : 0;
    },
    get calls() {
      return take ? take.events.filter((e) => e[1] === "call").length : 0;
    },
  };
}

// The walker's end of a take, for handing control back: where it stands and which way it faces.
export function lastPose(data) {
  const f = data.frames[data.frames.length - 1];
  const q = new Quaternion(f[4], f[5], f[6], f[7]);
  const ahead = new Vector3(0, 0, -1).applyQuaternion(q);
  return { x: f[1], z: f[3], yaw: Math.atan2(-ahead.x, -ahead.z) };
}
