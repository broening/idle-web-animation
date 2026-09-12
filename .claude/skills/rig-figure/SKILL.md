---
name: rig-figure
description: "Rig or tune an idle figure in this repository: give the layers of a character their pivots, parents and motions so it breathes, blinks, sways and looks around the way the twelve principles say. Use when asked to rig a figure, make a part move, fix a rig that looks wrong, spread periods apart, or check a figure before it ships."
---

# Rig a figure

Read `AGENTS.md` first. It says how a figure should behave, what the part
names give you for free, and what breaks.

## Steps

1. Find the figure. `figures/<name>/figure.json` is the whole rig. If there
   is only a folder of layers, run
   `python tools/import-layers.py figures/<name> <name>` and start from what
   it guessed.
2. Look at the picture. Read the flat source or the layers and decide the
   pose: what hangs from what, where each joint sits, what is nearest the
   camera.
3. For every layer set four things: `parent` by anatomy, `pivot` on the
   joint in the drawing (0..1 of the canvas), the motion block that fits the
   part, and `depth` by distance to the camera.
4. Check the periods. Independent parts must not share one, nor sit at
   double or half; chest and belly should. `gaze` only on the head and the
   pupils; `blink` on the eye layers.
5. Run the three checks and read the last word of each:
   `node tools/test-determinism.mjs`, `node tools/test-agreement.mjs`,
   `python tools/check-compat.py`.
6. If a browser tool is available, prove it: `python tools/serve.py`, open
   `http://localhost:5173/studio/`, pick the figure, look at the bones on the
   stage, then **Contact sheet** and **Events** under Check.
7. Report what you set, what the checks said, and what you could not judge.
   Pivots want a person's eye; say which ones you are unsure of.

## Do not

- add poses, keyframes or a per-layer scale; the engine has none on purpose
- write `crop` by hand, or file names with umlauts
- start the paid model tools in `docs/models.md` without being asked
- paint marks for a cut yourself; ask the person to mark the picture
