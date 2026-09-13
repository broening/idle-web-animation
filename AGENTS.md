# For the agent building a figure here

You can build a whole figure without a mouse. The rig is one JSON file, every
tool is a command, every check is a command. What no tool decides for you is
how the figure should *behave*, and that is most of this file.

Read `README.md` once for the shape of the project and `docs/figure-json.md`
for the schema. `docs/principles.md` is the honest table of what the engine
enforces and what it does not; do not claim more than it does.

## Three rules the code lives by

1. `solve(figure, t)` is a pure function of time. No `Math.random`, no state
   carried from one frame to the next. `tools/test-determinism.mjs` refuses
   anything else.
2. No dependencies, no build step. A `<script>` tag, images, one JSON file.
3. Chromium 103 is the floor, for the player and for the studio.
   `tools/check-compat.py` refuses newer syntax.

`addons/` is the one exception to rule 2: it is optional (the core builds and
runs a figure without it) and may load code from a CDN - the core under
`player/`, `studio/` and `tools/` never does.

## What you can do from a shell

| Job | How |
|---|---|
| a folder of cut layers, each the full canvas, becomes a rigged figure | `python tools/import-layers.py figures/<name> <name>` |
| repaint some layers and keep the rig | the same command again; `--rewrite-rig` throws the corrections away |
| a lit part becomes a screen overlay that can pulse | `python tools/cut-glow.py <part> <out> --hue <colour>` |
| one layer of specks becomes groups that can move apart | `tools/split-particles.py` |
| a rigged figure becomes the flat picture it came from | `tools/flatten.py` |
| the studio, with a server that can write | `python tools/serve.py`, then `http://localhost:5173/studio/` |

Every tool explains itself at the top of its file. The server answers `PUT`
inside `figures/`, `GET /_figures`, `GET /_files?name=`, `GET /_vocab`, and
runs the importer and the cutter on request; `tools/serve.py` lists the
routes.

Two things stay with a person. Cutting a flat picture into parts needs marks
painted with a brush in the studio (**Mark**, then **Cut**), so ask for
them instead of guessing a boundary. And the model route in `docs/cutting.md`
and `docs/models.md` costs money and needs API keys; do not start it on your
own.

## Part names decide the first rig

`import-layers.py` reads each part's name and picks a joint, a motion and a
depth. German and English both work: `kopf` and `head` give the same rig.
`python tools/import-layers.py --vocab` prints the words it knows.

| the name contains | pivot | motion | depth |
|---|---|---|---|
| head, hair, face, hat | the neck, bottom edge of the part | `gaze` | 0.45 |
| hand, finger, rifle, gun | top edge, where it leaves the sleeve | `sway` | 0.7 |
| arm, sleeve, shoulder | the shoulder, top edge | a small `sway` | 0.5 |
| cloak, cape, scarf, strap | where it is fastened, top edge | `sway` | 0.4 |
| chest, collar, torso, coat | bottom edge | `breathe` | 0.3 |
| belly, leg, waist, lower | bottom edge | `breathe` | 0.2 |
| glow, light, rune, fire, flame, spark | centre | `glow` | 0.8 |
| anything else | bottom edge | a whisper of `sway` | 0.35 |

That is a starting point, not an answer. It measures each part's alpha box
and guesses; **the pose decides pivots and parents, and no file name knows
the pose.** You can read the picture. Put every pivot where the joint is in
the drawing, in 0..1 of the canvas, and set every `parent` by anatomy.

## How a figure should behave: the twelve principles as figure.json

| # | Principle | What to write |
|---|---|---|
| 1 | Squash and stretch | `breathe` on the torso. It scales up and narrows at once, so the body keeps its volume. Chest and belly are one pair of lungs: keep their periods close. |
| 2 | Anticipation | `blink` widens the eye a touch 140 ms before the lid drops. Put `blink` on the eye layers, never on the head: on the head that widening lifts the hat. |
| 3 | Staging | Your call. The pointer is followed by the head and the pupils and by nothing else. Eyes ride the head through `parent` and carry no `gaze` of their own, or they drift off the face. |
| 4 | Straight ahead and pose to pose | There are no poses, no keyframes and no timelines here, on purpose. Do not add any. Every layer is a function of `t` plus its inputs. A mood (`states`) is one of those inputs, like the pointer: the page asks for `sad`, it is not a pose placed on a timeline. |
| 5 | Follow through | The parent chain. Each step down the chain reads time `motion.followSeconds` later, 0.085 s is a good start. Build it by anatomy: hem to cloak to chest, hand to arm to chest, pupil to eyeball to head to chest. `lag` adds seconds for something heavy. |
| 6 | Slow in and slow out | Free for `breathe`, `sway`, `gaze` and `glow`. `blink` and `flipbook` are hard cuts, and are meant to be. |
| 7 | Arcs | The pivot is a joint, not a centre. A hand turns about the elbow, a head about the neck, a cloak about the collar. A hand rotating about its own middle is a spinning sticker. |
| 8 | Secondary action | Keep periods apart between independent systems. Cloak 7.5 against chest 4.0 is fine; 4.0 against 8.0 locks together. The studio's Motion card says `Same period as ...` and `Double or half the period of ...` for the selected layer. Chest and belly are the one pair that should match. |
| 9 | Timing | The defaults are tuned: `breathe` 4.0, `sway` 7.5, `gaze` 11.3, `glow` 5.3, `blink` interval 4.2. Change them for character, not out of habit. Particle groups need a different `every` each. |
| 10 | Exaggeration | `strength` on `breathe`, `sway`, `gaze`, `glow`, up to 3. `blink` and `flipbook` ignore it. Keep movement small: a part cut from a flat picture shows a hole behind it when it moves far, because nothing is painted there. |
| 11 | Solid drawing | `depth` 0..1, back to front, drives the parallax as the pointer moves. `motion.parallax` 0.35 is subtle, above 0.8 it looks like a toy. |
| 12 | Appeal | Judgement. Look at the contact sheet, not at one frame. |

## Recipes that are known to work

**Eyes.** Four layers: the eyeball, cut from the face, no motion at all; the
pupil as its child with a small `gaze`; the open lids with
`"role": "eyesOpen"`; the closed lids with `"role": "eyesClosed"`, which have
to be drawn because a picture with open eyes does not contain them. `blink`
sits on both eye layers. Cut the eye box out of the head layer, or the painted
eyes show through. A camera page sets `figure.blink` from 0 to 1 instead;
the schedule stops while it is set and resumes when it is `undefined` again.

**Mouth.** Two full-canvas layers parented to the head, no motion: the closed
mouth with `"role": "mouthClosed"`, the open one with `"role": "mouthOpen"`,
drawn because a closed mouth does not contain an open one. Cut the mouth out
of the head layer like the eyes. Only `ctx.mouth` (a page's `figure.mouth`)
opens it, above 0.5; without it the mouth stays closed.

**A face with no lids.** A mask or a skull blinks by its light going out:
lit lenses as a `screen` copy with `glow` and role `eyesOpen`, dark glass
drawn over the head with role `eyesClosed`. The dark copy has to cover the
lit pixels completely.

**Particles.** `drift` moves a whole layer, so one layer of specks is
confetti on a string. Split the specks into groups, one layer each, with
`tools/split-particles.py`, and give every group its own `phase`, `every`,
`life` and distance. Keep the climb short, 50 to 86 px worked and 100 px
tore the spray off the hand. `"fadeOut": false` for a drip that has to
vanish at a hard edge. Turn the studio's window loop off to watch them.

**Light.** Do not cut a lantern out of the part it is painted into. Run
`cut-glow.py`, mount the copy over the original with `"blend": "screen"` and
a `glow`.

**Effects.** Lightning, fire and smoke as `frames` on a black field with
`"blend": "screen"` and a `flipbook` in `burst` mode; black disappears under
screen, so no alpha and no background removal. `charge` builds a discharge in
stages. `multiply` is the counterpart for shadows on a white field; a
standing shadow is just a painted layer.

**Moods.** Posture first, pictures second. A head 4 to 6 px lower, a tilt
of -2 to -3 degrees and a torso breathing at 5.5 instead of 4.0 already
reads sad; the head 3 px higher and breathing at 3.4 reads happy. A mood's
`offset` replaces the layer's, so keep any cutting correction in it. A
different mouth or brow is a full-canvas picture on the same canvas, swapped
by `src`; it switches hard in the middle of the blend, while the head is
already moving. List only what differs from neutral, then run
`node tools/test-states.mjs`.

**A part that sits two pixels off.** `offset` in canvas pixels, children
inherit it, the pivot stays. Do not re-cut for a seam nobody sees once it
moves.

## Things that break

- Anything that ends up in a divisor must be above zero. `"period": 0` and
  `"interval": 0` are rejected and the default is used.
- A parent loop freezes the tab. The studio refuses it; when you write JSON
  yourself, check the chain.
- Each motion type once per layer. Two blinks fire as one, two drifts make
  the layer jump between rises.
- `plus-darker` is the one blend the contact sheet cannot reproduce. Do not
  use it.
- File names in plain ASCII. A server may not find `%C3%A4`, and a Mac stores
  the umlaut in a different form, so the reference in `figure.json` would not
  match either way.
- Author with full-canvas layers only. `crop` is written by the studio's
  Export; never write it by hand.
- `motion.windowSeconds` is a review window, not a loop period. Looping it
  shows a seam, and that is correct.
- A mood may not change `pivot`, `parent`, `depth`, `role` or `blend`, nor
  `lag`, `frames`, `opacity` or `motions`. Every mood shares one rig; a blend
  cannot put a joint halfway between two anatomies. The engine ignores those
  keys, and `Idle.checkStates(figure)` reports them.

## Before you say it is done

```
node tools/test-determinism.mjs    ->  DETERMINISTISCH
node tools/test-agreement.mjs      ->  EINIG
node tools/test-states.mjs         ->  ZUSTAENDE-OK
node tools/test-addons.mjs         ->  ADDONS-OK
python tools/check-compat.py       ->  CHROMIUM-103-TAUGLICH
```

The German last words mean deterministic, agreed, moods in order, and fit
for Chromium 103. Then, if you have a browser, open the studio, pick the figure, and use
**Contact sheet** and **Events** under Check: the sheet shows 24 frames of the
window, the scan lists every blink and burst over 30 seconds. A single
screenshot cannot prove movement. The bones on the stage show the chain; a
bone that does not follow the body is a wrong parent or a pivot off its joint.

Say what you set and what you could not judge. Pivots want a person's eye.
