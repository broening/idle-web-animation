# idle-web-animation

Turn a flat character PNG into a figure that breathes, blinks, looks around
and throws lightning — as plain layered images driven by a small deterministic
engine. No game engine, no editor licence, no build step.

Made for the loading screen of a RedM server, so **Chromium 103 is the floor**.
It runs the same way on any modern website.

---

## Why not Spine, Live2D or Godot

| | Web runtime | Text-authorable | Cost |
|---|---|---|---|
| **Spine** | `spine-webgl`, also `spine-canvas` (2D canvas) | yes — the JSON skeleton format is documented and editable, plus a headless CLI | $69 Essential / $379 Professional; **Enterprise $2,499 + $379 per user** above $500k revenue. The runtime licence requires holding an editor licence. |
| **Live2D Cubism** | WebGL canvas | no — `.cmo3` / `.moc3` are editor formats | Editor free but hard-capped (1 texture, 100 ArtMeshes, 50 deformers); PRO is paid at any revenue. The separate SDK publication licence is free below ¥10M. |
| **Godot** | WASM bundle, tens of MB | yes — `.tscn` and `.gd` are plain text, and `--headless --script` is documented | free, MIT |
| **this** | DOM + CSS transforms | yes — one JSON file | free |

**The reason is the runtime, not the authoring.** An earlier version of this
file argued that all three are mouse-only and an agent cannot use a mouse.
That is wrong: Godot is thoroughly text-authorable and Spine's skeleton JSON
is a documented, hand-editable format. Only Live2D is genuinely editor-locked.

What none of the three give you is the actual target: **DOM and CSS transforms
inside a 2022-era CEF, shipped as a folder you copy.** Spine and Live2D paint
into a canvas, which cannot be styled, blended or laid out with the rest of the
page. Godot's web export is a WASM runtime measured in tens of megabytes for a
loading screen that has to appear instantly. Spine additionally costs money,
and the runtime licence is tied to owning the editor.

The engine here is 502 non-blank lines.

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
  test-agreement.mjs    proves the DOM and canvas renderers agree
  check-compat.py       refuses anything newer than Chromium 103
figures/                the art. Not in git.
docs/
  figure-json.md        the schema
  principles.md         which Disney principle lives where, and which does not
  models.md             which model for which job, with live prices
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
4. **Four of the twelve principles are genuinely enforced by the engine**,
   four are partial, two are not implemented and two are judgement.
   `docs/principles.md` says which is which and why, rather than claiming
   more than the code does.

## Checking a figure

A single screenshot cannot prove movement, so the studio offers two views:

- **Contact sheet** — 24 frames of the 8 second window in one image.
- **Events** — a 30 second scan at 60 fps listing every blink and burst with
  its duration and spacing.

The second one exists because the first one cannot see short events. Measured
on the shipped figure at 0.5 ms resolution over 600 seconds: a blink holds the
eye closed for **86.1 ms** (86.0 to 86.5), and a sheet sampling every 333 ms
catches **39 of 165**, so it misses about three in four. On this particular
figure it is worse than that — the sample grid is fixed and the blinks never
land on it, so the 24 cell sheet catches **none of them, every time**.

Note that the events scan reads durations off its own 60 fps grid, so it
reports an 86 ms blink as 67 or 83 ms. Good enough to prove the event happens
and to compare spacings; not a measurement instrument.

## Licence

MIT. The character art under `figures/` is not part of it and is not in this
repository.
