"""
Refuse anything Chromium 103 cannot run.

RedM and FiveM ship CEF on Chromium 103.0.5060.141, from June 2022. An upgrade
to Chrome 140 is in progress but not released, so 103 is the floor. Features
newer than that fail silently in the game client while working perfectly in
the browser you tested in - which is the worst possible failure mode.

Comments are stripped first, so a line that *forbids* a feature does not
itself trip the check.

    python tools/check-compat.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    "player/idle.js",
    "player/idle.css",
    "studio/studio.js",
    "studio/studio.css",
    "studio/index.html",
]

# pattern, first Chrome version that has it, what to use instead
BANNED = [
    (r"\bObject\.groupBy\b",           117, "build the map with a loop"),
    (r"\bMap\.groupBy\b",              117, "build the map with a loop"),
    (r"\bPromise\.withResolvers\b",    119, "new Promise(...) and keep the two functions"),
    (r"\bArray\.fromAsync\b",          121, "for await, pushing into an array"),
    (r"\.toSorted\(",                  110, "slice().sort()"),
    (r"\.toReversed\(",                110, "slice().reverse()"),
    (r"\.toSpliced\(",                 110, "slice() then splice()"),
    (r"\.isWellFormed\(",              111, "a regex test"),
    (r":has\(",                        105, "a class set from JS"),
    (r"\boklch\(",                     111, "hex or rgb()"),
    (r"\boklab\(",                     111, "hex or rgb()"),
    (r"\bcolor-mix\(",                 111, "a second custom property"),
    (r"@container\b",                  105, "a media query or a JS resize handler"),
    (r"@scope\b",                      118, "a plain class prefix"),
    (r"text-wrap\s*:\s*balance",       114, "a manual line break"),
    (r"::view-transition",             111, "an opacity or transform transition"),
    (r"\bsubgrid\b",                   117, "nested grid with explicit tracks"),
    (r"\bfield-sizing\s*:",            123, "a fixed size"),
]


def strip_js(src):
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = re.sub(r"(?m)^\s*//.*$", " ", src)
    return src


def strip_css(src):
    return re.sub(r"/\*.*?\*/", " ", src, flags=re.S)


def strip_html(src):
    return re.sub(r"<!--.*?-->", " ", src, flags=re.S)


STRIPPERS = {".js": strip_js, ".mjs": strip_js, ".css": strip_css, ".html": strip_html}


def main():
    problems = []
    checked = 0

    for rel in TARGETS:
        path = ROOT / rel
        if not path.exists():
            problems.append((rel, 0, "Datei fehlt", 0, ""))
            continue
        checked += 1
        raw = path.read_text(encoding="utf-8")
        stripped = STRIPPERS[path.suffix](raw)

        # Keep line numbers usable: comments become spaces, newlines survive.
        for pattern, since, instead in BANNED:
            for m in re.finditer(pattern, stripped):
                line = stripped.count("\n", 0, m.start()) + 1
                problems.append((rel, line, m.group(0), since, instead))

    # CSS nesting: a selector line that starts with & inside a block.
    for rel in TARGETS:
        path = ROOT / rel
        if not path.exists() or path.suffix != ".css":
            continue
        for i, line in enumerate(strip_css(path.read_text(encoding="utf-8")).splitlines(), 1):
            if re.match(r"\s*&", line):
                problems.append((rel, i, "CSS nesting (&)", 112, "write the full selector"))

    if problems:
        print(f"{len(problems)} Problem(e) in {checked} Dateien:\n")
        for rel, line, what, since, instead in problems:
            print(f"  {rel}:{line}  {what}")
            if since:
                print(f"      erst ab Chrome {since}, hier laeuft 103. Stattdessen: {instead}")
        sys.exit(1)

    print(f"{checked} Dateien geprueft, {len(BANNED) + 1} Regeln.")
    print("CHROMIUM-103-TAUGLICH")


if __name__ == "__main__":
    main()
