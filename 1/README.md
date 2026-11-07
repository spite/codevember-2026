November 1, 2026

"Fold"

Paper polyhedra generated with Conway operators, unfolded into flat nets and
folded back with rounded creases. Each one is a convex hull in Ammo (Bullet),
with zero gravity and springs pulling it home, so the shapes bump into each
other: drag one to throw it, tap empty space to scatter them. Randomize unfolds
them, morphs each flat net into the net of the next solid, and folds that up.
Faces bow slightly and the peaks are softly rounded; the paper can be egg white,
white with a coloured accent, or mixed origami colours.

A new set folds up every 15 seconds. Randomizing, pausing, or throwing or orbiting starts the 15
seconds over. Auto change in the panel turns it off or sets how often, and Next change shows how
long is left.

Rendered with the shared pipeline (`modules/pipeline/`): PBR paper with a
baked fibre texture (`modules/materials/paper.js`), burnished creases and sheen,
a procedural studio environment, soft denoised PCSS shadows, analytic sphere
occlusion under the floating shapes, screen-space AO and indirect light, and
AgX tonemapping.

Sound (M or the speaker button toggles it; it starts on the first click or key): soft page-turn
swishes as the shapes fold and unfold and as the flat sheets morph, and paper taps when shapes bump,
scaled by the contact impulse. One-shots cut from CC0 recordings on freesound.org: "Turned page" by
MBPL (667180), "Book_Turning_Pages_01" by moai15 (336374), "book_pages" by drummy (458887),
"Turn Page" by KikeVilaplana (511402), "Turning pages" by Suspirias (795507),
"book_page_paper_handling_fingerOnPaper" by EricsSoundschmiede (709263), "PAGES TURNING" by
ThatMisfit (388782), "page turn sound effect" by stumpbutt (431871), "Paper in hands" by Aurelon
(693923), "20 Cardboard Folding" by Coral_Island_Studios (459447), "FX_Paper moving but not
folding" by ssugg (588320), "Paper play and crease foldn" by 9thHOLLOWProductions (705165) and
"creasing paper" by krb21 (118606).
