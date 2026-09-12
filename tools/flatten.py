"""
Flatten a rigged figure back into the single flat PNG it would have arrived as.

Why this exists: the cut test needs an honest input. The priest was cut by
hand, so his layers are ground truth. Composite them back into one image and
the machine gets exactly what a fresh character would look like - while the
hand-made layers stay available as the answer key.

Effect frames (lightning, fire, smoke) are left out by default. They are
bursts, not part of the resting pose, and a flat character sheet would not
show them either.

    python tools/flatten.py priest
    python tools/flatten.py priest --with-effects --out other.png
"""
import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow fehlt. Installieren mit: python -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent


def flatten(name, with_effects=False, out_name="source.png"):
    fdir = ROOT / "figures" / name
    spec_path = fdir / "figure.json"
    if not spec_path.exists():
        sys.exit(f"keine figure.json unter {fdir}")

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    size = spec.get("size", {})
    w = int(size.get("width", 1000))
    h = int(size.get("height", 1000))

    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    used, skipped = [], []

    for layer in spec.get("layers", []):
        frames = layer.get("frames") or []
        is_effect = bool(frames)
        if is_effect and not with_effects:
            skipped.append(layer["id"])
            continue

        src = frames[0] if is_effect else layer.get("src")
        if not src:
            skipped.append(layer["id"])
            continue

        path = fdir / src
        if not path.exists():
            sys.exit(f"Ebene fehlt: {path}")

        img = Image.open(path).convert("RGBA")
        if img.size != (w, h):
            img = img.resize((w, h), Image.LANCZOS)
        canvas.alpha_composite(img)
        used.append(layer["id"])

    out_path = fdir / out_name
    canvas.save(out_path)

    import numpy as np
    alpha = np.asarray(canvas)[:, :, 3]
    coverage = float((alpha > 8).mean())

    print(f"geschrieben: {out_path}")
    print(f"groesse: {canvas.size} modus: {canvas.mode}")
    print(f"ebenen benutzt ({len(used)}): {', '.join(used)}")
    if skipped:
        print(f"ausgelassen ({len(skipped)}): {', '.join(skipped)}")
    print(f"deckung: {coverage:.1%} der Flaeche ist nicht durchsichtig")
    if coverage < 0.02:
        sys.exit("FEHLER: das Ergebnis ist praktisch leer")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("figure", help="Ordnername unter figures/")
    ap.add_argument("--with-effects", action="store_true",
                    help="Effekt-Bilder mit einrechnen (erstes Bild je Effekt)")
    ap.add_argument("--out", default="source.png", help="Dateiname der Ausgabe")
    args = ap.parse_args()
    flatten(args.figure, args.with_effects, args.out)
