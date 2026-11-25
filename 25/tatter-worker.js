// Makes a tattered veil's maps (tatter.js) off the main thread and apart from the cloth's own worker, so they can be
// made while the cloth is still moving (the old veil blowing away).
const module = import(`./tatter.js${self.location.search}`);

onmessage = async ({ data }) => {
  const { createTatterData } = await module;
  const maps = createTatterData(data.seed);
  postMessage({ seed: data.seed, ...maps }, [maps.outline.buffer, maps.dirt.buffer]);
};
