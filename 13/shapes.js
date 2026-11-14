// Closed 3D surfaces with fast closest-point projection project(x, y, z, out) -> [px, py, pz, nx, ny, nz],
// manifold base meshes for rendering and Voronoi partitioning, and native polyhedral / hexagonal cell tilings.

const scratchGrad = new Float64Array(3);

function normalize3(x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function lerp3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Fast 1D secant/sphere-march radial ray-cast onto any convex genus-0 surface (calls project only once at the hit!).
function convexRayCast(shape, dx, dy, dz, out = new Float64Array(6)) {
  const [ux, uy, uz] = normalize3(dx, dy, dz);
  let t0 = 0.05;
  let t1 = Math.hypot(shape.bounds[0], shape.bounds[1], shape.bounds[2]);
  let f0 = shape.sdf(ux * t0, uy * t0, uz * t0);
  let f1 = shape.sdf(ux * t1, uy * t1, uz * t1);
  let t = t1;
  for (let step = 0; step < 14; step++) {
    const denom = f1 - f0;
    t = Math.abs(denom) > 1e-12 ? t1 - (f1 * (t1 - t0)) / denom : (t0 + t1) * 0.5;
    if (t <= Math.min(t0, t1) || t >= Math.max(t0, t1)) t = (t0 + t1) * 0.5;
    const ft = shape.sdf(ux * t, uy * t, uz * t);
    if (Math.abs(ft) < 1e-8) break;
    if (ft > 0) {
      t1 = t;
      f1 = ft;
    } else {
      t0 = t;
      f0 = ft;
    }
  }
  return shape.project(ux * t, uy * t, uz * t, out);
}

// Builds a rounded convex polyhedron from outward unit face normals, inner half-space distance, and rounding radius.
function makeRoundedPolyhedron({ faceNormals, inner, radius, radialScale = 1 }) {
  const faceCount = faceNormals.length;
  const corners = [];
  for (let i = 0; i < faceCount; i++) {
    for (let j = i + 1; j < faceCount; j++) {
      for (let k = j + 1; k < faceCount; k++) {
        const a = faceNormals[i];
        const b = faceNormals[j];
        const c = faceNormals[k];
        const bc = cross3(b, c);
        const ca = cross3(c, a);
        const ab = cross3(a, b);
        const det = dot3(a, bc);
        if (Math.abs(det) < 1e-8) continue;
        const vertex = [
          (bc[0] + ca[0] + ab[0]) / det,
          (bc[1] + ca[1] + ab[1]) / det,
          (bc[2] + ca[2] + ab[2]) / det,
        ];
        if (faceNormals.some((normal) => dot3(normal, vertex) > 1 + 1e-6)) continue;
        if (!corners.some((existing) => Math.hypot(existing[0] - vertex[0], existing[1] - vertex[1], existing[2] - vertex[2]) < 1e-5)) {
          corners.push(vertex);
        }
      }
    }
  }

  const facesOnCorner = corners.map((vertex) =>
    faceNormals
      .map((normal, fIdx) => (Math.abs(dot3(normal, vertex) - 1) < 1e-5 ? fIdx : -1))
      .filter((fIdx) => fIdx >= 0),
  );

  const edgeList = [];
  for (let i = 0; i < faceCount; i++) {
    for (let j = i + 1; j < faceCount; j++) {
      const shared = facesOnCorner
        .map((fList, vIdx) => (fList.includes(i) && fList.includes(j) ? vIdx : -1))
        .filter((vIdx) => vIdx >= 0);
      if (shared.length === 2) {
        const a = corners[shared[0]];
        const b = corners[shared[1]];
        const ax = a[0] * inner;
        const ay = a[1] * inner;
        const az = a[2] * inner;
        const ex = b[0] * inner - ax;
        const ey = b[1] * inner - ay;
        const ez = b[2] * inner - az;
        const invLenSq = 1 / (ex * ex + ey * ey + ez * ez);
        edgeList.push({ fi: i, fj: j, ax, ay, az, ex, ey, ez, invLenSq });
      }
    }
  }

  // Ordered corner indices around each face.
  const faceRings = faceNormals.map((normal, fIdx) => {
    const ring = corners
      .map((vertex, vIdx) => (facesOnCorner[vIdx].includes(fIdx) ? vIdx : -1))
      .filter((vIdx) => vIdx >= 0);
    const center = [normal[0], normal[1], normal[2]];
    const axisU = normalize3(
      corners[ring[0]][0] - center[0],
      corners[ring[0]][1] - center[1],
      corners[ring[0]][2] - center[2],
    );
    const axisW = cross3(normal, axisU);
    ring.sort((va, vb) => {
      const pa = corners[va];
      const pb = corners[vb];
      const angA = Math.atan2(
        (pa[0] - center[0]) * axisW[0] + (pa[1] - center[1]) * axisW[1] + (pa[2] - center[2]) * axisW[2],
        (pa[0] - center[0]) * axisU[0] + (pa[1] - center[1]) * axisU[1] + (pa[2] - center[2]) * axisU[2],
      );
      const angB = Math.atan2(
        (pb[0] - center[0]) * axisW[0] + (pb[1] - center[1]) * axisW[1] + (pb[2] - center[2]) * axisW[2],
        (pb[0] - center[0]) * axisU[0] + (pb[1] - center[1]) * axisU[1] + (pb[2] - center[2]) * axisU[2],
      );
      return angA - angB;
    });
    return ring;
  });

  const planeDist = new Float64Array(faceCount);
  const closestInner = new Float64Array(3);
  const maxCoord = Math.max(...corners.flatMap((v) => v.map((c) => Math.abs(c)))) * inner + radius;

  function closestOnInner(x, y, z) {
    let bestDist = -Infinity;
    let bestFace = 0;
    let outsideCount = 0;
    for (let i = 0; i < faceCount; i++) {
      const n = faceNormals[i];
      const d = n[0] * x + n[1] * y + n[2] * z - inner;
      planeDist[i] = d;
      if (d > 0) outsideCount++;
      if (d > bestDist) {
        bestDist = d;
        bestFace = i;
      }
    }
    // Strictly inside all half-spaces: closest boundary face is bestFace (note: outsideCount === 1 is NOT sufficient
    // on acute-dihedral solids like the 70.53 deg tetrahedron, where edge bevels extend into planeDist[other] < 0!).
    if (outsideCount === 0) {
      const n = faceNormals[bestFace];
      closestInner[0] = x - n[0] * bestDist;
      closestInner[1] = y - n[1] * bestDist;
      closestInner[2] = z - n[2] * bestDist;
      return { dist: bestDist, bestFace };
    }

    // By convex KKT optimality, if orthogonal projection onto violated face i lies inside all other half-spaces,
    // it is guaranteed to be the unique global closest point on the inner polyhedron!
    for (let i = 0; i < faceCount; i++) {
      const di = planeDist[i];
      if (di <= 0) continue;
      const n = faceNormals[i];
      const qx = x - n[0] * di;
      const qy = y - n[1] * di;
      const qz = z - n[2] * di;
      let insideAll = true;
      for (let j = 0; j < faceCount; j++) {
        if (j !== i && faceNormals[j][0] * qx + faceNormals[j][1] * qy + faceNormals[j][2] * qz > inner + 1e-9) {
          insideAll = false;
          break;
        }
      }
      if (insideAll) {
        closestInner[0] = qx;
        closestInner[1] = qy;
        closestInner[2] = qz;
        return { dist: di, bestFace: i };
      }
    }

    // Point lies in an edge bevel or corner cap Voronoi wedge: check edges touching at least one violated half-space.
    let minSq = Infinity;
    for (let e = 0; e < edgeList.length; e++) {
      const ed = edgeList[e];
      if (planeDist[ed.fi] <= 0 && planeDist[ed.fj] <= 0) continue;
      const px = x - ed.ax;
      const py = y - ed.ay;
      const pz = z - ed.az;
      const t = Math.max(0, Math.min(1, (px * ed.ex + py * ed.ey + pz * ed.ez) * ed.invLenSq));
      const qx = ed.ax + ed.ex * t;
      const qy = ed.ay + ed.ey * t;
      const qz = ed.az + ed.ez * t;
      const dSq = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
      if (dSq < minSq) {
        minSq = dSq;
        closestInner[0] = qx;
        closestInner[1] = qy;
        closestInner[2] = qz;
      }
    }
    return { dist: Math.sqrt(minSq), bestFace };
  }

  return {
    genus: 0,
    inner,
    radius,
    faceNormals,
    corners,
    faceRings,
    radialScale,
    bounds: [maxCoord, maxCoord, maxCoord],
    sdf(x, y, z) {
      return closestOnInner(x, y, z).dist - radius;
    },
    project(x, y, z, out = new Float64Array(6)) {
      const { dist, bestFace } = closestOnInner(x, y, z);
      let nx, ny, nz;
      if (dist <= 1e-9) {
        const n = faceNormals[bestFace];
        nx = n[0];
        ny = n[1];
        nz = n[2];
      } else {
        nx = (x - closestInner[0]) / dist;
        ny = (y - closestInner[1]) / dist;
        nz = (z - closestInner[2]) / dist;
      }
      out[0] = closestInner[0] + nx * radius;
      out[1] = closestInner[1] + ny * radius;
      out[2] = closestInner[2] + nz * radius;
      out[3] = nx;
      out[4] = ny;
      out[5] = nz;
      return out;
    },
    // Casts a direction ray from the origin onto the surface (for radial polyhedral & Goldberg grids).
    rayCast(dx, dy, dz, out = new Float64Array(6)) {
      return convexRayCast(this, dx, dy, dz, out);
    },
    ringScalar(x, y, z) {
      const len = Math.hypot(x, y, z) || 1;
      return Math.acos(Math.max(-1, Math.min(1, (y * 0.92 + x * 0.39) / len)));
    },
  };
}

// Golden ratio normals for dodecahedron & icosahedron.
const PHI = (1 + Math.sqrt(5)) / 2;
const DODECA_NORMALS = [
  [0, 1, PHI], [0, -1, PHI], [0, 1, -PHI], [0, -1, -PHI],
  [1, PHI, 0], [-1, PHI, 0], [1, -PHI, 0], [-1, -PHI, 0],
  [PHI, 0, 1], [-PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, -1],
].map((v) => normalize3(v[0], v[1], v[2]));

const dodecaShape = makeRoundedPolyhedron({
  faceNormals: DODECA_NORMALS,
  inner: 0.72,
  radius: 0.18,
});

const ICOSA_NORMALS = dodecaShape.corners.map((v) => normalize3(v[0], v[1], v[2]));
const icosaShape = makeRoundedPolyhedron({
  faceNormals: ICOSA_NORMALS,
  inner: 0.71,
  radius: 0.17,
});

const OCTA_NORMALS = [
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map((v) => normalize3(v[0], v[1], v[2]));
const octaShape = makeRoundedPolyhedron({
  faceNormals: OCTA_NORMALS,
  inner: 0.56,
  radius: 0.22,
});

const TETRA_NORMALS = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
].map((v) => normalize3(v[0], v[1], v[2]));
const tetraShape = makeRoundedPolyhedron({
  faceNormals: TETRA_NORMALS,
  inner: 0.38,
  radius: 0.26,
});

const RHOMBIC_DODECA_NORMALS = [
  [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
].map((v) => normalize3(v[0], v[1], v[2]));
const rhombicDodecaShape = makeRoundedPolyhedron({
  faceNormals: RHOMBIC_DODECA_NORMALS,
  inner: 0.65,
  radius: 0.18,
});

// Triaxial river-stone ellipsoid with exact 1D-Lagrange closest-point projection.
const pebbleShape = {
  genus: 0,
  axes: [1.04, 0.58, 0.82],
  bounds: [1.04, 0.58, 0.82],
  closestEllipsoid(x, y, z, out) {
    const [ax, ay, az] = this.axes;
    const ax2 = ax * ax;
    const ay2 = ay * ay;
    const az2 = az * az;
    const px = Math.abs(x);
    const py = Math.abs(y);
    const pz = Math.abs(z);
    if (px + py + pz < 1e-10) {
      out[0] = 0;
      out[1] = ay;
      out[2] = 0;
      out[3] = 0;
      out[4] = 1;
      out[5] = 0;
      return -ay;
    }
    const wx = ax * px;
    const wy = ay * py;
    const wz = az * pz;
    let tLo = -ay2 + wy;
    let tHi = -ay2 + Math.hypot(wx, wy, wz);
    let t = (tLo + tHi) * 0.5;
    for (let it = 0; it < 12; it++) {
      const dx = t + ax2;
      const dy = t + ay2;
      const dz = t + az2;
      const rx = wx / dx;
      const ry = wy / dy;
      const rz = wz / dz;
      const g = rx * rx + ry * ry + rz * rz - 1;
      if (Math.abs(g) < 1e-12) break;
      if (g > 0) tLo = t;
      else tHi = t;
      const dg = -2 * ((rx * rx) / dx + (ry * ry) / dy + (rz * rz) / dz);
      const nextT = t - g / dg;
      t = nextT > tLo && nextT < tHi ? nextT : (tLo + tHi) * 0.5;
    }
    const qx = (ax2 * x) / (t + ax2);
    const qy = (ay2 * y) / (t + ay2);
    const qz = (az2 * z) / (t + az2);
    const [nx, ny, nz] = normalize3(qx / ax2, qy / ay2, qz / az2);
    out[0] = qx;
    out[1] = qy;
    out[2] = qz;
    out[3] = nx;
    out[4] = ny;
    out[5] = nz;
    const dist = Math.hypot(x - qx, y - qy, z - qz);
    const inside = (x * x) / ax2 + (y * y) / ay2 + (z * z) / az2 < 1 ? -1 : 1;
    return inside * dist;
  },
  sdf(x, y, z) {
    const tmp = new Float64Array(6);
    return this.closestEllipsoid(x, y, z, tmp);
  },
  project(x, y, z, out = new Float64Array(6)) {
    this.closestEllipsoid(x, y, z, out);
    return out;
  },
  rayCast(dx, dy, dz, out = new Float64Array(6)) {
    const [ax, ay, az] = this.axes;
    const [ux, uy, uz] = normalize3(dx, dy, dz);
    const k = 1 / Math.hypot(ux / ax, uy / ay, uz / az);
    const px = ux * k;
    const py = uy * k;
    const pz = uz * k;
    const [nx, ny, nz] = normalize3(px / (ax * ax), py / (ay * ay), pz / (az * az));
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    out[3] = nx;
    out[4] = ny;
    out[5] = nz;
    return out;
  },
  ringScalar(x, y, z) {
    return y;
  },
};

// Lathe-turned rounded bicone top (exact closed-form 2D revolved SDF & projection).
const biconeShape = (() => {
  const coreR = 0.68;
  const coreH = 0.34;
  const radius = 0.23;
  const hyp = Math.hypot(coreR, coreH);
  const nhR = coreH / hyp;
  const nhY = coreR / hyp;
  const abR = -coreR;
  const abY = coreH;
  const abLenSq = abR * abR + abY * abY;

  function eval2D(r, ay) {
    const dLine = (r - coreR) * nhR + ay * nhY;
    if (dLine <= 0) {
      return {
        dist: dLine,
        qr: r - dLine * nhR,
        qy: ay - dLine * nhY,
        nr: nhR,
        ny: nhY,
      };
    }
    const t = Math.max(0, Math.min(1, ((r - coreR) * abR + ay * abY) / abLenSq));
    const qr = coreR + abR * t;
    const qy = abY * t;
    const dr = r - qr;
    const dy = ay - qy;
    const d = Math.hypot(dr, dy);
    return {
      dist: d,
      qr,
      qy,
      nr: d > 1e-12 ? dr / d : nhR,
      ny: d > 1e-12 ? dy / d : nhY,
    };
  }

  return {
    genus: 0,
    bounds: [coreR + radius, coreH + radius, coreR + radius],
    sdf(x, y, z) {
      return eval2D(Math.hypot(x, z), Math.abs(y)).dist - radius;
    },
    project(x, y, z, out = new Float64Array(6)) {
      const r = Math.hypot(x, z);
      const sy = y < 0 ? -1 : 1;
      const ux = r > 1e-12 ? x / r : 1;
      const uz = r > 1e-12 ? z / r : 0;
      const { qr, qy, nr, ny } = eval2D(r, Math.abs(y));
      const pr = qr + nr * radius;
      const py = sy * (qy + ny * radius);
      out[0] = ux * pr;
      out[1] = py;
      out[2] = uz * pr;
      out[3] = ux * nr;
      out[4] = sy * ny;
      out[5] = uz * nr;
      return out;
    },
    rayCast(dx, dy, dz, out = new Float64Array(6)) {
      return convexRayCast(this, dx, dy, dz, out);
    },
    ringScalar(x, _y, z) {
      return Math.hypot(x, z);
    },
  };
})();

// Superellipsoid cushion with Newton closest-point projection.
const pillowShape = {
  genus: 0,
  axisA: 0.92,
  axisB: 0.58,
  bounds: [0.92, 0.58, 0.92],
  field(x, y, z, grad) {
    const a = this.axisA;
    const b = this.axisB;
    const minAxis = Math.min(a, b);
    const ux = Math.abs(x) / a;
    const uy = Math.abs(y) / b;
    const uz = Math.abs(z) / a;
    const ux2 = ux * ux;
    const uz2 = uz * uz;
    const ux5 = ux2 * ux2 * ux;
    const uz5 = uz2 * uz2 * uz;
    const planar = ux5 * ux + uz5 * uz;
    const planarSqrt = Math.sqrt(planar);
    const total = planarSqrt + uy * uy * uy;
    if (!(total > 1e-24)) {
      grad[0] = 0;
      grad[1] = 1;
      grad[2] = 0;
      return -minAxis;
    }
    const gauge = Math.cbrt(total);
    const scale = (gauge / total) * minAxis;
    const scalePlanar = planarSqrt > 1e-18 ? scale / planarSqrt : 0;
    grad[0] = (scalePlanar * ux5 * (x < 0 ? -1 : 1)) / a;
    grad[1] = (scale * uy * uy * (y < 0 ? -1 : 1)) / b;
    grad[2] = (scalePlanar * uz5 * (z < 0 ? -1 : 1)) / a;
    return (gauge - 1) * minAxis;
  },
  sdf(x, y, z) {
    return this.field(x, y, z, scratchGrad);
  },
  project(x, y, z, out = new Float64Array(6)) {
    let px = x;
    let py = y;
    let pz = z;
    if (px * px + py * py + pz * pz < 1e-8) py = this.axisB;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let prevSlide = Infinity;
    for (let outer = 0; outer < 7; outer++) {
      for (let inner = 0; inner < 18; inner++) {
        const f = this.field(px, py, pz, scratchGrad);
        const gg = scratchGrad[0] ** 2 + scratchGrad[1] ** 2 + scratchGrad[2] ** 2;
        if (!(gg > 1e-14)) break;
        if (Math.abs(f) < 1e-8) break;
        let step = f / gg;
        const stepLen = Math.abs(step) * Math.sqrt(gg);
        if (stepLen > 0.16) step *= 0.16 / stepLen;
        px -= step * scratchGrad[0];
        py -= step * scratchGrad[1];
        pz -= step * scratchGrad[2];
      }
      const gl = Math.hypot(scratchGrad[0], scratchGrad[1], scratchGrad[2]) || 1;
      nx = scratchGrad[0] / gl;
      ny = scratchGrad[1] / gl;
      nz = scratchGrad[2] / gl;
      const rx = x - px;
      const ry = y - py;
      const rz = z - pz;
      const normalComp = rx * nx + ry * ny + rz * nz;
      const tx = rx - nx * normalComp;
      const ty = ry - ny * normalComp;
      const tz = rz - nz * normalComp;
      const tLen = Math.hypot(tx, ty, tz);
      if (tLen < 1e-7 || outer === 6) break;
      const damp = tLen > prevSlide ? 0.5 : 1;
      prevSlide = tLen;
      px += tx * damp;
      py += ty * damp;
      pz += tz * damp;
    }
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    out[3] = nx;
    out[4] = ny;
    out[5] = nz;
    return out;
  },
  ringScalar(x, y, z) {
    return Math.hypot(x, z);
  },
  rayCast(dx, dy, dz, out = new Float64Array(6)) {
    const [ux, uy, uz] = normalize3(dx, dy, dz);
    const a = this.axisA;
    const b = this.axisB;
    const planar = Math.hypot((Math.abs(ux) / a) ** 3, (Math.abs(uz) / a) ** 3);
    const t = 1 / Math.cbrt(planar + (Math.abs(uy) / b) ** 3);
    const px = ux * t;
    const py = uy * t;
    const pz = uz * t;
    this.field(px, py, pz, scratchGrad);
    const [nx, ny, nz] = normalize3(scratchGrad[0], scratchGrad[1], scratchGrad[2]);
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    out[3] = nx;
    out[4] = ny;
    out[5] = nz;
    return out;
  },
};

// General closed parametric tube builder with exact Newton curve projection and twist-free parallel-transport frame.
function makeParametricTube({ evalCurve, tubeRadius, bounds, sampleCount = 480, lengthRatio = 6.5 }) {
  const samples = new Float64Array(sampleCount * 3);
  const tangents = new Float64Array(sampleCount * 3);
  const frameU = new Float64Array(sampleCount * 3);
  const frameV = new Float64Array(sampleCount * 3);

  const tmpPos = [0, 0, 0];
  const tmpD1 = [0, 0, 0];
  const tmpD2 = [0, 0, 0];

  for (let i = 0; i < sampleCount; i++) {
    const t = (i / sampleCount) * Math.PI * 2;
    evalCurve(t, tmpPos, tmpD1, null);
    samples.set(tmpPos, i * 3);
    const tNorm = normalize3(tmpD1[0], tmpD1[1], tmpD1[2]);
    tangents.set(tNorm, i * 3);
  }

  // Parallel-transport an initial normal around the closed loop, then distribute the closing twist evenly.
  const t0 = [tangents[0], tangents[1], tangents[2]];
  let uVec = normalize3(...cross3(t0, Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const rawU = [uVec];
  for (let i = 1; i <= sampleCount; i++) {
    const idx = (i % sampleCount) * 3;
    const tNext = [tangents[idx], tangents[idx + 1], tangents[idx + 2]];
    const proj = dot3(uVec, tNext);
    uVec = normalize3(uVec[0] - proj * tNext[0], uVec[1] - proj * tNext[1], uVec[2] - proj * tNext[2]);
    rawU.push(uVec);
  }
  const v0 = cross3(t0, rawU[0]);
  const endU = rawU[sampleCount];
  const twistError = Math.atan2(dot3(endU, v0), dot3(endU, rawU[0]));

  for (let i = 0; i < sampleCount; i++) {
    const idx = i * 3;
    const tVec = [tangents[idx], tangents[idx + 1], tangents[idx + 2]];
    const baseU = rawU[i];
    const baseV = cross3(tVec, baseU);
    const corr = -twistError * (i / sampleCount);
    const ca = Math.cos(corr);
    const sa = Math.sin(corr);
    const ux = baseU[0] * ca + baseV[0] * sa;
    const uy = baseU[1] * ca + baseV[1] * sa;
    const uz = baseU[2] * ca + baseV[2] * sa;
    frameU[idx] = ux;
    frameU[idx + 1] = uy;
    frameU[idx + 2] = uz;
    const vx = tVec[1] * uz - tVec[2] * uy;
    const vy = tVec[2] * ux - tVec[0] * uz;
    const vz = tVec[0] * uy - tVec[1] * ux;
    frameV[idx] = vx;
    frameV[idx + 1] = vy;
    frameV[idx + 2] = vz;
  }

  function closestParameter(x, y, z) {
    let bestIdx = 0;
    let bestSq = Infinity;
    for (let i = 0; i < sampleCount; i += 4) {
      const k = i * 3;
      const dSq = (x - samples[k]) ** 2 + (y - samples[k + 1]) ** 2 + (z - samples[k + 2]) ** 2;
      if (dSq < bestSq) {
        bestSq = dSq;
        bestIdx = i;
      }
    }
    for (let offset = -4; offset <= 4; offset++) {
      const i = (bestIdx + offset + sampleCount) % sampleCount;
      const k = i * 3;
      const dSq = (x - samples[k]) ** 2 + (y - samples[k + 1]) ** 2 + (z - samples[k + 2]) ** 2;
      if (dSq < bestSq) {
        bestSq = dSq;
        bestIdx = i;
      }
    }
    let t = (bestIdx / sampleCount) * Math.PI * 2;
    for (let it = 0; it < 4; it++) {
      evalCurve(t, tmpPos, tmpD1, tmpD2);
      const rx = tmpPos[0] - x;
      const ry = tmpPos[1] - y;
      const rz = tmpPos[2] - z;
      const f = rx * tmpD1[0] + ry * tmpD1[1] + rz * tmpD1[2];
      const df =
        tmpD1[0] * tmpD1[0] + tmpD1[1] * tmpD1[1] + tmpD1[2] * tmpD1[2] +
        rx * tmpD2[0] + ry * tmpD2[1] + rz * tmpD2[2];
      if (Math.abs(df) < 1e-10) break;
      const dt = Math.max(-0.08, Math.min(0.08, f / df));
      t -= dt;
      if (Math.abs(dt) < 1e-8) break;
    }
    t = ((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return t;
  }

  function frameAt(t) {
    const f = ((t / (Math.PI * 2)) * sampleCount) % sampleCount;
    const i0 = Math.floor(f) % sampleCount;
    const i1 = (i0 + 1) % sampleCount;
    const frac = f - Math.floor(f);
    evalCurve(t, tmpPos, tmpD1, null);
    const tNorm = normalize3(tmpD1[0], tmpD1[1], tmpD1[2]);
    const ux = frameU[i0 * 3] * (1 - frac) + frameU[i1 * 3] * frac;
    const uy = frameU[i0 * 3 + 1] * (1 - frac) + frameU[i1 * 3 + 1] * frac;
    const uz = frameU[i0 * 3 + 2] * (1 - frac) + frameU[i1 * 3 + 2] * frac;
    const proj = ux * tNorm[0] + uy * tNorm[1] + uz * tNorm[2];
    const uNorm = normalize3(ux - proj * tNorm[0], uy - proj * tNorm[1], uz - proj * tNorm[2]);
    const vNorm = cross3(tNorm, uNorm);
    return { center: [tmpPos[0], tmpPos[1], tmpPos[2]], u: uNorm, v: vNorm };
  }

  return {
    genus: 1,
    isTube: true,
    tubeRadius,
    lengthRatio,
    bounds,
    frameAt,
    sdf(x, y, z) {
      const t = closestParameter(x, y, z);
      evalCurve(t, tmpPos, null, null);
      return Math.hypot(x - tmpPos[0], y - tmpPos[1], z - tmpPos[2]) - tubeRadius;
    },
    project(x, y, z, out = new Float64Array(6)) {
      const t = closestParameter(x, y, z);
      evalCurve(t, tmpPos, tmpD1, null);
      let dx = x - tmpPos[0];
      let dy = y - tmpPos[1];
      let dz = z - tmpPos[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-8) {
        const fr = frameAt(t);
        dx = fr.u[0];
        dy = fr.u[1];
        dz = fr.u[2];
      } else {
        dx /= len;
        dy /= len;
        dz /= len;
      }
      out[0] = tmpPos[0] + dx * tubeRadius;
      out[1] = tmpPos[1] + dy * tubeRadius;
      out[2] = tmpPos[2] + dz * tubeRadius;
      out[3] = dx;
      out[4] = dy;
      out[5] = dz;
      return out;
    },
    ringScalar(x, y, z) {
      const t = closestParameter(x, y, z);
      const fr = frameAt(t);
      const dx = x - fr.center[0];
      const dy = y - fr.center[1];
      const dz = z - fr.center[2];
      return Math.atan2(
        dx * fr.v[0] + dy * fr.v[1] + dz * fr.v[2],
        dx * fr.u[0] + dy * fr.u[1] + dz * fr.u[2],
      );
    },
  };
}

// Trefoil (2, 3) torus knot tube.
const trefoilShape = (() => {
  const scale = 0.32;
  const heightZ = 1.7;
  const tubeRadius = 0.19;
  return makeParametricTube({
    tubeRadius,
    lengthRatio: 9.1,
    bounds: [3 * scale + tubeRadius, heightZ * scale + tubeRadius, 3 * scale + tubeRadius],
    evalCurve(t, pos, d1, d2) {
      const c1 = Math.cos(t);
      const s1 = Math.sin(t);
      const c2 = Math.cos(2 * t);
      const s2 = Math.sin(2 * t);
      const c3 = Math.cos(3 * t);
      const s3 = Math.sin(3 * t);
      pos[0] = (s1 + 2 * s2) * scale;
      pos[1] = -heightZ * s3 * scale;
      pos[2] = (c1 - 2 * c2) * scale;
      if (d1) {
        d1[0] = (c1 + 4 * c2) * scale;
        d1[1] = -3 * heightZ * c3 * scale;
        d1[2] = (-s1 + 4 * s2) * scale;
      }
      if (d2) {
        d2[0] = (-s1 - 8 * s2) * scale;
        d2[1] = 9 * heightZ * s3 * scale;
        d2[2] = (-c1 + 8 * c2) * scale;
      }
    },
  });
})();

// 3-fold undulating saddle-crown ring tube.
const saddleRingShape = (() => {
  const baseR = 0.72;
  const lobeR = 0.1;
  const waveY = 0.25;
  const tubeRadius = 0.23;
  return makeParametricTube({
    tubeRadius,
    lengthRatio: 4.5,
    sampleCount: 360,
    bounds: [baseR + lobeR + tubeRadius, waveY + tubeRadius, baseR + lobeR + tubeRadius],
    evalCurve(t, pos, d1, d2) {
      const c1 = Math.cos(t);
      const s1 = Math.sin(t);
      const c3 = Math.cos(3 * t);
      const s3 = Math.sin(3 * t);
      const r = baseR + lobeR * c3;
      pos[0] = r * c1;
      pos[1] = waveY * s3;
      pos[2] = r * s1;
      if (d1) {
        const dr = -3 * lobeR * s3;
        d1[0] = dr * c1 - r * s1;
        d1[1] = 3 * waveY * c3;
        d1[2] = dr * s1 + r * c1;
      }
      if (d2) {
        const dr = -3 * lobeR * s3;
        const d2r = -9 * lobeR * c3;
        d2[0] = (d2r - r) * c1 - 2 * dr * s1;
        d2[1] = -9 * waveY * s3;
        d2[2] = (d2r - r) * s1 + 2 * dr * c1;
      }
    },
  });
})();

export const SHAPES = {
  sphere: {
    genus: 0,
    bounds: [1, 1, 1],
    sdf: (x, y, z) => Math.hypot(x, y, z) - 1,
    project(x, y, z, out = new Float64Array(6)) {
      const len = Math.hypot(x, y, z) || 1;
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;
      out[0] = nx;
      out[1] = ny;
      out[2] = nz;
      out[3] = nx;
      out[4] = ny;
      out[5] = nz;
      return out;
    },
    ringScalar(x, y, z) {
      const len = Math.hypot(x, y, z) || 1;
      return Math.acos(Math.max(-1, Math.min(1, (y * 0.9 + z * 0.435) / len)));
    },
    rayCast(dx, dy, dz, out = new Float64Array(6)) {
      return this.project(dx, dy, dz, out);
    },
  },

  torus: {
    genus: 1,
    majorR: 0.72,
    minorR: 0.35,
    bounds: [1.07, 0.35, 1.07],
    sdf(x, y, z) {
      return Math.hypot(Math.hypot(x, z) - this.majorR, y) - this.minorR;
    },
    project(x, y, z, out = new Float64Array(6)) {
      const ringLen = Math.hypot(x, z);
      const cx = ringLen > 1e-9 ? (x / ringLen) * this.majorR : this.majorR;
      const cz = ringLen > 1e-9 ? (z / ringLen) * this.majorR : 0;
      let dx = x - cx;
      let dy = y;
      let dz = z - cz;
      const tubeLen = Math.hypot(dx, dy, dz) || 1;
      dx /= tubeLen;
      dy /= tubeLen;
      dz /= tubeLen;
      out[0] = cx + dx * this.minorR;
      out[1] = dy * this.minorR;
      out[2] = cz + dz * this.minorR;
      out[3] = dx;
      out[4] = dy;
      out[5] = dz;
      return out;
    },
    ringScalar(x, y, z) {
      const ringLen = Math.hypot(x, z);
      return Math.atan2(y, ringLen - this.majorR);
    },
  },

  icosahedron: icosaShape,
  dodecahedron: dodecaShape,

  "rounded cube": {
    genus: 0,
    half: 0.78,
    radius: 0.24,
    bounds: [0.78, 0.78, 0.78],
    sdf(x, y, z) {
      const core = this.half - this.radius;
      const qx = Math.abs(x) - core;
      const qy = Math.abs(y) - core;
      const qz = Math.abs(z) - core;
      return (
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
        Math.min(Math.max(qx, qy, qz), 0) -
        this.radius
      );
    },
    project(x, y, z, out = new Float64Array(6)) {
      const core = this.half - this.radius;
      const qx = Math.max(-core, Math.min(core, x));
      const qy = Math.max(-core, Math.min(core, y));
      const qz = Math.max(-core, Math.min(core, z));
      let dx = x - qx;
      let dy = y - qy;
      let dz = z - qz;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-9) {
        const ax = core - Math.abs(x);
        const ay = core - Math.abs(y);
        const az = core - Math.abs(z);
        if (ax <= ay && ax <= az) dx = x < 0 ? -1 : 1;
        else if (ay <= az) dy = y < 0 ? -1 : 1;
        else dz = z < 0 ? -1 : 1;
      }
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      out[0] = qx + dx * this.radius;
      out[1] = qy + dy * this.radius;
      out[2] = qz + dz * this.radius;
      out[3] = dx;
      out[4] = dy;
      out[5] = dz;
      return out;
    },
    ringScalar(x, y, z) {
      const len = Math.hypot(x, y, z) || 1;
      return Math.acos(Math.max(-1, Math.min(1, y / len)));
    },
    rayCast(dx, dy, dz, out = new Float64Array(6)) {
      return convexRayCast(this, dx, dy, dz, out);
    },
  },

  octahedron: octaShape,
  tetrahedron: tetraShape,
  "rhombic dodecahedron": rhombicDodecaShape,
  pillow: pillowShape,
  pebble: pebbleShape,
  bicone: biconeShape,

  capsule: {
    genus: 0,
    halfLen: 0.42,
    radius: 0.68,
    bounds: [0.68, 1.1, 0.68],
    sdf(x, y, z) {
      const cy = Math.max(-this.halfLen, Math.min(this.halfLen, y));
      return Math.hypot(x, y - cy, z) - this.radius;
    },
    project(x, y, z, out = new Float64Array(6)) {
      const cy = Math.max(-this.halfLen, Math.min(this.halfLen, y));
      let dx = x;
      let dy = y - cy;
      let dz = z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) {
        dx = 1;
        dy = 0;
        dz = 0;
      } else {
        dx /= len;
        dy /= len;
        dz /= len;
      }
      out[0] = dx * this.radius;
      out[1] = cy + dy * this.radius;
      out[2] = dz * this.radius;
      out[3] = dx;
      out[4] = dy;
      out[5] = dz;
      return out;
    },
    ringScalar(_x, y, _z) {
      return y;
    },
    rayCast(dx, dy, dz, out = new Float64Array(6)) {
      return convexRayCast(this, dx, dy, dz, out);
    },
  },

  "saddle ring": saddleRingShape,
  trefoil: trefoilShape,
};

// Builds a welded closed manifold triangle mesh for any shape (used both for the floor shell and Voronoi growth).
export function buildShapeMesh(shapeName, resolution = 64) {
  const shape = SHAPES[shapeName];
  const proj = new Float64Array(6);
  const rawPos = [];
  const rawNor = [];
  const rawIdx = [];

  if (shapeName === "torus") {
    const nu = Math.round(resolution * 3.2);
    const nv = Math.round(resolution * 1.6);
    const { majorR, minorR } = shape;
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      for (let i = 0; i < nu; i++) {
        const u = (i / nu) * Math.PI * 2;
        const cu = Math.cos(u);
        const su = Math.sin(u);
        const nx = cv * cu;
        const ny = sv;
        const nz = cv * su;
        rawPos.push((majorR + minorR * cv) * cu, minorR * sv, (majorR + minorR * cv) * su);
        rawNor.push(nx, ny, nz);
      }
    }
    for (let j = 0; j < nv; j++) {
      const jNext = (j + 1) % nv;
      for (let i = 0; i < nu; i++) {
        const iNext = (i + 1) % nu;
        const a = j * nu + i;
        const b = jNext * nu + i;
        const c = jNext * nu + iNext;
        const d = j * nu + iNext;
        rawIdx.push(a, b, c, a, c, d);
      }
    }
    return {
      position: new Float32Array(rawPos),
      normal: new Float32Array(rawNor),
      index: new Uint32Array(rawIdx),
    };
  }

  if (shape.isTube) {
    const nu = Math.round(resolution * (shape.lengthRatio ?? 6.5) * 1.05);
    const nv = Math.max(28, Math.round(resolution * 1.05));
    const r = shape.tubeRadius;
    for (let i = 0; i < nu; i++) {
      const t = (i / nu) * Math.PI * 2;
      const fr = shape.frameAt(t);
      for (let j = 0; j < nv; j++) {
        const phi = (j / nv) * Math.PI * 2;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        const nx = fr.u[0] * cp + fr.v[0] * sp;
        const ny = fr.u[1] * cp + fr.v[1] * sp;
        const nz = fr.u[2] * cp + fr.v[2] * sp;
        rawPos.push(fr.center[0] + nx * r, fr.center[1] + ny * r, fr.center[2] + nz * r);
        rawNor.push(nx, ny, nz);
      }
    }
    for (let i = 0; i < nu; i++) {
      const iNext = (i + 1) % nu;
      for (let j = 0; j < nv; j++) {
        const jNext = (j + 1) % nv;
        const a = i * nv + j;
        const b = iNext * nv + j;
        const c = iNext * nv + jNext;
        const d = i * nv + jNext;
        rawIdx.push(a, d, c, a, c, b);
      }
    }
    return {
      position: new Float32Array(rawPos),
      normal: new Float32Array(rawNor),
      index: new Uint32Array(rawIdx),
    };
  }

  // Welded cubed-sphere projected onto any genus-0 shape.
  const n = resolution;
  const vertexMap = new Map();
  const faces = [
    [0, 1, 2, 1],
    [0, 1, 2, -1],
    [1, 2, 0, 1],
    [1, 2, 0, -1],
    [2, 0, 1, 1],
    [2, 0, 1, -1],
  ];

  function getWeldedVertex(ix, iy, iz) {
    const key = `${ix},${iy},${iz}`;
    let id = vertexMap.get(key);
    if (id !== undefined) return id;
    let ux = ix / n;
    let uy = iy / n;
    let uz = iz / n;
    ux = Math.abs(ix) === n ? Math.sign(ix) : Math.tan((ux * Math.PI) / 4);
    uy = Math.abs(iy) === n ? Math.sign(iy) : Math.tan((uy * Math.PI) / 4);
    uz = Math.abs(iz) === n ? Math.sign(iz) : Math.tan((uz * Math.PI) / 4);
    shape.rayCast(ux, uy, uz, proj);
    id = rawPos.length / 3;
    rawPos.push(proj[0], proj[1], proj[2]);
    rawNor.push(proj[3], proj[4], proj[5]);
    vertexMap.set(key, id);
    return id;
  }

  const faceGrids = [];

  for (const [axisA, axisB, axisC, sign] of faces) {
    const grid = new Int32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const coords = [0, 0, 0];
        coords[axisC] = sign * n;
        coords[axisA] = (i * 2 - n) * sign;
        coords[axisB] = j * 2 - n;
        grid[j * (n + 1) + i] = getWeldedVertex(coords[0], coords[1], coords[2]);
      }
    }
    faceGrids.push(grid);
  }

  const position = new Float32Array(rawPos);
  const normal = new Float32Array(rawNor);

  // Choose whichever quad diagonal (a-c vs b-d) aligns with the surface generator (higher normal dot product)
  // so diagonal edges run parallel along cylindrical bevels instead of folding creases across them!
  for (const grid of faceGrids) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = grid[j * (n + 1) + i];
        const b = grid[j * (n + 1) + i + 1];
        const c = grid[(j + 1) * (n + 1) + i + 1];
        const d = grid[(j + 1) * (n + 1) + i];
        const a3 = a * 3;
        const b3 = b * 3;
        const c3 = c * 3;
        const d3 = d * 3;
        const dotAC =
          normal[a3] * normal[c3] + normal[a3 + 1] * normal[c3 + 1] + normal[a3 + 2] * normal[c3 + 2];
        const dotBD =
          normal[b3] * normal[d3] + normal[b3 + 1] * normal[d3 + 1] + normal[b3 + 2] * normal[d3 + 2];
        if (dotAC >= dotBD) {
          rawIdx.push(a, b, c, a, c, d);
        } else {
          rawIdx.push(a, b, d, b, c, d);
        }
      }
    }
  }

  return {
    position,
    normal,
    index: new Uint32Array(rawIdx),
  };
}
