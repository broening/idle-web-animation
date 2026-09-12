"""
Turn a layerize result into a figure the player can animate.

This is the missing link between "the model cut it up" and "it moves". It
takes the placed, full-canvas layers written by place-cut-test.py, copies them
into a figure folder, and writes a figure.json with a pivot and a motion for
every part - guessed from the name the model gave it.

Guessed is the right word. The pivots are a starting point to be dragged in
the studio, not an answer. What the guess does get right is the *kind* of
joint: a head turns about its neck, an arm about its shoulder, a hand about
its wrist, a torso about its hips.

    python tools/layerize-to-figure.py fal-seedream-layerize priest-cut
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEST = ROOT / "figures" / "priest" / "cut-test"
FIGURES = ROOT / "figures"


def slug(name, i):
    s = "".join(c.lower() if c.isalnum() else "-" for c in (name or f"layer-{i}"))
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:28] or f"layer-{i}"


def alpha_box(path):
    a = np.asarray(Image.open(path).convert("RGBA"))[:, :, 3] > 8
    if not a.any():
        return None
    ys, xs = np.where(a)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def kind_of(name):
    """The body part a layer name refers to, or None."""
    n = (name or "").lower()
    if "eye" in n:
        return "eyes"
    if "head" in n or "hair" in n or "face" in n:
        return "head"
    if "hand" in n or "finger" in n:
        return "hand"
    if "arm" in n or "sleeve" in n:
        return "arm"
    if "chest" in n or "shoulder" in n or "collar" in n or "torso" in n:
        return "chest"
    if "belly" in n or "lower" in n or "waist" in n or "leg" in n:
        return "belly"
    return None


"""Who hangs off whom. Anatomy, not the order the model happened to return."""
PARENT_OF = {
    "eyes": "head",     # eyes ride the head - they may blink, never look elsewhere
    "head": "chest",
    "chest": "belly",
    "arm": "chest",
    "hand": "arm",
    "belly": None,      # the root; the base plate stays independent
}


def link_parents(layers, by_kind):
    """Wire the chain, and take away any motion a child must not have on its own.

    Without this every layer floats free: the head turns and the eyes stay
    behind, which reads as a mask sliding off a face. It is also what makes
    follow-through work at all - a child reads time slightly later than its
    parent, so a hand trails the arm that swings it.
    """
    by_id = {L["id"]: L for L in layers}
    for kind, sid in by_kind.items():
        parent_kind = PARENT_OF.get(kind)
        pid = by_kind.get(parent_kind) if parent_kind else None
        if pid and pid != sid:
            by_id[sid]["parent"] = pid

    # The eyes inherit the head's gaze through the chain. Giving them their own
    # would let them drift away from the face they are painted on.
    eyes = by_kind.get("eyes")
    if eyes:
        L = by_id[eyes]
        L["motions"] = [m for m in L["motions"] if m["type"] != "gaze"]
        if not L["motions"]:
            L["motions"] = [{"type": "blink", "interval": 4.2, "duration": 0.13}]


def rig_for(name, box, W, H):
    """Pivot and motions from what the model called the layer."""
    n = (name or "").lower()
    x0, y0, x1, y1 = box
    cx = (x0 + x1) / 2 / W

    if "eye" in n:
        return [cx, (y0 + y1) / 2 / H], [
            {"type": "blink", "interval": 4.2, "duration": 0.13}], "eyesOpen", 0.5

    if "head" in n or "hair" in n or "face" in n:
        # The neck, not the middle of the skull.
        return [cx, y1 / H], [
            {"type": "gaze", "strength": 1.0, "pixels": 7, "degrees": 1.2, "follow": 0.8}], None, 0.45

    if "hand" in n or "finger" in n:
        # Wrist: the top edge, on the side the arm comes from.
        return [cx, y0 / H], [
            {"type": "sway", "strength": 1.0, "period": 7.5, "degrees": 2.0}], None, 0.7

    if "arm" in n or "sleeve" in n or "shoulder" in n and "chest" not in n:
        return [cx, y0 / H], [
            {"type": "sway", "strength": 0.5, "period": 6.1, "degrees": 1.1}], None, 0.5

    if "cloak" in n or "cape" in n or "coat" in n or "hair" in n or "scarf" in n:
        return [cx, y0 / H], [
            {"type": "sway", "strength": 1.0, "period": 7.5, "degrees": 2.2}], None, 0.4

    if "chest" in n or "shoulder" in n or "collar" in n or "torso" in n:
        return [cx, y1 / H], [
            {"type": "breathe", "strength": 1.3, "period": 4.0}], None, 0.3

    if "belly" in n or "lower" in n or "jacket" in n or "leg" in n or "waist" in n:
        return [cx, y1 / H], [
            {"type": "breathe", "strength": 1.0, "period": 4.0}], None, 0.2

    if any(k in n for k in ("light", "glow", "rune", "fire", "flame", "spark", "lightning")):
        return [cx, (y0 + y1) / 2 / H], [
            {"type": "glow", "strength": 1.0, "period": 5.3, "min": 0.5}], None, 0.8

    # Anything unrecognised gets a whisper of sway rather than nothing, so it
    # is visible in the studio and can be corrected.
    return [cx, y1 / H], [
        {"type": "sway", "strength": 0.3, "period": 9.1, "degrees": 0.8}], None, 0.35


def main(model, out_name):
    src = TEST / model
    placed = sorted((src / "placed").glob("*.png"))
    if not placed:
        sys.exit(f"keine zurueckgesetzten Ebenen in {src / 'placed'} - erst place-cut-test.py laufen lassen")

    meta = json.loads((src / "_response.json").read_text(encoding="utf-8")).get("layers")
    if not meta and (src / "_layers.json").exists():
        meta = json.loads((src / "_layers.json").read_text(encoding="utf-8"))
    meta = meta or []

    out = FIGURES / out_name
    (out / "layers").mkdir(parents=True, exist_ok=True)

    first = Image.open(placed[0])
    W, H = first.size

    layers = []
    background = None
    by_kind = {}

    for i, p in enumerate(placed):
        name = (meta[i].get("name") if i < len(meta) and isinstance(meta[i], dict) else None)
        box = alpha_box(p)
        if box is None:
            print(f"  uebersprungen (leer): {p.name}")
            continue

        if i == 0:
            # The base plate: everything the model did not lift out, plus the
            # reconstruction behind every part it did. This is what keeps a
            # hole from appearing when a part moves.
            dst = out / "layers" / "base.png"
            shutil.copy(p, dst)
            layers.append({
                "id": "base", "src": "layers/base.png", "alt": "Base plate",
                "pivot": [0.5, 0.95], "depth": 0.1,
                "motions": [{"type": "breathe", "strength": 0.4, "period": 4.0}],
            })
            continue

        sid = slug(name, i)
        dst = out / "layers" / f"{sid}.png"
        shutil.copy(p, dst)

        pivot, motions, role, depth = rig_for(name, box, W, H)
        L = {
            "id": sid,
            "src": f"layers/{sid}.png",
            "alt": name or sid,
            "pivot": [round(pivot[0], 3), round(pivot[1], 3)],
            "depth": depth,
            "motions": motions,
        }
        if role:
            L["role"] = role
        layers.append(L)
        by_kind.setdefault(kind_of(name), sid)
        print(f"  {sid:32} pivot {L['pivot']}  {motions[0]['type']}")

    link_parents(layers, by_kind)

    fig = {
        "name": out_name,
        "note": f"Built by tools/layerize-to-figure.py from {model}. "
                "Pivots are guesses from each layer's bounding box - drag them in the studio.",
        "size": {"width": W, "height": H},
        "motion": {"windowSeconds": 8, "followSeconds": 0.085, "parallax": 0.35},
        "layers": layers,
    }
    if background:
        fig["background"] = background

    (out / "figure.json").write_text(json.dumps(fig, indent=2) + "\n", encoding="utf-8")

    idx = FIGURES / "index.json"
    names = json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else []
    if out_name not in names:
        names.append(out_name)
        idx.write_text(json.dumps(names) + "\n", encoding="utf-8")

    print(f"\n{len(layers)} Ebenen -> {out / 'figure.json'}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fal-seedream-layerize",
         sys.argv[2] if len(sys.argv) > 2 else "priest-cut")
