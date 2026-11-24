# 25 · Veil

A skull that follows your head through the webcam, under a veil of thin cloth simulated on it. MediaPipe's
FaceLandmarker gives the head's pose and blendshapes: the skull turns and moves with you, its jaw opens and slides with
yours, and when you frown its eyes light up as embers that glow through the cloth. Lose the camera's sight of you and it
drifts off into the dark, then comes back by itself, looking about, chattering and scowling, until it finds a face again.

Ported from the skull example of FaceMeshFaceGeometry to the shared Pipeline.

## Controls

- Look at the camera, open your mouth, move your jaw sideways, frown.
- Drag to orbit, scroll to zoom.
- R (or the button) for a new veil: colour, opacity, diffusion, tattered or whole, and the draft. The old veil dissolves,
  the new one is dropped and fades in.
- D drops the veil again, C turns the camera on and off, M the sound.
- The panel picks the skull (evil, realistic, Suzanne), the frown threshold and the glow.

## How it works

- `tracker.js`: the webcam and MediaPipe (loaded from its CDN at run time), detecting in its own worker
  (`tracker-worker.js`, on the CPU) so it never holds up a frame; the main thread is the fallback. The pose is smoothed with a One Euro filter on
  its position and a speed-dependent slerp on its rotation, then mirrored in the world and in the head's own space, so it
  stays a rotation.
- `skull.js`: the glTF heads have a two-bone skin; the jaw's weight goes to a vertex attribute and `displace()` swings it,
  so the jaw reaches shadows, AO and velocity. Bone colour and normal maps are read in `surface()` (derivative tangent
  frame). The embers light the socket walls from inside, and the outside through each socket's mouth.
- `veil-sim.js` (in `veil-worker.js`): position-based cloth, 64×64 particles, colliding with distance fields baked from the
  cranium and the jaw, and with itself.
- `veil.js`: the far side of the cloth is drawn in the main pass and casts the veil's shadow (a checkerboard, half the
  light through). The near side is drawn in the Pipeline's composite hook, over a blurred copy of the lit scene with its
  depth, so what's behind the cloth shows through diffused. Surfaces come back from the worker a few frames apart, so the
  cloth is drawn between the last two, one behind, and moves every frame. Tattered veils (`tatter.js`, made in the worker) have ragged holes and rips running down the cloth, loose threads
  hanging off edges that face down, sheer wear round the holes and toward the hem, and dirt: grime toward the hem and
  round the holes, water stains with darker tide lines, and mildew specks.

## Performance

- Frames go out on every Nth display refresh, at most ~120 fps, stepping down to the next even rate when frames keep
  missing their refresh: uneven frame pacing shows as judder, and the cloth amplifies it. `?fps=` sets the most, `?fps=0`
  draws every refresh.
- The page renders at most at 1.5x pixel ratio (`?dpr=2` for full Retina); the 2x screenshot keeps its size.
- The veil's composite fills only depth into its multisampled layer and lays the cloth over the frame in one pass; the
  cloth's shadows use a fixed filter, and the jaw's field is sampled once per surface, not per frame.
- The panel's Tracking line shows the camera's frame rate (and the most it says it can do), detection time and where it
  runs, and the render rate. `?pose=jump` and `?tracker=main` switch to the original demo's behaviour, for comparison.

## Credits

- Skull: based on ["Skull downloadable"](https://sketchfab.com/models/1a9db900738d44298b0bc59f68123393) by
  [martinjario](https://sketchfab.com/martinjario), CC-BY 4.0 (see `assets/README.md`).
- Suzanne: the Blender Foundation's monkey, from the Khronos glTF sample models, donated by Norbert Nopper.
- Face tracking: [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
- Sound, CC0 from freesound.org: "Fabric_Foley_1" and "Fabric_Foley_2" by Mediasaur (789038, 789039), "Jacket/Cloth
  Rustle 9" by brandondelehoy (494797), "wings" by amberbeata (837042), "Canvas Dropcloth Snap 1" by zembacraftworks
  (428337), "Teeth clack 1" and "Teeth clack 2" by hollandm (691908, 691909), "Crackling Flames (loop)" by NickTayloe
  (813328).
