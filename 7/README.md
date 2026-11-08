November 7, 2026

"Hollow"

A sculpture that hollows itself out. A solid (a thick trefoil knot, Suzanne, a sphere, an
egg, a torus, a rounded cube, a Platonic solid, a capsule or a blend of two) floats above a studio floor as a smooth, solid skin. Shallow
dimples appear on it, break through, and widen into a lattice of rounded Voronoi struts. Then it holds, tumbling
slowly in the air, and a warm light inside it glows through the thin walls and throws the pattern of its holes
across the floor and the sweep behind it.

The shapes (`shapes/volumes.js`): a thick trefoil knot, Suzanne (from a baked distance field,
`assets/suzanne-sdf-96.bin`, baked by `tools/suzanne-sdf.mjs`, with the ears and brow thickened), a sphere, an egg or
pebble, a torus, a rounded cube, the five Platonic solids, a capsule, and a smooth blend of two of them. Other families
(surfaces, knots and tangles, fractals) are still in `shapes/` but hidden: `FAMILIES` in `shapes/index.js` lists the
ones offered. The solid becomes a hollow skin around its surface.

## How it is made

Everything is geometry on a surface mesh, like perforating a mesh in MeshLab; there is no 3D field at run time.

- **A fair surface** (`surface.js`). The solid's distance field is meshed by surface nets, sampled finely only next
  to the surface, relaxed along it and projected onto the field with Newton steps; its normals are the field's
  gradient. The mesh is turned to its principal axes (Suzanne keeps a fixed upright frame) and scaled to a common
  reach, so every shape fits the same view.
- **Fields on the surface** (`hollow.js`, prepare). A coarse distance grid to the vertices gives each vertex its
  clearance (how far along its normal to another part of the surface: a solid's thickness, or another part passing
  close), its occlusion either side (a few short rays), and places the light. Curvature is how fast the normal turns.
- **Cells.** Sites are Poisson-disc samples over graph distance on the mesh, so a part of the surface passing close never blocks
  another. Their spacing comes from Cells, varies with noise, and is smaller where the surface is tight (curved, or a
  solid that is thin), then the whole layout is scaled to keep near the count asked for, but never wider than a
  solid is thick, so a cell can't wrap round a thin tube and cut it. No site sits right by an open edge. A small
  surface gets a finer mesh, so its smaller cells still have smooth struts. Each vertex takes the
  nearest site over the mesh (Dijkstra), then the nearest in space among the cells around it, so cell borders are the
  planes halfway between sites and there is no cross-talk between parts that pass close.
- **Distance to the border.** Every vertex stores b, half the gap between its distances to the nearest site and to
  each neighbouring one (Worley's F2 - F1), which is the same from either side of a border, so the strut is
  continuous across it. The gaps to all the neighbours are blended by a soft min (log-sum-exp, its width set by
  Roundness): the corners of the holes round off and the sides bow out, so the holes are ovals, and the struts
  thicken a little towards the joints, which read as webs.
  b's gradient along the surface is kept for the normals.
- **Cutting and thickening** (`hollow.js`, mesh). Each cell has a strut half-width w: the hole is where b > w. The
  wall's half-thickness follows a quarter round across the lip: with s = (w - b) / r (r the lip radius, Fillet × the
  strut's final half-width), it is t · sin θ where s = 1 - cos θ. So with w ≈ r ≈ t a strut is a round tube, with
  Fillet below 1 a rounded band. The triangles are cut along isolines of s at even steps of θ (marching triangles in
  bands), so the lip's round profile is sampled finely whatever the mesh; the rim (s = 0) is shared by both faces. Normals are analytic: the face normal tilted by the profile's slope
  along b's gradient. The wall is never thicker than the struts there are wide (so with a full Fillet every strut
  is a round tube), than there is room for where another part passes close, or than the surface's radius of curvature (so it
  tapers to a point at a pinch point instead of folding through itself). Puff crowns the struts along their middle.
- **Hollowing.** w is per cell, on its own clock, loosely spreading from the side facing the camera. At first it
  sits a lip radius past the cell's largest b: a closed skin. A shallow dimple runs ahead; then w comes down to that
  largest b (the skin thins to nothing in the middle of the cell, a dimple from both faces), breaks through, and
  widens to its final strut. A cell too small for a clean hole stays closed. Workers re-cut the surface every few
  hundredths of the erosion (one cut is 2D work, about a tenth of a second); each cut carries every vertex's velocity
  with erosion, so the vertex shader moves the surface on between cuts.
- **The light inside.** It sits at the most enclosed point that is clear of every wall: the one from which the most
  rays hit the skin, near the middle. A cube map rendered from it, in the sculpture's own frame, holds the length of
  wall along every ray, one layer per channel. Entering faces subtract their distance and leaving faces add it, under
  additive blending. Every surface the light reaches turns that into a transmittance per colour channel: porcelain
  lets a little warm light through, wax the most. The cube is mip-mapped and sampled over a cone as wide as the
  light's penumbra at that distance, with a fixed spiral of taps, so the hole patterns on the floor and the sweep blur
  with distance. The cube turns with the sculpture, so tumbling never redraws it. As daylight goes, the glow bounced
  back by the room fills the outer skin from below and the camera side, so it keeps its form at night.
- **The light's way** (`lightpath.js`). Once the lattice is open, a worker also sends a clearance grid of the final
  mesh: the distance from every node to the nearest wall. The light walks to its target by A* over that grid, paying
  more for ways closer to a wall than Light distance, so it goes round the struts and out through the holes instead of
  jumping through a wall. The way is planned again a few times a second as the target moves.
- **Staging.** The sculpture floats a little above the floor and bobs. It tumbles about two axes the whole time, while it is sketched, built and hollowed too.
  The key light's PCSS shadow falls beside it, and the floor under it is darkened as if a sphere the sculpture's size
  hid the studio from it.
- **Finish.** The colour comes from the palette, the material from the finish:
  - *Glossy* is a ceramic glaze: a crisp, strong specular over the colour, which deepens where the glaze pools in the
    hollows. It is the most opaque to the glow.
  - *Plastic* is satin injection-moulded or printed plastic: medium-low roughness, more saturated colour, a faint sheen.
  - *Porcelain* is matte-satin with a soft sheen and a little translucency.
  - *Wax* scatters: the key wraps past the terminator, redder the further it goes, and comes through thin walls, the
    room glows through from behind, the specular is broad and low, and the glow comes through the most and warmest.
- Rendered with the shared pipeline: a soft window key with PCSS shadows, GTAO and screen-space GI (which also
  bounces the glow), AgX, and bloom on the light.

## Controls

**Shape** (any change builds a new sculpture and hollows it from solid). While these change, a sketch follows them live: the
plain shape (the sculpture's own solid skin when only the cells change, or a coarse mesh of a new shape until it is
built, lit and shadowed like the sculpture) with the holes it will open drawn on it as bright
outlines (`previz.js`: the mesh is made once per shape, then celled and traced again on each change in its own worker,
with the mesher's spacing noise, rounded border distance and strut width; `sketchLines.js` draws the outlines a few
pixels wide). A change of shape shrinks the old sculpture away (ease in), fades the backdrop to
the new palette, puts the new material on, and grows the new one in (ease out with a little overshoot). The backdrop and the glow's daylight, warmth and brightness always ease to new values, never jump, and the view
and the sculpture's turn carry on across the swap. The sculpture is built and hollows 1.2 s after the
last change:

- **Shape:** a shape, or random, which picks one by the seed.
- **The shape's own sliders** (shown for the shape on show): Knot width, Knot height, Tube and Swell for the trefoil;
  Tube for the torus; Taper for the egg; Edges for the rounded cube and the Platonic solids; Length and Radius for the
  capsule; Thicken and Swell for Suzanne; Variant (which two solids, their sizes and how they meet) for the blend. The
  sphere has none. Dragging one morphs the sketch in place (a coarser mesh while it moves, no outlines), and the
  hole outlines fade in once the sliders have rested for about half a second (Cells, Variation and Roundness don't
  change the shape, so the outlines stay up and redraw live while they move); only a change of shape shrinks it out
  and grows the new one in.
**Hollowing** (also rebuilds; the outlines redraw live while these move):

- **Cells, Variation:** about how many holes on a sculpture of typical size (a smaller surface gets fewer), and how
  much their sizes vary.
- **Roundness:** how round the holes are (how much their corners blend into webbed joints).
- **Hollow time, Hollow again:** the length of the erosion, and a button (or H) to replay it.

**Look** (changes the sculpture in place):

- **Strut, Fillet, Thickness, Puff:** the width of the struts relative to their cells, how round their lips are (1:
  a full round), the wall thickness (at most the struts' width, so they stay round tubes; less flattens them into
  bands) and how much the struts crown. These re-mesh the open lattice without hollowing it again.
- **Palette:** white, bone, blush, magenta.
- **Translucency:** how much light the walls let through.
- **Finish:** glossy, plastic, porcelain or wax.
- **Tumble:** how fast it turns in the air.

**Light:**

- **Glow, Brightness, Warmth:** the light inside, its power and colour temperature.
- **Light:** fixed (held still while the sculpture tumbles around it, so the patterns sweep across the floor) or
  pointer (always at the mouse, on a plane through the sculpture, or at the last tap on touch screens, anywhere in
  the room; it finds its way through the holes once they are open, and goes straight through a closed skin). Before
  the pointer has moved, it stays where it is in the room, also across new shapes: only the first sculpture places
  it. Its cube is redrawn when it moves relative to the sculpture.
- **Light distance:** how much room the light keeps from the walls and from the floor. It still squeezes through
  narrower holes on its way, and a target closer to a wall than this is moved out to it.
- **Daylight:** from night to a bright studio. Randomize picks either a day or a night.
- **Flicker:** a gentle flicker once it has opened.

**Auto change** (kiosk mode): on by default, a new random sculpture every Change every seconds (20 by default),
counted only once the current one has finished hollowing and nobody is interacting.

Keys: H hollows it again, L switches the glow, plus the usual ones. Drag to orbit, scroll or pinch to zoom.

Randomize picks a shape and keeps the lattice open: it picks 150 to 300 cells and a
thinner strut the more cells there are, round holes (Roundness 0.5 to 1), a near-full fillet, and a wall about as
thick as the struts are wide.

Phones get a coarser mesh, fewer steps across a lip, larger
erosion steps with one worker (a second only with six cores or more), a longer default Hollow time, a smaller light
cube that is only redrawn when a new mesh lands, fewer cube taps, a wider lens in portrait, and a lens shifted up to
keep the sculpture clear of the collapsed GUI bar. A large surface gets a coarser mesh everywhere, so a frame stays
around half a million triangles. Shaders compile against a stand-in mesh while the worker prepares the first one, so
the two waits overlap, and the loading pill fills as the studio loads, the shaders compile and the worker reports its
progress.
