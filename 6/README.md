# Day 6: Orrery

An engraved metal sphere whose surface is a working mechanism. Channels run round it along great and
small circles. At every crossing a turntable turns its slot from one channel to another, and carriages
carry coloured beads from crossing to crossing in clockwork ticks. The beads sort themselves onto the
circles of their colour, orbit together for a while, then scramble and start again.

Turntables, dials and plates pop out of the sphere on their rods, now and then on their own or when
clicked. Their gears turn, and the core opens underneath to show a well with a sun and planet gear
train. Press R and the machine comes apart: in a loose wave, each part in its own time, every part flies
straight out and dissolves, leaving a bare black core whose rails fade out and in. Then the new layout's
parts fly back from all around and seat themselves one by one, and the gears lock with a ka-ching.

## Controls

- Click (or tap) a turntable to pop it out and turn its bead onto another circle. Click a dial or a
  plate to pop it out and spin it.
- Drag to orbit, scroll or pinch to zoom.
- R: a new layout, finish and engraving. S: scramble the beads. M or the speaker button: sound.
- The GUI picks the layout (random great circles, a seeded symmetric one, or one of the presets), the
  finish, the bead set, the engraving motifs and how varied they are, how often parts pop out on
  their own, and supersampling for the sharpest engraving.

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
  motifs (geometric, arcane, medieval, sidereal and a generated alien script) from a distance-field
  atlas. Lines narrower than a pixel are widened and dimmed instead of breaking into dots.
- The machine is a small scheduler: each tick, turntables turn first, then every bead that has room
  moves one edge. It never lets two beads meet, never moves a bead into a turntable that is popped
  out, and never lets a plate rise while one of its corner turntables is out.

## Sound

Sound starts on the first click or key: an escapement's tic-tac, winding, ratchets, gear trains and
latches, and for the transformations a crank, tower-clock cogs, a press, levers and bolts, ending in a
ka-ching. One-shots were cut from CC0 recordings on freesound.org: "watch-ticking-contact-mic.wav" by
Astounded (478738), "Metal_Mechanism_Click_Small.wav" by LamaMakesMusic (403587), "MECHRtch_Ratchet01" by
InMotionAudio (689528), "INSTAX CAMERA - Mechanical wheel, ratchet" by Headphaze (696760),
"slide_small_3" by blaukreuz (459647), "Metal Slide 2" by WasabiWielder (323369), "Spring loaded release"
by KieranKeegan (418229), "12 Volt Solenoid Clicks" by shdwtek (679204), "Clockwork motor" by
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
