November 1, 2026

"Folded"

Paper polyhedra generated with Conway operators, unfolded into flat nets and
folded back with rounded creases. Each one is a convex hull in Ammo (Bullet),
with zero gravity and springs pulling it home, so the shapes bump into each
other: drag one to throw it, tap empty space to scatter them. Randomize unfolds
them, morphs each flat net into the net of the next solid, and folds that up.
Faces bow slightly and the peaks are softly rounded; the paper can be egg white,
white with a coloured accent, or mixed origami colours.

Rendered with the shared pipeline (`modules/pipeline/`): PBR paper with a
baked fibre texture (`modules/materials/paper.js`), burnished creases and sheen,
a procedural studio environment, soft denoised PCSS shadows, analytic sphere
occlusion under the floating shapes, screen-space AO and indirect light, and
AgX tonemapping.

Sound (M or the speaker button toggles it; it starts on the first click or key): creases while the
shapes fold and unfold, a rustle as the flat sheets morph, and soft taps when shapes bump, scaled by
the contact impulse. One-shots cut from CC0 recordings on freesound.org:
"Folding paper" by bojan_t95 (507009), "Paper rustle/Plane Ticket" by puppetmaster685719 (627059),
"PAPER RUSTLING" by stevielematt (707835), "Paper in hands" by Aurelon (693923),
"20 Cardboard Folding" by Coral_Island_Studios (459447), "Office paper crumple folding handling" by
WavJunction.com (456769), "FX_Paper moving but not folding" by ssugg (588320), and
"handle_paper_2/3" by jakobhandersen (181054, 181053).
