// What bursts, and how.
// shell: outer and inner colour and roughness, the outer layer's share of the thickness (a rim along
//   torn edges), a pattern (0 plain, 1 citrus glands, 2 speckle, 3 ripple, 4 plaster/rock, 5 bronze,
//   6 obsidian, 7 thin film), specular, light through
//   the inside.
// fill: chunks from inside, or core: a solid sphere left standing.
// spray: liquid drops and/or two-tone chips of shell, and citrus flecks.
// burst: "radial" (everything out from the middle) or "side" (blown off one side, the rest holding).
//   metal: outer layer metalness; glowColor/glow: heat from within (patterns 4, 6).
// shell.rimColor, rimLight: a cool rim light on the outside (pattern 6).
// shell.film: { index, base, thin, thick }: an interference coating (pattern 7) of that refractive
//   index over a backing of index `base`, its thickness wandering between thin and thick (nm).
// spray.chipStretch, chipThin: chips drawn out into slivers, and thinned; chipSize scales them and
//   bigChips the share of large fast ones (default 1).
// fracture: { warp, stretch }: straighter tears, and pieces drawn out into splinters (stretch < 1)
//   pointing away from the side burst's impact.
// fill/core: glowColor, glow, molten (0 all glowing, 1 crust with glowing cracks), burn (turbulent flame).
// spray.dropGlow: drops as embers ({ glowColor, glow }).
// disabled: kept, but not offered in the panel (or to randomize).
// set: "white" (high key), "grey" (studio gradient), "slate" (dark grey, more bloom) or "dark".
const SUBJECTS = {
  shell: {
    thickness: 0.07,
    pieces: 70,
    burst: "side",
    set: "grey",
    shell: { outer: 0xe9e8e4, inner: 0x1b1b1e, outerRough: 0.55, innerRough: 0.45, rim: 0.35, pattern: 0, specular: 1, through: 0 },
    core: { color: 0x141416, rough: 0.35, specular: 1.2 },
    spray: { drops: 0, chips: 1, flecks: 0 },
  },
  grapefruit: {
    thickness: 0.09,
    pieces: 24,
    burst: "radial",
    set: "white",
    shell: { outer: 0xf59410, inner: 0xf6eadc, outerRough: 0.3, innerRough: 0.85, rim: 0.2, pattern: 1, specular: 1, through: 0.35 },
    fill: { color: 0xe03822, rough: 0.08, through: 1.2, sacs: 1, chunks: 30, lumpy: 1 },
    spray: { drops: 1, dropColor: 0xf0522a, chips: 0, flecks: 1 },
  },
  porcelain: {
    thickness: 0.05,
    pieces: 36,
    burst: "side",
    set: "white",
    shell: { outer: 0x1d3f8f, inner: 0xeee8de, outerRough: 0.06, innerRough: 0.8, rim: 0.12, pattern: 0, specular: 1.6, through: 0 },
    spray: { drops: 0, chips: 1, flecks: 0 },
  },
  egg: {
    thickness: 0.025,
    pieces: 44,
    burst: "radial",
    set: "white",
    shell: { outer: 0xd29a6a, inner: 0xf3efe6, outerRough: 0.65, innerRough: 0.7, rim: 0.5, pattern: 2, specular: 0.8, through: 0.4 },
    fill: { color: 0xf3a20c, rough: 0.06, through: 1, sacs: 0, chunks: 14, lumpy: 0.4 },
    spray: { drops: 1, dropColor: 0xf6b21e, chips: 1, flecks: 0 },
  },
  chocolate: {
    thickness: 0.12,
    pieces: 20,
    burst: "radial",
    set: "white",
    shell: { outer: 0x3b1d0e, inner: 0x5a2f16, outerRough: 0.12, innerRough: 0.7, rim: 0.3, pattern: 3, specular: 1.3, through: 0 },
    fill: { color: 0xc86a14, rough: 0.05, through: 0.8, sacs: 0, chunks: 18, lumpy: 0.6 },
    spray: { drops: 1, dropColor: 0xc86a14, chips: 1, flecks: 0 },
  },
  lava: {
    disabled: true,
    thickness: 0.16,
    pieces: 34,
    burst: "radial",
    set: "slate",
    shell: { outer: 0xe2e1dd, inner: 0x2e2c2c, outerRough: 0.95, innerRough: 0.8, rim: 0.28, pattern: 4, specular: 0.5, through: 0, glowColor: 0xff2804, glow: 6 },
    core: { color: 0x2a1408, rough: 0.6, specular: 1, glowColor: 0xff3a08, glow: 6, molten: 1 },
    fill: { color: 0x3a1a0a, rough: 0.5, through: 0, sacs: 0, chunks: 16, lumpy: 0.7, glowColor: 0xff4a0c, glow: 5, molten: 0.85 },
    spray: { drops: 0.6, dropColor: 0x200800, dropGlow: { glowColor: 0xff6a1c, glow: 24 }, chips: 1, flecks: 0 },
  },
  obsidian: {
    thickness: 0.045,
    pieces: 80,
    burst: "side",
    set: "night",
    fracture: { warp: 0.05, stretch: 0.3 },
    shell: { outer: 0x050506, inner: 0x3a0800, outerRough: 0.04, innerRough: 1, rim: 0.35, pattern: 6, specular: 0.7, through: 0, glowColor: 0xff5a0e, glow: 4, rimColor: 0x2fc8ff, rimLight: 0.35 },
    spray: { drops: 0, chips: 0.8, chipStretch: 2.6, chipThin: 0.3, chipSize: 0.6, bigChips: 0, flecks: 0 },
  },
  bronze: {
    thickness: 0.07,
    pieces: 48,
    burst: "side",
    set: "dark",
    shell: { outer: 0x7a5a34, inner: 0x3f6e5c, outerRough: 0.32, innerRough: 0.8, rim: 0.3, pattern: 5, specular: 1, through: 0, metal: 1 },
    spray: { drops: 0, chips: 1, flecks: 0 },
  },
  iridescent: {
    thickness: 0.05,
    pieces: 60,
    burst: "side",
    set: "dark",
    shell: { outer: 0x000000, inner: 0x1a1a1e, outerRough: 0.06, innerRough: 0.35, rim: 0.3, pattern: 7, specular: 1, through: 0, film: { index: 1.38, base: 2.6, thin: 260, thick: 620 } },
    spray: { drops: 0, chips: 1, chipThin: 0.6, chipSize: 0.8, flecks: 0 },
  },
};

export { SUBJECTS };
