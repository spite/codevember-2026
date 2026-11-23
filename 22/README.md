# 22 · Echo

*November 22, 2026* · Prompt: **Echo**

An endless, yellowing back-rooms labyrinth you can only see by calling out. Every call sends thousands of rays out at
the speed of sound; where they land they leave dots on the walls, floor and ceiling, which fade after a few seconds, so
the maze is only ever what your last echoes reached. The deeper you go the stranger it gets: rooms with no ceiling,
raised floors, shapes sunk half into the walls, sculptures on plinths, presences that step closer when you call, and
watchers standing in the distance, seen only as the holes they leave in the echoes. It is all filmed on a worn
camcorder and played back on a CRT.

## How to play

A start screen offers three ways in, over the camcorder's blue standby screen:

- **With my voice**: the microphone, and only your voice, sends echoes. Say hello, shout or clap; louder carries
  further. Your own voice comes back as the echoes, from the directions they bounced off.
- **Click to shout** (tap on phones): a recorded hello calls out. The voice tires: each call spends some of the VOICE
  meter, it needs half a second between calls, and once spent it is gone for five seconds.
- **Just watch**: it walks by itself: picks a destination at the edge of what it has heard, keeps to the walls, takes
  corners wide, stops at forks and rooms to look down each way and call, and glances back now and then.

Choosing goes fullscreen with the UI hidden (it comes back when leaving fullscreen). WASD or the arrows walk; the first
click grabs the mouse to look around, Esc lets go. On phones: drag to look, hold to walk. V changes the mode, R gives a
new maze, K records your motion for a video. When the tape (10 minutes by default) runs out, it stops, rewinds, and
starts again on a fresh one.

## Notable

- **World** (`world.js`): an endless maze in 8×8-cell chunks, deterministic per seed, with thick walls and posts, rooms
  knocked through, and openings shared across chunk edges. Rays are traced on the CPU through the cell grid (slab tests
  against walls, posts, floors and ceilings, then mesh hits for the objects and capsules for the bodies).
- **Echoes** (`scan.js`): each call traces its first 200 rays at once (their hits set the sound's echoes) and the rest
  over the next frames; rays travel unseen at the speed of sound, bounce twice, and leave instanced discs lying on the
  surface they hit. Your own body, behind the camera, casts a sound shadow.
- **Walker** (`walk.js`): critically damped body and head turns (always the short way round), gait with bob, sway and
  footsteps, breathing, and a planner that only routes through heard cells, so it never walks into a dead end it has
  already heard. The eyes rest on the most open direction near the route, never a wall.
- **Sound** (`audio.js`): each echo is the call itself, delayed by its distance, darker and quieter, HRTF-panned from
  its direction around the head; tight spaces add a flutter, and deeper in the echoes drift lower, warble, sometimes
  come back reversed, or are answered by a different take. Every take is trimmed so its vowel lands 60 ms in, in step
  with its rays.
- **Tape** (`vhs.js`): a camcorder recording to VHS, modelled as a signal after ntsc-rs, on the GPU at 360 lines:
  camera (with low-light grain and the display burned in), composite encoding with noise, snow, head-switching and
  tracking trouble, notch and demodulation, the VHS record/playback filters as causal FIR versions of ntsc-rs's IIR
  filters, an edge wave and the chroma comb. The display is a 5×7 bitmap character generator (`osdfont.js`).
- **Screen** (`crt.js`): after crt-guest-advanced: beams whose width follows brightness, an aperture-grille mask, glow
  and halation, deconvergence and a slight curve.
- **Recordings** (`record.js`): K records the camera's pose and the calls, steps and breaths in scene time; a take plays
  back exactly (`?replay=<file>` or `window.app.playRecording`) for the video recorder, with its sound rendered offline.

## Sounds

- The call: `hello-hello-hello-hello-hello.wav`, supplied by the author, cut into 8 shouted and 9 plain takes in `voice/`.
- Breathing: the second half of the same file, cut into light and deep breaths and a gasp in `breath/`, keeping their relative levels.
