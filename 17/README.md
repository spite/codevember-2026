November 17, 2026

"Kelp"

A giant kelp forest seen from the reef, looking up into the sun: golden stalks rising to a canopy at the surface, bull kelp
floating its ribbons under the waves, palm kelp on the rocks, and shafts of light breaking through it all. The fixed camera
watches the forest sway in a steady surge, with bigger surges now and then. Rendered by its own renderer rather than the
shared pipeline, borrowing its bloom and final pass.

## The kelp

Three kinds, each on a holdfast on the rock, built in a worker (`kelpBuilder.js`):

- Giant kelp (Macrocystis): bundles of up to a dozen stipes from one holdfast, a low mound of root-like haptera, with a
  skirt of sporophylls at the base. A frond grows from its tip: its blades and their small stalked gas bladders grow from a
  few centimetres to full size over its top metre, splitting off one side then the other of a turning plane. Mature
  blades hang from their bladders, on their own side and downstream: broad wedges with ruffled margins, the old ones worn
  blunt and a few dying back. The older fronds reach the surface and trail along it downstream as the canopy, which frames
  the sun. The stipes of a bundle splay and cross. Behind the composed plants, more bundles fill the forest out to its far
  edge, and young plants dot the reef in front.
- Bull kelp (Nereocystis): a thin whip of a stipe flaring into one round bulb under the surface, with two bunches of long
  ribbons streaming downstream from it.
- Palm kelp (Pterygophora): stands of short woody stipes with two rows of narrow blades along their upper third.

The reef is rolling rock strewn with boulders and cobbles.

The water is a calm swell, three exact linear waves of 6.5-12 s in 25 m of water (about 0.2 m/s at the floor and 0.33 m/s
at the surface), over a slow current that the whole forest hangs downstream in. A coarse incompressible fluid on the CPU
(`fluidSim.js`: vorticity confinement, advection, pressure projection) carries what stirs it on top: the probe sphere's
wake, the pointer, S's gusts and slow eddies.

Every stipe is a chain of inextensible Verlet nodes pinned at its holdfast, dragged by the flow beyond the current it was
built in, so the forest rests as built and leans to and fro with the swell. Buoyancy holds the giant kelp up (balanced
against its spring), bull kelp floats from its bulb and palm kelp stands on its own stiffness. The shaders draw each stipe
as a smooth curve through its nodes. Every simulated blade is a tip particle hinged to its stipe within a cone, dragged
and sprung back to rest; the shaders turn the blade toward its tip and bend it along an arc, and run slow waves and a twist
down it at a pace of its own, larger in faster flow. Only the nearer plants' blades are simulated (about 4,200 of 32,000);
further back they lean with their swaying stipes.

## The light

One model for the water (`water.js`): the sun refracted at the surface, light attenuated on its way down and along the
eye's ray (red first), and diffuse light from above scattered toward the eye. The background, the fog on every surface and
the shafts all come from it.

- Caustics: a grid on a tiling patch of the surface refracts the sun through the waves; each cell's brightness where it
  lands is how much its area shrank (Evan Wallace's method). The pattern is projected down along the sun onto the kelp,
  the reef, the snow and the shafts, sharpest at the focus depth.
- Shadows: a sun shadow map (raw depth plus a comparison map, as in the shared pipeline) drawn from a coarser copy of the
  kelp. Soft, with a penumbra that grows with the distance to the blockers, found per vertex along with the canopy's cover
  so both change smoothly. Kelp lets amber light through, dimmer for every layer, and a wide lookup darkens what lies under
  the canopy.
- Blades are thin translucent sheets: the sunlit side reflects, the other side glows through the blade's thickness, lemon
  where it is young and thin, amber where it is old and thick. The light scatters inside the blade, so it comes through
  even near edge-on and glows brightest looking into the sun. Bladders and bull kelp's bulb glow like beads.
- Each blade has its own age and condition, and the lamina's relief is baked once at startup into tiling textures in blade
  metres: blisters, crinkles and patchy thickness, with Membranipora colonies, epiphyte specks, spore patches and a colour
  mottle for the older blades and the sporophylls.
- The margins are cut in the kelp's depth pre-pass, by alpha to coverage: uneven edges, fine spines on young blades and
  ragged ends on old ones. The colour pass lands only on the samples kept.
- Marine snow shows only where the sun lights it, scattering it forward, sized and dimmed as the lens draws it; a few
  specks drift close to the lens as faint out-of-focus discs.
- Light shafts: every view ray is marched at half resolution through the shadow map and the caustics, then blurred and
  upsampled with the ray lengths as a guide.
- The surface from below: Snell's window, with the sky and the sun's glints inside the critical angle and the deep reflected
  outside it, rippled by the same waves that make the caustics.
- The water softens what is far: a half-resolution, depth-aware blur mixed in with distance.
- The kelp's depth is drawn first (with the same invariant positions), so the dense foliage is shaded once per pixel.
- The frame goes through the shared pipeline's bloom and final pass (exposure, AgX, vignette, grain, dither), with
  multisampling.

## Randomize

The first forest is the composed one. R moves, leans and resizes its plants and mirrors it half the time: silt clouds the
water, the new forest (built meanwhile in the worker) is swapped in, and the water clears.

## Controls

- The camera is fixed. Move the pointer (drag on touch screens) to stir the water.
- R for a new forest, S (or "Stir the water") for a gust through the forest.
- Surge: the strength of the swell. Probe sphere: on or off. Surge (button): a big surge now; they also come by themselves every 10-25 s.
- Rendering: quality, exposure, shafts, caustics, bloom, far blur, vignette, grain, and debug views of the shadows, the
  caustics and the light reaching the surfaces (also `?debug=shadow|caustics|light`).

## Performance

The simulations run on a fixed 60 Hz step on the main thread (on a desktop: water and kelp about 2 ms each). The forest is
about 1.9 million triangles (500,000 in the shadow map's copy). Phones get the medium tier: fewer stipes and blades,
lighter tessellation, the water stepped at 30 Hz, fewer constraint passes and simulated blades, smaller shadow map and
fewer shaft steps.
