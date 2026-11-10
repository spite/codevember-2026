November 9, 2026

"Membrane"

Soft jelly bodies packed inside a hollow glass or plastic shell. Turn the shell and they tumble, slide and
squeeze against each other and the walls; beads and cores float inside each body and push its skin around. The
satin finish blurs what's inside by how far behind the wall it sits: sharp where a body presses against it, a
soft glow further in. The shell is a rounded cube, slab, tower, sphere, capsule, torus, T, L, cross or peanut;
the bodies are balls, cushions, pills and five-lobed gumdrops; what floats in them is matte beads, dice and rings, or a
single core.

Controls: drag to turn the volume (it keeps spinning a little when let go), scroll or pinch to zoom. While
paused (Space), dragging orbits the camera instead. R makes a
new one: the old bodies shrink away while the volume morphs into its next shape and the new ones swell in. M or
the speaker button: sound. The panel picks the look, the volume, how many bodies, how varied and how tightly
packed, how soft, what floats inside, and the frost, haze and jelly colour. Auto change brings a new one every
12 seconds; randomizing, pausing or any interaction starts the count over.

Notable:

- The soft bodies are position-based shells: a subdivided icosahedron (a sphere, a superellipsoid cushion or a
  pill) whose particles are held by edge springs, a volume (pressure) constraint and a soft pull toward the
  best-fit rotated rest shape. Shells of different bodies collide through a spatial hash, gathered once per
  frame; floaters are heavier particles that push their own shell. Everything collides with the volume's
  signed distance field, rotating, with friction against the moving walls.
- The bodies are never drawn by the pipeline. Their skins (Loop-subdivided each frame) go into two passes: the
  nearest surface, and an additive pass of signed distances (back faces minus front faces, clipped at the
  floaters' depth) weighted by each body's absorption and scattering. That gives the jelly's colour along every
  ray, however many bodies it crosses.
- The shell is sphere-traced from the same distance field. Its walls are thin slabs: a ray through one leaves
  parallel to how it entered, so each wall only tints and reflects (Fresnel at both faces), and the eye ray crosses
  the inside straight, in register with the jelly image. Where a ray grazes the wall without reaching the inside,
  it's the rim, bent and tinted by the long path through glass. What it meets is sampled from a Gaussian pyramid of
  the jelly image, at a blur that grows with the distance behind the wall.
- The volume's shadow on the sweep is a soft shadow marched through the same field, tinted by the jelly.

Sound: a swoosh as the volume is swung round, a rubbery voop when bodies knock together, a deeper one under firmer knocks and a low wobbling bounce under
the hardest, a rubber marble rolling as the floaters knock about inside, and now and then a soft one while they rest; a suction pop as a
set leaves and squelches played backwards as the next swells in. All muffled, with a short dark echo, as if heard
through jelly and glass. Cut from CC0 recordings on freesound.org: "swoosh" by Halgrimm, "Woosh (stick swung in the air)" by Dalesome, "Swing Woosh" by Jofae, "Whoosh #1" by Kinoton, "voop.boaay" by BOAAY, "2017 03 rubber marble in a plastic bowl.flac" by arseniiv, "jellybounce_00.wav" and "jellybounce.wav" by Mixtos, "Suction Cups Popping.wav"
by ross_sinc, "Plunger Pop.wav" by praxis_bard, and for the swells "wet squish 1" by 45t, "Squelch.wav" by APallot,
"Squish.wav" by SaxOman7, "Squishes for Mud, Fruit, and Blood" by JelloApocalypse, "Squishy Gore.mp3" by DigPro120
and "Step on a slug (Splat!) 2" by Breviceps.
