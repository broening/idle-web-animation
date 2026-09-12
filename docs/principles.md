# The twelve principles, and where each one lives

Twelve principles are not twelve features. Several of them describe *how* a
movement is shaped, not a movement of their own — which is why the engine
ships six building blocks rather than twelve.

Nine principles are enforced in code, so they cannot be forgotten. Three are
judgement and belong to whoever plans the figure.

| # | Principle | Where it lives | How |
|---|---|---|---|
| 1 | Squash and stretch | engine, `breathe` | The chest gets taller and narrower in the same instant, so volume is kept. `sy += a*0.012`, `sx -= a*0.0066`. |
| 2 | Anticipation | engine, `blink` | The lid widens for 140 ms before it drops. Without it a blink reads as a dropped frame. |
| 3 | Staging | **plan** | Which part carries the eye, what the pose says. No code can decide this. |
| 4 | Straight ahead vs. pose to pose | **engine, settled** | The engine is pose-to-pose by construction: every layer is a function of `t`, never a chain of accumulated steps. |
| 5 | Follow through and overlapping action | engine, chain depth | A child layer reads time at `t − depth × followSeconds`. The hem of a cloak lags the shoulder that drags it, automatically. |
| 6 | Slow in and slow out | engine, all blocks | Motion is harmonic. A sine is already eased at both ends, so nothing starts or stops abruptly. Discrete events use a half-sine pulse. |
| 7 | Arcs | engine, `sway` and `gaze` | `sway` rotates about a pivot, so a hem travels a curve rather than sliding sideways. `gaze` adds a term quadratic in the horizontal, so the eyeline bows instead of ruling a straight line. |
| 8 | Secondary action | engine, periods | Blocks run on deliberately non-matching periods — breath 4.0 s, wind 7.5 s, glow 5.3 s, gaze drift 11.3 s. Nothing ever lines up, so nothing reads as one mechanism. |
| 9 | Timing | engine, `period` | Every block owns its period, and the studio has a slider for it. |
| 10 | Exaggeration | engine, `strength` | One multiplier per motion. Push it until it reads, then back off one notch. |
| 11 | Solid drawing | engine, `depth` + parallax | Layers displace by their own depth as the pointer moves, so a flat stack reads as a space. |
| 12 | Appeal | **plan** | Silhouette, expression, whether anyone wants to look at it. |

## The one that is easy to get wrong

**Principle 8 is why the periods look arbitrary.** They are not arbitrary,
they are chosen not to divide into one another. On top of that, every motion
is two sines at the golden ratio, so even a single block never repeats
exactly. The loading screen this project came from already used the same trick
by hand — breath at 4 s against wind at 7.5 s.

The cost: there is no clean loop point. The studio's 8 second window is a
review frame, not a period. Looping it shows a visible seam, and that is
correct rather than a defect.

## What the six blocks map to

| Block | Use for | Principles it carries |
|---|---|---|
| `breathe` | chest, belly, anything alive | 1, 6, 9 |
| `sway` | cloth, hair, cloak, a held weapon | 6, 7, 8, 9, 10 |
| `blink` | eyes | 2, 6, 9 |
| `gaze` | head and eyes, follows the pointer | 6, 7, 8 |
| `flipbook` | lightning, fire, smoke, sparks | 9, 10 |
| `glow` | lantern, rune, a lit eye | 6, 8, 9 |

Follow-through (5) and parallax (11) are not blocks. They apply to every layer
from its `parent` chain and its `depth`, so they cannot be left out by
accident.
