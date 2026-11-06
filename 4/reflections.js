import { FloatType, PMREMGenerator } from "three";
import { computeSH, dominantDirection } from "modules/pipeline/studio.js";

const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const azimuth = (v) => Math.atan2(v.z, v.x);

// An HDR for reflections only: turned so its brightest light sits at the key's azimuth,
// and scaled to the brightness of the env it replaces. Resolves to { envMap, maxLod }.
async function loadReflections(renderer, url, { keyDirection, match }) {
  const { HDRLoader } = await import("three/addons/loaders/HDRLoader.js");
  const texture = await new HDRLoader().setDataType(FloatType).loadAsync(url);
  const { width: W, height: H, data } = texture.image;
  const C = data.length / (W * H);
  const source = data.slice();
  const pmrem = new PMREMGenerator(renderer);
  let target = null;

  const build = (shift, gain) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const from = (y * W + ((((x - shift) % W) + W) % W)) * C;
        const to = (y * W + x) * C;
        for (let c = 0; c < 3; c++) data[to + c] = source[from + c] * gain;
      }
    texture.needsUpdate = true;
    target?.dispose();
    target = pmrem.fromEquirectangular(texture);
    return computeSH(renderer, target.texture);
  };

  let sh = build(0, 1);
  const gain = lum(computeSH(renderer, match)[0]) / Math.max(lum(sh[0]), 1e-6);
  const goal = azimuth(keyDirection);
  const error = wrap(goal - azimuth(dominantDirection(sh)));
  // Which way a column shift turns the map depends on the cube convention, so try both.
  let best = null;
  let current = 0;
  for (const sign of [1, -1]) {
    current = Math.round(((sign * error) / (2 * Math.PI)) * W);
    sh = build(current, gain);
    const left = Math.abs(wrap(goal - azimuth(dominantDirection(sh))));
    if (!best || left < best.left) best = { shift: current, left };
    if (left < 0.2) break;
  }
  if (current !== best.shift) build(best.shift, gain);

  pmrem.dispose();
  texture.dispose();
  return { envMap: target.texture, maxLod: Math.max(target.texture.mipmaps.length - 1, 0) };
}

export { loadReflections };
