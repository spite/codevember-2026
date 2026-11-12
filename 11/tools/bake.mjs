// Bakes the corrosion patterns: node 11/tools/bake.mjs (writes 11/corrosion.bin).
import { writeFileSync } from "node:fs";
import { bakeCorrosion } from "../corrosion.js";

writeFileSync(new URL("../corrosion.bin", import.meta.url), bakeCorrosion());
