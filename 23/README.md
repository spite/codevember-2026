# 23 · Magma

*November 23, 2026* · Prompt: **Magma**

A rock of cooling crust over molten magma, turning slowly in a dark caldera. Lava glows through its cracks and
pulses as it flows, heat haze shimmers over it, embers rise off the hot spots, and smoke curls up through a light
shaft from above, stirred by the rock as it turns. Every new look melts the old rock into a sloshing pool of lava
and raises a new one out of it, which cools as it settles.

Styles (10): Cracked Plates, Pillow Lava, Pahoehoe Coils, Obsidian, Flow Bands, Shard Scales, Strata Plates,
Charred Grain, Ropy Strands and Marbled Glass.

Shapes (12): Sphere, Boulder, Meteorite, Rounded Cube, Crystal, Dodecahedron, Icosahedron, Star, Torus, Twisted Ring,
Trefoil Knot and Suzanne.

## Controls

Drag to turn the rock (it keeps its momentum, then goes back to its slow spin), scroll or pinch to zoom. R or the
randomize button gives a new rock, always of another style and shape. W shows the adaptive wireframe, M or the speaker
button toggles the sound, Space pauses. Auto change brings a new rock every 14 seconds by default.

The panel sets the style and shape, the crust (how much of the surface has cooled), the fluid flow and turbulence that
shape the pattern, its scale, the relief, the heat, the glow and its spread, the heat haze, the gloss, how fast the
magma flows, the embers and the spin. "Geometry detail" sets how far the tessellation goes.

The Smoke section (not randomised, kept in the url, all live):
- Light shaft (0–2, 1): the whole smoke and its light.
- Room smoke (0–2, 1) and Room billow size (0.5–2, 1): the broad billows filling the room.
- Plumes (0–2, 1): the lava's smoke as thick, fast-rising puffs; 0 gives thin wisps and calmer air.
- From the lava (0–3, 1), From underneath (0–3, 1): smoke given off by the hot cracks, and the hot air and smoke
  rising off the rock's underside (with plumes).
- Rise speed (0.2–3, 1): buoyancy and the rock's updraft. Turbulence (0–3, 1): vorticity, how much it curls and breaks up.
- Density (0.2–3, 1): thin wisps to thick smoke. Lifetime (0.25–4, 1): how long the lava's smoke lasts.
- Draught (0–4, 1) and Draught heading (0–360°, 53): the room's air current.
- Lava light (0–3, 1), Ember light (0–3, 1): warm light on the smoke from the lava and from the embers.

## Notable

- **The pattern is a fluid** (`sim.js`): a GPU Navier-Stokes simulation on the closed sphere (octahedral boundary
  wrapping, curl vortices, an elastic pull back to the start) advects 3D material coordinates and the fluid's strain.
  Each style reads them in its own bake shader (`baker.js`), so the plates, coils, bands and veins all look sheared and
  dragged by flow, then solidifies them into padded cube-face maps of height, heat, normals and crevice AO (up to
  3072×2048 at high quality).
- **The relief is real geometry** (`meshWorker.js`, `meshData.js`): a worker builds a 2:1-balanced adaptive quadtree per
  cube face (and over the wrapped surface of the torus, twisted ring and knot), splitting a cell while its flat patch
  misses the displaced surface by more than a tolerance, so triangles gather on crack walls, plate edges and terraces
  while flat slabs stay lean, within a triangle budget per quality tier. Each vertex reads the baked height filtered to
  its own cell size; detail finer than the triangles is left to the normal map. W shows the result.
- **Melt, pool, recompose** (`morph.js`): a change of look melts the crust (1.4 s), hands the rock to a raymarched
  liquid, a blend of the two shapes' distance fields that collapses into a sloshing pool (1.1 s + 1.2 s), raises the new
  shape out of it (1.4 s) and hands it back to the new mesh, which cools (2.6 s). The old and new lava patterns
  cross-fade while the liquid churns. The field is baked into an atlas of z slices so the shaft and haze read it cheaply.
- **Heat glow and haze** (`glow.js`, `pulse.js`): a volumetric glow around the hot surface and a heat shimmer whose
  plumes stand over the lava. Both are paired with the flowing lava: a pulse volume evaluates the same flowing noise
  the surface shows at the nearest surface point, so the glow and the light the lava spills on the rock flare and drift
  with the flow instead of sitting still.
- **Embers** (`embers.js`): CPU particles that leave the hottest, brightest spots of the flowing lava (weighted by the
  pulse, read back asynchronously), rise on buoyancy that fades as they cool, and ride a divergence-free turbulent
  flow. They collide with the rock through its baked distance field, so it pushes them aside as it turns.
- **Smoke** (`fumes.js`, on the shared `modules/fumes/SmokeGrid.js`, also day 10): stable fluids on a 48×56×48 grid
  fixed in the room (32×38×32 on medium), with the rock as a moving obstacle read from its morph field, so it follows
  the melt, the pool and the new shape. Turning the rock drags the air touching it, so it stirs and flings the smoke.
  The hot lava gives off more from spots that flare and fade, and (with plumes) hot air rises off the underside and
  wraps up around the sides; buoyancy lifts it, vorticity confinement curls it, and it thins out as it goes. It is
  drawn in two layers: the room's broad billows, static noise read through a field of offsets the flow carries, and the
  lava's own smoke as thick plumes, the sim's density eroded by noise into puffs with dense cores and torn rims.
- **Light shaft** (`shaft.js`): the smoke is marched at half resolution, lit cool from above with the rock's shadow,
  warm from the lava and the embers, and self-shadowed. Each frame's march is jittered and blended into the last
  (reprojected at the smoke's depth, clamped to the neighbourhood), so a paused frame settles to a clean image.
- **Embers light the smoke** (`emberLight.js`): every frame the live embers' glow is splatted on the CPU into a
  32×38×32 grid over the sim's box and uploaded as an 8-bit 3D texture, which the march reads as warm in-scattered
  light. Puffs near a cluster of sparks glow, and a spark crossing a billow drags a warm patch with it.
- **Performance**: the bakes run in bands and slices spread over frames while the rock is hidden in the pool, the
  fluid for the next look is developed ahead during the melt, readbacks are asynchronous, the other styles' bake
  programs compile in the background, and the morph field and rising heat are baked into textures rather than
  evaluated per sample. Low quality keeps the static smoke.
- **Sound** (`sound.js`): a looping dark minimalist drone on its own Web Audio bus. It downloads as a load step, starts
  at a random point in its first minute and fades in, at once when the browser allows it and otherwise on the first
  click, tap or key; it fades out while paused or muted.

## Credits

- Soundtrack (`sounds/soundtrack.mp3`) made with Lyria 3.5.
- Code: started in Antigravity with Gemini 4 Neon, finished in Claude Code with Opus 5.5.
