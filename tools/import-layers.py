"""
Turn a folder of already-cut, full-canvas layers into a figure.

Different starting point from layerize-to-figure.py: there a model cut the
picture up and named the parts. Here the parts arrive already separated, one
PNG per part, every one the full canvas, in draw order. Nothing has to be
guessed about *what* was cut - only about where each joint sits.

Files are read in sorted order and are FRONT FIRST, which is how a layer
palette shows them. figure.json lists them the other way round, so the list is
reversed on the way in.

    python tools/import-layers.py <folder> <figure-name>
    python tools/import-layers.py <folder> <figure-name> --names kopf,arme,...

Without --names the part name comes from the file name: a leading number, the
figure's own name and the extension are stripped, so `1-Grim-Waffe.webp`
becomes `waffe`. Naming the files is the cheapest way to rig a figure, and it
survives being re-exported from the drawing program.

Every name is matched against the same vocabulary layerize-to-figure.py uses,
so "kopf" and "head" both produce a neck pivot and a gaze.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FIGURES = ROOT / "figures"

# German names for the same parts. The vocabulary in layerize-to-figure.py is
# English because a model wrote those names; here a person does.
GERMAN = {
    "kopf": "head", "gesicht": "face", "maske": "head", "hut": "head",
    "auge": "eye", "augen": "eye", "linse": "eye", "linsen": "eye",
    "arm": "arm", "arme": "arm", "aermel": "sleeve",
    "hand": "hand", "haende": "hand", "gewehr": "hand", "waffe": "hand",
    "brust": "chest", "torso": "torso", "kragen": "collar",
    "schulter": "shoulder", "ruecken": "back",
    "mantel": "coat", "umhang": "cloak", "cape": "cape", "tuch": "scarf",
    "bauch": "belly", "huefte": "waist",
    "bein": "leg", "beine": "leg", "hose": "leg", "guertel": "waist",
    "riemen": "strap", "gurt": "strap",
    "leuchten": "glow", "glut": "glow",
}


def canon(name):
    """Fold a German part name onto the English word the rig table knows."""
    n = (name or "").lower()
    for de, en in GERMAN.items():
        if de in n:
            n = n + " " + en
    return n


def name_from_file(path, figure):
    """`1-Grim-Waffe.webp` with figure `grim` gives `waffe`."""
    s = path.stem
    while s and (s[0].isdigit() or s[0] in "-_ ."):
        s = s[1:]
    low, fl = s.lower(), figure.lower()
    if low.startswith(fl):
        s = s[len(fl):].lstrip("-_ .")
    return s or path.stem


def slug(name, i):
    s = "".join(c.lower() if c.isalnum() else "-" for c in (name or "layer-%d" % i))
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:28] or "layer-%d" % i


def alpha_box(path):
    a = np.asarray(Image.open(path).convert("RGBA"))[:, :, 3] > 8
    if not a.any():
        return None
    ys, xs = np.where(a)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def kind_of(n):
    if "eye" in n or "lens" in n:
        return "eyes"
    if "head" in n or "hair" in n or "face" in n or "hat" in n:
        return "head"
    if "hand" in n or "finger" in n or "rifle" in n or "gun" in n:
        return "hand"
    if "arm" in n or "sleeve" in n or "shoulder" in n:
        return "arm"
    if "chest" in n or "collar" in n or "torso" in n or "coat" in n:
        return "chest"
    if "cloak" in n or "cape" in n or "scarf" in n or "strap" in n:
        return "cloak"
    if "belly" in n or "leg" in n or "waist" in n or "lower" in n:
        return "belly"
    return None


"""Who hangs off whom. Anatomy, not the order the files happened to arrive in."""
PARENT_OF = {
    "eyes": "head",
    "head": "chest",
    "arm": "chest",
    "hand": "arm",
    "cloak": "chest",
    "chest": "belly",
    "belly": None,      # the root
}


def rig_for(n, box, W, H):
    """Pivot, motions, role and depth from what the part is called."""
    x0, y0, x1, y1 = box
    cx = (x0 + x1) / 2 / W

    if "eye" in n or "lens" in n:
        return [cx, (y0 + y1) / 2 / H], [
            {"type": "glow", "strength": 1.0, "period": 5.3, "min": 0.55,
             "brightness": 0.22}], None, 0.5

    if "head" in n or "hair" in n or "face" in n or "hat" in n:
        # The neck, not the middle of the skull.
        return [cx, y1 / H], [
            {"type": "gaze", "strength": 1.0, "pixels": 7, "degrees": 1.2,
             "follow": 0.8}], None, 0.45

    if "hand" in n or "finger" in n or "rifle" in n or "gun" in n:
        return [cx, y0 / H], [
            {"type": "sway", "strength": 1.0, "period": 7.5, "degrees": 2.0}], None, 0.7

    if "arm" in n or "sleeve" in n or "shoulder" in n:
        # Shoulder: the top edge, where the arm leaves the body.
        return [cx, y0 / H], [
            {"type": "sway", "strength": 0.5, "period": 6.1, "degrees": 1.1}], None, 0.5

    if "cloak" in n or "cape" in n or "scarf" in n or "strap" in n:
        # A hanging cloth turns where it is fastened - its top edge.
        return [cx, y0 / H], [
            {"type": "sway", "strength": 1.0, "period": 7.5, "degrees": 2.2}], None, 0.4

    if "chest" in n or "collar" in n or "torso" in n or "coat" in n:
        return [cx, y1 / H], [
            {"type": "breathe", "strength": 1.3, "period": 4.0}], None, 0.3

    if "belly" in n or "leg" in n or "waist" in n or "lower" in n:
        return [cx, y1 / H], [
            {"type": "breathe", "strength": 1.0, "period": 4.0}], None, 0.2

    if any(k in n for k in ("glow", "light", "rune", "fire", "flame", "spark")):
        return [cx, (y0 + y1) / 2 / H], [
            {"type": "glow", "strength": 1.0, "period": 5.3, "min": 0.5}], None, 0.8

    # Unrecognised parts get a whisper of sway rather than nothing, so they are
    # visible in the studio and can be corrected there.
    return [cx, y1 / H], [
        {"type": "sway", "strength": 0.3, "period": 9.1, "degrees": 0.8}], None, 0.35


def link_parents(layers, by_kind):
    """Wire the chain. A child reads time later than its parent - that is the lag."""
    by_id = {L["id"]: L for L in layers}
    for kind, sid in by_kind.items():
        pid = by_kind.get(PARENT_OF.get(kind))
        if pid and pid != sid:
            by_id[sid]["parent"] = pid

    # Eyes inherit the head's gaze through the chain. Their own would let them
    # drift off the face they are painted on.
    eyes = by_kind.get("eyes")
    if eyes:
        L = by_id[eyes]
        L["motions"] = [m for m in L["motions"] if m["type"] != "gaze"]


def copy_parts(files, names, out):
    """Copy every source file into layers/ and return {id: src, id: box}."""
    copied, boxes = {}, {}
    for i, (p, name) in enumerate(zip(files, names)):
        box = alpha_box(p)
        if box is None:
            print("  uebersprungen (leer): %s" % p.name)
            continue
        sid = slug(name, i)
        rel = "layers/%s%s" % (sid, p.suffix.lower())
        shutil.copy(p, out / rel)
        copied[sid] = (rel, name)
        boxes[sid] = box
    return copied, boxes


def refresh(fig, copied, out, W, H):
    """Second run and later: replace the pixels, leave the rig alone.

    Re-guessing the rig here would be the worst thing this tool could do. The
    pivots and the parent chain are the part a person corrected by hand, and
    they are not recoverable from the images - a redrawn sleeve looks exactly
    like the old one to a bounding box.
    """
    have = {L["id"] for L in fig.get("layers", [])}
    fresh = sorted(copied)
    print("  erneuert: %s" % ", ".join(fresh))

    old = fig.get("size", {})
    if old.get("width") != W or old.get("height") != H:
        print("  ACHTUNG Leinwand war %sx%s, ist jetzt %dx%d. "
              "size in figure.json angepasst; die Pivots gelten weiter, "
              "weil sie in 0..1 stehen."
              % (old.get("width"), old.get("height"), W, H))
        fig["size"] = {"width": W, "height": H}

    # A layer with no source file was derived from one - a glow overlay, a set
    # of closed lids. Nothing here can rebuild it, so say its name out loud.
    derived = sorted(have - set(copied))
    if derived:
        print("  NICHT erneuert, weil abgeleitet: %s" % ", ".join(derived))
        print("    -> tools/cut-glow.py noch einmal laufen lassen, "
              "wenn die Quelle sich geaendert hat")

    neu = sorted(set(copied) - have)
    if neu:
        print("  neue Datei ohne Ebene in figure.json: %s" % ", ".join(neu))
        print("    -> von Hand eintragen, oder --rewrite-rig "
              "(das wirft den Rig weg)")

    missing = [L["id"] for L in fig.get("layers", [])
               if not (out / L["src"]).exists()]
    if missing:
        print("  FEHLT auf der Platte: %s" % ", ".join(missing))

    # A file in layers/ that no layer points at. Hand-drawn extras land here -
    # a set of unlit lenses, a second mouth - and without this they are
    # invisible to everything: the copy step does not touch them, figure.json
    # does not name them, and the studio never lists them.
    used = {L["src"].replace("\\", "/") for L in fig.get("layers", [])}
    orphan = sorted(p.name for p in (out / "layers").iterdir()
                    if p.is_file() and not p.name.startswith(".")
                    and ("layers/" + p.name) not in used)
    if orphan:
        print("  liegt in layers/, wird aber von niemandem benutzt: %s"
              % ", ".join(orphan))
        print("    -> als Ebene in figure.json eintragen, oder loeschen")
    return fig


def build(copied, boxes, name, W, H):
    """First run: guess a rig from the boxes and the names."""
    layers, by_kind = [], {}
    for sid in copied:
        rel, part = copied[sid]
        n = canon(part)
        pivot, motions, role, depth = rig_for(n, boxes[sid], W, H)
        L = {
            "id": sid,
            "src": rel,
            "alt": part,
            "pivot": [round(pivot[0], 3), round(pivot[1], 3)],
            "depth": depth,
            "motions": motions,
        }
        if role:
            L["role"] = role
        layers.append(L)
        by_kind.setdefault(kind_of(n), sid)
        print("  %-24s kasten %s  pivot %s  %s"
              % (sid, boxes[sid], L["pivot"], motions[0]["type"]))

    link_parents(layers, by_kind)
    return {
        "name": name,
        "note": "Built by tools/import-layers.py from parts that arrived already "
                "cut. Pivots are read off each part's alpha box - a starting "
                "point to drag in the studio, not an answer.",
        "size": {"width": W, "height": H},
        "motion": {"windowSeconds": 8, "followSeconds": 0.085, "parallax": 0.25},
        "layers": layers,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="folder of full-canvas images, front first")
    ap.add_argument("name", help="figure name, becomes figures/<name>/")
    ap.add_argument("--names", default="",
                    help="comma separated part names, front first, one per file")
    ap.add_argument("--rewrite-rig", action="store_true",
                    help="throw away an existing figure.json and guess a new "
                         "one. Without this an existing rig is kept and only "
                         "the pixels are refreshed.")
    args = ap.parse_args()

    src = Path(args.folder).expanduser()
    files = sorted(p for p in src.iterdir()
                   if p.is_file() and not p.name.startswith(".")
                   and p.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg"))
    if not files:
        sys.exit("keine Bilder in %s" % src)

    given = [s.strip() for s in args.names.split(",") if s.strip()]
    if given and len(given) != len(files):
        sys.exit("%d Dateien, aber %d Namen" % (len(files), len(given)))

    sizes = {Image.open(p).size for p in files}
    if len(sizes) != 1:
        sys.exit("Ebenen haben verschiedene Groessen: %s - alle muessen die "
                 "gleiche Leinwand sein, sonst stimmt kein Pivot" % sorted(sizes))
    W, H = sizes.pop()

    out = FIGURES / args.name
    (out / "layers").mkdir(parents=True, exist_ok=True)

    # Front first on the way in, back to front in figure.json.
    names = given or [name_from_file(p, args.name) for p in files]
    order = list(zip(files, names))
    order.reverse()
    copied, boxes = copy_parts([p for p, _ in order], [n for _, n in order], out)

    target = out / "figure.json"
    vorhanden = json.loads(target.read_text(encoding="utf-8")) if target.exists() else None
    # An empty layer list is not a rig worth keeping - it is what the studio
    # writes when it creates a figure, before any part has been uploaded.
    # Treating it as one produced a figure with the images copied and nothing
    # wired up, which looks exactly like the import silently failing.
    if vorhanden and vorhanden.get("layers") and not args.rewrite_rig:
        fig = refresh(vorhanden, copied, out, W, H)
        wie = "Rig behalten"
    else:
        fig = build(copied, boxes, args.name, W, H)
        wie = "Rig neu geraten"

    target.write_text(json.dumps(fig, indent=2) + "\n", encoding="utf-8")

    idx = FIGURES / "index.json"
    known = json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else []
    if args.name not in known:
        known.append(args.name)
        idx.write_text(json.dumps(known) + "\n", encoding="utf-8")

    print("\n%d Bilder kopiert, %s -> %s" % (len(copied), wie, target))


if __name__ == "__main__":
    main()
