# Contributing

Thanks for looking. This is a small, dependency-free project, and it wants to
stay that way. A few things make a change easy to accept.

## What you need

- **Python 3** for the tools under `tools/`. Install their two libraries once:
  `pip install -r requirements.txt` (Pillow and numpy). `tools/serve.py`
  itself needs nothing beyond the standard library.
- **Node** for the two test files.
- A browser to open the studio.

## Run the studio

```
python tools/serve.py
```

Then open <http://localhost:5173/studio/>. The player and a figure are all
static files, so `python -m http.server 5173` serves them too, read-only.

## The three rules the code lives by

Read `README.md` and `AGENTS.md` for the why. In short:

1. `solve(figure, t)` is a pure function of time. No `Math.random`, no state
   carried between frames.
2. No dependencies and no build step. A `<script>` tag, images, one JSON file.
3. Chromium 103 is the floor, for the player and the studio. No syntax newer
   than that.

A change that breaks one of these will not be merged, however useful.

## Before you open a pull request

Run the three checks. They must print their last word exactly:

```
node tools/test-determinism.mjs     ->  DETERMINISTISCH
node tools/test-agreement.mjs       ->  EINIG
python tools/check-compat.py        ->  CHROMIUM-103-TAUGLICH
```

The same three run in CI on every push and pull request.

## Working with figures

- Author with full-canvas layers only. `crop` is written by the studio's
  export, never by hand.
- Character art is not in the repository. `figures/` is gitignored except for
  the demo figure `pedro`. Do not commit your own art.
- File names in plain ASCII. A server may not find `%C3%A4`, and a Mac stores
  an umlaut in a different form, so the reference in `figure.json` would not
  match either way.

## Pull requests

- Keep them small and focused. One change per pull request.
- Say what changed and why. Link an issue if there is one.
- Update the docs when behavior changes.
- If you use an AI agent, it should follow `AGENTS.md`; the checks above are
  the gate either way.

## License of your contribution

The code is MIT. By contributing, you agree your contribution is under the
same MIT license. The demo art under `figures/pedro/` is CC BY 4.0 and is not
part of the code license.
