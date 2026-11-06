November 4, 2026

"Tangle"

A nested coil of iridescent bands. Two to five flat bands with a rounded,
squircle-like section lie side by side and wind together around a central hole,
twisting around each other as they go. The coil slowly writhes, and every few
seconds it re-ties itself into a new knot, the bands sliding and morphing from one
shape into the next while the finish fades to another colour.

The coil is a closed (p, q) torus-knot path with a wobble; the bundle twists along
it, and each band breathes, slides and tilts on its own (`knots.js`). The band
frames are carried continuously along the path, so a band never flips, and a
re-tie matches the old coil to the new one (a spin about the hole, then which old
path angle and band each new sample takes) before blending them, so the bands
don't sweep across the hole while they morph.

The surface is a smooth union of swept rounded-rectangle bands (`tangle.js`). A
mesh is projected onto it on the GPU every frame with a few Newton steps, and the
normals are recomputed exactly per pixel from the same field, so the faces stay
smooth at any distance and merged bands blend into soft fillets. The bands reflect
each other: a coarse distance volume is baked each frame, and reflected rays march
it to find up to three candidate bands, which are then solved exactly. Those rays
are jittered slightly and averaged over frames, so reflections of neighbouring
bands settle into soft, glossy gradients. The finishes are thin-film
interference: holographic chrome, a pearl coat, or tinted glass that absorbs the
complementary colours. Rendered with the shared pipeline (`modules/pipeline/`):
soft PCSS shadows, screen-space AO and indirect light, depth of field and AgX.

Controls:

- Drag to orbit, pinch or scroll to zoom.
- Finish: holographic, pearl or glass. Palette: purple-cyan, gold-green or
  pink-orange. Iridescence sets the strength of the thin film. Changes fade over
  about a second.
- Bands (2 to 5) and Merge, how softly neighbouring bands blend together.
- Section: squircle, pinched (corners pushed out past the sides), fluted (ridges
  along the band) or lens, with Section amount. Changing it morphs the bands.
- Motion sets how fast the coil writhes. Auto change re-ties and restyles the coil
  every few seconds while playing (0 turns it off; pausing restarts the countdown).
- Reflections: the baked studio or a photographed studio HDR. Depth of field sets
  the blur; while nothing moves, frames from across the lens are averaged.
- Re-tie (T) ties a new knot. Space pauses, R randomises.

Phones get a lighter tier: a coarser mesh, a smaller distance volume and fewer
reflection steps.

The HDR is Studio Small 03 from Poly Haven (CC0).
