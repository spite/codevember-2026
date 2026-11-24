import { Vector2, LatheGeometry, BufferAttribute } from "three";

const DOLL_HEIGHT = 2.2;
const CENTER_Y = DOLL_HEIGHT * 0.48; // Center origin inside the hollow belly for 3D tumbling nesting
const SPLIT_H = 0.43;
const SPLIT_Y = DOLL_HEIGHT * SPLIT_H;
const WALL_THICKNESS = 0.056;
const LIP_STEP = 0.026;
const LIP_HEIGHT = 0.088;
const BASE_THICKNESS = 0.075;

const SHAPES = ["Nordic", "Classic", "Pear"];

// Smooth C-infinity analytical lathe profiles r(h) for h in [0, 1].
// Single unified curve per silhouette (no piecewise stitches or slope kinks),
// closing smoothly into a hemispherical/ellipsoidal dome at h = 1.
function profileRadius(h, shape = "Nordic") {
  const t = Math.max(0, Math.min(1, h));
  const t2 = t * t;
  const t4 = t2 * t2;
  const dome = Math.sqrt(Math.max(0, 1 - t4 * t4));

  if (shape === "Classic") {
    // Traditional Matryoshka hourglass-pear: generous belly, graceful pinched waist, full round head
    const g =
      0.425 +
      0.145 * Math.exp(-Math.pow((t - 0.31) / 0.22, 2)) -
      0.042 * Math.exp(-Math.pow((t - 0.62) / 0.13, 2)) +
      0.068 * Math.exp(-Math.pow((t - 0.82) / 0.18, 2));
    return dome * g;
  }

  if (shape === "Pear") {
    // Classic folk babushka pear: generous low belly sweeping smoothly up into a full, rounded head dome
    const g =
      0.380 +
      0.215 * Math.exp(-Math.pow((t - 0.28) / 0.25, 2)) +
      0.115 * Math.exp(-Math.pow((t - 0.84) / 0.21, 2));
    return dome * g;
  }

  // "Nordic" (default): sleek modern pear-dome silhouette
  const g =
    0.425 +
    0.122 * Math.exp(-Math.pow((t - 0.36) / 0.27, 2)) +
    0.038 * Math.exp(-Math.pow((t - 0.82) / 0.22, 2));
  return dome * g;
}

// Build a watertight LatheGeometry from a list of { r, y, part, cavity } control points.
// `part`: 0 = painted exterior, 1 = raw turned wooden rim / rabbet / interior cavity.
// `cavity`: 0 = exterior / rim, 0..1 = depth inside the hollow interior for ambient darkening.
function buildLathe(pts, radialSegments = 96) {
  const vecs = pts.map((p) => new Vector2(Math.max(0, p.r), p.y - CENTER_Y));
  const geom = new LatheGeometry(vecs, radialSegments);
  // Move the LatheGeometry phi=0 seam to the back (-Z) so the front (+Z) is completely seamless.
  geom.rotateY(Math.PI);

  // LatheGeometry creates (radialSegments + 1) columns of pts.length vertices each.
  const nPts = pts.length;
  const cols = radialSegments + 1;
  const count = geom.attributes.position.count;
  const partAttr = new Float32Array(count);
  const cavityAttr = new Float32Array(count);
  const hAttr = new Float32Array(count);

  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < nPts; i++) {
      const idx = c * nPts + i;
      if (idx < count) {
        partAttr[idx] = pts[i].part;
        cavityAttr[idx] = pts[i].cavity;
        hAttr[idx] = pts[i].y / DOLL_HEIGHT;
      }
    }
  }

  geom.setAttribute("aPart", new BufferAttribute(partAttr, 1));
  geom.setAttribute("aCavity", new BufferAttribute(cavityAttr, 1));
  geom.setAttribute("aH", new BufferAttribute(hAttr, 1));
  geom.computeVertexNormals();
  return geom;
}

function createDollGeometries(shape = "Nordic", radialSegments = 96) {
  const rSplit = profileRadius(SPLIT_H, shape);
  const rBase = profileRadius(0, shape);
  // Measure the narrowest outer radius along the rabbet lip height so the lip stays strictly inside
  // the tapering waist of the top cap on every silhouette (especially Plump and Classic).
  const rLipTopOuter = profileRadius((SPLIT_Y + LIP_HEIGHT + 0.01) / DOLL_HEIGHT, shape);
  const rLipOuter = Math.min(rSplit, rLipTopOuter) - 0.034;
  const rInnerRim = rLipOuter - 0.026;

  // --- Bottom Cup (y = 0 .. SPLIT_Y + LIP_HEIGHT) ---
  const bottomPts = [];
  // Flat base bottom (painted/raw wood underside)
  bottomPts.push({ r: 0, y: 0, part: 1, cavity: 0.25 });
  bottomPts.push({ r: rBase - 0.022, y: 0, part: 1, cavity: 0.15 });
  // Small chamfer around bottom edge
  bottomPts.push({ r: rBase - 0.008, y: 0.008, part: 0, cavity: 0 });
  bottomPts.push({ r: rBase, y: 0.022, part: 0, cavity: 0 });

  // Outer wall up to smooth chamfered split seam
  const seamChamfer = 0.0085;
  const outerBottomSteps = 28;
  for (let i = 1; i <= outerBottomSteps; i++) {
    const h = 0.01 + (SPLIT_H - 0.01) * (i / outerBottomSteps);
    const y = Math.min(h * DOLL_HEIGHT, SPLIT_Y - seamChamfer);
    bottomPts.push({ r: profileRadius(y / DOLL_HEIGHT, shape), y, part: 0, cavity: 0 });
  }
  // Smooth 3-step rounded chamfer at the bottom cup's outer split rim (anti-aliased specular catch)
  bottomPts.push({ r: rSplit - seamChamfer * 0.18, y: SPLIT_Y - seamChamfer * 0.52, part: 0, cavity: 0 });
  bottomPts.push({ r: rSplit - seamChamfer * 0.58, y: SPLIT_Y - seamChamfer * 0.16, part: 0, cavity: 0 });
  bottomPts.push({ r: rSplit - seamChamfer * 0.95, y: SPLIT_Y, part: 0, cavity: 0 });
  bottomPts.push({ r: rLipOuter + 0.004, y: SPLIT_Y, part: 1, cavity: 0.08 });
  bottomPts.push({ r: rLipOuter, y: SPLIT_Y + 0.004, part: 1, cavity: 0.06 });
  // Vertical rabbet lip
  bottomPts.push({ r: rLipOuter, y: SPLIT_Y + LIP_HEIGHT - 0.006, part: 1, cavity: 0.02 });
  // Rounded top rim of the lip
  bottomPts.push({ r: rLipOuter - 0.006, y: SPLIT_Y + LIP_HEIGHT, part: 1, cavity: 0 });
  bottomPts.push({ r: rInnerRim + 0.006, y: SPLIT_Y + LIP_HEIGHT, part: 1, cavity: 0.04 });
  bottomPts.push({ r: rInnerRim, y: SPLIT_Y + LIP_HEIGHT - 0.006, part: 1, cavity: 0.12 });

  // Inner hollow cavity wall descending to inner floor
  const innerBottomSteps = 16;
  for (let i = 0; i <= innerBottomSteps; i++) {
    const t = i / innerBottomSteps;
    const y = (SPLIT_Y + LIP_HEIGHT - 0.012) * (1 - t) + (BASE_THICKNESS + 0.016) * t;
    const h = Math.max(0, Math.min(SPLIT_H, y / DOLL_HEIGHT));
    const rIn = Math.max(0.06, Math.min(rInnerRim, profileRadius(h, shape) - WALL_THICKNESS));
    bottomPts.push({ r: rIn, y, part: 1, cavity: 0.15 + 0.72 * t });
  }
  // Inner floor fillet + flat inner floor
  const rInnerFloor = Math.max(0.05, Math.min(rInnerRim, rBase - WALL_THICKNESS) - 0.015);
  bottomPts.push({ r: rInnerFloor - 0.015, y: BASE_THICKNESS, part: 1, cavity: 0.92 });
  bottomPts.push({ r: 0, y: BASE_THICKNESS, part: 1, cavity: 0.96 });

  // --- Top Cap (y = SPLIT_Y .. DOLL_HEIGHT) ---
  // Traced CCW in (r, y): inner crown -> inner dome down -> inner rabbet recess -> outer rim -> outer dome up -> outer crown.
  const topPts = [];
  const innerCrownY = DOLL_HEIGHT - WALL_THICKNESS;
  topPts.push({ r: 0, y: innerCrownY, part: 1, cavity: 0.95 });

  const innerTopSteps = 22;
  const innerStartY = SPLIT_Y + LIP_HEIGHT + 0.006;
  for (let i = 1; i <= innerTopSteps; i++) {
    const t = i / innerTopSteps;
    // Ease near crown so dome cap is smooth
    const y = innerCrownY * (1 - t) + innerStartY * t;
    const h = Math.min(0.995, y / DOLL_HEIGHT);
    // Shrink inner crown smoothly near top
    const domeCap = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (y - (innerCrownY - 0.34)) / 0.34), 2)));
    const rProfile = Math.max(0, Math.min(rInnerRim, profileRadius(h, shape) - WALL_THICKNESS));
    const rIn = y > innerCrownY - 0.34 ? Math.min(rProfile, (rInnerRim * 0.88) * domeCap) : rProfile;
    topPts.push({ r: Math.max(0.002, rIn), y, part: 1, cavity: 0.92 * (1 - t) + 0.25 * t });
  }

  // Stepped inner rabbet recess that fits cleanly over the bottom cup's lip (+0.0025 clearance)
  const rRecess = rLipOuter + 0.0025;
  topPts.push({ r: rRecess, y: innerStartY, part: 1, cavity: 0.2 });
  topPts.push({ r: rRecess, y: SPLIT_Y + 0.004, part: 1, cavity: 0.1 });
  // Bottom rim of top cap with matching smooth 3-step rounded chamfer
  topPts.push({ r: rRecess + 0.004, y: SPLIT_Y, part: 1, cavity: 0.04 });
  topPts.push({ r: rSplit - seamChamfer * 0.95, y: SPLIT_Y, part: 0, cavity: 0 });
  topPts.push({ r: rSplit - seamChamfer * 0.58, y: SPLIT_Y + seamChamfer * 0.16, part: 0, cavity: 0 });
  topPts.push({ r: rSplit - seamChamfer * 0.18, y: SPLIT_Y + seamChamfer * 0.52, part: 0, cavity: 0 });
  topPts.push({ r: profileRadius((SPLIT_Y + seamChamfer) / DOLL_HEIGHT, shape), y: SPLIT_Y + seamChamfer, part: 0, cavity: 0 });

  // Outer wall of top cap up to crown
  const outerTopSteps = 56;
  const hTopStart = (SPLIT_Y + seamChamfer) / DOLL_HEIGHT;
  for (let i = 1; i < outerTopSteps; i++) {
    // Non-uniform spacing: denser near the rounded crown for a silky silhouette
    const u = i / outerTopSteps;
    const s = 1 - Math.pow(1 - u, 1.55);
    const h = hTopStart + (1 - hTopStart) * s;
    topPts.push({ r: profileRadius(h, shape), y: h * DOLL_HEIGHT, part: 0, cavity: 0 });
  }
  topPts.push({ r: 0, y: DOLL_HEIGHT, part: 0, cavity: 0 });

  return {
    bottom: buildLathe(bottomPts, radialSegments),
    top: buildLathe(topPts, radialSegments),
  };
}

export {
  DOLL_HEIGHT,
  CENTER_Y,
  SPLIT_H,
  SPLIT_Y,
  BASE_THICKNESS,
  SHAPES,
  profileRadius,
  createDollGeometries,
};
