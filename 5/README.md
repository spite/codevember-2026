November 5, 2026

"Moss"

A sculpture grown by reaction-diffusion, then slowly overgrown by moss.

The form is Gray-Scott reaction-diffusion run on the GPU in a 128³ volume (96³ on
phones), stored as a tiled 2D atlas so one draw advances every voxel. The reaction is
confined to a shape with zero-flux edges, so the pattern runs out through the surface
instead of lining it. The shapes are simple solids (sphere, egg, pebble, torus, a smoothed Suzanne) and implicit
surfaces with internal structure: the gyroid as a network and as a sheet, the Schwarz P and
Neovius networks, a diamond sheet, the tanglecube and Goursat's surface. Lattice keeps the
reaction in a hollow skin, coral grows it over a solid core, sponge fills the whole body, and solid keeps the whole shape, the pattern only eroding grooves into its skin as deep as Erosion sets.
The implicit shapes always keep a solid core under the pattern, so their tubes and sheets
stay chunky. Worms, sponge and coral are different feed/kill
rates; pores inverts spots into holes. Pattern size runs the reaction on a coarser grid and resamples
it onto the full one, so the holes grow up to 2.5x without the diffusion going unstable. The field is read back and meshed now and then while
it grows, so a change shows the form developing right away. The final field is meshed in a
worker with surface nets, smoothed, and cleared of floating fragments; the worker also
bakes hemisphere occlusion by marching the field.

The moss is a mat displaced out of the surface in cushions, plus fur shells: instanced
layers, outermost first, each an alpha-tested slice through a tileable 3D Voronoi of
shoots with leafy lobes, so the moss casts shadows and gets AO like any other surface.
Where it grows comes from a per-vertex rank (tops, outward faces, open areas, noise), so
Overgrowth is exactly the fraction covered, and the moss spreads from the best spots
outward over Grow time, staining the stone just ahead of its front. Four species with
their own colours, heights and leaf shapes sit in patches and small islands.

The stone is shaded per pixel: a slow swell, grit and fine grain, scattered pits and solution
grooves bend the normal, over mineral mottling and faint strata. A curvature baked by the mesher
wears the ridges paler and leaves grime in the hollows, streaks run down the sides, and crustose
lichen (grey-green, pale grey, rarely ochre, with a dark margin and cracked areoles) settles on the
open stone. Weathering sets how far all of that has gone.

The sculpture hovers over the floor (Float sets the gap), turned to a random orientation from the
seed (Tumble scales it back to upright); the turn is baked into the mesh, so moss still settles on
whatever faces up. Its contact shadow softens with height.

Rendered with the shared pipeline: an overcast studio, soft PCSS shadows, screen-space
AO and indirect light, depth haze and ground mist as a composite pass, depth of field,
and AgX tonemapping.

Suzanne is a 64³ distance field baked from the mesh by `tools/suzanne-sdf.mjs` (sign from the
winding number, then dilated and blurred so the ears survive and the creases round off) and stored
in `suzanne.bin`. It ignores Tumble and always faces the camera, level.

Controls: drag to orbit, scroll or pinch to zoom. R randomizes (a new sculpture), G
regrows the moss, Space pauses. The depth of field is shallow by default: Aperture sets it and Focus
moves the focal plane from the sculpture's front (-1) through its middle (0) to its back (1). It spins
slowly by default (Spin), and Auto change, on by default, brings a new sculpture once the current one has
been on show for Change every seconds (15). Randomizing, pausing, or orbiting or touching the panel starts
the count over, and Next change shows how long is left.
