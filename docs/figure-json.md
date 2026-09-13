# figure.json

One file describes a whole figure. It is meant to be read by a person and
diffed in a pull request, which is why motions carry names rather than
keyframes.

```json
{
  "name": "priest",
  "size": { "width": 1000, "height": 1000 },
  "background": "layers/background.webp",
  "backgroundZoom": 1.18,
  "motion": { "windowSeconds": 8, "followSeconds": 0.085, "parallax": 0.35 },
  "layers": [ ... ]
}
```

| Field | Meaning |
|---|---|
| `size` | The canvas every layer shares. Each layer is a full-canvas box, so a layer sits where its pixels are. The figures you author are full-canvas images too; an exported figure carries smaller files plus a `crop` that puts them back in place. `offset` corrects a part that was cut a few pixels off; nothing else displaces a layer. |
| `background` | Optional backdrop. It fills the host element, not the figure canvas, because a backdrop is rarely the same shape as the character. |
| `backgroundZoom` | Scale for the backdrop, e.g. `1.18`. |
| `motion.windowSeconds` | The review window. The contact sheet samples this span. It is **not** a loop period — see `principles.md`. Read by the studio only; the player ignores it. |
| `motion.followSeconds` | How far each step down the parent chain lags. `0.085` is a good start. |
| `motion.parallax` | How strongly layers separate as the pointer moves. `0.35` is subtle, above `0.8` it starts to look like a toy. |
| `motion.stateSeconds` | How long a switch from one mood to another blends, in seconds. `0.4` by default, `0` is a hard cut, `5` at most; a negative value gets the default. See [Moods](#moods-states). |
| `states` | Moods: named sets of differences from the layers as written. See [Moods](#moods-states). |

## A layer

```json
{
  "id": "hand",
  "src": "layers/hand.webp",
  "alt": "Hand",
  "parent": "arm",
  "pivot": [0.13, 0.78],
  "depth": 0.7,
  "offset": [0, 0],
  "lag": 0,
  "opacity": 1,
  "motions": [
    { "type": "sway", "strength": 1.0, "period": 7.5, "degrees": 2.0 }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Unique. Used by `parent` and by the studio. |
| `src` | One image. Use `frames` instead for a flip-book. |
| `frames` | List of images. The `flipbook` motion picks which one shows. |
| `parent` | Another layer's `id`. Transforms compose, and the child inherits a time lag. Draw order is unaffected — it comes only from the array order. |
| `pivot` | `[x, y]` in 0…1 of the canvas. This is the joint: the elbow for a hand, the neck for a head, the collar for a cloak. Drag it in the studio rather than guessing. |
| `depth` | 0…1, back to front. Drives parallax only. |
| `offset` | `[x, y]` in canvas pixels, a standing correction for a part that was cut a few pixels off. Children inherit it; the pivot does not move with it. Alt-drag it on the stage, or nudge it with the arrow keys. Leave it out when it is `[0, 0]`. |
| `tilt` | Degrees, a standing rotation about the pivot on top of whatever the motions turn. Children inherit it, like `offset`. Mostly useful in a mood; leave it out when it is 0. |
| `hidden` | `true` leaves the layer out of the picture in both renderers. It wins over the eye roles: a hidden `eyesClosed` layer stays hidden mid-blink. A mood can set it back to `false`. |
| `lag` | Extra seconds of delay on top of the chain lag. |
| `role` | `"eyesOpen"` marks the layer a `blink` hides. The `blink` motion may sit on this layer or on any ancestor. |
| `blend` | CSS `mix-blend-mode`, e.g. `"screen"`. Applies in the page and in the contact sheet alike. |
| `alt` | Alt text for the `<img>`. Cosmetic, but free. |
| `opacity` | Base opacity, clamped to 0…1. Out-of-range values used to make the DOM layer invisible and the canvas layer opaque — two different results from one file. |
| `crop` | `[x, y, width, height]` in canvas pixels: where a `src` image sits when the file is smaller than the canvas. The layer box stays the full canvas, so pivot and parent do not change. The studio's **Export** writes it; do not write it by hand. Anything but four numbers with a positive size is ignored. |
| `crops` | The same for a `frames` layer, one rectangle per frame. It wins over `crop`; a frame it does not cover is shown at full canvas. |

`name` and `note` at the top level are for people. The player never reads
them; the studio takes a figure's name from its folder.

### Which of these the studio writes for you

This file rarely needs an editor. In the studio:

| Field | Where |
|---|---|
| `parent`, `role`, `blend`, `opacity`, `alt` | the **Layer card** |
| `pivot`, `offset` | dragged on the stage |
| the array order | dragged in the layer list |
| `motions`, and every number in them | the **Motion card**, which also adds and removes whole blocks |
| `depth`, `lag`, `motion.parallax`, `motion.followSeconds` | sliders |

Two things the Layer card refuses on purpose. The `parent` list leaves out
every layer that already hangs below the selected one, because a loop in the
chain freezes the tab — the engine walks the chain on every frame. And the
`blend` list stops at the modes canvas can reproduce, so `plus-darker` is not
offered: it is the one value that would make the contact sheet disagree with
the page.

Layers come and go in the studio too. **Upload parts…** and the **Place**
card add them. **Remove this layer** in the Layer card deletes one, together
with its image files, and saves. What is **not** in the panel: renaming a
layer, and the `frames` list. Those still want the file, or
`tools/import-layers.py`. The
JSON card's **Apply** button is the way in — it reads the box back into the
figure and refuses bad JSON, a parent that is not a layer, a parent loop and a
duplicate id. Nothing is written to disk until **Save**.

Layers are listed **back to front**. The studio shows them the other way
round, the way a layer palette does.

## The eight motions

```json
{ "type": "breathe",  "strength": 1.0, "period": 4.0, "phase": 0 }
{ "type": "sway",     "strength": 1.0, "period": 7.5, "degrees": 2.2, "phase": 0 }
{ "type": "blink",    "interval": 4.2, "duration": 0.13 }
{ "type": "gaze",     "strength": 1.0, "pixels": 9, "degrees": 1.4, "follow": 1, "period": 11.3 }
{ "type": "flipbook", "mode": "burst", "fps": 12, "every": 6.5, "jitter": 0.45 }
{ "type": "glow",     "strength": 1.0, "period": 5.3, "min": 0.55, "brightness": 0.22 }
{ "type": "charge",   "stages": 3, "cycle": 24, "hold": 1.0, "ramp": 0.35, "showFrom": 1 }
{ "type": "drift",    "dx": 0, "dy": -120, "life": 3.0, "every": 4.0, "jitter": 0.5, "phase": 0, "wander": 6 }
```

- **breathe** — scales up and narrows at once, and lifts slightly.
- **sway** — rotates about the pivot, with a trace of drift along the swing.
- **blink** — hides the `eyesOpen` layer. Deterministic schedule with jitter
  and an occasional double blink. `interval` is an average, not a metronome.
- **gaze** — moves toward the pointer along a shallow arc, plus a slow idle
  drift so the figure still lives when nobody moves the mouse. `follow: 0`
  keeps the drift and ignores the pointer.
- **flipbook** — `mode: "loop"` cycles forever at `fps`. `mode: "burst"` plays
  the frames once every `every` seconds, with `jitter` spreading the start so
  two effects never fire in lockstep. Between bursts the layer is hidden.
- **glow** — pulses opacity down to `min` and brightness up by `brightness`.
- **charge** — a slow build-up that fires in stages, each stronger than the
  last. One `cycle` is split into `stages` equal slots; in slot *n* the layer
  ramps up over `ramp`, holds for `hold`, ramps down again, and reaches *n /
  stages* of full strength. A layer joins from `showFrom` upwards, so three
  bolt images with `showFrom` 1, 2 and 3 become three visible steps of one
  discharge rather than a single flash. Between flashes the layer is hidden.

- **drift** — the only block that goes somewhere and stays. The layer travels
  `dx, dy` pixels over `life` seconds on an ease-out, fades in over the first
  eighth and out over the last half, and is not drawn at all between rises.
  `every` is the gap between rises, `jitter` spreads their start, `wander`
  is a slow sideways waver, and `phase` shifts the whole schedule.
  `fadeOut: false` drops the fade-out: the layer still fades in over the
  first eighth so the spawn does not pop, but then holds at full opacity and
  cuts out the instant `life` ends, instead of softening over the last half.
  Right for a drip that has to disappear at a hard edge - a mouth, a
  floor - rather than dissolve mid-air.

Several motions can sit on one layer; they add up. A hand can `sway` and
`glow` at the same time.

## Particles

There is no particle system, and `drift` is not one. It moves whole layers,
like everything else here, so one `drift` on one layer of specks slides all of
them together — confetti on a string.

What makes it read as a stream is using it **several times over**. Split the
specks into groups, one layer each, and give every group its own `phase`,
`every`, `life` and distance. `tools/split-particles.py` does the splitting,
filling the groups round robin so each one is scattered across the whole spray
rather than owning a corner of it — a group that is one solid clump is the
confetti problem again at one tenth the size.

Two numbers decide whether it works, and both were found the hard way on
`grim`, which has 154 specks in ten groups:

1. **Keep the climb short.** The specks are painted where the stream already
   is, so the drawing does most of the work and the motion only has to make it
   live. 100 px of climb pulled the whole spray off the hand it came from and
   left a hole there; 50 to 86 px does not.
2. **Give every group a different `every`.** Ten groups on one period beat
   together into a single pulse — the confetti again, in time. Measured over
   300 s with the periods spread from 4.4 to 7.19 s, the strongest repeat in
   the whole spray is 0.35 of a perfect one, and between 2 and 10 groups are
   on screen at any moment.

   Spread them by more than it takes to look tidy. `jitter` cannot help here:
   the engine clamps it to the share of the slot the rise leaves free, or two
   rises of one layer overlap and the layer jumps between them — which is
   flicker, and is what `tools/test-agreement.mjs` now refuses.

And one thing to know before reporting a bug against it: **turn the studio's
window loop off to watch particles.** `windowSeconds` is a review window, not
a loop period, so restarting it at 0 cuts every motion mid-stride. Breathing
and sway survive that because they are near where they started; a spray does
not. On `grim` the seam is a 0.91 opacity step, and no window length fixes it
— 8, 16, 24, 32 and 40 s were all measured, and the shortest seam of those is
still 0.91, because the group periods do not divide any of them.

## Blinking properly

`role: "eyesOpen"` hides a layer while the lid is down. That alone leaves a
hole where an eye should be. Give the figure both roles:

| Layer | role | what it is |
|---|---|---|
| eyeball | – | the white and iris, cut from the source. Never moves on its own. |
| pupil | – | a child of the eyeball with a small `gaze`. Only this follows the pointer. |
| lids closed | `eyesClosed` | shown **only** while blinking. Has to be drawn or generated - a source with open eyes does not contain it. |
| lids open | `eyesOpen` | hidden while blinking. |

The head carries the head's own motion; the eyes ride it through `parent` and
must not have a `gaze` of their own, or they drift off the face.

### A face with no eyelids

A mask, a helmet, a skull. The two roles still work — what changes is what
they hold. `grim` is a plague doctor whose lenses are lit, so the blink is the
light going out:

| Layer | role | what it is |
|---|---|---|
| head | – | the mask, lit lenses painted in |
| lenses lit | `eyesOpen` | a `screen` copy of the lit pixels, with `glow`. Hidden while the eyes are out. |
| lenses unlit | `eyesClosed` | dark glass, drawn **over** the head. Shown only while the eyes are out. |

The unlit copy has to genuinely cover the lit pixels underneath, or the light
shows through its own blink. Measure it rather than trusting the drawing:
on `grim`, 99.0 % of the head's lit pixels sit under full alpha and the
thinnest spot is 167 of 255.

Put the `blink` on **both eye layers**, not on the head. It may legally sit on
any ancestor, but `blink` adds a touch of widening as anticipation, and on a
head that lifts the whole hat — measured at 2.7 px on `grim`, which is five
times the drift the rest of that rig was built to hold. On the eye layers
themselves the same term is worth 0.3 px. Two siblings under one parent read
time at the same depth, so one schedule written twice fires as one event.

## Moods (states)

A mood is a second look for the same rig: the head a little lower, the
breathing slower, another mouth. The page asks for one by name, a stream
overlay when the scene changes or a game when the character is hurt, and the
figure blends there.

```json
"motion": { "stateSeconds": 0.4 },
"states": {
  "sad":   { "kopf":  { "offset": [0, 6], "tilt": -2.5 },
             "torso": { "breathe": { "period": 5.5 } } },
  "happy": { "kopf":  { "offset": [0, -3] },
             "torso": { "breathe": { "period": 3.4, "strength": 1.2 } } }
}
```

That example changes posture only, and posture is where to start. A head six
pixels lower with a small forward tilt and a slower breath reads as sad before
a single picture is repainted.

**`neutral`** is the layers as written. It is never listed in `states`; a
`states.neutral` entry is ignored. Every mood lists **only what differs from
neutral**, never from another mood, so a switch from sad to happy goes
straight there.

**Names** are lowercase letters, digits, `-` and `_`, start with a letter or
digit, and are at most 32 characters. Lowercase so that a scene called
`Sad - Intro` can find the mood `sad` without guessing at case.

**A mood's value replaces the layer's**, it does not add to it. A head whose
layer carries a cutting correction of `[2, 0]` and should sit six pixels lower
writes `"offset": [2, 6]`.

What a mood can change:

| Key | What it does |
|---|---|
| `src` | Another picture for the layer, painted full canvas like every layer and swapped whole. Ignored on a `frames` layer, where the flipbook picks. |
| `crop` | The rectangle for that `src`. The studio's **Export** writes it; do not write it by hand. A mood's `src` without one shows at full canvas. One file has one cut: the layer's own `crop` wins for its own file, and the first mood's wins when two moods show the same file. |
| `offset` | Replaces the layer's `offset`. |
| `tilt` | Replaces the layer's `tilt`. |
| `hidden` | `true` or `false`. |
| `breathe`, `sway`, `gaze`, `glow`, `blink`, `flipbook`, `charge`, `drift` | An object of parameters laid over the layer's motion of that type, e.g. `{ "period": 5.5 }`. A motion the layer does not have is ignored: a mood changes motions, it does not add them. `type` inside is ignored. A value of the wrong kind, like `"period": "slow"`, keeps the layer's own. |

Everything else is **fixed**: `id`, `pivot`, `parent`, `depth`, `role`,
`blend`, `lag`, `frames`, `crops`, `motions`, `opacity`, `alt`, and any key not
in the table. Those are the rig, and the rig stays one rig. A blend between
two moods that disagreed about a pivot would have to put a joint halfway
between two anatomies; the parent chain is what times follow-through; a role
decides blinks, and a blend mode flipping mid-switch is a flash, not a mood.
The engine ignores fixed keys rather than failing, so a typo would be silent.
`Idle.checkStates(figure)` lists every ignored key, bad name and bad value,
and `node tools/test-states.mjs` refuses a figure that has any.

### What a switch looks like

Both moods are solved and mixed over `motion.stateSeconds`. **Position and
motion blend smoothly.** Two different periods never jump: each mood's
breathing runs on its own clock and only the mix between them moves. Measured
in `tools/test-determinism.mjs`: a torso going from a 4.0 s to a 5.5 s breath
moves at most 0.165 px between two frames at 120 fps, against 9.2 px as a hard
cut.

**Pictures switch hard, in the middle of the blend.** So do `hidden`, the
flipbook frame and the blink. Half a picture is not a thing a layer can show;
in the middle, the head is already on its way, and a swap inside a movement is
where a cut hides best. Every picture a mood can show is loaded with the
figure, so a switch never waits for a file.

### From the page

```js
var figure = new IdleFigure(host, data, 'figures/pedro/');
figure.play();
figure.setState('sad');     // true; false for a name the figure does not have
figure.state;               // 'sad', the mood asked for last
Idle.stateNames(data);      // ['neutral', 'sad', 'happy']
Idle.checkStates(data);     // [] when every mood is usable
```

`setState` blends from whichever mood currently shows more: asked for happy a
quarter of the way from neutral to sad, it starts from neutral. It switches
hard instead of blending when `stateSeconds` is 0, when the studio's window
loop is on (its clock jumps back at the seam), and when the figure is paused
(a paused clock would hold the blend at its start forever).

Anyone calling `solve` or `drawFrame` directly passes the mood in `ctx`,
either a name or a blend whose `since` is on the same clock as `t`:

```js
Idle.solve(data, t, { state: 'sad' });
Idle.solve(data, t, { state: { from: 'neutral', to: 'sad', since: 12.0 } });
Idle.drawFrame(g, data, images, t, { ctx: { state: 'sad' } });
```

An unknown name, or none, is neutral. A renderer of your own asks
`Idle.imageOf(layer, solvedLayer, data)` which picture shows and where, and
`Idle.imagesOf(layer, data)` for every picture to load up front, the way both
built-in renderers do.

## Blend modes, and why effects are cheap

An effect flip-book is cheapest to produce as a two second video on a **black**
field, cut into frames with ffmpeg — see `models.md`. Black disappears under
`"blend": "screen"`, so those frames need no alpha channel and no background
removal pass at all.

```json
{ "id": "lightning", "blend": "screen",
  "frames": ["fx/bolt-1.webp", "fx/bolt-2.webp", "fx/bolt-3.webp"],
  "motions": [{ "type": "flipbook", "mode": "burst", "fps": 12, "every": 6.5 }] }
```

`multiply` is the counterpart for shadows and grime on a white field. Any CSS
blend mode works; the canvas renderer uses the same names, so what the contact
sheet shows is what the page shows.

## Three rules that save time

1. **The pivot is a joint, not a centre.** A hand rotating about its own
   middle looks like a spinning sticker. About the elbow it looks like an arm.
2. **Keep periods apart between independent systems.** A cloak and a chest
   should not share one — 4.0 and 8.0 visibly lock together, 4.0 and 7.5 do
   not. But a chest and a belly *should* be close: they are one pair of
   lungs, and forcing them apart looks wrong. The engine does not stop you;
   the studio's Motion card warns when the selected layer shares a period
   with another, or sits at exactly double or half of one. Whether that pair
   should move as one is still the author's call. See principle 8 in
   `principles.md`.
3. **Anything that ends up in a divisor must be greater than zero.** A
   `period: 0` or an `interval: 0` is rejected and the default is used.
   Earlier they produced a figure made of `NaN`, and `interval: 0` froze the
   tab outright.

## Blend modes the canvas cannot do

`screen`, `multiply`, `overlay`, `darken`, `lighten`, `difference` and the
rest of the standard set behave identically in the page and in the contact
sheet. Three CSS values have no canvas equivalent and are translated:

| CSS value | Canvas gets | Effect |
|---|---|---|
| `normal` | `source-over` | identical, as expected |
| `plus-lighter` | `lighter` | very close |
| `plus-darker` | `source-over` | **not reproduced** — avoid it |
