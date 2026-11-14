// Surface cell tilings (polyhedral, hexagonal Goldberg/honeycomb, and intrinsic manifold Voronoi),
// four maze generators (backtracker, kruskal, braided, rings), diameter Start/Goal placement,
// recessed floor shell with Ariadne hint path, and zero-Z-fighting mitered bevelled wall geometry.
import { BufferGeometry, BufferAttribute } from "../third_party/three.core.js";
import { SHAPES, buildShapeMesh } from "./shapes.js";

const MIN_WALL_HALF_WIDTH = 0.0125;

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

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function tangentFrame(normal) {
  const ref = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize3(...cross3(ref, normal));
  const v = cross3(normal, u);
  return { u, v };
}

// Finalizes a list of polygonal cells (each an ordered ring of vertex indices) into a clean cell-edge complex.
function finalizeComplex(shape, rawVertices, rawCellRings) {
  const proj = new Float64Array(6);
  const vertices = rawVertices.map((pos) => {
    shape.project(pos[0], pos[1], pos[2], proj);
    return {
      pos: [proj[0], proj[1], proj[2]],
      normal: [proj[3], proj[4], proj[5]],
    };
  });

  const cells = [];
  for (let cIdx = 0; cIdx < rawCellRings.length; cIdx++) {
    const ring = [];
    for (const vIdx of rawCellRings[cIdx]) {
      if (ring.length === 0 || ring[ring.length - 1] !== vIdx) {
        ring.push(vIdx);
      }
    }
    if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length < 3) continue;

    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const vIdx of ring) {
      const p = vertices[vIdx].pos;
      sx += p[0];
      sy += p[1];
      sz += p[2];
    }
    shape.project(sx / ring.length, sy / ring.length, sz / ring.length, proj);
    const center = [proj[0], proj[1], proj[2]];
    const normal = [proj[3], proj[4], proj[5]];

    // Ensure ring winds counter-clockwise around outward normal.
    const { u, v } = tangentFrame(normal);
    let signedArea = 0;
    for (let k = 0; k < ring.length; k++) {
      const pa = vertices[ring[k]].pos;
      const pb = vertices[ring[(k + 1) % ring.length]].pos;
      const ax = (pa[0] - center[0]) * u[0] + (pa[1] - center[1]) * u[1] + (pa[2] - center[2]) * u[2];
      const ay = (pa[0] - center[0]) * v[0] + (pa[1] - center[1]) * v[1] + (pa[2] - center[2]) * v[2];
      const bx = (pb[0] - center[0]) * u[0] + (pb[1] - center[1]) * u[1] + (pb[2] - center[2]) * u[2];
      const by = (pb[0] - center[0]) * v[0] + (pb[1] - center[1]) * v[1] + (pb[2] - center[2]) * v[2];
      signedArea += ax * by - bx * ay;
    }
    if (signedArea < 0) ring.reverse();

    // Estimate cell inradius from center to boundary segments.
    let inradius = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const pa = vertices[ring[k]].pos;
      const pb = vertices[ring[(k + 1) % ring.length]].pos;
      const ex = pb[0] - pa[0];
      const ey = pb[1] - pa[1];
      const ez = pb[2] - pa[2];
      const eLenSq = ex * ex + ey * ey + ez * ez;
      const t = eLenSq > 1e-12
        ? Math.max(0, Math.min(1, ((center[0] - pa[0]) * ex + (center[1] - pa[1]) * ey + (center[2] - pa[2]) * ez) / eLenSq))
        : 0;
      const d = Math.hypot(center[0] - (pa[0] + ex * t), center[1] - (pa[1] + ey * t), center[2] - (pa[2] + ez * t));
      if (d < inradius) inradius = d;
    }

    cells.push({
      id: cells.length,
      center,
      normal,
      ring,
      edgeIds: [],
      inradius,
    });
  }

  const edgeMap = new Map();
  const edges = [];
  for (let cIdx = 0; cIdx < cells.length; cIdx++) {
    const ring = cells[cIdx].ring;
    for (let k = 0; k < ring.length; k++) {
      const va = ring[k];
      const vb = ring[(k + 1) % ring.length];
      if (va === vb) continue;
      const lo = Math.min(va, vb);
      const hi = Math.max(va, vb);
      const key = `${lo}_${hi}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = {
          id: edges.length,
          v0: lo,
          v1: hi,
          c0: cIdx,
          c1: -1,
          length: dist3(vertices[lo].pos, vertices[hi].pos),
        };
        edgeMap.set(key, edge);
        edges.push(edge);
      } else if (edge.c1 === -1 && edge.c0 !== cIdx) {
        edge.c1 = cIdx;
      }
      cells[cIdx].edgeIds.push(edge.id);
    }
  }

  return { vertices, cells, edges };
}

// ---------------------------------------------------------------------------
// 1. Structured / Polyhedral Tiling
// ---------------------------------------------------------------------------
function buildPolyhedralTiling(shapeName, density) {
  const shape = SHAPES[shapeName];
  const rawVertices = [];
  const rawRings = [];
  const vertexByKey = new Map();

  function addWeldedPoint(x, y, z) {
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let idx = vertexByKey.get(key);
    if (idx === undefined) {
      idx = rawVertices.length;
      rawVertices.push([x, y, z]);
      vertexByKey.set(key, idx);
    }
    return idx;
  }

  if (shapeName === "torus") {
    const nv = Math.max(7, Math.round(6.5 + density * 6));
    const nu = Math.max(14, Math.round(nv * 1.6));
    const grid = (i, j) => ((j % nv) + nv) % nv * nu + (((i % nu) + nu) % nu);
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      for (let i = 0; i < nu; i++) {
        const u = (i / nu) * Math.PI * 2;
        const nx = Math.cos(v) * Math.cos(u);
        const ny = Math.sin(v);
        const nz = Math.cos(v) * Math.sin(u);
        rawVertices.push([
          (shape.majorR + shape.minorR * Math.cos(v)) * Math.cos(u),
          shape.minorR * ny,
          (shape.majorR + shape.minorR * Math.cos(v)) * Math.sin(u),
        ]);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        rawRings.push([grid(i, j), grid(i, j + 1), grid(i + 1, j + 1), grid(i + 1, j)]);
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  if (shape.isTube) {
    const nv = Math.max(6, Math.round(5.5 + density * 4.5));
    const ratio = shape.lengthRatio ?? 6.5;
    const nu = Math.max(24, Math.round(((5.5 + density * 4.5) * ratio * 0.82) / 3) * 3);
    const r = shape.tubeRadius;
    const grid = (i, j) => ((i % nu) + nu) % nu * nv + (((j % nv) + nv) % nv);
    for (let i = 0; i < nu; i++) {
      const fr = shape.frameAt((i / nu) * Math.PI * 2);
      for (let j = 0; j < nv; j++) {
        const phi = (j / nv) * Math.PI * 2;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        rawVertices.push([
          fr.center[0] + (fr.u[0] * cp + fr.v[0] * sp) * r,
          fr.center[1] + (fr.u[1] * cp + fr.v[1] * sp) * r,
          fr.center[2] + (fr.u[2] * cp + fr.v[2] * sp) * r,
        ]);
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        rawRings.push([grid(i, j), grid(i, j + 1), grid(i + 1, j + 1), grid(i + 1, j)]);
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  if (shapeName === "dodecahedron") {
    const sub = Math.max(2, Math.round(1.6 + density * 2.4));
    const proj = new Float64Array(6);
    const castPoint = (p) => {
      shape.rayCast(p[0], p[1], p[2], proj);
      return addWeldedPoint(proj[0], proj[1], proj[2]);
    };
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let fIdx = 0; fIdx < shape.faceNormals.length; fIdx++) {
      const center = shape.faceNormals[fIdx].map((c) => c * shape.inner);
      const ring = shape.faceRings[fIdx].map((vIdx) => shape.corners[vIdx].map((c) => c * shape.inner));
      const m = ring.length;
      for (let k = 0; k < m; k++) {
        const corner = ring[k];
        const midPrev = lerp(ring[(k + m - 1) % m], corner, 0.5);
        const midNext = lerp(corner, ring[(k + 1) % m], 0.5);
        const patch = [];
        for (let j = 0; j <= sub; j++) {
          for (let i = 0; i <= sub; i++) {
            const p = lerp(lerp(center, midPrev, i / sub), lerp(midNext, corner, i / sub), j / sub);
            patch.push(castPoint(p));
          }
        }
        for (let j = 0; j < sub; j++) {
          for (let i = 0; i < sub; i++) {
            rawRings.push([
              patch[j * (sub + 1) + i],
              patch[j * (sub + 1) + i + 1],
              patch[(j + 1) * (sub + 1) + i + 1],
              patch[(j + 1) * (sub + 1) + i],
            ]);
          }
        }
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  if (shapeName === "rhombic dodecahedron") {
    const sub = Math.max(3, Math.round(2.8 + density * 3.0));
    const proj = new Float64Array(6);
    const castPoint = (p) => {
      shape.rayCast(p[0], p[1], p[2], proj);
      return addWeldedPoint(proj[0], proj[1], proj[2]);
    };
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let fIdx = 0; fIdx < shape.faceNormals.length; fIdx++) {
      const [c0, c1, c2, c3] = shape.faceRings[fIdx].map((vIdx) => shape.corners[vIdx]);
      const patch = [];
      for (let j = 0; j <= sub; j++) {
        for (let i = 0; i <= sub; i++) {
          const p = lerp(lerp(c0, c1, i / sub), lerp(c3, c2, i / sub), j / sub);
          patch.push(castPoint(p));
        }
      }
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) {
          rawRings.push([
            patch[j * (sub + 1) + i],
            patch[j * (sub + 1) + i + 1],
            patch[(j + 1) * (sub + 1) + i + 1],
            patch[(j + 1) * (sub + 1) + i],
          ]);
        }
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  if (shapeName === "icosahedron" || shapeName === "octahedron" || shapeName === "tetrahedron") {
    const baseSub = shapeName === "icosahedron"
      ? Math.max(3, Math.round(2.6 + density * 3.0))
      : shapeName === "octahedron"
        ? Math.max(4, Math.round(4 + density * 4.2))
        : Math.max(6, Math.round(5.5 + density * 5.0));
    const proj = new Float64Array(6);
    const castPoint = (p) => {
      shape.rayCast(p[0], p[1], p[2], proj);
      return addWeldedPoint(proj[0], proj[1], proj[2]);
    };
    for (let fIdx = 0; fIdx < shape.faceNormals.length; fIdx++) {
      const ring = shape.faceRings[fIdx].map((vIdx) => shape.corners[vIdx]);
      const [va, vb, vc] = ring;
      const triGrid = [];
      for (let i = 0; i <= baseSub; i++) {
        const row = [];
        for (let j = 0; j <= baseSub - i; j++) {
          const k = baseSub - i - j;
          const px = (va[0] * k + vb[0] * i + vc[0] * j) / baseSub;
          const py = (va[1] * k + vb[1] * i + vc[1] * j) / baseSub;
          const pz = (va[2] * k + vb[2] * i + vc[2] * j) / baseSub;
          row.push(castPoint([px, py, pz]));
        }
        triGrid.push(row);
      }
      for (let i = 0; i < baseSub; i++) {
        for (let j = 0; j < baseSub - i; j++) {
          rawRings.push([triGrid[i][j], triGrid[i + 1][j], triGrid[i][j + 1]]);
          if (j + 1 < baseSub - i) {
            rawRings.push([triGrid[i + 1][j], triGrid[i + 1][j + 1], triGrid[i][j + 1]]);
          }
        }
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  // Cubed-sphere / projected cube quads for sphere, rounded cube, pillow, capsule.
  const n = Math.max(5, Math.round(5 + density * 6));
  const proj = new Float64Array(6);
  const cubeFaces = [
    [0, 1, 2, 1],
    [0, 1, 2, -1],
    [1, 2, 0, 1],
    [1, 2, 0, -1],
    [2, 0, 1, 1],
    [2, 0, 1, -1],
  ];

  for (const [axisA, axisB, axisC, sign] of cubeFaces) {
    const patch = new Int32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = Math.tan((((i / n) * 2 - 1) * Math.PI) / 4);
        const v = Math.tan((((j / n) * 2 - 1) * Math.PI) / 4);
        const p = [0, 0, 0];
        p[axisC] = sign;
        p[axisA] = u * sign;
        p[axisB] = v;
        shape.rayCast(p[0], p[1], p[2], proj);
        patch[j * (n + 1) + i] = addWeldedPoint(proj[0], proj[1], proj[2]);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        rawRings.push([
          patch[j * (n + 1) + i],
          patch[j * (n + 1) + i + 1],
          patch[(j + 1) * (n + 1) + i + 1],
          patch[(j + 1) * (n + 1) + i],
        ]);
      }
    }
  }

  return finalizeComplex(shape, rawVertices, rawRings);
}

// ---------------------------------------------------------------------------
// 2. Hexagonal / Goldberg Honeycomb Tiling
// ---------------------------------------------------------------------------
function buildHexagonalTiling(shapeName, density) {
  const shape = SHAPES[shapeName];
  const rawVertices = [];
  const rawRings = [];

  if (shape.genus === 1) {
    // Periodic honeycomb on (u, v) for torus, saddle ring, and trefoil.
    const nv = shape.isTube
      ? Math.max(6, Math.round((6 + density * 4) / 2) * 2)
      : Math.max(6, Math.round((6 + density * 6) / 2) * 2);
    const nu = shape.isTube
      ? Math.max(18, Math.round(((18 + density * 18) * ((shape.lengthRatio ?? 6.5) / 5.5)) / 3) * 3)
      : Math.max(14, Math.round(nv * 1.65));

    const mapUV = (uNorm, vNorm) => {
      const uWrapped = ((uNorm % 1) + 1) % 1;
      const vWrapped = ((vNorm % 1) + 1) % 1;
      if (shapeName === "torus") {
        const u = uWrapped * Math.PI * 2;
        const v = vWrapped * Math.PI * 2;
        return [
          (shape.majorR + shape.minorR * Math.cos(v)) * Math.cos(u),
          shape.minorR * Math.sin(v),
          (shape.majorR + shape.minorR * Math.cos(v)) * Math.sin(u),
        ];
      }
      const fr = shape.frameAt(uWrapped * Math.PI * 2);
      const phi = vWrapped * Math.PI * 2;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const r = shape.tubeRadius;
      return [
        fr.center[0] + (fr.u[0] * cp + fr.v[0] * sp) * r,
        fr.center[1] + (fr.u[1] * cp + fr.v[1] * sp) * r,
        fr.center[2] + (fr.u[2] * cp + fr.v[2] * sp) * r,
      ];
    };

    // Dual of staggered triangular lattice on nu x nv: two tri-centers per (i, j) cell.
    const cornerIndex = new Map();
    const getCorner = (i, j, kind) => {
      const ii = ((i % nu) + nu) % nu;
      const jj = ((j % nv) + nv) % nv;
      const key = `${ii},${jj},${kind}`;
      let idx = cornerIndex.get(key);
      if (idx !== undefined) return idx;
      const oddStrip = jj & 1;
      let uCoord, vCoord;
      if (!oddStrip) {
        if (kind === 0) {
          uCoord = (ii + (ii + 1) + (ii + 0.5)) / 3 / nu;
          vCoord = (jj + jj + (jj + 1)) / 3 / nv;
        } else {
          uCoord = ((ii + 1) + (ii + 1.5) + (ii + 0.5)) / 3 / nu;
          vCoord = (jj + (jj + 1) + (jj + 1)) / 3 / nv;
        }
      } else {
        if (kind === 0) {
          uCoord = ((ii + 0.5) + (ii + 1.5) + (ii + 1)) / 3 / nu;
          vCoord = (jj + jj + (jj + 1)) / 3 / nv;
        } else {
          uCoord = ((ii + 1.5) + (ii + 2) + (ii + 1)) / 3 / nu;
          vCoord = (jj + (jj + 1) + (jj + 1)) / 3 / nv;
        }
      }
      idx = rawVertices.length;
      rawVertices.push(mapUV(uCoord, vCoord));
      cornerIndex.set(key, idx);
      return idx;
    };

    for (let j = 0; j < nv; j++) {
      const odd = j & 1;
      for (let i = 0; i < nu; i++) {
        if (!odd) {
          rawRings.push([
            getCorner(i, j, 0),
            getCorner(i - 1, j, 1),
            getCorner(i - 1, j, 0),
            getCorner(i - 2, j - 1, 1),
            getCorner(i - 1, j - 1, 0),
            getCorner(i - 1, j - 1, 1),
          ]);
        } else {
          rawRings.push([
            getCorner(i, j, 0),
            getCorner(i - 1, j, 1),
            getCorner(i - 1, j, 0),
            getCorner(i - 1, j - 1, 1),
            getCorner(i, j - 1, 0),
            getCorner(i, j - 1, 1),
          ]);
        }
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  // Goldberg dual of subdivided icosahedron for genus-0 shapes.
  const freq = Math.max(4, Math.round(4 + density * 4.5));
  const primalVerts = [];
  const primalMap = new Map();
  const primalTris = [];

  const addPrimal = (x, y, z) => {
    const [ux, uy, uz] = normalize3(x, y, z);
    const key = `${Math.round(ux * 1e4)},${Math.round(uy * 1e4)},${Math.round(uz * 1e4)}`;
    let id = primalMap.get(key);
    if (id === undefined) {
      id = primalVerts.length;
      primalVerts.push([ux, uy, uz]);
      primalMap.set(key, id);
    }
    return id;
  };

  const icosaRef = SHAPES.icosahedron;
  for (let fIdx = 0; fIdx < icosaRef.faceNormals.length; fIdx++) {
    const [va, vb, vc] = icosaRef.faceRings[fIdx].map((vIdx) => icosaRef.corners[vIdx]);
    const triGrid = [];
    for (let i = 0; i <= freq; i++) {
      const row = [];
      for (let j = 0; j <= freq - i; j++) {
        const k = freq - i - j;
        row.push(
          addPrimal(
            va[0] * k + vb[0] * i + vc[0] * j,
            va[1] * k + vb[1] * i + vc[1] * j,
            va[2] * k + vb[2] * i + vc[2] * j,
          ),
        );
      }
      triGrid.push(row);
    }
    for (let i = 0; i < freq; i++) {
      for (let j = 0; j < freq - i; j++) {
        primalTris.push([triGrid[i][j], triGrid[i + 1][j], triGrid[i][j + 1]]);
        if (j + 1 < freq - i) {
          primalTris.push([triGrid[i + 1][j], triGrid[i + 1][j + 1], triGrid[i][j + 1]]);
        }
      }
    }
  }

  const proj = new Float64Array(6);
  const incidentTris = Array.from({ length: primalVerts.length }, () => []);

  for (let tIdx = 0; tIdx < primalTris.length; tIdx++) {
    const [a, b, c] = primalTris[tIdx];
    const pa = primalVerts[a];
    const pb = primalVerts[b];
    const pc = primalVerts[c];
    const dir = normalize3(pa[0] + pb[0] + pc[0], pa[1] + pb[1] + pc[1], pa[2] + pb[2] + pc[2]);
    shape.rayCast(dir[0], dir[1], dir[2], proj);
    rawVertices.push([proj[0], proj[1], proj[2]]);
    incidentTris[a].push(tIdx);
    incidentTris[b].push(tIdx);
    incidentTris[c].push(tIdx);
  }

  for (let pIdx = 0; pIdx < primalVerts.length; pIdx++) {
    const tris = incidentTris[pIdx];
    if (tris.length < 3) continue;
    const dir = primalVerts[pIdx];
    const { u, v } = tangentFrame(dir);
    tris.sort((ta, tb) => {
      const pa = primalTris[ta];
      const pb = primalTris[tb];
      const da = normalize3(
        primalVerts[pa[0]][0] + primalVerts[pa[1]][0] + primalVerts[pa[2]][0],
        primalVerts[pa[0]][1] + primalVerts[pa[1]][1] + primalVerts[pa[2]][1],
        primalVerts[pa[0]][2] + primalVerts[pa[1]][2] + primalVerts[pa[2]][2],
      );
      const db = normalize3(
        primalVerts[pb[0]][0] + primalVerts[pb[1]][0] + primalVerts[pb[2]][0],
        primalVerts[pb[0]][1] + primalVerts[pb[1]][1] + primalVerts[pb[2]][1],
        primalVerts[pb[0]][2] + primalVerts[pb[1]][2] + primalVerts[pb[2]][2],
      );
      const angA = Math.atan2(dot3(da, v), dot3(da, u));
      const angB = Math.atan2(dot3(db, v), dot3(db, u));
      return angA - angB;
    });
    rawRings.push(tris);
  }

  // Area-equalizing centroidal relaxation on the surface so hexagons wrap evenly across corners, bevels, and faces.
  if (shapeName !== "sphere") {
    const vSumX = new Float64Array(rawVertices.length);
    const vSumY = new Float64Array(rawVertices.length);
    const vSumZ = new Float64Array(rawVertices.length);
    const vDeg = new Int32Array(rawVertices.length);
    for (let iter = 0; iter < 5; iter++) {
      vSumX.fill(0);
      vSumY.fill(0);
      vSumZ.fill(0);
      vDeg.fill(0);
      for (let c = 0; c < rawRings.length; c++) {
        const ring = rawRings[c];
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let k = 0; k < ring.length; k++) {
          const vp = rawVertices[ring[k]];
          cx += vp[0];
          cy += vp[1];
          cz += vp[2];
        }
        shape.project(cx / ring.length, cy / ring.length, cz / ring.length, proj);
        for (let k = 0; k < ring.length; k++) {
          const vId = ring[k];
          vSumX[vId] += proj[0];
          vSumY[vId] += proj[1];
          vSumZ[vId] += proj[2];
          vDeg[vId]++;
        }
      }
      for (let vId = 0; vId < rawVertices.length; vId++) {
        if (vDeg[vId] < 2) continue;
        shape.project(
          rawVertices[vId][0] * 0.25 + (vSumX[vId] / vDeg[vId]) * 0.75,
          rawVertices[vId][1] * 0.25 + (vSumY[vId] / vDeg[vId]) * 0.75,
          rawVertices[vId][2] * 0.25 + (vSumZ[vId] / vDeg[vId]) * 0.75,
          proj,
        );
        rawVertices[vId] = [proj[0], proj[1], proj[2]];
      }
    }
  }

  return finalizeComplex(shape, rawVertices, rawRings);
}

// ---------------------------------------------------------------------------
// 2b. Additional Surface Cell Tilings: Triangular, Octagonal (4.8.8), Masonry
// ---------------------------------------------------------------------------
function mapGenus1UV(shapeName, shape, uNorm, vNorm) {
  const uWrapped = ((uNorm % 1) + 1) % 1;
  const vWrapped = ((vNorm % 1) + 1) % 1;
  if (shapeName === "torus") {
    const u = uWrapped * Math.PI * 2;
    const v = vWrapped * Math.PI * 2;
    return [
      (shape.majorR + shape.minorR * Math.cos(v)) * Math.cos(u),
      shape.minorR * Math.sin(v),
      (shape.majorR + shape.minorR * Math.cos(v)) * Math.sin(u),
    ];
  }
  const fr = shape.frameAt(uWrapped * Math.PI * 2);
  const phi = vWrapped * Math.PI * 2;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const r = shape.tubeRadius;
  return [
    fr.center[0] + (fr.u[0] * cp + fr.v[0] * sp) * r,
    fr.center[1] + (fr.u[1] * cp + fr.v[1] * sp) * r,
    fr.center[2] + (fr.u[2] * cp + fr.v[2] * sp) * r,
  ];
}

function relaxSurfaceComplexRings(shape, rawVertices, rawRings, iterations = 3, blend = 0.65) {
  const proj = new Float64Array(6);
  const vSumX = new Float64Array(rawVertices.length);
  const vSumY = new Float64Array(rawVertices.length);
  const vSumZ = new Float64Array(rawVertices.length);
  const vDeg = new Int32Array(rawVertices.length);
  for (let iter = 0; iter < iterations; iter++) {
    vSumX.fill(0);
    vSumY.fill(0);
    vSumZ.fill(0);
    vDeg.fill(0);
    for (let c = 0; c < rawRings.length; c++) {
      const ring = rawRings[c];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let k = 0; k < ring.length; k++) {
        const vp = rawVertices[ring[k]];
        cx += vp[0];
        cy += vp[1];
        cz += vp[2];
      }
      shape.project(cx / ring.length, cy / ring.length, cz / ring.length, proj);
      for (let k = 0; k < ring.length; k++) {
        const vId = ring[k];
        vSumX[vId] += proj[0];
        vSumY[vId] += proj[1];
        vSumZ[vId] += proj[2];
        vDeg[vId]++;
      }
    }
    for (let vId = 0; vId < rawVertices.length; vId++) {
      if (vDeg[vId] < 2) continue;
      shape.project(
        rawVertices[vId][0] * (1 - blend) + (vSumX[vId] / vDeg[vId]) * blend,
        rawVertices[vId][1] * (1 - blend) + (vSumY[vId] / vDeg[vId]) * blend,
        rawVertices[vId][2] * (1 - blend) + (vSumZ[vId] / vDeg[vId]) * blend,
        proj,
      );
      rawVertices[vId] = [proj[0], proj[1], proj[2]];
    }
  }
}

function buildTriangularTiling(shapeName, density) {
  const shape = SHAPES[shapeName];
  const rawVertices = [];
  const rawRings = [];

  if (shape.genus === 1) {
    const nv = Math.max(6, Math.round((5.5 + density * 4.5) / 2) * 2);
    const nu = shape.isTube
      ? Math.max(18, Math.round((18 + density * 18) * ((shape.lengthRatio ?? 6.5) / 5.5) / 3) * 3)
      : Math.max(14, Math.round(nv * 1.7));
    const idx = (i, j) => (((j % nv) + nv) % nv) * nu + (((i % nu) + nu) % nu);
    for (let j = 0; j < nv; j++) {
      const shift = (j & 1) * 0.5;
      for (let i = 0; i < nu; i++) {
        rawVertices.push(mapGenus1UV(shapeName, shape, (i + shift) / nu, j / nv));
      }
    }
    for (let j = 0; j < nv; j++) {
      const odd = j & 1;
      for (let i = 0; i < nu; i++) {
        if (!odd) {
          rawRings.push([idx(i, j), idx(i + 1, j), idx(i, j + 1)]);
          rawRings.push([idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
        } else {
          rawRings.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
          rawRings.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
        }
      }
    }
    relaxSurfaceComplexRings(shape, rawVertices, rawRings, 2, 0.45);
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  // Geodesic subdivided icosahedron cast onto any genus-0 shape.
  const freq = Math.max(3, Math.round(2.8 + density * 3.0));
  const vertexByKey = new Map();
  const proj = new Float64Array(6);
  const addPoint = (x, y, z) => {
    const [ux, uy, uz] = normalize3(x, y, z);
    const key = `${Math.round(ux * 1e4)},${Math.round(uy * 1e4)},${Math.round(uz * 1e4)}`;
    let id = vertexByKey.get(key);
    if (id === undefined) {
      shape.rayCast(ux, uy, uz, proj);
      id = rawVertices.length;
      rawVertices.push([proj[0], proj[1], proj[2]]);
      vertexByKey.set(key, id);
    }
    return id;
  };

  const icosaRef = SHAPES.icosahedron;
  for (let fIdx = 0; fIdx < icosaRef.faceNormals.length; fIdx++) {
    const [va, vb, vc] = icosaRef.faceRings[fIdx].map((vIdx) => icosaRef.corners[vIdx]);
    const triGrid = [];
    for (let i = 0; i <= freq; i++) {
      const row = [];
      for (let j = 0; j <= freq - i; j++) {
        const k = freq - i - j;
        row.push(
          addPoint(
            va[0] * k + vb[0] * i + vc[0] * j,
            va[1] * k + vb[1] * i + vc[1] * j,
            va[2] * k + vb[2] * i + vc[2] * j,
          ),
        );
      }
      triGrid.push(row);
    }
    for (let i = 0; i < freq; i++) {
      for (let j = 0; j < freq - i; j++) {
        rawRings.push([triGrid[i][j], triGrid[i + 1][j], triGrid[i][j + 1]]);
        if (j + 1 < freq - i) {
          rawRings.push([triGrid[i + 1][j], triGrid[i + 1][j + 1], triGrid[i][j + 1]]);
        }
      }
    }
  }
  if (shapeName !== "sphere") {
    relaxSurfaceComplexRings(shape, rawVertices, rawRings, 3, 0.55);
  }
  return finalizeComplex(shape, rawVertices, rawRings);
}

// Uniform 4.8.8 truncated-quad tiling (interlocking octagons & 45-deg diamonds).
function buildOctagonalTiling(shapeName, density, wallStyle = "three-step") {
  const shape = SHAPES[shapeName];
  const baseVertices = [];
  const baseQuads = [];
  const proj = new Float64Array(6);

  if (shape.genus === 1) {
    const nv = shape.isTube
      ? Math.max(4, Math.round(3.8 + density * 2.4))
      : Math.max(5, Math.round(4.5 + density * 3.0));
    const nu = shape.isTube
      ? Math.max(12, Math.round(((13 + density * 11) * ((shape.lengthRatio ?? 6.5) / 5.5)) / 3) * 3)
      : Math.max(10, Math.round(nv * 1.6));
    const idx = (i, j) => (((j % nv) + nv) % nv) * nu + (((i % nu) + nu) % nu);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        baseVertices.push(mapGenus1UV(shapeName, shape, i / nu, j / nv));
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        baseQuads.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
      }
    }
  } else {
    const n = Math.max(3, Math.round(2.8 + density * 2.6));
    const vertexByKey = new Map();
    const addWelded = (x, y, z) => {
      const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      let id = vertexByKey.get(key);
      if (id === undefined) {
        id = baseVertices.length;
        baseVertices.push([x, y, z]);
        vertexByKey.set(key, id);
      }
      return id;
    };
    const cubeFaces = [
      [0, 1, 2, 1],
      [0, 1, 2, -1],
      [1, 2, 0, 1],
      [1, 2, 0, -1],
      [2, 0, 1, 1],
      [2, 0, 1, -1],
    ];
    for (const [axisA, axisB, axisC, sign] of cubeFaces) {
      const patch = new Int32Array((n + 1) * (n + 1));
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const u = Math.tan((((i / n) * 2 - 1) * Math.PI) / 4);
          const v = Math.tan((((j / n) * 2 - 1) * Math.PI) / 4);
          const p = [0, 0, 0];
          p[axisC] = sign;
          p[axisA] = u * sign;
          p[axisB] = v;
          shape.rayCast(p[0], p[1], p[2], proj);
          patch[j * (n + 1) + i] = addWelded(proj[0], proj[1], proj[2]);
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          baseQuads.push([
            patch[j * (n + 1) + i],
            patch[j * (n + 1) + i + 1],
            patch[(j + 1) * (n + 1) + i + 1],
            patch[(j + 1) * (n + 1) + i],
          ]);
        }
      }
    }
  }

  const baseComplex = finalizeComplex(shape, baseVertices, baseQuads);
  const rawVertices = [];
  const rawRings = [];
  const truncCut =
    wallStyle === "original" ? 1 / (2 + Math.SQRT2) : wallStyle === "three-step" ? 0.325 : 0.335;
  const edgeTrunc = baseComplex.edges.map((e) => {
    const p0 = baseComplex.vertices[e.v0].pos;
    const p1 = baseComplex.vertices[e.v1].pos;
    shape.project(
      p0[0] + (p1[0] - p0[0]) * truncCut,
      p0[1] + (p1[1] - p0[1]) * truncCut,
      p0[2] + (p1[2] - p0[2]) * truncCut,
      proj,
    );
    const id0 = rawVertices.length;
    rawVertices.push([proj[0], proj[1], proj[2]]);
    shape.project(
      p1[0] + (p0[0] - p1[0]) * truncCut,
      p1[1] + (p0[1] - p1[1]) * truncCut,
      p1[2] + (p0[2] - p1[2]) * truncCut,
      proj,
    );
    const id1 = rawVertices.length;
    rawVertices.push([proj[0], proj[1], proj[2]]);
    return { v0: e.v0, v1: e.v1, id0, id1 };
  });

  const edgeLookup = new Map();
  const vertIncidents = Array.from({ length: baseComplex.vertices.length }, () => []);
  for (let eIdx = 0; eIdx < edgeTrunc.length; eIdx++) {
    const et = edgeTrunc[eIdx];
    const lo = Math.min(et.v0, et.v1);
    const hi = Math.max(et.v0, et.v1);
    edgeLookup.set(`${lo}_${hi}`, et);
    vertIncidents[et.v0].push(et.id0);
    vertIncidents[et.v1].push(et.id1);
  }

  for (const cell of baseComplex.cells) {
    const r = cell.ring;
    const oct = [];
    for (let k = 0; k < r.length; k++) {
      const va = r[k];
      const vb = r[(k + 1) % r.length];
      const et = edgeLookup.get(`${Math.min(va, vb)}_${Math.max(va, vb)}`);
      if (!et) continue;
      if (et.v0 === va) {
        oct.push(et.id0, et.id1);
      } else {
        oct.push(et.id1, et.id0);
      }
    }
    if (oct.length >= 3) rawRings.push(oct);
  }
  const majorCellCount = rawRings.length;

  for (let vIdx = 0; vIdx < baseComplex.vertices.length; vIdx++) {
    const inc = vertIncidents[vIdx];
    if (inc.length < 3) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < inc.length; k++) {
      const p = rawVertices[inc[k]];
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    shape.project(cx / inc.length, cy / inc.length, cz / inc.length, proj);
    const vp = [proj[0], proj[1], proj[2]];
    const vn = [proj[3], proj[4], proj[5]];
    const { u, v } = tangentFrame(vn);
    inc.sort((ia, ib) => {
      const pa = rawVertices[ia];
      const pb = rawVertices[ib];
      const angA = Math.atan2(
        (pa[0] - vp[0]) * v[0] + (pa[1] - vp[1]) * v[1] + (pa[2] - vp[2]) * v[2],
        (pa[0] - vp[0]) * u[0] + (pa[1] - vp[1]) * u[1] + (pa[2] - vp[2]) * u[2],
      );
      const angB = Math.atan2(
        (pb[0] - vp[0]) * v[0] + (pb[1] - vp[1]) * v[1] + (pb[2] - vp[2]) * v[2],
        (pb[0] - vp[0]) * u[0] + (pb[1] - vp[1]) * u[1] + (pb[2] - vp[2]) * u[2],
      );
      return angA - angB;
    });
    rawRings.push(inc);
  }

  relaxSurfaceComplexRings(shape, rawVertices, rawRings, 3, 0.45);
  const complex = finalizeComplex(shape, rawVertices, rawRings);
  if (wallStyle === "straightened") {
    for (let i = majorCellCount; i < complex.cells.length; i++) {
      complex.cells[i].isChamfer = true;
    }
  }
  return complex;
}

// Staggered running-bond concentric masonry courses (with polar medallions on genus-0 shapes).
function buildMasonryTiling(shapeName, density) {
  const shape = SHAPES[shapeName];
  const rawVertices = [];
  const rawRings = [];
  const proj = new Float64Array(6);

  if (shape.genus === 1) {
    const nv = shape.isTube
      ? Math.max(6, Math.round((5.2 + density * 2.8) / 2) * 2)
      : Math.max(6, Math.round((6 + density * 4) / 2) * 2);
    const nu = shape.isTube
      ? Math.max(10, Math.round((10 + density * 10) * Math.max(1, (shape.lengthRatio ?? 6.5) / 6.5)))
      : Math.max(9, Math.round(nv * 1.15));
    const subU = nu * 2;
    const idx = (s, j) => (((j % nv) + nv) % nv) * subU + (((s % subU) + subU) % subU);
    for (let j = 0; j < nv; j++) {
      for (let s = 0; s < subU; s++) {
        rawVertices.push(mapGenus1UV(shapeName, shape, s / subU, j / nv));
      }
    }
    for (let j = 0; j < nv; j++) {
      const shift = j & 1;
      for (let i = 0; i < nu; i++) {
        const s0 = 2 * i + shift;
        rawRings.push([
          idx(s0, j),
          idx(s0 + 1, j),
          idx(s0 + 2, j),
          idx(s0 + 2, j + 1),
          idx(s0 + 1, j + 1),
          idx(s0, j + 1),
        ]);
      }
    }
    return finalizeComplex(shape, rawVertices, rawRings);
  }

  // Genus-0 concentric latitude courses between North and South polar medallions!
  const courseCount = Math.max(5, Math.round(5 + density * 4));
  const seamCount = courseCount + 1;
  const eqBricks = Math.max(10, Math.round(10 + density * 8));
  const courseBricks = [];
  for (let c = 0; c < courseCount; c++) {
    const thetaMid = ((c + 1) / (courseCount + 1)) * Math.PI;
    courseBricks.push(Math.max(5, Math.round(eqBricks * Math.sin(thetaMid))));
  }

  const wrapAngle = (a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const seamVerts = [];

  for (let s = 0; s < seamCount; s++) {
    const theta = ((s + 0.68) / (seamCount + 0.36)) * Math.PI;
    const angles = [];
    if (s > 0) {
      const mAbove = courseBricks[s - 1];
      const off = ((s - 1) & 1) * 0.5;
      for (let i = 0; i < mAbove; i++) angles.push(wrapAngle(((i + off) / mAbove) * Math.PI * 2));
    }
    if (s < courseCount) {
      const mBelow = courseBricks[s];
      const off = (s & 1) * 0.5;
      for (let i = 0; i < mBelow; i++) angles.push(wrapAngle(((i + off) / mBelow) * Math.PI * 2));
    }
    angles.sort((a, b) => a - b);

    // Merge seam angles closer than 40% of the finer brick spacing so shared edges stay wide!
    const maxM = Math.max(s > 0 ? courseBricks[s - 1] : 5, s < courseCount ? courseBricks[s] : 5);
    const minAngGap = ((Math.PI * 2) / (maxM * 2)) * 0.72;
    const merged = [];
    for (const a of angles) {
      if (merged.length === 0 || a - merged[merged.length - 1] >= minAngGap) {
        merged.push(a);
      } else {
        merged[merged.length - 1] = (merged[merged.length - 1] + a) * 0.5;
      }
    }
    if (merged.length > 3 && Math.PI * 2 - merged[merged.length - 1] + merged[0] < minAngGap) {
      const avg = wrapAngle((merged[merged.length - 1] + merged[0] + Math.PI * 2) * 0.5);
      merged[0] = avg;
      merged.pop();
      merged.sort((a, b) => a - b);
    }

    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const ring = merged.map((phi) => {
      shape.rayCast(st * Math.cos(phi), ct, st * Math.sin(phi), proj);
      const vId = rawVertices.length;
      rawVertices.push([proj[0], proj[1], proj[2]]);
      return { phi, vId };
    });
    seamVerts.push(ring);
  }

  // Helper: find closest vertex on a seam to target angle phi, and walk forward CCW along the seam to endIdx.
  function closestSeamIdx(seam, targetPhi) {
    let bestK = 0;
    let bestDiff = Infinity;
    for (let k = 0; k < seam.length; k++) {
      let diff = Math.abs(seam[k].phi - targetPhi);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestK = k;
      }
    }
    return bestK;
  }

  function arcIndicesCCW(seam, kStart, kEnd) {
    const out = [seam[kStart].vId];
    let k = kStart;
    let guard = 0;
    while (k !== kEnd && guard++ <= seam.length) {
      k = (k + 1) % seam.length;
      out.push(seam[k].vId);
    }
    return out;
  }

  // North polar medallion (around +Y) and South polar medallion (around -Y).
  rawRings.push(seamVerts[0].map((sv) => sv.vId).reverse());
  rawRings.push(seamVerts[seamCount - 1].map((sv) => sv.vId));

  for (let c = 0; c < courseCount; c++) {
    const m = courseBricks[c];
    const off = (c & 1) * 0.5;
    const topSeam = seamVerts[c];
    const botSeam = seamVerts[c + 1];
    for (let i = 0; i < m; i++) {
      const phi0 = wrapAngle(((i + off) / m) * Math.PI * 2);
      const phi1 = wrapAngle(((i + 1 + off) / m) * Math.PI * 2);
      const t0 = closestSeamIdx(topSeam, phi0);
      const t1 = closestSeamIdx(topSeam, phi1);
      const b0 = closestSeamIdx(botSeam, phi0);
      const b1 = closestSeamIdx(botSeam, phi1);
      if (t0 === t1 || b0 === b1) continue;
      const topArc = arcIndicesCCW(topSeam, t0, t1);
      const botArc = arcIndicesCCW(botSeam, b0, b1);
      rawRings.push([...botArc, ...topArc.reverse()]);
    }
  }

  return finalizeComplex(shape, rawVertices, rawRings);
}

// ---------------------------------------------------------------------------
// 3. Organic Intrinsic Manifold Voronoi Tiling
// ---------------------------------------------------------------------------
function buildVoronoiTiling(shapeName, density, rand) {
  const shape = SHAPES[shapeName];
  const baseMesh = buildShapeMesh(shapeName, 26);
  const pos = baseMesh.position;
  const idx = baseMesh.index;
  const vertCount = pos.length / 3;
  const triCount = idx.length / 3;

  // Build vertex adjacency list with edge lengths for fast intrinsic Dijkstra.
  const adjVerts = Array.from({ length: vertCount }, () => []);
  const adjWeights = Array.from({ length: vertCount }, () => []);
  const addHalfEdge = (a, b) => {
    if (adjVerts[a].includes(b)) return;
    const d = Math.hypot(
      pos[a * 3] - pos[b * 3],
      pos[a * 3 + 1] - pos[b * 3 + 1],
      pos[a * 3 + 2] - pos[b * 3 + 2],
    );
    adjVerts[a].push(b);
    adjWeights[a].push(d);
    adjVerts[b].push(a);
    adjWeights[b].push(d);
  };
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    addHalfEdge(a, b);
    addHalfEdge(b, c);
    addHalfEdge(c, a);
    const abx = pos[b * 3] - pos[a * 3];
    const aby = pos[b * 3 + 1] - pos[a * 3 + 1];
    const abz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const acx = pos[c * 3] - pos[a * 3];
    const acy = pos[c * 3 + 1] - pos[a * 3 + 1];
    const acz = pos[c * 3 + 2] - pos[a * 3 + 2];
    totalArea +=
      0.5 *
      Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
  }

  // Scale Voronoi cell count directly by surface area so thin tubes & polyhedra have the same generous cell spacing as spheres!
  const areaFactor = Math.max(0.42, Math.min(1.25, totalArea / 11.2));
  let targetCells = Math.max(28, Math.round(areaFactor * (58 + density * 86)));
  // Thin tubes need at least ~4 cells around, or cells wrap the tube and gates can't be measured.
  if (shape.isTube) targetCells = Math.max(targetCells, Math.round(totalArea / ((2 * Math.PI * shape.tubeRadius) / 4) ** 2));
  const siteVerts = [Math.floor(rand() * vertCount)];

  const distArr = new Float64Array(vertCount);
  const ownerArr = new Int32Array(vertCount);
  const heapNodes = new Int32Array(vertCount * 4 + 64);
  const heapKeys = new Float64Array(vertCount * 4 + 64);

  function relaxDijkstraHeap(initialSize) {
    let heapSize = initialSize;
    const push = (node, key) => {
      let i = heapSize++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapKeys[parent] <= key) break;
        heapNodes[i] = heapNodes[parent];
        heapKeys[i] = heapKeys[parent];
        i = parent;
      }
      heapNodes[i] = node;
      heapKeys[i] = key;
    };
    const pop = () => {
      const topNode = heapNodes[0];
      const lastNode = heapNodes[--heapSize];
      const lastKey = heapKeys[heapSize];
      let i = 0;
      while ((i << 1) + 1 < heapSize) {
        let child = (i << 1) + 1;
        if (child + 1 < heapSize && heapKeys[child + 1] < heapKeys[child]) child++;
        if (lastKey <= heapKeys[child]) break;
        heapNodes[i] = heapNodes[child];
        heapKeys[i] = heapKeys[child];
        i = child;
      }
      if (heapSize > 0) {
        heapNodes[i] = lastNode;
        heapKeys[i] = lastKey;
      }
      return topNode;
    };

    while (heapSize > 0) {
      const u = pop();
      const du = distArr[u];
      const neighbors = adjVerts[u];
      const weights = adjWeights[u];
      for (let k = 0; k < neighbors.length; k++) {
        const w = neighbors[k];
        const nextDist = du + weights[k];
        if (nextDist + 1e-12 < distArr[w]) {
          distArr[w] = nextDist;
          ownerArr[w] = ownerArr[u];
          push(w, nextDist);
        }
      }
    }
  }

  function runMultiSourceDijkstra(seeds) {
    distArr.fill(Infinity);
    ownerArr.fill(-1);
    let initSize = 0;
    for (let s = 0; s < seeds.length; s++) {
      const v = seeds[s];
      if (distArr[v] === 0) continue;
      distArr[v] = 0;
      ownerArr[v] = s;
      let i = initSize++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapKeys[parent] <= 0) break;
        heapNodes[i] = heapNodes[parent];
        heapKeys[i] = heapKeys[parent];
        i = parent;
      }
      heapNodes[i] = v;
      heapKeys[i] = 0;
    }
    relaxDijkstraHeap(initSize);
  }

  // Incremental farthest-point seeding along the manifold: only relaxes the new seed's local basin each step!
  runMultiSourceDijkstra(siteVerts);
  while (siteVerts.length < targetCells) {
    let farthestVert = 0;
    let maxDist = -1;
    for (let v = 0; v < vertCount; v++) {
      const jittered = distArr[v] * (0.96 + 0.08 * rand());
      if (jittered > maxDist) {
        maxDist = jittered;
        farthestVert = v;
      }
    }
    const sIdx = siteVerts.length;
    siteVerts.push(farthestVert);
    if (distArr[farthestVert] > 0) {
      distArr[farthestVert] = 0;
      ownerArr[farthestVert] = sIdx;
      heapNodes[0] = farthestVert;
      heapKeys[0] = 0;
      relaxDijkstraHeap(1);
    }
  }

  // Intrinsic Lloyd relaxation on the mesh with single-pass O(V) centroid snapping.
  const sumX = new Float64Array(targetCells);
  const sumY = new Float64Array(targetCells);
  const sumZ = new Float64Array(targetCells);
  const centX = new Float64Array(targetCells);
  const centY = new Float64Array(targetCells);
  const centZ = new Float64Array(targetCells);
  const bestDistSq = new Float64Array(targetCells);
  const counts = new Int32Array(targetCells);
  const proj = new Float64Array(6);

  for (let iter = 0; iter < 4; iter++) {
    if (iter > 0) runMultiSourceDijkstra(siteVerts);
    sumX.fill(0);
    sumY.fill(0);
    sumZ.fill(0);
    counts.fill(0);
    for (let v = 0; v < vertCount; v++) {
      const s = ownerArr[v];
      if (s < 0) continue;
      sumX[s] += pos[v * 3];
      sumY[s] += pos[v * 3 + 1];
      sumZ[s] += pos[v * 3 + 2];
      counts[s]++;
    }
    for (let s = 0; s < targetCells; s++) {
      if (counts[s] === 0) continue;
      shape.project(sumX[s] / counts[s], sumY[s] / counts[s], sumZ[s] / counts[s], proj);
      centX[s] = proj[0];
      centY[s] = proj[1];
      centZ[s] = proj[2];
    }
    bestDistSq.fill(Infinity);
    for (let v = 0; v < vertCount; v++) {
      const s = ownerArr[v];
      if (s < 0 || counts[s] === 0) continue;
      const dSq =
        (pos[v * 3] - centX[s]) ** 2 +
        (pos[v * 3 + 1] - centY[s]) ** 2 +
        (pos[v * 3 + 2] - centZ[s]) ** 2;
      if (dSq < bestDistSq[s]) {
        bestDistSq[s] = dSq;
        siteVerts[s] = v;
      }
    }
  }
  runMultiSourceDijkstra(siteVerts);

  // Extract trivalent junction vertices from triangles where 3 distinct site labels meet,
  // and trace the dual boundary graph around every region.
  const junctionPos = [];
  const triJunctionId = new Int32Array(triCount).fill(-1);
  const triEdgeNeighbors = new Int32Array(triCount * 3).fill(-1);
  const halfEdgeMap = new Map();

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const va = idx[t * 3 + k];
      const vb = idx[t * 3 + ((k + 1) % 3)];
      halfEdgeMap.set(`${va}_${vb}`, t * 3 + k);
    }
  }
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const va = idx[t * 3 + k];
      const vb = idx[t * 3 + ((k + 1) % 3)];
      const opp = halfEdgeMap.get(`${vb}_${va}`);
      if (opp !== undefined) {
        triEdgeNeighbors[t * 3 + k] = Math.floor(opp / 3);
      }
    }

    const la = ownerArr[idx[t * 3]];
    const lb = ownerArr[idx[t * 3 + 1]];
    const lc = ownerArr[idx[t * 3 + 2]];
    if (la !== lb && lb !== lc && lc !== la) {
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      shape.project(
        (pos[a] + pos[b] + pos[c]) / 3,
        (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3,
        (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3,
        proj,
      );
      triJunctionId[t] = junctionPos.length;
      junctionPos.push([proj[0], proj[1], proj[2]]);
    }
  }

  // For each cell r, walk each directed boundary half-edge leaving a 3-label triangle where region r sits on the left.
  const cellNextJunction = Array.from({ length: targetCells }, () => new Map());
  for (let t = 0; t < triCount; t++) {
    const jStart = triJunctionId[t];
    if (jStart < 0) continue;
    for (let k = 0; k < 3; k++) {
      const va = idx[t * 3 + k];
      const vb = idx[t * 3 + ((k + 1) % 3)];
      const rLeft = ownerArr[va];
      const rRight = ownerArr[vb];
      if (rLeft === rRight) continue;

      // Follow the boundary between rLeft and rRight out across edge (va, vb) until hitting the next 3-label triangle.
      let currTri = triEdgeNeighbors[t * 3 + k];
      let guard = 0;
      while (currTri >= 0 && triJunctionId[currTri] < 0 && guard++ < vertCount) {
        let nextTri = -1;
        for (let e = 0; e < 3; e++) {
          const ea = idx[currTri * 3 + e];
          const eb = idx[currTri * 3 + ((e + 1) % 3)];
          if (ownerArr[ea] === rLeft && ownerArr[eb] === rRight) {
            nextTri = triEdgeNeighbors[currTri * 3 + e];
            break;
          }
        }
        currTri = nextTri;
      }
      if (currTri >= 0 && triJunctionId[currTri] >= 0) {
        cellNextJunction[rLeft].set(jStart, triJunctionId[currTri]);
      }
    }
  }

  const rawRings = [];
  for (let s = 0; s < targetCells; s++) {
    const nextMap = cellNextJunction[s];
    if (nextMap.size < 3) continue;
    const startJ = nextMap.keys().next().value;
    const ring = [];
    let curr = startJ;
    for (let step = 0; step <= nextMap.size; step++) {
      ring.push(curr);
      curr = nextMap.get(curr);
      if (curr === undefined || curr === startJ) break;
    }
    if (curr === startJ && ring.length >= 3) {
      rawRings.push(ring);
    }
  }

  // Iteratively collapse short Voronoi edges so sliver gates cannot pinch corridors.
  const expectedSpacing = Math.sqrt(Math.max(2.5, totalArea) / targetCells);
  const minEdgeLen = expectedSpacing * 0.46;
  function collapseShortVoronoiEdges(rings, passes) {
    let currentRings = rings;
    const parent = Int32Array.from({ length: junctionPos.length }, (_, i) => i);
    const findRoot = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let pass = 0; pass < passes; pass++) {
      let mergedAny = false;
      for (const ring of currentRings) {
        for (let k = 0; k < ring.length; k++) {
          const a = findRoot(ring[k]);
          const b = findRoot(ring[(k + 1) % ring.length]);
          if (a !== b && dist3(junctionPos[a], junctionPos[b]) < minEdgeLen) {
            const mid = [
              (junctionPos[a][0] + junctionPos[b][0]) * 0.5,
              (junctionPos[a][1] + junctionPos[b][1]) * 0.5,
              (junctionPos[a][2] + junctionPos[b][2]) * 0.5,
            ];
            shape.project(mid[0], mid[1], mid[2], proj);
            junctionPos[a] = [proj[0], proj[1], proj[2]];
            parent[b] = a;
            mergedAny = true;
          }
        }
      }
      currentRings = currentRings
        .map((ring) => {
          const dedup = [];
          for (const v of ring) {
            const root = findRoot(v);
            if (dedup.length === 0 || dedup[dedup.length - 1] !== root) dedup.push(root);
          }
          if (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();
          return dedup;
        })
        .filter((ring) => ring.length >= 3);
      if (!mergedAny) break;
    }
    return currentRings;
  }

  let remappedRings = collapseShortVoronoiEdges(rawRings, 4);

  // Relax Voronoi corners toward the centroid of their incident cell centers so junctions meet cleanly near 120 deg.
  for (let relax = 0; relax < 3; relax++) {
    const cellCenters = remappedRings.map((ring) => {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const v of ring) {
        cx += junctionPos[v][0];
        cy += junctionPos[v][1];
        cz += junctionPos[v][2];
      }
      shape.project(cx / ring.length, cy / ring.length, cz / ring.length, proj);
      return [proj[0], proj[1], proj[2]];
    });
    const vSumX = new Float64Array(junctionPos.length);
    const vSumY = new Float64Array(junctionPos.length);
    const vSumZ = new Float64Array(junctionPos.length);
    const vDeg = new Int32Array(junctionPos.length);
    for (let c = 0; c < remappedRings.length; c++) {
      const cc = cellCenters[c];
      for (const v of remappedRings[c]) {
        vSumX[v] += cc[0];
        vSumY[v] += cc[1];
        vSumZ[v] += cc[2];
        vDeg[v]++;
      }
    }
    for (let v = 0; v < junctionPos.length; v++) {
      if (vDeg[v] < 2) continue;
      const mx = junctionPos[v][0] * 0.4 + (vSumX[v] / vDeg[v]) * 0.6;
      const my = junctionPos[v][1] * 0.4 + (vSumY[v] / vDeg[v]) * 0.6;
      const mz = junctionPos[v][2] * 0.4 + (vSumZ[v] / vDeg[v]) * 0.6;
      shape.project(mx, my, mz, proj);
      junctionPos[v] = [proj[0], proj[1], proj[2]];
    }
  }

  remappedRings = collapseShortVoronoiEdges(remappedRings, 2);
  return finalizeComplex(shape, junctionPos, remappedRings);
}

// ---------------------------------------------------------------------------
// 4. Maze Generation Algorithms & Diameter Pathing
// ---------------------------------------------------------------------------
function generateMazePassages(complex, shape, algorithm, rand, passableEdgeMask) {
  const cellCount = complex.cells.length;
  const openEdgeSet = new Set();

  // Adjacency restricted to passable edges.
  const cellAdj = Array.from({ length: cellCount }, () => []);
  for (const edge of complex.edges) {
    if (!passableEdgeMask[edge.id] || edge.c0 < 0 || edge.c1 < 0) continue;
    cellAdj[edge.c0].push({ neighbor: edge.c1, edgeId: edge.id });
    cellAdj[edge.c1].push({ neighbor: edge.c0, edgeId: edge.id });
  }

  let firstMajorCell = 0;
  while (firstMajorCell < cellCount && (complex.cells[firstMajorCell].isChamfer || complex.cells[firstMajorCell].sliver)) firstMajorCell++;
  if (firstMajorCell >= cellCount) firstMajorCell = 0;

  const pickMajorSeed = () => {
    let idx = Math.floor(rand() * cellCount);
    for (let s = 0; s < cellCount && (complex.cells[idx].isChamfer || complex.cells[idx].sliver); s++) {
      idx = (idx + 1) % cellCount;
    }
    return idx;
  };

  if (algorithm === "kruskal") {
    const parent = Int32Array.from({ length: cellCount }, (_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const candidateEdges = complex.edges
      .filter((e) => passableEdgeMask[e.id] && e.c0 >= 0 && e.c1 >= 0)
      .map((e) => ({ edge: e, weight: rand() }));
    candidateEdges.sort((a, b) => a.weight - b.weight);
    for (const { edge } of candidateEdges) {
      const ra = find(edge.c0);
      const rb = find(edge.c1);
      if (ra !== rb) {
        parent[rb] = ra;
        openEdgeSet.add(edge.id);
      }
    }
  } else if (algorithm === "rings") {
    // Weighted Prim prioritizing level-contour edges along shape.ringScalar.
    const scalarAtCell = complex.cells.map((c) => shape.ringScalar(c.center[0], c.center[1], c.center[2]));
    const visited = new Uint8Array(cellCount);
    const startCell = pickMajorSeed();
    visited[startCell] = 1;
    const frontier = [];
    const addFrontier = (cIdx) => {
      for (const { neighbor, edgeId } of cellAdj[cIdx]) {
        if (visited[neighbor]) continue;
        let diff = Math.abs(scalarAtCell[cIdx] - scalarAtCell[neighbor]);
        if (shape.genus === 1 && diff > Math.PI) diff = Math.PI * 2 - diff;
        // Small diff = along the ring (low cost); large diff = radial cross-gate (high cost).
        const cost = diff * 8.5 + rand() * 0.35;
        frontier.push({ from: cIdx, to: neighbor, edgeId, cost });
      }
    };
    addFrontier(startCell);
    while (frontier.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < frontier.length; i++) {
        if (frontier[i].cost < frontier[bestIdx].cost) bestIdx = i;
      }
      const chosen = frontier[bestIdx];
      frontier[bestIdx] = frontier[frontier.length - 1];
      frontier.pop();
      if (visited[chosen.to]) continue;
      visited[chosen.to] = 1;
      openEdgeSet.add(chosen.edgeId);
      addFrontier(chosen.to);
    }
  } else {
    // Recursive backtracker with smooth forward-direction momentum (used by "backtracker" and as base for "braided").
    const visited = new Uint8Array(cellCount);
    const startCell = pickMajorSeed();
    visited[startCell] = 1;
    const stack = [{ cell: startCell, dir: [0, 0, 0] }];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const curr = complex.cells[top.cell];
      const options = [];
      for (const { neighbor, edgeId } of cellAdj[top.cell]) {
        if (visited[neighbor]) continue;
        const nextCenter = complex.cells[neighbor].center;
        const stepDir = normalize3(
          nextCenter[0] - curr.center[0],
          nextCenter[1] - curr.center[1],
          nextCenter[2] - curr.center[2],
        );
        const forwardAlign = dot3(stepDir, top.dir);
        const score = rand() + 0.38 * forwardAlign;
        options.push({ neighbor, edgeId, stepDir, score });
      }
      if (options.length === 0) {
        stack.pop();
        continue;
      }
      options.sort((a, b) => b.score - a.score);
      const pick = options[0];
      visited[pick.neighbor] = 1;
      openEdgeSet.add(pick.edgeId);
      stack.push({ cell: pick.neighbor, dir: pick.stepDir });
    }
  }

  // Ensure any isolated non-chamfer components (if passable filter split a narrow corner) are bridged.
  const compVisited = new Uint8Array(cellCount);
  let targetMajorCount = 0;
  for (let c = 0; c < cellCount; c++) {
    if ((complex.cells[c].isChamfer || complex.cells[c].sliver)) compVisited[c] = 2;
    else targetMajorCount++;
  }
  const bfsQueue = [firstMajorCell];
  compVisited[firstMajorCell] = 1;
  let head = 0;
  while (head < bfsQueue.length) {
    const u = bfsQueue[head++];
    for (const edgeId of complex.cells[u].edgeIds) {
      if (!openEdgeSet.has(edgeId)) continue;
      const edge = complex.edges[edgeId];
      const v = edge.c0 === u ? edge.c1 : edge.c0;
      if (v >= 0 && compVisited[v] === 0) {
        compVisited[v] = 1;
        bfsQueue.push(v);
      }
    }
  }
  if (bfsQueue.length < targetMajorCount) {
    // Bridge remaining non-chamfer cells via widest shared edges.
    let changed = true;
    while (changed) {
      changed = false;
      let bestEdge = null;
      for (const edge of complex.edges) {
        if (edge.c0 < 0 || edge.c1 < 0) continue;
        const s0 = compVisited[edge.c0];
        const s1 = compVisited[edge.c1];
        if (s0 === 2 || s1 === 2) continue;
        if (s0 !== s1) {
          if (!bestEdge || edge.length > bestEdge.length) bestEdge = edge;
        }
      }
      if (bestEdge) {
        openEdgeSet.add(bestEdge.id);
        const newlyReached = compVisited[bestEdge.c0] === 1 ? bestEdge.c1 : bestEdge.c0;
        const subQ = [newlyReached];
        compVisited[newlyReached] = 1;
        while (subQ.length > 0) {
          const u = subQ.pop();
          for (const eId of complex.cells[u].edgeIds) {
            if (!openEdgeSet.has(eId)) continue;
            const e = complex.edges[eId];
            const v = e.c0 === u ? e.c1 : e.c0;
            if (v >= 0 && compVisited[v] === 0) {
              compVisited[v] = 1;
              subQ.push(v);
            }
          }
        }
        changed = true;
      }
    }
  }

  // Braided labyrinth: open dead-ends into circuits, preferring edges that form larger loops.
  if (algorithm === "braided") {
    const degree = new Int32Array(cellCount);
    for (const edgeId of openEdgeSet) {
      const e = complex.edges[edgeId];
      if (e.c0 >= 0 && e.c1 >= 0) {
        degree[e.c0]++;
        degree[e.c1]++;
      }
    }
    const deadEnds = [];
    for (let c = 0; c < cellCount; c++) {
      if (degree[c] === 1) deadEnds.push(c);
    }
    // Shuffle dead-ends deterministically.
    for (let i = deadEnds.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [deadEnds[i], deadEnds[j]] = [deadEnds[j], deadEnds[i]];
    }
    for (const c of deadEnds) {
      if (degree[c] > 1 || rand() < 0.12) continue;
      let bestCandidate = null;
      let bestScore = -1;
      for (const { neighbor, edgeId } of cellAdj[c]) {
        if (openEdgeSet.has(edgeId)) continue;
        if (passableEdgeMask && !passableEdgeMask[edgeId]) continue;
        const score = (degree[neighbor] === 1 ? 2.0 : 1.0) + rand() * 0.5;
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = { neighbor, edgeId };
        }
      }
      if (bestCandidate) {
        openEdgeSet.add(bestCandidate.edgeId);
        degree[c]++;
        degree[bestCandidate.neighbor]++;
      }
    }
  }

  return openEdgeSet;
}

function bfsDistances(complex, openEdgeSet, sourceCell, passageByEdge = null, minEndpointInradius = 0) {
  const n = complex.cells.length;
  const dist = new Int32Array(n).fill(-1);
  const parentCell = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[sourceCell] = 0;
  queue[tail++] = sourceCell;
  let farthestCell = sourceCell;
  const eligible = (id) => !complex.cells[id].isChamfer && complex.cells[id].inradius >= minEndpointInradius;

  while (head < tail) {
    const u = queue[head++];
    if (eligible(u) && (!eligible(farthestCell) || dist[u] > dist[farthestCell])) {
      farthestCell = u;
    }
    const edgeIds = passageByEdge
      ? complex.cells[u].edgeIds.slice().sort((a, b) => (passageByEdge.get(b)?.halfSpan ?? 0) - (passageByEdge.get(a)?.halfSpan ?? 0))
      : complex.cells[u].edgeIds;
    for (const edgeId of edgeIds) {
      if (!openEdgeSet.has(edgeId)) continue;
      const edge = complex.edges[edgeId];
      const v = edge.c0 === u ? edge.c1 : edge.c0;
      if (v >= 0 && dist[v] === -1) {
        dist[v] = dist[u] + 1;
        parentCell[v] = u;
        queue[tail++] = v;
      }
    }
  }
  return { dist, parentCell, farthestCell };
}

// ---------------------------------------------------------------------------
// 5. Floor Shell + Zero-Z-Fighting Mitered Bevelled Wall Mesher
// ---------------------------------------------------------------------------
// Flat zero-allocation 3D CSR spatial grid constants (covers [-1.54, +1.54]^3 at 0.11 cell resolution).
const GRID_RES = 28;
const GRID_HALF = 1.54;
const GRID_INV = GRID_RES / (GRID_HALF * 2);

function gridCellAt(x, y, z) {
  let gx = ((x + GRID_HALF) * GRID_INV) | 0;
  let gy = ((y + GRID_HALF) * GRID_INV) | 0;
  let gz = ((z + GRID_HALF) * GRID_INV) | 0;
  if (gx < 0) gx = 0;
  else if (gx >= GRID_RES) gx = GRID_RES - 1;
  if (gy < 0) gy = 0;
  else if (gy >= GRID_RES) gy = GRID_RES - 1;
  if (gz < 0) gz = 0;
  else if (gz >= GRID_RES) gz = GRID_RES - 1;
  return (gz * GRID_RES + gy) * GRID_RES + gx;
}

function buildFloorGeometry(
  shapeName,
  startCell,
  goalCell,
  pocketRadius,
  marbleRadius,
  wallHalfWidth,
  capsuleData,
  gridOffsets,
  gridItems,
  lowDetail = false,
) {
  const mesh = buildShapeMesh(shapeName, lowDetail ? 30 : 64);
  const pos = mesh.position;
  const analyticNor = new Float32Array(mesh.normal);
  const nor = mesh.normal;
  const vertCount = pos.length / 3;
  const wallDistAttr = new Float32Array(vertCount);
  const wallFarAttr = new Float32Array(vertCount);
  const pocketBlend = new Float32Array(vertCount);

  const startCenter = startCell.center;
  const goalCenter = goalCell.center;
  const goalInnerR = pocketRadius * 0.96;
  const goalOuterR = pocketRadius * 1.85;
  const startOuterR = pocketRadius * 1.18;
  const goalDepth = marbleRadius * 0.76;
  const startDepth = marbleRadius * 0.22;
  const maxChannelSpan = Math.max(wallHalfWidth * 3.2, marbleRadius * 1.55);

  for (let i = 0; i < vertCount; i++) {
    const px = pos[i * 3];
    const py = pos[i * 3 + 1];
    const pz = pos[i * 3 + 2];
    const nx = nor[i * 3];
    const ny = nor[i * 3 + 1];
    const nz = nor[i * 3 + 2];

    // Exact O(1) CSR grid lookup — zero string allocations, zero 27-neighbor loops!
    const cellIdx = gridCellAt(px, py, pz);
    const startIdx = gridOffsets[cellIdx];
    const endIdx = gridOffsets[cellIdx + 1];
    let minSq = Infinity;
    for (let k = startIdx; k < endIdx; k++) {
      const base = gridItems[k] * 12;
      const ax = capsuleData[base];
      const ay = capsuleData[base + 1];
      const az = capsuleData[base + 2];
      const ex = capsuleData[base + 6] - ax;
      const ey = capsuleData[base + 7] - ay;
      const ez = capsuleData[base + 8] - az;
      const eLenSq = ex * ex + ey * ey + ez * ez;
      const t = eLenSq > 1e-12
        ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / eLenSq))
        : 0;
      const cnx = capsuleData[base + 3] + (capsuleData[base + 9] - capsuleData[base + 3]) * t;
      const cny = capsuleData[base + 4] + (capsuleData[base + 10] - capsuleData[base + 4]) * t;
      const cnz = capsuleData[base + 5] + (capsuleData[base + 11] - capsuleData[base + 5]) * t;
      if (cnx * nx + cny * ny + cnz * nz < -0.36) continue;
      const dSq = (px - (ax + ex * t)) ** 2 + (py - (ay + ey * t)) ** 2 + (pz - (az + ez * t)) ** 2;
      if (dSq < minSq) minSq = dSq;
    }
    const clearDist = Math.max(0, Math.sqrt(minSq) - wallHalfWidth);
    wallDistAttr[i] = Math.min(1, clearDist / maxChannelSpan);
    wallFarAttr[i] = Math.min(1, clearDist);

    const dGoal = Math.hypot(px - goalCenter[0], py - goalCenter[1], pz - goalCenter[2]);
    const dStart = Math.hypot(px - startCenter[0], py - startCenter[1], pz - startCenter[2]);

    let dip = 0;
    let pMask = 0;
    if (dGoal < goalOuterR * 1.12) {
      const fade = 1 - Math.max(0, (dGoal - goalOuterR * 0.86) / (goalOuterR * 0.26));
      pMask = Math.max(pMask, fade * fade * (3 - 2 * fade));
      if (dGoal < goalOuterR) {
        // Wide turned funnel bevel gently drawing into the deep Goal cup!
        const f = 1 - dGoal / goalOuterR;
        dip = -marbleRadius * 0.15 * f * f * (3 - 2 * f);
        if (dGoal < goalInnerR) {
          const u = dGoal / goalInnerR;
          dip -= (goalDepth - marbleRadius * 0.15) * Math.cos(u * Math.PI * 0.5) ** 1.35;
        }
      }
    }

    if (dStart < startOuterR * 1.15) {
      const fade = 1 - Math.max(0, (dStart - pocketRadius * 0.75) / (startOuterR * 1.15 - pocketRadius * 0.75));
      pMask = Math.max(pMask, fade * fade * (3 - 2 * fade));
      if (dStart < startOuterR && dStart < pocketRadius * 0.85) {
        const u = dStart / (pocketRadius * 0.85);
        dip -= startDepth * (1 - u * u);
      }
    }
    pocketBlend[i] = pMask;

    pos[i * 3] = px + nx * dip;
    pos[i * 3 + 1] = py + ny * dip;
    pos[i * 3 + 2] = pz + nz * dip;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new BufferAttribute(nor, 3));
  geometry.setAttribute("floorWallDist", new BufferAttribute(wallDistAttr, 1));
  geometry.setAttribute("floorWallFar", new BufferAttribute(wallFarAttr, 1));
  geometry.setIndex(new BufferAttribute(mesh.index, 1));
  geometry.computeVertexNormals();
  // Preserve exact analytic surface normals everywhere outside the dipped Start/Goal dishes so faces & bevels never facet!
  const computedNor = geometry.getAttribute("normal").array;
  for (let i = 0; i < vertCount; i++) {
    const b = pocketBlend[i];
    const i3 = i * 3;
    if (b <= 1e-4) {
      computedNor[i3] = analyticNor[i3];
      computedNor[i3 + 1] = analyticNor[i3 + 1];
      computedNor[i3 + 2] = analyticNor[i3 + 2];
    } else if (b < 0.9999) {
      const mx = analyticNor[i3] * (1 - b) + computedNor[i3] * b;
      const my = analyticNor[i3 + 1] * (1 - b) + computedNor[i3 + 1] * b;
      const mz = analyticNor[i3 + 2] * (1 - b) + computedNor[i3 + 2] * b;
      const ml = Math.hypot(mx, my, mz) || 1;
      computedNor[i3] = mx / ml;
      computedNor[i3 + 1] = my / ml;
      computedNor[i3 + 2] = mz / ml;
    }
  }
  return geometry;
}

// Builds a smooth 5-station rounded half-round golden inlay wire mesh along the solution spline!
function buildHintRibbonGeometry(points, shape, marbleRadius) {
  const n = points.length;
  const g = new BufferGeometry();
  if (n < 2) {
    g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute("surfNormal", new BufferAttribute(new Float32Array(9), 3));
    return g;
  }

  const halfW = Math.min(0.016, Math.max(0.0052, marbleRadius * 0.22));
  const crownH = 0.0032;
  const edgeH = 0.0009;
  const cols = 5;
  const profileU = [-1, -0.56, 0, 0.56, 1];
  const profileH = [edgeH, edgeH + (crownH - edgeH) * 0.72, crownH, edgeH + (crownH - edgeH) * 0.72, edgeH];
  const profileNx = [-0.62, -0.32, 0, 0.32, 0.62];
  const profileNy = [0.78, 0.95, 1, 0.95, 0.78];

  const pos = new Float32Array(n * cols * 3);
  const nor = new Float32Array(n * cols * 3);
  const surfNor = new Float32Array(n * cols * 3);
  const idx = new Uint32Array((n - 1) * (cols - 1) * 6);
  const proj = new Float64Array(6);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    shape.project(p[0], p[1], p[2], proj);
    const nx = proj[3];
    const ny = proj[4];
    const nz = proj[5];

    const pPrev = points[Math.max(0, i - 1)];
    const pNext = points[Math.min(n - 1, i + 1)];
    let tx = pNext[0] - pPrev[0];
    let ty = pNext[1] - pPrev[1];
    let tz = pNext[2] - pPrev[2];
    const dotN = tx * nx + ty * ny + tz * nz;
    tx -= nx * dotN;
    ty -= ny * dotN;
    tz -= nz * dotN;
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;

    const sx = ny * tz - nz * ty;
    const sy = nz * tx - nx * tz;
    const sz = nx * ty - ny * tx;

    const taper = Math.min(1, Math.min(i, n - 1 - i) / 5);
    const w = halfW * (0.25 + 0.75 * taper);

    for (let c = 0; c < cols; c++) {
      const base = (i * cols + c) * 3;
      const u = profileU[c] * w;
      const h = profileH[c];
      pos[base] = proj[0] + sx * u + nx * h;
      pos[base + 1] = proj[1] + sy * u + ny * h;
      pos[base + 2] = proj[2] + sz * u + nz * h;

      const [vnx, vny, vnz] = normalize3(
        sx * profileNx[c] + nx * profileNy[c],
        sy * profileNx[c] + ny * profileNy[c],
        sz * profileNx[c] + nz * profileNy[c],
      );
      nor[base] = vnx;
      nor[base + 1] = vny;
      nor[base + 2] = vnz;

      surfNor[base] = nx;
      surfNor[base + 1] = ny;
      surfNor[base + 2] = nz;
    }
  }

  let out = 0;
  for (let i = 0; i < n - 1; i++) {
    const rowA = i * cols;
    const rowB = (i + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a0 = rowA + c;
      const a1 = a0 + 1;
      const b0 = rowB + c;
      const b1 = b0 + 1;
      // Front-facing outward winding: (b0 - a0) x (a1 - a0) = t x s = +surfNormal!
      idx[out++] = a0;
      idx[out++] = b0;
      idx[out++] = b1;
      idx[out++] = a0;
      idx[out++] = b1;
      idx[out++] = a1;
    }
  }

  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nor, 3));
  g.setAttribute("surfNormal", new BufferAttribute(surfNor, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

// Finer CSR grid of wall capsules for the floor's reflection rays: each cell lists the capsules within `pad` of it.
const RENDER_GRID_RES = 40;
function packRenderGrid(capsuleData, pad) {
  const res = RENDER_GRID_RES;
  const inv = res / (GRID_HALF * 2);
  const capCount = capsuleData.length / 12;
  const cellRange = (lo, hi) => [
    Math.max(0, Math.min(res - 1, Math.floor((lo - pad + GRID_HALF) * inv))),
    Math.max(0, Math.min(res - 1, Math.floor((hi + pad + GRID_HALF) * inv))),
  ];
  const ranges = new Int32Array(capCount * 6);
  const counts = new Int32Array(res * res * res);
  for (let i = 0; i < capCount; i++) {
    const b = i * 12;
    const [x0, x1] = cellRange(Math.min(capsuleData[b], capsuleData[b + 6]), Math.max(capsuleData[b], capsuleData[b + 6]));
    const [y0, y1] = cellRange(Math.min(capsuleData[b + 1], capsuleData[b + 7]), Math.max(capsuleData[b + 1], capsuleData[b + 7]));
    const [z0, z1] = cellRange(Math.min(capsuleData[b + 2], capsuleData[b + 8]), Math.max(capsuleData[b + 2], capsuleData[b + 8]));
    ranges.set([x0, x1, y0, y1, z0, z1], i * 6);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[(z * res + y) * res + x]++;
  }
  const offsets = new Int32Array(counts.length + 1);
  for (let c = 0; c < counts.length; c++) offsets[c + 1] = offsets[c] + counts[c];
  const items = new Int32Array(offsets[counts.length]);
  const cursor = offsets.slice(0, counts.length);
  for (let i = 0; i < capCount; i++) {
    const [x0, x1, y0, y1, z0, z1] = ranges.subarray(i * 6, i * 6 + 6);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) items[cursor[(z * res + y) * res + x]++] = i;
  }
  return { offsets, items, res, half: GRID_HALF, pad };
}

// Shared two-pass flat CSR 3D spatial grid packer for wall capsules (padded up to 0.36 for 1-cell queries on large marbles).
function packWallCapsuleGrid(wallNodes, wallSegments, avgInradius) {
  const capCount = wallSegments.length;
  const capsuleData = new Float32Array(capCount * 12);
  for (let i = 0; i < capCount; i++) {
    const seg = wallSegments[i];
    const a = wallNodes[seg.n0];
    const b = wallNodes[seg.n1];
    const base = i * 12;
    capsuleData[base] = a.pos[0];
    capsuleData[base + 1] = a.pos[1];
    capsuleData[base + 2] = a.pos[2];
    capsuleData[base + 3] = a.normal[0];
    capsuleData[base + 4] = a.normal[1];
    capsuleData[base + 5] = a.normal[2];
    capsuleData[base + 6] = b.pos[0];
    capsuleData[base + 7] = b.pos[1];
    capsuleData[base + 8] = b.pos[2];
    capsuleData[base + 9] = b.normal[0];
    capsuleData[base + 10] = b.normal[1];
    capsuleData[base + 11] = b.normal[2];
  }

  const totalCells = GRID_RES * GRID_RES * GRID_RES;
  const gridCounts = new Int32Array(totalCells);
  const pad = Math.min(0.36, Math.max(0.145, avgInradius * 1.65));
  const capBounds = new Int32Array(capCount * 6);

  for (let i = 0; i < capCount; i++) {
    const base = i * 12;
    const ax = capsuleData[base];
    const ay = capsuleData[base + 1];
    const az = capsuleData[base + 2];
    const bx = capsuleData[base + 6];
    const by = capsuleData[base + 7];
    const bz = capsuleData[base + 8];
    const x0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ax, bx) - pad + GRID_HALF) * GRID_INV) | 0));
    const x1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ax, bx) + pad + GRID_HALF) * GRID_INV) | 0));
    const y0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ay, by) - pad + GRID_HALF) * GRID_INV) | 0));
    const y1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ay, by) + pad + GRID_HALF) * GRID_INV) | 0));
    const z0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(az, bz) - pad + GRID_HALF) * GRID_INV) | 0));
    const z1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(az, bz) + pad + GRID_HALF) * GRID_INV) | 0));
    const bIdx = i * 6;
    capBounds[bIdx] = x0;
    capBounds[bIdx + 1] = x1;
    capBounds[bIdx + 2] = y0;
    capBounds[bIdx + 3] = y1;
    capBounds[bIdx + 4] = z0;
    capBounds[bIdx + 5] = z1;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gy = y0; gy <= y1; gy++) {
        const row = (gz * GRID_RES + gy) * GRID_RES;
        for (let gx = x0; gx <= x1; gx++) {
          gridCounts[row + gx]++;
        }
      }
    }
  }

  const gridOffsets = new Int32Array(totalCells + 1);
  for (let c = 0; c < totalCells; c++) {
    gridOffsets[c + 1] = gridOffsets[c] + gridCounts[c];
  }
  const gridItems = new Int32Array(gridOffsets[totalCells]);
  const writeCursor = new Int32Array(gridOffsets.subarray(0, totalCells));

  for (let i = 0; i < capCount; i++) {
    const bIdx = i * 6;
    const x0 = capBounds[bIdx];
    const x1 = capBounds[bIdx + 1];
    const y0 = capBounds[bIdx + 2];
    const y1 = capBounds[bIdx + 3];
    const z0 = capBounds[bIdx + 4];
    const z1 = capBounds[bIdx + 5];
    for (let gz = z0; gz <= z1; gz++) {
      for (let gy = y0; gy <= y1; gy++) {
        const row = (gz * GRID_RES + gy) * GRID_RES;
        for (let gx = x0; gx <= x1; gx++) {
          const cell = row + gx;
          gridItems[writeCursor[cell]++] = i;
        }
      }
    }
  }

  return { wallNodes, wallSegments, capsuleData, gridOffsets, gridItems };
}

// Mode 1 ("original"): raw polygonal closed-cell boundaries directly from the tiling, projected cleanly onto curved surfaces.
function extractWallGraphOriginal(shape, complex, openEdgeSet, avgInradius, lowDetail = false) {
  const proj = new Float64Array(6);
  const wallNodes = complex.vertices.map((v) => ({
    pos: v.pos.slice(),
    normal: v.normal.slice(),
    arc: 0,
    incidents: [],
  }));
  const wallSegments = [];
  const maxCurvedSegLen = lowDetail ? 0.085 : 0.036;

  for (const edge of complex.edges) {
    if (openEdgeSet.has(edge.id)) continue;
    const vStart = complex.vertices[edge.v0];
    const vEnd = complex.vertices[edge.v1];
    const p0 = vStart.pos;
    const p1 = vEnd.pos;
    const mx = (p0[0] + p1[0]) * 0.5;
    const my = (p0[1] + p1[1]) * 0.5;
    const mz = (p0[2] + p1[2]) * 0.5;
    shape.project(mx, my, mz, proj);
    const chordSag = Math.hypot(proj[0] - mx, proj[1] - my, proj[2] - mz);
    const normalTurn = 1 - dot3(vStart.normal, vEnd.normal);
    const isCurved = chordSag > 0.0006 || normalTurn > 0.0012;
    const steps = isCurved ? Math.max(1, Math.ceil(edge.length / maxCurvedSegLen)) : 1;

    let prevNodeIdx = edge.v0;
    for (let s = 1; s <= steps; s++) {
      let nextNodeIdx = edge.v1;
      if (s < steps) {
        const t = s / steps;
        shape.project(
          p0[0] + (p1[0] - p0[0]) * t,
          p0[1] + (p1[1] - p0[1]) * t,
          p0[2] + (p1[2] - p0[2]) * t,
          proj,
        );
        nextNodeIdx = wallNodes.length;
        wallNodes.push({
          pos: [proj[0], proj[1], proj[2]],
          normal: [proj[3], proj[4], proj[5]],
          arc: edge.length * t,
          incidents: [],
        });
      }
      const segIdx = wallSegments.length;
      wallSegments.push({ n0: prevNodeIdx, n1: nextNodeIdx });
      wallNodes[prevNodeIdx].incidents.push({ segIdx, end: 0, other: nextNodeIdx });
      wallNodes[nextNodeIdx].incidents.push({ segIdx, end: 1, other: prevNodeIdx });
      prevNodeIdx = nextNodeIdx;
    }
  }

  return packWallCapsuleGrid(wallNodes, wallSegments, avgInradius);
}

// Mode 2 ("three-step"): solver -> coarse relaxer + Chaikin quadratic B-spline corner-cutting -> angle-aware RDP simplifier.
function extractWallGraphThreeStep(shape, complex, openEdgeSet, avgEdge, avgInradius, lowDetail = false) {
  const proj = new Float64Array(6);
  const totalGridCells = GRID_RES * GRID_RES * GRID_RES;

  const openCaps = [];
  let maxKeepR = 0.04;
  for (const cell of complex.cells) {
    const keepCellR = Math.min(0.24, cell.inradius * 0.74);
    if (keepCellR > maxKeepR) maxKeepR = keepCellR;
    openCaps.push(
      cell.center[0], cell.center[1], cell.center[2],
      cell.center[0], cell.center[1], cell.center[2],
      cell.normal[0], cell.normal[1], cell.normal[2],
      keepCellR,
    );
  }
  for (const edgeId of openEdgeSet) {
    const e = complex.edges[edgeId];
    if (e.c0 < 0 || e.c1 < 0) continue;
    const va = complex.vertices[e.v0].pos;
    const vb = complex.vertices[e.v1].pos;
    shape.project((va[0] + vb[0]) * 0.5, (va[1] + vb[1]) * 0.5, (va[2] + vb[2]) * 0.5, proj);
    const gx = proj[0];
    const gy = proj[1];
    const gz = proj[2];
    const gnx = proj[3];
    const gny = proj[4];
    const gnz = proj[5];
    const c0 = complex.cells[e.c0];
    const c1 = complex.cells[e.c1];
    const keepR = Math.max(0.029, Math.min(0.18, Math.min(e.length * 0.40, avgInradius * 0.76)));
    if (keepR > maxKeepR) maxKeepR = keepR;
    openCaps.push(c0.center[0], c0.center[1], c0.center[2], gx, gy, gz, gnx, gny, gnz, keepR);
    openCaps.push(gx, gy, gz, c1.center[0], c1.center[1], c1.center[2], gnx, gny, gnz, keepR);
  }

  const openCapCount = openCaps.length / 10;
  const openCapData = new Float32Array(openCaps);
  const openCounts = new Int32Array(totalGridCells);
  const openBounds = new Int32Array(openCapCount * 6);
  const openPad = maxKeepR + 0.025;

  for (let i = 0; i < openCapCount; i++) {
    const b = i * 10;
    const ax = openCapData[b];
    const ay = openCapData[b + 1];
    const az = openCapData[b + 2];
    const bx = openCapData[b + 3];
    const by = openCapData[b + 4];
    const bz = openCapData[b + 5];
    const x0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ax, bx) - openPad + GRID_HALF) * GRID_INV) | 0));
    const x1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ax, bx) + openPad + GRID_HALF) * GRID_INV) | 0));
    const y0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ay, by) - openPad + GRID_HALF) * GRID_INV) | 0));
    const y1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ay, by) + openPad + GRID_HALF) * GRID_INV) | 0));
    const z0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(az, bz) - openPad + GRID_HALF) * GRID_INV) | 0));
    const z1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(az, bz) + openPad + GRID_HALF) * GRID_INV) | 0));
    const bi = i * 6;
    openBounds[bi] = x0;
    openBounds[bi + 1] = x1;
    openBounds[bi + 2] = y0;
    openBounds[bi + 3] = y1;
    openBounds[bi + 4] = z0;
    openBounds[bi + 5] = z1;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gy = y0; gy <= y1; gy++) {
        const row = (gz * GRID_RES + gy) * GRID_RES;
        for (let gx = x0; gx <= x1; gx++) openCounts[row + gx]++;
      }
    }
  }
  const openOffsets = new Int32Array(totalGridCells + 1);
  for (let c = 0; c < totalGridCells; c++) openOffsets[c + 1] = openOffsets[c] + openCounts[c];
  const openItems = new Int32Array(openOffsets[totalGridCells]);
  const openCursor = new Int32Array(openOffsets.subarray(0, totalGridCells));
  for (let i = 0; i < openCapCount; i++) {
    const bi = i * 6;
    for (let gz = openBounds[bi + 4]; gz <= openBounds[bi + 5]; gz++) {
      for (let gy = openBounds[bi + 2]; gy <= openBounds[bi + 3]; gy++) {
        const row = (gz * GRID_RES + gy) * GRID_RES;
        for (let gx = openBounds[bi]; gx <= openBounds[bi + 1]; gx++) {
          openItems[openCursor[row + gx]++] = i;
        }
      }
    }
  }

  const repelOut = [0, 0, 0];
  function repelFromOpenCorridors(px, py, pz, pnx, pny, pnz) {
    let x = px;
    let y = py;
    let z = pz;
    const cellIdx = gridCellAt(x, y, z);
    const sIdx = openOffsets[cellIdx];
    const eIdx = openOffsets[cellIdx + 1];
    for (let k = sIdx; k < eIdx; k++) {
      const b = openItems[k] * 10;
      if (openCapData[b + 6] * pnx + openCapData[b + 7] * pny + openCapData[b + 8] * pnz < -0.22) continue;
      const ax = openCapData[b];
      const ay = openCapData[b + 1];
      const az = openCapData[b + 2];
      const ex = openCapData[b + 3] - ax;
      const ey = openCapData[b + 4] - ay;
      const ez = openCapData[b + 5] - az;
      const keepR = openCapData[b + 9];
      const lenSq = ex * ex + ey * ey + ez * ez;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / lenSq)) : 0;
      const dx = x - (ax + ex * t);
      const dy = y - (ay + ey * t);
      const dz = z - (az + ez * t);
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < keepR * keepR && dSq > 1e-14) {
        const nDot = dx * pnx + dy * pny + dz * pnz;
        const tanDist = Math.sqrt(Math.max(0, dSq - nDot * nDot));
        if (Math.abs(nDot) > 0.035 + tanDist * 0.95) continue;
        const d = Math.sqrt(dSq);
        const push = (keepR - d) / d;
        x += dx * push;
        y += dy * push;
        z += dz * push;
      }
    }
    repelOut[0] = x;
    repelOut[1] = y;
    repelOut[2] = z;
  }

  const vCount = complex.vertices.length;
  const closedAdj = Array.from({ length: vCount }, () => []);
  const closedEdges = [];
  for (const edge of complex.edges) {
    if (openEdgeSet.has(edge.id)) continue;
    const cId = closedEdges.length;
    closedEdges.push({ v0: edge.v0, v1: edge.v1 });
    closedAdj[edge.v0].push({ to: edge.v1, cId });
    closedAdj[edge.v1].push({ to: edge.v0, cId });
  }

  const coarseX = new Float64Array(vCount);
  const coarseY = new Float64Array(vCount);
  const coarseZ = new Float64Array(vCount);
  const coarseNX = new Float64Array(vCount);
  const coarseNY = new Float64Array(vCount);
  const coarseNZ = new Float64Array(vCount);
  const nextCX = new Float64Array(vCount);
  const nextCY = new Float64Array(vCount);
  const nextCZ = new Float64Array(vCount);

  for (let v = 0; v < vCount; v++) {
    const p = complex.vertices[v].pos;
    const n = complex.vertices[v].normal;
    coarseX[v] = p[0];
    coarseY[v] = p[1];
    coarseZ[v] = p[2];
    coarseNX[v] = n[0];
    coarseNY[v] = n[1];
    coarseNZ[v] = n[2];
  }

  const maxDeg2Drift = Math.min(0.09, avgInradius * 0.54);
  const maxJuncDrift = Math.min(0.05, avgInradius * 0.42);
  const maxTipDrift = Math.min(0.032, avgInradius * 0.32);

  for (let pass = 0; pass < 10; pass++) {
    for (let v = 0; v < vCount; v++) {
      const adj = closedAdj[v];
      const deg = adj.length;
      if (deg === 0) continue;
      let tx = coarseX[v];
      let ty = coarseY[v];
      let tz = coarseZ[v];

      if (deg === 2) {
        const a = adj[0].to;
        const b = adj[1].to;
        tx = tx * 0.36 + (coarseX[a] + coarseX[b]) * 0.32;
        ty = ty * 0.36 + (coarseY[a] + coarseY[b]) * 0.32;
        tz = tz * 0.36 + (coarseZ[a] + coarseZ[b]) * 0.32;
      } else if (deg >= 3) {
        let bestPairA = -1;
        let bestPairB = -1;
        let minPairDot = 1;
        for (let i = 0; i < deg; i++) {
          const ni = adj[i].to;
          const dix = coarseX[ni] - tx;
          const diy = coarseY[ni] - ty;
          const diz = coarseZ[ni] - tz;
          const li = Math.hypot(dix, diy, diz) || 1;
          for (let j = i + 1; j < deg; j++) {
            const nj = adj[j].to;
            const djx = coarseX[nj] - tx;
            const djy = coarseY[nj] - ty;
            const djz = coarseZ[nj] - tz;
            const lj = Math.hypot(djx, djy, djz) || 1;
            const dVal = (dix * djx + diy * djy + diz * djz) / (li * lj);
            if (dVal < minPairDot) {
              minPairDot = dVal;
              bestPairA = ni;
              bestPairB = nj;
            }
          }
        }
        if (minPairDot < -0.35 && bestPairA >= 0) {
          tx = tx * 0.62 + (coarseX[bestPairA] + coarseX[bestPairB]) * 0.19;
          ty = ty * 0.62 + (coarseY[bestPairA] + coarseY[bestPairB]) * 0.19;
          tz = tz * 0.62 + (coarseZ[bestPairA] + coarseZ[bestPairB]) * 0.19;
        } else {
          let sx = 0;
          let sy = 0;
          let sz = 0;
          for (let k = 0; k < deg; k++) {
            const nb = adj[k].to;
            sx += coarseX[nb];
            sy += coarseY[nb];
            sz += coarseZ[nb];
          }
          tx = tx * 0.86 + (sx / deg) * 0.14;
          ty = ty * 0.86 + (sy / deg) * 0.14;
          tz = tz * 0.86 + (sz / deg) * 0.14;
        }
      }

      repelFromOpenCorridors(tx, ty, tz, coarseNX[v], coarseNY[v], coarseNZ[v]);
      tx = repelOut[0];
      ty = repelOut[1];
      tz = repelOut[2];

      const orig = complex.vertices[v].pos;
      const dx = tx - orig[0];
      const dy = ty - orig[1];
      const dz = tz - orig[2];
      const d = Math.hypot(dx, dy, dz);
      const cap = deg === 2 ? maxDeg2Drift : deg >= 3 ? maxJuncDrift : maxTipDrift;
      if (d > cap && d > 1e-9) {
        const s = cap / d;
        tx = orig[0] + dx * s;
        ty = orig[1] + dy * s;
        tz = orig[2] + dz * s;
      }
      nextCX[v] = tx;
      nextCY[v] = ty;
      nextCZ[v] = tz;
    }

    for (let v = 0; v < vCount; v++) {
      if (closedAdj[v].length === 0) continue;
      shape.project(nextCX[v], nextCY[v], nextCZ[v], proj);
      coarseX[v] = proj[0];
      coarseY[v] = proj[1];
      coarseZ[v] = proj[2];
      coarseNX[v] = proj[3];
      coarseNY[v] = proj[4];
      coarseNZ[v] = proj[5];
    }
  }

  for (let v = 0; v < vCount; v++) {
    if (closedAdj[v].length === 0) continue;
    const cv = complex.vertices[v];
    cv.pos[0] = coarseX[v];
    cv.pos[1] = coarseY[v];
    cv.pos[2] = coarseZ[v];
    cv.normal[0] = coarseNX[v];
    cv.normal[1] = coarseNY[v];
    cv.normal[2] = coarseNZ[v];
  }

  const visitedEdge = new Uint8Array(closedEdges.length);
  const chains = [];
  for (let u = 0; u < vCount; u++) {
    if (closedAdj[u].length === 0 || closedAdj[u].length === 2) continue;
    for (const step of closedAdj[u]) {
      if (visitedEdge[step.cId]) continue;
      visitedEdge[step.cId] = 1;
      const verts = [u, step.to];
      let curr = step.to;
      while (closedAdj[curr].length === 2 && curr !== u) {
        const [e0, e1] = closedAdj[curr];
        const nextStep = !visitedEdge[e0.cId] ? e0 : !visitedEdge[e1.cId] ? e1 : null;
        if (!nextStep) break;
        visitedEdge[nextStep.cId] = 1;
        verts.push(nextStep.to);
        curr = nextStep.to;
      }
      chains.push({ verts, periodic: false });
    }
  }
  for (let cId = 0; cId < closedEdges.length; cId++) {
    if (visitedEdge[cId]) continue;
    const startE = closedEdges[cId];
    visitedEdge[cId] = 1;
    const verts = [startE.v0, startE.v1];
    let curr = startE.v1;
    while (curr !== startE.v0) {
      const adj = closedAdj[curr];
      let nextStep = null;
      for (const st of adj) {
        if (!visitedEdge[st.cId]) {
          nextStep = st;
          break;
        }
      }
      if (!nextStep) break;
      visitedEdge[nextStep.cId] = 1;
      if (nextStep.to === startE.v0) break;
      verts.push(nextStep.to);
      curr = nextStep.to;
    }
    if (verts.length >= 3) chains.push({ verts, periodic: true });
  }

  const simplifyTol = lowDetail ? 0.0022 : 0.00055;
  const maxTurnCos = Math.cos(lowDetail ? 0.16 : 0.085);
  function rdpSelect(pts, i0, i1, keepMask) {
    if (i1 <= i0 + 1) return;
    const a = pts[i0];
    const b = pts[i1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const abLenSq = abx * abx + aby * aby + abz * abz;
    let maxDist = -1;
    let splitIdx = -1;
    for (let k = i0 + 1; k < i1; k++) {
      const p = pts[k];
      let d;
      if (abLenSq > 1e-12) {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / abLenSq));
        d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
      } else {
        d = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
      }
      if (d > maxDist) {
        maxDist = d;
        splitIdx = k;
      }
    }
    let angleNeedsSplit = false;
    const mid = splitIdx > i0 ? splitIdx : (i0 + i1) >> 1;
    const pm = pts[mid];
    const d1x = pm.x - a.x;
    const d1y = pm.y - a.y;
    const d1z = pm.z - a.z;
    const d2x = b.x - pm.x;
    const d2y = b.y - pm.y;
    const d2z = b.z - pm.z;
    const l1 = Math.hypot(d1x, d1y, d1z);
    const l2 = Math.hypot(d2x, d2y, d2z);
    if (l1 > 1e-6 && l2 > 1e-6) {
      const cosTurn = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
      if (cosTurn < maxTurnCos) angleNeedsSplit = true;
    }
    if ((maxDist > simplifyTol || angleNeedsSplit) && mid > i0 && mid < i1) {
      keepMask[mid] = 1;
      rdpSelect(pts, i0, mid, keepMask);
      rdpSelect(pts, mid, i1, keepMask);
    }
  }

  const wallNodes = [];
  const wallSegments = [];
  const anchorNodeMap = new Int32Array(vCount).fill(-1);
  function getAnchorWallNode(v) {
    let idx = anchorNodeMap[v];
    if (idx >= 0) return idx;
    idx = wallNodes.length;
    wallNodes.push({
      pos: [coarseX[v], coarseY[v], coarseZ[v]],
      normal: [coarseNX[v], coarseNY[v], coarseNZ[v]],
      arc: 0,
      incidents: [],
    });
    anchorNodeMap[v] = idx;
    return idx;
  }
  function addWallSegment(n0, n1) {
    if (n0 === n1) return;
    const segIdx = wallSegments.length;
    wallSegments.push({ n0, n1 });
    wallNodes[n0].incidents.push({ segIdx, end: 0, other: n1 });
    wallNodes[n1].incidents.push({ segIdx, end: 1, other: n0 });
  }

  const maxLinearSpan = lowDetail ? 0.055 : 0.036;
  for (const chain of chains) {
    const { verts, periodic } = chain;
    const segCount = periodic ? verts.length : verts.length - 1;
    let pts = [];
    for (let s = 0; s < segCount; s++) {
      const va = verts[s];
      const vb = verts[(s + 1) % verts.length];
      const ax = coarseX[va];
      const ay = coarseY[va];
      const az = coarseZ[va];
      const anx = coarseNX[va];
      const any = coarseNY[va];
      const anz = coarseNZ[va];
      const bx = coarseX[vb];
      const by = coarseY[vb];
      const bz = coarseZ[vb];
      const bnx = coarseNX[vb];
      const bny = coarseNY[vb];
      const bnz = coarseNZ[vb];
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const sub = len > maxLinearSpan ? Math.ceil(len / maxLinearSpan) : 1;
      const limit = !periodic && s === segCount - 1 ? sub : sub - 1;
      for (let k = 0; k <= limit; k++) {
        const t = k / sub;
        pts.push({
          x: ax + (bx - ax) * t,
          y: ay + (by - ay) * t,
          z: az + (bz - az) * t,
          nx: anx + (bnx - anx) * t,
          ny: any + (bny - any) * t,
          nz: anz + (bnz - anz) * t,
        });
      }
    }

    const chaikinPasses = periodic || pts.length >= 3 ? (lowDetail ? 2 : 3) : 0;
    for (let ch = 0; ch < chaikinPasses; ch++) {
      const len = pts.length;
      if (periodic) {
        const nextPts = new Array(len * 2);
        for (let i = 0; i < len; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % len];
          nextPts[i * 2] = {
            x: a.x * 0.75 + b.x * 0.25,
            y: a.y * 0.75 + b.y * 0.25,
            z: a.z * 0.75 + b.z * 0.25,
            nx: a.nx * 0.75 + b.nx * 0.25,
            ny: a.ny * 0.75 + b.ny * 0.25,
            nz: a.nz * 0.75 + b.nz * 0.25,
          };
          nextPts[i * 2 + 1] = {
            x: a.x * 0.25 + b.x * 0.75,
            y: a.y * 0.25 + b.y * 0.75,
            z: a.z * 0.25 + b.z * 0.75,
            nx: a.nx * 0.25 + b.nx * 0.75,
            ny: a.ny * 0.25 + b.ny * 0.75,
            nz: a.nz * 0.25 + b.nz * 0.75,
          };
        }
        pts = nextPts;
      } else {
        const nextPts = [pts[0]];
        for (let i = 0; i < len - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (i > 0) {
            nextPts.push({
              x: a.x * 0.75 + b.x * 0.25,
              y: a.y * 0.75 + b.y * 0.25,
              z: a.z * 0.75 + b.z * 0.25,
              nx: a.nx * 0.75 + b.nx * 0.25,
              ny: a.ny * 0.75 + b.ny * 0.25,
              nz: a.nz * 0.75 + b.nz * 0.25,
            });
          } else {
            nextPts.push({
              x: a.x * 0.5 + b.x * 0.5,
              y: a.y * 0.5 + b.y * 0.5,
              z: a.z * 0.5 + b.z * 0.5,
              nx: a.nx * 0.5 + b.nx * 0.5,
              ny: a.ny * 0.5 + b.ny * 0.5,
              nz: a.nz * 0.5 + b.nz * 0.5,
            });
          }
          if (i < len - 2) {
            nextPts.push({
              x: a.x * 0.25 + b.x * 0.75,
              y: a.y * 0.25 + b.y * 0.75,
              z: a.z * 0.25 + b.z * 0.75,
              nx: a.nx * 0.25 + b.nx * 0.75,
              ny: a.ny * 0.25 + b.ny * 0.75,
              nz: a.nz * 0.25 + b.nz * 0.75,
            });
          } else {
            nextPts.push({
              x: a.x * 0.5 + b.x * 0.5,
              y: a.y * 0.5 + b.y * 0.5,
              z: a.z * 0.5 + b.z * 0.5,
              nx: a.nx * 0.5 + b.nx * 0.5,
              ny: a.ny * 0.5 + b.ny * 0.5,
              nz: a.nz * 0.5 + b.nz * 0.5,
            });
          }
        }
        nextPts.push(pts[len - 1]);
        pts = nextPts;
      }
    }

    const m = pts.length;
    if (m < 2) continue;

    const iStart = periodic ? 0 : 1;
    const iEnd = periodic ? m : m - 1;
    for (let pol = 0; pol < 2; pol++) {
      for (let i = iStart; i < iEnd; i++) {
        const prev = pts[(i - 1 + m) % m];
        const curr = pts[i];
        const next = pts[(i + 1) % m];
        const sx = curr.x * 0.6 + (prev.x + next.x) * 0.2;
        const sy = curr.y * 0.6 + (prev.y + next.y) * 0.2;
        const sz = curr.z * 0.6 + (prev.z + next.z) * 0.2;
        repelFromOpenCorridors(sx, sy, sz, curr.nx, curr.ny, curr.nz);
        curr.x = repelOut[0];
        curr.y = repelOut[1];
        curr.z = repelOut[2];
      }
    }
    for (let i = 0; i < m; i++) {
      const p = pts[i];
      shape.project(p.x, p.y, p.z, proj);
      p.x = proj[0];
      p.y = proj[1];
      p.z = proj[2];
      p.nx = proj[3];
      p.ny = proj[4];
      p.nz = proj[5];
    }

    if (periodic) {
      if (m < 3) continue;
      const closedPts = pts.concat([pts[0]]);
      const keep = new Uint8Array(closedPts.length);
      const q1 = Math.max(1, Math.floor(m / 3));
      const q2 = Math.max(q1 + 1, Math.floor((m * 2) / 3));
      keep[0] = 1;
      keep[q1] = 1;
      keep[q2] = 1;
      keep[m] = 1;
      rdpSelect(closedPts, 0, q1, keep);
      rdpSelect(closedPts, q1, q2, keep);
      rdpSelect(closedPts, q2, m, keep);

      const loopNodes = [];
      const firstPt = pts[0];
      for (let i = 0; i < m; i++) {
        if (!keep[i]) continue;
        const p = pts[i];
        if (loopNodes.length > 0) {
          const prevN = wallNodes[loopNodes[loopNodes.length - 1]].pos;
          if (Math.hypot(p.x - prevN[0], p.y - prevN[1], p.z - prevN[2]) < 0.011) continue;
          if (Math.hypot(p.x - firstPt.x, p.y - firstPt.y, p.z - firstPt.z) < 0.011) continue;
        }
        const nIdx = wallNodes.length;
        wallNodes.push({
          pos: [p.x, p.y, p.z],
          normal: [p.nx, p.ny, p.nz],
          arc: 0,
          incidents: [],
        });
        loopNodes.push(nIdx);
      }
      if (loopNodes.length >= 3) {
        for (let k = 0; k < loopNodes.length; k++) {
          addWallSegment(loopNodes[k], loopNodes[(k + 1) % loopNodes.length]);
        }
      }
    } else {
      const keep = new Uint8Array(m);
      keep[0] = 1;
      keep[m - 1] = 1;
      rdpSelect(pts, 0, m - 1, keep);

      const startNode = getAnchorWallNode(verts[0]);
      const endNode = getAnchorWallNode(verts[verts.length - 1]);
      const endPos = wallNodes[endNode].pos;
      let prevNode = startNode;

      for (let i = 1; i < m - 1; i++) {
        if (!keep[i]) continue;
        const p = pts[i];
        const prevPos = wallNodes[prevNode].pos;
        if (Math.hypot(p.x - prevPos[0], p.y - prevPos[1], p.z - prevPos[2]) < 0.011) continue;
        if (Math.hypot(p.x - endPos[0], p.y - endPos[1], p.z - endPos[2]) < 0.011) continue;
        const nIdx = wallNodes.length;
        wallNodes.push({
          pos: [p.x, p.y, p.z],
          normal: [p.nx, p.ny, p.nz],
          arc: 0,
          incidents: [],
        });
        addWallSegment(prevNode, nIdx);
        prevNode = nIdx;
      }
      addWallSegment(prevNode, endNode);
    }
  }

  return packWallCapsuleGrid(wallNodes, wallSegments, avgInradius);
}

// Mode 3 ("straightened"): co-relaxed dual corridor ribbons + geodesic sub-chord straightener + uniform-step Chaikin fillets.
function extractWallGraphStraightened(shape, complex, openEdgeSet, avgEdge, avgInradius, lowDetail = false) {
  const proj = new Float64Array(6);
  const totalGridCells = GRID_RES * GRID_RES * GRID_RES;

  // 1. Build coarse closed-wall graph AND movable dual open-passage skeleton (hubs + open gates),
  //    then co-relax them together so zig-zag/diamond/brick corridors straighten into true geodesics
  //    without embossing polygon-centroid dents into straight walls or pinching any doorway!
  const vCount = complex.vertices.length;
  const cellCount = complex.cells.length;
  const closedAdj = Array.from({ length: vCount }, () => []);
  const closedEdges = [];
  for (const edge of complex.edges) {
    if (openEdgeSet.has(edge.id)) continue;
    const cId = closedEdges.length;
    closedEdges.push({ v0: edge.v0, v1: edge.v1 });
    closedAdj[edge.v0].push({ to: edge.v1, cId, origLen: edge.length });
    closedAdj[edge.v1].push({ to: edge.v0, cId, origLen: edge.length });
  }

  const coarseX = new Float64Array(vCount);
  const coarseY = new Float64Array(vCount);
  const coarseZ = new Float64Array(vCount);
  const coarseNX = new Float64Array(vCount);
  const coarseNY = new Float64Array(vCount);
  const coarseNZ = new Float64Array(vCount);
  for (let v = 0; v < vCount; v++) {
    const p = complex.vertices[v].pos;
    const n = complex.vertices[v].normal;
    coarseX[v] = p[0];
    coarseY[v] = p[1];
    coarseZ[v] = p[2];
    coarseNX[v] = n[0];
    coarseNY[v] = n[1];
    coarseNZ[v] = n[2];
  }

  // Dual open-passage hubs & gates + local closed-edge lists per cell for O(1) topological barrier checks.
  const pHubX = new Float64Array(cellCount);
  const pHubY = new Float64Array(cellCount);
  const pHubZ = new Float64Array(cellCount);
  const pHubNX = new Float64Array(cellCount);
  const pHubNY = new Float64Array(cellCount);
  const pHubNZ = new Float64Array(cellCount);
  const cellOpenGates = Array.from({ length: cellCount }, () => []);
  const cellLocalClosed = Array.from({ length: cellCount }, () => []);

  for (let c = 0; c < cellCount; c++) {
    const cell = complex.cells[c];
    pHubX[c] = cell.center[0];
    pHubY[c] = cell.center[1];
    pHubZ[c] = cell.center[2];
    pHubNX[c] = cell.normal[0];
    pHubNY[c] = cell.normal[1];
    pHubNZ[c] = cell.normal[2];
  }

  const openGateEdges = [];
  for (const edgeId of openEdgeSet) {
    const e = complex.edges[edgeId];
    if (e.c0 < 0 || e.c1 < 0) continue;
    const gIdx = openGateEdges.length;
    const va = complex.vertices[e.v0].pos;
    const vb = complex.vertices[e.v1].pos;
    shape.project((va[0] + vb[0]) * 0.5, (va[1] + vb[1]) * 0.5, (va[2] + vb[2]) * 0.5, proj);
    const minCellInr = Math.min(complex.cells[e.c0].inradius, complex.cells[e.c1].inradius);
    const keepR = Math.min(
      0.20,
      Math.max(MIN_WALL_HALF_WIDTH * 2.5, Math.min(e.length * 0.40, Math.max(minCellInr * 0.66, e.length * 0.36))),
    );
    openGateEdges.push({
      edgeId,
      c0: e.c0,
      c1: e.c1,
      v0: e.v0,
      v1: e.v1,
      origX: proj[0],
      origY: proj[1],
      origZ: proj[2],
      gx: proj[0],
      gy: proj[1],
      gz: proj[2],
      gnx: proj[3],
      gny: proj[4],
      gnz: proj[5],
      keepR,
      minDoorSpan: Math.min(e.length * 0.88, Math.max(MIN_WALL_HALF_WIDTH * 4.4, avgEdge * 0.82)),
      maxShift: Math.max(e.length * 0.85, avgInradius * 1.15),
    });
    cellOpenGates[e.c0].push(gIdx);
    cellOpenGates[e.c1].push(gIdx);
  }

  // Gather closed edges of each cell + its 1-ring open neighbors so smoothed passage spines never jump across closed walls!
  for (let c = 0; c < cellCount; c++) {
    const seen = new Set();
    const pushCellClosed = (cid) => {
      for (const eId of complex.cells[cid].edgeIds) {
        if (openEdgeSet.has(eId) || seen.has(eId)) continue;
        seen.add(eId);
        const ce = complex.edges[eId];
        cellLocalClosed[c].push(ce.v0, ce.v1);
      }
    };
    pushCellClosed(c);
    for (const gIdx of cellOpenGates[c]) {
      const og = openGateEdges[gIdx];
      pushCellClosed(og.c0 === c ? og.c1 : og.c0);
    }
  }

  function pushAwayFromLocalWalls(px, py, pz, clist, minClear) {
    let x = px;
    let y = py;
    let z = pz;
    for (let i = 0; i < clist.length; i += 2) {
      const u = clist[i];
      const w = clist[i + 1];
      const ax = coarseX[u];
      const ay = coarseY[u];
      const az = coarseZ[u];
      const ex = coarseX[w] - ax;
      const ey = coarseY[w] - ay;
      const ez = coarseZ[w] - az;
      const lSq = ex * ex + ey * ey + ez * ez;
      const t = lSq > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / lSq)) : 0;
      const dx = x - (ax + ex * t);
      const dy = y - (ay + ey * t);
      const dz = z - (az + ez * t);
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minClear * minClear && dSq > 1e-14) {
        const d = Math.sqrt(dSq);
        const push = (minClear - d) / d;
        x += dx * push;
        y += dy * push;
        z += dz * push;
      }
    }
    repelOut[0] = x;
    repelOut[1] = y;
    repelOut[2] = z;
  }

  const repelOut = [0, 0, 0];
  let openCapCount = 0;
  let openCapData = new Float32Array(0);
  const openCounts = new Int32Array(totalGridCells);
  const openOffsets = new Int32Array(totalGridCells + 1);
  let openItems = new Int32Array(0);
  const openCursor = new Int32Array(totalGridCells);

  function minDistToLocalWalls(px, py, pz, clist) {
    let minSq = Infinity;
    for (let i = 0; i < clist.length; i += 2) {
      const u = clist[i];
      const w = clist[i + 1];
      const ax = coarseX[u];
      const ay = coarseY[u];
      const az = coarseZ[u];
      const ex = coarseX[w] - ax;
      const ey = coarseY[w] - ay;
      const ez = coarseZ[w] - az;
      const lSq = ex * ex + ey * ey + ez * ez;
      const t = lSq > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / lSq)) : 0;
      const dx = px - (ax + ex * t);
      const dy = py - (ay + ey * t);
      const dz = pz - (az + ez * t);
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minSq) minSq = dSq;
    }
    return Math.sqrt(minSq);
  }

  function relaxDualPassages(subPasses) {
    for (let sp = 0; sp < subPasses; sp++) {
      for (let g = 0; g < openGateEdges.length; g++) {
        const og = openGateEdges[g];
        const postMidX = (coarseX[og.v0] + coarseX[og.v1]) * 0.5;
        const postMidY = (coarseY[og.v0] + coarseY[og.v1]) * 0.5;
        const postMidZ = (coarseZ[og.v0] + coarseZ[og.v1]) * 0.5;
        const mx = (pHubX[og.c0] + pHubX[og.c1]) * 0.5;
        const my = (pHubY[og.c0] + pHubY[og.c1]) * 0.5;
        const mz = (pHubZ[og.c0] + pHubZ[og.c1]) * 0.5;
        const d0x = pHubX[og.c0] - postMidX;
        const d0y = pHubY[og.c0] - postMidY;
        const d0z = pHubZ[og.c0] - postMidZ;
        const d1x = pHubX[og.c1] - postMidX;
        const d1y = pHubY[og.c1] - postMidY;
        const d1z = pHubZ[og.c1] - postMidZ;
        const l0 = Math.hypot(d0x, d0y, d0z) || 1;
        const l1 = Math.hypot(d1x, d1y, d1z) || 1;
        const gPull = (d0x * d1x + d0y * d1y + d0z * d1z) / (l0 * l1) < -0.35 ? 0.25 : 0.0;
        shape.project(
          postMidX * (1 - gPull) + mx * gPull,
          postMidY * (1 - gPull) + my * gPull,
          postMidZ * (1 - gPull) + mz * gPull,
          proj,
        );
        og.gx = proj[0];
        og.gy = proj[1];
        og.gz = proj[2];
        og.gnx = proj[3];
        og.gny = proj[4];
        og.gnz = proj[5];
      }

      for (let c = 0; c < cellCount; c++) {
        const gates = cellOpenGates[c];
        const oDeg = gates.length;
        if (oDeg === 0) continue;
        const cell = complex.cells[c];
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let k = 0; k < oDeg; k++) {
          const og = openGateEdges[gates[k]];
          sx += og.gx;
          sy += og.gy;
          sz += og.gz;
        }
        sx /= oDeg;
        sy /= oDeg;
        sz /= oDeg;

        // Only pull oDeg === 2 hubs onto their gate chord when the two gates oppose each other (through-corridor, NEVER a U-turn around a wall tip!).
        let pull = 0.0;
        if (oDeg === 2) {
          const g0 = openGateEdges[gates[0]];
          const g1 = openGateEdges[gates[1]];
          const a0x = g0.gx - pHubX[c];
          const a0y = g0.gy - pHubY[c];
          const a0z = g0.gz - pHubZ[c];
          const a1x = g1.gx - pHubX[c];
          const a1y = g1.gy - pHubY[c];
          const a1z = g1.gz - pHubZ[c];
          const la0 = Math.hypot(a0x, a0y, a0z) || 1;
          const la1 = Math.hypot(a1x, a1y, a1z) || 1;
          const openCos = (a0x * a1x + a0y * a1y + a0z * a1z) / (la0 * la1);
          if (openCos < -0.25) pull = 0.55;
        } else if (oDeg >= 3) {
          pull = 0.30;
        }
        let nx = pHubX[c] * (1 - pull) + sx * pull;
        let ny = pHubY[c] * (1 - pull) + sy * pull;
        let nz = pHubZ[c] * (1 - pull) + sz * pull;
        if (oDeg === 1) {
          nx = cell.center[0] * 0.82 + sx * 0.18;
          ny = cell.center[1] * 0.82 + sy * 0.18;
          nz = cell.center[2] * 0.82 + sz * 0.18;
        }
        let maxGateR = cell.inradius * 0.72;
        for (let k = 0; k < oDeg; k++) {
          const og = openGateEdges[gates[k]];
          if (og.keepR > maxGateR) maxGateR = og.keepR;
        }
        const clearH = Math.min(0.20, Math.max(MIN_WALL_HALF_WIDTH * 2.35, maxGateR * 1.04));
        pushAwayFromLocalWalls(nx, ny, nz, cellLocalClosed[c], clearH);
        nx = repelOut[0];
        ny = repelOut[1];
        nz = repelOut[2];
        const maxShift = cell.inradius * 0.44;
        const dx = nx - cell.center[0];
        const dy = ny - cell.center[1];
        const dz = nz - cell.center[2];
        const d = Math.hypot(dx, dy, dz);
        if (d > maxShift && d > 1e-9) {
          const s = maxShift / d;
          nx = cell.center[0] + dx * s;
          ny = cell.center[1] + dy * s;
          nz = cell.center[2] + dz * s;
        }
        shape.project(nx, ny, nz, proj);
        const clist = cellLocalClosed[c];
        const minSafeH = clearH * 0.80;
        let segsSafe = minDistToLocalWalls(proj[0], proj[1], proj[2], clist) >= minSafeH;
        for (let k = 0; segsSafe && k < oDeg; k++) {
          const og = openGateEdges[gates[k]];
          if (
            minDistToLocalWalls(
              (proj[0] + og.gx) * 0.5,
              (proj[1] + og.gy) * 0.5,
              (proj[2] + og.gz) * 0.5,
              clist,
            ) < og.keepR * 0.82
          ) {
            segsSafe = false;
          }
        }
        if (segsSafe) {
          pHubX[c] = proj[0];
          pHubY[c] = proj[1];
          pHubZ[c] = proj[2];
          pHubNX[c] = proj[3];
          pHubNY[c] = proj[4];
          pHubNZ[c] = proj[5];
        }
      }
    }
  }

  function rebuildOpenKeepoutGrid(scaleR = 1.0) {
    const openCaps = [];
    let maxKeepR = 0.04;
    for (let c = 0; c < cellCount; c++) {
      const gates = cellOpenGates[c];
      const oDeg = gates.length;
      // Only dead-end pockets (oDeg <= 1) and tight hairpin U-turns (oDeg === 2 with openCos > -0.15) need a compact turn-apex sphere;
      // straight/gentle corridors and T-plazas use purely smooth openCaps ribbons so passing straight walls NEVER dent!
      if (oDeg >= 3) continue;
      if (oDeg === 2) {
        const g0 = openGateEdges[gates[0]];
        const g1 = openGateEdges[gates[1]];
        const a0x = g0.gx - pHubX[c];
        const a0y = g0.gy - pHubY[c];
        const a0z = g0.gz - pHubZ[c];
        const a1x = g1.gx - pHubX[c];
        const a1y = g1.gy - pHubY[c];
        const a1z = g1.gz - pHubZ[c];
        const la0 = Math.hypot(a0x, a0y, a0z) || 1;
        const la1 = Math.hypot(a1x, a1y, a1z) || 1;
        if ((a0x * a1x + a0y * a1y + a0z * a1z) / (la0 * la1) <= -0.15) continue;
      }
      const g0R = oDeg === 1 ? openGateEdges[gates[0]].keepR : 0;
      const factor = oDeg <= 1 ? 0.62 : 0.42;
      const keepCellR = Math.min(0.20, Math.max(complex.cells[c].inradius * factor, g0R * 0.88)) * scaleR;
      if (keepCellR > maxKeepR) maxKeepR = keepCellR;
      openCaps.push(
        pHubX[c], pHubY[c], pHubZ[c],
        pHubX[c], pHubY[c], pHubZ[c],
        pHubNX[c], pHubNY[c], pHubNZ[c],
        keepCellR,
      );
    }
    for (let g = 0; g < openGateEdges.length; g++) {
      const og = openGateEdges[g];
      const r = og.keepR * scaleR;
      if (r > maxKeepR) maxKeepR = r;
      shape.project(
        (pHubX[og.c0] + og.gx) * 0.5,
        (pHubY[og.c0] + og.gy) * 0.5,
        (pHubZ[og.c0] + og.gz) * 0.5,
        proj,
      );
      const m0x = proj[0];
      const m0y = proj[1];
      const m0z = proj[2];
      const m0nx = proj[3];
      const m0ny = proj[4];
      const m0nz = proj[5];
      openCaps.push(pHubX[og.c0], pHubY[og.c0], pHubZ[og.c0], m0x, m0y, m0z, m0nx, m0ny, m0nz, r);
      openCaps.push(m0x, m0y, m0z, og.gx, og.gy, og.gz, og.gnx, og.gny, og.gnz, r);

      shape.project(
        (og.gx + pHubX[og.c1]) * 0.5,
        (og.gy + pHubY[og.c1]) * 0.5,
        (og.gz + pHubZ[og.c1]) * 0.5,
        proj,
      );
      const m1x = proj[0];
      const m1y = proj[1];
      const m1z = proj[2];
      const m1nx = proj[3];
      const m1ny = proj[4];
      const m1nz = proj[5];
      openCaps.push(og.gx, og.gy, og.gz, m1x, m1y, m1z, og.gnx, og.gny, og.gnz, r);
      openCaps.push(m1x, m1y, m1z, pHubX[og.c1], pHubY[og.c1], pHubZ[og.c1], m1nx, m1ny, m1nz, r);
    }
    openCapCount = openCaps.length / 10;
    openCapData = new Float32Array(openCaps);
    openCounts.fill(0);
    const openBounds = new Int32Array(openCapCount * 6);
    const openPad = maxKeepR + 0.03;

    for (let i = 0; i < openCapCount; i++) {
      const b = i * 10;
      const ax = openCapData[b];
      const ay = openCapData[b + 1];
      const az = openCapData[b + 2];
      const bx = openCapData[b + 3];
      const by = openCapData[b + 4];
      const bz = openCapData[b + 5];
      const x0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ax, bx) - openPad + GRID_HALF) * GRID_INV) | 0));
      const x1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ax, bx) + openPad + GRID_HALF) * GRID_INV) | 0));
      const y0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(ay, by) - openPad + GRID_HALF) * GRID_INV) | 0));
      const y1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(ay, by) + openPad + GRID_HALF) * GRID_INV) | 0));
      const z0 = Math.max(0, Math.min(GRID_RES - 1, ((Math.min(az, bz) - openPad + GRID_HALF) * GRID_INV) | 0));
      const z1 = Math.max(0, Math.min(GRID_RES - 1, ((Math.max(az, bz) + openPad + GRID_HALF) * GRID_INV) | 0));
      const bi = i * 6;
      openBounds[bi] = x0;
      openBounds[bi + 1] = x1;
      openBounds[bi + 2] = y0;
      openBounds[bi + 3] = y1;
      openBounds[bi + 4] = z0;
      openBounds[bi + 5] = z1;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gy = y0; gy <= y1; gy++) {
          const row = (gz * GRID_RES + gy) * GRID_RES;
          for (let gx = x0; gx <= x1; gx++) openCounts[row + gx]++;
        }
      }
    }
    openOffsets[0] = 0;
    for (let c = 0; c < totalGridCells; c++) openOffsets[c + 1] = openOffsets[c] + openCounts[c];
    openItems = new Int32Array(openOffsets[totalGridCells]);
    openCursor.set(openOffsets.subarray(0, totalGridCells));
    for (let i = 0; i < openCapCount; i++) {
      const bi = i * 6;
      for (let gz = openBounds[bi + 4]; gz <= openBounds[bi + 5]; gz++) {
        for (let gy = openBounds[bi + 2]; gy <= openBounds[bi + 3]; gy++) {
          const row = (gz * GRID_RES + gy) * GRID_RES;
          for (let gx = openBounds[bi]; gx <= openBounds[bi + 1]; gx++) {
            openItems[openCursor[row + gx]++] = i;
          }
        }
      }
    }
  }

  function repelFromOpenCorridors(px, py, pz, pnx, pny, pnz) {
    let x = px;
    let y = py;
    let z = pz;
    const cellIdx = gridCellAt(x, y, z);
    const sIdx = openOffsets[cellIdx];
    const eIdx = openOffsets[cellIdx + 1];
    for (let k = sIdx; k < eIdx; k++) {
      const b = openItems[k] * 10;
      if (openCapData[b + 6] * pnx + openCapData[b + 7] * pny + openCapData[b + 8] * pnz < -0.22) continue;
      const ax = openCapData[b];
      const ay = openCapData[b + 1];
      const az = openCapData[b + 2];
      const ex = openCapData[b + 3] - ax;
      const ey = openCapData[b + 4] - ay;
      const ez = openCapData[b + 5] - az;
      const keepR = openCapData[b + 9];
      const lenSq = ex * ex + ey * ey + ez * ez;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / lenSq)) : 0;
      const dx = x - (ax + ex * t);
      const dy = y - (ay + ey * t);
      const dz = z - (az + ez * t);
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < keepR * keepR && dSq > 1e-14) {
        const nDot = dx * pnx + dy * pny + dz * pnz;
        const tanDist = Math.sqrt(Math.max(0, dSq - nDot * nDot));
        if (Math.abs(nDot) > 0.035 + tanDist * 0.95) continue;
        const d = Math.sqrt(dSq);
        const push = (keepR - d) / d;
        x += dx * push;
        y += dy * push;
        z += dz * push;
      }
    }
    repelOut[0] = x;
    repelOut[1] = y;
    repelOut[2] = z;
  }

  function pointClearOfOpenCorridors(x, y, z, pnx, pny, pnz, margin = 0.88) {
    const cellIdx = gridCellAt(x, y, z);
    const sIdx = openOffsets[cellIdx];
    const eIdx = openOffsets[cellIdx + 1];
    for (let k = sIdx; k < eIdx; k++) {
      const b = openItems[k] * 10;
      if (openCapData[b + 6] * pnx + openCapData[b + 7] * pny + openCapData[b + 8] * pnz < -0.22) continue;
      const ax = openCapData[b];
      const ay = openCapData[b + 1];
      const az = openCapData[b + 2];
      const ex = openCapData[b + 3] - ax;
      const ey = openCapData[b + 4] - ay;
      const ez = openCapData[b + 5] - az;
      const rSafe = openCapData[b + 9] * margin;
      const lenSq = ex * ex + ey * ey + ez * ez;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / lenSq)) : 0;
      const dx = x - (ax + ex * t);
      const dy = y - (ay + ey * t);
      const dz = z - (az + ez * t);
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < rSafe * rSafe) {
        const nDot = dx * pnx + dy * pny + dz * pnz;
        const tanDist = Math.sqrt(Math.max(0, dSq - nDot * nDot));
        if (Math.abs(nDot) > 0.035 + tanDist * 0.95) continue;
        return false;
      }
    }
    return true;
  }

  const edgeProj = new Float64Array(6);
  function incidentEdgesClear(v, cx, cy, cz, nx, ny, nz) {
    if (!pointClearOfOpenCorridors(cx, cy, cz, nx, ny, nz, 0.90)) return false;
    const adj = closedAdj[v];
    for (let k = 0; k < adj.length; k++) {
      const nb = adj[k].to;
      const bx = coarseX[nb];
      const by = coarseY[nb];
      const bz = coarseZ[nb];
      const segLen = Math.hypot(cx - bx, cy - by, cz - bz);
      const samples = Math.max(2, Math.min(6, Math.ceil(segLen / 0.04)));
      for (let s = 1; s < samples; s++) {
        const u = s / samples;
        shape.project(bx + (cx - bx) * u, by + (cy - by) * u, bz + (cz - bz) * u, edgeProj);
        if (!pointClearOfOpenCorridors(edgeProj[0], edgeProj[1], edgeProj[2], edgeProj[3], edgeProj[4], edgeProj[5], 0.86)) {
          return false;
        }
      }
    }
    return true;
  }

  // Smooth zig-zags out of the dual open-passage spine ONCE, then straighten coarse walls against that stationary ribbon!
  relaxDualPassages(8);
  rebuildOpenKeepoutGrid(1.0);

  const maxDeg2Drift = Math.min(0.46, avgInradius * 2.65);
  const maxJuncDrift = Math.min(0.28, avgInradius * 1.55);
  const maxTipDrift = Math.min(0.22, avgInradius * 1.25);

  const coarsePasses = 56;
  for (let pass = 0; pass < coarsePasses; pass++) {
    const reverseSweep = (pass & 1) === 1;
    for (let step = 0; step < vCount; step++) {
      const v = reverseSweep ? vCount - 1 - step : step;
      const adj = closedAdj[v];
      const deg = adj.length;
      if (deg === 0) continue;
      const curX = coarseX[v];
      const curY = coarseY[v];
      const curZ = coarseZ[v];
      let tx = curX;
      let ty = curY;
      let tz = curZ;

      if (deg === 2) {
        const a = adj[0].to;
        const b = adj[1].to;
        tx = (coarseX[a] + coarseX[b]) * 0.5;
        ty = (coarseY[a] + coarseY[b]) * 0.5;
        tz = (coarseZ[a] + coarseZ[b]) * 0.5;
      } else if (deg === 1) {
        // Collinearly align multi-segment stub tips that started nearly straight (< ~55 deg kink) without swinging 60/90-deg hooks into doorways!
        const nb = adj[0].to;
        const nbAdj = closedAdj[nb];
        if (nbAdj.length === 2) {
          const prev = nbAdj[0].to === v ? nbAdj[1].to : nbAdj[0].to;
          const op = complex.vertices[prev].pos;
          const onb = complex.vertices[nb].pos;
          const ov = complex.vertices[v].pos;
          const o1x = onb[0] - op[0];
          const o1y = onb[1] - op[1];
          const o1z = onb[2] - op[2];
          const o2x = ov[0] - onb[0];
          const o2y = ov[1] - onb[1];
          const o2z = ov[2] - onb[2];
          const ol1 = Math.hypot(o1x, o1y, o1z) || 1;
          const ol2 = Math.hypot(o2x, o2y, o2z) || 1;
          if ((o1x * o2x + o1y * o2y + o1z * o2z) / (ol1 * ol2) > 0.55) {
            let rx = coarseX[nb] - coarseX[prev];
            let ry = coarseY[nb] - coarseY[prev];
            let rz = coarseZ[nb] - coarseZ[prev];
            const nDot = rx * coarseNX[nb] + ry * coarseNY[nb] + rz * coarseNZ[nb];
            rx -= coarseNX[nb] * nDot;
            ry -= coarseNY[nb] * nDot;
            rz -= coarseNZ[nb] * nDot;
            const rLen = Math.hypot(rx, ry, rz);
            if (rLen > 1e-6) {
              const targetLen = adj[0].origLen;
              tx = tx * 0.25 + (coarseX[nb] + (rx / rLen) * targetLen) * 0.75;
              ty = ty * 0.25 + (coarseY[nb] + (ry / rLen) * targetLen) * 0.75;
              tz = tz * 0.25 + (coarseZ[nb] + (rz / rLen) * targetLen) * 0.75;
            }
          }
        }
      } else if (deg >= 3) {
        // Align T-junctions strongly along their most-collinear through-pair so side spokes never pull V-kinks into straight walls!
        let bestPairA = -1;
        let bestPairB = -1;
        let minPairDot = 1;
        for (let i = 0; i < deg; i++) {
          const ni = adj[i].to;
          const dix = coarseX[ni] - tx;
          const diy = coarseY[ni] - ty;
          const diz = coarseZ[ni] - tz;
          const li = Math.hypot(dix, diy, diz) || 1;
          for (let j = i + 1; j < deg; j++) {
            const nj = adj[j].to;
            const djx = coarseX[nj] - tx;
            const djy = coarseY[nj] - ty;
            const djz = coarseZ[nj] - tz;
            const lj = Math.hypot(djx, djy, djz) || 1;
            const dVal = (dix * djx + diy * djy + diz * djz) / (li * lj);
            if (dVal < minPairDot) {
              minPairDot = dVal;
              bestPairA = ni;
              bestPairB = nj;
            }
          }
        }
        if (minPairDot < -0.18 && bestPairA >= 0) {
          tx = tx * 0.12 + (coarseX[bestPairA] + coarseX[bestPairB]) * 0.44;
          ty = ty * 0.12 + (coarseY[bestPairA] + coarseY[bestPairB]) * 0.44;
          tz = tz * 0.12 + (coarseZ[bestPairA] + coarseZ[bestPairB]) * 0.44;
        } else {
          let sx = 0;
          let sy = 0;
          let sz = 0;
          for (let k = 0; k < deg; k++) {
            const nb = adj[k].to;
            sx += coarseX[nb];
            sy += coarseY[nb];
            sz += coarseZ[nb];
          }
          tx = tx * 0.78 + (sx / deg) * 0.22;
          ty = ty * 0.78 + (sy / deg) * 0.22;
          tz = tz * 0.78 + (sz / deg) * 0.22;
        }
      }

      for (let k = 0; k < deg; k++) {
        const nb = adj[k].to;
        shape.project((tx + coarseX[nb]) * 0.5, (ty + coarseY[nb]) * 0.5, (tz + coarseZ[nb]) * 0.5, edgeProj);
        repelFromOpenCorridors(edgeProj[0], edgeProj[1], edgeProj[2], edgeProj[3], edgeProj[4], edgeProj[5]);
        tx += (repelOut[0] - edgeProj[0]) * 0.65;
        ty += (repelOut[1] - edgeProj[1]) * 0.65;
        tz += (repelOut[2] - edgeProj[2]) * 0.65;
      }
      repelFromOpenCorridors(tx, ty, tz, coarseNX[v], coarseNY[v], coarseNZ[v]);
      tx = repelOut[0];
      ty = repelOut[1];
      tz = repelOut[2];

      const orig = complex.vertices[v].pos;
      const dx = tx - orig[0];
      const dy = ty - orig[1];
      const dz = tz - orig[2];
      const d = Math.hypot(dx, dy, dz);
      const cap = deg === 2 ? maxDeg2Drift : deg >= 3 ? maxJuncDrift : maxTipDrift;
      if (d > cap && d > 1e-9) {
        const s = cap / d;
        tx = orig[0] + dx * s;
        ty = orig[1] + dy * s;
        tz = orig[2] + dz * s;
        repelFromOpenCorridors(tx, ty, tz, coarseNX[v], coarseNY[v], coarseNZ[v]);
        tx = repelOut[0];
        ty = repelOut[1];
        tz = repelOut[2];
      }

      // Guarantee NO incident closed edge ever straddles an open corridor while ALWAYS keeping endpoints repelled outside openCaps!
      let accepted = false;
      let alpha = 1.0;
      for (let attempt = 0; attempt < 4; attempt++) {
        let cx = curX + (tx - curX) * alpha;
        let cy = curY + (ty - curY) * alpha;
        let cz = curZ + (tz - curZ) * alpha;
        repelFromOpenCorridors(cx, cy, cz, coarseNX[v], coarseNY[v], coarseNZ[v]);
        shape.project(repelOut[0], repelOut[1], repelOut[2], proj);
        if (incidentEdgesClear(v, proj[0], proj[1], proj[2], proj[3], proj[4], proj[5])) {
          coarseX[v] = proj[0];
          coarseY[v] = proj[1];
          coarseZ[v] = proj[2];
          coarseNX[v] = proj[3];
          coarseNY[v] = proj[4];
          coarseNZ[v] = proj[5];
          accepted = true;
          break;
        }
        alpha *= 0.45;
      }
      if (!accepted) {
        repelFromOpenCorridors(curX, curY, curZ, coarseNX[v], coarseNY[v], coarseNZ[v]);
        shape.project(repelOut[0], repelOut[1], repelOut[2], proj);
        coarseX[v] = proj[0];
        coarseY[v] = proj[1];
        coarseZ[v] = proj[2];
        coarseNX[v] = proj[3];
        coarseNY[v] = proj[4];
        coarseNZ[v] = proj[5];
      }
    }
  }

  // Write relaxed post coordinates AND smoothed corridor hubs/gates back to complex so clearance measurement starts right on the smoothed corridor spine!
  for (let v = 0; v < vCount; v++) {
    if (closedAdj[v].length === 0) continue;
    const cv = complex.vertices[v];
    cv.pos[0] = coarseX[v];
    cv.pos[1] = coarseY[v];
    cv.pos[2] = coarseZ[v];
    cv.normal[0] = coarseNX[v];
    cv.normal[1] = coarseNY[v];
    cv.normal[2] = coarseNZ[v];
  }
  for (let c = 0; c < cellCount; c++) {
    const cell = complex.cells[c];
    cell.center = [pHubX[c], pHubY[c], pHubZ[c]];
    cell.normal = [pHubNX[c], pHubNY[c], pHubNZ[c]];
  }
  for (let g = 0; g < openGateEdges.length; g++) {
    const og = openGateEdges[g];
    complex.edges[og.edgeId].initGate = [og.gx, og.gy, og.gz, og.gnx, og.gny, og.gnz];
  }

  // 3. Decompose the relaxed coarse graph into maximal degree-2 open chains & pure degree-2 closed loops!
  const visitedEdge = new Uint8Array(closedEdges.length);
  const chains = [];

  for (let u = 0; u < vCount; u++) {
    if (closedAdj[u].length === 0 || closedAdj[u].length === 2) continue;
    for (const step of closedAdj[u]) {
      if (visitedEdge[step.cId]) continue;
      visitedEdge[step.cId] = 1;
      const verts = [u, step.to];
      let curr = step.to;
      while (closedAdj[curr].length === 2 && curr !== u) {
        const [e0, e1] = closedAdj[curr];
        const nextStep = !visitedEdge[e0.cId] ? e0 : !visitedEdge[e1.cId] ? e1 : null;
        if (!nextStep) break;
        visitedEdge[nextStep.cId] = 1;
        verts.push(nextStep.to);
        curr = nextStep.to;
      }
      chains.push({ verts, periodic: false });
    }
  }

  for (let cId = 0; cId < closedEdges.length; cId++) {
    if (visitedEdge[cId]) continue;
    const startE = closedEdges[cId];
    visitedEdge[cId] = 1;
    const verts = [startE.v0, startE.v1];
    let curr = startE.v1;
    while (curr !== startE.v0) {
      const adj = closedAdj[curr];
      let nextStep = null;
      for (const st of adj) {
        if (!visitedEdge[st.cId]) {
          nextStep = st;
          break;
        }
      }
      if (!nextStep) break;
      visitedEdge[nextStep.cId] = 1;
      if (nextStep.to === startE.v0) break;
      verts.push(nextStep.to);
      curr = nextStep.to;
    }
    if (verts.length >= 3) {
      chains.push({ verts, periodic: true });
    }
  }

  // 3b. Geodesic Sub-Chord Straightener: snaps any low-deflection (< ~12 deg) multi-edge polygon wave along a face
  // or smooth surface directly onto its exact surface-projected geodesic chord whenever open corridors stay clear!
  for (const chain of chains) {
    if (chain.periodic || chain.verts.length < 3) continue;
    const cv = chain.verts;
    const nV = cv.length;
    let i0 = 0;
    while (i0 < nV - 2) {
      let snapped = false;
      for (let i1 = nV - 1; i1 >= i0 + 2; i1--) {
        const va = cv[i0];
        const vb = cv[i1];
        if (coarseNX[va] * coarseNX[vb] + coarseNY[va] * coarseNY[vb] + coarseNZ[va] * coarseNZ[vb] < 0.86) continue;
        const ax = coarseX[va];
        const ay = coarseY[va];
        const az = coarseZ[va];
        const bx = coarseX[vb];
        const by = coarseY[vb];
        const bz = coarseZ[vb];
        const chordLen = Math.hypot(bx - ax, by - ay, bz - az);
        if (chordLen < 1e-5) continue;

        const spanCount = i1 - i0;
        const cumArc = new Float64Array(spanCount + 1);
        for (let s = 1; s <= spanCount; s++) {
          const u0 = cv[i0 + s - 1];
          const u1 = cv[i0 + s];
          cumArc[s] = cumArc[s - 1] + Math.hypot(coarseX[u1] - coarseX[u0], coarseY[u1] - coarseY[u0], coarseZ[u1] - coarseZ[u0]);
        }
        const totalArc = cumArc[spanCount];
        if (totalArc > chordLen * 1.08) continue;

        const maxAllowedPerp = Math.min(avgInradius * 0.48, chordLen * 0.11);
        let withinTol = true;
        for (let s = 1; s < spanCount; s++) {
          const u = totalArc > 1e-8 ? cumArc[s] / totalArc : s / spanCount;
          shape.project(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, edgeProj);
          const vm = cv[i0 + s];
          const perp = Math.hypot(coarseX[vm] - edgeProj[0], coarseY[vm] - edgeProj[1], coarseZ[vm] - edgeProj[2]);
          if (perp > maxAllowedPerp) {
            withinTol = false;
            break;
          }
        }
        if (!withinTol) continue;

        const samples = Math.max(4, Math.ceil(chordLen / 0.028));
        let clear = true;
        for (let s = 1; s < samples; s++) {
          const u = s / samples;
          shape.project(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, edgeProj);
          if (!pointClearOfOpenCorridors(edgeProj[0], edgeProj[1], edgeProj[2], edgeProj[3], edgeProj[4], edgeProj[5], 0.90)) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;

        for (let s = 1; s < spanCount; s++) {
          const u = totalArc > 1e-8 ? cumArc[s] / totalArc : s / spanCount;
          shape.project(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, edgeProj);
          const vm = cv[i0 + s];
          coarseX[vm] = edgeProj[0];
          coarseY[vm] = edgeProj[1];
          coarseZ[vm] = edgeProj[2];
          coarseNX[vm] = edgeProj[3];
          coarseNY[vm] = edgeProj[4];
          coarseNZ[vm] = edgeProj[5];
          const cvObj = complex.vertices[vm];
          cvObj.pos[0] = edgeProj[0];
          cvObj.pos[1] = edgeProj[1];
          cvObj.pos[2] = edgeProj[2];
          cvObj.normal[0] = edgeProj[3];
          cvObj.normal[1] = edgeProj[4];
          cvObj.normal[2] = edgeProj[5];
        }
        i0 = i1;
        snapped = true;
        break;
      }
      if (!snapped) i0++;
    }
  }

  // 4. Angle-and-chord Ramer-Douglas-Peucker simplifier on a smooth B-spline manifold curve pts[i0..i1]:
  //    collapses straight runs to single segments while keeping bends <= ~4.8 deg per vertex!
  const simplifyTol = lowDetail ? 0.0022 : 0.00055;
  const maxTurnCos = Math.cos(lowDetail ? 0.16 : 0.085);

  function rdpSelect(pts, i0, i1, keepMask) {
    if (i1 <= i0 + 1) return;
    const a = pts[i0];
    const b = pts[i1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const abLenSq = abx * abx + aby * aby + abz * abz;

    let maxDist = -1;
    let splitIdx = -1;
    for (let k = i0 + 1; k < i1; k++) {
      const p = pts[k];
      let d;
      if (abLenSq > 1e-12) {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / abLenSq));
        d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
      } else {
        d = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
      }
      if (d > maxDist) {
        maxDist = d;
        splitIdx = k;
      }
    }

    // Check bend angle across the midpoint so tight fillets never collapse into 2 sharp chords!
    let angleNeedsSplit = false;
    const mid = splitIdx > i0 ? splitIdx : (i0 + i1) >> 1;
    const pm = pts[mid];
    const d1x = pm.x - a.x;
    const d1y = pm.y - a.y;
    const d1z = pm.z - a.z;
    const d2x = b.x - pm.x;
    const d2y = b.y - pm.y;
    const d2z = b.z - pm.z;
    const l1 = Math.hypot(d1x, d1y, d1z);
    const l2 = Math.hypot(d2x, d2y, d2z);
    if (l1 > 1e-6 && l2 > 1e-6) {
      const cosTurn = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
      if (cosTurn < maxTurnCos) angleNeedsSplit = true;
    }

    if ((maxDist > simplifyTol || angleNeedsSplit) && mid > i0 && mid < i1) {
      keepMask[mid] = 1;
      rdpSelect(pts, i0, mid, keepMask);
      rdpSelect(pts, mid, i1, keepMask);
    }
  }

  // 5. Chaikin quadratic B-spline corner-cutting + corridor polish + RDP simplification -> watertight wallNodes!
  const wallNodes = [];
  const wallSegments = [];
  const anchorNodeMap = new Int32Array(vCount).fill(-1);

  function getAnchorWallNode(v) {
    let idx = anchorNodeMap[v];
    if (idx >= 0) return idx;
    idx = wallNodes.length;
    wallNodes.push({
      pos: [coarseX[v], coarseY[v], coarseZ[v]],
      normal: [coarseNX[v], coarseNY[v], coarseNZ[v]],
      arc: 0,
      incidents: [],
    });
    anchorNodeMap[v] = idx;
    return idx;
  }

  function addWallSegment(n0, n1) {
    if (n0 === n1) return;
    const segIdx = wallSegments.length;
    wallSegments.push({ n0, n1 });
    wallNodes[n0].incidents.push({ segIdx, end: 0, other: n1 });
    wallNodes[n1].incidents.push({ segIdx, end: 1, other: n0 });
  }

  // Uniform-step coarse resampling so Chaikin rounds corners smoothly while keeping straight collinear runs 100% straight!
  const filletStep = lowDetail ? 0.042 : Math.min(0.036, Math.max(0.016, avgInradius * 0.38));

  for (const chain of chains) {
    const { verts, periodic } = chain;
    const segCount = periodic ? verts.length : verts.length - 1;

    let pts = [];
    for (let s = 0; s < segCount; s++) {
      const va = verts[s];
      const vb = verts[(s + 1) % verts.length];
      const ax = coarseX[va];
      const ay = coarseY[va];
      const az = coarseZ[va];
      const anx = coarseNX[va];
      const any = coarseNY[va];
      const anz = coarseNZ[va];
      const bx = coarseX[vb];
      const by = coarseY[vb];
      const bz = coarseZ[vb];
      const bnx = coarseNX[vb];
      const bny = coarseNY[vb];
      const bnz = coarseNZ[vb];
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const sub = Math.max(1, Math.ceil(len / filletStep));
      const limit = !periodic && s === segCount - 1 ? sub : sub - 1;
      for (let k = 0; k <= limit; k++) {
        const t = k / sub;
        pts.push({
          x: ax + (bx - ax) * t,
          y: ay + (by - ay) * t,
          z: az + (bz - az) * t,
          nx: anx + (bnx - anx) * t,
          ny: any + (bny - any) * t,
          nz: anz + (bnz - anz) * t,
        });
      }
    }

    // 3 Chaikin quadratic B-spline corner-cutting passes turn every polygonal bend & loop into a silky C1 spline!
    const chaikinPasses = periodic || pts.length >= 3 ? (lowDetail ? 2 : 3) : 0;
    for (let ch = 0; ch < chaikinPasses; ch++) {
      const len = pts.length;
      if (periodic) {
        const nextPts = new Array(len * 2);
        for (let i = 0; i < len; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % len];
          nextPts[i * 2] = {
            x: a.x * 0.75 + b.x * 0.25,
            y: a.y * 0.75 + b.y * 0.25,
            z: a.z * 0.75 + b.z * 0.25,
            nx: a.nx * 0.75 + b.nx * 0.25,
            ny: a.ny * 0.75 + b.ny * 0.25,
            nz: a.nz * 0.75 + b.nz * 0.25,
          };
          nextPts[i * 2 + 1] = {
            x: a.x * 0.25 + b.x * 0.75,
            y: a.y * 0.25 + b.y * 0.75,
            z: a.z * 0.25 + b.z * 0.75,
            nx: a.nx * 0.25 + b.nx * 0.75,
            ny: a.ny * 0.25 + b.ny * 0.75,
            nz: a.nz * 0.25 + b.nz * 0.75,
          };
        }
        pts = nextPts;
      } else {
        const nextPts = [pts[0]];
        for (let i = 0; i < len - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (i > 0) {
            nextPts.push({
              x: a.x * 0.75 + b.x * 0.25,
              y: a.y * 0.75 + b.y * 0.25,
              z: a.z * 0.75 + b.z * 0.25,
              nx: a.nx * 0.75 + b.nx * 0.25,
              ny: a.ny * 0.75 + b.ny * 0.25,
              nz: a.nz * 0.75 + b.nz * 0.25,
            });
          } else {
            nextPts.push({
              x: a.x * 0.5 + b.x * 0.5,
              y: a.y * 0.5 + b.y * 0.5,
              z: a.z * 0.5 + b.z * 0.5,
              nx: a.nx * 0.5 + b.nx * 0.5,
              ny: a.ny * 0.5 + b.ny * 0.5,
              nz: a.nz * 0.5 + b.nz * 0.5,
            });
          }
          if (i < len - 2) {
            nextPts.push({
              x: a.x * 0.25 + b.x * 0.75,
              y: a.y * 0.25 + b.y * 0.75,
              z: a.z * 0.25 + b.z * 0.75,
              nx: a.nx * 0.25 + b.nx * 0.75,
              ny: a.ny * 0.25 + b.ny * 0.75,
              nz: a.nz * 0.25 + b.nz * 0.75,
            });
          } else {
            nextPts.push({
              x: a.x * 0.5 + b.x * 0.5,
              y: a.y * 0.5 + b.y * 0.5,
              z: a.z * 0.5 + b.z * 0.5,
              nx: a.nx * 0.5 + b.nx * 0.5,
              ny: a.ny * 0.5 + b.ny * 0.5,
              nz: a.nz * 0.5 + b.nz * 0.5,
            });
          }
        }
        nextPts.push(pts[len - 1]);
        pts = nextPts;
      }
    }

    const m = pts.length;
    if (m < 2) continue;

    // Project Chaikin B-spline onto the manifold and enforce open-corridor keepout LAST (no extra loop-shrinking Laplacian!).
    const iStart = periodic ? 0 : 1;
    const iEnd = periodic ? m : m - 1;
    for (let i = 0; i < m; i++) {
      const p = pts[i];
      shape.project(p.x, p.y, p.z, proj);
      p.x = proj[0];
      p.y = proj[1];
      p.z = proj[2];
      p.nx = proj[3];
      p.ny = proj[4];
      p.nz = proj[5];
    }
    for (let i = iStart; i < iEnd; i++) {
      const p = pts[i];
      repelFromOpenCorridors(p.x, p.y, p.z, p.nx, p.ny, p.nz);
      if (repelOut[0] !== p.x || repelOut[1] !== p.y || repelOut[2] !== p.z) {
        shape.project(repelOut[0], repelOut[1], repelOut[2], proj);
        p.x = proj[0];
        p.y = proj[1];
        p.z = proj[2];
        p.nx = proj[3];
        p.ny = proj[4];
        p.nz = proj[5];
      }
    }

    if (periodic) {
      if (m < 3) continue;
      const closedPts = pts.concat([pts[0]]);
      const keep = new Uint8Array(closedPts.length);
      const q1 = Math.max(1, Math.floor(m / 3));
      const q2 = Math.max(q1 + 1, Math.floor((m * 2) / 3));
      keep[0] = 1;
      keep[q1] = 1;
      keep[q2] = 1;
      keep[m] = 1;
      rdpSelect(closedPts, 0, q1, keep);
      rdpSelect(closedPts, q1, q2, keep);
      rdpSelect(closedPts, q2, m, keep);

      const loopNodes = [];
      const firstPt = pts[0];
      for (let i = 0; i < m; i++) {
        if (!keep[i]) continue;
        const p = pts[i];
        if (loopNodes.length > 0) {
          const prevN = wallNodes[loopNodes[loopNodes.length - 1]].pos;
          if (Math.hypot(p.x - prevN[0], p.y - prevN[1], p.z - prevN[2]) < 0.011) continue;
          if (Math.hypot(p.x - firstPt.x, p.y - firstPt.y, p.z - firstPt.z) < 0.011) continue;
        }
        const nIdx = wallNodes.length;
        wallNodes.push({
          pos: [p.x, p.y, p.z],
          normal: [p.nx, p.ny, p.nz],
          arc: 0,
          incidents: [],
        });
        loopNodes.push(nIdx);
      }
      if (loopNodes.length >= 3) {
        for (let k = 0; k < loopNodes.length; k++) {
          addWallSegment(loopNodes[k], loopNodes[(k + 1) % loopNodes.length]);
        }
      }
    } else {
      const keep = new Uint8Array(m);
      keep[0] = 1;
      keep[m - 1] = 1;
      rdpSelect(pts, 0, m - 1, keep);

      const startNode = getAnchorWallNode(verts[0]);
      const endNode = getAnchorWallNode(verts[verts.length - 1]);
      const endPos = wallNodes[endNode].pos;
      let prevNode = startNode;

      for (let i = 1; i < m - 1; i++) {
        if (!keep[i]) continue;
        const p = pts[i];
        const prevPos = wallNodes[prevNode].pos;
        if (Math.hypot(p.x - prevPos[0], p.y - prevPos[1], p.z - prevPos[2]) < 0.011) continue;
        if (Math.hypot(p.x - endPos[0], p.y - endPos[1], p.z - endPos[2]) < 0.011) continue;
        const nIdx = wallNodes.length;
        wallNodes.push({
          pos: [p.x, p.y, p.z],
          normal: [p.nx, p.ny, p.nz],
          arc: 0,
          incidents: [],
        });
        addWallSegment(prevNode, nIdx);
        prevNode = nIdx;
      }
      addWallSegment(prevNode, endNode);
    }
  }

  return packWallCapsuleGrid(wallNodes, wallSegments, avgInradius);
}

// Evaluates exact lifted tangent-projected distance to nearest closed wall centerline (matching stepMarble in physics.js)
// and relaxes a medial passage network across every open doorway and cell turn to find the true worst-case bottleneck.
function computePassageClearanceAndHubs(shape, complex, openEdgeSet, capsuleData, gridOffsets, gridItems, rLift, avgInradius) {
  const proj = new Float64Array(6);
  const outPush = [0, 0, 0];

  function evalWallDist(px, py, pz, nx, ny, nz, lift) {
    const lx = px + nx * lift;
    const ly = py + ny * lift;
    const lz = pz + nz * lift;
    const cellIdx = gridCellAt(px, py, pz);
    const startIdx = gridOffsets[cellIdx];
    const endIdx = gridOffsets[cellIdx + 1];

    let bestDist = 0.36;
    let bestDx = 0;
    let bestDy = 0;
    let bestDz = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const base = gridItems[i] * 12;
      const ax = capsuleData[base] + capsuleData[base + 3] * lift;
      const ay = capsuleData[base + 1] + capsuleData[base + 4] * lift;
      const az = capsuleData[base + 2] + capsuleData[base + 5] * lift;
      const bx = capsuleData[base + 6] + capsuleData[base + 9] * lift;
      const by = capsuleData[base + 7] + capsuleData[base + 10] * lift;
      const bz = capsuleData[base + 8] + capsuleData[base + 11] * lift;

      const ex = bx - ax;
      const ey = by - ay;
      const ez = bz - az;
      const eLenSq = ex * ex + ey * ey + ez * ez;
      const t = eLenSq > 1e-12
        ? Math.max(0, Math.min(1, ((lx - ax) * ex + (ly - ay) * ey + (lz - az) * ez) / eLenSq))
        : 0;
      const cnx = capsuleData[base + 3] + (capsuleData[base + 9] - capsuleData[base + 3]) * t;
      const cny = capsuleData[base + 4] + (capsuleData[base + 10] - capsuleData[base + 4]) * t;
      const cnz = capsuleData[base + 5] + (capsuleData[base + 11] - capsuleData[base + 5]) * t;
      if (cnx * nx + cny * ny + cnz * nz < -0.28) continue;
      let rx = lx - (ax + ex * t);
      let ry = ly - (ay + ey * t);
      let rz = lz - (az + ez * t);
      const nDot = rx * nx + ry * ny + rz * nz;
      rx -= nx * nDot;
      ry -= ny * nDot;
      rz -= nz * nDot;
      const d = Math.hypot(rx, ry, rz);
      if (Math.abs(nDot) > 0.022 + d * 0.95) continue;
      if (d < bestDist) {
        bestDist = d;
        if (d > 1e-8) {
          bestDx = rx / d;
          bestDy = ry / d;
          bestDz = rz / d;
        }
      }
    }
    outPush[0] = bestDx;
    outPush[1] = bestDy;
    outPush[2] = bestDz;
    return bestDist;
  }

  const cellCount = complex.cells.length;
  const hubs = complex.cells.map((c) => ({
    x: c.center[0],
    y: c.center[1],
    z: c.center[2],
    nx: c.normal[0],
    ny: c.normal[1],
    nz: c.normal[2],
    origX: c.center[0],
    origY: c.center[1],
    origZ: c.center[2],
    inradius: c.inradius,
    maxShift: c.inradius * 0.82,
  }));

  const passages = [];
  for (const edgeId of openEdgeSet) {
    const e = complex.edges[edgeId];
    if (e.c0 < 0 || e.c1 < 0) continue;
    const va = complex.vertices[e.v0].pos;
    const vb = complex.vertices[e.v1].pos;
    let gx, gy, gz, gnx, gny, gnz;
    if (e.initGate) {
      [gx, gy, gz, gnx, gny, gnz] = e.initGate;
    } else {
      shape.project(
        (va[0] + vb[0]) * 0.5,
        (va[1] + vb[1]) * 0.5,
        (va[2] + vb[2]) * 0.5,
        proj,
      );
      gx = proj[0];
      gy = proj[1];
      gz = proj[2];
      gnx = proj[3];
      gny = proj[4];
      gnz = proj[5];
    }

    const h0 = hubs[e.c0];
    const h1 = hubs[e.c1];
    shape.project((h0.x + gx) * 0.5, (h0.y + gy) * 0.5, (h0.z + gz) * 0.5, proj);
    const q0 = { x: proj[0], y: proj[1], z: proj[2], nx: proj[3], ny: proj[4], nz: proj[5] };
    shape.project((h1.x + gx) * 0.5, (h1.y + gy) * 0.5, (h1.z + gz) * 0.5, proj);
    const q1 = { x: proj[0], y: proj[1], z: proj[2], nx: proj[3], ny: proj[4], nz: proj[5] };

    passages.push({
      edgeId,
      c0: e.c0,
      c1: e.c1,
      va,
      vb,
      tGate: 0.5,
      gx,
      gy,
      gz,
      gnx,
      gny,
      gnz,
      q0,
      q1,
    });
  }

  // Monotone hill-climbing medial-axis relaxation: only accepts moves that strictly increase wall clearance,
  // guaranteeing zero overshoot across thin cells while finding the widest arc on giant cells!
  for (let iter = 0; iter < 16; iter++) {
    const decay = Math.pow(0.80, iter);

    for (let c = 0; c < cellCount; c++) {
      const h = hubs[c];
      const curD = evalWallDist(h.x, h.y, h.z, h.nx, h.ny, h.nz, rLift);
      const px = outPush[0];
      const py = outPush[1];
      const pz = outPush[2];
      const hStep = Math.min(curD * 0.45, h.inradius * 0.18) * decay;
      if (hStep < 1e-4) continue;
      let nx = h.x + px * hStep;
      let ny = h.y + py * hStep;
      let nz = h.z + pz * hStep;
      const dx = nx - h.origX;
      const dy = ny - h.origY;
      const dz = nz - h.origZ;
      const d = Math.hypot(dx, dy, dz);
      if (d > h.maxShift && d > 1e-8) {
        const s = h.maxShift / d;
        nx = h.origX + dx * s;
        ny = h.origY + dy * s;
        nz = h.origZ + dz * s;
      }
      shape.project(nx, ny, nz, proj);
      const nextD = evalWallDist(proj[0], proj[1], proj[2], proj[3], proj[4], proj[5], rLift);
      if (nextD > curD) {
        h.x = proj[0];
        h.y = proj[1];
        h.z = proj[2];
        h.nx = proj[3];
        h.ny = proj[4];
        h.nz = proj[5];
      }
    }

    for (let i = 0; i < passages.length; i++) {
      const p = passages[i];
      const curGD = evalWallDist(p.gx, p.gy, p.gz, p.gnx, p.gny, p.gnz, rLift);
      const ex = p.vb[0] - p.va[0];
      const ey = p.vb[1] - p.va[1];
      const ez = p.vb[2] - p.va[2];
      const eLen = Math.hypot(ex, ey, ez) || 1;
      const gStep = Math.min(curGD * 0.44, Math.max(eLen, avgInradius) * 0.18) * decay;
      if (gStep > 1e-4) {
        const midX = (p.va[0] + p.vb[0]) * 0.5;
        const midY = (p.va[1] + p.vb[1]) * 0.5;
        const midZ = (p.va[2] + p.vb[2]) * 0.5;
        let ngx = p.gx + outPush[0] * gStep;
        let ngy = p.gy + outPush[1] * gStep;
        let ngz = p.gz + outPush[2] * gStep;
        const maxGShift = Math.max(eLen * 0.85, avgInradius * 1.15);
        const dg = Math.hypot(ngx - midX, ngy - midY, ngz - midZ);
        if (dg > maxGShift && dg > 1e-8) {
          const s = maxGShift / dg;
          ngx = midX + (ngx - midX) * s;
          ngy = midY + (ngy - midY) * s;
          ngz = midZ + (ngz - midZ) * s;
        }
        shape.project(ngx, ngy, ngz, proj);
        const nextGD = evalWallDist(proj[0], proj[1], proj[2], proj[3], proj[4], proj[5], rLift);
        if (nextGD > curGD) {
          p.gx = proj[0];
          p.gy = proj[1];
          p.gz = proj[2];
          p.gnx = proj[3];
          p.gny = proj[4];
          p.gnz = proj[5];
        }
      }

      const h0 = hubs[p.c0];
      shape.project((h0.x + p.gx) * 0.5, (h0.y + p.gy) * 0.5, (h0.z + p.gz) * 0.5, proj);
      const m0x = proj[0];
      const m0y = proj[1];
      const m0z = proj[2];
      const curQ0 = evalWallDist(p.q0.x, p.q0.y, p.q0.z, p.q0.nx, p.q0.ny, p.q0.nz, rLift);
      const q0Step = Math.min(curQ0 * 0.42, h0.inradius * 0.16) * decay;
      const c0x = p.q0.x * 0.78 + m0x * 0.22 + outPush[0] * q0Step;
      const c0y = p.q0.y * 0.78 + m0y * 0.22 + outPush[1] * q0Step;
      const c0z = p.q0.z * 0.78 + m0z * 0.22 + outPush[2] * q0Step;
      shape.project(c0x, c0y, c0z, proj);
      if (evalWallDist(proj[0], proj[1], proj[2], proj[3], proj[4], proj[5], rLift) > curQ0) {
        p.q0.x = proj[0];
        p.q0.y = proj[1];
        p.q0.z = proj[2];
        p.q0.nx = proj[3];
        p.q0.ny = proj[4];
        p.q0.nz = proj[5];
      }

      const h1 = hubs[p.c1];
      shape.project((h1.x + p.gx) * 0.5, (h1.y + p.gy) * 0.5, (h1.z + p.gz) * 0.5, proj);
      const m1x = proj[0];
      const m1y = proj[1];
      const m1z = proj[2];
      const curQ1 = evalWallDist(p.q1.x, p.q1.y, p.q1.z, p.q1.nx, p.q1.ny, p.q1.nz, rLift);
      const q1Step = Math.min(curQ1 * 0.42, h1.inradius * 0.16) * decay;
      const c1x = p.q1.x * 0.78 + m1x * 0.22 + outPush[0] * q1Step;
      const c1y = p.q1.y * 0.78 + m1y * 0.22 + outPush[1] * q1Step;
      const c1z = p.q1.z * 0.78 + m1z * 0.22 + outPush[2] * q1Step;
      shape.project(c1x, c1y, c1z, proj);
      if (evalWallDist(proj[0], proj[1], proj[2], proj[3], proj[4], proj[5], rLift) > curQ1) {
        p.q1.x = proj[0];
        p.q1.y = proj[1];
        p.q1.z = proj[2];
        p.q1.nx = proj[3];
        p.q1.ny = proj[4];
        p.q1.nz = proj[5];
      }
    }
  }

  for (let c = 0; c < cellCount; c++) {
    const h = hubs[c];
    shape.project(h.x, h.y, h.z, proj);
    h.x = proj[0];
    h.y = proj[1];
    h.z = proj[2];
    h.nx = proj[3];
    h.ny = proj[4];
    h.nz = proj[5];
  }
  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    shape.project(p.gx, p.gy, p.gz, proj);
    p.gx = proj[0];
    p.gy = proj[1];
    p.gz = proj[2];
    p.gnx = proj[3];
    p.gny = proj[4];
    p.gnz = proj[5];

    shape.project(p.q0.x, p.q0.y, p.q0.z, proj);
    p.q0.x = proj[0];
    p.q0.y = proj[1];
    p.q0.z = proj[2];
    p.q0.nx = proj[3];
    p.q0.ny = proj[4];
    p.q0.nz = proj[5];

    shape.project(p.q1.x, p.q1.y, p.q1.z, proj);
    p.q1.x = proj[0];
    p.q1.y = proj[1];
    p.q1.z = proj[2];
    p.q1.nx = proj[3];
    p.q1.ny = proj[4];
    p.q1.nz = proj[5];
  }

  function measureMinHalfSpan(lift, startId = -1, goalId = -1) {
    const stepSize = Math.max(0.005, Math.min(0.012, lift * 0.28));
    function segMinSpan(ax, ay, az, bx, by, bz) {
      let sMin = Infinity;
      const segLen = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(2, Math.ceil(segLen / stepSize));
      const halfStepMargin = (segLen / steps) * 0.5;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        shape.project(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, proj);
        const d = evalWallDist(proj[0], proj[1], proj[2], proj[3], proj[4], proj[5], lift) - halfStepMargin;
        if (d < sMin) sMin = d;
      }
      return sMin;
    }

    for (let i = 0; i < passages.length; i++) {
      const p = passages[i];
      const h0 = hubs[p.c0];
      const h1 = hubs[p.c1];
      p.halfSpan = Math.min(
        segMinSpan(h0.x, h0.y, h0.z, p.q0.x, p.q0.y, p.q0.z),
        segMinSpan(p.q0.x, p.q0.y, p.q0.z, p.gx, p.gy, p.gz),
        segMinSpan(p.gx, p.gy, p.gz, p.q1.x, p.q1.y, p.q1.z),
        segMinSpan(p.q1.x, p.q1.y, p.q1.z, h1.x, h1.y, h1.z),
      );
    }

    // Widest-path Kruskal: the passage width at which most major cells join one component.
    const sorted = passages.slice().sort((a, b) => b.halfSpan - a.halfSpan);
    const parent = new Int32Array(cellCount);
    const compMajor = new Int32Array(cellCount);
    let totalMajor = 0;
    for (let c = 0; c < cellCount; c++) {
      parent[c] = c;
      if (!complex.cells[c].isChamfer && hubs[c].inradius >= avgInradius * 0.52) {
        compMajor[c] = 1;
        totalMajor++;
      }
    }
    if (totalMajor < 2) {
      totalMajor = cellCount;
      compMajor.fill(1);
    }
    const find = (x) => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      while (x !== r) {
        const nxt = parent[x];
        parent[x] = r;
        x = nxt;
      }
      return r;
    };
    const targetMajor = Math.max(2, Math.ceil(totalMajor * 0.90));
    const fallbackMajor = Math.max(2, Math.ceil(totalMajor * 0.7));
    let fallbackBottleneck = -1;
    const needSG = startId >= 0 && goalId >= 0 && startId !== goalId;
    let sgDone = !needSG;
    let majorDone = false;
    let sgBottleneck = sorted.length > 0 ? sorted[0].halfSpan : 0.04;
    let majorBottleneck = sgBottleneck;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const ra = find(p.c0);
      const rb = find(p.c1);
      if (ra !== rb) {
        parent[rb] = ra;
        compMajor[ra] += compMajor[rb];
        if (fallbackBottleneck < 0 && compMajor[ra] >= fallbackMajor) fallbackBottleneck = p.halfSpan;
        if (!majorDone && compMajor[ra] >= targetMajor) {
          majorBottleneck = p.halfSpan;
          majorDone = true;
        }
        if (!sgDone && find(startId) === find(goalId)) {
          sgBottleneck = p.halfSpan;
          sgDone = true;
        }
        if (majorDone && sgDone) break;
      }
    }
    // A single narrow passage that cuts off a few cells must not shrink the marble for the whole maze.
    if (fallbackBottleneck > 0 && majorBottleneck < fallbackBottleneck * 0.6) majorBottleneck = fallbackBottleneck * 0.6;
    return needSG ? Math.min(majorBottleneck, sgBottleneck) : majorBottleneck;
  }

  function measureHubClearance(lift) {
    const hubClearance = new Float64Array(cellCount);
    for (let c = 0; c < cellCount; c++) {
      const h = hubs[c];
      hubClearance[c] = evalWallDist(h.x, h.y, h.z, h.nx, h.ny, h.nz, lift);
    }
    return hubClearance;
  }

  return { hubs, passages, measureMinHalfSpan, measureHubClearance, evalWallDist, outPush };
}

// Turns the raw cell-to-gate polyline into a sweeping, kink-free racing-line spline on the surface while keeping
// comfortable clearance from every closed wall post and flank.
function buildSmoothSolutionSpline(rawWaypoints, shape, clearanceInfo, safeClearance) {
  if (rawWaypoints.length < 2) return rawWaypoints;
  const proj = new Float64Array(6);
  const { evalWallDist, outPush } = clearanceInfo;

  // 1. Subdivide raw waypoints uniformly (~0.018 spacing) along the surface.
  let pts = [];
  for (let i = 0; i < rawWaypoints.length - 1; i++) {
    const a = rawWaypoints[i];
    const b = rawWaypoints[i + 1];
    const segLen = dist3(a, b);
    const steps = Math.max(2, Math.ceil(segLen / 0.018));
    const limit = i === rawWaypoints.length - 2 ? steps : steps - 1;
    for (let s = 0; s <= limit; s++) {
      const t = s / steps;
      shape.project(
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        proj,
      );
      pts.push({
        x: proj[0],
        y: proj[1],
        z: proj[2],
        nx: proj[3],
        ny: proj[4],
        nz: proj[5],
      });
    }
  }

  // 2. Elastic-band Laplacian smoothing with hard wall-clearance repulsion: pulls zig-zags straight into graceful
  // sweeping arcs while keeping every point safely away from wall posts!
  const n = pts.length;
  const nextX = new Float64Array(n);
  const nextY = new Float64Array(n);
  const nextZ = new Float64Array(n);

  for (let iter = 0; iter < 28; iter++) {
    const smoothWeight = 0.46;
    for (let i = 1; i < n - 1; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const next = pts[i + 1];
      let px = curr.x * (1 - smoothWeight) + (prev.x + next.x) * 0.5 * smoothWeight;
      let py = curr.y * (1 - smoothWeight) + (prev.y + next.y) * 0.5 * smoothWeight;
      let pz = curr.z * (1 - smoothWeight) + (prev.z + next.z) * 0.5 * smoothWeight;

      const dWall = evalWallDist(px, py, pz, curr.nx, curr.ny, curr.nz, 0);
      if (dWall < safeClearance) {
        const push = safeClearance - dWall;
        px += outPush[0] * push;
        py += outPush[1] * push;
        pz += outPush[2] * push;
      }
      nextX[i] = px;
      nextY[i] = py;
      nextZ[i] = pz;
    }

    const doProject = (iter & 3) === 3 || iter === 27;
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i];
      if (doProject) {
        shape.project(nextX[i], nextY[i], nextZ[i], proj);
        p.x = proj[0];
        p.y = proj[1];
        p.z = proj[2];
        p.nx = proj[3];
        p.ny = proj[4];
        p.nz = proj[5];
      } else {
        p.x = nextX[i];
        p.y = nextY[i];
        p.z = nextZ[i];
      }
    }
  }

  // 3. Final Chaikin corner-rounding pass projected onto the surface for C1-smooth curvature everywhere!
  const refined = [[pts[0].x, pts[0].y, pts[0].z]];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (i > 0) {
      shape.project(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25, a.z * 0.75 + b.z * 0.25, proj);
      refined.push([proj[0], proj[1], proj[2]]);
    }
    if (i < n - 2) {
      shape.project(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75, a.z * 0.25 + b.z * 0.75, proj);
      refined.push([proj[0], proj[1], proj[2]]);
    }
  }
  refined.push([pts[n - 1].x, pts[n - 1].y, pts[n - 1].z]);
  return refined;
}

// Extrudes a manifold, zero-Z-fighting bevelled wall mesh from an extracted wall graph.
function extrudeWallGeometry(wallNodes, wallSegments, wallHalfWidth, wallHeight, waveOrigin, lowDetail = false) {
  // Sort incident half-edges CCW around each node's surface normal and compute disjoint miter corners.
  const segCorners = wallSegments.map(() => ({
    startLeft: null,
    startRight: null,
    endLeft: null,
    endRight: null,
  }));

  // Sculpted lathe-milled wall profile: tucked foot -> concave cove fillet -> vertical flank -> smooth 2-step bevel arc -> crown.
  const bevel = Math.min(wallHalfWidth * 0.38, wallHeight * 0.32);
  const footSink = 0.014;
  const profile = lowDetail
    ? [
        { r: 1.12, h: -footSink, nr: 0.92, nh: 0.38, top: 0.0, bevelMask: 0.0 },
        { r: 1.01, h: wallHeight * 0.09, nr: 0.99, nh: 0.14, top: 0.0, bevelMask: 0.0 },
        { r: 0.98, h: wallHeight - bevel, nr: 1.0, nh: 0.06, top: 0.0, bevelMask: 0.15 },
        { r: 0.84, h: wallHeight - bevel * 0.28, nr: 0.62, nh: 0.78, top: 0.52, bevelMask: 1.0 },
        { r: 0.58, h: wallHeight, nr: 0.14, nh: 0.99, top: 1.0, bevelMask: 0.35 },
      ]
    : [
        { r: 1.12, h: -footSink, nr: 0.92, nh: 0.38, top: 0.0, bevelMask: 0.0 },
        { r: 1.04, h: wallHeight * 0.06, nr: 0.97, nh: 0.24, top: 0.0, bevelMask: 0.0 },
        { r: 1.00, h: wallHeight * 0.16, nr: 1.0, nh: 0.08, top: 0.0, bevelMask: 0.0 },
        { r: 0.98, h: wallHeight - bevel, nr: 1.0, nh: 0.06, top: 0.0, bevelMask: 0.12 },
        { r: 0.91, h: wallHeight - bevel * 0.58, nr: 0.84, nh: 0.54, top: 0.24, bevelMask: 0.68 },
        { r: 0.78, h: wallHeight - bevel * 0.18, nr: 0.48, nh: 0.88, top: 0.68, bevelMask: 1.0 },
        { r: 0.58, h: wallHeight, nr: 0.12, nh: 0.99, top: 1.0, bevelMask: 0.35 },
      ];
  const ringLevels = profile.length;

  const positions = [];
  const normals = [];
  const surfNormals = [];
  const wallMeta = []; // x: heightFrac (0..1), y: waveOrder (0..1), z: topMask, w: sinkSpan
  const wallShade = []; // x: bevelMask (0..1, peaks on shoulder), y: radialOffsetLen
  const indices = [];

  const maxWaveDist = 2.25;
  const sinkSpan = wallHeight + footSink + 0.008;

  function emitVertex(basePos, surfNormal, offsetVec, levelObj) {
    const idx = positions.length / 3;
    const ox = offsetVec[0] * levelObj.r;
    const oy = offsetVec[1] * levelObj.r;
    const oz = offsetVec[2] * levelObj.r;
    const px = basePos[0] + ox + surfNormal[0] * levelObj.h;
    const py = basePos[1] + oy + surfNormal[1] * levelObj.h;
    const pz = basePos[2] + oz + surfNormal[2] * levelObj.h;
    positions.push(px, py, pz);
    surfNormals.push(surfNormal[0], surfNormal[1], surfNormal[2]);

    const outLen = Math.hypot(offsetVec[0], offsetVec[1], offsetVec[2]) || 1;
    const rx = offsetVec[0] / outLen;
    const ry = offsetVec[1] / outLen;
    const rz = offsetVec[2] / outLen;
    const nx = rx * levelObj.nr + surfNormal[0] * levelObj.nh;
    const ny = ry * levelObj.nr + surfNormal[1] * levelObj.nh;
    const nz = rz * levelObj.nr + surfNormal[2] * levelObj.nh;
    const nNorm = normalize3(nx, ny, nz);
    normals.push(nNorm[0], nNorm[1], nNorm[2]);

    const wave = Math.min(1, dist3(basePos, waveOrigin) / maxWaveDist);
    const heightFrac = Math.max(0, (levelObj.h + footSink) / (wallHeight + footSink));
    const vertexSink = Math.max(0, levelObj.h + footSink) + 0.012;
    wallMeta.push(heightFrac, wave, levelObj.top, vertexSink);
    wallShade.push(levelObj.bevelMask ?? 0.0, levelObj.r);
    return idx;
  }

  function emitProfileColumn(basePos, surfNormal, offsetVec) {
    const base = positions.length / 3;
    for (let l = 0; l < ringLevels; l++) {
      emitVertex(basePos, surfNormal, offsetVec, profile[l]);
    }
    return base;
  }

  // Connects columnA -> columnB where columnB is further CCW around the wall boundary (outward face points right of A->B).
  function connectColumns(colA, colB) {
    for (let l = 0; l < ringLevels - 1; l++) {
      const a0 = colA + l;
      const a1 = colA + l + 1;
      const b0 = colB + l;
      const b1 = colB + l + 1;
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }

  for (let vIdx = 0; vIdx < wallNodes.length; vIdx++) {
    const node = wallNodes[vIdx];
    const deg = node.incidents.length;
    if (deg === 0) continue;

    const p = node.pos;
    const n = node.normal;
    const { u, v } = tangentFrame(n);

    // Compute unit outgoing tangent for each incident segment.
    for (const inc of node.incidents) {
      const q = wallNodes[inc.other].pos;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const dz = q[2] - p[2];
      const dotN = dx * n[0] + dy * n[1] + dz * n[2];
      const tVec = normalize3(dx - n[0] * dotN, dy - n[1] * dotN, dz - n[2] * dotN);
      inc.dir = tVec;
      inc.edgeLen = Math.hypot(dx, dy, dz);
      inc.angle = Math.atan2(dot3(tVec, v), dot3(tVec, u));
    }
    node.incidents.sort((a, b) => a.angle - b.angle);

    // Center crown vertex for junction top fan.
    const centerTopIdx = emitVertex(p, n, [0, 0, 0], { r: 0, h: wallHeight, nr: 0, nh: 1, top: 1 });

    if (deg === 1) {
      // Rounded semicircular pill cap around degree-1 wall tip.
      const inc = node.incidents[0];
      const tVec = inc.dir;
      // Outgoing edge: left normal is n x tVec, right normal is -left.
      const leftN = normalize3(...cross3(n, tVec));
      const rightN = [-leftN[0], -leftN[1], -leftN[2]];
      const leftOff = [leftN[0] * wallHalfWidth, leftN[1] * wallHalfWidth, leftN[2] * wallHalfWidth];
      const rightOff = [rightN[0] * wallHalfWidth, rightN[1] * wallHalfWidth, rightN[2] * wallHalfWidth];

      const capSteps = lowDetail ? 4 : 8;
      const capCols = [];
      for (let s = 0; s <= capSteps; s++) {
        // Sweep CCW from leftN (angle +pi/2 from tVec) around back (-tVec) to rightN (+3pi/2 from tVec).
        const theta = Math.PI * 0.5 + (s / capSteps) * Math.PI;
        const ct = Math.cos(theta);
        const st = Math.sin(theta);
        const dir = [
          (tVec[0] * ct + leftN[0] * st) * wallHalfWidth,
          (tVec[1] * ct + leftN[1] * st) * wallHalfWidth,
          (tVec[2] * ct + leftN[2] * st) * wallHalfWidth,
        ];
        capCols.push(emitProfileColumn(p, n, dir));
      }
      for (let s = 0; s < capSteps; s++) {
        connectColumns(capCols[s], capCols[s + 1]);
        indices.push(centerTopIdx, capCols[s] + ringLevels - 1, capCols[s + 1] + ringLevels - 1);
      }

      const leftCol = capCols[0];
      const rightCol = capCols[capSteps];
      if (inc.end === 0) {
        segCorners[inc.segIdx].startLeft = leftCol;
        segCorners[inc.segIdx].startRight = rightCol;
        // Close triangle between startRight and startLeft across centerTopIdx is handled by the segment strip.
      } else {
        segCorners[inc.segIdx].endRight = leftCol;
        segCorners[inc.segIdx].endLeft = rightCol;
      }
      continue;
    }

    // Degree >= 2: build sector corners between consecutive CCW outgoing half-edges inc[k] and inc[k+1].
    const sectorLeftCols = new Array(deg);
    const sectorRightCols = new Array(deg);

    for (let k = 0; k < deg; k++) {
      const curr = node.incidents[k];
      const next = node.incidents[(k + 1) % deg];
      let deltaAngle = next.angle - curr.angle;
      if (deltaAngle <= 0) deltaAngle += Math.PI * 2;

      const currLeft = normalize3(...cross3(n, curr.dir));
      const nextRight = [-cross3(n, next.dir)[0], -cross3(n, next.dir)[1], -cross3(n, next.dir)[2]];
      const nextRightNorm = normalize3(nextRight[0], nextRight[1], nextRight[2]);

      if (deltaAngle > Math.PI * 1.05) {
        // Reflex outer bend: round with a short circular arc so no miter tip ever protrudes into a corridor.
        const arcSteps = Math.max(
          lowDetail ? 2 : 5,
          Math.round(((deltaAngle - Math.PI) / Math.PI) * (lowDetail ? 4 : 8)),
        );
        const arcCols = [];
        for (let s = 0; s <= arcSteps; s++) {
          const frac = s / arcSteps;
          // Slerp-like blend in tangent plane around -bisector.
          const ang = curr.angle + Math.PI * 0.5 + frac * (deltaAngle - Math.PI);
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const off = [
            (u[0] * ca + v[0] * sa) * wallHalfWidth,
            (u[1] * ca + v[1] * sa) * wallHalfWidth,
            (u[2] * ca + v[2] * sa) * wallHalfWidth,
          ];
          arcCols.push(emitProfileColumn(p, n, off));
        }
        for (let s = 0; s < arcSteps; s++) {
          connectColumns(arcCols[s], arcCols[s + 1]);
          indices.push(centerTopIdx, arcCols[s] + ringLevels - 1, arcCols[s + 1] + ringLevels - 1);
        }
        sectorLeftCols[k] = arcCols[0];
        sectorRightCols[(k + 1) % deg] = arcCols[arcSteps];
      } else {
        // Standard or inner corner: single shared miter column!
        const halfA = deltaAngle * 0.5;
        const miterScale = Math.min(2.15, 1 / Math.max(0.32, Math.sin(halfA)));
        const midAng = curr.angle + halfA;
        const cm = Math.cos(midAng);
        const sm = Math.sin(midAng);
        const maxReach = Math.min(curr.edgeLen, next.edgeLen) * 0.46;
        const reach = Math.min(wallHalfWidth * miterScale, Math.max(wallHalfWidth, maxReach));
        const miterOff = [
          (u[0] * cm + v[0] * sm) * reach,
          (u[1] * cm + v[1] * sm) * reach,
          (u[2] * cm + v[2] * sm) * reach,
        ];
        const col = emitProfileColumn(p, n, miterOff);
        sectorLeftCols[k] = col;
        sectorRightCols[(k + 1) % deg] = col;
      }
    }

    // Fan centerTopIdx across each outgoing edge's right-to-left crown so junction tops are 100% watertight without overlap.
    for (let k = 0; k < deg; k++) {
      const inc = node.incidents[k];
      const rCol = sectorRightCols[k];
      const lCol = sectorLeftCols[k];
      indices.push(centerTopIdx, rCol + ringLevels - 1, lCol + ringLevels - 1);
      if (inc.end === 0) {
        segCorners[inc.segIdx].startLeft = lCol;
        segCorners[inc.segIdx].startRight = rCol;
      } else {
        segCorners[inc.segIdx].endRight = lCol;
        segCorners[inc.segIdx].endLeft = rCol;
      }
    }
  }

  // Stitch each wall segment between its two endpoint miter pairs.
  for (let s = 0; s < wallSegments.length; s++) {
    const sc = segCorners[s];
    if (sc.startLeft === null || sc.endLeft === null) continue;
    // Right side (going n0 -> n1, outward normal points right: CCW boundary goes startRight -> endRight).
    connectColumns(sc.startRight, sc.endRight);
    // Left side (going n1 -> n0, outward normal points left: CCW boundary goes endLeft -> startLeft).
    connectColumns(sc.endLeft, sc.startLeft);
    // Flat crown quad connecting the two bevel shoulders!
    const srTop = sc.startRight + ringLevels - 1;
    const erTop = sc.endRight + ringLevels - 1;
    const elTop = sc.endLeft + ringLevels - 1;
    const slTop = sc.startLeft + ringLevels - 1;
    indices.push(srTop, erTop, elTop, srTop, elTop, slTop);
  }

  const wallGeometry = new BufferGeometry();
  wallGeometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  wallGeometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  wallGeometry.setAttribute("surfNormal", new BufferAttribute(new Float32Array(surfNormals), 3));
  wallGeometry.setAttribute("wallMeta", new BufferAttribute(new Float32Array(wallMeta), 4));
  wallGeometry.setAttribute("wallShade", new BufferAttribute(new Float32Array(wallShade), 2));
  wallGeometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return wallGeometry;
}

// ---------------------------------------------------------------------------
// Public Builder: buildLabyrinth
// ---------------------------------------------------------------------------
export function buildLabyrinth({
  shapeName,
  tiling,
  algorithm,
  density,
  wallStyle = "three-step",
  rand,
  lowDetail = false,
}) {
  const shape = SHAPES[shapeName];
  let complex;
  if (tiling === "triangular") {
    complex = buildTriangularTiling(shapeName, density);
  } else if (tiling === "hexagonal") {
    complex = buildHexagonalTiling(shapeName, density);
  } else if (tiling === "octagonal") {
    complex = buildOctagonalTiling(shapeName, density, wallStyle);
  } else if (tiling === "masonry") {
    complex = buildMasonryTiling(shapeName, density);
  } else if (tiling === "voronoi") {
    complex = buildVoronoiTiling(shapeName, density, rand);
  } else {
    complex = buildPolyhedralTiling(shapeName, density);
  }

  let edgeLengthSum = 0;
  const sortedEdgeLens = complex.edges.map((e) => {
    edgeLengthSum += e.length;
    return e.length;
  }).sort((a, b) => a - b);
  const avgEdge = edgeLengthSum / Math.max(1, complex.edges.length);
  const medianEdge = sortedEdgeLens[Math.floor(sortedEdgeLens.length * 0.5)] ?? avgEdge;

  let inradiusSum = 0;
  let majorCellTotal = 0;
  for (const cell of complex.cells) {
    if (cell.isChamfer) continue;
    inradiusSum += cell.inradius;
    majorCellTotal++;
  }
  const avgInradius = inradiusSum / Math.max(1, majorCellTotal);

  // Keep narrow edges closed; a cell with no wide edge gets its widest one, so a single tiny cell doesn't narrow every gate.
  const passableThreshold = Math.max(medianEdge * 0.78, MIN_WALL_HALF_WIDTH * 4.4);
  const passableEdgeMask = new Uint8Array(complex.edges.length);
  // Sliver cells are too thin for any marble, so they stay sealed off.
  for (const cell of complex.cells) cell.sliver = !cell.isChamfer && cell.inradius < avgInradius * 0.4;
  const usable = (c) => c >= 0 && !complex.cells[c].isChamfer && !complex.cells[c].sliver;
  const isInner = (e) => usable(e.c0) && usable(e.c1);
  for (const edge of complex.edges) {
    passableEdgeMask[edge.id] = isInner(edge) && edge.length >= passableThreshold ? 1 : 0;
  }
  for (const cell of complex.cells) {
    if (cell.isChamfer || cell.sliver) continue;
    let widest = null;
    let hasGate = false;
    for (const edgeId of cell.edgeIds) {
      const e = complex.edges[edgeId];
      if (passableEdgeMask[edgeId]) hasGate = true;
      if (isInner(e) && (!widest || e.length > widest.length)) widest = e;
    }
    if (!hasGate && widest) passableEdgeMask[widest.id] = 1;
  }

  const openEdgeSet = generateMazePassages(complex, shape, algorithm, rand, passableEdgeMask);

  // Steiner-arc resolution for 4.8.8 octagonal vertex-chamfer cells: preserves exact major-room maze connectivity
  // while turning straight walls into pure deg-2 runs, L-corners into 45-deg chamfers, and wall tips into open roundabouts!
  const vertIncidentEdges = Array.from({ length: complex.vertices.length }, () => []);
  for (const e of complex.edges) {
    vertIncidentEdges[e.v0].push(e.id);
    vertIncidentEdges[e.v1].push(e.id);
  }
  for (const cell of complex.cells) {
    if (!cell.isChamfer) continue;
    const ring = cell.ring;
    const k = ring.length;
    const cEdges = cell.edgeIds;
    if (cEdges.length !== k || k < 3) continue;
    const terms = [];
    for (let m = 0; m < k; m++) {
      const u = ring[m];
      let hasClosedSpoke = false;
      for (const eId of vertIncidentEdges[u]) {
        if (cEdges.includes(eId)) continue;
        if (!openEdgeSet.has(eId)) {
          hasClosedSpoke = true;
          break;
        }
      }
      if (hasClosedSpoke) terms.push(m);
    }
    if (terms.length <= 1) {
      for (let m = 0; m < k; m++) openEdgeSet.add(cEdges[m]);
    } else {
      let bestSteps = -1;
      let bestArcLen = -1;
      let bestStart = terms[0];
      for (let t = 0; t < terms.length; t++) {
        const tA = terms[t];
        const tB = terms[(t + 1) % terms.length];
        const steps = (tB - tA + k) % k || k;
        let arcLen = 0;
        for (let s = 0; s < steps; s++) arcLen += complex.edges[cEdges[(tA + s) % k]].length;
        if (steps > bestSteps || (steps === bestSteps && arcLen > bestArcLen)) {
          bestSteps = steps;
          bestArcLen = arcLen;
          bestStart = tA;
        }
      }
      for (let m = 0; m < k; m++) openEdgeSet.delete(cEdges[m]);
      for (let s = 0; s < bestSteps; s++) {
        openEdgeSet.add(cEdges[(bestStart + s) % k]);
      }
    }
  }

  // Give small dead-end cells a second gate so their tight corners never trap the marble.
  for (const cell of complex.cells) {
    if (cell.isChamfer || cell.inradius >= avgInradius * 0.52) continue;
    let openCount = 0;
    let bestClosedId = -1;
    let bestClosedLen = 0;
    for (const edgeId of cell.edgeIds) {
      if (openEdgeSet.has(edgeId)) {
        openCount++;
      } else {
        const e = complex.edges[edgeId];
        if (usable(e.c0) && usable(e.c1) && e.length > bestClosedLen) {
          bestClosedLen = e.length;
          bestClosedId = edgeId;
        }
      }
    }
    if (openCount === 1 && bestClosedId >= 0) {
      openEdgeSet.add(bestClosedId);
    }
  }

  // Extract closed-wall centerline graph + zero-allocation CSR spatial grid using the selected wall finish mode!
  const wallGraph =
    wallStyle === "original"
      ? extractWallGraphOriginal(shape, complex, openEdgeSet, avgInradius, lowDetail)
      : wallStyle === "straightened"
        ? extractWallGraphStraightened(shape, complex, openEdgeSet, avgEdge, avgInradius, lowDetail)
        : extractWallGraphThreeStep(shape, complex, openEdgeSet, avgEdge, avgInradius, lowDetail);
  const { wallNodes, wallSegments, capsuleData, gridOffsets, gridItems } = wallGraph;

  // Solve directly for the maximum corner-passable marbleRadius for this exact maze:
  const baseWallHalfWidth = Math.max(MIN_WALL_HALF_WIDTH, Math.min(0.036, avgInradius * 0.20));
  let wallHalfWidth = baseWallHalfWidth;
  let marbleRadius = Math.max(0.014, Math.min(0.055, avgInradius * 0.34));

  const clearanceInfo = computePassageClearanceAndHubs(
    shape,
    complex,
    openEdgeSet,
    capsuleData,
    gridOffsets,
    gridItems,
    marbleRadius,
    avgInradius,
  );

  // 1. Solve for the maximum marbleRadius across the 90% widest major-room network first so 1 tiny corner never crushes the marble!
  let finalHalfSpan = Math.max(0.026, clearanceInfo.measureMinHalfSpan(marbleRadius));
  for (let refine = 0; refine < 5; refine++) {
    wallHalfWidth = Math.max(MIN_WALL_HALF_WIDTH, Math.min(baseWallHalfWidth, finalHalfSpan * 0.24));
    const maxPassableR = Math.max(0.0105, Math.min(0.24, (finalHalfSpan - wallHalfWidth) * 0.75));
    marbleRadius = refine === 0 ? maxPassableR : 0.45 * marbleRadius + 0.55 * maxPassableR;
    finalHalfSpan = Math.max(0.026, clearanceInfo.measureMinHalfSpan(marbleRadius));
  }
  wallHalfWidth = Math.max(MIN_WALL_HALF_WIDTH, Math.min(baseWallHalfWidth, finalHalfSpan * 0.24));
  marbleRadius = Math.max(
    0.0105,
    Math.min(marbleRadius, Math.min(0.24, (finalHalfSpan - wallHalfWidth) * 0.755)),
  );
  finalHalfSpan = Math.max(0.026, clearanceInfo.measureMinHalfSpan(marbleRadius));
  if (marbleRadius > (finalHalfSpan - wallHalfWidth) * 0.76) {
    marbleRadius = Math.max(0.0105, (finalHalfSpan - wallHalfWidth) * 0.75);
  }
  const hubClearance = clearanceInfo.measureHubClearance(marbleRadius);

  // Center every cell on its maximum-clearance medial hub and record each open gate's centered crossing & clear span.
  for (let c = 0; c < complex.cells.length; c++) {
    const h = clearanceInfo.hubs[c];
    const cell = complex.cells[c];
    cell.center = [h.x, h.y, h.z];
    cell.normal = [h.nx, h.ny, h.nz];
    cell.inradius = Math.min(cell.inradius * 1.25, Math.max(cell.inradius, marbleRadius * 1.1));
  }
  const passageByEdge = new Map();
  for (const p of clearanceInfo.passages) {
    passageByEdge.set(p.edgeId, p);
    complex.edges[p.edgeId].gatePoint = [p.gx, p.gy, p.gz];
    complex.edges[p.edgeId].clearSpan = p.halfSpan * 2;
  }

  const wallHeight = Math.max(
    marbleRadius * 0.92,
    Math.min(
      wallHalfWidth * 3.8,
      Math.max(marbleRadius * 1.15, avgEdge * 0.30, wallHalfWidth * 2.1),
    ),
  );

  // Margin beyond the wall's own reach that the reflection march may step without missing a capsule.
  const renderGrid = packRenderGrid(capsuleData, wallHalfWidth + wallHeight + 0.03);

  // 2. Place Start and Goal inside the largest connected component of verified-passable corridors (guaranteed 100% passable end-to-end!)
  const minPassableSpan = wallHalfWidth + marbleRadius * 1.04;
  const passableOpenSet = new Set();
  for (const p of clearanceInfo.passages) {
    if (p.halfSpan >= minPassableSpan) passableOpenSet.add(p.edgeId);
  }
  const routeEdgeSet = passableOpenSet.size >= 4 ? passableOpenSet : openEdgeSet;
  const compVisited = new Uint8Array(complex.cells.length);
  let bestCompCells = null;
  let bestCompMajor = -1;
  for (let c = 0; c < complex.cells.length; c++) {
    if (compVisited[c] || complex.cells[c].isChamfer) continue;
    compVisited[c] = 1;
    const q = [c];
    let majorCnt = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      if (!complex.cells[u].isChamfer) majorCnt++;
      for (const eId of complex.cells[u].edgeIds) {
        if (!routeEdgeSet.has(eId)) continue;
        const e = complex.edges[eId];
        const nb = e.c0 === u ? e.c1 : e.c0;
        if (nb >= 0 && !compVisited[nb]) {
          compVisited[nb] = 1;
          q.push(nb);
        }
      }
    }
    if (majorCnt > bestCompMajor) {
      bestCompMajor = majorCnt;
      bestCompCells = q.filter((id) => !complex.cells[id].isChamfer);
    }
  }
  const bestCompSeed = bestCompCells && bestCompCells.length > 0
    ? bestCompCells[Math.floor(rand() * bestCompCells.length)]
    : 0;
  const minStartGoalInr = avgInradius * 0.56;
  const firstPass = bfsDistances(complex, routeEdgeSet, bestCompSeed, passageByEdge, minStartGoalInr);
  const secondPass = bfsDistances(complex, routeEdgeSet, firstPass.farthestCell, passageByEdge, minStartGoalInr);
  const startCellId = secondPass.farthestCell;
  const goalCellId = firstPass.farthestCell;

  const goalBfs = bfsDistances(complex, routeEdgeSet, goalCellId, passageByEdge);
  const nextTowardGoal = goalBfs.parentCell;
  const distToGoal = goalBfs.dist;
  // Extend into any remaining off-route alcoves in descending order of doorway width so off-route cells always exit via their widest gate!
  const sortedAllPassages = clearanceInfo.passages.slice().sort((a, b) => b.halfSpan - a.halfSpan);
  let extended = true;
  while (extended) {
    extended = false;
    for (let i = 0; i < sortedAllPassages.length; i++) {
      const p = sortedAllPassages[i];
      const d0 = distToGoal[p.c0];
      const d1 = distToGoal[p.c1];
      const r0 = d0 >= 0 && d0 < 1e8;
      const r1 = d1 >= 0 && d1 < 1e8;
      if (r0 && !r1) {
        distToGoal[p.c1] = d0 + 1;
        nextTowardGoal[p.c1] = p.c0;
        extended = true;
      } else if (r1 && !r0) {
        distToGoal[p.c0] = d1 + 1;
        nextTowardGoal[p.c0] = p.c1;
        extended = true;
      }
    }
  }

  // Extract raw waypoints from Start through centered open gates to Goal, then relax into a silky smooth spline!
  const rawSolutionWaypoints = [complex.cells[startCellId].center];
  let traceCell = startCellId;
  const visitedTrace = new Set();
  while (traceCell >= 0 && traceCell !== goalCellId && !visitedTrace.has(traceCell)) {
    visitedTrace.add(traceCell);
    const nextCell = nextTowardGoal[traceCell];
    if (nextCell < 0) break;
    for (const edgeId of complex.cells[traceCell].edgeIds) {
      if (!openEdgeSet.has(edgeId)) continue;
      const e = complex.edges[edgeId];
      if (e.c0 === nextCell || e.c1 === nextCell) {
        const pass = passageByEdge.get(edgeId);
        if (pass) {
          rawSolutionWaypoints.push([pass.gx, pass.gy, pass.gz]);
        }
        break;
      }
    }
    rawSolutionWaypoints.push(complex.cells[nextCell].center);
    traceCell = nextCell;
  }
  const safeWireClearance = Math.min(finalHalfSpan * 0.82, wallHalfWidth + marbleRadius * 0.78);
  const solutionPathPoints = buildSmoothSolutionSpline(
    rawSolutionWaypoints,
    shape,
    clearanceInfo,
    safeWireClearance,
  );

  const startCell = complex.cells[startCellId];
  const goalCell = complex.cells[goalCellId];
  const goalPocketClear = Math.max(marbleRadius * 1.16, hubClearance[goalCellId] - wallHalfWidth);
  const pocketRadius = Math.max(
    marbleRadius * 1.16,
    Math.min(avgInradius * 0.92, marbleRadius * 1.46, goalPocketClear * 0.96),
  );

  const wallGeometry = extrudeWallGeometry(
    wallNodes,
    wallSegments,
    wallHalfWidth,
    wallHeight,
    goalCell.center,
    lowDetail,
  );
  const floorGeometry = buildFloorGeometry(
    shapeName,
    startCell,
    goalCell,
    pocketRadius,
    marbleRadius,
    wallHalfWidth,
    capsuleData,
    gridOffsets,
    gridItems,
    lowDetail,
  );
  const hintGeometry = buildHintRibbonGeometry(solutionPathPoints, shape, marbleRadius);

  const minClearWidth = Math.max(0, 2 * (finalHalfSpan - wallHalfWidth));
  const minClearanceRatio = minClearWidth / (2 * marbleRadius);

  return {
    shapeName,
    shape,
    complex,
    openEdgeSet,
    startCellId,
    goalCellId,
    startCell,
    goalCell,
    nextTowardGoal,
    distToGoal,
    marbleRadius,
    wallHalfWidth,
    wallHeight,
    pocketRadius,
    minPassageHalfSpan: finalHalfSpan,
    minClearanceRatio,
    solutionPathPoints,
    floorGeometry,
    wallGeometry,
    hintGeometry,
    capsuleData,
    renderGrid,
    gridOffsets,
    gridItems,
    gridRes: GRID_RES,
    gridHalf: GRID_HALF,
    gridInv: GRID_INV,
  };
}
