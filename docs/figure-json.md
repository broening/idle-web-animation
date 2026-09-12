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
| `size` | The canvas every layer shares. Layers are never cropped and never carry an offset — the pivot alone decides how a layer moves. |
| `background` | Optional backdrop. It fills the host element, not the figure canvas, because a backdrop is rarely the same shape as the character. |
| `backgroundZoom` | Scale for the backdrop, e.g. `1.18`. |
| `motion.windowSeconds` | The review window. The contact sheet samples this span. It is **not** a loop period — see `principles.md`. |
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
| `lag` | Extra seconds of delay on top of the chain lag. |
| `role` | `"eyesOpen"` marks the layer that a `blink` hides. |
| `blend` | CSS `mix-blend-mode`, e.g. `"screen"`. Applies in the page and in the contact sheet alike. |

Layers are listed **back to front**. The studio shows them the other way
round, the way a layer palette does.

## The six motions

```json
{ "type": "breathe",  "strength": 1.0, "period": 4.0, "phase": 0 }
{ "type": "sway",     "strength": 1.0, "period": 7.5, "degrees": 2.2, "phase": 0 }
{ "type": "blink",    "interval": 4.2, "duration": 0.13 }
{ "type": "gaze",     "strength": 1.0, "pixels": 9, "degrees": 1.4, "follow": 1, "period": 11.3 }
{ "type": "flipbook", "mode": "burst", "fps": 12, "every": 6.5, "jitter": 0.45 }
{ "type": "glow",     "strength": 1.0, "period": 5.3, "min": 0.55, "brightness": 0.22 }
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

Several motions can sit on one layer; they add up. A hand can `sway` and
`glow` at the same time.

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

## Two rules that save time

1. **The pivot is a joint, not a centre.** A hand rotating about its own
   middle looks like a spinning sticker. About the elbow it looks like an arm.
2. **Keep periods from dividing into each other.** 4.0 and 8.0 will visibly
   lock together; 4.0 and 7.5 will not. This is principle 8 and it is the
   difference between alive and mechanical.
