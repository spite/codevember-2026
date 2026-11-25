# Skull

`skull.glb` and `skull-evil.glb` are based on
["Skull downloadable"](https://sketchfab.com/models/1a9db900738d44298b0bc59f68123393)
by [martinjario](https://sketchfab.com/martinjario), licensed under
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).

Changes: rescaled to meters, Y-up and facing +Z; textures reduced to 1024px; a
two-bone skin added (`CraniumBone`, and `JawBone` on the jaw joint, carrying the
mandible and lower teeth). `skull-evil.glb` also has its geometry deformed: a
lowered brow, wider cheekbones, hollow temples, a longer chin and pointed canines.

`skull.sdf.bin` and `skull-evil.sdf.bin` are distance fields baked from those meshes,
for the veil in `examples/skull` to collide with: one for the cranium and upper teeth,
one for the jaw and lower teeth, on 3 mm grids, with cavities a 2 cm ball can't enter
closed.

`suzanne.glb` is Suzanne, the Blender Foundation's monkey, from the Khronos glTF sample
donated by Norbert Nopper. Changes: rescaled so her eyes sit where the skull's sockets
are, her eyes marked in the vertex colour, base color brightened and reduced to a JPEG, and the same two-bone
skin added (her jaw bone moves nothing). `suzanne.sdf.bin` is her distance field.
