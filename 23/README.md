November 23, 2026

"Magma"

A hybrid fluid-developed volcanic sculpture: a GPU Navier-Stokes fluid simulation on the closed
sphere (using exact octahedral boundary wrapping, swirling curl vortices, and elastic coordinate
restoring) advects 3D material coordinates and fluid strain before solidifying analytically into
high-resolution padded cube-face PBR maps (up to 3072×2048).

The relief is real geometry. A mesh worker builds a 2:1-balanced adaptive quadtree per cube face
(and over the wrapped surface of the torus and knot), splitting cells while the flat cell misses the
displaced surface by more than a tolerance, so triangles gather on crack walls, plate edges and
terraces while flat slabs stay lean, within a triangle budget per quality tier. Each vertex reads
the baked height filtered to its own cell size; detail finer than the triangles is left to the
normal map. "Geometry detail" sets how far the tessellation goes. The surface also has baked
crevice AO, PCSS soft shadows, magma flowing in the cracks, a volumetric glow from the hot surface
and rising embers.

The smoke around the rock is simulated (`fumes.js`, on `modules/fumes/SmokeGrid.js`): stable fluids on a
48×56×48 grid fixed in the room (32×38×32 on medium), with the rock as a moving obstacle read from its morph field,
so it follows the melt, the pool and the new shape. Turning the rock (dragging, its momentum, the idle spin) drags
the air touching it, so it stirs and flings the smoke, which flows around it and rises past it on a light draught.
The hot lava gives off more, from spots that flare and fade as the rock turns, more where it is hotter, all over
while it is molten and (with plumes) off its underside, where hot air rises and wraps up around its sides;
buoyancy lifts it, vorticity confinement curls it, and it thins out as it goes. It is drawn in two layers: the
room's broad billows, the old static noise read through a field of offsets the flow carries (it heals slowly
back), so they keep their detail while the rock pushes them about; and the lava's own smoke as thick plumes, the
sim's density eroded by billow and detail noise into puffs with dense cores and torn rims, rising at the smoke's
pace. With plumes off, the lava's smoke is drawn as thin curling wisps instead. The light shaft marches it at half
resolution: lit cool from above with the rock's shadow, warm from the lava and the embers, self-shadowed. Each
frame's march is jittered and blended into the last (reprojected at the smoke's depth, clamped to the
neighbourhood), so a paused frame settles to a clean image.

The embers light the smoke around them: every frame the live embers' glow is splatted on the CPU (a gaussian about
0.25 across, so their light falls off over about half a unit) into a 32×38×32 grid over the sim's box
(`emberLight.js`), uploaded as an 8-bit 3D texture and read by the march as warm light in-scattered by the smoke.
Puffs near a cluster of sparks glow, and a spark crossing a billow drags a warm patch with it. About 0.2 ms a step and 0.3–0.4 ms
more march than the static smoke at 1080p on an RTX 4060 laptop; low keeps the static noise.

A change of look melts the crust, collapses the rock into a sloshing pool of lava (a raymarched
blend of the two shapes' distance fields) and raises the new shape out of it before it cools.

Styles (5): Cracked Plates, Pillow Lava, Pahoehoe Coils, Obsidian and Flow Bands.

Shapes (6): Sphere, Boulder, Rounded Cube, Crystal, Torus, and Trefoil Knot.

Controls: drag to orbit, scroll to zoom, R for a new rock, W for the adaptive wireframe.

The Smoke section of the panel (not randomised, kept in the url, all live):
- Light shaft (0–2, 1): the whole smoke and its light.
- Room smoke (0–2, 1) and Room billow size (0.5–2, 1): the broad billows filling the room.
- Plumes (0–2, 1): the lava's smoke as thick, fast-rising puffs; 0 gives thin wisps and the calmer air of before.
- From the lava (0–3, 1), From underneath (0–3, 1): smoke given off by the hot cracks, and the hot air and smoke
  rising off the rock's underside (with plumes).
- Rise speed (0.2–3, 1): buoyancy and the rock's updraft. Turbulence (0–3, 1): vorticity, how much it curls and breaks up.
- Density (0.2–3, 1): thin wisps to thick smoke. Lifetime (0.25–4, 1): how long the lava's smoke lasts.
- Draught (0–4, 1) and Draught heading (0–360°, 53): the room's air current.
- Lava light (0–3, 1), Ember light (0–3, 1): warm light on the smoke from the lava and from the embers.
