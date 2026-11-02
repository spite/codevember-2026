import { Color } from "three";
import Maf from "maf";

class GradientLinear {
  constructor(colors) {
    this.colors = colors.map((c) => new Color(c));
  }
  getAt(t) {
    t = Maf.clamp(t, 0, 1);
    const n = this.colors.length - 1;
    if (n === 0) return this.colors[0].clone();
    const from = Math.min(Math.floor(t * n), n - 1);
    const fc = this.colors[from];
    const ft = this.colors[from + 1];
    const p = t * n - from;
    const res = new Color();
    res.r = Maf.mix(fc.r, ft.r, p);
    res.g = Maf.mix(fc.g, ft.g, p);
    res.b = Maf.mix(fc.b, ft.b, p);
    return res;
  }
}

export { GradientLinear };
