// Seeded PRNG that replaces Math.random, so Maf, gui.js and three all follow the seed.

const nativeRandom = Math.random;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

let seed;

function setSeed(s) {
  seed = String(s);
  Math.random = mulberry32(hash(seed));
  return seed;
}

function getSeed() {
  return seed;
}

function newSeed() {
  const s = Math.floor(nativeRandom() * 0xffffffff).toString(36);
  const url = new URL(window.location.href);
  url.searchParams.set("seed", s);
  history.replaceState(null, "", url);
  return setSeed(s);
}

const urlSeed = new URLSearchParams(window.location.search).get("seed");
if (urlSeed) {
  setSeed(urlSeed);
} else {
  setSeed(Math.floor(nativeRandom() * 0xffffffff).toString(36));
}

export { setSeed, getSeed, newSeed, nativeRandom, urlSeed };
