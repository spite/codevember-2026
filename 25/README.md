# 25 · Veil

A skull under a veil of thin cloth, simulated on it, that moves as you do. With the camera, MediaPipe's FaceLandmarker
gives your head's pose and blendshapes: the skull turns and moves with you, comes closer as you lean in, its jaw opens
and slides with yours, and when you frown its empty sockets fill with a glow that shows through the cloth. Without it,
the skull turns to follow the mouse or your finger. Every few seconds a ghostly gust moves the veil; R blows it away and
drops a new one.

Ported from the skull example of FaceMeshFaceGeometry to the shared Pipeline.

## Controls

- A start screen asks how to play: the camera (the skull follows your face) or the mouse / touch (it turns toward the
  pointer; hold to open the jaw, hold on and the eyes light up). C or the camera button brings it back.
- With the camera: turn and tilt your head, lean in and back, open your jaw and push it sideways, frown. If your face
  is lost the skull drifts off into the dark and comes back by itself until it finds you again.
- With the mouse or touch, left alone for 8 s, the skull looks about, mutters and scowls by itself until the pointer
  moves again. Scroll to zoom; with the camera, drag to orbit.
- R (or the dice) for a new veil: a muted colour (red, oxblood, crimson, black, charcoal, bone white, ash, purple,
  plum), an opacity and diffusion that read as cloth, whole or tattered, a draft, and the eyes' light. The old veil lets
  go and a gust blows it away; the new one drops from above and drapes over the head. D drops it again.
- The panel also picks the skull (evil, realistic, Suzanne) and the eyes' light (Hellfire red, Pale white, Sick
  green), and sets the frown threshold and the glow. M turns the sound on and off.
- Shift+T records a take of your face, with the veil changes and gusts, for a video; Shift+T again downloads it.
  `?replay=take.json&replayStart=s` plays one back.

## How it works

- `tracker.js`, `tracker-worker.js`: the webcam and MediaPipe (loaded from its CDN), detecting in its own worker on the
  CPU so it never holds up a frame (the main thread is the fallback). The pose is smoothed with a One Euro filter on
  its position and a speed-dependent slerp on its rotation, mirrored in the world and in the head's own space so it
  stays a rotation, and played back along a Catmull-Rom curve through the latest detections, by when each frame was
  captured, about a frame behind: the skull moves smoothly at the camera's 20–30 fps, and misses under a third of a
  second (fast moves blur frames) play on. The face's position maps onto the view as the webcam sees it.
- `skull.js`: the glTF heads have a two-bone skin; the jaw's weight goes to a vertex attribute and `displace()` swings
  it, so the jaw reaches shadows, AO and velocity. Bone colour and normal maps are read in `surface()` (derivative
  tangent frame). The eyes' light sits deep in each socket and in the nose, with no visible source: it lights the
  walls, leaves through the openings, and glows through thin bone; Suzanne's eyes glow themselves.
- `veil-sim.js` (run in `veil-worker.js`): position-based cloth, 64×64 particles, colliding with distance fields baked
  from the cranium and the jaw, and with itself. It's pinned at the crown and leashed loosely to its drape, which it
  drifts back to after a gust or a turn. A dropped veil falls live, along the skull's own down until its crown lands,
  then eases into a drape worked out in still air. Gusts blow in the room, patchy over the cloth and mostly on the part
  that hangs.
- `veil.js`: the cloth seen from either side is drawn in the Pipeline's composite hook, over a blurred copy of the lit
  scene with its depth, so what's behind it shows through diffused; the far side is also drawn in the main pass, where
  it casts the veil's shadow. Each point of the shadow blocks the key with a chance equal to the share of light the
  cloth stops there (never none while there's cloth, more as it diffuses, more with its opacity, dirt and wear), redrawn
  every frame and averaged by the shadow filter and denoiser. The key is about 7° across, so the shadow of cloth a few
  centimetres off the bone survives on surfaces tilted toward the light. The veil also cuts the soft studio light on the
  bone, and tints the light that reaches it with its colour.
- `tatter.js`, `tatter-worker.js`: a tattered veil's maps, made in their own worker: an edge-distance field (ragged
  holes and rips running down, loose threads hanging from edges that face down) that the shader cuts antialiased at any
  zoom, sheer wear round the holes, and dirt (grime toward the hem, water stains with darker tide lines, mildew).
- `sound.js`: a dungeon. A wind bed under everything rises with each gust, water drips at random somewhere in the dark,
  and now and then a chain moves in another room; all of it muffled. CC0 samples, levelled per kind.
- `chooser.js`: the start screen.

## Performance

- Frames go out on every Nth display refresh, at most about 120 fps, stepping down to the next even rate when frames
  keep missing their refresh. `?fps=` sets the most, `?fps=0` draws every refresh.
- The page renders at most at 1.5x pixel ratio (`?dpr=2` for full Retina).
- The cloth's worker surfaces are drawn between the last two, so the veil moves every frame; the composite fills only
  depth into its multisampled layer; the jaw's field is sampled once per surface.
- Under `?capture` the cloth is simulated on the page, a step per frame, for recordings.

## Credits

- Skull: based on ["Skull downloadable"](https://sketchfab.com/models/1a9db900738d44298b0bc59f68123393) by
  [martinjario](https://sketchfab.com/martinjario), CC-BY 4.0 (see `assets/README.md`).
- Suzanne: the Blender Foundation's monkey, from the Khronos glTF sample models, donated by Norbert Nopper.
- Face tracking: [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
- Sound, CC0 from freesound.org: wind from "spooky ghost wind 01" by TitanKaempfer (582300), "Muffled Eerie Wind" by
  IanStarGem (269591) and "Soft Wind" by florianreichelt (459977); drips from "Water Drop Dark" by Ev-Dawg (337525),
  "Water Dripping in Cave" by Sclolex (177958) and "Water drops with reverb" by Patrick_Corra (696438); chains from
  "Steel Chain Dragged, Hard Reverb" and "Steel chain dragged, shower reverb" by ani_music (167912, 167914).
