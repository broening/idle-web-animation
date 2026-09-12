"""
Put the machine-cut layers back where they belong, then measure them.

Seedream's response carries a bounding box, a name and a z_index for every
layer, but the image files come back cropped and at their own resolution. The
first IoU run ignored all of that and compared free-floating shapes, which is
why a hand matched a head.

With the boxes applied the comparison is honest again, and two different
questions can be asked:

  1. Does the machine's cut agree with the hand-made rig?  (IoU per part)
  2. Is the cut sound on its own terms?  (do the layers, stacked in z order,
     reconstruct the source image, and does every source pixel belong to
     exactly one layer?)

Question 2 is the one that matters for a new figure, where there is no hand
rig to compare against.

    python tools/place-cut-test.py fal-seedream-layerize
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEST = ROOT / "figures" / "priest" / "cut-test"
SOURCE = ROOT / "figures" / "priest" / "source.png"
TRUTH_DIR = ROOT / "figures" / "priest" / "layers"

TRUTH_FOR = {
    "belly": "belly.webp",
    "arm": "arm.webp",
    "chest": "chest.webp",
    "head": "head.webp",
    "eyes": "eyes-open.webp",
    "hand": "hand.webp",
}


def guess_truth(name):
    n = (name or "").lower()
    for key, f in TRUTH_FOR.items():
        if key in n:
            return f
    if "collar" in n or "shoulder" in n:
        return "chest.webp"
    if "stake" in n:
        return "hand.webp"
    if "jacket" in n or "lower" in n:
        return "belly.webp"
    return None


def mask(a, thresh=8):
    return a[:, :, 3] > thresh


def iou(a, b):
    inter = np.logical_and(a, b).sum()
    uni = np.logical_or(a, b).sum()
    return float(inter / uni) if uni else float("nan")


def main(model):
    d = TEST / model
    resp = json.loads((d / "_response.json").read_text(encoding="utf-8"))
    layers = resp.get("layers") or []
    # kie wraps its result in a JSON string inside the response; the collector
    # unpacks it to _layers.json. Same fields as fal, different envelope.
    if not layers and (d / "_layers.json").exists():
        layers = json.loads((d / "_layers.json").read_text(encoding="utf-8"))
    if not layers:
        # Qwen returns a flat `images` list: no bounding box, no name, no
        # z_index. The images are full-canvas, so placement is just a resize -
        # but nothing says which layer is which part, or what order they
        # stack in. That is a real difference in what the two models deliver.
        imgs = resp.get("images") or []
        layers = [{"z_index": i, "bounding_box": None,
                   "name": "base" if i == 0 else "unnamed " + str(i)}
                  for i in range(len(imgs))]
    src = Image.open(SOURCE).convert("RGBA")
    W, H = src.size

    placed_dir = d / "placed"
    placed_dir.mkdir(exist_ok=True)

    stack = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rows = []
    coverage = np.zeros((H, W), dtype=np.int16)

    for i, L in enumerate(layers):
        cands = sorted(d.glob(f"layer_{i:02d}.*"))
        cands = [c for c in cands if c.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg")]
        if not cands:
            continue
        f = cands[0]
        im = Image.open(f).convert("RGBA")
        bb = (L.get("bounding_box") or {}).get("absolute")
        name = L.get("name") or ("base" if i == 0 else f"layer {i}")

        if bb:
            x0, y0, x1, y1 = [int(v) for v in bb]
            w, h = max(1, x1 - x0), max(1, y1 - y0)
            fitted = im.resize((w, h), Image.LANCZOS)
            canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            canvas.alpha_composite(fitted, (x0, y0))
        else:
            canvas = im.resize((W, H), Image.LANCZOS) if im.size != (W, H) else im

        canvas.save(placed_dir / f"{i:02d}-{(name or 'layer')[:28].replace('/', '-')}.png")
        stack.alpha_composite(canvas)

        m = mask(np.asarray(canvas))
        if i > 0:
            coverage += m.astype(np.int16)

        truth_file = guess_truth(name)
        score = float("nan")
        if truth_file and (TRUTH_DIR / truth_file).exists():
            tm = mask(np.asarray(Image.open(TRUTH_DIR / truth_file).convert("RGBA")))
            score = iou(m, tm)
        rows.append((i, name, truth_file, score, float(m.mean())))

    stack.save(d / "_reconstructed.png")

    # How close is the stack to the original?
    s = np.asarray(src).astype(np.int16)
    r = np.asarray(stack).astype(np.int16)
    both = (s[:, :, 3] > 8) & (r[:, :, 3] > 8)
    if both.sum():
        diff = np.abs(s[:, :, :3][both] - r[:, :, :3][both]).mean()
    else:
        diff = float("nan")
    src_m = s[:, :, 3] > 8
    rec_m = r[:, :, 3] > 8
    missing = float((src_m & ~rec_m).sum() / max(1, src_m.sum()))

    print(f"=== {model} ===")
    print(f"{'#':>2}  {'name':34} {'truth':16} {'IoU':>6}  Flaeche")
    for i, name, tf, sc, area in rows:
        sc_s = "  -   " if sc != sc else f"{sc:6.3f}"
        print(f"{i:>2}  {(name or '')[:34]:34} {(tf or '-'):16} {sc_s}  {area:6.1%}")

    good = [sc for _, _, tf, sc, _ in rows if tf and sc == sc]
    if good:
        print(f"\nMittel IoU ueber {len(good)} zugeordnete Teile: {sum(good)/len(good):.3f}")

    over = int((coverage > 1).sum())
    none = int(((coverage == 0) & src_m).sum())
    print(f"\nRekonstruktion:")
    print(f"  Farbabstand zum Original, wo beide deckend sind: {diff:.1f} von 255")
    print(f"  Pixel des Originals, die keine Ebene abdeckt:    {missing:.1%}")
    print(f"  doppelt abgedeckte Pixel:                        {over/ (W*H):.1%}")
    print(f"  gar nicht abgedeckte Pixel der Figur:            {none/max(1,int(src_m.sum())):.1%}")
    print(f"\nZurueckgesetzte Ebenen: {placed_dir}")
    print(f"Rekonstruktion:         {d / '_reconstructed.png'}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fal-seedream-layerize")
