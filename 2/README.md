November 2, 2026

"Shatter"

An object caught a split second after it bursts, like a high-speed photograph. The surface tears into
curved pieces with real thickness, along wandering cracks or drawn out into splinters, and they fly
out with their filling, drops and chips of shell. Everything sits at position = start + velocity × t,
so any moment of the burst can be shown, scrubbed or played back in slow motion.

Subjects: a white shell over a dark core, grapefruit, porcelain, egg, chocolate, plaster over
molten rock, aged bronze with verdigris, obsidian glowing from inside, and an iridescent
thin-film coating. Shapes: sphere, torus, rounded cube, icosahedron, dodecahedron and Suzanne. Side
bursts blow off one side, in a direction each seed picks; radial ones go everywhere.

Controls: the bar at the bottom rewinds, plays, randomizes and scrubs the burst. The panel picks
the subject and shape, how far into the burst, how much spray, the rotation, and the depth of field
(focus from the nearest piece to the farthest, and aperture). Drag to orbit.

Notable:

- The tearing works on any surface: a 3D Voronoi over the surface, warped by noise or stretched
  away from the impact, with triangles that straddle a tear cut along it so the edges stay smooth.
  Thin parts (Suzanne's ears) get a thinner shell so the inside never comes out the far side.
- Depth of field is the shared pipeline's: a tiled half-resolution gather while things move, and
  frames rendered from across the lens and averaged while the view holds still (pause, or set
  Rotation to 0), which gives the exact blur.
- The iridescent coating is thin-film interference: the Airy reflectance of a film over a dark
  backing, for both polarisations, across the spectrum and through the CIE colour matching
  functions.
