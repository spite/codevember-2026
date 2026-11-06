// The prompt for every day, and which days are up. A day's title is its prompt once it is in
// `published`; until then it shows as "soon" in the gallery and isn't linked from the nav.
const prompts = [
  "Fold",
  "Shatter",
  "Melt",
  "Tangle",
  "Moss",
  "Orrery",
  "Hollow",
  "Tesseract",
  "Membrane",
  "Caustic",
  "Rust",
  "Feather",
  "Labyrinth",
  "Tension",
  "Mirage",
  "Spore",
  "Kelp",
  "Pendulum",
  "Erosion",
  "Cocoon",
  "Bolt",
  "Echo",
  "Magma",
  "Nest",
  "Veil",
  "Anamorph",
  "Burrow",
  "Hive",
  "Portal",
  "Dissolve",
];

const published = [1, 2, 3, 4, 5];

const days = prompts.map((prompt, i) => ({
  day: i + 1,
  prompt,
  title: published.includes(i + 1) ? prompt : "",
}));

const year = 2026;
const event = "Codevember";

export { days, year, event };
