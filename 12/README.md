# Day 12: Feather

Tori and torus knots covered in feathers. Each form is a tube around a closed centre line (a torus, a (p, q) torus
knot, or a classic knot: trefoil, figure-eight, saddle, crown, star) with thousands of feathers rooted on it,
layered like a real plumage. It breathes, rouses now and then with a wave that runs round the whole form, ruffles
where the pointer passes, and lies down under gusts of wind. Randomizing morphs it into the next form, the plumage's
colours blending on the way.

## Controls

- Drag to turn the form, scroll or pinch to zoom. Move the pointer close to stir the feathers (touch on phones).
- R: a new form and plumage. M or the speaker button: sound.
- O: a rouse, S: a swipe along the form, W: a gust of wind, C: a bird's call.
- Space stops the spin (the plumage keeps breathing and answering the pointer), F fullscreen, Tab hides the UI, P a
  screenshot.
- The panel sets the shape and its size, the palette and the feathers' own pattern, how many feathers (Density, up to
  Max feathers), their length, width, ruffle, curl, angle and lean, the under-layer, internal shadow, see-through, the
  colour gradient round the form, the light, the shadow mode, the spin and the transition (morph, or shrink and grow).
- Left alone, it changes form every 10 s.

## Notes

- Feathers are laid out on the tube straightened (a Poisson disc by area, wrapping round a closed loop, with
  neighbours staggered in height so overlapping vanes never meet), in a worker so a new form never stalls the page.
  The vertex shader bends them onto the centre line, read from a texture, which is what lets one form morph into
  another: closed loops are lined up first, then the line and the tube's radius blend while the old feathers fold
  away and the new ones grow in.
- Each feather is a card with a procedural vane: a rachis, barbs with gaps, a downy base, and its own colouring
  (plain, gradient, barred, streaked or mottled). Light goes through them with stochastic transparency, resolved by
  an opt-in temporal pass in the pipeline (jittered frames, variance-clipped history), and edge-on vanes are lit like
  fibres so silhouettes don't turn grey. Their buried bases darken under the feathers in front.
- How many feathers: Density per unit of area, capped by Max feathers. The Performance section measures the GPU time
  and keeps a running estimate of how many this device could draw at 60 fps; the next form is capped by it.

## Sound

All synthesized with Web Audio, no samples: breathing, the rustle of a rouse (dense bursts of tiny contacts rather
than noise), a softer stir under the pointer, swipes, wind gusts and the odd distant chirp, in a small convolver
room.
