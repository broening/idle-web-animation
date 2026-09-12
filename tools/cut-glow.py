"""
Pull a glowing part out of a layer by colour, as a screen-blend overlay.

A lantern, a rune, a pair of lit eyes. The light is already painted into the
part it sits on, so cutting it *out* would leave a hole. This takes a copy
instead: the lit pixels stay where they are, and a second layer of the same
pixels rides on top with `"blend": "screen"` and a `glow` motion. Screen adds,
so at rest the two together look like the original and at the top of the pulse
the light gets brighter. Nothing has to be inpainted and nothing can tear.

The halo is a blurred, dilated copy of the same mask in the same colour. It is
what makes the pulse read as light rather than as an opacity slider.

    python tools/cut-glow.py figures/grim/2-Grim-Kopf.webp \
        figures/grim/layers/augen-glut.webp --hue green

Prints the pixel count and the box, because a colour threshold that caught
nothing looks exactly like one that worked until you open the file.
"""
import argparse
import sys

import numpy as np
from PIL import Image, ImageFilter

# Each entry answers: which channel has to lead, and by how much.
HUES = {
    "green": (1, 0, 2),
    "red": (0, 1, 2),
    "blue": (2, 0, 1),
    "cyan": (1, 0, 0),      # lead channel g, both compared against r
    "amber": (0, 2, 2),     # r over b twice; g rides along
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="the layer the light is painted into")
    ap.add_argument("out", help="overlay to write")
    ap.add_argument("--hue", default="green", choices=sorted(HUES))
    ap.add_argument("--lead", type=int, default=90,
                    help="how bright the leading channel must be, 0..255")
    ap.add_argument("--over", type=int, default=30,
                    help="how far it must beat the other two, 0..255")
    ap.add_argument("--halo", type=float, default=5.0,
                    help="blur radius of the bloom, in pixels")
    ap.add_argument("--halo-strength", type=float, default=0.8)
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGBA")
    a = np.asarray(im).astype(np.int16)
    lead, other1, other2 = HUES[args.hue]
    c = [a[:, :, i] for i in range(3)]

    mask = ((a[:, :, 3] > 8)
            & (c[lead] > args.lead)
            & (c[lead] - c[other1] > args.over)
            & (c[lead] - c[other2] > args.over))

    n = int(mask.sum())
    if n == 0:
        sys.exit("keine %s Pixel gefunden - Schwellen senken (--lead, --over)" % args.hue)
    ys, xs = np.where(mask)
    box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))

    # The colour the halo is painted in: the average of what was found, so a
    # sickly green stays sickly instead of turning into a pure hue.
    tint = [int(a[:, :, i][mask].mean()) for i in range(3)]

    core = Image.fromarray((mask * 255).astype(np.uint8), "L")
    # Dilate by one pixel first: a threshold always cuts inside the true edge,
    # and a halo that starts inside the lens leaves a dark ring around it.
    halo = core.filter(ImageFilter.MaxFilter(3)).filter(
        ImageFilter.GaussianBlur(args.halo))

    alpha = np.clip(np.asarray(core).astype(np.float32)
                    + np.asarray(halo).astype(np.float32) * args.halo_strength,
                    0, 255).astype(np.uint8)

    rgb = np.zeros(a.shape[:2] + (3,), np.uint8)
    for i in range(3):
        rgb[:, :, i] = tint[i]
    # Inside the lens the real pixels win; only the bloom is flat tint.
    for i in range(3):
        rgb[:, :, i] = np.where(mask, a[:, :, i].astype(np.uint8), rgb[:, :, i])

    out = np.dstack([rgb, alpha])
    Image.fromarray(out, "RGBA").save(args.out)
    print("%d Pixel  kasten %s  farbe %s -> %s" % (n, box, tint, args.out))


if __name__ == "__main__":
    main()
