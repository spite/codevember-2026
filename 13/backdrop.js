import { Mesh, Vector2, LatheGeometry, Color, BackSide } from "three";
import { PipelineMaterial } from "modules/pipeline/PipelineMaterial.js";

const FLOOR_RADIUS = 3.4;
const ARC_RADIUS = 2.4;
const WALL_HEIGHT = 12;

function createBowlGeometry() {
  const points = [];
  for (let i = 0; i <= 14; i++) {
    points.push(new Vector2((FLOOR_RADIUS * i) / 14, 0));
  }
  for (let i = 1; i <= 20; i++) {
    const angle = (i / 20) * Math.PI * 0.5;
    points.push(new Vector2(FLOOR_RADIUS + ARC_RADIUS * Math.sin(angle), ARC_RADIUS * (1 - Math.cos(angle))));
  }
  for (let i = 1; i <= 4; i++) {
    points.push(new Vector2(FLOOR_RADIUS + ARC_RADIUS, ARC_RADIUS + (i * WALL_HEIGHT) / 4));
  }
  return new LatheGeometry(points, 72);
}

export function createBackdrop() {
  const material = new PipelineMaterial({ color: 0x6e6862, roughness: 0.92, metalness: 0 });
  const mesh = new Mesh(createBowlGeometry(), material);
  material.side = BackSide;
  // Render after the opaque labyrinth so hardware depth-testing skips hidden backdrop pixels.
  mesh.renderOrder = 1;
  mesh.userData.noShadow = true;
  mesh.userData.noWireframe = true;

  const targetColor = new Color();
  let targetFloorY = null;

  return {
    mesh,
    material,
    place(bottom, gap = 0.48) {
      if (targetFloorY === null) mesh.position.y = bottom - gap;
      targetFloorY = bottom - gap;
    },
    setColor(hex, amount = 0.72) {
      targetColor.set(hex).multiplyScalar(amount);
    },
    update(dt) {
      material.color.lerp(targetColor, Math.min(1, dt * 3.5));
      if (targetFloorY !== null) {
        mesh.position.y += (targetFloorY - mesh.position.y) * (1 - Math.exp(-dt * 3));
      }
    },
    snap() {
      material.color.copy(targetColor);
      if (targetFloorY !== null) mesh.position.y = targetFloorY;
    },
  };
}
