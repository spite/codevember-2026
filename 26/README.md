November 26, 2026

"Anamorph"

Forced-perspective and orthographic impossible objects built from untwisted 3D solids split along the sightline of a single sweet-spot camera (`ring`, `figure-8`, `trefoil`, Penrose `triangle`, `square`, `diamond`, `divided-diamond`, `pentagon`, `hexagon`, `star`, `reutersvard`, `valknut`, `hex-cross`, `hooked-tribar`, `stairs`, `waterfall`, `escher-cube`, `archway`, `ladder`, `chair`, `cross`, `pinwheel`, `frame`, `s-hook`, `meander`, `spiral-tribar`, `triquetra`, `double-tribar`, `borromean`, `borromean-tribar`, and `hourglass`). From the sweet spot, the separated 3D pieces weld into an impossible figure while discrete blocks march endlessly around the loop; orbiting off-axis exposes the forced-perspective 3D depth breaks.

Controls: drag to orbit and reveal the 3D split, scroll or pinch to zoom. Press L (or click "Snap to sweet spot") to ease back into alignment, P to switch between true forced-perspective (`PerspectiveCamera`) and parallel (`OrthographicCamera`) anamorphosis, [ / ] to cycle all 31 objects, S to toggle discrete segments vs. continuous solid meshes, Space to pause, E to toggle edge outlines, and R to randomize.

Notable:

- In `perspective` mode, every vertex and edge is mapped through the exact $PGL(4, \mathbb{R})$ projective homology $(x, y, z) \mapsto \frac{D}{D + \kappa z}(x, y, \kappa z)$, preserving straight 3D lines, planar Penrose faces, and linear depth-buffer precision while scaling background pieces into huge Ames-room monoliths and foreground pieces into miniatures that align pixel-for-pixel from `(0, 0, D)` (and Physically re-normalizing via the analytical cofactor $J^{-T}$ when orbited).
- The impossible ring is built from two untwisted 180° half-torus meshes split at the minor-axis middle, with the second half rotated 180° around the camera sightline (`(u, v, z) -> (-u, -v, z)`), shaded with $C^\infty$ continuous ribbon normals across both splits from the sweet spot.
- Adjustable 3D `Chamfer` (`0..0.45`) turns every beam into an 8-sided octagonal molding that miters across 90° Penrose L-corners without creasing the coplanar ribbons, welds across sightline portals (`(ua, ub) -> (-ua, ub)` invariant on the ring), and bevels discrete block end-caps with 45° collars.
- Illusion-space `Shadows` (`0..1`) bake pre-homology sweet-spot coordinates onto the mesh and evaluate analytic PCSS-like OBB key shadows + normal-biased hemisphere and contact crease AO in the surface shader (defaulting to a luminous gallery-white `studio` look with ink `edges` and `autoSnap`) — unwinding sightline portal cliffs locally so seams stay invisible while compressing over/under crossings so bars cast crisp sculptural drop shadows onto each other that remain painted onto the separated 3D pieces when orbited.
