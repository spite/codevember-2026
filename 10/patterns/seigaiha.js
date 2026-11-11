// Seigaiha, the Japanese wave pattern: rows of fans of concentric rings, each row overlapping the bases of the one
// before. The rows are the scales' (level lines of a slope plus noise, folded by the symmetry), with round scales of
// kind 3, which the relief shades as rings around the centre of their free edge.
import { scales } from "./scales.js";

export const seigaiha = (shape, opts, kit) => scales(shape, opts, kit, 3);
