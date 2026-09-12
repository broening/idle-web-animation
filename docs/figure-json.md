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
| `size` | The canvas every layer shares. Layers are never cropped: each one is a full-canvas image, so a layer sits where its pixels are. `offset` corrects a part that was cut a few pixels off; nothing else displaces a layer. |
| `background` | Optional backdrop. It fills the host element, not the figure canvas, because a backdrop is rarely the same shape as the character. |
| `backgroundZoom` | Scale for the backdrop, e.g. `1.18`. |
| `motion.windowSeconds` | The review window. The contact sheet samples this span. It is **not** a loop period — see `principles.md`. Read by the studio only; the player ignores it. |
| `motion.followSeconds` | How far each step down the parent chain lags. `0.085` is a good start. |
| `motion.parallax` | How strongly layers separate as the pointer moves. `0.35` is subtle, above `0.8` it starts to look like a toy. |

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
| `lag` | Extra seconds of delay on top of the chain lag. |
| `role` | `"eyesOpen"` marks the layer a `blink` hides. The `blink` motion may sit on this layer or on any ancestor. |
| `blend` | CSS `mix-blend-mode`, e.g. `"screen"`. Applies in the page and in the contact sheet alike. |
| `alt` | Alt text for the `<img>`. Cosmetic, but free. |
| `opacity` | Base opacity, clamped to 0…1. Out-of-range values used to make the DOM layer invisible and the canvas layer opaque — two different results from one file. |

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

What is **not** in the panel: creating, deleting or renaming a layer, and the
`frames` list. Those still want the file, or `tools/import-layers.py`. The
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
   lungs, and forcing them apart looks wrong. The engine does not check this;
   it is the author's job. See principle 8 in `principles.md`.
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
