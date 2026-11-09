// Builds named solids off the main thread: the larger ones take up to a fifth of a second the first time.
import { getSolid } from "../modules/polyhedra/solids.js";

onmessage = ({ data: names }) => {
  for (const name of names) {
    const { vertices, faces } = getSolid(name);
    postMessage({ name, vertices, faces });
  }
};
