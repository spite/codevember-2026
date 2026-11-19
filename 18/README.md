November 18, 2026

"Pendulum"

A pendulum swings through a row of moving gates, and everything is always just in time: discs turn their holes into
line as the bob arrives, a wall of bars shuffles back into a tunnel, a camera iris spirals open, rings spinning like
coins turn face on (most round a solid disc with the bob's outline cut through it), a stack of thin discs, whole in an
open trench through the base and riding on two rails, turns into line as a tunnel (each slit marked either side on
the rim, so the slits lining up read as two lines), a slit torus spins face on to whichever pendulum comes through, and at the top of each swing the bob
may slide into a socket and stop a hair from its back. Every few swings every turning part comes back round at once
and their gold marks line up, with a bell. Each new one is built from scratch: its layout, its hero mechanism, the
gates around it, its bob and its finish.

Controls: click (tap) a gate to knock it: it spins or shoves, and always gets back into line before the bob comes.
Drag to orbit, scroll to zoom, R for a new pendulum; left alone, the camera drifts slowly round its angle. M or the
speaker button: sound. The panel picks the layout, the hero, whether pendulums cross, the bob, the finish and look, the
clearance and the speed, the Motion (constant or quick) and Physical (below). Instant change makes R and auto change
cut straight to the next contraption (once it's built), the camera cutting to its framing, instead of flying the pieces
out and in. Auto change brings a new one every 15 seconds; randomizing, pausing or any interaction starts the count
over.

Notable:

- The pendulum is solved exactly (Jacobi's elliptic functions), so its timing never drifts at any amplitude, and
  every gate's motion is a function of the same time: where the bob passes each gate, and when, is known for good.
- No hole is designed. Each moving piece is a 2D slab, and its holes are whatever the bob and its rod sweep through it
  as both move: the solids are rasterized in the piece's frame at every pass of a whole loop (clipped to the slab's
  thickness), dilated by the clearance with a distance transform, contoured, smoothed and extruded with rounded edges.
  So the fit is exact by construction, whatever the bob's shape and however the gate moves. This runs in a worker.
- Steady gates stand where the gaps between passes are in a small whole ratio, so a constant rate lines up with every
  pass; clockwork gates hold through each pass and tick after it; burst gates wind back and dash into line just before
  it; shutters, bars and irises open around it. Every turning part makes whole turns (half turns for even bobs) a
  period or two, so everything comes back round together: the grand alignment.
- Knocking a gate puts a quintic on top of its schedule that dies away, at rest and on a whole turn, before the arm next
  comes near it; the later the knock, the gentler the jolt, and none comes while the bob is close.
- Crossing pendulums (some layouts) swing across the main plane with the same period at a smaller amplitude; their
  stations are solved so that the main bob passes 2.5 cm behind them, checked over a whole period, bob against bob and
  each rod against the other's bob. They thread gates of their own, keyholes and shutters on posts either side of the
  main pendulum's plane: each crosser is a rig of its own for the cutter, its swing plane turned across the main one.
- Motion: constant (the default) keeps every piece moving: a turning part spins steadily all the time, like the rings
  and the torus, and lands exactly in line at every pass. Its rate is the slowest whole number of steps a period that needs little correction: mostly a turn a period or
  less, about as fast as the torus, and whole loops so the grand alignment holds. Where the two gaps don't split the
  period as the steps do, its speed swells and eases smoothly once a period to land exactly (a few per cent typically,
  a third at worst). A tunnel's discs differ in how many slits they have for the rod (one, two, four..., counts that
  divide the bob's symmetry, set by the disc's distance from the tunnel's middle so the tunnel is symmetric): a disc
  lines up again at every slit, so each turns at its own speed, the fewer slits the faster. A bob with no symmetry still needs a whole turn every gap. An opening part swings smoothly shut and
  back, open only while the bob goes through. Quick is the first version: pieces wait, then snap into line just in
  time. A seed builds the same contraption either way, but for where the turning gates sit.
- Physical (off by default) keeps every piece held by something. Turning parts make whole turns between passes, so
  each meets every pass at the same angle, is cut a single slot and stays one piece. Wall bars reach far enough to stay
  between a column's plates all along their slide, and a knock can't push them off their track. A gimbal's shutters
  part along its lower arm, pedestals take
  a shutter's feet however far it opens, and rocker and ring bases stand on the floor. Any fragment still not held (by
  the base, its housing's rim, a column, its pin or its spindle) is removed. A seed builds the same contraption either
  way; `app.floating()` lists what would float in the one on show.
- The iris is built as a camera's is: five broad lobed blades round the aperture (traced from a drawing of one), thin
  sheets stacked so close they lie all but in one plane, each turning on a fixed pivot near its inner end as the actuator ring, through a pin on each, turns them all together.
  Open, their inner edges ring the aperture and the blades hide behind the housing's front plate; turned 82 degrees,
  they swing in, overlapping, and shut it. Open, the blades also stand a few centimetres apart (each one's leading end
  trimmed back), and the iris is turned so one of those gaps lies under the rod: it comes down between two blades and
  cuts neither. To still shut with no gap, their lobes are drawn out a third further than the drawing's. The housing
  closes round them, a rim between its front and back plates just beyond the blades' reach. It is too big for a
  gimbal's loop, which takes the run of discs instead (a straight stack on one pedestal, square to the path at its
  middle disc, each disc cut and timed for its own pass).
- The torus hero is a ring of round tube round the path, parted at the top by a narrow slit for the rod, its ends
  closed in gold. Like the rings it spins steadily on its upright axis, standing on the base by its lowest point like a coin
  spinning on a table (the base comes up just to it), half a turn between
  passes (or a whole one), and is face on each time the bob goes through; its hole is opened up, if need be, until
  spinning it still clears the ball. The slit sits on the spin axis, so it stays over the rod whichever way the torus
  faces: with a crossing pendulum, the torus is shared. A single crosser then hangs through the bottom of the main
  swing, a quarter period out of step, and the torus, at the single rate, is face on to each in turn. (Out of step, the
  two are never at rest together, so the set is caught and let go wherever nothing is near a gate.) Or, half the time,
  both crossers stay and each gets a torus of its own where it crosses the main path, an eighth of a period past the
  bottom: three pendulums, three tori. Spinning at the double rate, each is face on to the main bob as it passes and a
  quarter turn later face on to its crosser, which goes through at the bottom of its swing. That torus's slit opens to
  one side as far as the crosser's upright rod needs (about 60° wide, against 18° for one rod), and like the others it stands on the
  base by its lowest point. It isn't cut: its hole clears the balls and its slit the rods, by numbers sampled over a
  period.
- Slow motion (a panel switch, off by default): time eases right down, to a twenty-fifth of its pace, as the bob goes
  through each gate (a bell curve about 0.09 s of pendulum time either side of the pass) and picks up again between.
  Everything goes with it: the sounds play slowed and lowered by the pace at their moment (down to 0.15 of their speed),
  each timed by the pace on the way to it, the air past the bobs drops with their real speed, the grand alignment's
  bell rings lower, and the camera drifts slower. Where gates are close it stays slow right through.
- Pendulum view (a panel switch): the picture turns about the pendulum's pivot so its rod stays upright on screen while
  everything else swings round it. The camera only rolls about its line of sight to the pivot, so it stays where it is.
- A new contraption comes in piece by piece. The old one goes quickly: on its last swing each gate flies up as soon as
  the bob has passed it for good, the pendulum is whisked up from the top of that swing, the gates it hung over follow,
  and the base goes last. Then the next base comes down, its gates drop
  in one by one, each settling as it lands with a clack, and its pendulum is lowered in and let go. A bob resting in a
  socket leaves and arrives with it; inside the ring the pendulum goes with the ring, and the ring's gates slide out to
  the front before they fly. A gimbal's bob is held, and let go, only where it is clear of every gate. A piece's shadow
  fades as it lifts off and grows back as it comes down (in the shadow pass alone it is drawn shrunk toward its own
  centre), so none is left on the floor once it's gone, nor appears before it arrives.
- Layouts: a block cradle, a rocker whose tips are sockets, gates on posts, a ring round the pivot with a shorter
  pendulum swinging up to about 145°, slowing to a crawl through the gates near the top, and a gimbal: a pendulum on
  two hinges, one above the other, swinging at 1:2 or 2:3 so its bob draws a closed figure eight or pretzel (inlaid in
  gold on its plinth, like a harmonograph's drawing). Its bob turns on a swivel to face the way it goes; its gates
  stand upright along the loop, each placed only where nothing of the swing ever comes near it but its own pass. Layout: foucault (only when
  picked, never at random) is a Foucault pendulum instead: one long arm whose swing plane turns steadily round the
  upright, a whole turn every six or eight swings, so the bob draws a rosette of long lobes (the plinth is left plain, but for the slots). Its
  gates live in slots cut in the plinth, each lying flat in its own (face up or down, along the swing or across it,
  whichever keeps its slot clear of the others', so 4 to 10 fit): a keyhole cut down to the bob, a pair of shutters or
  an iris, for one of the swings, somewhere on one of its lobe's long sides (45–85% of the way out). As the bob comes, its
  column telescopes up out of the slot and the gate turns upright into place on top of it, square to the swing, pivoting
  on its foot, in 0.45 s; it stays up 0.14 s either side of the pass and folds back down into its slot, with a slide and a
  thump. Passes are at least 1.29 s apart, so only one is ever up. While up, a keyhole spins steadily (a third to half a
  turn a second) and lines up as the bob goes through, and shutters and irises snap open for it. A gate is checked
  against the swing only while it is up or on its way, in the pose it has at each moment, column and all, so it can
  stand where the other swings cross. Finishes: pastel clay, one
  colour throughout, and polished stone (marble, travertine) with brass.
- Sound: a whoosh of noise following each bob's speed, a swish through every gate, and mechanical one-shots for the
  gates' ticks, latches, slides and clacks, knocks and the stage's machinery; the bell is synthesized. The one-shots are
  day 6's set, cut from CC0 recordings on freesound.org: "watch-ticking-contact-mic.wav" by Astounded (478738),
  "Metal_Mechanism_Click_Small.wav" by LamaMakesMusic (403587), "MECHRtch_Ratchet01" by InMotionAudio (689528),
  "INSTAX CAMERA - Mechanical wheel, ratchet" by Headphaze (696760), "Glass Marbles Rolling on Wood.wav" by Solar01
  (661650), "Stone Sliding" by qubodup (743262), "Bycicle grears in reverse.wav" by MichelleGrobler (410557), "ratchet
  socket wrench tool" by AlaskaRobotics (551497), "Wind-up2.aif" and "Wind-up3.aif" by timgormly (162806, 162807),
  "metal clink" by waheegle (738634), "metal hammer clink.wav" by Pagey1969 (566041), "Metal clinks in a shallow dish"
  by haulaway (434194), "Clockwork motor" by robindouglasjohnson (698991), "gears Mitchel animation table mechanism turn
  metal rattle6" by kyles (452239), "Door Lock" by nebulasnails (405534), "Box Latch" by Motion_S (177851), "Metallic
  latch release.wav" by Crinkem (481789), "Antique Pocket Watch Ticking and Winding" by apintofmild (847217),
  "clockKey-cranking-winding" by Gerent (558732), "Lock - strong door" by Vrymaa (734641), "Bolt lock" by DDT197
  (445774), "1911 .45 Hammer Cocking" by shelbyshark (508243), "S011_Gear_Change_Mono" by Pól (385936), "Gear Shift" by
  microman502 (818294), "Turnstile_RX" by strikingtwice (260208), "Kirche_Duddenstett_Uhrwerk" by Jeln Pueskas
  (722593), "S32-10 Old printing press; no motor noise" by craigsmith (675545), "Clank1" and "Mechanical1" by BMacZero
  (94127, 94120), "Industrial Lever" by Autobot8299 (835550), "LeverCrank" by Harrisando (466207), "Turn
  crank_Old_Metal_Machine_Loop" by AslakHostaker (395042), "Small Crank / Winch / Can Opener" by mm4wood (760623), "Cha
  Ching.wav" by deleted_user_96253 (351304) and "old cash register open and close with a bing" by clubmydia+ (584168).
