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

The engine here is 768 non-blank lines.

---

## Layout

```
player/
  idle.js      the engine: 8 motion blocks, solve(), DOM and canvas renderers
  idle.css     the layout contract - a figure is a stack of full-canvas images
studio/
  index.html   authoring and checking surface
  studio.js    pivot dragging, the layer and motion cards, contact sheet,
               events, export, IoU
tools/
  serve.py              the studio's dev server - reads like http.server, writes
  import-layers.py      a folder of already-cut layers -> a rigged figure
  cut-by-marks.py       one flat picture + painted marks -> the parts
  split-particles.py    one layer of specks -> groups that can move apart
  cut-glow.py           a lit part -> a screen-blend overlay that can pulse
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
python tools/serve.py
```

Then open <http://localhost:5173/studio/>. `.claude/launch.json` starts the
same server from Claude Code.

`python -m http.server 5173` still works and still serves everything, but it
cannot write, so the studio switches creating, uploading and saving off and
says why. `tools/serve.py` serves the same files and additionally answers
`PUT` inside `figures/` and can run `import-layers.py` for you. Standard
library only, and it binds to `127.0.0.1`: a server that writes to disk on
request has no business being reachable from the network.

## Start a figure

A figure begins as one flat image, straight out of the drawing. Press
**Start from a flat image** in the studio and drop the PNG in. It mounts as a
single layer that breathes — enough to see it alive — and from there it gets
split into parts by a layerize model (see `docs/models.md`) and each part gets
its motion.

Once a figure is loaded the layer list is a layer palette: drag a row by its
grip to change draw order, and the dot beside it switches that layer off on
the stage. The dot is a way of looking, not a property of the figure — the
contact sheet ignores it, because the sheet's job is to show what ships.

**Save** writes `figure.json` back where it came from. **Reset** throws away
what you have changed and reloads that file. **Delete figure**, two clicks
like removing a layer, throws the whole folder away — every image, the rig,
`figures/index.json`'s entry for it. A figure that only lives in this page
(dropped in from **Start from a flat image** and never saved) needs no
server call for that: discarding it just forgets it, and any other unsaved
figure you have not yet saved stays exactly where it was. All three need
`tools/serve.py`.

A folder can also disappear the ordinary way — deleted by hand, moved, a git
checkout that dropped it — without the studio ever being asked. The list
notices on its own: a figure whose `figure.json` no longer answers is quietly
dropped from the picker and from `index.json`, with one line saying which one
it was. Nothing is guessed back into existence; if every figure listed turns
out to be missing, the studio says so and waits for **Start from a flat
image** or **Create**.

The studio never shows the figure's own backdrop. When you are judging how
something moves, a painted scene behind it is noise. Pick a stage colour
instead, or leave it transparent and read the alpha edges against the
checkerboard. The `background` field stays in `figure.json` for the target
that wants it.

### When all you have is one flat picture

Nothing splits a drawing into parts on its own. A layerize model does not know
that a collar belongs to the chest and a strap does not, and `docs/cutting.md`
measures what happens when you let it try. What it cannot know, you can say in
five seconds with a brush.

Press **Mark** under the stage and paint one rough blob per part, each in its
own colour, then name them. The name is the whole rig: `kopf` or `head` gives
a neck pivot and a gaze, `arm` a shoulder and a sway. **Cut** then splits the
picture along your blobs and hands the parts to the same importer everything
else goes through.

The boundary is not your blob, it comes out of the drawing: each blob spreads
outwards and pays extra to cross an edge the picture already has. How far it
may spread at all is the **reach** slider, and it is the setting that decides
what a cut even is. Small, and the parts follow your brush. Large, and the
marks divide the whole figure between them, with the seams halfway between
your blobs rather than on the drawing.

Whatever no mark reached becomes one layer at the back, or is thrown away, so
you can take two limbs out of this picture and the others out of a different
one. Marked close to their edges at a 24 px reach, the eight parts of `baer`
came back at **0.9967 IoU** against the layers they were flattened from, in
about two seconds.

Three limits worth knowing before you start. A thin part next to a fat one
has to be marked along its length, not with a dot. A bigger reach is not a
better one: on marks painted 10 px inside the true shape, a 15 px reach scored
0.95 and a 90 px reach 0.65. And a flat picture only contains what is
**visible** - a pupil with six visible pixels cannot be cut out at all, and
what sits behind a part is simply not in the file, so a part that moves far
shows a hole. That is why `docs/cutting.md` prefers asking a model to draw the
picture again without the part. Marking is the cheap route, not the good
one.

### Parts out of more than one picture

One picture rarely gives every part at its best. Cut the first for the parts
it does well, cut a second for the rest, and put them on one figure.

Cut each picture into its own figure, with **keep what no mark reached**
switched off so you get only the parts you marked. Then open the figure you
are building and use the **Add part** card: pick the other figure, pick the
layer, press **Bring it in**. It appears on the stage; drag it where it
belongs and set its size, then press **Place**.

The same card takes a **loose image file** of any size, for a part that never
belonged to a figure. **Upload parts…** at the top is the other way in and the
faster one when the images already fit: it takes several at once, but every one
has to be the figure's exact canvas size.

The two pictures do not have to be the same size. The part is scaled and
baked into this figure's canvas, so what ships is an ordinary full-canvas
layer and `idle.js` learns nothing new - which is also why there is no
per-layer scale in `figure.json`.

A placed part arrives with a sway and no parent, because nothing about a
picture says where it hangs. One dropdown in the Layer card fixes that.

### When the parts arrive already cut

Sometimes the splitting has already happened — an artist exported one PNG per
layer, every one the full canvas. Nothing then has to be guessed about *what*
was cut, only about where each joint sits, and `docs/cutting.md` does not
apply at all.

In the studio: type a name, press **Create**, then **Upload parts…** and pick
them all. The same thing from a shell, on a folder that is already there:

```bash
python tools/import-layers.py figures/grim grim
```

Files are read in sorted order, **front first**, the way a layer palette shows
them; `figure.json` lists them the other way round and the tool reverses them.
The part name comes from the file name — `1-Grim-Waffe.webp` becomes `waffe` —
and that name picks the joint: a head turns about its neck, a cloak about its
collar, a torso about its hips. German and English names both work.

What comes out is a starting point, not an answer. It measures each part's
alpha box honestly and guesses the rest, so the pivots want dragging in the
studio and the parent chain wants reading. **The pose decides both**, and no
file name knows the pose. On a figure aiming a rifle, for instance, the head
and the weapon have to carry the same motion and sit at the same depth in the
chain, or the mask leaves the sights — measured on `grim`, matching them holds
the cheek weld to 0.49 px over the whole window.

### Rigging it, without editing the file

Three columns: the layers on the left, the figure in the middle, its settings
on the right. Both rails fold away with the two buttons at the top right, both
can be dragged wider by the line beside them (arrow keys work too), and the
button between them trades their sides for anyone who reads a rig the other
way round. The widths are remembered per browser, not in `figure.json`.

On the stage itself the wheel zooms towards the pointer, a second or tilt
wheel slides sideways (`Shift` and the main wheel do the same), dragging
anywhere that is not a pivot dot pushes the figure about, and **Fit** or a
double-click puts it back. That view is a magnifying glass and nothing else: it is not
saved, and the contact sheet, the events scan and the export all render from
the figure data at their own fixed size.

Everything a rig is made of is in those cards, so the file does not have to be
opened to build one.

- **Layer card** — `parent`, `role`, `blend`, `opacity`, `alt` for whichever
  layer is selected. The `parent` list leaves out every layer that already
  hangs below this one, so the chain cannot be closed into a loop. It also
  says when a `blink` has no eye role to drive, and the other way round.
- **Removing a layer** is at the bottom of the Layer card. It takes two
  clicks, and it deletes the layer's images from the figure folder as well:
  leaving the file behind would put the layer straight back on the next cut
  or upload. Anything that hung off the removed layer hangs off what it hung
  off.
- **Motion card** — add or remove a motion block. Each of the eight types once
  per layer: two blinks on one layer read the same clock and fire as one, and
  two drifts make the layer jump between rises.
- **JSON card** — **Apply** reads the box back into the figure, for the rare
  thing no knob covers. Bad JSON, a parent that is not a layer, a parent loop
  and a duplicate id are refused and nothing changes.

Nothing in the panel touches the disk. **Save** does that, and Reset throws
the lot away.

### After you repaint a layer

`layers/` holds **copies**. Editing the source images changes nothing on its
own — run the same command again:

```bash
python tools/import-layers.py figures/grim grim
```

The second run and every one after it **keeps the rig** and replaces only the
pixels. Re-guessing pivots there would be the worst thing this tool could do:
they are the part a person corrected by hand, and a redrawn sleeve looks
exactly like the old one to a bounding box. `--rewrite-rig` forces a fresh
guess and throws the corrections away.

It then says what it could not do for you: layers that were *derived* from a
source rather than copied from one (a glow overlay, a set of closed lids) are
named, because only the tool that made them can remake them. So are source
files with no layer in `figure.json`, layers whose file has gone missing, and
files sitting in `layers/` that nothing points at.

A part that is lit — a rune, a lantern, a pair of glowing lenses — does not
need cutting out of the layer it is painted into:

```bash
python tools/cut-glow.py figures/grim/2-Grim-Kopf.webp \
    figures/grim/layers/augen-glut.webp --hue green
```

That writes a *copy* of the lit pixels plus a blurred halo. Mount it over the
original with `"blend": "screen"` and a `glow` motion: screen adds, so at rest
the two together look like the drawing and at the top of the pulse the light
gets brighter. Nothing is inpainted, so nothing can tear.

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
