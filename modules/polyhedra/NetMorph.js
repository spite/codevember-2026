// Flat paper sheet that morphs one unfolded net into another: both outlines are sampled as
// signed distance grids once, then each frame the blended field is contoured (marching squares)
// into a planar mesh in the XZ plane, with the same attributes FoldedPaper provides.
// With `via: "square"` the sheet passes through a plain square of the same paper area on the way.

import { BufferGeometry, BufferAttribute, Sphere } from "three";

const polyArea = (polys) =>
  polys.reduce((sum, poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return sum + Math.abs(a) / 2;
  }, 0);

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function bounds(polys) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys) {
    for (const [x, z] of poly) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], z);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], z);
    }
  }
  return b;
}

// Per polygon: bounding box, then per edge its start, direction, length and the area sign.
function packPolys(polys) {
  let edges = 0;
  for (const p of polys) edges += p.length;
  const box = new Float64Array(polys.length * 4);
  const start = new Int32Array(polys.length + 1);
  const sign = new Float64Array(polys.length);
  const E = new Float64Array(edges * 6);
  let e = 0;
  polys.forEach((poly, p) => {
    box.set(bounds([poly]), p * 4);
    start[p] = e;
    const n = poly.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    sign[p] = area > 0 ? 1 : -1;
    for (let i = 0; i < n; i++, e++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const len = Math.hypot(ex, ez) || 1e-9;
      E.set([a[0], a[1], ex, ez, len, len * len], e * 6);
    }
  });
  start[polys.length] = e;
  return { count: polys.length, box, start, sign, E };
}

// Signed distance of (x, z) to polygon p, exact outside.
function polySDF(P, p, x, z) {
  const { E, start } = P;
  const sign = P.sign[p];
  let inside = -Infinity;
  for (let e = start[p] * 6, end = start[p + 1] * 6; e < end; e += 6) {
    const plane = (sign * (E[e + 2] * (z - E[e + 1]) - E[e + 3] * (x - E[e]))) / -E[e + 4];
    if (plane > inside) inside = plane;
  }
  if (inside <= 0) return inside;
  let out = Infinity;
  for (let e = start[p] * 6, end = start[p + 1] * 6; e < end; e += 6) {
    const ex = E[e + 2], ez = E[e + 3];
    const px = x - E[e], pz = z - E[e + 1];
    const t = Math.min(1, Math.max(0, (px * ex + pz * ez) / E[e + 5]));
    const dx = px - ex * t, dz = pz - ez * t;
    const d = dx * dx + dz * dz;
    if (d < out) out = d;
  }
  return Math.sqrt(out);
}

const SAMPLE_TILE = 24;

// polysA / polysB: flatOutline() of the two nets, or null to grow from / shrink to a point.
// Set while NetMorph.create() runs the constructor, which then leaves the build steps to it.
let deferring = false;

export class NetMorph extends BufferGeometry {
  constructor(polysA, polysB, options = {}) {
    super();
    const steps = this._build(polysA, polysB, options);
    if (deferring) this._steps = steps;
    else while (!steps.next().done);
  }

  // Generator form of the constructor: yields while sampling the nets, returns the geometry.
  static *create(polysA, polysB, options = {}) {
    deferring = true;
    let g;
    try {
      g = new NetMorph(polysA, polysB, options);
    } finally {
      deferring = false;
    }
    yield* g._steps;
    delete g._steps;
    return g;
  }

  *_build(polysA, polysB, { resolution = 96, bulge = 0.12, via = null, hold = 0.2 }) {
    this.via = via;
    this.hold = hold;
    const src = [polysA, polysB].filter(Boolean);
    const b = src.map(bounds).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
    this.bulge = bulge * Math.min(b[2] - b[0], b[3] - b[1]);
    const pad = 0.05 * Math.max(b[2] - b[0], b[3] - b[1]) + this.bulge;
    this.x0 = b[0] - pad;
    this.z0 = b[1] - pad;
    const w = b[2] - b[0] + 2 * pad;
    const h = b[3] - b[1] + 2 * pad;
    this.cell = Math.max(w, h) / resolution;
    this.nx = Math.ceil(w / this.cell) + 1;
    this.nz = Math.ceil(h / this.cell) + 1;
    const { nx, nz } = this;
    const count = nx * nz;
    this.gx = new Float32Array(nx);
    this.gz = new Float32Array(nz);
    for (let i = 0; i < nx; i++) this.gx[i] = this.x0 + i * this.cell;
    for (let j = 0; j < nz; j++) this.gz[j] = this.z0 + j * this.cell;
    this.a = new Float32Array(count);
    this.b = new Float32Array(count);
    for (const [polys, out] of [[polysA, this.a], [polysB, this.b]]) {
      if (!polys) {
        this._samplePoint(out);
        continue;
      }
      const P = packPolys(polys);
      for (let J0 = 0; J0 < nz; J0 += SAMPLE_TILE) {
        this._sampleRows(P, out, J0);
        yield;
      }
    }
    if (via === "square") {
      // Same paper area as the nets (their mean), with slightly softened corners.
      const area = src.reduce((sum, polys) => sum + polyArea(polys), 0) / src.length;
      const half = Math.sqrt(area) / 2;
      const r = 0.06 * half;
      this.sq = new Float32Array(count);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const dx = Math.abs(this.gx[i]) - (half - r);
          const dz = Math.abs(this.gz[j]) - (half - r);
          this.sq[j * nx + i] = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0) - r;
        }
      }
    }
    this.field = new Float32Array(count);

    // Shared contour vertices: inside grid points, then crossings on x edges and z edges.
    this._hx = count;
    this._hz = count + (nx - 1) * nz;
    const maxVerts = this._hz + nx * (nz - 1);
    this._ids = new Int32Array(maxVerts);
    this.positions = new Float32Array(maxVerts * 3);
    const uv = new Float32Array(maxVerts * 2);
    const normal = new Float32Array(maxVerts * 3);
    for (let i = 0; i < maxVerts; i++) normal[i * 3 + 1] = 1;
    const valley = new Float32Array(maxVerts * 2);
    for (let i = 0; i < maxVerts; i++) valley[i * 2] = 10;
    const maxIndex = (nx - 1) * (nz - 1) * 12;
    this.setIndex(new BufferAttribute(maxVerts > 65535 ? new Uint32Array(maxIndex) : new Uint16Array(maxIndex), 1));
    this.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.setAttribute("normal", new BufferAttribute(normal, 3));
    this.setAttribute("uv", new BufferAttribute(uv, 2));
    this.setAttribute("crease", new BufferAttribute(new Float32Array(maxVerts), 1));
    this.setAttribute("valley", new BufferAttribute(valley, 2));
    this.setAttribute("faceId", new BufferAttribute(new Float32Array(maxVerts), 1));
    this.boundingSphere = new Sphere();
    this.fold = 0;
    this.setMorph(0);
  }

  _samplePoint(out) {
    const { nx, nz, x0, z0, cell } = this;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) out[j * nx + i] = Math.hypot(x0 + i * cell, z0 + j * cell) + cell;
  }

  // Union SDF of polygons P into out, for the band of SAMPLE_TILE sample rows from J0.
  _sampleRows(P, out, J0) {
    const { nx, nz, x0, z0, cell } = this;
    const box = P.box;
    const all = Int32Array.from(P.count === 0 ? [] : Array(P.count).keys());
    const coarse = new Int32Array(P.count);
    const cand = new Int32Array(P.count);
    const lb = new Float64Array(P.count);
    const boxDist2 = (p, xa, xb, za, zb) => {
      const bx = Math.max(box[p * 4] - xb, 0, xa - box[p * 4 + 2]);
      const bz = Math.max(box[p * 4 + 1] - zb, 0, za - box[p * 4 + 3]);
      return bx * bx + bz * bz;
    };
    // Polygons from src[0..n) that can be the minimum somewhere in the sample tile, sorted by
    // their lower bound into dst / lb. The field is 1-Lipschitz, so the tile centre's value plus
    // the tile radius bounds it from above.
    const tile = (i0, i1, j0, j1, src, n, dst) => {
      const tx0 = x0 + i0 * cell, tx1 = x0 + i1 * cell, tz0 = z0 + j0 * cell, tz1 = z0 + j1 * cell;
      const cx = (tx0 + tx1) / 2, cz = (tz0 + tz1) / 2;
      let bc = Infinity;
      for (let c = 0; c < n; c++) {
        const p = src[c];
        const b2 = boxDist2(p, cx, cx, cz, cz);
        if (bc > 0 ? b2 >= bc * bc : b2 > 0) continue;
        const d = polySDF(P, p, cx, cz);
        if (d < bc) bc = d;
      }
      const U = bc + (1.0001 * Math.hypot(tx1 - tx0, tz1 - tz0)) / 2 + 1e-9;
      let m = 0;
      for (let c = 0; c < n; c++) {
        const p = src[c];
        const b2 = boxDist2(p, tx0, tx1, tz0, tz1);
        const l = b2 > 0 ? Math.sqrt(b2) : -Infinity;
        if (l > U) continue;
        let k = m++;
        while (k > 0 && lb[k - 1] > l) {
          lb[k] = lb[k - 1];
          dst[k] = dst[k - 1];
          k--;
        }
        lb[k] = l;
        dst[k] = p;
      }
      return m;
    };
    const T1 = SAMPLE_TILE;
    const T2 = 6;
    {
      const J1 = Math.min(J0 + T1, nz) - 1;
      for (let I0 = 0; I0 < nx; I0 += T1) {
        const I1 = Math.min(I0 + T1, nx) - 1;
        const nc = tile(I0, I1, J0, J1, all, P.count, coarse);
        for (let j0 = J0; j0 <= J1; j0 += T2) {
          const j1 = Math.min(j0 + T2 - 1, J1);
          for (let i0 = I0; i0 <= I1; i0 += T2) {
            const i1 = Math.min(i0 + T2 - 1, I1);
            const n = tile(i0, i1, j0, j1, coarse, nc, cand);
            for (let j = j0; j <= j1; j++) {
              const z = z0 + j * cell;
              for (let i = i0; i <= i1; i++) {
                const x = x0 + i * cell;
                let best = Infinity;
                for (let c = 0; c < n; c++) {
                  const l = lb[c];
                  // Sorted by lower bound: nothing after this can beat best.
                  if (l > 0 && (best <= 0 || l >= best)) break;
                  const p = cand[c];
                  const b2 = boxDist2(p, x, x, z, z);
                  if (best > 0 ? b2 >= best * best : b2 > 0) continue;
                  const d = polySDF(P, p, x, z);
                  if (d < best) best = d;
                }
                out[j * nx + i] = best;
              }
            }
          }
        }
      }
    }
  }

  // 0 = net A, 1 = net B.
  setMorph(t) {
    if (t === this.morph) return this;
    this.morph = t;
    const { field, nx, nz, gx, gz } = this;
    let a = this.a;
    let b = this.b;
    let u = t;
    if (this.sq) {
      // A -> square, hold, square -> B.
      const ramp = (1 - this.hold) / 2;
      if (t < 0.5) {
        b = this.sq;
        u = smooth(t / ramp);
      } else {
        a = this.sq;
        u = smooth((t - 1 + ramp) / ramp);
      }
    }
    // Inflates mid-way so the sheet stays one rounded piece instead of tearing where the shapes disagree.
    const bulge = this.bulge * 4 * u * (1 - u);
    for (let i = 0; i < field.length; i++) field[i] = a[i] + (b[i] - a[i]) * u - bulge;
    const P = this.positions;
    const uv = this.attributes.uv.array;
    const index = this.index.array;
    const ids = this._ids;
    ids.fill(-1);
    const hx = this._hx;
    const hz = this._hz;
    let nv = 0;
    let ni = 0;
    const emit = (slot, x, z) => {
      ids[slot] = nv;
      P[nv * 3] = x;
      P[nv * 3 + 1] = 0;
      P[nv * 3 + 2] = z;
      uv[nv * 2] = x;
      uv[nv * 2 + 1] = -z;
      return nv++;
    };
    const point = (g, i, j) => (ids[g] >= 0 ? ids[g] : emit(g, gx[i], gz[j]));
    const crossX = (g, i, j) => {
      const s = hx + j * (nx - 1) + i;
      if (ids[s] >= 0) return ids[s];
      const d1 = field[g], d2 = field[g + 1];
      return emit(s, gx[i] + (gx[i + 1] - gx[i]) * (d1 / (d1 - d2)), gz[j]);
    };
    const crossZ = (g, i, j) => {
      const s = hz + j * nx + i;
      if (ids[s] >= 0) return ids[s];
      const d1 = field[g], d2 = field[g + nx];
      return emit(s, gx[i], gz[j] + (gz[j + 1] - gz[j]) * (d1 / (d1 - d2)));
    };
    const poly = this._poly || (this._poly = new Int32Array(8));
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        const d0 = field[k], d1 = field[k + 1], d2 = field[k + nx + 1], d3 = field[k + nx];
        if (d0 >= 0 && d1 >= 0 && d2 >= 0 && d3 >= 0) continue;
        let n = 0;
        if (d0 < 0) poly[n++] = point(k, i, j);
        if (d0 < 0 !== d1 < 0) poly[n++] = crossX(k, i, j);
        if (d1 < 0) poly[n++] = point(k + 1, i + 1, j);
        if (d1 < 0 !== d2 < 0) poly[n++] = crossZ(k + 1, i + 1, j);
        if (d2 < 0) poly[n++] = point(k + nx + 1, i + 1, j + 1);
        if (d2 < 0 !== d3 < 0) poly[n++] = crossX(k + nx, i, j + 1);
        if (d3 < 0) poly[n++] = point(k + nx, i, j + 1);
        if (d3 < 0 !== d0 < 0) poly[n++] = crossZ(k, i, j);
        // Fan from the first point; cell polygons are convex (saddles resolve as connected).
        for (let q = 2; q < n; q++) {
          index[ni++] = poly[0];
          index[ni++] = poly[q];
          index[ni++] = poly[q - 1];
        }
      }
    }
    this.setDrawRange(0, ni);
    for (const [attr, n] of [[this.attributes.position, nv * 3], [this.attributes.uv, nv * 2], [this.index, ni]]) {
      // A zero-length range would make WebGL2 bufferSubData upload the whole array.
      if (!n) continue;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n);
      attr.needsUpdate = true;
    }
    this._boundingSphere(nv);
    return this;
  }

  _boundingSphere(nv) {
    const P = this.positions;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < nv * 3; i += 3) {
      const x = P[i], z = P[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const s = this.boundingSphere;
    if (!nv) {
      s.center.set(0, 0, 0);
      s.radius = 0;
      return;
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    let r2 = 0;
    for (let i = 0; i < nv * 3; i += 3) {
      const dx = P[i] - cx, dz = P[i + 2] - cz;
      const d = dx * dx + dz * dz;
      if (d > r2) r2 = d;
    }
    s.center.set(cx, 0, cz);
    s.radius = Math.sqrt(r2);
  }
}
