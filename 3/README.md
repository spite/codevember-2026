November 3, 2026

"Melt"

A floating object melting under a coat of glossy liquid. Blobs seep out of the
skin, sag and run downhill, merge into bigger ones and leave wet trails behind.
On the underside the liquid gathers into a pool that sags into a teardrop as it
fills, then stretches on a thinning thread until a big drop pinches off and falls
into a puddle that spreads on the floor below.

The liquid is a field of soft kernels displaced onto the body in the vertex shader
and refined per pixel, so the bumps stay smooth at any distance. The displaced surface
is evaluated once per vertex per frame (`bake.js`, the vertices drawn as points into a
float texture) and every pass reads it from there. Blobs walk the
surface mesh with gravity in object space, so they follow world down when the
object rocks, tumbles or flips. The hanging pools are part of the same skin: around
a low point the displaced surface is remapped onto a lathe profile, so a pool swells
out of the body without a seam. The profile is a Young–Laplace pendant drop for the
pool's volume (`dropShape.js`, tabulated once at load for several root widths): a
shallow lens on a wide root, then, as the root narrows, a pear that is widest near
its round bottom and filleted broadly into the skin. Each pool has its own size, root
and fill rate, so neighbours drip out of step. Only in the last fraction of a second
does a neck form: the bulb rounds off under a thread that opens into a cone. It
snaps, the bulb falls as a drop of exactly its drawn volume and proportions that
wobbles round as it falls, and the cone recoils into a nub. Drops fall
ballistically and splat into a height-field puddle, a thick
pool with a rounded edge; stray splats drift in to join it, and each landing sends a
splash ring across its surface. Rendered with the shared pipeline (`modules/pipeline/`): soft PCSS
shadows, screen-space AO and indirect light, sphere occluders under the object,
pools and drops, motion blur and AgX.

Controls:

- Hold on the object to grow a blob; tap to drop a smaller one. Holding on the
  underside keeps it dripping.
- Drag on the object to turn it, drag elsewhere to orbit, pinch or scroll to zoom.
- Shape: Suzanne, Heart, Blob, Sphube, Torus, Knot, Star, Icosahedron, Dodecahedron.
- Finish: Lacquer, Blueberry, Candy, Mercury or Wax (candle wax with subsurface scattering: light wraps past the shadow line and glows through thin parts; dimpled where dry, glossy where fresh melt runs).
- Amount, Viscosity, Size and Drip length shape the melt; Reset melt (M) dries
  the object and lets it seep again.
- Motion: Rock, Tumble or Still, with Spin. Flip (T) turns the object over.
- Set: a light or dark studio. Space pauses, R randomises.

Phones get a lighter tier: an 8k-vertex body (densified, so the pools have
vertices to swell from), fewer blobs, trails, pools and drops, smaller drips, a
smaller puddle grid and no motion blur.

The shapes are signed distance fields from my `dof` repo, meshed and baked
offline by `tools/bake.mjs`. Suzanne is Blender's monkey head, via the same repo.
