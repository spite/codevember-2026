November 13, 2026

"Labyrinth"

A playable handheld labyrinth carved onto 14 closed 3D surfaces: a sphere, a torus, rounded polyhedra (icosahedron,
dodecahedron, octahedron, tetrahedron, rhombic dodecahedron, rounded cube), a superellipsoid pillow, a triaxial river
pebble, a lathe-turned bicone, a capsule, a three-fold undulating saddle ring, and a trefoil torus-knot tube. A heavy
marble rolls along the recessed channels from the Start dish to the gleaming Goal cup under world gravity while staying
hugged to the surface floor, so passages run seamlessly around the underside, through the hole of the torus, and along
every loop of the knot without the ball ever falling out.

## Controls

- **Drag** (or **WASD / Arrow keys**) to tilt and turn the labyrinth like a physical ball in your hands; let go and it
  coasts to a stop.
- **Shift + drag** or **right-drag** (or drag while paused with **Space**) to orbit the camera; **scroll** or pinch to
  zoom.
- **R**: randomize shape, cell tiling, maze type, density and finish — sinks the current walls into the blank, shrinks
  the old piece away, calculates the new values and labyrinth unseen, expands the smooth new blank, and raises the new
  labyrinth walls in a wave (switching **Shape** follows the same five-stage choreography).
- **B**: return the marble to the Start dish.
- **C** (or **Camera: follow**): toggle the car-style chase camera that perches behind and above the marble along the corridor ahead (**Follow height**, or scroll wheel, adjusts chase altitude).
- **H** (or **Hint thread**): inlay Ariadne's golden thread along the shortest path to the Goal cup.
- **M** or the speaker button: toggle sound.
- With the `steady` solver (the default), the marble rolls slowly on gentle slopes while the piece follows it with
  capped angular speed (1.2 rad/s) and acceleration (2 rad/s²), using the smallest rotation that slopes the surface
  under the marble. It also turns slowly about the vertical to bring the marble round to the side facing the camera,
  and when the piece still hides it, the orbit camera glides (gently ramped, at most 0.7 rad/s) to the nearest clear
  view (`view.js`; it leaves the camera alone for 3 s after you orbit or zoom). It favours keeping the marble in view
  over reaching the Goal cup; when it does arrive, the walls sink in a wave and a fresh labyrinth rises.
- Wherever the piece hides the marble (another strand, the far side, a wall), it shows through as a soft glowing
  rim, drawn with an inverted depth test.
- **Solver** picks the auto tilt: `steady` (above), `original`, the first version, which holds a full orientation
  with the aim facing the camera and brakes and weaves as it goes, or `optimal`, the same smallest rotation with
  tight, lively tracking that solves the most mazes (about 78 of 84 shape × cell builds within 4 minutes in
  simulation).
- **Auto change** (on by default) waits while auto tilt is still getting closer to the Goal; a solve then randomizes
  the whole piece, and a run that stops making progress for 20 s changes after the usual interval.

## Shapes, Tilings & Maze Types

- **Fourteen shapes** (`shapes.js`): analytic closest-point projections for `sphere`, `torus`, `rounded cube`, `bicone`
  and `capsule`; exact inner-solid face/edge/corner projections offset by a rounding ball for `icosahedron`,
  `dodecahedron`, `octahedron`, `tetrahedron` and `rhombic dodecahedron`; 1D-Lagrange triaxial ellipsoid projection for
  `pebble`; Newton gauge-field projection for `pillow`; and Newton curve-parameter refinement with twist-compensated
  parallel-transport frames for `saddle ring` and `trefoil`.
- **Six cell tilings** (`maze.js`):
  - **Polyhedral**: native to each form — subdivided equilateral triangles on the icosahedron, octahedron and
    tetrahedron, symmetric pentagonal kites on the dodecahedron, diamond grids on the rhombic dodecahedron, equiangular
    cubed-sphere quads on the sphere, rounded cube, pillow, pebble, bicone and capsule, and seamless $(u, v)$ tube rings
    on the torus, saddle ring and trefoil.
  - **Triangular**: geodesic subdivided icosahedron triangles relaxed onto genus-0 surfaces, and a staggered equilateral
    triangle lattice around genus-1 tubes.
  - **Hexagonal**: Goldberg polyhedra relaxed across genus-0 faces, bevels and corners, and a seamless staggered toroidal
    honeycomb on genus-1 tubes.
  - **Octagonal**: uniform $4.8.8$ truncated-quad marquetry of interlocking octagons and $45^\circ$ diamonds.
  - **Masonry**: concentric running-bond courses between polar medallions on genus-0 shapes, and staggered running-bond
    brick rings around genus-1 tubes.
  - **Voronoi**: farthest-point intrinsic Dijkstra seeding on a welded manifold mesh followed by intrinsic Lloyd
    relaxation and iterative short-edge collapse for a crack-free polygonal Voronoi complex on any genus.
- **Four maze generators** (`maze.js`):
  - **Backtracker**: depth-first search with forward tangent momentum for long, sweeping river corridors.
  - **Kruskal**: randomized spanning tree with dense forks and short deceptive cul-de-sacs.
  - **Braided**: opens dead-ends into circuits so the marble can flow continuously around loops.
  - **Rings**: weighted Prim biased along level contours (polar latitude rings on genus-0 shapes, poloidal lanes around
    the torus and trefoil) joined by sparse radial gates.
- **Walls** (`maze.js`) offers three wall-geometry modes on the exact same labyrinth seed (`original`, the default: raw polygonal
  cell boundaries; `three-step`: coarse relaxation, Chaikin B-spline corner-cutting, and angle-aware Ramer–Douglas–Peucker
  simplification; `straightened`: co-relaxed dual corridor ribbons, Steiner-arc octagonal chamfers, and geodesic
  sub-chord straightening), before extruding shared miter columns, rounded semicircular gate posts and outer bend arcs
  with zero overlapping faces. Start and Goal sit at the two-pass BFS diameter of the passage network, and each maze
  solves for its largest corner-passable marble radius via a widest-path bottleneck spanning tree over the lifted
  tangent wall-clearance field.

## Floor reflections

On the high and capture quality tiers, glossy floors mirror the walls and the marble (**Floor reflections** toggles it;
**Reflections** sets the strength and **Reflection reach** how far, in wall heights, they fade and blur). Each floor pixel's reflection
ray marches the walls' distance field: the maze's wall capsules, uploaded as float textures and looked up through a
40³ grid, extruded to the wall height (which follows the walls as they sink and rise). The marble is a sphere at its
live position. The march stops once the ray is higher than the walls, widens into a cone on rougher floors for soft
reflections, and lights what it hits with the key light and the studio. The result replaces the environment
reflection where the ray hits, through `PipelineMaterial`'s opt-in `reflections` hook. It costs about 1 ms at
1184×805 on the test laptop.

## Finishes

Twelve pairings (`materials.js`), driven by a pre-baked tileable $64^3$ `RGBA16F` 3D noise volume (domain warp,
four-octave FBM, periodic Worley domes/vesicles and $F_2 - F_1$ ridges/crazing) with physically measured metal
reflectances ($F_0$), Snell-refracted subsurface depth, smooth $C^1$ screen-space surface-gradient normal relief
(`dFdx`/`dFdy`), Tokuyoshi–Kaplanyan specular anti-aliasing, analytical wall-cove proximity and worn corridor tracks,
and matching acoustic foley profiles:
- `walnut & brass`: oiled longitudinal black walnut with irregular annual growth rings, quartersawn medullary rays,
  view-dependent chatoyant curl and hair-thin earlywood vessel lines, satin boxwood/maple walls, sunburst-turned C260
  brass bezels with 24 dark-patinated graduations, and a hardened 52100 chrome steel ball bearing.
- `boxwood`: fine-ringed European boxwood floor, East Indian rosewood walls with black-violet resin streaks, and a
  $290\,^\circ\text{C}$ heat-blued watchmaker steel marble with cobalt-to-violet oxide interference.
- `black enamel`: grand-feu piano-black vitreous enamel floor with subtle kiln wave, frosted-sablé 18th-century ormolu
  fire-gilt walls with mirror agate-burnished bevels, and a refracted banded sardonyx/carnelian eye-agate marble.
- `travertine`: vein-cut honed Roman travertine with fine tilted sedimentary varves, elongated lenticular vugs and
  sparry calcite veins, antiqued bronze bezels, and a mahogany-sheen volcanic obsidian marble.
- `verdigris bronze`: patinated antique statuary bronze with organic patchy malachite, brochantite and azurite blooming
  in sheltered pockets, hand-rubbed golden bronze bevels, and an antiqued sterling silver marble.
- `porcelain & cobalt`: Song Qingbai glazed porcelain pooling into luminous celadon coves over multi-scale tea-stained
  Kannyu crazing, hand-brushed underglaze Mohammedan blue cobalt crowns with crystalline russet iron spots, rose-copper
  bezels, and a lathe-turned solid brass marble.
- `damascus & gold`: finely forge-folded acid-etched 15N20/1095 Damascus steel with 1200-grit satin sanding lines,
  hammered 24k Koftgari gold bevel inlays, and a lapped tungsten carbide ball.
- `jade & gilt`: translucent carved spinach-celadon nephrite jade with refracted fibrous tremolite clouds, moss pockets,
  pinpoint chromite inclusions and waxy mutton-fat luster, fire-gilt bezels, and a Hetian mutton-fat white jade marble.
- `terracotta & basalt`: low-$F_0$ sun-baked Impruneta terracotta clay with kiln blushing and sandy chamotte grain,
  saw-cut micro-vesicular basalt walls, and a pyrite-flecked Badakhshan lapis lazuli marble.
- `lapis & alabaster`: flush-lapped ultramarine lapis lazuli with marble calcite clouds and clustered golden pyrite
  seams, banded translucent Volterra honey-alabaster walls, and a 24k burnished gold sphere.
- `carbon & titanium`: autoclave-cured clearcoated 3K $2\times 2$ twill carbon fiber with refracted warp/weft
  anisotropic graphite flip-flop, CNC-machined Grade-5 titanium walls with diamond-chamfered bevels, and a synthetic
  ruby corundum bearing ($\text{IOR}=1.77$).
- `yakisugi & copper`: charred Japanese yakisugi cedar with polygonal alligator shrinkage scales and matte-satin carbon
  grain, hand-planished rose-copper walls with plum cuprite base tarnish, and a white Raku crackle-glazed ceramic marble.

## Sound

Looping ambient kalimba, electric-piano and string soundtrack (`sounds/soundtrack.mp3`, made by spite with Google's
Lyria) on a dedicated Web Audio bus
that fades in gently on start and fades out to silence with a warm lowpass sweep as the old labyrinth sinks and shrinks
on randomize before blooming back in as the new piece expands and raises its walls (adjustable via **Music**). Paired
with sample-based foley (`sound.js`) cut and crossfaded from CC0 recordings on freesound.org: continuous speed- and
visibility-filtered rolling loops for wood, stone and metal, a wall-gliding rub loop, stereo-panned wall knocks and
rim clinks, a pocket latch drop, a ka-ching goal lock, air swooshes on fast spins, and mechanical shifts as walls sink
and rise. Source recordings (all CC0):
- "Glass Marbles Rolling on Wood.wav" by Solar01 (661650)
- "2017 03 rubber marble in a plastic bowl.flac" by arseniiv
- "Stone Sliding" by qubodup (743262)
- "Knife Sharpen - Stone.wav" by MWsfx
- "brushing shoes_mixdown" by hello_world+123
- "Bycicle grears in reverse.wav" by MichelleGrobler (410557)
- "metal clink" by waheegle (738634), "metal hammer clink.wav" by Pagey1969 (566041), "Metal clinks in a shallow dish" by haulaway (434194)
- "tap hammer small piece of metal gentle hits.wav" by kyles, "Metal Box Impacts 3 - Doubles - High Pitch.wav" by alexanderdanner
- "Metal_Mechanism_Click_Small.wav" by LamaMakesMusic (403587), "watch-ticking-contact-mic.wav" by Astounded (478738), "Turnstile_RX" by strikingtwice (260208)
- "Suction Cups Popping.wav" by ross_sinc, "Box Latch" by Motion_S (177851), "Door Lock" by nebulasnails (405534), "Metallic latch release.wav" by Crinkem (481789), "Bolt lock" by DDT197 (445774)
- "Gear Shift" by microman502 (818294), "S011_Gear_Change_Mono" by Pól (385936)
- "swoosh" by Halgrimm, "Woosh (stick swung in the air)" by Dalesome, "Swing Woosh" by Jofae, "Whoosh #1" by Kinoton
- "Cha Ching.wav" by deleted_user_96253 (351304), "old cash register open and close with a bing" by clubmydia+ (584168)
