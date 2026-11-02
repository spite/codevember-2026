import { MeshBasicMaterial } from "three";

const skipMaterial = new MeshBasicMaterial({ visible: false });

function pick(material, variant) {
  if (!material?.isPipelineMaterial) return null;
  if (variant === "prepass" && material.transparent) return null;
  return material.getVariant(variant);
}

const swapped = [];

// Swaps PipelineMaterial objects to `variant` ("prepass" | "shadow"), renders, restores.
// Objects whose material isn't a PipelineMaterial are hidden during variant passes (children still render).
// filter(object) → false skips (e.g. object.userData.noShadow for "shadow", transparent for "prepass").
export function renderVariant(renderer, scene, camera, variant, target, filter) {
  swapped.length = 0;
  scene.traverseVisible((object) => {
    const material = object.material;
    if (!material) return;
    let next = null;
    if (!filter || filter(object)) {
      if (Array.isArray(material)) {
        const list = material.map((m) => pick(m, variant));
        next = list.some(Boolean) ? list.map((m) => m ?? skipMaterial) : null;
      } else {
        next = pick(material, variant);
      }
    }
    swapped.push(object, material);
    object.material = next ?? skipMaterial;
  });

  const background = scene.background;
  const overrideMaterial = scene.overrideMaterial;
  scene.background = null;
  scene.overrideMaterial = null;
  try {
    if (target !== undefined) renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    scene.background = background;
    scene.overrideMaterial = overrideMaterial;
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
    swapped.length = 0;
  }
}

// renderer.compileAsync for the `variant` materials renderVariant would draw (hidden objects included).
export function compileVariant(renderer, scene, camera, variant, filter) {
  const restore = [];
  scene.traverse((object) => {
    const material = object.material;
    if (!material) return;
    let next = null;
    if (!filter || filter(object)) {
      if (Array.isArray(material)) {
        const list = material.map((m) => pick(m, variant)).filter(Boolean);
        next = list.length ? list : null;
      } else {
        next = pick(material, variant);
      }
    }
    restore.push(object, material);
    // compile() skips objects without a material, so nothing is built for skipMaterial.
    object.material = next;
  });
  try {
    return renderer.compileAsync(scene, camera);
  } finally {
    for (let i = 0; i < restore.length; i += 2) restore[i].material = restore[i + 1];
  }
}
