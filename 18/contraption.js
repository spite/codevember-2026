import { Group, Mesh, Vector3, CylinderGeometry, SphereGeometry, BoxGeometry, Matrix4, TubeGeometry, CatmullRomCurve3, Shape, ExtrudeGeometry, TorusGeometry } from "three";
import { Pendulum } from "./pendulum.js";
import { swingPath } from "./gimbal.js";
import { KeyholeGate, TumblerGate, ShutterGate, WallGate, IrisGate, RingsGate, SocketGate, TorusGate } from "./gates.js";
import { slabFromShapes, capSoup, soup, bounds } from "./slab.js";
import { motionValue } from "./motion.js";
import { liftProgress, liftPose, liftFootY } from "./lift.js";
import { suzanneGeometry } from "modules/suzanne/suzanneMesh.js";

const FLOOR_Y = 0;
const LOWEST = 0.62;
const BAND = 0.34;

// Suzanne's model, fetched the first time a Suzanne bob is built.
let suzanne = null;
function suzanneText() {
  suzanne ??= typeof fetch === "function" && typeof window !== "undefined"
    ? fetch(new URL("../assets/suzanne.obj", import.meta.url)).then((r) => r.text())
    : import("node:fs").then((fs) => fs.readFileSync(new URL("../assets/suzanne.obj", import.meta.url), "utf8"));
  return suzanne;
}

// Runs cutter batches in a worker (or inline, for node), resolving with each job's nested loops.
class Cutter {
  constructor(inline = null) {
    this.inline = inline;
    if (inline) return;
    this.worker = new Worker(new URL("./cut.worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.id = 0;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.results);
    };
    // A worker that fails to load or dies takes every batch waiting on it down with it, rather than leaving them hanging.
    this.worker.onerror = this.worker.onmessageerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message ?? "cutter worker failed"));
      this.pending.clear();
    };
  }

  run(batch) {
    if (this.inline) return Promise.resolve(this.inline(batch));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, batch });
    });
  }
}

function inLoop(x, y, a) {
  let inside = false;
  for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
    const yi = a[i + 1], yj = a[j + 1];
    if (yi > y !== yj > y && x < ((a[j] - a[i]) * (y - yi)) / (yj - yi) + a[i]) inside = !inside;
  }
  return inside;
}

function edgeDistance(x, y, a) {
  let d = Infinity;
  for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
    const ax = a[j], ay = a[j + 1], bx = a[i], by = a[i + 1];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
  }
  return d;
}

// Whether a disc of radius r at (x, y) lies wholly in the solid of the cut shapes.
function solidAround(shapes, x, y, r) {
  for (const s of shapes) {
    if (!inLoop(x, y, s.outer) || s.holes.some((h) => inLoop(x, y, h))) continue;
    return edgeDistance(x, y, s.outer) > r && s.holes.every((h) => edgeDistance(x, y, h) > r);
  }
  return false;
}

// How far along the arc (metres) each gate reaches either side of its station, and across it (half-width).
function alongArc(g) {
  if (g.family === "tumbler") return (g.count * (g.pitch ?? 0.033)) / 2 + 0.03;
  if (g.family === "rings") return g.outer + 0.03;
  if (g.family === "socket") return 0.15;
  if (g.family === "torus") return g.major + g.tube;
  return 0.08;
}

const TUMBLER_RADIUS = 0.31;

function across(g) {
  if (g.family === "shutter") return 0.3 + Math.abs(g.motions[1].open);
  if (g.family === "wall") return 0.44;
  if (g.family === "iris") return g.outer ?? 0.31;
  if (g.family === "torus") return g.major + g.tube;
  if (g.family === "tumbler") return Math.max(0.31, ...(g.radii ?? []));
  return 0.31;
}

// One pendulum and the gates it swings through, built from a design (design.js). Time `t` is the pendulum's own: 0 is
// a pass through the bottom, swinging toward +angle.
class Contraption {
  constructor(design, { clearance = 0.004, rodRadius = 0.009, physical = false } = {}) {
    this.design = design;
    this.physical = physical;
    this.group = new Group();
    this.base = new Group();
    this.group.add(this.base);
    const L = design.length;
    if (design.layout === "gimbal") {
      this.gimbal = swingPath(design.gimbal);
      // What the rest of the day asks of a pendulum: its loop, length and swing.
      this.pendulum = { period: this.gimbal.period, length: L, amplitude: design.amplitude };
    } else this.pendulum = new Pendulum({ length: L, amplitude: design.amplitude });
    // The ring stands on the floor round its pivot; the others hang the bob LOWEST over the floor.
    const pivotY = design.layout === "ring" ? FLOOR_Y + L + design.below + BAND - 0.02 : FLOOR_Y + LOWEST + L;
    this.pivot = new Vector3(0, pivotY, 0);
    this.clearance = clearance;
    this.rodRadius = rodRadius;
    // A crosser out of step with the main pendulum (sharing a torus): never all at rest at once.
    this.phased = !!design.crossing?.shared;
    this.baseDepth = 1;
  }

  // Outlines (in x, y, extruded along z) of whatever the gates stand on.
  baseJobs(below, halfAngle) {
    const { pivot, design } = this;
    const L = this.pendulum.length;
    const Rc = L + below;
    const c = [pivot.x, pivot.y];
    const yBot = FLOOR_Y - 0.25;
    const floor = { type: "roundRect", c: [0, pivot.y], h: [20, pivot.y - FLOOR_Y + 0.03], r: 0 };
    if (design.layout === "block") {
      const xEnd = Rc * Math.sin(halfAngle);
      const yTop = pivot.y - Rc * Math.cos(halfAngle);
      return [
        {
          bounds: [-xEnd - 0.02, yBot - 0.02, xEnd + 0.02, yTop + 0.02],
          cell: 0.004,
          smooth: 16,
          outline: {
            add: [{ type: "roundRect", c: [0, (yTop + yBot) / 2], h: [xEnd, (yTop - yBot) / 2], r: 0.05 }],
            clip: [{ type: "outsideCircle", c, r: Rc }],
          },
        },
      ];
    }
    if (design.layout === "rocker" || design.layout === "ring") {
      // Physically, the band stands on the floor however small the bob.
      const Ro = this.physical ? Math.max(Rc + BAND, pivot.y - FLOOR_Y + 0.06) : Rc + BAND;
      const clip = [{ type: "outsideCircle", c, r: Rc }, floor];
      if (design.layout === "rocker") clip.push({ type: "wedge", c, half: halfAngle });
      const yTop = design.layout === "ring" ? pivot.y + Ro : pivot.y - Rc * Math.cos(halfAngle) + BAND;
      const xEnd = design.layout === "ring" ? Ro : Ro * Math.sin(halfAngle);
      return [{ bounds: [-xEnd - 0.02, yBot, xEnd + 0.02, yTop + 0.02], cell: 0.004, smooth: 16, outline: { add: [{ type: "circle", c, r: Ro }], clip } }];
    }
    // Posts: under each gate, a short piece of band on a column down to the floor.
    const jobs = [];
    for (const g of design.gates) {
      const half = alongArc(g) / L + 0.03;
      const at = g.station;
      const Ro = Rc + 0.2;
      const pts = [-half, half].flatMap((a) => [Rc, Ro].map((r) => [pivot.x + r * Math.sin(at + a), pivot.y - r * Math.cos(at + a)]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      jobs.push({
        bounds: [Math.min(...xs) - 0.03, Math.min(...ys) - 0.03, Math.max(...xs) + 0.03, Math.max(...ys) + 0.03],
        cell: 0.003,
        smooth: 14,
        outline: { add: [{ type: "circle", c, r: Ro }], clip: [{ type: "outsideCircle", c, r: Rc }, { type: "wedge", c, half, at }] },
      });
      const r = Rc + 0.12;
      const x = pivot.x + r * Math.sin(at), y = pivot.y - r * Math.cos(at);
      jobs.push({
        bounds: [x - 0.09, yBot, x + 0.09, y + 0.02],
        cell: 0.003,
        outline: { add: [{ type: "roundRect", c: [x, (y + yBot) / 2], h: [0.07, (y - yBot) / 2], r: 0.02 }] },
      });
    }
    return jobs;
  }

  // Gates on the crossing pendulums' own arcs: each crosser is a rig of its own (its ball and rod, its swing plane
  // turned across the main one), cut on its own, and its gates stand on pedestals and columns.
  async buildCrosserGates(cutter, materials) {
    const crossing = this.design.crossing;
    if (!crossing) return;
    const posts = [];
    for (const [i, c] of crossing.crossers.entries()) {
      if (!c.gates?.length) continue;
      const pendulum = this.crossers[i].pendulum;
      const pivot = new Vector3().fromArray(c.pivot);
      const base = new Matrix4().makeRotationY((-c.side * Math.PI) / 2).setPosition(pivot);
      const ball = soup(new SphereGeometry(c.radius, 16, 12));
      const rodLength = c.length - c.radius * 0.5;
      const rod = soup(new CylinderGeometry(this.rodRadius * 0.85, this.rodRadius * 0.85, rodLength, 12, 1));
      const rig = {
        pendulum,
        pivot,
        base,
        physical: this.physical,
        clearance: this.clearance,
        xExtent: c.radius,
        cyclePeriods: 12,
        batch: {
          length: c.length,
          amplitude: c.amplitude,
          pivot: c.pivot,
          base: Float64Array.from(base.elements),
          clearance: this.clearance,
          xExtent: c.radius,
          solids: [
            { positions: ball, ...bounds(ball), offset: Float64Array.from(new Matrix4().makeTranslation(0, -c.length, 0).elements) },
            { positions: rod, ...bounds(rod), offset: Float64Array.from(new Matrix4().makeTranslation(0, -rodLength / 2, 0).elements) },
          ],
        },
      };
      const depth = c.radius + 0.18;
      const gates = c.gates.map((g) =>
        g.family === "shutter"
          ? new ShutterGate(rig, { station: g.station, motions: g.motions, halfWidth: 0.22, top: 0.25, depth, post: this.postFor(g, 0.2) / 2 })
          : new KeyholeGate(rig, { station: g.station, motion: g.motion, discRadius: 0.17, halfWidth: 0.23, above: 0.08, depth }),
      );
      const results = await cutter.run({ rig: rig.batch, jobs: gates.flatMap((g) => g.jobs) });
      let k = 0;
      for (const [i, gate] of gates.entries()) {
        gate.apply(results.slice(k, k + gate.jobs.length), materials);
        k += gate.jobs.length;
        this.group.add(gate.group);
        this.gates.push(gate);
        posts.push({ frame: gate.frame, depth, thickness: 0.1, width: this.postFor(c.gates[i], 0.2) });
      }
    }
    await this.addPosts(cutter, posts, materials);
  }

  // An open trench through the base under each tunnel, so its discs are seen whole, turning: the cut (an arc band
  // round the pivot, out to just under the discs) and the angles its rails span, into its end walls.
  trenches(below) {
    const { pivot, design } = this;
    if (design.layout === "gimbal") return [];
    const L = this.pendulum.length;
    const out = [];
    for (const g of design.gates) {
      if (g.family !== "tumbler") continue;
      const pitch = g.pitch ?? 0.033;
      const h = (((g.count - 1) / 2) * pitch + (pitch - 0.007) / 2 + 0.012) / L;
      const [r0, r1] = [L + below - 0.06, L + TUMBLER_RADIUS + 0.035];
      const arc = (r, a0, a1) => Array.from({ length: 13 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / 12;
        return [pivot.x + r * Math.sin(a), pivot.y - r * Math.cos(a)];
      });
      const [a0, a1] = [g.station - h, g.station + h];
      const span = { from: a0 - 0.03 / L, to: a1 + 0.03 / L };
      // Where the base lies below the discs (under the rings it drops away) there is no trench: the rails stand on legs.
      out.push(r0 < r1 ? { ...span, cut: { type: "poly", points: [...arc(r1, a0, a1), ...arc(r0, a1, a0)] } } : span);
    }
    return out;
  }

  // A pedestal under each gate (in its frame) and a column from it down to the floor.
  async addPosts(cutter, posts, materials, floor = FLOOR_Y) {
    if (!posts.length) return;
    for (const p of posts) p.foot = new Vector3(0, -p.depth - 0.09, 0).applyMatrix4(p.frame);
    const jobs = [
      ...posts.map(({ width, depth }) => ({ bounds: [-width / 2 - 0.01, -depth - 0.16, width / 2 + 0.01, -depth + 0.05], cell: 0.003, outline: { add: [{ type: "roundRect", c: [0, -depth - 0.055], h: [width / 2, 0.095], r: 0.025 }] } })),
      ...posts.map(({ foot }) => ({ bounds: [foot.x - 0.08, floor - 0.27, foot.x + 0.08, foot.y + 0.02], cell: 0.003, outline: { add: [{ type: "roundRect", c: [foot.x, (foot.y + floor - 0.25) / 2], h: [0.05, (foot.y - floor + 0.25) / 2], r: 0.02 }] } })),
    ];
    const shapes = await cutter.run({ rig: null, jobs });
    posts.forEach((post, i) => {
      const pedestal = new Mesh(slabFromShapes(shapes[i], { thickness: post.thickness, bevel: 0.012 }), materials.cradle);
      post.frame.decompose(pedestal.position, pedestal.quaternion, pedestal.scale);
      const column = new Mesh(slabFromShapes(shapes[posts.length + i], { thickness: 0.1, bevel: 0.012, toPiece: false }), materials.cradle);
      column.position.z = post.foot.z;
      this.base.add(pedestal, column);
    });
  }

  // A gate's pedestal width: physically, a shutter's halves keep their feet on it however far they part.
  postFor(g, width) {
    if (!this.physical || g.family !== "shutter") return width;
    return Math.max(width, 2 * (Math.max(...g.motions.map((m) => Math.abs(m.open))) + 0.07));
  }

  // The bob's geometry to show, what the cutter sees of it, and how high its top is (where the rod goes in).
  async bobParts(bobShapes) {
    const bob = this.design.bob;
    if (bob.solid === "sphere") return { geometry: new SphereGeometry(bob.radius, 64, 40), sweep: soup(new SphereGeometry(bob.radius, 20, 14)), top: bob.radius };
    if (bob.solid === "suzanne") {
      const text = await suzanneText();
      const face = new Matrix4().makeRotationY(Math.PI / 2);
      const geometry = suzanneGeometry(text, 2, { center: [0, 0, 0], scale: bob.scale }).applyMatrix4(face);
      geometry.computeVertexNormals();
      const low = suzanneGeometry(text, 0, { center: [0, 0, 0], scale: bob.scale }).applyMatrix4(face);
      low.computeBoundingBox();
      return { geometry, sweep: soup(low), top: low.boundingBox.max.y };
    }
    let top = 0;
    for (const s of bobShapes) for (let i = 0; i < s.outer.length; i += 2) if (Math.abs(s.outer[i]) < 0.01) top = Math.max(top, s.outer[i + 1]);
    return { geometry: slabFromShapes(bobShapes, { thickness: bob.thickness, bevel: Math.min(0.016, bob.thickness * 0.24) }), sweep: capSoup(bobShapes, bob.thickness), top };
  }

  // A gimbal: two arms on two hinges, the bob on its swivel, and gates on pedestals and columns along its loop.
  async buildGimbal(cutter, materials) {
    const { design, gimbal, pivot } = this;
    const bob = design.bob;
    const depth = design.below + 0.06;
    const frames = design.gates.map((g) => new Matrix4().fromArray(g.frame));
    const R = bob.radius * 1.12 + 0.01;
    // A low plinth under it all, the loop the bob draws inlaid in it, and on it a column up to a pedestal under each
    // gate (in the gate's frame).
    const path = design.path;
    let hx = 0, hz = 0;
    for (let i = 0; i < path.length; i += 2) [hx, hz] = [Math.max(hx, Math.abs(path[i])), Math.max(hz, Math.abs(path[i + 1]))];
    for (const f of frames) [hx, hz] = [Math.max(hx, Math.abs(f.elements[12]) + 0.2), Math.max(hz, Math.abs(f.elements[14]) + 0.2)];
    // Slots in the plinth for gates that pop up out of it.
    const slots = design.gates.filter((g) => g.lift).map((g) => g.lift.slot);
    for (const [x, z] of slots.flat()) [hx, hz] = [Math.max(hx, Math.abs(x) + 0.12), Math.max(hz, Math.abs(z) + 0.12)];
    [hx, hz] = [hx + 0.42, hz + 0.42];
    const plinth = 0.07;
    const posts = design.gates.map((g, i) => (g.post ? { ...g.post, index: i, width: this.postFor(g, g.post.width), frame: frames[i], foot: new Vector3(0, -depth - 0.09, 0).applyMatrix4(frames[i]) } : null)).filter(Boolean);
    const jobs = [
      bob.solid ? { bounds: [-0.01, -0.01, 0.01, 0.01], cell: 0.005, outline: { add: [{ type: "circle", r: 0.001 }] } } : { bounds: [-R, -R, R, R], cell: 0.0008, outline: bob.outline },
      { bounds: [-hx - 0.02, -hz - 0.02, hx + 0.02, hz + 0.02], cell: 0.006, smooth: 10, outline: { add: [{ type: "roundRect", h: [hx, hz], r: Math.min(hx, hz) * 0.95 }], sub: slots.map((q) => ({ type: "poly", points: q.map(([x, z]) => [x, -z]) })) } },
      ...posts.map(({ width }) => ({ bounds: [-width / 2 - 0.01, -depth - 0.16, width / 2 + 0.01, -depth + 0.05], cell: 0.003, outline: { add: [{ type: "roundRect", c: [0, -depth - 0.055], h: [width / 2, 0.095], r: 0.025 }] } })),
      // A popping-up gate's column stands on the floor in its slot.
      ...posts.map(({ foot, index }) => {
        const bottom = design.gates[index].lift ? FLOOR_Y - 0.02 : FLOOR_Y + plinth - 0.02;
        return { bounds: [foot.x - 0.08, bottom - 0.01, foot.x + 0.08, foot.y + 0.02], cell: 0.003, outline: { add: [{ type: "roundRect", c: [foot.x, (foot.y + bottom) / 2], h: [0.055, (foot.y - bottom) / 2], r: 0.02 }] } };
      }),
    ];
    const [bobShapes, plinthShapes, ...rest] = await cutter.run({ rig: null, jobs });
    const slab = slabFromShapes(plinthShapes, { thickness: plinth, bevel: 0.02, toPiece: false });
    slab.rotateX(-Math.PI / 2);
    const base = new Mesh(slab, materials.cradle);
    base.position.y = FLOOR_Y + plinth / 2;
    const points = [];
    for (let i = 0; i < path.length; i += 2) points.push(new Vector3(path[i], FLOOR_Y + plinth + 0.001, path[i + 1]));
    const drawn = new Mesh(new TubeGeometry(new CatmullRomCurve3(points, true), 600, 0.007, 6, true), materials.accent);
    // A Foucault pendulum's plinth is left plain, its slots the only marks on it.
    this.base.add(base);
    if (!design.foucault) this.base.add(drawn);
    posts.forEach((post, i) => {
      const pedestal = new Mesh(slabFromShapes(rest[i], { thickness: post.thickness, bevel: 0.012 }), materials.cradle);
      post.frame.decompose(pedestal.position, pedestal.quaternion, pedestal.scale);
      const column = new Mesh(slabFromShapes(rest[posts.length + i], { thickness: 0.11, bevel: 0.012, toPiece: false }), materials.cradle);
      column.position.z = post.foot.z;
      post.pedestal = pedestal;
      post.column = column;
      if (!design.gates[post.index].lift) return this.base.add(pedestal, column);
      // A popping-up gate carries its pedestal; its column telescopes, from the floor.
      const telescope = new Group();
      telescope.position.y = FLOOR_Y - 0.02;
      column.position.y = -(FLOOR_Y - 0.02);
      telescope.add(column);
      this.base.add(telescope);
      post.telescope = telescope;
    });
    const stands = new Map(posts.map((p) => [p.index, p]));

    const { geometry, sweep, top } = await this.bobParts(bobShapes);
    const rr = this.rodRadius;
    // The upper arm from the pivot to the hinge, the hinge's axle, the lower arm down into the bob on its swivel.
    this.arm = new Group();
    this.arm.position.copy(pivot);
    const upperRod = new CylinderGeometry(rr * 1.15, rr * 1.15, gimbal.upper, 20, 1);
    const upper = new Mesh(upperRod, materials.rod);
    upper.position.y = -gimbal.upper / 2;
    this.hinge = new Group();
    this.hinge.position.y = -gimbal.upper;
    const axle = new Mesh(new CylinderGeometry(0.022, 0.022, 0.1, 24, 1).rotateZ(Math.PI / 2), materials.rod);
    const knuckle = new Mesh(new SphereGeometry(0.03, 24, 16), materials.rod);
    const lowerLength = gimbal.lower - top + 0.03;
    const lowerRod = new CylinderGeometry(rr, rr, lowerLength, 20, 1);
    const lower = new Mesh(lowerRod, materials.rod);
    lower.position.y = -lowerLength / 2;
    this.swivel = new Group();
    this.swivel.position.y = -gimbal.lower;
    this.swivel.add(new Mesh(geometry, materials.bob));
    this.hinge.add(axle, knuckle, lower, this.swivel);
    this.arm.add(upper, this.hinge);
    this.group.add(this.arm);

    const segment = (h) => [0, -h / 2, 0, 0, h / 2, 0];
    const lowerSoup = soup(new CylinderGeometry(rr, rr, lowerLength, 12, 1));
    const upperSoup = soup(new CylinderGeometry(rr * 1.15, rr * 1.15, gimbal.upper, 12, 1));
    const rig = {
      gimbal,
      pivot,
      physical: this.physical,
      clearance: this.clearance,
      xExtent: Math.max(bob.thickness / 2, rr),
      bobRadius: bob.radius,
      cyclePeriods: 1,
      batch: {
        gimbal: design.gimbal,
        clearance: this.clearance,
        solids: [
          { positions: sweep, ...bounds(sweep), offset: Float64Array.from(new Matrix4().elements), link: "bob" },
          { positions: lowerSoup, ...bounds(lowerSoup), offset: Float64Array.from(new Matrix4().makeTranslation(0, -lowerLength / 2, 0).elements), link: "lower", segment: segment(lowerLength), thick: rr + 0.004 },
          { positions: upperSoup, ...bounds(upperSoup), offset: Float64Array.from(new Matrix4().makeTranslation(0, -gimbal.upper / 2, 0).elements), link: "upper", segment: segment(gimbal.upper), thick: rr + 0.004 },
        ],
      },
    };
    this.rig = rig;
    this.gates = design.gates.map((g, i) => {
      const station = { frame: frames[i], pass: g.pass };
      switch (g.family) {
        case "tumbler": return new TumblerGate(rig, { station, motions: g.motions, pitch: g.pitch, thickness: g.thickness, radii: g.radii });
        case "shutter": return new ShutterGate(rig, { station, motions: g.motions, depth, post: this.postFor(g, g.post.width) / 2 });
        case "iris": return new IrisGate(rig, { station, motions: g.motions, aperture: g.aperture, lean: g.lean, outer: g.outer, depth });
        default: return new KeyholeGate(rig, { station, motion: g.motion, depth, ...g.size });
      }
    });
    const results = await cutter.run({ rig: rig.batch, jobs: this.gates.flatMap((g) => g.jobs) });
    let k = 0;
    for (const gate of this.gates) {
      gate.apply(results.slice(k, k + gate.jobs.length), materials);
      k += gate.jobs.length;
      this.group.add(gate.group);
    }
    // Popping-up gates: everything of the gate, and its pedestal, in a group posed by its lift.
    this.lifts = [];
    design.gates.forEach((g, i) => {
      if (!g.lift) return;
      const gate = this.gates[i];
      const lifter = new Group();
      for (const child of [...gate.group.children]) lifter.add(child);
      const stand = stands.get(i);
      if (stand) {
        stand.pedestal.position.set(0, 0, 0);
        stand.pedestal.quaternion.identity();
        lifter.add(stand.pedestal);
      }
      gate.group.add(lifter);
      lifter.matrixAutoUpdate = false;
      const inverse = frames[i].clone().invert();
      gate.lift = { ...g.lift, pass: g.pass, lifter, inverse, telescope: stand?.telescope, reach: stand ? stand.foot.y - (FLOOR_Y - 0.02) : 1 };
      this.lifts.push(gate.lift);
    });
    // Down already, but for any that are up at the start.
    this.update(0);
    this.crossers = [];
    this.addMarkers(materials);
    this.height = pivot.y + 0.2 - FLOOR_Y;
    return this;
  }

  async build(cutter, materials) {
    if (this.gimbal) return this.buildGimbal(cutter, materials);
    const { pendulum, pivot, design } = this;
    const bob = design.bob;
    const L = pendulum.length;
    // Whatever the gates stand on runs `below` under the bob's path; the gates reach down into it.
    const below = design.below;
    const depth = below + 0.15;
    const outer = Math.max(0, ...design.gates.map((g) => Math.abs(g.station) + alongArc(g) / L));
    const halfAngle = Math.max((22 * Math.PI) / 180, outer + (design.layout === "rocker" ? 0.005 : 0.05));
    // Deep enough that nothing a gate hides in it ever shows through its sides.
    const baseDepth = 2 * Math.max(0.35, ...design.gates.map((g) => across(g) + 0.04));
    this.baseDepth = baseDepth;
    const R = bob.radius * 1.12 + 0.01;
    const baseJobs = this.baseJobs(below, halfAngle);
    const trenches = this.trenches(below);
    for (const job of baseJobs) (job.outline.sub ??= []).push(...trenches.filter((t) => t.cut).map((t) => t.cut));
    const outlined = !bob.solid;
    const [bobShapes, ...baseShapes] = await cutter.run({
      rig: null,
      jobs: [...(outlined ? [{ bounds: [-R, -R, R, R], cell: 0.0008, outline: bob.outline }] : [{ bounds: [-0.01, -0.01, 0.01, 0.01], cell: 0.005, outline: { add: [{ type: "circle", r: 0.001 }] } }]), ...baseJobs],
    });
    // A solid bob's mesh to show, a lighter one for the cutter, and how high its top is (where the rod goes in).
    let bobGeometry, sweepGeometry, top;
    if (bob.solid === "sphere") {
      bobGeometry = new SphereGeometry(bob.radius, 64, 40);
      sweepGeometry = new SphereGeometry(bob.radius, 20, 14);
      top = bob.radius;
    } else if (bob.solid === "suzanne") {
      const text = await suzanneText();
      const face = new Matrix4().makeRotationY(Math.PI / 2);
      bobGeometry = suzanneGeometry(text, 2, { center: [0, 0, 0], scale: bob.scale }).applyMatrix4(face);
      bobGeometry.computeVertexNormals();
      sweepGeometry = suzanneGeometry(text, 0, { center: [0, 0, 0], scale: bob.scale }).applyMatrix4(face);
      sweepGeometry.computeBoundingBox();
      top = sweepGeometry.boundingBox.max.y;
    }

    this.arm = new Group();
    this.arm.position.copy(pivot);
    if (outlined) bobGeometry = slabFromShapes(bobShapes, { thickness: bob.thickness, bevel: Math.min(0.016, bob.thickness * 0.24) });
    const bobMesh = new Mesh(bobGeometry, materials.bob);
    bobMesh.position.y = -L;
    // The rod runs into the bob's top.
    if (outlined) {
      top = 0;
      for (const s of bobShapes) for (let i = 0; i < s.outer.length; i += 2) if (Math.abs(s.outer[i]) < 0.01) top = Math.max(top, s.outer[i + 1]);
    }
    const rodBottom = -L + top - 0.03;
    const rod = new Mesh(new CylinderGeometry(this.rodRadius, this.rodRadius, -rodBottom, 20, 1), materials.rod);
    rod.position.y = rodBottom / 2;
    this.arm.add(bobMesh, rod);
    this.group.add(this.arm);
    let baseTop = FLOOR_Y;
    for (const shapes of baseShapes) {
      const geometry = slabFromShapes(shapes, { thickness: baseDepth, bevel: 0.016, toPiece: false });
      if (!geometry) continue;
      this.base.add(new Mesh(geometry, materials.cradle));
      baseTop = Math.max(baseTop, geometry.boundingBox.max.y);
    }
    // Each tunnel's discs ride on two rails, either side of their lowest point.
    for (const { from, to } of trenches) {
      const r = 0.012, phi = 0.5, out = TUMBLER_RADIUS + r;
      const rail = L + out * Math.cos(phi), deep = L + design.below + 0.03;
      for (const side of [-1, 1]) {
        const z = side * out * Math.sin(phi);
        if (deep - rail < 0.06) {
          // Along the trench, set into its ends.
          const geometry = new TorusGeometry(rail, r, 12, 48, to - from).rotateZ(from - Math.PI / 2);
          this.base.add(new Mesh(geometry.translate(this.pivot.x, this.pivot.y, z), materials.rod));
          continue;
        }
        // Where the base lies further down (under the rings it drops away), each rail bends down at either end into a
        // leg of the same rod, into the base: one tube, legs, bends and rail, along (u, radius) with u round the arc.
        const b = 0.04, length = (to - from) * rail;
        const at = (u, rr) => new Vector3(this.pivot.x + rr * Math.sin(from + u / rail), this.pivot.y - rr * Math.cos(from + u / rail), z);
        const points = [];
        for (let k = 0; k <= 4; k++) points.push(at(0, deep + ((rail + b - deep) * k) / 4));
        for (let k = 1; k <= 8; k++) {
          const a = (k / 8) * (Math.PI / 2);
          points.push(at(b - b * Math.cos(a), rail + b - b * Math.sin(a)));
        }
        for (let k = 1; k < 24; k++) points.push(at(b + ((length - 2 * b) * k) / 24, rail));
        for (let k = 0; k <= 8; k++) {
          const a = (k / 8) * (Math.PI / 2);
          points.push(at(length - b + b * Math.sin(a), rail + b - b * Math.cos(a)));
        }
        for (let k = 1; k <= 4; k++) points.push(at(length, rail + b + ((deep - rail - b) * k) / 4));
        const curve = new CatmullRomCurve3(points, false, "centripetal");
        this.base.add(new Mesh(new TubeGeometry(curve, 200, r, 12, false), materials.rod));
      }
    }
    if (design.layout === "ring") {
      // The axle, held from behind by a spoked hub on the ring.
      const z = -baseDepth / 2 - 0.035;
      // Three spokes and a hub, built round the origin (where `rot` turns them) and moved to the pivot.
      const [spokes] = await cutter.run({
        rig: null,
        jobs: [
          {
            bounds: [-L - below - 0.2, -L - below - 0.2, L + below + 0.2, L + below + 0.2],
            cell: 0.004,
            outline: {
              add: [
                { type: "circle", r: 0.13 },
                ...[0, 1, 2].map((k) => ({ type: "roundRect", c: [0, (L + below + 0.15) / 2], h: [0.035, (L + below + 0.15) / 2], r: 0.02, rot: Math.PI + ((k - 1) * 2 * Math.PI) / 3 })),
              ],
            },
          },
        ],
      });
      const wheel = new Mesh(slabFromShapes(spokes, { thickness: 0.05, bevel: 0.012, toPiece: false }), materials.cradle);
      wheel.position.set(pivot.x, pivot.y, z);
      const axle = new Mesh(new CylinderGeometry(0.03, 0.03, -z + 0.03, 24, 1), materials.rod);
      axle.rotation.x = Math.PI / 2;
      axle.position.set(pivot.x, pivot.y, z / 2 + 0.015);
      this.base.add(wheel, axle);
    }
    // The crossing pendulums, hanging from out of frame like the main one.
    this.crossers = (design.crossing?.crossers ?? []).map((c) => {
      const arm = new Group();
      arm.position.fromArray(c.pivot);
      const rod = new Mesh(new CylinderGeometry(this.rodRadius * 0.85, this.rodRadius * 0.85, c.length - c.radius * 0.5, 16, 1), materials.rod);
      rod.position.y = -(c.length - c.radius * 0.5) / 2;
      const ball = new Mesh(new SphereGeometry(c.radius, 48, 32), materials.bob2);
      ball.position.y = -c.length;
      arm.add(rod, ball);
      this.group.add(arm);
      return { arm, side: c.side, pivot: new Vector3().fromArray(c.pivot), pendulum: new Pendulum({ length: c.length, amplitude: c.amplitude }), phase: c.phase ?? 0 };
    });
    // How tall the set stands, pendulums and all: how far its pieces fly up to leave.
    const pivots = Math.max(pivot.y, ...this.crossers.map((c) => c.pivot.y)) + 0.1;
    this.height = Math.max(baseTop, pivots) - FLOOR_Y + 0.1;

    // The cutter sees a prism bob as its caps (its silhouette along the swing), a solid one whole, and a lighter rod.
    const bobSoup = outlined ? capSoup(bobShapes, bob.thickness) : soup(sweepGeometry);
    const rodSoup = soup(new CylinderGeometry(this.rodRadius, this.rodRadius, -rodBottom, 12, 1));
    const rig = {
      pendulum,
      pivot,
      physical: this.physical,
      clearance: this.clearance,
      xExtent: Math.max(bob.thickness / 2, this.rodRadius),
      cyclePeriods: 12,
      batch: {
        length: L,
        amplitude: pendulum.amplitude,
        pivot: pivot.toArray(),
        clearance: this.clearance,
        xExtent: Math.max(bob.thickness / 2, this.rodRadius),
        solids: [
          { positions: bobSoup, ...bounds(bobSoup), offset: Float64Array.from(new Matrix4().makeTranslation(0, -L, 0).elements) },
          { positions: rodSoup, ...bounds(rodSoup), offset: Float64Array.from(new Matrix4().makeTranslation(0, rodBottom / 2, 0).elements) },
        ],
      },
    };

    this.gates = design.gates.map((g) => {
      const { station } = g;
      switch (g.family) {
        case "tumbler": return new TumblerGate(rig, { station, motions: g.motions, pitch: g.pitch, thickness: g.thickness, radii: g.radii });
        case "shutter": return new ShutterGate(rig, { station, motions: g.motions, depth });
        case "wall": return new WallGate(rig, { station, motions: g.motions, depth });
        case "iris": return new IrisGate(rig, { station, motions: g.motions, aperture: g.aperture, lean: g.lean, outer: g.outer, depth });
        case "rings": return new RingsGate(rig, { station, motions: g.motions, outer: g.outer, solid: g.solid, depth });
        case "torus": return new TorusGate(rig, { station, motion: g.motions[0], tube: g.tube, major: g.major, rod: this.rodRadius, depth, passers: (g.through ?? []).map((i) => this.passer(i, g)) });
        case "socket": return new SocketGate(rig, { station, side: g.side, bobThickness: bob.thickness, depth });
        default: return new KeyholeGate(rig, { station, motion: g.motion, depth });
      }
    });
    const results = await cutter.run({ rig: rig.batch, jobs: this.gates.flatMap((g) => g.jobs) });
    let k = 0;
    for (const gate of this.gates) {
      gate.apply(results.slice(k, k + gate.jobs.length), materials);
      k += gate.jobs.length;
      this.group.add(gate.group);
    }
    await this.buildCrosserGates(cutter, materials);
    this.addMarkers(materials);
    return this;
  }

  // The grand alignment: a gold mark on every turning part, placed so that at time 0 (and every `loop` periods after)
  // they all face front at once: a stripe on each tumbler disc's rim (lining up into one bar along the tunnel), a dot
  // on each keyhole disc's face, a dot on each ring's side.
  addMarkers(materials) {
    this.markers = [];
    for (const gate of this.gates) {
      for (const p of gate.pieces) {
        if (!p.mesh || !p.shapes || ["static", "pulse", "wave"].includes(p.motion.type)) continue;
        const axis = p.motion.axis ?? "x";
        const v0 = motionValue(p.motion, 0);
        let mesh = null;
        if (axis === "x" && gate.kind === "tumbler") {
          const R = p.radius ?? gate.discRadius;
          const a = this.solidAngle(p.shapes, R - 0.012, v0, 0.011);
          if (a === null) continue;
          mesh = new Mesh(new BoxGeometry(p.thickness + 0.002, 0.008, 0.026), materials.accent);
          mesh.position.set(0, (R + 0.001) * Math.sin(a), (R + 0.001) * Math.cos(a));
          mesh.rotation.x = Math.PI / 2 - a;
          this.slitMarks(p, R, materials);
        } else if (axis === "x") {
          const R = Math.min(p.job.bounds[2], p.job.bounds[3]) - 0.005;
          let a = null, r;
          for (r of [R - 0.035, R - 0.05, R - 0.025]) if ((a = this.solidAngle(p.shapes, r, v0, 0.02)) !== null) break;
          if (a === null) continue;
          mesh = new Mesh(new CylinderGeometry(0.016, 0.016, p.thickness + 0.003, 28, 1).rotateZ(Math.PI / 2), materials.accent);
          mesh.position.set(0, r * Math.sin(a), r * Math.cos(a));
        } else if (axis === "ry") {
          // Face on at time 0 (turned 0 or a half turn): the dot on whichever side is then in front.
          const [u0, , u1] = p.job.bounds;
          const R = (u1 - u0) / 2 - 0.01 - 0.0225;
          mesh = new Mesh(new CylinderGeometry(0.014, 0.014, p.thickness + 0.003, 24, 1).rotateZ(Math.PI / 2), materials.accent);
          mesh.position.set(0, 0, R * Math.sign(Math.cos(v0) || 1));
        }
        if (!mesh) continue;
        p.mesh.add(mesh);
        this.markers.push(mesh);
      }
    }
  }

  // A tumbler disc's slits for the rod, each marked on the rim either side, so slits lined up along a tunnel read as
  // two lines.
  slitMarks(p, R, materials) {
    const n = 720, r = R - 0.006;
    const solid = Array.from({ length: n }, (_, k) => {
      const a = (k / n) * 2 * Math.PI;
      return solidAround(p.shapes, r * Math.cos(a), r * Math.sin(a), 0.002);
    });
    const start = solid.indexOf(true);
    if (start < 0) return;
    const step = (2 * Math.PI) / n;
    const slits = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (solid[i] || !solid[(i - 1 + n) % n]) continue;
      let w = 0;
      while (!solid[(i + w) % n] && w < n) w++;
      // Only narrow gaps: a slit, not the bob's hole reaching the rim.
      if (w * step * R <= 0.08) slits.push([i * step, (i + w) * step]);
    }
    // An arc over the rim either side of each slit, wrapping onto both faces, as long as leaves room for its neighbours'.
    const pad = 0.006 / R;
    const depth = p.thickness + 0.003;
    slits.forEach(([a0, a1], k) => {
      const next = slits[(k + 1) % slits.length][0] + (k + 1 === slits.length ? 2 * Math.PI : 0);
      const prev = slits[(k - 1 + slits.length) % slits.length][1] - (k === 0 ? 2 * Math.PI : 0);
      const room = slits.length > 1 ? Math.min(next - a1, a0 - prev) / 2 - pad - 0.03 : Infinity;
      const span = Math.max(0.08, Math.min(0.45, room));
      for (const [from, to] of [[a0 - pad - span, a0 - pad], [a1 + pad, a1 + pad + span]]) {
        const shape = new Shape();
        shape.absarc(0, 0, R + 0.001, from, to, false);
        shape.absarc(0, 0, R - 0.022, to, from, true);
        const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
        geometry.translate(0, 0, -depth / 2).rotateY(-Math.PI / 2);
        p.mesh.add(new Mesh(geometry, materials.accent));
      }
    });
  }

  // The angle (in the piece's plane) that faces front once the piece has turned by v0, or the nearest one with solid
  // round it at radius r; null if there is none close.
  solidAngle(shapes, r, v0, size) {
    for (const d of [0, 0.03, -0.03, 0.06, -0.06, 0.1, -0.1, 0.14, -0.14]) {
      const a = v0 + d;
      if (solidAround(shapes, r * Math.cos(a), r * Math.sin(a), size)) return a;
    }
    return null;
  }

  // The box worth framing: the base, the gates, and the bob's swing (the rod runs on up out of frame, except round the
  // ring, which is framed whole).
  framing() {
    const { pivot, pendulum, design } = this;
    const L = pendulum.length;
    const A = pendulum.amplitude;
    let half = 0, top = 0;
    this.base.traverse((o) => {
      if (!o.geometry) return;
      o.geometry.computeBoundingBox();
      half = Math.max(half, Math.abs(o.geometry.boundingBox.min.x + o.position.x), Math.abs(o.geometry.boundingBox.max.x + o.position.x));
      top = Math.max(top, o.geometry.boundingBox.max.y + o.position.y);
    });
    if (this.gimbal) {
      for (let t = 0; t < this.gimbal.period; t += 0.05) {
        const [x, y] = this.gimbal.bob(t);
        half = Math.max(half, Math.abs(x) + design.bob.radius + 0.35);
        top = Math.max(top, y + 0.45);
      }
    } else if (design.layout !== "ring") {
      half = Math.max(half, L * Math.sin(Math.min(A, Math.PI / 2)) + design.bob.radius + 0.1);
      top = Math.max(top, pivot.y - L * Math.cos(A) + design.bob.radius + 0.25);
    }
    // A gimbal's loop reads best from higher up.
    return { center: new Vector3(pivot.x, (top + FLOOR_Y) / 2, pivot.z), width: 2 * half, height: top - FLOOR_Y, depth: this.gimbal ? 1.5 : 1, elevation: this.gimbal ? [24, 34] : [9, 18] };
  }

  update(t) {
    this.holdArms(t);
    for (const gate of this.gates) gate.update(t);
    // Popping-up gates: posed by how far from their pass they are, their columns telescoping under them.
    const T = this.pendulum.period;
    for (const l of this.lifts ?? []) {
      const x = liftProgress(l, Math.abs(((((t - l.pass) % T) + T * 1.5) % T) - T / 2));
      l.lifter.matrix.fromArray(liftPose(l.matrix ??= new Float64Array(16), l, x)).premultiply(l.inverse);
      l.lifter.matrixWorldNeedsUpdate = true;
      if (l.telescope) l.telescope.scale.y = Math.max(0.01, (liftFootY(l, x) - (FLOOR_Y - 0.02)) / l.reach);
    }
  }

  // Where the bob is at time t (world).
  bobPosition(t) {
    if (this.gimbal) {
      const [x, y, z] = this.gimbal.bob(t);
      return new Vector3(x + this.arm.position.x - this.pivot.x, y + this.arm.position.y - this.pivot.y, z);
    }
    const th = this.pendulum.angle(t);
    const L = this.pendulum.length;
    return new Vector3(this.arm.position.x + L * Math.sin(th), this.arm.position.y - L * Math.cos(th), this.arm.position.z);
  }

  // Which way the pendulum hangs from its pivot as shown (world, unit): along its rod, or a gimbal's pivot to its bob.
  hang(out = new Vector3()) {
    if (!this.gimbal) return out.set(0, -1, 0).applyEuler(this.arm.rotation);
    out.set(0, -this.gimbal.lower, 0).applyEuler(this.hinge.rotation);
    out.y -= this.gimbal.upper;
    return out.applyEuler(this.arm.rotation).normalize();
  }

  // A crosser through a torus gate: its rod's ends at time t, and whether its ball is near the torus.
  passer(i, g) {
    const c = this.design.crossing.crossers[i];
    const pendulum = new Pendulum({ length: c.length, amplitude: c.amplitude });
    const pivot = new Vector3().fromArray(c.pivot);
    const phase = c.phase ?? 0;
    const reach = (g.major + g.tube + c.radius + 0.03) / c.length;
    return {
      segment: (t) => {
        const a = pendulum.angle(t + phase);
        return [pivot.clone(), new Vector3(pivot.x, pivot.y - c.length * Math.cos(a), pivot.z + c.side * c.length * Math.sin(a))];
      },
      near: (t) => Math.abs(pendulum.angle(t + phase)) < reach,
    };
  }

  // Whether nothing swinging is near a gate at time t: where a pendulum out of step with the main one (sharing a
  // torus) can be caught and let go, since it is never at rest when the main one is.
  clearAt(t) {
    const P = this.pendulum;
    for (const g of this.gates) {
      const half = g.kind === "torus" ? g.major + g.tube : 0.35;
      if (Math.abs(P.angle(t) - g.station) < (half + 0.1) / P.length) return false;
    }
    for (const c of this.crossers) if (Math.abs(c.pendulum.angle(t + c.phase)) < 0.6 / c.pendulum.length) return false;
    return true;
  }

  // When in a period the bob (or a crosser's ball) goes through a gate.
  passTimes() {
    const out = [];
    for (const g of this.gates) {
      if (g.pass !== undefined) out.push(g.pass);
      else if (g.rig.pendulum.passesInPeriod) out.push(...g.rig.pendulum.passesInPeriod(g.station));
    }
    return out;
  }

  // The pendulums alone, at time t (held there while the gates go on).
  holdArms(t) {
    if (this.gimbal?.foucault) {
      this.arm.rotation.set(0, this.gimbal.precession(t), this.gimbal.a.angle(t), "YZX");
      return;
    }
    if (this.gimbal) {
      const [a, b] = this.gimbal.angles(t);
      this.arm.rotation.z = a;
      this.hinge.rotation.x = b;
      this.swivel.rotation.y = this.gimbal.yaw(t);
      return;
    }
    this.arm.rotation.z = this.pendulum.angle(t);
    for (const c of this.crossers) c.arm.rotation.x = -c.side * c.pendulum.angle(t + c.phase);
  }

  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
  }
}

export { Contraption, Cutter, FLOOR_Y };
