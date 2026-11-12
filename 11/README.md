# Day 11: Rust

Floating clockwork gear trains that really work, left to rust. Every machine is a seeded train of involute gears
(spur, compound and idler stages, helical, herringbone, crossed, bevel, worm, ring, planetary, yoke, differential
and chain drives) that mesh correctly and are all driven by one coordinate: the escape wheel's angle. A clock escapement meters it out, either a Graham
deadbeat anchor with a pendulum or a lever escapement whose fork swings a balance wheel through a wide arc, so the
train advances in ticks.

While a machine runs it ages, from bare oxidised steel and brass to heavy rust: patches start in the roots and
crevices and spread, the crust thickens and blisters, edges pit, plates flake away, grime and old grease pack the
corners. As the rust grows the train starts to stick: it holds until the pull beats the friction, then lurches. Each
change of machine knocks the parts off their axles and away, and the next one flies in and seats itself, in a new
light studio.

## Controls

- Drag a gear to turn the train by hand: the anchor lifts clear and the whole train follows, with a ratchet under
  your hand. Drag elsewhere to orbit, scroll or pinch to zoom.
- R: a new machine, finish and studio. T: a timelapse of the ageing. M or the speaker button: sound.
- Space pauses, F fullscreen, Tab hides the UI, P a screenshot.
- The panel sets the gear count, the mix of gear types, the chance of a balance wheel over a pendulum, chamfer and
  wear, and the weathering: age, rust and its colours, grease, edge pitting, flaking and grime.
- Left alone, it changes machine every 20 s, ageing each one over that time.

## Notes

- The gears are true involutes with backlash, laid out by a generator that grows the train stage by stage from the
  escape arbor and checks every part against the others with colliders. Meshed teeth never touch.
- The rust is a procedural material over four CC0 scans: grown corrosion fields (baked into `corrosion.bin` by
  `tools/bake.mjs`) decide where and when it arrives; the scans give its pattern and relief, triplanar with iq's
  anti-tiling. Gear zones (roots, flanks, tips, bore, sunk webs) from uniforms place polish, grease, grime and dark
  scale where they would be on a real gear. The crust puffs the surface out a fraction of a millimetre (less than
  the backlash) and rounds the chamfers.
- The view: candidate directions are scored by how much of each gear's disc they show (favouring three-quarter
  views) and how little the parts hide each other. The machine turns slowly on its spot so its best side faces the
  camera halfway through the show, lit from the side by the key.

## Sound

Sound starts on the first click or key: the escapement's tic-tac, teeth meshing, rust catching and breaking free,
the ratchet under a dragging hand, creaks from old machines, a lever and heavy clanks and chains as a machine is
knocked apart, and clinks and latches as the next one seats. All CC0 from freesound.org:

- The tick, cog, ratchet, clink, clack and latch sets are day 6's (credits in `6/README.md`).
- "single big impact, industrial press.wav" by vestibule-door (668993), "metal-impact" by JeffPearson (850040),
  "MetalClank2" by Oddworld (171246), "Clang" by qubodup (812592), "Clang 1" by editor_adp (198116), "Chain
  rattling" by georgesavic (593458), "Chain.ogg" by egomassive (536737), "Steel chain hard clicking" by ani_music
  (167916), "Metal Creak 4.wav" by ingudios (119468), "Industrial Lever" by Autobot8299 (835550).

## Credits

Rust scans, CC0: ambientCG Rust007, Rust004 and Metal055C, and Poly Haven rust_coarse_01.
