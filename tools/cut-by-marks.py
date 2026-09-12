"""
Cut a flat picture into parts along marks a person painted over it.

The machine cut does not work. docs/cutting.md says why: a layerize model
lifts a part out and leaves black behind it, and no wording stops a full-image
editor re-encoding everything else. What a model cannot know is which pixels
are *meant* to be one part - that a collar belongs to the chest and a strap
does not - and that is exactly the thing a person can say in five seconds with
a brush.

So: the person paints one rough blob per part, in its own colour. This decides
who owns what. The boundary between two blobs is then worked out from the
picture rather than from the blobs, so the marks can stay rough.

    python tools/cut-by-marks.py figures/<name> <name>

Reads, in that folder:

    source.png   the flat picture
    marks.png    one flat colour per part, transparent elsewhere
    marks.json   {"parts": [{"colour": [r,g,b], "name": "kopf"}, ...]}
                 front first, the same order the studio's list shows

Writes `01-<name>.png`, `02-<name>.png` ... into the same folder, every one
the full canvas. From there tools/import-layers.py takes over unchanged: it
reads them in sorted order front first, folds the names onto its part
vocabulary, and guesses pivots, motions, depth and the parent chain.

The pixels written are the source pixels, cut along the mask and nothing else.
Nothing is repainted, so a part looks exactly like it did in the drawing.

A mark does not own everything nearest to it. It spends a budget as it
spreads - `--grow`, in pixels - and a step across an edge the drawing makes
costs several. So the cut follows what was painted, and whatever no mark
reached lands in one leftover layer, or is dropped with `--rest ""`. That is
what makes it possible to take two limbs out of a picture and leave the rest
alone. The first version divided the whole figure between the marks, and two
small strokes on a bear produced two layers of 26 % and 74 % with the seam
down the middle of the animal.

What this does NOT do is fill in what sits behind a part. Cut a head out of a
flat picture and there is a head-shaped hole under it. At the few degrees this
engine moves a layer that is a seam at the edge, not a hole in the middle -
but it is real, and it is why cutting.md asks a model to draw the picture
again without the part. That step is not in here.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# Four neighbours, not eight. A diagonal step lets a region leak through the
# one-pixel gap where two parts touch corner to corner, which shows up as a
# thin spur of the wrong part reaching across a seam.
STEPS = ((-1, 0), (1, 0), (0, -1), (0, 1))


def slug(name, i):
    """Same rule as import-layers.py, so the file name survives the round."""
    s = "".join(c.lower() if c.isalnum() else "-" for c in (name or "teil-%d" % i))
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:28] or "teil-%d" % i


def load_rgba(path, what):
    if not path.exists():
        sys.exit("%s fehlt: %s" % (what, path))
    return np.asarray(Image.open(path).convert("RGBA"))


def shift(a, dy, dx, fill):
    """Move an array by one pixel and pad the edge, without wrapping."""
    out = np.full_like(a, fill)
    ys = slice(max(dy, 0), a.shape[0] + min(dy, 0))
    xs = slice(max(dx, 0), a.shape[1] + min(dx, 0))
    yd = slice(max(-dy, 0), a.shape[0] + min(-dy, 0))
    xd = slice(max(-dx, 0), a.shape[1] + min(-dx, 0))
    out[ys, xs] = a[yd, xd]
    return out


def seeds_from_marks(marks, colours):
    """Which part each painted pixel belongs to, by nearest declared colour.

    Not an exact match. A brush stroke on a canvas is antialiased, so its rim
    is a blend of the colour and nothing, and where two strokes meet the
    pixels are a blend of two colours. Exact matching drops every one of
    those; nearest-colour keeps them and puts them within a pixel of where
    they belong anyway.

    The alpha gate is what keeps a faint rim from voting at all.
    """
    painted = marks[:, :, 3] > 128
    rgb = marks[:, :, :3].astype(np.int16)
    best = np.full(marks.shape[:2], -1, np.int16)
    bestd = np.full(marks.shape[:2], 1 << 30, np.int32)
    for i, c in enumerate(colours):
        d = np.abs(rgb - np.array(c, np.int16)).sum(axis=2).astype(np.int32)
        take = painted & (d < bestd)
        best[take] = i
        bestd[take] = d[take]
    return best


def edge_map(rgb, solid, percentile):
    """Where the drawing itself changes fast.

    A step onto one of these pixels costs the growing mark several steps
    instead of one, so a boundary settles on a line the drawing already has
    rather than halfway between two blobs.

    The threshold is a percentile of this picture rather than a fixed number,
    because painted art and flat art have nothing in common on an absolute
    scale - one figure's strong edge is another's shading.
    """
    a = rgb.astype(np.int16)
    gy = np.zeros(a.shape[:2], np.int32)
    gx = np.zeros(a.shape[:2], np.int32)
    gy[1:, :] = np.abs(a[1:, :, :] - a[:-1, :, :]).sum(axis=2)
    gx[:, 1:] = np.abs(a[:, 1:, :] - a[:, :-1, :]).sum(axis=2)
    g = np.maximum(gy, gx)
    inside = g[solid]
    if inside.size == 0:
        return np.zeros(a.shape[:2], bool)
    cut = np.percentile(inside, percentile)
    return g > cut


def grow(lab, solid, hard, budget, edge_cost):
    """Spread each mark out over the figure, but only so far.

    This used to divide the whole figure up: every pixel went to its nearest
    mark, so two small strokes on a bear made two layers of 26 % and 74 % and
    the seam ran down the middle of the animal. That is a partition, and a
    partition is the wrong shape for the job. What somebody marking a picture
    wants is a *selection*: this bit, and that bit, and leave the rest alone.

    So a mark now spends a budget as it spreads. A step through flat paint
    costs 1; a step across an edge the drawing itself makes costs
    `edge_cost`, so the frontier runs freely inside a shape and grinds to a
    halt at its outline. When the budget is gone it stops, whatever is next
    to it. Everything nobody could reach stays unclaimed - and that is what
    makes it possible to take two limbs out of a picture rather than the
    whole picture.

    Returns the cost map, so the caller can say how far the marks actually
    had to reach.
    """
    dist = np.full(lab.shape, np.inf, np.float32)
    dist[lab >= 0] = 0.0
    step = np.where(hard, np.float32(edge_cost), np.float32(1.0))
    budget = np.float32(budget)

    # One ring per pass at minimum cost, so the budget is also the iteration
    # bound. A small budget is therefore a fast cut, which is the case
    # somebody correcting a mark runs over and over.
    for _ in range(int(budget) + 2):
        moved = False
        for dy, dx in STEPS:
            nd = shift(dist, dy, dx, np.float32(np.inf))
            nl = shift(lab, dy, dx, np.int16(-1))
            cand = nd + step
            take = solid & (nl >= 0) & (cand < dist) & (cand <= budget)
            if take.any():
                dist[take] = cand[take]
                lab[take] = nl[take]
                moved = True
        if not moved:
            break
    return dist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="figures/<name>, holding source.png and marks.png")
    ap.add_argument("name", help="figure name, only used for messages")
    ap.add_argument("--edge", type=float, default=88.0,
                    help="percentile of the picture's own gradient that counts "
                         "as an edge, 0..100. Higher means fewer edges hold "
                         "the boundary back.")
    ap.add_argument("--grow", type=float, default=24.0,
                    help="how far a mark may spread beyond itself, in pixels "
                         "of flat paint. Small means the cut hugs what you "
                         "painted; large means the marks divide the whole "
                         "figure between them.")
    ap.add_argument("--edge-cost", type=float, default=6.0,
                    help="what one step across a drawn edge costs out of the "
                         "grow budget")
    ap.add_argument("--rest", default="rest",
                    help="name for one layer holding everything no mark "
                         "reached. Empty string throws those pixels away "
                         "instead, for taking a few parts out of a picture "
                         "and getting the others from somewhere else.")
    ap.add_argument("--keep", action="store_true",
                    help="leave old NN-*.png files in place instead of "
                         "removing them first")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    src = load_rgba(folder / "source.png", "source.png")
    marks = load_rgba(folder / "marks.png", "marks.png")

    plan_path = folder / "marks.json"
    if not plan_path.exists():
        sys.exit("marks.json fehlt: %s" % plan_path)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    parts = plan.get("parts") or []
    if not parts:
        sys.exit("marks.json nennt keine Teile")

    if src.shape[:2] != marks.shape[:2]:
        sys.exit("source.png ist %dx%d, marks.png ist %dx%d - beide muessen "
                 "dieselbe Leinwand sein"
                 % (src.shape[1], src.shape[0], marks.shape[1], marks.shape[0]))

    H, W = src.shape[:2]
    solid = src[:, :, 3] > 8
    if not solid.any():
        sys.exit("source.png ist ueberall durchsichtig")

    colours = [tuple(int(v) for v in p["colour"]) for p in parts]
    names = [p.get("name") or "" for p in parts]

    seed = seeds_from_marks(marks, colours)
    lab = np.full((H, W), -1, np.int16)
    inside = solid & (seed >= 0)
    lab[inside] = seed[inside]

    # A blob painted next to the figure rather than on it says nothing about
    # any pixel, and the part would come out empty three steps later with no
    # hint why.
    for i, n in enumerate(names):
        if not (lab == i).any():
            outside = int((seed == i).sum())
            sys.exit('Teil "%s" hat keinen Fleck auf der Figur%s'
                     % (n or ("#%d" % (i + 1)),
                        " (%d gemalte Pixel liegen daneben)" % outside
                        if outside else ""))

    hard = edge_map(src[:, :, :3], solid, args.edge)
    dist = grow(lab, solid, hard, args.grow, args.edge_cost)

    total = int(solid.sum())
    rest = solid & (lab < 0)
    n_rest = int(rest.sum())

    # Front first on the way out, so 01 is the frontmost file - that is the
    # order import-layers.py reads. The leftovers go last, because whatever
    # the marks did not claim is what the marked parts sit on.
    order = list(enumerate(names))
    written = []

    if not args.keep:
        for old in folder.glob("[0-9][0-9]-*.png"):
            old.unlink()

    def write(idx, name, mask):
        out = np.zeros_like(src)
        # The source pixels, moved across untouched. Nothing is repainted, so
        # a part looks exactly like it did in the drawing.
        out[mask] = src[mask]
        fname = "%02d-%s.png" % (idx, slug(name, idx))
        Image.fromarray(out, "RGBA").save(folder / fname)
        written.append((fname, int(mask.sum())))

    for i, n in order:
        mask = lab == i
        if not mask.any():
            sys.exit('Teil "%s" hat nach dem Wachsen kein einziges Pixel' % n)
        write(i + 1, n, mask)

    if n_rest and args.rest:
        write(len(order) + 1, args.rest, rest)

    share = sum(c for _, c in written)
    if args.rest and share != total:
        sys.exit("die Teile ergeben %d Pixel, die Figur hat %d" % (share, total))

    reach = dist[np.isfinite(dist) & (lab >= 0)]
    print("%d Teile aus %dx%d, Budget %g px:"
          % (len(written), W, H, args.grow))
    for fname, count in written:
        print("  %-34s %8d px  %5.1f %%" % (fname, count, 100.0 * count / total))
    if reach.size:
        print("weiteste Ausbreitung: %.0f von %g Budget"
              % (float(reach.max()), args.grow))
    if n_rest:
        if args.rest:
            print("%.1f %% der Figur hat kein Fleck erreicht und liegt in "
                  '"%s".' % (100.0 * n_rest / total, args.rest))
        else:
            print("%.1f %% der Figur hat kein Fleck erreicht und wurde "
                  "weggelassen." % (100.0 * n_rest / total))
    else:
        print("Jedes Figurpixel wurde von einem Fleck erreicht - das Budget "
              "reicht weiter als noetig, die Grenzen liegen zwischen den "
              "Flecken statt an ihnen.")
    print("\nWeiter mit:  python tools/import-layers.py %s %s"
          % (folder.as_posix(), args.name))


if __name__ == "__main__":
    main()
