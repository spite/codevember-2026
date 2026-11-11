// A seamless studio bowl: a floor sweeping up into a wall all round, so it stays behind the piece from any side.
// Matte, in the metal's backdrop colour; it takes the piece's soft shadow and contact occlusion but casts none.
import { Mesh, Vector2, LatheGeometry, Color } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const FLOOR = 3.2;
const ARC = 2.2;
const WALL = 12;

function bowlGeometry() {
  const points = [];
  for (let i = 0; i <= 24; i++) points.push(new Vector2((FLOOR * i) / 24, 0));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 0.5;
    points.push(new Vector2(FLOOR + ARC * Math.sin(a), ARC * (1 - Math.cos(a))));
  }
  for (let i = 1; i <= 6; i++) points.push(new Vector2(FLOOR + ARC, ARC + (i * WALL) / 6));
  return new LatheGeometry(points, 160);
}

export function createBackdrop() {
  const material = new PipelineMaterial({ color: 0x808080, roughness: 0.92, metalness: 0 });
  const mesh = new Mesh(bowlGeometry(), material);
  // Seen from inside: the lathe's faces point out.
  material.side = 1;
  mesh.userData.noShadow = true;
  mesh.userData.noWireframe = true;
  const target = new Color();
  let floorY = null;
  return {
    mesh,
    material,
    // The floor this far below the piece's lowest point; it glides there (update) rather than jumping with each piece.
    place(bottom, gap = 0.45) {
      // The first piece sets it outright.
      if (floorY === null) mesh.position.y = bottom - gap;
      floorY = bottom - gap;
    },
    // Eases toward the backdrop colour of the metal (sRGB hex), dimmed so the lit floor reads as that colour.
    setColor(hex, amount = 0.72) {
      target.set(hex).multiplyScalar(amount);
    },
    update(dt) {
      material.color.lerp(target, Math.min(1, dt * 3));
      if (floorY !== null) mesh.position.y += (floorY - mesh.position.y) * (1 - Math.exp(-dt * 2.5));
    },
    snap() {
      material.color.copy(target);
      if (floorY !== null) mesh.position.y = floorY;
    },
  };
}
