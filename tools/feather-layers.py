"""
Soften every layer's alpha edge, so a cut stops reading as a cut.

A layerize model returns hard alpha. Measured on the priest: only 0.18 to
0.31 % of each layer's pixels are semi-transparent, which means the edges are
one pixel wide and perfectly sharp.

That is fine where the edge is the figure's real silhouette - it sits against
nothing. It is wrong where the edge is an internal cut. The head layer ends in
a hard horizontal line straight across the neck; as soon as the head moves,
that line slides across the base plate and reads as a second contour behind
the face.

Feathering fixes it for the same reason a real painter blends: two overlapping
pieces of the same jacket, softly joined, have no edge to see.

The base plate is left alone. Its outline is the figure against nothing, and
softening that only makes the whole figure look out of focus.

    python tools/feather-layers.py priest-cut
    python tools/feather-layers.py priest-cut --radius 6
"""
import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent


def feather(path, radius, keep_backup=True):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)
    alpha = a[:, :, 3]

    hard = ((alpha > 8) & (alpha < 248)).mean()

    # Pull the edge inwards first, then blur. Blurring alone would spread the
    # layer outwards into pixels it has no colour for, which shows as a dark
    # halo - the exact artefact this is meant to remove.
    solid = Image.fromarray((alpha > 128).astype(np.uint8) * 255)
    eroded = solid.filter(ImageFilter.MinFilter(radius | 1))
    soft = eroded.filter(ImageFilter.GaussianBlur(radius / 2.0))

    out = a.copy()
    out[:, :, 3] = np.minimum(alpha, np.asarray(soft))

    if keep_backup:
        bak = path.with_suffix(path.suffix + ".hard")
        if not bak.exists():
            shutil.copy(path, bak)

    Image.fromarray(out).save(path)
    new_soft = ((out[:, :, 3] > 8) & (out[:, :, 3] < 248)).mean()
    lost = 1 - (out[:, :, 3] > 8).sum() / max(1, (alpha > 8).sum())
    return hard, new_soft, lost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("figure", help="Ordnername unter figures/")
    ap.add_argument("--radius", type=int, default=5,
                    help="Breite des Uebergangs in Pixeln (Standard 5)")
    ap.add_argument("--include-base", action="store_true",
                    help="auch die Basisplatte weichzeichnen (normalerweise falsch)")
    args = ap.parse_args()

    d = ROOT / "figures" / args.figure / "layers"
    if not d.exists():
        sys.exit(f"kein Ordner {d}")

    print(f"{'Ebene':28} {'weich vorher':>13} {'weich nachher':>14} {'Flaeche verloren':>17}")
    n = 0
    for p in sorted(d.glob("*.png")):
        if p.stem == "base" and not args.include_base:
            print(f"{p.stem:28} {'-':>13} {'uebersprungen':>14} {'-':>17}")
            continue
        before, after, lost = feather(p, args.radius)
        print(f"{p.stem[:28]:28} {before:12.2%} {after:13.2%} {lost:16.2%}")
        n += 1
    print(f"\n{n} Ebenen weichgezeichnet, Radius {args.radius} px. "
          f"Die harten Fassungen liegen als *.png.hard daneben.")


if __name__ == "__main__":
    main()
