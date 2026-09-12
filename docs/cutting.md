# How to cut a figure into layers

The method below came from the person this tool is for, after three wrong
attempts. It is written down because every wrong attempt looked reasonable
until it moved.

## The principle

**Do not cut a hole and then hide it. Ask the model to draw the same picture
without the part.**

A layerize model lifts parts out and leaves black behind them — measured: 85 %
of the area under a lifted part was black, and the transparent background came
back painted solid black too. An inpainter asked to fill a head-shaped hole in
a portrait draws another head. Both produce a figure that falls apart the
moment a part moves.

Generating the picture *without* the part gives a background that was actually
drawn: the jacket really continues where the hand was, the collar really runs
under the chin.

## The chain

Each step is an edit of the step before, so every version stays aligned with
the last. Verified on the priest: offset between source and edits was **0 px in
x and y**, residual difference ~10 of 255, which is redraw noise.

```
Vorlage
  └─ "remove the head, hair and neck"        → body without head
       └─ "remove the hand and the stake"    → THE BASE PLATE
  └─ "eyes without pupils"                   → eyeball layer
  └─ "eyes closed"                           → closed-lid layer
```

Run `birefnet/v2` on each result: the edit models return an opaque black
background, and the alpha has to come back.

## Where each layer's pixels come from

| Layer | Source | Why |
|---|---|---|
| base | the *without* version | it is drawn, not patched |
| head, hand | **cut from the Vorlage** | the pixels stay exact; only what is behind them may be invented |
| pupils | Vorlage minus "eyes without pupils" | the difference *is* the pupils |
| eyeball | "eyes without pupils" | |
| closed lids | "eyes closed" | a source with open eyes does not contain them |

Two ways to get a part's mask, and they fail differently:

- **Silhouette difference** (`alpha(Vorlage) − alpha(without)`) works for a part
  that sticks out past the body — a head, a raised arm.
- **Colour difference** works for a part lying *on* the body — a hand on a
  jacket. Silhouette difference finds almost nothing there (measured: 0.52 %
  where the true answer was 8 %).

Colour difference fails the other way round when a dark part sits on a dark
background: black hair against the edit model's black backdrop produced almost
no difference and the hair was lost. Use the silhouette there.

## The eye rig

```
head            gaze, a few pixels only
 └─ eyeball     no motion at all - it is painted on the face
     └─ pupil   gaze; this is the only thing that follows the pointer
 └─ lids        role "eyesClosed", blink
```

Measured on the priest: the eyeball tracks the head to within **0.06 px**, the
pupil moves **6.2 px** at full pointer deflection, the lids are visible **2.4 %**
of the time.

Cut the eye box **out of the head layer**, or the head's own painted eyes show
through underneath the eyeball layer.

## What does not work

- **Feathering the edges.** The complaint was never that an edge was hard. It
  was that there was an edge at all — a head layer that ends at the jaw puts a
  second chin behind the face. Blurring it gives a blurred second chin. Fix
  the cut, not the edge.
- **Cutting the head at the jaw.** Cut at the collar, so the whole neck travels
  with the head and only jacket sits behind it.
- **A base plate that is opaque where the figure is not.** Behind a head is
  background. If the base is opaque there, the head moves and a black slab
  appears behind it.

## The edit models redraw everything — measured

`seedream/v5/pro/edit` is described as "region-precise, changes one element
while keeping the rest of the frame intact". It does not. Asked to change only
the eyes, on a 1472x1472 Vorlage:

| | average change, of 255 |
|---|---|
| inside the eye region (1.5 % of the canvas) | 24.1 |
| **everywhere else** | **6.5** |
| pixels outside changed by more than 20 | **4.9 %** |

Removing the head changed the far shoulder by 6.0; removing the hand as well
took it to 8.0. That is not the prompt. A full-image diffusion editor
re-encodes every pixel, and no wording stops it.

**So do not paste its output in as a rectangle.** The 6.5 shift is invisible
in the middle of a region and glaring at its border - that is exactly the seam
that showed across the priest's face and under his eyes.

Three rules follow:

1. **Use the output as a mask, not as pixels**, wherever the Vorlage already
   contains what you need. The pupils are found by differencing against "eyes
   without pupils", but the pupil *pixels* are cut from the Vorlage.
2. **Colour-match what you do have to take.** Measure the mean offset in a ring
   around the region and subtract it. On the eye layers this was
   R−11.3 G−11.9 B−16.6 — a visible step, removed by arithmetic.
3. **Composite along the shape, never a box.** A dilation of the part's own
   mask; a rectangle puts a straight edge where the two versions disagree.

A mask-based inpainter (`flux-pro/v1/fill`, `bria/eraser`) is the structural
answer: it writes only inside the mask, so the rest of the image is
byte-identical by construction. Worth preferring wherever the edit is
surgical rather than creative.

## Cutting a picture you only have flat

Everything above needs the model to draw the picture again without a part.
When that is not on the table — no key, no budget, or a picture that came
from somewhere else — there is a second route, and it costs nothing.

**Paint one rough blob per part, and let the boundary come out of the
picture.** A model cannot know that a collar belongs to the chest and a strap
does not. A person says it in five seconds with a brush, and it is the only
thing they have to say: the name of each blob decides the rig, through the
same table `tools/import-layers.py` has always used.

    Mark in the studio  ->  tools/cut-by-marks.py  ->  tools/import-layers.py

The cutter reads `source.png` and `marks.png` from the figure's folder plus a
`marks.json` naming each colour, and writes one full-canvas part per blob.

### Reach, and why the first version was wrong

Every blob spreads outwards over the figure, and the setting that decides what
a cut even *is* is how far it may spread. A step through flat paint costs 1
out of the budget; a step across an edge the drawing itself makes costs six,
so the frontier runs freely inside a shape and grinds to a halt at its
outline.

The first version had no budget. Every pixel went to its nearest mark, which
is a **partition**, and a partition is the wrong shape for the job. Two small
strokes on a bear produced two layers of **64 % and 36 %**, with the seam
running down the middle of the animal rather than anywhere near what was
painted. What somebody marking a picture wants is a **selection**: this bit,
and that bit, and leave the rest alone.

With a 24 px reach the same two strokes take **2.2 % and 1.8 %**, and the
other 96 % is either kept as one leftover layer at the back or dropped.
Dropped is what lets you take two limbs out of this picture and the others
out of a different one.

Reach is also the only thing that trades against how carefully you paint.
Measured on two marks eroded 10 px inside the true shapes:

| reach | kopf | arm |
|---|---|---|
| 15 px | 0.945 | 0.954 |
| 30 px | 0.882 | 0.951 |
| 50 px | 0.785 | 0.910 |
| 90 px | 0.646 | 0.832 |

**Less is better**, as long as the mark is near the edge to begin with. Reach
buys tolerance for a sloppy mark and pays for it in spill.

### What it is worth

Measured by flattening a finished figure with `tools/flatten.py`, marking the
flat result, cutting it, and scoring each part against the layer it came
from. The truth is each layer **as it is visible in the flat picture**, since
that is all a flat picture contains.

On `baer`, 8 parts, marks painted close to each edge:

| part | IoU | | part | IoU |
|---|---|---|---|---|
| fuesse | 0.999 | | kopf | 0.993 |
| arm-links | 0.998 | | auge | 0.983 |
| arm-rechts | 0.997 | | kiefer | 0.966 |
| torso | 0.996 | | kiefer-saber | 0.873 |

**0.9967 over the whole figure**, at a reach of 24 px. The cut takes about
2 s; the budget is also the iteration count, so a small reach is a fast cut,
which is the one somebody correcting a mark runs over and over.

### The two things that decide the result

1. **The finer the part, the closer to its edge you paint.** `kiefer-saber`
   is a thin shape filling 31 % of its own box, lying against a much larger
   jaw. Marked with a sparse dot it scored **0.477** under the old partition;
   marked along its length and cut with a 24 px reach, **0.873**. Everything
   fat scored above 0.96 either way.
2. **You can only cut what is visible.** On the priest the big parts came out
   at 0.94 to 0.99, and the two pupils at **0.13 and 0.08** — because 15 and 6
   of their pixels survive the flatten at all. Eyes want their own drawn
   images, exactly as the eye rig above says.

### What it does not do

It does not draw what is behind a part. Cut a head out of a flat picture and
there is a head-shaped hole under it. At the few degrees this engine moves a
layer that is a seam at the edge rather than a hole in the middle, but it is
real — and it is the whole reason the method at the top of this file asks a
model to draw the picture again instead. The hand cut is the cheap route, not
the good one.

### One figure out of two pictures

A cut can only give you what the picture has. When a second picture has a
better arm, cut it into its own figure with the leftovers dropped, then bring
that layer across in the studio's **Add part** card: pick it, drag it into
place, set its size, press Place.

The scaling is baked into the pixels there and then. `figure.json` has no
per-layer scale and does not want one - every layer is a full-canvas image,
and that is what keeps the file readable and the two renderers agreeing.

Two things follow from doing it this way. A part is resampled once, when it
is placed, so place it at the size you want rather than nudging it later.
And `import-layers.py` now adds a part it has not seen before as a new layer
instead of only reporting it, so putting one part on a rigged figure no
longer costs you the rig.
