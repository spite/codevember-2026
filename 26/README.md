# 26 · Anamorph

Impossible figures as real objects. Each one is a solid sculpture in matte painted wood, cut along the line of sight
of a single viewpoint and its pieces pushed apart in depth: from that sweet spot they weld into a Penrose triangle, an
Escher cube, an impossible ring or one of 31 figures in all; from anywhere else they come apart. Most then split into
blocks that march around the loop.

Started from a zip of the figures and their sweet-spot split, ported to the shared Pipeline's look.

## Controls

- Drag to orbit and break the illusion, scroll to zoom. Letting go eases back to the sweet spot (L does it too).
- M (or the speaker button) turns the sound on and off.
- R (or the dice) for a new figure, with a random split style, gap, size and thickness. [ and ] step through the
  figures in order. S toggles the blocks, E the ink outlines, P perspective / ortho.
- Left alone it changes by itself (Auto change). Each figure orbits in, clicks into the sweet spot, splits and marches,
  then merges back and dissolves where it stands before the next one swings in.
- The panel picks the figure, whether it splits and how (together, wave, alternate, halving, from the joins, both
  ways, slide), the block length, gap, size and thickness, the look (painted, dark, studio, wireframe), the shadow
  strength, the camera sway, and how long each part of the transition takes.

## How it works

- `objects.js`: the figures. Each is one or more loops (beams on an isometric cube lattice, curved rings, flat plates)
  with *portals*: points where the loop is cut along the sightline and the rest moved in depth, so the sweet-spot view
  is unchanged but the solid is no longer one piece. The valknut places each triangle's cut where nothing covers it.
- `anamorph.js`: builds the meshes every frame. Blocks are laid out along each loop, clipped at the portals into
  pieces at their depths, chamfered as whole blocks so the bevel slides through a cut, and their gaps open in the
  chosen order. Open paths (a ladder's rungs, a waterfall's columns) stay solid while the loops march. In perspective
  the pieces are mapped through a projective transform so they still line up from the sweet spot.
- Shadows are traced per pixel in *illusion space*: against boxes placed where each piece appears from the sweet spot,
  with the depth jumps at the cuts unwound, so the impossible figure casts consistent shadows on itself. They fade out
  as the camera leaves the sweet spot, where they would no longer match. The Pipeline's own shadow maps and screen-space
  AO are off: both see the real depth, which breaks at every cut.
- The paint is a slow tone drift and long, faint brush lines along each beam, running in loop coordinates so they
  ride with the blocks and continue across closed seams.
- The camera is driven by a damped spring chasing a guide path, so it glides into the sweet spot and settles there; a
  slow sway about the sightline keeps the alignment.

## Sound

- A swoosh of pink noise through a band-pass, its level and pitch following how fast the camera swings around the
  figure.
- A wooden click as the figure locks into its sweet spot (when the pieces' depth offsets move them by less than a
  pixel), and a knock of toy wooden blocks for every gap that opens or closes, lower when closing.
- Samples, CC0 from freesound.org: "Wooden Click" by BenjaminNelan (321083) and single hits cut from
  "Toy-Wooden-Blocks_Child.wav" by rzSHI (395675).
