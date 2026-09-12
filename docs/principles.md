# The twelve principles, and where each one actually lives

Twelve principles are not twelve features. Several describe *how* a movement is
shaped rather than a movement of their own, which is why the engine ships six
building blocks.

An earlier version of this file claimed nine of the twelve were "enforced in
the engine". That was not true, and its own table listed ten rows as engine
while saying nine. The honest count, measured against the code:

**4 genuinely enforced. 4 partial. 2 not implemented. 2 are judgement.**

| # | Principle | Verdict | What the code actually does |
|---|---|---|---|
| 1 | Squash and stretch | **enforced** | `breathe` scales `sy` by `+1.2%` and `sx` by `−0.66%` together. Volume is only *partly* preserved: `sx·sy` still varies by 0.53%. Read as 3D volume (`sx²·sy`) it is about 90% compensated. |
| 2 | Anticipation | **token** | The timing is real — `pulse(t − start + 0.14, 0.14)` fires in exactly the 140 ms before a blink. The effect is not. There is no lid layer, so it scales the whole eye layer by 1% about a pivot 229 px below the eyes. Measured: the eye band **moves up 8.5 px** and **changes height 2.1 px**. The described effect is the small one. The second blink of a double blink gets no anticipation at all. |
| 3 | Staging | **judgement** | Which part carries the eye, what the pose says. No code decides this. |
| 4 | Straight ahead vs. pose to pose | **not implemented** | The engine is procedural: every layer is a function of `t`. There is not one pose or keyframe in the schema. That is neither of the two techniques, and calling determinism "pose to pose" was a rename, not an implementation. |
| 5 | Follow through and overlapping action | **enforced** | `lt = t − chainDepth × followSeconds − lag`. A child layer reads time further back than its parent, so a hem lags the shoulder that drags it, with no author effort. |
| 6 | Slow in and slow out | **partial** | True for `breathe`, `sway`, `gaze`, `glow` — all harmonic, eased at both ends by construction. Not true on screen for the other two: `blink` computes an eased pulse and then throws the easing away, because visibility is `blink > 0.5` and the layer renders at opacity 1 or 0 with nothing in between. `flipbook` is `Math.floor(dt × fps)`, a hard cut. |
| 7 | Arcs | **enforced** | `sway` rotates about the pivot, so a hem travels a curve instead of sliding sideways. `gaze` adds `− gx² × reach × 0.18`, a real quadratic term, so the eyeline bows. |
| 8 | Secondary action | **not enforced** | The differing default periods are defaults, nothing more. No code reads, checks or perturbs a period. The shipped priest proves the gap: `belly` and `chest` both breathe at 4.0 s with phase 0, so their peaks sit a constant 0.085 s apart forever — one mechanism, exactly what the principle warns against. Keeping periods apart is the author's job, and the tool does not help yet. |
| 9 | Timing | **partial** | Only `breathe`, `sway`, `gaze` and `glow` have a `period`. `blink` has `interval`, `flipbook` has `every` and `fps`. And the studio only draws a slider for a key that is **already in the JSON**, so a motion written without `period` silently runs on the default with no control to find it. |
| 10 | Exaggeration | **partial** | `strength` is read by `breathe`, `sway`, `gaze` and `glow`. `blink` and `flipbook` ignore it. Writing `"strength"` on either produces a working-looking slider that changes nothing. |
| 11 | Solid drawing | **enforced** | Layers displace by their own `depth` as the pointer moves, so a flat stack reads as a space. Mouse only — `trackPointer` binds `mousemove` and `mouseleave`, so touch devices get nothing. |
| 12 | Appeal | **judgement** | Silhouette, expression, whether anyone wants to look at it. |

## What "enforced" has to mean

A comment naming a principle is not an implementation. A default value is not
enforcement. The four marked **enforced** hold because the author cannot switch
them off by writing the JSON badly: follow-through comes from the parent chain,
arcs come from rotating about a pivot, squash comes from two coupled scales,
parallax comes from `depth`. The four marked **partial** work on some blocks
and not others. The two marked **not implemented** are ambitions.

## The one that is easy to get wrong

**Principle 8 needs the author, not the engine.** Every motion is two sines at
the golden ratio, so a single block never repeats exactly. But two blocks with
the same period still march together, and nothing stops that.

An earlier version of this file said the loading screen this project came from
"already used the same trick by hand — breath at 4 s against wind at 7.5 s".
That was invented. Checked: it runs `breathe` at 4.2 s, `handsway` at **4.2 s**
— the same period — and `windsway` at 3.4 s, and it deliberately phase-locks
two animations to each other. The cited precedent does the opposite of what it
was cited for.

The real rule, with the exception that matters: **keep periods apart between
independent systems.** A cloak and a chest should not share one. A chest and a
belly *should* be close — they are one pair of lungs, and forcing them apart
would look wrong.

The cost of non-matching periods: there is no clean loop point. The studio's
8 second window is a review frame, not a period. Looping it shows a seam, and
that is correct rather than a defect.

## What the six blocks map to

| Block | Use for | `strength` | `period` |
|---|---|---|---|
| `breathe` | chest, belly, anything alive | yes | yes, 4.0 |
| `sway` | cloth, hair, cloak, a held weapon | yes | yes, 7.5 |
| `blink` | eyes | **no** | **no** — `interval` 4.2 |
| `gaze` | head and eyes, follows the pointer | yes | yes, 11.3 |
| `flipbook` | lightning, fire, smoke, sparks | **no** | **no** — `every` 6.5, `fps` 12 |
| `glow` | lantern, rune, a lit eye | yes | yes, 5.3 |

Follow-through and parallax are not blocks. They apply to every layer from its
`parent` chain and its `depth`, so they cannot be left out by accident. Those
two, plus arcs and squash, are the four that are genuinely enforced.
