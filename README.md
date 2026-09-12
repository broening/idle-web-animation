# idle-web-animation

Turn a flat character PNG into a figure that breathes, blinks, looks around
and throws lightning — as plain layered images driven by a small deterministic
engine. No game engine, no editor licence, no build step.

Made for the loading screen of a RedM server, so **Chromium 103 is the floor**.
It runs the same way on any modern website.

---

## Why not Spine, Live2D or Godot

| | Editor | Web runtime | Cost |
|---|---|---|---|
| **Spine** | GUI only | WebGL canvas | 69–349 USD, runtime licence requires ownership |
| **Live2D Cubism** | GUI only | WebGL canvas | free below a revenue threshold |
| **Godot** | GUI only | WASM, tens of MB | free |
| **this** | plain JSON | DOM + CSS transforms | free |

All three of the others are built by dragging bones around in a desktop
application. An agent cannot use a mouse; it can write text. That single fact,
plus a target that wants HTML and CSS rather than a canvas, is the whole
argument. The engine here is roughly 500 lines.

---

## Layout

```
player/
  idle.js      the engine: 6 motion blocks, solve(), DOM and canvas renderers
  idle.css     the layout contract - a figure is a stack of full-canvas images
studio/
  index.html   authoring and checking surface
  studio.js    pivot dragging, sliders, contact sheet, events, export, IoU
tools/
  flatten.py            rigged figure -> the one flat PNG it came from
  test-determinism.mjs  proves solve() is a pure function of time
figures/                the art. Not in git.
docs/
  figure-json.md        the schema
  principles.md         which Disney principle lives where
```

## Run it

```bash
python -m http.server 5173
```

Then open <http://localhost:5173/studio/>. `.claude/launch.json` starts the
same server from Claude Code.

## Start a figure

A figure begins as one flat image, straight out of the drawing. Press
**Start from a flat image** in the studio and drop the PNG in. It mounts as a
single layer that breathes — enough to see it alive — and from there it gets
split into parts by a layerize model (see `docs/models.md`) and each part gets
its motion.

The studio never shows the figure's own backdrop. When you are judging how
something moves, a painted scene behind it is noise. Pick a stage colour
instead, or leave it transparent and read the alpha edges against the
checkerboard. The `background` field stays in `figure.json` for the target
that wants it.

## Ship a figure

Export a zip from the studio at whatever size the target wants, drop the
folder next to `player/idle.js`, and mount it:

```html
<link rel="stylesheet" href="player/idle.css">
<div id="hero" style="width:100%;height:100vh"></div>
<script src="player/idle.js"></script>
<script>
  fetch('priest/figure.json').then(function (r) { return r.json(); }).then(function (fig) {
    var f = new IdleFigure(document.getElementById('hero'), fig, 'priest/');
    f.trackPointer();
    f.play();
  });
</script>
```

## The rules that shape the code

1. **Everything is a pure function of time.** `solve(figure, t)` returns the
   same state for the same `t`, always — no `Math.random`, no accumulated
   state. That is what lets the timeline be scrubbed, the contact sheet be
   exact, and the browser and Node agree frame for frame.
2. **No dependencies and no build step.** A plain `<script>` tag, images and a
   JSON file. Copying a folder is the whole deployment.
3. **Chromium 103 is the floor.** No `:has()`, no CSS nesting, no `oklch()`,
   no `color-mix()`, no container queries.
4. **Nine of the twelve principles are enforced by the engine**, not by
   whoever writes the JSON. See `docs/principles.md`.

## Checking a figure

A single screenshot cannot prove movement, so the studio offers two views:

- **Contact sheet** — 24 frames of the 8 second window in one image.
- **Events** — a 30 second scan at 60 fps listing every blink and burst with
  its duration and spacing. This exists because a blink lasts about 70 ms
  while the sheet samples every 330 ms, so the sheet misses roughly three
  blinks out of four. Measured, not assumed.

## Licence

MIT. The character art under `figures/` is not part of it and is not in this
repository.
