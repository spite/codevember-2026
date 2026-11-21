November 21, 2026

"Bolt"

A clear glass object on a concrete slab in a hazy grey studio, a warm lamp set into the slab under it. Strike it: for a second the charge gathers, filaments of electricity arc from the spot to the glass
round it, as in a plasma ball, sweeping about as the places they touch wander, crackling, more and longer as it grows; then a leader darts down from above the frame, and
the return stroke flashes, white, with a restrike or two, all inside a quarter of a second. The
glass is left with the discharge frozen in it, a Lichtenberg figure. It glows blue for a moment, then it is white
fractures in the glass, lit from below by the lamp and from behind by a cool key.

Controls: click or tap the glass to strike it where you hit it (S strikes it somewhere); drag to orbit, scroll to zoom.
An object can be struck once, and not while paused; C clears the figure so the same object can be struck again; R or the randomize button brings a new clear one, always of another shape. The panel sets the shape, how the figure
branches, how much of the glass it reaches, the charge trapped in the glass, the refraction, the spin and the lamp. Auto change gives each object the set number of seconds (12 by default): if nobody has struck it 5 seconds before the
end, it strikes itself, and a strike always leaves 6 seconds to watch before the next object; randomizing, pausing or
any interaction starts the count over. Left alone for 4 seconds, the camera comes round in front of the glass, low and a little to one side
(a different side for each object), so the strike and the figure are seen backlit. M toggles the sound.

Notable:

- The figure is grown by space colonisation in a worker: charge is scattered through the glass, first sparsely,
  then finely, and the tree grows from the entry toward it, a short step at a time, pushed away from the entry as
  the field would push it, so the fronds fan out side by side. Hairline cracks are raked off every piece for the
  feathering. The leader waits for the worker, which works to a deadline.
- The discharge runs out through the glass in about a second: the worker also writes, at half resolution, when each
  place is reached (its distance along the tree from the entry), and the glass shows only what the front has passed,
  white hot and blue at the front and cooling behind it.
- The glass is not a mesh. Every shape is a distance field baked to a 96³ texture (Suzanne's is day 7's), sphere-traced
  in one full-screen pass over the lit frame: refraction in, a march through the figure, and at the far side a Fresnel
  split, with the part that stays inside crossing the object once more, which gives the copies in a block's faces.
- The figure's texture stores the distance to the channel walls rather than coverage, so the shader traces the
  channels as surfaces: chipped by noise, each chip lit as a facet of its own.
- Caustics: a jittered grid of rays from the key is traced through the same distance field in a vertex shader
  (refracted in, across, out) and splatted where it lands into a light map of the plinth's top and one of the floor;
  the figure's channels scatter the rays that cross them, so a struck object throws a mottled pattern. The plinth and
  floor find the glass's shadow by walking the key's ray through the field, and take the map's light inside it.
  `?debug=caustics` shows the floor's map.
- The bolt is a few hundred camera-facing quads, one per piece of a channel that is jagged at every scale and forks
  into branches that fork again, drawn with MAX blending into a target of their own (so joints don't glow double) and
  only while it lasts. Its timing follows lightning's: a leader, a return stroke up the channel that lights the
  branches as it passes them, restrikes down the main channel alone, a beaded afterglow. It lights the plinth and floor
  from three points up the channel, throws the glass's shadow, shows in the glass, and over-exposes the frame.
- The set: a seamless cyc lit by a cool key from behind and a warm fill, so the room goes warm to one side and cool to
  the other; a light haze in the air, and the glass's own light scattered round it. The lamp under the glass lights the
  figure by distance (the warm hot spot low in the glass) and the slab around it. The glass holds a few seed bubbles.
- Sound: a Tesla coil's hum swelling while the charge gathers, a close lightning crack with a rolling tail and a farther
  rumble, a snap for each restrike, ice crackling while the discharge runs through the glass, and a few ticks as it
  cools. Sources on freesound.org, all CC0: "Thunderstorm lightning strike" by foad (243614), "Closeup Thunder Strike
  01" by loganzsound (840628), "Thunder Clap And Rumble #9" by Kinoton (760216), "S16-18 Tesla coil sparking and
  humming" by craigsmith (675760), "ELECTRIC_ZAP_001.wav" by JoelAudio (136542), "ice grinding cracking freezing
  designed.wav" by kyles (452645) and "Ice Crack 1" by j_p_higgins (262635); trimmed and levelled into `sounds/`.
