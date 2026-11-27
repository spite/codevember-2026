# 27 · Burrow

*27 November 2026 — Prompt: Burrow*

A cast-metal burrow in a frosted resin block on a plinth, under a single gallery spot in a dark room. Each piece plays
as a cycle: an empty plinth, the metal pours in and finds the burrow, it cools as the resin rises around it, and the
finished piece rests. A new one lifts the old piece out of view and starts again.

Six procedural burrow morphologies (`dendritic`, `antcast`, `brood`, `shaft`, `filigree`, `termite`) are baked into a narrow-band 3D signed distance volume alongside a 3D-blurred volumetric ember glow field. A 3D raytraced frosted glass pass (`cube`, `cylinder`, `column`, `hex`, `slab`, `dome`, `monolith`, `paperweight`) refracts through the block into seven cast-metal finishes (`aluminum`, `bronze`, `gold`, `copper`, `iron`, `bismuth`, `blued`), runs a second-bounce Total Internal Reflection crossing for mirrored internal wall reflections, applies a silhouette-masked Gaussian pyramid + Vogel-disc depth-frost gather, and composites crisp Fresnel reflections and adjustable chamfered edge catchlights on top.

## Controls

- **Drag** to orbit, **scroll** to zoom
- **R** — cast a new burrow (the old piece lifts away first)
- **P** — replay the cast of this piece
- **E** — toggle excavate (hide/show the frosted glass encasing)
- **M** — toggle sound
- **Space** — pause / resume

Left alone, the camera slowly circles the piece, near and far, above and a little below (Idle orbit in the panel), and
auto change casts a new piece once each one has rested for its interval.

## Notable

- True 3D raytraced glass refraction and Total Internal Reflection over a `Data3DTexture` burrow SDF and 3D-blurred volumetric glow field.
- Depth-weighted bilateral frosted blur so branches close to the front glass wall stay sharp while deeper tunnels and internal wall reflections soften into milky frosted silica.
- Multi-scale craggy sand-cast micro-relief with smooth specular lower undersides and heat-oxidized molten ember transitions.
- The pour: a molten stream falls into the hole and each point of the cast takes its heat from when the front reached it, white-hot at the front and molten until the pour ends; then it cools through orange and red to bare metal over about 3 s, the first metal in first; the deepest tips keep an ember glow.
- Internal reflections off the frosted faces arrive blurred by the frost, as light scattered by a sandblasted surface would.
- The gallery spot is a beam of lit haze along the key with forward scattering, shadowed by the plinth, the glass and the cast, with drifting dust motes and a lit pool where it lands.
- The bake is split: the seeded layout of the burrow is drawn on the page (so a seed always gives the same piece), and
  rasterizing it into the distance volume (about a second) runs in a worker while the old piece lifts away.
- The volume is stored as half floats: at 8 bits, the rounding of the distance showed in the normals and made the
  highlights shimmer as the cast turned. The glass pass has its own temporal antialiasing on top.
- The case's shadow on the plinth is worked out in the plinth's shader from how far the spot's light runs through the
  resin, so it is smooth and steady; the metal casts through the shadow map.
- Dust in the beam wanders on its own, mostly faint specks with a few larger flakes that glint as they tumble, and blurs
  into soft discs away from the focus distance.
- On Windows, Chrome compiles shaders through Direct3D's FXC, which inlines every call: each heavy function (the crossing, the metal shading, the distance functions in the normals) has a single call site, which took the first frame from about 37 s to 12 s there.

## Sound

A thick, gloopy bubbling while the stream runs (one of three takes per pour), a soft sizzle as it first hits, and a crackle
as the cast cools, fading with its heat. Cut from CC0 recordings on freesound.org: "Hot Bubbling Mud" by Breviceps
(456806), "Lava Loop 1" and "Lava Loop 2" by Fission9 (474850, 474852), "ShovelSizzle8_mod.MP3" by rabban625 (436470),
"Bread Crackling Cooling Fresh from Oven" by Erbsland-Music (623368) and "Bread is singing out of the bread oven" by
Sacha.Julien (727285); looped, softened and levelled into `sounds/`.
