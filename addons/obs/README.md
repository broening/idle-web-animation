# OBS addon

Put an animated figure into OBS Studio, with a transparent background, a mood
that follows the scene name, and, if you like, a camera that drives the head,
the eyes, the mouth and a smile.

The addon is optional. The core (`player/`, `studio/`, `tools/`) builds and
runs a figure without any of it.

| Page | What it does | Needs |
|---|---|---|
| `figure.html` | the figure alone, transparent, mood from the scene name | OBS 28 or newer |
| `avatar.html` | the same, driven by your webcam | OBS 31 or newer, a launch flag |

## Part A: the figure in OBS

### 1. Start the server

OBS loads the figure from the repo's own server. Open a terminal in the
project folder:

```
cd C:\path\to\idle-web-animation
```

Then start the server:

```
python tools/serve.py
```

Leave that window open while you stream. `Ctrl+C` stops the server. It
listens on `127.0.0.1:5173` only, so nothing on your network can reach it.
The studio uses the same server; if it already runs, skip this step.

### 2. Add a Browser source

1. In OBS, click **+** under **Sources**.
2. Pick **Browser**.
3. Name it, for example "Pedro", and click **OK**.

### 3. Set up the source

| Field | Value |
|---|---|
| **Local file** | unchecked |
| **URL** | `http://127.0.0.1:5173/addons/obs/figure.html?figure=pedro` |
| **Width** | `1792` |
| **Height** | `1000` |
| **Shutdown source when not visible** | unchecked |
| **Refresh browser when scene becomes active** | unchecked |

Then click **OK**.

- **URL:** replace `pedro` with any folder name under `figures/`. Letters,
  digits, `.`, `_` and `-` only; anything else falls back to `pedro`.
- **Width and height:** 1792 x 1000 is Pedro's own canvas, so he stays
  sharp. Any other size works too; the page fits the figure into the box.
  Resize the source in the scene as usual.
- **The two checkboxes:** a source that shuts down or refreshes starts the
  figure over from the beginning at every scene change.
- **Transparency** needs no setting. The page paints nothing but the figure.

### 4. Pick a mood (optional)

A figure with moods in its `figure.json` can switch between them. Pedro has
`sad` and `happy`. There are two ways to choose:

**By scene name.** A word in the scene's name that matches a mood switches
to it, with a short blend.

| Scene name | Mood |
|---|---|
| `Pause sad` | `sad` |
| `Just Chatting happy` | `happy` |
| `HAPPY ending` | `happy` (case does not matter) |
| `Game` | the start mood from the URL, else `neutral` |
| `sad-ish` | no match: a hyphenated word is one word |

The first matching word wins.

**By URL.** `&state=` sets the mood the page starts in. It is also the mood
for every scene whose name has no mood word:

```
http://127.0.0.1:5173/addons/obs/figure.html?figure=pedro&state=sad
```

**Page permissions.** To read the scene name when the page loads, the source
needs more than the default. Open the source's **Properties**, find **Page
permissions**, and pick **Read access to user information** or any level
above it. Without it the page only learns the scene name at the next scene
change.

Technically: the page calls `window.obsstudio.getCurrentScene()`, which the
[obs-browser](https://github.com/obsproject/obs-browser) documentation lists
under the permission level READ_USER, and listens to the `obsSceneChanged`
event, for which it lists no level. `scene.js` guards every call, so the page
never breaks outside OBS or with too little permission.

## Part B: avatar with camera (optional)

`avatar.html` is `figure.html` plus a webcam. The face is read with
[MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker),
loaded from jsDelivr at a pinned version.

**Untested on a real camera.** This page was built without a camera and
without OBS 31. Its rules are tested in Node (`node tools/test-addons.mjs`),
and in a browser without a camera it falls back to the plain figure as
designed. Whether the head turns the right way and the thresholds suit a real
face is not verified. Use `&debug=1` the first time.

### 1. Check your OBS version

**Help > About** in OBS. You need **31 or newer**: OBS 28 to 30 embed
Chromium 103, and nobody has confirmed that MediaPipe runs there.

### 2. Allow OBS to use the camera

OBS's built-in browser blocks cameras unless OBS starts with a flag.

1. Close OBS completely.
2. Right-click the OBS shortcut and pick **Properties**.
3. In **Target**, after the closing quote, add a space and
   `--enable-media-stream`:

   ```
   "C:\Program Files\obs-studio\bin\64bit\obs64.exe" --enable-media-stream
   ```

4. Click **OK** and always start OBS from this shortcut. The Start menu entry
   does not carry the flag.

### 3. Point the source at the avatar page

Change the URL of the Browser source from Part A:

```
http://127.0.0.1:5173/addons/obs/avatar.html?figure=pedro&debug=1
```

`&debug=1` shows your camera image and the live numbers in the bottom left
corner. Once everything looks right, remove it.

The page must come from `http://127.0.0.1:5173` through `tools/serve.py`,
never from **Local file**: browsers only open a camera on a secure page, and
localhost counts as one.

Scene names and `&state=` work exactly as in Part A.

### What the camera controls

| You | The figure |
|---|---|
| turn or tilt your head | turns and looks the same way, like a mirror; 25 degrees is the full turn |
| close both eyes | blinks; one eye alone does nothing |
| open your mouth | shows its open mouth, if it has one |
| smile for half a second | switches to `happy`, if it has that mood |
| stop smiling for 1.5 seconds | goes back to the scene's mood |
| leave the picture for a second | blinks on its own again and looks ahead |

An open mouth needs two mouth layers in the figure, with the roles
`mouthOpen` and `mouthClosed` (see the Mouth recipe in `../../AGENTS.md`).
Pedro has none yet, so his mouth stays as painted.

### If something is wrong

| Problem | Fix |
|---|---|
| The camera stays off, `&debug=1` says so | Add `--use-fake-ui-for-media-stream` to the shortcut's **Target** as well, after `--enable-media-stream`. It answers the camera prompt OBS never shows. |
| The head turns the wrong way | Add `&mirror=0` to the URL. |
| OBS also shows your camera, and one of the two stays black | Windows gives a camera to one program at a time. Windows 11 24H2 and later can share it: **Settings > Bluetooth & devices > Cameras > (your camera) > Allow multiple apps to use camera at the same time**. |
| Nothing moves at all | Is `python tools/serve.py` still running? |

### Without the launch flag: chroma key

If you cannot start OBS with a flag, run the page in Chrome instead and key
out a green background:

1. Open this in Chrome and allow the camera:

   ```
   http://127.0.0.1:5173/addons/obs/avatar.html?figure=pedro&bg=00ff00
   ```

2. In OBS, add a **Window Capture** of that Chrome window.
3. Add a **Chroma Key** filter to it, key colour green.

This works with any OBS version. Soft edges such as hair keep a thin green
fringe; **Spill reduction** in the filter helps. The Chrome window has to stay
open.

`&bg=` takes 3 or 6 hex digits without `#` and works on `figure.html` too.

## Part C: a package to share

Parts A and B need this repo and `tools/serve.py`. A package does not: it is a
zip someone unpacks and opens in OBS with **Local file**.

1. In the studio, pick the figure and open the **Export** card.
2. Pick a **size**, fill in the **OBS package** block (logo, start mood,
   credit, licence) and click **OBS package (zip)**.
3. Hand over `<figure>-obs.zip`.

The zip holds `obs.html` (figure, player and scene glue all inline),
`layers/`, the logo if you chose one, `ANLEITUNG.txt` with the exact OBS steps
and the figure's real width and height, and `LICENSE.txt` when a licence is
chosen. The figure's background is never packed; the page is transparent.

Moods and scene names work as in Part A. The camera avatar does not: it needs
the server. The builder is `package.js`, tested by `node tools/test-addons.mjs`.

German readers: [ANLEITUNG.md](ANLEITUNG.md) walks through all of this, from
the server to a package in OBS, with credit and licence.

## URL parameters

| Parameter | Pages | Meaning |
|---|---|---|
| `figure=pedro` | both | folder under `figures/`; default `pedro` |
| `state=sad` | both | start mood, and the mood for scene names without a mood word |
| `bg=00ff00` | both | solid background for chroma key; default transparent |
| `debug=1` | avatar | camera image and live numbers in a corner |
| `mirror=0` | avatar | flips the head turn |

## Why not a video loop

A figure here runs its motions on periods that deliberately do not line up,
and `breathe` and `sway` each mix two sines at the golden ratio, whose sum
never repeats. A video has to end and start again, and at that cut every
motion jumps back to where it began. The page runs the engine itself, which
is a function of time, so it keeps counting and never reaches a seam.
