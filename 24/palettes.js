import { Color } from "three";

const FAMILY_SIZE = 5;
const SHAPE_LIST = ["Nordic", "Classic", "Pear"];

// Shift a color's hue/saturation/lightness only when it is chromatic (preserves pure whites & jet blacks)
function shiftChromatic(hex, dh, ds = 0, dl = 0) {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.s < 0.14 || hsl.l < 0.10 || hsl.l > 0.91) return c;
  c.setHSL(
    (hsl.h + dh + 10) % 1,
    Math.max(0.18, Math.min(0.92, hsl.s + ds)),
    Math.max(0.16, Math.min(0.84, hsl.l + dl)),
  );
  return c;
}

// Compute a remixed studio backdrop for Cycle >= 1 so recurring families feel fresh and cohesive
function getBackdropForFamily(familyIndex, seed) {
  const family = getFamilyForIndex(familyIndex, seed);
  const base = family.backdrop;
  const cycle = Math.abs(Math.floor(familyIndex / FAMILIES.length));
  if (cycle === 0 || family.patternIdx === 11 || family.patternIdx === 8) return base;
  const dh = (cycle * 0.381966 + hashGen(seed, familyIndex, 91) * 0.18) % 1;
  const shiftBg = (hex) => {
    const c = new Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // Keep studio backdrops warm, sunlit, and gently desaturated
    const nextH = (hsl.h + dh * 0.35 + 1) % 1;
    c.setHSL(nextH, Math.min(0.26, Math.max(0.10, hsl.s)), hsl.l);
    return `#${c.getHexString()}`;
  };
  return {
    bg: shiftBg(base.bg),
    cyc: shiftBg(base.cyc),
    level: base.level,
    wallFill: base.wallFill,
  };
}

const PATTERNS = [
  "Bauhaus",
  "Drip",
  "Mosaic",
  "Botanical",
  "City Stripe",
  "Dipped",
  "Folk Graphic",
  "Patchwork",
  "Monochrome",
  "Porcelain Shawl",
  "Babushka",
  "Balloon",
  "Gel Overlap",
  "Modern Folk",
  "Scandi Emblem",
];

const FINISHES = [
  "Matte Wood",
  "Glossy Lacquer",
  "Glazed Ceramic",
  "Raw & Dipped",
  "Satin & Brass",
];

const FACES = [
  "Happy",
  "Wink",
  "Surprised",
  "Serene",
  "Smirk",
  "Grin",
  "Curious",
  "Bliss",
  "Minimal",
  "None",
];

const BACKDROPS = {
  "Warm plaster": { bg: "#e6dfd4", cyc: "#e6dfd4", level: 0.42, wallFill: 0.32 },
  "Soft gallery": { bg: "#eceae6", cyc: "#eceae6", level: 0.44, wallFill: 0.34 },
  "Deep charcoal": { bg: "#1c1d21", cyc: "#24262b", level: 0.24, wallFill: 0.22 },
  "Terracotta": { bg: "#4e221e", cyc: "#5b2722", level: 0.32, wallFill: 0.26 },
};

// Curated modern palettes (5 cohesive colorways per family, matching the reference sets).
const PALETTES = {
  Bauhaus: {
    // Exact reference palette: crisp warm white, burnt sienna, deep navy, mustard ochre, charcoal black, warm sand
    sets: [
      { base: "#f5f2eb", c1: "#a6301a", c2: "#1b3656", c3: "#d4901e", accent: "#1a1a1c", skin: "#ecc098", blush: "#d97868", wood: "#dfc7a3" },
      { base: "#f5f2eb", c1: "#d4901e", c2: "#1b3656", c3: "#cbbba4", accent: "#1a1a1c", skin: "#ecc098", blush: "#d97868", wood: "#dfc7a3" },
      { base: "#f5f2eb", c1: "#1a1a1c", c2: "#a6301a", c3: "#d4901e", accent: "#1a1a1c", skin: "#ecc098", blush: "#d97868", wood: "#dfc7a3" },
      { base: "#f5f2eb", c1: "#1b3656", c2: "#d4901e", c3: "#a6301a", accent: "#1a1a1c", skin: "#ecc098", blush: "#d97868", wood: "#dfc7a3" },
      { base: "#f5f2eb", c1: "#1b3656", c2: "#a6301a", c3: "#d4901e", accent: "#1a1a1c", skin: "#ecc098", blush: "#d97868", wood: "#dfc7a3" },
    ],
  },
  "Pastel Drip": {
    // Ref #2: glossy white porcelain + mint, emerald teal, blush pink, coral, lemon yellow (warm colored faces over white heads)
    sets: [
      { base: "#f5f4f0", c1: "#8ed3c7", c2: "#58b5a6", c3: "#cceae4", accent: "#3b5652", skin: "#efb892", blush: "#de7476", wood: "#e5d2b5" },
      { base: "#f5f4f0", c1: "#3ea88e", c2: "#2a7f6b", c3: "#8ed3c7", accent: "#274c43", skin: "#f0bc96", blush: "#de7476", wood: "#e5d2b5" },
      { base: "#f5f4f0", c1: "#e6a4a6", c2: "#cf7c82", c3: "#f5d6d6", accent: "#6d4042", skin: "#efb596", blush: "#d96c72", wood: "#e5d2b5" },
      { base: "#f5f4f0", c1: "#e26a46", c2: "#c24c2c", c3: "#f5b094", accent: "#5a2b1d", skin: "#f2c092", blush: "#dc766a", wood: "#e5d2b5" },
      { base: "#f5f4f0", c1: "#f4d742", c2: "#e0b41e", c3: "#faf0a5", accent: "#6b5a18", skin: "#efb996", blush: "#de7476", wood: "#e5d2b5" },
    ],
  },
  "Terracotta Folk": {
    // Ref #1: warm coral clay, apricot, cocoa umber, sage mist, dusty rose + gold leaf
    sets: [
      { base: "#d96c5b", c1: "#b23e2c", c2: "#e8a57a", c3: "#d8b058", accent: "#5a2b24", skin: "#f2ebe4", blush: "#d98e8c", wood: "#e1caa8" },
      { base: "#d6906a", c1: "#8f4e37", c2: "#f0c89c", c3: "#d8b058", accent: "#5a3a2e", skin: "#f2ebe4", blush: "#d68c84", wood: "#e1caa8" },
      { base: "#7e5e52", c1: "#4f3830", c2: "#c8804a", c3: "#d8b058", accent: "#3f2b25", skin: "#f2ebe4", blush: "#cf8f8e", wood: "#dfc7a5" },
      { base: "#b7bca9", c1: "#7d886c", c2: "#dce0cf", c3: "#d8b058", accent: "#5e6456", skin: "#f3eee8", blush: "#d8a09c", wood: "#e4cfb0" },
      { base: "#c88682", c1: "#8d4d4a", c2: "#ebd0cc", c3: "#d8b058", accent: "#543130", skin: "#f3eee8", blush: "#d47c7e", wood: "#e1caa8" },
    ],
  },
  "Studio Vivid": {
    // Ref #3 & #6: vibrant geometric mosaic & skyline hues (warm peach face contrasts cleanly over light upper bars/tiles)
    sets: [
      { base: "#f4efe6", c1: "#e86848", c2: "#95d4c4", c3: "#f4d448", accent: "#3a2528", skin: "#eebc94", blush: "#df7e82", wood: "#e2cba8" },
      { base: "#f4efe6", c1: "#d63228", c2: "#f08c68", c3: "#e8a8b2", accent: "#3a1a28", skin: "#eebc94", blush: "#df7e82", wood: "#e2cba8" },
      { base: "#f4efe6", c1: "#7e3a98", c2: "#c6589a", c3: "#d8a8dc", accent: "#2e163c", skin: "#eebc94", blush: "#df7e82", wood: "#e2cba8" },
      { base: "#f4efe6", c1: "#2585c4", c2: "#7ec8e3", c3: "#1c5a8c", accent: "#1b2852", skin: "#eebc94", blush: "#df7e82", wood: "#e2cba8" },
      { base: "#f4efe6", c1: "#f0b418", c2: "#f5dc4c", c3: "#e88424", accent: "#4a3210", skin: "#eebc94", blush: "#df7e82", wood: "#e2cba8" },
    ],
  },
  "Nordic Calm": {
    // Ref #5 & #7: marigold, tangerine, sky blue, aqua mint, cobalt (with raw birch)
    sets: [
      { base: "#f2eee6", c1: "#f2b818", c2: "#d49612", c3: "#d4b06a", accent: "#4e463e", skin: "#f4f1ec", blush: "#cf4c4a", wood: "#e4d2b4" },
      { base: "#f2eee6", c1: "#eb6e28", c2: "#c44e16", c3: "#d4b06a", accent: "#4e463e", skin: "#f4f1ec", blush: "#cf4c4a", wood: "#e4d2b4" },
      { base: "#f2eee6", c1: "#2498cc", c2: "#18729c", c3: "#d4b06a", accent: "#4e463e", skin: "#f4f1ec", blush: "#cf4c4a", wood: "#e4d2b4" },
      { base: "#f2eee6", c1: "#64c8d0", c2: "#3ea0a8", c3: "#d4b06a", accent: "#4e463e", skin: "#f4f1ec", blush: "#cf4c4a", wood: "#e4d2b4" },
      { base: "#f2eee6", c1: "#2c6ec4", c2: "#1c4a8c", c3: "#d4b06a", accent: "#4e463e", skin: "#f4f1ec", blush: "#cf4c4a", wood: "#e4d2b4" },
    ],
  },
  "Lacquer Jewel": {
    // Ref #8 & #9: deep navy, crimson, saffron, emerald, violet
    sets: [
      { base: "#d9b468", c1: "#c9242b", c2: "#1f54a8", c3: "#f2f0ea", accent: "#18181c", skin: "#e6cba8", blush: "#d88a84", wood: "#dfc6a0" },
      { base: "#6f2d94", c1: "#f2c116", c2: "#1e6ec4", c3: "#82ba28", accent: "#18181c", skin: "#e6cba8", blush: "#d88a84", wood: "#dfc6a0" },
      { base: "#1b2c68", c1: "#5ea8dc", c2: "#d8382c", c3: "#f0c824", accent: "#141828", skin: "#e6cba8", blush: "#d88a84", wood: "#dfc6a0" },
      { base: "#1d9c72", c1: "#4ed4c6", c2: "#f2d21e", c3: "#5c2a8c", accent: "#162824", skin: "#e6cba8", blush: "#d88a84", wood: "#dfc6a0" },
      { base: "#c9242b", c1: "#f2c116", c2: "#6f2d94", c3: "#4ed4c6", accent: "#18181c", skin: "#e6cba8", blush: "#d88a84", wood: "#dfc6a0" },
    ],
  },
  Monochrome: {
    // Glossy jet black & crisp porcelain white graphic lacquer family (colored face on white heads, light face on black heads)
    sets: [
      { base: "#f5f4f0", c1: "#141416", c2: "#f5f4f0", c3: "#2a2a2e", accent: "#121214", skin: "#e8b690", blush: "#d87a72", wood: "#e4d0b2" },
      { base: "#141416", c1: "#f5f4f0", c2: "#141416", c3: "#e8e6e0", accent: "#121214", skin: "#f6efe4", blush: "#e89a92", wood: "#e4d0b2" },
      { base: "#141416", c1: "#f5f4f0", c2: "#141416", c3: "#e8e6e0", accent: "#121214", skin: "#f6efe4", blush: "#e89a92", wood: "#e4d0b2" },
      { base: "#f5f4f0", c1: "#141416", c2: "#f5f4f0", c3: "#2a2a2e", accent: "#121214", skin: "#e8b690", blush: "#d87a72", wood: "#e4d0b2" },
      { base: "#f5f4f0", c1: "#141416", c2: "#f5f4f0", c3: "#2a2a2e", accent: "#121214", skin: "#e8b690", blush: "#d87a72", wood: "#e4d0b2" },
    ],
  },
  "Porcelain Shawl": {
    // Glossy white porcelain apron with colorful tulips under pastel hoods (pink, sky, sage, butter, lilac)
    sets: [
      { base: "#f7f5f0", c1: "#f09ea2", c2: "#d9362e", c3: "#5c9e58", accent: "#d96c38", skin: "#f6e2c8", blush: "#e68e8e", wood: "#e4d2b4" },
      { base: "#f7f5f0", c1: "#9cc4e2", c2: "#d9362e", c3: "#5c9e58", accent: "#d96c38", skin: "#f6e2c8", blush: "#e68e8e", wood: "#e4d2b4" },
      { base: "#f7f5f0", c1: "#9ec49c", c2: "#e05872", c3: "#4c8856", accent: "#c87438", skin: "#f6e2c8", blush: "#e68e8e", wood: "#e4d2b4" },
      { base: "#f7f5f0", c1: "#f2d67c", c2: "#d9362e", c3: "#5c9e58", accent: "#c86438", skin: "#f6e2c8", blush: "#e68e8e", wood: "#e4d2b4" },
      { base: "#f7f5f0", c1: "#c6b0dc", c2: "#e05872", c3: "#5c9e58", accent: "#c86c38", skin: "#f6e2c8", blush: "#e68e8e", wood: "#e4d2b4" },
    ],
  },
  "Crimson Babushka": {
    // High-gloss vermilion red hood & knotted scarf over crisp white, jet black, and deep oxblood bodies
    sets: [
      { base: "#f7f6f2", c1: "#d93224", c2: "#f7f6f2", c3: "#161618", accent: "#141416", skin: "#f7e6d8", blush: "#cc4238", wood: "#e2cca8" },
      { base: "#151518", c1: "#d93224", c2: "#151518", c3: "#f7f6f2", accent: "#141416", skin: "#f7e6d8", blush: "#cc4238", wood: "#e2cca8" },
      { base: "#8c1518", c1: "#eb4230", c2: "#8c1518", c3: "#f7f6f2", accent: "#141416", skin: "#f7e6d8", blush: "#cc4238", wood: "#e2cca8" },
      { base: "#f7f6f2", c1: "#18181c", c2: "#d93224", c3: "#f7f6f2", accent: "#141416", skin: "#f7e6d8", blush: "#cc4238", wood: "#e2cca8" },
      { base: "#151518", c1: "#f7f6f2", c2: "#d93224", c3: "#151518", accent: "#141416", skin: "#ecb692", blush: "#cc4238", wood: "#e2cca8" },
    ],
  },
  Balloon: {
    // Crisp glossy porcelain white with a single iconic floating balloon & wavy black string
    sets: [
      { base: "#f7f6f2", c1: "#d12622", c2: "#f7f6f2", c3: "#1c1c1e", accent: "#1a1a1c", skin: "#ecb892", blush: "#de7476", wood: "#e4d2b4" },
      { base: "#f7f6f2", c1: "#1d5bb8", c2: "#f7f6f2", c3: "#1c1c1e", accent: "#1a1a1c", skin: "#ecb892", blush: "#de7476", wood: "#e4d2b4" },
      { base: "#f7f6f2", c1: "#e8a818", c2: "#f7f6f2", c3: "#1c1c1e", accent: "#1a1a1c", skin: "#ecb892", blush: "#de7476", wood: "#e4d2b4" },
      { base: "#f7f6f2", c1: "#248f5a", c2: "#f7f6f2", c3: "#1c1c1e", accent: "#1a1a1c", skin: "#ecb892", blush: "#de7476", wood: "#e4d2b4" },
      { base: "#f7f6f2", c1: "#1a1a1d", c2: "#f7f6f2", c3: "#1c1c1e", accent: "#1a1a1c", skin: "#ecb892", blush: "#de7476", wood: "#e4d2b4" },
    ],
  },
  "Gel Overlap": {
    // Bold hood over translucent overlapping color-gel rounded rectangles (silkscreen/overprint aesthetic)
    sets: [
      { base: "#e6246e", c1: "#d61556", c2: "#50b8c8", c3: "#e8e01e", accent: "#1e1a22", skin: "#f7ebdc", blush: "#e87882", wood: "#e4d2b4" },
      { base: "#2858c8", c1: "#1c3c9c", c2: "#e86842", c3: "#58d4b4", accent: "#1e1a22", skin: "#f7ebdc", blush: "#e87882", wood: "#e4d2b4" },
      { base: "#1d9c82", c1: "#147864", c2: "#f08c28", c3: "#e8649c", accent: "#1e1a22", skin: "#f7ebdc", blush: "#e87882", wood: "#e4d2b4" },
      { base: "#e44c34", c1: "#c43222", c2: "#38b8cc", c3: "#f0d424", accent: "#1e1a22", skin: "#f7ebdc", blush: "#e87882", wood: "#e4d2b4" },
      { base: "#7e32a8", c1: "#5e1e84", c2: "#48c89c", c3: "#f0b824", accent: "#1e1a22", skin: "#f7ebdc", blush: "#e87882", wood: "#e4d2b4" },
    ],
  },
  "Modern Folk": {
    // Rich navy cloak + vermilion/coral hood + pink/gold petals over cream floral emblem apron
    sets: [
      { base: "#f7f3ea", c1: "#e63c24", c2: "#16233c", c3: "#e8a818", accent: "#161a24", skin: "#f7ece0", blush: "#e87872", wood: "#e2cca8" },
      { base: "#f7f3ea", c1: "#1e8c84", c2: "#1e2246", c3: "#f0a424", accent: "#181a28", skin: "#f7ece0", blush: "#e87872", wood: "#e2cca8" },
      { base: "#f7f3ea", c1: "#d42c6e", c2: "#261b42", c3: "#e8b422", accent: "#1c1628", skin: "#f7ece0", blush: "#e87872", wood: "#e2cca8" },
      { base: "#f7f3ea", c1: "#e09818", c2: "#182c4c", c3: "#e24228", accent: "#161c28", skin: "#f7ece0", blush: "#e87872", wood: "#e2cca8" },
      { base: "#f7f3ea", c1: "#248c58", c2: "#1c202c", c3: "#e89824", accent: "#161820", skin: "#f7ece0", blush: "#e87872", wood: "#e2cca8" },
    ],
  },
  "Scandi Emblem": {
    // Crisp editorial mid-century hood + cream buttoned chest with botanical sprigs + geometric color-block skirt
    sets: [
      { base: "#f6f2e8", c1: "#e83e22", c2: "#2c828c", c3: "#e4aa18", accent: "#161618", skin: "#f6ece0", blush: "#e64a32", wood: "#e2cca8" },
      { base: "#f6f2e8", c1: "#1c5ea8", c2: "#d85c38", c3: "#e8b424", accent: "#161618", skin: "#f6ece0", blush: "#e06458", wood: "#e2cca8" },
      { base: "#f6f2e8", c1: "#248464", c2: "#d64234", c3: "#ebb420", accent: "#161618", skin: "#f6ece0", blush: "#e26858", wood: "#e2cca8" },
      { base: "#f6f2e8", c1: "#d88e18", c2: "#225a94", c3: "#d94638", accent: "#161618", skin: "#f6ece0", blush: "#e26454", wood: "#e2cca8" },
      { base: "#f6f2e8", c1: "#9e2e68", c2: "#28848c", c3: "#e8aa1c", accent: "#161618", skin: "#f6ece0", blush: "#e06470", wood: "#e2cca8" },
    ],
  },
};

const PALETTE_NAMES = Object.keys(PALETTES);

// 15 curated Matryoshka families: a full family of 5 dolls shares one cohesive pattern, finish,
// and palette family while each sibling sports a distinct emoji-inspired face expression
// (Bauhaus keeps its signature Minimal face; Balloon is faceless so the balloon is the front icon).
const FAMILIES = [
  { name: "Bauhaus Ceramic", patternIdx: 0, finishIdx: 2, faceIdx: 8, shape: "Nordic", paletteName: "Bauhaus", gold: 0.3, backdrop: { bg: "#efe6d6", cyc: "#efe6d6", level: 0.43, wallFill: 0.33 } },
  { name: "Pastel Drip", patternIdx: 1, finishIdx: 1, faceIdx: -1, shape: "Pear", paletteName: "Pastel Drip", gold: 0.0, backdrop: { bg: "#dce8de", cyc: "#dce8de", level: 0.43, wallFill: 0.33 } },
  { name: "Terracotta Folk", patternIdx: 3, finishIdx: 0, faceIdx: -1, shape: "Classic", paletteName: "Terracotta Folk", gold: 1.0, backdrop: { bg: "#f2dfd0", cyc: "#f2dfd0", level: 0.44, wallFill: 0.33 } },
  { name: "Prism Mosaic", patternIdx: 2, finishIdx: 0, faceIdx: -1, shape: "Nordic", paletteName: "Studio Vivid", gold: 0.0, backdrop: { bg: "#e8c4b0", cyc: "#e8c4b0", level: 0.41, wallFill: 0.31 } },
  { name: "Dipped Studio", patternIdx: 5, finishIdx: 3, faceIdx: -1, shape: "Nordic", paletteName: "Nordic Calm", gold: 0.6, backdrop: { bg: "#f2ece0", cyc: "#f2ece0", level: 0.45, wallFill: 0.34 } },
  { name: "Jewel Patchwork", patternIdx: 7, finishIdx: 1, faceIdx: -1, shape: "Pear", paletteName: "Lacquer Jewel", gold: 0.0, backdrop: { bg: "#e5cfa0", cyc: "#e5cfa0", level: 0.42, wallFill: 0.31 } },
  { name: "City Skyline", patternIdx: 4, finishIdx: 1, faceIdx: -1, shape: "Nordic", paletteName: "Studio Vivid", gold: 0.0, backdrop: { bg: "#ece2d4", cyc: "#ece2d4", level: 0.43, wallFill: 0.32 } },
  { name: "Folk Graphic", patternIdx: 6, finishIdx: 1, faceIdx: -1, shape: "Classic", paletteName: "Lacquer Jewel", gold: 0.7, backdrop: { bg: "#d49b8a", cyc: "#d49b8a", level: 0.40, wallFill: 0.30 } },
  { name: "Monochrome Lacquer", patternIdx: 8, finishIdx: 1, faceIdx: -1, shape: "Pear", paletteName: "Monochrome", gold: 0.0, backdrop: { bg: "#d6c7b4", cyc: "#d6c7b4", level: 0.41, wallFill: 0.31 } },
  { name: "Porcelain Shawl", patternIdx: 9, finishIdx: 1, faceIdx: -1, shape: "Classic", paletteName: "Porcelain Shawl", gold: 0.0, backdrop: { bg: "#ebd6cf", cyc: "#ebd6cf", level: 0.43, wallFill: 0.32 } },
  { name: "Crimson Babushka", patternIdx: 10, finishIdx: 1, faceIdx: -1, shape: "Classic", paletteName: "Crimson Babushka", gold: 0.0, backdrop: { bg: "#ede2d2", cyc: "#ede2d2", level: 0.43, wallFill: 0.32 } },
  { name: "Balloon", patternIdx: 11, finishIdx: 1, faceIdx: 9, shape: "Pear", paletteName: "Balloon", gold: 0.0, backdrop: { bg: "#221f20", cyc: "#292527", level: 0.24, wallFill: 0.21 } },
  { name: "Gel Overlap", patternIdx: 12, finishIdx: 1, faceIdx: -1, shape: "Nordic", paletteName: "Gel Overlap", gold: 0.0, backdrop: { bg: "#eee0ea", cyc: "#eee0ea", level: 0.44, wallFill: 0.33 } },
  { name: "Modern Folk", patternIdx: 13, finishIdx: 1, faceIdx: -1, shape: "Classic", paletteName: "Modern Folk", gold: 0.0, backdrop: { bg: "#ebd8ae", cyc: "#ebd8ae", level: 0.43, wallFill: 0.32 } },
  { name: "Scandi Emblem", patternIdx: 14, finishIdx: 2, faceIdx: -1, shape: "Pear", paletteName: "Scandi Emblem", gold: 0.0, backdrop: { bg: "#b8cfc8", cyc: "#b8cfc8", level: 0.41, wallFill: 0.31 } },
];

// Deterministic hash in [0, 1) for (seed, gen, salt)
function hashGen(seed, gen, salt = 0) {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(gen | 0, 668265263) + Math.imul(salt | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Deterministic permutation of FAMILIES for a given (seed, cycle) so every family plays in full
// before repeating, and consecutive cycles never start with the same family they ended on.
// A fixed order of FAMILIES indices (for videos), or null for the seeded shuffle.
let familyOrder = null;
function setFamilyOrder(order) {
  familyOrder = order?.length ? order : null;
}

function getFamilyForIndex(familyIndex, seed) {
  const n = FAMILIES.length;
  const cycle = Math.floor(familyIndex / n);
  const pos = ((familyIndex % n) + n) % n;
  if (familyOrder) return FAMILIES[familyOrder[((familyIndex % familyOrder.length) + familyOrder.length) % familyOrder.length]];

  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(hashGen(seed, cycle, 500 + i) * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return FAMILIES[order[pos]];
}

// Build a deterministic doll design spec for generation `gen`.
// Generations are grouped into cohesive families of `FAMILY_SIZE` (5) dolls:
// members 0..4 share the same family pattern, finish, face style, and palette family,
// then member 0 of the next family opens cleanly inside member 4 of the previous family.
function getDollSpec(gen, seed, opts) {
  const { patternMode, finishMode, paletteMode, faceMode, shapeMode, mixFamilies } = opts;

  // mixFamilies: every doll from its own family (a shuffled run through all of them), as a random sibling.
  const familyIndex = mixFamilies ? gen : Math.floor(gen / FAMILY_SIZE);
  const memberIndex = mixFamilies
    ? Math.floor(hashGen(seed, gen, 71) * FAMILY_SIZE)
    : ((gen % FAMILY_SIZE) + FAMILY_SIZE) % FAMILY_SIZE;
  const cycle = Math.abs(Math.floor(familyIndex / FAMILIES.length));
  const family = getFamilyForIndex(familyIndex, seed);

  const paletteName = paletteMode === "Family" ? family.paletteName : paletteMode;
  const pal = PALETTES[paletteName] || PALETTES.Bauhaus;
  // Permute sibling colorway order on Cycle >= 1 (except Bauhaus/Monochrome whose 5 siblings are paired with fixed compositions)
  const colorIdx =
    cycle > 0 && family.patternIdx !== 0 && family.patternIdx !== 8
      ? (memberIndex + Math.floor(hashGen(seed, familyIndex, 43) * pal.sets.length)) % pal.sets.length
      : memberIndex % pal.sets.length;
  const colors = pal.sets[colorIdx];

  const patternIdx = patternMode === "Family" ? family.patternIdx : Math.max(0, PATTERNS.indexOf(patternMode));
  // Subtle finish variation on Cycle >= 1 (preserving Raw & Dipped on Dipped Studio and Glossy Lacquer on Balloon/Monochrome)
  let finishIdx;
  if (finishMode === "Family") {
    if (cycle > 0 && family.patternIdx !== 5 && family.patternIdx !== 8 && family.patternIdx !== 11) {
      const altFinishes = [0, 1, 2]; // Matte Wood, Glossy Lacquer, Glazed Ceramic
      const pick = Math.floor(hashGen(seed, familyIndex, 61) * altFinishes.length);
      finishIdx = altFinishes[(altFinishes.indexOf(family.finishIdx) + cycle + pick) % altFinishes.length];
    } else {
      finishIdx = family.finishIdx;
    }
  } else {
    finishIdx = Math.max(0, FINISHES.indexOf(finishMode));
  }

  // Rotate silhouette across Nordic / Classic / Pear on Cycle >= 1
  let shape;
  if (!shapeMode || shapeMode === "Family") {
    if (cycle > 0) {
      const baseShapeIdx = Math.max(0, SHAPE_LIST.indexOf(family.shape));
      const rot = cycle + Math.floor(hashGen(seed, familyIndex, 31) * 2);
      shape = SHAPE_LIST[(baseShapeIdx + rot) % SHAPE_LIST.length];
    } else {
      shape = family.shape;
    }
  } else {
    shape = shapeMode;
  }

  // In Family mode, each sibling gets a distinct emoji expression (0..7) unless the family locks Minimal (Bauhaus) or None (Balloon)
  let faceIdx;
  if (faceMode === "Family") {
    if (family.faceIdx >= 0) {
      faceIdx = family.faceIdx;
    } else {
      const startExpr = Math.floor(hashGen(seed, familyIndex, 77) * 8);
      faceIdx = (startExpr + memberIndex) % 8;
    }
  } else {
    faceIdx = Math.max(0, FACES.indexOf(faceMode));
  }

  // Keep family-level style variant cohesive while giving each sibling distinct index in [0, 1)
  const variant =
    family.patternIdx === 0 || family.patternIdx === 8
      ? (memberIndex + 0.5) / FAMILY_SIZE // Bauhaus & Monochrome: exact 5 distinct sibling compositions
      : (hashGen(seed, familyIndex, 13) * 0.35 + (memberIndex / FAMILY_SIZE) * 0.65) % 1;
  const phase = (hashGen(seed, familyIndex, 17) + memberIndex * 0.27) * Math.PI * 2;
  const goldAmount =
    patternIdx === 3 ? 1.0 : finishIdx === 4 ? 1.0 : family.gold;

  // On Cycle >= 1, apply a cohesive golden-ratio hue shift to chromatic paint colors (preserving whites, blacks, and face contrast)
  const doHueShift = cycle > 0 && paletteMode === "Family" && family.patternIdx !== 8;
  const hueShift = doHueShift
    ? (cycle * 0.381966 + hashGen(seed, familyIndex, 91) * 0.18) % 1
    : 0;
  const satShift = doHueShift ? (hashGen(seed, familyIndex, 97) - 0.5) * 0.10 : 0;
  const litShift = doHueShift ? (hashGen(seed, familyIndex, 101) - 0.5) * 0.06 : 0;

  return {
    gen,
    familyIndex,
    memberIndex,
    familyName: family.name,
    backdrop: getBackdropForFamily(familyIndex, seed),
    patternIdx,
    finishIdx,
    faceIdx,
    shape,
    variant,
    phase,
    goldAmount,
    colors: {
      base: doHueShift ? shiftChromatic(colors.base, hueShift, satShift, litShift) : new Color(colors.base),
      c1: doHueShift ? shiftChromatic(colors.c1, hueShift, satShift, litShift) : new Color(colors.c1),
      c2: doHueShift ? shiftChromatic(colors.c2, hueShift, satShift, litShift) : new Color(colors.c2),
      c3: doHueShift ? shiftChromatic(colors.c3, hueShift, satShift, litShift) : new Color(colors.c3),
      accent: new Color(colors.accent),
      skin: new Color(colors.skin),
      blush: new Color(colors.blush),
      wood: new Color(colors.wood),
    },
  };
}

export {
  FAMILY_SIZE,
  FAMILIES,
  PATTERNS,
  FINISHES,
  FACES,
  BACKDROPS,
  PALETTES,
  PALETTE_NAMES,
  getDollSpec,
  getFamilyForIndex,
  setFamilyOrder,
  getBackdropForFamily,
  hashGen,
};
