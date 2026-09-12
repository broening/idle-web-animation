"""
Split one layer of loose specks into a few groups that can move separately.

A particle layer is not one shape, it is a hundred and fifty. The engine moves
whole layers, so a single `drift` slides all of them as one block - which
reads as a sheet of confetti on a string, not as a stream. Cutting them into
groups and giving each group its own phase is what makes them leave a few at a
time.

Groups are filled round robin over the specks in scan order, so every group
ends up scattered across the whole spray rather than owning one corner of it.
A group that is one solid clump is the block problem again, one tenth the size.

    python tools/split-particles.py figures/grim/layers/Partikel.webp \
        figures/grim/layers --groups 10 --prefix partikel

Every output is the full canvas, like every other layer: the engine crops
nothing and carries no offsets, so a speck stays exactly where it was drawn.

The labelling is union-find over an 8-neighbourhood, written out here rather
than pulled from scipy - the other tools need numpy and Pillow and nothing
else, and one connected-components pass is not worth a third dependency.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def label(mask):
    """Connected components, 8-neighbourhood. Returns a label per pixel."""
    H, W = mask.shape
    lab = np.zeros((H, W), np.int32)
    parent = [0]

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]      # halve the path as we go
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    ys, xs = np.where(mask)
    for y, x in zip(ys, xs):
        seen = []
        # Only the four already-visited neighbours; the other four get us on
        # their own pass.
        for dy, dx in ((-1, -1), (-1, 0), (-1, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and lab[yy, xx]:
                seen.append(lab[yy, xx])
        if seen:
            m = min(seen)
            lab[y, x] = m
            for v in seen:
                union(m, v)
        else:
            parent.append(len(parent))
            lab[y, x] = len(parent) - 1

    # Second pass: every pixel takes its root, so a speck that was found in
    # two halves ends up with one number.
    flat = np.array([find(i) for i in range(len(parent))], np.int32)
    return flat[lab]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="the layer holding all the specks")
    ap.add_argument("out_dir", help="where the groups are written")
    ap.add_argument("--groups", type=int, default=10)
    ap.add_argument("--prefix", default="partikel")
    ap.add_argument("--min-area", type=int, default=0,
                    help="drop specks smaller than this many pixels")
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGBA")
    a = np.asarray(im)
    mask = a[:, :, 3] > 8
    if not mask.any():
        sys.exit("die Ebene ist leer")

    lab = label(mask)
    ids = [i for i in np.unique(lab) if i]
    areas = {i: int((lab == i).sum()) for i in ids}
    ids = [i for i in ids if areas[i] > args.min_area]
    if not ids:
        sys.exit("nach --min-area ist nichts uebrig")

    n = max(1, min(args.groups, len(ids)))
    print("%d Flecken gefunden, %d Gruppen" % (len(ids), n))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(args.src).suffix.lower()

    for g in range(n):
        mine = ids[g::n]                       # round robin: scattered, not clumped
        sel = np.isin(lab, mine)
        part = np.where(sel[:, :, None], a, 0).astype(np.uint8)
        name = "%s-%d%s" % (args.prefix, g + 1, suffix)
        Image.fromarray(part, "RGBA").save(out_dir / name)
        ys, xs = np.where(sel)
        print("  %-16s %3d Flecken, %5d Px, kasten %d %d %d %d"
              % (name, len(mine), int(sel.sum()),
                 xs.min(), ys.min(), xs.max(), ys.max()))

    # Nothing may be lost between the one layer and the many.
    total = sum(len(ids[g::n]) for g in range(n))
    if total != len(ids):
        sys.exit("Fleck verloren: %d von %d verteilt" % (total, len(ids)))
    print("alle %d Flecken verteilt" % total)


if __name__ == "__main__":
    main()
