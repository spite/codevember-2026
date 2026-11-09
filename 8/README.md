November 8, 2026

"Tesseract"

An infinity polyhedron, in homage to Anthony James. His sculptures are convex solids (an icosahedron, a
dodecahedron, a cube) with a dark steel frame, faces of two-way mirror glass, and a light tube along every edge
inside. Seen from outside, the mirrors inside send the tubes back and forth between the faces without end, and the
solid opens onto a lattice of light that goes on in every direction: a higher-dimensional polytope folded into a
three-dimensional one. The page opens on the prompt itself: a cube with a smaller cube nested inside and joined to it
at every corner, the usual picture of a tesseract, repeated without end by the mirrors. The piece floats in a pale
dome, which it lights through its windows.

The solids (`sculpture.js`): the Platonic and Archimedean solids, the Catalan solids, and prisms, antiprisms and
bipyramids, up to 64 faces. A change of solid morphs from one to the next.

## How it is made

The frame is a mesh rendered by the shared pipeline. The inside is ray traced exactly, per pixel, in the pipeline's
composite pass (`infinity.js`), over the lit image: there are no reflection probes and no screen-space tricks.

- **The solid as planes.** Every solid is a set of planes { n, d } with circumradius 1. Its faces are the planes
  clipped by all the others; a face only touched by the solid is dropped. The frame is the band between each face
  (raised a little) and its window, the face inset by the rim, plus the window's walls down to the glass.
- **Exact polytope tracing.** A ray enters through the face whose plane it crosses last on the way in (slab test
  over every plane), and inside it leaves through the plane it meets first. The window test is the frame mesh's
  own: the point is behind the bar if it is within the rim of another face's plane. Through a window the ray finds
  the inner glass, a two-way mirror: most of it is reflected back in (Inner mirror), and so on for up to 48
  bounces. The outside of the glass shows a faint reflection of the room, more at grazing angles, and lets
  See-through of the inside out.
- **Tubes per face.** One tube runs along each edge of each window, a little under the frame. All of a face's tubes lie
  in a thin slab below it, so a straight run inside the solid can only meet them if one of its ends is near that
  face. Each end of a run marks the faces within reach in a 64-bit mask, and only their tubes are tested: a run
  across a 32-face solid tests a handful of tubes, not all of them. Frosted nodes sit where tubes meet.
- **Footprint-filtered tubes.** A ray carries its footprint: a pixel's angle times the distance travelled,
  widened at each bounce by the warped glass and, from a glossy floor on, by the floor's blur. Every tube is
  box-filtered against it, so a lattice twenty reflections deep fades to its mean colour instead of aliasing. A
  ray that still has light left after the last bounce adds the mean light of the rest: the tubes at the rate they
  cover the walls, over a geometric series of mirror bounces. Pixels whose path went deep get two more rays, at
  full quality on the sparser solids.
- **The room's light.** Each window is a uniform polygon light at the inside's mean radiance through the glass. The
  floor and the wall (or the dome) integrate it exactly with the edge integral of the windows facing them (the convex
  solid hides the others), which gives the soft spread. A gobo gives the sharp one: from the solid's centre, each
  direction goes out through one face (an octahedral direction map, baked once per solid), and it is lit inside
  that face's window and dark behind the bars. Shadow sharpness blends the two, scaled to carry the same power, so
  the room shows the frame's shadow as a soft wash or a crisp pattern.
- **Haze.** The air around the sculpture scatters the light of its windows: six equiangular samples along each
  camera ray around the centre, each lit through the window its direction leaves through (from the same map), or
  dark behind a bar. The samples change between the frames the pipeline averages while still, so they converge.
- **Morphing.** The solids in between two (`morphPlanes`) take every face direction of both, each plane at the
  blend of the two solids' support distances along it. At the start the new planes only touch the old solid,
  at the end the old ones only touch the new: faces grow in from vertices and edges and shrink away into them.
  Window lights follow their face by its normal while faces are added, dropped or re-sorted.
- **Glass.** *Mirror* is plain two-way glass. *Dichroic* has a thin-film coating whose colour shifts with the angle
  and a little across the panel: it reflects one colour and passes the others, and never gains light in any
  channel. *Smoked* is darker and greyer and shows less of the inside. *Cracked* breaks each panel into Voronoi
  shards, each at its own angle and depth, so the reflections jump from shard to shard, with dark seams. *Open*
  removes some panels, and the ray leaves into the room. Every panel is a little bowed, askew and rippled (Warp,
  Tilt, Ripple), which bends its normal only.
- **Inside.** A nested solid, a smaller mirror with a tube on every edge, can turn inside the first one, kept within
  its inradius. Its reflections and the outer ones multiply each other. *Tesseract* nests the outer solid itself,
  shrunk and aligned, with a tube joining each of its vertices to the outer one, like a hypercube's projection.
- **Staging.** The camera ray and, on a glossy floor, its mirror image are both traced through the same call, so the
  floor reflects the lattice. Depth of field reads a hull of the solid written into the prepass depth. Rendered
  with the shared pipeline: a dim studio, GTAO and screen-space GI, AgX and a little bloom.

## Controls

Drag to turn the sculpture in your hand (a flick keeps it turning), right-drag or two fingers to orbit, scroll or
pinch to zoom. Click or tap a window to switch its light.

**Shape:**

- **Solid:** one of the 40 solids; a change morphs to it.
- **Rim:** the frame's width.
- **Nodes:** frosted connectors where the tubes meet.
- **Inside, Inside size, Inside spin:** a nested solid (none, a tesseract, the same one, or a Platonic or quasi-regular one) and
  its size and spin.
- **Spin:** how fast the sculpture turns on its stand.

**Lighting:**

- **Brightness, Lights, Tubes:** the tubes' power, their colours (white, warm or cool white, or a palette), and the
  kind of tube: frosted, LED pixels, neon or filament.
- **Pattern:** how the colours are spread: solid, per window, per tube, segments (with Segments and Gaps) or a
  gradient.
- **Dark windows:** the share of windows that are off.
- **Animation, Speed:** none, breathe, wave, scan, sequence, flicker or chase.

**Surface:**

- **Glass, Amount:** mirror, dichroic, smoked, cracked or open, and how strong.
- **Inner mirror, See-through:** how much the inside of the glass reflects, and how much of the inside shows.
- **Warp, Ripple, Tilt, Uneven:** the glass's bow, ripples and skew, and how unequal the tubes are.
- **Bounces:** how many reflections are traced (capped on phones and on the denser solids).

**Room:** gallery (a floor and a wall) or sphere (a dome all around), Haze, Floor gloss, Room light and Shadow
sharpness.

**Camera:** Aperture and Focus, for depth of field.

**Auto change** (kiosk mode): on by default, a new random sculpture every 20 seconds once the morph has landed and
nobody is interacting.

Randomize morphs to another solid, hanging at a new angle, leaves it empty inside four times in five (otherwise
any nested solid grows in), switches the tubes to frosted, neon or filament halfway through, and eases in new lights (white half the time, colours otherwise), Brightness (0.7–1.5), glass flaws (Inner mirror 0.6–0.8; Warp,
Ripple and Tilt up to 0.2), haze (0.5–1) and room light (0.75–2). Everything else stays as it is.

Phones and the medium and low tiers trace fewer bounces and a smaller direction map, and get no extra rays; on any
screen at a pixel ratio of 1.5 or more the extra rays are skipped too. The pipeline's AO/GI is off: the windows light
the room, and it barely changed it.
