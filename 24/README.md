# Day 24 — Nest

Infinite nested Matryoshka dolls with modern graphic patterns and tactile finishes.

Each doll is turned as two hollow halves with real wall thickness, a stepped rabbet lip and raw linden wood (or
unglazed bisque) inside. The halves unscrew, peel apart along their own arcs and dissolve into the backdrop while
the doll inside grows into the hero spot, forever.

## Controls

- **Drag** to orbit (gimbal-free: over the top and underneath), **scroll** to zoom
- **Click / tap** or **N** to open the next doll
- **R** for new dolls: the doll in the middle spins once and a new seed starts at the first doll still hidden, so the new designs
  show at the next opening while the dolls on screen keep their paint
- **Space** to pause, **M** for sound
- Panel: Pattern, Finish, Palette, Faces, Shape and Backdrop (each "Family" by default), Direction (open / close),
  Speed, Finish polish, Orbit and Roll. No auto change: the nest keeps opening by itself.

## Notable

- **Infinite zoom.** Each inner doll sits coaxially inside its mother at `exp(-0.35)` scale. The nest root scales by
  `exp(0.35 · frac)` and four slots cycle through the generations, so nothing ever grows past `exp(0.35)`.
- **Families.** Generations come in families of five sharing a pattern, finish, shape and palette, with a different
  emoji expression per sibling. The 15 families are shuffled per seed and vary in hue, finish and shape on later cycles.
- **Analytic patterns.** Every pattern, face, wood grain, turning ring and gold inlay is evaluated per pixel, so it
  stays crisp at any scale.
- **One shader per pattern.** Each pattern compiles as its own small program (`DOLL_PATTERN`), and the shadow, depth
  and prepass variants skip the pattern code. The first frame waits only for the patterns on screen; the rest compile
  in the background, nearest families first.

## References

Inspired by modern Matryoshka designs and photos by:

- Becky Kemp, Sketch Inc: black-and-white graphic dolls
  (https://petitmonkey.com/products/sketch-inc-nesting-dolls-black-and-white); the dripped dolls sold by Petit Monkey
  are probably hers too (https://petitmonkey.com/products/nesting-dolls-dripped-dolls)
- Studio Marii Roze "Vremya Samotsvetov": "All Colours" interior matryoshka
  (https://www.livemaster.ru/item/36924904-kukly-i-igrushki-interernaya-matreshka-vse-tsveta-razvivayusc)
- Emma, emuse: "How to design a unique set of Russian dolls"
  (https://emusing-emma.blogspot.com/2014/04/how-to-design-unique-set-of-russian.html)
- Katelyn Masters, Bit & Bauble: "DIY Modern Nesting Dolls" (https://bitandbauble.com/diy-modern-nesting-dolls/)
- Fortmoon Forty: "Fortmoon_dolls_1" (https://www.flickr.com/photos/125787439@N05/37853823356/)
- Studio SIESTA (Zuzanna Malinowska, Marcin Wroński): ceramic BABA matryoshkas (http://www.siestastudio.com/)
- Fluid Market: "Salt and Pepper Dolls" (https://fluidmarket.fr/en/products/sel-poivre-doll-poupee-russe)
- Bud: "Babushka Dinner Dolls" set
- Eline Pellinkhof: harlequin dolls (photo signed by her)

The makers of a few other reference photos could not be traced.

## Sound

Music: "Melancholic Russian Folk Trip-Hop", generated with Lyria 3.5, looping under the foley.

Wooden foley cut from CC0 recordings on freesound.org: openings from "Wooden Box Handling Opening Closing" by
onewileybear (852176), closings from "Wooden Box: Open / Close 2 (Compilation)" by Sheyvan (475294).
