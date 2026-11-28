// Builds a forest's geometry (and a coarser copy for the shadow map) and its physics layout off the main thread.
import { buildKelpForestGeometry } from "./kelpBuilder.js";

onmessage = ({ data }) => {
  try {
    build(data);
  } catch (error) {
    // Answered either way, so the page never waits on a forest that failed.
    postMessage({ id: data.id, error: String(error?.stack ?? error) });
  }
};

function build(data) {
  const forest = buildKelpForestGeometry(data);
  const shadow = buildKelpForestGeometry({ ...data, detail: data.shadowDetail, shadow: true });
  const buffers = [
    ...Object.values(forest.attributes),
    forest.index,
    forest.columns,
    forest.blades,
    ...Object.values(shadow.attributes),
    shadow.index,
  ].map((a) => a.buffer);
  postMessage({ id: data.id, ...forest, shadow: { attributes: shadow.attributes, index: shadow.index } }, buffers);
}
