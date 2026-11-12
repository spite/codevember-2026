# Packs the CC0 scans into 11/textures: python3 pack.py <downloads dir> <out dir>. Sources: ambientCG Rust007, Rust004,
# Metal055C and Poly Haven rust_coarse_01 (1K maps), each in <downloads>/<name>/.
import sys, colorsys
from PIL import Image, ImageFilter, ImageEnhance, ImageStat
T = sys.argv[1]; OUT = sys.argv[2]
def img(name, f, mode="RGB", size=1024):
    return Image.open(f"{T}/{name}/{f}").convert(mode).resize((size, size), Image.LANCZOS)
def grade(im, sat, val):
    im = ImageEnhance.Color(im).enhance(sat)
    return ImageEnhance.Brightness(im).enhance(val)
def median_hex(im):
    s = ImageStat.Stat(im); return "#%02x%02x%02x" % tuple(int(v) for v in s.median)
a = grade(img("Rust007", "albedo_1k.jpg"), 0.82, 0.92)
b = grade(img("Rust004", "albedo_1k.jpg"), 0.8, 1.05)
print("Rust007 graded median", median_hex(a), "Rust004 graded", median_hex(b))
col = Image.new("RGB", (1024, 2048)); col.paste(a, (0, 0)); col.paste(b, (0, 1024))
col.save(f"{OUT}/color.jpg", quality=88)
nrm = Image.new("RGB", (1024, 2048)); nrm.paste(img("Rust007", "normal_1k.png"), (0, 0)); nrm.paste(img("Rust004", "normal_1k.png"), (0, 1024))
nrm.save(f"{OUT}/normal.jpg", quality=92)
S = 512
rough = img("Rust007", "rough_1k.jpg", "L", S)
pits = img("Rust004", "height_1k.png", "L", S)
# Mottle: blurred luminance ratio of rust_coarse_01, recentred on 128.
lum = img("rust_coarse_01", "albedo_1k.jpg", "L", S).filter(ImageFilter.GaussianBlur(6))
m = ImageStat.Stat(lum).mean[0]
mottle = lum.point(lambda v: max(0, min(255, int(128 + (v - m) * 2.2))))
flake = img("Metal055C", "height_1k.png", "L", S)
Image.merge("RGBA", (rough, pits, mottle, flake)).save(f"{OUT}/data.png", optimize=True)
