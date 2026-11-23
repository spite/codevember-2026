// Abstract sculptural room for Day 22 (Echo): an enclosed gallery with walls,
// pilasters, ceiling beams, plinths, monoliths, spheres, polyhedra, an arch ring,
// and Suzanne. Keeps an analytic collider list in sync with the visible meshes so
// multi-bounce acoustic raytracing runs in sub-millisecond time on the CPU.

import {
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  TorusGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  DodecahedronGeometry,
  Vector3,
  Color,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Euler,
  CatmullRomCurve3,
  Raycaster,
  MeshBasicMaterial,
} from "three";
import { suzanneGeometry } from "modules/suzanne/suzanneMesh.js";
import { getSeed, seededRandom } from "modules/random.js";

const ROOM_HALF_X = 12;
const ROOM_HALF_Z = 12;
const ROOM_HEIGHT = 3.2;

const _ro = new Vector3();
const _rd = new Vector3();
const _n = new Vector3();
const _hit = new Vector3();

// Fast ray-OBB intersection in local box space (box centered at origin with half-extents hx, hy, hz).
function intersectOBB(origin, dir, box, maxT) {
  _ro.copy(origin).applyMatrix4(box.invMatrix);
  _rd.copy(dir).transformDirection(box.invMatrix);
  // Scale direction by local scale embedded in invMatrix (extract length).
  // Since invMatrix only has rotation + translation (scale = 1), _rd is unit length.

  let tmin = 0.001;
  let tmax = maxT;
  let hitAxis = -1;
  let hitSign = 1;

  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? _ro.x : axis === 1 ? _ro.y : _ro.z;
    const d = axis === 0 ? _rd.x : axis === 1 ? _rd.y : _rd.z;
    const h = axis === 0 ? box.hx : axis === 1 ? box.hy : box.hz;
    if (Math.abs(d) < 1e-7) {
      if (o < -h || o > h) return null;
    } else {
      const invD = 1 / d;
      let t1 = (-h - o) * invD;
      let t2 = (h - o) * invD;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        hitAxis = axis;
        hitSign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (hitAxis < 0 || tmin >= maxT) return null;

  _n.set(
    hitAxis === 0 ? hitSign : 0,
    hitAxis === 1 ? hitSign : 0,
    hitAxis === 2 ? hitSign : 0,
  ).applyQuaternion(box.quat).normalize();

  return { t: tmin, normal: _n.clone(), reflectivity: box.reflectivity, pitch: box.pitch, albedo: box.albedo, sculpture: box.sculpture };
}

function intersectSphere(origin, dir, sph, maxT) {
  const ox = origin.x - sph.cx;
  const oy = origin.y - sph.cy;
  const oz = origin.z - sph.cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - sph.r * sph.r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0.001 || t >= maxT) return null;
  const invR = 1 / sph.r;
  return {
    t,
    normal: new Vector3((ox + dir.x * t) * invR, (oy + dir.y * t) * invR, (oz + dir.z * t) * invR),
    reflectivity: sph.reflectivity,
    pitch: sph.pitch,
    albedo: sph.albedo,
    sculpture: sph.sculpture,
  };
}

const ROOM_WALL_COLOR = new Color("#d8d4cc");
const ROOM_FLOOR_COLOR = new Color("#bab6ae");
const ROOM_LEFT_COLOR = new Color("#c8684e");  // warm terracotta bounce
const ROOM_RIGHT_COLOR = new Color("#5482b8"); // cool slate-blue bounce

// Inside of the room box: rays always start inside [-hx, hx] x [0, H] x [-hz, hz].
function intersectRoomBounds(origin, dir, maxT) {
  let bestT = maxT;
  let nx = 0, ny = 0, nz = 0;
  let albedo = ROOM_WALL_COLOR;

  if (dir.x > 1e-6) {
    const t = (ROOM_HALF_X - origin.x) / dir.x;
    if (t > 0.001 && t < bestT) { bestT = t; nx = -1; ny = 0; nz = 0; albedo = ROOM_RIGHT_COLOR; }
  } else if (dir.x < -1e-6) {
    const t = (-ROOM_HALF_X - origin.x) / dir.x;
    if (t > 0.001 && t < bestT) { bestT = t; nx = 1; ny = 0; nz = 0; albedo = ROOM_LEFT_COLOR; }
  }

  if (dir.y > 1e-6) {
    const t = (ROOM_HEIGHT - origin.y) / dir.y;
    if (t > 0.001 && t < bestT) { bestT = t; nx = 0; ny = -1; nz = 0; albedo = ROOM_WALL_COLOR; }
  } else if (dir.y < -1e-6) {
    const t = (0 - origin.y) / dir.y;
    if (t > 0.001 && t < bestT) { bestT = t; nx = 0; ny = 1; nz = 0; albedo = ROOM_FLOOR_COLOR; }
  }

  if (dir.z > 1e-6) {
    const t = (ROOM_HALF_Z - origin.z) / dir.z;
    if (t > 0.001 && t < bestT) { bestT = t; nx = 0; ny = 0; nz = -1; albedo = ROOM_WALL_COLOR; }
  } else if (dir.z < -1e-6) {
    const t = (-ROOM_HALF_Z - origin.z) / dir.z;
    if (t > 0.001 && t < bestT) { bestT = t; nx = 0; ny = 0; nz = 1; albedo = ROOM_WALL_COLOR; }
  }

  if (bestT >= maxT) return null;
  return { t: bestT, normal: new Vector3(nx, ny, nz), reflectivity: 0.78, pitch: 0.88, albedo, isRoom: true };
}

let cachedSuzanneGeo = null;

// The maze: MAZE_N x MAZE_N cells of CELL metres filling the room.
const CELL = 2.4;
const MAZE_N = 10;
const MAZE_COLORS = [new Color("#d8d4cc"), new Color("#d8d4cc"), new Color("#c8684e"), new Color("#d8d4cc"), new Color("#5482b8"), new Color("#c8b68c"), new Color("#d8d4cc")];

// Surfaces are subdivided to about this size, since what the voice reveals is remembered per vertex.
const MEMORY_CELL = 0.1;
const seg = () => 1;
const box = (w, h, d) => new BoxGeometry(w, h, d, seg(w), seg(h), seg(d));

export async function loadSuzanne() {
  if (!cachedSuzanneGeo) {
    const res = await fetch("../assets/suzanne.obj");
    const text = await res.text();
    const geo = suzanneGeometry(text, 2);
    geo.computeBoundingBox();
    const c = new Vector3();
    geo.boundingBox.getCenter(c);
    geo.translate(-c.x, -c.y, -c.z);
    const size = new Vector3();
    geo.boundingBox.getSize(size);
    const s = 1.65 / Math.max(size.x, size.y, size.z);
    geo.scale(s, s, s);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    // A lighter mesh of the same shape for ray hits: one subdivision level instead of two.
    const hull = suzanneGeometry(text, 1);
    hull.translate(-c.x, -c.y, -c.z);
    hull.scale(s, s, s);
    hull.computeBoundingSphere();
    geo.userData.hull = hull;
    cachedSuzanneGeo = geo;
  }
  return cachedSuzanneGeo;
}

export function createRoom(material, suzanneGeo) {
  const group = new Group();
  const boxes = [];
  const spheres = [];
  const occBoxes = [];
  const occSpheres = [];
  // Sculptures: rays test a bounding sphere, then the actual mesh in its current pose.
  const hulls = [];
  const hullRaycaster = new Raycaster();
  const hullMaterial = new MeshBasicMaterial();
  const animated = [];
  const meshes = [];
  const walls = [];
  const startPos = new Vector3();
  const goal = new Vector3();
  // Broad flat faces (the monoliths') that reflect like mirrors: centre, outward normal, in-plane axis, half sizes.
  const faces = [];
  let patrolCurve = null;
  let patrolSamples = [];

  // Push a waypoint outside every interior collider and comfortably inside the room bounds.
  const _localP = new Vector3();
  const _pushDir = new Vector3();
  function clearPoint(p, clearance = 0.65) {
    for (let iter = 0; iter < 6; iter++) {
      // Room walls, floor, ceiling margin.
      p.x = Math.max(-ROOM_HALF_X + 0.9, Math.min(ROOM_HALF_X - 0.9, p.x));
      p.y = Math.max(0.75, Math.min(ROOM_HEIGHT - 0.95, p.y));
      p.z = Math.max(-ROOM_HALF_Z + 0.9, Math.min(ROOM_HALF_Z - 0.9, p.z));

      // Repel from spheres (Suzanne, floating spheres, polyhedra).
      for (let i = 0; i < occSpheres.length; i++) {
        const s = occSpheres[i];
        _pushDir.set(p.x - s.cx, p.y - s.cy, p.z - s.cz);
        const d = _pushDir.length();
        const minD = s.r + clearance;
        if (d < minD) {
          if (d < 1e-4) _pushDir.set(0, 1, 0);
          else _pushDir.divideScalar(d);
          p.addScaledVector(_pushDir, minD - d);
        }
      }

      // Repel from boxes and cylinders (monoliths, plinths, torus pillars).
      for (let i = 0; i < occBoxes.length; i++) {
        const b = occBoxes[i];
        _localP.copy(p).applyMatrix4(b.invMatrix);
        if (b.isCylinder) {
          const r2 = Math.hypot(_localP.x, _localP.z);
          const minR = b.hx + clearance;
          const minY = b.hy + clearance;
          if (r2 < minR && Math.abs(_localP.y) < minY) {
            const penR = minR - r2;
            const penY = minY - Math.abs(_localP.y);
            if (penR < penY) {
              const nx = r2 > 1e-4 ? _localP.x / r2 : 1;
              const nz = r2 > 1e-4 ? _localP.z / r2 : 0;
              _pushDir.set(nx, 0, nz).applyQuaternion(b.quat);
              p.addScaledVector(_pushDir, penR);
            } else {
              _pushDir.set(0, _localP.y >= 0 ? 1 : -1, 0).applyQuaternion(b.quat);
              p.addScaledVector(_pushDir, penY);
            }
          }
        } else {
          const dx = b.hx + clearance - Math.abs(_localP.x);
          const dy = b.hy + clearance - Math.abs(_localP.y);
          const dz = b.hz + clearance - Math.abs(_localP.z);
          if (dx > 0 && dy > 0 && dz > 0) {
            if (dx <= dy && dx <= dz) _pushDir.set(_localP.x >= 0 ? 1 : -1, 0, 0);
            else if (dz <= dx && dz <= dy) _pushDir.set(0, 0, _localP.z >= 0 ? 1 : -1);
            else _pushDir.set(0, _localP.y >= 0 ? 1 : -1, 0);
            const pen = Math.min(dx, dy, dz);
            _pushDir.applyQuaternion(b.quat);
            p.addScaledVector(_pushDir, pen);
          }
        }
      }
    }
    return p;
  }

  // The stroll: a polyline through cell centres, sampled by distance along it.
  let routeLengths = [];
  let routeTotal = 1;
  function buildPatrolPath(route) {
    patrolSamples = route.map((p) => p.clone().setY(1.6));
    routeLengths = [0];
    for (let i = 1; i < patrolSamples.length; i++) routeLengths.push(routeLengths[i - 1] + patrolSamples[i].distanceTo(patrolSamples[i - 1]));
    routeTotal = Math.max(1e-3, routeLengths[routeLengths.length - 1]);
    patrolCurve = true;
  }

  function samplePatrol(u, target = new Vector3()) {
    if (!patrolCurve) return target.set(0, 1.6, 0);
    const d = (((u % 1) + 1) % 1) * routeTotal;
    let lo = 0;
    let hi = routeLengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (routeLengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const f = (d - routeLengths[lo]) / Math.max(1e-6, routeLengths[hi] - routeLengths[lo]);
    return target.lerpVectors(patrolSamples[lo], patrolSamples[hi], f);
  }

  const DEFAULT_ALBEDO = new Color("#e2dfd8");

  function setGeoColor(geo, col) {
    const count = geo.attributes.position.count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = col.r;
      arr[i * 3 + 1] = col.g;
      arr[i * 3 + 2] = col.b;
    }
    geo.setAttribute("color", new BufferAttribute(arr, 3));
  }

  function addMesh(geo, pos, rotY = 0, rotX = 0, rotZ = 0, mat = material, albedo = DEFAULT_ALBEDO) {
    // Clone shared Suzanne geometry before tagging vertex color if needed.
    if (!geo.attributes.color) setGeoColor(geo, albedo);
    const mesh = new Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.rotation.set(rotX, rotY, rotZ);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    group.add(mesh);
    meshes.push(mesh);
    return mesh;
  }

  const _euler = new Euler();
  function addBoxCollider(pos, sx, sy, sz, rotY = 0, rotX = 0, rotZ = 0, reflectivity = 0.78, pitch = 1.0, castsShadow = true, isCylinder = false, albedo = DEFAULT_ALBEDO) {
    const q = new Quaternion().setFromEuler(_euler.set(rotX, rotY, rotZ, "XYZ"));
    // Build rigid transform (no scale) so invMatrix preserves unit ray length.
    const m = new Matrix4().compose(pos, q, new Vector3(1, 1, 1));
    const entry = {
      center: pos.clone(),
      hx: sx * 0.5,
      hy: sy * 0.5,
      hz: sz * 0.5,
      quat: q,
      invMatrix: m.invert(),
      reflectivity,
      pitch,
      isCylinder,
      albedo,
      sculpture: castsShadow,
    };
    boxes.push(entry);
    if (castsShadow) occBoxes.push(entry);
  }

  // mesh: the rendered sculpture; geometry: what rays hit (defaults to its own). Walking uses the sphere.
  function addHull(mesh, radius, albedo, reflectivity = 0.85, pitch = 1.25, geometry = mesh.geometry) {
    const collider = new Mesh(geometry, hullMaterial);
    collider.matrixAutoUpdate = false;
    hulls.push({ mesh, collider, radius, albedo, reflectivity, pitch, center: new Vector3() });
    occSpheres.push({ cx: mesh.position.x, cy: mesh.position.y, cz: mesh.position.z, r: radius, reflectivity, pitch, albedo, sculpture: true });
  }

  function addSphereCollider(pos, r, reflectivity = 0.82, pitch = 1.15, castsShadow = true, albedo = DEFAULT_ALBEDO) {
    const entry = { cx: pos.x, cy: pos.y, cz: pos.z, r, reflectivity, pitch, albedo, sculpture: castsShadow };
    spheres.push(entry);
    if (castsShadow) occSpheres.push(entry);
  }

  function addBox(w, h, d, pos, rotY = 0, rotX = 0, rotZ = 0, reflectivity = 0.78, pitch = 1.0, castsShadow = true, albedo = DEFAULT_ALBEDO) {
    const geo = box(w, h, d);
    setGeoColor(geo, albedo);
    const mesh = addMesh(geo, pos, rotY, rotX, rotZ, material, albedo);
    addBoxCollider(pos, w, h, d, rotY, rotX, rotZ, reflectivity, pitch, castsShadow, false, albedo);
    // Every face of a free-standing box is a finite mirror (not the bottom, which sits on the floor).
    if (castsShadow) {
      const q = new Quaternion().setFromEuler(_euler.set(rotX, rotY, rotZ, "XYZ"));
      const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((a) => a.applyQuaternion(q));
      const half = [w * 0.5, h * 0.5, d * 0.5];
      for (let k = 0; k < 3; k++) {
        for (const sign of [1, -1]) {
          const normal = axes[k].clone().multiplyScalar(sign);
          if (normal.y < -0.5) continue;
          faces.push({
            center: pos.clone().addScaledVector(normal, half[k]),
            normal,
            u: axes[(k + 1) % 3],
            hu: half[(k + 1) % 3],
            hv: half[(k + 2) % 3],
            albedo,
            reflectivity,
            pitch,
            mesh,
          });
        }
      }
    }
    return mesh;
  }

  function rebuild() {
    // Dispose old meshes except shared cachedSuzanneGeo.
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      if (child.geometry && child.geometry !== suzanneGeo) child.geometry.dispose();
    }
    boxes.length = 0;
    spheres.length = 0;
    occBoxes.length = 0;
    occSpheres.length = 0;
    hulls.length = 0;
    animated.length = 0;
    meshes.length = 0;

    const rand = seededRandom(`${getSeed()}:room`);
    const range = (a, b) => a + rand() * (b - a);

    // 1. Enclosed Cornell-gallery room: matte plaster walls with warm left / cool right color bleed.
    const t = 0.4;
    const W = ROOM_HALF_X * 2;
    const D = ROOM_HALF_Z * 2;
    walls.length = 0;
    faces.length = 0;
    const addWall = (geo, pos, albedo, normal, point) => {
      const mesh = addMesh(geo, pos, 0, 0, 0, material, albedo);
      walls.push({ mesh, normal, point, albedo, reflectivity: 0.78, pitch: 0.88 });
    };
    addWall(box(W + t * 2, t, D + t * 2), new Vector3(0, -t * 0.5, 0), ROOM_FLOOR_COLOR, new Vector3(0, 1, 0), new Vector3(0, 0, 0));
    // The ceiling is rarely looked at closely, so it is remembered more coarsely.
    addWall(new BoxGeometry(W + t * 2, t, D + t * 2, Math.ceil(W / 0.3), 1, Math.ceil(D / 0.3)), new Vector3(0, ROOM_HEIGHT + t * 0.5, 0), ROOM_WALL_COLOR, new Vector3(0, -1, 0), new Vector3(0, ROOM_HEIGHT, 0));
    addWall(box(t, ROOM_HEIGHT, D), new Vector3(-ROOM_HALF_X - t * 0.5, ROOM_HEIGHT * 0.5, 0), ROOM_LEFT_COLOR, new Vector3(1, 0, 0), new Vector3(-ROOM_HALF_X, 0, 0));
    addWall(box(t, ROOM_HEIGHT, D), new Vector3(ROOM_HALF_X + t * 0.5, ROOM_HEIGHT * 0.5, 0), ROOM_RIGHT_COLOR, new Vector3(-1, 0, 0), new Vector3(ROOM_HALF_X, 0, 0));
    addWall(box(W, ROOM_HEIGHT, t), new Vector3(0, ROOM_HEIGHT * 0.5, -ROOM_HALF_Z - t * 0.5), ROOM_WALL_COLOR, new Vector3(0, 0, 1), new Vector3(0, 0, -ROOM_HALF_Z));
    addWall(box(W, ROOM_HEIGHT, t), new Vector3(0, ROOM_HEIGHT * 0.5, ROOM_HALF_Z + t * 0.5), ROOM_WALL_COLOR, new Vector3(0, 0, -1), new Vector3(0, 0, ROOM_HALF_Z));

    // 2. The maze: a grid of cells, a random spanning tree carved through it, then a few big rooms
    // knocked open (each holding a sculpture) and some extra openings so there are loops.
    const N = MAZE_N;
    const cellCenter = (cx, cz) => new Vector3(-ROOM_HALF_X + (cx + 0.5) * CELL, 0, -ROOM_HALF_Z + (cz + 0.5) * CELL);
    // open[cell][dir]: dir 0 = +x, 1 = +z.
    const openE = Array.from({ length: N * N }, () => false);
    const openS = Array.from({ length: N * N }, () => false);
    const id = (x, z) => z * N + x;
    const seen = new Array(N * N).fill(false);
    const tree = Array.from({ length: N * N }, () => []);
    const stack = [[0, N - 1]];
    seen[id(0, N - 1)] = true;
    while (stack.length) {
      const [x, z] = stack[stack.length - 1];
      const next = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => [x + dx, z + dz])
        .filter(([nx, nz]) => nx >= 0 && nz >= 0 && nx < N && nz < N && !seen[id(nx, nz)]);
      if (!next.length) {
        stack.pop();
        continue;
      }
      const [nx, nz] = next[Math.floor(rand() * next.length)];
      if (nx !== x) openE[id(Math.min(x, nx), z)] = true;
      else openS[id(x, Math.min(z, nz))] = true;
      tree[id(x, z)].push(id(nx, nz));
      seen[id(nx, nz)] = true;
      stack.push([nx, nz]);
    }

    // Big rooms: rectangles of cells with every inner wall removed, away from the start corner.
    const rooms = [];
    for (let tries = 0; tries < 60 && rooms.length < 5; tries++) {
      const w = 2 + Math.floor(rand() * 2);
      const h = 2 + Math.floor(rand() * 2);
      const x0 = Math.floor(rand() * (N - w));
      const z0 = Math.floor(rand() * (N - h));
      if (x0 < 3 && z0 + h > N - 3) continue;
      if (rooms.some((r) => x0 < r.x0 + r.w + 1 && r.x0 < x0 + w + 1 && z0 < r.z0 + r.h + 1 && r.z0 < z0 + h + 1)) continue;
      rooms.push({ x0, z0, w, h });
      for (let z = z0; z < z0 + h; z++) {
        for (let x = x0; x < x0 + w; x++) {
          if (x < x0 + w - 1) openE[id(x, z)] = true;
          if (z < z0 + h - 1) openS[id(x, z)] = true;
        }
      }
    }
    for (let k = 0; k < N; k++) {
      const x = Math.floor(rand() * (N - 1));
      const z = Math.floor(rand() * (N - 1));
      if (rand() < 0.5) openE[id(x, z)] = true;
      else openS[id(x, z)] = true;
    }

    // Walls as boxes along cell edges (posts at the corners fill the joins).
    const WALL_T = 0.16;
    const wallColor = (x, z) => MAZE_COLORS[(x * 7 + z * 3) % MAZE_COLORS.length];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const c = cellCenter(x, z);
        if (x < N - 1 && !openE[id(x, z)]) {
          addBox(WALL_T, ROOM_HEIGHT, CELL, new Vector3(c.x + CELL / 2, ROOM_HEIGHT / 2, c.z), 0, 0, 0, 0.8, 0.9, true, wallColor(x, z));
        }
        if (z < N - 1 && !openS[id(x, z)]) {
          addBox(CELL, ROOM_HEIGHT, WALL_T, new Vector3(c.x, ROOM_HEIGHT / 2, c.z + CELL / 2), 0, 0, 0, 0.8, 0.9, true, wallColor(z, x));
        }
      }
    }

    // A sculpture in each room; Suzanne in the room farthest from the start, the goal.
    const start = cellCenter(0, N - 1);
    rooms.sort((a, b) => cellCenter(b.x0, b.z0).distanceTo(start) - cellCenter(a.x0, a.z0).distanceTo(start));
    const kinds = ["icosa", "sphere", "dodeca", "octa", "torus"];
    rooms.forEach((r, k) => {
      const c = cellCenter(r.x0, r.z0).add(new Vector3((r.w - 1) * CELL * 0.5, 0, (r.h - 1) * CELL * 0.5));
      const plinthH = range(0.7, 1.0);
      addBox(0.8, plinthH, 0.8, new Vector3(c.x, plinthH / 2, c.z), range(0, Math.PI), 0, 0, 0.8, 0.95, true);
      if (k === 0 && suzanneGeo) {
        const suzY = plinthH - suzanneGeo.boundingBox.min.y * 0.7 + 0.04;
        const suz = addMesh(suzanneGeo, new Vector3(c.x, suzY, c.z), range(-Math.PI, Math.PI));
        suz.scale.setScalar(0.7);
        suz.updateMatrix();
        suz.updateMatrixWorld(true);
        suzanneGeo.computeBoundingSphere();
        addHull(suz, suzanneGeo.boundingSphere.radius * 0.7 + 0.05, DEFAULT_ALBEDO, 0.84, 1.18, suzanneGeo.userData.hull ?? suzanneGeo);
        goal.copy(c);
        return;
      }
      const kind = kinds[k % kinds.length];
      const radius = 0.42;
      const pos = new Vector3(c.x, plinthH + radius + 0.08, c.z);
      let geo;
      if (kind === "sphere") geo = new SphereGeometry(radius, 48, 32);
      else if (kind === "torus") geo = new TorusGeometry(radius, 0.12, 24, 64);
      else if (kind === "icosa") geo = subdivideFlat(new IcosahedronGeometry(radius, 0), 3);
      else if (kind === "dodeca") geo = subdivideFlat(new DodecahedronGeometry(radius, 0), 3);
      else geo = subdivideFlat(new OctahedronGeometry(radius, 0), 3);
      const albedo = MAZE_COLORS[(k + 1) % MAZE_COLORS.length];
      const mesh = addMesh(geo, pos, range(0, Math.PI), range(-0.3, 0.3), 0, material, albedo);
      // A sphere is its own exact collider; the other shapes are hit on their mesh.
      if (kind === "sphere") addSphereCollider(pos, radius, 0.85, 1.35, true, albedo);
      else addHull(mesh, (kind === "torus" ? radius + 0.12 : radius) + 0.05, albedo);
      if (kind !== "sphere") animated.push({ mesh, baseY: pos.y, baseYaw: mesh.rotation.y, spin: 0.15, bob: 0.03, phase: k });
    });

    startPos.copy(start);
    // Walk the spanning tree depth first: a continuous stroll down every corridor and back.
    const route = [];
    const visit = (cell) => {
      route.push(cellCenter(cell % N, Math.floor(cell / N)));
      for (const child of tree[cell]) {
        visit(child);
        route.push(cellCenter(cell % N, Math.floor(cell / N)));
      }
    };
    visit(id(0, N - 1));
    buildPatrolPath(route);
    assignMemory();
  }

  // Each vertex gets a texel in the memory texture.
  let memoryCount = 0;
  function assignMemory() {
    memoryCount = 0;
    for (const m of meshes) {
      const n = m.geometry.attributes.position.count;
      const idx = new Float32Array(n);
      for (let i = 0; i < n; i++) idx[i] = memoryCount + i;
      m.geometry.setAttribute("memIndex", new BufferAttribute(idx, 1));
      memoryCount += n;
    }
  }

  function trace(origin, dir, maxT = 40) {
    let best = intersectRoomBounds(origin, dir, maxT);
    let bestT = best ? best.t : maxT;

    for (let i = 0; i < boxes.length; i++) {
      const h = intersectOBB(origin, dir, boxes[i], bestT);
      if (h && h.t < bestT) {
        best = h;
        bestT = h.t;
      }
    }
    for (let i = 0; i < spheres.length; i++) {
      const h = intersectSphere(origin, dir, spheres[i], bestT);
      if (h && h.t < bestT) {
        best = h;
        bestT = h.t;
      }
    }

    for (const h of hulls) {
      h.center.setFromMatrixPosition(h.mesh.matrixWorld);
      const ox = origin.x - h.center.x, oy = origin.y - h.center.y, oz = origin.z - h.center.z;
      const b = ox * dir.x + oy * dir.y + oz * dir.z;
      const c = ox * ox + oy * oy + oz * oz - h.radius * h.radius;
      // Skip unless the ray starts inside the bounds or enters them before the current best hit.
      if (c > 0 && (b > 0 || b * b - c < 0 || -b - Math.sqrt(b * b - c) > bestT)) continue;
      h.collider.matrixWorld.copy(h.mesh.matrixWorld);
      hullRaycaster.set(origin, dir);
      hullRaycaster.near = 0.001;
      hullRaycaster.far = bestT;
      const hit = hullRaycaster.intersectObject(h.collider, false)[0];
      if (!hit || hit.distance >= bestT) continue;
      const n = hit.face.normal.clone().transformDirection(h.mesh.matrixWorld);
      if (n.dot(dir) > 0) n.negate();
      best = { t: hit.distance, normal: n, reflectivity: h.reflectivity, pitch: h.pitch, albedo: h.albedo, sculpture: true };
      bestT = hit.distance;
    }

    if (!best) return null;
    _hit.copy(origin).addScaledVector(dir, best.t);
    return {
      point: _hit.clone(),
      normal: best.normal,
      distance: best.t,
      reflectivity: best.reflectivity,
      pitch: best.pitch,
      albedo: best.albedo ?? DEFAULT_ALBEDO,
      sculpture: !!best.sculpture,
      isRoom: !!best.isRoom,
    };
  }

  function update(time, dt) {
    for (let i = 0; i < animated.length; i++) {
      const a = animated[i];
      a.mesh.rotation.y += dt * a.spin;
      if (a.bob > 0) a.mesh.position.y = a.baseY + Math.sin(time * 0.9 + a.phase) * a.bob;
    }
  }

  rebuild();

  return {
    group,
    meshes,
    walls,
    faces,
    clearPoint,
    startPos,
    goal,
    patrolLength: () => routeTotal,
    memoryCount: () => memoryCount,
    getOccluders: () => ({ occBoxes, occSpheres }),
    getPatrolSamples: () => patrolSamples,
    samplePatrol,
    rebuild,
    trace,
    update,
    bounds: { halfX: ROOM_HALF_X, halfZ: ROOM_HALF_Z, height: ROOM_HEIGHT },
  };
}

// Splits each triangle of a flat-shaded solid into level^2 smaller ones, keeping the faces flat.
function subdivideFlat(geo, level) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.attributes.position;
  const out = [];
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), p = new Vector3();
  const at = (i, j) => p.copy(a).multiplyScalar(1 - (i + j) / level).addScaledVector(b, i / level).addScaledVector(c, j / level).toArray();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    for (let i = 0; i < level; i++) {
      for (let j = 0; j < level - i; j++) {
        out.push(...at(i, j), ...at(i + 1, j), ...at(i, j + 1));
        if (j < level - i - 1) out.push(...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j + 1));
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}
