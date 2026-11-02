// One entry per day; a day with an empty title shows as "soon" in the gallery.
const days = Array.from({ length: 30 }, (_, i) => ({
  day: i + 1,
  title: ["Folded"][i] ?? "",
}));

const year = 2026;
const event = "Codevember";

export { days, year, event };
