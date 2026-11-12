# Compares run.sh's captures: old vs new, and old vs old2 (the day's own run-to-run noise).
# Prints a table and writes N-view-cmp.jpg (old | new | difference x8) for every pair.
import glob, os, sys

import numpy as np
from PIL import Image

OUT = sys.argv[1]


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.int16)


def stats(a, b):
    d = np.abs(a - b).max(axis=2)
    return (d > 4).mean() * 100, (d > 16).mean() * 100, int(d.max())


print(f"{'day-view':<12}{'old→new  >4% / >16% / max':<30}{'old→old2 (noise)  >4% / >16% / max':<36}verdict")
for old in sorted(glob.glob(f"{OUT}/old-*.png"), key=lambda p: [int(t) if t.isdigit() else t for t in os.path.basename(p).split("-")]):
    name = os.path.basename(old)[4:-4]
    new, old2 = f"{OUT}/new-{name}.png", f"{OUT}/old2-{name}.png"
    if not (os.path.exists(new) and os.path.exists(old2)):
        print(f"{name:<12}missing captures")
        continue
    a, b, c = load(old), load(new), load(old2)
    if a.shape != b.shape:
        print(f"{name:<12}sizes differ")
        continue
    s, n = stats(a, b), stats(a, c)
    # A change counts when it clearly exceeds what the same build does between two runs.
    verdict = "changed" if s[1] > n[1] + 0.05 or s[2] > n[2] + 12 else "same"
    print(f"{name:<12}{s[0]:6.2f} / {s[1]:6.2f} / {s[2]:3d}          {n[0]:6.2f} / {n[1]:6.2f} / {n[2]:3d}             {verdict}")
    heat = np.clip(np.abs(a - b).max(axis=2) * 8, 0, 255).astype(np.uint8)
    strip = np.concatenate([a.astype(np.uint8), b.astype(np.uint8), np.stack([heat] * 3, 2)], 1)
    Image.fromarray(strip).save(f"{OUT}/{name}-cmp.jpg", quality=88)
