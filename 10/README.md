November 10, 2026

"Caustic"

Acid etching. A polished metal blank (a sphere, a torus, a rounded box, a dodecahedron with rounded edges, a lentil,
or one of the modern forms: a superellipsoid cushion, a trefoil and a cinquefoil knot, a twisted triangular ring, a
cluster of soft blobs, a gyroid sheet cut to a ball, or Suzanne) gets a generative ornament scribed on
it: a floral rinceau, an airy Art Nouveau, or one of the classic (arabesque, knotwork, scales, seigaiha, paisley,
feathers, friezes), geometric (meander, strapwork, girih, guilloché) or alien (veins, biomech, coral) patterns. Hammer
blows planish the blank and raise the motifs, the piece goes into the acid, which bites the ground away around them
(fizzing, bubbling, fuming) and drains off it, a patina creeps into the recesses, and a burnish brings the tops back to bright metal.
Twenty-one finishes, from copper with verdigris to champlevé enamel, which adds its own stages after the etch.

Shape, Metal (the finish), Pattern and Symmetry are each their own selector, and every combination works. The
Symmetry select lists only the groups the shape (and, for interlace, the pattern) can take, the sliders under the
Pattern are the ones that pattern reads, named for what they do in it, and R picks a coherent piece (a scale that
reads well, no scales, seigaiha or guilloché under enamel, which needs ground to lie in).

## How it is made

- **The blanks** (`shapes.js`, `fields.js`): the sphere, torus and box are analytic, with an exact closest-point
  projection, meshed as fine grids. The cushion ((|x|⁶ + |z|⁶)^½ + |y|³ = 1 on scaled axes), the twisted ring (a rounded
  triangle turning a third of a turn on the way round, so one edge runs round three times) and the blobs (spheres
  under a soft minimum) are distance fields: a point lands on the surface by Newton steps along the gradient, then
  slides until its offset is normal to it. The knot is a tube round a trefoil, projected exactly from the closest
  point on its curve (the nearest sample from a grid of candidate lists, then Newton steps on the parameter). Their
  meshes are built in the worker (`mesher.js`): surface nets relaxed along the surface, a tube with
  rotation-minimizing frames, and a (u, v) grid whose last ring joins the first a third of the way round. Each lists
  the symmetry groups it has (the knot's are rotations only), and the Symmetry select offers just those.
- **More blanks** (`fields.js`): the cinquefoil is the trefoil's curve generalised to a (p, q) torus knot,
  e^{i(q−p)t} − M e^{−ipt} with height sin qt, here (2, 5), with 5-fold rotations. The dodecahedron is the solid
  offset by a ball (flat faces, cylindrical edges, spherical corners), projected exactly from the closest face, edge or
  corner of the inner solid; it takes the coordinate mirrors, a 3-fold kaleidoscope about a corner, a 5-fold one about a
  face (turned up, so it spins about it) and the pyritohedral group, and its interlace grid splits each pentagon into
  five kites, which every symmetry of the solid maps onto itself. The lentil is iq's vesica turned about its axis and
  offset by a small radius for a soft rim; its interlace grid is laid by arc length from the rim, so the cells stay
  even. The gyroid is a sheet of constant thickness (G / |∇G| within a half thickness of Schoen's gyroid), cut to a
  ball with rounded corners, centred in a channel with its 3-fold axis up; its grids are surface nets of a thicker
  sheet in the gyroid's own axes (so its rotations map them onto themselves), and where Newton steps on the field miss
  (along the tunnel's axis) the projection starts from the nearest of a cloud of surface points.
- **The ornament** (`ornament.js`, grown in `build.worker.js`): the main stems are flow lines, contours of a noise on
  the surface plus a slope (Flow sets how much they wander), grown all at once from scattered seeds and kept a band
  apart, as in Inktober 2025 #26 and #27, then smoothed. Each ends in a volute. Scrolls peel off them tangentially
  into the bands, their radius of curvature shrinking linearly as in a logarithmic spiral; when blocked they curl
  tighter into the space left instead of stopping, after Robert Hodgin's Growth. Leaves, small curls, collars,
  berries, rosettes and buds go on at the nodes once a stem is grown. Occupancy discs keep everything a gap apart,
  which becomes the etched ground. Smaller scrolls and tendrils that follow the flow, then beads, fill what is left;
  a stem that would only be a stub is taken back. A last sweep over a fine lattice of the whole surface gives every
  spot still free the largest motif that fits (on a stalk from the nearest stem, else a small flower or a bead), so
  no ground is left wider than the gap. Stems are emitted as circular arcs, so they stay smooth. Every
  element keeps a growth time, which orders the drawing, and a hammer time, from the first blow that lands on it.
- **Meander** (`patterns/meander.js`): a Greek key labyrinth on a square lattice laid over the blank (the torus by
  its two angles, the knot and twist by their tube grids, anything else by an equal-angle cube projected onto it; the
  blob's by rays from its centre). Walkers step one node at a time, all at once, turning only by right angles and
  always the same way first, so alone they wind square spirals and hemmed in they run one unit off the lines already
  laid; every node left over starts a walker of its own, down to a single stud. Straight runs become flat or ribbed
  straps, mitred at the joints so their mouldings meet on the bisector.
- **Strapwork** (`patterns/strapwork.js`): Poisson sites over the blank, the edges of their Voronoi cells (clipped
  in each site's tangent plane, exact on the sphere, unrolled round folds) raised as ribbed straps with a boss at every
  junction. Each cell holds a turned medallion (faceted star, gadrooned boss or stepped terraces, folded to the cell's
  corners) inside a ring or a row of pearls, and nested fillets following the cell's outline, broken off around the
  medallion, fill the corners with chevrons. The drawing spreads as a wave from one cell.
- **Classic patterns** (Pattern in the panel). *Knotwork* (`patterns/knotwork.js`) weaves ribbons along the medial
  graph of a mesh laid over the blank (`patterns/weave.js`: a cube grid, a torus grid or rings of latitude, whichever
  the symmetry maps onto itself): every edge midpoint is a crossing, every face corner a piece of strand, smoothed into
  a B-spline and laid as circular arcs. Over and under alternate along each strand; the under one dips and stops
  short of the one above, so the crossing order reads in the relief. Breaks, scattered or along the contours of a
  noise as walls, turn strands back into knots and panels, and mirror planes always break. *Arabesque*
  (`patterns/arabesque.js`) lays flat straps on the same mesh by Hankin's polygons-in-contact: straps leave each edge
  midpoint at a contact angle and meet inside the faces, so every face and every vertex holds a star; they interlace
  at the midpoints with mitred corners, and the stars fill with split palmettes round a boss, scrolls and pellets.
  *Scales* (`patterns/scales.js`) are rows along the level lines of a slope plus noise (folded by the symmetry into
  chevrons), each row laid a row spacing below the last and shifted half a step; each scale is cut back from the rims
  of the ones above it, so the ground shows in crescents. Fish (round, striated), dragon (pointed, keeled) or snake.
  On the knot and twist the interlace mesh is their tube grid, and on the blob a cube grid cast from its centre.
- **More classic patterns.** *Seigaiha* (`patterns/seigaiha.js`) is the scales' rows with Japanese wave fans: each a
  disc of rounded concentric rings, cut back by the row above. *Paisley* (`patterns/paisley.js`) lays boteh teardrops
  largest first, each walked on the surface as a spine bending ever tighter toward its tip with a half width over it,
  then outlined by a raised band, a row of beads and a fillet, its tip curling over into a spiral that ends in a bead;
  a big flower fills the bulb, leaves or flowers go along the spine and smaller flowers and beads into every gap
  inside, then flowers, curls and beads fill the ground. *Feathers* (`patterns/feathers.js`) walks plumes from the
  quill along the level lines of a slope plus noise, their tips curling over, kept a little less than their width
  apart so the vanes overlap (the first laid on top); each is a chain of segments mitred on the bisectors, with a
  rachis and fine barbs that slant and curve toward the tip and here and there split apart, the barbs sheared so they
  run on through the joints. *Friezes* (`patterns/friezes.js`) turns the blank into bands of classical mouldings, as
  on a chased beaker: egg-and-dart, a running (Vitruvian) wave and a guilloche, with narrow bead-and-reel between,
  each between fillets. The bands are rows along level lines (`patterns/levels.js`, shared with the scales): rings
  round the axis by the angle from it, round a knot by arc length along its curve and round a torus across its tube,
  so they keep their spacing; a band goes down once most of its line is clear of the bands before, squeezed where it
  comes closer, as units spaced evenly along it, each a whole period of its moulding (elements on the seams are
  drawn whole by both neighbours, so nothing is cut there). Rosettes and beads fill the poles and band ends.
- **Girih** (`patterns/girih.js`, on framed panels from `patterns/panels.js`): the Persian ten-fold strapwork. Regular
  decagons on a rhombic lattice (each sharing an edge with four neighbours, a bowtie in every gap) carry Hankin's
  star: straps leave each edge midpoint at 54° and meet their neighbours half an edge from the corner, so every
  decagon holds a ten-point star ringed by petals. The quads of the interlace mesh become panels with a raised frame
  and a boss at each corner; each panel's chart is a Coons patch of its four edge curves (so it can wrap a thin tube),
  the lattice is laid in it with a mirror on each axis, and the straps run on under the frame. Where two stars cross
  they interlace, over and under by the checkerboard colouring of the regions they bound (a panel on a mirror plane
  just lets them meet); each star gets a ten-petal rosette or a faceted star, and pellets fill the petals and bowties.
  Panels sets how many stars a panel holds; on blanks whose grid is fixed (the polyhedra's kites, the gyroid's fine
  cells) the stars are sized to it, down to one medallion a panel.
- **Guilloché** (`patterns/guilloche.js`): engine-turned panels, Fabergé-like. The same frames, plain or ribbed, and
  some panels split again by beaded or plain fillets; each part is one primitive (a convex quad in its tangent frame,
  cut with ridges at a fine pitch in the shader): rose-engine rings with lobes, a sunburst round a polished boss,
  waves, barleycorn, hobnail (clous de Paris) or spiral rays, a palette of one to three a piece. A part whose sides
  would stray from its straight outline (on a bending tube or round a box's edge) is split until they don't, and the
  ridges fade to a sheen where they get finer than a pixel. Each panel is cut line by line as the drawing reaches it.
- **Symmetry** (Symmetry in the panel): one, two or three mirror planes, or 3-, 4- or 6-fold kaleidoscopes about the
  axis (the box takes 3-fold about its diagonal, and 6-fold as the cube's full symmetry). Every disc the generator
  reserves is also reserved at each image, so motifs grow up to the planes without crossing them, and every motif is
  copied to each image at the end, mirror images curling the other way.
- **Alien patterns** (Pattern in the panel). *Veins* (`patterns/veins.js`) is grown by space colonization: attractors
  scattered over the blank pull the nearest vein tips toward them and die once reached, in three rounds from sparse to
  dense, so main veins come first and capillaries branch off them. Radii follow the pipe model (a vein carries every
  tip beyond it), so trunks taper into capillaries; knots swell where real branches leave, and pods, bulbs and pored
  cysts, many on a short neck from the nearest vein, fill the spaces. Drawing spreads from a few hearts. *Biomech*
  (`patterns/biomech.js`), after Giger: spines of vertebrae follow flow lines, each from an orifice at its head down
  to a tapering tail, with ribs curving back into a cage; bundles of corrugated hoses run between them, sphincter
  rings with twisted folds open in the larger spaces, and nodules fill the rest. Flow, Leaves (pods / ribs), Rosettes
  (knots / orifices) and Fill steer both.
- **Nouveau** (`patterns/nouveau.js`): the airy one. A few whiplash stems, contour lines of a slow noise kept far
  apart, each end lashing into a volute with a knob at its eye, carry irises (seen from the side: three standards, two
  bearded falls drooping back, an ovary), poppies (four crinkled cupped petals, two over two, round a rayed seed
  capsule and its stamens) and lily pads (notched toward the stalk, veins forking toward an upturned rim), each on a
  long stalk that swings out and back in an S, with slender blades sweeping along the stems and buds in their spathes.
  The fill is sparing (larger spots only, motifs on stalks from the nearest stem, a stem of its own where none
  reaches), so the matted ground shows between. Flowers and leaves are two primitives of their own (`BLOOM`,
  `BLADE`), whose petal loops take their count from the data so they stay loops in the compiled shader.
- **Coral** (`patterns/coral.js`): brain coral, a labyrinth of rounded ridges of near-constant width a pitch apart.
  Walkers step all at once along the surface, wander with a smooth noise (so neighbours meander alike), keep a pitch
  from the ridge beside them (turning round its end when it stops, which makes the U-turns), and now and then fork
  into a Y; when all are stuck, batches of new ridges start a pitch beside their nearest neighbour, running both
  ways along it, until no spot is left. Across a mirror a ridge runs on to meet its own image. Texture picks crested,
  flat-topped pulsing, or septa-crossed ridges (`TUBE`s); pores and knobs fill the few wider valleys. Drawing grows
  from the first seeds outward.
- **The relief** (`relief.js`), per pixel: the primitives (arcs and strokes, lobed leaves bent along an arc,
  rosettes, beads) are packed in data textures with a grid of cells over the shape. The fragment shader sums
  the few near each pixel into a signed distance and a height, then takes the normal by finite differences, so
  the detail is as fine up close as the screen allows and needs no UVs. The scribed line follows the union's outline.
- **The etch**: the acid spreads over the piece from a few places, bites, then the rinse thins it into patches and
  away. The bite starts at the resist
  walls and spreads out across the ground, faster where the acid is agitated (a noise), and leaves the walls steep and
  rounded with a cove at their foot (an isotropic etch), deeper in open ground, matted and pitted. Under the bath the
  metal is seen dark through yellow-green acid, and the film adds its own sharp reflection, from a surface of its own:
  level, rising in a meniscus up every wall, rippling slowly, domed by the gas bubbles that nucleate on the bitten
  ground, clustered along the walls and densest where the bite is fastest, grow and pop. Copper, gold and bronze stain
  as they bite, brown, rose by the walls, then dark red-black; silver and steel go a frosty grey; the patina lays on
  over that. Fumes rise off the piece while it bites (`fumes.js`, high tier only, as are the ripples): a vapour
  raymarched at half resolution over the lit image, up to the scene's depth so the piece hides what is behind it, and folded into the last frames. Its density
  is a smoke simulation (stable fluids) on a 48 × 64 × 48 grid around and above the piece, its slices tiled in a 2D
  atlas so each pass is one full-screen draw: advection with a MacCormack correction for the vapour, buoyancy, a
  wandering draught, vorticity confinement for the curls, and a Jacobi pressure solve that keeps the flow from passing
  through the piece. The piece is a moving obstacle, its shape a signed distance baked from the blank's closest-point
  projection, and the air touching it goes with its surface, so spinning or dragging it stirs and flings the vapour.
  Vapour is given off where the acid covers it, more from spots fixed on the piece (so they turn with it) and from its
  upper side; a fine noise carried along by the flow adds the wisps finer than the grid. Lit by the key light through
  a short march toward it (and the piece's own shadow) and by the studio's ambient; on copper and the gold alloys it is nitric acid's brown NO₂, absorbing blue, elsewhere a pale vapour.
- **Compiling** (`relief.js`, `main.js`): the relief shader is large, and its first compile (tens of seconds on
  Windows' D3D) is what a new piece waits for. So each program holds only the primitive types the piece uses and the
  finish code its metal needs (`ORN_FILL`, `ORN_GUILLOCHE`, `ORN_CLEAR`, `ORN_CLOISON`, `ORN_LAM`, `ORN_ANODIZE`), one
  cached material per set. On first load the blank goes up at once in a small program of its own and the process starts
  once the relief's program is ready; a change of metal on the piece on show keeps the old finish until the new one's
  program is compiled (off to the side), then fades, switching programs at the middle of the fade. In auto change the
  next piece is grown ahead: the seed of the next change is picked while the current piece plays, what it would set is
  worked out (the randomize handler run and undone), and that piece is grown in a second worker and its program
  compiled, so the change rarely waits. The fumes' obstacle field is baked in the worker with the blank's mesh.
- **The hammer** displaces the mesh in the vertex shader: each blow dents the blank with an overshoot.
- **Patina**: an oxide over the whole piece, a crust gathered along the walls and in patches; the burnish takes
  both off the tops, highest first.
- **Finishes** (Metal in the panel): copper, silver, gilt bronze, blued steel and antique bronze with their patinas;
  parcel-gilt and damascened steel, where the motifs turn gold over a silver or blackened steel ground; and filled
  finishes with stages of their own after the etch. Niello (black sulphide in silver) and champlevé enamel
  (turquoise and coral, cobalt and white, oxblood: opaque glass in the etched ground, a second colour hugging the
  metal) are packed in as powder spreading from a few points, fused in the kiln (glowing, scaling the bare
  metal), ground flush with a stone, which cuts the motifs down to one level, and polished. Basse-taille lays
  translucent enamel over an engine-turned guilloché ground, Fabergé-like: the surface shades as glass, and the
  grooves under it are lit through it, the colour deepening with the depth of glass. Cloisonné turns each motif into a
  cell: the etch leaves only a wire round its rim, and the enamel fills inside (coral, whitening toward the crowns) and
  out (turquoise), ground flush with the wires. Shakudō gilds the motifs over a blue-black patinated ground;
  mokume-gane is a woodgrain laminate of copper, silver and brass, wavy layers that the relief and the etch cut down
  through, so the domes show rings; titanium is heat-tinted, its oxide's interference colour (straw, bronze, purple,
  blue, teal) thickening up the relief.
- **The process**, in seconds at speed 1: draw 0.3–6.5, hammer 7–11.5, etch 12–20 (the acid has spread by 13.6, rinses
  17.3–19.8), patina 19.8–23.3, burnish 23.6–26.3, done at 26.8. Enamel and niello keep the first three, then fill
  20.3–23.1, fire (with the firescale patina) 23.3–26.1, grind 26.5–29.9 and burnish 30.1–32.7, done at 33.2; auto
  change waits for the longer run.

Sound: a scribe's scratch that follows how much is being drawn, a tink per hammer blow (varied in pitch and
strength, now and then with a soft rebound; panned, duller on the far side), the acid's sizzle and the fizz of its bubbles (louder and higher while it bites fastest), a splash as the bath drains off, and the burnishing rub, cut from CC0 recordings on freesound.org: "tap hammer small
piece of metal gentle hits.wav" and "bubbles in soda steady fizz.flac" by kyles, "Sizzle / Acid Burn" by bottles (the acid's sizzle: a steady stretch, its
ends crossfaded into a loop), "Metal Box Impacts 3 - Doubles -
High Pitch.wav" by alexanderdanner, "210426 engraving scratching.wav" by TRP, "brushing shoes_mixdown" by
hello_world+123, "Water plopping in pulling out small object.wav" by vjoe1985 (the rinse), and for the enamel the kiln's torch, "blowtorch light and run flame good detail on off2.flac" by
kyles, and the grinding stone, "Knife Sharpen - Stone.wav" by MWsfx.

Controls: drag to spin the piece, scroll to zoom, Space then drag to orbit, R for a new piece, E to replay the
etching, M for sound. Motion blur follows the piece's own motion (spins, drags, the hammer's jolts, the shake-off).

Suzanne is day 7's baked distance field (`assets/suzanne-sdf-96.bin`), with her ears and brow thickened as there,
sampled by a cubic B-spline with its analytic gradient. The build worker builds the grid the first time she is chosen
and hands it to the page with her mesh.

More finishes: **gunmetal** (dark glossy steel), **excavated** bronze (a heavy verdigris crust with only the crowns
rubbed back to metal), **rusted iron** (bright silver motifs inlaid in a rusted iron ground) and **mother-of-pearl**
(nacre laid into the etched ground with the enamel stages, its colours shifting with the view and its growth layers).

**icosa**: a rounded icosahedron, the dodecahedron's dual (its faces point at the dodecahedron's corners), so it shares
all its symmetries, kaleidoscopes and kite grid.

Controls: drag to spin the piece like a trackball (it keeps its momentum, coasts down, then settles back to a slow
upright turn); pause (Space) and drag to orbit the camera instead.


**moebius**: a Möbius band, a flat stadium-section band turning half a turn on the way round, so its two faces are
one and the ornament runs over both without a seam.

**damascus**: pattern-welded steel, wavy layers of bright nickel steel and carbon steel that the etch blackens. In it
and in mokume-gane the etch also eats the softer layers deeper (the carbon steel, the copper), so the layers stand in
relief, and they show as contour rings over the raised motifs, as where a laminate is cut through.
