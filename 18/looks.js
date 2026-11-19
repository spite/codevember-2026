import { Color } from "three";
import { plasterMaterial, glazeMaterial, metalMaterial, stoneMaterial, brassMaterial } from "./materials.js";

// Looks: a finish (pastel clay, one colour throughout, or stone and brass) and its colours for the studio, the
// plates and cradle, the turning parts, the bob, its rod and the gold marks of the grand alignment.
const LOOKS = {
  peach: { finish: "clay", backdrop: 0xe6c9b8, slab: 0xf3e3d6, slab2: 0xefdacb, cradle: 0xecd5c5, disc: 0xe2876b, disc2: 0xeca58b, bob: 0xfaf4ec, rod: 0xd2ccc5 },
  mint: { finish: "clay", backdrop: 0xc6dacd, slab: 0xedf2ec, slab2: 0xe2ebe3, cradle: 0xdfe9e0, disc: 0x63ad93, disc2: 0x93c7b1, bob: 0xfbfaf5, rod: 0xc9cdca },
  lilac: { finish: "clay", backdrop: 0xd5cde2, slab: 0xf0ecf4, slab2: 0xe7e1ee, cradle: 0xe4ddec, disc: 0x9a83c8, disc2: 0xb8a6da, bob: 0xfbf9fb, rod: 0xcdcad2 },
  butter: { finish: "clay", backdrop: 0xe8d8b2, slab: 0xf6efdc, slab2: 0xf1e7cf, cradle: 0xefe3c8, disc: 0xe2ad35, disc2: 0xeac46b, bob: 0xfcf8ee, rod: 0xd1cbbd, accent: 0xc2532e },
  sky: { finish: "clay", backdrop: 0xc5d6e5, slab: 0xedf2f7, slab2: 0xe2eaf2, cradle: 0xdfe8f0, disc: 0x5b8fc2, disc2: 0x8fb3d8, bob: 0xfafbfc, rod: 0xc8ccd2 },
  rose: { finish: "clay", backdrop: 0xe6c8d0, slab: 0xf6e9ec, slab2: 0xf0dfe3, cradle: 0xeedbe0, disc: 0xcf6784, disc2: 0xe096aa, bob: 0xfcf7f8, rod: 0xd3cbcd },
  sage: { finish: "clay", backdrop: 0xd2d6c2, slab: 0xf1f2ea, slab2: 0xe8eadd, cradle: 0xe6e8da, disc: 0x8a9a5b, disc2: 0xb2bd8c, bob: 0xfbfbf6, rod: 0xcbcbc4 },
  terracotta: { finish: "mono", backdrop: 0xc98466, slab: 0xd2896a, slab2: 0xcd8364, cradle: 0xcb8263, disc: 0xc57a5c, disc2: 0xd08c6e, bob: 0xdb9a7d, rod: 0xc9b9b0, accent: 0xf3e2c8 },
  olive: { finish: "mono", backdrop: 0x9aa07a, slab: 0xa6ac85, slab2: 0xa0a67f, cradle: 0x9ea47d, disc: 0x949a73, disc2: 0xabb18a, bob: 0xb8bd98, rod: 0xc2c4b8, accent: 0xf0ead2 },
  chalk: { finish: "mono", backdrop: 0xdfdcd6, slab: 0xf4f2ee, slab2: 0xeeebe6, cradle: 0xebe8e3, disc: 0xe6e3dd, disc2: 0xf0ede8, bob: 0xfbfaf8, rod: 0xcfccc7 },
  cobalt: { finish: "mono", backdrop: 0x4f6fa8, slab: 0x5b7cb6, slab2: 0x5676b0, cradle: 0x5474ae, disc: 0x4c6ba4, disc2: 0x6584bd, bob: 0x7591c6, rod: 0xc5ccd8, accent: 0xf3e6c4 },
  graphite: { finish: "mono", backdrop: 0x55585c, slab: 0x606367, slab2: 0x5b5e62, cradle: 0x595c60, disc: 0x54575b, disc2: 0x676a6e, bob: 0x75787c, rod: 0xb9bcc0 },
  travertine: { finish: "stone", stone: "travertine", backdrop: 0x9c968d, slab: 0xd8ccb6, slab2: 0xd2c5ad, cradle: 0xcfc1a8, vein: 0x8f8270, disc: 0xc59d57, disc2: 0xb98f4b, bob: 0xd7b06a, rod: 0xc9c6c0, accent: 0x2c2a28 },
  carrara: { finish: "stone", stone: "marble", backdrop: 0x5d5b58, slab: 0xefebe5, slab2: 0xe9e4dd, cradle: 0xe6e1d9, vein: 0x77726c, disc: 0xc59d57, disc2: 0xba914d, bob: 0xd7b06a, rod: 0xc9c6c0, accent: 0x2c2a28 },
  nero: { finish: "stone", stone: "marble", backdrop: 0xbab3a8, slab: 0x2e2d2c, slab2: 0x343331, cradle: 0x2b2a29, vein: 0xd6d0c6, disc: 0xc59d57, disc2: 0xb98f4b, bob: 0xdcdad6, rod: 0xc9c6c0, accent: 0xe8e2d6 },
  verde: { finish: "stone", stone: "marble", backdrop: 0xa9aaa2, slab: 0x3f5a4c, slab2: 0x456253, cradle: 0x3b5548, vein: 0xc9d1c4, disc: 0xc59d57, disc2: 0xb98f4b, bob: 0xd7b06a, rod: 0xc9c6c0, accent: 0xe8e2d6 },
};

const FINISHES = ["clay", "mono", "stone"];
const ROLES = ["slab", "slab2", "cradle", "disc", "disc2", "bob", "bob2", "rod", "accent"];
const GOLD = 0xe0a23a;

// One material set per finish (and stone), made once; a look's colours go on when it comes on stage.
const sets = new Map();
function materialsFor(look) {
  const key = look.finish === "stone" ? `stone-${look.stone}` : look.finish;
  if (!sets.has(key)) {
    const white = 0xffffff;
    if (look.finish === "stone") {
      const stone = (roughness) => stoneMaterial({ color: white, kind: look.stone, roughness, vein: look.vein });
      sets.set(key, {
        slab: stone(0.28),
        slab2: stone(0.28),
        cradle: stone(0.32),
        disc: brassMaterial({ color: white, roughness: 0.3 }),
        disc2: brassMaterial({ color: white, roughness: 0.36 }),
        bob: metalMaterial({ color: white, roughness: 0.14 }),
        bob2: metalMaterial({ color: white, roughness: 0.18 }),
        rod: metalMaterial({ color: white, roughness: 0.25 }),
        accent: glazeMaterial({ color: white, roughness: 0.3 }),
      });
    } else {
      sets.set(key, {
        slab: plasterMaterial({ color: white, roughness: 0.8 }),
        slab2: plasterMaterial({ color: white, roughness: 0.8 }),
        cradle: plasterMaterial({ color: white, roughness: 0.84 }),
        disc: plasterMaterial({ color: white, roughness: 0.7 }),
        disc2: plasterMaterial({ color: white, roughness: 0.7 }),
        bob: glazeMaterial({ color: white }),
        bob2: glazeMaterial({ color: white, roughness: 0.14 }),
        rod: metalMaterial({ color: white, roughness: 0.28 }),
        accent: glazeMaterial({ color: white, roughness: 0.25 }),
      });
    }
  }
  return sets.get(key);
}

function colour(look, role) {
  if (role === "bob2") return look.finish === "stone" ? look.bob : look.disc;
  if (role === "accent") return look.accent ?? GOLD;
  return look[role];
}

// A look's colours on its materials.
function dress(look) {
  const m = materialsFor(look);
  for (const role of ROLES) m[role].color.setHex(colour(look, role));
  if (m.slab.uniforms.veinColor) for (const role of ["slab", "slab2", "cradle"]) m[role].uniforms.veinColor.value.setHex(look.vein);
  return m;
}

const _a = new Color();
const _b = new Color();
// The studio partway (t) from one look to the next.
function blendStudio(from, to, t, { backdrop, pipeline }) {
  _a.setHex(from.backdrop).lerp(_b.setHex(to.backdrop), t);
  backdrop.material.color.copy(_a);
  pipeline.background.copy(_a);
}

export { LOOKS, FINISHES, materialsFor, dress, blendStudio };
