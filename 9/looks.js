// Looks drawn from the references: backdrop, resin, jelly colours and floaters.
const LOOKS = {
  ruby: {
    backdrop: "#cdc8c3",
    resin: { color: "#f6d4d0", density: 0.3, frost: 0.1, haze: 0.8, hazeColor: "#f0b8b0", rough: 0.32, dispersion: 0.012 },
    jelly: { colors: ["#9e1020", "#c8243a", "#d63a4e", "#7a0c22"], density: 4, milk: 1.4, frost: 0.08, rough: 0.12, glow: 0.35 },
    floaters: { core: ["#3a0509", "#52070f"], beads: ["#f2ece6", "#1a0a0b", "#e8b0a8"] },
  },
  blush: {
    backdrop: "#efcfd2",
    resin: { color: "#ffffff", density: 0, frost: 0.1, haze: 1.0, hazeColor: "#ffe6ee", rough: 0.4, dispersion: 0.03 },
    jelly: { colors: ["#c43c7c", "#f27a6c", "#8a46b0", "#f5a3b8"], density: 1.6, milk: 1.6, frost: 0.1, rough: 0.2, glow: 0.5 },
    floaters: { core: ["#5a1a4a", "#f7d4dc"], beads: ["#ffffff", "#f2b0c0", "#6a2a6a"] },
  },
  pebbles: {
    backdrop: "#d4d3cf",
    resin: { color: "#f4f6f4", density: 0.05, frost: 0.12, haze: 0.2, hazeColor: "#eef2f0", rough: 0.18, dispersion: 0.02 },
    jelly: { colors: ["#f0eee8", "#d8dcd8", "#e8e2d8"], density: 0.3, milk: 0.04, frost: 0.04, rough: 0.06, glow: 0.05 },
    // Clear jelly shows its floaters or nothing: mostly dark, so they read through the frost.
    floaters: { core: ["#1c1414", "#3a2c26"], beads: ["#1c1414", "#2a1f1f", "#5a4a42", "#1c1414", "#f6f4f0"] },
  },
  peach: {
    backdrop: "#f1dccd",
    resin: { color: "#fff4ec", density: 0.08, frost: 0.12, haze: 0.9, hazeColor: "#fbe2d2", rough: 0.38, dispersion: 0.015 },
    jelly: { colors: ["#f29a3a", "#e8606a", "#b45a8c", "#ffc06a"], density: 1.5, milk: 1.5, frost: 0.08, rough: 0.25, glow: 0.6 },
    floaters: { core: ["#8a2a4a", "#ffe0c0"], beads: ["#fff2e4", "#c0406a", "#ffb060"] },
  },
  mint: {
    backdrop: "#d3e6dd",
    resin: { color: "#f2fbf6", density: 0.05, frost: 0.1, haze: 0.8, hazeColor: "#d8f2e6", rough: 0.35, dispersion: 0.02 },
    jelly: { colors: ["#3fae8e", "#7dd3b4", "#1f8a7a", "#a8e6c8"], density: 2.4, milk: 1.4, frost: 0.08, rough: 0.18, glow: 0.5 },
    floaters: { core: ["#0f4a40", "#fff1e0"], beads: ["#fffaf0", "#ff8a70", "#0f4a40"] },
  },
  lilac: {
    backdrop: "#dcd6e6",
    resin: { color: "#f8f4ff", density: 0.05, frost: 0.1, haze: 0.9, hazeColor: "#e8def8", rough: 0.35, dispersion: 0.025 },
    jelly: { colors: ["#9a78d8", "#c3a8ee", "#6e4ab8", "#e0c8f4"], density: 2.2, milk: 1.5, frost: 0.09, rough: 0.2, glow: 0.5 },
    floaters: { core: ["#3a1a5a", "#fff4e6"], beads: ["#fffaf2", "#4a2266", "#f0b8d8"] },
  },
  tide: {
    backdrop: "#d8d1c7",
    resin: { color: "#f4f7fa", density: 0.05, frost: 0.1, haze: 0.6, hazeColor: "#dde6ef", rough: 0.35, dispersion: 0.02 },
    // Blues, with one muted amber to answer them.
    jelly: { colors: ["#4d6f9e", "#7f9bc2", "#2f4c74", "#a8bdd6", "#d0874a"], density: 3.6, milk: 1.0, frost: 0.08, rough: 0.2, glow: 0.45 },
    floaters: { core: ["#1c2a44", "#f2ece2", "#c47a36"], beads: ["#f4efe6", "#b0694e", "#1c2a44", "#e0a060"] },
  },
};

// Light colours: the key light and the studio's ambient fill, as tints over the neutral studio.
const LIGHTS = {
  neutral: { key: "#ffffff", fill: "#ffffff" },
  warm: { key: "#ffd2a0", fill: "#c6d8ff" },
  golden: { key: "#ffc07a", fill: "#ffe0c4" },
  daylight: { key: "#dce8ff", fill: "#c8dbff" },
  rose: { key: "#ffbccd", fill: "#e6ccff" },
  teal: { key: "#a6f2e2", fill: "#bfeee6" },
  dusk: { key: "#ff9a7a", fill: "#a0aeff" },
};

export { LOOKS, LIGHTS };
