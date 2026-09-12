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
