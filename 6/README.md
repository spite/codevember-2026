# Day 6: Orrery

An engraved metal sphere whose surface is a working mechanism. Channels run round it along great and
small circles. At every crossing a turntable turns its slot from one channel to another, and carriages
carry coloured beads from crossing to crossing in clockwork ticks. The beads sort themselves onto the
circles of their colour, orbit together for a while, then scramble and start again.

Turntables, dials and plates pop out of the sphere on their rods, now and then on their own or when
clicked. Their gears turn, and the core opens underneath to show a well with a sun and planet gear
train. Press R and the machine comes apart: in a loose wave, each part in its own time, every part flies
straight out and dissolves, leaving a bare black core whose rails thin away to nothing and the new ones
thicken in. Then the new layout's parts fly back from all around and seat themselves one by one, and the
gears lock with a ka-ching.

## Controls

- Click (or tap) a turntable to pop it out and turn its bead onto another circle. Click a dial or a
  plate to pop it out and spin it.
- Drag to orbit, scroll or pinch to zoom.
- R: a new layout, finish and engraving. M or the speaker button: sound.
- The GUI picks the layout (a seeded symmetric one, one of the presets, or random great circles, whose
  number the Circles slider sets; randomising only picks symmetric layouts and presets), how
  many beads there are and in how many colours, the finish, the bead set, the engraving motifs and how
  varied they are, how often parts pop out on their own, how often a new layout comes on its own (Auto
  change, every 30 seconds by default, counted from when a layout lands; randomizing, pausing, clicking
  parts, orbiting or using the panel starts it over, and Next change shows how long is left), and supersampling for the sharpest engraving.
- Quality, in the Rendering section: Auto (desktops high, phones medium, phones with 4 GB of memory or 4 cores or fewer low), High,
  Medium or Low; changing it reloads the page with the same seed. Low cuts the heaviest costs first: a
  1-megapixel drawing buffer, cheaper GI, no MSAA, motion blur or bloom, no guilloche and lighter geometry.
- Only a new shape comes apart and rebuilds: R, the layout or the number of circles. The finish and
  engraving change in place, and a new bead count or colours restarts the machine where it stands.

## Gallery

`gallery/` (linked from the panel) shows every layout the machine can build, each rendered in black enamel
and gold at capture quality: the presets, the symmetric orbits and random circles. Then every finish, each
on a different layout with the bead and motif sets taking turns. Each one opens in the sketch.

## Finishes

Twenty-two, after watch movements, clocks and instruments: brass, copper, steel, gunmetal, bronze and
pewter; frosted gilt with blued turntables, blued steel, rhodium, rose gold, ruthenium, ormolu and
oil-blackened steel; two-tone pairings (rhodium and blued, brass and blued, steel and rose gold, gilt and
rhodium); verdigris bronze; niello silver; and enamels: black and white enamel and lapis, where the
engraving on the gold dials and turntables is filled with the plate's colour, champleve style.

## Notes

- Layouts are arrangements of circles on the sphere. Where circles cross there is a turntable, and
  the faces between them become plates. Presets come from polyhedra (octahedral, cuboctahedral,
  icosidodecahedral and their mirror planes) and from rings around the axes of the regular solids.
  The dense ones shrink the whole mechanism to fit up to 120 turntables. "Symmetric" draws from
  layouts generated offline as orbits of rings under the tetrahedral, octahedral and icosahedral
  rotations, each checked for spacing and for plates that would fold.
- Plates are built from a distance field on the sphere: walls along the channels, cut-outs round the
  turntables and dials, rounded bevels and a closed underside.
- The engraving is drawn in the shader: rules, channel graduations, guilloche and motif belts, plus
  motifs (geometric, arcane, medieval, sidereal, and alien crop-circle pictograms seeded per layout)
  from a distance-field atlas. Lines narrower than a pixel are widened and dimmed instead of breaking
  into dots.
- Motion blur (desktop only) mostly shows while parts fly off and back, where it also softens their
  dithered dissolve. Every part's motion is already measured per frame, so while the camera holds still
  the blur reuses the prepass velocity instead of rendering the scene again.
- Once nothing moves (paused with Space, or Speed and Spin at 0, with the camera left alone for 0.4 s),
  the engraving is drawn as if pixels were a quarter of their size, so its finest lines and smallest motifs
  appear, and 64 jittered frames of it (16 on phones) are averaged, which filters that detail like a 4×
  supersample at the same resolution. Then the sketch stops rendering the scene until something changes.
- Hidden work is skipped: the gears under a part are collapsed to nothing while it is seated, the core
  draws after the parts covering it, and the next layout is found and built a step at a time while the
  old one flies apart.
- A plate whose outline is symmetric can turn just part of the way when it pops, a third, a fifth or a
  half, as long as it fits back in its hole; the machine finds each plate's symmetry from its distance
  field.
- The machine is a small scheduler: each tick, turntables turn first, then every bead that has room
  moves one edge. It never lets two beads meet, never moves a bead into a turntable that is popped
  out, and never lets a plate rise while one of its corner turntables is out.

## Sound

Sound starts on the first click or key: an escapement's tic-tac, beads rolling in their channels,
winding, ratchets, gear trains, latches and plates clinking back into place, and for the transformations a crank, tower-clock cogs, a press, levers and bolts, ending in a
ka-ching. One-shots were cut from CC0 recordings on freesound.org: "watch-ticking-contact-mic.wav" by
Astounded (478738), "Metal_Mechanism_Click_Small.wav" by LamaMakesMusic (403587), "MECHRtch_Ratchet01" by
InMotionAudio (689528), "INSTAX CAMERA - Mechanical wheel, ratchet" by Headphaze (696760),
"Glass Marbles Rolling on Wood.wav" by Solar01 (661650), "Stone Sliding" by qubodup (743262), "Bycicle grears in reverse.wav" by MichelleGrobler (410557), "ratchet socket wrench tool" by AlaskaRobotics (551497), "Wind-up2.aif" and "Wind-up3.aif" by timgormly (162806, 162807), "metal clink" by waheegle (738634), "metal hammer clink.wav" by Pagey1969 (566041), "Metal clinks in a shallow dish" by haulaway (434194), "Clockwork motor" by
robindouglasjohnson (698991), "gears Mitchel animation table mechanism turn metal rattle6" by kyles
(452239), "Door Lock" by nebulasnails (405534), "Box Latch" by Motion_S (177851), "Metallic latch
release.wav" by Crinkem (481789), "Antique Pocket Watch Ticking and Winding" by apintofmild (847217),
"clockKey-cranking-winding" by Gerent (558732), "Lock - strong door" by Vrymaa (734641), "Bolt lock" by
DDT197 (445774), "1911 .45 Hammer Cocking" by shelbyshark (508243), "S011_Gear_Change_Mono" by Pól
(385936), "Gear Shift" by microman502 (818294), "Turnstile_RX" by strikingtwice (260208),
"Kirche_Duddenstett_Uhrwerk" by Jeln Pueskas (722593), "S32-10 Old printing press; no motor noise" by
craigsmith (675545), "Clank1" and "Mechanical1" by BMacZero (94127, 94120), "Industrial Lever" by
Autobot8299 (835550), "LeverCrank" by Harrisando (466207), "Turn crank_Old_Metal_Machine_Loop" by
AslakHostaker (395042) "Small Crank / Winch / Can Opener" by mm4wood (760623), "Cha Ching.wav" by
deleted_user_96253 (351304) and "old cash register open and close with a bing" by clubmydia+ (584168).
